// ops/budget-selftest.ts - BUDGET (docs/BUDGET_SPEC.md "Proof"): the forced-amber
// test and the rule-table checks, against the REAL live numbers, with no writes.
//
//   npx tsx ops/budget-selftest.ts
//
// What it proves, in order:
//   1. the live read of both providers (real remaining %), and the levels the
//      default thresholds give;
//   2. levelFor() boundaries (green > 40, amber 15-40, red < 15);
//   3. FORCED AMBER (env override on the thresholds, so the real measured
//      remaining % lands in amber): a Kimi worker pick becomes DeepSeek, the
//      assistant's Opus pick becomes Sonnet, Fleet parallelism is clamped to 10;
//   4. FORCED RED: only the cheapest models survive, an ordinary Claude role
//      moves to DeepSeek, a "review" role keeps Claude, Fleet is clamped to 3,
//      a non-urgent Fleet order queues with "waiting for budget";
//   5. the CEO override (BUDGET_OVERRIDE=1) beats every rule;
//   6. NOT CONNECTED (no key, no cookie): connected:false, the exact
//      "not connected: add OPENCODE_SESSION_COOKIE" instruction, level unknown,
//      and NO restriction applied.
//
// Nothing here writes to the live company/ folder: it uses buildSnapshot(), not
// refreshBudgetState(). It never prints a secret.

