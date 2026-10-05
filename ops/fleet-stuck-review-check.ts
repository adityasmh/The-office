/**
 * ops/fleet-stuck-review-check.ts — why an order sat in `reviewing` after its work was done.
 *
 * Measured (17:13 local, docs/ORDER_2026-10-01_stuck-reviews.md): two orders were stuck in
 * `reviewing`.
 *   - fomupe3jzs (PERF-SESS): last trace was `review PASS` (PERF-PANEL), so the manager read it
 *     as "all work orders PASSed but the order never settled". The data says otherwise: one
 *     work order is `reviewed` with verdict REDO and its REPORT.md was never reworked, so the
 *     order is waiting on the CEO's Redo/Leave answer BY DESIGN (`settleOrder`).
 *   - fomupdu81a (WO1): reviewed with verdict REDO at 10:51:02Z, the worker then reworked
 *     src/company/airGap.ts and rewrote REPORT.md at 10:57:38Z — and the fleet never looked
 *     again, because `tickFleet`'s re-report detection requires `wo.state !== "reviewed"`.
 *     A finished rework was invisible: that is the defect this file pins down.
 *
 * This drives the real exported `tickFleet()` against a throwaway COMPANY_ROOT/FLEET_REPO with
 * four fixtures that mirror those states:
 *   A  foStuckRedo    reviewed + REDO, REPORT.md REWRITTEN after the review  -> must be re-reviewed and settle
 *   B  foWaitingRedo  reviewed + REDO, REPORT.md untouched since the review  -> must NOT be re-reviewed (CEO's call)
 *   C  foSettleOnly   all reviewed + PASS, order still `reviewing`          -> must settle to `done` (the settle step does run)
 *   D  foPassRework   reviewed + PASS, REPORT.md rewritten afterwards        -> must NOT be re-reviewed
 *
 * MOCK_MODE=1: the point is the fleet's state machine, not the reviewer, so the mock verdict
 * (PASS) makes "was this report looked at again?" observable without calling a model.
 *
 *   npx tsx ops/fleet-stuck-review-check.ts
 */
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-stuck-review-"));
process.env.COMPANY_ROOT = path.join(tmp, "company");
process.env.FLEET_REPO = path.join(tmp, "repo");
process.env.MOCK_MODE = "1"; // deterministic verdicts; the defect is in tickFleet, not the reviewer
process.env.FLEET_AUTO_APPROVE = "0";
process.env.FLEET_WATCH_INTERVAL_MS = "600000";

const companyRoot = process.env.COMPANY_ROOT;
const repo = process.env.FLEET_REPO;
fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
fs.mkdirSync(path.join(companyRoot, "fleet"), { recursive: true });

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
};

const fleet = await import("../src/company/fleet.js");

// ── the real timestamps of fomupdu81a/WO1, reused so the trace reads like the incident ──────
const REDO_AT = "2026-10-01T10:51:02.788Z";        // review REDO trace
const REVIEWED_AT = "2026-10-01T10:50:36.705Z";    // lastReviewAttemptAt (when the review ran)
const REWORK_AT = "2026-10-01T10:57:38.535Z";      // REPORT.md rewritten by the worker, alone
const UNTOUCHED_AT = "2026-10-01T10:50:30.000Z";   // report older than the review

const WO_DONE = ["the deliverable exists", "the report carries real command output"];

function mkOrder(id: string, wo: Record<string, unknown>, verdictDetail: string): Record<string, unknown> {
  return {
    id,
    text: "GOAL: (fixture) reproduce a fleet order stuck in reviewing.",
    createdAt: "2026-10-01T10:19:39.694Z",
    updatedAt: REDO_AT,
    status: "reviewing",
    plan: "one work order",
    workOrders: [wo],
    trace: [
      { ts: "2026-10-01T10:19:39.694Z", from: "CEO", to: "Claude (manager)", what: "order", detail: "GOAL: fixture" },
      { ts: "2026-10-01T10:50:36.695Z", from: "jcode:WO1", to: "Claude (manager)", what: "report", detail: "REPORT.md written" },
      { ts: REDO_AT, from: "Claude (manager)", to: "CEO", what: `review ${wo.verdict}`, detail: verdictDetail },
    ],
  };
}

