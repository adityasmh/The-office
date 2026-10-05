/**
 * src/adaptive/topic.ts — the Kafka-shaped bus, with a real Kafka implementation
 * and an in-process fallback that behaves the same way.
 *
 * Contract (docs/LAYA_ADAPTIVE_ROUTING_SPEC.md "Kafka"):
 *   - `laya.outcomes`  every request outcome; key = model (per-model ordering), 3 partitions
 *   - `laya.decisions` rule-engine decisions + reasons, for the dashboard/audit
 *   - `laya.dlq`       events that failed to parse
 *   - producing NEVER blocks or fails a request: fire-and-forget, bounded buffer,
 *     drop-and-count when the broker is slow or down.
 *   - consumers use a group, commit offsets, and replay the last hour on start.
 *
 * When `KAFKA_BROKERS` is unset, or the broker is unreachable, the system FALLS
 * BACK to `InProcessTopic` automatically and flags it (dashboard "(Kafka down,
 * using in-process)"), while a background loop keeps trying to connect.
 *
 * Only localhost is ever used; the broker is never configured from here beyond the
 * broker list, and no message carries prompt text (see events.ts).
 */
import type { Admin, Consumer, Kafka as KafkaClient, Producer } from "kafkajs";
import type { TopicName } from "./types.js";
import { TOPICS, type BusStats, type GroupStat, type TopicMessage, type TopicStat } from "./types.js";

export type TopicHandler = (msg: TopicMessage) => void;
export type SubscribeOpts = { sinceMs?: number; fromBeginning?: boolean };

export interface Topic {
  readonly backend: "kafka" | "in-process";
  /** Fire-and-forget. Never throws, never awaits the broker. */
  publish(topic: TopicName, key: string | null, value: unknown): void;
  subscribe(group: string, topic: TopicName, handler: TopicHandler, opts?: SubscribeOpts): void;
  stats(): BusStats;
  /** A cheap liveness view for the dashboard strip. */
  health(): { backend: string; brokerUp: boolean; detail: string };
  close(): Promise<void>;
}

const RING_MAX = 2000;

function partitionFor(key: string | null, partitions: number): number {
  if (partitions <= 1) return 0;
  const s = key ?? String(Math.random());
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % partitions;
}

type Sub = { group: string; topic: TopicName; handler: TopicHandler; cursor: number; consumed: number; lastTs: number };

/**
 * Bounded in-process topic. Offsets are monotonic per topic and per partition, so
 * the dashboard's "topic depth / lag" strip means the same thing here as on Kafka.
 * Delivery is synchronous inside `publish` (handlers are small and idempotent);
 * that keeps a caller that records an outcome and immediately asks the estimator
 * for P(success) deterministic.
 */
export class InProcessTopic implements Topic {
  readonly backend = "in-process" as const;
  private parts: Record<TopicName, number[]>;
  private produced: Record<TopicName, number>;
  private ring: Record<TopicName, TopicMessage[]>;
  private base: Record<TopicName, number>;
  private stamps: Record<TopicName, number[]>;
  private subs: Sub[] = [];
  private evicted = 0;

  constructor(partitionCounts: Partial<Record<TopicName, number>> = {}) {
    this.parts = {} as Record<TopicName, number[]>;
    this.produced = {} as Record<TopicName, number>;
    this.ring = {} as Record<TopicName, TopicMessage[]>;
    this.base = {} as Record<TopicName, number>;
    this.stamps = {} as Record<TopicName, number[]>;
    for (const t of TOPICS) {
      const n = t === "laya.outcomes" ? (partitionCounts[t] ?? 3) : 1;
      this.parts[t] = new Array(n).fill(0);
      this.produced[t] = 0;
      this.ring[t] = [];
      this.base[t] = 0;
      this.stamps[t] = [];
    }
  }

