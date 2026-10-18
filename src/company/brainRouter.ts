// src/company/brainRouter.ts - the Laya gate in front of every Claude call
// (CEO order 2026-09-30, docs/CHEAP_BY_DEFAULT_SPEC.md).
//
// RULE: Claude is for BIG tasks, or for a call the CEO explicitly named Claude on.
// Everything else defaults to deepseek-v4.1-flash. Small tasks must never be
// assigned to or through Claude.
//
// One choke point: this module is hooked into callClaudeSubscription(), and every
// caller passes a `purpose`. Tiers:
//   none   -> no Claude at all: the cheap Go model (deepseek-v4.1-flash) or a plain rule
//   sonnet -> the standard Claude brain (the default for real planning/review)
//   opus   -> rare: the CEO named it, a hard rule fired, or Laya was very sure
//
// Claude runs only when:
//   1. Laya says the task is BIG. The question is the measured size/complexity one
//      (`complexityQuestionSpec`: long / multi / tiny noul probabilities), and the
//      gate is top-probability >= 0.33 AND lead >= 0.08 - the LAYA-TUNE starting
//      point for a gated noul pair, NOT `confidence` (which stays near 0 for
//      multi-option questions and would discard every pick).
//   2. The CEO named Claude/Sonnet/Opus in the order text (keyword check; overrides
//      Laya; no model call is made for the decision itself).
//   3. Laya says "not big" AND the purpose is plan/review-planning: the task takes
//      the CHEAPER tier. Chat-style replies never get Claude on a weak signal.
// Safety net: a small task that failed on the cheap model twice escalates ONCE to
// Sonnet, and the reason says so (callers pass how many times they have seen it
// fail; noteCheapFailure()/cheapFailures() keep that count for callers that want it).
// Laya is asked with a 3 s deadline (BUDGET_BRAIN_LAYA_MS). Down or slow: planning
// purposes keep Sonnet, everything else takes the cheap tier - and the reason says
// "fallback", so nobody mistakes it for a measured decision.
//
// Every decision is appended to company/budget/brain-decisions.jsonl with its
// purpose, tier, reason kind (laya | ceo-override | fallback), Laya's numbers and
// whether a Claude call was avoided; brainStats() is what the Budget page shows.
//
// The budget guard stays the FINAL filter: resolveBrainModel() runs the chosen
// model through applyBudgetFilter() before anyone dials out.

import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { cachedBySig, fileSig } from "./cache.js";
import { complexityQuestionSpec } from "../decision.js";
import { addTrace } from "./gates.js";
import { getCompanyRoot } from "./org.js";
import { applyBudgetFilter, budgetStatePath, readBudgetState, type BudgetLevel } from "./budgetGuard.js";
// FLEET_DEEPSEEK_ONLY (CEO order 2026-10-01 18:30, docs/ORDER_2026-10-01_deepseek-only.md): the
// cheap tier is a Go model, so the switch maps it onto a DeepSeek model the direct API serves.
import { deepseekOnlyModel } from "./deepseekDirect.js";
// Attribution only (fix 3 of the 2026-10-01 event-loop order): labels a BLOCK on the failure file.
import { withBusy } from "./loopWatchdog.js";

/** `none` = no Claude. `deepseek` is accepted as an alias for it (older callers). */
export type BrainTier = "none" | "sonnet" | "opus";

export type BrainPurpose =
  | "plan"
  | "review"
  | "assistant"
  | "fleet-plan"
  | "chat"
  | "answer"
  | "status"
  | "briefing"
  | "run-card"
  | "enhance"
  | "summarize"
  | "worker"
  | "generate";

export type ReasonKind = "laya" | "ceo-override" | "fallback";

type PurposeRule = {
  /** may this purpose spend Claude at all when Laya says the work is big? */
  claudeEligible: boolean;
  /** may it ever take opus (still only via CEO naming or a hard rule)? */
  opusEligible: boolean;
  /**
   * What to use when Laya cannot answer. ALWAYS "none": the CEO's rule is cheap by
   * default, so an unmeasurable task must NOT silently become a Claude task. The
   * escape hatches stay: the CEO naming Claude is checked before Laya, and the
   * twice-failed safety net climbs to Sonnet. (Measured need: Laya was down at
   * 20:59Z and the first version of this table sent every plan/review to Sonnet.)
   */
  fallbackTier: BrainTier;
  /** hard rules that take the top tier without asking Laya. */
  hardRules: Array<"redo2" | "failed" | "stuck">;
  /** this call reads files; a `none` tier cannot, so the pick is flagged. */
  files: boolean;
  /**
   * The caller can still produce its answer on a plain gateway model when the tier is `none`
   * (fleet planning: it ships a repo digest and its fallback models run over the Go gateway).
   * Without this flag a `none` pick is marked `fileBlind` and the "I need real files"
   * heuristic is applied even though no Claude call was ever going to happen.
   */
  gatewayFallback?: boolean;
  plain: string;
};

