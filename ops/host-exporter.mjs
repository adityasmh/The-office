// ---------------------------------------------------------------------------
// ops/host-exporter.mjs - the host/GPU exporter for the Laya metrics stack
// (docs/METRICS_STACK_SPEC.md section "Sources to build" 3).
//
// Serves Prometheus text on 127.0.0.1:9101 (/metrics) with:
//   * free/total RAM (os.freemem / os.totalmem)
//   * per-process RSS for OUR processes (router, laya python, jcode, kafka, vm)
//   * GPU via `nvidia-smi --query-gpu` (VRAM used/total, util, temp, power)
//   * Laya /health up + latency (127.0.0.1:8000)
//   * Kafka port 9092 up
//
// No external calls: everything is local (os, nvidia-smi, a loopback HTTP GET, a
// loopback TCP connect, and one PowerShell CIM read for the process table).
//
// MEMORY-LIGHT BY DESIGN: the process table scan is the expensive one on this
// box (CIM can stall for seconds), so it never runs on the scrape path. Each
// source refreshes on its own timer and the scrape renders the cached values, so
// a scrape is a string build and nothing else. No external dependencies.
//
// Usage: node ops/host-exporter.mjs        (HOST_EXPORTER_PORT to override 9101)
// ---------------------------------------------------------------------------
import http from "node:http";
import os from "node:os";
import net from "node:net";
import { execFile } from "node:child_process";

const PORT = Number(process.env.HOST_EXPORTER_PORT || 9101);
const BIND = process.env.HOST_EXPORTER_BIND || "127.0.0.1";
const LAYA_HEALTH_URL = process.env.LAYA_HEALTH_URL || "http://127.0.0.1:8000/health";
const KAFKA_HOST = process.env.KAFKA_HOST || "127.0.0.1";
const KAFKA_PORT = Number(process.env.KAFKA_PORT || 9092);
const NVIDIA_SMI = process.env.NVIDIA_SMI || "nvidia-smi";

const PROCESS_TTL_MS = Number(process.env.HOST_EXPORTER_PROCESS_TTL_MS || 20_000);
const GPU_TTL_MS = Number(process.env.HOST_EXPORTER_GPU_TTL_MS || 10_000);
const HEALTH_TTL_MS = Number(process.env.HOST_EXPORTER_HEALTH_TTL_MS || 5_000);

// ── small helpers ──────────────────────────────────────────────────────────
const now = () => Date.now();
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const esc = (v) => String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ");

const state = {
  startedAt: now(),
  processes: { at: 0, ok: false, error: "", rows: [] },
  gpu: { at: 0, ok: false, error: "", rows: [] },
  laya: { at: 0, up: 0, latencyMs: 0, status: 0, error: "", samples: [] },
  kafka: { at: 0, up: 0, error: "" },
};

