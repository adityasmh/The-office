import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.js";
import { getCompanyRoot, loadOrg } from "./org.js";
import { cachedBySig, fileSig, sigOf } from "./cache.js";
import { IN_MOTION, loadTasks, approveGate } from "./gates.js";
import type { TaskRec, TraceStep } from "./gates.js";
import { resumeTask } from "./pipeline.js";
import { isNoOpTask, isSupersededOrder, orderFailureCause, orderRetryExhausted } from "./needsYouRule.js";
// The plain "sign-in expired" sentence, so a FAILED order shows the real reason instead of
// the generic "Retry this order or drop it?" prompt (which hid it).
import { CLAUDE_SIGNIN_EXPIRED_MESSAGE, mentionsClaudeSignInExpired } from "./claudeSignIn.js";
import { callClaudeSubscription } from "../claudeSubscription.js";
import { classifyBrain } from "../decision.js";
// Attribution only (fix 3 of the 2026-10-01 event-loop order): names the code that held the loop.
import { withBusy } from "./loopWatchdog.js";

// ---------------------------------------------------------------------------
// RUN MANAGERS (docs/REPORTING_SPEC.md section 1, docs/AUTOCLOSE_SPEC.md)
//
// The CEO's problem: too many sessions running to keep track. Every *run* gets
// a manager check by Claude that reads real evidence and writes a one-screen
// "run card" in plain words: what's done, what's remaining, and whether the CEO
// must do something.
//
// A run is one of:
//   - "task"  : a company pipeline task (company/projects/<id>/tasks.json)
//   - "fleet" : a fleet work order (company/fleet/orders.json, see FLEET_SPEC.md;
//               read tolerantly - the file and src/company/fleet.ts may not exist yet)
//   - "jcode" : a live/visible jcode session not started by the fleet (rose, OPS,
//               CRASHFIX, UI-*, ...). Discovered from %USERPROFILE%\.jcode\sessions\
//               (*.journal.jsonl = live meta + activity, <id>.json = meta + messages,
//               so the FIRST user message is the work order), matched to its entry
//               in docs/AGENT_COORDINATION.md by session name for its role/owner.
//
// HARD RULES (house style, like ceoContext.ts)
//  - TOTAL: discovery never throws - a broken source degrades to "no runs" from it.
//  - CHEAP BY DEFAULT: listRunCards()/getRunCard() do no LLM calls and no writes.
//    Only checkRuns() (called by the briefing watcher, or POST refresh) spends
//    Claude quota, and only when a run's evidence changed, at most once per
//    RUN_MANAGER_MIN_INTERVAL_S per run, at most RUN_MANAGER_CONCURRENCY at once,
//    and at most RUN_MANAGER_MAX_CHECKS_PER_TICK per tick.
//  - MODEL CHOICE (spec): Laya /health first, then classifyBrain; its pick is used
//    only with confidence >= RUN_MANAGER_LAYA_MIN_CONF (default 0.35), otherwise
//    Sonnet. ALWAYS Opus when the run is failed/stuck or REDO happened twice.
//    Laya offline -> Sonnet with modelReason "Laya offline".
//  - A manager card is only written to disk after a real manager check. Runs that
//    have not been checked yet get a free local placeholder (model "local", see
//    heuristicCard) so the briefing always covers every run without spending quota.
//  - Stuck detection without Claude: no journal/trace activity for RUN_STUCK_MINUTES
//    (default 15) while not done -> state "stuck".
//  - Verdicts (docs/AUTOCLOSE_SPEC.md): PASS/REDO/FAIL + reason + verifiedAt are
//    given ONLY when the run has reported, and only after the evidence was checked
//    (do the claimed files exist? is the claimed output real?), not just summarised.
//
// Storage (REPORTING owns): company/reports/runs/<runId>.json (latest card) and
// company/reports/runs.jsonl (history, one line per checked/changed card).
// ---------------------------------------------------------------------------

export type RunState = "working" | "stuck" | "done" | "failed" | "waiting_for_ceo";
export type RunVerdict = "PASS" | "REDO" | "FAIL";
export type RunKind = "task" | "fleet" | "jcode";

/** Where a run lives, so the UI can link to it (tasks -> #/flow/:taskId, fleet -> #/fleet/:orderId). */
export type RunRef = {
  kind: RunKind;
  projectId?: string;
  taskId?: string;
  orderId?: string;
  sessionId?: string;
  sessionName?: string;
};

export type RunCard = {
  runId: string;
  kind: RunKind;
  title: string;
  /** e.g. "jcode kikazaru (UI-ASSISTANT)", "Engineering team (Agent Office)" */
  owner: string;
  state: RunState;
  /** one sentence a non-engineer understands */
  headline: string;
  /** plain words, most important first, max 6 */
  done: string[];
  /** plain words, max 6 */
  remaining: string[];
  /** only if the CEO must decide/do something */
  needsCeo?: string;
  model: string;
  modelReason: string;
  checkedAt: string;
  evidenceHash: string;
  // ── docs/AUTOCLOSE_SPEC.md: verification (AUTOCLOSE consumes these) ──
  /** only set once the run has reported AND the evidence was checked */
  verdict?: RunVerdict;
  verdictReason?: string;
  verifiedAt?: string;
  /** archived report for this run, when AUTOCLOSE wrote one */
  archive?: string;
  /** the jcode session id for kind "jcode" (AUTOCLOSE matches on this) */
  sessionId?: string;
  /** has this run reported? (REPORT.md, its coordination-log entry, or a merged task) */
  reported: boolean;
  /** last real activity we could see for this run */
  updatedAt: string;
  ref: RunRef;
  // ── RETRY LOOP (2026-09-30) ──
  /** When this run is a failed fleet order: a stable signature of WHY it failed, so the
   *  briefing can tell "the same failure again" from "a new one" (needsYouRule.jobPromptId). */
  fleetFailureCause?: string;
  /** The job has used up its retries (needsYouRule.maxOrderRetries): show ONE honest item
   *  with no retry button instead of minting another copy of the order. */
  fleetRetryExhausted?: boolean;
  /** RETRY LOOP: manager checks that produced no verdict for the SAME evidence. Used to cap
   *  re-checks (a failing check used to re-run on every pass forever). */
  checkAttempts?: number;
};

/** A discovered run with the bounded evidence bundle a manager check reads. */
export type Run = {
  runId: string;
  kind: RunKind;
  title: string;
  owner: string;
  /** the work order / request text (bounded) */
  order: string;
  /** deterministic state before the manager check (never empty) */
  state: RunState;
  reported: boolean;
  updatedAt: string;
  evidenceHash: string;
  /** bounded plain-text evidence bundle handed to the manager model */
  evidence: string;
  /** extra read-only roots the manager may open to verify this run's claims */
  addDirs?: string[];
  /** local, free fallback card (used until/unless a manager check happens) */
  placeholder: { headline: string; done: string[]; remaining: string[]; needsCeo?: string };
  ref: RunRef;
  /** fleet work orders already carry a PASS/REDO verdict from the fleet review */
  fleetVerdict?: RunVerdict;
  fleetVerdictReason?: string;
  /** RETRY LOOP: why a failed fleet order failed, and whether its retries are used up. */
  fleetFailureCause?: string;
  fleetRetryExhausted?: boolean;
  /** if the record was closed/superseded or dropped in memory, label it on the card */
  closure?: { as: string; by?: string };
};

export type CheckSummary = {
  discovered: number;
  inFlight: number;
  checked: number;
  changed: number;
  skipped: number;
  /** runs left on a free local placeholder this pass (cost control) */
  onPlaceholder: number;
  claudeCalls: number;
  models: string[];
  errors: string[];
  ms: number;
};

// ── tunables (env, read per call so ops/tests can override) ──────────────────

function envNum(name: string, dflt: number, min = 0): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return dflt;
  return Math.max(min, raw);
}

function envStr(name: string, dflt: string): string {
  const raw = (process.env[name] ?? "").trim();
  return raw || dflt;
}

export const runManagerKnobs = () => ({
  minIntervalS: envNum("RUN_MANAGER_MIN_INTERVAL_S", 180, 0),
  concurrency: envNum("RUN_MANAGER_CONCURRENCY", 2, 1),
  layaMinConf: envNum("RUN_MANAGER_LAYA_MIN_CONF", 0.35, 0),
  // Deliberately low for a laptop that is already at the CEO's 20-session limit:
  // at most this many Claude checks per pass (and RUN_MANAGER_CONCURRENCY at once).
  // Raise it if the CEO wants every run carded faster; the runs whose evidence
  // actually changed are always served before untouched ones.
  maxChecksPerTick: envNum("RUN_MANAGER_MAX_CHECKS_PER_TICK", 2, 1),
  maxRuns: envNum("RUN_MANAGER_MAX_RUNS", 40, 1),
  stuckMinutes: envNum("RUN_STUCK_MINUTES", 15, 1),
  windowHours: envNum("RUN_WINDOW_HOURS", 6, 0.1),
  jcodeActiveMinutes: envNum("RUN_JCODE_ACTIVE_MINUTES", 240, 1),
  layaTimeoutMs: envNum("RUN_MANAGER_LAYA_TIMEOUT_MS", 2500, 250),
  backend: envStr("RUN_MANAGER_BACKEND", "claude"),
});

// ── small helpers ───────────────────────────────────────────────────────────

function clip(text: unknown, max: number): string {
  const s = typeof text === "string" ? text : String(text ?? "");
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseMs(iso: string | undefined): number {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? t : 0;
}

function minutesSince(iso: string | undefined, now: number): number {
  const t = parseMs(iso);
  if (!t) return Number.POSITIVE_INFINITY;
  return (now - t) / 60000;
}

function sha1(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 16);
}

function safeName(runId: string): string {
  return runId.replace(/[^A-Za-z0-9._-]/g, "_");
}

type CardCacheEntry = { mtimeMs: number; size: number; value: unknown };
const cardReadCache = new Map<string, CardCacheEntry>();

function cardFileKey(file: string): { mtimeMs: number; size: number } | undefined {
  try {
    const st = fs.statSync(file);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return undefined;
  }
}

function readJson<T>(file: string): T | undefined {
  try {
    if (!fs.existsSync(file)) return undefined;
    const key = cardFileKey(file);
    const hit = key ? cardReadCache.get(file) : undefined;
    if (hit && hit.mtimeMs === key!.mtimeMs && hit.size === key!.size) return hit.value as T;
    const raw = fs.readFileSync(file, "utf8");
    const value = JSON.parse(raw) as T;
    if (key) cardReadCache.set(file, { ...key, value });
    return value;
  } catch {
    return undefined;
  }
}

// LOOP-LAG (2026-10-01): serialised async writer queue so run-card tmp+rename never blocks
// the event loop, and concurrent writers cannot interleave.
let cardWriteQueue: Promise<void> = Promise.resolve();

