/**
 * src/company/deepseekDirect.ts — DeepSeek's own API as a second "bank" (CEO order 2026-10-01).
 *
 * WHY: OpenCode Go is a $10/mo subscription with WEEKLY quota windows, and this company
 * burns the weekly window (measured 2026-10-01 16:30 IST: 5-hour 84% left but WEEKLY only
 * 13% left, resets in 3d12h). DeepSeek is ~90% of the traffic shape that will flow once
 * the fleet runs freely, and DeepSeek's direct API is HALF PRICE off-peak. Since CEO order
 * 2026-10-06 (POLICY-GO-FIRST) the credits are spent ONLY when OpenCode Go is exhausted:
 *
 *   quota healthy (>= 10%) -> OpenCode Go, at ANY hour, off-peak included (no credits);
 *   quota below 10% or a Go 429 -> DeepSeek direct API (own credit, Go quota already out);
 *   DEEPSEEK_OFFPEAK_DIRECT=1   -> explicit opt-in: off-peak is half price, use direct.
 *
 * This module is the single decision point: every caller asks `deepseekDirectPlan(model)`
 * and either routes itself or does nothing. Nothing here throws, nothing here performs
 * I/O, and with `DEEPSEEK_DIRECT` unset the whole feature is inert (byte-for-byte the old
 * behaviour), so a half-configured box cannot lose work.
 *
 * Env:
 *   DEEPSEEK_DIRECT=1                  master switch (default 0 = off)
 *   DEEPSEEK_API_KEY=sk-...            the direct key (platform.deepseek.com -> API keys)
 *   DEEPSEEK_BASE_URL                  default https://api.deepseek.com
 *   DEEPSEEK_DIRECT_MODEL              force one direct model id (else mapped: the direct
 *                                      API lists deepseek-flash and deepseek-v4-pro)
 *   DEEPSEEK_PROVIDER                  jcode provider id for fleet terminals (default deepseek)
 *   DEEPSEEK_DIRECT_ALL_HOURS=1        also use direct at peak (saves Go quota, pays 2x)
 *   DEEPSEEK_OFFPEAK_DIRECT=1          opt-in: restore "off-peak is half price, use direct"
 *   FLEET_DEEPSEEK_DIRECT_READY=1      skip the launchability probe (see fleetDirectReady)
 *   JCODE_BIN                          jcode executable the readiness probe runs (default jcode)
 */
import { execFile } from "node:child_process";
import { deepseekClock, type DeepseekClock } from "./offpeak.js";
import { openCodeGoUsageCached, type GoQuota } from "./usage.js";

export type DeepseekDirectPlan = {
  /** Route THIS call to the direct API now. */
  use: boolean;
  /** jcode provider id the fleet terminal must be launched with. */
  provider: string;
  /** Model id to send to the direct API. */
  model: string;
  baseUrl: string;
  key: string;
  /** Always set, whether or not we route: the plain-English reason. */
  why: string;
};

const env = (name: string): string => (process.env[name] ?? "").trim();

