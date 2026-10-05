#!/usr/bin/env node
/**
 * ops/setup.ts - first-run wizard that creates a safe .env.
 *
 *   npx tsx ops/setup.ts                 # project root, mock mode: a first run costs nothing
 *   npx tsx ops/setup.ts --live          # real providers: MOCK_MODE=0, fill the keys in first
 *   npx tsx ops/setup.ts --dir <path>    # run against another folder (the proof uses temp folders)
 *   npx tsx ops/setup.ts --force         # replace an existing .env (the old one is copied to .env.bak)
 *
 * What it does, in order:
 *   1. if .env is missing, copy .env.example to .env
 *   2. set MOCK_MODE=1 by default (0 with --live) so a first run does not spend anything
 *   3. if COMPANY_AUTH_TOKEN is empty or still a template value, fill it with 32 random
 *      bytes from node:crypto as hex (64 chars)
 *   4. create company/ and logs/ when they are missing
 *
 * It NEVER overwrites an existing .env without --force, and NEVER prints a value from .env
 * or the generated token - only key NAMES and what it did. All file work happens under
 * `dir`, so ops/setup-check.ts can run it in a temporary folder. No network calls.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_PORT = 8787;
export const DIRS_TO_CREATE = ["company", "logs"] as const;
/** 32 random bytes rendered as hex: this is what `crypto.randomBytes(32).toString("hex")` gives. */
export const TOKEN_BYTES = 32;

/** Values in .env.example that are placeholders, not real settings. Compared lower-cased. */
const TEMPLATE_VALUES = new Set([
  "changeme",
  "change-me",
  "change_me",
  "replace_me",
  "replace-me",
  "replaceme",
  "your_token_here",
  "your-token-here",
  "yourtokenhere",
  "your_token",
  "your-token",
  "todo",
  "tbd",
  "xxx",
  "xxxx",
  "placeholder",
  "example",
  "secret",
  "token",
  "paste_here",
  "paste-here",
  "insert_here",
  "fill_me_in",
]);

/** True for an empty value, `<something>`, `{{ something }}` or a known placeholder word. */
export function isTemplateValue(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  const trimmed = value.trim();
  if (trimmed === "") return true;
  if (/^<.*>$/.test(trimmed) || /^\{\{.*\}\}$/.test(trimmed)) return true;
  return TEMPLATE_VALUES.has(trimmed.toLowerCase());
}

/**
 * Value of `key` in dotenv-style text, or null when the key is absent (or commented out).
 * Quoted values are unquoted and a trailing ` # comment` is dropped. Never printed by callers.
 */
export function envValue(text: string, key: string): string | null {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    if (body.slice(0, eq).trim() !== key) continue;
    let value = body.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
    if (quoted) value = value.slice(1, -1);
    else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    return value;
  }
  return null;
}

/**
 * Set `key` to `value` in dotenv-style text: replace the first uncommented assignment,
 * otherwise append it (with `comment` above it when given). Existing EOL style is kept.
 */
export function setEnvVar(text: string, key: string, value: string, comment?: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trimStart();
    const body = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
    if (body.startsWith("#")) continue;
    const eq = body.indexOf("=");
    if (eq <= 0 || body.slice(0, eq).trim() !== key) continue;
    lines[i] = `${key}=${value}`;
    return lines.join(eol);
  }
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  if (comment) lines.push(comment);
  lines.push(`${key}=${value}`);
  lines.push("");
  return lines.join(eol);
}

/** Uncommented key names whose value is empty. Names only: values are never returned or printed. */
export function emptyKeyNames(text: string): string[] {
  const names: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const name = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    let value = body.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    if (value.trim() === "" && !names.includes(name)) names.push(name);
  }
  return names;
}

const MAX_NAMES_SHOWN = 8;

function nameList(names: string[]): string {
  const shown = names.slice(0, MAX_NAMES_SHOWN).join(", ");
  return names.length > MAX_NAMES_SHOWN ? `${shown} (+${names.length - MAX_NAMES_SHOWN} more)` : shown;
}

