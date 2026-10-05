import fs from "node:fs";
import path from "node:path";
import { ROLES } from "./roles.js";
import type { AgentType, RoleId } from "./org.js";
import { getCompanyRoot, loadOrg } from "./org.js";
import { runAgent } from "./workers.js";
import type { WorkerEvent } from "./workers.js";
import { ensureAgentBudget, getBudget, charge, estimateCostForRole, markRunning } from "./budget.js";
import type { AgentBudget } from "./budget.js";
import { startSession, finishSession, runningSessionsFor, lastSessionFor } from "./sessions.js";
import type { SessionContext, SessionRec } from "./sessions.js";

// Per-agent messaging + the org-wide agent roster.
//
// Addressing: agent ids are only unique WITHIN a project, so agents are addressed by a
// composite key "<projectId>::<agentId>" (canonical) while the bare "<agentId>" form is
// accepted as a convenience (first match scanning projects in org order). The special
// assistant agent's key is exactly "assistant".
//
// Identity rules match budget.ts / sessions.ts / workers.ts: budgets are keyed by the
// composite key, session records carry the bare agentId plus the bare projectId.
//
// Session + spend accounting is owned by workers.ts (runAgent opens/finishes the session
// from the taskContext we hand it and charges the budget). We only register a session
// ourselves if the worker layer did not, so nothing is ever double counted.
//
// Agent art lives at company/agents/<safeKey>/thread.jsonl (one JSON line per message)
// and company/agents/<safeKey>/queue.jsonl (messages held while the agent is busy).

export type AgentView = {
  agentId: string;
  agentKey: string;
  name: string;
  role: RoleId;
  roleName: string;
  departmentId: string;
  departmentName: string;
  projectId: string;
  projectName: string;
  modelId: string;
  status: "idle" | "running";
  running: boolean;
  budget: AgentBudget;
  lastMessage: string;
  threadDepth: number;
};

export type AgentThreadEntry = { ts: string; from: "ceo" | "agent"; text: string; kind?: string };

export type AgentMessageResult = {
  agentId: string; // exactly the id the caller sent (raw path param), echoed back
  agentKey: string; // canonical "<projectId>::<agentId>" (or "assistant")
  status: "replied" | "queued" | "error";
  reply?: string;
  sessionId?: string;
  budget?: AgentBudget; // budget.agentId is always the canonical composite key
  error?: string;
};

type QueueItem = { ts: string; text: string; force?: boolean };

type Located = {
  agent: AgentType;
  agentId: string;
  key: string;
  departmentId: string;
  departmentName: string;
  projectId: string;
  projectName: string;
};

type BudgetCtx = {
  agentId: string; // bare agent id
  name: string;
  role: RoleId;
  departmentId: string;
  departmentName: string;
  projectId: string; // bare project id
  projectName: string;
  modelId: string;
};

const ASSISTANT_ID = "assistant";
const ASSISTANT_DEPT_ID = "d-ceo";
const ASSISTANT_DEPT_NAME = "Executive";
const ASSISTANT_PROJECT_ID = "p-ceo";
const ASSISTANT_PROJECT_NAME = "Executive Office";
const CEO_TASK_PREFIX = "CEO message: ";

function nowIso(): string {
  return new Date().toISOString();
}

// Canonical composite key for an agent inside a project.
export function agentKey(projectId: string, agentId: string): string {
  return `${projectId}::${agentId}`;
}

function splitKey(key: string): { projectId?: string; agentId: string } {
  const raw = (key ?? "").toString().trim();
  const i = raw.indexOf("::");
  if (i >= 0) {
    const projectId = raw.slice(0, i).trim();
    const agentId = raw.slice(i + 2).trim();
    return { projectId: projectId || undefined, agentId };
  }
  return { agentId: raw };
}

function safeId(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "unknown";
}

function agentDir(key: string): string {
  return path.join(getCompanyRoot(), "agents", safeId(key));
}

function threadFile(key: string): string {
  return path.join(agentDir(key), "thread.jsonl");
}

function queueFile(key: string): string {
  return path.join(agentDir(key), "queue.jsonl");
}

