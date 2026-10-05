import path from "node:path";
import { getCompanyRoot, loadOrg } from "./org.js";
import { loadTasks, type TaskRec, type TraceStep } from "./gates.js";
import { cachedBySig, fileSig } from "./cache.js";

// The dashboard's "Flow" view: for each recent task, the hand-off chain
// CEO -> Assistant -> Laya -> Claude (manager) -> Laya -> worker -> Claude -> Assistant -> CEO,
// straight from task.trace. Read-only.
//
// PERF (docs/PERF_SPEC.md item 4, 2026-09-29). This endpoint used to parse every
// project's tasks.json on every call (measured 21-35 ms for 342 KB across five
// projects, and 5.2 s on the loaded live router where the call waited behind
// other work). Now:
//   * each project's tasks are parsed once and reused until that tasks.json
//     changes (mtime + size);
//   * the assembled, sorted, capped answer is memoised on a signature of the
//     per-project task files plus the limit, so repeated polls with no task
//     activity cost a handful of stat() calls.
// The payload is byte-identical to before: same fields, same caps, same order.

export type FlowTask = {
  taskId: string;
  projectId: string;
  projectName: string;
  departmentName: string;
  request: string;
  status: TaskRec["status"];
  createdAt: string;
  updatedAt: string;
  result?: string;
  error?: string;
  trace: TraceStep[];
};

function tasksFile(projectId: string): string {
  return path.join(getCompanyRoot(), "projects", projectId, "tasks.json");
}

function tasksFor(projectId: string): TaskRec[] {
  const file = tasksFile(projectId);
  return cachedBySig<TaskRec[]>(`flow:tasks:${file}`, fileSig(file), () => {
    try {
      return loadTasks(projectId);
    } catch {
      return [];
    }
  });
}

function buildFlow(org: ReturnType<typeof loadOrg>, limit: number): { tasks: FlowTask[] } {
  const out: FlowTask[] = [];
  for (const p of org.projects) {
    const dept = org.departments.find((d) => d.id === p.departmentId)?.name ?? p.departmentId;
    for (const t of tasksFor(p.id)) {
      out.push({
        taskId: t.id,
        projectId: p.id,
        projectName: p.name,
        departmentName: dept,
        request: t.rawRequest.slice(0, 400),
        status: t.status,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        result: t.result?.slice(0, 2000),
        error: t.error?.slice(0, 500),
        // Copies: the parsed task is cached, so a caller must not be able to edit
        // the trace inside the cache (the traces are also not the caller's).
        trace: (t.trace ?? []).map((s) => ({ ...s })),
      });
    }
  }
  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { tasks: out.slice(0, limit) };
}

export function flowData(limit = 25): { tasks: FlowTask[] } {
  const org = loadOrg();
  const sig = [
    org.name,
    org.projects.length,
    limit,
    ...org.projects.map((p) => `${p.id}@${fileSig(tasksFile(p.id))}`),
  ].join("|");
  return cachedBySig<{ tasks: FlowTask[] }>("flow:data", sig, () => buildFlow(org, limit));
}
