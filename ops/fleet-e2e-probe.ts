/**
 * ops/fleet-e2e-probe.ts - READ-ONLY HTTP probe of the live fleet router.
 *
 *   npx tsx ops/fleet-e2e-probe.ts                      # GET /company/fleet (all orders)
 *   npx tsx ops/fleet-e2e-probe.ts --order <id>         # GET /company/fleet/orders/<id>
 *   npx tsx ops/fleet-e2e-probe.ts --order <id> --tail 20
 *   npx tsx ops/fleet-e2e-probe.ts --base http://127.0.0.1:8787
 *
 * Base URL: --base, else $FLEET_PROBE_BASE, else http://127.0.0.1:8787 (the live
 * router, started by ops/start-company.ps1).
 *
 * This probe talks to a RUNNING router over HTTP only. It issues GET requests and
 * nothing else, imports nothing from src/company/fleet.ts, writes no files, and
 * contains no code that starts, spawns or restarts a server.
 *
 * Auth: loopback GETs need no token. If COMPANY_TOKEN / COMPANY_AUTH_TOKEN is set
 * it is sent as x-company-token (never printed) so the probe also works against a
 * token-guarded instance.
 *
 * Exit codes: 0 ok, 1 unexpected HTTP status or non-JSON body, 2 router not
 * reachable, 3 unknown --order id.
 */

const argv = process.argv.slice(2);
const flag = (name: string, def = ""): string => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};

const DEFAULT_BASE = "http://127.0.0.1:8787";
const base = (flag("--base") || process.env.FLEET_PROBE_BASE || DEFAULT_BASE).replace(/\/+$/, "");
const orderId = flag("--order");
const tailLines = Number(flag("--tail", "15")) || 15;
const TIMEOUT_MS = 5000;
// Token value is read but never echoed anywhere in this file's output.
const token = (process.env.COMPANY_TOKEN || process.env.COMPANY_AUTH_TOKEN || "").trim();

const clip = (s: unknown, n = 70): string => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const session = (s?: string): string => (s ? String(s).slice(0, 40) : "(no session)");
const hhmmss = (s?: string): string => (s && s.length >= 19 ? s.slice(11, 19) : (s ?? "-"));
const asArray = (v: unknown): Record<string, any>[] => (Array.isArray(v) ? (v as Record<string, any>[]) : []);

type Result = { status: number; text: string; json?: Record<string, any> };

async function getJson(route: string): Promise<Result> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) headers["x-company-token"] = token;
  try {
    const res = await fetch(`${base}${route}`, { method: "GET", headers, signal: ac.signal });
    const text = await res.text();
    let json: Record<string, any> | undefined;
    try {
      json = JSON.parse(text) as Record<string, any>;
    } catch {
      json = undefined;
    }
    return { status: res.status, text, json };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<number> {
  let res: Result;
  try {
    res = await getJson(orderId ? `/company/fleet/orders/${encodeURIComponent(orderId)}` : "/company/fleet");
  } catch (e) {
    const reason =
      (e as Error)?.name === "AbortError"
        ? `timed out after ${TIMEOUT_MS}ms`
        : String((e as Error)?.cause ?? (e as Error)?.message ?? e);
    console.error(
      `fleet router not reachable at ${base} (${reason}). The router is not running or not listening; ` +
        `this probe does not start servers - start it via ops/start-company.ps1 if appropriate.`,
    );
    return 2;
  }

  if (res.json === undefined) {
    console.error(`non-JSON body from ${base}${orderId ? ` (HTTP ${res.status})` : ""}: ${clip(res.text, 200)}`);
    return 1;
  }
  if (res.status === 404 && orderId) {
    console.error(`no such fleet order: ${orderId}`);
    return 3;
  }
  if (res.status < 200 || res.status >= 300) {
    console.error(`unexpected HTTP ${res.status} from ${base}: ${clip(res.text, 300)}`);
    return 1;
  }

  console.log(`base       : ${base}`);
  console.log(`status     : HTTP ${res.status}`);
  console.log(`token sent : ${token ? "yes (x-company-token)" : "no"}`);

  if (!orderId) {
    const d = res.json;
    if (d.limits) console.log(`limits     : maxSessions=${d.limits?.maxSessions} running=${d.limits?.running}`);
    if (d.watcher) console.log(`watcher    : running=${d.watcher?.running} interval=${d.watcher?.intervalMs}ms`);
    const orders = asArray(d.orders);
    console.log(`orders     : ${orders.length}`);
    for (const o of orders) {
      const wos = asArray(o.workOrders);
      const passed = wos.filter((w) => w.verdict === "PASS").length;
      console.log(
        `  ${o.id}  ${String(o.status ?? "?").padEnd(17)} ${passed}/${wos.length} passed  "${clip(o.text)}"`,
      );
      for (const w of wos) {
        console.log(
          `      ${String(w.id ?? "?").padEnd(12)} ${String(w.state ?? "?").padEnd(9)} ${String(w.verdict ?? "-").padEnd(4)} ` +
            `${session(w.sessionId)}${w.live?.streaming ? " STREAMING" : ""}  lastActivity=${hhmmss(w.live?.lastActivity)}`,
        );
      }
    }
    return 0;
  }

  const o = res.json;
  console.log(`order      : ${o.id ?? orderId}  status=${o.status ?? "?"}`);
  if (o.error) console.log(`error      : ${clip(o.error, 300)}`);
  if (o.summary) console.log(`summary    : ${clip(o.summary, 300)}`);
  const wos = asArray(o.workOrders);
  console.log(`work orders: ${wos.length}`);
  for (const w of wos) {
    console.log(`-- ${w.id} [${w.state}] verdict=${w.verdict ?? "-"} - ${clip(w.title, 80)}`);
    console.log(
      `   role=${w.role ?? "-"} attempts=${w.attempts ?? "-"} session=${w.sessionId ?? "(no session)"}`,
    );
    if (w.delivery) console.log(`   delivery: ${w.delivery.how} - ${clip(w.delivery.detail, 200)}`);
    if (w.error) console.log(`   error: ${clip(w.error, 300)}`);
    console.log(`   streaming=${Boolean(w.live?.streaming)} lastActivity=${w.live?.lastActivity ?? "-"}`);
    const tail: string[] = Array.isArray(w.live?.tail) ? w.live.tail : [];
    console.log(`   live tail (last ${tailLines} of ${tail.length}):`);
    for (const line of tail.slice(-tailLines)) console.log(`     | ${line}`);
  }
  const trace = asArray(o.trace);
  if (trace.length) {
    console.log("");
    console.log(`trace (${trace.length} hops):`);
    for (const t of trace) console.log(`  ${hhmmss(t.ts)} ${t.from} -> ${t.to} [${t.what}]`);
  }
  return 0;
}

process.exit(await main());
export {};
