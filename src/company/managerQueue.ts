import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getCompanyRoot } from "./org.js";
import {
  causeAutoRetryable,
  managerQueueMaxRetries,
  staleAfterHours,
} from "./needsYouRule.js";

// ---------------------------------------------------------------------------
// MANAGER QUEUE (CEO APPROVAL POLICY, 2026-09-30)
//
// The CEO stopped approving routine work. A prompt that is only "retry this
// failed/stale thing or drop it?" is NOT the CEO's to answer: it lands here, in
// company/reports/manager-queue.json, and the manager (the Claude session, plus
// the tick in needsYouActions.ts) decides it.
//
// Lifecycle of one entry:
//   pending        - queued, no automatic retry spent yet
//   auto_retried   - the queue retried it once (cause was transient/infrastructure)
//   escalated      - the retry budget is spent (or a person is needed): this becomes
//                    ONE prompt for the CEO, then never again
//   resolved       - the run stopped failing, or the CEO decided it
//
// Bounds (the whole point: no infinite loop, no repeat questions):
//   - at most managerQueueMaxRetries() automatic retries per JOB (default 2, the
//     same cap the fleet resolver already uses);
//   - at most ONE escalation per entry per failure signature, keyed by a stable id;
//   - once the CEO has decided the escalation, the entry is closed for good.
//
// This module owns the FILE only (read/write/shape + the pure decision function).
// The retry ACTIONS live in needsYouActions.managerQueueTick, which has the fleet
// and pipeline machinery, so this file stays importable from briefing.ts without
// a cycle.
// ---------------------------------------------------------------------------

export type ManagerQueueItemState = "pending" | "auto_retried" | "escalated" | "resolved";

export type ManagerQueueEntry = {
  /** stable per JOB (and per failure cause), so one job is one entry */
  id: string;
  at: string;
  updatedAt: string;
  runId?: string;
  kind: "task" | "fleet" | "unknown";
  title?: string;
  /** plain words: what the manager is being asked to decide */
  text: string;
  projectId?: string;
  taskId?: string;
  orderId?: string;
  failureCause?: string;
  /** a failed run nobody has touched for MANAGER_QUEUE_STALE_HOURS */
  stale: boolean;
  /** automatic retries this queue has spent on the job */
  attempts: number;
  state: ManagerQueueItemState;
  /** why the queue did the last thing it did (plain words) */
  decision?: string;
  /** when the tick last looked at this entry (it does not move `updatedAt`) */
  lastCheckedAt?: string;
  queuedFor?: string;
  escalatedAt?: string;
  /** the needs-you id of the ONE CEO prompt this entry raised */
  escalationId?: string;
  resolvedAt?: string;
};

export type ManagerQueueFile = { updatedAt: string; items: ManagerQueueEntry[] };

/** What the briefing hands over when it routes a routine prompt out of "needs you". */
export type RoutineRun = {
  runId?: string;
  itemId?: string;
  title?: string;
  text: string;
  state?: string;
  updatedAt?: string;
  failureCause?: string;
  riskReason?: string;
};

const QUEUE_MAX = 500;

function nowIso(): string {
  return new Date().toISOString();
}

export function managerQueueFile(): string {
  return path.join(getCompanyRoot(), "reports", "manager-queue.json");
}

function resolvedFile(): string {
  return path.join(getCompanyRoot(), "reports", "needs-you-resolved.json");
}

function readJson<T>(file: string): T | undefined {
  try {
    if (!fs.existsSync(file)) return undefined;
    const raw = fs.readFileSync(file, "utf8").trim();
    if (!raw) return undefined;
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    // the queue is best-effort on write: never break a briefing read
  }
}

function isEntry(v: unknown): v is ManagerQueueEntry {
  return !!v && typeof v === "object" && typeof (v as ManagerQueueEntry).id === "string" && !!(v as ManagerQueueEntry).id;
}

