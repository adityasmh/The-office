/**
 * ops/budget-guard-direct-check.ts — proof for the DeepSeek-direct budget-hold skip
 * (work order 2026-10-01: "do not hold Fleet orders for OpenCode Go quota when they will
 * run on DeepSeek direct").
 *
 * It runs the REAL decision the launch gate runs — `fleet.fleetBudgetHold()`, which calls
 * the real `budget.fleetQueueForBudget()`, `direct.deepseekDirectPlan()` and
 * `direct.fleetDirectReady()` — against forced red/amber/green rule tables built by the
 * guard's own `rulesFor()`, with the DeepSeek clock pinned via `at` so the phase is exact.
 *
 * The cases (the work order's Verify list):
 *   (a) Go red + a DeepSeek model + off-peak 11:00Z + armed + a ready terminal -> NOT held;
 *   (b) the same at peak 02:00Z                                              -> held;
 *   (c) a Kimi model at off-peak                                             -> NOT held (policy maps it);
 *   (d) a terminal that cannot launch DeepSeek (no login)                    -> held;
 *   (e) Go amber / green                                                     -> unchanged.
 * Plus: an armed-but-keyless box keeps waiting (behaviour as today).
 *
 * Read-only and ISOLATED: COMPANY_ROOT is pointed at a temp dir before any module resolves
 * it, so the check cannot read the live budget state or spend a live CEO grant, and it
 * writes nothing into company/. It spawns no terminal.
 *
 *   npx tsx ops/budget-guard-direct-check.ts
 */
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// MUST run before org.ts is imported (COMPANY_ROOT is read at import time).
const TEMP_ROOT = path.join(os.tmpdir(), `jcode-budget-guard-direct-${process.pid}`);
fs.mkdirSync(TEMP_ROOT, { recursive: true });
process.env.COMPANY_ROOT = TEMP_ROOT;
delete process.env.BUDGET_OVERRIDE; // a live override would open every queue below

const budget = await import("../src/company/budgetGuard.js");
const fleet = await import("../src/company/fleet.js");
const direct = await import("../src/company/deepseekDirect.js");
const usage = await import("../src/company/usage.js");

type Snap = NonNullable<ReturnType<typeof budget.readBudgetState>>;
type Level = "red" | "amber" | "green";

/** A synthetic snapshot built from the guard's OWN rulesFor(), so the red rules (queue
 *  non-urgent, cheapest models) are the real ones and the numbers cannot drift. */
function snapWith(go: Level, claude: Level = "green"): Snap {
  return {
    version: 1,
    checkedAt: new Date().toISOString(),
    pollS: 300,
    thresholds: { greenMin: 40, amberMin: 15 },
    levels: { go, claude },
    providers: {
      go: { id: "go", label: "OpenCode Go", level: go, connected: true, remainingPct: go === "red" ? 6 : 70, source: "check" },
      claude: { id: "claude", label: "Claude", level: claude, connected: true, remainingPct: 80, source: "check" },
    },
    rules: budget.rulesFor(go, claude),
    effects: [],
    needsYou: null,
    spend: { lastHourUsd: 0, last24hUsd: 0, todayUsd: 0, byModel: {} },
    samples: [],
    detail: "ops/budget-guard-direct-check.ts (synthetic)",
  } as unknown as Snap;
}

