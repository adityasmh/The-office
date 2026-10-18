// BUDGET (docs/BUDGET_SPEC.md): real provider budget pressure, and the rules
// that bend the company's behaviour before a provider stops it.
//
// WHY THIS EXISTS
// The dashboard's "$80.50 budget" is a virtual policy cap (src/company/budget.ts,
// docs/PROVIDER_USAGE.md): it is not money and nothing breaks when it is used up.
// What actually stops work is the subscription quota:
//   - OpenCode Go (every jcode terminal/worker): a 5-hour / weekly / monthly
//     allowance, read from the Go API with the key this company already holds
//     (src/company/usage.ts -> openCodeGoUsage()).
//   - Claude (manager, reviews, assistant, run managers): the rolling 5-hour and
//     7-day windows from `jcode usage --json --no-update` (readClaudeQuota()).
//
// WHAT THIS MODULE OWNS
//   1. budgetPressure()  - one honest row per provider: remaining %, reset,
//      measured burn, projected run-out, and a green/amber/red level.
//   2. the RULES TABLE as data (rulesFor), so the manager's decisions in the
//      spec's table are easy to tune and easy to read.
//   3. the HARD FILTER (applyBudgetFilter) applied AFTER Laya: a Kimi pick under
//      Go amber becomes DeepSeek, and the reason is recorded.
//   4. the guarded background poller (startBudgetWatcher) that writes
//      company/budget/state.json + company/budget/history.jsonl every
//      BUDGET_POLL_S (default 300 s), async only, unref'd, never on the request path.
//
// Every rule here is advisory-but-data-driven: nothing in this module spends
// money, and with no measurement (level "unknown") it applies NO restriction and
// says so instead of guessing.
//
// Hard rules from the work order: read-only, the API key/cookie never leave
// usage.ts, and no login is ever automated.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { getCompanyRoot } from "./org.js";
import {
  humanizeUntil, openCodeGoUsage, readClaudeQuota,
  type ClaudeQuota, type GoQuota,
} from "./usage.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type BudgetLevel = "green" | "amber" | "red" | "unknown";

export type BudgetThresholds = {
  /** remaining > greenMin  -> green */
  greenMin: number;
  /** remaining >= amberMin -> amber, below -> red */
  amberMin: number;
};

export type ProviderPressure = {
  id: "go" | "claude";
  label: string;
  connected: boolean;
  remainingPct?: number;
  usedPct?: number;
  resetsAt?: string;
  resetsIn?: string;
  bindingWindow?: string;
  /** real measured spend from our own per-call ledger, USD/hour (last 3 h). */
  burnPerHour?: number;
  /** measured consumption of the binding window, %/hour, from history.jsonl. */
  burnPctPerHour?: number;
  runsOutAt?: string;
  runsOutIn?: string;
  level: BudgetLevel;
  source: string;
  checkedAt: string;
  detail: string;
};

export type GoRules = {
  level: BudgetLevel;
  /** models a worker pick must not choose at this level (hard filter). */
  forbiddenModels: string[];
  /** at "red" only these are allowed. */
  cheapestModels: string[];
  /** what a forbidden pick is switched to. */
  fallbackModel: string;
  /**
   * extra cap on Fleet parallelism. ONLY set when the CEO explicitly set
   * BUDGET_FLEET_MAX_PARALLEL_AMBER / _RED; undefined = no budget cap (the
   * machine limit MAX_PARALLEL_SESSIONS is used as written).
   */
  fleetMaxParallel?: number;
  /** new non-urgent Fleet orders wait for budget instead of starting. */
  queueNonUrgent: boolean;
  note: string;
};

export type ClaudeRules = {
  level: BudgetLevel;
  /** force the assistant onto this Claude model (amber: Sonnet, red: undefined). */
  assistantModel?: string;
  /** at red the assistant runs on this Go model instead of Claude. */
  assistantGoModel?: string;
  /** roles that keep their current Claude model even at amber (plan + review). */
  keepOpusFor?: string[];
  /** roles that still use Claude even at red. */
  keepClaudeFor: string[];
  runManagerIntervalMinutes?: number;
  runManagerStuckOnly: boolean;
  briefingMinIntervalMinutes?: number;
  note: string;
};

export type BudgetRules = { go: GoRules; claude: ClaudeRules };

export type BudgetSample = { ts: string; go?: number; claude?: number };

export type BudgetSnapshot = {
  version: 1;
  checkedAt: string;
  pollS: number;
  thresholds: BudgetThresholds;
  levels: { go: BudgetLevel; claude: BudgetLevel };
  providers: { go: ProviderPressure; claude: ProviderPressure };
  binding: { provider: "go" | "claude"; level: BudgetLevel; remainingPct?: number };
  rules: BudgetRules;
  effects: string[];
  needsYou: { text: string; provider: "go" | "claude"; level: BudgetLevel } | null;
  /** the CEO's one-time INBOX grant, when one is held (informational, never spent here). */
  override?: BudgetGrant & { held: true };
  spend: {
    lastHourUsd: number;
    last24hUsd: number;
    todayUsd: number;
    byModel: Array<{ model: string; calls: number; costUsd: number }>;
  };
  samples: BudgetSample[];
  detail: string;
};

export type ModelChoice = {
  model: string;
  reason?: string;
  /** Laya/agent role, e.g. "worker" | "coder" | "assistant" | "plan" | "review". */
  role?: string;
  /** an urgent order may still queue/skip differently under red. */
  urgent?: boolean;
  /** the CEO explicitly overrode the budget rule for this one pick. */
  override?: boolean;
  /**
   * This call must be able to READ an attached file (the assistant's attachment
   * path). The filter then reports `lostFileRead` instead of silently returning a
   * model that cannot - ATTACH (llama) hit exactly this at 21:38Z.
   */
  needsFileRead?: boolean;
};

export type FilteredChoice = {
  model: string;
  original: string;
  changed: boolean;
  reason: string;
  level: BudgetLevel;
  budget: { go: BudgetLevel; claude: BudgetLevel };
  /** true when the request needed file reading and `model` cannot do it. */
  lostFileRead?: boolean;
};

