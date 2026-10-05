/**
 * ops/deepseek-fallback-check.ts — proof for the DeepSeek direct + both-ways fallback fix
 * (CEO order 2026-10-02, docs/ORDER_2026-10-02_deepseek-fallback-fix.md).
 *
 * What it proves, with LOCAL STUB HTTP servers (a stub Go gateway and a stub DeepSeek direct API),
 * against temp dirs only - no real Go call, no real DeepSeek call, no window spawned:
 *
 *   a. flags ON + stub Go 429 GoUsageLimitError: the call is served DIRECT, exactly one direct
 *      attempt, and the result keeps the same { text, usage, meta } shape every caller relies on;
 *   b. stub direct 402 (insufficient balance): falls back to Go ONCE, a 5-minute cool-off is set,
 *      and a second call within that window SKIPS direct (Go is not hammered);
 *   c. both fail (direct 429 + Go 500): the final error reaches the caller;
 *   d. flags OFF: identical to today (no direct call at all);
 *   e. FLEET_DEEPSEEK_ONLY=1: a kimi/glm/qwen pick's launch target is `-p deepseek -m
 *      deepseek-v4-pro`/`deepseek-flash` (the exact args the spawn uses), never the Go id, and the
 *      not-ready case falls back loudly to the old provider;
 *   f. REAL FALLBACK the other way: a Go call for a DeepSeek-family model that fails 429 retries
 *      ONCE on the direct API (exercised whenever the direct plan is not already primary).
 *
 * Run:  npx tsx ops/deepseek-fallback-check.ts
 */
import "dotenv/config";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

