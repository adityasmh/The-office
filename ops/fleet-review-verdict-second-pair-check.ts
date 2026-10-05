/**
 * ops/fleet-review-verdict-second-pair-check.ts — attack the review PASS for FIXTURE LUCK.
 *
 * `ops/fleet-review-verdict-check.ts` repeats the SAME good/bad pair three times, so it can only
 * prove the verdict is stable FOR THAT PAIR. If the pair happened to be easy (or the reviewer
 * keyed on something incidental), a different pair could tell a different story.
 *
 * This runs a DELIBERATELY DIFFERENT pair: different route names, different deliverable type
 * (a shell script rather than a markdown guide), different evidence commands.
 *
 *   npx tsx ops/fleet-review-verdict-second-pair-check.ts
 */
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-pair2-"));
process.env.COMPANY_ROOT = path.join(tmp, "company");
process.env.FLEET_REPO = path.join(tmp, "repo");
process.env.MOCK_MODE = "0";
process.env.FLEET_AUTO_APPROVE = "0";
process.env.FLEET_FALLBACK_MODELS = "deepseek-v4.1-flash,kimi-k2.7-code";
process.env.FLEET_WATCH_INTERVAL_MS = "600000";
// A different stage-of-day: no Laya dependency change, just a distinct reviewer input.
fs.mkdirSync(path.join(process.env.FLEET_REPO!, "scripts"), { recursive: true });

const binDir = path.join(tmp, "bin");
fs.mkdirSync(binDir, { recursive: true });
const payload = JSON.stringify({ type: "result", is_error: true, result: "Failed to authenticate: OAuth session expired and could not be refreshed" });
const claudeExe = path.join(binDir, process.platform === "win32" ? "claude.exe" : "claude");
if (process.platform === "win32") {
  const src = path.join(tmp, "bad.cs");
  fs.writeFileSync(src, ["public class Program {", "  public static int Main(string[] a) {", `    System.Console.WriteLine(${JSON.stringify(payload)});`, "    return 1;", "  }", "}"].join("\n"));
  const { execFileSync } = await import("node:child_process");
  execFileSync(path.join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"), ["/nologo", `/out:${claudeExe}`, src], { stdio: "inherit" });
}
process.env.CLAUDE_BIN = claudeExe;

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
};

const fleet = await import("../src/company/fleet.js");
const companyRoot = process.env.COMPANY_ROOT!;
const repo = process.env.FLEET_REPO!;

// GOOD: a real, small, self-verifying shell script.
const goodRel = "scripts/fleet_check.sh";
const script = [
  "#!/bin/sh",
  "# Read-only health check for the six fleet routes. Never writes anything.",
  "BASE=\"${1:-http://127.0.0.1:8787}\"",
  "fails=0",
  "check() { # name url",
  "  code=$(curl -s -o /dev/null -w '%{http_code}' \"$2\")",
  "  if [ \"$code\" = \"200\" ] || [ \"$code\" = \"401\" ]; then echo \"PASS $1 ($code)\"; else echo \"FAIL $1 ($code)\"; fails=$((fails+1)); fi",
  "}",
  "check \"orders\"  \"$BASE/company/fleet/orders\"",
  "check \"detail\"  \"$BASE/company/fleet/orders/none\"",
  "check \"approve\" \"$BASE/company/fleet/orders/none/approve\"",
  "check \"cancel\"  \"$BASE/company/fleet/orders/none/cancel\"",
  "check \"tick\"    \"$BASE/company/fleet/tick\"",
  "check \"status\"  \"$BASE/company/fleet/status\"",
  "[ \"$fails\" = \"0\" ] && echo \"ALL ROUTES OK\" || echo \"$fails ROUTE(S) FAILED\"",
  "exit $([ \"$fails\" = \"0\" ] && echo 0 || echo 1)",
].join("\n");
fs.writeFileSync(path.join(repo, goodRel), script);

