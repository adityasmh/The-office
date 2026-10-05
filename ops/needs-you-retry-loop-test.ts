/**
 * ops/needs-you-retry-loop-test.ts - RETRY LOOP acceptance probe (2026-09-30).
 *
 * The CEO's complaint: the system was "stuck in a loop asking for approval and failing".
 * This probe proves the fixes, all against a THROWAWAY COMPANY_ROOT (never the live
 * company tree), with MOCK_MODE=1 so no model is called:
 *
 *   A. ONE entry per job: a failed order's prompt is keyed on (job + why it failed), not on
 *      the order id, so a retry (which mints a NEW order id) does not look like a brand-new
 *      prompt, and two copies of one job collapse to one entry.
 *   B. The retry really re-queues: the manager queue retries a transiently-failed order by
 *      itself, the new order carries the same text with retryCount/retriedFrom, and it goes
 *      through the normal (mock) planner path - nothing is spawned.
 *   C. The cap: after FLEET_ORDER_MAX_RETRIES (2) no further copy is minted and the queue
 *      raises exactly ONE item for the CEO, which says how many retries were spent.
 *   D. The FAIL/REDO re-check loop: runManagers.recheckDecision stops re-checking a run whose
 *      manager check keeps failing (the measured loop: one order re-written FAIL 90x).
 *   E. The stale-prompt cleanup (ops/needs-you-stale-resolve.ts) still finds and closes the
 *      prompts whose root cause is fixed, and the manager queue honours those closures.
 *
 * CEO APPROVAL POLICY (2026-09-30): a plain "Retry this order or drop it?" prompt is NOT the
 * CEO's decision any more. Those prompts are routed out of `needsYou` into `briefing.
 * managerQueue` (persisted to company/reports/manager-queue.json, served at
 * GET /api/manager-queue) and decided by src/company/needsYouActions.managerQueueTick. Every
 * check below therefore reads the manager queue where it used to read needsYou.
 *
 * Run: npx tsx ops/needs-you-retry-loop-test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ny-retry-loop-"));
process.env.COMPANY_ROOT = tmpDir;
// MOCK_MODE=1: planOrder uses the built-in mock plan, so no planner model is called.
process.env.MOCK_MODE = "1";
// The RAM floor is checked before any terminal opens; set absurdly high so this probe can
// never spawn a window (the same guard the live fleet uses when memory is low).
process.env.MIN_FREE_RAM_MB = "900000";
process.env.NEEDS_YOU_AUTO_NUDGE = "0";
process.env.FLEET_ORDER_MAX_RETRIES = "2";
process.env.MANAGER_QUEUE_MAX_RETRIES = "2";
process.env.RUN_MANAGER_BACKEND = "heuristic";
// Discovery is memoised for 15 s on the live router; a probe that edits orders.json and
// immediately re-composes must not read that cache.
process.env.RUN_DISCOVER_TTL_MS = "0";

fs.mkdirSync(path.join(tmpDir, "fleet"), { recursive: true });
fs.mkdirSync(path.join(tmpDir, "reports"), { recursive: true });

const LONG_A =
  "GOAL: Build the assistant chat upgrade so the CEO can see when the assistant is talking vs listening. DELIVERABLES: animated companion, live transcript, state indicator.";
const LONG_B =
  "GOAL: Write the operator guide and a read-only health check script for the six fleet routes in docs/FLEET_SPEC.md.";
const LONG_C =
  "GOAL: Rebuild the CEO dashboard with a live cost meter and a per-department rollup panel for the morning briefing.";
const LONG_D =
  "GOAL: Rebuild the two fleet deliverables that were never built, plus the operator guide for the six fleet routes.";
const LONG_E =
  "GOAL: Add the retry-loop regression cover for the manager queue so a transient gateway failure is retried by itself.";
const PLANNER_ERR = "the planner produced no usable work orders";
// A TRANSIENT cause: the manager queue is allowed to retry this one by itself.
const TRANSIENT_ERR = "planning failed: Error: glm-5.3-flash request failed after 180s: TypeError: fetch failed";
// A cause that needs a person: the queue must NOT retry this one by itself.
const SESSION_ERR = "the fleet could not start a worker: session limit reached";

const t0 = "2026-09-30T10:00:00.000Z";
const t1 = "2026-09-30T10:30:00.000Z";

const ordersFile = path.join(tmpDir, "fleet", "orders.json");
type Order = {
  id: string;
  text: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  error?: string;
  retryCount?: number;
  retriedFrom?: string;
  retryExhaustedAt?: string;
  closedAs?: string;
  supersededBy?: string;
  plan?: string;
  workOrders: Array<{ id: string; state: string; sessionId?: string }>;
  trace: unknown[];
};
const seed: Order[] = [
  { id: "a1", text: LONG_A, createdAt: t0, updatedAt: t0, status: "failed", error: PLANNER_ERR, workOrders: [], trace: [] },
  { id: "a2", text: LONG_A, createdAt: t1, updatedAt: t1, status: "failed", error: PLANNER_ERR, workOrders: [], trace: [] },
  { id: "b1", text: LONG_B, createdAt: t0, updatedAt: t0, status: "failed", error: PLANNER_ERR, workOrders: [], trace: [] },
  { id: "c1", text: LONG_C, createdAt: t0, updatedAt: t0, status: "failed", error: PLANNER_ERR, retryCount: 2, workOrders: [], trace: [] },
  { id: "e1", text: LONG_D, createdAt: t0, updatedAt: t0, status: "failed", error: SESSION_ERR, workOrders: [], trace: [] },
  { id: "r1", text: LONG_E, createdAt: t0, updatedAt: t0, status: "failed", error: TRANSIENT_ERR, workOrders: [], trace: [] },
];
function writeOrders(list: Order[]): void {
  fs.writeFileSync(ordersFile, JSON.stringify(list, null, 2));
}
function readOrders(): Order[] {
  return JSON.parse(fs.readFileSync(ordersFile, "utf8")) as Order[];
}
writeOrders(seed);

const { listRunCards, recheckDecision } = await import("../src/company/runManagers.js");
const { composeBriefing } = await import("../src/company/briefing.js");
const { __testReissueOrders, managerQueueTick } = await import("../src/company/needsYouActions.js");
const { jobPromptId, orderFailureCause, orderRetryDepth } = await import("../src/company/needsYouRule.js");
const { readManagerQueue, queueEscalations, writeManagerQueue, enqueueRoutineRuns } = await import("../src/company/managerQueue.js");
const { findStalePrompts, applyStaleResolve } = await import("./needs-you-stale-resolve.js");
import type { BriefingItem } from "../src/company/briefing.js";
import type { RoutineRun } from "../src/company/managerQueue.js";

let pass = true;
function check(cond: boolean, msg: string): void {
  if (cond) console.log(`PASS ${msg}`);
  else {
    console.log(`FAIL ${msg}`);
    pass = false;
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Wait for the async planner to settle, so a simulated failure is not overwritten by it. */
async function waitSettled(id: string, timeoutMs = 8000): Promise<Order | undefined> {
  for (let i = 0; i < timeoutMs / 100; i++) {
    const o = readOrders().find((x) => x.id === id);
    if (o && (o.status === "running" || o.status === "awaiting_approval")) return o;
    await sleep(100);
  }
  return readOrders().find((x) => x.id === id);
}
/** Make an order fail the way the fleet would, on disk (the last word, after the planner). */
function failOrder(id: string, error: string): void {
  const list = readOrders();
  const o = list.find((x) => x.id === id);
  if (!o) return;
  o.status = "failed";
  o.error = error;
  o.updatedAt = new Date(Date.now() + 1000).toISOString();
  o.workOrders = [];
  writeOrders(list);
}
/**
 * Make an order fail and MAKE IT STICK. The fleet saves the whole orders array from
 * memory (approve -> fillSlots -> save), so a write can be reverted by a pass that loaded
 * the file a moment earlier; the probe rewrites until the file agrees twice in a row.
 */
