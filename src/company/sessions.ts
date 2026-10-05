import fs from "node:fs";
import path from "node:path";
import { getCompanyRoot } from "./org.js";

// ---------------------------------------------------------------------------
// Session registry — one record per agent run (opencode child process OR a
// router LLM call). The CEO dashboard reads this to show what is running, what
// is queued and what finished, with elapsed time, cost and the tail of output.
//
// Storage: in-memory Map is the read model; every mutation appends a FULL
// SessionRec snapshot as one JSONL line (append-only => crash safe), and the
// file is replayed on first use with last-write-wins per id. In-memory state is
// capped to the newest MAX_IN_MEMORY sessions and the file is rewritten
// compacted once it exceeds COMPACT_AT_LINES lines, so it cannot grow forever.
//
// PERF (docs/PERF_SPEC.md item 3, 2026-09-29). Two measured problems, both fixed
// here without changing the file format:
//   1. every output chunk appended a whole snapshot, so sessions.jsonl reached
//      3.6 MB in one session (1564 lines, ~2.3 KB per line) and every boot
//      replayed all of it. The tail of a run's output now goes to
//      company/sessions/<id>.tail (capped, trimmed in place), and the JSONL gets
//      a snapshot at most once per SNAPSHOT_MIN_MS per session - plus always on
//      any status change and on finish, so the last state of every session is in
//      the file. reconcileStaleSessions() and usage.ts read the same lines as
//      before; only the chunk-snapshot frequency changed.
//   2. listSessions() re-sorted and re-cloned the registry on every call, and
//      budget.ts calls listSessions(500) once per agent (~40 per dashboard poll),
//      i.e. ~20k record clones with 2 KB output tails each. The sorted order is
//      now memoised per registry revision and the cloned result per
//      (revision, limit). Callers still get a private array of copies.
//
// Every write is best-effort: a metrics failure must never break a real run.
// ---------------------------------------------------------------------------

export type SessionStatus = "queued" | "running" | "done" | "error";

export type SessionRec = {
  id: string; // unique, e.g. s<ts>-<agentId>
  agentId: string; // e.g. "coder-1", "manager", "assistant"
  agentName: string; // display name
  role: string; // RoleId
  departmentId: string; // "d..." id or "d-ceo" for the assistant
  departmentName: string; // "Engineering", "Executive", ...
  projectId: string;
  projectName: string;
  taskId: string | null;
  taskTitle: string; // the exact work item this session is doing
  model: string; // modelId used
  status: SessionStatus;
  startedAt: string; // ISO
  finishedAt?: string;
  durationMs?: number;
  pid?: number; // child process pid when opencode-backed
  lastText?: string; // last chunk of output (<= 2000 chars)
  costUsd?: number; // charged to the agent budget for this run
  runtime?: "opencode" | "router";
};

export type SessionContext = {
  agentId: string;
  agentName: string;
  role: string;
  departmentId: string;
  departmentName: string;
  projectId: string;
  projectName: string;
  taskId?: string | null;
  taskTitle: string;
  model: string;
  runtime?: "opencode" | "router";
};

const MAX_IN_MEMORY = 500;
const COMPACT_AT_LINES = 2000;
const LAST_TEXT_CHARS = 2000;

