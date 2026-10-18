import fs from "node:fs";
import path from "node:path";
import { loadOrg } from "./org.js";
import type { ProjectDef } from "./org.js";
import { loadTasks } from "./gates.js";
import type { TaskRec } from "./gates.js";
import { budgetByDepartment, budgetTotals } from "./budget.js";
import { listSessions, sessionCounts } from "./sessions.js";

// ---------------------------------------------------------------------------
// LIVE COMPANY CONTEXT — the "understand everything" digest.
//
// The CEO's assistant already gets an ORG DIGEST (company, departments, projects,
// agents, per-department budget). That digest answers "who exists" but not "what
// work has been done", so the CEO asking "what has the QA team finished?" got a
// hand-wave. This module assembles a second, cheap digest from state that already
// exists on disk and answers the work/status/budget/session questions:
//
//   - company name, department + project + agent counts
//   - every project: id, name, status, owning department, agent count
//   - TASK BREAKDOWN PER PROJECT BY STATUS (e.g. "merged 3, enhancing 2, testing 1")
//     plus the few most recently touched task titles with their status
//   - budgets: company totals + remaining per department
//   - sessions: how many are running/queued right now, which agent is on what
//   - the key docs worth pointing the CEO at
//
// HARD RULES
//  - READ-ONLY and CHEAP: no LLM calls, no network, no writes. Every source is a
//    file already on disk (org.json, projects/*/tasks.json, budgets.json,
//    sessions.jsonl) behind the accessors the rest of the app uses.
//  - BOUNDED: the result is capped at maxChars (default 3000) so it can be pasted
//    into a planning prompt without blowing the context window. Truncation is
//    explicit ("... (context truncated)").
//  - TOTAL: never throws. Any failure degrades to a single labelled
//    "(context unavailable: <reason>)" line, because a broken digest must never
//    break the assistant turn that carries it.
// ---------------------------------------------------------------------------

export const CEO_CONTEXT_MAX_CHARS = 3000;

// The docs a CEO question usually lands on. Only files that actually exist are
// listed (an assistant that cites a missing doc is worse than one that stays quiet).
const KEY_DOCS = [
  "docs/CEO_RUNBOOK.md",
  "docs/VERIFICATION_REPORT.md",
  "docs/COLLECTED_INPUTS.md",
];

// How much of the raw state to show per project. Small on purpose: this is a
// prompt preamble, not a report.
const RECENT_TASKS_PER_PROJECT = 3;
const MAX_TITLE_CHARS = 70;

