/**
 * ops/review-noverdict-check.ts - a review reply with NO parseable verdict must never become a
 * made-up REDO. See docs/perf/REVIEW_NO_VERDICT_2026-10-01.md.
 *
 * Before the fix: `parseJsonObject(reply)` returning null defaulted the verdict to "REDO", reset
 * `reviewAttempts` to 0 and asked the CEO to redo finished work. This check drives the REAL
 * exported `tickFleet()` against a throwaway COMPANY_ROOT/FLEET_REPO whose HTTP is stubbed (a
 * stub gateway + a Laya that answers 503, so the gate always takes the cheap tier):
 *
 *   A  foNoVerdictA  prose twice                    -> needs_manager, NO REDO, counter NOT reset
 *   B  foNoVerdictB  prose then a valid verdict     -> the verdict is used after ONE retry
 *   C1 foPassC       a valid PASS                    -> PASS as before
 *   C2 foRedoC       a valid REDO                    -> REDO as before
 *   D  (all calls)   the gateway body carries maxTokens 8192
 *   E  foSnipE       a 20 KB owned file              -> the reviewer sees 6000 chars of it
 *
 *   npx tsx ops/review-noverdict-check.ts
 */
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-noverdict-"));
process.env.COMPANY_ROOT = path.join(tmp, "company");
process.env.FLEET_REPO = path.join(tmp, "repo");
process.env.MOCK_MODE = "0"; // the reviewer path must really run
process.env.FLEET_AUTO_APPROVE = "0";
process.env.FLEET_WATCH_INTERVAL_MS = "600000";

const companyRoot = process.env.COMPANY_ROOT!;
const repo = process.env.FLEET_REPO!;
fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
fs.mkdirSync(path.join(companyRoot, "fleet"), { recursive: true });

// ── stub HTTP: a Laya that is down (-> cheap tier) and a scripted gateway ────────────────
type RecordedCall = { url: string; maxTokens?: number; user: string };
const calls: RecordedCall[] = [];
const queues: Record<string, string[]> = {};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes("/v1/systemone")) {
    // Laya is unavailable -> pickBrain falls back to the cheap tier ("none").
    return new Response("laya unavailable", { status: 503 });
  }
  let body: { max_tokens?: number; messages?: Array<{ role?: string; content?: string }> } = {};
  try { body = init?.body ? JSON.parse(String(init.body)) : {}; } catch { /* keep {} */ }
  const user = (body.messages ?? []).filter((m) => m.role === "user").map((m) => m.content ?? "").join("\n");
  calls.push({ url, maxTokens: body.max_tokens, user });
  let reply = "{}";
  for (const id of Object.keys(queues)) {
    if (user.includes(`WORK ORDER ${id}`)) {
      reply = queues[id].shift() ?? "{}";
      break;
    }
  }
  const payload = { choices: [{ finish_reason: "stop", message: { content: reply } }], usage: {} };
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
};

// ── fixtures ─────────────────────────────────────────────────────────────────────────────
type Fixture = { orderId: string; wid: string; reviewAttempts?: number; owns?: string[]; pass?: boolean; report: string };

const BIG_MARKER = "ZZZ_AFTER_THE_6000_CHAR_SNIPPET";
const bigFile = "docs/BIG_SNIP.md";
const bigContent = `${"A".repeat(6500)}${BIG_MARKER}${"B".repeat(13000)}`;

const fixtures: Fixture[] = [
  { orderId: "foNoVerdictA", wid: "WOA", reviewAttempts: 2, report: "# REPORT\nprose-review scenario A.\n" },
  { orderId: "foNoVerdictB", wid: "WOB", report: "# REPORT\nprose-then-verdict scenario B.\n" },
  { orderId: "foPassC", wid: "WOC", report: "# REPORT\nvalid PASS scenario C1.\n" },
  { orderId: "foRedoC", wid: "WOD", report: "# REPORT\nvalid REDO scenario C2.\n" },
  { orderId: "foSnipE", wid: "WOE", owns: [bigFile], report: "# REPORT\nsnippet scenario E.\n" },
];

const PROSE = "Let me analyze this work order review carefully. The deliverable looks complete and the checks appear to hold, but I am still reasoning about it.";
const nowIso = new Date().toISOString();

for (const f of fixtures) {
  const dir = path.join(companyRoot, "fleet", f.orderId, f.wid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "REPORT.md"), f.report);
}

// scripted replies, keyed by work-order id
queues["WOA"] = [PROSE, PROSE];
queues["WOB"] = [PROSE, '{"verdict":"REDO","review":"the second reply is a real verdict."}'];
queues["WOC"] = ['{"verdict":"PASS","review":"everything checks out."}'];
queues["WOD"] = ['{"verdict":"REDO","review":"evidence is missing."}'];
queues["WOE"] = ['{"verdict":"PASS","review":"snippet scenario."}'];

