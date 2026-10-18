/**
 * Guarded workers view (WORKERS-LIVE, 2026-10-06) — the backend for the Terminals
 * page's "Guarded workers (headless, no window)" section.
 *
 * Guarded workers are started by ops/spawn-worker.ps1 and run with -WindowStyle
 * Hidden, so they have no window and never show up in the jcode terminal list.
 * This module reads the three files that already describe them:
 *   - logs/workers.json       the registry: one JSON object per line, written by
 *                             spawn-worker.ps1 when it starts a worker
 *                             (name, pid, log, startedAt, maxMinutes, maxUsd,
 *                             creationTime, provider, model, order, title).
 *   - logs/token-ledger.jsonl the guard's ledger: one JSON object per line, written
 *                             by ops/worker-guard.ps1 when a worker finishes or is
 *                             killed (name, turns, estUsd, endedBy, ...).
 *   - logs/queue.json         the wave's batch: a JSON array written by
 *                             ops/spawn-wave.ps1 (name, order, title, state, note,
 *                             updatedAt). TERMINALS-ALL (2026-10-06) surfaces the
 *                             entries still waiting or never started, so the page
 *                             can show queued work before a slot frees up.
 *
 * HARD RULES:
 *   1. READ-ONLY. Nothing here spawns, signals, stops or touches a process, and no
 *      file is ever written. The only process call is `process.kill(pid, 0)`, which
 *      merely asks whether a pid is alive.
 *   2. A malformed JSON line is skipped, never fatal. A missing file is an empty
 *      list, never an exception (workerTail reports "not found" instead of throwing).
 *   3. workerTail only ever resolves a file INSIDE the logs directory, and the name
 *      it accepts is `^[A-Za-z0-9-]+$`, so no path traversal is possible.
 *
 * Routes (src/server.ts):
 *   GET /company/workers                    -> listWorkers()
 *   GET /company/workers/:name/tail?lines=N -> workerTail(name, N)
 *
 * TERMINALS-ALL (2026-10-06): every worker now carries its task title and order, the
 * newest readable line of its log (lastActivity) and how long ago that log changed
 * (idleSec), so the Terminals page can show one list of every worker and what it is
 * doing. `queued` carries the wave's entries that are still waiting for a slot (or
 * were refused/skipped): they exist before any log does.
 */

import fs from "node:fs";
import path from "node:path";

// ── types ────────────────────────────────────────────────────────────────────

export type WorkerStatus = "running" | "finished" | "killed" | "stopped";

export type Worker = {
  name: string;
  pid: number;
  status: WorkerStatus;
  /** which provider the guard/spawner picked (registry field; absent on old rows) */
  provider?: string;
  /** the exact model id the worker runs (registry field; absent on old rows) */
  model?: string;
  startedAt: string;
  elapsedSec: number;
  maxMinutes: number;
  maxUsd: number;
  /** ledger only: how many model turns the guard counted */
  turns?: number;
  /** ledger only: the guard's cost estimate in USD */
  estUsd?: number;
  /** ledger only: why it ended, e.g. "finished", "killed:repeat-line x6" */
  endedBy?: string;
  /** the task it was ordered to do: the order's first heading (registry field; falls
   *  back to the first non-empty line of the worker's log when the registry is old) */
  title?: string;
  /** the order file it was handed (registry field; absent on old rows) */
  order?: string;
  /** the newest readable line of its log, thoughts joined, one short line (≤120 chars) */
  lastActivity?: string;
  /** seconds since its log last changed; undefined when no log was found */
  idleSec?: number;
};

/** A logs/queue.json entry that has not run yet (or never will). */
export type QueuedWorker = {
  name: string;
  state: "queued" | "refused" | "skipped";
  /** 1-based place in the queue, only for entries still waiting for a slot */
  position?: number;
  /** the wave's own ordering number, when the writer gave one */
  order?: number;
  /** the order's first heading, so the card can name the task */
  title?: string;
  /** why it was refused or skipped (shown in the warning colour) */
  note?: string;
  /** when the queue entry was last written by the wave */
  updatedAt?: string;
};

