# VictoriaMetrics monitoring for our tools (single-node, laptop-sized) - spec

Source: CEO diagram (VictoriaMetrics agents -> insert/storage/select -> Grafana + Alertmanager -> Slack). We build the single-machine version. Not the cluster, not CloudWatch, not Kubernetes.

## CEO approvals (2026-10-01)
Downloads approved from OFFICIAL releases only (github.com/VictoriaMetrics/VictoriaMetrics releases, github.com/prometheus/alertmanager releases, Grafana OSS zip from dl.grafana.com): `victoria-metrics` single-node, `vmagent`, `vmalert`, `vmutils` bundle if that is how they ship, Alertmanager, and Grafana OSS. Windows amd64 builds, verify the published SHA-256 for each and stop on mismatch. Unpack INSIDE the repo under `tools/vm/` (victoria-metrics, vmagent, vmalert, alertmanager) and `tools/grafana/`; no installer, no admin, no PATH/registry change, no Windows service. Record versions, sizes, checksums in docs/perf/VM_SETUP.md. Nothing else may be downloaded.
Slack alerts: build and test the wiring, but **send nothing outbound until the CEO confirms** (the alert receiver defaults to `local-only`; Slack receiver stays disabled by flag `ALERT_SLACK=0`). Never print or store the Slack token anywhere new: reuse what src/slack.ts / slackInbound.ts already use, one channel. Air-gapped mode (AIR_GAPPED=1) forces local-only.

## Memory budget (this laptop is often <1 GB free)
Total for the whole stack under ~300 MB when Grafana is off. Start scripts must check free RAM first: below 1.5 GB free, start only victoria-metrics + vmagent (the core, ~100 MB) and say so. Retention 7 days. Grafana is off by default (`ops/vm-up.ps1 -Grafana` to start).
Ports (127.0.0.1 only): VictoriaMetrics 8428 (its built-in query UI is http://localhost:8428/vmui), vmagent 8429, vmalert 8880, Alertmanager 9093, Grafana 3000.
Data under `company/vm-data/`. Start/stop: `ops/vm-up.ps1`, `ops/vm-down.ps1` (detached hidden processes, clean stop, pid files, idempotent; never kill anything it did not start).

## What gets scraped (vmagent, scrape every 5 s, config `ops/vm/vmagent.yml`)
1. Router: add `GET /metrics` (Prometheus text) to the router if missing: event-loop lag (lagMs, lagMaxMs), uptime, requests by route+status, request duration, fleet orders by status, sessions by status, running terminals, planner failures by kind, Laya call latency, `/company/panel` build time.
2. Adaptive routing: `/company/adaptive/metrics` (being built by order fomuperagy): P(success) per model x class, circuit state, decision counts, topic depth, consumer lag.
3. Kafka: broker up/down, topic offsets, consumer-group lag (small exporter script reading from the broker; or JMX-less approach through kafkajs admin API) exposed at :9308.
4. Machine: free RAM, committed memory, CPU, disk free (a small `ops/vm/host-exporter.ts` reading `Get-CimInstance`/os module, :9309).
5. GPU: `ops/vm/gpu-exporter.ts` shelling out to `nvidia-smi --query-gpu=... --format=csv` every 5 s: VRAM used/total, GPU util, temperature, power, throttle reasons. Tolerate nvidia-smi missing/failing (export `gpu_up 0`).
6. Laya server :8000 `/health` latency and up/down via a blackbox-style probe in the same host exporter.
7. Business metrics: spend (measured) per model/provider from company/budgets.json, tasks done/failed per day, needs-you count, manager-queue size.
Every exporter binds 127.0.0.1 only, is tiny, and never blocks if its source is slow (timeout 2 s, last good value + `scrape_ok 0`).

## Alert rules (vmalert, `ops/vm/alerts.yml`), each with a plain-words summary
- RouterLagHigh: lagMaxMs > 5000 for 1 min (the 2026-09-30 hang and the 32 s stalls)
- RouterDown: up == 0 for 30 s
- FreeRamLow: free RAM < 1 GB for 2 min; FreeRamCritical < 0.5 GB
- LayaDown / LayaSlow: /health failing, or latency p95 > 3 s (the router's own Laya timeout)
- GpuVramHigh: > 5.5 GB of 6 GB; GpuThrottled; GpuDown
- ModelSuccessDropped: P(success) for a model under 0.6 over 5 min; CircuitOpened
- PlannerNoJsonSpike: planner failures > 3 in 10 min
- KafkaDown, KafkaConsumerLagHigh (> 500 events or > 30 s), ProduceDropsNonZero
- NeedsYouGrowing / ManagerQueueStuck
- SpendRate: measured spend more than X per hour (X in env, default 2 USD)
Alertmanager groups by alertname, 5 min repeat, inhibits warning when critical fires. Receivers: `local` (always on: writes `company/alerts/alerts.jsonl` and a flag the dashboard shows) and `slack` (disabled, see above).

## Dashboards
- Our own plain page `public/monitor.html` (auto refresh 2 s, plain words, no polish) showing the firing alerts and the 8 most important numbers (router lag, free RAM, GPU VRAM, Laya latency, Kafka lag, model P(success) table, spend/hour, needs-you), reading from VictoriaMetrics' HTTP API through a tiny router endpoint `GET /company/monitor` (loopback, read-only, short cache). Link from the main dashboard.
- Grafana: provision one datasource and one dashboard JSON (`tools/grafana/provisioning/`) with the same panels, only if `ops/vm-up.ps1 -Grafana` is used.

## Proof (real numbers, honest)
`ops/vm-check.ts`: starts the stack, waits for first scrape, asserts every target is `up`, fires each of these on purpose and measures time-to-alert: stop Laya (LayaDown), spin the router event loop for 8 s in a throwaway instance on another port (RouterLagHigh), allocate memory to push free RAM down only if safe (otherwise inject a fake metric via the exporter's test hook) and checks the alert lands in `company/alerts/alerts.jsonl` and on `public/monitor.html`. Writes `docs/perf/VM_MONITORING.md` with: stack RAM measured (RSS per process), scrape interval, time-to-alert per rule, and what is NOT covered. `npx tsc --noEmit` exit 0.

## Rules
Do not restart the main router (the manager does). The router `/metrics` hook is a small edit: re-read src/server.ts right before editing, other workers are editing it. Do not touch Laya serving or scripts/serve-laya.ps1. No secrets printed. Append a timestamped entry to docs/AGENT_COORDINATION.md.
