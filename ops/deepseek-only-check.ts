/**
 * ops/deepseek-only-check.ts — proof for FLEET_DEEPSEEK_ONLY, the "run on the DeepSeek API key
 * instead of OpenCode Go, for now" switch (CEO order 2026-10-01 18:30,
 * docs/ORDER_2026-10-01_deepseek-only.md).
 *
 * What it proves, in order:
 *
 *   A. SWITCH OFF (today's default) — every pick is byte-for-byte today's: a Laya kimi pick stays
 *      kimi, the rule's glm/kimi picks stay glm/kimi, and the budget hold behaves as before
 *      (peak -> still held). Since CEO order 2026-10-06 (POLICY-GO-FIRST) a healthy Go window keeps
 *      off-peak work on Go too, so the off-peak hold now waits; DEEPSEEK_OFFPEAK_DIRECT=1 restores
 *      the old off-peak skip.
 *   B. SWITCH ON + the bank armed — a Laya pick of kimi / glm / qwen maps onto the DeepSeek model
 *      the direct API serves (kimi/qwen -> deepseek-v4-pro, glm -> deepseek-v4.1-flash), and the
 *      REASON LINE still names Laya's original pick, which is what the Fleet trace prints.
 *      The planner/reviewer paths (fleet.ruleModel, the Claude-outage fallback chain, brainRouter's
 *      cheap tier) and the router route mapping are checked the same way.
 *   C. SWITCH ON, KEY MISSING — nothing changes (the pick stays on OpenCode Go) and the reason
 *      says exactly why, so a half-configured box cannot lose work.
 *   D. BUDGET HOLD — while OpenCode Go is RED, a non-urgent order is released only in the
 *      all-DeepSeek case: every model of the order must be direct-usable right now (armed, key,
 *      and DEEPSEEK_DIRECT_ALL_HOURS=1 at peak). One kimi/glm/qwen model in the order, or a peak
 *      hour without ALL_HOURS, keeps the wait.
 *
 * It runs the REAL functions (deepseekDirect.*, fleet.pickFleetModel / ruleModel / fallback path /
 * allDeepseekDirect / fleetBudgetHold, the guard's own fleetQueueForBudget + rulesFor) against a
 * throwaway COMPANY_ROOT and a LOCAL Laya stub, so no server, no Go call and no DeepSeek call is
 * made, the live budget state is never read, and no CEO grant is spent. It writes nothing into
 * company/ and releases no order: the only fleet dir is the temp one, which is asserted to have no
 * orders.json at the end.
 *
 *   npx tsx ops/deepseek-only-check.ts
 */
import "dotenv/config";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

// MUST run before org.ts is imported (COMPANY_ROOT is read at import time).
const TEMP_ROOT = path.join(os.tmpdir(), `jcode-deepseek-only-${process.pid}`);
fs.mkdirSync(TEMP_ROOT, { recursive: true });
process.env.COMPANY_ROOT = TEMP_ROOT;
delete process.env.BUDGET_OVERRIDE; // a live override would open every queue below
delete process.env.MOCK_MODE; // the Laya stub answers for real

// The IANA clock the check pins: Thu 16:30 IST is off-peak; Thu 07:30 IST is peak.
const OFFPEAK = new Date("2026-10-01T11:00:00Z");
const PEAK = new Date("2026-10-01T02:00:00Z");