  publish(topic: TopicName, key: string | null, value: unknown): void {
    if (!this.produced[topic] && this.produced[topic] !== 0) return; // unknown topic: drop
    const partition = partitionFor(key, this.parts[topic].length);
    const offset = this.produced[topic];
    const msg: TopicMessage = { topic, key, value, partition, offset, ts: Date.now() };
    this.produced[topic] = offset + 1;
    this.parts[topic][partition] += 1;
    const ring = this.ring[topic];
    ring.push(msg);
    if (ring.length > RING_MAX) {
      const drop = ring.length - RING_MAX;
      ring.splice(0, drop);
      this.base[topic] += drop;
      this.evicted += drop;
    }
    const now = Date.now();
    const stamps = this.stamps[topic];
    stamps.push(now);
    while (stamps.length && stamps[0] < now - 60_000) stamps.shift();
    // Synchronous fan-out to every group subscribed to this topic.
    for (const s of this.subs) {
      if (s.topic !== topic) continue;
      if (s.cursor > offset) continue;
      s.cursor = offset + 1;
      s.consumed += 1;
      s.lastTs = now;
      try {
        s.handler(msg);
      } catch {
        /* a handler must never break the producer path */
      }
    }
  }

  subscribe(group: string, topic: TopicName, handler: TopicHandler, opts?: SubscribeOpts): void {
    let cursor = this.produced[topic];
    if (opts?.sinceMs && opts.sinceMs > 0) {
      const cutoff = Date.now() - opts.sinceMs;
      const first = this.ring[topic].find((m) => m.ts >= cutoff);
      if (first) cursor = first.offset;
    }
    if (opts?.fromBeginning) cursor = this.base[topic];
    this.subs.push({ group, topic, handler, cursor, consumed: 0, lastTs: 0 });
  }

  stats(): BusStats {
    const topics: Record<string, TopicStat> = {};
    let perSec = 0;
    for (const t of TOPICS) {
      topics[t] = {
        produced: this.produced[t],
        highWater: this.produced[t],
        offsets: [...this.parts[t]],
        retention: `${this.ring[t].length}/${RING_MAX} in-process ring`,
      };
      perSec += this.stamps[t].length / 60;
    }
    const groups: GroupStat[] = this.subs.map((s) => {
      const lag = Math.max(0, this.produced[s.topic] - s.cursor);
      return {
        group: s.group,
        topic: s.topic,
        consumed: s.consumed,
        committed: s.cursor,
        lag,
        // "lag in time" is only meaningful while there is something to consume;
        // a quiet topic must not look like a stalled consumer.
        lagMs: lag > 0 && s.lastTs ? Date.now() - s.lastTs : 0,
      };
    });
    return {
      backend: "in-process",
      brokerRequested: false,
      brokerUp: false,
      brokerDetail: "KAFKA_BROKERS not set - in-process topic",
      topics,
      groups,
      dropped: 0,
      produceErrors: 0,
      unparseable: 0,
      evictedRing: this.evicted,
      eventsPerSec: Number(perSec.toFixed(2)),
      lagMs: groups.reduce((a, g) => Math.max(a, g.lagMs), 0),
    };
  }

  health() {
    return { backend: "in-process", brokerUp: false, detail: "in-process topic (no broker configured)" };
  }

  async close(): Promise<void> {
    this.subs = [];
  }
}

const KAFKA_TOPIC_CONFIG: Record<TopicName, { numPartitions: number; retentionMs: number; retentionBytes: number }> = {
  "laya.outcomes": { numPartitions: 3, retentionMs: 24 * 60 * 60 * 1000, retentionBytes: 256 * 1024 * 1024 },
  "laya.decisions": { numPartitions: 1, retentionMs: 24 * 60 * 60 * 1000, retentionBytes: 64 * 1024 * 1024 },
  "laya.dlq": { numPartitions: 1, retentionMs: 24 * 60 * 60 * 1000, retentionBytes: 32 * 1024 * 1024 },
};

/** Bounded producer buffer: beyond this, events are dropped and counted. */
const BUFFER_MAX = 5_000;
const FLUSH_MS = 50;

