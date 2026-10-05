// ---------------------------------------------------------------------------
// NEEDS-YOU RULE (docs/NEEDS_YOU_RULE_SPEC.md)
//
// Pure functions that decide which run cards actually belong in the CEO's
// "Needs you" list.  Everything else (failed-but-not-blocking, stuck, working,
// done, closed, superseded) is filtered out here and routed to problems or
// in-progress by the briefing composer.
//
// RETRY LOOP (2026-09-30): this module also owns the two rules that stop a failed
// job from asking the CEO the same question forever:
//   - a job may be re-issued at most MAX_ORDER_RETRIES times, then it is EXHAUSTED;
//   - a prompt's id is derived from (job, why it failed), so a copy of the same job
//     failing again for the SAME reason is not a new prompt, while a NEW reason is.
// ---------------------------------------------------------------------------

import crypto from "node:crypto";
import type { RunCard } from "./runManagers.js";
import { budgetNeedsYou } from "./budgetGuard.js";

export type NeedCategory = "missing_key" | "spend_limit" | "real_choice";

export type ClassifyNeedResult = {
  need: boolean;
  reason?: string;
  category?: NeedCategory;
};

// Minimal shapes so this module can inspect records from fleet/tasks without
// owning the canonical types in fleet.ts / gates.ts.
export type OrderLike = {
  id?: string;
  text?: string;
  createdAt?: string;
  status?: string;
  closedAs?: string;
  supersededBy?: string;
  supersedes?: string[];
  /** why the order failed, as written by the fleet (plain words) */
  error?: string;
  /** how many times this job has been re-issued; written by the resolver on retry */
  retryCount?: number;
  trace?: Array<{ what?: string; detail?: string }>;
};

export type TaskLike = {
  rawRequest?: string;
  result?: string;
  closedAs?: string;
};

const NO_OP_RE = /smoke[- ]?test|tracking[- ]only|no-?op/i;

// "Missing ... access key / API key / secret / token / credential" with up to
// three intervening words (handles "missing Kimi access key", "invalid API key").
const MISSING_KEY_RE =
  /(?:missing|absent|invalid|bad|wrong|no|expired)(?:\s+\S+){0,3}\s+(?:access\s+key|api\s+key|secret|token|credential|auth)/i;

const SPEND_LIMIT_RE = /(?:spending|monthly|usage|rate)\s+limit|limit\s+(?:reached|exceeded|hit)/i;

/** In-memory no-op detection: smoke tests and tracking-only tasks are dropped. */
export function isNoOpTask(task: TaskLike): boolean {
  return NO_OP_RE.test(task.rawRequest ?? "") || NO_OP_RE.test(task.result ?? "");
}

function normaliseWords(text: string): Set<string> {
  const words = text.toLowerCase().match(/\b[a-z]{3,}\b/g) ?? [];
  return new Set(words);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  const intersection = new Set([...a].filter((w) => b.has(w)));
  return intersection.size / (a.size + b.size - intersection.size);
}

/** Longest-order-title key. Short/generic titles (under 20 chars) get no key, so
 *  unrelated short jobs are never collapsed together. */
export function orderTitleKey(text: string | undefined): string {
  const t = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length >= 20 ? t : "";
}

/**
 * A failed fleet order is superseded in memory when:
 *  - it was explicitly closed (closedAs / supersededBy), or
 *  - a later order explicitly names it in `supersedes`, or
 *  - a LATER order carries the SAME title (the retry loop reissues an order with
 *    the same text, so the older copies must not each raise their own prompt), or
 *  - a later FINISHED order has similar text (Jaccard >= 0.5).
 *
 * (DUPLICATE-PROMPTS, 2026-09-30: the same-title rule is what makes "at most one
 * prompt per order" hold when several copies of one job exist.)
 */
