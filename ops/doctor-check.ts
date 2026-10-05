#!/usr/bin/env node
/**
 * ops/doctor-check.ts - proof for order F01-doctor (2026-10-06).
 *
 * Runs the REAL checks in ops/doctor.ts through FAKED probes against a
 * TEMPORARY folder under the OS temp dir. The repository .env is never opened
 * by this harness and every secret-looking string below is fake. No network
 * calls are made (the doctor itself makes none either).
 *
 *   npx tsx ops/doctor-check.ts
 *
 * Prints PASS or FAIL per line; exit code is 1 if any line is FAIL.
 *
 * Covered:
 *   1. a missing .env is a FAIL with a fix text
 *   2. all-pass fixture -> ok, exit 0; and every non-PASS check carries a fix
 *   3. a present key with an EMPTY value is reported by NAME only
 *   4. no fake secret VALUE appears in the text output or the JSON output
 *   5. --json output parses, from renderJson() and from the real CLI
 *   6. an absent GPU is WARN, never FAIL (and does not fail the run)
 *   7. exit code is 1 on any FAIL and 0 otherwise (pure + real CLI)
 *   8. Node too old is FAIL; ports in use are WARN with "in use"
 *   9. one output line per check
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  exitCodeFor,
  parseEnvFile,
  realProbes,
  renderJson,
  renderText,
  runDoctor,
  type CheckResult,
  type DoctorOptions,
  type DoctorProbes,
  type DoctorResult,
} from "./doctor.js";

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HARNESS_DIR, "..");

// Fake, secret-looking values. Nothing here is a real credential.
const SECRET_VALUE = "doctor_check_secret_value_9f3a7c";
const ALPHA_VALUE = "doctor_check_alpha_value_1122";
const FAKE_GPU = "NVIDIA GeForce RTX 4090 (fake)";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? `  -> ${detail}` : ""}`);
}

const tempDirs: string[] = [];
function mkroot(tag: string, files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `doctor-check-${tag}-`));
  tempDirs.push(dir);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text, "utf8");
  return dir;
}

/** Real filesystem probes (over a temp root) with the environment-sensitive ones faked. */
function probes(over: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    ...realProbes(),
    nodeVersion: () => "v20.11.0",
    gitVersion: () => "git version 2.43.0",
    findJcode: () => path.join("C:", "fake", "jcode.exe"),
    tsxVersion: () => "4.23.15",
    portInUse: async () => false,
    gpuName: () => FAKE_GPU,
    freeRamMB: () => 8192,
    totalRamMB: () => 16384,
    freeDiskGB: () => 120,
    ...over,
  };
}

function options(root: string, over: Partial<DoctorOptions> = {}): DoctorOptions {
  return { root, ports: [8787, 8000], minNodeMajor: 20, minRamMB: 2048, minDiskGB: 2, ...over };
}

function find(result: DoctorResult, name: string): CheckResult | undefined {
  return result.checks.find((c) => c.name === name);
}

const EXAMPLE_OK = ["# fake .env.example", "DT_ALPHA=1", "DT_EMPTY=", "DT_SECRET=changeme", ""].join("\n");
const ENV_ALL_SET = [
  `DT_ALPHA=${ALPHA_VALUE}`,
  "DT_EMPTY=doctor_check_empty_value_ok",
  `DT_SECRET=${SECRET_VALUE}`,
  "",
].join("\n");