function readJsonl<T>(file: string): T[] {
  try {
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, "utf8").trim();
    if (!raw) return [];
    const out: T[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        // skip a corrupt line, never break a thread
      }
    }
    return out;
  } catch {
    return [];
  }
}

function appendJsonl(file: string, entry: unknown) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n");
  } catch {
    // best effort: a failed log write must never break a run
  }
}

function roleRuntime(role: RoleId): "opencode" | "router" {
  return ROLES[role]?.execution ?? "router";
}

function assistantAgentDef(): AgentType {
  return {
    id: ASSISTANT_ID,
    role: "assistant",
    name: ROLES.assistant.name,
    modelId: ROLES.assistant.defaultModel,
    workdir: path.join(agentDir(ASSISTANT_ID), "workdir"),
  };
}

// Running sessions for this exact agent. Read in both id forms (workers.ts registers the
// bare id, we may register the composite key) and drop project-scoped bare matches that
// belong to another project's agent with the same id.
function runningFor(id: string, projectId: string, key: string): SessionRec[] {
  const candidates: SessionRec[] = [];
  try {
    candidates.push(...runningSessionsFor(id));
  } catch {
    // registry unavailable
  }
  if (key !== id) {
    try {
      candidates.push(...runningSessionsFor(key));
    } catch {
      // registry unavailable
    }
  }
  const seen = new Set<string>();
  const out: SessionRec[] = [];
  for (const s of candidates) {
    if (!s || seen.has(s.id)) continue;
    if (s.agentId === key || !s.projectId || s.projectId === projectId) {
      seen.add(s.id);
      out.push(s);
    }
  }
  return out;
}

// The session workers.ts just opened for this run, identified by the task title we asked
// for (plus a freshness + project guard).
function sessionIdForRun(agentId: string, projectId: string, taskTitle: string, startedMs: number): string | undefined {
  try {
    const rec = lastSessionFor(agentId);
    if (!rec) return undefined;
    if (rec.taskTitle !== taskTitle) return undefined;
    if (rec.projectId && projectId && rec.projectId !== projectId) return undefined;
    if (Date.parse(rec.startedAt) < startedMs - 5000) return undefined;
    return rec.id;
  } catch {
    return undefined;
  }
}

function synthBudget(ctx: BudgetCtx): AgentBudget {
  return {
    agentId: agentKey(ctx.projectId, ctx.agentId),
    name: ctx.name,
    role: ctx.role,
    tier: ROLES[ctx.role]?.costTier ?? "cheap",
    departmentId: ctx.departmentId,
    departmentName: ctx.departmentName,
    projectId: ctx.projectId,
    projectName: ctx.projectName,
    modelId: ctx.modelId,
    allocatedUsd: null,
    spentUsd: 0,
    remainingUsd: null,
    pctUsed: null,
    sessionsRun: 0,
    status: "idle",
  };
}

// Register (idempotent) and read back this agent's budget so every view always has one.
// budget.ts keys rows by `${projectId}::${agentId}`, so it needs the bare ids and hands
// back the composite key in AgentBudget.agentId.
function budgetFor(ctx: BudgetCtx): AgentBudget {
  try {
    const b = ensureAgentBudget({
      agentId: ctx.agentId,
      name: ctx.name,
      role: ctx.role,
      tier: ROLES[ctx.role]?.costTier ?? "cheap",
      departmentId: ctx.departmentId,
      departmentName: ctx.departmentName,
      projectId: ctx.projectId,
      projectName: ctx.projectName,
      modelId: ctx.modelId,
    });
    if (b) return b;
  } catch {
    // budget store unavailable: fall back to a read / synthetic zero budget
  }
  try {
    const b = getBudget(agentKey(ctx.projectId, ctx.agentId));
    if (b) return b;
  } catch {
    // fall through
  }
  return synthBudget(ctx);
}

// CEO order 2026-10-01: agents are no longer marked "budget_exhausted" - they
// have no quotas. Provider pressure (budgetGuard.ts) is the only thing that may
// hold work back, and it lives on the provider, not on the employee.
function statusOf(running: boolean, _budget: AgentBudget): AgentView["status"] {
  return running ? "running" : "idle";
}