async function doWriteJsonAtomic(file: string, value: unknown, appendLog?: { file: string; line: string }): Promise<void> {
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(value, null, 2));
    await fs.promises.rename(tmp, file);
    const key = cardFileKey(file);
    if (key) cardReadCache.set(file, { ...key, value });
    if (appendLog) {
      await fs.promises.mkdir(path.dirname(appendLog.file), { recursive: true });
      await fs.promises.appendFile(appendLog.file, appendLog.line);
    }
  } catch {
    // cards are best effort; never break a caller
  }
}

function writeJsonAtomic(file: string, value: unknown, appendLog?: { file: string; line: string }): void {
  cardWriteQueue = cardWriteQueue.then(() => doWriteJsonAtomic(file, value, appendLog)).catch(() => {
    // best effort
  });
}

function repoRoot(): string {
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, "src", "server.ts"))) return cwd;
  let dir = cwd;
  for (let i = 0; i < 4; i++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    if (fs.existsSync(path.join(dir, "src", "server.ts"))) return dir;
  }
  return cwd;
}

function jcodeHome(): string {
  return process.env.JCODE_HOME ?? path.join(os.homedir(), ".jcode");
}

export function reportsDir(): string {
  return path.join(getCompanyRoot(), "reports");
}

function runsDir(): string {
  return path.join(reportsDir(), "runs");
}

function runsLogFile(): string {
  return path.join(reportsDir(), "runs.jsonl");
}

function cardFile(runId: string): string {
  return path.join(runsDir(), `${safeName(runId)}.json`);
}

/** Read the last maxBytes of a file (journals can be hundreds of KB; never load it all). */
function readTail(file: string, maxBytes: number): string {
  return readSlice(file, maxBytes, true);
}

/** Read the FIRST maxBytes of a file (session metas can be megabytes; never parse them all). */
function readHead(file: string, maxBytes: number): string {
  return readSlice(file, maxBytes, false);
}

function readSlice(file: string, maxBytes: number, fromEnd: boolean): string {
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, maxBytes);
    if (len <= 0) return "";
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, fromEnd ? st.size - len : 0);
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

// ── coordination log (role/owner + "has it reported?") ──────────────────────

type LogEntry = { time: string; author: string; text: string };

let logCache: { file: string; mtime: number; entries: LogEntry[] } | undefined;

function coordinationFile(): string {
  return path.join(repoRoot(), "docs", "AGENT_COORDINATION.md");
}

/**
 * Parse docs/AGENT_COORDINATION.md into log entries. An entry starts with
 * "- HH:MM ..." and runs until the next such line; `author` is the text before
 * the first colon ("rose -> Claude Code", "jcode SMOKE worker (order #2 ...)").
 */
export function coordinationEntries(): LogEntry[] {
  const file = coordinationFile();
  try {
    const st = fs.statSync(file);
    if (logCache && logCache.file === file && logCache.mtime === st.mtimeMs) return logCache.entries;
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    const entries: LogEntry[] = [];
    for (const line of lines) {
      const m = /^-\s+(?:(\d{1,2}:\d{2})\s+)?(.*)$/.exec(line);
      if (m && /^\s*-/.test(line)) {
        const rest = m[2] ?? "";
        const colon = rest.indexOf(":");
        const author = (colon >= 0 ? rest.slice(0, colon) : rest).trim();
        const time = m[1] ?? "";
        const body = colon >= 0 ? rest.slice(colon + 1) : "";
        entries.push({ time, author, text: `${author}:${body}` });
      } else if (entries.length && line.trim()) {
        entries[entries.length - 1].text += `\n${line}`;
      }
    }
    logCache = { file, mtime: st.mtimeMs, entries };
    return entries;
  } catch {
    return [];
  }
}

const ROLE_STOP = new Set([
  "CEO", "DONE", "PASS", "REDO", "FAIL", "ACK", "NOTE", "NOTE", "JSON", "HTTP", "HTTPS", "API", "TS", "TSX", "MD",
  "OK", "ID", "UI", "UX", "SESSION", "JCODE", "RUN", "RUNS", "NEW", "AND", "NOT", "ALL", "ONE", "TWO", "LOG", "LOGS",
  "DIR", "FILE", "FILES", "TODO", "CLI", "GATE", "GATES", "SLACK", "SPEC", "SPECS", "DOC", "DOCS", "TEST",
  "TESTS", "MOCK", "TEMP", "CPU", "RAM", "PID", "PIDS", "URL", "URLS", "ENV", "SRC", "PUBLIC", "IF", "IT",
  "THE", "THIS", "THAT", "SYSTEM", "SERVER", "ROUTER", "STOP", "ONLY", "ALSO", "TASK", "TASKS", "WORK", "ORDER",
  // Common English words that show up in ALL CAPS inside the log and are not roles.
  "STILL", "NOW", "AFTER", "BEFORE", "WHEN", "THEN", "BOTH", "WAIT", "READ", "POST", "SEND", "KEEP", "OPEN",
  "CLOSE", "MOVE", "USE", "ADD", "WITH", "FROM", "INTO", "OVER", "THAN", "THEY", "HAVE", "BEEN", "MUST",
  "WILL", "HERE", "THERE", "SAME", "NEXT", "LAST", "FIRST", "FOUR", "FIVE", "SIX", "THREE", "ZERO", "ANY",
  "DAY", "AM", "PM", "UTC", "ETA", "ASAP", "WIP", "TODO", "DONE", "CALL", "CALLS", "TIME", "HOURS", "MINS",
]);

function roleToken(t: string): boolean {
  return /^[A-Z][A-Z0-9-]{2,}$/.test(t) && !ROLE_STOP.has(t) && !/^\d+$/.test(t);
}

function entryMentions(entry: LogEntry, name: string, id: string): boolean {
  const text = entry.text;
  if (text.includes(`session_${name}_`) || text.includes(id)) return true;
  return new RegExp(`\\b${name}\\b`, "i").test(text);
}

/**
 * Did THIS session write the entry? Being mentioned is not reporting - the log is
 * full of the manager telling sessions what to do. An entry counts as the session's
 * report when its AUTHOR names the session ("rose -> Claude Code"), names its role
 * ("jcode SMOKE worker (order #2 ...)" for session duckling), or the text carries
 * the full session id.
 */
function entryAuthoredBy(entry: LogEntry, name: string, id: string, role: string | undefined): boolean {
  if (entry.text.includes(id) || entry.text.includes(`session_${name}_`)) return true;
  if (new RegExp(`\\b${name}\\b`, "i").test(entry.author)) return true;
  if (role && role.length >= 3 && new RegExp(`\\b${role}\\b`).test(entry.author.toUpperCase())) return true;
  return false;
}

function roleAuthorMentions(entry: LogEntry, name: string): boolean {
  return new RegExp(`\\b${name}\\b`, "i").test(entry.author);
}

/**
 * Best-effort role label for a jcode session (e.g. "UI-SHELL", "OPS", "AUTOCLOSE")
 * from the coordination log: "ROLE=name", "ROLE (name)", "ROLE = session name",
 * "ROLE (session_<name>_...)" or the author line of its own entries.
 */
export function roleForSession(name: string, id: string): string | undefined {
  const entries = coordinationEntries().filter((e) => entryMentions(e, name, id));
  const patterns = [
    new RegExp(`([A-Z][A-Z0-9-]{2,})['\"]?\\s*=\\s*session\\s+${name}`, "i"),
    new RegExp(`([A-Z][A-Z0-9-]{2,})\\s*[=(]\\s*(?:session_)?${name}\\b`, "i"),
    new RegExp(`([A-Z][A-Z0-9-]{2,})\\s*(?:session)?\\s*\\(\\s*session_${name}`, "i"),
    new RegExp(`(?:session_)?${name}\\s*[)=]\\s*([A-Z][A-Z0-9-]{2,})`, "i"),
  ];
  for (const re of patterns) {
    for (const e of entries) {
      const m = re.exec(e.text);
      if (m && roleToken(m[1].toUpperCase())) return m[1].toUpperCase();
    }
  }
  // Fall back to an all-caps token in the author line ("jcode SMOKE worker ...").
  for (const e of entries.filter((x) => roleAuthorMentions(x, name))) {
    for (const tok of e.author.split(/[^A-Za-z0-9-]+/)) {
      const t = tok.toUpperCase();
      if (roleToken(t) && t !== "JCODE") return t;
    }
  }
  return undefined;
}

// ── jcode sessions (read-only) ──────────────────────────────────────────────

type JournalInfo = { lastActivityAt: string; lines: string[]; files: string[] };

type SessionMeta = {
  id: string;
  shortName: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  order: string;
  workingDir: string;
  model: string;
  status: string;
  messageCount: number;
};

const MESSAGE_TEXT_MAX = 400;
/** Journals: only the tail is ever needed (the last lines of activity). */
const JOURNAL_TAIL_BYTES = 192 * 1024;
/**
 * Session metas grow with the whole conversation (measured here: one live session's
 * `<id>.json` was 1.7 MB, 17 of them totalled 13.2 MB). Reading and JSON.parsing all
 * of that synchronously in a request or a watcher tick stalled the control plane's
 * event loop for ~0.3-1.0s, so a meta bigger than this is never parsed: only its
 * head is read and the interesting fields are scraped (see readSessionMeta).
 */
const META_FULL_MAX_BYTES = 192 * 1024;
/** The first user message sits a few KB into the file; 128 KB is a very wide margin. */
const META_HEAD_BYTES = 128 * 1024;

