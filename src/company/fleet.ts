import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "../config.js";
import { getCompanyRoot } from "./org.js";
import { callClaudeSubscription } from "../claudeSubscription.js";
// CHEAP BY DEFAULT (docs/CHEAP_BY_DEFAULT_SPEC.md Job 2): the fleet asks the gate before it
// spends a planner call, so a small order is served by ONE locally built work order instead.
import { pickBrain, noteCheapFailure, clearCheapFailures } from "./brainRouter.js";
import { callGatewayModel } from "../gateway.js";
// The plain "sign-in expired" sentence, shared with the run cards and the briefing.
import { CLAUDE_SIGNIN_EXPIRED_MESSAGE, mentionsClaudeSignInExpired } from "./claudeSignIn.js";
import type { TraceStep } from "./gates.js";
// Budget pressure (docs/BUDGET_SPEC.md §2, integration requested by BUDGET/otter): a hard
// filter AFTER Laya, a parallelism cap, and a queue for new non-urgent orders under red.
// All three are sync, do no I/O (5 s cached state) and are no-ops while nothing is measured.
import { applyBudgetFilter, fleetMaxParallel, fleetQueueForBudget } from "./budgetGuard.js";
// DEEPSEEK DIRECT (docs/DEEPSEEK_DIRECT.md, CEO order 2026-10-01): during DeepSeek's
// off-peak window a work order whose model is a DeepSeek model is launched on DeepSeek's
// OWN provider (half price, its own credit) so it never spends the Go weekly quota.
import {
  deepseekDirectModel, deepseekDirectPlan, deepseekOnlyModel, deepseekProvider,
  fleetDeepseekOnlyArmed, fleetDirectReady, isDeepseekModel,
  type DeepseekDirectPlan,
} from "./deepseekDirect.js";
// The shared, LAYA-TUNE-calibrated worker-model question (noul-based; 24% -> 59-86% gated accuracy
// per docs/LAYA_TUNING.md). The fleet no longer asks its own 3-way choice question: it asks THIS
// and then applies the CEO's cost rule on top (see pickFleetModel).
import { chooseWorkerModel } from "./dispatch.js";
// Attribution only (fix 3 of the 2026-10-01 event-loop order): labels a BLOCK with the code
// that held the loop instead of "idle". No behaviour change.
import { withBusyAsync } from "./loopWatchdog.js";
// GH-2 (docs/GITHUB_INTEGRATION_SPEC.md): optional GitHub PR publication for PASSed work
// orders plus the CI-red downgrade. Off by default (FLEET_GITHUB unset => every call is a no-op).
import { publishWorkOrder, applyCiDowngrade } from "./fleetGithub.js";

// ── FLEET ──────────────────────────────────────────────────────────────
// "Claude manages, jcode executes": the CEO types an order, Claude (manager)
// splits it into parallel work orders, the CEO approves, and one VISIBLE jcode
// terminal is opened per work order. Each worker finishes by writing
// company/fleet/<orderId>/<workOrderId>/REPORT.md, Claude reviews it (PASS/REDO),
// and the order settles when every work order passes.
//
// Spec: docs/FLEET_SPEC.md. State: company/fleet/orders.json.
//
// Two rules this module exists to honour:
//  1. NEVER write into %USERPROFILE%\.jcode (read-only). All session state we
//     need (journal, streaming_pids, client_sessions) is read, never written.
//  2. Delivery into a specific worker session is TARGETED
//     (`jcode transcript --mode send -S <sessionId>`), not focus-based. The old
//     focus method is kept only as a fallback, because it can drop an order into
//     the wrong window when the CEO clicks another jcode window mid-spawn.

export type WorkOrderState =
  | "planned" | "queued" | "starting" | "working" | "idle" | "reported" | "reviewed" | "failed"
  /** The reviewer's reply carried no parseable verdict twice; the work order waits on the
   *  manager (an INBOX question), NOT on a made-up REDO. See reviewWorkOrder. */
  | "needs_manager";

export type WorkOrder = {
  id: string;
  title: string;
  role: string;
  /** project (org record) this work belongs to, when the plan names one; used
   *  for the per-project team model override in chooseWorkerModel */
  projectId?: string;
  owns: string[];
  brief: string;
  done: string[];
  state: WorkOrderState;
  sessionId?: string;
  windowPid?: number;
  startedAt?: string;
  reportedAt?: string;
  verdict?: "PASS" | "REDO";
  review?: string;
  attempts: number;
  error?: string;
  /** how many times Claude's review has been attempted for this work order's current report */
  reviewAttempts?: number;
  // ── GH-2 GitHub PR flow (docs/GITHUB_INTEGRATION_SPEC.md) ─────────────
  /** the draft PR opened for this work order's PASS (only when FLEET_GITHUB is on) */
  prUrl?: string;
  /** the branch the draft PR was opened from */
  branch?: string;
  /** set once a red CI check has downgraded this PASS to REDO, so it only happens once */
  ciDowngraded?: boolean;
  // ── Laya's model pick (docs/LAYA_FIX_SPEC.md Fix 1) ──────────────────
  /** the jcode model this worker was spawned with (`jcode -p <provider> -m <model>`) */
  model?: string;
  /** why that model: Laya's answer, or which rule chose it */
  modelReason?: string;
  /** who decided: "laya" (above the confidence guard) or "rules" (guard/fallback) */
  modelSource?: "laya" | "rules";
  /** Laya's `confidence` for the model question (1 - H/log k, per src/decision.ts) */
  layaConfidence?: number;
  /** Laya's `answer_confidence` for the model question (probability of the chosen option) */
  layaAnswerConfidence?: number;
  /** Laya's top probability minus the runner-up (the second half of the guard) */
  layaLead?: number;
  /** when the last review attempt ran, so retries are spaced out instead of burning in seconds */
  lastReviewAttemptAt?: string;
  /** the model the session's own journal reports, for the "did it really run kimi?" check */
  sessionModel?: string;
  /** result of driving the session's model through the jcode debug socket (F1) */
  modelSwitch?: { ok: boolean; at: string; detail: string };
  // Delivery bookkeeping (not in the spec's type, purely diagnostic).
  delivery?: { how: "targeted" | "focused" | "none"; at: string; detail: string };
};

export type FleetOrder = {
  id: string;
  text: string;
  createdAt: string;
  updatedAt: string;
  status: "planning" | "awaiting_approval" | "running" | "reviewing" | "done" | "failed" | "cancelled";
  plan?: string;
  specDoc?: string;
  /** org project this order belongs to, when the caller knows it (optional). */
  projectId?: string;
  workOrders: WorkOrder[];
  trace: TraceStep[];
  error?: string;
  summary?: string;
  // ── restart resilience (docs/RESUME_SPEC.md 1) + shutdown (docs/SHUTDOWN_SPEC.md) ──
  /** pid of the process planning this order; a dead pid at boot means "resume planning" */
  plannerPid?: number;
  /** how many times planning has been started; 3 in a row without success -> failed */
  planAttempts?: number;
  /** set by the SHUTDOWN lifecycle before a planned shutdown; cleared by resumeAfterShutdown() */
  pausedByShutdown?: boolean;
  /** when the router last resumed this order after a restart */
  resumedAt?: string;
  // ── NY-RESOLVER additive wiring (docs/NEEDS_YOU_SPEC.md) ───────────────
  /** Force the planner/reviewer to a specific provider. */
  forceProvider?: "kimi" | "claude";
  /** Set when a new order replaces this one (retry/reissue). */
  supersededBy?: string;
  // ── DUPLICATE-PROMPTS (docs/NEEDS_YOU_RULE_SPEC.md §1) ─────────────────
  /** Set when the order is closed so it stops raising a "needs you" prompt. */
  closedAs?: "superseded" | "dropped";
  /** Order ids this order replaces (a later finished order may name older copies). */
  supersedes?: string[];
  closedReason?: string;
  closedAt?: string;
  closedBy?: string;
  // ── RETRY LOOP (2026-09-30) ────────────────────────────────────────────
  /** How many times this job has been re-issued (0/absent = the first attempt). Written
   *  by the resolver on retry so the cap survives across copies and restarts. */
  retryCount?: number;
  /** The order this copy was re-issued from (the resolver's retry). */
  retriedFrom?: string;
  /** When the resolver refused to mint another copy because the retry cap was reached. */
  retryExhaustedAt?: string;
  /** Why this order failed, as a stable short signature (needsYouRule.orderFailureCause). */
  failureCause?: string;
};

// ── knobs ─────────────────────────────────────────────────────────────

function envNum(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}
function envStr(name: string, fallback: string): string {
  const raw = (process.env[name] ?? "").trim();
  return raw || fallback;
}

// CHEAP BY DEFAULT (docs/CHEAP_BY_DEFAULT_SPEC.md Job 2): these name the MAX tier handed to the
// brainRouter gate, not the model that will run. The default is Sonnet, not Opus, so a fresh
// install cannot ask for the top tier by accident; Opus stays reachable only through the gate's
// own rules (the CEO naming it, a failed/stuck plan, a 2nd REDO on a review).
const plannerModel = () => envStr("FLEET_PLANNER_MODEL", config.claudeSonnet);
const reviewerModel = () => envStr("FLEET_REVIEWER_MODEL", plannerModel());

// ── gateway fallback brain (CEO rule, 2026-09-30) ──────────────────────
// When Claude cannot be reached at all (an expired `claude login`, an outage), planning and
// review must still produce work on the Go gateway. Order matters: DeepSeek is the cheap
// default for all work, and Kimi is the escalation - it is only asked if DeepSeek failed.
//
// FLEET_FALLBACK_MODELS is the explicit list (comma separated). FLEET_FALLBACK_MODEL is the
// older single-model knob: it is still honoured, but it can no longer push DeepSeek out of
// first place, which is what the CEO asked for.
const FALLBACK_MODELS_DEFAULT = ["deepseek-v4.1-flash", "kimi-k2.7-code"];
// Exported for ops/deepseek-only-check.ts, which proves the FLEET_DEEPSEEK_ONLY mapping on the
// Claude-outage chain too (read-only: it only reads the env and the switch).
export const fallbackModels = (): string[] => {
  const raw = (process.env.FLEET_FALLBACK_MODELS ?? "").trim();
  let list: string[];
  if (raw) {
    list = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (!list.length) list = [...FALLBACK_MODELS_DEFAULT];
  } else {
    const legacy = (process.env.FLEET_FALLBACK_MODEL ?? "").trim();
    list = [...FALLBACK_MODELS_DEFAULT, ...(legacy ? [legacy] : [])];
  }
  // FLEET_DEEPSEEK_ONLY: this chain is the planner/reviewer fallback for a Claude outage and it
  // names kimi-k2.7-code - a Go model. With the switch armed every entry is mapped onto a
  // DeepSeek model the direct API serves (and deduped), so the outage path cannot spend the Go
  // weekly window either. With the switch off this is the identity, entry for entry.
  return [...new Set(list.map((m) => deepseekOnlyModel(m).model))];
};
/**
 * Output budget for a fallback plan/review call.
 *
 * MEASURED (2026-09-30, live gateway): these models are reasoning models and their
 * `reasoning_content` is counted inside `max_tokens`. At the gateway default of 4096
 * `deepseek-v4.1-flash` came back either with `finish_reason: "length"` (a truncated,
 * unparseable plan) or with EMPTY content and a 9253-char reasoning block, which the
 * planner treats as "empty response". That is why a run whose Claude login had expired
 * ended as "the planner produced no usable work orders". 8192 leaves room for the
 * reasoning plus the whole JSON plan. FLEET_FALLBACK_MAX_TOKENS overrides it.
 */
const fallbackMaxTokens = () => envNum("FLEET_FALLBACK_MAX_TOKENS", 8192);
/**
 * How many times the whole fallback chain is walked before giving up.
 *
 * MEASURED (2026-09-30): these gateway models occasionally answer a structured-output call with a
 * reasoning dump plus a TOOL-CALL artifact (`{"file_path":...}`, 14-30 kB) instead of the plan -
 * the exact shape of the original `fleet:fomunyxv8p` failure. It is stochastic (2 of 3 attempts in
 * one run, then 3 of 3), so ONE wasted attempt must not fail the whole order: the chain is walked
 * `FLEET_FALLBACK_TRIES` times (default 2), which also lets DeepSeek take the second try when Kimi
 * wasted the first.
 */
const fallbackTries = () => envNum("FLEET_FALLBACK_TRIES", 2);
/**
 * MEASURED (2026-09-30): these gateway models are REASONING models and they put their
 * deliberation in `reasoning_content`, which is billed inside `max_tokens`. On a structured-output
 * call that reasoning dominates: kimi-k2.7-code returned 29,927 chars of it, emitted a TOOL-CALL
 * artifact (`{"file_path":...}`) instead of the plan, and the run produced no work orders - the
 * exact shape of the original `fleet:fomunyxv8p` failure. `reasoning_effort: "none"` was tried on
 * the wire and the models REJECT it (no generated text at all), so the suppression is stated in
 * the PROMPT: the appended line was measured to make the replies come back as the JSON itself.
 * Set FLEET_FALLBACK_NO_REASONING=0 to send the prompt exactly as it was before.
 */
function fallbackNote(): string {
  if ((process.env.FLEET_FALLBACK_NO_REASONING ?? "1") === "0") return "";
  return [
    "",
    "IMPORTANT: do not think step by step and do not deliberate. Do not use any tool and do not emit a tool call.",
    "Answer IMMEDIATELY with the single JSON object described above and nothing else.",
  ].join("\n");
}
// Terminal caps and the low-RAM guard.
//
// IMPORTANT (manager's correction, 19:59): %USERPROFILE%\.jcode\active_pids does NOT
// count terminals - every entry points at the SHARED jcode server pid (all 22 were
// pid 36564), so it is useless as a session count. We count REAL processes instead:
// jcode.exe that is not the server/helper (`serve`, `server`, `keepalive`,
// `setup-hotkey`), plus `opencode.exe run` workers. MAX_PARALLEL_SESSIONS is the
// machine-wide limit (CEO raised it 20 -> 30); FLEET_MAX_SESSIONS can only be stricter.
const maxParallelSessions = () => envNum("MAX_PARALLEL_SESSIONS", 30);
// Budget pressure can lower the effective cap (amber 10, red 3 - docs/BUDGET_SPEC.md §2).
const effectiveMaxParallel = () => fleetMaxParallel(maxParallelSessions());
const maxSessions = () => envNum("FLEET_MAX_SESSIONS", effectiveMaxParallel());
// Low-RAM guard: the fleet will not open a new terminal below this much free memory
// (the queued work order waits for the next tick). CEO's floor: 2048 MB. 0 disables it.
const minFreeRamMb = () => envNum("MIN_FREE_RAM_MB", 2048);
const watchIntervalMs = () => envNum("FLEET_WATCH_INTERVAL_MS", 5000);
const idleSeconds = () => envNum("FLEET_IDLE_SECONDS", 90);
const provider = () => envStr("FLEET_PROVIDER", "opencode-go");
const repoRoot = () => path.resolve(envStr("FLEET_REPO", process.cwd()));
const spawnDetectMs = () => envNum("FLEET_SPAWN_DETECT_MS", 60000);
// How often identifySession() re-checks for the spawned session's descendant pid.
//
// PERF-BACKEND, 21:10: this used to be a hard-coded 1000 ms, so a single 60 s detection
// window could iterate ~60 times. Combined with the per-iteration process-table spawn
// below that is where the 14 concurrent powershell.exe (30-106 MB each) came from.
// Default raised to 3000 ms; a shared, TTL-cached process-tree snapshot (see
// processTreeSnapshot) makes each iteration cheap even at this cadence.
const detectPollMs = () => Math.max(500, envNum("FLEET_DETECT_POLL_MS", 3000));
// TTL for the ONE shared process-tree snapshot. 4000 ms is inside the requested
// 2000-5000 ms band: with the 3000 ms poll interval several iterations reuse one
// snapshot, so a 60 s window costs ~15 spawns TOTAL instead of ~60 per caller.
const processTreeTtlMs = () => Math.min(30000, Math.max(1000, envNum("FLEET_PROCESS_TREE_TTL_MS", 4000)));
const deliverVerifyMs = () => envNum("FLEET_DELIVER_VERIFY_MS", 20000);
const reviewRetries = () => envNum("FLEET_REVIEW_RETRIES", 3);
// RESUME_SPEC 1: planning is retried across restarts, but never endlessly.
const planMaxAttempts = () => envNum("FLEET_PLAN_MAX_ATTEMPTS", 3);
const autoApprove = () => process.env.FLEET_AUTO_APPROVE === "1";
const jcodeBin = () => envStr("JCODE_BIN", "jcode");
// Laya must clear this bar for HER model pick to be used, else the rule default
// decides. The metric is the TOP PROBABILITY (not `confidence`): the manager's
// finding of 19:59 - Laya's `confidence` is 1 - H(p)/log k, which stays near 0 for
// a 3-option choice even with a clear winner (p=0.403 vs 0.243 reads 0.046), so
// gating on it discards every pick. The gate is now read against the shared noul-based
// question's `value` (its top probability - the same scale), and LAYA-TUNE owns the tuning.
const layaModelMinConf = () => {
  const raw = Number(process.env.LAYA_MODEL_MIN_CONF);
  return Number.isFinite(raw) && raw >= 0 ? raw : 0.33;
};

const RUNNING_STATES: WorkOrderState[] = ["starting", "working", "idle"];

// ── one warning per state change, not one per 5 s tick ─────────────────
//
// WHY (2026-09-30, CEO order "Cap + spam"): the terminal-cap warning was a plain
// console.warn on every watcher tick, which wrote one identical line to the error log
// every 5 s (measured: 18 identical `[fleet] not spawning: ...` lines per 90 s window).
// The CEO reads that log; a warning that repeats unchanged is noise, not information.
// This logs when the MESSAGE changes (a real state change) and otherwise at most once
// per WARN_REPEAT_MS, so a genuinely stuck state is still visible on a slow cadence.
const WARN_REPEAT_MS = 10 * 60_000;
const warnLast = new Map<string, { msg: string; at: number }>();

/**
 * Log `msg` under `key` once per state change, else at most once per WARN_REPEAT_MS.
 * Exported so ops/fleet-cap-check.ts can prove the "logged once" behaviour with a
 * synthetic clock; the two real call sites below use it internally.
 */
export function warnThrottled(key: string, msg: string, now = Date.now()): boolean {
  const prev = warnLast.get(key);
  if (prev && prev.msg === msg && now - prev.at < WARN_REPEAT_MS) return false;
  warnLast.set(key, { msg, at: now });
  console.warn(msg);
  return true;
}

/** Test seam: forget the throttle state (proof of "logged once"). */
export function resetWarnThrottle(): void {
  warnLast.clear();
}

// ── persistence ───────────────────────────────────────────────────────

export function fleetRoot(): string {
  return path.join(getCompanyRoot(), "fleet");
}
function ordersFile(): string {
  return path.join(fleetRoot(), "orders.json");
}
export function workOrderDir(orderId: string, wid: string): string {
  return path.join(fleetRoot(), sanitizeId(orderId), sanitizeId(wid));
}
export function reportPath(orderId: string, wid: string): string {
  return path.join(workOrderDir(orderId, wid), "REPORT.md");
}

function sanitizeId(id: string): string {
  return String(id).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "unnamed";
}

function nowIso(): string {
  return new Date().toISOString();
}

// ── read caches (PERF-BACKEND's corrected ranking, 20:57) ──────────────
// The two real costs in THIS file were repeated file reads: `loadFleetOrders` (582 ms in
// their live window) and `sessionLive` (418 ms). Both re-read and re-parsed the same bytes
// many times per second on a box where file I/O is expensive (their own ranking shows
// existsSync 1.3 s / stat 1.0 s of AV-inflated metadata churn). Both are now memoised by
// (path, mtime, size), so an unchanged file is parsed once, and `saveFleetOrders` writes
// through to the cache so a mutate-then-save cycle never sees a stale copy.
let ordersCache: { key: string; value: FleetOrder[] } | null = null;

// FIX 1 (docs/ORDER_2026-10-01_loop-fixes-1-2.md): the 5 s tick used to rewrite orders.json
// unconditionally (611 KB tmp write + rename), which is the live router's 190 s single block.
// We now remember the exact bytes THIS process last wrote and skip an identical save, so a tick
// that changed nothing does zero writes. `FLEET_SAVE_ALWAYS=1` restores the old always-write
// behaviour (operational escape hatch). The first save in a process always writes, so a missing
// file is still repaired.
let lastSavedOrdersJson: string | null = null;

// Serialised async writer queue for orders.json. The synchronous caller returns
// immediately after updating in-memory state; the actual tmp+rename I/O happens
// off the event loop and concurrent writers are forced into a single flight.
let ordersWriteQueue: Promise<void> = Promise.resolve();
let pendingOrdersKey = 0;

/** Cache key for a file: mtime + size. Cheap-ish, and it never aliases a changed file. */
function fileKey(file: string): string {
  const st = fs.statSync(file);
  return `${st.mtimeMs}:${st.size}`;
}

export function loadFleetOrders(): FleetOrder[] {
  try {
    const file = ordersFile();
    // If a save is in flight, the in-memory value is authoritative for this process.
    if (ordersCache && ordersCache.key.startsWith("__pending__")) return ordersCache.value;
    const key = fileKey(file);
    if (ordersCache && ordersCache.key === key) return ordersCache.value;
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : ((parsed as { orders?: unknown })?.orders ?? []);
    const value = Array.isArray(list)
      ? (list as FleetOrder[]).filter((o) => o && typeof o === "object" && typeof o.id === "string")
      : [];
    ordersCache = { key, value };
    return value;
  } catch {
    return [];
  }
}

