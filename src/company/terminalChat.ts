/**
 * Terminal chat (docs/TERMINALS_SPEC.md) — the backend for the CEO's Terminals page.
 *
 * What it does, in one paragraph: it discovers every jcode session that is alive or
 * was alive in the last two hours, works out what each one is FOR (its role) and what
 * it is DOING right now (a plain-words description), shows the last few human-readable
 * lines of its journal, and delivers a message from the CEO into exactly one session
 * with `jcode transcript --mode send -S <sessionId>`.
 *
 * HARD RULES (from the spec):
 *   1. `%USERPROFILE%\.jcode\` is READ-ONLY. Nothing here is ever written there.
 *   2. Delivery is TARGETED only (`-S <sessionId>`). There is deliberately NO fallback
 *      to the focus-based send: it can land in the wrong terminal.
 *   3. Nothing secret is ever returned. Every string that leaves this module goes
 *      through redact() + clip().
 *   4. Never throw at the caller for data reasons: a missing journal, a corrupt file or
 *      an unreachable session degrades to an empty/closed entry, not a 500.
 *
 * KNOWN FACTS about this install (found by AUTOCLOSE / FLEET-BACKEND, re-verified here):
 *   - `active_pids/<sessionId>` and `streaming_pids/<sessionId>` hold the SHARED jcode
 *     SERVER pid (the same number for every session), so their CONTENT is useless for
 *     liveness. What they are good for is (a) "is streaming right now" and (b) the set of
 *     session ids the client recently touched.
 *   - The real `sessionId -> client pid` map is `client_sessions/<pid>` (file content is
 *     the session id). Those files are never cleaned up, so a pid must be checked for
 *     liveness (pidAlive) before it counts.
 *   - `sessions/<id>.json` is the session state (full messages) and `sessions/<id>.journal.jsonl`
 *     is the append log. Both are large; everything here reads bounded heads/tails and
 *     caches the one expensive thing (the work order, which never changes).
 *
 * Owned by the jcode session TERMINALS. Routes live in src/server.ts:
 *   GET  /company/terminals/live
 *   GET  /company/terminals/:sessionId/tail?lines=60
 *   POST /company/terminals/:sessionId/message {text}
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { getCompanyRoot } from "./org.js";
import { airgappedBlock } from "./airGap.js";

// ── knobs ────────────────────────────────────────────────────────────────────

/** A closed session stays on the page this long after its last activity, then disappears. */
const CLOSED_KEEP_MS = envNum("TERMINALS_CLOSED_KEEP_MIN", 120) * 60_000;
/** Discovery cache, so a 3s UI poll does not re-stat the whole .jcode tree. */
const SCAN_TTL_MS = envNum("TERMINALS_SCAN_TTL_MS", 1500);
/** RunCard cache (REPORTING recomputes cards from every project + fleet order). */
const CARD_TTL_MS = envNum("TERMINALS_CARD_TTL_MS", 15_000);
/** How long we wait for `jcode transcript --mode send` to exit. */
const SEND_TIMEOUT_MS = envNum("TERMINALS_SEND_TIMEOUT_MS", 20_000);
/** How long we then wait for the text to show up in that session's journal/state (spec: 20s). */
const VERIFY_TIMEOUT_MS = envNum("TERMINALS_VERIFY_TIMEOUT_MS", 20_000);

const HEAD_BYTES = 2 * 1024 * 1024; // bounded head read (meta + first user message)
const TAIL_BYTES = 640 * 1024; // bounded tail read (the live tail + delivery check)
const WORK_ORDER_MAX = 1200; // chars kept of the work order
const ORDER_EXCERPT_MAX = 400; // chars of "work order excerpt" in the list payload
const LINE_MAX = 320; // chars per tail line
const DESC_WORDS = 20; // the description sentence is cut to this many words

/** The exact prefix every message sent from the dashboard carries. */
export const CEO_PREFIX = "[From the CEO via the dashboard] ";

