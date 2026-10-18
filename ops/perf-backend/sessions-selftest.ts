// PERF-BACKEND sessions.jsonl selftest (2026-09-29).
//
// Proves the two item-3 claims, in TWO separate processes (so the "restart"
// really is a cold start):
//   phase write   - a burst of output chunks must NOT append a snapshot each
//                   (sessions.jsonl stays tiny) and the tail must land in
//                   company/sessions/<id>.tail
//   phase verify  - a NEW process must show the same output (tail file wins over
//                   the throttled JSONL snapshot), keep listSessions working, and
//                   still mark a leftover "running" session as error on boot.
//
// Usage:
//   npx tsx ops/perf-backend/sessions-selftest.ts write  [rootDir]
//   npx tsx ops/perf-backend/sessions-selftest.ts verify [rootDir]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const phase = process.argv[2] ?? "write";
const root = process.argv[3] ?? path.join(os.tmpdir(), "jcode-perfbe-sessions", "company");
process.env.COMPANY_ROOT = root;
process.env.SESSION_SNAPSHOT_MIN_MS = "1000";
fs.mkdirSync(root, { recursive: true });

const S = await import("../../src/company/sessions.js");

const CHUNKS = 2000;
const CHUNK = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.\n";
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const jsonLines = () => {
  const f = path.join(root, "sessions.jsonl");
  if (!fs.existsSync(f)) return 0;
  return fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).length;
};

if (phase === "write") {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });

  const ctx = (agentId: string) => ({
    agentId, agentName: agentId, role: "coder", departmentId: "d1", departmentName: "Engineering",
    projectId: "pTEST", projectName: "Perf Test", taskId: "t1", taskTitle: "burst", model: "m1",
    runtime: "router" as const,
  });

  const a = S.startSession(ctx("coder-1"));
  const b = S.startSession(ctx("tester-1"));
  const linesAfterStart = jsonLines();

  const t0 = Date.now();
  for (let i = 0; i < CHUNKS; i++) {
    S.chunkSession(a.id, CHUNK);
    if (i % 100 === 0) S.chunkSession(b.id, CHUNK);
  }
  S.finishSession(b.id, "done", { text: "ALLDONE", costUsd: 0.25 });
  const ms = Date.now() - t0;

  const lines = jsonLines();
  const bytes = fs.statSync(path.join(root, "sessions.jsonl")).size;
  const budget = Math.max(4, Math.ceil(ms / 1000) * 2 + 4); // 2 snapshots/s + finish + starts
  check("jsonl did not grow per chunk", lines <= budget, `${lines} lines for ${CHUNKS} chunks in ${ms} ms (budget ${budget})`);
  check("jsonl stayed small", bytes < 64 * 1024, `${bytes} bytes`);

  const tailFile = path.join(root, "sessions", `${a.id}.tail`);
  check("tail file written", fs.existsSync(tailFile), tailFile);
  const tail = fs.existsSync(tailFile) ? fs.readFileSync(tailFile, "utf8") : "";
  check("tail holds the run's output", tail.length > 0 && (tail.includes(CHUNK.trim()) || tail.length >= 1000), `${tail.length} chars`);
  check("tail is capped", fs.existsSync(tailFile) ? fs.statSync(tailFile).size <= 20000 : false, fs.existsSync(tailFile) ? `${fs.statSync(tailFile).size} bytes` : "missing");

  // The in-memory record is what the dashboard reads and must be current.
  const live = S.getSession(a.id);
  const expected = (CHUNK.repeat(CHUNKS)).slice(-2000);
  check("in-memory lastText is current", live?.lastText === expected, `${(live?.lastText ?? "").length} chars`);

  // listSessions must still be newest-first and complete.
  const list = S.listSessions(10);
  check("listSessions returns both", list.length === 2 && list[0].id === b.id, list.map((s) => s.id).join(","));
  check("counts are right", JSON.stringify(S.sessionCounts()) === JSON.stringify({ running: 1, queued: 0, total: 2 }), JSON.stringify(S.sessionCounts()));

  fs.writeFileSync(path.join(root, "..", "selftest-ids.json"), JSON.stringify({ a: a.id, b: b.id, chunks: CHUNKS }));
  console.log(`# phase write done: ${CHUNKS} chunks -> ${lines} jsonl line(s), ${bytes} bytes jsonl, ${tail.length} tail chars, ${ms} ms`);
} else {
  // ---- cold start: nothing from the write phase is in memory ----------------
  const ids = JSON.parse(fs.readFileSync(path.join(root, "..", "selftest-ids.json"), "utf8"));
  const linesBefore = jsonLines();

  const live = S.getSession(ids.a);
  const expected = (CHUNK.repeat(ids.chunks)).slice(-2000);
  check("cold start restored lastText from the tail file", live?.lastText === expected, `${(live?.lastText ?? "").length} chars`);
  const done = S.getSession(ids.b);
  check("finished session restored", done?.status === "done" && done?.costUsd === 0.25, `status=${done?.status} cost=${done?.costUsd}`);
  check("boot did not grow the file", jsonLines() === linesBefore, `${linesBefore} -> ${jsonLines()}`);

  const reconciled = S.reconcileStaleSessions("selftest restart");
  check("stale running session was reconciled", reconciled === 1, `reconciled=${reconciled}`);
  const after = S.getSession(ids.a);
  check("stale session is error now", after?.status === "error", `status=${after?.status}`);
  check("stale annotation survived the restore path", (after?.lastText ?? "").includes("[stale:"), "");

  // A second burst in this process must not blow the file up either.
  const c = S.startSession({ agentId: "coder-2", agentName: "coder-2", role: "coder", departmentId: "d1", departmentName: "Engineering", projectId: "pTEST", projectName: "Perf Test", taskId: "t2", taskTitle: "burst2", model: "m1" });
  const t0 = Date.now();
  for (let i = 0; i < 500; i++) S.chunkSession(c.id, CHUNK);
  const ms = Date.now() - t0;
  const grew = jsonLines() - linesBefore;
  check("second burst stayed throttled", grew <= Math.ceil(ms / 1000) * 2 + 4, `+${grew} lines in ${ms} ms`);
  console.log(`# phase verify done: jsonl ${jsonLines()} lines`);
}

console.log(failures === 0 ? "# ALL CHECKS PASSED" : `# ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
