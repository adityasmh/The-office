# Metrics stack for Laya (VictoriaMetrics, small version of the Razorpay diagram) - spec

CEO approved 2026-10-01. Pattern from the diagram, shrunk to one laptop (15.7 GB RAM, often near-full, RTX 4050 6 GB).

| Diagram | Ours |
|---|---|
| Metrics sources (CloudWatch, k8s, app/business) | our `/metrics` endpoints: router, adaptive routing + Kafka lag, host/GPU exporter, fleet/session stats |
| 8 VM Agents | ONE `vmagent` (scrapes every 5 s, tiny memory) |
| Load balancers, 2x VM Insert/Storage/Select | NOT built: ONE `victoria-metrics` single-node (insert+storage+select in one binary) |
| Grafana | NOT now (200-400 MB RAM). VictoriaMetrics' own UI (`/vmui`) plus our plain page cover it. Revisit when RAM allows |
| Alertmanager -> Slack | `vmalert` evaluates rules -> webhook into our router -> manager queue first; only CEO-level alerts to Slack through the EXISTING Slack bridge (src/slack.ts), rate-limited |

## Downloads approved (exactly these, nothing else)
From the official GitHub releases of VictoriaMetrics/VictoriaMetrics (latest stable, windows amd64): `victoria-metrics-windows-amd64`, `vmagent-windows-amd64`, `vmalert-windows-amd64` (zips; about 30-60 MB in total). Verify each zip against the published `_checksums.txt` / SHA-256 from the same release and STOP if it does not match. Unpack INSIDE the repo under `tools/vm/` (add to .gitignore if one exists). No system install, no PATH/registry change, no admin, no Docker, no Grafana, no Alertmanager. Record versions, sizes, checksums in `docs/perf/METRICS_SETUP.md`.

## Run
- `ops/metrics-up.ps1` / `ops/metrics-down.ps1`: start/stop detached, localhost only (`-httpListenAddr=127.0.0.1:PORT`). Ports: victoria-metrics 8428, vmagent 8429, vmalert 8880, host exporter 9101. Data in `company/vm-data/`, retention 14 days (`-retentionPeriod=14d`), small memory (`-memory.allowedPercent=10`).
- **RAM guard:** do not start unless free RAM >= 1.5 GB; if it is lower, report and exit 0. Expected use about 150-250 MB for the whole stack. State the measured RSS of each process in the doc.
- Idempotent: only start what is not already running; never kill anything that is not ours (by pid file in `company/vm-data/pids.json`).

## Sources to build (small, no deps beyond what is installed)
1. `GET /company/metrics` on the router (Prometheus text, loopback no token): fleet orders by status, work orders by state, running sessions/terminals, event-loop lag (the lagMs/lagMaxMs the health check already has), request counts + latency per route, queue sizes (needs-you, manager queue), measured spend, parked/failed tasks. Put code in `src/metrics/` and add ONE line in src/server.ts; other workers are editing server.ts, re-read right before editing, tiny diff.
2. Adaptive routing + Kafka metrics: the adaptive order is adding `GET /company/adaptive/metrics`; scrape it when it exists (scrape config tolerates it being down).
3. `ops/host-exporter.mjs` on :9101: free/total RAM, per-process RSS for our processes (router, laya python, jcode, kafka, vm), GPU via `nvidia-smi --query-gpu` (VRAM used/total, util, temp, power), Laya /health up/latency (127.0.0.1:8000), Kafka port 9092 up. No external calls.
4. vmagent scrape config `tools/vm/scrape.yml` for all of the above, 5 s interval.

## Alerts (vmalert rules in `tools/vm/alerts.yml`)
Each has a severity: `routine` (manager queue only) or `ceo` (also Slack).
- router event-loop lag > 5 s for 1 m (routine; > 30 s for 2 m = ceo)
- router /company/metrics not scraped for 2 m (ceo: router down)
- free RAM < 1.0 GB for 2 m (routine); < 0.5 GB for 2 m (ceo)
- GPU VRAM > 90% for 3 m, GPU temp > 85 C (routine)
- Laya /health down or p95 > 3 s for 2 m (routine; down for 5 m = ceo)
- Kafka down, consumer lag > 5 s for 2 m (routine); adaptive circuit open (routine); producer drops > 0 (routine)
- fleet: orders failed in the last 15 m >= 3 (routine); same failure kind >= 3 (routine, name the kind)
- measured spend rising faster than a configurable cap per hour (ceo)
Webhook: `POST /company/alerts/webhook` (Alertmanager-compatible JSON that vmalert sends with `-notifier.url`). Receiver in `src/metrics/alerts.ts`: dedupe by alertname+labels, route `routine` into the existing manager queue (look at how src/company needsYouRule / manager-queue creates items; reuse, do not invent a second queue), `ceo` additionally posts ONE Slack message via the existing slack.ts persona function, max 1 Slack message per alert per 30 min, plain words ("Router is not responding for 2 minutes. Manager is looking at it."). Resolved alerts close the item. Never include secrets or prompt text.

## Dashboard
`public/metrics.html` (plain, 2 s refresh, reads from VictoriaMetrics `http://127.0.0.1:8428/api/v1/query` through a tiny router proxy `GET /company/metrics/query?q=` so the browser needs no CORS): panels for router lag, RAM free, GPU VRAM/temp, Laya latency, Kafka lag, orders by status, firing alerts. Link from the main dashboard and from public/adaptive.html. Also mention `/vmui` at :8428.

## Checks (must pass)
`ops/metrics-check.ts`: stack up -> all 3 scrape targets show `up=1` within 30 s -> a fake alert posted to the webhook creates exactly one manager-queue item, a duplicate does not, resolve closes it, a `ceo` fake produces one Slack call to a STUBBED sender (never the real Slack in the test) -> RAM guard path tested with a stub free-RAM value. `npx tsc --noEmit` exit 0.

## Rules
Do not restart the router (manager does it). Do not touch Laya serving or scripts/serve-laya.ps1 / laya-gpu-boot.py (cuda session). No secrets printed. No deletes outside tools/vm and company/vm-data. Memory-light: nothing may start if RAM guard fails.