type Fixture = {
  orderId: string;
  wid: string;
  wo: Record<string, unknown>;
  report: string;
  reportMtime: string;
};

const fixtures: Fixture[] = [
  {
    // A — fomupdu81a/WO1: the worker reworked on its own after the REDO.
    orderId: "foStuckRedo",
    wid: "WO1",
    wo: {
      id: "WO1",
      title: "Air-gapped mode (reworked after a REDO)",
      role: "code",
      owns: ["src/company/airGap.ts"],
      brief: "Add AIR_GAPPED=1 with zero outbound calls.",
      done: WO_DONE,
      state: "reviewed",
      attempts: 0,
      reportedAt: REVIEWED_AT,
      lastReviewAttemptAt: REVIEWED_AT,
      verdict: "REDO",
      review: "1. The held queue silently drops work (MAX_HELD=5). 2. ... 3. ...",
      sessionId: "session_koala_dead",
    },
    report: "# REPORT\nReworked 10:57Z: the held queue now keeps every row and flags the overflow.\n",
    reportMtime: REWORK_AT,
  },
  {
    // B — fomupe3jzs/PERF-SESS: REDO open, deliverable untouched -> the CEO's Redo/Leave question.
    orderId: "foWaitingRedo",
    wid: "PERF-SESS",
    wo: {
      id: "PERF-SESS",
      title: "Sessions tail split (REDO open, nothing reworked)",
      role: "code",
      owns: ["src/company/sessions.ts"],
      brief: "Spec items 3 and 6.",
      done: WO_DONE,
      state: "reviewed",
      attempts: 0,
      reportedAt: REVIEWED_AT,
      lastReviewAttemptAt: REVIEWED_AT,
      verdict: "REDO",
      review: "One acceptance check fails: the report gives no line evidence. No code changes are needed. Update REPORT.md only.",
      sessionId: "session_otter_dead",
    },
    report: "# REPORT\nThe code is already implemented; measurements pasted below.\n",
    reportMtime: UNTOUCHED_AT,
  },
  {
    // C — "all work orders reviewed but the settle step never runs": the hypothesis to kill.
    orderId: "foSettleOnly",
    wid: "PERF-PANEL",
    wo: {
      id: "PERF-PANEL",
      title: "Panel caches audit (all PASS, order still reviewing)",
      role: "code",
      owns: ["src/company/panel.ts"],
      brief: "Audit the panel caches.",
      done: WO_DONE,
      state: "reviewed",
      attempts: 0,
      reportedAt: REVIEWED_AT,
      lastReviewAttemptAt: REVIEWED_AT,
      verdict: "PASS",
      review: "Complete and all acceptance checks are addressed.",
      sessionId: "session_mouse_dead",
    },
    report: "# REPORT\nBEFORE/AFTER tables pasted.\n",
    reportMtime: UNTOUCHED_AT,
  },
  {
    // D — guard: a PASSed work order must never be dragged back for re-review.
    orderId: "foPassRework",
    wid: "WO1",
    wo: {
      id: "WO1",
      title: "PASSed work whose report was touched later",
      role: "docs",
      owns: ["docs/perf/NOTE.md"],
      brief: "Write the note.",
      done: WO_DONE,
      state: "reviewed",
      attempts: 0,
      reportedAt: REVIEWED_AT,
      lastReviewAttemptAt: REVIEWED_AT,
      verdict: "PASS",
      review: "Passed.",
      sessionId: "session_koala_dead",
    },
    report: "# REPORT\nPassed, then someone appended a line.\n",
    reportMtime: REWORK_AT,
  },
];