async function failOrderAndVerify(id: string, error: string): Promise<boolean> {
  let stable = 0;
  for (let i = 0; i < 20 && stable < 2; i++) {
    const o = readOrders().find((x) => x.id === id);
    if (o?.status === "failed" && o.error === error) stable++;
    else {
      stable = 0;
      failOrder(id, error);
    }
    await sleep(250);
  }
  return stable >= 2;
}

/** The CEO's list (what the CEO would answer) after one composition. */
function compose(resolved: Record<string, { at: string }> = {}): BriefingItem[] {
  return composeBriefing(listRunCards(), {
    seenAt: new Date(0).toISOString(),
    summary: "probe",
    model: "local",
    resolved,
  }).needsYou;
}
/** The routine prompts this composition hands to the manager queue. */
function composeQueued(): RoutineRun[] {
  return (
    composeBriefing(listRunCards(), { seenAt: new Date(0).toISOString(), summary: "probe", model: "local" }).managerQueue ?? []
  );
}
/** One full pass as the router does it: compose, persist the routine prompts, then decide. */
async function tickThroughCompose(): Promise<void> {
  enqueueRoutineRuns(composeQueued());
  await managerQueueTick();
}
const entryFor = (runId: string) => readManagerQueue().find((e) => e.runId === runId);
const entryById = (id: string) => readManagerQueue().find((e) => e.id === id);
const DEBUG = !!process.env.PROBE_DEBUG;
function dump(label: string): void {
  if (!DEBUG) return;
  console.log(`--- ${label}`);
  for (const e of readManagerQueue()) {
    console.log(`    ${e.id}  run=${e.runId}  state=${e.state}  attempts=${e.attempts}  cause=${e.failureCause ?? "-"}  ${e.decision ?? ""}`);
  }
}

