import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { getCompanyRoot } from "./org.js";
import { getBriefing, refreshBriefing, type BriefingItem, type NeedsYouAction, type NeedsYouEffect } from "./briefing.js";
import { approveGate, dropTask, getTask, updateTask } from "./gates.js";
import { resumeTask, runPipeline } from "./pipeline.js";
import { createFleetOrder, cancelFleetOrder, getFleetOrder, loadFleetOrders, saveFleetOrders, type FleetOrder } from "./fleet.js";
import { refreshBudgetState } from "./budgetGuard.js";
import { refuseNewWork } from "./lifecycle.js";
import {
  decideQueueAction,
  escalationIdFor,
  normalizeQueueState,
  readManagerQueue,
  resolvedNeedsYouIds,
  updateQueueEntry,
  type QueueDecisionName,
} from "./managerQueue.js";
import {
  jobPromptId,
  maxOrderRetries,
  orderFailureCause,
  orderRetryDepth,
  orderRetryExhausted,
  orderTitleKey,
} from "./needsYouRule.js";

// docs/NEEDS_YOU_SPEC.md section 5: resolver engine.
//
// - Looks up the item in the live briefing by id.
// - Executes the chosen action's effect.
// - Writes needs-you-resolved.json (except for open_link) and appends to
//   needs-you-decisions.json (capped at 500 entries).
// - Never leaks input values (secrets are scrubbed from messages and logs).

export type ResolveResult = {
  ok: boolean;
  message: string;
  newState?: string;
  itemId: string;
  actionId: string;
  needsYou?: BriefingItem[];
};

const STALE_MESSAGE = "That item is no longer waiting on you (it may already be handled). Refresh the list.";

function reportsDir(): string {
  return path.join(getCompanyRoot(), "reports");
}

function resolvedFile(): string {
  return path.join(reportsDir(), "needs-you-resolved.json");
}

function decisionsFile(): string {
  return path.join(reportsDir(), "needs-you-decisions.json");
}

function nowIso(): string {
  return new Date().toISOString();
}

