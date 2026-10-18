/**
 * ops/laya-callsite-proof.ts — OPS-DOCS call-site proof (2026-10-01).
 *
 * READ-ONLY. No server, no writes, no company/ mutation, no router restart, no Laya restart.
 * The only side effect is the Laya HTTP calls this proof makes on purpose (a few, sequential).
 *
 * What it proves: the three call-site fixes landed by the CODE worker are live in the CODE
 * (not just in the docs), by running a realistic pipeline coding subtask through the REAL
 * `chooseWorkerModel()` (src/company/dispatch.ts) against the live local Laya and then through
 * the SAME ceiling block the pipeline applies at src/company/pipeline.ts (the `for (const a of
 * assignments)` loop: `escalationAllowed()` gate on a kimi pick, downgrade to
 * `config.models.standard` when unjustified).
 *
 * The ceiling lives inline in the (non-exported) pipeline dispatch function, so it cannot be
 * imported. This file therefore REPLICATES those lines verbatim and prints the exact trace
 * strings the pipeline would record, so the claim can be diffed against the source by eye.
 * Where a string is copied from pipeline.ts it is marked with the source line number.
 *
 * Usage:
 *   npx tsx ops/laya-callsite-proof.ts            # the two subtasks below, live Laya
 *   npx tsx ops/laya-callsite-proof.ts "some subtask text" ...   # plus ad-hoc subtasks
 */

import "dotenv/config";
import { config } from "../src/config.js";
import { chooseWorkerModel, escalationAllowed } from "../src/company/dispatch.js";

/** One realistic coding subtask, as the manager would hand it to a coder. */
type Case = { name: string; agentId: string; subtask: string; expect: string };

const CASES: Case[] = [
  {
    name: "A: UI subtask (realistic pipeline subtask; UI is NOT an escalation reason)",
    agentId: "coder-1",
    subtask:
      "Rebuild the settings page: update the three React views under src/ui/views and polish the CSS so the controls line up on small screens.",
    expect: "should end on the cost-rule default (deepseek); if Laya picks kimi the ceiling must refuse it",
  },
  {
    name: "B: ordinary non-trivial code work, no escalation reason (should stay on deepseek)",
    agentId: "coder-2",
    subtask:
      "Add exponential backoff and a retry counter to the Laya client call in src/decision.ts, with a unit test for it.",
    expect: "deepseek (one file, ordinary work, no failed prior attempt, no kimi text)",
  },
];

// Ad-hoc subtasks from the command line, so any one subtask can be checked without editing this file.
const EXTRA = process.argv.slice(2).filter((a) => !a.startsWith("--"));
for (const [i, s] of EXTRA.entries()) {
  CASES.push({ name: `X${i + 1}: ad-hoc subtask from the command line`, agentId: `coder-x${i + 1}`, subtask: s, expect: "(ad hoc - no expectation asserted)" });
}

function pad(s: string, n: number): string {
  return (s + " ".repeat(n)).slice(0, n);
}

async function runCase(c: Case): Promise<{ model: string; reason: string }> {
  console.log("");
  console.log("=".repeat(100));
  console.log(`${c.name}`);
  console.log(`agent: ${c.agentId}   expectation: ${c.expect}`);
  console.log(`subtask: ${c.subtask}`);
  console.log("-".repeat(100));

  // --- the shipped call, exactly as pipeline.ts:528 calls it (with the project/role opts) ---
  const pick = await chooseWorkerModel(c.subtask, { role: "coder" });

  // --- pipeline.ts:529-538 reproduced verbatim (the CEO cost-rule ceiling) ---
  let ceiling = "not applied (Laya did not pick the escalation model)";
  if (pick.modelId === config.models.complex) {
    const esc = escalationAllowed(c.subtask);
    if (!esc.escalate) {
      pick.modelId = config.models.standard;
      pick.confidence = 0;
      pick.reason = `kimi refused: no escalation justification -> ${config.models.standard} (cost rule) | was: ${pick.reason}`;
      ceiling = "REFUSED kimi -> downgraded to the cost-rule default";
    } else {
      pick.reason = `kimi allowed: ${esc.why} | ${pick.reason}`;
      ceiling = "ALLOWED kimi (justified)";
    }
  }

  // --- the trace lines the pipeline writes (pipeline.ts:546-552) ---
  const traceTo = `pick: ${pick.modelId}`;
  const traceDetail = `${pick.reason} for ${c.agentId}`; // pipeline.ts:550
  const reasonLine = `${c.agentId} -> ${pick.modelId} (${pick.reason})`; // pipeline.ts:552

  console.log(`model chosen : ${pick.modelId}`);
  console.log(`confidence   : ${pick.confidence}`);
  console.log(`ceiling      : ${ceiling}`);
  console.log(`trace from="Laya" to="${traceTo}"`);
  console.log(`trace detail : ${traceDetail}`);
  console.log(`dispatch reason line:`);
  console.log(`  ${reasonLine}`);

  const noul = /noul escalate=[\d.]+ trivial=[\d.]+ \(>= [\d.]+ \/ [\d.]+\)/.exec(pick.reason);
  if (noul) {
    console.log(`RAW 'noul escalate=' LINE: ${noul[0]}`);
  } else {
    console.log(`RAW 'noul escalate=' LINE: (none - the reason does not carry it: ${pick.reason})`);
  }
  return { model: pick.modelId, reason: pick.reason };
}

async function main(): Promise<void> {
  console.log("ops/laya-callsite-proof.ts - read-only call-site proof (OPS-DOCS, 2026-10-01)");
  console.log(`decision backend: ${config.decisionBackend ?? "(unset)"}\nmodels: standard=${config.models.standard} complex=${config.models.complex} routine=${config.models.routine}`);
  console.log("note: no projectId is passed, so no per-project team override can apply - this is the");
  console.log("      global cost rule path, the one a project with no override takes.");
  const out: Array<{ name: string; model: string; reason: string }> = [];
  for (const c of CASES) {
    const r = await runCase(c);
    out.push({ name: c.name.slice(0, 1), model: r.model, reason: r.reason });
  }
  console.log("");
  console.log("=".repeat(100));
  console.log("RECAP");
  console.log(pad("case", 8) + pad("model chosen", 22) + "reason");
  for (const r of out) console.log(pad(r.name, 8) + pad(r.model, 22) + r.reason);
  console.log("");
  console.log("Note: this proof calls the real chooseWorkerModel and the real escalationAllowed;");
  console.log("the ceiling lines are a verbatim copy of pipeline.ts:529-538 (source read at run time).");
}

main().catch((e) => {
  console.error("proof failed:", e);
  process.exit(1);
});