// ── A. one entry per job, keyed by (job + cause) ────────────────────────────
const first = composeQueued();
dump("first compose");
const jobA = first.filter((r) => r.runId === "fleet:a1" || r.runId === "fleet:a2");
check(jobA.length === 1, "two copies of one failed job produce exactly ONE manager-queue entry");
check(jobA[0]?.runId === "fleet:a2", "the entry follows the NEWEST copy of the job");
check((jobA[0]?.itemId ?? "").startsWith("fleet:job:"), "the entry id is the job key, not the order id");
const a2Card = listRunCards().find((c) => c.runId === "fleet:a2");
check(jobA[0]?.itemId === jobPromptId(String(a2Card?.title ?? ""), "planner-no-plan"), "the job key is stable (job + why it failed)");
check(!!first.find((r) => r.runId === "fleet:b1") && first.find((r) => r.runId === "fleet:b1")!.itemId !== jobA[0]!.itemId, "a different job gets a different entry");
const ceoItems = compose();
check(ceoItems.length === 0, `no routine retry/drop prompt is shown to the CEO (${ceoItems.map((i) => `${i.runId}:${i.question}`).join(" | ")})`);
const again = composeQueued();
check(
  JSON.stringify(again.map((r) => `${r.itemId}|${r.runId}`)) === JSON.stringify(first.map((r) => `${r.itemId}|${r.runId}`)),
  "composing twice gives identical entries (no oscillation)",
);
check(!!first.find((r) => r.runId === "fleet:c1"), "a job that already used its retries still gets its own entry");
check(orderRetryDepth({ id: "c1", retryCount: 2 }) === 2, "the retry depth is read from the order");

// ── B. the manager queue retries a transient failure by itself ──────────────
enqueueRoutineRuns(first);
dump("queued");
const r1Entry = entryFor("fleet:r1");
check(!!r1Entry && r1Entry.state === "pending", "the transiently-failed order is queued pending");

const beforeRetry = readOrders().length;
const tick1 = await managerQueueTick();
dump("after tick 1");
check(tick1.retried.includes(r1Entry!.id), `the queue retried the transient failure by itself (${tick1.retried.join(", ")})`);
check(!tick1.retried.includes("fleet:e1"), "the queue did NOT auto-retry the failure that needs a person (session limit)");
const afterRetry = readOrders();
const created = afterRetry.filter((o) => o.retriedFrom === "r1");
check(created.length === 1, "the automatic retry created exactly one new order");
check(afterRetry.length === beforeRetry + 1, "no other order was created");
check(created[0]?.text === LONG_E, "the new order carries the same job text (re-queued, not lost)");
check(created[0]?.retryCount === 1, "the new order records retryCount = 1 (the cap is per job, not per order id)");
check(readOrders().find((o) => o.id === "r1")?.supersededBy === created[0]!.id, "the old order is marked superseded by the new copy");
check(entryFor("fleet:r1")?.attempts === 1, "the queue counted the retry");
check(queueEscalations().some((p) => p.runId === "fleet:c1"), "the job that already used its retries escalated on the first pass (one prompt)");

// planning is async; wait for the mock plan to land and settle.
const newId = created[0]!.id;
const planned = (await waitSettled(newId))!;
check(planned.status === "running" || planned.status === "awaiting_approval", `the re-queued order went through the planner (status ${planned.status})`);
check(planned.workOrders.length === 2, `the planner produced work orders for the retry (${planned.workOrders.length})`);
check(planned.workOrders.every((w) => !w.sessionId), "nothing was spawned in this probe (no terminal opened)");
check(planned.plan !== undefined && planned.plan.length > 0, "the retry produced a real plan");

// The superseded original is closed, and the entry closes too: the job is progressing again,
// so there is nothing left for the manager to decide.
await tickThroughCompose();
dump("after the retry is running");
const resting = entryById(r1Entry!.id);
check(resting?.state === "resolved", "the entry closes itself once the job is running again");
check(/no longer failing/i.test(resting?.decision ?? ""), "and says why (plain words)");

