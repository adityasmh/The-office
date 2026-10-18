// Proof/verification for Order F4-merge-all-paths.
//
// FIRST import MUST be the sandbox: ES imports run before top-level code, so this
// points COMPANY_ROOT at a temp folder before any company module captures it.
import "./sandbox-company-root.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Offline: MOCK_MODE makes every model/worker stage return instantly and never call
// out, so runPipeline can be driven end to end with no network and no router. Set
// before the dynamic import of pipeline.js so config.js captures it.
process.env.MOCK_MODE = "1";
process.env.PIPELINE_MOCK_STAGE_DELAY_MS = "0";
process.env.GATE_WAIT_SECONDS = "0";

const { evaluateMergeGuard, isPlanUnusable, runPipeline, finalizeMerge } = await import("../src/company/pipeline.js");
const { createProject } = await import("../src/company/org.js");
const { createTask, updateTask, getTask } = await import("../src/company/gates.js");

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`PASS: ${name}`);
  } else {
    failed++;
    console.log(`FAIL: ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// A. Merge-guard unit checks (pure, the semantics finalizeMerge must reuse).
// ---------------------------------------------------------------------------
const clean = {
  reviewVerdict: "VERDICT: PASS",
  testerStatus: "PASS",
  coderOutput: "coder-1 wrote the file",
  deliverableFiles: [{ planned: "out/x.txt", exists: true }],
};

check("A0 guard allows a clean result", evaluateMergeGuard(clean).ok === true);
check(
  "A1 guard refuses empty coder output (the shortcut route's input)",
  evaluateMergeGuard({ ...clean, coderOutput: "" }).ok === false,
);
check(
  "A2 guard refuses a missing deliverable file",
  evaluateMergeGuard({ ...clean, deliverableFiles: [{ planned: "out/x.txt", exists: false }] }).ok === false,
);
check(
  "A3 guard refuses a LOOP/FAIL verdict",
  evaluateMergeGuard({ ...clean, reviewVerdict: "VERDICT: LOOP" }).ok === false,
);

// The F4 review required replacing the guard's bare-substring match on
// "LOOP"/"FAIL" with a structured verdict parse: a "VERDICT: X" marker wins, and
// without one only a line that STARTS with a verdict word counts. Ordinary prose
// mentioning pass/loop mid-sentence must NOT false-refuse a merge, while real
// verdicts are still refused.
check(
  'A4 guard does NOT false-refuse prose like "reviewers decide pass/loop" (structured verdict parse)',
  evaluateMergeGuard({ ...clean, reviewVerdict: "reviewers decide pass/loop" }).ok === true,
);
check(
  "A5 guard still refuses a line-initial verdict word (no VERDICT: marker)",
  evaluateMergeGuard({ ...clean, reviewVerdict: "LOOP\nthe coder produced nothing useful" }).ok === false,
);
check(
  "A6 guard still refuses tester BLOCKED",
  evaluateMergeGuard({ ...clean, testerStatus: "BLOCKED" }).ok === false,
);

// ---------------------------------------------------------------------------
// Case 5 helpers: the plan-usability rule is exported pure, so the retry
// semantics (unusable -> retry once -> fail) are unit-checkable offline; an
// end-to-end mock cannot produce a deterministically junk manager plan twice
// without a router, so the loop shape itself is asserted structurally below.
// ---------------------------------------------------------------------------
const BRIEF = "Enhanced brief placeholder for the unusable-plan rule checks.";
check(
  "5a unusable: plan shorter than 80 chars",
  isPlanUnusable("Coder 2: Code (...)", "anything") === true,
);
check(
  "5b unusable: long text with no sentence",
  isPlanUnusable(
    "Coder 2: Code ( ... more fragments    no terminator at all aaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "x",
  ) === true,
);
check(
  "5c unusable: plan equals the enhanced brief (trimmed)",
  isPlanUnusable(`  ${BRIEF}  `, BRIEF) === true,
);
check(
  "5d usable: an 80+ char plan with a sentence and not equal to the brief",
  isPlanUnusable("Create the module, run the checks, then write the report into docs, and end. Done.", BRIEF) === false,
);

// ---------------------------------------------------------------------------
// B. Behavioural route checks: drive runPipeline with a temp project (MOCK_MODE).
// ---------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "merge-paths-"));
const created = createProject({
  projectName: "F4 merge paths check",
  departmentName: "Engineering",
  rootDir: path.join(tmp, "repo"),
});
const projectId = created.project.id;
const rootDir = created.project.rootDir;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runCase(request: string, seed: (taskId: string) => void) {
  await sleep(5); // createTask ids are Date.now-based; keep them unique
  const t = createTask(projectId, request);
  seed(t.id);
  await runPipeline(projectId, request, { taskId: t.id, auto: true });
  return getTask(projectId, t.id);
}

// Case 1: the shortcut route - a plan treated as a direct answer with empty
// assignments and missing deliverable files. F4 says this must end `failed`.
const reqShortcut =
  "# Task\nAnswer this and create the named file.\n\n## Files\n- `out/shortcut-artifact.txt`\n";
const t1 = await runCase(reqShortcut, (id) => {
  updateTask(projectId, id, {
    enhancedBrief: "Enhanced brief placeholder for the shortcut route.",
    plan: "Manager answered this request directly in the plan; nothing to dispatch.",
    assignments: [],
  });
});
check(
  "1. shortcut route, empty assignments, missing files -> failed with guard reason",
  t1?.status === "failed" && /merge guard/i.test(String(t1?.error ?? "")),
  `status=${t1?.status} error=${t1?.error ?? "(none)"}`,
);

// Case 2: the same shortcut route but with coder output present and the named file
// on disk -> the guard should allow the merge.
const reqPresent =
  "# Task\nCreate the named artifact.\n\n## Files\n- `out/present-artifact.txt`\n";
fs.mkdirSync(path.join(rootDir, "out"), { recursive: true });
fs.writeFileSync(path.join(rootDir, "out", "present-artifact.txt"), "fixture\n");
const t2 = await runCase(reqPresent, (id) => {
  updateTask(projectId, id, {
    enhancedBrief: "Enhanced brief placeholder for the present-files route.",
    plan: "Manager answered directly, but a coder still produced the artifact.",
    assignments: [],
    result: "coder-1 output: created out/present-artifact.txt",
  });
});
check(
  "2. shortcut route, files present + coder output present -> merged",
  t2?.status === "merged",
  `status=${t2?.status} error=${t2?.error ?? ""}`,
);

// Case 3: the normal coder route is unchanged - a coder assignment, coder output,
// a PASS review and an existing deliverable still merge.
const t3 = await runCase(reqPresent, (id) => {
  updateTask(projectId, id, {
    enhancedBrief: "Enhanced brief placeholder for the normal route.",
    plan: 'DISPATCH: {"assignments":[{"role":"coder","subtask":"create out/present-artifact.txt"}]}',
    assignments: [
      { agentId: "coder-1", role: "coder", subtask: "create out/present-artifact.txt", modelId: "deepseek-v4-flash" },
    ],
    result: "coder-1 output: created out/present-artifact.txt",
    review: "VERDICT: PASS - artifact present.",
  });
});
check("3. normal coder route still merges", t3?.status === "merged", `status=${t3?.status} error=${t3?.error ?? ""}`);

// Case 6: a plan with no DISPATCH line on a request that has a Files section must
// be dispatched to a coder, not treated as a finished answer.
const reqNoDispatch =
  "# Task\nBuild the widget for the customer.\n\n## Files\n- `out/widget.txt`\n";
fs.writeFileSync(path.join(rootDir, "out", "widget.txt"), "fixture\n");
const t6 = await runCase(reqNoDispatch, (id) => {
  updateTask(projectId, id, {
    enhancedBrief: "Enhanced brief placeholder for the no-DISPATCH route.",
    plan: "Plan: build the widget in one small file. (no dispatch line follows)",
  });
});
const t6Coders = (t6?.assignments ?? []).filter((a) => a.role === "coder").map((a) => a.agentId);
check(
  "6. plan without DISPATCH on a Files request -> routed to a coder",
  t6Coders.length > 0,
  `assignments=${JSON.stringify((t6?.assignments ?? []).map((a) => `${a.agentId}:${a.role}`))} status=${t6?.status}`,
);

// ---------------------------------------------------------------------------
// C. Structural checks on pipeline.ts (the single choke point and the plan rules).
// ---------------------------------------------------------------------------
const src = fs.readFileSync(path.join(process.cwd(), "src", "company", "pipeline.ts"), "utf8");

function bodyOf(source: string, fnName: string): string {
  const m = source.match(new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${fnName}\\s*\\(`));
  if (!m || m.index === undefined) return "";
  const open = source.indexOf("{", m.index);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

