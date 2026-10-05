#!/usr/bin/env node
/**
 * ops/install-hooks.ts - install the secret-scan git hooks.
 *
 *   npx tsx ops/install-hooks.ts            # write .git/hooks/pre-commit and pre-push
 *   npx tsx ops/install-hooks.ts --uninstall  # remove only hooks this tool wrote
 *   npx tsx ops/install-hooks.ts --force      # replace even a foreign hook
 *   npx tsx ops/install-hooks.ts --root <dir> # repo to edit (default: cwd)
 *
 * Every hook written here starts with the marker line `# jcode-secret-scan-hook:v1`.
 * An existing hook without that marker is left alone unless `--force` is given,
 * so a team member's own hook is never clobbered by accident. `--uninstall`
 * deletes a hook only when the marker is present. The scripts are POSIX `sh`,
 * which Git for Windows runs through its bundled shell.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOOK_MARKER = "# jcode-secret-scan-hook:v1";
export const HOOKS = ["pre-commit", "pre-push"] as const;
export type HookName = (typeof HOOKS)[number];

export type HookStatus =
  | "installed"
  | "unchanged"
  | "updated"
  | "skipped-foreign"
  | "removed"
  | "absent";

export interface HookOutcome {
  hook: HookName;
  path: string;
  status: HookStatus;
}

/** The exact text written to every hook. `sh` syntax only, no bashisms. */
export function hookScript(_hook: HookName): string {
  return [
    "#!/bin/sh",
    HOOK_MARKER,
    "# Blocks a commit or push that contains secret-looking strings.",
    "# Bypass once with: git commit --no-verify",
    'if ! command -v npx >/dev/null 2>&1; then',
    '  echo "secret-scan: npx not found, skipping" >&2',
    "  exit 0",
    "fi",
    "if ! npx tsx ops/secret-scan.ts --staged; then",
    '  echo "secret-scan: blocked; add a .secretscan-allow entry or use --no-verify" >&2',
    "  exit 1",
    "fi",
    "exit 0",
    "",
  ].join("\n");
}

/** Resolve the git directory for `start`, or null when it is not a repo. */
export function findGitDir(start: string): string | null {
  const r = spawnSync("git", ["-C", start, "rev-parse", "--git-dir"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const dir = r.stdout.trim();
  return dir ? path.resolve(start, dir) : null;
}

function hookPath(gitDir: string, hook: HookName): string {
  return path.join(gitDir, "hooks", hook);
}

function writeHook(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { encoding: "utf8", mode: 0o755 });
  try {
    fs.chmodSync(file, 0o755);
  } catch {
    // Windows without an exec bit; Git for Windows runs hooks through sh anyway.
  }
}

export function installHooks(
  gitDir: string,
  opts: { force?: boolean } = {},
): HookOutcome[] {
  return HOOKS.map((hook) => {
    const file = hookPath(gitDir, hook);
    const script = hookScript(hook);
    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file, "utf8");
      if (!existing.includes(HOOK_MARKER)) {
        if (!opts.force) return { hook, path: file, status: "skipped-foreign" as const };
        writeHook(file, script);
        return { hook, path: file, status: "updated" as const };
      }
      if (existing === script) return { hook, path: file, status: "unchanged" as const };
      writeHook(file, script);
      return { hook, path: file, status: "updated" as const };
    }
    writeHook(file, script);
    return { hook, path: file, status: "installed" as const };
  });
}

export function uninstallHooks(gitDir: string): HookOutcome[] {
  return HOOKS.map((hook) => {
    const file = hookPath(gitDir, hook);
    if (!fs.existsSync(file)) return { hook, path: file, status: "absent" as const };
    const existing = fs.readFileSync(file, "utf8");
    if (!existing.includes(HOOK_MARKER)) {
      return { hook, path: file, status: "skipped-foreign" as const };
    }
    fs.unlinkSync(file);
    return { hook, path: file, status: "removed" as const };
  });
}

export const USAGE = [
  "usage: npx tsx ops/install-hooks.ts [--uninstall] [--force] [--root <dir>]",
].join("\n");

export function main(argv: string[] = process.argv.slice(2)): number {
  let uninstall = false;
  let force = false;
  let root: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--uninstall") uninstall = true;
    else if (arg === "--force") force = true;
    else if (arg === "--root") root = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      return 0;
    }
  }
  const start = path.resolve(root ?? process.cwd());
  const gitDir = findGitDir(start);
  if (!gitDir) {
    console.error(`install-hooks: ${start} is not inside a git repository`);
    return 2;
  }
  const outcomes = uninstall ? uninstallHooks(gitDir) : installHooks(gitDir, { force });
  for (const o of outcomes) {
    console.log(`${o.status}: ${path.relative(start, o.path) || o.path}`);
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (invokedDirectly) process.exit(main());
