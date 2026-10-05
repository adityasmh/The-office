import type { TaskComplexity } from "./decision.js";
import type { AgentType } from "./company/org.js";
import type { DispatchPlan } from "./company/dispatch.js";

// Deterministic mocks so the internal tool runs without spending budget.
// Enabled with MOCK_MODE=1. Replace with live calls once keys are pasted.

export function mockClassify(prompt: string) {
  const p = prompt.toLowerCase();
  let predicted: TaskComplexity = "STANDARD";
  if (p.length < 80 && !p.includes("refactor") && !p.includes("multi")) predicted = "ROUTINE";
  if (p.includes("refactor") || p.includes("multi-file") || p.includes("tool")) predicted = "COMPLEX";
  if (p.includes("ambiguous") || p.includes("long-horizon") || p.includes("high-risk") || p.length > 800) {
    predicted = "DEMANDING";
  }
  return { predicted, confidence: 0.82, probabilities: { [predicted]: 0.82 }, model: "mock-jev", usage: undefined };
}

export function mockGenerate(prompt: string, modelId: string) {
  return {
    text: `[mock ${modelId}] Received ${prompt.length} chars. Paste real keys to get live output.\nEcho: ${prompt.slice(0, 300)}`,
    usage: { mocked: true },
  };
}

export function mockBrain(prompt: string) {
  const p = prompt.toLowerCase();
  const opusHints = ["ambiguous", "architecture", "migration", "high-risk", "long-horizon", "audit", "opus"];
  const useOpus = opusHints.some((h) => p.includes(h));
  return {
    brain: (useOpus ? "OPUS" : "SONNET") as "SONNET" | "OPUS",
    confidence: 0.8,
    reason: useOpus ? "mock: hard-brain signals" : "mock: standard brain",
  };
}

export function mockChooseModel(prompt: string) {
  const p = prompt.toLowerCase();
  let modelId = "deepseek-v4-flash";
  if (p.includes("format") || p.length < 40) modelId = "glm-5.3-flash";
  if (p.includes("refactor") || p.includes("multi-file") || p.includes("tool") || p.includes("kimi")) modelId = "kimi-k2.7-code";
  if (p.includes("long") || p.includes("document") || p.includes("research") || p.includes("qwen")) modelId = "qwen3.8-flash";
  if (p.includes("plan") || p.includes("review")) modelId = "claude-sonnet-5-5";
  if (p.includes("ambiguous") || p.includes("architecture") || p.includes("migration") || p.includes("high-risk") || p.includes("opus")) {
    modelId = "claude-opus-5-5";
  }
  return {
    modelId,
    via: modelId.startsWith("claude") ? ("claude-subscription" as const) : modelId === "qwen3.8-flash" ? ("qwen-messages" as const) : ("gateway" as const),
    confidence: 0.82,
    probabilities: { [modelId]: 0.82 },
    reason: `mock: best_model=${modelId}`,
  };
}

export function mockReview() {
  return { pass: true, grounded: 0.9, completeness: 1.8, confidence: 0.8, verdict: "PASS" as const };
}

export function mockChooseAgent(task: string, agents: AgentType[]): DispatchPlan {
  const t = task.toLowerCase();
  let role: AgentType["role"] = "coder";
  if (t.includes("test")) role = "tester";
  else if (t.includes("review") || t.includes("oppose")) role = "opposer";
  else if (t.includes("plan") || t.includes("adjud")) role = "manager";
  else if (t.includes("summar")) role = "summarizer";
  else if (t.includes("enhanc")) role = "prompt-enhancer";
  const match = agents.find((a) => a.role === role);
  const parallel = agents.filter((a) => a.role === "coder").length > 1;
  return {
    assignments: match ? [{ agentId: match.id, role: match.role, subtask: task }] : [],
    parallel,
    reason: `mock: dispatch=${role} parallel=${parallel}`,
    confidence: 0.8,
  };
}