function envNum(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

// ── types ────────────────────────────────────────────────────────────────────

export type TerminalLiveState = "working" | "idle" | "closed";

export type RunCardLite = {
  headline: string;
  done: string[];
  remaining: string[];
  doneCount: number;
  remainingCount: number;
  verdict?: string;
  state?: string;
  updatedAt?: string;
};

export type LiveTerminal = {
  sessionId: string;
  /** short_name, e.g. "tigress" */
  name: string;
  /** e.g. "OPS (router uptime)", "UI-SHELL", "CEO's own jcode window" */
  role: string;
  /** one plain-words sentence of what this terminal is doing */
  description: string;
  state: TerminalLiveState;
  model: string;
  provider?: string;
  /** ISO of the newest activity we can see (journal mtime / meta last_active_at) */
  lastActivity?: string;
  startedAt?: string;
  workOrderExcerpt: string;
  runCard?: RunCardLite;
  keepOpen?: boolean;
  /** additive: sessions are working=streaming, idle=client alive but quiet */
  streaming: boolean;
  liveClientPids: number[];
  idleSeconds?: number;
  /** additive: where the description came from ("runcard" | "work order") */
  descriptionSource: string;
};

export type TailLine = {
  ts: string;
  who: "ceo" | "manager" | "agent" | "tool";
  text: string;
};

export type TailResult = {
  sessionId: string;
  name: string;
  state: TerminalLiveState;
  workOrderExcerpt?: string;
  lines: TailLine[];
  generatedAt: string;
};

export type SendResult = {
  ok: boolean;
  how: "targeted";
  detail: string;
  status: number;
  sessionId: string;
  name?: string;
  /** the text actually delivered (prefix included), already redacted for logging */
  sent?: string;
  /** true when the text was seen as a NEW user message in that session's own journal */
  verified?: boolean;
  verifiedAt?: string;
};

// ── tiny fs helpers ──────────────────────────────────────────────────────────

function jcodeHome(): string {
  return process.env.JCODE_HOME_DIR || path.join(os.homedir(), ".jcode");
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readFileBounded(file: string, maxBytes: number, fromEnd = false): string {
  try {
    const size = fs.statSync(file).size;
    if (size <= maxBytes) return fs.readFileSync(file, "utf8");
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      const start = fromEnd ? size - maxBytes : 0;
      const n = fs.readSync(fd, buf, 0, maxBytes, start);
      return buf.toString("utf8", 0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function mtimeMs(file: string): number | undefined {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

function birthMs(file: string): number | undefined {
  try {
    const st = fs.statSync(file);
    const b = st.birthtimeMs;
    return Number.isFinite(b) && b > 0 ? b : st.mtimeMs;
  } catch {
    return undefined;
  }
}

/** The session id must be a plain id: it is joined into paths, so this is a safety gate. */
export function isSessionId(id: unknown): id is string {
  return typeof id === "string" && /^session_[A-Za-z0-9_-]{4,}$/.test(id);
}

// ── redaction / clipping ─────────────────────────────────────────────────────

const SECRET_RULES: Array<[RegExp, string]> = [
  [/[A-Za-z0-9]{0,12}[_-](?:sk|pk|rk)[_-][A-Za-z0-9_-]{10,}/g, "[redacted-key]"],
  [/\b(?:sk|pk|rk|api)[-_][A-Za-z0-9_-]{12,}/g, "[redacted-key]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{8,}/g, "[redacted-slack-token]"],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "[redacted-github-token]"],
  [/\bAKIA[0-9A-Z]{12,}/g, "[redacted-aws-key]"],
  [/\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted-jwt]"],
  [
    /((?:token|secret|password|passwd|api[_-]?key|auth[_-]?token|app[_-]?token)\s*[:=]\s*)["']?([A-Za-z0-9_\-.]{10,})["']?/gi,
    "$1[redacted]",
  ],
  [/\b[A-Za-z0-9+/]{60,}={0,2}\b/g, "[redacted-blob]"],
];

/** Never let a key, token or password reach the dashboard. */
export function redact(text: string): string {
  let out = String(text ?? "");
  for (const [re, replacement] of SECRET_RULES) out = out.replace(re, replacement);
  return out;
}

function clip(text: string, max: number): string {
  const t = String(text ?? "");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function oneLine(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

// ── sessions on disk (read-only) ─────────────────────────────────────────────

function sessionsDir(): string {
  return path.join(jcodeHome(), "sessions");
}

function journalFile(sessionId: string): string {
  return path.join(sessionsDir(), `${sessionId}.journal.jsonl`);
}

function stateFile(sessionId: string): string {
  return path.join(sessionsDir(), `${sessionId}.json`);
}

type JournalMeta = {
  short_name?: string;
  title?: string;
  model?: string;
  provider_key?: string;
  status?: string;
  updated_at?: string;
  last_active_at?: string;
  working_dir?: string;
};

type JournalRec = {
  meta?: JournalMeta;
  append_messages?: Array<{
    role?: string;
    timestamp?: string;
    content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }>;
  }>;
};

function parseJsonLines(text: string): JournalRec[] {
  const out: JournalRec[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line[0] !== "{") continue;
    try {
      out.push(JSON.parse(line) as JournalRec);
    } catch {
      // A truncated bound (head/tail read) can cut a line in half: skip it, never throw.
    }
  }
  return out;
}

/** The first line of the journal is the session meta record. */
function readJournalMeta(sessionId: string): JournalMeta | undefined {
  const head = readFileBounded(journalFile(sessionId), 64 * 1024);
  const nl = head.indexOf("\n");
  const first = nl >= 0 ? head.slice(0, nl) : head;
  try {
    const rec = JSON.parse(first) as JournalRec;
    return rec.meta;
  } catch {
    // Fall back to a regex pull of the few fields we need (very large titles).
    const m = /"short_name"\s*:\s*"([^"]*)"/.exec(head);
    const t = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head);
    if (!m && !t) return undefined;
    const dec = (s: string): string => {
      try {
        return JSON.parse(`"${s}"`) as string;
      } catch {
        return s;
      }
    };
    return {
      short_name: m ? dec(m[1]) : undefined,
      title: t ? dec(t[1]) : undefined,
      model: /"model"\s*:\s*"([^"]*)"/.exec(head)?.[1],
      provider_key: /"provider_key"\s*:\s*"([^"]*)"/.exec(head)?.[1],
      status: /"status"\s*:\s*"([^"]*)"/.exec(head)?.[1],
      last_active_at: /"last_active_at"\s*:\s*"([^"]*)"/.exec(head)?.[1],
    };
  }
}

/**
 * The work order: the first REAL user message in `sessions/<id>.json`.
 * System reminders are marked `display_role: "system"` (or start with `<system-reminder>`),
 * and that field comes AFTER the text, so candidates are filtered on their text.
 * Cached for the life of the process (the work order never changes) — this is the only
 * expensive read in the module, so it must happen at most once per session.
 */
const workOrderCache = new Map<string, string>();

