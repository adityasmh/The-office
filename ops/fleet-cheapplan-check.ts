// ops/fleet-cheapplan-check.ts - CHEAPPLAN-OWNS acceptance (docs/ORDER_2026-10-06_cheapplan-owns.md).
//
// Self-contained: a throwaway repo dir and a throwaway COMPANY_ROOT, no server, no network, no
// model call, nothing spent. It proves the small-order (cheapPlan) path now carries real file
// ownership:
//   A. an order naming an existing file gets that file in `owns`; a missing path does not;
//   B. `.env`, `company/x.json`, `../outside.txt` and an absolute path are dropped even when
//      they exist (secrets, machine files and never-own folders too);
//   C. more than 10 qualifying paths returns exactly 10 (de-duplicated, forward slashes);
//   D. the cheap brief names the owned files, edits nothing else, and never mentions
//      AGENT_COORDINATION; an order with no derivable files says so plainly;
//   E. a planner-built (non-cheap) plan is byte-identical to the saved pre-change copy, so the
//      Claude planner path is untouched.
//
// Run: npx tsx ops/fleet-cheapplan-check.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cheapplan-owns-"));
const repoDir = path.join(tmp, "repo");
process.env.COMPANY_ROOT = path.join(tmp, "company");
process.env.FLEET_REPO = repoDir;
process.env.SLACK_BRIDGE = "0";
process.env.SLACK_SOCKET_MODE = "0";
delete process.env.MOCK_MODE;
process.env.CLAUDE_BIN = path.join(tmp, "no-such-claude.exe"); // any Claude attempt would fail loudly
fs.mkdirSync(process.env.COMPANY_ROOT, { recursive: true });

type FleetOrder = import("../src/company/fleet.js").FleetOrder;

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  console.log(`        ${detail}`);
  if (!ok) failures += 1;
}

