import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { loadOrg, type ProjectDef } from "./org.js";
import { loadTasks, getTask, updateTask, normalizeRequest, type TaskRec } from "./gates.js";
import { runPipeline } from "./pipeline.js";
import { realBudgetSync, type RealBudget } from "./budgetReal.js";
import { listSessions, getSessionTail, type SessionRec } from "./sessions.js";

// ─────────────────────────────────────────────────────────────────────────────
// opsView — ONE truthful, read-from-real-state status payload for the CEO's Ops
// view (order D1-ops-api, docs/reports/ORDER_D1-ops-api.md), plus the controls
// behind its buttons (pause / resume / retry / drop / worker kill).
//
// Rules obeyed from docs/PITFALLS.md:
//   * No side effects at import time: nothing here reads or writes disk until a
//     function is called, and it never touches the real company/ folder.
//   * Every outside interaction (clock, HTTP, powershell, the log directory,
//     project and task loaders, the pipeline run function, the process-kill
//     helper, the money snapshot) is injectable through a `deps` object, so
//     tests run offline against fake state with an injected clock.
//   * Nothing that fails throws at the caller: each section degrades to an
//     explicit "unavailable / missing" field instead.
//   * No secret values ever end up in this payload (no .env reads, no tokens).
//
// Node 24 built-ins only; ES module; `.js` import suffixes.
// ─────────────────────────────────────────────────────────────────────────────

// ── types ────────────────────────────────────────────────────────────────────

export type InfraItem = { ok: boolean; detail: string; ageMin: number };

export type MoneyWindow = { remainingPct: number | null; resetsAt?: string; resetsIn?: string };

export type MoneyView = {
  opencode: {
    fiveHour: MoneyWindow;
    weekly: MoneyWindow;
    monthly: MoneyWindow;
  };
  deepseekBalance: number | null;
  creditStart: number | null;
  creditSpent: number | null;
  cap: number | null;
};

export type QueueView = {
  /** "ok" when logs/order-queue-state.json was read, else a note such as "missing". */
  state: string;
  note?: string;
  /** the orders map from the state file, verbatim (resolution value per stage id). */
  orders?: Record<string, string>;
  counts: { done: number; active: number; waiting: number; failed: number };
  paused: boolean;
  /** whole minutes since the pause file was written (only when paused). */
  pausedAgeMin?: number;
  /** whole minutes since the state file was last written (only when present). */
  ageMin?: number;
};

export type WorkerRow = {
  pid: number;
  kind: "opencode" | "jcode";
  orderId: string | undefined;
  memMB: number;
  startTime: string;
  runningMin: number;
  /** true when the process has no visible window (MainWindowHandle === 0). */
  headless: boolean;
  /** newest captured output lines from sessions.ts (empty when none). */
  lastLines: string[];
};

export type WorkersView =
  | { workers: WorkerRow[] }
  | { unavailable: true; reason: string };

export type OpsTask = {
  id: string;
  projectId: string;
  project: string;
  orderId: string | undefined;
  status: string;
  ageMin: number;
  isStale: boolean;
  error?: string;
  errorPlain?: string;
};

export type OpsAlert = {
  kind: "task-failed" | "infra" | "queue-paused" | "quota" | "credit";
  target: string;
  text: string;
  ageMin: number;
  /** true when ageMin <= 10. */
  fresh: boolean;
};

export type OpsStatus = {
  generatedAt: string;
  infra: {
    router: InfraItem;
    laya: InfraItem;
    orderQueue: InfraItem;
    watchdog: InfraItem;
    keepAwake: InfraItem;
  };
  money: MoneyView;
  queue: QueueView;
  workers: WorkersView;
  tasks: OpsTask[];
  alerts: OpsAlert[];
};

export type OpsDeps = {
  /** clock, epoch ms. */
  now?: () => number;
  /** HTTP helper for the health endpoints. */
  fetchFn?: typeof fetch;
  /** runs a powershell one-liner, returns stdout. */
  runPowerShell?: (script: string, timeoutMs?: number) => Promise<string>;
  /** where the queue / pause / ops-action files live. */
  logsDir?: () => string;
  routerUrl?: () => string;
  layaUrl?: () => string;
  /** project list for the tasks section. */
  loadProjects?: () => Array<Pick<ProjectDef, "id" | "name">>;
  /** the tasks of one project. */
  loadProjectTasks?: (projectId: string) => Array<TaskRec>;
  /** one task by id (the retry / drop controls). */
  getTaskFn?: typeof getTask;
  /** patches one task (the drop control). */
  updateTaskFn?: typeof updateTask;
  /** money snapshot; the real default is the same realBudgetSync() panel.ts uses. */
  realBudget?: () => RealBudget;
  /** the hard DeepSeek-credit spend cap (USD). */
  creditCapUsd?: () => number | null;
  /** creates a NEW task and runs it through the pipeline (retry control). */
  run?: (projectId: string, request: string) => Promise<unknown>;
  /** session registry for captured worker output (sessions.ts). */
  listSessions?: (limit?: number) => SessionRec[];
  getSessionTail?: (id: string) => string | undefined;
  /** makes the kill permanent (kill control); tests inject a fake. */
  killProcess?: (pid: number) => Promise<void>;
  /** answers with a pid's process NAME (kill must refuse non-workers). */
  processNameFor?: (pid: number) => Promise<string>;
};

