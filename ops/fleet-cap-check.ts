/**
 * ops/fleet-cap-check.ts - proof for the CEO order "Cap + spam" (2026-09-30).
 *
 * Three claims, each checked against the REAL modules (no copied logic):
 *   1. Without a CEO-set budget cap, the effective Fleet parallelism is exactly
 *      MAX_PARALLEL_SESSIONS (30), at Go amber AND at Go red. The old code returned 10/3.
 *   2. When the CEO DOES set BUDGET_FLEET_MAX_PARALLEL_AMBER / _RED, the cap applies and the
 *      reason is shown ONCE (a repeat call does not re-log it).
 *   3. The "not spawning" warning is logged once per state change, else at most once per
 *      10 minutes (synthetic clock).
 *   4. The live real-terminal count excludes FINISHED terminals whose pid Windows reused:
 *      it equals the number of pids the process table proves are live jcode TUI clients,
 *      and is <= the raw client_sessions pid-file count.
 *
 * Read-only: spawns nothing itself (it only asks the shared process-table cache to refresh),
 * writes no state, closes nothing.
 *
 *   npx tsx ops/fleet-cap-check.ts
 *   npx tsx ops/fleet-cap-check.ts --json
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const budget = await import("../src/company/budgetGuard.js");
const fleet = await import("../src/company/fleet.js");
const reaper = await import("../src/company/terminalReaper.js");

const json = process.argv.includes("--json");
const results: Array<{ label: string; ok: boolean; detail: string }> = [];
function check(label: string, ok: boolean, detail = ""): void {
  results.push({ label, ok, detail });
  if (!json) console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? `  -> ${detail}` : ""}`);
}

// ── capture console.warn so "logged once" is observable ─────────────────
const warns: string[] = [];
const realWarn = console.warn;
console.warn = (...args: unknown[]) => {
  warns.push(args.map((a) => String(a)).join(" "));
};

const AMBER = "BUDGET_FLEET_MAX_PARALLEL_AMBER";
const RED = "BUDGET_FLEET_MAX_PARALLEL_RED";
const savedAmber = process.env[AMBER];
const savedRed = process.env[RED];
delete process.env[AMBER];
delete process.env[RED];

type Snap = NonNullable<Parameters<typeof budget.fleetMaxParallel>[1]>;
/** A minimal snapshot that carries only the rule under test (fleetMaxParallel reads rules.go). */
const snapWith = (go: ReturnType<typeof budget.rulesFor>["go"]): Snap =>
  ({
    version: 1,
    levels: { go: go.level, claude: "green" },
    rules: { go, claude: budget.rulesFor("green", "green").claude },
  }) as unknown as Snap;

const live = budget.readBudgetState();
const machineLimit = Number(process.env.MAX_PARALLEL_SESSIONS ?? 30);

if (!json) {
  console.log(`# live OpenCode Go level: ${live?.levels.go ?? "unknown"} | MAX_PARALLEL_SESSIONS=${machineLimit}`);
  console.log("");
  console.log("== 1. no CEO budget cap set (the shipped default) ==");
}
budget.resetFleetCapNotice();
warns.length = 0;

const amberRules = budget.rulesFor("amber", "green");
check(
  "rulesFor('amber') carries NO budget cap",
  amberRules.go.fleetMaxParallel === undefined,
  `fleetMaxParallel=${String(amberRules.go.fleetMaxParallel)}`,
);
check(
  `fleetMaxParallel(${machineLimit}) === ${machineLimit} at Go amber (no clamp)`,
  budget.fleetMaxParallel(machineLimit, snapWith(amberRules.go)) === machineLimit,
  `got ${budget.fleetMaxParallel(machineLimit, snapWith(amberRules.go))}`,
);

const redRules = budget.rulesFor("red", "red");
check(
  "rulesFor('red') carries NO budget cap",
  redRules.go.fleetMaxParallel === undefined,
  `fleetMaxParallel=${String(redRules.go.fleetMaxParallel)}`,
);
check(
  `fleetMaxParallel(${machineLimit}) === ${machineLimit} at Go red (no clamp)`,
  budget.fleetMaxParallel(machineLimit, snapWith(redRules.go)) === machineLimit,
);
check("no clamp reason was logged (nothing to explain)", warns.length === 0 && budget.fleetMaxParallelNotice() === "", warns[0] ?? "");

if (!json) console.log("\n== 2. the CEO sets the cap explicitly ==");
process.env[AMBER] = "12";
budget.resetFleetCapNotice();
warns.length = 0;
const amberCapped = budget.rulesFor("amber", "green");
check("rulesFor('amber') carries the CEO cap", amberCapped.go.fleetMaxParallel === 12, `fleetMaxParallel=${String(amberCapped.go.fleetMaxParallel)}`);
const capped = budget.fleetMaxParallel(machineLimit, snapWith(amberCapped.go));
check(`fleetMaxParallel(${machineLimit}) === 12 with ${AMBER}=12`, capped === 12, `got ${capped}`);
check("the reason was shown exactly once", warns.length === 1, warns[0] ?? "");
budget.fleetMaxParallel(machineLimit, snapWith(amberCapped.go));
budget.fleetMaxParallel(machineLimit, snapWith(amberCapped.go));
check("repeat calls do NOT re-log the same reason", warns.length === 1, `warns=${warns.length}`);
delete process.env[AMBER];