const OFFPEAK = "2026-10-01T11:00:00Z"; // Thu 16:30 IST
const PEAK = "2026-10-01T02:00:00Z"; //    Thu 07:30 IST
const DEEPSEEK = "deepseek-v4.1-flash";
const KIMI = "kimi-k2.7-code";

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${label}\n        ${detail}\n`);
  if (!ok) failures++;
}

/** The real gate decision, run exactly as fillSlotsNow runs it. */
async function gate(level: Level, model: string, at: string): Promise<{ hold: boolean; reason: string; direct?: { use: boolean; model: string; provider: string } }> {
  const snap = snapWith(level);
  const q = budget.fleetQueueForBudget(false, snap);
  return fleet.fleetBudgetHold(q, model, new Date(at));
}

async function main(): Promise<void> {
  process.stdout.write("budget guard x DeepSeek direct: does a Fleet order still wait?\n");
  process.stdout.write("=".repeat(78) + "\n\n");

  const saved = {
    flag: process.env.DEEPSEEK_DIRECT,
    key: process.env.DEEPSEEK_API_KEY,
    ready: process.env.FLEET_DEEPSEEK_DIRECT_READY,
    bin: process.env.JCODE_BIN,
    // The clock is pinned with `at` below, so the two env switches that widen/keep the direct
    // window must be pinned too: `.env` now sets DEEPSEEK_DIRECT_ALL_HOURS=1 (CEO order
    // 2026-10-01) and the manager later sets FLEET_DEEPSEEK_ONLY=1, either of which would make
    // the peak/Kimi cases assert something other than the rule they name.
    allHours: process.env.DEEPSEEK_DIRECT_ALL_HOURS,
    deepseekOnly: process.env.FLEET_DEEPSEEK_ONLY,
  };
  // Arm the provider explicitly (this box may be unarmed) and require a ready terminal.
  process.env.DEEPSEEK_DIRECT = "1";
  process.env.DEEPSEEK_API_KEY = "check-only-not-a-real-key";
  process.env.FLEET_DEEPSEEK_DIRECT_READY = "1";
  delete process.env.DEEPSEEK_DIRECT_ALL_HOURS;
  delete process.env.FLEET_DEEPSEEK_ONLY;
  direct.resetFleetDirectReady();
  // A KNOWN healthy Go snapshot: (b) proves "peak -> held" for a KNOWN quota. CEO order 2026-10-02
  // (B) routes UNKNOWN quota direct instead, proven by ops/deepseek-policy-check.ts.
  usage.setGoUsageCache({
    connected: true,
    source: "api",
    windows: [],
    remainingPct: 63,
    usedPct: 37,
    bindingWindow: "weekly",
    resetsAt: "2026-10-05T00:00:00Z",
    detail: "ops/budget-guard-direct-check.ts (injected)",
    checkedAt: new Date().toISOString(),
  } as import("../src/company/usage.js").GoQuota);

  try {
    // Precondition: the guard really does queue a non-urgent order while Go is red.
    const red = snapWith("red");
    const q = budget.fleetQueueForBudget(false, red);
    check(
      "precondition: Go red + non-urgent -> the guard queues",
      q.queue === true,
      `queue=${q.queue} :: ${q.reason}`,
    );

    // (a) red + deepseek + off-peak + armed + ready -> NOT held.
    const a = await gate("red", DEEPSEEK, OFFPEAK);
    check(
      "(a) red + deepseek model + off-peak 11:00Z + armed + ready -> NOT held",
      a.hold === false && a.reason === fleet.FLEET_DIRECT_SKIP_REASON,
      `hold=${a.hold} :: ${a.reason}`,
    );
    check(
      "(a) ... and the plan really is DeepSeek direct",
      a.direct?.use === true && a.direct?.provider === "deepseek" && a.direct?.model === "deepseek-flash",
      JSON.stringify(a.direct ?? null),
    );

    // (b) the same at peak -> held.
    const b = await gate("red", DEEPSEEK, PEAK);
    check("(b) same at peak 02:00Z -> held", b.hold === true, `hold=${b.hold} :: ${b.reason}`);

    // (c) a Kimi model at off-peak -> NOT held: the routing POLICY (CEO order 2026-10-02) maps
    // kimi/glm/qwen onto DeepSeek direct when it says direct (off-peak, or Go quota < 10%), so the
    // order spends no Go quota and the hold protects nothing.
    const c = await gate("red", KIMI, OFFPEAK);
    check("(c) red + Kimi model + off-peak -> NOT held (kimi maps to DeepSeek direct)", c.hold === false && c.direct?.use === true && c.direct?.model === "deepseek-flash", `hold=${c.hold} :: ${c.reason}`);

    // (d) no launchable DeepSeek terminal -> held, exactly as before.
    delete process.env.FLEET_DEEPSEEK_DIRECT_READY;
    process.env.JCODE_BIN = "jcode-no-such-binary-for-this-check";
    direct.resetFleetDirectReady();
    const ready = await direct.fleetDirectReady();
    check("(d) an unlaunchable provider -> fleetDirectReady() is false", ready === false, `fleetDirectReady=${ready}`);
    const d = await gate("red", DEEPSEEK, OFFPEAK);
    check("(d) not ready -> held", d.hold === true, `hold=${d.hold} :: ${d.reason}`);

    // (d2) evidence: the REAL probe on this box right now.
    if (saved.bin === undefined) delete process.env.JCODE_BIN;
    else process.env.JCODE_BIN = saved.bin;
    direct.resetFleetDirectReady();
    const realReady = await direct.fleetDirectReady();
    process.stdout.write(
      `INFO  real \`jcode model list -p deepseek\` probe on this box: fleetDirectReady=${realReady}` +
        `${realReady ? " (the CEO has logged the provider in)" : " -> every hold stays exactly as today until the CEO runs: jcode login --provider deepseek"}\n`,
    );

    // (e) amber and green: the guard never queues, so nothing changes.
    for (const level of ["amber", "green"] as const) {
      for (const at of [OFFPEAK, PEAK]) {
        const h = await gate(level, DEEPSEEK, at);
        check(
          `(e) Go ${level} -> not held, unchanged (deepseek model at ${at})`,
          h.hold === false && h.direct === undefined && new RegExp(`OpenCode Go ${level}`).test(h.reason),
          `hold=${h.hold} :: ${h.reason}`,
        );
      }
    }

    // Extra: armed but no key -> held, exactly as before.
    process.env.FLEET_DEEPSEEK_DIRECT_READY = "1";
    delete process.env.DEEPSEEK_API_KEY;
    const nokey = await gate("red", DEEPSEEK, OFFPEAK);
    check("extra: DEEPSEEK_DIRECT=1 but no key -> held", nokey.hold === true, `hold=${nokey.hold} :: ${nokey.reason}`);
  } finally {
    for (const [k, v] of Object.entries({
      DEEPSEEK_DIRECT: saved.flag,
      DEEPSEEK_API_KEY: saved.key,
      FLEET_DEEPSEEK_DIRECT_READY: saved.ready,
      JCODE_BIN: saved.bin,
      DEEPSEEK_DIRECT_ALL_HOURS: saved.allHours,
      FLEET_DEEPSEEK_ONLY: saved.deepseekOnly,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    direct.resetFleetDirectReady();
    try {
      fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  process.stdout.write(`\n${failures === 0 ? "OK - all cases pass" : `${failures} FAILURE(S)`}\n`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => {
  process.stderr.write(`budget-guard-direct-check failed: ${String(e)}\n`);
  process.exitCode = 1;
});
