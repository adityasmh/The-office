// PERF-BACKEND live profiler (2026-09-29, manager's order).
//
// Profiles a RUNNING router WITHOUT restarting it:
//   1. `process._debugProcess(<pid>)` opens the inspector on that process (Windows
//      supported, loopback only, port 9229);
//   2. this script talks Chrome DevTools Protocol to it - using Node's BUILT-IN
//      WebSocket (Node >= 22), so no new npm dependency;
//   3. it installs a small event-loop-lag monitor inside the target (a 250 ms
//      interval measuring its own scheduling drift, unref'd), samples it while the
//      CPU profiler runs, and removes it again;
//   4. it stops the profiler, writes logs/cpuprof-be/<label>.cpuprofile, prints the
//      in-process lag stats + memory, and closes the inspector.
//
// It also makes a few SEQUENTIAL read-only HTTP probes of the live router so the
// profile has latency numbers next to it (no concurrency: the point is to measure
// the loop, not to add load).
//
// Usage:
//   node ops/perf-backend/live-profile.mjs --pid 25808 --seconds 60 --label live-before
//   node ops/perf-backend/live-profile.mjs --pid 25808 --pid-check-only
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const PID = Number(arg("pid", "0"));
const SECONDS = Number(arg("seconds", "60"));
const LABEL = arg("label", "live");
const BASE = arg("base", "http://127.0.0.1:8787");
const PORT = Number(arg("debug-port", "9229"));
const OUT = path.join("logs", "cpuprof-be", `${LABEL}.cpuprofile`);
const LAG_READ_EVERY_S = 15;
const PROBE_EVERY_S = 5;

if (!PID) {
  console.error("usage: node ops/perf-backend/live-profile.mjs --pid <pid> [--seconds 60] [--label live-before]");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 1. open the inspector on the live process -----------------------------
console.log(`# attaching inspector to pid ${PID} (process._debugProcess)`);
try {
  execFileSync(process.execPath, ["-e", `process._debugProcess(${PID})`], { stdio: "pipe" });
} catch (e) {
  console.error(`refusing to continue: could not signal pid ${PID}: ${String(e)}`);
  process.exit(1);
}

// ---- 2. find the debugger URL ---------------------------------------------
let target = null;
for (let i = 0; i < 50; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = Array.isArray(list) ? list.find((t) => t.webSocketDebuggerUrl) : null;
    if (target) break;
  } catch {
    /* not listening yet */
  }
  await sleep(200);
}
if (!target) {
  console.error(`no inspector target on 127.0.0.1:${PORT}; is the pid still alive?`);
  process.exit(1);
}
console.log(`# target: ${target.title ?? "(no title)"} -> ${target.webSocketDebuggerUrl}`);

// ---- 3. CDP over the built-in WebSocket -----------------------------------
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", (e) => rej(new Error(`websocket error: ${String(e?.message ?? e)}`)), { once: true });
});
let msgId = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  let msg;
  try {
    msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
  } catch {
    return;
  }
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) rej(new Error(JSON.stringify(msg.error)));
    else res(msg.result);
  }
});
function send(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression, awaitPromise = false) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`evaluate failed: ${JSON.stringify(r.exceptionDetails.exception ?? r.exceptionDetails)}`);
  return r.result?.value;
}

await send("Profiler.enable");
await send("Profiler.setSamplingInterval", { interval: 500 });
await send("Profiler.start");
console.log("# profiler started (0.5 ms sampling)");

// ---- 4. in-process event-loop-lag monitor ---------------------------------
const LAG_INSTALL = `(() => {
  if (globalThis.__jcodeLag && globalThis.__jcodeLag.timer) return "already-installed";
  const mon = { samples: [], max: 0, started: Date.now(), timer: null };
  globalThis.__jcodeLag = mon;
  let expected = Date.now() + 250;
  mon.timer = setInterval(() => {
    const now = Date.now();
    const lag = Math.max(0, now - expected);
    if (lag > mon.max) mon.max = lag;
    mon.samples.push(lag);
    if (mon.samples.length > 2000) mon.samples.shift();
    expected = now + 250;
  }, 250);
  if (mon.timer.unref) mon.timer.unref();
  return "installed";
})()`;
const LAG_READ = `(() => {
  const m = globalThis.__jcodeLag;
  if (!m) return null;
  const s = [...m.samples].sort((a, b) => a - b);
  const pick = (p) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0);
  return { n: s.length, p50: pick(0.5), p95: pick(0.95), p99: pick(0.99), max: m.max, last: s.length ? s[s.length - 1] : 0, over50: s.filter((v) => v > 50).length, over500: s.filter((v) => v > 500).length };
})()`;

