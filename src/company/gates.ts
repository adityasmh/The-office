import fs from "node:fs";
import path from "node:path";
import { getCompanyRoot } from "./org.js";
import { cachedBySig, cloneDeep, fileSig } from "./cache.js";

// Human approval gates. Tasks have a status; the pipeline waits at gates.

export type TaskStatus =
  | "pending_intake" // GATE 1
  | "enhancing"
  | "planned"
  | "pending_code" // GATE 2
  | "coding"
  | "testing"
  | "opposing"
  | "summarizing"
  | "adjudicating"
  | "pending_merge" // GATE 3
  | "merged"
  | "rejected"
  | "failed";

export type TaskRec = {
  id: string;
  projectId: string;
  rawRequest: string;
  enhancedBrief?: string;
  plan?: string;
  assignments?: Array<{ agentId: string; role: string; subtask: string; modelId?: string }>;
  status: TaskStatus;
  gates: { intake: boolean; code: boolean; merge: boolean }; // human approval flags
  createdAt: string;
  updatedAt: string;
  result?: string;
  loopCount: number;
  review?: string; // manager's PASS/LOOP verdict on the work
  error?: string; // why the task failed (status "failed")
  trace?: TraceStep[]; // the hand-off chain CEO -> assistant -> Laya -> Claude -> worker -> back
  runnerPid?: number; // process running this task's pipeline (other server instances must not reap it)
  // How many times a restart caught this task mid-stage (docs/RESUME_SPEC.md §2).
  // Boot resumes it when this is 1; at RESUME_MAX_INTERRUPTIONS the task is failed
  // instead of resumed, so a crash loop cannot retry forever.
  interruptions?: number;
  // Set by SHUTDOWN (docs/SHUTDOWN_SPEC.md, src/company/lifecycle.ts) on every task
  // that was mid-stage when the CEO shut the company down on purpose. A planned
  // shutdown is NOT an interruption: boot resumes such a task and clears this flag
  // without touching `interruptions` (pipeline.ts reconcileStaleTasks).
  pausedByShutdown?: boolean;
  // The pipeline was started with the gates skipped (assistant dispatch / auto run).
  // RESUME_SPEC §2: a resume continues in the SAME mode, so an unattended task that a
  // restart interrupted finishes unattended instead of parking at a gate.
  auto?: boolean;
  // NY-RESOLVER additive wiring (docs/NEEDS_YOU_SPEC.md): a note recording the CEO's
  // chosen option on a choice item, visible to the coder in the task record.
  note?: string;
  // Minimal additive drop marker: the task was cancelled by the CEO (no TaskStatus
  // value exists for "dropped", so this field carries the intent).
  closedAs?: "dropped";
  closedReason?: string;
  closedAt?: string;
  closedBy?: string;
};

// One hop in the chain, rendered as the task's flow on the dashboard.
export type TraceStep = {
  ts: string;
  from: string; // "CEO", "Assistant", "Laya", "Claude (manager)", "kimi-k2.7-code (coder-1)"...
  to: string;
  what: string; // short label: "order", "pick team", "plan", "pick model", "result", "review"...
  detail?: string;
};

export function addTrace(projectId: string, taskId: string, step: Omit<TraceStep, "ts">): void {
  try {
    const t = getTask(projectId, taskId);
    if (!t) return;
    t.trace = [...(t.trace ?? []), { ts: new Date().toISOString(), ...step, detail: step.detail?.slice(0, 600) }];
    t.updatedAt = new Date().toISOString();
    saveTask(projectId, t);
  } catch {
    // tracing is best effort
  }
}

// Statuses in which a pipeline is actively working. After a restart nothing is, so
// tasks left in these states are handed to the boot resume queue (pipeline.ts
// reconcileStaleTasks) - they used to be marked failed and needed a manual Resume.
export const IN_MOTION: TaskStatus[] = ["enhancing", "planned", "coding", "testing", "opposing", "summarizing", "adjudicating"];

const dir = () => path.join(getCompanyRoot(), "projects");
const file = (projectId: string) => path.join(dir(), projectId, "tasks.json");

export function loadTasks(projectId: string): TaskRec[] {
  const f = file(projectId);
  const parsed = cachedBySig<TaskRec[]>(`tasks:${f}`, fileSig(f), () => {
    try {
      return JSON.parse(fs.readFileSync(f, "utf8")) as TaskRec[];
    } catch {
      return [];
    }
  });
  // A caller may mutate the array (e.g. saveTask pushes/edits in place before
  // writing). Returning a deep copy keeps the cache entry immutable.
  return cloneDeep(parsed);
}

export function saveTask(projectId: string, task: TaskRec) {
  const tasks = loadTasks(projectId);
  const i = tasks.findIndex((t) => t.id === task.id);
  if (i >= 0) tasks[i] = task;
  else tasks.push(task);
  fs.mkdirSync(path.join(dir(), projectId), { recursive: true });
  fs.writeFileSync(file(projectId), JSON.stringify(tasks, null, 2));
}

export function getTask(projectId: string, taskId: string): TaskRec | undefined {
  return loadTasks(projectId).find((t) => t.id === taskId);
}

export function createTask(projectId: string, rawRequest: string): TaskRec {
  const task: TaskRec = {
    id: `t${Date.now().toString(36)}`,
    projectId,
    rawRequest,
    status: "pending_intake",
    gates: { intake: false, code: false, merge: false },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    loopCount: 0,
  };
  saveTask(projectId, task);
  return task;
}

export function approveGate(projectId: string, taskId: string, gate: "intake" | "code" | "merge"): TaskRec {
  const t = getTask(projectId, taskId);
  if (!t) throw new Error(`task not found: ${taskId}`);
  t.gates[gate] = true;
  if (gate === "intake" && t.status === "pending_intake") t.status = "enhancing";
  if (gate === "merge" && t.status === "pending_merge") t.status = "merged";
  t.updatedAt = new Date().toISOString();
  saveTask(projectId, t);
  return t;
}

export function updateTask(projectId: string, taskId: string, patch: Partial<TaskRec>): TaskRec {
  const t = getTask(projectId, taskId);
  if (!t) throw new Error(`task not found: ${taskId}`);
  const next: TaskRec = { ...t, ...patch, updatedAt: new Date().toISOString() };
  saveTask(projectId, next);
  return next;
}

/** NY-RESOLVER additive wiring: mark a task as dropped by the CEO. */
export function dropTask(projectId: string, taskId: string, reason?: string, who?: string): TaskRec {
  const t = getTask(projectId, taskId);
  if (!t) throw new Error(`task not found: ${taskId}`);
  const now = new Date().toISOString();
  const next: TaskRec = {
    ...t,
    closedAs: "dropped",
    closedReason: reason || "dropped by the CEO",
    closedAt: now,
    closedBy: who || "ceo",
    updatedAt: now,
  };
  saveTask(projectId, next);
  return next;
}