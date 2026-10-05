import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { config } from "../config.js";
import { postAs } from "../slack.js";
import { callClaudeSubscription } from "../claudeSubscription.js";
import { checkRuns, listRunCards, reportsDir, runCounts, runManagerKnobs } from "./runManagers.js";
import type { CheckSummary, RunCard } from "./runManagers.js";
import { classifyNeed, classifyApprovalRisk, jobPromptId, maxOrderRetries } from "./needsYouRule.js";
import { type RoutineRun, enqueueRoutineRuns, queueEscalations as readQueueEscalations } from "./managerQueue.js";
import { CLAUDE_SIGNIN_EXPIRED_MESSAGE, mentionsClaudeSignInExpired } from "./claudeSignIn.js";

// ---------------------------------------------------------------------------
// THE CEO BRIEFING (docs/REPORTING_SPEC.md section 2)
//
// One page for the CEO, rolled up from every run card: what needs them, what
// finished since they last looked, what is still in progress, and what broke.
// Everything a CEO reads here is plain words (the cards are already plain words,
// so this module mostly selects and orders them).
//
// DESIGN RULES (why it looks like this)
//  - GET is free and total. The page's SHAPE (needs you / done / in progress /
//    problems / counts) is composed locally from the cards on every read, so the
//    endpoints never block on a model and never show a stale "nothing to report".
//    Only the SUMMARY SENTENCE comes from Claude.
//  - Claude is spent only when a card changed, and at most once every
//    BRIEFING_MIN_INTERVAL_S (default 300s). Sonnet normally, Opus when anything
//    has failed (spec).
//  - "Done since last time" is measured against the moment the CEO last opened the
//    page (POST /company/briefing/seen). Until they open it once, the window starts
//    at local midnight, so the first morning briefing is "what happened today".
//  - Slack: ONE short message (postAs, persona ASSISTANT_CHIEF) when something
//    matters - a run finished, failed, got stuck, or a new "needs you" item - and
//    never more than one post per BRIEFING_SLACK_MIN_INTERVAL_S (default 600s)
//    UNLESS there is a new "needs you" item.
//  - The watcher loop (startBriefingWatcher, every BRIEFING_WATCH_INTERVAL_MS,
//    default 30s) is unref'd, non-overlapping, and wrapped so that it can never
//    crash the router: a failure is logged and the next tick tries again.
//
// Storage (REPORTING owns): company/reports/briefing.json (the page),
// briefing-meta.json (bookkeeping: which card set the page was built from, the
// last Slack post), briefing-seen.json (when the CEO last looked).
// ---------------------------------------------------------------------------

// ── "Needs you" classification (docs/NEEDS_YOU_SPEC.md) ─────────────────────

export type NeedsYouKind = "approve" | "choice" | "provide" | "external";
export type NeedsYouEffect =
  | "approve_gate" // params: {projectId, taskId, gate:'intake'|'code'|'merge', note?}
  | "retry_task" // params: {projectId, taskId}
  | "drop_task" // params: {projectId, taskId}
  | "retry_order" // params: {orderId}   reissue same text, normal model rules
  | "reissue_kimi" // params: {orderId}   reissue with planner/reviewer forced to Kimi
  | "drop_order" // params: {orderId}
  | "provide_key" // params: {orderId?, envName:'OPENCODE_API_KEY'} then retry_order
  | "open_link" // params: {url}  (UI opens it; resolver just logs, does NOT resolve the item)
  | "recheck_budget"; // params: {provider:'claude'|'go'}

export type NeedsYouAction = {
  id: string;
  label: string;
  effect: NeedsYouEffect;
  params?: Record<string, string>;
  url?: string;
};

export type NeedsYouInput = {
  name: string;
  label: string;
  secret: boolean;
  placeholder?: string;
};

export type BriefingItem = {
  text: string;
  runId?: string;
  id?: string; // present on every needsYou item (problems[] may omit)
  kind?: NeedsYouKind;
  actions?: NeedsYouAction[];
  question?: string; // plain words, required for 'choice' and 'external'
  input?: NeedsYouInput; // required for 'provide'
  // docs/NEEDS_YOU_RULE_SPEC.md §1: optional; plain words why a person must act.
  reason?: string;
  // DUPLICATE-PROMPTS: the run's own title, used to collapse several copies of one
  // job (the retry loop reissues the same order text) into a single prompt.
  title?: string;
};

export type BriefingDone = { text: string; runId?: string; at: string };
export type BriefingProgress = { text: string; runId?: string; owner: string; remaining: string[] };

export type Briefing = {
  generatedAt: string;
  model: string;
  summary: string;
  needsYou: BriefingItem[];
  done: BriefingDone[];
  inProgress: BriefingProgress[];
  problems: BriefingItem[];
  counts: { running: number; done: number; failed: number; stuck: number };
  // CEO APPROVAL POLICY (2026-09-30): routine prompts (retry/drop of a failed or
  // stale order) that this read routed OUT of "needs you" and INTO the manager
  // queue (company/reports/manager-queue.json). Kept on the briefing so the
  // caller persists them; the page the CEO reads never shows them.
  managerQueue?: RoutineRun[];
};

type BriefingMeta = {
  cardStamp: string;
  modelReason?: string;
  lastSlackAt?: string;
  lastSlackSummary?: string;
  slackSeen?: { done: string[]; failed: string[]; stuck: string[]; needsYou: string[] };
  lastError?: string;
  lastTickAt?: string;
  lastTickSummary?: string;
};

const DONE_MAX = 12;
const PROGRESS_MAX = 12;
const PROBLEMS_MAX = 8;
const NEEDS_MAX = 6;
const SLACK_MAX_CHARS = 1400;

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

function nowIso(): string {
  return new Date().toISOString();
}

function clip(text: string, max: number): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/**
 * DUPLICATE-PROMPTS: a stable key for a run's job, used to collapse several copies of
 * one order into a single prompt. Titles shorter than 20 characters get no key, so
 * unrelated short jobs are never merged by accident.
 */
