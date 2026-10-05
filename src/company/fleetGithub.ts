// fleetGithub.ts - GH-2: hooks the GH-1 git/GitHub helper into the fleet review path.
//
// This is the ONLY place that decides when a PASSed work order becomes a draft pull
// request, and when a red CI check on that PR downgrades the PASS to a REDO.
//
// Safety, matching docs/GITHUB_INTEGRATION_SPEC.md and GH-1's github.ts:
//   * OFF by default. FLEET_GITHUB must be "1" for anything to run; until then every
//     export here is a no-op that returns a "skipped" result and makes no git/network call.
//   * FLEET_GITHUB_DRY_RUN=1 turns publishWorkOrder into a log line with no git change.
//   * Repo from FLEET_GITHUB_REPO (owner/name); token from GITHUB_TOKEN. Base branch from
//     FLEET_GITHUB_BASE (default "main"). The token is never logged (all output goes through
//     redactForLog).
//   * publishWorkOrder NEVER throws: every failure is caught and returned as { skipped }.
//   * Node built-ins only; imports the finished helper from ./github.js, never edits it.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getCompanyRoot } from "./org.js";
import {
  ghConfig,
  ensureRepo,
  branchFor,
  commitOwned,
  push,
  openDraftPr,
  readChecks,
  redactForLog,
  currentBranch,
  checkoutBranch,
  shortSubject,
  type CheckRun,
} from "./github.js";
// Type-only: erased at compile time, so this does not create a runtime import cycle
// with fleet.ts (which imports the values below).
import type { FleetOrder, WorkOrder } from "./fleet.js";

export type CiVerdict = "RED" | "GREEN" | "PENDING";

export type PublishResult =
  | { prUrl?: string; branch: string; base: string; dryRun: boolean }
  | { skipped: string; failed?: true; branch?: string };

function log(action: string, detail: string): void {
  console.log(redactForLog(`[fleetGithub] ${action}: ${detail}`));
}

function repoName(): string {
  return (process.env.FLEET_GITHUB_REPO ?? "").trim();
}

function repoToken(): string {
  return (process.env.GITHUB_TOKEN ?? "").trim();
}

/** The draft PR's base branch: FLEET_GITHUB_BASE when set, else "main". */
function prBase(): string {
  return (process.env.FLEET_GITHUB_BASE ?? "").trim() || "main";
}

// ── REPORT.md path (mirrors fleet.ts's reportPath; ids are sanitised the same way) ──
function sanitizeId(id: string): string {
  return String(id).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "unnamed";
}

function readReport(orderId: string, wid: string): string {
  const file = path.join(getCompanyRoot(), "fleet", sanitizeId(orderId), sanitizeId(wid), "REPORT.md");
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "(REPORT.md could not be read)";
  }
}

// ── local git plumbing for branch creation (GH-1 owns the rest) ─────────────
function gitRun(dir: string, args: string[]): { ok: boolean; err: string } {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  const err = String(r.stderr ?? "") || (r.error ? String(r.error) : "");
  return { ok: r.status === 0, err };
}

