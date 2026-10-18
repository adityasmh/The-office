/**
 * ops/fleet-write-plan.ts — write a plan/approve payload by HAND into an existing order.
 *
 * Why this exists: the CEO ordered work while Claude was rate-limited, so the fleet planned it
 * with the Kimi fallback (working, see the 21:15 entry). Kimi's plan was usable but it reached
 * into `src/` - files a peer group is editing right now - so the manager (me) rewrote the plan
 * to stay inside this order's own `owns` list instead of letting workers collide with peers.
 * That is a normal manager action and this is the explicit tool for it, rather than hand-editing
 * orders.json.
 *
 *   npx tsx ops/fleet-write-plan.ts --order <id> --file plan.json [--approve]
 *
 * `plan.json` shape (all fields optional except workOrders):
 *   { "plan": "markdown", "specDoc": null,
 *     "workOrders": [{ "id":"A","title":"...","role":"A","owns":["path"],"brief":"...","done":["..."] }] }
 *
 * With --approve it also marks the order approved/running; the spawn itself is done by
 * `ops/fleet-run.ts --spawn-order <id>` (which is the CEO-ordered bypass path).
 */
import "dotenv/config";
import fs from "node:fs";
import { loadFleetOrders, saveFleetOrders, getFleetOrder, pushOrderTrace } from "../src/company/fleet.js";

const argv = process.argv.slice(2);
const flag = (name: string, def = ""): string => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};

const orderId = flag("--order");
const file = flag("--file");
const approve = argv.includes("--approve");
if (!orderId || !file) {
  console.error('usage: npx tsx ops/fleet-write-plan.ts --order <id> --file plan.json [--approve]');
  process.exit(2);
}

type PlanFile = {
  plan?: string;
  specDoc?: string | null;
  workOrders: Array<{ id: string; title: string; role?: string; owns?: string[]; brief: string; done?: string[] }>;
};
const incoming = JSON.parse(fs.readFileSync(file, "utf8")) as PlanFile;
if (!Array.isArray(incoming.workOrders) || !incoming.workOrders.length) {
  console.error("plan.json needs a non-empty workOrders array");
  process.exit(2);
}

const orders = loadFleetOrders();
const order = orders.find((o) => o.id === orderId);
if (!order) {
  console.error(`no such fleet order: ${orderId}`);
  process.exit(2);
}

order.plan = incoming.plan ?? order.plan ?? "(plan written by the manager)";
if (incoming.specDoc === null) order.specDoc = undefined;
else if (typeof incoming.specDoc === "string") order.specDoc = incoming.specDoc;

order.workOrders = incoming.workOrders.map((w) => ({
  id: w.id,
  title: w.title,
  role: w.role ?? w.id,
  owns: w.owns ?? [],
  brief: w.brief,
  done: (w.done ?? ["The brief is satisfied."]).slice(),
  state: "planned" as const,
  attempts: 0,
}));

pushOrderTrace(order, {
  from: "CEO",
  to: "Claude (manager)",
  what: "plan rewritten by the manager",
  detail: `${order.workOrders.length} work orders written by hand (Claude rate-limited; keeping workers inside this order's owns)`,
});
if (approve) {
  order.status = "running";
  pushOrderTrace(order, { from: "CEO", to: "Claude (manager)", what: "approve", detail: "approved so the CEO-ordered spawn can start" });
} else if (order.status === "planning" || order.status === "failed") {
  order.status = "awaiting_approval";
}
order.error = undefined;
order.plannerPid = undefined;
order.planAttempts = 0;

saveFleetOrders(orders);
const after = getFleetOrder(orderId)!;
console.log(`[write-plan] ${after.id} status=${after.status} workOrders=${after.workOrders.length}`);
for (const w of after.workOrders) console.log(`  ${w.id.padEnd(16)} owns=${w.owns.join(", ")}`);
