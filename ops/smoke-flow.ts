// Isolated end-to-end smoke for the hand-off chain and the gate/resume wiring.
//
// Unlike ops/smoke-company.ts (which asserts against the LIVE router on :8787),
// this harness is fully self-contained and hermetic:
//
//   * it builds a throw-away COMPANY_ROOT under the OS temp dir (a project with a
//     default 7-role team, created by the real createProject()), so it can never
//     read or write the live company/ folder;
//   * it starts its own `node --import tsx src/server.ts` on a free port with
//     MOCK_MODE=1, SLACK_BRIDGE=0, SLACK_SOCKET_MODE=0 and fake Slack creds, so
//     no provider is called and no Slack message can be posted;
//   * the only un-mocked model path - the CEO assistant's planning call - is
//     served by a tiny in-process HTTP stub gateway (GATEWAY_BASE_URL), so the
//     run is deterministic and offline;
//   * everything it starts is killed and the temp root removed on exit.
//
// What it proves (the four invariants in the work order):
//   (a) a task driven through the pipeline records task.trace hops IN ORDER:
//       CEO -> Assistant -> Laya -> Assistant -> Claude (manager) -> plan ->
//       Claude (manager) -> <model> (coder-N) -> result -> Claude (manager)
//       review: PASS -> Assistant (done) -> CEO (report);
//   (b) GET /company/flow returns that same task with the same trace;
//   (c) a task parked at the intake gate is resumed by
//       POST /company/projects/:id/tasks/:tid/approve-intake with resumed:true,
//       and then proceeds (through the code and merge gates) to merged;
//   (d) a task left mid-flight by a restart is AUTO-RESUMED by boot reconcile
//       (docs/RESUME_SPEC.md §2: it is no longer marked failed) and records the
//       Router "restarted at <stage>" hop; a task already in `failed` still resumes
//       via POST /company/projects/:id/run {"taskId": ...}; a task marked
//       pausedByShutdown (docs/SHUTDOWN_SPEC.md) resumes without counting an
//       interruption.
//
// Usage:
//   npx tsx ops/smoke-flow.ts [--gate-seconds 2] [--timeout 20000] [--keep] [--json]
//
// Exit code 0 when every check passes, 1 otherwise. No secret is ever printed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

type CheckTag = "free" | "mutating";
type Check = { n: number; name: string; tag: CheckTag; ok: boolean; detail: string };
const checks: Check[] = [];