const mkOrder = (f: Fixture) => ({
  id: f.orderId,
  text: "GOAL: (fixture) review-no-verdict behaviour.",
  createdAt: nowIso,
  updatedAt: nowIso,
  status: "running",
  plan: "one work order",
  workOrders: [
    {
      id: f.wid,
      title: `fixture ${f.wid}`,
      role: "code",
      owns: f.owns ?? [`src/${f.wid}.ts`],
      brief: "Do the thing and write REPORT.md.",
      done: ["the deliverable exists"],
      state: "reported",
      attempts: 0,
      reportedAt: nowIso,
      ...(f.reviewAttempts !== undefined ? { reviewAttempts: f.reviewAttempts } : {}),
    },
  ],
  trace: [{ ts: nowIso, from: "CEO", to: "Claude (manager)", what: "order", detail: "GOAL: fixture" }],
});
fs.writeFileSync(path.join(companyRoot, "fleet", "orders.json"), JSON.stringify(fixtures.map(mkOrder), null, 2));

// an owned file longer than the snippet: only its first 6000 chars may reach the reviewer
fs.writeFileSync(path.join(repo, bigFile), bigContent);

const fleet = await import("../src/company/fleet.js");
const callsFor = (wid: string) => calls.filter((c) => c.user.includes(`WORK ORDER ${wid}`));
const woOf = (id: string) => fleet.getFleetOrder(id)!.workOrders[0]!;

console.log("[noverdict] driving the SHIPPED tickFleet() once");
const res = await fleet.tickFleet();
console.log(`[noverdict] tickFleet -> ${JSON.stringify(res)}`);

// A - prose twice -> needs_manager, no REDO, counter not reset
const a = woOf("foNoVerdictA");
check("A: prose twice -> state needs_manager", a.state === "needs_manager", `state=${a.state}`);
check("A: ... no made-up REDO verdict", a.verdict === undefined, `verdict=${String(a.verdict)}`);
check("A: ... reviewAttempts NOT reset (still 3, was 2)", a.reviewAttempts === 3, `reviewAttempts=${a.reviewAttempts}`);
check("A: ... the order waits for the manager (reviewing)", fleet.getFleetOrder("foNoVerdictA")!.status === "reviewing", `status=${fleet.getFleetOrder("foNoVerdictA")!.status}`);
check("A: ... two reviewer calls were made", callsFor("WOA").length === 2, `calls=${callsFor("WOA").length}`);

// B - prose then a valid verdict -> the verdict is used after one retry
const b = woOf("foNoVerdictB");
check("B: prose then a verdict -> the verdict is used", b.state === "reviewed" && b.verdict === "REDO", `state=${b.state} verdict=${b.verdict}`);
check("B: ... after exactly one retry (2 calls)", callsFor("WOB").length === 2, `calls=${callsFor("WOB").length}`);
check("B: ... reviewAttempts reset on a completed review", b.reviewAttempts === 0, `reviewAttempts=${b.reviewAttempts}`);
check("B: ... a `review retry (no verdict)` hop was recorded", (fleet.getFleetOrder("foNoVerdictB")!.trace ?? []).some((t) => String(t.what) === "review retry (no verdict)"), "trace");

// C - valid PASS / valid REDO behave exactly as before
const c1 = woOf("foPassC");
const c2 = woOf("foRedoC");
check("C1: a valid PASS still PASSes", c1.state === "reviewed" && c1.verdict === "PASS" && c1.reviewAttempts === 0, `state=${c1.state} verdict=${c1.verdict}`);
check("C2: a valid REDO still REDOs", c2.state === "reviewed" && c2.verdict === "REDO" && c2.reviewAttempts === 0, `state=${c2.state} verdict=${c2.verdict}`);
check("C: valid verdicts take one call each", callsFor("WOC").length === 1 && callsFor("WOD").length === 1, `${callsFor("WOC").length}/${callsFor("WOD").length}`);

// D - every reviewer request carries maxTokens 8192 (other stub hits, e.g. Slack, are ignored)
const reviewerCalls = calls.filter((c) => /WORK ORDER \w+/.test(c.user));
check("D: every reviewer request carries maxTokens 8192", reviewerCalls.length === 7 && reviewerCalls.every((c) => c.maxTokens === 8192), `n=${reviewerCalls.length} budgets=${JSON.stringify([...new Set(reviewerCalls.map((c) => c.maxTokens))])}`);

// E - the owned-file snippet is 6000 chars, not 1500
const eCalls = callsFor("WOE");
const eUser = eCalls[0]?.user ?? "";
check("E: a 20KB owned file reaches the reviewer as a 6000-char snippet", eUser.includes(bigContent.slice(0, 6000)), `prompt=${eUser.length} chars`);
check("E: ... content beyond 6000 chars is NOT included", !eUser.includes(BIG_MARKER), "marker absent");

globalThis.fetch = realFetch;
console.log(`\n[noverdict] ${failures ? `${failures} FAILED` : "ALL CHECKS PASSED"} (temp dir ${tmp})`);
process.exit(failures ? 1 : 0);
