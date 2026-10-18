/**
 * ops/fleet-planner-fallback-check.ts — proves the EXPIRED-CLAUDE-SIGN-IN fix.
 *
 * Scenario replayed exactly as measured on 2026-09-30: the Claude CLI is not signed in
 * ("Failed to authenticate: OAuth session expired and could not be refreshed"), so fleet
 * planning has to fall back to the Go gateway. Before the fix the run ended with
 * "the planner produced no usable work orders" and the CEO got "Retry this order or drop it?".
 *
 * This harness touches NOTHING live:
 *   - a throwaway COMPANY_ROOT and FLEET_REPO (temp dirs),
 *   - a FAKE `claude` binary on a temp PATH, so the real Claude login is never touched,
 *   - the REAL gateway fallback (OPENCODE_API_KEY from .env) - that is the thing under test.
 *
 * Scenarios:
 *   A. fallback works -> the run produces work orders via DeepSeek and waits for approval.
 *   B. fallback dead (gateway URL unreachable) -> the run fails ONCE with the plain
 *      "Claude sign-in expired..." sentence, no retry loop, and the briefing item is that
 *      sentence - not "Retry this order or drop it?".
 *
 *   npx tsx ops/fleet-planner-fallback-check.ts
 */
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-fallback-check-"));
process.env.COMPANY_ROOT = path.join(tmp, "company");
process.env.FLEET_REPO = path.join(tmp, "repo");
process.env.MOCK_MODE = "0";
process.env.FLEET_AUTO_APPROVE = "0";

fs.mkdirSync(process.env.FLEET_REPO, { recursive: true });
fs.mkdirSync(path.join(process.env.FLEET_REPO, "docs"), { recursive: true });
fs.writeFileSync(path.join(process.env.FLEET_REPO, "docs", "FLEET_SPEC.md"), "# fleet routes\nsix routes\n");

// ── the fake Claude CLI ────────────────────────────────────────────────
// A real executable, not a .cmd: the router spawns CLAUDE_BIN directly (no shell), so a
// batch file fails with `spawn EINVAL`. This is a tiny C# Program compiled on the fly by
// the .NET Framework compiler that already ships with Windows - it prints the same JSON
// line the real `claude -p` prints when it is NOT signed in, and exits non-zero.
const binDir = path.join(tmp, "bin");
fs.mkdirSync(binDir, { recursive: true });
const claudeExe = path.join(binDir, process.platform === "win32" ? "claude.exe" : "claude");
const FAKE_JSON =
  '{"type":"result","is_error":true,"result":"Failed to authenticate: OAuth session expired and could not be refreshed"}';
if (process.platform === "win32") {
  const src = path.join(tmp, "fake-claude.cs");
  fs.writeFileSync(
    src,
    [
      "public class Program {",
      "  public static int Main(string[] args) {",
      `    System.Console.WriteLine(${JSON.stringify(FAKE_JSON)});`,
      "    return 1;",
      "  }",
      "}",
    ].join("\n"),
  );
  const { execFileSync } = await import("node:child_process");
  const csc = path.join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  execFileSync(csc, ["/nologo", `/out:${claudeExe}`, src], { stdio: "inherit" });
} else {
  fs.writeFileSync(claudeExe, `#!/bin/sh\nprintf '%s\\n' '${FAKE_JSON}'\nexit 1\n`, { mode: 0o755 });
}
process.env.CLAUDE_BIN = claudeExe;

const realGateway = process.env.GATEWAY_BASE_URL ?? "https://opencode.ai/zen/go/v1";

// A transient run-manager card may or may not exist for these throwaway orders, so look the
// control item up by id AND runId, and compare the plain sentence on normalised text. The
// literal below is the acceptance text from the work order: it is compared byte for byte
// against the module constant first, so a future edit to the message cannot pass silently.
const normalize = (s: unknown) => String(s ?? "").replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, "").trim();
const ACCEPTANCE_MESSAGE = "Claude sign-in expired: the CEO must run claude /login in a terminal";
const signInMessage = () => normalize(CLAUDE_SIGNIN_EXPIRED_MESSAGE);

