/**
 * src/adaptive/index.ts — the adaptive-routing engine: bus + estimator + rules +
 * persistence, wired behind the `ADAPTIVE_ROUTING` flag (default 0).
 *
 * Nothing here runs (no timers, no subscriptions, no disk writes) unless the
 * engine is enabled or a tool constructs one on purpose, so importing this module
 * from the router costs nothing and changes nothing by default.
 */
import { classifyFailure, newId, nowIso, type FailureKind, type OutcomeEvent, type TaskClass, type Via } from "./events.js";
import { Estimator, type EstimatorConfig, type PairStats } from "./estimator.js";
import { AdaptiveStore, adaptiveRoot } from "./persistence.js";
import { CircuitBreaker, coolOffMs, exploreRate, select as selectModelRules, thresholdFor, type SelectInput, type SelectResult } from "./rules.js";
import { kafkaBrokersFromEnv, TopicRouter } from "./topic.js";
import type { BusStats } from "./types.js";

export * from "./events.js";
export * from "./estimator.js";
export * from "./types.js";
export * from "./catalog.js";
export { CircuitBreaker, thresholdFor, exploreRate, coolOffMs, selectModelRules, type SelectInput, type SelectResult };
export { TopicRouter, InProcessTopic, KafkaTopic, kafkaBrokersFromEnv } from "./topic.js";
export { AdaptiveStore, adaptiveRoot, outcomesPath, estimatesPath } from "./persistence.js";
export { withAdaptive, recordAdaptiveOutcome, estimateCostUsd, type AdaptiveRouteLike, type OutcomeInfo } from "./hook.js";

export type RecordInput = {
  id?: string;
  /** Event timestamp (ISO). Defaults to now; the replay tool passes the original. */
  ts?: string;
  model: string;
  cls: TaskClass;
  ok: boolean;
  failureKind?: FailureKind;
  latencyMs?: number;
  tokens?: number;
  cost?: number;
  via?: Via;
  source?: string;
  agent?: string;
  error?: unknown;
  status?: number;
};

export type AdaptiveFlags = { key: string; label: string; on: boolean; detail: string };

export type AdaptiveEngineOptions = {
  root?: string;
  brokers?: string[] | null;
  cfg?: Partial<EstimatorConfig>;
  enabled?: boolean;
  /** Persist outcomes/estimates (default true; tools may disable for a dry run). */
  persist?: boolean;
  /** Subscribe the estimator + monitor consumer groups (default true). */
  subscribe?: boolean;
  source?: string;
};

export function adaptiveEnabled(): boolean {
  return (process.env.ADAPTIVE_ROUTING ?? "0").trim() === "1";
}

export class AdaptiveEngine {
  readonly est: Estimator;
  readonly breaker: CircuitBreaker;
  readonly bus: TopicRouter;
  readonly store: AdaptiveStore;
  readonly source: string;
  enabled: boolean;
  startedAt: string | null = null;
  private persist: boolean;
  private subscribeGroups: boolean;
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  private observed = new Set<string>();
  private observedOrder: string[] = [];
  decisions: import("./events.js").DecisionEvent[] = [];
  events: OutcomeEvent[] = [];
  counters = { decisions: 0, escalations: 0, explorations: 0, events: 0, dupes: 0, drops: 0, coldStarts: 0 };

  constructor(opts: AdaptiveEngineOptions = {}) {
    this.est = new Estimator(opts.cfg ?? {});
    this.breaker = new CircuitBreaker();
    this.enabled = opts.enabled ?? adaptiveEnabled();
    // With the flag off the router must not even try to reach a broker.
    const brokers = opts.brokers !== undefined ? opts.brokers : this.enabled ? kafkaBrokersFromEnv() : null;
    this.bus = new TopicRouter(brokers);
    this.store = new AdaptiveStore(opts.root);
    this.persist = opts.persist ?? true;
    this.subscribeGroups = opts.subscribe ?? true;
    this.source = opts.source ?? "router";
  }

