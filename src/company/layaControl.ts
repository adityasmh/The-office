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
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { snapshotProcessesAsync, type ProcMap } from "./terminalReaper.js";

const HEALTH_TIMEOUT_MS = 2500;
const GPU_TIMEOUT_MS = 8000;

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
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
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
  loaded: string[];
  pids: number[];
  gpu: GpuInfo | null;
  layaGpuMiB: number | null;
};

export type LayaDeps = {
  health?: () => Promise<HealthResult>;
  processes?: () => Promise<ProcInput[]> | ProcInput[];
  exec?: ExecFn;
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

export async function layaStatus(deps: LayaDeps = {}): Promise<LayaStatus> {
  const exec = deps.exec ?? runCommand;
  const health = await (deps.health ? deps.health() : fetchHealth());
  const list = deps.processes ? await deps.processes() : procsFromTable(await snapshotProcessesAsync(true));
  const pids = layaPids(list);
  const { gpu, layaGpuMiB } = await readGpu(exec, pids);
  const json = health.json;
  return {
    ok: health.ok,
    device: json && typeof json.device === "string" ? json.device : null,
    checkpointDevices: deviceNames(json),
    loaded: loadedNames(json),
    pids,
    gpu,
    layaGpuMiB,
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
    return { started: false, refused: true, reason: "Laya is already answering on :8000" };
  }
  const pid = await (opts.spawn ? opts.spawn(opts.device) : spawnLaya(opts.device));
  return { started: true, ...(pid > 0 ? { pid } : {}) };
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