function readWorkOrder(sessionId: string): string {
  const cached = workOrderCache.get(sessionId);
  if (cached !== undefined) return cached;
  const head = readFileBounded(stateFile(sessionId), HEAD_BYTES);
  let found = "";
  // {"id":"...","role":"user","content":[{"type":"text","text":"..."}],...
  const re = /"role"\s*:\s*"user"[\s\S]{0,200}?"content"\s*:\s*\[\s*\{\s*"type"\s*:\s*"text"\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(head)) !== null) {
    let text = "";
    try {
      text = JSON.parse(`"${m[1]}"`) as string;
    } catch {
      text = m[1];
    }
    const t = text.trim();
    if (!t) continue;
    if (/^<system-reminder>/i.test(t) || /^\s*<system-reminder>/i.test(t)) continue;
    found = t;
    break;
  }
  // Older/odd sessions keep the order only in the journal meta title.
  if (!found) found = readJournalMeta(sessionId)?.title ?? "";
  const cleaned = clip(cleanOrder(redact(found)).replace(/\s+/g, " ").trim(), WORK_ORDER_MAX);
  if (cleaned) {
    if (workOrderCache.size > 300) workOrderCache.clear();
    workOrderCache.set(sessionId, cleaned);
  }
  return cleaned;
}

/**
 * jcode stores the CEO's/manager's prompt wrapped in a `[transcription]` marker, and its
 * title is a tail-truncation of the same text, so a message can begin with a few junk
 * characters followed by the marker (e.g. ` wit[transcription] You are ...`). Strip it.
 */
function cleanOrder(text: string): string {
  return String(text ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/^\s*[^\s\[]{0,8}\[transcription\]\s*/i, "")
    .replace(/^\uFEFF/, "");
}

/** sessionId -> live client pids, from client_sessions/<pid> (content = session id). */
function liveClientPidsBySession(): Map<string, number[]> {
  const out = new Map<string, number[]>();
  let names: string[] = [];
  try {
    names = fs.readdirSync(path.join(jcodeHome(), "client_sessions"));
  } catch {
    return out;
  }
  for (const name of names) {
    const pid = Number(name);
    if (!Number.isFinite(pid) || !pidAlive(pid)) continue;
    let content = "";
    try {
      content = fs.readFileSync(path.join(jcodeHome(), "client_sessions", name), "utf8").trim();
    } catch {
      continue;
    }
    if (!isSessionId(content)) continue;
    const list = out.get(content);
    if (list) list.push(pid);
    else out.set(content, [pid]);
  }
  return out;
}

function dirSessionIds(dirName: string): Set<string> {
  const out = new Set<string>();
  try {
    for (const name of fs.readdirSync(path.join(jcodeHome(), dirName))) {
      if (isSessionId(name)) out.add(name);
    }
  } catch {
    // directory absent: no such sessions
  }
  return out;
}

export type SessionScan = {
  sessionId: string;
  name: string;
  title: string;
  model: string;
  provider: string;
  state: TerminalLiveState;
  streaming: boolean;
  liveClientPids: number[];
  lastActivityMs: number;
  startedMs: number;
  workOrder: string;
};

const scanCache = new Map<string, { at: number; data: SessionScan[] }>();

/**
 * Every jcode session that has a live client OR was active within CLOSED_KEEP_MS.
 * Bounded and cached: the page polls this, so it must stay cheap.
 */
export function scanSessions(now = Date.now()): SessionScan[] {
  const cacheKey = "all";
  const hit = scanCache.get(cacheKey);
  if (hit && now - hit.at < SCAN_TTL_MS) return hit.data;

  const live = liveClientPidsBySession();
  const active = dirSessionIds("active_pids");
  const streaming = dirSessionIds("streaming_pids");

  const candidates = new Set<string>([...live.keys(), ...active, ...streaming]);
  // Also catch a session whose pid files were already cleaned up but which was active
  // minutes ago (its journal mtime is the evidence).
  let journalNames: string[] = [];
  try {
    journalNames = fs.readdirSync(sessionsDir());
  } catch {
    journalNames = [];
  }
  for (const n of journalNames) {
    if (!n.endsWith(".journal.jsonl")) continue;
    const id = n.slice(0, -".journal.jsonl".length);
    if (isSessionId(id)) candidates.add(id);
  }

  const out: SessionScan[] = [];
  for (const sessionId of candidates) {
    const jm = mtimeMs(journalFile(sessionId));
    const sm = mtimeMs(stateFile(sessionId));
    if (jm === undefined && sm === undefined) continue; // no session files at all
    const livePids = live.get(sessionId) ?? [];
    const lastActivityMs = Math.max(jm ?? 0, sm ?? 0);
    if (livePids.length === 0 && now - lastActivityMs > CLOSED_KEEP_MS) continue;
    const meta = readJournalMeta(sessionId);
    const isStreaming = streaming.has(sessionId) && livePids.length > 0;
    out.push({
      sessionId,
      name: meta?.short_name || shortNameFromId(sessionId),
      title: oneLine(meta?.title ?? ""),
      model: meta?.model ?? "",
      provider: meta?.provider_key ?? "",
      state: livePids.length === 0 ? "closed" : isStreaming ? "working" : "idle",
      streaming: isStreaming,
      liveClientPids: livePids,
      lastActivityMs,
      startedMs: birthMs(journalFile(sessionId)) ?? lastActivityMs,
      workOrder: readWorkOrder(sessionId),
    });
  }

  // working first, then idle, then closed; newest activity first inside each group.
  const rank: Record<TerminalLiveState, number> = { working: 0, idle: 1, closed: 2 };
  out.sort((a, b) => rank[a.state] - rank[b.state] || b.lastActivityMs - a.lastActivityMs);
  scanCache.set(cacheKey, { at: now, data: out });
  return out;
}

function shortNameFromId(sessionId: string): string {
  const m = /^session_([a-z]+)_/.exec(sessionId);
  return m ? m[1] : sessionId;
}

export function findSession(sessionId: string): SessionScan | undefined {
  return scanSessions().find((s) => s.sessionId === sessionId);
}

// ── role + description ───────────────────────────────────────────────────────

/**
 * Roles, in order of trust:
 *   1. the AUTOCLOSE registry (company/terminals.json) — curated when the window was spawned;
 *   2. the coordination log ("UI-SHELL=mizaru", "OPS (tigress)", "session TERMINALS (session_...)");
 *   3. the work order itself ("You are TERMINALS" / "You are UI-FLOW"). If it only says
 *      "You are a jcode worker session", that is not a role, so it is ignored here.
 * rose is the CEO's own window (the spec names it).
 */
function registryRoles(): Map<string, { role: string; keepOpen?: boolean }> {
  const out = new Map<string, { role: string; keepOpen?: boolean }>();
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(getCompanyRoot(), "terminals.json"), "utf8"),
    ) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : ((parsed as { terminals?: unknown })?.terminals ?? []);
    if (!Array.isArray(list)) return out;
    for (const rec of list as Array<{ sessionId?: string; role?: string; keepOpen?: boolean }>) {
      if (!rec || typeof rec.sessionId !== "string") continue;
      out.set(rec.sessionId, {
        role: typeof rec.role === "string" ? rec.role.trim() : "",
        ...(typeof rec.keepOpen === "boolean" ? { keepOpen: rec.keepOpen } : {}),
      });
    }
  } catch {
    // No registry yet (or unreadable): roles come from the log / work order instead.
  }
  return out;
}