function decodeJsonString(s: string): string {
  return s.replace(/\\n/g, " ").replace(/\\r/g, " ").replace(/\\t/g, " ").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

/**
 * The first real user message from a RAW (unparsed) meta slice - used when the file is
 * too big to parse. Walks `"role":"user"` occurrences and skips the session-context
 * system-reminder, which is always the first one.
 */
function firstUserTextFromRaw(raw: string): string {
  const roleRe = /"role"\s*:\s*"user"/g;
  let m: RegExpExecArray | null;
  while ((m = roleRe.exec(raw))) {
    const window = raw.slice(m.index, m.index + 8000);
    const t = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(window);
    if (!t) continue;
    const text = decodeJsonString(t[1]);
    if (!text.trim()) continue;
    if (/<system-reminder>/i.test(text) && text.trim().startsWith("<system-reminder>")) continue;
    return clip(cleanOrder(text), MESSAGE_TEXT_MAX);
  }
  return "";
}

/**
 * The CEO-facing text of a session's order. Worker sessions start with a boilerplate
 * preamble ("You are a jcode worker session spawned by Claude Code ... YOUR WORK
 * ORDER: ..."), and some transcripts arrive with a broken prefix before
 * "[transcription]", so both are stripped: the card and the manager prompt should
 * read the actual work order, not the harness.
 */
function cleanOrder(raw: string): string {
  const stripped = raw.replace(/^[\s\S]{0,60}?\[transcription\]/i, "").trim();
  const m = /(?:YOUR WORK ORDER|WORK ORDER|YOUR TASK|YOUR ORDER|WORK ORDER FROM[^:]*)\s*[:\-]\s*([\s\S]+)/i.exec(stripped);
  if (m && m[1].trim().length > 20) return m[1].trim();
  return stripped;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: unknown; text?: unknown };
    if (typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

function firstUserMessage(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const rec = m as { role?: unknown; content?: unknown };
    if (rec.role !== "user") continue;
    const text = textFromContent(rec.content);
    if (!text) continue;
    // The first entry of every jcode session is a system-reminder, not the order.
    if (/<system-reminder>/i.test(text) && text.trim().startsWith("<system-reminder>")) continue;
    return clip(cleanOrder(text), MESSAGE_TEXT_MAX);
  }
  return "";
}

/** Tolerant meta read: full JSON when it parses, regex field-scrape when it is huge/truncated. */
function readSessionMeta(id: string, journalMtime: number): SessionMeta | undefined {
  const file = path.join(jcodeHome(), "sessions", `${id}.json`);
  // PERF (manager's profile, 2026-09-29). This is the most expensive read in the scan:
  // either a full JSON.parse of a session meta (up to 192 KB) or a 128 KB head plus a
  // regex scrape, for every session, on every pass. The value depends only on the file's
  // bytes AND on journalMtime (used as the updatedAt fallback when the meta carries no
  // updated_at), so BOTH go into the key: same bytes + same journalMtime -> the exact
  // same object the old code would have built. A session that has not written anything
  // since the last pass now costs one stat() instead of a read + parse.
  // The cached object is SHARED and read-only to callers.
  const sig = sigOf(fileSig(file), journalMtime);
  return cachedBySig<SessionMeta | undefined>(`runManagers:sessionMeta:${file}`, sig, () =>
    readSessionMetaUncached(id, journalMtime, file),
  );
}

/** Unmemoised body of readSessionMeta(): tolerant meta read for one session file. */
function readSessionMetaUncached(id: string, journalMtime: number, file: string): SessionMeta | undefined {
  let raw = "";
  let parsedMeta: Record<string, unknown> | undefined;
  try {
    const st = fs.statSync(file);
    if (st.size <= META_FULL_MAX_BYTES) {
      raw = fs.readFileSync(file, "utf8");
      parsedMeta = JSON.parse(raw) as Record<string, unknown>;
    } else {
      // A long session's meta is megabytes; the whole conversation is not needed,
      // only the identity fields and the first user message near the front.
      raw = readHead(file, META_HEAD_BYTES);
    }
  } catch {
    // Unreadable or unparsable: fall through to the tolerant scrape below.
  }
  const base: SessionMeta = {
    id,
    shortName: id.replace(/^session_/, "").split("_")[0] ?? "",
    title: "",
    createdAt: "",
    updatedAt: "",
    order: "",
    workingDir: "",
    model: "",
    status: "",
    messageCount: 0,
  };
  if (parsedMeta) {
    const meta = parsedMeta as {
      short_name?: unknown; title?: unknown; created_at?: unknown; updated_at?: unknown;
      working_dir?: unknown; model?: unknown; status?: unknown; messages?: unknown;
    };
    return {
      ...base,
      shortName: typeof meta.short_name === "string" && meta.short_name ? meta.short_name : base.shortName,
      title: typeof meta.title === "string" ? meta.title : "",
      createdAt: typeof meta.created_at === "string" ? meta.created_at : "",
      updatedAt: typeof meta.updated_at === "string" ? meta.updated_at : new Date(journalMtime).toISOString(),
      order: firstUserMessage(meta.messages),
      workingDir: typeof meta.working_dir === "string" ? meta.working_dir : "",
      model: typeof meta.model === "string" ? meta.model : "",
      status: typeof meta.status === "string" ? meta.status : "",
      messageCount: Array.isArray(meta.messages) ? meta.messages.length : 0,
    };
  }
  if (!raw) return undefined;
  const grab = (key: string): string => {
    const mm = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(raw);
    return mm ? decodeJsonString(mm[1]) : "";
  };
  return {
    ...base,
    shortName: grab("short_name") || base.shortName,
    title: grab("title"),
    createdAt: grab("created_at"),
    updatedAt: grab("updated_at") || new Date(journalMtime).toISOString(),
    order: firstUserTextFromRaw(raw),
    workingDir: grab("working_dir"),
    model: grab("model"),
    status: grab("status"),
    messageCount: 0,
  };
}

const FILE_HINT_RE = /(?:[A-Za-z]:\\[^\s"'<>|*,;]+|(?:src|public|docs|ops|company|scripts|tests)[\\/][^\s"'<>|*,;)]+)/g;
/** Bare filenames with a known extension ("flow-check.txt"), resolved against the run's own root. */
const BARE_FILE_RE = /\b[A-Za-z0-9_.-]+\.(?:md|txt|json|ts|tsx|js|mjs|cjs|ps1|log|yml|yaml|csv|html|css)\b/g;

function normalizeHintPath(p: string, base: string): string | undefined {
  const cleaned = p.replace(/[.,;:)]+$/, "");
  if (cleaned.length < 4 || cleaned.includes("...")) return undefined;
  const abs = path.isAbsolute(cleaned) ? cleaned : path.resolve(base, cleaned);
  return abs;
}

/** Journal tail: last activity timestamp + a bounded text tail + files the session touched. */
function readJournal(id: string): JournalInfo {
  const file = path.join(jcodeHome(), "sessions", `${id}.journal.jsonl`);
  // PERF (manager's profile, 2026-09-29). A journal is appended to constantly, but this
  // was re-read (up to 192 KB) and its last 80 lines re-parsed on EVERY discovery pass,
  // for every session - the single biggest read in the scan. The parsed tail is a pure
  // function of the file's bytes, so it is memoised on mtime+size (the cache.ts rule):
  // an unchanged journal costs one stat() instead of a read + JSON.parse. The cached
  // object is SHARED and read-only (discoverJcodeRuns spreads .lines into a fresh array).
  return cachedBySig<JournalInfo>(`runManagers:journal:${file}`, fileSig(file), () => parseJournal(file));
}

/** Unmemoised body of readJournal(): parse the tail of one journal file. */
function parseJournal(file: string): JournalInfo {
  const raw = readTail(file, JOURNAL_TAIL_BYTES);
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const out: string[] = [];
  const files = new Set<string>();
  let lastActivityAt = "";
  for (const line of lines.slice(-80)) {
    try {
      const rec = JSON.parse(line) as { meta?: { updated_at?: unknown }; append_messages?: unknown };
      const stamp = rec.meta && typeof rec.meta.updated_at === "string" ? rec.meta.updated_at : "";
      if (stamp) lastActivityAt = stamp;
      if (!Array.isArray(rec.append_messages)) continue;
      for (const msg of rec.append_messages) {
        if (!msg || typeof msg !== "object") continue;
        const m = msg as { role?: unknown; content?: unknown };
        const role = typeof m.role === "string" ? m.role : "?";
        if (!Array.isArray(m.content)) continue;
        for (const block of m.content) {
          if (!block || typeof block !== "object") continue;
          const b = block as { type?: unknown; text?: unknown; name?: unknown; input?: unknown };
          if (typeof b.text === "string" && b.text.trim() && b.type !== "tool_result") {
            out.push(`${role}: ${clip(b.text, 300)}`);
          } else if (b.type === "tool_use" && typeof b.name === "string") {
            const input = (b.input ?? {}) as Record<string, unknown>;
            const fp = [input.file_path, input.path, input.notebook_path].find((v) => typeof v === "string") as string | undefined;
            if (fp) files.add(fp);
            const detail = fp ?? (typeof input.command === "string" ? input.command : JSON.stringify(input));
            out.push(`${role} [tool ${b.name}]: ${clip(detail, 200)}`);
          }
        }
      }
    } catch {
      // partial/oversized journal line: ignore
    }
  }
  return { lastActivityAt, lines: out.slice(-16), files: [...files].slice(-8) };
}

function sessionStateDir(name: "streaming_pids" | "active_pids", id: string): boolean {
  try {
    return fs.existsSync(path.join(jcodeHome(), name, id));
  } catch {
    return false;
  }
}

function discoverJcodeRuns(now: number, stuckMinutes: number): Run[] {
  const dir = path.join(jcodeHome(), "sessions");
  const activeMinutes = runManagerKnobs().jcodeActiveMinutes;
  const out: Run[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".journal.jsonl"));
  } catch {
    return out; // no jcode sessions on this machine (or no permission): no jcode runs
  }
  // The coordination log is ONE file for every session (and coordinationEntries() is
  // itself mtime-cached), so parse it once per scan instead of two times per session.
  // Same entries, same order - the filters below just read a shared array.
  const logEntries = coordinationEntries();
  for (const f of names) {
    const id = f.replace(/\.journal\.jsonl$/, "");
    const file = path.join(dir, f);
    try {
      const st = fs.statSync(file);
      const journal = readJournal(id);
      const last = journal.lastActivityAt || new Date(st.mtimeMs).toISOString();
      const updatedAtMs = Math.max(parseMs(last), st.mtimeMs);
      const streaming = sessionStateDir("streaming_pids", id);
      if (!streaming && (now - updatedAtMs) / 60000 > activeMinutes) continue;
      const meta = readSessionMeta(id, updatedAtMs);
      if (!meta) continue;
      const role = roleForSession(meta.shortName, id);
      const owner = `jcode ${meta.shortName}${role ? ` (${role})` : ""}`;
      const mentions = logEntries.filter((e) => entryMentions(e, meta.shortName, id));
      const authored = logEntries.filter((e) => entryAuthoredBy(e, meta.shortName, id, role));
      const reportMd = path.join(reportsDir(), "terminals", `${meta.shortName}.md`);
      const reported = authored.length > 0 || fs.existsSync(reportMd);
      const stale = !streaming && minutesSince(new Date(updatedAtMs).toISOString(), now) > stuckMinutes;
      const state: RunState = streaming ? "working" : reported ? "done" : stale ? "stuck" : "working";
      const title = clip(meta.order || meta.title || journal.lines.find((l) => l.startsWith("user:"))?.replace(/^user:\s*/, "") || `${meta.shortName}'s session`, 140);
      const logTail = mentions.slice(-2).map((e) => `${e.time} ${clip(e.text, 700)}`).join("\n");
      const fileChecks = journal.files
        .map((p) => normalizeHintPath(p, meta.workingDir || repoRoot()))
        .filter((p): p is string => !!p)
        .slice(0, 8)
        .map((p) => `${p.length > 110 ? `...${p.slice(-110)}` : p} -> ${fs.existsSync(p) ? "exists" : "MISSING"}`);
      const evidence = [
        `RUN ${id} (kind=jcode)`,
        `owner: ${owner}${role ? "" : " (role unknown - not in the coordination log yet)"}`,
        `session: ${meta.shortName} | model: ${meta.model || "?"} | messages: ${meta.messageCount || "?"}`,
        `created: ${meta.createdAt || "?"} | last activity: ${new Date(updatedAtMs).toISOString()} (${Math.round(minutesSince(new Date(updatedAtMs).toISOString(), now))} min ago)`,
        `streaming now: ${streaming} | reported: ${reported} (its own log entries: ${authored.length}, REPORT.md: ${fs.existsSync(reportMd) ? "yes" : "no"})`,
        `working dir: ${meta.workingDir || "?"}`,
        ``,
        `WORK ORDER (first user message):`,
        clip(meta.order || meta.title || "(no order recorded)", 900),
        ``,
        `RECENT JOURNAL TAIL:`,
        ...(journal.lines.length ? journal.lines : ["(journal empty)"]),
        ``,
        `FILES THE SESSION TOUCHED (existence checked just now):`,
        ...(fileChecks.length ? fileChecks : ["(none visible in the journal tail)"]),
        ``,
        `ITS OWN COORDINATION LOG ENTRIES:`,
        logTail || "(none - this session has not written a log entry yet)",
      ].join("\n");
      out.push({
        runId: `jcode:${id}`,
        kind: "jcode",
        title,
        owner,
        order: meta.order || meta.title || title,
        state,
        reported,
        updatedAt: new Date(updatedAtMs).toISOString(),
        evidenceHash: sha1([`jcode`, id, last, st.size, streaming ? "s" : "-", reported ? "r" : "-"].join("|")),
        evidence: clip(evidence, 6000),
        placeholder: {
          headline: `${owner} is ${state === "stuck" ? "idle without reporting" : state === "done" ? "done" : "working"} on: ${title}`,
          done: reported ? ["Reported back in the coordination log"] : [],
          remaining: state === "done" ? [] : [title],
        },
        ref: { kind: "jcode", sessionId: id, sessionName: meta.shortName },
      });
    } catch {
      // one unreadable session must not hide the rest
    }
  }
  return out;
}

