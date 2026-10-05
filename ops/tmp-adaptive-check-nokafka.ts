/**
 * TEMP COPY of ops/adaptive-check.ts (block-7 Kafka probe pointed at a dead port).
 * Generated for ORDER_2026-10-01_replay-attribution.md step 4 only.
 */
/**
 * ops/adaptive-check.ts — acceptance checks for the adaptive routing layer.
 *
 * Run: npx tsx ops/adaptive-check.ts
 *
 * What it proves (docs/LAYA_ADAPTIVE_ROUTING_SPEC.md "Checks"):
 *   1. ADAPTIVE_ROUTING=0 => the call site behaves exactly as today (same picks,
 *      no decision events, no topic traffic, no disk writes);
 *   2. ADAPTIVE_ROUTING=1 => a failing model loses traffic within the window;
 *   3. the circuit reopens after the cool-off (half-open trial failed => open again);
 *   4. cold start (<10 samples) trusts Laya's prior;
 *   5. persisted state reloads (outcomes.jsonl + estimates.json);
 *   6. broker unreachable => automatic in-process fallback, flagged.
 *
 * Safety: no server, no router restart, no :8787, no network beyond a refused
 * localhost connect (127.0.0.1:9). All persistence happens in a temp dir.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { AdaptiveEngine, getAdaptive, modelCatalog, recordAdaptiveOutcome, withAdaptive } from "../src/adaptive/index.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adaptive-check-"));
let failures = 0;
let checks = 0;

function ok(name: string, cond: boolean, detail = "") {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${detail ? `  [${detail}]` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${detail ? `  [${detail}]` : ""}`);
  }
}

const cat = modelCatalog();
const DEEPSEEK = cat.find((m) => m.costRank === 1)!.id;
const KIMI = cat.find((m) => m.costRank === 2 && m.via !== "qwen-messages")!.id;
const PROMPT = "GOAL: implement the retry policy in src/lib/retry.ts and run the tests";
const priorDeepseek = { modelId: DEEPSEEK, via: "gateway" as const, reason: `Laya best_model=${DEEPSEEK} conf=0.71` };

async function main() {
  console.log(`adaptive-check: deepseek=${DEEPSEEK} kimi=${KIMI} tmp=${tmp}`);

  // -------------------------------------------------------------------------
  // 1. ADAPTIVE_ROUTING=0 => identical behaviour (the default)
  // -------------------------------------------------------------------------
  delete process.env.ADAPTIVE_ROUTING;
  delete process.env.KAFKA_BROKERS;
  const today = getAdaptive();
  const fixedRequests = [
    { complexity: "ROUTINE" as const, confidence: 0.9, modelId: cat[0].id, via: "gateway" as const, reason: "Laya best_model=glm conf=0.9" },
    { complexity: "STANDARD" as const, confidence: 0.8, modelId: DEEPSEEK, via: "gateway" as const, reason: "Laya best_model=deepseek conf=0.8" },
    { complexity: "COMPLEX" as const, confidence: 0.7, modelId: KIMI, via: "gateway" as const, reason: "Laya best_model=kimi conf=0.7" },
    { complexity: "DEMANDING" as const, confidence: 0.4, modelId: cat.find((m) => m.costRank === 3)!.id, via: "claude-subscription" as const, reason: "low conf -> ceiling SONNET" },
  ];
  const picksOff = fixedRequests.map((r) => withAdaptive(r, PROMPT));
  const identical = picksOff.every(
    (p, i) => p.modelId === fixedRequests[i].modelId && p.via === fixedRequests[i].via && p.reason === fixedRequests[i].reason,
  );
  ok("ADAPTIVE_ROUTING=0: same picks, same via, same reason", identical, `enabled=${today.enabled} picks=${picksOff.map((p) => p.modelId).join(",")}`);
  ok(
    "ADAPTIVE_ROUTING=0: no decision events, no topic traffic",
    today.counters.decisions === 0 && today.bus.stats().topics["laya.outcomes"].produced === 0,
    `decisions=${today.counters.decisions} produced=${today.bus.stats().topics["laya.outcomes"].produced}`,
  );
  recordAdaptiveOutcome({ complexity: "STANDARD", modelId: DEEPSEEK, via: "gateway" }, true, Date.now() - 12, { tokens: 100 });
  ok("ADAPTIVE_ROUTING=0: recording an outcome writes nothing", today.counters.events === 0 && today.est.appliedCount === 0);

  // -------------------------------------------------------------------------
  // 2/3/4. ADAPTIVE_ROUTING=1 on an isolated engine (temp root, no broker)
  // -------------------------------------------------------------------------
  process.env.ADAPTIVE_ROUTING = "1";
  const eng = new AdaptiveEngine({ root: tmp, brokers: null, enabled: true, persist: true, subscribe: true, source: "check" });
  eng.start();

  // 4. cold start trusts the prior
  const cold = eng.select(priorDeepseek, "COMPLEX", PROMPT, { allowExploreForTest: false });
  ok("cold start: prior kept with n<10", cold.modelId === DEEPSEEK && /cold start/.test(cold.reason), cold.reason);

  // 2. a failing model loses traffic within the window
  const WARM = 10; // exactly enough to leave cold start
  let flippedAt = -1;
  let movedOff = 0;
  for (let i = 0; i < WARM; i++) {
    const pick = eng.select(priorDeepseek, "COMPLEX", PROMPT, { allowExploreForTest: false });
    eng.record({ model: pick.modelId, cls: "COMPLEX", ok: true, latencyMs: 900, cost: 0.0009 });
  }
  for (let j = 0; j < 40; j++) {
    const pick = eng.select(priorDeepseek, "COMPLEX", PROMPT, { allowExploreForTest: false });
    const okSample = pick.modelId !== DEEPSEEK || j % 5 >= 3; // 40% success on deepseek only
    eng.record({
      model: pick.modelId,
      cls: "COMPLEX",
      ok: okSample,
      failureKind: okSample ? "ok" : j % 2 === 0 ? "planner_no_json" : "tool_call_instead_of_json",
      latencyMs: 1200,
      cost: 0.0009,
    });
    if (pick.modelId !== DEEPSEEK) {
      movedOff += 1;
      if (flippedAt < 0) flippedAt = j + 1;
    }
  }
  ok(
    "failing model loses traffic within the 20-sample window",
    flippedAt > 0 && flippedAt <= 20,
    `traffic first moved off ${DEEPSEEK} after ${flippedAt} failing-phase requests; ${movedOff}/40 picks afterwards`,
  );
  const changed = eng.decisions.filter((d) => d.changed && d.prior === DEEPSEEK);
  ok("decision reason names the live P and the escalation", changed.some((d) => /P=\d\.\d\d/.test(d.reason)), (changed[0]?.reason ?? "none").slice(0, 130));

  // 3. circuit reopens after the cool-off
  const COOL = Number(process.env.ADAPTIVE_COOLDOWN_MS ?? 120000);
  const t0 = Date.now();
  const openNow = eng.breaker.state(DEEPSEEK, "COMPLEX", eng.est.recent(DEEPSEEK, "COMPLEX"), t0);
  ok("circuit is open while the window is failing", openNow.state === "open", openNow.detail);
  const half = eng.breaker.state(DEEPSEEK, "COMPLEX", eng.est.recent(DEEPSEEK, "COMPLEX"), t0 + COOL + 1);
  ok("circuit half-opens after the cool-off", half.state === "half-open", half.detail);
  const pickAfterCool = eng.select(priorDeepseek, "COMPLEX", PROMPT, { nowMs: t0 + COOL + 1, allowExploreForTest: false });
  ok("half-open model is eligible again (not skipped as open)", !/^open/.test(pickAfterCool.circuit[DEEPSEEK] ?? ""), pickAfterCool.circuit[DEEPSEEK]);
  // the half-open trial fails => the circuit reopens with a fresh cool-off
  eng.record({
    model: DEEPSEEK,
    cls: "COMPLEX",
    ok: false,
    failureKind: "planner_no_json",
    latencyMs: 1300,
    ts: new Date(t0 + COOL + 1).toISOString(),
  });
  const reopened = eng.breaker.state(DEEPSEEK, "COMPLEX", eng.est.recent(DEEPSEEK, "COMPLEX"), t0 + COOL + 2);
  ok("half-open failure reopens the circuit (fresh cool-off)", reopened.state === "open", reopened.detail);
  const pickAfterReopen = eng.select(priorDeepseek, "COMPLEX", PROMPT, { nowMs: t0 + COOL + 2, allowExploreForTest: false });
  ok(
    "reopened circuit is skipped again",
    pickAfterReopen.circuit[DEEPSEEK]?.startsWith("open") === true && pickAfterReopen.modelId !== DEEPSEEK,
    `${pickAfterReopen.circuit[DEEPSEEK]} -> ${pickAfterReopen.modelId}`,
  );
  ok("exploration re-tests the cheaper failing model when the dice allow", /exploration/.test(eng.select(priorDeepseek, "COMPLEX", PROMPT, { rng: () => 0 }).reason));

  // -- persistence: flush, then reload in a fresh engine ----------------------
  eng.flush();
  const before = eng.est.p(DEEPSEEK, "COMPLEX");
  const eng2 = new AdaptiveEngine({ root: tmp, brokers: null, enabled: true, persist: true, subscribe: true, source: "check-reload" });
  eng2.start();
  const after = eng2.est.p(DEEPSEEK, "COMPLEX");
  ok("persisted state reloads", before !== null && after !== null && Math.abs(before - after) < 1e-9, `p before=${before?.toFixed(4)} after=${after?.toFixed(4)}`);
  await new Promise((r) => setTimeout(r, 400)); // outcome appends are async by design
  ok(
    "outcomes.jsonl has the recorded events",
    fs.readFileSync(path.join(tmp, "adaptive", "outcomes.jsonl"), "utf8").split("\n").filter(Boolean).length >= 50,
  );
  ok("estimates.json exists", fs.existsSync(path.join(tmp, "adaptive", "estimates.json")));

  // -------------------------------------------------------------------------
  // 6. broker unreachable => in-process fallback, flagged
  // -------------------------------------------------------------------------
  const eng3 = new AdaptiveEngine({ root: tmp, brokers: ["127.0.0.1:9"], enabled: true, persist: false, subscribe: true, source: "check-broker" });
  eng3.start();
  eng3.record({ model: DEEPSEEK, cls: "COMPLEX", ok: true, latencyMs: 900 });
  await new Promise((r) => setTimeout(r, 1200));
  const stats3 = eng3.bus.stats();
  ok(
    "unreachable broker: in-process fallback",
    stats3.backend === "in-process" && stats3.brokerRequested && !stats3.brokerUp,
    `${stats3.backend} / ${stats3.brokerDetail}`,
  );
  const flags3 = (eng3.snapshot() as { flags: { key: string; label: string; on: boolean }[] }).flags;
  ok("fallback is flagged on the dashboard payload", flags3.some((f) => f.key === "kafka" && f.on && /Kafka down, using in-process/.test(f.label)));
  ok("in-process topic still delivered the event (no double count)", eng3.est.appliedCount === 1, `applied=${eng3.est.appliedCount} dupes=${eng3.counters.dupes}`);

  // -------------------------------------------------------------------------
  // 7. REAL Kafka, when the provisioned broker answers on 127.0.0.1:9092.
  //     (Skipped with a clear line when it does not: the in-process path above is
  //     the one this repo ships with by default.)
  // -------------------------------------------------------------------------
  // ORDER 2026-10-01 replay-attribution: the real broker on 127.0.0.1:9092 is LIVE and another
  // worker owns it (the order says "do not touch Kafka"), so this copy probes a dead port and
  // skips block 7. Everything else is byte-identical to ops/adaptive-check.ts.
  const kafkaUp = await tcpProbe("127.0.0.1", 9, 800);
  if (!kafkaUp) {
    console.log("SKIP  kafka: no broker on 127.0.0.1:9092 (in-process topic is the tested path; see docs/perf/KAFKA_SETUP.md)");
  } else {
    process.env.KAFKA_BROKERS = "127.0.0.1:9092";
    const ke = new AdaptiveEngine({ root: tmp, enabled: true, persist: false, subscribe: true, source: "check-kafka" });
    ke.start();
    const upOk = await waitFor(() => ke.bus.stats().brokerUp, 25000);
    ok("kafka: broker reachable, topics created", upOk, `${ke.bus.stats().backend} / ${ke.bus.health().detail}`);
    const before = ke.est.appliedCount;
    const N = 12;
    for (let i = 0; i < N; i++) {
      ke.record({
        model: DEEPSEEK,
        cls: "COMPLEX",
        ok: i % 5 >= 3,
        failureKind: i % 5 >= 3 ? "ok" : "planner_no_json",
        latencyMs: 1100,
        cost: 0.0009,
      });
    }
    const consumed = await waitFor(() => (ke.bus.stats().groups.find((g) => g.group === "laya-estimator")?.consumed ?? 0) >= N, 25000);
    await new Promise((r) => setTimeout(r, 1500));
    const st = ke.bus.stats();
    const outTopic = st.topics["laya.outcomes"];
    ok("kafka: producer sent to laya.outcomes", (outTopic?.produced ?? 0) >= N, `produced=${outTopic?.produced} highWater=${outTopic?.highWater} partitions=${(outTopic?.offsets ?? []).length}`);
    ok("kafka: partitions are 3 and carry offsets", (outTopic?.offsets ?? []).length === 3 && (outTopic?.highWater ?? 0) > 0, `offsets=[${(outTopic?.offsets ?? []).join(",")}]`);
    ok("kafka: consumer group laya-estimator received the events", consumed, `consumed=${st.groups.find((g) => g.group === "laya-estimator")?.consumed}`);
    ok("kafka: dashboard group laya-monitor is subscribed too", st.groups.some((g) => g.group === "laya-monitor"));
    const delivered = st.groups.find((g) => g.group === "laya-estimator")?.consumed ?? 0;
    ok(
      "kafka: nothing counted twice (idempotent by event id)",
      ke.est.appliedCount === before + delivered && ke.counters.dupes === N,
      `applied=${ke.est.appliedCount} = local ${N} + broker ${delivered - N} (earlier events replayed on subscribe) ; dupes ignored=${ke.counters.dupes} (the ${N} local ones came back and were dropped)`,
    );
    ok("kafka: consumer lag reported (not negative)", st.groups.every((g) => g.lag >= 0 || g.lag === -1), `${st.groups.map((g) => `${g.group}=${g.lag}`).join(" ")} | highWater=${Object.entries(st.topics).map(([t, v]) => `${t}:${v.highWater}`).join(",")}`);
    await ke.close();
    delete process.env.KAFKA_BROKERS;
  }

  await eng.close();
  await eng2.close();
  await eng3.close();
  return failures;
}

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (v: boolean) => {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

async function waitFor(fn: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

main()
  .then((f) => {
    console.log(`\n${checks - failures}/${checks} checks passed (${failures} failed). tmp=${tmp}`);
    process.exit(f ? 1 : 0);
  })
  .catch((e) => {
    console.error("adaptive-check crashed:", e);
    process.exit(2);
  });