// ── default deps (the real integrations) ─────────────────────────────────────

function defaultRunPowerShell(script: string, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-Command", script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
      (err, stdout) => {
        if (err) {
          const tail = String(stdout ?? "").trim().slice(-200);
          reject(new Error(tail ? `${err.message} (${tail})` : err.message));
        } else {
          resolve(String(stdout ?? ""));
        }
      },
    );
  });
}

export function defaultOpsDeps(): OpsDeps {
  return {
    now: () => Date.now(),
    fetchFn: (u, i) => fetch(u, i),
    runPowerShell: defaultRunPowerShell,
    logsDir: () => path.join(process.cwd(), "logs"),
    routerUrl: () =>
      (process.env.ROUTER_URL ?? `http://127.0.0.1:${process.env.PORT ?? "8787"}`).replace(/\/+$/, ""),
    layaUrl: () => (process.env.LAYA_URL ?? "http://127.0.0.1:8000").replace(/\/+$/, ""),
    loadProjects: () => {
      try {
        return loadOrg().projects.map((p) => ({ id: p.id, name: p.name }));
      } catch {
        return [];
      }
    },
    loadProjectTasks: (projectId) => {
      try {
        return loadTasks(projectId);
      } catch {
        return [];
      }
    },
    getTaskFn: (projectId, taskId) => {
      try {
        return getTask(projectId, taskId);
      } catch {
        return undefined;
      }
    },
    updateTaskFn: (projectId, taskId, patch) => updateTask(projectId, taskId, patch),
    realBudget: () => realBudgetSync(),
    creditCapUsd: () => {
      const n = Number(process.env.ORDER_CREDIT_CAP);
      return Number.isFinite(n) && n > 0 ? n : null; // no cap unless ORDER_CREDIT_CAP is a positive number (the CEO removed the cap on 2026-10-12)
    },
    run: (projectId: string, request: string) =>
      runPipeline(projectId, normalizeRequest(request), { auto: true }),
    listSessions: (limit = 500) => listSessions(limit),
    getSessionTail: (id) => getSessionTail(id),
    killProcess: (pid: number) =>
      new Promise((resolve, reject) => {
        execFile("taskkill.exe", ["/F", "/T", "/PID", String(pid)], { windowsHide: true, timeout: 10_000 }, (err) =>
          err ? reject(err) : resolve(),
        );
      }),
    processNameFor: async (pid: number) => {
      const out = await defaultRunPowerShell(
        `try { (Get-Process -Id ${pid} -ErrorAction Stop).ProcessName } catch { }`,
        10_000,
      );
      return out.trim();
    },
  };
}

function merged(deps?: OpsDeps): OpsDeps {
  return { ...defaultOpsDeps(), ...deps };
}

function logsDirSafe(deps?: OpsDeps): string {
  try {
    return (deps?.logsDir ?? defaultOpsDeps().logsDir!)();
  } catch {
    return path.join(process.cwd(), "logs");
  }
}

// ── small helpers ────────────────────────────────────────────────────────────

/** Whole minutes since `ts` (ISO string, epoch ms, or undefined/unknown), against
 *  clock `now`. An unknown timestamp is 0 min (never invents an age). */
export function ageMin(ts: string | number | undefined, now: number): number {
  const t = typeof ts === "number" ? ts : ts === undefined ? NaN : Date.parse(ts);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now - t) / 60_000));
}

/**
 * One plain sentence for a non-developer, from a raw error. Pure.
 * The exact mappings the order names, then the fallback (first 120 chars).
 */
