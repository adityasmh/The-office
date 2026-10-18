/**
 * ops/fleet-budget-check.ts — verify the BUDGET integration inside fleet.ts
 * (docs/BUDGET_SPEC.md §2: model filter, parallelism cap, red-order queue).
 *
 * It runs the SAME call sequence `fillSlotsNow` runs, so it proves the wiring rather than
 * the guard alone. Read-only: it spawns nothing and writes no state. The forced-red case
 * uses a COPY of the live snapshot with their own `rulesFor("red", "red")`, so it does not
 * depend on env thresholds or on the providers actually being red.
 *
 *   npx tsx ops/fleet-budget-check.ts
 */
const fleet = await import("../src/company/fleet.js");
const budget = await import("../src/company/budgetGuard.js");

type Snapshot = NonNullable<ReturnType<typeof budget.readBudgetState>>;

/** A copy of the live snapshot with Go forced to red, built from THEIR rulesFor() so the
 *  red rules (forbidden/cheapest models, cap 3, queue non-urgent) are the real ones. */
function forcedRed(snap: Snapshot): Snapshot {
  const rules = budget.rulesFor("red", "red");
  return {
    ...snap,
    levels: { go: "red", claude: "red" },
    rules,
    providers: { ...snap.providers, go: { ...snap.providers.go, level: "red" } },
  } as Snapshot;
}

const mk = (id: string, title: string, owns: string[], brief: string, failed = false) => ({
  id, title, role: id, owns, brief, done: ["(sample)"], state: "queued" as const,
  attempts: failed ? 1 : 0,
  ...(failed ? { error: "previous attempt failed" } : {}),
});

const uiOrder = mk("UI", "Create the fleet card page (HTML + CSS)", ["public/fleet-proof/card.html"],
  "One self-contained page with inline CSS and state pills. Static sample data only.");
const redoOrder = mk("REDO", "Fix the failing probe (2nd attempt)", ["ops/fleet-http-probe.ts"],
  "The previous attempt failed: the probe exits 0 on an unreachable router. Fix it.", true);

function report(label: string, snap: Snapshot | undefined): void {
  const cap = budget.fleetMaxParallel(30, snap);
  const level = (snap as { levels?: { go?: string } } | undefined)?.levels?.go ?? "unknown";
  console.log(`\n=== ${label}: OpenCode Go ${level} -> effective fleet cap ${cap} (default 30) ===`);
  for (const wo of [uiOrder, redoOrder]) {
    const urgent = fleet.needsEscalation(wo).escalate;
    const pick = budget.applyBudgetFilter({ model: fleet.ruleModel(wo).model, role: "worker", urgent }, snap);
    const q = budget.fleetQueueForBudget(urgent, snap);
    console.log(`  ${wo.id.padEnd(4)} urgent=${String(urgent).padEnd(5)} model -> ${pick.model}${pick.reason ? `  (${pick.reason.slice(0, 90)})` : ""}`);
    console.log(`       red-budget queue: ${q.queue ? `YES - ${q.reason.slice(0, 100)}` : "no"}`);
  }
}

const live = budget.readBudgetState();
report("LIVE state", live);
if (live) {
  report("FORCED RED (snapshot copy, their rulesFor('red','red'))", forcedRed(live));
} else {
  console.log("\n(no budget snapshot on disk yet - the guard is a no-op, which is the documented default)");
}

// And the real pick path (Laya + the CEO cost rule) under the LIVE state, so the two
// filters are shown together: rule/Laya model -> what the fleet would actually spawn.
console.log("\n=== model path with the LIVE state (Laya + cost rule + budget filter) ===");
for (const wo of [uiOrder, redoOrder]) {
  const urgent = fleet.needsEscalation(wo).escalate;
  const pk = await fleet.pickFleetModel(wo);
  const f = budget.applyBudgetFilter({ model: pk.model, role: "worker", urgent });
  console.log(`  ${wo.id.padEnd(4)} pick=${pk.model} [${pk.source}] -> spawn with ${f.model}${f.model !== pk.model ? `  (budget changed it: ${f.reason.slice(0, 80)})` : ""}`);
}
