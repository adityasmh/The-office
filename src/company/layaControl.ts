/**
 * LAYA-CTL: status, stop and start controls for the local Laya decision server.
 *
 * The System page's "Laya (decision model)" panel (public/v2/views/system.js) gets its
 * data and its two mutations from here:
 *   - `layaStatus()`   -> health + device + the process table's Laya pids + GPU memory;
 *   - `stopLaya()`     -> stops ONLY python.exe running `laya.serve` / `laya-gpu-boot.py`
 *                         (the same rule ops/laya-restart.ps1 follows: never the router,
 *                         never jcode, never an unrelated python), then reports freed VRAM;
 *   - `startLaya()`    -> refuses when Laya already answers, else starts
 *                         scripts/serve-laya.ps1 detached and hidden and returns at once
 *                         (loading takes minutes, so the caller reads status afterwards).
 *
 * Safety rules honoured here:
 *   1. `layaPids()` is pure and narrow: a pid is returned only when its process NAME is
 *      `python.exe` AND its command line names one of Laya's two entrypoints. The router
 *      (node), jcode, and any other python process can never leak through.
 *   2. The real process list comes from terminalReaper's cached WMI snapshot
 *      (`Get-CimInstance Win32_Process`); no shell string is ever built from user input.
 *   3. Nothing here starts a server on the live company: `startLaya()` only ever launches
 *      `scripts/serve-laya.ps1`, and it refuses before touching anything if /health answers.
 *   4. Health is read exactly the way src/company/lifecycle.ts reads it (same
 *      `LAYA_HEALTH_URL`, same short AbortSignal.timeout fetch), so the two pages can
 *      never disagree about whether Laya is up.
 *
 * LAYA-UX additions (docs/ORDER_2026-10-06_laya-ux.md):
 *   - `switchLaya()`  stop, wait up to 15 s for health to go down, then start the other device
 *                     as one action; nothing starts when the stop part fails;
 *   - `layaStatus()`  now also returns `starting`, `lastStartError`, `gpuHeadroom`,
 *                     `fallbackNotice`, `requestedDevice` and per-checkpoint `cpuFallbacks`,
 *                     derived from a remembered start plus the same health body;
 *   - `gpuHeadroomWarning()` / `cpuFallbackNotice()` / `logTail()` / `redactTokens()` are pure
 *                     and exported so the proof can drive them with fake numbers and fake logs.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { snapshotProcessesAsync, type ProcMap } from "./terminalReaper.js";

const HEALTH_TIMEOUT_MS = 2500;
const GPU_TIMEOUT_MS = 8000;
// LAYA-UX knobs (see docs/ORDER_2026-10-06_laya-ux.md).
const START_GRACE_MS = 20_000; // a start that never produces a process or health is a failure
const SWITCH_STOP_WAIT_MS = 15_000; // how long a switch waits for health to go down
const LOG_TAIL_LINES = 5;
const LOG_TAIL_CHARS = 600;
const LAYA_NEEDS_MIB = 4 * 1024; // "Laya needs about 4 GB"

function layaHealthUrl(): string {
  const raw = (process.env.LAYA_HEALTH_URL ?? "").trim();
  return raw || "http://127.0.0.1:8000/health";
}

function clip(text: string, max: number): string {
  const t = String(text ?? "");
  return t.length > max ? `${t.slice(0, Math.max(0, max - 1))}…` : t;
}
function oneLine(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // Deliberately NOT unref'd: a promise that awaits this timer must keep the event loop
    // alive. With unref, a bare script (the proof) exits mid-wait with nothing pending, and
    // `stopLaya()`'s wait loop could return early in the same way.
    setTimeout(resolve, ms);
  });
}

// ── the last requested start (LAYA-UX item 2/3) ─────────────────────────────
//
// A start returns at once (loading takes minutes), so the panel has no way to tell "loading
// right now" from "the start died". We remember the request here and derive that in
// `layaStatus()`: a Laya process with health still down is `starting`; no process and health
// still down past the grace period is `lastStartError`.

export type LayaDevice = "gpu" | "cpu";
type PendingStart = { device: LayaDevice; at: number };

let pendingStart: PendingStart | null = null;

/** Test seam only: set (or clear) the remembered start so the proof can drive the clock. */
export function setPendingStartForTests(value: { device: LayaDevice; at: number } | null): void {
  pendingStart = value;
}
/** Test seam only: what is currently remembered (used by the proof). */
export function getPendingStartForTests(): PendingStart | null {
  return pendingStart ? { ...pendingStart } : null;
}

