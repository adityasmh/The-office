// ---------------------------------------------------------------------------
// loopWatchdog.ts - names the thing that blocked the event loop, caps log spam,
// and leaves evidence WHILE the loop is still blocked (ROUTER-HANG, 2026-09-30).
//
// The incident this answers: `/health` stopped answering for minutes at a time
// while the process showed 0 ms of CPU, timers inside it never fired (a
// PowerShell child with a 10 s hard-kill deadline was still alive 4 minutes
// later) and TCP connects to :8787 were dropped (the accept backlog filled).
// That is the signature of a *blocking syscall on the main thread*, not of JS
// work, a busy loop or GC. The old evidence could not say WHICH call it was:
// router.out.log simply stopped mid-line, and a restart destroyed the process
// state. Three gaps had to close:
//
//   1. ATTRIBUTION. When the loop is stuck, say what was running. `markBusy()`
//      sets a breadcrumb, `timeSyncOp()` times a synchronous section, and
//      `installSyncOpTracing()` wraps the `fs` sync primitives this codebase
//      uses so a slow/blocking `fs.readFileSync(<path>)` names itself. A block
//      is recorded with the breadcrumb + the last slow sync op in flight.
//
//   2. EVIDENCE WHILE BLOCKED. A blocked loop cannot run its own timers, so it
//      cannot write its own obituary. A worker thread shares a heartbeat
//      (SharedArrayBuffer + Atomics) with the main thread and writes a STALL
//      line to logs/router*.blocks.log from its own thread while the main
//      thread is still stuck. The supervisor's "no /health answer" then has a
//      timestamped, attributed cause attached to it.
//
//   3. LOG SPAM. router.out.log reached 10.4 MB with 2,465 full-object dumps
//      ("[DEBUG readOpenNeedsYouSync] briefing: {...}" ~7.6 KB per call, 246
//      newlines, written as ONE chunk). stdout/stderr are redirected to FILES by
//      ops/router-supervisor.ps1 (`1>> logs\router.out.log`), and Node writes
//      to file streams SYNCHRONOUSLY on the event loop, so every such dump is a
//      blocking 7.6 KB write on the main thread. `installLogCap()` truncates a
//      single line/chunk, collapses consecutive duplicates and enforces a
//      bytes/second budget.
//
// Cost per sampled tick: one Date.now(), one Atomics.store. Per traced fs call:
// two Date.now() reads. Nothing here allocates on the hot path unless something
// is genuinely slow. Every knob has an env override and an off switch.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";

// ── knobs ──────────────────────────────────────────────────────────────

function envNum(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function envOff(name: string): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  return raw === "0" || raw === "false" || raw === "off";
}

/** How often the main thread stamps its heartbeat / measures lag. */
export const SAMPLE_MS = envNum("ROUTER_LOOP_SAMPLE_MS", 100, 20);
/** A late tick this far behind schedule is reported as a loop block. */
export const BLOCK_REPORT_MS = envNum("ROUTER_BLOCK_REPORT_MS", 500, 50);
/** A synchronous op this slow is named in the log. */
export const SYNC_OP_REPORT_MS = envNum("ROUTER_SYNC_OP_REPORT_MS", 250, 10);
/** The worker writes a STALL line once the heartbeat is this stale. */
export const STALL_REPORT_MS = envNum("ROUTER_STALL_REPORT_MS", 5000, 500);
/** Longest single log write; longer chunks are truncated. 0 disables. */
export const MAX_LOG_LINE = envNum("ROUTER_LOG_MAX_LINE", 512, 0);
/** Log bytes/second budget; beyond it lines are dropped and counted. 0 disables. */
export const LOG_BUDGET_BPS = envNum("ROUTER_LOG_BUDGET_BPS", 1_000_000, 0);
/** Keep at most this many block / slow-op records in memory. */
const RING = envNum("ROUTER_LOOP_RING", 20, 1);

const LABEL_BYTES = 240;
const SAB_BYTES = 4096;
const LABEL_OFFSET = 64;

// ── state ──────────────────────────────────────────────────────────────

export type BlockRecord = {
  /** ISO time the block was detected (i.e. roughly when it ended). */
  at: string;
  /** How long the loop was late, in ms. */
  ms: number;
  /** Breadcrumb + slow sync op active around the block. */
  label: string;
  slowOp?: string;
};

export type SyncOpRecord = { at: string; ms: number; op: string; label: string };

