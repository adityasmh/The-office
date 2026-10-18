// src/company/budgetReal.ts — the REAL budget numbers (CEO order 2026-10-01).
//
// WHY THIS EXISTS
// The dashboard used to show a "$80.50 budget" with per-agent caps (coder $5,
// manager $3, ...) that this codebase invented (src/company/budget.ts
// DEFAULT_ALLOCATION_USD). Nothing is charged when one is "used up" and no
// provider knows about it. The CEO's order: show the actual budget and the real
// numbers, and stop giving employees quotas.
//
// So this module answers with three provider blocks and one measured-spend
// block, and NOTHING ELSE:
//   - OpenCode Go   : the real 5-hour / weekly / monthly windows (% left and
//                     when each resets), read with the key the company already
//                     holds (src/company/usage.ts openCodeGoUsage()).
//   - DeepSeek direct: the real credit balance from DeepSeek's own balance
//                     endpoint, plus the off-peak/peak line from
//                     src/company/offpeak.ts and whether direct is armed
//                     (src/company/deepseekDirect.ts deepseekDirectArmed()).
//   - Claude        : the real subscription windows from `jcode usage --json`,
//                     or "not measured" with the reason. It is a subscription:
//                     there is no dollar budget, and none is invented.
//   - Spend         : the sum of real per-call cost already recorded in
//                     company/projects/*/cost.jsonl (+ company/budgets.json for
//                     per-agent attribution): today, last 7 days, by provider,
//                     by model, by department/project. DeepSeek direct is shown
//                     separately from Go.
//
// Rules honoured here (from the work order):
//   * read-only GETs; the DeepSeek key is only ever placed in a header and is
//     NEVER returned, logged or written to disk by this module;
//   * each source is bounded (SOURCE_TIMEOUT_MS, default 3 s) and the result is
//     cached (BUDGET_REAL_CACHE_MS, default 45 s, clamp 10-60 s). A source that
//     fails returns the LAST GOOD value with `stale: true`, or `connected:false`
//     with the honest reason — never a guessed number;
//   * anything unmeasured says "not measured" instead of a number.

import fs from "node:fs";
import path from "node:path";
import { getCompanyRoot, loadOrg } from "./org.js";
import { listBudgets } from "./budget.js";
import {
  maskSensitive,
  openCodeGoUsage,
  readClaudeQuota,
  type ClaudeQuota,
  type GoQuota,
} from "./usage.js";
import { deepseekClock, type DeepseekClock } from "./offpeak.js";
import { deepseekBaseUrl, deepseekDirectArmed, deepseekKey } from "./deepseekDirect.js";

// ---------------------------------------------------------------------------
// Knobs
// ---------------------------------------------------------------------------
function envMs(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, raw));
}

/** The whole payload is rebuilt at most this often (the work order: 30-60 s). */
export function realBudgetCacheMs(): number {
  return envMs("BUDGET_REAL_CACHE_MS", 45_000, 30_000, 60_000);
}

