import fs from "node:fs";
import path from "node:path";
import { ROLES, defaultTeamAgents } from "./roles.js";
import { cachedBySig, cloneDeep, fileSig } from "./cache.js";

// Company structure persisted as JSON under a local "company/" root.
// No separate DB: every entity is a file, and per-project folders are
// indexed into a knowledge graph (graphify) so agents share project context.
// Thread/agent message history lives in per-project .jsonl logs.
//
// PERF (docs/PERF_SPEC.md item 2, 2026-09-29, read paths only - no behaviour
// change). These three readers used to re-read and re-parse their file on EVERY
// call, and the dashboard calls them per project per poll:
//   * loadOrg()  - 0.7 ms each, but budget.ts calls it once per agent while it
//                  resolves budget identities (~40x per /company/panel), and
//                  pipeline.ts calls it per project;
//   * readThread() - parses the WHOLE thread.jsonl to return the last N lines
//                  (up to 172 KB per project on this machine);
//   * readCost()   - parses every cost event, on every call.
// Each parse is now reused until mtime+size changes, and every caller still gets
// its own copy, so an in-place edit (server.ts pause/resume mutates a project and
// then saves it) behaves exactly as before.

export type RoleId =
  | "prompt-enhancer"
  | "manager"
  | "coder"
  | "tester"
  | "opposer"
  | "summarizer"
  | "assistant";

export type AgentType = {
  id: string; // unique per team, e.g. "coder-1"
  role: RoleId;
  name: string; // display name
  modelId: string; // model opencode/router should use
  workdir: string; // absolute path this agent operates in
};

export type TeamDef = {
  id: string;
  name: string;
  projectId: string;
  agents: AgentType[];
};

// ── PER-PROJECT TEAM CONFIG (docs/PROJECT_TEAM_SPEC.md) ──────────────────────
// Optional per-project override stored on the project record itself. Absent
// keys mean "the global rule applies" (chooseWorkerModel in dispatch.ts).
export type TeamConfigRole = "manager" | "coder" | "tester" | "opposer";

export type ProjectTeamConfig = {
  /** how many coder agents the project's team has (int 1..6) */
  coders?: number;
  /** role -> model id; wins over the global rule for that project's workers */
  models?: Partial<Record<TeamConfigRole, string>>;
};

export const TEAM_CONFIG_ROLES: TeamConfigRole[] = ["manager", "coder", "tester", "opposer"];

export function isTeamConfigRole(value: string): value is TeamConfigRole {
  return (TEAM_CONFIG_ROLES as string[]).includes(value);
}

/**
 * Validate a raw `team` payload. Pure: no I/O, never throws. Accepts only the
 * keys the spec names; `coders` must be an integer 1..6, `models` keys must be
 * known roles and values non-empty strings. Unknown keys are dropped.
 */
export function validateTeamConfig(input: unknown): { ok: true; team: ProjectTeamConfig } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, team: {} };
  if (typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "team must be an object" };
  const raw = input as Record<string, unknown>;
  const team: ProjectTeamConfig = {};
  if (raw.coders !== undefined && raw.coders !== null) {
    const n = raw.coders;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 6) {
      return { ok: false, error: "team.coders must be an integer 1..6" };
    }
    team.coders = n;
  }
  if (raw.models !== undefined && raw.models !== null) {
    if (typeof raw.models !== "object" || Array.isArray(raw.models)) {
      return { ok: false, error: "team.models must be an object of role -> model id" };
    }
    const models: Partial<Record<TeamConfigRole, string>> = {};
    for (const [role, value] of Object.entries(raw.models as Record<string, unknown>)) {
      if (!isTeamConfigRole(role)) {
        return { ok: false, error: `unknown team role: ${role} (expected one of ${TEAM_CONFIG_ROLES.join(", ")})` };
      }
      if (typeof value !== "string" || !value.trim()) {
        return { ok: false, error: `team.models.${role} must be a non-empty model id` };
      }
      models[role] = value.trim();
    }
    team.models = models;
  }
  return { ok: true, team };
}

export type ProjectDef = {
  id: string;
  name: string;
  description: string;
  departmentId: string;
  rootDir: string; // repo/work folder
  teams: TeamDef[];
  status: "active" | "paused" | "archived";
  // Optional per-project team config (docs/PROJECT_TEAM_SPEC.md). Records written
  // before this field existed simply omit it and still load and behave as before.
  team?: ProjectTeamConfig;
};

