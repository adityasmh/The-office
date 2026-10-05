/**
 * ops/needs-you-dedupe-test.ts - DUPLICATE-PROMPTS acceptance probe.
 *
 * Proves the fixes for the "the same 'Retry this order or drop it?' prompt appears
 * again and again" bug:
 *   1. several copies of ONE job (same long title) produce a single prompt;
 *   2. a later order with the same title supersedes the earlier copies;
 *   3. a cancelled (dropped) order is closed, not shown as failed;
 *   4. distinct jobs (and short/generic titles) are NOT merged;
 *   5. the chat asks an identical question once, however many runs raised it.
 *
 * CEO APPROVAL POLICY (2026-09-30): a retry/drop prompt for a FAILED run is not the CEO's
 * decision any more. Those prompts are routed out of `needsYou` into
 * `briefing.managerQueue` (persisted to company/reports/manager-queue.json, served at
 * GET /api/manager-queue). The dedupe guarantees above still hold - the checks below read
 * the manager queue for them, exactly as they used to read needsYou.
 *
 * Run with: npx tsx ops/needs-you-dedupe-test.ts
 *
 * Safety: runs entirely inside a temporary COMPANY_ROOT. It never reads or writes the
 * live company/ tree, never calls a model and never starts a server.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ny-dedupe-test-"));
process.env.COMPANY_ROOT = tmpDir;
process.env.NEEDS_YOU_AUTO_NUDGE = "0";

fs.mkdirSync(path.join(tmpDir, "fleet"), { recursive: true });
fs.mkdirSync(path.join(tmpDir, "reports"), { recursive: true });

const LONG_A =
  "GOAL: Build the assistant chat upgrade so the CEO can see when the assistant is talking vs listening. DELIVERABLES: animated companion, live transcript, state indicator.";
const LONG_B =
  "GOAL: Write the operator guide and a read-only health check script for the six fleet routes in docs/FLEET_SPEC.md.";
const LONG_C =
  "GOAL: Rebuild the CEO dashboard with a live cost meter and a per-department rollup panel for the morning briefing.";

const t0 = "2026-09-30T10:00:00.000Z";
const t1 = "2026-09-30T11:00:00.000Z";

// A fleet orders file with: two copies of one job (A), a distinct job (B), a cancelled
// job (C).
fs.writeFileSync(
  path.join(tmpDir, "fleet", "orders.json"),
  JSON.stringify(
    [
      { id: "oldA", text: LONG_A, createdAt: t0, updatedAt: t0, status: "failed", workOrders: [], trace: [] },
      { id: "newA", text: LONG_A, createdAt: t1, updatedAt: t1, status: "failed", workOrders: [], trace: [] },
      { id: "jobB", text: LONG_B, createdAt: t1, updatedAt: t1, status: "failed", workOrders: [], trace: [] },
      { id: "jobC", text: LONG_C, createdAt: t0, updatedAt: t0, status: "cancelled", workOrders: [], trace: [] },
    ],
    null,
    2,
  ),
);

const { listRunCards } = await import("../src/company/runManagers.js");
const { composeBriefing } = await import("../src/company/briefing.js");
const { isSupersededOrder, orderTitleKey } = await import("../src/company/needsYouRule.js");
const { askNeedsYouInChat, reportTailLine } = await import("../src/company/assistant.js");
const { __testReissueOrders } = await import("../src/company/needsYouActions.js");
const { enqueueRoutineRuns, readManagerQueue } = await import("../src/company/managerQueue.js");
import type { RunCard } from "../src/company/runManagers.js";

let pass = true;
function check(cond: boolean, msg: string) {
  if (cond) console.log(`PASS ${msg}`);
  else {
    console.log(`FAIL ${msg}`);
    pass = false;
  }
}

function card(over: Partial<RunCard>): RunCard {
  return {
    runId: "fleet:x",
    kind: "fleet",
    title: "t",
    owner: "Fleet",
    state: "failed",
    headline: "h",
    done: [],
    remaining: [],
    model: "local",
    modelReason: "synthetic",
    checkedAt: t0,
    evidenceHash: "s",
    reported: false,
    updatedAt: t1,
    ref: { kind: "fleet", orderId: "x" },
    ...over,
  } as RunCard;
}

// ---------------------------------------------------------------------------
// 1. Live-ish discovery: the duplicate and the cancelled order are closed.
// ---------------------------------------------------------------------------
const cards = listRunCards();
const stateOf = (runId: string) => cards.find((c) => c.runId === runId)?.state;
check(stateOf("fleet:oldA") === "done", "older duplicate order (oldA) is closed (done)");
check(stateOf("fleet:newA") === "failed", "newest copy of the job (newA) is still open (failed)");
check(stateOf("fleet:jobC") === "done", "cancelled order (jobC) is closed (done), not failed");

// Only the fleet cards, so a session card found on this machine cannot change the result.
const fleetCards = cards.filter((c) => c.kind === "fleet");
const briefing = composeBriefing(fleetCards, { seenAt: t0, summary: "", model: "local" });
// CEO APPROVAL POLICY (2026-09-30): these are routine retry/drop prompts, so the CEO's list
// must be empty and the runs must be handed over as briefing.managerQueue instead. The queue
// entry's `runId` names the order (its stable id is asserted in ops/manager-queue-check.ts).
const queued = briefing.managerQueue ?? [];
check(briefing.needsYou.length === 0, "no retry/drop prompt is shown to the CEO");
check(queued.length === 2, `the two open jobs were handed to the manager queue (${queued.length})`);
const queuedRuns = queued.map((r) => r.runId);
check(queuedRuns.includes("fleet:newA"), "newest copy of the job is the one entry queued");
check(!queuedRuns.includes("fleet:oldA"), "older duplicate order raises no entry");
check(!queuedRuns.includes("fleet:jobC"), "a dropped order raises no entry");
check(queuedRuns.includes("fleet:jobB"), "a distinct job still raises its own entry");
check(queuedRuns.filter((id) => id === "fleet:newA" || id === "fleet:oldA").length === 1, "at most one queue entry per job");

// ---------------------------------------------------------------------------
// 2. Pure rule: a later same-title order supersedes the older copy.
// ---------------------------------------------------------------------------
check(
  isSupersededOrder(
    { id: "oldA", text: LONG_A, createdAt: t0, status: "failed" },
    [
      { id: "oldA", text: LONG_A, createdAt: t0, status: "failed" },
      { id: "newA", text: LONG_A, createdAt: t1, status: "failed" },
    ],
  ),
  "isSupersededOrder: later failed copy of the same job supersedes the older",
);
check(
  !isSupersededOrder(
    { id: "jobB", text: LONG_B, createdAt: t1, status: "failed" },
    [
      { id: "jobB", text: LONG_B, createdAt: t1, status: "failed" },
      { id: "newA", text: LONG_A, createdAt: t1, status: "failed" },
    ],
  ),
  "isSupersededOrder: a different job is not superseded",
);

// ---------------------------------------------------------------------------
// 3. Composition dedupe: newest wins; short titles are never merged.
// ---------------------------------------------------------------------------
const dupCards = [
  card({ runId: "fleet:o1", title: LONG_A, updatedAt: t0 }),
  card({ runId: "fleet:o2", title: LONG_A, updatedAt: t1 }),
];
const dupBrief = composeBriefing(dupCards, { seenAt: t0, summary: "", model: "local" });
const dupQueue = dupBrief.managerQueue ?? [];
check(
  dupQueue.length === 1 && dupQueue[0]?.runId === "fleet:o2",
  "two copies of one job collapse to the newest single entry",
);

const shortCards = [
  card({ runId: "fleet:s1", title: "voice project", updatedAt: t0 }),
  card({ runId: "fleet:s2", title: "voice project", updatedAt: t1 }),
];
const shortBrief = composeBriefing(shortCards, { seenAt: t0, summary: "", model: "local" });
check((shortBrief.managerQueue ?? []).length === 2, "short/generic titles are NOT merged");
check(orderTitleKey("voice project") === "", "a short title gets no dedupe key");
check(orderTitleKey(LONG_A) !== "", "a long job title gets a dedupe key");

// 3b. CEO APPROVAL POLICY (2026-09-30): answering a job closes it. The old guarantee was
// "a stale copy never puts the same prompt back"; the queue now carries that guarantee: the
// same unchanged job is queued ONCE, and a different job is queued separately. The CEO-side
// half (an answered item disappears from needs-you) is checked on an approval card, the kind
// of item the CEO still answers.
const dupQItemId = dupQueue[0]?.itemId ?? "";
const firstQueue = enqueueRoutineRuns(dupBrief.managerQueue ?? []);
check(firstQueue.added === 1, `the composed routine run queues exactly one entry (${firstQueue.added})`);
const secondQueue = enqueueRoutineRuns(dupBrief.managerQueue ?? []);
check(
  secondQueue.added === 0 && readManagerQueue().length === 1,
  "queueing the same unchanged job again adds no second entry (nothing is re-asked)",
);
const withOther = [...dupCards, card({ runId: "fleet:other", title: LONG_B, updatedAt: t1 })];
const otherBrief = composeBriefing(withOther, { seenAt: t0, summary: "", model: "local" });
check(
  (otherBrief.managerQueue ?? []).some((r) => r.runId === "fleet:other"),
  "and a different job is queued on its own",
);

// An answered item never shows again: the approval the CEO does answer clears on its own id.
const approvalCard = card({
  kind: "task",
  runId: "task:p:tApprove",
  ref: { kind: "task", projectId: "p", taskId: "tApprove" },
  title: LONG_C,
  state: "waiting_for_ceo",
  needsCeo: "Approve the plan so the coder can start.",
});
const approvalBrief = composeBriefing([approvalCard], { seenAt: t0, summary: "", model: "local" });
check(approvalBrief.needsYou.length === 1, "a plan approval is still shown to the CEO");
const approvalId = approvalBrief.needsYou[0]?.id ?? "";
const approvalResolved = composeBriefing([approvalCard], {
  seenAt: t0,
  summary: "",
  model: "local",
  resolved: { [approvalId]: { at: "2026-09-30T12:00:00.000Z" } },
});
check(approvalResolved.needsYou.length === 0, "answering it clears it (nothing is re-asked)");
check(!!dupQItemId && readManagerQueue().every((e) => e.id === dupQItemId), "the queue is keyed on the job, not on the order copy");

// 3c. The needs-you cap still holds when many jobs are open. (Approval cards: a routine
// retry/drop prompt is not in needsYou at all now, so the cap is proved on the CEO's items.)
const many = Array.from({ length: 8 }, (_, i) =>
  card({
    kind: "task",
    runId: `task:p:t${i}`,
    ref: { kind: "task", projectId: "p", taskId: `t${i}` },
    title: `${LONG_B} variant ${i}`,
    state: "waiting_for_ceo",
    needsCeo: "Approve the plan so the coder can start.",
    updatedAt: t1,
  }),
);
const manyBrief = composeBriefing(many, { seenAt: t0, summary: "", model: "local" });
check(manyBrief.needsYou.length <= 6, `the needs-you cap still holds (${manyBrief.needsYou.length} <= 6)`);
check(
  new Set(manyBrief.needsYou.map((n) => n.id)).size === manyBrief.needsYou.length,
  "no duplicate ids in the needs-you list",
);

// 3d. Rule guards: no title text, and an older copy never supersedes a newer one.
check(
  !isSupersededOrder(
    { id: "a", text: "", createdAt: t0, status: "failed" },
    [{ id: "b", text: "", createdAt: t1, status: "failed" }],
  ),
  "empty-text orders are not treated as the same job",
);
check(
  !isSupersededOrder(
    { id: "new", text: LONG_A, createdAt: t1, status: "failed" },
    [{ id: "old", text: LONG_A, createdAt: t0, status: "failed" }],
  ),
  "an older copy never supersedes a newer one",
);

// 3e. Ties are deterministic: the winner does not depend on card order.
const tieA = card({ runId: "fleet:tA", title: LONG_A, updatedAt: t1, checkedAt: t1 });
const tieB = card({ runId: "fleet:tB", title: LONG_A, updatedAt: t1, checkedAt: t1 });
const tie1 = composeBriefing([tieA, tieB], { seenAt: t0, summary: "", model: "local" });
const tie2 = composeBriefing([tieB, tieA], { seenAt: t0, summary: "", model: "local" });
const tie1Runs = (tie1.managerQueue ?? []).map((r) => r.runId);
const tie2Runs = (tie2.managerQueue ?? []).map((r) => r.runId);
check(tie1Runs.length === 1 && tie2Runs.length === 1, "equal-timestamp duplicates still collapse to one entry");
check(
  JSON.stringify(tie1Runs) === JSON.stringify(tie2Runs),
  "equal timestamps: the same copy wins regardless of card order",
);

// 3f. Dedupe is not fleet-only: task cards for one job collapse too.
const taskDup = [
  card({
    kind: "task",
    runId: "task:p:t1",
    ref: { kind: "task", projectId: "p", taskId: "t1" },
    title: LONG_B,
    updatedAt: t0,
  }),
  card({
    kind: "task",
    runId: "task:p:t2",
    ref: { kind: "task", projectId: "p", taskId: "t2" },
    title: LONG_B,
    updatedAt: t1,
  }),
];
const taskBrief = composeBriefing(taskDup, { seenAt: t0, summary: "", model: "local" });
const taskQueue = taskBrief.managerQueue ?? [];
check(
  taskQueue.length === 1 && taskQueue[0]?.runId === "task:p:t2",
  "task cards for one job also collapse to the newest single entry",
);

// ---------------------------------------------------------------------------
// 4. Chat asks an identical question once, however many runs raised it.
// ---------------------------------------------------------------------------
fs.writeFileSync(
  path.join(tmpDir, "reports", "briefing.json"),
  JSON.stringify(
    {
      needsYou: [
        {
          id: "fleet:q1",
          runId: "fleet:q1",
          text: "one order failed",
          kind: "choice",
          question: "Retry this order or drop it?",
          actions: [
            { id: "retry", label: "Retry order" },
            { id: "drop", label: "Drop order" },
          ],
        },
        {
          id: "fleet:q2",
          runId: "fleet:q2",
          text: "another order failed",
          kind: "choice",
          question: "Retry this order or drop it?",
          actions: [
            { id: "retry", label: "Retry order" },
            { id: "drop", label: "Drop order" },
          ],
        },
      ],
    },
    null,
    2,
  ),
);
const askedCount = askNeedsYouInChat();
check(askedCount === 1, "the chat asks one identical question once (not once per run)");
const threadLines = fs
  .readFileSync(path.join(tmpDir, "assistant.jsonl"), "utf8")
  .trim()
  .split("\n")
  .filter(Boolean);
check(threadLines.length === 1, "exactly one chat prompt was appended");
const asked = JSON.parse(fs.readFileSync(path.join(tmpDir, "reports", "needs-you-asked.json"), "utf8"));
check(!!asked["fleet:q1"] && !!asked["fleet:q2"], "both runs are recorded as asked, so neither is asked again");

// 4b/4c. Ledger semantics: a stale entry for a closed run is harmless; clearing the
// entry for a still-open item re-asks it exactly once (never once per poll).
const briefingPath = path.join(tmpDir, "reports", "briefing.json");
const askedPath = path.join(tmpDir, "reports", "needs-you-asked.json");
const q1Only = {
  needsYou: [
    {
      id: "fleet:q1",
      runId: "fleet:q1",
      text: "one order failed",
      kind: "choice",
      question: "Retry this order or drop it?",
      actions: [
        { id: "retry", label: "Retry order" },
        { id: "drop", label: "Drop order" },
      ],
    },
  ],
};
const stamp = new Date().toISOString();
fs.writeFileSync(briefingPath, JSON.stringify(q1Only, null, 2));
fs.writeFileSync(askedPath, JSON.stringify({ "fleet:q1": { at: stamp }, "fleet:gone": { at: stamp } }, null, 2));
check(askNeedsYouInChat() === 0, "a stale ledger entry for a closed run asks nothing");
fs.writeFileSync(askedPath, JSON.stringify({}, null, 2));
check(askNeedsYouInChat() === 1, "a cleared ledger entry for an open item re-asks it exactly once");
check(askNeedsYouInChat() === 0, "and never more than once");

// ---------------------------------------------------------------------------
// 5. Joey never says "Needs you: nothing" while a prompt is open.
// ---------------------------------------------------------------------------
check(!reportTailLine(true, "t1").includes("Needs you: nothing"), "open item: Joey reports it, not 'Needs you: nothing'");
fs.writeFileSync(path.join(tmpDir, "reports", "briefing.json"), JSON.stringify({ needsYou: [] }, null, 2));
check(reportTailLine(true, "t1").includes("Needs you: nothing"), "no open items: Joey may say 'Needs you: nothing'");

// ---------------------------------------------------------------------------
// 6. The reissue guard: a newer copy means no new order is minted.
// ---------------------------------------------------------------------------
const ordersPath = path.join(tmpDir, "fleet", "orders.json");
const before = JSON.parse(fs.readFileSync(ordersPath, "utf8")) as Array<{ id: string }>;
const reissued = await __testReissueOrders(["oldA"], undefined);
const after = JSON.parse(fs.readFileSync(ordersPath, "utf8")) as Array<{ id: string; supersededBy?: string }>;
check(after.length === before.length, "retry did not mint a new order when a newer copy exists");
check(reissued.created.length === 1 && reissued.created[0] === "newA", "retry pointed at the newer copy instead of creating one");
check(reissued.capped.length === 0, "nothing was reported as capped while a newer copy existed");
check(
  after.find((o) => o.id === "oldA")?.supersededBy === "newA",
  "the old order is marked superseded by the newer copy",
);

console.log(pass ? "\nAll DUPLICATE-PROMPTS checks passed." : "\nDUPLICATE-PROMPTS checks FAILED.");
process.exit(pass ? 0 : 1);
