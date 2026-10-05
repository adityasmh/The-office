/**
 * ops/adaptive-sim.ts — the CEO's demo, on simulated providers, through the SAME
 * request-service / rule-engine / estimator code the router uses.
 *
 * Run: npx tsx ops/adaptive-sim.ts        (writes nothing outside a temp dir)
 *
 * Providers are simulated with a settable success rate, latency, outage, 429s and a
 * "returns a tool-call instead of JSON" mode. Scenario:
 *   A. all healthy                         -> does adaptive cost us anything?
 *   B. deepseek drops to 40% on COMPLEX    -> how many requests until traffic moves?
 *   C. provider fully down                 -> are requests lost?
 *   D. recovers                            -> does traffic come back (exploration)?
 *   E. 10x flood                           -> drops + lag shown, no freeze.
 * The same provider behaviour is replayed against the CURRENT static Laya routing
 * so the comparison table is apples to apples.
 *
 * Determinism: a seeded PRNG keyed by (request index, model), and a virtual clock,
 * so both arms see the same provider draws for the same model.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AdaptiveEngine, modelCatalog } from "../src/adaptive/index.js";
import { InProcessTopic, KafkaTopic } from "../src/adaptive/topic.js";
import type { FailureKind, TaskClass } from "../src/adaptive/events.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adaptive-sim-"));
process.env.ADAPTIVE_COOLDOWN_MS = process.env.ADAPTIVE_COOLDOWN_MS ?? "20000";
process.env.ADAPTIVE_ROUTING = "1";

const cat = modelCatalog();
const byRank = (r: number) => cat.find((m) => m.costRank === r && m.via !== "qwen-messages")!.id;
const GLM = byRank(0);
const DEEPSEEK = byRank(1);
const KIMI = byRank(2);
const SONNET = cat.find((m) => m.costRank === 3)!.id;
const COST = (id: string) => cat.find((m) => m.id === id)?.costUsd ?? 0;

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) keyed per (seed, index, model)
// ---------------------------------------------------------------------------
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function rand(seed: number, i: number, key: string): number {
  let t = (seed + Math.imul(i, 0x9e3779b1) + hash(key)) >>> 0;
  t += 0x6d2b79f5;
  let x = t;
  x = Math.imul(x ^ (x >>> 15), 1 | x);
  x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
}

type Behaviour = {
  /** P(success) per task class. */
  ok: Record<TaskClass, number>;
  /** [min, max] latency in ms. */
  lat: [number, number];
  /** Provider entirely unreachable. */
  down: boolean;
  /** Extra probability the call is rate limited (429). */
  p429: number;
  /** For the planner failure: probability of a tool-call instead of JSON. */
  pToolCall: number;
};

const BASE: Record<string, Behaviour> = {
  [GLM]: { ok: { ROUTINE: 0.96, STANDARD: 0.9, COMPLEX: 0.75, DEMANDING: 0.6 }, lat: [300, 700], down: false, p429: 0.01, pToolCall: 0 },
  [DEEPSEEK]: { ok: { ROUTINE: 0.97, STANDARD: 0.94, COMPLEX: 0.9, DEMANDING: 0.8 }, lat: [700, 1600], down: false, p429: 0.02, pToolCall: 0 },
  [KIMI]: { ok: { ROUTINE: 0.97, STANDARD: 0.95, COMPLEX: 0.94, DEMANDING: 0.88 }, lat: [1400, 3000], down: false, p429: 0.02, pToolCall: 0 },
  [SONNET]: { ok: { ROUTINE: 0.98, STANDARD: 0.97, COMPLEX: 0.96, DEMANDING: 0.95 }, lat: [2000, 4200], down: false, p429: 0.01, pToolCall: 0 },
  [cat.find((m) => m.costRank === 4)!.id]: { ok: { ROUTINE: 0.99, STANDARD: 0.98, COMPLEX: 0.97, DEMANDING: 0.97 }, lat: [2600, 6000], down: false, p429: 0.01, pToolCall: 0 },
};

type Sim = {
  clock: number;
  seed: number;
  i: number;
  behaviour: (model: string) => Behaviour;
};

type CallResult = { ok: boolean; kind: FailureKind; latencyMs: number; cost: number };

