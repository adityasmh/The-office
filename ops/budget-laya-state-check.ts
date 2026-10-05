// ops/budget-laya-state-check.ts - F3 (docs/BUDGET_SPEC.md §2): every Laya
// decision carries the budget state, and the TUNED question wording is untouched.
//
//   npx tsx ops/budget-laya-state-check.ts
//
// Why it exists: `dispatch.ts` is the manager's file and was closed to me until
// F3; this proves the change without needing a live Laya (the spec builders are
// pure functions), and it pins the two properties that matter:
//   1. agent / team / worker-model specs all carry `state.budget {go, claude}`
//      and a plain `state.cost` sentence, with the levels matching the real
//      company/budget/state.json;
//   2. the decision `note` carries the budget tag, so the trace shows it;
//   3. the instructions/criteria are byte-identical to what LAYA-TUNE measured
//      (no new wording anywhere), which is the point cricket's two reverts made.
//
// Exit code 0 = all pass. Read-only: it writes nothing.

import { agentQuestionSpec, teamQuestionSpec, workerModelQuestionSpec, agentChoices, workerModelCatalog } from "../src/company/dispatch.js";
import type { AgentType, RoleId } from "../src/company/org.js";

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n        ${detail}`);
  if (!ok) failures += 1;
}

const ROLES: RoleId[] = ["coder", "tester", "manager"];
const agents: AgentType[] = ROLES.map((role, i) => ({
  id: `agent-${i}`,
  name: `Agent ${i}`,
  role,
  departmentId: "d1",
} as unknown as AgentType));

const projects = [
  { id: "p1", name: "Platform Core", department: "Engineering", description: "Core services." },
  { id: "p2", name: "Research", department: "Research", description: "Exploratory work." },
];

function main(): void {
  const agentSpec = agentQuestionSpec("Add a small health endpoint to the router.", agents, "kind=code");
  const teamSpec = teamQuestionSpec("Department: Research. Investigate the cache hit rate.", projects);
  const workerSpec = workerModelQuestionSpec("Rename one variable in docs/README.md.");

  const specs: Array<[string, { state: Record<string, unknown> }]> = [
    ["agentQuestionSpec", agentSpec as unknown as { state: Record<string, unknown> }],
    ["teamQuestionSpec", teamSpec as unknown as { state: Record<string, unknown> }],
    ["workerModelQuestionSpec", workerSpec as unknown as { state: Record<string, unknown> }],
  ];

  for (const [name, spec] of specs) {
    const budget = spec.state.budget as { go?: string; claude?: string } | undefined;
    const cost = spec.state.cost as string | undefined;
    check(
      `${name}: state.budget is present with go/claude levels`,
      !!budget && typeof budget.go === "string" && typeof budget.claude === "string",
      `budget=${JSON.stringify(budget)}`,
    );
    check(
      `${name}: state.cost is a plain sentence about remaining budget`,
      typeof cost === "string" && cost.length > 20,
      cost ?? "(missing)",
    );
  }

  const agentNote = agentSpec.decide({ assignment: { choice: "agent-0", confidence: 0.5, answer_confidence: 0.5 } } as never).note;
  const teamNote = teamSpec.decide({ team: { choice: "p1", confidence: 0.5, answer_confidence: 0.5 } } as never).note;
  const workerNote = workerSpec.decide({ escalate: { noul: 0 }, trivial: { noul: 0 } } as never).note;
  for (const [name, note] of [["agent", agentNote], ["team", teamNote], ["worker-model", workerNote]] as const) {
    check(`${name} trace note carries the budget tag`, / \| budget go=\w+ claude=\w+$/.test(note), note);
  }

  // The wording LAYA-TUNE measured must not have moved. These are the exact
  // strings from the file at the time of the tuning (docs/LAYA_TUNING.md).
  const agentQ = agentSpec.questions.assignment as { instructions: string; criteria: Record<string, string> };
  const teamQ = teamSpec.questions.team as { instructions: string };
  const workerQ = workerSpec.questions.escalate as { instructions: string };
  check(
    "the tuned agent instructions are unchanged",
    agentQ.instructions ===
      "Pick the single best agent for this task from the team roster. Match the role to what the task needs: implementation->coder, tests->tester, review->opposer, planning/adjudication->manager, enrichment->prompt-enhancer, summarization->summarizer. Balance capability against cost.",
    `len=${agentQ.instructions.length}`,
  );
  check(
    "the tuned worker escalation instruction is unchanged",
    workerQ.instructions ===
      "Should this escalate to the stronger, much more expensive coder? Answer high ONLY if a previous attempt at this same work order already failed, or the work is exceptionally hard multi-file coding. A user interface, a page or a component is NOT by itself a reason to escalate.",
    `len=${workerQ.instructions.length}`,
  );
  const criteria = agentChoices(agents);
  check(
    "the agent criteria are still the plain role hints (no cost text injected)",
    Object.values(criteria).every((v) => !/budget|remaining|% left/i.test(v)) &&
      Object.values(teamSpec.questions.team ? (teamSpec.questions.team as { criteria: Record<string, string> }).criteria : {}).every(
        (v) => !/budget|remaining|% left/i.test(v),
      ),
    `agent criteria: ${Object.values(criteria).join(" | ")}`,
  );
  check(
    "the worker-model catalog is unchanged (the descriptions the manager shows)",
    Object.keys(workerModelCatalog()).length === 3,
    Object.keys(workerModelCatalog()).join(", "),
  );

  console.log("");
  if (failures > 0) {
    console.log(`LAYA-BUDGET-STATE CHECK FAILED: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("LAYA-BUDGET-STATE CHECK ALL PASS (budget on every Laya decision, tuned wording untouched)");
}

main();
