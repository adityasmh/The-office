#!/usr/bin/env node
/**
 * ops/run-all-checks-check.ts - proof for order F08-run-all-checks (2026-10-06).
 *
 * Drives the REAL runner (ops/run-all-checks.ts) against a TEMPORARY manifest of
 * tiny dummy scripts under the OS temp dir. Nothing here touches the live router,
 * the network, .env or company/ - the dummies only print and exit, except one that
 * appends to a sentinel file inside the same temp dir.
 *
 *   npx tsx ops/run-all-checks-check.ts
 *
 * Prints PASS or FAIL per line; exit code is 1 if any line is FAIL.
 *
 * Covered:
 *   1. a passing script is PASS
 *   2. a failing script is FAIL, the run exits 1, and the last 6 output lines are shown
 *      (the 7th-from-last is not)
 *   3. a script that outlives timeoutSec is TIMEOUT (and the run exits 1)
 *   4. a network-marked script is SKIPPED-network by default and does NOT run
 *   5. the same script runs (PASS) with --include-network
 *   6. --only filters, by exact name and by substring
 *   7. the summary counts and the exit code follow the statuses
 *   8. the real ops/checks.manifest.json parses, every command points at a real
 *      file, names match their file, and no network=false entry hides a client call
 *   9. a missing manifest is a usage error (exit 2), not a crash
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO_ROOT, loadManifest, META_CHECKS, type CheckEntry } from "./run-all-checks.js";

const TEMP_MANIFEST = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "run-all-checks-check-")), "manifest.json");
const TEMP_DIR = path.dirname(TEMP_MANIFEST);
const REAL_MANIFEST = path.join(REPO_ROOT, "ops", "checks.manifest.json");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? `  -> ${detail}` : ""}`);
}

function write(file: string, text: string): string {
  fs.writeFileSync(path.join(TEMP_DIR, file), text, "utf8");
  return path.join(TEMP_DIR, file);
}

/** Runs the real runner and returns its stdout, stderr and exit code. */
function runner(args: string[]): { out: string; err: string; code: number | null } {
  const res = spawnSync(`npx tsx ops/run-all-checks.ts ${args.join(" ")}`, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    shell: true,
    timeout: 300_000,
    windowsHide: true,
  });
  return { out: res.stdout ?? "", err: res.stderr ?? "", code: res.status };
}

/** The table row for a check, e.g. "alpha  PASS  0.4  node ...". */
function row(out: string, name: string): string | null {
  const line = out.split(/\r?\n/).find((l) => new RegExp(`^${name}\\s+(PASS|FAIL|TIMEOUT|SKIPPED-network)\\s+[\\d.]+\\s`).test(l));
  return line ?? null;
}

function rowStatus(out: string, name: string): string {
  const match = row(out, name)?.match(new RegExp(`^${name}\\s+(\\S+)`));
  return match?.[1] ?? "(no row)";
}

function tableRows(out: string): string[] {
  return out.split(/\r?\n/).filter((l) => /^\S+\s+(PASS|FAIL|TIMEOUT|SKIPPED-network)\s+[\d.]+\s/.test(l));
}

