/**
 * ops/fleet-status.ts — read-only view of the fleet (what the dashboard shows).
 *
 *   npx tsx ops/fleet-status.ts                     # every order, one line each
 *   npx tsx ops/fleet-status.ts --order foXXXX      # full detail + live tails
 *   npx tsx ops/fleet-status.ts --order foXXXX --tail 20
 *
 * Prints exactly the payload GET /company/fleet and GET /company/fleet/orders/:id
 * return, so a UI bug can be told apart from a backend bug without a browser.
 */
const argv = process.argv.slice(2);
const flag = (name: string, def = ""): string => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};

const orderId = flag("--order");
const tailLines = Number(flag("--tail", "15")) || 15;

const fleet = await import("../src/company/fleet.js");

if (!orderId) {
  const data = fleet.fleetOrdersData();
  console.log(`fleet root : ${fleet.fleetRoot()}`);
  console.log(`limits     : maxSessions=${data.limits.maxSessions} running=${data.limits.running}`);
  console.log(`watcher    : running=${data.watcher.running} interval=${data.watcher.intervalMs}ms`);
  console.log(`orders     : ${data.orders.length}`);
  for (const o of data.orders) {
    const passed = o.workOrders.filter((w) => w.verdict === "PASS").length;
    console.log(
      `  ${o.id}  ${o.status.padEnd(17)} ${String(passed)}/${o.workOrders.length} passed  ` +
        `created=${o.createdAt.slice(11, 19)}  "${o.text.replace(/\s+/g, " ").slice(0, 70)}"`,
    );
    for (const w of o.workOrders) {
      console.log(
        `      ${w.id.padEnd(12)} ${w.state.padEnd(9)} ${w.verdict ?? "-"}  ` +
          `${w.sessionId ? w.sessionId.slice(0, 40) : "(no session)"}` +
          `${w.live.streaming ? " STREAMING" : ""}  last=${(w.live.lastActivity ?? "-").slice(11, 19)}`,
      );
    }
  }
  process.exit(0);
}

const detail = fleet.fleetOrderDetail(orderId);
if (!detail) {
  console.error(`no such fleet order: ${orderId}`);
  process.exit(2);
}
console.log(JSON.stringify({ ...detail, workOrders: detail.workOrders.map((w) => ({ ...w, live: { streaming: w.live.streaming, lastActivity: w.live.lastActivity } })) }, null, 2));
console.log("");
console.log(`plan:\n${detail.plan ?? "(none)"}`);
if (detail.specDoc) console.log(`\nspec doc: ${detail.specDoc}`);
console.log("");
for (const w of detail.workOrders) {
  console.log(`── ${w.id} [${w.state}] ${w.verdict ?? "-"} — ${w.title}`);
  console.log(`   role=${w.role} owns=${w.owns.join(", ") || "(none)"} attempts=${w.attempts}`);
  console.log(`   session=${w.sessionId ?? "(none)"} windowPid=${w.windowPid ?? "-"} streaming=${w.live.streaming} lastActivity=${w.live.lastActivity ?? "-"}`);
  if (w.delivery) console.log(`   delivery: ${w.delivery.how} — ${w.delivery.detail}`);
  if (w.error) console.log(`   error: ${w.error}`);
  console.log(`   report: ${w.reportPath}`);
  console.log(`   live tail (last ${tailLines}):`);
  for (const line of w.live.tail.slice(-tailLines)) console.log(`     | ${line}`);
  if (w.review) console.log(`   review: ${w.review.replace(/\s+/g, " ").slice(0, 400)}`);
}
console.log("");
console.log(`trace (${detail.trace.length} hops):`);
for (const t of detail.trace) console.log(`  ${t.ts.slice(11, 19)} ${t.from} -> ${t.to} [${t.what}] ${(t.detail ?? "").slice(0, 160)}`);
