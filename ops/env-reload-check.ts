/**
 * ops/env-reload-check.ts - proof for order F2-ENVRELOAD (2026-10-06).
 *
 * Checks the REAL src/company/envReload.ts against a TEMPORARY .env file in the OS temp
 * directory. The repository's own .env is never opened, read or written: every call passes
 * an explicit path. No network calls are made.
 *
 * process.env is snapshotted first (a plain copy) and restored in a finally block, so the
 * process that runs this harness ends with exactly the environment it started with.
 *
 *   npx tsx ops/env-reload-check.ts
 *
 * Prints PASS or FAIL per line; exit code is 1 if any line is FAIL.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reloadEnv, RELOADABLE_ENV_KEYS } from "../src/company/envReload.js";

// Fake, secret-looking values. Nothing here is a real credential.
const NEW_TOKEN = "ghp_ENVRELOAD_SECRET_0123456789";
const OLD_TOKEN = "ghp_ENVRELOAD_OLD_9876543210";
const BASE_URL = "https://example.test/base";
const OTHER_SECRET = "other_secret_value_abcdef";
const AUTH_SECRET = "company_secret_value_abcdef";
const APIKEY_SECRET = "opencode_secret_value_abcdef";

const FIXTURE = [
  "# env-reload-check fixture - a TEMPORARY file, never the repository .env",
  "# every value below is fake",
  "",
  `GITHUB_TOKEN="${NEW_TOKEN}"`,
  "",
  "FLEET_GITHUB_DRY_RUN='1'",
  `FLEET_GITHUB_BASE="${BASE_URL}"`,
  "FLEET_MAX_SESSIONS=7",
  '   DEEPSEEK_DIRECT = "1"',
  "",
  `SOME_OTHER_KEY="${OTHER_SECRET}"`,
  `COMPANY_AUTH_TOKEN=${AUTH_SECRET}`,
  `OPENCODE_API_KEY="${APIKEY_SECRET}"`,
  "",
].join("\n");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? `  -> ${detail}` : ""}`);
}

/** Set every key of `before` and drop everything that is not in it. */
function restoreEnv(before: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
  for (const [key, value] of Object.entries(before)) process.env[key] = value;
}

const envBefore: NodeJS.ProcessEnv = { ...process.env };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-reload-check-"));
const fixtureFile = path.join(dir, ".env");

try {
  fs.writeFileSync(fixtureFile, FIXTURE, "utf8");

  // Known starting state. Two allow-listed keys match the file (must be "unchanged"),
  // three differ or are absent (must be "changed"), one allow-listed key is missing from
  // the file (must be "skipped" and must keep its current value).
  process.env.GITHUB_TOKEN = OLD_TOKEN;
  process.env.FLEET_GITHUB_DRY_RUN = "0";
  delete process.env.FLEET_GITHUB_BASE;
  process.env.FLEET_MAX_SESSIONS = "7";
  process.env.DEEPSEEK_DIRECT = "1";
  process.env.MIN_FREE_RAM_MB = "4096";
  delete process.env.SOME_OTHER_KEY;
  delete process.env.COMPANY_AUTH_TOKEN;
  delete process.env.OPENCODE_API_KEY;

  const first = reloadEnv(fixtureFile);

  // 1. A changed allow-listed key is reported and really copied (GITHUB_TOKEN is quoted in
  //    the fixture, so this also proves the quotes came off).
  check(
    "changed allow-listed key is listed and process.env has the new value",
    first.changed.includes("GITHUB_TOKEN") && process.env.GITHUB_TOKEN === NEW_TOKEN,
    `changed=${JSON.stringify(first.changed)}; token matches=${process.env.GITHUB_TOKEN === NEW_TOKEN}`,
  );

  // 2. Keys off the allow-list are never copied, even though they are in the file.
  const leaked = ["SOME_OTHER_KEY", "COMPANY_AUTH_TOKEN", "OPENCODE_API_KEY"].filter(
    (k) => k in process.env || first.changed.includes(k),
  );
  check(
    "non-allow-listed keys (SOME_OTHER_KEY, COMPANY_AUTH_TOKEN, OPENCODE_API_KEY) are not copied",
    leaked.length === 0 && !RELOADABLE_ENV_KEYS.includes("COMPANY_AUTH_TOKEN" as never),
    leaked.length ? `leaked=${JSON.stringify(leaked)}` : "none present in process.env",
  );

  // 3. The result carries key names only, so no secret-looking value can appear in it.
  const json = JSON.stringify(first);
  const found = [NEW_TOKEN, OLD_TOKEN, BASE_URL, OTHER_SECRET, AUTH_SECRET, APIKEY_SECRET].filter((v) => json.includes(v));
  check(
    "returned object contains no value",
    found.length === 0 && JSON.stringify(Object.keys(first).sort()) === JSON.stringify(["changed", "skipped", "unchanged"]),
    found.length ? `result text contains a test value` : `result keys=${JSON.stringify(Object.keys(first))}`,
  );

  // 4. Comments and blank lines are ignored; single and double quotes are stripped; the
  //    whitespace-padded "   DEEPSEEK_DIRECT = "1"" line parses. The exact "changed" set is
  //    the strongest check that no comment line became a key.
  const expectedChanged = JSON.stringify(["FLEET_GITHUB_BASE", "FLEET_GITHUB_DRY_RUN", "GITHUB_TOKEN"]);
  check(
    "comments, blank lines, whitespace and quoted values parse correctly",
    JSON.stringify([...first.changed].sort()) === expectedChanged &&
      process.env.FLEET_GITHUB_DRY_RUN === "1" &&
      process.env.FLEET_GITHUB_BASE === BASE_URL &&
      process.env.DEEPSEEK_DIRECT === "1",
    `changed=${JSON.stringify([...first.changed].sort())}; quoted values match=${process.env.FLEET_GITHUB_DRY_RUN === "1" && process.env.FLEET_GITHUB_BASE === BASE_URL}`,
  );

  // 5. An allow-listed key absent from the file is skipped and leaves process.env alone.
  check(
    "allow-listed key missing from the file is skipped and unchanged",
    first.skipped.includes("MIN_FREE_RAM_MB") &&
      process.env.MIN_FREE_RAM_MB === "4096" &&
      first.skipped.length === RELOADABLE_ENV_KEYS.length - 5 &&
      !first.skipped.includes("GITHUB_TOKEN"),
    `skipped=${JSON.stringify(first.skipped)}`,
  );

  // 6. Idempotent: a second call in a row changes nothing.
  const second = reloadEnv(fixtureFile);
  check(
    "second call in a row returns an empty changed",
    second.changed.length === 0 && second.unchanged === 5 && second.skipped.length === first.skipped.length,
    `changed=${JSON.stringify(second.changed)}; unchanged=${second.unchanged}; skipped=${second.skipped.length}`,
  );
} catch (e) {
  check("harness completed without throwing", false, String(e instanceof Error ? e.message : e));
} finally {
  restoreEnv(envBefore);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort: the temp dir is outside the repo */
  }
}

console.log(failures === 0 ? "env-reload-check: all checks passed" : `env-reload-check: ${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