// ── process table (one async PowerShell CIM read, cached) ─────────────────
const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$names = @('node.exe','python.exe','java.exe','jcode.exe','victoria-metrics.exe','vmagent.exe','vmalert.exe','opencode.exe')
$filter = ($names | ForEach-Object { "Name='" + $_ + "'" }) -join ' OR '
$rows = Get-CimInstance Win32_Process -Filter $filter | ForEach-Object {
  [pscustomobject]@{ pid = [int]$_.ProcessId; name = [string]$_.Name; rss = [int64]$_.WorkingSetSize; cmd = [string]$_.CommandLine }
}
ConvertTo-Json -Compress -InputObject @($rows)
`.trim();

let processScanInFlight = false;

/** Which of our components a process belongs to (label used on the metric). */
function componentFor(name, cmd) {
  const n = String(name || "").toLowerCase();
  const c = String(cmd || "").toLowerCase();
  if (n.startsWith("victoria-metrics")) return "victoria-metrics";
  if (n.startsWith("vmagent")) return "vmagent";
  if (n.startsWith("vmalert")) return "vmalert";
  if (n.startsWith("java")) return "kafka";
  if (n.startsWith("jcode")) return "jcode";
  if (n.startsWith("python")) return "laya";
  if (n.startsWith("opencode")) return "opencode";
  if (n.startsWith("node")) {
    if (c.includes("host-exporter.mjs")) return "host-exporter";
    if (/server\.ts/.test(c)) return "router";
    return "node";
  }
  return "";
}

function refreshProcesses() {
  if (processScanInFlight) return;
  processScanInFlight = true;
  const started = now();
  execFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", PS_SCRIPT],
    { timeout: 60_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    (err, stdout) => {
      processScanInFlight = false;
      try {
        if (err) {
          state.processes = { ...state.processes, at: now(), ok: false, error: String(err.message || err).slice(0, 200) };
          return;
        }
        const text = String(stdout || "").trim();
        const parsed = text ? JSON.parse(text) : [];
        const list = Array.isArray(parsed) ? parsed : [parsed];
        const byComponent = new Map();
        for (const p of list) {
          if (!p || typeof p !== "object") continue;
          const key = componentFor(p.name, p.cmd);
          if (!key) continue;
          const cur = byComponent.get(key) || { rss: 0, count: 0, pids: [] };
          cur.rss += num(p.rss);
          cur.count += 1;
          cur.pids.push(num(p.pid));
          byComponent.set(key, cur);
        }
        const rows = [...byComponent.entries()].map(([name, v]) => ({ name, rss: v.rss, count: v.count, pids: v.pids }));
        state.processes = { at: now(), ok: true, error: "", rows, scanMs: now() - started };
      } catch (e) {
        state.processes = { ...state.processes, at: now(), ok: false, error: String(e && e.message ? e.message : e).slice(0, 200) };
      }
    },
  );
}

// ── GPU (nvidia-smi, cached) ──────────────────────────────────────────────
const GPU_FIELDS = "index,name,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw";
let gpuScanInFlight = false;

function refreshGpu() {
  if (gpuScanInFlight) return;
  gpuScanInFlight = true;
  execFile(
    NVIDIA_SMI,
    [`--query-gpu=${GPU_FIELDS}`, "--format=csv,noheader,nounits"],
    { timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024 },
    (err, stdout) => {
      gpuScanInFlight = false;
      if (err) {
        state.gpu = { at: now(), ok: false, error: String(err.message || err).slice(0, 200), rows: state.gpu.rows || [] };
        return;
      }
      const rows = [];
      for (const line of String(stdout || "").split(/\r?\n/)) {
        if (!line.trim()) continue;
        const parts = line.split(",").map((s) => s.trim());
        if (parts.length < 7) continue;
        rows.push({
          index: num(parts[0]),
          name: parts[1],
          usedMiB: num(parts[2]),
          totalMiB: num(parts[3]),
          utilPct: num(parts[4]),
          tempC: num(parts[5]),
          powerW: num(parts[6]),
        });
      }
      state.gpu = { at: now(), ok: rows.length > 0, error: rows.length ? "" : "nvidia-smi returned no rows", rows };
    },
  );
}

// ── Laya /health (loopback GET, cached) ───────────────────────────────────
let healthInFlight = false;

function refreshLaya() {
  if (healthInFlight) return;
  healthInFlight = true;
  const started = now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 4000);
  fetch(LAYA_HEALTH_URL, { signal: ac.signal })
    .then((res) => {
      const latencyMs = now() - started;
      const samples = [...state.laya.samples, latencyMs].slice(-20);
      state.laya = { at: now(), up: res.ok ? 1 : 0, latencyMs, status: res.status, error: res.ok ? "" : `HTTP ${res.status}`, samples };
    })
    .catch((e) => {
      const latencyMs = now() - started;
      const samples = [...state.laya.samples, latencyMs].slice(-20);
      state.laya = { at: now(), up: 0, latencyMs, status: 0, error: String(e && e.message ? e.message : e).slice(0, 200), samples };
    })
    .finally(() => {
      clearTimeout(timer);
      healthInFlight = false;
    });
}

// ── Kafka port (loopback TCP connect, cached) ─────────────────────────────
let kafkaInFlight = false;

function refreshKafka() {
  if (kafkaInFlight) return;
  kafkaInFlight = true;
  const sock = net.connect({ host: KAFKA_HOST, port: KAFKA_PORT });
  const done = (up, error) => {
    kafkaInFlight = false;
    state.kafka = { at: now(), up, error: error || "" };
    sock.destroy();
  };
  sock.setTimeout(2000);
  sock.once("connect", () => done(1, ""));
  sock.once("timeout", () => done(0, "timed out"));
  sock.once("error", (e) => done(0, String(e && e.code ? e.code : e).slice(0, 100)));
}

function p95(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

// ── timers (unref'd so the process can still be stopped cleanly) ──────────
refreshProcesses();
refreshGpu();
refreshLaya();
refreshKafka();
setInterval(refreshProcesses, PROCESS_TTL_MS).unref?.();
setInterval(refreshGpu, GPU_TTL_MS).unref?.();
setInterval(refreshLaya, HEALTH_TTL_MS).unref?.();
setInterval(refreshKafka, Math.max(HEALTH_TTL_MS, 5000)).unref?.();

// ── render ────────────────────────────────────────────────────────────────
function render() {
  // Declarations are emitted ONCE per family: a duplicate HELP/TYPE line is a
  // parse error for a Prometheus/VM scraper.
  const help = new Map();
  const series = [];
  const gauge = (name, text, value, labels = "") => {
    if (!help.has(name)) help.set(name, text);
    series.push(`${name}${labels} ${num(value)}`);
  };
  series.push("# Prometheus text from ops/host-exporter.mjs (Laya metrics stack).");
  gauge("host_up", "1 while this exporter answers.", 1);
  gauge("host_exporter_uptime_seconds", "Seconds since the exporter started.", (now() - state.startedAt) / 1000);

  const free = os.freemem();
  const total = os.totalmem();
  gauge("host_ram_free_bytes", "Free physical memory.", free);
  gauge("host_ram_total_bytes", "Total physical memory.", total);
  gauge("host_ram_used_bytes", "Used physical memory.", Math.max(0, total - free));
  gauge("host_load1", "1-minute load average (Windows: 0 when unavailable).", os.loadavg()[0] || 0);
  gauge("host_cpu_count", "Logical CPU count.", os.cpus().length);

  const p = state.processes;
  gauge("host_exporter_process_scan_ok", "1 when the last process scan succeeded.", p.ok ? 1 : 0);
  gauge("host_exporter_process_scan_age_seconds", "Seconds since the last process scan finished.", p.at ? (now() - p.at) / 1000 : -1);
  for (const row of p.rows) {
    gauge("proc_rss_bytes", "Resident memory of our processes by component.", row.rss, `{name="${esc(row.name)}"}`);
    gauge("proc_count", "How many processes of each component are running.", row.count, `{name="${esc(row.name)}"}`);
  }
  const notes = [];
  if (p.error) notes.push(`# process scan note: ${String(p.error).replace(/[\r\n]+/g, " ")}`);

  const g = state.gpu;
  gauge("gpu_scan_ok", "1 when the last nvidia-smi read succeeded.", g.ok ? 1 : 0);
  for (const row of g.rows) {
    const lbl = `{index="${row.index}",name="${esc(row.name)}"}`;
    gauge("gpu_vram_used_bytes", "GPU memory used.", row.usedMiB * 1024 * 1024, lbl);
    gauge("gpu_vram_total_bytes", "GPU memory total.", row.totalMiB * 1024 * 1024, lbl);
    gauge("gpu_vram_used_ratio", "GPU memory used / total.", row.totalMiB ? row.usedMiB / row.totalMiB : 0, lbl);
    gauge("gpu_utilization_percent", "GPU utilization.", row.utilPct, lbl);
    gauge("gpu_temperature_celsius", "GPU temperature.", row.tempC, lbl);
    gauge("gpu_power_watts", "GPU power draw.", row.powerW, lbl);
  }

  gauge("laya_health_up", "1 when Laya /health answered 2xx.", state.laya.up);
  gauge("laya_health_latency_seconds", "Last Laya /health latency.", state.laya.latencyMs / 1000);
  gauge("laya_health_latency_p95_seconds", "p95 Laya /health latency over the last 20 probes.", p95(state.laya.samples) / 1000);
  gauge("laya_health_status_code", "Last HTTP status from Laya /health.", state.laya.status);

  gauge("kafka_up", "1 when TCP 127.0.0.1:9092 accepted a connection.", state.kafka.up);

  const declared = [];
  for (const [name, text] of help) declared.push(`# HELP ${name} ${text}`, `# TYPE ${name} gauge`);
  return [...declared, ...series, ...notes].join("\n") + "\n";
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/metrics" || req.url.startsWith("/metrics?"))) {
    let body;
    try {
      body = render();
    } catch (e) {
      body = `host_exporter_error 1\n# ${String(e && e.message ? e.message : e)}\n`;
    }
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
    res.end(body);
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, processes: state.processes.ok, gpu: state.gpu.ok, laya: state.laya.up, kafka: state.kafka.up }));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found\n");
});

server.listen(PORT, BIND, () => {
  console.log(`[host-exporter] listening on http://${BIND}:${PORT}/metrics (laya=${LAYA_HEALTH_URL}, kafka=${KAFKA_HOST}:${KAFKA_PORT})`);
});

const stop = () => server.close(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
