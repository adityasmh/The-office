# Laya adaptive routing (diagram applied to Laya AI) - spec

Same shape as the CEO's payments diagram, but the "payment" is an AI request and the "banks" are model providers.

| Diagram | Laya version |
|---|---|
| /payments | an AI request entering the router (`/route`, `/chat`, fleet planner / worker calls) |
| payments-service | **request-service**: takes the request, asks the rule engine for a model, calls it, returns the answer |
| Select Gateway | **Select Model**: the rule-engine picks provider+model for this request |
| Bank 1 / Bank 2 | model providers: deepseek-v4.1-flash, kimi-k2.7-code, glm-5.3-flash, Claude (Sonnet via CLI), optional small local model |
| Payment Status Events | **Outcome events**: request id, task class (Laya's ROUTINE/STANDARD/COMPLEX/DEMANDING), model, ok/fail, failure kind, latency_ms, tokens, cost |
| Kafka topic | **Real Kafka topic** `laya.outcomes` (see "Kafka" below). Internal to our tools and routing; the banks in the diagram were only an analogy |
| real-time ML engine | **Online success estimator**: live P(success) per (model, task class), plus latency and cost, updated on every event |
| Success probability across gateways | `P(success | model, task class)` pushed to the rule engine |
| rule-engine | **Rule engine**: Laya's current choice (chooseBestModel / decideRoute) stays the prior; rules + live probabilities adjust it |

## Kafka (real, internal)
- Topics: `laya.outcomes` (every request outcome; key = model so one model's events stay ordered; 3 partitions is plenty), `laya.decisions` (rule-engine decisions + reasons, for the dashboard/audit), `laya.dlq` (events that failed to parse). Retention 24 h / 256 MB, this is a rolling window, not a database.
- Producers: the request path (every Laya-routed call: router `/route` `/chat`, fleet planner, fleet workers, company pipeline roles, the cuda/eval tools when they call Laya). Producing must never block or fail a request: fire-and-forget with a small bounded buffer, drop-and-count when the broker is slow or down.
- Consumers: the online success estimator (consumer group `laya-estimator`, commits offsets, on start replays the last hour so it rebuilds its state) and the dashboard feed (`laya-monitor`). Anything else that wants routing outcomes later (cost tracking, budget guard) subscribes as its own group, not by changing the producer.
- Client: `kafkajs` (pure JS, no JVM in our process). `src/adaptive/topic.ts` keeps the `Topic` interface with two implementations: `KafkaTopic` (used when `KAFKA_BROKERS` is set and reachable) and `InProcessTopic` (bounded ring). If the broker is unreachable the system FALLS BACK to the in-process topic automatically, flags it on the dashboard ("Kafka down, using in-process"), and reconnects in the background. Air-gapped mode (another worker's flag) works because the broker is localhost only.
- Broker: ONE local single-node broker on 127.0.0.1:9092, KRaft mode (no ZooKeeper), small heap (~256 MB) because this laptop has 15.7 GB total and is often near-full. No Java and no running Docker daemon exist on this machine today, so provisioning the broker is a separate step that needs the CEO's yes for the download: option A Redpanda single node (Docker Desktop, `--smp 1 --memory 512M --overprovisioned`), option B Apache Kafka KRaft + a JDK (zip, no installer). The code and checks are written against the interface first and run on `InProcessTopic`; the Kafka-specific checks run when the broker is up. **CEO chose option B (2026-10-01): Apache Kafka KRaft + JDK, approved for exactly these two downloads and nothing else:** (1) a Temurin JDK 17 zip (x64 Windows) from the official Adoptium site (api.adoptium.net / github.com/adoptium), (2) the Apache Kafka binary tgz/zip (current 3.x, Scala 2.13) from downloads.apache.org or archive.apache.org. Verify each against its published SHA-512/SHA-256 checksum and stop if it does not match. Unpack INSIDE the repo under `tools/jdk/` and `tools/kafka/` (add both to .gitignore if a .gitignore exists); no system-wide install, no PATH or registry changes, no admin. Write `ops/kafka-up.ps1` (formats KRaft storage once, starts the broker detached on 127.0.0.1:9092 with `KAFKA_HEAP_OPTS=-Xms128m -Xmx256m`, data dir `company/kafka-data/`, waits for the port) and `ops/kafka-down.ps1` (clean stop). Create the three topics. Before starting the broker check free RAM; if under 1.5 GB free, do not start it, report and use the in-process topic. Record the sizes and checksums you verified in docs/perf/KAFKA_SETUP.md.
- Safety: only localhost, no auth needed locally, but bind to 127.0.0.1 only. Messages contain no prompt text, only ids, model, class, outcome, failure kind, latency, tokens, cost (privacy + size).
- Extra monitoring for Kafka: topic offsets per partition, consumer lag per group (estimator and monitor), produce errors, dropped-at-producer count, broker up/down state.

## What counts as "success" (the useful part)
A call is a failure if any of: HTTP 429/5xx/timeout; planner returned no parseable JSON or a tool-call instead of JSON (the 2026-10-01 failure: deepseek planning orders with "read file X" wording); empty/too-short answer; reviewer verdict LOOP/REDO on the result; budget exceeded. Record the failure kind, so the estimator learns per kind.

## Rule engine behaviour
1. Start from Laya's pick (unchanged, it is the prior).
2. Cost-aware: choose the CHEAPEST model whose live `P(success | model, class)` >= threshold for that class (default 0.85, env `ADAPTIVE_MIN_SUCCESS`). Cheap-by-default stays: deepseek first unless data says it fails this class.
3. If a model is failing (P below 0.5 over the last N=20) or hits 429s: circuit opens, skip it for a cool-off, route to the next cheapest that clears the threshold. Escalation to Kimi/Claude is recorded with the reason.
4. 5% exploration so a recovered model gets re-tested; never explore on CEO-named or high-risk requests.
5. Cold start: fewer than 10 samples for a (model, class) = trust Laya's prior.
6. Hard rules first: air-gapped flag (no outbound models), CEO-named model, per-agent budget, tool-capable model required when the request needs tools.
7. Every decision logs its reason ("deepseek P=0.93 >= 0.85, cheapest", "deepseek circuit open: 7/20 planner no-JSON", "exploration").

## Where it lives (do not collide with other workers)
- New code in `src/adaptive/` : `topic.ts` (Topic interface + InProcessTopic), `estimator.ts` (online decayed counts / EWMA per (model, class), keeps latency p50/p95 and cost), `rules.ts` (selection + circuit breaker), `events.ts` (event type + failure kinds), `index.ts`.
- A small hook in the existing call path (src/orchestrator.ts `decideRoute`/`generate` and the fleet planner call): (a) before the call, `adaptive.select(prior, class)`; (b) after, `adaptive.record(outcome)`. Behind env `ADAPTIVE_ROUTING=1`, **default 0** so nothing changes until the CEO turns it on. Keep the hook diff minimal: other workers are editing orchestrator/decision (decision cache, air-gapped mode, planner fix). Re-read the file right before editing, edit small, never rewrite files.
- State persisted to `company/adaptive/outcomes.jsonl` and `estimates.json` (restart keeps what it learned). Bounded.
- Do NOT touch Laya serving (scripts/serve-laya.ps1, laya-gpu-boot.py, anything under deps/): the cuda session owns it. Do not restart the router.

## Monitoring (the CEO wants to watch this closely)
- `GET /company/adaptive` on the router (read-only, loopback no token) returning JSON, and a plain page `public/adaptive.html` (auto refresh 1-2 s) showing: per (model x task class) P(success), n samples, latency p50/p95, cost per call, circuit state; last 30 routing decisions with reasons; topic depth, events/s, dropped, estimator lag; a flags strip (circuit opened, preferred model flipped, lag > 5 s, drops > 0); failure kinds histogram.
- `GET /company/adaptive/metrics` Prometheus text.
- Link it from the main dashboard (one plain link).

## Demo + numbers (real, measured)
- `ops/adaptive-sim.ts`: simulated providers (settable success rate, latency, outage, 429s, "returns tool-call instead of JSON" mode) driven through the SAME request-service/rule-engine code. Scenario: all healthy -> deepseek success drops to 40% on COMPLEX (the planner failure) -> measure payments... requests until traffic shifts away (count + seconds) -> provider fully down -> zero lost requests via fallback -> recovers -> exploration returns traffic -> 10x flood: topic drops/lag shown, no freeze.
- Compare against the current static Laya routing on the same simulated provider behaviour: success rate, mean cost per request, p95 latency. Table in `docs/perf/ADAPTIVE_ROUTING.md`. Honest numbers; include where adaptive is WORSE (cold start, exploration cost).
- Replay mode: `ops/adaptive-replay.ts` replays real past outcomes (company/fleet orders, company/sessions.jsonl, logs/router.out.log `[brain]` + `[fleet:plan:debug]` lines) into the estimator and prints what it would have learned (e.g. deepseek planning P(success) on COMPLEX). This is the real-data evidence.

## Checks
`ops/adaptive-check.ts`: with ADAPTIVE_ROUTING=0 behaviour identical to today (same picks on a fixed request set); with =1: failing model loses traffic within the stated window; circuit reopens after cool-off; cold start uses the prior; persisted state reloads. ALL PASS + `npx tsc --noEmit` exit 0.
