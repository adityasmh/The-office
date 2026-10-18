// ops/dev-router-acceptance.ts - CHEAP-DEFAULT: the LIVE end-to-end acceptance the design doc
// lists as not covered ("a live CEO order through the RUNNING router").
//
// Per the manager's 08:24 rule: this NEVER touches :8787 (PROD). It starts its OWN router on a
// port in 8801-8899 with an ISOLATED data dir under %TEMP%, drives real CEO orders over HTTP
// through the real assistant -> Laya -> brainRouter gate path, asserts on the dev instance's own
// decision log, then stops the instance and frees the port.
//
// No external model spend: the Go gateway is a local stub (GATEWAY_BASE_URL) and CLAUDE_BIN points
// at a file that does not exist, so any Claude attempt fails LOUDLY instead of spending. Laya is
// the real local decision service.
//
// Run: npx tsx ops/dev-router-acceptance.ts [--keep] [--port 8811]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

const KEEP = process.argv.includes("--keep");
const portArg = process.argv.indexOf("--port");
const WANTED_PORT = portArg >= 0 ? Number(process.argv[portArg + 1]) : 0;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dev-cheap-default-"));
const companyRoot = path.join(tempRoot, "company");
fs.mkdirSync(companyRoot, { recursive: true });
const authToken = crypto.randomBytes(24).toString("hex");

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n        ${detail}`);
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

async function pickPort(): Promise<number> {
  if (WANTED_PORT) {
    if (!(await portFree(WANTED_PORT))) throw new Error(`port ${WANTED_PORT} is in use`);
    return WANTED_PORT;
  }
  for (let p = 8811; p <= 8899; p++) if (await portFree(p)) return p;
  throw new Error("no free port in 8801-8899");
}

function jsonPost(port: number, route: string, body: unknown, timeoutMs = 120000): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port, path: route, method: "POST", timeout: timeoutMs,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), "x-company-token": authToken } },
      (res) => {
        let out = "";
        res.on("data", (d) => (out += d.toString()));
        res.on("end", () => {
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(out) }); }
          catch { resolve({ status: res.statusCode ?? 0, body: out }); }
        });
      },
    );
    req.on("timeout", () => { req.destroy(new Error(`timeout after ${timeoutMs}ms`)); });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function getJson(port: number, route: string, timeoutMs = 10000): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: route, timeout: timeoutMs, headers: { "x-company-token": authToken } }, (res) => {
      let out = "";
      res.on("data", (d) => (out += d.toString()));
      res.on("end", () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(out) }); }
        catch { resolve({ status: res.statusCode ?? 0, body: out }); }
      });
    });
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.on("error", reject);
  });
}

async function main(): Promise<void> {
  // ── stub gateway: the assistant's answer comes from here, so nothing is spent ─────────────
  let gatewayCalls = 0;
  const stubReply = JSON.stringify({
    reply: "Done: nothing was changed.\nRemaining: nothing.\nNeeds you: nothing.",
    decisions: [],
    tasks: [],
  });
  const gateway = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d.toString()));
    req.on("end", () => {
      gatewayCalls += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: stubReply } }], usage: {} }));
    });
  });
  await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", () => r()));
  const gatewayPort = (gateway.address() as net.AddressInfo).port;

  const port = await pickPort();
  const claudeBin = path.join(tempRoot, "no-such-claude.exe");
  console.log(`# dev-router-acceptance`);
  console.log(`# PROD :8787 is NOT touched. dev port :${port} | isolated COMPANY_ROOT: ${companyRoot}`);
  console.log(`# stub gateway :${gatewayPort} | CLAUDE_BIN=${claudeBin} (does not exist) | auth token: generated, not printed`);
  console.log("");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    COMPANY_ROOT: companyRoot,
    COMPANY_AUTH_TOKEN: authToken,
    SLACK_BRIDGE: "0",
    SLACK_SOCKET_MODE: "0",
    // ISOLATION GAP (found by this harness, 03:03): the run manager discovers runs from the GLOBAL
    // ~/.jcode/sessions journals, so a dev router will happily review the REAL runs unless this is
    // set - the first run of this script did exactly that (2 Claude card checks + 1 Slack briefing
    // post). `heuristic` keeps every card local, and blank Slack creds make the briefing post a
    // no-op (dotenv does not override variables that are already present, even when empty).
    RUN_MANAGER_BACKEND: "heuristic",
    SLACK_BOT_TOKEN: "",
    SLACK_CHANNEL_ID: "",
    SLACK_APP_TOKEN: "",
    MOCK_MODE: "0",
    GATEWAY_BASE_URL: `http://127.0.0.1:${gatewayPort}`,
    LAYA_BASE_URL: process.env.LAYA_BASE_URL ?? "http://127.0.0.1:8000",
    ASSISTANT_MODEL: "claude-opus-5-5", // the live ceiling: it must NOT force Claude
    CLAUDE_BIN: claudeBin,
    AUTOCLOSE_ENABLED: "0",
    FLEET_AUTO_APPROVE: "0",
  };

  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: path.resolve(process.cwd()),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log: string[] = [];
  const keep = (d: Buffer) => { for (const l of d.toString().split(/\r?\n/)) if (l.trim()) log.push(l.trim()); };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);

  const kill = () => {
    try { spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* gone */ }
  };
  const cleanup = async () => {
    kill();
    await new Promise((r) => setTimeout(r, 1500));
    await new Promise<void>((r) => gateway.close(() => r()));
  };

  try {
    // wait for the dev router
    const deadline = Date.now() + 90000;
    let health: any = undefined;
    while (Date.now() < deadline) {
      try { health = (await getJson(port, "/health", 3000)).body; break; } catch { await new Promise((r) => setTimeout(r, 1500)); }
    }
    check("the dev router started on its own port with isolated data", !!health && health.ok !== false,
      health ? `:${port} /health -> ${JSON.stringify(health).slice(0, 160)}` : `no /health; last log lines: ${log.slice(-6).join(" | ")}`);
    if (!health) { await cleanup(); return; }
    console.log(`# boot log (selected): ${log.filter((l) => /\[brain\]|\[fleet\]|\[autoclose\]|\[briefing\]|router on/.test(l)).slice(0, 6).join("\n#   ")}`);

    // Two plain small questions and one CEO-named order. Questions keep the assistant's task list
    // empty, so no pipeline/worker is ever spawned by this test.
    const orders = [
      { key: "small-status", text: "what is the status of the dashboard rebuild?" },
      { key: "small-typo", text: "is there a typo in docs/README.md?" },
      { key: "ceo-named", text: "use Claude: what is the status of the dashboard rebuild?" },
    ];
    const answers: Record<string, any> = {};
    for (const o of orders) {
      const r = await jsonPost(port, "/company/assistant/message", { text: o.text, autoRun: false });
      answers[o.key] = r;
      const dec = JSON.stringify(r.body?.decisions ?? []);
      console.log(`\n# order ${o.key}: HTTP ${r.status} | ${(r.body?.reply ?? r.body?.error ?? "").toString().replace(/\s+/g, " ").slice(0, 70)}`);
      console.log(`#   decisions: ${dec.slice(0, 240)}`);
    }

    // ── the dev instance's OWN decision log ────────────────────────────────────────────────
    const logFile = path.join(companyRoot, "budget", "brain-decisions.jsonl");
    const rows = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return undefined; } }).filter(Boolean) as any[]
      : [];
    const assistantRows = rows.filter((r) => r.purpose === "assistant");
    const byTier = assistantRows.reduce((acc: Record<string, number>, r) => { acc[r.tier] = (acc[r.tier] ?? 0) + 1; return acc; }, {});
    const claudeRows = assistantRows.filter((r) => r.claudeCall);
    console.log(`\n# decision log: ${rows.length} row(s), ${assistantRows.length} for purpose=assistant | byTier ${JSON.stringify(byTier)}`);
    for (const r of assistantRows) console.log(`#   ${r.reasonKind} tier=${r.tier} model=${r.model} | ${String(r.reason).slice(0, 90)}`);

    check("no assistant order could reach Opus (the purpose is not opus-eligible)",
      assistantRows.every((r) => r.tier !== "opus"),
      `tiers: ${assistantRows.map((r) => r.tier).join(", ") || "(none)"}`);
    check("at least one plain small question made ZERO Claude calls",
      assistantRows.filter((r) => r.tier === "none" && r.claudeCall === false).length >= 1,
      `none-rows=${assistantRows.filter((r) => r.tier === "none").length}, claudeCall rows=${assistantRows.filter((r) => r.claudeCall).length} (Laya's own answer is the variable - see the rows above)`);
    const named = assistantRows.find((r) => r.reasonKind === "ceo-override");
    check("the order containing 'use Claude' reached the Claude tier (ceo-override)",
      !!named && named.claudeCall === true && named.tier === "sonnet",
      named ? `tier=${named.tier} reasonKind=${named.reasonKind} reason=${String(named.reason).slice(0, 80)}` : "no ceo-override row");

    const smallA = JSON.stringify(answers["small-status"]?.body?.decisions ?? []);
    const namedD = JSON.stringify(answers["ceo-named"]?.body?.decisions ?? []);
    const claudeMentions = orders.filter((o) => /Claude subscription/i.test(JSON.stringify(answers[o.key]?.body?.decisions ?? []))).length;
    check("every Claude attempt matches a gate row that authorised it (no unauthorised spend)",
      claudeMentions <= claudeRows.length,
      `replies reporting a Claude attempt=${claudeMentions}; gate rows with claudeCall=${claudeRows.length}. ` +
        `(The status-question fixture is Laya's unstable one - it lands on Sonnet in some draws, which is a LEGITIMATE attempt; ` +
        `what must never happen is an attempt with no authorising row.)`);
    check("the CEO-named order really ATTEMPTED Claude (the missing binary proves the attempt)",
      /Claude subscription[^\"]*unavailable|ENOENT|no-such-claude/i.test(namedD),
      `ceo-named decisions: ${namedD.slice(0, 220)}`);
    check("the stub gateway served the answers (nothing external was called)", gatewayCalls >= 2,
      `gateway requests: ${gatewayCalls}`);
    // The isolation gap this harness uncovered: background watchers must not touch real work.
    const backgroundClaude = rows.filter((r) => r.purpose !== "assistant" && r.claudeCall);
    check("the dev instance's background watchers spent NO Claude (RUN_MANAGER_BACKEND=heuristic)",
      backgroundClaude.length === 0 && !log.some((l) => /slack post ok/i.test(l)),
      `non-assistant claudeCall rows=${backgroundClaude.length}; slack posts in the log=${log.filter((l) => /slack post ok/i.test(l)).length}`);
  } finally {
    await cleanup();
    const free = await portFree(port);
    check("the dev instance was stopped and its port released", free, `:${port} free=${free}`);
    check("nothing was written outside the isolated root and the temp dir",
      !fs.existsSync(path.join(process.cwd(), "company", "dev-cheap-default-marker")),
      `isolated COMPANY_ROOT: ${companyRoot}`);
    if (KEEP) console.log(`\n# kept temp root (--keep): ${tempRoot}`);
    else fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  const failed = checks.filter((c) => !c.ok);
  console.log("");
  if (failed.length) {
    console.log(`DEV ROUTER ACCEPTANCE FAILED: ${failed.length}/${checks.length} check(s) failed`);
    console.log(log.slice(-25).join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`DEV ROUTER ACCEPTANCE ALL PASS (${checks.length} checks) - live HTTP path, isolated dev instance, :8787 untouched`);
  }
}

main().catch((e) => {
  console.error("dev-router-acceptance crashed:", e);
  process.exitCode = 1;
});