function readJson<T>(file: string): T | undefined {
  try {
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function readResolved(): Record<string, { at: string; actionId: string }> {
  return readJson<Record<string, { at: string; actionId: string }>>(resolvedFile()) ?? {};
}

function writeResolved(map: Record<string, { at: string; actionId: string }>): void {
  writeJsonAtomic(resolvedFile(), map);
}

type DecisionEntry = {
  at: string;
  who: string;
  itemId: string;
  actionId: string;
  effect: string;
  ok: boolean;
  message: string;
};

function appendDecision(entry: DecisionEntry): void {
  try {
    const arr = readJson<DecisionEntry[]>(decisionsFile()) ?? [];
    arr.push(entry);
    if (arr.length > 500) arr.splice(0, arr.length - 500);
    writeJsonAtomic(decisionsFile(), arr);
  } catch {
    // the decision log is best-effort; a failed write must not break the resolver
  }
}

/** Replace every occurrence of `secret` with a fixed token. */
function scrub(message: string, secret?: string): string {
  if (!secret) return message;
  return message.split(secret).join("[REDACTED]");
}

/** Collect all non-empty input values so they can be scrubbed from output. */
function collectSecrets(input: Record<string, string> | undefined): string[] {
  const out: string[] = [];
  if (!input) return out;
  for (const v of Object.values(input)) {
    if (typeof v === "string" && v.length > 0) out.push(v);
  }
  return out;
}

/** Atomic upsert of `KEY=value` into the repo .env and live process/config state. */
async function upsertEnv(key: string, value: string): Promise<void> {
  const envPath = path.join(process.cwd(), ".env");
  let text = "";
  try {
    text = fs.readFileSync(envPath, "utf8");
  } catch {
    text = "";
  }
  const lines = text.split(/\r?\n/);
  const prefix = `${key}=`;
  const idx = lines.findIndex((line) => line.startsWith(prefix));
  if (idx >= 0) lines[idx] = `${prefix}${value}`;
  else lines.push(`${prefix}${value}`);
  const tmp = `${envPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, lines.join("\n"));
  fs.renameSync(tmp, envPath);
  process.env[key] = value;
  if (key === "OPENCODE_API_KEY") config.gatewayKey = value;
}

function mentionsClaudeLimit(text: string): boolean {
  return /spend(ing)? limit|monthly limit|usage limit|out of (usage|credit)/i.test(text ?? "");
}

function orderMentionsClaudeLimit(order: FleetOrder): boolean {
  const probe = [order.error ?? "", order.text, ...order.trace.map((s) => `${s.what} ${s.detail ?? ""}`)].join(" ");
  return mentionsClaudeLimit(probe);
}

/**
 * Record on the old order that a newer copy replaces it (best effort).
 */
function markSuperseded(orderId: string, byId: string): void {
  try {
    const all = loadFleetOrders();
    const oldRec = all.find((o) => o.id === orderId);
    if (oldRec) {
      oldRec.supersededBy = byId;
      oldRec.updatedAt = nowIso();
      saveFleetOrders(all);
    }
  } catch {
    // supersededBy is best-effort
  }
}

/**
 * RETRY LOOP: write down durably that this job has used up its retries, so the briefing
 * can raise ONE plain item ("this failed N times for the same reason") and the resolver
 * refuses to mint another copy. The order stays `failed` on purpose: it must still be
 * visible once, it must not silently vanish.
 */
function markRetryExhausted(orderId: string): number {
  try {
    const all = loadFleetOrders();
    const rec = all.find((o) => o.id === orderId);
    if (!rec) return 0;
    const depth = orderRetryDepth(rec, all);
    rec.retryCount = depth;
    rec.retryExhaustedAt = rec.retryExhaustedAt ?? nowIso();
    rec.failureCause = rec.failureCause ?? orderFailureCause(rec);
    rec.updatedAt = nowIso();
    pushReissueTrace(rec, `retry cap reached (${depth} of ${maxOrderRetries()} retries): not reissuing ${orderId}`);
    saveFleetOrders(all);
    return depth;
  } catch {
    return 0;
  }
}

/** Append one hop explaining a retry/reissue decision (best effort). */
function pushReissueTrace(order: FleetOrder, detail: string): void {
  try {
    if (!Array.isArray(order.trace)) order.trace = [];
    order.trace.push({ ts: nowIso(), from: "Claude (manager)", to: "CEO", what: "retry capped", detail });
    if (order.trace.length > 200) order.trace.splice(0, order.trace.length - 200);
  } catch {
    // a trace hop is diagnostic only
  }
}

export type ReissueResult = {
  /** ids of the orders that now carry this job (a new copy, or an existing newer one) */
  created: string[];
  /** ids whose retry budget is spent: nothing was created, a person must look at them */
  capped: string[];
};

/**
 * Create a new order from the old order's text. If `orderIds` is omitted, every
 * failed fleet order whose error/trace mentions the Claude limit is reissued.
 * Records `supersededBy` on the old order(s).
 *
 * DUPLICATE-PROMPTS: if a NEWER copy of the same job (same long title) is already on
 * disk, no new order is created - the old one is just marked superseded by that copy.
 *
 * RETRY LOOP (2026-09-30): a job is reissued at most `maxOrderRetries()` times. Past that
 * the resolver creates NOTHING (the reissue is what used to loop forever: every answer to
 * "Retry this order or drop it?" minted a fresh order id, which re-raised the prompt) and
 * the order is marked exhausted so the briefing says so ONCE, with no retry button.
 */
async function reissueOrders(
  orderIds: string[] | undefined,
  forceProvider: "kimi" | undefined,
  who?: string,
): Promise<ReissueResult> {
  const created: string[] = [];
  const capped: string[] = [];
  const ids = orderIds ?? loadFleetOrders().filter((o) => o.status === "failed" && orderMentionsClaudeLimit(o)).map((o) => o.id);
  for (const orderId of ids) {
    const old = getFleetOrder(orderId);
    if (!old) continue;

    const titleKey = orderTitleKey(old.text);
    if (titleKey) {
      const newer = loadFleetOrders().find(
        (o) =>
          o.id !== orderId &&
          !o.closedAs &&
          !o.supersededBy &&
          orderTitleKey(o.text) === titleKey &&
          (Date.parse(o.createdAt) || 0) > (Date.parse(old.createdAt) || 0),
      );
      if (newer) {
        markSuperseded(orderId, newer.id);
        created.push(newer.id);
        continue;
      }
    }

    const all = loadFleetOrders();
    if (orderRetryExhausted(old, all)) {
      markRetryExhausted(orderId);
      capped.push(orderId);
      continue;
    }

    const next = await createFleetOrder(old.text, {
      autoApprove: true,
      ...(forceProvider ? { forceProvider } : {}),
      retryCount: orderRetryDepth(old, all) + 1,
      retriedFrom: old.id,
    });
    created.push(next.id);
    markSuperseded(orderId, next.id);
  }
  return { created, capped };
}

async function executeEffect(
  effect: NeedsYouEffect,
  params: Record<string, string> | undefined,
  input: Record<string, string> | undefined,
  who?: string,
): Promise<{ message: string; resolved: boolean }> {
  const p = params ?? {};
  switch (effect) {
    case "approve_gate": {
      const gate = p.gate as "intake" | "code" | "merge";
      approveGate(p.projectId, p.taskId, gate);
      if (p.note) updateTask(p.projectId, p.taskId, { note: p.note });
      resumeTask(p.projectId, p.taskId);
      return { message: `Gate ${gate} approved.`, resolved: true };
    }
    case "retry_task": {
      const blocked = refuseNewWork("resolveNeedsYou retry_task");
      if (blocked) throw new Error(`Company is paused: ${blocked}`);
      const t = getTask(p.projectId, p.taskId);
      if (!t) throw new Error("Task not found.");
      updateTask(p.projectId, p.taskId, { status: "pending_intake", error: undefined });
      void runPipeline(p.projectId, t.rawRequest, { taskId: p.taskId }).catch(() => {});
      return { message: "Task queued for retry.", resolved: true };
    }
    case "drop_task": {
      dropTask(p.projectId, p.taskId, "dropped by the CEO", who);
      return { message: "Task dropped.", resolved: true };
    }
    case "retry_order": {
      const res = await reissueOrders(p.orderId ? [p.orderId] : undefined, undefined, who);
      if (!res.created.length) {
        if (res.capped.length) {
          // RETRY LOOP: the cap is the answer, not an error. Say so in plain words and let the
          // item resolve; the briefing will raise the ONE "this keeps failing" item instead.
          return {
            message:
              `Not retrying: this job has already been retried ${maxOrderRetries()} times, and the last attempt failed for the same reason. ` +
              `It needs the cause fixed first (or drop it).`,
            resolved: true,
          };
        }
        throw new Error("Could not reissue the order.");
      }
      return { message: `Order reissued as ${res.created.join(", ")}.`, resolved: true };
    }
    case "reissue_kimi": {
      const res = await reissueOrders(p.orderId ? [p.orderId] : undefined, "kimi", who);
      if (!res.created.length) {
        if (res.capped.length) {
          return {
            message: `Not retrying with Kimi: this job has already been retried ${maxOrderRetries()} times for the same reason.`,
            resolved: true,
          };
        }
        throw new Error("Could not reissue the order with Kimi.");
      }
      return { message: `Order reissued with Kimi as ${res.created.join(", ")}.`, resolved: true };
    }
    case "drop_order": {
      cancelFleetOrder(p.orderId);
      return { message: "Order cancelled.", resolved: true };
    }
    case "provide_key": {
      const envName = p.envName ?? "OPENCODE_API_KEY";
      const value = input?.[envName];
      if (typeof value !== "string" || !value.trim()) throw new Error("A key is required.");
      if (/\s/.test(value)) throw new Error("The key cannot contain whitespace.");
      await upsertEnv(envName, value.trim());
      const res = await reissueOrders(p.orderId ? [p.orderId] : undefined, undefined, who);
      return {
        message: res.capped.length && !res.created.length ? "Key saved. Not retrying: this job's retry budget is spent." : "Key saved.",
        resolved: true,
      };
    }
    case "open_link": {
      // eslint-disable-next-line no-console
      console.log(`[needs-you] open link: ${p.url ?? "(no url)"}`);
      return { message: "Link opened in the UI.", resolved: false };
    }
    case "recheck_budget": {
      await refreshBudgetState({ fresh: true });
      const res = await reissueOrders(undefined, undefined, who);
      return {
        message: `Budget refreshed; ${res.created.length ? `reissued ${res.created.length} order(s)` : "no Claude-limit orders to retry"}.`,
        resolved: true,
      };
    }
    default: {
      const _exhaustive: never = effect;
      throw new Error(`Unknown effect: ${_exhaustive}`);
    }
  }
}

export function openNeedsYouItems(): BriefingItem[] {
  return getBriefing().needsYou;
}

/**
 * Test hook: exercise the reissue guard directly. With a newer copy of the same job on
 * disk it must NOT create another order (and must not spawn anything); past the retry cap
 * it must create nothing at all and report the order as capped.
 */
export const __testReissueOrders = reissueOrders;

export async function resolveNeedsYou(itemId: string, actionId: string, input?: Record<string, string>, who?: string): Promise<ResolveResult> {
  const whoName = who || "ceo";
  const item = openNeedsYouItems().find((n) => n.id === itemId);
  const action = item?.actions?.find((a) => a.id === actionId);
  const effect = action?.effect;
  const at = nowIso();

  if (!item || !action || !effect || !item.id) {
    const message = STALE_MESSAGE;
    appendDecision({ at, who: whoName, itemId, actionId, effect: effect ?? "unknown", ok: false, message });
    return { ok: false, message, itemId, actionId };
  }

  const secrets = collectSecrets(input);

  try {
    const { message: rawMessage, resolved } = await executeEffect(effect, action.params, input, whoName);
    let message = rawMessage;
    for (const s of secrets) message = scrub(message, s);

    if (resolved) {
      if (effect !== "open_link") {
        const map = readResolved();
        map[item.id!] = { at, actionId };
        writeResolved(map);
      }
      const briefing = await refreshBriefing({ maxChecks: 0 });
      appendDecision({ at, who: whoName, itemId, actionId, effect, ok: true, message });
      return { ok: true, message, newState: effect, itemId, actionId, needsYou: briefing.briefing.needsYou };
    }

    // open_link succeeds but does NOT resolve the item.
    appendDecision({ at, who: whoName, itemId, actionId, effect, ok: true, message });
    return { ok: true, message, newState: effect, itemId, actionId, needsYou: openNeedsYouItems() };
  } catch (e) {
    let raw = e instanceof Error ? e.message : String(e);
    for (const s of secrets) raw = scrub(raw, s);
    const message = raw;
    appendDecision({ at, who: whoName, itemId, actionId, effect, ok: false, message });
    return { ok: false, message, itemId, actionId };
  }
}

// ── MANAGER QUEUE TICK (CEO APPROVAL POLICY, 2026-09-30) ────────────────────
//
// Routine retry/drop prompts do not go to the CEO (see needsYouRule
// classifyApprovalRisk and managerQueue.ts). They land in the manager queue and
// this tick decides them:
//   - a failed order/task whose cause a retry can fix (a gateway connection error,
//     a provider blip) is retried ONCE automatically, and at most
//     managerQueueMaxRetries() times in total (default 2);
//   - once the budget is spent the entry is ESCALATED: that becomes exactly ONE
//     prompt for the CEO, and never a second one (the entry is closed as soon as
//     the CEO answers it);
//   - a run that stopped failing is closed silently.
//
// Everything here is bounded and best effort: a broken entry is logged and the
// next entry is still handled, so a bad queue entry can never take the router down.

export type ManagerQueueTickResult = {
  ok: boolean;
  retried: string[];
  escalated: string[];
  resolved: string[];
  kept: number;
  /** set when the company is paused, so nothing was retried */
  blocked?: string;
  /** set when another tick was already running, so this call did nothing */
  busy?: string;
  error?: string;
};

export type ManagerQueueTickDeps = {
  /** how the queue retries one failed fleet order (tests inject a stub) */
  retryOrder?: (orderId: string) => Promise<string>;
  /** how the queue retries one failed task (tests inject a stub) */
  retryTask?: (projectId: string, taskId: string) => Promise<string>;
};

/** Set while a pass is in flight, so two callers cannot decide the same entry twice. */
let queueTickRunning = false;

function queueFailureCauseForTask(projectId: string, taskId: string): string | undefined {
  const t = getTask(projectId, taskId);
  if (!t) return undefined;
  return orderFailureCause({ error: t.error, status: t.status });
}

/**
 * One pass over the manager queue, one at a time.
 *
 * REENTRANCY (found 2026-09-30 in ops/manager-queue-check.ts): the 60s watcher and
 * POST /api/manager-queue/tick can overlap, and without this guard both read the same entry and
 * BOTH fire an automatic retry for one retry budget (measured: two retry calls for one attempt,
 * with the entry recording attempts=1). The second caller is now told the tick was busy.
 * (Two PROCESSES sharing one company root are still bounded only by the fleet's own per-job
 * retryCount cap - noted in docs/AGENT_COORDINATION.md.)
 */
export async function managerQueueTick(deps: ManagerQueueTickDeps = {}): Promise<ManagerQueueTickResult> {
  if (queueTickRunning) {
    return { ok: true, retried: [], escalated: [], resolved: [], kept: 0, busy: "a manager-queue tick is already running" };
  }
  queueTickRunning = true;
  try {
    return await managerQueueTickPass(deps);
  } finally {
    queueTickRunning = false;
  }
}

/**
 * One pass over the manager queue. `deps` lets a proof run the real bookkeeping
 * (attempts, the retry cap, escalation) without touching a provider.
 */
async function managerQueueTickPass(deps: ManagerQueueTickDeps = {}): Promise<ManagerQueueTickResult> {
  const out: ManagerQueueTickResult = { ok: true, retried: [], escalated: [], resolved: [], kept: 0 };
  try {
    const entries = readManagerQueue().filter((e) => normalizeQueueState(e.state) !== "resolved");
    if (!entries.length) return out;
    const resolvedIds = resolvedNeedsYouIds();
    const blocked = refuseNewWork("manager-queue tick");
    if (blocked) out.blocked = blocked;
    const retryOrder = deps.retryOrder ?? (async (orderId: string) => (await executeEffect("retry_order", { orderId }, undefined, "manager-queue")).message);
    const retryTask =
      deps.retryTask ??
      (async (projectId: string, taskId: string) => (await executeEffect("retry_task", { projectId, taskId }, undefined, "manager-queue")).message);

    for (const entry of entries) {
      try {
        const entryState = normalizeQueueState(entry.state);
        if (entryState === "unknown") {
          // A state this module does not understand (a hand-edit typo, or a file from a newer
          // build): park it for a person instead of acting on it.
          updateQueueEntry(entry.id, { decision: `unrecognised state "${String(entry.state)}": left alone`, lastCheckedAt: nowIso() }, false);
          out.kept += 1;
          continue;
        }
        let runStillFailed = true;
        let retryDepth: number | undefined;
        let failureCause = entry.failureCause;
        if (entry.kind === "fleet" && entry.orderId) {
          const order = getFleetOrder(entry.orderId);
          // A superseded/closed order is not the live failure any more: the newer copy carries
          // the job and has its own entry, so this one is closed instead of retried again.
          if (!order || order.status !== "failed" || order.supersededBy || order.closedAs) {
            runStillFailed = false;
          } else {
            retryDepth = orderRetryDepth(order, loadFleetOrders());
            failureCause = failureCause ?? orderFailureCause(order);
          }
        } else if (entry.kind === "task" && entry.projectId && entry.taskId) {
          const t = getTask(entry.projectId, entry.taskId);
          if (!t || t.status !== "failed" || t.closedAs) runStillFailed = false;
          else failureCause = failureCause ?? queueFailureCauseForTask(entry.projectId, entry.taskId);
        }

        // A decision already on disk - the ONE prompt the CEO answered, or an id a person
        // closed by hand (ops/needs-you-stale-resolve.ts writes those) - ends the entry.
        const escalationResolved =
          (!!entry.escalationId && resolvedIds.has(entry.escalationId)) ||
          resolvedIds.has(entry.id) ||
          (!!entry.runId && resolvedIds.has(entry.runId));
        const decision = decideQueueAction({
          state: entryState,
          attempts: entry.attempts,
          runStillFailed,
          ...(retryDepth !== undefined ? { retryDepth } : {}),
          ...(failureCause ? { failureCause } : {}),
          stale: entry.stale,
          ageMs: Date.now() - (Date.parse(entry.at) || Date.now()),
          escalationResolved,
        });

        const applied: QueueDecisionName = decision.action;
        if (applied === "resolved") {
          updateQueueEntry(entry.id, { state: "resolved", resolvedAt: nowIso(), decision: decision.why, ...(failureCause ? { failureCause } : {}) });
          out.resolved.push(entry.id);
          continue;
        }
        if (applied === "keep") {
          // Observable, not a state change: the manager queue says WHAT it is waiting for.
          updateQueueEntry(entry.id, { decision: decision.why, lastCheckedAt: nowIso() }, false);
          out.kept += 1;
          continue;
        }
        if (applied === "escalate") {
          updateQueueEntry(entry.id, {
            state: "escalated",
            escalatedAt: nowIso(),
            escalationId: entry.escalationId ?? escalationIdFor(entry.id, entry.runId),
            decision: decision.why,
            ...(failureCause ? { failureCause } : {}),
          });
          out.escalated.push(entry.id);
          console.log(`[manager-queue] escalated ${entry.id}: ${decision.why} (ONE prompt for the CEO)`);
          continue;
        }

        // retry
        if (blocked) {
          out.kept += 1;
          continue;
        }
        const attempts = entry.attempts + 1;
        let message = "";
        if (entry.kind === "fleet" && entry.orderId) {
          message = await retryOrder(entry.orderId);
        } else if (entry.kind === "task" && entry.projectId && entry.taskId) {
          message = await retryTask(entry.projectId, entry.taskId);
        } else {
          // Nothing to retry: escalate rather than sit here forever. (Abnormal: a real entry
          // always names an order or a task, so this is logged loudly.)
          console.error(`[manager-queue] ${entry.id} has no retry path (kind=${entry.kind}); escalating it to the CEO instead`);
          updateQueueEntry(entry.id, { state: "escalated", escalatedAt: nowIso(), escalationId: entry.escalationId ?? escalationIdFor(entry.id, entry.runId), decision: "no retry path for this entry" });
          out.escalated.push(entry.id);
          continue;
        }
        updateQueueEntry(entry.id, {
          attempts,
          state: "auto_retried",
          decision: `retried automatically (attempt ${attempts} of ${maxOrderRetries()}): ${message}`,
          ...(failureCause ? { failureCause } : {}),
        });
        out.retried.push(entry.id);
        console.log(`[manager-queue] auto-retried ${entry.id} (attempt ${attempts}): ${message}`);
      } catch (e) {
        console.error(`[manager-queue] entry ${entry.id} failed (continuing): ${String(e)}`);
      }
    }
    return out;
  } catch (e) {
    out.ok = false;
    out.error = e instanceof Error ? e.message : String(e);
    console.error(`[manager-queue] tick failed (router continues): ${out.error}`);
    return out;
  }
}

// ── the guarded manager-queue watcher ───────────────────────────────────────

let queueTimer: NodeJS.Timeout | undefined;
let queueTicking = false;

function envNum(name: string, dflt: number, min = 0): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return dflt;
  return Math.max(min, raw);
}

function envFlag(name: string, dflt: boolean): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return dflt;
  return !(raw === "0" || raw === "false" || raw === "off");
}

export function managerQueueIntervalMs(): number {
  return envNum("MANAGER_QUEUE_INTERVAL_MS", 60000, 5000);
}

/** Start the manager-queue loop (unref'd, non-overlapping, never throws). */
export function startManagerQueueWatcher(): { running: boolean; enabled: boolean; intervalMs: number } {
  const enabled = envFlag("MANAGER_QUEUE", true);
  const intervalMs = managerQueueIntervalMs();
  if (queueTimer) return { running: true, enabled, intervalMs };
  if (!enabled) return { running: false, enabled: false, intervalMs };
  queueTimer = setInterval(() => {
    if (queueTicking) return;
    queueTicking = true;
    void managerQueueTick()
      .catch((e) => console.error(`[manager-queue] tick threw (router continues): ${String(e)}`))
      .finally(() => {
        queueTicking = false;
      });
  }, intervalMs);
  queueTimer.unref?.();
  console.log(`[manager-queue] watcher every ${intervalMs}ms (unref'd; routine retry/drop prompts are decided here, not by the CEO)`);
  return { running: true, enabled: true, intervalMs };
}

export function stopManagerQueueWatcher(): boolean {
  if (!queueTimer) return false;
  clearInterval(queueTimer);
  queueTimer = undefined;
  return true;
}

export function managerQueueWatcherStatus(): { running: boolean; intervalMs: number; enabled: boolean } {
  return { running: !!queueTimer, intervalMs: managerQueueIntervalMs(), enabled: envFlag("MANAGER_QUEUE", true) };
}
