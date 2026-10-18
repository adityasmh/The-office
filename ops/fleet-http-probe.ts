/**
 * ops/fleet-http-probe.ts - READ-ONLY HTTP probe for the fleet router.
 *
 *   npx tsx ops/fleet-http-probe.ts [--order <id>] [--tail N] [--base <url>]
 *
 * Modelled on ops/fleet-status.ts (same output shape, same argument parsing),
 * but it reads the router over HTTP instead of importing the fleet module:
 * GET /company/fleet and GET /company/fleet/orders/:id, nothing else.
 *
 * It imports nothing from the project sources, makes GET requests only, never
 * writes anything, and NEVER starts or restarts a server or any other process:
 * if the router is not running you get one line telling you so and a
 * non-zero exit code.
 */

const argv = process.argv.slice(2);
const flag = (name: string, def = ""): string => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};

const DEFAULT_BASE = "http://127.0.0.1:8787";
const base = (flag("--base", DEFAULT_BASE) || DEFAULT_BASE).replace(/\/+$/, "");
const orderId = flag("--order");
const tailLines = Number(flag("--tail", "15")) || 15;
const TIMEOUT_MS = 5000;

// Mirrors the router's fleet types: WorkOrder, FleetOrder, FleetWorkOrderView, fleetOrdersData.
type WorkOrderState = "planned" | "queued" | "starting" | "working" | "idle" | "reported" | "reviewed" | "failed";

type WorkOrderView = {
  id: string;
  title: string;
  role: string;
  owns: string[];
  state: WorkOrderState;
  sessionId?: string;
  windowPid?: number;
  verdict?: "PASS" | "REDO";
  attempts?: number;
  error?: string;
  delivery?: { how: "targeted" | "focused" | "none"; at: string; detail: string };
  review?: string;
  live: { streaming: boolean; lastActivity?: string; tail: string[] };
  reportPath: string;
};

type OrderView = {
  id: string;
  text: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  plan?: string;
  specDoc?: string;
  summary?: string;
  error?: string;
  workOrders: WorkOrderView[];
  trace: { ts: string; from: string; to: string; what: string; detail?: string }[];
};

type FleetData = {
  orders: OrderView[];
  limits: { maxSessions: number; running: number };
  watcher: { running: boolean; intervalMs: number };
};

const clip = (s: unknown, n = 70): string => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const session = (s?: string): string => (s ? s.slice(0, 40) : "(no session)");

async function getJson(route: string): Promise<{ status: number; text: string; json: unknown }> {
  const res = await fetch(`${base}${route}`, { method: "GET", signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, text, json };
}

async function main(): Promise<number> {
  let res: { status: number; text: string; json: unknown };
  try {
    res = await getJson(orderId ? `/company/fleet/orders/${encodeURIComponent(orderId)}` : "/company/fleet");
  } catch {
    // ECONNREFUSED, DNS failure, timeout: one clear line, never a stack trace.
    console.error(`fleet router not reachable at ${base} - is it running? (this probe never starts it)`);
    return 1;
  }

  if (res.status === 404 && orderId) {
    console.error(`no such fleet order: ${orderId}`);
    return 2;
  }
  if (res.status < 200 || res.status >= 300) {
    console.error(`fleet router returned HTTP ${res.status}: ${clip(res.text, 300)}`);
    return 1;
  }

  if (!orderId) {
    const data = res.json as FleetData;
    const orders = Array.isArray(data?.orders) ? data.orders : [];
    console.log(`base    : ${base}`);
    console.log(`limits  : maxSessions=${data?.limits?.maxSessions} running=${data?.limits?.running}`);
    console.log(`watcher : running=${data?.watcher?.running} interval=${data?.watcher?.intervalMs}ms`);
    console.log(`orders  : ${orders.length}`);
    for (const o of orders) {
      const wos = Array.isArray(o.workOrders) ? o.workOrders : [];
      const passed = wos.filter((w) => w.verdict === "PASS").length;
      console.log(
        `  ${o.id}  ${String(o.status).padEnd(17)} ${passed}/${wos.length} passed  ` +
          `created=${String(o.createdAt ?? "").slice(11, 19)}  "${clip(o.text)}"`,
      );
      for (const w of wos) {
        const tail = Array.isArray(w.live?.tail) ? w.live.tail : [];
        const last = tail.length ? tail[tail.length - 1] : "-";
        console.log(
          `      ${w.id.padEnd(12)} ${String(w.state).padEnd(9)} ${clip(w.verdict ?? "-", 4).padEnd(4)} ` +
            `${session(w.sessionId)}${w.live?.streaming ? " STREAMING" : ""}  last=${clip(last, 80)}`,
        );
      }
    }
    return 0;
  }

  const o = res.json as OrderView;
  const wos = Array.isArray(o?.workOrders) ? o.workOrders : [];
  console.log(`order   : ${o?.id}`);
  console.log(`status  : ${o?.status}`);
  console.log(`created : ${o?.createdAt}  updated=${o?.updatedAt}`);
  console.log(`text    : ${clip(o?.text, 200)}`);
  if (o?.error) console.log(`error   : ${clip(o.error, 300)}`);
  console.log(`plan    :\n${o?.plan ?? "(none)"}`);
  console.log(`spec doc: ${o?.specDoc ?? "(none)"}`);
  console.log(`work orders: ${wos.length}`);
  for (const w of wos) {
    console.log(`-- ${w.id} [${w.state}] ${w.verdict ?? "-"} - ${clip(w.title, 80)}`);
    console.log(
      `   session: ${w.sessionId ?? "(no session)"}${w.live?.streaming ? " STREAMING" : ""} windowPid=${w.windowPid ?? "-"}`,
    );
    if (w.delivery) console.log(`   delivery: ${w.delivery.how} - ${clip(w.delivery.detail, 200)}`);
    if (w.error) console.log(`   error: ${clip(w.error, 300)}`);
    console.log(`   report: ${w.reportPath ?? "-"}`);
    console.log(`   live tail (last ${tailLines}):`);
    const tail = Array.isArray(w.live?.tail) ? w.live.tail : [];
    for (const line of tail.slice(-tailLines)) console.log(`     | ${line}`);
  }
  return 0;
}

process.exitCode = await main();
export {};
