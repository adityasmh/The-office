/**
 * ops/planner-toolcall-check.ts — proves the 2026-10-01 fleet-planner TOOL-CALL fix.
 *
 * MEASURED (2026-10-01, orders fomupdu7ne / fomupdu7w2 / fomupdu87j): the order said "Read
 * docs/PERF_PLAN_2026-10-01.md first", the planner call landed on a cheap tier, and the model
 * answered with a TOOL-CALL block instead of the plan JSON:
 *   <|DSML| calls> <|DSML| invoke name="Read"> ... docs\PERF_PLAN_2026-10-01.md ...
 * planOrder stored that markup as `order.plan`, built ZERO work orders and failed the order with
 * "the planner did not return parseable JSON" - so the failure could not be told apart from prose.
 *
 * This harness drives the REAL planner (`createFleetOrder` -> `planOrder` -> the real
 * `planOrReviewModel` / brain gate / Claude CLI path) with a STUB MODEL that answers the way the
 * measured model did. Nothing live is touched and nothing is spent:
 *   - a throwaway COMPANY_ROOT and FLEET_REPO (temp dirs),
 *   - Laya is a local stub (answers "BIG", so the gate really does pick a model call),
 *   - the gateway is a local stub that 429s (a stray gateway call would be counted and fail a check),
 *   - CLAUDE_BIN is a locally compiled stub that serves canned replies from files, and records the
 *     prompt it was handed, so the retry's extra instruction and the inlined file can be read back.
 *
 * Scenarios (both through the real planner function):
 *   A. the stub replies with the DSML tool call on call 1 and valid JSON on call 2
 *      -> the order gets work orders (awaiting_approval), and call 2 carried the no-tools
 *         instruction plus the contents of the file the order named.
 *   B. the stub replies with tool calls EVERY time
 *      -> it escalates ONCE (one extra model call, through the gate's Sonnet climb) and then
 *         fails with the KIND named (tool-call) on the trace and in the order error.
 *
 *   npx tsx ops/planner-toolcall-check.ts
 */
import "dotenv/config";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "planner-toolcall-"));
const repo = path.join(tmp, "repo");
process.env.COMPANY_ROOT = path.join(tmp, "company");
process.env.FLEET_REPO = repo;
process.env.MOCK_MODE = "0";
process.env.FLEET_AUTO_APPROVE = "0";
process.env.AIR_GAPPED = "0";
process.env.SLACK_BRIDGE = "0";
process.env.CLAUDE_BACKEND = "cli";
process.env.BUDGET_BRAIN_LAYA_MS = "5000";
process.env.DECISION_BACKEND = "laya";
// The planner's MAX tier must stay a Claude model: that is what makes "one tier up" == Sonnet.
delete process.env.FLEET_PLANNER_MODEL;
delete process.env.BUDGET_BRAIN_CHEAP_MODEL;
fs.mkdirSync(process.env.COMPANY_ROOT, { recursive: true });

// The file the ORDER TEXT names. Scenario A proves its contents reach the retry prompt.
const DOC_REL = "docs/PERF_PLAN_2026-10-01.md";
const DOC_MARKER = "UNIQUE-MARKER-9F3A-perf-item-5";
fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
fs.writeFileSync(path.join(repo, DOC_REL), `# PERF plan 2026-10-01\n\nITEM 5: add a decision cache.\n${DOC_MARKER}\n`);

const ORDER =
  `GOAL: implement PERF item 5 from ${DOC_REL} - cache Laya decisions in the router. ` +
  `Read ${DOC_REL} first, then plan the work. DELIVERABLES: the cache and a check script.`;

// The measured shape (fullwidth bars and all): a tool call, not a plan. It contains no `{`, which
// is exactly why the old code stored it as the "plan" instead of reporting a specific kind.
const DSML = [
  "<｜｜DSML｜｜ calls>",
  '<｜｜DSML｜｜ invoke name="Read">',
  `<｜｜DSML｜｜ parameter name="file_path" string="true">${DOC_REL}</｜｜DSML｜｜ parameter>`,
  "</｜｜DSML｜｜ invoke>",
  "</｜｜DSML｜｜ calls>",
].join("\n");

const PLAN_JSON = JSON.stringify({
  plan: "# Tool-call recovery plan\n\n1. Add the decision cache.\n2. Add the check script.",
  specDoc: null,
  workOrders: [
    {
      id: "WO-TC",
      title: "Add the decision cache",
      role: "coder",
      owns: ["docs/perf/decision-cache.txt"],
      brief: "Add the cache described by the plan and write the check script.",
      done: ["the file exists", "the check script passes"],
    },
  ],
});