export function deviceWord(device: string | null | undefined): string {
  return device === "cpu" ? "CPU" : device === "gpu" ? "GPU" : "unknown";
}

/** "gpu" | "cpu" | null from a health body's `device` field (`cuda:0`, `cpu`, ...). */
export function deviceOf(json: LayaHealthJson | undefined): LayaDevice | null {
  const raw = json && typeof json.device === "string" ? json.device : "";
  if (!raw) return null;
  if (/cuda|gpu|nvidia/i.test(raw)) return "gpu";
  if (/cpu/i.test(raw)) return "cpu";
  return null;
}

// ── log tail for a failed start (LAYA-UX item 3) ──────────────────────────────

/**
 * Anything shaped like a secret becomes "[redacted]" before it can reach the page.
 * Deliberately narrow: known key prefixes, Bearer tokens, `key=value` secrets and long
 * base64/hex blobs. Ordinary log text (paths, sizes, error names) survives untouched.
 */
export function redactTokens(text: string): string {
  let out = String(text ?? "");
  const patterns: RegExp[] = [
    /\b(?:sk|ghp|gho|ghs|ghu|xoxb|xoxp|xoxa|xoxr|hf|pk|rk)[-_][A-Za-z0-9_-]{10,}\b/g,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi,
    /\b[A-Za-z0-9_]*(?:token|secret|password|passwd|api[_-]?key)[A-Za-z0-9_]*\s*[:=]\s*["']?[A-Za-z0-9._+/=-]{6,}["']?/gi,
    /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
  ];
  for (const re of patterns) out = out.replace(re, "[redacted]");
  return out;
}

/** The last `n` non-blank lines of a log, or "" when there is nothing to show. */
export function lastLines(text: string, n = LOG_TAIL_LINES): string {
  const lines = String(text ?? "").split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (!lines.length) return "";
  return lines.slice(Math.max(0, lines.length - Math.max(1, n))).join("\n").trim();
}

/**
 * Last `lines` lines of each labelled log, redacted and clipped to `maxChars` (default 600).
 * Pure, so the proof can feed it fake log text.
 */
export function logTail(
  parts: Array<{ label: string; text: string }>,
  opts: { lines?: number; maxChars?: number } = {},
): string {
  const lines = opts.lines ?? LOG_TAIL_LINES;
  const maxChars = opts.maxChars ?? LOG_TAIL_CHARS;
  const chunks = (parts ?? [])
    .map((p) => {
      const body = lastLines(p?.text ?? "", lines);
      const label = String(p?.label ?? "").trim();
      return body ? (label ? `${label}\n${body}` : body) : "";
    })
    .filter((c) => c.length > 0);
  return clip(redactTokens(chunks.join("\n")), maxChars);
}

function readFileIfAny(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** Read-only tail of logs/laya.err.log + logs/laya.out.log (redacted, capped at 600 chars). */
export function layaStartLogTail(read: (file: string) => string = readFileIfAny): string {
  const dir = path.join(process.cwd(), "logs");
  return logTail([
    { label: "logs/laya.err.log", text: read(path.join(dir, "laya.err.log")) },
    { label: "logs/laya.out.log", text: read(path.join(dir, "laya.out.log")) },
  ]);
}

// ── plain-word notices the panel shows (items 4 and 5) ───────────────────────

/** "GPU has X.X GB free; Laya needs about 4 GB..." when free VRAM is under 4.0 GB, else null. */
export function gpuHeadroomWarning(gpu: GpuInfo | null, needsMiB = LAYA_NEEDS_MIB): string | null {
  if (!gpu) return null;
  const total = Number(gpu.totalMiB) || 0;
  const used = Number(gpu.usedMiB) || 0;
  if (total <= 0) return null;
  const freeMiB = Math.max(0, total - used);
  if (freeMiB >= needsMiB) return null;
  const gb = (mib: number): string => (mib / 1024).toFixed(1);
  return `GPU has ${gb(freeMiB)} GB free; Laya needs about ${gb(needsMiB)} GB. It may fall back to CPU or load slowly.`;
}

export type FallbackInput = {
  requestedDevice?: LayaDevice | null;
  checkpointDevices?: Record<string, string>;
  cpuFallbacks?: Record<string, number>;
};

/** "Some models fell back to CPU" when a count is above 0, or a checkpoint sits on CPU
 *  even though the last start asked for the GPU. Null when everything is where it should be. */
export function cpuFallbackNotice(input: FallbackInput | null | undefined): string | null {
  const counts = input?.cpuFallbacks ?? {};
  const flipped = Object.values(counts).some((n) => Number(n) > 0);
  const askedGpu = input?.requestedDevice === "gpu";
  const onCpu = Object.values(input?.checkpointDevices ?? {}).some((d) => /cpu/i.test(String(d)));
  return flipped || (askedGpu && onCpu) ? "Some models fell back to CPU" : null;
}

// ── the process list Laya is identified from ─────────────────────────────────

/** One row of the process table, as `Get-CimInstance Win32_Process` reports it. */
export type ProcInput = { pid: number; name: string; commandLine: string };

function procsFromTable(table: ProcMap): ProcInput[] {
  return [...table.values()].map((r) => ({ pid: r.pid, name: r.name, commandLine: r.cmd }));
}

/**
 * The pids of the Laya decision server: python.exe processes whose command line runs
 * `laya.serve` or `laya-gpu-boot.py`. Pure, so the proof can drive it with fake lists.
 * A node router, a jcode client, or `python -m http.server` never matches.
 */
export function layaPids(processList: ProcInput[]): number[] {
  const out: number[] = [];
  for (const row of processList ?? []) {
    if (!row) continue;
    if (!/^python(\.exe)?$/i.test(String(row.name ?? ""))) continue;
    const cmd = String(row.commandLine ?? "").toLowerCase();
    if (!cmd.includes("laya.serve") && !cmd.includes("laya-gpu-boot.py")) continue;
    const pid = Number(row.pid);
    if (Number.isFinite(pid) && pid > 0) out.push(pid);
  }
  return out;
}

// ── health (same URL + fetch style as lifecycle.ts) ──────────────────────────

export type LayaHealthJson = {
  status?: unknown;
  loaded?: unknown;
  device?: unknown;
  checkpoint_devices?: unknown;
  /** {name: {count, last_reason}} — per-checkpoint CPU-fallback counters (see laya/serve.py). */
  cpu_fallbacks?: unknown;
};
export type HealthResult = { ok: boolean; detail?: string; json?: LayaHealthJson };

async function fetchHealth(ms = HEALTH_TIMEOUT_MS): Promise<HealthResult> {
  const url = layaHealthUrl();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
    let json: LayaHealthJson | undefined;
    try {
      json = (await res.json()) as LayaHealthJson;
    } catch {
      json = undefined; // a non-JSON body still proves something answered
    }
    return {
      ok: res.ok,
      detail: `HTTP ${res.status}${res.ok ? "" : ` ${res.statusText}`}`,
      ...(json ? { json } : {}),
    };
  } catch (e) {
    return { ok: false, detail: clip(oneLine(String(e)), 200) };
  }
}

// ── nvidia-smi (parsers are exported so the proof can feed them fake output) ──

export type GpuInfo = { name: string; usedMiB: number; totalMiB: number };
export type ComputeApp = { pid: number; usedMiB: number };
export type CmdResult = { ok: boolean; stdout: string; stderr: string; error?: string };
export type ExecFn = (cmd: string, args: string[], timeoutMs: number) => Promise<CmdResult>;

/**
 * One line of `nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv,noheader,nounits`,
 * e.g. "NVIDIA GeForce RTX 4050 Laptop GPU, 1234, 6144". Empty/garbage output -> null, never throws.
 */
export function parseGpuQuery(stdout: string): GpuInfo | null {
  const line = String(stdout ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  const m = /^(.*?),\s*(\d+)\s*,\s*(\d+)\s*$/.exec(line);
  if (!m) return null;
  const usedMiB = Number(m[2]);
  const totalMiB = Number(m[3]);
  if (!Number.isFinite(usedMiB) || !Number.isFinite(totalMiB)) return null;
  return { name: m[1].trim(), usedMiB, totalMiB };
}

/** The lines of `--query-compute-apps=pid,used_memory`, e.g. "1234, 512". Bad lines are skipped. */
export function parseComputeApps(stdout: string): ComputeApp[] {
  const out: ComputeApp[] = [];
  for (const raw of String(stdout ?? "").split(/\r?\n/)) {
    const m = /^(\d+)\s*,\s*(\d+)\s*$/.exec(raw.trim());
    if (!m) continue;
    const pid = Number(m[1]);
    const usedMiB = Number(m[2]);
    if (Number.isFinite(pid) && Number.isFinite(usedMiB)) out.push({ pid, usedMiB });
  }
  return out;
}

/**
 * The GPU totals and, when nvidia-smi answers the second query, Laya's own share of
 * `usedMiB` (only the compute-apps rows whose pid is one of Laya's). `gpu: null` means
 * nvidia-smi is unavailable or unparsable; the caller shows "(no nvidia-smi)".
 */
export async function readGpu(exec: ExecFn, pids: Iterable<number> = []): Promise<{ gpu: GpuInfo | null; layaGpuMiB: number | null }> {
  let gpu: GpuInfo | null = null;
  try {
    const res = await exec(
      "nvidia-smi",
      ["--query-gpu=name,memory.used,memory.total", "--format=csv,noheader,nounits"],
      GPU_TIMEOUT_MS,
    );
    gpu = res.ok ? parseGpuQuery(res.stdout) : null;
  } catch {
    gpu = null;
  }
  if (!gpu) return { gpu: null, layaGpuMiB: null };
  const wanted = new Set<number>(pids);
  let layaGpuMiB: number | null = null;
  try {
    const res = await exec(
      "nvidia-smi",
      ["--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"],
      GPU_TIMEOUT_MS,
    );
    if (res.ok && wanted.size > 0) {
      const mine = parseComputeApps(res.stdout).filter((a) => wanted.has(a.pid));
      if (mine.length) layaGpuMiB = mine.reduce((sum, a) => sum + a.usedMiB, 0);
    }
  } catch {
    layaGpuMiB = null;
  }
  return { gpu, layaGpuMiB };
}

async function gpuUsedMiB(exec: ExecFn): Promise<number | null> {
  const { gpu } = await readGpu(exec);
  return gpu ? gpu.usedMiB : null;
}

// ── status ───────────────────────────────────────────────────────────────────

export type LayaStatus = {
  ok: boolean;
  device: string | null;
  checkpointDevices: Record<string, string>;
  cpuFallbacks: Record<string, number>;
  loaded: string[];
  pids: number[];
  gpu: GpuInfo | null;
  layaGpuMiB: number | null;
  /** The device the last start asked for, kept so the panel can spot a CPU fallback. */
  requestedDevice: LayaDevice | null;
  /** A start was requested, a Laya process exists, but health does not answer yet. */
  starting: { device: LayaDevice; sinceSec: number } | null;
  /** A start was requested, no Laya process exists, and health stayed down past the grace
   *  period: plain words plus the last log lines (redacted, capped at 600 chars). */
  lastStartError: string | null;
  /** Plain-words warning when free GPU memory is under 4 GB (item 4), else null. */
  gpuHeadroom: string | null;
  /** Plain-words notice when a checkpoint fell back to CPU (item 5), else null. */
  fallbackNotice: string | null;
};

export type LayaDeps = {
  health?: () => Promise<HealthResult>;
  processes?: () => Promise<ProcInput[]> | ProcInput[];
  exec?: ExecFn;
  /** test seam: lets the proof place the remembered start in the past */
  now?: () => number;
};

function loadedNames(json: LayaHealthJson | undefined): string[] {
  return json && Array.isArray(json.loaded) ? json.loaded.map((x) => String(x)) : [];
}
function deviceNames(json: LayaHealthJson | undefined): Record<string, string> {
  const raw = json?.checkpoint_devices;
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = String(v);
  return out;
}
/** Per-checkpoint CPU-fallback counters from `cpu_fallbacks: {name: {count, last_reason}}`. */
function fallbackCounts(json: LayaHealthJson | undefined): Record<string, number> {
  const raw = json?.cpu_fallbacks;
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const count = v && typeof v === "object" ? Number((v as { count?: unknown }).count) : Number(v);
    if (Number.isFinite(count)) out[k] = count;
  }
  return out;
}

export async function layaStatus(deps: LayaDeps = {}): Promise<LayaStatus> {
  const exec = deps.exec ?? runCommand;
  const now = deps.now ?? (() => Date.now());
  const health = await (deps.health ? deps.health() : fetchHealth());
  const list = deps.processes ? await deps.processes() : procsFromTable(await snapshotProcessesAsync(true));
  const pids = layaPids(list);
  const { gpu, layaGpuMiB } = await readGpu(exec, pids);
  const json = health.json;
  const checkpointDevices = deviceNames(json);
  const cpuFallbacks = fallbackCounts(json);
  const requestedDevice = pendingStart ? pendingStart.device : null;

  // Item 2: a Laya process is alive but health is still silent -> it is loading.
  const starting = pendingStart && pids.length > 0 && !health.ok
    ? { device: pendingStart.device, sinceSec: Math.max(0, Math.round((now() - pendingStart.at) / 1000)) }
    : null;

  // Item 3: the start produced neither a process nor health within the grace period.
  let lastStartError: string | null = null;
  if (pendingStart && pids.length === 0 && !health.ok && now() - pendingStart.at > START_GRACE_MS) {
    const tail = layaStartLogTail();
    lastStartError =
      `Laya did not start on ${deviceWord(pendingStart.device)} and no Laya process is running.` +
      (tail ? ` Last log lines:\n${tail}` : " There is nothing new in logs/laya.err.log or logs/laya.out.log.");
  }

  return {
    ok: health.ok,
    device: json && typeof json.device === "string" ? json.device : null,
    checkpointDevices,
    cpuFallbacks,
    loaded: loadedNames(json),
    pids,
    gpu,
    layaGpuMiB,
    requestedDevice,
    starting,
    lastStartError,
    gpuHeadroom: gpuHeadroomWarning(gpu),
    fallbackNotice: cpuFallbackNotice({ requestedDevice, checkpointDevices, cpuFallbacks }),
  };
}

// ── stop ─────────────────────────────────────────────────────────────────────

export type StopResult = { stopped: number[]; freedMiB: number };

/**
 * Stop Laya and only Laya. Finds its pids from the real process table, terminates exactly
 * those, waits up to 10 s for /health to go down, and reports the VRAM the box got back.
 */
export async function stopLaya(deps: LayaDeps = {}): Promise<StopResult> {
  const exec = deps.exec ?? runCommand;
  // A stop cancels any start we were tracking: nothing is loading after this.
  pendingStart = null;
  const list = deps.processes ? await deps.processes() : procsFromTable(await snapshotProcessesAsync(true));
  const pids = layaPids(list);
  const before = await gpuUsedMiB(exec);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone, or not ours to kill: the wait below decides
    }
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const h = await (deps.health ? deps.health() : fetchHealth(1200));
    if (!h.ok) break;
    await sleep(500);
  }
  const after = await gpuUsedMiB(exec);
  const freedMiB = before !== null && after !== null ? Math.max(0, before - after) : 0;
  return { stopped: pids, freedMiB };
}

