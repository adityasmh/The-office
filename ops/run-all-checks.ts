#!/usr/bin/env node
/**
 * ops/run-all-checks.ts - one command that runs every offline check in ops/.
 *
 *   npx tsx ops/run-all-checks.ts [--include-network] [--only name] [--manifest file]
 *
 * The list of checks lives in ops/checks.manifest.json (overridable with
 * --manifest). Every entry is:
 *
 *   { "name": "doctor", "command": "npx tsx ops/doctor-check.ts",
 *     "network": false, "timeoutSec": 180 }
 *
 * `network: true` means the script itself makes real network calls (it contains
 * fetch( / a socket client, or names a real https host). Those are SKIPPED unless
 * --include-network is passed - the default run stays offline.
 *
 * Checks run one at a time, in the foreground, and get the last 6 lines of their
 * output printed when they fail. Exit codes:
 *   0 = no FAIL and no TIMEOUT
 *   1 = at least one FAIL or TIMEOUT
 *   2 = bad usage, an unreadable/invalid manifest, or an --only that matches nothing
 *
 * Node built-ins only. No network calls of its own.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HARNESS_DIR, "..");
export const DEFAULT_MANIFEST = path.join(HARNESS_DIR, "checks.manifest.json");

/** The runner's own proof harness: it spawns this file, so it must never be listed as a check. */
export const META_CHECKS = new Set(["run-all-checks-check.ts", "run-all-checks-check.mjs"]);

export type CheckStatus = "PASS" | "FAIL" | "TIMEOUT" | "SKIPPED-network";

export interface CheckEntry {
  name: string;
  command: string;
  network: boolean;
  timeoutSec: number;
}

export interface CheckResult {
  name: string;
  command: string;
  status: CheckStatus;
  seconds: number;
  output: string;
}

export interface Options {
  includeNetwork: boolean;
  only: string | null;
  manifest: string;
}

class UsageError extends Error {}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function parseArgs(argv: string[]): Options {
  const opts: Options = { includeNetwork: false, only: null, manifest: DEFAULT_MANIFEST };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--include-network") {
      opts.includeNetwork = true;
    } else if (arg === "--only") {
      const value = argv[++i];
      if (value === undefined || value === "") throw new UsageError("--only needs a check name");
      opts.only = value;
    } else if (arg === "--manifest") {
      const value = argv[++i];
      if (value === undefined || value === "") throw new UsageError("--manifest needs a file");
      opts.manifest = path.resolve(process.cwd(), value);
    } else if (arg === "--help" || arg === "-h") {
      throw new UsageError("usage: npx tsx ops/run-all-checks.ts [--include-network] [--only name] [--manifest file]");
    } else {
      throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

export function loadManifest(file: string): CheckEntry[] {
  const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(raw)) throw new Error("manifest must be a JSON array of {name, command, network, timeoutSec}");
  const seen = new Set<string>();
  return raw.map((entry, i) => {
    const e = entry as Partial<CheckEntry> | null;
    const label = typeof e?.name === "string" && e.name.trim() !== "" ? e.name.trim() : `entry ${i}`;
    if (typeof e?.name !== "string" || e.name.trim() === "") throw new Error(`${label}: name must be a non-empty string`);
    if (typeof e.command !== "string" || e.command.trim() === "") throw new Error(`${label}: command must be a non-empty string`);
    if (typeof e.network !== "boolean") throw new Error(`${label}: network must be true or false`);
    if (typeof e.timeoutSec !== "number" || !Number.isFinite(e.timeoutSec) || e.timeoutSec <= 0) {
      throw new Error(`${label}: timeoutSec must be a positive number of seconds`);
    }
    const name = e.name.trim();
    if (seen.has(name)) throw new Error(`${label}: duplicate name ${JSON.stringify(name)}`);
    seen.add(name);
    return { name, command: e.command.trim(), network: e.network, timeoutSec: e.timeoutSec };
  });
}

/** Exact name first, then a case-insensitive substring; null `only` keeps everything. */
export function selectChecks(entries: CheckEntry[], only: string | null): CheckEntry[] {
  if (only === null) return entries;
  const needle = only.toLowerCase();
  const exact = entries.filter((e) => e.name.toLowerCase() === needle);
  if (exact.length > 0) return exact;
  return entries.filter((e) => e.name.toLowerCase().includes(needle));
}

/** ops/*-check.ts|mjs files that the manifest does not list (new checks land without an edit here). */
export function unlistedCheckFiles(root: string, entries: CheckEntry[]): string[] {
  const listed = new Set<string>();
  for (const e of entries) {
    const token = e.command.split(/\s+/).filter(Boolean).pop() ?? "";
    const file = path.basename(token.replace(/^"|"$/g, ""));
    if (file !== "") listed.add(file);
  }
  const dir = path.join(root, "ops");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /-check\.(ts|mjs)$/.test(f) && !listed.has(f) && !META_CHECKS.has(f))
    .sort();
}

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    // The command runs through cmd.exe, so kill the whole tree or the child survives.
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      /* best effort */
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* best effort */
      }
    }
  }
}

export function lastLines(text: string, n: number): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n).join("\n");
}

