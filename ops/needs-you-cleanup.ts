// NY-CLEANUP data-side cleanup script.
// Reads live company/ files at the repo root, applies the 6 closures/approvals
// from the CEO order, writes atomically, and validates JSON.
//
// Usage: npx tsx ops/needs-you-cleanup.ts

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { approveGate, getTask, updateTask } from "../src/company/gates.js";
import { resumeTask } from "../src/company/pipeline.js";
import { composeBriefing } from "../src/company/briefing.js";
import { listRunCards } from "../src/company/runManagers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function atomicWriteJson(filePath: string, data: unknown): void {
  const tmpPath = `${filePath}.tmp-${Date.now()}`;
  const text = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmpPath, text, "utf8");
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err: any) {
    // Windows fs.renameSync does not replace an existing file.
    if (err?.code === "EEXIST") {
      fs.unlinkSync(filePath);
      fs.renameSync(tmpPath, filePath);
    } else {
      // Clean up the temp file on any other error, then rethrow.
      try { fs.unlinkSync(tmpPath); } catch {}
      throw err;
    }
  }
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function validateJson(filePath: string): void {
  JSON.parse(fs.readFileSync(filePath, "utf8"));
}

const nowIso = new Date().toISOString();
const closedBy = "ceo-order";

const needsYouIds = new Set([
  "task:pmumhp51x:tmumi7iz3",
  "task:pmumhg71w:tmumhg72u",
  "fleet:fomumvpd3d",
  "fleet:fomumvo4sg",
  "fleet:fomumvmg57",
  "task:pmumhp51r:tmumjkfgo",
]);

// ---------------------------------------------------------------------------
// 1. QA README comment plan: record hidden-comment choice, approve merge gate.
// ---------------------------------------------------------------------------
{
  const projectId = "pmumhp51x";
  const taskId = "tmumi7iz3";
  const t = getTask(projectId, taskId);
  if (!t) {
    console.log(`[SKIP] ${taskId}: task not found`);
  } else if (t.status !== "pending_merge") {
    console.log(`[SKIP] ${taskId}: status is already ${t.status}`);
  } else {
    const chosenComment =
      "<!-- QA & Verification project (pmumhp51x) — README for the dept-report script. -->";
    const decisionNote =
      `CEO decision: approve the recommended HIDDEN HTML comment.\nChosen comment: ${chosenComment}`;
    const plan = t.plan ? `${t.plan}\n\n${decisionNote}` : decisionNote;
    updateTask(projectId, taskId, { plan });
    approveGate(projectId, taskId, "merge");
    const resumed = resumeTask(projectId, taskId, "gate");
    const after = getTask(projectId, taskId);
    console.log(`[DONE] ${taskId}: status=${after?.status}, resumed=${resumed}`);
  }
}

// ---------------------------------------------------------------------------
// 2. LiveFinal hello.txt: approve intake gate and resume.
// ---------------------------------------------------------------------------
{
  const projectId = "pmumhg71w";
  const taskId = "tmumhg72u";
  const t = getTask(projectId, taskId);
  if (!t) {
    console.log(`[SKIP] ${taskId}: task not found`);
  } else if (t.status !== "pending_intake") {
    console.log(`[SKIP] ${taskId}: status is already ${t.status}`);
  } else {
    approveGate(projectId, taskId, "intake");
    const resumed = resumeTask(projectId, taskId, "gate");
    const after = getTask(projectId, taskId);
    console.log(`[DONE] ${taskId}: status=${after?.status}, resumed=${resumed}`);
  }
}

// ---------------------------------------------------------------------------
// 3-5. Fleet orders: mark the 3 old voice orders as superseded by fomumvtp5p.
// ---------------------------------------------------------------------------
{
  const ordersPath = path.join(repoRoot, "company", "fleet", "orders.json");
  const orders = readJson<any[]>(ordersPath);
  const targetIds = ["fomumvpd3d", "fomumvo4sg", "fomumvmg57"];
  const supersededBy = "fomumvtp5p";
  let changed = 0;
  for (const id of targetIds) {
    const o = orders.find((x) => x.id === id);
    if (!o) {
      console.log(`[SKIP] fleet:${id}: order not found`);
      continue;
    }
    if (o.closedAs) {
      console.log(`[SKIP] fleet:${id}: already closedAs=${o.closedAs}`);
      continue;
    }
    o.closedAs = "superseded";
    o.supersededBy = supersededBy;
    o.closedReason = `Superseded by later finished order ${supersededBy}; all 3 work orders passed.`;
    o.closedAt = nowIso;
    o.closedBy = closedBy;
    changed++;
    console.log(`[DONE] fleet:${id}: closedAs=superseded, supersededBy=${supersededBy}`);
  }
  if (changed > 0) {
    atomicWriteJson(ordersPath, orders);
    validateJson(ordersPath);
    console.log(`[WRITE] ${ordersPath}: ${changed} order(s) updated, JSON valid`);
  }
}

// ---------------------------------------------------------------------------
// 6. Executive Office smoke-test tracking tasks: close as dropped.
// ---------------------------------------------------------------------------
{
  const tasksPath = path.join(repoRoot, "company", "projects", "pmumhp51r", "tasks.json");
  const tasks = readJson<any[]>(tasksPath);
  const smokeRe = /smoke/i;
  const toClose = tasks.filter((t) => smokeRe.test(t.rawRequest || "") && t.status === "failed");
  let changed = 0;
  for (const t of toClose) {
    if (t.closedAs) {
      console.log(`[SKIP] task:${t.id}: already closedAs=${t.closedAs}`);
      continue;
    }
    t.status = "rejected";
    t.closedAs = "dropped";
    t.closedReason = "no-op smoke test";
    t.closedAt = nowIso;
    t.closedBy = closedBy;
    changed++;
    console.log(`[DONE] task:${t.id}: status=rejected, closedAs=dropped`);
  }
  if (changed > 0) {
    atomicWriteJson(tasksPath, tasks);
    validateJson(tasksPath);
    console.log(`[WRITE] ${tasksPath}: ${changed} smoke-test task(s) closed, JSON valid`);
  }
}

// ---------------------------------------------------------------------------
// Regenerate briefing.json using the new needs-you rule. This also removes the
// 6 false-alarm ids. The running router's 30s watcher still uses old in-memory
// code and may rewrite the file until the router is restarted; the data records
// on disk are already closed so the new rule keeps them out.
// ---------------------------------------------------------------------------
{
  const briefingPath = path.join(repoRoot, "company", "reports", "briefing.json");
  const cards = listRunCards();
  const briefing = composeBriefing(cards, {
    seenAt: nowIso,
    summary: "",
    model: "local",
  });
  const found = Array.from(needsYouIds).filter((id) =>
    briefing.needsYou.some((item: any) => item.runId === id)
  );
  atomicWriteJson(briefingPath, briefing);
  validateJson(briefingPath);
  console.log(
    `[WRITE] ${briefingPath}: regenerated, needsYou=${briefing.needsYou.length}, forbidden ids=${found.length === 0 ? "none" : found.join(", ")}, JSON valid`
  );
}

console.log("[OK] NY-CLEANUP data-side script finished.");