export type LoopWatchStatus = {
  installed: boolean;
  sampleMs: number;
  blockReportMs: number;
  /** ms the loop was late on the most recent tick (0 when idle). */
  lagNowMs: number;
  /** worst block seen since boot */
  maxBlockMs: number;
  /** number of reported blocks since boot */
  blocks: number;
  lastBlock?: BlockRecord;
  /** worst/most recent synchronous op that named itself */
  lastSlowOp?: SyncOpRecord;
  /** the breadcrumb right now */
  busy: string;
  /** worker-thread stall evidence (works while this thread is blocked) */
  worker: { enabled: boolean; stallReports: number; stallMaxMs: number; lastStallMs: number; lastStallLabel: string };
  logCap: LogCapStatus;
  syncTrace: { enabled: boolean; wrapped: number };
};

let installed = false;
let sampleTimer: NodeJS.Timeout | undefined;
let flushTimer: NodeJS.Timeout | undefined;
let worker: Worker | undefined;
let logPath = "";

let busy = "idle";
let lagNow = 0;
let maxBlock = 0;
let blockCount = 0;
/** the breadcrumb as of the last sampler tick (a tick cannot see during a block) */
let labelAtTick = "idle";
/** when the sampler last ran: a block can only have started at or after this */
let lastTickAt = Date.now();
/**
 * The last few breadcrumb CHANGES with timestamps. A block is detected on the
 * sampler's next tick, by which time the caller has usually restored its label,
 * so the block is attributed to the first label that was set at or after the
 * block started (`tick - lag`). One Date.now() per label change, nothing per tick.
 */
const labelChanges: Array<{ label: string; at: number }> = [];
const blocks: BlockRecord[] = [];
const slowOps: SyncOpRecord[] = [];
let lastSlowOp: SyncOpRecord | undefined;

let sab: SharedArrayBuffer | undefined;
let i32: Int32Array | undefined;
let labelBytes: Uint8Array | undefined;
let labelWritten = "";
let lastWorkerStall: { reports: number; maxMs: number; lastMs: number; label: string } = {
  reports: 0,
  maxMs: 0,
  lastMs: 0,
  label: "",
};

// ── the evidence file ──────────────────────────────────────────────────

/** Port-appropriate evidence path (mirrors server.ts's crashLogPath rule). */
export function defaultBlockLogPath(port = Number(process.env.PORT ?? 8787)): string {
  const name = port === 8787 ? "router.blocks.log" : `router-${port}.blocks.log`;
  return path.join(process.cwd(), "logs", name);
}

let pending: string[] = [];
let writing = false;

/**
 * Append one line to the evidence file. ASYNC on purpose: this module exists
 * because synchronous I/O on the loop can wedge the process, so the watchdog
 * must not add any. Order is preserved by a single-flight drain.
 */
function evidence(line: string): void {
  if (!logPath) return;
  pending.push(`[${new Date().toISOString()}] ${line}\n`);
  if (pending.length > 200) pending = pending.slice(-200);
  if (writing) return;
  writing = true;
  drainEvidence();
}

function drainEvidence(): void {
  const chunk = pending.join("");
  pending = [];
  fs.appendFile(logPath, chunk, (err) => {
    writing = false;
    if (err) {
      // A watchdog that cannot write must stay silent, never fatal.
      pending = [];
      return;
    }
    if (pending.length) drainEvidence();
  });
}

// ── breadcrumbs + slow sync ops ────────────────────────────────────────

/** Say what is running right now. Cheap: one string compare unless it changed. */
export function markBusy(label: string): void {
  if (label === busy) return;
  busy = label;
  labelChanges.push({ label, at: Date.now() });
  if (labelChanges.length > 8) labelChanges.shift();
  if (labelBytes && i32 && labelWritten !== label) {
    labelWritten = label;
    const enc = Buffer.from(label.slice(0, LABEL_BYTES - 1), "utf8");
    const n = Math.min(enc.length, LABEL_BYTES - 1);
    labelBytes.fill(0);
    labelBytes.set(enc.subarray(0, n), 0);
    Atomics.store(i32, 1, n);
  }
}

/**
 * Which breadcrumb held the loop during the block that has just ended? The first
 * label change at/after the previous tick wins (a label set before the block
 * started is the one that was running when it started); otherwise the label the
 * previous tick saw. The block can only have started at or after `lastTickAt`,
 * which is why the estimate comes from the previous TICK and not from the lag.
 */
function attributeBlock(): string {
  for (const c of labelChanges) if (c.at >= lastTickAt - 2) return c.label;
  return labelAtTick;
}