export function isSupersededOrder(order: OrderLike, allOrders: OrderLike[]): boolean {
  if (order.closedAs === "superseded" || order.supersededBy) return true;
  if (order.status !== "failed") return false;
  const orderCreated = Date.parse(order.createdAt ?? "");
  const orderText = order.text ?? "";
  const orderWords = normaliseWords(orderText);
  const orderTitle = orderTitleKey(orderText);

  for (const other of allOrders) {
    if (!other || other.id === order.id) continue;
    if (other.supersedes && Array.isArray(other.supersedes) && other.supersedes.includes(order.id ?? "")) {
      return true;
    }
    const otherCreated = Date.parse(other.createdAt ?? "");
    if (!Number.isFinite(orderCreated) || !Number.isFinite(otherCreated) || otherCreated <= orderCreated) continue;
    if (orderTitle && orderTitleKey(other.text ?? "") === orderTitle) return true;
    if (other.status === "done" && orderWords.size && jaccard(orderWords, normaliseWords(other.text ?? "")) >= 0.5) {
      return true;
    }
  }
  return false;
}

// ── RETRY LOOP (2026-09-30) ─────────────────────────────────────────────────
//
// MEASURED before this rule existed: one failed job's "Retry this order or drop it?"
// prompt was answered 6 times in ~20 minutes (company/reports/needs-you-decisions.json)
// and every answer minted a NEW order id, so the briefing raised what looked like a
// brand-new prompt for the same job and the chat asked again. Nothing bounded it.
//
// Two rules bound it now:
//   1. orderRetryExhausted() - a job may be re-issued maxOrderRetries() times
//      (default 2), then the resolver refuses to mint another copy and the briefing
//      raises ONE plain item that says so (with no "retry" button to mash).
//   2. jobPromptId() - the prompt's id is (job title + failure cause), so the same job
//      failing again for the SAME reason re-uses the id it already had (the page still
//      shows it, the chat does not ask a second time), while a genuinely NEW reason
//      produces a new id and is allowed to ask again.

/** How many times one job may be re-issued before a person must look at it. */
export function maxOrderRetries(): number {
  const raw = Number(process.env.FLEET_ORDER_MAX_RETRIES);
  return Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : 2;
}

/**
 * A stable, plain signature of WHY an order failed. It is deliberately coarse: it is
 * used to tell "the same failure again" from "a different failure", never to explain
 * the failure to the CEO (the card's headline does that).
 */
export function orderFailureCause(order: OrderLike): string {
  const probe = [order.error ?? "", ...(order.trace ?? []).slice(-4).map((t) => `${t?.what ?? ""} ${t?.detail ?? ""}`)].join(" ");
  if (/expired|not signed in|failed to authenticate|claude \/login/i.test(probe)) return "sign-in-expired";
  if (/spend(ing)? limit|monthly limit|usage limit|out of (usage|credit)/i.test(probe)) return "provider-limit";
  if (/produced no usable work orders/i.test(order.error ?? "")) return "planner-no-plan";
  if (/planning failed|plan failed|planning attempt/i.test(probe)) return "planning-failed";
  if (/access key|api key|credential/i.test(probe)) return "missing-key";
  if (/session limit|too many (sessions|terminals)|max_parallel/i.test(probe)) return "session-limit";
  if (/review (failed|unavailable)|review could not run/i.test(probe)) return "review-unavailable";
  return order.status === "failed" ? "failed" : "unfinished";
}

/**
 * How many times this order's JOB has already been retried (0 = first attempt).
 * The explicit `retryCount` (written by the resolver when it re-issues an order) wins;
 * for orders written before that field existed the depth is inferred by walking the
 * `supersededBy` chain (each retry marks the copy it replaced).
 */
