// ops/fix-org.ts — one-off + re-runnable org.json hygiene pass.
//
// WHAT IT DOES (idempotent: running it twice changes nothing the second time)
//   1. Kills the stray near-duplicate department "Eng" (dmumhg71w, minted by an
//      early manual createProject test). Its only project (pmumhg71w "LiveFinal")
//      is re-pointed at Engineering (dmumhp51u), the project id is appended to
//      Engineering.projectIds, and the now-empty "Eng" department is dropped.
//      NO project, team, agent, task, thread or file on disk is deleted.
//   2. Normalizes department.projectIds hygiene for every department:
//      de-duplicate, drop ids that are not in org.projects, and make sure every
//      project that names a department is listed exactly once (no project may be
//      claimed by two departments).
//   3. VERIFIES the result and prints a report:
//      - agent count: 32 team agents + 1 assistant = 33
//      - every project's rootDir exists on disk (missing ones are listed)
//      - every project.departmentId resolves to a real department
//      - department <-> project cross-references agree
//
// WHAT IT DOES NOT DO
//   - It never touches company/projects/**, budgets.json, sessions.jsonl, or any
//     agent workdir. It only rewrites company/org.json, and only when the
//     normalized doc actually differs from what is on disk.
//   - The assistant's pseudo-department ("d-ceo", not stored in org.json at all)
//     is handled in code, not data: see ASSISTANT_DEPT_NAME in
//     src/company/agentchat.ts. This script only reports it.
//
// USAGE
//   npx tsx ops/fix-org.ts              # apply (idempotent; prints before/after + checks)
//   npx tsx ops/fix-org.ts --dry-run    # report only, never writes
//   (COMPANY_ROOT env var overrides the company/ location, same as src/company/org.ts)

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types (mirrors src/company/org.ts; duplicated so the script stays standalone)
// ---------------------------------------------------------------------------

type AgentType = { id: string; role: string; name: string; modelId: string; workdir: string };
type TeamDef = { id: string; name: string; projectId: string; agents: AgentType[] };
type ProjectDef = {
  id: string;
  name: string;
  description: string;
  departmentId: string;
  rootDir: string;
  teams: TeamDef[];
  status: "active" | "paused" | "archived";
};
type DepartmentDef = { id: string; name: string; projectIds: string[] };
type CompanyDef = { name: string; departments: DepartmentDef[]; projects: ProjectDef[] };

// ---------------------------------------------------------------------------
// Config: the stray department and the department it is folded into
// ---------------------------------------------------------------------------

const STRAY_DEPT_ID = "dmumhg71w";
const STRAY_DEPT_NAME = "Eng";
const TARGET_DEPT_ID = "dmumhp51u";
const TARGET_DEPT_NAME = "Engineering";
const ASSISTANT_ID = "assistant";
const ASSISTANT_DEPT_ID = "d-ceo";
const ASSISTANT_DEPT_NAME = "Executive Office"; // must match ASSISTANT_DEPT_NAME in src/company/agentchat.ts
const EXPECTED_TEAM_AGENTS = 32;
const EXPECTED_AGENT_TOTAL = EXPECTED_TEAM_AGENTS + 1; // + the CEO assistant

const COMPANY_ROOT = process.env.COMPANY_ROOT ?? path.join(process.cwd(), "company");
const ORG_FILE = path.join(COMPANY_ROOT, "org.json");

const DRY_RUN = process.argv.includes("--dry-run");

// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------

function readText(file: string): string {
  return fs.readFileSync(file, "utf8");
}

function parseOrg(text: string): CompanyDef {
  const parsed = JSON.parse(text) as CompanyDef;
  if (!parsed || typeof parsed !== "object") throw new Error("org.json is not an object");
  if (!Array.isArray(parsed.departments)) throw new Error("org.json: departments[] missing");
  if (!Array.isArray(parsed.projects)) throw new Error("org.json: projects[] missing");
  return parsed;
}

function serialize(org: CompanyDef): string {
  // Exactly the serialization src/company/org.ts saveOrg() uses, so a later
  // saveOrg() call cannot re-diff the file.
  return JSON.stringify(org, null, 2);
}

function writeIfChanged(text: string, next: string): boolean {
  if (text === next) return false;
  fs.writeFileSync(ORG_FILE, next);
  return true;
}