/** The queue, oldest first. Tolerant of a missing or corrupt file. */
export function readManagerQueue(): ManagerQueueEntry[] {
  const file = readJson<ManagerQueueFile>(managerQueueFile());
  const items = Array.isArray(file?.items) ? file.items.filter(isEntry) : [];
  return items.map((e) => ({ ...e, attempts: Number.isFinite(e.attempts) ? e.attempts : 0 }));
}

export function writeManagerQueue(items: ManagerQueueEntry[]): void {
  writeJsonAtomic(managerQueueFile(), { updatedAt: nowIso(), items: trimQueue(items) });
}

/**
 * Keep the queue bounded WITHOUT dropping a live decision: when the file is over the cap, closed
 * entries go first. Dropping a pending/escalated entry would silently lose work the manager owes the
 * CEO an answer for; dropping an old closed one loses nothing.
 */
function trimQueue(items: ManagerQueueEntry[]): ManagerQueueEntry[] {
  if (items.length <= QUEUE_MAX) return items;
  const live = items.filter((e) => normalizeQueueState(e.state) !== "resolved");
  if (live.length >= QUEUE_MAX) {
    // Nothing closed to drop: the oldest LIVE entries have to go. This is a last-resort bound, so say
    // so loudly - it means decisions are piling up faster than anyone is taking them.
    console.warn(`[manager-queue] ${live.length} live entries exceed the ${QUEUE_MAX} cap; keeping the newest ${QUEUE_MAX}`);
    return live.slice(-QUEUE_MAX);
  }
  const closed = items.filter((e) => normalizeQueueState(e.state) === "resolved");
  return [...closed.slice(-(QUEUE_MAX - live.length)), ...live];
}

/**
 * Patch one entry by id (best effort: a missing entry is not an error).
 * `touch` bumps updatedAt - pass false for a read-only observation like "still
 * waiting", so updatedAt keeps meaning "the last time this entry changed state".
 */
export function updateQueueEntry(id: string, patch: Partial<ManagerQueueEntry>, touch = true): ManagerQueueEntry | undefined {
  const items = readManagerQueue();
  const idx = items.findIndex((e) => e.id === id);
  if (idx < 0) return undefined;
  const next: ManagerQueueEntry = { ...items[idx]!, ...patch, ...(touch ? { updatedAt: nowIso() } : {}) };
  items[idx] = next;
  writeManagerQueue(items);
  return next;
}

function parseRun(run: RoutineRun): { kind: ManagerQueueEntry["kind"]; projectId?: string; taskId?: string; orderId?: string } {
  const runId = run.runId ?? "";
  const task = /^task:([^:]+):(.+)$/.exec(runId);
  if (task) return { kind: "task", projectId: task[1]!, taskId: task[2]! };
  const fleet = /^fleet:(.+)$/.exec(runId);
  if (fleet) return { kind: "fleet", orderId: fleet[1]! };
  return { kind: "unknown" };
}

function entryIdFor(run: RoutineRun, parsed: { kind: string; projectId?: string; taskId?: string; orderId?: string }): string {
  // CEO APPROVAL POLICY: the caller's stable id wins when it has one. For a failed fleet
  // order that id is the JOB key (fleet:job:<hash>, job + why it failed), so five copies of
  // one reissued job are ONE queue entry - the same guarantee the old needs-you list had.
  if (run.itemId) return run.itemId;
  if (parsed.kind === "task") return `task:${parsed.projectId}:${parsed.taskId}`;
  if (parsed.kind === "fleet") return `fleet:${parsed.orderId}`;
  return run.runId || `routine:${crypto.createHash("sha1").update(run.text).digest("hex").slice(0, 10)}`;
}

/**
 * Queue routine runs (a retry/drop prompt the manager must decide). Idempotent: an
 * entry already queued keeps its attempts, one already resolved is only re-opened
 * when the run changed since it was resolved, and one already escalated is left
 * alone (it must not be re-escalated into a second CEO prompt).
 */
