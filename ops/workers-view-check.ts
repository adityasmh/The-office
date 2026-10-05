/**
 * ops/workers-view-check.ts — acceptance checks for src/company/workersView.ts
 * (WORKERS-LIVE, 2026-10-06).
 *
 * Run: npx tsx ops/workers-view-check.ts
 *
 * What it proves (doc: docs/ORDER_2026-10-06_workers-live.md, "Proof"):
 *   1. a registry row whose pid is alive (this process) and has no ledger line is
 *      `running`; a row with a ledger line `killed:repeat-line x6` is `killed`;
 *      malformed registry/ledger lines are skipped, not fatal;
 *   2. `recent` is newest first and capped at 15;
 *   3. `workerTail` joins a run of thought-marker lines into ONE readable line,
 *      strips ANSI, honours the line count, and caps the 8 KB size;
 *   4. `workerTail("../x")`, `workerTail("a/b")` and an empty name are rejected;
 *   5. a missing log returns a not-found result instead of crashing.
 *
 * Safety: everything happens in a fresh temp directory with fake files. No
 * network, no server, no router, no real worker, no write outside the temp dir.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { THOUGHT_MARKER, listWorkers, workerTail } from "../src/company/workersView.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "workers-view-check-"));
const logs = path.join(tmp, "logs");
fs.mkdirSync(logs, { recursive: true });

let checks = 0;
let failures = 0;

function ok(name: string, cond: boolean, detail = "") {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${detail ? `  [${detail}]` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${detail ? `  [${detail}]` : ""}`);
  }
}

function row(o: Record<string, unknown>): string {
  return JSON.stringify(o) + "\r\n";
}

const iso = (agoSec: number) => new Date(Date.now() - agoSec * 1000).toISOString();

// ── fake registry: an alive row, a row that already ended, a dead row ────────
const registry =
  row({
    name: "alive-one",
    pid: process.pid, // this check's own process: guaranteed alive
    log: path.join(logs, "jcode-alive-one-20261006.log"),
    startedAt: iso(90),
    maxMinutes: 15,
    maxUsd: 0.3,
    creationTime: iso(90),
    provider: "deepseek",
    model: "deepseek-flash",
  }) +
  row({
    name: "kill-one",
    pid: 999999, // no such pid: it must not be reported live
    log: path.join(logs, "jcode-kill-one-20261006.log"),
    startedAt: iso(600),
    maxMinutes: 20,
    maxUsd: 0.4,
    creationTime: iso(600),
  }) +
  row({ name: "ghost-one", pid: 999998, log: "irrelevant", startedAt: iso(600), maxMinutes: 15, maxUsd: 0.3 }) +
  "{ this line is not json at all\r\n" +
  "\r\n";
fs.writeFileSync(path.join(logs, "workers.json"), registry, "utf8");

// ── fake ledger: 20 filler rows, then kill-one as the newest entry ───────────
let ledger = "";
for (let i = 1; i <= 20; i += 1) {
  ledger += row({ date: "2026-10-06", name: `filler-${i}`, turns: i, estUsd: 0.001 * i, endedBy: "finished" });
}
ledger += "not json either\r\n";
ledger += row({ date: "2026-10-06", name: "kill-one", turns: 81, estUsd: 0.2144, endedBy: "killed:repeat-line x6" });
fs.writeFileSync(path.join(logs, "token-ledger.jsonl"), ledger, "utf8");

// ── fake worker logs ─────────────────────────────────────────────────────────
const ESC = "\u001B";
// Exactly how jcode streams a thought: marker + ONE space for the first fragment,
// marker + TWO spaces for the rest, and the fragment text itself carries no space.
const thoughtRun = ["Let", "me", "look", "at", "the", "fleet.ts", "file", ",", "specifically", "cheapPlan", "."];
const workerLog =
  `${ESC}[32mI'll start by reading the work order.${ESC}[0m\n` +
  "\n" +
  "[read] docs\\ORDER_2026-10-06_workers-live.md\n" +
  "\n" +
  thoughtRun.map((piece, i) => `${THOUGHT_MARKER}${i === 0 ? " " : "  "}${piece}`).join("\n") +
  "\n" +
  "[bash] echo hi\n";
fs.writeFileSync(path.join(logs, "jcode-alive-one-20261006.log"), workerLog, "utf8");
// 600 medium lines ~ 24 KB: proves the 8 KB cap bites.
fs.writeFileSync(
  path.join(logs, "jcode-biglog-20261006.log"),
  Array.from({ length: 600 }, (_, i) => `line ${i} ${"x".repeat(36)}`).join("\n") + "\n",
  "utf8",
);

// ── 1. live / killed / malformed ─────────────────────────────────────────────
const view = listWorkers(logs);
const liveNames = view.live.map((w) => w.name);
const alive = view.live.find((w) => w.name === "alive-one");
ok("alive pid + no ledger line is running", !!alive && alive.status === "running", liveNames.join(","));
ok("provider/model surface on a live worker", !!alive && alive.provider === "deepseek" && alive.model === "deepseek-flash");
ok("alive elapsed is counted from startedAt", !!alive && alive.elapsedSec >= 89 && alive.elapsedSec <= 95);
ok("dead pid is not live", !liveNames.includes("ghost-one"));
ok("a run with a ledger line is not live", !liveNames.includes("kill-one"));

const killed = view.recent.find((w) => w.name === "kill-one");
ok("ledger endedBy killed:... is status killed", !!killed && killed.status === "killed", killed ? killed.status : "missing");
ok("killed keeps the reason and the numbers", !!killed && killed.endedBy === "killed:repeat-line x6" && killed.turns === 81 && killed.estUsd === 0.2144);
ok("malformed registry/ledger lines are skipped", view.recent.length === 15 && !view.recent.some((w) => /not json/.test(w.name)));

// ── 2. recent: newest first, capped at 15 ────────────────────────────────────
ok("recent is capped at 15", view.recent.length === 15, `len=${view.recent.length}`);
ok("recent is newest first (kill-one, then filler-20)", view.recent[0]?.name === "kill-one" && view.recent[1]?.name === "filler-20", view.recent.map((w) => w.name).join(","));
ok("recent keeps descending order", view.recent[2]?.name === "filler-19" && view.recent[14]?.name === "filler-7");
ok("recent joins the registry row by name when present", !!killed && killed.maxMinutes === 20 && killed.maxUsd === 0.4);

// ── 3. workerTail: thought run joined, ANSI stripped, caps honoured ──────────
const tail = workerTail("alive-one", 40, logs);
const joined = "Let me look at the fleet.ts file, specifically cheapPlan.";
ok("tail reads the worker's log", tail.lines.length === 4, `lines=${tail.lines.length}: ${JSON.stringify(tail.lines)}`);
ok("thought run is joined into one readable line", tail.lines[2] === joined, JSON.stringify(tail.lines[2]));
ok("ANSI escapes are stripped", !tail.lines.some((l) => l.includes(ESC)), JSON.stringify(tail.lines[0]));
ok("tail is chronological (newest last)", tail.lines[tail.lines.length - 1] === "[bash] echo hi");
ok("tail honours the requested line count", workerTail("alive-one", 1, logs).lines.length === 1);

const big = workerTail("biglog", 400, logs);
const bigBytes = Buffer.byteLength(big.lines.join("\n"), "utf8");
ok("tail caps the size at 8 KB", bigBytes <= 8 * 1024 && big.lines.length > 0, `${big.lines.length} lines / ${bigBytes} bytes`);
ok("tail keeps the newest line after the cap", big.lines[big.lines.length - 1] === `line 599 ${"x".repeat(36)}`);

// ── 4. bad names are rejected ────────────────────────────────────────────────
function rejected(name: string): boolean {
  try {
    workerTail(name, 40, logs);
    return false;
  } catch {
    return true;
  }
}
ok('workerTail("../x") is rejected', rejected("../x"));
ok('workerTail("a/b") is rejected', rejected("a/b"));
ok("workerTail(\"\") is rejected", rejected(""));

// ── 5. a missing log is a not-found result, not a crash ──────────────────────
let missing: ReturnType<typeof workerTail> | null = null;
let crashed = false;
try {
  missing = workerTail("nosuchworker", 40, logs);
} catch {
  crashed = true;
}
ok("missing log returns a not-found result", !crashed && !!missing && missing.lines.length === 0 && !!missing.error, missing ? String(missing.error) : "threw");
ok("missing file on disk is not a crash for the list either", (() => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "workers-view-empty-"));
  const v = listWorkers(empty);
  fs.rmSync(empty, { recursive: true, force: true });
  return v.live.length === 0 && v.recent.length === 0;
})());

console.log(`\nworkers-view-check: ${checks - failures}/${checks} passed (logs=${logs})`);
if (failures > 0) process.exitCode = 1;