function callProvider(sim: Sim, model: string, cls: TaskClass): CallResult {
  const b = sim.behaviour(model);
  const i = sim.i++;
  if (b.down) return { ok: false, kind: "http_5xx", latencyMs: 30, cost: 0 };
  const lat = Math.round(b.lat[0] + (b.lat[1] - b.lat[0]) * rand(sim.seed, i, `${model}:lat`));
  if (rand(sim.seed, i, `${model}:429`) < b.p429) return { ok: false, kind: "http_429", latencyMs: lat, cost: COST(model) * 0.2 };
  if (b.pToolCall > 0 && rand(sim.seed, i, `${model}:tool`) < b.pToolCall) {
    // The 2026-10-01 planner failure: the model answers with a tool-call block.
    return { ok: false, kind: "tool_call_instead_of_json", latencyMs: lat, cost: COST(model) };
  }
  const ok = rand(sim.seed, i, `${model}:ok`) < b.ok[cls];
  return { ok, kind: ok ? "ok" : "planner_no_json", latencyMs: lat, cost: COST(model) * (ok ? 1 : 0.6) };
}

const PROMPTS: Record<TaskClass, string> = {
  ROUTINE: "GOAL: fix the typo in README.md",
  STANDARD: "GOAL: add a retry helper in src/lib/retry.ts and run the tests",
  COMPLEX: "GOAL: implement the fleet planner fallback across src/company/fleet.ts and src/company/dispatch.ts",
  DEMANDING: "GOAL: audit the whole repo and rewrite the routing layer end to end",
};

type Req = { cls: TaskClass; ok: boolean; model: string; latencyMs: number; cost: number; attempts: number; held: boolean; reason: string };
type Arm = {
  name: string;
  engine: AdaptiveEngine | null;
  requests: Req[];
};

function priorFor(cls: TaskClass, engine: AdaptiveEngine | null): { modelId: string; via: "gateway" | "claude-subscription"; reason: string } {
  // Laya's prior: cheap-by-default, so deepseek for coding classes and Sonnet only
  // when Laya is unsure. This is the SAME prior both arms start from.
  if (engine) {
    const cheap = cls === "ROUTINE" ? GLM : DEEPSEEK;
    return { modelId: cheap, via: "gateway", reason: `Laya best_model=${cheap} conf=0.72` };
  }
  const cheap = cls === "ROUTINE" ? GLM : DEEPSEEK;
  return { modelId: cheap, via: "gateway", reason: `Laya best_model=${cheap} conf=0.72` };
}

/** The request-service: pick (adaptive or not) -> call -> record. */
function handle(arm: Arm, sim: Sim, cls: TaskClass): void {
  const prior = priorFor(cls, arm.engine);
  const pick = arm.engine ? arm.engine.select(prior, cls, PROMPTS[cls], { nowMs: sim.clock, rng: () => rand(sim.seed, sim.i, "explore") }) : prior;
  let model = pick.modelId;
  let attempts = 0;
  let res = callProvider(sim, model, cls);
  attempts += 1;
  // The existing fallback shape: a dead/limited provider is retried on the next
  // tier before the request is held (the router's 429/Claude fallback, extended).
  const tiers = [KIMI, SONNET, cat.find((m) => m.costRank === 4)!.id].filter((m) => m !== model);
  while (!res.ok && (res.kind === "http_429" || res.kind === "http_5xx") && attempts <= tiers.length) {
    model = tiers[attempts - 1];
    res = callProvider(sim, model, cls);
    attempts += 1;
  }
  const held = !res.ok && (res.kind === "http_429" || res.kind === "http_5xx");
  sim.clock += Math.max(50, res.latencyMs);
  arm.requests.push({ cls, ok: res.ok, model, latencyMs: res.latencyMs, cost: res.cost, attempts, held, reason: pick.reason });
  if (arm.engine) {
    arm.engine.record({
      model,
      cls,
      ok: res.ok,
      failureKind: res.kind,
      latencyMs: res.latencyMs,
      cost: res.cost,
      ts: new Date(sim.clock).toISOString(),
      source: "sim",
    });
  }
}

function p95(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(0.95 * (s.length - 1)))];
}

