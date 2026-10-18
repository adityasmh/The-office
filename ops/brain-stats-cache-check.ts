/**
 * ops/brain-stats-cache-check.ts - regression test for the brainStats() memo
 * (ROUTER-HANG, 2026-09-30).
 *
 * Why this exists: /company/budget rides along with the dashboard poll and asks for
 * brainStats(), which used to read and JSON.parse the WHOLE
 * company/budget/brain-decisions.jsonl on every call - synchronously, on the event
 * loop. The live log was 215 KB, so every poll paid a blocking read + ~1.5k parses
 * on a box whose fs metadata is AV-inflated. The fix memoises on the file's
 * mtime+size (the rule cache.ts applies everywhere), and hands callers a copy.
 *
 * This test runs against a THROWAWAY COMPANY_ROOT: it never reads or writes the live
 * company/. The one read outside the throwaway root is deliberate and read-only (it
 * measures what the memo saves on the real log); set SKIP_REAL_LOG=1 to skip it.
 *
 *   npx tsx ops/brain-stats-cache-check.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brain-stats-cache-"));
process.env.COMPANY_ROOT = path.join(tmp, "company");
fs.mkdirSync(path.join(process.env.COMPANY_ROOT, "budget"), { recursive: true });

const { brainStats, brainDecisionsPath } = await import("../src/company/brainRouter.js");

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
}

const DAY = "2026-09-30";
const OTHER_DAY = "2026-09-29";

function line(ts: string, opts: { tier?: "none" | "sonnet" | "opus"; purpose?: string; claudeCall?: boolean; ms?: number } = {}): string {
  return JSON.stringify({
    ts,
    tier: opts.tier ?? "none",
    purpose: opts.purpose ?? "review",
    reasonKind: "fallback",
    claudeCall: opts.claudeCall ?? false,
    opusAvoided: false,
    fileBlind: false,
    layaDown: true,
    climbed: false,
    asked: false,
    ms: opts.ms ?? 100,
  });
}

const file = brainDecisionsPath();
check("Q0 the throwaway root is the one in use", file.startsWith(tmp), file);

// 60 of today's lines + 40 of another day + 1 malformed line (must be skipped, not fatal).
const body = [
  ...Array.from({ length: 60 }, (_, i) => line(`${DAY}T0${i % 10}:00:00.000Z`, { ms: 100 + i })),
  ...Array.from({ length: 40 }, () => line(`${OTHER_DAY}T09:00:00.000Z`)),
  "{not json",
].join("\n") + "\n";
fs.writeFileSync(file, body);

// ── correctness ──────────────────────────────────────────────────────────
const cold = brainStats(DAY);
check("Q1 the cold call folds exactly today's lines", cold.calls === 60, `calls=${cold.calls}`);
check("Q2 the day is echoed", cold.day === DAY);
check("Q3 the other day is ignored", cold.calls !== 100, `calls=${cold.calls}`);
check("Q4 a malformed line does not break the fold", cold.byPurpose.review === 60, `byPurpose=${JSON.stringify(cold.byPurpose)}`);
check("Q5 latencies are folded", cold.medianMs > 0, `medianMs=${cold.medianMs}`);

// ── memo behaviour ───────────────────────────────────────────────────────
const warm = brainStats(DAY);
check("Q6 a second call returns the same answer", JSON.stringify(warm) === JSON.stringify(cold));

warm.calls = 999; // poison the returned object on purpose
check("Q7 callers cannot poison the memo", brainStats(DAY).calls === 60, `calls=${brainStats(DAY).calls}`);

fs.appendFileSync(file, line(`${DAY}T23:59:59.000Z`));
check("Q8 a write invalidates the memo on the next call", brainStats(DAY).calls === 61, `calls=${brainStats(DAY).calls}`);

// ── cost ─────────────────────────────────────────────────────────────────
const t0 = process.hrtime.bigint();
for (let i = 0; i < 500; i++) brainStats(DAY);
const warmMs = Number(process.hrtime.bigint() - t0) / 1e6 / 500;
check("Q9 a warm call is a stat, not a parse", warmMs < 0.5, `${warmMs.toFixed(4)} ms/call`);

if (process.env.SKIP_REAL_LOG !== "1") {
  const real = path.join(process.cwd(), "company", "budget", "brain-decisions.jsonl");
  if (fs.existsSync(real)) {
    const size = fs.statSync(real).size;
    const t1 = process.hrtime.bigint();
    const text = fs.readFileSync(real, "utf8"); // READ-ONLY: what every poll used to do
    let parsed = 0;
    for (const l of text.split("\n")) if (l.trim()) { try { JSON.parse(l); parsed++; } catch { /* skip */ } }
    const coldMs = Number(process.hrtime.bigint() - t1) / 1e6;
    console.log(
      `INFO  the live log is ${(size / 1024).toFixed(0)} KB / ${parsed} decisions; one cold call costs ` +
        `${coldMs.toFixed(1)} ms of blocking event-loop time (idle box), a warm call ${warmMs.toFixed(4)} ms`,
    );
  } else {
    console.log("INFO  no live brain-decisions.jsonl to measure");
  }
}

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* best effort */
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