// ── company tasks ───────────────────────────────────────────────────────────

const GATE_LABEL: Record<"intake" | "code" | "merge", string> = {
  intake: "approve the request before work starts",
  code: "approve the plan before coding starts",
  merge: "approve the merge to finish it",
};

function pendingGate(t: TaskRec): "intake" | "code" | "merge" | undefined {
  if (t.status === "pending_intake" && !t.gates?.intake) return "intake";
  if (t.status === "pending_code" && !t.gates?.code) return "code";
  if (t.status === "pending_merge" && !t.gates?.merge) return "merge";
  if (t.status === "pending_intake" || t.status === "pending_code" || t.status === "pending_merge") return "merge";
  return undefined;
}

function traceText(trace: TraceStep[] | undefined, max = 14): string {
  const steps = (trace ?? []).slice(-max);
  if (!steps.length) return "(no trace - this task never went through the hand-off chain)";
  return steps.map((s) => `${s.ts.slice(11, 19)} ${s.from} -> ${s.to} [${s.what}]${s.detail ? `: ${clip(s.detail, 160)}` : ""}`).join("\n");
}

// Local optional extensions: NY-CLEANUP writes these fields, NY-RULE only reads them.
type ClosedTaskRec = TaskRec & {
  closedAs?: "dropped" | "superseded";
  supersededBy?: string;
  closedReason?: string;
  closedAt?: string;
  closedBy?: string;
  ceoChoice?: { question: string; options: string[]; recommended?: string };
};

function taskState(t: ClosedTaskRec, now: number, stuckMinutes: number): RunState {
  // Rule change (docs/NEEDS_YOU_RULE_SPEC.md §2): closed/dropped/superseded records
  // are shown as done and removed from both needsYou and problems.
  if (t.closedAs) return "done";
  if (t.status === "merged") return "done";
  if (t.status === "failed" || t.status === "rejected") {
    // In-memory drop for no-op / smoke-test / tracking-only failures.
    if (isNoOpTask(t)) return "done";
    return "failed";
  }
  const gate = pendingGate(t);
  if (gate && !IN_MOTION.includes(t.status)) {
    // Only a genuine CEO choice (no recommended default) parks on the CEO now;
    // pending gates otherwise become working/stuck and are auto-nudged.
    if (t.ceoChoice && t.ceoChoice.recommended === undefined) return "waiting_for_ceo";
    return minutesSince(t.updatedAt, now) > stuckMinutes ? "stuck" : "working";
  }
  if (IN_MOTION.includes(t.status)) {
    return minutesSince(t.updatedAt, now) > stuckMinutes ? "stuck" : "working";
  }
  return "working";
}

function discoverTaskRuns(now: number, stuckMinutes: number): Run[] {
  const org = loadOrg();
  const windowMinutes = runManagerKnobs().windowHours * 60;
  const out: Run[] = [];
  for (const p of org.projects ?? []) {
    let tasks: ClosedTaskRec[] = [];
    try {
      tasks = loadTasks(p.id) as ClosedTaskRec[];
    } catch {
      tasks = [];
    }
    const dept = (org.departments ?? []).find((d) => d.id === p.departmentId)?.name ?? "Unassigned";
    for (const t of tasks) {
      const state = taskState(t, now, stuckMinutes);
      const inFlightRun = state === "working" || state === "stuck" || state === "waiting_for_ceo";
      if (!inFlightRun && minutesSince(t.updatedAt, now) > windowMinutes) continue;
      const gate = pendingGate(t);
      const title = clip(t.rawRequest, 140);

      // Closed/dropped/superseded records get a "Closed (...)" headline. Pending
      // gate tasks are no longer shown as waiting_for_ceo (they are auto-nudged),
      // except for a genuine ceoChoice with no recommended default.
      const closedLabel =
        t.closedAs && t.closedReason
          ? `Closed (${t.closedReason}): ${title} (${p.name})`
          : t.closedAs
            ? `Closed (${t.closedAs}${t.supersededBy ? ` by ${t.supersededBy}` : ""}): ${title} (${p.name})`
            : state === "done" && (t.status === "failed" || t.status === "rejected") && isNoOpTask(t)
              ? `Closed (dropped: smoke-test / no-op): ${title} (${p.name})`
              : undefined;
      const headline =
        closedLabel ??
        `${t.status === "merged" ? "Finished" : t.status === "failed" ? "Failed" : "In progress"}: ${title} (${p.name})`;
      const needsCeo =
        state === "waiting_for_ceo" && t.ceoChoice && t.ceoChoice.recommended === undefined
          ? t.ceoChoice.question
          : undefined;
      const closure: Run["closure"] | undefined = t.closedAs
        ? { as: t.closedAs, by: t.supersededBy ?? t.closedReason }
        : state === "done" && (t.status === "failed" || t.status === "rejected") && isNoOpTask(t)
          ? { as: "dropped", by: "smoke-test / no-op" }
          : undefined;

      const hints = [...new Set([
        ...((t.result ?? "").match(FILE_HINT_RE) ?? []),
        ...((t.result ?? "").match(BARE_FILE_RE) ?? []),
      ])];
      const rootDir = p.rootDir ?? repoRoot();
      const files = hints
        .slice(0, 8)
        .map((hint) => {
          const abs = normalizeHintPath(hint, rootDir);
          return abs ? `${hint} -> ${fs.existsSync(abs) ? "exists" : "MISSING"}` : undefined;
        })
        .filter((s): s is string => !!s);
      // A bounded listing of the project's own root: lets the manager verify claims
      // about files BY NAME (the spec's rule is check the evidence, not the summary).
      const listing = (() => {
        try {
          return fs.readdirSync(rootDir, { withFileTypes: true })
            .slice(0, 20)
            .map((e) => `${e.isDirectory() ? "[dir] " : "      "}${e.name}`)
            .join("\n");
        } catch {
          return "(project root not readable)";
        }
      })();
      const evidence = [
        `RUN task:${p.id}:${t.id} (kind=task)`,
        `project: ${p.name} (id=${p.id}), department ${dept}`,
        `status: ${t.status} | gates: intake=${t.gates?.intake} code=${t.gates?.code} merge=${t.gates?.merge} | loops: ${t.loopCount}`,
        `created: ${t.createdAt} | last change: ${t.updatedAt} (${Math.round(minutesSince(t.updatedAt, now))} min ago)`,
        `has result: ${t.result ? `yes (${t.result.length} chars)` : "no"} | error: ${t.error ? clip(t.error, 300) : "none"} | manager review: ${t.review ? clip(t.review, 300) : "none"}`,
        ``,
        `WORK ORDER:`,
        clip(t.rawRequest, 700),
        ``,
        `BRIEF (after enhancement):`,
        clip(t.enhancedBrief ?? "(none)", 500),
        ``,
        `PLAN:`,
        clip(t.plan ?? "(none)", 600),
        ``,
        `TEAM ASSIGNED:`,
        (t.assignments ?? []).slice(0, 8).map((a) => `${a.agentId} (${a.role}) model=${a.modelId ?? "?"} - ${clip(a.subtask, 120)}`).join("\n") || "(none)",
        ``,
        `HAND-OFF CHAIN (task.trace):`,
        traceText(t.trace),
        ``,
        `RESULT:`,
        clip(t.result ?? "(none)", 1200),
        ``,
        `FILES THE RESULT CLAIMS (existence checked just now):`,
        files.length ? files.join("\n") : "(no file paths found in the result)",
        ``,
        `PROJECT ROOT (${rootDir}, first 20 entries):`,
        listing,
      ].join("\n");
      out.push({
        runId: `task:${p.id}:${t.id}`,
        kind: "task",
        title,
        owner: `${dept} team (${p.name})`,
        order: t.rawRequest,
        state,
        reported: state === "done" || !!t.result,
        updatedAt: t.updatedAt,
        evidenceHash: sha1([t.status, t.updatedAt, t.loopCount, t.gates?.intake, t.gates?.code, t.gates?.merge, (t.trace ?? []).length, t.trace?.at(-1)?.ts ?? "", (t.result ?? "").length, t.error ? "e" : "-"].join("|")),
        evidence: clip(evidence, 6000),
        addDirs: [rootDir],
        placeholder: {
          headline,
          done: t.status === "merged" ? [clip(t.result ?? "Task merged", 90)] : [],
          remaining: state === "done" ? [] : [t.status === "failed" ? clip(t.error ?? "it failed", 90) : `${p.name}: ${title}`],
          ...(needsCeo ? { needsCeo } : {}),
        },
        ref: { kind: "task", projectId: p.id, taskId: t.id },
        ...(closure ? { closure } : {}),
      });

      // Rate-limited auto-restart for gate tasks: approve the gate and resume the
      // pipeline, the same calls the CEO's approve route makes. Never throws.
      if (gate && !(t.ceoChoice && t.ceoChoice.recommended === undefined)) {
        maybeAutoNudge(p.id, t.id, gate, `task:${p.id}:${t.id}`);
      }
    }
  }
  return out;
}