async function sleepAsync(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function doSaveFleetOrders(orders: FleetOrder[], data: string): Promise<void> {
  const file = ordersFile();
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    await fs.promises.mkdir(fleetRoot(), { recursive: true });
    await fs.promises.writeFile(tmp, data);
    for (let i = 0; i < 5; i++) {
      try {
        await fs.promises.rename(tmp, file);
        ordersCache = { key: fileKey(file), value: orders }; // write-through: no stale read
        lastSavedOrdersJson = data;
        return;
      } catch (e) {
        if (i === 4) throw e;
        await sleepAsync(80 * (i + 1)); // ONLY on a rename failure: the happy path never sleeps
      }
    }
  } catch (e) {
    try { await fs.promises.rm(tmp, { force: true }); } catch { /* best effort */ }
    console.warn(`[fleet] atomic save failed (${String(e).slice(0, 120)}); writing orders.json directly`);
    try {
      await fs.promises.writeFile(file, data);
      lastSavedOrdersJson = data;
      try {
        ordersCache = { key: fileKey(file), value: orders };
      } catch {
        ordersCache = null;
      }
    } catch (e2) {
      console.warn(`[fleet] direct save also failed (${String(e2).slice(0, 120)})`);
    }
  }
}

/**
 * Write orders.json atomically (tmp + rename), but stay tolerant of Windows:
 * rename over an existing file can fail with EPERM when another process (the
 * indexer, antivirus, a peer reading the file) holds it open for a moment. A
 * transient lock must never lose fleet state, so we retry and then fall back to
 * a direct write.
 *
 * FIX 1: an unchanged tick must not rewrite 611 KB. `lastSavedOrdersJson` is set only after a
 * write this process did, so the first save after boot always writes (and repairs a deleted
 * file); after that an identical payload is a no-op.
 *
 * LOOP-LAG (2026-10-01): the actual fs I/O is now async and serialised. The caller returns
 * immediately so the event loop never waits for the tmp write/rename; concurrent calls are
 * queued in order and cannot corrupt the file with interleaved writes.
 */
export function saveFleetOrders(orders: FleetOrder[]): void {
  const data = JSON.stringify(orders, null, 2);
  if (lastSavedOrdersJson !== null && lastSavedOrdersJson === data && process.env.FLEET_SAVE_ALWAYS !== "1") {
    return; // nothing changed since our last write: skip the tmp write + rename entirely
  }
  lastSavedOrdersJson = data;
  pendingOrdersKey++;
  ordersCache = { key: `__pending__:${pendingOrdersKey}`, value: orders };
  const current = orders;
  ordersWriteQueue = ordersWriteQueue.then(() => doSaveFleetOrders(current, data)).catch((e) => {
    console.warn(`[fleet] queued save failed (${String(e).slice(0, 120)})`);
  });
}

function touched(o: FleetOrder): void {
  o.updatedAt = nowIso();
}

/** Trace a waiting reason once: repeat calls refresh the same hop instead of spamming. */
function noteOnce(o: FleetOrder, what: string, detail: string): void {
  const last = o.trace[o.trace.length - 1];
  if (last && last.what === what) {
    last.detail = detail.slice(0, 600);
    last.ts = nowIso();
    o.updatedAt = last.ts;
    return;
  }
  pushTrace(o, { from: "Fleet", to: "Claude (manager)", what, detail });
}

function pushTrace(o: FleetOrder, step: Omit<TraceStep, "ts">): void {
  // exported for ops/ tools that need to add a hop (e.g. fleet-write-plan.ts, when the manager
  // rewrites a plan) without duplicating the trace shape.
  pushOrderTrace(o, step);
}

/** Add one hop to an order's trace (see pushTrace). */
export function pushOrderTrace(o: FleetOrder, step: Omit<TraceStep, "ts">): void {
  o.trace = [
    ...(o.trace ?? []),
    { ts: nowIso(), ...step, detail: step.detail?.slice(0, 600) },
  ];
  o.updatedAt = nowIso();
}

export function getFleetOrder(id: string): FleetOrder | undefined {
  return loadFleetOrders().find((o) => o.id === id);
}

// ── Claude report-back to the assistant thread ────────────────────────
// Same file/format as src/company/assistant.ts (imported shape only: that
// module owns the writer, this is a second writer to the same jsonl).
function appendAssistantEntry(text: string, tasks: string[] = []): void {
  try {
    fs.mkdirSync(getCompanyRoot(), { recursive: true });
    const entry = { ts: nowIso(), role: "assistant" as const, text, tasks };
    fs.appendFileSync(path.join(getCompanyRoot(), "assistant.jsonl"), JSON.stringify(entry) + "\n");
  } catch {
    // best effort
  }
}

// ── jcode session state (READ-ONLY) ───────────────────────────────────

export function jcodeStateDir(): string {
  return path.join(os.homedir(), ".jcode");
}

export function sessionsDir(): string {
  return path.join(jcodeStateDir(), "sessions");
}

export function clientSessionsDir(): string {
  return path.join(jcodeStateDir(), "client_sessions");
}

function streamingPidsDir(): string {
  return path.join(jcodeStateDir(), "streaming_pids");
}

