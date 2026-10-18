/**
 * ops/deepseek-policy-check.ts — proof for the DeepSeek routing POLICY
 * (CEO order 2026-10-02, docs/ORDER_2026-10-02_deepseek-routing-policy.md).
 *
 * "Everything using opencode gets routed to deepseek (if off peak is cheaper) and if opencode
 * budget falls below 10% quota left." This proves, with an INJECTED clock + INJECTED Go usage
 * snapshot + LOCAL STUB HTTP servers (no real Go/DeepSeek call, no window, temp dirs only):
 *
 *   a. the {off-peak,peak} x {0%,9%,10%,63%,unknown,stale} x {deepseek-v4.1-flash,kimi,glm} matrix
 *      -> the expected provider (direct=deepseek / Go=opencode-go), the expected direct model id,
 *      and a `why` naming the rule that fired. CEO order 2026-10-06 (POLICY-GO-FIRST): a healthy
 *      Go window (>= 10%) stays on OpenCode Go at ANY hour, off-peak included; only < 10% (or a
 *      fresh Go 429) spends credits; an unknown/stale quota stays on Go too;
 *   b. 5-hour window 99% but weekly 0% -> the binding window is weekly -> direct;
 *   c. no DeepSeek key -> Go (never direct), even at quota 0%;
 *   d. direct in auth cool-off + Go at 0% -> the error surfaces (no pointless fallback);
 *   e. direct fails + Go binding window 0% -> error surfaces (no fallback to exhausted Go);
 *   f. a Go 429 GoUsageLimitError sets "go-exhausted" (10 min) -> direct even at peak + 63%;
 *   g. the 45-minute boundary buffer applies to the DEEPSEEK_OFFPEAK_DIRECT=1 opt-in only;
 *   h. flags off -> byte-for-byte today's behaviour (no direct at all);
 *   j. go-first: a healthy quota -> OpenCode Go at any hour, quota unknown -> Go too;
 *   k. DEEPSEEK_OFFPEAK_DIRECT=1 restores the old "off-peak -> direct" result.
 *
 * Run:  npx tsx ops/deepseek-policy-check.ts
 */
import "dotenv/config";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

