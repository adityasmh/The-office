/**
 * Terminal auto-close (docs/AUTOCLOSE_SPEC.md).
 *
 * The CEO's rule: a jcode terminal closes itself when its work is done, but ONLY
 * after it has reported AND the manager has verified the work (a PASS verdict).
 *
 * This module owns:
 *   - the registry `company/terminals.json` (which windows we are allowed to close)
 *   - the guarded reaper loop (`startTerminalReaper`) that runs inside the router
 *   - `registerTerminal()` for the Fleet (FLEET-BACKEND calls it for every window)
 *   - the archive `company/reports/terminals/<sessionName>.md` + `company/reports/terminals.jsonl`
 *
 * HARD SAFETY RULES (from the spec, deliberately fail-closed):
 *   1. Only windows IN THE REGISTRY with spawnedBy "fleet" or "claude-code" are ever closed.
 *      Everything else - the CEO's own window (session rose), the jcode server, the router,
 *      Laya, unknown sessions - is never touched.
 *   2. A close needs verdict === "PASS". Missing / REDO / FAIL = stay open.
 *   3. Before killing, the process is re-verified: the pid must still be the same console
 *      process (command line + creation time), and the session's live jcode client must be a
 *      descendant of it. A reused pid is never killed.
 *   4. Never close while the session is streaming, or while its activity is younger than
 *      AUTOCLOSE_GRACE_S. Archive first, kill second.
 *   5. Never kill the router's OWN process tree: a pid that is `process.pid` or one of its
 *      ancestors (the shell / supervisor window that started the router) is refused, so a
 *      `taskkill /T` from inside the router can never delete the process it runs in.
 *      See ownProcessTree().
 *
 * NON-BLOCKING (REAPER-ASYNC, 2026-09-29): nothing that the router can reach may shell out
 * synchronously. The process table is fetched with an async `execFile` (`snapshotProcessesAsync`) and
 * request paths only ever READ the cached table (`cachedProcesses()`); `taskkill` goes through the
 * same async helper. This module contains no `execFileSync` at all. `runReaperPass()` keeps its
 * synchronous signature for `src/server.ts` (POST /company/terminals/reap does not await it) and
 * only PROJECTS what a pass would do; `runReaperPassAsync()` is the pass that really runs (router
 * loop, ops CLI), with a re-entrancy guard so two passes never overlap.
 *
 * KNOWN FACT about this install (the spec's backfill recipe is wrong here): `active_pids/<id>`
 * holds the SHARED SERVER pid, not a client pid. The real `sessionId -> client pid` map is
 * `client_sessions/<pid>` (file content = session id). See resolveWindow().
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { getCompanyRoot } from "./org.js";
// Attribution only (fix 3 of the 2026-10-01 event-loop order): labels the registry save.
import { withBusyAsync } from "./loopWatchdog.js";

// ── registry types (agreed with REPORTING + FLEET-BACKEND in the coordination log) ──

export type TerminalState = "working" | "reported" | "redo" | "failed" | "needs_ceo" | "closed" | "kept";
export type SpawnedBy = "fleet" | "claude-code" | "ceo" | "unknown";
export type Verdict = "PASS" | "REDO" | "FAIL";

export type TerminalRec = {
  sessionId: string;
  sessionName: string;
  role: string;
  /** the powershell.exe/cmd.exe window that hosts the TUI (what we kill, with its tree) */
  windowPid?: number;
  /** the jcode.exe TUI client inside that window (from client_sessions/<pid>) */
  clientPid?: number;
  /** creation time of windowPid as ISO; guards against pid reuse */
  windowCreatedAt?: string;
  spawnedBy: SpawnedBy;
  spawnedAt: string;
  state: TerminalState;
  stateReason?: string;
  keepOpen?: boolean;
  verdict?: Verdict;
  verdictReason?: string;
  verifiedAt?: string;
  verdictSource?: string;
  /** report file the worker wrote (Fleet: company/fleet/<order>/<wo>/REPORT.md) */
  reportPath?: string;
  archive?: string;
  closedAt?: string;
  closedReason?: string;
  closedPids?: number[];
  lastCheckedAt?: string;
  lastDecision?: string;
  /** registered by backfillToday() rather than by a spawner */
  backfilled?: boolean;
};

export type RegisterInput = {
  sessionId: string;
  sessionName?: string;
  role?: string;
  windowPid?: number;
  clientPid?: number;
  spawnedBy?: SpawnedBy;
  spawnedAt?: string;
  state?: TerminalState;
  keepOpen?: boolean;
  reportPath?: string;
};

/** Sessions that are NEVER closed, whatever the registry says (defence in depth). */
export const PROTECTED_SESSION_NAMES = ["rose"];

const CLOSABLE_SPAWNERS: SpawnedBy[] = ["fleet", "claude-code"];
const WINDOW_PROCESS = /^(powershell|pwsh|cmd)\.exe$/i;

// ── knobs ──────────────────────────────────────────────────────────────

