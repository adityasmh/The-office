// RESUME_SPEC §5 proof (owner: RESUME).
//
// A REAL restart drill against a TEST router, never the live one on :8787:
//   * the router runs on its own port under its own supervisor instance
//     (ops/router-supervisor.ps1 -Port <test> -LogPrefix router-test-resume), so
//     the restart after each kill is the supervisor doing its job, not this script;
//   * its COMPANY_ROOT is a temp COPY of company/ (projects/, memory/, reports/,
//     fleet/ and terminals.json excluded) with one fresh drill project created
//     inside it, so it can neither read nor resume any live task and can never
//     close a live terminal;
//   * SLACK_BRIDGE=0 and blank Slack credentials, so no message can be posted;
//   * MOCK_MODE=1 (the repo's standard isolated mode: every model stage is mocked)
//     so the drill costs nothing and is deterministic. The only un-mocked call is
//     the CEO assistant's planning call, which is served by a small in-process stub
//     gateway that can be made slow on purpose.
//
// What it proves, by killing the router (TerminateProcess, exactly what CRASHFIX
// documented) and letting the supervisor bring it back:
//   A. killed mid-PLANNING  -> the assistant-inflight marker is on disk, and the
//      restarted router redoes that one planning call, so the order still finishes.
//   B. killed mid-CODING    -> the task is auto-resumed at "coding" (Router hop in
//      its trace) and merges without anyone touching it.
//   C. killed twice on one task -> it is marked failed with the reason
//      "interrupted twice by restarts" and shows in the Briefing under "Needs you".
//
// Usage:
//   npx tsx ops/resume-drill.ts [--port 8899] [--keep] [--json]
//
// Exit 0 when every step is observed, 1 otherwise. Never prints a secret.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIVE_COMPANY = path.join(REPO_ROOT, "company");

const args = process.argv.slice(2);
const argOf = (name: string, fallback: number) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};
const PORT = argOf("--port", 8899);
const LOG_PREFIX = `router-test-resume`;
const KEEP = args.includes("--keep");
const AS_JSON = args.includes("--json");
// Which case(s) to run: A (kill mid-planning), B (kill mid-coding), C (kill twice).
const CASES = (() => {
  const i = args.indexOf("--case");
  return (i >= 0 && args[i + 1] ? args[i + 1] : "ABC").toUpperCase();
})();
const hasCase = (c: string) => CASES.includes(c);
// The low-RAM floor the boot queue uses. RESUME_SPEC §2 says do not resume while free
// RAM < 2 GB; on a loaded box (this one has been under 2 GB all evening, see the
// "resume queue paused" lines) that legitimately holds the queue, so the drill can be
// run with a lower floor --min-free-ram-mb 512 to exercise the resume path itself.
const MIN_FREE_RAM_MB = argOf("--min-free-ram-mb", 512);
// How long a mocked in-motion stage is held so the drill can kill the router INSIDE
// it. Read by src/company/pipeline.ts (PIPELINE_MOCK_STAGE_DELAY_MS, mock-only).
// 20s, not 5s: after a restart the drill must re-discover the router (health poll +
// two PowerShell pid lookups), and the second kill of case C has to land inside the
// resumed run's coder stage - a short hold lets the run merge first and the drill
// then kills nothing (observed: "status=merged interruptions=1", 2026-09-29T14:36Z).
const STAGE_HOLD_MS = 20000;
// How long the stub gateway stalls the assistant's planning call (kill mid-planning).
const PLANNING_STALL_MS = 6000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowStamp = () => new Date().toISOString();
const log = (msg: string) => console.log(`[${nowStamp()}] ${msg}`);

