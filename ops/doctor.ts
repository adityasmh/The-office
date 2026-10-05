#!/usr/bin/env node
/**
 * ops/doctor.ts - one command that tells a new developer what is missing.
 *
 *   npx tsx ops/doctor.ts            # one PASS / WARN / FAIL line per check
 *   npx tsx ops/doctor.ts --json     # a single JSON object {checks:[...],ok}
 *
 * Every FAIL and WARN carries a one-line fix. The process exits 1 if any check
 * FAILs and 0 otherwise. Nothing here makes a network call.
 *
 * The checks are pure functions of an injectable `DoctorProbes` object, so the
 * proof harness (ops/doctor-check.ts) can fake every probe and run against a
 * temporary folder. Key NAMES from .env.example / .env are compared; the values
 * are never printed or returned (only "present" / "empty" / "missing").
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Status = "PASS" | "WARN" | "FAIL";

export interface CheckResult {
  name: string;
  status: Status;
  detail: string;
  fix: string;
}

export interface DoctorResult {
  checks: CheckResult[];
  ok: boolean;
}

export interface DoctorOptions {
  /** Project root the file checks look at. Default: the repo containing this file. */
  root: string;
  /** Ports reported as "free" or "in use". Default: 8787 (router) and 8000 (Laya). */
  ports: number[];
  minNodeMajor: number;
  minRamMB: number;
  minDiskGB: number;
}

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_OPTIONS: DoctorOptions = {
  root: REPO_ROOT,
  ports: [8787, 8000],
  minNodeMajor: 20,
  minRamMB: 2048,
  minDiskGB: 2,
};

/** Every probe is a function so a proof can fake it. No probe touches the network. */
export interface DoctorProbes {
  nodeVersion(): string;
  /** Full `git --version` line, or null when git is not installed. */
  gitVersion(): string | null;
  /** Path of the jcode CLI on PATH or at the default install path, or null. */
  findJcode(): string | null;
  /** `tsx --version` output, or null when it cannot be run. */
  tsxVersion(): string | null;
  exists(p: string): boolean;
  readTextFile(p: string): string;
  portInUse(port: number): Promise<boolean>;
  /** GPU name from nvidia-smi, or null when there is no NVIDIA GPU / no driver. */
  gpuName(): string | null;
  freeRamMB(): number;
  totalRamMB(): number;
  freeDiskGB(dir: string): number;
  ensureDir(dir: string): { ok: boolean; error?: string };
  isWritable(dir: string): boolean;
}

/**
 * Minimal dotenv parser: returns key -> value for uncommented `KEY=value` lines.
 * Comments and blank lines are skipped, `export ` prefixes and surrounding
 * quotes are stripped. Callers must never print the returned values.
 */
export function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;
    const name = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    let value = withoutExport.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out.set(name, value);
  }
  return out;
}

/** Default install locations tried when `jcode` is not on PATH. */
export function defaultJcodeCandidates(): string[] {
  const home = os.homedir();
  const candidates: string[] = [];
  if (process.platform === "win32") {
    if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, "jcode", "bin", "jcode.exe"));
    candidates.push(path.join(home, "AppData", "Local", "jcode", "bin", "jcode.exe"));
    candidates.push(path.join(home, ".jcode", "bin", "jcode.exe"));
  } else {
    candidates.push(path.join(home, ".local", "bin", "jcode"));
    candidates.push("/usr/local/bin/jcode");
  }
  return candidates;
}

/** PATH lookup that also works on Windows (.exe / .cmd) without spawning a shell. */
function findOnPath(name: string): string | null {
  const pathValue = process.env.PATH ?? "";
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* not there */
      }
    }
  }
  return null;
}

function runCapture(cmd: string, args: string[]): string | null {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
    shell: process.platform === "win32",
  });
  if (res.error || res.status !== 0) return null;
  const text = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
  return text || null;
}