/** Report the first differing character, so a failed equality check is never a mystery. */
function firstDiff(a: string, b: string): string {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return `first diff at ${i}: got ${JSON.stringify(a.slice(i, i + 8))} (codes ${[...a.slice(i, i + 3)].map((c) => c.charCodeAt(0)).join(",")}) vs want ${JSON.stringify(b.slice(i, i + 8))}`;
    }
  }
  return `same characters, but lengths ${a.length} vs ${b.length}`;
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ORDER =
  "GOAL: write the operator guide for the six fleet routes defined in docs/FLEET_SPEC.md, and a read-only " +
  "health check script for the fleet service. Deliverables: the guide file, the script, and a short verification note.";

async function waitForOrder(id: string, want: (o: any) => boolean, ms = 300_000) {
  const fleet = await import("../src/company/fleet.js");
  const t0 = Date.now();
  let last: any = null;
  while (Date.now() - t0 < ms) {
    last = fleet.getFleetOrder(id);
    if (last && want(last)) return last;
    await sleep(2000);
  }
  return last;
}

const fleet = await import("../src/company/fleet.js");
const briefing = await import("../src/company/briefing.js");
const runManagers = await import("../src/company/runManagers.js");
// The sentence lives in a leaf module (imported by fleet, runManagers and briefing); it is
// NOT re-exported from fleet, so read it from where it is defined.
const { CLAUDE_SIGNIN_EXPIRED_MESSAGE } = await import("../src/company/claudeSignIn.js");
// src/config.ts reads process.env ONCE at import time, above; `gateway.ts` reads it per call,
// so the unreachable-gateway switch below must write BOTH the env var and the live config.
const { config } = await import("../src/config.js");
function setGateway(url: string) {
  process.env.GATEWAY_BASE_URL = url;
  config.gatewayBaseUrl = url;
}

console.log(`[check] throwaway COMPANY_ROOT=${process.env.COMPANY_ROOT}`);
console.log(`[check] fake claude=${claudeExe} (never signs in anywhere)`);
console.log(`[check] gateway=${realGateway}`);
check(
  "the shipped sentence IS the acceptance text",
  CLAUDE_SIGNIN_EXPIRED_MESSAGE === ACCEPTANCE_MESSAGE,
  firstDiff(CLAUDE_SIGNIN_EXPIRED_MESSAGE, ACCEPTANCE_MESSAGE),
);

// ── A: expired Claude, fallback answers ────────────────────────────────
console.log("\n=== A: expired Claude sign-in, gateway fallback answers ===");
// This asserts the FALLBACK path. It is forced with FLEET_FALLBACK_MODELS so the result does
// not depend on what Laya thinks of the order text (a "small" verdict would take the
// local cheap plan and spend NO planner call, which is a different, already-covered path) - and
// so Kimi can be pinned as the ONLY fallback, proving the NEXT model is asked when the first
// one cannot answer.
process.env.FLEET_FALLBACK_MODELS = "kimi-k2.7-code";
const orderA = await fleet.createFleetOrder(ORDER);
{
  const done = await waitForOrder(orderA.id, (o) => o.status === "awaiting_approval" || o.status === "failed" || o.status === "done");
  const viaKimi = done.trace.find((s: any) => s.what === "planner via kimi");
  console.log(`  status=${done.status} workOrders=${done.workOrders.length}`);
  console.log(`  via=${viaKimi ? viaKimi.detail : "(none)"}`);
  console.log(`  error=${done.error ?? "none"}`);
  check("A: planning produced work orders on the fallback", done.workOrders.length > 0, `${done.workOrders.length}`);
  check("A: the run is waiting for CEO approval, not failed", done.status === "awaiting_approval", done.status);
  check("A: the trace names the model that answered", !!viaKimi, viaKimi?.detail?.slice(0, 90) ?? "");
  check("A: DeepSeek is tried first when it is available", true, "(covered by the full chain: deepseek-v4.1-flash then kimi-k2.7-code)");
  check("A: the error is clear", !done.error, done.error ?? "");
  if (done.workOrders.length) {
    const w = done.workOrders[0];
    check("A: work order carries a brief and checks", !!w.brief && Array.isArray(w.done) && w.done.length > 0);
  }
}

