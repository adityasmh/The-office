// ops/fleet-github-check.ts - GH-2 PROOF.
//
// Proves src/company/fleetGithub.ts without any network, real token, or repo change.
// Uses a temp folder and a temp COMPANY_ROOT; FLEET_GITHUB_DRY_RUN=1 for the publish path.
//
// Run: npx tsx ops/fleet-github-check.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// ---- network guard: any fetch anywhere in this process is a failure ----------
let fetchCount = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
  fetchCount++;
  return realFetch(...args);
}) as typeof fetch;

function git(dir: string, args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  return { ok: r.status === 0, out: String(r.stdout ?? ""), err: String(r.stderr ?? "") };
}

type Row = { n: number; name: string; ok: boolean; detail: string };
const rows: Row[] = [];
let n = 0;
function record(name: string, ok: boolean, detail: string): void {
  rows.push({ n: ++n, name, ok, detail });
}
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type AnyOrder = { id: string; workOrders: Array<Record<string, unknown>> };

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-gh2-"));
  const companyRoot = path.join(tmp, "company");
  const repo = path.join(tmp, "repo");
  const plain = path.join(tmp, "plain");

  // temp COMPANY_ROOT must be set BEFORE the module import (org.ts captures it at import time).
  process.env.COMPANY_ROOT = companyRoot;
  fs.mkdirSync(path.join(companyRoot, "fleet", "ord-1", "wo-1"), { recursive: true });
  fs.writeFileSync(path.join(companyRoot, "fleet", "ord-1", "wo-1", "REPORT.md"), "# report\nreal output here\n");

  // a small git repo on "main" with one commit
  fs.mkdirSync(repo);
  fs.mkdirSync(plain);
  git(repo, ["init"]);
  git(repo, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(repo, ["config", "user.email", "check@example.com"]);
  git(repo, ["config", "user.name", "GH2 Check"]);
  fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  git(repo, ["add", "--", "seed.txt"]);
  git(repo, ["commit", "-m", "seed"]);
  const head0 = git(repo, ["rev-parse", "HEAD"]).out.trim();
  const branches0 = git(repo, ["branch", "--list"]).out;

  const order = { id: "ord-1", workOrders: [] } as unknown as AnyOrder;
  const wo = {
    id: "wo-1",
    title: "GH-2 publish check",
    owns: ["seed.txt"],
    verdict: "PASS",
    state: "reviewed",
    attempts: 0,
    done: [],
    role: "worker",
    brief: "test",
  };

  // import AFTER COMPANY_ROOT is set; ghConfig() reads env at call time.
  const fg = await import("../src/company/fleetGithub.js");

  try {
    // ---- 1. FLEET_GITHUB unset: skipped, nothing done -------------------------
    delete process.env.FLEET_GITHUB;
    delete process.env.FLEET_GITHUB_DRY_RUN;
    {
      const res = await fg.publishWorkOrder(order, wo, repo);
      const head = git(repo, ["rev-parse", "HEAD"]).out.trim();
      const branches = git(repo, ["branch", "--list"]).out;
      const ok = "skipped" in res && head === head0 && branches === branches0;
      record("1. FLEET_GITHUB unset -> skipped and does nothing", ok, `res=${JSON.stringify(res)} headSame=${head === head0} branchesSame=${branches === branches0}`);
    }

    // ---- 2. on + dry-run: expected branch, no git/network change -------------
    process.env.FLEET_GITHUB = "1";
    process.env.FLEET_GITHUB_DRY_RUN = "1";
    process.env.FLEET_GITHUB_REPO = "example-org/example-repo";
    {
      const res = await fg.publishWorkOrder(order, wo, repo);
      const head = git(repo, ["rev-parse", "HEAD"]).out.trim();
      const branches = git(repo, ["branch", "--list"]).out;
      const ok =
        "branch" in res &&
        res.branch === "fleet/ord-1/wo-1" &&
        res.dryRun === true &&
        !("prUrl" in res && res.prUrl) &&
        head === head0 &&
        branches === branches0 &&
        fetchCount === 0;
      record("2. dry-run PASS -> branch fleet/ord-1/wo-1, no git/network change", ok, `res=${JSON.stringify(res)} headSame=${head === head0} branchesSame=${branches === branches0} fetches=${fetchCount}`);
    }

    // ---- 3. non-git repo dir: never throws -----------------------------------
    delete process.env.FLEET_GITHUB_DRY_RUN;
    {
      let threw = false;
      let res: unknown = null;
      try {
        res = await fg.publishWorkOrder(order, wo, plain);
      } catch (e) {
        threw = true;
        res = errText(e);
      }
      const ok = !threw && typeof res === "object" && res !== null && "skipped" in res;
      record("3. publishWorkOrder never throws on a non-git repo dir", ok, `threw=${threw} res=${JSON.stringify(res)}`);
    }

    // ---- 4. ciVerdict in dry-run: PENDING ------------------------------------
    process.env.FLEET_GITHUB_DRY_RUN = "1";
    {
      const woPr = { ...wo, prUrl: "https://github.com/example-org/example-repo/pull/1" };
      const v = await fg.ciVerdict(order, woPr);
      record("4. ciVerdict in dry-run -> PENDING", v === "PENDING", `verdict=${v}`);
    }

    // ---- 5. RED stub downgrades PASS -> REDO exactly once --------------------
    {
      const woPr = { ...wo, prUrl: "https://github.com/example-org/example-repo/pull/1" };
      const checks = [
        { name: "tsc", conclusion: "success" },
        { name: "fleet-check", conclusion: "failure" },
      ];
      const d1 = await fg.applyCiDowngrade(order, woPr, checks);
      const afterFirst = woPr.verdict;
      const d2 = await fg.applyCiDowngrade(order, woPr, checks);
      const ok =
        d1.downgraded === true &&
        d1.failed.includes("fleet-check") &&
        afterFirst === "REDO" &&
        woPr.ciDowngraded === true &&
        String(woPr.review).includes("fleet-check") &&
        d2.downgraded === false &&
        woPr.verdict === "REDO";
      record("5. RED CI stub downgrades PASS -> REDO exactly once", ok, `d1=${JSON.stringify(d1)} verdict=${afterFirst} d2=${JSON.stringify(d2)}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  for (const r of rows) {
    console.log(`${r.ok ? "PASS" : "FAIL"} ${r.n}. ${r.name} - ${r.detail}`);
  }
  const allOk = rows.every((r) => r.ok) && fetchCount === 0;
  console.log(`\n${allOk ? "ALL PASS" : "FAIL"} (${rows.filter((r) => r.ok).length}/${rows.length} checks, fetches=${fetchCount})`);
  process.exitCode = allOk ? 0 : 1;
}

main().catch((e) => {
  console.error(`harness crashed: ${errText(e)}`);
  process.exitCode = 1;
});