function deptList(org: CompanyDef): string {
  return JSON.stringify(
    org.departments.map((d) => ({ id: d.id, name: d.name, projectIds: d.projectIds })),
    null,
    2
  );
}

function findDept(org: CompanyDef, id: string, name: string): DepartmentDef | undefined {
  return org.departments.find((d) => d.id === id) ?? org.departments.find((d) => d.name === name);
}

// ---------------------------------------------------------------------------
// Normalization steps
// ---------------------------------------------------------------------------

type Change = string;

function mergeStrayDepartment(org: CompanyDef, changes: Change[]): void {
  const stray = findDept(org, STRAY_DEPT_ID, STRAY_DEPT_NAME);
  if (!stray) {
    console.log(`[merge] no stray department "${STRAY_DEPT_NAME}" (${STRAY_DEPT_ID}) — nothing to merge`);
    return;
  }
  const target = findDept(org, TARGET_DEPT_ID, TARGET_DEPT_NAME);
  if (!target) throw new Error(`cannot merge ${stray.id}: target department ${TARGET_DEPT_ID} (${TARGET_DEPT_NAME}) not found`);
  if (target.id === stray.id) throw new Error("stray department and target department are the same record");

  // Projects that belong to the stray department: org order, plus any project
  // whose departmentId names it (belt and braces for a half-edited file).
  const claimed = org.projects.filter((p) => p.departmentId === stray.id || stray.projectIds.includes(p.id));

  for (const p of claimed) {
    if (p.departmentId !== target.id) {
      changes.push(`re-point project ${p.id} "${p.name}" departmentId ${p.departmentId} -> ${target.id} (${target.name})`);
      p.departmentId = target.id;
    }
    if (!target.projectIds.includes(p.id)) {
      changes.push(`add project ${p.id} to department ${target.id} projectIds`);
      target.projectIds.push(p.id);
    }
  }

  org.departments = org.departments.filter((d) => d.id !== stray.id);
  changes.push(`drop empty stray department ${stray.id} "${stray.name}" (projectIds were ${JSON.stringify(stray.projectIds)})`);
}