function envNum(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export function autocloseEnabled(): boolean {
  return process.env.AUTOCLOSE !== "0";
}
export function autocloseDryRun(): boolean {
  return process.env.AUTOCLOSE_DRY_RUN === "1";
}
export function graceMs(): number {
  return envNum("AUTOCLOSE_GRACE_S", 60) * 1000;
}
export function intervalMs(): number {
  return envNum("AUTOCLOSE_INTERVAL_MS", 30_000);
}

// ── small fs/pid helpers ───────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function readTrimmed(file: string): string {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
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

function parseTime(value: unknown): number | undefined {
  if (typeof value !== "string" || !value) return undefined;
  // journals carry nanosecond precision; trim to milliseconds before Date.parse
  const trimmed = value.replace(/(\.\d{3})\d+/, "$1");
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : undefined;
}

function fileMtimeMs(file: string): number | undefined {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

// LOOP-LAG (2026-10-01): serialised async writer queue so the terminals.json tmp write +
// rename never blocks the event loop. The busy label still names the BLOCK line.
let terminalsWriteQueue: Promise<void> = Promise.resolve();

async function doWriteFileAtomic(file: string, text: string): Promise<void> {
  await withBusyAsync("reaper registry save", async () => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    await fs.promises.writeFile(tmp, text);
    await fs.promises.rename(tmp, file);
  });
}

function writeFileAtomic(file: string, text: string): void {
  terminalsWriteQueue = terminalsWriteQueue.then(() => doWriteFileAtomic(file, text)).catch((e) => {
    console.warn(`[autoclose] registry save failed (${String(e).slice(0, 120)})`);
  });
}

// ── jcode session state (READ-ONLY) ────────────────────────────────────

export function jcodeHome(): string {
  return path.join(os.homedir(), ".jcode");
}
function sessionsDir(): string {
  return path.join(jcodeHome(), "sessions");
}
function clientSessionsDir(): string {
  return path.join(jcodeHome(), "client_sessions");
}
function streamingPidsDir(): string {
  return path.join(jcodeHome(), "streaming_pids");
}

export function isStreaming(sessionId: string): boolean {
  try {
    return fs.existsSync(path.join(streamingPidsDir(), sessionId));
  } catch {
    return false;
  }
}

/**
 * All LIVE client pids for a session, from `client_sessions/<pid>` (whose content is the
 * session id). Those files are not removed when a window closes, so liveness is checked here;
 * one session can have several live clients (reconnects), so every live one counts.
 */
export function liveClientPids(sessionId: string): number[] {
  if (!sessionId) return [];
  const out: number[] = [];
  for (const pid of clientSessionIndex().get(sessionId) ?? []) {
    if (pidAlive(pid)) out.push(pid);
  }
  return out;
}

/** How long the `client_sessions` scan is reused (see clientSessionIndex). */
const CLIENT_SESSION_INDEX_TTL_MS = 1000;
let clientSessionIndexCache: { at: number; bySession: Map<string, number[]> } | undefined;

/**
 * sessionId -> every client pid jcode recorded in `client_sessions/<pid>`; DEAD entries included on
 * purpose (a dead entry is exactly the proof verifyWindow's two-tier link uses).
 *
 * The whole directory is scanned at most once per second instead of once per record per caller. It has
 * ~50 entries here and BOTH listTerminals() and verifyWindow() ask for it about twice per record, which
 * is ~3.2ms a call - measured as the top remaining synchronous block in this module (~250ms of the
 * router's loop per route call and per reaper pass, on top of the run-card scan PERF-BACKEND profiled).
 * Liveness is still decided per pid, per call, by liveClientPids(), so a cached scan can never make a
 * dead client look alive - it can only miss a client that appeared within the last second (which is the
 * safe direction: no live client means "not closable", and the registration paths drop this cache first).
 */
function clientSessionIndex(): Map<string, number[]> {
  const now = Date.now();
  if (clientSessionIndexCache && now - clientSessionIndexCache.at < CLIENT_SESSION_INDEX_TTL_MS) {
    return clientSessionIndexCache.bySession;
  }
  const bySession = new Map<string, number[]>();
  let names: string[] = [];
  try {
    names = fs.readdirSync(clientSessionsDir());
  } catch {
    names = [];
  }
  for (const name of names) {
    const pid = Number(name);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    const sessionId = readTrimmed(path.join(clientSessionsDir(), name));
    if (!sessionId) continue;
    const seen = bySession.get(sessionId);
    if (seen) seen.push(pid);
    else bySession.set(sessionId, [pid]);
  }
  clientSessionIndexCache = { at: now, bySession };
  return bySession;
}

/** Drop the client_sessions scan: the registration/backfill paths need the exact, current view. */
function forgetClientSessions(): void {
  clientSessionIndexCache = undefined;
}

export type SessionMeta = {
  sessionId: string;
  name: string;
  workingDir: string;
  lastActiveAt?: string;
  title?: string;
  journal?: string;
};

/** The first `maxBytes` of a file as text ("" when unreadable). */
function readHead(file: string, maxBytes: number): string {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.toString("utf8", 0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function metaFromFirstLine(head: string): { name: string; workingDir: string; lastActiveAt?: string; title?: string } | undefined {
  const firstLine = head.split("\n")[0];
  try {
    const rec = JSON.parse(firstLine) as { meta?: Record<string, unknown> };
    const meta = rec.meta ?? {};
    return {
      name: typeof meta.short_name === "string" ? meta.short_name : "",
      workingDir: typeof meta.working_dir === "string" ? meta.working_dir : "",
      lastActiveAt: typeof meta.last_active_at === "string" ? meta.last_active_at : undefined,
      title: typeof meta.title === "string" ? meta.title : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * How long a cached session's meta is reused WITHOUT a stat (unchanged from the pre-perf revision, so
 * the stat rate can never go up). Past the TTL the journal mtime decides: same mtime -> reuse, changed
 * mtime -> one bounded re-read. See sessionMeta.
 */
const SESSION_META_TTL_MS = 5000;
/** The journal head parsed first; the ONE bounded retry used only when the first line is truncated. */
const SESSION_META_HEAD_BYTES = 64 * 1024;
const SESSION_META_HEAD_RETRY_BYTES = 256 * 1024;
const sessionMetaCache = new Map<string, { journal: string; mtime: number; at: number; meta?: SessionMeta }>();

/**
 * The journal's first record: short name, working dir, last activity, title.
 *
 * The first LINE contains the whole first user message (a Fleet work order can be 60KB+), so it does
 * not always fit in one read: session `dove` has a 63,688-char first line, which made the small read
 * fail to parse and left the session nameless ("unknown", never closable) and its idle time unknown.
 * So: read a small head, retry ONCE with a bounded bigger one (256KB, never megabytes), and as a last
 * resort pull the fields we need out of the raw prefix - the meta block starts the record, so they are
 * always reachable from the head we already have.
 *
 * MEMOIZED and mtime-keyed: a pass and GET /company/terminals both ask this for every record, so an
 * uncached call meant one 64KB (worst case 4MB) journal read per record per pass - PERF-BACKEND
 * measured the whole per-record file work at ~200ms per route call and rhino measured 0.24-0.73s cold,
 * 15.6-27s under I/O contention. The cache entry is per session and is reused while the journal's
 * mtime is unchanged (so an appended journal always re-reads) or for SESSION_META_TTL_MS without even
 * a stat, whichever is shorter. The only field that can ever be stale is `lastActiveAt`, and
 * sessionActivityMs() still stats the journal exactly, so a close decision is never based on a stale
 * activity stamp alone (grace is 60s). The 4MB fallback read is GONE: it was the source of the ~180MB
 * of synchronous reads per route call.
 */
export function sessionMeta(sessionId: string): SessionMeta | undefined {
  const journal = path.join(sessionsDir(), `${sessionId}.journal.jsonl`);
  const hit = sessionMetaCache.get(sessionId);
  if (hit && hit.journal === journal && Date.now() - hit.at < SESSION_META_TTL_MS) return hit.meta;
  const mtime = fileMtimeMs(journal);
  if (mtime === undefined) {
    // NEGATIVE memo (mtime -1): most registry records are already-closed sessions whose journal is
    // gone, so a pass / GET /company/terminals asks for them too. Remembering "no journal" for the TTL
    // keeps that at ONE stat per record per TTL instead of one per record per call.
    if (sessionMetaCache.size > 500) sessionMetaCache.clear();
    sessionMetaCache.set(sessionId, { journal, mtime: -1, at: Date.now(), meta: undefined });
    return undefined;
  }
  if (hit && hit.journal === journal && hit.mtime === mtime) {
    hit.at = Date.now();
    return hit.meta;
  }
  const meta = readSessionMeta(sessionId);
  if (sessionMetaCache.size > 500) sessionMetaCache.clear();
  sessionMetaCache.set(sessionId, { journal, mtime, at: Date.now(), meta });
  return meta;
}

function readSessionMeta(sessionId: string): SessionMeta | undefined {
  const journal = path.join(sessionsDir(), `${sessionId}.journal.jsonl`);
  const head = readHead(journal, SESSION_META_HEAD_BYTES);
  if (!head) return undefined;
  let fields = metaFromFirstLine(head);
  // A head without a newline is the ONE case where a bigger read can help (the first line was cut off
  // mid-record, e.g. `dove`'s 63,688-char work order). Bounded at 256KB on purpose: the old code read
  // up to 4MB here, which is what made 45 records cost up to 180MB of synchronous reads.
  if (!fields && !head.includes("\n")) fields = metaFromFirstLine(readHead(journal, SESSION_META_HEAD_RETRY_BYTES));
  if (!fields) {
    const grab = (key: string): string => {
      const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(head);
      return m ? m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\") : "";
    };
    // The meta block opens the record, so all four fields are inside the head even when the first
    // line's 60KB+ work order keeps the whole record from ever parsing.
    fields = {
      name: grab("short_name"),
      workingDir: grab("working_dir"),
      lastActiveAt: grab("last_active_at") || undefined,
      title: grab("title") || undefined,
    };
    if (!fields.name && !fields.workingDir) return undefined;
  }
  return { sessionId, journal, ...fields };
}

/** Newest known activity for a session (journal mtime vs the meta timestamps). */
export function sessionActivityMs(sessionId: string): number | undefined {
  const meta = sessionMeta(sessionId);
  const stamp = Math.max(
    fileMtimeMs(path.join(sessionsDir(), `${sessionId}.journal.jsonl`)) ?? 0,
    fileMtimeMs(path.join(sessionsDir(), `${sessionId}.json`)) ?? 0,
    parseTime(meta?.lastActiveAt) ?? 0,
  );
  return stamp > 0 ? stamp : undefined;
}

/** How many distinct journal tails the per-pass memo keeps before it is dropped wholesale. */
const TAIL_MEMO_MAX_ENTRIES = 200;
/**
 * Per-pass memo for journalTextTail, keyed by journal path + the read parameters. One reaper pass
 * archives several terminals and can build the same terminal's archive twice (plan/reconcile), so the
 * uncached version re-read and re-parsed the same journal - up to 4MB each and ~2.6MB per burst of 12
 * journals - N times per pass. An entry is reused only while the journal's mtime AND size are
 * unchanged, so an appended or rewritten journal always re-reads; the map is cleared at the start of
 * every pass (resetTailMemo) so it can never grow with the session count.
 */
const tailMemo = new Map<string, { mtime: number; size: number; lines: string[] }>();

/** Drop the per-pass journal-tail memo; called at the start of every reaper pass. */
function resetTailMemo(): void {
  if (tailMemo.size) tailMemo.clear();
}

/** The last `maxLines` readable lines of a session's journal text (for the archive). */
export function journalTextTail(sessionId: string, maxLines = 200, maxBytes = 4 * 1024 * 1024): string[] {
  const journal = path.join(sessionsDir(), `${sessionId}.journal.jsonl`);
  const memoKey = `${journal}\u0000${maxLines}\u0000${maxBytes}`;
  let size: number;
  let mtime: number;
  try {
    const st = fs.statSync(journal);
    size = st.size;
    mtime = st.mtimeMs;
  } catch {
    tailMemo.delete(memoKey);
    return [];
  }
  const memo = tailMemo.get(memoKey);
  if (memo && memo.mtime === mtime && memo.size === size) return memo.lines;
  let raw = "";
  try {
    if (size <= maxBytes) {
      raw = fs.readFileSync(journal, "utf8");
    } else {
      const fd = fs.openSync(journal, "r");
      try {
        const buf = Buffer.alloc(maxBytes);
        const n = fs.readSync(fd, buf, 0, buf.length, size - maxBytes);
        raw = buf.toString("utf8", 0, n);
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    return [];
  }
  const lines: string[] = [];
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let rec: {
      meta?: { updated_at?: string };
      append_messages?: Array<{ role?: string; content?: Array<{ type?: string; text?: string; name?: string }> }>;
    };
    try {
      rec = JSON.parse(line) as typeof rec;
    } catch {
      continue;
    }
    for (const m of rec.append_messages ?? []) {
      const who = m.role === "user" ? "user" : m.role === "assistant" ? "agent" : m.role ?? "?";
      for (const c of m.content ?? []) {
        if (c.type === "text" && c.text) {
          for (const textLine of c.text.split("\n")) {
            const t = textLine.trim();
            if (t) lines.push(`${who}: ${t.slice(0, 300)}`);
          }
        } else if (c.type === "tool_use") {
          lines.push(`${who} -> tool ${c.name ?? "?"}`);
        } else if (c.type === "tool_result") {
          lines.push(`${who} <- tool result`);
        }
      }
    }
  }
  const tail = lines.slice(-maxLines);
  if (tailMemo.size > TAIL_MEMO_MAX_ENTRIES) tailMemo.clear();
  tailMemo.set(memoKey, { mtime, size, lines: tail });
  return tail;
}

// ── windows / processes (READ-ONLY) ────────────────────────────────────

export type ProcRow = { pid: number; ppid: number; name: string; cmd: string; created: string };
export type ProcMap = Map<number, ProcRow>;

// NOTE: `[Console]::OutputEncoding = UTF8` is required. Without it, PowerShell writes the
// JSON through the console code page and a non-ASCII character in any CommandLine corrupts
// it (real failure seen: "Expected ',' or '}' after property value in JSON at position 122649"),
// which silently emptied the table and made every window unverifiable.
const PS_LIST_PROCS =
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8; " +
  "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine," +
  "@{n='Created';e={if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }}} | " +
  "ConvertTo-Json -Compress";

let procCache: { at: number; map: ProcMap } | undefined;
/** the refresh that is currently running (single-flight: the router must never stack PowerShell calls) */
let procRefresh: Promise<ProcMap> | undefined;
let procRefreshSeq = 0;

// CIRCUIT BREAKER (2026-09-30, incident: /v2/ unloadable).
// On this box `Get-CimInstance Win32_Process` now takes LONGER than its own timeout when
// the machine is loaded, so every pass spawned a PowerShell child that lived for the full
// timeout and was then killed. Measured on the live router: 23 powershell.exe alive at
// once, and 33 `process table unavailable ... timed out after 20000ms (child killed)`
// lines in a single error log, while the dashboard was down. The reaper fails CLOSED when
// the table is unavailable (it closes nothing), so backing off costs no safety and removes
// both the WMI contention and the child-process churn that was starving this process.
let procFailStreak = 0;
let procCooldownUntil = 0;
/** consecutive failures before we stop asking for a while */
const PROC_FAILS_BEFORE_TRIP = 2;
/** how long to leave WMI alone once the breaker trips */
const PROC_COOLDOWN_MS = 5 * 60_000;
/**
 * Timeout for the process-table query. The healthy cost is ~0.5-5 s (see the note above),
 * so 20 s only ever bought us a long-lived hung child; 10 s still has 2x headroom.
 */
const PROC_PS_TIMEOUT_MS = 10_000;

/** How stale a cached process table may be before a REQUEST path kicks a background refresh. */
const PROC_STALE_MS = 30_000;
/**
 * How old the process table may be for a pass to ACT on it. Every safety rule is verified against
 * that table (same creation time, a live client inside the window, a reused pid), so an older table
 * makes a pass close nothing: fail closed, never guess.
 */
const PROC_TABLE_MAX_AGE_MS = 60_000;

function parseProcTable(out: string): ProcMap {
  const map: ProcMap = new Map();
  try {
    const parsed = JSON.parse(out.trim() || "[]") as unknown;
    const rows = (Array.isArray(parsed) ? parsed : [parsed]) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const pid = Number(row.ProcessId);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      map.set(pid, {
        pid,
        ppid: Number(row.ParentProcessId) || 0,
        name: String(row.Name ?? ""),
        cmd: String(row.CommandLine ?? ""),
        created: String(row.Created ?? ""),
      });
    }
  } catch (e) {
    console.error(`[autoclose] could not parse the process table: ${String(e)}`);
  }
  return map;
}

type CmdResult = { ok: boolean; stdout: string; stderr: string; error?: string };

/**
 * Promise wrapper around `execFile`: NEVER blocks the event loop, always settles, and hard-kills the
 * child after `timeoutMs` (execFile's own `timeout` is the first line of defence, this timer is the
 * backstop for a child that ignores it). `windowsHide` keeps the console window hidden, as before.
 */
function runCommand(cmd: string, args: string[], timeoutMs: number): Promise<CmdResult> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<typeof execFile> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: CmdResult): void => {
      if (settled) return;
      settled = true;
      if (hardTimer) clearTimeout(hardTimer);
      resolve(result);
    };
    hardTimer = setTimeout(() => {
      finish({ ok: false, stdout: "", stderr: "", error: `timed out after ${timeoutMs}ms (child killed)` });
      try {
        child?.kill("SIGKILL");
      } catch {
        // the child is already gone
      }
    }, timeoutMs + 2000);
    hardTimer.unref?.();
    try {
      child = execFile(
        cmd,
        args,
        { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          finish({
            ok: !err,
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
            error: err ? String(err) : undefined,
          });
        },
      );
    } catch (e) {
      finish({ ok: false, stdout: "", stderr: "", error: String(e) });
    }
  });
}

export type ProcessTableInfo = {
  rows: number;
  ageMs?: number;
  loadedAt?: string;
  refreshing: boolean;
  /** rows > 0 AND fetched within PROC_TABLE_MAX_AGE_MS: a pass may act on this table */
  ready: boolean;
};

/** Freshness of the cached process table (reaperStatus, ops --status, the selftest). */
export function processTableStatus(): ProcessTableInfo {
  const ageMs = procCache ? Date.now() - procCache.at : undefined;
  const rows = procCache?.map.size ?? 0;
  return {
    rows,
    ageMs,
    loadedAt: procCache ? new Date(procCache.at).toISOString() : undefined,
    refreshing: Boolean(procRefresh),
    ready: rows > 0 && ageMs !== undefined && ageMs <= PROC_TABLE_MAX_AGE_MS,
  };
}

/**
 * The process table WITHOUT ever blocking the caller. This is what every router-reachable path uses:
 * it hands back whatever is cached (empty until the first refresh lands) and kicks a background
 * refresh when that cache is missing or older than PROC_STALE_MS. Nothing here spawns a process on
 * the caller's stack - `execFileSync` in this module used to freeze every other HTTP request for
 * 1.8-5s on this laptop (measured: `GET /company/terminals` 1.77s, and again on every pass).
 */
export function cachedProcesses(): ProcMap {
  if (!procCache || Date.now() - procCache.at > PROC_STALE_MS) void snapshotProcessesAsync(false);
  return procCache?.map ?? new Map<number, ProcRow>();
}

/** Kept for callers that knew the old name: the same non-blocking cache read as cachedProcesses(). */
export function snapshotProcesses(_force = false): ProcMap {
  return cachedProcesses();
}

/**
 * Fetch the whole process table with an ASYNC `execFile` (20s timeout, hidden window) and the
 * `[Console]::OutputEncoding = UTF8` fix, without which a non-ASCII CommandLine corrupts the JSON.
 * Single-flight: concurrent callers share one PowerShell. On failure it logs loudly and returns the
 * PREVIOUS table (or an empty one), so callers must check processTableStatus() rather than trust it.
 * `force` asks for a genuinely new table; it still joins a refresh that is already in flight.
 */
export function snapshotProcessesAsync(force = false): Promise<ProcMap> {
  if (procRefresh) return procRefresh;
  if (!force && procCache && Date.now() - procCache.at < 2000) return Promise.resolve(procCache.map);
  // Breaker open: do not spawn another PowerShell. Callers fail closed (nothing is closed).
  if (!force && Date.now() < procCooldownUntil) return Promise.resolve(procCache?.map ?? new Map<number, ProcRow>());
  const started = Date.now();
  const seq = ++procRefreshSeq;
  const flight = runCommand("powershell", ["-NoProfile", "-NonInteractive", "-Command", PS_LIST_PROCS], PROC_PS_TIMEOUT_MS).then(
    (res) => {
      if (!res.ok) {
        // No process table: nothing can be verified, so nothing will be closed this pass.
        // Loud on purpose - a silent empty table would make every terminal look unclosable.
        procFailStreak++;
        const why = `${res.error ?? res.stderr.trim()}`;
        if (procFailStreak >= PROC_FAILS_BEFORE_TRIP) {
          procCooldownUntil = Date.now() + PROC_COOLDOWN_MS;
          console.error(
            `[autoclose] process table unavailable (nothing will be closed): ${why}; ` +
              `backing off ${Math.round(PROC_COOLDOWN_MS / 60_000)} min after ${procFailStreak} consecutive failures ` +
              `(WMI is contended; nothing is closed while the table is stale)`,
          );
          procFailStreak = 0;
        } else {
          console.error(`[autoclose] process table unavailable (nothing will be closed): ${why}`);
        }
        return procCache?.map ?? new Map<number, ProcRow>();
      }
      procFailStreak = 0;
      procCooldownUntil = 0;
      const map = parseProcTable(res.stdout);
      if (map.size > 0) procCache = { at: started, map };
      else console.error("[autoclose] process table came back EMPTY (nothing will be closed this pass)");
      return procCache?.map ?? new Map<number, ProcRow>();
    },
  );
  procRefresh = flight;
  const clear = (): void => {
    if (procRefreshSeq === seq) procRefresh = undefined;
  };
  void flight.then(clear, clear);
  return flight;
}

function ancestorChain(pid: number, procs: ProcMap, maxDepth = 10): number[] {
  const chain: number[] = [];
  let cur = pid;
  for (let i = 0; i < maxDepth; i++) {
    const row = procs.get(cur);
    if (!row || !row.ppid || row.ppid === cur) break;
    chain.push(row.ppid);
    cur = row.ppid;
  }
  return chain;
}

/**
 * The pids that must NEVER be killed from inside this process: `selfPid` itself plus its ancestors.
 * The router is started by a supervisor shell/cmd window, so a `taskkill /T` aimed at a pid in this
 * set (or at one of its children) can take the router - and the control plane with it - down.
 * Everything else in a pass is verified against the process table; this rule needs no table to be
 * safe when the table is unavailable.
 */
export function ownProcessTree(procs?: ProcMap, selfPid: number = process.pid): Set<number> {
  const tree = new Set<number>([selfPid]);
  if (procs) for (const pid of ancestorChain(selfPid, procs)) tree.add(pid);
  return tree;
}

export type WindowInfo = {
  sessionId: string;
  clientPid: number;
  windowPid: number;
  windowName: string;
  windowCmd: string;
  windowCreatedAt: string;
};

/**
 * Walk from the session's live jcode client up to the console process that hosts it.
 * This replaces the spec's `active_pids/<id>` recipe, which returns the shared server pid
 * on this install and would identify nothing.
 */
export function resolveWindow(sessionId: string, procs?: ProcMap): WindowInfo | undefined {
  const table = procs ?? cachedProcesses();
  for (const clientPid of liveClientPids(sessionId)) {
    const client = table.get(clientPid);
    if (!client) continue;
    if (!/jcode/i.test(client.name) && !/jcode/i.test(client.cmd)) continue;
    for (const pid of ancestorChain(clientPid, table)) {
      const row = table.get(pid);
      if (!row) continue;
      if (WINDOW_PROCESS.test(row.name)) {
        return {
          sessionId,
          clientPid,
          windowPid: row.pid,
          windowName: row.name,
          windowCmd: row.cmd,
          windowCreatedAt: row.created,
        };
      }
    }
  }
  return undefined;
}

/** Memo for jcodeServerPids() (verifyWindow asks once per record). */
const JCODE_SERVER_PIDS_TTL_MS = 2000;
let jcodeServerPidsCache: { at: number; pids: number[] } | undefined;

/**
 * The jcode SERVER pids (never a close target) from ~/.jcode/servers.json, memoized for 2s: this is
 * read once per record by verifyWindow(), i.e. dozens of times per pass and per route call.
 */
function jcodeServerPids(): number[] {
  const now = Date.now();
  if (jcodeServerPidsCache && now - jcodeServerPidsCache.at < JCODE_SERVER_PIDS_TTL_MS) return jcodeServerPidsCache.pids;
  const raw = readTrimmed(path.join(jcodeHome(), "servers.json"));
  let pids: number[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, { pid?: unknown }>;
      pids = Object.values(parsed)
        .map((s) => Number(s?.pid))
        .filter((p) => Number.isFinite(p) && p > 0);
    } catch {
      pids = [];
    }
  }
  jcodeServerPidsCache = { at: now, pids };
  return pids;
}