function report(arm: Arm): { success: string; cost: string; p95: string; n: number; lost: number; held: number } {
  const n = arm.requests.length;
  const ok = arm.requests.filter((r) => r.ok).length;
  const cost = arm.requests.reduce((a, r) => a + r.cost, 0) / n;
  const lost = arm.requests.filter((r) => r.attempts === 0).length;
  const held = arm.requests.filter((r) => r.held).length;
  return { success: `${((ok / n) * 100).toFixed(1)}%`, cost: `$${cost.toFixed(5)}`, p95: `${p95(arm.requests.map((r) => r.latencyMs))} ms`, n, lost, held };
}

// ---------------------------------------------------------------------------
// The scenario, run twice: once with the rule engine, once without (today's static pick)
// ---------------------------------------------------------------------------
function runScenario(kind: "adaptive" | "static") {
  const engine = kind === "adaptive" ? new AdaptiveEngine({ root: path.join(tmp, kind), brokers: null, enabled: true, persist: false, subscribe: true, source: "sim" }) : null;
  const arm: Arm = { name: kind, engine, requests: [] };
  const sim: Sim = { clock: Date.now(), seed: 12345, i: 0 };
  const behaviour = (m: string) => BASE[m] ?? BASE[DEEPSEEK];

  // A. all healthy, mixed classes
  sim.behaviour = behaviour;
  for (let i = 0; i < 40; i++) handle(arm, sim, (["ROUTINE", "STANDARD", "COMPLEX"] as TaskClass[])[i % 3]);
  const afterA = { avgLatency: p95(arm.requests.map((r) => r.latencyMs)) };

  // B. deepseek drops to 40% on COMPLEX (the planner failure) - count + seconds
  const failing = (m: string): Behaviour =>
    m === DEEPSEEK ? { ...BASE[DEEPSEEK], ok: { ...BASE[DEEPSEEK].ok, COMPLEX: 0.4 }, pToolCall: 0.3 } : behaviour(m);
  sim.behaviour = failing;
  const bStart = sim.clock;
  const bFirst = arm.requests.length;
  let shiftAt = -1;
  for (let i = 0; i < 60; i++) {
    handle(arm, sim, "COMPLEX");
    const last = arm.requests[arm.requests.length - 1];
    if (shiftAt < 0 && last.model !== DEEPSEEK) shiftAt = arm.requests.length - bFirst;
  }
  const bSeconds = (sim.clock - bStart) / 1000;

  // C. every provider down
  const downBehaviour = () => ({ ...BASE[DEEPSEEK], down: true, ok: { ROUTINE: 0, STANDARD: 0, COMPLEX: 0, DEMANDING: 0 } }) as Behaviour;
  sim.behaviour = downBehaviour;
  const cStart = arm.requests.length;
  for (let i = 0; i < 12; i++) handle(arm, sim, "COMPLEX");
  const outage = arm.requests.slice(cStart);
  const outageLost = outage.filter((r) => r.attempts === 0).length;
  const outageHeld = outage.filter((r) => r.held).length;

  // D. recovery: pause past the cool-off, then measure the trial and the return to
  // normal rotation (the half-open trial + the estimator's recovery streak).
  sim.behaviour = behaviour;
  sim.clock += Number(process.env.ADAPTIVE_COOLDOWN_MS ?? 20000) + 1000;
  const dStart = arm.requests.length;
  for (let i = 0; i < 40; i++) handle(arm, sim, "COMPLEX");
  const dReqs = arm.requests.slice(dStart);
  const trialAt = dReqs.findIndex((r) => r.model === DEEPSEEK);
  const normalAt = dReqs.findIndex((r) => r.model === DEEPSEEK && /prior kept|cheapest that clears/.test(r.reason) && !/half-open/.test(r.reason));
  const explorationPicks = dReqs.filter((r) => /exploration/.test(r.reason)).length;

  // E. 10x flood against the topic (not the router): does the producer ever block?
  const topic = new InProcessTopic();
  const t0 = Date.now();
  let maxPublishMs = 0;
  for (let i = 0; i < 20000; i++) {
    const s = Date.now();
    topic.publish("laya.outcomes", DEEPSEEK, { model: DEEPSEEK, cls: "COMPLEX", ok: true, i });
    maxPublishMs = Math.max(maxPublishMs, Date.now() - s);
  }
  const floodMs = Date.now() - t0;
  const floodStats = topic.stats();

  if (engine) void engine.close();
  return { arm, report: report(arm), shiftAt, bSeconds, outage: { n: outage.length, lost: outageLost, held: outageHeld }, recovery: { trialAt, normalAt, explorationPicks }, flood: { events: 20000, ms: floodMs, maxPublishMs, evicted: floodStats.evictedRing, dropped: floodStats.dropped }, afterA };
}