const goodId = "foPair2Good";
const badId = "foPair2Bad";
const wid = "WO1";
const nowIso = new Date().toISOString();
const mk = (id: string) => ({
  id,
  text: "GOAL: write a read-only health check script for the six fleet routes.",
  createdAt: nowIso,
  updatedAt: nowIso,
  status: "running",
  plan: "one work order",
  workOrders: [{ id: wid, title: "Write the fleet health check script", role: "docs", owns: [goodRel], brief: "Write the script.", done: ["the script exists and is read-only"], state: "reported", attempts: 0, startedAt: nowIso }],
  trace: [{ ts: nowIso, from: "CEO", to: "Claude (manager)", what: "order", detail: "GOAL: write a read-only health check script..." }],
});

fs.mkdirSync(path.join(companyRoot, "fleet", goodId, wid), { recursive: true });
fs.writeFileSync(
  path.join(companyRoot, "fleet", goodId, wid, "REPORT.md"),
  [
    "# REPORT",
    "## What I did",
    `Wrote ${goodRel}: one "check" helper and six calls, one per route. It only issues GETs and a curled HEAD-style status read; it writes no files and mutates no state.`,
    "## How I verified (real output)",
    "```",
    "$ sh -n scripts/fleet_check.sh && echo SYNTAX_OK",
    "SYNTAX_OK",
    "$ grep -c 'check \"' scripts/fleet_check.sh",
    "6",
    "$ grep -nE 'curl (-X (POST|PUT|DELETE)|--data)' scripts/fleet_check.sh || echo NO_WRITE_CALLS",
    "NO_WRITE_CALLS",
    "$ sh scripts/fleet_check.sh http://127.0.0.1:8787; echo exit=$?",
    "FAIL orders (000)",
    "1 ROUTE(S) FAILED",
    "exit=1",
    "```",
    "## Acceptance checks",
    "- The script exists and is non-empty: `sh -n` reports SYNTAX_OK above.",
    "- It checks all six routes: `grep -c` above returns 6.",
    "- It is read-only: the `grep -nE` above found no POST/PUT/DELETE or payload flags.",
    "- It reports pass/fail and exits non-zero on failure: the real run above exited 1 and printed the failing route.",
    "- Honest limit: the fleet service was not running during this run, so every route reported 000 - I am not claiming the routes work, only that the script behaves correctly when they do not.",
  ].join("\n"),
);

fs.mkdirSync(path.join(companyRoot, "fleet", badId, wid), { recursive: true });
fs.writeFileSync(path.join(companyRoot, "fleet", badId, wid, "REPORT.md"), [
  "# REPORT",
  "Wrote the script. It is read-only and checks all six routes.",
  "Tested it and everything passes.",
].join("\n"));

fs.writeFileSync(path.join(companyRoot, "fleet", "orders.json"), JSON.stringify([mk(goodId), mk(badId)], null, 2));

console.log("[pair2] driving the SHIPPED tickFleet() on a DIFFERENT good/bad pair");
const res = await fleet.tickFleet();
console.log(`[pair2] tickFleet -> ${JSON.stringify(res)}`);
const good = fleet.getFleetOrder(goodId)!.workOrders[0]!;
const bad = fleet.getFleetOrder(badId)!.workOrders[0]!;
console.log(`[pair2] GOOD: state=${good.state} verdict=${good.verdict} notes=${String(good.review ?? "").length}`);
console.log(`[pair2] BAD : state=${bad.state} verdict=${bad.verdict} notes=${String(bad.review ?? "").length}`);
console.log(`[pair2] GOOD notes (first 220): ${JSON.stringify(String(good.review ?? "").slice(0, 220))}`);

check("both were reviewed", good.state === "reviewed" && bad.state === "reviewed", `${good.state}/${bad.state}`);
check("the stub script was not passed", bad.verdict === "REDO", String(bad.verdict));
check("the SECOND pair also discriminates: the good script was passed", good.verdict === "PASS", `good=${good.verdict} bad=${bad.verdict}`);
check("the PASS is justified with real notes", String(good.review ?? "").length > 40, `${String(good.review ?? "").length} chars`);

console.log(`\n[pair2] ${failures ? `${failures} FAILED` : "ALL CHECKS PASSED"} (temp dir ${tmp})`);
process.exit(failures ? 1 : 0);
