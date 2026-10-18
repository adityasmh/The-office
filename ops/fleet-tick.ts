/**
 * ops/fleet-tick.ts — run exactly ONE watcher pass and print what it did.
 *
 * Useful when a review will not run: `ops/fleet-run.ts --watch` also STARTS a watcher (and its
 * 5 s interval competes with the pass you are watching), which makes a single tick's behaviour
 * hard to read. This calls tickFleet() once, prints the counts, and then prints every work order
 * of the given order with its review bookkeeping.
 *
 *   npx tsx ops/fleet-tick.ts --order fomumvtp5p
 */
import "dotenv/config";
import { getFleetOrder, tickFleet } from "../src/company/fleet.js";

const argv = process.argv.slice(2);
const i = argv.indexOf("--order");
const orderId = i >= 0 ? argv[i + 1] : "";

console.log("[tick] running one fleet pass (no watcher interval)...");
const t = Date.now();
const res = await tickFleet();
console.log(`[tick] ${Date.now() - t}ms advanced=${res.advanced} reviewed=${res.reviewed} orders=${res.orders}`);

if (orderId) {
  const o = getFleetOrder(orderId);
  if (!o) {
    console.log(`[tick] no such order: ${orderId}`);
  } else {
    console.log(`[tick] ${o.id} status=${o.status}${o.error ? ` error=${o.error}` : ""}`);
    for (const w of o.workOrders) {
      console.log(
        `[tick]   ${w.id.padEnd(12)} state=${w.state.padEnd(8)} verdict=${(w.verdict ?? "-").padEnd(4)} ` +
          `reviewAttempts=${w.reviewAttempts ?? 0} lastReviewAttemptAt=${w.lastReviewAttemptAt ?? "-"}` +
          `${w.error ? ` error=${w.error.slice(0, 120)}` : ""}`,
      );
    }
    const recent = (o.trace ?? []).slice(-6);
    console.log("[tick] last hops:");
    for (const h of recent) console.log(`[tick]   ${h.ts.slice(11, 19)} ${h.from} -> ${h.to} [${h.what}] ${String(h.detail ?? "").slice(0, 130)}`);
  }
}