function flag(name: string, fallback = false): boolean {
  const raw = env(name).toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function deepseekKey(): string {
  return env("DEEPSEEK_API_KEY");
}

export function deepseekBaseUrl(): string {
  return (env("DEEPSEEK_BASE_URL") || "https://api.deepseek.com").replace(/\/+$/, "");
}

/** The jcode/opencode provider id that reaches DeepSeek's own API. */
export function deepseekProvider(): string {
  return env("DEEPSEEK_PROVIDER") || "deepseek";
}

/** Master switch AND a key: arming the feature without a key would only cause failures. */
export function deepseekDirectArmed(): boolean {
  return flag("DEEPSEEK_DIRECT") && !!deepseekKey();
}

/** Any model that belongs on DeepSeek's own API (the Go and direct ids both match). */
export function isDeepseekModel(modelId: string | undefined): boolean {
  return /deepseek/i.test(String(modelId ?? ""));
}

/**
 * Map a Go/gateway DeepSeek id onto the DIRECT API's id.
 *
 * MEASURED 2026-10-01 against `GET https://api.deepseek.com/models`: the direct API lists
 * exactly TWO models, `deepseek-flash` (DeepSeek-V4.1-Flash) and `deepseek-v4-pro`. So both
 * Go spellings of the flash model (`deepseek-v4.1-flash`, the fleet default, and
 * `deepseek-v4-flash`) map to `deepseek-flash`; pro/reasoner work stays on `deepseek-v4-pro`.
 * Sending a Go id verbatim is what produced the earlier `400 ... model`.
 */
/** Map ANY OpenCode-Go-bound model id onto a DeepSeek-family Go id (the same capability
 * mapping FLEET_DEEPSEEK_ONLY uses): kimi/qwen/pro/reason/r1/thinking/large/max -> the
 * escalation tier (deepseek-v4-pro); glm and unknown ids -> the cheap standard
 * (deepseek-v4.1-flash). DeepSeek ids and Claude ids pass through unchanged (Claude never
 * rides the Go gateway). */
export function mapGoModelToDeepseek(modelId: string): string {
  const id = String(modelId ?? "").trim();
  if (!id || isClaudeModel(id) || isDeepseekModel(id)) return id;
  const escalation = /kimi|qwen|pro|reason|r1|thinking|large|max/i.test(id);
  return escalation ? DEEPSEEK_ONLY_ESCALATION : DEEPSEEK_ONLY_STANDARD;
}

export function deepseekDirectModel(modelId: string): string {
  const forced = env("DEEPSEEK_DIRECT_MODEL");
  if (forced) return forced;
  // CEO order 2026-10-02 (A): EVERY direct DeepSeek call uses flash. No input maps to
  // deepseek-v4-pro any more (the reasoning/escalation tier is retired company-wide).
  void modelId;
  return "deepseek-flash";
}

// ---------------------------------------------------------------------------
// FLEET_DEEPSEEK_ONLY — "run on the DeepSeek API key instead of OpenCode Go, for now"
// (CEO order 2026-10-01 18:30, docs/ORDER_2026-10-01_deepseek-only.md)
// ---------------------------------------------------------------------------
//
// WHY: the OpenCode Go WEEKLY window fell to 6% with ~3 days to reset. Every pick that goes
// through Go (glm-5.3-flash, kimi-k2.7-code, qwen3.8-flash) burns that window. With this switch
// on, each such pick is mapped onto a model DeepSeek's OWN API serves, so the work spends
// DeepSeek credit instead of Go quota.
//
// INERT BY DEFAULT, and it also needs the bank: `FLEET_DEEPSEEK_ONLY=0` (or unset) returns every
// pick unchanged, and so does `=1` on a box with no DEEPSEEK_API_KEY - that mapping would only
// rename a model on the SAME Go gateway and hide where the quota went. The manager flips the
// switch after review; `DEEPSEEK_DIRECT_ALL_HOURS=1` is what makes the mapped calls usable at
// peak as well.
//
// DELIBERATELY NOT MAPPED: Claude ids (claude-*, sonnet, opus) run on the Claude subscription,
// not on Go; DeepSeek ids are already the target.
//
// The mapping is by CAPABILITY, not by vendor name: the escalation/strong tier (kimi, qwen, the
// pro/reasoner spellings) -> `deepseek-v4-pro`; everything else (glm, and an unknown id) -> the
// cheap default `deepseek-v4.1-flash`. Both are Go spellings; `deepseekDirectModel()` maps them
// onto the direct API's own ids (`deepseek-flash` / `deepseek-v4-pro`) at the call site.
export const DEEPSEEK_ONLY_STANDARD = "deepseek-v4.1-flash";
// DEEPSEEK_ONLY_ESCALATION is kept at a DeepSeek-family id for the trace, but since CEO order
// 2026-10-02 (A) it is flash too: deepseek-v4-pro is never launched or called anywhere.
export const DEEPSEEK_ONLY_ESCALATION = "deepseek-flash";

export function fleetDeepseekOnly(): boolean {
  return flag("FLEET_DEEPSEEK_ONLY");
}

/** The switch AND the key. A mapping without a key would only rename a Go model. */
export function fleetDeepseekOnlyArmed(): boolean {
  return fleetDeepseekOnly() && deepseekDirectArmed();
}

/** True for an id that belongs to the Claude subscription (never mapped by the switch). */
export function isClaudeModel(modelId: string | undefined): boolean {
  return /claude|sonnet|opus/i.test(String(modelId ?? ""));
}

export type DeepseekOnlyMatch = {
  /** the model to use (=== `original` when nothing was mapped). */
  model: string;
  /** the pick that arrived. */
  original: string;
  mapped: boolean;
  /** one plain sentence for the trace / decision line. Always set. */
  why: string;
};

/**
 * Map ONE pick onto a model DeepSeek's own API serves, when `FLEET_DEEPSEEK_ONLY=1` and the
 * direct bank is armed. Never throws; when nothing is mapped the reason still says why, so a
 * trace line can always print it. With the flag off this is the identity function.
 */
export function deepseekOnlyModel(modelId: string): DeepseekOnlyMatch {
  const original = String(modelId ?? "").trim();
  const unchanged = (why: string): DeepseekOnlyMatch => ({ model: original, original, mapped: false, why });
  if (!fleetDeepseekOnly()) return unchanged("FLEET_DEEPSEEK_ONLY is not 1 (DeepSeek-only switch off)");
  if (isClaudeModel(original)) return unchanged(`${original} is a Claude-subscription model, not an OpenCode Go pick`);
  if (isDeepseekModel(original)) return unchanged(`${original} is already a DeepSeek model`);
  if (!deepseekDirectArmed()) {
    return unchanged(
      `FLEET_DEEPSEEK_ONLY=1 but the direct bank is not armed (DEEPSEEK_DIRECT / DEEPSEEK_API_KEY missing): ${original} stays on OpenCode Go`,
    );
  }
  const escalation = /kimi|qwen|pro|reason|r1|thinking|large|max/i.test(original);
  const model = escalation ? DEEPSEEK_ONLY_ESCALATION : DEEPSEEK_ONLY_STANDARD;
  return {
    model,
    original,
    mapped: true,
    why:
      `picked ${original}, mapped to ${model} because FLEET_DEEPSEEK_ONLY=1 ` +
      `(${escalation ? "hard/escalation work" : "standard/cheap work"}; the direct API serves ${deepseekDirectModel(model)})`,
  };
}

// ---------------------------------------------------------------------------
// The routing POLICY (CEO order 2026-10-02; amended 2026-10-06 by POLICY-GO-FIRST,
// docs/ORDER_2026-10-06_policy-go-first.md).
//
// "Only use DeepSeek with credits when OpenCode is exhausted." So for EVERY OpenCode-Go-bound
// call (DeepSeek models AND Kimi/GLM/Qwen picks):
//   - Go binding window >= GO_QUOTA_DEEPSEEK_BELOW_PCT (10%) -> OpenCode Go at ANY hour,
//     off-peak included: no credits spent;
//   - Go binding window < GO_QUOTA_DEEPSEEK_BELOW_PCT (10%), or a Go 429 GoUsageLimitError
//     within the last 10 minutes -> DeepSeek direct (the only automatic credit spend);
//   - quota UNKNOWN/stale -> OpenCode Go, and learn from a 429; never guess credits.
// DEEPSEEK_OFFPEAK_DIRECT=1 (default off) restores the old 2026-10-02 "off-peak is cheaper,
// use DeepSeek direct" rule; DEEPSEEK_DIRECT_ALL_HOURS=1 still means always direct for
// DeepSeek-family ids. Quota is read SYNCHRONOUSLY from the usage cache; a missing snapshot, a
// disconnected one, or one older than GO_QUOTA_STALE_MS (15 min) is UNKNOWN.
// ---------------------------------------------------------------------------

/** Quota percentage at/below which the policy routes direct even at peak (env-overridable). */
export function goQuotaBelowPct(): number {
  const raw = Number(process.env.GO_QUOTA_DEEPSEEK_BELOW_PCT);
  return Number.isFinite(raw) && raw >= 0 ? raw : 10;
}

/** A Go snapshot older than this is treated as UNKNOWN (the quota read may lag reality). */
export const GO_QUOTA_STALE_MS = 15 * 60 * 1000;

/**
 * The reason line when the Go quota is UNKNOWN/stale: OpenCode Go stays primary and the policy
 * learns from a Go 429 (CEO order 2026-10-06, POLICY-GO-FIRST: never guess credits).
 */
export const GO_QUOTA_UNKNOWN_WHY =
  "Go quota unknown: using OpenCode Go and learning from a Go 429 (no credits spent on a guess)";

const GO_EXHAUSTED_MS = 10 * 60 * 1000;
const DIRECT_COOLOFF_MS = 5 * 60 * 1000;

/** Learned "Go is exhausted": a Go 429 GoUsageLimitError routes direct for 10 minutes. */
let goExhaustedUntil = 0;
/** A hard auth/balance error on direct must not be hammered: 5 min cool-off. */
let directCoolOffUntil = 0;

export function markGoExhausted(): void {
  goExhaustedUntil = Date.now() + GO_EXHAUSTED_MS;
}
export function goExhausted(): boolean {
  return Date.now() < goExhaustedUntil;
}
export function directInCoolOff(): boolean {
  return Date.now() < directCoolOffUntil;
}
export function markDirectCoolOff(): void {
  directCoolOffUntil = Date.now() + DIRECT_COOLOFF_MS;
}

/** True when the Go binding window is 0% / exhausted (a Go call will 429 again). */
export function goBindingExhausted(at: Date = new Date()): boolean {
  const v = goQuotaView(undefined, at);
  return v.known && v.remainingPct <= 0;
}

type GoQuotaView = {
  state: "known" | "unknown" | "stale" | "disconnected";
  known: boolean;
  remainingPct: number;
  bindingWindow?: string;
  resetsAt?: string;
};

/** The Go quota as the policy sees it (KNOWN or UNKNOWN), synchronously, no I/O. */
function goQuotaView(snapshot: GoQuota | null | undefined, at: Date): GoQuotaView {
  const snap = snapshot === undefined ? openCodeGoUsageCached() : snapshot;
  if (!snap) return { state: "unknown", known: false, remainingPct: 0 };
  if (snap.connected !== true || typeof snap.remainingPct !== "number") {
    return { state: "disconnected", known: false, remainingPct: 0 };
  }
  const age = Date.parse(snap.checkedAt ?? "");
  if (Number.isFinite(age) && at.getTime() - age > GO_QUOTA_STALE_MS) {
    return { state: "stale", known: false, remainingPct: 0 };
  }
  return {
    state: "known",
    known: true,
    remainingPct: snap.remainingPct,
    bindingWindow: snap.bindingWindow,
    resetsAt: snap.resetsAt,
  };
}

const DAY_NAMES_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Mon 05:30 IST" from an ISO timestamp, in the company's local timezone (IST). */
function formatResetIst(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return undefined;
  const ist = new Date(t + 330 * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${DAY_NAMES_SHORT[ist.getUTCDay()]} ${p(ist.getUTCHours())}:${p(ist.getUTCMinutes())} IST`;
}

function fmtPct(n: number): string {
  return String(Math.round(n * 10) / 10);
}

/** The quota-rule sentence: "quota 0% < 10%: weekly window, resets Mon 05:30 IST". */
function quotaWhy(v: GoQuotaView): string {
  const win = v.bindingWindow ?? "window";
  const reset = formatResetIst(v.resetsAt);
  const resetPart = reset ? `, resets ${reset}` : v.resetsAt ? `, resets ${v.resetsAt}` : "";
  return `quota ${fmtPct(v.remainingPct)}% < ${fmtPct(goQuotaBelowPct())}%: ${win} window${resetPart}`;
}

/** The plan for one call. Never throws; `use:false` always carries the reason. */
export function deepseekDirectPlan(
  modelId: string,
  at: Date = new Date(),
  snapshot?: GoQuota | null,
): DeepseekDirectPlan {
  const base = {
    provider: deepseekProvider(),
    model: deepseekDirectModel(modelId),
    baseUrl: deepseekBaseUrl(),
    key: deepseekKey(),
  };
  if (!String(modelId ?? "").trim()) {
    return { use: false, ...base, why: "(no model)" };
  }
  if (isClaudeModel(modelId)) {
    return { use: false, ...base, why: `${modelId} is a Claude-subscription model, not an OpenCode Go pick` };
  }
  if (!flag("DEEPSEEK_DIRECT")) {
    return { use: false, ...base, why: "DEEPSEEK_DIRECT is not 1 (feature off)" };
  }
  if (!base.key) {
    return { use: false, ...base, why: "no DEEPSEEK_API_KEY in .env (top up and paste the key)" };
  }

  const isDs = isDeepseekModel(modelId);
  const clock = deepseekClock(at);

  // DEEPSEEK_DIRECT_ALL_HOURS is the "always direct" override, but it is a DeepSeek PRICING
  // switch: it applies to DeepSeek-family ids only. Kimi/GLM/Qwen are mapped onto DeepSeek only
  // by the off-peak / quota rules below (never by this override), so a Go pick at peak with
  // healthy quota still runs on Go.
  if (isDs && flag("DEEPSEEK_DIRECT_ALL_HOURS")) {
    return { use: true, ...base, why: `DEEPSEEK_DIRECT_ALL_HOURS=1: always direct (${clock.ist})` };
  }

  const quota = goQuotaView(snapshot, at);
  const below = quota.known && quota.remainingPct < goQuotaBelowPct();

  // Quota rule beats price: route direct when the binding window is under the line, even at peak.
  if (below) {
    return { use: true, ...base, why: quotaWhy(quota) };
  }
  // Learned failure: a Go 429 within the last 10 minutes routes direct regardless of phase.
  if (goExhausted()) {
    return { use: true, ...base, why: "go-exhausted: OpenCode Go 429'd within the last 10 minutes, routing direct" };
  }

  // CEO order 2026-10-06 (POLICY-GO-FIRST): with a KNOWN healthy window, OpenCode Go carries the
  // call at ANY hour - including DeepSeek off-peak - and no credits are spent. The credits are
  // for an exhausted Go, not for a cheaper hour.
  if (quota.known) {
    if (flag("DEEPSEEK_OFFPEAK_DIRECT") && clock.phase === "off-peak") {
      // Explicit opt-in: the old 2026-10-02 rule (and its 45-minute boundary buffer) is back.
      if (!clock.clearOfBoundary) {
        return {
          use: false,
          ...base,
          why: `off-peak but only ${clock.minutesToChange}m from the next phase change (buffer 45m; pricing uses an undocumented start/end rule)`,
        };
      }
      return {
        use: true,
        ...base,
        why: `off-peak: half price (${clock.multiplier}x, ${clock.ist}), ${clock.minutesToChange}m to the next change, no Go quota spent`,
      };
    }
    return {
      use: false,
      ...base,
      why: `OpenCode quota ${fmtPct(quota.remainingPct)}% left: using OpenCode Go, no credits spent`,
    };
  }

  // UNKNOWN/stale quota: use OpenCode Go and learn from a Go 429. Never send work to the credits
  // just because the quota read is missing (CEO order 2026-10-06, POLICY-GO-FIRST).
  return { use: false, ...base, why: GO_QUOTA_UNKNOWN_WHY };
}

// ---------------------------------------------------------------------------
// In-memory routing counters (for GET /company/routing/policy, read-only).
// ---------------------------------------------------------------------------
type Outcome = { at: number; ok: boolean };
type FallbackEvent = { at: number; from: "go" | "direct" };
type FailEvent = { at: number; kind: string };

const RING_CAP = 200;
let directOutcomes: Outcome[] = [];
let goOutcomes: Outcome[] = [];
let fallbacks: FallbackEvent[] = [];
let failures: FailEvent[] = [];

function pushRing<T>(arr: T[], item: T): void {
  arr.push(item);
  if (arr.length > RING_CAP) arr.splice(0, arr.length - RING_CAP);
}
function countSince(arr: Array<{ at: number }>, since: number): number {
  return arr.reduce((n, e) => n + (e.at >= since ? 1 : 0), 0);
}

export function recordDirectOutcome(ok: boolean): void {
  pushRing(directOutcomes, { at: Date.now(), ok });
}
export function recordGoOutcome(ok: boolean): void {
  pushRing(goOutcomes, { at: Date.now(), ok });
}
export function recordFallback(from: "go" | "direct"): void {
  pushRing(fallbacks, { at: Date.now(), from });
}
export function recordFailure(kind: string): void {
  pushRing(failures, { at: Date.now(), kind });
}

/** Test seam: forget every counter (ops/deepseek-policy-check.ts). */
export function resetRoutingCounters(): void {
  directOutcomes = [];
  goOutcomes = [];
  fallbacks = [];
  failures = [];
  goExhaustedUntil = 0;
  directCoolOffUntil = 0;
}

function tally(arr: Outcome[]): { ok: number; failed: number } {
  return {
    ok: arr.reduce((n, e) => n + (e.ok ? 1 : 0), 0),
    failed: arr.reduce((n, e) => n + (e.ok ? 0 : 1), 0),
  };
}

function tallySince(arr: Outcome[], since: number): { ok: number; failed: number } {
  const win = arr.filter((e) => e.at >= since);
  return {
    ok: win.reduce((n, e) => n + (e.ok ? 1 : 0), 0),
    failed: win.reduce((n, e) => n + (e.ok ? 0 : 1), 0),
  };
}

export type RoutingPolicyStatus = {
  generatedAt: string;
  sampleStandard: { model: string; use: boolean; provider: string; modelId: string; why: string };
  sampleHard: { model: string; use: boolean; provider: string; modelId: string; why: string };
  go: {
    known: boolean;
    state: GoQuotaView["state"];
    remainingPct: number | null;
    bindingWindow: string | null;
    resetsAt: string | null;
    resetsIn: string | null;
    checkedAt: string | null;
  };
  deepseek: {
    phase: "peak" | "off-peak";
    minutesToChange: number;
    ist: string;
    keyPresent: boolean;
    armed: boolean;
    coolOff: boolean;
    goExhausted: boolean;
  };
  counters: {
    boot: {
      directOk: number;
      directFailed: number;
      goOk: number;
      goFailed: number;
      fallbackGoToDirect: number;
      fallbackDirectToGo: number;
    };
    last60m: {
      directOk: number;
      directFailed: number;
      goOk: number;
      goFailed: number;
      fallbackGoToDirect: number;
      fallbackDirectToGo: number;
    };
  };
  lastFailures: Array<{ kind: string; at: string }>;
};

/**
 * The read-only status block for GET /company/routing/policy: the current decision for a sample
 * standard + hard model, the Go binding window, the DeepSeek phase, key/cool-off state, and the
 * in-memory counters (since boot + last 60 min). No model call, no I/O, never the key.
 */
export function routingPolicyStatus(at: Date = new Date()): RoutingPolicyStatus {
  const standardModel = env("DEEPSEEK_DIRECT_MODEL") || "deepseek-v4.1-flash";
  const hardModel = "kimi-k2.7-code";
  const standard = deepseekDirectPlan(standardModel, at);
  const hard = deepseekDirectPlan(hardModel, at);
  const quota = goQuotaView(undefined, at);
  const snap = openCodeGoUsageCached();
  const clock = deepseekClock(at);
  const since = at.getTime() - 60 * 60 * 1000;
  const d = tally(directOutcomes);
  const g = tally(goOutcomes);
  const d60 = tallySince(directOutcomes, since);
  const g60 = tallySince(goOutcomes, since);
  const goToDirect = fallbacks.filter((f) => f.from === "go").length;
  const directToGo = fallbacks.filter((f) => f.from === "direct").length;
  const goToDirect60 = countSince(fallbacks.filter((f) => f.from === "go"), since);
  const directToGo60 = countSince(fallbacks.filter((f) => f.from === "direct"), since);
  return {
    generatedAt: at.toISOString(),
    sampleStandard: { model: standardModel, use: standard.use, provider: standard.provider, modelId: standard.model, why: standard.why },
    sampleHard: { model: hardModel, use: hard.use, provider: hard.provider, modelId: hard.model, why: hard.why },
    go: {
      known: quota.known,
      state: quota.state,
      remainingPct: quota.known ? quota.remainingPct : null,
      bindingWindow: quota.known ? (quota.bindingWindow ?? null) : null,
      resetsAt: quota.known ? (quota.resetsAt ?? null) : null,
      resetsIn: quota.known && quota.resetsAt ? humanizeUntilIso(quota.resetsAt, at) : null,
      checkedAt: snap?.checkedAt ?? null,
    },
    deepseek: {
      phase: clock.phase,
      minutesToChange: clock.minutesToChange,
      ist: clock.ist,
      keyPresent: !!deepseekKey(),
      armed: deepseekDirectArmed(),
      coolOff: directInCoolOff(),
      goExhausted: goExhausted(),
    },
    counters: {
      boot: {
        directOk: d.ok,
        directFailed: d.failed,
        goOk: g.ok,
        goFailed: g.failed,
        fallbackGoToDirect: goToDirect,
        fallbackDirectToGo: directToGo,
      },
      last60m: {
        directOk: d60.ok,
        directFailed: d60.failed,
        goOk: g60.ok,
        goFailed: g60.failed,
        fallbackGoToDirect: goToDirect60,
        fallbackDirectToGo: directToGo60,
      },
    },
    lastFailures: failures
      .slice(-5)
      .reverse()
      .map((f) => ({ kind: f.kind, at: new Date(f.at).toISOString() })),
  };
}

/** "3h 18m" from an ISO timestamp (local re-export so this module stays dependency-light). */
function humanizeUntilIso(iso: string, from: Date): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "unknown";
  let s = Math.round((t - from.getTime()) / 1000);
  if (s <= 0) return "now";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.round((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${Math.max(1, m)}m`;
}

/** Status block for the ops probe / dashboard: the clock plus whether direct would be used. */
export function deepseekDirectStatus(at: Date = new Date()): {
  armed: boolean;
  keyPresent: boolean;
  provider: string;
  clock: DeepseekClock;
  sampleModel: string;
  plan: DeepseekDirectPlan;
} {
  const sampleModel = env("DEEPSEEK_DIRECT_MODEL") || "deepseek-v4.1-flash";
  return {
    armed: deepseekDirectArmed(),
    keyPresent: !!deepseekKey(),
    provider: deepseekProvider(),
    clock: deepseekClock(at),
    sampleModel,
    plan: deepseekDirectPlan(sampleModel, at),
  };
}

// ---------------------------------------------------------------------------
// "Can a fleet terminal actually RUN on DeepSeek's own provider right now?"
// ---------------------------------------------------------------------------
//
// `deepseekDirectPlan().use` only says the direct API SHOULD carry this work. The fleet
// launches a VISIBLE terminal with `jcode -p deepseek`, which is a SEPARATE question: on
// 2026-10-01 `jcode -p deepseek` refuses until the CEO runs `jcode login --provider
// deepseek` (the box carries an old, invalid OpenCode credential for DeepSeek). Holding a
// Fleet order to protect the Go weekly quota is only pointless when the terminal will
// really run direct, so the launch gate asks this before it skips the hold. Not ready =>
// exactly the old behaviour (the order waits).
//
// The probe is `jcode model list -p deepseek`: exit 0 with `deepseek-flash` listed is the
// same non-interactive launchability the terminal needs. It is ASYNC (a child process,
// never a blocking call on the router's event loop), bounded by 5 s, and cached for
// 10 minutes; concurrent askers share one probe, so a burst of Fleet ticks costs one
// `jcode` process, not one per tick.
const READY_TTL_MS = 600_000;
const READY_TIMEOUT_MS = 5_000;

let readyCache: { at: number; value: boolean } | null = null;
let readyProbe: Promise<boolean> | null = null;

function jcodeBin(): string {
  return env("JCODE_BIN") || "jcode";
}

function probeDirectReady(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    execFile(
      jcodeBin(),
      ["model", "list", "-p", deepseekProvider()],
      { timeout: READY_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(!err && /deepseek-flash/i.test(String(stdout ?? ""))),
    );
  });
}

/**
 * True when a fleet terminal can be launched on DeepSeek's own provider right now.
 * Forced by `FLEET_DEEPSEEK_DIRECT_READY=1`, else the cached probe above. Never throws.
 */
export async function fleetDirectReady(): Promise<boolean> {
  if (flag("FLEET_DEEPSEEK_DIRECT_READY")) return true;
  if (readyCache && Date.now() - readyCache.at < READY_TTL_MS) return readyCache.value;
  if (readyProbe) return readyProbe;
  const p = probeDirectReady().then((value) => {
    readyCache = { at: Date.now(), value };
    return value;
  });
  readyProbe = p;
  try {
    return await p;
  } finally {
    if (readyProbe === p) readyProbe = null;
  }
}

/**
 * The cached readiness answer, or null before the first probe. NEVER blocks: a missing or
 * stale answer kicks a background probe and returns what is known now. For the dashboard,
 * which must not wait on a child process.
 */
export function fleetDirectReadyCached(): boolean | null {
  if (flag("FLEET_DEEPSEEK_DIRECT_READY")) return true;
  if (readyCache && Date.now() - readyCache.at < READY_TTL_MS) return readyCache.value;
  void fleetDirectReady();
  return readyCache?.value ?? null;
}

/** Test seam: forget the readiness probe (ops/budget-guard-direct-check.ts). */
export function resetFleetDirectReady(): void {
  readyCache = null;
  readyProbe = null;
}

/** The DeepSeek billing phase right now ("peak" | "off-peak"), for the dashboard. */
export function directPhase(at: Date = new Date()): "peak" | "off-peak" {
  return deepseekClock(at).phase;
}
