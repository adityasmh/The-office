// ---------------------------------------------------------------------------
// Department demo: the fast, visible proof that the whole company works.
//
//   npx tsx ops/run-department-demo.ts      (from the project root)
//
// Fires ONE tiny real deliverable into each of the live org's departments
// (Engineering, Quality, Research, Executive + one repeat on Engineering = 5
// instructions in parallel), prints every dispatch as it lands, polls the
// router's /company/sessions every 5s for a live table, and finishes with a
// per-task summary plus the on-disk file listing that proves a coder really
// wrote the artifact.
//
// Step 1 does NOT need the HTTP API: it calls runBatch -> assistantMessage
// in-process, which is the same code path the dashboard's assistant console
// uses. HTTP is used only for the live board and the task-status poll, and both
// degrade to reading company/*.jsonl off disk if the router is down.
//
// Everything is small on purpose: these are throughput proofs, not products.
// ---------------------------------------------------------------------------

import "dotenv/config"; // same boot step src/server.ts uses: the assistant's model
// fallback reads OPENCODE_API_KEY / GATEWAY_BASE_URL from .env, and without this
// the in-process planning call 401s while the server works fine.
import fs from "node:fs";
import path from "node:path";
import { getCompanyRoot } from "../src/company/org.js";
import { runBatch } from "../src/company/batch.js";
import type { BatchItem, BatchResult } from "../src/company/batch.js";
import { listSessions, sessionCounts } from "../src/company/sessions.js";
import type { SessionRec } from "../src/company/sessions.js";
import { loadTasks } from "../src/company/gates.js";
import type { TaskRec } from "../src/company/gates.js";

// ── knobs (env, all optional) ───────────────────────────────────────────────
const ROUTER = process.env.DEMO_ROUTER_URL ?? "http://localhost:8787";
const CONCURRENCY = clampInt(process.env.DEMO_CONCURRENCY, 5, 1, 16);
const CEILING_MINUTES = clampInt(process.env.DEMO_CEILING_MINUTES, 12, 1, 60);
const CEILING_MS = CEILING_MINUTES * 60_000;
const POLL_MS = 5_000;
const STALL_SECONDS = clampInt(process.env.DEMO_STALL_SECONDS, 180, 60, 3600);
const STALL_MS = STALL_SECONDS * 1000;
const HTTP_ENABLED = process.env.DEMO_NO_HTTP !== "1";
// Dry run: print the plan + one live table, then exit before spending a cent.
const DRY_RUN = process.env.DEMO_DRY_RUN === "1";
// Artifact filename tag, so a second run can prove itself independently of run 1.
const TAG = (process.env.DEMO_TAG ?? "s2").trim() || "s2";
const MAX_TABLE_ROWS = 14;
const MAX_LISTING_ROWS = 40;

// A stuck opencode child must die before our own ceiling, so a demo exit never
// leaves orphan workers behind. (workers.ts reads this per spawn.)
if (!process.env.OPENCODE_TIMEOUT_SECONDS) process.env.OPENCODE_TIMEOUT_SECONDS = "540";

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

const TERMINAL_TASK_STATUSES = new Set(["merged", "rejected", "failed"]);