/** Per-source hard bound so the router request is never held by a slow provider. */
export function realBudgetSourceTimeoutMs(): number {
  return envMs("BUDGET_REAL_TIMEOUT_MS", 3_000, 500, 15_000);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type RealWindow = {
  window: string;
  usedPct: number | null;
  remainingPct: number | null;
  resetsAt?: string;
  resetsIn?: string;
  note?: string;
};

export type RealProviderBlock = {
  id: "opencode-go" | "deepseek-direct" | "claude";
  label: string;
  /** quota = a percentage window; balance = prepaid credit; subscription = no dollars. */
  kind: "quota" | "balance" | "subscription";
  connected: boolean;
  measured: boolean;
  /** true when the live read failed and this is the last good value. */
  stale: boolean;
  source: string;
  checkedAt: string | null;
  windows: RealWindow[];
  remainingPct: number | null;
  bindingWindow: string | null;
  balanceUsd: number | null;
  currency: string | null;
  plan: string | null;
  /** balance block: is the direct API armed (flag + key)? */
  armed?: boolean;
  keyPresent?: boolean;
  /** balance block: the DeepSeek clock (off-peak/peak, in IST). */
  phase?: DeepseekClock;
  phaseLine?: string;
  /** subscription block: there is no dollar budget (Claude Pro). */
  noDollarBudget?: boolean;
  /** always set: plain-English line, no invented content. */
  detail: string;
  /** set when a real number could not be read (instead of guessing). */
  notMeasured?: string;
};

export type SpendBucket = { key: string; calls: number; costUsd: number };

export type RealSpend = {
  measured: boolean;
  source: string;
  todayUsd: number;
  last7dUsd: number;
  allTimeUsd: number;
  byProvider: { opencodeGoUsd: number; deepseekDirectUsd: number; claudeUsd: number; otherUsd: number };
  byModel: SpendBucket[];
  byDepartment: SpendBucket[];
  byProject: SpendBucket[];
  /** DeepSeek direct, separated from Go (work order). */
  deepseekDirect: { costUsd: number; calls: number; rule: string };
  note: string;
};

export type RealAgentSpend = {
  agentId: string;
  name: string;
  role: string;
  departmentName: string;
  projectName: string;
  /** measured spend so far, read-only. */
  spentUsd: number;
  spentTodayUsd: number;
  /** share of the company's measured spend, in percent. */
  sharePct: number;
  /** always null: the per-agent quotas are gone. */
  capUsd: null;
};

export type RealBudget = {
  version: 1;
  generatedAt: string;
  cacheTtlS: number;
  /** explicit statement of what changed for the CEO's benefit. */
  capsRemoved: true;
  headline: string;
  providers: { go: RealProviderBlock; deepseek: RealProviderBlock; claude: RealProviderBlock };
  spend: RealSpend;
  agents: RealAgentSpend[];
  /** no per-agent allocations exist any more. */
  caps: null;
  notMeasured: string[];
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function roundPct(n: number): number {
  return Math.round(n * 100) / 100;
}

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Resolve a promise, but never wait longer than `ms`; resolves to TIMEOUT. */
const TIMEOUT = Symbol("timeout");
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** "06:30" out of offpeak.ts's "2026-10-01 06:30 IST (Fri)" / "2026-10-01 06:30 UTC". */
function clockHHMM(formatted: string): string {
  const m = formatted.match(/\s(\d{2}:\d{2})\s/);
  return m ? m[1]! : formatted;
}

function phaseLine(clock: DeepseekClock): string {
  const until = clockHHMM(clock.nextChangeIst);
  return clock.phase === "off-peak"
    ? `off-peak (0.5x) until ${until} IST`
    : `peak (1x) until ${until} IST`;
}

// ---------------------------------------------------------------------------
// DeepSeek direct API: the real credit balance
// ---------------------------------------------------------------------------
export type DeepseekBalance = {
  connected: boolean;
  source: "deepseek-balance-api" | "unavailable";
  stale: boolean;
  checkedAt: string;
  currency: string | null;
  totalBalanceUsd: number | null;
  grantedBalanceUsd: number | null;
  toppedUpBalanceUsd: number | null;
  available: boolean | null;
  detail: string;
  notMeasured?: string;
};

type BalanceCache = { at: number; data: DeepseekBalance };
let balanceCache: BalanceCache | null = null;
const BALANCE_TTL_MS_DEFAULT = 45_000;

function unavailableBalance(checkedAt: string, reason: string): DeepseekBalance {
  return {
    connected: false,
    source: "unavailable",
    stale: false,
    checkedAt,
    currency: null,
    totalBalanceUsd: null,
    grantedBalanceUsd: null,
    toppedUpBalanceUsd: null,
    available: null,
    detail: `DeepSeek balance unavailable: ${reason}`,
    notMeasured: reason,
  };
}

/** Parse the documented `{is_available, balance_infos:[{currency,total_balance,...}]}`. */
export function parseDeepseekBalance(body: unknown): {
  available: boolean | null;
  currency: string | null;
  total: number | null;
  granted: number | null;
  toppedUp: number | null;
} {
  const root = (body ?? {}) as Record<string, unknown>;
  const infos = Array.isArray(root.balance_infos) ? (root.balance_infos as Array<Record<string, unknown>>) : [];
  const usd = infos.find((b) => String(b?.currency ?? "").toUpperCase() === "USD") ?? infos[0];
  return {
    available: typeof root.is_available === "boolean" ? root.is_available : null,
    currency: usd ? String(usd.currency ?? "") || null : null,
    total: usd ? numOrNull(usd.total_balance) : null,
    granted: usd ? numOrNull(usd.granted_balance) : null,
    toppedUp: usd ? numOrNull(usd.topped_up_balance) : null,
  };
}

/**
 * Read DeepSeek's credit balance. Read-only GET; the key is placed in the
 * Authorization header only and never appears in the result. On failure the
 * last good reading is returned with `stale: true`, else `connected:false`.
 */
export async function deepseekBalance(opts?: { fresh?: boolean; timeoutMs?: number }): Promise<DeepseekBalance> {
  const ttl = envMs("BUDGET_DEEPSEEK_BALANCE_CACHE_MS", BALANCE_TTL_MS_DEFAULT, 10_000, 60_000);
  if (opts?.fresh !== true && balanceCache && Date.now() - balanceCache.at < ttl) return balanceCache.data;

  const checkedAt = new Date().toISOString();
  const key = deepseekKey();
  if (!key) {
    const prev = balanceCache?.data;
    if (prev?.connected) {
      const stale = { ...prev, stale: true, detail: `${prev.detail} (key removed; showing the last reading)` };
      balanceCache = { at: Date.now(), data: stale };
      return stale;
    }
    const off = unavailableBalance(checkedAt, "no DEEPSEEK_API_KEY in .env");
    balanceCache = { at: Date.now(), data: off };
    return off;
  }

  const url = `${deepseekBaseUrl()}/user/balance`;
  const timeoutMs = opts?.timeoutMs ?? realBudgetSourceTimeoutMs();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let failure = "";
  try {
    const r = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: ac.signal,
    });
    const text = await r.text().catch(() => "");
    if (!r.ok) {
      failure = `GET ${url} -> HTTP ${r.status}`;
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      const b = parseDeepseekBalance(parsed);
      if (b.total === null && b.currency === null) {
        failure = `GET ${url} answered without a balance (no balance_infos)`;
      } else {
        const data: DeepseekBalance = {
          connected: true,
          source: "deepseek-balance-api",
          stale: false,
          checkedAt,
          currency: b.currency,
          totalBalanceUsd: b.total,
          grantedBalanceUsd: b.granted,
          toppedUpBalanceUsd: b.toppedUp,
          available: b.available,
          detail:
            `DeepSeek credit: ${b.total === null ? "not measured" : `${b.currency ?? "USD"} ${b.total.toFixed(2)}`}` +
            ` (topped up ${b.toppedUp === null ? "?" : b.toppedUp.toFixed(2)}, granted ${b.granted === null ? "?" : b.granted.toFixed(2)}). ` +
            `Read-only from GET ${url}; this is prepaid credit, not a subscription.`,
        };
        balanceCache = { at: Date.now(), data };
        return data;
      }
    }
  } catch (e) {
    failure = `${url} -> ${String((e as Error)?.message ?? e)}`;
  } finally {
    clearTimeout(timer);
  }

  const prev = balanceCache?.data;
  if (prev?.connected) {
    const stale: DeepseekBalance = {
      ...prev,
      stale: true,
      detail: `${prev.detail} (last live read failed: ${maskSensitive(failure)})`,
    };
    balanceCache = { at: Date.now(), data: stale };
    return stale;
  }
  const off = unavailableBalance(checkedAt, failure);
  balanceCache = { at: Date.now(), data: off };
  return off;
}

