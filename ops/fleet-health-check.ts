/**
 * ops/fleet-health-check.ts - READ-ONLY health check for the fleet backend.
 *
 *   npx tsx ops/fleet-health-check.ts [--base <url>]
 *
 * What it checks (prints a PASS/FAIL line for each):
 *   1. fleet order store exists and parses (no writes),
 *   2. every work order references a session id that is alive or not needed,
 *   3. the live router answers GET /company/fleet,
 *   4. the router and the on-disk store agree on the number of orders,
 *   5. the fleet watcher status the router reports is sane.
 *
 * This script imports nothing that mutates state, makes GET requests only,
 * never spawns a process, never starts/restarts a server, and NEVER queues or
 * starts a work order. If the router is not running you get one clear line and
 * a non-zero exit code; nothing is started for you.
 */

import fs from "node:fs";

const argv = process.argv.slice(2);
const flag = (name: string, def = ""): string => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const base = (flag("--base", "http://127.0.0.1:8787") || "http://127.0.0.1:8787").replace(/\/+$/, "");
const TIMEOUT_MS = 5000;

let failures = 0;
const results: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  const line = `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`;
  console.log(line);
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures++;
}

// ── 1: fleet order store parses ──────────────────────────────────────
const fleet = await import("../src/company/fleet.js");
const root = fleet.fleetRoot();
console.log(`fleet root : ${root}`);

check("fleet root directory exists", fs.existsSync(root), root);

let orders: ReturnType<typeof fleet.loadFleetOrders> = [];
try {
  orders = fleet.loadFleetOrders();
  check("fleet order store parses", true, `${orders.length} order(s), no parse errors`);
} catch (e) {
  check("fleet order store parses", false, String((e as Error)?.message ?? e).slice(0, 200));
  console.log("");
  console.log(`[health-check] ${failures} FAILURE(S) - cannot continue without the store`);
  process.exit(1);
}

// ── 2: work order sessions are alive or absent ───────────────────────
// A work order in "working"/"idle" should hold a live client session; queued
// work may legitimately have none yet. Anything else is stale.
const live = fleet.liveClientSessions();
const staleOrders: string[] = [];
for (const o of orders) {
  if (o.status !== "running") continue;
  for (const w of o.workOrders) {
    const needsSession = w.state === "working" || w.state === "idle";
    if (needsSession && !w.sessionId) {
      staleOrders.push(`${o.id}/${w.id}: ${w.state} without a session id`);
    } else if (needsSession && w.sessionId && !live.has(w.sessionId)) {
      staleOrders.push(`${o.id}/${w.id}: ${w.state} but session not live`);
    }
  }
}
check("running work orders hold live sessions", staleOrders.length === 0, staleOrders.join(" | ") || `${live.size} live client session(s)`);

// ── 3: route shapes the router exposes (from src/company/fleet.ts) ───
// GET /company/fleet        -> fleetOrdersData()
// GET /company/fleet/orders/:id -> fleetOrderDetail(id)
const ORDER_ROUTES = [
  { route: "/company/fleet", note: "GET /company/fleet -> orders + limits + watcher" },
  ...(orders.slice(0, 1).map((o) => ({ route: `/company/fleet/orders/${o.id}`, note: `GET /company/fleet/orders/:id (${o.id})` }))),
];

// ── 4: the live router answers GET /company/fleet ────────────────────
type FleetHttpData = {
  orders?: Array<{ id: string; status: string }>;
  limits?: { maxSessions?: number; running?: number };
  watcher?: { running?: boolean; intervalMs?: number };
};

let routerOk = false;
let httpData: FleetHttpData | undefined;
try {
  const res = await fetch(`${base}/company/fleet`, { method: "GET", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status >= 200 && res.status < 300) {
    httpData = (await res.json()) as FleetHttpData;
    routerOk = Array.isArray(httpData?.orders);
  } else {
    check("router answers GET /company/fleet", false, `HTTP ${res.status} from ${base}/company/fleet`);
  }
} catch {
  check("router answers GET /company/fleet", false, `router not reachable at ${base} - is it running? (this check never starts it)`);
}
if (routerOk) check("router answers GET /company/fleet", true, `${httpData?.orders?.length} order(s) over HTTP at ${base}`);

// ── 5: router and disk agree on the order count ──────────────────────
if (routerOk) {
  const diskCount = orders.length;
  const httpCount = (httpData?.orders ?? []).length;
  check("router and disk agree on order count", diskCount === httpCount, `disk=${diskCount} http=${httpCount}`);
}

// ── 6: watcher status the router reports is sane ─────────────────────
if (routerOk) {
  const w = httpData?.watcher;
  const s = fleet.fleetWatcherStatus();
  check("fleet watcher is running on the live router", !!w?.running, `http running=${w?.running} interval=${w?.intervalMs}ms; module running=${s.running} interval=${s.intervalMs}ms`);
}

// ── 7: the documented order routes answer ────────────────────────────
if (routerOk) {
  for (const r of ORDER_ROUTES) {
    try {
      const res = await fetch(`${base}${r.route}`, { method: "GET", signal: AbortSignal.timeout(TIMEOUT_MS) });
      check(r.note, res.status >= 200 && res.status < 300, `HTTP ${res.status} for ${r.route}`);
    } catch (e) {
      check(r.note, false, `FETCH FAILED for ${r.route}: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    }
  }
}

// ── 8: exits with a useful code for a person to read with `@echo %errorlevel%` in a .bat ──
const okCount = results.length - failures;
// Exit by exitCode (not process.exit()) so Node unwinds cleanly after the
// top-level await; on Windows process.exit() after top-level await can trip a
// libuv shutdown assertion and mask the real exit code.
console.log("");
console.log(`[health-check] ${okCount}/${results.length} checks passed. ${failures === 0 ? "FLEET BACKEND HEALTHY" : "FLEET BACKEND UNHEALTHY"}`);
process.exitCode = failures === 0 ? 0 : 1;
export {};