  /** Idempotent. Loads persisted state and joins the consumer groups. */
  start(): void {
    if (this.startedAt) return;
    this.startedAt = nowIso();
    if (this.persist) {
      const loaded = this.store.loadEstimator();
      if (loaded) this.restore(loaded);
    }
    if (this.subscribeGroups) {
      // The estimator consumer group (replays the last hour on start) and the
      // dashboard feed. Both apply through the same idempotent estimator.
      this.bus.subscribe("laya-estimator", "laya.outcomes", (m) => {
        const e = m.value as OutcomeEvent;
        if (e && e.model && e.cls) this.applyEvent(e);
      }, { sinceMs: 60 * 60 * 1000 });
      this.bus.subscribe("laya-monitor", "laya.outcomes", (m) => {
        const e = m.value as OutcomeEvent;
        if (e && e.model) this.observe(e);
      }, { sinceMs: 60 * 60 * 1000 });
    }
    if (this.persist && !this.saveTimer) {
      this.saveTimer = setInterval(() => this.flush(), 2000);
      if (typeof this.saveTimer.unref === "function") this.saveTimer.unref();
    }
  }

  private restore(loaded: Estimator): void {
    // Replace the fresh estimator's pairs with the persisted ones (keeps the cfg).
    (this.est as unknown as { pairs: Map<string, unknown> }).pairs = (loaded as unknown as { pairs: Map<string, unknown> }).pairs;
    (this.est as unknown as { applied: number }).applied = loaded.appliedCount;
  }

  private applyEvent(e: OutcomeEvent): boolean {
    const first = this.est.apply(e.model, e.cls, {
      ok: e.ok,
      failureKind: e.failureKind ?? "ok",
      latencyMs: e.latencyMs ?? 0,
      tokens: e.tokens ?? 0,
      cost: e.cost ?? 0,
    }, e.id);
    if (!first) {
      this.counters.dupes += 1;
    }
    const w = this.est.recent(e.model, e.cls);
    this.breaker.observe(e.model, e.cls, e.ok, w, Date.parse(e.ts) || Date.now());
    this.dirty = true;
    return first;
  }

  private observe(e: OutcomeEvent): void {
    // The record path and the laya-monitor consumer group both feed this ring;
    // dedupe by event id so the dashboard lists each outcome once.
    if (!e.id || this.observed.has(e.id)) return;
    this.observed.add(e.id);
    this.observedOrder.push(e.id);
    if (this.observedOrder.length > 500) {
      const drop = this.observedOrder.shift();
      if (drop) this.observed.delete(drop);
    }
    this.events.unshift(e);
    if (this.events.length > 100) this.events.length = 100;
  }

  /** Before a call: adjust Laya's prior. Pure and synchronous. */
  select(prior: { modelId: string; via: Via; reason?: string }, cls: TaskClass, prompt: string, opts: Omit<SelectInput, "prior" | "cls" | "prompt"> = {}): SelectResult {
    if (!this.enabled) {
      return {
        modelId: prior.modelId,
        via: prior.via,
        reason: prior.reason ?? "",
        cls,
        prior: prior.modelId,
        changed: false,
        explored: false,
        circuit: {},
        threshold: thresholdFor(cls),
        coldStart: false,
        hardRule: "disabled",
      };
    }
    this.start();
    const res = selectModelRules({ prior, cls, prompt, source: this.source, ...opts }, this.est, this.breaker);
    if (res.coldStart) this.counters.coldStarts += 1;
    if (res.changed) this.counters.escalations += 1;
    if (res.explored) this.counters.explorations += 1;
    this.counters.decisions += 1;
    const decision = {
      id: newId("dec"),
      ts: nowIso(),
      requestId: newId("req"),
      cls,
      prior: prior.modelId,
      priorVia: prior.via,
      chosen: res.modelId,
      chosenVia: res.via,
      changed: res.changed,
      explored: res.explored,
      circuit: res.circuit,
      reason: res.reason,
      source: this.source,
    };
    this.decisions.unshift(decision);
    if (this.decisions.length > 30) this.decisions.length = 30;
    this.bus.publish("laya.decisions", res.modelId, decision);
    return res;
  }

