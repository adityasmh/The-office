/**
 * src/adaptive/estimator.ts — the online success estimator ("real-time ML engine"
 * in the CEO's diagram).
 *
 * Live P(success | model, task class) per pair, plus latency p50/p95 and cost per
 * call, updated on every outcome event. Counts are decayed (EWMA) so a model that
 * recovered is not punished forever by old failures, and a short recent window
 * (last N=20) is kept separately for the circuit breaker.
 *
 * Cold start: fewer than `coldStartMin` samples (10 by default) means "no opinion":
 * `p()` returns null and the rule engine trusts Laya's prior.
 */
import type { FailureKind, Sample, TaskClass } from "./events.js";
import { FAILURE_KINDS } from "./events.js";

export type EstimatorConfig = {
  /** EWMA weight of the newest sample (0.9-0.99). */
  alpha: number;
  /** Below this many samples a pair is "cold" and has no opinion. */
  coldStartMin: number;
  /** Circuit-breaker window size. */
  window: number;
  /** Latency percentile window (last N latencies). */
  latencyWindow: number;
  /** Cap on the id-dedupe set (bounded memory). */
  dedupeMax: number;
  /** Consecutive successes that count as "recovered" (see p()). */
  recoveryStreak: number;
};

export const DEFAULT_ESTIMATOR_CONFIG: EstimatorConfig = {
  alpha: Number(process.env.ADAPTIVE_ALPHA ?? 0.97),
  coldStartMin: Number(process.env.ADAPTIVE_COLD_START ?? 10),
  window: 20,
  latencyWindow: 200,
  dedupeMax: 5000,
  recoveryStreak: Number(process.env.ADAPTIVE_RECOVERY_STREAK ?? 5),
};

export type PairStats = {
  model: string;
  cls: TaskClass;
  /** Raw sample count. */
  n: number;
  /** Raw successes. */
  ok: number;
  /** Decayed counts (EWMA). */
  decayedN: number;
  decayedOk: number;
  /** Live P(success) = decayedOk/decayedN; null while cold. */
  p: number | null;
  /** Success rate over the last `window` samples (circuit breaker input). */
  recentRate: number;
  recentN: number;
  recent429: number;
  latencyP50: number;
  latencyP95: number;
  meanLatencyMs: number;
  meanTokens: number;
  costPerCall: number;
  kinds: Record<string, number>;
  lastTs: string;
};

type Pair = {
  model: string;
  cls: TaskClass;
  n: number;
  ok: number;
  decayedN: number;
  decayedOk: number;
  recent: { ok: boolean; kind: FailureKind; ts: number }[];
  lat: number[];
  latSum: number;
  tokensSum: number;
  costSum: number;
  kinds: Record<string, number>;
  lastTs: string;
};

function keyOf(model: string, cls: TaskClass): string {
  return `${model}|${cls}`;
}

export class Estimator {
  readonly cfg: EstimatorConfig;
  private pairs = new Map<string, Pair>();
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private applied = 0;

  constructor(cfg: Partial<EstimatorConfig> = {}) {
    this.cfg = { ...DEFAULT_ESTIMATOR_CONFIG, ...cfg };
  }

  get appliedCount(): number {
    return this.applied;
  }

  /**
   * Apply one outcome. Idempotent by event id, so the same event may arrive both
   * from the local record path and from the Kafka consumer group without being
   * counted twice.
   */
  apply(model: string, cls: TaskClass, sample: Sample, eventId?: string): boolean {
    if (eventId) {
      if (this.seen.has(eventId)) return false;
      this.seen.add(eventId);
      this.seenOrder.push(eventId);
      if (this.seenOrder.length > this.cfg.dedupeMax) {
        const drop = this.seenOrder.shift();
        if (drop) this.seen.delete(drop);
      }
    }
    const k = keyOf(model, cls);
    let p = this.pairs.get(k);
    if (!p) {
      p = {
        model,
        cls,
        n: 0,
        ok: 0,
        decayedN: 0,
        decayedOk: 0,
        recent: [],
        lat: [],
        latSum: 0,
        tokensSum: 0,
        costSum: 0,
        kinds: {},
        lastTs: "",
      };
      this.pairs.set(k, p);
    }
    const a = Math.min(0.999, Math.max(0.5, this.cfg.alpha));
    p.n += 1;
    if (sample.ok) p.ok += 1;
    p.decayedN = p.decayedN * a + 1;
    p.decayedOk = p.decayedOk * a + (sample.ok ? 1 : 0);
    p.recent.push({ ok: sample.ok, kind: sample.failureKind, ts: Date.now() });
    if (p.recent.length > this.cfg.window) p.recent.splice(0, p.recent.length - this.cfg.window);
    if (sample.latencyMs > 0) {
      p.lat.push(sample.latencyMs);
      p.latSum += sample.latencyMs;
      if (p.lat.length > this.cfg.latencyWindow) {
        const drop = p.lat.shift();
        if (drop) p.latSum -= drop;
      }
    }
    p.tokensSum += sample.tokens || 0;
    p.costSum += sample.cost || 0;
    p.kinds[sample.failureKind] = (p.kinds[sample.failureKind] ?? 0) + 1;
    p.lastTs = new Date().toISOString();
    this.applied += 1;
    return true;
  }

