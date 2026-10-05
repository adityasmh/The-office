/**
 * Company lifecycle: shut everything down, then start everything again
 * (docs/SHUTDOWN_SPEC.md, ordered by the CEO, owned by the jcode session SHUTDOWN).
 *
 * The CEO's ask, in one paragraph: one button in the dashboard that stops the whole
 * company so it uses no RAM. Before anything closes, every terminal writes a checkpoint
 * of what it was doing, and a snapshot of the entire company (terminals, pipeline tasks,
 * Fleet orders, the assistant thread, stray test servers) lands in
 * `company/snapshots/<ISO-timestamp>/`. When the CEO starts the company again, every
 * terminal comes back as itself (`jcode --resume <sessionId>`, so it keeps its context)
 * and is handed a self-contained `resumeBrief` telling it what happened and what is left.
 *
 * Who does what, and why it is split that way:
 *   - THIS module (inside the running router) owns the PLAN: pause new work, ask for
 *     checkpoints, wait for them, write the snapshot, then hand over.
 *   - `ops/shutdown-all.ps1` (detached, outside this process) owns the KILLING: terminals,
 *     opencode workers, stray test servers, the shared jcode server, Laya, the supervisor
 *     scheduled task, and the router LAST. It must be outside this process because the
 *     router is one of the things it has to kill, and a process cannot kill its own
 *     supervisor path reliably from inside (killing the listener would leave the rest
 *     half-done). It also works standalone from a terminal, as the spec requires.
 *
 * Hard rules honoured here (same family as terminalChat.ts / terminalReaper.ts):
 *   1. `%USERPROFILE%\.jcode\` is READ-ONLY. Nothing in this file writes there.
 *   2. Delivery into a terminal is TARGETED (`jcode transcript --mode send -S <id>`);
 *      there is no focus-based fallback.
 *   3. Nothing secret is ever returned or written to a snapshot: every string that
 *      leaves this module passes through redact().
 *   4. A planned shutdown is NOT a crash: pipeline tasks in motion are marked
 *      `pausedByShutdown` (which RESUME's boot logic must resume, not fail) and Fleet
 *      orders are marked with bonehound's markPausedByShutdown().
 *   5. Never throw at the caller for data reasons: a missing journal, a dead pid or an
 *      unreachable peer degrades to an empty entry, never a 500.
 *
 * Routes (src/server.ts): GET /company/system/status, GET /company/system/snapshots,
 * GET /company/system/snapshots/:ts, POST /company/system/snapshot,
 * POST /company/system/shutdown, GET /company/system/shutdown/status,
 * POST /company/system/resume.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { addTrace, IN_MOTION, loadTasks, updateTask, type TaskRec } from "./gates.js";
import { getCompanyRoot, loadOrg } from "./org.js";
import {
  loadFleetOrders, markPausedByShutdown, resumeAfterShutdown, type FleetOrder,
} from "./fleet.js";
import { resumeTask } from "./pipeline.js";
import { assistantStatus, assistantThread, type AssistantThreadEntry } from "./assistant.js";
import { listRunCards, type RunCard } from "./runManagers.js";
import {
  isSessionId, redact, scanSessions, sendTerminalMessage, terminalTail, type SessionScan,
} from "./terminalChat.js";
import {
  cachedProcesses, jcodeHome, loadTerminals, liveClientPids, snapshotProcessesAsync,
  verifyWindow, type ProcMap, type ProcRow, type TerminalRec,
} from "./terminalReaper.js";

// ── knobs ────────────────────────────────────────────────────────────────────

function envNum(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}
function envStr(name: string, fallback: string): string {
  const raw = (process.env[name] ?? "").trim();
  return raw || fallback;
}

/** How long we wait for the terminals' checkpoint files after asking for them (spec: default 90s). */
export const checkpointWaitMs = (): number => envNum("SHUTDOWN_CHECKPOINT_S", 90) * 1000;
/**
 * Who counts as "a working terminal" for the checkpoint request.
 *
 * The spec says "each working terminal". On THIS install that cannot mean only
 * `state === "working"`: the state comes from `streaming_pids/<id>`, which only exists while
 * tokens are actually flowing, so a terminal that is mid-task but between tool calls reads
 * as "idle" (measured while building this). A terminal that was active in the last
 * SHUTDOWN_ACTIVE_WINDOW_S seconds is doing something, so it is asked for a checkpoint too -
 * which is the intent of the rule (tell the workers that are working to write down where
 * they are). The snapshot records which rule matched, per terminal.
 */
const activeWindowMs = (): number => envNum("SHUTDOWN_ACTIVE_WINDOW_S", 600) * 1000;
/** The notice we send before asking for a checkpoint (spec: "planned shutdown in 60s"). */
const checkpointNoticeS = (): number => envNum("SHUTDOWN_NOTICE_S", 60);
/** Stagger between opening resumed terminals (spec: one every ~8s). */
const resumeStaggerMs = (): number => envNum("SHUTDOWN_RESUME_STAGGER_S", 8) * 1000;
/** How long we wait for a resumed session to come alive before delivering its brief. */
const resumeAliveMs = (): number => envNum("SHUTDOWN_RESUME_ALIVE_S", 90) * 1000;
/**
 * The same two machine-wide limits the fleet respects before it opens a terminal.
 * The CEO raised the terminal limit to 30 (from 20) and kept the RAM floor at 2048 MB;
 * both are re-read from the environment here so lifecycle and fleet can never drift.
 */
const DEFAULT_MAX_PARALLEL_SESSIONS = 30;
const DEFAULT_MIN_FREE_RAM_MB = 2048;

const maxParallelSessions = (): number => envNum("MAX_PARALLEL_SESSIONS", DEFAULT_MAX_PARALLEL_SESSIONS);
const minFreeRamMb = (): number => envNum("MIN_FREE_RAM_MB", DEFAULT_MIN_FREE_RAM_MB);
/** How many snapshots to keep on disk (oldest are pruned after a new one is written). */
const snapshotsKeep = (): number => envNum("SHUTDOWN_SNAPSHOTS_KEEP", 20);
/** The scheduled task that keeps the router up (CRASHFIX's supervisor). */
const supervisorTaskName = (): string => envStr("ROUTER_SUPERVISOR_TASK", "LayaCompanyRouterSupervisor");
const layaHealthUrl = (): string => envStr("LAYA_HEALTH_URL", "http://127.0.0.1:8000/health");
const routerGraceSeconds = (): number => envNum("SHUTDOWN_ROUTER_GRACE_S", 6);

const jcodeBin = (): string => envStr("JCODE_BIN", "jcode");
const rootDir = (): string => process.cwd();

export function lifecycleKnobs() {
  return {
    checkpointWaitS: Math.round(checkpointWaitMs() / 1000),
    activeWindowS: Math.round(activeWindowMs() / 1000),
    noticeS: checkpointNoticeS(),
    resumeStaggerS: Math.round(resumeStaggerMs() / 1000),
    resumeAliveS: Math.round(resumeAliveMs() / 1000),
    maxParallelSessions: maxParallelSessions(),
    minFreeRamMb: minFreeRamMb(),
    snapshotsKeep: snapshotsKeep(),
    supervisorTask: supervisorTaskName(),
    routerGraceS: routerGraceSeconds(),
    onlySessions: onlySessionsFilter(),
    skip: skipSwitches(),
  };
}

/**
 * TEST MODE (spec §Proof): the whole flow must be provable on a throwaway instance, so the
 * two things that make a shutdown dangerous on a shared box are env-controlled, never
 * hard-coded: which sessions may be closed (`SHUTDOWN_ONLY_SESSIONS=tiger,lion`) and which
 * global steps to skip (`SHUTDOWN_SKIP=supervisor,laya,jcodeserver`). Unset = the real thing.
 */
