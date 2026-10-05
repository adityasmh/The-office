import os from "node:os";
import { config } from "../config.js";
import { getProject, ensureProjectDir, appendMessage, readThread, loadOrg, withTeamConfig } from "./org.js";
import type { AgentType, RoleId } from "./org.js";
import { ROLES } from "./roles.js";
import { chooseAgent, chooseWorkerModel, escalationAllowed, type Assignment } from "./dispatch.js";
import { runAgent, runParallel, type TaskContext, type WorkerEvent } from "./workers.js";
import { createTask, updateTask, getTask, loadTasks, addTrace, IN_MOTION, type TaskRec } from "./gates.js";
import { postAs, personaForRoute, notifyGate, notifyMerged } from "../slack.js";
import { projectContext } from "./knowledge.js";

// Task lifecycle engine with 3 human gates. Claude (the manager, run through
// Claude Code) is the brain: it plans, decides the dispatch, and reviews the
// work before merge. Laya is only the fallback dispatcher when the plan carries
// no usable DISPATCH line. Every step appends to project thread + Slack mirror.
//
// Resumable: each stage is skipped when its output is already on the task, so
// re-running a task (gate approved late, server restarted) continues where it
// stopped instead of redoing work. Any thrown error marks the task "failed".

export type PipelineHandle = {
  projectId: string;
  taskId: string;
  events: WorkerEvent[];
  task: TaskRec;
};

type PipelineOpts = {
  taskId?: string;
  taskHint?: string;
  auto?: boolean; // if true, skip gates (dangerous but for autonomous runs)
  onEvent?: (ev: WorkerEvent) => void;
  // Called once the task settles (merged or failed) so the caller - the CEO
  // assistant - can report the result back up the chain.
  onFinish?: (task: TaskRec) => void;
};

const MANAGER = "Claude (manager)";

// opencode workers emit one JSON event per line; keep only what the model said.
function readable(text: string | undefined): string {
  const said: string[] = [];
  for (const line of (text ?? "").split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      const ev = JSON.parse(s) as { type?: string; part?: { text?: string } };
      if (ev.type === "text" && ev.part?.text) said.push(ev.part.text);
    } catch {
      // partial line
    }
  }
  return said.length ? said.join("\n").trim() : (text ?? "");
}

// Task ids with a live pipeline in this process.
const active = new Set<string>();

export function isPipelineActive(taskId: string): boolean {
  return active.has(taskId);
}

const MAX_REVIEW_LOOPS = Number(process.env.PIPELINE_MAX_LOOPS ?? 1);
// How long a pipeline waits at a gate before parking. A parked task is picked
// up again by resumeTask() when the gate is approved.
const GATE_WAIT_MS = Number(process.env.GATE_WAIT_SECONDS ?? 600) * 1000;

