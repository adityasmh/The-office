/**
 * ops/fleet-fallback-flakiness-check.ts — separates "the gateway is flaky" from "my fix is
 * broken".
 *
 * The gateway key intermittently answers a planner call with EMPTY content (measured three
 * times this session). Without a control that looks identical to the failure, that flakiness is
 * indistinguishable from a code regression. So this pairs the real fleet fallback call with a
 * direct call to the same model on the same prompt:
 *
 *   for attempt in 1..3:
 *     direct model call -> usable text?   (ground truth for the gateway+GATEWAY MODEL)
 *     fleet fallback call                 (the thing under test)
 *
 * If the direct call is ALSO empty, the attempt is discounted as a gateway event; if the direct
 * call answers and the fleet path then produces no work orders, that IS a regression.
 *
 *   npx tsx ops/fleet-fallback-flakiness-check.ts
 */
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fallback-flaky-"));
process.env.COMPANY_ROOT = path.join(tmp, "company");
process.env.FLEET_REPO = path.join(tmp, "repo");
process.env.MOCK_MODE = "0";
process.env.FLEET_FALLBACK_MODELS = "kimi-k2.7-code";
fs.mkdirSync(path.join(process.env.FLEET_REPO, "docs"), { recursive: true });
fs.writeFileSync(path.join(process.env.FLEET_REPO, "docs", "FLEET_SPEC.md"), "# six fleet routes\n");

// A fake claude.exe that always reports the expired sign-in, so every attempt takes the
// fallback branch - the path under test.
const binDir = path.join(tmp, "bin");
fs.mkdirSync(binDir, { recursive: true });
const claudeExe = path.join(binDir, "claude.exe");
const payload = JSON.stringify({
  type: "result",
  is_error: true,
  result: "Failed to authenticate: OAuth session expired and could not be refreshed",
});
if (process.platform === "win32") {
  const src = path.join(tmp, "bad.cs");
  fs.writeFileSync(
    src,
    [
      "public class Program {",
      "  public static int Main(string[] args) {",
      `    System.Console.WriteLine(${JSON.stringify(payload)});`,
      "    return 1;",
      "  }",
      "}",
    ].join("\n"),
  );
  const { execFileSync } = await import("node:child_process");
  execFileSync(path.join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"), ["/nologo", `/out:${claudeExe}`, src], { stdio: "inherit" });
}
process.env.CLAUDE_BIN = claudeExe;

const { callGatewayModel } = await import("../src/gateway.js");
const fleet = await import("../src/company/fleet.js");

const REVIEW = [
  "You are the reviewing manager of a small engineering company.",
  "A work order claims to have written docs/FLEET_OPERATOR_GUIDE.md and scripts/fleet_check.py.",
  "OUTPUT FORMAT - a hard REQUIREMENT: reply with ONE JSON object and NOTHING else.",
  '{"verdict":"PASS|REDO|FAIL","verdictReason":"...","headline":"...","done":["..."],"remaining":["..."]}',
].join("\n");
const BUTTONS =
  "TEST ORDER BUTTONS: Reply with exactly this JSON object and nothing else: " +
  '{"verdict":"PASS","verdictReason":"gateway reachable","headline":"test","done":["reply received"],"remaining":[]}';

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ORDER = "GOAL: use claude to write the operator guide for the six fleet routes and a read-only check script.";
const latest = () => fleet.loadFleetOrders().slice(-1)[0]!;
const usable = (t: string) => t.trim().length > 0 && t.includes("{") && /\}|workOrders|work_orders|verdict/.test(t);

