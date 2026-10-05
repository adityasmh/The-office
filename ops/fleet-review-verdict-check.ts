/**
 * ops/fleet-review-verdict-check.ts — attack the review claim harder.
 *
 * `ops/fleet-review-shipped-check.ts` ran tickFleet ONCE and the verdict was REDO. That cannot
 * distinguish "the shipped reviewer judges the artifact" from "the shipped reviewer always says
 * REDO" - and an always-REDO reviewer is the same class of bug the planner fallback had.
 *
 * This drives the real exported `tickFleet()` on TWO orders in one run:
 *   GOOD - a report with real command output and a complete deliverable  -> expect PASS
 *   BAD  - a stub report claiming verification it never ran              -> expect REDO
 * If GOOD comes back REDO too, the reviewer is not discriminating and that must be reported.
 *
 *   npx tsx ops/fleet-review-verdict-check.ts
 */
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-verdict-"));
process.env.COMPANY_ROOT = path.join(tmp, "company");
process.env.FLEET_REPO = path.join(tmp, "repo");
process.env.MOCK_MODE = "0";
process.env.FLEET_AUTO_APPROVE = "0";
process.env.FLEET_FALLBACK_MODELS = "deepseek-v4.1-flash,kimi-k2.7-code";
process.env.FLEET_WATCH_INTERVAL_MS = "600000";

const repo = process.env.FLEET_REPO;
fs.mkdirSync(path.join(repo, "docs"), { recursive: true });

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

// ── the GOOD deliverable: complete, and the report shows REAL command output ──────────────
// The FIRST version of this fixture was rejected by the reviewer for a real inconsistency I
// introduced by accident: its pasted `grep -n 'Verify:'` output showed 2 lines while the prose
// claimed 6, and its verify commands omitted the auth header they documented. That review was
// CORRECT. This version removes those defects so a genuinely good deliverable can be graded.
const goodRel = "docs/FLEET_OPERATOR_GUIDE.md";
const routeLines: string[] = [];
const ROUTES = [
  { n: 1, m: "GET", p: "/company/fleet/orders", purpose: "List fleet orders and their work-order state.", req: "No params. Header X-Company-Token required.", res: '`{orders:[{id,status,workOrders:[...]}]}`.', err: "401 missing/invalid token.", verify: 'curl -s -H "X-Company-Token: $TOKEN" http://127.0.0.1:8787/company/fleet/orders' },
  { n: 2, m: "GET", p: "/company/fleet/orders/$ORDER_ID", purpose: "Fetch one order with its work orders and trace.", req: "Path param $ORDER_ID. Header X-Company-Token.", res: "`{order:{...}}`.", err: "401 no token; 404 unknown id.", verify: 'curl -s -H "X-Company-Token: $TOKEN" http://127.0.0.1:8787/company/fleet/orders/$ORDER_ID' },
  { n: 3, m: "POST", p: "/company/fleet/orders/$ORDER_ID/approve", purpose: "Approve a plan so its workers can start.", req: "Path param $ORDER_ID. Header X-Company-Token.", res: "`{order:{status:'running'}}`.", err: "400 not awaiting approval; 404 unknown id.", verify: 'curl -s -X POST -H "X-Company-Token: $TOKEN" http://127.0.0.1:8787/company/fleet/orders/$ORDER_ID/approve' },
  { n: 4, m: "POST", p: "/company/fleet/orders/$ORDER_ID/cancel", purpose: "Cancel an order's queued work without killing running terminals.", req: "Path param $ORDER_ID. Header X-Company-Token.", res: "`{order:{status:'cancelled'}}`.", err: "404 unknown id.", verify: 'curl -s -X POST -H "X-Company-Token: $TOKEN" http://127.0.0.1:8787/company/fleet/orders/$ORDER_ID/cancel' },
  { n: 5, m: "POST", p: "/company/fleet/tick", purpose: "Run one scheduling/review pass.", req: "No params. Header X-Company-Token.", res: "`{advanced,reviewed,orders}`.", err: "401 missing token.", verify: 'curl -s -X POST -H "X-Company-Token: $TOKEN" http://127.0.0.1:8787/company/fleet/tick' },
  { n: 6, m: "GET", p: "/company/fleet/status", purpose: "Report counts, caps and watcher state.", req: "No params. Header X-Company-Token.", res: "`{counts:{...},limits:{...},watcher:{...}}`.", err: "401 missing token.", verify: 'curl -s -H "X-Company-Token: $TOKEN" http://127.0.0.1:8787/company/fleet/status' },
];
for (const r of ROUTES) {
  routeLines.push(`## ${r.n}. ${r.m} ${r.p}`, `Purpose: ${r.purpose}`, `Request: ${r.req}`, `Response: ${r.res}`, `Errors: ${r.err}`, `Verify: \`${r.verify}\``, "");
}
const guide = ["# Fleet operator guide", "", "Base URL: `http://127.0.0.1:8787`. Auth: send `X-Company-Token`. Set the two variables the commands below use:", "", "```", 'TOKEN="<the value of COMPANY_AUTH_TOKEN>"', 'ORDER_ID="<an id from route 1>"', "```", "", ...routeLines].join("\n");
fs.writeFileSync(path.join(repo, goodRel), guide);