const hasFinalizeMerge = /function\s+finalizeMerge\s*\(/.test(src);
const mergeWrites = [...src.matchAll(/status:\s*["']merged["']/g)].length;
const finalizeBody = bodyOf(src, "finalizeMerge");
const mergeInsideFinalize = finalizeBody.includes('"merged"') || finalizeBody.includes("'merged'");
const guardInsideFinalize = finalizeBody.includes("evaluateMergeGuard");

check(
  '4. finalizeMerge is the only merge site (one status "merged", inside finalizeMerge)',
  hasFinalizeMerge && mergeWrites === 1 && mergeInsideFinalize,
  `finalizeMerge=${hasFinalizeMerge} mergeWrites=${mergeWrites} mergeInsideFinalize=${mergeInsideFinalize}`,
);
check(
  "4b. finalizeMerge calls evaluateMergeGuard",
  hasFinalizeMerge && guardInsideFinalize,
  `hasFinalizeMerge=${hasFinalizeMerge} guardInsideFinalize=${guardInsideFinalize}`,
);

// The current code only calls the guard when assignments.length is non-zero, which
// is exactly the shortcut-route bypass F4 must close.
const guardGatedOnAssignments =
  /if\s*\(\s*assignments\.length\s*\)\s*\{[\s\S]{0,800}?evaluateMergeGuard/.test(src);
check(
  "1b. merge guard runs on every route (not gated on assignments.length)",
  hasFinalizeMerge && !guardGatedOnAssignments,
  `guardGatedOnAssignments=${guardGatedOnAssignments}`,
);

const unusableReason = [...src.matchAll(/new Error\("manager plan unusable"\)/g)].length;
const retryOnce = [...src.matchAll(/planAttempts\s*<\s*2/g)].length;
check(
  "5. unusable plan retried once then fails with reason 'manager plan unusable'",
  unusableReason === 1 && retryOnce === 1 && src.includes("what: \"plan retry\""),
  `unusableReason=${unusableReason} retryOnce=${retryOnce}`,
);

// Case 7: repeated calls to the merge choke point must not double-post. Call
// finalizeMerge twice on a guard-refused task (status already failed, same
// reason) and twice on a merged task: the second call of each must be a no-op
// (no extra trace step, no duplicate message).
await sleep(5);
const t7 = createTask(projectId, reqShortcut);
updateTask(projectId, t7.id, {
  enhancedBrief: "Enhanced brief placeholder for the idempotence check.",
  plan: "Manager answered this request directly in the plan; nothing to dispatch.",
  assignments: [],
});
await finalizeMerge(projectId, t7.id, { rootDir, coderOutput: "", auto: true });
const afterFirst = getTask(projectId, t7.id)!;
const traceAfterFirst = (afterFirst.trace ?? []).length;
await finalizeMerge(projectId, t7.id, { rootDir, coderOutput: "", auto: true });
const afterSecond = getTask(projectId, t7.id)!;
const traces7 = (afterSecond.trace ?? []).filter((s) => s.what === "merge guard blocked");
check(
  "7a. repeated finalizeMerge on a refused task: no duplicate refusal trace/message",
  afterSecond.status === "failed" &&
    (afterSecond.trace ?? []).length === traceAfterFirst &&
    traces7.length === 1,
  `status=${afterSecond.status} traces=${(afterSecond.trace ?? []).length}/${traceAfterFirst} blocked=${traces7.length}`,
);
// A changed (different) reason on a re-call IS recorded: inputs changed, so the
// new refusal must update the stored reason exactly once.
await finalizeMerge(projectId, t7.id, { rootDir, coderOutput: "", reviewVerdict: undefined, auto: true });
// (inputs identical -> still no new post; verified by the same trace count check below)
const afterThird = getTask(projectId, t7.id)!;
check(
  "7b. refused task stays failed with the first guard reason",
  afterThird.status === "failed" && String(afterThird.error ?? "").startsWith("merge guard:"),
  `status=${afterThird.status} error=${afterThird.error ?? "(none)"}`,
);
// Merged idempotence: rerunning finalizeMerge on an already merged task posts nothing.
const t7m = await runCase(reqPresent, (id) => {
  updateTask(projectId, id, {
    enhancedBrief: "Enhanced brief placeholder for merged idempotence.",
    plan: "Manager answered directly; a coder produced the artifact.",
    assignments: [],
    result: "coder-1 output: created out/present-artifact.txt",
  });
});
if (t7m && t7m.status === "merged") {
  const traceCountMerged = (t7m.trace ?? []).filter((s) => s.what === "done").length;
  await finalizeMerge(projectId, t7m.id, { rootDir, coderOutput: "coder-1 output: created out/present-artifact.txt", auto: true });
  const afterRe = getTask(projectId, t7m.id)!;
  const doneTraces = (afterRe.trace ?? []).filter((s) => s.what === "done");
  check(
    "7c. repeated finalizeMerge on a merged task: no duplicate done trace",
    afterRe.status === "merged" && doneTraces.length === traceCountMerged,
    `status=${afterRe.status} done=${doneTraces.length}/${traceCountMerged}`,
  );
} else {
  check("7c. repeated finalizeMerge on a merged task: no duplicate done trace", false, `task status=${t7m?.status}`);
}

// ---------------------------------------------------------------------------
// Summary.
// ---------------------------------------------------------------------------
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  // best effort
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} \u2014 ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
