# Payments gateway routing demo (simulation) - spec

Source: CEO diagram (2026-10-01). Everything is simulated: no real money, no real banks, no real cards.
Code lives in `payments-demo/` (TypeScript, Node, same style as src/). Do not touch src/, scripts/serve-laya.ps1, laya-gpu-boot.py.

## Flow (from the diagram)
1. `POST /payments` enters **payments-service**.
2. payments-service asks **rule-engine** to "Select Gateway" (sync call).
3. rule-engine picks Bank 1 or Bank 2 using rules + the latest **success probability per gateway** from the ML engine. It sends the payment to that bank and returns the result.
4. payments-service publishes a **Payment Status Event** (id, amount, gateway, status, latency_ms, error_code, ts) to the **Kafka topic**.
5. **real-time ML engine** consumes the topic and keeps an online estimate of success probability per gateway (decayed counts / EWMA over a recent window, optionally per amount band). It pushes "success probability across gateways" to the rule-engine (in-process call or HTTP `PUT /probabilities`).
6. rule-engine uses the probabilities: pick the highest, with rules first (amount limits per bank, a gateway marked down by the circuit breaker is skipped, 5% exploration so a recovering gateway is re-tested).

## Components and ports
- payments-service  :8801  `POST /payments`, `GET /payments/:id`
- rule-engine       :8802  `POST /select`, `PUT /probabilities`, `GET /rules`
- ml-engine         :8803  consumes topic, `GET /probabilities`
- bank simulators   :8811 (Bank 1), :8812 (Bank 2): each has settable success rate, latency, and an outage switch via `POST /control {successRate, latencyMs, down}`.
- topic: interface `Topic { publish(ev), subscribe(fn), depth() }`. Default `InProcessTopic` (bounded ring, drops oldest and counts drops). Optional `KafkaTopic` behind env `KAFKA_BROKERS` using kafkajs; NOT started by default (memory). Do not install or start a broker.
- monitor dashboard :8805  (see below)
- everything starts with one command: `npm run payments:demo` (add script in package.json) or `payments-demo/start.ps1`; one process is fine if ports are honoured.

## Monitoring (the CEO wants to watch this closely)
Dashboard at http://localhost:8805, plain words, auto refresh 1 s, no polish. Shows:
- per gateway: success rate (last 1 min and 5 min), model probability, p50/p95 latency, count, circuit state (up/down)
- topic: depth, events/s, dropped count, ML engine lag (seconds behind the newest event)
- rule engine: last 20 decisions with the reason ("highest probability 0.93", "bank 2 down", "amount over limit", "exploration")
- live payments feed (last 50) with status
- overall: payments/s, overall success rate, error codes histogram
- an "events" strip that flags: a gateway going down, probabilities flipping the preferred gateway, ML lag > 5 s, drops > 0
`GET /metrics` on every service in Prometheus text format; `GET /health` on every service.
Also write JSON lines to `payments-demo/logs/decisions.jsonl` and `events.jsonl`.

## Load generator and the demo script
`payments-demo/loadgen.ts`: steady N payments/s with random amounts. `payments-demo/scenario.ts` runs a scripted story and prints the numbers:
 1. both banks healthy 95%/92% for 30 s
 2. Bank 1 success drops to 40% -> measure how many payments until the router shifts away (seconds and count)
 3. Bank 1 goes fully down -> circuit opens, all traffic to Bank 2, zero requests lost
 4. Bank 1 recovers -> exploration finds it, traffic returns
 5. flood at 10x rate -> topic drops/lag, payments-service sheds or queues, never freezes
Output: `docs/perf/PAYMENTS_SCENARIO.md` with a table: overall success rate with the ML router vs a naive round-robin baseline run on the SAME bank behaviour. Real measured numbers only.

## Rules for the code
- Idempotency key on `POST /payments` (same key = same result, no double charge).
- Timeouts and one retry on the other gateway if the first times out (only if the first did not return a success).
- No secrets, no outbound network calls beyond localhost. Memory-light: no JVM, no database; state in memory + jsonl.
- Add `ops/payments-check.ts`: starts the stack, sends 200 payments, asserts: all get a final status, probabilities sum sensible, a downed bank gets near-zero traffic within 10 s, idempotent replay returns the same id. ALL PASS required. `npx tsc --noEmit` exit 0.