function readTrimmed(file: string): string {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * sessionId -> pid of a LIVE TUI client process, from client_sessions/<pid>.
 * Those files are NOT cleaned up when a window closes, so the pid is liveness-
 * checked here; and one session can have several client pids (reconnects), so
 * any live one counts.
 */
export function liveClientSessions(): Map<string, number> {
  const out = new Map<string, number>();
  let names: string[] = [];
  try {
    names = fs.readdirSync(clientSessionsDir());
  } catch {
    return out;
  }
  for (const name of names) {
    const pid = Number(name);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (!pidAlive(pid)) continue;
    const sessionId = readTrimmed(path.join(clientSessionsDir(), name));
    if (sessionId) out.set(sessionId, pid);
  }
  return out;
}

export function isStreaming(sessionId: string): boolean {
  try {
    return fs.existsSync(path.join(streamingPidsDir(), sessionId));
  } catch {
    return false;
  }
}

export function sessionIsAlive(sessionId: string): boolean {
  if (!sessionId) return false;
  if (fs.existsSync(path.join(sessionsDir(), `${sessionId}.journal.jsonl`)) && isStreaming(sessionId)) return true;
  return liveClientSessions().has(sessionId);
}

type JournalMsg = { role?: string; content?: Array<{ type?: string; text?: string; name?: string; input?: Record<string, unknown> }> };

export type SessionLive = {
  found: boolean;
  streaming: boolean;
  lastActivity?: string;
  /** journal mtime / meta time as an ISO string */
  messages: number;
  tail: string[];
  /** the model the session itself reports (Fix 1: proves Kaya's pick really runs) */
  model?: string;
};

/** sessionLive memo (see its doc comment): keyed by journal mtime+size+maxLines. */
const liveMemo = new Map<string, { key: string; value: SessionLive }>();

function readTextTail(file: string, maxBytes = 1024 * 1024): string {
  try {
    const size = fs.statSync(file).size;
    if (size <= maxBytes) return fs.readFileSync(file, "utf8");
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      fs.readSync(fd, buf, 0, maxBytes, size - maxBytes);
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function describeToolUse(c: { name?: string; input?: Record<string, unknown> }): string {
  const name = c.name ?? "tool";
  const input = c.input ?? {};
  const pick = (k: string, n = 140): string => {
    const v = input[k];
    return typeof v === "string" ? v.replace(/\s+/g, " ").slice(0, n) : "";
  };
  switch (name) {
    case "bash": return `$ ${pick("command", 200)}`;
    case "read": return `read ${pick("file_path")}`;
    case "write": return `write ${pick("file_path")}`;
    case "edit": return `edit ${pick("file_path")}`;
    case "apply_patch": return `patch ${pick("intent", 80)}`;
    case "batch": return `batch ${pick("intent", 80)}`;
    case "todo": return `todo ${pick("intent", 80)}`;
    case "ls": return `ls ${pick("path", 80)}`;
    case "agentgrep": return `grep ${pick("query", 80)}`;
    default: {
      const first = Object.values(input).find((v) => typeof v === "string") as string | undefined;
      return `${name} ${(first ?? "").replace(/\s+/g, " ").slice(0, 100)}`;
    }
  }
}

/**
 * Read-only view of a jcode session: streaming flag, last activity, recent tail.
 *
 * MEMOISED by (journal mtime, size, maxLines): the watcher asks for the same session
 * every tick and the API asks again per poll, and each call used to read and parse up to
 * a megabyte of journal (PERF-BACKEND measured 418 ms of this in a 41 s live window).
 * Pass `force` when the caller has just CHANGED something (e.g. set the model) and must not
 * read a cached copy: the memo only refreshes when the journal's mtime/size moves.
 */
export function sessionLive(sessionId: string, maxLines = 15, force = false): SessionLive {
  const out: SessionLive = { found: false, streaming: false, messages: 0, tail: [] };
  if (!sessionId) return out;
  const journal = path.join(sessionsDir(), `${sessionId}.journal.jsonl`);
  const snapshot = path.join(sessionsDir(), `${sessionId}.json`);
  if (!fs.existsSync(journal) && !fs.existsSync(snapshot)) return out;
  let memoKey = "";
  try {
    const st = fs.statSync(journal);
    memoKey = `${st.mtimeMs}:${st.size}:${maxLines}`;
    if (!force) {
      const hit = liveMemo.get(sessionId);
      if (hit && hit.key === memoKey) return hit.value;
    }
  } catch {
    memoKey = "";
  }
  out.found = true;
  out.streaming = isStreaming(sessionId);
  const lines: string[] = [];
  let count = 0;
  try {
    for (const rawLine of readTextTail(journal).split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      let rec: { meta?: { updated_at?: string; model?: string }; append_messages?: JournalMsg[] };
      try {
        rec = JSON.parse(line) as typeof rec;
      } catch {
        continue; // a partial first line from the byte window, or a torn write
      }
      const ts = rec.meta?.updated_at;
      if (ts) out.lastActivity = ts;
      if (rec.meta?.model) out.model = rec.meta.model;
      for (const m of rec.append_messages ?? []) {
        count++;
        for (const c of m.content ?? []) {
          if (c.type === "text" && m.role === "assistant") {
            const t = (c.text ?? "").trim();
            if (t) lines.push(t.replace(/\s+/g, " ").slice(0, 200));
          } else if (c.type === "tool_use") {
            lines.push(`→ ${describeToolUse(c)}`);
          } else if (c.type === "tool_result") {
            lines.push("← result");
          }
        }
      }
    }
  } catch {
    // journal unreadable: report what we have
  }
  out.messages = count;
  out.tail = lines.slice(-maxLines);
  // The model lives in the session snapshot (and in the journal meta once it has
  // run a turn), so read it so the UI can show what the terminal ACTUALLY runs.
  if (!out.model) {
    try {
      const j = JSON.parse(fs.readFileSync(snapshot, "utf8")) as { model?: unknown };
      if (typeof j.model === "string" && j.model) out.model = j.model;
    } catch {
      // snapshot not written yet
    }
  }
  if (!out.lastActivity) {
    try {
      out.lastActivity = fs.statSync(journal).mtime.toISOString();
    } catch {
      try { out.lastActivity = fs.statSync(snapshot).mtime.toISOString(); } catch { /* ignore */ }
    }
  }
  if (memoKey) liveMemo.set(sessionId, { key: memoKey, value: out });
  return out;
}

/** Does the session's stored history already contain `marker` as a user message? */
export function sessionHasMarker(sessionId: string, marker: string): boolean {
  if (!sessionId || !marker) return false;
  const snapshot = path.join(sessionsDir(), `${sessionId}.json`);
  try {
    const j = JSON.parse(fs.readFileSync(snapshot, "utf8")) as {
      messages?: Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>;
    };
    for (const m of j.messages ?? []) {
      for (const c of m.content ?? []) {
        if (typeof c.text === "string" && c.text.includes(marker)) return true;
      }
    }
  } catch {
    // fall through to the journal
  }
  try {
    const journal = readTextTail(path.join(sessionsDir(), `${sessionId}.journal.jsonl`), 2 * 1024 * 1024);
    return journal.includes(marker);
  } catch {
    return false;
  }
}

// ── process helpers ───────────────────────────────────────────────────

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function run(bin: string, args: string[], opts: { stdin?: string; timeoutMs?: number; cwd?: string } = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      resolve({ code: -1, out: "", err: String(e) });
      return;
    }
    let out = "";
    let err = "";
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, out, err });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* gone */ }
      finish(-1);
    }, opts.timeoutMs ?? 60000);
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => { err += String(e); finish(-1); });
    child.on("close", (code) => finish(code ?? -1));
    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
    else child.stdin?.end();
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function psQuote(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// ── how many terminals are really running? ────────────────────────────

export type TerminalCount = {
  jcodeTerminals: number;
  opencodeWorkers: number;
  total: number;
  maxParallel: number;
  headroom: number;
  at: string;
  /** where the numbers came from: in-process (default) or the process table (opt-in) */
  source: string;
};

let terminalCountCache: TerminalCount | null = null;
let terminalCountInFlight: Promise<TerminalCount> | null = null;

/**
 * sessionId -> pid, but ONLY for pids the process table proves are LIVE jcode TUI clients.
 *
 * WHY THIS IS NOT liveClientSessions().size ANY MORE (2026-09-30, CEO order "Cap + spam"):
 * %USERPROFILE%\.jcode\client_sessions\<pid> files are never deleted when a client exits, so
 * `pidAlive(pid)` alone counts a FINISHED terminal whenever Windows reuses its pid. Measured
 * live on this box: 19 alive pid files, only 11 of them jcode - the other 8 were
 * brave / git / claude / Code / conhost holding recycled pids (an earlier sample read 18/10).
 * That inflated the machine-wide count to "18-19 real terminals" and made the cap check
 * refuse to spawn.
 *
 * The process table is the shared, TTL-cached, non-blocking one the terminal reaper already
 * keeps warm (terminalReaper.cachedProcesses() spawns nothing on the caller's stack).
 * FAIL-OPEN: when the table is not ready (cold start, WMI outage) we keep the old pid-liveness
 * rule rather than under-count and over-spawn.
 */
async function liveJcodeTerminals(): Promise<Map<string, number>> {
  const base = liveClientSessions();
  if (base.size === 0) return base;
  try {
    const { cachedProcesses } = await import("./terminalReaper.js");
    const table = cachedProcesses();
    if (table.size === 0) return base;
    const out = new Map<string, number>();
    for (const [sessionId, pid] of base) {
      const row = table.get(pid);
      if (!row) continue; // gone from the table: the client is dead, its pid file is stale
      if (!/^jcode(\.exe)?$/i.test(row.name)) continue; // pid reused by another program
      const cmd = row.cmd.toLowerCase();
      if (/\bserve\b/.test(cmd) || /keepalive/.test(cmd) || /setup-hotkey/.test(cmd)) continue; // infra, not a terminal
      out.set(sessionId, pid);
    }
    return out;
  } catch {
    return base;
  }
}

/**
 * Count the REAL terminals, IN-PROCESS by default: `client_sessions/<pid>` (live TUI
 * clients, so the shared server and the OS helpers are excluded by construction) plus
 * the pipeline's running opencode workers from the session index.
 *
 * WHY THIS IS NOT Get-CimInstance ANY MORE (PERF-BACKEND, 20:51): the old version spawned
 * a powershell child, and their live CPU profile attributed 29.5 s of a 60 s window to
 * CreateProcess on the watcher path (live /health p50 684 ms, event-loop lag p95 1464 ms).
 * Counting in-process removes the child process entirely. Set FLEET_TERMINAL_COUNT_VIA_PS=1
 * to fall back to the process table (accurate for foreign processes, but it spawns).
 * Single-flight + TTL mean concurrent callers share one count.
 */
export async function countRealTerminals(force = false): Promise<TerminalCount> {
  const ttl = envNum("FLEET_TERMINAL_COUNT_TTL_MS", 30000);
  if (!force && terminalCountCache && Date.now() - Date.parse(terminalCountCache.at) < ttl) return terminalCountCache;
  if (terminalCountInFlight) return terminalCountInFlight;
  terminalCountInFlight = (async () => {
    const maxParallel = effectiveMaxParallel();
    let jcodeTerminals = 0;
    let opencodeWorkers = 0;
    let source = "in-process (pid verified against the process table)";
    try {
      jcodeTerminals = (await liveJcodeTerminals()).size;
      const { listSessions } = await import("./sessions.js");
      opencodeWorkers = listSessions(400).filter(
        (s) => s.status === "running" && s.runtime === "opencode" && (typeof s.pid === "number" ? pidAlive(s.pid) : true),
      ).length;
    } catch {
      source = "in-process (partial)";
    }
    if (process.env.FLEET_TERMINAL_COUNT_VIA_PS === "1") {
      try {
        const r = await run(
          "powershell",
          ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object Name,CommandLine | ConvertTo-Json -Compress"],
          { timeoutMs: 30000 },
        );
        const parsed = JSON.parse(r.out.trim() || "[]") as unknown;
        const rows = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{ Name?: string; CommandLine?: string }>;
        let j = 0;
        let o = 0;
        for (const row of rows) {
          const name = (row.Name ?? "").toLowerCase();
          const cmd = row.CommandLine ?? "";
          if (name === "jcode.exe") {
            if (/\s(serve|server)\b|keepalive|setup-hotkey/i.test(cmd)) continue;
            j++;
          } else if (name === "opencode.exe") {
            if (!/\srun\b/i.test(cmd) || /\b(auth|version|--help)\b/i.test(cmd)) continue;
            o++;
          }
        }
        jcodeTerminals = j;
        opencodeWorkers = o;
        source = "process table (FLEET_TERMINAL_COUNT_VIA_PS=1)";
      } catch {
        source += " + process table failed";
      }
    }
    const total = jcodeTerminals + opencodeWorkers;
    terminalCountCache = {
      jcodeTerminals,
      opencodeWorkers,
      total,
      maxParallel,
      headroom: Math.max(0, maxParallel - total),
      at: nowIso(),
      source,
    };
    return terminalCountCache;
  })();
  try {
    return await terminalCountInFlight;
  } finally {
    terminalCountInFlight = null;
  }
}

/** The last measured terminal count, for the API (sync callers cannot await). */
export function lastTerminalCount(): TerminalCount | null {
  return terminalCountCache;
}

// ── process-tree snapshot (ONE shared, TTL-cached, single-flight) ─────

/**
 * The parent→children map of the whole process table.
 *
 * WHY THIS EXISTS (PERF-BACKEND, 21:10, measured live): `identifySession()` polls in a
 * `while (Date.now() < deadline)` loop, and every iteration used to spawn a full
 * `Get-CimInstance Win32_Process` enumeration. With FLEET_SPAWN_DETECT_MS=60000 and a
 * 1000 ms poll that is up to ~60 PowerShell children PER CALL; live we saw 14 concurrent
 * powershell.exe (30-106 MB each, ~800 MB) with free RAM below the app's own
 * MIN_FREE_RAM_MB floor. The Node event loop starved, /health stopped answering, the
 * supervisor killed the router, and /v2/ would not load.
 *
 * Same shape as countRealTerminals() (see its PERF-BACKEND, 20:51 comment): the work is
 * shared, so N concurrent callers and a 60 s poll loop cost ~1 spawn per TTL window.
 * Async `spawn` only, never execFileSync/spawnSync. Set FLEET_PROCESS_TREE_VIA_PS=0 to
 * skip the process table entirely (the snapshot then holds no edges, so only the root is
 * ever a descendant - useful on a box where WMI is unavailable).
 */
type ProcessTreeSnapshot = {
  /** ParentProcessId -> ProcessId[] edges. Empty when the table is disabled/failed. */
  edges: Map<number, number[]>;
  /** Date.now() when the snapshot was taken (cache key). */
  at: number;
  /** true when a real process table was read. */
  ok: boolean;
};

let processTreeCache: ProcessTreeSnapshot | null = null;
let processTreeInFlight: Promise<ProcessTreeSnapshot> | null = null;

async function readProcessTree(): Promise<ProcessTreeSnapshot> {
  const edges = new Map<number, number[]>();
  let ok = false;
  if (process.env.FLEET_PROCESS_TREE_VIA_PS !== "0") {
    try {
      const r = await run(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress"],
        { timeoutMs: 30000 },
      );
      if (r.code === 0 && r.out.trim()) {
        const parsed = JSON.parse(r.out.trim()) as unknown;
        const rows = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{ ProcessId?: number; ParentProcessId?: number }>;
        for (const row of rows) {
          if (typeof row.ProcessId !== "number" || typeof row.ParentProcessId !== "number") continue;
          const arr = edges.get(row.ParentProcessId) ?? [];
          arr.push(row.ProcessId);
          edges.set(row.ParentProcessId, arr);
        }
        ok = true;
      }
    } catch {
      ok = false;
    }
  }
  return { edges, at: Date.now(), ok };
}

/**
 * The shared snapshot. TTL-cached (FLEET_PROCESS_TREE_TTL_MS, default 4000 ms) and
 * single-flighted: concurrent callers await the SAME in-flight spawn. Failures are cached
 * for the TTL too, so a hung/failed WMI query cannot be retried once per caller per poll
 * (that retry storm is exactly the bug).
 *
 * Invalidation is TTL-only: a process tree is inherently time-varying, and the poll loop
 * re-reads it until the deadline, so there is nothing to invalidate by hand. The match
 * rule is unchanged - only a real snapshot is ever used to decide a descendant.
 */
async function processTreeSnapshot(force = false): Promise<ProcessTreeSnapshot> {
  const ttl = processTreeTtlMs();
  if (!force && processTreeCache && Date.now() - processTreeCache.at < ttl) return processTreeCache;
  if (processTreeInFlight) return processTreeInFlight;
  processTreeInFlight = (async () => {
    const snapshot = await readProcessTree();
    processTreeCache = snapshot;
    return snapshot;
  })();
  try {
    return await processTreeInFlight;
  } finally {
    processTreeInFlight = null;
  }
}

/** Every descendant pid of `rootPid` (depth-limited), from the shared cached snapshot. */
async function descendantsOf(rootPid: number): Promise<Set<number>> {
  const out = new Set<number>([rootPid]);
  const { edges } = await processTreeSnapshot();
  if (!edges.size) return out;
  const queue = [rootPid];
  for (let depth = 0; depth < 4 && queue.length; depth++) {
    const next: number[] = [];
    for (const pid of queue) {
      for (const child of edges.get(pid) ?? []) {
        if (!out.has(child)) {
          out.add(child);
          next.push(child);
        }
      }
    }
    queue.length = 0;
    queue.push(...next);
  }
  return out;
}

// ── spawn + targeted delivery ─────────────────────────────────────────

// Spawns are SERIALIZED (spec: "spawns MUST be serialized (one at a time, with
// a mutex)"). Without this, two spawns racing for the same "new session id"
// window is how an order lands in the wrong terminal.
let spawnMutex: Promise<unknown> = Promise.resolve();
function withSpawnLock<T>(fn: () => Promise<T>): Promise<T> {
  const runNext = spawnMutex.then(fn, fn);
  spawnMutex = runNext.catch(() => undefined);
  return runNext;
}

/**
 * Hand a freshly spawned worker window to AUTOCLOSE (docs/AUTOCLOSE_SPEC.md).
 * Its module (src/company/terminalReaper.ts) is owned by the AUTOCLOSE session and
 * may not exist yet, so the import is resolved at call time and a missing module
 * is a no-op: the fleet must never fail to spawn because a peer's file is late.
 * The Fleet's PASS/REDO verdicts live in company/fleet/orders.json
 * (workOrders[].verdict), which AUTOCLOSE reads to decide whether to close.
 */
async function registerWithAutoclose(rec: {
  sessionId: string;
  role: string;
  windowPid: number;
  clientPid?: number;
  orderId: string;
  workOrderId: string;
  title: string;
}): Promise<string> {
  const spec = "./terminalReaper.js"; // dynamic: resolves once AUTOCLOSE lands
  try {
    const mod = (await import(spec)) as { registerTerminal?: (r: unknown) => unknown };
    if (typeof mod.registerTerminal !== "function") return "terminalReaper has no registerTerminal (skipped)";
    // Fields match AUTOCLOSE's RegisterInput; reportPath is what it archives and
    // shows on the RunCard, and the Fleet's PASS/REDO is read from orders.json.
    mod.registerTerminal({
      sessionId: rec.sessionId,
      sessionName: rec.sessionId,
      role: rec.role,
      windowPid: rec.windowPid,
      clientPid: rec.clientPid,
      spawnedBy: "fleet",
      spawnedAt: nowIso(),
      state: "working",
      reportPath: reportPath(rec.orderId, rec.workOrderId),
    });
    return "registered with AUTOCLOSE";
  } catch (e) {
    return `AUTOCLOSE not available yet (${String(e).slice(0, 120)})`;
  }
}

// ── Laya picks each terminal's model (docs/LAYA_FIX_SPEC.md Fix 1) ─────
// Before a window opens, Laya chooses the jcode model from ONE catalog. Her pick
// is used only above a confidence guard; otherwise a rule default decides. Both
// the model and the reason land on the work order and in the order's trace.

/** The jcode models a fleet worker may be spawned with. One place, env-overridable. */
export function fleetModelCatalog(): Record<string, string> {
  return {
    [standardModel()]:
      "DeepSeek: the DEFAULT for ALL work, including UI/CSS/HTML work. Cheap and good enough; use it unless there is a reason below.",
    [routineModel()]:
      "GLM: cheapest. Trivial edits and text (one small change, typos, a short text/markdown file).",
    [complexModel()]:
      "Kimi: ESCALATION ONLY, it costs far more. Use it only (a) when this same work order already failed once (a REDO after a DeepSeek attempt) or (b) for exceptionally hard multi-file coding.",
  };
}

const complexModel = () => envStr("FLEET_MODEL_COMPLEX", "kimi-k2.7-code");
const standardModel = () => envStr("FLEET_MODEL_STANDARD", "deepseek-v4.1-flash");
const routineModel = () => envStr("FLEET_MODEL_ROUTINE", "glm-5.3-flash");

/** jcode model ids are plain slugs; anything else never reaches the launcher. */
const MODEL_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** The short family name, for trace/UI labels: kimi-k2.7-code -> "kimi". */
function modelFamily(model: string): string {
  const short = model.split("-")[0];
  return short || model;
}

/** Cheap deterministic read of a work order: what kind of work is this? */
export function classifyWork(wo: WorkOrder): { type: "ui" | "docs" | "code"; files: number; risk: "low" | "high" } {
  const owns = wo.owns.map((o) => o.toLowerCase());
  const text = `${wo.title}\n${wo.brief}`.toLowerCase();
  const uiOwns = owns.some((o) => /(^|\/)(public|ui|views?|components?|styles?)\//.test(o) || /\.(css|html|jsx?|tsx|vue|svelte)$/.test(o));
  const uiText = /\b(ui|css|html|view|button|layout|page|pill|card|style|component|render|responsive)\b/.test(text);
  const docOwns = owns.length > 0 && owns.every((o) => /\.(md|txt|rst)$/.test(o));
  const docText = /\b(docs?|documentation|readme|markdown|changelog)\b/.test(text);
  const hardWords = /\b(refactor|migrate|migration|rewrite|architecture|multi-file)\b/.test(text);
  // The OWNED PATHS are the strongest signal: a work order that may only touch .md files
  // is docs work even when its brief mentions a "style" or a "page" in passing. Measured
  // 20:17 - a one-line edit to docs/FLEET_SELFCHECK.md was classified `ui` (its brief said
  // "stylesheet"), which let Laya's kimi pick through the trivial-text ceiling.
  const ui = uiOwns || (uiText && !docOwns);
  const type: "ui" | "docs" | "code" = ui ? "ui" : docOwns || (docText && !hardWords) ? "docs" : "code";
  const hard = ui || owns.length > 3 || hardWords;
  return { type, files: owns.length, risk: hard ? "high" : "low" };
}

/**
 * CEO cost rule (20:39): deepseek is the default for ALL work, INCLUDING UI. Kimi is
 * ESCALATION ONLY - it costs far more - and needs a recorded reason: either this work
 * order already failed once (a REDO after a DeepSeek attempt), or the work is
 * exceptionally hard MULTI-FILE coding. Everything else leaves kimi alone.
 */
export function needsEscalation(wo: WorkOrder): { escalate: boolean; why: string } {
  if ((wo.attempts ?? 0) > 0 || wo.verdict === "REDO" || wo.error) {
    return { escalate: true, why: `escalation: this work order already failed once (attempt ${wo.attempts ?? 1}${wo.error ? `, ${wo.error.slice(0, 80)}` : ""})` };
  }
  const k = classifyWork(wo);
  // "Exceptionally hard MULTI-FILE coding": more than 3 owned paths, or hard-work
  // keywords (refactor/rewrite/migration) across more than one file.
  if (k.files > 3 || (k.risk === "high" && k.files > 1)) {
    return { escalate: true, why: `escalation: exceptionally hard multi-file coding (${k.files} owned paths)` };
  }
  return { escalate: false, why: "" };
}

/**
 * The rule default (spec's rule, adjusted to the CEO's 20:39 cost rule):
 *   escalation (failed once, or exceptionally hard multi-file)  -> kimi, with the reason
 *   docs-only + low risk                                        -> glm
 *   everything else INCLUDING ALL UI WORK                       -> deepseek
 */
export function ruleModel(wo: WorkOrder): { model: string; reason: string } {
  const k = classifyWork(wo);
  const esc = needsEscalation(wo);
  const base = esc.escalate
    ? { model: complexModel(), reason: `rule: ${esc.why} -> ${complexModel()}` }
    : k.type === "docs" && k.risk === "low"
      ? { model: routineModel(), reason: `rule: docs-only/trivial -> ${routineModel()} (default is ${standardModel()})` }
      : { model: standardModel(), reason: `rule: default for ${k.type} work -> ${standardModel()}${k.type === "ui" ? " (UI is NOT a reason to escalate per the CEO cost rule)" : ""}` };
  // FLEET_DEEPSEEK_ONLY: the rule's own picks are Go models too (kimi for escalation, glm for
  // trivial text, per the CEO cost rule), so they are mapped exactly like Laya's pick. With the
  // switch off this returns `base` untouched.
  const only = deepseekOnlyModel(base.model);
  return only.mapped ? { model: only.model, reason: `${base.reason} | ${only.why}` } : base;
}

/**
 * Semantic guard on top of the confidence one, now the CEO's COST rule (20:39): kimi is
 * escalation-only, so a confident kimi pick is still refused unless this work order
 * qualifies as an escalation. Everything else keeps the cheap default, which also means
 * the terminals' real model (the provider default, deepseek) matches the intent today.
 * Set LAYA_MODEL_CEILING=0 to trust Laya's number alone.
 */
function modelAllowedFor(wo: WorkOrder, model: string): { ok: boolean; why?: string } {
  if (process.env.LAYA_MODEL_CEILING === "0") return { ok: true };
  if (model !== complexModel()) return { ok: true };
  const esc = needsEscalation(wo);
  if (esc.escalate) return { ok: true };
  return { ok: false, why: `${model} is escalation-only (CEO cost rule) and this work order has no escalation reason` };
}

export type ModelPick = {
  model: string;
  reason: string;
  source: "laya" | "rules";
  /** Laya's `confidence` (1 - H/log k) - recorded for LAYA-TUNE, NOT used as the gate */
  confidence?: number;
  /** probability of Laya's chosen option (the gate input) */
  answerConfidence?: number;
  /** top probability minus the runner-up (the second gate input) */
  lead?: number;
};

/**
 * Map the SHARED catalog's ids (config.models.*) onto the fleet's env-overridable ids.
 * config.models.standard is `deepseek-v4-flash` while the CEO's cost rule names
 * `deepseek-v4.1-flash`, so the fleet catalog always wins the mapping - the guard and the
 * spawner must speak one language.
 */
function fleetModelForSharedId(modelId: string): string | undefined {
  if (modelId === config.models.complex) return complexModel();
  if (modelId === config.models.standard) return standardModel();
  if (modelId === config.models.routine) return routineModel();
  // FLEET_DEEPSEEK_ONLY: `chooseWorkerModel` (dispatch.ts) may already have mapped Laya's pick
  // onto a DeepSeek id before this module sees it; those are fleet ids, so keep them as they are.
  if (isDeepseekModel(modelId)) return modelId;
  return undefined;
}

/** The state the shared model question is asked with: title, brief, and the cheap size signals. */
function workerModelState(wo: WorkOrder): string {
  const k = classifyWork(wo);
  return [
    `title: ${wo.title}`,
    `brief: ${wo.brief.slice(0, 1500)}`,
    `owns: ${k.files} path(s)`,
    `type: ${k.type}`,
    `risk: ${k.risk}`,
    `size: ${wo.brief.length > 1200 ? "large" : wo.brief.length > 300 ? "medium" : "small"}`,
  ].join("\n");
}

/**
 * Pick the model for one work order.
 *
 * The DECISION now comes from the shared noul-based `chooseWorkerModel` (dispatch.ts), which
 * LAYA-TUNE calibrated on the live local Laya (docs/LAYA_TUNING.md). This module keeps only what
 * the shared function cannot know:
 *   - the fleet's model catalog (env-overridable ids, mapped from theirs);
 *   - the CEO's COST RULE as a ceiling: Kimi is escalation-only, so a confident Kimi pick is still
 *     refused unless this work order already failed or is exceptionally hard multi-file work;
 *   - the confidence gate (`LAYA_MODEL_MIN_CONF`, now read against the noul question's `value`,
 *     i.e. the top probability, which is the same scale this gate used before).
 * Below the bar, the rule default decides and the reason says exactly why.
 */
export async function pickFleetModel(wo: WorkOrder): Promise<ModelPick> {
  const fallback = ruleModel(wo);
  if (config.mockMode) return { ...fallback, source: "rules", reason: `${fallback.reason} (MOCK_MODE)` };
  try {
    const laya = await chooseWorkerModel(workerModelState(wo), { projectId: wo.projectId, role: wo.role });
    const conf = Number.isFinite(laya.confidence) ? laya.confidence : 0;
    // chooseWorkerModel never throws: on any failure it returns the complex model with conf 0 and
    // a reason that says so. Do not dress that up as "Laya picked Kimi".
    if (/unavailable|^mock$/i.test(laya.reason)) {
      return { ...fallback, source: "rules", confidence: conf, reason: `Laya unavailable (${laya.reason}); ${fallback.reason}` };
    }
    const mapped = fleetModelForSharedId(laya.modelId);
    if (!mapped) {
      return { ...fallback, source: "rules", confidence: conf, reason: `Laya answered "${laya.modelId}", which is not a fleet model; ${fallback.reason}` };
    }
    const bar = layaModelMinConf();
    const allowed = modelAllowedFor(wo, mapped);
    if (allowed.ok && conf >= bar) {
      // FLEET_DEEPSEEK_ONLY: the fleet's own catalog id (a kimi/glm pick allowed by the ceiling)
      // is mapped too; when dispatch.ts already mapped it this is the identity.
      const only = deepseekOnlyModel(mapped);
      return {
        model: only.mapped ? only.model : mapped,
        source: "laya",
        confidence: conf,
        reason: `Laya ${laya.modelId} conf=${conf.toFixed(2)} >= ${bar} - ${laya.reason}${only.mapped ? ` | ${only.why}` : ""}`,
      };
    }
    const miss = !allowed.ok ? `ceiling: ${allowed.why}` : `conf=${conf.toFixed(2)} < ${bar}`;
    return { ...fallback, source: "rules", confidence: conf, reason: `Laya picked ${mapped} but ${miss}; ${fallback.reason}` };
  } catch (e) {
    return { ...fallback, source: "rules", reason: `Laya unavailable (${String(e).slice(0, 120)}); ${fallback.reason}` };
  }
}

/**
 * Which PROVIDER a work order's terminal must be launched with, and which model it runs.
 *
 * DEEPSEEK DIRECT (docs/DEEPSEEK_DIRECT.md, CEO order 2026-10-01): outside DeepSeek's
 * peak hours a DeepSeek work order is launched on DeepSeek's OWN provider, so it spends
 * DeepSeek credit (half price off-peak) instead of the OpenCode Go weekly quota. Any
 * other model, any peak hour, a missing key, or DEEPSEEK_DIRECT unset keeps the old
 * provider - the feature is inert until the CEO switches it on.
 */
export async function launchTarget(model: string | undefined): Promise<{ provider: string; model?: string; direct: boolean; why: string }> {
  if (!model) return { provider: provider(), model: undefined, direct: false, why: "(no model)" };
  // FLEET_DEEPSEEK_ONLY=1 is the explicit "always DeepSeek" override (deepseekOnlyModel); with it
  // off the routing POLICY alone decides. fleetDirectReady() gates both: if a terminal cannot
  // actually run on the DeepSeek provider right now, fall back to the old provider loudly instead
  // of stranding the work.
  const only = deepseekOnlyModel(model);
  if (only.mapped) {
    if (await fleetDirectReady()) {
      return { provider: deepseekProvider(), model: deepseekDirectModel(only.model), direct: true, why: only.why };
    }
    return { provider: provider(), model, direct: false, why: `${only.why}; fleetDirectReady()=false, so the terminal stays on ${provider()}` };
  }
  // The routing POLICY (off-peak, or Go binding window < 10%, -> direct) maps kimi/glm/qwen onto
  // the direct API's own id when it routes direct; otherwise the original Laya pick stays on Go.
  const plan = deepseekDirectPlan(model);
  if (plan.use) {
    if (await fleetDirectReady()) {
      return { provider: plan.provider, model: plan.model, direct: true, why: plan.why };
    }
    return { provider: provider(), model, direct: false, why: `${plan.why}; fleetDirectReady()=false, so the terminal stays on ${provider()}` };
  }
  return { provider: provider(), model, direct: false, why: plan.why };
}

async function launcherScript(order: FleetOrder, wo: WorkOrder): Promise<string> {
  const repo = repoRoot();
  const launch = await launchTarget(wo.model);
  const script = [
    "# fleet worker launcher (generated by src/company/fleet.ts)",
    `$Host.UI.RawUI.WindowTitle = 'fleet ${order.id}/${wo.id}'`,
    `Set-Location -LiteralPath ${psQuote(repo)}`,
    // Fix 1: Laya's model goes on the command line, so the terminal really runs it
    // instead of jcode's default for the provider.
    `jcode -p ${launch.provider}${launch.model && MODEL_ID_RE.test(launch.model) ? ` -m ${launch.model}` : ""}`,
    "",
  ].join("\r\n");
  const file = path.join(workOrderDir(order.id, wo.id), "run.ps1");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, script);
  return file;
}

/**
 * The model the SERVER says a session is running, read from the debug socket's own session list.
 *
 * This is the only source that answers BEFORE a session's first turn: a session that has not run yet
 * has no journal and no snapshot, so `sessionLive().model` is empty at exactly the moment the fleet
 * needs the answer (measured live on a throwaway window: journal `(none)` while the server already
 * reported `kimi-k2.7-code`). Both sources are used; this one is asked first.
 */
async function serverSessionModel(sessionId: string, timeoutMs = envNum("FLEET_MODEL_SWITCH_VERIFY_TIMEOUT_MS", 5000)): Promise<{ model: string | null; provider: string | null; listed: boolean }> {
  const r = await run(jcodeBin(), ["debug", "sessions"], { timeoutMs });
  if (r.code !== 0) return { model: null, provider: null, listed: false };
  try {
    const list = JSON.parse(r.out) as { session_id?: string; model?: string | null; provider?: string | null }[];
    const hit = list.find((s) => s.session_id === sessionId);
    if (!hit) return { model: null, provider: null, listed: false };
    return { model: hit.model ?? null, provider: hit.provider ?? null, listed: true };
  } catch {
    return { model: null, provider: null, listed: false };
  }
}

/**
 * Drive ONE session's model through the jcode debug socket (F1, CEO-approved option 2).
 *
 * THIS IS THE ONLY MECHANISM THAT WORKS. Verified 2026-09-29: `jcode -p opencode-go -m <model>` is
 * ignored for TUI sessions (five flag forms tested), and `/model <id>` sent via
 * `jcode transcript --mode send` lands as a CHAT message. The debug socket exposes
 * `set_model:<model>` (see `jcode debug help`), which does switch the session.
 *
 * Three hard-won details:
 *  - the socket only exists when the server hosting the session was started with
 *    `[display] debug_socket = true`; with no server the command prints NOTHING and BLOCKS
 *    (measured: it sat for three minutes), so it is always run with a timeout;
 *  - success is proven from state, never from the exit code, and the SERVER's own view is asked
 *    first because a session that has not run a turn yet has no journal to read;
 *  - a failure never fails the spawn: the worker runs the provider default (per the CEO's cost rule
 *    the intended model for almost all work anyway) and the trace says exactly what happened.
 */
export async function switchSessionModel(sessionId: string, model: string): Promise<{ ok: boolean; detail: string }> {
  if (!MODEL_ID_RE.test(model)) return { ok: false, detail: `refusing a malformed model id (${model})` };
  const timeoutMs = envNum("FLEET_MODEL_SWITCH_TIMEOUT_MS", 20000);
  const r = await run(jcodeBin(), ["debug", "-S", sessionId, `set_model:${model}`], { timeoutMs });
  const out = `${r.out}${r.err}`.trim();
  if (r.code === -1 && !out) {
    return { ok: false, detail: "no answer from the jcode debug socket (it blocks silently when no debug-enabled server is running)" };
  }
  if (r.code !== 0) return { ok: false, detail: `jcode debug exited ${r.code}: ${out.slice(0, 200) || "(no output)"}` };
  // The command answers with the session's new {model, provider}; if it names something else, the
  // server coerced the pick (unknown id, provider fallback) and that must not be reported as success.
  let replied = "";
  try {
    const j = JSON.parse(r.out) as { model?: string; provider?: string };
    replied = `${j.model ?? "?"} @ ${j.provider ?? "?"}`;
    if (j.model && j.model !== model) {
      return { ok: false, detail: `the server answered ${replied} instead of ${model}` };
    }
  } catch {
    // not JSON (an older CLI): fall through to the state checks, which are the real proof
  }
  // Confirmation is BOUNDED BY WALL CLOCK, not by a fixed number of tries: with a dead socket each
  // probe can burn its own timeout, so a fixed count could hold a spawn for minutes. Measured answer
  // time when the socket is healthy: ~200-350 ms.
  const verifyDeadline = Date.now() + envNum("FLEET_MODEL_SWITCH_VERIFY_MS", 8000);
  for (;;) {
    const srv = await serverSessionModel(sessionId);
    const shown = srv.listed ? `${srv.model ?? "(null)"} @ ${srv.provider ?? "(null)"}` : "not listed yet";
    if (srv.model === model) {
      const jrn = sessionLive(sessionId, 5, true).model ?? null;
      return {
        ok: true,
        detail: `server view: ${shown}${jrn ? `; session record: ${jrn}` : " (a session writes its journal on its first turn)"}`,
      };
    }
    const jrn = sessionLive(sessionId, 5, true).model ?? null;
    if (jrn === model) return { ok: true, detail: `session record: meta.model=${jrn} (server view: ${shown})` };
    if (Date.now() >= verifyDeadline) {
      return {
        ok: false,
        detail: `jcode debug returned 0 (${replied || "no body"}) but the session still reports ${shown}; session record: ${jrn ?? "none"}`,
      };
    }
    await sleep(400);
  }
}

/**
 * Open a VISIBLE PowerShell window running `jcode -p <provider>` in the repo.
 *
 * The launcher path is quoted INSIDE the argument string on purpose: Start-Process
 * joins an -ArgumentList array with spaces and does NOT quote elements, so this
 * repo's path ("...\Desktop\Default Project") used to arrive as
 * `-File C:\Users\user\Desktop\Default`, PowerShell failed the -File and exited,
 * and the window died before jcode ever started. One quoted string fixes it.
 *
 * A missing pid is retried: under heavy load (many agents opening windows at once)
 * Start-Process occasionally returns nothing, and one flaky spawn must not fail a
 * work order.
 */
async function spawnWorkerWindow(order: FleetOrder, wo: WorkOrder): Promise<{ pid: number; detail: string }> {
  const launcher = await launcherScript(order, wo);
  const repo = repoRoot();
  const argLine = `-NoLogo -NoExit -ExecutionPolicy Bypass -File "${launcher}"`;
  const inner =
    `Start-Process -FilePath 'powershell' ` +
    `-ArgumentList ${psQuote(argLine)} ` +
    `-WorkingDirectory ${psQuote(repo)} -PassThru | Select-Object -ExpandProperty Id`;
  const attempts = 3;
  let detail = "";
  for (let i = 1; i <= attempts; i++) {
    const r = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", inner], { timeoutMs: 30000 });
    const pid = Number(r.out.trim().split(/\r?\n/).pop() ?? "");
    if (Number.isFinite(pid) && pid > 0) return { pid, detail: i > 1 ? `pid after ${i} attempts` : "" };
    detail = `Start-Process gave no pid (exit ${r.code}${r.err.trim() ? `, stderr: ${r.err.trim().slice(0, 200)}` : ""})`;
    if (i < attempts) await sleep(1500);
  }
  return { pid: 0, detail };
}

/**
 * Identify the jcode session that belongs to the window we just spawned.
 *
 * PRECISE ONLY: the session's TUI client pid must be a descendant of the window
 * pid (client_sessions/<pid> holds the session id). A looser "newest new session
 * in this repo" guess is OPT-IN (FLEET_LOOSE_MATCH=1) because it misfired in
 * anger: with the manager spawning its own windows at the same moment, it matched
 * a PEER's session and delivered this order into the wrong terminal. Failing a
 * work order is much better than ordering the wrong worker around.
 *
 * It also gives up early when the window itself died, which is the signature of a
 * broken launcher (that is exactly how the missing-space bug above showed up).
 */
async function identifySession(windowPid: number, before: Set<string>): Promise<{ sessionId: string; detail: string }> {
  const deadline = Date.now() + spawnDetectMs();
  const repo = repoRoot().toLowerCase();
  const loose = process.env.FLEET_LOOSE_MATCH === "1";
  let windowWasAlive = false;
  while (Date.now() < deadline) {
    if (windowPid && pidAlive(windowPid)) windowWasAlive = true;
    if (windowPid && !windowWasAlive && !pidAlive(windowPid)) {
      return { sessionId: "", detail: `the spawned window (pid ${windowPid}) exited immediately - check the launcher` };
    }
    if (windowPid) {
      const tree = await descendantsOf(windowPid);
      for (const [sessionId, pid] of liveClientSessions()) {
        if (tree.has(pid) && !before.has(sessionId)) {
          return { sessionId, detail: `matched pid ${pid} inside the window tree (pid ${windowPid})` };
        }
      }
    }
    if (loose) {
      const candidates: Array<{ id: string; at: string }> = [];
      for (const [sessionId] of liveClientSessions()) {
        if (before.has(sessionId)) continue;
        try {
          const j = JSON.parse(fs.readFileSync(path.join(sessionsDir(), `${sessionId}.json`), "utf8")) as {
            working_dir?: string; created_at?: string;
          };
          if ((j.working_dir ?? "").toLowerCase() === repo) candidates.push({ id: sessionId, at: j.created_at ?? "" });
        } catch {
          // not written yet
        }
      }
      if (candidates.length) {
        candidates.sort((a, b) => b.at.localeCompare(a.at));
        return { sessionId: candidates[0].id, detail: `LOOSE match on working_dir (FLEET_LOOSE_MATCH=1): ${candidates[0].id}` };
      }
    }
    // PERF-BACKEND, 21:10: was a hard-coded 1000 ms (see detectPollMs). Yields the event
    // loop between snapshots; the shared cache makes each pass ~free.
    await sleep(detectPollMs());
  }
  return {
    sessionId: "",
    detail:
      `no live jcode session became a descendant of window pid ${windowPid} within ${Math.round(spawnDetectMs() / 1000)}s` +
      (loose ? " (loose match also found nothing)" : "; set FLEET_LOOSE_MATCH=1 to allow a working_dir guess"),
  };
}

/**
 * Deliver text into ONE specific live session.
 * Primary: `jcode transcript --mode send -S <sessionId>` (targeted, no focus).
 * Fallback: the focus-based method from the spec (only when targeting fails).
 */
async function deliverInto(
  sessionId: string,
  text: string,
  marker: string,
): Promise<{ ok: boolean; how: "targeted" | "focused" | "none"; detail: string }> {
  if (!sessionId) return { ok: false, how: "none", detail: "no session id" };

  // 1. targeted
  const targeted = await run(jcodeBin(), ["transcript", "--mode", "send", "-S", sessionId], {
    stdin: text,
    timeoutMs: 45000,
  });
  let detail = `targeted: exit=${targeted.code}${targeted.err.trim() ? ` err=${targeted.err.trim().slice(0, 160)}` : ""}`;
  if (await waitForMarker(sessionId, marker)) return { ok: true, how: "targeted", detail };

  // 2. focus-based fallback (spec's original method; racy, so it is only a fallback)
  const focusedFile = path.join(jcodeStateDir(), "last_focused_client_session");
  const focusDeadline = Date.now() + 15000;
  while (Date.now() < focusDeadline && readTrimmed(focusedFile) !== sessionId) await sleep(500);
  const focused = readTrimmed(focusedFile) === sessionId;
  detail += `; focus=${focused ? "matched" : "never became focused"}`;
  if (focused) {
    const viaFocus = await run(jcodeBin(), ["transcript", "--mode", "send"], { stdin: text, timeoutMs: 45000 });
    detail += `; focused: exit=${viaFocus.code}`;
    if (await waitForMarker(sessionId, marker)) return { ok: true, how: "focused", detail };
  }
  return { ok: false, how: "none", detail: `${detail}; brief never appeared in the session` };
}

async function waitForMarker(sessionId: string, marker: string): Promise<boolean> {
  const deadline = Date.now() + deliverVerifyMs();
  while (Date.now() < deadline) {
    if (sessionHasMarker(sessionId, marker)) return true;
    await sleep(1000);
  }
  return sessionHasMarker(sessionId, marker);
}

// ── briefing ──────────────────────────────────────────────────────────

function workerPreamble(): string {
  return [
    "Read docs/AGENT_COORDINATION.md first and obey the file ownership. Edit ONLY the files in your `owns` list.",
    "Never stop/restart the router on :8787 or start another server on the live company/ (test servers: SLACK_BRIDGE=0, other PORT, temp COMPANY_ROOT). Never print secrets.",
    "Run `npx tsc --noEmit` if you touched TypeScript.",
  ].join(" ");
}

export function briefBody(order: FleetOrder, wo: WorkOrder, extra?: string): string {
  const report = reportPath(order.id, wo.id);
  return [
    `FLEET-ORDER ${order.id}/${wo.id}`,
    "",
    workerPreamble(),
    "",
    `ROLE: ${wo.role}`,
    `TITLE: ${wo.title}`,
    `REPO: ${repoRoot()}`,
    "",
    "YOU OWN (create/edit ONLY these paths):",
    ...(wo.owns.length ? wo.owns.map((o) => `  - ${o}`) : ["  - (the planner named no files; keep your edit to the smallest set and say what you touched)"]),
    "",
    "BRIEF:",
    wo.brief,
    "",
    "DONE (acceptance checks - all of them):",
    ...wo.done.map((d) => `  - ${d}`),
    ...(wo.review ? ["", "REVIEW NOTES from the previous attempt (a REDO was requested):", wo.review] : []),
    ...(extra ? ["", extra] : []),
    "",
    `FINISH: write ${report} with (1) what changed, (2) the files you touched,`,
    "(3) the exact commands you ran and their REAL output, (4) open issues. Then stop.",
  ].join("\n");
}

// ── planner ───────────────────────────────────────────────────────────

function repoDigest(): string {
  const repo = repoRoot();
  const list = (rel: string, limit = 60): string => {
    try {
      const names = fs.readdirSync(path.join(repo, rel), { withFileTypes: true })
        .filter((d) => !["node_modules", ".git", "company", "logs"].includes(d.name))
        .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
        .slice(0, limit);
      return `${rel}: ${names.join(", ")}`;
    } catch {
      return `${rel}: (missing)`;
    }
  };
  return [list("."), list("src"), list("src/company"), list("ops"), list("docs"), list("public"), list("public/v2/views")].join("\n");
}

/**
 * Raised when Claude could not even be reached because its sign-in is gone. Carries the
 * raw reasons so the order trace can show them; the CEO-facing sentence is the plain one.
 */
export class ClaudeSignInExpiredError extends Error {
  constructor(public readonly claudeWhy: string, public readonly fallbackWhy: string) {
    super(`${CLAUDE_SIGNIN_EXPIRED_MESSAGE} (Claude: ${claudeWhy}; fallback: ${fallbackWhy})`);
    this.name = "ClaudeSignInExpiredError";
  }
}

/**
 * Planner/reviewer model call with the CEO's rule for a Claude outage: "refer to Kimi".
 * Claude first (FLEET_PLANNER_MODEL / FLEET_REVIEWER_MODEL); if it is unavailable or at its
 * limit, the same prompt goes to the gateway fallback models IN ORDER - DeepSeek first, and
 * Kimi only if DeepSeek also failed - and the caller records which model answered.
 * Measured need: 21:00Z, Claude red in the budget module while the CEO ordered new work -
 * planning must not fail just because Claude is out.
 */
async function planOrReviewModel(
  model: string,
  system: string,
  user: string,
  purpose: "planning" | "review",
  forceVia?: "claude" | "kimi",
  /**
   * CHEAP BY DEFAULT: the cheap-failure counter's key for the gate's safety net. A retried work
   * order MUST pass a stable key (e.g. `review:${order.id}:${wo.id}`): the default key hashes the
   * prompt, and the prompt carries the previous report/evidence, so it changes on every retry and
   * the count would never reach 2 - the climb would never fire where it is needed most.
   */
  failureKey?: string,
): Promise<{ text: string; via: "claude" | "kimi"; detail: string; gate?: { tier: string; model: string; reason: string } }> {
  // NY-RESOLVER: CEO explicitly chose to skip Claude and use the gateway fallback.
  if (forceVia === "kimi") {
    return fallbackAsk(system, user, " (forced by CEO choice)");
  }
  try {
    const r = await callClaudeSubscription({
      model,
      system,
      user,
      cwd: repoRoot(),
      addDirs: [getCompanyRoot()],
      // BRAIN ROUTING: the fleet's own planning/review discriminator decides the
      // purpose; `model` (FLEET_PLANNER_MODEL / FLEET_REVIEWER_MODEL) is the MAX tier.
      purpose: purpose === "planning" ? "fleet-plan" : "review",
      ...(failureKey ? { failureKey } : {}),
    });
    const text = (r?.text ?? "").trim();
    if (!text) throw new Error("empty response");
    // CHEAP BY DEFAULT: hand the gate's decision back to the caller so the trace can say
    // which tier actually ran (a `none` tier is a Go gateway model, not Claude).
    const gate = r.brain ? { tier: r.brain.tier, model: r.brain.model, reason: r.brain.reason } : undefined;
    return { text, via: "claude", detail: `${model}`, ...(gate ? { gate } : {}) };
  } catch (e) {
    const why = String(e).slice(0, 160);
    const signInLost = mentionsClaudeSignInExpired(e);
    console.warn(
      `[fleet] ${purpose}: Claude ${model} unavailable (${why}); falling back to ${fallbackModels().join(" then ")}`,
    );
    try {
      return await fallbackAsk(system, user, ` (Claude ${model} unavailable: ${why})`);
    } catch (fbErr) {
      // Both brains are down. Say WHICH failed and WHY, instead of reporting only the Claude 429 -
      // otherwise a fallback outage looks like "Claude is rate-limited" and hides the real cause.
      const fbWhy = String(fbErr).slice(0, 300);
      // An expired sign-in is not a model problem and cannot be fixed by retrying: the CEO has to
      // run `claude /login`. Mark it so the caller fails ONCE, with one plain sentence, instead of
      // looping the bounded retry and asking "Retry this order or drop it?".
      if (signInLost) throw new ClaudeSignInExpiredError(why, fbWhy);
      throw new Error(`${purpose}: Claude ${model} failed (${why}) AND the gateway fallback failed (${fbWhy})`);
    }
  }
}

/**
 * Ask the gateway fallback models IN ORDER (DeepSeek first, Kimi only if DeepSeek failed) and
 * return the first usable answer. `suffix` is appended to the human-readable detail so the
 * order trace says WHY the fallback was used. Throws with every model's failure listed.
 */
async function fallbackAsk(
  system: string,
  user: string,
  suffix: string,
): Promise<{ text: string; via: "kimi"; detail: string }> {
  const models = fallbackModels();
  const failed: string[] = [];
  // The first answer that was a TOOL CALL rather than prose (see classifyPlannerReply).
  let toolCallReply: { text: string; detail: string } | null = null;
  for (let attempt = 1; attempt <= fallbackTries(); attempt++) {
    for (const m of models) {
      try {
        const r = await callGatewayModel(m, system, `${user}${fallbackNote()}`, { maxTokens: fallbackMaxTokens() });
        const text = (r?.text ?? "").trim();
        if (!text) throw new Error(`empty response${r.meta?.reasoningLen ? ` (reasoning only, ${r.meta.reasoningLen} chars)` : ""}`);
        // A reasoning model can answer with reasoning ONLY (finish_reason "stop", content "").
        // If the reply does not look like the JSON we asked for, treat it as a failed attempt and
        // try again (next model, then the next pass), instead of handing back prose that parses to
        // nothing - one wasted sample must not fail the order.
        if (!/[{\[]/.test(text)) {
          // MEASURED 2026-10-01 (orders fomupdu7ne / fomupdu7w2 / fomupdu87j): when the order says
          // "read file X first", the cheap tier answers with a TOOL-CALL block instead of the JSON.
          // That is not "no JSON" to walk past in silence: it is a specific failure the planner has
          // to NAME and retry (classifyPlannerReply + planOrder's retry). Keep walking the chain,
          // but remember the first tool-call answer and hand it back if nothing usable came.
          //
          // MARKUP ONLY is handed back: a short prose answer must keep the old behaviour (all
          // passes fail -> the caller's real error, e.g. the expired-sign-in sentence -
          // ops/fleet-signin-fallback-variant-check.ts asserts exactly that).
          if (!toolCallReply && hasToolCallMarkup(text)) {
            toolCallReply = { text, detail: `${m} pass${attempt} answered a tool call (${text.length} chars, no JSON)` };
          }
          failed.push(`${m} pass${attempt}: ${text.length} chars with no JSON`);
          continue;
        }
        const skipped = failed.length ? `; ${failed.join(" | ")}` : "";
        const pass = attempt > 1 ? ` (pass ${attempt})` : "";
        return { text, via: "kimi", detail: `${m}${pass}${suffix}${skipped}` };
      } catch (e) {
        failed.push(`${m} pass${attempt} failed (${String(e).slice(0, 120)})`);
      }
    }
  }
  // Nothing usable came back. If some model DID answer, and its answer was a tool call, return
  // that answer so the planner can name the failure kind and run its retry - throwing
  // "no fallback model answered" here would hide the one diagnosable thing we have.
  if (toolCallReply) {
    const skipped = failed.length ? `; ${failed.join(" | ")}` : "";
    return { text: toolCallReply.text, via: "kimi", detail: `${toolCallReply.detail}${suffix}${skipped}` };
  }
  throw new Error(`no fallback model answered in ${fallbackTries()} pass(es) (tried ${models.join(", ")}): ${failed.join("; ").slice(0, 300)}`);
}

type PlannedOrder = { id?: string; title?: string; role?: string; projectId?: string; owns?: unknown; brief?: string; done?: unknown };

function parseJsonObject(raw: string): unknown | null {
  const cleaned = String(raw ?? "").replace(/```[a-zA-Z]*/g, "");
  let idx = cleaned.indexOf("{");
  while (idx >= 0) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = idx; i < cleaned.length; i++) {
      const c = cleaned[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(cleaned.slice(idx, i + 1));
          } catch {
            break;
          }
        }
      }
    }
    idx = cleaned.indexOf("{", idx + 1);
  }
  return null;
}

const PLANNER_SYSTEM = [
  "You are Claude, the manager of a small engineering company. Your CEO gives you one order.",
  "You split it into work orders that can run in PARALLEL, each in its own visible jcode terminal, each owning a disjoint set of files.",
  "You may Read/Glob/Grep the repository to ground the plan in the real code. Never guess a file path you can check.",
  "Rules:",
  "- 2 to 5 work orders. Small and independent beat large and entangled.",
  "- `owns` lists repo-relative files or globs. NO OVERLAP between orders. If two orders must touch a file, merge them.",
  "- `brief` is self-contained: a fresh agent with no context must be able to do the work from it alone.",
  "- Do NOT put the worker rules or the REPORT.md path inside `brief`: the fleet prepends its own preamble and appends the real report path.",
  "- `done` lists concrete acceptance checks (a command, a file that must exist, a behaviour).",
  "- If the orders share a contract (a data shape, a file one writes and another reads), also return `specDoc` with the spec to write first.",
  "OUTPUT FORMAT - this is a hard REQUIREMENT:",
  "- Your ENTIRE reply must be ONE JSON object and NOTHING else. No prose, no explanation, no markdown, no code fences,",
  "  no text before or after it. The first character must be '{' and the last must be '}'.",
  "- Shapes: plan is a markdown string for the CEO; specDoc is an object or null; workOrders is an array with the keys below.",
  '{"plan":"markdown plan for the CEO","specDoc":{"path":"docs/NAME_SPEC.md","content":"..."}|null,',
  ' "workOrders":[{"id":"SHORT-ID","title":"...","role":"SHORT-ID","owns":["path"],"brief":"...","done":["..."]}]}',
  "If you are tempted to explain your plan in prose first, put that prose INSIDE the plan string instead.",
].join("\n");

function mockPlan(order: FleetOrder): { plan: string; specDoc?: string; workOrders: WorkOrder[] } {
  const wos: WorkOrder[] = [
    {
      id: "WO-A", title: "Mock work order A", role: "MOCK-A", owns: [`company/fleet/${order.id}/WO-A/`],
      brief: "Mock planner (MOCK_MODE) - no real work.", done: ["nothing to do"], state: "planned", attempts: 0,
    },
    {
      id: "WO-B", title: "Mock work order B", role: "MOCK-B", owns: [`company/fleet/${order.id}/WO-B/`],
      brief: "Mock planner (MOCK_MODE) - no real work.", done: ["nothing to do"], state: "planned", attempts: 0,
    },
  ];
  return { plan: "MOCK PLAN (MOCK_MODE=1): two parallel work orders.", workOrders: wos };
}

/**
 * Pull the plan object out of a planner reply.
 *
 * `parseJsonObject` alone is NOT enough on the fallback path: it returns the outermost balanced
 * object, so a reply wrapped in one key ({"result":{...}}) parsed "fine" and then produced ZERO
 * work orders and ZERO warnings - the run failed with "the planner produced no usable work
 * orders" and the trace said nothing about why. Measured 2026-09-30 on the planning fallback.
 *
 * MEASURED FAILURE (2026-09-30, attempt 1 and 3 of the flakiness harness): a reasoning model
 * under a large output budget sometimes emits a TOOL-CALL artifact instead of the plan -
 * `{"file_path": "..."}` (28.3 kB of reasoning, no plan) or `{"path": "..."}` - and blindly
 * unwrapping the "single wrapper key" returned THAT object, so the plan became empty and no
 * work order was built. The unwrap is therefore keyed to the wrapper names a model actually
 * uses, and a reply that resolves to no work orders is reported as UNPARSED (never as a silent
 * empty plan).
 *
 * Tolerated: a bare object (Claude's contract), a fenced block, an object nested under a known
 * wrapper key, and `work_orders` as an alias for `workOrders`.
 */
const PLAN_WRAPPER_KEYS = ["result", "response", "output", "data", "plan", "content", "message", "json"];

function countWorkOrders(node: Record<string, unknown>): number {
  if (Array.isArray(node.workOrders)) return node.workOrders.length;
  if (Array.isArray(node.work_orders)) return node.work_orders.length;
  return -1;
}

function extractPlanObject(raw: string): Record<string, unknown> | null {
  const first = parseJsonObject(raw);
  if (!first || typeof first !== "object" || Array.isArray(first)) return null;
  const root = first as Record<string, unknown>;
  const candidates: Array<Record<string, unknown>> = [root];
  const seen = new Set<Record<string, unknown>>([root]);
  const queue = [root];
  while (queue.length && candidates.length < 6) {
    const node = queue.shift()!;
    const keys = Object.keys(node);
    const onlyKey = keys.length === 1 ? keys[0]! : "";
    // Recurse ONLY into a kNOWN wrapper key (never into an arbitrary single key: `file_path`,
    // `path`, `content` as a tool-call artifact must not swallow the plan).
    const nested = onlyKey && PLAN_WRAPPER_KEYS.includes(onlyKey.toLowerCase()) ? node[onlyKey] : undefined;
    if (nested && typeof nested === "object" && !Array.isArray(nested) && !seen.has(nested as Record<string, unknown>)) {
      const next = nested as Record<string, unknown>;
      seen.add(next);
      candidates.push(next);
      queue.push(next);
    }
    // Also descend into a known wrapper key even when other keys are present (a plan carried
    // alongside metadata such as {id, result:{...}}).
    for (const k of keys) {
      if (!PLAN_WRAPPER_KEYS.includes(k.toLowerCase())) continue;
      const v = node[k];
      if (v && typeof v === "object" && !Array.isArray(v) && !seen.has(v as Record<string, unknown>)) {
        seen.add(v as Record<string, unknown>);
        candidates.push(v as Record<string, unknown>);
      }
    }
  }
  const withOrders = candidates.find((c) => countWorkOrders(c) > 0);
  if (withOrders) return withOrders;
  // No work orders anywhere: prefer a candidate that at least looks like a plan, else the root.
  const planish = candidates.find((c) => typeof c.plan === "string" || typeof c.plan === "object");
  if (planish && countWorkOrders(planish) >= 0) return planish;
  // A pure tool-call artifact with no work orders and no plan is NOT a plan: return null so the
  // caller reports "did not return parseable JSON" (with the keys in the trace) instead of
  // silently shipping an empty plan.
  return countWorkOrders(root) >= 0 ? root : null;
}

// ── planner reply classification + tool confinement (2026-10-01) ───────
//
// MEASURED (2026-10-01, orders fomupdu7ne / fomupdu7w2 / fomupdu87j): when the order text says
// "Read docs/X.md first" and the planner call lands on a cheap tier (the gate read the order as
// small, or the inner gate answered `none` while the outer one said Claude), the model tries to
// CALL A TOOL the planner does not have - it has NO tools at all, it only writes JSON. The whole
// reply was a tool-call block, e.g.
//   <|DSML| calls> <|DSML| invoke name="Read"> <|DSML| parameter name="file_path">...docs\PERF_PLAN_2026-10-01.md
// planOrder stored that markup as the "plan", created ZERO work orders and failed the order with
// "the planner did not return parseable JSON" - a sentence that says nothing about WHAT came back,
// so the next failure is undiagnosable without the logs.
//
// The reply is therefore put in its own failure KIND, retried ONCE on the same model with the tool
// confinement spelled out and the files the order named inlined (so "read X first" is satisfied
// without a tool), and only then escalated one tier (Sonnet).

/** Planner replies that are a TOOL CALL, not prose: the model asking for a tool it does not have. */
export const PLANNER_TOOL_CALL_MARKERS: RegExp[] = [
  /DSML/i, // the DeepSeek/Claude-Code style markup measured on 2026-10-01
  /<\s*\|/, // <|tool_call|>, <|function_call|>, ...
  /<\s*\/?\s*(tool_call|tool_calls|function_call|invoke|parameter|antml:invoke)\b/i,
  /\binvoke\s+name\s*=/i,
  /"tool_calls"\s*:/i,
  /\bfunction_call\b/i,
];

/** No `{` at all and no real answer either: a stub, not prose. */
const PLANNER_STUB_MAX_CHARS = 200;

export type PlannerReplyKind = "tool-call" | "truncated" | "prose";

/** Does this reply carry tool-call markup (an unmistakable attempt to call a tool)? */
export function hasToolCallMarkup(raw: string): boolean {
  const text = String(raw ?? "").trim();
  return !!text && PLANNER_TOOL_CALL_MARKERS.some((re) => re.test(text));
}

/** Does this reply look like the model trying to call a tool instead of answering? */
export function looksLikeToolCallReply(raw: string): boolean {
  const text = String(raw ?? "").trim();
  if (!text) return true;
  if (hasToolCallMarkup(text)) return true;
  // "empty/very short text with no {" is a tool-call-shaped no-answer too: the model produced
  // neither JSON nor an explanation (a real explanation is "prose" - see classifyPlannerReply).
  return !text.includes("{") && text.length <= PLANNER_STUB_MAX_CHARS;
}

/**
 * Name WHY a reply that is not a plan is not a plan, so the trace says it without the logs:
 *   tool-call - the model asked for a tool (DSML markup, `<tool_call>`, `invoke name=`, ...) or
 *               answered with nothing/almost nothing and no JSON at all;
 *   truncated - a JSON object started and never closed (a reasoning model cut off by max_tokens);
 *   prose     - an actual explanation with no JSON in it.
 */
export function classifyPlannerReply(raw: string): PlannerReplyKind {
  const text = String(raw ?? "").trim();
  if (looksLikeToolCallReply(text)) return "tool-call";
  return text.includes("{") ? "truncated" : "prose";
}

/** The retry's extra instruction - verbatim from the fix spec ("read X first" cannot be honoured
 *  by a planner that has no tools, so it is told so and handed the file contents). */
export const PLANNER_NO_TOOLS_INSTRUCTION =
  "You have no tools and cannot read files. Everything you need is in the order text. Reply with ONLY the JSON object.";

/** Bytes of each named file that are inlined into the retry prompt. */
const PLANNER_INLINE_MAX_BYTES = 12 * 1024;
const PLANNER_INLINE_MAX_FILES = 6;
/** Never inline a file that could carry a credential (no secrets into a model prompt). */
const PLANNER_INLINE_SKIP = /(^|[\\/])\.env($|[./\\])|credential|secret|id_rsa|\.(pem|key|pfx|p12|kdbx)$/i;

/** A token shaped like a repo-relative path with a file extension. */
function looksLikeRepoPath(tok: string): boolean {
  return /^[\w.@-]+(?:[\\/][\w.@-]+)+\.[A-Za-z0-9]{1,6}$/.test(tok);
}

/**
 * The contents of the files the ORDER TEXT names, for the retry prompt: the work order asks for
 * "any file the order text names (docs/*.md under the repo, size-capped ~12 KB each)" so that
 * "read X first" is actually satisfied without a tool. docs/*.md first, at most 6 files, and
 * never a secret-bearing file. Returns [] when the order names nothing readable.
 */
export function plannerOrderFiles(text: string): Array<{ rel: string; content: string }> {
  const root = repoRoot();
  const tokens = String(text ?? "").split(/[\s"'`<>()\[\],;]+/);
  const seen = new Set<string>();
  const found: Array<{ rel: string; abs: string }> = [];
  for (const raw of tokens) {
    const tok = raw.replace(/[.,:;]+$/, "");
    if (!tok || tok.length > 260) continue;
    const abs = path.isAbsolute(tok)
      ? path.resolve(tok)
      : looksLikeRepoPath(tok)
        ? path.resolve(root, tok)
        : null;
    if (!abs) continue;
    const rel = path.relative(root, abs);
    // Only files INSIDE the repo, and never a credential-shaped one.
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    if (PLANNER_INLINE_SKIP.test(rel)) continue;
    const key = rel.toLowerCase().replace(/\\/g, "/");
    if (seen.has(key)) continue;
    try {
      if (!fs.statSync(abs).isFile()) continue;
    } catch {
      continue; // named but not on disk: nothing to inline
    }
    seen.add(key);
    found.push({ rel: rel.replace(/\\/g, "/"), abs });
  }
  const rank = (rel: string) => (/^docs\//i.test(rel) && /\.md$/i.test(rel) ? 0 : /\.md$/i.test(rel) ? 1 : 2);
  found.sort((a, b) => rank(a.rel) - rank(b.rel) || a.rel.localeCompare(b.rel));
  const out: Array<{ rel: string; content: string }> = [];
  for (const f of found.slice(0, PLANNER_INLINE_MAX_FILES)) {
    try {
      const buf = fs.readFileSync(f.abs);
      const cut = buf.subarray(0, PLANNER_INLINE_MAX_BYTES).toString("utf8");
      out.push({ rel: f.rel, content: cut + (buf.length > PLANNER_INLINE_MAX_BYTES ? "\n...[truncated at 12 KB]" : "") });
    } catch {
      /* unreadable: skip it */
    }
  }
  return out;
}

/** The retry's user prompt: the tool confinement plus the contents of the files the order named. */
export function plannerRetryBlock(files: Array<{ rel: string; content: string }>): string {
  const body = files.length
    ? files.map((f) => `### ${f.rel}\n${f.content}`).join("\n\n")
    : "(The order text names no readable file, so there is nothing to read.)";
  return [
    PLANNER_NO_TOOLS_INSTRUCTION,
    "",
    "Your previous reply was a tool call. There is no tool to call and nothing to wait for; the",
    "files the order named are reproduced below, verbatim.",
    "",
    body,
    "",
    "Now reply with ONLY the JSON object described in your instructions (one object, the first",
    "character '{', the last character '}').",
  ].join("\n");
}

function normalizeWorkOrders(obj: Record<string, unknown>, order: FleetOrder, warn: string[]): WorkOrder[] {
  const raw = Array.isArray(obj.workOrders)
    ? obj.workOrders
    : Array.isArray(obj.work_orders)
      ? obj.work_orders
      : [];
  const out: WorkOrder[] = [];
  const claimed = new Map<string, string>();
  raw.forEach((item, i) => {
    if (!item || typeof item !== "object") return;
    const p = item as PlannedOrder;
    const title = typeof p.title === "string" ? p.title.trim() : "";
    const brief = typeof p.brief === "string" ? p.brief.trim() : "";
    if (!title || !brief) {
      warn.push(`Dropped work order #${i + 1}: it had no title or no brief.`);
      return;
    }
    const id = sanitizeId(typeof p.id === "string" && p.id.trim() ? p.id.trim() : `WO${i + 1}`).toUpperCase();
    const owns = (Array.isArray(p.owns) ? p.owns : []).filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim());
    const done = (Array.isArray(p.done) ? p.done : []).filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim());
    for (const own of owns) {
      const owner = claimed.get(own);
      if (owner) warn.push(`Overlap: "${own}" is claimed by both ${owner} and ${id}. Tell them the same edit; a race will lose one of them.`);
      else claimed.set(own, id);
    }
    out.push({
      id: out.some((w) => w.id === id) ? `${id}-${out.length + 1}` : id,
      title,
      role: typeof p.role === "string" && p.role.trim() ? p.role.trim() : id,
      ...(typeof p.projectId === "string" && p.projectId.trim()
        ? { projectId: p.projectId.trim() }
        : order.projectId
          ? { projectId: order.projectId }
          : {}),
      owns,
      brief,
      done: done.length ? done : ["The brief is satisfied."],
      state: "planned",
      attempts: 0,
    });
  });
  return out;
}

/**
 * CHEAP BY DEFAULT (docs/CHEAP_BY_DEFAULT_SPEC.md Job 2): the small-order plan.
 *
 * When the gate says the order is not big, the fleet makes NO planner model call at all and
 * sends ONE work order straight to a worker (the CEO's "skip the Claude plan, one worker
 * order" path). The order text IS the brief - there is no manager plan to follow - and the
 * acceptance checks are the ones the brief's own rule can state without a model: the work is
 * done and REPORT.md exists. Nothing here guesses at file ownership: `owns` stays empty and
 * `briefBody` already tells the worker to keep its edit to the smallest set and name what it
 * touched, which is what the reviewer reads.
 */
function cheapPlan(order: FleetOrder): { plan: string; workOrders: WorkOrder[] } {
  const text = String(order.text ?? "").trim();
  const firstLine = (text.split(/\r?\n/)[0] ?? "").trim();
  const title = (firstLine || `Order ${order.id}`).slice(0, 90);
  const wo: WorkOrder = {
    id: "WO1",
    title,
    role: "coder",
    owns: [],
    brief: [
      "The CEO's order, verbatim. This work order was built LOCALLY because the Laya gate read the order as SMALL: no planner model was called, so there is no manager plan to follow - the order text below IS the brief.",
      text,
    ].join("\n\n"),
    done: [
      "the work asked for in the CEO order is done",
      "REPORT.md exists and says what changed, which files were touched, the exact commands run and their real output",
    ],
    state: "planned",
    attempts: 0,
  };
  return {
    plan: "cheap default (the Laya gate read this order as small): one work order, no planner model call, no Claude plan.",
    workOrders: [wo],
  };
}

async function planOrder(orderId: string, forceAutoApprove = false): Promise<void> {
  const orders = loadFleetOrders();
  const order = orders.find((o) => o.id === orderId);
  if (!order) return;
  // RESUME_SPEC 1: claim the planning with our pid and count the attempt, so a boot
  // after a crash can tell "planning never finished" from "planning succeeded".
  order.planAttempts = (order.planAttempts ?? 0) + 1;
  order.plannerPid = process.pid;
  pushTrace(order, { from: "CEO", to: "Claude (manager)", what: "order", detail: order.text.slice(0, 400) });
  saveFleetOrders(orders);

  let planText = "";
  let workOrders: WorkOrder[] = [];
  const warn: string[] = [];
  // Unconditional, shape-only diagnostics for the planner answer. A "no usable work orders"
  // failure used to be undiagnosable: the trace said nothing about WHAT came back. This records
  // the model, the fallback hop, the raw text length, whether it parsed, how many work orders it
  // carried and every dropped-work-order warning. No content, no secrets.
  const phases: Record<string, unknown> = {};

  // CHEAP BY DEFAULT: ask the gate ONCE for this order (logged there), so a small order never
  // reaches a planner. When the gate DOES say Claude, `planOrReviewModel` below asks it again
  // and that inner answer is the one that decides the real call.
  const forcedKimi = order.forceProvider === "kimi";
  if (forcedKimi) {
    pushTrace(order, {
      from: "Fleet",
      to: "Claude (manager)",
      what: "skip Claude (forced kimi)",
      detail: "CEO chose Kimi for this order; bypassing the brain gate and Claude planner",
    });
    saveFleetOrders(orders);
  }
  const planGate = config.mockMode || forcedKimi ? undefined : await pickBrain({ purpose: "fleet-plan", text: order.text, needsFiles: true });
  if (config.mockMode) {
    const mock = mockPlan(order);
    planText = mock.plan;
    workOrders = mock.workOrders;
    warn.push("MOCK_MODE=1: used the built-in mock plan, no planning model was called.");
  } else if (planGate && !planGate.claudeCall) {
    // The gate says this order is small, so do not spend a planner call at all.
    //
    // NB this deliberately keys off `!claudeCall` and NOT the small `fileBlind` flag that
    // `none` picks normally carry for `fleet-plan` (see PURPOSE_RULES.gatewayFallback). The
    // cheap-default contract is "a not-big order costs ONE locally built work order and ZERO
    // model calls", and ops/cheap-default-check.ts asserts exactly that. The `gatewayFallback`
    // flag only relaxes the separate needsFiles heuristic; it must not spend a call here.
    const cheap = cheapPlan(order);
    planText = cheap.plan;
    workOrders = cheap.workOrders;
    pushTrace(order, {
      from: "Laya (brain)",
      to: "Fleet rules",
      what: "one work order, no planner",
      detail: `${planGate.reason} (${planGate.model})`,
    });
  } else {
    const plannerUser = [
      `CEO ORDER:\n${order.text}`,
      "",
      `REPO (${repoRoot()}):`,
      repoDigest(),
      "",
      "Plan it now. Reply with only the JSON object.",
    ].join("\n");
    // TOOL-CALL RECOVERY (2026-10-01): the planner has no tools. See the classification block above
    // for the measured failure this exists for. `failureKey` is stable per order, so the gate's
    // cheap-failure counter is about THIS work (the default key hashes the prompt).
    const failureKey = `fleet-plan:${order.id}`;
    const inlineFiles = plannerOrderFiles(order.text);
    if (inlineFiles.length) phases.inlineFiles = inlineFiles.map((f) => f.rel);
    let climbNoted = false;

    type PlannerStep = { text: string; via: string; detail: string; gate?: { tier: string; model: string; reason: string } };
    const askPlanner = async (opts2: { retry?: boolean; escalate?: boolean } = {}): Promise<PlannerStep> => {
      if (opts2.escalate) {
        // CHEAP BY DEFAULT (docs/CHEAP_BY_DEFAULT_SPEC.md Job 2): the gate climbs ONE tier - Sonnet -
        // when this work has already failed twice on the cheap tier. This plan call HAS failed twice
        // (the tool-call reply, then the retry), so both failures are booked and the GATE makes the
        // climb with its own recorded reason. Routing is unchanged: only the counter is filled in.
        noteCheapFailure(failureKey);
        noteCheapFailure(failureKey);
        climbNoted = true;
      }
      const user = opts2.retry ? `${plannerUser}\n\n${plannerRetryBlock(inlineFiles)}` : plannerUser;
      const planned = await planOrReviewModel(plannerModel(), PLANNER_SYSTEM, user, "planning", forcedKimi ? "kimi" : undefined, failureKey);
      if (planned.via === "kimi") {
        pushTrace(order, { from: "Fleet", to: "Claude (manager)", what: "planner via kimi", detail: planned.detail });
      }
      return { text: planned.text, via: planned.via, detail: planned.detail, ...(planned.gate ? { gate: planned.gate } : {}) };
    };

    try {
      let step = await askPlanner();
      let attempts = 1;
      let parsed = extractPlanObject(step.text);
      let kind: PlannerReplyKind | null = parsed ? null : classifyPlannerReply(step.text);

      if (!parsed && kind === "tool-call") {
        // The measured failure: the model tried to CALL A TOOL it does not have (it said "Read
        // docs/X.md first" to itself). Retry ONCE on the same model with the confinement spelled
        // out and the files the order named inlined, so "read X first" is satisfied without a tool.
        pushTrace(order, {
          from: "Fleet",
          to: "Claude (manager)",
          what: "planner replied with a tool call; retrying once",
          detail: `kind=tool-call; ${step.detail}; ${step.text.length} chars; inlined ${inlineFiles.length} file(s) the order named`,
        });
        step = await askPlanner({ retry: true });
        attempts++;
        parsed = extractPlanObject(step.text);
        kind = parsed ? null : classifyPlannerReply(step.text);

        if (!parsed && !forcedKimi) {
          // Twice failed -> ONE climb (Sonnet), per the cheap-by-default rule. The reason goes on
          // the trace, so the escalated attempt is visible without the logs.
          pushTrace(order, {
            from: "Fleet",
            to: "Claude (manager)",
            what: "planner still not a plan; escalating one tier",
            detail: `kind=${kind}; the cheap-failure safety net books the two failed attempts so the gate climbs to Sonnet once`,
          });
          step = await askPlanner({ retry: true, escalate: true });
          attempts++;
          parsed = extractPlanObject(step.text);
          kind = parsed ? null : classifyPlannerReply(step.text);
          pushTrace(order, {
            from: "Fleet",
            to: "Claude (manager)",
            what: "escalated planner attempt",
            detail: `kind=${kind ?? "plan"}; ran as ${step.gate ? `${step.gate.tier}/${step.gate.model}` : step.via}`,
          });
        } else if (!parsed && forcedKimi) {
          pushTrace(order, {
            from: "Fleet",
            to: "Claude (manager)",
            what: "no escalation (provider forced)",
            detail: `kind=${kind}; the CEO pinned this order to ${order.forceProvider}, so there is no tier to climb`,
          });
        }
      }

      phases.via = step.via;
      phases.detail = step.detail.slice(0, 120);
      phases.textLen = step.text.length;
      phases.attempts = attempts;
      phases.parsed = !!parsed;
      if (!parsed) {
        // The KIND names what came back, so the next failure is diagnosable without the logs.
        phases.kind = kind;
        warn.push(`The planner did not return parseable JSON (kind: ${kind}); its raw output is shown as the plan and no work orders were created.`);
        planText = (step.text ?? "").trim().slice(0, 4000);
      } else {
        const obj = parsed;
        planText = typeof obj.plan === "string" ? obj.plan.trim() : "";
        workOrders = normalizeWorkOrders(obj, order, warn);
        phases.keys = Object.keys(obj).slice(0, 10);
        phases.rawWorkOrders = Array.isArray(obj.workOrders) ? obj.workOrders.length : Array.isArray(obj.work_orders) ? obj.work_orders.length : "none";
        phases.orders = workOrders.length;
        if (!workOrders.length) {
          // Never fail a plan silently: this used to record "no usable work orders" with an
          // empty trace, which hid a whole class of fallback answers (a wrapper object, an
          // empty workOrders array, a refusal) behind one useless sentence.
          const keys = Object.keys(obj).slice(0, 8).join(", ") || "none";
          warn.push(`The planner's JSON carried no usable work orders (keys: ${keys}).`);
        }
        const spec = obj.specDoc as { path?: unknown; content?: unknown } | null | undefined;
        if (spec && typeof spec.path === "string" && typeof spec.content === "string" && spec.path.trim() && spec.content.trim()) {
          try {
            const rel = path.relative(repoRoot(), path.resolve(repoRoot(), spec.path));
            if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
              const abs = path.join(repoRoot(), rel);
              if (fs.existsSync(abs)) {
                warn.push(`Spec doc ${rel} already exists; wrote docs/FLEET_${order.id}_SPEC.md instead.`);
                const alt = path.join(repoRoot(), "docs", `FLEET_${order.id}_SPEC.md`);
                fs.writeFileSync(alt, spec.content);
                order.specDoc = path.relative(repoRoot(), alt).replace(/\\/g, "/");
              } else {
                fs.mkdirSync(path.dirname(abs), { recursive: true });
                fs.writeFileSync(abs, spec.content);
                order.specDoc = rel.replace(/\\/g, "/");
              }
            } else {
              warn.push(`The planner tried to write a spec doc outside the repo (${spec.path}); ignored.`);
            }
          } catch (e) {
            warn.push(`Could not write the spec doc: ${String(e).slice(0, 160)}.`);
          }
        }
      }
    } catch (e) {
      // Diagnostic on the FAILURE path as well: a thrown fallback used to leave `phases` unlogged,
      // so "the fallback failed" was invisible exactly when it mattered most (measured
      // 2026-09-30: the prose/HTTP-500 variants of the reachable-gateway check produced no
      // [fleet:plan:debug] line at all). Shapes only, same guard.
      if ((process.env.FLEET_PLANNER_DEBUG ?? "1") !== "0") {
        console.log(`[fleet:plan:debug] ${JSON.stringify({ ...phases, threw: String(e).slice(0, 200) })}`);
      }
      // EXPIRED CLAUDE SIGN-IN: retrying cannot fix it (only the CEO running `claude /login`
      // can), so fail the order ONCE with the one plain sentence - never the bounded retry
      // loop, and never a "Retry this order or drop it?" prompt. The raw reasons stay on the
      // trace; the CEO-facing error is the plain message.
      if (e instanceof ClaudeSignInExpiredError) {
        order.status = "failed";
        order.plannerPid = undefined;
        order.error = CLAUDE_SIGNIN_EXPIRED_MESSAGE;
        pushTrace(order, { from: "Claude (manager)", to: "CEO", what: "plan failed", detail: e.message });
        touched(order);
        saveFleetOrders(orders);
        return;
      }
      // Bounded retry: at most FLEET_PLAN_MAX_ATTEMPTS planning attempts in a row,
      // then the order fails with the reason (RESUME_SPEC 1: no endless retries).
      const attempts = order.planAttempts ?? 1;
      const why = String(e).slice(0, 400);
      if (attempts < planMaxAttempts()) {
        order.status = "planning";
        order.error = `planning attempt ${attempts}/${planMaxAttempts()} failed: ${why}`;
        pushTrace(order, { from: "Claude (manager)", to: "CEO", what: `planning retry ${attempts + 1}/${planMaxAttempts()}`, detail: why });
        touched(order);
        saveFleetOrders(orders);
        setTimeout(() => { void planOrder(orderId, forceAutoApprove); }, 2000).unref?.();
        return;
      }
      order.status = "failed";
      order.plannerPid = undefined;
      order.error = `planning failed ${attempts}x: ${why}`;
      pushTrace(order, { from: "Claude (manager)", to: "CEO", what: "plan failed", detail: order.error });
      touched(order);
      saveFleetOrders(orders);
      return;
    } finally {
      // The climb is SPENT once: whether the escalated attempt reached Claude (callClaudeSubscription
      // already forgets the counter) or fell back to the gateway, no other call inherits it.
      if (climbNoted) clearCheapFailures(failureKey);
    }
  }

  // Diagnostic: dump the planner's raw answer (shapes only) so a "no usable work orders"
  // failure can be understood instead of guessed. FLEET_PLANNER_DEBUG=0 turns it off.
  if ((process.env.FLEET_PLANNER_DEBUG ?? "1") !== "0") console.log(`[fleet:plan:debug] ${JSON.stringify(phases)}`);

  order.plan = planText || "(empty plan)";
  order.workOrders = workOrders;
  // Planning is done: release the claim so a boot never re-runs it (RESUME_SPEC 1).
  order.plannerPid = undefined;
  order.planAttempts = 0;
  order.error = undefined;
  // Warnings FIRST, then the work orders, then the verdict: u"plan readyu" must stay the LAST
  // hop of a successful plan (the UI reads the tail), and a failed plan must keep u"plan failedu"
  // last too - that ordering is what the reviewer and the dashboard key off.
  for (const w of warn) pushTrace(order, { from: "Claude (manager)", to: "CEO", what: "plan warning", detail: w });
  for (const w of workOrders) pushTrace(order, { from: "Claude (manager)", to: "jcode", what: `work order ${w.id}`, detail: w.title });
  if (!workOrders.length) {
    order.status = "failed";
    // Never fail silently: the earlier warnings say what the answer actually was.
    order.error = warn.length ? `the planner produced no usable work orders (${warn[0]!.slice(0, 200)})` : "the planner produced no usable work orders";
    pushTrace(order, { from: "Claude (manager)", to: "CEO", what: "plan failed", detail: order.error });
    touched(order);
    saveFleetOrders(orders);
    return;
  }

  order.status = "awaiting_approval";
  pushTrace(order, { from: "Claude (manager)", to: "CEO", what: "plan ready", detail: `${workOrders.length} work order(s), awaiting approval` });
  touched(order);
  saveFleetOrders(orders);

  // Push the approval question into INBOX now (optional; INBOX also derives it).
  await askCeoViaInbox({
    kind: "approval",
    title: "Approve the fleet plan",
    question: `Approve the plan for order ${order.id} so the workers can start? (${workOrders.length} work order(s))`,
    context: order.plan,
    source: { type: "fleet-plan", id: order.id },
  });

  if (forceAutoApprove || autoApprove()) {
    console.log(`[fleet] auto-approving ${order.id} (no CEO gate)`);
    await approveFleetOrder(order.id);
  }
}

export async function createFleetOrder(
  text: string,
  opts: { autoApprove?: boolean; forceProvider?: "kimi" | "claude"; retryCount?: number; retriedFrom?: string } = {},
): Promise<FleetOrder> {
  const instruction = String(text ?? "").trim();
  const order: FleetOrder = {
    id: `fo${Date.now().toString(36)}`,
    text: instruction,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: "planning",
    workOrders: [],
    trace: [],
    ...(opts.forceProvider ? { forceProvider: opts.forceProvider } : {}),
    // RETRY LOOP: carry the retry depth across copies, so the cap is per JOB and not per
    // order id (a fresh id used to reset every bound there was).
    ...(typeof opts.retryCount === "number" ? { retryCount: Math.max(0, Math.round(opts.retryCount)) } : {}),
    ...(opts.retriedFrom ? { retriedFrom: opts.retriedFrom } : {}),
  };
  const orders = loadFleetOrders();
  orders.unshift(order);
  saveFleetOrders(orders);
  if (!instruction) {
    order.status = "failed";
    order.error = "empty order text";
    saveFleetOrders(orders);
    return order;
  }
  const forceAuto = opts.autoApprove ?? autoApprove();
  if (order.forceProvider) {
    pushTrace(order, {
      from: "CEO",
      to: "Fleet",
      what: "force provider",
      detail: `planner/reviewer forced to ${order.forceProvider} by CEO choice`,
    });
    saveFleetOrders(orders);
  }
  // Planning is async: POST returns immediately with status "planning".
  void planOrder(order.id, forceAuto).catch((e) => console.error(`[fleet] planning ${order.id} failed: ${String(e)}`));
  return order;
}

// ── approve / spawn / queue ───────────────────────────────────────────

export type ApproveOptions = {
  workOrders?: Array<{ id?: string; title?: string; role?: string; projectId?: string; owns?: string[]; brief?: string; done?: string[] }>;
};

export async function approveFleetOrder(orderId: string, opts: ApproveOptions = {}): Promise<FleetOrder> {
  const orders = loadFleetOrders();
  const order = orders.find((o) => o.id === orderId);
  if (!order) throw new Error(`unknown fleet order ${orderId}`);
  if (order.status !== "awaiting_approval" && order.status !== "running") {
    throw new Error(`order ${orderId} is ${order.status}, not awaiting approval`);
  }

  if (Array.isArray(opts.workOrders) && opts.workOrders.length) {
    const edited: WorkOrder[] = opts.workOrders
      .filter((w) => w && (w.brief ?? "").trim() && (w.title ?? "").trim())
      .map((w, i) => {
        const prev = order.workOrders.find((p) => p.id === w.id);
        const id = sanitizeId(w.id ?? prev?.id ?? `WO${i + 1}`).toUpperCase();
        return {
          ...(prev ?? { state: "planned" as WorkOrderState, attempts: 0 }),
          id,
          title: (w.title ?? prev?.title ?? id).trim(),
          role: (w.role ?? prev?.role ?? id).trim(),
          ...(w.projectId ? { projectId: w.projectId } : {}),
          owns: (w.owns ?? prev?.owns ?? []).map((s) => s.trim()).filter(Boolean),
          brief: (w.brief ?? prev?.brief ?? "").trim(),
          done: (w.done ?? prev?.done ?? [""]).map((s) => s.trim()).filter(Boolean),
          state: prev?.sessionId ? prev.state : ("queued" as WorkOrderState),
        };
      });
    if (!edited.length) throw new Error("the edited plan had no usable work orders");
    order.workOrders = edited;
  } else {
    order.workOrders = order.workOrders.map((w) => ({ ...w, state: w.sessionId ? w.state : ("queued" as WorkOrderState) }));
  }

  order.status = "running";
  pushTrace(order, { from: "CEO", to: "Claude (manager)", what: "approve", detail: `${order.workOrders.length} work order(s) approved` });
  touched(order);
  saveFleetOrders(orders);

  // Spawning is not awaited: the POST returns as soon as the plan is accepted,
  // and the terminals open asynchronously (the watcher ticks fillSlots() too).
  void fillSlots().catch((e) => console.error(`[fleet] spawn after approve failed: ${String(e)}`));
  return getFleetOrder(orderId) ?? order;
}

function runningWorkOrders(orders: FleetOrder[]): WorkOrder[] {
  return orders.flatMap((o) => (o.status === "cancelled" ? [] : o.workOrders)).filter((w) => RUNNING_STATES.includes(w.state));
}

// Only one fillSlots() body may run at a time: the approve route and the watcher
// can both call it, and Node is single-threaded only until the first await.
let slotsInFlight: Promise<{ started: string[]; running: number }> | null = null;

// The state lock. fillSlots() and tickFleet() both load orders.json, mutate in memory
// and save after awaits (Laya call, spawn, delivery, a Claude review). Without this,
// the watcher's save clobbers the spawner's mid-flight write: measured 20:17 - a work
// order's `starting` + `model` reverted to `queued` because a tick saved a stale copy.
let stateMutex: Promise<unknown> = Promise.resolve();
function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = stateMutex.then(fn, fn);
  stateMutex = next.catch(() => undefined);
  return next;
}

