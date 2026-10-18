#!/usr/bin/env node
/**
 * ops/secret-scan.ts - find secret-looking strings before they are committed.
 *
 *   npx tsx ops/secret-scan.ts --staged           # files staged for the next commit
 *   npx tsx ops/secret-scan.ts --all              # every file under the root
 *   npx tsx ops/secret-scan.ts src/server.ts      # explicit files or folders
 *   npx tsx ops/secret-scan.ts --staged --json    # one JSON object instead of lines
 *
 * A hit prints the file, the line number, the rule name and a MASK of the
 * value: its first four characters, never the whole value. The process exits 1
 * when anything is found and 0 when the tree is clean (2 for a usage error).
 * Binary files, node_modules/ and .git/ are skipped. A `.secretscan-allow` file
 * at the root holds one path glob or value regex per line to ignore, with `#`
 * comments. Node built-ins only, no network calls.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Finding {
  file: string;
  line: number;
  rule: string;
  /** First four characters of the matched value. The full value is never kept. */
  masked: string;
}

export interface ScanResult {
  findings: Finding[];
  /** How many files were read (binary files are skipped, not counted). */
  scanned: number;
  /** Files that were skipped because they looked binary. */
  skipped: string[];
}

export interface ScanOptions {
  /** Project root. Paths are reported relative to it. Default: process.cwd(). */
  root?: string;
  /** `--staged` (git index), `--all` (walk), or `paths`. Default: "all". */
  mode?: "staged" | "all" | "paths";
  paths?: string[];
  json?: boolean;
}

export const ALLOW_FILE = ".secretscan-allow";
/** Directories never walked. Git runs hooks from the repo root, so this is enough. */
export const SKIP_DIRS = new Set(["node_modules", ".git"]);

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface Rule {
  name: string;
  pattern: RegExp;
  /** Assignment rules capture the value in group 1 and skip `*.example` files. */
  assignment?: boolean;
}

export const RULES: Rule[] = [
  { name: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "slack-token", pattern: /\bx(?:ox[abprs]|app)-[A-Za-z0-9-]{10,}\b/ },
  { name: "github-token", pattern: /\b(?:ghp|gho|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b/ },
  { name: "aws-access-key-id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { name: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    name: "assignment",
    assignment: true,
    pattern:
      /(?<![A-Za-z0-9])(?:KEY|TOKEN|SECRET|PASSWORD)\s*[:=]\s*["'`]?([A-Za-z0-9_\-+/=.]{16,})/,
  },
];

export interface AllowEntry {
  raw: string;
  /** The entry treated as a path glob, anchored at the root. */
  glob: RegExp;
  /** The entry treated as a regex against the matched value, when it compiles. */
  value: RegExp | null;
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Turn a path glob (`*`, `?`) into an anchored regex. A leading `/` is ignored. */
export function globToRegExp(glob: string): RegExp {
  const clean = glob.startsWith("/") ? glob.slice(1) : glob;
  const escaped = clean
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/** Parse the allow file: one path glob or value regex per line, `#` comments. */
export function parseAllow(text: string): AllowEntry[] {
  const entries: AllowEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw || raw.startsWith("#")) continue;
    let value: RegExp | null = null;
    try {
      value = new RegExp(raw);
    } catch {
      value = null;
    }
    entries.push({ raw, glob: globToRegExp(raw), value });
  }
  return entries;
}

export function loadAllow(root: string): AllowEntry[] {
  const file = path.join(root, ALLOW_FILE);
  try {
    return parseAllow(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

function allowed(allow: AllowEntry[], relFile: string, value: string): boolean {
  return allow.some((entry) => {
    if (entry.glob.test(relFile)) return true;
    return entry.value !== null && entry.value.test(value);
  });
}

/** False for captured "values" that are code, not credentials. */
function plausible(value: string): boolean {
  if (value.includes("process.env")) return false;
  if (value.startsWith("$") || value.startsWith("`")) return false;
  return true;
}

export function mask(value: string): string {
  return value.slice(0, 4);
}

/** Scan one file's text. `relFile` is only used for reporting and allow-list globs. */
export function scanContent(relFile: string, content: string, allow: AllowEntry[] = []): Finding[] {
  const findings: Finding[] = [];
  const isExample = /\.example$/i.test(path.basename(relFile));
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of RULES) {
      if (rule.assignment && isExample) continue;
      const flags = rule.pattern.flags.includes("g") ? rule.pattern.flags : rule.pattern.flags + "g";
      const re = new RegExp(rule.pattern.source, flags);
      let match: RegExpExecArray | null;
      while ((match = re.exec(line)) !== null) {
        const value = match[1] ?? match[0];
        const hit = plausible(value) && !allowed(allow, relFile, value);
        if (hit) {
          findings.push({ file: toPosix(relFile), line: i + 1, rule: rule.name, masked: mask(value) });
        }
        if (match.index === re.lastIndex) re.lastIndex++;
      }
    }
  }
  return findings;
}

/** NUL byte in the first block is the usual "this is binary" signal. */
function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

/** Files staged for the next commit, relative to `root` and forward-slashed. */
export function listStaged(root: string): string[] {
  const inside = spawnSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
  });
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    throw new Error(`not a git repository: ${root}`);
  }
  const r = spawnSync(
    "git",
    ["-C", root, "diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    throw new Error(`git diff --cached failed: ${(r.stderr || r.error?.message || "").trim()}`);
  }
  return r.stdout.split("\0").filter(Boolean).map(toPosix);
}

/** Content of a staged blob (`git show :path`), or null when it cannot be read. */
export function readStaged(root: string, rel: string): Buffer | null {
  const r = spawnSync("git", ["-C", root, "show", `:${rel}`], { maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout;
}

/** Every file under `root`, relative and forward-slashed, sorted. */
export function listAllFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(abs);
      } else if (entry.isFile()) {
        if (entry.name === ALLOW_FILE) continue;
        out.push(toPosix(path.relative(root, abs)));
      }
    }
  };
  visit(root);
  return out.sort();
}