type Step = { n: number; name: string; ok: boolean; detail: string };
const steps: Step[] = [];
const evidence: Record<string, unknown> = {};
function record(n: number, name: string, ok: boolean, detail: string) {
  steps.push({ n, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} [${n}] ${name}`);
  console.log(`      ${detail}`);
}

let stub: http.Server | undefined;
let supervisor: ChildProcess | undefined;
let tempRoot = "";
let companyRoot = "";
let token = "";

const base = () => `http://127.0.0.1:${PORT}`;

async function req(
  method: string,
  urlPath: string,
  body?: unknown,
  timeoutMs = 20000,
): Promise<{ status: number; json: any; raw: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(base() + urlPath, {
      method,
      headers: {
        "content-type": "application/json",
        "X-Company-Token": token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const raw = await res.text();
    let json: any;
    try {
      json = JSON.parse(raw);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, raw };
  } finally {
    clearTimeout(timer);
  }
}

async function health(): Promise<any | undefined> {
  try {
    const r = await req("GET", "/health", undefined, 3000);
    return r.status === 200 && r.json?.ok ? r.json : undefined;
  } catch {
    return undefined;
  }
}

/** The pid actually listening on the test port (the router process). */
function listenerPid(): number {
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", `(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`],
    { encoding: "utf8" },
  );
  return Number(String(r.stdout ?? "").trim()) || 0;
}

/** Kill the test router exactly the way it keeps dying for real: TerminateProcess. */
async function killRouter(why: string): Promise<{ pid: number; at: string }> {
  const pid = listenerPid();
  const at = nowStamp();
  if (pid > 0) {
    spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`], { encoding: "utf8" });
  }
  log(`KILL (${why}): stopped test router pid ${pid || "(none)"}`);
  return { pid, at };
}

/** Wait for the supervisor to have a healthy router again; returns the new pid. */
async function waitForRestart(maxMs: number): Promise<{ pid: number; waitedMs: number }> {
  const t0 = Date.now();
  for (;;) {
    const h = await health();
    if (h) {
      const pid = listenerPid();
      return { pid, waitedMs: Date.now() - t0 };
    }
    if (Date.now() - t0 > maxMs) return { pid: 0, waitedMs: Date.now() - t0 };
    await sleep(400);
  }
}

async function getTask(pid: string, tid: string): Promise<any | undefined> {
  const r = await req("GET", `/company/projects/${pid}/tasks`);
  return (Array.isArray(r.json) ? r.json : []).find((t: any) => t?.id === tid);
}

async function waitForTask(pid: string, tid: string, pred: (t: any) => boolean, maxMs: number) {
  const t0 = Date.now();
  const seen: string[] = [];
  let last: any;
  for (;;) {
    last = await getTask(pid, tid).catch(() => undefined);
    if (last) {
      const s = String(last.status);
      if (seen[seen.length - 1] !== s) seen.push(s);
      if (pred(last)) return { task: last, waitedMs: Date.now() - t0, seen };
    }
    if (Date.now() - t0 > maxMs) return { task: last, waitedMs: Date.now() - t0, seen };
    await sleep(250);
  }
}

const restartHop = (t: any) =>
  (Array.isArray(t?.trace) ? t.trace : []).find((h: any) => String(h?.from) === "Router" && /^restarted/i.test(String(h?.what)));

function hopLines(t: any): string[] {
  return (Array.isArray(t?.trace) ? t.trace : []).map(
    (h: any) => `${String(h.ts).slice(11, 19)} ${h.from} -> ${h.what} -> ${h.to}`,
  );
}

/* ------------------------------------------------------------------ stub gateway */
// Serves the CEO assistant's planning call (ASSISTANT_MODEL=drill-stub-assistant) and
// stalls it for PLANNING_STALL_MS so the drill can kill the router mid-planning.
function startStubGateway(planText: string): Promise<{ url: string; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        let model = "";
        try {
          model = String(JSON.parse(body)?.model ?? "");
        } catch {
          /* not JSON */
        }
        const answer = model === "drill-stub-assistant" ? planText : `[drill stub] ${model}`;
        const payload = JSON.stringify({
          choices: [{ message: { role: "assistant", content: answer } }],
          usage: { total_tokens: 1 },
        });
        const delay = model === "drill-stub-assistant" ? PLANNING_STALL_MS : 0;
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(payload);
        }, delay).unref?.();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      stub = server;
      const port = (server.address() as net.AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}/v1`, port });
    });
  });
}

