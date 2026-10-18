// Repeatable regression smoke harness for the live Laya AI Company server.
//
// Code against docs/CEO_DASHBOARD_API.md (frozen contract) and docs/SMOKE_TESTS.md.
// Reconciliations baked in (contract changed after the first draft of this file):
//   * the canonical agent identity is the COMPOSITE key "<projectId>::<agentId>"
//     (AgentBudget.agentId / panel.agents[].agentKey). The CEO assistant is the
//     one exception: its key is "assistant"; this harness accepts either
//     "assistant" or its composite for the assistant alone.
//   * extra response fields are allowed: every check validates required fields
//     and never asserts an exact key set.
//   * a failed agent run is status:"error" (server maps it to 502); "queued"
//     only means the agent was busy. Those statuses are contract-legal here.
//   * pctUsed is 0 when allocatedUsd and spentUsd are both 0.
//   * stale sessions are reconciled on boot (src/company/sessions.ts
//     reconcileStaleSessions); this harness asserts no session is exposed as
//     "running" with an ancient startedAt.
//   * the router runs as a hidden background process with logs in
//     logs/router.*.log; check 10 asserts those logs exist (localhost only).
//
// Usage:
//   npx tsx ops/smoke-company.ts [--base http://localhost:8787] [--root <dir>]
//                               [--timeout <ms>] [--skip-mutating]
//                               [--strict-dispatch] [--json]
//
// Read-only except check 12 (MUTATING), which POSTs one
// /company/assistant/message with { autoRun: false }. That creates a task but
// starts no pipeline and dispatches no agent, so no agent budget is spent. The
// assistant's planning call is charged to the assistant budget: observed
// $0.050000 per call, and the harness prints the measured delta.
//
// The box may be shared: check 12 counts a new session as a failure only when it
// is attributable to the smoke task or to a target project; unrelated traffic is
// reported. Pass --strict-dispatch to fail on ANY new session in the 10s window
// (use it on a quiesced router).
//
// Prints PASS/FAIL per check (with trimmed observed output) and exits nonzero
// if any check fails.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { companyAuthHeaders } from "../src/company/authguard.js";

type CheckTag = "free" | "mutating";
type Check = { n: number; name: string; tag: CheckTag; ok: boolean; detail: string };
const checks: Check[] = [];

