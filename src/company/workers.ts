import { spawn } from "node:child_process";
import { config } from "../config.js";
import { loadOrg, appendCost, getCompanyRoot } from "./org.js";
import type { AgentType } from "./org.js";
import { ROLES } from "./roles.js";
import { callGatewayModel, callQwenMessages } from "../gateway.js";
import { callClaudeSubscription } from "../claudeSubscription.js";
import { airgappedBlock, airgappedHoldCli, airgappedCliHoldPending } from "./airGap.js";
import {
  startSession,
  updateSession,
  chunkSession,
  finishSession,
  type SessionContext,
  type SessionRec,
} from "./sessions.js";
import {
  charge,
  ensureAgentBudget,
  estimateCostForRole,
  markRunning,
  budgetKeyFor,
  type AgentBudgetContext,
} from "./budget.js";

// Parallel terminal workers. Coders/testers spawn `opencode run` child processes
// (real file edits + tools) in per-agent workdirs, concurrently. Reasoning roles
// call the router models directly.

export type WorkerEvent = {
  agentId: string;
  role: string;
  status: "start" | "chunk" | "done" | "error";
  text?: string;
  exitCode?: number;
  startedAt: string;
  finishedAt?: string;
};

export type TaskContext = {
  projectId?: string;
  projectName?: string;
  departmentId?: string;
  departmentName?: string;
  taskId?: string | null;
  taskTitle?: string;
};

export type WorkerOptions = {
  cwd?: string;
  onEvent: (ev: WorkerEvent) => void;
  // Optional pipeline context so each run is registered as a dashboard session
  // against the right project/department/task. Purely additive: callers that
  // omit it behave exactly as before.
  taskContext?: TaskContext;
};

// ---------------------------------------------------------------------------
// Dashboard hooks: sessions + budgets. Everything here is wrapped in try/catch
// so a metrics failure can never break a real agent run.
// ---------------------------------------------------------------------------

function buildSessionContext(
  agent: AgentType,
  prompt: string,
  task: TaskContext | undefined,
  runtime: "opencode" | "router",
): SessionContext {
  const taskTitle = (task?.taskTitle ?? prompt ?? "").slice(0, 120);
  const base = {
    agentId: agent.id,
    agentName: agent.name,
    role: agent.role as string,
    taskId: task?.taskId ?? null,
    taskTitle,
    model: agent.modelId,
    runtime,
  };

  // The CEO assistant is not part of any project team: it lives in "d-ceo".
  if (agent.id === "assistant" || agent.role === "assistant") {
    return {
      ...base,
      departmentId: task?.departmentId ?? "d-ceo",
      departmentName: task?.departmentName ?? "Executive",
      projectId: task?.projectId ?? "",
      projectName: task?.projectName ?? "",
    };
  }

  let projectId = task?.projectId;
  let projectName = task?.projectName;
  let departmentId = task?.departmentId;
  let departmentName = task?.departmentName;
  if (!projectId || !departmentId || !departmentName) {
    // Agent ids repeat across projects; prefer the entry whose workdir matches.
    const org = loadOrg();
    outer: for (const p of org.projects) {
      for (const t of p.teams) {
        const hit =
          t.agents.find((a) => a.id === agent.id && a.workdir === agent.workdir) ??
          t.agents.find((a) => a.id === agent.id);
        if (!hit) continue;
        projectId = projectId ?? p.id;
        projectName = projectName ?? p.name;
        departmentId = departmentId ?? p.departmentId;
        departmentName =
          departmentName ?? org.departments.find((d) => d.id === (departmentId ?? p.departmentId))?.name;
        break outer;
      }
    }
  }
  return {
    ...base,
    departmentId: departmentId ?? "",
    departmentName: departmentName ?? departmentId ?? "",
    projectId: projectId ?? "",
    projectName: projectName ?? "",
  };
}

function safeSessionContext(
  agent: AgentType,
  prompt: string,
  task: TaskContext | undefined,
  runtime: "opencode" | "router",
): SessionContext | undefined {
  try {
    return buildSessionContext(agent, prompt, task, runtime);
  } catch {
    return undefined;
  }
}

function budgetContextFor(ctx: SessionContext): AgentBudgetContext {
  const roleDef = ROLES[ctx.role as keyof typeof ROLES];
  return {
    agentId: ctx.agentId,
    name: ctx.agentName,
    role: ctx.role,
    tier: roleDef?.costTier ?? "cheap",
    departmentId: ctx.departmentId,
    departmentName: ctx.departmentName,
    projectId: ctx.projectId,
    projectName: ctx.projectName,
    modelId: ctx.model,
  };
}