export function orderRetryDepth(order: OrderLike, all: OrderLike[] = []): number {
  if (typeof order.retryCount === "number" && Number.isFinite(order.retryCount)) {
    return Math.max(0, Math.round(order.retryCount));
  }
  let depth = 0;
  const seen = new Set<string>([order.id ?? ""]);
  let cursor: OrderLike = order;
  for (;;) {
    const prev = all.find((o) => !!o && !!o.id && o.id !== cursor.id && o.supersededBy === cursor.id && !seen.has(o.id));
    if (!prev) break;
    seen.add(prev.id ?? "");
    depth += 1;
    cursor = prev;
    if (depth > 8) break;
  }
  return depth;
}

/** Has this job used up its retries? Then no further copy may be minted. */
export function orderRetryExhausted(order: OrderLike, all: OrderLike[] = []): boolean {
  return orderRetryDepth(order, all) >= maxOrderRetries();
}

/**
 * The order was marked exhausted by the resolver (retryCount written down) - used when
 * the order list is not at hand. Distinct from orderRetryExhausted, which also infers.
 */
export function isRetryExhaustedOrder(order: OrderLike): boolean {
  return typeof order.retryCount === "number" && order.retryCount >= maxOrderRetries();
}

/**
 * The stable id of the prompt for ONE job whose failure has ONE cause. Two copies of the
 * same job failing the same way produce the same id (so the page keeps one item and the
 * chat does not ask again); a different cause produces a different id (and may ask).
 */