// ── tiny formatting helpers ─────────────────────────────────────────────────
function pad(text: string, width: number): string {
  const t = text.length > width ? `${text.slice(0, Math.max(0, width - 2))}..` : text;
  return t.padEnd(width);
}
function num(text: string, width: number): string {
  const t = text.length > width ? text.slice(0, width) : text;
  return t.padStart(width);
}
function usd(n: number | undefined): string {
  return `$${(Number.isFinite(n as number) ? (n as number) : 0).toFixed(4)}`;
}
function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}
function clock(d = new Date()): string {
  return d.toISOString().slice(11, 19);
}
function oneLine(text: string | undefined, max = 150): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
}
function line(text = ""): void {
  console.log(text);
}
function hr(label = ""): void {
  const tail = label ? ` ${label} ` : "";
  const width = Math.max(0, 78 - tail.length);
  line(`${"-".repeat(Math.floor(width / 2))}${tail}${"-".repeat(Math.ceil(width / 2))}`);
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── org.json: department -> project ─────────────────────────────────────────
type DeptInfo = { id: string; name: string; projectId: string; projectName: string; rootDir: string };

function readOrg(): { name: string; departments: DeptInfo[]; mtime: string } {
  const file = path.join(getCompanyRoot(), "org.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
    name?: string;
    departments?: Array<{ id: string; name: string; projectIds?: string[] }>;
    projects?: Array<{ id: string; name: string; departmentId: string; rootDir: string }>;
  };
  const projects = Array.isArray(raw.projects) ? raw.projects : [];
  const departments: DeptInfo[] = (raw.departments ?? []).map((d) => {
    // Same order the assistant's resolveProject uses (projectIds first, then any
    // project that names this department), so the paths we put in the work order
    // are the paths the pipeline will actually be routed to.
    const owned =
      (d.projectIds ?? []).map((pid) => projects.find((p) => p.id === pid)).find((p) => !!p) ??
      projects.find((p) => p.departmentId === d.id);
    return {
      id: d.id,
      name: d.name,
      projectId: owned?.id ?? "",
      projectName: owned?.name ?? "(no project yet)",
      rootDir: owned?.rootDir ?? "",
    };
  });
  let mtime = "unknown";
  try {
    mtime = fs.statSync(file).mtime.toISOString();
  } catch {
    // keep the fallback
  }
  return { name: raw.name ?? "Unknown Company", departments, mtime };
}

function deptByName(org: { departments: DeptInfo[] }, name: string): DeptInfo | undefined {
  const want = name.trim().toLowerCase();
  return org.departments.filter((d) => d.name.trim().toLowerCase() === want).sort((a, b) => (a.projectId ? -1 : 1))[0];
}

// ── the 5 small deliverables ────────────────────────────────────────────────
const ARTIFACTS = {
  engThroughput: `${TAG}-eng-throughput.mjs`,
  engHeartbeat: `${TAG}-eng-heartbeat.mjs`,
  qualityCheck: `${TAG}-quality-selfcheck.mjs`,
  researchBrief: `${TAG}-research-model-brief.md`,
  execCadence: `${TAG}-executive-cadence.md`,
};

function buildItems(org: { name: string; departments: DeptInfo[] }): { items: BatchItem[]; missing: string[] } {
  const missing: string[] = [];
  const need = ["Engineering", "Quality", "Research", "Executive"];
  const depts: Record<string, DeptInfo> = {};
  for (const name of need) {
    const d = deptByName(org, name);
    if (d) depts[name] = d;
    else missing.push(name);
  }
  if (missing.length) return { items: [], missing };

  const eng = depts.Engineering;
  const quality = depts.Quality;
  const research = depts.Research;
  const exec = depts.Executive;
  const p = (...parts: string[]) => path.join(...parts);

  const engFile = eng.rootDir ? p(eng.rootDir, ARTIFACTS.engThroughput) : ARTIFACTS.engThroughput;
  const engFile2 = eng.rootDir ? p(eng.rootDir, ARTIFACTS.engHeartbeat) : ARTIFACTS.engHeartbeat;
  const qualFile = quality.rootDir ? p(quality.rootDir, ARTIFACTS.qualityCheck) : ARTIFACTS.qualityCheck;
  const resFile = research.rootDir ? p(research.rootDir, ARTIFACTS.researchBrief) : ARTIFACTS.researchBrief;
  const execFile = exec.rootDir ? p(exec.rootDir, ARTIFACTS.execCadence) : ARTIFACTS.execCadence;

  const items: BatchItem[] = [
    {
      id: "eng-throughput",
      label: "Engineering #1",
      departmentName: "Engineering",
      text:
        `Department: Engineering. Create the file ${engFile} - a tiny Node ESM script that prints the company name ` +
        `"${org.name}" to stdout. Under 10 lines, no dependencies. Write the file, then run ` +
        `\`node ${engFile}\` once to prove it works. Do not create any other file.`,
    },
    {
      id: "eng-heartbeat",
      label: "Engineering #2 (repeat)",
      departmentName: "Engineering",
      text:
        `Department: Engineering. Create the file ${engFile2} - a tiny Node ESM script that prints exactly one line: ` +
        `"${TAG} engineering throughput proof 2 " plus the current ISO timestamp. Under 10 lines, no dependencies. ` +
        `Write the file, then run \`node ${engFile2}\` once. Do not create any other file.`,
    },
    {
      id: "quality-selfcheck",
      label: "Quality",
      departmentName: "Quality",
      text:
        `Department: Quality. Create the file ${qualFile} - a dependency-free Node ESM self-check script that ` +
        `validates that these four peer deliverables exist on disk:\n` +
        `  ${engFile}\n  ${engFile2}\n  ${resFile}\n  ${execFile}\n` +
        `It must print one PASS/MISSING line per file and exit with code 1 if any is missing. Under 30 lines. ` +
        `Some peers may still be mid-flight, so a MISSING line is a valid result - do not wait, do not retry, ` +
        `just create the checker and run it once. Do not create any other file.`,
    },
    {
      id: "research-brief",
      label: "Research",
      departmentName: "Research",
      text:
        `Department: Research. Write the file ${resFile}: a brief of EXACTLY 5 lines comparing two free/local ` +
        `models we could use for cheap dispatch decisions (one line each: model A strength, model B strength, ` +
        `cost/latency note, failure mode, one-line recommendation for Laya's dispatcher). No title, no preamble, ` +
        `no extra lines. Do not create any other file.`,
    },
    {
      id: "exec-cadence",
      label: "Executive",
      departmentName: "Executive",
      text:
        `Department: Executive. Write the file ${execFile}: a one-page operating-cadence note for ${org.name} ` +
        `(max 250 words) covering a daily 5-minute stand-up, a weekly gate review, a monthly budget review, and ` +
        `the escalation path when a pipeline stalls. Plain markdown, no fluff. Do not create any other file.`,
    },
  ];
  return { items, missing: [] };
}

// ── live table: router HTTP + our own in-process sessions ───────────────────
type SessionView = SessionRec & { source: "router" | "disk" };
type SessionsPayload = { running: number; queued: number; total: number; items: SessionRec[] };

async function fetchJson<T>(url: string, timeoutMs = 4000): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return (await res.json()) as T;
}