const resultLine = (text: string) => JSON.stringify({ type: "result", is_error: false, result: text });

// ── the stub model (a real executable: the router spawns CLAUDE_BIN directly) ─────────────
// It serves `reply-<n>.json` for call n (falling back to reply-default.json), counts calls, and
// records the prompt it was handed. The state dir travels by ENV so the C# source stays ASCII.
const stateDir = path.join(tmp, "state");
fs.mkdirSync(stateDir, { recursive: true });
process.env.PLANNER_STUB_STATE = stateDir;
const binDir = path.join(tmp, "bin");
fs.mkdirSync(binDir, { recursive: true });
const claudeExe = path.join(binDir, process.platform === "win32" ? "claude.exe" : "claude");
if (process.platform === "win32") {
  const src = path.join(tmp, "stub-claude.cs");
  fs.writeFileSync(
    src,
    [
      "public class Program {",
      "  public static int Main(string[] args) {",
      '    string dir = System.Environment.GetEnvironmentVariable("PLANNER_STUB_STATE");',
      "    string inp = System.Console.In.ReadToEnd();",
      "    if (string.IsNullOrEmpty(dir)) return 2;",
      "    int n = 1;",
      '    string cf = System.IO.Path.Combine(dir, "count.txt");',
      '    try { n = int.Parse(System.IO.File.ReadAllText(cf).Trim()) + 1; } catch {}',
      "    System.IO.File.WriteAllText(cf, n.ToString());",
      '    try { System.IO.File.WriteAllText(System.IO.Path.Combine(dir, "prompt-" + n + ".txt"), inp); } catch {}',
      '    string f = System.IO.Path.Combine(dir, "reply-" + n + ".json");',
      "    if (!System.IO.File.Exists(f)) {",
      '      string d = System.IO.Path.Combine(dir, "reply-default.json");',
      "      if (System.IO.File.Exists(d)) f = d; else return 3;",
      "    }",
      "    byte[] b = System.IO.File.ReadAllBytes(f);",
      "    var so = System.Console.OpenStandardOutput();",
      "    so.Write(b, 0, b.Length);",
      "    so.WriteByte((byte)10);",
      "    so.Flush();",
      "    return 0;",
      "  }",
      "}",
    ].join("\n"),
  );
  const { execFileSync } = await import("node:child_process");
  const csc = path.join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  execFileSync(csc, ["/nologo", `/out:${claudeExe}`, src], { stdio: "inherit" });
} else {
  fs.writeFileSync(
    claudeExe,
    [
      "#!/bin/sh",
      'dir="$PLANNER_STUB_STATE"',
      '[ -z "$dir" ] && exit 2',
      'inp="$(cat)"',
      'n=$(( $(cat "$dir/count.txt" 2>/dev/null || echo 0) + 1 ))',
      'echo "$n" > "$dir/count.txt"',
      'printf \'%s\' "$inp" > "$dir/prompt-$n.txt"',
      'f="$dir/reply-$n.json"',
      '[ -f "$f" ] || f="$dir/reply-default.json"',
      '[ -f "$f" ] || exit 3',
      'cat "$f"; echo',
    ].join("\n") + "\n",
    { mode: 0o755 },
  );
}
process.env.CLAUDE_BIN = claudeExe;

const resetStub = (replies: Record<string, string>, fallback: string) => {
  for (const f of fs.readdirSync(stateDir)) fs.rmSync(path.join(stateDir, f), { force: true });
  for (const [name, text] of Object.entries(replies)) fs.writeFileSync(path.join(stateDir, name), resultLine(text));
  fs.writeFileSync(path.join(stateDir, "reply-default.json"), resultLine(fallback));
};
const stubCalls = () => {
  try {
    return Number(fs.readFileSync(path.join(stateDir, "count.txt"), "utf8").trim()) || 0;
  } catch {
    return 0;
  }
};
const stubPrompt = (n: number) => {
  try {
    return fs.readFileSync(path.join(stateDir, `prompt-${n}.txt`), "utf8");
  } catch {
    return "";
  }
};

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
};

function listen(handler: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      resolve({
        port: typeof addr === "object" && addr ? addr.port : 0,
        close: () => new Promise((r) => srv.close(() => r())),
      });
    });
  });
}