function record(n: number, name: string, tag: CheckTag, ok: boolean, detail: string) {
  checks.push({ n, name, tag, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} [${n}] ${name} (${tag})`);
  if (detail) console.log(`      ${detail}`);
}

function trim(v: unknown, max = 400): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s === undefined) return "undefined";
  return s.length > max ? s.slice(0, max) + `…(+${s.length - max} chars)` : s;
}

function listBad(bad: string[], max = 400): string {
  if (bad.length <= 3) return bad.join(" | ");
  return `${bad.slice(0, 3).join(" | ")} | …(${bad.length} problems)`;
}

// Error -> string including the undici cause (code/message) for diagnosis.
function errStr(e: unknown): string {
  const cause = (e as any)?.cause;
  const c = cause ? ` | cause=${cause.code ?? ""} ${cause.message ?? String(cause)}` : "";
  return trim(String(e) + c, 300);
}

function isObj(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function nonEmptyStr(v: unknown): boolean {
  return typeof v === "string" && v.length > 0;
}
function isNum(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v);
}
function near(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol;
}
function parseableDate(v: unknown): boolean {
  return typeof v === "string" && Number.isFinite(Date.parse(v));
}

// --- CLI -------------------------------------------------------------------

const args = process.argv.slice(2);
let base = process.env.SMOKE_BASE ?? "http://localhost:8787";
let rootArg = "";
let timeoutMs = 15000;
let skipMutating = false;
let strictDispatch = false;
let emitJson = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--base" && args[i + 1]) base = args[++i];
  else if (a.startsWith("--base=")) base = a.slice("--base=".length);
  else if (a === "--root" && args[i + 1]) rootArg = args[++i];
  else if (a.startsWith("--root=")) rootArg = a.slice("--root=".length);
  else if (a === "--timeout" && args[i + 1]) timeoutMs = Number(args[++i]) || timeoutMs;
  else if (a.startsWith("--timeout=")) timeoutMs = Number(a.slice("--timeout=".length)) || timeoutMs;
  else if (a === "--skip-mutating") skipMutating = true;
  else if (a === "--strict-dispatch") strictDispatch = true;
  else if (a === "--json") emitJson = true;
  else if (a === "-h" || a === "--help") {
    console.log("usage: npx tsx ops/smoke-company.ts [--base url] [--root dir] [--timeout ms] [--skip-mutating] [--strict-dispatch] [--json]");
    process.exit(0);
  }
}
base = base.replace(/\/+$/, "");
const isLocalBase = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(base);

// Trust boundary (docs/CEO_RUNBOOK.md §0): /company/* mutations and the SSE
// stream need the shared secret. COMPANY_AUTH_TOKEN in the environment wins;
// otherwise, for a loopback base, the secret is read from the loopback-only
// bootstrap endpoint so this harness keeps working with zero configuration.
// Resolution is bounded: a token bootstrap that never answers must not block the
// harness before it prints anything (checks then run unauthenticated and any
// 401/403 shows up explicitly in the check output). The token value is never
// printed or written anywhere.
let authHeaders: Record<string, string> = {};
let authNote = "not resolved";

async function resolveAuthHeaders(tokenTimeoutMs = 5000): Promise<void> {
  const raced = Promise.race([
    companyAuthHeaders(base).catch(() => ({}) as Record<string, string>),
    new Promise<Record<string, string>>((resolve) => setTimeout(() => resolve({}), tokenTimeoutMs)),
  ]);
  const headers = await raced;
  authHeaders = headers && typeof headers === "object" ? headers : {};
  authNote = Object.keys(authHeaders).length ? "control-plane token resolved" : "no token (unauthenticated)";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function req(
  urlPath: string,
  init?: { method?: string; body?: unknown; timeoutMs?: number },
): Promise<{ status: number; json: any; raw: string; ok: boolean }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init?.timeoutMs ?? timeoutMs);
  try {
    const headers: Record<string, string> = { ...authHeaders };
    let body: string | undefined;
    if (init?.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.body);
    }
    const res = await fetch(base + urlPath, { method: init?.method ?? "GET", headers, body, signal: ctrl.signal });
    const raw = await res.text();
    let json: any = undefined;
    try {
      json = JSON.parse(raw);
    } catch {
      /* leave undefined */
    }
    return { status: res.status, json, raw, ok: true };
  } finally {
    clearTimeout(timer);
  }
}

// --- on-disk org -----------------------------------------------------------

type OrgAgent = { id: string; role: string; name?: string; workdir: string };
type OrgProject = { id: string; name: string; rootDir: string; departmentId?: string; teams: { id?: string; agents: OrgAgent[] }[] };
type Org = {
  name: string;
  departments: { id: string; name: string; projectIds?: string[] }[];
  projects: OrgProject[];
};

function findRoot(): string {
  if (rootArg) return path.resolve(rootArg);
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [process.cwd(), path.resolve(scriptDir, ".."), path.resolve(scriptDir, "..", "..")];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "company", "org.json"))) return c;
  }
  return process.cwd();
}

function readOrg(root: string): Org {
  return JSON.parse(fs.readFileSync(path.join(root, "company", "org.json"), "utf8")) as Org;
}

// --- identity helpers ------------------------------------------------------

function budgetKeyFor(projectId: unknown, agentId: unknown): string {
  return `${String(projectId ?? "")}::${String(agentId ?? "")}`;
}
// The CEO assistant is the single documented exception: its key is "assistant".
function isAssistantLike(a: { agentId?: unknown; role?: unknown } | undefined): boolean {
  return !!a && (a.agentId === "assistant" || a.role === "assistant");
}

// Validates one panel/team agent entry against the composite-key contract.
function checkAgentBinding(
  label: string,
  a: any,
  bad: string[],
  notes: string[],
  opts: { requireAgentKey?: boolean } = {},
) {
  const assistant = isAssistantLike(a);
  const expected = budgetKeyFor(a?.projectId, a?.agentId);
  const budget = a?.budget;

  if (!isObj(budget)) {
    bad.push(`${label}: budget is ${budget === null ? "null" : typeof budget} (must never be null)`);
  } else {
    const got = budget.agentId;
    if (assistant) {
      if (got !== expected && got !== "assistant") {
        bad.push(`${label}: budget.agentId=${JSON.stringify(got)} expected ${expected} (or "assistant" for the assistant exception)`);
      } else if (got !== expected) {
        notes.push(`${label}: assistant uses the documented "assistant" key`);
      }
    } else if (got !== expected) {
      bad.push(`${label}: budget.agentId=${JSON.stringify(got)} expected composite ${expected}`);
    }
    for (const k of ["allocatedUsd", "spentUsd", "remainingUsd", "pctUsed"] as const) {
      if (!isNum(budget[k])) bad.push(`${label}: budget.${k} not a number (${trim(budget[k], 60)})`);
    }
    if (!Array.isArray(budget.agentId) && !nonEmptyStr(budget.agentId)) bad.push(`${label}: budget.agentId empty`);
  }

  if (opts.requireAgentKey) {
    const key = a?.agentKey;
    if (!nonEmptyStr(key)) {
      bad.push(`${label}: agentKey missing/empty`);
    } else if (assistant) {
      if (key !== expected && key !== "assistant") bad.push(`${label}: agentKey=${JSON.stringify(key)} expected ${expected} (or "assistant")`);
    } else if (key !== expected) {
      bad.push(`${label}: agentKey=${JSON.stringify(key)} expected composite ${expected}`);
    }
  }

  if (!nonEmptyStr(a?.projectId)) bad.push(`${label}: projectId empty`);
  if (!nonEmptyStr(a?.agentId)) bad.push(`${label}: agentId empty`);
}

// --- main ------------------------------------------------------------------

async function main() {
  const root = findRoot();
  console.log(`# smoke-company v2 against ${base}`);
  console.log(`# project root: ${root}`);
  await resolveAuthHeaders();
  console.log(`# auth: ${authNote}\n`);

  const org = readOrg(root);
  const teamAgents = org.projects.flatMap((p) => p.teams.flatMap((t) => t.agents));
  const census = teamAgents.length + 1; // 32 team agents + assistant = 33 today

  // Shared fixtures (fetched once, reused by several checks).
  // The panel is fetched TWICE: the dashboard polls /company/panel, so the
  // warmed-up (second) payload is the one a real client sees on every refresh.
  // Both are validated; drift between them is itself a failure.
  let panel: any = undefined;
  let panelFirst: any = undefined;
  let budgetsEp: any = undefined;
  let agentsEp: any = undefined;
  let sessionsEp: any = undefined;

  // 1. /health -------------------------------------------------------------
  try {
    const r = await req("/health");
    const ok = r.status === 200 && isObj(r.json) && r.json.ok === true;
    record(1, "GET /health -> ok:true", "free", ok, `status=${r.status} body=${trim(r.raw, 160)}`);
  } catch (e) {
    record(1, "GET /health -> ok:true", "free", false, `request error: ${errStr(e)}`);
  }

  // fetch shared fixtures up front (all read-only)
  try {
    const r = await req("/company/panel", { timeoutMs: Math.max(timeoutMs, 30000) });
    if (r.status === 200 && isObj(r.json)) panelFirst = r.json;
  } catch {
    /* reported by check 2 */
  }
  try {
    const r = await req("/company/panel", { timeoutMs: Math.max(timeoutMs, 30000) });
    if (r.status === 200 && isObj(r.json)) panel = r.json;
  } catch {
    /* reported by check 2 */
  }
  try {
    const r = await req("/company/budgets");
    if (r.status === 200 && isObj(r.json)) budgetsEp = r.json;
  } catch {
    /* reported below */
  }
  try {
    const r = await req("/company/agents");
    if (r.status === 200 && Array.isArray(r.json)) agentsEp = r.json;
  } catch {
    /* reported by check 6 */
  }
  try {
    const r = await req("/company/sessions");
    if (r.status === 200 && isObj(r.json)) sessionsEp = r.json;
  } catch {
    /* reported by check 5 */
  }

  // 2. /company/panel shape ------------------------------------------------
  try {
    const bad: string[] = [];
    if (!isObj(panel)) throw new Error("panel response missing or not an object");
    if (!nonEmptyStr(panel.company)) bad.push("company missing/empty");
    if (!nonEmptyStr(panel.ceo?.name)) bad.push("ceo.name missing/empty");
    if (!nonEmptyStr(panel.ceo?.title)) bad.push("ceo.title missing/empty");
    if (!parseableDate(panel.generatedAt)) bad.push(`generatedAt not ISO (${trim(panel.generatedAt, 60)})`);

    const visualKeys = [
      "departments",
      "projects",
      "teams",
      "agents",
      "tasks",
      "sessionsRunning",
      "sessionsQueued",
      "sessionsTotal",
      "budgetTotalUsd",
      "budgetSpentUsd",
      "budgetRemainingUsd",
    ];
    if (!isObj(panel.visual)) bad.push("visual missing");
    else for (const k of visualKeys) if (!isNum(panel.visual[k])) bad.push(`visual.${k} not a number`);

    for (const k of ["departments", "projects", "agents", "gates"] as const) {
      if (!Array.isArray(panel[k])) bad.push(`${k}[] missing`);
    }
    if (!Array.isArray(panel.sessions?.items)) bad.push("sessions.items[] missing");
    if (!Array.isArray(panel.budgets?.byAgent)) bad.push("budgets.byAgent[] missing");
    if (!Array.isArray(panel.budgets?.byDepartment)) bad.push("budgets.byDepartment[] missing");
    if (!isObj(panel.assistant)) bad.push("assistant missing");

    // departments[]
    for (const d of panel.departments ?? []) {
      const label = `department ${d?.id ?? "?"}`;
      if (!nonEmptyStr(d?.id)) bad.push(`${label}: id empty`);
      if (!nonEmptyStr(d?.name)) bad.push(`${label}: name empty`);
      if (!Array.isArray(d?.projectIds)) bad.push(`${label}: projectIds[] missing`);
      if (!isNum(d?.agents)) bad.push(`${label}: agents not a number`);
      if (!isNum(d?.running)) bad.push(`${label}: running not a number`);
      if (!Array.isArray(d?.projects)) bad.push(`${label}: projects[] missing`);
      if (!isObj(d?.budget)) bad.push(`${label}: budget missing`);
      else for (const k of ["allocatedUsd", "spentUsd", "remainingUsd"]) if (!isNum(d.budget[k])) bad.push(`${label}: budget.${k} not a number`);
    }

    // projects[] (projectSummary keeps thread/tasks/cost)
    for (const p of panel.projects ?? []) {
      const label = `project ${p?.id ?? "?"}`;
      for (const k of ["id", "name", "description", "departmentId", "status", "rootDir"] as const) {
        if (typeof p?.[k] !== "string") bad.push(`${label}: ${k} missing/not a string`);
      }
      if (!nonEmptyStr(p?.id) || !nonEmptyStr(p?.name) || !nonEmptyStr(p?.rootDir)) bad.push(`${label}: id/name/rootDir must be non-empty`);
      if (!Array.isArray(p?.teams)) bad.push(`${label}: teams[] missing`);
      for (const k of ["thread", "tasks"] as const) if (!Array.isArray(p?.[k])) bad.push(`${label}: ${k}[] missing`);
      if (!isObj(p?.cost)) bad.push(`${label}: cost missing`);
      if (typeof p?.running !== "number" && typeof p?.running !== "boolean") bad.push(`${label}: running not a number/boolean`);
    }

    // assistant block
    if (isObj(panel.assistant)) {
      if (panel.assistant.agentId !== "assistant") bad.push(`assistant.agentId=${JSON.stringify(panel.assistant.agentId)} (must be "assistant")`);
      if (!["idle", "thinking"].includes(panel.assistant.status)) bad.push(`assistant.status=${JSON.stringify(panel.assistant.status)}`);
      if (!isObj(panel.assistant.budget)) bad.push("assistant.budget missing");
      if (!Array.isArray(panel.assistant.thread)) bad.push("assistant.thread[] missing");
      else for (const m of panel.assistant.thread) {
        if (!parseableDate(m?.ts)) bad.push(`assistant.thread item ts not ISO (${trim(m?.ts, 40)})`);
        if (!["ceo", "assistant"].includes(m?.role)) bad.push(`assistant.thread role=${JSON.stringify(m?.role)}`);
        if (typeof m?.text !== "string") bad.push("assistant.thread text not a string");
      }
    }

    // gates[]
    for (const g of panel.gates ?? []) {
      const label = `gate ${g?.taskId ?? "?"}`;
      for (const k of ["projectId", "projectName", "taskId", "request", "status"] as const) {
        if (!nonEmptyStr(g?.[k])) bad.push(`${label}: ${k} missing/empty`);
      }
      if (g?.awaiting !== null && !["intake", "code", "merge"].includes(g?.awaiting)) {
        bad.push(`${label}: awaiting=${JSON.stringify(g?.awaiting)} not one of intake|code|merge|null`);
      }
    }

    const ok = bad.length === 0;
    record(
      2,
      "GET /company/panel shape (required keys; extra fields allowed)",
      "free",
      ok,
      ok
        ? `departments=${panel.departments.length} projects=${panel.projects.length} agents=${panel.agents.length} gates=${panel.gates.length}`
        : listBad(bad),
    );
  } catch (e) {
    record(2, "GET /company/panel shape (required keys; extra fields allowed)", "free", false, `error: ${errStr(e)}`);
  }

  // 3. Composite agent-key binding ----------------------------------------
  try {
    const bad: string[] = [];
    const notes: string[] = [];
    if (!isObj(panel)) throw new Error("panel unavailable");

    const panelAgentKeys = new Set<string>();
    for (const a of panel.agents ?? []) {
      const label = `panel.agents[${a?.projectId ?? "?"}]`;
      checkAgentBinding(label, a, bad, notes, { requireAgentKey: true });
      if (isObj(a?.budget) && nonEmptyStr(a.budget.agentId)) panelAgentKeys.add(a.budget.agentId);
    }

    const projectAgentKeys = new Set<string>();
    for (const p of panel.projects ?? []) {
      for (const t of p?.teams ?? []) {
        for (const a of t?.agents ?? []) {
          const label = `projects.${p?.id}.teams.${t?.id ?? "?"}.${a?.id ?? "?"}`;
          checkAgentBinding(label, { ...a, agentId: a?.id, projectId: p?.id }, bad, notes, { requireAgentKey: true });
          if (isObj(a?.budget) && nonEmptyStr(a.budget.agentId)) projectAgentKeys.add(a.budget.agentId);
        }
      }
    }

    // /company/panel is polled; the same agent must keep the same budget row on
    // every request. A first-vs-warm drift means a lookup cache binds by bare id.
    if (isObj(panelFirst) && isObj(panel)) {
      const nestedOf = (p: any): Map<string, string> => {
        const m = new Map<string, string>();
        for (const pr of p?.projects ?? []) {
          for (const t of pr?.teams ?? []) {
            for (const a of t?.agents ?? []) m.set(`${pr?.id}/${a?.id}`, String(a?.budget?.agentId));
          }
        }
        return m;
      };
      const mFirst = nestedOf(panelFirst);
      const mWarm = nestedOf(panel);
      const drift: string[] = [];
      for (const [k, v] of mWarm) {
        const v1 = mFirst.get(k);
        if (v1 !== undefined && v1 !== v) drift.push(`${k}: first=${v1} then=${v}`);
      }
      if (drift.length) {
        bad.push(`project-summary agent budgets are not request-stable (${drift.length} agents drift); e.g. ${drift.slice(0, 2).join(" | ")}`);
      }
    }

    const epAgentKeys = new Set<string>();
    for (const a of agentsEp ?? []) {
      const label = `/company/agents[${a?.projectId ?? "?"}]`;
      checkAgentBinding(label, a, bad, notes, { requireAgentKey: true });
      if (isObj(a?.budget) && nonEmptyStr(a.budget.agentId)) epAgentKeys.add(a.budget.agentId);
    }

    const budgetRows: any[] = budgetsEp?.byAgent ?? panel.budgets?.byAgent ?? [];
    const budgetRowKeys = new Set<string>(budgetRows.map((b) => b?.agentId).filter((k) => nonEmptyStr(k)));

    // panel.projects[].teams[] cannot contain the CEO assistant (it lives in the
    // p-ceo pseudo project, which is not one of the org projects), so compare
    // the project-team keys against the agent keys minus the assistant's.
    const assistantKeys = new Set<string>(
      (panel.agents ?? [])
        .filter((a: any) => isAssistantLike(a))
        .map((a: any) => a?.budget?.agentId)
        .filter((k: any) => nonEmptyStr(k)),
    );
    const expectedProjectKeys = new Set<string>([...panelAgentKeys].filter((k) => !assistantKeys.has(k)));

    const diff = (x: Set<string>, y: Set<string>) => [...x].filter((k) => !y.has(k));
    for (const [nameA, a, nameB, b] of [
      ["panel.agents", panelAgentKeys, "budgets.byAgent", budgetRowKeys],
      ["panel.agents", panelAgentKeys, "/company/agents", epAgentKeys],
      ["panel.projects teams", projectAgentKeys, "panel.agents (minus assistant)", expectedProjectKeys],
    ] as const) {
      const missing = [...diff(a as Set<string>, b as Set<string>), ...diff(b as Set<string>, a as Set<string>)];
      if (missing.length) bad.push(`${nameA} vs ${nameB}: key sets differ (${missing.length}; e.g. ${trim(missing.slice(0, 4))})`);
    }

    // Budget values must come from the row with the same composite id, and a
    // project's rollup must equal the sum of that project's own rows. Both sides
    // come from the same panel payload, so live traffic cannot skew this.
    const panelRows: any[] = panel.budgets?.byAgent ?? [];
    const rowById = new Map<string, any>(panelRows.map((b) => [b?.agentId, b]));
    const sum = (xs: any[], k: string) => xs.reduce((s, x) => s + (isNum(x?.[k]) ? x[k] : 0), 0);
    for (const p of panel.projects ?? []) {
      const ownRows = panelRows.filter((b) => nonEmptyStr(b?.agentId) && b.agentId.startsWith(`${p?.id}::`));
      const nestedAgents = (p?.teams ?? []).flatMap((t: any) => t?.agents ?? []);
      for (const a of nestedAgents) {
        const key = budgetKeyFor(p?.id, a?.id);
        const expect = rowById.get(key);
        if (!isObj(a?.budget) || !expect) continue;
        if (!near(a.budget.allocatedUsd, expect.allocatedUsd, 1e-6) || !near(a.budget.spentUsd, expect.spentUsd, 1e-6)) {
          bad.push(
            `projects.${p?.id}.teams.${a?.id}: budget values (alloc ${a.budget.allocatedUsd}/spent ${a.budget.spentUsd}) != budgets.byAgent row ${key} (alloc ${expect.allocatedUsd}/spent ${expect.spentUsd})`,
          );
        }
      }
      if (ownRows.length !== nestedAgents.length) {
        bad.push(`project ${p?.id}: budgets.byAgent has ${ownRows.length} rows but projects[].teams[].agents has ${nestedAgents.length}`);
      }
      const expAlloc = sum(ownRows, "allocatedUsd");
      const expSpent = sum(ownRows, "spentUsd");
      if (!isObj(p?.budget) || !near(p.budget.allocatedUsd, expAlloc, 1e-6) || !near(p.budget.spentUsd, expSpent, 1e-6)) {
        bad.push(
          `project ${p?.id}: projects[].budget (alloc ${p?.budget?.allocatedUsd}/spent ${p?.budget?.spentUsd}) != sum of its own budgets.byAgent rows (alloc ${expAlloc}/spent ${expSpent})`,
        );
      }
    }

    const ok = bad.length === 0 && panelAgentKeys.size > 0;
    record(
      3,
      "Composite agent keys: non-null budget + agentKey binding across 3 endpoints",
      "free",
      ok,
      ok
        ? `keys=${panelAgentKeys.size} composite everywhere; byAgent rows=${budgetRowKeys.size}${notes.length ? `; ${notes[0]}` : ""}`
        : listBad(bad),
    );
  } catch (e) {
    record(3, "Composite agent keys: non-null budget + agentKey binding across 3 endpoints", "free", false, `error: ${errStr(e)}`);
  }

  // 4. Money invariants ----------------------------------------------------
  try {
    const bad: string[] = [];
    const rows: any[] = panel?.budgets?.byAgent ?? [];
    if (!rows.length) bad.push("budgets.byAgent is empty");

    let sumAlloc = 0;
    let sumSpent = 0;
    let sumRem = 0;
    const tol = 2e-6; // server rounds money to 6 decimals
    for (const b of rows) {
      const id = b?.agentId ?? "?";
      if (!nonEmptyStr(id)) bad.push("row without agentId");
      if (!isNum(b?.allocatedUsd) || !isNum(b?.spentUsd) || !isNum(b?.remainingUsd) || !isNum(b?.pctUsed)) {
        bad.push(`${id}: non-numeric money fields (${trim(b, 120)})`);
        continue;
      }
      sumAlloc += b.allocatedUsd;
      sumSpent += b.spentUsd;
      sumRem += b.remainingUsd;

      const expectedRem = Math.max(0, b.allocatedUsd - b.spentUsd);
      if (!near(b.remainingUsd, expectedRem, tol)) {
        bad.push(`${id}: remainingUsd ${b.remainingUsd} != max(0, ${b.allocatedUsd} - ${b.spentUsd}) = ${expectedRem}`);
      }
      if (b.spentUsd < 0) bad.push(`${id}: spentUsd < 0 (${b.spentUsd})`);
      if (b.allocatedUsd < 0) bad.push(`${id}: allocatedUsd < 0 (${b.allocatedUsd})`);
      if (b.remainingUsd < 0) bad.push(`${id}: remainingUsd < 0 (${b.remainingUsd})`);

      const expectedPct = b.allocatedUsd > 0 ? Math.min(100, (b.spentUsd / b.allocatedUsd) * 100) : b.spentUsd > 0 ? 100 : 0;
      if (!near(b.pctUsed, expectedPct, 0.05)) {
        bad.push(`${id}: pctUsed ${b.pctUsed} != ${expectedPct.toFixed(6)} (0 when allocated===0 && spent===0)`);
      }
      if (b.allocatedUsd === 0 && b.spentUsd === 0 && b.pctUsed !== 0) bad.push(`${id}: pctUsed=${b.pctUsed} must be 0 for a zero/zero budget`);
      if (!isNum(b.sessionsRun) || b.sessionsRun < 0) bad.push(`${id}: sessionsRun invalid (${trim(b.sessionsRun, 40)})`);
      if (!["idle", "running", "budget_exhausted"].includes(b.status)) bad.push(`${id}: status=${JSON.stringify(b.status)} not in enum`);
      if (b.remainingUsd <= 0 && b.status !== "budget_exhausted") bad.push(`${id}: remaining ${b.remainingUsd} but status=${b.status}`);
      if (b.remainingUsd > 0 && b.status === "budget_exhausted") bad.push(`${id}: status budget_exhausted but remaining ${b.remainingUsd}`);
    }

    // A row whose spend exceeded its allocation has remainingUsd clamped to 0, so
    // sum(rows.remainingUsd) = max(0, Σalloc - Σspent) + (over-spend). Spell that
    // out when the sums disagree, because otherwise the mismatch looks arbitrary.
    const overspent = rows.filter((b) => isNum(b?.allocatedUsd) && isNum(b?.spentUsd) && b.spentUsd > b.allocatedUsd + tol);
    const excess = overspent.reduce((s, b) => s + (b.spentUsd - b.allocatedUsd), 0);
    const clampNote = overspent.length
      ? ` [${overspent.length} over-spent row(s) by $${excess.toFixed(6)}: ${overspent.map((b) => b.agentId).slice(0, 3).join(",")}; per-row remainingUsd is clamped to 0, so sum(rows.remainingUsd) exceeds max(0, SumAllocated-SumSpent) by exactly that amount]`
      : "";

    const tot = panel?.budgets ?? {};
    for (const [name, got, want] of [
      ["totalUsd", tot.totalUsd, sumAlloc],
      ["spentUsd", tot.spentUsd, sumSpent],
      ["remainingUsd", tot.remainingUsd, sumRem],
    ] as const) {
      if (!isNum(got) || !near(got, want, 1e-6 * Math.max(1, Math.abs(want)))) {
        bad.push(`totals mismatch: budgets.${name}=${got} but sum(byAgent)=${want}${name === "remainingUsd" || name === "spentUsd" ? clampNote : ""}`);
      }
    }

    // department rollup must add up to the same totals
    const deptRows: any[] = panel?.budgets?.byDepartment ?? [];
    if (!deptRows.length) bad.push("budgets.byDepartment is empty");
    let dAlloc = 0;
    let dSpent = 0;
    let dRem = 0;
    for (const d of deptRows) {
      if (!isNum(d?.allocatedUsd) || !isNum(d?.spentUsd) || !isNum(d?.remainingUsd)) {
        bad.push(`byDepartment row invalid (${trim(d, 120)})`);
        continue;
      }
      dAlloc += d.allocatedUsd;
      dSpent += d.spentUsd;
      dRem += d.remainingUsd;
      if (!near(d.remainingUsd, Math.max(0, d.allocatedUsd - d.spentUsd), tol)) {
        bad.push(`byDepartment ${d.departmentName ?? d.departmentId}: remaining ${d.remainingUsd} != allocated-spent`);
      }
    }
    if (!near(dAlloc, sumAlloc, 1e-6 * Math.max(1, Math.abs(sumAlloc))) || !near(dSpent, sumSpent, 1e-6 * Math.max(1, Math.abs(sumSpent))) || !near(dRem, sumRem, 1e-6 * Math.max(1, Math.abs(sumRem)))) {
      bad.push(`byDepartment sums (${dAlloc}/${dSpent}/${dRem}) != byAgent sums (${sumAlloc}/${sumSpent}/${sumRem})${clampNote}`);
    }

    // panel.visual budget mirrors the same money (one payload)
    const v = panel?.visual ?? {};
    if (!near(v.budgetTotalUsd ?? NaN, sumAlloc, 1e-4) || !near(v.budgetSpentUsd ?? NaN, sumSpent, 1e-4) || !near(v.budgetRemainingUsd ?? NaN, sumRem, 1e-4)) {
      bad.push(`visual budget (${v.budgetTotalUsd}/${v.budgetSpentUsd}/${v.budgetRemainingUsd}) != sum(byAgent) (${sumAlloc}/${sumSpent}/${sumRem})${clampNote}`);
    }

    const ok = bad.length === 0;
    record(
      4,
      "Money invariants (rows, totals, department rollup, pctUsed)",
      "free",
      ok,
      ok
        ? `rows=${rows.length} allocated=$${sumAlloc} spent=$${sumSpent.toFixed(6)} remaining=$${sumRem.toFixed(6)} (totals + rollup + visual agree)`
        : listBad(bad, 500),
    );
  } catch (e) {
    record(4, "Money invariants (rows, totals, department rollup, pctUsed)", "free", false, `error: ${errStr(e)}`);
  }

  // 5. /company/sessions ---------------------------------------------------
  try {
    const bad: string[] = [];
    const s = sessionsEp;
    if (!isObj(s)) throw new Error("sessions endpoint unavailable");
    const items: any[] = Array.isArray(s.items) ? s.items : [];
    const statuses = new Set(["queued", "running", "done", "error"]);
    const running = items.filter((i) => i?.status === "running").length;
    const queued = items.filter((i) => i?.status === "queued").length;

    // Contract: running/queued/total are global counts, items is newest-first and
    // capped at 60. So a capped window can only be checked against the counts
    // from below (>=); an uncapped window must match exactly.
    const cap = 60;
    if (items.length > cap) bad.push(`items.length ${items.length} exceeds the contract cap of ${cap}`);
    if (!isNum(s.total) || s.total < items.length) bad.push(`total ${s.total} < items.length (${items.length})`);
    if (s.total > cap) {
      if (items.length !== cap) bad.push(`total ${s.total} > ${cap} so items should be capped at ${cap} (got ${items.length})`);
      if (s.running < running) bad.push(`running ${s.running} < ${running} running items in the capped window`);
      if (s.queued < queued) bad.push(`queued ${s.queued} < ${queued} queued items in the capped window`);
    } else {
      if (s.total !== items.length) bad.push(`total ${s.total} != items.length (${items.length}) (window is not capped)`);
      if (s.running !== running) bad.push(`running ${s.running} != items with status running (${running})`);
      if (s.queued !== queued) bad.push(`queued ${s.queued} != items with status queued (${queued})`);
    }

    const seen = new Set<string>();
    const now = Date.now();
    const required = ["id", "agentId", "role", "departmentName", "projectName", "taskTitle", "model", "status", "startedAt"];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      for (const k of required) if (!nonEmptyStr(it?.[k])) bad.push(`item[${i}] ${it?.id ?? "?"}: ${k} missing/empty`);
      if (!statuses.has(it?.status)) bad.push(`item[${i}] ${it?.id ?? "?"}: status=${JSON.stringify(it?.status)} not in enum`);
      if (!parseableDate(it?.startedAt)) bad.push(`item[${i}] ${it?.id ?? "?"}: startedAt not ISO`);
      if (nonEmptyStr(it?.id)) {
        if (seen.has(it.id)) bad.push(`duplicate session id ${it.id}`);
        seen.add(it.id);
      }
      if (it?.taskId !== null && it?.taskId !== undefined && typeof it.taskId !== "string") bad.push(`item[${i}]: taskId must be string|null`);
      if (i > 0 && parseableDate(items[i - 1]?.startedAt) && parseableDate(it?.startedAt)) {
        if (Date.parse(items[i - 1].startedAt) < Date.parse(it.startedAt)) {
          bad.push(`not newest-first at index ${i}: ${items[i - 1].startedAt} < ${it.startedAt}`);
          break;
        }
      }
      if (it?.status === "running" && parseableDate(it?.startedAt)) {
        const ageH = (now - Date.parse(it.startedAt)) / 3_600_000;
        if (ageH > 6) bad.push(`item[${i}] ${it.id}: exposed as running for ${ageH.toFixed(1)}h (stale sessions must be reconciled on boot)`);
      }
    }

    // panel agreement: the panel is a separate payload, so the box's live
    // traffic can slip a session in between the two fetches. Retry a few times
    // and pass as soon as two back-to-back reads agree.
    let agreed = false;
    let tries = 0;
    let observed = "";
    for (tries = 1; tries <= 3 && !agreed; tries++) {
      const ps = await req("/company/sessions");
      const pp = await req("/company/panel", { timeoutMs: Math.max(timeoutMs, 30000) });
      const psj = ps.json;
      const ppj = pp.json;
      const agreeBad: string[] = [];
      const aItems: any[] = Array.isArray(psj?.items) ? psj.items : [];
      const expectWin = Math.min(cap, isNum(psj?.total) ? psj.total : aItems.length);
      if (aItems.length !== expectWin) agreeBad.push(`sessions items=${aItems.length} != min(${cap}, total=${psj?.total})=${expectWin}`);
      if (isObj(ppj?.sessions)) {
        for (const k of ["running", "queued", "total"] as const) {
          if (ppj.sessions[k] !== psj?.[k]) agreeBad.push(`panel.sessions.${k}=${ppj.sessions[k]} != /company/sessions ${k}=${psj?.[k]}`);
        }
        const pi: any[] = Array.isArray(ppj.sessions.items) ? ppj.sessions.items : [];
        if (pi.length !== aItems.length) agreeBad.push(`panel.sessions.items=${pi.length} != /company/sessions items=${aItems.length}`);
        else if (pi.length && pi[0]?.id !== aItems[0]?.id) agreeBad.push(`panel.sessions.items[0]=${pi[0]?.id} != /company/sessions items[0]=${aItems[0]?.id}`);
      }
      for (const k of ["sessionsRunning", "sessionsQueued", "sessionsTotal"] as const) {
        const counter = k === "sessionsRunning" ? "running" : k === "sessionsQueued" ? "queued" : "total";
        if (isNum(ppj?.visual?.[k]) && ppj.visual[k] !== psj?.[counter]) {
          agreeBad.push(`visual.${k}=${ppj.visual[k]} != /company/sessions ${counter}=${psj?.[counter]}`);
        }
      }
      if (!agreeBad.length) agreed = true;
      else observed = agreeBad.join(" | ");
      if (!agreed) await sleep(400);
    }
    if (!agreed) bad.push(`panel vs sessions agreement failed on ${tries - 1} back-to-back read(s): ${observed}`);

    // shape counters that live inside one payload (no cross-fetch race)
    if (isObj(panel?.visual)) {
      if (panel.visual.departments !== (panel.departments?.length ?? -1)) {
        bad.push(`visual.departments=${panel.visual.departments} != departments[]=${panel.departments?.length}`);
      }
      if (panel.visual.projects !== (panel.projects?.length ?? -1)) {
        bad.push(`visual.projects=${panel.visual.projects} != projects[]=${panel.projects?.length}`);
      }
      const teamsOnDisk = org.projects.reduce((n, p) => n + p.teams.length, 0);
      if (panel.visual.teams !== teamsOnDisk) bad.push(`visual.teams=${panel.visual.teams} != teams in org.json (${teamsOnDisk})`);
      if (panel.visual.agents !== teamAgents.length && panel.visual.agents !== teamAgents.length + 1) {
        bad.push(`visual.agents=${panel.visual.agents} != team agents (${teamAgents.length}) or ${teamAgents.length}+assistant`);
      }
    }

    const ok = bad.length === 0;
    record(
      5,
      "GET /company/sessions counts/order/fields + panel.visual agreement",
      "free",
      ok,
      ok
        ? `items=${items.length} of total=${s.total} (contract cap ${cap}) running=${s.running} queued=${s.queued} newest-first ok`
        : listBad(bad, 500),
    );
  } catch (e) {
    record(5, "GET /company/sessions counts/order/fields + panel.visual agreement", "free", false, `error: ${errStr(e)}`);
  }

  // 6. /company/agents census ---------------------------------------------
  try {
    const bad: string[] = [];
    const arr: any[] = Array.isArray(agentsEp) ? agentsEp : [];
    if (!arr.length) bad.push("/company/agents did not return an array");
    const assistants = arr.filter((a) => a?.agentId === "assistant");
    if (assistants.length !== 1) bad.push(`expected exactly 1 assistant entry, saw ${assistants.length}`);
    if (arr.length !== census) bad.push(`agent count ${arr.length} != census ${census} (team agents ${teamAgents.length} + assistant; 33 expected today)`);
    const seenPair = new Set<string>();
    for (const a of arr) {
      for (const k of ["agentId", "name", "role", "roleName", "departmentId", "departmentName", "projectId", "projectName", "modelId", "status"] as const) {
        if (!nonEmptyStr(a?.[k])) bad.push(`${a?.agentId ?? "?"}: ${k} missing/empty`);
      }
      if (typeof a?.running !== "boolean") bad.push(`${a?.agentId ?? "?"}: running not a boolean`);
      if (!isObj(a?.budget)) bad.push(`${a?.agentId ?? "?"}: budget missing`);
      const pair = `${a?.projectId}::${a?.agentId}`;
      if (seenPair.has(pair)) bad.push(`duplicate agent identity ${pair}`);
      seenPair.add(pair);
    }
    const ok = bad.length === 0;
    record(
      6,
      `GET /company/agents census (${census} expected today)`,
      "free",
      ok,
      ok ? `len=${arr.length} (${teamAgents.length} team + assistant) all fields present` : listBad(bad, 500),
    );
  } catch (e) {
    record(6, `GET /company/agents census (${census} expected today)`, "free", false, `error: ${errStr(e)}`);
  }

  // 7. Threads: assistant + composite key + bare-id convenience ------------
  try {
    const bad: string[] = [];
    const a = await req("/company/agents/assistant/thread");
    if (a.status !== 200) bad.push(`assistant thread status=${a.status} body=${trim(a.raw, 120)}`);
    if (!Array.isArray(a.json?.messages)) bad.push(`assistant thread messages not an array (status=${a.status})`);
    if (nonEmptyStr(a.json?.agentId) && a.json.agentId !== "assistant") bad.push(`assistant thread echoed agentId=${a.json.agentId}, expected the id sent ("assistant")`);

    const proj = org.projects.find((p) => p.teams.some((t) => t.agents.length > 0));
    const ag = proj?.teams[0]?.agents[0];
    let compositeInfo = "no team agent in org.json";
    if (proj && ag) {
      const key = `${proj.id}::${ag.id}`;
      const c = await req(`/company/agents/${encodeURIComponent(key)}/thread`);
      if (c.status !== 200) bad.push(`composite thread ${key} status=${c.status}`);
      if (!Array.isArray(c.json?.messages)) bad.push(`composite thread ${key} messages not an array`);
      if (c.json?.agentId !== key) bad.push(`composite thread echoed agentId=${JSON.stringify(c.json?.agentId)}, expected ${key}`);
      compositeInfo = `${key} status=${c.status} messages=${Array.isArray(c.json?.messages) ? c.json.messages.length : "n/a"}`;

      // bare id resolves to the first registered match (convenience, not identity)
      const bare = await req(`/company/agents/${encodeURIComponent(ag.id)}/thread`);
      if (bare.status !== 200 || !Array.isArray(bare.json?.messages)) bad.push(`bare id ${ag.id} did not resolve (status=${bare.status})`);
      else if (bare.json.agentId !== ag.id) bad.push(`bare id ${ag.id} echoed agentId=${JSON.stringify(bare.json.agentId)}`);
    }
    const ok = bad.length === 0;
    record(7, "Agent threads: assistant + composite key + bare-id resolution", "free", ok, ok ? compositeInfo : listBad(bad, 400));
  } catch (e) {
    record(7, "Agent threads: assistant + composite key + bare-id resolution", "free", false, `request error: ${errStr(e)}`);
  }

  // 8. /company/stream one panel frame ------------------------------------
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    let frame: any = undefined;
    let ctype = "";
    try {
      const res = await fetch(base + "/company/stream", { signal: ctrl.signal, headers: { accept: "text/event-stream", ...authHeaders } });
      ctype = res.headers.get("content-type") ?? "";
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const idx = buf.indexOf("\n\n");
        if (idx !== -1) {
          const block = buf.slice(0, idx);
          const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
          if (block.includes("event: panel") && dataLine) frame = JSON.parse(dataLine.slice(5).trim());
          break;
        }
      }
      try {
        await reader.cancel();
      } catch {
        /* stream already closed */
      }
    } finally {
      clearTimeout(timer);
    }
    const ok =
      ctype.includes("text/event-stream") &&
      isObj(frame) &&
      nonEmptyStr(frame.company) &&
      isObj(frame.visual) &&
      Array.isArray(frame.departments) &&
      Array.isArray(frame.projects) &&
      Array.isArray(frame.agents);
    record(
      8,
      "GET /company/stream one `event: panel` frame parses as JSON (6s)",
      "free",
      ok,
      frame
        ? `company=${frame.company} departments=${frame.departments.length} projects=${frame.projects.length} agents=${frame.agents.length}`
        : `no JSON panel frame within 6s (content-type=${trim(ctype, 60)})`,
    );
  } catch (e) {
    record(8, "GET /company/stream one `event: panel` frame parses as JSON (6s)", "free", false, `error: ${errStr(e)}`);
  }

  // 9. Org integrity on disk ----------------------------------------------
  try {
    const bad: string[] = [];
    for (const p of org.projects) {
      const label = `project ${p.name} (${p.id})`;
      if (!nonEmptyStr(p.rootDir)) bad.push(`${label}: rootDir empty`);
      else if (!fs.existsSync(p.rootDir)) bad.push(`${label}: rootDir missing on disk: ${p.rootDir}`);
      else if (!fs.statSync(p.rootDir).isDirectory()) bad.push(`${label}: rootDir is not a directory: ${p.rootDir}`);
      if (!Array.isArray(p.teams) || p.teams.length === 0) bad.push(`${label}: no teams`);
      const ids = new Set<string>();
      for (const t of p.teams) {
        for (const a of t.agents) {
          const alabel = `${label}/${a.id}`;
          if (ids.has(a.id)) bad.push(`${alabel}: duplicate agent id inside the project`);
          ids.add(a.id);
          if (!nonEmptyStr(a.workdir)) bad.push(`${alabel}: workdir empty`);
          else if (!fs.existsSync(a.workdir)) bad.push(`${alabel}: workdir missing on disk: ${a.workdir}`);
        }
      }
    }
    const deptNames = org.departments.map((d) => d.name);
    const dupNames = [...new Set(deptNames.filter((n, i) => deptNames.indexOf(n) !== i))];
    if (dupNames.length) bad.push(`duplicate department names: ${dupNames.join(",")}`);
    const deptIds = org.departments.map((d) => d.id);
    const dupIds = [...new Set(deptIds.filter((n, i) => deptIds.indexOf(n) !== i))];
    if (dupIds.length) bad.push(`duplicate department ids: ${dupIds.join(",")}`);
    const projIds = org.projects.map((p) => p.id);
    const dupProj = [...new Set(projIds.filter((n, i) => projIds.indexOf(n) !== i))];
    if (dupProj.length) bad.push(`duplicate project ids: ${dupProj.join(",")}`);

    // served panel must cover the on-disk org (it may legitimately have more,
    // e.g. a project the assistant created at runtime)
    const servedProj = new Set((panel?.projects ?? []).map((p: any) => p?.id));
    const missingProj = projIds.filter((id) => !servedProj.has(id));
    if (missingProj.length) bad.push(`org.json projects missing from the served panel: ${missingProj.join(",")}`);
    const servedDept = new Set((panel?.departments ?? []).map((d: any) => d?.name));
    const missingDept = deptNames.filter((n) => !servedDept.has(n));
    if (missingDept.length) bad.push(`org.json departments missing from the served panel: ${missingDept.join(",")}`);

    const ok = bad.length === 0;
    record(
      9,
      "Org integrity (rootDirs, workdirs, unique ids/names, panel covers org)",
      "free",
      ok,
      ok ? `projects=${org.projects.length} agents=${teamAgents.length} departments=${org.departments.length} dirs + ids ok` : listBad(bad, 500),
    );
  } catch (e) {
    record(9, "Org integrity (rootDirs, workdirs, unique ids/names, panel covers org)", "free", false, `error: ${errStr(e)}`);
  }

  // 10. Router runs hidden with logs/router.*.log (localhost only) ---------
  try {
    if (!isLocalBase) {
      record(10, "Router background logs present (logs/router.*.log)", "free", true, `skipped: base ${base} is not localhost`);
    } else {
      const bad: string[] = [];
      const out = path.join(root, "logs", "router.out.log");
      const err = path.join(root, "logs", "router.err.log");
      let outText = "";
      if (!fs.existsSync(out)) bad.push(`missing ${path.relative(root, out)}`);
      else {
        outText = fs.readFileSync(out, "utf8");
        if (!outText.trim()) bad.push(`${path.relative(root, out)} is empty`);
      }
      if (!fs.existsSync(err)) bad.push(`missing ${path.relative(root, err)}`);
      const reconciled = /reconciled (\d+) stale session/.exec(outText);
      const ok = bad.length === 0;
      record(
        10,
        "Router background logs present (logs/router.*.log)",
        "free",
        ok,
        ok
          ? `router.out.log ${outText.trim().length} chars${reconciled ? `; boot line: reconciled ${reconciled[1]} stale session(s)` : ""}`
          : listBad(bad, 300),
      );
    }
  } catch (e) {
    record(10, "Router background logs present (logs/router.*.log)", "free", false, `error: ${errStr(e)}`);
  }

  // 11. Cross-view rollups -------------------------------------------------
  // departments[].budget and budgets.byDepartment describe the same money and
  // come from the same panel payload, so they must agree per department id.
  try {
    const bad: string[] = [];
    const deptRows: any[] = panel?.budgets?.byDepartment ?? [];
    const deptById = new Map<string, any>(deptRows.map((d) => [d?.departmentId, d]));
    const depts: any[] = panel?.departments ?? [];
    if (!depts.length) bad.push("panel.departments is empty");
    for (const d of depts) {
      const roll = deptById.get(d?.id);
      if (!roll) {
        bad.push(`departments[${d?.id}]: no budgets.byDepartment row for this department id`);
        continue;
      }
      if (!isObj(d?.budget) || !near(d.budget.allocatedUsd, roll.allocatedUsd, 1e-6) || !near(d.budget.spentUsd, roll.spentUsd, 1e-6)) {
        bad.push(
          `departments[${d?.id}].budget (alloc ${d?.budget?.allocatedUsd}/spent ${d?.budget?.spentUsd}) != budgets.byDepartment (alloc ${roll.allocatedUsd}/spent ${roll.spentUsd})`,
        );
      }
    }
    const ok = bad.length === 0;
    record(
      11,
      "Cross-view rollups: departments[].budget == budgets.byDepartment",
      "free",
      ok,
      ok ? `${depts.length} departments agree with the budget-store rollup` : listBad(bad, 500),
    );
  } catch (e) {
    record(11, "Cross-view rollups: departments[].budget == budgets.byDepartment", "free", false, `error: ${errStr(e)}`);
  }

  // 12. MUTATING: assistant message with autoRun:false --------------------
  const checkName = "POST /company/assistant/message {autoRun:false}: task created, nothing dispatched";
  if (skipMutating) {
    record(12, checkName, "mutating", true, "skipped (--skip-mutating)");
  } else {
    try {
      const bad: string[] = [];
      const before = await req("/company/sessions");
      const beforeIds = new Set<string>((before.json?.items ?? []).map((i: any) => i?.id));
      const beforeCounts = { running: before.json?.running ?? 0, queued: before.json?.queued ?? 0, total: before.json?.total ?? 0 };
      const assistantRowBefore = (panel?.budgets?.byAgent ?? []).find((b: any) => b?.role === "assistant");
      const spentBefore = isNum(assistantRowBefore?.spentUsd) ? assistantRowBefore.spentUsd : null;

      const stamp = new Date().toISOString();
      const r = await req("/company/assistant/message", {
        method: "POST",
        body: { text: `Smoke test ${stamp}: record this as a tracked task only, do not start any work.`, autoRun: false },
        timeoutMs: 60000,
      });
      const resp = r.json ?? {};
      if (r.status !== 200) bad.push(`status=${r.status} body=${trim(r.raw, 200)}`);
      if (resp.error !== undefined) bad.push(`response error=${trim(resp.error, 160)}`);
      if (!Array.isArray(resp.plan) || resp.plan.length < 1) bad.push(`plan[] missing/empty (${trim(resp.plan, 80)})`);
      if (!Array.isArray(resp.decisions)) bad.push("decisions[] missing");
      if (!isObj(resp.budgets) || !isNum(resp.budgets?.remainingUsd)) bad.push("budgets.remainingUsd missing");

      const dispatched: any[] = Array.isArray(resp.dispatched) ? resp.dispatched : [];
      if (!dispatched.length) bad.push("dispatched[] empty: no task was created");
      const newTaskIds = new Set<string>();
      for (const d of dispatched) {
        if (!nonEmptyStr(d?.projectId) || !nonEmptyStr(d?.taskId)) bad.push(`dispatched entry incomplete: ${trim(d, 120)}`);
        if (nonEmptyStr(d?.taskId)) newTaskIds.add(d.taskId);
        if (d?.status !== "created") bad.push(`dispatched ${d?.taskId ?? "?"} status=${JSON.stringify(d?.status)} (must be "created" with autoRun:false)`);
      }

      // the tasks must be visible in the served panel for their projects
      if (newTaskIds.size) {
        const p2 = await req("/company/panel", { timeoutMs: Math.max(timeoutMs, 30000) });
        const projById = new Map<string, any>((p2.json?.projects ?? []).map((p: any) => [p.id, p]));
        for (const d of dispatched) {
          const proj = projById.get(d?.projectId);
          const tasks: any[] = proj?.tasks ?? [];
          if (!proj) bad.push(`project ${d?.projectId} not in panel after the POST`);
          else if (!tasks.some((t) => t?.id === d.taskId)) bad.push(`task ${d.taskId} not present in project ${d.projectId} tasks[]`);
        }
      }

      // no dispatch: no session may reference the new task ids within 10s. Any
      // new session in a target project counts as attributable (the box may also
      // carry unrelated work; that is only a failure with --strict-dispatch).
      await sleep(10000);
      const after = await req("/company/sessions");
      const afterItems: any[] = after.json?.items ?? [];
      const afterIds = new Set<string>(afterItems.map((i) => i?.id));
      const added = afterItems.filter((i) => !beforeIds.has(i?.id));
      const dispatchedProjectIds = new Set<string>(dispatched.map((d) => d?.projectId).filter((x) => nonEmptyStr(x)));
      const attributable = added.filter((i) => newTaskIds.has(i?.taskId) || dispatchedProjectIds.has(i?.projectId));
      const unrelated = added.filter((i) => !attributable.includes(i));
      if (attributable.length) {
        bad.push(
          `${attributable.length} new session(s) attributable to the smoke task within 10s: ${attributable.map((i) => `${i?.id}[${i?.status}]`).slice(0, 3).join(",")}`,
        );
      }
      if (unrelated.length && strictDispatch) bad.push(`${unrelated.length} new session(s) appeared within 10s (--strict-dispatch)`);
      const runningNewTasks = afterItems.filter((i) => i?.status === "running" && newTaskIds.has(i?.taskId));
      if (runningNewTasks.length) bad.push(`session(s) running for the new task ids: ${runningNewTasks.map((i) => i.id).join(",")}`);
      const respSessions: any[] = Array.isArray(resp.sessions) ? resp.sessions : [];
      const respSessionsNewTask = respSessions.filter((s) => newTaskIds.has(s?.taskId));
      if (respSessionsNewTask.length) bad.push(`response sessions[] already contains sessions for the new tasks (${respSessionsNewTask.length})`);

      // the autoRun:false path costs the assistant a fraction of a cent
      const aAfter = await req("/company/agents/assistant/thread?limit=1");
      let costNote = "assistant budget delta unknown";
      try {
        const bAfter = await req("/company/budgets");
        const rowAfter = (bAfter.json?.byAgent ?? []).find((b: any) => b?.role === "assistant");
        if (isNum(rowAfter?.spentUsd) && spentBefore !== null) {
          costNote = `assistant spend $${spentBefore.toFixed(6)} -> $${rowAfter.spentUsd.toFixed(6)} (Δ $${(rowAfter.spentUsd - spentBefore).toFixed(6)}; no agent dispatches)`;
        }
      } catch {
        /* informational */
      }
      if (aAfter.status !== 200) bad.push(`assistant thread unreadable after the POST (status=${aAfter.status})`);

      const ok = bad.length === 0;
      const trafficNote = added.length
        ? ` (${added.length} unrelated live session(s) also appeared: ${added.map((i) => i?.id).slice(0, 2).join(",")})`
        : "";
      const stateNote = `sessions total ${beforeCounts.total} -> ${after.json?.total}${trafficNote}`;
      record(
        12,
        checkName,
        "mutating",
        ok,
        ok
          ? `status=${r.status} plan=${(resp.plan ?? []).length} decisions=${(resp.decisions ?? []).length} tasksCreated=${dispatched.length} all status=created; no session for the ${newTaskIds.size} new task id(s) after 10s; ${stateNote}; ${costNote}`
          : `${listBad(bad, 500)}; ${stateNote}; ${costNote}`,
      );
    } catch (e) {
      record(12, checkName, "mutating", false, `request error: ${errStr(e)}`);
    }
  }

  // summary ----------------------------------------------------------------
  const failed = checks.filter((c) => !c.ok);
  console.log("\n================ SUMMARY ================");
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  [${c.n}] ${c.name}  (${c.tag})`);
  console.log("-----------------------------------------");
  console.log(`${checks.length - failed.length}/${checks.length} passed; ${failed.length} failed`);
  if (failed.length) {
    console.log("failed: " + failed.map((c) => `[${c.n}] ${c.name}`).join(" | "));
    process.exitCode = 1;
  }
  console.log(`mutating checks run: ${checks.filter((c) => c.tag === "mutating" && !c.detail.startsWith("skipped")).length}/1 (check 12 only: creates a task, dispatches no agent, no paid pipeline)`);

  if (emitJson) {
    console.log("SMOKE_JSON " + JSON.stringify({ base, root, ok: failed.length === 0, checks }));
  }
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exitCode = 1;
});