let sessionsHttpErr = "";

async function collectSessions(): Promise<{ remote?: SessionsPayload; local: SessionsPayload }> {
  let remote: SessionsPayload | undefined;
  if (HTTP_ENABLED) {
    try {
      remote = await fetchJson<SessionsPayload>(`${ROUTER}/company/sessions`);
      sessionsHttpErr = "";
    } catch (e) {
      sessionsHttpErr = oneLine(String(e), 90);
    }
  }
  let localItems: SessionRec[] = [];
  let localCounts = { running: 0, queued: 0, total: 0 };
  try {
    localItems = listSessions(120);
    localCounts = sessionCounts();
  } catch {
    // sessions registry unavailable: the table still prints the router view
  }
  return { remote, local: { ...localCounts, items: localItems } };
}

function mergeSessions(payload: { remote?: SessionsPayload; local: SessionsPayload }): SessionView[] {
  const byId = new Map<string, SessionView>();
  for (const s of payload.remote?.items ?? []) byId.set(s.id, { ...s, source: "router" });
  for (const s of payload.local.items) {
    const prev = byId.get(s.id);
    // Our own process knows the truth about sessions it started.
    byId.set(s.id, { ...(prev ?? {}), ...s, source: prev ? prev.source : "disk" } as SessionView);
  }
  return [...byId.values()].sort((a, b) => {
    const rank = (s: SessionView) => (s.status === "running" ? 0 : s.status === "queued" ? 1 : 2);
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    return String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? ""));
  });
}

function elapsedOf(s: SessionRec): number {
  if (typeof s.durationMs === "number" && Number.isFinite(s.durationMs)) return s.durationMs;
  const start = Date.parse(s.startedAt ?? "");
  return Number.isFinite(start) ? Date.now() - start : 0;
}