export class KafkaTopic implements Topic {
  readonly backend = "kafka" as const;
  private brokers: string[];
  private clientId: string;
  private kafka: KafkaClient | null = null;
  private producer: Producer | null = null;
  private admin: Admin | null = null;
  private consumers = new Map<string, { consumer: Consumer; topics: Set<TopicName>; running: boolean }>();
  private subs: { group: string; topic: TopicName; handler: TopicHandler; opts?: SubscribeOpts }[] = [];
  private buffer: { topic: TopicName; key: string | null; value: string }[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private droppedCount = 0;
  private produceErrors = 0;
  private unparseable = 0;
  private ups = false;
  private detail = "not started";
  private produced: Record<TopicName, number>;
  private partOffsets = new Map<TopicName, number[]>();
  private groupOffsets = new Map<string, number>();
  private stamps: Record<TopicName, number[]>;

  constructor(brokers: string[], clientId = "laya-adaptive") {
    this.brokers = brokers;
    this.clientId = clientId;
    this.produced = {} as Record<TopicName, number>;
    this.stamps = {} as Record<TopicName, number[]>;
    for (const t of TOPICS) {
      this.produced[t] = 0;
      this.stamps[t] = [];
    }
  }

  get isUp(): boolean {
    return this.ups;
  }

  /** Connect + create the three topics. Throws when the broker is unreachable. */
  async start(timeoutMs = 4000): Promise<void> {
    const kafkajs = await import("kafkajs");
    const kafka = new kafkajs.Kafka({
      clientId: this.clientId,
      brokers: this.brokers,
      connectionTimeout: timeoutMs,
      requestTimeout: timeoutMs + 2000,
      retry: { retries: 1, initialRetryTime: 200 },
      logLevel: kafkajs.logLevel.NOTHING,
    });
    this.kafka = kafka;
    const admin = kafka.admin();
    this.admin = admin;
    await admin.connect();
    const existing = await admin.listTopics();
    const missing = TOPICS.filter((t) => !existing.includes(t)).map((t) => ({
      topic: t,
      numPartitions: KAFKA_TOPIC_CONFIG[t].numPartitions,
      replicationFactor: 1,
      configEntries: [
        { name: "retention.ms", value: String(KAFKA_TOPIC_CONFIG[t].retentionMs) },
        { name: "retention.bytes", value: String(KAFKA_TOPIC_CONFIG[t].retentionBytes) },
      ],
    }));
    if (missing.length) await admin.createTopics({ topics: missing, waitForLeaders: true });
    for (const t of TOPICS) {
      const info = await admin.fetchTopicOffsets(t).catch(() => []);
      this.partOffsets.set(
        t,
        info.map((p) => Number(p.high ?? 0)),
      );
    }
    const producer = kafka.producer({ allowAutoTopicCreation: false, maxInFlightRequests: 1, idempotent: false });
    this.producer = producer;
    await producer.connect();
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_MS);
    if (typeof this.flushTimer.unref === "function") this.flushTimer.unref();
    this.ups = true;
    this.detail = `connected to ${this.brokers.join(",")}`;
    // Re-attach anything subscribed before the broker came up (group replay path).
    for (const s of this.subs) await this.attach(s.group, s.topic, s.handler, s.opts).catch(() => undefined);
  }

  publish(topic: TopicName, key: string | null, value: unknown): void {
    if (!this.ups || !this.producer) {
      this.droppedCount += 1;
      return;
    }
    if (this.buffer.length >= BUFFER_MAX) {
      this.droppedCount += 1;
      return;
    }
    this.buffer.push({ topic, key, value: JSON.stringify(value) });
    this.produced[topic] += 1;
    const now = Date.now();
    const stamps = this.stamps[topic];
    stamps.push(now);
    while (stamps.length && stamps[0] < now - 60_000) stamps.shift();
    if (this.buffer.length >= 200) void this.flush();
  }

  /** Batched send; a failure marks the broker down and drops what was in flight. */
  private async flush(): Promise<void> {
    if (!this.producer || !this.buffer.length) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    const byTopic = new Map<TopicName, { key: string | null; value: string }[]>();
    for (const m of batch) {
      const arr = byTopic.get(m.topic) ?? [];
      arr.push({ key: m.key, value: m.value });
      byTopic.set(m.topic, arr);
    }
    try {
      await this.producer.sendBatch({
        topicMessages: [...byTopic.entries()].map(([topic, messages]) => ({ topic, messages })),
        acks: 1,
      });
    } catch (e) {
      this.produceErrors += 1;
      this.droppedCount += batch.length;
      this.ups = false;
      this.detail = `send failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`;
    }
  }