/** The role shown on the page, resolved in the documented order of trust. */
function resolveRole(s: SessionScan, registry: Map<string, { role: string; keepOpen?: boolean }>): string {
  if (s.name === "rose") return "CEO's own jcode window";
  return registry.get(s.sessionId)?.role || roleFromLog(s.name, s.sessionId) || roleFromWorkOrder(s.workOrder) || "";
}

let logCache: { file: string; mtime: number; text: string } | undefined;

function coordinationText(): string {
  const file = path.join(process.cwd(), "docs", "AGENT_COORDINATION.md");
  const m = mtimeMs(file) ?? 0;
  if (logCache && logCache.file === file && logCache.mtime === m) return logCache.text;
  const text = readFileBounded(file, 1024 * 1024);
  logCache = { file, mtime: m, text };
  return text;
}

const ROLE_STOP = new Set([
  "CEO", "DONE", "PASS", "REDO", "FAIL", "ACK", "NOTE", "JSON", "HTTP", "API", "TS", "TSX", "MD", "OK",
  "ID", "UI", "UX", "SESSION", "JCODE", "RUN", "RUNS", "NEW", "AND", "NOT", "ALL", "ONE", "TWO", "LOG",
  "LOGS", "DIR", "FILE", "FILES", "TODO", "CLI", "GATE", "GATES", "SLACK", "SPEC", "SPECS", "DOC", "DOCS",
  "TEST", "TESTS", "MOCK", "TEMP", "CPU", "RAM", "PID", "PIDS", "URL", "URLS", "ENV", "SRC", "PUBLIC",
  "IF", "IT", "THE", "THIS", "THAT", "SYSTEM", "SERVER", "ROUTER", "STOP", "ONLY", "ALSO", "TASK", "TASKS",
  "WORK", "ORDER", "STILL", "NOW", "AFTER", "BEFORE", "WHEN", "THEN", "BOTH", "WAIT", "READ", "POST",
  "SEND", "KEEP", "OPEN", "CLOSE", "MOVE", "USE", "ADD", "WITH", "FROM", "INTO", "OVER", "THAN", "THEY",
  "HAVE", "BEEN", "MUST", "WILL", "HERE", "THERE", "SAME", "NEXT", "LAST", "FIRST", "FOUR", "FIVE",
  "SIX", "THREE", "ZERO", "ANY", "YOUR", "YOU",
]);

function roleToken(token: string): boolean {
  const t = token.toUpperCase();
  return /^[A-Z][A-Z0-9-]{2,}$/.test(t) && !ROLE_STOP.has(t) && !/^\d+$/.test(t);
}

function roleFromLog(name: string, sessionId: string): string | undefined {
  if (!name) return undefined;
  const text = coordinationText();
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns: RegExp[] = [
    new RegExp(`([A-Z][A-Z0-9-]{2,})['"]?\\s*=\\s*(?:session\\s+)?${esc}\\b`),
    new RegExp(`([A-Z][A-Z0-9-]{2,})\\s*\\(\\s*${esc}\\b`),
    new RegExp(`session\\s+([A-Z][A-Z0-9-]{2,})\\s*\\(\\s*${esc}`),
    new RegExp(`${esc}\\s*[)=]\\s*([A-Z][A-Z0-9-]{2,})`),
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m && roleToken(m[1])) return m[1].toUpperCase();
  }
  if (text.includes(sessionId)) {
    const m = new RegExp(`([A-Z][A-Z0-9-]{2,})\\s*\\(\\s*${esc}\\b`).exec(text);
    if (m && roleToken(m[1])) return m[1].toUpperCase();
  }
  return undefined;
}

