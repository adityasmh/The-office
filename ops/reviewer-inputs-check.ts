// Proof/verification for Order F6-reviewer-inputs.
//
// FIRST import MUST be the sandbox: ES imports run before top-level code, so this
// points COMPANY_ROOT at a temp folder before any company module captures it
// (docs/PITFALLS.md item 1). No network, no router: everything runs offline
// against temp folders and an injected fake fs; git is never invoked because a
// gitStat hook is always passed in.
import "./sandbox-company-root.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// config.ts snapshots mockMode at module load, so MOCK_MODE must be set BEFORE
// the dynamic import below (ES import order does not help dynamic imports).
process.env.MOCK_MODE = "1";
process.env.PIPELINE_MOCK_STAGE_DELAY_MS = "0";

const results: { name: string; ok: boolean; detail: string }[] = [];
function report(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` ${detail}` : ""}`);
}

// Minimum fake stat shape buildReviewPack needs.
type StatLike = { size: number; mtimeMs: number; isFile(): boolean };
type FakeEntry = { size: number; mtimeMs: number; body?: Buffer; isDir?: boolean; isFileLike?: boolean };

function makeFs(files: Map<string, FakeEntry>) {
  return {
    existsSync: (p: string) => files.has(p),
    statSync: (p: string): StatLike => {
      const e = files.get(p);
      if (!e) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      if (e.isDir) throw Object.assign(new Error("EISDIR"), { code: "EISDIR" });
      return {
        size: e.size,
        mtimeMs: e.mtimeMs,
        isFile: () => e.isFileLike !== false,
      };
    },
    readFileSync: (p: string): Buffer => {
      const e = files.get(p);
      if (!e) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      if (e.isDir) throw Object.assign(new Error("EISDIR"), { code: "EISDIR" });
      return e.body ?? Buffer.alloc(0);
    },
    readdirSync: (p: string): string[] => {
      const names = new Set<string>();
      const prefix = p.endsWith(path.sep) ? p : p + path.sep;
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          if (rest && !rest.includes(path.sep)) names.add(rest);
        }
      }
      return [...names];
    },
  };
}

// Deterministic fake clock helper: fixed task start.
const TASK_START = Date.parse("2026-10-07T00:00:00.000Z");
const AFTER = TASK_START + 1000; // written after task start -> changed
const BEFORE = TASK_START - 1000; // written before -> unchanged

const { buildReviewPack, buildTesterPrompt, buildOpposerPrompt, buildManagerReviewPrompt, evaluateNoChangeGuard, REVIEW_PACK_LABEL, NO_DELIVERABLE_CHANGED_REASON } =
  await import("../src/company/pipeline.js");

const LABEL = "FACTS FROM DISK (authoritative)";
const noGit = () => undefined;

// ── 1. changed file appears with content ────────────────────────────────────
{
  const files = new Map<string, FakeEntry>();
  files.set(path.resolve("/r/out/a.txt"), { size: 11, mtimeMs: AFTER, body: Buffer.from("hello world") });
  const pack = buildReviewPack({
    root: "/r",
    files: ["out/a.txt"],
    taskStartMs: TASK_START,
    coderOutput: "step 1 ok",
    taskId: "tX",
    fs: makeFs(files) as unknown as Parameters<typeof buildReviewPack>[0]["fs"],
    gitStat: noGit,
  });
  report("1. changed file listed with content", pack.status === "ok" && pack.text.includes("hello world"), `status=${pack.status}`);
}

// ── 2. missing file listed as missing ───────────────────────────────────────
{
  const files = new Map<string, FakeEntry>();
  const pack = buildReviewPack({
    root: "/r",
    files: ["out/gone.txt"],
    taskStartMs: TASK_START,
    coderOutput: "",
    taskId: "tX",
    fs: makeFs(files) as unknown as Parameters<typeof buildReviewPack>[0]["fs"],
    gitStat: noGit,
  });
  const e = pack.entries[0];
  report(
    "2. missing file listed as missing",
    pack.entries.length === 1 && e.exists === false && e.missing === true && pack.text.includes("out/gone.txt") && pack.text.toLowerCase().includes("missing"),
    JSON.stringify(e),
  );
}

// ── 3. truncation markers + total cap (incl. boundaries) ────────────────────
{
  // 3a. exactly 300 lines: no truncation marker (inclusive boundary).
  const exactly300 = Array.from({ length: 300 }, (_, i) => `line${i + 1}`).join("\n");
  const filesA = new Map<string, FakeEntry>();
  filesA.set(path.resolve("/r/l300.txt"), { size: exactly300.length, mtimeMs: AFTER, body: Buffer.from(exactly300) });
  const packA = buildReviewPack({ root: "/r", files: ["l300.txt"], taskStartMs: TASK_START, coderOutput: "", taskId: "tX", fs: makeFs(filesA) as never, gitStat: noGit });
  // The Section B header legitimately contains the word "truncated"; the real
  // marker is a "[truncated: ...]" bracket line or a non-empty entry.truncated.
  report("3a. exactly 300 lines -> no marker", packA.entries[0]?.truncated === undefined && !packA.text.includes("[truncated"), packA.entries[0]?.truncated ?? "none");

  // 3b. 301 lines -> marker, first 300 kept.
  const l301 = exactly300 + "\nline301";
  const filesB = new Map<string, FakeEntry>();
  filesB.set(path.resolve("/r/l301.txt"), { size: l301.length, mtimeMs: AFTER, body: Buffer.from(l301) });
  const packB = buildReviewPack({ root: "/r", files: ["l301.txt"], taskStartMs: TASK_START, coderOutput: "", taskId: "tX", fs: makeFs(filesB) as never, gitStat: noGit });
  const bodyB = packB.text;
  report(
    "3b. 301 lines -> marker says what was removed, line301 absent",
    bodyB.includes("truncated") && bodyB.includes("line1") && !bodyB.includes("line301"),
    packB.entries[0]?.truncated ?? "no marker",
  );

  // 3c. exactly 20000 chars: no per-file marker.
  const exactly20k = "x".repeat(20000);
  const filesC = new Map<string, FakeEntry>();
  filesC.set(path.resolve("/r/c20k.txt"), { size: 20000, mtimeMs: AFTER, body: Buffer.from(exactly20k) });
  const packC = buildReviewPack({ root: "/r", files: ["c20k.txt"], taskStartMs: TASK_START, coderOutput: "", taskId: "tX", fs: makeFs(filesC) as never, gitStat: noGit });
  report("3c. exactly 20000 chars -> no marker", packC.entries[0]?.truncated === undefined && !packC.text.includes("[truncated"), packC.entries[0]?.truncated ?? "none");

  // 3d. 20001 chars -> per-file marker.
  const filesD = new Map<string, FakeEntry>();
  filesD.set(path.resolve("/r/c20k1.txt"), { size: 20001, mtimeMs: AFTER, body: Buffer.from("x".repeat(20001)) });
  const packD = buildReviewPack({ root: "/r", files: ["c20k1.txt"], taskStartMs: TASK_START, coderOutput: "", taskId: "tX", fs: makeFs(filesD) as never, gitStat: noGit });
  report("3d. 20001 chars -> per-file marker", !!packD.entries[0]?.truncated && packD.entries[0].truncated!.includes("20000"), packD.entries[0]?.truncated ?? "none");

  // 3e. total cap: the 20000-char per-file cap applies first, so every fixture
  // file must be <= 20000 chars for the total cap to engage. 20000+20000+20000+
  // 5000 = 65000 > 60000: the largest (a 20000 file; ties keep listed order) is
  // cut first by 5000, every other file stays whole.
  const bigA = "a".repeat(20000);
  const bigB = "b".repeat(20000);
  const bigC = "c".repeat(20000);
  const bigD = "d".repeat(5000);
  const filesE = new Map<string, FakeEntry>();
  filesE.set(path.resolve("/r/bigA.txt"), { size: 20000, mtimeMs: AFTER, body: Buffer.from(bigA) });
  filesE.set(path.resolve("/r/bigB.txt"), { size: 20000, mtimeMs: AFTER, body: Buffer.from(bigB) });
  filesE.set(path.resolve("/r/bigC.txt"), { size: 20000, mtimeMs: AFTER, body: Buffer.from(bigC) });
  filesE.set(path.resolve("/r/bigD.txt"), { size: 5000, mtimeMs: AFTER, body: Buffer.from(bigD) });
  const packE = buildReviewPack({ root: "/r", files: ["bigA.txt", "bigB.txt", "bigC.txt", "bigD.txt"], taskStartMs: TASK_START, coderOutput: "", taskId: "tX", fs: makeFs(filesE) as never, gitStat: noGit });
  const cut = packE.entries.filter((e) => e.truncated);
  report(
    "3e. total cap 60000: largest cut first, marker states removal",
    cut.length === 1 &&
      cut[0]?.path === "bigA.txt" &&
      cut[0].truncated!.includes("5000") &&
      cut[0].truncated!.includes("total cap") &&
      packE.text.includes("b".repeat(100)) &&
      packE.text.includes("c".repeat(100)) &&
      packE.text.includes("d".repeat(100)),
    `markerA=${cut[0]?.truncated ?? "none"}`,
  );
}

// ── 4. unchanged file not shown as changed ──────────────────────────────────
{
  const files = new Map<string, FakeEntry>();
  files.set(path.resolve("/r/old.txt"), { size: 8, mtimeMs: BEFORE, body: Buffer.from("original") });
  const filesAtStart = new Map<string, FakeEntry>();
  filesAtStart.set(path.resolve("/r/eq.txt"), { size: 2, mtimeMs: TASK_START, body: Buffer.from("eq") });
  const pack = buildReviewPack({ root: "/r", files: ["old.txt", "eq.txt"], taskStartMs: TASK_START, coderOutput: "", taskId: "tX", fs: makeFs(files) as never, gitStat: noGit });
  const packAtStart = buildReviewPack({ root: "/r", files: ["eq.txt"], taskStartMs: TASK_START, coderOutput: "", taskId: "tX", fs: makeFs(filesAtStart) as never, gitStat: noGit });
  report(
    "4. mtime before start -> unchanged, not in content section; mtime == start counts as changed (>=",
    pack.entries.every((e) => e.changed !== true) && pack.status === "nothing-changed" && !pack.text.includes("original") && packAtStart.entries[0]?.changed === true,
    `status=${pack.status}/${packAtStart.status}`,
  );
}

// ── 5. empty / binary / outside-root / deleted file ─────────────────────────
{
  const files = new Map<string, FakeEntry>();
  files.set(path.resolve("/r/empty.txt"), { size: 0, mtimeMs: AFTER, body: Buffer.alloc(0) });
  files.set(path.resolve("/r/bin.dat"), { size: 4, mtimeMs: AFTER, body: Buffer.from([0x00, 0x01, 0x02, 0x03]) });
  const pack = buildReviewPack({ root: "/r", files: ["empty.txt", "bin.dat", "../escape.txt", "outside/never.txt"], taskStartMs: TASK_START, coderOutput: "", taskId: "tX", fs: makeFs(files) as never, gitStat: noGit });
  report(
    "5. empty/binary skipped with reason, outside root rejected, no crash",
    pack.entries.length === 4 && pack.entries[0].reason?.startsWith("empty") && pack.entries[1].reason?.startsWith("binary") && pack.entries[2].reason?.includes("outside") === true,
    JSON.stringify(pack.entries.map((e) => e.reason)),
  );
}

// ── 6. section C: report file selection ─────────────────────────────────────
{
  const files = new Map<string, FakeEntry>();
  files.set(path.resolve("/r/docs/reports/REPORT_tY-b.md"), { size: 2, mtimeMs: AFTER, body: Buffer.from("B") });
  files.set(path.resolve("/r/docs/reports/REPORT_tY-a.md"), { size: 2, mtimeMs: AFTER, body: Buffer.from("A") });
  const pack = buildReviewPack({ root: "/r", files: [], taskStartMs: TASK_START, coderOutput: "", taskId: "tY", fs: makeFs(files) as never, gitStat: noGit });
  const filesNone = new Map<string, FakeEntry>();
  const packNone = buildReviewPack({ root: "/r", files: [], taskStartMs: TASK_START, coderOutput: "", taskId: "tZ", fs: makeFs(filesNone) as never, gitStat: noGit });
  report(
    "6. report C section picks first sorted match, zero matches says none",
    // Only the first sorted match is shown (by design), so the second match's
    // name is not in the pack; assert the "(first of N)" note + the shown content.
    pack.text.includes("REPORT_tY-a.md (first of 2 sorted matches)\nA") && packNone.text.includes("(no matching report file)"),
    pack.text.slice(pack.text.indexOf("C."), pack.text.indexOf("C.") + 120),
  );
}

// ── 7. section D: coder output tail ─────────────────────────────────────────
{
  const long = Array.from({ length: 200 }, (_, i) => `out${i + 1}`).join("\n");
  const packLong = buildReviewPack({ root: "/r", files: [], taskStartMs: TASK_START, coderOutput: long, taskId: "tX", fs: makeFs(new Map()) as never, gitStat: noGit });
  const packShort = buildReviewPack({ root: "/r", files: [], taskStartMs: TASK_START, coderOutput: "only line", taskId: "tX", fs: makeFs(new Map()) as never, gitStat: noGit });
  const packEmpty = buildReviewPack({ root: "/r", files: [], taskStartMs: TASK_START, coderOutput: "", taskId: "tX", fs: makeFs(new Map()) as never, gitStat: noGit });
  report(
    "7. section D: 200-line output keeps last 80, short output whole, empty handled",
    packLong.text.includes("out200") && !packLong.text.includes("out119\n") && packShort.text.includes("only line") && packEmpty.text.includes("(coder output empty)"),
    "",
  );
}

// ── 8. git diff --stat: present when hook answers, omitted cleanly otherwise ─
{
  const files = new Map<string, FakeEntry>();
  files.set(path.resolve("/r/r.txt"), { size: 2, mtimeMs: AFTER, body: Buffer.from("rr") });
  const withGit = buildReviewPack({ root: "/r", files: ["r.txt"], taskStartMs: TASK_START, coderOutput: "", taskId: "tX", fs: makeFs(files) as never, gitStat: () => " out/r.txt | 2 +-" });
  const withoutGit = buildReviewPack({ root: "/r", files: ["r.txt"], taskStartMs: TASK_START, coderOutput: "", taskId: "tX", fs: makeFs(files) as never, gitStat: noGit });
  report(
    "8. git stat shown via hook, omitted cleanly when not a repo",
    withGit.text.includes("git diff --stat") && withGit.text.includes("out/r.txt | 2 +-") && withoutGit.text.includes("omitted") === true,
    "",
  );
}

// ── 9. no-change guard unit checks ──────────────────────────────────────────
{
  const guardZeroListed = evaluateNoChangeGuard({ listedDeliverables: [], entries: [] });
  const guardNoChange = evaluateNoChangeGuard({
    listedDeliverables: ["out/a.txt"],
    entries: [{ path: "out/a.txt", exists: false, missing: true, reason: "missing" }],
  });
  const guardChanged = evaluateNoChangeGuard({
    listedDeliverables: ["out/a.txt"],
    entries: [{ path: "out/a.txt", exists: true, changed: true, size: 3, lastWriteTime: "x" }],
  });
  report(
    "9. guard: zero listed never fires; none changed fires with exact reason; one changed passes",
    guardZeroListed.ok === true &&
      guardNoChange.ok === false &&
      guardNoChange.reason === "merge guard: no deliverable changed on disk" &&
      guardChanged.ok === true,
    guardNoChange.reason ?? "",
  );
}

// ── 10. the three prompt builders contain the pack (fake model fns) ─────────
{
  // Fake model function capturing every prompt string it is asked to run, the
  // same way runAgent's callers embed prompts; here we drive the pure builders
  // and assert on the exact strings that would be sent.
  const files = new Map<string, FakeEntry>();
  files.set(path.resolve("/r/out/a.txt"), { size: 11, mtimeMs: AFTER, body: Buffer.from("hello world") });
  const pack = buildReviewPack({ root: "/r", files: ["out/a.txt"], taskStartMs: TASK_START, coderOutput: "coder output tail", taskId: "tX", fs: makeFs(files) as never, gitStat: noGit });
  const capturedPrompt: string[] = [];
  const fakeModelFn = (prompt: string) => {
    capturedPrompt.push(prompt);
    return { text: "mock" };
  };
  fakeModelFn(buildTesterPrompt({ subtask: "test the thing", brief: "acceptance", work: "coder said done", packText: pack.text }));
  fakeModelFn(buildOpposerPrompt({ subtask: "oppose the thing", brief: "acceptance", work: "coder said done", packText: pack.text }));
  fakeModelFn(buildManagerReviewPrompt({ request: "the request", plan: "the plan", work: "work", reviews: "reviews", packText: pack.text }));
  const testerPrompt = capturedPrompt[0];
  const opposerPrompt = capturedPrompt[1];
  const managerPrompt = capturedPrompt[2];
  const all = [testerPrompt, opposerPrompt, managerPrompt];
  report(
    "10a. every reviewer prompt contains the pack label + disk facts + override + reproduce-rule",
    all.every((p) => p.includes(LABEL) && p.includes("hello world") && p.toLowerCase().includes("override") && p.toLowerCase().includes("reproduce")),
    "",
  );
  report(
    "10b. tester prompt states the tester runs the check command",
    testerPrompt.includes("the tester performs this run") || testerPrompt.toLowerCase().includes("(the tester"),
    testerPrompt.slice(testerPrompt.indexOf(LABEL) - 260, testerPrompt.indexOf(LABEL)),
  );
  report(
    "10c. prompts keep the original stage framing (WHAT THE CODERS REPORTED / VERDICT line)",
    testerPrompt.startsWith("test the thing") && opposerPrompt.startsWith("oppose the thing") && managerPrompt.includes('Reply with the first line exactly "VERDICT: PASS" or "VERDICT: LOOP"'),
    "",
  );
}

// ── 11. behavioural: pipeline early-fails before opposer/manager run ───────
// MOCK_MODE keeps every model stage offline; the fake fs is not injectable into
// runPipeline (real fs is used), so this drives a temp project root.
{
  const { runPipeline } = await import("../src/company/pipeline.js");
  const { createProject } = await import("../src/company/org.js");
  const { createTask, getTask } = await import("../src/company/gates.js");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "f6-nochange-"));
  const proj = createProject({ projectName: "f6 no-change", departmentName: "Engineering", rootDir: path.join(tmp, "repo") });
  const projectId = proj.project.id;
  const request = "# Task\nwrite it\n\n## Files\n- `out/nothing.txt`\n";
  await new Promise((r) => setTimeout(r, 5));
  const t = createTask(projectId, request);
  // Seed a full pre-enhanced state so the run goes straight to the work phase;
  // the coder runs in MOCK_MODE, writes nothing, then the guard must fire.
  const { updateTask } = await import("../src/company/gates.js");
  updateTask(projectId, t.id, {
    enhancedBrief: "Enhanced brief placeholder long enough to be a usable brief for the check.",
    plan: 'DISPATCH: {"assignments":[{"role":"coder","subtask":"create out/nothing.txt"}]}',
    assignments: [{ agentId: "coder-1", role: "coder", subtask: "create out/nothing.txt", modelId: "deepseek-v4-flash" }],
  });
  await runPipeline(projectId, request, { taskId: t.id, auto: true });
  const after = getTask(projectId, t.id);
  report(
    "11. nothing changed on disk -> task failed early with exact reason, opposer/manager never ran",
    after?.status === "failed" &&
      String(after?.error ?? "") === NO_DELIVERABLE_CHANGED_REASON &&
      !after?.review && // the manager review stage never wrote a verdict
      after?.testerStatus === undefined, // the tester/summarizer stage never completed
    `status=${after?.status} error=${String(after?.error ?? "").slice(0, 120)} review=${after?.review ? "present" : "absent"}`,
  );
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${results.every((r) => r.ok) ? "PASS" : "FAIL"} — ${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