/**
 * Which session a client pid was recorded as, from `client_sessions/<pid>`. Read even when the pid
 * is now dead: those files are the client history, and a dead entry is exactly what proves that a
 * re-exec'd TUI's parent was this same session's client.
 */
function clientSessionOf(pid: number): string {
  if (!Number.isFinite(pid) || pid <= 0) return "";
  for (const [sessionId, pids] of clientSessionIndex()) if (pids.includes(pid)) return sessionId;
  return "";
}

/**
 * Proof used at REGISTRATION time (and by the selftest): does this window really host a live client
 * of this session? This is what makes the registry a verified allow-list instead of a list of pids
 * someone typed: registerTerminal() only records a windowPid that passes this.
 */
export function windowHostsSession(
  sessionId: string,
  windowPid: number,
  procs?: ProcMap,
): { ok: boolean; reason: string } {
  const table = procs ?? cachedProcesses();
  const row = table.get(windowPid);
  if (!row) return { ok: false, reason: `window pid ${windowPid} is not running` };
  if (!WINDOW_PROCESS.test(row.name)) {
    return { ok: false, reason: `pid ${windowPid} is ${row.name || "unknown"}, not a shell window` };
  }
  const clients = liveClientPids(sessionId);
  if (clients.length === 0) return { ok: false, reason: `no live client for ${sessionId}` };
  const inside = clients.find((pid) => ancestorChain(pid, table).includes(windowPid));
  if (inside === undefined) {
    return { ok: false, reason: `no live client of ${sessionId} runs inside window ${windowPid}` };
  }
  return { ok: true, reason: `client ${inside} runs inside ${row.name} ${windowPid}` };
}

export type WindowCheck = {
  ok: boolean;
  reason: string;
  /** "descendant" = live proof; "client-chain" = the client re-exec'd (see below) */
  link?: "descendant" | "client-chain";
  window?: ProcRow;
  client?: ProcRow;
};

/**
 * Re-verify a recorded window just before killing it: same process (name + creation time),
 * a console window, not a jcode server, and the session's client is inside it.
 *
 * Two links are accepted, because the jcode TUI RE-EXECS when the CLI updates itself (seen on
 * this laptop at 13:21Z: every session's client pid changed at once). The re-exec'd TUI becomes
 * a child of the pid it replaced, which then exits, so the live client is no longer a descendant
 * of the window and `taskkill /T` on the window cannot reach it any more:
 *   1. "descendant"   - a live client of this session is a descendant of the window (the normal case).
 *   2. "client-chain" - the ancestry walk from a live client ends at a DEAD pid that
 *      `client_sessions/<pid>` still reports as THIS session, i.e. the walk is a straight line of
 *      this session's own clients. The window itself is only trusted because registerTerminal/
 *      backfill recorded the pair after proving that exact ancestry, and the window must still be
 *      the same process (name + creation time) as the one recorded.
 * Anything else is refused.
 *
 * It also refuses the router's own process tree (this pid and its ancestors) - see ownProcessTree().
 */
export function verifyWindow(rec: TerminalRec, procs?: ProcMap, selfPid: number = process.pid): WindowCheck {
  if (!rec.windowPid) return { ok: false, reason: "no windowPid recorded (nothing verifiable to close)" };
  const table = procs ?? cachedProcesses();
  // RULE 5: never kill this process or anything above it. `taskkill /T /F` on the supervisor's
  // window (a real ancestor of the router) is exactly how a router kills itself.
  if (ownProcessTree(table, selfPid).has(rec.windowPid)) {
    return {
      ok: false,
      reason:
        rec.windowPid === selfPid
          ? `refused: pid ${rec.windowPid} is this process (never killed)`
          : `refused: pid ${rec.windowPid} is an ancestor of this process, i.e. inside the router's own tree (never killed)`,
    };
  }
  const row = table.get(rec.windowPid);
  if (!row) return { ok: false, reason: `window pid ${rec.windowPid} is not running` };
  if (!WINDOW_PROCESS.test(row.name)) {
    return { ok: false, reason: `pid ${rec.windowPid} is ${row.name || "unknown"}, not a shell window` };
  }
  if (jcodeServerPids().includes(rec.windowPid)) {
    return { ok: false, reason: `pid ${rec.windowPid} is the jcode server, refusing` };
  }
  if (rec.windowCreatedAt && row.created) {
    const a = parseTime(rec.windowCreatedAt);
    const b = parseTime(row.created);
    if (a !== undefined && b !== undefined && Math.abs(a - b) > 2000) {
      return { ok: false, reason: `pid ${rec.windowPid} was reused (created ${row.created}, registry ${rec.windowCreatedAt})` };
    }
  }
  const clientPids = liveClientPids(rec.sessionId);
  if (clientPids.length === 0) {
    return { ok: false, reason: "no live jcode client for this session (window already gone)" };
  }
  const strong = clientPids.find((pid) => ancestorChain(pid, table).includes(rec.windowPid as number));
  if (strong !== undefined) {
    return {
      ok: true,
      link: "descendant",
      reason: `verified: ${row.name} ${rec.windowPid} hosts client ${strong}`,
      window: row,
      client: table.get(strong),
    };
  }
  for (const pid of clientPids) {
    const chain = ancestorChain(pid, table);
    if (!chain.length) continue;
    const tail = chain[chain.length - 1];
    const tailIsThisSession = clientSessionOf(tail) === rec.sessionId;
    // The recorded client must also belong to this session: that pid is the one whose ancestry
    // inside this window was PROVEN when the record was written (registerTerminal/windowHostsSession),
    // so it is the link between an orphaned live client and the window.
    const recordedClientIsThisSession = Boolean(rec.clientPid) && clientSessionOf(rec.clientPid as number) === rec.sessionId;
    if (!table.has(tail) && tailIsThisSession && recordedClientIsThisSession) {
      return {
        ok: true,
        link: "client-chain",
        reason:
          `verified: ${row.name} ${rec.windowPid} is the window this session was registered in (recorded client ${rec.clientPid});` +
          ` its TUI re-exec'd (live client ${pid}, chain via dead client ${tail})`,
        window: row,
        client: table.get(pid),
      };
    }
  }
  return {
    ok: false,
    reason: `no live client of ${rec.sessionId} is linked to window ${rec.windowPid}`,
  };
}