const goodId = "foReviewVerdictGood";
const goodWid = "WO1";
fs.mkdirSync(path.join(companyRoot, "fleet", goodId, goodWid), { recursive: true });
// The report pastes output that MATCHES the file: 6 sections, 6 Verify lines, all shown.
const verifyLines = guide.split("\n").map((l, i) => ({ l, i: i + 1 })).filter(({ l }) => l.startsWith("Verify:"));
fs.writeFileSync(
  path.join(companyRoot, "fleet", goodId, goodWid, "REPORT.md"),
  [
    "# REPORT",
    "## What I did",
    `Wrote ${goodRel}: one section per route, each with Purpose, Request (method, path, params, header), Response shape, Errors with status codes, and a runnable Verify command. Defined $TOKEN and $ORDER_ID up front.`,
    "## How I verified (real output)",
    "```",
    "$ wc -l docs/FLEET_OPERATOR_GUIDE.md",
    `${guide.split("\n").length} docs/FLEET_OPERATOR_GUIDE.md`,
    "$ grep -c '^## ' docs/FLEET_OPERATOR_GUIDE.md",
    `${guide.split("\n").filter((l) => l.startsWith("## ")).length}`,
    "$ grep -c '^Purpose:' docs/FLEET_OPERATOR_GUIDE.md",
    `${guide.split("\n").filter((l) => l.startsWith("Purpose:")).length}`,
    "$ grep -c '^Verify:' docs/FLEET_OPERATOR_GUIDE.md",
    `${verifyLines.length}`,
    "$ grep -n '^Verify:' docs/FLEET_OPERATOR_GUIDE.md",
    ...verifyLines.map(({ l, i }) => `${i}:${l}`),
    "```",
    "## Acceptance checks",
    `- The guide exists and is non-empty: ${guide.split("\n").length} lines, per \`wc -l\` above.`,
    `- It names all six routes: ${guide.split("\n").filter((l) => l.startsWith("## ")).length} route sections, per \`grep -c '^## '\` above.`,
    `- Every route has a Purpose, a Request, a Response shape, Errors and a Verify command: ${guide.split("\n").filter((l) => l.startsWith("Purpose:")).length} Purpose / ${guide.split("\n").filter((l) => l.startsWith("Request:")).length} Request / ${guide.split("\n").filter((l) => l.startsWith("Response:")).length} Response / ${guide.split("\n").filter((l) => l.startsWith("Errors:")).length} Errors / ${verifyLines.length} Verify lines, all counted above.`,
    "- Not verified against the running service: this guide was written from the route definitions in the codebase; the Verify commands are provided for an operator to run.",
  ].join("\n"),
);

// ── the BAD deliverable: a stub, with fabricated verification ─────────────────────────────
const badId = "foReviewVerdictBad";
const badWid = "WO1";
fs.mkdirSync(path.join(companyRoot, "fleet", badId, badWid), { recursive: true });
fs.writeFileSync(path.join(companyRoot, "fleet", badId, badWid, "REPORT.md"), [
  "# REPORT",
  "Done. Everything works.",
  "I verified all six routes and they all return 200.",
].join("\n"));

const nowIso = new Date().toISOString();
const mk = (id: string, wid: string): any => ({
  id,
  text: "GOAL: write the operator guide for the six fleet routes from docs/FLEET_SPEC.md.",
  createdAt: nowIso,
  updatedAt: nowIso,
  status: "running",
  plan: "one work order",
  workOrders: [{ id: wid, title: "Write the operator guide", role: "docs", owns: [goodRel], brief: "Write the operator guide.", done: ["the guide exists"], state: "reported", attempts: 0, startedAt: nowIso }],
  trace: [{ ts: nowIso, from: "CEO", to: "Claude (manager)", what: "order", detail: "GOAL: write the operator guide..." }],
});
fs.writeFileSync(path.join(companyRoot, "fleet", "orders.json"), JSON.stringify([mk(goodId, goodWid), mk(badId, badWid)], null, 2));

console.log("[verdict] driving the SHIPPED tickFleet() on a GOOD and a BAD deliverable in one run");
const res = await fleet.tickFleet();
console.log(`[verdict] tickFleet -> ${JSON.stringify(res)}`);

const good = fleet.getFleetOrder(goodId)!.workOrders[0]!;
const bad = fleet.getFleetOrder(badId)!.workOrders[0]!;
console.log(`[verdict] GOOD: state=${good.state} verdict=${good.verdict} notes=${String(good.review ?? "").length} chars`);
console.log(`[verdict] BAD : state=${bad.state} verdict=${bad.verdict} notes=${String(bad.review ?? "").length} chars`);
console.log(`[verdict] GOOD notes (first 200): ${JSON.stringify(String(good.review ?? "").slice(0, 200))}`);

check("the GOOD deliverable was reviewed", good.state === "reviewed", String(good.state));
check("the BAD deliverable was reviewed", bad.state === "reviewed", String(bad.state));
check("both verdicts are legal values", ["PASS", "REDO"].includes(String(good.verdict)) && ["PASS", "REDO"].includes(String(bad.verdict)), `${good.verdict}/${bad.verdict}`);
check("both reviews carry real notes", String(good.review ?? "").length > 40 && String(bad.review ?? "").length > 40, `${String(good.review ?? "").length}/${String(bad.review ?? "").length}`);
check("the BAD stub was not passed", bad.verdict === "REDO", `${bad.verdict}`);
// The discriminating assertion: a genuinely good deliverable with matching evidence must PASS.
// If it does not, the reviewer is not discriminating and that is a finding, not a test bug.
check("the reviewer DISCRIMINATES: the good deliverable was passed", good.verdict === "PASS", `good=${good.verdict} bad=${bad.verdict}`);

console.log(`\n[verdict] ${failures ? `${failures} FAILED` : "ALL CHECKS PASSED"} (temp dir ${tmp})`);
process.exit(failures ? 1 : 0);
