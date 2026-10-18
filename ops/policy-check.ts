// ops/policy-check.ts - F10 PROOF (docs/overnight/ORDER_F10-policy-file.md).
//
// Self-contained: temp folders, a throwaway COMPANY_ROOT and throwaway git repos. No server,
// no network, no model call. Proves src/company/policy.ts and its two enforcement points:
//   A. the built-in defaults protect .env, .github/workflows/ci.yml, .git/config and a.pem
//      while leaving .env.example and src/a.ts alone;
//   B. the glob forms (*, **, ?, case-insensitive, basename-anywhere) behave;
//   C. a custom policy.json overrides the defaults (and a partial file defaults its gaps);
//   D. the owned-file derivation (ownablePaths + deriveOwns) drops protected paths;
//   E. the cheap-order derivation (pathsNamedInOrder) drops protected paths;
//   F. the publish step refuses a protected staged path, naming the path and the rule;
//   G. the publish step refuses a list longer than maxFilesPerWorkOrder;
//   H. a malformed policy.json falls back to the defaults with a warning.
//
// Run: npx tsx ops/policy-check.ts
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
function writeFile(root: string, rel: string, body = "// fixture\n"): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
}

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "policy-f10-"));
  const companyRoot = path.join(tmp, "company");
  const repo = path.join(tmp, "repo");
  const bare = path.join(tmp, "remote.git");

  // No real token, and the feature starts off: nothing may call out.
  delete process.env.GITHUB_TOKEN;
  delete process.env.FLEET_GITHUB;
  delete process.env.FLEET_GITHUB_DRY_RUN;

  // temp COMPANY_ROOT must be set BEFORE the module import (org.ts captures it at import time).
  process.env.COMPANY_ROOT = companyRoot;
  fs.mkdirSync(companyRoot, { recursive: true });

  // A small git repo on "main" with one commit and a LOCAL BARE remote (no network).
  fs.mkdirSync(repo);
  git(tmp, ["init", "--bare", bare]);
  git(repo, ["init"]);
  git(repo, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(repo, ["config", "user.email", "check@example.com"]);
  git(repo, ["config", "user.name", "Policy Check"]);
  fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  git(repo, ["add", "--", "seed.txt"]);
  git(repo, ["commit", "-m", "seed"]);
  git(repo, ["remote", "add", "origin", bare]);
  git(repo, ["push", "-u", "origin", "main"]);
  const head0 = git(repo, ["rev-parse", "HEAD"]).out.trim();
  const branches0 = git(repo, ["branch", "--list"]).out;

  const pol = await import("../src/company/policy.js");
  const fg = await import("../src/company/fleetGithub.js");
  const fleet = await import("../src/company/fleet.js");

  try {
    const defaults = pol.DEFAULT_POLICY;

    // ---- 1. defaults protect secrets, CI, .git and keys ----------------------
    {
      const must = [".env", ".github/workflows/ci.yml", ".git/config", "a.pem", "certs/server.key"];
      const ok = must.every((x) => pol.isProtected(x, defaults));
      record("1. defaults protect .env, .github/workflows/ci.yml, .git/config, a.pem and a .key", ok, `rules=${pol.DEFAULT_PROTECTED_PATHS.join(" | ")} -> ${must.map((x) => `${x}:${pol.isProtected(x, defaults)}`).join(" ")}`);
    }

    // ---- 2. defaults leave .env.example and src/a.ts editable ----------------
    {
      const free = [".env.example", "src/a.ts", "README.md"];
      const ok = free.every((x) => !pol.isProtected(x, defaults));
      const ex = pol.protectedRuleFor(".env.example", defaults);
      record("2. defaults leave .env.example and src/a.ts unprotected", ok, `${free.map((x) => `${x}:${pol.isProtected(x, defaults)}`).join(" ")} .env.example rule=${ex}`);
    }

    // ---- 3. the glob forms behave -------------------------------------------
    {
      const globPolicy = { protectedPaths: ["docs/**", "*.ts", "a?c.txt", "**/secret/**"], maxFilesPerWorkOrder: 5 };
      const cases: Array<[string, boolean]> = [
        ["docs/x/y.md", true],
        ["docs/readme.md", true],
        ["docs/sub/deep/file.ts", true],
        ["src/app.ts", true],
        ["abc.txt", true],
        ["ac.txt", false],
        ["a/c.txt", false],
        ["secret/x.txt", true],
        ["x/secret/y.txt", true],
        ["README.md", false],
      ];
      const wrong = cases.filter(([p, want]) => pol.isProtected(p, globPolicy) !== want);
      const caseOk = pol.isProtected("A.PEM", defaults) && pol.isProtected(".ENV", defaults) && pol.isProtected("docs\\x\\y.md", globPolicy);
      const ok = wrong.length === 0 && caseOk;
      record("3. glob forms: **, *, ?, basename-anywhere, case-insensitive, backslashes", ok, `wrong=${JSON.stringify(wrong)} caseInsensitive/backslash=${Boolean(caseOk)}`);
    }

    // ---- 4. a custom policy.json overrides; a partial one defaults its gaps ----
    {
      const customDir = path.join(tmp, "custom");
      writeFile(customDir, "policy.json", JSON.stringify({ protectedPaths: ["config/secrets/**"], maxFilesPerWorkOrder: 3 }));
      const custom = pol.loadPolicy(customDir);
      const customOk =
        pol.isProtected("config/secrets/x.json", custom) &&
        !pol.isProtected(".env", custom) &&
        !pol.isProtected("policy.json", custom) &&
        custom.maxFilesPerWorkOrder === 3;

      const partialDir = path.join(tmp, "partial");
      writeFile(partialDir, "policy.json", JSON.stringify({ maxFilesPerWorkOrder: 2 }));
      const partial = pol.loadPolicy(partialDir);
      const partialOk = partial.maxFilesPerWorkOrder === 2 && pol.isProtected(".env", partial) && JSON.stringify(partial.protectedPaths) === JSON.stringify(pol.DEFAULT_PROTECTED_PATHS);

      record("4. a custom policy.json overrides the defaults; a partial one fills the gaps", customOk && partialOk, `custom=${JSON.stringify(custom)} customOk=${customOk} partial=${JSON.stringify(partial)} partialOk=${partialOk}`);
    }

    // ---- 5. the owned-file derivation drops protected paths ------------------
    {
      const many = ["src/a.ts", "README.md", ".github/workflows/ci.yml", "policy.json", "a.pem", ".env", ".env.example"];
      const kept = fg.ownablePaths(many, pol.loadPolicy(repo));
      const ownableOk = JSON.stringify(kept) === JSON.stringify(["src/a.ts", "README.md", ".env.example"]);

      // deriveOwns: the changed-and-named files, with the protected one dropped.
      writeFile(repo, "src/a.ts");
      writeFile(repo, ".github/workflows/ci.yml", "name: ci\n");
      const wo = { id: "wo-derive", title: "derivation", role: "coder", owns: [], brief: "b", done: [], state: "planned", attempts: 0 };
      const report = "changed src/a.ts and .github/workflows/ci.yml";
      const derived = fg.deriveOwns(wo, repo, report);
      const deriveOk = JSON.stringify(derived.owns) === JSON.stringify(["src/a.ts"]);
      record("5. owned-file derivation drops the protected .github/workflows path", ownableOk && deriveOk, `ownablePaths=${JSON.stringify(kept)} deriveOwns.owns=${JSON.stringify(derived.owns)} why=${derived.why}`);
    }

    // ---- 6. the cheap-order derivation drops protected paths -----------------
    {
      const cheapDir = path.join(tmp, "cheap");
      writeFile(cheapDir, "src/a.ts");
      writeFile(cheapDir, ".github/workflows/ci.yml", "name: ci\n");
      writeFile(cheapDir, "policy.json", "{}");
      const text = "please edit .github/workflows/ci.yml, policy.json and src/a.ts";
      const owns = fleet.pathsNamedInOrder(text, cheapDir);
      const ok = JSON.stringify(owns) === JSON.stringify(["src/a.ts"]);
      record("6. pathsNamedInOrder drops .github/workflows and policy.json", ok, `owns=${JSON.stringify(owns)}`);
    }

    // ---- 7. the publish step refuses a protected staged path ----------------
    {
      process.env.FLEET_GITHUB = "1";
      process.env.FLEET_GITHUB_REPO = "example-org/example-repo";
      const wo = { id: "wo-ci", title: "edit CI", role: "coder", owns: [".github/workflows/ci.yml"], brief: "b", done: [], state: "reviewed", attempts: 0, verdict: "PASS" };
      const order = { id: "ord-ci", workOrders: [wo] } as unknown as import("../src/company/fleet.js").FleetOrder;
      const res = (await fg.publishWorkOrder(order, wo as never, repo)) as { skipped?: string };
      const reason = res.skipped ?? "";
      const head = git(repo, ["rev-parse", "HEAD"]).out.trim();
      const branches = git(repo, ["branch", "--list"]).out;
      const ok =
        reason.includes(".github/workflows/ci.yml") &&
        reason.includes(".github/workflows/**") &&
        /human/.test(reason) &&
        head === head0 &&
        branches === branches0;
      record("7. publish refuses a protected staged path, naming the path and the rule", ok, `reason=${JSON.stringify(reason)} headSame=${head === head0} branchesSame=${branches === branches0}`);
    }

    // ---- 8. the file-count limit refuses ------------------------------------
    {
      writeFile(repo, "policy.json", JSON.stringify({ protectedPaths: ["policy.json"], maxFilesPerWorkOrder: 2 }));
      const owns = ["a.txt", "b.txt", "c.txt"];
      for (const f of owns) writeFile(repo, f);
      const wo = { id: "wo-count", title: "too many", role: "coder", owns, brief: "b", done: [], state: "reviewed", attempts: 0, verdict: "PASS" };
      const order = { id: "ord-count", workOrders: [wo] } as unknown as import("../src/company/fleet.js").FleetOrder;
      const res = (await fg.publishWorkOrder(order, wo as never, repo)) as { skipped?: string };
      const reason = res.skipped ?? "";
      const head = git(repo, ["rev-parse", "HEAD"]).out.trim();
      const ok = reason.includes("maxFilesPerWorkOrder") && reason.includes("3") && head === head0;
      record("8. publish refuses more files than maxFilesPerWorkOrder", ok, `reason=${JSON.stringify(reason)} headSame=${head === head0}`);
      fs.rmSync(path.join(repo, "policy.json"), { force: true });
      delete process.env.FLEET_GITHUB;
      delete process.env.FLEET_GITHUB_REPO;
    }

    // ---- 9. a malformed policy.json falls back to the defaults with a warning ----
    {
      const badDir = path.join(tmp, "bad");
      writeFile(badDir, "policy.json", "{ this is not json");
      const warnings: string[] = [];
      const realWarn = console.warn;
      console.warn = (...a: unknown[]) => { warnings.push(a.map((v) => String(v)).join(" ")); };
      let got: unknown = null;
      try {
        got = pol.loadPolicy(badDir);
      } finally {
        console.warn = realWarn;
      }
      const okShape = JSON.stringify(got) === JSON.stringify(pol.DEFAULT_POLICY);
      const warned = warnings.some((w) => /malformed/.test(w) && /default/i.test(w));
      record("9. a malformed policy.json falls back to the defaults with a warning", okShape && warned, `defaults=${okShape} warned=${warned} warning=${JSON.stringify(warnings[0] ?? "")}`);
    }

    // ---- 10. a missing policy.json uses the defaults silently ----------------
    {
      const emptyDir = path.join(tmp, "none");
      fs.mkdirSync(emptyDir, { recursive: true });
      const warnings: string[] = [];
      const realWarn = console.warn;
      console.warn = (...a: unknown[]) => { warnings.push(a.map((v) => String(v)).join(" ")); };
      let got: unknown = null;
      try {
        got = pol.loadPolicy(emptyDir);
      } finally {
        console.warn = realWarn;
      }
      const ok = JSON.stringify(got) === JSON.stringify(pol.DEFAULT_POLICY) && warnings.length === 0;
      record("10. a missing policy.json uses the defaults without a warning", ok, `defaults=${JSON.stringify(got) === JSON.stringify(pol.DEFAULT_POLICY)} warnings=${warnings.length}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  for (const r of rows) {
    console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name} - ${r.detail}`);
  }
  const allOk = rows.every((r) => r.ok) && fetchCount === 0;
  console.log(`\n${allOk ? "ALL PASS" : "FAIL"} (${rows.filter((r) => r.ok).length}/${rows.length} checks, fetches=${fetchCount})`);
  process.exitCode = allOk ? 0 : 1;
}

main().catch((e) => {
  console.error(`harness crashed: ${errText(e)}`);
  process.exitCode = 1;
});
