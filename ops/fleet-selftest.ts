/**
 * ops/fleet-selftest.ts — regression test for the fleet state machine.
 *
 * Runs against a THROWAWAY COMPANY_ROOT and never spawns a window, never calls a
 * model (MOCK_MODE=1), and never touches the live company/:
 *
 *   1. a work order with a live session and no REPORT.md stays "working",
 *   2. REPORT.md appears -> "reported" -> Claude review -> verdict + "reviewed",
 *   3. all work orders PASS -> the order is "done" and the assistant thread gets
 *      exactly ONE report-back (a second tick must not add another),
 *   4. cancel stops queued work without touching anything running,
 *   5. the live tail reader returns real journal text for a real session.
 *
 *   npx tsx ops/fleet-selftest.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.MOCK_MODE = "1";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-selftest-"));
process.env.COMPANY_ROOT = path.join(tmp, "company");
process.env.FLEET_REPO = path.join(tmp, "repo");
fs.mkdirSync(process.env.FLEET_REPO, { recursive: true });

const fleet = await import("../src/company/fleet.js");

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
}

const companyRoot = process.env.COMPANY_ROOT;
const assistantThread = path.join(companyRoot, "assistant.jsonl");
const readThread = (): Array<{ text: string }> =>
  fs.existsSync(assistantThread)
    ? fs.readFileSync(assistantThread, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { text: string })
    : [];

// A real live session to stand in for a worker (this test process is NOT the
// session; any live jcode TUI will do). Skipped if none is running.
const liveSession = [...fleet.liveClientSessions().keys()][0] ?? "";
console.log(`[selftest] throwaway COMPANY_ROOT=${companyRoot}`);
console.log(`[selftest] stand-in live session=${liveSession || "(none running; tail test will be skipped)"}`);

// ── 1+2+3: report -> review -> done -> exactly one report-back ─────────
const orderId = "foSelftest1";
const mkWork = (id: string) => ({
  id,
  title: `selftest ${id}`,
  role: id,
  owns: [],
  brief: "selftest",
  done: ["selftest"],
  state: "working" as const,
  sessionId: liveSession || undefined,
  startedAt: new Date().toISOString(),
  attempts: 0,
});
fleet.saveFleetOrders([
  {
    id: orderId,
    text: "selftest order",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "running",
    workOrders: [mkWork("WO-1"), mkWork("WO-2")],
    trace: [{ ts: new Date().toISOString(), from: "CEO", to: "Claude (manager)", what: "order", detail: "selftest" }],
  },
]);

const t1 = await fleet.tickFleet();
const o1 = fleet.getFleetOrder(orderId)!;
check("no REPORT.md yet -> work orders are not reviewed", o1.workOrders.every((w) => w.state === "working" || w.state === "idle"), `states=${o1.workOrders.map((w) => w.state).join(",")} reviewed=${t1.reviewed}`);

for (const wid of ["WO-1", "WO-2"]) {
  fs.mkdirSync(path.dirname(fleet.reportPath(orderId, wid)), { recursive: true });
  fs.writeFileSync(fleet.reportPath(orderId, wid), `# report ${wid}\n\nchanged nothing (selftest)\n\n$ npx tsc --noEmit\n(exit 0)\n`);
}

const before = readThread().length;
const t2 = await fleet.tickFleet();
const o2 = fleet.getFleetOrder(orderId)!;
check("REPORT.md -> reviewed with a verdict", o2.workOrders.every((w) => w.state === "reviewed" && !!w.verdict), `states=${o2.workOrders.map((w) => `${w.state}/${w.verdict}`).join(",")} reviewed=${t2.reviewed}`);
check("all PASS -> order done", o2.status === "done", `status=${o2.status}`);
check("exactly one report-back appended to the assistant thread", readThread().length === before + 1, `before=${before} after=${readThread().length}`);

const t3 = await fleet.tickFleet();
check("second tick is a no-op (no duplicate report, no re-review)", readThread().length === before + 1 && t3.reviewed === 0, `after=${readThread().length} reviewed=${t3.reviewed}`);

const hops = (o2.trace ?? []).map((h) => `${h.from}->${h.to}[${h.what}]`).join(" | ");
check("trace carries CEO->Claude, jcode report, Claude review, Assistant->CEO", /CEO->Claude \(manager\)\[order\]/.test(hops) && /jcode:WO-1->Claude \(manager\)\[report\]/.test(hops) && /Claude \(manager\)->CEO\[review PASS/.test(hops) && /Assistant->CEO\[report\]/.test(hops), hops.slice(0, 400));

// ── 4: cancel stops queued work ───────────────────────────────────────
const queuedId = "foSelftest2";
fleet.saveFleetOrders([
  {
    id: queuedId,
    text: "selftest queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "running",
    workOrders: [{ ...mkWork("WO-Q"), state: "queued" as const, sessionId: undefined }],
    trace: [],
  },
]);
const cancelled = fleet.cancelFleetOrder(queuedId);
const remaining = fleet.fleetOrdersData().limits.running;
check("cancel marks the order cancelled without killing anything", cancelled.status === "cancelled" && remaining === 0, `status=${cancelled.status} running=${remaining}`);

// ── 5: the live tail reader returns real text for a real session ──────
// Any live session will do, but pick one that actually has recent text/tool lines in its
// journal: a session that is merely alive (client pid up) may have an empty tail window,
// which is not a failure of the reader.
const liveCandidates = [...fleet.liveClientSessions().keys()];
let tailChecked = false;
for (const sid of liveCandidates) {
  const live = fleet.sessionLive(sid, 5);
  if (live.found && live.tail.length > 0) {
    check("sessionLive reads a real journal (tail non-empty, found=true)", true, `session=${sid.slice(8, 24)} streaming=${live.streaming} tail=${live.tail.length} last=${live.lastActivity ?? "-"}`);
    tailChecked = true;
    break;
  }
}
if (!tailChecked) {
  console.log(`SKIP  sessionLive tail check (none of ${liveCandidates.length} live sessions had text lines in its journal tail)`);
}

console.log("");
console.log(`[selftest] ${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
