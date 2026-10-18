// ops/budget-brain-proof.ts - Job 1 acceptance (docs/CHEAP_BY_DEFAULT_SPEC.md):
// "10 test orders: small ones make ZERO Claude calls; big ones still get a Claude
// plan + review. An order containing 'use Claude' always reaches Claude."
//
//   set COMPANY_ROOT=%TEMP%\budget-verify\company    (a test root: the decision log
//   npx tsx ops/budget-brain-proof.ts                 must not pollute the live one)
//
// Real text comes from the company root (no invented "real" data):
//   company/projects/<id>/tasks.json  -> task records, field `rawRequest`
//   company/fleet/orders.json         -> fleet order briefs
// The three spec fixtures (rename a label / fix a typo / a status question) are
// labelled as fixtures, because the acceptance names them.

import fs from "node:fs";
import path from "node:path";
import { getCompanyRoot } from "../src/company/org.js";
import { brainStats, brainThresholds, cheapModel, pickBrain, resolveBrainModel, type BrainPurpose } from "../src/company/brainRouter.js";
import { config } from "../src/config.js";

type Row = { source: string; text: string; purpose: BrainPurpose; ceiling: string };

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function realRows(): Row[] {
  const root = getCompanyRoot();
  const rows: Row[] = [];
  const projectsDir = path.join(root, "projects");
  let projects: string[] = [];
  try {
    projects = fs.readdirSync(projectsDir);
  } catch {
    projects = [];
  }
  for (const pid of projects) {
    const tasks = readJson<Array<{ rawRequest?: string }> | { tasks?: Array<{ rawRequest?: string }> }>(path.join(projectsDir, pid, "tasks.json"));
    const list = Array.isArray(tasks) ? tasks : (tasks?.tasks ?? []);
    for (const t of list) {
      const text = String(t.rawRequest ?? "").trim();
      if (text.length > 40) rows.push({ source: `task ${pid}`, text, purpose: "plan", ceiling: config.claudeOpus });
    }
  }
  const orders = readJson<Array<{ title?: string; brief?: string; text?: string }> | { orders?: Array<{ title?: string; brief?: string; text?: string }> }>(
    path.join(root, "fleet", "orders.json"),
  );
  const orderList = Array.isArray(orders) ? orders : (orders?.orders ?? []);
  for (const o of orderList) {
    const text = String(o.brief ?? o.text ?? o.title ?? "").trim();
    if (text.length > 40) rows.push({ source: "fleet order", text, purpose: "fleet-plan", ceiling: config.claudeOpus });
  }
  return rows;
}

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  console.log(`        ${detail}`);
  if (!ok) failures += 1;
}

async function show(i: number, r: Row): Promise<{ tier: string; claudeCall: boolean }> {
  const pick = await pickBrain({ purpose: r.purpose, text: r.text, needsFiles: true });
  const resolved = resolveBrainModel(pick, r.ceiling, r.purpose);
  const head = r.text.replace(/\s+/g, " ").slice(0, 66);
  console.log(
    `${String(i).padStart(2)}. [${r.purpose}] ${pick.reasonKind}  Laya top=${pick.laya.top === undefined ? "n/a" : pick.laya.top.toFixed(2)}` +
      ` lead=${pick.laya.lead === undefined ? "n/a" : pick.laya.lead.toFixed(2)} ${pick.laya.predicted ?? ""}` +
      ` ${pick.laya.ms ?? 0}ms -> ${resolved.tier} (${resolved.model}) claudeCall=${pick.claudeCall}` +
      (pick.fileBlind ? " FILE-BLIND" : ""),
  );
  console.log(`    "${head}..."`);
  console.log(`    why: ${pick.reason}${resolved.changed.length ? ` | ${resolved.changed.join(" | ")}` : ""}`);
  return { tier: resolved.tier, claudeCall: pick.claudeCall };
}

