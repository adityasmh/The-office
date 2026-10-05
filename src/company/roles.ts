import { config } from "../config.js";
import path from "node:path";
import type { RoleId, AgentType } from "./org.js";

// 7 role definitions: what each agent does, which model it uses, its persona.
// Coders/testers run through opencode (file edits + tests). Reasoning roles
// (manager/opposer) use Claude subscription. Enhancer/summarizer use cheap Go.

export type RoleDef = {
  id: RoleId;
  name: string;
  description: string;
  persona: string; // Slack persona + system-prompt personality
  systemPrompt: string;
  execution: "opencode" | "router"; // opencode = file/tool execution, router = LLM call
  defaultModel: string; // model when Laya doesn't override
  costTier: "cheap" | "mid" | "frontier";
};

export const ROLES: Record<RoleId, RoleDef> = {
  "prompt-enhancer": {
    id: "prompt-enhancer",
    name: "Prompt Enhancer",
    description: "Takes the raw user request and enriches it into a precise, detailed task brief.",
    persona: "PromptEnhancer",
    systemPrompt:
      "You are the Prompt Enhancer in a software team. Take the raw request and produce a richer brief: clear goal, acceptance criteria, edge cases, files likely involved, testing notes. Be concise but complete. Output: ENHANCED BRIEF.",
    execution: "router",
    defaultModel: config.models.routine, // GLM — cheap
    costTier: "cheap",
  },
  manager: {
    id: "manager",
    name: "Manager",
    description: "Plans the work, breaks tasks into subtasks, assigns via Laya, adjudicates disputes, owns the gates.",
    persona: "Manager",
    systemPrompt:
      "You are the Manager of a software team of AI agents. You plan work, split it into discrete subtasks with clear file scopes, assign each to the right role, review opposing/coder output, and decide pass/loop. You never write full implementations yourself — you delegate. Output sections: PLAN (numbered subtasks with files), ASSIGNMENTS (role per subtask), RISKS, ACCEPTANCE.",
    execution: "router",
    defaultModel: config.claudeSonnet,
    costTier: "frontier",
  },
  coder: {
    id: "coder",
    name: "Coder",
    description: "Implements tasks with real file edits, run through opencode in its workdir.",
    persona: "Coder",
    systemPrompt:
      "You are a Coder. Implement the assigned subtask: edit the files, keep the diff minimal and focused, and report exactly what you changed and why. Follow the acceptance criteria. Run relevant checks if feasible.",
    execution: "opencode",
    defaultModel: config.models.complex, // Kimi
    costTier: "mid",
  },
  tester: {
    id: "tester",
    name: "Tester",
    description: "Writes and runs tests for the implementation; reports pass/fail and gaps.",
    persona: "Tester",
    systemPrompt:
      "You are a Tester. For the implemented changes, write or run tests, verify the acceptance criteria, and report: what you tested, results (pass/fail), and any uncovered edge cases. Be honest about what you could not test.",
    execution: "opencode",
    defaultModel: config.models.standard, // DeepSeek
    costTier: "mid",
  },
  opposer: {
    id: "opposer",
    name: "Opposer",
    description: "Adversarial reviewer: challenges the implementation, finds flaws and risks.",
    persona: "Opposer",
    systemPrompt:
      "You are the Opposer. Your job is to find real problems with the proposed implementation: correctness bugs, missed edge cases, security issues, performance problems, spec drift. Be specific and constructive. If it is genuinely solid, say so clearly and list what you verified.",
    execution: "router",
    defaultModel: config.claudeSonnet,
    costTier: "frontier",
  },
  summarizer: {
    id: "summarizer",
    name: "Summarizer",
    description: "Condenses the task thread into project memory / status for the next cycle.",
    persona: "Summarizer",
    systemPrompt:
      "You are the Summarizer. Read the task thread and produce a concise summary for project memory: what was decided, what changed (files), what is done, what is pending, open risks, next steps. Keep it under 200 words.",
    execution: "router",
    defaultModel: config.models.complexQwen, // Qwen — cheap
    costTier: "cheap",
  },
  assistant: {
    id: "assistant",
    name: "CEO Assistant",
    description: "The CEO's chief of staff: takes a plain instruction from the CEO, decomposes it, picks the department/project, hires the agents and dispatches the work.",
    persona: "Assistant",
    systemPrompt:
      "You are the CEO's Assistant (chief of staff) of a software company staffed by AI agents. The CEO gives you an instruction in plain language. Decompose it into discrete, independently executable tasks. For each task choose the target department (one of the departments you are given), the project to run it in, and the primary role that should own it (prompt-enhancer, manager, coder, tester, opposer, summarizer). Write each task as a precise work order: goal, deliverables, acceptance criteria, and the files or systems involved. Consider budget: prefer few high-value tasks over many, and say explicitly when a task is dropped or deferred and why. Output ONLY valid JSON, no prose, no markdown fences, in exactly this shape: {\"reply\":\"what you are telling the CEO, 2-5 sentences, including any budget concerns\",\"decisions\":[\"short bullet on routing/budget choices\"],\"tasks\":[{\"title\":\"short task title\",\"departmentName\":\"exact department name\",\"projectId\":\"existing project id or empty\",\"role\":\"primary role id\",\"request\":\"the full self-contained work order for the engineering pipeline\"}]}",
    execution: "router",
    defaultModel: config.claudeSonnet,
    costTier: "frontier",
  },
};

export function defaultTeamAgents(projectRoot: string, coderCount = 2): AgentType[] {
  const agents: AgentType[] = [];
  agents.push({ id: "manager", role: "manager", name: "Manager", modelId: ROLES.manager.defaultModel, workdir: projectRoot });
  agents.push({ id: "enhancer", role: "prompt-enhancer", name: "Prompt Enhancer", modelId: ROLES["prompt-enhancer"].defaultModel, workdir: projectRoot });
  agents.push({ id: "summarizer", role: "summarizer", name: "Summarizer", modelId: ROLES.summarizer.defaultModel, workdir: projectRoot });
  agents.push({ id: "opposer", role: "opposer", name: "Opposer", modelId: ROLES.opposer.defaultModel, workdir: projectRoot });
  agents.push({ id: "tester", role: "tester", name: "Tester", modelId: ROLES.tester.defaultModel, workdir: projectRoot });
  for (let i = 1; i <= coderCount; i++) {
    const dir = path.join(projectRoot, "agents", `coder-${i}`);
    agents.push({ id: `coder-${i}`, role: "coder", name: `Coder ${i}`, modelId: ROLES.coder.defaultModel, workdir: dir });
  }
  return agents;
}