function roleFromWorkOrder(order: string): string | undefined {
  const m = /You are (?:the )?([A-Z][A-Z0-9_-]{2,})\b/.exec(order);
  if (m && roleToken(m[1])) return m[1].toUpperCase();
  const m2 = /\byour role is\s+([A-Za-z0-9_-]{3,})/i.exec(order);
  if (m2 && roleToken(m2[1])) return m2[1].toUpperCase();
  return undefined;
}

const PATH_RE =
  /(?:[A-Za-z]:\\[^\s"'<>|*,;]+|(?:src|public|docs|ops|company|scripts|tests|deps|node_modules)[\\/][^\s"'<>|*,;)]+|[^\s"'<>|*,;)]+\.(?:ts|tsx|js|mjs|cjs|json|jsonl|md|css|html|ps1|bat|py|log|txt|env)\b)/gi;

/** One plain-words sentence, no file paths, ~20 words. */
function describeFromWorkOrder(order: string): string {
  let source = order;
  const lines = order.split(/\r?\n/);
  const idx = lines.findIndex((l) => /YOUR WORK ORDER/i.test(l));
  if (idx >= 0) {
    const body: string[] = [];
    for (const line of lines.slice(idx + 1)) {
      if (/^[A-Z][A-Z0-9 _-]{5,}$/.test(line.trim()) && body.length) break; // next heading
      if (!line.trim()) {
        if (body.length) break;
        continue;
      }
      body.push(line.trim());
    }
    if (body.join(" ").trim()) source = body.join(" ");
  }
  let text = oneLine(cleanOrder(source))
    .replace(PATH_RE, " ")
    .replace(/\b(?:README|repo|test|tests)\b/gi, (w) => w.toLowerCase());
  const words = text.split(" ").filter(Boolean);
  if (words.length > DESC_WORDS) text = `${words.slice(0, DESC_WORDS).join(" ")}…`;
  return clip(text, 200);
}

// ── RunCards (REPORTING) — read-only, with a disk fallback ───────────────────

type RawCard = {
  runId?: string;
  kind?: string;
  title?: string;
  owner?: string;
  headline?: string;
  done?: unknown;
  remaining?: unknown;
  verdict?: string;
  state?: string;
  updatedAt?: string;
  sessionId?: string;
  ref?: { sessionId?: string; sessionName?: string };
};

let cardCache: { at: number; cards: RawCard[] } | undefined;

/**
 * REPORTING owns the cards. `listRunCards()` is preferred (the spec names it); when that
 * module is unavailable or throws (it is being edited by a peer), we read the card files
 * `company/reports/runs/*.json` directly — those are the SAME cards AUTOCLOSE consumes.
 */
async function loadRawCards(): Promise<RawCard[]> {
  const now = Date.now();
  if (cardCache && now - cardCache.at < CARD_TTL_MS) return cardCache.cards;
  let cards: RawCard[] = [];
  try {
    const mod = (await import("./runManagers.js")) as { listRunCards?: (n?: number) => unknown };
    if (typeof mod.listRunCards === "function") {
      const raw = mod.listRunCards(now);
      if (Array.isArray(raw)) cards = raw as RawCard[];
    }
  } catch {
    cards = [];
  }
  if (!cards.length) {
    try {
      const dir = path.join(getCompanyRoot(), "reports", "runs");
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith(".json")) continue;
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as RawCard;
          if (parsed && typeof parsed.runId === "string") cards.push(parsed);
        } catch {
          // one bad card must not hide the others
        }
      }
    } catch {
      cards = [];
    }
  }
  cardCache = { at: now, cards };
  return cards;
}

function cardForSession(cards: RawCard[], session: SessionScan): RunCardLite | undefined {
  const name = session.name.toLowerCase();
  const hit = cards.find((c) => {
    if (!c || typeof c !== "object") return false;
    if (c.sessionId === session.sessionId || c.ref?.sessionId === session.sessionId) return true;
    if (c.runId === session.sessionId) return true;
    // Last resort, same rule AUTOCLOSE uses: the session's short name in the card's owner.
    if (name && c.kind === "jcode" && typeof c.owner === "string") {
      return new RegExp(`\\b${name}\\b`, "i").test(c.owner);
    }
    return false;
  });
  if (!hit) return undefined;
  const done = Array.isArray(hit.done) ? hit.done.map((x) => clip(oneLine(String(x)), 120)) : [];
  const remaining = Array.isArray(hit.remaining)
    ? hit.remaining.map((x) => clip(oneLine(String(x)), 120))
    : [];
  return {
    headline: clip(oneLine(hit.headline ?? hit.title ?? ""), 200),
    done: done.slice(0, 4),
    remaining: remaining.slice(0, 4),
    doneCount: done.length,
    remainingCount: remaining.length,
    ...(hit.verdict ? { verdict: hit.verdict } : {}),
    ...(hit.state ? { state: hit.state } : {}),
    ...(hit.updatedAt ? { updatedAt: hit.updatedAt } : {}),
  };
}

/**
 * REPORTING's headlines read "jcode tigress (OPS) is working on: <order>". The card already
 * shows the state and the terminal's own name, so that prefix is dropped from the sentence
 * we display under the name (the raw headline is still returned in runCard.headline).
 */