if (!json) console.log("\n== 3. the 'not spawning' warning is throttled ==");
fleet.resetWarnThrottle();
warns.length = 0;
const TEN_MIN = 10 * 60_000;
fleet.warnThrottled("terminal-cap", "same state", 0);
fleet.warnThrottled("terminal-cap", "same state", 1_000);
fleet.warnThrottled("terminal-cap", "same state", TEN_MIN - 1);
check("identical warning => 1 line (not 1 per tick)", warns.length === 1, `warns=${warns.length}`);
fleet.warnThrottled("terminal-cap", "same state", TEN_MIN);
check("unchanged warning re-logs after 10 min", warns.length === 2, `warns=${warns.length}`);
fleet.warnThrottled("terminal-cap", "18 real terminals >= MAX_PARALLEL_SESSIONS=30", TEN_MIN + 1_000);
check("a state change logs immediately", warns.length === 3, `warns=${warns.length}`);

if (!json) console.log("\n== 4. the live real-terminal count (finished terminals excluded) ==");
// raw: every client_sessions/<pid> file whose pid is alive (the OLD rule)
const csDir = path.join(os.homedir(), ".jcode", "client_sessions");
const rawAlive: number[] = [];
try {
  for (const name of fs.readdirSync(csDir)) {
    const pid = Number(name);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    try {
      process.kill(pid, 0);
      rawAlive.push(pid);
    } catch {
      // dead pid
    }
  }
} catch {
  // no dir
}

// verified: the same rule the fix uses, computed here from an independent fresh table
const table = await reaper.snapshotProcessesAsync(true);
let verified = 0;
const phantom: string[] = [];
const liveNames: string[] = [];
for (const pid of rawAlive) {
  const row = table.get(pid);
  const cmd = (row?.cmd ?? "").toLowerCase();
  const isTui = !!row && /^jcode(\.exe)?$/i.test(row.name) && !/\bserve\b/.test(cmd) && !/keepalive/.test(cmd) && !/setup-hotkey/.test(cmd);
  if (isTui) verified++;
  else phantom.push(`${pid} ${row?.name ?? "gone"}`);
}

const count = await fleet.countRealTerminals(true);
check(
  `count.jcodeTerminals (${count.jcodeTerminals}) === verified live jcode TUI clients (${verified})`,
  count.jcodeTerminals === verified,
);
check(
  `count.jcodeTerminals (${count.jcodeTerminals}) <= raw alive pid files (${rawAlive.length})`,
  count.jcodeTerminals <= rawAlive.length,
  `excluded ${rawAlive.length - count.jcodeTerminals} finished/reused pid(s)`,
);
check(
  `count.maxParallel (${count.maxParallel}) === MAX_PARALLEL_SESSIONS=${machineLimit}`,
  count.maxParallel === machineLimit,
);
if (!json) {
  console.log(`# source: ${count.source}`);
  console.log(`# phantom pid files (finished terminal, pid reused by another program): ${phantom.length ? phantom.join(", ") : "none"}`);
  console.log(`# headroom: ${count.headroom} of ${count.maxParallel} (jcode ${count.jcodeTerminals} + opencode ${count.opencodeWorkers} = ${count.total})`);
  for (const r of reaper.listTerminals(table).filter((r) => r.spawnedBy === "fleet" || r.spawnedBy === "claude-code")) {
    liveNames.push(`${r.sessionName || r.sessionId} [${r.spawnedBy}] state=${r.state} idle=${r.idleSeconds ?? "?"}s`);
  }
  console.log(`# registered fleet/claude-code terminals (close candidates, the reaper decides): ${liveNames.length}`);
  for (const n of liveNames) console.log(`#   ${n}`);
}

// ── restore ────────────────────────────────────────────────────────────
console.warn = realWarn;
if (savedAmber === undefined) delete process.env[AMBER];
else process.env[AMBER] = savedAmber;
if (savedRed === undefined) delete process.env[RED];
else process.env[RED] = savedRed;

const failed = results.filter((r) => !r.ok);
if (json) {
  console.log(JSON.stringify({ machineLimit, live: live?.levels.go ?? "unknown", count, phantom, results }, null, 2));
} else {
  console.log(`\n${failed.length === 0 ? "ALL CHECKS PASSED" : `${failed.length} CHECK(S) FAILED`} (${results.length} total)`);
}
process.exit(failed.length === 0 ? 0 : 1);