  /** Live P(success): null while cold ("trust Laya's prior"). */
  p(model: string, cls: TaskClass): number | null {
    const s = this.pairs.get(keyOf(model, cls));
    if (!s || s.n < this.cfg.coldStartMin || s.decayedN <= 0) return null;
    const ewma = s.decayedOk / s.decayedN;
    // Recovery signal: a run of unbroken successes earns trust back faster than the
    // EWMA alone (otherwise a model that recovers stays below the threshold for ~50
    // calls). p_recovery = 1 - 2^-streak: 5 in a row => 0.97.
    const streak = this.streakOk(s);
    if (streak >= this.cfg.recoveryStreak) return Math.max(ewma, 1 - Math.pow(2, -streak));
    return ewma;
  }

  /** Consecutive successes at the tail of the recent window. */
  streakOk(s: Pair): number {
    let n = 0;
    for (let i = s.recent.length - 1; i >= 0; i--) {
      if (!s.recent[i].ok) break;
      n += 1;
    }
    return n;
  }

  consecutiveOk(model: string, cls: TaskClass): number {
    const s = this.pairs.get(keyOf(model, cls));
    return s ? this.streakOk(s) : 0;
  }

  n(model: string, cls: TaskClass): number {
    return this.pairs.get(keyOf(model, cls))?.n ?? 0;
  }

  recent(model: string, cls: TaskClass): { n: number; fails: number; rate: number; count429: number; lastTs: string } {
    const s = this.pairs.get(keyOf(model, cls));
    if (!s) return { n: 0, fails: 0, rate: 1, count429: 0, lastTs: "" };
    const fails = s.recent.filter((r) => !r.ok).length;
    return {
      n: s.recent.length,
      fails,
      rate: s.recent.length ? 1 - fails / s.recent.length : 1,
      count429: s.recent.filter((r) => r.kind === "http_429").length,
      lastTs: s.lastTs,
    };
  }

  private percentiles(lat: number[]): { p50: number; p95: number } {
    if (!lat.length) return { p50: 0, p95: 0 };
    const sorted = [...lat].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
    return { p50: Math.round(at(0.5)), p95: Math.round(at(0.95)) };
  }

  stats(model: string, cls: TaskClass): PairStats | null {
    const s = this.pairs.get(keyOf(model, cls));
    if (!s) return null;
    const { p50, p95 } = this.percentiles(s.lat);
    return {
      model,
      cls,
      n: s.n,
      ok: s.ok,
      decayedN: Number(s.decayedN.toFixed(2)),
      decayedOk: Number(s.decayedOk.toFixed(2)),
      p: this.p(model, cls),
      recentRate: s.recent.length ? 1 - s.recent.filter((r) => !r.ok).length / s.recent.length : 1,
      recentN: s.recent.length,
      recent429: s.recent.filter((r) => r.kind === "http_429").length,
      latencyP50: p50,
      latencyP95: p95,
      meanLatencyMs: s.lat.length ? Math.round(s.latSum / s.lat.length) : 0,
      meanTokens: s.n ? Math.round(s.tokensSum / s.n) : 0,
      costPerCall: s.n ? Number((s.costSum / s.n).toFixed(6)) : 0,
      kinds: { ...s.kinds },
      lastTs: s.lastTs,
    };
  }

  /** Every learned pair, stable order (model, class). */
  table(): PairStats[] {
    return [...this.pairs.values()]
      .map((s) => this.stats(s.model, s.cls))
      .filter((s): s is PairStats => !!s)
      .sort((a, b) => a.model.localeCompare(b.model) || a.cls.localeCompare(b.cls));
  }

  /** Failure-kind histogram across all pairs (dashboard). */
  kindHistogram(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const fk of FAILURE_KINDS) out[fk] = 0;
    for (const s of this.pairs.values()) for (const [k, v] of Object.entries(s.kinds)) out[k] = (out[k] ?? 0) + v;
    return out;
  }

  toJSON(): unknown {
    return {
      version: 1,
      savedAt: new Date().toISOString(),
      cfg: this.cfg,
      applied: this.applied,
      pairs: [...this.pairs.values()],
    };
  }

  static fromJSON(raw: unknown): Estimator {
    const obj = (raw ?? {}) as { cfg?: Partial<EstimatorConfig>; pairs?: Pair[]; applied?: number };
    const est = new Estimator(obj.cfg ?? {});
    for (const p of obj.pairs ?? []) {
      if (!p || typeof p.model !== "string" || typeof p.cls !== "string") continue;
      const t = p as Pair;
      est.pairs.set(keyOf(t.model, t.cls), {
        ...t,
        recent: (t.recent ?? []).slice(-20),
        lat: (t.lat ?? []).slice(-200),
        kinds: t.kinds ?? {},
      });
    }
    est.applied = Number(obj.applied ?? 0);
    return est;
  }

  /** For tests/sims: forget everything. */
  reset(): void {
    this.pairs.clear();
    this.seen.clear();
    this.seenOrder = [];
    this.applied = 0;
  }
}
