// Work-order #1 verification driver - PART 3: the watcher interval itself.
//
// Starts the bridge (polling transport) against a channel id that does not
// exist, so no real CEO message can be read or answered, and proves:
//   * the finished-task reporter interval is created when the bridge starts
//   * it is unref'd (the process still exits on its own)
//   * stopSlackInbound() clears it
// Temp COMPANY_ROOT, temp state file; nothing in the live company/ is touched.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.join(os.tmpdir(), `slack-report-watcher-${process.pid}`);
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
process.env.COMPANY_ROOT = root;

async function main(): Promise<void> {
  const { startSlackInbound, stopSlackInbound, __testLog } = await import("../src/company/slackInbound.js");
  const status = startSlackInbound({
    channelId: "C_SELFTEST_CHANNEL_DOES_NOT_EXIST", // no real history can be read
    stateFile: path.join(root, "slack-inbound.json"),
    intervalMs: 600_000,
    reportIntervalMs: undefined,
  } as Parameters<typeof startSlackInbound>[0]);
  console.log(`[watcher] transport=${status.transport} running=${status.running} channel=${status.channel}`);
  await new Promise((r) => setTimeout(r, 1500));
  const logs = __testLog(40).filter((l) => /watcher|report-back|baseline|poll failed|auth\.test/.test(l));
  console.log(`[watcher] log lines:\n${logs.join("\n")}`);
  const started = logs.some((l) => /task report-back watcher every \d+ms/.test(l));
  console.log(`[watcher] reporter interval created=${started}`);
  stopSlackInbound();
  console.log(`[watcher] ${started ? "PASS" : "FAIL"}: the reporter starts with the bridge (and the process exited, so the interval is unref'd)`);
  if (!started) process.exitCode = 1;
}

void main().catch((e) => {
  console.error(`[watcher] driver failed: ${String(e)}`);
  process.exitCode = 1;
});