import "dotenv/config";
import {
  applyBudgetFilter, assistantModelFor, budgetOverridden, budgetPressure, buildSnapshot,
  fleetMaxParallel, fleetQueueForBudget, levelFor, modelCanReadFiles, rulesFor,
  type BudgetSnapshot,
} from "../src/company/budgetGuard.js";
import { openCodeGoUsage, parseGoQuotaPayload } from "../src/company/usage.js";

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n        ${detail}`);
  if (!ok) failures += 1;
}

function saveEnv(names: string[]): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const n of names) saved[n] = process.env[n];
  return saved;
}
function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const ENV_KEYS = [
  "BUDGET_GREEN_MIN", "BUDGET_AMBER_MIN", "BUDGET_OVERRIDE",
  "OPENCODE_API_KEY", "OPENCODE_SESSION_COOKIE",
  "BUDGET_GO_CHEAP_MODELS", "BUDGET_GO_FORBIDDEN_MODELS",
];

async function main(): Promise<void> {
  const saved = saveEnv(ENV_KEYS);
  try {
    // ---------------------------------------------------------------- 1. live
    console.log("=== 1. LIVE READ (real numbers, no env overrides) ===");
    const live = await budgetPressure({ fresh: true });
    for (const p of live.providers) {
      console.log(
        `  ${p.label}: level=${p.level} remaining=${p.remainingPct ?? "?"}% window=${p.bindingWindow ?? "-"} ` +
          `resets in ${p.resetsIn ?? "-"} burn=$${(p.burnPerHour ?? 0).toFixed(4)}/h source=${p.source}`,
      );
    }
    check(
      "OpenCode Go reports a real remaining percentage from the key-based API",
      live.providers[0]!.connected && typeof live.providers[0]!.remainingPct === "number",
      `connected=${live.providers[0]!.connected} source=${live.providers[0]!.source} remaining=${live.providers[0]!.remainingPct}%`,
    );
    check(
      "Claude reports the real 5-hour/7-day windows",
      live.providers[1]!.connected,
      `connected=${live.providers[1]!.connected} remaining=${live.providers[1]!.remainingPct}% detail=${live.providers[1]!.detail.slice(0, 120)}`,
    );

    // ------------------------------------------------------------ 2. boundaries
    console.log("\n=== 2. levelFor() boundaries (green > 40, amber 15-40, red < 15) ===");
    const b = [levelFor(41), levelFor(40), levelFor(15), levelFor(14.9), levelFor(undefined)];
    check("41% -> green, 40% -> amber, 15% -> amber, 14.9% -> red, undefined -> unknown",
      b.join(",") === "green,amber,amber,red,unknown", `levelFor(41,40,15,14.9,undefined) = ${b.join(", ")}`);

    // ----------------------------------------------------------- 3. forced amber
    console.log("\n=== 3. FORCED AMBER (env override: GREEN_MIN=99, AMBER_MIN=0 => any measured remaining is amber) ===");
    // REAL-BUDGET (2026-10-01): the old setup assumed the LIVE Go reading landed
    // between 15% and 99% left. The real weekly window is now ~6% left, i.e. RED, so
    // this check failed on live data instead of on behaviour. AMBER_MIN=0 makes
    // "amber" deterministic for any measured remaining percentage.
    process.env.BUDGET_GREEN_MIN = "99";
    process.env.BUDGET_AMBER_MIN = "0";
    delete process.env.BUDGET_OVERRIDE;
    const amber: BudgetSnapshot = await buildSnapshot({});
    console.log(`  levels: go=${amber.levels.go} claude=${amber.levels.claude} thresholds=${JSON.stringify(amber.thresholds)}`);
    check("forced amber actually lands in amber", amber.levels.go === "amber", `go level = ${amber.levels.go} (remaining ${amber.providers.go.remainingPct}%)`);
    const kimi = applyBudgetFilter({ model: "kimi-k2.7-code", role: "worker" }, amber);
    check("Kimi pick under Go amber becomes deepseek-v4.1-flash",
      kimi.model === "deepseek-v4.1-flash" && kimi.changed,
      `kimi-k2.7-code -> ${kimi.model} (${kimi.reason})`);
    const pro = applyBudgetFilter({ model: "deepseek-v4-pro", role: "worker" }, amber);
    check("deepseek-v4-pro under Go amber becomes deepseek-v4.1-flash",
      pro.model === "deepseek-v4.1-flash",
      `deepseek-v4-pro -> ${pro.model} (${pro.reason})`);
    const glm = applyBudgetFilter({ model: "glm-5.3-flash", role: "worker" }, amber);
    check("the cheapest model is untouched under amber", glm.model === "glm-5.3-flash" && !glm.changed, `glm-5.3-flash -> ${glm.model}`);
    for (const [claudeLevel, label] of [["amber", "claude amber"], ["red", "claude red"]] as const) {
      process.env.BUDGET_GREEN_MIN = "99";
      // amber: every measured remaining % is >= 0, so AMBER_MIN=0 puts it in amber
      // (the live 5-hour window is at 0% left, i.e. 100% used, right now).
      process.env.BUDGET_AMBER_MIN = claudeLevel === "amber" ? "0" : "99";
      const snap = await buildSnapshot({});
      if (snap.levels.claude === claudeLevel) {
        const asst = assistantModelFor("claude-opus-5-5", "assistant", snap);
        const expected = claudeLevel === "amber" ? "claude-sonnet-5-5" : "deepseek-v4.1-flash";
        check(`assistant Opus under ${label} becomes ${expected}`, asst === expected, `claude-opus-5-5 -> ${asst}`);
        const review = applyBudgetFilter({ model: "claude-opus-5-5", role: "review" }, snap);
        check(`a "review" role keeps Claude under ${label}`, review.model === "claude-opus-5-5", `claude-opus-5-5 -> ${review.model} (${review.reason})`);
      } else {
        console.log(`  (skipped: claude level is ${snap.levels.claude}, not ${claudeLevel} with these thresholds)`);
      }
    }
    process.env.BUDGET_GREEN_MIN = "99";
    process.env.BUDGET_AMBER_MIN = "0";
    // REAL-BUDGET (2026-10-01): the built-in amber=10 / red=3 fleet caps were removed
    // by the CEO's earlier "Cap + spam" order (budgetGuard.ts envNumSet). The cap now
    // applies ONLY when the CEO sets BUDGET_FLEET_MAX_PARALLEL_*; set it here so this
    // verifies the env-knob path that actually exists.
    process.env.BUDGET_FLEET_MAX_PARALLEL_AMBER = "10";
    const amber2 = await buildSnapshot({});
    check("Fleet parallelism is clamped to 10 when BUDGET_FLEET_MAX_PARALLEL_AMBER is set",
      fleetMaxParallel(30, amber2) === 10,
      `fleetMaxParallel(30) = ${fleetMaxParallel(30, amber2)} (rules.go.fleetMaxParallel=${amber2.rules.go.fleetMaxParallel})`);
    delete process.env.BUDGET_FLEET_MAX_PARALLEL_AMBER;

    // ------------------------------------------------------------- 4. forced red
    console.log("\n=== 4. FORCED RED (env override: BUDGET_AMBER_MIN=99 => everything below 99% is red) ===");
    process.env.BUDGET_GREEN_MIN = "99";
    process.env.BUDGET_AMBER_MIN = "99";
    const red: BudgetSnapshot = await buildSnapshot({});
    console.log(`  levels: go=${red.levels.go} claude=${red.levels.claude}`);
    check("forced red actually lands in red", red.levels.go === "red" && red.levels.claude === "red", `go=${red.levels.go} claude=${red.levels.claude}`);
    const kimiRed = applyBudgetFilter({ model: "kimi-k2.7-code", role: "worker" }, red);
    check("under Go red even Kimi becomes a cheapest model",
      red.rules.go.cheapestModels.includes(kimiRed.model),
      `kimi-k2.7-code -> ${kimiRed.model} (${kimiRed.reason})`);
    const claudeRed = applyBudgetFilter({ model: "claude-opus-5-5", role: "assistant" }, red);
    check("under Claude red the assistant runs on DeepSeek",
      claudeRed.model === "deepseek-v4.1-flash",
      `claude-opus-5-5 (assistant) -> ${claudeRed.model} (${claudeRed.reason})`);
    // REAL-BUDGET (2026-10-01): same as amber above - the built-in red cap was removed;
    // verify the env-knob path.
    process.env.BUDGET_FLEET_MAX_PARALLEL_RED = "3";
    const redWithCap = await buildSnapshot({});
    check("Fleet parallelism is clamped to 3 when BUDGET_FLEET_MAX_PARALLEL_RED is set", fleetMaxParallel(30, redWithCap) === 3, `fleetMaxParallel(30) = ${fleetMaxParallel(30, redWithCap)}`);
    delete process.env.BUDGET_FLEET_MAX_PARALLEL_RED;
    const queued = fleetQueueForBudget(false, red);
    check("a non-urgent Fleet order queues with a 'waiting for budget' reason",
      queued.queue && /waiting for budget/.test(queued.reason), `queue=${queued.queue} reason="${queued.reason}"`);
    check("an urgent Fleet order is not queued", fleetQueueForBudget(true, red).queue === false, `queue=${fleetQueueForBudget(true, red).queue}`);
    check("red produces a 'Needs you' item", !!red.needsYou, red.needsYou ? red.needsYou.text : "none");
    // ATTACH (llama, 21:38Z) found this in production: under Claude red the
    // assistant is moved to DeepSeek, which CANNOT read an attached file. The
    // filter now says so in machine-readable form.
    const attach = applyBudgetFilter({ model: "claude-opus-5-5", role: "assistant", needsFileRead: true }, red);
    check("an attached-file request under Claude red reports lostFileRead",
      attach.lostFileRead === true && !modelCanReadFiles(attach.model),
      `claude-opus-5-5 (needsFileRead) -> ${attach.model} lostFileRead=${attach.lostFileRead} | ${attach.reason}`);
    const attachGreen = applyBudgetFilter(
      { model: "claude-opus-5-5", role: "assistant", needsFileRead: true },
      { ...red, levels: { go: "green", claude: "green" }, rules: rulesFor("green", "green") },
    );
    check("the same request under GREEN keeps Claude and reports no loss",
      attachGreen.model === "claude-opus-5-5" && !attachGreen.lostFileRead && modelCanReadFiles(attachGreen.model),
      `claude-opus-5-5 -> ${attachGreen.model} lostFileRead=${attachGreen.lostFileRead ?? false}`);
    check("the red rules table is visible in the snapshot", red.rules.go.level === "red" && red.rules.claude.level === "red", `${red.rules.go.note} ${red.rules.claude.note}`);
    // ATTACH (llama) proved this in production at 21:47Z: the DeepSeek fallback
    // cannot open attached files, so the CEO-facing words must say it.
    check("the red effects and rules name the attachment consequence",
      red.effects.some((e: string) => /attach/i.test(e)) && /attach/i.test(red.rules.claude.note),
      red.effects.filter((e: string) => /attach/i.test(e)).join(" | ") || "(no effect line mentions attachments)");

    // ---------------------------------------------------------------- 5. override
    console.log("\n=== 5. CEO OVERRIDE (BUDGET_OVERRIDE=1) ===");
    process.env.BUDGET_OVERRIDE = "1";
    const overridden = applyBudgetFilter({ model: "kimi-k2.7-code", role: "worker" }, red);
    check("the CEO override wins over the red rule", overridden.model === "kimi-k2.7-code" && budgetOverridden(), `kimi-k2.7-code -> ${overridden.model} (${overridden.reason})`);
    delete process.env.BUDGET_OVERRIDE;

    // ------------------------------------------------------------- 6. not connected
    console.log("\n=== 6. NOT CONNECTED (no key, no cookie) ===");
    delete process.env.OPENCODE_API_KEY;
    delete process.env.OPENCODE_SESSION_COOKIE;
    const offline = await openCodeGoUsage({ fresh: true });
    check("Go reports connected:false instead of guessing",
      !offline.connected && offline.source === "unavailable",
      `connected=${offline.connected} source=${offline.source}`);
    check("the instruction names OPENCODE_SESSION_COOKIE",
      /not connected: add OPENCODE_SESSION_COOKIE/.test(offline.detail),
      offline.detail.slice(0, 220));
    delete process.env.BUDGET_GREEN_MIN;
    delete process.env.BUDGET_AMBER_MIN;
    const unknown = rulesFor("unknown", "unknown");
    const noRule = applyBudgetFilter({ model: "kimi-k2.7-code", role: "worker" }, {
      ...red,
      levels: { go: "unknown", claude: "unknown" },
      rules: unknown,
    });
    check("an unmeasured provider applies NO restriction (and says so)",
      noRule.model === "kimi-k2.7-code",
      `kimi-k2.7-code -> ${noRule.model} (${noRule.reason})`);
    check("unknown levels say 'not measured' in plain words", /not measured/.test(unknown.go.note), unknown.go.note);

    // ------------------------------------------------------- 7. parser robustness
    console.log("\n=== 7. Go payload parser (payload shapes) ===");
    const docShape = parseGoQuotaPayload({ usage: { rolling: { status: "ok", percent: 63, resetsAt: "2026-09-29T18:08:42.544Z" }, weekly: { percent: 65 }, monthly: { percent: 32 } } });
    const flatShape = parseGoQuotaPayload({ rolling: { percent: 10 }, weekly: { percent: 20 }, monthly: { percent: 30 } });
    const junk = parseGoQuotaPayload({ nothing: true });
    check("documented {usage:{rolling,weekly,monthly}} shape parses (5-hour from rolling)",
      docShape.length === 3 && docShape[0]!.window === "5-hour" && docShape[0]!.remainingPct === 37,
      JSON.stringify(docShape));
    check("a flat shape parses too", flatShape.length === 3 && flatShape[2]!.remainingPct === 70, JSON.stringify(flatShape));
    check("an unrelated payload yields no windows (never a guess)", junk.length === 0, JSON.stringify(junk));
  } finally {
    restoreEnv(saved);
  }

  console.log("");
  if (failures > 0) {
    console.log(`SELFTEST FAILED: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("SELFTEST ALL PASS");
}

main().catch((e) => {
  console.error("selftest crashed:", String(e));
  process.exit(1);
});