export type WorkersView = {
  /** registry rows whose pid is alive and which have no ledger line yet */
  live: Worker[];
  /** the last 15 ledger entries, newest first, joined to the registry by name */
  recent: Worker[];
  /** logs/queue.json entries still waiting for a slot, plus refused and skipped ones */
  queued: QueuedWorker[];
};

export type WorkerTail = {
  name: string;
  /** chronological: oldest first, newest last (the UI scrolls to the bottom) */
  lines: string[];
  /** set when there is no readable log; the route turns this into a 404 */
  error?: string;
};

// ── knobs ────────────────────────────────────────────────────────────────────

const RECENT_MAX = 15; // ledger rows shown in "Recently finished"
const TAIL_MAX_BYTES = 8 * 1024; // hard cap on what workerTail returns
const TAIL_READ_BYTES = 256 * 1024; // how much of the log is read (the end)
const ACTIVITY_MAX = 120; // lastActivity is one short readable line
const TITLE_MAX = 200; // the log-fallback title is one line, capped
const TITLE_READ_BYTES = 16 * 1024; // how much of a log's head is read for the fallback title
const NAME_RE = /^[A-Za-z0-9-]+$/;
/** The marker jcode prints before each streamed thought fragment (U+1F4AD). */
const THOUGHT = "\u{1F4AD}";
/** A thought line: the marker at the start, optional indent, then one tiny piece. */
const THOUGHT_RE = /^\s*\u{1F4AD}/u;
/** Remove the marker and ONE following space (ops/worker-guard.ps1 does the same,
 *  so the fragments concatenate back into the sentence the model thought). */
const THOUGHT_STRIP = /^\s*\u{1F4AD} ?/u;
/** ANSI colour/cursor escapes: strip them so the tail is plain text. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B[@-Z\\-_]/g;

function logsRoot(root?: string): string {
  const r = root === undefined || root === null ? "" : String(root);
  return r ? r : path.join(process.cwd(), "logs");
}

// ── small helpers ────────────────────────────────────────────────────────────

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function optNum(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Read a JSON-lines file, skipping blank and malformed lines. Never throws. */
function readJsonLines(file: string): Array<Record<string, unknown>> {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const v = JSON.parse(line) as unknown;
      if (v && typeof v === "object") out.push(v as Record<string, unknown>);
    } catch {
      // malformed line (a partial write, a truncated read): skip it, never throw
    }
  }
  return out;
}

/** Read a JSON array file (logs/queue.json). A missing or malformed file is an
 *  empty array, never an exception: a partial write must not blank the page. */
function readJsonArray(file: string): Array<Record<string, unknown>> {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  try {
    const v = JSON.parse(text) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((x) => x !== null && typeof x === "object") as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}

function mtimeMs(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return -1;
  }
}

/** The last `maxBytes` bytes of a file (the tail), decoded as UTF-8. Never throws.
 *  When the read starts mid-file the first (partial) line is dropped. */
function readTailBounded(file: string, maxBytes: number): string {
  let fd: number | null = null;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    if (len <= 0) return "";
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    let text = buf.toString("utf8", 0, n);
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : text;
    }
    return text;
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function stripAnsi(s: string): string {
  return String(s).replace(ANSI_RE, "");
}

// ── log-derived fields (TERMINALS-ALL) ───────────────────────────────────────

/** Collapse to ONE line and cap it, so a card never grows a paragraph. */
function clip(s: string, max: number): string {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "\u2026" : t;
}

/** The newest readable non-.err log for a validated worker name, as a base name,
 *  or null. Mirrors workerTail's pick so both agree on "the log". Never throws. */