function trimCardHeadline(name: string, headline: string): string {
  const h = String(headline ?? "").trim();
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^jcode\\s+${esc}\\s*(?:\\([^)]*\\))?\\s+is\\s+(?:[a-z]+\\s+){0,4}?on:\\s*`, "i");
  const trimmed = h.replace(re, "").trim();
  return trimmed || h;
}

// ── the public list ──────────────────────────────────────────────────────────

export type LiveTerminalsPayload = {
  terminals: LiveTerminal[];
  counts: { total: number; working: number; idle: number; closed: number };
  generatedAt: string;
  note?: string;
};

export async function listLiveTerminals(): Promise<LiveTerminalsPayload> {
  const sessions = scanSessions();
  const registry = registryRoles();
  let cards: RawCard[] = [];
  let note: string | undefined;
  try {
    cards = await loadRawCards();
  } catch {
    note = "RunCards unavailable (reporting module and card files both unreadable)";
  }

  const terminals: LiveTerminal[] = sessions.map((s) => {
    const reg = registry.get(s.sessionId);
    const card = cardForSession(cards, s);
    const role = resolveRole(s, registry);
    const derived = describeFromWorkOrder(s.workOrder);
    const description = card?.headline
      ? trimCardHeadline(s.name, card.headline)
      : derived || "No work order recorded for this session yet.";
    return {
      sessionId: s.sessionId,
      name: s.name,
      role,
      description,
      state: s.state,
      model: s.model,
      ...(s.provider ? { provider: s.provider } : {}),
      lastActivity: s.lastActivityMs ? new Date(s.lastActivityMs).toISOString() : undefined,
      startedAt: s.startedMs ? new Date(s.startedMs).toISOString() : undefined,
      workOrderExcerpt: clip(oneLine(s.workOrder), ORDER_EXCERPT_MAX),
      ...(card ? { runCard: card } : {}),
      ...(reg && typeof reg.keepOpen === "boolean" ? { keepOpen: reg.keepOpen } : {}),
      streaming: s.streaming,
      liveClientPids: s.liveClientPids,
      idleSeconds: s.lastActivityMs ? Math.max(0, Math.round((Date.now() - s.lastActivityMs) / 1000)) : undefined,
      descriptionSource: card?.headline ? "runcard" : "work order",
    };
  });

  return {
    terminals,
    counts: {
      total: terminals.length,
      working: terminals.filter((t) => t.state === "working").length,
      idle: terminals.filter((t) => t.state === "idle").length,
      closed: terminals.filter((t) => t.state === "closed").length,
    },
    generatedAt: new Date().toISOString(),
    ...(note ? { note } : {}),
  };
}

// ── the tail ─────────────────────────────────────────────────────────────────

const TOOL_ARG_KEYS = ["file_path", "path", "pattern", "command", "cmd", "query", "url", "text", "prompt"];

function toolArgSummary(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const rec = input as Record<string, unknown>;
  for (const key of TOOL_ARG_KEYS) {
    const v = rec[key];
    if (typeof v === "string" && v.trim()) return clip(oneLine(v), 90);
  }
  const keys = Object.keys(rec);
  return keys.length ? clip(oneLine(keys.slice(0, 4).join(", ")), 60) : "";
}

function whoForUser(text: string): "ceo" | "manager" {
  const head = text.slice(0, 48);
  return head.includes("[From the CEO") ? "ceo" : "manager";
}

/** Journal records -> human-readable lines. Never returns raw JSON; never returns secrets. */
function linesFromJournalText(text: string): TailLine[] {
  const out: TailLine[] = [];
  for (const rec of parseJsonLines(text)) {
    for (const m of rec.append_messages ?? []) {
      const ts = typeof m.timestamp === "string" ? m.timestamp : "";
      const role = m.role === "assistant" ? "agent" : m.role === "user" ? "user" : String(m.role ?? "?");
      const parts = Array.isArray(m.content) ? m.content : [];
      let userText = "";
      for (const c of parts) {
        if (c.type === "text" && c.text) {
          const t = oneLine(c.text);
          if (!t) continue;
          if (role === "agent" && /^(?:reasoning|thinking)\b/i.test(t)) {
            out.push({ ts, who: "agent", text: clip(redact(t), LINE_MAX) });
            continue;
          }
          if (role === "user") {
            if (/^<system-reminder>/i.test(t)) continue;
            if (t.length > userText.length) userText = t;
            continue;
          }
          out.push({ ts, who: "agent", text: clip(redact(t), LINE_MAX) });
        } else if (c.type === "tool_use") {
          const arg = toolArgSummary(c.input);
          const label = c.name ? `→ ${c.name}${arg ? ` · ${arg}` : ""}` : "→ tool";
          out.push({ ts, who: "tool", text: clip(redact(label), LINE_MAX) });
        } else if (c.type === "tool_result") {
          const t = oneLine(c.text ?? "");
          if (!t) continue;
          out.push({ ts, who: "tool", text: clip(redact(`← result (${t.length} chars)`), LINE_MAX) });
        }
      }
      if (userText) {
        // jcode records an injected message as "[transcription] <the text>".
        const shown = cleanOrder(userText);
        out.push({ ts, who: whoForUser(shown), text: clip(redact(shown), LINE_MAX) });
      }
    }
  }
  return out;
}

export function terminalTail(sessionId: string, wantLines = 60): TailResult {
  const lines = Math.max(5, Math.min(400, Math.round(wantLines) || 60));
  const session = findSession(sessionId);
  const name = session?.name ?? shortNameFromId(sessionId);
  const tail = linesFromJournalText(readFileBounded(journalFile(sessionId), TAIL_BYTES, true));
  return {
    sessionId,
    name,
    state: session?.state ?? "closed",
    ...(session?.workOrder ? { workOrderExcerpt: clip(oneLine(session.workOrder), ORDER_EXCERPT_MAX) } : {}),
    lines: tail.slice(-lines),
    generatedAt: new Date().toISOString(),
  };
}

// ── targeted delivery ────────────────────────────────────────────────────────

function runJcode(args: string[], stdin: string, timeoutMs: number): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}> {
  return new Promise((resolve) => {
    // AIR-GAP (PERF item 7 review fix 2): `jcode transcript --mode send` drives the
    // live jcode agent, which may call hosted models (and itself fetches). Refuse the
    // whole delivery under AIR_GAPPED=1: the caller turns the non-ok result into the
    // terminal-chat error path, so nothing leaves the box and nothing is swallowed.
    if (airgappedBlock("fleet-agent", `jcode ${args.join(" ")}`)) {
      resolve({ code: null, stdout: "", stderr: "AIR_GAPPED=1 blocks the jcode agent delivery", timedOut: false, error: "air-gap blocked" });
      return;
    }
    const bin = process.env.JCODE_BIN || "jcode";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, error: String(e) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let done = false;
    let timedOut = false;
    const finish = (result: { code: number | null; error?: string }): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        code: result.code,
        stdout: clip(stdout, 4000),
        stderr: clip(stderr, 4000),
        timedOut,
        ...(result.error ? { error: result.error } : {}),
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish({ code: null, error: `timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.on("error", (e: Error) => finish({ code: null, error: e.message }));
    child.on("close", (code: number | null) => finish({ code }));
    try {
      child.stdin?.end(stdin, "utf8");
    } catch {
      /* the close/error handler reports it */
    }
  });
}