// ── the registry ───────────────────────────────────────────────────────

export function registryFile(): string {
  return path.join(getCompanyRoot(), "terminals.json");
}

/**
 * A cheap identity for a file: size + mtime. Used as a cache key for data that changes rarely, so a
 * reader can tell "nothing changed" without reading and parsing the whole file again.
 * The reaper deliberately keeps this helper local: no cross-module import on the router's hot path.
 */
function statSig(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {
    return "missing";
  }
}

/**
 * The registry, parsed. MEMOIZED on the file's size+mtime (PERF-BACKEND measured a live pass where the
 * registry read showed up as >1s of blocked event loop: this file is 35KB but the box is I/O-starved, and
 * a pass reads it several times). `saveTerminals()` invalidates the memo, and a caller always gets fresh
 * copies, so a caller that mutates records (repairArchives, reattributeUnknowns) cannot poison the cache.
 */
let registryCache: { sig: string; list: TerminalRec[] } | undefined;

export function loadTerminals(): TerminalRec[] {
  const file = registryFile();
  const sig = statSig(file);
  if (registryCache && registryCache.sig === sig) return registryCache.list.map((r) => ({ ...r }));
  let list: TerminalRec[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    const rawList = Array.isArray(parsed) ? parsed : ((parsed as { terminals?: unknown })?.terminals ?? []);
    if (!Array.isArray(rawList)) return [];
    list = (rawList as TerminalRec[]).filter((r) => r && typeof r.sessionId === "string" && r.sessionId.length > 0);
  } catch {
    // a failed/partial read is never cached: the next call tries again
    return [];
  }
  registryCache = { sig, list };
  return list.map((r) => ({ ...r }));
}

export function saveTerminals(list: TerminalRec[]): void {
  const sorted = [...list].sort((a, b) => (a.spawnedAt < b.spawnedAt ? -1 : a.spawnedAt > b.spawnedAt ? 1 : 0));
  writeFileAtomic(registryFile(), `${JSON.stringify(sorted, null, 2)}\n`);
  registryCache = undefined; // our write changed the file: never serve the stale list
}

export function getTerminal(sessionId: string): TerminalRec | undefined {
  return loadTerminals().find((r) => r.sessionId === sessionId);
}

/** Merge `patch` into one record. A closed record stays closed. */
function updateTerminal(sessionId: string, patch: Partial<TerminalRec>): TerminalRec | undefined {
  const list = loadTerminals();
  const i = list.findIndex((r) => r.sessionId === sessionId);
  if (i < 0) return undefined;
  const next: TerminalRec = { ...list[i], ...patch };
  if (list[i].closedAt && !patch.closedAt) next.closedAt = list[i].closedAt;
  list[i] = next;
  saveTerminals(list);
  return next;
}

/**
 * Register (or refresh) a terminal. FLEET-BACKEND calls this for every window it spawns.
 * NEVER throws (it returns a Promise that always resolves); returns undefined only when `sessionId` is
 * missing. Idempotent per sessionId. `spawnedBy` defaults to "unknown" (registered, never closable).
 *
 * ASYNC (REAPER-ASYNC): the window proof needs a FRESH process table and fetching it must not block
 * anyone. The only await is the snapshot itself; everything after it is synchronous, so two racing
 * registrations can never interleave a load -> modify -> save cycle on company/terminals.json.
 * The Fleet does not await this (the window is recorded as soon as the table comes back).
 */
export async function registerTerminal(input: RegisterInput): Promise<TerminalRec | undefined> {
  try {
    if (!input || typeof input.sessionId !== "string" || !input.sessionId.trim()) return undefined;
    const sessionId = input.sessionId.trim();
    // `true` = force a new table: the window was created seconds ago and a stale table would miss it,
    // which would register the terminal without a windowPid (safe, but useless).
    const procs = await snapshotProcessesAsync(true);
    // The registration proof must see the pid files as they are NOW (a client that appeared moments ago),
    // so it does not reuse the 1s client_sessions index.
    forgetClientSessions();
    const list = loadTerminals();
    const existing = list.find((r) => r.sessionId === sessionId);
    const meta = sessionMeta(sessionId);
    const resolved = resolveWindow(sessionId, procs);
    // A window pid from the caller is only recorded if it PROVABLY hosts a live client of this
    // session (windowHostsSession). A wrong or premature pid leaves the terminal registered but
    // without a window, i.e. not closable - which is the safe direction. A recorded pairing is
    // never replaced by a new guess.
    let windowPid = existing?.windowPid;
    if (!windowPid) {
      const candidate = input.windowPid && input.windowPid > 0 ? input.windowPid : resolved?.windowPid;
      if (candidate && windowHostsSession(sessionId, candidate, procs).ok) windowPid = candidate;
    }
    const windowRow = windowPid ? procs.get(windowPid) : undefined;

    const rec: TerminalRec = {
      sessionId,
      sessionName: input.sessionName || existing?.sessionName || meta?.name || sessionId,
      role: input.role || existing?.role || "",
      windowPid,
      clientPid: input.clientPid ?? resolved?.clientPid ?? existing?.clientPid,
      windowCreatedAt: windowRow?.created || existing?.windowCreatedAt,
      spawnedBy: input.spawnedBy ?? existing?.spawnedBy ?? "unknown",
      spawnedAt: input.spawnedAt || existing?.spawnedAt || nowIso(),
      state: input.state ?? existing?.state ?? "working",
      keepOpen: input.keepOpen ?? existing?.keepOpen,
      reportPath: input.reportPath || existing?.reportPath,
      // preserved fields
      verdict: existing?.verdict,
      verdictReason: existing?.verdictReason,
      verifiedAt: existing?.verifiedAt,
      verdictSource: existing?.verdictSource,
      archive: existing?.archive,
      closedAt: existing?.closedAt,
      closedReason: existing?.closedReason,
      closedPids: existing?.closedPids,
      lastCheckedAt: existing?.lastCheckedAt,
      lastDecision: existing?.lastDecision,
      backfilled: existing?.backfilled,
    };
    return upsertRecord(rec);
  } catch {
    return undefined;
  }
}

function upsertRecord(rec: TerminalRec): TerminalRec {
  const list = loadTerminals();
  const i = list.findIndex((r) => r.sessionId === rec.sessionId);
  if (i >= 0) list[i] = { ...list[i], ...rec };
  else list.push(rec);
  saveTerminals(list);
  return getTerminal(rec.sessionId) as TerminalRec;
}

export function setKeepOpen(sessionId: string, keepOpen: boolean): TerminalRec | undefined {
  return updateTerminal(sessionId, {
    keepOpen,
    state: keepOpen ? "kept" : "working",
    stateReason: keepOpen ? "keep-open flag set (never closed)" : "keep-open flag cleared",
  });
}

export type VerdictInput = { verdict: Verdict; reason?: string; source?: string };

/** Record a manager verdict (the Fleet review path, or a POST from the manager/UI). */
export function recordVerdict(sessionId: string, input: VerdictInput): TerminalRec | undefined {
  const verdict = input.verdict;
  if (verdict !== "PASS" && verdict !== "REDO" && verdict !== "FAIL") return undefined;
  return updateTerminal(sessionId, {
    verdict,
    verdictReason: (input.reason ?? "").slice(0, 600),
    verifiedAt: nowIso(),
    verdictSource: input.source ?? "manager",
  });
}

// ── verdicts written by REPORTING (company/reports/runs/<runId>.json) ──

export type RunCardLite = {
  runId?: string;
  sessionId?: string;
  kind?: string;
  title?: string;
  owner?: string;
  verdict?: Verdict;
  verdictReason?: string;
  verifiedAt?: string;
};

function runCardsDir(): string {
  return path.join(getCompanyRoot(), "reports", "runs");
}

/** How long one scan of REPORTING's run cards is reused when nothing in the directory changed. */
let runCardsCache: { sig: string; cards: Array<{ card: RunCardLite; file: string }> } | undefined;

/** size+mtime of every card, so an unchanged directory costs a few stats instead of 45 reads+parses. */
function runCardsSig(): string {
  const dir = runCardsDir();
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return "none";
  }
  let sig = `${names.length}`;
  for (const name of names) sig += `|${name}:${statSig(path.join(dir, name))}`;
  return sig;
}

/**
 * Every run card, parsed, memoized on the directory's size+mtime signature. Read-only and tolerant of
 * the module not existing yet.
 *
 * PERF-BACKEND measured the un-memoized version at **1,978 ms of `readFileSync` inside ONE live reaper
 * pass** (each record called it again: `verdictFromRunCards` <- `effectiveVerdict` <- `planOne` <-
 * `planPass` <- `executePass`), the largest synchronous block on the router's loop. A verdict only ever
 * drives a close on a LATER pass, so an unchanged directory is reused and a changed one is re-read
 * exactly as before (any edit to a card changes its mtime, which changes the signature).
 */
function readRunCards(): Array<{ card: RunCardLite; file: string }> {
  const sig = runCardsSig();
  if (runCardsCache && runCardsCache.sig === sig) return runCardsCache.cards;
  const dir = runCardsDir();
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    runCardsCache = undefined;
    return [];
  }
  const cards: Array<{ card: RunCardLite; file: string }> = [];
  for (const name of names) {
    try {
      cards.push({ card: JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as RunCardLite, file: name });
    } catch {
      // a card being written right now: skip
    }
  }
  runCardsCache = { sig, cards };
  return cards;
}

/**
 * REPORTING's run-card verdict for a session. Matches runId, then an explicit sessionId field, then -
 * only for kind "jcode" - the session name inside owner/title.
 */
export function verdictFromRunCards(sessionId: string, sessionName?: string): { card: RunCardLite; source: string } | undefined {
  const cards = readRunCards();
  // NOTE: REPORTING's runId is "jcode:<sessionId>" while the FILE is "jcode_<sessionId>.json", so the
  // source we report is the file name, not runId (a colon is not even a legal Windows file name).
  const exact = cards.find((c) => c.card.runId === sessionId || c.card.sessionId === sessionId);
  if (exact) return { card: exact.card, source: `company/reports/runs/${exact.file}` };
  if (!sessionName) return undefined;
  const byName = cards.find(
    (c) =>
      c.card.kind === "jcode" &&
      [c.card.title, c.card.owner].some((s) => typeof s === "string" && s.toLowerCase().includes(sessionName.toLowerCase())),
  );
  return byName ? { card: byName.card, source: `company/reports/runs/${byName.file} (matched by name)` } : undefined;
}

/**
 * The verdict AUTOCLOSE will act on, in order of authority:
 *   1. a verdict recorded on the registry record (Fleet review, manager POST),
 *   2. the Fleet work order for this session (company/fleet/orders.json: PASS/REDO), else
 *   3. REPORTING's run card for this session (company/reports/runs/<runId>.json).
 * No source = no verdict = the terminal stays open.
 */