/** Start queued work orders while there is a free session slot. */
export async function fillSlots(): Promise<{ started: string[]; running: number }> {
  if (slotsInFlight) return slotsInFlight;
  const p = withStateLock(() => fillSlotsNow());
  slotsInFlight = p;
  try {
    return await p;
  } finally {
    if (slotsInFlight === p) slotsInFlight = null;
  }
}

/**
 * Same as fillSlots(), but the machine-cap / budget-queue checks are skipped for work the CEO
 * ordered directly (see spawnOrderNow). Low-RAM is still respected. Kept separate so the normal
 * path can never accidentally bypass a cap.
 */
export async function fillSlotsForced(): Promise<{ started: string[]; running: number }> {
  if (slotsInFlight) return slotsInFlight;
  const p = withStateLock(() => fillSlotsNow({ ignoreSlotCaps: true }));
  slotsInFlight = p;
  try {
    return await p;
  } finally {
    if (slotsInFlight === p) slotsInFlight = null;
  }
}

/** The trace hop added when a red-budget hold is skipped because the work runs direct. */
export const FLEET_DIRECT_SKIP_REASON = "budget: skipped hold, runs on DeepSeek direct (off-peak, no Go quota)";

/**
 * FLEET_DEEPSEEK_ONLY (CEO order 2026-10-01 18:30, docs/ORDER_2026-10-01_deepseek-only.md): with
 * the switch armed EVERY pick on a non-urgent order is mapped onto a model DeepSeek's own API
 * serves (`chooseWorkerModel` + `ruleModel`), so no model of the order can spend the Go weekly
 * quota and the Go hold protects nothing. Kept as its own reason so a trace/ops check can tell
 * which skip fired.
 */