function printLiveTable(payload: { remote?: SessionsPayload; local: SessionsPayload }): void {
  const merged = mergeSessions(payload);
  const run = merged.filter((s) => s.status === "running").length;
  const queued = merged.filter((s) => s.status === "queued").length;
  const local = payload.local;
  const routerText = payload.remote
    ? `router running=${payload.remote.running} queued=${payload.remote.queued} total=${payload.remote.total}`
    : HTTP_ENABLED
      ? `router UNREACHABLE (${sessionsHttpErr || "error"})`
      : "router polling disabled (DEMO_NO_HTTP=1)";
  line(
    `[${clock()}] sessions: running=${run} queued=${queued} total=${merged.length}  |  ${routerText} ` +
      `| disk log running=${local.running} queued=${local.queued} total=${local.total}`,
  );
  line("  SRC=router is the live server's in-memory view; SRC=disk is company/sessions.jsonl, which also carries the runs this script starts.");
  line(
    `  ${pad("SRC", 7)}${pad("ROLE", 16)}${pad("AGENT", 11)}${pad("DEPARTMENT", 13)}${pad("STATUS", 9)}` +
      `${num("ELAPSED", 9)}  ${num("COST", 9)}  ${pad("TASK", 13)}TITLE`,
  );
  for (const s of merged.slice(0, MAX_TABLE_ROWS)) {
    line(
      `  ${pad(s.source, 7)}${pad(String(s.role ?? "?"), 16)}${pad(String(s.agentId ?? "?"), 11)}` +
        `${pad(String(s.departmentName ?? s.departmentId ?? "?"), 13)}${pad(s.status, 9)}` +
        `${num(fmtDuration(elapsedOf(s)), 9)}  ${num(usd(s.costUsd), 9)}  ` +
        `${pad(String(s.taskId ?? "-"), 13)}${oneLine(s.taskTitle, 54)}`,
    );
  }
  if (merged.length > MAX_TABLE_ROWS) line(`  ... +${merged.length - MAX_TABLE_ROWS} more sessions`);
}

// ── targets + task-status polling ───────────────────────────────────────────
type Target = {
  itemId: string;
  departmentName: string;
  projectId: string;
  taskId: string;
  title: string;
  dispatchedStatus: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  firstSeenMs: number;
  lastChangeMs: number;
  terminal: boolean;
  terminalSeenMs?: number;
  stalled: boolean;
  statusSource: string;
};

const targets: Target[] = [];

function addTarget(r: BatchResult, d: { projectId: string; taskId: string; title: string; status: string }): void {
  if (targets.some((t) => t.taskId === d.taskId)) return;
  targets.push({
    itemId: r.id,
    departmentName: r.departmentName ?? "?",
    projectId: d.projectId,
    taskId: d.taskId,
    title: d.title,
    dispatchedStatus: d.status,
    status: "(new)",
    createdAt: "",
    updatedAt: "",
    firstSeenMs: Date.now(),
    lastChangeMs: Date.now(),
    terminal: false,
    stalled: false,
    statusSource: "?",
  });
}

async function tasksFor(projectId: string): Promise<{ tasks: TaskRec[]; source: string }> {
  if (HTTP_ENABLED) {
    try {
      const tasks = await fetchJson<TaskRec[]>(`${ROUTER}/company/projects/${encodeURIComponent(projectId)}/tasks`);
      return { tasks, source: "router" };
    } catch {
      // fall through to disk
    }
  }
  try {
    return { tasks: loadTasks(projectId), source: "disk" };
  } catch {
    return { tasks: [], source: "none" };
  }
}

async function refreshTargets(verbose = true): Promise<void> {
  const pending = targets.filter((t) => !t.terminal);
  if (!pending.length) return;
  const projects = [...new Set(pending.map((t) => t.projectId))];
  for (const projectId of projects) {
    const { tasks, source } = await tasksFor(projectId);
    for (const t of pending.filter((x) => x.projectId === projectId)) {
      const rec = tasks.find((x) => x.id === t.taskId);
      if (!rec) {
        t.statusSource = source;
        if (Date.now() - t.firstSeenMs > 30_000 && t.status === "(new)") {
          t.status = "(not found on disk)";
          t.lastChangeMs = Date.now();
          if (verbose) line(`[${clock()}] ${t.taskId}: not found in project ${projectId} tasks via ${source}`);
        }
        continue;
      }
      t.statusSource = source;
      if (!t.createdAt) t.createdAt = rec.createdAt ?? "";
      if (rec.updatedAt !== t.updatedAt) {
        const from = t.status;
        t.updatedAt = rec.updatedAt ?? "";
        if (rec.status !== t.status) {
          t.status = rec.status;
          t.lastChangeMs = Date.now();
          if (verbose && from !== rec.status) {
            line(`[${clock()}] task ${t.taskId} (${t.departmentName}/${projectId}) ${from} -> ${rec.status} [${source}]`);
          }
        }
      }
      if (TERMINAL_TASK_STATUSES.has(t.status)) {
        t.terminal = true;
        t.terminalSeenMs = Date.now();
      }
    }
  }
}