function openSession(ctx: SessionContext | undefined): SessionRec | undefined {
  if (!ctx) return undefined;
  let rec: SessionRec | undefined;
  try {
    rec = startSession(ctx);
  } catch {
    rec = undefined;
  }
  try {
    ensureAgentBudget(budgetContextFor(ctx));
    markRunning(budgetKeyFor(ctx.projectId, ctx.agentId), true);
  } catch {
    // dashboard metrics are best-effort
  }
  return rec;
}

// Parse cost from `opencode --format json` stdout: one JSON event per line;
// sum every numeric cost field we recognise (top-level `cost`, nested
// `part.cost`, `part.tokens.cost`, plus `tokens`/`usage` shapes for tolerance).
function costFromOpencodeOutput(text: string): number {
  let total = 0;
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      const ev = JSON.parse(s) as Record<string, unknown>;
      total += costFieldsIn(ev);
    } catch {
      // partial/pretty-printed line: ignore
    }
  }
  return Math.round(total * 1e6) / 1e6;
}

function costFieldsIn(obj: Record<string, unknown> | undefined): number {
  if (!obj || typeof obj !== "object") return 0;
  const costOf = (o: unknown): number => {
    const c = (o as { cost?: unknown } | undefined)?.cost;
    return typeof c === "number" && Number.isFinite(c) ? c : 0;
  };
  const part = obj.part as Record<string, unknown> | undefined;
  return (
    costOf(obj) +
    costOf(part) +
    costOf(part?.tokens) +
    costOf(obj.tokens) +
    costOf(obj.usage)
  );
}

function closeSession(
  ctx: SessionContext | undefined,
  session: SessionRec | undefined,
  agent: AgentType,
  status: "done" | "error",
  options: { text?: string; parsedCostUsd?: number; exitCode?: number; runtime: "opencode" | "router" },
): void {
  try {
    const estimated = estimateCostForRole(agent.role, options.runtime);
    const costUsd =
      typeof options.parsedCostUsd === "number" && options.parsedCostUsd > 0
        ? options.parsedCostUsd
        : estimated;
    if (session) finishSession(session.id, status, { text: options.text, costUsd, exitCode: options.exitCode });
    const projectId = session?.projectId ?? ctx?.projectId ?? "";
    const key = budgetKeyFor(projectId, agent.id);
    charge(key, costUsd, session ? `session ${session.id}` : `run ${agent.id}`);
    if (projectId) {
      appendCost(projectId, {
        ts: new Date().toISOString(),
        modelId: agent.modelId,
        costUsd,
        note: `${agent.id} ${session?.id ?? ""}`.trim(),
      });
    }
    markRunning(key, false);
  } catch {
    // metrics must never break a run
  }
}

function providerSlashModel(modelId: string): string {
  // Map router model IDs to opencode provider/model format for `opencode run`.
  if (modelId.startsWith("claude")) return `anthropic/${modelId}`;
  if (modelId.includes("qwen")) return `opencode-go/${modelId}`;
  return `opencode-go/${modelId}`; // GLM/DeepSeek/Kimi via Go
}

