// ops/github-check.ts - GH-1 PROOF.
//
// Proves src/company/github.ts against a temp folder under os.tmpdir() whose remote
// is a LOCAL BARE repo. No network and no real token are used anywhere: the only
// fetch that could happen is counted, and the check fails if it ever fires.
//
// Run: npx tsx ops/github-check.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
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
} from "../src/company/github.js";

// ---- network guard: any fetch anywhere in this process is a failure ----------
let fetchCount = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
  fetchCount++;
  return realFetch(...args);
}) as typeof fetch;

// ---- git plumbing for the harness --------------------------------------------
function git(dir: string, args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  return { ok: r.status === 0, out: String(r.stdout ?? ""), err: String(r.stderr ?? "") };
}
const revParse = (dir: string, ref: string): string => git(dir, ["rev-parse", ref]).out.trim();

type Row = { n: number; name: string; ok: boolean; detail: string };
const rows: Row[] = [];
let n = 0;
function record(name: string, ok: boolean, detail: string): void {
  rows.push({ n: ++n, name, ok, detail });
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-gh1-"));
  const bare = path.join(tmp, "remote.git");
  const work = path.join(tmp, "work");
  const plain = path.join(tmp, "plain");
  fs.mkdirSync(work);
  fs.mkdirSync(plain);

  try {
    // ---- setup: local bare remote + a working clone on branch "main" ----------
    git(tmp, ["init", "--bare", bare]);
    git(work, ["init"]);
    git(work, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(work, ["config", "user.email", "gh1-check@example.test"]);
    git(work, ["config", "user.name", "GH-1 Check"]);
    fs.writeFileSync(path.join(work, "owned.txt"), "owned v1\n");
    fs.writeFileSync(path.join(work, "other.txt"), "other v1\n");
    git(work, ["add", "--", "owned.txt", "other.txt"]);
    git(work, ["commit", "-m", "init"]);
    git(work, ["remote", "add", "origin", bare]);
    git(work, ["push", "-u", "origin", "main"]);

    // Live (non-dry) mode for the real git checks 1-5.
    process.env.FLEET_GITHUB = "1";
    process.env.FLEET_GITHUB_DRY_RUN = "0";

    // ---- 1. ensureRepo rejects a plain folder with no git --------------------
    try {
      ensureRepo(plain);
      record("ensureRepo rejects a plain folder with no git", false, "no error was thrown");
    } catch (e) {
      record("ensureRepo rejects a plain folder with no git", true, errText(e));
    }

    // ---- 2. branchFor gives the expected name --------------------------------
    const b1 = branchFor("ord-1", "wo-1");
    const b2 = branchFor("ord 1", "wo/2"); // sanitised: no spaces
    const b2ok = b2 === "fleet/ord-1/wo-2" && !/\s/.test(b1);
    record("branchFor gives the expected name", b1 === "fleet/ord-1/wo-1" && b2ok, `branchFor("ord-1","wo-1")=${b1}; branchFor("ord 1","wo/2")=${b2}`);

    // ---- 3. commitOwned commits ONLY the owned file --------------------------
    git(work, ["checkout", "-b", "fleet/ord-1/wo-1"]);
    fs.writeFileSync(path.join(work, "owned.txt"), "owned v2\n");
    fs.writeFileSync(path.join(work, "other.txt"), "other v2\n");
    const c3 = commitOwned(work, ["owned.txt"], "GH-1: owned only");
    const files3 = git(work, ["show", "--name-only", "--format=", "HEAD"]).out.trim().split(/\r?\n/).filter(Boolean);
    const status3 = git(work, ["status", "--porcelain"]).out;
    const onlyOwned = files3.length === 1 && files3[0] === "owned.txt";
    const otherStillDirty = /other\.txt/.test(status3);
    record("commitOwned commits only the owned file", c3.committed && onlyOwned && otherStillDirty, `commit files=[${files3.join(", ")}] committed=${c3.committed} other.txt still dirty=${otherStillDirty}`);

    // ---- 4. commitOwned refuses on main --------------------------------------
    git(work, ["checkout", "main"]);
    let refused4 = false;
    let refusedMsg = "";
    try {
      commitOwned(work, ["owned.txt"], "should refuse");
    } catch (e) {
      refused4 = /protected branch/.test(errText(e));
      refusedMsg = errText(e);
    }
    record("commitOwned refuses on main", refused4, refusedMsg || "no error was thrown");

    // ---- 5. push lands the branch; main unchanged ----------------------------
    git(work, ["checkout", "fleet/ord-1/wo-1"]);
    const localTip = revParse(work, "HEAD");
    const mainBefore = revParse(bare, "main");
    const p5 = push(work, "fleet/ord-1/wo-1");
    const remoteTip = revParse(bare, "fleet/ord-1/wo-1");
    const mainAfter = revParse(bare, "main");
    record("push lands the branch and leaves main unchanged", p5.pushed && remoteTip === localTip && remoteTip !== "" && mainBefore === mainAfter, `pushed=${p5.pushed} remoteTip=${remoteTip.slice(0, 8)} localTip=${localTip.slice(0, 8)} main ${mainBefore.slice(0, 8)}->${mainAfter.slice(0, 8)}`);

    // ---- 6. dry-run: no commit, no push, repo state unchanged ----------------
    process.env.FLEET_GITHUB_DRY_RUN = "1";
    const headBefore = revParse(work, "HEAD");
    fs.appendFileSync(path.join(work, "owned.txt"), "dry change\n");
    const c6 = commitOwned(work, ["owned.txt"], "dry commit");
    const p6 = push(work, "fleet/ord-1/wo-1");
    const headAfter = revParse(work, "HEAD");
    const status6 = git(work, ["status", "--porcelain"]).out;
    const stateUnchanged = headBefore === headAfter && /owned\.txt/.test(status6);
    record("dry-run: no commit, push, or state change", c6.committed === false && p6.pushed === false && stateUnchanged, `committed=${c6.committed} pushed=${p6.pushed} head unchanged=${headBefore === headAfter}`);

    // ---- 7. dry-run: openDraftPr / readChecks return with no network ---------
    const fakeToken = "ghp_" + "A".repeat(36); // token-shaped, fake, never sent
    const captured: string[] = [];
    const realLog = console.log;
    console.log = (...a: unknown[]) => {
      captured.push(a.map((v) => String(v)).join(" "));
    };
    let pr7: string | null = null;
    let checks7: Awaited<ReturnType<typeof readChecks>> = [];
    try {
      pr7 = await openDraftPr({ repo: "acme/repo", branch: "fleet/ord-1/wo-1", title: "dry", body: "dry", token: fakeToken });
      checks7 = await readChecks({ repo: "acme/repo", ref: "abc123", token: fakeToken });
    } finally {
      console.log = realLog;
    }
    const tokenLeaked = captured.some((l) => l.includes(fakeToken)) || captured.some((l) => l.includes("Bearer " + fakeToken));
    const redactOk = !redactForLog(`auth=${fakeToken}`).includes(fakeToken);
    record("dry-run: openDraftPr/readChecks make no network call", pr7 === null && checks7.length === 0 && fetchCount === 0, `pr=${pr7} checks=${checks7.length} fetches=${fetchCount}`);
    record("token never logged (redaction holds)", !tokenLeaked && redactOk, tokenLeaked ? "FAKE TOKEN FOUND IN LOG OUTPUT" : "no token-shaped text in log lines");

    // ---- 8. shortSubject: short titles untouched, long ones cut ----------------
    const short8 = shortSubject("tiny title", 72);
    const long8 = "x".repeat(500);
    const cut8 = shortSubject(long8, 72);
    record("shortSubject leaves a short title unchanged", short8 === "tiny title", `-> "${short8}"`);
    record(
      "shortSubject cuts a 500-char title to at most 72",
      cut8.length <= 72 && cut8.endsWith("…") && long8.startsWith(cut8.slice(0, -1)),
      `len=${cut8.length} endsWithEllipsis=${cut8.endsWith("…")}`,
    );

    // ---- 9. currentBranch/checkoutBranch round-trip ---------------------------
    git(work, ["checkout", "--", "owned.txt"]); // drop check 6's deliberate dry-run change first
    const on9 = currentBranch(work);
    const sha9 = revParse(work, "HEAD");
    git(work, ["checkout", "--detach", sha9]);
    const detached9 = currentBranch(work);
    git(work, ["checkout", "fleet/ord-1/wo-1"]);
    checkoutBranch(work, "main");
    const after9 = currentBranch(work);
    record(
      'currentBranch reports the branch and "" when detached; checkoutBranch switches',
      on9 === "fleet/ord-1/wo-1" && detached9 === "" && after9 === "main",
      `on=${on9} detached="${detached9}" afterCheckoutBranch=${after9}`,
    );

    // ---- restore env and clean up --------------------------------------------
    delete process.env.FLEET_GITHUB;
    delete process.env.FLEET_GITHUB_DRY_RUN;
    fs.rmSync(tmp, { recursive: true, force: true });
  } finally {
    // Clean up even if an unexpected throw happened above.
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  }

  // ---- report ----------------------------------------------------------------
  let failures = 0;
  for (const r of rows) {
    if (!r.ok) failures++;
    console.log(`${r.ok ? "PASS" : "FAIL"} ${r.n}. ${r.name}${r.detail ? ` - ${r.detail}` : ""}`);
  }
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAIL`} (${rows.length} checks, fetches=${fetchCount})`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(`github-check crashed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exitCode = 1;
});