// ---------------------------------------------------------------------------
// Measured spend from our own per-call ledger
// ---------------------------------------------------------------------------
type LedgerEvent = { ts: number; model: string; costUsd: number; projectId: string; agentId: string };

const DIRECT_DEEPSEEK_IDS = new Set(["deepseek-flash"]);

/**
 * Fallback when no per-call cost line exists yet: the newest record per session
 * from company/sessions.jsonl (the same fallback usage.ts's measuredSpendByModel
 * uses). The work order names sessions.jsonl as a measured-spend source.
 */
function sessionCostEvents(): LedgerEvent[] {
  const file = path.join(getCompanyRoot(), "sessions.jsonl");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const latest = new Map<string, LedgerEvent>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec: { id?: string; agentId?: string; projectId?: string; model?: string; costUsd?: number; startedAt?: string; finishedAt?: string };
    try {
      rec = JSON.parse(line) as typeof rec;
    } catch {
      continue; // a malformed line is skipped, never guessed
    }
    if (!rec.id) continue;
    const prev = latest.get(rec.id);
    const model = String(rec.model ?? prev?.model ?? "unknown");
    const costUsd = Number(rec.costUsd);
    const ts = Date.parse(String(rec.finishedAt ?? rec.startedAt ?? ""));
    latest.set(rec.id, {
      ts: Number.isFinite(ts) ? ts : (prev?.ts ?? NaN),
      model,
      costUsd: Number.isFinite(costUsd) ? costUsd : (prev?.costUsd ?? 0),
      projectId: String(rec.projectId ?? prev?.projectId ?? ""),
      agentId: String(rec.agentId ?? prev?.agentId ?? ""),
    });
  }
  return [...latest.values()].filter((e) => Number.isFinite(e.ts));
}

