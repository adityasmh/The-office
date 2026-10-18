/**
 * ops/fleet-signin-fallback-variant-check.ts — exercise the OTHER way the fallback can die.
 *
 * `ops/fleet-signin-shipped-check.ts` kills the gateway at the TRANSPORT layer (unreachable host).
 * The storage error branch also builds a different message for a gateway that ANSWERS but with
 * nothing usable ("empty response", "answered N chars with no JSON"). This runs a real local HTTP
 * server that imitates that gateway, so the fallback is exhausted at the APPLICATION layer while
 * Claude is expired - and checks the order still ends with the one plain sign-in sentence.
 *
 *   npx tsx ops/fleet-signin-fallback-variant-check.ts
 */
import "dotenv/config";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signin-variant-"));
process.env.COMPANY_ROOT = path.join(tmp, "company");
process.env.FLEET_REPO = path.join(tmp, "repo");
process.env.MOCK_MODE = "0";
process.env.FLEET_FALLBACK_MODELS = "deepseek-v4.1-flash,kimi-k2.7-code";
process.env.FLEET_FALLBACK_TRIES = "1";

const repo = process.env.FLEET_REPO;
fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
fs.writeFileSync(path.join(repo, "docs", "FLEET_SPEC.md"), "# six routes\n");

// Fake, un-signed-in claude.
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

// A gateway that is REACHABLE but answers with nothing usable - the application-layer failure.
// Three modes, because "unusable" has more than one shape in the real world:
//   prose   - an answer with no JSON at all (the model explains instead of answering)
//   partial - a TRUNCATED JSON object (finish_reason "length"): the realistic reasoning-model failure
//   error   - an HTTP 500, i.e. the gateway answers but refuses the call
const STUB_MODE = (process.env.STUB_MODE ?? "prose") as "prose" | "partial" | "error";
let hits = 0;
const server = http.createServer((req, res) => {
  hits++;
  if (STUB_MODE === "error") {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "upstream model unavailable", type: "server_error" } }));
    return;
  }
  const content =
    STUB_MODE === "partial"
      ? '{"plan":"# Fleet plan\\n\\n1. Read docs/FLEET_SPEC.md and extract the six routes","specDoc":null,"workOrders":[{"id":"WO-A","title":"Write the operator'
      : "I could not produce a plan. Let me explain my reasoning at length instead.";
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id: "x", object: "chat.completion", model: "stub",
    choices: [{ index: 0, finish_reason: STUB_MODE === "partial" ? "length" : "stop", message: { role: "assistant", content, reasoning_content: "" } }],
    usage: {},
  }));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
process.env.GATEWAY_BASE_URL = `http://127.0.0.1:${port}/v1`;

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
};

const fleet = await import("../src/company/fleet.js");
const { config } = await import("../src/config.js");
const { CLAUDE_SIGNIN_EXPIRED_MESSAGE } = await import("../src/company/claudeSignIn.js");
config.gatewayBaseUrl = process.env.GATEWAY_BASE_URL!;

console.log(`[variant] stub gateway on 127.0.0.1:${port} (reachable, mode=${STUB_MODE})`);
const order = await fleet.createFleetOrder("GOAL: use claude to write the operator guide for the six fleet routes and a read-only check script.");
let done: any = null;
const t0 = Date.now();
while (Date.now() - t0 < 180_000) {
  done = fleet.getFleetOrder(order.id);
  if (done && ["failed", "awaiting_approval", "done"].includes(done.status)) break;
  await new Promise((r) => setTimeout(r, 1500));
}
const hop = (done?.trace ?? []).find((s: any) => /kimi|fallback/i.test(String(s.what)));
console.log(`[variant] stub gateway hits=${hits} status=${done?.status} error=${JSON.stringify(done?.error ?? "")}`);
console.log(`[variant] fallback hop: ${hop ? String(hop.detail).slice(0, 160) : "(none)"}`);

check("the stub gateway was really called by the fallback", hits > 0, `${hits} hit(s)`);
check("the order failed", done?.status === "failed", String(done?.status));
check("it failed ONCE (no planning-retry hops)", !(done?.trace ?? []).some((s: any) => /planning retry/i.test(String(s.what))), `${(done?.trace ?? []).filter((s: any) => /planning retry/i.test(String(s.what))).length}`);
check("exactly one 'plan failed' hop", (done?.trace ?? []).filter((s: any) => s.what === "plan failed").length === 1, String((done?.trace ?? []).filter((s: any) => s.what === "plan failed").length));

// THE REQUIRED OUTCOME SPLITS, and the split is correct:
//  - prose / HTTP 500: the fallback THREW, so Claude is the only thing that failed for a sign-in
//    reason -> the CEO must get the ONE plain sign-in sentence, and never the raw fallback text.
//  - partial JSON: the fallback ANSWERED (parseable JSON with a workOrders key) and the plan was
//    simply unusable -> that is a planner-content failure, not a sign-in failure, so the sign-in
//    sentence would be WRONG here. The CEO gets the honest planner error, and the raw reason is
//    on the trace.
if (STUB_MODE === "partial") {
  check("a REACHABLE fallback that answered is NOT reported as a sign-in failure", done?.error !== CLAUDE_SIGNIN_EXPIRED_MESSAGE, JSON.stringify(done?.error));
  check("the planner-content failure is described in plain words", /no usable work orders/i.test(String(done?.error ?? "")), JSON.stringify(String(done?.error ?? "").slice(0, 120)));
  check("the trace still records the real cause", (done?.trace ?? []).some((s: any) => /plan failed|unparseable|no usable work orders/i.test(`${s.what} ${s.detail ?? ""}`)), "cause recorded");
} else {
  check("the error IS the plain sign-in sentence (not the raw fallback text)", done?.error === CLAUDE_SIGNIN_EXPIRED_MESSAGE, JSON.stringify(done?.error));
  check("the trace names what the fallback actually said", (done?.trace ?? []).some((s: any) => /no JSON|empty response|no fallback model answered|[0-9]{3}/i.test(String(s.detail ?? ""))), "the real reason is recorded, not hidden");
  check("the CEO never sees the raw fallback text", !/no JSON|empty response|\b5\d\d\b/i.test(String(done?.error ?? "")), String(done?.error));
}

server.close();
console.log(`\n[variant] ${failures ? `${failures} FAILED` : "ALL CHECKS PASSED"} (temp dir ${tmp})`);
process.exit(failures ? 1 : 0);
