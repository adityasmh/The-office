// github.ts - GH-1: the git/GitHub helper for the fleet PR flow.
//
// Safety-first, as the spec's "Safety rules" require:
//   * OFF by default: FLEET_GITHUB must be "1" for any real action.
//   * FLEET_GITHUB_DRY_RUN=1 (or the feature being off) turns every action into a
//     log line that says what WOULD happen - nothing runs and no network call is made.
//   * Never force-push. Never commit on main/master. commitOwned stages ONLY the
//     paths it is given - never `git add -A`, never `git add .`.
//   * A token is never logged: every log line goes through redactForLog().
//   * Node built-ins only.
import { spawnSync } from "node:child_process";

export type GhConfig = { enabled: boolean; dryRun: boolean };

/**
 * FLEET_GITHUB=1 turns the flow on (default off). FLEET_GITHUB_DRY_RUN=1 makes every
 * action a no-op that only logs. Read from env at call time, not import time.
 */
export function ghConfig(): GhConfig {
  return {
    enabled: (process.env.FLEET_GITHUB ?? "").trim() === "1",
    dryRun: (process.env.FLEET_GITHUB_DRY_RUN ?? "").trim() === "1",
  };
}

// ---------------------------------------------------------------- redaction
// No token may ever reach a log line. Mirrors the patterns the fleet already uses
// (terminalChat.ts SECRET_RULES / memory.ts redactSecrets), GitHub shapes included.
const SECRET_RULES: Array<[RegExp, string]> = [
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[redacted-github-token]"],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "[redacted-github-token]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{8,}/g, "[redacted-slack-token]"],
  [/\bAKIA[0-9A-Z]{12,}/g, "[redacted-aws-key]"],
  [/\b(?:sk|pk|rk|api)[-_][A-Za-z0-9_-]{12,}/g, "[redacted-key]"],
  [/\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted-jwt]"],
  [/((?:token|secret|password|passwd|api[_-]?key|auth[_-]?token)\s*[:=]\s*)["']?([A-Za-z0-9_\-.]{10,})["']?/gi, "$1[redacted]"],
  [/\b[A-Za-z0-9+/]{60,}={0,2}\b/g, "[redacted-blob]"],
];

/** Strip anything shaped like a credential from a log line. */
export function redactForLog(text: string): string {
  let out = String(text ?? "");
  for (const [re, to] of SECRET_RULES) out = out.replace(re, to);
  return out;
}

function log(action: string, detail: string): void {
  console.log(redactForLog(`[github] ${action}: ${detail}`));
}

// ---------------------------------------------------------------- git plumbing
type RunResult = { ok: boolean; status: number; stdout: string; stderr: string };

function git(dir: string, args: string[]): RunResult {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  const stderr = String(res.stderr ?? "") || (res.error ? String(res.error) : "");
  return {
    ok: res.status === 0,
    status: res.status ?? -1,
    stdout: String(res.stdout ?? ""),
    stderr,
  };
}

function currentBranch(dir: string): string {
  const res = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!res.ok) throw new Error(`github: could not read the current branch in ${dir}: ${redactForLog(res.stderr.trim())}`);
  return res.stdout.trim();
}

/** True when nothing may really run: the feature is off, or dry-run was requested. */
function isDry(): boolean {
  const c = ghConfig();
  return c.dryRun || !c.enabled;
}

function dryReason(): string {
  const c = ghConfig();
  if (!c.enabled) return "FLEET_GITHUB is off (default)";
  return "FLEET_GITHUB_DRY_RUN=1";
}

// ---------------------------------------------------------------- public API

/**
 * Throw a clear error unless `dir` is a git working tree with at least one remote.
 * Uses only local git; never touches the network.
 */
export function ensureRepo(dir: string): void {
  const inside = git(dir, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    const why = redactForLog(inside.stderr.trim() || inside.stdout.trim() || "git rev-parse returned no output");
    throw new Error(`github: ${dir} is not a git working tree (${why})`);
  }
  const remotes = git(dir, ["remote"]);
  if (!remotes.ok || !remotes.stdout.trim()) {
    throw new Error(`github: ${dir} is a git repo but has no remote configured`);
  }
}

/** Branch name `fleet/<orderId>/<workOrderId>`, sanitised so it never contains spaces. */
export function branchFor(orderId: string, workOrderId: string): string {
  const clean = (v: string): string => {
    const s = String(v ?? "")
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "");
    return s || "unknown";
  };
  return `fleet/${clean(orderId)}/${clean(workOrderId)}`;
}

export type CommitResult = { committed: boolean; dryRun: boolean; branch: string; paths: string[] };

/**
 * Stage ONLY the listed paths and commit. Refuses on main/master (even in dry-run,
 * so the refusal is never hidden). In dry-run/off it logs the intended commit and
 * changes nothing.
 */