// PRE-FLIGHT: the order text must actually reach the PLANNER. Naming Claude is the gate's own
// override, but if the CEO-named tier is `fleet-plan` it is a Sonnet ask and - with the CLI not
// signed in - it takes the fallback, which is the path under test. The Laya verdict is logged
// per attempt so a drifting gate can never quietly turn this into a cheap-plan test again.
console.log(`[flaky] gateway=${process.env.GATEWAY_BASE_URL ?? "(default)"} fallback=${process.env.FLEET_FALLBACK_MODELS}`);
const { pickBrain } = await import("../src/company/brainRouter.js");
const probe = await pickBrain({ purpose: "fleet-plan", text: ORDER, needsFiles: true });
console.log(`[flaky] gate pre-flight: tier=${probe.tier} claudeCall=${probe.claudeCall} fileBlind=${probe.fileBlind}`);
if (!probe.claudeCall) {
  console.log("[flaky] ABORT: the gate would take the local cheap plan, so this run cannot test the fallback path.");
  process.exit(2);
}
let discounted = 0;
let gradedAttempts = 0;
// Only the graded checks count toward the pass/fail verdict; "the orders were produced" is the
// one that decides whether the fallback path actually worked on a healthy-gateway attempt.
let gradedFailures = 0;

for (let attempt = 1; attempt <= 3; attempt++) {
  // Control: the SAME model, same shape of prompt, asked directly. Tries a couple of phrasings,
  // because empty content is tied to the reasoning models' output budget.
  let directUsable = false;
  let directNote = "";
  for (const [i, user] of [REVIEW, BUTTONS].entries()) {
    try {
      const r = await callGatewayModel("kimi-k2.7-code", "You are a precise assistant.", user, { maxTokens: 8192 });
      const t = r?.text ?? "";
      directNote += `#${i + 1} len=${t.length} usable=${usable(t)}; `;
      if (usable(t)) { directUsable = true; break; }
    } catch (e) {
      directNote += `#${i + 1} threw ${String(e).slice(0, 60)}; `;
    }
  }

  const order = await fleet.createFleetOrder(ORDER);
  let done: any = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 240_000) {
    done = fleet.getFleetOrder(order.id) ?? latest();
    if (done && ["awaiting_approval", "failed", "done"].includes(done.status)) break;
    await sleep(2000);
  }
  const model = done?.trace?.find((s: any) => s.what === "planner via kimi")?.detail ?? "(no fallback hop)";
  console.log(`  attempt ${attempt}: control usable=${directUsable} (${directNote.trim()}) | fleet status=${done?.status} workOrders=${done?.workOrders?.length} error=${JSON.stringify(String(done?.error ?? "").slice(0, 60))}`);

  if (!directUsable) {
    discounted++;
    console.log("   -> DISCOUNTED: the gateway itself answered nothing on this attempt (external flakiness)");
    continue;
  }
  // The fleet MUST have gone through the fallback for this to be a valid graded attempt.
  const usedFallback = done?.trace?.some((s: any) => s.what === "planner via kimi");
  if (!usedFallback) {
    console.log(`   -> NOT GRADED: the fleet never called the fallback (trace: ${(done?.trace ?? []).map((s: any) => s.what).join(" | ")})`);
    continue;
  }
  gradedAttempts++;
  check(`attempt ${attempt}: with a healthy gateway the fleet still planned`, done?.status === "awaiting_approval", String(done?.status));
  check(`attempt ${attempt}: work orders were produced`, (done?.workOrders?.length ?? 0) > 0, String(done?.workOrders?.length));
  if (done?.status !== "awaiting_approval" || !(done?.workOrders?.length ?? 0)) gradedFailures++;
  check(`attempt ${attempt}: the trace names the model that answered`, /kimi-k2\.7-code/.test(model), model.slice(0, 80));
  check(`attempt ${attempt}: the error is clear`, !done?.error, String(done?.error ?? ""));
}

console.log(`\n[flaky] graded attempts=${gradedAttempts} discounted(gateway)=${discounted}`);
check("the fleet path is correct on every attempt where the gateway worked", gradedAttempts > 0 && gradedFailures === 0, `graded=${gradedAttempts} failed=${gradedFailures}`);
if (gradedAttempts === 0) console.log("[flaky] NO GRADED ATTEMPTS: the gateway was unusable for the whole run; this proves nothing either way");

console.log(`\n[flaky] ${failures ? `${failures} FAILED` : "ALL CHECKS PASSED"} (temp dir ${tmp})`);
process.exit(failures ? 1 : 0);
