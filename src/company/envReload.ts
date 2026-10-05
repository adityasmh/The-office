/**
 * ENV-RELOAD (order F2-ENVRELOAD, 2026-10-06): re-read a small allow-list of settings
 * from .env into this process without restarting the router.
 *
 * Why: the router loads .env once at boot (`import "dotenv/config"` in src/server.ts).
 * When one of those settings is replaced on disk (a rotated GITHUB_TOKEN, a flipped
 * FLEET_GITHUB_DRY_RUN) the running process keeps the OLD value until a restart, which
 * is how a replaced GitHub token kept answering `401 Bad credentials`.
 *
 * Two hard rules this module exists to honour:
 *   1. Only the keys in RELOADABLE_ENV_KEYS are ever copied. No other key is read into
 *      process.env - not another API key, not COMPANY_AUTH_TOKEN, not the Slack keys.
 *   2. No VALUE is ever returned or logged: the result carries key NAMES only.
 */

import fs from "node:fs";
import path from "node:path";

/** The only keys reloadEnv() may copy into process.env. Order is the report order. */
export const RELOADABLE_ENV_KEYS = [
  "GITHUB_TOKEN",
  "FLEET_GITHUB",
  "FLEET_GITHUB_REPO",
  "FLEET_GITHUB_DRY_RUN",
  "FLEET_GITHUB_BASE",
  "DEEPSEEK_DIRECT",
  "DEEPSEEK_DIRECT_ALL_HOURS",
  "DEEPSEEK_OFFPEAK_DIRECT",
  "GO_QUOTA_DEEPSEEK_BELOW_PCT",
  "FLEET_MAX_SESSIONS",
  "MAX_PARALLEL_SESSIONS",
  "MIN_FREE_RAM_MB",
  "FLEET_AUTO_APPROVE",
] as const;

export type ReloadEnvResult = {
  /** Allow-listed key NAMES whose value differs from process.env (never the values). */
  changed: string[];
  /** How many allow-listed keys were in the file with the value already in process.env. */
  unchanged: number;
  /** Allow-listed keys that were absent from the file. */
  skipped: string[];
};

/**
 * Parse simple `KEY=VALUE` lines. Comments (`#`) and blank lines are ignored, one pair
 * of surrounding single or double quotes is stripped, and the LAST duplicate wins.
 * Deliberately tiny: no interpolation, no `export` prefix, no variable expansion.
 */
function parseEnvText(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      if ((first === '"' || first === "'") && value[value.length - 1] === first) {
        value = value.slice(1, -1);
      }
    }
    out.set(key, value);
  }
  return out;
}

/**
 * Read `envPath` (default: <cwd>/.env) and copy ONLY the allow-listed keys whose value
 * differs into process.env. Throws if the file cannot be read: a silent no-op would hide
 * a typo in the path. Never returns or logs a value.
 */
export function reloadEnv(envPath?: string): ReloadEnvResult {
  const file = envPath ?? path.join(process.cwd(), ".env");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`reloadEnv: cannot read ${file}: ${String(e instanceof Error ? e.message : e)}`);
  }

  const parsed = parseEnvText(text);
  const changed: string[] = [];
  const skipped: string[] = [];
  let unchanged = 0;

  for (const key of RELOADABLE_ENV_KEYS) {
    if (!parsed.has(key)) {
      skipped.push(key);
      continue;
    }
    const next = parsed.get(key) as string;
    if (process.env[key] === next) {
      unchanged++;
      continue;
    }
    process.env[key] = next;
    changed.push(key);
  }

  return { changed, unchanged, skipped };
}