function sessionsForTask(taskId: string, all: SessionView[]): SessionView[] {
  return all
    .filter((s) => s.taskId === taskId)
    .sort((a, b) => String(a.startedAt ?? "").localeCompare(String(b.startedAt ?? "")));
}

function threadTail(projectId: string, n = 2): Array<{ ts: string; agent: string; kind: string; text: string }> {
  try {
    const file = path.join(getCompanyRoot(), "projects", projectId, "thread.jsonl");
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-n).map((l) => {
      try {
        const j = JSON.parse(l) as { ts?: string; agent?: string; kind?: string; text?: string };
        return { ts: j.ts ?? "", agent: j.agent ?? "?", kind: j.kind ?? "?", text: j.text ?? "" };
      } catch {
        return { ts: "", agent: "?", kind: "?", text: "(unparseable thread line)" };
      }
    });
  } catch {
    return [];
  }
}

function reportStall(t: Target, all: SessionView[]): void {
  const age = Date.now() - t.lastChangeMs;
  line("");
  line(`!! STALL: task ${t.taskId} (${t.departmentName} / ${t.projectId}) stuck in "${t.status}" for ${fmtDuration(age)}`);
  line(`   title: ${oneLine(t.title, 160)}`);
  line(`   status source: ${t.statusSource}; last update ${t.updatedAt || "unknown"}; dispatched as "${t.dispatchedStatus}"`);
  const rows = sessionsForTask(t.taskId, all);
  if (!rows.length) line("   session rows: none recorded for this task");
  for (const s of rows.slice(-4)) {
    line(
      `   session ${s.id} | role=${s.role} agent=${s.agentId} dept=${s.departmentName} status=${s.status} ` +
        `model=${s.model} runtime=${s.runtime ?? "-"} elapsed=${fmtDuration(elapsedOf(s))} cost=${usd(s.costUsd)} ` +
        `pid=${s.pid ?? "-"} source=${s.source}`,
    );
    if (s.lastText) line(`     last output tail: ${oneLine(s.lastText.slice(-400), 300)}`);
  }
  for (const m of threadTail(t.projectId, 2)) {
    line(`   thread [${m.ts}] ${m.agent}/${m.kind}: ${oneLine(m.text, 160)}`);
  }
  line("   (evidence above; not waiting on this pipeline any further)");
}

// ── on-disk artifact proof ──────────────────────────────────────────────────
type Found = { file: string; size: number; mtime: string };

function listDirRecursive(root: string, maxDepth = 4, cap = 300): Found[] {
  const out: Found[] = [];
  const skip = new Set(["node_modules", ".git", ".opencode", "dist", ".cache"]);
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || out.length >= cap) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= cap) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue;
        walk(full, depth + 1);
      } else if (e.isFile()) {
        try {
          const st = fs.statSync(full);
          out.push({ file: full, size: st.size, mtime: st.mtime.toISOString() });
        } catch {
          // vanished between readdir and stat
        }
      }
    }
  };
  walk(root, 0);
  return out;
}

function findByName(roots: string[], name: string): Found[] {
  const hits: Found[] = [];
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    for (const f of listDirRecursive(root)) {
      if (path.basename(f.file).toLowerCase() === name.toLowerCase()) hits.push(f);
    }
  }
  return hits;
}

// ── main ────────────────────────────────────────────────────────────────────
let summaryPrinted = false;