// Every agent in every team of every project, in org order (no cross-project dedupe:
// distinct projects legitimately hold agents with the same bare id).
function locateAgents(): Located[] {
  const org = loadOrg();
  const out: Located[] = [];
  for (const project of org.projects) {
    const dept = org.departments.find((d) => d.id === project.departmentId);
    for (const team of project.teams) {
      for (const agent of team.agents) {
        out.push({
          agent,
          agentId: agent.id,
          key: agentKey(project.id, agent.id),
          departmentId: project.departmentId,
          departmentName: dept?.name ?? "Unassigned",
          projectId: project.id,
          projectName: project.name,
        });
      }
    }
  }
  return out;
}

function viewFromParts(opts: {
  agentId: string;
  key: string;
  name: string;
  role: RoleId;
  departmentId: string;
  departmentName: string;
  projectId: string;
  projectName: string;
  modelId: string;
}): AgentView {
  const budget = budgetFor({
    agentId: opts.agentId,
    name: opts.name,
    role: opts.role,
    departmentId: opts.departmentId,
    departmentName: opts.departmentName,
    projectId: opts.projectId,
    projectName: opts.projectName,
    modelId: opts.modelId,
  });
  const running = runningFor(opts.agentId, opts.projectId, opts.key).length > 0;
  const thread = readJsonl<AgentThreadEntry>(threadFile(opts.key));
  const last = thread.length ? thread[thread.length - 1] : undefined;
  return {
    agentId: opts.agentId,
    agentKey: opts.key,
    name: opts.name,
    role: opts.role,
    roleName: ROLES[opts.role]?.name ?? opts.role,
    departmentId: opts.departmentId,
    departmentName: opts.departmentName,
    projectId: opts.projectId,
    projectName: opts.projectName,
    modelId: opts.modelId,
    status: statusOf(running, budget),
    running,
    budget,
    lastMessage: last ? String(last.text ?? "").slice(0, 300) : "",
    threadDepth: thread.length,
  };
}

function viewFor(loc: Located): AgentView {
  return viewFromParts({
    agentId: loc.agentId,
    key: loc.key,
    name: loc.agent.name,
    role: loc.agent.role,
    departmentId: loc.departmentId,
    departmentName: loc.departmentName,
    projectId: loc.projectId,
    projectName: loc.projectName,
    modelId: loc.agent.modelId,
  });
}

function assistantView(): AgentView {
  const def = assistantAgentDef();
  try {
    fs.mkdirSync(def.workdir, { recursive: true });
    fs.mkdirSync(agentDir(ASSISTANT_ID), { recursive: true });
  } catch {
    // ignore
  }
  return viewFromParts({
    agentId: ASSISTANT_ID,
    key: ASSISTANT_ID,
    name: def.name,
    role: "assistant",
    departmentId: ASSISTANT_DEPT_ID,
    departmentName: ASSISTANT_DEPT_NAME,
    projectId: ASSISTANT_PROJECT_ID,
    projectName: ASSISTANT_PROJECT_NAME,
    modelId: def.modelId,
  });
}

export function ensureAssistantAgent(): AgentView {
  return assistantView();
}

export function listAgentsFlat(): AgentView[] {
  const out: AgentView[] = [assistantView()];
  for (const loc of locateAgents()) out.push(viewFor(loc));
  return out;
}

// Resolve "<projectId>::<agentId>" (canonical) or a bare "<agentId>" (first in org order).
function resolveAgent(agentId: string): { agent: AgentType; view: AgentView } | undefined {
  const { projectId, agentId: bare } = splitKey(agentId);
  if (!bare) return undefined;
  if (bare === ASSISTANT_ID) {
    const view = assistantView();
    return { agent: assistantAgentDef(), view };
  }
  const located = locateAgents();
  const loc =
    (projectId ? located.find((l) => l.projectId === projectId && l.agentId === bare) : undefined) ??
    located.find((l) => l.agentId === bare);
  if (!loc) return undefined;
  return { agent: loc.agent, view: viewFor(loc) };
}

