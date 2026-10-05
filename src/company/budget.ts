import fs from "node:fs";
import path from "node:path";
import { getCompanyRoot, loadOrg } from "./org.js";
import { ROLES } from "./roles.js";
import { listSessions } from "./sessions.js";

// ---------------------------------------------------------------------------
// Agent budgets — how much each agent (per project) is allowed to spend, how
// much it has spent, and the ledger of charges behind that number.
//
// Keying: agent ids repeat across projects (every project has a "coder-1", a
// "manager", ...), so budgets are keyed by the COMPOSITE id
// `${projectId}::${agentId}` (see budgetKeyFor). Bare ids are still accepted
// everywhere and resolve to the first registered match, so older/simple callers
// keep working. AgentBudget.agentId carries the composite key; AgentBudget
// .projectId still carries the bare project id.
//
// Storage: company/budgets.json  { updatedAt, agents: { [compositeKey]:
// { allocatedUsd, spentUsd, ledger: [{ts,usd,note?}] } } }, persisted on every
// mutation, ledger capped to the newest 200 entries per agent.
// ---------------------------------------------------------------------------

export type AgentBudget = {
  // Canonical budget key: the composite `<projectId>::<agentId>` string (agent
  // ids repeat across projects, so a bare id is not unique). This is the id the
  // dashboard and the budget endpoints use. Every function below also accepts a
  // bare agent id and resolves it to the first registered match, so simple
  // callers keep working. `projectId`/`projectName` below stay bare.
  agentId: string;
  name: string;
  role: string;
  tier: "cheap" | "mid" | "frontier";
  departmentId: string;
  departmentName: string;
  projectId: string;
  projectName: string;
  modelId: string;
  /**
   * CEO order 2026-10-01: there are NO per-agent quotas. These three fields are
   * always null now (the old invented caps were coder $5, manager $3, ...). The
   * key is kept so the old endpoints keep their shape.
   */
  allocatedUsd: number | null;
  /** MEASURED spend so far (read-only). This is the only number that is real. */
  spentUsd: number;
  remainingUsd: number | null;
  pctUsed: number | null;
  sessionsRun: number;
  status: "idle" | "running";
};

export type AgentBudgetContext = {
  agentId: string;
  name: string;
  role: string;
  tier: "cheap" | "mid" | "frontier";
  departmentId: string;
  departmentName: string;
  projectId: string;
  projectName: string;
  modelId: string;
};

type LedgerEntry = { ts: string; usd: number; note?: string };
type AgentBudgetRow = { allocatedUsd: number; spentUsd: number; ledger: LedgerEntry[] };
type BudgetFile = { updatedAt: string; agents: Record<string, AgentBudgetRow> };

const LEDGER_CAP = 200;
const KEY_SEP = "::";

// CEO order 2026-10-01: the per-agent USD allocation policy (coder 5, manager 3,
// assistant 3, tester 2.50, opposer 2, enhancer 0.50, summarizer 0.50, ...) has
// been REMOVED. It was invented by this codebase, it was not money and no
// provider knew about it. Employees have no quotas any more; the real limits are
// the provider quotas and balances in src/company/budgetReal.ts and budgetGuard.ts.

// Flat per-run cost estimate used when a runtime reports no cost of its own.
const ROUTER_RUN_COST_USD: Record<string, number> = {
  "prompt-enhancer": 0.01,
  summarizer: 0.01,
  manager: 0.05,
  opposer: 0.04,
  assistant: 0.05,
  coder: 0.03,
  tester: 0.03,
  unknown: 0.02,
};
// An opencode run is a full agent loop (many model calls + tool round-trips),
// so it is estimated at a multiple of a single router call.
const OPENCODE_RUN_MULTIPLIER = 2;

let fileCache: BudgetFile | null = null;
const identities = new Map<string, AgentBudgetContext>(); // composite key -> context
const aliasToKey = new Map<string, string>(); // bare agentId -> composite key (first registered wins)
const runningKeys = new Set<string>(); // transient "currently executing" marker
const sessionRuns = new Map<string, number>(); // in-process session counter per composite key
// budgets.json stores exactly { allocatedUsd, spentUsd, ledger } per agent; the
// session count is derived (in-process marks + the session registry) so the file
// schema stays as specified.

function budgetsFile(): string {
  return path.join(getCompanyRoot(), "budgets.json");
}

export function budgetKeyFor(projectId: string, agentId: string): string {
  return `${projectId ?? ""}${KEY_SEP}${agentId}`;
}

