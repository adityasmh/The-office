/**
 * ops/needs-you-classify-test.ts - verify "needs you" classification
 * (src/company/briefing.ts, docs/NEEDS_YOU_SPEC.md sections 1-4).
 *
 * Run with: npx tsx ops/needs-you-classify-test.ts
 *
 * Safety: this script only imports briefing.ts and exercises its pure functions
 * with in-memory fake RunCards. It never reads the live company/ folder, never
 * calls a model, and never starts a server.
 */
import assert from "node:assert";
import type { RunCard } from "../src/company/runManagers.js";
import { classifyNeedsYou, budgetNeedsYouItem, composeBriefing, type BriefingItem } from "../src/company/briefing.js";

const cases: string[] = [];
function pass(name: string) {
  cases.push(name);
  console.log(`PASS ${name}`);
}

function actionIds(item: BriefingItem): string[] {
  return (item.actions ?? []).map((a) => a.id);
}

function hasParam(item: BriefingItem, actionId: string, key: string, value: string): boolean {
  const action = item.actions?.find((a) => a.id === actionId);
  return action?.params?.[key] === value;
}

// ---------------------------------------------------------------------------
// 1. QA README plan at pending_merge -> choice between alternatives
// ---------------------------------------------------------------------------
const qaReadmeCard: RunCard = {
  runId: "task:pmumhp51x:tmumi7iz3",
  kind: "task",
  title: "README comment plan",
  owner: "Claude (manager)",
  state: "waiting_for_ceo",
  headline: "The QA team wrote a plan to add a one-line comment at the top of the project's README.",
  done: [],
  remaining: ["Approve the plan or pick the alternative comment wording."],
  needsCeo: "Approve the recommended hidden comment (or choose the visible header) so a coder can make the edit.",
  model: "claude-sonnet-5-5",
  modelReason: "test",
  checkedAt: "2026-09-29T14:59:20.207Z",
  evidenceHash: "test",
  reported: true,
  updatedAt: "2026-09-29T14:15:30.981Z",
  ref: { kind: "task", projectId: "pmumhp51x", taskId: "tmumi7iz3" },
};

const qaItem = classifyNeedsYou(qaReadmeCard, "pending_merge");
assert.strictEqual(qaItem.kind, "choice", "qa readme kind");
assert.strictEqual(qaItem.id, "task:pmumhp51x:tmumi7iz3", "qa readme id");
assert.deepStrictEqual(actionIds(qaItem), ["approve", "approve_alt"], "qa readme actions");
assert.ok(hasParam(qaItem, "approve", "gate", "merge"), "qa readme approve gate");
assert.ok(hasParam(qaItem, "approve", "note", "hidden comment"), "qa readme approve note");
assert.ok(hasParam(qaItem, "approve_alt", "note", "visible header"), "qa readme alt note");
assert.ok(qaItem.text.includes("hidden comment") || qaItem.text.includes("README"), "qa readme text");
pass("qa-readme-plan-choice");

// ---------------------------------------------------------------------------
// 2. hello.txt at pending_intake -> approve (intake gate)
// ---------------------------------------------------------------------------
const helloCard: RunCard = {
  runId: "task:pmumhg71w:tmumhg72u",
  kind: "task",
  title: "create hello.txt",
  owner: "coder-1 (Engineering)",
  state: "waiting_for_ceo",
  headline: "The hello file task has not started; it has been waiting at the intake step for about 94 minutes.",
  done: [],
  remaining: ["Intake approval is still pending, so no work has started"],
  needsCeo: "Approve the intake step so coder-1 can create the file, or cancel the task if it is no longer needed.",
  model: "claude-sonnet-5-5",
  modelReason: "test",
  checkedAt: "2026-09-29T15:07:22.668Z",
  evidenceHash: "test",
  reported: false,
  updatedAt: "2026-09-29T13:33:08.593Z",
  ref: { kind: "task", projectId: "pmumhg71w", taskId: "tmumhg72u" },
};