export function jobPromptId(titleOrText: string | undefined, cause: string): string {
  const key = orderTitleKey(titleOrText) || String(titleOrText ?? "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 120);
  const hash = crypto.createHash("sha1").update(`${key}|${cause}`).digest("hex").slice(0, 10);
  return `fleet:job:${hash}`;
}

function providerFromCard(card: RunCard): "go" | "claude" | undefined {
  const text = `${card.headline} ${card.needsCeo ?? ""} ${card.verdictReason ?? ""}`.toLowerCase();
  if (/claude|anthropic/.test(text)) return "claude";
  if (/kimi|opencode\s*go|go\s+gateway|open\s*code\s*go/.test(text)) return "go";
  return undefined;
}

/**
 * Decide whether a run card should appear in the CEO's "Needs you" list.
 *
 * - real_choice: waiting_for_ceo from a genuine choice, or a fleet order awaiting
 *   approval.
 * - missing_key: failed run blocked by a missing/invalid access key / API key /
 *   secret / token / credential.
 * - spend_limit: failed run blocked by a provider spending/usage limit while that
 *   provider's budget guard item is still active.
 */
export function classifyNeed(card: RunCard): ClassifyNeedResult {
  // Closed/superseded records are never "needs you".
  if (card.state === "done") {
    return { need: false };
  }

  if (card.state === "waiting_for_ceo") {
    return {
      need: true,
      category: "real_choice",
      reason: "CEO must choose or approve before work can continue.",
    };
  }

  if (card.state !== "failed") {
    return { need: false };
  }

  const haystack = `${card.headline} ${card.needsCeo ?? ""} ${card.verdictReason ?? ""}`;

  if (MISSING_KEY_RE.test(haystack)) {
    return {
      need: true,
      category: "missing_key",
      reason: "Missing or invalid access key, API key, secret, token or credential is blocking the run.",
    };
  }

  if (SPEND_LIMIT_RE.test(haystack)) {
    const budget = budgetNeedsYou();
    const cardProvider = providerFromCard(card);
    if (budget && (!cardProvider || budget.provider === cardProvider)) {
      return {
        need: true,
        category: "spend_limit",
        reason: `Provider spending/usage limit is still blocking live work (${budget.provider}).`,
      };
    }
  }

  return { need: false };
}

// ── CEO APPROVAL POLICY (CEO order, 2026-09-30) ─────────────────────────────
//
// The CEO asked to stop being asked for approval on routine work. Only things that
// are RISKY may reach the CEO. The exact risk list, as given by the CEO:
//   1. deleting data
//   2. spending money or budget changes
//   3. logins / credentials / secrets
//   4. sending messages to people
//   5. publishing/promoting to the real site (the first real promote.ps1 run)
//   6. killing the CEO's own apps
//   7. anything that could break the live system (restarting the router, etc.)
//
// Everything else is ROUTINE and is decided by the manager: retry/drop of a failed
// or stale order, re-queueing, cleanups, routine fixes, which worker/model to use,
// test runs. Routine prompts are moved into the manager queue (company/reports/
// manager-queue.json, served at GET /api/manager-queue) instead of the CEO's
// "needs you" list; risky ones stay in "needs you".
//
// The classifier below is deliberately conservative: an item it does not
// understand stays RISKY (i.e. the CEO still sees it). Hiding a prompt by accident
// is worse than showing one prompt too many.

export type ApprovalRisk = "risky" | "routine";

/** One named risk rule. Exported so tests and ops tools can enumerate the exact list. */
export type RiskRule = { name: string; what: string; re: RegExp };

/** The CEO's risk list, one regex per item (order matches the CEO's wording). */
export const CEO_RISK_RULES: RiskRule[] = [
  { name: "delete_data", what: "deleting data", re: /\b(delete|deleting|wipe|wiping|erase|erasing|purge|purging|rm -rf|drop the (company|database|data|table)|remove the data)\b/i },
  { name: "money", what: "spending money or budget changes", re: /\b(spend|spending|budget|billing|invoice|payment|pay for|purchase|buy|top ?up|raise the limit|usage limit|credit card|cost limit)\b/i },
  { name: "credentials", what: "logins/credentials/secrets", re: /\b(log ?in|sign ?in|signin|password|secret|api key|access key|access token|credential|credentials|\.env|oauth)\b/i },
  { name: "message_people", what: "sending messages to people", re: /\b(send (an? )?(email|message|dm|slack)|email (the|to) |text the|post to (slack|twitter|x|linkedin)|tweet|notify (the )?(customer|client|user))\b/i },
  { name: "publish", what: "publishing/promoting to the real site", re: /\b(publish|promote|deploy|deployment|go live|going live|ship to (prod|production|live)|push to (prod|production|main|master)|release to the (public|real|live)|promote\.ps1)\b/i },
  { name: "kill_apps", what: "killing the CEO's own apps", re: /\b(kill|quit|close|shut ?down|terminate)\b[^.]{0,40}\b(app|apps|window|windows|terminal|session|process|browser|editor)\b/i },
  { name: "live_system", what: "anything that could break the live system", re: /\b(restart|reboot|stop|kill)\b[^.]{0,30}\b(router|server|supervisor|supervised)\b|\bdown ?time\b/i },
];

/** Effects that mean "ask the CEO" for reasons other than a retry/drop decision. */
const CEO_EFFECTS = new Set(["approve_gate", "provide_key", "recheck_budget", "open_link", "reissue_kimi"]);

/** Effects that are only ever a retry-or-drop decision (routine by themselves). */
const RETRY_DROP_EFFECTS = new Set(["retry_task", "drop_task", "retry_order", "drop_order"]);

/** How old a failed run must be before it counts as STALE (hours). */
export function staleAfterHours(): number {
  const raw = Number(process.env.MANAGER_QUEUE_STALE_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : 6;
}

/**
 * Structural view of a prompt, so this module can classify a briefing item without
 * importing briefing.ts (briefing.ts imports this module).
 */
export type RiskProbe = {
  kind?: string;
  text?: string;
  question?: string;
  reason?: string;
  actions?: Array<{ id?: string; label?: string; effect?: string }>;
  /** the run card's state, when the caller has it ("failed", "stuck", ...) */
  runState?: string;
  /** when the run last changed, ISO */
  updatedAt?: string;
};

export type ApprovalRiskResult = {
  risk: ApprovalRisk;
  /** plain words: why this is the manager's call, or why the CEO must see it */
  reason: string;
  /** the risk rule that matched, when risk === "risky" and a rule matched */
  rule?: string;
  /** a failed run nobody has touched for a while */
  stale: boolean;
};

/** Is this failed run stale (old enough that it is not live work anymore)? */
export function isStaleFailure(runState: string | undefined, updatedAt: string | undefined, now = Date.now()): boolean {
  if (runState !== "failed" && runState !== "stuck") return false;
  const at = Date.parse(updatedAt ?? "");
  if (!Number.isFinite(at)) return false;
  return now - at >= staleAfterHours() * 3600_000;
}

/**
 * Decide whether a prompt is the CEO's to answer (risky) or the manager's
 * (routine). Routine = a retry/drop decision about a failed or stale run and
 * nothing else; everything with a risk keyword, a gate approval, a key/secret
 * input, a budget action or an unknown shape stays with the CEO.
 */
export function classifyApprovalRisk(probe: RiskProbe, now = Date.now()): ApprovalRiskResult {
  const stale = isStaleFailure(probe.runState, probe.updatedAt, now);
  const actionText = (probe.actions ?? [])
    .map((a) => `${a?.id ?? ""} ${a?.label ?? ""} ${a?.effect ?? ""}`)
    .join(" ");
  const haystack = `${probe.text ?? ""} ${probe.question ?? ""} ${probe.reason ?? ""} ${actionText}`;

  for (const rule of CEO_RISK_RULES) {
    if (rule.re.test(haystack)) {
      return { risk: "risky", rule: rule.name, stale, reason: `the CEO's risk list: ${rule.what}` };
    }
  }

  const effects = (probe.actions ?? []).map((a) => a?.effect ?? "").filter(Boolean);
  const ceoEffect = effects.find((e) => CEO_EFFECTS.has(e));
  if (ceoEffect) {
    return { risk: "risky", stale, reason: `"${ceoEffect}" is the CEO's own decision, not a retry/drop call.` };
  }

  const onlyRetryDrop = effects.length > 0 && effects.every((e) => RETRY_DROP_EFFECTS.has(e));
  // Only a FINISHED run (failed/stuck) may be a routine retry/drop call. A run that is still
  // parked on the CEO is not this decision, and an unknown shape is never hidden.
  const finished = probe.runState === "failed" || probe.runState === "stuck";
  if (onlyRetryDrop && finished) {
    return {
      risk: "routine",
      stale,
      reason: stale
        ? "stale failure: retry/drop of a failed or stale order is the manager's call (CEO approval policy 2026-09-30)."
        : "retry/drop of a failed order is the manager's call (CEO approval policy 2026-09-30).",
    };
  }
  if (onlyRetryDrop && !finished) {
    return {
      risk: "risky",
      stale,
      reason: `a retry/drop prompt on a run in state "${probe.runState ?? "unknown"}" is not a finished failure, so it stays with the CEO.`,
    };
  }

  // Anything else (approvals, unknown effects, no actions at all): show the CEO.
  return { risk: "risky", stale, reason: "not a routine retry/drop decision, so it stays with the CEO." };
}

/** Failure causes a retry can plausibly fix by itself (transient / infrastructure). */
const AUTO_RETRYABLE_CAUSES = new Set([
  "failed",
  "unfinished",
  "planning-failed",
  "review-unavailable",
  "provider-limit",
]);

/** How many automatic retries the manager queue may spend on one job. */
export function managerQueueMaxRetries(): number {
  const raw = Number(process.env.MANAGER_QUEUE_MAX_RETRIES);
  return Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : maxOrderRetries();
}

/**
 * "The cause is fixed" in practice means the failure was transient (a gateway
 * connection error, a provider blip, a review that could not run), so a retry is
 * worth one attempt. Causes that need a person (a missing key, a session limit, a
 * planner that produced nothing) are NOT auto-retried: they escalate instead.
 */
export function causeAutoRetryable(cause: string | undefined): boolean {
  return AUTO_RETRYABLE_CAUSES.has(String(cause ?? "failed"));
}
