/**
 * ops/fleet-deliver-probe.ts — prove the fleet's order-delivery mechanism.
 *
 * docs/FLEET_SPEC.md asked FLEET-BACKEND to investigate a TARGETED way to put an
 * order into one specific jcode session before falling back to the focus-based
 * method. This script runs that investigation as a reproducible test:
 *
 *   1. opens one real VISIBLE PowerShell window running `jcode -p opencode-go`
 *      (in a throwaway repo, so the probe agent can never touch this project),
 *   2. identifies the jcode session that belongs to that window,
 *   3. delivers a probe instruction into THAT session,
 *   4. verifies the instruction really landed there (and only there), by reading
 *      the session's own stored history.
 *
 * It runs against a throwaway COMPANY_ROOT + FLEET_REPO and never contacts the
 * live company/ or the router on :8787.
 *
 *   npx tsx ops/fleet-deliver-probe.ts [--keep] [--repo <dir>] [--model <id>]
 *
 * `--repo` points the probe at a given directory (default: a throwaway temp dir).
 * Use it to reproduce path-with-spaces bugs, e.g. --repo "$env:TEMP\probe dir with spaces":
 * Start-Process does not quote -ArgumentList array elements, so an unquoted launcher
 * path silently killed the worker window before jcode started (found this way).
 *
 * --keep leaves the probe window open (default: it is closed and its session
 * state is left in %USERPROFILE%\.jcode, which this script never writes to).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const keep = process.argv.includes("--keep");
// --model <id>: spawn with `-m <id>` and report what the session ACTUALLY runs
// (Fix 1 verification: jcode must switch model, not keep the provider default).
const modelIdx = process.argv.indexOf("--model");
const modelArg = modelIdx >= 0 ? process.argv[modelIdx + 1] : "";
const repoArgIdx = process.argv.indexOf("--repo");
const repoArg = repoArgIdx >= 0 ? process.argv[repoArgIdx + 1] : "";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-deliver-probe-"));
// NOTE: these two directory names deliberately contain a SPACE. A launcher path
// with a space is what broke delivery in the real repo (see the header), so every
// probe run now exercises it.
const repo = repoArg ? path.resolve(repoArg) : path.join(tmp, "probe repo");
fs.mkdirSync(repo, { recursive: true });
if (!fs.existsSync(path.join(repo, "README.md"))) fs.writeFileSync(path.join(repo, "README.md"), "# throwaway probe repo\n");

// Throwaway roots: the live company/ and this repo are never touched.
// "probe company" has a space on purpose (see above).
process.env.COMPANY_ROOT = path.join(tmp, "probe company");
process.env.FLEET_REPO = repo;
process.env.FLEET_SPAWN_DETECT_MS = process.env.FLEET_SPAWN_DETECT_MS ?? "90000";

const fleet = await import("../src/company/fleet.js");

const marker = `FLEET-PROBE ${Date.now().toString(36)}`;
const text = [
  `${marker}`,
  "",
  "This is an automated delivery probe. Do not edit any files.",
  "Reply with the single word: ACK. Then stop.",
].join("\n");

console.log(`[probe] throwaway COMPANY_ROOT=${process.env.COMPANY_ROOT}`);
console.log(`[probe] throwaway FLEET_REPO=${repo}`);
console.log(`[probe] marker=${marker}`);
console.log("[probe] spawning one visible terminal and delivering into it...");

const result = await fleet.probeDelivery({ orderId: "probe", wid: "WO-PROBE", text, marker, ...(modelArg ? { model: modelArg } : {}) });

console.log("");
console.log(`[probe] window pid     : ${result.windowPid}`);
console.log(`[probe] session id     : ${result.sessionId || "(none)"}`);
console.log(`[probe] window match   : ${result.match}`);
if (modelArg) {
  console.log(`[probe] model asked for: ${modelArg}`);
  console.log(`[probe] session model  : ${result.sessionModel ?? "(session reports none)"}`);
}
console.log(`[probe] delivery       : ok=${result.delivery.ok} how=${result.delivery.how}`);
console.log(`[probe] delivery detail: ${result.delivery.detail}`);
console.log(`[probe] marker in session history: ${result.confirmed}`);
console.log(`[probe] session tail   :`);
for (const line of result.tail) console.log(`    | ${line}`);

// Negative control: the marker must NOT be in some other live session.
const others = [...fleet.liveClientSessions().keys()].filter((s) => s !== result.sessionId);
const leaks = others.filter((s) => fleet.sessionHasMarker(s, marker));
console.log(`[probe] other live sessions checked (marker must be absent): ${others.length}; leaks=${leaks.length}`);
if (leaks.length) console.log(`[probe] LEAKED INTO: ${leaks.join(", ")}`);

if (!keep && result.windowPid) {
  spawnSync("taskkill", ["/PID", String(result.windowPid), "/T", "/F"], { stdio: "ignore" });
  console.log(`[probe] closed probe window pid ${result.windowPid}`);
} else if (result.windowPid) {
  console.log(`[probe] leaving probe window pid ${result.windowPid} open (--keep)`);
}

const ok = result.delivery.ok && result.confirmed && leaks.length === 0 && (!modelArg || result.sessionModel === modelArg);
console.log("");
console.log(`[probe] RESULT: ${ok ? "PASS" : "FAIL"} (targeted delivery ${result.delivery.how})`);
process.exit(ok ? 0 : 1);
