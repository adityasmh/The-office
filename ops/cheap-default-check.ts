// ops/cheap-default-check.ts - CHEAP-DEFAULT (Job 2) call-site acceptance, self-contained.
//
// Proves the small-task path at the CALL SITE (not just the gate's decision):
//   A. a SMALL fleet order gets ONE locally built work order and makes NO planner model call
//      at all (0 gateway requests, no Claude process);
//   B. a BIG fleet order still engages the planner (Claude is attempted first);
//   C. the assistant purpose resolves a small order to `claudeCall: false` even when the
//      requested model is a Claude id (the ceiling must not force Claude).
//
// Safety: no server is started, :8787 is never touched, nothing is spent. COMPANY_ROOT is a
// throwaway directory, CLAUDE_BIN points at a file that does not exist (so any Claude attempt
// would fail loudly rather than spend), and Laya + the Go gateway are local stubs.
//
// Run: npx tsx ops/cheap-default-check.ts
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cheap-default-"));
process.env.COMPANY_ROOT = path.join(tmp, "company");
process.env.SLACK_BRIDGE = "0";
process.env.SLACK_SOCKET_MODE = "0";
delete process.env.MOCK_MODE;
process.env.CLAUDE_BIN = path.join(tmp, "no-such-claude.exe");
process.env.BUDGET_BRAIN_LAYA_MS = "5000";
fs.mkdirSync(process.env.COMPANY_ROOT, { recursive: true });

type Noul = { long: number; multi: number; tiny: number };
let layaAnswer: Noul = { long: 0.1, multi: 0.15, tiny: 0.75 }; // LOW by default: "not big"
let layaCalls = 0;
let gatewayCalls = 0;
const gatewayBodies: string[] = [];

function listen(handler: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ port, close: () => new Promise((r) => srv.close(() => r())) });
    });
  });
}

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  console.log(`        ${detail}`);
  if (!ok) failures += 1;
}