export function busyLabel(): string {
  return busy;
}

/** Run `fn` with a breadcrumb set; the label is always restored. */
export function withBusy<T>(label: string, fn: () => T): T {
  const prev = busy;
  markBusy(label);
  try {
    return fn();
  } finally {
    markBusy(prev);
  }
}

/**
 * `withBusy` for an async section: plain `withBusy` restores the label as soon as the
 * promise is returned, so an `await`ed call site needs this one to hold the breadcrumb
 * for the whole operation (FIX 3 attribution, 2026-10-01).
 */
export async function withBusyAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const prev = busy;
  markBusy(label);
  try {
    return await fn();
  } finally {
    markBusy(prev);
  }
}

function recordSlowOp(op: string, ms: number): void {
  const rec: SyncOpRecord = { at: new Date().toISOString(), ms: Math.round(ms), op, label: busy };
  lastSlowOp = rec;
  slowOps.push(rec);
  if (slowOps.length > RING) slowOps.splice(0, slowOps.length - RING);
  evidence(`SLOW-SYNC ${rec.ms}ms ${op} label="${busy}"`);
}

/** Time a synchronous section and name it if it exceeds SYNC_OP_REPORT_MS. */
export function timeSyncOp<T>(op: string, fn: () => T): T {
  const t0 = Date.now();
  try {
    return fn();
  } finally {
    const ms = Date.now() - t0;
    if (ms >= SYNC_OP_REPORT_MS) recordSlowOp(op, ms);
  }
}

// The fs sync primitives this codebase actually uses. Named-import escapes are
// impossible to patch (an ESM named binding of a builtin is live and read-only),
// but every `import fs from "node:fs"` call site goes through this object.
const TRACED_FS = [
  "existsSync",
  "statSync",
  "lstatSync",
  "readFileSync",
  "readdirSync",
  "openSync",
  "readSync",
  "writeFileSync",
  "appendFileSync",
  "renameSync",
  "unlinkSync",
  "mkdirSync",
  "rmSync",
  "copyFileSync",
] as const;

let traced = 0;

/**
 * Wrap the fs sync API so a slow call names itself in the block log. Idempotent;
 * `ROUTER_SYNC_TRACE=0` disables it. Adds two Date.now() reads per fs sync call.
 */
export function installSyncOpTracing(): { enabled: boolean; wrapped: number } {
  if (envOff("ROUTER_SYNC_TRACE")) return { enabled: false, wrapped: traced };
  if (traced) return { enabled: true, wrapped: traced };
  const obj = fs as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of TRACED_FS) {
    const original = obj[name];
    if (typeof original !== "function") continue;
    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
      const t0 = Date.now();
      try {
        return original.apply(obj, args);
      } finally {
        const ms = Date.now() - t0;
        if (ms >= SYNC_OP_REPORT_MS) {
          const target = typeof args[0] === "string" ? (args[0] as string) : "";
          recordSlowOp(target ? `fs.${name}(${shortPath(target)})` : `fs.${name}`, ms);
        }
      }
    };
    Object.defineProperty(wrapper, "name", { value: name });
    obj[name] = wrapper;
    traced++;
  }
  return { enabled: true, wrapped: traced };
}

function shortPath(p: string): string {
  const cwd = process.cwd();
  // Only shorten a path that is genuinely INSIDE cwd: a bare prefix match on a
  // shorter path would slice away the drive and print nonsense.
  const rel = p.length > cwd.length + 1 && p.startsWith(cwd) ? p.slice(cwd.length + 1) : p;
  return rel.length > 80 ? `…${rel.slice(-79)}` : rel;
}

// ── the log cap ────────────────────────────────────────────────────────

export type LogCapStatus = {
  enabled: boolean;
  maxLine: number;
  budgetPerSec: number;
  truncatedChunks: number;
  truncatedBytes: number;
  collapsedLines: number;
  droppedLines: number;
  droppedBytes: number;
};

const logCap: LogCapStatus = {
  enabled: false,
  maxLine: MAX_LOG_LINE,
  budgetPerSec: LOG_BUDGET_BPS,
  truncatedChunks: 0,
  truncatedBytes: 0,
  collapsedLines: 0,
  droppedLines: 0,
  droppedBytes: 0,
};

/** Lines that must never be capped: the supervisor and ops scripts match them. */
const UNCAPPED =
  /(router on|starting router|BOOT|SUPERVISOR|listen|uncaughtException|UNCAUGHT_EXCEPTION|UNHANDLED_REJECTION|EXIT pid|\[log\] cap)/i;