// ── start ────────────────────────────────────────────────────────────────────

export type StartResult = { started: boolean; refused?: boolean; reason?: string; pid?: number };

export type StartDeps = {
  health?: () => Promise<HealthResult>;
  /** test seam: proves startLaya refuses BEFORE any process is spawned */
  spawn?: (device: "gpu" | "cpu") => Promise<number>;
};

export async function startLaya(opts: { device: "gpu" | "cpu" } & StartDeps): Promise<StartResult> {
  if (opts.device !== "gpu" && opts.device !== "cpu") {
    return { started: false, refused: true, reason: 'device must be "gpu" or "cpu"' };
  }
  const health = await (opts.health ? opts.health() : fetchHealth());
  if (health.ok) {
    pendingStart = null;
    return { started: false, refused: true, reason: "Laya is already answering on :8000" };
  }
  const pid = await (opts.spawn ? opts.spawn(opts.device) : spawnLaya(opts.device));
  // Remember the request: while this exists and health is silent, layaStatus() reports
  // `starting` (process alive) or `lastStartError` (process gone past the grace period).
  pendingStart = { device: opts.device, at: Date.now() };
  return { started: true, ...(pid > 0 ? { pid } : {}) };
}

// ── switch (item 1) ─────────────────────────────────────────────────────────