export type SpendProviderClass = "opencode-go" | "deepseek-direct" | "claude" | "other";

/** Provider split by the RECORDED model id (see rule in `deepseekDirect.rule`). */
export function providerClassForModel(model: string): SpendProviderClass {
  const m = String(model ?? "").toLowerCase();
  if (m.startsWith("claude")) return "claude";
  if (DIRECT_DEEPSEEK_IDS.has(m)) return "deepseek-direct";
  if (/deepseek/.test(m)) return "opencode-go";
  if (/^(gpt|space-bunny|o1|o3)/.test(m)) return "other";
  return "opencode-go"; // GLM/Kimi/Qwen all ride the single OpenCode Go key
}

function ledgerEvents(): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  const projectsDir = path.join(getCompanyRoot(), "projects");
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(projectsDir);
  } catch {
    ids = [];
  }
  for (const id of ids) {
    const file = path.join(projectsDir, id, "cost.jsonl");
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let e: { ts?: string; modelId?: string; model?: string; costUsd?: number; note?: string };
      try {
        e = JSON.parse(line) as typeof e;
      } catch {
        continue; // a malformed line is skipped, never guessed
      }
      const ts = Date.parse(String(e.ts ?? ""));
      const cost = Number(e.costUsd ?? 0);
      if (!Number.isFinite(ts) || !Number.isFinite(cost)) continue;
      const note = String(e.note ?? "");
      events.push({
        ts,
        model: String(e.modelId ?? e.model ?? "unknown"),
        costUsd: cost,
        projectId: id,
        agentId: note.split(/\s+/)[0] ?? "",
      });
    }
  }
  // No per-call line anywhere: fall back to the session registry (sessions.jsonl),
  // which is the other measured source the work order names. Same rule as usage.ts.
  if (events.length === 0) return sessionCostEvents();
  return events;
}

function projectInfo(): Map<string, { projectName: string; departmentName: string }> {
  const out = new Map<string, { projectName: string; departmentName: string }>();
  try {
    const org = loadOrg();
    for (const p of org.projects) {
      const dept = org.departments.find((d) => d.id === p.departmentId);
      out.set(p.id, { projectName: p.name, departmentName: dept?.name ?? p.departmentId ?? "Unassigned" });
    }
  } catch {
    /* org unreadable: project ids are used as their own labels below */
  }
  return out;
}

/**
 * Sum the real per-call cost. `now` defaults to Date.now(); "today" is the local
 * calendar day (the same rule the old spend block used).
 */