const TRUNC_MARK = " …[line truncated by loopWatchdog]";

let prevChunk = "";
let prevRepeats = 0;
let windowStart = 0;
let windowBytes = 0;
let droppedThisWindow = 0;
let droppedBytesThisWindow = 0;
let bypass = false;

function capChunk(raw: string): string | null {
  let chunk = raw;
  // Lifecycle/crash lines are exempt from everything: the supervisor greps them and a
  // truncated stack trace would cost exactly the forensics this repo added in CRASHFIX.
  const exempt = UNCAPPED.test(chunk);
  if (!exempt && logCap.maxLine > 0 && chunk.length > logCap.maxLine) {
    const nl = chunk.indexOf("\n");
    // A multi-line chunk is what a full-object dump looks like: keep its first
    // line, then cut. A single long line is cut and keeps its newline so the log
    // stays line-parseable.
    const cut =
      nl >= 0 && nl + 1 < logCap.maxLine
        ? `${chunk.slice(0, nl + 1)}${chunk.slice(nl + 1, Math.max(nl + 1, logCap.maxLine))}${TRUNC_MARK}\n`
        : `${chunk.slice(0, logCap.maxLine)}${TRUNC_MARK}${chunk.endsWith("\n") ? "\n" : ""}`;
    logCap.truncatedChunks++;
    logCap.truncatedBytes += Math.max(0, chunk.length - cut.length);
    chunk = cut;
  }

  // Collapse a run of identical single lines. Only whole-line chunks are
  // collapsed: partial writes (streams that split a line) must keep their order.
  const now = Date.now();
  if (now - windowStart >= 1000) {
    if (droppedThisWindow > 0) {
      bypass = true;
      try {
        process.stdout.write(
          `[${new Date().toISOString()}] [log] cap: dropped ${droppedThisWindow} line(s) / ${Math.round(droppedBytesThisWindow / 1024)} KB in the last second (budget ${logCap.budgetPerSec} B/s)\n`,
        );
      } catch {
        /* never throw from the cap */
      }
      bypass = false;
    }
    windowStart = now;
    windowBytes = 0;
    droppedThisWindow = 0;
    droppedBytesThisWindow = 0;
  }

  if (chunk === prevChunk && chunk.endsWith("\n")) {
    prevRepeats++;
    logCap.collapsedLines++;
    return null;
  }
  if (prevRepeats > 0) {
    const n = prevRepeats;
    prevRepeats = 0;
    prevChunk = chunk;
    bypass = true;
    try {
      process.stdout.write(`[${new Date().toISOString()}] [log] cap: the previous line repeated ${n} more time(s)\n`);
    } catch {
      /* ignore */
    }
    bypass = false;
  } else {
    prevChunk = chunk;
  }

  windowBytes += chunk.length;
  if (logCap.budgetPerSec > 0 && windowBytes > logCap.budgetPerSec && !exempt) {
    droppedThisWindow++;
    droppedBytesThisWindow += chunk.length;
    logCap.droppedLines++;
    logCap.droppedBytes += chunk.length;
    return null;
  }
  return chunk;
}

/**
 * Cap what this process writes to stdout/stderr. Node writes file-backed
 * stdout/stderr SYNCHRONOUSLY on the event loop, and the supervisor redirects
 * both into logs/router*.log, so an oversized or repeated line is a blocking
 * syscall, not just noise. `ROUTER_LOG_CAP=0` disables it.
 */
export function installLogCap(): LogCapStatus {
  if (envOff("ROUTER_LOG_CAP") || logCap.enabled) return logCap;
  logCap.enabled = true;
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream) as (...args: unknown[]) => boolean;
    const patched = function (this: unknown, chunk: unknown, ...rest: unknown[]): boolean {
      try {
        if (bypass) return original(chunk, ...rest) as boolean;
        if (typeof chunk !== "string") {
          // Buffers: only size-cap them, never re-order.
          const buf = chunk instanceof Uint8Array ? chunk : null;
          if (buf && logCap.maxLine > 0 && buf.length > logCap.maxLine) {
            logCap.truncatedChunks++;
            logCap.truncatedBytes += buf.length - logCap.maxLine;
            const cut = Buffer.concat([Buffer.from(buf.subarray(0, logCap.maxLine)), Buffer.from(TRUNC_MARK + "\n")]);
            return original(cut, ...rest) as boolean;
          }
          return original(chunk, ...rest) as boolean;
        }
        const capped = capChunk(chunk);
        if (capped === null) return true;
        return original(capped, ...rest) as boolean;
      } catch {
        return original(chunk, ...rest) as boolean;
      }
    };
    (stream as unknown as { write: unknown }).write = patched;
  }
  // A repeating tail must still be visible when nothing else is written.
  flushTimer = setInterval(() => {
    if (prevRepeats > 0) {
      const n = prevRepeats;
      prevRepeats = 0;
      bypass = true;
      try {
        process.stdout.write(`[${new Date().toISOString()}] [log] cap: the previous line repeated ${n} more time(s)\n`);
      } catch {
        /* ignore */
      }
      bypass = false;
    }
  }, 5000);
  flushTimer.unref?.();
  return logCap;
}