function envMs(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

// At most one JSONL snapshot per session per this window (0 = one per chunk).
const SNAPSHOT_MIN_MS = envMs("SESSION_SNAPSHOT_MIN_MS", 1000);
// Tail file: flush when this much text is pending, at least this often.
const TAIL_FLUSH_CHARS = 512;
const TAIL_FLUSH_MIN_MS = 500;
const TAIL_CAP_CHARS = 4000; // kept per session after a trim
const TAIL_TRIM_AT_CHARS = 4 * TAIL_CAP_CHARS; // trim once it passes this

let store: Map<string, SessionRec> | null = null;
let fileLines = 0;

// Monotonic revision counters. `rev` moves on ANY change to the registry (used
// to invalidate the read caches below); `statusRev` moves only when a session's
// status changes (used by callers - e.g. the panel's budget rollup - that do not
// care about output text). Both are exported as the invalidation API for code
// that memoises session-derived data: a caller that only counts running sessions
// should key on sessionsStatusRevision() and NOT on sessionsRevision(), otherwise
// every output chunk invalidates it.
let rev = 0;
let statusRev = 0;

export function sessionsRevision(): number {
  return rev;
}

export function sessionsStatusRevision(): number {
  return statusRev;
}

let sortedCache: { rev: number; sorted: SessionRec[] } | null = null;
const listCache = new Map<string, SessionRec[]>();

function invalidateReadCaches(): void {
  sortedCache = null;
  if (listCache.size) listCache.clear();
}

// Output tails live beside the registry, one small file per session. The id is
// generated here but its agentId part comes from callers, so it is never used as
// a path segment unchecked.
function tailsDir(): string {
  return path.join(getCompanyRoot(), "sessions");
}

function tailFileFor(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "session";
  return path.join(tailsDir(), `${safe}.tail`);
}

type PendingTail = { text: string; flushedAt: number; lastSnapshotAt: number };
const pendingTails = new Map<string, PendingTail>();
const MAX_PENDING_TAILS = 1000;

// Read at most the last `maxChars` characters of a file (used for the tail file
// and for restoring lastText after a restart).
function readTailText(file: string, maxChars: number): string {
  const st = fs.statSync(file);
  const bytes = Math.min(st.size, maxChars * 4);
  if (bytes <= 0) return "";
  const buf = Buffer.allocUnsafe(bytes);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buf, 0, bytes, st.size - bytes);
  } finally {
    fs.closeSync(fd);
  }
  const text = buf.toString("utf8");
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

// Append the buffered tail text to its own file. Cheap on purpose: small appends,
// and a trim (temp + rename) only once the file has grown well past the cap.
function flushTail(id: string, force = false): void {
  const p = pendingTails.get(id);
  if (!p) return;
  if (!p.text && !force) return;
  const now = Date.now();
  if (!force && p.text.length < TAIL_FLUSH_CHARS && now - p.flushedAt < TAIL_FLUSH_MIN_MS) return;
  try {
    fs.mkdirSync(tailsDir(), { recursive: true });
    const file = tailFileFor(id);
    if (p.text) fs.appendFileSync(file, p.text);
    p.text = "";
    p.flushedAt = now;
    const st = fs.statSync(file);
    if (st.size > TAIL_TRIM_AT_CHARS) {
      const tail = readTailText(file, TAIL_CAP_CHARS);
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, tail);
      fs.renameSync(tmp, file);
    }
  } catch {
    // metrics must never break a run
  }
}

// Fold any text still buffered into the registry record, so an abrupt end of the
// process does not lose the last few hundred characters.
export function flushSessionTails(): void {
  for (const id of [...pendingTails.keys()]) flushTail(id, true);
}

function sessionsFile(): string {
  return path.join(getCompanyRoot(), "sessions.jsonl");
}

// Newest first. Map insertion order is chronological (append order), and
// Array#sort is stable, so ties keep their append order.
function byNewest(a: SessionRec, b: SessionRec): number {
  const at = a.startedAt ?? "";
  const bt = b.startedAt ?? "";
  return bt.localeCompare(at);
}

function clone(rec: SessionRec): SessionRec {
  return { ...rec };
}