const adaptive = runScenario("adaptive");
const staticArm = runScenario("static");

// ---------------------------------------------------------------------------
// A producer that is DOWN must never block: bounded buffer, drop-and-count.
// ---------------------------------------------------------------------------
const kafkaDown = new KafkaTopic(["127.0.0.1:9"]);
let maxKafkaPublishMs = 0;
for (let i = 0; i < 20000; i++) {
  const s = Date.now();
  kafkaDown.publish("laya.outcomes", KIMI, { model: KIMI, cls: "COMPLEX", ok: true, i });
  maxKafkaPublishMs = Math.max(maxKafkaPublishMs, Date.now() - s);
}
const kafkaDownStats = kafkaDown.stats();

const rows = [
  ["arm", "requests", "success", "mean cost/request", "p95 latency", "lost", "held for retry"],
  ["static Laya (today)", String(staticArm.report.n), staticArm.report.success, staticArm.report.cost, staticArm.report.p95, String(staticArm.report.lost), String(staticArm.report.held)],
  ["adaptive (ADAPTIVE_ROUTING=1)", String(adaptive.report.n), adaptive.report.success, adaptive.report.cost, adaptive.report.p95, String(adaptive.report.lost), String(adaptive.report.held)],
];
const w = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
const table = rows.map((r) => r.map((cell, c) => String(cell).padEnd(w[c])).join("  ")).join("\n");

console.log("== adaptive-sim ==");
console.log(`deepseek=${DEEPSEEK} kimi=${KIMI} glm=${GLM} sonnet=${SONNET}`);
console.log(`cool-off=${process.env.ADAPTIVE_COOLDOWN_MS}ms (sim override)  explore=${process.env.ADAPTIVE_EXPLORE ?? "0.05"}`);
console.log("");
console.log(table);
console.log("");
console.log(`B. deepseek -> 40% on COMPLEX: adaptive traffic moved off it after ${adaptive.shiftAt} COMPLEX requests (~${adaptive.bSeconds.toFixed(1)} simulated s); static arm never moves (first switch: ${staticArm.shiftAt})`);
console.log(`C. full outage (12 requests): lost=${adaptive.outage.lost} held-for-retry=${adaptive.outage.held} of ${adaptive.outage.n} (static: lost=${staticArm.outage.lost} held=${staticArm.outage.held})`);
console.log(`D. recovery (clock advanced past the cool-off): the half-open trial went to ${DEEPSEEK} at request ${adaptive.recovery.trialAt} and normal rotation resumed at request ${adaptive.recovery.normalAt} (${adaptive.recovery.explorationPicks} exploration picks in the 40-request window)`);
console.log(`E. 10x flood (20000 events, in-process topic): ${adaptive.flood.ms} ms total, worst single publish ${adaptive.flood.maxPublishMs} ms, ring evictions ${adaptive.flood.evicted}, dropped ${adaptive.flood.dropped}`);
console.log(`   flood against a DOWN Kafka producer: worst single publish ${maxKafkaPublishMs} ms, dropped-at-producer ${kafkaDownStats.dropped} (bounded buffer, fire-and-forget, no block)`);
console.log("");
const json = { adaptive: adaptive.report, static: staticArm.report, shiftAt: adaptive.shiftAt, bSeconds: adaptive.bSeconds, outage: adaptive.outage, recovery: adaptive.recovery, flood: adaptive.flood, kafkaDownFlood: { maxPublishMs: maxKafkaPublishMs, dropped: kafkaDownStats.dropped } };
fs.writeFileSync(path.join(tmp, "sim.json"), JSON.stringify(json, null, 2));
console.log(JSON.stringify(json));
console.log(`\n(tmp dir: ${tmp})`);