  private async attach(group: string, topic: TopicName, handler: TopicHandler, opts?: SubscribeOpts): Promise<void> {
    if (!this.kafka) return;
    let entry = this.consumers.get(group);
    if (!entry) {
      const consumer = this.kafka.consumer({ groupId: group, sessionTimeout: 10_000, heartbeatInterval: 3_000 });
      await consumer.connect();
      entry = { consumer, topics: new Set<TopicName>(), running: false };
      this.consumers.set(group, entry);
    }
    // kafkajs requires every subscribe() BEFORE run(); run() may only be called once
    // per consumer, so the first attach starts it and later topics are added first.
    if (!entry.topics.has(topic)) {
      await entry.consumer.subscribe({ topic, fromBeginning: true });
      entry.topics.add(topic);
    }
    if (entry.running || !entry.topics.size) return;
    entry.running = true;
    const cutoff = Date.now() - (opts?.sinceMs ?? 0);
    void entry.consumer
      .run({
        eachMessage: async (payload) => {
          const raw = payload.message.value?.toString() ?? "";
          let value: unknown;
          try {
            value = JSON.parse(raw);
          } catch {
            this.unparseable += 1;
            this.publish("laya.dlq", payload.message.key?.toString() ?? null, { raw: raw.slice(0, 512), group, topic });
            return;
          }
          const ts = Number(payload.message.timestamp ?? Date.now());
          // "replay the last hour": older messages are committed and skipped.
          if (opts?.sinceMs && ts < cutoff) return;
          handler({
            topic,
            key: payload.message.key?.toString() ?? null,
            value,
            partition: payload.partition,
            offset: Number(payload.message.offset ?? 0),
            ts,
          });
          this.groupOffsets.set(group, (this.groupOffsets.get(group) ?? 0) + 1);
        },
      })
      .catch((e: unknown) => {
        this.ups = false;
        entry && (entry.running = false);
        this.detail = `consumer ${group} stopped: ${String((e as Error)?.message ?? e).slice(0, 120)}`;
      });
  }

  subscribe(group: string, topic: TopicName, handler: TopicHandler, opts?: SubscribeOpts): void {
    this.subs.push({ group, topic, handler, opts });
    if (this.ups) void this.attach(group, topic, handler, opts).catch(() => undefined);
  }

  stats(): BusStats {
    const topics: Record<string, TopicStat> = {};
    let perSec = 0;
    for (const t of TOPICS) {
      const offsets = this.partOffsets.get(t) ?? [0];
      topics[t] = {
        produced: this.produced[t],
        highWater: offsets.reduce((a, b) => a + b, 0),
        offsets,
        retention: "24 h / 256 MB (broker)",
      };
      perSec += this.stamps[t].length / 60;
    }
    const groups: GroupStat[] = this.subs.map((s) => {
      const lag = this.groupLag.get(s.group) ?? -1;
      const since = this.groupLagSince.get(s.group);
      return {
        group: s.group,
        topic: s.topic,
        consumed: this.groupOffsets.get(s.group) ?? 0,
        committed: this.groupOffsets.get(s.group) ?? 0,
        lag,
        lagMs: lag > 0 && since ? Date.now() - since : 0,
      };
    });
    return {
      backend: "kafka",
      brokerRequested: true,
      brokerUp: this.ups,
      brokerDetail: this.detail,
      topics,
      groups,
      dropped: this.droppedCount,
      produceErrors: this.produceErrors,
      unparseable: this.unparseable,
      evictedRing: 0,
      eventsPerSec: Number(perSec.toFixed(2)),
      lagMs: groups.reduce((a, g) => Math.max(a, g.lagMs), 0),
    };
  }

  private groupLag = new Map<string, number>();
  private groupLagSince = new Map<string, number>();

  /** Refresh broker-side offsets + consumer lag (admin calls, cached by the caller). */
  async refreshOffsets(): Promise<void> {
    if (!this.admin || !this.ups) return;
    const withTimeout = <T>(p: Promise<T>, ms: number) =>
      Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("admin timeout")), ms).unref?.())]);
    try {
      for (const t of TOPICS) {
        const info = await withTimeout(this.admin.fetchTopicOffsets(t), 1500);
        this.partOffsets.set(
          t,
          info.map((p) => Number(p.high ?? 0)),
        );
      }
      for (const group of this.consumers.keys()) {
        const offs = await withTimeout(this.admin.fetchOffsets({ groupId: group, topics: [...TOPICS] }), 1500);
        let lag = 0;
        for (const t of offs) {
          const high = (this.partOffsets.get(t.topic as TopicName) ?? []).reduce((a, b) => a + b, 0);
          const committed = t.partitions.reduce((a, p) => a + Number(p.offset ?? 0), 0);
          lag += Math.max(0, high - committed);
        }
        this.groupLag.set(group, lag);
        if (lag > 0) {
          if (!this.groupLagSince.has(group)) this.groupLagSince.set(group, Date.now());
        } else {
          this.groupLagSince.delete(group);
        }
      }
    } catch {
      /* a slow admin call must never affect routing */
    }
  }

  health() {
    return { backend: "kafka", brokerUp: this.ups, detail: this.detail };
  }

  async close(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flush().catch(() => undefined);
    await this.producer?.disconnect().catch(() => undefined);
    for (const { consumer } of this.consumers.values()) await consumer.disconnect().catch(() => undefined);
    await this.admin?.disconnect().catch(() => undefined);
    this.ups = false;
  }
}