export function enqueueRoutineRuns(runs: RoutineRun[]): { added: number; reopened: number; skipped: number; total: number } {
  if (!runs.length) return { added: 0, reopened: 0, skipped: 0, total: readManagerQueue().length };
  const items = readManagerQueue();
  const byId = new Map(items.map((e) => [e.id, e]));
  // A decision already on disk closes the entry for good: this is what stops the same question
  // coming back after the CEO answers it (see the guard below).
  const decidedIds = resolvedNeedsYouIds();
  let added = 0;
  let reopened = 0;
  let skipped = 0;
  let dirty = false;
  for (const run of runs) {
    if (!run.text) {
      skipped += 1;
      continue;
    }
    const parsed = parseRun(run);
    const id = entryIdFor(run, parsed);
    const existing = byId.get(id);
    // Belt and braces: ONE entry per live order/task, even if the job key changed (e.g. the
    // failure cause was still unknown when the first entry was written). Two entries for one
    // order would mean two retry budgets and two prompts for the same thing.
    const sameRun = items.find(
      (e) =>
        e.id !== id &&
        e.state !== "resolved" &&
        ((!!parsed.orderId && e.orderId === parsed.orderId) ||
          (!!parsed.taskId && e.taskId === parsed.taskId && e.projectId === parsed.projectId)),
    );
    if (sameRun) {
      skipped += 1;
      continue;
    }
    if (existing) {
      const changedSince = (Date.parse(run.updatedAt ?? "") || 0) > (Date.parse(existing.resolvedAt ?? existing.updatedAt ?? "") || 0);
      const newerCopy = !!run.runId && run.runId !== existing.runId;
      if (existing.state === "resolved" || existing.state === "escalated") {
        // A NEW failure (the run moved since we last acted) starts a fresh decision; an
        // unchanged one must not be asked again.
        //
        // DECIDED ENTRIES (found 2026-09-30): the resolver's own bookkeeping also moves a run's
        // updatedAt, so "the run changed" alone would re-open a job the CEO had just answered and
        // ask the same question twice. A decision on disk therefore keeps the entry closed unless
        // a NEWER COPY of the job appears - a re-ordered job is a new attempt and may be asked about.
        const decided =
          decidedIds.has(existing.escalationId ?? "") || decidedIds.has(existing.id) || (!!existing.runId && decidedIds.has(existing.runId));
        if (!changedSince || (decided && !newerCopy)) {
          skipped += 1;
          continue;
        }
        existing.state = "pending";
        existing.attempts = 0;
        existing.decision = "new failure since the last decision; queued again";
        existing.stale = false;
        existing.escalatedAt = undefined;
        existing.escalationId = undefined;
        existing.resolvedAt = undefined;
        reopened += 1;
        dirty = true;
      }
      // The retry budget belongs to the JOB, so the entry follows the newest copy of it: the
      // reissued order is the one a retry can actually act on (the older copy is superseded).
      if (newerCopy) {
        const ids = parseRun(run);
        existing.runId = run.runId;
        existing.kind = ids.kind;
        existing.orderId = ids.orderId;
        existing.projectId = ids.projectId;
        existing.taskId = ids.taskId;
        existing.text = run.text;
        if (run.title) existing.title = run.title;
        existing.updatedAt = nowIso();
        dirty = true;
      }
      if (run.failureCause && !existing.failureCause) {
        existing.failureCause = run.failureCause;
        dirty = true;
      }
      skipped += 1;
      continue;
    }
    const entry: ManagerQueueEntry = {
      id,
      at: nowIso(),
      updatedAt: nowIso(),
      ...(run.runId ? { runId: run.runId } : {}),
      kind: parsed.kind,
      ...(run.title ? { title: run.title } : {}),
      text: run.text,
      ...(parsed.projectId ? { projectId: parsed.projectId } : {}),
      ...(parsed.taskId ? { taskId: parsed.taskId } : {}),
      ...(parsed.orderId ? { orderId: parsed.orderId } : {}),
      ...(run.failureCause ? { failureCause: run.failureCause } : {}),
      stale: isStaleRun(run.state, run.updatedAt),
      attempts: 0,
      state: "pending",
      ...(run.riskReason ? { queuedFor: run.riskReason } : {}),
    };
    items.push(entry);
    byId.set(id, entry);
    added += 1;
    dirty = true;
  }
  if (dirty) writeManagerQueue(items);
  return { added, reopened, skipped, total: items.length };
}