function splitKey(key: string): { projectId: string; agentId: string } {
  const i = key.indexOf(KEY_SEP);
  if (i < 0) return { projectId: "", agentId: key };
  return { projectId: key.slice(0, i), agentId: key.slice(i + KEY_SEP.length) };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function emptyFile(): BudgetFile {
  return { updatedAt: new Date().toISOString(), agents: {} };
}

function ensureLoaded(): BudgetFile {
  if (fileCache) return fileCache;
  const file = budgetsFile();
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as BudgetFile;
      if (parsed && typeof parsed === "object" && parsed.agents && typeof parsed.agents === "object") {
        fileCache = {
          updatedAt: parsed.updatedAt ?? new Date().toISOString(),
          agents: parsed.agents,
        };
        return fileCache;
      }
    }
  } catch {
    // unreadable/corrupt file: start clean rather than crash the dashboard
  }
  fileCache = emptyFile();
  return fileCache;
}

function persist(): void {
  const f = ensureLoaded();
  f.updatedAt = new Date().toISOString();
  try {
    const file = budgetsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(f, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    // budget bookkeeping must never break a run; in-memory state stays correct
  }
}

function registerIdentity(ctx: AgentBudgetContext): string {
  const key = budgetKeyFor(ctx.projectId, ctx.agentId);
  identities.set(key, ctx);
  if (!aliasToKey.has(ctx.agentId)) aliasToKey.set(ctx.agentId, key);
  return key;
}

// Recover an agent's identity from org.json when this process has not seen it
// yet (e.g. dashboard reads budgets.json right after a restart).
function identityFromOrg(key: string): AgentBudgetContext | undefined {
  const { projectId, agentId } = splitKey(key);
  if (agentId === "assistant") {
    return {
      agentId,
      name: ROLES.assistant.name,
      role: "assistant",
      tier: ROLES.assistant.costTier,
      departmentId: "d-ceo",
      departmentName: "Executive",
      projectId,
      projectName: "",
      modelId: ROLES.assistant.defaultModel,
    };
  }
  let org;
  try {
    org = loadOrg();
  } catch {
    return undefined;
  }
  for (const p of org.projects) {
    if (projectId && p.id !== projectId) continue;
    for (const t of p.teams) {
      for (const a of t.agents) {
        if (a.id !== agentId) continue;
        const dept = org.departments.find((d) => d.id === p.departmentId);
        return {
          agentId: a.id,
          name: a.name,
          role: a.role,
          tier: ROLES[a.role]?.costTier ?? "cheap",
          departmentId: p.departmentId,
          departmentName: dept?.name ?? p.departmentId,
          projectId: p.id,
          projectName: p.name,
          modelId: a.modelId,
        };
      }
    }
  }
  return undefined;
}

function identityFor(key: string): AgentBudgetContext | undefined {
  const known = identities.get(key);
  if (known) return known;
  const fromOrg = identityFromOrg(key);
  if (fromOrg) return fromOrg;
  // Last resort: a persisted row for an agent/project org.json no longer knows
  // about stays visible (generic fields) instead of silently disappearing.
  return ensureLoaded().agents[key] ? syntheticIdentity(key) : undefined;
}

function syntheticIdentity(key: string): AgentBudgetContext {
  const { projectId, agentId } = splitKey(key);
  return {
    agentId,
    name: agentId,
    role: "unknown",
    tier: "cheap",
    departmentId: "",
    departmentName: "",
    projectId,
    projectName: "",
    modelId: "",
  };
}

// First stored row whose composite key ends with "::<bareAgentId>".
function scanBareId(bareId: string): string | undefined {
  const f = ensureLoaded();
  const suffix = `${KEY_SEP}${bareId}`;
  for (const k of Object.keys(f.agents)) {
    if (k.endsWith(suffix)) {
      if (!aliasToKey.has(bareId)) aliasToKey.set(bareId, k);
      return k;
    }
  }
  return undefined;
}

// Fresh process, no alias registered yet: fall back to the first org.json team
// that owns this agent id (the assistant lives outside any project).
function orgKeyForBareId(agentId: string): string | undefined {
  if (!agentId) return undefined;
  if (agentId === "assistant") return budgetKeyFor("", agentId);
  try {
    const org = loadOrg();
    for (const p of org.projects) {
      for (const t of p.teams) {
        for (const a of t.agents) {
          if (a.id === agentId) return budgetKeyFor(p.id, a.id);
        }
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

// Accepts either a composite key or a bare agent id (resolved to the first
// registered match, then to the first stored/org match). undefined when unknown.
function resolveKey(idOrKey: string): string | undefined {
  if (!idOrKey) return undefined;
  const f = ensureLoaded();
  if (f.agents[idOrKey]) return idOrKey;
  if (idOrKey.includes(KEY_SEP)) {
    return identities.has(idOrKey) || identityFromOrg(idOrKey) ? idOrKey : undefined;
  }
  const alias = aliasToKey.get(idOrKey);
  if (alias) return alias;
  const scanned = scanBareId(idOrKey);
  if (scanned) return scanned;
  return orgKeyForBareId(idOrKey);
}

function ensureRow(ctx: AgentBudgetContext): { key: string; row: AgentBudgetRow } {
  const key = registerIdentity(ctx);
  const f = ensureLoaded();
  let row = f.agents[key];
  if (!row) {
    row = { allocatedUsd: budgetPolicyForRole(ctx.role, ctx.tier), spentUsd: 0, ledger: [] };
    f.agents[key] = row;
    persist();
  }
  return { key, row };
}

function toBudget(key: string, ctx: AgentBudgetContext, row: AgentBudgetRow): AgentBudget {
  // No caps any more: only the measured spend is real. The stored allocatedUsd
  // is legacy data we no longer read (it is not deleted either).
  const spentUsd = round6(Math.max(0, row.spentUsd ?? 0));
  const status: AgentBudget["status"] = runningKeys.has(key) ? "running" : "idle";
  return {
    agentId: key,
    name: ctx.name,
    role: ctx.role,
    tier: ctx.tier,
    departmentId: ctx.departmentId,
    departmentName: ctx.departmentName,
    projectId: ctx.projectId,
    projectName: ctx.projectName,
    modelId: ctx.modelId,
    allocatedUsd: null,
    spentUsd,
    remainingUsd: null,
    pctUsed: null,
    sessionsRun: 0,
    status,
  };
}

// sessionsRun must not be lost across restarts and must not silently drift, so
// it is the max of the in-process mark counter and the number of sessions the
// session registry knows for this composite agent (projectId + agentId).
function sessionsRunFor(key: string): number {
  const marked = sessionRuns.get(key) ?? 0;
  let observed = 0;
  try {
    const { projectId, agentId } = splitKey(key);
    observed = listSessions(500).filter((s) => s.agentId === agentId && (s.projectId ?? "") === projectId).length;
  } catch {
    // registry unavailable: fall back to the in-process counter
  }
  return Math.max(marked, observed);
}

function budgetFor(key: string): AgentBudget | undefined {
  const f = ensureLoaded();
  const row = f.agents[key];
  if (!row) return undefined;
  const ctx = identityFor(key);
  if (!ctx) return undefined;
  return { ...toBudget(key, ctx, row), sessionsRun: sessionsRunFor(key) };
}

// CEO order 2026-10-01: the per-agent dollar quotas this table used to hold are
// GONE. It is kept as a zero-returning shim so any external caller that still
// asks "what is this role's cap?" gets a truthful "none" instead of a number.
// Do not reintroduce a policy number here: the real constraints are the provider
// quotas and balances (src/company/budgetReal.ts).
export function budgetPolicyForRole(_role: string, _tier: string): number {
  return 0;
}

export function ensureAgentBudget(ctx: AgentBudgetContext): AgentBudget {
  const { key, row } = ensureRow(ctx);
  return { ...toBudget(key, ctx, row), sessionsRun: sessionsRunFor(key) };
}

export function getBudget(agentId: string): AgentBudget | undefined {
  const key = resolveKey(agentId);
  if (!key) return undefined;
  return budgetFor(key);
}

export function listBudgets(): AgentBudget[] {
  const f = ensureLoaded();
  const out: AgentBudget[] = [];
  for (const key of Object.keys(f.agents)) {
    const row = f.agents[key];
    const ctx = identityFor(key);
    if (!row || !ctx) continue;
    out.push({ ...toBudget(key, ctx, row), sessionsRun: sessionsRunFor(key) });
  }
  return out;
}

export function charge(agentId: string, costUsd: number, note?: string): AgentBudget | undefined {
  const key = resolveKey(agentId);
  if (!key) return undefined;
  const f = ensureLoaded();
  if (!f.agents[key]) {
    const ctx = identityFor(key);
    if (!ctx) return undefined;
    ensureRow(ctx);
  }
  const row = f.agents[key];
  const usd = Number.isFinite(costUsd) && costUsd > 0 ? round6(costUsd) : 0;
  if (usd > 0) {
    row.spentUsd = round6((row.spentUsd ?? 0) + usd);
    row.ledger.push({ ts: new Date().toISOString(), usd, ...(note ? { note } : {}) });
    if (row.ledger.length > LEDGER_CAP) row.ledger = row.ledger.slice(-LEDGER_CAP);
    persist();
  }
  return budgetFor(key);
}

/**
 * CEO order 2026-10-01: an agent is never refused for its own budget any more.
 * There are no per-agent quotas, so this always returns true. Kept exported so
 * older callers (and ops checks) still link; real pressure lives in
 * budgetGuard.ts (provider quota), which is the only thing that may slow work.
 */
export function canAfford(_agentId: string, _estimatedUsd = 0): boolean {
  return true;
}

/**
 * Legacy endpoint shim. CEO order 2026-10-01 removed per-agent quotas, so there
 * is nothing to set any more: the call is a no-op that returns the (cap-free)
 * row unchanged, so an old client gets a valid shape instead of a 404.
 */
export function setAllocation(agentId: string, _allocatedUsd: number): AgentBudget | undefined {
  const key = resolveKey(agentId);
  if (!key) return undefined;
  const f = ensureLoaded();
  if (!f.agents[key]) {
    const ctx = identityFor(key);
    if (!ctx) return undefined;
    ensureRow(ctx);
  }
  return budgetFor(key);
}

export type BudgetTotals = {
  /** always null: there is no cap total any more. */
  totalUsd: number | null;
  /** MEASURED spend, the real number. */
  spentUsd: number;
  /** always null: nothing is left of an allocation that no longer exists. */
  remainingUsd: number | null;
  capRemoved: true;
};

export function budgetTotals(): BudgetTotals {
  const f = ensureLoaded();
  let spentUsd = 0;
  for (const row of Object.values(f.agents)) {
    spentUsd += Math.max(0, row.spentUsd ?? 0);
  }
  return { totalUsd: null, spentUsd: round6(spentUsd), remainingUsd: null, capRemoved: true };
}

export function budgetByDepartment(): Array<{
  departmentId: string;
  departmentName: string;
  /** always null: no per-agent quotas. */
  allocatedUsd: number | null;
  /** MEASURED spend, the real number. */
  spentUsd: number;
  /** always null: nothing is left of an allocation that no longer exists. */
  remainingUsd: number | null;
}> {
  const groups = new Map<string, { departmentId: string; departmentName: string; spentUsd: number }>();
  for (const b of listBudgets()) {
    const id = b.departmentId || "unknown";
    const g = groups.get(id) ?? { departmentId: id, departmentName: b.departmentName || id, spentUsd: 0 };
    g.spentUsd += b.spentUsd;
    groups.set(id, g);
  }
  return [...groups.values()].map((g) => ({
    departmentId: g.departmentId,
    departmentName: g.departmentName,
    allocatedUsd: null,
    spentUsd: round6(g.spentUsd),
    remainingUsd: null,
  }));
}

export function estimateCostForRole(role: string, runtime: "opencode" | "router"): number {
  const base = ROUTER_RUN_COST_USD[role] ?? ROUTER_RUN_COST_USD.unknown;
  return round6(runtime === "opencode" ? base * OPENCODE_RUN_MULTIPLIER : base);
}

export function markRunning(agentId: string, running: boolean): void {
  const key = resolveKey(agentId);
  if (!key) return;
  const f = ensureLoaded();
  if (!f.agents[key]) {
    const ctx = identityFor(key);
    if (!ctx) return;
    ensureRow(ctx);
  }
  if (running) {
    if (!runningKeys.has(key)) sessionRuns.set(key, (sessionRuns.get(key) ?? 0) + 1);
    runningKeys.add(key);
  } else {
    runningKeys.delete(key);
  }
  persist();
}

export function budgetLedger(agentId: string): Array<{ ts: string; usd: number; note?: string }> {
  const key = resolveKey(agentId);
  if (!key) return [];
  const row = ensureLoaded().agents[key];
  if (!row) return [];
  // newest first
  return row.ledger.slice(-LEDGER_CAP).reverse().map((e) => ({ ...e }));
}