// Isolated-drill pacing (docs/RESUME_SPEC.md §5, ops only). With MOCK_MODE on, every
// model stage returns instantly, so a whole run finishes in milliseconds and an ops
// restart drill cannot kill the router *inside* a stage. PIPELINE_MOCK_STAGE_DELAY_MS
// holds each in-motion stage for that long - and is a no-op unless MOCK_MODE is on,
// so production behaviour cannot change by setting it by accident. Default 0.
const mockStageDelayMs = () => {
  if (!config.mockMode) return 0;
  const n = Number(process.env.PIPELINE_MOCK_STAGE_DELAY_MS ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
async function holdMockStage(): Promise<void> {
  const ms = mockStageDelayMs();
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}

async function log(projectId: string, agentId: string, role: string, kind: string, text: string, slackThread?: string) {
  const entry = { ts: new Date().toISOString(), agent: agentId, role, kind, text };
  appendMessage(projectId, entry);
  // Mirror to Slack with the right persona (best-effort, non-blocking).
  if (!config.mockMode) {
    void postAs(personaForRoute(role === "manager" ? "claude-subscription" : "gateway", ROLES[role as keyof typeof ROLES]?.defaultModel ?? ""), `${role}: ${text.slice(0, 1500)}`, slackThread).catch(() => {});
  }
  return entry;
}

async function waitGate(gate: "intake" | "code" | "merge", task: TaskRec, auto: boolean): Promise<boolean> {
  if (auto) return true;
  if (getTask(task.projectId, task.id)?.gates[gate]) return true;
  // A human has to act: put it in front of the CEO on Slack with the exact
  // approve path (best effort - the mirror must never block the gate poll).
  void notifyGate(gate, {
    projectId: task.projectId,
    taskId: task.id,
    title: task.rawRequest,
    status: getTask(task.projectId, task.id)?.status ?? task.status,
  });
  // Poll the gate flag without blocking the event loop.
  const deadline = Date.now() + GATE_WAIT_MS;
  while (Date.now() < deadline) {
    const t = getTask(task.projectId, task.id);
    if (t && t.gates[gate]) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false; // parked; approving the gate later resumes via resumeTask()
}

// The manager ends its plan with one machine-readable line:
//   DISPATCH: {"assignments":[{"role":"coder","subtask":"..."}]}
// Coders are spread round-robin over the team's coders.
function parseManagerDispatch(plan: string, agents: AgentType[]): Assignment[] {
  const m = plan.match(/DISPATCH:\s*(\{[\s\S]*\})\s*$/m) ?? plan.match(/DISPATCH:\s*(\{[\s\S]*?\})\s*(?:\n|$)/);
  if (!m) return [];
  let parsed: { assignments?: Array<{ role?: string; subtask?: string }> };
  try {
    parsed = JSON.parse(m[1]);
  } catch {
    return [];
  }
  const coders = agents.filter((a) => a.role === "coder");
  let ci = 0;
  const out: Assignment[] = [];
  for (const a of parsed.assignments ?? []) {
    if (!a.role || !a.subtask) continue;
    // Pipeline-stage roles never run in the work phase.
    if (a.role === "manager" || a.role === "prompt-enhancer" || a.role === "summarizer" || a.role === "assistant") continue;
    let agent: AgentType | undefined;
    if (a.role === "coder" && coders.length) agent = coders[ci++ % coders.length];
    else agent = agents.find((x) => x.role === a.role);
    if (agent) out.push({ agentId: agent.id, role: agent.role, subtask: a.subtask });
  }
  return out;
}

const DISPATCH_INSTRUCTIONS = (agents: AgentType[]) => {
  const coders = agents.filter((a) => a.role === "coder").length;
  return `\n\nYou are the brain of this team. You can read the project files (Read/Glob/Grep) - look before you plan.
Team: ${coders} coder(s) (implement with real file edits, each in its own subfolder agents/coder-N of the project), 1 tester (runs checks AFTER coders finish), 1 opposer (reviews AFTER coders finish).
If the request needs no code (a report, a status summary, a decision), answer it fully yourself in the PLAN and dispatch nothing.
End your reply with exactly one final line, valid JSON, no code fence:
DISPATCH: {"assignments":[{"role":"coder","subtask":"precise self-contained work order incl. exact file paths"}]}
Use "assignments":[] when no work should be dispatched. Give coders distinct, non-overlapping subtasks; only use 2 coders when the work genuinely splits.`;
};

export async function runPipeline(projectId: string, rawRequest: string, opts: PipelineOpts = {}): Promise<PipelineHandle> {
  const stored = getProject(projectId);
  if (!stored) throw new Error(`project not found: ${projectId}`);
  // PER-PROJECT TEAM CONFIG (docs/PROJECT_TEAM_SPEC.md): `team.coders` sets how
  // many coder agents this project's team has. withTeamConfig reconciles the
  // roster (no coders config -> the same object, so nothing changes); the
  // reconciled copy is what the stages build their agents from. ensureProjectDir
  // then creates the workdir of any coder this adds, so an added coder is
  // immediately usable.
  const project = withTeamConfig(stored);
  ensureProjectDir(project);
  const events: WorkerEvent[] = [];
  const onEvent = opts.onEvent ?? ((ev: WorkerEvent) => { events.push(ev); });
  const task = opts.taskId ? getTask(projectId, opts.taskId) ?? createTask(projectId, rawRequest) : createTask(projectId, rawRequest);
  const handle = () => ({ projectId, taskId: task.id, events, task: getTask(projectId, task.id)! });

  if (active.has(task.id)) return handle(); // already running in this process
  active.add(task.id);
  // Remember a gates-skipped (auto) start so a resume continues in the same mode
  // (RESUME_SPEC §2): an unattended task must not start needing approvals because a
  // restart happened to hit it.
  updateTask(projectId, task.id, { runnerPid: process.pid, ...(opts.auto ? { auto: true } : {}) });
  try {
    await stages(project, task, rawRequest, opts, onEvent);
  } catch (e) {
    const msg = String((e as Error)?.stack ?? e).slice(0, 1500);
    updateTask(projectId, task.id, { status: "failed", error: msg });
    addTrace(projectId, task.id, { from: "Pipeline", to: MANAGER, what: "failed", detail: msg.slice(0, 300) });
    await log(projectId, "system", "manager", "error", `Task ${task.id} failed: ${msg.slice(0, 500)}`);
  } finally {
    active.delete(task.id);
  }
  const done = getTask(projectId, task.id);
  if (done && (done.status === "merged" || done.status === "failed")) {
    try { opts.onFinish?.(done); } catch { /* reporting is best effort */ }
  }
  return handle();
}

// Continue a parked/interrupted task in the background (idempotent).
// `reason` only affects the trace: a "restart"/"shutdown" resume records the
// Router hop the dashboard renders distinctly (docs/RESUME_SPEC.md §4); a gate
// approval does not.
export type ResumeReason = "manual" | "gate" | "restart" | "shutdown";

export function resumeTask(projectId: string, taskId: string, reason: ResumeReason = "manual"): boolean {
  const t = getTask(projectId, taskId);
  if (!t || active.has(taskId)) return false;
  if (t.status === "merged" || t.status === "rejected") return false;
  if (reason === "restart" || reason === "shutdown") return startBootResume(projectId, taskId, reason);
  void runPipeline(projectId, t.rawRequest, { taskId, auto: t.auto === true }).catch(() => {});
  return true;
}

function pidAlive(pid: number | undefined): boolean {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check only
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// ── restart resume (docs/RESUME_SPEC.md §2) ──────────────────────────────────
// A restart orphans every pipeline that was mid-stage. Instead of failing those
// tasks (the old behaviour: a human had to press Resume), boot hands them to a
// staggered queue:
//   * one resume per RESUME_STAGGER_SECONDS (default 10 s) - the first starts
//     immediately, the stagger spaces the rest;
//   * at most RESUME_MAX_CONCURRENT (default 3) resumed pipelines in flight at
//     once; the rest wait in this queue;
//   * nothing at all while free RAM is below RESUME_MIN_FREE_RAM_MB (default
//     2048 MB, 0 disables the guard) - resumed coder runs spawn opencode workers.
// Stages already skip finished work, so a resumed task continues from the last
// finished step instead of redoing it.
const RESUME_MAX_INTERRUPTIONS = 2;

function resumeStaggerMs(): number {
  const n = Number(process.env.RESUME_STAGGER_SECONDS ?? 10);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) * 1000 : 10_000;
}
function resumeMaxConcurrent(): number {
  const n = Number(process.env.RESUME_MAX_CONCURRENT ?? 3);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
}
function resumeMinFreeRamMb(): number {
  const raw = process.env.RESUME_MIN_FREE_RAM_MB;
  if (raw === undefined || raw === "") return 2048;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 2048;
}
function freeRamMb(): number {
  try {
    return Math.round(os.freemem() / (1024 * 1024));
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

// Who owns the stage a task stopped in: the "to" of the restart hop.
function stageOwner(t: TaskRec): string {
  const coder = (t.assignments ?? []).find((a) => a.role === "coder");
  switch (t.status) {
    case "enhancing":
      return "prompt-enhancer";
    case "coding":
      return coder ? `${coder.modelId ?? "coder"} (${coder.agentId})` : "coder";
    case "testing":
      return (t.assignments ?? []).find((a) => a.role === "tester")?.agentId ?? "tester";
    case "opposing":
      return (t.assignments ?? []).find((a) => a.role === "opposer")?.agentId ?? "opposer";
    case "summarizing":
      return "summarizer";
    default:
      return MANAGER;
  }
}

type BootQueueItem = { projectId: string; taskId: string; stage: string; since: string; why: "restart" | "shutdown" };
const bootQueue: BootQueueItem[] = [];
const bootRunning = new Set<string>();
let bootTimer: NodeJS.Timeout | undefined;

export type BootResumeStatus = {
  queued: number;
  running: number;
  maxConcurrent: number;
  staggerMs: number;
  minFreeRamMb: number;
  freeRamMb: number;
  active: boolean;
};

export function bootResumeStatus(): BootResumeStatus {
  return {
    queued: bootQueue.length,
    running: bootRunning.size,
    maxConcurrent: resumeMaxConcurrent(),
    staggerMs: resumeStaggerMs(),
    minFreeRamMb: resumeMinFreeRamMb(),
    freeRamMb: freeRamMb(),
    active: !!bootTimer,
  };
}

// Start (or join) one resumed pipeline and record the restart hop the Flow/Fleet
// pages render as "restarted -> resumed at <stage>". `why` only changes the detail:
// a planned shutdown (docs/SHUTDOWN_SPEC.md) is not a crash, but it is still the
// router coming back and picking the work up, so the CEO sees the same hop.
function startBootResume(projectId: string, taskId: string, why: "restart" | "shutdown" = "restart"): boolean {
  const t = getTask(projectId, taskId);
  if (!t || active.has(taskId)) return false;
  const stage = t.status;
  bootRunning.add(taskId);
  addTrace(projectId, taskId, {
    from: "Router",
    to: stageOwner(t),
    what: `restarted \u2192 resumed at ${stage}`,
    detail:
      why === "shutdown"
        ? `the company was shut down on purpose while this task was in "${stage}"; it resumed from the last finished step when the router came back`
        : `the router restarted while this task was in "${stage}"; the pipeline resumed from the last finished step`,
  });
  // A planned shutdown is not an interruption, so its flag goes away here (the
  // task is running again). Recorded on the same write as the resume.
  if (t.pausedByShutdown) updateTask(projectId, taskId, { pausedByShutdown: undefined });
  void runPipeline(projectId, t.rawRequest, { taskId, auto: t.auto === true })
    .catch(() => {})
    .finally(() => bootRunning.delete(taskId));
  return true;
}

function bootResumeTick(): void {
  if (!bootQueue.length) {
    stopBootResumeQueue();
    return;
  }
  if (bootRunning.size >= resumeMaxConcurrent()) return;
  const floor = resumeMinFreeRamMb();
  const free = freeRamMb();
  if (floor > 0 && free < floor) {
    console.log(`[tasks] resume queue paused: ${free} MB free < RESUME_MIN_FREE_RAM_MB=${floor}`);
    return;
  }
  // One start per tick (that is the stagger). Entries that stopped being resumable
  // while they waited are dropped without burning a tick.
  while (bootQueue.length) {
    const item = bootQueue.shift()!;
    const t = getTask(item.projectId, item.taskId);
    if (!t || active.has(t.id)) continue;
    if (!IN_MOTION.includes(t.status)) continue; // parked at a gate / terminal now
    if (startBootResume(item.projectId, item.taskId, item.why)) {
      console.log(`[tasks] restart resume: ${item.projectId}/${item.taskId} was queued at "${item.stage}", now running (resumed at "${t.status}", ${item.why})`);
      return;
    }
  }
  if (!bootQueue.length) stopBootResumeQueue();
}

// Called once at boot (server.ts). Safe to call with an empty queue: it returns
// immediately and starts no timer.
export function startBootResumeQueue(): BootResumeStatus {
  if (!bootTimer && bootQueue.length) {
    bootTimer = setInterval(bootResumeTick, resumeStaggerMs());
    bootTimer.unref?.();
    // The first queued task starts now; the stagger spaces the ones after it.
    bootResumeTick();
  }
  return bootResumeStatus();
}

export function stopBootResumeQueue(): void {
  if (bootTimer) {
    clearInterval(bootTimer);
    bootTimer = undefined;
  }
}

export type ReconcileReport = { queued: number; failed: number; afterShutdown: number };

// At boot nothing is running, so tasks left mid-stage are orphans. Each one is
// queued for an automatic resume (startBootResumeQueue) instead of being marked
// failed, so a restart no longer needs a human. A task already interrupted
// RESUME_MAX_INTERRUPTIONS times is failed instead, with the reason the Briefing
// shows under "Needs you". POST .../run {taskId} still resumes by hand.
// A task carrying `pausedByShutdown` (a PLANNED stop, docs/SHUTDOWN_SPEC.md) is
// always resumed and its flag cleared: a deliberate shutdown is not an interruption.
export function reconcileStaleTasks(): ReconcileReport {
  const report: ReconcileReport = { queued: 0, failed: 0, afterShutdown: 0 };
  for (const p of loadOrg().projects) {
    for (const t of loadTasks(p.id)) {
      // Several server instances can share company/ (e.g. a test server on another
      // port): only touch a task whose runner process is gone.
      if (!IN_MOTION.includes(t.status) || active.has(t.id) || pidAlive(t.runnerPid)) continue;
      if (t.pausedByShutdown) {
        updateTask(p.id, t.id, { pausedByShutdown: undefined });
        bootQueue.push({ projectId: p.id, taskId: t.id, stage: t.status, since: t.updatedAt, why: "shutdown" });
        report.afterShutdown++;
        continue;
      }
      const interruptions = (t.interruptions ?? 0) + 1;
      if (interruptions >= RESUME_MAX_INTERRUPTIONS) {
        updateTask(p.id, t.id, {
          interruptions,
          status: "failed",
          error: `interrupted twice by restarts (caught in "${t.status}"). Resume with POST /company/projects/${p.id}/run {"taskId":"${t.id}"}`,
        });
        addTrace(p.id, t.id, {
          from: "Router",
          to: stageOwner(t),
          what: `restart limit reached (${interruptions})`,
          detail: "interrupted by restarts too often; marked failed instead of resumed, for the CEO to decide",
        });
        report.failed++;
        continue;
      }
      updateTask(p.id, t.id, { interruptions });
      bootQueue.push({ projectId: p.id, taskId: t.id, stage: t.status, since: t.updatedAt, why: "restart" });
      report.queued++;
    }
  }
  return report;
}

async function stages(
  project: NonNullable<ReturnType<typeof getProject>>,
  task: TaskRec,
  rawRequest: string,
  opts: PipelineOpts,
  onEvent: (ev: WorkerEvent) => void,
) {
  const projectId = project.id;
  const auto = opts.auto ?? false;
  const allAgents = project.teams.flatMap((t) => t.agents);
  const cur = () => getTask(projectId, task.id)!;

  // Dashboard hook: tag every session this run starts with the project + task it
  // belongs to, so sessions/budgets can be attributed correctly.
  let departmentName = project.departmentId;
  try {
    departmentName = loadOrg().departments.find((d) => d.id === project.departmentId)?.name ?? project.departmentId;
  } catch {
    // keep the fallback
  }
  const taskContext = (title?: string): TaskContext => ({
    projectId: project.id,
    projectName: project.name,
    departmentId: project.departmentId,
    departmentName,
    taskId: task.id,
    taskTitle: (title ?? rawRequest).slice(0, 120),
  });
  const find = (role: RoleId) => allAgents.find((a) => a.role === role);

  // GATE 1 â€” intake approval.
  if (!cur().gates.intake && !auto) {
    updateTask(projectId, task.id, { status: "pending_intake" });
    if (!(await waitGate("intake", task, auto))) return;
  }

  // Project context digest (HANDOVER 7.2) so agents extend what exists.
  let projectCtx = "";
  try {
    projectCtx = projectContext(projectId, 3000);
  } catch {
    projectCtx = "";
  }
  const withCtx = (prompt: string) =>
    projectCtx
      ? `${prompt}\n\nPROJECT CONTEXT (auto-generated digest of this project's tree; use it instead of re-reading files):\n${projectCtx}`
      : prompt;

  // 1. Prompt enhancer enriches the brief.
  if (!cur().enhancedBrief) {
    updateTask(projectId, task.id, { status: "enhancing" });
    await log(projectId, "system", "manager", "intake", `New task accepted: ${rawRequest.slice(0, 300)}`);
    const enhancer = find("prompt-enhancer") ?? allAgents[0];
    const enhanced = await runAgent(enhancer, withCtx(rawRequest), { onEvent, taskContext: taskContext() });
    if (enhanced.status === "error") throw new Error(`enhancer failed: ${enhanced.text?.slice(0, 300)}`);
    addTrace(projectId, task.id, { from: `${enhancer.modelId} (enhancer)`, to: MANAGER, what: "brief", detail: enhanced.text?.slice(0, 400) });
    updateTask(projectId, task.id, { enhancedBrief: enhanced.text, status: "planned" });
    await log(projectId, enhancer.id, enhancer.role, "enhanced", enhanced.text ?? "");
  }
  const brief = cur().enhancedBrief ?? "";

  // 2. Manager (Claude) plans AND decides the dispatch.
  const manager = find("manager") ?? allAgents[0];
  if (!cur().plan) {
    updateTask(projectId, task.id, { status: "planned" });
    const planRes = await runAgent(
      manager,
      withCtx(`${rawRequest}\n\nEnhanced brief:\n${brief}${DISPATCH_INSTRUCTIONS(allAgents)}`),
      { onEvent, taskContext: taskContext(`Plan: ${rawRequest}`) },
    );
    if (planRes.status === "error") throw new Error(`manager failed: ${planRes.text?.slice(0, 300)}`);
    const fellBack = /\[manager-fallback:/.test(planRes.text ?? "");
    addTrace(projectId, task.id, {
      from: fellBack ? `${config.models.standard} (Claude unavailable, fallback)` : MANAGER,
      to: MANAGER,
      what: "plan",
      detail: planRes.text?.replace(/DISPATCH:[\s\S]*$/, "").slice(0, 500),
    });
    updateTask(projectId, task.id, { plan: planRes.text });
    await log(projectId, manager.id, manager.role, "plan", planRes.text ?? "");
  }
  const plan = cur().plan ?? "";

  // 3. Dispatch: the manager's DISPATCH line wins; Laya only when it is missing.
  if (!cur().assignments) {
    let assignments = parseManagerDispatch(plan, allAgents);
    let reason = `Manager dispatch: ${assignments.map((a) => a.agentId).join(", ") || "none (manager answered directly)"}`;
    if (!assignments.length && !/DISPATCH:/.test(plan)) {
      const d = await chooseAgent(rawRequest, allAgents, opts.taskHint);
      assignments = d.assignments.filter((a) => a.role === "coder" || a.role === "tester" || a.role === "opposer");
      reason = `Manager gave no DISPATCH line; Laya fallback: ${d.reason}`;
      // Without an explicit "assignments":[] the manager did not say "no work", so
      // never silently drop the order: give it to the first coder with the brief.
      const coder = allAgents.find((a) => a.role === "coder");
      if (!assignments.length && coder) {
        assignments = [{ agentId: coder.id, role: coder.role, subtask: `${rawRequest}\n\nMANAGER PLAN:\n${plan.slice(-6000)}` }];
        reason += `; Laya picked no worker, so ${coder.id} gets the order`;
      }
    }
    // Claude decided WHAT; now Claude asks Laya WHO (which model) for each coding subtask.
    // CEO COST RULE CEILING (LAYA-TUNE, Stability 3): pipeline.ts used to take
    // chooseWorkerModel's pick as is, so Laya's UI prior could put a worker on Kimi
    // (config.models.complex, escalation-only) with no justification. fleet.ts
    // `needsEscalation()` enforces the same rule on the fleet path; since fleet.ts
    // imports dispatch.ts (no reverse import allowed), the shared predicate lives in
    // dispatch.ts as `escalationAllowed` mirroring needsEscalation's criteria, and it is
    // applied to the subtask text here. An unjustified kimi pick is downgraded to the
    // cost-rule default (config.models.standard) with the reason recorded in the trace;
    // a justified pick keeps Kimi and records WHY. The Laya trace text keeps the
    // 'noul escalate=' wording from the measured question intact.
    for (const a of assignments) {
      if (a.role !== "coder") continue;
      const pick = await chooseWorkerModel(a.subtask, { projectId, role: a.role });
      if (pick.modelId === config.models.complex) {
        const esc = escalationAllowed(a.subtask);
        if (!esc.escalate) {
          pick.modelId = config.models.standard;
          pick.confidence = 0;
          pick.reason = `kimi refused: no escalation justification -> ${config.models.standard} (cost rule) | was: ${pick.reason}`;
        } else {
          pick.reason = `kimi allowed: ${esc.why} | ${pick.reason}`;
        }
      }
      a.modelId = pick.modelId;
      addTrace(projectId, task.id, {
        from: MANAGER,
        to: "Laya",
        what: "which model?",
        detail: a.subtask.slice(0, 300),
      });
      addTrace(projectId, task.id, {
        from: "Laya",
        to: MANAGER,
        what: `pick: ${pick.modelId}`,
        detail: `${pick.reason} for ${a.agentId}`,
      });
      reason += `\n${a.agentId} -> ${pick.modelId} (${pick.reason})`;
    }
    updateTask(projectId, task.id, { assignments, status: "pending_code" });
    await log(projectId, "system", "manager", "dispatch", reason);
  }
  const assignments = cur().assignments ?? [];

  // GATE 2 â€” before code executes.
  if (assignments.length && !cur().gates.code && !auto) {
    updateTask(projectId, task.id, { status: "pending_code" });
    if (!(await waitGate("code", task, auto))) return;
  }

  // 4. Work phase: coders first, THEN tester + opposer on what the coders did,
  // THEN the manager reviews (PASS, or LOOP once with fix instructions).
  if (!cur().result) {
    let work = "";
    let fixNote = "";
    for (let loop = cur().loopCount; ; loop++) {
      const coderJobs = assignments
        .filter((a) => a.role === "coder")
        .map((a) => {
          const base = allAgents.find((x) => x.id === a.agentId);
          // Run with the model Laya picked for this subtask.
          const agent = base ? { ...base, modelId: a.modelId ?? base.modelId } : undefined;
          const prompt = `${a.subtask}\n\nFULL BRIEF (for context; do only your subtask):\n${brief}${fixNote}`;
          return { agent: agent!, prompt, taskContext: taskContext(a.subtask) };
        })
        .filter((j) => j.agent);
      if (coderJobs.length) {
        updateTask(projectId, task.id, { status: "coding" });
        await holdMockStage(); // ops drill only: see mockStageDelayMs()
        for (const j of coderJobs) {
          addTrace(projectId, task.id, { from: MANAGER, to: `${j.agent.modelId} (${j.agent.id})`, what: fixNote ? "fix order" : "work order", detail: j.prompt.slice(0, 300) });
        }
        const coded = await runParallel(coderJobs, { onEvent, taskContext: taskContext() });
        for (const r of coded) {
          const model = coderJobs.find((j) => j.agent.id === r.agentId)?.agent.modelId ?? "";
          addTrace(projectId, task.id, { from: `${model} (${r.agentId})`, to: MANAGER, what: r.status === "done" ? "result" : "error", detail: readable(r.text).slice(-400) });
        }
        for (const r of coded) await log(projectId, r.agentId, r.role, r.status === "done" ? "done" : "error", r.text ?? "");
        work = coded.map((r) => `## ${r.agentId} (${r.status}, workdir ${allAgents.find((a) => a.id === r.agentId)?.workdir})\n${readable(r.text).slice(-1500)}`).join("\n\n");
      }

      const reviewJobs = assignments
        .filter((a) => a.role === "tester" || a.role === "opposer")
        .map((a) => {
          const agent = allAgents.find((x) => x.id === a.agentId)!;
          const prompt = `${a.subtask}\n\nWHAT THE CODERS REPORTED:\n${work || "(no coder ran)"}\n\nACCEPTANCE (from the brief):\n${brief.slice(0, 3000)}`;
          return { agent, prompt, taskContext: taskContext(a.subtask) };
        })
        .filter((j) => j.agent);
      let reviews = "";
      if (reviewJobs.length) {
        updateTask(projectId, task.id, { status: "testing" });
        const reviewed = await runParallel(reviewJobs, { onEvent, taskContext: taskContext() });
        for (const r of reviewed) {
          const model = reviewJobs.find((j) => j.agent.id === r.agentId)?.agent.modelId ?? "";
          addTrace(projectId, task.id, { from: `${model} (${r.role})`, to: MANAGER, what: r.role === "tester" ? "test report" : "objections", detail: readable(r.text).slice(-400) });
          await log(projectId, r.agentId, r.role, r.status === "done" ? "done" : "error", r.text ?? "");
        }
        reviews = reviewed.map((r) => `## ${r.role} (${r.status})\n${readable(r.text).slice(-1500)}`).join("\n\n");
      }

      if (!coderJobs.length && !reviewJobs.length) break; // manager answered directly

      updateTask(projectId, task.id, { status: "adjudicating" });
      const verdict = await runAgent(
        manager,
        `Review this task's outcome. You can read the files the coders wrote.\n\nREQUEST:\n${rawRequest}\n\nYOUR PLAN:\n${plan.slice(0, 3000)}\n\nCODERS:\n${work}\n\nTESTER/OPPOSER:\n${reviews}\n\nReply with the first line exactly "VERDICT: PASS" or "VERDICT: LOOP", then a short justification. If LOOP, list the precise fixes the coders must make.`,
        { onEvent, taskContext: taskContext(`Review ${task.id}`) },
      );
      await log(projectId, manager.id, manager.role, "review", verdict.text ?? "");
      updateTask(projectId, task.id, { review: verdict.text });
      const wantsLoop = /VERDICT:\s*LOOP/i.test(verdict.text ?? "");
      addTrace(projectId, task.id, { from: MANAGER, to: MANAGER, what: wantsLoop ? "review: LOOP" : "review: PASS", detail: verdict.text?.slice(0, 400) });
      if (!wantsLoop || loop >= MAX_REVIEW_LOOPS || !coderJobs.length) break;
      updateTask(projectId, task.id, { loopCount: loop + 1 });
      fixNote = `\n\nMANAGER REVIEW - FIX THESE BEFORE ANYTHING ELSE:\n${verdict.text}`;
    }

    if (!assignments.length) {
      // The manager answered directly (report, question, decision): its plan IS the result.
      updateTask(projectId, task.id, { result: plan.replace(/DISPATCH:[\s\S]*$/, "").trim(), status: "pending_merge" });
    } else {
    // 5. Summarizer condenses THIS task (not the whole project thread).
    updateTask(projectId, task.id, { status: "summarizing" });
    const summarizer = find("summarizer") ?? allAgents[0];
    const thread = readThread(projectId, 200)
      .filter((m) => Date.parse(m.ts) >= Date.parse(task.createdAt))
      .slice(-30)
      .map((m) => `${m.agent}: ${m.text}`)
      .join("\n");
    const summary = await runAgent(summarizer, `Summarize this task (${task.id}) for the CEO:\nREQUEST: ${rawRequest}\n\n${thread}`, { onEvent, taskContext: taskContext(`Summarize ${task.id}`) });
    updateTask(projectId, task.id, { result: summary.text || cur().review || plan.slice(0, 2000), status: "pending_merge" });
    await log(projectId, summarizer.id, summarizer.role, "summary", summary.text ?? "");
    }
  }

  // GATE 3 â€” before merge.
  if (!cur().gates.merge && !auto) {
    updateTask(projectId, task.id, { status: "pending_merge" });
    if (!(await waitGate("merge", task, auto))) return;
  }
  updateTask(projectId, task.id, { status: "merged" });
  addTrace(projectId, task.id, { from: MANAGER, to: "Assistant", what: "done", detail: (cur().result ?? "").slice(0, 500) });
  await log(projectId, "system", "manager", "merge", `Task ${task.id} merged.`);
  void notifyMerged({
    projectId,
    taskId: task.id,
    title: task.rawRequest,
    detail: (cur().result ?? "").slice(0, 400),
  });
}