export function errorPlain(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const s = raw.slice(0, 600);
  if (/fetch failed/i.test(s)) {
    return "The pipeline could not reach a service it needs (usually Laya or the network). This is an infrastructure problem, not the task's fault.";
  }
  if (/merge guard.{0,20}review verdict is LOOP or FAIL/i.test(s)) {
    return "The work was finished but the manager reviewed it and said it is not good enough yet.";
  }
  if (/merge guard.{0,20}tester reported BLOCKED or FAIL/i.test(s)) {
    return "The tester could not verify the work.";
  }
  if (/merge guard.{0,20}deliverable file\(s\) missing/i.test(s)) {
    return "The task says it is done but the promised files are not on disk.";
  }
  if (/merge guard.{0,20}no coder produced output/i.test(s)) {
    return "No coder actually ran, so nothing was built.";
  }
  if (/manager plan unusable/i.test(s)) {
    return "The manager's plan came back unreadable.";
  }
  return `Unrecognised error: ${s.replace(/\s+/g, " ").trimStart().slice(0, 120)}`;
}

/**
 * The order id inside a command line or request text:
 * `# Order <id>` (an order heading, anywhere in the text; the id stops at
 * whitespace or `:`, so hyphenated ids like ZX1-ops-api come out whole) and
 * `Order <id>-` (a worker's argument, as ops/order-queue.ps1 matches it).
 * Returns undefined when neither appears.
 */
export function parseOrderId(cmd: string): string | undefined {
  const s = String(cmd ?? "");
  // skip placeholders such as "<id>-..." that appear in prompt text as a format example
  for (const m of s.matchAll(/#\s*Order\s+([^\s:]+)/g)) {
    if (/^[A-Za-z0-9]/.test(m[1])) return m[1];
  }
  const inline = /Order\s+([A-Za-z0-9]+)-/.exec(s);
  return inline ? inline[1] : undefined;
}

// ── process table ────────────────────────────────────────────────────────────

export type ProcessRow = {
  pid: number;
  name: string;
  cmd: string;
  /** UTC ISO start time, "" when unknown. */
  started: string;
  memMB: number;
  /** the process's main window handle; 0 means it has no visible window. */
  hwnd: number;
};

// PowerShell 5.1 only: no `&&`, no `??=`, no ternary. Each process becomes one
// JSON line, followed by a `PID=<n> HWND=<n>` marker line that carries the
// Get-Process MainWindowHandle join.
const PROC_QUERY = `
$ws = @(Get-CimInstance Win32_Process -Filter "Name='opencode.exe' OR Name='jcode.exe'" |
  Select-Object ProcessId,Name,CommandLine,CreationDate,WorkingSetSize)
$pk = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { ([string]$_.CommandLine) -like '*keep-awake*' -or ([string]$_.CommandLine) -like '*order-queue*' } |
  Select-Object ProcessId,Name,CommandLine,CreationDate,WorkingSetSize)
$wins = @{}
Get-Process | ForEach-Object { if ($_.MainWindowHandle) { $wins[[int]$_.Id] = $_.MainWindowHandle } }
foreach ($p in @($ws + $pk)) {
  if ($p -eq $null) { continue }
  $p2 = [int]$p.ProcessId
  New-Object PSObject -Property @{
    pid = $p2
    name = [string]$p.Name
    cmd = ([string]$p.CommandLine)
    started = ($(try { ([datetime]$p.CreationDate).ToUniversalTime().ToString("o") } catch { "" }))
    memMB = ([math]::Round(($p.WorkingSetSize) / 1MB, 1))
    hwnd = [int]$wins[$p2]
  } | ConvertTo-Json -Compress
}
`;

/** The st Table snapshot of the real worker processes (opencode.exe, jcode.exe
 *  and the keep-awake powershell) via Get-CimInstance Win32_Process with a 10
 *  second timeout, joined with Get-Process MainWindowHandle values.
 *  Never throws: an unavailable table is {unavailable: true, reason}. */
export async function readProcessTable(deps?: OpsDeps): Promise<
  { processes: ProcessRow[] } | { unavailable: true; reason: string }
> {
  const d = merged(deps);
  try {
    const raw = await d.runPowerShell!(PROC_QUERY, 10_000);
    const processes: ProcessRow[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try {
        const v = JSON.parse(t) as Record<string, unknown>;
        const pid = Number(v.pid);
        if (!Number.isFinite(pid) || pid <= 0) continue;
        processes.push({
          pid,
          name: String(v.name ?? ""),
          cmd: String(v.cmd ?? ""),
          started: normalizeIso(v.started),
          memMB: Number(v.memMB) || 0,
          hwnd: Number(v.hwnd) || 0,
        });
      } catch {
        // skip a malformed line (truncated read, partial write)
      }
    }
    return { processes };
  } catch (e) {
    return { unavailable: true, reason: errorPlain(e) };
  }
}

function normalizeIso(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : "";
}

async function fetchHealth(
  url: string,
  fetchFn: typeof fetch,
  timeoutMs = 5000,
): Promise<{ ok: boolean; status: number; body?: unknown }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchFn(url, { signal: ctl.signal });
    let body: unknown;
    try {
      body = await r.json();
    } catch {
      body = undefined;
    }
    return { ok: r.status >= 200 && r.status < 300, status: r.status, body };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

// ── workers ──────────────────────────────────────────────────────────────────

/**
 * Real worker rows from the process table:
 *   - every `opencode.exe` process (the coding / testing / review workers);
 *   - every `jcode.exe` process that is a REAL terminal, using the same rule as
 *     lifecycle.ts's discoverTerminals: the TUI client's command line carries
 *     `--resume <sessionId>`; jcode.exe without it is a helper, not a terminal.
 * Sort: longest-running first.
 */
export function classifyWorkers(
  table: { processes: ProcessRow[] },
  now: number,
  deps?: OpsDeps,
): WorkerRow[] {
  const d = merged(deps);
  const sessions: SessionRec[] = (() => {
    try {
      return d.listSessions?.() ?? [];
    } catch {
      return [];
    }
  })();
  const byPid = new Map<number, SessionRec>();
  for (const s of sessions) {
    const pid = s.pid;
    if (typeof pid === "number" && Number.isFinite(pid)) {
      const prev = byPid.get(pid);
      if (!prev || (s.startedAt ?? "") > (prev.startedAt ?? "")) byPid.set(pid, s);
    }
  }
  const out: WorkerRow[] = [];
  for (const p of table.processes) {
    const low = String(p.name).toLowerCase();
    if (low === "opencode.exe") {
      out.push(rowFor(p, "opencode", byPid, d, now));
    } else if (low === "jcode.exe" && /--resume\s+\S+/.test(p.cmd)) {
      out.push(rowFor(p, "jcode", byPid, d, now));
    }
  }
  return out.sort((a, b) => b.runningMin - a.runningMin);
}

/** The order a worker is running, read from its session's task when the command line does not say (workers do not get their prompt in argv). */
function orderFromSession(session: SessionRec | undefined, d: OpsDeps): string | undefined {
  if (!session || !session.taskId || !session.projectId) return undefined;
  try {
    const task = (d.getTaskFn ?? getTask)(session.projectId, session.taskId);
    return task ? parseOrderId(String(task.rawRequest ?? "")) : undefined;
  } catch {
    return undefined; // a task that is gone is normal for a finished order
  }
}

function rowFor(
  p: ProcessRow,
  kind: "opencode" | "jcode",
  byPid: Map<number, SessionRec>,
  d: OpsDeps,
  now: number,
): WorkerRow {
  const session = byPid.get(p.pid);
  let lastLines: string[] = [];
  if (session) {
    let tailText: string | undefined = session.lastText;
    if (!tailText) {
      try {
        tailText = d.getSessionTail?.(session.id);
      } catch {
        tailText = undefined;
      }
    }
    if (tailText) {
      lastLines = tailText.split(/\r?\n/).filter((l) => l.trim() !== "").slice(-5);
    }
  }
  const started = Date.parse(p.started);
  return {
    pid: p.pid,
    kind,
    orderId: parseOrderId(p.cmd) ?? orderFromSession(session, d),
    memMB: p.memMB,
    startTime: p.started,
    runningMin: Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 60_000)) : 0,
    headless: p.hwnd === 0,
    lastLines,
  };
}

