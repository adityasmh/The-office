// Extend the existing harness with adversarial predicate cases and a signed-in-response case.
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { mentionsClaudeSignInExpired } from "../src/company/claudeSignIn.js";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
};

console.log("=== the sign-in predicate: what MUST match ===");
const positives = [
  "claude -p error: Failed to authenticate: OAuth session expired and could not be refreshed",
  "Error: Claude OAuth refresh 400: invalid_grant",
  "oauth session expired",
  "Claude credentials not found at C:\\Users\\u\\.claude\\.credentials.json. Run: claude login",
  "No claudeAiOauth block in credentials. Re-run `claude login`.",
  "Claude subscription rejected (401). Re-run 'claude login'. Body: ...",
];
for (const s of positives) check(`matches: ${s.slice(0, 60)}`, mentionsClaudeSignInExpired(s), s.slice(0, 60));

console.log("\n=== the sign-in predicate: what MUST NOT match ===");
const negatives = [
  // A spend limit is a DIFFERENT failure: it must keep the retry/drop + Claude-limit path.
  "Claude subscription rate-limited (429). Back off and retry, or fall back to the gateway model in CLAUDE_FALLBACK_MODEL.",
  "Claude hit its spending limit.",
  "claude -p 429: subscription usage limit reached",
  // A plain outage, not an expired sign-in.
  "spawn C:\\x\\claude.exe ENOENT",
  "claude -p timed out after 300s",
  "Error: claude -p exit 1: ",
  // The old planner error text - this is what the six live orders actually carry.
  "the planner produced no usable work orders",
  "planning failed 3x: the planner produced no usable work orders",
  // Near-miss strings that accidentally contain 'login' but are not a sign-in failure.
  "the login page was redesigned",
  "add a login form to the settings page",
  "GOAL: write the operator guide for the fleet routes",
  "",
];
for (const s of negatives) check(`does NOT match: ${JSON.stringify(s.slice(0, 56))}`, !mentionsClaudeSignInExpired(s), s.slice(0, 56));

// ── the CLI path: a SIGNED-IN claude must plan via Claude, not the fallback ──────────────
// A fake claude.exe that returns a valid plan JSON proves the healthy path is untouched.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signin-healthy-"));
process.env.COMPANY_ROOT = path.join(tmp, "company");
process.env.FLEET_REPO = path.join(tmp, "repo");
process.env.MOCK_MODE = "0";
fs.mkdirSync(path.join(process.env.FLEET_REPO, "docs"), { recursive: true });
fs.writeFileSync(path.join(process.env.FLEET_REPO, "docs", "FLEET_SPEC.md"), "# six routes\n");

const PLAN = JSON.stringify({
  plan: "healthy-path plan",
  specDoc: null,
  workOrders: [
    { id: "WO-A", title: "Write the guide", role: "WO-A", owns: ["docs/GUIDE.md"], brief: "Write the guide.", done: ["the file exists"] },
    { id: "WO-B", title: "Write the check", role: "WO-B", owns: ["scripts/check.py"], brief: "Write the check.", done: ["the file exists"] },
  ],
});
const binDir = path.join(tmp, "bin");
fs.mkdirSync(binDir, { recursive: true });
const claudeExe = path.join(binDir, "claude.exe");
if (process.platform === "win32") {
  const src = path.join(tmp, "ok.cs");
  fs.writeFileSync(
    src,
    [
      "public class Program {",
      "  public static int Main(string[] args) {",
      `    System.Console.WriteLine(${JSON.stringify(JSON.stringify({ type: "result", is_error: false, result: PLAN }))});`,
      "    return 0;",
      "  }",
      "}",
    ].join("\n"),
  );
  const { execFileSync } = await import("node:child_process");
  execFileSync(path.join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"), ["/nologo", `/out:${claudeExe}`, src], { stdio: "inherit" });
}
// Force the PLANNER path: the CEO naming Claude is the gate's own override ("use claude"), so
// the order reaches callClaudeSubscription instead of the local cheap plan. A single pinned
// fallback model AND an unreachable gateway then prove any success came from CLAUDE.
process.env.FLEET_FALLBACK_MODELS = "deepseek-v4.1-flash";
const fleet = await import("../src/company/fleet.js");
const { config } = await import("../src/config.js");
config.gatewayBaseUrl = "http://127.0.0.1:9/never";

console.log("\n=== a SIGNED-IN claude still plans via Claude (fallback unreachable) ===");
const order = await fleet.createFleetOrder("GOAL: use claude to document the six fleet routes and write a read-only check script.");
let done: any = null;
const t0 = Date.now();
while (Date.now() - t0 < 120_000) {
  done = fleet.getFleetOrder(order.id);
  if (done && ["awaiting_approval", "failed", "done"].includes(done.status)) break;
  await new Promise((r) => setTimeout(r, 2000));
}
const hops = (done?.trace ?? []).map((s: any) => s.what).join(" | ");
console.log(`  status=${done?.status} workOrders=${done?.workOrders?.length} hops=${hops}`);
check("the healthy path is untouched: it plans via Claude", done?.status === "awaiting_approval", String(done?.status));
check("the healthy plan produced the two work orders the fake claude returned", done?.workOrders?.length === 2, String(done?.workOrders?.length));
check("the healthy path did NOT use the fallback", !/planner via kimi/i.test(hops), hops);
check("the healthy path did NOT fail with the sign-in sentence", done?.error !== "Claude sign-in expired: the CEO must run claude /login in a terminal", String(done?.error));
check("the healthy path did NOT fall back at all (no 'unavailable' warn in the trace)", !/unavailable/i.test(hops), hops);

console.log(`\n[check] ${failures ? `${failures} FAILED` : "ALL CHECKS PASSED"} (temp dir ${tmp})`);
process.exit(failures ? 1 : 0);
