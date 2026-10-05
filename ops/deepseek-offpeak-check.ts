/**
 * ops/deepseek-offpeak-check.ts — proof for the DeepSeek direct off-peak routing
 * (docs/DEEPSEEK_DIRECT.md, CEO order 2026-10-01).
 *
 * Rule now tested (POLICY-GO-FIRST 2026-10-06): healthy Go quota stays on Go at any hour; off-peak direct is opt-in (DEEPSEEK_OFFPEAK_DIRECT=1).
 *
 * Three things, in order:
 *   1. WINDOW MATH: the clock against known timestamps (weekday peak, the 04:00-06:00 UTC
 *      gap, the UTC weekend, the weekend roll into Monday), plus the IST rendering.
 *   2. NOW: the current phase, both clocks, and whether a DeepSeek call would go direct.
 *   3. LIVE (only when a key is present): ONE minimal chat completion against DeepSeek's
 *      own API, printing the reply, token usage and the exact reason if it fails. With no
 *      key it prints the top-up instructions and exits 0 - it is a check, not a gate.
 *
 * Read-only apart from that single opt-in call. Never prints the key.
 *
 *   npx tsx ops/deepseek-offpeak-check.ts          # windows + now + live if keyed
 *   npx tsx ops/deepseek-offpeak-check.ts --no-live  # windows + now only
 */
import "dotenv/config";
import { deepseekClock, DEEPSEEK_IST_WINDOWS, isDeepseekPeak, nextDeepseekPhaseChange, formatIst } from "../src/company/offpeak.js";
import { deepseekDirectModel, deepseekDirectPlan, deepseekDirectStatus } from "../src/company/deepseekDirect.js";
import { setGoUsageCache } from "../src/company/usage.js";
import { modelCatalog } from "../src/adaptive/catalog.js";
import { callDeepseekDirect } from "../src/gateway.js";

const NO_LIVE = process.argv.includes("--no-live");
let failures = 0;