// ── B2. the same failure again: the SAME entry is reopened, not a second one ─
check(await failOrderAndVerify(newId, TRANSIENT_ERR), "the retried job failed again on disk");
const afterSameFail = composeQueued();
const sameJob = afterSameFail.filter((r) => r.runId === `fleet:${newId}`);
check(sameJob.length === 1, "the job failing again produces exactly ONE entry");
check(sameJob[0]?.itemId === r1Entry!.id, `the same failure reason re-uses the SAME entry id (${sameJob[0]?.itemId} vs ${r1Entry!.id})`);
enqueueRoutineRuns(afterSameFail);
const reopened = entryById(r1Entry!.id);
check(reopened?.state === "pending", "the entry is reopened for the new failure instead of a duplicate");
check(reopened?.runId === `fleet:${newId}`, `and it follows the live copy of the job (${reopened?.runId})`);
check(readManagerQueue().filter((e) => e.id === r1Entry!.id).length === 1, "and only one entry carries that job key");

// ── C. the cap: two automatic retries, then ONE prompt for the CEO ──────────
await managerQueueTick();
dump("after second automatic retry");
const secondCopy = readOrders().filter((o) => o.retriedFrom === newId);
check(secondCopy.length === 1, "the second automatic retry created one copy");
check(secondCopy[0]?.retryCount === 2, `the copy records retryCount 2 (${secondCopy[0]?.retryCount})`);
const cappedId = secondCopy[0]!.id;
await tickThroughCompose();
check(await failOrderAndVerify(cappedId, TRANSIENT_ERR), "the capped order is failed on disk");
await tickThroughCompose();
dump("after the cap");
const escalatedEntry = entryById(r1Entry!.id);
check(escalatedEntry?.state === "escalated", "past the cap the entry is escalated, not retried again");
check(escalatedEntry?.runId === `fleet:${cappedId}`, "the escalated entry names the live copy of the job");
check(readOrders().filter((o) => o.retriedFrom === cappedId).length === 0, "no third copy was minted");
const prompts = queueEscalations().filter((p) => p.runId === `fleet:${cappedId}`);
check(prompts.length === 1, `exactly ONE prompt is raised for the capped job (${prompts.length})`);
check((prompts[0]?.actions ?? []).some((a) => a.effect === "retry_order"), "the prompt can retry it anyway");
check((prompts[0]?.actions ?? []).some((a) => a.effect === "drop_order"), "the prompt can drop it");
check(/retried this 2 time/i.test(prompts[0]?.question ?? ""), "the prompt says how many retries were spent");
const shown = composeBriefing(listRunCards(), {
  seenAt: new Date(0).toISOString(),
  summary: "probe",
  model: "local",
  queueEscalations: queueEscalations(),
}).needsYou;
check(shown.some((i) => i.id === prompts[0]?.id), "the ONE escalated prompt is shown to the CEO");
check(shown.filter((i) => /^retry this (order|task) or drop it\?$/i.test(i.question ?? "")).length === 0, "no routine retry/drop prompt is shown");
await managerQueueTick();
check(queueEscalations().filter((p) => p.runId === `fleet:${cappedId}`).length === 1, "a second pass does not raise a second prompt");

// The resolver's own cap still holds (independent of the queue).
const cappedRes = await __testReissueOrders(["c1"], undefined);
check(cappedRes.created.length === 0, "past the cap the resolver creates NO new order");
check(cappedRes.capped.includes("c1"), "and reports the order as capped");
check(!!readOrders().find((o) => o.id === "c1")?.retryExhaustedAt, "the exhausted order records retryExhaustedAt durably");

// A risky prompt still reaches the CEO: a key failure is not a routine retry/drop call.
const { classifyApprovalRisk } = await import("../src/company/needsYouRule.js");
const keyRisk = classifyApprovalRisk({
  text: "The planning assistant's access key is missing.",
  question: "Add the missing access key for the Kimi assistant, then resend the order.",
  actions: [{ id: "save_key_retry", effect: "provide_key" }],
  runState: "failed",
});
check(keyRisk.risk === "risky", "a missing-key prompt is still the CEO's to answer");