const PURPOSE_RULES: Record<BrainPurpose, PurposeRule> = {
  plan: { claudeEligible: true, opusEligible: true, fallbackTier: "none", hardRules: ["failed", "stuck"], files: true, plain: "a pipeline plan" },
  review: { claudeEligible: true, opusEligible: true, fallbackTier: "none", hardRules: ["redo2"], files: true, plain: "a review verdict" },
  assistant: { claudeEligible: true, opusEligible: false, fallbackTier: "none", hardRules: [], files: true, plain: "the CEO assistant" },
  "fleet-plan": { claudeEligible: true, opusEligible: true, fallbackTier: "none", hardRules: ["failed", "stuck"], files: true, plain: "a fleet plan", gatewayFallback: true },
  chat: { claudeEligible: false, opusEligible: false, fallbackTier: "none", hardRules: [], files: false, plain: "a chat reply" },
  answer: { claudeEligible: false, opusEligible: false, fallbackTier: "none", hardRules: [], files: false, plain: "an answer" },
  status: { claudeEligible: false, opusEligible: false, fallbackTier: "none", hardRules: [], files: false, plain: "a status roll-up" },
  briefing: { claudeEligible: true, opusEligible: false, fallbackTier: "none", hardRules: [], files: false, plain: "the briefing summary" },
  "run-card": { claudeEligible: true, opusEligible: false, fallbackTier: "none", hardRules: [], files: false, plain: "a run-card summary" },
  enhance: { claudeEligible: false, opusEligible: false, fallbackTier: "none", hardRules: [], files: false, plain: "a prompt enhancement" },
  summarize: { claudeEligible: false, opusEligible: false, fallbackTier: "none", hardRules: [], files: false, plain: "a summary" },
  worker: { claudeEligible: false, opusEligible: false, fallbackTier: "none", hardRules: [], files: false, plain: "an agent turn" },
  generate: { claudeEligible: false, opusEligible: false, fallbackTier: "none", hardRules: [], files: false, plain: "a plain generation" },
};

export function brainPurposes(): BrainPurpose[] {
  return Object.keys(PURPOSE_RULES) as BrainPurpose[];
}

/** Unknown purposes take the cheap, safe route and are logged as such. */
export function normalizePurpose(purpose: string | undefined): { purpose: BrainPurpose; known: boolean } {
  const p = String(purpose ?? "").trim().toLowerCase() as BrainPurpose;
  if (p && (PURPOSE_RULES as Record<string, PurposeRule>)[p]) return { purpose: p, known: true };
  return { purpose: "generate", known: false };
}

function envNum(name: string, dflt: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : dflt;
}

export function brainThresholds() {
  const share = envNum("BUDGET_BRAIN_OPUS_SHARE", 0.3);
  const bar = opusBarForShare(share);
  return {
    /** Laya's top probability must clear this to count as "big" (spec: 0.33). */
    bigP: envNum("BUDGET_BRAIN_BIG_P", 0.33),
    /** and its lead over the runner-up must clear this (spec: 0.08). */
    bigLead: envNum("BUDGET_BRAIN_BIG_LEAD", 0.08),
    /** the target share of BIG work that should reach Opus (CEO: "roughly 30%"). */
    opusShare: share,
    /** the calibrated Opus bars; see OPUS_BAR_LADDER for the measurement behind them. */
    opusP: envNum("BUDGET_BRAIN_OPUS_P", bar.p),
    opusLead: envNum("BUDGET_BRAIN_OPUS_LEAD", bar.lead),
    /** Laya deadline; slower than this and the fallback tier is used. */
    layaMs: envNum("BUDGET_BRAIN_LAYA_MS", 3000),
  };
}