export type DepartmentDef = {
  id: string;
  name: string;
  projectIds: string[];
};

export type CompanyDef = {
  name: string;
  departments: DepartmentDef[];
  projects: ProjectDef[];
};

const COMPANY_ROOT = process.env.COMPANY_ROOT ?? path.join(process.cwd(), "company");
const ORG_FILE = path.join(COMPANY_ROOT, "org.json");

export function getCompanyRoot() {
  return COMPANY_ROOT;
}

function readOrgFile(): CompanyDef {
  if (!fs.existsSync(ORG_FILE)) {
    const seed: CompanyDef = { name: "Local AI Company", departments: [], projects: [] };
    fs.mkdirSync(COMPANY_ROOT, { recursive: true });
    fs.writeFileSync(ORG_FILE, JSON.stringify(seed, null, 2));
    return seed;
  }
  return JSON.parse(fs.readFileSync(ORG_FILE, "utf8")) as CompanyDef;
}

export function loadOrg(): CompanyDef {
  // A malformed org.json still throws, exactly as it did before caching (the
  // parse happens inside the cache fill, and a throw is not cached).
  return cloneDeep(cachedBySig<CompanyDef>(`org:${ORG_FILE}`, fileSig(ORG_FILE), readOrgFile));
}

export function saveOrg(org: CompanyDef) {
  fs.mkdirSync(COMPANY_ROOT, { recursive: true });
  fs.writeFileSync(ORG_FILE, JSON.stringify(org, null, 2));
}

export function getProject(projectId: string): ProjectDef | undefined {
  return loadOrg().projects.find((p) => p.id === projectId);
}

// Create a department + project with a default team, persisted to org.json.
// `team` (docs/PROJECT_TEAM_SPEC.md) is optional: when it sets coders, the
// default team is built with that many coders, and the config is stored on the
// project so dispatch can read the model overrides later.
export function createProject(opts: {
  companyName?: string;
  departmentName?: string;
  projectName?: string;
  description?: string;
  rootDir?: string;
  coderCount?: number;
  team?: ProjectTeamConfig;
}): { org: CompanyDef; project: ProjectDef; department: DepartmentDef } {
  const org = loadOrg();
  const companyName = opts.companyName ?? org.name ?? "Local AI Company";
  const deptId = `d${Date.now().toString(36)}`;
  const projId = `p${Date.now().toString(36)}`;
  const rootDir = opts.rootDir ?? path.join(COMPANY_ROOT, "projects", projId, "repo");
  const project: ProjectDef = {
    id: projId,
    name: opts.projectName ?? "Pilot Project",
    description: opts.description ?? "",
    departmentId: deptId,
    rootDir,
    teams: [],
    status: "active",
  };
  const team = opts.team && Object.keys(opts.team).length ? opts.team : undefined;
  if (team) project.team = team;
  const teamAgents = defaultTeamAgents(rootDir, team?.coders ?? opts.coderCount ?? 2);
  project.teams = [{ id: `t${Date.now().toString(36)}`, name: "Default Team", projectId: projId, agents: teamAgents }];
  const department: DepartmentDef = { id: deptId, name: opts.departmentName ?? "Engineering", projectIds: [projId] };
  org.name = companyName;
  org.departments.push(department);
  org.projects.push(project);
  saveOrg(org);
  fs.mkdirSync(project.rootDir, { recursive: true });
  for (const a of teamAgents) fs.mkdirSync(a.workdir, { recursive: true });
  return { org, project, department };
}

export function ensureProjectDir(project: ProjectDef) {
  fs.mkdirSync(project.rootDir, { recursive: true });
  for (const team of project.teams) {
    for (const agent of team.agents) {
      fs.mkdirSync(agent.workdir, { recursive: true });
    }
  }
  return project.rootDir;
}

// ── per-project team config (docs/PROJECT_TEAM_SPEC.md) ─────────────────────

/** Create a standalone department (no project yet). Caller validates the name. */
export function createDepartment(name: string): DepartmentDef {
  const org = loadOrg();
  const department: DepartmentDef = { id: `d${Date.now().toString(36)}`, name: name.trim(), projectIds: [] };
  org.departments.push(department);
  saveOrg(org);
  return department;
}