async function main(): Promise<void> {
  // ---- the dummies -----------------------------------------------------------
  const alpha = write("alpha.mjs", "console.log('alpha ran'); process.exit(0);\n");
  const beta = write(
    "beta.mjs",
    "for (let i = 1; i <= 8; i++) console.log('beta-out line ' + i);\nprocess.exit(3);\n",
  );
  const gamma = write("gamma.mjs", "setTimeout(() => {}, 60000);\n");
  // The runner only prints the output of FAILures, so "did delta actually run?" is
  // proved by a sentinel file the dummy appends to, not by its stdout.
  const sentinel = path.join(TEMP_DIR, "delta-sentinel.txt");
  const delta = write(
    "delta.mjs",
    `import fs from "node:fs";\nfs.appendFileSync(${JSON.stringify(sentinel)}, "ran\\n");\nconsole.log("NETWORK-RAN-OK");\nprocess.exit(0);\n`,
  );

  const devManifest: CheckEntry[] = [
    { name: "alpha", command: `node "${alpha}"`, network: false, timeoutSec: 30 },
    { name: "beta", command: `node "${beta}"`, network: false, timeoutSec: 30 },
    { name: "gamma", command: `node "${gamma}"`, network: false, timeoutSec: 2 },
    { name: "delta", command: `node "${delta}"`, network: true, timeoutSec: 30 },
  ];
  fs.writeFileSync(TEMP_MANIFEST, `${JSON.stringify(devManifest, null, 2)}\n`, "utf8");

  // ---- 1 + 2 + 3 + 4 + 7: the default (offline) run ---------------------------
  const full = runner([`--manifest "${TEMP_MANIFEST}"`]);
  check(
    "a passing script is PASS",
    rowStatus(full.out, "alpha") === "PASS",
    `row=${JSON.stringify(row(full.out, "alpha"))}`,
  );
  check(
    "a failing script is FAIL (exit code 3 from the dummy)",
    rowStatus(full.out, "beta") === "FAIL",
    `row=${JSON.stringify(row(full.out, "beta"))}`,
  );
  check(
    "a script that outlives timeoutSec is TIMEOUT",
    rowStatus(full.out, "gamma") === "TIMEOUT",
    `row=${JSON.stringify(row(full.out, "gamma"))}`,
  );
  check(
    "a network-marked script is SKIPPED-network by default",
    rowStatus(full.out, "delta") === "SKIPPED-network",
    `row=${JSON.stringify(row(full.out, "delta"))}`,
  );
  check(
    "a skipped network script does not run at all",
    !fs.existsSync(sentinel),
    fs.existsSync(sentinel) ? "delta ran anyway" : "no sentinel written by delta",
  );
  check(
    "the run exits 1 when a check FAILs or TIMEOUTs",
    full.code === 1,
    `exit=${full.code}`,
  );
  check(
    "the FAIL tail shows the last 6 output lines and stops there",
    full.out.includes("beta-out line 8") && full.out.includes("beta-out line 3") && !full.out.includes("beta-out line 2"),
    `line3=${full.out.includes("beta-out line 3")}; line2=${full.out.includes("beta-out line 2")}`,
  );
  check(
    "the TIMEOUT tail records the kill",
    /killed after 2s/.test(full.out),
    `killed-line=${JSON.stringify(full.out.split(/\r?\n/).find((l) => l.includes("killed after")) ?? "")}`,
  );
  check(
    "the summary counts each status exactly once",
    /run-all-checks: 1 PASS, 1 FAIL, 1 TIMEOUT, 1 SKIPPED-network/.test(full.out),
    `summary=${JSON.stringify(full.out.split(/\r?\n/).find((l) => /^\d|^run-all-checks: \d/.test(l) && l.includes("PASS,")) ?? "")}`,
  );
  check(
    "the table has exactly one row per manifest entry",
    tableRows(full.out).length === devManifest.length,
    `rows=${tableRows(full.out).length}`,
  );

  // ---- 6: --only filters (substring), and a filter-only run can exit 0 ---------
  const only = runner([`--manifest "${TEMP_MANIFEST}"`, "--only alph"]);
  check(
    "--only (substring) runs just the matching check",
    tableRows(only.out).length === 1 && rowStatus(only.out, "alpha") === "PASS" && !only.out.includes("beta-out line"),
    `rows=${JSON.stringify(tableRows(only.out))}`,
  );
  check(
    "a run with no FAIL and no TIMEOUT exits 0",
    only.code === 0,
    `exit=${only.code}`,
  );
  check(
    "--only reports how many of the manifest it selected",
    only.out.includes("1 of 4 check(s)"),
    `banner=${JSON.stringify(only.out.split(/\r?\n/)[0] ?? "")}`,
  );

  // ---- 4 + 5: the same network check, skipped then included --------------------
  const skipped = runner([`--manifest "${TEMP_MANIFEST}"`, "--only delta"]);
  check(
    "--only an exact name + default: the network check is skipped and the run exits 0",
    rowStatus(skipped.out, "delta") === "SKIPPED-network" && !fs.existsSync(sentinel) && skipped.code === 0,
    `status=${rowStatus(skipped.out, "delta")}; ran=${fs.existsSync(sentinel)}; exit=${skipped.code}`,
  );
  fs.rmSync(sentinel, { force: true });
  const included = runner([`--manifest "${TEMP_MANIFEST}"`, "--include-network", "--only delta"]);
  check(
    "--include-network runs the network check and it PASSes",
    rowStatus(included.out, "delta") === "PASS" && fs.existsSync(sentinel) && included.code === 0,
    `status=${rowStatus(included.out, "delta")}; ran=${fs.existsSync(sentinel)}; exit=${included.code}`,
  );

  // ---- 9: a missing manifest is exit 2, not a crash ----------------------------
  const missing = runner([`--manifest "${path.join(TEMP_DIR, "nope", "manifest.json")}"`]);
  check(
    "a missing manifest exits 2 with a message",
    missing.code === 2 && /cannot read manifest/i.test(missing.err + missing.out),
    `exit=${missing.code}; msg=${JSON.stringify((missing.err + missing.out).split(/\r?\n/)[0] ?? "")}`,
  );

  // ---- 8: the real manifest ----------------------------------------------------
  let real: CheckEntry[] = [];
  let parseError = "";
  try {
    real = loadManifest(REAL_MANIFEST);
  } catch (e) {
    parseError = String(e instanceof Error ? e.message : e);
  }
  check(
    "the real manifest parses to a non-empty list with unique names",
    parseError === "" && real.length > 0,
    parseError ? `parse error: ${parseError}` : `entries=${real.length}`,
  );
  check(
    "every real command's file exists and matches its name",
    real.every((e) => {
      const token = e.command.split(/\s+/).filter(Boolean).pop() ?? "";
      const file = path.basename(token.replace(/^"|"$/g, ""));
      return file === `${e.name}-check.ts` || file === `${e.name}-check.mjs`;
    }) &&
      real.every((e) => {
        const token = e.command.split(/\s+/).filter(Boolean).pop() ?? "";
        const file = path.basename(token.replace(/^"|"$/g, ""));
        return fs.existsSync(path.join(REPO_ROOT, "ops", file));
      }),
    `missing=${JSON.stringify(
      real
        .filter((e) => {
          const token = e.command.split(/\s+/).filter(Boolean).pop() ?? "";
          return !fs.existsSync(path.join(REPO_ROOT, "ops", path.basename(token.replace(/^"|"$/g, ""))));
        })
        .map((e) => e.name),
    )}`,
  );
  const onDisk = fs
    .readdirSync(path.join(REPO_ROOT, "ops"))
    .filter((f) => /-check\.(ts|mjs)$/.test(f) && !META_CHECKS.has(f))
    .sort();
  const listedFiles = new Set(
    real.map((e) => path.basename((e.command.split(/\s+/).filter(Boolean).pop() ?? "").replace(/^"|"$/g, ""))),
  );
  const unlisted = onDisk.filter((f) => !listedFiles.has(f));
  check(
    "every ops/*-check script on disk is in the real manifest",
    unlisted.length === 0,
    `listed=${listedFiles.size}/${onDisk.length}; unlisted=${JSON.stringify(unlisted)}`,
  );
  const networkEntries = real.filter((e) => e.network);
  const clientTokens = ["fetch(", "net.connect(", "new WebSocket(", "https://", "http://"];
  check(
    "the manifest flags some network checks, and each really names a client call or host",
    networkEntries.length > 0 &&
      networkEntries.every((e) => {
        const token = e.command.split(/\s+/).filter(Boolean).pop() ?? "";
        const text = fs.readFileSync(path.join(REPO_ROOT, "ops", path.basename(token.replace(/^"|"$/g, ""))), "utf8");
        return clientTokens.some((t) => text.includes(t));
      }),
    `network=${networkEntries.length}/${real.length}`,
  );
  check(
    "no network=false entry hides a fetch( or socket client",
    real
      .filter((e) => !e.network)
      .every((e) => {
        const token = e.command.split(/\s+/).filter(Boolean).pop() ?? "";
        const text = fs.readFileSync(path.join(REPO_ROOT, "ops", path.basename(token.replace(/^"|"$/g, ""))), "utf8");
        return !text.includes("fetch(") && !text.includes("net.connect(") && !text.includes("new WebSocket(");
      }),
    "",
  );
  check(
    "every timeoutSec is a positive number and every network flag a boolean",
    real.every((e) => typeof e.network === "boolean" && Number.isFinite(e.timeoutSec) && e.timeoutSec > 0),
    `min=${Math.min(...real.map((e) => e.timeoutSec))}s max=${Math.max(...real.map((e) => e.timeoutSec))}s`,
  );
}

try {
  await main();
} catch (e) {
  check("harness completed without throwing", false, String(e instanceof Error ? e.message : e));
} finally {
  try {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  } catch {
    /* best effort: outside the repo */
  }
}

console.log(failures === 0 ? "run-all-checks-check: all checks passed" : `run-all-checks-check: ${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