export function commitOwned(dir: string, owns: string[], message: string): CommitResult {
  if (!Array.isArray(owns) || owns.length === 0) throw new Error("github: commitOwned needs at least one owned path");
  const branch = currentBranch(dir);
  if (branch === "main" || branch === "master") {
    throw new Error(`github: refusing to commit on protected branch "${branch}"`);
  }
  if (isDry()) {
    log("commitOwned", `DRY-RUN (${dryReason()}) would stage ${owns.length} owned path(s) on ${branch} [${owns.join(", ")}] and commit: ${message}`);
    return { committed: false, dryRun: true, branch, paths: [...owns] };
  }
  // Stage ONLY the owned paths - never `git add -A`, never `git add .`.
  const added = git(dir, ["add", "--", ...owns]);
  if (!added.ok) throw new Error(`github: git add failed for [${owns.join(", ")}]: ${redactForLog(added.stderr.trim())}`);
  const committed = git(dir, ["commit", "-m", message]);
  if (!committed.ok) throw new Error(`github: git commit failed: ${redactForLog(committed.stderr.trim() || committed.stdout.trim())}`);
  log("commitOwned", `committed ${owns.length} owned path(s) on ${branch} [${owns.join(", ")}]`);
  return { committed: true, dryRun: false, branch, paths: [...owns] };
}

export type PushResult = { pushed: boolean; dryRun: boolean; branch: string };

/** Push a branch. Never uses a force flag. In dry-run/off it logs and does nothing. */
export function push(dir: string, branch: string): PushResult {
  if (!branch || branch.startsWith("-")) throw new Error(`github: refusing to push invalid branch "${branch}"`);
  if (isDry()) {
    log("push", `DRY-RUN (${dryReason()}) would push ${branch} to origin (no force)`);
    return { pushed: false, dryRun: true, branch };
  }
  const res = git(dir, ["push", "--set-upstream", "origin", branch]); // never --force
  if (!res.ok) throw new Error(`github: git push failed for ${branch}: ${redactForLog(res.stderr.trim() || res.stdout.trim())}`);
  log("push", `pushed ${branch} to origin (no force)`);
  return { pushed: true, dryRun: false, branch };
}

export type DraftPrArgs = { repo: string; branch: string; title: string; body: string; token: string; base?: string };

/**
 * Open a DRAFT pull request via the GitHub REST API and return its html_url.
 * Only runs when not dry-run AND a token was passed in; otherwise logs and returns null.
 * The token is never logged.
 */
export async function openDraftPr(args: DraftPrArgs): Promise<string | null> {
  const { repo, branch, title, body, token, base = "main" } = args;
  if (isDry()) {
    log("openDraftPr", `DRY-RUN (${dryReason()}) would open a draft PR on ${repo}: head=${branch} base=${base} title="${title}"`);
    return null;
  }
  if (!token) {
    log("openDraftPr", `skipped: no token passed in (repo=${repo} head=${branch})`);
    return null;
  }
  const res = await fetch(`https://api.github.com/repos/${repo}/pulls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "fleet-github-gh1",
    },
    body: JSON.stringify({ title, body, head: branch, base, draft: true }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`github: opening the draft PR failed (${res.status}): ${redactForLog(text.slice(0, 500))}`);
  }
  const json = (await res.json()) as { html_url?: string };
  const url = json.html_url ?? "";
  log("openDraftPr", `opened draft PR on ${repo} head=${branch}: ${url}`);
  return url;
}

export type CheckRun = { name: string; conclusion: string | null };
export type ReadChecksArgs = { repo: string; ref: string; token: string };

/**
 * Read check runs for a ref via the GitHub REST API. Same guard as openDraftPr:
 * only runs when not dry-run AND a token was passed in; returns [] otherwise.
 */
export async function readChecks(args: ReadChecksArgs): Promise<CheckRun[]> {
  const { repo, ref, token } = args;
  if (isDry()) {
    log("readChecks", `DRY-RUN (${dryReason()}) would read checks for ${repo}@${ref}`);
    return [];
  }
  if (!token) {
    log("readChecks", `skipped: no token passed in (repo=${repo} ref=${ref})`);
    return [];
  }
  const res = await fetch(`https://api.github.com/repos/${repo}/commits/${ref}/check-runs`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "fleet-github-gh1",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`github: reading checks failed (${res.status}): ${redactForLog(text.slice(0, 500))}`);
  }
  const json = (await res.json()) as { check_runs?: Array<{ name?: string; conclusion?: string | null }> };
  return (json.check_runs ?? []).map((c) => ({ name: c.name ?? "", conclusion: c.conclusion ?? null }));
}