/* ------------------------------------------------------------------ test company */
// A temp COPY of company/ (the spec's recipe), with the parts that carry live state
// excluded so the test router cannot resume a live task, show live runs in its
// briefing, or consider closing a live terminal.
function buildTestCompany(): string {
  // The copy lives INSIDE tempRoot, which cleanup() removes: mkdtemp on its own would
  // leak a directory per run (observed: 4 leftovers from this session's 4 drill runs).
  const copy = path.join(tempRoot, "company");
  fs.mkdirSync(copy, { recursive: true });
  const excluded = ["projects", "memory", "reports", "fleet", "probe-hang", "probe-node", "probe-stdin"];
  const entries = fs.readdirSync(LIVE_COMPANY, { withFileTypes: true });
  let copied = 0;
  for (const e of entries) {
    if (excluded.includes(e.name)) continue;
    if (e.name === "terminals.json") continue; // never inherit a registry of live windows
    const from = path.join(LIVE_COMPANY, e.name);
    const to = path.join(copy, e.name);
    fs.cpSync(from, to, { recursive: true });
    copied++;
  }
  fs.mkdirSync(path.join(copy, "reports"), { recursive: true });
  log(`temp COMPANY_ROOT: ${copy} (copied ${copied} of ${entries.length} entries; excluded ${excluded.join(", ")} + terminals.json)`);
  return copy;
}