export interface SetupArgs {
  /** Folder that holds .env / .env.example and gets company/ and logs/. */
  dir: string;
  /** true = real providers (MOCK_MODE=0); false = safe mock first run (MOCK_MODE=1). */
  live: boolean;
  /** Replace an existing .env (a copy is written to .env.bak first). */
  force: boolean;
}

export interface SetupOutcome {
  code: number;
  dir: string;
  envPath: string;
  /** Secret-free, human-readable lines describing what was done. */
  actions: string[];
  nextSteps: string[];
  /** true when an existing .env was left untouched because --force was not given. */
  refused: boolean;
  /** true when .env was created or replaced in this run. */
  wroteEnv: boolean;
  envBakPath: string | null;
  error: string | null;
}

export const USAGE = [
  "usage: npx tsx ops/setup.ts [--dir <path>] [--live] [--force]",
  "  --dir <path>  folder to set up (default: the repo root)",
  "  --live        real providers: MOCK_MODE=0 (default is MOCK_MODE=1, a free first run)",
  "  --force       replace an existing .env (the old file is copied to .env.bak first)",
].join("\n");

/** Parse argv. Returns an error string for a bad/unknown flag instead of guessing. */
export function parseArgs(argv: string[]): SetupArgs | { error: string } {
  let dir = REPO_ROOT;
  let live = false;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--live") {
      live = true;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--dir") {
      const value = argv[++i];
      if (!value) return { error: "--dir needs a path" };
      dir = path.resolve(value);
    } else if (arg.startsWith("--dir=")) {
      const value = arg.slice("--dir=".length);
      if (!value) return { error: "--dir needs a path" };
      dir = path.resolve(value);
    } else {
      return { error: `unknown argument: ${arg}` };
    }
  }
  return { dir, live, force };
}

export interface SetupHooks {
  /** Injectable for tests: the token source. Real runs use node:crypto random bytes. */
  randomToken?: () => string;
}

/** Default token: 32 random bytes from node:crypto, hex, 64 characters. Never printed. */
export function newAuthToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString("hex");
}

function dashboardUrl(envText: string): string {
  const port = envValue(envText, "PORT") ?? "";
  return /^\d+$/.test(port) ? `http://127.0.0.1:${port}/` : `http://127.0.0.1:${DEFAULT_PORT}/`;
}

/**
 * Do the work against `args.dir`. Pure with respect to the process: it only touches the
 * filesystem under `dir` and returns secret-free lines for the caller to print.
 */