// ── stale detection ──────────────────────────────────────────────────────────

/** Worker stages that a process should be serving (ops/order-queue.ps1's
 *  IsLive). Router-side stages (enhancing, planning, adjudicating, summarizing)
 *  have no process to look at; pending_code is always alive at a gate. */
const WORKER_STAGES = new Set<string>(["coding", "testing"]);

/**
 * For each task: true when it is in a worker stage (coding / testing), there is
 * NO matching live worker (by parsed order id) in `workers`, and the task has
 * not changed for more than 4 minutes.
 */
export function computeStale(
  tasks: Array<TaskRec>,
  workers: WorkerRow[],
  now: number,
): boolean[] {
  const liveOrders = new Set(workers.map((w) => w.orderId).filter((o): o is string => Boolean(o)));
  return tasks.map((t: TaskRec) => {
    if (!WORKER_STAGES.has(String(t.status))) return false;
    const id = parseOrderId(String(t.rawRequest ?? ""));
    if (id && liveOrders.has(id)) return false;
    return ageMin(t.updatedAt, now) > 4;
  });
}

// ── alerts ───────────────────────────────────────────────────────────────────

/**
 * Derived alerts, newest first (`fresh` = ageMin <= 10). Sources: the failed
 * tasks (grouped per order, the LATEST failure only), infra items that are
 * down, the queue being paused, OpenCode quota under 10%, and credit spend over
 * 80% of the cap.
 */
