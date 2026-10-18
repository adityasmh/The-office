// Idempotent org seed for the "Laya AI Company".
//
// Usage: npx tsx scripts/seed-company.ts
//
// Guarantees:
//  - Uses createProject() from src/company/org.ts (never hand-edits org.json).
//  - Never deletes or rewrites existing projects/departments.
//  - Safe to run repeatedly: a second run adds nothing and leaves org.json
//    byte-identical (normalization is deterministic and order-stable).
//
// After seeding, departments are normalized so each name appears exactly once
// and each department owns exactly the projects that reference it.

import path from "node:path";
import fs from "node:fs";
import { loadOrg, saveOrg, createProject, getCompanyRoot } from "../src/company/org.js";
import type { CompanyDef, DepartmentDef } from "../src/company/org.js";

const COMPANY_NAME = "Laya AI Company";

type DesiredProject = {
  departmentName: string;
  projectName: string;
  description: string;
  coderCount: number;
};

// The four departments and their one project each.
const DESIRED: DesiredProject[] = [
  {
    departmentName: "Executive",
    projectName: "Executive Office",
    description: "Executive strategy, planning and cross-company coordination.",
    coderCount: 1,
  },
  {
    departmentName: "Engineering",
    projectName: "Platform Core",
    description: "Core platform engineering and product implementation.",
    coderCount: 2,
  },
  {
    departmentName: "Quality",
    projectName: "QA & Verification",
    description: "Test strategy, verification and release quality gates.",
    coderCount: 1,
  },
  {
    departmentName: "Research",
    projectName: "Applied Research",
    description: "Applied research, prototypes and model evaluation.",
    coderCount: 1,
  },
];

function projectOrgFile(): string {
  return path.join(getCompanyRoot(), "org.json");
}

// Seed any missing department/project pairs. Existing projects are never touched.
// createProject() derives rootDir as company/projects/<projectId>/repo, which is
// the required layout, so we let it own the id and the path.
function seed(): number {
  let created = 0;
  for (const desired of DESIRED) {
    const org = loadOrg();
    const existing = org.projects.find((p) => p.name === desired.projectName);
    if (existing) continue;

    createProject({
      companyName: COMPANY_NAME,
      departmentName: desired.departmentName,
      projectName: desired.projectName,
      description: desired.description,
      coderCount: desired.coderCount,
    });
    created++;
  }
  return created;
}

// Merge duplicate departments by name (keep the first id), remap every project's
// departmentId, and recompute projectIds from the projects list. Deterministic.
function normalize(org: CompanyDef): CompanyDef {
  const byName = new Map<string, DepartmentDef>();
  const remap = new Map<string, string>();

  for (const dept of org.departments) {
    const kept = byName.get(dept.name);
    if (kept) {
      remap.set(dept.id, kept.id);
    } else {
      byName.set(dept.name, { id: dept.id, name: dept.name, projectIds: [] });
    }
  }

  const projects = org.projects.map((p) => {
    const mapped = remap.get(p.departmentId);
    return mapped ? { ...p, departmentId: mapped } : p;
  });

  const departments: DepartmentDef[] = [...byName.values()].map((d) => ({
    id: d.id,
    name: d.name,
    projectIds: projects.filter((p) => p.departmentId === d.id).map((p) => p.id),
  }));

  return { name: COMPANY_NAME, departments, projects };
}

type Summary = {
  company: string;
  generatedAt: string;
  totalDepartments: number;
  totalProjects: number;
  totalAgents: number;
  departments: Array<{ id: string; name: string; projectIds: string[] }>;
  projects: Array<{
    id: string;
    name: string;
    departmentId: string;
    departmentName: string;
    rootDir: string;
    agentIds: string[];
  }>;
};

function summarize(org: CompanyDef): Summary {
  const deptName = (id: string) => org.departments.find((d) => d.id === id)?.name ?? id;
  return {
    company: org.name,
    generatedAt: new Date().toISOString(),
    totalDepartments: org.departments.length,
    totalProjects: org.projects.length,
    totalAgents: org.projects.reduce(
      (n, p) => n + p.teams.reduce((m, t) => m + t.agents.length, 0),
      0,
    ),
    departments: org.departments.map((d) => ({ id: d.id, name: d.name, projectIds: d.projectIds })),
    projects: org.projects.map((p) => ({
      id: p.id,
      name: p.name,
      departmentId: p.departmentId,
      departmentName: deptName(p.departmentId),
      rootDir: p.rootDir,
      agentIds: p.teams.flatMap((t) => t.agents.map((a) => a.id)),
    })),
  };
}

function main() {
  const orgFile = projectOrgFile();
  const before = fs.existsSync(orgFile) ? fs.readFileSync(orgFile, "utf8") : "";

  const created = seed();

  const org = normalize(loadOrg());
  saveOrg(org);

  const after = fs.readFileSync(orgFile, "utf8");
  const summary = summarize(org);

  console.log(`[seed-company] projects created this run: ${created}`);
  console.log(`[seed-company] org.json changed: ${before !== after}`);
  console.log(JSON.stringify(summary, null, 2));

  const notes = [
    "# Org seed notes (scripts/seed-company.ts)",
    "",
    `Generated: ${summary.generatedAt}`,
    `Projects created this run: ${created} (0 means structure already existed)`,
    `org.json changed this run: ${before !== after}`,
    "",
    "## Final department ids",
    "",
    ...summary.departments.map((d) => `- ${d.name}: \`${d.id}\` -> projectIds [${d.projectIds.join(", ")}]`),
    "",
    "Contains the full JSON summary printed by the seed run.",
    "",
    "```json",
    JSON.stringify(summary, null, 2),
    "```",
    "",
  ].join("\n");

  const notesPath = path.join(process.cwd(), "docs", "SEED_NOTES.md");
  fs.mkdirSync(path.dirname(notesPath), { recursive: true });
  fs.writeFileSync(notesPath, notes);
  console.log(`[seed-company] wrote ${notesPath}`);
}

main();