export function measuredSpend(now = Date.now()): RealSpend {
  const events = ledgerEvents();
  const info = projectInfo();
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const weekAgo = now - 7 * 24 * 3600_000;

  let todayUsd = 0;
  let last7dUsd = 0;
  let allTimeUsd = 0;
  const byModel = new Map<string, { calls: number; costUsd: number }>();
  const byProject = new Map<string, { calls: number; costUsd: number }>();
  const byDepartment = new Map<string, { calls: number; costUsd: number }>();
  const byProvider = { opencodeGoUsd: 0, deepseekDirectUsd: 0, claudeUsd: 0, otherUsd: 0 };
  let directCost = 0;
  let directCalls = 0;

  for (const e of events) {
    allTimeUsd += e.costUsd;
    if (e.ts >= midnight.getTime()) todayUsd += e.costUsd;
    if (e.ts >= weekAgo) last7dUsd += e.costUsd;

    const m = byModel.get(e.model) ?? { calls: 0, costUsd: 0 };
    m.calls += 1;
    m.costUsd += e.costUsd;
    byModel.set(e.model, m);

    const pj = byProject.get(e.projectId) ?? { calls: 0, costUsd: 0 };
    pj.calls += 1;
    pj.costUsd += e.costUsd;
    byProject.set(e.projectId, pj);

    const deptName = info.get(e.projectId)?.departmentName ?? "Unknown";
    const dp = byDepartment.get(deptName) ?? { calls: 0, costUsd: 0 };
    dp.calls += 1;
    dp.costUsd += e.costUsd;
    byDepartment.set(deptName, dp);

    const cls = providerClassForModel(e.model);
    if (cls === "claude") byProvider.claudeUsd += e.costUsd;
    else if (cls === "deepseek-direct") {
      byProvider.deepseekDirectUsd += e.costUsd;
      directCost += e.costUsd;
      directCalls += 1;
    } else if (cls === "other") byProvider.otherUsd += e.costUsd;
    else byProvider.opencodeGoUsd += e.costUsd;
  }

  const buckets = (m: Map<string, { calls: number; costUsd: number }>): SpendBucket[] =>
    [...m.entries()]
      .map(([key, v]) => ({ key, calls: v.calls, costUsd: round6(v.costUsd) }))
      .sort((a, b) => b.costUsd - a.costUsd);

  return {
    measured: events.length > 0,
    source: "company/projects/*/cost.jsonl (per-call cost recorded by the runtime); company/sessions.jsonl when no per-call line exists",
    todayUsd: round6(todayUsd),
    last7dUsd: round6(last7dUsd),
    allTimeUsd: round6(allTimeUsd),
    byProvider: {
      opencodeGoUsd: round6(byProvider.opencodeGoUsd),
      deepseekDirectUsd: round6(byProvider.deepseekDirectUsd),
      claudeUsd: round6(byProvider.claudeUsd),
      otherUsd: round6(byProvider.otherUsd),
    },
    byModel: buckets(byModel),
    byDepartment: buckets(byDepartment),
    byProject: buckets(byProject),
    deepseekDirect: {
      costUsd: round6(directCost),
      calls: directCalls,
      rule:
        'A call counts as DeepSeek direct only when its recorded model id is "deepseek-flash" (the direct API\'s own id). ' +
        'Go records "deepseek-v4-flash" / "deepseek-v4.1-flash" for the same family, so a direct call routed under a Go id ' +
        'cannot be told apart from a Go call: it is counted with Go and this is stated here rather than guessed.',
    },
    note:
      events.length > 0
        ? "Summed from the real per-call cost already recorded. The runtime's own per-call figure, not a provider invoice."
        : "Not measured: no per-call cost has been recorded yet (company/projects/*/cost.jsonl is empty).",
  };
}

// ---------------------------------------------------------------------------
// Per-agent measured spend (read-only; no caps)
// ---------------------------------------------------------------------------
type BudgetFileShape = {
  agents?: Record<string, { spentUsd?: number; ledger?: Array<{ ts?: string; usd?: number }> }>;
};