export function spawnOpencodeWorker(agent: AgentType, prompt: string, opts: WorkerOptions) {
  const start = new Date().toISOString();
  const role = ROLES[agent.role];
  const sessionCtx = safeSessionContext(agent, prompt, opts.taskContext, "opencode");
  const session = openSession(sessionCtx);
  opts.onEvent({ agentId: agent.id, role: agent.role, status: "start", text: prompt.slice(0, 200), startedAt: start });

  if (config.mockMode) {
    const ev: WorkerEvent = { agentId: agent.id, role: agent.role, status: "done", text: `[mock opencode ${agent.modelId}] ${prompt.slice(0, 300)}`, startedAt: start, finishedAt: new Date().toISOString() };
    opts.onEvent(ev);
    closeSession(sessionCtx, session, agent, "done", { text: ev.text, runtime: "opencode" });
    return Promise.resolve(ev);
  }

  // AIR-GAP (PERF item 7 review fix 2): the opencode CLI reaches hosted models
  // (opencode-go provider, see providerSlashModel above). Under AIR_GAPPED=1 the
  // spawn is refused once per exact (role, model) hop and the work is QUEUED in the
  // held-air-gapped queue - not dropped, not failed. A repeat of the same hop
  // reports the same error without re-queueing; when the queue row is served the
  // pending marker is cleared via clearAirgappedCliHold and the hop queues again.
  const opencodeGateLabel = `opencode run ${providerSlashModel(agent.modelId)}`;
  const opencodeHoldKey: ["opencode-worker", string] = ["opencode-worker", opencodeGateLabel];
  if (airgappedBlock(...opencodeHoldKey)) {
    if (!airgappedCliHoldPending(...opencodeHoldKey)) {
      airgappedHoldCli(...opencodeHoldKey, "opencode-worker");
    }
    const ev: WorkerEvent = {
      agentId: agent.id,
      role: agent.role,
      status: "error",
      text: `[air-gap] opencode worker blocked under AIR_GAPPED=1: queued as held-air-gapped\n${prompt.slice(0, 200)}`,
      startedAt: start,
      finishedAt: new Date().toISOString(),
    };
    opts.onEvent(ev);
    closeSession(sessionCtx, session, agent, "error", { text: "air-gap: opencode spawn blocked (AIR_GAPPED=1)", runtime: "opencode" });
    return Promise.resolve(ev);
  }

  const fullPrompt = `${role.systemPrompt}\n\nTASK:\n${prompt}`;
  const args = [
    "run",
    "--dir", agent.workdir,
    "--model", providerSlashModel(agent.modelId),
    "--auto",
    "--format", "json",
    fullPrompt,
  ];

  // Direct exe, no shell: args pass cleanly (paths with spaces are fine).
  const opencodeBin = process.env.OPENCODE_BIN
    ?? "C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe";
  // stdin MUST be ignored. Verified empirically (ops/probe-stdin.mjs, 2026-09-29):
  // the exact same command completes in ~7-10s with `stdio: ["ignore",...]` and
  // HANGS FOREVER (0 bytes of output) with the default open pipe stdin that
  // nobody writes to. This was the root cause of "the coder hangs in the
  // pipeline" while the identical manual run in a terminal worked.
  const child = spawn(opencodeBin, args, {
    cwd: opts.cwd ?? agent.workdir,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (session && typeof child.pid === "number") {
    try {
      updateSession(session.id, { pid: child.pid });
    } catch {
      // metrics are best-effort
    }
  }

  return new Promise<WorkerEvent>((resolve) => {
    let acc = "";
    const errAcc: string[] = [];
    let settled = false;
    let lineBuf = "";
    let sawStop = false;
    // Hard ceiling so a stuck child can never wedge the pipeline forever.
    const timeoutMs = Number(process.env.OPENCODE_TIMEOUT_SECONDS ?? 900) * 1000;
    let graceTimer: NodeJS.Timeout | undefined;

    const settle = (
      status: "done" | "error",
      exitCode: number | undefined,
      note?: string,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      const ev: WorkerEvent = {
        agentId: agent.id,
        role: agent.role,
        status,
        text: (acc.slice(-3000) + (note ? `\n${note}` : "")).trim(),
        exitCode,
        startedAt: start,
        finishedAt: new Date().toISOString(),
      };
      if (errAcc.length) ev.text = (ev.text ?? "") + "\n[stderr] " + errAcc.slice(-5).join(" | ");
      opts.onEvent(ev);
      closeSession(sessionCtx, session, agent, status, {
        text: ev.text,
        parsedCostUsd: costFromOpencodeOutput(acc),
        exitCode,
        runtime: "opencode",
      });
      resolve(ev);
    };

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      settle("error", undefined, `[timeout] opencode exceeded ${timeoutMs / 1000}s and was killed`);
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      const s = d.toString();
      acc += s;
      if (session) chunkSession(session.id, s);
      opts.onEvent({ agentId: agent.id, role: agent.role, status: "chunk", text: s.slice(-500), startedAt: start });

      // Completion signal: opencode emits `{"type":"step_finish","part":{"reason":"stop"}}`
      // when it has finished the task. Resolve on that event instead of waiting for
      // process close, so a process that lingers after finishing cannot hang the run.
      lineBuf += s;
      let nl: number;
      while ((nl = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (!line.startsWith("{")) continue;
        try {
          const ev = JSON.parse(line) as { type?: string; part?: { reason?: string } };
          if (ev.type === "step_finish" && ev.part?.reason === "stop") sawStop = true;
        } catch {
          // partial line: ignore
        }
      }
      if (sawStop && !graceTimer && !settled) {
        // Give the process a moment to exit on its own; if it does not, kill it.
        graceTimer = setTimeout(() => {
          try { child.kill(); } catch { /* already gone */ }
          settle("done", undefined, "[resolved on step_finish:stop; process did not exit in time]");
        }, 5000);
      }
    });
    child.stderr.on("data", (d) => errAcc.push(d.toString()));
    child.on("error", (e) => {
      settle("error", undefined, String(e.message ?? e));
    });
    child.on("close", (code) => {
      settle((code ?? 0) === 0 ? "done" : "error", code ?? undefined);
    });
  });
}

// Run reasoning roles (manager/opposer/enhancer/summarizer) via the router.
export async function runRouterRole(agent: AgentType, prompt: string, opts?: WorkerOptions): Promise<WorkerEvent> {
  const start = new Date().toISOString();
  const role = ROLES[agent.role];
  const fullPrompt = `${role.systemPrompt}\n\nTASK:\n${prompt}`;
  const sessionCtx = safeSessionContext(agent, prompt, opts?.taskContext, "router");
  const session = openSession(sessionCtx);
  const finishRouter = (status: "done" | "error", text?: string) =>
    closeSession(sessionCtx, session, agent, status, { text, runtime: "router" });
  if (config.mockMode) {
    const ev: WorkerEvent = { agentId: agent.id, role: agent.role, status: "done", text: `[mock ${agent.modelId}] ${fullPrompt.slice(0, 300)}`, startedAt: start, finishedAt: new Date().toISOString() };
    finishRouter("done", ev.text);
    return ev;
  }
  let text = "";
  try {
    if (agent.modelId.startsWith("claude")) {
      // Claude on Pro rate-limits. Fall back to DeepSeek (Go) so the brain never stalls.
      try {
        // Claude Code runs in the project root so the brain can read real files.
        const r = await callClaudeSubscription({
          model: agent.modelId,
          system: role.systemPrompt,
          user: prompt,
          cwd: agent.workdir,
          addDirs: [getCompanyRoot()],
          // CHEAP BY DEFAULT (Job 1): name the purpose so the Laya gate can keep small
          // work off Claude (manager plans, opposer reviews, everything else = worker).
          purpose: agent.role === "manager" ? "plan" : agent.role === "opposer" ? "review" : "worker",
        });
        text = r.text;
      } catch (claudeErr) {
        const fb = await callGatewayModel(config.models.standard, role.systemPrompt, prompt);
        text = `${fb.text}\n\n[manager-fallback: Claude ${String(claudeErr).slice(0, 120)} -> ${config.models.standard}]`;
      }
    } else if (agent.modelId.includes("qwen")) {
      try {
        text = (await callQwenMessages(agent.modelId, role.systemPrompt, prompt)).text;
      } catch (qwenErr) {
        // The Qwen path needs a key the Go gateway does not always have
        // (observed: "Qwen 401 Missing API key."). Fall back to the standard
        // gateway model so the summarizer stage never hard-fails the pipeline.
        const fb = await callGatewayModel(config.models.standard, role.systemPrompt, prompt);
        text = `${fb.text}\n\n[qwen-fallback: ${String(qwenErr).slice(0, 120)} -> ${config.models.standard}]`;
      }
    } else {
      text = (await callGatewayModel(agent.modelId, role.systemPrompt, prompt)).text;
    }
    // Keep the whole reply: the manager's plan ends with a machine-readable DISPATCH
    // line, and a front-truncated plan loses the "DISPATCH:" marker (observed: tmummq62z).
    const ev: WorkerEvent = { agentId: agent.id, role: agent.role, status: "done", text: text.slice(-30000), startedAt: start, finishedAt: new Date().toISOString() };
    finishRouter("done", ev.text);
    return ev;
  } catch (e) {
    const ev: WorkerEvent = { agentId: agent.id, role: agent.role, status: "error", text: String(e), startedAt: start, finishedAt: new Date().toISOString() };
    finishRouter("error", ev.text);
    return ev;
  }
}

export function runAgent(agent: AgentType, prompt: string, opts: WorkerOptions): Promise<WorkerEvent> {
  return ROLES[agent.role].execution === "opencode"
    ? spawnOpencodeWorker(agent, prompt, opts)
    : runRouterRole(agent, prompt, opts);
}

// Run many agents in parallel and resolve when all settle. A job may carry its
// own taskContext (e.g. the per-coder subtask) which wins over the shared one.
export async function runParallel(
  agents: Array<{ agent: AgentType; prompt: string; taskContext?: TaskContext }>,
  opts: WorkerOptions,
): Promise<WorkerEvent[]> {
  return Promise.all(
    agents.map(({ agent, prompt, taskContext }) =>
      runAgent(agent, prompt, taskContext ? { ...opts, taskContext: { ...opts.taskContext, ...taskContext } } : opts),
    ),
  );
}