export function deriveAlerts(
  status: Pick<OpsStatus, "tasks" | "workers" | "queue" | "infra" | "money">,
  _now: number,
): OpsAlert[] {
  void _now;
  const alerts: OpsAlert[] = [];
  const add = (kind: OpsAlert["kind"], target: string, text: string, age: number) => {
    const a = Math.max(0, Math.floor(age));
    alerts.push({ kind, target, text, ageMin: a, fresh: a <= 10 });
  };

  // failed tasks, one alert per order (or per task when the request has no id),
  // the LATEST failure only
  const latestFailed = new Map<string, { task: OpsTask; age: number }>();
  for (const t of status.tasks) {
    if (t.status !== "failed") continue;
    const key = t.orderId ?? `${t.projectId}/${t.id}`;
    const prev = latestFailed.get(key);
    if (!prev || t.ageMin < prev.age) latestFailed.set(key, { task: t, age: t.ageMin });
  }
  for (const [key, { task }] of latestFailed) {
    add("task-failed", key, `Task failed: ${task.errorPlain ?? task.error ?? "(no error text)"}`, task.ageMin);
  }

  for (const [key, item] of Object.entries(status.infra)) {
    if (!item.ok) add("infra", key, `${key} is down: ${item.detail}`, item.ageMin);
  }
  if (status.queue.paused) {
    const age = status.queue.pausedAgeMin ?? status.queue.ageMin ?? 0;
    add("queue-paused", "order-queue", "The leadgen queue is paused.", age);
  }
  const pcts = Object.values(status.money.opencode)
    .map((w) => w.remainingPct)
    .filter((x): x is number => typeof x === "number");
  if (pcts.length) {
    const min = Math.min(...pcts);
    if (min < 10) add("quota", "opencode", `OpenCode quota is down to ${min}% in its tightest window.`, status.queue.ageMin ?? 0);
  }
  const { creditSpent, cap } = status.money;
  if (cap !== null && cap > 0 && typeof creditSpent === "number" && creditSpent / cap > 0.8) {
    add(
      "credit",
      "deepseek",
      `DeepSeek credit spend is ${creditSpent.toFixed(2)} USD of a ${cap.toFixed(2)} USD cap (over 80%).`,
      status.queue.ageMin ?? 0,
    );
  }

  alerts.sort((a, b) => a.ageMin - b.ageMin);
  return alerts;
}

// ── controls ─────────────────────────────────────────────────────────────────

const PAUSE_FILE = "order-queue.pause";
const ACTIONS_FILE = "ops-actions.log";

/** Appends one `ISO  action  target` line to logs/ops-actions.log. Best-effort. */
export function logOpsAction(logsDir: string, action: string, target: string, now: number): void {
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    fs.appendFileSync(path.join(logsDir, ACTIONS_FILE), `${new Date(now).toISOString()}  ${action}  ${target}\n`);
  } catch {
    // a logging failure must never break a control
  }
}

export function pauseQueue(logsDir: string, now: number): { ok: boolean } {
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(
      path.join(logsDir, PAUSE_FILE),
      `paused by the operator at ${new Date(now).toISOString()}\n`,
    );
  } catch {
    return { ok: false };
  }
  logOpsAction(logsDir, "pause", "order-queue", now);
  return { ok: true };
}

export function resumeQueue(logsDir: string, now: number): { ok: boolean } {
  let ok = true;
  try {
    fs.rmSync(path.join(logsDir, PAUSE_FILE), { force: true });
  } catch {
    ok = false;
  }
  logOpsAction(logsDir, "resume", "order-queue", now);
  return { ok };
}

/**
 * RETRY: creates a NEW task through the existing run function with the original
 * request text (never reuses the failed task), then logs the action.
 */
export async function retryTask(
  deps: OpsDeps,
  projectId: string,
  taskId: string,
  now: number,
): Promise<{ ok: boolean; reason?: string }> {
  const d = merged(deps);
  let t: TaskRec | undefined;
  try {
    t = (d.getTaskFn ?? getTask)(projectId, taskId);
  } catch {
    t = undefined;
  }
  if (!t) return { ok: false, reason: `task ${projectId}/${taskId} not found` };
  const request = String(t.rawRequest ?? "");
  if (!request) return { ok: false, reason: `task ${projectId}/${taskId} has no request text to retry` };
  try {
    await d.run!(projectId, request);
  } catch (e) {
    logOpsAction(logsDirSafe(deps), "retry", `${projectId}/${taskId} FAILED: ${errorPlain(e)}`, now);
    return { ok: false, reason: errorPlain(e) };
  }
  logOpsAction(logsDirSafe(deps), "retry", `${projectId}/${taskId}`, now);
  return { ok: true };
}