/**
 * The measured BIG fixtures, as (top = max(long,multi), lead = top - tiny), from
 * `ops/brain-opus-calibration.ts` (29 realistic CEO orders, 65 Laya samples, 2026-09-30). These
 * ten are the fixtures the gate itself calls BIG; the other 19 samples went to `none`. Keeping the
 * raw measurements HERE (and deriving the ladder from them) means a threshold edit cannot silently
 * drift from the data it was calibrated on - the proof re-derives every share.
 */
export const MEASURED_BIG_PAIRS: ReadonlyArray<readonly [number, number]> = [
  [0.7693, 0.7233], // multi-file feature (API + migration + UI page)
  [0.8652, 0.7536], // refactor the authentication layer across six files
  [0.8416, 0.0842], // migrate Express -> Fastify (big, but Laya's lead over tiny is thin here)
  [0.6477, 0.1762], // event-driven architecture for the order pipeline
  [0.6323, 0.5163], // two-week roadmap, four workstreams
  [0.5241, 0.3148], // split the monolithic fleet module into three files
  [0.5471, 0.3988], // end-to-end tests across the whole order pipeline
  [0.878, 0.0854], // replace the polling watcher with a durable queue (thin lead again)
  [0.6322, 0.4492], // architecture document + migration steps
  [0.8325, 0.4362], // move the frontend to the new component library
];

/** The five bars the ladder samples, loosest first. The SHARE of each is DERIVED below. */
const OPUS_BARS: ReadonlyArray<readonly [number, number]> = [
  [0.6, 0.08],
  [0.65, 0.1],
  [0.75, 0.2],
  [0.8, 0.3],
  [0.84, 0.4],
];

/**
 * The ladder, DERIVED from `MEASURED_BIG_PAIRS`: how much of the measured BIG work each bar would
 * send to Opus. Measured 2026-09-30 -> 0.60/0.08 = 80%, 0.65/0.10 = 30%, 0.75/0.20 = 30%,
 * 0.80/0.30 = 20%, 0.84/0.40 = 10%. Measured evidence for the problem this fixes: the hand-raised
 * 0.92/0.85 sent **0 of 10** (Laya's big scores top out near 0.88), i.e. Opus would never run.
 */
function opusLadder(): Array<{ p: number; lead: number; share: number }> {
  const n = MEASURED_BIG_PAIRS.length || 1;
  return OPUS_BARS.map(([p, lead]) => ({
    p,
    lead,
    share: MEASURED_BIG_PAIRS.filter(([top, l]) => top >= p && l >= lead).length / n,
  }));
}

/** The derived ladder, for proofs/tests (read-only copy). */
export function opusLadderShares(): Array<{ p: number; lead: number; share: number }> {
  return opusLadder();
}

/**
 * The bar to use for a target share: the STRICTEST ladder step whose measured share still reaches
 * the target (so a 30% target lands on 0.75/0.20, not on the looser 0.65/0.10 that would also give
 * 30%), or the loosest step when even that cannot fill the target. `BUDGET_BRAIN_OPUS_P`/`_LEAD`
 * still override the result outright.
 */
export function opusBarForShare(share = 0.3): { p: number; lead: number } {
  const target = Math.max(0.05, Math.min(0.9, Number.isFinite(share) ? share : 0.3));
  const ladder = opusLadder();
  const reach = ladder.filter((b) => b.share + 1e-9 >= target);
  const chosen = reach.length ? reach[reach.length - 1]! : ladder[0]!;
  return { p: chosen.p, lead: chosen.lead };
}

/** The cheap tier: exactly the model the spec names. */
export function cheapModel(): string {
  return (process.env.BUDGET_BRAIN_CHEAP_MODEL ?? "deepseek-v4.1-flash").trim() || "deepseek-v4.1-flash";
}

export function tierModel(tier: BrainTier): string {
  if (tier === "opus") return config.claudeOpus;
  if (tier === "sonnet") return config.claudeSonnet;
  // FLEET_DEEPSEEK_ONLY: the cheap tier is a Go model; with the switch armed it is mapped onto a
  // DeepSeek model that DeepSeek's own API serves. Identity when the switch is off (default).
  const only = deepseekOnlyModel(cheapModel());
  return only.mapped ? only.model : cheapModel();
}

/** Accepts the older "deepseek" spelling and maps any model id to its tier. */
export function normalizeTier(tier: string): BrainTier {
  const t = String(tier ?? "").toLowerCase();
  if (t === "opus") return "opus";
  if (t === "sonnet" || t === "claude") return "sonnet";
  return "none";
}