/** Convenience: one run. */
export function enqueueRoutineRun(run: RoutineRun): { added: number; reopened: number; skipped: number; total: number } {
  return enqueueRoutineRuns([run]);
}

export function isStaleRun(runState: string | undefined, updatedAt: string | undefined, now = Date.now()): boolean {
  if (runState !== "failed" && runState !== "stuck") return false;
  const at = Date.parse(updatedAt ?? "");
  if (!Number.isFinite(at)) return false;
  return now - at >= staleAfterHours() * 3600_000;
}

// ── the ONE CEO prompt an escalated entry raises ─────────────────────────────

export type ManagerEscalationAction = {
  id: string;
  label: string;
  effect: "retry_order" | "retry_task" | "drop_order" | "drop_task";
  params: Record<string, string>;
};

export type ManagerEscalation = {
  id: string;
  text: string;
  runId?: string;
  title?: string;
  kind: "choice";
  question: string;
  reason: string;
  actions: ManagerEscalationAction[];
};

/**
 * Stable id for the ONE prompt an entry raises.
 *
 * It includes the RUN the entry currently points at, so the CEO's decision on one copy of a job
 * cannot leak onto a NEWER copy of the same job: a re-ordered job gets a fresh prompt id (and a
 * fresh decision), while the same copy keeps the same id across restarts (proved in
 * ops/manager-queue-check.ts).
 */
export function escalationIdFor(entryId: string, runId?: string): string {
  return `mq:${crypto.createHash("sha1").update(`manager-queue|${entryId}|${runId ?? ""}`).digest("hex").slice(0, 10)}`;
}