const helloItem = classifyNeedsYou(helloCard, "pending_intake");
assert.strictEqual(helloItem.kind, "approve", "hello kind");
assert.deepStrictEqual(actionIds(helloItem), ["approve", "drop"], "hello actions");
assert.ok(hasParam(helloItem, "approve", "gate", "intake"), "hello approve gate");
assert.ok(hasParam(helloItem, "approve", "projectId", "pmumhg71w"), "hello projectId");
assert.ok(hasParam(helloItem, "approve", "taskId", "tmumhg72u"), "hello taskId");
pass("hello-intake-approve");

// ---------------------------------------------------------------------------
// 3. Claude-limit fleet cards -> external with 3 actions
// ---------------------------------------------------------------------------
const claudeLimitCard1: RunCard = {
  runId: "fleet:fomumvpd3d",
  kind: "fleet",
  title: "voice project",
  owner: "Claude (manager)",
  state: "failed",
  headline: "The voice project never started because planning failed and no tasks were created.",
  done: [],
  remaining: ["Claude hit its monthly spending limit and could not plan"],
  needsCeo: "Raise the Claude spending limit, or tell us to retry with Kimi only, then reissue the order.",
  model: "claude-opus-5-5",
  modelReason: "test",
  checkedAt: "2026-09-29T18:50:00.468Z",
  evidenceHash: "test",
  verdict: "FAIL",
  verdictReason: "the fleet review flagged a work order",
  verifiedAt: "2026-09-29T18:50:00.468Z",
  reported: false,
  updatedAt: "2026-09-29T16:17:49.259Z",
  ref: { kind: "fleet", orderId: "fomumvpd3d" },
};

const claudeItem1 = classifyNeedsYou(claudeLimitCard1);
assert.strictEqual(claudeItem1.kind, "external", "claude1 kind");
assert.strictEqual(claudeItem1.id, "fleet:fomumvpd3d", "claude1 id");
assert.deepStrictEqual(actionIds(claudeItem1), ["open_limit_page", "use_kimi", "raised_retry"], "claude1 actions");
const openLinkAction = claudeItem1.actions?.find((a) => a.id === "open_limit_page");
assert.strictEqual(openLinkAction?.url, "https://claude.ai/settings/usage", "claude1 link");
assert.ok(openLinkAction?.params?.url === "https://claude.ai/settings/usage", "claude1 link param");
assert.ok(hasParam(claudeItem1, "use_kimi", "orderId", "fomumvpd3d"), "claude1 use_kimi orderId");
assert.ok(hasParam(claudeItem1, "raised_retry", "orderId", "fomumvpd3d"), "claude1 raised_retry orderId");
pass("claude-limit-external-1");

const claudeLimitCard2: RunCard = {
  ...claudeLimitCard1,
  runId: "fleet:fomumvo4sg",
  headline: "The voice project never started because the planner could not produce any tasks.",
  needsCeo: "Claude hit its monthly spending limit. Raise the limit, or approve a retry using only Kimi.",
  updatedAt: "2026-09-29T16:15:39.877Z",
  ref: { kind: "fleet", orderId: "fomumvo4sg" },
};
const claudeItem2 = classifyNeedsYou(claudeLimitCard2);
assert.strictEqual(claudeItem2.kind, "external", "claude2 kind");
assert.deepStrictEqual(actionIds(claudeItem2), ["open_limit_page", "use_kimi", "raised_retry"], "claude2 actions");
pass("claude-limit-external-2");

