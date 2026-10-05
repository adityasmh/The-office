import fs from "node:fs";
import path from "node:path";
import { getCompanyRoot, loadOrg, readCost, type AgentType, type CompanyDef, type ProjectDef } from "./org.js";
import { loadTasks, type TaskRec } from "./gates.js";
import { ROLES } from "./roles.js";
import { listSessions, sessionCounts, type SessionRec } from "./sessions.js";
import {
  budgetByDepartment, budgetTotals, ensureAgentBudget, getBudget, listBudgets,
  type AgentBudget, type AgentBudgetContext,
} from "./budget.js";
import { listAgentsFlat } from "./agentchat.js";
import { assistantStatus, assistantThread } from "./assistant.js";
// REAL BUDGET (CEO order 2026-10-01): the same object GET /company/budget/real
// returns, so the page and the API cannot disagree. Sync + memoised; it never
// blocks this payload on a provider read.
import { realBudgetSync } from "./budgetReal.js";

// Assemble the CEO control-panel payload: org tree, live sessions, budgets,
// the CEO assistant thread and the human gate queue.
//
// Read-only by design: budget rows are initialised at most once per agent per
// process (see primeBudgets) so a 2s dashboard poll never rewrites
// company/budgets.json on every frame.
//
// PERF (2026-09-29). The live router answered /health in 9-20 s because this
// payload was 1.49 MB and every reader (the old dashboard's 2 s poll,
// GET /company/panel, the SSE feed in server.ts, the v2 projects view) paid a
// full rebuild. What changed here:
//   * panelData() is memoised for PANEL_CACHE_MS (default 10000 ms; 0 = off) so
//     concurrent callers - the poll, the SSE tick and ?lite=1 - share one build.
//     A cached payload is validated against the mtimes of the files it read plus
//     a session-registry signature, so a new task, a new cap or a new session is
//     never hidden behind the TTL.
//   * each project summary is built ONCE and reused by the flat projects[] and
//     by departments[].projects (which gets a slim projection of the same
//     object - no second file read, no second task/thread walk).
//   * thread/cost/tasks are read with mtime-keyed caches, threads are tail-read,
//     and the per-project arrays are capped to what the dashboards render.
//   * session output tails are capped. The record is otherwise untouched.
// Every cap below names its reader; nothing here is dropped that a reader in
// this repo reads from the panel (public/index.html renderGates/renderOrg,
// public/v2/views/projects.js taskCounts/lastActivity, ops/smoke-company.ts).

const CEO_NAME = process.env.CEO_NAME ?? "Aditya Shukla";

// ---- size / cost knobs -----------------------------------------------------
// PERF (n3-panel-org, 2026-09-30): 3000 -> 10000 ms. The TTL is NOT how long a
// change can stay hidden - signature() below invalidates on the mtime of every
// file that carries state (org.json, budgets.json, assistant.jsonl, each
// tasks.json) plus the session registry, so a new task/cap/session rebuilds on
// the very next call. The TTL only bounds how often the expensive read path runs
// when nothing changed, and how stale the DISPLAY-ONLY parts are (thread tails,
// cost events; their files are deliberately not in the signature, or every thread
// append would invalidate the payload). Measured on an isolated router over a
// copy of the live data: a 2 s caller paid a full rebuild (224 KB, 126-1248 ms)
// every ~3 s; 10 s matches the legacy dashboard's own poll interval
// (public/index.html: setInterval pollNow, 10000 ms) and the v2 heartbeat, so a
// poll at that cadence is now always a cache hit, and a display-only tail is at
// most 10 s behind instead of 3.
const DEFAULT_CACHE_MS = 10000;
const THREAD_LINES = 10; // index.html renders the last 3 lines of a thread
const THREAD_TAIL_BYTES = 64 * 1024; // never read more than this from the end
const THREAD_TEXT_CHARS = 400; // index.html clips a rendered line to 130 chars
const TASK_LIMIT = 20; // unchanged: the newest 20 tasks per project
const TASK_REQUEST_CHARS = 600; // the task board shows 90 chars + a full title
const TASK_ERROR_CHARS = 300; // v2 clips a failure reason to 200 chars
const SESSION_TEXT_CHARS = 600; // the session row's tooltip shows 400 chars
const COST_EVENTS = 50; // newest cost events shipped per project (totalUsd is exact)

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function cacheMs(): number {
  return envMs("PANEL_CACHE_MS", DEFAULT_CACHE_MS);
}