async function main(): Promise<void> {
  const root = getCompanyRoot();
  const th = brainThresholds();
  const rows = realRows();
  console.log("BRAIN GATE PROOF - Job 1 acceptance (docs/CHEAP_BY_DEFAULT_SPEC.md)");
  console.log("==================================================================");
  console.log(`company root: ${root}${path.resolve(root) === path.resolve(process.cwd(), "company") ? "  ** LIVE ROOT: the decision log will land in the live folder **" : "  (test root)"}`);
  console.log(`Laya: ${config.decisionBaseUrl} deadline ${th.layaMs} ms · gate: top >= ${th.bigP} and lead >= ${th.bigLead} -> big`);
  console.log(`tiers: none = ${cheapModel()} (no Claude) | sonnet = ${config.claudeSonnet} | opus = ${config.claudeOpus}`);
  console.log("");

  // 1. ten REAL orders, each with its real purpose.
  const sample = rows.slice(0, 10);
  console.log("=== 1. TEN REAL PAST ORDERS ===");
  let claudeCalls = 0;
  let avoided = 0;
  for (const [i, r] of sample.entries()) {
    const out = await show(i + 1, r);
    if (out.claudeCall) claudeCalls += 1;
    else avoided += 1;
  }
  console.log("");
  // Honest check: this row is evidence only if Laya really answered. With Laya down
  // every row is a fallback row, and the proof must SAY so instead of passing.
  const answered = brainStats().layaAnswered;
  check(
    "the ten real orders were classified by Laya (not fallback rows)",
    answered >= sample.length,
    `${sample.length} real orders, ${avoided} avoided Claude, ${claudeCalls} used it; Laya answered ${answered} decisions in total` +
      (answered < sample.length ? " -> LAYA IS DOWN: these rows are the fallback rule, re-run when Laya answers" : ""),
  );

  // 2. the spec's three small fixtures must produce ZERO Claude calls.
  console.log("");
  console.log("=== 2. THE SPEC'S SMALL FIXTURES (must be zero Claude) ===");
  const smalls: Row[] = [
    { source: "fixture", text: "Rename the label 'Projects' to 'Work' on the dashboard.", purpose: "plan", ceiling: config.claudeOpus },
    { source: "fixture", text: "Fix a typo in docs/README.md: 'recieve' -> 'receive'.", purpose: "plan", ceiling: config.claudeOpus },
    { source: "fixture", text: "What is the status of the fleet orders right now?", purpose: "chat", ceiling: config.claudeSonnet },
  ];
  let smallClaudeCalls = 0;
  for (const [i, r] of smalls.entries()) {
    const out = await show(i + 1, r);
    if (out.claudeCall) smallClaudeCalls += 1;
  }
  check("small fixtures make ZERO Claude calls", smallClaudeCalls === 0, `${smallClaudeCalls} of ${smalls.length} touched Claude`);

  // 3. "use Claude" in the order must always reach Claude.
  console.log("");
  console.log("=== 3. CEO NAMING CLAUDE (must always reach Claude) ===");
  const namedRows: Row[] = [
    { source: "fixture", text: "Fix a typo in docs/README.md - use Claude for the review.", purpose: "review", ceiling: config.claudeOpus },
    { source: "fixture", text: "Rename the label 'Projects' to 'Work'; have opus review it.", purpose: "review", ceiling: config.claudeOpus },
  ];
  const namedTiers: string[] = [];
  for (const [i, r] of namedRows.entries()) {
    const pick = await pickBrain({ purpose: r.purpose, text: r.text, needsFiles: true });
    const resolved = resolveBrainModel(pick, r.ceiling, r.purpose);
    namedTiers.push(resolved.tier);
    console.log(`${i + 1}. [${r.purpose}] ${pick.reasonKind} -> ${resolved.tier} (${resolved.model}) - ${pick.reason}`);
  }
  check(
    "an order containing 'use Claude' reaches Claude (sonnet)",
    namedTiers[0] === "sonnet",
    `tier=${namedTiers[0]}`,
  );
  check(
    "an order naming opus gets opus where the purpose allows it",
    namedTiers[1] === "opus",
    `tier=${namedTiers[1]}`,
  );

  // 4. the two plain rules: 2nd REDO on a review, and the twice-failed safety net.
  console.log("");
  console.log("=== 4. PLAIN RULES (hard rule + safety net) ===");
  const smallText = "Fix a typo in docs/README.md: 'recieve' -> 'receive'.";
  const redo = await pickBrain({ purpose: "review", text: smallText, needsFiles: true, hardRule: "redo2" });
  const net = await pickBrain({ purpose: "plan", text: smallText, needsFiles: true, cheapFailures: 2 });
  console.log(`2nd REDO on a review -> ${redo.tier} (${redo.model}) - ${redo.reason}`);
  console.log(`small task after 2 cheap failures -> ${net.tier} (${net.model}) - ${net.reason}`);
  check("a 2nd REDO takes the top tier for a review", redo.tier === "opus", `tier=${redo.tier}`);
  check("the safety net climbs a twice-failed small task to one Sonnet attempt", net.tier === "sonnet" && net.climbed, `tier=${net.tier} climbed=${net.climbed}`);

  const stats = brainStats();
  console.log("");
  console.log(
    `decision log today: ${stats.calls} entries | byTier ${JSON.stringify(stats.byTier)} | byReason ${JSON.stringify(stats.byReason)} | ` +
      `claudeCalls ${stats.claudeCalls}, Claude avoided ${stats.claudeAvoided}, opus avoided ${stats.opusAvoided}, ` +
      `file-blind ${stats.fileBlind}, climbed ${stats.climbed}, Laya down ${stats.layaDown}, ` +
      `Laya answered ${stats.layaAnswered}/failed ${stats.layaFailed}, median ${stats.medianMs} ms`,
  );
  console.log("");
  if (failures > 0) {
    console.log(`BRAIN GATE PROOF FAILED: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("BRAIN GATE PROOF ALL PASS");
}

main().catch((e) => {
  console.error("brain proof crashed:", String(e));
  process.exit(1);
});