// ── D. the FAIL/REDO re-check loop is capped ────────────────────────────────
const baseCard = {
  runId: "fleet:loop",
  kind: "fleet" as const,
  title: "t",
  owner: "Fleet",
  state: "failed" as const,
  headline: "h",
  done: [],
  remaining: [],
  model: "local",
  modelReason: "r",
  checkedAt: t0,
  reported: false,
  updatedAt: t0,
  ref: { kind: "fleet" as const, orderId: "loop" },
};
const theRun = { evidenceHash: "abc123", state: "failed" as const };
check(
  recheckDecision({ stored: { ...baseCard, evidenceHash: "pending:abc123" }, run: theRun, maxCheckAttempts: 2 }).check,
  "a card from a FAILED check is retried once while under the cap",
);
check(
  !recheckDecision({ stored: { ...baseCard, evidenceHash: "pending:abc123", checkAttempts: 2 }, run: theRun, maxCheckAttempts: 2 }).check,
  "at the cap the run is not re-checked (this is the 90-row loop)",
);
check(
  recheckDecision({ stored: { ...baseCard, evidenceHash: "pending:abc123", checkAttempts: 2 }, run: theRun, maxCheckAttempts: 2 }).reason ===
    "check-failed-cap(2/2)",
  "and it says why it was skipped",
);
check(
  !recheckDecision({ stored: { ...baseCard, evidenceHash: "abc123" }, run: theRun, maxCheckAttempts: 2 }).check,
  "a card the manager really wrote is never re-checked for the same evidence",
);
check(
  recheckDecision({ stored: { ...baseCard, evidenceHash: "pending:abc123", checkAttempts: 2 }, run: { evidenceHash: "different", state: "failed" }, maxCheckAttempts: 2 }).check,
  "but NEW evidence always gets a check",
);
check(
  !recheckDecision({ stored: { ...baseCard, evidenceHash: "pending:abc", checkAttempts: 0 }, run: { evidenceHash: "different", state: "failed" }, maxCheckAttempts: 2, minutesSinceChecked: 0.2, minIntervalS: 180 }).check,
  "the min-interval guard still spaces checks out",
);

// ── E. stale prompts whose root cause is fixed ──────────────────────────────
const found = await findStalePrompts();
check(found.stale.length >= 2, `the cleanup still finds the planner-failure prompts (${found.stale.length})`);
check(found.stale.every((s) => s.cause === "planner-no-plan"), "only prompts whose cause is fixed in code are selected");
const applied = applyStaleResolve(found);
check(applied.written === found.stale.length * 2, "each stale prompt is closed under its job id AND its legacy per-order id");
const after = await findStalePrompts();
check(after.stale.length === 0, `nothing is left to close (${after.stale.length})`);
check(after.alreadyClosed.length >= found.stale.length, "a re-run is a no-op: they are recorded as already closed");
// The queue honours a closure a person made: those entries stop being retried/asked.
await managerQueueTick();
const closedRuns = found.stale.map((s) => s.runId);
const stillOpen = readManagerQueue().filter((e) => closedRuns.includes(e.runId ?? "") && e.state !== "resolved");
check(stillOpen.length === 0, `the manager queue closed the prompts a person closed (${stillOpen.length} left)`);
check(
  compose().every((i) => !found.stale.some((s) => s.runId === i.runId)),
  "and nothing about them is left on the CEO's list",
);

// The retired plan errors can no longer be produced: the code paths that fixed them exist.
check(orderFailureCause({ status: "failed", error: PLANNER_ERR }) === "planner-no-plan", "the planner failure has its own stable cause");
check(
  orderFailureCause({ status: "failed", error: "Claude sign-in expired: please run claude /login", trace: [] }) === "sign-in-expired",
  "the expired sign-in has its own stable cause",
);
check(
  orderFailureCause({ status: "failed", error: TRANSIENT_ERR }) === "planning-failed",
  "a gateway connection failure is a planning failure (the cause the queue may retry)",
);
check(orderFailureCause({ status: "failed", error: SESSION_ERR }) === "session-limit", "a session limit is a cause that needs a person");

// A queue entry with nothing to act on is escalated rather than sitting forever (it must
// never raise a prompt with no actions).
writeManagerQueue([
  { id: "unknown:nothing", at: new Date().toISOString(), updatedAt: new Date().toISOString(), kind: "unknown", text: "something", stale: true, attempts: 0, state: "pending" },
]);
const orphanTick = await managerQueueTick();
check(orphanTick.escalated.includes("unknown:nothing"), "an entry with no retry path is escalated");
check(queueEscalations().every((p) => (p.actions ?? []).length > 0), "no prompt is ever raised without actions");

console.log(pass ? "\nAll RETRY-LOOP checks passed." : "\nRETRY-LOOP checks FAILED.");
process.exit(pass ? 0 : 1);