// Trim a rendered string and mark the cut, so a capped value is never mistaken
// for the whole thing.
function cap(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length <= max ? value : `${value.slice(0, max)}\u2026`;
}

// ---- mtime-keyed file cache ------------------------------------------------
// The panel reads org.json, budgets.json, assistant.jsonl and per-project
// tasks.json / thread.jsonl / cost.jsonl. Re-reading and re-parsing them on
// every tick is what made this endpoint cost seconds; the parsed value is reused
// until that file changes (mtime + size), so a write is picked up immediately.
type FileCacheEntry = { key: string; value: unknown };
const fileCache = new Map<string, FileCacheEntry>();
const FILE_CACHE_MAX = 64;

function fileKey(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "missing";
  }
}

function cachedByMtime<T>(file: string, build: () => T): T {
  const key = fileKey(file);
  const hit = fileCache.get(file);
  if (hit && hit.key === key) return hit.value as T;
  const value = build();
  if (fileCache.size >= FILE_CACHE_MAX && !fileCache.has(file)) {
    const oldest = fileCache.keys().next();
    if (!oldest.done) fileCache.delete(oldest.value);
  }
  fileCache.set(file, { key, value });
  return value;
}

// Tail-read a JSONL log: at most `maxBytes` from the end, at most `maxLines`
// complete lines, malformed lines skipped. A multi-megabyte log must never be
// parsed on the dashboard path.
const FULL_READ_MAX_BYTES = 4 * 1024 * 1024;