function onlySessionsFilter(): string[] {
  return envStr("SHUTDOWN_ONLY_SESSIONS", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
function skipSwitches(): string[] {
  return envStr("SHUTDOWN_SKIP", "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// ── tiny fs helpers ──────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJsonAtomic(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows: a rename over a locked file fails; a direct write is better than losing the snapshot.
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
  }
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Timestamp safe for a file name: 2026-09-29T19-55-01-123Z */
function stampForFile(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

function clip(text: string, max: number): string {
  const t = String(text ?? "");
  return t.length > max ? `${t.slice(0, Math.max(0, max - 1))}…` : t;
}

function oneLine(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

export function snapshotsRoot(): string {
  return path.join(getCompanyRoot(), "snapshots");
}
export function snapshotDir(ts: string): string {
  return path.join(snapshotsRoot(), stampForFile(ts));
}

// ── process table (the same technique terminalReaper proved on this box) ────

/** The jcode TUI clients (never the server, the keepalive or the hotkey helper). */
function isJcodeTui(row: ProcRow): boolean {
  if (!/^jcode(\.exe)?$/i.test(row.name)) return false;
  const cmd = row.cmd.toLowerCase();
  if (/\bserve\b/.test(cmd)) return false; // shared server: `serve --socket ...`
  if (/keepalive/.test(cmd)) return false; // `server keepalive`
  if (/setup-hotkey/.test(cmd)) return false; // the hotkey helper
  if (/--version/.test(cmd)) return false;
  return true;
}

/** sessionId -> the TUI client pids that the *process table* proves are live. */
function clientPidsBySession(table: ProcMap): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const row of table.values()) {
    if (!isJcodeTui(row)) continue;
    const sessionId = sessionIdOfClient(row.pid, row.cmd);
    if (!sessionId) continue;
    const list = out.get(sessionId);
    if (list) list.push(row.pid);
    else out.set(sessionId, [row.pid]);
  }
  return out;
}

/** `--resume <id>` on the command line wins; otherwise the client_sessions/<pid> record. */
function sessionIdOfClient(pid: number, cmd: string): string {
  const m = /--resume\s+(session_[A-Za-z0-9_-]{4,})/.exec(cmd);
  if (m && isSessionId(m[1])) return m[1];
  try {
    const content = fs.readFileSync(path.join(jcodeHome(), "client_sessions", String(pid)), "utf8").trim();
    if (isSessionId(content)) return content;
  } catch {
    // no record
  }
  return "";
}

function ancestorChain(pid: number, table: ProcMap, maxDepth = 10): number[] {
  const chain: number[] = [];
  let cur = pid;
  for (let i = 0; i < maxDepth; i++) {
    const row = table.get(cur);
    if (!row || !row.ppid || row.ppid === cur) break;
    chain.push(row.ppid);
    cur = row.ppid;
  }
  return chain;
}

const WINDOW_PROCESS = /^(powershell|pwsh|cmd|windowsterminal|conhost|wezterm|alacritty|wt)\.exe$/i;

/** The shell window that hosts a client pid (what a close must target). */
function windowOf(clientPid: number, table: ProcMap): ProcRow | undefined {
  for (const pid of ancestorChain(clientPid, table)) {
    const row = table.get(pid);
    if (row && WINDOW_PROCESS.test(row.name)) return row;
  }
  return undefined;
}

/** The jcode shared-server pids from ~/.jcode/servers.json (never a close target). */
function jcodeServerPids(): number[] {
  const parsed = readJson<Record<string, { pid?: unknown }>>(path.join(jcodeHome(), "servers.json"));
  if (!parsed) return [];
  return Object.values(parsed)
    .map((s) => Number(s?.pid))
    .filter((p) => Number.isFinite(p) && p > 0);
}

function pidAlive(pid: number | undefined): boolean {
  if (!Number.isFinite(pid) || (pid as number) <= 0) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch {
    return false;
  }
}

// ── terminal discovery (the snapshot's unit of work) ─────────────────────────

export type TerminalSnapshot = {
  sessionId: string;
  name: string;
  role: string;
  /** full work order */
  workOrder: string;
  /** working | idle | closed */
  state: string;
  lastActivity?: string;
  startedAt?: string;
  /** REPORTING's card, if there is one for this session */
  runCard?: { headline: string; done: string[]; remaining: string[]; verdict?: string; state?: string; updatedAt?: string };
  /** files this terminal owns, extracted from its work order (and the registry role) */
  ownedFiles: string[];
  /** the last ~40 readable journal lines */
  lastSteps: string[];
  /** process identity: what a close must re-verify */
  clientPids: number[];
  windowPid?: number;
  windowName?: string;
  windowCreatedAt?: string;
  registryState?: string;
  /** absolute path of the checkpoint file it wrote, if it wrote one */
  checkpointPath?: string;
  checkpointText?: string;
  /** why this terminal was asked for a checkpoint (state or recent activity) */
  checkpointReason?: string;
  /** the message it will be handed when it comes back */
  resumeBrief: string;
};

export type TerminalInfo = {
  sessionId: string;
  name: string;
  role: string;
  state: string;
  streaming: boolean;
  lastActivity?: string;
  clientPids: number[];
  windowPid?: number;
  windowName?: string;
  /** the command line of the TUI client (redacted) */
  clientCmd: string;
  /** registry record, when AUTOCLOSE knows this terminal */
  registered: boolean;
};

const PATH_RE =
  /(?:[A-Za-z]:\\[^\s"'<>|*,;]+|(?:src|public|docs|ops|company|scripts|tests|deps|logs)[\\/][^\s"'<>|*,;)]+|[^\s"'<>|*,;)]+\.(?:ts|tsx|js|mjs|cjs|json|jsonl|md|css|html|ps1|bat|py))/g;

function ownedFilesFrom(order: string): string[] {
  const found = new Set<string>();
  for (const m of order.matchAll(PATH_RE)) {
    const p = m[0].replace(/[.,;:]+$/, "");
    if (p.length > 3) found.add(p);
  }
  return [...found].slice(0, 40);
}

/**
 * Every REAL jcode terminal alive right now: one row per live TUI client, mapped to its
 * session id (command line `--resume <id>` or the client_sessions record), plus the shell
 * window that hosts it (the registry's windowPid when AUTOCLOSE verified one, else the
 * ancestor walk). The shared server, the keepalive and the hotkey helper are excluded:
 * they are not terminals.
 */
export async function discoverTerminals(opts: { fresh?: boolean } = {}): Promise<TerminalInfo[]> {
  const table = opts.fresh ? await snapshotProcessesAsync(true) : cachedProcesses();
  const registry = new Map<string, TerminalRec>();
  for (const rec of safeLoadTerminals()) registry.set(rec.sessionId, rec);
  const sessions = new Map<string, SessionScan>();
  for (const s of safeScanSessions()) sessions.set(s.sessionId, s);

  const bySession = clientPidsBySession(table);
  const out: TerminalInfo[] = [];
  for (const [sessionId, pids] of bySession) {
    const scan = sessions.get(sessionId);
    const reg = registry.get(sessionId);
    const clientRow = table.get(pids[0]);
    let windowPid = reg?.windowPid;
    let windowName = windowPid ? table.get(windowPid)?.name : undefined;
    if (!windowPid || !pidAlive(windowPid)) {
      const derived = windowOf(pids[0], table);
      windowPid = derived?.pid;
      windowName = derived?.name;
    }
    out.push({
      sessionId,
      name: scan?.name || reg?.sessionName || shortName(sessionId),
      role: scan?.name === "rose" ? "CEO's own jcode window" : reg?.role || "",
      state: scan?.state ?? "working",
      streaming: scan?.streaming ?? false,
      lastActivity: scan?.lastActivityMs ? new Date(scan.lastActivityMs).toISOString() : undefined,
      clientPids: pids,
      windowPid,
      windowName,
      clientCmd: clip(redact(oneLine(clientRow?.cmd ?? "")), 300),
      registered: Boolean(reg),
    });
  }
  const rank: Record<string, number> = { working: 0, idle: 1, closed: 2 };
  out.sort((a, b) => (rank[a.state] ?? 3) - (rank[b.state] ?? 3) || a.name.localeCompare(b.name));
  return out;
}

function shortName(sessionId: string): string {
  const m = /^session_([a-z]+)_/.exec(sessionId);
  return m ? m[1] : sessionId;
}

function safeLoadTerminals(): TerminalRec[] {
  try {
    return loadTerminals();
  } catch {
    return [];
  }
}
function safeScanSessions(): SessionScan[] {
  try {
    return scanSessions();
  } catch {
    return [];
  }
}
function safeRunCards(): RunCard[] {
  try {
    return listRunCards();
  } catch {
    return [];
  }
}
function safeAssistantThread(limit: number): AssistantThreadEntry[] {
  try {
    return assistantThread(limit);
  } catch {
    return [];
  }
}

function cardFor(cards: RunCard[], sessionId: string, name: string): TerminalSnapshot["runCard"] {
  const lowName = name.toLowerCase();
  const hit = cards.find((c) => {
    if (!c || typeof c !== "object") return false;
    if (c.runId === sessionId) return true;
    const ref = (c as { ref?: { sessionId?: string } }).ref;
    if (ref?.sessionId === sessionId) return true;
    if (c.kind === "jcode" && typeof c.owner === "string" && lowName) {
      return new RegExp(`\\b${lowName}\\b`, "i").test(c.owner);
    }
    return false;
  });
  if (!hit) return undefined;
  const done = Array.isArray(hit.done) ? hit.done.map((x) => clip(oneLine(String(x)), 200)).slice(0, 6) : [];
  const remaining = Array.isArray(hit.remaining) ? hit.remaining.map((x) => clip(oneLine(String(x)), 200)).slice(0, 6) : [];
  return {
    headline: clip(redact(oneLine(hit.headline ?? "")), 300),
    done,
    remaining,
    ...(hit.verdict ? { verdict: hit.verdict } : {}),
    ...(hit.state ? { state: hit.state } : {}),
    ...(hit.updatedAt ? { updatedAt: hit.updatedAt } : {}),
  };
}

/**
 * The full work order: the first real (non-system-reminder) user message in the session's
 * own state file, unbounded by the 1200-char excerpt terminalChat keeps for its list.
 */
const fullOrderCache = new Map<string, string>();

function readFullWorkOrder(sessionId: string): string {
  const cached = fullOrderCache.get(sessionId);
  if (cached !== undefined) return cached;
  const file = path.join(jcodeHome(), "sessions", `${sessionId}.json`);
  let text = "";
  try {
    const size = fs.statSync(file).size;
    const maxBytes = 4 * 1024 * 1024;
    if (size <= maxBytes) {
      text = fs.readFileSync(file, "utf8");
    } else {
      const fd = fs.openSync(file, "r");
      try {
        const buf = Buffer.alloc(maxBytes);
        const n = fs.readSync(fd, buf, 0, maxBytes, 0);
        text = buf.toString("utf8", 0, n);
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    text = "";
  }
  let found = "";
  const re = /"role"\s*:\s*"user"[\s\S]{0,200}?"content"\s*:\s*\[\s*\{\s*"type"\s*:\s*"text"\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let decoded = "";
    try {
      decoded = JSON.parse(`"${m[1]}"`) as string;
    } catch {
      decoded = m[1];
    }
    const t = decoded.trim();
    if (!t || /^<system-reminder>/i.test(t)) continue;
    found = t;
    break;
  }
  const cleaned = redact(found.replace(/^\uFEFF/, "").replace(/^\s*[^\s\[]{0,8}\[transcription\]\s*/i, "").trim());
  if (cleaned) {
    if (fullOrderCache.size > 200) fullOrderCache.clear();
    fullOrderCache.set(sessionId, cleaned);
  }
  return cleaned;
}

/** The last ~40 readable journal lines, as "hh:mm:ss who: text". */
function lastSteps(sessionId: string, lines = 40): string[] {
  try {
    return terminalTail(sessionId, lines).lines.map((l) => {
      const when = l.ts ? `${l.ts.slice(11, 19)} ` : "";
      return `${when}${l.who}: ${clip(oneLine(l.text), 240)}`;
    });
  } catch {
    return [];
  }
}

/**
 * The self-contained message a terminal is handed when it comes back (spec §1). It has to
 * stand alone: the session keeps its context, but the context is exactly what was
 * interrupted, so it repeats the order, what was done, where it stopped and what is left.
 */
function buildResumeBrief(input: {
  name: string;
  role: string;
  stoppedAt: string;
  workOrder: string;
  state: string;
  lastActivity?: string;
  runCard?: TerminalSnapshot["runCard"];
  checkpoint?: string;
  lastSteps: string[];
  ownedFiles: string[];
}): string {
  const parts: string[] = [];
  parts.push(
    `[Manager] The whole company was shut down by the CEO at ${input.stoppedAt} and has just been started again. ` +
      `You were interrupted by that planned shutdown — nothing failed and nothing was your fault.`,
  );
  parts.push(`Your order was: ${clip(oneLine(input.workOrder), 1200) || "(no work order recorded for this session)"}`);
  const done = input.runCard?.done?.length
    ? input.runCard.done.map((d) => `- ${d}`).join("\n")
    : "(no run card recorded what was done)";
  parts.push(`Done so far (from your run card):\n${done}`);
  const mid = input.checkpoint
    ? clip(input.checkpoint, 2000)
    : input.lastSteps.length
      ? input.lastSteps.slice(-8).join("\n")
      : "(no checkpoint arrived before the shutdown)";
  parts.push(`You were in the middle of:\n${mid}`);
  const remaining = input.runCard?.remaining?.length
    ? input.runCard.remaining.map((r) => `- ${r}`).join("\n")
    : "(not recorded — re-read your own notes above and decide what is left)";
  parts.push(`Remaining:\n${remaining}`);
  parts.push(
    `Your state at shutdown: ${input.state}${input.lastActivity ? `, last activity ${input.lastActivity}` : ""}` +
      (input.ownedFiles.length ? `. Files you own / were touching: ${input.ownedFiles.slice(0, 20).join(", ")}` : ""),
  );
  parts.push(
    "Check the files before continuing (they are on disk exactly as you left them), then carry on with your order " +
      "and send your report when you are done. If your work is already finished, just say so.",
  );
  return parts.join("\n\n");
}

// ── status ───────────────────────────────────────────────────────────────────

export type SystemStatus = {
  generatedAt: string;
  paused: boolean;
  router: { host: string; port: number; pid: number; uptimeS: number };
  laya: { url: string; ok: boolean; detail?: string };
  jcodeServer: { running: boolean; pids: number[] };
  supervisor: { task: string; state: string; detail?: string };
  terminals: { total: number; working: number; idle: number; names: string[] };
  opencodeWorkers: number;
  testServers: number;
  freeRamMb: number;
  totalRamMb: number;
  limits: { maxParallelSessions: number; minFreeRamMb: number };
  shutdown: ShutdownJobStatus;
  latestSnapshot: SnapshotSummary | null;
  blockedReason: string | null;
};

const startedAtMs = Date.now();

/** Test servers an agent left behind: node.exe started from one of our project roots. */
function testServerRows(table: ProcMap): ProcRow[] {
  const roots = new Set<string>();
  try {
    for (const p of loadOrg().projects) if (p.rootDir) roots.add(path.resolve(p.rootDir).toLowerCase());
  } catch {
    // no org: nothing to match
  }
  roots.add(path.join(rootDir(), "company").toLowerCase());
  const out: ProcRow[] = [];
  for (const row of table.values()) {
    if (!/^node(\.exe)?$/i.test(row.name)) continue;
    const cmd = row.cmd.replace(/\//g, "\\").toLowerCase();
    if (cmd.includes("src\\server.ts")) continue; // the router itself
    if (cmd.includes("router-supervisor")) continue;
    for (const r of roots) {
      if (r && cmd.includes(r)) { out.push(row); break; }
    }
  }
  return out;
}

function opencodeRows(table: ProcMap): ProcRow[] {
  return [...table.values()].filter((r) => /^opencode(\.exe)?$/i.test(r.name));
}

async function fetchWithTimeout(url: string, ms: number): Promise<{ ok: boolean; detail?: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
    let body = "";
    try { body = clip(oneLine(await res.text()), 200); } catch { /* body irrelevant */ }
    return { ok: res.ok, detail: `${res.status} ${res.statusText}${body ? ` · ${body}` : ""}` };
  } catch (e) {
    return { ok: false, detail: clip(redact(String(e)), 200) };
  }
}

let supervisorCache: { at: number; state: string; detail?: string } | undefined;

/** The scheduled task's state, from schtasks (cached 10s: the UI polls this page). */
async function supervisorState(): Promise<{ state: string; detail?: string }> {
  if (supervisorCache && Date.now() - supervisorCache.at < 10_000) {
    return { state: supervisorCache.state, ...(supervisorCache.detail ? { detail: supervisorCache.detail } : {}) };
  }
  const task = supervisorTaskName();
  const res = await runCommand("schtasks", ["/query", "/tn", task, "/fo", "LIST"], 15_000);
  let state = "unknown";
  let detail: string | undefined;
  if (!res.ok) {
    state = "not found";
    detail = clip(oneLine(res.stderr || res.error || ""), 200);
  } else {
    const m = /^Status:\s*(.+)$/m.exec(res.stdout);
    // schtasks is localized; "Running"/"Ready" are the English words. Fall back to the raw line.
    state = m ? m[1].trim() : "unknown";
    if (/running/i.test(state)) state = "Running";
    else if (/ready/i.test(state)) state = "Ready";
    else if (/disabled/i.test(state)) state = "Disabled";
  }
  supervisorCache = { at: Date.now(), state, ...(detail ? { detail } : {}) };
  return { state, ...(detail ? { detail } : {}) };
}

export async function systemStatus(): Promise<SystemStatus> {
  const table = cachedProcesses();
  const terminals = await discoverTerminals();
  const [laya, supervisor] = await Promise.all([
    fetchWithTimeout(layaHealthUrl(), 2500),
    supervisorState(),
  ]);
  const serverPids = jcodeServerPids().filter((p) => pidAlive(p));
  const totalRamMb = Math.round(os.totalmem() / 1048576);
  const freeRamMb = Math.round(os.freemem() / 1048576);
  const latest = listSnapshots(1)[0] ?? null;
  return {
    generatedAt: nowIso(),
    paused: paused(),
    router: {
      host: config.host,
      port: config.port,
      pid: process.pid,
      uptimeS: Math.round((Date.now() - startedAtMs) / 1000),
    },
    laya: { url: layaHealthUrl(), ok: laya.ok, ...(laya.detail ? { detail: laya.detail } : {}) },
    jcodeServer: { running: serverPids.length > 0, pids: serverPids },
    supervisor: { task: supervisorTaskName(), state: supervisor.state, ...(supervisor.detail ? { detail: supervisor.detail } : {}) },
    terminals: {
      total: terminals.length,
      working: terminals.filter((t) => t.state === "working").length,
      idle: terminals.filter((t) => t.state === "idle").length,
      names: terminals.map((t) => t.name),
    },
    opencodeWorkers: opencodeRows(table).length,
    testServers: testServerRows(table).length,
    freeRamMb,
    totalRamMb,
    limits: { maxParallelSessions: maxParallelSessions(), minFreeRamMb: minFreeRamMb() },
    shutdown: shutdownJobStatus(),
    latestSnapshot: latest,
    blockedReason: paused() ? "the company is paused for a planned shutdown" : null,
  };
}

// ── the pause flag ───────────────────────────────────────────────────────────
// Spec §2 step 1: "pause new work (a flag that makes the assistant/fleet/pipeline refuse
// new starts)". The flag is in-memory for the running process (a router restart clears
// it, which is correct: after a restart only the CEO decides when to resume) and is
// mirrored to company/system/paused.json so the dashboard and the ops scripts can see it.

let pausedFlag = false;

export function paused(): boolean {
  return pausedFlag;
}

export function pausedFile(): string {
  return path.join(getCompanyRoot(), "system", "paused.json");
}

export function setPaused(next: boolean, reason: string): { paused: boolean; at: string; reason: string } {
  pausedFlag = next;
  const rec = { paused: next, at: nowIso(), reason: redact(reason) };
  try {
    writeJsonAtomic(pausedFile(), rec);
  } catch (e) {
    console.error(`[shutdown] could not write ${pausedFile()}: ${String(e)}`);
  }
  console.log(`[shutdown] new work ${next ? "PAUSED" : "allowed again"} (${rec.reason})`);
  return rec;
}

/**
 * The guard the router uses on the routes that START work (assistant, pipeline, fleet).
 * Returns a reason when new work must be refused, else null.
 */
export function refuseNewWork(what: string): string | null {
  if (!pausedFlag) return null;
  return (
    `the company is paused for a planned shutdown (${what} was refused). ` +
    "Finish the shutdown with the System page's 'Resume all', or the CEO can start the company again with 'Start Laya Company'."
  );
}

// ── snapshot ─────────────────────────────────────────────────────────────────

export type SnapshotSummary = {
  ts: string;
  dir: string;
  reason: string;
  createdAt: string;
  restoredAt?: string;
  counts: {
    terminals: number;
    checkpoints: number;
    tasks: number;
    fleetOrders: number;
    messages: number;
    strayProcesses: number;
  };
  terminals: Array<{ name: string; sessionId: string; state: string; role: string; windowPid?: number; checkpoint?: boolean }>;
};

export type SnapshotResult = {
  ok: boolean;
  ts: string;
  dir: string;
  counts: SnapshotSummary["counts"];
  index: string;
  terminalFiles: string[];
  checkpoints: string[];
  warnings: string[];
};

const CHECKPOINT_WORDS = /checkpoint/i;

/**
 * Write one snapshot of the whole company to company/snapshots/<ts>/.
 *
 * Steps (in the spec's order): terminals (+ checkpoints) → pipeline tasks in motion →
 * Fleet orders → assistant → stray processes → index.json. Every terminal gets its own
 * terminals/<name>.json with a self-contained resumeBrief; checkpoints arriving from the
 * terminals are merged into it.
 */
export async function takeSnapshot(opts: {
  reason: string;
  /** ask the working terminals for a checkpoint and wait for the files (shutdown: true) */
  withCheckpoints?: boolean;
  /** mark pipeline tasks + fleet orders pausedByShutdown (shutdown: true) */
  markPaused?: boolean;
  /** called as the checkpoint files arrive, for the UI progress view */
  onProgress?: (step: string) => void;
}): Promise<SnapshotResult> {
  const ts = nowIso();
  const dir = snapshotDir(ts);
  const warnings: string[] = [];
  const progress = (s: string): void => {
    console.log(`[shutdown] ${s}`);
    try { opts.onProgress?.(s); } catch { /* observer only */ }
  };

  ensureDir(path.join(dir, "terminals"));
  const checkpointDir = path.join(dir, "checkpoints");
  ensureDir(checkpointDir);

  progress("reading the process table");
  const table = await snapshotProcessesAsync(true);
  const allTerminals = await discoverTerminals({ fresh: true });
  // TEST MODE: `SHUTDOWN_ONLY_SESSIONS` must scope the WHOLE run, not just the closing step.
  // (An earlier revision scoped only ops/shutdown-all.ps1, so a test shutdown asked every
  // live terminal for a checkpoint and told it to stop - the request phase has to honour the
  // same filter, or "test mode" would not be safe to run while the real company is working.)
  const only = onlySessionsFilter();
  const terminals = only.length
    ? allTerminals.filter((t) => only.includes(t.sessionId) || only.includes(t.name))
    : allTerminals;
  if (only.length) {
    const missing = only.filter((id) => !terminals.some((t) => t.sessionId === id || t.name === id));
    if (missing.length) {
      warnings.push(`SHUTDOWN_ONLY_SESSIONS names ${missing.length} session(s) that are not live: ${missing.join(", ")}`);
    }
    progress(
      `SCOPED RUN (SHUTDOWN_ONLY_SESSIONS): ${terminals.length} of ${allTerminals.length} live terminal(s) are in this snapshot`,
    );
  }
  const cards = safeRunCards();
  progress(`found ${terminals.length} real jcode terminal(s)`);

  // ── 1. the terminals ──────────────────────────────────────────────────────
  const built: Array<{ info: TerminalInfo; snap: TerminalSnapshot; file: string }> = [];
  const usedNames = new Set<string>();
  for (const info of terminals) {
    const workOrder = readFullWorkOrder(info.sessionId);
    const steps = lastSteps(info.sessionId, 40);
    const card = cardFor(cards, info.sessionId, info.name);
    const snap: TerminalSnapshot = {
      sessionId: info.sessionId,
      name: info.name,
      role: info.role,
      workOrder,
      state: info.state,
      ...(info.lastActivity ? { lastActivity: info.lastActivity } : {}),
      ...(card ? { runCard: card } : {}),
      ownedFiles: ownedFilesFrom(`${workOrder}\n${card?.headline ?? ""}`),
      lastSteps: steps,
      clientPids: info.clientPids,
      ...(info.windowPid ? { windowPid: info.windowPid } : {}),
      ...(info.windowName ? { windowName: info.windowName } : {}),
      ...(table.get(info.windowPid ?? -1)?.created ? { windowCreatedAt: table.get(info.windowPid as number)!.created } : {}),
      registryState: safeLoadTerminals().find((r) => r.sessionId === info.sessionId)?.state,
      resumeBrief: "",
    };
    snap.resumeBrief = buildResumeBrief({
      name: snap.name,
      role: snap.role,
      stoppedAt: ts,
      workOrder: snap.workOrder,
      state: snap.state,
      ...(snap.lastActivity ? { lastActivity: snap.lastActivity } : {}),
      ...(snap.runCard ? { runCard: snap.runCard } : {}),
      lastSteps: snap.lastSteps,
      ownedFiles: snap.ownedFiles,
    });
    let fileName = `${safeFileName(snap.name || snap.sessionId)}.json`;
    if (usedNames.has(fileName)) fileName = `${safeFileName(snap.name || snap.sessionId)}--${snap.sessionId.slice(-8)}.json`;
    usedNames.add(fileName);
    const file = path.join(dir, "terminals", fileName);
    writeJsonAtomic(file, snap);
    built.push({ info, snap, file });
  }

  // ── 2. checkpoints ────────────────────────────────────────────────────────
  const checkpointFiles: string[] = [];
  const sendResults: Array<{ sessionId: string; name: string; ok: boolean; detail: string }> = [];
  const working = built.filter((b) => {
    if (b.snap.state === "working") {
      b.snap.checkpointReason = "state=working (its turn is streaming right now)";
      return true;
    }
    const at = b.snap.lastActivity ? Date.parse(b.snap.lastActivity) : NaN;
    if (Number.isFinite(at) && Date.now() - at <= activeWindowMs()) {
      b.snap.checkpointReason = `active ${Math.round((Date.now() - at) / 1000)}s ago (between tool calls, so not flagged working)`;
      return true;
    }
    return false;
  });
  for (const b of working) writeJsonAtomic(b.file, b.snap);
  if (opts.withCheckpoints && working.length) {
    const notice = checkpointNoticeS();
    progress(`asking ${working.length} working terminal(s) for a checkpoint`);
    // The path is ABSOLUTE on purpose: the terminals run in the project root, but the
    // snapshot may live under a different COMPANY_ROOT (a test instance), and a relative
    // path would then land somewhere the router is not looking.
    const messageFor = (name: string): string => {
      const file = path.join(checkpointDir, `${safeFileName(name)}.md`);
      // A shutdown says "then stop"; a plain "Snapshot now" must NOT stop anyone, or taking a
      // snapshot would interrupt the company it is only supposed to record.
      return opts.markPaused
        ? `[Manager] Planned shutdown in ${notice}s: write a checkpoint of what you're doing and what's left to ` +
          `${file} now, then stop. ` +
          `(The company is being stopped by the CEO to free RAM; you will be resumed with your context and this checkpoint.)`
        : `[Manager] Snapshot now (the company keeps running): write a checkpoint of what you're doing and what's left to ` +
          `${file}, then carry on with your order.`;
    };
    await Promise.all(
      working.map(async (b) => {
        try {
          const res = await sendTerminalMessage(b.snap.sessionId, messageFor(b.snap.name));
          sendResults.push({ sessionId: b.snap.sessionId, name: b.snap.name, ok: res.ok, detail: clip(redact(res.detail), 300) });
        } catch (e) {
          sendResults.push({ sessionId: b.snap.sessionId, name: b.snap.name, ok: false, detail: clip(redact(String(e)), 300) });
        }
      }),
    );
    const deadline = Date.now() + checkpointWaitMs();
    const want = new Set(working.map((b) => safeFileName(b.snap.name).toLowerCase()));
    const wantIds = new Set(working.map((b) => b.snap.sessionId));
    while (Date.now() < deadline) {
      const seen = checkpointFilesNow(checkpointDir);
      for (const f of seen) {
        if (checkpointFiles.includes(f)) continue;
        checkpointFiles.push(f);
        progress(`checkpoint arrived: ${path.basename(f)}`);
      }
      const covered = new Set(seen.map((f) => checkpointBase(f).toLowerCase()));
      const allIn = [...want].every((n) => covered.has(n));
      // Also stop early when every checkpoint carries one of our session ids, whatever it is named.
      const byId = new Set(
        seen.map((f) => readCheckpoint(f)).filter((t) => [...wantIds].some((id) => t.includes(id))).map(() => true),
      );
      if (allIn || (seen.length > 0 && byId.size >= wantIds.size && wantIds.size <= seen.length)) break;
      await sleep(2000);
    }
    for (const b of built) {
      const hit = checkpointFiles.find((f) => checkpointBase(f).toLowerCase() === safeFileName(b.snap.name).toLowerCase())
        ?? checkpointFiles.find((f) => readCheckpoint(f).includes(b.snap.sessionId));
      if (!hit) continue;
      const text = readCheckpoint(hit);
      if (!text) continue;
      b.snap.checkpointPath = path.relative(dir, hit).replace(/\\/g, "/");
      b.snap.checkpointText = clip(text, 4000);
      b.snap.resumeBrief = buildResumeBrief({
        name: b.snap.name,
        role: b.snap.role,
        stoppedAt: ts,
        workOrder: b.snap.workOrder,
        state: b.snap.state,
        ...(b.snap.lastActivity ? { lastActivity: b.snap.lastActivity } : {}),
        ...(b.snap.runCard ? { runCard: b.snap.runCard } : {}),
        checkpoint: b.snap.checkpointText,
        lastSteps: b.snap.lastSteps,
        ownedFiles: b.snap.ownedFiles,
      });
      writeJsonAtomic(b.file, b.snap);
    }
    const missing = working.filter((b) => !b.snap.checkpointPath);
    if (missing.length) {
      warnings.push(
        `no checkpoint arrived from ${missing.length} working terminal(s): ${missing.map((b) => b.snap.name).join(", ")} ` +
          `(their resumeBrief falls back to the last journal lines)`,
      );
    }
    progress(`${checkpointFiles.length} checkpoint(s) received`);
  } else if (!opts.withCheckpoints) {
    warnings.push("checkpoints were not requested (snapshot-only run)");
  }

  // ── 3. pipeline tasks in motion ───────────────────────────────────────────
  const tasks: Array<{ projectId: string; projectName?: string; taskId: string; status: string; request: string; updatedAt: string; trace?: unknown }> = [];
  const markedTasks: string[] = [];
  try {
    for (const project of loadOrg().projects) {
      for (const t of loadTasks(project.id)) {
        if (!IN_MOTION.includes(t.status)) continue;
        tasks.push({
          projectId: project.id,
          projectName: project.name,
          taskId: t.id,
          status: t.status,
          request: clip(redact(oneLine(t.rawRequest)), 600),
          updatedAt: t.updatedAt,
        });
        if (opts.markPaused) {
          try {
            // `pausedByShutdown` does NOT count as an interruption (RESUME_SPEC): RESUME's
            // boot logic resumes these tasks instead of marking them failed.
            updateTask(project.id, t.id, { pausedByShutdown: true } as TaskPatch);
            addTrace(project.id, t.id, {
              from: "CEO",
              to: "Router",
              what: `shut down by CEO at ${ts}`,
              detail: `planned shutdown; pausedByShutdown=true; snapshot company/snapshots/${path.basename(dir)}`,
            });
            markedTasks.push(`${project.id}/${t.id}`);
          } catch (e) {
            warnings.push(`could not mark ${project.id}/${t.id} pausedByShutdown: ${clip(redact(String(e)), 200)}`);
          }
        }
      }
    }
  } catch (e) {
    warnings.push(`could not read the projects: ${clip(redact(String(e)), 200)}`);
  }
  if (tasks.length) progress(`${tasks.length} pipeline task(s) in motion${opts.markPaused ? ` (all marked pausedByShutdown)` : ""}`);

  // ── 4. Fleet orders ──────────────────────────────────────────────────────
  const orders: FleetOrder[] = [];
  try {
    for (const o of loadFleetOrders()) {
      if (["done", "cancelled", "failed"].includes(o.status)) continue;
      orders.push(o);
    }
  } catch (e) {
    warnings.push(`could not read the fleet orders: ${clip(redact(String(e)), 200)}`);
  }
  let markedOrders = 0;
  if (opts.markPaused && orders.length) {
    try {
      markedOrders = markPausedByShutdown(orders.map((o) => o.id));
    } catch (e) {
      warnings.push(`could not mark the fleet orders pausedByShutdown: ${clip(redact(String(e)), 200)}`);
    }
  }
  const fleetJson = orders.map((o) => ({
    id: o.id,
    text: clip(redact(oneLine(o.text)), 600),
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    status: o.status,
    plan: o.plan ? clip(redact(o.plan), 4000) : undefined,
    pausedByShutdown: (o as { pausedByShutdown?: boolean }).pausedByShutdown,
    workOrders: (o.workOrders ?? []).map((w) => ({
      id: w.id,
      title: clip(redact(w.title), 200),
      role: w.role,
      owns: w.owns,
      brief: clip(redact(w.brief), 2000),
      state: w.state,
      sessionId: w.sessionId,
      windowPid: w.windowPid,
      attempts: w.attempts,
      reportedAt: w.reportedAt,
      verdict: w.verdict,
      reportPath: w.sessionId ? `company/fleet/${o.id}/${w.id}/REPORT.md` : undefined,
    })),
    trace: (o.trace ?? []).slice(-12),
  }));
  if (orders.length) writeJsonAtomic(path.join(dir, "fleet.json"), fleetJson);

  // ── 5. the assistant ─────────────────────────────────────────────────────
  const messages = safeAssistantThread(20);
  let inFlight: unknown;
  try {
    const file = path.join(getCompanyRoot(), "assistant-inflight.json");
    if (fs.existsSync(file)) inFlight = readJson<unknown>(file);
  } catch {
    // no marker
  }
  writeJsonAtomic(path.join(dir, "assistant.json"), {
    status: (() => {
      try { return assistantStatus(); } catch { return "unknown"; }
    })(),
    inFlight: inFlight ?? null,
    messages: messages.map((m) => ({ ts: m.ts, role: m.role, text: clip(redact(m.text), 1500), ...(m.tasks ? { tasks: m.tasks } : {}) })),
  });

  // ── 6. processes that will be stopped but NOT resumed ────────────────────
  const strays = [...opencodeRows(table), ...testServerRows(table)].map((r) => ({
    pid: r.pid,
    name: r.name,
    kind: /opencode/i.test(r.name) ? "opencode-worker" : "test-server",
    cmd: clip(redact(oneLine(r.cmd)), 300),
  }));
  writeJsonAtomic(path.join(dir, "processes.json"), {
    note: "stopped by the shutdown, not resumed",
    router: { pid: process.pid, port: config.port },
    jcodeServerPids: jcodeServerPids(),
    strays,
  });

  // ── 7. index.json ────────────────────────────────────────────────────────
  const checkpointNames = checkpointFilesNow(checkpointDir).map((f) => path.relative(dir, f).replace(/\\/g, "/"));
  const summary: SnapshotSummary & {
    kind: "full" | "snapshot-only";
    warnings: string[];
    checkpointRequests: typeof sendResults;
    markedTasks: string[];
    markedFleetOrders: number;
    resumeNotes: string;
    scopedTo?: string[];
  } = {
    ts,
    dir,
    reason: redact(opts.reason),
    createdAt: ts,
    kind: checkpointNames.length ? "full" : "snapshot-only",
    counts: {
      terminals: built.length,
      checkpoints: checkpointNames.length,
      tasks: tasks.length,
      fleetOrders: orders.length,
      messages: messages.length,
      strayProcesses: strays.length,
    },
    terminals: built.map((b) => ({
      name: b.snap.name,
      sessionId: b.snap.sessionId,
      state: b.snap.state,
      role: b.snap.role,
      ...(b.snap.windowPid ? { windowPid: b.snap.windowPid } : {}),
      checkpoint: Boolean(b.snap.checkpointPath),
    })),
    warnings,
    checkpointRequests: sendResults,
    markedTasks,
    markedFleetOrders: markedOrders,
    resumeNotes:
      "POST /company/system/resume {sessionIds} reopens these terminals with jcode --resume and delivers each resumeBrief; " +
      "tasks flagged pausedByShutdown are resumed by RESUME's boot logic / this route; Fleet orders by markPausedByShutdown/resumeAfterShutdown (FLEET).",
    ...(only.length ? { scopedTo: only } : {}),
  };
  writeJsonAtomic(path.join(dir, "index.json"), summary);
  writeJsonAtomic(path.join(dir, "checkpoints.json"), { ts, received: checkpointNames, requested: sendResults });
  pruneSnapshots();

  progress(`snapshot written: ${path.relative(rootDir(), dir).replace(/\\/g, "/")} (${built.length} terminals)`);
  return {
    ok: true,
    ts,
    dir,
    counts: summary.counts,
    index: "index.json",
    terminalFiles: built.map((b) => path.relative(dir, b.file).replace(/\\/g, "/")),
    checkpoints: checkpointNames,
    warnings,
  };
}

/** `pausedByShutdown` is RESUME's field (gates.ts); the cast keeps this module compiling
 *  whether or not their edit has landed yet — updateTask spreads the patch as-is. */
type TaskPatch = Partial<TaskRec> & { pausedByShutdown?: boolean };

function safeFileName(name: string): string {
  const cleaned = String(name ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60);
  return cleaned || "unnamed";
}

function checkpointFilesNow(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
      .filter((n) => CHECKPOINT_WORDS.test(n) || /\.md$/i.test(n))
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

function checkpointBase(file: string): string {
  return path.basename(file).replace(/\.md$/i, "").replace(/[^A-Za-z0-9._-]/g, "_");
}

function readCheckpoint(file: string): string {
  try {
    return redact(fs.readFileSync(file, "utf8"));
  } catch {
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

// ── snapshots on disk ────────────────────────────────────────────────────────

type IndexFile = SnapshotSummary & { warnings?: string[]; kind?: string; markedTasks?: string[] };

export function listSnapshots(limit = 20): SnapshotSummary[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(snapshotsRoot());
  } catch {
    return [];
  }
  const out: SnapshotSummary[] = [];
  for (const name of names) {
    const dir = path.join(snapshotsRoot(), name);
    const idx = readJson<IndexFile>(path.join(dir, "index.json"));
    if (!idx || typeof idx.ts !== "string") continue;
    out.push({ ...idx, dir });
  }
  out.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  return out.slice(0, limit);
}

export function readSnapshot(ts: string): { summary: SnapshotSummary; terminals: TerminalSnapshot[] } | undefined {
  const idx = readJson<IndexFile>(path.join(snapshotDir(ts), "index.json"));
  if (!idx) return undefined;
  const dir = path.join(snapshotsRoot(), path.basename(idx.dir ?? snapshotDir(ts)));
  const terminals: TerminalSnapshot[] = [];
  try {
    for (const name of fs.readdirSync(path.join(dir, "terminals"))) {
      if (!name.endsWith(".json")) continue;
      const snap = readJson<TerminalSnapshot>(path.join(dir, "terminals", name));
      if (snap && snap.sessionId) terminals.push(snap);
    }
  } catch {
    // no terminals directory: the summary still stands
  }
  return { summary: { ...idx, dir }, terminals };
}

function pruneSnapshots(): void {
  const keep = snapshotsKeep();
  const all = listSnapshots(1000);
  for (const s of all.slice(keep)) {
    try {
      fs.rmSync(s.dir, { recursive: true, force: true });
      console.log(`[shutdown] pruned old snapshot ${path.basename(s.dir)}`);
    } catch {
      // best effort
    }
  }
}

// ── shutdown ─────────────────────────────────────────────────────────────────

export type ShutdownStep = { ts: string; phase: string; text: string };

export type ShutdownJobStatus = {
  id: string | null;
  running: boolean;
  phase: "idle" | "pausing" | "checkpointing" | "snapshot" | "closing" | "done" | "error";
  startedAt?: string;
  finishedAt?: string;
  snapshotTs?: string;
  snapshotDir?: string;
  counts?: SnapshotSummary["counts"];
  checkpointsArrived: number;
  checkpointsExpected: number;
  terminals: number;
  scriptPid?: number;
  logFile?: string;
  error?: string;
  steps: ShutdownStep[];
  warnings: string[];
};

let job: ShutdownJobStatus = {
  id: null,
  running: false,
  phase: "idle",
  checkpointsArrived: 0,
  checkpointsExpected: 0,
  terminals: 0,
  steps: [],
  warnings: [],
};

export function shutdownJobStatus(): ShutdownJobStatus {
  return {
    ...job,
    steps: job.steps.slice(-40),
    checkpointsArrived: countCheckpointFiles(job.snapshotDir),
  };
}

function countCheckpointFiles(dir: string | undefined): number {
  if (!dir) return job.checkpointsArrived;
  try {
    return fs.readdirSync(path.join(dir, "checkpoints")).filter((n) => /\.md$/i.test(n)).length;
  } catch {
    return job.checkpointsArrived;
  }
}

function step(text: string): void {
  job.steps.push({ ts: nowIso(), phase: job.phase, text: redact(text) });
  console.log(`[shutdown] ${text}`);
}

export function shutdownLogFile(): string {
  return path.join(rootDir(), "logs", "shutdown.log");
}

/**
 * Start the whole shutdown. Returns immediately (spec §2): the heavy part runs in the
 * background of THIS process (pause → checkpoints → snapshot), and the KILLING is handed
 * to the detached ops/shutdown-all.ps1, which stops the router last. Because the router
 * dies, the HTTP reply is sent before the script touches anything (the script waits
 * SHUTDOWN_ROUTER_GRACE_S first).
 */
export function startShutdown(opts: { requestedBy?: string } = {}): ShutdownJobStatus {
  if (job.running) return shutdownJobStatus();
  const id = `sd_${Date.now().toString(36)}`;
  job = {
    id,
    running: true,
    phase: "pausing",
    startedAt: nowIso(),
    checkpointsArrived: 0,
    checkpointsExpected: 0,
    terminals: 0,
    steps: [],
    warnings: [],
  };
  step(`shutdown ${id} started by ${opts.requestedBy ?? "the CEO"}`);
  setPaused(true, `planned shutdown ${id}`);

  void (async () => {
    try {
      job.phase = "checkpointing";
      const snap = await takeSnapshot({
        reason: `planned shutdown ${id}`,
        withCheckpoints: true,
        markPaused: true,
        onProgress: (s) => step(s),
      });
      job.snapshotTs = snap.ts;
      job.snapshotDir = snap.dir;
      job.counts = snap.counts;
      job.checkpointsExpected = snap.terminalFiles.length;
      job.terminals = snap.counts.terminals;
      job.warnings = snap.warnings;
      job.phase = "closing";
      const args = shutdownScriptArgs(snap.dir);
      const pid = await spawnDetachedShutdown(args);
      job.scriptPid = pid;
      job.logFile = shutdownLogFile();
      step(
        `snapshot written; handing over to ops/shutdown-all.ps1 (pid ${pid || "unknown"}) — ` +
          `terminals, opencode workers, test servers, the jcode server, Laya, the supervisor task, then this router`,
      );
      job.running = false;
      job.phase = "done";
      job.finishedAt = nowIso();
    } catch (e) {
      job.running = false;
      job.phase = "error";
      job.error = clip(redact(String(e)), 600);
      job.finishedAt = nowIso();
      step(`shutdown failed: ${job.error}`);
      // The company is paused and nothing was closed: say so loudly in the log.
      try {
        appendShutdownLog(`ERROR: ${job.error} — nothing was closed; new work stays paused until a resume`);
      } catch {
        // log only
      }
    }
  })();

  return shutdownJobStatus();
}

function appendShutdownLog(line: string): void {
  const file = shutdownLogFile();
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `[${nowIso()}] [router] ${redact(line)}\n`);
}

/** The exact arguments the detached script gets, including the test-mode switches. */
function shutdownScriptArgs(snapshot: string): string[] {
  const args = [
    "-Port", String(config.port),
    "-Root", rootDir(),
    "-SnapshotDir", snapshot,
    "-RouterGraceSeconds", String(routerGraceSeconds()),
  ];
  const only = onlySessionsFilter();
  if (only.length) args.push("-OnlySessionIds", only.join(","));
  const skip = skipSwitches();
  // `router` too can be skipped (used by the harness to prove the snapshot/checkpoint half alone).
  for (const name of skip) {
    if (name === "supervisor") args.push("-SkipSupervisor");
    else if (name === "laya") args.push("-SkipLaya");
    else if (name === "jcodeserver" || name === "jcode") args.push("-SkipJcodeServer");
    else if (name === "terminals") args.push("-SkipTerminals");
    else if (name === "router") args.push("-SkipRouter");
    else if (name === "workers") args.push("-SkipWorkers");
  }
  return args;
}

/**
 * Spawn ops/shutdown-all.ps1 so that it OUTLIVES this process (it is the one that kills the
 * router). Two mechanisms were tried on this box:
 *
 *   1. `spawn("powershell.exe", [...], { detached: true, stdio: "ignore" })` - the child
 *      process is created but DOES NOTHING: no stdout, no stderr, not even its own log file
 *      (measured twice). A console-less PowerShell 5.1 started that way never executes the
 *      script, and with stdio ignored the failure is invisible, which is the worst possible
 *      combination for the one script that must run.
 *   2. a short FOREGROUND powershell that calls `Start-Process ... -PassThru`: the shutdown
 *      script becomes an independent process (its parent is the helper, which exits, not
 *      node), returns its pid, and 
 *      is demonstrably not a child of the router - so killing the router cannot take it down
 *      (the same trick FLEET uses to open its worker windows).
 *
 * Mechanism 2 is what this uses. Every argument that contains a space is quoted INSIDE the
 * single -ArgumentList string because Start-Process joins an array with spaces and does not
 * quote elements: with a bare `-Root C:\...\Default Project`, PowerShell received
 * `-Root C:\...\Default` plus a stray `Project`, failed to bind the parameter and exited
 * before its first log line - an invisible failure. The child's stdout/stderr are redirected
 * to logs/shutdown-script.*.log for the same reason: a launch failure must be readable.
 */
async function spawnDetachedShutdown(args: string[]): Promise<number> {
  const script = path.join(rootDir(), "ops", "shutdown-all.ps1");
  if (!fs.existsSync(script)) {
    throw new Error(`ops/shutdown-all.ps1 not found at ${script}`);
  }
  const argLine = [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", winQuote(script),
    ...args.map((a) => (/\s/.test(a) ? winQuote(a) : a)),
  ].join(" ");
  const outLog = path.join(rootDir(), "logs", "shutdown-script.out.log");
  const errLog = path.join(rootDir(), "logs", "shutdown-script.err.log");
  const inner =
    `Start-Process -FilePath 'powershell' -WindowStyle Hidden ` +
    `-ArgumentList ${psQuote(argLine)} ` +
    `-RedirectStandardOutput ${psQuote(outLog)} ` +
    `-RedirectStandardError ${psQuote(errLog)} ` +
    `-WorkingDirectory ${psQuote(rootDir())} -PassThru | Select-Object -ExpandProperty Id`;
  const res = await runCommand("powershell", ["-NoProfile", "-NonInteractive", "-Command", inner], 30_000);
  const pid = Number(res.stdout.trim().split(/\r?\n/).pop() ?? "");
  if (!Number.isFinite(pid) || pid <= 0) {
    throw new Error(
      `could not start ops/shutdown-all.ps1 (${clip(redact(oneLine(res.stderr || res.error || "no pid returned")), 300)}). ` +
        "Run it by hand: powershell -NoProfile -ExecutionPolicy Bypass -File ops/shutdown-all.ps1",
    );
  }
  return pid;
}

/** A Windows command-line quoted argument (used inside the Start-Process argument string). */
function winQuote(s: string): string {
  return `"${String(s).replace(/"/g, '\\"')}"`;
}

// ── resume ───────────────────────────────────────────────────────────────────

export type ResumePlanItem = {
  sessionId: string;
  name: string;
  role: string;
  state: string;
  windowPid?: number;
  checkpoint: boolean;
  /** queued | opening | waiting | delivered | failed | already_running | skipped */
  status: string;
  detail?: string;
  launcher?: string;
};

export type ResumeResult = {
  ok: boolean;
  ts: string;
  startedAt: string;
  finishedAt?: string;
  requested: string[];
  items: ResumePlanItem[];
  queued: string[];
  tasksResumed: string[];
  fleetResumed: string[];
  notes: string[];
};

let resumeJob: ResumeResult | null = null;

export function resumeJobStatus(): ResumeResult | null {
  return resumeJob;
}

/**
 * Resume after a planned shutdown (spec §3). For each selected terminal: open a VISIBLE
 * window running `jcode --resume <sessionId>` (so it keeps its context), wait for it to
 * come alive, then deliver its resumeBrief with a targeted -S send. Staggered (one every
 * ~8s) and bounded by MAX_PARALLEL_SESSIONS and MIN_FREE_RAM_MB; anything over the limit
 * is queued and reported. Then pipeline tasks flagged pausedByShutdown are resumed through
 * RESUME's resumeTask(), and Fleet orders through FLEET's resumeAfterShutdown().
 */
export function startResume(opts: { sessionIds?: string[]; snapshotTs?: string; all?: boolean } = {}): ResumeResult {
  const ts = opts.snapshotTs ?? (resumeJob?.ts || listSnapshots(1)[0]?.ts) ?? "";
  const snap = ts ? readSnapshot(ts) : undefined;
  if (!snap) {
    return {
      ok: false,
      ts,
      startedAt: nowIso(),
      requested: [],
      items: [],
      queued: [],
      tasksResumed: [],
      fleetResumed: [],
      notes: ["no snapshot to resume from"],
    };
  }
  const wanted = new Set(opts.sessionIds ?? []);
  const selected = snap.terminals.filter((t) => (wanted.size ? wanted.has(t.sessionId) : true));
  const result: ResumeResult = {
    ok: true,
    ts,
    startedAt: nowIso(),
    requested: selected.map((t) => t.sessionId),
    items: selected.map((t) => ({
      sessionId: t.sessionId,
      name: t.name,
      role: t.role,
      state: t.state,
      ...(t.windowPid ? { windowPid: t.windowPid } : {}),
      checkpoint: Boolean(t.checkpointPath),
      status: "queued",
    })),
    queued: [],
    tasksResumed: [],
    fleetResumed: [],
    notes: [],
  };
  resumeJob = result;
  setPaused(false, `resume from snapshot ${ts}`);

  void (async () => {
    try {
      // 1. terminals: launch ONE EVERY ~8 s (spec §3) and let each one finish coming alive in
      //    parallel, so 20 terminals do not take 10 minutes. Capacity (MAX_PARALLEL_SESSIONS /
      //    MIN_FREE_RAM_MB) is re-checked per terminal, so a full box queues the rest.
      const pending: Array<Promise<void>> = [];
      for (const item of result.items) {
        const snapT = snap.terminals.find((t) => t.sessionId === item.sessionId);
        if (!snapT) continue;
        if (pending.length) await sleep(resumeStaggerMs());
        pending.push(resumeOneTerminal(item, snapT.resumeBrief, snap.summary.dir, listResumeItems(result), result));
      }
      await Promise.all(pending);

      // 2. pipeline tasks paused by the shutdown → RESUME's own resume path.
      try {
        for (const project of loadOrg().projects) {
          for (const t of loadTasks(project.id)) {
            if (!(t as { pausedByShutdown?: boolean }).pausedByShutdown) continue;
            const ok = resumeTask(project.id, t.id);
            const patched = updateTask(project.id, t.id, { pausedByShutdown: false } as TaskPatch);
            addTrace(project.id, t.id, {
              from: "Router",
              to: "Pipeline",
              what: `resumed at ${patched.status}`,
              detail: `after the planned shutdown (snapshot ${ts}); resumeTask ${ok ? "started" : "found the pipeline already active"}`,
            });
            result.tasksResumed.push(`${project.id}/${t.id}`);
          }
        }
      } catch (e) {
        result.notes.push(`tasks: ${clip(redact(String(e)), 200)}`);
      }

      // 3. Fleet orders → bonehound's resume (adopts the sessions we just brought back).
      try {
        for (const o of loadFleetOrders()) {
          if (!(o as { pausedByShutdown?: boolean }).pausedByShutdown) continue;
          await resumeAfterShutdown(o.id);
          result.fleetResumed.push(o.id);
        }
      } catch (e) {
        result.notes.push(`fleet: ${clip(redact(String(e)), 200)}`);
      }

      // 4. mark the snapshot restored.
      try {
        const idxFile = path.join(snap.summary.dir, "index.json");
        const idx = readJson<IndexFile>(idxFile);
        if (idx) {
          const done = result.items.filter((i) => i.status === "delivered" || i.status === "already_running").length;
          writeJsonAtomic(idxFile, {
            ...idx,
            restoredAt: nowIso(),
            resume: {
              at: nowIso(),
              requested: result.requested.length,
              resumed: done,
              queued: result.queued.length,
              failed: result.items.filter((i) => i.status === "failed").length,
              tasks: result.tasksResumed.length,
              fleetOrders: result.fleetResumed.length,
            },
          });
        }
      } catch (e) {
        result.notes.push(`could not mark the snapshot restored: ${clip(redact(String(e)), 200)}`);
      }
    } catch (e) {
      result.notes.push(`resume failed: ${clip(redact(String(e)), 300)}`);
    } finally {
      if (result.queued.length) {
        result.notes.push(
          `${result.queued.length} terminal(s) are queued (MAX_PARALLEL_SESSIONS=${maxParallelSessions()} or free RAM below ` +
            `MIN_FREE_RAM_MB=${minFreeRamMb()}); POST /company/system/resume {sessionIds:[…]} again to start them.`,
        );
      }
      result.finishedAt = nowIso();
      resumeJob = result;
      console.log(
        `[shutdown] resume from ${ts}: ${result.items.filter((i) => i.status === "delivered").length} delivered, ` +
          `${result.queued.length} queued, ${result.items.filter((i) => i.status === "failed").length} failed, ` +
          `${result.tasksResumed.length} task(s), ${result.fleetResumed.length} fleet order(s)`,
      );
    }
  })();

  return result;
}

function listResumeItems(result: ResumeResult): ResumePlanItem[] {
  return result.items;
}

/**
 * One terminal's whole resume: capacity check, open the visible `jcode --resume` window,
 * wait for it to be alive, hand it its resumeBrief. Any failure is recorded on the item and
 * never stops the other terminals (they run in parallel from startResume).
 */
async function resumeOneTerminal(
  item: ResumePlanItem,
  brief: string,
  snapshotDirAbs: string,
  items: ResumePlanItem[],
  result: ResumeResult,
): Promise<void> {
  try {
    const wait = await waitForCapacity(items);
    if (wait) {
      item.status = "queued";
      item.detail = wait;
      result.queued.push(item.sessionId);
      return;
    }
    const live = liveClientPids(item.sessionId);
    if (live.length) {
      item.status = "already_running";
      item.detail = "this session's TUI is already alive (adopting it)";
    } else {
      const opened = await openResumeWindow(item, snapshotDirAbs);
      if (!opened.ok) {
        item.status = "failed";
        item.detail = opened.detail;
        return;
      }
      item.status = "waiting";
      item.launcher = opened.launcher;
      const alive = await waitForAlive(item.sessionId, resumeAliveMs());
      if (!alive) {
        item.status = "failed";
        item.detail =
          `opened pid ${opened.pid || "?"} but no live jcode client appeared for ${item.sessionId} within ` +
          `${Math.round(resumeAliveMs() / 1000)}s`;
        return;
      }
      item.status = "opening";
    }
    const sent = await sendTerminalMessage(item.sessionId, brief);
    item.status = sent.ok ? "delivered" : "failed";
    item.detail = clip(redact(sent.detail), 300);
  } catch (e) {
    item.status = "failed";
    item.detail = clip(redact(String(e)), 300);
  }
}

/** Slots and RAM: the same two limits the fleet respects before opening a terminal. */
async function waitForCapacity(items: ResumePlanItem[]): Promise<string | null> {
  const running = items.filter((i) => i.status === "waiting" || i.status === "opening" || i.status === "delivered").length
    + (await discoverTerminals()).filter((t) => t.state !== "closed").length;
  const free = Math.round(os.freemem() / 1048576);
  if (running >= maxParallelSessions()) {
    return `not started: ${running} terminals are alive and MAX_PARALLEL_SESSIONS=${maxParallelSessions()}`;
  }
  if (free < minFreeRamMb()) {
    return `not started: ${free} MB free is below MIN_FREE_RAM_MB=${minFreeRamMb()}`;
  }
  return null;
}

/**
 * Open a VISIBLE window running `jcode --resume <sessionId>` (the CEO sees it come back).
 * Same proven mechanics as the fleet's spawn (a generated launcher script + Start-Process
 * with the script path quoted inside one argument string, otherwise a path with a space
 * splits and PowerShell never runs the file).
 */
async function openResumeWindow(
  item: ResumePlanItem,
  snapshotDirAbs: string,
): Promise<{ ok: boolean; pid: number; detail: string; launcher?: string }> {
  const dir = path.join(snapshotDirAbs, "resume");
  ensureDir(dir);
  const launcher = path.join(dir, `${safeFileName(item.name)}.ps1`);
  const bin = jcodeBin();
  const script = [
    "# generated by src/company/lifecycle.ts (planned-shutdown resume)",
    `$Host.UI.RawUI.WindowTitle = '${item.name} (resumed)'`,
    `Set-Location -LiteralPath '${rootDir().replace(/'/g, "''")}'`,
    `& '${bin.replace(/'/g, "''")}' --resume ${item.sessionId}`,
    "",
  ].join("\r\n");
  try {
    fs.writeFileSync(launcher, script);
  } catch (e) {
    return { ok: false, pid: 0, detail: `could not write the launcher: ${clip(redact(String(e)), 200)}` };
  }
  const argLine = `-NoLogo -NoExit -ExecutionPolicy Bypass -File "${launcher}"`;
  const inner =
    `Start-Process -FilePath 'powershell' ` +
    `-ArgumentList ${psQuote(argLine)} ` +
    `-WorkingDirectory ${psQuote(rootDir())} -PassThru | Select-Object -ExpandProperty Id`;
  const res = await runCommand("powershell", ["-NoProfile", "-NonInteractive", "-Command", inner], 30_000);
  const pid = Number(res.stdout.trim().split(/\r?\n/).pop() ?? "");
  if (!Number.isFinite(pid) || pid <= 0) {
    return {
      ok: false,
      pid: 0,
      detail: `Start-Process gave no pid (${clip(redact(oneLine(res.stderr || res.error || "")), 200)})`,
      launcher,
    };
  }
  return { ok: true, pid, detail: `opened window pid ${pid}`, launcher };
}

function psQuote(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}

async function waitForAlive(sessionId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (liveClientPids(sessionId).length > 0) return true;
    await sleep(1500);
  }
  return false;
}

// ── command helper ───────────────────────────────────────────────────────────

function runCommand(cmd: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<typeof execFile> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: { ok: boolean; stdout: string; stderr: string; error?: string }): void => {
      if (settled) return;
      settled = true;
      if (hardTimer) clearTimeout(hardTimer);
      resolve(result);
    };
    hardTimer = setTimeout(() => {
      finish({ ok: false, stdout: "", stderr: "", error: `timed out after ${timeoutMs}ms (child killed)` });
      try { child?.kill("SIGKILL"); } catch { /* already gone */ }
    }, timeoutMs + 2000);
    hardTimer.unref?.();
    try {
      child = execFile(
        cmd,
        args,
        { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => finish({ ok: !err, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), ...(err ? { error: String(err) } : {}) }),
      );
    } catch (e) {
      finish({ ok: false, stdout: "", stderr: "", error: String(e) });
    }
  });
}

// ── what the System page shows for the "did it really close?" question ──────

export type ClosePlan = {
  generatedAt: string;
  terminals: Array<{ sessionId: string; name: string; windowPid?: number; windowName?: string; verified: boolean; detail: string; clientPids: number[] }>;
  opencode: number;
  testServers: number;
  jcodeServerPids: number[];
  layaPids: number[];
  router: { port: number; pid: number };
  supervisorTask: string;
};

/**
 * The list the confirm dialog shows ("exactly what will close"), each terminal re-verified
 * with AUTOCLOSE's own verifyWindow() so the CEO is not promised a close that would be
 * refused (a reused pid, a window that no longer hosts this session, the CEO's own window
 * protected by the registry rules...).
 */
export async function closePlan(): Promise<ClosePlan> {
  const table = await snapshotProcessesAsync(true);
  const terminals = await discoverTerminals({ fresh: true });
  const registry = new Map(safeLoadTerminals().map((r) => [r.sessionId, r] as const));
  const only = onlySessionsFilter();
  const targets = only.length ? terminals.filter((t) => only.includes(t.sessionId) || only.includes(t.name)) : terminals;
  const rows = targets.map((t) => {
    const rec = registry.get(t.sessionId);
    if (rec && t.windowPid) {
      const check = verifyWindow(rec, table, process.pid);
      return {
        sessionId: t.sessionId,
        name: t.name,
        ...(t.windowPid ? { windowPid: t.windowPid } : {}),
        ...(t.windowName ? { windowName: t.windowName } : {}),
        verified: check.ok,
        detail: check.reason,
        clientPids: t.clientPids,
      };
    }
    const win = t.windowPid ? table.get(t.windowPid) : undefined;
    return {
      sessionId: t.sessionId,
      name: t.name,
      ...(t.windowPid ? { windowPid: t.windowPid } : {}),
      ...(t.windowName ? { windowName: t.windowName } : {}),
      verified: Boolean(win),
      detail: win
        ? `${win.name} ${win.pid} hosts client ${t.clientPids[0]} (unregistered: verified from the process table)`
        : "no shell window found for this client (the script closes the client tree instead)",
      clientPids: t.clientPids,
    };
  });
  const laya = [...table.values()]
    .filter((r) => /^python(\.exe)?$/i.test(r.name) && /laya[._-]?serve/i.test(r.cmd))
    .map((r) => r.pid);
  return {
    generatedAt: nowIso(),
    terminals: rows,
    opencode: opencodeRows(table).length,
    testServers: testServerRows(table).length,
    jcodeServerPids: jcodeServerPids(),
    layaPids: laya,
    router: { port: config.port, pid: process.pid },
    supervisorTask: supervisorTaskName(),
  };
}
