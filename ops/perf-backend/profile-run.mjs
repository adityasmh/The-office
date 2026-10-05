// PERF-BACKEND profiler harness (2026-09-29).
//
// `node --cpu-prof` only writes its .cpuprofile on a GRACEFUL exit, and a Windows
// TerminateProcess (Stop-Process -Force) skips that, so the profile of a test
// server that is force-stopped is silently lost. This harness takes the profile
// from inside the process instead: it starts V8's sampling profiler via
// node:inspector, boots the real src/server.ts in THIS process against a temp
// COMPANY_ROOT, replays the dashboard polling with the same harness used for the
// before/after latency tables, then stops the profiler and writes the .cpuprofile.
//
// Usage:
//   node --import tsx ops/perf-backend/profile-run.mjs --label before --port 8801 --seconds 45
//   node --import tsx ops/perf-backend/profile-run.mjs --label after  --port 8802 --seconds 45
//
// Safety: refuses to run unless COMPANY_ROOT points at the temp copy, binds
// 127.0.0.1 on the given port, disables the Slack bridge, and sets MOCK_MODE=1.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import inspector from "node:inspector";

const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const LABEL = arg("label", "profile");
const PORT = Number(arg("port", "8801"));
const SECONDS = Number(arg("seconds", "45"));
const COMPANY_ROOT = process.env.COMPANY_ROOT ?? path.join(process.env.TEMP ?? "/tmp", "jcode-perfbe", "company");
const OUT = path.join("logs", "cpuprof-be", `${LABEL}.cpuprofile`);
const BASE = `http://127.0.0.1:${PORT}`;

if (!COMPANY_ROOT.includes("jcode-perfbe")) {
  console.error(`refusing: COMPANY_ROOT must be the temp copy, got ${COMPANY_ROOT}`);
  process.exit(2);
}
if (!fs.existsSync(path.join(COMPANY_ROOT, "org.json"))) {
  console.error(`refusing: ${COMPANY_ROOT} has no org.json - run ops/perf-backend/make-testroot.ps1 first`);
  process.exit(2);
}

process.env.PORT = String(PORT);
process.env.HOST = "127.0.0.1";
process.env.COMPANY_ROOT = COMPANY_ROOT;
process.env.SLACK_BRIDGE = "0";
process.env.SLACK_SOCKET_MODE = "0";
process.env.MOCK_MODE = "1";
process.env.COMPANY_AUTH_TOKEN = "perf-backend-test-token";

const session = new inspector.Session();
session.connect();
const post = (method, params) => new Promise((res, rej) => session.post(method, params ?? {}, (e, r) => (e ? rej(e) : res(r))));

await post("Profiler.enable");
await post("Profiler.setSamplingInterval", { interval: 500 }); // 0.5 ms
await post("Profiler.start");

console.log(`# profiling ${LABEL}: port ${PORT}, company root ${COMPANY_ROOT}`);
await import("../../src/server.ts");
console.log("# server module loaded; waiting for /health");

for (let i = 0; i < 100; i++) {
  try {
    const r = await fetch(`${BASE}/health`);
    if (r.ok) break;
  } catch {
    /* not listening yet */
  }
  await new Promise((r) => setTimeout(r, 200));
}

console.log(`# replaying dashboard polling for ${SECONDS}s`);
const replay = spawn(
  process.execPath,
  ["ops/perf-backend/replay.mjs", "--base", BASE, "--seconds", String(SECONDS), "--label", LABEL],
  { stdio: ["ignore", "inherit", "inherit"] },
);
await new Promise((res) => replay.on("exit", res));

const { profile } = await post("Profiler.stop");
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(profile));
const cpuMs = (profile.endTime - profile.startTime) / 1000;
console.log(`# wrote ${OUT} (${fs.statSync(OUT).size} bytes, ${profile.samples.length} samples, wall ${cpuMs.toFixed(0)} ms)`);
process.exit(0);