/* ------------------------------------------------------------------ supervisor */
function psSingleQuote(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

function startSupervisor(childEnv: Record<string, string>): ChildProcess {
  const pairs = Object.entries(childEnv)
    .map(([k, v]) => `${k}=${psSingleQuote(v)}`)
    .join("; ");
  const cmd =
    `& ${psSingleQuote(path.join(REPO_ROOT, "ops", "router-supervisor.ps1"))} ` +
    `-Port ${PORT} -LogPrefix ${psSingleQuote(LOG_PREFIX)} -ChildEnv @{ ${pairs} }`;
  const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", cmd], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => process.stdout.write(`[sup] ${String(d).trimEnd()}\n`));
  child.stderr?.on("data", (d) => process.stdout.write(`[sup:err] ${String(d).trimEnd()}\n`));
  return child;
}

function stopSupervisor() {
  spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(REPO_ROOT, "ops", "router-supervisor.ps1"),
      "-Port",
      String(PORT),
      "-LogPrefix",
      LOG_PREFIX,
      "-Stop",
    ],
    { encoding: "utf8", cwd: REPO_ROOT },
  );
  try {
    supervisor?.kill();
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ drill */
async function main() {
  if (listenerPid()) throw new Error(`port ${PORT} already has a listener (pid ${listenerPid()}) - pick another --port`);
  if (PORT === 8787) throw new Error("refusing to run the drill on the live port 8787");

  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jcode-resume-drill-root-"));
  companyRoot = buildTestCompany();
  process.env.COMPANY_ROOT = companyRoot; // BEFORE importing anything that reads it

  const org = await import("../src/company/org.js");
  const { project, department } = org.createProject({
    companyName: "Resume Drill Co",
    departmentName: "Engineering",
    projectName: "Restart Drill",
    description: "isolated restart drill (RESUME_SPEC section 5)",
    coderCount: 1,
  });
  const pid = project.id;
  log(`drill project: ${pid} ("${project.name}", department "${department.name}")`);

  token = crypto.randomBytes(16).toString("hex");
  const stubGateway = await startStubGateway(
    JSON.stringify({
      reply: "Drill order accepted: one coder task dispatched in the isolated company.",
      decisions: ["Isolated RESUME drill (MOCK_MODE=1, stub gateway, temp COMPANY_ROOT)."],
      tasks: [
        {
          title: "Write the drill file",
          departmentName: department.name,
          projectId: pid,
          role: "coder",
          request: "Create a file drill.txt containing one short line for the CEO.",
        },
      ],
    }),
  );
  log(`stub gateway: ${stubGateway.url} (planning stalls ${PLANNING_STALL_MS}ms)`);

  supervisor = startSupervisor({
    PORT: String(PORT),
    HOST: "127.0.0.1",
    COMPANY_ROOT: companyRoot,
    COMPANY_AUTH_TOKEN: token,
    MOCK_MODE: "1",
    SLACK_BRIDGE: "0",
    SLACK_SOCKET_MODE: "0",
    SLACK_BOT_TOKEN: "",
    SLACK_APP_TOKEN: "",
    SLACK_CHANNEL_ID: "",
    GATE_WAIT_SECONDS: "2",
    PIPELINE_MAX_LOOPS: "1",
    // RESUME_SPEC §2 queue: 1s stagger so a drill step does not wait 10s.
    RESUME_STAGGER_SECONDS: "1",
    RESUME_MAX_CONCURRENT: "3",
    RESUME_MIN_FREE_RAM_MB: String(MIN_FREE_RAM_MB),
    // RESUME_SPEC §5: hold a mocked in-motion stage so a kill lands INSIDE it.
    PIPELINE_MOCK_STAGE_DELAY_MS: String(STAGE_HOLD_MS),
    ASSISTANT_MODEL: "drill-stub-assistant",
    GATEWAY_BASE_URL: stubGateway.url,
    OPENCODE_API_KEY: "drill-mock-key",
  });

  const up = await waitForRestart(120000);
  record(1, `test router is up on :${PORT} under its own supervisor (logs/${LOG_PREFIX}.supervisor.log)`, up.pid > 0, `listener pid=${up.pid} after ${up.waitedMs}ms`);
  if (!up.pid) throw new Error("test router never came up");
  const h = await health();
  log(`test router booted json: url=${base()} mock=${h?.mock} bind=${h?.bind}`);
  evidence.pidFirst = up.pid;

  /* ---------------------------------------------------------------- A: mid-planning */
  evidence.caseA = {};
  if (hasCase("A")) {
    const order = "Drill A: write the drill file, please.";
    const t0 = nowStamp();
    void req("POST", "/company/assistant/message", { text: order, autoRun: true }, 60000).catch(() => undefined);
    await sleep(1800);
    const markerFile = path.join(companyRoot, "assistant-inflight.json");
    let marker: any;
    try {
      marker = JSON.parse(fs.readFileSync(markerFile, "utf8"));
    } catch {
      marker = undefined;
    }
    const pidBefore = listenerPid();
    const killed = await killRouter("mid-planning");
    const restarted = await waitForRestart(120000);
    // The redo re-plans the same message (stub stalls 6s) and dispatches the task.
    let redone: any;
    for (let i = 0; i < 120; i++) {
      const runs = await req("GET", "/company/runs");
      const cards = Array.isArray(runs.json?.cards) ? runs.json.cards : [];
      const mine = cards.find((c: any) => String(c.runId ?? "").includes(pid) && c.kind === "task");
      if (mine?.ref?.taskId) {
        redone = mine;
        break;
      }
      await sleep(500);
    }
    const taskId = String(redone?.ref?.taskId ?? "");
    let settled: any = { task: undefined, seen: [] as string[], waitedMs: 0 };
    if (taskId) settled = await waitForTask(pid, taskId, (t) => t.status === "merged" || t.status === "failed", 60000);
    const thread = await req("GET", "/company/assistant/thread?limit=20");
    const msgs = Array.isArray(thread.json?.messages) ? thread.json.messages : [];
    const noted = msgs.filter((m: any) => /\(redone after restart\)/.test(String(m.text ?? "")));
    const markerGone = !fs.existsSync(markerFile);
    const ok =
      !!marker && marker.pid === pidBefore && marker.text === order && !marker.taskIds &&
      markerGone &&
      noted.length > 0 &&
      settled.task?.status === "merged";
    evidence.caseA = {
      orderStartedAt: t0,
      markerSeenBeforeKill: marker ? { id: marker.id, pid: marker.pid, text: marker.text } : null,
      killedPid: killed.pid,
      killedAt: killed.at,
      restartedPid: restarted.pid,
      restartWaitedMs: restarted.waitedMs,
      markerClearedAfterBoot: markerGone,
      threadNotices: noted.map((m: any) => m.text.slice(0, 200)),
      taskId,
      finalStatus: settled.task?.status,
      statusPath: settled.seen,
    };
    record(
      2,
      "A. killed mid-PLANNING -> marker on disk, boot redoes that one planning call, order finishes on its own",
      ok,
      `marker{pid=${marker?.pid} text="${String(marker?.text ?? "").slice(0, 40)}"} cleared=${markerGone} redoneNotice=${noted.length}` +
        ` | killed pid ${killed.pid} at ${killed.at} -> restarted pid ${restarted.pid} in ${restarted.waitedMs}ms` +
        ` | task ${taskId} final=${settled.task?.status} path=${settled.seen.join(">")}`,
    );
  }

  /* ---------------------------------------------------------------- B: mid-coding */
  evidence.caseB = {};
  if (hasCase("B")) {
    const created = await req("POST", `/company/projects/${pid}/tasks`, { request: "Drill B: write the drill file." });
    const taskId = String(created.json?.id ?? "");
    void req("POST", `/company/projects/${pid}/run`, { taskId, auto: true }, 30000).catch(() => undefined);
    const coding = await waitForTask(pid, taskId, (t) => t.status === "coding", 30000);
    const killed = await killRouter("mid-coding");
    const restarted = await waitForRestart(120000);
    const settled = await waitForTask(pid, taskId, (t) => t.status === "merged" || t.status === "failed", 90000);
    const hop = restartHop(settled.task);
    const ok =
      coding.task?.status === "coding" &&
      settled.task?.status === "merged" &&
      (settled.task?.interruptions ?? 0) === 1 &&
      !!hop &&
      /coding/.test(String(hop.what));
    evidence.caseB = {
      taskId,
      statusAtKill: coding.task?.status,
      killedPid: killed.pid,
      killedAt: killed.at,
      restartedPid: restarted.pid,
      restartWaitedMs: restarted.waitedMs,
      finalStatus: settled.task?.status,
      interruptions: settled.task?.interruptions,
      restartHop: hop ? { from: hop.from, to: hop.to, what: hop.what, detail: hop.detail } : null,
      trace: hopLines(settled.task),
    };
    record(
      3,
      "B. killed mid-CODING -> task auto-resumes at coding (Router hop) and merges with no human action",
      ok,
      `status AtKill=${coding.task?.status} interruptions=${settled.task?.interruptions} final=${settled.task?.status}` +
        ` restartHop=${hop ? `"${hop.what}" -> ${hop.to}` : "(none)"} | killed pid ${killed.pid} at ${killed.at} -> restarted pid ${restarted.pid} in ${restarted.waitedMs}ms`,
    );
  }

  /* --------------------------------------------------------- C: twice -> failed */
  evidence.caseC = {};
  if (hasCase("C")) {
    const created = await req("POST", `/company/projects/${pid}/tasks`, { request: "Drill C: write the drill file twice." });
    const taskId = String(created.json?.id ?? "");
    void req("POST", `/company/projects/${pid}/run`, { taskId, auto: true }, 30000).catch(() => undefined);
    await waitForTask(pid, taskId, (t) => t.status === "coding", 30000);
    const kill1 = await killRouter("mid-coding (1st)");
    const restart1 = await waitForRestart(120000);
    // The resumed run re-enters the coder stage. Wait for the RESTART HOP to exist
    // (that is the resume actually starting) and then kill immediately, so this second
    // kill cannot miss the stage: the status was already "coding" before the restart,
    // so status alone would match instantly and fire the kill too early.
    const codingAgain = await waitForTask(
      pid,
      taskId,
      (t) => (t.interruptions ?? 0) === 1 && !!restartHop(t) && t.status === "coding",
      60000,
    );
    const kill2 = await killRouter("mid-coding (2nd)");
    const restart2 = await waitForRestart(120000);
    const settled = await waitForTask(pid, taskId, (t) => t.status === "failed", 60000);
    // The Briefing the CEO reads: refresh the page, then read it back.
    await req("POST", "/company/briefing/refresh", {}, 60000).catch(() => undefined);
    const brief = await req("GET", "/company/briefing");
    const needs = Array.isArray(brief.json?.needsYou) ? brief.json.needsYou : [];
    const mine = needs.find((n: any) => String(n.runId ?? "").includes(taskId));
    const ok =
      settled.task?.status === "failed" &&
      /^interrupted twice by restarts/.test(String(settled.task?.error ?? "")) &&
      (settled.task?.interruptions ?? 0) === 2 &&
      !!mine;
    evidence.caseC = {
      taskId,
      kill1: { pid: kill1.pid, at: kill1.at },
      restart1: { pid: restart1.pid, waitedMs: restart1.waitedMs },
      codingAgainAt: codingAgain.task?.status,
      kill2: { pid: kill2.pid, at: kill2.at },
      restart2: { pid: restart2.pid, waitedMs: restart2.waitedMs },
      finalStatus: settled.task?.status,
      interruptions: settled.task?.interruptions,
      error: settled.task?.error,
      briefingNeedsYou: mine ?? null,
      briefingCounts: brief.json?.counts,
      trace: hopLines(settled.task),
    };
    record(
      4,
      "C. killed twice on one task -> failed with \"interrupted twice by restarts\" and listed under the Briefing's Needs you",
      ok,
      `status=${settled.task?.status} interruptions=${settled.task?.interruptions} error="${String(settled.task?.error ?? "").slice(0, 70)}..."` +
        ` | kills ${kill1.pid}@${kill1.at} / ${kill2.pid}@${kill2.at} | briefing needsYou=${mine ? `"${String(mine.text).slice(0, 110)}"` : "(absent)"}`,
    );
  }

  writeReport();
}

function writeReport() {
  const failed = steps.filter((s) => !s.ok);
  const report = {
    generatedAt: nowStamp(),
    repoRoot: REPO_ROOT,
    port: PORT,
    logPrefix: LOG_PREFIX,
    tempCompanyRoot: companyRoot,
    supervisorLog: path.join(REPO_ROOT, "logs", `${LOG_PREFIX}.supervisor.log`),
    routerLog: path.join(REPO_ROOT, "logs", `${LOG_PREFIX}.out.log`),
    live_SLACK_BRIDGE: "0",
    live_port_8787_touched: false,
    steps,
    evidence,
  };
  const file = path.join(REPO_ROOT, "logs", "resume-drill-report.json");
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log("");
  console.log(`DRILL ${steps.length - failed.length}/${steps.length} passed; ${failed.length} failed`);
  if (failed.length) console.log(`failed: ${failed.map((s) => `${s.n} ${s.name}`).join(" | ")}`);
  console.log(`# structured evidence: ${file}`);
}

async function cleanup() {
  stopSupervisor();
  try {
    stub?.close();
  } catch {
    /* ignore */
  }
  if (!KEEP) {
    for (const dir of [tempRoot]) {
      if (dir && dir.startsWith(os.tmpdir())) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
    }
  } else {
    console.log(`# kept temp root: ${tempRoot}`);
  }
}

main()
  .catch((e) => {
    console.log(`FATAL ${String((e as Error)?.stack ?? e).slice(0, 800)}`);
    steps.push({ n: 0, name: "fatal", ok: false, detail: String(e).slice(0, 300) });
    try {
      writeReport();
    } catch {
      /* ignore */
    }
  })
  .finally(async () => {
    await cleanup();
    const failed = steps.filter((s) => !s.ok);
    if (AS_JSON) console.log(`DRILL_JSON ${JSON.stringify({ steps })}`);
    process.exit(failed.length ? 1 : 0);
  });