/** Create `branch` off the current HEAD, or switch to it if it already exists. */
function ensureBranch(dir: string, branch: string): void {
  const created = gitRun(dir, ["checkout", "-b", branch]);
  if (created.ok) return;
  const switched = gitRun(dir, ["checkout", branch]);
  if (!switched.ok) {
    throw new Error(`github: could not create or switch to branch ${branch}: ${redactForLog((created.err || switched.err).trim())}`);
  }
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * On a PASSed work order, publish it as a DRAFT pull request: branch `fleet/<order>/<wo>`,
 * commit ONLY the owned paths, push, open the PR with the REPORT.md text + verdict line.
 *
 * Returns { prUrl?, branch, dryRun } on success/dry-run, or { skipped: reason }. Never throws.
 */
export async function publishWorkOrder(
  order: FleetOrder,
  workOrder: WorkOrder,
  repoDir: string,
): Promise<PublishResult> {
  const cfg = ghConfig();
  if (!cfg.enabled) return { skipped: "FLEET_GITHUB is off (default)" };
  if (workOrder.verdict !== "PASS") return { skipped: `verdict is ${workOrder.verdict ?? "unset"}, not PASS` };

  const branch = branchFor(order.id, workOrder.id);
  const base = prBase();

  // Dry-run (or a missing repo/token) must change nothing. Start no git or network work.
  if (cfg.dryRun) {
    log(
      "publishWorkOrder",
      `DRY-RUN (FLEET_GITHUB_DRY_RUN=1) would branch ${branch}, commit [${workOrder.owns.join(", ")}], push and open a draft PR on base ${base}`,
    );
    return { branch, base, dryRun: true };
  }

  let startBranch = "";
  let branchMade = false;
  try {
    const repo = repoName();
    if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) return { skipped: "FLEET_GITHUB_REPO is not set as owner/name" };
    const token = repoToken();
    ensureRepo(repoDir);
    startBranch = currentBranch(repoDir);
    ensureBranch(repoDir, branch);
    branchMade = true;
    commitOwned(repoDir, workOrder.owns, shortSubject(workOrder.title, 72));
    push(repoDir, branch);
    const body = `${readReport(order.id, workOrder.id)}\n\nVerdict: ${workOrder.verdict}`;
    const prUrl = await openDraftPr({ repo, branch, title: shortSubject(workOrder.title, 100), body, token, base });
    log("publishWorkOrder", `branch ${branch} pushed; draft PR ${prUrl ?? "(not opened: no token)"} on base ${base}`);
    return { branch, base, dryRun: false, ...(prUrl ? { prUrl } : {}) };
  } catch (e) {
    // Never throw into the fleet: a publish failure must not change a verdict or crash a tick.
    // Once the branch exists the folder is on it, so the caller must be told (failed) and the
    // result carries the branch it was left on for the trace.
    const reason = redactForLog(String(e)).slice(0, 300);
    return branchMade ? { skipped: reason, failed: true, branch } : { skipped: reason };
  } finally {
    // The next order must branch from the branch we started on: return the folder to it on
    // success AND failure. A failed switch is ignored (the publish result still stands) but is
    // always reported in the log line.
    if (branchMade && startBranch) {
      try {
        checkoutBranch(repoDir, startBranch);
      } catch (e) {
        log("publishWorkOrder", `could not return to ${startBranch}: ${redactForLog(String(e))}`);
      }
    }
  }
}

/** Read the PR's checks. `checks` is an optional test seam (the proof passes a stub). */
async function readPrChecks(
  order: FleetOrder,
  workOrder: WorkOrder,
  checks?: CheckRun[],
): Promise<CheckRun[]> {
  if (checks) return checks;
  const cfg = ghConfig();
  const repo = repoName();
  const token = repoToken();
  if (!workOrder.prUrl || !cfg.enabled || cfg.dryRun || !repo || !token) return [];
  try {
    const ref = workOrder.branch ?? branchFor(order.id, workOrder.id);
    return await readChecks({ repo, ref, token });
  } catch {
    return [];
  }
}

/**
 * The CI verdict for a work order's PR. "RED" if any check failed, "GREEN" if all passed,
 * else "PENDING". Dry-run, no PR, or no token is always "PENDING" (nothing is called).
 * An explicit `checks` array is honoured as-is (the proof's stub seam).
 */
export async function ciVerdict(
  order: FleetOrder,
  workOrder: WorkOrder,
  checks?: CheckRun[],
): Promise<CiVerdict> {
  const runs = await readPrChecks(order, workOrder, checks);
  if (runs.length === 0) return "PENDING";
  if (runs.some((c) => c.conclusion === "failure")) return "RED";
  if (runs.every((c) => c.conclusion === "success")) return "GREEN";
  return "PENDING";
}

/**
 * Downgrade a PASSed work order to REDO ONCE when its PR's CI is RED, naming the failed
 * checks in the review text. Mutates the work order in place and reports what it did.
 * A second call (ciDowngraded already set) changes nothing.
 */
export async function applyCiDowngrade(
  order: FleetOrder,
  workOrder: WorkOrder,
  checks?: CheckRun[],
): Promise<{ downgraded: boolean; verdict: CiVerdict; failed: string[] }> {
  if (workOrder.ciDowngraded) return { downgraded: false, verdict: "PENDING", failed: [] };
  const runs = await readPrChecks(order, workOrder, checks);
  const verdict: CiVerdict =
    runs.length === 0 ? "PENDING" : runs.some((c) => c.conclusion === "failure") ? "RED" : runs.every((c) => c.conclusion === "success") ? "GREEN" : "PENDING";
  if (verdict !== "RED") return { downgraded: false, verdict, failed: [] };

  const failed = runs.filter((c) => c.conclusion === "failure").map((c) => c.name || "(unnamed check)");
  workOrder.ciDowngraded = true;
  workOrder.verdict = "REDO";
  const names = failed.join(", ") || "the PR's CI check";
  workOrder.review = `automated CI check on the draft PR: ${names} failed, so the PASS is downgraded to REDO. ${workOrder.review ?? ""}`.trim();
  return { downgraded: true, verdict, failed };
}