export function effectiveVerdict(rec: TerminalRec): { verdict?: Verdict; reason?: string; at?: string; source?: string } {
  if (rec.verdict) {
    return { verdict: rec.verdict, reason: rec.verdictReason, at: rec.verifiedAt, source: rec.verdictSource ?? "registry" };
  }
  const fleet = fleetWorkOrderFor(rec.sessionId);
  if (fleet?.verdict) {
    return {
      verdict: fleet.verdict,
      reason: fleet.reason,
      source: `fleet review ${fleet.orderId}/${fleet.wid} (company/fleet/orders.json)`,
    };
  }
  const card = verdictFromRunCards(rec.sessionId, rec.sessionName);
  if (card?.card.verdict) {
    return {
      verdict: card.card.verdict,
      reason: card.card.verdictReason,
      at: card.card.verifiedAt,
      source: card.source,
    };
  }
  return {};
}

// ── backfill for the sessions opened by hand today ─────────────────────

/**
 * Known sessions from docs/AGENT_COORDINATION.md (2026-09-29). Names not listed here are
 * registered with spawnedBy "unknown" - visible in the UI, never closed.
 */
const KNOWN_SESSIONS: Record<string, { role: string; spawnedBy: SpawnedBy }> = {
  rose: { role: "CEO assistant bridge (COLLECTOR)", spawnedBy: "ceo" },
  tigress: { role: "OPS (router uptime)", spawnedBy: "claude-code" },
  duckling: { role: "SMOKE (chain regression)", spawnedBy: "claude-code" },
  mizaru: { role: "UI-SHELL", spawnedBy: "claude-code" },
  kikazaru: { role: "UI-ASSISTANT", spawnedBy: "claude-code" },
  iwazaru: { role: "UI-PROJECTS", spawnedBy: "claude-code" },
  retriever: { role: "UI-FLOW", spawnedBy: "claude-code" },
  pawprint: { role: "UI-OFFICE", spawnedBy: "claude-code" },
  piglet: { role: "CRASHFIX (server crashes)", spawnedBy: "claude-code" },
  bonehound: { role: "FLEET-BACKEND", spawnedBy: "claude-code" },
  sabertooth: { role: "FLEET-UI", spawnedBy: "claude-code" },
  mushroom: { role: "REPORTING", spawnedBy: "claude-code" },
  cactus: { role: "ASSISTANT-BRAIN", spawnedBy: "claude-code" },
  clover: { role: "BRIEFING-UI", spawnedBy: "claude-code" },
  hibiscus: { role: "AUTOCLOSE", spawnedBy: "claude-code" },
  microbe: { role: "fleet probe (temp dir)", spawnedBy: "fleet" },
  blossom: { role: "MEMORY (graphify memory)", spawnedBy: "claude-code" },
  tulip: { role: "FLEET-PROBE (fleet spawn test)", spawnedBy: "fleet" },
};

export type BackfillResult = {
  scanned: number;
  added: TerminalRec[];
  refreshed: TerminalRec[];
  unknown: string[];
  windowless: string[];
  pruned: string[];
};

/**
 * One-off discovery of the sessions that are attached to the shared jcode server but were
 * never registered by a spawner (Claude Code opened them by hand today). Adds only MISSING
 * records and refreshes pids of open ones; a closed record is never resurrected.
 * ASYNC (REAPER-ASYNC): the same fresh-table rule as registerTerminal; the await is the snapshot
 * and nothing else, so the registry writes stay atomic.
 */
export async function backfillTerminals(): Promise<BackfillResult> {
  const out: BackfillResult = { scanned: 0, added: [], refreshed: [], unknown: [], windowless: [], pruned: [] };
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(path.join(jcodeHome(), "active_pids"));
  } catch {
    return out;
  }
  const procs = await snapshotProcessesAsync(true);
  forgetClientSessions();
  const list = loadTerminals();
  const byId = new Map(list.map((r) => [r.sessionId, r]));

  for (const sessionId of ids) {
    out.scanned++;
    const existing = byId.get(sessionId);
    if (existing?.closedAt) continue; // never resurrect a closed terminal
    const meta = sessionMeta(sessionId);
    const name = meta?.name || existing?.sessionName || "";
    const known = name ? KNOWN_SESSIONS[name] : undefined;
    // A Fleet work order names its session, so we can classify it from data instead of a name map
    // (this is what makes a hand-spawned fleet window closable even if its spawner did not register).
    const fleet = fleetWorkOrderFor(sessionId);
    // spawnedBy decides who may close a terminal (only "fleet" and "claude-code"). A name that is not
    // in KNOWN_SESSIONS used to default to "unknown" = never closable, which meant every NEW worker
    // Claude Code opens by hand would sit open forever after its PASS. The manager's rule is "close
    // every verified-done, quiet terminal, never rose", so a NAMED terminal whose working directory
    // is this repo is attributed to Claude Code (today every such window came from it), while
    // anything outside this repo, unnamed, or rose keeps the fail-closed "unknown"/"ceo" default.
    const wd = (meta?.workingDir ?? "").toLowerCase().replace(/[\\/]+$/, "");
    const root = repoRoot().toLowerCase().replace(/[\\/]+$/, "");
    const inThisRepo = Boolean(wd) && (wd === root || wd.startsWith(`${root}\\`) || wd.startsWith(`${root}/`));
    const inferred: SpawnedBy = name && name !== "rose" && inThisRepo ? "claude-code" : "unknown";
    if (!known && !fleet && inferred === "unknown") out.unknown.push(`${name || sessionId} (${sessionId})`);
    const resolved = resolveWindow(sessionId, procs);
    // A session we cannot tie to a window is not a terminal (headless `jcode run` workers, or a
    // pane we cannot identify): it has nothing to close, so it does not belong in the registry.
    // Records that already have a windowPid keep it even when the chain has drifted since.
    const windowPid = existing?.windowPid ?? resolved?.windowPid;
    if (!windowPid) {
      out.windowless.push(`${name || sessionId} (${sessionId})`);
      continue;
    }
    const rec: TerminalRec = {
      sessionId,
      sessionName: name || existing?.sessionName || sessionId,
      role: fleet
        ? `FLEET ${fleet.orderId}/${fleet.wid}: ${fleet.title}`
        : known?.role ?? existing?.role ?? "",
      windowPid,
      // A fresh resolve can land on a DIFFERENT console after a TUI re-exec or a reconnect, so a
      // recorded pairing - which was verified by ancestry when it was made - is never overwritten
      // by a guess. New records use the resolved pair; existing ones keep theirs.
      clientPid: existing?.clientPid ?? resolved?.clientPid,
      windowCreatedAt: existing?.windowCreatedAt || resolved?.windowCreatedAt,
      // A record already registered by someone keeps its spawner, EXCEPT one that was only ever
      // classified as "unknown" (e.g. it was first seen before its journal existed): that one may be
      // upgraded to the inference, otherwise a new worker would stay unclosable forever.
      spawnedBy: fleet
        ? "fleet"
        : known?.spawnedBy ??
          (existing?.spawnedBy && existing.spawnedBy !== "unknown" ? existing.spawnedBy : inferred),
      spawnedAt: existing?.spawnedAt ?? spawnedAtFromId(sessionId) ?? meta?.lastActiveAt ?? nowIso(),
      state: existing?.state ?? "working",
      stateReason: existing?.stateReason,
      keepOpen: existing?.keepOpen ?? (name ? PROTECTED_SESSION_NAMES.includes(name) : false),
      reportPath: existing?.reportPath ?? fleet?.reportPath,
      verdict: existing?.verdict,
      verdictReason: existing?.verdictReason,
      verifiedAt: existing?.verifiedAt,
      verdictSource: existing?.verdictSource,
      archive: existing?.archive,
      closedAt: existing?.closedAt,
      closedReason: existing?.closedReason,
      closedPids: existing?.closedPids,
      lastCheckedAt: existing?.lastCheckedAt,
      lastDecision: existing?.lastDecision,
      backfilled: true,
    };
    upsertRecord(rec);
    if (existing) out.refreshed.push(rec);
    else out.added.push(rec);
  }

  // Drop records this backfill created that turned out to be no use at all: no window (so nothing
  // to close), no verdict, no archive, never closed, not kept open, not a protected name and not
  // spawned by anyone we trust. Only records marked `backfilled` are ever removed here, so a
  // registerTerminal() record from the Fleet or a manager is never touched.
  try {
    const all = loadTerminals();
    const keep = all.filter((r) => {
      const useless =
        r.backfilled === true &&
        !r.windowPid &&
        !r.closedAt &&
        !r.keepOpen &&
        !r.verdict &&
        !r.archive &&
        r.spawnedBy === "unknown" &&
        !PROTECTED_SESSION_NAMES.includes(r.sessionName);
      if (useless) out.pruned.push(`${r.sessionName || r.sessionId} (${r.sessionId})`);
      return !useless;
    });
    if (out.pruned.length) saveTerminals(keep);
  } catch {
    // pruning is housekeeping; never fail the backfill over it
  }
  return out;
}

