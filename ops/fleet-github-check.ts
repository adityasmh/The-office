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
  const bare = path.join(tmp, "remote.git");

  // No real token may be used anywhere in this check.
  delete process.env.GITHUB_TOKEN;

  // temp COMPANY_ROOT must be set BEFORE the module import (org.ts captures it at import time).
  process.env.COMPANY_ROOT = companyRoot;
  fs.mkdirSync(path.join(companyRoot, "fleet", "ord-1", "wo-1"), { recursive: true });
  fs.writeFileSync(path.join(companyRoot, "fleet", "ord-1", "wo-1", "REPORT.md"), "# report\nreal output here\n");

  // a small git repo on "main" with one commit, and a LOCAL BARE remote (no network)
  fs.mkdirSync(repo);
  fs.mkdirSync(plain);
  git(tmp, ["init", "--bare", bare]);
  git(repo, ["init"]);
  git(repo, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(repo, ["config", "user.email", "check@example.com"]);
  git(repo, ["config", "user.name", "GH2 Check"]);
  fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  git(repo, ["add", "--", "seed.txt"]);
  git(repo, ["commit", "-m", "seed"]);
  git(repo, ["remote", "add", "origin", bare]);
  git(repo, ["push", "-u", "origin", "main"]);
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

    // ---- 6. no FLEET_GITHUB_BASE: the dry-run base is "main" ------------------
    {
      const prevBase = process.env.FLEET_GITHUB_BASE;
      try {
        delete process.env.FLEET_GITHUB_BASE;
        const res = await fg.publishWorkOrder(order, wo, repo);
        const ok = "base" in res && res.base === "main";
        record('6. FLEET_GITHUB_BASE unset -> dry-run base is "main"', ok, `res=${JSON.stringify(res)}`);
      } finally {
        if (prevBase === undefined) delete process.env.FLEET_GITHUB_BASE;
        else process.env.FLEET_GITHUB_BASE = prevBase;
      }
    }

    // ---- 7. FLEET_GITHUB_BASE set: the dry-run base follows it -----------------
    {
      const prevBase = process.env.FLEET_GITHUB_BASE;
      try {
        process.env.FLEET_GITHUB_BASE = "fleet-orchestrator";
        const res = await fg.publishWorkOrder(order, wo, repo);
        const ok = "base" in res && res.base === "fleet-orchestrator";
        record("7. FLEET_GITHUB_BASE=fleet-orchestrator -> dry-run base follows it", ok, `res=${JSON.stringify(res)}`);
      } finally {
        if (prevBase === undefined) delete process.env.FLEET_GITHUB_BASE;
        else process.env.FLEET_GITHUB_BASE = prevBase;
      }
    }

    // From here on: live (no dry-run), no token, the local bare remote as origin.
    delete process.env.FLEET_GITHUB_DRY_RUN;
    delete process.env.GITHUB_TOKEN;

    // ---- 8. live publish with no token: repo back on its starting branch -------
    {
      fs.writeFileSync(path.join(repo, "seed.txt"), "seed v2\n");
      const startBranch = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).out.trim();
      const wo8 = { ...wo, id: "wo-8", title: "GH-5 live publish" };
      const res = await fg.publishWorkOrder(order, wo8, repo);
      const backOn = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).out.trim();
      const branchExists = git(repo, ["branch", "--list", "fleet/ord-1/wo-8"]).out.trim() !== "";
      const pushed = git(bare, ["rev-parse", "fleet/ord-1/wo-8"]).out.trim();
      const ok =
        "branch" in res &&
        res.branch === "fleet/ord-1/wo-8" &&
        res.dryRun === false &&
        !res.prUrl &&
        backOn === startBranch &&
        branchExists &&
        pushed !== "" &&
        fetchCount === 0;
      record("8. live publish (no token) -> repo back on its starting branch", ok, `res=${JSON.stringify(res)} backOn=${backOn} branchExists=${branchExists} pushed=${pushed.slice(0, 8)} fetches=${fetchCount}`);
    }

    // ---- 9. commit subject is at most 72 chars for a 500-char title ------------
    {
      fs.writeFileSync(path.join(repo, "seed.txt"), "seed v3\n");
      const longTitle = "T".repeat(500);
      const wo9 = { ...wo, id: "wo-9", title: longTitle };
      const res = await fg.publishWorkOrder(order, wo9, repo);
      const subject = git(repo, ["log", "-1", "--format=%s", "fleet/ord-1/wo-9"]).out.trim();
      const ok = "branch" in res && subject.length > 0 && subject.length <= 72 && longTitle.startsWith(subject.replace(/…$/, ""));
      record("9. commit subject is at most 72 chars for a 500-char title", ok, `subjectLen=${subject.length} subject="${subject.slice(0, 48)}…"`);
    }

    // ---- 10. push failure: failed:true and repo back on its starting branch -----
    {
      fs.writeFileSync(path.join(repo, "seed.txt"), "seed v4\n");
      const realOrigin = git(repo, ["remote", "get-url", "origin"]).out.trim();
      git(repo, ["remote", "set-url", "origin", path.join(tmp, "does-not-exist.git")]);
      const wo10 = { ...wo, id: "wo-10", title: "GH-5 failed push" };
      const res = await fg.publishWorkOrder(order, wo10, repo);
      const backOn = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).out.trim();
      git(repo, ["remote", "set-url", "origin", realOrigin]);
      const ok = "skipped" in res && res.failed === true && res.branch === "fleet/ord-1/wo-10" && backOn === "main";
      record("10. push failure -> failed:true, repo back on its starting branch", ok, `res=${JSON.stringify(res)} backOn=${backOn}`);
    }

    // ─────────────── F1-OWNS: deriving an empty `owns` ───────────────
    // Still live (no dry-run), still no token, still the local bare remote.

    // ---- 11. empty owns: a changed file named in the report is derived + committed ----
    {
      fs.writeFileSync(path.join(repo, "owned.txt"), "owned v1\n"); // untracked, named in the report
      fs.writeFileSync(path.join(repo, "unowned.txt"), "unowned v1\n"); // untracked, NOT named
      fs.mkdirSync(path.join(companyRoot, "fleet", "ord-1", "wo-11"), { recursive: true });
      fs.writeFileSync(path.join(companyRoot, "fleet", "ord-1", "wo-11", "REPORT.md"), "# report\nchanged file owned.txt is done\n");
      const wo11 = { ...wo, id: "wo-11", title: "F1 derived owns", owns: [] as string[] };
      const res = await fg.publishWorkOrder(order, wo11, repo);
      const committed = git(repo, ["show", "--name-only", "--format=", "fleet/ord-1/wo-11"]).out.trim().split(/\r?\n/).filter(Boolean);
      const status = git(repo, ["status", "--porcelain"]).out;
      const unownedDirty = /unowned\.txt/.test(status);
      const ok =
        "branch" in res &&
        res.branch === "fleet/ord-1/wo-11" &&
        JSON.stringify(res.derivedOwns) === JSON.stringify(["owned.txt"]) &&
        committed.includes("owned.txt") &&
        !committed.includes("unowned.txt") &&
        unownedDirty;
      record("11. empty owns -> changed+named derived+committed; changed+unnamed left uncommitted", ok, `res=${JSON.stringify(res)} committed=[${committed.join(", ")}] unownedDirty=${unownedDirty}`);
    }

    // ---- 12. a file named in the report that did NOT change is not derived ----
    {
      fs.writeFileSync(path.join(repo, "absent.txt"), "keep\n");
      git(repo, ["add", "--", "absent.txt"]);
      git(repo, ["commit", "-m", "track absent.txt clean"]);
      const wo12 = { ...wo, id: "wo-12", owns: [] as string[] };
      const d = fg.deriveOwns(wo12, repo, "# report\nwe edited absent.txt in an earlier step\n");
      const ok = d.owns.length === 0;
      record("12. a report-named file that did not change is not derived", ok, `owns=[${d.owns.join(", ")}] why=${d.why}`);
    }

    // ---- 13. .env / company/ / .. paths are removed even when changed and named ----
    {
      fs.writeFileSync(path.join(repo, ".env"), "SECRET=1\n");
      fs.mkdirSync(path.join(repo, "company"), { recursive: true });
      fs.writeFileSync(path.join(repo, "company", "x.json"), "{}\n");
      const wo13 = { ...wo, id: "wo-13", owns: [] as string[] };
      const d13 = fg.deriveOwns(wo13, repo, "# report\n.env\ncompany/x.json\n../outside.txt\n");
      const filtered = fg.ownablePaths([".env", ".env.example", "company/x.json", "../outside.txt", "ok.txt", "a.pem", "b.key", "c.log", "d.pid", "logs/e.txt", "node_modules/f.js", ".git/config"]);
      const filteredOk = JSON.stringify(filtered) === JSON.stringify([".env.example", "ok.txt"]);
      const ok = d13.owns.length === 0 && filteredOk;
      record("13. .env, company/x.json and ../outside.txt are removed even when changed and named", ok, `owns=[${d13.owns.join(", ")}] why=${d13.why} filtered=[${filtered.join(", ")}]`);
    }

    // ---- 14. more than 20 qualifying files -> empty owns with the cap reason ----
    {
      const capRepo = path.join(tmp, "caprepo");
      fs.mkdirSync(capRepo);
      git(capRepo, ["init"]);
      git(capRepo, ["symbolic-ref", "HEAD", "refs/heads/main"]);
      git(capRepo, ["config", "user.email", "check@example.com"]);
      git(capRepo, ["config", "user.name", "GH2 Check"]);
      fs.writeFileSync(path.join(capRepo, "seed.txt"), "seed\n");
      git(capRepo, ["add", "--", "seed.txt"]);
      git(capRepo, ["commit", "-m", "seed"]);
      const names: string[] = [];
      for (let i = 1; i <= 21; i++) {
        const name = `f${String(i).padStart(2, "0")}.txt`;
        names.push(name);
        fs.writeFileSync(path.join(capRepo, name), `v${i}\n`);
      }
      const wo14 = { ...wo, id: "wo-14", owns: [] as string[] };
      const report14 = `# report\n${names.join("\n")}\n`;
      const over = fg.deriveOwns(wo14, capRepo, report14);
      fs.rmSync(path.join(capRepo, "f21.txt")); // now exactly 20 changed + named files
      const at20 = fg.deriveOwns(wo14, capRepo, report14);
      const ok = over.owns.length === 0 && /20/.test(over.why) && at20.owns.length === 20;
      record("14. >20 qualifying files -> empty owns with the cap reason; exactly 20 -> 20", ok, `over=${over.owns.length} why=${over.why} at20=${at20.owns.length}`);
    }

    // ---- 15. a non-empty owns behaves exactly as before (no derivation) ----
    {
      fs.writeFileSync(path.join(repo, "seed.txt"), "seed v5\n");
      fs.writeFileSync(path.join(repo, "decoy.txt"), "decoy\n"); // changed + would be derivable
      fs.mkdirSync(path.join(companyRoot, "fleet", "ord-1", "wo-15"), { recursive: true });
      fs.writeFileSync(path.join(companyRoot, "fleet", "ord-1", "wo-15", "REPORT.md"), "# report\nseed.txt and decoy.txt\n");
      const wo15 = { ...wo, id: "wo-15", owns: ["seed.txt"] };
      const res = await fg.publishWorkOrder(order, wo15, repo);
      const committed = git(repo, ["show", "--name-only", "--format=", "fleet/ord-1/wo-15"]).out.trim().split(/\r?\n/).filter(Boolean);
      const decoyDirty = /decoy\.txt/.test(git(repo, ["status", "--porcelain"]).out);
      const ok =
        "branch" in res &&
        res.branch === "fleet/ord-1/wo-15" &&
        res.derivedOwns === undefined &&
        committed.includes("seed.txt") &&
        !committed.includes("decoy.txt") &&
        decoyDirty;
      record("15. a non-empty owns commits exactly as before (no derivation)", ok, `res=${JSON.stringify(res)} committed=[${committed.join(", ")}] decoyDirty=${decoyDirty}`);
    }

    // ---- 16. dry-run with empty owns logs the derived list and changes nothing ----
    {
      fs.writeFileSync(path.join(repo, "dry.txt"), "dry\n"); // untracked, named in the report
      fs.mkdirSync(path.join(companyRoot, "fleet", "ord-1", "wo-16"), { recursive: true });
      fs.writeFileSync(path.join(companyRoot, "fleet", "ord-1", "wo-16", "REPORT.md"), "# report\ndry.txt was touched\n");
      const wo16 = { ...wo, id: "wo-16", title: "F1 dry derived owns", owns: [] as string[] };
      const headBefore = git(repo, ["rev-parse", "HEAD"]).out.trim();
      const branchesBefore = git(repo, ["branch", "--list"]).out;
      const lines: string[] = [];
      const realLog = console.log;
      let res: unknown = null;
      try {
        console.log = (...a: unknown[]) => {
          lines.push(a.map((v) => String(v)).join(" "));
        };
        process.env.FLEET_GITHUB_DRY_RUN = "1";
        res = await fg.publishWorkOrder(order, wo16, repo);
      } finally {
        console.log = realLog;
        delete process.env.FLEET_GITHUB_DRY_RUN;
      }
      const headAfter = git(repo, ["rev-parse", "HEAD"]).out.trim();
      const branchesAfter = git(repo, ["branch", "--list"]).out;
      const logged = lines.some((l) => /DRY-RUN/.test(l) && l.includes("dry.txt"));
      const r = res as { branch?: string; dryRun?: boolean; derivedOwns?: string[] };
      const ok =
        logged &&
        r.dryRun === true &&
        JSON.stringify(r.derivedOwns) === JSON.stringify(["dry.txt"]) &&
        headBefore === headAfter &&
        branchesBefore === branchesAfter &&
        fetchCount === 0;
      record("16. dry-run with empty owns logs the derived list and changes nothing", ok, `logged=${logged} res=${JSON.stringify(res)} headSame=${headBefore === headAfter} branchesSame=${branchesBefore === branchesAfter}`);
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