export function runSetup(args: SetupArgs, hooks: SetupHooks = {}): SetupOutcome {
  const dir = path.resolve(args.dir);
  const envPath = path.join(dir, ".env");
  const examplePath = path.join(dir, ".env.example");
  const actions: string[] = [];
  const nextSteps: string[] = [];
  const base: SetupOutcome = {
    code: 0,
    dir,
    envPath,
    actions,
    nextSteps,
    refused: false,
    wroteEnv: false,
    envBakPath: null,
    error: null,
  };

  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return { ...base, code: 1, error: `${dir} is not a folder` };
  }

  // Folders first: harmless and idempotent, so a second run is still safe.
  for (const name of DIRS_TO_CREATE) {
    const target = path.join(dir, name);
    if (fs.existsSync(target)) {
      actions.push(`${name}/ already exists`);
    } else {
      try {
        fs.mkdirSync(target, { recursive: true });
      } catch (e) {
        return { ...base, code: 1, error: `could not create ${target}: ${String(e instanceof Error ? e.message : e)}` };
      }
      actions.push(`created ${name}/`);
    }
  }

  const envExists = fs.existsSync(envPath);
  if (envExists && !args.force) {
    actions.push(".env already exists - left untouched (never overwritten without --force)");
    actions.push("to replace it anyway, re-run with --force: the old file is copied to .env.bak first");
    return { ...base, refused: true };
  }

  if (!fs.existsSync(examplePath)) {
    return {
      ...base,
      code: 1,
      error: `${examplePath} is missing, so there is no template to copy`,
    };
  }

  let template = "";
  try {
    template = fs.readFileSync(examplePath, "utf8");
  } catch (e) {
    return { ...base, code: 1, error: `could not read ${examplePath}: ${String(e instanceof Error ? e.message : e)}` };
  }

  let envBakPath: string | null = null;
  if (envExists) {
    envBakPath = path.join(dir, ".env.bak");
    try {
      fs.copyFileSync(envPath, envBakPath);
    } catch (e) {
      return { ...base, code: 1, error: `could not write .env.bak: ${String(e instanceof Error ? e.message : e)}` };
    }
    actions.push("copied the existing .env to .env.bak before replacing it");
  }

  let text = template;

  // 2. Mock mode by default: a first run must not call a provider or spend anything.
  const mockMode = args.live ? "0" : "1";
  const hadMock = envValue(text, "MOCK_MODE") !== null;
  text = setEnvVar(
    text,
    "MOCK_MODE",
    mockMode,
    args.live
      ? "# 0 = live providers (set by `ops/setup.ts --live`)."
      : "# 1 = mock mode: no provider calls, so a first run costs nothing (`ops/setup.ts` default).",
  );
  actions.push(
    args.live
      ? "set MOCK_MODE=0 (live run: fill the empty keys below before starting)"
      : `set MOCK_MODE=1 (safe first run: nothing is spent)${hadMock ? "" : " - key was not in the template"}`,
  );

  // 3. Company token: only filled when empty/placeholder, so a real token is never replaced.
  const tokenSet = envValue(text, "COMPANY_AUTH_TOKEN");
  if (isTemplateValue(tokenSet)) {
    const token = (hooks.randomToken ?? newAuthToken)();
    text = setEnvVar(text, "COMPANY_AUTH_TOKEN", token);
    actions.push(
      `filled COMPANY_AUTH_TOKEN with a fresh random ${TOKEN_BYTES}-byte hex value (${token.length} chars, value not shown)`,
    );
  } else {
    actions.push("COMPANY_AUTH_TOKEN already had a value - left as is");
  }

  try {
    fs.writeFileSync(envPath, text, "utf8");
  } catch (e) {
    return { ...base, code: 1, error: `could not write ${envPath}: ${String(e instanceof Error ? e.message : e)}` };
  }
  actions.push(envExists ? "wrote a fresh .env from .env.example" : "created .env from .env.example");
  actions.push(`.env path: ${envPath}`);

  if (args.live) {
    const empty = emptyKeyNames(text).filter((name) => name !== "MOCK_MODE");
    if (empty.length > 0) {
      actions.push(`still empty in .env, fill these in before a live run (names only): ${nameList(empty)}`);
    }
  }

  nextSteps.push("check the machine:   npx tsx ops/doctor.ts");
  nextSteps.push("start the server:    npm run dev");
  nextSteps.push(`open the dashboard:  ${dashboardUrl(text)}`);
  if (args.live) {
    nextSteps.push("live mode: keep the keys above out of git and never print them");
  }

  return { ...base, wroteEnv: true, envBakPath };
}

export interface SetupIo {
  log(line: string): void;
  error(line: string): void;
}

export function renderOutcome(outcome: SetupOutcome): string[] {
  if (outcome.error) {
    return [`setup: error - ${outcome.error}`, ...outcome.actions.map((a) => `  - ${a}`)];
  }
  const lines = [`setup: ${outcome.dir}`, ...outcome.actions.map((a) => `  - ${a}`)];
  if (outcome.nextSteps.length > 0) {
    lines.push("next steps:");
    for (const step of outcome.nextSteps) lines.push(`  ${step}`);
  }
  return lines;
}

export function main(argv: string[] = process.argv.slice(2), io: SetupIo = console): number {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    io.error(`setup: ${parsed.error}`);
    io.error(USAGE);
    return 1;
  }
  const outcome = runSetup(parsed);
  for (const line of renderOutcome(outcome)) {
    if (outcome.error) io.error(line);
    else io.log(line);
  }
  return outcome.code;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]).replace(/\.(ts|js)$/, "").toLowerCase() ===
    fileURLToPath(import.meta.url).replace(/\.(ts|js)$/, "").toLowerCase();

if (invokedDirectly) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(`setup: unexpected error - ${String(e instanceof Error ? e.message : e)}`);
    process.exitCode = 1;
  }
}