export const FLEET_DEEPSEEK_ONLY_SKIP_REASON =
  "budget: skipped hold, every model on this order runs on DeepSeek direct (FLEET_DEEPSEEK_ONLY=1; no Go quota spent)";

/** True when EVERY model given would be carried by DeepSeek's own API right now. */
export function allDeepseekDirect(models: string | Array<string | undefined>, at: Date = new Date()): boolean {
  const list = (Array.isArray(models) ? models : [models]).map((m) => String(m ?? "").trim()).filter(Boolean);
  return list.length > 0 && list.every((m) => deepseekDirectPlan(m, at).use);
}

export type FleetBudgetHold = {
  /** Should a NEW work order wait instead of starting now? */
  hold: boolean;
  /** Plain sentence for the trace / the ops check. */
  reason: string;
  /** Set only when the hold was skipped: the direct plan that made the hold pointless. */
  direct?: DeepseekDirectPlan;
};

/**
 * The launch gate's ONE budget decision for a new work order (exported so
 * ops/budget-guard-direct-check.ts exercises the real gate, not a copy of it).
 *
 * It is the budget guard's own answer (`fleetQueueForBudget`, passed in already computed
 * because calling it twice could spend a CEO grant twice), with the exceptions this work order
 * adds: while OpenCode Go is red the guard makes a NON-URGENT order wait, to protect the Go
 * weekly quota. Two kinds of work spend no Go quota at all, so holding them protects nothing:
 *
 *   (1) the model runs on DeepSeek's OWN provider right now (`deepseekDirectPlan(model).use`:
 *       armed, keyed, off-peak - or `DEEPSEEK_DIRECT_ALL_HOURS=1` - and clear of the phase
 *       boundary) AND a fleet terminal can really be launched on that provider
 *       (`fleetDirectReady()`: `jcode -p deepseek` answers non-interactively);
 *   (2) FLEET_DEEPSEEK_ONLY=1 with the bank armed: every model of the order is mapped onto the
 *       direct API before it reaches this gate, so the ORDER cannot touch Go quota. Here the
 *       terminal-side readiness is deliberately not required: the manager flips the switch only
 *       after the CEO has confirmed the `deepseek` provider import, and until then a launch
 *       fails without spending any Go quota either.
 *
 * Everything else - peak hours with the switch off, a Kimi/GLM/Qwen model, a missing key, an
 * unlaunchable provider - keeps waiting exactly as before. The guard's thresholds, red/amber
 * logic and `fleetQueueForBudget` are unchanged; this only reads their verdict.
 */