// ── rate-limited auto-restart for pending gate tasks ────────────────────────
//
// Pending intake/code/merge gates are no longer "waiting_for_ceo". Instead we
// auto-approve and resume them, once per task per 10 minutes, using the exact
// same calls the CEO's gate route uses. NEEDS_YOU_AUTO_NUDGE=0 disables the
// restart but still keeps the item off the list.

type NudgeEntry = { at: string; runId: string; gate: string; ok: boolean; message: string };

const lastAutoNudge = new Map<string, number>();

(function seedLastNudges() {
  try {
    const file = path.join(reportsDir(), "auto-nudges.json");
    if (!fs.existsSync(file)) return;
    const arr = JSON.parse(fs.readFileSync(file, "utf8")) as NudgeEntry[];
    for (const e of arr) {
      if (!e.runId || !e.at) continue;
      const t = Date.parse(e.at);
      if (!Number.isFinite(t)) continue;
      const prev = lastAutoNudge.get(e.runId) ?? 0;
      if (t > prev) lastAutoNudge.set(e.runId, t);
    }
  } catch {
    // seeding is best effort; the rate limit is a safety rail, not a guarantee
  }
})();

function autoNudgeEnabled(): boolean {
  const raw = (process.env.NEEDS_YOU_AUTO_NUDGE ?? "").trim().toLowerCase();
  if (!raw) return true;
  return !(raw === "0" || raw === "false" || raw === "off");
}

function appendAutoNudge(entry: NudgeEntry): void {
  try {
    const file = path.join(reportsDir(), "auto-nudges.json");
    let arr: NudgeEntry[] = [];
    if (fs.existsSync(file)) arr = JSON.parse(fs.readFileSync(file, "utf8")) as NudgeEntry[];
    arr.push(entry);
    if (arr.length > 500) arr = arr.slice(-500);
    writeJsonAtomic(file, arr);
  } catch {
    // nudge log is best effort; never break discovery
  }
}

function maybeAutoNudge(projectId: string, taskId: string, gate: "intake" | "code" | "merge", runId: string): void {
  if (!autoNudgeEnabled()) return;
  const now = Date.now();
  const last = lastAutoNudge.get(runId) ?? 0;
  if (now - last < 10 * 60 * 1000) return;
  lastAutoNudge.set(runId, now);
  void (async () => {
    try {
      approveGate(projectId, taskId, gate);
      const resumed = resumeTask(projectId, taskId);
      appendAutoNudge({ at: nowIso(), runId, gate, ok: resumed, message: resumed ? "auto-approved and resumed" : "approved but pipeline already active" });
    } catch (e) {
      const message = clip(e instanceof Error ? e.message : String(e), 200);
      appendAutoNudge({ at: nowIso(), runId, gate, ok: false, message });
    }
  })();
}

// ── fleet work orders (tolerated when absent) ───────────────────────────────

type FleetWorkOrder = {
  id?: string; title?: string; role?: string; state?: string; verdict?: string; review?: string;
  sessionId?: string; attempts?: number;
};
type FleetOrder = {
  id?: string; text?: string; createdAt?: string; updatedAt?: string; status?: string; error?: string;
  workOrders?: FleetWorkOrder[]; trace?: TraceStep[];
};

// Local optional extensions: NY-CLEANUP writes these fields, NY-RULE only reads them.
type ClosedFleetOrder = FleetOrder & {
  closedAs?: "superseded" | "dropped";
  supersededBy?: string;
  closedReason?: string;
  closedAt?: string;
  closedBy?: string;
  supersedes?: string[];
};

function fleetState(status: string | undefined, workOrders: FleetWorkOrder[], now: number, stuckMinutes: number, updatedAt: string | undefined): RunState {
  const anyRedo = workOrders.some((w) => w.verdict === "REDO");
  const anyFailed = workOrders.some((w) => w.state === "failed");
  if (status === "done") return "done";
  if (status === "failed" || status === "cancelled" || anyFailed) return "failed";
  if (status === "awaiting_approval") return "waiting_for_ceo";
  if (status === "planning" || status === "running" || status === "reviewing") {
    if (anyRedo) return "working";
    return minutesSince(updatedAt, now) > stuckMinutes ? "stuck" : "working";
  }
  return "working";
}

function discoverFleetRuns(now: number, stuckMinutes: number): Run[] {
  const file = path.join(getCompanyRoot(), "fleet", "orders.json");
  const orders = readJson<ClosedFleetOrder[]>(file);
  if (!Array.isArray(orders)) return []; // FLEET-BACKEND has not landed yet: no fleet runs
  const out: Run[] = [];
  for (const o of orders.slice(-20)) {
    if (!o?.id) continue;
    const workOrders = Array.isArray(o.workOrders) ? o.workOrders : [];
    let state = fleetState(o.status, workOrders, now, stuckMinutes, o.updatedAt);
    const isSuperseded = isSupersededOrder(o, orders) || o.closedAs === "superseded" || !!o.supersededBy;
    // DUPLICATE-PROMPTS: a cancelled (dropped) order is closed too. Without this the
    // order kept showing as a failed run and its "Retry this order or drop it?" prompt
    // came back after any card update.
    const isCancelled = o.status === "cancelled";
    const closure: Run["closure"] | undefined = o.closedAs
      ? { as: o.closedAs, by: o.supersededBy ?? o.closedReason }
      : isSuperseded
        ? { as: "superseded", by: o.supersededBy ?? "later finished order" }
        : isCancelled
          ? { as: "dropped", by: o.closedReason ?? "cancelled by the CEO" }
          : undefined;
    // Closed/superseded/dropped fleet orders are shown as done and never counted as failed.
    if (closure && state === "failed") state = "done";

    const title = clip(o.text ?? "(no order text)", 140);
    const closedLabel =
      closure && closure.by
        ? `Closed (${closure.as} by ${closure.by}): ${title}`
        : closure
          ? `Closed (${closure.as}): ${title}`
          : undefined;
    const headline = closedLabel ?? `Fleet order is ${o.status}: ${title}`;

    const verdict: RunVerdict | undefined = state === "done" && !closure
      ? "PASS"
      : workOrders.some((w) => w.verdict === "REDO")
        ? "REDO"
        : state === "failed"
          ? "FAIL"
          : undefined;
    const evidence = [
      `RUN fleet:${o.id} (kind=fleet)`,
      `status: ${o.status} | created: ${o.createdAt} | updated: ${o.updatedAt} (${Math.round(minutesSince(o.updatedAt, now))} min ago)`,
      `error: ${o.error ? clip(o.error, 300) : "none"}`,
      ``,
      `ORDER FROM THE CEO:`,
      clip(o.text, 700),
      ``,
      `WORK ORDERS (${workOrders.length}):`,
      workOrders.map((w) => `${w.id} [${w.state}] ${clip(w.title, 100)} role=${w.role} attempts=${w.attempts ?? 0} verdict=${w.verdict ?? "-"}${w.review ? ` review=${clip(w.review, 200)}` : ""}`).join("\n") || "(none)",
      ``,
      `TRACE:`,
      traceText(o.trace),
    ].join("\n");
    out.push({
      runId: `fleet:${o.id}`,
      kind: "fleet",
      title,
      owner: "Fleet (Claude plans, jcode executes)",
      order: o.text ?? "",
      state,
      reported: workOrders.some((w) => w.state === "reported" || w.state === "reviewed" || !!w.verdict),
      updatedAt: o.updatedAt ?? o.createdAt ?? "",
      evidenceHash: sha1([o.status, o.updatedAt, workOrders.map((w) => `${w.id}:${w.state}:${w.attempts}:${w.verdict ?? ""}`).join(",")].join("|")),
      evidence: clip(evidence, 6000),
      placeholder: {
        headline,
        done: workOrders.filter((w) => w.verdict === "PASS").map((w) => clip(w.title ?? w.id ?? "work order", 90)),
        remaining: workOrders.filter((w) => w.verdict !== "PASS").map((w) => clip(w.title ?? w.id ?? "work order", 90)),
        ...(o.status === "awaiting_approval" && !closure ? { needsCeo: "Approve Claude's plan to start the workers" } : {}),
        // A failed order whose own error is the expired sign-in keeps the DETERMINISTIC reason
        // (the manager's own needsCeo line is written by a cheap model and is dropped for a
        // non-waiting card, which is how this fact used to get lost).
        ...(o.status === "failed" && !closure && mentionsClaudeSignInExpired(o.error) ? { needsCeo: CLAUDE_SIGNIN_EXPIRED_MESSAGE } : {}),
      },
      ref: { kind: "fleet", orderId: o.id },
      ...(closure ? { closure } : {}),
      ...(verdict ? { fleetVerdict: verdict, fleetVerdictReason: o.status === "done" ? "the fleet review passed every work order" : "the fleet review flagged a work order" } : {}),
      // RETRY LOOP: a failed, still-open order carries WHY it failed and whether its retry
      // budget is spent, so the briefing can key the prompt on (job, cause) and stop
      // offering a retry that cannot work.
      ...(state === "failed" && !closure
        ? { fleetFailureCause: orderFailureCause(o), fleetRetryExhausted: orderRetryExhausted(o, orders) }
        : {}),
    });
  }
  return out;
}

// ── discovery ───────────────────────────────────────────────────────────────

let discoveryCache: { at: number; runs: Run[] } | undefined;

/**
 * Every run worth the CEO's attention, newest activity first: in-motion tasks plus
 * recent ones, fleet orders, and live/recent jcode sessions. Never throws.
 *
 * Memoised for RUN_DISCOVER_TTL_MS (default 15s) because discovery stats every journal and
 * every session meta and, whenever something did change, reads up to ~2.6 MB of journal
 * tails plus ~1.6 MB of session metas (a full scan measured 97-170 ms of synchronous IO
 * even with a warm page cache). That is far too costly to repeat for each of GET
 * /company/runs, the assistant prompt and the briefing in the same second.
 *
 * Why 15s and not the old 5s: every state this scan decides is minutes-granular
 * (RUN_JCODE_ACTIVE_MINUTES default 240, RUN_STUCK_MINUTES default 15), so a 15s-old
 * snapshot cannot label a run differently except in the 15s around a minute boundary,
 * while the dashboard polls every 2-5s. The manager pass is unaffected: checkRuns()
 * asks for { fresh: true } and always re-scans.
 *
 * The scan itself is also much cheaper now that the journal tails and the session metas
 * are memoised on their own mtime+size (see readJournal/readSessionMeta): a repeat scan
 * with nothing changed costs one stat() per file instead of a re-read and a re-parse.
 */
