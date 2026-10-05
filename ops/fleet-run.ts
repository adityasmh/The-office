/**
 * ops/fleet-run.ts — drive the fleet end to end WITHOUT the dashboard.
 *
 * This runs the exact same code the /company/fleet routes call
 * (createFleetOrder -> plan -> approve -> fillSlots -> watcher -> Claude review),
 * so it can prove a real order with visible worker terminals while the router on
 * :8787 is untouched (this script starts no server, and never restarts one).
 *
 *   npx tsx ops/fleet-run.ts --text "add a README section and a comment in X" --auto-approve
 *   npx tsx ops/fleet-run.ts --text "..."                 # stops at awaiting_approval
 *   npx tsx ops/fleet-run.ts --approve foXXXX             # approve a parked plan, then watch
 *   npx tsx ops/fleet-run.ts --watch foXXXX               # just watch an existing order
 *   npx tsx ops/fleet-run.ts --redo foXXXX:WO-A
 *   npx tsx ops/fleet-run.ts --cancel foXXXX
 *
 * Flags: --auto-approve  --timeout <seconds> (default 900)  --mock (MOCK_MODE=1)
 *        --force (allow a second watcher; normally refuses)  --max N (override the cap)
 *        --spawn-order <orderId>  /  --spawn-order <orderId>/<workOrderId>
 *
 * `--spawn-order` bypasses the watcher's slot/budget QUEUE for work the CEO has directly
 * ordered (e.g. "spawn a session and do X"). It still respects the machine's terminal cap
 * unless you also pass --max, it never bypasses the budget MODEL filter, and it records the
 * override in the trace - the bypass is visible, not silent.
 *
 * NOTE: `import "dotenv/config"` is REQUIRED here and was missing at first: `config` reads
 * process.env at import time, so without it .env looked empty and every gateway/Claude call
 * 401'd (measured 21:14Z: the planner's Kimi fallback failed with "Missing API key").
 */
import "dotenv/config";
process.env.SLACK_BRIDGE = "0";

const argv = process.argv.slice(2);
const flag = (name: string, def = ""): string => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const has = (name: string): boolean => argv.includes(name);

const text = flag("--text");
const approveId = flag("--approve");
const watchId = flag("--watch");
const redoArg = flag("--redo");
const cancelId = flag("--cancel");
const spawnOrderArg = flag("--spawn-order");
const maxOverride = Number(flag("--max", "")) || 0;
if (maxOverride > 0) process.env.MAX_PARALLEL_SESSIONS = String(maxOverride);
const autoApprove = has("--auto-approve");
const timeoutSec = Number(flag("--timeout", "900")) || 900;
if (has("--mock")) process.env.MOCK_MODE = "1";
if (has("--force")) process.env.FLEET_FORCE = "1";

if (!text && !approveId && !watchId && !redoArg && !cancelId && !spawnOrderArg) {
  console.error(
    "usage: tsx ops/fleet-run.ts --text \"<order>\" [--auto-approve] [--timeout 900] [--mock]\n" +
      "       tsx ops/fleet-run.ts --approve <orderId> [--timeout 900]\n" +
      "       tsx ops/fleet-run.ts --watch <orderId>\n" +
      "       tsx ops/fleet-run.ts --redo <orderId>:<workOrderId>\n" +
      "       tsx ops/fleet-run.ts --cancel <orderId>\n" +
      "       tsx ops/fleet-run.ts --spawn-order <orderId>[/<wid>] [--max N]",
  );
  process.exit(2);
}

const fleet = await import("../src/company/fleet.js");

// --cancel does not need a watcher.
if (cancelId) {
  const cancelled = fleet.cancelFleetOrder(cancelId);
  console.log(`[fleet-run] cancelled ${cancelled.id}: status=${cancelled.status} (running terminals were left alone)`);
  process.exit(0);
}

// --spawn-order <orderId>[/<wid>]: spawn CEO-ordered work directly, bypassing only the QUEUE.
if (spawnOrderArg) {
  const [orderId, wid] = spawnOrderArg.split("/");
  const res = await fleet.spawnOrderNow(orderId, wid);
  console.log(`[fleet-run] spawn-order ${orderId}${wid ? `/${wid}` : ""}: ${JSON.stringify(res)}`);
  process.exit(res.started.length ? 0 : 1);
}

const status = fleet.startFleetWatcher();
console.log(`[fleet-run] watcher: running=${status.running} interval=${status.intervalMs}ms`);
if (!status.running) {
  console.error("[fleet-run] another fleet watcher is live (see company/fleet/WATCHER.json). Stop it or use --force.");
  process.exit(3);
}