/**
 * The distinctive part of a sent message, used to find it again in the journal.
 * It is a LONG window (48 chars) taken from a fifth of the way into the text, so it cannot
 * collide with another message that merely starts with the same words (the first run of this
 * probe proved that: "check the Terminals page backend with ..." matched a previous delivery).
 */
function deliveryMarker(text: string): string {
  const norm = oneLine(text);
  if (norm.length <= 48) return norm;
  const start = Math.min(norm.length - 48, Math.max(0, Math.floor(norm.length * 0.2)));
  const window = norm.slice(start, start + 48).trim();
  return window.length >= 12 ? window : norm.slice(-48).trim();
}

/** How many times the marker appears in the session's own files right now. */
function markerCount(sessionId: string, marker: string): number {
  if (!marker) return 0;
  let n = 0;
  for (const file of [journalFile(sessionId), stateFile(sessionId)]) {
    const text = readFileBounded(file, TAIL_BYTES, true);
    let i = text.indexOf(marker);
    while (i >= 0) {
      n += 1;
      i = text.indexOf(marker, i + marker.length);
    }
  }
  return n;
}

/**
 * A busy terminal QUEUES the text and only writes it to its journal when it takes the turn
 * (measured on this install: 11s once, 59s while the target was in a long turn). So the HTTP
 * reply reports "accepted" and this unref'd background check upgrades the audit trail to
 * "confirmed" once the text really is in that session's journal - or says so if it never is.
 * Bounded: at most 4 pending checks, one interval each, and never keeps the process alive.
 */
const pendingConfirms = new Set<string>();

function scheduleDeliveryConfirm(
  sessionId: string,
  marker: string,
  sent: string,
  name: string,
  role: string,
): void {
  const key = `${sessionId}::${marker}`;
  if (pendingConfirms.has(key) || pendingConfirms.size >= 4) return;
  pendingConfirms.add(key);
  const before = markerCount(sessionId, marker);
  const deadline = Date.now() + 180_000;
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const seen = markerCount(sessionId, marker) > before;
    if (!seen && Date.now() < deadline) return;
    clearInterval(timer);
    pendingConfirms.delete(key);
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    logMessage({
      ts: new Date().toISOString(),
      sessionId,
      sessionName: name,
      role,
      text: sent,
      ok: true,
      how: "targeted",
      verified: seen,
      detail: seen
        ? `confirmed by the background check: the text is a new user message in ${name}'s journal (${seconds}s after delivery)`
        : `still not visible in ${name}'s journal 3 minutes after delivery — the terminal may never have taken the turn`,
    });
  }, 3000);
  timer.unref?.();
}