// MUST run before any src/ module is imported (COMPANY_ROOT is read at import time).
const TEMP_ROOT = path.join(os.tmpdir(), `jcode-deepseek-fallback-${process.pid}`);
fs.mkdirSync(TEMP_ROOT, { recursive: true });
process.env.COMPANY_ROOT = TEMP_ROOT;
delete process.env.MOCK_MODE;
delete process.env.BUDGET_OVERRIDE;
// Clean baseline: a real .env may carry these, and every case below sets them explicitly.
delete process.env.DEEPSEEK_DIRECT;
delete process.env.DEEPSEEK_DIRECT_ALL_HOURS;
delete process.env.DEEPSEEK_DIRECT_MODEL;
delete process.env.FLEET_DEEPSEEK_ONLY;

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${label}\n        ${detail}\n`);
  if (!ok) failures++;
}

/** A configurable local HTTP server; the handler behaviour is driven by the mutable state below. */
function listen(handler: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ port, close: () => new Promise((r) => srv.close(() => r())) });
    });
  });
}

/** Run `fn` with the given env values, restoring every key afterwards (undefined = delete). */
async function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(values)) saved[k] = process.env[k];
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    restore();
  }
}

async function main(): Promise<void> {
  // ---- stub Go gateway (the OpenCode Go base URL callGatewayModel dials) ----
  let goStatus = 200;
  let goBody: unknown = { choices: [{ message: { content: "go ok" }, finish_reason: "stop" }], usage: { total_tokens: 2 } };
  let goCalls = 0;
  const goSeenModels: string[] = [];
  const go = await listen((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d.toString()));
    req.on("end", () => {
      goCalls += 1;
      try {
        goSeenModels.push((JSON.parse(body) as { model?: string }).model ?? "");
      } catch {
        goSeenModels.push("(unparseable)");
      }
      res.writeHead(goStatus, { "content-type": "application/json" });
      res.end(typeof goBody === "string" ? goBody : JSON.stringify(goBody));
    });
  });

  // ---- stub DeepSeek direct API ----
  let dsStatus = 200;
  let dsBody: unknown = { choices: [{ message: { content: "direct ok" }, finish_reason: "stop" }], usage: { total_tokens: 3 } };
  let dsCalls = 0;
  const dsSeenModels: string[] = [];
  const ds = await listen((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d.toString()));
    req.on("end", () => {
      dsCalls += 1;
      try {
        dsSeenModels.push((JSON.parse(body) as { model?: string }).model ?? "");
      } catch {
        dsSeenModels.push("(unparseable)");
      }
      res.writeHead(dsStatus, { "content-type": "application/json" });
      res.end(typeof dsBody === "string" ? dsBody : JSON.stringify(dsBody));
    });
  });

  // config.gatewayBaseUrl / config.gatewayKey are read at import time; point them at the stubs first.
  process.env.GATEWAY_BASE_URL = `http://127.0.0.1:${go.port}/v1`;
  process.env.OPENCODE_API_KEY = "check-go-key";
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${ds.port}`;
  process.env.DEEPSEEK_API_KEY = "check-ds-key-not-real";

  const gateway = await import("../src/gateway.js");
  const direct = await import("../src/company/deepseekDirect.js");
  const fleet = await import("../src/company/fleet.js");

  const DEEPSEEK = "deepseek-v4.1-flash";
  // flags fully ON (direct is primary at any hour)
  const on = { DEEPSEEK_DIRECT: "1", DEEPSEEK_DIRECT_ALL_HOURS: "1" };
  const off = { DEEPSEEK_DIRECT: undefined, DEEPSEEK_DIRECT_ALL_HOURS: undefined, FLEET_DEEPSEEK_ONLY: undefined };

  process.stdout.write("DeepSeek direct + both-ways fallback (stub Go + stub direct API)\n");
  process.stdout.write("=".repeat(84) + "\n\n");

  // ── a. flags ON + stub Go 429: served DIRECT, one attempt, correct shape ─────────────
  process.stdout.write("a. flags ON + stub Go 429 GoUsageLimitError -> the call is served direct\n");
  goStatus = 429;
  goBody = { type: "error", error: { type: "GoUsageLimitError", message: "Go usage limit exceeded" } };
  dsStatus = 200;
  dsBody = { choices: [{ message: { content: "direct ok" }, finish_reason: "stop" }], usage: { total_tokens: 3 } };
  goCalls = 0;
  dsCalls = 0;
  dsSeenModels.length = 0;
  const a = await withEnv(on, () => gateway.callGatewayModel(DEEPSEEK, undefined, "hello"));
  check("result has the text/usage/meta shape", typeof a.text === "string" && !!a.usage && !!a.meta, JSON.stringify(a));
  check("served by direct (direct ok)", a.text === "direct ok", a.text);
  check("exactly ONE direct attempt (no retry)", dsCalls === 1, `direct calls=${dsCalls}`);
  check("Go was never dialed (429 stub untouched)", goCalls === 0, `go calls=${goCalls}`);
  check("the direct id sent is deepseek-flash", dsSeenModels[0] === "deepseek-flash", `models sent to direct=${dsSeenModels.join(",")}`);

  // ── c. both fail: caller gets the error ──────────────────────────────────────────────
  process.stdout.write("\nc. both fail -> the final error reaches the caller\n");
  dsStatus = 429;
  dsBody = { error: { message: "too many requests" } };
  goStatus = 500;
  goBody = { error: { message: "gateway exploded" } };
  goCalls = 0;
  dsCalls = 0;
  let bothErr = "";
  try {
    await withEnv(on, () => gateway.callGatewayModel(DEEPSEEK, undefined, "hello"));
  } catch (e) {
    bothErr = String((e as Error)?.message ?? e);
  }
  check("both failed and the caller got an error", bothErr.length > 0 && /failed/.test(bothErr), bothErr);
  check("neither provider was retried (direct=1, go=1)", dsCalls === 1 && goCalls === 1, `direct=${dsCalls} go=${goCalls}`);

  // ── d. flags OFF: identical to today (no direct call at all) ────────────────────────
  process.stdout.write("\nd. flags OFF -> identical to today (no direct call)\n");
  dsStatus = 200;
  dsBody = { choices: [{ message: { content: "direct ok" }, finish_reason: "stop" }], usage: { total_tokens: 3 } };
  goStatus = 200;
  goBody = { choices: [{ message: { content: "go ok" }, finish_reason: "stop" }], usage: { total_tokens: 2 } };
  goCalls = 0;
  dsCalls = 0;
  const d = await withEnv(off, () => gateway.callGatewayModel(DEEPSEEK, undefined, "hello"));
  check("served by Go (go ok)", d.text === "go ok", d.text);
  check("direct was never dialed", dsCalls === 0, `direct calls=${dsCalls}`);
  check("Go was dialed once", goCalls === 1, `go calls=${goCalls}`);

  // ── f. REAL FALLBACK the other way: Go 429 for a DeepSeek model -> direct ONCE ───────
  process.stdout.write("\nf. Go 429 for a DeepSeek-family model -> retry ONCE on direct\n");
  await withEnv(
    { DEEPSEEK_DIRECT: "1", DEEPSEEK_DIRECT_ALL_HOURS: undefined, FLEET_DEEPSEEK_ONLY: undefined },
    async () => {
      const planNow = direct.deepseekDirectPlan(DEEPSEEK);
      if (planNow.use) {
        // direct is already primary (off-peak, clear): the direct-first path carries it, Go never dialed.
        check("direct already primary at this hour (fallback not needed)", true, planNow.why);
      } else {
        goStatus = 429;
        goBody = { type: "error", error: { type: "GoUsageLimitError", message: "Go usage limit exceeded" } };
        dsStatus = 200;
        dsBody = { choices: [{ message: { content: "direct ok" }, finish_reason: "stop" }], usage: { total_tokens: 3 } };
        goCalls = 0;
        dsCalls = 0;
        // armed (DEEPSEEK_DIRECT + key) but the plan says "Go" right now (peak/boundary).
        const f = await gateway.callGatewayModel(DEEPSEEK, undefined, "hello");
        check("Go 429 -> served by direct", f.text === "direct ok", f.text);
        check("Go attempted once, direct retried once", goCalls === 1 && dsCalls === 1, `go=${goCalls} direct=${dsCalls}`);
      }
    },
  );

  // ── e. FLEET_DEEPSEEK_ONLY=1: the launch target is the DeepSeek provider/model ──────
  process.stdout.write("\ne. FLEET_DEEPSEEK_ONLY=1 -> launch target is `-p deepseek -m <direct id>`\n");
  const fleetOn = { DEEPSEEK_DIRECT: "1", DEEPSEEK_DIRECT_ALL_HOURS: "1", FLEET_DEEPSEEK_ONLY: "1", FLEET_DEEPSEEK_DIRECT_READY: "1" };
  await withEnv(fleetOn, async () => {
    direct.resetFleetDirectReady();
    const g = await fleet.launchTarget("glm-5.3-flash");
    check("glm pick -> -p deepseek -m deepseek-flash", g.provider === "deepseek" && g.model === "deepseek-flash" && g.direct === true, `${g.provider} ${g.model} direct=${g.direct} :: ${g.why}`);
    const k = await fleet.launchTarget("kimi-k2.7-code");
    check("kimi pick -> -p deepseek -m deepseek-flash", k.provider === "deepseek" && k.model === "deepseek-flash" && k.direct === true, `${k.provider} ${k.model} direct=${k.direct} :: ${k.why}`);
    const q = await fleet.launchTarget("qwen3.8-flash");
    check("qwen pick -> -p deepseek -m deepseek-flash", q.provider === "deepseek" && q.model === "deepseek-flash" && q.direct === true, `${q.provider} ${q.model} direct=${q.direct} :: ${q.why}`);
    const dsPick = await fleet.launchTarget("deepseek-v4.1-flash");
    check("a DeepSeek pick stays deepseek (deepseek-flash)", dsPick.provider === "deepseek" && dsPick.model === "deepseek-flash", `${dsPick.provider} ${dsPick.model} direct=${dsPick.direct}`);
    check("the trace reason names the switch", g.why.includes("FLEET_DEEPSEEK_ONLY=1"), g.why);
    direct.resetFleetDirectReady();
  });

  // e2. not ready -> loud fallback to the old provider (do not strand work)
  process.stdout.write("e2. not ready -> loud fallback to the old provider\n");
  await withEnv(
    { DEEPSEEK_DIRECT: "1", DEEPSEEK_DIRECT_ALL_HOURS: "1", FLEET_DEEPSEEK_ONLY: "1", FLEET_DEEPSEEK_DIRECT_READY: undefined, JCODE_BIN: "jcode-no-such-binary" },
    async () => {
      direct.resetFleetDirectReady();
      const g = await fleet.launchTarget("glm-5.3-flash");
      check("glm pick with no deepseek terminal -> old provider (opencode-go)", g.provider === "opencode-go" && g.model === "glm-5.3-flash" && g.direct === false, `${g.provider} ${g.model} direct=${g.direct}`);
      check("the reason says it out loud", /fleetDirectReady\(\)=false/.test(g.why), g.why);
      direct.resetFleetDirectReady();
    },
  );

  // ── b. direct 402 -> Go once, cool-off set, second call skips direct (LAST: cool-off persists) ──
  process.stdout.write("\nb. stub direct 402 (insufficient balance) -> fall back to Go ONCE + 5 min cool-off\n");
  dsStatus = 402;
  dsBody = { error: { message: "Insufficient balance" } };
  goStatus = 200;
  goBody = { choices: [{ message: { content: "go ok" }, finish_reason: "stop" }], usage: { total_tokens: 2 } };
  goCalls = 0;
  dsCalls = 0;
  const b1 = await withEnv(on, () => gateway.callGatewayModel(DEEPSEEK, undefined, "hello"));
  check("direct 402 fell back to Go", b1.text === "go ok", b1.text);
  check("direct attempted exactly once", dsCalls === 1, `direct calls=${dsCalls}`);
  check("Go attempted exactly once (one retry, no loop)", goCalls === 1, `go calls=${goCalls}`);
  // second call within the 5 min cool-off: direct must be SKIPPED entirely
  const b2 = await withEnv(on, () => gateway.callGatewayModel(DEEPSEEK, undefined, "hello again"));
  check("second call skips direct (cool-off active)", dsCalls === 1 && b2.text === "go ok", `direct calls=${dsCalls} (still 1), text=${b2.text}`);

  // ── isolation ────────────────────────────────────────────────────────────────────────
  process.stdout.write("\nIsolation\n");
  check(
    "ran against its own temp COMPANY_ROOT",
    fleet.fleetRoot().toLowerCase().startsWith(TEMP_ROOT.toLowerCase()),
    `fleetRoot=${fleet.fleetRoot()}`,
  );
  check(
    "no orders.json was written",
    !fs.existsSync(path.join(TEMP_ROOT, "fleet", "orders.json")),
    path.join(TEMP_ROOT, "fleet", "orders.json"),
  );

  await go.close();
  await ds.close();
  try {
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  } catch {
    /* best effort */
  }

  process.stdout.write(`\n${failures === 0 ? "OK - all cases pass" : `${failures} FAILURE(S)`}\n`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => {
  process.stderr.write(`deepseek-fallback-check failed: ${String(e)}\n`);
  process.exitCode = 1;
});
