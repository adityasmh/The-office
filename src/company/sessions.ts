import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
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
  pidAttachedAt?: string; // ISO time when pid was attached; guards pid reuse in reconcile
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
let lastFileKey = "";

function sessionsFileKey(): string {
  try {
    const st = fs.statSync(sessionsFile());
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "missing";
  }
}

// Monotonic revision counters. `rev` moves on ANY change to the registry (used
// to invalidate the read caches below); `statusRev` moves only when a session's
// status changes (used by callers - e.g. the panel's budget rollup - that do not
// care about output text). Both are exported as the invalidation API for code
// that memoises session-derived data: a caller that only counts running sessions
// should key on sessionsStatusRevision() and NOT on sessionsRevision(), otherwise
// every output chunk invalidates it.
let rev = 0;
let statusRev = 0;
let panelRev = 0;

export function sessionsRevision(): number {
  return rev;
}

export function sessionsStatusRevision(): number {
  return statusRev;
}

export function sessionsPanelRevision(): number {
  return panelRev;
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

function statusRank(s: SessionStatus): number {
  if (s === "done" || s === "error") return 2;
  if (s === "running") return 1;
  return 0;
}

// Return true when the in-memory record is more resolved than the file line.
// This guards against a concurrent/stale file snapshot overwriting a finish,
// a pid attachment, or a cost update that happened in this process.
function sessionIsNewer(a: SessionRec, b: SessionRec): boolean {
  if (statusRank(a.status) > statusRank(b.status)) return true;
  if (a.finishedAt && (!b.finishedAt || a.finishedAt > b.finishedAt)) return true;
  if (typeof a.pid === "number" && typeof b.pid !== "number") return true;
  if ((a.costUsd ?? 0) > (b.costUsd ?? 0)) return true;
  return false;
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
    lastFileKey = sessionsFileKey();
  } catch {
    // Keep the in-memory view authoritative; a later append can retry.
  }
}

function normalizeStatus(s: string | undefined): SessionStatus {
  if (!s) return "error";
  if (s === "success" || s === "complete" || s === "finished") return "done";
  const validStatus: SessionStatus[] = ["queued", "running", "done", "error"];
  if (validStatus.includes(s as SessionStatus)) return s as SessionStatus;
  // Pass through unknown legacy values rather than silently coercing to error.
  return s as SessionStatus;
}

function normalizeSessionRec(raw: unknown): SessionRec | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : typeof r.sessionId === "string" ? r.sessionId : undefined;
  if (!id) return undefined;

  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = r[k];
      if (typeof v === "string" && v.length > 0) return v;
    }
    return undefined;
  };

  const status = normalizeStatus(pick("status"));

  return {
    // Preserve unknown legacy keys so old lines round-trip instead of being
    // silently dropped; canonical fields override any legacy aliases below.
    ...r,
    id,
    agentId: pick("agentId", "agent") ?? "",
    agentName: pick("agentName", "name", "agent") ?? "",
    role: pick("role") ?? "",
    departmentId: pick("departmentId", "department", "deptId") ?? "",
    departmentName: pick("departmentName", "deptName") ?? "",
    projectId: pick("projectId", "project", "projId") ?? "",
    projectName: pick("projectName", "projName") ?? "",
    taskId: typeof r.taskId === "string" ? r.taskId : typeof r.task === "string" ? r.task : null,
    taskTitle: pick("taskTitle", "title") ?? "",
    model: pick("model") ?? "",
    status,
    startedAt: pick("startedAt", "started") ?? new Date(0).toISOString(),
    ...(typeof r.finishedAt === "string"
      ? { finishedAt: r.finishedAt }
      : typeof r.finished === "string"
        ? { finishedAt: r.finished }
        : {}),
    ...(typeof r.durationMs === "number" && Number.isFinite(r.durationMs) ? { durationMs: r.durationMs } : {}),
    ...(typeof r.pid === "number" && Number.isFinite(r.pid) ? { pid: r.pid } : {}),
    ...(typeof r.lastText === "string" ? { lastText: r.lastText } : {}),
    costUsd:
      typeof r.costUsd === "number" && Number.isFinite(r.costUsd)
        ? r.costUsd
        : typeof r.cost === "number" && Number.isFinite(r.cost)
          ? r.cost
          : 0,
    ...(() => {
      const rt = pick("runtime");
      return rt === "opencode" || rt === "router" ? { runtime: rt } : {};
    })(),
  };
}