// ── local stubs: Laya (answers BIG) and the Go gateway (must never be reached) ─────────────
let layaCalls = 0;
const laya = await listen((req, res) => {
  req.on("data", () => {});
  req.on("end", () => {
    layaCalls++;
    res.writeHead(200, { "content-type": "application/json" });
    // BIG: top >= 0.33 and lead over `tiny` >= 0.08, so the gate really does spend a model call.
    res.end(JSON.stringify({ answers: { long: { noul: 0.9 }, multi: { noul: 0.85 }, tiny: { noul: 0.05 } } }));
  });
});
let gatewayCalls = 0;
const gateway = await listen((req, res) => {
  req.on("data", () => {});
  req.on("end", () => {
    gatewayCalls++;
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "GoUsageLimitError: the stub gateway must never be needed" } }));
  });
});
process.env.LAYA_BASE_URL = `http://127.0.0.1:${laya.port}`;
process.env.GATEWAY_BASE_URL = `http://127.0.0.1:${gateway.port}/v1`;

const fleet = await import("../src/company/fleet.js");
const { config } = await import("../src/config.js");
config.gatewayBaseUrl = process.env.GATEWAY_BASE_URL;
const { PLANNER_NO_TOOLS_INSTRUCTION } = fleet;

const settle = async (id: string, ms = 120_000) => {
  const t0 = Date.now();
  for (;;) {
    const o = fleet.getFleetOrder(id);
    if (o && o.status !== "planning") return o;
    if (Date.now() - t0 > ms) return fleet.getFleetOrder(id);
    await new Promise((r) => setTimeout(r, 250));
  }
};
const decisions = () =>
  (fs.existsSync(path.join(process.env.COMPANY_ROOT!, "budget", "brain-decisions.jsonl"))
    ? fs.readFileSync(path.join(process.env.COMPANY_ROOT!, "budget", "brain-decisions.jsonl"), "utf8").split(/\r?\n/).filter(Boolean)
    : []
  )
    .map((l) => {
      try {
        return JSON.parse(l) as { purpose?: string; tier?: string; climbed?: boolean; model?: string; reason?: string };
      } catch {
        return undefined;
      }
    })
    .filter(Boolean) as Array<{ purpose?: string; tier?: string; climbed?: boolean; model?: string; reason?: string }>;

console.log(`# planner-toolcall-check: sandbox ${tmp}`);
console.log(`# Laya stub :${laya.port} (BIG) | gateway stub :${gateway.port} (429) | stub model ${claudeExe}`);
console.log(`# order names ${DOC_REL} ("Read ... first"), exactly the shape that broke on 2026-10-01`);
console.log("");

// ── A: tool call first, JSON second -> work orders ─────────────────────────────────────────
console.log("=== A. stub model answers a TOOL CALL on call 1 and the plan JSON on call 2 ===");
resetStub({ "reply-1.json": DSML, "reply-2.json": PLAN_JSON }, PLAN_JSON);
const gwBeforeA = gatewayCalls;
const a = await fleet.createFleetOrder(ORDER);
const aDone = await settle(a.id);
const aTrace = (aDone?.trace ?? []).map((t: any) => `${t.what} :: ${String(t.detail ?? "")}`);
console.log(`  status=${aDone?.status} workOrders=${(aDone?.workOrders ?? []).length} stubCalls=${stubCalls()}`);
for (const t of aTrace) console.log(`  trace: ${t.slice(0, 150)}`);
check("A: the order got work orders instead of failing", (aDone?.workOrders ?? []).length > 0, `${(aDone?.workOrders ?? []).length} work order(s)`);
check("A: it is awaiting approval, not failed", aDone?.status === "awaiting_approval", String(aDone?.status));
check("A: the plan is the JSON plan, not the tool-call markup", !String(aDone?.plan ?? "").includes("DSML"), `plan starts: ${JSON.stringify(String(aDone?.plan ?? "").slice(0, 60))}`);
check("A: the retry hop names the kind (tool-call)", aTrace.some((t: string) => /retrying once/.test(t) && /kind=tool-call/.test(t)), aTrace.find((t: string) => /retrying once/.test(t))?.slice(0, 120) ?? "(no hop)");
check("A: the retry was exactly ONE extra model call", stubCalls() === 2, `stub calls: ${stubCalls()}`);
check("A: no escalation was needed (the retry worked)", !aTrace.some((t: string) => /escalating one tier/.test(t)), "no escalation hop");
const aPrompt1 = stubPrompt(1);
const aPrompt2 = stubPrompt(2);
check("A: call 1 was the plain planner prompt (no extra instruction)", !aPrompt1.includes(PLANNER_NO_TOOLS_INSTRUCTION), `${aPrompt1.length} chars`);
check("A: call 2 carried the exact no-tools instruction", aPrompt2.includes(PLANNER_NO_TOOLS_INSTRUCTION), PLANNER_NO_TOOLS_INSTRUCTION);
check("A: call 2 inlined the contents of the file the order named", aPrompt2.includes(DOC_MARKER) && aPrompt2.includes(`### ${DOC_REL}`), `prompt-2 ${aPrompt2.length} chars, marker ${aPrompt2.includes(DOC_MARKER)}`);
check("A: the gateway was never needed (no spend)", gatewayCalls === gwBeforeA, `gateway calls: ${gwBeforeA} -> ${gatewayCalls}`);

