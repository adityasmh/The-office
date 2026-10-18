#!/usr/bin/env node
/**
 * ops/setup-check.ts - proof for order F02-setup (2026-10-06).
 *
 * Runs the REAL wizard (ops/setup.ts) against TEMPORARY folders under the OS temp dir.
 * The repository .env is never opened by this harness, every secret-looking string
 * below is fake, and no network call is made.
 *
 *   npx tsx ops/setup-check.ts
 *
 * Prints PASS or FAIL per line; exit code is 1 if any line is FAIL.
 *
 * Covered:
 *   1. creates .env from .env.example
 *   2. sets MOCK_MODE=1 by default, and not with --live
 *   3. fills an empty / template COMPANY_AUTH_TOKEN with 64 hex chars (32 bytes)
 *   4. never prints the token or any .env value
 *   5. refuses to overwrite an existing .env
 *   6. --force writes .env.bak first (exact copy) and then regenerates .env
 *   7. creates company/ and logs/
 *   8. running twice is safe (no change, exit 0, no .env.bak)
 *   9. the real CLI `npx tsx ops/setup.ts --dir <temp>` does the same end to end
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { envValue, main, parseArgs, runSetup, TOKEN_BYTES } from "./setup.js";

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HARNESS_DIR, "..");

// Fake, secret-looking values. Nothing here is a real credential.
const FAKE_DECLARED_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const FAKE_DECLARED_SECRET = "setup_check_declared_secret_77c1";
const SENTINEL_ENV = [
  "# fake pre-existing .env written by setup-check (temp folder only)",
  "DT_ALPHA=setup_check_sentinel_alpha",
  `COMPANY_AUTH_TOKEN=${FAKE_DECLARED_TOKEN}`,
  "PORT=8787",
  "",
].join("\n");

const EXAMPLE_WITH_KEYS = [
  "# fake .env.example for setup-check (all values are fake)",
  "DT_ALPHA=setup_check_alpha_1122",
  `DT_SECRET=${FAKE_DECLARED_SECRET}`,
  "SOME_EMPTY=",
  "MOCK_MODE=0",
  "COMPANY_AUTH_TOKEN=changeme",
  "PORT=8787",
  "",
].join("\n");

/** No MOCK_MODE and an empty token: the wizard has to append one and fill the other. */
const EXAMPLE_PLAIN = ["# fake .env.example (plain)", "DT_BETA=1", "COMPANY_AUTH_TOKEN=", ""].join("\n");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? `  -> ${detail}` : ""}`);
}

const tempDirs: string[] = [];
function mkroot(tag: string, files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `setup-check-${tag}-`));
  tempDirs.push(dir);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text, "utf8");
  return dir;
}

function readEnv(dir: string): string {
  return fs.readFileSync(path.join(dir, ".env"), "utf8");
}

/** Run the real CLI entry point in-process and capture everything it prints. */
function runCli(argv: string[]): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv, { log: (line) => out.push(line), error: (line) => err.push(line) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function countKeyLines(text: string, key: string): number {
  return text.split(/\r?\n/).filter((line) => !line.trimStart().startsWith("#") && line.trimStart().startsWith(`${key}=`)).length;
}

async function runChecks(): Promise<void> {
  // ---- 1 + 2 + 3 + 4: a fresh folder gets a complete, safe .env -----------------
  const freshDir = mkroot("fresh", { ".env.example": EXAMPLE_WITH_KEYS });
  const fresh = runCli(["--dir", freshDir]);
  const envPath = path.join(freshDir, ".env");
  check(
    "creates .env from .env.example (exit 0, names are reported)",
    fresh.code === 0 && fs.existsSync(envPath) && fresh.out.includes("created .env from .env.example") && fresh.out.includes("COMPANY_AUTH_TOKEN"),
    `exit=${fresh.code}; envExists=${fs.existsSync(envPath)}`,
  );

  const freshText = readEnv(freshDir);
  check(
    "sets MOCK_MODE=1 by default (replaced in place, no duplicate key)",
    envValue(freshText, "MOCK_MODE") === "1" && countKeyLines(freshText, "MOCK_MODE") === 1,
    `MOCK_MODE=${envValue(freshText, "MOCK_MODE")}; keyLines=${countKeyLines(freshText, "MOCK_MODE")}`,
  );
  check(
    "keeps the rest of the template and adds nothing else",
    envValue(freshText, "DT_ALPHA") === "setup_check_alpha_1122" && envValue(freshText, "PORT") === "8787" && envValue(freshText, "SOME_EMPTY") === "",
    `DT_ALPHA=${envValue(freshText, "DT_ALPHA")}; PORT=${envValue(freshText, "PORT")}`,
  );

  const token = envValue(freshText, "COMPANY_AUTH_TOKEN") ?? "";
  check(
    `fills a template COMPANY_AUTH_TOKEN with a random ${TOKEN_BYTES}-byte hex value`,
    /^[0-9a-f]{64}$/.test(token) && token !== "changeme" && token !== FAKE_DECLARED_TOKEN,
    `length=${token.length}; hex=${/^[0-9a-f]{64}$/.test(token)}; wasTemplate=${token === "changeme"}`,
  );
  const printed = `${fresh.out}\n${fresh.err}`;
  check(
    "never prints the generated token or any .env value",
    !printed.includes(token) &&
      !printed.includes(FAKE_DECLARED_SECRET) &&
      !printed.includes(FAKE_DECLARED_TOKEN) &&
      fresh.out.includes("value not shown"),
    `tokenLeaked=${printed.includes(token)}; declaredSecretLeaked=${printed.includes(FAKE_DECLARED_SECRET)}`,
  );
  check(
    "prints the next steps (doctor, server, dashboard URL)",
    /npx tsx ops\/doctor\.ts/.test(fresh.out) && /npm run dev/.test(fresh.out) && /http:\/\/127\.0\.0\.1:8787\//.test(fresh.out),
    `nextSteps=${/next steps:/.test(fresh.out)}`,
  );

  // ---- 2 (cont.) + 3 (cont.): --live uses real providers and fills an empty token --
  const liveDir = mkroot("live", { ".env.example": EXAMPLE_PLAIN });
  const live = runCli(["--dir", liveDir, "--live"]);
  const liveText = readEnv(liveDir);
  const liveToken = envValue(liveText, "COMPANY_AUTH_TOKEN") ?? "";
  check(
    "--live sets MOCK_MODE=0 (not 1) and appends the key when the template lacks it",
    live.code === 0 && envValue(liveText, "MOCK_MODE") === "0" && countKeyLines(liveText, "MOCK_MODE") === 1,
    `exit=${live.code}; MOCK_MODE=${envValue(liveText, "MOCK_MODE")}; keyLines=${countKeyLines(liveText, "MOCK_MODE")}`,
  );
  check(
    "--live also fills the empty token with 64 hex chars and prints no value",
    /^[0-9a-f]{64}$/.test(liveToken) && !`${live.out}\n${live.err}`.includes(liveToken),
    `length=${liveToken.length}; hex=${/^[0-9a-f]{64}$/.test(liveToken)}`,
  );

  // ---- a template value that is already real-looking must be left alone ----------
  const keepExample = ["# fake", "COMPANY_AUTH_TOKEN=" + FAKE_DECLARED_TOKEN, "MOCK_MODE=0", ""].join("\n");
  const keepDir = mkroot("keep", { ".env.example": keepExample });
  const keep = runCli(["--dir", keepDir]);
  check(
    "a non-template COMPANY_AUTH_TOKEN in the template is left as is",
    keep.code === 0 && envValue(readEnv(keepDir), "COMPANY_AUTH_TOKEN") === FAKE_DECLARED_TOKEN && keep.out.includes("left as is"),
    `preserved=${envValue(readEnv(keepDir), "COMPANY_AUTH_TOKEN") === FAKE_DECLARED_TOKEN}`,
  );

  // ---- 5: refuse to overwrite an existing .env ---------------------------------
  const refuseDir = mkroot("refuse", { ".env.example": EXAMPLE_WITH_KEYS, ".env": SENTINEL_ENV });
  const before = readEnv(refuseDir);
  const refuse = runCli(["--dir", refuseDir]);
  const after = readEnv(refuseDir);
  const refused = runSetup({ dir: refuseDir, live: false, force: false });
  check(
    "refuses to overwrite an existing .env (content byte-identical)",
    refuse.code === 0 && after === before && refused.refused === true && /--force/.test(refuse.out) && !fs.existsSync(path.join(refuseDir, ".env.bak")),
    `exit=${refuse.code}; unchanged=${after === before}; refused=${refused.refused}; bak=${fs.existsSync(path.join(refuseDir, ".env.bak"))}`,
  );

  // ---- 6: --force backs up first, then regenerates ------------------------------
  const forceDir = mkroot("force", { ".env.example": EXAMPLE_WITH_KEYS, ".env": SENTINEL_ENV });
  const force = runCli(["--dir", forceDir, "--force"]);
  const bakPath = path.join(forceDir, ".env.bak");
  const forcedText = readEnv(forceDir);
  const forcedToken = envValue(forcedText, "COMPANY_AUTH_TOKEN") ?? "";
  check(
    "--force writes .env.bak as an exact copy of the old file, then regenerates .env",
    force.code === 0 && fs.existsSync(bakPath) && fs.readFileSync(bakPath, "utf8") === SENTINEL_ENV &&
      forcedText !== SENTINEL_ENV && /^[0-9a-f]{64}$/.test(forcedToken) && forcedToken !== FAKE_DECLARED_TOKEN,
    `exit=${force.code}; bakIsCopy=${fs.existsSync(bakPath) && fs.readFileSync(bakPath, "utf8") === SENTINEL_ENV}; freshToken=${/^[0-9a-f]{64}$/.test(forcedToken)}`,
  );

  // ---- 7: the two folders ------------------------------------------------------
  check(
    "creates company/ and logs/ when missing",
    isDir(path.join(freshDir, "company")) && isDir(path.join(freshDir, "logs")) && isDir(path.join(liveDir, "company")) && isDir(path.join(liveDir, "logs")),
    `fresh: company=${isDir(path.join(freshDir, "company"))} logs=${isDir(path.join(freshDir, "logs"))}`,
  );

  // ---- 8: running twice is safe ------------------------------------------------
  const firstRunText = readEnv(freshDir);
  const twice = runCli(["--dir", freshDir]);
  const secondRunText = readEnv(freshDir);
  check(
    "running twice is safe (exit 0, .env unchanged, no .env.bak created)",
    twice.code === 0 && secondRunText === firstRunText && !fs.existsSync(path.join(freshDir, ".env.bak")) && twice.out.includes("already exists"),
    `exit=${twice.code}; unchanged=${secondRunText === firstRunText}; bak=${fs.existsSync(path.join(freshDir, ".env.bak"))}`,
  );

  // ---- template/CRLF + argv hygiene -------------------------------------------
  const crlfDir = mkroot("crlf", { ".env.example": ["# fake", "MOCK_MODE=0", "COMPANY_AUTH_TOKEN=", ""].join("\r\n") });
  const crlf = runCli(["--dir", crlfDir]);
  const crlfText = readEnv(crlfDir);
  check(
    "keeps the template's CRLF line endings when it edits a key",
    crlf.code === 0 && crlfText.includes("\r\n") && envValue(crlfText, "MOCK_MODE") === "1",
    `crlf=${crlfText.includes("\r\n")}; MOCK_MODE=${envValue(crlfText, "MOCK_MODE")}`,
  );
  check(
    "an unknown flag is an error (usage, exit 1), not a guess",
    runCli(["--nope"]).code === 1 && /usage:/.test(runCli(["--nope"]).err) && "error" in parseArgs(["--dir"]),
    `exit=${runCli(["--nope"]).code}`,
  );

  // ---- 9: the real CLI, end to end -------------------------------------------
  const cliDir = mkroot("cli", { ".env.example": EXAMPLE_WITH_KEYS });
  const cmd = `npx tsx ops/setup.ts --dir ${JSON.stringify(cliDir)}`;
  const cli = spawnSync(cmd, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    shell: true,
    timeout: 240000,
    windowsHide: true,
  });
  const cliOut = `${cli.stdout ?? ""}${cli.stderr ?? ""}`;
  let cliToken = "";
  try {
    cliToken = envValue(fs.readFileSync(path.join(cliDir, ".env"), "utf8"), "COMPANY_AUTH_TOKEN") ?? "";
  } catch {
    /* no .env: the checks below will say so */
  }
  check(
    "real CLI `npx tsx ops/setup.ts --dir <temp>` creates a safe .env and exits 0",
    cli.status === 0 && fs.existsSync(path.join(cliDir, ".env")) && envValue(readEnv(cliDir), "MOCK_MODE") === "1" && /^[0-9a-f]{64}$/.test(cliToken),
    `exit=${cli.status}; tokenLength=${cliToken.length}; MOCK_MODE=${fs.existsSync(path.join(cliDir, ".env")) ? envValue(readEnv(cliDir), "MOCK_MODE") : "n/a"}`,
  );
  check(
    "real CLI output leaks no value and mentions the next steps",
    !cliOut.includes(cliToken) && !cliOut.includes(FAKE_DECLARED_SECRET) && /npx tsx ops\/doctor\.ts/.test(cliOut) && /http:\/\/127\.0\.0\.1:8787\//.test(cliOut),
    `tokenLeaked=${cliOut.includes(cliToken)}; nextSteps=${/next steps:/.test(cliOut)}`,
  );
}

try {
  await runChecks();
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

console.log(failures === 0 ? "setup-check: all checks passed" : `setup-check: ${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