let orderId = approveId || watchId;
if (redoArg) {
  const [id, wid] = redoArg.split(":");
  if (!id || !wid) {
    console.error("usage: --redo <orderId>:<workOrderId>");
    process.exit(2);
  }
  const redone = await fleet.redoWorkOrder(id, wid);
  orderId = id;
  console.log(`[fleet-run] redo queued for ${id}/${wid} (attempt ${redone.workOrders.find((w) => w.id === wid)?.attempts})`);
} else if (approveId) {
  const approved = await fleet.approveFleetOrder(approveId, {});
  console.log(`[fleet-run] approved ${approved.id}: ${approved.workOrders.length} work order(s), status=${approved.status}`);
} else if (text) {
  const created = await fleet.createFleetOrder(text, { autoApprove });
  orderId = created.id;
  console.log(`[fleet-run] order ${created.id} created (status=${created.status}, autoApprove=${autoApprove})`);
  console.log(`[fleet-run] plan: ${text}`);
}

const TERMINAL = ["done", "failed", "cancelled"];
/** states in which a work order is still active, so the driver must keep its watcher alive */
const RUNNING_STATES_FOR_DRIVER = ["starting", "working", "idle", "reported", "queued"];
const deadline = Date.now() + timeoutSec * 1000;
let lastLine = "";
for (;;) {
  const order = orderId ? fleet.getFleetOrder(orderId) : undefined;
  if (!order) {
    console.error(`[fleet-run] order ${orderId} disappeared`);
    break;
  }
  const wos = order.workOrders;
  const counts = new Map<string, number>();
  for (const w of wos) counts.set(w.state, (counts.get(w.state) ?? 0) + 1);
  const line =
    `${order.id} ${order.status}  ` +
    (wos.length
      ? wos.map((w) => `${w.id}:${w.state}${w.sessionId ? `@${w.sessionId.slice(8, 24)}` : ""}${w.verdict ? `(${w.verdict})` : ""}`).join(" ")
      : "(no plan yet)");
  if (line !== lastLine) {
    console.log(`[fleet-run] [${new Date().toISOString().slice(11, 19)}] ${line}`);
    lastLine = line;
  }

  const settled =
    TERMINAL.includes(order.status) ||
    // "reviewing" and "awaiting_approval" are stopping states for THIS driver, but only once
    // nothing is still running: exiting while a work order is still working leaves the order
    // without any watcher at all (measured 21:38: order fomumvtp5p/SPEAK-API's report sat
    // unreviewed because the driver had exited and the live router's watcher was dead, and the
    // review attempts that did happen were spread over ~16 minutes instead of minutes).
    ((order.status === "reviewing" || order.status === "awaiting_approval") &&
      !order.workOrders.some((w) => RUNNING_STATES_FOR_DRIVER.includes(w.state)));
  if (settled) {
    console.log("");
    console.log(`[fleet-run] STOP: status=${order.status}${order.error ? ` error=${order.error}` : ""}`);
    console.log(`[fleet-run] plan:\n${(order.plan ?? "").split("\n").map((l) => `  ${l}`).join("\n")}`);
    for (const w of wos) {
      console.log(
        `[fleet-run] work order ${w.id} state=${w.state} verdict=${w.verdict ?? "-"} attempts=${w.attempts}` +
          `${w.sessionId ? ` session=${w.sessionId}` : ""}${w.windowPid ? ` pid=${w.windowPid}` : ""}`,
      );
      console.log(`           title: ${w.title}`);
      console.log(`           owns:  ${w.owns.join(", ") || "(none)"}`);
      if (w.delivery) console.log(`           delivery: ${w.delivery.how} (${w.delivery.detail.slice(0, 200)})`);
      if (w.review) console.log(`           review: ${w.review.replace(/\s+/g, " ").slice(0, 300)}`);
      if (w.error) console.log(`           error: ${w.error}`);
      console.log(`           report: ${fleet.reportPath(order.id, w.id)}`);
    }
    console.log(`[fleet-run] trace (${order.trace.length} hops):`);
    for (const t of order.trace) console.log(`  ${t.ts.slice(11, 19)} ${t.from} -> ${t.to} [${t.what}] ${(t.detail ?? "").slice(0, 140)}`);
    console.log(`[fleet-run] orders.json: ${fleet.fleetRoot()}\\orders.json`);
    fleet.stopFleetWatcher();
    // 0 = done, 0 also for a normal non-terminal stop (awaiting approval / reviewing),
    // 1 = failed/cancelled, 4 = timeout.
    process.exit(order.status === "failed" || order.status === "cancelled" ? 1 : 0);
  }

  if (Date.now() > deadline) {
    console.log(`[fleet-run] TIMEOUT after ${timeoutSec}s; last state: ${line}`);
    fleet.stopFleetWatcher();
    process.exit(4);
  }
  await new Promise((r) => setTimeout(r, 3000));
}
