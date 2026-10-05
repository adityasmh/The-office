/**
 * ops/fleet-model-probe.ts — what model would each work order get, and why?
 *
 * Runs the REAL `pickFleetModel` from src/company/fleet.ts (Laya + the guard +
 * the rule default) over a few sample work orders and prints, for each:
 * the classifier's read (type/files/risk), Laya's pick with BOTH confidence
 * numbers, whether the guard accepted it, and the model that would be spawned.
 *
 * Read-only: it spawns nothing, starts no server and writes no state.
 *
 *   npx tsx ops/fleet-model-probe.ts
 *   LAYA_MODEL_MIN_CONF=0.4 LAYA_MODEL_MIN_LEAD=0.15 npx tsx ops/fleet-model-probe.ts
 */
const fleet = await import("../src/company/fleet.js");

type Sample = { label: string; wo: Parameters<typeof fleet.pickFleetModel>[0] };

const mk = (label: string, id: string, title: string, owns: string[], brief: string) =>
  ({ label, wo: { id, title, role: id, owns, brief, done: ["(sample)"], state: "queued" as const, attempts: 0 } });

const samples: Sample[] = [
  mk("trivial/docs", "TRIV",
    "Append one line to the Notes section of docs/FLEET_SELFCHECK.md",
    ["docs/FLEET_SELFCHECK.md"],
    "Add a single line 'Last verified: today' under a '## Notes' heading in docs/FLEET_SELFCHECK.md (create the heading if it is missing). Change nothing else."),
  mk("ui/static-page (CEO rule: UI is NOT an escalation)", "UI",
    "Create a static fleet state card page (HTML + CSS)",
    ["public/fleet-proof/card.html"],
    "Create public/fleet-proof/card.html: one self-contained page with inline CSS (no JS framework, no backend) rendering three sample fleet work-order cards with state pills (planned, working, reviewed) and the model + confidence text under each. Static sample data only."),
  mk("script/ops", "SCRIPT",
    "Write a read-only ops script that prints fleet orders",
    ["ops/fleet-summary.ts"],
    "Create ops/fleet-summary.ts, a small read-only CLI that GETs http://127.0.0.1:8787/company/fleet and prints one line per order. No new dependencies, no server start."),
  mk("hard/multi-file (escalation -> kimi)", "HARD",
    "Refactor the fleet watcher and the reaper across four files",
    ["src/company/fleet.ts", "src/company/terminalReaper.ts", "src/company/gates.ts", "src/company/flow.ts"],
    "Refactor the restart handling across the fleet watcher, the terminal reaper, the gates and the flow view so they share one resume path. Multi-file."),
  mk("redo after a DeepSeek failure (escalation -> kimi)", "REDO",
    "Fix the failing probe script",
    ["ops/fleet-http-probe.ts"],
    "The previous attempt at this work order failed, so this is a REDO: the probe exits 0 on an unreachable router. Fix it."),
];
// The redo sample carries the failure marker on the work order itself (the hard
// multi-file sample gets kimi from its FILE count, not from a failure).
(samples[4].wo as { attempts?: number; error?: string }).attempts = 1;
(samples[4].wo as { attempts?: number; error?: string }).error = "previous attempt failed: exit code 0 on an unreachable router";

const catalog = fleet.fleetModelCatalog();
const t0 = Date.now();
const terminals = await fleet.countRealTerminals(true);
const countMs = Date.now() - t0;
const freeMb = Math.round((await import("node:os")).freemem() / (1024 * 1024));
console.log(`[probe] real terminals: ${terminals.total} (jcode ${terminals.jcodeTerminals} + opencode ${terminals.opencodeWorkers}) / MAX_PARALLEL_SESSIONS ${terminals.maxParallel} -> headroom ${terminals.headroom}  [source: ${terminals.source}, counted in ${countMs}ms]`);
console.log(`[probe] free RAM: ${freeMb} MB (MIN_FREE_RAM_MB floor ${process.env.MIN_FREE_RAM_MB ?? "default 2048"}) -> ${freeMb >= Number(process.env.MIN_FREE_RAM_MB ?? 2048) ? "spawning allowed" : "WOULD NOT SPAWN"}`);
console.log(`[probe] catalog: ${Object.keys(catalog).join(" | ")}`);
console.log(`[probe] threshold: LAYA_MODEL_MIN_CONF=${process.env.LAYA_MODEL_MIN_CONF ?? "(default 0.33 = the shared noul question's value)"} ceiling=${process.env.LAYA_MODEL_CEILING ?? "on"}`);
console.log("");
for (const s of samples) {
  const k = fleet.classifyWork(s.wo);
  const rule = fleet.ruleModel(s.wo);
  const pick = await fleet.pickFleetModel(s.wo);
  console.log(`── ${s.label}`);
  console.log(`   classified : type=${k.type} files=${k.files} risk=${k.risk}  escalation=${fleet.needsEscalation(s.wo).escalate ? fleet.needsEscalation(s.wo).why : "no"}`);
  console.log(`   rule       : ${rule.model}  (${rule.reason})`);
  console.log(`   Laya       : conf=${pick.confidence ?? "-"} answer_conf=${pick.answerConfidence ?? "-"}`);
  console.log(`   guard      : ${pick.source === "laya" ? "ACCEPTED Laya" : "refused -> rules"}`);
  console.log(`   FINAL      : ${pick.model} [${pick.source}]  ${pick.reason}`);
  console.log("");
}