/**
 * DROP: sets the task's status to `failed` with error `dropped by the operator`
 * (no deletion), then logs the action. Returns false when the task is unknown.
 */
export function dropTask(
  deps: OpsDeps,
  projectId: string,
  taskId: string,
  now: number,
): { ok: boolean; reason?: string } {
  const d = merged(deps);
  let t: TaskRec | undefined;
  try {
    t = (d.getTaskFn ?? getTask)(projectId, taskId);
  } catch {
    t = undefined;
  }
  if (!t) return { ok: false, reason: `task ${projectId}/${taskId} not found` };
  try {
    (d.updateTaskFn ?? updateTask)(projectId, taskId, {
      status: "failed",
      error: "dropped by the operator",
      closedAs: "dropped",
    });
  } catch (e) {
    logOpsAction(logsDirSafe(deps), "drop", `${projectId}/${taskId} FAILED: ${errorPlain(e)}`, now);
    return { ok: false, reason: errorPlain(e) };
  }
  logOpsAction(logsDirSafe(deps), "drop", `${projectId}/${taskId}`, now);
  return { ok: true };
}

/**
 * KILL: allowed ONLY for opencode.exe and jcode.exe processes; any other pid is
 * refused on purpose (a wrong pid must never be signalled). Never throws.
 */
export async function killWorker(pid: number, deps?: OpsDeps): Promise<{ ok: boolean; refused?: boolean; reason?: string }> {
  const d = merged(deps);
  if (!Number.isFinite(pid) || pid <= 0) return { ok: false, refused: true, reason: "not a worker pid" };
  let name = "";
  try {
    name = (d.processNameFor ? await d.processNameFor(pid) : "").trim();
  } catch (e) {
    return { ok: false, reason: errorPlain(e) };
  }
  const low = name.toLowerCase();
  if (low !== "opencode" && low !== "jcode") {
    logOpsAction(logsDirSafe(deps), "kill", `pid ${pid} REFUSED (process "${name || "unknown"}")`, d.now!());
    return {
      ok: false,
      refused: true,
      reason: `kill is only allowed for opencode.exe and jcode.exe; this pid is "${name || "unknown"}"`,
    };
  }
  try {
    await (d.killProcess ?? merged(deps).killProcess!)(pid);
  } catch (e) {
    logOpsAction(logsDirSafe(deps), "kill", `pid ${pid} FAILED: ${errorPlain(e)}`, d.now!());
    return { ok: false, reason: errorPlain(e) };
  }
  logOpsAction(logsDirSafe(deps), "kill", `pid ${pid} (${low}.exe)`, d.now!());
  return { ok: true };
}

/**
 * The last 60 lines of a worker's captured output (sessions.ts), or the
 * explicit note that this worker's output is not captured because it runs
 * headless. Never throws.
 */
export function workerTailFor(pid: number, deps?: OpsDeps): { lines: string[]; note?: string } {
  const d = merged(deps);
  try {
    const hit = (d.listSessions?.() ?? []).find((s) => s.pid === pid);
    const raw = hit ? hit.lastText ?? d.getSessionTail?.(hit.id) : undefined;
    if (!raw) return { lines: [], note: "this worker's output is not captured; it runs headless" };
    return { lines: raw.split(/\r?\n/).filter((l) => l.trim() !== "").slice(-60) };
  } catch {
    return { lines: [], note: "this worker's output is not captured; it runs headless" };
  }
}

// ── infra state-change stamps (the `ageMin` on every infra item) ────────────

const infraSince = new Map<string, number>();

function infraItem(key: string, ok: boolean, detail: string, now: number): InfraItem {
  const name = `${key}:${ok ? "up" : "down"}`;
  if (!infraSince.has(name)) infraSince.set(name, now);
  infraSince.delete(`${key}:${ok ? "down" : "up"}`);
  return { ok, detail, ageMin: Math.floor((now - (infraSince.get(name) as number)) / 60_000) };
}

// ── single-file state readers ────────────────────────────────────────────────

type QueueStateFile = {
  updatedAt?: string;
  infra?: string;
  active?: number;
  freeGB?: number;
  quotaPct?: number;
  creditStart?: number | null;
  paused?: boolean;
  orders?: Record<string, string>;
};

function readQueueState(file: string): QueueStateFile | undefined {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (v && typeof v === "object") return v as QueueStateFile;
  } catch {
    return undefined;
  }
  return undefined;
}

function pauseFileAge(logsDir: string, now: number): number | undefined {
  try {
    return ageMin(fs.statSync(path.join(logsDir, PAUSE_FILE)).mtimeMs, now);
  } catch {
    return undefined;
  }
}

// ── the status payload ───────────────────────────────────────────────────────