export function discoverRuns(now = Date.now(), opts: { fresh?: boolean } = {}): Run[] {
  const ttl = envNum("RUN_DISCOVER_TTL_MS", 15000, 0);
  if (!opts.fresh && discoveryCache && now - discoveryCache.at < ttl) return discoveryCache.runs;
  const runs: Run[] = [];
  const { stuckMinutes, maxRuns } = runManagerKnobs();
  for (const source of [discoverTaskRuns, discoverFleetRuns, discoverJcodeRuns]) {
    try {
      runs.push(...source(now, stuckMinutes));
    } catch {
      // a broken source contributes nothing rather than breaking the briefing
    }
  }
  const inFlight = (r: Run) => r.state === "working" || r.state === "stuck" || r.state === "waiting_for_ceo";
  const sorted = runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const kept = sorted.slice(0, maxRuns);
  const keptIds = new Set(kept.map((r) => r.runId));
  for (const r of sorted) {
    if (keptIds.has(r.runId) || !inFlight(r)) continue;
    kept.push(r); // never hide something that is still moving
    keptIds.add(r.runId);
  }
  discoveryCache = { at: now, runs: kept };
  return kept;
}

// ── stored cards ────────────────────────────────────────────────────────────

export function readStoredCard(runId: string): RunCard | undefined {
  const card = readJson<RunCard>(cardFile(runId));
  if (!card || typeof card.runId !== "string") return undefined;
  return card;
}

/**
 * The evidence hash a card settled on. `pending:` marks a card written when the manager
 * check produced no answer (heuristicCard).
 *
 * RETRY LOOP (2026-09-30): the comparison in checkRuns() used the RAW string, so a card
 * written as "pending:H" never equalled the run's own hash "H" - the run was therefore
 * re-checked on every pass for as long as the failing check kept failing, and each pass
 * appended an identical row to runs.jsonl. MEASURED on the live company: fleet order
 * fomumoiq1j held 90 identical FAIL rows ("the fleet review flagged a work order") at
 * ~210 s spacing over 5.5 h, all with hash pending:453d133f64bce879; 125 of the log's
 * 194 verdict rows were that one sentence. Stripping the marker is the fix.
 */
function settledHash(hash: string | undefined): string {
  return String(hash ?? "").replace(/^pending:/, "");
}

// PERF (manager's live profile, 2026-09-29 20:44). This used to read and parse
// every run card on every call. On the live router that measured 3,707 ms of
// synchronous readFileSync inside ONE request, because the stack is
//   readJson <- storedCards <- listRunCards <- GET /company/runs
// and listRunCards() is also called by the briefing refresh and the assistant's
// prompt. Cards only change when a card file is written, so the parse is now
// FIX 2 (docs/ORDER_2026-10-01_loop-fixes-1-2.md, 2026-10-01). This used to cost a
// `readdirSync` PLUS one `statSync` per card (133 cards = 133 stats per call), and the live
// router measured a single card's statSync at 385 ms, so this signature was a BLOCK generator
// (133 BLOCK events / 627 s in 2 h). It is now ONE `statSync` of the runs directory
// (mtime + size), memoised for RUNS_SIG_TTL_MS. `writeCard()` writes tmp + renames, which moves
// the directory mtime, so a real change is picked up on the next call after the TTL; the TTL
// (5-10 s, env-tunable) exists to bound even that one stat. Accepted worst case: a card update
// is noticed up to one briefing tick (30 s) later - the card is already on disk, nothing is
// lost. `cachedBySig` is unchanged and still owns the invalidation.
// The returned array is SHARED: callers copy fields out of it (listRunCards spreads each card
// into a new object) and must not mutate the cards.
const RUNS_SIG_TTL_MS = Number.isFinite(Number(process.env.RUNS_SIG_TTL_MS)) ? Number(process.env.RUNS_SIG_TTL_MS) : 8000;
let runsSigMemo: { at: number; sig: string } | null = null;

function runsDirSignature(): string {
  const now = Date.now();
  if (runsSigMemo && now - runsSigMemo.at < RUNS_SIG_TTL_MS) return runsSigMemo.sig;
  let sig: string;
  try {
    const st = fs.statSync(runsDir());
    sig = `${st.mtimeMs}:${st.size}`;
  } catch {
    sig = "missing";
  }
  runsSigMemo = { at: now, sig };
  return sig;
}

function storedCards(): RunCard[] {
  // ATTRIBUTION (fix 3): label the briefing's card read so a BLOCK here names itself.
  return withBusy("briefing storedCards", () => {
    const dir = runsDir();
    return cachedBySig<RunCard[]>(`runManagers:storedCards:${dir}`, runsDirSignature(), () => {
      try {
        if (!fs.existsSync(dir)) return [];
        return fs
          .readdirSync(dir)
          .filter((f) => f.endsWith(".json"))
          .map((f) => readJson<RunCard>(path.join(dir, f)))
          .filter((c): c is RunCard => !!c && typeof c.runId === "string");
      } catch {
        return [];
      }
    });
  });
}

function writeCard(card: RunCard): void {
  writeJsonAtomic(cardFile(card.runId), card, { file: runsLogFile(), line: `${JSON.stringify(card)}\n` });
}

/**
 * A free, deterministic card for a run no manager has checked yet. Its
 * evidenceHash is marked "pending" so the next manager pass still sees the run as
 * unchecked (a placeholder must never look like a verification).
 */
export function heuristicCard(run: Run): RunCard {
  return {
    runId: run.runId,
    kind: run.kind,
    title: run.title,
    owner: run.owner,
    state: run.state,
    headline: run.placeholder.headline,
    done: run.placeholder.done.slice(0, 6),
    remaining: run.placeholder.remaining.slice(0, 6),
    ...(run.placeholder.needsCeo ? { needsCeo: run.placeholder.needsCeo } : {}),
    model: "local",
    modelReason: "not manager-checked yet (free local status; the manager check is queued)",
    checkedAt: run.updatedAt || nowIso(),
    evidenceHash: `pending:${run.evidenceHash}`,
    ...(run.ref.sessionId ? { sessionId: run.ref.sessionId } : {}),
    ...(run.fleetVerdict ? { verdict: run.fleetVerdict, verdictReason: run.fleetVerdictReason, verifiedAt: run.updatedAt } : {}),
    ...(run.fleetFailureCause ? { fleetFailureCause: run.fleetFailureCause } : {}),
    ...(run.fleetRetryExhausted !== undefined ? { fleetRetryExhausted: run.fleetRetryExhausted } : {}),
    reported: run.reported,
    updatedAt: run.updatedAt,
    ref: run.ref,
  };
}

function archivedFor(run: Run): string | undefined {
  if (run.kind !== "jcode" || !run.ref.sessionName) return undefined;
  const file = path.join(reportsDir(), "terminals", `${run.ref.sessionName}.md`);
  return fs.existsSync(file) ? path.relative(repoRoot(), file).split(path.sep).join("/") : undefined;
}

/**
 * All run cards, newest activity first: stored manager cards where they exist, and
 * free local placeholders for runs the manager has not checked yet. No LLM calls,
 * no writes - safe for GET /company/runs and for the assistant's prompt.
 */
export function listRunCards(now = Date.now()): RunCard[] {
  const runs = discoverRuns(now);
  const stored = new Map(storedCards().map((c) => [c.runId, c]));
  const cards = runs.map((r) => {
    const card = stored.get(r.runId);
    if (!card) return heuristicCard(r);
    // Keep the manager's words, but refresh what only the runner knows right now:
    // the deterministic state (a task that just failed must not read "working"),
    // the current activity stamp and the archive link AUTOCLOSE may have written.
    const archive = archivedFor(r);
    const finalState = runStatePrecedence(r, card);
    // Closed/superseded runs always show the "Closed (...)" headline from discovery,
    // and only waiting_for_ceo cards keep a needsCeo line.
    const closureHeadline = r.closure && finalState === "done" ? r.placeholder.headline : undefined;
    const finalNeedsCeo =
      finalState === "waiting_for_ceo"
        ? (card.needsCeo ?? r.placeholder.needsCeo)
        : finalState === "failed"
          ? r.placeholder.needsCeo
          : undefined;
    const { needsCeo: _, ...cardWithoutNeedsCeo } = card;
    return {
      ...cardWithoutNeedsCeo,
      state: finalState,
      headline: closureHeadline ?? card.headline,
      ...(finalNeedsCeo !== undefined ? { needsCeo: finalNeedsCeo } : {}),
      updatedAt: r.updatedAt,
      reported: card.reported || r.reported,
      ...(archive ? { archive } : {}),
      ...(r.fleetVerdict && !card.verdict ? { verdict: r.fleetVerdict, verdictReason: r.fleetVerdictReason, verifiedAt: card.verifiedAt ?? r.updatedAt } : {}),
      // RETRY LOOP: these two are read from the order on disk, so the newest truth wins.
      ...(r.fleetFailureCause ? { fleetFailureCause: r.fleetFailureCause } : {}),
      ...(r.fleetRetryExhausted !== undefined ? { fleetRetryExhausted: r.fleetRetryExhausted } : {}),
    };
  });
  // Old cards for runs no longer discovered (aged out) are still history: keep the
  // newest few so the briefing never silently forgets a finished run.
  for (const card of stored.values()) {
    if (cards.some((c) => c.runId === card.runId)) continue;
    if (card.state === "done" || card.state === "failed") cards.push(card);
  }
  return cards
    .sort((a, b) => (b.updatedAt ?? b.checkedAt).localeCompare(a.updatedAt ?? a.checkedAt))
    .slice(0, runManagerKnobs().maxRuns + 20);
}

/**
 * The deterministic signal wins only when the run already reached a terminal state
 * on disk (merged/failed) - a manager card must never hide that. Otherwise the
 * manager's read of the run is kept.
 */
function runStatePrecedence(run: Run, card: RunCard): RunState {
  // A finished/in-motion company task or fleet order on disk outranks a manager
  // card, which may be minutes old.
  if (run.kind !== "jcode") {
    if (run.state === "done" || run.state === "failed") return run.state;
    // Rule change (docs/NEEDS_YOU_RULE_SPEC.md §2): pending gates are never
    // waiting_for_ceo. If a stale manager card still says so, trust the run.
    if (card.state === "waiting_for_ceo" && run.state !== "waiting_for_ceo") return run.state;
  }
  // For a session, the manager's read wins - EXCEPT that a session that is
  // streaming right now is working again, whatever an older card said. (A session
  // that writes an early log entry must not be frozen as "done".)
  if (run.kind === "jcode" && run.state === "working" && card.state === "done") return "working";
  return card.state;
}