function cardTitleKey(title: string | undefined): string {
  const t = String(title ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length >= 20 ? t : "";
}

function briefingFile(): string {
  return path.join(reportsDir(), "briefing.json");
}

function metaFile(): string {
  return path.join(reportsDir(), "briefing-meta.json");
}

function seenFile(): string {
  return path.join(reportsDir(), "briefing-seen.json");
}

function resolvedFile(): string {
  return path.join(reportsDir(), "needs-you-resolved.json");
}

function readJson<T>(file: string): T | undefined {
  try {
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJson(file: string, value: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    // the briefing is a view; a failed write must never break a caller
  }
}

// ── "since the CEO last looked" ─────────────────────────────────────────────

/** Local midnight, so the first briefing of the day reads as "what happened today". */
function localMidnight(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export function briefingSeenAt(): string {
  const seen = readJson<{ seenAt?: string }>(seenFile());
  const parsed = Date.parse(seen?.seenAt ?? "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : localMidnight();
}

/** Mark "the CEO has seen the briefing now": drives the Done list on the next read. */
export function markBriefingSeen(at = nowIso()): { seenAt: string; briefing: Briefing } {
  const seenAt = at;
  writeJson(seenFile(), { seenAt });
  return { seenAt, briefing: getBriefing() };
}

// ── "needs you" classification (pure) ───────────────────────────────────────

function parseTaskRef(runId: string): { projectId: string; taskId: string } | undefined {
  const m = /^task:([^:]+):(.+)$/.exec(runId);
  if (!m) return undefined;
  return { projectId: m[1]!, taskId: m[2]! };
}

function parseFleetRef(runId: string): { orderId: string } | undefined {
  const m = /^fleet:([^:]+)$/.exec(runId);
  if (!m) return undefined;
  return { orderId: m[1]! };
}

function inferGate(text: string, taskStatus?: string): "intake" | "code" | "merge" {
  const t = (text ?? "").toLowerCase();
  if (taskStatus === "pending_intake" || /\bintake\b/.test(t)) return "intake";
  if (taskStatus === "pending_code" || /\bcode\b/.test(t)) return "code";
  if (taskStatus === "pending_merge" || /\bmerge\b/.test(t) || /\bplan\b/.test(t)) return "merge";
  return "merge";
}

function looksLikeChoice(text: string): { recommended: string; alternative: string } | undefined {
  const t = (text ?? "").trim();
  if (!t) return undefined;
  // "Approve the recommended X (or choose the Y) ..."
  const m1 = /recommended\s+([^,(]+)\s*\(\s*or\s+choose\s+(?:the\s+)?([^)]+)\)/i.exec(t);
  if (m1) {
    return {
      recommended: m1[1]!.trim(),
      alternative: m1[2]!.trim(),
    };
  }
  // "Approve X or choose Y"
  const m2 = /approve\s+(?:the\s+)?([^,]+)\s+or\s+(?:choose|pick)\s+(?:the\s+)?([^.,]+)/i.exec(t);
  if (m2) {
    return {
      recommended: m2[1]!.trim(),
      alternative: m2[2]!.trim(),
    };
  }
  return undefined;
}

function mentionsMissingKey(text: string): boolean {
  return /access key|api key|missing .*key|kimi key/i.test(text ?? "");
}

function mentionsClaudeLimit(text: string): boolean {
  return /spend(ing)? limit|monthly limit|usage limit|out of (usage|credit)/i.test(text ?? "");
}

/**
 * Turn one run card into a classified "needs you" item.
 * Pure: no disk, no model, no secrets.
 */
export function classifyNeedsYou(card: RunCard, taskStatus?: string): BriefingItem {
  const text =
    card.state === "waiting_for_ceo"
      ? card.needsCeo
        ? `${card.headline} ${card.needsCeo}`
        : `${card.headline} Waiting on your go-ahead.`
      : card.needsCeo ?? `${card.headline} Decide whether to resume it or drop it.`;
  const id = card.runId;
  // docs/NEEDS_YOU_RULE_SPEC.md §3: the rule module explains WHY the CEO must act.
  // Attaching its reason keeps the briefing and the rule in agreement, and gives the
  // UI something honest to show on each prompt.
  const reason = classifyNeed(card).reason;
  const base: BriefingItem = {
    text,
    runId: id,
    id,
    title: card.title,
    ...(reason ? { reason } : {}),
  };

  if (card.kind === "task") {
    const ref = parseTaskRef(card.runId);
    if (card.state === "waiting_for_ceo") {
      const choice = looksLikeChoice(card.needsCeo ?? card.headline);
      if (choice) {
        return {
          ...base,
          kind: "choice",
          question: card.needsCeo ?? "Which option do you want?",
          actions: [
            {
              id: "approve",
              label: `Approve ${choice.recommended}`,
              effect: "approve_gate",
              params: { projectId: ref?.projectId ?? "", taskId: ref?.taskId ?? "", gate: "merge", note: choice.recommended },
            },
            {
              id: "approve_alt",
              label: `Choose ${choice.alternative}`,
              effect: "approve_gate",
              params: { projectId: ref?.projectId ?? "", taskId: ref?.taskId ?? "", gate: "merge", note: choice.alternative },
            },
          ],
        };
      }
      const gate = inferGate(card.needsCeo ?? card.headline, taskStatus);
      return {
        ...base,
        kind: "approve",
        actions: [
          {
            id: "approve",
            label: `Approve ${gate === "intake" ? "intake" : gate === "code" ? "the plan" : "the merge"}`,
            effect: "approve_gate",
            params: { projectId: ref?.projectId ?? "", taskId: ref?.taskId ?? "", gate },
          },
          {
            id: "drop",
            label: "Drop task",
            effect: "drop_task",
            params: { projectId: ref?.projectId ?? "", taskId: ref?.taskId ?? "" },
          },
        ],
      };
    }
    // failed task
    return {
      ...base,
      kind: "choice",
      question: "Retry this task or drop it?",
      actions: [
        {
          id: "retry",
          label: "Retry task",
          effect: "retry_task",
          params: { projectId: ref?.projectId ?? "", taskId: ref?.taskId ?? "" },
        },
        {
          id: "drop",
          label: "Drop task",
          effect: "drop_task",
          params: { projectId: ref?.projectId ?? "", taskId: ref?.taskId ?? "" },
        },
      ],
    };
  }

  if (card.kind === "fleet") {
    const ref = parseFleetRef(card.runId);
    const orderId = ref?.orderId ?? "";
    const probe = `${card.headline} ${card.needsCeo ?? ""}`;
    // RETRY LOOP (2026-09-30): the prompt's id is (job, why it failed), NOT the order id.
    // Every answer to "Retry this order or drop it?" used to mint a new order id, which
    // made the same question look like a brand-new prompt (and made the chat ask it
    // again). Same job + same cause = same id = ONE prompt; a NEW cause is a NEW id and is
    // the only thing allowed to ask again. A title too short/generic to identify a job
    // (< 20 chars) keeps its per-run id, exactly as before, so two unrelated short jobs are
    // never merged.
    const failureCause = card.fleetFailureCause ?? "failed";
    const stableJobId = cardTitleKey(card.title) ? jobPromptId(card.title, failureCause) : base.id;
    const fleetBase: BriefingItem = { ...base, id: stableJobId };

    // EXPIRED CLAUDE SIGN-IN COMES FIRST. It has to outrank every other branch, including the
    // retry-exhausted one below: retrying cannot fix it (only the CEO running `claude /login`
    // can), so an order that is BOTH retried out AND sign-in-expired must still be shown the one
    // action that actually helps. Measured 2026-09-30: with this check AFTER the retry-exhausted
    // branch, such an order was shown "already been retried 2 times ... Drop it here" with only a
    // Drop button - the exact prompt this work was asked to remove.
    if (mentionsClaudeSignInExpired(probe) || mentionsClaudeSignInExpired(card.verdictReason)) {
      return {
        ...fleetBase,
        kind: "external",
        question: CLAUDE_SIGNIN_EXPIRED_MESSAGE,
        // Still one button, so the item can be cleared: the CEO signs in in a terminal, then
        // asks for the work again. There is deliberately no "drop" alternative here.
        actions: [
          {
            id: "signed_in_retry",
            label: "I ran claude /login - retry this order",
            effect: "retry_order",
            params: { orderId },
          },
        ],
      };
    }

    // The retry budget is spent: say so ONCE, in plain words, with nothing to mash.
    // (Before this, the same "Retry this order or drop it?" came back after every attempt.)
    if (card.fleetRetryExhausted) {
      return {
        ...fleetBase,
        kind: "choice",
        question: `This job has already been retried ${maxOrderRetries()} times and the last attempt failed the same way. Retrying it as it is will fail again - the cause has to be fixed first. Drop it here, or ask for it again in chat once you have fixed it.`,
        reason: "The same failure came back after the retry cap, so another automatic retry would just burn tokens.",
        actions: [{ id: "drop", label: "Drop this job", effect: "drop_order", params: { orderId } }],
      };
    }

    if (mentionsMissingKey(probe)) {
      return {
        ...fleetBase,
        kind: "provide",
        question: card.needsCeo ?? "Add the missing access key.",
        input: {
          name: "OPENCODE_API_KEY",
          label: "Kimi access key (OpenCode Go gateway)",
          secret: true,
          placeholder: "sk-...",
        },
        actions: [
          {
            id: "save_key_retry",
            label: "Save key and retry",
            effect: "provide_key",
            params: { orderId, envName: "OPENCODE_API_KEY" },
          },
          {
            id: "drop",
            label: "Drop order",
            effect: "drop_order",
            params: { orderId },
          },
        ],
      };
    }

    if (mentionsClaudeLimit(probe)) {
      return {
        ...fleetBase,
        kind: "external",
        question: "Claude hit its spending limit. Raise it at claude.ai, use Kimi instead, or tell us you raised it.",
        actions: [
          {
            id: "open_limit_page",
            label: "Open Claude usage settings",
            effect: "open_link",
            params: { url: "https://claude.ai/settings/usage" },
            url: "https://claude.ai/settings/usage",
          },
          {
            id: "use_kimi",
            label: "Retry with Kimi",
            effect: "reissue_kimi",
            params: { orderId },
          },
          {
            id: "raised_retry",
            label: "I raised the limit - retry",
            effect: "retry_order",
            params: { orderId },
          },
        ],
      };
    }

    // failed fleet fallback
    return {
      ...fleetBase,
      kind: "choice",
      question: card.needsCeo ?? "Retry this order or drop it?",
      actions: [
        { id: "retry", label: "Retry order", effect: "retry_order", params: { orderId } },
        { id: "drop", label: "Drop order", effect: "drop_order", params: { orderId } },
      ],
    };
  }

  // jcode or unknown kind: keep plain item so callers still render it
  return base;
}

export type BudgetNeedsYouSource = { text: string; provider: "go" | "claude"; level: string };

/**
 * Turn a budget-guard alert into a classified "needs you" item.
 * Pure: no disk, no model, no secrets.
 */
export function budgetNeedsYouItem(b: BudgetNeedsYouSource | null | undefined): BriefingItem | null {
  if (!b) return null;
  const id = `budget:${b.provider}`;
  const base: BriefingItem = { text: b.text, id };

  if (b.provider === "claude") {
    return {
      ...base,
      kind: "external",
      question: "Claude hit its spending limit. Raise it at claude.ai, use Kimi instead, or tell us you raised it.",
      actions: [
        {
          id: "open_limit_page",
          label: "Open Claude usage settings",
          effect: "open_link",
          params: { url: "https://claude.ai/settings/usage" },
          url: "https://claude.ai/settings/usage",
        },
        {
          id: "use_kimi",
          label: "Retry every Claude-limit order with Kimi",
          effect: "reissue_kimi",
        },
        {
          id: "raised_retry",
          label: "I raised the limit - recheck budget",
          effect: "recheck_budget",
          params: { provider: "claude" },
        },
      ],
    };
  }

  return {
    ...base,
    kind: "external",
    question: "OpenCode Go is nearly out. Open the dashboard or recheck budget?",
    actions: [
      {
        id: "open_limit_page",
        label: "Open OpenCode dashboard",
        effect: "open_link",
        params: { url: "https://opencode.ai" },
        url: "https://opencode.ai",
      },
      {
        id: "raised_retry",
        label: "Recheck budget",
        effect: "recheck_budget",
        params: { provider: "go" },
      },
    ],
  };
}

// ── composition (pure: no disk, no LLM) ─────────────────────────────────────

/**
 * The page's structure, built from the cards. A run card's own headline/done/
 * remaining are already plain words (the manager wrote them), so the briefing only
 * has to choose what matters and order it: decisions first.
 */
export function composeBriefing(
  cards: RunCard[],
  opts: {
    seenAt: string;
    summary: string;
    model: string;
    generatedAt?: string;
    resolved?: Record<string, { at: string }>;
    taskStatus?: (projectId: string, taskId: string) => string | undefined;
    budgetItem?: BriefingItem | null;
    /** CEO APPROVAL POLICY: the ONE prompt each escalated manager-queue entry raises. */
    queueEscalations?: BriefingItem[];
  }
): Briefing {
  const counts = {
    running: cards.filter((c) => c.state === "working").length,
    done: cards.filter((c) => c.state === "done").length,
    failed: cards.filter((c) => c.state === "failed").length,
    stuck: cards.filter((c) => c.state === "stuck").length,
  };

  const resolved = opts.resolved ?? {};
  const isResolved = (item: BriefingItem): boolean => {
    const r = item.id ? resolved[item.id] : undefined;
    if (!r || !r.at) return false;
    const resolvedAt = Date.parse(r.at);
    if (!Number.isFinite(resolvedAt)) return false;
    const card = cards.find((c) => c.runId === item.runId);
    const cardAt = Date.parse(card?.updatedAt ?? "");
    if (!Number.isFinite(cardAt)) return false;
    return resolvedAt >= cardAt;
  };

  const needsYou: BriefingItem[] = [];
  const usedRunIds = new Set<string>();
  // DUPLICATE-PROMPTS: collect the candidates with their card first, so several copies
  // of ONE job (the retry loop reissues the same order text) can be collapsed into a
  // single prompt below. runManagers also closes the older copies; this is the
  // belt-and-braces guarantee that the CEO sees at most one prompt per run/order.
  const cands: { item: BriefingItem; card: RunCard }[] = [];
  // CEO APPROVAL POLICY (2026-09-30): prompts that are only "retry/drop this failed or
  // stale thing" are the manager's call. They are collected here instead of going into
  // "needs you"; the caller persists them into company/reports/manager-queue.json. They
  // are deduped by JOB below, with the same newest-wins rule the CEO's list uses.
  const routineCands: { item: BriefingItem; card: RunCard }[] = [];
  const pushCand = (card: RunCard, item: BriefingItem) => {
    if (!item.text) return;
    const key = item.runId ?? item.id ?? "";
    if (key && usedRunIds.has(key)) return;
    if (item.id && isResolved(item)) return;
    const risk = classifyApprovalRisk({
      kind: item.kind,
      text: item.text,
      question: item.question,
      reason: item.reason,
      actions: item.actions,
      runState: card.state,
      updatedAt: card.updatedAt,
    });
    if (risk.risk === "routine") {
      if (key) usedRunIds.add(key);
      routineCands.push({ item, card });
      return;
    }
    if (key) usedRunIds.add(key);
    cands.push({ item, card });
  };

  // Budget item first when present (kept outside the title dedupe: it is not a run).
  if (opts.budgetItem && opts.budgetItem.text) {
    const r = resolved[opts.budgetItem.id ?? ""];
    if (!r || !r.at || Date.parse(r.at) < Date.now() - 86400_000) {
      // Budget items are transient pressure alerts: hide them for 24 h after the CEO
      // acts, because the guard refreshes its own state every poll. A fresh red alert
      // still shows immediately if no resolve timestamp exists.
      if (needsYou.length < NEEDS_MAX) needsYou.push(opts.budgetItem);
    }
  }

  // CEO APPROVAL POLICY: a manager-queue entry that spent its automatic retries raises
  // exactly ONE prompt here. Everything else routine stayed out of this list.
  for (const esc of opts.queueEscalations ?? []) {
    if (!esc.text) continue;
    if (esc.id && isResolved(esc)) continue;
    if (needsYou.length >= NEEDS_MAX) break;
    needsYou.push(esc);
  }

  // 1. Runs parked on the CEO. 2. Failures (a decision: resume, redo, drop?).
  for (const c of cards.filter((c) => c.state === "waiting_for_ceo")) {
    const status =
      c.kind === "task"
        ? (() => {
            const ref = parseTaskRef(c.runId);
            return ref ? opts.taskStatus?.(ref.projectId, ref.taskId) : undefined;
          })()
        : undefined;
    pushCand(c, classifyNeedsYou(c, status));
  }
  for (const c of cards.filter((c) => c.state === "failed")) {
    pushCand(c, classifyNeedsYou(c));
  }

  // One prompt per job: keep the newest card, drop the older copies. Two candidates share a
  // group when they carry the same long title OR the same stable prompt id (same job and
  // same failure cause - the retry loop reissues one job as several orders).
  const stampOf = (c: RunCard) =>
    Math.max(Date.parse(c.updatedAt ?? "") || 0, Date.parse(c.checkedAt ?? "") || 0);
  const groupKeyOf = (cand: { item: BriefingItem; card: RunCard }): string =>
    cardTitleKey(cand.card.title) || (cand.item.id ? `id:${cand.item.id}` : "");
  const winnerByTitle = new Map<string, { item: BriefingItem; card: RunCard }>();
  for (const cand of cands) {
    const titleKey = groupKeyOf(cand);
    if (!titleKey) continue;
    const cur = winnerByTitle.get(titleKey);
    // Newest wins; on an exact tie the higher runId wins, so the choice does not depend
    // on the order the cards arrived in (an order-dependent winner could flip between
    // ticks and make the chat ask two different copies).
    const better =
      !cur ||
      stampOf(cand.card) > stampOf(cur.card) ||
      (stampOf(cand.card) === stampOf(cur.card) && (cand.item.id ?? "") > (cur.item.id ?? ""));
    if (better) winnerByTitle.set(titleKey, cand);
  }
  for (const cand of cands) {
    const titleKey = groupKeyOf(cand);
    if (titleKey && winnerByTitle.get(titleKey) !== cand) continue; // an older duplicate of the same job
    if (needsYou.length >= NEEDS_MAX) break;
    needsYou.push(cand.item);
  }

  // CEO APPROVAL POLICY: ONE manager-queue entry per JOB, newest copy wins - the same
  // guarantee the CEO's list has, so a job reissued five times is queued once (keyed on
  // the stable job id when the card has one). Routine items are NOT bounded by NEEDS_MAX:
  // they are not shown to anyone, the file itself is capped.
  const routineWinner = new Map<string, { item: BriefingItem; card: RunCard }>();
  for (const cand of routineCands) {
    const jobKey = cardTitleKey(cand.card.title) || cand.item.id || cand.card.runId;
    const cur = routineWinner.get(jobKey);
    const better =
      !cur ||
      stampOf(cand.card) > stampOf(cur.card) ||
      (stampOf(cand.card) === stampOf(cur.card) && (cand.item.runId ?? "") > (cur.item.runId ?? ""));
    if (better) routineWinner.set(jobKey, cand);
  }
  const routedRoutine: RoutineRun[] = [...routineWinner.values()].map(({ item, card }) => ({
    ...(item.runId ? { runId: item.runId } : {}),
    ...(item.id ? { itemId: item.id } : {}),
    ...(item.title ? { title: item.title } : {}),
    text: item.text,
    state: card.state,
    updatedAt: card.updatedAt,
    ...(card.fleetFailureCause ? { failureCause: card.fleetFailureCause } : {}),
  }));

  const problems: BriefingItem[] = [];
  for (const c of cards.filter((c) => c.state === "failed")) {
    problems.push({
      text: c.verdict === "FAIL" ? `${c.headline} (the manager could not verify it)`.replace(/\.$/, "") : c.headline,
      runId: c.runId,
    });
  }
  for (const c of cards.filter((c) => c.state === "stuck")) {
    if (problems.length < PROBLEMS_MAX) problems.push({ text: c.headline, runId: c.runId });
  }

  const inProgress: BriefingProgress[] = cards
    .filter((c) => c.state === "working")
    .slice(0, PROGRESS_MAX)
    .map((c) => ({ text: c.headline, runId: c.runId, owner: c.owner, remaining: c.remaining.slice(0, 4) }));

  // Done since the CEO last looked, newest first. A verified finish says so.
  const seenMs = Date.parse(opts.seenAt);
  const done: BriefingDone[] = cards
    .filter((c) => c.state === "done")
    .map((c) => ({ c, at: c.verdict ? c.verifiedAt ?? c.checkedAt : c.updatedAt || c.checkedAt }))
    .filter((x) => !Number.isFinite(seenMs) || Date.parse(x.at) >= seenMs)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, DONE_MAX)
    .map((x) => ({
      text: x.c.verdict === "PASS" ? `${x.c.headline} Verified by the manager and closed.` : x.c.headline,
      runId: x.c.runId,
      at: x.at,
    }));

  // Terminal closes recorded by AUTOCLOSE (docs/AUTOCLOSE_SPEC.md) are additionally
  // "done" evidence, so a closed window shows up here even if its card is quiet.
  for (const c of terminalClosesSince(seenMs).slice(0, 4)) {
    if (done.some((d) => d.runId && c.runId && d.runId === c.runId)) continue;
    if (done.length >= DONE_MAX) break;
    done.push(c);
  }
  done.sort((a, b) => b.at.localeCompare(a.at));

  return {
    generatedAt: opts.generatedAt ?? nowIso(),
    model: opts.model,
    summary: opts.summary,
    needsYou,
    done,
    inProgress,
    problems: problems.slice(0, PROBLEMS_MAX),
    counts,
    ...(routedRoutine.length ? { managerQueue: routedRoutine } : {}),
  };
}

/** AUTOCLOSE appends {at, sessionId, sessionName, runId?, reason?} per closed window. */
function terminalClosesSince(seenMs: number): BriefingDone[] {
  try {
    const file = path.join(reportsDir(), "terminals.jsonl");
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim());
    const out: BriefingDone[] = [];
    for (const line of lines.slice(-200)) {
      try {
        const rec = JSON.parse(line) as { at?: string; sessionId?: string; sessionName?: string; role?: string; reason?: string };
        const at = rec.at ?? "";
        if (!at || (Number.isFinite(seenMs) && Date.parse(at) < seenMs)) continue;
        const who = rec.role ? `${rec.role}: ${rec.sessionName ?? rec.sessionId ?? "a session"}` : `jcode ${rec.sessionName ?? rec.sessionId ?? "session"}`;
        out.push({
          text: `${who} finished and its terminal was closed.`,
          ...(rec.sessionId ? { runId: `jcode:${rec.sessionId}` } : {}),
          at,
        });
      } catch {
        // skip a partial line
      }
    }
    return out;
  } catch {
    return [];
  }
}

function localSummary(cards: RunCard[], needsYou: number): string {
  const c = runCounts(cards);
  if (!c.total) return "No runs tracked yet. Nothing needs you.";
  const parts = [`${c.total} runs tracked:`, `${c.running} still working`, `${c.done} finished`, `${c.failed} failed`, `${c.stuck} stuck`];
  const tail = needsYou > 0 ? ` ${needsYou} item(s) need your decision.` : " Nothing needs your decision right now.";
  return `${parts.join(" ")}.${tail}`;
}

function cardStamp(cards: RunCard[]): string {
  const canonical = cards
    .map((c) => `${c.runId}|${c.state}|${c.verdict ?? "-"}|${c.evidenceHash}|${c.headline}`)
    .sort()
    .join("\n");
  return crypto.createHash("sha1").update(canonical).digest("hex").slice(0, 16);
}

// ── the summary sentence (the only model call) ───────────────────────────────

const SUMMARY_SYSTEM = `You write the first paragraph of the CEO's morning briefing for a small AI software company.

Rules:
- 2-3 short sentences, plain words, no jargon, no file paths, no model names.
- Say what matters: what finished, what is in progress, and anything the CEO must decide.
- Speak about work, not about tooling. "The dashboard rebuild" not "the briefing UI view".
- Never invent status. Use ONLY the run cards given.
- Do not use bullet points; write prose.

Answer with ONLY this JSON, no prose and no code fences:
{"summary":"..."}`;

async function briefingSummary(cards: RunCard[], counts: Briefing["counts"], needsYouCount: number, failures: number): Promise<{ summary: string; model: string; reason: string }> {
  // CHEAP BY DEFAULT (docs/CHEAP_BY_DEFAULT_SPEC.md Job 2): the briefing is DeepSeek by default
  // and reaches Claude only when Laya calls the roll-up big. `sonnet` here is the CEILING handed to
  // the gate (`purpose: "briefing"`), not the model that runs - and brainRouter's table says a
  // briefing may never take Opus, so the old "failures > 0 -> Opus" pick could only mislead the page.
  const ceiling = config.claudeSonnet;
  const why = failures > 0 ? `${failures} failed run(s) in this briefing` : "nothing failed";
  const reason = `Sonnet ceiling (${why}); the Laya gate picks the tier`;
  if (config.mockMode) return { summary: localSummary(cards, needsYouCount), model: "local", reason: "MOCK_MODE=1" };
  // RUN_MANAGER_BACKEND=heuristic means "spend nothing": the manager cards are local
  // too, so the summary must be as well (used by ops/tests and by the CEO if they
  // ever want the briefing to run for free).
  if (runManagerKnobs().backend === "heuristic") {
    return { summary: localSummary(cards, needsYouCount), model: "local", reason: "RUN_MANAGER_BACKEND=heuristic (no model calls)" };
  }
  const compact = cards.slice(0, 30).map((c) => ({
    kind: c.kind,
    state: c.state,
    owner: c.owner,
    headline: c.headline,
    remaining: c.remaining.slice(0, 3),
    ...(c.needsCeo ? { needsCeo: c.needsCeo } : {}),
  }));
  const user = [`Counts: ${JSON.stringify(counts)}. Items needing the CEO: ${needsYouCount}.`, `Run cards (JSON):`, JSON.stringify(compact)].join("\n");
  try {
    const out = await callClaudeSubscription({ model: ceiling, system: SUMMARY_SYSTEM, user, cwd: process.cwd(), purpose: "briefing" });
    // CHEAP BY DEFAULT: report the tier and model the gate actually chose, never the ceiling.
    const ranOn = out.brain?.model || out.model || ceiling;
    const gateReason = out.brain
      ? out.brain.tier === "none"
        ? `${reason} -> ${out.brain.reason} (cheap summary, no Claude call)`
        : `${reason} -> ${out.brain.reason}`
      : reason;
    const start = out.text.indexOf("{");
    const end = out.text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const parsed = JSON.parse(out.text.slice(start, end + 1)) as { summary?: unknown };
      if (typeof parsed.summary === "string" && parsed.summary.trim()) {
        return { summary: clip(parsed.summary, 700), model: ranOn, reason: gateReason };
      }
    }
    return { summary: clip(out.text, 700) || localSummary(cards, needsYouCount), model: ranOn, reason: `${gateReason}; model returned prose, used as-is` };
  } catch (e) {
    return {
      summary: localSummary(cards, needsYouCount),
      model: "local",
      reason: `model call failed (${clip(e instanceof Error ? e.message : String(e), 120)}) - local summary`,
    };
  }
}

// ── reading and refreshing ───────────────────────────────────────────────────

function readResolved(): Record<string, { at: string }> {
  try {
    return readJson<Record<string, { at: string }>>(resolvedFile()) ?? {};
  } catch {
    return {};
  }
}

const requireFromHere = createRequire(import.meta.url);

function budgetItemNow(): BriefingItem | null {
  try {
    const { budgetNeedsYou } = requireFromHere("./budgetGuard.js") as typeof import("./budgetGuard.js");
    const b = budgetNeedsYou();
    if (!b) return null;
    return budgetNeedsYouItem(b);
  } catch {
    return null;
  }
}

function taskStatusNow(projectId: string, taskId: string): string | undefined {
  try {
    const { getTask } = requireFromHere("./gates.js") as typeof import("./gates.js");
    return getTask(projectId, taskId)?.status;
  } catch {
    return undefined;
  }
}

/**
 * CEO APPROVAL POLICY: the ONE prompt per escalated manager-queue entry. Read-only.
 */
function escalationItemsNow(): BriefingItem[] {
  try {
    return readQueueEscalations();
  } catch {
    return [];
  }
}

/**
 * CEO APPROVAL POLICY: write this pass's routine retry/drop prompts into the manager
 * queue (company/reports/manager-queue.json) so the tick can decide them. Called from
 * refreshBriefing, NOT from getBriefing - a page read must stay write-free.
 */
function persistRoutineRuns(runs: RoutineRun[] | undefined): { added: number; reopened: number; skipped: number } {
  if (!runs || !runs.length) return { added: 0, reopened: 0, skipped: 0 };
  try {
    const res = enqueueRoutineRuns(runs);
    return { added: res.added, reopened: res.reopened, skipped: res.skipped };
  } catch {
    return { added: 0, reopened: 0, skipped: 0 };
  }
}

/**
 * The latest briefing. Never blocks, never writes, never calls a model: it re-reads
 * the cards and re-renders the page shape (so "done since last time" is always
 * current), keeping the summary sentence that was last generated.
 */
export function getBriefing(): Briefing {
  const seenAt = briefingSeenAt();
  const stored = readJson<Briefing>(briefingFile());
  try {
    const cards = listRunCards();
    const draft = composeBriefing(cards, {
      seenAt,
      summary: "",
      model: stored?.model ?? "local",
      resolved: readResolved(),
      taskStatus: taskStatusNow,
      budgetItem: budgetItemNow(),
      queueEscalations: escalationItemsNow(),
    });
    const summary = stored?.summary && stored.summary.trim() ? stored.summary : localSummary(cards, draft.needsYou.length);
    return { ...draft, summary, generatedAt: stored?.generatedAt ?? draft.generatedAt, model: stored?.model ?? "local" };
  } catch (e) {
    if (stored) return stored;
    return {
      generatedAt: nowIso(),
      model: "local",
      summary: `The briefing could not be read (${clip(e instanceof Error ? e.message : String(e), 120)}).`,
      needsYou: [],
      done: [],
      inProgress: [],
      problems: [],
      counts: { running: 0, done: 0, failed: 0, stuck: 0 },
    };
  }
}

export type RefreshResult = { briefing: Briefing; checked: CheckSummary; regenerated: boolean; posted: { posted: boolean; error?: string } };

/**
 * One refresh pass: manager-check the runs, then re-render the page (and its summary
 * sentence when a card changed and the min interval allows). `force` skips both
 * cost guards. Safe to call from the watcher and from POST /company/briefing/refresh.
 */
export async function refreshBriefing(opts: { force?: boolean; maxChecks?: number } = {}): Promise<RefreshResult> {
  const checked = await checkRuns({ force: opts.force, maxChecks: opts.maxChecks });
  const cards = listRunCards();
  const stored = readJson<Briefing>(briefingFile());
  const meta = readJson<BriefingMeta>(metaFile()) ?? { cardStamp: "" };
  const stamp = cardStamp(cards);
  const minIntervalS = envNum("BRIEFING_MIN_INTERVAL_S", 300, 0);
  const lastGeneratedMs = Date.parse(stored?.generatedAt ?? "");
  const tooSoon = Number.isFinite(lastGeneratedMs) && Date.now() - lastGeneratedMs < minIntervalS * 1000;
  const needsModel = opts.force || !stored || (meta.cardStamp !== stamp && !tooSoon);

  const seenAt = briefingSeenAt();
  const draft = composeBriefing(cards, {
    seenAt,
    summary: "",
    model: stored?.model ?? "local",
    resolved: readResolved(),
    taskStatus: taskStatusNow,
    budgetItem: budgetItemNow(),
    queueEscalations: escalationItemsNow(),
  });
  let summary = stored?.summary ?? "";
  let model = stored?.model ?? "local";
  let modelReason = meta.modelReason ?? "kept from the last generation (nothing changed since)";
  let regenerated = false;
  if (needsModel) {
    const out = await briefingSummary(cards, draft.counts, draft.needsYou.length, draft.counts.failed);
    summary = out.summary;
    model = out.model;
    modelReason = out.reason;
    regenerated = true;
  }
  if (!summary.trim()) summary = localSummary(cards, draft.needsYou.length);

  const briefing = composeBriefing(cards, {
    seenAt,
    summary,
    model,
    resolved: readResolved(),
    taskStatus: taskStatusNow,
    budgetItem: budgetItemNow(),
    queueEscalations: escalationItemsNow(),
  });
  // CEO APPROVAL POLICY (2026-09-30): hand this pass's routine retry/drop prompts to the
  // manager queue. They were deliberately kept OUT of briefing.needsYou above, so the
  // CEO's page and the chat never ask about them; the manager queue decides them, and
  // only a spent retry budget promotes one back into "needs you" (queueEscalations).
  const queued = persistRoutineRuns(briefing.managerQueue);
  if (queued.added || queued.reopened) {
    console.log(`[manager-queue] queued ${queued.added} routine prompt(s) (${queued.reopened} reopened); the CEO is not asked about these`);
  }
  writeJson(briefingFile(), briefing);
  writeJson(metaFile(), {
    ...meta,
    cardStamp: regenerated ? stamp : meta.cardStamp || stamp,
    modelReason,
    lastError: checked.errors.length ? checked.errors.slice(0, 3).join("; ") : undefined,
  });
  const posted = await maybePostSlack(briefing);
  return { briefing, checked, regenerated, posted };
}

// ── Slack (one short message, rate limited) ──────────────────────────────────

function slackText(b: Briefing): string {
  const lines: string[] = [
    `:office: Company brief - ${b.counts.running} running, ${b.counts.done} finished, ${b.counts.failed} failed, ${b.counts.stuck} stuck`,
    b.summary,
  ];
  if (b.needsYou.length) {
    lines.push(":rotating_light: Needs you:");
    for (const n of b.needsYou.slice(0, 3)) lines.push(`  - ${clip(n.text, 160)}`);
  }
  if (b.done.length) {
    lines.push(":white_check_mark: Done:");
    for (const d of b.done.slice(0, 4)) lines.push(`  - ${clip(d.text, 160)}`);
  }
  if (b.inProgress.length) {
    lines.push(":hourglass_flowing_sand: Still going:");
    for (const p of b.inProgress.slice(0, 3)) lines.push(`  - ${clip(p.text, 160)} (${clip(p.owner, 60)})`);
  }
  return lines.join("\n").slice(0, SLACK_MAX_CHARS);
}

/**
 * Post ONE briefing message when something new matters: a run finished, failed, got
 * stuck, or a new "needs you" item. Rate limited to BRIEFING_SLACK_MIN_INTERVAL_S
 * (600s) unless there is a NEW needs-you item. Never throws (postAs is total).
 */
async function maybePostSlack(b: Briefing): Promise<{ posted: boolean; error?: string }> {
  if (!envFlag("BRIEFING_SLACK", true)) return { posted: false, error: "BRIEFING_SLACK=0" };
  const meta = readJson<BriefingMeta>(metaFile()) ?? { cardStamp: "" };
  const prev = meta.slackSeen ?? { done: [], failed: [], stuck: [], needsYou: [] };
  const nowDone = b.done.map((d) => d.runId ?? d.text);
  const nowProblems = b.problems.map((p) => p.runId ?? p.text);
  const needsYouKeys = b.needsYou.map((n) => `${n.runId ?? ""}:${n.text}`);
  const freshNeedsYou = needsYouKeys.filter((k) => !prev.needsYou.includes(k));
  const freshDone = nowDone.filter((k) => !prev.done.includes(k));
  const freshProblems = nowProblems.filter((k) => !prev.failed.includes(k));
  const matters = freshNeedsYou.length > 0 || freshDone.length > 0 || freshProblems.length > 0 || b.counts.stuck > prev.stuck.length;
  const minIntervalS = envNum("BRIEFING_SLACK_MIN_INTERVAL_S", 600, 0);
  const lastSlackMs = Date.parse(meta.lastSlackAt ?? "");
  const tooSoon = Number.isFinite(lastSlackMs) && Date.now() - lastSlackMs < minIntervalS * 1000;
  if (!matters) return { posted: false, error: "nothing new to report" };
  if (tooSoon && freshNeedsYou.length === 0) return { posted: false, error: `rate limited (${minIntervalS}s between posts)` };
  const res = await postAs("ASSISTANT_CHIEF", slackText(b));
  writeJson(metaFile(), {
    ...meta,
    lastSlackAt: res.posted ? nowIso() : meta.lastSlackAt,
    lastSlackSummary: clip(b.summary, 200),
    slackSeen: {
      done: [...new Set([...prev.done, ...nowDone])].slice(-200),
      failed: [...new Set([...prev.failed, ...nowProblems])].slice(-200),
      stuck: [...new Set([...prev.stuck, ...nowProblems])].slice(-200),
      needsYou: [...new Set([...prev.needsYou, ...needsYouKeys])].slice(-200),
    },
  });
  console.log(`[briefing] slack post ${res.posted ? `ok ts=${res.ts}` : `skipped/err=${res.error}`} (${b.counts.running} running, ${b.counts.failed} failed, ${b.needsYou.length} need CEO)`);
  return { posted: res.posted, ...(res.error ? { error: res.error } : {}) };
}

// ── the guarded watcher loop ─────────────────────────────────────────────────

let timer: NodeJS.Timeout | undefined;
let ticking = false;
let lastTickAt: string | undefined;
let lastTickSummary: string | undefined;
let lastError: string | undefined;

export function briefingIntervalMs(): number {
  return envNum("BRIEFING_WATCH_INTERVAL_MS", 30000, 5000);
}

/**
 * The briefing loop: manager-check the runs, refresh the page, and post one Slack
 * message when something changed. Fully guarded - it can never crash the router and
 * it refuses to overlap itself.
 */
export async function briefingTick(opts: { force?: boolean; maxChecks?: number } = {}): Promise<{ ok: boolean; regenerated: boolean; checked: CheckSummary; error?: string }> {
  if (ticking) {
    return { ok: false, regenerated: false, checked: { discovered: 0, inFlight: 0, checked: 0, changed: 0, skipped: 0, onPlaceholder: 0, claudeCalls: 0, models: [], errors: [], ms: 0 }, error: "a briefing tick is already running" };
  }
  ticking = true;
  try {
    const out = await refreshBriefing(opts);
    lastTickAt = nowIso();
    lastTickSummary = `${out.briefing.counts.running} running, ${out.briefing.counts.done} done, ${out.briefing.counts.failed} failed, ${out.briefing.counts.stuck} stuck | checked ${out.checked.checked} (changed ${out.checked.changed}, claude ${out.checked.claudeCalls})`;
    lastError = out.checked.errors.length ? out.checked.errors.slice(0, 3).join("; ") : undefined;
    if (out.checked.checked || out.regenerated || out.posted.posted || out.checked.errors.length) {
      console.log(`[briefing] tick: ${lastTickSummary}${out.regenerated ? " | summary regenerated" : ""}${out.posted.posted ? " | slack posted" : ""}`);
    }
    return { ok: true, regenerated: out.regenerated, checked: out.checked, ...(lastError ? { error: lastError } : {}) };
  } catch (e) {
    lastError = clip(e instanceof Error ? e.message : String(e), 200);
    console.error(`[briefing] tick failed (router continues): ${lastError}`);
    return { ok: false, regenerated: false, checked: { discovered: 0, inFlight: 0, checked: 0, changed: 0, skipped: 0, onPlaceholder: 0, claudeCalls: 0, models: [], errors: [lastError], ms: 0 }, error: lastError };
  } finally {
    ticking = false;
  }
}

/** Start the 30s briefing loop (unref'd so it never keeps the process alive). */
export function startBriefingWatcher(): { running: boolean; intervalMs: number; enabled: boolean } {
  const enabled = envFlag("BRIEFING_WATCH", true);
  const intervalMs = briefingIntervalMs();
  if (timer) return { running: true, intervalMs, enabled };
  if (!enabled) return { running: false, intervalMs, enabled: false };
  timer = setInterval(() => {
    void briefingTick().catch((e) => console.error(`[briefing] tick threw (router continues): ${String(e)}`));
  }, intervalMs);
  timer.unref?.();
  console.log(`[briefing] watcher every ${intervalMs}ms (unref'd; card checks are capped at ${Number(process.env.RUN_MANAGER_MAX_CHECKS_PER_TICK ?? 2)} per tick)`);
  // First pass shortly after boot so the CEO's page is real within seconds, not 30s.
  const kick = setTimeout(() => {
    void briefingTick().catch((e) => console.error(`[briefing] first tick failed (router continues): ${String(e)}`));
  }, 2500);
  kick.unref?.();
  return { running: true, intervalMs, enabled: true };
}

export function stopBriefingWatcher(): boolean {
  if (!timer) return false;
  clearInterval(timer);
  timer = undefined;
  return true;
}

export function briefingStatus(): {
  running: boolean;
  intervalMs: number;
  minIntervalS: number;
  slackIntervalS: number;
  seenAt: string;
  lastTickAt?: string;
  lastTickSummary?: string;
  lastError?: string;
  /** why the last generated summary used the model it used (Sonnet vs Opus, or local) */
  modelReason?: string;
  storedRuns: number;
  model: string;
  counts: Briefing["counts"];
} {
  const stored = readJson<Briefing>(briefingFile());
  const meta = readJson<BriefingMeta>(metaFile());
  return {
    running: !!timer,
    intervalMs: briefingIntervalMs(),
    minIntervalS: envNum("BRIEFING_MIN_INTERVAL_S", 300, 0),
    slackIntervalS: envNum("BRIEFING_SLACK_MIN_INTERVAL_S", 600, 0),
    seenAt: briefingSeenAt(),
    lastTickAt: lastTickAt ?? meta?.lastTickAt,
    lastTickSummary: lastTickSummary ?? meta?.lastTickSummary,
    lastError: lastError ?? meta?.lastError,
    modelReason: meta?.modelReason,
    storedRuns: stored ? stored.counts.running + stored.counts.done + stored.counts.failed + stored.counts.stuck : 0,
    model: stored?.model ?? "local",
    counts: stored?.counts ?? { running: 0, done: 0, failed: 0, stuck: 0 },
  };
}