// Timestamped backup name (Windows-safe).
function backupFileName(file: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${file}.backup.${ts}`;
}

function backupSessionsFile(file: string): boolean {
  try {
    if (!fs.existsSync(file)) return true;
    fs.copyFileSync(file, backupFileName(file));
    return true;
  } catch {
    return false;
  }
}

// Rewrite the file with only the newest MAX_IN_MEMORY snapshots (atomic-ish:
// temp file + rename). Called on growth and on startup replay. A backup copy is
// written first and nothing is deleted; the backup preserves the pre-compaction
// JSONL exactly as it was on disk.
function compactNow(m: Map<string, SessionRec>): void {
  const newest = [...m.values()].sort(byNewest).slice(0, MAX_IN_MEMORY).reverse();
  const file = sessionsFile();
  const body = newest.length ? newest.map((r) => JSON.stringify(r)).join("\n") + "\n" : "";
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!backupSessionsFile(file)) return;
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
    fileLines = newest.length;
  } catch {
    // Keep the in-memory view authoritative; a later append can retry.
  }
}

function ensureLoaded(): Map<string, SessionRec> {
  if (store) return store;
  const m = new Map<string, SessionRec>();
  store = m;
  fileLines = 0;
  const file = sessionsFile();
  try {
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
      fileLines = lines.length;
      for (const line of lines) {
        try {
          const rec = JSON.parse(line) as SessionRec;
          if (!rec || typeof rec.id !== "string") continue;
          // last write wins per id; re-insert so ordering follows the log
          m.delete(rec.id);
          m.set(rec.id, rec);
        } catch {
          // skip malformed line
        }
      }
    }
  } catch {
    // unreadable log: start from whatever we managed to read
  }
  const capped = [...m.values()].sort(byNewest).slice(0, MAX_IN_MEMORY).reverse();
  m.clear();
  for (const rec of capped) m.set(rec.id, rec);
  // Chunk snapshots are throttled, so the record on disk can be a moment behind
  // the per-session tail file. At boot the tail file wins when it differs.
  for (const rec of m.values()) restoreLastTextFromTail(rec);
  // Boot compaction: if the JSONL contains duplicate snapshots (fileLines > the
  // number of unique sessions kept in memory) or it has grown past the hard
  // threshold, rewrite it to one last-state line per session. A backup is written
  // first and the original is never deleted.
  if (fileLines > m.size || fileLines > COMPACT_AT_LINES) compactNow(m);
  return m;
}

function restoreLastTextFromTail(rec: SessionRec): void {
  // Never overwrite an annotation this module wrote on a previous boot.
  if ((rec.lastText ?? "").includes("[stale:")) return;
  try {
    const tail = readTailText(tailFileFor(rec.id), LAST_TEXT_CHARS);
    if (tail && tail !== rec.lastText) rec.lastText = tail;
  } catch {
    // no tail file (older data, or the run never produced output): keep the JSONL value
  }
}

// A server restart orphans anything that was in flight: the child process and the
// in-process HTTP call died with the old process, but the on-disk record still
// says "running". Mark those as error on boot so the dashboard never shows a
// ghost session as if it were live (observed 2026-09-29: a killed server left an
// enhancer row "running" forever, which made the CEO board lie).
export function reconcileStaleSessions(reason = "server restarted while this session was in flight"): number {
  const m = ensureLoaded();
  let fixed = 0;
  const now = Date.now();
  for (const rec of [...m.values()]) {
    if (rec.status !== "running" && rec.status !== "queued") continue;
    const startedMs = Date.parse(rec.startedAt);
    put({
      ...rec,
      status: "error",
      finishedAt: new Date(now).toISOString(),
      durationMs: Number.isFinite(startedMs) ? now - startedMs : rec.durationMs,
      lastText: `${rec.lastText ?? ""}\n[stale: ${reason}]`.trim().slice(-LAST_TEXT_CHARS),
    });
    fixed++;
  }
  return fixed;
}

function append(rec: SessionRec): void {
  try {
    const file = sessionsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + "\n");
    fileLines++;
    if (fileLines > COMPACT_AT_LINES) compactNow(ensureLoaded());
  } catch {
    // metrics must never break a run
  }
}

function put(rec: SessionRec): SessionRec {
  const m = ensureLoaded();
  const prev = m.get(rec.id);
  if (!prev || prev.status !== rec.status) statusRev++;
  m.set(rec.id, rec);
  append(rec);
  rev++;
  invalidateReadCaches();
  return clone(rec);
}

function newId(agentId: string): string {
  const base = `s${Date.now().toString(36)}-${agentId}`;
  const m = ensureLoaded();
  if (!m.has(base)) return base;
  let n = 2;
  while (m.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function fromContext(ctx: SessionContext, status: SessionStatus): SessionRec {
  return {
    id: newId(ctx.agentId),
    agentId: ctx.agentId,
    agentName: ctx.agentName,
    role: ctx.role,
    departmentId: ctx.departmentId,
    departmentName: ctx.departmentName,
    projectId: ctx.projectId,
    projectName: ctx.projectName,
    taskId: ctx.taskId ?? null,
    taskTitle: ctx.taskTitle,
    model: ctx.model,
    status,
    startedAt: new Date().toISOString(),
    ...(ctx.runtime ? { runtime: ctx.runtime } : {}),
  };
}

export function startSession(ctx: SessionContext): SessionRec {
  return put(fromContext(ctx, "running"));
}

export function queueSession(ctx: SessionContext): SessionRec {
  return put(fromContext(ctx, "queued"));
}

export function updateSession(id: string, patch: Partial<SessionRec>): SessionRec | undefined {
  const m = ensureLoaded();
  const rec = m.get(id);
  if (!rec) return undefined;
  const next: SessionRec = { ...rec, ...patch, id: rec.id };
  return put(next);
}

// A chunk of a run's output. The in-memory record is always current; the output
// itself goes to the per-session tail file, and the JSONL only gets a snapshot
// once per SNAPSHOT_MIN_MS (see the header). Status changes go through put() and
// always write a snapshot, so the file's last state per session stays correct.
export function chunkSession(id: string, text: string): void {
  if (!text) return;
  try {
    const m = ensureLoaded();
    const rec = m.get(id);
    if (!rec) return;
    rec.lastText = `${rec.lastText ?? ""}${text}`.slice(-LAST_TEXT_CHARS);
    rev++;
    invalidateReadCaches();

    let p = pendingTails.get(id);
    if (!p) {
      if (pendingTails.size >= MAX_PENDING_TAILS) {
        const oldest = pendingTails.keys().next();
        if (!oldest.done) {
          flushTail(oldest.value, true);
          pendingTails.delete(oldest.value);
        }
      }
      p = { text: "", flushedAt: Date.now(), lastSnapshotAt: 0 };
      pendingTails.set(id, p);
    }
    p.text += text;
    flushTail(id);
    const now = Date.now();
    if (SNAPSHOT_MIN_MS <= 0 || now - p.lastSnapshotAt >= SNAPSHOT_MIN_MS) {
      p.lastSnapshotAt = now;
      append(rec);
    }
  } catch {
    // metrics must never break a run
  }
}

export function finishSession(
  id: string,
  status: "done" | "error",
  opts: { text?: string; costUsd?: number; exitCode?: number } = {},
): SessionRec | undefined {
  const m = ensureLoaded();
  const rec = m.get(id);
  if (!rec) return undefined;
  const finishedAt = new Date().toISOString();
  const started = Date.parse(rec.startedAt);
  rec.status = status;
  rec.finishedAt = finishedAt;
  rec.durationMs = Number.isFinite(started) ? Math.max(0, Date.parse(finishedAt) - started) : 0;
  if (opts.text) rec.lastText = `${rec.lastText ?? ""}${opts.text}`.slice(-LAST_TEXT_CHARS);
  if (typeof opts.costUsd === "number" && Number.isFinite(opts.costUsd)) rec.costUsd = opts.costUsd;
  const out = put(rec);
  // The run is over: fold the buffered tail into its file now.
  flushTail(id, true);
  pendingTails.delete(id);
  return out;
}

// Newest first, capped. The sorted order is memoised per registry revision and
// the cloned result per (revision, limit): budget.ts calls listSessions(500) once
// per agent per poll and every one of those calls used to sort + clone the whole
// registry. Callers get an array of copies; treat the array itself as read-only
// (all current callers only map/filter/find it).
export function listSessions(limit = 200): SessionRec[] {
  const m = ensureLoaded();
  const n = Math.max(0, limit);
  const key = `${rev}:${n}`;
  const hit = listCache.get(key);
  if (hit) return hit;
  if (!sortedCache || sortedCache.rev !== rev) {
    sortedCache = { rev, sorted: [...m.values()].sort(byNewest) };
  }
  const out = sortedCache.sorted.slice(0, n).map(clone);
  if (listCache.size >= 32) listCache.clear();
  listCache.set(key, out);
  return out;
}

export function sessionCounts(): { running: number; queued: number; total: number } {
  const m = ensureLoaded();
  let running = 0;
  let queued = 0;
  for (const rec of m.values()) {
    if (rec.status === "running") running++;
    else if (rec.status === "queued") queued++;
  }
  return { running, queued, total: m.size };
}

export function runningSessionsFor(agentId: string): SessionRec[] {
  return listSessions(MAX_IN_MEMORY).filter((r) => r.agentId === agentId && r.status === "running");
}

export function lastSessionFor(agentId: string): SessionRec | undefined {
  return listSessions(MAX_IN_MEMORY).find((r) => r.agentId === agentId);
}

export function getSession(id: string): SessionRec | undefined {
  const rec = ensureLoaded().get(id);
  return rec ? clone(rec) : undefined;
}

// Full tail text for a session, read from the separate tail file. This is NOT
// included in the listSessions() payload; callers that need it can ask for it
// explicitly (server.ts exposes `GET /company/sessions/:id?tail=1`).
export function getSessionTail(id: string): string | undefined {
  const rec = ensureLoaded().get(id);
  if (!rec) return undefined;
  try {
    return readTailText(tailFileFor(id), TAIL_CAP_CHARS);
  } catch {
    return undefined;
  }
}