export function getRunCard(runId: string, now = Date.now()): { card: RunCard; history: RunCard[] } | undefined {
  const runs = discoverRuns(now);
  const run = runs.find((r) => r.runId === runId);
  const stored = readStoredCard(runId);
  const card = run ? (stored ? { ...stored, state: runStatePrecedence(run, stored), updatedAt: run.updatedAt } : heuristicCard(run)) : stored;
  if (!card) return undefined;
  return { card, history: cardHistory(runId) };
}

function cardHistory(runId: string, limit = 50): RunCard[] {
  try {
    const file = runsLogFile();
    if (!fs.existsSync(file)) return [];
    const lines = readTail(file, 4 * 1024 * 1024).split(/\r?\n/).filter((l) => l.trim());
    const out: RunCard[] = [];
    for (const line of lines) {
      try {
        const c = JSON.parse(line) as RunCard;
        if (c?.runId === runId) out.push(c);
      } catch {
        // skip a partial first line
      }
    }
    return out.slice(-limit);
  } catch {
    return [];
  }
}

export function runCounts(cards = listRunCards()): { running: number; done: number; failed: number; stuck: number; waiting: number; total: number } {
  const of = (s: RunState) => cards.filter((c) => c.state === s).length;
  return { running: of("working"), done: of("done"), failed: of("failed"), stuck: of("stuck"), waiting: of("waiting_for_ceo"), total: cards.length };
}

// ── model choice (Laya + guard rails) ───────────────────────────────────────

