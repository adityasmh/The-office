/**
 * ops/fleet-retry-check.ts - F34 PROOF (docs/ORDER_2026-10-06_f34-retry-strip.md).
 *
 * Proves the retry-publish path (A) and the CI state the tick stores (B) with no router, no real
 * token and no network. Everything runs against a throwaway COMPANY_ROOT; the only "remote" is a
 * LOCAL bare git repo, and the only fetch is a stub that answers the GitHub check-runs URL (any
 * other fetch throws and is reported as a stray fetch).
 *
 *   npx tsx ops/fleet-retry-check.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// ── the check's fetch: the stubbed check-runs URL is answered from a table; anything else throws,
//    so no real network call can happen (a stray fetch fails the run). ─────────────────────────
const CHECK_PAYLOADS: Record<string, Array<{ name: string; conclusion: string | null }>> = {
  "fleet/foCiRed/WO-RED": [{ name: "unit", conclusion: "failure" }],
  "fleet/foCiGreen/WO-GREEN": [{ name: "unit", conclusion: "success" }],
  "fleet/foCiPending/WO-PENDING": [],
};
let stubFetches = 0;
let strayFetches = 0;
globalThis.fetch = (async (url: unknown) => {
  const u = String(url);
  const m = u.match(/\/commits\/(.+?)\/check-runs$/);
  const ref = m ? decodeURIComponent(m[1]!) : "";
  const runs = ref ? CHECK_PAYLOADS[ref] : undefined;
  if (!runs) {
    strayFetches++;
    throw new Error("unexpected fetch (no stub): " + u);
  }
  stubFetches++;
  return { ok: true, status: 200, json: async () => ({ check_runs: runs }), text: async () => "" } as unknown as Response;
}) as typeof fetch;

// ── throwaway roots, set BEFORE the module import (org.ts captures COMPANY_ROOT at import) ────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-retry-"));
const companyRoot = path.join(tmp, "company");
const repoDir = path.join(tmp, "repo");
const bare = path.join(tmp, "remote.git");
process.env.COMPANY_ROOT = companyRoot;
process.env.FLEET_REPO = repoDir;
process.env.MOCK_MODE = "1"; // no model calls; the point is the fleet's own state machine
process.env.FLEET_AUTO_APPROVE = "0";
process.env.FLEET_WATCH_INTERVAL_MS = "600000";
delete process.env.FLEET_GITHUB; // each phase sets what it needs
delete process.env.FLEET_GITHUB_DRY_RUN;
delete process.env.GITHUB_TOKEN;

fs.mkdirSync(path.join(companyRoot, "fleet"), { recursive: true });
fs.mkdirSync(repoDir, { recursive: true });

let failures = 0;
let n = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "PASS" : "FAIL"} ${++n}. ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures++;
};
const note = (name: string, detail: string): void => console.log(`NOTE ${name} - ${detail}`);
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function git(dir: string, args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  return { ok: r.status === 0, out: String(r.stdout ?? ""), err: String(r.stderr ?? "") };
}

// ── fixtures: every order the check needs, written once so the module cache stays authoritative ─
const WO_DONE = ["the deliverable exists"];

type Fixture = { orderId: string; status: string; wo: Record<string, unknown>; report?: string };

const fixtures: Fixture[] = [
  {
    // A: the refusals and the stubbed publish. `done` keeps the tick away from it.
    orderId: "foRetryRefuse",
    status: "done",
    wo: { id: "wo-ok", title: "PASS with no PR yet", role: "code", owns: ["seed.txt"], brief: "b", done: WO_DONE, state: "reviewed", attempts: 0, verdict: "PASS" },
  },
  {
    orderId: "foRetryRefuse",
    status: "done",
    wo: { id: "wo-nopass", title: "REDO work order", role: "code", owns: ["seed.txt"], brief: "b", done: WO_DONE, state: "reviewed", attempts: 0, verdict: "REDO" },
  },
  {
    orderId: "foRetryRefuse",
    status: "done",
    wo: { id: "wo-haspr", title: "PASS already published", role: "code", owns: ["seed.txt"], brief: "b", done: WO_DONE, state: "reviewed", attempts: 0, verdict: "PASS", prUrl: "https://github.com/example-org/example-repo/pull/9", branch: "fleet/foRetryRefuse/wo-haspr" },
  },
  {
    // A3: a stubbed publish that fails again.
    orderId: "foRetryFail",
    status: "done",
    wo: { id: "wo-fail", title: "PR publish failed after the push", role: "code", owns: ["seed.txt"], brief: "b", done: WO_DONE, state: "reviewed", attempts: 0, verdict: "PASS" },
  },
  {
    orderId: "foRetryFail",
    status: "done",
    wo: { id: "wo-fail-plain", title: "publish silently skipped", role: "code", owns: ["seed.txt"], brief: "b", done: WO_DONE, state: "reviewed", attempts: 0, verdict: "PASS" },
  },
  {
    // B: the tick's CI state. `running` so the tick visits them.
    orderId: "foCiRed",
    status: "running",
    wo: { id: "WO-RED", title: "CI red", role: "code", owns: ["seed.txt"], brief: "b", done: WO_DONE, state: "reviewed", attempts: 0, verdict: "PASS", prUrl: "https://github.com/example-org/example-repo/pull/1", branch: "fleet/foCiRed/WO-RED" },
  },
  {
    orderId: "foCiGreen",
    status: "running",
    wo: { id: "WO-GREEN", title: "CI green", role: "code", owns: ["seed.txt"], brief: "b", done: WO_DONE, state: "reviewed", attempts: 0, verdict: "PASS", prUrl: "https://github.com/example-org/example-repo/pull/2", branch: "fleet/foCiGreen/WO-GREEN" },
  },
  {
    orderId: "foCiPending",
    status: "running",
    wo: { id: "WO-PENDING", title: "CI pending", role: "code", owns: ["seed.txt"], brief: "b", done: WO_DONE, state: "reviewed", attempts: 0, verdict: "PASS", prUrl: "https://github.com/example-org/example-repo/pull/3", branch: "fleet/foCiPending/WO-PENDING" },
  },
  {
    // B: no PR at all -> the tick must write nothing.
    orderId: "foCiNone",
    status: "running",
    wo: { id: "WO-NOPR", title: "no PR", role: "code", owns: ["seed.txt"], brief: "b", done: WO_DONE, state: "reviewed", attempts: 0, verdict: "PASS" },
  },
  {
    // Live publish against the LOCAL bare remote (no token, no network).
    orderId: "foReal",
    status: "done",
    wo: { id: "wo-real", title: "live publish on a local remote", role: "code", owns: ["seed.txt"], brief: "b", done: WO_DONE, state: "reviewed", attempts: 0, verdict: "PASS" },
  },
];

function mkOrder(orderId: string, status: string, wos: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: orderId,
    text: "GOAL: (fixture) F34 retry / CI state.",
    createdAt: "2026-10-06T00:00:00.000Z",
    updatedAt: "2026-10-06T00:00:00.000Z",
    status,
    plan: "one work order",
    workOrders: wos,
    trace: [{ ts: "2026-10-06T00:00:00.000Z", from: "CEO", to: "Claude (manager)", what: "order", detail: "GOAL: fixture" }],
  };
}

const orderIds = [...new Set(fixtures.map((f) => f.orderId))];
const orderDocs = orderIds.map((id) => {
  const mine = fixtures.filter((f) => f.orderId === id);
  return mkOrder(id, mine[0]!.status, mine.map((f) => f.wo));
});
fs.writeFileSync(path.join(companyRoot, "fleet", "orders.json"), JSON.stringify(orderDocs, null, 2));

// REPORT.md exists for every work order (an empty owned-file tree would make the retry noisier).
for (const f of fixtures) {
  const dir = path.join(companyRoot, "fleet", f.orderId, String(f.wo.id));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "REPORT.md"), f.report ?? "# REPORT\nfixture\n");
}

const fleet = await import("../src/company/fleet.js");

const wo = (orderId: string, wid: string): Record<string, unknown> => {
  const o = fleet.getFleetOrder(orderId);
  const w = o && o.workOrders.find((x: Record<string, unknown>) => x.id === wid);
  if (!w) throw new Error(`fixture missing: ${orderId}/${wid}`);
  return w as unknown as Record<string, unknown>;
};
const traceLen = (orderId: string): number => (fleet.getFleetOrder(orderId)?.trace ?? []).length;

async function main(): Promise<void> {
  // ---- 1. refusals: not PASS, and already has a prUrl ------------------------------------
  delete process.env.FLEET_GITHUB;
  const rNopass = await fleet.republishWorkOrder("foRetryRefuse", "wo-nopass");
  const rHaspr = await fleet.republishWorkOrder("foRetryRefuse", "wo-haspr");
  const refused = rNopass.ok === false && /not PASS/i.test(String(rNopass.reason)) && rHaspr.ok === false && /already has a pull request/i.test(String(rHaspr.reason));
  check(
    "republishWorkOrder refuses a non-PASS verdict and a work order that already has a prUrl",
    refused,
    `nopass=${JSON.stringify(rNopass)} haspr=${JSON.stringify(rHaspr)}`,
  );

  // ---- 2. the route's 404 signal (extra) --------------------------------------------------
  const rMissing = await fleet.republishWorkOrder("foRetryRefuse", "wo-nope");
  const rNoOrder = await fleet.republishWorkOrder("no-such-order", "wo-ok");
  check(
    "an unknown order or work order returns notFound (the route's 404)",
    rMissing.ok === false && rMissing.notFound === true && rNoOrder.ok === false && rNoOrder.notFound === true,
    `missingWo=${JSON.stringify(rMissing)} missingOrder=${JSON.stringify(rNoOrder)}`,
  );

  // ---- 3. a stubbed publish that succeeds -------------------------------------------------
  const stubOk = async (): Promise<unknown> => ({
    branch: "fleet/foRetryRefuse/wo-ok",
    base: "main",
    dryRun: false,
    prUrl: "https://github.com/example-org/example-repo/pull/42",
  });
  const before3 = traceLen("foRetryRefuse");
  const okRes = await fleet.republishWorkOrder("foRetryRefuse", "wo-ok", stubOk as never);
  const o3 = fleet.getFleetOrder("foRetryRefuse")!;
  const w3 = wo("foRetryRefuse", "wo-ok");
  const hop3 = (o3.trace ?? [])[before3];
  const again = await fleet.republishWorkOrder("foRetryRefuse", "wo-ok"); // now refused: prUrl is stored
  check(
    "a stubbed publish that succeeds stores prUrl and branch and adds one trace step",
    okRes.ok === true &&
      String(okRes.prUrl) === "https://github.com/example-org/example-repo/pull/42" &&
      String(okRes.branch) === "fleet/foRetryRefuse/wo-ok" &&
      w3.prUrl === "https://github.com/example-org/example-repo/pull/42" &&
      w3.branch === "fleet/foRetryRefuse/wo-ok" &&
      traceLen("foRetryRefuse") === before3 + 1 &&
      !!hop3 &&
      hop3.to === "GitHub" &&
      String(hop3.what) === "draft PR" &&
      again.ok === false,
    `out=${JSON.stringify(okRes)} woBranch=${String(w3.branch)} hop=${JSON.stringify(hop3)} secondCall=${JSON.stringify(again)}`,
  );

  // ---- 4. a stubbed publish that fails again ----------------------------------------------
  const stubFail = async (): Promise<unknown> => ({ skipped: "github: git push failed for fleet/foRetryFail/wo-fail (403)", failed: true, branch: "fleet/foRetryFail/wo-fail" });
  const stubSkip = async (): Promise<unknown> => ({ skipped: "FLEET_GITHUB is off (default)" });
  const before4 = traceLen("foRetryFail");
  const failRes = await fleet.republishWorkOrder("foRetryFail", "wo-fail", stubFail as never);
  const w4 = wo("foRetryFail", "wo-fail");
  const hop4 = (fleet.getFleetOrder("foRetryFail")!.trace ?? [])[before4];
  const before4b = JSON.stringify(wo("foRetryFail", "wo-fail-plain"));
  const skipRes = await fleet.republishWorkOrder("foRetryFail", "wo-fail-plain", stubSkip as never);
  const unchanged = JSON.stringify(wo("foRetryFail", "wo-fail-plain")) === before4b;
  check(
    "a stubbed publish that fails again returns the reason, opens nothing and does not crash",
    failRes.ok === false &&
      /403/.test(String(failRes.reason)) &&
      !w4.prUrl &&
      w4.verdict === "PASS" &&
      w4.branch === "fleet/foRetryFail/wo-fail" &&
      !!hop4 &&
      String(hop4.what) === "PR publish failed" &&
      skipRes.ok === false &&
      unchanged,
    `fail=${JSON.stringify(failRes)} verdict=${String(w4.verdict)} prUrl=${String(w4.prUrl)} hop=${JSON.stringify(hop4)} skip=${JSON.stringify(skipRes)} plainWoUnchanged=${unchanged}`,
  );

  // ---- 5/6. the tick stores ciState from the stubbed CI result ----------------------------
  process.env.FLEET_GITHUB = "1";
  process.env.FLEET_GITHUB_REPO = "example-org/example-repo";
  process.env.GITHUB_TOKEN = "f34-check-token-not-real";
  const tick = await fleet.tickFleet();
  const red = wo("foCiRed", "WO-RED");
  const green = wo("foCiGreen", "WO-GREEN");
  const pending = wo("foCiPending", "WO-PENDING");
  check(
    "the tick stores ciState RED / GREEN / PENDING from the stubbed CI result",
    red.ciState === "RED" &&
      typeof red.ciCheckedAt === "string" &&
      green.ciState === "GREEN" &&
      typeof green.ciCheckedAt === "string" &&
      pending.ciState === "PENDING" &&
      typeof pending.ciCheckedAt === "string",
    `tick=${JSON.stringify(tick)} RED=${JSON.stringify(red.ciState)}@${String(red.ciCheckedAt)} ${JSON.stringify(green.ciState)}@${String(green.ciCheckedAt)} ${JSON.stringify(pending.ciState)}@${String(pending.ciCheckedAt)}`,
  );
  const noPr = wo("foCiNone", "WO-NOPR");
  check(
    "the tick writes nothing for a work order with no PR (and made no other fetch)",
    noPr.ciState === undefined && noPr.ciCheckedAt === undefined && stubFetches === 3 && strayFetches === 0,
    `noPr=${JSON.stringify(noPr.ciState)}/${String(noPr.ciCheckedAt)} stubFetches=${stubFetches} strayFetches=${strayFetches}`,
  );
  check(
    "the RED result still downgrades the PASS to REDO exactly once (the same check)",
    red.verdict === "REDO" && red.ciDowngraded === true,
    `verdict=${String(red.verdict)} ciDowngraded=${String(red.ciDowngraded)}`,
  );

  // ---- 7. live publish against the LOCAL bare remote (no token, no network) ---------------
  git(tmp, ["init", "--bare", bare]);
  git(repoDir, ["init"]);
  git(repoDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(repoDir, ["config", "user.email", "check@example.com"]);
  git(repoDir, ["config", "user.name", "F34 Check"]);
  fs.writeFileSync(path.join(repoDir, "seed.txt"), "seed\n");
  git(repoDir, ["add", "--", "seed.txt"]);
  git(repoDir, ["commit", "-m", "seed"]);
  git(repoDir, ["remote", "add", "origin", bare]);
  git(repoDir, ["push", "-u", "origin", "main"]);
  // The worker's change: the owned path, uncommitted, exactly as the fleet sees it at publish time.
  fs.writeFileSync(path.join(repoDir, "seed.txt"), "seed v2 (the work)\n");
  delete process.env.GITHUB_TOKEN; // no token: the PR call is skipped, nothing leaves the box
  const realRes = await fleet.republishWorkOrder("foReal", "wo-real");
  const localBranch = git(repoDir, ["rev-parse", "refs/heads/fleet/foReal/wo-real"]).out.trim();
  const remoteBranch = git(bare, ["rev-parse", "fleet/foReal/wo-real"]).out.trim();
  const committed = git(repoDir, ["show", "fleet/foReal/wo-real:seed.txt"]).out.trim();
  const backOn = git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]).out.trim();
  check(
    "a live publish on a local remote makes the branch, commits the owned change, pushes it and returns to main",
    realRes.ok === true &&
      String(realRes.branch) === "fleet/foReal/wo-real" &&
      !realRes.prUrl &&
      localBranch !== "" &&
      remoteBranch === localBranch &&
      committed === "seed v2 (the work)" &&
      backOn === "main" &&
      strayFetches === 0,
    `out=${JSON.stringify(realRes)} local=${localBranch.slice(0, 8)} remote=${remoteBranch.slice(0, 8)} committed=${JSON.stringify(committed)} backOn=${backOn}`,
  );

  // The retry on an already-existing branch: reuses it, never force-pushes, never crashes.
  const headBefore = git(repoDir, ["rev-parse", "refs/heads/fleet/foReal/wo-real"]).out.trim();
  const retryRes = await fleet.republishWorkOrder("foReal", "wo-real");
  const headAfter = git(repoDir, ["rev-parse", "refs/heads/fleet/foReal/wo-real"]).out.trim();
  const remoteAfter = git(bare, ["rev-parse", "fleet/foReal/wo-real"]).out.trim();
  const w7 = wo("foReal", "wo-real");
  check(
    "the retry on an existing branch reuses it, never force-pushes, does not crash and now succeeds (commitOwned treats nothing-to-commit as committed:false)",
    retryRes.ok === true &&
      headAfter === headBefore &&
      remoteAfter === headBefore &&
      !w7.prUrl &&
      w7.verdict === "PASS" &&
      strayFetches === 0,
    `retry=${JSON.stringify(retryRes)} headSame=${headAfter === headBefore} remoteIntact=${remoteAfter === headBefore}`,
  );
  note(
    "RESOLVED 2026-10-06 (manager)",
    `commitOwned now returns committed:false for "nothing to commit", so a retry falls through to push and the PR call; retry result: ${JSON.stringify(retryRes)}`,
  );

  console.log(`\n[fleet-retry] ${failures ? `${failures} FAILED` : "ALL CHECKS PASSED"} (${n} checks, stubFetches=${stubFetches}, strayFetches=${strayFetches}, temp ${tmp})`);
  if (failures) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`harness crashed: ${errText(e)}`);
  process.exitCode = 1;
});