function newestLogFile(dir: string, name: string): string | null {
  if (!NAME_RE.test(name)) return null;
  let candidates: string[] = [];
  try {
    candidates = fs.readdirSync(dir).filter(
      (f) => f.startsWith(`jcode-${name}-`) && f.endsWith(".log") && !f.endsWith(".err.log"),
    );
  } catch {
    return null;
  }
  let best: string | null = null;
  let bestAt = -1;
  for (const f of candidates) {
    const at = mtimeMs(path.join(dir, f));
    if (at > bestAt) {
      bestAt = at;
      best = f;
    }
  }
  return best;
}

/** Turn raw log text into readable lines: ANSI stripped, blank lines dropped, and
 *  each run of thought-marker fragments joined back into one sentence. */
function readableLines(raw: string): string[] {
  const out: string[] = [];
  let thought: string | null = null;
  const flush = () => {
    if (thought === null) return;
    // Each fragment is a separate tiny line, so the joining space can land before
    // a punctuation mark ("files ."): close it back up, which is what the model
    // actually thought. Everything else is left exactly as streamed.
    const t = thought.trim().replace(/\s+([,.!?;:)\]])/g, "$1");
    if (t) out.push(t);
    thought = null;
  };

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = stripAnsi(rawLine);
    if (THOUGHT_RE.test(line)) {
      thought = (thought === null ? "" : thought) + line.replace(THOUGHT_STRIP, "");
      continue;
    }
    flush();
    if (line.trim() !== "") out.push(line);
  }
  flush();
  return out;
}

/** The first non-empty line of a file, ANSI and thought marker stripped, capped:
 *  the fallback task title for a registry row that predates the `title` field. */
function firstLineOf(file: string, maxBytes: number): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    for (const rawLine of buf.toString("utf8", 0, n).split(/\r?\n/)) {
      const line = stripAnsi(rawLine).replace(THOUGHT_STRIP, "").trim();
      if (line) return line.slice(0, TITLE_MAX);
    }
    return "";
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/** Everything listWorkers can learn from a worker's own log. A missing log leaves
 *  idleSec/lastActivity/firstLine undefined/empty instead of throwing. */
type LogInfo = { idleSec?: number; lastActivity?: string; firstLine?: string };

function logInfo(dir: string, name: string): LogInfo {
  const base = newestLogFile(dir, name);
  if (!base) return {};
  const full = path.join(dir, base);
  const mtime = mtimeMs(full);
  const idleSec = mtime >= 0 ? Math.max(0, Math.round((Date.now() - mtime) / 1000)) : undefined;
  const lines = readableLines(readTailBounded(full, TAIL_READ_BYTES));
  const last = lines.length ? lines[lines.length - 1] : "";
  return {
    idleSec,
    lastActivity: last ? clip(last, ACTIVITY_MAX) : undefined,
    firstLine: firstLineOf(full, TITLE_READ_BYTES),
  };
}

/** Attach title/order/lastActivity/idleSec to a worker row. A finished worker's
 *  log stops changing when it ends, so its mtime is the best end time we have:
 *  that fills the "total time" a card shows for a settled worker. */
function decorate(w: Worker, dir: string, reg: Record<string, unknown> | undefined): Worker {
  if (!w.title && reg && reg.title) w.title = String(reg.title);
  if (!w.order && reg && reg.order) w.order = String(reg.order);
  const info = logInfo(dir, w.name);
  if (info.idleSec !== undefined) w.idleSec = info.idleSec;
  if (info.lastActivity) w.lastActivity = info.lastActivity;
  if (!w.title && info.firstLine) w.title = info.firstLine;
  if (w.status !== "running" && info.idleSec !== undefined) {
    const started = Date.parse(w.startedAt);
    const endedMs = Date.now() - info.idleSec * 1000;
    if (Number.isFinite(started) && endedMs > started) w.elapsedSec = Math.round((endedMs - started) / 1000);
  }
  return w;
}

/** logs/queue.json rows that have not run yet: queued (waiting for a slot), plus
 *  refused and skipped. A `running` entry is not queued (it is in `live`), and one
 *  whose worker is already gone has finished, so neither is listed here. */