function readBudgetsFile(): BudgetFileShape {
  try {
    const raw = fs.readFileSync(path.join(getCompanyRoot(), "budgets.json"), "utf8");
    const parsed = JSON.parse(raw) as BudgetFileShape;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Measured spend per agent, newest-first. `capUsd` is always null (no quotas). */
export function agentSpendRows(now = Date.now()): RealAgentSpend[] {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const file = readBudgetsFile();

  // Names/roles/departments come from the budget module's own rows (org-backed).
  let described: Array<{ agentId: string; name: string; role: string; departmentName: string; projectName: string }> = [];
  try {
    described = listBudgets().map((b) => ({
      agentId: b.agentId,
      name: b.name,
      role: b.role,
      departmentName: b.departmentName,
      projectName: b.projectName,
    }));
  } catch {
    described = [];
  }
  const byKey = new Map(described.map((d) => [d.agentId, d]));

  const rows: Array<Omit<RealAgentSpend, "sharePct">> = [];
  for (const [agentId, row] of Object.entries(file.agents ?? {})) {
    const spent = Number(row?.spentUsd ?? 0);
    let today = 0;
    for (const e of row?.ledger ?? []) {
      const ts = Date.parse(String(e?.ts ?? ""));
      const usd = Number(e?.usd ?? 0);
      if (Number.isFinite(ts) && ts >= midnight.getTime() && Number.isFinite(usd)) today += usd;
    }
    const d = byKey.get(agentId);
    const [, bareId = agentId] = agentId.split("::");
    rows.push({
      agentId,
      name: d?.name || bareId,
      role: d?.role || "unknown",
      departmentName: d?.departmentName || "Unassigned",
      projectName: d?.projectName || "",
      spentUsd: round6(Number.isFinite(spent) ? spent : 0),
      spentTodayUsd: round6(today),
      capUsd: null,
    });
  }

  const total = rows.reduce((n, r) => n + r.spentUsd, 0);
  return rows
    .map((r) => ({ ...r, sharePct: total > 0 ? roundPct((r.spentUsd / total) * 100) : 0 }))
    .sort((a, b) => b.spentUsd - a.spentUsd);
}

// ---------------------------------------------------------------------------
// Provider blocks
// ---------------------------------------------------------------------------
function goBlock(go: GoQuota, stale: boolean, detailSuffix?: string): RealProviderBlock {
  const windows: RealWindow[] = go.windows.map((w) => ({
    window: w.window,
    usedPct: numOrNull(w.usedPct),
    remainingPct: numOrNull(w.remainingPct),
    ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}),
    ...(w.resetsIn ? { resetsIn: w.resetsIn } : {}),
  }));
  return {
    id: "opencode-go",
    label: "OpenCode Go",
    kind: "quota",
    connected: go.connected,
    measured: go.connected,
    stale,
    source: go.source === "api" ? "opencode-go-api" : go.source === "cookie" ? "opencode-console-cookie" : "unavailable",
    checkedAt: go.checkedAt ?? null,
    windows,
    remainingPct: go.connected ? numOrNull(go.remainingPct) : null,
    bindingWindow: go.bindingWindow ?? null,
    balanceUsd: null,
    currency: null,
    plan: null,
    detail: (go.connected ? go.detail : go.detail) + (detailSuffix ? ` ${detailSuffix}` : ""),
    ...(go.connected ? {} : { notMeasured: go.detail }),
  };
}

function claudeBlock(claude: ClaudeQuota, stale: boolean, detailSuffix?: string): RealProviderBlock {
  const windows: RealWindow[] = claude.windows.map((w) => ({
    window: w.label,
    usedPct: numOrNull(w.usedPct),
    remainingPct: numOrNull(w.remainingPct),
    ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}),
    ...(w.resetsIn ? { resetsIn: w.resetsIn } : {}),
  }));
  const subLine = "Claude is a subscription: there is no dollar budget, and no per-agent quota.";
  return {
    id: "claude",
    label: "Claude",
    kind: "subscription",
    connected: claude.connected,
    measured: claude.connected,
    stale,
    source: claude.source === "cli" ? "jcode-usage-cli" : "unavailable",
    checkedAt: claude.checkedAt ?? null,
    windows,
    remainingPct: claude.connected ? numOrNull(claude.remainingPct) : null,
    bindingWindow: claude.bindingWindow ?? null,
    balanceUsd: null,
    currency: null,
    plan: claude.plan ?? null,
    noDollarBudget: true,
    detail:
      (claude.connected ? claude.detail : claude.detail) +
      ` ${subLine}` +
      (detailSuffix ? ` ${detailSuffix}` : ""),
    ...(claude.connected ? {} : { notMeasured: claude.detail }),
  };
}

// ---------------------------------------------------------------------------
// The build (async, cached, in-flight deduped)
// ---------------------------------------------------------------------------
let realCache: { at: number; data: RealBudget } | null = null;
let inFlight: Promise<RealBudget> | null = null;
let lastGoodGo: GoQuota | null = null;
let lastGoodClaude: ClaudeQuota | null = null;

