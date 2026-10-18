/**
 * ops/fleet-signin-shipped-check.ts — prove the sign-in sentence comes from the SHIPPED code.
 *
 * The earlier briefing checks wrote the record by hand, which only proves the READ path. This
 * drives the real `planOrder` (via createFleetOrder) with:
 *   - a fake, un-signed-in `claude.exe`, and
 *   - a gateway that cannot be reached (FLEET_FALLBACK_MODELS pinned to a bogus host via config),
 * so the ONLY possible outcome is the expired-sign-in failure - and we then read the order the
 * shipped code wrote, plus the CEO-facing prompt derived from it.
 *
 *   npx tsx ops/fleet-signin-shipped-check.ts
 */
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signin-shipped-"));
process.env.COMPANY_ROOT = path.join(tmp, "company");
process.env.FLEET_REPO = path.join(tmp, "repo");
process.env.MOCK_MODE = "0";
process.env.FLEET_AUTO_APPROVE = "0";
process.env.FLEET_PLANNER_DEBUG = "0"; // also proves the "=0 silences it" promise
process.env.FLEET_FALLBACK_TRIES = "1"; // also proves "=1 stops after one pass"
// The order must reach the PLANNER: naming Claude is the gate's own override.
const ORDER = "GOAL: use claude to write the operator guide for the six fleet routes and a read-only check script.";

const repo = process.env.FLEET_REPO;
fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
fs.writeFileSync(path.join(repo, "docs", "FLEET_SPEC.md"), "# six fleet routes\n");

// not-signed-in claude
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
const { config } = await import("../src/config.js");
const { CLAUDE_SIGNIN_EXPIRED_MESSAGE } = await import("../src/company/claudeSignIn.js");

// Capture stdout to prove the debug promise.
const lines: string[] = [];
const origLog = console.log.bind(console);
console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); origLog(...a); };

// Make the gateway unreachable AFTER the modules loaded (gateway.ts reads config per call).
const originalGateway = config.gatewayBaseUrl;
config.gatewayBaseUrl = "http://127.0.0.1:9/never";

console.log("[signin] driving the SHIPPED createFleetOrder -> planOrder (Claude expired, gateway dead)");
const order = await fleet.createFleetOrder(ORDER);
let done: any = null;
const t0 = Date.now();
while (Date.now() - t0 < 240_000) {
  done = fleet.getFleetOrder(order.id);
  if (done && ["failed", "awaiting_approval", "done"].includes(done.status)) break;
  await new Promise((r) => setTimeout(r, 1500));
}
config.gatewayBaseUrl = originalGateway;
console.log = origLog;

const debugLines = lines.filter((l) => l.includes("[fleet:plan:debug]"));
console.log(`[signin] status=${done?.status} planAttempts=${done?.planAttempts}`);
console.log(`[signin] error=${JSON.stringify(done?.error ?? "")}`);
console.log(`[signin] hops=${(done?.trace ?? []).map((s: any) => s.what).join(" | ")}`);
console.log(`[signin] debug lines emitted: ${debugLines.length}`);

check("the shipped planOrder failed the order", done?.status === "failed", String(done?.status));
check("the error IS the acceptance sentence", done?.error === CLAUDE_SIGNIN_EXPIRED_MESSAGE, JSON.stringify(done?.error));
check("it failed ONCE (no planning-retry hops)", !(done?.trace ?? []).some((s: any) => /planning retry/i.test(String(s.what))), `${(done?.trace ?? []).filter((s: any) => /planning retry/i.test(String(s.what))).length} retry hop(s)`);
check("exactly one 'plan failed' hop", (done?.trace ?? []).filter((s: any) => s.what === "plan failed").length === 1, String((done?.trace ?? []).filter((s: any) => s.what === "plan failed").length));
check("the raw reasons are kept on the trace", (done?.trace ?? []).some((s: any) => /Failed to authenticate|no fallback/i.test(String(s.detail ?? ""))), "trace carries the raw cause");
check("FLEET_PLANNER_DEBUG=0 emitted NO debug line", debugLines.length === 0, `${debugLines.length} line(s)`);
check("FLEET_FALLBACK_TRIES=1 produced ONE pass", !(done?.trace ?? []).some((s: any) => /pass2|pass 2/i.test(String(s.detail ?? ""))), "no second pass recorded");

// The CEO-facing prompt, derived from what the SHIPPED code wrote.
const cards = runManagers.listRunCards();
const b = briefing.composeBriefing(cards, { seenAt: new Date(0).toISOString(), summary: "(x)", model: "local" });
const item = b.needsYou.find((n: any) => n.runId === `fleet:${order.id}`);
console.log(`[signin] needsYou item: ${JSON.stringify(item ? { kind: item.kind, q: item.question, acts: (item.actions ?? []).map((a: any) => a.label) } : null)}`);
check("the CEO is asked the acceptance sentence", item?.question === CLAUDE_SIGNIN_EXPIRED_MESSAGE, JSON.stringify(item?.question ?? null));
check("it is not a retry/drop choice", item?.kind === "external", String(item?.kind));
check("there is exactly ONE action", (item?.actions ?? []).length === 1, String((item?.actions ?? []).length));
check("no 'Drop order' button is offered", !(item?.actions ?? []).some((a: any) => /drop/i.test(String(a.label))), JSON.stringify((item?.actions ?? []).map((a: any) => a.label)));

console.log(`\n[signin-shipped] ${failures ? `${failures} FAILED` : "ALL CHECKS PASSED"} (temp dir ${tmp})`);
process.exit(failures ? 1 : 0);