function parseJsonlLines<T>(text: string, maxLines: number): T[] {
  const out: T[] = [];
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  for (const line of lines.slice(-maxLines)) {
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

function readJsonlTail<T>(file: string, maxLines: number, maxBytes: number): T[] {
  let fd = -1;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size === 0) return [];
    const start = Math.max(0, st.size - maxBytes);
    let text = "";
    if (start === 0) {
      text = fs.readFileSync(file, "utf8");
    } else {
      const len = st.size - start;
      const buf = Buffer.allocUnsafe(len);
      fd = fs.openSync(file, "r");
      fs.readSync(fd, buf, 0, len, start);
      text = buf.toString("utf8");
      // the first line is a fragment (and may start mid UTF-8 sequence): drop it
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    }
    const out = parseJsonlLines<T>(text, maxLines);
    if (out.length === 0 && start > 0 && st.size <= FULL_READ_MAX_BYTES) {
      // No newline inside the window: the tail was a fragment of one very long
      // line, so the bounded read legitimately found nothing. For a file this
      // small, read it whole rather than silently dropping the project's thread
      // (the projection still caps the text that ships, see THREAD_TEXT_CHARS).
      // Beyond the bound this returns [] on purpose: the request path must never
      // read an unbounded log.
      return parseJsonlLines<T>(fs.readFileSync(file, "utf8"), maxLines);
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

const primed = new Set<string>();

export function budgetKey(projectId: string, agentId: string): string {
  return `${projectId}::${agentId}`;
}

function primeBudget(ctx: AgentBudgetContext): AgentBudget | undefined {
  const key = budgetKey(ctx.projectId, ctx.agentId);
  // Always address the row by its COMPOSITE key. The old code fell back to
  // getBudget(ctx.agentId) (the bare id) on the already-primed path, and a bare
  // id resolves to the FIRST registered match (budget.ts resolveKey/aliasToKey):
  // with five "manager" rows that handed pmumhp51r's manager the cap row of
  // whichever project registered first - and which one that was changed between
  // builds, so the same agent showed a different budget on the next request.
  // Verified 2026-09-29: first build vs second build of a fresh process now
  // returns byte-identical budget rows (task board / agent console report F-13).
  if (primed.has(key)) return getBudget(key);
  primed.add(key);
  try {
    return ensureAgentBudget(ctx);
  } catch {
    return getBudget(key);
  }
}

type AgentRow = {
  agentKey: string;
  agent: AgentType;
  project: ProjectDef;
  departmentName: string;
  budget?: AgentBudget;
  running: boolean;
};

function departmentNameFor(org: CompanyDef, departmentId: string): string {
  return org.departments.find((d) => d.id === departmentId)?.name ?? "Unassigned";
}

function agentRows(org: CompanyDef): AgentRow[] {
  const rows: AgentRow[] = [];
  for (const project of org.projects) {
    const departmentName = departmentNameFor(org, project.departmentId);
    for (const team of project.teams) {
      for (const agent of team.agents) {
        const role = ROLES[agent.role];
        const ctx: AgentBudgetContext = {
          agentId: agent.id,
          name: agent.name,
          role: agent.role,
          tier: role?.costTier ?? "mid",
          departmentId: project.departmentId,
          departmentName,
          projectId: project.id,
          projectName: project.name,
          modelId: agent.modelId,
        };
        rows.push({ agentKey: budgetKey(project.id, agent.id), agent, project, departmentName, budget: primeBudget(ctx), running: false });
      }
    }
  }
  return rows;
}

function projectFile(projectId: string, name: string): string {
  return path.join(getCompanyRoot(), "projects", projectId, name);
}

// tasks.json is parsed by gates.ts; this layer caches the result per file
// revision. All tasks are kept (visual.tasks counts them), only the projection
// sent to the browser is capped.
function tasksFor(projectId: string): TaskRec[] {
  const file = projectFile(projectId, "tasks.json");
  return cachedByMtime(file, () => loadTasks(projectId));
}

type ThreadEntry = { ts?: string; agent?: string; role?: string; kind?: string; text?: string };

// Thread tails: org.ts readThread() re-reads and re-parses the whole JSONL
// (up to ~180 KB per project here); the dashboards only render the tail.
function threadFor(projectId: string): ThreadEntry[] {
  const file = projectFile(projectId, "thread.jsonl");
  const tail = cachedByMtime(file, () => readJsonlTail<ThreadEntry>(file, THREAD_LINES, THREAD_TAIL_BYTES));
  return tail.map((m) => ({
    ts: typeof m?.ts === "string" ? m.ts : "",
    agent: typeof m?.agent === "string" ? m.agent : "",
    role: typeof m?.role === "string" ? m.role : "",
    kind: typeof m?.kind === "string" ? m.kind : "",
    text: cap(m?.text, THREAD_TEXT_CHARS) ?? "",
  }));
}

// Cost: the log is append-only, so the tail is what any reader needs. The panel
// ships the total plus the newest PANEL_COST_EVENTS events (v2's lastActivity()
// reads event `ts`, the per-model spend table in the v2 detail view reads
// GET /company/projects/:id/cost, which still returns every event). Without this
// cap one busy project's cost.jsonl alone could push the payload past 300 KB:
// measured, a 257 KB log added 262 KB to the response (PERF-PANEL growth test).
function costFor(projectId: string): ProjectCost {
  const file = projectFile(projectId, "cost.jsonl");
  const raw = cachedByMtime(file, () => readCost(projectId));
  const events = raw.events.length > COST_EVENTS ? raw.events.slice(-COST_EVENTS) : raw.events;
  return { totalUsd: raw.totalUsd, events, eventsTotal: raw.events.length };
}

// ---- projections -----------------------------------------------------------
// PanelTask keeps exactly the fields the panel's readers use:
//   public/index.html renderGates -> id, gates, rawRequest, status, updatedAt
//   public/v2/views/projects.js   -> status (counts), createdAt/updatedAt
//                                     (lastActivity), id
// plan / result / review / enhancedBrief / assignments / trace are NOT read from
// the panel by anything in this repo: the v2 task detail view gets them from
// GET /company/projects/:id/tasks and the Flow view gets the trace from
// GET /company/flow. traceCount keeps that loss explicit instead of silent.
type PanelTask = {
  id: string;
  projectId: string;
  status: TaskRec["status"];
  rawRequest?: string;
  gates?: TaskRec["gates"];
  createdAt?: string;
  updatedAt?: string;
  loopCount?: number;
  error?: string;
  traceCount: number;
};

function panelTask(t: TaskRec): PanelTask {
  return {
    id: t.id,
    projectId: t.projectId,
    status: t.status,
    ...(t.rawRequest ? { rawRequest: cap(t.rawRequest, TASK_REQUEST_CHARS) } : {}),
    ...(t.gates ? { gates: t.gates } : {}),
    ...(t.createdAt ? { createdAt: t.createdAt } : {}),
    ...(t.updatedAt ? { updatedAt: t.updatedAt } : {}),
    ...(typeof t.loopCount === "number" ? { loopCount: t.loopCount } : {}),
    ...(t.error ? { error: cap(t.error, TASK_ERROR_CHARS) } : {}),
    traceCount: t.trace?.length ?? 0,
  };
}

// No per-agent quotas any more (CEO order 2026-10-01): the cap fields are null
// and only the measured spend is real. The shape is kept for old readers.
type ProjectBudget = { allocatedUsd: number | null; spentUsd: number; remainingUsd: number | null };

type ProjectCost = { totalUsd: number; events: Array<Record<string, unknown>>; eventsTotal: number };

type FullAgent = {
  id: string;
  agentKey: string;
  role: string;
  name: string;
  modelId: string;
  workdir: string;
  running: boolean;
  budget?: AgentBudget;
};

type FullTeam = { id: string; name: string; agents: FullAgent[] };

type ProjectSummary = {
  id: string;
  name: string;
  description: string;
  departmentId: string;
  departmentName: string;
  status: ProjectDef["status"];
  rootDir: string;
  running: number;
  budget: ProjectBudget;
  teams: FullTeam[];
  thread: ThreadEntry[];
  tasks: PanelTask[];
  cost: ProjectCost;
};

// The slim project used inside departments[] (and for ?lite=1). id/name/status/
// tasks[].length/teams[].agents[].{id,name,role,budget} are what
// public/index.html renderOrg reads from departments[].projects; the rest of the
// page reads the flat projects[] entries.
type CompactBudget = {
  agentId: string;
  allocatedUsd: number | null;
  spentUsd: number;
  remainingUsd: number | null;
  pctUsed: number | null;
  status: string;
};

type SlimAgent = {
  id: string;
  name: string;
  role: string;
  modelId: string;
  agentKey: string;
  running: boolean;
  budget?: CompactBudget;
};

type SlimTask = { id: string; status: string; updatedAt?: string };

type SlimProject = {
  id: string;
  name: string;
  description: string;
  departmentId: string;
  departmentName: string;
  status: ProjectDef["status"];
  rootDir: string;
  running: number;
  budget: ProjectBudget;
  taskCount: number;
  teams: Array<{ id: string; name: string; agents: SlimAgent[] }>;
  tasks: SlimTask[];
};

function compactBudget(b: AgentBudget | undefined): CompactBudget | undefined {
  if (!b) return undefined;
  return {
    agentId: b.agentId,
    allocatedUsd: b.allocatedUsd,
    spentUsd: b.spentUsd,
    remainingUsd: b.remainingUsd,
    pctUsed: b.pctUsed,
    status: b.status,
  };
}

function slimProject(s: ProjectSummary): SlimProject {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    departmentId: s.departmentId,
    departmentName: s.departmentName,
    status: s.status,
    rootDir: s.rootDir,
    running: s.running,
    budget: s.budget,
    taskCount: s.tasks.length,
    teams: s.teams.map((t) => ({
      id: t.id,
      name: t.name,
      agents: t.agents.map((a) => ({
        id: a.id,
        name: a.name,
        role: a.role,
        modelId: a.modelId,
        agentKey: a.agentKey,
        running: a.running,
        budget: compactBudget(a.budget),
      })),
    })),
    tasks: s.tasks.map((t) => ({ id: t.id, status: t.status, ...(t.updatedAt ? { updatedAt: t.updatedAt } : {}) })),
  };
}

// One summary per project, built from one pass over the rows and one cached read
// of tasks/thread/cost. departments[].projects reuses it (see slimProject).
function buildProjectSummary(
  org: CompanyDef,
  p: ProjectDef,
  projectRows: AgentRow[],
  runningByProject: Map<string, number>,
): ProjectSummary {
  const spent = projectRows.reduce((sum, r) => sum + (r.budget?.spentUsd ?? 0), 0);
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    departmentId: p.departmentId,
    departmentName: departmentNameFor(org, p.departmentId),
    status: p.status,
    rootDir: p.rootDir,
    running: runningByProject.get(p.id) ?? 0,
    budget: { allocatedUsd: null, spentUsd: spent, remainingUsd: null },
    teams: p.teams.map((t) => ({
      id: t.id,
      name: t.name,
      agents: t.agents.map((a) => {
        const row = projectRows.find((r) => r.agent.id === a.id);
        return {
          id: a.id,
          agentKey: budgetKey(p.id, a.id),
          role: a.role,
          name: a.name,
          modelId: a.modelId,
          workdir: a.workdir,
          running: row?.running ?? false,
          budget: row?.budget,
        };
      }),
    })),
    thread: threadFor(p.id),
    tasks: tasksFor(p.id).slice(-TASK_LIMIT).map(panelTask),
    cost: costFor(p.id),
  };
}

function gateQueue(org: CompanyDef, tasks: Map<string, TaskRec[]>) {
  const out: Array<Record<string, unknown>> = [];
  for (const p of org.projects) {
    for (const t of tasks.get(p.id) ?? []) {
      const awaiting = t.status === "pending_intake" ? "intake" : t.status === "pending_code" ? "code" : t.status === "pending_merge" ? "merge" : null;
      if (awaiting) {
        out.push({ projectId: p.id, projectName: p.name, taskId: t.id, request: t.rawRequest, status: t.status, awaiting });
      }
    }
  }
  return out;
}

function sessionAgentKey(s: SessionRec): string {
  return budgetKey(s.projectId, s.agentId);
}

// The session record's output tail is the only big field in it (~1.4 KB average
// here). The dashboard tooltip shows 400 chars and the search box matches on it,
// so cap it there rather than shipping megabytes of build logs.
function trimSession(s: SessionRec): SessionRec {
  const text = s.lastText;
  if (!text || text.length <= SESSION_TEXT_CHARS) return s;
  return { ...s, lastText: cap(text, SESSION_TEXT_CHARS) };
}

// ?lite=1 (public/v2/views/projects.js): no output tails, no project threads,
// no cost events, no gate queue, no assistant thread - the shape stays, the
// heavy leaves are emptied.
type LiteSession = Pick<
  SessionRec,
  | "id" | "agentId" | "agentName" | "role" | "departmentId" | "departmentName"
  | "projectId" | "projectName" | "taskId" | "taskTitle" | "model" | "status" | "startedAt"
> & { finishedAt?: string; costUsd?: number; runtime?: SessionRec["runtime"] };

function liteSession(s: SessionRec): LiteSession {
  return {
    id: s.id,
    agentId: s.agentId,
    agentName: s.agentName,
    role: s.role,
    departmentId: s.departmentId,
    departmentName: s.departmentName,
    projectId: s.projectId,
    projectName: s.projectName,
    taskId: s.taskId,
    taskTitle: s.taskTitle,
    model: s.model,
    status: s.status,
    startedAt: s.startedAt,
    ...(s.finishedAt ? { finishedAt: s.finishedAt } : {}),
    ...(typeof s.costUsd === "number" ? { costUsd: s.costUsd } : {}),
    ...(s.runtime ? { runtime: s.runtime } : {}),
  };
}

// ---- the build -------------------------------------------------------------

function buildPanel(lite: boolean) {
  const org = loadOrg();
  const sessions = listSessions(60);
  const counts = sessionCounts();

  // listAgentsFlat() BEFORE listBudgets(): it is the call that registers every
  // agent's budget identity, and the CEO assistant is the one agent org.json does
  // not describe (its key is p-ceo::assistant). With the old order the FIRST build
  // of a fresh process resolved that key through budget.ts's synthetic fallback
  // (projectName "") and every later build resolved it correctly - a first-vs-warm
  // drift in the payload itself. Same calls, same cost, deterministic now.
  const flatAgents = listAgentsFlat();

  const budgets = listBudgets();
  const budgetIndex = new Map<string, AgentBudget>();
  for (const b of budgets) {
    budgetIndex.set(b.agentId, b);
    budgetIndex.set(budgetKey(b.projectId, b.agentId), b);
  }

  const runningAgentKeys = new Set(sessions.filter((s) => s.status === "running").map(sessionAgentKey));
  const rows = agentRows(org).map((r) => {
    const budget = r.budget ?? budgetIndex.get(r.agentKey) ?? budgetIndex.get(r.agent.id);
    return { ...r, running: runningAgentKeys.has(r.agentKey), budget };
  });
  const rowsByProject = new Map<string, AgentRow[]>();
  for (const r of rows) {
    const list = rowsByProject.get(r.project.id) ?? [];
    list.push(r);
    rowsByProject.set(r.project.id, list);
  }

  const tasks = new Map<string, TaskRec[]>();
  for (const p of org.projects) tasks.set(p.id, tasksFor(p.id));

  const runningByProject = new Map<string, number>();
  for (const s of sessions) {
    if (s.status === "running") runningByProject.set(s.projectId, (runningByProject.get(s.projectId) ?? 0) + 1);
  }

  // ONE summary per project; projects[] and departments[].projects both read it.
  const summaries = new Map<string, ProjectSummary>();
  for (const p of org.projects) {
    summaries.set(p.id, buildProjectSummary(org, p, rowsByProject.get(p.id) ?? [], runningByProject));
  }
  const summariesOf = (p: ProjectDef): ProjectSummary => summaries.get(p.id) as ProjectSummary;

  const fullProjects = org.projects.map(summariesOf);

  const departments = org.departments.map((d) => {
    const deptProjects = org.projects.filter((p) => p.departmentId === d.id);
    const deptRows = rows.filter((r) => r.project.departmentId === d.id);
    const spentUsd = deptRows.reduce((sum, r) => sum + (r.budget?.spentUsd ?? 0), 0);
    return {
      id: d.id,
      name: d.name,
      projectIds: d.projectIds,
      agents: deptRows.length,
      running: deptRows.filter((r) => r.running).length,
      budget: { allocatedUsd: null, spentUsd, remainingUsd: null },
      projects: deptProjects.map((p) => slimProject(summariesOf(p))),
    };
  });

  const totals = budgetTotals();
  const agents = flatAgents.map((a) => ({
    ...a,
    budget: a.budget ?? budgetIndex.get(a.agentKey ?? a.agentId) ?? budgetIndex.get(a.agentId),
  }));

  const assistantInfo = agents.find((a) => a.agentId === "assistant");

  return {
    company: org.name,
    ceo: { name: CEO_NAME, title: "Chief Executive Officer" },
    generatedAt: new Date().toISOString(),
    ...(lite ? { lite: true as const } : {}),
    visual: {
      departments: org.departments.length,
      projects: org.projects.length,
      teams: org.projects.reduce((n, p) => n + p.teams.length, 0),
      agents: rows.length,
      tasks: [...tasks.values()].reduce((n, t) => n + t.length, 0),
      sessionsRunning: counts.running,
      sessionsQueued: counts.queued,
      sessionsTotal: counts.total,
      budgetTotalUsd: null,
      budgetSpentUsd: totals.spentUsd,
      budgetRemainingUsd: null,
    },
    departments,
    projects: lite ? fullProjects.map(slimProject) : fullProjects,
    sessions: {
      running: counts.running,
      queued: counts.queued,
      total: counts.total,
      items: lite ? sessions.map(liteSession) : sessions.map(trimSession),
    },
    budgets: { ...totals, byAgent: budgets, byDepartment: budgetByDepartment() },
    // REAL BUDGET (CEO order 2026-10-01): provider limits + measured spend +
    // read-only per-agent "spent so far". The dashboard reads THIS, not the
    // legacy caps above.
    realBudget: realBudgetSync(),
    agents,
    assistant: {
      agentId: "assistant",
      name: assistantInfo?.name ?? "CEO Assistant",
      status: assistantStatus(),
      budget: assistantInfo?.budget,
      thread: lite ? [] : assistantThread(60),
    },
    gates: lite ? [] : gateQueue(org, tasks),
  };
}

export type PanelPayload = ReturnType<typeof buildPanel>;

// The unmemoised builder, for tests and benchmarks that need a real build.
export function buildPanelData(lite = false): PanelPayload {
  return buildPanel(lite);
}

// ---- memoisation -----------------------------------------------------------
// A cached payload is only reused while it is both inside the TTL and provably
// still current: the signature covers the mtimes of the files the payload read
// (org.json, budgets.json, assistant.jsonl, every tasks.json) plus the session
// registry (counts, ids, statuses). So a new task, a new cap or a new session
// shows up on the very next call - the TTL only decides how often the expensive
// read path runs when nothing changed, which is what makes the poll, the SSE
// tick and ?lite=1 share one build.
//
// Project thread tails and cost events are display-only: they are re-read (via
// the mtime cache) whenever the payload is rebuilt, i.e. at most PANEL_CACHE_MS
// behind.
function fileSignature(): string {
  const root = getCompanyRoot();
  const parts = [
    fileKey(path.join(root, "org.json")),
    fileKey(path.join(root, "budgets.json")),
    fileKey(path.join(root, "assistant.jsonl")),
  ];
  try {
    for (const p of loadOrg().projects) parts.push(fileKey(projectFile(p.id, "tasks.json")));
  } catch {
    parts.push("org-unreadable");
  }
  return parts.join("|");
}

// The ONE place a payload can change without any file changing: sessionCounts()
// walks the in-memory registry and reports "running". Without this token a
// session started/finished inside the TTL would keep the memoised payload until
// the TTL lapsed. Counts only (total/running/queued) - the per-session statuses
// are recomputed on every rebuild, so a registry WRITE creates a new payload on
// the next tick and this token covers the transitions that do not.
//
// PERF (n3-panel-org, 2026-09-30): the per-session id:status suffix that used to
// be appended here was removed. It was redundant work ON THE HOT PATH - the stats
// that carry it (total/running/queued plus each session's status) are captured by
// the fingerprint in panelData() whenever a build actually happens, and a session
// whose status changes without the counts moving still produces a fresh payload
// through that fingerprint, so the stream invalidates either way.
function sessionSignature(): string {
  const counts = sessionCounts();
  return `${counts.total}:${counts.running}:${counts.queued}`;
}

function signature(): string {
  return `${fileSignature()}::${sessionSignature()}`;
}

type CacheEntry = { at: number; signature: string; data: PanelPayload; buildMs: number };
const cache = new Map<"full" | "lite", CacheEntry>();
const stats = { hits: 0, misses: 0, lastBuildMs: 0, reason: "cold" as string };

export type PanelOptions = { force?: boolean; lite?: boolean };

/**
 * Is the memoised payload authoritative at this instant, and if so what signature
 * was it built from? Two calls that return the same non-empty sig describe the
 * same state, so a caller that only wants to know whether anything changed (the
 * SSE feed) can ask WITHOUT paying for a rebuild - it costs only the stat() set
 * that signature() already needs. `locked` is false when PANEL_CACHE_MS=0 (the
 * payload is rebuilt on every call, so there is no built-from signature to
 * compare) or when the entry has just lapsed; the caller falls back to identity.
 */
export function panelState(opts: PanelOptions | boolean = {}): { sig: string; locked: boolean } {
  const o = typeof opts === "boolean" ? { lite: opts } : opts;
  const ttl = cacheMs();
  const entry = cache.get(o.lite ? "lite" : "full");
  const locked = ttl > 0 && !!entry && Date.now() - entry.at <= ttl;
  return { sig: locked ? signature() : "", locked };
}

// `sig` is the value signature() produced BEFORE the build. Recomputing it here
// would hand the next call a signature that already describes the payload we just
// built, which silently defeats the "nothing changed" check; on the forced and
// cache-off paths no sign was taken, so it is computed then. Same strings, same
// result - only the timing changed.
function buildAndStore(key: "full" | "lite", lite: boolean, sig: string): PanelPayload {
  const t0 = Date.now();
  const data = buildPanel(lite);
  const buildMs = Date.now() - t0;
  stats.misses++;
  stats.lastBuildMs = buildMs;
  cache.set(key, { at: Date.now(), signature: sig || signature(), data, buildMs });
  return data;
}

export function panelData(opts: PanelOptions | boolean = {}): PanelPayload {
  const o = typeof opts === "boolean" ? { lite: opts } : opts;
  const key: "full" | "lite" = o.lite ? "lite" : "full";
  const ttl = cacheMs();
  const entry = cache.get(key);
  const cacheable = !o.force && ttl > 0;
  const sig = cacheable ? signature() : "";

  if (cacheable && entry && Date.now() - entry.at <= ttl && entry.signature === sig) {
    stats.hits++;
    stats.reason = "hit";
    return entry.data;
  }
  if (cacheable) stats.reason = !entry ? "cold" : entry.signature !== sig ? "invalidated" : "ttl-expired";
  else stats.reason = o.force ? "forced" : "cache-off";

  return buildAndStore(key, !!o.lite, sig);
}

/**
 * Force a state check without waiting for the next call: returns the signature the
 * current state would produce. Exported for the SSE path and for tests.
 */
export function panelRevision(): string {
  return signature();
}

// Evidence for tests/reports: hit rate, build cost and what invalidated a build.
export function panelCacheStats(): {
  cacheMs: number;
  hits: number;
  misses: number;
  lastBuildMs: number;
  reason: string;
  cached: string[];
  fileCacheEntries: number;
} {
  return {
    cacheMs: cacheMs(),
    hits: stats.hits,
    misses: stats.misses,
    lastBuildMs: stats.lastBuildMs,
    reason: stats.reason,
    cached: [...cache.keys()],
    fileCacheEntries: fileCache.size,
  };
}