// ---------------------------------------------------------------------------
// 4. Kimi key fleet card -> provide with secret input
// ---------------------------------------------------------------------------
const kimiKeyCard: RunCard = {
  runId: "fleet:fomumvmg57",
  kind: "fleet",
  title: "voice project",
  owner: "Claude (manager)",
  state: "failed",
  headline: "The voice project never started because the planning assistant's access key is missing.",
  done: [],
  remaining: ["No plan or work orders were created, so nothing was cloned or built"],
  needsCeo: "Add the missing access key for the Kimi assistant, then resend the voice order.",
  model: "claude-opus-5-5",
  modelReason: "test",
  checkedAt: "2026-09-29T18:50:30.485Z",
  evidenceHash: "test",
  verdict: "FAIL",
  verdictReason: "the fleet review flagged a work order",
  verifiedAt: "2026-09-29T18:50:30.485Z",
  reported: false,
  updatedAt: "2026-09-29T16:14:28.007Z",
  ref: { kind: "fleet", orderId: "fomumvmg57" },
};

const kimiItem = classifyNeedsYou(kimiKeyCard);
assert.strictEqual(kimiItem.kind, "provide", "kimi kind");
assert.deepStrictEqual(actionIds(kimiItem), ["save_key_retry", "drop"], "kimi actions");
assert.strictEqual(kimiItem.input?.name, "OPENCODE_API_KEY", "kimi input name");
assert.strictEqual(kimiItem.input?.secret, true, "kimi input secret");
assert.ok(kimiItem.input?.label.includes("Kimi access key"), "kimi input label");
assert.ok(hasParam(kimiItem, "save_key_retry", "envName", "OPENCODE_API_KEY"), "kimi envName");
assert.ok(hasParam(kimiItem, "save_key_retry", "orderId", "fomumvmg57"), "kimi orderId");
pass("kimi-key-provide");

// ---------------------------------------------------------------------------
// 5. Failed tracking task -> choice retry/drop
// ---------------------------------------------------------------------------
const failedTaskCard: RunCard = {
  runId: "task:pmumhp51r:tmumjkfgo",
  kind: "task",
  title: "logging smoke test",
  owner: "coder-1 (Engineering)",
  state: "failed",
  headline: "Logging the smoke test as a tracked-only task failed twice before any work began.",
  done: [],
  remaining: ["The AI service that prepares the brief could not be reached"],
  model: "claude-opus-5-5",
  modelReason: "test",
  checkedAt: "2026-09-29T18:00:00.000Z",
  evidenceHash: "test",
  verdict: "FAIL",
  reported: false,
  updatedAt: "2026-09-29T17:00:00.000Z",
  ref: { kind: "task", projectId: "pmumhp51r", taskId: "tmumjkfgo" },
};

const failedItem = classifyNeedsYou(failedTaskCard);
assert.strictEqual(failedItem.kind, "choice", "failed task kind");
assert.strictEqual(failedItem.question, "Retry this task or drop it?", "failed task question");
assert.deepStrictEqual(actionIds(failedItem), ["retry", "drop"], "failed task actions");
assert.ok(hasParam(failedItem, "retry", "projectId", "pmumhp51r"), "failed task retry projectId");
assert.ok(hasParam(failedItem, "retry", "taskId", "tmumjkfgo"), "failed task retry taskId");
pass("failed-task-choice");

// ---------------------------------------------------------------------------
// 6. Budget items
// ---------------------------------------------------------------------------
const claudeBudget = budgetNeedsYouItem({ text: "Claude is nearly out (5% left) - work is being restricted.", provider: "claude", level: "red" });
assert.ok(claudeBudget, "claude budget exists");
assert.strictEqual(claudeBudget?.id, "budget:claude", "claude budget id");
assert.strictEqual(claudeBudget?.kind, "external", "claude budget kind");
assert.deepStrictEqual(actionIds(claudeBudget!), ["open_limit_page", "use_kimi", "raised_retry"], "claude budget actions");
const claudeBudgetLink = claudeBudget?.actions?.find((a) => a.id === "open_limit_page");
assert.strictEqual(claudeBudgetLink?.url, "https://claude.ai/settings/usage", "claude budget link");
assert.ok(claudeBudgetLink?.params?.url === "https://claude.ai/settings/usage", "claude budget link param");
assert.ok(claudeBudget?.actions?.find((a) => a.id === "use_kimi")?.params === undefined, "claude budget use_kimi has no orderId");
pass("budget-claude-external");