async function main(): Promise<void> {
  // ── local stubs: Laya (the decision service) and the Go gateway ────────────────────────
  const laya = await listen((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d.toString()));
    req.on("end", () => {
      layaCalls += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ answers: { long: { noul: layaAnswer.long }, multi: { noul: layaAnswer.multi }, tiny: { noul: layaAnswer.tiny } } }));
    });
  });
  const plannerJson = JSON.stringify({
    plan: "stub planner: two work orders",
    workOrders: [
      { id: "WO-1", title: "Stub A", role: "coder", owns: ["stub-a.txt"], brief: "stub A brief", done: ["stub A done"] },
      { id: "WO-2", title: "Stub B", role: "coder", owns: ["stub-b.txt"], brief: "stub B brief", done: ["stub B done"] },
    ],
  });
  const gateway = await listen((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d.toString()));
    req.on("end", () => {
      gatewayCalls += 1;
      gatewayBodies.push(body.slice(0, 400));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: plannerJson } }], usage: {} }));
    });
  });
  process.env.LAYA_BASE_URL = `http://127.0.0.1:${laya.port}`;
  process.env.GATEWAY_BASE_URL = `http://127.0.0.1:${gateway.port}`;
  process.env.DECISION_BACKEND = "laya";

  const { createFleetOrder, getFleetOrder } = await import("../src/company/fleet.js");
  const { pickBrain, resolveBrainModel, brainStats } = await import("../src/company/brainRouter.js");
  const { config } = await import("../src/config.js");

  const waitForPlan = async (id: string, ms = 20000) => {
    const until = Date.now() + ms;
    for (;;) {
      const o = getFleetOrder(id);
      if (o && o.status !== "planning") return o;
      if (Date.now() > until) return getFleetOrder(id);
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  console.log(`# cheap-default-check: sandbox ${tmp}`);
  console.log(`# Laya stub :${laya.port} | gateway stub :${gateway.port} | CLAUDE_BIN=${process.env.CLAUDE_BIN} (does not exist)`);
  console.log("");

  // ── A. a SMALL fleet order: one local work order, no planner call ──────────────────────
  console.log("=== A. SMALL ORDER (Laya stub says: not big) ===");
  layaAnswer = { long: 0.1, multi: 0.15, tiny: 0.75 };
  const gwBefore = gatewayCalls;
  const small = await createFleetOrder("rename the 'Submit' label to 'Send' on the settings page");
  const smallDone = await waitForPlan(small.id);
  const smallOrders = smallDone?.workOrders ?? [];
  const smallPlan = String(smallDone?.plan ?? "");
  const smallTrace = (smallDone?.trace ?? []).map((t) => `${t.from}->${t.to}:${t.what}`).join(" | ");
  console.log(`  status=${smallDone?.status} workOrders=${smallOrders.length} plan="${smallPlan.slice(0, 80)}"`);
  console.log(`  trace: ${smallTrace}`);
  check("the small order got exactly ONE work order", smallOrders.length === 1, `${smallOrders.length} work order(s)`);
  check("the work order was built locally (cheap default plan)", /cheap default/i.test(smallPlan), `plan="${smallPlan.slice(0, 60)}"`);
  check("the small order made ZERO gateway (planner model) calls", gatewayCalls === gwBefore, `gateway calls: ${gwBefore} -> ${gatewayCalls}`);
  check("no Claude process was ever spawned", !/claude -p|no-such-claude|ENOENT/i.test(JSON.stringify(smallDone)), "the order carries no Claude/ENOENT evidence");
  check("the trace records the gate decision", /Laya \(brain\)/.test(smallTrace) && /one work order, no planner/.test(smallTrace), smallTrace.slice(0, 120));

  // ── B. a BIG fleet order: the planner path is engaged (Claude attempted first) ─────────
  console.log("");
  console.log("=== B. BIG ORDER (Laya stub says: big) ===");
  layaAnswer = { long: 0.9, multi: 0.85, tiny: 0.05 };
  const gwBeforeBig = gatewayCalls;
  const big = await createFleetOrder("add a multi-file feature: a new API endpoint plus a database migration and a UI page");
  const bigDone = await waitForPlan(big.id);
  const bigTraceFull = (bigDone?.trace ?? []).map((t) => `${t.what}:${String(t.detail ?? "")}`).join(" | ");
  const bigTrace = bigTraceFull.slice(0, 400);
  console.log(`  status=${bigDone?.status} workOrders=${(bigDone?.workOrders ?? []).length}`);
  console.log(`  trace: ${bigTrace}`);
  check("the big order engaged the planner (Claude was attempted)",
    /planner (fallback|via) kimi/.test(bigTraceFull) && /no-such-claude|ENOENT|Failed to launch|not found/i.test(bigTraceFull),
    "trace shows the Claude attempt and its fallback");

  // ── C. the gate's own rows: small = no Claude, big = Claude ────────────────────────────
  console.log("");
  console.log("=== C. GATE ROWS + THE ASSISTANT CEILING ===");
  layaAnswer = { long: 0.1, multi: 0.15, tiny: 0.75 }; // back to "not big" before the small check
  const assigned = await pickBrain({ purpose: "assistant", text: "rename the 'Submit' label to 'Send' on the settings page", needsFiles: true });
  const assignedResolved = resolveBrainModel(assigned, config.claudeOpus, "assistant");
  check("a small assistant order with a Claude CEILING still makes no Claude call",
    assigned.claudeCall === false && assignedResolved.claudeCall === false && assignedResolved.model === "deepseek-v4.1-flash",
    `tier=${assignedResolved.tier} model=${assignedResolved.model} claudeCall=${assignedResolved.claudeCall}`);

  layaAnswer = { long: 0.9, multi: 0.85, tiny: 0.05 };
  const bigPick = await pickBrain({ purpose: "assistant", text: "add a multi-file feature across six files", needsFiles: true });
  const bigResolved = resolveBrainModel(bigPick, config.claudeOpus, "assistant");
  check("a big assistant order does reach Claude (assistant never takes Opus)",
    bigResolved.claudeCall === true && bigResolved.tier === "sonnet",
    `tier=${bigResolved.tier} model=${bigResolved.model} claudeCall=${bigResolved.claudeCall}`);

  const stats = brainStats();
  console.log("");
  console.log(`decision log: ${stats.calls} rows | byTier ${JSON.stringify(stats.byTier)} | claudeCalls ${stats.claudeCalls}, avoided ${stats.claudeAvoided} | Laya answered ${stats.layaAnswered}/${stats.layaFailed}`);
  console.log(`Laya stub received ${layaCalls} question(s); gateway stub received ${gatewayCalls} request(s)`);

  // ── D. the redo2 leak: the escalation must fire ONCE, not forever ──────────────────────
  console.log("");
  console.log("=== D. THE redo2 ESCALATION (measured live leak: 15 Opus reviews / 15 min) ===");
  const { redoEscalation } = await import("../src/company/runManagers.js");
  const oldRule = (h: Array<{ verdict?: string }>) => h.filter((c) => c.verdict === "REDO").length >= 2;
  const cases: Array<{ name: string; hist: Array<{ verdict?: "PASS" | "REDO" | "FAIL" }>; want: boolean }> = [
    { name: "2nd consecutive REDO escalates", hist: [{ verdict: "REDO" }, { verdict: "REDO" }], want: true },
    { name: "a 3rd REDO re-check does NOT re-escalate", hist: [{ verdict: "REDO" }, { verdict: "REDO" }, { verdict: "REDO" }], want: false },
    { name: "an older REDO pair does NOT keep escalating", hist: [{ verdict: "REDO" }, { verdict: "REDO" }, { verdict: "PASS" }, { verdict: "REDO" }], want: false },
    { name: "two REDOs separated by a PASS do not escalate", hist: [{ verdict: "REDO" }, { verdict: "PASS" }, { verdict: "REDO" }], want: false },
    { name: "no history / one REDO do not escalate", hist: [], want: false },
  ];
  let dOk = true;
  for (const c of cases) {
    const got = redoEscalation(c.hist);
    const old = oldRule(c.hist);
    dOk = dOk && got === c.want;
    console.log(`  ${got === c.want ? "ok  " : "BAD "} ${c.name}: new=${got} (old rule=${old})`);
  }
  check("the redo2 escalation fires once, on the 2nd consecutive REDO only", dOk, "see the cases above: the old rule returned true for the 2nd, 3rd and 4th histories too");

  // ── E. the Opus ladder must not drift from the measurements it was calibrated on ──────
  console.log("");
  console.log("=== E. THE CALIBRATED OPUS LADDER (derived from the measured pairs) ===");
  const { opusLadderShares, opusBarForShare, MEASURED_BIG_PAIRS } = await import("../src/company/brainRouter.js");
  const ladder = opusLadderShares();
  const documented: Array<[number, number, number]> = [[0.6, 0.08, 0.8], [0.65, 0.1, 0.3], [0.75, 0.2, 0.3], [0.8, 0.3, 0.2], [0.84, 0.4, 0.1]];
  let eOk = ladder.length === documented.length;
  for (const [p, lead, want] of documented) {
    const got = ladder.find((b) => Math.abs(b.p - p) < 1e-9 && Math.abs(b.lead - lead) < 1e-9);
    const ok = !!got && Math.abs(got.share - want) < 1e-9;
    eOk = eOk && ok;
    console.log(`  ${ok ? "ok  " : "BAD "} ${p.toFixed(2)}/${lead.toFixed(2)} -> ${((got?.share ?? -1) * 100).toFixed(0)}% (documented ${(want * 100).toFixed(0)}%)`);
  }
  const chosen30 = opusBarForShare(0.3);
  const handBar = MEASURED_BIG_PAIRS.filter(([t, l]) => t >= 0.92 && l >= 0.85).length;
  console.log(`  bars: target 0.30 -> ${chosen30.p}/${chosen30.lead} | the hand-raised 0.92/0.85 would reach ${handBar}/${MEASURED_BIG_PAIRS.length} (${((handBar / MEASURED_BIG_PAIRS.length) * 100).toFixed(0)}%)`);
  check("the ladder reproduces the documented shares and picks 0.75/0.20 for a 30% target",
    eOk && chosen30.p === 0.75 && chosen30.lead === 0.2 && handBar === 0,
    `${ladder.length} bars derived from ${MEASURED_BIG_PAIRS.length} measured pairs; target 0.30 -> ${chosen30.p}/${chosen30.lead}`);

  // ── F. the cheap-failure safety net (BUDGET/otter's finding: it was inert) ──
  console.log("");
  console.log("=== F. SAFETY NET: 2 cheap failures -> ONE Sonnet attempt ===");
  layaAnswer = { long: 0.1, multi: 0.15, tiny: 0.75 }; // small: the tier is `none`
  let broke429 = 0;
  const broke = await listen((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d.toString()));
    req.on("end", () => {
      broke429 += 1;
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "GoUsageLimitError: no credit" } }));
    });
  });
  const { callClaudeSubscription } = await import("../src/claudeSubscription.js");
  const { cheapFailures, clearCheapFailures } = await import("../src/company/brainRouter.js");
  const key = "check:safety-net";
  // `config` is already bound in section C; mutating it is how a stubbed gateway is swapped in.
  const goodGateway = config.gatewayBaseUrl;
  config.gatewayBaseUrl = `http://127.0.0.1:${broke.port}`; // the cheap tier now 429s
  clearCheapFailures(key);
  const outcomes: string[] = [];
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await callClaudeSubscription({ purpose: "plan", user: "rename the 'Submit' label to 'Send'", failureKey: key });
      outcomes.push(`attempt ${i}: returned tier=${r.brain?.tier}`);
    } catch (e) {
      const msg = String(e);
      outcomes.push(`attempt ${i}: threw ${/ENOENT|no-such-claude/i.test(msg) ? "the CLAUDE attempt (ENOENT)" : /429|GoUsageLimit/i.test(msg) ? "the cheap tier 429" : msg.slice(0, 60)}`);
    }
  }
  config.gatewayBaseUrl = goodGateway;
  await broke.close();
  for (const o of outcomes) console.log(`  ${o}`);
  const fRows = (fs.existsSync(path.join(process.env.COMPANY_ROOT!, "budget", "brain-decisions.jsonl"))
    ? fs.readFileSync(path.join(process.env.COMPANY_ROOT!, "budget", "brain-decisions.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return undefined; } }).filter(Boolean)
    : []) as Array<{ purpose?: string; tier?: string; climbed?: boolean; asked?: boolean }>;
  const climbed = fRows.filter((r) => r.climbed === true);
  console.log(`  rows with climbed=true: ${climbed.length} (tiers: ${climbed.map((r) => r.tier).join(", ") || "none"})`);
  console.log(`  cheap-failure counter after the climb: ${cheapFailures(key)} (0 = the one attempt was spent and reset)`);
  check("the cheap tier's TWO failures escalated the THIRD attempt to Sonnet (the net is live)",
    broke429 === 2 && /ENOENT|no-such-claude/i.test(outcomes[2] ?? "") && climbed.length === 1 && climbed[0]!.tier === "sonnet",
    `429s=${broke429}; outcomes=${outcomes.join(" | ")}`);
  check("the climb is spent once (counter reset), so the next failure starts a fresh cycle",
    cheapFailures(key) === 0, `cheapFailures(${key})=${cheapFailures(key)}`);

  await laya.close();
  await gateway.close();
  console.log("");
  if (failures) {
    console.log(`CHEAP-DEFAULT CHECK FAILED: ${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log("CHEAP-DEFAULT CHECK ALL PASS");
  }
}

main().catch((e) => {
  console.error("cheap-default-check crashed:", e);
  process.exitCode = 1;
});
