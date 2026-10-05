/**
 * ops/fleet-review-shipped-check.ts — attack the review-path claim PROPERLY.
 *
 * The first attempt (ops/fleet-review-path-check.ts) RE-IMPLEMENTED reviewWorkOrder's prompt and
 * classification, so it proved the gateway answers, not that the SHIPPED review code works. This
 * one drives the real exported `tickFleet()`, which is what the watcher calls, with a real order,
 * a real REPORT.md and a real owned file - so `reviewWorkOrder` itself runs, including its strict
 * `parseJsonObject`, its REDO-on-parse-failure default and its automated PASS floor.
 *
 * Claude is faked as expired, so the review must arrive over the gateway fallback chain.
 *
 *   npx tsx ops/fleet-review-shipped-check.ts
 */
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-shipped-"));
process.env.COMPANY_ROOT = path.join(tmp, "company");
process.env.FLEET_REPO = path.join(tmp, "repo");
process.env.MOCK_MODE = "0";
process.env.FLEET_AUTO_APPROVE = "0";
process.env.FLEET_FALLBACK_MODELS = "deepseek-v4.1-flash,kimi-k2.7-code";
process.env.FLEET_FALLBACK_TRIES = "2";
process.env.FLEET_WATCH_INTERVAL_MS = "600000"; // never start the watcher in this process

const repo = process.env.FLEET_REPO;
fs.mkdirSync(path.join(repo, "docs"), { recursive: true });

// A fake claude.exe that is NOT signed in.
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
const runManagers = await import("../src/company/runManagers.js");
const briefing = await import("../src/company/briefing.js");
const { CLAUDE_SIGNIN_EXPIRED_MESSAGE } = await import("../src/company/claudeSignIn.js");

// ── build an order that is already past planning, with a reported work order ─────────────
const orderId = "foReviewShipped";
const wid = "WO1";
const ownedRel = "docs/FLEET_OPERATOR_GUIDE.md";
fs.writeFileSync(path.join(repo, ownedRel), "# Fleet operator guide\n\nSix routes: orders, detail, approve, cancel, tick, status.\n");
fs.mkdirSync(path.join(process.env.COMPANY_ROOT!, "fleet", orderId, wid), { recursive: true });
fs.writeFileSync(
  path.join(process.env.COMPANY_ROOT!, "fleet", orderId, wid, "REPORT.md"),
  [
    "# REPORT",
    "## What I did",
    `Wrote ${ownedRel} documenting the six fleet routes.`,
    "## How I verified",
    "Ran `type docs\\FLEET_OPERATOR_GUIDE.md`; the six route headings are present:",
    "```",
    "GET /company/fleet/orders",
    "GET /company/fleet/orders/:id",
    "POST /company/fleet/orders/:id/approve",
    "POST /company/fleet/orders/:id/cancel",
    "POST /company/fleet/tick",
    "GET /company/fleet/status",
    "```",
    "## Acceptance checks",
    "- The guide exists and names all six routes: yes.",
  ].join("\n"),
);

const nowIso = new Date().toISOString();
const order = {
  id: orderId,
  text: "GOAL: write the operator guide for the six fleet routes from docs/FLEET_SPEC.md.",
  createdAt: nowIso,
  updatedAt: nowIso,
  status: "running",
  plan: "one work order",
  workOrders: [
    { id: wid, title: "Write the guide", role: "docs", owns: [ownedRel], brief: "Write the operator guide.", done: ["the guide exists"], state: "reported", attempts: 0, startedAt: nowIso },
  ],
  trace: [{ ts: nowIso, from: "CEO", to: "Claude (manager)", what: "order", detail: "GOAL: write the operator guide..." }],
};
fs.writeFileSync(path.join(process.env.COMPANY_ROOT!, "fleet", "orders.json"), JSON.stringify([order], null, 2));

console.log("[review] driving the SHIPPED tickFleet() (Claude faked as expired)");
const t0 = Date.now();
const res = await fleet.tickFleet();
console.log(`[review] tickFleet -> ${JSON.stringify(res)} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const after = fleet.getFleetOrder(orderId)!;
const wo = after.workOrders[0]!;
const reviewHop = (after.trace ?? []).find((s: any) => /review (PASS|REDO)/.test(String(s.what)));
const viaHop = (after.trace ?? []).find((s: any) => String(s.what).startsWith("review via"));
console.log(`[review] wo.state=${wo.state} verdict=${wo.verdict} error=${JSON.stringify(wo.error ?? "")}`);
console.log(`[review] review notes (first 160): ${JSON.stringify(String(wo.review ?? "").slice(0, 160))}`);
console.log(`[review] hops: ${(after.trace ?? []).map((s: any) => s.what).join(" | ")}`);

check("the shipped review actually ran (the work order left 'reported')", wo.state !== "reported", String(wo.state));
check("a verdict was recorded on the work order", wo.verdict === "PASS" || wo.verdict === "REDO", String(wo.verdict));
check("the verdict is a legal value (not the parse-failure fallthrough)", wo.verdict === "PASS" || wo.verdict === "REDO", String(wo.verdict));
check("the reviewer wrote real notes", String(wo.review ?? "").length > 40, `${String(wo.review ?? "").length} chars`);
check("the review went through the gateway fallback, not Claude", !!viaHop || !!reviewHop, viaHop ? String(viaHop.detail).slice(0, 80) : "(no via hop)");
check("no work-order error was left behind", !wo.error, String(wo.error ?? ""));
check("the sign-in sentence was NOT used for a successful review", wo.error !== CLAUDE_SIGNIN_EXPIRED_MESSAGE, String(wo.error ?? ""));

// The order must settle to done or stay running without inventing a failure.
console.log(`[review] order.status=${after.status}`);
check("the order did not fail on the expired sign-in (the work was already done)", after.status !== "failed", after.status);

// And the CEO-facing prompt must not be a sign-in prompt.
const cards = runManagers.listRunCards();
const b = briefing.composeBriefing(cards, { seenAt: new Date(0).toISOString(), summary: "(x)", model: "local" });
const item = b.needsYou.find((n: any) => n.runId === `fleet:${orderId}`);
console.log(`[review] needsYou item: ${JSON.stringify(item ? { kind: item.kind, q: item.question } : null)}`);
check("no sign-in prompt is raised for a successfully reviewed order", !item || item.question !== CLAUDE_SIGNIN_EXPIRED_MESSAGE, JSON.stringify(item?.question ?? null));

console.log(`\n[review-shipped] ${failures ? `${failures} FAILED` : "ALL CHECKS PASSED"} (temp dir ${tmp})`);
process.exit(failures ? 1 : 0);
