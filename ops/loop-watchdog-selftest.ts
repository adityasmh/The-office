/**
 * ops/loop-watchdog-selftest.ts — regression test for the ROUTER-HANG watchdog
 * (src/company/loopWatchdog.ts + the /health move in src/server.ts).
 *
 * Everything runs in THIS throwaway process with a temp evidence file: no router
 * is started, :8787 is never touched, no company data is read or written.
 *
 *   npx tsx ops/loop-watchdog-selftest.ts
 *
 * What it proves, and why each one matters:
 *   A. the watchdog installs and is cheap;
 *   B. a block of the event loop is recorded WITH the breadcrumb that was running
 *      (the old incident could only show that the log stopped);
 *   C. the watchdog THREAD writes a STALL line to the evidence file WHILE the
 *      main thread is still blocked — timestamped inside the blocked window, so a
 *      hang leaves evidence before anyone restarts the process (the old evidence
 *      was written only after the loop came back, if ever);
 *   D. a slow synchronous op names itself (fs.*Sync wrapper + timeSyncOp), which
 *      is the attribution the 2026-09-30 hang was missing;
 *   E. the fs tracing is transparent (same bytes/sizes as an untraced read);
 *   F. log spam is capped: one oversized chunk is truncated, so a 7.6 KB
 *      full-object dump (the 10.4 MB log's main ingredient) becomes a bounded
 *      blocking write;
 *   G. consecutive duplicates collapse (2,465 identical dumps -> a few lines);
 *   H. the bytes/second budget drops volume and says how much it dropped;
 *   I. startup/lifecycle lines the supervisor greps for are never capped;
 *   J. /health is registered BEFORE all middleware and its handler does no I/O
 *      (static check on src/server.ts);
 *   K. the /health payload itself is memory-only (measured per-call cost).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Knobs must be set BEFORE the module is imported: they are read at import time.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loop-watchdog-"));
const evidenceLog = path.join(tmp, "router-selftest.blocks.log");
process.env.ROUTER_LOOP_SAMPLE_MS = "50";
process.env.ROUTER_BLOCK_REPORT_MS = "300";
process.env.ROUTER_SYNC_OP_REPORT_MS = "20";
process.env.ROUTER_STALL_REPORT_MS = "1000";
process.env.ROUTER_LOG_MAX_LINE = "200";
process.env.ROUTER_LOG_BUDGET_BPS = "65536";

let failures = 0;
// The cap under test drops lines by design, so check output must not go through
// process.stdout: write it straight to fd 1. That also keeps `captured` clean.
const emit = (line: string): void => {
  fs.writeSync(1, `${line}\n`);
};
function check(name: string, ok: boolean, detail = ""): void {
  emit(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
}

// Capture what actually reaches the stream. Installed BEFORE the cap, so the cap
// calls this wrapper and we see the post-cap bytes.
const captured: string[] = [];
const realWrite = process.stdout.write.bind(process.stdout);
(process.stdout as unknown as { write: unknown }).write = ((chunk: unknown, ...rest: unknown[]) => {
  captured.push(String(chunk));
  return realWrite(chunk, ...rest);
}) as unknown as typeof process.stdout.write;

const wd = await import("../src/company/loopWatchdog.js");
const block = (ms: number): "ok" | "timed-out" => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// A block is measured by the sampler on its NEXT tick, and the evidence file is
// appended asynchronously, so every assertion must let the loop turn first.
const settle = (ms = 400): Promise<void> => new Promise((r) => setTimeout(r, ms));
const readEvidence = (): string => (fs.existsSync(evidenceLog) ? fs.readFileSync(evidenceLog, "utf8") : "");
const clearEvidence = (): void => fs.writeFileSync(evidenceLog, "");
async function waitFor(test: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (test()) return true;
    await settle(50);
  }
  return test();
}
const detail = (s: string, n = 150): string => (s.length > n ? `${s.slice(0, n)}…` : s);

const status = wd.installLoopWatchdog({ logPath: evidenceLog, port: 0 });
wd.resetLoopWatchdog();
clearEvidence();
await settle(250);

// ── A ────────────────────────────────────────────────────────────────────
check("A1 watchdog installed", status.installed);
check("A2 fs sync tracing wrapped functions", status.syncTrace.enabled && status.syncTrace.wrapped > 5, `wrapped=${status.syncTrace.wrapped}`);
check("A3 log cap on", status.logCap.enabled && status.logCap.maxLine === 200, `maxLine=${status.logCap.maxLine} budget=${status.logCap.budgetPerSec}`);

// ── B ────────────────────────────────────────────────────────────────────
wd.markBusy("selftest:block");
block(1200);
wd.markBusy("idle");
await settle(500); // let the sampler notice the block and flush the evidence file
const blocks = wd.recentBlocks();
const last = blocks[blocks.length - 1];
check("B1 a loop block is recorded", blocks.length >= 1, `blocks=${blocks.length}`);
check("B2 the block duration is measured", Boolean(last) && last.ms >= 900, `ms=${last?.ms}`);
check("B3 the block carries the running breadcrumb", last?.label === "selftest:block", `label=${last?.label}`);
check("B4 the block reaches the evidence file", await waitFor(() => /BLOCK \d+ms label="selftest:block"/.test(readEvidence())));

// ── C: evidence written by the watchdog THREAD while the loop is blocked ──
clearEvidence();
wd.markBusy("selftest:stall-block");
await settle(50);
const t0 = Date.now();
block(3500);
const t1 = Date.now();
wd.markBusy("idle");
await settle(1500); // let the thread notice the resume and the file flush
const stallLines = readEvidence()
  .split("\n")
  .filter((l) => / STALL main thread blocked for/.test(l) && l.includes('label="selftest:stall-block"'));
const stallTs = stallLines.length ? Date.parse(stallLines[0].slice(1, 25)) : NaN;
check("C1 the watchdog thread wrote a STALL line", stallLines.length >= 1, `${stallLines.length} line(s)`);
check(
  "C2 that write happened WHILE the loop was blocked",
  Number.isFinite(stallTs) && stallTs >= t0 - 100 && stallTs <= t1 + 100,
  `stall=${new Date(stallTs).toISOString()} window=${new Date(t0).toISOString()}..${new Date(t1).toISOString()}`,
);
check("C3 the STALL line names what was running", /label="selftest:stall-block"/.test(stallLines[0] ?? ""), detail(stallLines[0] ?? "(none)"));
check("C4 recovery is reported", /STALL-END main thread resumed/.test(readEvidence()));
const stStatus = wd.loopWatchStatus();
check("C5 the stall is visible through /health's status", stStatus.worker.stallReports >= 1 && stStatus.worker.lastStallMs >= 1000, `reports=${stStatus.worker.stallReports} lastMs=${stStatus.worker.lastStallMs}`);

// ── D ────────────────────────────────────────────────────────────────────
wd.resetLoopWatchdog();
clearEvidence();
wd.timeSyncOp("selftest:sync-section", () => {
  block(120);
});
const big = path.join(tmp, "big.bin");
fs.writeFileSync(big, Buffer.alloc(32 * 1024 * 1024, 0x61));
const tRead = Date.now();
const bytes = fs.readFileSync(big).length;
const readMs = Date.now() - tRead;
const ops = wd.recentSlowOps();
const opNames = detail(JSON.stringify(ops.map((o) => o.op)));
check("D1 timeSyncOp names a slow section", ops.some((o) => o.op === "selftest:sync-section"), opNames);
check("D2 the traced fs call names itself", ops.some((o) => o.op.startsWith("fs.readFileSync(")), `read=${readMs}ms ops=${opNames}`);
check("D3 the slow op reaches the evidence file", await waitFor(() => /SLOW-SYNC \d+ms fs\.readFileSync\(/.test(readEvidence())));

// ── E: tracing does not change behaviour ─────────────────────────────────
check("E1 readFileSync returns the same bytes", bytes === 32 * 1024 * 1024, `bytes=${bytes}`);
check("E2 statSync is unchanged", fs.statSync(big).size === 32 * 1024 * 1024);
check("E3 existsSync still reports both ways", fs.existsSync(big) && !fs.existsSync(path.join(tmp, "nope.bin")));

// ── F/G/H/I: the log cap ─────────────────────────────────────────────────
const capStart = captured.length;
wd.installLogCap(); // idempotent; also proves re-install is harmless
const huge = `[selftest] oversized dump: ${"Z".repeat(4000)}`;
console.log(huge);
const bigWrites = captured.slice(capStart).filter((c) => c.includes("oversized dump"));
check("F1 an oversized line is truncated", bigWrites.length === 1 && bigWrites[0].length <= 200 + 120, `len=${bigWrites[0]?.length}`);
check("F2 truncation is marked", (bigWrites[0] ?? "").includes("line truncated by loopWatchdog"), detail(bigWrites[0]?.slice(-60) ?? ""));
check("F3 truncation is counted", wd.loopWatchStatus().logCap.truncatedChunks >= 1);

const dupStart = captured.length;
for (let i = 0; i < 500; i++) console.log("[selftest] duplicate line");
console.log("[selftest] after the duplicates");
const dupWrites = captured.slice(dupStart).filter((c) => c.includes("duplicate line)") || c.includes("duplicate line\n"));
check("G1 500 identical lines collapse to a handful", dupWrites.length <= 3, `physical writes=${dupWrites.length}`);
check("G2 the collapse is reported", captured.slice(dupStart).some((c) => /repeated \d+ more time\(s\)/.test(c)), detail(captured.slice(dupStart).find((c) => /repeated/.test(c)) ?? ""));
check("G3 the collapse is counted", wd.loopWatchStatus().logCap.collapsedLines >= 490, `collapsed=${wd.loopWatchStatus().logCap.collapsedLines}`);

const budgetStart = captured.length;
for (let i = 0; i < 600; i++) console.log(`[selftest] unique volume line ${i} ${String(i).repeat(380)}`);
const capStatus = wd.loopWatchStatus().logCap;
check("H1 the bytes/second budget drops volume", capStatus.droppedLines > 0, `droppedLines=${capStatus.droppedLines} droppedBytes=${capStatus.droppedBytes}`);
await settle(1100); // the budget window resets (and announces the drops) on the next write
console.log("[selftest] trigger the drop summary");
await settle(50);
check("H2 the drops are announced", captured.slice(budgetStart).some((c) => /\[log\] cap: dropped \d+ line/.test(c)), detail(captured.slice(budgetStart).find((c) => /dropped \d+ line/.test(c)) ?? "(none)"));

const mustStart = captured.length;
console.log("router on :8787 selftest (must never be capped)");
console.log("BOOT pid=1 selftest");
const crashLine = `[crash] uncaughtException (exiting 1 so the supervisor restarts cleanly): Error: boom\n    at ${'frame\n    at '.repeat(120)}end`;
console.log(crashLine);
check(
  "I1 supervisor-matched lines are never capped",
  captured.slice(mustStart).some((c) => c.includes("router on :8787 selftest")) && captured.slice(mustStart).some((c) => c.includes("BOOT pid=1")),
);
const crashOut = captured.slice(mustStart).filter((c) => c.includes("uncaughtException"));
check(
  "I2 a crash stack is never truncated",
  crashOut.length === 1 && crashOut[0].includes("end") && !crashOut[0].includes("line truncated"),
  `len=${crashOut[0]?.length} truncated=${crashOut[0]?.includes("line truncated")}`,
);

// ── J: /health placement + handler purity (static, on the real server.ts) ──
const serverSrc = fs.readFileSync(path.join(process.cwd(), "src", "server.ts"), "utf8");
const healthAt = serverSrc.indexOf('app.get("/health"');
const firstUse = serverSrc.indexOf("app.use(");
check("J1 exactly one /health route", serverSrc.split('app.get("/health"').length - 1 === 1);
check("J2 /health is registered before every middleware", healthAt > 0 && healthAt < firstUse, `health@${healthAt} firstUse@${firstUse}`);
const handlerEnd = serverSrc.indexOf("\n});", healthAt);
const handler = serverSrc.slice(healthAt, handlerEnd);
check("J3 the handler does no file I/O", !/readFileSync|existsSync|statSync|hasClaudeCreds\(/.test(handler.replace(/\/\/.*$/gm, "")), detail(handler.match(/\w*Sync\(|hasClaudeCreds\(/g)?.join(",") ?? "clean"));
check("J4 the handler reports the watchdog", handler.includes("loopWatchStatus()") && handler.includes("lastBlock"));

// ── K: the /health payload is memory-only ────────────────────────────────
// eventLoopLag() + loopWatchStatus() are the only work the handler does.
const t = process.hrtime.bigint();
for (let i = 0; i < 2000; i++) wd.loopWatchStatus();
const perCallMs = Number(process.hrtime.bigint() - t) / 1e6 / 2000;
check("K1 the health payload costs microseconds", perCallMs < 0.5, `${perCallMs.toFixed(4)} ms/call`);

// ── counters, for the report ─────────────────────────────────────────────
// (block/stall counts are since the last resetLoopWatchdog() in phase D)
const final = wd.loopWatchStatus();
emit(
  `\ncounters: blocksSinceReset=${final.blocks} maxBlockMsSinceReset=${final.maxBlockMs} stallReportsSinceReset=${final.worker.stallReports} ` +
    `truncatedChunks=${final.logCap.truncatedChunks} collapsedLines=${final.logCap.collapsedLines} droppedLines=${final.logCap.droppedLines}`,
);

// ── cleanup ──────────────────────────────────────────────────────────────
(process.stdout as unknown as { write: unknown }).write = realWrite;
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* best effort */
}

emit(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