for (const f of fixtures) {
  const dir = path.join(companyRoot, "fleet", f.orderId, f.wid);
  fs.mkdirSync(dir, { recursive: true });
  const rp = path.join(dir, "REPORT.md");
  fs.writeFileSync(rp, f.report);
  // Deterministic mtimes: the whole point is "was the report newer than our last look?".
  const mtime = new Date(f.reportMtime);
  fs.utimesSync(rp, mtime, mtime);
}
fs.writeFileSync(
  path.join(companyRoot, "fleet", "orders.json"),
  JSON.stringify(fixtures.map((f) => mkOrder(f.orderId, f.wo, String(f.wo.review ?? ""))), null, 2),
);

// Only hops the TICK added count: the fixtures already carry their own `review REDO/PASS` hop,
// so "was this report looked at again?" is measured from the trace length before the pass.
const traceOf = (id: string) => (fleet.getFleetOrder(id)?.trace ?? []) as Array<{ what?: string }>;
const ids = fixtures.map((f) => f.orderId);
const before = new Map(ids.map((id) => [id, traceOf(id).length]));
const newReviewHops = (id: string) =>
  traceOf(id)
    .slice(before.get(id) ?? 0)
    .filter((t) => String(t.what ?? "").startsWith("review ")).length;

console.log(`[stuck-review] before: ${fixtures.map((f) => `${f.orderId} ${fleet.getFleetOrder(f.orderId)!.status}/${fleet.getFleetOrder(f.orderId)!.workOrders[0]!.state}:${fleet.getFleetOrder(f.orderId)!.workOrders[0]!.verdict}`).join("  ")}`);
console.log("[stuck-review] driving the SHIPPED tickFleet() once");
const res = await fleet.tickFleet();
console.log(`[stuck-review] tickFleet -> ${JSON.stringify(res)}`);

const get = (id: string) => fleet.getFleetOrder(id)!;
const wo = (id: string) => get(id).workOrders[0]!;

// A — the defect: a reworked deliverable must be looked at again, and then the order settles.
check(
  "A: the reworked REPORT.md was re-reviewed (`reviewed` -> new verdict)",
  newReviewHops("foStuckRedo") > 0 && wo("foStuckRedo").verdict === "PASS",
  `status=${get("foStuckRedo").status} state=${wo("foStuckRedo").state} verdict=${wo("foStuckRedo").verdict} newReviewHops=${newReviewHops("foStuckRedo")}`,
);
check(
  "A: ... and the order settled to `done` once every work order PASSed",
  get("foStuckRedo").status === "done",
  `status=${get("foStuckRedo").status}`,
);

// B — the manager's fomupe3jzs: nothing was reworked, so the REDO question stands (CEO's call).
check(
  "B: an untouched REDO'd report is NOT re-reviewed (no review spam)",
  newReviewHops("foWaitingRedo") === 0 && wo("foWaitingRedo").verdict === "REDO",
  `state=${wo("foWaitingRedo").state} verdict=${wo("foWaitingRedo").verdict} newReviewHops=${newReviewHops("foWaitingRedo")}`,
);
check(
  "B: ... and the order stays `reviewing` (settle runs; it is waiting for the CEO)",
  get("foWaitingRedo").status === "reviewing",
  `status=${get("foWaitingRedo").status}`,
);

// C — the settle step DOES run for an all-reviewed order; that was never the bug.
check(
  "C: an all-PASS order still in `reviewing` settles to `done` on the next tick",
  get("foSettleOnly").status === "done",
  `status=${get("foSettleOnly").status} verdict=${wo("foSettleOnly").verdict}`,
);

// D — a PASS is never re-opened, even if its report file is touched later.
check(
  "D: a PASSed work order is not re-reviewed when its report is touched later",
  newReviewHops("foPassRework") === 0 && wo("foPassRework").verdict === "PASS",
  `verdict=${wo("foPassRework").verdict} newReviewHops=${newReviewHops("foPassRework")}`,
);

console.log("\n[stuck-review] trace of A:");
for (const t of traceOf("foStuckRedo").slice(-4)) console.log(`   ${JSON.stringify(t).slice(0, 200)}`);

console.log(`\n[stuck-review] ${failures ? `${failures} FAILED` : "ALL CHECKS PASSED"} (temp dir ${tmp})`);
process.exit(failures ? 1 : 0);