export async function buildRealBudget(opts?: { fresh?: boolean; now?: number }): Promise<RealBudget> {
  const ttl = realBudgetCacheMs();
  if (opts?.fresh !== true && realCache && Date.now() - realCache.at < ttl) return realCache.data;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const now = opts?.now ?? Date.now();
    const timeoutMs = realBudgetSourceTimeoutMs();

    const [goRes, claudeRes, balance] = await Promise.all([
      withTimeout(openCodeGoUsage({ fresh: opts?.fresh }), timeoutMs).then((r) =>
        r === TIMEOUT ? ("timeout" as const) : r,
      ).catch(() => "timeout" as const),
      withTimeout(readClaudeQuota({ fresh: opts?.fresh }), timeoutMs).then((r) =>
        r === TIMEOUT ? ("timeout" as const) : r,
      ).catch(() => "timeout" as const),
      deepseekBalance({ fresh: opts?.fresh, timeoutMs }).catch(() => undefined),
    ]);

    // OpenCode Go: keep the last good reading when the live read failed/timed out.
    let go: GoQuota;
    let goStale = false;
    let goSuffix: string | undefined;
    if (goRes !== "timeout" && goRes.connected) {
      lastGoodGo = goRes;
      go = goRes;
    } else if (lastGoodGo) {
      go = lastGoodGo;
      goStale = true;
      goSuffix = `(live read failed or timed out; showing the last good reading from ${lastGoodGo.checkedAt})`;
    } else if (goRes !== "timeout") {
      go = goRes;
    } else {
      go = {
        connected: false,
        source: "unavailable",
        windows: [],
        detail: `OpenCode Go not measured: the quota read did not answer within ${timeoutMs} ms and no earlier reading exists.`,
        checkedAt: new Date().toISOString(),
      };
    }

    let claude: ClaudeQuota;
    let claudeStale = false;
    let claudeSuffix: string | undefined;
    if (claudeRes !== "timeout" && claudeRes.connected) {
      lastGoodClaude = claudeRes;
      claude = claudeRes;
    } else if (lastGoodClaude) {
      claude = lastGoodClaude;
      claudeStale = true;
      claudeSuffix = `(live read failed or timed out; showing the last good reading from ${lastGoodClaude.checkedAt})`;
    } else if (claudeRes !== "timeout") {
      claude = claudeRes;
    } else {
      claude = {
        connected: false,
        source: "unavailable",
        windows: [],
        detail: `Claude windows not measured: \`jcode usage --json\` did not answer within ${timeoutMs} ms and no earlier reading exists.`,
        checkedAt: new Date().toISOString(),
      };
    }

    const clock = deepseekClock(new Date(now));
    const armed = deepseekDirectArmed();
    const keyPresent = !!deepseekKey();
    const bal = balance ?? (await deepseekBalance({}).catch(() => undefined));
    const deepseek: RealProviderBlock = {
      id: "deepseek-direct",
      label: "DeepSeek direct API",
      kind: "balance",
      connected: !!bal?.connected,
      measured: !!bal?.connected,
      stale: !!bal?.stale,
      source: bal?.source ?? "unavailable",
      checkedAt: bal?.checkedAt ?? null,
      windows: [],
      remainingPct: null,
      bindingWindow: null,
      balanceUsd: bal?.totalBalanceUsd ?? null,
      currency: bal?.currency ?? null,
      plan: null,
      armed,
      keyPresent,
      phase: clock,
      phaseLine: phaseLine(clock),
      detail:
        (bal?.detail ?? "DeepSeek balance not measured (the balance read did not answer).") +
        ` Phase: ${phaseLine(clock)}.` +
        ` Direct routing ${armed ? "is ARMED" : keyPresent ? "is off (set DEEPSEEK_DIRECT=1)" : "has no key (set DEEPSEEK_API_KEY)"}.`,
      ...(bal?.connected ? {} : { notMeasured: bal?.notMeasured ?? "the balance read did not answer" }),
    };

    const spend = measuredSpend(now);
    const agents = agentSpendRows(now);

    const notMeasured: string[] = [];
    if (!go.connected) notMeasured.push("OpenCode Go windows: " + go.detail);
    if (!bal?.connected) notMeasured.push("DeepSeek balance: " + (bal?.notMeasured ?? "not measured"));
    if (!claude.connected) notMeasured.push("Claude windows: " + claude.detail);
    if (!spend.measured) notMeasured.push("Measured spend: no per-call cost recorded yet.");

    const data: RealBudget = {
      version: 1,
      generatedAt: new Date(now).toISOString(),
      cacheTtlS: Math.round(ttl / 1000),
      capsRemoved: true,
      headline:
        "Real numbers: provider limits and measured spend. Per-agent quotas are gone; nobody is refused for a cap.",
      providers: {
        go: goBlock(go, goStale, goSuffix),
        deepseek,
        claude: claudeBlock(claude, claudeStale, claudeSuffix),
      },
      spend,
      agents,
      caps: null,
      notMeasured,
    };
    realCache = { at: Date.now(), data };
    return data;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/**
 * Synchronous view for callers that cannot await (the /company/panel payload).
 * Returns the memoised build when one exists (any age) and kicks a background
 * refresh when it is missing or stale, so the panel and GET /company/budget/real
 * show the SAME object. Before the first build it returns the measured-only
 * numbers with the provider blocks marked "not measured" - never an invention.
 */
export function realBudgetSync(): RealBudget {
  const ttl = realBudgetCacheMs();
  const stale = !realCache || Date.now() - realCache.at >= ttl;
  if (stale && !inFlight) void buildRealBudget().catch(() => undefined);
  if (realCache) return realCache.data;
  return measuredOnlyBudget();
}

function measuredOnlyBudget(): RealBudget {
  const now = Date.now();
  const clock = deepseekClock(new Date(now));
  const blank = (id: RealProviderBlock["id"], label: string, kind: RealProviderBlock["kind"], why: string): RealProviderBlock => ({
    id,
    label,
    kind,
    connected: false,
    measured: false,
    stale: false,
    source: "unavailable",
    checkedAt: null,
    windows: [],
    remainingPct: null,
    bindingWindow: null,
    balanceUsd: null,
    currency: null,
    plan: null,
    detail: why,
    notMeasured: why,
  });
  const spend = measuredSpend(now);
  return {
    version: 1,
    generatedAt: new Date(now).toISOString(),
    cacheTtlS: Math.round(realBudgetCacheMs() / 1000),
    capsRemoved: true,
    headline:
      "Real numbers: provider limits and measured spend. Per-agent quotas are gone; nobody is refused for a cap.",
    providers: {
      go: blank("opencode-go", "OpenCode Go", "quota", "Not measured yet: the first real reading is still being fetched."),
      deepseek: {
        ...blank("deepseek-direct", "DeepSeek direct API", "balance", "Not measured yet: the first real balance read is still being fetched."),
        armed: deepseekDirectArmed(),
        keyPresent: !!deepseekKey(),
        phase: clock,
        phaseLine: phaseLine(clock),
      },
      claude: blank("claude", "Claude", "subscription", "Not measured yet: the first real reading is still being fetched."),
    },
    spend,
    agents: agentSpendRows(now),
    caps: null,
    notMeasured: ["The provider readings have not completed yet on this process."],
  };
}

/** Test/ops seam: drop the caches so a check reads the live sources. */
export function resetRealBudgetCache(): void {
  realCache = null;
  balanceCache = null;
  lastGoodGo = null;
  lastGoodClaude = null;
}

/** Masked, key-free evidence line for ops (never includes a secret). */
export function realBudgetSummary(b: RealBudget): string {
  const w = b.providers.go.windows.map((x) => `${x.window} ${x.remainingPct}% left`).join(", ");
  return [
    `Go: ${b.providers.go.connected ? w : "not measured"}`,
    `DeepSeek: ${b.providers.deepseek.balanceUsd === null ? "not measured" : `$${b.providers.deepseek.balanceUsd}`} ${b.providers.deepseek.phaseLine ?? ""}`,
    `Claude: ${b.providers.claude.connected ? b.providers.claude.windows.map((x) => `${x.window} ${x.remainingPct}% left`).join(", ") : "not measured"}`,
    `Spend today $${b.spend.todayUsd}, 7d $${b.spend.last7dUsd}`,
  ].join(" | ");
}

/** Re-exported so the ops check can name the key without importing deepseekDirect. */
export { deepseekKey };