/** Expand CLI path arguments into files. Directories are walked. */
export function expandPaths(root: string, inputs: string[]): string[] {
  const out = new Set<string>();
  for (const input of inputs) {
    const abs = path.resolve(root, input);
    // A path that goes through node_modules/ or .git/ is skipped even when named.
    if (path.relative(root, abs).split(path.sep).some((part) => SKIP_DIRS.has(part))) continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      for (const rel of listAllFiles(abs)) {
        out.add(toPosix(path.relative(root, path.join(abs, rel))));
      }
    } else if (stat.isFile()) {
      out.add(toPosix(path.relative(root, abs)));
    }
  }
  return [...out].sort();
}

function scanContents(
  pairs: Array<{ file: string; content: string | null }>,
  allow: AllowEntry[],
): ScanResult {
  const result: ScanResult = { findings: [], scanned: 0, skipped: [] };
  for (const pair of pairs) {
    if (pair.content === null) {
      result.skipped.push(pair.file);
      continue;
    }
    result.scanned++;
    result.findings.push(...scanContent(pair.file, pair.content, allow));
  }
  result.findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return result;
}

/** Scan files on disk. */
export function scanPaths(root: string, files: string[], allow: AllowEntry[] = []): ScanResult {
  return scanContents(
    files.map((file) => {
      try {
        const buf = fs.readFileSync(path.join(root, file));
        return { file, content: looksBinary(buf) ? null : buf.toString("utf8") };
      } catch {
        return { file, content: null };
      }
    }),
    allow,
  );
}

/** Scan the git index (what the next commit would contain), not the worktree. */
export function scanStaged(root: string, allow: AllowEntry[] = []): ScanResult {
  return scanContents(
    listStaged(root).map((file) => {
      const buf = readStaged(root, file);
      return { file, content: !buf || looksBinary(buf) ? null : buf.toString("utf8") };
    }),
    allow,
  );
}

export function renderText(result: ScanResult): string {
  return result.findings
    .map((f) => `${f.file}:${f.line}: ${f.rule} mask=${f.masked}`)
    .join("\n");
}

export function renderJson(result: ScanResult): string {
  return JSON.stringify(
    { findings: result.findings, ok: result.findings.length === 0 },
    null,
    2,
  );
}

export function exitCodeFor(result: ScanResult): number {
  return result.findings.length > 0 ? 1 : 0;
}

export function parseArgs(argv: string[]): ScanOptions & { help?: boolean } {
  const opts: ScanOptions & { help?: boolean } = { mode: "all", paths: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--staged") opts.mode = "staged";
    else if (arg === "--all") opts.mode = "all";
    else if (arg === "--json") opts.json = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--root") opts.root = argv[++i];
    else if (!arg.startsWith("-")) {
      opts.mode = "paths";
      (opts.paths as string[]).push(arg);
    }
  }
  return opts;
}

export const USAGE = [
  "usage: npx tsx ops/secret-scan.ts [--staged | --all | <paths>] [--json] [--root <dir>]",
].join("\n");

export function main(argv: string[] = process.argv.slice(2)): number {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  const root = path.resolve(opts.root ?? process.cwd());
  const allow = loadAllow(root);
  let result: ScanResult;
  try {
    if (opts.mode === "staged") result = scanStaged(root, allow);
    else if (opts.mode === "paths") result = scanPaths(root, expandPaths(root, opts.paths ?? []), allow);
    else result = scanPaths(root, listAllFiles(root), allow);
  } catch (err) {
    console.error(`secret-scan: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  if (opts.json) {
    console.log(renderJson(result));
  } else {
    const text = renderText(result);
    if (text) console.log(text);
    console.error(
      result.findings.length === 0
        ? `secret-scan: clean (${result.scanned} file(s) scanned)`
        : `secret-scan: ${result.findings.length} finding(s) in ${new Set(result.findings.map((f) => f.file)).size} file(s)`,
    );
  }
  return exitCodeFor(result);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (invokedDirectly) process.exit(main());