function logMessage(entry: Record<string, unknown>): void {
  try {
    const file = path.join(getCompanyRoot(), "reports", "terminal-messages.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    // A log failure must never fail the delivery.
  }
}

/** Instruction? then leave one short trace-style line in the coordination log. */
const INSTRUCTION_RE =
  /^\s*(?:please\s+|hey\s+|hi\s+|ok\s+|okay\s+)?(?:do|fix|add|build|run|stop|start|check|update|remove|change|make|write|deploy|restart|revert|investigate|verify|ensure|continue|move|help|tell|explain|look|read|rename|test|try|use|apply|commit|push|finish|complete|review|clean|kill|close|open)\b/i;

function noteInCoordinationLog(name: string, role: string, text: string): void {
  try {
    const file = path.join(process.cwd(), "docs", "AGENT_COORDINATION.md");
    const stamp = new Date().toISOString().slice(11, 16);
    const who = role ? `${name} (${role})` : name;
    fs.appendFileSync(
      file,
      `- ${stamp} CEO -> terminal ${who}: "${clip(oneLine(text), 140)}" (sent from the Terminals page)\n`,
    );
  } catch {
    // Never fail a delivery because the log is locked.
  }
}

/**
 * Deliver a message from the CEO dashboard into ONE jcode session.
 * Targeted only: `jcode transcript --mode send -S <sessionId>`, text on stdin.
 * There is NO focus-based fallback — the whole point of -S is that it cannot land in
 * the wrong terminal, and a fallback would destroy exactly that guarantee.
 */
export async function sendTerminalMessage(sessionIdRaw: unknown, textRaw: unknown): Promise<SendResult> {
  const sessionId = typeof sessionIdRaw === "string" ? sessionIdRaw : "";
  const text = typeof textRaw === "string" ? textRaw.trim() : "";

  if (!isSessionId(sessionId)) {
    return { ok: false, how: "targeted", status: 400, sessionId, detail: "not a valid session id" };
  }
  if (!text) {
    return { ok: false, how: "targeted", status: 400, sessionId, detail: "text required" };
  }
  const session = findSession(sessionId);
  if (!session) {
    return {
      ok: false,
      how: "targeted",
      status: 400,
      sessionId,
      detail: "no such session (it is not listed as live or recently active)",
    };
  }
  if (session.state === "closed" || session.liveClientPids.length === 0) {
    return {
      ok: false,
      how: "targeted",
      status: 400,
      sessionId,
      name: session.name,
      detail: `session ${session.name} is closed (no live client) — it cannot receive a message. Use \`jcode --resume ${sessionId}\` to bring it back.`,
    };
  }

  const payload = `${CEO_PREFIX}${text}`;
  const sent = clip(oneLine(payload), 300);
  const role = resolveRole(session, registryRoles());
  const started = Date.now();
  const result = await runJcode(
    ["transcript", "--mode", "send", "-S", sessionId, "--no-update", "--quiet"],
    payload,
    SEND_TIMEOUT_MS,
  );

  const stderr = clip(oneLine(redact(result.stderr)), 300);
  if (result.code !== 0 && !result.timedOut) {
    const detail = `jcode transcript --mode send -S ${sessionId} failed (exit ${result.code}${stderr ? `: ${stderr}` : ""})`;
    logMessage({
      ts: new Date().toISOString(),
      sessionId,
      sessionName: session.name,
      role,
      text: sent,
      ok: false,
      how: "targeted",
      detail,
    });
    return { ok: false, how: "targeted", status: 502, sessionId, name: session.name, sent, detail };
  }

  // Verify: the text must show up as a NEW user message in that session's own files. A busy
  // terminal queues the text and only writes it when it takes the turn (measured: ~11s on
  // this install), and the agent's own output can quote the words, so what counts is the
  // number of occurrences going UP - never "the text is somewhere in the file".
  const marker = deliveryMarker(text);
  const before = markerCount(sessionId, marker);
  const deadline = Date.now() + VERIFY_TIMEOUT_MS;
  let verified = false;
  while (Date.now() < deadline) {
    if (markerCount(sessionId, marker) > before) {
      verified = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  const tookMs = Date.now() - started;
  if (!verified) {
    // `-S` succeeded (jcode exited 0), so the text IS with that terminal; it just has not been
    // written to the journal yet - a busy terminal only records it when it takes the turn.
    // Reported honestly instead of as a hard failure.
    const detail =
      `accepted by ${session.name} (jcode exit 0) but not yet visible in its journal after ` +
      `${Math.round(VERIFY_TIMEOUT_MS / 1000)}s — a busy terminal queues the message until it takes the next turn` +
      (stderr ? ` (stderr: ${stderr})` : "");
    logMessage({
      ts: new Date().toISOString(),
      sessionId,
      sessionName: session.name,
      role,
      text: sent,
      ok: true,
      how: "targeted",
      verified: false,
      detail,
    });
    if (INSTRUCTION_RE.test(text)) noteInCoordinationLog(session.name, role, text);
    scheduleDeliveryConfirm(sessionId, marker, sent, session.name, role);
    return { ok: true, how: "targeted", status: 200, sessionId, name: session.name, sent, detail };
  }

  const detail =
    `delivered to ${session.name} (${session.state}) via \`jcode transcript --mode send -S ${sessionId}\`` +
    ` and confirmed as a user message in its journal after ${tookMs}ms`;
  logMessage({
    ts: new Date().toISOString(),
    sessionId,
    sessionName: session.name,
    role,
    text: sent,
    ok: true,
    how: "targeted",
    verified: true,
    detail,
  });
  if (INSTRUCTION_RE.test(text)) noteInCoordinationLog(session.name, role, text);

  return {
    ok: true,
    how: "targeted",
    status: 200,
    sessionId,
    name: session.name,
    sent,
    verified: true,
    verifiedAt: new Date().toISOString(),
    detail,
  };
}

// ── status (for the log line and the ops/ probe) ─────────────────────────────

export function terminalChatStatus(): {
  jcodeHome: string;
  jcodeBin: string;
  sessions: number;
  working: number;
  idle: number;
  closed: number;
  closedKeepMinutes: number;
} {
  const sessions = scanSessions();
  return {
    jcodeHome: jcodeHome(),
    jcodeBin: process.env.JCODE_BIN || "jcode",
    sessions: sessions.length,
    working: sessions.filter((s) => s.state === "working").length,
    idle: sessions.filter((s) => s.state === "idle").length,
    closed: sessions.filter((s) => s.state === "closed").length,
    closedKeepMinutes: Math.round(CLOSED_KEEP_MS / 60_000),
  };
}