async function main(): Promise<void> {
  const t0 = Date.now();
  const org = readOrg();
  const { items, missing } = buildItems(org);
  const expectedProjects = [...new Set(items.map((i) => i.departmentName ?? ""))];
  const projectRoots = [...new Set(org.departments.filter((d) => expectedProjects.includes(d.name)).map((d) => d.rootDir))];

  hr("S2 DEPARTMENT DEMO");
  line(`company:   ${org.name}`);
  line(`org.json:  ${path.join(getCompanyRoot(), "org.json")} (${org.departments.length} departments, mtime ${org.mtime})`);
  line(`router:    ${ROUTER}${HTTP_ENABLED ? "" : " (polling disabled)"}`);
  line(`plan:      ${items.length} instructions, concurrency ${CONCURRENCY}, ceiling ${CEILING_MINUTES}m, stall flag ${STALL_SECONDS}s`);
  line(`openCode child timeout: ${process.env.OPENCODE_TIMEOUT_SECONDS}s`);
  for (const it of items) {
    const d = org.departments.find((x) => x.name === it.departmentName);
    line(`  - ${pad(it.id, 18)} ${pad(it.departmentName ?? "?", 12)} project=${d?.projectId || "?"} root=${d?.rootDir || "?"}`);
    line(`    work order: ${oneLine(it.text, 110)}`);
  }
  if (missing.length) {
    line("");
    line(`BLOCKED: org.json is missing department(s): ${missing.join(", ")}. Nothing dispatched.`);
    process.exitCode = 2;
    return;
  }
  line("");

  if (HTTP_ENABLED) {
    try {
      const health = await fetchJson<{ ok?: boolean }>(`${ROUTER}/health`, 3000);
      line(`router health: ${JSON.stringify(health)}`);
    } catch (e) {
      line(`router health: UNREACHABLE (${oneLine(String(e), 80)}) - continuing, HTTP is optional`);
    }
  }

  if (DRY_RUN) {
    hr("DRY RUN");
    const payload = await collectSessions();
    printLiveTable(payload);
    line("DEMO_DRY_RUN=1: nothing dispatched, no spend. Unset it to run the real thing.");
    return;
  }

  // Live board: poll every 5s while the batch + pipelines run.
  let stopping = false;
  const pollLoop = (async () => {
    while (!stopping) {
      try {
        const payload = await collectSessions();
        printLiveTable(payload);
      } catch (e) {
        line(`[${clock()}] poll failed: ${oneLine(String(e), 120)}`);
      }
      if (stopping) return;
      await sleep(POLL_MS);
    }
  })();

  hr("DISPATCH (in-process assistantMessage through runBatch)");
  const run = await runBatch(items, {
    concurrency: CONCURRENCY,
    autoRun: true,
    onProgress: (r) => {
      const tag = `${r.departmentName ?? "?"}${r.label ? ` (${r.label})` : ""}`;
      line("");
      line(`[${clock()}] DISPATCH LANDED ${r.id} | ${tag} | ${fmtDuration(r.durationMs)}`);
      if (!r.dispatched.length) {
        line(`   no task dispatched${r.error ? ` error=${r.error}` : ""} reply=${oneLine(r.reply, 200)}`);
      }
      for (const d of r.dispatched) {
        line(`   ${tag} -> ${d.taskId} -> ${d.status} (project ${d.projectId}) "${oneLine(d.title, 80)}"`);
        addTarget(r, d);
      }
      if (r.reply) line(`   reply: ${oneLine(r.reply, 220)}`);
      for (const d of r.decisions ?? []) {
        line(`   decision: ${oneLine(d, 200)}`);
      }
      for (const s of (r.plan ?? []).slice(0, 3)) {
        line(`   plan: ${oneLine(s.title, 70)} | dept=${s.departmentName} role=${s.role}`);
      }
    },
  });

  const batchMs = run.durationMs;
  line("");
  hr("BATCH RETURNED");
  line(
    `batch: ${run.results.length} instructions in ${fmtDuration(batchMs)} | ` +
      `tasks dispatched ${targets.length} | errors ${run.results.filter((r) => r.error).length}`,
  );
  for (const r of run.results) {
    line(`  ${pad(r.id, 18)} ${pad(r.departmentName ?? "?", 12)} ${r.error ? `ERROR ${oneLine(r.error, 90)}` : `${r.dispatched.length} task(s)`}`);
  }

  // Wait for pipelines: poll task status until terminal or ceiling.
  hr("PIPELINE WATCH (task status every 5s)");
  if (!targets.length) {
    line("BLOCKED: the assistant planned nothing, so no pipeline was started.");
    for (const r of run.results) line(`  ${pad(r.id, 18)} ${r.error ? `ERROR ${oneLine(r.error, 80)}` : "no task"}`);
    line("Fix the planning model path (Claude subscription creds or OPENCODE_API_KEY/.env) and re-run.");
    process.exitCode = 4;
    return;
  }
  const deadline = t0 + CEILING_MS;
  let lastAllSessions = mergeSessions(await collectSessions());

  while (Date.now() < deadline) {
    await refreshTargets();
    const payload = await collectSessions();
    lastAllSessions = mergeSessions(payload);
    const pending = targets.filter((t) => !t.terminal);
    if (!pending.length) break;

    // Stall check: report once, and once everything pending is stalled we stop
    // waiting instead of sitting on dead pipelines.
    for (const t of pending) {
      if (t.stalled) continue;
      if (Date.now() - t.lastChangeMs < STALL_MS) continue;
      t.stalled = true;
      reportStall(t, lastAllSessions);
    }
    if (pending.every((t) => t.stalled)) {
      line("");
      line(`All ${pending.length} pending pipeline(s) are stalled; exiting the wait (evidence above).`);
      break;
    }
    await sleep(POLL_MS);
  }

  stopping = true;
  await pollLoop.catch(() => undefined);

  const reason = targets.length && targets.every((t) => t.terminal) ? "all pipelines settled" : `stopped (ceiling ${CEILING_MINUTES}m or stall)`;
  // Planning spend is read back from the assistant's own decisions ("cost about $X").
  let planCalls = 0;
  let planSpendUsd = 0;
  for (const r of run.results) {
    for (const d of r.decisions ?? []) {
      const m = /planning call cost about \$([0-9.]+)/i.exec(d);
      if (m) {
        planCalls++;
        planSpendUsd += Number(m[1]);
      }
    }
  }
  await printFinalSummary(reason, batchMs, lastAllSessions, projectRoots, { planCalls, planSpendUsd });
  process.exitCode = targets.length && targets.every((t) => t.terminal) ? 0 : 1;
}