// ---------------------------------------------------------------------------
// Config knobs (env-overridable, defaults are the spec's numbers)
// ---------------------------------------------------------------------------
function envNum(name: string, dflt: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : dflt;
}

/**
 * An env knob that only counts when the CEO actually SET it.
 *
 * WHY (2026-09-30, CEO order "Cap + spam"): the budget cap used to carry built-in defaults
 * (Go amber = 10, Go red = 3). Those defaults silently overrode the CEO's machine limit,
 * so `MAX_PARALLEL_SESSIONS=30` behaved as 10 and the fleet logged
 * "not spawning: 18 real terminals >= MAX_PARALLEL_SESSIONS=10" every 5 s forever.
 * A blank, unset or invalid value now means "the CEO set no budget cap" and the machine
 * limit is honoured as written. The value still shows in the snapshot's `rules.go` when set.
 */
function envNumSet(name: string): number | undefined {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function budgetThresholds(): BudgetThresholds {
  return {
    greenMin: envNum("BUDGET_GREEN_MIN", 40),
    amberMin: envNum("BUDGET_AMBER_MIN", 15),
  };
}

export function budgetPollS(): number {
  return Math.max(30, envNum("BUDGET_POLL_S", 300));
}

export function budgetOverridden(): boolean {
  const v = String(process.env.BUDGET_OVERRIDE ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// ---------------------------------------------------------------------------
// The CEO's one-time grant (INBOX, panda; company/inbox/INTEGRATION.md §8)
//
// An answered budget item in the inbox writes a single-use, time-boxed grant to
// company/inbox/budget-overrides.json. "Allowed this once" means: the guard does
// NOT downgrade or refuse the next pick it would otherwise have changed, and it
// spends the grant for exactly that pick (never for a pick that needed no change,
// so a grant is not silently burned on a no-op).
//
// The access to inbox.ts is LAZY on purpose:
//   1. inbox.ts imports THIS module (budgetNeedsYou/readBudgetState) for its
//      derived budget item, so a static import would be a cycle - resolving it at
//      first use keeps evaluation order trivial;
//   2. a broken or not-yet-installed inbox must never break the budget guard or
//      the modules that call it (fleet.ts, assistant.ts, the ops scripts);
//   3. the ops probes stay lightweight until a decision actually asks.
// ---------------------------------------------------------------------------
type InboxModule = typeof import("./inbox.js");
const requireFromHere = createRequire(import.meta.url);
let inboxModule: InboxModule | null | undefined; // undefined = not tried yet, null = unavailable

function inbox(): InboxModule | undefined {
  if (inboxModule === undefined) {
    try {
      inboxModule = requireFromHere("./inbox.js") as InboxModule;
    } catch (e) {
      console.error(`[budget] inbox module unavailable, the CEO grant is ignored: ${String(e)}`);
      inboxModule = null;
    }
  }
  return inboxModule ?? undefined;
}

export type BudgetGrant = {
  source: "inbox" | "env";
  /** the CEO's own words (or the env flag that stands in for them). */
  answer: string;
  id?: string;
  expiresAt?: string;
};

/** The grant the guard should honour right now, if any (never throws). */
export function budgetOverrideGrant(now = Date.now()): BudgetGrant | undefined {
  if (budgetOverridden()) return { source: "env", answer: "BUDGET_OVERRIDE=1 (env)" };
  const m = inbox();
  if (!m) return undefined;
  try {
    const g = m.budgetOverrideActive(now);
    if (!g) return undefined;
    return { source: "inbox", answer: String(g.answer ?? "allowed once"), id: g.id, expiresAt: g.expiresAt };
  } catch (e) {
    console.error(`[budget] could not read the CEO grant: ${String(e)}`);
    return undefined;
  }
}

/** Spend the inbox grant (env override is not spent - it is a switch, not a grant). */
function spendGrant(by: string): BudgetGrant | undefined {
  const m = inbox();
  if (!m) return undefined;
  try {
    const used = m.consumeBudgetOverride(by);
    if (!used) return undefined;
    return { source: "inbox", answer: String(used.answer ?? "allowed once"), id: used.id, expiresAt: used.expiresAt };
  } catch (e) {
    console.error(`[budget] could not spend the CEO grant: ${String(e)}`);
    return undefined;
  }
}

/** Read-only: is a CEO grant held right now (for the dashboard)? Never spends it. */
export function budgetGrantHeld(now = Date.now()): BudgetGrant | undefined {
  return budgetOverrideGrant(now);
}

/** cheapest Go models allowed at "red" - the spec names both. */
function cheapestGoModels(): string[] {
  const raw = (process.env.BUDGET_GO_CHEAP_MODELS ?? "").trim();
  const list = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : ["glm-5.3-flash", "deepseek-v4.1-flash"];
  return [...new Set(list)];
}

/** Go models disabled at "amber" (spec: "never choose Kimi or deepseek-v4-pro"). */
function forbiddenGoModels(): string[] {
  const raw = (process.env.BUDGET_GO_FORBIDDEN_MODELS ?? "").trim();
  if (raw) return [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  return ["kimi-k2.7-code", "kimi-k2.6", "kimi-k3", "deepseek-v4-pro"];
}

function goFallbackModel(): string {
  return (process.env.BUDGET_GO_FALLBACK_MODEL ?? "deepseek-v4.1-flash").trim() || "deepseek-v4.1-flash";
}

function claudeSonnet(): string {
  return (process.env.BUDGET_CLAUDE_SONNET ?? "claude-sonnet-5-5").trim() || "claude-sonnet-5-5";
}

// ---------------------------------------------------------------------------
// Levels and the rules table (the spec's table, as data)
// ---------------------------------------------------------------------------
export function levelFor(remainingPct: number | undefined, th: BudgetThresholds = budgetThresholds()): BudgetLevel {
  if (remainingPct === undefined || !Number.isFinite(remainingPct)) return "unknown";
  if (remainingPct > th.greenMin) return "green";
  if (remainingPct >= th.amberMin) return "amber";
  return "red";
}

export function rulesFor(go: BudgetLevel, claude: BudgetLevel): BudgetRules {
  const goRules: GoRules =
    go === "red"
      ? {
          level: "red",
          forbiddenModels: forbiddenGoModels(),
          cheapestModels: cheapestGoModels(),
          fallbackModel: goFallbackModel(),
          fleetMaxParallel: envNumSet("BUDGET_FLEET_MAX_PARALLEL_RED"),
          queueNonUrgent: true,
          note: "OpenCode Go is RED: only the cheapest models, new non-urgent Fleet orders wait for budget (the Fleet cap stays at the CEO's MAX_PARALLEL_SESSIONS unless BUDGET_FLEET_MAX_PARALLEL_RED is set).",
        }
      : go === "amber"
        ? {
            level: "amber",
            forbiddenModels: forbiddenGoModels(),
            cheapestModels: [],
            fallbackModel: goFallbackModel(),
            fleetMaxParallel: envNumSet("BUDGET_FLEET_MAX_PARALLEL_AMBER"),
            queueNonUrgent: false,
            note: "OpenCode Go is AMBER: Kimi and DeepSeek V4 Pro are off (the Fleet cap stays at the CEO's MAX_PARALLEL_SESSIONS unless BUDGET_FLEET_MAX_PARALLEL_AMBER is set).",
          }
        : {
            level: go === "unknown" ? "unknown" : "green",
            forbiddenModels: [],
            cheapestModels: [],
            fallbackModel: goFallbackModel(),
            queueNonUrgent: false,
            note:
              go === "unknown"
                ? "OpenCode Go remaining is not measured, so no restriction is applied (numbers missing, not assumed)."
                : "OpenCode Go is GREEN: no model restrictions.",
          };

  const claudeRules: ClaudeRules =
    claude === "red"
      ? {
          level: "red",
          assistantGoModel: goFallbackModel(),
          keepClaudeFor: ["plan", "review", "manager"],
          runManagerStuckOnly: true,
          note: "Claude is RED: the assistant runs on DeepSeek, Claude is kept only for planning and the final review, run managers do stuck-detection only. Attached files (PDFs/images) cannot be read on this run - the assistant says so instead of guessing.",
        }
      : claude === "amber"
        ? {
            level: "amber",
            assistantModel: claudeSonnet(),
            keepOpusFor: ["plan", "review", "manager"],
            keepClaudeFor: [],
            runManagerIntervalMinutes: envNum("BUDGET_RUN_MANAGER_INTERVAL_MIN_AMBER", 10),
            runManagerStuckOnly: false,
            briefingMinIntervalMinutes: envNum("BUDGET_BRIEFING_INTERVAL_MIN_AMBER", 15),
            note: "Claude is AMBER: the assistant uses Sonnet instead of Opus, run-manager checks every 10 min, the Briefing refreshes at most every 15 min.",
          }
        : {
            level: claude === "unknown" ? "unknown" : "green",
            keepClaudeFor: [],
            runManagerStuckOnly: false,
            note:
              claude === "unknown"
                ? "Claude windows are not measured, so no restriction is applied (numbers missing, not assumed)."
                : "Claude is GREEN: no restrictions.",
          };

  return { go: goRules, claude: claudeRules };
}

/** Plain-words description of what the system is doing about each level. */
export function budgetEffects(levels: { go: BudgetLevel; claude: BudgetLevel }, rules: BudgetRules): string[] {
  const out: string[] = [];
  if (rules.go.level === "amber") out.push("Kimi and DeepSeek V4 Pro are disabled because OpenCode Go is amber.");
  if (rules.go.level === "red") out.push("Only the cheapest models are used because OpenCode Go is red (new non-urgent Fleet orders wait).");
  if (rules.go.level === "unknown") out.push("OpenCode Go is not measured right now, so no model is disabled.");
  if (rules.claude.level === "amber") out.push("The assistant uses Sonnet instead of Opus; run-manager and Briefing checks are slowed down because Claude is amber.");
  if (rules.claude.level === "red") out.push("The assistant runs on DeepSeek and Claude is kept for planning/review only because Claude is red (attached PDFs/images cannot be read on this run, and the assistant says so plainly).");
  if (rules.claude.level === "unknown") out.push("Claude windows are not measured right now, so no Claude restriction is applied.");
  if (out.length === 0) out.push("Both providers are green: nothing is being restricted.");
  return out;
}

// ---------------------------------------------------------------------------
// Measured spend + burn from our own per-call ledger
// ---------------------------------------------------------------------------
export function modelProvider(model: string): "claude" | "openai" | "go" {
  const m = String(model || "");
  if (/^claude/i.test(m)) return "claude";
  if (/^(gpt|space-bunny)/i.test(m)) return "openai";
  return "go";
}

/**
 * Can this model read an attached file? Today only the Claude path can
 * (assistant.ts `canReadFiles`), so a budget downgrade AWAY from Claude loses the
 * ability to see an attachment. Callers that care pass `needsFileRead:true` and
 * check `lostFileRead` instead of guessing from the model name.
 * Env-overridable for the day another path gains the capability.
 */
export function modelCanReadFiles(model: string): boolean {
  const raw = (process.env.BUDGET_FILE_READ_MODELS ?? "").trim();
  const prefixes = raw
    ? raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    : ["claude"];
  const m = String(model ?? "").toLowerCase();
  return prefixes.some((p) => m.startsWith(p));
}

type LedgerEvent = { ts: number; model: string; costUsd: number };

let ledgerCache: { at: number; events: LedgerEvent[] } | null = null;
const LEDGER_CACHE_MS = 15_000;

export function ledgerEvents(fresh = false): LedgerEvent[] {
  if (!fresh && ledgerCache && Date.now() - ledgerCache.at < LEDGER_CACHE_MS) return ledgerCache.events;
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
      try {
        const e = JSON.parse(line) as { ts?: string; modelId?: string; model?: string; costUsd?: number };
        const ts = Date.parse(String(e.ts ?? ""));
        const cost = Number(e.costUsd ?? 0);
        if (!Number.isFinite(ts) || !Number.isFinite(cost)) continue;
        events.push({ ts, model: String(e.modelId ?? e.model ?? "unknown"), costUsd: cost });
      } catch {
        /* a malformed line is skipped, never guessed */
      }
    }
  }
  ledgerCache = { at: Date.now(), events };
  return events;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function spendWindows(now = Date.now()): {
  lastHourUsd: number;
  last24hUsd: number;
  todayUsd: number;
  byModel: Array<{ model: string; calls: number; costUsd: number }>;
  byProvider: { go: number; claude: number; openai: number };
  burnPerHour: { go: number; claude: number };
} {
  const events = ledgerEvents();
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  let lastHourUsd = 0;
  let last24hUsd = 0;
  let todayUsd = 0;
  const byModel = new Map<string, { calls: number; costUsd: number }>();
  const byProvider = { go: 0, claude: 0, openai: 0 };
  const burn = { go: 0, claude: 0 };
  const threeHoursAgo = now - 3 * 3600_000;
  for (const e of events) {
    if (now - e.ts <= 3600_000) lastHourUsd += e.costUsd;
    if (now - e.ts <= 24 * 3600_000) last24hUsd += e.costUsd;
    if (e.ts >= midnight.getTime()) todayUsd += e.costUsd;
    const agg = byModel.get(e.model) ?? { calls: 0, costUsd: 0 };
    agg.calls += 1;
    agg.costUsd += e.costUsd;
    byModel.set(e.model, agg);
    const p = modelProvider(e.model);
    byProvider[p] += e.costUsd;
    if (e.ts >= threeHoursAgo) {
      if (p === "claude") burn.claude += e.costUsd;
      else if (p === "go") burn.go += e.costUsd;
    }
  }
  return {
    lastHourUsd: round6(lastHourUsd),
    last24hUsd: round6(last24hUsd),
    todayUsd: round6(todayUsd),
    byModel: [...byModel.entries()]
      .map(([model, v]) => ({ model, calls: v.calls, costUsd: round6(v.costUsd) }))
      .sort((a, b) => b.costUsd - a.costUsd),
    byProvider: { go: round6(byProvider.go), claude: round6(byProvider.claude), openai: round6(byProvider.openai) },
    burnPerHour: { go: round6(burn.go / 3), claude: round6(burn.claude / 3) },
  };
}

// ---------------------------------------------------------------------------
// history.jsonl: the 24 h sparkline and the "%/hour" slope
// ---------------------------------------------------------------------------
function budgetDir(): string {
  return path.join(getCompanyRoot(), "budget");
}
export function budgetStatePath(): string {
  return path.join(budgetDir(), "state.json");
}
export function budgetHistoryPath(): string {
  return path.join(budgetDir(), "history.jsonl");
}

export function readHistory(maxLines = 400): BudgetSample[] {
  let text: string;
  try {
    text = fs.readFileSync(budgetHistoryPath(), "utf8");
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const tail = lines.slice(-maxLines);
  const out: BudgetSample[] = [];
  for (const line of tail) {
    try {
      const s = JSON.parse(line) as BudgetSample;
      if (s && s.ts) out.push({ ts: String(s.ts), go: numOrUndef(s.go), claude: numOrUndef(s.claude) });
    } catch {
      /* skip */
    }
  }
  return out;
}

function numOrUndef(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Linear slope of "remaining %" per hour over the samples, for one provider. */
export function remainingSlopePerHour(samples: BudgetSample[], key: "go" | "claude"): number | undefined {
  const pts = samples
    .map((s) => ({ t: Date.parse(s.ts), v: s[key] }))
    .filter((p): p is { t: number; v: number } => Number.isFinite(p.t) && typeof p.v === "number");
  if (pts.length < 3) return undefined;
  const now = Date.now();
  const recent = pts.filter((p) => now - p.t <= 6 * 3600_000);
  const use = recent.length >= 3 ? recent : pts.slice(-3);
  const first = use[0]!;
  const last = use[use.length - 1]!;
  const hours = (last.t - first.t) / 3600_000;
  if (hours < 0.15) return undefined;
  const slope = (last.v - first.v) / hours; // %/hour; negative means it is draining
  return Math.round(slope * 1000) / 1000;
}

function addHours(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function projectRunOut(
  remainingPct: number | undefined,
  resetsAt: string | undefined,
  slope: number | undefined,
): { runsOutAt?: string; runsOutIn?: string; burnPctPerHour?: number } {
  if (remainingPct === undefined || slope === undefined || slope >= -0.01) return { burnPctPerHour: slope };
  const perHour = -slope;
  const hoursLeft = remainingPct / perHour;
  const msLeft = hoursLeft * 3600_000;
  const resetMs = resetsAt ? Date.parse(resetsAt) - Date.now() : NaN;
  if (Number.isFinite(resetMs) && resetMs > 0 && resetMs <= msLeft) {
    // The window refills before it would run out.
    return { burnPctPerHour: perHour };
  }
  const at = addHours(msLeft);
  return { runsOutAt: at, runsOutIn: humanizeUntil(at), burnPctPerHour: round6(perHour) };
}

// ---------------------------------------------------------------------------
// budgetPressure(): the spec's per-provider row
// ---------------------------------------------------------------------------
export type BudgetPressureReport = {
  checkedAt: string;
  thresholds: BudgetThresholds;
  providers: ProviderPressure[];
};

function goPressure(go: GoQuota, spend: ReturnType<typeof spendWindows>, slope: number | undefined): ProviderPressure {
  const level = levelFor(go.remainingPct);
  const proj = projectRunOut(go.remainingPct, go.resetsAt, slope);
  const parts: string[] = [];
  if (go.connected) {
    parts.push(`OpenCode Go: ${go.remainingPct}% left on the binding ${go.bindingWindow ?? "window"}`);
    for (const w of go.windows) parts.push(`${w.window} ${w.remainingPct}% left${w.resetsIn ? ` (resets in ${w.resetsIn})` : ""}`);
    parts.push(`source: ${go.source === "api" ? "Go API key (read-only)" : "console session cookie (read-only)"}`);
  } else {
    parts.push(go.detail);
  }
  return {
    id: "go",
    label: "OpenCode Go",
    connected: go.connected,
    remainingPct: go.remainingPct,
    usedPct: go.usedPct,
    resetsAt: go.resetsAt,
    resetsIn: humanizeUntil(go.resetsAt),
    bindingWindow: go.bindingWindow,
    burnPerHour: spend.burnPerHour.go,
    burnPctPerHour: proj.burnPctPerHour,
    runsOutAt: proj.runsOutAt,
    runsOutIn: proj.runsOutIn,
    level,
    source: go.connected ? (go.source === "api" ? "opencode-go-api" : "opencode-console-cookie") : "unavailable",
    checkedAt: go.checkedAt,
    detail: parts.join("; ") + `; measured local burn $${spend.burnPerHour.go.toFixed(4)}/h.`,
  };
}

function claudePressure(
  claude: ClaudeQuota,
  spend: ReturnType<typeof spendWindows>,
  slope: number | undefined,
): ProviderPressure {
  const level = levelFor(claude.remainingPct);
  const proj = projectRunOut(claude.remainingPct, claude.resetsAt, slope);
  const parts: string[] = [];
  if (claude.connected) {
    parts.push(planLabel(claude.plan));
    for (const w of claude.windows) {
      parts.push(
        w.usedPct === undefined
          ? `${w.label}: (no percentage reported)`
          : `${w.label} ${w.remainingPct}% left (${w.usedPct}% used${w.resetsIn ? `, resets in ${w.resetsIn}` : ""})`,
      );
    }
    parts.push("source: jcode usage --json (CLI, cached 2 min)");
  } else {
    parts.push(claude.detail);
  }
  return {
    id: "claude",
    label: "Claude",
    connected: claude.connected,
    remainingPct: claude.remainingPct,
    usedPct: claude.usedPct,
    resetsAt: claude.resetsAt,
    resetsIn: claude.resetIn ?? humanizeUntil(claude.resetsAt),
    bindingWindow: claude.bindingWindow,
    burnPerHour: spend.burnPerHour.claude,
    burnPctPerHour: proj.burnPctPerHour,
    runsOutAt: proj.runsOutAt,
    runsOutIn: proj.runsOutIn,
    level,
    source: claude.connected ? "jcode-usage-cli" : "unavailable",
    checkedAt: claude.checkedAt,
    detail: parts.join("; ") + `; measured local burn $${spend.burnPerHour.claude.toFixed(4)}/h.`,
  };
}

function planLabel(plan?: string): string {
  return plan ? `Claude subscription (${plan})` : "Claude subscription";
}

export function bindingOf(levels: { go: BudgetLevel; claude: BudgetLevel }, providers: ProviderPressure[]): BudgetSnapshot["binding"] {
  const rank: Record<BudgetLevel, number> = { unknown: 3, green: 0, amber: 1, red: 2 };
  const ordered: Array<"go" | "claude"> = rank[levels.go] >= rank[levels.claude] ? ["go", "claude"] : ["claude", "go"];
  const id = ordered[0]!;
  const p = providers.find((x) => x.id === id);
  return { provider: id, level: levels[id], remainingPct: p?.remainingPct };
}

/**
 * One honest row per provider: remaining %, reset, measured burn, projected
 * run-out, and the green/amber/red level. Never throws; an unreadable source is
 * reported as "unavailable"/"unknown" with the reason.
 */
export async function budgetPressure(opts?: { fresh?: boolean; now?: number }): Promise<BudgetPressureReport> {
  const checkedAt = new Date(opts?.now ?? Date.now()).toISOString();
  const thresholds = budgetThresholds();
  const [go, claude] = await Promise.all([
    openCodeGoUsage({ fresh: opts?.fresh }),
    readClaudeQuota({ fresh: opts?.fresh }),
  ]);
  const spend = spendWindows(opts?.now ?? Date.now());
  const samples = readHistory();
  const goP = goPressure(go, spend, remainingSlopePerHour(samples, "go"));
  const claudeP = claudePressure(claude, spend, remainingSlopePerHour(samples, "claude"));
  return { checkedAt, thresholds, providers: [goP, claudeP] };
}

// ---------------------------------------------------------------------------
// Snapshot: in-memory (watcher) -> state.json -> sync cache
// ---------------------------------------------------------------------------
let liveSnapshot: BudgetSnapshot | null = null;
let diskCache: { at: number; data: BudgetSnapshot | null } | null = null;
const DISK_CACHE_MS = 5_000;

export async function buildSnapshot(opts?: { fresh?: boolean; now?: number }): Promise<BudgetSnapshot> {
  const report = await budgetPressure(opts);
  const go = report.providers.find((p) => p.id === "go")!;
  const claude = report.providers.find((p) => p.id === "claude")!;
  const levels = { go: go.level, claude: claude.level };
  const rules = rulesFor(levels.go, levels.claude);
  const effects = budgetEffects(levels, rules);
  // A held CEO grant is shown to the CEO, never spent by a status read.
  const grant = budgetGrantHeld();
  if (grant) {
    effects.push(
      `The CEO allowed one overridden decision (${grant.answer})` +
        `${grant.expiresAt ? `, valid until ${grant.expiresAt}` : ""}: the next pick the guard would have changed keeps its model, and this one is spent then.`,
    );
  }
  const spend = spendWindows(opts?.now ?? Date.now());

  const prev = liveSnapshot ?? readBudgetStateFile();
  const sample: BudgetSample = {
    ts: new Date(opts?.now ?? Date.now()).toISOString(),
    go: go.remainingPct,
    claude: claude.remainingPct,
  };
  // 24 h of samples maximum (~288 at the default 300 s poll), oldest dropped.
  const cutoff = Date.now() - 24 * 3600_000;
  const samples = [...(prev?.samples ?? readHistory()), sample].filter((s) => Date.parse(s.ts) >= cutoff).slice(-400);

  const red = levels.go === "red" || levels.claude === "red";
  const needsYou = red
    ? {
        text:
          levels.go === "red"
            ? `OpenCode Go is nearly out (${go.remainingPct}% left) - work is being restricted to the cheapest models.`
            : `Claude is nearly out (${claude.remainingPct}% left on the ${claude.bindingWindow ?? "5-hour"}) - Claude work is being cut back.`,
        provider: levels.go === "red" ? ("go" as const) : ("claude" as const),
        level: "red" as const,
      }
    : null;

  return {
    version: 1,
    checkedAt: report.checkedAt,
    pollS: budgetPollS(),
    thresholds: report.thresholds,
    levels,
    providers: { go, claude },
    binding: bindingOf(levels, report.providers),
    rules,
    effects,
    needsYou,
    ...(grant ? { override: { ...grant, held: true as const } } : {}),
    spend: {
      lastHourUsd: spend.lastHourUsd,
      last24hUsd: spend.last24hUsd,
      todayUsd: spend.todayUsd,
      byModel: spend.byModel,
    },
    samples,
    detail: `${go.detail} | ${claude.detail}`,
  };
}

/** Refresh once and persist state.json + one history.jsonl line. */
export async function refreshBudgetState(opts?: { fresh?: boolean }): Promise<BudgetSnapshot> {
  const snap = await buildSnapshot(opts);
  try {
    fs.mkdirSync(budgetDir(), { recursive: true });
    fs.writeFileSync(budgetStatePath(), JSON.stringify(snap, null, 2));
    const line = JSON.stringify({ ts: snap.checkedAt, go: snap.providers.go.remainingPct, claude: snap.providers.claude.remainingPct });
    fs.appendFileSync(budgetHistoryPath(), line + "\n");
    trimHistory();
  } catch (e) {
    console.error(`[budget] could not persist budget state: ${String(e)}`);
  }
  liveSnapshot = snap;
  diskCache = { at: Date.now(), data: snap };
  return snap;
}

const HISTORY_MAX_LINES = 2880; // ~10 days at 300 s; the snapshot keeps its own 24 h window

function trimHistory(): void {
  try {
    const text = fs.readFileSync(budgetHistoryPath(), "utf8");
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length <= HISTORY_MAX_LINES) return;
    fs.writeFileSync(budgetHistoryPath(), lines.slice(-HISTORY_MAX_LINES).join("\n") + "\n");
  } catch {
    /* not fatal: history is a convenience, not a source of truth */
  }
}

function readBudgetStateFile(): BudgetSnapshot | null {
  try {
    const raw = fs.readFileSync(budgetStatePath(), "utf8");
    const parsed = JSON.parse(raw) as BudgetSnapshot;
    return parsed && parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Synchronous snapshot for callers that cannot await (Laya's state, model
 * filters): the watcher's live value, else state.json (cached 5 s). Returns
 * undefined when nothing has been measured yet - callers then apply NO rule.
 */
export function readBudgetState(): BudgetSnapshot | undefined {
  if (liveSnapshot) return liveSnapshot;
  if (diskCache && Date.now() - diskCache.at < DISK_CACHE_MS) return diskCache.data ?? undefined;
  const data = readBudgetStateFile();
  diskCache = { at: Date.now(), data };
  return data ?? undefined;
}

/** Test seam: drop the in-memory/disk caches (used by ops/budget-selftest.ts). */
export function resetBudgetCache(): void {
  liveSnapshot = null;
  diskCache = null;
}

// ---------------------------------------------------------------------------
// The HARD FILTER (runs AFTER Laya; the spec: "the guard rules apply AFTER
// Laya, as a hard filter ... and the reason is recorded")
// ---------------------------------------------------------------------------
export function layaBudgetState(snapshot?: BudgetSnapshot): { go: BudgetLevel; claude: BudgetLevel } {
  const s = snapshot ?? readBudgetState();
  return { go: s?.levels.go ?? "unknown", claude: s?.levels.claude ?? "unknown" };
}

/** One plain sentence about cost, for Laya's choice descriptions. */
export function budgetCostNote(snapshot?: BudgetSnapshot): string {
  const s = snapshot ?? readSnapshotForRules();
  const st = layaBudgetState(s);
  if (!s || (st.go === "unknown" && st.claude === "unknown")) {
    return "Budget: not measured yet (no provider numbers), so cost rules are not applied.";
  }
  const bits: string[] = [];
  bits.push(`OpenCode Go ${st.go}${s.providers.go.remainingPct !== undefined ? ` (${s.providers.go.remainingPct}% left)` : ""}`);
  bits.push(`Claude ${st.claude}${s.providers.claude.remainingPct !== undefined ? ` (${s.providers.claude.remainingPct}% left)` : ""}`);
  if (s.rules.go.level === "amber") bits.push("Kimi and DeepSeek V4 Pro are disabled by the budget guard");
  if (s.rules.go.level === "red") bits.push("only the cheapest models are allowed");
  if (s.rules.claude.level === "amber") bits.push("the assistant must use Sonnet, not Opus");
  if (s.rules.claude.level === "red") bits.push("Claude is reserved for planning and the final review");
  return `Budget: ${bits.join("; ")}.`;
}

function readSnapshotForRules(): BudgetSnapshot | undefined {
  return readBudgetState();
}

/**
 * The budget guard's hard filter. Applied AFTER Laya has chosen, so the pick and
 * the reason both stay visible. Order of precedence:
 *   1. `{override:true}` / `BUDGET_OVERRIDE=1` (the switch, never spent);
 *   2. the CEO's one-time INBOX grant (spent on the pick it rescues);
 *   3. the level rules below.
 *
 *   - Go red:  only the cheapest models (glm-5.3-flash / deepseek-v4.1-flash).
 *   - Go amber: Kimi and DeepSeek V4 Pro become deepseek-v4.1-flash.
 *   - Claude red: Claude work moves to DeepSeek, EXCEPT the roles in
 *     rules.claude.keepClaudeFor (plan + final review).
 *   - Claude amber: an Opus ASSISTANT pick becomes claude-sonnet-5-5; the roles
 *     Claude is kept for (rules.claude.keepOpusFor) keep Opus.
 *   - No measurement (unknown): nothing changes.
 */
export function applyBudgetFilter(choice: ModelChoice, snapshot?: BudgetSnapshot): FilteredChoice {
  return filterCore(choice, snapshot ?? readBudgetState(), false);
}

function filterCore(choice: ModelChoice, s: BudgetSnapshot | undefined, ignoreGrant: boolean): FilteredChoice {
  const levels = { go: s?.levels.go ?? "unknown", claude: s?.levels.claude ?? "unknown" };
  const model = String(choice.model ?? "");
  const roll: FilteredChoice["budget"] = levels;
  const role = String(choice.role ?? "worker").toLowerCase();
  const done = (next: string, reason: string): FilteredChoice => {
    const lostFileRead = choice.needsFileRead === true && !modelCanReadFiles(next);
    return {
      model: next,
      original: model,
      changed: next !== model,
      reason:
        (reason || choice.reason || "budget: no change needed") +
        (lostFileRead
          ? " [this call needs a model that can read attached files and " +
            `${next} cannot, so the attachment must be reported as unreadable]`
          : ""),
      level: bindingLevel(levels),
      budget: roll,
      ...(lostFileRead ? { lostFileRead: true } : {}),
    };
  };

  if (choice.override === true) {
    return done(model, "caller override: the budget rule did not apply to this pick.");
  }
  if (!ignoreGrant) {
    const grant = budgetOverrideGrant();
    if (grant) {
      // "Allowed this once": if the guard WOULD have changed or refused this pick,
      // keep the CEO's pick and spend the grant for exactly this decision. A pick
      // that needed no change does not burn the grant.
      const without = filterCore(choice, s, true);
      if (without.changed) {
        const spent = grant.source === "inbox" ? spendGrant("applyBudgetFilter") : grant;
        return done(
          model,
          `CEO allowed this once (${spent?.answer ?? grant.answer}): kept ${model} instead of ${without.model}` +
            `${grant.id ? ` [grant ${grant.id} spent]` : ""}.`,
        );
      }
      return done(model, `no change needed (an unused CEO grant is still held: ${grant.answer}).`);
    }
  }
  if (!s) {
    return done(model, "no budget measurement yet, so no rule was applied.");
  }

  const rules = s.rules;
  const provider = modelProvider(model);

  if (provider === "claude") {
    const keep = rules.claude.keepClaudeFor.map((r) => r.toLowerCase());
    if (keep.includes(role)) {
      return done(model, `Claude kept for role "${role}" (allowed even at ${rules.claude.level}).`);
    }
    if (rules.claude.level === "red" && rules.claude.assistantGoModel) {
      return done(rules.claude.assistantGoModel, `Claude red -> ${rules.claude.assistantGoModel} (Claude only for ${keep.join("/")}).`);
    }
    if (rules.claude.level === "amber" && rules.claude.assistantModel && /opus/i.test(model)) {
      // The spec downgrades the ASSISTANT (Opus -> Sonnet). Planning and the
      // final review are the roles Claude is kept for, so they keep Opus.
      const keepOpus = (rules.claude.keepOpusFor ?? []).map((r) => r.toLowerCase());
      if (keepOpus.includes(role)) {
        return done(model, `Claude amber: role "${role}" keeps ${model} (only the assistant downgrades).`);
      }
      return done(rules.claude.assistantModel, `Claude amber -> ${rules.claude.assistantModel} instead of Opus.`);
    }
    return done(model, `Claude ${rules.claude.level}: no change for this role.`);
  }

  if (provider === "openai") {
    return done(model, "not a Claude/Go model: the budget guard does not steer it.");
  }

  if (rules.go.level === "red") {
    if (rules.go.cheapestModels.includes(model)) {
      return done(model, `OpenCode Go red: ${model} is on the cheapest list, allowed.`);
    }
    const picked = rules.go.cheapestModels[0] ?? rules.go.fallbackModel;
    return done(picked, `OpenCode Go red -> only cheapest models are allowed (${rules.go.cheapestModels.join(" / ")}); ${model} was replaced by ${picked}.`);
  }
  if (rules.go.level === "amber" && rules.go.forbiddenModels.includes(model)) {
    return done(rules.go.fallbackModel, `OpenCode Go amber -> ${model} is disabled; replaced by ${rules.go.fallbackModel}.`);
  }
  return done(model, `OpenCode Go ${rules.go.level}: no change.`);
}

function bindingLevel(levels: { go: BudgetLevel; claude: BudgetLevel }): BudgetLevel {
  const rank: Record<BudgetLevel, number> = { unknown: 3, green: 0, amber: 1, red: 2 };
  return rank[levels.go] >= rank[levels.claude] ? levels.go : levels.claude;
}

/** The last clamp reason we logged, so the same reason is never logged twice in a row. */
let clampNotice = "";

// ---------------------------------------------------------------------------
// Call sites for the other owners (small, exact, safe to call)
// ---------------------------------------------------------------------------

/**
 * Fleet: clamp the manager's parallelism by the current Go level.
 *
 * The cap is applied ONLY when the CEO explicitly set BUDGET_FLEET_MAX_PARALLEL_AMBER / _RED
 * (the snapshot carries `rules.go.fleetMaxParallel` then). Without that env knob the CEO's
 * MAX_PARALLEL_SESSIONS is returned unchanged: the old built-in amber=10 / red=3 defaults
 * silently cut a `MAX_PARALLEL_SESSIONS=30` box down to 10 and stopped the fleet from ever
 * spawning. When a cap IS applied the reason is logged once per state change, not per tick.
 */
export function fleetMaxParallel(defaultMax: number, snapshot?: BudgetSnapshot): number {
  const s = snapshot ?? readBudgetState();
  const cap = s?.rules.go.fleetMaxParallel;
  if (!cap || !Number.isFinite(cap) || cap <= 0) return defaultMax;
  const effective = Math.max(1, Math.min(defaultMax, cap));
  const level = s?.rules.go.level ?? "unknown";
  const reason = `CEO-set budget cap: OpenCode Go ${level} -> Fleet parallelism ${effective} (MAX_PARALLEL_SESSIONS=${defaultMax})`;
  if (clampNotice !== reason) {
    clampNotice = reason;
    console.warn(`[budget] ${reason}`);
  }
  return effective;
}

/** The one-line reason the last clamp was applied for (the ops check reads it). */
export function fleetMaxParallelNotice(): string {
  return clampNotice;
}

/** Test seam: forget the last clamp notice (so a check can prove "logged once"). */
export function resetFleetCapNotice(): void {
  clampNotice = "";
}

/** Fleet: should a NEW order wait for budget instead of starting now? */
export function fleetQueueForBudget(urgent: boolean, snapshot?: BudgetSnapshot): { queue: boolean; reason: string } {
  const s = snapshot ?? readBudgetState();
  if (!s) return { queue: false, reason: "budget not measured" };
  if (budgetOverridden()) return { queue: false, reason: "CEO override (BUDGET_OVERRIDE)" };
  const wouldQueue = s.rules.go.queueNonUrgent && !urgent;
  if (wouldQueue) {
    // Refusing to start an order is a "refuse" the CEO's one-time grant covers,
    // and it is a single decision, so the grant is spent here.
    const grant = budgetOverrideGrant();
    if (grant) {
      const spent = grant.source === "inbox" ? spendGrant("fleetQueueForBudget") : grant;
      return {
        queue: false,
        reason: `CEO allowed this once (${spent?.answer ?? grant.answer}): this non-urgent order may start even though OpenCode Go is red.`,
      };
    }
    return {
      queue: true,
      reason: `waiting for budget: OpenCode Go is red (${s.providers.go.remainingPct ?? "?"}% left) and this order is not urgent`,
    };
  }
  const held = budgetGrantHeld();
  return { queue: false, reason: `OpenCode Go ${s.rules.go.level}${held ? " (a CEO grant is held)" : ""}` };
}

/** Run managers: the check interval in seconds (Claude amber slows it down). */
export function runManagerIntervalS(defaultS: number, snapshot?: BudgetSnapshot): number {
  const s = snapshot ?? readBudgetState();
  const minutes = s?.rules.claude.runManagerIntervalMinutes;
  if (!minutes || !Number.isFinite(minutes)) return defaultS;
  return Math.max(defaultS, minutes * 60);
}

/** Run managers: at Claude red, only stuck detection runs (no Claude calls). */
export function runManagerStuckOnly(snapshot?: BudgetSnapshot): boolean {
  const s = snapshot ?? readBudgetState();
  if (budgetOverridden()) return false;
  // Deliberately NOT grant-aware: a cadence/interval getter is not the single
  // "pick" a one-time grant is for, and honouring it here would keep full Claude
  // checks running for the grant's whole window (up to INBOX_BUDGET_OVERRIDE_MINUTES)
  // or spend the CEO's grant on background housekeeping. See INBOX §8.
  return !!s?.rules.claude.runManagerStuckOnly;
}

/** Briefing: its minimum Claude-refresh interval in seconds. */
export function briefingMinIntervalS(defaultS: number, snapshot?: BudgetSnapshot): number {
  const s = snapshot ?? readBudgetState();
  const minutes = s?.rules.claude.briefingMinIntervalMinutes;
  if (!minutes || !Number.isFinite(minutes)) return defaultS;
  return Math.max(defaultS, minutes * 60);
}

/** The assistant's model for this call, after the Claude rules. */
export function assistantModelFor(defaultModel: string, role = "assistant", snapshot?: BudgetSnapshot): string {
  const filtered = applyBudgetFilter({ model: defaultModel, role }, snapshot);
  return filtered.model;
}

/** A "Needs you" briefing item while anything is red (undefined when all green). */
export function budgetNeedsYou(snapshot?: BudgetSnapshot): BudgetSnapshot["needsYou"] {
  const s = snapshot ?? readBudgetState();
  return s?.needsYou ?? null;
}

// ---------------------------------------------------------------------------
// The guarded background poller
// ---------------------------------------------------------------------------
type WatcherState = {
  running: boolean;
  startedAt?: string;
  lastRun?: string;
  lastError?: string;
  lastMs?: number;
  runs: number;
  pollS: number;
  timer?: NodeJS.Timeout;
};
const watcher: WatcherState = { running: false, runs: 0, pollS: budgetPollS() };

export function startBudgetWatcher(opts?: { pollS?: number; immediate?: boolean }): { pollS: number; stop: () => void } {
  const pollS = Math.max(30, opts?.pollS ?? budgetPollS());
  watcher.pollS = pollS;
  if (watcher.running) return { pollS, stop: stopBudgetWatcher };
  watcher.running = true;
  watcher.startedAt = new Date().toISOString();

  const tick = async () => {
    if (tickInFlight) return; // never overlap: one pass at a time
    tickInFlight = true;
    const started = Date.now();
    try {
      await refreshBudgetState();
      watcher.lastRun = new Date().toISOString();
      watcher.lastError = undefined;
    } catch (e) {
      watcher.lastError = String((e as Error)?.message ?? e);
      console.error(`[budget] poll failed: ${watcher.lastError}`);
    } finally {
      watcher.runs += 1;
      watcher.lastMs = Date.now() - started;
      tickInFlight = false;
    }
  };

  if (opts?.immediate !== false) void tick();
  // unref'd: a background poller must never keep the process alive (and it is
  // deliberately serial + async so it can never block the event loop).
  watcher.timer = setInterval(() => void tick(), pollS * 1000);
  watcher.timer.unref?.();
  return { pollS, stop: stopBudgetWatcher };
}

let tickInFlight = false;

export function stopBudgetWatcher(): void {
  if (watcher.timer) clearInterval(watcher.timer);
  watcher.timer = undefined;
  watcher.running = false;
}

export function budgetStatus(): {
  running: boolean;
  pollS: number;
  runs: number;
  startedAt?: string;
  lastRun?: string;
  lastError?: string;
  lastMs?: number;
  checkedAt?: string;
  levels?: { go: BudgetLevel; claude: BudgetLevel };
} {
  const s = readBudgetState();
  return {
    running: watcher.running,
    pollS: watcher.pollS,
    runs: watcher.runs,
    startedAt: watcher.startedAt,
    lastRun: watcher.lastRun,
    lastError: watcher.lastError,
    lastMs: watcher.lastMs,
    checkedAt: s?.checkedAt,
    levels: s?.levels,
  };
}