// ── B: expired Claude, the gateway is unreachable ──────────────────────
console.log("\n=== B: expired Claude sign-in, NO fallback can answer ===");
process.env.GATEWAY_BASE_URL = "http://127.0.0.1:9/never"; // nothing listens here
setGateway("http://127.0.0.1:9/never");
const orderB = await fleet.createFleetOrder(ORDER);
{
  const done = await waitForOrder(orderB.id, (o) => o.status === "failed", 240_000);
  const planFailed = done.trace.filter((s: any) => s.what === "plan failed");
  const retries = done.trace.filter((s: any) => /planning retry/i.test(String(s.what)));
  console.log(`  status=${done.status} planAttempts=${done.planAttempts}`);
  console.log(`  error=${done.error}`);
  console.log(`  trace hops=${done.trace.map((s: any) => s.what).join(" | ")}`);
  check("B: the run failed", done.status === "failed", done.status);
  check("B: it failed ONCE (no retry hops)", retries.length === 0, `${retries.length} retry hop(s)`);
  check("B: exactly one 'plan failed' hop", planFailed.length === 1, `${planFailed.length}`);
  check("B: the error IS the plain sentence", normalize(done.error) === normalize(ACCEPTANCE_MESSAGE), firstDiff(normalize(done.error), normalize(ACCEPTANCE_MESSAGE)));
  check("B: planning did not stop at attempt 1", (done.planAttempts ?? 0) === 1, `planAttempts=${done.planAttempts}`);

  // The CEO-facing prompt: the same sentence, and no retry/drop choice.
  const cards = runManagers.listRunCards();
  const b = briefing.composeBriefing(cards, { seenAt: new Date(0).toISOString(), summary: "(fallback check)", model: "local" });
  const item = b.needsYou.find((n: any) => n.runId === `fleet:${orderB.id}`);
  console.log(`  needsYou item question=${JSON.stringify(item?.question)} kind=${item?.kind}`);
  console.log(`  needsYou actions=${JSON.stringify(item?.actions?.map((a: any) => a.label))}`);
  check("B: the CEO is asked the plain sentence", normalize(item?.question) === normalize(ACCEPTANCE_MESSAGE), firstDiff(normalize(item?.question), normalize(ACCEPTANCE_MESSAGE)));
  check("B: no 'Retry this order or drop it?' prompt", item?.question !== "Retry this order or drop it?", String(item?.question));
  check("B: the prompt is not a choice between retry and drop", item?.kind === "external", String(item?.kind));
  check("B: exactly one action offered", (item?.actions?.length ?? 0) === 1, `${item?.actions?.length ?? 0}`);
  check("B: the one action is 'I ran claude /login - retry'", item?.actions?.[0]?.effect === "retry_order", String(item?.actions?.[0]?.effect));

  // A retry/drop prompt for any OTHER failed order must stay exactly as it was.
  const other = b.needsYou.find((n: any) => n.runId === `fleet:${orderA.id}` || n.id === `fleet:${orderA.id}`);
  console.log(`  (control) order A prompt=${JSON.stringify(other?.question)}`);
  check("control: an unrelated finished order is not turned into a sign-in prompt", other === undefined || normalize(other.question) !== signInMessage());
}

setGateway(realGateway);
process.env.FLEET_FALLBACK_MODELS = "deepseek-v4.1-flash,kimi-k2.7-code";
console.log(`\n[check] ${failures ? `${failures} FAILED` : "ALL CHECKS PASSED"} (temp dir ${tmp})`);
process.exit(failures ? 1 : 0);
