// ---------------------------------------------------------------------------
// Work-order #1 verification driver - PART 1 (b): the REAL handler path.
//
// Drives __testHandleIncoming() (the same processMessage() the poller and the
// socket funnel into) with a LOCAL mock gateway on 127.0.0.1, so the assistant
// produces a genuine dispatch without a paid model call and without any Slack
// post. Proves that a dispatch caused by a CEO message is persisted as
// <projectId>::<taskId> -> the message's thread ts in slack-task-threads.json.
//
// Isolation: temp COMPANY_ROOT, MOCK_MODE=1, SLACK_BRIDGE=0, no server on any
// port except the in-process mock gateway on an ephemeral localhost port.
// Nothing here reads or writes the live company/ directory or .env.
// ---------------------------------------------------------------------------
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.join(os.tmpdir(), `slack-report-e2e-${process.pid}`);
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
process.env.COMPANY_ROOT = root; // read at import time by org.ts -> must be first
process.env.MOCK_MODE = "1"; // console fallbacks; never post to Slack
process.env.SLACK_BRIDGE = "0";
process.env.ASSISTANT_MODEL = "selftest-free-model"; // not "claude" -> gateway chain
process.env.OPENCODE_API_KEY = "selftest-local-mock-key"; // not a real secret

const stateFile = path.join(root, "slack-inbound.json");
const over = { stateFile, botToken: "", channelId: "", intervalMs: 60_000 };

// The assistant's planning model is answered by this in-process stub.
const assistantJson = {
  reply: "Dispatched one work order to Engineering.",
  decisions: ["selftest: local mock gateway"],
  tasks: [
    {
      title: "Add a hello endpoint",
      departmentName: "Engineering",
      role: "coder",
      request: "Add a hello endpoint to the selftest repo.",
    },
  ],
};

function readMap(file: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += String(c)));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(assistantJson) } }], usage: {} }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  process.env.GATEWAY_BASE_URL = `http://127.0.0.1:${port}/v1`; // set before config.ts loads
  console.log(`[e2e] mock gateway listening on 127.0.0.1:${port} (GATEWAY_BASE_URL overridden for this process only)`);

  const { __testHandleIncoming, __testTaskThreadsFile } = await import("../src/company/slackInbound.js");
  const { getTask } = await import("../src/company/gates.js");

  const ceoTs = "1799000000.000100"; // stand-in for the CEO's Slack message ts
  const outcome = await __testHandleIncoming("Kick off the work: add a hello endpoint", ceoTs, {
    ...over,
    autoRun: false, // plan + create the task, do NOT start a pipeline
  });

  console.log(
    `[e2e] outcome: ${JSON.stringify({
      skipped: outcome.skipped,
      assistantCalled: outcome.assistantCalled,
      replied: outcome.replied,
      replyTs: outcome.replyTs,
      reason: outcome.reason,
    })}`,
  );

  const mapFile = __testTaskThreadsFile(over);
  const map = readMap(mapFile);
  console.log(`[e2e] map file: ${mapFile}`);
  console.log(`[e2e] (b) persisted map after a real dispatch:\n${JSON.stringify(map, null, 2)}`);

  const keys = Object.keys(map);
  const first = keys[0];
  const entry = first ? (map[first] as Record<string, unknown>) : undefined;
  const taskOnDisk = entry
    ? getTask(String(entry.projectId), String(entry.taskId))
    : undefined;
  console.log(
    `[e2e] task on disk: ${JSON.stringify({
      projectId: entry?.projectId,
      taskId: entry?.taskId,
      title: entry?.title,
      threadTs: entry?.threadTs,
      reportedTs: entry?.reportedTs,
      taskStatus: taskOnDisk?.status,
    })}`,
  );

  const ok =
    !!entry &&
    entry.threadTs === ceoTs &&
    entry.reportedTs === null &&
    !!taskOnDisk &&
    outcome.assistantCalled === true;
  console.log(`[e2e] ${ok ? "PASS" : "FAIL"}: dispatch recorded as <projectId>::<taskId> -> threadTs=${ceoTs}`);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!ok) process.exitCode = 1;
}

void main().catch((e) => {
  console.error(`[e2e] driver failed: ${String(e)}`);
  process.exitCode = 1;
});