export function tierOf(model: string): BrainTier {
  const m = String(model ?? "");
  if (/opus/i.test(m)) return "opus";
  if (/claude|sonnet/i.test(m)) return "sonnet";
  return "none";
}

const TIER_ORDER: BrainTier[] = ["none", "sonnet", "opus"];

export function minTier(a: BrainTier, b: BrainTier): BrainTier {
  return TIER_ORDER[Math.min(TIER_ORDER.indexOf(a), TIER_ORDER.indexOf(b))] ?? "none";
}

/** Which tier the CEO asked for by name in the order text, if any. */
export function ceoNamedTier(text: string): BrainTier | undefined {
  const t = String(text ?? "");
  if (/\b(use|with|on|via)\s+opus\b/i.test(t) || /\bhave\s+opus\b/i.test(t) || /\bopus\s+review\b/i.test(t)) return "opus";
  if (/\b(use|with|on|via)\s+claude\b/i.test(t) || /\buse\s+sonnet\b/i.test(t) || /\bhave\s+claude\b/i.test(t) || /\bclaude\s+review\b/i.test(t)) return "sonnet";
  return undefined;
}

export type BrainPick = {
  tier: BrainTier;
  /** false = no Claude call at all for this pick. */
  claudeCall: boolean;
  model: string;
  reason: string;
  reasonKind: ReasonKind;
  purpose: BrainPurpose;
  /** Laya's size/complexity numbers: top probability, its lead, the class. */
  laya: { asked: boolean; top?: number; lead?: number; predicted?: string; ms?: number; error?: string };
  /** true when the pick is `none` but this call reads files (a gateway model cannot). */
  fileBlind: boolean;
  /** true when Laya could not answer, so the tier came from the fallback rule. */
  layaDown: boolean;
  hardRule?: "redo2" | "failed" | "stuck";
  climbed: boolean;
  checkedAt: string;
};

type LayaReply = { ok: boolean; top?: number; lead?: number; predicted?: string; ms: number; error?: string };

/**
 * Ask Laya the measured size/complexity question, with a deadline.
 *
 * The wire call mirrors decisionCall() in src/decision.ts (`POST /v1/systemone`
 * with {state, questions}) rather than importing it, because that helper is private
 * and takes no timeout, and decision.ts owns the tuned wording (no grant there for
 * a deadline). Any failure returns ok:false; nothing here throws because of Laya.
 */