/**
 * The switch the rest of the code sees. Kafka when `KAFKA_BROKERS` is set and the
 * broker answers; otherwise (or on failure) the in-process topic, with a
 * background reconnect. `publish` always goes to the ACTIVE transport only, so
 * there is no double counting; the estimator dedupes by event id anyway.
 */
export class TopicRouter implements Topic {
  private local = new InProcessTopic();
  private kafka: KafkaTopic | null = null;
  private active: Topic;
  private subscribers: { group: string; topic: TopicName; handler: TopicHandler; opts?: SubscribeOpts }[] = [];
  private retryTimer: NodeJS.Timeout | null = null;
  private connecting = false;
  private lastError = "";
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(brokers: string[] | null) {
    this.active = this.local;
    if (brokers && brokers.length) {
      this.kafka = new KafkaTopic(brokers);
      void this.tryKafka();
    }
  }

  get backend(): "kafka" | "in-process" {
    return this.active.backend;
  }

  private async tryKafka(): Promise<void> {
    if (this.connecting || !this.kafka) return;
    this.connecting = true;
    try {
      if (!this.kafka.isUp) await this.kafka.start();
      if (this.kafka.isUp) {
        this.active = this.kafka;
        for (const s of this.subscribers) this.kafka.subscribe(s.group, s.topic, s.handler, s.opts);
        if (!this.refreshTimer) {
          this.refreshTimer = setInterval(() => void this.kafka?.refreshOffsets(), 5000);
          if (typeof this.refreshTimer.unref === "function") this.refreshTimer.unref();
        }
        this.scheduleRetry(0); // stop retrying: we are up
      }
    } catch (e) {
      this.lastError = String((e as Error)?.message ?? e).slice(0, 200);
      this.active = this.local;
      this.scheduleRetry(5000);
    }
    this.connecting = false;
  }

  private scheduleRetry(ms: number): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (!ms) {
      this.retryTimer = null;
      return;
    }
    this.retryTimer = setTimeout(() => void this.tryKafka(), ms);
    if (typeof this.retryTimer.unref === "function") this.retryTimer.unref();
  }

  publish(topic: TopicName, key: string | null, value: unknown): void {
    this.active.publish(topic, key, value);
  }

  subscribe(group: string, topic: TopicName, handler: TopicHandler, opts?: SubscribeOpts): void {
    this.subscribers.push({ group, topic, handler, opts });
    this.active.subscribe(group, topic, handler, opts);
  }

  stats(): BusStats {
    const s = this.active.stats();
    const up = this.kafka?.isUp ?? false;
    return {
      ...s,
      brokerRequested: !!this.kafka,
      brokerUp: up,
      brokerDetail: this.kafka ? (up ? this.kafka.health().detail : this.lastError || "broker unreachable - using in-process") : s.brokerDetail,
      // In-process counters always exist, so the strip has numbers even in fallback.
      evictedRing: s.evictedRing || this.local.stats().evictedRing,
    };
  }

  health() {
    const up = this.kafka?.isUp ?? false;
    if (!this.kafka) return { backend: "in-process", brokerUp: false, detail: "KAFKA_BROKERS not set - in-process topic" };
    return { backend: up ? "kafka" : "in-process", brokerUp: up, detail: up ? this.kafka.health().detail : this.lastError || "broker unreachable" };
  }

  async close(): Promise<void> {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    await this.kafka?.close().catch(() => undefined);
    await this.local.close();
  }
}

export function kafkaBrokersFromEnv(): string[] | null {
  const raw = (process.env.KAFKA_BROKERS ?? "").trim();
  if (!raw) return null;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