function clip(text: unknown, max: number): string {
  const s = typeof text === "string" ? text : String(text ?? "");
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function taskSortKey(t: TaskRec): string {
  return t.updatedAt || t.createdAt || "";
}

// "merged 3, enhancing 2, testing 1" — biggest buckets first so the shape of the
// work is obvious at a glance.
function statusBreakdown(tasks: TaskRec[]): string {
  const counts = new Map<string, number>();
  for (const t of tasks) {
    const status = typeof t?.status === "string" && t.status ? t.status : "unknown";
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([status, n]) => `${status} ${n}`);
  return parts.length ? parts.join(", ") : "(no tasks)";
}

function recentTaskLines(tasks: TaskRec[]): string {
  const recent = [...tasks].sort((a, b) => taskSortKey(b).localeCompare(taskSortKey(a))).slice(0, RECENT_TASKS_PER_PROJECT);
  return recent
    .map((t) => `[${t?.status ?? "unknown"}] ${clip(t?.rawRequest, MAX_TITLE_CHARS)}`)
    .join("; ");
}

function projectAgents(p: ProjectDef): number {
  return (p.teams ?? []).reduce((n, team) => n + (team?.agents?.length ?? 0), 0);
}

function elapsedLabel(startedAt: string): string {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return "?";
  const secs = Math.max(0, Math.round((Date.now() - started) / 1000));
  if (secs < 90) return `${secs}s`;
  const mins = Math.round(secs / 60);
  return mins < 90 ? `${mins}m` : `${Math.round(mins / 60)}h`;
}

function build(maxChars: number): string {
  const out: string[] = [];
  let used = 0;
  let dropped = false;
  // Reserve room for the truncation marker so the RESULT never exceeds maxChars.
  const marker = "... (context truncated)";
  const limit = Math.max(1, maxChars - marker.length - 1);
  // Incremental budget: a section that would overflow the cap is dropped whole
  // rather than sliced mid-line, so the digest always reads as clean lines.
  const add = (line: string): boolean => {
    const cost = line.length + 1;
    if (used + cost > limit) {
      dropped = true;
      return false;
    }
    out.push(line);
    used += cost;
    return true;
  };

  const org = loadOrg();
  const projects = Array.isArray(org.projects) ? org.projects : [];
  const departments = Array.isArray(org.departments) ? org.departments : [];
  const totalAgents = projects.reduce((n, p) => n + projectAgents(p), 0);

  add(`Company: ${org.name || "(unnamed)"} | ${departments.length} department(s), ${projects.length} project(s), ${totalAgents} agent(s)`);

  // Departments with their project/agent counts and remaining budget.
  let deptBudget: ReturnType<typeof budgetByDepartment> = [];
  try {
    deptBudget = budgetByDepartment();
  } catch {
    deptBudget = [];
  }
  if (departments.length) {
    const parts = departments.map((d) => {
      const owned = (d.projectIds ?? [])
        .map((id) => projects.find((p) => p.id === id))
        .filter((p): p is ProjectDef => !!p);
      const agents = owned.reduce((n, p) => n + projectAgents(p), 0);
      const roll = deptBudget.find((b) => b.departmentId === d.id);
      const left = typeof roll?.remainingUsd === "number" ? `, $${roll.remainingUsd.toFixed(2)} budget left` : "";
      return `${d.name} (${owned.length} project(s), ${agents} agent(s)${left})`;
    });
    add(`Departments: ${parts.join("; ")}`);
  }

  // Per-project work state: this is the part that answers "what work has been done?".
  if (projects.length) {
    add("PROJECTS AND WORK:");
    for (const p of projects) {
      const deptName = departments.find((d) => d.id === p.departmentId)?.name ?? "Unassigned";
      let tasks: TaskRec[] = [];
      try {
        tasks = loadTasks(p.id);
      } catch {
        tasks = [];
      }
      if (
        !add(`- ${p.name} (id=${p.id}) status=${p.status} dept=${deptName} agents=${projectAgents(p)}`)
      ) {
        break;
      }
      if (!tasks.length) {
        add("  tasks: none created yet");
        continue;
      }
      add(`  tasks (${tasks.length}): ${statusBreakdown(tasks)}`);
      const recent = recentTaskLines(tasks);
      if (recent) add(`  recent: ${recent}`);
    }
  } else {
    add("PROJECTS AND WORK: none yet (no project has been created)");
  }

  // Money: what is left to spend, company-wide and per department.
  try {
    const totals = budgetTotals();
    add(
      `BUDGETS: there are no per-agent quotas (removed 2026-10-01). Measured spend so far $${totals.spentUsd.toFixed(2)}. ` +
        `The real limits are the provider quotas and balances (GET /company/budget/real).`
    );
    if (deptBudget.length) {
      // Two budget rows can share a display name (the CEO assistant's own row is
      // departmentId "d-ceo" / "Executive", same as the real Executive department),
      // so a duplicated name is disambiguated with its id instead of looking like a
      // contradictory pair of numbers.
      const nameCounts = new Map<string, number>();
      for (const b of deptBudget) {
        const n = b.departmentName || b.departmentId;
        nameCounts.set(n, (nameCounts.get(n) ?? 0) + 1);
      }
      const byDept = deptBudget
        .slice()
        .sort((a, b) => b.spentUsd - a.spentUsd)
        .slice(0, 6)
        .map((b) => {
          const base = b.departmentName || b.departmentId;
          const label = (nameCounts.get(base) ?? 0) > 1 ? `${base} [${b.departmentId}]` : base;
          return `${label} $${b.spentUsd.toFixed(2)} spent`;
        })
        .join(", ");
      add(`  by department (measured spend): ${byDept}`);
    }
  } catch {
    // budget store unavailable: skip the section, keep the rest of the digest
  }

  // What is running right now (this is what makes the assistant feel live).
  try {
    const counts = sessionCounts();
    add(`SESSIONS NOW: ${counts.running} running, ${counts.queued} queued, ${counts.total} known`);
    const running = listSessions(20).filter((s) => s.status === "running").slice(0, 4);
    for (const s of running) {
      add(
        `  ${s.agentName || s.agentId} (${s.role}) on "${clip(s.taskTitle, 60)}" in ${s.projectName || s.projectId} - ${elapsedLabel(s.startedAt)}`
      );
    }
  } catch {
    // session registry unavailable: skip
  }

  // Where to read more. Only docs that exist on disk.
  try {
    const root = process.cwd();
    const present = KEY_DOCS.filter((d) => fs.existsSync(path.join(root, d)));
    if (present.length) add(`KEY DOCS: ${present.join(", ")}`);
  } catch {
    // ignore
  }

  if (dropped) out.push(marker);
  return out.join("\n");
}

/**
 * Compact plain-text digest of live company state, bounded to `maxChars`
 * (default 3000). Read-only, no network, no LLM, never throws: on failure it
 * returns a single labelled "(context unavailable: ...)" line.
 */
export function ceoContextDigest(maxChars: number = CEO_CONTEXT_MAX_CHARS): string {
  const cap = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : CEO_CONTEXT_MAX_CHARS;
  try {
    return build(cap);
  } catch (e) {
    return `(context unavailable: ${clip(e instanceof Error ? e.message : String(e), 200)})`;
  }
}