export async function fleetBudgetHold(
  queue: { queue: boolean; reason: string },
  /** the order's models: one id, or every model the order will run (see the caller). */
  model: string | string[],
  at: Date = new Date(),
): Promise<FleetBudgetHold> {
  if (!queue.queue) return { hold: false, reason: queue.reason };
  const models = (Array.isArray(model) ? model : [model]).map((m) => String(m ?? "").trim()).filter(Boolean);
  const plans = models.map((m) => deepseekDirectPlan(m, at));
  const allDirect = plans.length > 0 && plans.every((p) => p.use);
  const direct = plans.find((p) => p.use) ?? plans[0];
  if (allDirect && (await fleetDirectReady())) {
    return { hold: false, reason: FLEET_DIRECT_SKIP_REASON, direct };
  }
  if (fleetDeepseekOnlyArmed() && allDirect) {
    return { hold: false, reason: FLEET_DEEPSEEK_ONLY_SKIP_REASON, direct };
  }
  return { hold: true, reason: queue.reason };
}

async function fillSlotsNow(opts: { ignoreSlotCaps?: boolean } = {}): Promise<{ started: string[]; running: number }> {
  const started: string[] = [];
  // Orders the budget guard told us to skip (red: non-urgent orders wait). Tracked so the
  // loop cannot pick the same work order again and spin.
  const budgetSkipped = new Set<string>();
  for (;;) {
    const orders = loadFleetOrders();
    const running = runningWorkOrders(orders).length;
    if (running >= maxSessions()) break;

    // Find work FIRST. The cap/RAM checks below cost a powershell spawn (the terminal
    // count), so on an idle tick - no queued work order - this function must return
    // without doing any of them. That was PERF-BACKEND's fleet.ts finding at 20:36.
    const next = orders
      .filter((o) => o.status === "running" && !budgetSkipped.has(o.id))
      .flatMap((o) => o.workOrders.map((w) => ({ o, w })))
      .find(({ w }) => w.state === "queued");
    if (!next) break;
    const { o, w } = next;

    // Budget under red: a NON-URGENT order waits instead of starting (BUDGET_SPEC §2).
    // "Urgent" = the order contains an escalation (a work order that already failed, the
    // one case the CEO's cost rule says deserves the expensive model); everything else is
    // non-urgent. The wait is recorded as a trace hop, like the RAM/terminal-cap waits.
    const orderUrgent = o.workOrders.some((x) => needsEscalation(x).escalate);
    const budgetQueue = fleetQueueForBudget(orderUrgent);
    // DEEPSEEK DIRECT: while the guard would hold this NON-URGENT order for the Go quota,
    // the model pick is pulled forward - the hold's one escape hatch (this work order will
    // really run on DeepSeek's own provider, which spends no Go quota) needs to know the
    // model. On every other path the pick is still made after the cap/RAM checks, so a
    // capped fleet does not ask Laya. One decision point: fleetBudgetHold().
    let pick: ModelPick | undefined;
    if (budgetQueue.queue && !opts.ignoreSlotCaps) {
      pick = await pickFleetModel(w);
      // The hold is an ORDER decision, so it is handed every model this order will run: this
      // tick's real pick plus the deterministic rule pick of each other queued work order
      // (FLEET_DEEPSEEK_ONLY maps all of them onto the direct API; see fleetBudgetHold).
      const orderModels = [
        pick.model,
        ...o.workOrders.filter((x) => x !== w && x.state === "queued").map((x) => x.model ?? ruleModel(x).model),
      ];
      const hold = await fleetBudgetHold(budgetQueue, orderModels);
      if (hold.hold) {
        noteOnce(o, "waiting: budget", hold.reason);
        saveFleetOrders(orders);
        budgetSkipped.add(o.id);
        continue;
      }
      pushTrace(o, {
        from: "Fleet",
        to: "Claude (manager)",
        what: hold.reason,
        detail: `${hold.direct?.why ?? ""}; this work order runs ${hold.direct?.provider}/${hold.direct?.model}`,
      });
    }

    // Machine-wide cap, counted from REAL processes (active_pids lies).
    const terminals = await countRealTerminals();
    if (terminals.total >= terminals.maxParallel && !opts.ignoreSlotCaps) {
      for (const o of orders.filter((x) => x.status === "running")) {
        if (o.workOrders.some((w) => w.state === "queued")) {
          noteOnce(o, "waiting: terminal cap", `${terminals.total} real terminals (jcode ${terminals.jcodeTerminals} + opencode ${terminals.opencodeWorkers}) >= MAX_PARALLEL_SESSIONS=${terminals.maxParallel}; queued work stays queued`);
        }
      }
      saveFleetOrders(orders);
      warnThrottled("terminal-cap", `[fleet] not spawning: ${terminals.total} real terminals >= MAX_PARALLEL_SESSIONS=${terminals.maxParallel}`);
      break;
    }
    // Low-RAM guard (MIN_FREE_RAM_MB, 0 = off).
    const ramFloor = minFreeRamMb();
    if (ramFloor > 0) {
      const freeMb = Math.round(os.freemem() / (1024 * 1024));
      if (freeMb < ramFloor) {
        for (const o of orders.filter((x) => x.status === "running")) {
          if (o.workOrders.some((w) => w.state === "queued")) {
            noteOnce(o, "waiting: low RAM", `${freeMb} MB free < MIN_FREE_RAM_MB=${ramFloor}; queued work stays queued`);
          }
        }
        saveFleetOrders(orders);
        warnThrottled("low-ram", `[fleet] not spawning: ${freeMb} MB free < MIN_FREE_RAM_MB=${ramFloor}`);
        break;
      }
    }

    // Fix 1: Laya picks this terminal's model before the window opens, and the BUDGET
    // guard then filters that pick as a hard rule (amber/red Go: no Kimi, no deepseek-v4-pro).
    pick = pick ?? (await pickFleetModel(w));
    // FLEET_DEEPSEEK_ONLY: a pick already mapped onto DeepSeek's own API spends DeepSeek credit,
    // not Go quota, so the Go budget filter (red/amber downgrade to glm/kimi/qwen) must not push
    // it back onto a Go model - that is exactly the "pick says mapped, spawn used glm" bug.
    const filtered =
      fleetDeepseekOnlyArmed() && isDeepseekModel(pick.model)
        ? { model: pick.model, original: pick.model, changed: false, reason: `FLEET_DEEPSEEK_ONLY=1: ${pick.model} runs on DeepSeek direct (no Go quota); Go budget filter skipped` }
        : applyBudgetFilter({ model: pick.model, role: "worker", urgent: orderUrgent });
    const modelChangedByBudget = filtered.model !== pick.model;
    w.model = MODEL_ID_RE.test(filtered.model) ? filtered.model : standardModel();
    w.modelReason = modelChangedByBudget ? `${pick.reason}; budget: ${filtered.reason}` : pick.reason;
    w.modelSource = pick.source;
    w.layaConfidence = pick.confidence;
    w.layaAnswerConfidence = pick.answerConfidence;
    w.layaLead = pick.lead;
    const shown = pick.answerConfidence;
    pushTrace(o, {
      from: pick.source === "laya" ? "Laya" : "Fleet rules",
      to: "Claude (manager)",
      what: `pick ${modelFamily(w.model)}${shown !== undefined ? ` (${shown.toFixed(2)})` : ""}`,
      detail: `${w.model} [${pick.source}] - ${pick.reason}`,
    });

    w.state = "starting";
    w.startedAt = nowIso();
    const spawnLaunch = await launchTarget(w.model);
    pushTrace(o, {
      from: "Claude (manager)",
      to: `jcode:${w.id}`,
      what: "spawn",
      detail: `opening a visible terminal for ${w.title} with -p ${spawnLaunch.provider}${spawnLaunch.model ? ` -m ${spawnLaunch.model}` : ""} (${spawnLaunch.why})`,
    });
    saveFleetOrders(orders);

    const result = await withSpawnLock(async () => {
      const before = new Set(liveClientSessions().keys());
      const spawned = await spawnWorkerWindow(o, w);
      const found = spawned.pid
        ? await identifySession(spawned.pid, before)
        : { sessionId: "", detail: spawned.detail };
      return { pid: spawned.pid, sessionId: found.sessionId, detail: found.detail };
    });

    const after = loadFleetOrders();
    const target = after.find((x) => x.id === o.id)?.workOrders.find((x) => x.id === w.id);
    if (!target) continue;
    target.windowPid = result.pid || undefined;
    if (!result.sessionId) {
      target.state = "failed";
      target.error = `no jcode session matched this window: ${result.detail}`;
      pushTrace(after.find((x) => x.id === o.id)!, { from: `jcode:${w.id}`, to: "Claude (manager)", what: "spawn failed", detail: target.error });
      saveFleetOrders(after);
      continue;
    }
    target.sessionId = result.sessionId;
    const clientPid = liveClientSessions().get(result.sessionId);
    const autoclose = await registerWithAutoclose({
      sessionId: result.sessionId,
      role: w.role,
      windowPid: result.pid,
      clientPid,
      orderId: o.id,
      workOrderId: w.id,
      title: w.title,
    });
    pushTrace(after.find((x) => x.id === o.id)!, { from: `jcode:${w.id}`, to: "CEO", what: "session", detail: `${result.sessionId} (window pid ${result.pid || "?"}); ${autoclose}` });
    saveFleetOrders(after);

    // F1: switch the session's model BEFORE the brief is delivered, so the worker's very first
    // turn already uses the picked model. The verification is the journal's own meta.model.
    if (target.model) {
      // DEEPSEEK DIRECT: the provider was chosen at spawn time by launchTarget(); the
      // model to SET must be the direct id when the window runs DeepSeek's own provider.
      const launch = await launchTarget(target.model);
      const switched = await switchSessionModel(target.sessionId, launch.model ?? target.model);
      const afterSwitch = loadFleetOrders();
      const t = afterSwitch.find((x) => x.id === o.id)?.workOrders.find((x) => x.id === w.id);
      const ord = afterSwitch.find((x) => x.id === o.id);
      if (t && ord) {
        t.modelSwitch = { ok: switched.ok, at: nowIso(), detail: `${switched.detail}${launch.direct ? ` | ${launch.why}` : ""}` };
        pushTrace(ord, {
          from: `jcode:${w.id}`,
          to: "Claude (manager)",
          what: switched.ok ? `model set to ${launch.model ?? target.model}` : "model switch unavailable",
          detail: `${switched.detail}${launch.direct ? ` | ${launch.why}` : ""}`,
        });
        saveFleetOrders(afterSwitch);
      }
    }

    const brief = briefBody(o, target);
    const marker = `FLEET-ORDER ${o.id}/${w.id}`;
    const delivery = await deliverInto(target.sessionId, brief, marker);
    const after2 = loadFleetOrders();
    const target2 = after2.find((x) => x.id === o.id)?.workOrders.find((x) => x.id === w.id);
    if (target2) {
      const ord2 = after2.find((x) => x.id === o.id)!;
      target2.delivery = { how: delivery.how, at: nowIso(), detail: delivery.detail };
      target2.state = delivery.ok ? "working" : "failed";
      if (!delivery.ok) target2.error = `brief was not delivered: ${delivery.detail}`;
      pushTrace(ord2, {
        from: "Claude (manager)",
        to: `jcode:${w.id}`,
        what: delivery.ok ? `brief delivered (${delivery.how})` : "brief delivery failed",
        detail: delivery.detail,
      });
      saveFleetOrders(after2);
      started.push(`${o.id}/${w.id}`);
    }
    if (!delivery.ok) continue;
  }
  return { started, running: runningWorkOrders(loadFleetOrders()).length };
}

