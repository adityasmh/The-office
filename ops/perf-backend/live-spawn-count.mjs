// PERF-BACKEND: count the child processes a LIVE process really spawns.
//
// The live CPU profile put 29,502 ms of a 60 s window inside
//   spawn <- run <- countRealTerminals <- fillSlots <- tickFleet
// and the per-spawn CreateProcess cost measured in-process was 29-52 ms, which
// IMPLIES hundreds of spawns per minute. This turns that inference into a measured
// number, from outside the target (no instrumentation, no restart): it polls the
// Windows process table every 2 s and records every distinct child PID whose
// ParentProcessId is the target.
//
// Usage: node ops/perf-backend/live-spawn-count.mjs --pid 25808 --seconds 60 [--interval 2000]
import { execFile } from "node:child_process";

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const PID = Number(arg("pid", "0"));
const SECONDS = Number(arg("seconds", "60"));
const INTERVAL = Number(arg("interval", "2000"));
if (!PID) {
  console.error("usage: node ops/perf-backend/live-spawn-count.mjs --pid <pid> [--seconds 60] [--interval 2000]");
  process.exit(2);
}

function ps(script) {
  return new Promise((resolve) => {
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 20000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout) => resolve(err ? "" : String(stdout)),
    );
  });
}

const QUERY = `Get-CimInstance Win32_Process -Filter "ParentProcessId=${PID}" | Select-Object ProcessId,Name,CreationDate | ConvertTo-Json -Compress`;

const seen = new Map(); // pid -> name
const byName = new Map();
const started = Date.now();
let polls = 0;

console.log(`# counting children of pid ${PID} for ${SECONDS}s (poll every ${INTERVAL} ms, no instrumentation)`);
while (Date.now() - started < SECONDS * 1000) {
  const raw = await ps(QUERY);
  polls++;
  let rows = [];
  try {
    const parsed = JSON.parse((raw.trim() || "[]").replace(/^\uFEFF/, ""));
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    rows = [];
  }
  let fresh = 0;
  for (const r of rows) {
    const id = Number(r.ProcessId);
    const name = String(r.Name ?? "?");
    if (!id || seen.has(id)) continue;
    seen.set(id, name);
    byName.set(name, (byName.get(name) ?? 0) + 1);
    fresh++;
  }
  if (fresh) console.log(`  +${String(fresh).padStart(3)} new child${fresh === 1 ? "" : "ren"}  (total ${seen.size})`);
  await new Promise((r) => setTimeout(r, INTERVAL));
}

const elapsed = (Date.now() - started) / 1000;
console.log("");
console.log(`# children observed over ${elapsed.toFixed(0)}s in ${polls} polls: ${seen.size} distinct PIDs`);
console.log(`# rate: ${(seen.size / (elapsed / 60)).toFixed(0)} child processes per minute`);
for (const [name, n] of [...byName.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`#   ${name.padEnd(20)} ${n}`);
}
console.log("# NOTE: children that start AND exit inside one poll window are invisible to a 2 s poll, so this is a LOWER BOUND.");