function ensureLoaded(): Map<string, SessionRec> {
  const key = sessionsFileKey();
  if (store && lastFileKey === key) return store;
  // Flush buffered tail text before re-reading so a concurrent writer cannot
  // overwrite a tail that is newer than the last JSONL snapshot.
  flushSessionTails();
  invalidateReadCaches();
  const previousStore = store;
  const previousById = previousStore ? new Map(previousStore) : new Map<string, SessionRec>();
  const m = new Map<string, SessionRec>();
  store = m;
  fileLines = 0;
  lastFileKey = key;
  const file = sessionsFile();
  try {
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
      fileLines = lines.length;
      for (const line of lines) {
        try {
          const rec = normalizeSessionRec(JSON.parse(line));
          if (!rec) continue;
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
  // Preserve in-memory state that is newer than the file: pending tail text and
  // any fields advanced in this process (status, pid, cost, finishedAt) must not
  // be discarded just because another process appended an older snapshot.
  for (const [id, rec] of previousById) {
    const loaded = m.get(id);
    if (!loaded) {
      // session exists only in memory (not yet snapshotted): keep it
      m.set(id, rec);
      continue;
    }
    const newer = sessionIsNewer(rec, loaded);
    const newerText = pendingTails.has(id) && (rec.lastText?.length ?? 0) > (loaded.lastText?.length ?? 0);
    if (newer || newerText) {
      m.set(id, {
        ...loaded,
        ...rec,
        lastText: newerText ? rec.lastText : loaded.lastText,
      });
    }
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
  // Bump revision counters when the reload actually changed the registry, so
  // panel memo and other observers invalidate.
  let changed = false;
  if (!previousStore || previousStore.size !== m.size) {
    changed = true;
  } else {
    for (const [id, rec] of m) {
      const prev = previousStore.get(id);
      if (!prev || JSON.stringify(prev) !== JSON.stringify(rec)) {
        changed = true;
        break;
      }
    }
  }
  if (changed) {
    rev++;
    statusRev++;
    panelRev++;
  }
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

function pidIsAlive(pid: number | undefined): boolean {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    // Sending signal 0 tests whether the process exists without affecting it.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we lack permission to signal it.
    if ((err as NodeJS.ErrnoException | undefined)?.code === "EPERM") return true;
    return false;
  }
}

const PID_REUSE_TOLERANCE_MS = 1000;

// Test seam: override the detected start time for a pid without spawning processes.
const testPidStartTimes = new Map<number, number | undefined>();
export function __setPidStartTimeForTest(pid: number, ms: number | undefined): void {
  if (ms === undefined) testPidStartTimes.delete(pid);
  else testPidStartTimes.set(pid, ms);
}

// Test seam: reset all module state so a harness can exercise a fresh registry.
export function __resetSessionsForTest(): void {
  store = null;
  fileLines = 0;
  lastFileKey = "";
  rev = 0;
  statusRev = 0;
  panelRev = 0;
  sortedCache = null;
  listCache.clear();
  pendingTails.clear();
  testPidStartTimes.clear();
}

function pidStartTimeMs(pid: number): number | undefined {
  const override = testPidStartTimes.get(pid);
  if (override !== undefined) return override;
  try {
    if (process.platform === "win32") {
      const out = execSync(
        `powershell.exe -NoProfile -Command "(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToString('o')"`,
        { encoding: "utf8", timeout: 2000, windowsHide: true },
      );
      const t = Date.parse(out.trim());
      return Number.isFinite(t) ? t : undefined;
    }
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const btimeLine = fs.readFileSync("/proc/stat", "utf8").split("\n").find((l) => l.startsWith("btime "));
      if (!btimeLine) return undefined;
      const btime = Number(btimeLine.split(" ")[1]);
      const lastParen = stat.lastIndexOf(")");
      const fields = stat.slice(lastParen + 2).split(" ");
      const starttime = Number(fields[19]);
      if (!Number.isFinite(starttime) || !Number.isFinite(btime)) return undefined;
      const hz = 100;
      return Math.round((btime + starttime / hz) * 1000);
    }
    const out = execSync(`ps -o lstart= -p ${pid}`, { encoding: "utf8", timeout: 2000 });
    const t = Date.parse(out.trim());
    return Number.isFinite(t) ? t : undefined;
  } catch {
    return undefined;
  }
}

function pidIsOurs(pid: number, attachedAtMs: number): { alive: boolean; reason?: string } {
  if (!pidIsAlive(pid)) return { alive: false };
  const startedMs = pidStartTimeMs(pid);
  if (startedMs === undefined) return { alive: true }; // cannot verify, trust the pid
  if (startedMs > attachedAtMs + PID_REUSE_TOLERANCE_MS) {
    return { alive: false, reason: "pid reused by a newer process" };
  }
  return { alive: true };
}

// A server restart orphans anything that was in flight: the child process and the
// in-process HTTP call died with the old process, but the on-disk record still
// says "running". Mark those as error on boot so the dashboard never shows a
// ghost session as if it were live (observed 2026-09-29: a killed server left an
// enhancer row "running" forever, which made the CEO board lie).
//
// A session whose pid is still alive is left alone (the opencode child survived
// the restart); a session with a dead pid or no pid (router runtime) is marked
// stale.
export function reconcileStaleSessions(reason = "server restarted while this session was in flight"): number {
  const m = ensureLoaded();
  let fixed = 0;
  const now = Date.now();
  for (const rec of [...m.values()]) {
    if (rec.status !== "running" && rec.status !== "queued") continue;
    if (typeof rec.pid === "number") {
      const attachedAtMs = rec.pidAttachedAt ? Date.parse(rec.pidAttachedAt) : Date.parse(rec.startedAt);
      const check = pidIsOurs(rec.pid, Number.isFinite(attachedAtMs) ? attachedAtMs : now);
      if (check.alive) continue;
      reason = check.reason ?? reason;
    }
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
    lastFileKey = sessionsFileKey();
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
  panelRev++; // invalidates panel memo on every non-chunk registry mutation (start/update/finish)
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
  if (typeof next.pid === "number" && next.pid !== rec.pid) {
    next.pidAttachedAt = new Date().toISOString();
  }
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
  const next: SessionRec = { ...rec };
  const finishedAt = new Date().toISOString();
  const started = Date.parse(next.startedAt);
  next.status = status;
  next.finishedAt = finishedAt;
  next.durationMs = Number.isFinite(started) ? Math.max(0, Date.parse(finishedAt) - started) : 0;
  if (opts.text) next.lastText = `${next.lastText ?? ""}${opts.text}`.slice(-LAST_TEXT_CHARS);
  if (typeof opts.costUsd === "number" && Number.isFinite(opts.costUsd)) next.costUsd = opts.costUsd;
  const out = put(next);
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
