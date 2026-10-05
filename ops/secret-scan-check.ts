#!/usr/bin/env node
/**
 * ops/secret-scan-check.ts - the proof for ops/secret-scan.ts and ops/install-hooks.ts.
 *
 *   npx tsx ops/secret-scan-check.ts
 *
 * One PASS or FAIL line per check, then a summary. Exits 1 if anything FAILed.
 * Everything runs against temporary git repositories under the OS temp dir, so
 * the real repository is never scanned and no real secret is ever read. Every
 * fake credential is assembled from pieces at runtime, which also proves that
 * these three source files are not flagged by the scanner itself.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOOK_MARKER, hookScript, installHooks, uninstallHooks } from "./install-hooks.js";
import {
  exitCodeFor,
  expandPaths,
  listAllFiles,
  listStaged,
  loadAllow,
  parseAllow,
  renderJson,
  renderText,
  scanContent,
  scanPaths,
  scanStaged,
  type Finding,
} from "./secret-scan.js";

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HARNESS_DIR, "..");
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SCAN_TS = path.join(REPO_ROOT, "ops", "secret-scan.ts");
const HOOKS_TS = path.join(REPO_ROOT, "ops", "install-hooks.ts");
const SELF_SOURCES = ["ops/secret-scan.ts", "ops/install-hooks.ts", "ops/secret-scan-check.ts"];

// ---- fake credentials, built at runtime from pieces so nothing here is a literal ----
const P = (...parts: string[]): string => parts.join("");
const FAKE_OPENAI = P("sk", "-", "proj", "-", "T3stAbCdEf0123456789XyZ");
const FAKE_GITHUB = P("gh", "p", "_", "A1b2C3d4E5f6G7h8I9j0K1l2");
const FAKE_AWS = P("AK", "IA", "0123456789ABCDEF");
const FAKE_GOOGLE = P("AI", "za", "SyD9", "_fake", "0123456789", "AbCdEfGhIjKlMnOp");
const FAKE_PRIVATE = P("-----BEGIN ", "RSA PRIVATE", " KEY-----");
const FAKE_ASSIGN = P("Zq7", "pLm2Xr9", "TuvWx4Yz8", "Q1sT");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? `  -> ${detail}` : ""}`);
}

const tempDirs: string[] = [];
function mkdir(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function write(root: string, rel: string, text: string): void {
  const file = path.join(root, rel);
  mkdir(path.dirname(file));
  fs.writeFileSync(file, text, "utf8");
}
function git(root: string, args: string[]): string {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || "").trim()}`);
  return r.stdout;
}
function mkrepo(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `secret-scan-check-${tag}-`));
  tempDirs.push(dir);
  git(dir, ["init", "-q"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  git(dir, ["config", "user.email", "check@example.invalid"]);
  git(dir, ["config", "user.name", "Secret Scan Check"]);
  return dir;
}
function runTs(script: string, args: string[], cwd: string) {
  return spawnSync(process.execPath, [TSX_CLI, script, ...args], { cwd, encoding: "utf8" });
}
function byRule(findings: Finding[], rule: string): Finding[] {
  return findings.filter((f) => f.rule === rule);
}

function scannerChecks(): void {
  // ---- staged detection, masking, allow-list ---------------------------------
  const repo = mkrepo("staged");
  write(repo, "app.ts", `export const openaiKey = "${FAKE_OPENAI}";\n`);
  git(repo, ["add", "app.ts"]);
  const staged = scanStaged(repo, loadAllow(repo));
  const openai = byRule(staged.findings, "openai-key");
  check(
    "a staged fake key is detected",
    openai.length === 1 && openai[0].file === "app.ts" && openai[0].line === 1,
    `findings=${JSON.stringify(openai)}`,
  );
  check(
    "the hit carries the rule name and masks to the first four characters",
    openai.length === 1 && openai[0].masked === FAKE_OPENAI.slice(0, 4) && openai[0].masked.length === 4,
    `masked=${openai[0]?.masked}`,
  );
  const text = renderText(staged);
  check(
    "the rendered line never contains the full value",
    text.length > 0 && !text.includes(FAKE_OPENAI) && text.includes("openai-key"),
    text,
  );
  check(
    "exit code is 1 on a hit and 0 on a clean result",
    exitCodeFor(staged) === 1 && exitCodeFor({ findings: [], scanned: 1, skipped: [] }) === 0,
    `hit=${exitCodeFor(staged)}`,
  );
  const parsed = JSON.parse(renderJson(staged)) as { findings: Finding[]; ok: boolean };
  check(
    "JSON output parses to findings plus an ok flag and leaks no value",
    parsed.ok === false &&
      parsed.findings.length === 1 &&
      !renderJson(staged).includes(FAKE_OPENAI),
    `ok=${parsed.ok}; findings=${parsed.findings.length}`,
  );

  // allow-list: the openai value passes, an uncovered key is still reported
  write(repo, ".secretscan-allow", `# one value regex per line\n\n${FAKE_OPENAI}\n`);
  const allowedStaged = scanStaged(repo, loadAllow(repo));
  check(
    "an allow-listed value passes",
    byRule(allowedStaged.findings, "openai-key").length === 0,
    `findings=${JSON.stringify(allowedStaged.findings)}`,
  );
  write(repo, "other.ts", `const gh = "${FAKE_GITHUB}";\n`);
  git(repo, ["add", "other.ts"]);
  const mixed = scanStaged(repo, loadAllow(repo));
  check(
    "a key that is not allow-listed is still reported",
    byRule(mixed.findings, "github-token").length === 1 &&
      mixed.findings.length === 1,
    `findings=${JSON.stringify(mixed.findings.map((f) => f.rule))}`,
  );
  const entries = parseAllow("# c\n\n  \nfoo/*.ts\n");
  check(
    "allow-file comments and blank lines are ignored, globs are kept",
    entries.length === 1 && entries[0].glob.test("foo/a.ts") && !entries[0].glob.test("bar/a.ts"),
    `entries=${entries.length}`,
  );

  // ---- clean file -------------------------------------------------------------
  const cleanRepo = mkrepo("clean");
  write(cleanRepo, "clean.ts", "export const answer = 42;\n");
  const clean = scanPaths(cleanRepo, ["clean.ts"]);
  check(
    "a clean file passes",
    clean.findings.length === 0 && clean.scanned === 1,
    `scanned=${clean.scanned}`,
  );

  // ---- assignment rule and *.example ----------------------------------------
  const assignRepo = mkrepo("assign");
  write(assignRepo, "config.env", `DB_PASSWORD = "${FAKE_ASSIGN}"\n`);
  const assignHit = scanPaths(assignRepo, ["config.env"]);
  check(
    "an assignment-shaped secret in a normal file is detected",
    byRule(assignHit.findings, "assignment").length === 1 &&
      byRule(assignHit.findings, "assignment")[0].masked === FAKE_ASSIGN.slice(0, 4),
    `masked=${byRule(assignHit.findings, "assignment")[0]?.masked}`,
  );
  write(assignRepo, "config.env.example", `DB_PASSWORD = "${FAKE_ASSIGN}"\n`);
  const example = scanPaths(assignRepo, ["config.env.example"]);
  check(
    "*.example files are ignored for assignment rules",
    example.findings.length === 0,
    `findings=${JSON.stringify(example.findings)}`,
  );
  write(assignRepo, "notes.example", `${FAKE_OPENAI}\n`);
  const exampleKey = scanPaths(assignRepo, ["notes.example"]);
  check(
    "a real key shape in a *.example file is still detected",
    byRule(exampleKey.findings, "openai-key").length === 1,
    `findings=${JSON.stringify(exampleKey.findings.map((f) => f.rule))}`,
  );

  // ---- other rule shapes -----------------------------------------------------
  const shapeRepo = mkrepo("shapes");
  write(
    shapeRepo,
    "shapes.txt",
    [FAKE_OPENAI, FAKE_GITHUB, FAKE_AWS, FAKE_GOOGLE, FAKE_PRIVATE].join("\n") + "\n",
  );
  const shapes = scanPaths(shapeRepo, ["shapes.txt"]);
  const names = shapes.findings.map((f) => f.rule).sort();
  check(
    "OpenAI, GitHub, AWS, Google and private-key shapes are all detected",
    names.join(",") === "aws-access-key-id,github-token,google-api-key,openai-key,private-key",
    names.join(","),
  );
  check(
    "no finding ever carries more than the four masked characters",
    shapes.findings.every((f) => f.masked.length === 4) && !renderText(shapes).includes(FAKE_AWS),
    `masks=${shapes.findings.map((f) => f.masked).join(" ")}`,
  );

  // ---- skips: binary, node_modules, .git ------------------------------------
  const walkRepo = mkrepo("walk");
  write(walkRepo, "dirty.ts", `const gh = "${FAKE_GITHUB}";\n`);
  write(walkRepo, "clean.ts", "export const n = 1;\n");
  write(walkRepo, "node_modules/dep/index.js", `module.exports = "${FAKE_OPENAI}";\n`);
  fs.writeFileSync(path.join(walkRepo, "blob.bin"), Buffer.concat([
    Buffer.from("binary\u0000data ", "utf8"),
    Buffer.from(FAKE_OPENAI, "utf8"),
    Buffer.from("\n", "utf8"),
  ]));
  const walked = listAllFiles(walkRepo).join(",");
  check(
    "node_modules/ and .git/ are not walked",
    !walked.includes("node_modules") && !walked.includes(".git/") && walked.includes("dirty.ts"),
    walked,
  );
  const walkScan = scanPaths(walkRepo, listAllFiles(walkRepo));
  check(
    "a binary file is skipped rather than scanned",
    walkScan.skipped.includes("blob.bin") && !renderText(walkScan).includes("blob.bin"),
    `skipped=${walkScan.skipped.join(",")}`,
  );
  check(
    "the walk finds exactly the one real hit outside those folders",
    walkScan.findings.length === 1 && walkScan.findings[0].file === "dirty.ts",
    `findings=${JSON.stringify(walkScan.findings.map((f) => `${f.file}:${f.rule}`))}`,
  );
  const expanded = expandPaths(walkRepo, ["node_modules"]);
  check(
    "expanding a skipped folder yields nothing",
    expanded.length === 0,
    `expanded=${expanded.length}`,
  );

  // ---- self-scan -------------------------------------------------------------
  const selfFindings = SELF_SOURCES.flatMap((rel) =>
    scanContent(rel, fs.readFileSync(path.join(REPO_ROOT, rel), "utf8")),
  );
  check(
    "the scanner, the installer and this harness are not flagged by the scanner",
    selfFindings.length === 0,
    `findings=${JSON.stringify(selfFindings)}`,
  );
}

function hookChecks(): void {
  const repo = mkrepo("hooks");
  const gitDir = git(repo, ["rev-parse", "--absolute-git-dir"]).trim();
  const first = installHooks(gitDir);
  const preCommit = path.join(gitDir, "hooks", "pre-commit");
  const prePush = path.join(gitDir, "hooks", "pre-push");
  const text = fs.readFileSync(preCommit, "utf8");
  check(
    "both hooks install and report installed",
    first.map((o) => `${o.hook}:${o.status}`).join(",") === "pre-commit:installed,pre-push:installed" &&
      fs.existsSync(preCommit) && fs.existsSync(prePush),
    first.map((o) => `${o.hook}:${o.status}`).join(","),
  );
  check(
    "each hook carries the marker and runs the scanner on the staged files",
    text.includes(HOOK_MARKER) &&
      text.includes("npx tsx ops/secret-scan.ts --staged") &&
      text.startsWith("#!/bin/sh") &&
      hookScript("pre-commit").includes(HOOK_MARKER),
    `first line=${text.split("\n")[0]}`,
  );
  check(
    "the hook script is bare POSIX sh (no bashisms)",
    !/\bbash\b|\[\[|\bfunction\b/.test(text),
    `bytes=${text.length}`,
  );
  const second = installHooks(gitDir);
  check(
    "installing twice is idempotent",
    second.every((o) => o.status === "unchanged") &&
      fs.readFileSync(preCommit, "utf8") === text,
    second.map((o) => `${o.hook}:${o.status}`).join(","),
  );
  const foreignText = "#!/bin/sh\necho team hook\n";
  fs.writeFileSync(preCommit, foreignText, "utf8");
  const skipped = installHooks(gitDir);
  check(
    "a foreign hook is not clobbered without --force",
    skipped.find((o) => o.hook === "pre-commit")?.status === "skipped-foreign" &&
      fs.readFileSync(preCommit, "utf8") === foreignText,
    skipped.map((o) => `${o.hook}:${o.status}`).join(","),
  );
  const forced = installHooks(gitDir, { force: true });
  check(
    "--force replaces a foreign hook with ours",
    forced.find((o) => o.hook === "pre-commit")?.status === "updated" &&
      fs.readFileSync(preCommit, "utf8").includes(HOOK_MARKER),
    forced.map((o) => `${o.hook}:${o.status}`).join(","),
  );
  // a foreign pre-push must survive an uninstall of our pre-commit
  fs.writeFileSync(prePush, foreignText, "utf8");
  const removed = uninstallHooks(gitDir);
  check(
    "--uninstall removes only the hooks it wrote",
    removed.find((o) => o.hook === "pre-commit")?.status === "removed" &&
      removed.find((o) => o.hook === "pre-push")?.status === "skipped-foreign" &&
      !fs.existsSync(preCommit) &&
      fs.readFileSync(prePush, "utf8") === foreignText,
    removed.map((o) => `${o.hook}:${o.status}`).join(","),
  );
  const empty = uninstallHooks(gitDir);
  check(
    "--uninstall is a no-op when there is no hook to remove",
    empty.find((o) => o.hook === "pre-commit")?.status === "absent",
    empty.map((o) => `${o.hook}:${o.status}`).join(","),
  );
}

function cliChecks(): void {
  const repo = mkrepo("cli");
  write(repo, "app.ts", `export const openaiKey = "${FAKE_OPENAI}";\n`);
  git(repo, ["add", "app.ts"]);
  const hit = runTs(SCAN_TS, ["--staged", "--json"], repo);
  let hitJson: { findings: Finding[]; ok: boolean } | null = null;
  try {
    hitJson = JSON.parse(hit.stdout) as { findings: Finding[]; ok: boolean };
  } catch {
    hitJson = null;
  }
  check(
    "CLI --staged --json detects a staged key and exits 1",
    hit.status === 1 && hitJson !== null && hitJson.findings.length === 1 && hitJson.ok === false,
    `exit=${hit.status}; findings=${hitJson?.findings.length}`,
  );
  check(
    "CLI --staged --json masks the value in its output",
    hit.stdout.includes(FAKE_OPENAI.slice(0, 4)) && !hit.stdout.includes(FAKE_OPENAI),
    `masked=${hitJson?.findings[0]?.masked}`,
  );
  const stagedList = listStaged(repo);
  check(
    "the staged file list comes from the git index",
    stagedList.length === 1 && stagedList[0] === "app.ts",
    `staged=${stagedList.join(",")}`,
  );

  const cleanRepo = mkrepo("cli-clean");
  write(cleanRepo, "clean.ts", "export const ok = true;\n");
  git(cleanRepo, ["add", "clean.ts"]);
  const clean = runTs(SCAN_TS, ["--staged", "--json"], cleanRepo);
  check(
    "CLI exits 0 on a clean staged tree",
    clean.status === 0 && JSON.parse(clean.stdout).ok === true,
    `exit=${clean.status}`,
  );
  const all = runTs(SCAN_TS, ["--all", "--json"], repo);
  check(
    "CLI --all scans the worktree and exits 1 on the one hit",
    all.status === 1 && JSON.parse(all.stdout).findings.length === 1,
    `exit=${all.status}`,
  );
  const help = runTs(SCAN_TS, ["--help"], repo);
  check(
    "CLI --help prints usage and exits 0",
    help.status === 0 && help.stdout.includes("secret-scan.ts"),
    `exit=${help.status}`,
  );
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "secret-scan-check-norepo-"));
  tempDirs.push(outside);
  const bare = runTs(SCAN_TS, ["--staged"], outside);
  check(
    "CLI --staged outside a git repo fails loudly (exit 2) instead of passing",
    bare.status === 2 && /not a git repo/.test(bare.stderr),
    `exit=${bare.status}; stderr=${(bare.stderr || "").trim().slice(0, 60)}`,
  );

  const hookRepo = mkrepo("cli-hooks");
  const installed = runTs(HOOKS_TS, [], hookRepo);
  check(
    "CLI install-hooks installs both hooks in the working directory's repo",
    installed.status === 0 &&
      /installed/.test(installed.stdout) &&
      /pre-commit/.test(installed.stdout) &&
      /pre-push/.test(installed.stdout),
    installed.stdout.trim().replace(/\s+/g, " "),
  );
  const foreignRepo = mkrepo("cli-hooks-force");
  const gitDir = git(foreignRepo, ["rev-parse", "--absolute-git-dir"]).trim();
  fs.writeFileSync(path.join(gitDir, "hooks", "pre-commit"), "#!/bin/sh\necho mine\n", "utf8");
  const blocked = runTs(HOOKS_TS, [], foreignRepo);
  const replaced = runTs(HOOKS_TS, ["--force"], foreignRepo);
  check(
    "CLI refuses a foreign hook and --force replaces it",
    /skipped-foreign/.test(blocked.stdout) && /updated/.test(replaced.stdout),
    `before=${blocked.stdout.trim().split(/\r?\n/)[0]}; after=${replaced.stdout.trim().split(/\r?\n/)[0]}`,
  );
  const uninstalled = runTs(HOOKS_TS, ["--uninstall"], hookRepo);
  check(
    "CLI --uninstall removes the hooks it installed",
    uninstalled.status === 0 && /removed/.test(uninstalled.stdout),
    uninstalled.stdout.trim().replace(/\s+/g, " "),
  );
}

function main(): void {
  try {
    scannerChecks();
    hookChecks();
    cliChecks();
  } finally {
    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort; a locked temp folder is not a test failure
      }
    }
  }
  if (failures > 0) {
    console.log(`secret-scan-check: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("secret-scan-check: all checks passed");
}

main();
