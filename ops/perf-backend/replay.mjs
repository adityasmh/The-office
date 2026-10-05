// PERF-BACKEND polling replay (2026-09-29).
//
// Replays what the dashboards actually ask for, so a profile shows the real
// request-path work rather than one lucky call:
//
//   * "old dashboard" client: GET /company/panel every 2 s (public/index.html)
//   * "v2 shell" client:      /company/sessions + /company/flow?limit=30 +
//                             /company/budgets every 6 s, /health every 4 s
//   * "v2 office" client:     /company/org + /company/agents every 6 s
//   * "v2 projects" client:   /company/panel every 6 s
//   * "v2 memory" client:     /company/memory/status every 6 s
//   * "static probe":         /v2/ , /v2/app.js , /v2/style.css every 3 s
//                             (a static file's latency IS the event-loop lag)
//
// Usage: node ops/perf-backend/replay.mjs [--base http://127.0.0.1:8801] [--seconds 45] [--label before]
//        node ops/perf-backend/replay.mjs [--base ...] --seq [--rounds 3]
// Prints one line per request plus a per-path latency table (p50/p95/max, bytes).
// --seq measures one client, one request at a time: that is the endpoint's own
// cost, with no queue in front of it (the spec's "every /company/* < 300 ms").

const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const BASE = arg("base", "http://127.0.0.1:8801").replace(/\/+$/, "");
const SECONDS = Number(arg("seconds", "45"));
const LABEL = arg("label", "");

/** path -> samples of { ms, bytes, status } */
const stats = new Map();
let inflight = 0;
let maxInflight = 0;
let errors = 0;
const started = Date.now();

async function hit(path) {
  inflight++;
  if (inflight > maxInflight) maxInflight = inflight;
  const t0 = performance.now();
  let status = 0;
  let bytes = 0;
  try {
    const res = await fetch(BASE + path, { headers: { accept: "*/*" } });
    status = res.status;
    const buf = await res.arrayBuffer();
    bytes = buf.byteLength;
    if (!res.ok) errors++;
  } catch (e) {
    status = -1;
    errors++;
  } finally {
    inflight--;
  }
  const ms = performance.now() - t0;
  const list = stats.get(path) ?? [];
  list.push({ ms, bytes, status });
  stats.set(path, list);
  console.log(`${(ms).toFixed(1).padStart(9)} ms  ${String(status).padStart(3)}  ${String(bytes).padStart(9)} B  ${path}`);
}

function pct(list, p) {
  const s = [...list].sort((a, b) => a - b);
  if (!s.length) return 0;
  const i = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[i];
}

function every(intervalMs, path) {
  void hit(path);
  const t = setInterval(() => void hit(path), intervalMs);
  t.unref?.();
  return t;
}

const SEQ = args.includes("--seq");
const ROUNDS = Number(arg("rounds", "3"));

const PATHS = [
  "/health",
  "/company/panel",
  "/company/panel?lite=1",
  "/company/sessions",
  "/company/flow?limit=30",
  "/company/budgets",
  "/company/org",
  "/company/agents",
  "/company/memory/status",
  "/v2/",
  "/v2/app.js",
  "/v2/style.css",
];

function report() {
  const elapsed = (Date.now() - started) / 1000;
  console.log("");
  console.log(`# replay ${LABEL} ${BASE} mode=${SEQ ? "seq" : "polling"} for ${elapsed.toFixed(1)}s  maxInflight=${maxInflight} errors=${errors}`);
  console.log("# path                                n    p50     p95     max      totalKB  avgB");
  const rows = [...stats.entries()].sort((a, b) => pct(b[1].map((x) => x.ms), 95) - pct(a[1].map((x) => x.ms), 95));
  for (const [path, list] of rows) {
    const ms = list.map((x) => x.ms);
    const bytes = list.reduce((n, x) => n + x.bytes, 0);
    console.log(
      `# ${path.padEnd(34)} ${String(list.length).padStart(3)}  ${pct(ms, 50).toFixed(1).padStart(6)}  ${pct(ms, 95).toFixed(1).padStart(6)}  ${Math.max(...ms).toFixed(1).padStart(6)}  ${(bytes / 1024).toFixed(0).padStart(8)}  ${(bytes / list.length).toFixed(0).padStart(6)}`,
    );
  }
}

if (SEQ) {
  // One client, sequential: the endpoint's own cost, no queue in front of it.
  (async () => {
    for (let r = 0; r < ROUNDS; r++) {
      for (const p of PATHS) await hit(p);
    }
    report();
    process.exit(0);
  })();
} else {
const timers = [
  every(2000, "/company/panel"),                    // old dashboard
  every(6000, "/company/sessions"),                 // v2 shell
  every(6000, "/company/flow?limit=30"),            // v2 shell + assistant view
  every(6000, "/company/budgets"),                  // v2 shell
  every(4000, "/health"),                           // v2 heartbeat
  every(6000, "/company/org"),                      // v2 office
  every(6000, "/company/agents"),                   // v2 office
  every(6000, "/company/panel"),                    // v2 projects (duplicate on purpose: same as live)
  every(6000, "/company/memory/status"),            // v2 memory
  every(3000, "/v2/"),                              // static
  every(3000, "/v2/app.js"),                        // static
  every(3000, "/v2/style.css"),                     // static
];

// Not unref'd on purpose: this timer is what keeps the replay alive while the
// (unref'd) interval timers fire.
setTimeout(() => {
  for (const t of timers) clearInterval(t);
  report();
  process.exit(0);
}, SECONDS * 1000);
}