// ── the sampler (in-process attribution) ───────────────────────────────

function recordBlock(ms: number, label: string): void {
  const rec: BlockRecord = {
    at: new Date().toISOString(),
    ms: Math.round(ms),
    label,
    ...(lastSlowOp ? { slowOp: lastSlowOp.op } : {}),
  };
  blockCount++;
  if (ms > maxBlock) maxBlock = ms;
  blocks.push(rec);
  if (blocks.length > RING) blocks.splice(0, blocks.length - RING);
  if (ms >= BLOCK_REPORT_MS) {
    evidence(`BLOCK ${rec.ms}ms label="${rec.label}"${rec.slowOp ? ` slowOp="${rec.slowOp}"` : ""}`);
  }
}

// ── the worker (evidence while the loop is blocked) ────────────────────

// Kept as a string so it needs no extra file and no loader: `eval: true` workers
// are regular CommonJS scripts, and the interval INSIDE the worker must stay ref'd
// (unref'ing it there makes the worker exit immediately).
const WORKER_SOURCE = `
const { workerData } = require('node:worker_threads');
const fs = require('node:fs');
const i32 = new Int32Array(workerData.sab);
const bytes = new Uint8Array(workerData.sab, workerData.labelOffset, workerData.labelBytes);
const decode = () => {
  const n = Atomics.load(i32, 1) | 0;
  return n > 0 ? Buffer.from(bytes.subarray(0, n)).toString('utf8') : '(unknown)';
};
const STALL_MS = workerData.stallMs;
const STAGES = [1, 6, 30, 60, 300];
let stallStart = 0;
let lastHb = Atomics.load(i32, 0);
let lastChange = Date.now();
let stage = 0;
const line = (text) => { try { fs.appendFileSync(workerData.log, text + '\\n'); } catch (e) { /* silent */ } };
line('[' + new Date().toISOString() + '] WATCHER started pid=' + workerData.pid + ' stallMs=' + STALL_MS + ' (independent thread: it reports while the main thread is stuck)');
tick();
function tick() {
  setTimeout(() => {
    try {
      const hb = Atomics.load(i32, 0);
      const now = Date.now();
      if (hb !== lastHb) {
        lastHb = hb;
        lastChange = now;
        if (stage > 0) {
          line('[' + new Date().toISOString() + '] STALL-END main thread resumed after ~' + Math.round((now - stallStart) / 1000) + 's (heartbeat ' + hb + ')');
          stage = 0;
        }
      }
      const stalled = now - lastChange;
      if (stalled >= STALL_MS) {
        const factor = STAGES[Math.min(stage, STAGES.length - 1)];
        if (stage === 0 || stalled >= STALL_MS * factor) {
          if (stage === 0) stallStart = now - stalled;
          Atomics.store(i32, 3, Atomics.load(i32, 3) + 1);
          Atomics.store(i32, 4, stalled);
          line('[' + new Date().toISOString() + '] STALL main thread blocked for ~' + Math.round(stalled / 1000) + 's label="' + decode() + '" hb=' + hb + ' (measured by the watchdog thread, which keeps running)');
          stage++;
        }
      }
    } catch (e) { /* the watchdog must never die loudly */ }
    tick();
  }, 250);
}
`;

function startWorker(opts: { port: number }): boolean {
  if (envOff("ROUTER_LOOP_WORKER")) return false;
  try {
    worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { sab, log: logPath, stallMs: STALL_REPORT_MS, labelOffset: LABEL_OFFSET, labelBytes: LABEL_BYTES, pid: process.pid },
    });
    worker.unref();
    worker.on("error", (e: unknown) => {
      evidence(`WATCHER-DEAD ${String(e)}`);
      worker = undefined;
    });
    return true;
  } catch (e) {
    evidence(`WATCHER-SPAWN-FAILED ${String(e)}`);
    worker = undefined;
    return false;
  }
}