function queuedRows(dir: string): QueuedWorker[] {
  const out: QueuedWorker[] = [];
  for (const q of readJsonArray(path.join(dir, "queue.json"))) {
    const name = typeof q.name === "string" ? q.name : "";
    if (!name) continue;
    const raw = String(q.state ?? "");
    if (raw !== "queued" && raw !== "refused" && raw !== "skipped") continue;
    out.push({
      name,
      state: raw as QueuedWorker["state"],
      order: optNum(q.order),
      title: typeof q.title === "string" && q.title ? q.title : undefined,
      note: typeof q.note === "string" && q.note ? q.note : undefined,
      updatedAt: typeof q.updatedAt === "string" && q.updatedAt ? q.updatedAt : undefined,
    });
  }
  out.sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
  let position = 0;
  for (const q of out) if (q.state === "queued") q.position = ++position;
  return out;
}

// ── row builders ─────────────────────────────────────────────────────────────

function statusFromEndedBy(endedBy: string): WorkerStatus {
  if (endedBy.startsWith("killed")) return "killed";
  if (endedBy === "stopped") return "stopped";
  return "finished";
}

function liveWorker(e: Record<string, unknown>, pid: number): Worker {
  const startedAt = e.startedAt === undefined || e.startedAt === null ? "" : String(e.startedAt);
  const started = Date.parse(startedAt);
  const elapsedSec = Number.isFinite(started) ? Math.max(0, Math.round((Date.now() - started) / 1000)) : 0;
  return {
    name: String(e.name),
    pid,
    status: "running",
    provider: e.provider ? String(e.provider) : undefined,
    model: e.model ? String(e.model) : undefined,
    startedAt,
    elapsedSec,
    maxMinutes: num(e.maxMinutes),
    maxUsd: num(e.maxUsd),
  };
}

function recentWorker(l: Record<string, unknown>, e: Record<string, unknown> | undefined): Worker {
  const endedBy = l.endedBy === undefined || l.endedBy === null || l.endedBy === "" ? "finished" : String(l.endedBy);
  return {
    name: String(l.name),
    pid: e ? num(e.pid) : 0,
    status: statusFromEndedBy(endedBy),
    provider: e && e.provider ? String(e.provider) : undefined,
    model: e && e.model ? String(e.model) : undefined,
    startedAt: e && e.startedAt ? String(e.startedAt) : "",
    // The ledger has no end timestamp: decorate() fills this from the log's mtime
    // when a log exists, and it stays 0 when there is none.
    elapsedSec: 0,
    maxMinutes: e ? num(e.maxMinutes) : 0,
    maxUsd: e ? num(e.maxUsd) : 0,
    turns: optNum(l.turns),
    estUsd: optNum(l.estUsd),
    endedBy,
  };
}

// ── listWorkers ──────────────────────────────────────────────────────────────

/**
 * The guarded workers, in two groups.
 *
 * `live` = a registry row whose pid is alive AND whose run has no ledger line yet.
 *   A name can be reused across runs (each run appends a registry row and, when it
 *   ends, a ledger line), so runs are paired in order: the i-th registry row for a
 *   name has a ledger line only once there are more than i ledger lines for it.
 * `recent` = the last RECENT_MAX ledger lines (newest first), each joined to the
 *   registry row of the same name when one exists.
 * `queued` = logs/queue.json entries that have not run: queued, refused, skipped.
 *
 * Every `live`/`recent` row is then decorated from its own log: its task title (the
 * registry's `title`, else the log's first line), the newest readable line
 * (lastActivity) and how long ago that log changed (idleSec). A missing log simply
 * leaves those fields empty; nothing here throws.
 */