console.log(`# lag monitor: ${await evaluate(LAG_INSTALL)}`);
const mem0 = await evaluate(`({ rssMb: Math.round(process.memoryUsage().rss / 1048576), heapMb: Math.round(process.memoryUsage().heapUsed / 1048576), uptimeS: Math.round(process.uptime()) })`);
console.log(`# target memory at start: ${JSON.stringify(mem0)}`);

// ---- 5. run the window, sampling lag and probing the live router ----------
const probe = async (pathname) => {
  const t0 = performance.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(BASE + pathname, { signal: ctrl.signal });
    const buf = await res.arrayBuffer();
    clearTimeout(timer);
    return { ms: performance.now() - t0, status: res.status, bytes: buf.byteLength };
  } catch (e) {
    return { ms: performance.now() - t0, status: 0, bytes: 0, err: String(e?.cause?.code ?? e?.message ?? e).slice(0, 60) };
  }
};
const PROBES = ["/health", "/v2/style.css", "/company/panel?lite=1"];
const probeStats = new Map();
const started = Date.now();
let nextLag = started + LAG_READ_EVERY_S * 1000;
let nextProbe = started;

while (Date.now() - started < SECONDS * 1000) {
  const now = Date.now();
  if (now >= nextProbe) {
    nextProbe = now + PROBE_EVERY_S * 1000;
    for (const p of PROBES) {
      const r = await probe(p);
      const list = probeStats.get(p) ?? [];
      list.push(r);
      probeStats.set(p, list);
      console.log(`  probe ${String(Math.round((now - started) / 1000)).padStart(3)}s  ${r.ms.toFixed(0).padStart(6)} ms  HTTP ${r.status}  ${String(r.bytes).padStart(8)} B  ${p}${r.err ? `  (${r.err})` : ""}`);
    }
  }
  if (now >= nextLag) {
    nextLag = now + LAG_READ_EVERY_S * 1000;
    const lag = await evaluate(LAG_READ);
    console.log(`  lag   ${String(Math.round((now - started) / 1000)).padStart(3)}s  ${JSON.stringify(lag)}`);
  }
  await sleep(250);
}

// ---- 6. stop, remove the monitor, write the profile ----------------------
const { profile } = await send("Profiler.stop");
const lag = await evaluate(LAG_READ);
await evaluate(`(() => { const m = globalThis.__jcodeLag; if (m && m.timer) clearInterval(m.timer); delete globalThis.__jcodeLag; return "removed"; })()`);
const mem1 = await evaluate(`({ rssMb: Math.round(process.memoryUsage().rss / 1048576), heapMb: Math.round(process.memoryUsage().heapUsed / 1048576) })`);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(profile));
console.log("");
console.log(`# wrote ${OUT} (${fs.statSync(OUT).size} bytes, ${profile.samples.length} samples)`);
console.log(`# live event-loop lag (in-process, 250 ms interval drift): ${JSON.stringify(lag)}`);
console.log(`# target memory at end: ${JSON.stringify(mem1)}`);
console.log("# live HTTP probes (sequential, read-only):");
for (const [p, list] of probeStats) {
  const ms = list.map((r) => r.ms).sort((a, b) => a - b);
  const pick = (q) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))];
  console.log(`#   ${p.padEnd(26)} n=${list.length}  p50=${pick(0.5).toFixed(0)}ms  max=${Math.max(...ms).toFixed(0)}ms  errors=${list.filter((r) => !r.status || r.status >= 400).length}`);
}

// ---- 7. close the inspector ---------------------------------------------
try {
  const closed = await evaluate(`import("node:inspector").then((m) => { m.close(); return "inspector closed"; })`, true);
  console.log(`# ${closed}`);
} catch (e) {
  console.log(`# could not close the inspector from inside (${String(e).slice(0, 120)}) - it stays on 127.0.0.1:${PORT} until the process restarts`);
}
try {
  ws.close();
} catch {
  /* already gone */
}
process.exit(0);
