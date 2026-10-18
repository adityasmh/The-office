/**
 * ops/fleet-requeue-review.ts — put REPORTED work orders whose review failed for
 * INFRASTRUCTURE reasons back in the review queue.
 *
 * Measured need (21:38Z, order fomumvtp5p): two work orders reported, then their review failed
 * 3x with a raw Claude 429 because NO WATCHER WAS ALIVE at the time (the driver had exited and
 * the live router's watcher was dead). Their reports were fine and on disk. This clears the
 * failure and resets reviewAttempts so the next tick reviews them again, and writes a trace hop
 * saying exactly why - a reviewer must be able to tell "the work failed" from "nobody looked".
 *
 * It does NOT invent a verdict: it only requeues.
 *
 *   npx tsx ops/fleet-requeue-review.ts --order fomumvtp5p [--wid TOOLCHAIN]
 */
import "dotenv/config";
import { getFleetOrder, loadFleetOrders, pushOrderTrace, reportPath, saveFleetOrders } from "../src/company/fleet.js";
import fs from "node:fs";

const argv = process.argv.slice(2);
const flag = (n: string, d = ""): string => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const orderId = flag("--order");
const onlyWid = flag("--wid");
if (!orderId) {
  console.error("usage: npx tsx ops/fleet-requeue-review.ts --order <id> [--wid <wid>]");
  process.exit(2);
}

const orders = loadFleetOrders();
const order = orders.find((o) => o.id === orderId);
if (!order) {
  console.error(`no such order: ${orderId}`);
  process.exit(2);
}

const requeued: string[] = [];
const skipped: string[] = [];
for (const w of order.workOrders) {
  if (onlyWid && w.id !== onlyWid) continue;
  const hasReport = fs.existsSync(reportPath(order.id, w.id));
  if (!hasReport) {
    skipped.push(`${w.id} (no REPORT.md)`);
    continue;
  }
  if (w.state === "reviewed") {
    skipped.push(`${w.id} (already reviewed)`);
    continue;
  }
  const was = w.state;
  w.state = "reported";
  w.error = undefined;
  w.verdict = undefined;
  w.reviewAttempts = 0;
  // Clear the retry clock too, otherwise a spaced-out retry would refuse to run for a minute
  // after a manual requeue and look like another stall.
  w.lastReviewAttemptAt = undefined;
  requeued.push(`${w.id} (was ${was})`);
  pushOrderTrace(order, {
    from: "Claude (manager)",
    to: "Claude (manager)",
    what: "review requeued",
    detail: `${w.id}: the report was on disk but the review never ran (no watcher was alive when it should have). Requeued, not re-worked.`,
  });
}
if (requeued.length) {
  order.status = "running";
  order.error = undefined;
  saveFleetOrders(orders);
}
const after = getFleetOrder(orderId)!;
console.log(`[requeue] ${after.id} status=${after.status}`);
console.log(`  requeued: ${requeued.join(", ") || "(none)"}`);
console.log(`  skipped : ${skipped.join(", ") || "(none)"}`);