async function main(): Promise<void> {
  // ---- 1 + 2: all-pass fixture, missing .env ---------------------------------
  const allRoot = mkroot("allpass", { ".env.example": EXAMPLE_OK, ".env": ENV_ALL_SET });
  const allPass = await runDoctor(probes(), options(allRoot));
  const failuresInAllPass = allPass.checks.filter((c) => c.status === "FAIL").map((c) => c.name);
  check(
    "all-pass fixture has no FAIL and ok=true",
    allPass.ok && failuresInAllPass.length === 0,
    `checks=${allPass.checks.length}; fails=${JSON.stringify(failuresInAllPass)}`,
  );
  const noFixNeeded = allPass.checks.every((c) => c.status === "PASS" || c.fix.trim() !== "");
  check(
    "every non-PASS check carries a one-line fix (all-pass fixture)",
    noFixNeeded,
    `statuses=${JSON.stringify(allPass.checks.map((c) => c.status))}`,
  );
  check(
    "Render: one output line per check",
    renderText(allPass).split("\n").length === allPass.checks.length && allPass.checks.length > 0,
    `lines=${renderText(allPass).split("\n").length}; checks=${allPass.checks.length}`,
  );

  const missingRoot = mkroot("noenv", { ".env.example": EXAMPLE_OK });
  const missing = await runDoctor(probes(), options(missingRoot));
  const envCheck = find(missing, ".env");
  check(
    "missing .env gives a FAIL with a fix text",
    envCheck?.status === "FAIL" && (envCheck.fix ?? "").trim().length > 0 && /\.env\.example/.test(envCheck.fix ?? ""),
    `status=${envCheck?.status}; fix=${JSON.stringify(envCheck?.fix ?? "")}`,
  );
  const keysWhenMissing = find(missing, ".env keys");
  check(
    "missing .env also FAILs the key check rather than skipping it",
    keysWhenMissing?.status === "FAIL" && keysWhenMissing.fix.trim() !== "",
    `status=${keysWhenMissing?.status}`,
  );
  check(
    "exit code is 1 on any FAIL",
    exitCodeFor(missing) === 1 && missing.ok === false,
    `exit=${exitCodeFor(missing)}; ok=${missing.ok}`,
  );
  check(
    "exit code is 0 when nothing FAILs",
    exitCodeFor(allPass) === 0 && allPass.ok === true,
    `exit=${exitCodeFor(allPass)}; ok=${allPass.ok}`,
  );

  // ---- 3 + 4: empty value named only, no value ever printed ------------------
  const emptyValueEnv = [`DT_ALPHA=${ALPHA_VALUE}`, "DT_EMPTY=", `DT_SECRET=${SECRET_VALUE}`, ""].join("\n");
  const emptyRoot = mkroot("emptyvalue", { ".env.example": EXAMPLE_OK, ".env": emptyValueEnv });
  const emptyResult = await runDoctor(probes(), options(emptyRoot));
  const keyCheck = find(emptyResult, ".env keys");
  check(
    "a present key with an empty value is reported by name",
    keyCheck?.status === "FAIL" && (keyCheck.detail ?? "").includes("DT_EMPTY") && (keyCheck.detail ?? "").includes("empty"),
    `status=${keyCheck?.status}; detail=${JSON.stringify(keyCheck?.detail ?? "")}`,
  );
  check(
    "the empty key's name is in the fix, and a key that IS set is not named",
    (keyCheck?.fix ?? "").includes("DT_EMPTY") && !(keyCheck?.detail ?? "").includes("DT_ALPHA"),
    `fix=${JSON.stringify(keyCheck?.fix ?? "")}`,
  );
  check(
    "every non-PASS check carries a fix (empty-value fixture)",
    emptyResult.checks.every((c) => c.status === "PASS" || c.fix.trim() !== ""),
    `statuses=${JSON.stringify(emptyResult.checks.map((c) => c.status))}`,
  );

  const textOut = renderText(emptyResult);
  const jsonOut = renderJson(emptyResult);
  const sentinelIn = (text: string) => [SECRET_VALUE, ALPHA_VALUE, "changeme", "doctor_check_empty_value_ok"].filter((v) => text.includes(v));
  const textLeaks = sentinelIn(textOut);
  const jsonLeaks = sentinelIn(jsonOut);
  check(
    "no fake secret value appears in the text output",
    textLeaks.length === 0,
    textLeaks.length ? `leaked ${textLeaks.length} value(s)` : "value-free (names only)",
  );
  check(
    "no fake secret value appears in the JSON output",
    jsonLeaks.length === 0,
    jsonLeaks.length ? `leaked ${jsonLeaks.length} value(s)` : "value-free (names only)",
  );
  check(
    "the parsed .env in memory really held the fake secrets (so the leak test is meaningful)",
    parseEnvFile(emptyValueEnv).get("DT_SECRET") === SECRET_VALUE,
    `keys=${JSON.stringify([...parseEnvFile(emptyValueEnv).keys()])}`,
  );

  // ---- 5: --json output parses ----------------------------------------------
  let parsedJson: { checks?: unknown; ok?: unknown } | null = null;
  let jsonParseError = "";
  try {
    parsedJson = JSON.parse(jsonOut) as { checks?: unknown; ok?: unknown };
  } catch (e) {
    jsonParseError = String(e instanceof Error ? e.message : e);
  }
  const jsonChecks = Array.isArray(parsedJson?.checks) ? (parsedJson?.checks as CheckResult[]) : [];
  check(
    "renderJson() output parses to one object with checks[] and a boolean ok",
    parsedJson !== null && jsonChecks.length === emptyResult.checks.length && typeof parsedJson.ok === "boolean",
    jsonParseError ? `parse error: ${jsonParseError}` : `checks=${jsonChecks.length}; ok=${String(parsedJson?.ok)}`,
  );
  check(
    "every JSON check has name/status/detail/fix and a valid status",
    jsonChecks.every(
      (c) =>
        typeof c?.name === "string" &&
        ["PASS", "WARN", "FAIL"].includes(c?.status) &&
        typeof c.detail === "string" &&
        typeof c.fix === "string",
    ),
    `sample=${JSON.stringify(jsonChecks[0] ?? null)}`,
  );

  // ---- 6: absent GPU is WARN, never FAIL ------------------------------------
  const gpuRoot = mkroot("nogpu", { ".env.example": EXAMPLE_OK, ".env": ENV_ALL_SET });
  const noGpu = await runDoctor(probes({ gpuName: () => null }), options(gpuRoot));
  const gpuCheck = find(noGpu, "gpu");
  check(
    "absent GPU is WARN not FAIL, with a fix, and does not fail the run",
    gpuCheck?.status === "WARN" && gpuCheck.fix.trim() !== "" && noGpu.ok === true && exitCodeFor(noGpu) === 0,
    `status=${gpuCheck?.status}; ok=${noGpu.ok}`,
  );

  // ---- 7 + 8: old Node, busy ports, low RAM/disk ----------------------------
  const oldRoot = mkroot("oldnode", { ".env.example": EXAMPLE_OK, ".env": ENV_ALL_SET });
  const oldNode = await runDoctor(probes({ nodeVersion: () => "v18.20.4" }), options(oldRoot));
  const nodeCheck = find(oldNode, "node");
  check(
    "Node older than 20 is FAIL with a fix that says 20",
    nodeCheck?.status === "FAIL" && /20/.test(nodeCheck.fix),
    `status=${nodeCheck?.status}; fix=${JSON.stringify(nodeCheck?.fix ?? "")}`,
  );

  const busyRoot = mkroot("busyports", { ".env.example": EXAMPLE_OK, ".env": ENV_ALL_SET });
  const busy = await runDoctor(probes({ portInUse: async () => true }), options(busyRoot));
  const p8787 = find(busy, "port 8787");
  const p8000 = find(busy, "port 8000");
  check(
    "ports in use are WARN with detail \"in use\" (and free ports say \"free\")",
    p8787?.status === "WARN" && p8787.detail === "in use" && p8000?.status === "WARN" && p8000.fix.trim() !== "" &&
      find(allPass, "port 8787")?.status === "PASS" && find(allPass, "port 8787")?.detail === "free",
    `8787=${p8787?.status}/${p8787?.detail}; 8000=${p8000?.status}/${p8000?.detail}`,
  );

  const tightRoot = mkroot("tight", { ".env.example": EXAMPLE_OK, ".env": ENV_ALL_SET });
  const tight = await runDoctor(probes({ freeRamMB: () => 256, freeDiskGB: () => 1 }), options(tightRoot));
  check(
    "low RAM and low disk are WARN (exit stays 0 when nothing FAILs)",
    find(tight, "ram")?.status === "WARN" && find(tight, "disk")?.status === "WARN" && exitCodeFor(tight) === 0,
    `ram=${find(tight, "ram")?.status}; disk=${find(tight, "disk")?.status}; exit=${exitCodeFor(tight)}`,
  );

  // ---- real CLI: --json parses and the exit code follows ok -----------------
  const cli = spawnSync("npx tsx ops/doctor.ts --json", {
    cwd: REPO_ROOT,
    encoding: "utf8",
    shell: true,
    timeout: 180000,
    windowsHide: true,
  });
  let cliJson: DoctorResult | null = null;
  let cliParseError = "";
  try {
    cliJson = JSON.parse((cli.stdout ?? "").trim()) as DoctorResult;
  } catch (e) {
    cliParseError = String(e instanceof Error ? e.message : e);
  }
  check(
    "real CLI `npx tsx ops/doctor.ts --json` prints one parsable JSON object",
    cliJson !== null && Array.isArray(cliJson.checks) && typeof cliJson.ok === "boolean" && cliJson.checks.length > 0,
    cliParseError ? `parse error: ${cliParseError}; stderr=${JSON.stringify((cli.stderr ?? "").slice(0, 200))}` : `checks=${cliJson?.checks.length}; ok=${cliJson?.ok}`,
  );
  check(
    "real CLI exit code is 1 on any FAIL and 0 otherwise",
    cli.status === (cliJson?.ok ? 0 : 1) && (cli.status === 0 || cli.status === 1),
    `exit=${cli.status}; ok=${cliJson?.ok}`,
  );
  check(
    "real CLI stdout leaks no fake test value",
    sentinelIn(cli.stdout ?? "").length === 0 && !(cli.stdout ?? "").includes(SECRET_VALUE),
    `statuses=${JSON.stringify((cliJson?.checks ?? []).map((c) => `${c.name}=${c.status}`))}`,
  );
}

try {
  await main();
} catch (e) {
  check("harness completed without throwing", false, String(e instanceof Error ? e.message : e));
} finally {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort: outside the repo */
    }
  }
}

console.log(failures === 0 ? "doctor-check: all checks passed" : `doctor-check: ${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