const KIMI = "kimi-k2.7-code";
const GLM = "glm-5.3-flash";
const QWEN = "qwen3.8-flash";
const DEEPSEEK = "deepseek-v4.1-flash";

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${label}\n        ${detail}\n`);
  if (!ok) failures++;
}

/** The local Laya stub: two noul probabilities, so the shared worker-model question answers. */
let layaEscalate = 0.9;
let layaTrivial = 0.02;
let layaCalls = 0;

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
  const laya = await listen((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d.toString()));
    req.on("end", () => {
      layaCalls += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: "laya-stub",
          answers: {
            escalate: { noul: layaEscalate },
            trivial: { noul: layaTrivial },
          },
        }),
      );
    });
  });
  process.env.LAYA_BASE_URL = `http://127.0.0.1:${laya.port}`;
  process.env.DECISION_BACKEND = "laya";
  process.env.LAYA_API_KEY = "";

  const direct = await import("../src/company/deepseekDirect.js");
  const budget = await import("../src/company/budgetGuard.js");
  const fleet = await import("../src/company/fleet.js");
  const brain = await import("../src/company/brainRouter.js");
  const usage = await import("../src/company/usage.js");

  // A KNOWN healthy Go snapshot: this check exercises the KNOWN-quota rules. CEO order 2026-10-02 (B)
  // routes UNKNOWN quota to DeepSeek instead of OpenCode blind, which ops/deepseek-policy-check.ts
  // proves; pinning a healthy snapshot keeps "peak -> Go" meaning what it says here.
  usage.setGoUsageCache({
    connected: true,
    source: "api",
    windows: [],
    remainingPct: 63,
    usedPct: 37,
    bindingWindow: "weekly",
    resetsAt: "2026-10-05T00:00:00Z",
    detail: "ops/deepseek-only-check.ts (injected)",
    checkedAt: new Date().toISOString(),
  } as import("../src/company/usage.js").GoQuota);

  type Snap = NonNullable<ReturnType<typeof budget.readBudgetState>>;
  /** A synthetic RED snapshot built from the guard's OWN rulesFor(), so the red rules are real. */
  function redSnapshot(): Snap {
    return {
      version: 1,
      checkedAt: new Date().toISOString(),
      pollS: 300,
      thresholds: { greenMin: 40, amberMin: 15 },
      levels: { go: "red", claude: "green" },
      providers: {
        go: { id: "go", label: "OpenCode Go", level: "red", connected: true, remainingPct: 6, source: "check" },
        claude: { id: "claude", label: "Claude", level: "green", connected: true, remainingPct: 80, source: "check" },
      },
      rules: budget.rulesFor("red", "green"),
      effects: [],
      needsYou: null,
      spend: { lastHourUsd: 0, last24hUsd: 0, todayUsd: 0, byModel: {} },
      samples: [],
      detail: "ops/deepseek-only-check.ts (synthetic)",
    } as unknown as Snap;
  }

  /** The real launch-gate decision, run exactly as fillSlotsNow runs it. */
  async function hold(models: string | string[], at: Date) {
    return fleet.fleetBudgetHold(budget.fleetQueueForBudget(false, redSnapshot()), models, at);
  }

  /**
   * The same decision with the TERMINAL-side readiness pinned, since `fleetDirectReady()` caches
   * its probe: `ready: false` uses a jcode binary that does not exist, which is what this box looks
   * like until the CEO confirms the `deepseek` provider import.
   */
  async function withTerminalReady<T>(ready: boolean, fn: () => Promise<T>): Promise<T> {
    direct.resetFleetDirectReady();
    try {
      return await withEnv(
        ready
          ? { FLEET_DEEPSEEK_DIRECT_READY: "1", JCODE_BIN: undefined }
          : { FLEET_DEEPSEEK_DIRECT_READY: undefined, JCODE_BIN: "jcode-no-such-binary-for-this-check" },
        fn,
      );
    } finally {
      direct.resetFleetDirectReady();
    }
  }

  const mk = (id: string, title: string, owns: string[], brief: string, failed = false) =>
    ({
      id,
      title,
      role: id,
      owns,
      brief,
      done: ["(sample)"],
      state: "queued" as const,
      attempts: failed ? 1 : 0,
      ...(failed ? { error: "previous attempt failed" } : {}),
    });
  // A trivial docs order (the rule's glm case) and an escalation order (the rule's kimi case).
  const docsWo = mk("DOCS", "Tidy the README wording", ["docs/README.md"], "Fix the wording of one short markdown paragraph.");
  const hardWo = mk("HARD", "Refactor the router (2nd attempt)", ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"], "The previous attempt failed: refactor these four files.", true);

  process.stdout.write("FLEET_DEEPSEEK_ONLY: does a Go-bound pick move to the DeepSeek API key?\n");
  process.stdout.write("=".repeat(84) + "\n\n");

  // The bank: armed in the temp process, never a real call. Readiness is pinned so the hold cases
  // do not depend on whether this box has imported the `deepseek` provider yet.
  const armed = { DEEPSEEK_DIRECT: "1", DEEPSEEK_API_KEY: "check-only-not-a-real-key", FLEET_DEEPSEEK_DIRECT_READY: "1" };

  // ── A. SWITCH OFF: today's picks, byte for byte ─────────────────────────────────────────
  process.stdout.write("A. FLEET_DEEPSEEK_ONLY off (the default) -> today's behaviour\n");
  await withEnv({ ...armed, FLEET_DEEPSEEK_ONLY: undefined, DEEPSEEK_DIRECT_ALL_HOURS: undefined, BUDGET_BRAIN_CHEAP_MODEL: undefined }, async () => {
    const k = direct.deepseekOnlyModel(KIMI);
    check("kimi is NOT mapped", k.mapped === false && k.model === KIMI, `${k.model} :: ${k.why}`);
    const g = direct.deepseekOnlyModel(GLM);
    check("glm is NOT mapped", g.mapped === false && g.model === GLM, `${g.model} :: ${g.why}`);
    const q = direct.deepseekOnlyModel(QWEN);
    check("qwen is NOT mapped", q.mapped === false && q.model === QWEN, `${q.model} :: ${q.why}`);

    check("rule pick for a trivial docs order is still glm", fleet.ruleModel(docsWo).model === GLM, fleet.ruleModel(docsWo).reason);
    check("rule pick for an escalation order is still kimi", fleet.ruleModel(hardWo).model === KIMI, fleet.ruleModel(hardWo).reason);
    check(
      "the Claude-outage fallback chain is unchanged (deepseek then kimi)",
      JSON.stringify(fleet.fallbackModels()) === JSON.stringify([DEEPSEEK, KIMI]),
      fleet.fallbackModels().join(", "),
    );

    layaEscalate = 0.9;
    layaTrivial = 0.02;
    const pick = await fleet.pickFleetModel(hardWo);
    check("Laya's kimi pick is unchanged", pick.model === KIMI && pick.source === "laya", `${pick.model} [${pick.source}] ${pick.reason}`);

    const peak = await hold(DEEPSEEK, PEAK);
    check("red + peak + no ALL_HOURS -> still held (Go)", peak.hold === true, `hold=${peak.hold} :: ${peak.reason}`);
    // CEO order 2026-10-06 (POLICY-GO-FIRST): a healthy Go window keeps off-peak work on OpenCode
    // Go, so the old off-peak skip no longer fires by default - the order now waits like any Go call.
    const off = await hold(DEEPSEEK, OFFPEAK);
    check(
      "red + off-peak + healthy quota -> now held (go-first: off-peak stays on Go)",
      off.hold === true,
      `hold=${off.hold} :: ${off.reason}`,
    );
    // ...and the explicit opt-in restores the old off-peak direct skip (same reason as before).
    const offOpt = await withEnv({ DEEPSEEK_OFFPEAK_DIRECT: "1" }, () => hold(DEEPSEEK, OFFPEAK));
    check(
      "red + off-peak + DEEPSEEK_OFFPEAK_DIRECT=1 -> the OLD skip is back",
      offOpt.hold === false && offOpt.reason === fleet.FLEET_DIRECT_SKIP_REASON,
      `hold=${offOpt.hold} :: ${offOpt.reason}`,
    );
  });

  // ── B. SWITCH ON + ARMED: Go-bound picks move to the direct bank ────────────────────────
  process.stdout.write("\nB. FLEET_DEEPSEEK_ONLY=1 + DEEPSEEK_DIRECT + key -> mapped to DeepSeek\n");
  await withEnv({ ...armed, FLEET_DEEPSEEK_ONLY: "1", DEEPSEEK_DIRECT_ALL_HOURS: "1", BUDGET_BRAIN_CHEAP_MODEL: undefined }, async () => {
    const cases: Array<[string, string, string]> = [
      [KIMI, "deepseek-flash", "deepseek-flash"],
      [GLM, DEEPSEEK, "deepseek-flash"],
      [QWEN, "deepseek-flash", "deepseek-flash"],
    ];
    for (const [from, wantModel, wantDirectId] of cases) {
      const m = direct.deepseekOnlyModel(from);
      check(`Laya/fleet pick ${from} -> ${wantModel}`, m.mapped === true && m.model === wantModel, m.why);
      check(
        `...the reason line keeps the original pick (${from})`,
        m.why.includes(from) && m.why.includes("FLEET_DEEPSEEK_ONLY=1"),
        m.why,
      );
      check(
        `...and the direct API id really is ${wantDirectId}`,
        direct.deepseekDirectPlan(m.model, OFFPEAK).model === wantDirectId,
        direct.deepseekDirectPlan(m.model, OFFPEAK).model,
      );
    }
    const claude = direct.deepseekOnlyModel("claude-opus-5-5");
    check("a Claude id is never mapped (subscription path)", claude.mapped === false && claude.model === "claude-opus-5-5", claude.why);
    const already = direct.deepseekOnlyModel(DEEPSEEK);
    check("a DeepSeek id is left alone", already.mapped === false && already.model === DEEPSEEK, already.why);

    layaEscalate = 0.9;
    layaTrivial = 0.02;
    const pick = await fleet.pickFleetModel(hardWo);
    check(
      "pickFleetModel: the Laya kimi pick becomes deepseek-v4-pro",
      pick.model === "deepseek-flash",
      `${pick.model} [${pick.source}] ${pick.reason}`,
    );
    check(
      "...and the trace/decision line shows Laya picked kimi",
      pick.reason.includes(KIMI) && pick.reason.includes("FLEET_DEEPSEEK_ONLY=1"),
      pick.reason,
    );

    layaEscalate = 0.02;
    layaTrivial = 0.9;
    const trivialPick = await fleet.pickFleetModel(docsWo);
    check(
      "pickFleetModel: a Laya glm pick becomes deepseek-v4.1-flash",
      trivialPick.model === DEEPSEEK,
      `${trivialPick.model} [${trivialPick.source}] ${trivialPick.reason}`,
    );

    const ruleEsc = fleet.ruleModel(hardWo);
    check("ruleModel: escalation kimi -> deepseek-v4-pro", ruleEsc.model === "deepseek-flash", ruleEsc.reason);
    const ruleDocs = fleet.ruleModel(docsWo);
    check("ruleModel: trivial glm -> deepseek-v4.1-flash", ruleDocs.model === DEEPSEEK, ruleDocs.reason);
    const chain = fleet.fallbackModels();
    check(
      "the Claude-outage fallback chain is DeepSeek-only (kimi -> deepseek-v4-pro, deduped)",
      JSON.stringify(chain) === JSON.stringify([DEEPSEEK, "deepseek-flash"]) && !chain.some((m) => /kimi|glm|qwen/i.test(m)),
      chain.join(", "),
    );
    check(
      "...and both rule reasons name the original pick",
      ruleEsc.reason.includes(KIMI) && ruleDocs.reason.includes(GLM),
      `${ruleEsc.reason} | ${ruleDocs.reason}`,
    );

    check("brainRouter cheap tier: glm -> deepseek-v4.1-flash", brain.tierModel("none") === DEEPSEEK, brain.tierModel("none"));
    check("brainRouter: a Claude tier is untouched", brain.tierModel("sonnet").includes("claude"), brain.tierModel("sonnet"));

    // D. The budget hold, switch on. All-DeepSeek is the ONLY case that is released.
    const allNoTerminal = await withTerminalReady(false, () => hold([DEEPSEEK, "deepseek-flash"], PEAK));
    check(
      "red + PEAK + all-DeepSeek + ALL_HOURS, no usable `deepseek` terminal yet -> NOT held (the new skip)",
      allNoTerminal.hold === false && allNoTerminal.reason === fleet.FLEET_DEEPSEEK_ONLY_SKIP_REASON,
      `hold=${allNoTerminal.hold} :: ${allNoTerminal.reason}`,
    );
    const allReady = await withTerminalReady(true, () => hold([DEEPSEEK, "deepseek-flash"], PEAK));
    check(
      "...with a ready terminal the older off-peak skip reason wins (both are skips)",
      allReady.hold === false && allReady.reason === fleet.FLEET_DIRECT_SKIP_REASON,
      `hold=${allReady.hold} :: ${allReady.reason}`,
    );
    const mixed = await withTerminalReady(false, () => hold([DEEPSEEK, KIMI], PEAK));
    check(
      "red + a kimi model anywhere in the order -> still held",
      mixed.hold === true,
      `hold=${mixed.hold} :: ${mixed.reason}`,
    );
    const allNoHours = await withTerminalReady(false, () =>
      withEnv({ DEEPSEEK_DIRECT_ALL_HOURS: undefined }, () => hold([DEEPSEEK, "deepseek-flash"], PEAK)),
    );
    check(
      "red + PEAK + all-DeepSeek but no ALL_HOURS (a Go call at peak) -> held",
      allNoHours.hold === true,
      `hold=${allNoHours.hold} :: ${allNoHours.reason}`,
    );
    const off = await withTerminalReady(true, () => hold([DEEPSEEK, "deepseek-flash"], OFFPEAK));
    check(
      "red + off-peak + all-DeepSeek -> released (old skip reason still wins)",
      off.hold === false && off.reason === fleet.FLEET_DIRECT_SKIP_REASON,
      `hold=${off.hold} :: ${off.reason}`,
    );
    check(
      "allDeepseekDirect() is the order-level rule (one non-DeepSeek fails it)",
      fleet.allDeepseekDirect([DEEPSEEK, "deepseek-flash"], PEAK) === true &&
        fleet.allDeepseekDirect([DEEPSEEK, GLM], PEAK) === false,
      `all=[deepseek, pro]=${fleet.allDeepseekDirect([DEEPSEEK, "deepseek-flash"], PEAK)} allWithGlm=${fleet.allDeepseekDirect([DEEPSEEK, GLM], PEAK)}`,
    );
  });

  // A glm-typed brainRouter cheap tier: the switch maps it, the default (deepseek) does not move.
  await withEnv({ FLEET_DEEPSEEK_ONLY: "1", ...armed, BUDGET_BRAIN_CHEAP_MODEL: GLM }, () => {
    check(
      "brainRouter cheap tier set to glm -> mapped to the direct bank",
      brain.tierModel("none") === DEEPSEEK,
      `BUDGET_BRAIN_CHEAP_MODEL=${GLM} -> ${brain.tierModel("none")}`,
    );
  });
  await withEnv({ FLEET_DEEPSEEK_ONLY: undefined, ...armed, BUDGET_BRAIN_CHEAP_MODEL: GLM }, () => {
    check("...and with the switch off it stays glm (today)", brain.tierModel("none") === GLM, brain.tierModel("none"));
  });

  // ── C. SWITCH ON, KEY MISSING: nothing moves, and the reason says so ────────────────────
  process.stdout.write("\nC. FLEET_DEEPSEEK_ONLY=1 but NO KEY -> today's picks, and it says why\n");
  await withEnv(
    { DEEPSEEK_DIRECT: "1", DEEPSEEK_API_KEY: undefined, FLEET_DEEPSEEK_ONLY: "1", FLEET_DEEPSEEK_DIRECT_READY: "1", DEEPSEEK_DIRECT_ALL_HOURS: undefined },
    async () => {
      const m = direct.deepseekOnlyModel(KIMI);
      check("no key -> kimi is NOT mapped", m.mapped === false && m.model === KIMI, m.why);
      check("no key -> the reason names the missing key/flag", /DEEPSEEK_API_KEY|DEEPSEEK_DIRECT/.test(m.why), m.why);
      check("no key -> the rule pick for an escalation is still kimi", fleet.ruleModel(hardWo).model === KIMI, fleet.ruleModel(hardWo).reason);
      check("no key -> the trivial rule pick is still glm", fleet.ruleModel(docsWo).model === GLM, fleet.ruleModel(docsWo).reason);
      check(
        "no key -> the fallback chain is unchanged too",
        JSON.stringify(fleet.fallbackModels()) === JSON.stringify([DEEPSEEK, KIMI]),
        fleet.fallbackModels().join(", "),
      );
      layaEscalate = 0.9;
      layaTrivial = 0.02;
      const pick = await fleet.pickFleetModel(hardWo);
      check("no key -> Laya's kimi pick is unchanged", pick.model === KIMI, `${pick.model} [${pick.source}] ${pick.reason}`);
      const held = await hold([DEEPSEEK, "deepseek-flash"], PEAK);
      check("no key -> the Go budget hold still applies", held.hold === true, `hold=${held.hold} :: ${held.reason}`);
    },
  );

  // ── E. Nothing was released, nothing was written ────────────────────────────────────────
  process.stdout.write("\nE. Isolation\n");
  const fleetRoot = fleet.fleetRoot();
  check(
    "the check ran against its own temp COMPANY_ROOT",
    fleetRoot.toLowerCase().startsWith(TEMP_ROOT.toLowerCase()),
    `fleetRoot=${fleetRoot}`,
  );
  check(
    "no order was released or written (no orders.json in the temp root)",
    !fs.existsSync(path.join(TEMP_ROOT, "fleet", "orders.json")),
    path.join(TEMP_ROOT, "fleet", "orders.json"),
  );
  process.stdout.write(`INFO  Laya stub answered ${layaCalls} question(s); no gateway or DeepSeek call was made.\n`);

  await laya.close();
  try {
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  } catch {
    /* best effort */
  }

  process.stdout.write(`\n${failures === 0 ? "OK - all cases pass" : `${failures} FAILURE(S)`}\n`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => {
  process.stderr.write(`deepseek-only-check failed: ${String(e)}\n`);
  process.exitCode = 1;
});
