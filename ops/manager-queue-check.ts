/**
 * ops/manager-queue-check.ts - prove the CEO APPROVAL POLICY work (2026-09-30).
 *
 * Run with: npx tsx ops/manager-queue-check.ts
 *
 * What it proves:
 *  A. the risk classifier (needsYouRule.classifyApprovalRisk) routes routine retry/drop
 *     prompts to the manager and keeps every item on the CEO's risk list in "needs you";
 *  B. composeBriefing drops routine prompts out of needsYou and hands them over as
 *     briefing.managerQueue, while a gate approval and a key/spend prompt still show;
 *  C. the manager queue file, the retry cap (max 2), the ONE escalation per entry, and
 *     closing an entry when the CEO answers or when the run stops failing;
 *  D. the router is wired (static check of src/server.ts: routes + watcher).
 *
 * Safety: COMPANY_ROOT is pointed at a throwaway temp directory BEFORE any module is
 * imported, so the live company/ is never read or written. MOCK_MODE=1 is set, and the
 * automatic retries are injected stubs: this script never calls a model, never spawns a
 * session and never starts a server.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mq-check-"));
process.env.COMPANY_ROOT = tmpRoot;
process.env.MOCK_MODE = "1";
process.env.MANAGER_QUEUE_MAX_RETRIES = "2";
process.env.MANAGER_QUEUE_STALE_HOURS = "6";
delete process.env.MANAGER_QUEUE_ESCALATE_MINUTES;
delete process.env.MANAGER_QUEUE;

// Imported AFTER COMPANY_ROOT is set: org.ts reads it at import time.
const { classifyApprovalRisk, CEO_RISK_RULES, isStaleFailure } = await import("../src/company/needsYouRule.js");
const { readManagerQueue, writeManagerQueue, updateQueueEntry, enqueueRoutineRuns, queueEscalations, managerQueueFile, escalationIdFor, managerQueueSummary, normalizeQueueState } = await import(
  "../src/company/managerQueue.js"
);
const { classifyNeedsYou, composeBriefing, refreshBriefing } = await import("../src/company/briefing.js");
const { managerQueueTick, openNeedsYouItems, resolveNeedsYou } = await import("../src/company/needsYouActions.js");
const { askNeedsYouInChat, tryResolveFromChat } = await import("../src/company/assistant.js");
const { setPaused } = await import("../src/company/lifecycle.js");
type RunCard = import("../src/company/runManagers.js").RunCard;

const cases: string[] = [];
function pass(name: string) {
  cases.push(name);
  console.log(`PASS ${name}`);
}

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function fakeCard(over: Partial<RunCard> & Pick<RunCard, "runId" | "kind" | "state">): RunCard {
  return {
    title: "the voice project",
    owner: "Claude (manager)",
    headline: "The work stopped before it finished.",
    done: [],
    remaining: ["Decide what happens next"],
    model: "claude-sonnet-5-5",
    modelReason: "check",
    checkedAt: nowIso(),
    evidenceHash: "check",
    reported: false,
    updatedAt: nowIso(),
    ref: { kind: over.kind },
    ...over,
  } as RunCard;
}

// ---------------------------------------------------------------------------
// A. the risk classifier
// ---------------------------------------------------------------------------
assert.strictEqual(CEO_RISK_RULES.length, 7, "the CEO's risk list has 7 entries");
assert.deepStrictEqual(
  CEO_RISK_RULES.map((r) => r.name),
  ["delete_data", "money", "credentials", "message_people", "publish", "kill_apps", "live_system"],
  "the risk rules are the CEO's list, in order"
);
pass("risk-list-is-the-ceos-list");

// Each risk rule must actually catch a representative prompt.
const riskySamples: Array<[string, string]> = [
  ["delete_data", "Should we delete the company data now?"],
  ["money", "This run is blocked by the monthly spending limit. Raise it?"],
  ["credentials", "Add the missing access key for the Kimi assistant, then retry."],
  ["message_people", "Send an email to the client with the new price."],
  ["publish", "Run promote.ps1 to publish the update to the real site."],
  ["kill_apps", "Close the CEO's editor window to free memory."],
  ["live_system", "Restart the router to load the new code."],
];
for (const [ruleName, text] of riskySamples) {
  const out = classifyApprovalRisk({ text, actions: [{ id: "retry", label: "Retry", effect: "retry_order" }] });
  assert.strictEqual(out.risk, "risky", `"${text}" must stay with the CEO`);
  assert.strictEqual(out.rule, ruleName, `"${text}" must match the ${ruleName} rule`);
}
pass("every-risk-rule-fires");

// A plain retry/drop prompt for a failed order is routine (the manager's call).
const failedOrderItem = classifyNeedsYou(fakeCard({ runId: "fleet:foRETRY", kind: "fleet", state: "failed" }));
assert.strictEqual(failedOrderItem.kind, "choice", "failed fleet card is a choice");
assert.deepStrictEqual(
  (failedOrderItem.actions ?? []).map((a) => a.effect),
  ["retry_order", "drop_order"],
  "failed fleet card offers retry/drop"
);
const routineOrder = classifyApprovalRisk({
  kind: failedOrderItem.kind,
  text: failedOrderItem.text,
  question: failedOrderItem.question,
  reason: failedOrderItem.reason,
  actions: failedOrderItem.actions,
  runState: "failed",
  updatedAt: nowIso(),
});
assert.strictEqual(routineOrder.risk, "routine", "retry/drop of a failed order is routine");
assert.strictEqual(routineOrder.stale, false, "a fresh failure is not stale");
pass("routine-retry-drop-order");

const failedTaskItem = classifyNeedsYou(fakeCard({ runId: "task:pFIX:tRETRY", kind: "task", state: "failed", title: "add hello.txt" }));
assert.deepStrictEqual(
  (failedTaskItem.actions ?? []).map((a) => a.effect),
  ["retry_task", "drop_task"],
  "failed task card offers retry/drop"
);
const routineTask = classifyApprovalRisk({ ...failedTaskItem, runState: "failed", updatedAt: nowIso() });
assert.strictEqual(routineTask.risk, "routine", "retry/drop of a failed task is routine");
const staleTask = classifyApprovalRisk({ ...failedTaskItem, runState: "failed", updatedAt: nowIso(-10 * 3600_000) });
assert.strictEqual(staleTask.risk, "routine", "a stale failure is still routine (manager's call)");
assert.strictEqual(staleTask.stale, true, "a 10 hour old failure counts as stale");
assert.ok(/stale/i.test(staleTask.reason), "the reason says why it is routine (stale)");
pass("routine-retry-drop-task-and-stale");

// Gate approvals are the CEO's own gate and must keep showing.
const approveItem = classifyNeedsYou(
  fakeCard({
    runId: "task:pmumhp51x:tmumi7iz3",
    kind: "task",
    state: "waiting_for_ceo",
    title: "README comment plan",
    needsCeo: "Approve the recommended hidden comment (or choose the visible header).",
  })
);
assert.strictEqual(approveItem.kind, "choice", "the plan prompt is a choice");
const approveRisk = classifyApprovalRisk({ ...approveItem, runState: "waiting_for_ceo", updatedAt: nowIso() });
assert.strictEqual(approveRisk.risk, "risky", "a gate approval still needs the CEO");
pass("approval-stays-with-ceo");

// A key prompt and a spend prompt stay too, even though they read like a retry.
const keyCard = fakeCard({
  runId: "fleet:fomumvmg57",
  kind: "fleet",
  state: "failed",
  headline: "The planning assistant's access key is missing.",
  needsCeo: "Add the missing access key for the Kimi assistant, then resend the voice order.",
});
const keyRisk = classifyApprovalRisk({ ...classifyNeedsYou(keyCard), runState: "failed", updatedAt: nowIso() });
assert.strictEqual(keyRisk.risk, "risky", "a key/secret prompt stays with the CEO");
assert.strictEqual(keyRisk.rule, "credentials", "matched by the credentials rule");
pass("key-prompt-stays-with-ceo");

const spendCard = fakeCard({
  runId: "fleet:fomumvpd3d",
  kind: "fleet",
  state: "failed",
  headline: "The project never started because planning failed.",
  needsCeo: "Raise the Claude spending limit, or tell us to retry with Kimi only.",
});
const spendRisk = classifyApprovalRisk({ ...classifyNeedsYou(spendCard), runState: "failed", updatedAt: nowIso() });
assert.strictEqual(spendRisk.risk, "risky", "a spending/budget prompt stays with the CEO");
assert.strictEqual(spendRisk.rule, "money", "matched by the money rule");
pass("spend-prompt-stays-with-ceo");

// An unexplained prompt (no actions at all) is never hidden by accident.
const unknownRisk = classifyApprovalRisk({ text: "Something happened.", runState: "failed", updatedAt: nowIso() });
assert.strictEqual(unknownRisk.risk, "risky", "an unknown shape defaults to the CEO");
pass("unknown-shape-defaults-to-ceo");

// ---------------------------------------------------------------------------
// B. composition: routine goes to the manager queue, risky stays in needs you
// ---------------------------------------------------------------------------
const approveForCompose = fakeCard({
  runId: "task:pmumhp51x:tmumi7iz3",
  kind: "task",
  state: "waiting_for_ceo",
  title: "README comment plan",
  needsCeo: "Approve the recommended hidden comment (or choose the visible header).",
});
const failedOrderForCompose = fakeCard({ runId: "fleet:foRETRY", kind: "fleet", state: "failed", title: "the voice project" });
const failedTaskForCompose = fakeCard({ runId: "task:pFIX:tRETRY", kind: "task", state: "failed", title: "add hello.txt" });
const composed = composeBriefing([approveForCompose, failedOrderForCompose, failedTaskForCompose], {
  seenAt: new Date(0).toISOString(),
  summary: "check",
  model: "local",
});
assert.strictEqual(composed.needsYou.length, 1, "only the gate approval is left for the CEO");
assert.strictEqual(composed.needsYou[0]?.id, "task:pmumhp51x:tmumi7iz3", "the item left is the approval");
assert.ok(
  !composed.needsYou.some((n) => /retry .* drop/i.test(n.question ?? "")),
  "no routine retry/drop prompt is shown to the CEO"
);
const routed = composed.managerQueue ?? [];
assert.strictEqual(routed.length, 2, "both routine prompts were handed to the manager queue");
assert.ok(
  routed.some((r) => r.runId === "fleet:foRETRY") && routed.some((r) => r.runId === "task:pFIX:tRETRY"),
  "the handed-over runs are the failed order and the failed task"
);
pass("compose-routes-routine-out-of-needs-you");

// ---------------------------------------------------------------------------
// C. the queue file, the retry cap and the ONE escalation
// ---------------------------------------------------------------------------
assert.ok(
  managerQueueFile().startsWith(tmpRoot) && managerQueueFile().endsWith(path.join("reports", "manager-queue.json")),
  `the queue lives at <company>/reports/manager-queue.json (got ${managerQueueFile()})`
);
// Merely loading these modules must not create the file: nothing is written until something is
// really queued, so the live tree cannot be touched by a router that has nothing to route.
assert.strictEqual(fs.existsSync(managerQueueFile()), false, "no queue file exists before anything is queued");
pass("queue-file-path-and-no-eager-write");

// Real fixtures on disk, in the throwaway root: a failed order a retry can fix, a failed
// order that needs a person, a stale failed order, and a failed task.
const ordersFile = path.join(tmpRoot, "fleet", "orders.json");
const tasksFile = path.join(tmpRoot, "projects", "pFIX", "tasks.json");
fs.mkdirSync(path.dirname(ordersFile), { recursive: true });
fs.mkdirSync(path.dirname(tasksFile), { recursive: true });
const failedOrder = (id: string, error: string, updatedAt = nowIso()) => ({
  id,
  text: `work order ${id}`,
  createdAt: updatedAt,
  updatedAt,
  status: "failed",
  workOrders: [],
  trace: [],
  error,
  retryCount: 0,
});
fs.writeFileSync(
  ordersFile,
  JSON.stringify(
    [
      failedOrder("foRETRY", "planning failed: Error: glm-5.3-flash request failed after 180s: TypeError: fetch failed"),
      failedOrder("foSTUCK", "the planner produced no usable work orders"),
      failedOrder("foSTALE", "the planner produced no usable work orders", nowIso(-10 * 3600_000)),
    ],
    null,
    2
  )
);
fs.writeFileSync(
  tasksFile,
  JSON.stringify(
    [
      {
        id: "tRETRY",
        projectId: "pFIX",
        rawRequest: "add hello.txt",
        status: "failed",
        error: "enhancer failed: Error: glm-5.3-flash request failed after 180s: TypeError: fetch failed",
        gates: { intake: true, code: true, merge: false },
        createdAt: nowIso(),
        updatedAt: nowIso(),
        loopCount: 0,
      },
    ],
    null,
    2
  )
);

const queued = enqueueRoutineRuns([
  { runId: "fleet:foRETRY", title: "the voice project", text: "The project never started. Retry this order or drop it?", state: "failed", updatedAt: nowIso() },
  { runId: "fleet:foSTUCK", title: "the stuck project", text: "The project never started. Retry this order or drop it?", state: "failed", updatedAt: nowIso() },
  { runId: "fleet:foSTALE", title: "the old project", text: "The project never started. Retry this order or drop it?", state: "failed", updatedAt: nowIso(-10 * 3600_000) },
  { runId: "task:pFIX:tRETRY", title: "add hello.txt", text: "The task failed. Retry this task or drop it?", state: "failed", updatedAt: nowIso() },
]);
assert.strictEqual(queued.added, 4, "four routine prompts were queued");
assert.strictEqual(readManagerQueue().length, 4, "the queue file holds four entries");
assert.ok(
  readManagerQueue().every((e) => e.attempts === 0 && e.state === "pending"),
  "every entry starts pending with no retries spent"
);
const queuedAgain = enqueueRoutineRuns([
  { runId: "fleet:foRETRY", title: "the voice project", text: "The project never started. Retry this order or drop it?", state: "failed", updatedAt: nowIso() },
]);
assert.strictEqual(queuedAgain.added, 0, "queueing the same job twice does not duplicate it");
assert.strictEqual(readManagerQueue().length, 4, "the queue still holds four entries");
pass("queue-file-and-idempotence");

// The tick. Retries are injected stubs: the real ones (executeEffect retry_order /
// retry_task) spawn work, and this check must not spawn anything.
const retriedOrders: string[] = [];
const retriedTasks: string[] = [];
const deps = {
  retryOrder: async (orderId: string) => {
    retriedOrders.push(orderId);
    return `Order reissued as foNEW${retriedOrders.length}.`;
  },
  retryTask: async (projectId: string, taskId: string) => {
    retriedTasks.push(`${projectId}:${taskId}`);
    return "Task queued for retry.";
  },
};

const tick1 = await managerQueueTick(deps);
assert.deepStrictEqual(tick1.retried.sort(), ["fleet:foRETRY", "task:pFIX:tRETRY"], "tick 1 retried the two transient failures");
assert.deepStrictEqual(tick1.escalated, ["fleet:foSTALE"], "tick 1 escalated the stale failure");
assert.strictEqual(retriedOrders.length, 1, "exactly one automatic order retry");
assert.strictEqual(retriedTasks.length, 1, "exactly one automatic task retry");
const afterTick1 = () => new Map(readManagerQueue().map((e) => [e.id, e]));
assert.strictEqual(afterTick1().get("fleet:foRETRY")!.attempts, 1, "the order retry was counted");
assert.strictEqual(afterTick1().get("fleet:foRETRY")!.state, "auto_retried", "the order entry is marked auto_retried");
assert.strictEqual(afterTick1().get("fleet:foSTUCK")!.state, "pending", "the entry that needs a person keeps waiting");
assert.ok(/needs a person|waiting/i.test(afterTick1().get("fleet:foSTUCK")!.decision ?? ""), "and says so");
pass("tick1-retry-escalate-keep");

const tick2 = await managerQueueTick(deps);
assert.deepStrictEqual(tick2.retried.sort(), ["fleet:foRETRY", "task:pFIX:tRETRY"], "tick 2 spent the second retry");
assert.strictEqual(afterTick1().get("task:pFIX:tRETRY")!.attempts, 2, "the task retry was counted twice");
assert.deepStrictEqual(tick2.escalated, [], "nothing escalated before the cap was reached");
pass("tick2-second-retry");

const tick3 = await managerQueueTick(deps);
assert.deepStrictEqual(tick3.retried, [], "tick 3 spends no third retry (the cap is 2)");
assert.deepStrictEqual(tick3.escalated.sort(), ["fleet:foRETRY", "task:pFIX:tRETRY"], "tick 3 escalated both capped entries");
assert.strictEqual(retriedOrders.length, 2, "the order was retried exactly twice");
assert.strictEqual(retriedTasks.length, 2, "the task was retried exactly twice");
pass("cap-at-two-then-escalate");

const tick4 = await managerQueueTick(deps);
assert.deepStrictEqual(tick4.retried, [], "tick 4 does not retry an escalated entry");
assert.deepStrictEqual(tick4.escalated, [], "tick 4 does not escalate a second time");
assert.strictEqual(tick4.kept, 4, "tick 4 leaves all four entries alone (3 escalated, 1 still waiting)");
assert.strictEqual(afterTick1().get("fleet:foRETRY")!.attempts, 2, "and spends no further retry");
pass("no-repeat-escalation");

// ONE prompt per escalated entry, with real actions.
const escalations = queueEscalations();
assert.strictEqual(escalations.length, 3, "three entries are escalated and each raises exactly one prompt");
assert.ok(escalations.every((e) => e.id.startsWith("mq:")), "every escalation has a stable mq: id");
const escOrder = escalations.find((e) => e.runId === "fleet:foRETRY");
const escTask = escalations.find((e) => e.runId === "task:pFIX:tRETRY");
assert.ok(escOrder && escOrder.actions.some((a) => a.effect === "retry_order" && a.params.orderId === "foRETRY"), "the order escalation offers a real retry");
assert.ok(escOrder && escOrder.actions.some((a) => a.effect === "drop_order"), "the order escalation offers a drop");
assert.ok(escTask && escTask.actions.some((a) => a.effect === "retry_task" && a.params.taskId === "tRETRY"), "the task escalation offers a real retry");
assert.ok(/retried this 2 time/i.test(escTask.question), "the prompt says how many retries were spent");
pass("one-escalation-prompt-per-entry");

// The escalated prompt reaches the CEO exactly once, and only for a spent budget.
const escComposed = composeBriefing([failedOrderForCompose, approveForCompose], {
  seenAt: new Date(0).toISOString(),
  summary: "check",
  model: "local",
  queueEscalations: escalations,
});
const escIds = escComposed.needsYou.map((n) => n.id);
assert.ok(escIds.includes(escOrder!.id), "the escalated entry shows in the CEO's list");
assert.strictEqual(escIds.filter((id) => id === escOrder!.id).length, 1, "and shows exactly once");
pass("escalation-shows-once-in-needs-you");

// The CEO answers: the entry closes and the prompt stops.
const resolvedMap: Record<string, { at: string; actionId: string }> = {};
resolvedMap[escOrder!.id] = { at: nowIso(), actionId: "drop" };
fs.writeFileSync(path.join(tmpRoot, "reports", "needs-you-resolved.json"), JSON.stringify(resolvedMap, null, 2));
const tick5 = await managerQueueTick(deps);
assert.ok(tick5.resolved.includes("fleet:foRETRY"), "tick 5 closed the entry the CEO answered");
assert.strictEqual(afterTick1().get("fleet:foRETRY")!.state, "resolved", "the entry is resolved for good");
assert.strictEqual(queueEscalations().length, 2, "and its prompt is gone (no second question)");
const tick6 = await managerQueueTick(deps);
assert.deepStrictEqual(tick6.escalated, [], "the closed entry never comes back");
assert.strictEqual(queueEscalations().length, 2, "still no new prompt");
pass("ceo-answer-closes-the-entry");

// The ONE escalated prompt must be ANSWERABLE, not just visible: the item the queue raises has to
// be findable by the REAL resolver (openNeedsYouItems -> getBriefing + the queue's escalations),
// and the CEO's answer has to act on the order. The hand-written ledger above proves the other
// half (an answered prompt stops being asked); this proves the click itself works.
const staleEscalation = escalations.find((e) => e.runId === "fleet:foSTALE")!;
const liveItem = openNeedsYouItems().find((n) => n.id === staleEscalation.id);
assert.ok(liveItem, "the escalated prompt is in the live briefing the resolver reads");
assert.strictEqual(liveItem!.kind, "choice", "it is a choice, like the CEO's other decisions");
assert.ok((liveItem!.actions ?? []).some((a) => a.effect === "drop_order"), "and it can be answered");
assert.ok((liveItem!.actions ?? []).every((a) => (a.effect === "drop_order" || a.effect === "retry_order")), "with only retry/drop actions");
const dropRes = await resolveNeedsYou(staleEscalation.id, "drop", undefined, "ceo");
assert.strictEqual(dropRes.ok, true, `the CEO's answer went through (${dropRes.message})`);
const afterDropTick = await managerQueueTick();
assert.ok(afterDropTick.resolved.includes("fleet:foSTALE"), "and the queue closed that entry for good");
assert.strictEqual(readManagerQueue().find((e) => e.id === "fleet:foSTALE")?.state, "resolved", "its state is resolved");
assert.ok(!queueEscalations().some((e) => e.runId === "fleet:foSTALE"), "so the prompt is gone and is never asked twice");
pass("escalation-answered-through-the-resolver");

// ONE entry per live ORDER, even when the job key changes (a different failure cause for the same
// order must not buy a second retry budget or a second prompt).
const stuckEntriesBefore = readManagerQueue().filter((e) => e.orderId === "foSTUCK").length;
assert.strictEqual(stuckEntriesBefore, 1, "the stuck order has exactly one entry to begin with");
enqueueRoutineRuns([
  {
    runId: "fleet:foSTUCK",
    title: "the stuck project",
    text: "Retry this order or drop it?",
    state: "failed",
    updatedAt: nowIso(),
    failureCause: "session-limit",
    itemId: "fleet:job:another-cause-entirely",
  },
]);
assert.strictEqual(readManagerQueue().filter((e) => e.orderId === "foSTUCK").length, 1, "a second job key for the same order creates no second entry");
pass("one-entry-per-live-order");

// A DANGLING escalation: the order behind the prompt was removed before the CEO clicked. The
// resolver must answer with a plain message instead of throwing, and the queue must keep working -
// the CEO is never left with a prompt that cannot be answered and never gets a crash screen.
writeManagerQueue([
  ...readManagerQueue(),
  {
    id: "fleet:foGONE",
    at: nowIso(),
    updatedAt: nowIso(),
    kind: "fleet",
    text: "an order that no longer exists",
    orderId: "foGONE",
    runId: "fleet:foGONE",
    state: "escalated",
    attempts: 2,
    stale: true,
    escalationId: escalationIdFor("fleet:foGONE", "fleet:foGONE"),
    decision: "2 of 2 automatic retries spent",
  },
]);
const goneItem = openNeedsYouItems().find((n) => n.id === escalationIdFor("fleet:foGONE", "fleet:foGONE"));
assert.ok(goneItem, "a dangling escalation is still shown, not silently dropped");
const goneRes = await resolveNeedsYou(goneItem!.id, "retry", undefined, "ceo");
assert.strictEqual(typeof goneRes.ok, "boolean", "answering it returns a result instead of throwing");
assert.strictEqual(goneRes.ok, false, "and it honestly reports that the order could not be reissued");
assert.ok(typeof goneRes.message === "string" && goneRes.message.length > 0, "with a plain-words message");
assert.ok(openNeedsYouItems().some((n) => n.id === goneItem!.id), "the prompt stays open so the CEO can still decide");
const afterGoneTick = await managerQueueTick();
assert.strictEqual(afterGoneTick.ok, true, "and the queue still ticks afterwards");
pass("dangling-escalation-answers-cleanly");

// The CEO's OTHER answer on an escalated prompt: "Retry it anyway" when the job already spent its
// retries. The resolver must say so in plain words, resolve the item, and the queue must close it -
// no silent no-op, and no second prompt.
const ordersTextBeforeCapped = fs.readFileSync(ordersFile, "utf8");
const queueTextBeforeCapped = fs.readFileSync(managerQueueFile(), "utf8");
fs.writeFileSync(
  ordersFile,
  JSON.stringify(
    [
      {
        ...failedOrder("foCAPPED", "planning failed: Error: fetch failed"),
        retryCount: 2,
      },
    ],
    null,
    2,
  ),
);
writeManagerQueue([]);
enqueueRoutineRuns([
  { runId: "fleet:foCAPPED", title: "the capped job", text: "Retry this order or drop it?", state: "failed", updatedAt: nowIso() },
]);
const cappedTick = await managerQueueTick();
assert.ok(cappedTick.escalated.includes("fleet:foCAPPED"), "a job at the retry cap escalates instead of retrying again");
const capPrompts = queueEscalations();
assert.strictEqual(capPrompts.length, 1, "and it raises exactly one prompt");
const capRes = await resolveNeedsYou(capPrompts[0]!.id, "retry", undefined, "ceo");
assert.strictEqual(capRes.ok, true, "the CEO's \"retry anyway\" is accepted");
assert.ok(
  /already been retried 2 times/i.test(capRes.message),
  `and answered in plain words (${capRes.message})`,
);
const capAfter = await managerQueueTick();
assert.ok(capAfter.resolved.includes("fleet:foCAPPED"), "the queue closes the entry once it was decided");
assert.strictEqual(queueEscalations().length, 0, "and the prompt does not come back");
fs.writeFileSync(ordersFile, ordersTextBeforeCapped); // put the other fixtures back for the next cases
fs.writeFileSync(managerQueueFile(), queueTextBeforeCapped);
pass("retry-at-the-cap-answered-plainly");

// A run that stopped failing is closed silently.
const orders2 = JSON.parse(fs.readFileSync(ordersFile, "utf8")) as Array<{ id: string; status: string }>;
const stuck = orders2.find((o) => o.id === "foSTUCK")!;
stuck.status = "running";
fs.writeFileSync(ordersFile, JSON.stringify(orders2, null, 2));
const tick7 = await managerQueueTick(deps);
assert.ok(tick7.resolved.includes("fleet:foSTUCK"), "an order that is no longer failing is closed silently");
assert.strictEqual(afterTick1().get("fleet:foSTUCK")!.state, "resolved", "its entry is resolved");
pass("recovered-run-closes-silently");

// The cap must also respect the fleet's own retry depth (copies of one job).
const depthCapped = readManagerQueue().length;
assert.ok(depthCapped >= 0, "queue readable");
const { decideQueueAction } = await import("../src/company/managerQueue.js");
const byDepth = decideQueueAction({ state: "pending", attempts: 0, runStillFailed: true, retryDepth: 2 });
assert.strictEqual(byDepth.action, "escalate", "a job already retried twice by the fleet escalates instead of retrying");
const byCause = decideQueueAction({ state: "pending", attempts: 0, runStillFailed: true, failureCause: "missing-key" });
assert.strictEqual(byCause.action, "keep", "a cause that needs a person is not auto-retried while it is fresh");
const byStale = decideQueueAction({ state: "pending", attempts: 0, runStillFailed: true, failureCause: "missing-key", stale: true });
assert.strictEqual(byStale.action, "escalate", "a stale failure that needs a person escalates");
pass("decision-bounds");

// The default (real) retry binding is only used when a cause is auto-retryable. Point the
// queue at a FAILED order whose cause needs a person, call the tick with NO injected deps,
// and prove nothing was retried or spawned.
const orders3 = JSON.parse(fs.readFileSync(ordersFile, "utf8")) as Array<{ id: string; status: string; updatedAt: string }>;
const stuckAgain = orders3.find((o) => o.id === "foSTUCK")!;
stuckAgain.status = "failed";
stuckAgain.updatedAt = nowIso();
fs.writeFileSync(ordersFile, JSON.stringify(orders3, null, 2));
fs.writeFileSync(path.join(tmpRoot, "reports", "manager-queue.json"), JSON.stringify({ updatedAt: nowIso(), items: [] }));
enqueueRoutineRuns([
  { runId: "fleet:foSTUCK", title: "the stuck project", text: "Retry this order or drop it?", state: "failed", updatedAt: nowIso() },
]);
const tickDefault = await managerQueueTick();
assert.deepStrictEqual(tickDefault.retried, [], "the real tick does not retry a cause that needs a person");
assert.strictEqual(tickDefault.kept, 1, "it keeps the entry for the manager instead");
pass("real-tick-binds-defaults-and-spawns-nothing");

// ---------------------------------------------------------------------------
// D. the router is wired (static check: no server is started here)
// ---------------------------------------------------------------------------
const serverSrc = fs.readFileSync(path.join(process.cwd(), "src", "server.ts"), "utf8");
assert.ok(serverSrc.includes('app.get("/api/manager-queue"'), "GET /api/manager-queue is registered");
assert.ok(serverSrc.includes('app.post("/api/manager-queue/tick"'), "POST /api/manager-queue/tick is registered");
assert.ok(serverSrc.includes("startManagerQueueWatcher()"), "the manager-queue watcher is started at boot");
assert.ok(serverSrc.includes('app.get("/api/needs-you"'), "the needs-you routes are untouched");
assert.ok(/app\.use\("\/api", companyGuard\)/.test(serverSrc), "the /api routes are still behind the token guard");
pass("router-wired-static-check");

// The escalation id is stable for the SAME copy of a job (so a restart cannot rename the prompt)
// and deliberately different for a NEWER copy (so a decision on one copy cannot silence the next).
assert.strictEqual(escalationIdFor("fleet:foRETRY", "fleet:foRETRY"), escalationIdFor("fleet:foRETRY", "fleet:foRETRY"), "escalation ids are stable for one copy");
assert.notStrictEqual(escalationIdFor("fleet:foRETRY", "fleet:foRETRY"), escalationIdFor("fleet:foRETRY", "fleet:foCOPY2"), "a newer copy of the same job gets a fresh prompt id");
assert.notStrictEqual(escalationIdFor("fleet:foRETRY", "fleet:foRETRY"), escalationIdFor("fleet:foOTHER", "fleet:foOTHER"), "different entries get different ids");
pass("escalation-id-stable");

// A hostile queue file (corrupt, wrong shape, missing fields, string numbers) must never throw:
// the queue is read on every briefing refresh and every tick, so a bad file may cost a decision
// but must never take the router down.
const queuePathForJunk = managerQueueFile();
const goodQueueText = fs.readFileSync(queuePathForJunk, "utf8");
const junkVariants = [
  "",
  "not json at all",
  "[]",
  '{"items":"nope"}',
  '{"items":[{"id":""},null,42]}',
  '{"items":[{"id":"x","kind":"unknown","state":"pending","text":"t","attempts":"3","stale":"yes"}]}',
  '{"items":[{"id":"y","kind":"fleet","state":"pending","text":"t","orderId":"gone","at":"not-a-date"}]}',
];
for (const junk of junkVariants) {
  fs.writeFileSync(queuePathForJunk, junk);
  const items = readManagerQueue();
  assert.ok(Array.isArray(items), `a hostile queue file still reads as a list (${JSON.stringify(junk.slice(0, 24))})`);
  const summary = managerQueueSummary();
  assert.strictEqual(typeof summary.total, "number", "and the summary still answers with a number");
  assert.strictEqual(typeof summary.maxRetries, "number", "and still reports the retry cap");
  const junkTick = await managerQueueTick();
  assert.strictEqual(junkTick.ok, true, "and the tick survives it");
  assert.ok(queueEscalations().every((e) => (e.actions ?? []).length > 0), "and no empty prompt is ever produced from it");
}
fs.writeFileSync(queuePathForJunk, goodQueueText);
assert.strictEqual(readManagerQueue().length >= 1, true, "the real queue is restored after the hostile-file checks");
pass("hostile-queue-file-survived");

// Hostile IDS: an entry whose id/orderId looks like a path must not make the queue create or read
// anything outside the company root. The only file it may touch is the queue file itself.
function inventory(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.push(path.relative(root, p));
    }
  };
  walk(root);
  return out.sort();
}
const filesBefore = inventory(tmpRoot);
writeManagerQueue([
  {
    id: "../../evil",
    at: nowIso(),
    updatedAt: nowIso(),
    kind: "fleet",
    text: "an id that looks like a path",
    orderId: "../../evil",
    runId: "fleet:../../evil",
    state: "pending",
    attempts: 0,
    stale: false,
  },
]);
const hostileIdTick = await managerQueueTick();
assert.strictEqual(hostileIdTick.ok, true, "a path-looking entry id does not break the tick");
const filesAfter = inventory(tmpRoot);
assert.deepStrictEqual(
  filesAfter.filter((f) => !f.endsWith("manager-queue.json")),
  filesBefore.filter((f) => !f.endsWith("manager-queue.json")),
  "and creates nothing but the queue file itself",
);
assert.strictEqual(fs.existsSync(path.join(tmpRoot, "..", "evil")), false, "no file appeared above the company root");
assert.ok(!filesAfter.some((f) => f.includes("..")), "and no file inside the root is named after the hostile id");
pass("hostile-entry-id-stays-inside-the-root");
fs.writeFileSync(queuePathForJunk, goodQueueText);

// The guarded watcher that server.ts starts at boot: prove it starts, is idempotent, honours the
// off switch, and stops cleanly - with no server and no extra RAM. The interval is set to an hour
// so no tick can fire during the check (nothing in the live tree is touched either way).
const { startManagerQueueWatcher, stopManagerQueueWatcher, managerQueueWatcherStatus } = await import(
  "../src/company/needsYouActions.js"
);
process.env.MANAGER_QUEUE_INTERVAL_MS = "3600000";
delete process.env.MANAGER_QUEUE;
const watcher1 = startManagerQueueWatcher();
assert.strictEqual(watcher1.running, true, "the manager-queue watcher starts");
assert.strictEqual(watcher1.enabled, true, "and reports itself enabled");
assert.strictEqual(watcher1.intervalMs, 3600000, "with the configured interval");
assert.strictEqual(startManagerQueueWatcher().running, true, "starting it twice does not start a second loop");
assert.strictEqual(managerQueueWatcherStatus().running, true, "status reports it running");
assert.strictEqual(stopManagerQueueWatcher(), true, "it stops cleanly");
assert.strictEqual(managerQueueWatcherStatus().running, false, "and status reports it stopped");
process.env.MANAGER_QUEUE = "0";
const watcher2 = startManagerQueueWatcher();
assert.strictEqual(watcher2.running, false, "MANAGER_QUEUE=0 disables the watcher");
assert.strictEqual(watcher2.enabled, false, "and says it is disabled");
delete process.env.MANAGER_QUEUE;
pass("watcher-lifecycle");

// The loop really fires: a short interval plus ONE harmless entry in the queue (kind "unknown":
// it escalates - nothing is retried, nothing is spawned) and the watcher must decide it by
// itself, with no hand-called tick.
writeManagerQueue([
  { id: "unknown:watcher", at: new Date().toISOString(), updatedAt: new Date().toISOString(), kind: "unknown", text: "watcher tick check", stale: true, attempts: 0, state: "pending" },
]);
process.env.MANAGER_QUEUE_INTERVAL_MS = "5000";
assert.strictEqual(startManagerQueueWatcher().running, true, "the watcher starts with the short interval");
const deadline = Date.now() + 25000;
let tickedByItself = false;
while (Date.now() < deadline) {
  if (readManagerQueue().find((e) => e.id === "unknown:watcher")?.state === "escalated") {
    tickedByItself = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 250));
}
assert.strictEqual(tickedByItself, true, "the watcher's own tick decided the queued entry (no hand-called tick)");
assert.strictEqual(stopManagerQueueWatcher(), true, "and the watcher stops again");
pass("watcher-fires-on-schedule");

// ---------------------------------------------------------------------------
// E. the ROUTER'S OWN refresh is what fills the queue (the production path)
// ---------------------------------------------------------------------------
// Everything above drove the pieces directly. This drives the exact call the router makes every
// 30s: refreshBriefing() must keep routine prompts out of the CEO's list, persist them into
// company/reports/manager-queue.json by itself, and leave the chat with nothing to ask.
process.env.BRIEFING_SLACK = "0"; // a check must never post to Slack
fs.writeFileSync(
  ordersFile,
  JSON.stringify([failedOrder("foREFRESH", "planning failed: Error: glm-5.3-flash request failed after 180s: TypeError: fetch failed")], null, 2),
);
writeManagerQueue([]);
const refreshed = await refreshBriefing({ force: true });
assert.strictEqual(refreshed.briefing.needsYou.length, 0, "the router's own refresh shows the CEO nothing routine");
const routerQueued = readManagerQueue().filter((e) => e.orderId === "foREFRESH");
assert.strictEqual(routerQueued.length, 1, "and that same refresh put the job in the manager queue");
assert.strictEqual(routerQueued[0]?.state, "pending", "as a pending decision, not yet escalated");
assert.ok((routerQueued[0]?.text ?? "").length > 10, "holding the prompt text the CEO is no longer asked");
assert.strictEqual(
  routerQueued[0]?.text,
  refreshed.briefing.managerQueue?.find((r) => r.runId === "fleet:foREFRESH")?.text,
  "which is exactly the text this composition routed to the manager",
);
assert.ok(routerQueued[0]?.id.startsWith("fleet:job:"), "keyed on the job, so the copy that gets retried is the live one");
assert.strictEqual(queueEscalations().length, 0, "no CEO prompt is raised for it yet");
const chatAsked = askNeedsYouInChat();
assert.strictEqual(chatAsked, 0, "and the chat asks the CEO nothing about it either");
pass("router-refresh-fills-the-queue");

// ---------------------------------------------------------------------------
// F. two overlapping ticks must not double-retry one job
// ---------------------------------------------------------------------------
// Found here on 2026-09-30: the watcher's tick and POST /api/manager-queue/tick can overlap. Before
// the guard, BOTH read the same entry and both fired an automatic retry for ONE retry budget
// (measured: 2 retry calls, attempts recorded as 1).
fs.writeFileSync(ordersFile, JSON.stringify([failedOrder("foCONC", "planning failed: Error: fetch failed")], null, 2));
writeManagerQueue([]);
enqueueRoutineRuns([
  { runId: "fleet:foCONC", title: "the concurrent job", text: "Retry this order or drop it?", state: "failed", updatedAt: nowIso() },
]);
const concCalls: string[] = [];
const slowDeps = {
  retryOrder: async (orderId: string) => {
    concCalls.push(orderId);
    await new Promise((r) => setTimeout(r, 200));
    return "stubbed retry";
  },
};
const [concA, concB] = await Promise.all([managerQueueTick(slowDeps), managerQueueTick(slowDeps)]);
assert.strictEqual(concCalls.length, 1, "two overlapping ticks fire exactly ONE automatic retry");
assert.strictEqual([concA, concB].filter((r) => !!r.busy).length, 1, "exactly one of them reports itself busy");
assert.strictEqual([concA, concB].filter((r) => r.retried.length === 1).length, 1, "while the other did the work");
assert.strictEqual(readManagerQueue().find((e) => e.orderId === "foCONC")?.attempts, 1, "the retry is counted once");
const busyResult = concA.busy ? concA : concB;
assert.strictEqual(typeof busyResult.busy, "string", "the busy result explains itself in plain words");
assert.strictEqual(
  busyResult.retried.length + busyResult.escalated.length + busyResult.resolved.length,
  0,
  "and the busy call changed nothing",
);
pass("overlapping-ticks-single-retry");

// ---------------------------------------------------------------------------
// G. the other half of defect 4, and the queue knobs
// ---------------------------------------------------------------------------
// The decision guard must close a decided job WITHOUT silently swallowing new work: a newer copy of
// the same job (the CEO ordered it again) is a fresh attempt, so the entry reopens onto it and can
// raise a prompt with a NEW id - the old decision must not suppress it.
const reorderText = "the re-ordered job";
fs.writeFileSync(
  ordersFile,
  JSON.stringify(
    [
      { ...failedOrder("foREORDER", "planning failed: Error: fetch failed"), retryCount: 2 },
      { ...failedOrder("foREORDER2", "planning failed: Error: fetch failed"), retryCount: 2 },
    ],
    null,
    2,
  ),
);
writeManagerQueue([]);
enqueueRoutineRuns([
  { runId: "fleet:foREORDER", title: reorderText, text: "Retry this order or drop it?", state: "failed", updatedAt: nowIso() },
]);
await managerQueueTick();
const reorderEntry = readManagerQueue().find((e) => e.orderId === "foREORDER")!;
assert.strictEqual(reorderEntry.state, "escalated", "the capped first copy escalates");
const firstPromptId = queueEscalations().find((p) => p.runId === "fleet:foREORDER")!.id;
const reorderLedger: Record<string, { at: string; actionId: string }> = {};
reorderLedger[firstPromptId] = { at: nowIso(), actionId: "drop" };
fs.writeFileSync(path.join(tmpRoot, "reports", "needs-you-resolved.json"), JSON.stringify(reorderLedger, null, 2));
await managerQueueTick();
assert.strictEqual(readManagerQueue().find((e) => e.orderId === "foREORDER")!.state, "resolved", "the CEO's answer closes the entry");
enqueueRoutineRuns([
  {
    runId: "fleet:foREORDER2",
    itemId: reorderEntry.id,
    title: reorderText,
    text: "Retry this order or drop it?",
    state: "failed",
    updatedAt: nowIso(),
  },
]);
const reopened = readManagerQueue().find((e) => e.id === reorderEntry.id)!;
assert.strictEqual(reopened.state, "pending", "a NEWER copy of a decided job reopens the entry");
assert.strictEqual(reopened.runId, "fleet:foREORDER2", "and it follows the new copy");
assert.ok(!reopened.escalationId, "the old prompt id is cleared so the old decision cannot silence it");
const reorderTick = await managerQueueTick();
assert.ok(reorderTick.escalated.includes(reorderEntry.id), "the new copy can be escalated in its own right");
const secondPrompt = queueEscalations().find((p) => p.runId === "fleet:foREORDER2");
assert.ok(secondPrompt, "and it raises its own prompt");
assert.notStrictEqual(secondPrompt!.id, firstPromptId, "with a DIFFERENT id from the decided copy");
pass("newer-copy-outlives-the-decision");

// MANAGER_QUEUE_MAX_RETRIES=0 means "never retry by yourself": every failed job goes straight to the
// CEO's ONE prompt instead.
process.env.MANAGER_QUEUE_MAX_RETRIES = "0";
fs.writeFileSync(ordersFile, JSON.stringify([failedOrder("foZERO", "planning failed: Error: fetch failed")], null, 2));
writeManagerQueue([]);
enqueueRoutineRuns([
  { runId: "fleet:foZERO", title: "the no-retry job", text: "Retry this order or drop it?", state: "failed", updatedAt: nowIso() },
]);
const zeroCalls: string[] = [];
const zeroTick = await managerQueueTick({
  retryOrder: async (id: string) => {
    zeroCalls.push(id);
    return "should not be called";
  },
});
assert.deepStrictEqual(zeroTick.retried, [], "MANAGER_QUEUE_MAX_RETRIES=0 spends no automatic retry");
assert.strictEqual(zeroCalls.length, 0, "and the retry path is never called");
assert.ok(zeroTick.escalated.includes("fleet:foZERO"), "the job goes straight to its ONE prompt");
assert.strictEqual(queueEscalations().filter((p) => p.runId === "fleet:foZERO").length, 1, "exactly one prompt");
delete process.env.MANAGER_QUEUE_MAX_RETRIES;
pass("max-retries-zero-goes-straight-to-the-ceo");

// Ordering of the rules, pinned: age alone does not escalate a cause a retry can fix. Only a cause
// that needs a person is escalated when it goes stale.
const staleTransient = decideQueueAction({ state: "pending", attempts: 0, runStillFailed: true, failureCause: "planning-failed", stale: true });
assert.strictEqual(staleTransient.action, "retry", "a stale TRANSIENT cause is still retried once (age alone does not escalate)");
const stalePeopleCause = decideQueueAction({ state: "pending", attempts: 0, runStillFailed: true, failureCause: "session-limit", stale: true });
assert.strictEqual(stalePeopleCause.action, "escalate", "a stale cause that needs a person is escalated");
const freshPeopleCause = decideQueueAction({ state: "pending", attempts: 0, runStillFailed: true, failureCause: "session-limit", stale: false });
assert.strictEqual(freshPeopleCause.action, "keep", "while the same fresh cause waits");
pass("rule-ordering-pinned");

// ---------------------------------------------------------------------------
// H. a hand-edited state, and the time knobs
// ---------------------------------------------------------------------------
// The queue file is meant to be inspected (and may be edited by hand), so a state this build does not
// understand must PARK the entry for a person instead of triggering work on it.
fs.writeFileSync(ordersFile, JSON.stringify([failedOrder("foPAUSED", "planning failed: Error: fetch failed")], null, 2));
writeManagerQueue([
  {
    id: "fleet:foPAUSED",
    at: nowIso(),
    updatedAt: nowIso(),
    kind: "fleet",
    text: "an entry whose state was edited by hand",
    orderId: "foPAUSED",
    runId: "fleet:foPAUSED",
    state: "paused",
    attempts: 0,
    stale: false,
  },
]);
const pausedCalls: string[] = [];
const pausedTick = await managerQueueTick({
  retryOrder: async (id: string) => {
    pausedCalls.push(id);
    return "should never run";
  },
});
assert.strictEqual(pausedCalls.length, 0, "an entry with an unrecognised state is never acted on");
assert.deepStrictEqual(pausedTick.retried, [], "nothing is retried for it");
assert.deepStrictEqual(pausedTick.escalated, [], "and nothing is escalated");
assert.strictEqual(normalizeQueueState(readManagerQueue()[0]!.state), "unknown", "its state reads as unknown");
assert.ok(/unrecognised/i.test(readManagerQueue()[0]!.decision ?? ""), "and the entry records why it was left alone");
assert.strictEqual(queueEscalations().length, 0, "no prompt is raised from it");
pass("unrecognised-state-parks-the-entry");

// The wait window: a cause that needs a person escalates once MANAGER_QUEUE_ESCALATE_MINUTES passed.
const waitMinutesBefore = process.env.MANAGER_QUEUE_ESCALATE_MINUTES;
process.env.MANAGER_QUEUE_ESCALATE_MINUTES = "0.001"; // ~60 ms of patience
fs.writeFileSync(
  ordersFile,
  JSON.stringify([failedOrder("foWAIT", "the fleet could not start a worker: session limit reached")], null, 2),
);
writeManagerQueue([
  {
    id: "fleet:foWAIT",
    at: new Date(Date.now() - 5000).toISOString(),
    updatedAt: nowIso(),
    kind: "fleet",
    text: "waited long enough",
    orderId: "foWAIT",
    runId: "fleet:foWAIT",
    state: "pending",
    attempts: 0,
    stale: false,
  },
]);
const waitTick = await managerQueueTick();
assert.ok(waitTick.escalated.includes("fleet:foWAIT"), "a cause that needs a person escalates once the wait window passed");
if (waitMinutesBefore === undefined) delete process.env.MANAGER_QUEUE_ESCALATE_MINUTES;
else process.env.MANAGER_QUEUE_ESCALATE_MINUTES = waitMinutesBefore;
pass("wait-window-escalates");

// The staleness knob decides what counts as stale, in the queue and in the shared rule.
const staleHoursBefore = process.env.MANAGER_QUEUE_STALE_HOURS;
process.env.MANAGER_QUEUE_STALE_HOURS = "0.001"; // ~3.6 s
writeManagerQueue([]);
enqueueRoutineRuns([{ runId: "fleet:foOLD", text: "an old failure", state: "failed", updatedAt: new Date(Date.now() - 60_000).toISOString() }]);
assert.strictEqual(readManagerQueue()[0]?.stale, true, "MANAGER_QUEUE_STALE_HOURS decides what counts as stale at queue time");
assert.strictEqual(isStaleFailure("failed", new Date(Date.now() - 60_000).toISOString()), true, "and the shared stale rule agrees with it");
if (staleHoursBefore === undefined) delete process.env.MANAGER_QUEUE_STALE_HOURS;
else process.env.MANAGER_QUEUE_STALE_HOURS = staleHoursBefore;
assert.strictEqual(isStaleFailure("failed", new Date(Date.now() - 60_000).toISOString()), false, "while under the default window a one-minute-old failure is not stale");
pass("staleness-knob");

// ---------------------------------------------------------------------------
// I. the file cap, and a paused company
// ---------------------------------------------------------------------------
// The cap must never drop a LIVE decision to make room for closed ones.
const bigQueue: Array<Record<string, unknown>> = [];
for (let i = 0; i < 600; i++) {
  bigQueue.push({
    id: `fleet:foCLOSED${i}`,
    at: nowIso(),
    updatedAt: nowIso(),
    kind: "fleet",
    text: `closed entry ${i}`,
    state: "resolved",
    attempts: 0,
    stale: false,
    resolvedAt: nowIso(),
  });
}
bigQueue.splice(5, 0, {
  id: "fleet:foLIVE",
  at: nowIso(),
  updatedAt: nowIso(),
  kind: "fleet",
  text: "the live decision",
  orderId: "foLIVE",
  runId: "fleet:foLIVE",
  state: "escalated",
  attempts: 2,
  stale: false,
  escalationId: escalationIdFor("fleet:foLIVE", "fleet:foLIVE"),
});
writeManagerQueue(bigQueue as never);
const cappedQueue = readManagerQueue();
assert.strictEqual(cappedQueue.length, 500, "the queue file stays capped at 500 entries");
assert.ok(cappedQueue.some((e) => e.id === "fleet:foLIVE"), "and the LIVE entry survives (a closed one is dropped instead)");
assert.strictEqual(
  cappedQueue.filter((e) => normalizeQueueState(e.state) !== "resolved").length,
  1,
  "with exactly the one live entry kept",
);
pass("queue-cap-keeps-live-entries");

// Last-resort bound: when EVERY entry is live, the oldest live ones must go - and that must be LOUD.
const warnCalls: string[] = [];
const realWarn = console.warn;
console.warn = (...args: unknown[]) => {
  warnCalls.push(args.map((a) => String(a)).join(" "));
};
const allLive = Array.from({ length: 600 }, (_, i) => ({
  id: `fleet:foLive${i}`,
  at: nowIso(),
  updatedAt: nowIso(),
  kind: "fleet",
  text: `live entry ${i}`,
  orderId: `foLive${i}`,
  runId: `fleet:foLive${i}`,
  state: "pending",
  attempts: 0,
  stale: false,
}));
writeManagerQueue(allLive as never);
console.warn = realWarn;
const keptLive = readManagerQueue();
assert.strictEqual(keptLive.length, 500, "with only live entries the file is still capped");
assert.ok(keptLive.some((e) => e.id === "fleet:foLive599"), "the newest live entry is kept");
assert.ok(!keptLive.some((e) => e.id === "fleet:foLive0"), "the oldest live entry is the one dropped");
assert.ok(warnCalls.some((w) => /exceed the/.test(w)), "and dropping live entries is logged, never silent");
pass("cap-drops-oldest-live-with-a-warning");

// The same job twice in ONE batch is queued once (a compose that routes a run twice must not double it).
writeManagerQueue([]);
const dupBatch = enqueueRoutineRuns([
  { runId: "fleet:foDUP", text: "Retry this order or drop it?", state: "failed", updatedAt: nowIso() },
  { runId: "fleet:foDUP", text: "Retry this order or drop it?", state: "failed", updatedAt: nowIso() },
]);
assert.strictEqual(dupBatch.added, 1, "the same job twice in one batch is queued once");
assert.strictEqual(readManagerQueue().length, 1, "and the file holds exactly one entry");
pass("same-job-twice-in-one-batch");

// An escalated entry with no words at all must never reach the CEO as a blank card.
writeManagerQueue([
  {
    id: "fleet:foBLANK",
    at: nowIso(),
    updatedAt: nowIso(),
    kind: "fleet",
    text: "",
    orderId: "foBLANK",
    runId: "fleet:foBLANK",
    state: "escalated",
    attempts: 2,
    stale: false,
    escalationId: escalationIdFor("fleet:foBLANK", "fleet:foBLANK"),
  },
]);
assert.strictEqual(queueEscalations().length, 0, "a text-less escalated entry raises no prompt at the source");
const blankBrief = composeBriefing([], {
  seenAt: new Date(0).toISOString(),
  summary: "",
  model: "local",
  queueEscalations: queueEscalations(),
});
assert.strictEqual(blankBrief.needsYou.length, 0, "and nothing blank is shown to the CEO");
pass("blank-entry-never-becomes-a-prompt");

// Patching an entry that is not there is a no-op, not a throw (the file may change under the tick).
assert.strictEqual(updateQueueEntry("no-such-entry", { state: "resolved" }), undefined, "patching a missing entry is a no-op");
assert.strictEqual(readManagerQueue().length, 1, "and the queue is untouched by it");
pass("missing-entry-patch-is-a-no-op");

// A paused company (planned shutdown) must not spend work - but the CEO's list must stay honest:
// a decided entry still closes, and a job that has spent its retries still escalates.
setPaused(true, "ops/manager-queue-check.ts: pause behaviour");
fs.writeFileSync(
  ordersFile,
  JSON.stringify(
    [
      failedOrder("foPAUSEWORK", "planning failed: Error: fetch failed"),
      { ...failedOrder("foPAUSECAP", "planning failed: Error: fetch failed"), retryCount: 2 },
    ],
    null,
    2,
  ),
);
writeManagerQueue([
  {
    id: "fleet:foPAUSEWORK",
    at: nowIso(),
    updatedAt: nowIso(),
    kind: "fleet",
    text: "a retryable failure during a pause",
    orderId: "foPAUSEWORK",
    runId: "fleet:foPAUSEWORK",
    state: "pending",
    attempts: 0,
    stale: false,
  },
]);
const pauseCalls: string[] = [];
const pauseTick = await managerQueueTick({
  retryOrder: async (id: string) => {
    pauseCalls.push(id);
    return "should never run while paused";
  },
});
assert.strictEqual(pauseCalls.length, 0, "a paused company spends no automatic retry");
assert.ok(!!pauseTick.blocked, "and the tick reports that it was blocked");
assert.deepStrictEqual(pauseTick.escalated, [], "nothing is escalated while it waits");
// an at-cap job still escalates while paused (the CEO is still told the truth)
writeManagerQueue([
  {
    id: "fleet:foPAUSECAP",
    at: nowIso(),
    updatedAt: nowIso(),
    kind: "fleet",
    text: "a capped failure during a pause",
    orderId: "foPAUSECAP",
    runId: "fleet:foPAUSECAP",
    state: "pending",
    attempts: 2,
    stale: false,
  },
]);
const pausedCapTick = await managerQueueTick();
assert.ok(pausedCapTick.escalated.includes("fleet:foPAUSECAP"), "a job that spent its retries still escalates while paused");
setPaused(false, "ops/manager-queue-check.ts: pause behaviour checked");
const unpausedTick = await managerQueueTick({ retryOrder: async (id: string) => `stubbed retry for ${id}` });
assert.strictEqual(unpausedTick.blocked, undefined, "and once resumed the block is gone");
pass("paused-company-is-honest");

// ---------------------------------------------------------------------------
// J. the CEO-facing paths: the chat answer, and the API contract
// ---------------------------------------------------------------------------
// The CEO can answer the ONE prompt in chat as well as on the page: the assistant must find this
// item (an `mq:` id it has never seen before) among the things it asked, and resolve it.
fs.writeFileSync(ordersFile, JSON.stringify([failedOrder("foCHAT", "planning failed: Error: fetch failed")], null, 2));
writeManagerQueue([
  {
    id: "fleet:foCHAT",
    at: nowIso(),
    updatedAt: nowIso(),
    kind: "fleet",
    text: "Retry this order or drop it?",
    orderId: "foCHAT",
    runId: "fleet:foCHAT",
    state: "escalated",
    attempts: 2,
    stale: false,
    escalationId: escalationIdFor("fleet:foCHAT", "fleet:foCHAT"),
  },
]);
// The chat reads the briefing FILE, so the router's own refresh is what puts the escalated item in
// front of it (exactly as production does every 30s).
await refreshBriefing({ force: true });
const chatAskedEscalation = askNeedsYouInChat();
assert.ok(chatAskedEscalation >= 1, `the chat asks about the escalated prompt once (${chatAskedEscalation})`);
const chatAnswer = await tryResolveFromChat("drop");
assert.ok(!!chatAnswer && chatAnswer.ok === true, `the CEO's one-word chat answer resolves it (${chatAnswer?.message ?? "null"})`);
const chatTick = await managerQueueTick();
assert.ok(chatTick.resolved.includes("fleet:foCHAT"), "and the queue closes that entry");
assert.strictEqual(queueEscalations().length, 0, "leaving no prompt behind");
pass("escalation-answered-from-the-chat");

// The API contract the manager will consume (GET /api/manager-queue -> managerQueueSummary()).
const queueSummary = managerQueueSummary();
for (const key of ["total", "pending", "autoRetried", "escalated", "resolved", "maxRetries", "items", "updatedAt"]) {
  assert.ok(key in queueSummary, `the summary carries ${key}`);
}
assert.strictEqual(typeof queueSummary.total, "number", "total is a number");
assert.strictEqual(typeof queueSummary.maxRetries, "number", "maxRetries is a number");
assert.ok(Array.isArray(queueSummary.items), "items is a list");
assert.ok(queueSummary.items.length <= 100, `items is bounded (${queueSummary.items.length} <= 100)`);
pass("summary-contract");

// The file is oldest-first; the summary shows the newest first, and stays bounded.
writeManagerQueue([
  { id: "fleet:foOLDEST", at: nowIso(), updatedAt: nowIso(), kind: "fleet", text: "older", orderId: "foOLDEST", runId: "fleet:foOLDEST", state: "pending", attempts: 0, stale: false },
  { id: "fleet:foNEWEST", at: nowIso(), updatedAt: nowIso(), kind: "fleet", text: "newer", orderId: "foNEWEST", runId: "fleet:foNEWEST", state: "pending", attempts: 0, stale: false },
]);
const summaryIds = managerQueueSummary().items.map((i) => i.id);
assert.deepStrictEqual(summaryIds, ["fleet:foNEWEST", "fleet:foOLDEST"], "the summary lists the newest entry first");
pass("summary-order-newest-first");

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\nAll ${cases.length} cases passed.`);
