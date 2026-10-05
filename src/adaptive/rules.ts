/**
 * src/adaptive/rules.ts — the rule engine and the circuit breaker.
 *
 * Laya's current choice (chooseBestModel / decideRoute) stays the PRIOR; these
 * rules only adjust it with live evidence:
 *
 *   1. cheap-by-default: the prior is kept while it clears the class threshold;
 *   2. escalate to the cheapest model that clears it when the prior does not;
 *   3. circuit breaker: a model below 50% over its last 20 samples (or with 429s)
 *      is skipped for a cool-off, then half-opened once;
 *   4. 5% exploration so a recovered model gets re-tested (never on CEO-named or
 *      high-risk requests);
 *   5. cold start (<10 samples) trusts Laya's prior;
 *   6. hard rules first: air-gapped, CEO-named model, per-agent budget,
 *      tool-capable model required when the request needs tools;
 *   7. every decision carries a reason string ("deepseek P=0.93 >= 0.85, cheapest").
 */
import { byCost, CLASS_FLOOR, modelCatalog, namedModel, specFor, type ModelSpec } from "./catalog.js";
import type { TaskClass, Via } from "./events.js";
import type { Estimator } from "./estimator.js";

export type CircuitState = "closed" | "open" | "half-open";

export type CircuitView = { state: CircuitState; detail: string };

export function thresholdFor(cls: TaskClass): number {
  const perClass = process.env[`ADAPTIVE_MIN_SUCCESS_${cls}`];
  const raw = perClass ?? process.env.ADAPTIVE_MIN_SUCCESS ?? "0.85";
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.85;
}

export function exploreRate(): number {
  const n = Number(process.env.ADAPTIVE_EXPLORE ?? "0.05");
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.05;
}

export function coolOffMs(): number {
  const n = Number(process.env.ADAPTIVE_COOLDOWN_MS ?? "120000");
  return Number.isFinite(n) && n > 0 ? n : 120_000;
}

export function circuitFailRate(): number {
  const n = Number(process.env.ADAPTIVE_CIRCUIT_FAIL_RATE ?? "0.5");
  return Number.isFinite(n) && n > 0 && n < 1 ? n : 0.5;
}

export type Window = { n: number; fails: number; rate: number; count429: number };

/**
 * Circuit breaker over the estimator's recent window. The state always DERIVES
 * from the live window (so recovery closes the circuit by itself); the only state
 * kept here is when the circuit opened, which gates the cool-off / half-open.
 */
export class CircuitBreaker {
  private entries = new Map<string, { openedAt: number; reason: string }>();
  constructor(
    private coolOff = coolOffMs(),
    private minSamples = 10,
    private failRate = circuitFailRate(),
    private max429 = 3,
  ) {}

  static key(model: string, cls: TaskClass): string {
    return `${model}|${cls}`;
  }

  private failing(w: Window): boolean {
    if (w.n < this.minSamples) return false;
    return w.rate < this.failRate || w.count429 >= this.max429;
  }

  state(model: string, cls: TaskClass, w: Window, now: number): CircuitView {
    const key = CircuitBreaker.key(model, cls);
    if (!this.failing(w)) {
      this.entries.delete(key);
      return { state: "closed", detail: `window ${w.n - w.fails}/${w.n} ok` };
    }
    const why = w.count429 >= this.max429 ? `${w.count429}/${w.n} 429s` : `${w.fails}/${w.n} failed`;
    let e = this.entries.get(key);
    if (!e) {
      e = { openedAt: now, reason: why };
      this.entries.set(key, e);
    }
    e.reason = why;
    const elapsed = now - e.openedAt;
    if (elapsed >= this.coolOff) {
      return { state: "half-open", detail: `cool-off elapsed after ${Math.round(elapsed / 1000)}s (${why}) - one trial` };
    }
    return { state: "open", detail: `${why}; ${Math.ceil((this.coolOff - elapsed) / 1000)}s cool-off left` };
  }