export function findAgent(agentId: string): AgentView | undefined {
  return resolveAgent(agentId)?.view;
}

// "<projectId>::<agentId>" -> canonical key; bare ids are returned untouched.
function canonicalKey(agentId: string): string {
  const { projectId, agentId: bare } = splitKey(agentId);
  if (!projectId || bare === ASSISTANT_ID) return bare;
  return agentKey(projectId, bare);
}

export function agentThread(agentId: string, limit = 200): AgentThreadEntry[] {
  const resolved = resolveAgent(agentId);
  const key = resolved ? resolved.view.agentKey : canonicalKey(agentId);
  const entries = readJsonl<AgentThreadEntry>(threadFile(key));
  const n = typeof limit === "number" && limit > 0 ? limit : 200;
  return entries.slice(-n).map((e) => ({
    ts: String(e.ts ?? ""),
    from: e.from === "ceo" ? "ceo" : "agent",
    text: String(e.text ?? ""),
    ...(e.kind ? { kind: String(e.kind) } : {}),
  }));
}

function appendThread(key: string, entry: AgentThreadEntry) {
  appendJsonl(threadFile(key), entry);
}

function enqueue(key: string, item: QueueItem) {
  appendJsonl(queueFile(key), item);
}

// Sessions may or may not hand back their record; read the id defensively either way.
function sessionIdOf(rec: unknown): string | undefined {
  if (rec && typeof rec === "object" && "id" in rec) {
    const id = (rec as { id?: unknown }).id;
    if (typeof id === "string" && id) return id;
  }
  return undefined;
}

function finishOpts(costUsd: number, text: string): { costUsd: number; text: string } {
  return { costUsd, text };
}

function promptFor(text: string): string {
  return [
    "The CEO has sent you a direct message. Answer as yourself (your role), in plain language, concise and concrete.",
    "If the CEO asks for work you can start now, state exactly what you will do and the first step.",
    "Never invent results you did not actually produce.",
    "",
    `CEO: ${text}`,
  ].join("\n");
}

async function executeMessage(
  resolved: { agent: AgentType; view: AgentView },
  text: string,
  force: boolean,
  fromQueue: boolean,
  echoId: string
): Promise<AgentMessageResult> {
  const { agent, view } = resolved;
  const key = view.agentKey;
  const role = agent.role;
  const runtime = roleRuntime(role);
  // budget.ts owns the composite budget key; it is returned on every AgentBudget.
  const budgetKey = view.budget?.agentId || key;
  const taskTitle = `${CEO_TASK_PREFIX}${text.slice(0, 80)}`;

  if (!fromQueue) {
    appendThread(key, { ts: nowIso(), from: "ceo", text, kind: force ? "forced" : "message" });
  }

  const startedMs = Date.now();
  let ev: WorkerEvent;
  try {
    ev = await runAgent(agent, promptFor(text), {
      // workers.ts registers the session + charges the budget from this context.
      taskContext: {
        projectId: view.projectId,
        projectName: view.projectName,
        departmentId: view.departmentId,
        departmentName: view.departmentName,
        taskId: null,
        taskTitle,
      },
      onEvent: () => {
        // progress is streamed into the session by workers.ts itself
      },
    });
  } catch (e) {
    ev = { agentId: view.agentId, role, status: "error", text: String(e), startedAt: nowIso(), finishedAt: nowIso() };
  }

  const raw = String(ev.text ?? "").trim();
  // A failed run is not a queueing outcome: workers.ts marks nonzero opencode exits as
  // session errors too, so mirror that here.
  const exitCode = typeof ev.exitCode === "number" ? ev.exitCode : undefined;
  const failed = ev.status === "error" || (exitCode !== undefined && exitCode !== 0);
  let sid = sessionIdForRun(view.agentId, view.projectId, taskTitle, startedMs);

  if (!sid) {
    // The worker layer did not register a session for this run: register and settle one
    // ourselves so the dashboard still sees the work (and the spend).
    try {
      const ctx: SessionContext = {
        agentId: view.agentId,
        agentName: view.name,
        role,
        departmentId: view.departmentId,
        departmentName: view.departmentName,
        projectId: view.projectId,
        projectName: view.projectName,
        taskId: null,
        taskTitle,
        model: view.modelId,
        runtime,
      };
      sid = sessionIdOf(startSession(ctx));
      markRunning(budgetKey, true);
      const cost = estimateCostForRole(role, runtime);
      if (!failed) charge(budgetKey, cost, taskTitle);
      if (sid) finishSession(sid, failed ? "error" : "done", finishOpts(cost, raw.slice(-2000)));
      markRunning(budgetKey, false);
    } catch {
      // accounting is best effort; the reply still flows back to the CEO
    }
  }

  if (failed) {
    appendThread(key, { ts: nowIso(), from: "agent", text: `(run failed) ${raw.slice(0, 500)}`, kind: "error" });
    void drainQueue(key).catch(() => {});
    const reason =
      exitCode !== undefined && exitCode !== 0
        ? `run exited with code ${exitCode}: ${raw.slice(0, 200) || "no output"}`
        : `run failed: ${raw.slice(0, 300) || "unknown error"}`;
    return {
      agentId: echoId,
      agentKey: key,
      status: "error",
      error: reason,
      sessionId: sid,
      budget: getBudget(budgetKey) ?? view.budget,
    };
  }

  const reply = raw.slice(0, 6000);
  appendThread(key, { ts: nowIso(), from: "agent", text: reply, kind: "reply" });

  void drainQueue(key).catch(() => {});

  return {
    agentId: echoId,
    agentKey: key,
    status: "replied",
    reply,
    sessionId: sid,
    budget: getBudget(budgetKey) ?? view.budget,
  };
}