async function askLaya(text: string, hint: string | undefined, timeoutMs: number): Promise<LayaReply> {
  const started = Date.now();
  if (config.mockMode) return { ok: false, ms: 0, error: "mock mode" };
  const spec = complexityQuestionSpec(text, hint ?? "");
  const isJev = config.decisionBackend === "jev";
  const base = isJev ? config.typesafeBaseUrl : config.decisionBaseUrl;
  const key = isJev ? config.typesafeApiKey : config.decisionKey;
  const body: Record<string, unknown> = isJev
    ? { state: spec.state, model: config.jevModel, questions: spec.questions }
    : { state: spec.state, questions: spec.questions };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) return { ok: false, ms: Date.now() - started, error: `Laya ${res.status}` };
    const doc = (await res.json()) as {
      answers?: Record<string, { noul?: number } | undefined>;
    };
    const l = doc.answers?.long?.noul;
    const m = doc.answers?.multi?.noul;
    const tiny = doc.answers?.tiny?.noul;
    if (typeof l !== "number" || typeof m !== "number" || typeof tiny !== "number") {
      return { ok: false, ms: Date.now() - started, error: "Laya answered without the three probabilities" };
    }
    // Same rule as complexityQuestionSpec's own decide(): top probability and its
    // lead over the runner-up (NOT `confidence`, which collapses on multi-option).
    // BIG means the "long" or "multi" answer is what Laya is confident about. The old
    // code took the top of all three, so a confident "tiny" (a typo, 0.78) counted as
    // BIG and went to Opus - the exact leak this gate exists to stop. Score the big
    // side only: its strongest probability, and its lead over "tiny".
    const bigTop = Math.max(l, m);
    const top = bigTop;
    const lead = bigTop - tiny;
    const predicted = l >= 0.5 ? "DEMANDING" : m >= 0.5 ? "COMPLEX" : tiny >= 0.5 ? "ROUTINE" : "STANDARD";
    return { ok: true, top, lead, predicted, ms: Date.now() - started };
  } catch (e) {
    const msg = (e as Error)?.name === "AbortError" ? `Laya slower than ${timeoutMs} ms` : String((e as Error)?.message ?? e);
    return { ok: false, ms: Date.now() - started, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

export type BrainInput = {
  purpose: BrainPurpose | string;
  /** what will be asked or done - the only thing Laya and the CEO-naming check see. */
  text: string;
  hint?: string;
  /** the call passes a cwd/addDirs, so it reads files (a `none` tier cannot). */
  needsFiles?: boolean;
  /** a hard rule the caller noticed (a 2nd REDO, a failed or stuck run). */
  hardRule?: "redo2" | "failed" | "stuck";
  /** how many times this work already failed on the cheap model (2 = escalate once). */
  cheapFailures?: number;
  /** levels to clamp against; defaults to the guard's current state. */
  budget?: { go: BudgetLevel; claude: BudgetLevel };
  /** optional task context: the pick also lands as a hop on this task's trace. */
  trace?: { projectId: string; taskId: string };
};

/**
 * The gate. Returns the tier, the model, a plain reason and Laya's numbers. Never
 * throws. resolveBrainModel() still puts the result through the budget guard.
 */
export async function pickBrain(opts: BrainInput): Promise<BrainPick> {
  const { purpose, known } = normalizePurpose(opts.purpose);
  const rule = PURPOSE_RULES[purpose];
  const th = brainThresholds();
  const checkedAt = new Date().toISOString();
  const needsFiles = opts.needsFiles ?? rule.files;

  const finish = (
    tier: BrainTier,
    reasonKind: ReasonKind,
    reason: string,
    laya: BrainPick["laya"],
    extra?: { climbed?: boolean; hardRule?: BrainPick["hardRule"]; layaDown?: boolean; fileBlind?: boolean },
  ): BrainPick => {
    // FLEET_DEEPSEEK_ONLY: a `none` tier is a Go model, so with the switch armed it is mapped
    // onto the direct bank; the mapping note goes into the decision-log reason so Laya's own
    // routing stays visible. Claude tiers are never mapped.
    const only = tier === "none" ? deepseekOnlyModel(cheapModel()) : undefined;
    const baseReason = known ? reason : `${reason} [unknown purpose "${String(opts.purpose)}" -> ${purpose}]`;
    const pick: BrainPick = {
      tier,
      claudeCall: tier !== "none",
      model: tierModel(tier),
      reason: only?.mapped ? `${baseReason} | ${only.why}` : baseReason,
      reasonKind,
      purpose,
      laya,
      fileBlind: tier === "none" && needsFiles && !(extra?.fileBlind === false),
      layaDown: extra?.layaDown === true,
      hardRule: extra?.hardRule ?? opts.hardRule,
      climbed: extra?.climbed ?? false,
      checkedAt,
    };
    logDecision(pick, opts);
    if (opts.trace?.projectId && opts.trace?.taskId) {
      try {
        addTrace(opts.trace.projectId, opts.trace.taskId, {
          from: "Laya (brain)",
          to: `${pick.tier} (${pick.model})`,
          what: "model tier",
          detail: `${pick.purpose}: ${pick.reason}${pick.laya.top === undefined ? "" : ` [top=${pick.laya.top.toFixed(2)}, lead=${(pick.laya.lead ?? 0).toFixed(2)}, ${pick.laya.ms ?? 0} ms]`}`,
        });
      } catch (e) {
        console.error(`[brain] could not write the trace hop: ${String(e)}`);
      }
    }
    return pick;
  };

  // RULE 2 first: the CEO named it. Overrides Laya, costs no model call.
  const named = ceoNamedTier(`${opts.text}\n${opts.hint ?? ""}`);
  if (named) {
    const tier = named === "opus" && !rule.opusEligible ? "sonnet" : named;
    return finish(tier, "ceo-override", `the CEO named ${named} in the order -> ${tier}`, { asked: false });
  }

  // Plain rules first (facts about the work), including the spec's safety net: a
  // small task that already failed twice on the cheap model gets ONE Sonnet attempt.
  // Both are independent of Laya, so they still work when Laya is down.
  if (opts.hardRule && rule.hardRules.includes(opts.hardRule) && rule.claudeEligible) {
    const tier: BrainTier = rule.opusEligible ? "opus" : "sonnet";
    return finish(tier, "fallback", `hard rule: ${opts.hardRule} on ${rule.plain} -> ${tier}`, { asked: false }, { hardRule: opts.hardRule });
  }
  if ((opts.cheapFailures ?? 0) >= 2 && rule.claudeEligible) {
    return finish(
      "sonnet",
      "fallback",
      `safety net: the cheap model failed ${opts.cheapFailures} times on ${rule.plain} -> one Sonnet attempt`,
      { asked: true },
      { climbed: true },
    );
  }

  const layaRaw = await askLaya(opts.text, opts.hint, th.layaMs);
  const laya: BrainPick["laya"] = {
    asked: true,
    top: layaRaw.top,
    lead: layaRaw.lead,
    predicted: layaRaw.predicted,
    ms: layaRaw.ms,
    error: layaRaw.error,
  };

  if (!layaRaw.ok) {
    // Laya cannot decide. Cheap by default: an unmeasurable task does NOT become a
    // Claude task. The CEO naming Claude (checked above) and the safety net are the
    // only ways up, and `layaDown` says in the log why this row took the cheap tier.
    const tier = rule.fallbackTier;
    return finish(
      tier,
      "fallback",
      `Laya unavailable (${layaRaw.error ?? "no answer"}) -> ${tier} (cheap by default; CEO-named or a twice-failed task can still climb)`,
      laya,
      { layaDown: true },
    );
  }

  const big = layaRaw.top! >= th.bigP && layaRaw.lead! >= th.bigLead;
  if (!big) {
    // Below the bar: cheaper tier. This is the case that must produce ZERO Claude calls.
    // A purpose with `gatewayFallback` still gets its answer - on the caller's gateway model -
    // so it is NOT fileBlind and must not be answered locally "because it needs real files".
    return finish("none", "laya", `Laya says it is not big (bigScore=max(long,multi)=${layaRaw.top!.toFixed(2)} < ${th.bigP} or leadOverTiny=${layaRaw.lead!.toFixed(2)} < ${th.bigLead}, class ${layaRaw.predicted}) -> no Claude`, laya, rule.gatewayFallback ? { fileBlind: false } : undefined);
  }

  if (!rule.claudeEligible) {
    return finish("none", "laya", `Laya says it is big (bigScore=${layaRaw.top!.toFixed(2)}, class ${layaRaw.predicted}) but ${rule.plain} never takes Claude -> no Claude`, laya);
  }
  if (rule.opusEligible && layaRaw.top! >= th.opusP && layaRaw.lead! >= th.opusLead) {
    return finish("opus", "laya", `Laya reads it as clearly big (bigScore=${layaRaw.top!.toFixed(2)}, leadOverTiny=${layaRaw.lead!.toFixed(2)} >= ${th.opusP}/${th.opusLead}, class ${layaRaw.predicted}) and ${rule.plain} may take opus`, laya);
  }
  return finish("sonnet", "laya", `Laya says it is big (bigScore=${layaRaw.top!.toFixed(2)}, leadOverTiny=${layaRaw.lead!.toFixed(2)}, class ${layaRaw.predicted}) -> Sonnet`, laya);
}

// ---------------------------------------------------------------------------
// The cheap-failure counter (the spec's safety net, for callers that want it)
// ---------------------------------------------------------------------------
function failuresPath(): string {
  return path.join(path.dirname(budgetStatePath()), "brain-failures.json");
}

function readFailures(): Record<string, number> {
  // ATTRIBUTION (fix 3): the 529-byte read that produced the 455 s block now names itself.
  return withBusy("brain failures", () => {
    try {
      return JSON.parse(fs.readFileSync(failuresPath(), "utf8")) as Record<string, number>;
    } catch {
      return {};
    }
  });
}

/** Record one cheap-model failure for a key (e.g. `${purpose}:${taskId}`). */
export function noteCheapFailure(key: string): number {
  return withBusy("brain failures", () => {
    const all = readFailures();
    const n = (all[key] ?? 0) + 1;
    all[key] = n;
    try {
      fs.mkdirSync(path.dirname(failuresPath()), { recursive: true });
      fs.writeFileSync(failuresPath(), JSON.stringify(all, null, 2));
    } catch (e) {
      console.error(`[brain] could not persist the cheap-failure count: ${String(e)}`);
    }
    return n;
  });
}

/** How many cheap-model failures are recorded for a key (2 = escalate once more). */
export function cheapFailures(key: string): number {
  return readFailures()[key] ?? 0;
}

export function clearCheapFailures(key: string): void {
  withBusy("brain failures", () => {
    const all = readFailures();
    if (!(key in all)) return;
    delete all[key];
    try {
      fs.writeFileSync(failuresPath(), JSON.stringify(all, null, 2));
    } catch {
      /* best effort */
    }
  });
}

// ---------------------------------------------------------------------------
// The decision log + the numbers the Budget page shows
// ---------------------------------------------------------------------------
export function brainDecisionsPath(): string {
  return path.join(path.dirname(budgetStatePath()), "brain-decisions.jsonl");
}

export type BrainDecisionLine = {
  ts: string;
  purpose: BrainPurpose;
  tier: BrainTier;
  model: string;
  reasonKind: ReasonKind;
  reason: string;
  top?: number;
  lead?: number;
  predicted?: string;
  ms?: number;
  asked: boolean;
  hardRule?: string;
  needsFiles: boolean;
  fileBlind: boolean;
  climbed: boolean;
  /** false = this call never touched Claude. */
  claudeCall: boolean;
  /** Laya could not answer this one, so the fallback rule picked the tier. */
  layaDown: boolean;
  /** 0 for the cheap tier (its real spend is in the cost ledger); null = subscription. */
  costUsd: number | null;
  textChars: number;
  claudeAvoided: boolean;
  opusAvoided: boolean;
};

/** Purposes whose calls used to be hardcoded to Opus before this gate. */
const OPUS_WAS_DEFAULT: BrainPurpose[] = ["assistant", "fleet-plan"];

function logDecision(pick: BrainPick, opts: BrainInput): void {
  const line: BrainDecisionLine = {
    ts: pick.checkedAt,
    purpose: pick.purpose,
    tier: pick.tier,
    model: pick.model,
    reasonKind: pick.reasonKind,
    reason: pick.reason,
    top: pick.laya.top,
    lead: pick.laya.lead,
    predicted: pick.laya.predicted,
    ms: pick.laya.ms,
    asked: pick.laya.asked,
    hardRule: pick.hardRule,
    needsFiles: opts.needsFiles ?? PURPOSE_RULES[pick.purpose].files,
    fileBlind: pick.fileBlind,
    layaDown: pick.layaDown,
    climbed: pick.climbed,
    claudeCall: pick.claudeCall,
    costUsd: pick.claudeCall ? null : 0,
    textChars: String(opts.text ?? "").length,
    claudeAvoided: !pick.claudeCall,
    opusAvoided: OPUS_WAS_DEFAULT.includes(pick.purpose) && pick.tier !== "opus",
  };
  try {
    fs.mkdirSync(path.dirname(brainDecisionsPath()), { recursive: true });
    fs.appendFileSync(brainDecisionsPath(), JSON.stringify(line) + "\n");
    trimBrainLog();
  } catch (e) {
    console.error(`[brain] could not log the decision: ${String(e)}`);
  }
}

const BRAIN_LOG_MAX = 5000;

function trimBrainLog(): void {
  try {
    const file = brainDecisionsPath();
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim());
    if (lines.length <= BRAIN_LOG_MAX) return;
    fs.writeFileSync(file, lines.slice(-BRAIN_LOG_MAX).join("\n") + "\n");
  } catch {
    /* the log is a convenience, never a source of truth */
  }
}

export type BrainStats = {
  day: string;
  calls: number;
  byTier: Record<BrainTier, number>;
  byPurpose: Record<string, number>;
  byReason: Record<string, number>;
  claudeCalls: number;
  claudeAvoided: number;
  opusAvoided: number;
  fileBlind: number;
  layaDown: number;
  layaAnswered: number;
  layaFailed: number;
  climbed: number;
  medianMs: number;
};

/** Today's routing numbers, for the Budget page and for my own proof runs. */
export function brainStats(day = new Date().toISOString().slice(0, 10)): BrainStats {
  // ROUTER-HANG (2026-09-30): /company/budget is polled by the dashboard, and this log
  // had reached 215 KB, so every poll re-read and re-parsed the whole file synchronously
  // on the event loop - on a box whose fs metadata is AV-inflated (the repo has measured
  // 1.0-1.3 s for a single stat/exists under load). The result is a pure function of
  // (file content, day), so it is memoised on the file's mtime+size, the same rule
  // cache.ts applies everywhere else; a write is picked up on the very next call.
  // Callers get their own copy, so nobody can poison the memo by mutating the answer.
  const stats = cachedBySig<BrainStats>(`brain:stats:${day}`, fileSig(brainDecisionsPath()), () =>
    computeBrainStats(day),
  );
  return { ...stats, byTier: { ...stats.byTier }, byPurpose: { ...stats.byPurpose }, byReason: { ...stats.byReason } };
}

/** The uncached computation behind brainStats(): read the log, fold today's lines. */
function computeBrainStats(day: string): BrainStats {
  const stats: BrainStats = {
    day,
    calls: 0,
    byTier: { none: 0, sonnet: 0, opus: 0 },
    byPurpose: {},
    byReason: {},
    claudeCalls: 0,
    claudeAvoided: 0,
    opusAvoided: 0,
    fileBlind: 0,
    layaDown: 0,
    layaAnswered: 0,
    layaFailed: 0,
    climbed: 0,
    medianMs: 0,
  };
  let text: string;
  try {
    text = fs.readFileSync(brainDecisionsPath(), "utf8");
  } catch {
    return stats;
  }
  const latencies: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let d: BrainDecisionLine;
    try {
      d = JSON.parse(line) as BrainDecisionLine;
    } catch {
      continue;
    }
    if (String(d.ts ?? "").slice(0, 10) !== day) continue;
    stats.calls += 1;
    if (d.tier) stats.byTier[d.tier] = (stats.byTier[d.tier] ?? 0) + 1;
    stats.byPurpose[d.purpose] = (stats.byPurpose[d.purpose] ?? 0) + 1;
    stats.byReason[d.reasonKind] = (stats.byReason[d.reasonKind] ?? 0) + 1;
    if (d.claudeCall) stats.claudeCalls += 1;
    else stats.claudeAvoided += 1;
    if (d.opusAvoided) stats.opusAvoided += 1;
    if (d.fileBlind) stats.fileBlind += 1;
    if (d.layaDown) stats.layaDown += 1;
    if (d.climbed) stats.climbed += 1;
    if (d.asked && typeof d.top === "number") stats.layaAnswered += 1;
    if (d.asked && typeof d.top !== "number") stats.layaFailed += 1;
    if (typeof d.ms === "number" && d.ms > 0) latencies.push(d.ms);
  }
  latencies.sort((a, b) => a - b);
  stats.medianMs = latencies.length ? latencies[Math.floor(latencies.length / 2)]! : 0;
  return stats;
}