export function realProbes(): DoctorProbes {
  return {
    nodeVersion: () => process.version,
    gitVersion: () => runCapture("git", ["--version"]),
    findJcode: () => {
      const onPath = findOnPath("jcode");
      if (onPath) return onPath;
      for (const candidate of defaultJcodeCandidates()) {
        try {
          if (fs.statSync(candidate).isFile()) return candidate;
        } catch {
          /* not there */
        }
      }
      return null;
    },
    tsxVersion: () => {
      const direct = runCapture("tsx", ["--version"]);
      if (direct) return direct;
      // --no-install keeps this local: npx must not fetch tsx from the network.
      return runCapture("npx", ["--no-install", "tsx", "--version"]);
    },
    exists: (p) => fs.existsSync(p),
    readTextFile: (p) => fs.readFileSync(p, "utf8"),
    portInUse: (port) =>
      new Promise<boolean>((resolve) => {
        const server = net.createServer();
        server.once("error", (err: NodeJS.ErrnoException) => {
          resolve(err.code === "EADDRINUSE" || err.code === "EACCES");
        });
        server.once("listening", () => server.close(() => resolve(false)));
        server.listen(port, "127.0.0.1");
      }),
    gpuName: () => {
      const out = runCapture("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"]);
      return out ? out.split(/\r?\n/)[0]!.trim() || null : null;
    },
    freeRamMB: () => Math.round(os.freemem() / (1024 * 1024)),
    totalRamMB: () => Math.round(os.totalmem() / (1024 * 1024)),
    freeDiskGB: (dir) => {
      const stats = fs.statfsSync(dir);
      return Math.round((stats.bavail * stats.bsize) / (1024 * 1024 * 1024));
    },
    ensureDir: (dir) => {
      try {
        fs.mkdirSync(dir, { recursive: true });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e instanceof Error ? e.message : e) };
      }
    },
    isWritable: (dir) => {
      try {
        fs.accessSync(dir, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function pass(name: string, detail = ""): CheckResult {
  return { name, status: "PASS", detail, fix: "" };
}
function warn(name: string, detail: string, fix: string): CheckResult {
  return { name, status: "WARN", detail, fix };
}
function fail(name: string, detail: string, fix: string): CheckResult {
  return { name, status: "FAIL", detail, fix };
}

const MAX_NAMES_SHOWN = 8;

function nameList(names: string[]): string {
  const shown = names.slice(0, MAX_NAMES_SHOWN).join(", ");
  return names.length > MAX_NAMES_SHOWN ? `${shown} (+${names.length - MAX_NAMES_SHOWN} more)` : shown;
}

/**
 * Run all checks. `options.root` is the folder the file checks look at, which is
 * how the proof runs against a temporary folder instead of the repository.
 */
export async function runDoctor(probes: DoctorProbes, options: DoctorOptions = DEFAULT_OPTIONS): Promise<DoctorResult> {
  const checks: CheckResult[] = [];

  // 1. Node version.
  const nodeRaw = probes.nodeVersion();
  const nodeMajor = Number.parseInt(String(nodeRaw).replace(/^v/, "").split(".")[0] ?? "", 10);
  if (Number.isFinite(nodeMajor) && nodeMajor >= options.minNodeMajor) {
    checks.push(pass("node", `${nodeRaw} (>= ${options.minNodeMajor})`));
  } else {
    checks.push(
      fail(
        "node",
        `found ${nodeRaw || "nothing"}; Node ${options.minNodeMajor} or newer is required`,
        `Install Node.js ${options.minNodeMajor}+ from https://nodejs.org and make sure it is on PATH.`,
      ),
    );
  }

  // 2. git.
  const git = probes.gitVersion();
  if (git) {
    checks.push(pass("git", git));
  } else {
    checks.push(fail("git", "git was not found on PATH", "Install git from https://git-scm.com/downloads and reopen the terminal."));
  }

  // 3. jcode CLI.
  const jcode = probes.findJcode();
  if (jcode) {
    checks.push(pass("jcode", jcode));
  } else {
    checks.push(
      fail(
        "jcode",
        "not on PATH and not at a default install path",
        `Install the jcode CLI (or set JCODE_BIN in .env). Looked at: ${defaultJcodeCandidates().join(", ")}`,
      ),
    );
  }

  // 4. tsx (what every ops script runs on).
  const tsx = probes.tsxVersion();
  if (tsx) {
    checks.push(pass("npx tsx", `tsx ${tsx}`));
  } else {
    checks.push(fail("npx tsx", "tsx could not be run", "Run `npm install` in the project (tsx is a devDependency)."));
  }

  // 5. .env exists.
  const envPath = path.join(options.root, ".env");
  const examplePath = path.join(options.root, ".env.example");
  const hasEnv = probes.exists(envPath);
  if (hasEnv) {
    checks.push(pass(".env", ".env found"));
  } else {
    checks.push(fail(".env", ".env is missing", "Copy .env.example to .env, then fill in the values (never commit .env)."));
  }

  // 6. Every key NAME in .env.example present with a non-empty value in .env.
  //    Names only: a value is never read into the result or printed.
  if (!probes.exists(examplePath)) {
    checks.push(warn(".env keys", ".env.example is missing, so no key list to compare against", "Restore .env.example from git (`git checkout -- .env.example`)."));
  } else if (!hasEnv) {
    checks.push(fail(".env keys", "cannot check: .env is missing", "Copy .env.example to .env, then fill in the values."));
  } else {
    const expected = parseEnvFile(probes.readTextFile(examplePath));
    const actual = parseEnvFile(probes.readTextFile(envPath));
    const missing: string[] = [];
    const empty: string[] = [];
    for (const name of expected.keys()) {
      if (!actual.has(name)) missing.push(name);
      else if ((actual.get(name) ?? "").trim() === "") empty.push(name);
    }
    const wanted = expected.size;
    if (missing.length === 0 && empty.length === 0) {
      checks.push(pass(".env keys", `${wanted} key name(s) from .env.example are set`));
    } else {
      const parts: string[] = [];
      if (missing.length) parts.push(`missing: ${nameList(missing)}`);
      if (empty.length) parts.push(`empty: ${nameList(empty)}`);
      const named = [...missing, ...empty];
      checks.push(
        fail(
          ".env keys",
          `${named.length} of ${wanted} key(s) not set - ${parts.join("; ")}`,
          `Set ${nameList(named)} in .env (take the values from .env.example).`,
        ),
      );
    }
  }

  // 7. Ports (informational: the router / Laya may legitimately be running).
  for (const port of options.ports) {
    let busy = false;
    try {
      busy = await probes.portInUse(port);
    } catch {
      busy = false;
    }
    if (busy) {
      checks.push(warn(`port ${port}`, "in use", `Leave it if the router/Laya is already running, otherwise stop the process using port ${port}.`));
    } else {
      checks.push(pass(`port ${port}`, "free"));
    }
  }

  // 8. Optional GPU. Never a FAIL: the project runs fine on CPU.
  const gpu = probes.gpuName();
  if (gpu) {
    checks.push(pass("gpu", gpu));
  } else {
    checks.push(warn("gpu", "no NVIDIA GPU detected", "Optional: install an NVIDIA driver so nvidia-smi is on PATH. Not required to run."));
  }

  // 9. Free RAM.
  const freeRam = probes.freeRamMB();
  const totalRam = probes.totalRamMB();
  if (freeRam >= options.minRamMB) {
    checks.push(pass("ram", `${freeRam} MB free of ${totalRam} MB`));
  } else {
    checks.push(warn("ram", `${freeRam} MB free of ${totalRam} MB (want >= ${options.minRamMB} MB)`, "Close some applications to free memory before starting the fleet."));
  }

  // 10. Free disk.
  let freeDisk = 0;
  try {
    freeDisk = probes.freeDiskGB(options.root);
  } catch {
    freeDisk = 0;
  }
  if (freeDisk >= options.minDiskGB) {
    checks.push(pass("disk", `${freeDisk} GB free`));
  } else {
    checks.push(warn("disk", `${freeDisk} GB free (want >= ${options.minDiskGB} GB)`, "Free space on the drive that holds the project (logs and sessions grow over time)."));
  }

  // 11. company/ and logs/ exist and are writable (created when missing).
  for (const dirName of ["company", "logs"]) {
    const dir = path.join(options.root, dirName);
    const created = probes.ensureDir(dir);
    if (!created.ok) {
      checks.push(fail(`${dirName}/`, `could not create ${dir}: ${created.error ?? "unknown error"}`, `Create ${dir} yourself or fix the permissions of ${options.root}.`));
      continue;
    }
    if (probes.isWritable(dir)) {
      checks.push(pass(`${dirName}/`, "writable"));
    } else {
      checks.push(fail(`${dirName}/`, `${dir} is not writable`, `Give the current user write access to ${dir}.`));
    }
  }

  return { checks, ok: checks.every((c) => c.status !== "FAIL") };
}

export function exitCodeFor(result: DoctorResult): number {
  return result.ok ? 0 : 1;
}

function fixSuffix(check: CheckResult): string {
  return check.status !== "PASS" && check.fix ? `  | fix: ${check.fix}` : "";
}

export function renderText(result: DoctorResult): string {
  return result.checks.map((c) => `${c.status} ${c.name}${c.detail ? ` - ${c.detail}` : ""}${fixSuffix(c)}`).join("\n");
}

export function renderJson(result: DoctorResult): string {
  return JSON.stringify({ checks: result.checks, ok: result.ok }, null, 2);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const json = argv.includes("--json");
  const result = await runDoctor(realProbes(), DEFAULT_OPTIONS);
  if (json) {
    console.log(renderJson(result));
  } else {
    console.log(renderText(result));
    const fails = result.checks.filter((c) => c.status === "FAIL").length;
    const warns = result.checks.filter((c) => c.status === "WARN").length;
    console.log(
      result.ok
        ? `doctor: ok (${result.checks.length} checks, ${warns} warning(s))`
        : `doctor: ${fails} FAIL, ${warns} warning(s) - see the fixes above`,
    );
  }
  return exitCodeFor(result);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]).replace(/\.(ts|js)$/, "").toLowerCase() ===
    fileURLToPath(import.meta.url).replace(/\.(ts|js)$/, "").toLowerCase();

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      console.error(`doctor: unexpected error - ${String(e instanceof Error ? e.message : e)}`);
      process.exitCode = 1;
    });
}