  /** After a call: record the outcome. Never throws, never blocks. */
  record(input: RecordInput): OutcomeEvent {
    const kind: FailureKind = input.ok ? "ok" : input.failureKind ?? classifyFailure(input.error, input.status);
    const event: OutcomeEvent = {
      id: input.id ?? newId("evt"),
      ts: input.ts ?? nowIso(),
      requestId: newId("req"),
      model: input.model,
      via: input.via ?? "gateway",
      cls: input.cls,
      ok: input.ok,
      failureKind: kind,
      latencyMs: Math.max(0, Math.round(input.latencyMs ?? 0)),
      tokens: Math.max(0, Math.round(input.tokens ?? 0)),
      cost: Math.max(0, input.cost ?? 0),
      source: input.source ?? this.source,
      agent: input.agent,
    };
    this.counters.events += 1;
    // 1) apply locally (idempotent by id) so learning never waits for a broker;
    // 2) publish to the topic (fire-and-forget) for the dashboard/audit and for
    //    the laya-estimator consumer group (restart replay).
    this.applyEvent(event);
    this.observe(event);
    this.bus.publish("laya.outcomes", event.model, event);
    if (this.persist) this.store.append(event);
    // Reflect the outcome in the producer-side view of drops.
    if (this.persist) this.dirty = true;
    return event;
  }

  flush(): void {
    if (!this.persist || !this.dirty) return;
    this.dirty = false;
    this.store.saveEstimator(this.est);
  }

  /** GET /company/adaptive */
  snapshot(): Record<string, unknown> {
    // Opening the dashboard is what brings the reader up (loads persisted state and
    // joins the consumer groups) when the flag is on; with the flag off this stays inert.
    if (this.enabled) this.start();
    const bus: BusStats = this.bus.stats();
    const health = this.bus.health();
    const table: PairStats[] = this.est.table();
    const circuits = this.breaker.openCircuits();
    const flags: AdaptiveFlags[] = [
      { key: "circuit_open", label: "circuit opened", on: Object.keys(circuits).length > 0, detail: Object.keys(circuits).join(", ") || "none" },
      {
        key: "preferred_flipped",
        label: "preferred model flipped",
        on: this.decisions.some((d) => d.changed),
        detail: this.decisions.find((d) => d.changed)?.reason ?? "no change yet",
      },
      { key: "lag", label: "consumer lag > 5 s", on: bus.lagMs > 5000, detail: `${bus.lagMs} ms` },
      { key: "drops", label: "drops > 0", on: bus.dropped > 0, detail: `${bus.dropped} dropped at the producer` },
      {
        key: "kafka",
        label: bus.brokerRequested ? (bus.brokerUp ? "Kafka up" : "Kafka down, using in-process") : "in-process topic (no broker configured)",
        on: bus.brokerRequested && !bus.brokerUp,
        detail: bus.brokerDetail,
      },
    ];
    return {
      enabled: this.enabled,
      startedAt: this.startedAt,
      source: this.source,
      env: {
        mode: adaptiveEnabled() ? "ADAPTIVE_ROUTING=1" : "ADAPTIVE_ROUTING=0 (off)",
        minSuccess: thresholdFor("STANDARD"),
        explore: exploreRate(),
        cooldownMs: coolOffMs(),
        alpha: this.est.cfg.alpha,
        coldStartMin: this.est.cfg.coldStartMin,
        brokers: kafkaBrokersFromEnv() ?? [],
        root: adaptiveRoot(),
      },
      health,
      bus,
      counters: { ...this.counters, appliedEvents: this.est.appliedCount, learnedPairs: table.length },
      estimator: table,
      failureKinds: this.est.kindHistogram(),
      circuits,
      decisions: this.decisions,
      recentEvents: this.events.slice(0, 50),
      persistence: this.persist ? this.store.size() : null,
      flags,
      capturedAt: nowIso(),
    };
  }