function record(n: number, name: string, tag: CheckTag, ok: boolean, detail: string) {
  checks.push({ n, name, tag, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} [${n}] ${name} (${tag})`);
  if (detail) console.log(`      ${detail}`);
}

function trim(v: unknown, max = 500): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s === undefined) return "undefined";
  return s.length > max ? s.slice(0, max) + `…(+${s.length - max} chars)` : s;
}

function errStr(e: unknown): string {
  const cause = (e as any)?.cause;
  const c = cause ? ` | cause=${cause.code ?? ""} ${cause.message ?? String(cause)}` : "";
  return trim(String(e) + c, 300);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- CLI -------------------------------------------------------------------

const args = process.argv.slice(2);
let gateSeconds = 2;
let timeoutMs = 20000;
let keep = false;
let emitJson = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--gate-seconds" && args[i + 1]) gateSeconds = Number(args[++i]) || gateSeconds;
  else if (a.startsWith("--gate-seconds=")) gateSeconds = Number(a.slice("--gate-seconds=".length)) || gateSeconds;
  else if (a === "--timeout" && args[i + 1]) timeoutMs = Number(args[++i]) || timeoutMs;
  else if (a.startsWith("--timeout=")) timeoutMs = Number(a.slice("--timeout=".length)) || timeoutMs;
  else if (a === "--keep") keep = true;
  else if (a === "--json") emitJson = true;
  else if (a === "-h" || a === "--help") {
    console.log("usage: npx tsx ops/smoke-flow.ts [--gate-seconds N] [--timeout ms] [--keep] [--json]");
    process.exit(0);
  }
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const MANAGER = "Claude (manager)";

// --- small helpers ---------------------------------------------------------

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("could not allocate a port"))));
    });
  });
}

type ReqResult = { status: number; json: any; raw: string };
let base = "";
let token = "";

async function req(method: string, urlPath: string, body?: unknown, perReqTimeout = timeoutMs): Promise<ReqResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), perReqTimeout);
  try {
    const headers: Record<string, string> = { "x-company-token": token };
    let payload: string | undefined;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + urlPath, { method, headers, body: payload, signal: ctrl.signal });
    const raw = await res.text();
    let json: any = undefined;
    try {
      json = JSON.parse(raw);
    } catch {
      /* leave undefined */
    }
    return { status: res.status, json, raw };
  } finally {
    clearTimeout(timer);
  }
}

async function getTasks(pid: string): Promise<any[]> {
  const r = await req("GET", `/company/projects/${pid}/tasks`);
  return Array.isArray(r.json) ? r.json : [];
}

async function getTask(pid: string, tid: string): Promise<any | undefined> {
  return (await getTasks(pid)).find((t) => t?.id === tid);
}

// Poll until pred(task) is true; returns the last task seen (undefined if never).
async function waitForTask(
  pid: string,
  tid: string,
  pred: (t: any) => boolean,
  limitMs = timeoutMs,
): Promise<{ task?: any; waitedMs: number; seen: string[] }> {
  const started = Date.now();
  const seen: string[] = [];
  for (;;) {
    const t = await getTask(pid, tid).catch(() => undefined);
    if (t) {
      const s = String(t.status);
      if (seen[seen.length - 1] !== s) seen.push(s);
      if (pred(t)) return { task: t, waitedMs: Date.now() - started, seen };
    }
    if (Date.now() - started > limitMs) return { task: t, waitedMs: Date.now() - started, seen };
    await sleep(200);
  }
}

// Drive a task to `merged` by approving each gate as it parks. Deliberately
// tolerant of the gate-poll race: approving a gate while the pipeline is still
// polling its 500ms loop makes the running waitGate() pick the flag up, while a
// fully parked task is resumed by the route's resumeTask(). Both are correct.
async function settleMerged(
  pid: string,
  tid: string,
  limitMs = timeoutMs * 2,
): Promise<{ task?: any; steps: string[]; seen: string[]; doneHop: boolean }> {
  const started = Date.now();
  const steps: string[] = [];
  const seen: string[] = [];
  let approvedCode = false;
  let approvedMerge = false;
  let mergedAt = 0;
  let last: any;
  for (;;) {
    const t = await getTask(pid, tid).catch(() => undefined);
    if (t) {
      last = t;
      const s = String(t.status);
      if (seen[seen.length - 1] !== s) seen.push(s);
      const doneHop = hops(t.trace).some((h) => h.from === MANAGER && h.to === "Assistant" && h.what === "done");
      if (s === "failed") return { task: t, steps, seen, doneHop };
      if (s === "merged") {
        // approveGate() sets status "merged" synchronously, but the still-polling
        // pipeline appends its final [done] hop a moment later. Give it a short
        // grace window before reporting.
        if (!mergedAt) mergedAt = Date.now();
        if (doneHop || Date.now() - mergedAt > 2500) return { task: t, steps, seen, doneHop };
      } else {
        mergedAt = 0;
        if (!approvedCode && s === "pending_code") {
          approvedCode = true;
          const r = await req("POST", `/company/projects/${pid}/tasks/${tid}/approve-code`, {});
          steps.push(`approve-code resumed=${r.json?.resumed}`);
          continue;
        }
        if (!approvedMerge && s === "pending_merge") {
          approvedMerge = true;
          const r = await req("POST", `/company/projects/${pid}/tasks/${tid}/approve-merge`, {});
          steps.push(`approve-merge status=${r.json?.status} resumed=${r.json?.resumed}`);
          continue;
        }
      }
    }
    if (Date.now() - started > limitMs) return { task: last, steps, seen, doneHop: false };
    await sleep(200);
  }
}

// --- trace assertions ------------------------------------------------------

type Hop = { from: string; to: string; what: string };

function hops(trace: unknown): Hop[] {
  return (Array.isArray(trace) ? trace : []).map((h: any) => ({
    from: String(h?.from ?? ""),
    to: String(h?.to ?? ""),
    what: String(h?.what ?? ""),
  }));
}

// The work phase: the manager hands the order to a coder, the coder reports
// back, and the manager records its review verdict. Shared by all three task
// scenarios. The final [done] hop is deliberately NOT required here: a task
// approved at a fully parked merge gate gets status "merged" from approveGate()
// but resumeTask() refuses an already-merged task, so no [done] hop is recorded
// (see the finding in docs/SMOKE_TESTS.md).
function workPhaseProblems(trace: Hop[], from = 0): string[] {
  const bad: string[] = [];
  const at = (pred: (h: Hop) => boolean, start: number) => trace.findIndex((h, i) => i >= start && pred(h));

  let i = at((h) => h.from === MANAGER && /\(coder-\d+\)$/.test(h.to) && h.what === "work order", from);
  if (i < 0) bad.push("missing hop Claude (manager) -> <model> (coder-N) [work order]");
  const iWork = i;

  i = at((h) => /\(coder-\d+\)$/.test(h.from) && h.to === MANAGER && h.what === "result", iWork + 1);
  if (i < 0) bad.push("missing hop <model> (coder-N) -> Claude (manager) [result]");
  const iResult = i;

  i = at((h) => h.from === MANAGER && h.to === MANAGER && /^review: (PASS|LOOP)$/.test(h.what), iResult + 1);
  if (i < 0) bad.push("missing Claude (manager) review hop [review: PASS|LOOP] after the coder result");
  return bad;
}

// Work phase plus the manager's plan hop (present when the pipeline planned the
// task itself, i.e. it was not resumed from a pre-planned task record).
function workChainProblems(trace: Hop[], from = 0): string[] {
  const at = (pred: (h: Hop) => boolean, start: number) => trace.findIndex((h, i) => i >= start && pred(h));
  const iPlan = at((h) => h.to === MANAGER && h.what === "plan", from);
  const bad = iPlan < 0 ? ["missing hop -> Claude (manager) [plan]"] : [];
  bad.push(...workPhaseProblems(trace, iPlan + 1));
  return bad;
}

// The full CEO-anchored chain (scenario a). Only the assistant path records the
// CEO/Assistant/Laya team hops, which is exactly why scenario (a) goes through
// POST /company/assistant/message, and only an un-gated (auto) run is guaranteed
// to reach the final [done] + [report] hops.
function fullChainProblems(trace: Hop[]): string[] {
  const bad: string[] = [];
  const at = (pred: (h: Hop) => boolean, start: number) => trace.findIndex((h, i) => i >= start && pred(h));

  let i = at((h) => h.from === "CEO" && h.to === "Assistant" && h.what === "order", 0);
  if (i < 0) bad.push("missing first hop CEO -> Assistant [order]");
  const iOrder = i;

  i = at((h) => h.from === "Assistant" && h.to === "Laya", iOrder + 1);
  if (i < 0) bad.push("missing hop Assistant -> Laya");
  const iToLaya = i;

  i = at((h) => h.from === "Laya" && h.to === "Assistant" && /^team:/.test(h.what), iToLaya + 1);
  if (i < 0) bad.push("missing hop Laya -> Assistant [team: ...]");
  const iTeam = i;

  i = at((h) => h.from === "Assistant" && h.to === MANAGER, iTeam + 1);
  if (i < 0) bad.push("missing hop Assistant -> Claude (manager)");
  const iToManager = i;

  bad.push(...workChainProblems(trace, iToManager + 1));

  const iDone = trace.findIndex((h) => h.from === MANAGER && h.to === "Assistant" && h.what === "done");
  if (iDone < 0) bad.push("missing hop Claude (manager) -> Assistant [done]");
  i = at((h) => h.from === "Assistant" && h.to === "CEO", iDone + 1);
  if (i < 0) bad.push("missing final hop Assistant -> CEO [report]");
  return bad;
}

function hopLine(h: Hop): string {
  return `${h.from} -> ${h.to} [${h.what}]`;
}

// --- the stub assistant-planner gateway ------------------------------------

// In MOCK_MODE every pipeline role is mocked, but the CEO assistant's planning
// call is NOT (assistant.ts -> callGatewayModel). Pointing GATEWAY_BASE_URL at
// this stub keeps the whole run offline and deterministic.
function startStubGateway(content: string): Promise<{ url: string; calls: () => number; close: () => Promise<void> }> {
  let calls = 0;
  const srv = http.createServer((r, res) => {
    let body = "";
    r.on("data", (d) => (body += d));
    r.on("end", () => {
      if (r.method === "POST" && (r.url ?? "").includes("/chat/completions")) {
        calls++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content } }], usage: { mocked: true } }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "stub gateway: only POST /v1/chat/completions" }));
    });
  });
  return new Promise((resolve, reject) => {
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        calls: () => calls,
        close: () => new Promise((r) => srv.close(() => r())),
      });
    });
  });
}

// --- main ------------------------------------------------------------------

let child: ChildProcess | undefined;
let stub: Awaited<ReturnType<typeof startStubGateway>> | undefined;
let tempRoot = "";
const serverOut: string[] = [];
let cleanedUp = false;

function killServer() {
  if (!child || child.exitCode !== null || !child.pid) return;
  try {
    // The child is a plain `node` process; /T is belt-and-braces for any helper.
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* fall through */
  }
  try {
    child.kill();
  } catch {
    /* already gone */
  }
}

async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  killServer();
  if (stub) await stub.close().catch(() => {});
  if (tempRoot && !keep) {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  if (keep && tempRoot) console.log(`# kept temp COMPANY_ROOT: ${tempRoot}`);
}

function lastServerLines(n = 25): string {
  const lines = serverOut.join("").split(/\r?\n/).filter((l) => l.trim());
  return lines.slice(-n).join("\n      ");
}

async function main() {
  const port = await freePort();

  // 1. Throw-away company root, built by the real createProject().
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jcode-smoke-flow-"));
  const companyRoot = path.join(tempRoot, "company");
  fs.mkdirSync(companyRoot, { recursive: true });
  process.env.COMPANY_ROOT = companyRoot; // BEFORE importing anything that reads it
  const org = await import("../src/company/org.js");
  const { project, department } = org.createProject({
    companyName: "Smoke Flow Co",
    departmentName: "Engineering",
    projectName: "Flow Smoke",
    description: "isolated smoke-flow fixture",
    coderCount: 2,
  });
  const pid = project.id;

  // 2. Fixtures for scenario (d).
  //    (d1) a task interrupted mid-"coding" by a restart (RESUME §2: boot now
  //         auto-resumes it instead of marking it failed); it already passed the
  //         intake and code gates, so the boot reconciler is the only thing that can
  //         still touch it. Resuming it continues at the work phase and parks at merge.
  //    (d2) a task already in `failed` (what a task looks like after two restarts
  //         caught it, or after any other failure): POST /run {taskId} resumes it.
  //    (d3) a task marked pausedByShutdown (a PLANNED stop, docs/SHUTDOWN_SPEC.md):
  //         boot resumes it and clears the flag WITHOUT counting an interruption.
  //    (d4) a task interrupted once ALREADY (interruptions: 1): the next restart is
  //         the second one, so boot must fail it with "interrupted twice by restarts"
  //         and the Briefing must show it under "Needs you".
  const fixtureId = `t${Date.now().toString(36)}fixture`;
  const fixtureBase = {
    projectId: pid,
    rawRequest: "Create a file hello.txt that greets the CEO in one short line.",
    enhancedBrief: "Smoke fixture brief: write one greeting line to hello.txt.",
    plan: "Smoke fixture plan: one coder writes hello.txt.",
    assignments: [
      {
        agentId: "coder-1",
        role: "coder",
        subtask: "Write hello.txt containing one greeting line for the CEO.",
        modelId: "kimi-k2.7-code",
      },
    ],
    gates: { intake: true, code: true, merge: false },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    loopCount: 0,
  };
  const fixture = { id: fixtureId, ...fixtureBase, status: "coding" };
  const failedFixtureId = `t${Date.now().toString(36)}failedfix`;
  const failedFixture = {
    id: failedFixtureId,
    ...fixtureBase,
    status: "failed",
    error: 'smoke fixture: this task is in "failed" (as after two restarts)',
  };
  const shutdownFixtureId = `t${Date.now().toString(36)}shutdownfix`;
  const shutdownFixture = { id: shutdownFixtureId, ...fixtureBase, status: "coding", pausedByShutdown: true };
  const twiceFixtureId = `t${Date.now().toString(36)}twicefix`;
  const twiceFixture = { id: twiceFixtureId, ...fixtureBase, status: "coding", interruptions: 1 };
  const projDir = path.join(companyRoot, "projects", pid);
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(
    path.join(projDir, "tasks.json"),
    JSON.stringify([fixture, failedFixture, shutdownFixture, twiceFixture], null, 2),
  );

  // 3. Stub gateway serving the assistant's plan.
  const planJson = JSON.stringify({
    reply: "Smoke order accepted: one coder task dispatched in the isolated company.",
    decisions: ["Isolated smoke-flow run (MOCK_MODE=1, stub gateway, temp COMPANY_ROOT)."],
    tasks: [
      {
        title: "Write hello.txt",
        departmentName: department.name,
        projectId: pid,
        role: "coder",
        // Deliberately free of the mock dispatcher's trigger words
        // (test/review/plan/summar/enhanc) so Laya's mock picks the coder.
        request: "Create a file hello.txt that greets the CEO in one short line.",
      },
    ],
  });
  stub = await startStubGateway(planJson);

  // 4. Server: isolated root, mock mode, no Slack, tiny gate wait.
  token = crypto.randomBytes(16).toString("hex");
  base = `http://127.0.0.1:${port}`;
  console.log(`# smoke-flow: isolated server on ${base}`);
  console.log(`# temp COMPANY_ROOT: ${companyRoot}`);
  console.log(`# project: ${pid} ("${project.name}", department "${department.name}")`);
  console.log(`# stub gateway: ${stub.url} | gate wait: ${gateSeconds}s | mockMode: 1 | slack bridge: off`);

  child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      COMPANY_ROOT: companyRoot,
      COMPANY_AUTH_TOKEN: token,
      MOCK_MODE: "1",
      SLACK_BRIDGE: "0",
      SLACK_SOCKET_MODE: "0",
      SLACK_BOT_TOKEN: "",
      SLACK_APP_TOKEN: "",
      SLACK_CHANNEL_ID: "",
      GATE_WAIT_SECONDS: String(gateSeconds),
      PIPELINE_MAX_LOOPS: "1",
      // RESUME_SPEC §2: the boot resume queue staggering. 1s instead of the 10s
      // default so two queued fixtures do not make this harness wait 10 seconds.
      RESUME_STAGGER_SECONDS: "1",
      LAYA_TEAM_MIN_CONF: "0.3",
      ASSISTANT_MODEL: "smoke-stub-planner",
      GATEWAY_BASE_URL: stub.url,
      OPENCODE_API_KEY: "smoke-mock-key",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => serverOut.push(String(d)));
  child.stderr?.on("data", (d) => serverOut.push(String(d)));
  let childExit = "";
  child.on("exit", (code, signal) => {
    childExit = `exit code=${code} signal=${signal}`;
  });

  // 5. Wait for health.
  let health: any;
  const healthDeadline = Date.now() + 60000;
  for (;;) {
    try {
      const r = await req("GET", "/health", undefined, 3000);
      if (r.status === 200 && r.json?.ok) {
        health = r.json;
        break;
      }
    } catch {
      /* not up yet */
    }
    if (childExit) break;
    if (Date.now() > healthDeadline) break;
    await sleep(250);
  }
  if (!health) {
    record(1, "isolated server answers GET /health", "free", false, childExit || `no response within 60s\n      ${lastServerLines()}`);
    throw new Error("server did not come up");
  }
  record(
    1,
    "isolated server answers GET /health with mock:true",
    "free",
    health.ok === true && health.mock === true,
    `ok=${health.ok} mock=${health.mock} bind=${health.bind}`,
  );

  // ---- (d1) fixture: the interrupted task is AUTO-RESUMED on boot -------------
  // RESUME_SPEC §2 replaced the old "mark it failed" behaviour, so this check now
  // asserts the resume: one interruption counted, a Router restart hop in the trace,
  // and the pipeline continuing from the interrupted stage (it parks at the merge
  // gate, which is the fixture's next unfinished step).
  {
    const settled = (t: any) =>
      !!t && (t.status === "pending_merge" || t.status === "merged" || t.status === "failed");
    const { task: t, waitedMs, seen } = await waitForTask(pid, fixtureId, settled, 25000);
    const restartHop = hops(t?.trace).find((h) => h.from === "Router" && /^restarted/i.test(h.what));
    const ok =
      !!t &&
      (t.status === "pending_merge" || t.status === "merged") &&
      (t.interruptions ?? 0) === 1 &&
      !!restartHop &&
      !/interrupted twice/.test(String(t.error ?? ""));
    const line = serverOut.join("").split(/\r?\n/).find((l) => /restart resume:/.test(l)) ?? "(no boot resume line)";
    record(2, 'boot reconcile AUTO-RESUMES the interrupted ("coding") task, no longer marks it failed', "free", ok,
      `${ok ? "status=" + t.status : `status=${t?.status}`} interruptions=${t?.interruptions ?? 0} waited=${waitedMs}ms seen=${seen.join(">")}` +
      ` restartHop=${restartHop ? `"${restartHop.what}" -> ${restartHop.to}` : "(none)"} | ${line.trim()}`);
  }

  // ---- (a) full chain through the assistant --------------------------------
  let chainTaskId = "";
  {
    const order = "Have the team write a greeting file.";
    const r = await req("POST", "/company/assistant/message", { text: order, autoRun: true });
    const dispatched = Array.isArray(r.json?.dispatched) ? r.json.dispatched : [];
    chainTaskId = String(dispatched[0]?.taskId ?? "");
    const dispatchedOk = r.status === 200 && dispatched.length >= 1 && !!chainTaskId && !r.json?.error;
    if (!dispatchedOk) {
      record(3, "(a) assistant dispatches one task with a full ordered trace", "mutating", false,
        `status=${r.status} error=${trim(r.json?.error)} reply=${trim(r.json?.reply, 160)} decisions=${trim(r.json?.decisions, 240)}`);
    } else {
      const { task, waitedMs, seen } = await waitForTask(pid, chainTaskId, (t) => t.status === "merged" || t.status === "failed");
      const trace = hops(task?.trace);
      const problems = task?.status === "merged" ? fullChainProblems(trace) : [`task did not merge: status=${task?.status} error=${trim(task?.error, 200)}`];
      record(3, "(a) chain task settles merged with trace CEO -> Assistant -> Laya -> Claude (manager) -> worker -> review -> Assistant -> CEO", "mutating",
        problems.length === 0,
        `${problems.length ? `${problems.join(" | ")} | ` : ""}status=${task?.status} in ${waitedMs}ms statusPath=${seen.join(">")}` +
          ` trace=${trace.length} hops:\n      ${trace.map(hopLine).join("\n      ")}`);
    }
  }

  // ---- (b) GET /company/flow returns the same task + trace -----------------
  {
    const flow = await req("GET", "/company/flow?limit=50");
    const entry = Array.isArray(flow.json?.tasks) ? flow.json.tasks.find((t: any) => t?.taskId === chainTaskId) : undefined;
    const task = chainTaskId ? await getTask(pid, chainTaskId) : undefined;
    const a = entry?.trace;
    const b = task?.trace;
    const sameTrace = JSON.stringify(hops(a)) === JSON.stringify(hops(b));
    const ok = flow.status === 200 && !!entry && sameTrace && entry.status === "merged";
    record(4, "(b) GET /company/flow returns the task with the identical trace", "free", ok,
      ok
        ? `task ${chainTaskId} status=${entry.status} trace=${hops(entry.trace).length} hops (matches tasks.json)`
        : `status=${flow.status} found=${!!entry} sameTrace=${sameTrace} flowStatus=${entry?.status} ${trim(flow.json, 200)}`);
  }

  // ---- (c) parked intake gate resumes via approve-intake -------------------
  let gateTaskId = "";
  {
    const created = await req("POST", `/company/projects/${pid}/tasks`, { request: "Write notes.txt with two short bullet points about this run." });
    gateTaskId = String(created.json?.id ?? "");
    const run = gateTaskId ? await req("POST", `/company/projects/${pid}/run`, { taskId: gateTaskId, auto: false }, timeoutMs) : undefined;
    const parked = gateTaskId ? await getTask(pid, gateTaskId) : undefined;
    const parkedOk = !!gateTaskId && run?.status === 200 && parked?.status === "pending_intake" && parked?.gates?.intake === false;

    if (!parkedOk) {
      record(5, "(c) a fresh task parks at the intake gate", "mutating", false,
        `runStatus=${run?.status} status=${parked?.status} gates=${trim(parked?.gates)}`);
    } else {
      const approved = await req("POST", `/company/projects/${pid}/tasks/${gateTaskId}/approve-intake`, {});
      const resumedOk = approved.status === 200 && approved.json?.resumed === true && approved.json?.gates?.intake === true;
      record(5, "(c) approve-intake on the parked task returns resumed:true", "mutating", parkedOk && resumedOk,
        `parked(pending_intake, gates.intake=false) -> approve-intake status=${approved.status} resumed=${approved.json?.resumed} gates.intake=${approved.json?.gates?.intake}`);
    }
  }

  // ---- (c cont.) the resumed task proceeds to merged -----------------------
  {
    const settled = await settleMerged(pid, gateTaskId);
    const task = settled.task;
    const proceeded = !!task && task.status === "merged";
    const problems = proceeded ? workChainProblems(hops(task.trace)) : [`task did not proceed to merged: status=${task?.status}`];
    record(6, "(c) the resumed task proceeds through the code/merge gates to merged", "mutating", problems.length === 0,
      `${problems.length ? `${problems.join(" | ")} | ` : ""}statusPath=${settled.seen.join(">")} final=${task?.status}` +
        `${settled.steps.length ? ` (${settled.steps.join("; ")})` : ""} trace=${hops(task?.trace).length} hops doneHop=${settled.doneHop}`);
  }

  // ---- (d2) a failed task resumes via POST /run {taskId} -------------------
  {
    const before = await getTask(pid, failedFixtureId);
    const run = await req("POST", `/company/projects/${pid}/run`, { taskId: failedFixtureId }, timeoutMs);
    const after = await getTask(pid, failedFixtureId);
    // The fixture had already cleared the intake and code gates, so resuming
    // continues at the work phase and parks at merge.
    const resumedOk =
      run.status === 200 &&
      run.json?.taskId === failedFixtureId &&
      before?.status === "failed" &&
      !!after &&
      after.status !== "failed" &&
      !after.error;
    let settled = { task: after, steps: [] as string[], seen: [`failed`, String(after?.status)], doneHop: false };
    if (resumedOk) settled = await settleMerged(pid, failedFixtureId);
    const task = settled.task;
    const problems = !resumedOk
      ? [`failed task did not resume: status=${after?.status} error=${trim(after?.error, 160)}`]
      : task?.status === "merged"
        ? workPhaseProblems(hops(task.trace))
        : [`resumed task did not merge: status=${task?.status}`];
    record(7, '(d) the failed task resumes with POST /run {"taskId"} and proceeds to merged', "mutating", problems.length === 0,
      `${problems.length ? `${problems.join(" | ")} | ` : ""}failed -> run status=${run.status} (error cleared=${!after?.error}) -> ${settled.seen.join(">")} final=${task?.status}` +
        `${settled.steps.length ? ` (${settled.steps.join("; ")})` : ""} trace=${hops(task?.trace).length} hops doneHop=${settled.doneHop}`);
  }

  // ---- (d3) a task paused by the planned shutdown resumes without an interruption
  // A deliberate shutdown (SHUTDOWN_SPEC) must not push a task toward the
  // "interrupted twice" failure, so `interruptions` has to stay 0.
  {
    const settled = (t: any) =>
      !!t && (t.status === "pending_merge" || t.status === "merged" || t.status === "failed");
    const { task: t, waitedMs, seen } = await waitForTask(pid, shutdownFixtureId, settled, 25000);
    const restartHop = hops(t?.trace).find((h) => h.from === "Router" && /^restarted/i.test(h.what));
    // `hops()` keeps only from/to/what, so read the raw trace for the detail text.
    const raw = (Array.isArray(t?.trace) ? t.trace : []).find(
      (h: any) => String(h?.from) === "Router" && /^restarted/i.test(String(h?.what)),
    );
    const ok =
      !!t &&
      (t.status === "pending_merge" || t.status === "merged") &&
      !t.pausedByShutdown &&
      (t.interruptions ?? 0) === 0 &&
      !!restartHop &&
      /shut down on purpose/.test(String(raw?.detail ?? ""));
    record(8, "(d) a pausedByShutdown task resumes at boot without counting an interruption", "free", ok,
      `${ok ? "status=" + t.status : `status=${t?.status}`} interruptions=${t?.interruptions ?? 0} pausedByShutdown=${t?.pausedByShutdown} waited=${waitedMs}ms seen=${seen.join(">")}` +
      ` restartHopDetail=${raw ? `"${String(raw.detail).slice(0, 70)}..."` : "(none)"}`);
  }

  // ---- (e) second interruption -> failed, and it shows in "Needs you" ---------
  // RESUME_SPEC §2: after 2 interrupted attempts the task is failed with the reason
  // "interrupted twice by restarts", and the Briefing must surface it under
  // "Needs you". The run-manager discovery and the briefing composition are pure
  // (heuristic cards, no model call) and read the temp COMPANY_ROOT this harness
  // already points process.env at, so this is the real path, not a mock of it.
  {
    const t = await getTask(pid, twiceFixtureId);
    const failedOk =
      !!t &&
      t.status === "failed" &&
      /^interrupted twice by restarts/.test(String(t.error ?? "")) &&
      (t.interruptions ?? 0) === 2 &&
      hops(t.trace).some((h) => h.from === "Router" && /^restart limit reached/.test(h.what));
    let briefOk = false;
    let needText = "";
    let cardState = "";
    try {
      const rm = await import("../src/company/runManagers.js");
      const bf = await import("../src/company/briefing.js");
      const cards = rm.discoverRuns().map((r) => rm.heuristicCard(r));
      const card = cards.find((c: any) => c.runId === `task:${pid}:${twiceFixtureId}`);
      cardState = String(card?.state ?? "(no card)");
      const b = bf.composeBriefing(cards, {
        seenAt: new Date(0).toISOString(),
        summary: "smoke",
        model: "heuristic",
      });
      const need = b.needsYou.find((n: any) => n.runId === `task:${pid}:${twiceFixtureId}`);
      briefOk = !!need;
      needText = String(need?.text ?? "");
    } catch (e) {
      needText = `composeBriefing failed: ${errStr(e)}`;
    }
    record(9, "(e) a task interrupted twice is failed with the right reason and appears in the Briefing's 'Needs you'", "free", failedOk && briefOk,
      `status=${t?.status} interruptions=${t?.interruptions ?? 0} error="${trim(t?.error, 90)}"` +
      ` | run-card state=${cardState} | needsYou=${briefOk ? `"${trim(needText, 140)}"` : "(absent)"}`);
  }

  console.log(`# stub gateway calls: ${stub?.calls() ?? 0} (the assistant's planning call)`);
}

main()
  .catch((e) => {
    console.log(`FATAL ${errStr(e)}`);
    checks.push({ n: 0, name: "fatal", tag: "free", ok: false, detail: errStr(e) });
  })
  .finally(async () => {
    await cleanup();
    const failed = checks.filter((c) => !c.ok);
    const total = checks.length;
    const passed = total - failed.length;
    console.log("");
    console.log(emitJson ? `SMOKE_JSON ${JSON.stringify({ total, passed, failed: failed.length, checks })}` : `SMOKE_FLOW ${passed}/${total} passed; ${failed.length} failed`);
    if (failed.length) console.log(`failed: ${failed.map((c) => `[${c.n}] ${c.name}`).join(" | ")}`);
    process.exit(failed.length ? 1 : 0);
  });
