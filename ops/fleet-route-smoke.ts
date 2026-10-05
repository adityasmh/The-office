/**
 * ops/fleet-route-smoke.ts — verify the SIX /company/fleet routes over HTTP.
 *
 * The fleet logic is covered by ops/fleet-selftest.ts and ops/fleet-deliver-probe.ts,
 * but those call the module directly, so they cannot catch a route that is mounted
 * wrong, returns the wrong shape, or is not guarded. This hits the real router.
 *
 * It never starts a server itself. Point it at one:
 *   npx tsx ops/fleet-route-smoke.ts [--base http://127.0.0.1:8791] [--token <x-company-token>]
 *
 * Against the live :8787 router the mutating checks need COMPANY_AUTH_TOKEN; against a
 * throwaway test server (SLACK_BRIDGE=0, PORT=8791, COMPANY_ROOT=<temp>) any token works.
 * The token is never printed.
 *
 * Checks: GET /company/fleet shape; GET detail shape (live tail + reportPath); 404 for an
 * unknown order; 401 for a mutate with no token; 400 for empty text; create -> planning ->
 * awaiting_approval (with MOCK_MODE on the server); approve of an unknown order -> 4xx;
 * cancel of the created order -> cancelled. It never approves a real order, so it never
 * spawns a terminal.
 */
const argv = process.argv.slice(2);
const flag = (name: string, def = ""): string => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};

const base = flag("--base", process.env.FLEET_PROBE_BASE ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const token = flag("--token", process.env.FLEET_SMOKE_TOKEN ?? process.env.COMPANY_AUTH_TOKEN ?? "");

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
}

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers["x-company-token"] = token;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let json: any = undefined;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

console.log(`[smoke] base=${base} token=${token ? "(set)" : "(none)"}`);

// ── GET /company/fleet ────────────────────────────────────────────────
const list = await req("GET", "/company/fleet");
if (list.status !== 200) {
  console.error(`[smoke] GET /company/fleet -> ${list.status}: ${list.text.slice(0, 200)}`);
  console.error("[smoke] the router is up but has no fleet routes: it predates them (needs a restart), or the base is wrong.");
  process.exit(2);
}
check("GET /company/fleet returns orders + limits", Array.isArray(list.json?.orders) && typeof list.json?.limits?.maxSessions === "number",
  `orders=${list.json?.orders?.length} limits=${JSON.stringify(list.json?.limits)}`);
const orders: any[] = list.json.orders ?? [];
check("every listed order has a workOrders array", orders.every((o) => Array.isArray(o.workOrders)), `n=${orders.length}`);

const existing = orders.find((o) => o.workOrders.length);
if (existing) {
  check("work orders in the list carry live {streaming}", existing.workOrders.every((w: any) => w && w.live && typeof w.live.streaming === "boolean"));
}

// ── GET detail ────────────────────────────────────────────────────────
if (existing) {
  const detail = await req("GET", `/company/fleet/orders/${encodeURIComponent(existing.id)}`);
  const w0 = detail.json?.workOrders?.[0];
  check("GET /company/fleet/orders/:id returns the order + per-work-order live", detail.status === 200 && !!w0?.live && Array.isArray(w0.live.tail) && typeof w0.reportPath === "string",
    `status=${detail.status} live.streaming=${w0?.live?.streaming} tail=${w0?.live?.tail?.length} reportPath=${w0?.reportPath}`);
  check("detail trace is an array of hops", Array.isArray(detail.json?.trace), `hops=${detail.json?.trace?.length}`);
}

const missing = await req("GET", "/company/fleet/orders/nosuchorder");
check("GET an unknown order -> 404 {error:'not found'}", missing.status === 404 && missing.json?.error === "not found", `status=${missing.status}`);

// ── mutations ─────────────────────────────────────────────────────────
if (!token) {
  const unauth = await req("POST", "/company/fleet/orders", { text: "smoke" });
  check("POST without a token is refused (401)", unauth.status === 401, `status=${unauth.status}`);
  console.log("[smoke] no token: skipping the mutating checks. Set --token or COMPANY_AUTH_TOKEN.");
} else {
  const empty = await req("POST", "/company/fleet/orders", { text: "   " });
  check("POST empty text -> 400 text required", empty.status === 400, `status=${empty.status} body=${empty.text.slice(0, 80)}`);

  const created = await req("POST", "/company/fleet/orders", { text: "route smoke test - MOCK_MODE only, do not spawn anything" });
  const id = created.json?.id;
  check("POST /company/fleet/orders creates an order", created.status === 200 && typeof id === "string" && created.json?.status === "planning",
    `status=${created.status} order=${id} orderStatus=${created.json?.status}`);

  if (id) {
    // The planner runs async; with MOCK_MODE on the server it settles in a moment.
    let after: any = undefined;
    for (let i = 0; i < 20; i++) {
      const r = await req("GET", `/company/fleet/orders/${id}`);
      after = r.json;
      if (after?.status === "awaiting_approval" || after?.status === "failed") break;
      await new Promise((r2) => setTimeout(r2, 500));
    }
    check("the async planner moved it to awaiting_approval with work orders", after?.status === "awaiting_approval" && (after?.workOrders?.length ?? 0) > 0,
      `status=${after?.status} workOrders=${after?.workOrders?.length ?? 0}${after?.error ? ` error=${after.error}` : ""}`);

    const unknownApprove = await req("POST", "/company/fleet/orders/nosuchorder/approve", {});
    check("POST approve of an unknown order -> 4xx", unknownApprove.status >= 400 && unknownApprove.status < 500, `status=${unknownApprove.status}`);
    const unknownRedo = await req("POST", "/company/fleet/orders/nosuchorder/work/NOPE/redo", {});
    check("POST redo of an unknown work order -> 4xx", unknownRedo.status >= 400 && unknownRedo.status < 500, `status=${unknownRedo.status}`);

    const cancelled = await req("POST", `/company/fleet/orders/${id}/cancel`, {});
    check("POST cancel -> status cancelled", cancelled.status === 200 && cancelled.json?.status === "cancelled", `status=${cancelled.status} orderStatus=${cancelled.json?.status}`);
    console.log(`[smoke] created and cancelled ${id}; nothing was approved, so no terminal was spawned.`);
  }
}

console.log("");
console.log(`[smoke] ${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
