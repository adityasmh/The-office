import { decideRoute, generate } from "./orchestrator.js";
import { reviewAnswer } from "./decision.js";
import { personaForRoute, postAs } from "./slack.js";
import type { HandoffBundle } from "./handoff.js";

// Manager-employee loop in one Slack thread. Orchestrator stays in charge;
// Slack thread is the shared floor where each model speaks as staff.
// Manager (Opus/Sonnet) assigns, employee (labour model) reports, QA (Laya) verdicts.

export async function runTeamTask(bundle: HandoffBundle, opts?: { taskHint?: string; system?: string }) {
  const prompt = `${bundle.task}\n\nFiles: ${bundle.files.map((f) => f.path).join(", ") || "none"}`;
  const route = await decideRoute(prompt, { taskHint: opts?.taskHint });

  const manager = route.via === "claude-subscription" && route.modelId.toLowerCase().includes("opus") ? "OPUS_MANAGER" as const : "SONNET_LEAD" as const;
  const employee = personaForRoute(route.via, route.modelId);

  // 1. Manager kickoff (new thread).
  const kickoff = await postAs(manager, `Team, new job: ${bundle.task}\n@${employee} — you take it. Diffs over essays. Report diff + tests when done.`);
  const threadTs = kickoff.ts ?? "mock-thread";

  // 2. Employee executes via gateway / subscription.
  const gen = await generate(prompt, route, opts?.system);
  await postAs(employee, `Boss, done on ${route.modelId}. Result:\n${gen.text.slice(0, 3000)}`, threadTs);

  // 3. QA verdict via Laya.
  const verdict = await reviewAnswer(prompt, "", gen.text);
  await postAs("LAYA_QA", `QA verdict: ${verdict.verdict} (grounded=${verdict.grounded.toFixed(2)}, completeness=${verdict.completeness.toFixed(2)}). ${verdict.verdict === "PASS" ? "Ship it." : "Manager, needs rework."}`, threadTs);

  // 4. Manager close-out / escalation.
  if (verdict.verdict !== "PASS" && manager !== "OPUS_MANAGER") {
    await postAs("OPUS_MANAGER", `Escalating to me (Opus). Sonnet/employee output needs rework. I will re-plan; labour re-runs after.`, threadTs);
  } else {
    await postAs(manager, verdict.verdict === "PASS" ? `Approved. Closing this thread.` : `Reviewing now — hold labour until my re-plan lands.`, threadTs);
  }

  return { threadTs, route, answer: gen.text, review: verdict, posted: kickoff.posted };
}