export function runCheck(entry: CheckEntry, cwd: string): Promise<CheckResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: CheckResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child: ChildProcess;
    try {
      child = spawn(entry.command, {
        cwd,
        shell: true,
        windowsHide: true,
        detached: process.platform !== "win32",
        env: { ...process.env, RUN_ALL_CHECKS_CHILD: "1" },
      });
    } catch (e) {
      settle({ name: entry.name, command: entry.command, status: "FAIL", seconds: 0, output: `spawn failed: ${msg(e)}` });
      return;
    }

    let output = "";
    const collect = (chunk: Buffer | string) => {
      output += chunk.toString();
      if (output.length > 400_000) output = output.slice(-200_000); // keep the tail of a runaway log
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (e) => {
      output += `\nspawn error: ${e.message}`;
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // The close event should follow; do not hang the whole run if it does not.
      setTimeout(() => {
        settle({
          name: entry.name,
          command: entry.command,
          status: "TIMEOUT",
          seconds: (Date.now() - start) / 1000,
          output: `${output}\n[run-all-checks] killed after ${entry.timeoutSec}s`,
        });
      }, 5000).unref();
    }, entry.timeoutSec * 1000);

    child.on("close", (code) => {
      clearTimeout(timer);
      settle({
        name: entry.name,
        command: entry.command,
        status: timedOut ? "TIMEOUT" : code === 0 ? "PASS" : "FAIL",
        seconds: (Date.now() - start) / 1000,
        output: timedOut ? `${output}\n[run-all-checks] killed after ${entry.timeoutSec}s` : output,
      });
    });
  });
}

export function renderTable(results: CheckResult[]): string {
  const nameW = Math.max(4, ...results.map((r) => r.name.length));
  const header = `${"name".padEnd(nameW)}  ${"status".padEnd(15)}  ${"secs".padStart(6)}  command`;
  const rule = "-".repeat(header.length);
  const rows = results.map(
    (r) => `${r.name.padEnd(nameW)}  ${r.status.padEnd(15)}  ${r.seconds.toFixed(1).padStart(6)}  ${r.command}`,
  );
  return [header, rule, ...rows].join("\n");
}

export function countStatuses(results: CheckResult[]): Record<CheckStatus, number> {
  const counts: Record<CheckStatus, number> = { PASS: 0, FAIL: 0, TIMEOUT: 0, "SKIPPED-network": 0 };
  for (const r of results) counts[r.status]++;
  return counts;
}

export function exitCodeFor(results: CheckResult[]): number {
  return results.some((r) => r.status === "FAIL" || r.status === "TIMEOUT") ? 1 : 0;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let opts: Options;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(`run-all-checks: ${msg(e)}`);
    return 2;
  }

  let entries: CheckEntry[];
  try {
    entries = loadManifest(opts.manifest);
  } catch (e) {
    console.error(`run-all-checks: cannot read manifest ${opts.manifest} - ${msg(e)}`);
    return 2;
  }

  const selected = selectChecks(entries, opts.only);
  if (selected.length === 0) {
    console.error(`run-all-checks: no check in ${opts.manifest} matches --only ${JSON.stringify(opts.only)}`);
    return 2;
  }

  const unlisted = unlistedCheckFiles(REPO_ROOT, entries);
  console.log(`run-all-checks: ${selected.length} of ${entries.length} check(s) from ${opts.manifest}${opts.includeNetwork ? " (including network checks)" : ""}`);
  if (unlisted.length > 0) {
    console.log(`run-all-checks: note - ${unlisted.length} ops/*-check file(s) are not in the manifest: ${unlisted.join(", ")}`);
  }

  const results: CheckResult[] = [];
  for (let i = 0; i < selected.length; i++) {
    const entry = selected[i];
    const progress = `[${i + 1}/${selected.length}]`;
    if (entry.network && !opts.includeNetwork) {
      console.log(`${progress} ${entry.name}: SKIPPED-network (needs --include-network)`);
      results.push({ name: entry.name, command: entry.command, status: "SKIPPED-network", seconds: 0, output: "" });
      continue;
    }
    console.log(`${progress} ${entry.name}: running ${entry.command} (timeout ${entry.timeoutSec}s) ...`);
    const result = await runCheck(entry, REPO_ROOT);
    console.log(`${progress} ${entry.name}: ${result.status} (${result.seconds.toFixed(1)}s)`);
    results.push(result);
  }

  console.log("");
  console.log(renderTable(results));

  for (const r of results.filter((x) => x.status === "FAIL" || x.status === "TIMEOUT")) {
    const tail = lastLines(r.output, 6);
    console.log("");
    console.log(`---- ${r.status} ${r.name} (${r.seconds.toFixed(1)}s) last 6 lines of ${r.command} ----`);
    console.log(tail === "" ? "(no output)" : tail);
  }

  const counts = countStatuses(results);
  console.log("");
  console.log(
    `run-all-checks: ${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts.TIMEOUT} TIMEOUT, ${counts["SKIPPED-network"]} SKIPPED-network`,
  );
  const code = exitCodeFor(results);
  console.log(`run-all-checks: exit ${code}${code === 0 ? "" : " (FAIL or TIMEOUT present)"}`);
  return code;
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
      console.error(`run-all-checks: unexpected error - ${msg(e)}`);
      process.exitCode = 1;
    });
}
