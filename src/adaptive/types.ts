/**
 * src/adaptive/types.ts — the small shared type vocabulary for the bus.
 *
 * Split out of topic.ts so estimator.ts / rules.ts / index.ts can import the
 * message and stats shapes without pulling in kafkajs.
 */

export type TopicName = "laya.outcomes" | "laya.decisions" | "laya.dlq";

export const TOPICS: TopicName[] = ["laya.outcomes", "laya.decisions", "laya.dlq"];

export type TopicMessage = {
  topic: TopicName;
  key: string | null;
  value: unknown;
  partition: number;
  offset: number;
  ts: number;
};

export type TopicStat = {
  /** Events this process produced into the topic. */
  produced: number;
  /** Broker high-water mark (or the in-process produced count). */
  highWater: number;
  /** Per-partition high-water mark. */
  offsets: number[];
  retention: string;
};

export type GroupStat = {
  group: string;
  topic: TopicName;
  /** Messages handled by this process for the group. */
  consumed: number;
  /** Last committed offset (in-process: the same cursor, in messages). */
  committed: number;
  /** High-water minus committed; -1 when the broker did not answer in time. */
  lag: number;
  lagMs: number;
};

export type BusStats = {
  backend: "kafka" | "in-process";
  brokerRequested: boolean;
  brokerUp: boolean;
  brokerDetail: string;
  topics: Record<string, TopicStat>;
  groups: GroupStat[];
  /** Events the producer dropped because the broker was down or the buffer was full. */
  dropped: number;
  produceErrors: number;
  /** Messages that failed to parse (routed to laya.dlq). */
  unparseable: number;
  /** In-process ring evictions (replay window rotated). */
  evictedRing: number;
  eventsPerSec: number;
  lagMs: number;
};