function readWorkerStall(): void {
  if (!i32) return;
  const reports = Atomics.load(i32, 3);
  if (reports === lastWorkerStall.reports) return;
  lastWorkerStall = {
    reports,
    maxMs: Math.max(lastWorkerStall.maxMs, Atomics.load(i32, 4)),
    lastMs: Atomics.load(i32, 4),
    label: labelWritten,
  };
}

// ── install + status ───────────────────────────────────────────────────

export type LoopWatchdogOptions = {
  port?: number;
  logPath?: string;
  worker?: boolean;
  syncTrace?: boolean;
  logCap?: boolean;
};

/**
 * Start the watchdog. Idempotent and non-throwing: if anything here fails, the
 * router boots exactly as it did before.
 */
export function installLoopWatchdog(opts: LoopWatchdogOptions = {}): LoopWatchStatus {
  if (installed) return loopWatchStatus();
  installed = true;
  try {
    logPath = opts.logPath ?? defaultBlockLogPath(opts.port ?? Number(process.env.PORT ?? 8787));
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    sab = new SharedArrayBuffer(SAB_BYTES);
    i32 = new Int32Array(sab, 0, 8);
    labelBytes = new Uint8Array(sab, LABEL_OFFSET, LABEL_BYTES);
    if (opts.syncTrace !== false) installSyncOpTracing();
    if (opts.logCap !== false) installLogCap();

    let expected = Date.now() + SAMPLE_MS;
    sampleTimer = setInterval(() => {
      const now = Date.now();
      const lag = Math.max(0, now - expected);
      expected = now + SAMPLE_MS;
      lagNow = lag;
      if (i32) Atomics.add(i32, 0, 1);
      readWorkerStall();
      const label = attributeBlock();
      if (lag >= BLOCK_REPORT_MS) recordBlock(lag, label);
      labelAtTick = busy;
      lastTickAt = now;
    }, SAMPLE_MS);
    sampleTimer.unref?.();

    if (opts.worker !== false) startWorker({ port: opts.port ?? 0 });
    evidence(
      `WATCHDOG installed pid=${process.pid} log=${logPath} sampleMs=${SAMPLE_MS} blockReportMs=${BLOCK_REPORT_MS} ` +
        `syncOpReportMs=${SYNC_OP_REPORT_MS} stallReportMs=${STALL_REPORT_MS} maxLogLine=${logCap.maxLine} ` +
        `logBudgetBps=${logCap.budgetPerSec} syncTrace=${traced} worker=${worker ? "on" : "off"}`,
    );
  } catch (e) {
    evidence(`WATCHDOG-INSTALL-FAILED ${String(e)}`);
  }
  return loopWatchStatus();
}

export function loopWatchStatus(): LoopWatchStatus {
  if (i32) readWorkerStall();
  return {
    installed,
    sampleMs: SAMPLE_MS,
    blockReportMs: BLOCK_REPORT_MS,
    lagNowMs: Math.round(lagNow),
    maxBlockMs: Math.round(maxBlock),
    blocks: blockCount,
    ...(blocks.length ? { lastBlock: blocks[blocks.length - 1] } : {}),
    ...(lastSlowOp ? { lastSlowOp } : {}),
    busy,
    worker: {
      enabled: Boolean(worker),
      stallReports: lastWorkerStall.reports,
      stallMaxMs: Math.round(lastWorkerStall.maxMs),
      lastStallMs: Math.round(lastWorkerStall.lastMs),
      lastStallLabel: lastWorkerStall.label,
    },
    logCap: { ...logCap },
    syncTrace: { enabled: traced > 0, wrapped: traced },
  };
}

export function recentBlocks(): BlockRecord[] {
  return [...blocks];
}

export function recentSlowOps(): SyncOpRecord[] {
  return [...slowOps];
}

/** Test hook: forget everything (keeps the installed timers). */
export function resetLoopWatchdog(): void {
  blocks.length = 0;
  slowOps.length = 0;
  labelChanges.length = 0;
  lastSlowOp = undefined;
  blockCount = 0;
  maxBlock = 0;
  lagNow = 0;
  busy = "idle";
  labelAtTick = "idle";
  lastTickAt = Date.now();
  if (i32) {
    Atomics.store(i32, 3, 0);
    Atomics.store(i32, 4, 0);
  }
  lastWorkerStall = { reports: 0, maxMs: 0, lastMs: 0, label: "" };
}