/** Write a fixture inside the temp repo and return its absolute path. */
function write(rel: string, body = "// fixture\n"): string {
  const abs = path.join(repoDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
}

function order(id: string, text: string): FleetOrder {
  return { id, text, createdAt: "2026-10-06T00:00:00.000Z", updatedAt: "2026-10-06T00:00:00.000Z", status: "planning", workOrders: [], trace: [] };
}

/** The pre-change worker preamble, saved here as the copy the planner path must still match. */
const SAVED_PREAMBLE = [
  "Read docs/AGENT_COORDINATION.md first and obey the file ownership. Edit ONLY the files in your `owns` list.",
  "Never stop/restart the router on :8787 or start another server on the live company/ (test servers: SLACK_BRIDGE=0, other PORT, temp COMPANY_ROOT). Never print secrets.",
  "Run `npx tsc --noEmit` if you touched TypeScript.",
].join(" ");

async function main(): Promise<void> {
  // ── fixtures: every shape the rule must judge ──────────────────────────────
  write("src/app.ts");
  write("src/other.ts");
  write("docs/notes.md");
  write("public/v2/views/budget.js");
  write("ops/tool.ps1");
  write("secrets/.env", "SECRET=1\n");
  write("secrets/.env.local", "SECRET=1\n");
  write("secrets/.env.example", "SECRET=\n");
  write("secrets/private.pem", "key\n");
  write("company/x.json", "{}\n");
  write("logs/run.log", "log\n");
  write("node_modules/pkg/index.js");
  write(".git/config", "[core]\n");
  write("gen/f01.ts");
  for (let i = 2; i <= 12; i++) write(`gen/f${String(i).padStart(2, "0")}.ts`);
  fs.mkdirSync(tmp, { recursive: true });
  const outside = path.join(tmp, "outside.txt"); // "../outside.txt": exists, outside the repo
  fs.writeFileSync(outside, "outside\n");
  const absApp = path.join(repoDir, "src", "app.ts"); // an absolute path that exists

  const { cheapPlan, pathsNamedInOrder, briefBody } = await import("../src/company/fleet.js");
  console.log(`# fleet-cheapplan-check: repo ${repoDir}`);
  console.log(`# COMPANY_ROOT=${process.env.COMPANY_ROOT} | FLEET_REPO=${process.env.FLEET_REPO} | no network`);
  console.log("");

  // ── A. existing file kept, missing file not ───────────────────────────────
  console.log("=== A. THE ORDER NAMES FILES ===");
  const aText = "Please rename the heading in docs/notes.md and also touch gen/missing.ts which does not exist.";
  const aList = pathsNamedInOrder(aText, repoDir);
  const aPlan = cheapPlan(order("ORD-A", aText));
  const aOwns = aPlan.workOrders[0].owns;
  check(
    "an order naming an existing file gets it in owns; a path that does not exist is not included",
    aOwns.includes("docs/notes.md") && !aOwns.some((p) => /missing/.test(p)) && JSON.stringify(aOwns) === JSON.stringify(["docs/notes.md"]),
    `helper owns=[${aList.join(", ")}] | cheapPlan owns=[${aOwns.join(", ")}] (gen/missing.ts is on disk? ${fs.existsSync(path.join(repoDir, "gen/missing.ts"))})`,
  );

  // ── B. the shapes that must never be owned ────────────────────────────────
  console.log("");
  console.log("=== B. WHAT MUST NEVER BE OWNED (all of these exist except the absolute-path twin) ===");
  const bText = [
    "Update secrets/.env, secrets/.env.local, company/x.json, ../outside.txt,",
    `the file ${absApp}, logs/run.log, node_modules/pkg/index.js, .git/config,`,
    "secrets/private.pem, secrets/.env.example and src/other.ts.",
  ].join(" ");
  const bList = pathsNamedInOrder(bText, repoDir);
  const forbidden = (p: string) => {
    const base = p.slice(p.lastIndexOf("/") + 1).toLowerCase();
    if (base === ".env.example") return false; // the one allowed .env shape
    return /^\.env(\.|$)/.test(base) || /^company\//i.test(p) || p.includes("..") || /^[A-Za-z]:/.test(p) ||
      /^(logs|node_modules|\.git)\//i.test(p) || /\.(pem|key|log|pid)$/i.test(p);
  };
  const leaked = bList.filter(forbidden);
  check(
    "`.env`, `company/x.json`, `../outside.txt` and an absolute path are removed even when they exist or are named",
    !bList.includes("company/x.json") && !bList.includes("../outside.txt") &&
      !bList.some((p) => /\.env(\.|$)/.test(p) && p !== "secrets/.env.example") &&
      !bList.some((p) => /^[A-Za-z]:/.test(p)) && leaked.length === 0,
    `owns=[${bList.join(", ")}] | leaked=[${leaked.join(", ")}] | outside.txt exists=${fs.existsSync(outside)} | ${absApp} exists=${fs.existsSync(absApp)}`,
  );
  check(
    "the .env.example exception still works (it is a template, not a secret)",
    bList.includes("secrets/.env.example") && bList.includes("src/other.ts"),
    `owns=[${bList.join(", ")}]`,
  );

  // ── C. cap + de-dup + forward slashes ────────────────────────────────────
  console.log("");
  console.log("=== C. CAP, DE-DUP, NORMALISATION ===");
  const twelve = Array.from({ length: 12 }, (_, i) => `gen/f${String(i + 1).padStart(2, "0")}.ts`);
  const cList = pathsNamedInOrder(`Touch ${twelve.join(", ")} in one pass.`, repoDir);
  check("more than 10 qualifying paths returns exactly 10", cList.length === 10, `${twelve.length} named -> ${cList.length} owned: [${cList.join(", ")}]`);
  const dList = pathsNamedInOrder("Again: src/app.ts, src/app.ts, ./src/app.ts.", repoDir);
  const backList = pathsNamedInOrder("and src\\app.ts too", repoDir);
  check(
    "owned paths are de-duplicated and normalised to forward slashes",
    dList.length === 1 && dList[0] === "src/app.ts" && backList.length === 1 && backList[0] === "src/app.ts",
    `dedupe=[${dList.join(", ")}] | windows-style=[${backList.join(", ")}]`,
  );

  // ── D. the cheap brief ───────────────────────────────────────────────────
  console.log("");
  console.log("=== D. THE BRIEF CHEAPPLAN BUILDS ===");
  const dOwns = aPlan.workOrders[0].owns;
  const dBrief = aPlan.workOrders[0].brief;
  check(
    'the brief for an order with owned files contains the "ONLY these files" sentence and NOT `AGENT_COORDINATION`',
    dBrief.includes(`You may edit ONLY these files: ${dOwns.join(", ")}. Edit nothing else.`) &&
      dBrief.includes("This is a small order: make the edit, write REPORT.md, and stop.") &&
      !dBrief.includes("AGENT_COORDINATION"),
    `owns=[${dOwns.join(", ")}] | AGENT_COORDINATION present=${dBrief.includes("AGENT_COORDINATION")} | first line="${dBrief.split("\n")[0]}"`,
  );
  const ePlan = cheapPlan(order("ORD-E", "rename the 'Submit' label to 'Send' on the settings page"));
  const eWo = ePlan.workOrders[0];
  check(
    "the brief for an order with no derivable files says there is no ownership list and does not tell the worker to read the coordination file",
    eWo.owns.length === 0 &&
      /there is no file ownership list for this order\./.test(eWo.brief) &&
      /Do not search docs\/AGENT_COORDINATION\.md/.test(eWo.brief) &&
      !/read docs\/AGENT_COORDINATION/i.test(eWo.brief),
    `owns=[${eWo.owns.join(", ")}] | brief="${eWo.brief.split("\n\n")[0]}"`,
  );
  check(
    "the cheap brief keeps the REPORT.md acceptance checks",
    ePlan.workOrders[0].done.some((d) => /REPORT\.md exists/.test(d)) &&
      aPlan.workOrders[0].done.some((d) => /REPORT\.md exists/.test(d)),
    `done=[${aPlan.workOrders[0].done.join(" | ")}]`,
  );

  // ── E. the planner path is untouched (compare against a saved copy) ───────
  console.log("");
  console.log("=== E. A PLANNER-BUILT PLAN IS UNCHANGED (saved-copy comparison) ===");
  const pOrder = order("ORD-P", "this order was planned by Claude, not by cheapPlan");
  const pBrief = "planner brief: change the thing in src/app.ts";
  const pWo = { id: "WO-P", title: "planner work order", role: "coder", owns: ["src/app.ts"], brief: pBrief, done: ["the work is done"], state: "planned" as const, attempts: 0 };
  const savedPlannerBrief = [
    "FLEET-ORDER ORD-P/WO-P",
    "",
    SAVED_PREAMBLE,
    "",
    "ROLE: coder",
    "TITLE: planner work order",
    `REPO: ${repoDir}`,
    "",
    "YOU OWN (create/edit ONLY these paths):",
    "  - src/app.ts",
    "",
    "BRIEF:",
    pBrief,
    "",
    "DONE (acceptance checks - all of them):",
    "  - the work is done",
    "",
    `FINISH: write ${path.join(process.env.COMPANY_ROOT, "fleet", "ORD-P", "WO-P", "REPORT.md")} with (1) what changed, (2) the files you touched,`,
    "(3) the exact commands you ran and their REAL output, (4) open issues. Then stop.",
  ].join("\n");
  const gotPlannerBrief = briefBody(pOrder, pWo);
  const at = [...savedPlannerBrief].findIndex((c, i) => c !== gotPlannerBrief[i]);
  check(
    "a planner-built (non-cheap) plan is unchanged (its brief still contains whatever it contained before: this is the saved copy)",
    gotPlannerBrief === savedPlannerBrief &&
      gotPlannerBrief.includes(pBrief) &&
      gotPlannerBrief.includes("docs/AGENT_COORDINATION.md"),
    gotPlannerBrief === savedPlannerBrief
      ? `byte-identical to the saved copy (${gotPlannerBrief.length} chars); it still carries the coordination instruction as before`
      : `differs at char ${at}: saved=${JSON.stringify(savedPlannerBrief.slice(at, at + 40))} got=${JSON.stringify(gotPlannerBrief.slice(at, at + 40))}`,
  );

  console.log("");
  if (failures) {
    console.log(`CHEAPPLAN-OWNS CHECK FAILED: ${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log("CHEAPPLAN-OWNS CHECK ALL PASS");
  }
}

main().catch((e) => {
  console.error("fleet-cheapplan-check crashed:", e);
  process.exitCode = 1;
});