export async function redoWorkOrder(orderId: string, wid: string): Promise<FleetOrder> {
  const orders = loadFleetOrders();
  const order = orders.find((o) => o.id === orderId);
  if (!order) throw new Error(`unknown fleet order ${orderId}`);
  const wo = order.workOrders.find((w) => w.id === wid);
  if (!wo) throw new Error(`unknown work order ${wid}`);
  wo.attempts += 1;
  wo.verdict = undefined;
  wo.review = wo.review ?? "";
  wo.sessionId = undefined;
  wo.windowPid = undefined;
  wo.startedAt = undefined;
  wo.reportedAt = undefined;
  wo.error = undefined;
  wo.state = "queued";
  order.status = "running";
  pushTrace(order, { from: "CEO", to: `jcode:${wid}`, what: "redo", detail: `attempt ${wo.attempts + 1} with the review notes` });
  touched(order);
  saveFleetOrders(orders);
  void fillSlots().catch((e) => console.error(`[fleet] spawn after redo failed: ${String(e)}`));
  return getFleetOrder(orderId) ?? order;
}

/**
 * CEO-ordered work does not wait in the fleet's slot/budget QUEUE (the CEO literally said
 * "spawn a session and do X"). This marks the work order(s) "starting" so the machine caps are
 * bypassed for them, and records a trace hop that makes the override visible. The model filter
 * still applies (it is applied in fillSlots), and fillSlots itself opens the windows and
 * delivers the briefs, so this cannot clash with the watcher's in-flight pass.
 */
export async function spawnOrderNow(orderId: string, wid?: string): Promise<{ orderId: string; started: string[]; detail: string }> {
  const orders = loadFleetOrders();
  const order = orders.find((o) => o.id === orderId);
  if (!order) throw new Error(`unknown fleet order ${orderId}`);
  const targets = order.workOrders.filter((w) => (wid ? w.id === wid : true));
  if (!targets.length) throw new Error(`no work order ${wid ?? "(any)"} on ${orderId}`);
  const marked: string[] = [];
  for (const w of targets) {
    if (w.state === "working" || w.state === "starting") continue;
    w.state = "queued";
    w.error = undefined;
    marked.push(w.id);
  }
  if (!marked.length) return { orderId, started: [], detail: "all targeted work orders were already running or starting" };
  order.status = "running";
  pushTrace(order, {
    from: "CEO",
    to: "Claude (manager)",
    what: "CEO-ordered spawn",
    detail: `spawning now without waiting for a fleet slot: ${marked.join(", ")}`,
  });
  saveFleetOrders(orders);
  const res = await fillSlotsForced();
  return { orderId, started: res.started, detail: `queued ${marked.join(", ")}; fillSlotsForced started ${res.started.length}` };
}

export function cancelFleetOrder(orderId: string): FleetOrder {
  const orders = loadFleetOrders();
  const order = orders.find((o) => o.id === orderId);
  if (!order) throw new Error(`unknown fleet order ${orderId}`);
  order.status = "cancelled";
  // DUPLICATE-PROMPTS: record the drop durably, so the order can never raise its
  // "Retry this order or drop it?" prompt again (card state becomes done).
  order.closedAs = "dropped";
  order.closedReason = "cancelled by the CEO";
  order.closedAt = new Date().toISOString();
  order.closedBy = "ceo";
  // Running terminals are NOT killed: the CEO closes them.
  pushTrace(order, { from: "CEO", to: "Claude (manager)", what: "cancel", detail: "queued work will not start; running terminals are left alone" });
  touched(order);
  saveFleetOrders(orders);
  return order;
}

// ── review ────────────────────────────────────────────────────────────

const REVIEW_SYSTEM = [
  "You are the reviewing manager of a small engineering company. The model that runs this prompt may be Claude or a cheaper one; the standard does not change.",
  "A worker reports on a work order. Read its REPORT.md and the actual files it owns, then judge the work.",
  "Be strict but fair: PASS means the acceptance checks demonstrably hold and the report carries REAL command output.",
  "REDO means something required is missing, unverified, or broken - and your notes must say exactly what to fix.",
  "Reply with ONLY a JSON object: {\"verdict\":\"PASS\"|\"REDO\",\"review\":\"markdown notes\"}",
].join("\n");

/**
 * How much of each owned file the reviewer is shown. 1500 chars made a cheap reviewer read a
 * head fragment as a TRUNCATED file and ask for a REDO (docs/perf/REVIEW_NO_VERDICT_2026-10-01.md
 * §4); 6000 shows the whole deliverable for all but the very largest files.
 */
const OWNED_FILE_SNIPPET_CHARS = 6000;

function ownedFileSnips(wo: WorkOrder, budget = OWNED_FILE_SNIPPET_CHARS): string {
  const repo = repoRoot();
  const out: string[] = [];
  let used = 0;
  const files: string[] = [];
  for (const own of wo.owns) {
    const abs = path.resolve(repo, own);
    try {
      const st = fs.statSync(abs);
      if (st.isFile()) files.push(abs);
      else if (st.isDirectory()) {
        for (const n of fs.readdirSync(abs).slice(0, 10)) {
          const f = path.join(abs, n);
          try { if (fs.statSync(f).isFile()) files.push(f); } catch { /* skip */ }
        }
      }
    } catch {
      // a glob like src/company/fleet*.ts: expand one level
      const dir = path.dirname(abs);
      const base = path.basename(abs);
      try {
        for (const n of fs.readdirSync(dir)) {
          if (base.includes("*") ? new RegExp(`^${base.replace(/[.]/g, "\\.").replace(/\*/g, ".*")}$`).test(n) : false) {
            files.push(path.join(dir, n));
          }
        }
      } catch { /* nothing to add */ }
    }
  }
  for (const f of files.slice(0, 8)) {
    if (used >= budget) break;
    try {
      const text = fs.readFileSync(f, "utf8").slice(0, OWNED_FILE_SNIPPET_CHARS);
      out.push(`--- ${path.relative(repo, f).replace(/\\/g, "/")} ---\n${text}`);
      used += text.length;
    } catch {
      // unreadable
    }
  }
  return out.join("\n\n") || "(none of the owned paths exist yet)";
}

/**
 * GH-2: on a PASS, publish the work order as a draft PR when FLEET_GITHUB is on. Never throws,
 * never changes the verdict, and adds no trace step when the feature is off (default).
 */
async function publishPass(order: FleetOrder, wo: WorkOrder): Promise<void> {
  try {
    const res = await publishWorkOrder(order, wo, repoRoot());
    if ("skipped" in res) return; // feature off / nothing to record: no new trace step
    wo.branch = res.branch;
    if (res.prUrl) wo.prUrl = res.prUrl;
    pushTrace(order, {
      from: "Fleet",
      to: "GitHub",
      what: res.dryRun ? "PR dry-run" : "draft PR",
      detail: `${res.branch}${res.prUrl ? ` ${res.prUrl}` : " (dry-run, no change)"}`,
    });
  } catch (e) {
    pushTrace(order, { from: "Fleet", to: "GitHub", what: "PR publish failed", detail: String(e).slice(0, 200) });
  }
}

async function reviewWorkOrder(order: FleetOrder, wo: WorkOrder): Promise<void> {
  if (config.mockMode) {
    wo.verdict = "PASS";
    wo.review = "MOCK_MODE=1: the mock reviewer always passes.";
    wo.state = "reviewed";
    pushTrace(order, { from: "Claude (manager)", to: "CEO", what: "review PASS (mock)", detail: wo.review });
    await publishPass(order, wo);
    settleOrder(order);
    return;
  }

  let report = "";
  // CHEAP BY DEFAULT: REPORT.md is the brief's own requirement, and it is the deterministic half
  // of this review (see the PASS floor below). Track whether it could really be read.
  let reportReadable = false;
  try {
    report = fs.readFileSync(reportPath(order.id, wo.id), "utf8").slice(0, 12000);
    reportReadable = report.trim().length > 0;
  } catch {
    report = "(REPORT.md could not be read)";
  }
  const user = [
    `WORK ORDER ${wo.id} - ${wo.title} (role ${wo.role})`,
    `BRIEF:\n${wo.brief}`,
    `ACCEPTANCE CHECKS:\n${wo.done.map((d) => `- ${d}`).join("\n")}`,
    `YOU OWN: ${wo.owns.join(", ") || "(not specified)"}`,
    "",
    `REPORT.md:\n${report}`,
    "",
    "CURRENT CONTENT OF THE OWNED FILES:",
    ownedFileSnips(wo),
    "",
    "Verdict now. Reply with only the JSON object.",
  ].join("\n");

  wo.reviewAttempts = (wo.reviewAttempts ?? 0) + 1;
  wo.lastReviewAttemptAt = nowIso();
  const forcedKimi = order.forceProvider === "kimi";
  if (forcedKimi) {
    pushTrace(order, {
      from: "Fleet",
      to: "Claude (manager)",
      what: "skip Claude (forced kimi)",
      detail: "CEO chose Kimi for this order; bypassing Claude reviewer",
    });
  }
  try {
    // NO-VERDICT FIX (docs/perf/REVIEW_NO_VERDICT_2026-10-01.md): a reply with no parseable
    // verdict used to default to REDO with no retry and no escalation, so a reasoning-only or
    // truncated reply produced a made-up REDO. Retry the SAME tier and budget ONCE; if it is
    // still unreadable, ask the manager (needs_manager) instead of inventing a verdict.
    // An explicit PASS/REDO keeps its exact old behaviour.
    let rv: Awaited<ReturnType<typeof planOrReviewModel>> | undefined;
    let parsedVerdict: "PASS" | "REDO" | null = null;
    let parsedReview = "";
    let lastText = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      rv = await planOrReviewModel(reviewerModel(), REVIEW_SYSTEM, user, "review", forcedKimi ? "kimi" : undefined, `review:${order.id}:${wo.id}`);
      if (rv.via === "kimi") {
        pushTrace(order, { from: "Fleet", to: "Claude (manager)", what: "review via kimi", detail: rv.detail });
      }
      lastText = rv.text ?? "";
      const parsed = parseJsonObject(lastText) as { verdict?: unknown; review?: unknown } | null;
      if (parsed && (parsed.verdict === "PASS" || parsed.verdict === "REDO")) {
        parsedVerdict = parsed.verdict;
        parsedReview = typeof parsed.review === "string" && parsed.review.trim() ? parsed.review.trim() : "";
        break;
      }
      if (attempt < 2) {
        pushTrace(order, { from: "Claude (manager)", to: "CEO", what: "review retry (no verdict)", detail: "the reply carried no verdict; retrying the review once" });
      }
    }

    if (!parsedVerdict) {
      // Unreadable TWICE: do not return REDO and do not clear the review counter - hand it to
      // the manager through the existing INBOX "needs you" mechanism.
      wo.verdict = undefined;
      wo.review = lastText.trim().slice(0, 2000) || "the reviewer returned no notes";
      wo.state = "needs_manager";
      wo.error = undefined;
      pushTrace(order, { from: "Claude (manager)", to: "CEO", what: "review unreadable", detail: "no verdict in two replies; asking the manager" });
      await askCeoViaInbox({
        kind: "choice",
        title: `Review ${wo.id} unreadable`.slice(0, 120),
        question: "Review reply was unreadable twice; please decide: accept, redo, or drop.",
        options: ["Accept it", "Redo it", "Drop it"],
        context: wo.review,
        source: { type: "fleet-redo", id: order.id, wid: wo.id },
      });
      settleOrder(order);
      return;
    }

    // CHEAP BY DEFAULT: `rv.gate` says which tier actually ran, so the trace can say it honestly
    // (a `none` tier is a Go gateway model - deepseek-v4.1-flash - not Claude).
    const gateLabel = rv?.gate ? `[${rv.gate.tier} ${rv.gate.model}] ` : "";
    let verdict: "PASS" | "REDO" = parsedVerdict;
    let review = parsedReview || (lastText.trim().slice(0, 2000) || "the reviewer returned no notes");
    // AUTOMATED CHECK (docs/CHEAP_BY_DEFAULT_SPEC.md Job 2): the deterministic half of the
    // review. The brief orders every worker to write REPORT.md, so a PASS without a readable,
    // non-empty report is not allowed. This matters more now that a small work order's review
    // runs on the cheap tier by default: the check is what stops "PASS" from being a gift.
    if (verdict === "PASS" && !reportReadable) {
      verdict = "REDO";
      review = `automated check: ${reportPath(order.id, wo.id)} is missing or empty, so a PASS is not allowed. ${review}`;
    }
    wo.verdict = verdict;
    wo.review = review;
    wo.state = "reviewed";
    wo.error = undefined;
    wo.reviewAttempts = 0;
    pushTrace(order, {
      from: rv?.gate?.tier === "none" ? `${rv.gate.model} (cheap review)` : "Claude (manager)",
      to: "CEO",
      what: `review ${verdict}`,
      detail: `${gateLabel}${review}`,
    });
    // GH-2: a PASS is published as a draft PR when FLEET_GITHUB is on. Never changes the verdict.
    if (verdict === "PASS") await publishPass(order, wo);
  } catch (e) {
    // Explain a Claude spend-limit failure instead of just relaying the raw 429: it is not a
    // transient outage, the fallback should have carried the review, and the retry counter below
    // is what eventually fails the work order. (Measured 21:38: order fomumvtp5p/SPEAK-API was
    // failed with the raw 429 text after 3 review attempts, which read like a fleet bug.)
    const raw = String(e);
    const limitHit = /429|spend limit|rate-limited/i.test(raw);
    if ((wo.reviewAttempts ?? 0) >= reviewRetries()) {
      wo.state = "failed";
      wo.error = limitHit
        ? `review could not run: Claude is at its spend/rate limit and the ${fallbackModels().join(" / ")} fallback did not answer after ${wo.reviewAttempts} attempts (raw: ${raw.slice(0, 200)})`
        : `review failed ${wo.reviewAttempts}x: ${raw.slice(0, 300)}`;
      pushTrace(order, { from: "Claude (manager)", to: "CEO", what: "review unavailable", detail: wo.error });
    } else {
      // stay in "reported" so the next tick retries
      pushTrace(order, { from: "Claude (manager)", to: "CEO", what: "review retry", detail: `attempt ${wo.reviewAttempts}: ${raw.slice(0, 200)}` });
    }
  }
  settleOrder(order);
}

function settleOrder(order: FleetOrder): void {
  // Idempotent: an order that is already done/failed must not report twice.
  if (order.status === "done" || order.status === "failed") return;
  const wos = order.workOrders;
  const allReviewed = wos.length > 0 && wos.every((w) => w.state === "reviewed");
  const anyFailed = wos.some((w) => w.state === "failed");
  const anyRunning = wos.some((w) => RUNNING_STATES.includes(w.state) || w.state === "queued");
  const allPass = allReviewed && wos.every((w) => w.verdict === "PASS");

  if (allPass) {
    order.status = "done";
    order.summary = `${wos.length} work order(s) PASSed.`;
    pushTrace(order, { from: "Claude (manager)", to: "Assistant", what: "all PASS", detail: order.summary });
    pushTrace(order, { from: "Assistant", to: "CEO", what: "report", detail: order.summary });
    // GH-2: name the draft PRs in the order summary when FLEET_GITHUB produced them.
    const prLines = wos.filter((w) => w.prUrl).map((w) => `- ${w.id} ${w.title}: ${w.prUrl}`);
    appendAssistantEntry(
      `Fleet order ${order.id} is done: ${wos.length} work order(s) PASSed.\n` +
        wos.map((w) => `- ${w.id} ${w.title}: ${(w.review ?? "").replace(/\s+/g, " ").slice(0, 160)}`).join("\n") +
        (prLines.length ? `\n\nPull requests:\n${prLines.join("\n")}` : ""),
    );
    return;
  }
  if (!anyRunning && wos.some((w) => w.state === "needs_manager")) {
    // A work order whose review reply was unreadable twice. Do not invent a REDO and do not
    // fail the order: leave it visible and waiting on the manager's INBOX answer.
    const stuck = wos.filter((w) => w.state === "needs_manager");
    order.status = "reviewing";
    order.summary = `${wos.filter((w) => w.verdict === "PASS").length}/${wos.length} PASSed; ${stuck.length} need the manager (unreadable review).`;
    pushTrace(order, { from: "Claude (manager)", to: "CEO", what: "needs manager", detail: `review unreadable for: ${stuck.map((w) => w.id).join(", ")}` });
    return;
  }
  if (allReviewed && wos.some((w) => w.verdict === "REDO")) {
    order.status = "reviewing";
    order.summary = `${wos.filter((w) => w.verdict === "PASS").length}/${wos.length} PASSed; REDO offered for the rest.`;
    // Push the REDO question into INBOX (optional; INBOX also derives it from the verdict).
    for (const w of wos.filter((x) => x.verdict === "REDO")) {
      void askCeoViaInbox({
        kind: "choice",
        title: `Redo ${w.id}?`,
        question: `The review asked for a REDO on "${w.title}". Redo it, or leave it?`,
        options: ["Redo it", "Leave it"],
        context: w.review,
        source: { type: "fleet-redo", id: order.id, wid: w.id },
      });
    }
    return;
  }
  if (!anyRunning && anyFailed) {
    order.status = "failed";
    order.error = wos.filter((w) => w.state === "failed").map((w) => `${w.id}: ${w.error ?? "failed"}`).join(" | ");
    pushTrace(order, { from: "Claude (manager)", to: "CEO", what: "fleet failed", detail: order.error });
    appendAssistantEntry(`Fleet order ${order.id} failed.\n${order.error}`);
    return;
  }
  order.status = "running";
}

// ── boot reconcile + shutdown interface (RESUME_SPEC 1, SHUTDOWN_SPEC) ──

/**
 * RESUME_SPEC 1 + 4: the hop RESUME's flow.js/fleet.js views detect.
 * Literal agreed with RESUME (session crocodile): from === "Router" exactly, and
 * `what` starts with "restarted" and names the step we resumed at.
 */