export type SwitchResult = {
  switched: boolean;
  /** the device Laya was on before the switch, when health told us */
  from: LayaDevice | null;
  /** the device the switch asked for: always the opposite of `from` when `from` is known */
  to: LayaDevice;
  stopped: number[];
  failedAt?: "stop" | "wait" | "start";
  reason?: string;
};

export type SwitchDeps = {
  health?: () => Promise<HealthResult>;
  stop?: () => Promise<StopResult>;
  start?: (device: LayaDevice) => Promise<StartResult>;
  /** test seam: how long to wait for health to go down (default 15 s) */
  waitMs?: number;
  /** test seam: pause between health checks while waiting (default 500 ms) */
  pollMs?: number;
};

/**
 * One action: stop Laya, wait up to 15 s for health to go down, then start it on the other
 * device. The target is derived from what health says Laya is on, so the caller cannot ask
 * for the device it is already on. If the stop part fails (the stop throws, or health is
 * still answering after the wait) nothing is started and `failedAt` says where it stopped.
 */
export async function switchLaya(opts: { device?: LayaDevice } & SwitchDeps = {}): Promise<SwitchResult> {
  const health = opts.health ?? (() => fetchHealth());
  const before = await health();
  const from = deviceOf(before.json);
  const to: LayaDevice = from === "cpu" ? "gpu" : from === "gpu" ? "cpu" : (opts.device === "cpu" ? "cpu" : "gpu");

  if (from !== null && opts.device && opts.device !== to) {
    return { switched: false, from, to, stopped: [], reason: `Laya is already on ${deviceWord(opts.device)}` };
  }

  let stopped: number[] = [];
  try {
    const r = await (opts.stop ? opts.stop() : stopLaya());
    stopped = Array.isArray(r?.stopped) ? r.stopped : [];
  } catch (e) {
    return {
      switched: false, from, to, stopped,
      failedAt: "stop",
      reason: `Laya could not be stopped (${clip(oneLine(String(e)), 200)}). Nothing was started.`,
    };
  }

  const waitMs = opts.waitMs ?? SWITCH_STOP_WAIT_MS;
  const pollMs = Math.max(50, opts.pollMs ?? 500);
  const deadline = Date.now() + waitMs;
  let down = !(await health()).ok;
  while (!down && Date.now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    down = !(await health()).ok;
  }
  if (!down) {
    const waited = waitMs >= 10_000 ? String(Math.round(waitMs / 1000)) : (waitMs / 1000).toFixed(1);
    return {
      switched: false, from, to, stopped,
      failedAt: "wait",
      reason: `Laya was stopped but is still answering after ${waited} seconds, so it was not started on ${deviceWord(to)}.`,
    };
  }

  const started = await (opts.start ? opts.start(to) : startLaya({ device: to, health }));
  if (!started.started) {
    return {
      switched: false, from, to, stopped,
      failedAt: "start",
      reason: started.reason ?? `Laya was stopped but could not be started on ${deviceWord(to)}.`,
    };
  }
  return { switched: true, from, to, stopped };
}