// MUST run before any src/ module is imported (COMPANY_ROOT is read at import time).
const TEMP_ROOT = path.join(os.tmpdir(), `jcode-deepseek-policy-${process.pid}`);
fs.mkdirSync(TEMP_ROOT, { recursive: true });
process.env.COMPANY_ROOT = TEMP_ROOT;
delete process.env.MOCK_MODE;
delete process.env.BUDGET_OVERRIDE;
// Clean baseline: a real .env may carry these; every case below sets them explicitly.
delete process.env.DEEPSEEK_DIRECT;
delete process.env.DEEPSEEK_DIRECT_ALL_HOURS;
delete process.env.DEEPSEEK_DIRECT_MODEL;
delete process.env.FLEET_DEEPSEEK_ONLY;
delete process.env.GO_QUOTA_DEEPSEEK_BELOW_PCT;
delete process.env.DEEPSEEK_OFFPEAK_DIRECT;

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${label}\n        ${detail}\n`);
  if (!ok) failures++;
}

/** A configurable local HTTP server. */
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

// The IANA clock the check pins (same as deepseek-only-check.ts): Thu 16:30 IST is off-peak
// (clear of the 45-min boundary), Thu 07:30 IST is peak, Thu 06:00 IST is off-peak but inside
// the boundary buffer (30 min to the 06:30 peak start).
const OFFPEAK = new Date("2026-10-01T11:00:00Z");
const PEAK = new Date("2026-10-01T02:00:00Z");
const BOUNDARY = new Date("2026-10-01T00:30:00Z");

const DEEPSEEK = "deepseek-v4.1-flash";
const KIMI = "kimi-k2.7-code";
const GLM = "glm-5.3-flash";
const DIRECT_ID = { [DEEPSEEK]: "deepseek-flash", [KIMI]: "deepseek-flash", [GLM]: "deepseek-flash" } as const;

type QuotaKind = "0%" | "9%" | "10%" | "63%" | "unknown" | "stale";

async function main(): Promise<void> {
  // ---- stub Go gateway + stub DeepSeek direct API (for the fallback cases) ----
  let goStatus = 200;
  let goBody: unknown = { choices: [{ message: { content: "go ok" }, finish_reason: "stop" }], usage: { total_tokens: 2 } };
  let goCalls = 0;
  const go = await listen((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d.toString()));
    req.on("end", () => {
      goCalls += 1;
      res.writeHead(goStatus, { "content-type": "application/json" });
      res.end(typeof goBody === "string" ? goBody : JSON.stringify(goBody));
    });
  });
  let dsStatus = 200;
  let dsBody: unknown = { choices: [{ message: { content: "direct ok" }, finish_reason: "stop" }], usage: { total_tokens: 3 } };
  let dsCalls = 0;
  const ds = await listen((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d.toString()));
    req.on("end", () => {
      dsCalls += 1;
      res.writeHead(dsStatus, { "content-type": "application/json" });
      res.end(typeof dsBody === "string" ? dsBody : JSON.stringify(dsBody));
    });
  });

  process.env.GATEWAY_BASE_URL = `http://127.0.0.1:${go.port}/v1`;
  process.env.OPENCODE_API_KEY = "check-go-key";
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${ds.port}`;
  process.env.DEEPSEEK_API_KEY = "check-ds-key-not-real";

  const direct = await import("../src/company/deepseekDirect.js");
  const usage = await import("../src/company/usage.js");
  const gateway = await import("../src/gateway.js");
  const fleet = await import("../src/company/fleet.js");

  const snap = (remainingPct: number, bindingWindow: string, resetsAt: string | undefined, checkedAt: string) =>
    ({
      connected: true,
      source: "api",
      windows: [],
      remainingPct,
      usedPct: 100 - remainingPct,
      bindingWindow,
      resetsAt,
      detail: "ops/deepseek-policy-check.ts (injected)",
      checkedAt,
    }) as import("../src/company/usage.js").GoQuota;

  /** The injected snapshot for one matrix cell, relative to the injected clock `at`. */
  function quotaFor(at: Date, kind: QuotaKind): import("../src/company/usage.js").GoQuota | null {
    switch (kind) {
      case "0%": return snap(0, "weekly", "2026-10-05T00:00:00Z", at.toISOString());
      case "9%": return snap(9, "weekly", "2026-10-05T00:00:00Z", at.toISOString());
      case "10%": return snap(10, "weekly", "2026-10-05T00:00:00Z", at.toISOString());
      case "63%": return snap(63, "weekly", "2026-10-05T00:00:00Z", at.toISOString());
      case "unknown": return null;
      case "stale": return snap(63, "weekly", "2026-10-05T00:00:00Z", new Date(at.getTime() - 20 * 60 * 1000).toISOString());
    }
  }

  const QUOTA_RE = /quota \d+(\.\d+)?% < 10%/;
  const OFFPEAK_RE = /off-peak/;
  const PEAKGO_RE = /OpenCode Go/;
  const UNKNOWN_RE = /Go quota unknown/;

  process.stdout.write("DeepSeek routing POLICY (injected clock + snapshot + stub HTTP)\n");
  process.stdout.write("=".repeat(84) + "\n\n");

  // ── a. the full matrix ──────────────────────────────────────────────────────────────
  process.stdout.write("a. {off-peak,peak} x {0%,9%,10%,63%,unknown,stale} x {deepseek,kimi,glm}\n");
  await withEnv({ DEEPSEEK_DIRECT: "1", DEEPSEEK_API_KEY: "check-key" }, async () => {
    direct.resetRoutingCounters();
    for (const phase of ["off-peak", "peak"] as const) {
      const at = phase === "off-peak" ? OFFPEAK : PEAK;
      for (const kind of ["0%", "9%", "10%", "63%", "unknown", "stale"] as QuotaKind[]) {
        const below = kind === "0%" || kind === "9%";
        const unknownish = kind === "unknown" || kind === "stale";
        // CEO order 2026-10-06 (POLICY-GO-FIRST): OpenCode Go is primary whenever the binding
        // window is healthy (>= 10%), at ANY hour; credits are spent only below the line or after
        // a fresh Go 429. An unknown/stale quota also stays on Go (never guess credits).
        const expectDirect = below;
        const whyRe = below ? QUOTA_RE : unknownish ? UNKNOWN_RE : PEAKGO_RE;
        for (const model of [DEEPSEEK, KIMI, GLM] as const) {
          const plan = direct.deepseekDirectPlan(model, at, quotaFor(at, kind));
          const provider = plan.use ? "deepseek" : "opencode-go";
          check(
            `${phase} / ${kind} / ${model} -> ${expectDirect ? "deepseek" : "opencode-go"}`,
            plan.use === expectDirect && provider === (expectDirect ? "deepseek" : "opencode-go"),
            `${provider} :: ${plan.why}`,
          );
          check(
            `...the why names the rule (${phase}/${kind}/${model})`,
            whyRe.test(plan.why),
            plan.why,
          );
          if (expectDirect) {
            check(
              `...the direct id is ${DIRECT_ID[model]} (${model})`,
              plan.model === DIRECT_ID[model],
              `model=${plan.model}`,
            );
          }
        }
      }
    }
  });

  // ── b. binding window: 5-hour 99% but weekly 0% -> weekly -> direct ──────────────────
  process.stdout.write("\nb. 5-hour window 99% but weekly 0% -> binding weekly -> direct\n");
  await withEnv({ DEEPSEEK_DIRECT: "1", DEEPSEEK_API_KEY: "check-key" }, () => {
    direct.resetRoutingCounters();
    const twoWindow = snap(0, "weekly", "2026-10-05T00:00:00Z", PEAK.toISOString()) as import("../src/company/usage.js").GoQuota;
    twoWindow.windows = [
      { window: "5-hour", usedPct: 1, remainingPct: 99 },
      { window: "weekly", usedPct: 100, remainingPct: 0, resetsAt: "2026-10-05T00:00:00Z" },
    ];
    const plan = direct.deepseekDirectPlan(DEEPSEEK, PEAK, twoWindow);
    check("binding weekly at 0% -> direct at PEAK", plan.use === true, plan.why);
    check("the why names the weekly window + reset", /weekly window/.test(plan.why) && /Mon 05:30 IST/.test(plan.why), plan.why);
  });

  // ── c. no key -> Go ──────────────────────────────────────────────────────────────────
  process.stdout.write("\nc. no DeepSeek key -> Go (even at quota 0%)\n");
  await withEnv({ DEEPSEEK_DIRECT: "1", DEEPSEEK_API_KEY: undefined }, () => {
    const plan = direct.deepseekDirectPlan(DEEPSEEK, PEAK, quotaFor(PEAK, "0%"));
    check("no key -> use=false", plan.use === false, plan.why);
    check("the why names the missing key", /DEEPSEEK_API_KEY/.test(plan.why), plan.why);
  });

  // ── g. the 45-min boundary buffer belongs to the DEEPSEEK_OFFPEAK_DIRECT=1 opt-in ───
  process.stdout.write("\ng. after POLICY-GO-FIRST the boundary buffer gates the off-peak opt-in only\n");
  await withEnv({ DEEPSEEK_DIRECT: "1", DEEPSEEK_API_KEY: "check-key" }, () => {
    direct.resetRoutingCounters();
    const low = direct.deepseekDirectPlan(DEEPSEEK, BOUNDARY, quotaFor(BOUNDARY, "9%"));
    check("off-peak in the buffer + quota 9% -> direct", low.use === true, low.why);
    const healthy = direct.deepseekDirectPlan(DEEPSEEK, BOUNDARY, quotaFor(BOUNDARY, "63%"));
    check(
      "off-peak in the buffer + quota 63% -> Go (go-first; the buffer only gates the opt-in)",
      healthy.use === false && PEAKGO_RE.test(healthy.why),
      healthy.why,
    );
  });

  // ── j. POLICY-GO-FIRST: a healthy quota -> OpenCode Go at ANY hour (no credits) ─────────
  process.stdout.write("\nj. healthy quota -> OpenCode Go, off-peak included (no credits spent)\n");
  await withEnv({ DEEPSEEK_DIRECT: "1", DEEPSEEK_API_KEY: "check-key", DEEPSEEK_OFFPEAK_DIRECT: undefined }, () => {
    direct.resetRoutingCounters();
    for (const [phase, at] of [["off-peak", OFFPEAK], ["peak", PEAK]] as const) {
      for (const kind of ["10%", "63%"] as QuotaKind[]) {
        const plan = direct.deepseekDirectPlan(DEEPSEEK, at, quotaFor(at, kind));
        check(
          `${phase} / quota ${kind} -> OpenCode Go, no credits`,
          plan.use === false && PEAKGO_RE.test(plan.why) && /no credits spent/.test(plan.why),
          plan.why,
        );
      }
    }
    const unknownOff = direct.deepseekDirectPlan(KIMI, OFFPEAK, quotaFor(OFFPEAK, "unknown"));
    check(
      "off-peak / quota unknown -> OpenCode Go (never guess credits)",
      unknownOff.use === false && UNKNOWN_RE.test(unknownOff.why),
      unknownOff.why,
    );
  });

  // ── k. DEEPSEEK_OFFPEAK_DIRECT=1 opt-in restores the old off-peak rule ────────────────
  process.stdout.write("\nk. DEEPSEEK_OFFPEAK_DIRECT=1 restores \"off-peak -> DeepSeek direct\"\n");
  await withEnv({ DEEPSEEK_DIRECT: "1", DEEPSEEK_API_KEY: "check-key", DEEPSEEK_OFFPEAK_DIRECT: "1" }, () => {
    direct.resetRoutingCounters();
    const off = direct.deepseekDirectPlan(DEEPSEEK, OFFPEAK, quotaFor(OFFPEAK, "63%"));
    check("opt-in + off-peak + 63% -> direct (the old rule)", off.use === true && OFFPEAK_RE.test(off.why), off.why);
    const peak = direct.deepseekDirectPlan(DEEPSEEK, PEAK, quotaFor(PEAK, "63%"));
    check("opt-in + peak + 63% -> still OpenCode Go", peak.use === false && PEAKGO_RE.test(peak.why), peak.why);
    const low = direct.deepseekDirectPlan(DEEPSEEK, OFFPEAK, quotaFor(OFFPEAK, "9%"));
    check("opt-in + off-peak + 9% -> direct (quota rule wins)", low.use === true && QUOTA_RE.test(low.why), low.why);
    const buffer = direct.deepseekDirectPlan(DEEPSEEK, BOUNDARY, quotaFor(BOUNDARY, "63%"));
    check(
      "opt-in + off-peak in the buffer + 63% -> Go (buffer holds)",
      buffer.use === false && /buffer 45m/.test(buffer.why),
      buffer.why,
    );
  });

  // ── f. go-exhausted: a Go 429 sets 10-min "direct" even at peak + 63% ────────────────
  process.stdout.write("\nf. Go 429 GoUsageLimitError sets go-exhausted (10 min) -> direct at peak + 63%\n");
  await withEnv({ DEEPSEEK_DIRECT: "1", DEEPSEEK_API_KEY: "check-key" }, () => {
    direct.resetRoutingCounters();
    const before = direct.deepseekDirectPlan(DEEPSEEK, PEAK, quotaFor(PEAK, "63%"));
    check("peak + 63% -> Go before the 429", before.use === false, before.why);
    direct.markGoExhausted();
    const after = direct.deepseekDirectPlan(DEEPSEEK, PEAK, quotaFor(PEAK, "63%"));
    check("go-exhausted -> direct even at peak + 63%", after.use === true && /go-exhausted/.test(after.why), after.why);
    check("goExhausted() reports true", direct.goExhausted() === true, String(direct.goExhausted()));
  });

  // The live wiring: a real Go 429 GoUsageLimitError through the choke point marks go-exhausted.
  process.stdout.write("f2. the choke point marks go-exhausted on a Go 429 usage limit\n");
  await withEnv({ DEEPSEEK_DIRECT: "1" }, async () => {
    direct.resetRoutingCounters();
    usage.setGoUsageCache(null);
    const planNow = direct.deepseekDirectPlan(DEEPSEEK);
    if (planNow.use) {
      check("direct already primary at this hour (f2 skipped)", true, planNow.why);
    } else {
      goStatus = 429;
      goBody = { type: "error", error: { type: "GoUsageLimitError", message: "Go usage limit exceeded" } };
      dsStatus = 200;
      dsBody = { choices: [{ message: { content: "direct ok" }, finish_reason: "stop" }], usage: { total_tokens: 3 } };
      goCalls = 0;
      dsCalls = 0;
      const r = await gateway.callGatewayModel(DEEPSEEK, undefined, "hello");
      check("Go 429 -> served direct (one fallback)", r.text === "direct ok", r.text);
      check("go-exhausted was marked", direct.goExhausted() === true, String(direct.goExhausted()));
    }
    usage.setGoUsageCache(null);
  });

  // ── d. direct in auth cool-off + Go at 0% -> error surfaces (no pointless fallback) ──
  process.stdout.write("\nd. direct in cool-off + Go at 0% -> error surfaces (no pointless fallback)\n");
  await withEnv({ DEEPSEEK_DIRECT: "1", DEEPSEEK_DIRECT_ALL_HOURS: "1" }, async () => {
    direct.resetRoutingCounters();
    usage.setGoUsageCache(snap(0, "weekly", undefined, new Date().toISOString()));
    direct.markDirectCoolOff();
    goStatus = 429;
    goBody = { type: "error", error: { type: "GoUsageLimitError", message: "Go usage limit exceeded" } };
    dsStatus = 200;
    dsBody = { choices: [{ message: { content: "direct ok" }, finish_reason: "stop" }], usage: { total_tokens: 3 } };
    goCalls = 0;
    dsCalls = 0;
    let err = "";
    try {
      await gateway.callGatewayModel(DEEPSEEK, undefined, "hello");
    } catch (e) {
      err = String((e as Error)?.message ?? e);
    }
    check("error surfaces (both providers unusable)", err.length > 0, err);
    check("direct was NOT dialed (cool-off respected)", dsCalls === 0, `dsCalls=${dsCalls}`);
    usage.setGoUsageCache(null);
  });

  // ── e. direct fails + Go binding 0% -> error surfaces (no fallback to exhausted Go) ──
  process.stdout.write("\ne. direct 429 + Go binding 0% -> error surfaces (no fallback to exhausted Go)\n");
  await withEnv({ DEEPSEEK_DIRECT: "1", DEEPSEEK_DIRECT_ALL_HOURS: "1" }, async () => {
    direct.resetRoutingCounters();
    usage.setGoUsageCache(snap(0, "weekly", undefined, new Date().toISOString()));
    dsStatus = 429;
    dsBody = { error: { message: "too many requests" } };
    goStatus = 200;
    goBody = { choices: [{ message: { content: "go ok" }, finish_reason: "stop" }], usage: { total_tokens: 2 } };
    goCalls = 0;
    dsCalls = 0;
    let err = "";
    try {
      await gateway.callGatewayModel(DEEPSEEK, undefined, "hello");
    } catch (e) {
      err = String((e as Error)?.message ?? e);
    }
    check("error surfaces and names the exhausted Go window", /exhausted/.test(err), err);
    check("Go was NOT dialed (binding window 0%)", goCalls === 0, `goCalls=${goCalls}`);
    usage.setGoUsageCache(null);
  });

  // ── h. flags off -> byte-for-byte today's behaviour ──────────────────────────────────
  process.stdout.write("\nh. flags off -> byte-for-byte today's behaviour (no direct)\n");
  await withEnv(
    { DEEPSEEK_DIRECT: undefined, DEEPSEEK_DIRECT_ALL_HOURS: undefined, FLEET_DEEPSEEK_ONLY: undefined, DEEPSEEK_API_KEY: "check-key" },
    () => {
      const plan = direct.deepseekDirectPlan(DEEPSEEK, OFFPEAK, quotaFor(OFFPEAK, "0%"));
      check("flags off -> use=false", plan.use === false && /feature off/.test(plan.why), plan.why);
      check("a kimi pick is NOT mapped to deepseek", direct.deepseekOnlyModel(KIMI).mapped === false, direct.deepseekOnlyModel(KIMI).why);
    },
  );

  // ── i. CEO order 2026-10-02 (A): the mapping is flash for EVERY input ─────────────────
  process.stdout.write("\ni. every DeepSeek direct model id is deepseek-flash (CEO order A)\n");
  {
    const inputs = [
      "kimi-k2.7-code",
      "qwen3.8-flash",
      "glm-5.3-flash",
      "deepseek-v4-pro",
      "deepseek-reasoner",
      "deepseek-v4.1-flash",
      "deepseek-v4-flash",
      "r1",
      "thinking-max",
      "totally-unknown-model",
      "",
    ];
    for (const m of inputs) {
      const got = direct.deepseekDirectModel(m);
      check(`deepseekDirectModel(${m || "(empty)"}) === deepseek-flash`, got === "deepseek-flash", got);
    }
  }

  // The grep assertion: no literal deepseek-v4-pro model is LAUNCHED or CALLED from src.
  process.stdout.write("i2. no `\"deepseek-v4-pro\"` model literal in any launch/call path\n");
  {
    const launchPaths = [
      "gateway.ts",
      "company/fleet.ts",
      "company/workers.ts",
      "company/dispatch.ts",
      "adaptive/catalog.ts",
      "company/deepseekDirect.ts",
    ];
    const offenders: string[] = [];
    for (const rel of launchPaths) {
      const p = path.join(process.cwd(), "src", rel);
      if (!fs.existsSync(p)) continue;
      fs.readFileSync(p, "utf8")
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (/"deepseek-v4-pro"/.test(line)) offenders.push(`${rel}:${i + 1}`);
        });
    }
    check("no quoted deepseek-v4-pro model literal in a launch/call path", offenders.length === 0, offenders.join(", ") || "none");
  }

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
  process.stderr.write(`deepseek-policy-check failed: ${String(e)}\n`);
  process.exitCode = 1;
});