/**
 * Merge a validated `team` patch into a project and persist it. `coders` replaces
 * the count; `models` merges per role. Returns undefined when the project is gone.
 * Records with no `team` are unaffected by a models-only patch beyond the merge.
 */
export function updateProjectTeam(projectId: string, patch: ProjectTeamConfig): ProjectDef | undefined {
  const org = loadOrg();
  const i = org.projects.findIndex((p) => p.id === projectId);
  if (i < 0) return undefined;
  const merged: ProjectTeamConfig = { ...(org.projects[i].team ?? {}) };
  if (patch.coders !== undefined) merged.coders = patch.coders;
  if (patch.models !== undefined) merged.models = { ...(merged.models ?? {}), ...patch.models };
  org.projects[i] = { ...org.projects[i], team: merged };
  saveOrg(org);
  return org.projects[i];
}

/**
 * A copy of the project whose team's CODER agents match `team.coders` (the spec's
 * "team.coders sets how many coder agents the project's team has"). Other roles
 * and their relative order are preserved; existing coder agents are reused so an
 * edited agent keeps its fields. No `coders` -> the project is returned unchanged
 * (same object), so the global behaviour is byte-for-byte what it was.
 * Pure-ish: it does not write to disk.
 */
export function withTeamConfig(project: ProjectDef): ProjectDef {
  const count = project.team?.coders;
  if (typeof count !== "number" || count < 1) return project;
  const teams = project.teams.map((t) => {
    const others = t.agents.filter((a) => a.role !== "coder");
    const coders: AgentType[] = [];
    for (let i = 1; i <= count; i++) {
      const existing = t.agents.find((a) => a.role === "coder" && a.id === `coder-${i}`);
      coders.push(
        existing ?? {
          id: `coder-${i}`,
          role: "coder",
          name: `Coder ${i}`,
          modelId: ROLES.coder.defaultModel,
          workdir: path.join(project.rootDir, "agents", `coder-${i}`),
        },
      );
    }
    return { ...t, agents: [...others, ...coders] };
  });
  return { ...project, teams };
}

// Thread log: append-only per project JSONL (one line per agent message).
export function appendMessage(projectId: string, entry: { ts: string; agent: string; role: string; kind: string; text: string }) {
  const dir = path.join(COMPANY_ROOT, "projects", projectId);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "thread.jsonl"), JSON.stringify(entry) + "\n");
}

export type ThreadEntry = { ts: string; agent: string; role: string; kind: string; text: string };

function readThreadFile(file: string): ThreadEntry[] {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  // Deliberately not try/catch per line: a malformed thread line still raises, as
  // it did before this cache existed.
  return lines.map((l) => JSON.parse(l) as ThreadEntry);
}

export function readThread(projectId: string, limit = 200): ThreadEntry[] {
  const file = path.join(COMPANY_ROOT, "projects", projectId, "thread.jsonl");
  const all = cachedBySig<ThreadEntry[]>(`thread:${file}`, fileSig(file), () => readThreadFile(file));
  // Fresh objects per call, so callers may edit what they get back.
  return all.slice(-limit).map((e) => ({ ...e }));
}

// Cost meter: append-only JSONL of spend events per project.
export function appendCost(projectId: string, entry: { ts: string; modelId: string; inputTokens?: number; outputTokens?: number; costUsd?: number; note?: string }) {
  const dir = path.join(COMPANY_ROOT, "projects", projectId);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "cost.jsonl"), JSON.stringify(entry) + "\n");
}

export type CostEvent = { ts: string; modelId: string; inputTokens?: number; outputTokens?: number; costUsd?: number; note?: string };

function readCostFile(file: string): { totalUsd: number; events: CostEvent[] } {
  if (!fs.existsSync(file)) return { totalUsd: 0, events: [] };
  const events = fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as CostEvent);
  const totalUsd = events.reduce((s, e) => s + (typeof e.costUsd === "number" ? e.costUsd : 0), 0);
  return { totalUsd, events };
}

export function readCost(projectId: string): { totalUsd: number; events: CostEvent[] } {
  const file = path.join(COMPANY_ROOT, "projects", projectId, "cost.jsonl");
  const parsed = cachedBySig(`cost:${file}`, fileSig(file), () => readCostFile(file));
  // Copies, like readThread: the cached event objects are never handed out.
  return { totalUsd: parsed.totalUsd, events: parsed.events.map((e) => ({ ...e })) };
}