function normalizeProjectIds(org: CompanyDef, changes: Change[]): void {
  const projectIds = new Set(org.projects.map((p) => p.id));

  for (const d of org.departments) {
    const before = d.projectIds ?? [];
    const deduped: string[] = [];
    for (const pid of before) {
      if (!projectIds.has(pid)) {
        changes.push(`department ${d.id}: drop projectIds entry "${pid}" (no such project)`);
        continue;
      }
      if (deduped.includes(pid)) {
        changes.push(`department ${d.id}: drop duplicate projectIds entry "${pid}"`);
        continue;
      }
      deduped.push(pid);
    }
    d.projectIds = deduped;
  }

  // Any project that names a department must appear in that department's list.
  for (const p of org.projects) {
    const d = org.departments.find((x) => x.id === p.departmentId);
    if (d && !d.projectIds.includes(p.id)) {
      d.projectIds.push(p.id);
      changes.push(`department ${d.id}: add missing projectIds entry "${p.id}" (project ${p.id} claims it)`);
    }
  }

  // No project may be listed by a department that does not own it.
  for (const d of org.departments) {
    d.projectIds = d.projectIds.filter((pid) => {
      const p = org.projects.find((x) => x.id === pid);
      if (p && p.departmentId !== d.id) {
        changes.push(`department ${d.id}: drop projectIds entry "${pid}" (project ${pid} actually belongs to ${p.departmentId})`);
        return false;
      }
      return true;
    });
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

type Report = {
  teamAgents: number;
  agentTotal: number;
  missingRootDirs: Array<{ projectId: string; name: string; rootDir: string }>;
  orphanProjects: Array<{ projectId: string; departmentId: string }>;
  unlistedProjects: string[];
  problems: string[];
};

function verify(org: CompanyDef): Report {
  const problems: string[] = [];
  let teamAgents = 0;
  let assistantSeen = false;
  for (const p of org.projects) {
    for (const t of p.teams) {
      for (const a of t.agents) {
        teamAgents++;
        if (a.id === ASSISTANT_ID) assistantSeen = true;
      }
    }
  }
  const agentTotal = teamAgents + 1; // the assistant is code-registered, never in org.json
  if (teamAgents !== EXPECTED_TEAM_AGENTS) {
    problems.push(`team agent count is ${teamAgents}, expected ${EXPECTED_TEAM_AGENTS}`);
  }
  if (assistantSeen) problems.push(`an agent with id "${ASSISTANT_ID}" is inside a project team (it must only be code-registered)`);

  const missingRootDirs: Report["missingRootDirs"] = [];
  for (const p of org.projects) {
    if (!p.rootDir || !fs.existsSync(p.rootDir)) {
      missingRootDirs.push({ projectId: p.id, name: p.name, rootDir: p.rootDir });
    }
  }

  const orphanProjects: Report["orphanProjects"] = [];
  for (const p of org.projects) {
    if (!org.departments.some((d) => d.id === p.departmentId)) {
      orphanProjects.push({ projectId: p.id, departmentId: p.departmentId });
    }
  }
  if (orphanProjects.length) problems.push(`${orphanProjects.length} project(s) point at a department that does not exist`);

  const unlistedProjects = org.projects.filter((p) => !org.departments.some((d) => d.projectIds.includes(p.id))).map((p) => p.id);
  if (unlistedProjects.length) problems.push(`project(s) not listed by any department: ${unlistedProjects.join(", ")}`);

  for (const d of org.departments) {
    if (d.projectIds.some((pid, i) => d.projectIds.indexOf(pid) !== i)) problems.push(`department ${d.id} has duplicate projectIds`);
  }

  const names = new Map<string, string[]>();
  for (const d of org.departments) {
    const key = d.name.trim().toLowerCase();
    names.set(key, [...(names.get(key) ?? []), d.id]);
  }
  for (const [name, ids] of names) {
    if (ids.length > 1) problems.push(`duplicate department name "${name}": ${ids.join(", ")}`);
  }

  return { teamAgents, agentTotal, missingRootDirs, orphanProjects, unlistedProjects, problems };
}

function printReport(org: CompanyDef, report: Report): void {
  console.log("");
  console.log("== verification ==");
  console.log(`team agents in org.json : ${report.teamAgents} (expected ${EXPECTED_TEAM_AGENTS})`);
  console.log(`agents total (+assistant): ${report.agentTotal} (expected ${EXPECTED_AGENT_TOTAL})`);
  console.log(`departments             : ${org.departments.length}`);
  console.log(`projects                : ${org.projects.length}`);
  console.log(`teams                   : ${org.projects.reduce((n, p) => n + p.teams.length, 0)}`);
  console.log(
    `rootDir missing on disk : ${report.missingRootDirs.length ? report.missingRootDirs.map((m) => `${m.projectId} (${m.name}) -> ${m.rootDir}`).join("; ") : "none"}`
  );
  console.log(`assistant pseudo-dept   : ${ASSISTANT_DEPT_ID} "${ASSISTANT_DEPT_NAME}" (code constant in src/company/agentchat.ts, not stored in org.json)`);
  if (report.problems.length) {
    console.log("PROBLEMS:");
    for (const p of report.problems) console.log(`  - ${p}`);
  } else {
    console.log("problems                : none");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  console.log(`org file : ${ORG_FILE}`);
  console.log(`mode     : ${DRY_RUN ? "dry run (--dry-run)" : "apply (idempotent, writes only if org.json differs)"}`);

  const before = readText(ORG_FILE);
  const org = parseOrg(before);

  console.log("");
  console.log("== before: departments (id, name, projectIds) ==");
  console.log(deptList(org));

  const changes: Change[] = [];
  mergeStrayDepartment(org, changes);
  normalizeProjectIds(org, changes);

  const after = serialize(org);
  const changed = before !== after;

  console.log("");
  console.log("== changes ==");
  if (!changed) {
    console.log("none — org.json is already normalized (this run is a no-op)");
  } else if (!changes.length) {
    console.log("file content differs (formatting/trailing whitespace only)");
  } else {
    for (const c of changes) console.log(`  - ${c}`);
  }

  if (changed && !DRY_RUN) {
    writeIfChanged(before, after);
    console.log("org.json written");
  } else if (changed && DRY_RUN) {
    console.log("DRY RUN: org.json NOT written");
  }

  console.log("");
  console.log("== after: departments (id, name, projectIds) ==");
  console.log(deptList(org));

  printReport(org, verify(org));

  console.log("");
  console.log(`written: ${changed && !DRY_RUN ? "yes" : "no"}`);
}

main();