/** jcode session ids embed their creation time in ms: session_<name>_<ms>_<hex>. */
function spawnedAtFromId(sessionId: string): string | undefined {
  const m = /^session_[a-z]+_(\d{13})_/.exec(sessionId);
  if (!m) return undefined;
  const ms = Number(m[1]);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

// ── archive ────────────────────────────────────────────────────────────

function repoRoot(): string {
  return process.env.COMPANY_REPO ?? process.cwd();
}

export type FleetHit = {
  orderId: string;
  wid: string;
  title: string;
  role: string;
  state: string;
  orderStatus: string;
  verdict?: Verdict;
  reason?: string;
  reportPath: string;
};

/** One order, as much as we read of it (typed loosely: it is FLEET-BACKEND's file). */
type FleetOrderLite = {
  id?: string;
  status?: string;
  workOrders?: Array<{
    id?: string;
    title?: string;
    role?: string;
    state?: string;
    sessionId?: string;
    verdict?: string;
    review?: string;
  }>;
};

/** How long one read of the Fleet's orders.json is reused (see fleetOrders). */
const FLEET_ORDERS_TTL_MS = 2000;
let fleetOrdersCache: { at: number; stamp: string; orders: FleetOrderLite[] } | undefined;

/**
 * company/fleet/orders.json, parsed, memoized. `effectiveVerdict()` asks for the Fleet work order of
 * EVERY registry record, so this used to read and parse the whole (95KB) file once per record - about
 * 3.7MB and 39 JSON parses per reaper pass, on the router's event loop (the same hotspot PERF-BACKEND
 * profiled for the run cards). The stamp is the file's mtime+size, so a new Fleet review is picked up
 * on the next call, not at the end of a TTL.
 */
function fleetOrders(): FleetOrderLite[] {
  const file = path.join(getCompanyRoot(), "fleet", "orders.json");
  let stamp = "";
  try {
    const st = fs.statSync(file);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    fleetOrdersCache = undefined;
    return [];
  }
  const now = Date.now();
  if (fleetOrdersCache && fleetOrdersCache.stamp === stamp && now - fleetOrdersCache.at < FLEET_ORDERS_TTL_MS) {
    return fleetOrdersCache.orders;
  }
  const raw = readTrimmed(file);
  if (!raw) {
    fleetOrdersCache = undefined;
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    const orders = (Array.isArray(parsed) ? parsed : ((parsed as { orders?: unknown }).orders ?? [])) as FleetOrderLite[];
    const list = Array.isArray(orders) ? orders : [];
    fleetOrdersCache = { at: now, stamp, orders: list };
    return list;
  } catch {
    // FLEET-BACKEND is mid-write: no verdict this time, fail closed
    fleetOrdersCache = undefined;
    return [];
  }
}

/**
 * The Fleet work order a session belongs to, read from company/fleet/orders.json (READ-ONLY -
 * FLEET-BACKEND owns that file). The spec says Fleet work orders already get PASS/REDO from the
 * Fleet review and AUTOCLOSE treats those the same, so this is a first-class verdict source and
 * it also gives us the worker's real REPORT.md for the archive.
 */
export function fleetWorkOrderFor(sessionId: string): FleetHit | undefined {
  for (const order of fleetOrders()) {
    for (const wo of order.workOrders ?? []) {
      if (!wo || wo.sessionId !== sessionId || !order.id || !wo.id) continue;
      const verdict = wo.verdict === "PASS" || wo.verdict === "REDO" ? (wo.verdict as Verdict) : undefined;
      return {
        orderId: order.id,
        wid: wo.id,
        title: wo.title ?? "",
        role: wo.role ?? "",
        state: wo.state ?? "",
        orderStatus: order.status ?? "",
        verdict,
        reason: typeof wo.review === "string" ? wo.review.slice(0, 400) : undefined,
        reportPath: path.join(getCompanyRoot(), "fleet", order.id, wo.id, "REPORT.md"),
      };
    }
  }
  return undefined;
}

/** The parsed `- `-blocks of the last 1200 lines of the coordination doc, keyed by the file's mtime. */
type CoordBlock = { text: string; lower: string };
let coordBlocksCache: { file: string; mtime: number; blocks: CoordBlock[] } | undefined;

/**
 * docs/AGENT_COORDINATION.md split into its log entries (an entry starts at "- "). Parsed ONCE per
 * file revision: buildArchive asks for it per archived terminal, so the uncached version re-read and
 * re-split the ~560KB file (20-60ms) for every archive in a pass - seconds in a burst. Same shape as
 * runManagers.ts coordinationEntries()'s mtime cache.
 */
function coordinationBlocks(): CoordBlock[] {
  const file = path.join(repoRoot(), "docs", "AGENT_COORDINATION.md");
  try {
    const st = fs.statSync(file);
    if (coordBlocksCache && coordBlocksCache.file === file && coordBlocksCache.mtime === st.mtimeMs) return coordBlocksCache.blocks;
    const text = fs.readFileSync(file, "utf8").split("\n").slice(-1200).join("\n");
    const blocks: CoordBlock[] = [];
    let current: string[] = [];
    const flush = () => {
      if (!current.length) return;
      const joined = current.join("\n");
      blocks.push({ text: joined, lower: joined.toLowerCase() });
      current = [];
    };
    for (const line of text.split("\n")) {
      if (line.startsWith("- ")) {
        flush();
        current = [line];
      } else if (current.length) {
        current.push(line);
      }
    }
    flush();
    coordBlocksCache = { file, mtime: st.mtimeMs, blocks };
    return blocks;
  } catch {
    return [];
  }
}

/** The log entries in docs/AGENT_COORDINATION.md that mention this session (pre-Fleet reports). */
function coordinationEntries(sessionName: string): string[] {
  if (!sessionName) return [];
  const needle = sessionName.toLowerCase();
  const entries: string[] = [];
  for (const block of coordinationBlocks()) {
    if (block.lower.includes(needle)) entries.push(block.text);
  }
  return entries.slice(-3);
}

export type ArchiveResult = { relPath: string; absPath: string; text: string; reportSource: string };

/** Where a terminal's archive lives (registry link + UI). */
export function archiveAbsPath(rec: TerminalRec): string {
  return path.join(getCompanyRoot(), "reports", "terminals", `${rec.sessionName || rec.sessionId}.md`);
}
export function archiveRelPath(rec: TerminalRec): string {
  return path.join("company", "reports", "terminals", `${rec.sessionName || rec.sessionId}.md`).replace(/\\/g, "/");
}

/** Build (do not write) the archive markdown for a terminal. */
export function buildArchive(
  rec: TerminalRec,
  verdict?: { verdict?: Verdict; reason?: string; at?: string; source?: string },
): ArchiveResult {
  const name = rec.sessionName || rec.sessionId;
  const relPath = archiveRelPath(rec);
  const absPath = archiveAbsPath(rec);

  let report = "";
  let reportSource = "none";
  if (rec.reportPath) {
    report = readTrimmed(rec.reportPath);
    if (report) reportSource = rec.reportPath;
  }
  if (!report) {
    const fleet = fleetWorkOrderFor(rec.sessionId);
    if (fleet) {
      report = readTrimmed(fleet.reportPath);
      if (report) reportSource = fleet.reportPath;
    }
  }
  const logEntries = coordinationEntries(rec.sessionName);
  const tail = journalTextTail(rec.sessionId, 200);

  const header = [
    `# Terminal archive: ${name}`,
    "",
    `- session: \`${rec.sessionId}\``,
    `- role: ${rec.role || "(unset)"} (spawned by ${rec.spawnedBy})`,
    `- state: ${rec.state}${rec.stateReason ? ` (${rec.stateReason})` : ""}`,
    `- window pid: ${rec.windowPid ?? "?"}${rec.windowCreatedAt ? ` (created ${rec.windowCreatedAt})` : ""}, client pid: ${rec.clientPid ?? "?"}`,
    `- spawned: ${rec.spawnedAt}`,
    `- verdict: ${rec.verdict ?? verdict?.verdict ?? "(none)"}${rec.verdictReason ?? verdict?.reason ? ` - ${rec.verdictReason ?? verdict?.reason}` : ""}`,
    `- verdict source: ${rec.verdictSource ?? verdict?.source ?? "(none)"}`,
    `- archived: ${nowIso()}`,
    `- reopen it with: \`jcode --resume ${rec.sessionId}\``,
    "",
    "## Report",
    "",
    report ? `(from ${reportSource})\n\n${report}` : `(no report file found; sources checked: reportPath=${rec.reportPath ?? "-"}, fleet orders.json, docs/AGENT_COORDINATION.md)`,
    "",
  ];
  if (logEntries.length) {
    header.push("## Its entries in docs/AGENT_COORDINATION.md", "", logEntries.join("\n\n"), "");
  }
  header.push(`## Journal tail (last ${tail.length} lines)`, "", tail.length ? tail.join("\n") : "(journal unreadable)", "");
  const text = header.join("\n");
  return { relPath, absPath, text, reportSource };
}

function appendCloseLog(entry: Record<string, unknown>): void {
  try {
    const file = path.join(getCompanyRoot(), "reports", "terminals.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    // reporting up the chain is best effort; the registry record is the source of truth
  }
}

// ── the reaper ─────────────────────────────────────────────────────────

export type ReapAction = "close" | "skip" | "already_closed" | "window_gone";

export type ReapDecision = {
  sessionId: string;
  sessionName: string;
  role: string;
  spawnedBy: SpawnedBy;
  state: TerminalState;
  action: ReapAction;
  reason: string;
  closed: boolean;
  verdict?: Verdict;
  verdictSource?: string;
  streaming?: boolean;
  idleSeconds?: number;
  windowPid?: number;
  archive?: string;
};

export type ReapPass = {
  at: string;
  dryRun: boolean;
  enabled: boolean;
  graceSeconds: number;
  decisions: ReapDecision[];
  closed: ReapDecision[];
  /** why a pass could not act (no usable process table, another pass running, ...) */
  note?: string;
};

/** How a pass reports a close: "dry" and "project" never touch anything, "execute" really kills. */
type PassMode = "dry" | "project" | "execute";

type VerdictInfo = { verdict?: Verdict; reason?: string; at?: string; source?: string };

/** A verified close, waiting for the async executor (archive -> taskkill -> registry). */
type ClosePlan = {
  rec: TerminalRec;
  verdict: VerdictInfo;
  windowPid: number;
  windowAlive: boolean;
  check: WindowCheck;
  orphans: number[];
  streaming: boolean;
  idleSeconds?: number;
};

/** A window that exited on its own: archive it and mark it closed, kill nothing. */
type ReconcilePlan = { rec: TerminalRec; verdict: VerdictInfo; absPath: string; relPath: string };

type PlanOutcome = { decision: ReapDecision; close?: ClosePlan; reconcile?: ReconcilePlan };

type PassCtx = {
  now: number;
  grace: number;
  enabled: boolean;
  dryRun: boolean;
  mode: PassMode;
  procs: ProcMap;
  selfPid: number;
  own: Set<number>;
  /** the table has rows AND was fetched within PROC_TABLE_MAX_AGE_MS */
  tableReady: boolean;
};

/** the pass that is running RIGHT NOW, if any: the module-wide re-entrancy guard */
let passInFlight: { dryRun: boolean; promise: Promise<ReapPass> } | undefined;

/**
 * `taskkill /PID <pid> /T /F`, WITHOUT blocking the event loop (this used to be an execFileSync on the
 * router's event loop). The own-process-tree refusal is repeated at this level (defence in depth) so
 * that no caller - now or later - can ever kill the router, the shell it was started from, or the
 * supervisor window above it.
 */
async function killTreeAsync(pid: number, ctx: { own: Set<number> }): Promise<{ ok: boolean; detail: string }> {
  if (ctx.own.has(pid)) {
    return { ok: false, detail: `refused: pid ${pid} is this process or one of its ancestors (the router's own tree)` };
  }
  const res = await runCommand("taskkill", ["/PID", String(pid), "/T", "/F"], 15_000);
  if (res.ok) return { ok: true, detail: res.stdout.trim().split("\n").join(" | ") || "closed" };
  const detail = (res.stdout.trim() || res.stderr.trim() || res.error || "taskkill failed").split("\n").join(" | ");
  // same rule as before: a failed taskkill only counts as success when the pid is really gone
  return { ok: pidAlive(pid) === false, detail };
}

export type ReapPassOpts = { dryRun?: boolean };

/**
 * ONE guarded pass over the registry, AWAITED. This is the pass the router loop and the ops CLI run,
 * and the only path that can close anything. Fail-closed: anything it cannot PROVE (a PASS verdict,
 * idle beyond the grace period, not streaming, a FRESH process table, a window that verifies) means
 * "leave it open".
 *
 * RE-ENTRANCY GUARD: while a pass is running, a second call with the SAME mode gets that pass's very
 * own promise (a slow refresh can never stack passes), and a call with a different mode gets an
 * explicit "nothing was done" pass instead of a second, overlapping pass.
 * NOT an `async function` on purpose: an async wrapper would return a NEW promise, and the guard must
 * hand back the identical promise so callers can see that they shared a pass.
 */
export function runReaperPassAsync(opts: ReapPassOpts = {}): Promise<ReapPass> {
  const dryRun = opts.dryRun ?? autocloseDryRun();
  if (passInFlight) {
    if (passInFlight.dryRun === dryRun) return passInFlight.promise;
    return Promise.resolve(guardedPass(dryRun, "another reaper pass is already running (this call did nothing)"));
  }
  const entry = { dryRun, promise: undefined as unknown as Promise<ReapPass> };
  entry.promise = executePass(dryRun).finally(() => {
    if (passInFlight === entry) passInFlight = undefined;
  });
  passInFlight = entry;
  return entry.promise;
}

/**
 * SYNCHRONOUS compatibility entry point: `src/server.ts` (POST /company/terminals/reap) does not await
 * this, and this module must never block the router. It therefore:
 *   - reads the CACHED process table (it never spawns PowerShell on the caller's stack),
 *   - reports what a pass WOULD do (mode "project"): it closes nothing and writes nothing itself,
 *   - with dryRun:false kicks the real ASYNC pass off in the background, which re-fetches the table,
 *     re-verifies every window and performs the kills (the router loop would do the same within 30s).
 * The returned shape (ReapPass) is unchanged, so the route keeps working as-is.
 */
export function runReaperPass(opts: { dryRun?: boolean } = {}): ReapPass {
  const dryRun = opts.dryRun ?? autocloseDryRun();
  const enabled = autocloseEnabled();
  resetTailMemo(); // a pass boundary: the journal-tail memo never outlives one pass
  const procs = enabled ? cachedProcesses() : new Map<number, ProcRow>();
  const info = processTableStatus();
  const ctx: PassCtx = {
    now: Date.now(),
    grace: graceMs(),
    enabled,
    dryRun,
    mode: "project",
    procs,
    selfPid: process.pid,
    own: ownProcessTree(procs, process.pid),
    tableReady: procs.size > 0 && info.ageMs !== undefined && info.ageMs <= PROC_TABLE_MAX_AGE_MS,
  };
  let records: TerminalRec[] = [];
  try {
    records = loadTerminals();
  } catch {
    records = [];
  }
  const { pass } = planPass(records, ctx);
  if (!dryRun && enabled) {
    const prefix = pass.note ? `${pass.note}; ` : "";
    if (passInFlight) {
      pass.note = `${prefix}a pass is already running (${passInFlight.dryRun ? "dry run" : "real"}); the router loop will do the closes`;
    } else {
      pass.note = `${prefix}the synchronous entry point never closes anything by itself: the real pass was started asynchronously`;
      void runReaperPassAsync({ dryRun: false });
    }
  }
  return pass;
}

/**
 * A record that was registered while its journal did not exist yet is stored as spawnedBy "unknown"
 * (= never closable). Every real pass gives those one more look: when the journal now names the
 * session and its working directory is this repo, the spawner is upgraded to "claude-code" so the
 * terminal can close normally once the manager PASSes it. Only "unknown" is ever upgraded, rose is
 * never touched, and NOTHING is killed here. Returns how many records changed.
 */
function reattributeUnknowns(): number {
  try {
    const list = loadTerminals();
    const root = repoRoot().toLowerCase().replace(/[\\/]+$/, "");
    let changed = 0;
    for (const rec of list) {
      if (rec.spawnedBy !== "unknown" || rec.closedAt) continue;
      const meta = sessionMeta(rec.sessionId);
      const name = meta?.name || "";
      if (!name || PROTECTED_SESSION_NAMES.includes(name)) continue;
      const wd = (meta?.workingDir ?? "").toLowerCase().replace(/[\\/]+$/, "");
      const inThisRepo = Boolean(wd) && (wd === root || wd.startsWith(`${root}\\`) || wd.startsWith(`${root}/`));
      if (!inThisRepo) continue;
      rec.sessionName = name;
      rec.spawnedBy = "claude-code";
      rec.stateReason = "re-attributed after its journal appeared (named terminal in this repo)";
      rec.lastCheckedAt = nowIso();
      changed++;
    }
    if (changed) saveTerminals(list);
    return changed;
  } catch (e) {
    console.error(`[autoclose] re-attribution failed (nothing closed because of it): ${String(e)}`);
    return 0;
  }
}

/** The real pass: one fresh process table for its whole duration, then plan, then execute. */
async function executePass(dryRun: boolean): Promise<ReapPass> {
  const started = Date.now();
  resetTailMemo(); // a real pass starts here: one journal read per file for its whole duration
  try {
    const enabled = autocloseEnabled();
    const mode: PassMode = dryRun ? "dry" : "execute";
    if (enabled) await snapshotProcessesAsync(true);
    // BEFORE planning: records that were registered before their journal existed (spawnedBy
    // "unknown" = never closable) get one more look, so a new worker becomes closable by itself and
    // is judged as closable in THIS pass, not the next one.
    const upgraded = mode === "execute" ? reattributeUnknowns() : 0;
    if (upgraded > 0) console.log(`[autoclose] re-attributed ${upgraded} terminal(s) whose journal appeared (now closable after a PASS)`);
    const info = processTableStatus();
    const procs = enabled ? cachedProcesses() : new Map<number, ProcRow>();
    // The table above is cached for the WHOLE pass: every decision and every kill below verifies
    // against exactly this one snapshot (never a second PowerShell call in the middle of a pass).
    const ctx: PassCtx = {
      now: Date.now(),
      grace: graceMs(),
      enabled,
      dryRun,
      mode,
      procs,
      selfPid: process.pid,
      own: ownProcessTree(procs, process.pid),
      tableReady: procs.size > 0 && info.rows > 0 && info.ageMs !== undefined && info.ageMs <= PROC_TABLE_MAX_AGE_MS,
    };
    let records: TerminalRec[] = [];
    try {
      records = loadTerminals();
    } catch {
      records = [];
    }
    const { pass, plans } = planPass(records, ctx);
    if (mode === "execute") {
      // Reconciliations first (they only write files), then the closes. Every plan was verified
      // against the fresh table above, and killTreeAsync refuses this process's own tree again.
      for (const p of plans) {
        if (p.reconcile) {
          pass.decisions[p.index] = reconcileNow(p.reconcile);
          continue;
        }
        if (p.close) {
          const done = await closeNow(p.close, ctx);
          pass.decisions[p.index] = done;
          if (done.closed) pass.closed.push(done);
        }
      }
    }
    lastPass = pass;
    lastPassMs = Date.now() - started;
    return pass;
  } catch (e) {
    // a broken pass must never take the control plane down with it
    console.error(`[autoclose] pass failed (router continues): ${String(e)}`);
    return guardedPass(dryRun, `reaper pass failed: ${String(e)}`);
  }
}

function guardedPass(dryRun: boolean, note: string): ReapPass {
  return {
    at: nowIso(),
    dryRun,
    enabled: autocloseEnabled(),
    graceSeconds: Math.round(graceMs() / 1000),
    decisions: [],
    closed: [],
    note,
  };
}

/**
 * Decide for every record WITHOUT touching anything. Closable records come back as plans and the async
 * executor runs them. The whole pass works off ONE process table (ctx.procs).
 */
function planPass(
  records: TerminalRec[],
  ctx: PassCtx,
): { pass: ReapPass; plans: Array<{ index: number; close?: ClosePlan; reconcile?: ReconcilePlan }> } {
  const pass: ReapPass = {
    at: nowIso(),
    dryRun: ctx.dryRun,
    enabled: ctx.enabled,
    graceSeconds: Math.round(ctx.grace / 1000),
    decisions: [],
    closed: [],
  };
  const plans: Array<{ index: number; close?: ClosePlan; reconcile?: ReconcilePlan }> = [];
  if (!ctx.enabled) {
    pass.decisions = records.map((r) => decision(r, "skip", "AUTOCLOSE=0 (disabled)", false));
    return { pass, plans };
  }
  // FAIL CLOSED without a usable process table: with an empty or too-old map none of the rules below
  // can be verified (a live window would look "gone" and could even be reconciled away), so no record
  // is considered at all.
  if (!ctx.tableReady) {
    const age = processTableStatus().ageMs;
    pass.note =
      ctx.procs.size === 0
        ? "process table not loaded (a refresh is running); nothing can be verified, so nothing was closed"
        : `process table too old to act on (${Math.round((age ?? 0) / 1000)}s); nothing was closed`;
    pass.decisions = records.map((r) => decision(r, "skip", pass.note as string, false));
    return { pass, plans };
  }
  for (const rec of records) {
    try {
      const out = planOne(rec, ctx);
      pass.decisions.push(out.decision);
      if (out.close || out.reconcile) {
        plans.push({ index: pass.decisions.length - 1, close: out.close, reconcile: out.reconcile });
      }
    } catch (e) {
      pass.decisions.push(decision(rec, "skip", `reaper error: ${String(e)}`, false));
    }
  }
  return { pass, plans };
}

/** The window exited on its own: keep the report as an archive and record the terminal as closed. */
function reconcileNow(plan: ReconcilePlan): ReapDecision {
  const { rec, verdict, absPath, relPath } = plan;
  let archiveRel: string | undefined = rec.archive;
  try {
    if (!rec.archive || !fs.existsSync(absPath)) {
      const archive = buildArchive(rec, verdict);
      fs.mkdirSync(path.dirname(archive.absPath), { recursive: true });
      fs.writeFileSync(archive.absPath, archive.text);
      archiveRel = archive.relPath;
    }
  } catch {
    archiveRel = rec.archive;
  }
  updateTerminal(rec.sessionId, {
    state: "closed",
    stateReason: "window exited on its own (not closed by AUTOCLOSE)",
    closedAt: nowIso(),
    closedReason: "window exited before AUTOCLOSE got to it; nothing was killed",
    archive: archiveRel,
    lastCheckedAt: nowIso(),
    lastDecision: "reconciled: window already gone",
  });
  appendCloseLog({
    at: nowIso(),
    sessionId: rec.sessionId,
    sessionName: rec.sessionName,
    role: rec.role,
    verdict: verdict.verdict,
    verdictReason: verdict.reason,
    verdictSource: verdict.source,
    archive: archiveRel,
    reason: `reconciled: ${rec.sessionName || rec.sessionId}${rec.role ? ` (${rec.role})` : ""} had already exited; report archived, nothing killed`,
  });
  return decision(rec, "already_closed", "window exited before AUTOCLOSE got to it (reconciled + archived, nothing killed)", false, {
    verdict: verdict.verdict,
    verdictSource: verdict.source,
    archive: archiveRel,
  });
}

/** Archive first, then kill (async), then record. Returns the FINAL decision for this record. */
async function closeNow(plan: ClosePlan, ctx: PassCtx): Promise<ReapDecision> {
  const { rec, verdict, windowPid, windowAlive, check, streaming, idleSeconds } = plan;
  const archive = buildArchive(rec, verdict);
  try {
    fs.mkdirSync(path.dirname(archive.absPath), { recursive: true });
    fs.writeFileSync(archive.absPath, archive.text);
  } catch (e) {
    return decision(rec, "skip", `could not write the archive: ${String(e)}`, false, {
      verdict: verdict.verdict,
      verdictSource: verdict.source,
    });
  }

  const kill = windowAlive ? await killTreeAsync(windowPid, ctx) : { ok: true, detail: "window already gone" };
  // A jcode TUI that re-exec'd after an update is orphaned from its window, so `taskkill /T` on the
  // window cannot reach it: close the leftovers too, but only pids that client_sessions still
  // attributes to THIS session - and never a pid inside this process's own tree.
  const candidates = liveClientPids(rec.sessionId);
  const refused = candidates.filter((pid) => ctx.own.has(pid));
  const leftovers = candidates.filter((pid) => !ctx.own.has(pid));
  const clientKills: Array<{ pid: number; ok: boolean; detail: string }> = [];
  for (const pid of leftovers) clientKills.push({ pid, ...(await killTreeAsync(pid, ctx)) });
  const closedPids = [...(windowAlive ? [windowPid] : []), ...leftovers];
  const stillAlive = closedPids.filter((p) => pidAlive(p));
  const killedClients = clientKills.filter((k) => k.ok).map((k) => k.pid);
  const closedOk = kill.ok && stillAlive.length === 0;
  const refusedNote = refused.length ? ` (refused to kill this process's own tree: ${refused.join(", ")})` : "";
  const reason =
    (closedOk
      ? (windowAlive
          ? `closed ${check.window?.name ?? "window"} ${windowPid}` +
            `${killedClients.length ? ` + orphaned TUI client(s) ${killedClients.join(", ")}` : ""}`
          : `closed its orphaned TUI client(s) ${killedClients.join(", ") || "(already gone)"}; the window ${windowPid} was already gone`) +
        ` (verdict ${verdict.verdict} from ${verdict.source ?? "manager"})`
      : `taskkill said: ${kill.detail}${stillAlive.length ? ` (still alive: ${stillAlive.join(", ")})` : ""}`) + refusedNote;

  updateTerminal(rec.sessionId, {
    // a failed kill is a reaper problem, not a failed run: keep the run state
    state: closedOk ? "closed" : rec.state,
    stateReason: reason,
    verdict: verdict.verdict,
    verdictReason: verdict.reason,
    verifiedAt: verdict.at,
    verdictSource: verdict.source,
    archive: archive.relPath,
    closedAt: closedOk ? nowIso() : undefined,
    closedReason: reason,
    closedPids,
    lastCheckedAt: nowIso(),
    lastDecision: reason,
  });

  if (closedOk) {
    appendCloseLog({
      at: nowIso(),
      sessionId: rec.sessionId,
      sessionName: rec.sessionName,
      role: rec.role,
      verdict: verdict.verdict,
      verdictReason: verdict.reason,
      verifiedAt: verdict.at,
      verdictSource: verdict.source,
      archive: archive.relPath,
      reportSource: archive.reportSource,
      reason: `verified and closed after PASS: ${rec.sessionName || rec.sessionId}${rec.role ? ` (${rec.role})` : ""}`,
    });
  }

  return decision(rec, closedOk ? "close" : "skip", reason, closedOk, {
    verdict: verdict.verdict,
    verdictSource: verdict.source,
    streaming,
    idleSeconds,
    archive: archive.relPath,
  });
}

function decision(
  rec: TerminalRec,
  action: ReapAction,
  reason: string,
  closed: boolean,
  extra: Partial<ReapDecision> = {},
): ReapDecision {
  return {
    sessionId: rec.sessionId,
    sessionName: rec.sessionName,
    role: rec.role,
    spawnedBy: rec.spawnedBy,
    state: rec.state,
    action,
    reason,
    closed,
    windowPid: rec.windowPid,
    ...extra,
  };
}

/**
 * All the rules, in one place, WITHOUT touching anything: the outcome is a decision plus (when the
 * record is closable) a plan for the async executor. `ctx.procs` is the pass's single process table.
 */
function planOne(rec: TerminalRec, ctx: PassCtx): PlanOutcome {
  const verdict = effectiveVerdict(rec);

  if (rec.closedAt || rec.state === "closed") {
    return { decision: decision(rec, "already_closed", `closed at ${rec.closedAt ?? "?"}`, false, {
      verdict: verdict.verdict,
      verdictSource: verdict.source,
    }) };
  }
  if (PROTECTED_SESSION_NAMES.includes(rec.sessionName)) {
    return { decision: decision(rec, "skip", `protected session name "${rec.sessionName}" (the CEO's own window)`, false, {
      verdict: verdict.verdict,
      verdictSource: verdict.source,
    }) };
  }
  if (!CLOSABLE_SPAWNERS.includes(rec.spawnedBy)) {
    return { decision: decision(rec, "skip", `spawnedBy "${rec.spawnedBy}" is not closable (only ${CLOSABLE_SPAWNERS.join("/")})`, false, {
      verdict: verdict.verdict,
      verdictSource: verdict.source,
    }) };
  }
  if (rec.keepOpen) {
    return { decision: decision(rec, "skip", "keep-open flag set (never closed)", false, { verdict: verdict.verdict, verdictSource: verdict.source }) };
  }

  // Reconcile, do not kill: if the recorded window is gone AND the session has no live client, the
  // terminal was closed outside AUTOCLOSE (by hand, or by OPS during the RAM crunch). The registry
  // must not keep claiming it is working, so archive what the run left behind and record it as
  // closed. Nothing is killed here, and the async executor owns the write.
  if (rec.windowPid && !ctx.procs.has(rec.windowPid) && liveClientPids(rec.sessionId).length === 0) {
    const absPath = archiveAbsPath(rec);
    const relPath = archiveRelPath(rec);
    const reconcileText =
      ctx.mode === "execute"
        ? "window exited before AUTOCLOSE got to it (reconciling: the report is archived, nothing killed)"
        : "window exited before AUTOCLOSE got to it (would reconcile + archive, nothing killed)";
    return {
      decision: decision(rec, "already_closed", reconcileText, false, {
        verdict: verdict.verdict,
        verdictSource: verdict.source,
        archive: fs.existsSync(absPath) ? relPath : undefined,
      }),
      reconcile: ctx.mode === "execute" ? { rec, verdict, absPath, relPath } : undefined,
    };
  }

  if (verdict.verdict !== "PASS") {
    const why = verdict.verdict ? `${verdict.verdict}: ${verdict.reason ?? ""}`.trim() : "not reported / no manager verdict yet";
    return { decision: decision(rec, "skip", `no PASS verdict (${why})`, false, {
      verdict: verdict.verdict,
      verdictSource: verdict.source,
    }) };
  }
  const streaming = isStreaming(rec.sessionId);
  if (streaming) {
    return { decision: decision(rec, "skip", "still streaming (streaming_pids entry present)", false, {
      verdict: verdict.verdict,
      verdictSource: verdict.source,
      streaming,
    }) };
  }
  const activity = sessionActivityMs(rec.sessionId);
  const idleMs = activity ? ctx.now - activity : undefined;
  if (idleMs !== undefined && idleMs < ctx.grace) {
    return { decision: decision(rec, "skip", `activity ${Math.round(idleMs / 1000)}s ago < grace ${Math.round(ctx.grace / 1000)}s`, false, {
      verdict: verdict.verdict,
      verdictSource: verdict.source,
      streaming,
      idleSeconds: Math.round(idleMs / 1000),
    }) };
  }

  // Verified PASS and idle. The terminal goes away in one of two shapes:
  //   (a) its window is still there -> verify the window, kill the window tree + any orphaned TUI;
  //   (b) the window exited on its own but its TUI is still alive -> close that orphaned TUI, which
  //       is all that is left of the terminal (otherwise a finished worker keeps holding RAM).
  // In both cases we only ever kill pids that jcode itself attributes to this session.
  const windowAlive = ctx.procs.has(rec.windowPid as number);
  // RULE 5, before anything else about this record: a recorded window that IS this process or one of
  // its ancestors is never a close target, whatever the registry says.
  if (ctx.own.has(rec.windowPid as number)) {
    return {
      decision: decision(
        rec,
        "skip",
        `PASS but not closable: pid ${rec.windowPid} is this process or one of its ancestors (the router's own tree)`,
        false,
        {
          verdict: verdict.verdict,
          verdictSource: verdict.source,
          streaming,
          idleSeconds: idleMs === undefined ? undefined : Math.round(idleMs / 1000),
        },
      ),
    };
  }
  const check = windowAlive ? verifyWindow(rec, ctx.procs, ctx.selfPid) : { ok: false, reason: `window pid ${rec.windowPid} is not running` };
  const orphans = windowAlive ? [] : liveClientPids(rec.sessionId);
  if (windowAlive && !check.ok) {
    return { decision: decision(rec, "skip", `PASS but not closable: ${check.reason}`, false, {
      verdict: verdict.verdict,
      verdictSource: verdict.source,
      streaming,
      idleSeconds: idleMs === undefined ? undefined : Math.round(idleMs / 1000),
    }) };
  }
  if (!windowAlive && orphans.length === 0) {
    return { decision: decision(rec, "window_gone", `PASS but the window is gone and no TUI client is left: ${check.reason}`, false, {
      verdict: verdict.verdict,
      verdictSource: verdict.source,
      streaming,
      idleSeconds: idleMs === undefined ? undefined : Math.round(idleMs / 1000),
    }) };
  }
  const idleSeconds = idleMs === undefined ? undefined : Math.round(idleMs / 1000);
  const closeReason = windowAlive
    ? check.reason
    : `window ${rec.windowPid} already gone; only its orphaned TUI client(s) ${orphans.join(", ")} remained`;
  // "execute" is the only mode that closes; the other two report what WOULD happen (the sync entry
  // point cannot wait for the async snapshot/taskkill, so it can only project).
  const closeText =
    ctx.mode === "execute"
      ? closeReason
      : ctx.mode === "dry"
        ? `WOULD CLOSE (dry run): ${closeReason}`
        : `WOULD CLOSE (sync evaluation; the async reaper pass performs the close): ${closeReason}`;
  return {
    decision: decision(rec, "close", closeText, false, {
      verdict: verdict.verdict,
      verdictSource: verdict.source,
      streaming,
      idleSeconds,
    }),
    close:
      ctx.mode === "execute"
        ? { rec, verdict, windowPid: rec.windowPid as number, windowAlive, check, orphans, streaming, idleSeconds }
        : undefined,
  };
}

// ── the guarded loop (started by src/server.ts after listen) ───────────

let timer: ReturnType<typeof setInterval> | undefined;
let lastPass: ReapPass | undefined;
let lastPassMs: number | undefined;

export function startTerminalReaper(): { intervalMs: number; running: boolean; dryRun: boolean; enabled: boolean } {
  const every = intervalMs();
  if (!autocloseEnabled()) {
    console.log("[autoclose] disabled (AUTOCLOSE=0); the terminal registry stays read-only");
    return { intervalMs: every, running: false, dryRun: autocloseDryRun(), enabled: false };
  }
  if (timer) return reaperStatus();
  // NOTE: deliberately NO warm-up refresh here. The first pass (one interval from now) fetches the
  // table, and a request path kicks its own background refresh, so the router's boot stays as light
  // as it was: on this RAM-starved laptop the supervisor kills a router that does not answer quickly,
  // and boot must not spawn extra PowerShell children for a nicety.
  // ASYNC on purpose: the table comes from execFile and every kill from the async taskkill helper, so
  // a pass can never block the HTTP server. runReaperPassAsync is re-entrancy guarded, so a slow
  // refresh cannot stack passes either.
  timer = setInterval(() => {
    void runReaperPassAsync()
      .then((pass) => {
        for (const d of pass.closed) {
          console.log(`[autoclose] closed ${d.sessionName} (${d.sessionId}): ${d.reason}; archive ${d.archive ?? "-"}`);
        }
      })
      .catch((e) => {
        // a broken pass must never take the control plane down with it
        console.error(`[autoclose] pass failed (router continues): ${String(e)}`);
      });
  }, every);
  // unref: the reaper must never be the reason this process cannot exit
  timer.unref?.();
  console.log(
    `[autoclose] reaper every ${every}ms, grace ${Math.round(graceMs() / 1000)}s` +
      `${autocloseDryRun() ? " (DRY RUN: nothing will be closed)" : ""} (async + unref'd: a pass never blocks the router and never keeps the process alive)`,
  );
  return reaperStatus();
}

export function stopTerminalReaper(): { running: boolean } {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
  return reaperStatus();
}

export function reaperStatus(): {
  intervalMs: number;
  running: boolean;
  dryRun: boolean;
  enabled: boolean;
  graceSeconds: number;
  registry: string;
  registered: number;
  lastPass?: { at: string; closed: number; decisions: number };
  lastPassMs?: number;
  /** true while a pass (or its process-table refresh) is in flight: the re-entrancy guard */
  passInFlight: boolean;
  passInFlightDryRun?: boolean;
  /** freshness of the cached process table every decision is verified against */
  processTable: { rows: number; ageMs?: number; refreshing: boolean; ready: boolean };
} {
  const table = processTableStatus();
  return {
    intervalMs: intervalMs(),
    running: Boolean(timer),
    dryRun: autocloseDryRun(),
    enabled: autocloseEnabled(),
    graceSeconds: Math.round(graceMs() / 1000),
    registry: registryFile(),
    registered: loadTerminals().length,
    lastPass: lastPass ? { at: lastPass.at, closed: lastPass.closed.length, decisions: lastPass.decisions.length } : undefined,
    lastPassMs,
    passInFlight: Boolean(passInFlight),
    passInFlightDryRun: passInFlight?.dryRun,
    processTable: { rows: table.rows, ageMs: table.ageMs, refreshing: table.refreshing, ready: table.ready },
  };
}

/**
 * Registry + live evidence for GET /company/terminals.
 * Non-blocking by default (THE ROUTE PATH): it reads the cached process table and kicks a background
 * refresh instead of spawning PowerShell on the request's stack, so the route answers in milliseconds
 * even while a refresh runs. Pass the table in (ops --status passes a freshly fetched one) when an
 * exact answer matters.
 */
export function listTerminals(procs?: ProcMap): Array<TerminalRec & {
  streaming: boolean;
  aliveClientPids: number[];
  idleSeconds?: number;
  windowOk: boolean;
  windowNote: string;
}> {
  const table = procs ?? cachedProcesses();
  const cold = table.size === 0;
  const now = Date.now();
  return loadTerminals().map((rec) => {
    const activity = sessionActivityMs(rec.sessionId);
    const check =
      rec.state === "closed"
        ? { ok: false, reason: "closed" }
        : cold
          ? { ok: false, reason: "process table not loaded yet (a background refresh is running); not verifiable right now" }
          : verifyWindow(rec, table);
    return {
      ...rec,
      streaming: isStreaming(rec.sessionId),
      aliveClientPids: liveClientPids(rec.sessionId),
      idleSeconds: activity ? Math.round((now - activity) / 1000) : undefined,
      windowOk: check.ok,
      windowNote: check.reason,
    };
  });
}
