// ---------------------------------------------------------------------------
// Work-order #1 verification driver - PART 2 (b)(c)(d)(e): LIVE Slack posts.
//
// Creates a TEMP company root, makes synthetic tasks that are already terminal,
// points the bridge's task->thread map at the temp dir, then runs the module's
// own report tick (__testReportOnce) and checks what Slack actually received.
//
// Run with:  tsx --env-file=.env scripts/slack-report-live.ts
// No server is started (the bridge transport is never started), the live
// company/ directory is never touched, and no token or .env value is printed.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.join(os.tmpdir(), `slack-report-live-${process.pid}`);
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
process.env.COMPANY_ROOT = root; // read at import time by org.ts -> must be first
process.env.SLACK_BRIDGE = "0"; // never start a transport in this driver

const stateFile = path.join(root, "slack-inbound.json");
const over = { stateFile, intervalMs: 60_000 };

type SlackMsg = { ts?: string; text?: string; thread_ts?: string };
type SlackResp = { ok: boolean; ts?: string; error?: string; messages?: SlackMsg[] };

async function slack(method: string, body: Record<string, string | number | boolean>): Promise<SlackResp> {
  const token = process.env.SLACK_BOT_TOKEN ?? "";
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) search.set(k, String(v));
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
    body: search.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  return (await res.json()) as SlackResp;
}

function readMap(file: string): Record<string, Record<string, unknown>> {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, Record<string, unknown>>;
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const { config } = await import("../src/config.js");
  const { __testRecordDispatched, __testReportOnce, __testTaskThreadsFile } = await import(
    "../src/company/slackInbound.js"
  );
  const { createTask, updateTask, getTask } = await import("../src/company/gates.js");
  const { createProject } = await import("../src/company/org.js");

  const channel = config.slackChannelId;
  console.log(
    `[live] mockMode=${config.mockMode} botTokenPresent=${!!config.slackBotToken} channelConfigured=${!!channel}`,
  );
  console.log(`[live] temp COMPANY_ROOT=${root}`);
  if (!config.slackBotToken || !channel) {
    console.log("[live] SKIP: no Slack bot token / channel configured in this environment");
    process.exitCode = 2;
    return;
  }

  // A real parent message = "the CEO's order". Its ts is what reports must thread under.
  const parent = await slack("chat.postMessage", {
    channel,
    text: `[bridge-selftest] work-order #1 verification parent (automated, not a CEO message) ${new Date().toISOString()}`,
    unfurl_links: false,
  });
  if (!parent.ok || !parent.ts) {
    console.log(`[live] FAIL: could not post the parent message: ${parent.error ?? "unknown"}`);
    process.exitCode = 1;
    return;
  }
  const parentTs = parent.ts;
  console.log(`[live] parent (the CEO's order) posted with ts=${parentTs}`);

  const { project } = createProject({ projectName: "Selftest Project", departmentName: "Engineering" });
  const mapFile = __testTaskThreadsFile(over);
  console.log(`[live] task->thread map file: ${mapFile}`);

  // ── (b) record a dispatch exactly as processMessage does ─────────────────
  const taskA = createTask(project.id, "Add a hello endpoint");
  updateTask(project.id, taskA.id, { status: "merged", result: "hello endpoint merged" });
  const keyA = `${project.id}::${taskA.id}`;
  __testRecordDispatched(
    {
      reply: "ok",
      plan: [],
      dispatched: [{ projectId: project.id, taskId: taskA.id, title: "Add a hello endpoint", status: "running" }],
      sessions: [],
      budgets: { remainingUsd: 0 },
      decisions: [],
    },
    parentTs,
    over,
  );
  console.log(`[live] (b) persisted map after recording the dispatch:\n${JSON.stringify(readMap(mapFile), null, 2)}`);

  // ── (c) one report, into the correct thread ──────────────────────────────
  const first = await __testReportOnce(over);
  const mapAfterFirst = readMap(mapFile);
  const postedTs = String(mapAfterFirst[keyA]?.reportedTs ?? "");
  console.log(
    `[live] (c) tick #1: reports posted=${first}; reportedTs=${postedTs}; task status on disk=${getTask(project.id, taskA.id)?.status}`,
  );
  const replies = await slack("conversations.replies", { channel, ts: parentTs, limit: 20 });
  const child = (replies.messages ?? []).find((m) => m.ts === postedTs);
  console.log(
    `[live] (c) thread check: child of parentTs found=${!!child} child.ts=${child?.ts ?? "(none)"} child.thread_ts=${
      child?.thread_ts ?? "(none)"
    } text=${JSON.stringify(child?.text ?? "")}`,
  );
  const cOk = first === 1 && !!child && child.thread_ts === parentTs;

  // ── (d) idempotence ──────────────────────────────────────────────────────
  const second = await __testReportOnce(over);
  const mapAfterSecond = readMap(mapFile);
  console.log(
    `[live] (d) tick #2: reports posted=${second} (must be 0); persisted reportedTs=${String(
      mapAfterSecond[keyA]?.reportedTs ?? "",
    )} (unchanged=${mapAfterSecond[keyA]?.reportedTs === postedTs})`,
  );
  const dOk = second === 0 && mapAfterSecond[keyA]?.reportedTs === postedTs;

  // ── (e) fallback: no thread ts -> the channel ────────────────────────────
  const taskB = createTask(project.id, "Selftest task with no known thread");
  updateTask(project.id, taskB.id, { status: "failed", error: "selftest: the tester rejected the build" });
  const keyB = `${project.id}::${taskB.id}`;
  __testRecordDispatched(
    {
      reply: "ok",
      plan: [],
      dispatched: [
        { projectId: project.id, taskId: taskB.id, title: "Selftest fallback task", status: "running" },
      ],
      sessions: [],
      budgets: { remainingUsd: 0 },
      decisions: [],
    },
    "",
    over,
  );
  const third = await __testReportOnce(over);
  const mapAfterThird = readMap(mapFile);
  const fallbackTs = String(mapAfterThird[keyB]?.reportedTs ?? "");
  const hist = await slack("conversations.history", { channel, limit: 20 });
  const top = (hist.messages ?? []).find((m) => m.ts === fallbackTs);
  const eOk = third === 1 && !!top && !top.thread_ts;
  console.log(
    `[live] (e) fallback tick: reports posted=${third}; channel message ts=${fallbackTs} foundInHistory=${!!top} thread_ts=${
      top?.thread_ts ?? "(none: posted to the channel)"
    } text=${JSON.stringify(top?.text ?? "")}`,
  );
  console.log(`[live] (e) final persisted map:\n${JSON.stringify(readMap(mapFile), null, 2)}`);

  console.log(
    `[live] ${cOk && dOk && eOk ? "PASS" : "FAIL"}: (c) threaded one-shot=${cOk} (d) idempotent=${dOk} (e) channel fallback=${eOk}`,
  );
  if (!(cOk && dOk && eOk)) process.exitCode = 1;
}

void main().catch((e) => {
  console.error(`[live] driver failed: ${String(e)}`);
  process.exitCode = 1;
});