// ── B: tool calls every time -> escalate once, then fail with the kind named ───────────────
console.log("");
console.log("=== B. stub model answers TOOL CALLS every time ===");
resetStub({ "reply-1.json": DSML }, DSML);
const gwBeforeB = gatewayCalls;
const b = await fleet.createFleetOrder(ORDER);
const bDone = await settle(b.id);
const bTrace = (bDone?.trace ?? []).map((t: any) => `${t.what} :: ${String(t.detail ?? "")}`);
console.log(`  status=${bDone?.status} error=${JSON.stringify(String(bDone?.error ?? "").slice(0, 160))}`);
console.log(`  stubCalls=${stubCalls()} planAttempts=${bDone?.planAttempts}`);
for (const t of bTrace) console.log(`  trace: ${t.slice(0, 170)}`);
check("B: the order failed", bDone?.status === "failed", String(bDone?.status));
check("B: it escalated ONCE and then stopped (3 model calls: 1 + retry + 1 escalated)", stubCalls() === 3, `stub calls: ${stubCalls()}`);
check("B: the escalation hop is on the trace with its reason", bTrace.some((t: string) => /escalating one tier/.test(t)), bTrace.find((t: string) => /escalating one tier/.test(t))?.slice(0, 140) ?? "(no hop)");
check("B: the escalated attempt ran as sonnet through the gate", bTrace.some((t: string) => /^escalated planner attempt :: .*sonnet/.test(t)), bTrace.find((t: string) => /escalated planner attempt/.test(t))?.slice(0, 140) ?? "(no hop)");
const climbed = decisions().filter((d) => d.purpose === "fleet-plan" && d.climbed === true);
check("B: the gate logged the climb as a Sonnet climb (routing unchanged)", climbed.length === 1 && climbed[0]!.tier === "sonnet", `${climbed.length} climbed row(s): ${climbed.map((d) => `${d.tier}/${d.model}`).join(", ") || "none"}`);
check("B: the KIND (tool-call) is named on the failure hop", bTrace.some((t: string) => /plan warning :: .*kind: tool-call/.test(t)), bTrace.find((t: string) => /plan warning/.test(t))?.slice(0, 160) ?? "(no hop)");
check("B: the order error names the kind (tool-call)", /tool-call/.test(String(bDone?.error ?? "")), JSON.stringify(String(bDone?.error ?? "").slice(0, 130)));
check("B: the plan still shows the raw reply, so the CEO can see what came back", String(bDone?.plan ?? "").includes("DSML"), `plan starts: ${JSON.stringify(String(bDone?.plan ?? "").slice(0, 50))}`);
check("B: the climb was spent once (no leftover cheap-failure counter)", !fs.existsSync(path.join(process.env.COMPANY_ROOT!, "budget", "brain-failures.json")) || !Object.keys(JSON.parse(fs.readFileSync(path.join(process.env.COMPANY_ROOT!, "budget", "brain-failures.json"), "utf8"))).some((k) => k.startsWith("fleet-plan:")), "no fleet-plan counter left behind");
check("B: the gateway was never needed (no spend)", gatewayCalls === gwBeforeB, `gateway calls: ${gwBeforeB} -> ${gatewayCalls}`);
check("B: exactly one 'plan failed' hop", bTrace.filter((t: string) => /^plan failed ::/.test(t)).length === 1, `${bTrace.filter((t: string) => /^plan failed ::/.test(t)).length}`);
check("B: no planning-retry hops (the tool-call path is not the thrown-error path)", !bTrace.some((t: string) => /^planning retry/.test(t)), "none");

console.log("");
console.log(`Laya stub received ${layaCalls} question(s); gateway stub received ${gatewayCalls} request(s)`);
await laya.close();
await gateway.close();
console.log(`\n[check] ${failures ? `${failures} FAILED` : "ALL CHECKS PASSED"} (temp dir ${tmp})`);
process.exit(failures ? 1 : 0);