/** How long a queued entry may sit before a person is asked (minutes). */
export function escalateAfterMinutes(): number {
  const raw = Number(process.env.MANAGER_QUEUE_ESCALATE_MINUTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
}

/**
 * The states this module understands, normalised. Anything else reads as "unknown" and is LEFT
 * ALONE by the tick: the file is meant to be inspected (and may be hand-edited by the manager), so a
 * typo must park the entry for a person instead of triggering work on it.
 */
export function normalizeQueueState(state: unknown): ManagerQueueItemState | "unknown" {
  const v = String(state ?? "").trim().toLowerCase();
  return v === "pending" || v === "auto_retried" || v === "escalated" || v === "resolved" ? v : "unknown";
}

export type QueueDecisionInput = {
  state: ManagerQueueItemState;
  attempts: number;
  /** is the run still in the failed state the queue was told about? */
  runStillFailed: boolean;
  /** the fleet order's retry depth (copies of the same job), when known */
  retryDepth?: number;
  failureCause?: string;
  stale?: boolean;
  /** how long this entry has been waiting for a decision */
  ageMs?: number;
  /** the CEO already answered the ONE escalated prompt */
  escalationResolved?: boolean;
};

export type QueueDecisionName = "retry" | "escalate" | "keep" | "resolved";

/**
 * The pure decision: what should happen to one queued entry right now?
 * Kept separate from the side effects so it can be proved directly.
 */
export function decideQueueAction(input: QueueDecisionInput): { action: QueueDecisionName; why: string } {
  const max = managerQueueMaxRetries();
  if (input.state === "escalated") {
    return input.escalationResolved
      ? { action: "resolved", why: "the CEO answered the one prompt this entry raised" }
      : { action: "keep", why: "already escalated: the CEO has been asked once" };
  }
  if (!input.runStillFailed) {
    return { action: "resolved", why: "the run is no longer failing" };
  }
  if (input.escalationResolved) {
    return { action: "resolved", why: "already decided" };
  }
  const depth = Number.isFinite(input.retryDepth) ? Math.max(0, Math.round(input.retryDepth!)) : 0;
  if (depth >= max || input.attempts >= max) {
    return {
      action: "escalate",
      why: `${Math.max(depth, input.attempts)} of ${max} automatic retries spent, so this becomes one prompt for the CEO`,
    };
  }
  if (causeAutoRetryable(input.failureCause)) {
    return { action: "retry", why: `the cause (${input.failureCause ?? "failed"}) is the kind a retry can fix by itself` };
  }
  const waited = input.ageMs ?? 0;
  if (input.stale || waited >= escalateAfterMinutes() * 60_000) {
    return {
      action: "escalate",
      why: input.stale ? "the failure is stale and retrying it is not expected to help" : `waited ${Math.round(waited / 60_000)} minutes without an automatic fix`,
    };
  }
  return { action: "keep", why: "waiting: this needs a person, and the entry is still fresh" };
}

/** The ONE CEO prompt per escalated entry, ready to drop into the briefing. */
export function queueEscalations(): ManagerEscalation[] {
  const out: ManagerEscalation[] = [];
  for (const entry of readManagerQueue()) {
    if (normalizeQueueState(entry.state) !== "escalated") continue;
    const what = entry.title || entry.text;
    // No words, no prompt: the CEO must never be shown a blank card.
    if (!what) continue;
    const id = entry.escalationId ?? escalationIdFor(entry.id, entry.runId);
    const base: ManagerEscalation = {
      id,
      text: what,
      ...(entry.runId ? { runId: entry.runId } : {}),
      ...(entry.title ? { title: entry.title } : {}),
      kind: "choice",
      question: `The manager retried this ${managerQueueMaxRetries()} time(s) and it failed the same way. Fix the cause and ask again, or drop it.`,
      reason: entry.decision ?? "the automatic retries are spent, so this needs a person",
      actions: [],
    };
    if (entry.kind === "fleet" && entry.orderId) {
      base.actions = [
        { id: "retry", label: "Retry it anyway", effect: "retry_order", params: { orderId: entry.orderId } },
        { id: "drop", label: "Drop it", effect: "drop_order", params: { orderId: entry.orderId } },
      ];
    } else if (entry.kind === "task" && entry.projectId && entry.taskId) {
      base.actions = [
        { id: "retry", label: "Retry it", effect: "retry_task", params: { projectId: entry.projectId, taskId: entry.taskId } },
        { id: "drop", label: "Drop it", effect: "drop_task", params: { projectId: entry.projectId, taskId: entry.taskId } },
      ];
    } else {
      continue; // nothing to offer: never raise a prompt with no actions
    }
    out.push(base);
  }
  return out;
}

/** Ids the CEO has already decided (needs-you-resolved.json). */
export function resolvedNeedsYouIds(): Set<string> {
  const map = readJson<Record<string, { at?: string }>>(resolvedFile()) ?? {};
  return new Set(Object.keys(map));
}

export type ManagerQueueSummary = {
  total: number;
  pending: number;
  autoRetried: number;
  escalated: number;
  resolved: number;
  /** how many automatic retries are saved for one job */
  maxRetries: number;
  /** what the manager is being asked to decide */
  items: ManagerQueueEntry[];
  updatedAt: string;
};

export function managerQueueSummary(): ManagerQueueSummary {
  const items = readManagerQueue();
  const count = (s: ManagerQueueItemState) => items.filter((e) => e.state === s).length;
  return {
    total: items.length,
    pending: count("pending"),
    autoRetried: count("auto_retried"),
    escalated: count("escalated"),
    resolved: count("resolved"),
    maxRetries: managerQueueMaxRetries(),
    items: items.slice(-100).reverse(), // newest first, bounded for the API
    updatedAt: readJson<ManagerQueueFile>(managerQueueFile())?.updatedAt ?? nowIso(),
  };
}