/**
 * The whole truth payload, every section read from real state at call time.
 * Nothing here throws: each section that can fail degrades instead.
 */
export async function opsStatus(deps?: OpsDeps): Promise<OpsStatus> {
  const d = merged(deps);
  const now = d.now!();
  const dir = logsDirSafe(d);

  // ── infra: router (own /health), Laya (GET http://127.0.0.1:8000/health) ──
  const [router, laya] = await Promise.all([
    fetchHealth(`${d.routerUrl!()}/health`, d.fetchFn!, 5000),
    fetchHealth(`${d.layaUrl!()}/health`, d.fetchFn!, 5000),
  ]);
  const routerBody = (router.body ?? {}) as Record<string, unknown>;
  const routerBodyOk = router.ok && routerBody.ok !== false;
  const routerDetail = routerBodyOk
    ? `own health answers (pid ${process.pid}, up ${Math.floor(process.uptime())} s` +
      (typeof routerBody.lagNowMs === "number" ? `, lag ${Math.round(routerBody.lagNowMs)} ms` : "") +
      ")"
    : `no answer (HTTP ${router.status || "unreachable"})`;
  const layaBody = (laya.body ?? {}) as Record<string, unknown>;
  const infra: OpsStatus["infra"] = {
    router: infraItem("router", routerBodyOk, routerDetail, now),
    laya: infraItem(
      "laya",
      laya.ok && layaBody.ok !== false,
      laya.ok ? `Laya answered on ${d.layaUrl!()}` : `no answer on ${d.layaUrl!()} (HTTP ${laya.status || "unreachable"})`,
      now,
    ),
    orderQueue: { ok: false, detail: "", ageMin: 0 },
    watchdog: { ok: false, detail: "", ageMin: 0 },
    keepAwake: { ok: false, detail: "", ageMin: 0 },
  };

  // process table once; it feeds the queue process, keep-awake and workers.
  const table = await readProcessTable(d);

  // ── queue: the state file + is the queue powershell alive? ────────────────
  const stateFile = path.join(dir, "order-queue-state.json");
  const qst = readQueueState(stateFile);
  const stateAge: number | undefined = (() => {
    if (qst?.updatedAt !== undefined && Number.isFinite(Date.parse(String(qst.updatedAt)))) {
      return ageMin(String(qst.updatedAt), now);
    }
    try {
      return ageMin(fs.statSync(stateFile).mtimeMs, now);
    } catch {
      return undefined;
    }
  })();
  const isPaused = fs.existsSync(path.join(dir, PAUSE_FILE));
  const pausedAge = pauseFileAge(dir, now);
  const queueAlive = "processes" in table && table.processes.some((p) => /order-queue/i.test(p.cmd));
  infra.orderQueue = infraItem(
    "orderQueue",
    queueAlive && stateAge !== undefined && stateAge <= 10,
    queueAlive
      ? `queue process running; state file ${stateAge === undefined ? "never written" : `${stateAge} min old`}`
      : `no powerShell process with "order-queue" in its command line` +
        (stateAge !== undefined ? ` (its last state file is ${stateAge} min old)` : ""),
    now,
  );

  // ── watchdog: the OfficeQueueWatch scheduled task (schtasks /query) ────
  try {
    const out = await d.runPowerShell!('schtasks /query /tn "OfficeQueueWatch" /fo LIST', 10_000);
    const status = /Status\s*:\s*(\S+)/.exec(out)?.[1] ?? "";
    const next = /Next Run Time\s*:\s*(.+?)(?:\r|\n|$)/.exec(out)?.[1]?.trim() ?? "";
    const okw = Boolean(status) && !/not ready|disabled/i.test(status);
    infra.watchdog = infraItem(
      "watchdog",
      okw,
      `scheduled task OfficeQueueWatch: ${status || "?"}${next ? `, next run ${next}` : ""}`,
      now,
    );
  } catch (e) {
    infra.watchdog = infraItem("watchdog", false, `scheduled task OfficeQueueWatch: ${errorPlain(e)}`, now);
  }

  // ── keep-awake: the powershell whose command line carries keep-awake ──────
  if ("processes" in table) {
    const kp = table.processes.find((p) => /keep-awake/i.test(p.cmd));
    infra.keepAwake = infraItem(
      "keepAwake",
      Boolean(kp),
      kp ? `keep-awake.ps1 running as pid ${kp.pid} (${Date.parse(kp.started) ? Math.floor((now - Date.parse(kp.started)) / 60_000) : 0} min)` : "no keep-awake process found in the process table",
      now,
    );
  } else {
    infra.keepAwake = infraItem("keepAwake", false, `unavailable: ${table.reason}`, now);
  }

  // ── money: the same realBudgetSync() sources panel.ts uses ────────────────
  // goRaw keeps each window's name so win() can pick the 5-hour / weekly /
  // monthly window by name; the payload only carries the safe fields.
  const goRaw: Array<{ window: string; w: MoneyWindow }> = [];
  let deepseekBalance: number | null = null;
  try {
    const b = d.realBudget!();
    for (const w of b.providers.go.windows) {
      const view: MoneyWindow = {
        remainingPct: typeof w.remainingPct === "number" ? Math.round(w.remainingPct * 10) / 10 : null,
        ...(w.resetsAt !== undefined ? { resetsAt: w.resetsAt } : {}),
        ...(w.resetsIn !== undefined ? { resetsIn: w.resetsIn } : {}),
      };
      goRaw.push({ window: String(w.window ?? ""), w: view });
    }
    if (typeof b.providers.deepseek.balanceUsd === "number") deepseekBalance = b.providers.deepseek.balanceUsd;
  } catch {
    // leave both unset; the payload shows "not measured" instead of inventing
  }
  const win = (pattern: RegExp): MoneyWindow => {
    const hit = goRaw.find((x) => pattern.test(x.window)) ?? goRaw[0];
    return hit ? hit.w : { remainingPct: null };
  };
  const creditStart = typeof qst?.creditStart === "number" ? qst.creditStart : null;
  const cap = typeof d.creditCapUsd === "function" ? d.creditCapUsd() : null;
  const money: MoneyView = {
    opencode: {
      fiveHour: win(/\b5[\s-]?hour|5h/i),
      weekly: win(/week/i),
      monthly: win(/month/i),
    },
    deepseekBalance,
    creditStart,
    creditSpent:
      creditStart !== null && deepseekBalance !== null
        ? Math.round((creditStart - deepseekBalance) * 1000) / 1000
        : null,
    cap,
  };

  // ── queue counts from the orders map ──────────────────────────────────────
  const orders: Record<string, string> = qst?.orders && typeof qst.orders === "object" ? qst.orders : {};
  const queue: QueueView = {
    ...(qst
      ? { state: "ok" }
      : {
          state: "missing",
          note: "logs/order-queue-state.json is missing (the queue has not run, or has not written it yet)",
        }),
    ...(qst ? { orders } : {}),
    counts: {
      done: Object.values(orders).filter((v) => v === "done").length,
      active: Object.values(orders).filter((v) => v === "active").length,
      waiting: Object.values(orders).filter((v) => v === "need").length,
      failed: Object.values(orders).filter((v) => v === "exhausted").length,
    },
    paused: isPaused,
    ...(isPaused && pausedAge !== undefined ? { pausedAgeMin: pausedAge } : {}),
    ...(qst && stateAge !== undefined ? { ageMin: stateAge } : {}),
  };

  // ── workers ───────────────────────────────────────────────────────────────
  const workers: WorkersView =
    "processes" in table
      ? { workers: classifyWorkers(table, now, d) }
      : { unavailable: true, reason: table.reason };

  // ── tasks: every task of every project ────────────────────────────────────
  let projects: Array<Pick<ProjectDef, "id" | "name">> = [];
  try {
    projects = d.loadProjects?.() ?? [];
  } catch {
    projects = [];
  }
  const allTasks: TaskRec[] = [];
  for (const p of projects) {
    let ts: Array<TaskRec> = [];
    try {
      ts = d.loadProjectTasks?.(p.id) ?? [];
    } catch {
      ts = [];
    }
    for (const t of ts) allTasks.push(t);
  }
  const liveWorkers = "workers" in workers ? workers.workers : [];
  const staleFlags = computeStale(allTasks, liveWorkers, now);
  const projName = new Map(projects.map((p) => [p.id, p.name]));
  const tasks: OpsTask[] = allTasks.map((t, i) => {
    const errPlain = t.error ? errorPlain(t.error) : undefined;
    return {
      id: t.id,
      projectId: t.projectId,
      project: projName.get(t.projectId) ?? t.projectId,
      orderId: parseOrderId(String(t.rawRequest ?? "")),
      status: String(t.status),
      ageMin: ageMin(t.updatedAt, now),
      isStale: staleFlags[i],
      ...(t.error !== undefined && t.error !== null ? { error: String(t.error).slice(0, 500) } : {}),
      ...(errPlain ? { errorPlain: errPlain } : {}),
    };
  });

  // ── alerts ────────────────────────────────────────────────────────────────
  const alerts = deriveAlerts({ tasks, workers, queue, infra, money }, now);

  return {
    generatedAt: new Date(now).toISOString(),
    infra,
    money,
    queue,
    workers,
    tasks,
    alerts,
  };
}