/**
 * Launch scripts/serve-laya.ps1 as a hidden, detached process and return its pid at once.
 * Same mechanics as lifecycle.spawnDetachedShutdown: a short FOREGROUND powershell calls
 * Start-Process (UseShellExecute=$false with both streams redirected to log files), so the
 * child is not a child of the router and a caller never blocks on inherited pipe handles.
 * Only the fixed script path, the log dir and the CPU switch are ever passed.
 */
async function spawnLaya(device: "gpu" | "cpu"): Promise<number> {
  const root = process.cwd();
  const script = path.join(root, "scripts", "serve-laya.ps1");
  if (!fs.existsSync(script)) {
    throw new Error(`scripts/serve-laya.ps1 not found at ${script}`);
  }
  const logDir = path.join(root, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const argLine = [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", winQuote(script),
    "-LogDir", winQuote(logDir),
    ...(device === "cpu" ? ["-Cpu"] : []),
  ].join(" ");
  const outLog = path.join(logDir, "laya-control.out.log");
  const errLog = path.join(logDir, "laya-control.err.log");
  const inner =
    `Start-Process -FilePath 'powershell' -WindowStyle Hidden ` +
    `-ArgumentList ${psQuote(argLine)} ` +
    `-RedirectStandardOutput ${psQuote(outLog)} ` +
    `-RedirectStandardError ${psQuote(errLog)} ` +
    `-WorkingDirectory ${psQuote(root)} -PassThru | Select-Object -ExpandProperty Id`;
  const res = await runCommand("powershell", ["-NoProfile", "-NonInteractive", "-Command", inner], 30_000);
  const pid = Number(res.stdout.trim().split(/\r?\n/).pop() ?? "");
  if (!Number.isFinite(pid) || pid <= 0) {
    throw new Error(
      `could not start scripts/serve-laya.ps1 (${clip(oneLine(res.stderr || res.error || "no pid returned"), 300)}). ` +
        "Run it by hand: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/serve-laya.ps1",
    );
  }
  return pid;
}

function winQuote(s: string): string {
  return `"${String(s).replace(/"/g, '\\"')}"`;
}
function psQuote(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// ── command helper (same shape as terminalReaper.runCommand) ─────────────────

function runCommand(cmd: string, args: string[], timeoutMs: number): Promise<CmdResult> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<typeof execFile> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: CmdResult): void => {
      if (settled) return;
      settled = true;
      if (hardTimer) clearTimeout(hardTimer);
      resolve(result);
    };
    hardTimer = setTimeout(() => {
      finish({ ok: false, stdout: "", stderr: "", error: `timed out after ${timeoutMs}ms (child killed)` });
      try {
        child?.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, timeoutMs + 2000);
    hardTimer.unref?.();
    try {
      child = execFile(
        cmd,
        args,
        { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) =>
          finish({
            ok: !err,
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
            ...(err ? { error: String(err) } : {}),
          }),
      );
    } catch (e) {
      finish({ ok: false, stdout: "", stderr: "", error: String(e) });
    }
  });
}
