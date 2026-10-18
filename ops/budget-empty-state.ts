// ops/budget-empty-state.ts - BUDGET (docs/BUDGET_SPEC.md): the NO-MEASUREMENT
// path, i.e. exactly what `fleet.ts` and `assistant.ts` see between a fresh boot
// and the first budget poll (or forever if the state file is deleted).
//
// Run it against a company root that has no company/budget/state.json:
//
//   set COMPANY_ROOT=%TEMP%\budget-empty\company
//   npx tsx ops/budget-empty-state.ts
//
// Asserts: the state reads as undefined, the guard applies NO rule, and every
// call site the other owners wired in degrades to its own default instead of
// throwing or silently blocking work. Exits non-zero on any failure.

import fs from "node:fs";
import path from "node:path";
import { getCompanyRoot } from "../src/company/org.js";
import {
  applyBudgetFilter, assistantModelFor, budgetCostNote, budgetStatus,
  fleetMaxParallel, fleetQueueForBudget, layaBudgetState, readBudgetState, runManagerIntervalS,
  runManagerStuckOnly, briefingMinIntervalS, budgetNeedsYou,
} from "../src/company/budgetGuard.js";

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n        ${detail}`);
  if (!ok) failures += 1;
}

function main(): void {
  const root = getCompanyRoot();
  const statePath = path.join(root, "budget", "state.json");
  console.log(`company root: ${root}`);
  console.log(`state file:   ${statePath} (exists: ${fs.existsSync(statePath)})`);

  const state = readBudgetState();
  check(
    "with no state file, readBudgetState() is undefined (nothing invented)",
    state === undefined,
    `readBudgetState() -> ${state === undefined ? "undefined" : JSON.stringify(state.checkedAt)}`,
  );

  check(
    "layaBudgetState() reports unknown/unknown",
    JSON.stringify(layaBudgetState()) === JSON.stringify({ go: "unknown", claude: "unknown" }),
    JSON.stringify(layaBudgetState()),
  );
  check(
    "budgetCostNote() says it is not measured",
    /not measured/.test(budgetCostNote()),
    budgetCostNote(),
  );
  check(
    "assistantModelFor() returns the model it was given (no silent downgrade)",
    assistantModelFor("claude-opus-5-5", "assistant") === "claude-opus-5-5",
    `assistantModelFor(claude-opus-5-5, assistant) -> ${assistantModelFor("claude-opus-5-5", "assistant")}`,
  );
  check(
    "applyBudgetFilter() leaves a Kimi pick alone and says why",
    applyBudgetFilter({ model: "kimi-k2.7-code", role: "worker" }).model === "kimi-k2.7-code",
    applyBudgetFilter({ model: "kimi-k2.7-code", role: "worker" }).reason,
  );
  check(
    "fleetMaxParallel() keeps the manager's own default",
    fleetMaxParallel(30) === 30,
    `fleetMaxParallel(30) -> ${fleetMaxParallel(30)}`,
  );
  check(
    "fleetQueueForBudget() does not queue work",
    fleetQueueForBudget(false).queue === false,
    `queue=${fleetQueueForBudget(false).queue} (${fleetQueueForBudget(false).reason})`,
  );
  check(
    "run managers keep their own interval and the full check path",
    runManagerIntervalS(180) === 180 && runManagerStuckOnly() === false,
    `runManagerIntervalS(180)=${runManagerIntervalS(180)} runManagerStuckOnly()=${runManagerStuckOnly()}`,
  );
  check(
    "briefing keeps its own interval",
    briefingMinIntervalS(300) === 300,
    `briefingMinIntervalS(300) -> ${briefingMinIntervalS(300)}`,
  );
  check(
    "no 'Needs you' item is invented",
    budgetNeedsYou() === null,
    `budgetNeedsYou() -> ${budgetNeedsYou() === null ? "null" : "an item"}`,
  );
  check(
    "budgetStatus() reports the watcher state without throwing",
    typeof budgetStatus().running === "boolean",
    JSON.stringify(budgetStatus()),
  );

  console.log("");
  if (failures > 0) {
    console.log(`EMPTY-STATE CHECK FAILED: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("EMPTY-STATE CHECK ALL PASS (no measurement -> no rule, no block, no crash)");
}

main();