/**
 * The tier chain for a call site: the gate's pick, then the caller's own model as a
 * CEILING (`model`/ASSISTANT_MODEL/FLEET_PLANNER_MODEL mean "never above this"),
 * then the budget guard as the FINAL filter. A ceiling that is NOT a Claude model
 * (undefined, or a gateway id) imposes nothing - see the note in the body.
 */
export function resolveBrainModel(
  pick: BrainPick,
  requestedModel: string,
  role: string = pick.purpose,
): { model: string; tier: BrainTier; reason: string; changed: string[]; claudeCall: boolean } {
  const changed: string[] = [];
  const ceiling = tierOf(requestedModel);
  // CHEAP BY DEFAULT (bug found by the safety-net proof, 2026-09-30): a ceiling of `none` means the
  // caller named no Claude model at all (or named a cheap one) - that is the DEFAULT, not a veto.
  // Applying it cancelled BOTH escape hatches (a CEO naming, and `pickBrain`'s safety-net climb),
  // so an undefined `model` turned "the cheap tier failed twice -> one Sonnet attempt" straight back
  // into the cheap tier that had just failed. Only a real Claude ceiling (sonnet/opus) caps a pick.
  let tier = ceiling === "none" ? pick.tier : minTier(pick.tier, ceiling);
  if (tier !== pick.tier) changed.push(`ceiling ${requestedModel} (max tier ${ceiling})`);
  let model = tierModel(tier);
  const filtered = applyBudgetFilter({ model, role });
  if (filtered.changed) {
    changed.push(`budget guard: ${filtered.reason}`);
    model = filtered.model;
    tier = tierOf(model);
  }
  const reason = `${pick.reason}${changed.length ? ` | ${changed.join(" | ")}` : ""}`;
  return { model, tier, reason, changed, claudeCall: tier !== "none" };
}