function pushRestartHop(o: FleetOrder, what: string, to: string, detail: string): void {
  pushTrace(o, { from: "Router", to, what, detail });
}

/**
 * Push a CEO question into INBOX (docs/INBOX_SPEC.md, request from the INBOX owner 21:34).
 *
 * INBOX already DERIVES an item for every awaiting_approval order and every REDO, and the answer
 * calls approveFleetOrder/cancelFleetOrder/redoWorkOrder unchanged, so this is optional: it makes
 * the item appear the moment the watcher sees the state instead of on the next inbox read.
 * The import is LAZY for the same reason as AUTOCLOSE's: `inbox.ts` is another session's file and
 * may not exist in an older build, and the fleet must never fail a tick because a peer's module
 * is missing. INBOX dedupes per source (type|id|gate|wid|sessionId), so calling this every tick is
 * safe and can never duplicate their derived item.
 */
async function askCeoViaInbox(input: {
  kind: "approval" | "choice";
  title: string;
  question: string;
  options?: string[];
  context?: string;
  source: { type: string; id: string; wid?: string };
}): Promise<void> {
  try {
    const mod = (await import("./inbox.js")) as { askCeo?: (i: unknown) => unknown };
    if (typeof mod.askCeo !== "function") return;
    mod.askCeo(input);
  } catch {
    // INBOX not built in this build, or it is mid-edit: the derived item still appears.
  }
}

/**
 * Called once at router boot (server.ts). Any Fleet order that was mid-flight IN THE
 * PROCESS THAT DIED is redone here, once: planning restarts (bounded by
 * FLEET_PLAN_MAX_ATTEMPTS), and a work order that was mid-spawn is either adopted (its
 * session is still alive) or re-queued. Orders the SHUTDOWN session paused, and orders
 * owned by a still-live planner pid, are left alone.
 */
export function reconcileFleetOnBoot(): {
  resumed: string[];
  requeued: string[];
  adopted: string[];
  failed: string[];
  skipped: string[];
} {
  const out = { resumed: [] as string[], requeued: [] as string[], adopted: [] as string[], failed: [] as string[], skipped: [] as string[] };
  const orders = loadFleetOrders();
  for (const o of orders) {
    const midSpawn = o.status === "running" && o.workOrders.some((w) => w.state === "starting");
    if (o.status !== "planning" && !midSpawn) continue;
    // A live planner in another process still owns it; a shutdown-paused order waits
    // for the CEO's "Resume all" (SHUTDOWN calls resumeAfterShutdown).
    if (o.plannerPid && o.plannerPid !== process.pid && pidAlive(o.plannerPid)) {
      out.skipped.push(o.id);
      continue;
    }
    if (o.pausedByShutdown) {
      out.skipped.push(o.id);
      continue;
    }
    if (o.status === "planning") {
      const attempts = o.planAttempts ?? 0;
      if (attempts >= planMaxAttempts()) {
        o.status = "failed";
        o.plannerPid = undefined;
        o.error = `planning interrupted ${attempts} times by restarts`;
        pushRestartHop(o, "restarted -> planning gave up", "CEO", o.error);
        out.failed.push(o.id);
      } else {
        pushRestartHop(o, "restarted -> resumed at planning", "Claude (manager)", `attempt ${attempts + 1}/${planMaxAttempts()}; the previous planner (pid ${o.plannerPid ?? "?"}) is gone`);
        out.resumed.push(o.id);
      }
    }
    for (const w of o.workOrders) {
      if (w.state !== "starting") continue;
      if (w.sessionId && sessionIsAlive(w.sessionId)) {
        w.state = "working";
        pushRestartHop(o, "restarted -> resumed at working", `jcode:${w.id}`, `adopted the live session ${w.sessionId}`);
        out.adopted.push(`${o.id}/${w.id}`);
      } else {
        w.state = "queued";
        w.sessionId = undefined;
        w.windowPid = undefined;
        pushRestartHop(o, "restarted -> resumed at starting", `jcode:${w.id}`, "its session died with the router; re-queueing it once");
        out.requeued.push(`${o.id}/${w.id}`);
      }
    }
    o.resumedAt = nowIso();
    touched(o);
  }
  saveFleetOrders(orders);
  for (const id of out.resumed) void planOrder(id).catch((e) => console.error(`[fleet] resume planning ${id} failed: ${String(e)}`));
  if (out.requeued.length || out.adopted.length) void fillSlots().catch((e) => console.error(`[fleet] fillSlots after boot reconcile failed: ${String(e)}`));
  return out;
}

/**
 * SHUTDOWN interface (docs/SHUTDOWN_SPEC.md): mark the live orders paused so the boot
 * reconcile leaves them for the CEO's "Resume all". Returns how many were marked.
 * Called by the lifecycle before a planned shutdown; safe to call with no args (all
 * orders that are not done/cancelled/failed).
 */
export function markPausedByShutdown(orderIds?: string[]): number {
  const orders = loadFleetOrders();
  let n = 0;
  for (const o of orders) {
    if (orderIds && !orderIds.includes(o.id)) continue;
    if (["done", "cancelled", "failed"].includes(o.status)) continue;
    o.pausedByShutdown = true;
    touched(o);
    n++;
  }
  saveFleetOrders(orders);
  return n;
}

/**
 * SHUTDOWN interface: the other half of markPausedByShutdown - what the System page's
 * "Resume all" calls per order. Clears the flag, adopts sessions that are still alive,
 * re-queues the ones that died, and (for an order that never got a plan) resumes
 * planning. Adds the same restart hop RESUME renders.
 */
export async function resumeAfterShutdown(orderId: string): Promise<FleetOrder> {
  const orders = loadFleetOrders();
  const order = orders.find((o) => o.id === orderId);
  if (!order) throw new Error(`unknown fleet order ${orderId}`);
  order.pausedByShutdown = false;
  order.resumedAt = nowIso();
  if (!order.plan) {
    order.status = "planning";
    pushRestartHop(order, "restarted -> resumed at planning", "Claude (manager)", "resumed after shutdown");
    touched(order);
    saveFleetOrders(orders);
    void planOrder(orderId).catch((e) => console.error(`[fleet] resume planning ${orderId} failed: ${String(e)}`));
    return getFleetOrder(orderId) ?? order;
  }
  order.status = "running";
  for (const w of order.workOrders) {
    if (w.state === "reviewed" || w.state === "failed") continue;
    if (w.sessionId && sessionIsAlive(w.sessionId)) {
      w.state = "working";
      pushRestartHop(order, "restarted -> resumed at working", `jcode:${w.id}`, `adopted the live session ${w.sessionId}`);
    } else {
      w.state = "queued";
      w.sessionId = undefined;
      w.windowPid = undefined;
      pushRestartHop(order, "restarted -> resumed at starting", `jcode:${w.id}`, w.reportedAt ? "its report is already on disk" : "its session is gone; opening a fresh terminal");
    }
  }
  touched(order);
  saveFleetOrders(orders);
  void fillSlots().catch((e) => console.error(`[fleet] fillSlots after shutdown resume failed: ${String(e)}`));
  return getFleetOrder(orderId) ?? order;
}

// ── watcher ───────────────────────────────────────────────────────────

let watcherTimer: NodeJS.Timeout | null = null;
let watching = false;
const reviewsInFlight = new Set<string>();

function watcherLockFile(): string {
  return path.join(fleetRoot(), "WATCHER.json");
}

/**
 * Did the worker rewrite its REPORT.md after the review we last graded it on?
 * Used by tickFleet's rework re-open below; a missing/unreadable report is not newer.
 */
function reportNewerThanLastReview(orderId: string, wo: WorkOrder): boolean {
  if (!wo.lastReviewAttemptAt) return false;
  try {
    return fs.statSync(reportPath(orderId, wo.id)).mtimeMs > Date.parse(wo.lastReviewAttemptAt);
  } catch {
    return false;
  }
}

/** One pass over every live order: advance states, review finished work. */
export async function tickFleet(): Promise<{ advanced: number; reviewed: number; orders: number }> {
  // The whole pass holds the state lock (it awaits Claude reviews in the middle);
  // fillSlots() is called AFTER the lock is released so the two cannot clobber each
  // other's orders.json, and so this cannot deadlock on its own lock.
  // ATTRIBUTION (fix 3): any BLOCK recorded while this pass holds the loop is labeled
  // "fleet tick" instead of "idle". Diagnostic only. Caveat: the label is held across the
  // review awaits too, so a block from another module during a review can share this label.
  const result = await withBusyAsync("fleet tick", () => withStateLock(async () => {
    let reviewed = 0;
    let advanced = 0;
    const orders = loadFleetOrders();
  for (const order of orders) {
    if (order.status !== "running" && order.status !== "reviewing") continue;
    for (const wo of order.workOrders) {
      if (RUNNING_STATES.includes(wo.state) && wo.sessionId) {
        const live = sessionLive(wo.sessionId);
        const alive = sessionIsAlive(wo.sessionId);
        // Fix 1 check: does the terminal really run the model Laya picked?
        if (live.model && live.model !== wo.sessionModel) {
          wo.sessionModel = live.model;
          if (wo.model && live.model !== wo.model) {
            pushTrace(order, { from: `jcode:${wo.id}`, to: "Claude (manager)", what: "model mismatch", detail: `the session says ${live.model} but the pick was ${wo.model}` });
          } else {
            pushTrace(order, { from: `jcode:${wo.id}`, to: "Claude (manager)", what: `running ${live.model}`, detail: `session model matches the ${wo.modelSource ?? "?"} pick` });
          }
          advanced++;
        }
        const idleForMs = live.lastActivity ? Date.now() - Date.parse(live.lastActivity) : Number.POSITIVE_INFINITY;
        const next: WorkOrderState = live.streaming
          ? "working"
          : alive && idleForMs < idleSeconds() * 1000
            ? "working"
            : "idle";
        if (next !== wo.state) {
          advanced++;
          pushTrace(order, { from: `jcode:${wo.id}`, to: "Claude (manager)", what: next === "idle" ? "idle" : "working", detail: live.tail.slice(-2).join(" | ").slice(0, 300) });
          wo.state = next;
        }
        if (!alive && !wo.reportedAt && Date.now() - Date.parse(wo.startedAt ?? order.createdAt) > 120000) {
          wo.state = "failed";
          wo.error = "the worker session is gone and no REPORT.md was written";
          pushTrace(order, { from: `jcode:${wo.id}`, to: "Claude (manager)", what: "worker gone", detail: wo.error });
          settleOrder(order);
        }
      }
      // A REDO'd work order whose worker reworks ON ITS OWN rewrites REPORT.md, but its state is
      // already "reviewed", so the block below skipped it and the order sat in "reviewing" with a
      // finished fix nobody looked at (measured 17:13, docs/ORDER_2026-10-01_stuck-reviews.md:
      // fomupdu81a/WO1 got REDO at 10:51:02Z, its report was rewritten at 10:57:38Z, and 50 min
      // later there was still no re-review). If the report on disk is NEWER than the attempt we
      // graded, put the work order back in "reported" so this same pass re-reviews the new report.
      // Only a REDO re-opens (a PASS needs no second look) and this cannot loop: the re-review
      // stamps lastReviewAttemptAt, so an unchanged report is never picked up twice.
      if (wo.state === "reviewed" && wo.verdict === "REDO" && reportNewerThanLastReview(order.id, wo)) {
        wo.state = "reported";
        wo.reviewAttempts = 0;
        advanced++;
        pushTrace(order, {
          from: `jcode:${wo.id}`,
          to: "Claude (manager)",
          what: "rework",
          detail: "REPORT.md was rewritten after the REDO; re-reviewing the new report (no CEO redo was needed)",
        });
      }
      // GH-2: a PASS work order with an open PR whose CI is RED is downgraded to REDO ONCE.
      // No-op unless FLEET_GITHUB actually opened a PR (prUrl set), so the default is unchanged.
      if (wo.state === "reviewed" && wo.verdict === "PASS" && wo.prUrl && !wo.ciDowngraded) {
        try {
          const d = await applyCiDowngrade(order, wo);
          if (d.downgraded) {
            advanced++;
            pushTrace(order, {
              from: "Fleet",
              to: "Claude (manager)",
              what: "CI red -> REDO",
              detail: `draft PR check(s) failed: ${d.failed.join(", ") || "unknown"}`,
            });
          }
        } catch (e) {
          // a CI read must never crash a tick or change a verdict
          pushTrace(order, { from: "Fleet", to: "Claude (manager)", what: "CI check failed", detail: String(e).slice(0, 200) });
        }
      }
      if (wo.state !== "reviewed" && wo.state !== "failed" && fs.existsSync(reportPath(order.id, wo.id))) {
        if (!wo.reportedAt) {
          wo.reportedAt = nowIso();
          wo.state = "reported";
          advanced++;
          pushTrace(order, { from: `jcode:${wo.id}`, to: "Claude (manager)", what: "report", detail: `REPORT.md written (${path.relative(repoRoot(), reportPath(order.id, wo.id)).replace(/\\/g, "/")})` });
        }
        // Space the retries out. Without this the SAME tick's loop re-entered the review as soon
        // as it failed and burned all FLEET_REVIEW_RETRIES in ~10 s (measured 21:39: attempts at
        // 16:39:02, :08 and :12), so a transient outage permanently failed a work order whose
        // report was fine. FLEET_REVIEW_RETRY_DELAY_S defaults to 60 s.
        const retryDelayMs = envNum("FLEET_REVIEW_RETRY_DELAY_S", 60) * 1000;
        const since = wo.lastReviewAttemptAt ? Date.now() - Date.parse(wo.lastReviewAttemptAt) : Number.POSITIVE_INFINITY;
        const readyForRetry = !wo.reviewAttempts || (wo.reviewAttempts < reviewRetries() && since >= retryDelayMs);
        const key = `${order.id}/${wo.id}`;
        if (wo.state === "reported" && readyForRetry && !reviewsInFlight.has(key)) {
          reviewsInFlight.add(key);
          reviewed++;
          try {
            await reviewWorkOrder(order, wo);
          } finally {
            reviewsInFlight.delete(key);
          }
        }
      }
    }
    settleOrder(order);
    // FIX 1: no unconditional `touched(order)` here. It bumped updatedAt every 5 s, which forced
    // the 611 KB orders.json write on every tick even when nothing else changed. Real mutations
    // already refresh updatedAt via pushTrace/touched at their call sites.
  }
    saveFleetOrders(orders);
    return { advanced, reviewed, orders: orders.length };
  }));
  await fillSlots();
  return result;
}

export function startFleetWatcher(): { intervalMs: number; running: boolean } {
  if (watcherTimer) return { intervalMs: watchIntervalMs(), running: true };
  // One watcher only. Two watchers would double-review (exactly the duplicate-
  // bridge incident this repo already had with Slack), so a second process
  // refuses unless FLEET_FORCE=1.
  try {
    const lock = waitersLock();
    if (!lock && process.env.FLEET_FORCE !== "1") {
      console.warn("[fleet] another fleet watcher is live; not starting a second one (set FLEET_FORCE=1 to override)");
      return { intervalMs: watchIntervalMs(), running: false };
    }
    fs.mkdirSync(fleetRoot(), { recursive: true });
    fs.writeFileSync(watcherLockFile(), JSON.stringify({ pid: process.pid, startedAt: nowIso() }, null, 2));
  } catch (e) {
    console.warn(`[fleet] watcher lock unavailable (continuing): ${String(e)}`);
  }
  watching = true;
  const intervalMs = watchIntervalMs();
  let tickRunning = false;
  watcherTimer = setInterval(() => {
    if (!watching) return;
    // Never pile up: a tick can take a minute (a Claude review runs inside it), and the old
    // code let an interval callback start a new pass while the previous was still running,
    // which multiplied every read in the pass (PERF-BACKEND's corrected ranking, 20:57).
    if (tickRunning) return;
    tickRunning = true;
    void tickFleet()
      .catch((e) => console.error(`[fleet] watcher tick failed: ${String(e)}`))
      .finally(() => { tickRunning = false; });
  }, intervalMs);
  // Never keep the process alive just to watch.
  if (typeof watcherTimer.unref === "function") watcherTimer.unref();
  console.log(`[fleet] watcher every ${intervalMs}ms (interval is unref'd, so it keeps no process alive)`);
  return { intervalMs, running: true };
}

function waitersLock(): boolean {
  try {
    const raw = fs.readFileSync(watcherLockFile(), "utf8");
    const rec = JSON.parse(raw) as { pid?: number };
    if (typeof rec.pid === "number" && rec.pid !== process.pid && pidAlive(rec.pid)) return false;
  } catch {
    // no lock yet
  }
  return true;
}

export function stopFleetWatcher(): { running: boolean } {
  watching = false;
  if (watcherTimer) {
    clearInterval(watcherTimer);
    watcherTimer = null;
  }
  try {
    const rec = JSON.parse(fs.readFileSync(watcherLockFile(), "utf8")) as { pid?: number };
    if (rec.pid === process.pid) fs.rmSync(watcherLockFile(), { force: true });
  } catch {
    // nothing to release
  }
  return { running: false };
}

export function fleetWatcherStatus(): { running: boolean; intervalMs: number } {
  return { running: watching, intervalMs: watchIntervalMs() };
}

// ── API-shaped readers ────────────────────────────────────────────────

export type FleetWorkOrderView = WorkOrder & {
  live: { streaming: boolean; lastActivity?: string; tail: string[]; model?: string };
  reportPath: string;
};

export type FleetOrderView = Omit<FleetOrder, "workOrders"> & { workOrders: FleetWorkOrderView[] };

function withLive(wo: WorkOrder): Omit<FleetWorkOrderView, "reportPath"> {
  const live = wo.sessionId ? sessionLive(wo.sessionId) : { found: false, streaming: false, messages: 0, tail: [] as string[] };
  return {
    ...wo,
    live: { streaming: live.streaming, lastActivity: live.lastActivity, tail: live.tail, model: live.model ?? wo.sessionModel },
  };
}

export function fleetOrdersData(): {
  orders: FleetOrderView[];
  limits: { maxSessions: number; running: number; maxParallelSessions: number; realTerminals: number | null };
  watcher: { running: boolean; intervalMs: number };
} {
  const orders = loadFleetOrders().slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const running = runningWorkOrders(orders).length;
  const terminals = lastTerminalCount();
  return {
    orders: orders.map((o) => ({ ...o, workOrders: o.workOrders.map((w) => ({ ...withLive(w), reportPath: relReport(o.id, w.id) })) })),
    limits: {
      maxSessions: maxSessions(),
      running,
      maxParallelSessions: maxParallelSessions(),
      // Real terminal count (jcode + opencode workers), or null until first measured.
      realTerminals: terminals ? terminals.total : null,
    },
    watcher: fleetWatcherStatus(),
  };
}

function relReport(orderId: string, wid: string): string {
  // Prefer a repo-relative path (what the UI links to), but never hand back a
  // "..\..\..." escape: when COMPANY_ROOT lives outside the repo (test servers),
  // the absolute path is the honest answer.
  const abs = reportPath(orderId, wid);
  const rel = path.relative(repoRoot(), abs).replace(/\\/g, "/");
  return !rel || rel.startsWith("..") ? abs.replace(/\\/g, "/") : rel;
}

export function fleetOrderDetail(id: string): FleetOrderView | undefined {
  const order = getFleetOrder(id);
  if (!order) return undefined;
  return { ...order, workOrders: order.workOrders.map((w) => ({ ...withLive(w), reportPath: relReport(order.id, w.id) })) };
}

// ── test hook (ops/fleet-deliver-probe.ts) ────────────────────────────
// Spawns one real visible terminal and delivers `text` into THAT session,
// exactly as fillSlots does, so the delivery mechanism can be verified on its
// own (and against a throwaway COMPANY_ROOT / FLEET_REPO) without touching the
// live company. Returns the session it landed in and how it was verified.
export async function probeDelivery(opts: {
  orderId: string;
  wid: string;
  text: string;
  marker: string;
  /** the model to pass as `-m`, to verify jcode really switches (Fix 1) */
  model?: string;
}): Promise<{
  windowPid: number;
  sessionId: string;
  /** how the session was matched to the window (process-tree walk, or a loose guess) */
  match: string;
  delivery: { ok: boolean; how: "targeted" | "focused" | "none"; detail: string };
  confirmed: boolean;
  tail: string[];
  /** the model the SESSION reports (proves whether -m took effect) */
  sessionModel?: string;
}> {
  const order: FleetOrder = {
    id: opts.orderId,
    text: "(delivery probe)",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: "running",
    workOrders: [],
    trace: [],
  };
  const wo: WorkOrder = {
    id: opts.wid,
    title: "delivery probe",
    role: "probe",
    owns: [],
    brief: opts.text,
    done: [],
    state: "starting",
    attempts: 0,
    ...(opts.model ? { model: opts.model } : {}),
  };
  return withSpawnLock(async () => {
    const before = new Set(liveClientSessions().keys());
    const spawned = await spawnWorkerWindow(order, wo);
    const windowPid = spawned.pid;
    const found = windowPid
      ? await identifySession(windowPid, before)
      : { sessionId: "", detail: spawned.detail };
    const sessionId = found.sessionId;
    const delivery = sessionId
      ? await deliverInto(sessionId, opts.text, opts.marker)
      : { ok: false, how: "none" as const, detail: `no session matched the window: ${found.detail}` };
    const sessionLiveOut = sessionId ? sessionLive(sessionId) : undefined;
    return {
      windowPid,
      sessionId,
      match: found.detail,
      delivery,
      confirmed: sessionId ? sessionHasMarker(sessionId, opts.marker) : false,
      tail: sessionLiveOut?.tail ?? [],
      sessionModel: sessionLiveOut?.model,
    };
  });
}