async function printFinalSummary(
  reason: string,
  batchMs: number,
  allSessions: SessionView[],
  projectRoots: string[],
  planning: { planCalls: number; planSpendUsd: number } = { planCalls: 0, planSpendUsd: 0 },
): Promise<void> {
  if (summaryPrinted) return;
  summaryPrinted = true;

  // Refresh once more so the summary reflects the final on-disk state.
  await refreshTargets(false);
  const liveSessions = mergeSessions(await collectSessions());
  const sessions = liveSessions.length ? liveSessions : allSessions;
  const myTaskIds = new Set(targets.map((t) => t.taskId));
  const mySessions = sessions.filter((s) => !!s.taskId && myTaskIds.has(s.taskId));
  const mySpend = mySessions.reduce((n, s) => n + (s.costUsd ?? 0), 0);
  const boardRunning = sessions.filter((s) => s.status === "running").length;
  const boardQueued = sessions.filter((s) => s.status === "queued").length;
  // Resolve ids to roots FIRST, then de-duplicate (de-duping ids left the root paths doubled).
  const roots = [
    ...new Set(
      [...projectRoots, ...targets.map((t) => projectRootOf(t.projectId) ?? t.projectId)].filter((x): x is string => !!x),
    ),
  ];

  line("");
  hr("FINAL SUMMARY");
  line(`reason:            ${reason}`);
  line(`instructions:      ${targets.length} tasks dispatched (${new Set(targets.map((t) => t.itemId)).size} batch items)`);
  line(`batch dispatch:    ${fmtDuration(batchMs)} (assistant planning + task creation)`);
  line(`assistant planning: ${planning.planCalls} call(s), ${usd(planning.planSpendUsd)} (from the assistant's own decisions)`);
  line(`pipeline sessions: ${mySessions.length} session(s) for these tasks, ${usd(mySpend)}`);
  line(`total (this run):  ${usd(mySpend + planning.planSpendUsd)}`);
  line(`board at exit:     running=${boardRunning} queued=${boardQueued} total=${sessions.length} visible sessions (router-view ${sessions.filter((s) => s.source === "router").length}, disk-log ${sessions.filter((s) => s.source === "disk").length}; other workstreams share this board)`);
  line("");

  for (const [i, t] of targets.entries()) {
    const rows = sessionsForTask(t.taskId, sessions);
    const wallMs = t.createdAt && t.updatedAt ? Date.parse(t.updatedAt) - Date.parse(t.createdAt) : Date.now() - t.firstSeenMs;
    const cost = rows.reduce((n, s) => n + (s.costUsd ?? 0), 0);
    line(`[${i + 1}] ${pad(t.itemId, 18)} ${pad(t.departmentName, 12)} task ${t.taskId}  status=${t.status}${t.terminal ? "" : " (NOT TERMINAL)"}`);
    line(`    project ${t.projectId} | wall ${fmtDuration(wallMs)} | ${rows.length} session(s) | cost ${usd(cost)} | ${oneLine(t.title, 100)}`);
    if (!rows.length) {
      line("    work: (no session rows recorded - pipeline produced no worker runs)");
    } else {
      const chain = rows
        .map((s) => `${s.role}/${s.agentId}(${s.model}, ${fmtDuration(elapsedOf(s))}, ${usd(s.costUsd)}, ${s.status})`)
        .join(" -> ");
      line(`    work: ${chain}`);
    }
    if (t.stalled) line(`    STALLED in "${t.status}" for ${fmtDuration(Date.now() - t.lastChangeMs)} (session rows above)`);
  }

  line("");
  hr("ARTIFACT CHECK (on disk)");
  for (const [id, name] of Object.entries(ARTIFACTS)) {
    const hits = findByName(roots, name);
    const status = hits.length ? "FOUND " : "MISSING";
    line(`  ${status} ${pad(id, 18)} ${name}${hits.length ? `  (${hits.length} copy/copies)` : ""}`);
    for (const h of hits) line(`      ${h.file}  ${h.size} bytes  ${h.mtime}`);
  }

  line("");
  hr("PROJECT REPO LISTINGS");
  for (const root of [...new Set(roots)]) {
    const exists = fs.existsSync(root);
    line(`  ${root}${exists ? "" : "  (does not exist)"}`);
    if (!exists) continue;
    const files = listDirRecursive(root).sort((a, b) => a.file.localeCompare(b.file));
    for (const f of files.slice(0, MAX_LISTING_ROWS)) {
      line(`      ${num(String(f.size), 8)} bytes  ${f.mtime}  ${f.file.slice(root.length + 1)}`);
    }
    if (files.length > MAX_LISTING_ROWS) line(`      ... +${files.length - MAX_LISTING_ROWS} more files`);
  }

  line("");
  hr("EXIT");
  line(`terminal tasks: ${targets.filter((t) => t.terminal).length}/${targets.length} | stalled: ${targets.filter((t) => t.stalled).length}`);
}

function projectRootOf(projectId: string): string | undefined {
  try {
    const file = path.join(getCompanyRoot(), "org.json");
    const org = JSON.parse(fs.readFileSync(file, "utf8")) as {
      departments?: Array<{ id: string; name: string }>;
      projects?: Array<{ id: string; departmentId: string; rootDir: string }>;
    };
    const project = (org.projects ?? []).find((p) => p.id === projectId);
    return project?.rootDir;
  } catch {
    return undefined;
  }
}

// ── bootstrap ───────────────────────────────────────────────────────────────
process.on("SIGINT", () => {
  line("");
  line("SIGINT: printing what we have, then exiting. Long-running opencode children self-kill on OPENCODE_TIMEOUT_SECONDS.");
  void printFinalSummary("interrupted (SIGINT)", 0, [], []).finally(() => process.exit(130));
});

main().catch((e) => {
  console.error(`demo crashed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exitCode = 3;
});