  /** GET /company/adaptive/metrics (Prometheus text format). */
  metrics(): string {
    const bus = this.bus.stats();
    const lines: string[] = [];
    const l = (s: string) => lines.push(s);
    l("# HELP laya_adaptive_enabled 1 when ADAPTIVE_ROUTING=1 (the rule engine adjusts Laya's pick).");
    l("# TYPE laya_adaptive_enabled gauge");
    l(`laya_adaptive_enabled ${this.enabled ? 1 : 0}`);
    l("# HELP laya_adaptive_broker_up 1 when the Kafka broker answered; 0 means the in-process fallback.");
    l("# TYPE laya_adaptive_broker_up gauge");
    l(`laya_adaptive_broker_up ${bus.brokerUp ? 1 : 0}`);
    l("# HELP laya_adaptive_broker_requested 1 when KAFKA_BROKERS is configured.");
    l("# TYPE laya_adaptive_broker_requested gauge");
    l(`laya_adaptive_broker_requested ${bus.brokerRequested ? 1 : 0}`);
    l("# HELP laya_adaptive_events_total Outcome events recorded by this process.");
    l("# TYPE laya_adaptive_events_total counter");
    l(`laya_adaptive_events_total ${this.counters.events}`);
    l("# HELP laya_adaptive_decisions_total Routing decisions taken.");
    l("# TYPE laya_adaptive_decisions_total counter");
    l(`laya_adaptive_decisions_total ${this.counters.decisions}`);
    l("# HELP laya_adaptive_escalations_total Decisions that changed Laya's prior.");
    l("# TYPE laya_adaptive_escalations_total counter");
    l(`laya_adaptive_escalations_total ${this.counters.escalations}`);
    l("# HELP laya_adaptive_explorations_total Exploration picks (5% re-test).");
    l("# TYPE laya_adaptive_explorations_total counter");
    l(`laya_adaptive_explorations_total ${this.counters.explorations}`);
    l("# HELP laya_adaptive_topic_dropped_total Events dropped at the producer (broker down/slow).");
    l("# TYPE laya_adaptive_topic_dropped_total counter");
    l(`laya_adaptive_topic_dropped_total ${bus.dropped}`);
    l("# HELP laya_adaptive_produce_errors_total Producer send failures.");
    l("# TYPE laya_adaptive_produce_errors_total counter");
    l(`laya_adaptive_produce_errors_total ${bus.produceErrors}`);
    l("# HELP laya_adaptive_consumer_lag Messages behind per consumer group.");
    l("# TYPE laya_adaptive_consumer_lag gauge");
    for (const g of bus.groups) l(`laya_adaptive_consumer_lag{group="${g.group}",topic="${g.topic}"} ${g.lag}`);
    l("# HELP laya_adaptive_topic_produced_total Events produced per topic.");
    l("# TYPE laya_adaptive_topic_produced_total counter");
    for (const [t, s] of Object.entries(bus.topics)) l(`laya_adaptive_topic_produced_total{topic="${t}"} ${s.produced}`);
    l("# HELP laya_adaptive_p_success Live P(success | model, class); absent while cold (<10 samples).");
    l("# TYPE laya_adaptive_p_success gauge");
    l("# HELP laya_adaptive_samples Samples per (model, class).");
    l("# TYPE laya_adaptive_samples gauge");
    l("# HELP laya_adaptive_latency_p95_ms Latency p95 per (model, class).");
    l("# TYPE laya_adaptive_latency_p95_ms gauge");
    l("# HELP laya_adaptive_cost_per_call_usd Estimated cost per call per (model, class).");
    l("# TYPE laya_adaptive_cost_per_call_usd gauge");
    for (const s of this.est.table()) {
      const lbl = `{model="${s.model}",class="${s.cls}"}`;
      if (s.p !== null) l(`laya_adaptive_p_success${lbl} ${s.p.toFixed(4)}`);
      l(`laya_adaptive_samples${lbl} ${s.n}`);
      l(`laya_adaptive_latency_p95_ms${lbl} ${s.latencyP95}`);
      l(`laya_adaptive_cost_per_call_usd${lbl} ${s.costPerCall}`);
    }
    l("# HELP laya_adaptive_circuit_open 1 when the circuit breaker holds a model open.");
    l("# TYPE laya_adaptive_circuit_open gauge");
    for (const k of Object.keys(this.breaker.openCircuits())) {
      const [model, cls] = k.split("|");
      l(`laya_adaptive_circuit_open{model="${model}",class="${cls}"} 1`);
    }
    return `${lines.join("\n")}\n`;
  }

  async close(): Promise<void> {
    this.flush();
    if (this.saveTimer) clearInterval(this.saveTimer);
    this.saveTimer = null;
    await this.bus.close();
  }
}

let singleton: AdaptiveEngine | null = null;

/** The process-wide engine. Created lazily, started lazily. */
export function getAdaptive(): AdaptiveEngine {
  if (!singleton) singleton = new AdaptiveEngine();
  return singleton;
}

/** Test/tool helper: swap the singleton (checks and sims use their own engine). */
export function setAdaptive(engine: AdaptiveEngine | null): void {
  singleton = engine;
}