async function layaUp(): Promise<boolean> {
  if (config.decisionBackend !== "laya") return false;
  try {
    const base = config.decisionBaseUrl.replace(/\/+$/, "");
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(runManagerKnobs().layaTimeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

async function chooseRunModel(run: Run, redoTwice: boolean): Promise<{ model: string; modelReason: string }> {
  const opus = config.claudeOpus;
  const sonnet = config.claudeSonnet;
  // CHEAP BY DEFAULT (docs/CHEAP_BY_DEFAULT_SPEC.md Job 2): the value returned here is the
  // CEILING handed to the brainRouter gate (`purpose: "review"` below), never "the model that
  // will run". The gate picks the tier: a small run is reviewed on deepseek-v4.1-flash with no
  // Claude call at all, and Claude comes back only when Laya calls the run big, when the CEO
  // named it, or on the 2nd-REDO hard rule. The reasons say so, so the card cannot be read as
  // "Opus reviewed this".
  const forceOpus = run.state === "failed" || run.state === "stuck" || redoTwice;
  if (forceOpus) {
    const why = run.state === "failed" ? "the run failed" : run.state === "stuck" ? "the run looks stuck" : "REDO happened twice";
    return { model: opus, modelReason: `Opus ceiling: ${why} (the gate decides)` };
  }
  if (config.decisionBackend === "laya" && !(await layaUp())) {
    return { model: sonnet, modelReason: "Sonnet ceiling: Laya offline (the gate decides)" };
  }
  try {
    const { layaMinConf } = runManagerKnobs();
    const brain = await classifyBrain(clip(run.order || run.title, 1500), run.owner);
    const pick = brain.brain === "OPUS" ? opus : sonnet;
    if (brain.confidence >= layaMinConf) return { model: pick, modelReason: `${brain.reason} (>= ${layaMinConf}) [ceiling; the gate decides]` };
    return { model: sonnet, modelReason: `${brain.reason} < ${layaMinConf} guard rail -> Sonnet ceiling` };
  } catch (e) {
    return { model: sonnet, modelReason: `decision backend error (${clip(e instanceof Error ? e.message : String(e), 60)}) -> Sonnet ceiling` };
  }
}

/**
 * The deterministic half of a review (CHEAP BY DEFAULT, docs/CHEAP_BY_DEFAULT_SPEC.md Job 2).
 * `discoverRuns` already checks every path a run claimed and writes `-> exists` / `-> MISSING`
 * into the evidence without spending a model call, so a review that ran on the cheap tier must
 * never be allowed to PASS a run whose OWN evidence says a claimed file is missing. This is the
 * "automated check" the spec names for small tasks, used as a floor under the model's verdict.
 */
function missingClaims(evidence: string): string[] {
  const out: string[] = [];
  for (const m of String(evidence ?? "").matchAll(/^(.{1,200}?) -> MISSING\s*$/gm)) {
    const what = (m[1] ?? "").trim();
    if (what) out.push(what);
  }
  return [...new Set(out)].slice(0, 5);
}

// ── the manager check (Claude) ──────────────────────────────────────────────

const MANAGER_SYSTEM = `You are the run manager of a small AI software company. You watch ONE run (a work order being executed) and write a short status card for the CEO, who is NOT an engineer.

Write plain words only:
- No file paths, no code identifiers, no jargon. Say "the dashboard rebuild", never "public/v2/views/flow.js".
- A person or team name for who is doing it.
- Past tense for finished work ("Built the flow page").
- Max ~15 words per item, max 6 items in "done", max 6 in "remaining".
- "headline" is ONE sentence the CEO understands.
- "needsCeo" only when the CEO must decide or do something, otherwise omit it.
- Never invent status. If the evidence does not say, say so in "remaining" (e.g. "No report yet, so its state is unclear").

State (exactly one):
- "working": it is still making progress.
- "stuck": it stopped making progress, went quiet, or is looping (evidence shows no activity for a long time).
- "done": the work is complete and it reported.
- "failed": it failed / was rejected / the work was abandoned.
- "waiting_for_ceo": it cannot continue without a CEO decision or approval.

Verdict (docs/AUTOCLOSE_SPEC.md) - only when the run has reported (its report, its coordination-log entry, or a merged task):
- Verify EVIDENCE, do not summarise. Use the file-existence checks in the evidence, and the claimed commands/output.
- "PASS": the report matches the work order and the evidence supports its claims.
- "REDO": the run claimed something the evidence does not support, or the work is incomplete, or you cannot verify it.
- "FAIL": the run is broken/failed and should not be re-run as-is.
- "verdictReason": one sentence, and say what you actually checked ("checked the two files it created - both exist").
- If it has NOT reported, set verdict to null and explain in "remaining".

Answer with ONLY this JSON, no prose and no code fences:
{"state":"working|stuck|done|failed|waiting_for_ceo","headline":"...","done":["..."],"remaining":["..."],"needsCeo":"...","owner":"...","verdict":"PASS|REDO|FAIL|null","verdictReason":"..."}`;

type ManagerAnswer = {
  state?: unknown;
  headline?: unknown;
  done?: unknown;
  remaining?: unknown;
  needsCeo?: unknown;
  owner?: unknown;
  verdict?: unknown;
  verdictReason?: unknown;
};

const STATES: RunState[] = ["working", "stuck", "done", "failed", "waiting_for_ceo"];

function stringList(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((s) => clip(s, 160)).slice(0, max);
}

function parseManagerAnswer(text: string): ManagerAnswer | undefined {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as ManagerAnswer;
  } catch {
    return undefined;
  }
}

/**
 * Should this run's review escalate to the top tier? (docs/CHEAP_BY_DEFAULT_SPEC.md: "a 2nd REDO
 * on a review may take the top tier".)
 *
 * CHEAP BY DEFAULT (measured leak, 2026-09-30): this used to be "two REDOs anywhere in the
 * run's card history", and the gate's hard rule BYPASSES the measured Laya bars - so every run
 * that had ever collected two REDOs sent `hardRule: "redo2"` on EVERY later re-check.
 * Measured on the live log: 15 Opus review calls in 15 minutes at 30-60 s intervals, all
 * `hardRule=redo2`, on a host where Opus is supposed to be ~30% of BIG work only. A 2nd REDO is
 * an ESCALATION, not a permanent state (the cheap-model safety net climbs the same way, once),
 * so this fires only on the transition into a second CONSECUTIVE REDO.
 * Exported so a proof can call the real predicate (ops/cheap-default-check.ts, section D).
 */
export function redoEscalation(history: Array<{ verdict?: "PASS" | "REDO" | "FAIL" }>): boolean {
  const v = history.map((c) => c.verdict);
  return v.length >= 2 && v[v.length - 1] === "REDO" && v[v.length - 2] === "REDO" && v[v.length - 3] !== "REDO";
}

async function managerCard(run: Run, previous: RunCard | undefined, history: RunCard[]): Promise<RunCard> {
  const redoTwice = redoEscalation(history);
  const { model, modelReason } = await chooseRunModel(run, redoTwice);
  const checkedAt = nowIso();
  const user = `${run.evidence}\n\n---\nWrite the card for this run. Kind: ${run.kind}. Deterministic status from the files on disk: ${run.state}. It has reported: ${run.reported ? "yes" : "no"}.`;
  try {
    const out = await callClaudeSubscription({
      model,
      system: MANAGER_SYSTEM,
      user: clip(user, 12000),
      cwd: repoRoot(),
      // BRAIN ROUTING: a verdict is a "review"; two REDOs on the same run are the one
      // hard rule that may take the top tier (it is where a weak reviewer costs most).
      purpose: "review",
      hardRule: redoTwice ? "redo2" : undefined,
      // CHEAP BY DEFAULT: a run is re-checked repeatedly and the prompt carries the CHANGING
      // evidence, so the safety net needs the run's stable identity as its key - with the default
      // hash key the count would reset on every check and the climb could never fire.
      failureKey: `review:${run.runId}`,
      // The company folder plus the run's own working root, so the manager can READ
      // the deliverable it is verifying instead of trusting the report (the spec's
      // "check evidence, not just summarise").
      addDirs: [getCompanyRoot(), ...(run.addDirs ?? [])].filter((d, i, all) => !!d && all.indexOf(d) === i),
    });
    const parsed = parseManagerAnswer(out.text);
    if (!parsed) throw new Error(`manager answer was not JSON: ${clip(out.text, 160)}`);
    // CHEAP BY DEFAULT: say which model and tier actually ran, and let the deterministic
    // check veto a PASS (see missingClaims above). `out.brain` is present because this call
    // names a purpose, so the card never has to guess.
    const gate = out.brain;
    const cheap = gate?.tier === "none";
    const modelReasonOut = gate
      ? `${modelReason} | gate: ${gate.tier} ${gate.model} (${gate.reason})${cheap ? " - cheap review, no Claude call" : ""}`
      : modelReason;
    const state = STATES.includes(parsed.state as RunState) ? (parsed.state as RunState) : run.state;
    const done = stringList(parsed.done, 6);
    const remaining = stringList(parsed.remaining, 6);
    const headline = typeof parsed.headline === "string" && parsed.headline.trim() ? clip(parsed.headline, 240) : run.placeholder.headline;
    const verdictRaw = typeof parsed.verdict === "string" ? parsed.verdict.toUpperCase() : "";
    // A verdict is only ever given for a run that reported (docs/AUTOCLOSE_SPEC.md).
    const hasReport = run.reported || state === "done";
    let verdict: RunVerdict | undefined = !hasReport
      ? undefined
      : verdictRaw === "PASS" || verdictRaw === "REDO" || verdictRaw === "FAIL"
        ? (verdictRaw as RunVerdict)
        : undefined;
    let verdictReason = typeof parsed.verdictReason === "string" && parsed.verdictReason.trim() ? clip(parsed.verdictReason, 300) : "checked by the run manager";
    // The automated check has veto power over PASS only: a REDO/FAIL the model chose stands.
    const missing = missingClaims(run.evidence);
    if (verdict === "PASS" && missing.length) {
      verdict = "REDO";
      verdictReason = `automated check${cheap ? " (no Claude)" : ""}: the run's own evidence says ${missing.join(", ")} is MISSING, so a PASS is not allowed.`;
    }
    const owner = typeof parsed.owner === "string" && parsed.owner.trim() ? clip(parsed.owner, 80) : run.owner;
    return {
      runId: run.runId,
      kind: run.kind,
      title: run.title,
      owner,
      state,
      headline,
      done: done.length ? done : run.placeholder.done.slice(0, 6),
      remaining: state === "done" && !remaining.length ? [] : remaining.length ? remaining : run.placeholder.remaining.slice(0, 6),
      ...(typeof parsed.needsCeo === "string" && parsed.needsCeo.trim()
        ? { needsCeo: clip(parsed.needsCeo, 200) }
        : run.placeholder.needsCeo
          ? { needsCeo: run.placeholder.needsCeo }
          : {}),
      model: out.model || model,
      modelReason: modelReasonOut,
      checkedAt,
      evidenceHash: run.evidenceHash,
      ...(run.ref.sessionId ? { sessionId: run.ref.sessionId } : {}),
      ...(verdict
        ? {
            verdict,
            verdictReason,
            verifiedAt: checkedAt,
          }
        : run.fleetVerdict
          ? { verdict: run.fleetVerdict, verdictReason: run.fleetVerdictReason, verifiedAt: checkedAt }
          : {}),
      // RETRY LOOP: deterministic facts about a failed fleet order, so a manager re-check
      // cannot lose them (and cannot silently re-offer a retry that is used up).
      ...(run.fleetFailureCause ? { fleetFailureCause: run.fleetFailureCause } : {}),
      ...(run.fleetRetryExhausted !== undefined ? { fleetRetryExhausted: run.fleetRetryExhausted } : {}),
      reported: hasReport,
      updatedAt: run.updatedAt,
      ref: run.ref,
      ...(previous?.archive ? { archive: previous.archive } : {}),
    };
  } catch (e) {
    // The manager could not answer: keep the free local card, say why, and do not
    // pretend it was verified (no verdict). The hash is marked "pending" so this run
    // is retried on a later pass instead of being treated as checked - but only up to
    // RUN_CHECK_MAX_ATTEMPTS times for the SAME evidence (RETRY LOOP, 2026-09-30: without
    // that cap a run whose check kept failing was re-checked on every pass forever and
    // appended an identical row to runs.jsonl each time - measured 90 rows for one order
    // in 5.5 h, all "the fleet review flagged a work order").
    const sameEvidence = settledHash(previous?.evidenceHash) === run.evidenceHash;
    return {
      ...heuristicCard(run),
      checkedAt,
      checkAttempts: (sameEvidence ? (previous?.checkAttempts ?? 0) : 0) + 1,
      model: model,
      modelReason: `${modelReason}; the manager check failed: ${clip(e instanceof Error ? e.message : String(e), 120)}`,
      ...(previous?.archive ? { archive: previous.archive } : {}),
    };
  }
}

// ── the check pass ──────────────────────────────────────────────────────────

let checking = false;

/**
 * RETRY LOOP (2026-09-30): should this run be manager-checked on this pass?
 *
 * Extracted from the check pass so a proof can call the REAL rule with synthetic cards
 * (ops/needs-you-retry-loop-test.ts) instead of re-implementing it.
 *
 * The rule that matters: a card written after a FAILED manager check carries
 * `pending:<hash>` (heuristicCard) and `checkAttempts`. Comparing the raw string never
 * matched the run's own hash, so such a run was re-checked on every pass for as long as the
 * check kept failing, and the pass appended an identical row to runs.jsonl each time.
 * MEASURED on the live company: fleet order fomumoiq1j had 90 identical FAIL rows
 * ("the fleet review flagged a work order") at ~210 s spacing over 5.5 h; 125 of the log's
 * 194 verdict rows were that one sentence. Now: the settled hash is compared, and a failed
 * check is retried at most RUN_CHECK_MAX_ATTEMPTS (default 2) times for the SAME evidence.
 */
export function recheckDecision(input: {
  stored: RunCard;
  run: Pick<Run, "evidenceHash" | "state">;
  force?: boolean;
  maxCheckAttempts?: number;
  minutesSinceChecked?: number;
  minIntervalS?: number;
}): { check: boolean; reason: string } {
  const maxAttempts = input.maxCheckAttempts ?? envNum("RUN_CHECK_MAX_ATTEMPTS", 2, 1);
  const pending = /^pending:/.test(String(input.stored.evidenceHash ?? ""));
  const attempts = input.stored.checkAttempts ?? 0;
  const final = input.stored.state === "done" || input.stored.state === "failed";
  if (!input.force && settledHash(input.stored.evidenceHash) === input.run.evidenceHash) {
    // The evidence has not moved since this card was written. A card the manager really wrote
    // needs no second look; a card written after a FAILED check is retried, but only up to the
    // cap - that cap is what stops the endless re-check/re-log loop.
    const retryable = pending && attempts < maxAttempts;
    if (!retryable) {
      if (pending) return { check: false, reason: `check-failed-cap(${attempts}/${maxAttempts})` };
      return { check: false, reason: final ? "final-unchanged" : "unchanged" };
    }
  }
  if (
    !input.force &&
    input.minutesSinceChecked !== undefined &&
    input.minIntervalS !== undefined &&
    input.minutesSinceChecked < input.minIntervalS / 60
  ) {
    return { check: false, reason: "min-interval" };
  }
  if (input.stored.state === "done" && input.run.state === "done") return { check: false, reason: "done-stays-done" };
  return { check: true, reason: pending ? "retry-failed-check" : "check" };
}

export type CheckOptions = {
  /** ignore the per-run min interval and the "evidence unchanged" shortcut */
  force?: boolean;
  /** hard cap on manager (Claude) calls this pass */
  maxChecks?: number;
  now?: number;
};

/**
 * One manager pass: discover runs, re-check the ones whose evidence changed, and
 * persist the cards. Serialised (one pass at a time) and fully guarded.
 */
export async function checkRuns(opts: CheckOptions = {}): Promise<CheckSummary> {
  const started = Date.now();
  const now = opts.now ?? Date.now();
  const knobs = runManagerKnobs();
  const summary: CheckSummary = {
    discovered: 0, inFlight: 0, checked: 0, changed: 0, skipped: 0, onPlaceholder: 0,
    claudeCalls: 0, models: [], errors: [], ms: 0,
  };
  if (checking) {
    summary.errors.push("another manager pass is already running");
    return summary;
  }
  checking = true;
  try {
    const runs = discoverRuns(now, { fresh: true });
    summary.discovered = runs.length;
    summary.inFlight = runs.filter((r) => r.state === "working" || r.state === "stuck" || r.state === "waiting_for_ceo").length;

    const useClaude = knobs.backend !== "heuristic" && !config.mockMode;
    // RETRY LOOP: how many times one run's FAILED manager check may be retried for the same
    // evidence before it is left alone (new evidence always gets a fresh look).
    const maxCheckAttempts = envNum("RUN_CHECK_MAX_ATTEMPTS", 2, 1);
    const candidates: Run[] = [];
    for (const run of runs) {
      const stored = readStoredCard(run.runId);
      if (!stored) {
        candidates.push(run);
        continue;
      }
      const decision = recheckDecision({
        stored,
        run,
        force: opts.force,
        maxCheckAttempts,
        minutesSinceChecked: minutesSince(stored.checkedAt, now),
        minIntervalS: knobs.minIntervalS,
      });
      if (!decision.check) {
        summary.skipped++;
        continue;
      }
      candidates.push(run);
    }

    const maxChecks = Math.min(opts.maxChecks ?? knobs.maxChecksPerTick, knobs.maxChecksPerTick);
    const queue = candidates.slice(0, useClaude ? maxChecks : 0);
    summary.onPlaceholder = runs.length - queue.length;
    const queueIds = new Set(queue.map((r) => r.runId));

    // Runs we are not checking this pass still need a card on disk the moment they
    // are new, so the history shows when they first appeared. Cheap: no LLM.
    for (const run of runs) {
      if (queueIds.has(run.runId)) continue;
      if (readStoredCard(run.runId)) continue;
      if (run.state === "done" || run.state === "failed") continue; // wait for a real check
      writeCard(heuristicCard(run));
    }

    const results = new Map<string, RunCard>();
    let index = 0;
    const workers = Array.from({ length: Math.min(knobs.concurrency, Math.max(1, queue.length)) }, async () => {
      for (;;) {
        const i = index++;
        if (i >= queue.length) return;
        const run = queue[i];
        try {
          const card = await managerCard(run, readStoredCard(run.runId), cardHistory(run.runId));
          results.set(run.runId, card);
          if (card.model !== "local") summary.claudeCalls++;
          if (!summary.models.includes(card.model)) summary.models.push(card.model);
        } catch (e) {
          summary.errors.push(`${run.runId}: ${clip(e instanceof Error ? e.message : String(e), 160)}`);
        }
      }
    });
    await Promise.all(workers);

    for (const run of queue) {
      const card = results.get(run.runId);
      if (!card) continue;
      const previous = readStoredCard(run.runId);
      writeCard(card);
      summary.checked++;
      if (!previous || previous.evidenceHash !== card.evidenceHash || previous.state !== card.state || previous.headline !== card.headline || previous.verdict !== card.verdict) {
        summary.changed++;
      }
    }
    summary.ms = Date.now() - started;
    return summary;
  } catch (e) {
    summary.errors.push(clip(e instanceof Error ? e.message : String(e), 200));
    summary.ms = Date.now() - started;
    return summary;
  } finally {
    checking = false;
  }
}

/** Status for logs/ops: knobs + how many cards are on disk. Never throws. */
export function runManagerStatus(): {
  knobs: ReturnType<typeof runManagerKnobs>;
  storedCards: number;
  discovering: boolean;
  backend: string;
} {
  const knobs = runManagerKnobs();
  return {
    knobs,
    storedCards: storedCards().length,
    discovering: checking,
    backend: config.mockMode ? "heuristic (MOCK_MODE=1)" : knobs.backend,
  };
}