// Drain held messages once the agent is idle again. Best effort, never blocks a caller.
async function drainQueue(key: string): Promise<void> {
  const resolved = resolveAgent(key);
  if (!resolved) return;
  const { agent, view } = resolved;
  if (runningFor(view.agentId, view.projectId, view.agentKey).length > 0) return;

  const file = queueFile(view.agentKey);
  const items = readJsonl<QueueItem>(file);
  if (!items.length) return;
  try {
    fs.writeFileSync(file, "");
  } catch {
    return;
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item.text !== "string") continue;
    if (runningFor(view.agentId, view.projectId, view.agentKey).length > 0) {
      for (const rest of items.slice(i)) enqueue(view.agentKey, rest);
      return;
    }
    // CEO order 2026-10-01: no per-agent budget gate. A held message is drained
    // regardless of any cap (there are none); provider quota pressure is handled
    // by budgetGuard.ts elsewhere, never by refusing an individual agent here.
    await executeMessage(resolved, item.text, !!item.force, true, view.agentKey);
  }
}

export async function messageAgent(
  agentId: string,
  text: string,
  opts: { run?: boolean; force?: boolean } = {}
): Promise<AgentMessageResult> {
  // Echo the id the caller actually sent, whatever form it took.
  const requestedId = typeof agentId === "string" ? agentId : String(agentId ?? "");
  const resolved = resolveAgent(requestedId);
  if (!resolved) {
    return { agentId: requestedId, agentKey: requestedId, status: "error", error: "unknown agent" };
  }

  const { view } = resolved;
  const key = view.agentKey;
  const message = typeof text === "string" ? text : String(text ?? "");

  // CEO order 2026-10-01: there is NO per-agent budget gate. "Set" controls and
  // the 402 "budget exhausted" refusal are gone; the real protections are the
  // provider quotas in budgetGuard.ts. Messages always run/queue from here.

  // Busy (or explicitly held): persist the message and return immediately.
  if (runningFor(view.agentId, view.projectId, key).length > 0 || opts.run === false) {
    enqueue(key, { ts: nowIso(), text: message, force: !!opts.force });
    appendThread(key, {
      ts: nowIso(),
      from: "ceo",
      text: message,
      kind: opts.run === false ? "held" : "queued",
    });
    return { agentId: requestedId, agentKey: key, status: "queued", budget: view.budget };
  }

  return executeMessage(resolved, message, !!opts.force, false, requestedId);
}