export function listWorkers(root?: string): WorkersView {
  const dir = logsRoot(root);
  const entries = readJsonLines(path.join(dir, "workers.json")).filter(
    (e) => typeof e.name === "string" && e.name !== "" && Number.isFinite(Number(e.pid)),
  );
  const ledger = readJsonLines(path.join(dir, "token-ledger.jsonl")).filter(
    (l) => typeof l.name === "string" && l.name !== "",
  );

  const ledgerByName = new Map<string, Array<Record<string, unknown>>>();
  for (const l of ledger) {
    const name = String(l.name);
    const arr = ledgerByName.get(name) ?? [];
    arr.push(l);
    ledgerByName.set(name, arr);
  }

  const live: Worker[] = [];
  const runIndex = new Map<string, number>();
  for (const e of entries) {
    const name = String(e.name);
    const idx = runIndex.get(name) ?? 0;
    runIndex.set(name, idx + 1);
    const settled = idx < (ledgerByName.get(name)?.length ?? 0); // this run already ended
    const pid = num(e.pid);
    if (!settled && pidAlive(pid)) live.push(decorate(liveWorker(e, pid), dir, e));
  }

  // Newest registry row for a name wins when joining a ledger line back to it.
  const regByName = new Map<string, Record<string, unknown>>();
  for (const e of entries) regByName.set(String(e.name), e);

  const recent: Worker[] = [];
  for (const l of ledger.slice(-RECENT_MAX).reverse()) {
    const reg = regByName.get(String(l.name));
    recent.push(decorate(recentWorker(l, reg), dir, reg));
  }

  return { live, recent, queued: queuedRows(dir) };
}

// ── workerTail ───────────────────────────────────────────────────────────────

/**
 * The last `lines` readable lines of a worker's stdout log
 * (logs/jcode-<name>-*.log, newest match; the .err.log is ignored).
 *
 * An invalid name throws (the route answers 400). A missing log is a graceful
 * `{ lines: [], error }` result (the route answers 404), never a crash.
 *
 * jcode streams a thought as many tiny lines that each start with the thought
 * marker and carry one word or one punctuation mark. Those consecutive marker
 * lines are joined back into ONE line so the tail reads as sentences.
 */
export function workerTail(name: string, lines = 40, root?: string): WorkerTail {
  if (typeof name !== "string" || !NAME_RE.test(name)) throw new Error("invalid worker name");
  const dir = path.resolve(logsRoot(root));
  const want = Math.max(1, Math.min(500, Math.floor(num(lines, 40)) || 40));

  let candidates: string[] = [];
  try {
    candidates = fs.readdirSync(dir).filter(
      (f) => f.startsWith(`jcode-${name}-`) && f.endsWith(".log") && !f.endsWith(".err.log"),
    );
  } catch {
    candidates = [];
  }
  if (!candidates.length) return { name, lines: [], error: "no log found for this worker" };

  const best = newestLogFile(dir, name);
  if (!best) return { name, lines: [], error: "no log found for this worker" };

  // Belt and braces: the validated name plus the prefix filter already make
  // traversal impossible; this proves the resolved path is still inside logs/.
  const full = path.resolve(dir, best);
  const rel = path.relative(dir, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { name, lines: [], error: "no log found for this worker" };
  }

  const raw = readTailBounded(full, TAIL_READ_BYTES);
  if (!raw) return { name, lines: [], error: "no log found for this worker" };

  const out = readableLines(raw);

  // Keep the newest `want` lines (the array is chronological), then the 8 KB cap.
  let kept = out.length > want ? out.slice(out.length - want) : out;
  while (kept.length > 1 && Buffer.byteLength(kept.join("\n"), "utf8") > TAIL_MAX_BYTES) kept = kept.slice(1);
  if (kept.length === 1 && Buffer.byteLength(kept[0], "utf8") > TAIL_MAX_BYTES) {
    kept = [Buffer.from(kept[0], "utf8").subarray(0, TAIL_MAX_BYTES).toString("utf8")];
  }

  return { name, lines: kept };
}

/** The thought marker, exported so callers/tests can build real log lines. */
export const THOUGHT_MARKER = THOUGHT;