const goBudget = budgetNeedsYouItem({ text: "OpenCode Go is nearly out (3% left) - work is restricted.", provider: "go", level: "red" });
assert.ok(goBudget, "go budget exists");
assert.strictEqual(goBudget?.id, "budget:go", "go budget id");
assert.strictEqual(goBudget?.kind, "external", "go budget kind");
assert.deepStrictEqual(actionIds(goBudget!), ["open_limit_page", "raised_retry"], "go budget actions");
const goBudgetLink = goBudget?.actions?.find((a) => a.id === "open_limit_page");
assert.strictEqual(goBudgetLink?.url, "https://opencode.ai", "go budget link");
pass("budget-go-external");

assert.strictEqual(budgetNeedsYouItem(null), null, "null budget -> null");
assert.strictEqual(budgetNeedsYouItem(undefined), null, "undefined budget -> null");
pass("budget-null");

// ---------------------------------------------------------------------------
// 7. composeBriefing uses classification, respects resolved list
// ---------------------------------------------------------------------------
const seenAt = "2026-09-29T12:00:00.000Z";
const briefing = composeBriefing([qaReadmeCard, helloCard, claudeLimitCard1, claudeLimitCard2, kimiKeyCard], {
  seenAt,
  summary: "test summary",
  model: "local",
});
assert.ok(briefing.needsYou.every((n) => n.id && n.kind && (n.actions ?? []).length > 0), "every needsYou item has id, kind, actions");
assert.strictEqual(briefing.needsYou.length, 5, "composeBriefing returns classified items");
pass("composeBriefing-classifies");

// ---------------------------------------------------------------------------
// 8. resolved-list hiding and card-updated-after-resolve reappears
// ---------------------------------------------------------------------------
const resolvedAt = "2026-09-29T16:18:00.000Z"; // after claudeLimitCard1.updatedAt
const resolvedBriefing = composeBriefing([claudeLimitCard1], {
  seenAt,
  summary: "test",
  model: "local",
  resolved: { "fleet:fomumvpd3d": { at: resolvedAt } },
});
assert.strictEqual(resolvedBriefing.needsYou.length, 0, "resolved item hidden");
pass("resolved-hides-item");

const staleResolvedAt = "2026-09-29T16:17:00.000Z"; // before claudeLimitCard1.updatedAt
const reappearedBriefing = composeBriefing([claudeLimitCard1], {
  seenAt,
  summary: "test",
  model: "local",
  resolved: { "fleet:fomumvpd3d": { at: staleResolvedAt } },
});
assert.strictEqual(reappearedBriefing.needsYou.length, 1, "card updated after resolve reappears");
assert.strictEqual(reappearedBriefing.needsYou[0]?.id, "fleet:fomumvpd3d", "reappeared item id");
pass("updated-card-reappears");

// ---------------------------------------------------------------------------
// 9. budget item placed first (within NEEDS_MAX)
// ---------------------------------------------------------------------------
const withBudget = composeBriefing([qaReadmeCard, helloCard, claudeLimitCard1, claudeLimitCard2, kimiKeyCard], {
  seenAt,
  summary: "test",
  model: "local",
  budgetItem: claudeBudget,
});
assert.strictEqual(withBudget.needsYou[0]?.id, "budget:claude", "budget item is first");
pass("budget-first");

// ---------------------------------------------------------------------------
// 10. empty/null budget item does not break composition
// ---------------------------------------------------------------------------
const noBudget = composeBriefing([qaReadmeCard], {
  seenAt,
  summary: "test",
  model: "local",
  budgetItem: null,
});
assert.strictEqual(noBudget.needsYou.length, 1, "null budget does not break");
pass("null-budget-safe");

console.log(`\nAll ${cases.length} cases passed.`);