function check(label: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}\n`);
}

function phaseAt(iso: string): string {
  return isDeepseekPeak(new Date(iso)) ? "peak" : "off-peak";
}

async function main() {
  process.stdout.write("DeepSeek off-peak check (docs/DEEPSEEK_DIRECT.md)\n");
  process.stdout.write("=".repeat(78) + "\n\n");

  // 1. Window math. 2026-10-01 is a Thursday; 2026-10-03/04 are Sat/Sun.
  process.stdout.write("WINDOW MATH (peak = 01:00-04:00 and 06:00-10:00 UTC, Mon-Fri)\n");
  check("Thu 11:00Z (16:30 IST) off-peak", phaseAt("2026-10-01T11:00:00Z"), "off-peak");
  check("Thu 02:00Z (07:30 IST) peak", phaseAt("2026-10-01T02:00:00Z"), "peak");
  check("Thu 08:00Z (13:30 IST) peak", phaseAt("2026-10-01T08:00:00Z"), "peak");
  check("Thu 05:00Z (10:30 IST) off-peak (gap between blocks)", phaseAt("2026-10-01T05:00:00Z"), "off-peak");
  check("Thu 01:00Z boundary -> peak", phaseAt("2026-10-01T01:00:00Z"), "peak");
  check("Thu 04:00Z boundary -> off-peak", phaseAt("2026-10-01T04:00:00Z"), "off-peak");
  check("Thu 10:00Z boundary -> off-peak", phaseAt("2026-10-01T10:00:00Z"), "off-peak");
  check("Sat 02:00Z (weekend) off-peak", phaseAt("2026-10-03T02:00:00Z"), "off-peak");
  check("Sun 08:00Z (weekend) off-peak", phaseAt("2026-10-04T08:00:00Z"), "off-peak");
  check(
    "Fri 23:00Z next change = Mon 01:00Z (whole weekend off-peak)",
    nextDeepseekPhaseChange(new Date("2026-10-02T23:00:00Z")).toISOString(),
    "2026-10-05T01:00:00.000Z",
  );
  check("IST rendering", formatIst(new Date("2026-10-01T11:00:00Z")), "2026-10-01 16:30 IST (Thu)");

  // 2. Now.
  const now = new Date();
  const clock = deepseekClock(now);
  const status = deepseekDirectStatus(now);
  process.stdout.write("\nNOW\n");
  process.stdout.write(`  UTC            ${clock.utc}\n`);
  process.stdout.write(`  IST            ${clock.ist}\n`);
  process.stdout.write(`  phase          ${clock.phase} (${clock.multiplier}x)\n`);
  process.stdout.write(`  next change    ${clock.nextChangeUtc}  |  ${clock.nextChangeIst}  (in ${clock.minutesToChange}m)\n`);
  process.stdout.write(`  clear of the 45m boundary buffer: ${clock.clearOfBoundary}\n`);
  process.stdout.write(`  IST windows    peak ${DEEPSEEK_IST_WINDOWS.peak.join(" & ")} | off-peak ${DEEPSEEK_IST_WINDOWS.offPeak.join(", ")}\n`);
  process.stdout.write("\nROUTING\n");
  process.stdout.write(`  DEEPSEEK_DIRECT armed: ${status.armed}   key present: ${status.keyPresent}\n`);
  process.stdout.write(`  fleet provider: ${status.provider}\n`);
  process.stdout.write(`  sample (${status.sampleModel}): use=${status.plan.use} -> ${status.plan.model} @ ${status.plan.baseUrl}\n`);
  process.stdout.write(`  why: ${status.plan.why}\n`);

  // 2b. The gate, made deterministic with a FAKE key so nothing can reach the network. The
  // real environment is saved first: this box may itself be armed, so "unarmed" is built
  // explicitly rather than assumed.
  const saved = { flag: process.env.DEEPSEEK_DIRECT, key: process.env.DEEPSEEK_API_KEY, model: process.env.DEEPSEEK_DIRECT_MODEL, allHours: process.env.DEEPSEEK_DIRECT_ALL_HOURS, offpeakDirect: process.env.DEEPSEEK_OFFPEAK_DIRECT };
  // The cases below pin the CLOCK with explicit timestamps, so the "also at peak" switch must be
  // cleared: `.env` sets DEEPSEEK_DIRECT_ALL_HOURS=1 (CEO order 2026-10-01), which would make the
  // peak cases assert the wrong rule. It is exercised explicitly a few lines below instead.
  delete process.env.DEEPSEEK_DIRECT_ALL_HOURS;
  // POLICY-GO-FIRST: off-peak direct is now an OPT-IN, so pin it OFF for the default cases below
  // and set it per case where the old rule is the one under test.
  delete process.env.DEEPSEEK_OFFPEAK_DIRECT;
  const hasBankNote = () => modelCatalog().some((m) => /DeepSeek direct API/.test(m.label));
  process.stdout.write("\nGATE (fake key in-process; no call is made)\n");

  // UNARMED #1 - no flag at all.
  delete process.env.DEEPSEEK_DIRECT;
  delete process.env.DEEPSEEK_API_KEY;
  const un1 = deepseekDirectPlan("deepseek-v4.1-flash", new Date("2026-10-01T11:00:00Z"));
  check("DEEPSEEK_DIRECT unset -> no direct", un1.use, false);
  check("DEEPSEEK_DIRECT unset -> no direct bank in Laya's catalogue", hasBankNote(), false);

  // UNARMED #2 - flag on, no key.
  process.env.DEEPSEEK_DIRECT = "1";
  const un2 = deepseekDirectPlan("deepseek-v4.1-flash", new Date("2026-10-01T11:00:00Z"));
  check("no key -> no direct", un2.use, false);
  check("no key -> no direct bank in Laya's catalogue", hasBankNote(), false);
  check("no key -> the reason names the missing key", /DEEPSEEK_API_KEY/.test(un2.why), true);

  // ARMED.
  process.env.DEEPSEEK_API_KEY = "check-only-not-a-real-key";
  delete process.env.DEEPSEEK_DIRECT_MODEL;
  // A KNOWN healthy Go snapshot: "peak -> stays on Go" is a rule about KNOWN quota. CEO order
  // 2026-10-02 (B) makes UNKNOWN quota route direct instead, so pin a healthy snapshot here.
  setGoUsageCache({
    connected: true,
    source: "api",
    windows: [],
    remainingPct: 63,
    usedPct: 37,
    bindingWindow: "weekly",
    resetsAt: "2026-10-05T00:00:00Z",
    detail: "ops/deepseek-offpeak-check.ts (injected)",
    checkedAt: "2026-10-01T11:00:00Z",
  } as import("../src/company/usage.js").GoQuota);
  // POLICY-GO-FIRST changed the default, so this case pins the opt-in to keep testing the preserved
  // 2026-10-01 rule ("off-peak -> direct"); the new default is checked after the block below.
  process.env.DEEPSEEK_OFFPEAK_DIRECT = "1";
  const offPlan = deepseekDirectPlan("deepseek-v4.1-flash", new Date("2026-10-01T11:00:00Z"));
  check("armed, off-peak + DEEPSEEK_OFFPEAK_DIRECT=1 -> direct (the old rule)", offPlan.use, true);
  check("fleet id deepseek-v4.1-flash -> direct id deepseek-flash", offPlan.model, "deepseek-flash");
  check("Go id deepseek-v4-flash -> direct id deepseek-flash", deepseekDirectModel("deepseek-v4-flash"), "deepseek-flash");
  check("an already-direct id stays deepseek-flash", deepseekDirectModel("deepseek-flash"), "deepseek-flash");
  check("pro -> deepseek-flash (CEO order A: flash only)", deepseekDirectPlan("deepseek-v4-pro", new Date("2026-10-01T11:00:00Z")).model, "deepseek-flash");
  check("reasoner -> deepseek-flash (CEO order A: flash only)", deepseekDirectModel("deepseek-reasoner"), "deepseek-flash");
  check("direct plan names the direct provider", offPlan.provider, "deepseek");
  check("armed -> Laya's catalogue names the direct bank", hasBankNote(), true);
  check("armed -> no new model id is invented for the catalogue", modelCatalog().some((m) => /^deepseek-flash$/.test(m.id)), false);
  check("peak 02:00Z -> stays on Go", deepseekDirectPlan("deepseek-v4.1-flash", new Date("2026-10-01T02:00:00Z")).use, false);
  check(
    "30m before a peak block -> stays on Go (boundary buffer)",
    deepseekDirectPlan("deepseek-v4.1-flash", new Date("2026-10-01T00:30:00Z")).use,
    false,
  );
  delete process.env.DEEPSEEK_OFFPEAK_DIRECT;
  // POLICY-GO-FIRST (CEO order 2026-10-06): the NEW DEFAULT. A healthy Go window carries off-peak
  // work on OpenCode Go and spends no credits; the opt-in above is what restores direct.
  const offPeakDefault = deepseekDirectPlan("deepseek-v4.1-flash", new Date("2026-10-01T11:00:00Z"));
  check("off-peak + healthy quota (no opt-in) -> OpenCode Go, no credits", offPeakDefault.use, false);
  check("...and the why is the go-first sentence", /using OpenCode Go, no credits spent/.test(offPeakDefault.why), true);
  // The .env line the CEO order added: DEEPSEEK_DIRECT_ALL_HOURS=1 routes at peak too (paying 2x,
  // still spending no Go quota). Both blocks, so the flag cannot be half-wired.
  process.env.DEEPSEEK_DIRECT_ALL_HOURS = "1";
  check(
    "peak 02:00Z + DEEPSEEK_DIRECT_ALL_HOURS=1 -> direct (the .env line)",
    deepseekDirectPlan("deepseek-v4.1-flash", new Date("2026-10-01T02:00:00Z")).use,
    true,
  );
  check(
    "peak 08:00Z + DEEPSEEK_DIRECT_ALL_HOURS=1 -> direct",
    deepseekDirectPlan("deepseek-v4.1-flash", new Date("2026-10-01T08:00:00Z")).use,
    true,
  );
  delete process.env.DEEPSEEK_DIRECT_ALL_HOURS;
  // ROUTING POLICY (POLICY-GO-FIRST, CEO order 2026-10-06): Kimi/GLM/Qwen picks are MAPPED to
  // DeepSeek only when the plan body says direct (known quota < 10%, a fresh Go 429, or the
  // DEEPSEEK_OFFPEAK_DIRECT=1 opt-in at off-peak). At peak with a KNOWN healthy quota a kimi pick
  // stays on Go, and an UNKNOWN quota stays on Go too (never spend credits on a guess).
  process.env.DEEPSEEK_OFFPEAK_DIRECT = "1";
  const kimiOff = deepseekDirectPlan("kimi-k2.7-code", new Date("2026-10-01T11:00:00Z"));
  check("a kimi pick maps to DeepSeek direct at off-peak + DEEPSEEK_OFFPEAK_DIRECT=1", kimiOff.use, true);
  check("a kimi pick maps to deepseek-flash", kimiOff.model, "deepseek-flash");
  delete process.env.DEEPSEEK_OFFPEAK_DIRECT;
  check("a kimi pick stays on Go at peak with a KNOWN healthy quota", deepseekDirectPlan("kimi-k2.7-code", new Date("2026-10-01T02:00:00Z")).use, false);
  setGoUsageCache(null);
  check(
    "a kimi pick stays on Go at peak when the Go quota is UNKNOWN (POLICY-GO-FIRST)",
    deepseekDirectPlan("kimi-k2.7-code", new Date("2026-10-01T02:00:00Z")).use,
    false,
  );

  // restore the real environment before the live call
  if (saved.flag === undefined) delete process.env.DEEPSEEK_DIRECT;
  else process.env.DEEPSEEK_DIRECT = saved.flag;
  if (saved.key === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = saved.key;
  if (saved.model !== undefined) process.env.DEEPSEEK_DIRECT_MODEL = saved.model;
  if (saved.allHours === undefined) delete process.env.DEEPSEEK_DIRECT_ALL_HOURS;
  else process.env.DEEPSEEK_DIRECT_ALL_HOURS = saved.allHours;
  if (saved.offpeakDirect === undefined) delete process.env.DEEPSEEK_OFFPEAK_DIRECT;
  else process.env.DEEPSEEK_OFFPEAK_DIRECT = saved.offpeakDirect;

  // 3. Live call.
  process.stdout.write("\nLIVE\n");
  if (NO_LIVE) {
    process.stdout.write("  skipped (--no-live)\n");
  } else if (!status.keyPresent) {
    process.stdout.write(
      "  skipped: no DEEPSEEK_API_KEY.\n" +
        "  Top up at https://platform.deepseek.com (the balance is shown there; there is no\n" +
        "  auto-recharge), create a key, then put it in .env as DEEPSEEK_API_KEY=...\n",
    );
  } else {
    const t0 = Date.now();
    // SEND THE MAPPED ID. The raw Go id (deepseek-v4.1-flash) is a 400 on this API; the
    // direct ids are deepseek-flash and deepseek-v4-pro (GET /models, 2026-10-01).
    const liveModel = status.plan.model;
    process.stdout.write(`  model sent: ${liveModel}\n`);
    try {
      // The direct models are REASONING models (`completion_tokens_details.reasoning_tokens`),
      // and reasoning is billed INSIDE max_tokens - at 8 the whole budget went to reasoning and
      // the visible answer was truncated (measured 2026-10-01). 64 is enough for a short reply
      // while still a trivial, near-free call. `effort`/`reasoning_effort: "low"` were both
      // accepted by the API and did NOT reliably cut reasoning tokens, so neither is sent.
      const out = await callDeepseekDirect(liveModel, "You are a terse checker.", "Reply with exactly: OK", {
        maxTokens: 64,
      });
      process.stdout.write(`  reply: ${JSON.stringify(out.text)}  (${Date.now() - t0}ms)\n`);
      process.stdout.write(`  usage: ${JSON.stringify(out.usage ?? {})}\n`);
    } catch (e) {
      failures++;
      process.stdout.write(`  FAILED after ${Date.now() - t0}ms: ${String(e).slice(0, 300)}\n`);
      process.stdout.write(
        "  A 401 \"Authentication Fails ... invalid\" means the key was created before the\n" +
          "  account was funded, or is not a DeepSeek key: top up, make a new key.\n",
      );
    }
  }

  process.stdout.write(`\n${failures === 0 ? "OK" : `${failures} FAILURE(S)`}\n`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => {
  process.stderr.write(`deepseek-offpeak-check failed: ${String(e)}\n`);
  process.exitCode = 1;
});