  /** Feed one outcome so a failed half-open trial restarts the cool-off. */
  observe(model: string, cls: TaskClass, ok: boolean, w: Window, now: number): void {
    const key = CircuitBreaker.key(model, cls);
    const view = this.state(model, cls, w, now);
    if (ok) {
      if (view.state === "closed") this.entries.delete(key);
      return;
    }
    if (view.state === "half-open") {
      const e = this.entries.get(key);
      if (e) {
        e.openedAt = now;
        e.reason = `half-open trial failed (${e.reason})`;
      }
    }
  }

  /** Snapshot for the dashboard: every key the breaker currently holds. */
  openCircuits(): Record<string, { reason: string; openedAt: string; msInState: number }> {
    const now = Date.now();
    const out: Record<string, { reason: string; openedAt: string; msInState: number }> = {};
    for (const [k, v] of this.entries) out[k] = { reason: v.reason, openedAt: new Date(v.openedAt).toISOString(), msInState: now - v.openedAt };
    return out;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Per-class preference order (costRank), cheapest-first for the class. */
const CLASS_RANKS: Record<TaskClass, number[]> = {
  ROUTINE: [0, 1, 2, 3, 4],
  STANDARD: [1, 0, 2, 3, 4],
  COMPLEX: [2, 1, 3, 4],
  DEMANDING: [3, 4, 2],
};

function preferredFor(cls: TaskClass): ModelSpec[] {
  const cat = modelCatalog();
  const out: ModelSpec[] = [];
  for (const r of CLASS_RANKS[cls]) {
    // Prefer the coding route when two models share a rank (qwen is chat/docs).
    const pick =
      cat.filter((m) => m.costRank === r && m.via !== "qwen-messages").sort(byCost)[0] ??
      cat.filter((m) => m.costRank === r).sort(byCost)[0];
    if (pick && !out.some((m) => m.id === pick.id)) out.push(pick);
  }
  // Anything in the catalog that is not in the class order is still eligible, so a
  // config with extra models never locks the engine out.
  for (const m of [...cat].sort(byCost)) if (!out.some((x) => x.id === m.id)) out.push(m);
  return out;
}

export type SelectInput = {
  prior: { modelId: string; via: Via; reason?: string };
  cls: TaskClass;
  prompt: string;
  taskHint?: string;
  /** The request needs a tool call, so a chat-only model must not be picked. */
  requiresTools?: boolean;
  /** The agent is over its budget: cost wins over capability. */
  overBudget?: boolean;
  /** High-risk work: no exploration. */
  highRisk?: boolean;
  /** Never escalate above the prior (default false = escalation allowed). */
  noEscalate?: boolean;
  /** Injected clock + RNG for deterministic checks/sims. */
  nowMs?: number;
  rng?: () => number;
  source?: string;
  /** Checks/sims only: set false to disable exploration deterministically. */
  allowExploreForTest?: boolean;
};

export type SelectResult = {
  modelId: string;
  via: Via;
  reason: string;
  cls: TaskClass;
  prior: string;
  changed: boolean;
  explored: boolean;
  /** Circuit state per candidate considered, for the decision event/dashboard. */
  circuit: Record<string, string>;
  threshold: number;
  coldStart: boolean;
  hardRule?: string;
};

function sameModel(id: string, spec: ModelSpec | undefined): boolean {
  return !!spec && spec.id === id;
}

/**
 * The rule engine. Pure: it reads the estimator and the breaker, never the clock
 * (unless `nowMs` is omitted) and never the network.
 */
export function select(
  input: SelectInput,
  est: Estimator,
  breaker: CircuitBreaker,
): SelectResult {
  const now = input.nowMs ?? Date.now();
  const rng = input.rng ?? Math.random;
  const threshold = thresholdFor(input.cls);
  const cls = input.cls;
  const cat = modelCatalog();
  const priorSpec = specFor(input.prior.modelId, cat);
  const priorRank = priorSpec?.costRank ?? 99;
  const nominalPrior: ModelSpec =
    priorSpec ?? { id: input.prior.modelId, via: input.prior.via, costRank: 99, costUsd: 0, toolCapable: true, label: "prior" };
  const circuit: Record<string, string> = {};

  const finish = (
    spec: ModelSpec,
    reason: string,
    extra: Partial<SelectResult> = {},
  ): SelectResult => ({
    modelId: spec.id,
    via: spec.via,
    reason,
    cls,
    prior: input.prior.modelId,
    changed: spec.id !== input.prior.modelId,
    explored: false,
    circuit,
    threshold,
    coldStart: est.n(nominalPrior.id, cls) < est.cfg.coldStartMin,
    ...extra,
  });

  const priorReason = input.prior.reason ? `prior reason: ${input.prior.reason}` : "prior reason: (none)";

  // ---- Hard rule: air-gapped (no outbound model may be selected) -------------
  if ((process.env.AIR_GAPPED ?? "").trim() === "1") {
    return finish(nominalPrior, `air-gapped flag: keeping prior ${nominalPrior.id}; no outbound selection (${priorReason})`, {
      hardRule: "air_gapped",
    });
  }

  // ---- Hard rule: the CEO named a model --------------------------------------
  const named = namedModel(`${input.prompt}\n${input.taskHint ?? ""}`, cat);
  if (named?.modelId) {
    const spec = specFor(named.modelId, cat);
    if (spec) {
      return finish(spec, `CEO named ${named.alias} -> ${spec.id} (hard rule; no exploration)`, { hardRule: "ceo_named" });
    }
  }

  // ---- Candidate set --------------------------------------------------------
  // Never below the class floor, never below the prior (no silent downgrade of
  // work Laya already judged this hard), unless the agent is over budget.
  const floor = Math.min(CLASS_FLOOR[cls], priorRank === 99 ? CLASS_FLOOR[cls] : priorRank);
  let candidates = modelCatalog().filter((m) => m.costRank >= floor || sameModel(m.id, nominalPrior));
  if (!candidates.some((m) => m.id === nominalPrior.id)) candidates = [nominalPrior, ...candidates];
  if (input.requiresTools) {
    const toolCapable = candidates.filter((m) => m.toolCapable || m.id === nominalPrior.id);
    if (toolCapable.length) candidates = toolCapable;
  }
  // Agentic classes need a model that can return a tool call at all: a chat-only
  // model must not be escalated INTO planning/coding work (it can still be the prior
  // if Laya itself chose it, or the only candidate left).
  if (cls === "COMPLEX" || cls === "DEMANDING") {
    const toolCapable = candidates.filter((m) => m.toolCapable || m.id === nominalPrior.id);
    if (toolCapable.length) candidates = toolCapable;
  }
  if (input.noEscalate) candidates = candidates.filter((m) => m.costRank <= priorRank || m.id === nominalPrior.id);

  // Preferred (cheapest-first) order for the class, then anything else by cost.
  const order = preferredFor(cls);
  candidates.sort((a, b) => order.indexOf(a) - order.indexOf(b) || byCost(a, b));
  if (input.overBudget) {
    const cheapest = [...candidates].sort(byCost);
    candidates = cheapest.filter((m) => m.costUsd <= (priorSpec?.costUsd ?? Infinity) || m.id === nominalPrior.id);
    if (!candidates.length) candidates = cheapest.slice(0, 1);
  }

  // ---- Circuit state per candidate ------------------------------------------
  const views = candidates.map((m) => {
    const w = est.recent(m.id, cls);
    const view = breaker.state(m.id, cls, w, now);
    circuit[m.id] = view.state === "closed" ? "closed" : `${view.state}: ${view.detail}`;
    return { spec: m, view, w };
  });
  const open = views.filter((v) => v.view.state === "open");
  const usable = views.filter((v) => v.view.state !== "open");

  // ---- Cold start: trust Laya's prior ---------------------------------------
  const priorSamples = est.n(nominalPrior.id, cls);
  if (priorSamples < est.cfg.coldStartMin) {
    return finish(nominalPrior, `cold start: prior ${nominalPrior.id} (n=${priorSamples} < ${est.cfg.coldStartMin}); trusting Laya`, {
      coldStart: true,
    });
  }

  // ---- Half-open trial: after the cool-off, give the model the one trial the
  // circuit breaker promises (standard CB semantics). A success earns trust back
  // (the estimator's recovery streak); a failure restarts the cool-off.
  const halfOpen = views.filter((v) => v.view.state === "half-open").sort((a, b) => byCost(a.spec, b.spec));
  if (halfOpen.length) {
    const t = halfOpen[0];
    return finish(t.spec, `circuit half-open: trial ${t.spec.id} after cool-off (${t.view.detail})`);
  }

  // ---- Live P per candidate --------------------------------------------------
  const scored = usable.map((v) => ({ ...v, p: est.p(v.spec.id, cls) }));
  const priorScored = scored.find((s) => s.spec.id === nominalPrior.id);
  const priorP = priorScored?.p ?? null;

  // ---- Exploration (5%): re-test a model the circuit is currently skipping, or
  // one that failed recently, so a recovered model gets a fresh sample. Never on
  // CEO-named, high-risk, DEMANDING or over-budget requests.
  const exploreAllowed =
    input.allowExploreForTest !== false && !input.highRisk && !input.overBudget && cls !== "DEMANDING" && !named;
  if (exploreAllowed && rng() < exploreRate()) {
    const pool = views
      .filter((v) => est.n(v.spec.id, cls) > 0)
      .filter((v) => v.w.fails > 0 || v.view.state !== "closed" || (est.p(v.spec.id, cls) ?? 1) < threshold)
      .sort((a, b) => byCost(a.spec, b.spec));
    const target = pool[0];
    if (target) {
      const p = est.p(target.spec.id, cls);
      return finish(
        target.spec,
        `exploration (${(exploreRate() * 100).toFixed(0)}%): re-testing ${target.spec.id} P=${p === null ? "cold" : p.toFixed(2)} n=${est.n(target.spec.id, cls)} (${target.view.state}) instead of ${nominalPrior.id}`,
        { explored: true },
      );
    }
  }

  // ---- Pick: the cheapest candidate whose live P clears the threshold --------
  const clearing = scored.filter((s) => s.p !== null && s.p >= threshold);
  if (clearing.length) {
    const best = clearing[0]; // sorted cheapest-first
    const p = best.p as number;
    if (best.spec.id === nominalPrior.id) {
      return finish(best.spec, `${best.spec.id} P=${p.toFixed(2)} >= ${threshold}, cheapest (prior kept)`);
    }
    const why = open.some((o) => o.spec.id === nominalPrior.id)
      ? `prior ${nominalPrior.id} circuit open`
      : priorP === null
        ? `prior ${nominalPrior.id} cold`
        : `prior ${nominalPrior.id} P=${priorP.toFixed(2)} < ${threshold}`;
    return finish(
      best.spec,
      `${best.spec.id} P=${p.toFixed(2)} >= ${threshold}, cheapest that clears (escalation: ${why})`,
    );
  }

  // ---- Nothing clears: take the best live P, and say so ----------------------
  const known = scored.filter((s) => s.p !== null).sort((a, b) => (b.p as number) - (a.p as number));
  if (known.length) {
    const best = known[0];
    const p = best.p as number;
    const skipped = open.length ? `; skipped: ${open.map((o) => `${o.spec.id} circuit open (${o.view.detail})`).join(", ")}` : "";
    if (best.spec.id === nominalPrior.id) {
      return finish(best.spec, `no candidate clears ${threshold}; best live P is the prior ${best.spec.id} P=${p.toFixed(2)}, keeping it${skipped}`);
    }
    return finish(best.spec, `no candidate clears ${threshold}; best live P is ${best.spec.id} P=${p.toFixed(2)} (prior ${nominalPrior.id} P=${priorP === null ? "cold" : priorP.toFixed(2)})${skipped}`);
  }

  // ---- No live data and no usable candidate: prior, unless its own circuit is open.
  if (priorScored === undefined && open.some((o) => o.spec.id === nominalPrior.id)) {
    const next = usable[0];
    if (next) {
      return finish(
        next.spec,
        `${nominalPrior.id} circuit open (${circuit[nominalPrior.id]}); routed to next cheapest ${next.spec.id} (no live P yet)`,
      );
    }
  }
  const skipped = open.length ? `; skipped: ${open.map((o) => `${o.spec.id} (${o.view.detail})`).join(", ")}` : "";
  return finish(nominalPrior, `no live data for the candidates; keeping prior ${nominalPrior.id}${skipped}`);
}
