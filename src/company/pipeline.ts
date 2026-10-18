import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { config } from "../config.js";
import { getProject, ensureProjectDir, appendMessage, readThread, loadOrg, withTeamConfig } from "./org.js";
import type { AgentType, RoleId } from "./org.js";
import { ROLES } from "./roles.js";
import { chooseAgent, chooseWorkerModel, escalationAllowed, type Assignment } from "./dispatch.js";
import { runAgent, runParallel, type TaskContext, type WorkerEvent } from "./workers.js";
import { createTask, updateTask, getTask, loadTasks, addTrace, IN_MOTION, type TaskRec } from "./gates.js";
import { postAs, personaForRoute, notifyGate, notifyMerged } from "../slack.js";
import { projectContext } from "./knowledge.js";

// Task lifecycle engine with 3 human gates. Claude (the manager, run through
// Claude Code) is the brain: it plans, decides the dispatch, and reviews the
// work before merge. Laya is only the fallback dispatcher when the plan carries
// no usable DISPATCH line. Every step appends to project thread + Slack mirror.
//
// Resumable: each stage is skipped when its output is already on the task, so
// re-running a task (gate approved late, server restarted) continues where it
// stopped instead of redoing work. Any thrown error marks the task "failed".

export type PipelineHandle = {
  projectId: string;
  taskId: string;
  events: WorkerEvent[];
  task: TaskRec;
};

type PipelineOpts = {
  taskId?: string;
  taskHint?: string;
  auto?: boolean; // if true, skip gates (dangerous but for autonomous runs)
  onEvent?: (ev: WorkerEvent) => void;
  // Called once the task settles (merged or failed) so the caller - the CEO
  // assistant - can report the result back up the chain.
  onFinish?: (task: TaskRec) => void;
};

const MANAGER = "Claude (manager)";

// opencode workers emit one JSON event per line; keep only what the model said.
function readable(text: string | undefined): string {
  const said: string[] = [];
  for (const line of (text ?? "").split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      const ev = JSON.parse(s) as { type?: string; part?: { text?: string } };
      if (ev.type === "text" && ev.part?.text) said.push(ev.part.text);
    } catch {
      // partial line
    }
  }
  return said.length ? said.join("\n").trim() : (text ?? "");
}

// A verdict word at the START of a line (allowing `>`/`-`/`*` quote markers)
// is treated as a verdict; mid-sentence wording never is.
function lineStartVerdict(text: string): string {
  const m = text.match(/^[\s>#*-]*\b(PASS|LOOP|FAIL|BLOCKED)\b/m);
  return (m?.[1] ?? "").toUpperCase();
}

export function evaluateMergeGuard(input: {
  reviewVerdict: string;
  testerStatus: string;
  coderOutput: string;
  deliverableFiles: { planned: string; exists: boolean }[];
}): { ok: boolean; reason?: string } {
  // STRUCTURED VERDICT PARSE (review fix on F4): a "VERDICT: X" marker wins; only
  // when there is no marker does a line that STARTS with a verdict word count.
  // Ordinary prose mentioning pass/loop mid-sentence ("decide pass/loop") is not a
  // verdict, so it can no longer false-refuse a merge, while real LOOP/FAIL
  // verdicts are refused exactly as before.
  const verdictText = String(input.reviewVerdict ?? "");
  const verdict = (verdictText.match(/VERDICT:\s*(PASS|LOOP|FAIL|BLOCKED)\b/i)?.[1] ?? lineStartVerdict(verdictText)).toUpperCase();
  if (verdict === "LOOP" || verdict === "FAIL") {
    return { ok: false, reason: "merge guard: review verdict is LOOP or FAIL" };
  }
  const tester = String(input.testerStatus ?? "").toUpperCase();
  if (/^(BLOCKED|FAIL)\b/.test(tester)) {
    return { ok: false, reason: "merge guard: tester reported BLOCKED or FAIL" };
  }
  const coder = (input.coderOutput ?? "").trim();
  if (!coder || coder.toUpperCase().includes("NO CODER RAN")) {
    return { ok: false, reason: "merge guard: no coder produced output" };
  }
  const missing = (input.deliverableFiles ?? []).filter((f) => !f.exists);
  if (missing.length) {
    return { ok: false, reason: `merge guard: deliverable file(s) missing: ${missing.map((f) => f.planned).join(", ")}` };
  }
  return { ok: true };
}

export function parseDeliverableFiles(request: string): string[] {
  const section = request.match(/##\s*Files\s*\n([\s\S]*?)(?:\n##\s|\n###\s|$)/i);
  if (!section) return [];
  const files: string[] = [];
  for (const m of section[1].matchAll(/`([^`]+)`/g)) {
    files.push(m[1]);
  }
  return files;
}

// ── Order F6-reviewer-inputs ────────────────────────────────────────────────
// The tester, opposer and manager previously judged work only from the coder's
// own summary. The ReviewPack assembles what is actually true on disk: file
// metadata, the content of files changed since the task started, the coder's
// report file and the tail of the coder's raw output. It is a pure function so
// the proof script can drive it with a fake fs; outside effects (reads, git)
// go through the injected hooks, all confined to the task root.

export const REVIEW_PACK_LABEL = "FACTS FROM DISK (authoritative)";
export const REVIEW_PACK_RULES =
  "Disk facts above override the coder's summary wherever they disagree. A claimed PASS must be reproduced by running the check command named in the request before it is accepted (the tester performs this run).";
export const NO_DELIVERABLE_CHANGED_REASON = "merge guard: no deliverable changed on disk";

// Order F7-no-scope-creep: every review stage gets the raw order text under a
// fixed label and is told to judge ONLY against the order's own Files list and
// Proof section. The shared handoff text lives in handoff.ts; re-exported here
// so the pipeline and the proof script keep importing from pipeline.js.
export {
  ORIGINAL_ORDER_LABEL,
  TESTER_ORDER_RULE,
  MANAGER_ORDER_RULE,
} from "./handoff.js";
import {
  ORIGINAL_ORDER_LABEL,
  TESTER_ORDER_RULE,
  MANAGER_ORDER_RULE,
} from "./handoff.js";

const REVIEW_PACK_LINES = 300;
const REVIEW_PACK_CHARS_PER_FILE = 20000;
const REVIEW_PACK_CHARS_TOTAL = 60000;
const REVIEW_PACK_TAIL_LINES = 80;
const REVIEW_PACK_REPORT_CHARS = 20000;

export type ReviewPackFs = {
  existsSync(p: string): boolean;
  statSync(p: string): { size: number; mtimeMs: number; isFile(): boolean };
  readFileSync(p: string): Buffer;
  readdirSync?(p: string): string[];
};

export type ReviewPackEntry = {
  path: string;
  exists: boolean;
  missing?: boolean;
  changed?: boolean; // exists and mtime >= task start
  size?: number;
  lastWriteTime?: string;
  reason?: string; // why there is no content: missing / outside root / unchanged / binary / error
  truncated?: string; // what was removed when caps cut the content
  content?: string;
};

export type ReviewPack = {
  status: "ok" | "nothing-changed";
  text: string;
  entries: ReviewPackEntry[];
};

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function insideRoot(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || rel.startsWith("../") || path.isAbsolute(rel)) return false;
  return true;
}

function capLines(text: string): { body: string; truncated?: string } {
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop(); // a trailing newline is not a line
  if (lines.length <= REVIEW_PACK_LINES) return { body: lines.join("\n") };
  return {
    body: lines.slice(0, REVIEW_PACK_LINES).join("\n"),
    truncated: `truncated: lines ${REVIEW_PACK_LINES + 1}..${lines.length} removed (${lines.length - REVIEW_PACK_LINES} line(s) beyond the ${REVIEW_PACK_LINES}-line cap)`,
  };
}

function capCharsPerFile(text: string): { body: string; truncated?: string } {
  if (text.length <= REVIEW_PACK_CHARS_PER_FILE) return { body: text };
  return {
    body: text.slice(0, REVIEW_PACK_CHARS_PER_FILE),
    truncated: `truncated: last ${text.length - REVIEW_PACK_CHARS_PER_FILE} character(s) removed beyond the ${REVIEW_PACK_CHARS_PER_FILE}-char per-file cap`,
  };
}

export function defaultGitStat(root: string): string | undefined {
  try {
    const probe = spawnSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", windowsHide: true });
    if (probe.status !== 0 || String(probe.stdout ?? "").trim() !== "true") return undefined;
    const diff = spawnSync("git", ["-C", root, "diff", "--stat"], { encoding: "utf8", windowsHide: true });
    if (diff.status !== 0) return undefined;
    const out = String(diff.stdout ?? "");
    return out.trim() === "" ? undefined : out;
  } catch {
    return undefined;
  }
}

export function buildReviewPack(input: {
  root: string;
  files: string[];
  taskStartMs: number;
  coderOutput: string;
  taskId: string;
  fs?: ReviewPackFs;
  gitStat?: (root: string) => string | undefined;
}): ReviewPack {
  const f: ReviewPackFs = input.fs ?? {
    existsSync: (p) => fs.existsSync(p),
    statSync: (p) => fs.statSync(p),
    readFileSync: (p) => fs.readFileSync(p),
    readdirSync: (p) => fs.readdirSync(p),
  };
  const gitStat = input.gitStat ?? defaultGitStat;
  const root = path.resolve(input.root);
  const entries: ReviewPackEntry[] = [];
  const bodies = new Map<ReviewPackEntry, string>();

  for (const listed of input.files ?? []) {
    const abs = path.resolve(root, listed);
    if (!insideRoot(root, abs)) {
      entries.push({ path: listed, exists: false, reason: "rejected: outside the task root" });
      continue;
    }
    let meta: { size: number; mtimeMs: number };
    try {
      const st = f.statSync(abs);
      if (!st.isFile()) throw Object.assign(new Error("not a regular file"), { code: "ENOENT" });
      meta = { size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      entries.push({ path: listed, exists: false, missing: true, reason: "missing" });
      continue;
    }
    // mtime exactly equal to the task start counts as changed (>= is deliberate).
    const changed = meta.mtimeMs >= input.taskStartMs;
    const entry: ReviewPackEntry = {
      path: listed,
      exists: true,
      size: meta.size,
      lastWriteTime: new Date(meta.mtimeMs).toISOString(),
      changed,
    };
    entries.push(entry);
    if (!changed) {
      entry.reason = "unchanged since task start (no content shown)";
      continue;
    }
    let buf: Buffer;
    try {
      buf = f.readFileSync(abs);
    } catch (e) {
      entry.reason = `unreadable: ${String((e as Error)?.message ?? e).slice(0, 120)}`;
      continue;
    }
    if (looksBinary(buf)) {
      entry.reason = `binary file: content skipped (${buf.length} bytes, NUL byte in the first 8000)`;
      continue;
    }
    if (buf.length === 0) {
      entry.reason = "empty file (0 bytes): no content";
      continue;
    }
    const lineCut = capLines(buf.toString("utf8"));
    const charCut = capCharsPerFile(lineCut.body);
    const marks = [lineCut.truncated, charCut.truncated].filter(Boolean) as string[];
    if (marks.length) entry.truncated = marks.join("; ");
    bodies.set(entry, charCut.body);
  }

  // Total cap, largest files truncated first: walk the bodies biggest-first and
  // cut (or drop whole) each until the sum fits. Deterministic: equal lengths
  // keep the listed order. Markers name exactly what was removed.
  const ordered = [...bodies.keys()];
  let total = 0;
  for (const e of ordered) total += bodies.get(e)!.length;
  const desc = [...ordered].sort(
    (a, b) => bodies.get(b)!.length - bodies.get(a)!.length || ordered.indexOf(a) - ordered.indexOf(b),
  );
  for (const e of desc) {
    if (total <= REVIEW_PACK_CHARS_TOTAL) break;
    const len = bodies.get(e)!.length;
    const over = total - REVIEW_PACK_CHARS_TOTAL;
    if (len <= over) {
      e.truncated = e.truncated ? `${e.truncated}; ` : "";
      e.truncated += `truncated: all ${len} character(s) removed to fit the ${REVIEW_PACK_CHARS_TOTAL}-char total cap (largest files are cut first)`;
      bodies.set(e, "");
      total -= len;
      continue;
    }
    e.truncated = e.truncated ? `${e.truncated}; ` : "";
    e.truncated += `truncated: last ${over} character(s) removed to fit the ${REVIEW_PACK_CHARS_TOTAL}-char total cap (largest files are cut first)`;
    bodies.set(e, bodies.get(e)!.slice(0, len - over));
    total = REVIEW_PACK_CHARS_TOTAL;
  }

  // Section C: the coder's report file for this task id (first in sorted order).
  const repDir = path.join(root, "docs", "reports");
  let reportBlock = `docs/reports/REPORT_${input.taskId}*.md: (no matching report file)`;
  try {
    const names = (f.readdirSync ? f.readdirSync(repDir) : fs.readdirSync(repDir))
      .filter((n) => n.startsWith(`REPORT_${input.taskId}`) && n.endsWith(".md"))
      .sort();
    if (names.length) {
      const buf = f.readFileSync(path.join(repDir, names[0]));
      if (looksBinary(buf)) {
        reportBlock = `${names[0]}: (report matched but is binary - content skipped)`;
      } else {
        const raw = buf.toString("utf8");
        const capped =
          raw.length > REVIEW_PACK_REPORT_CHARS
            ? `${raw.slice(0, REVIEW_PACK_REPORT_CHARS)}\n[truncated: last ${raw.length - REVIEW_PACK_REPORT_CHARS} character(s) removed beyond the ${REVIEW_PACK_REPORT_CHARS}-char report cap]`
            : raw;
        reportBlock = `${names.length > 1 ? `${names[0]} (first of ${names.length} sorted matches)` : names[0]}\n${capped}`;
      }
    }
  } catch {
    // no docs/reports dir or unreadable -> stays "(no matching report file)"
  }

  // Section D: last 80 lines of the coder output (short/empty handled).
  const outLines = String(input.coderOutput ?? "").split(/\r?\n/);
  if (outLines.length && outLines[outLines.length - 1] === "") outLines.pop();
  const tail = outLines.length ? outLines.slice(-REVIEW_PACK_TAIL_LINES).join("\n") : "(coder output empty)";

  const sectionA = entries.length
    ? entries.map((e) =>
        !e.exists
          ? `- ${e.path}: ${e.reason ?? "missing"}`
          : `- ${e.path}: exists, ${e.size ?? 0} bytes, last write ${e.lastWriteTime ?? "?"}, changed since task start: ${e.changed ? "yes" : "no"}${e.reason ? ` (${e.reason})` : ""}${e.truncated ? `; ${e.truncated}` : ""}`,
      )
    : ["(no files listed in the request)"];

  const sectionB: string[] = [];
  if (!ordered.length) {
    sectionB.push("(no listed file changed since the task start)");
  } else {
    for (const e of ordered) {
      const body = bodies.get(e)!;
      sectionB.push(`--- FILE: ${e.path} (${e.size ?? 0} bytes, mtime ${e.lastWriteTime ?? "?"})${e.truncated ? `\n[${e.truncated}]` : ""}`);
      sectionB.push(body || "(content removed by the total cap; see marker above)");
    }
  }
  let gitLine: string;
  try {
    const stat = gitStat(root);
    gitLine = stat ? `--- git diff --stat ---\n${stat.trim()}` : "(git diff --stat omitted: not a git repository or git unavailable)";
  } catch {
    gitLine = "(git diff --stat omitted: not a git repository or git unavailable)";
  }

  const text = [
    REVIEW_PACK_LABEL,
    "",
    "A. LISTED FILES",
    ...sectionA,
    "",
    `B. CONTENT OF FILES CHANGED SINCE TASK START (first ${REVIEW_PACK_LINES} lines/file, ${REVIEW_PACK_CHARS_PER_FILE} chars/file, ${REVIEW_PACK_CHARS_TOTAL} chars total, largest truncated first)`,
    ...sectionB,
    gitLine,
    "",
    `C. CODER REPORT (docs/reports/REPORT_${input.taskId}*.md, first in sorted order)`,
    reportBlock,
    "",
    `D. CODER OUTPUT (last ${REVIEW_PACK_TAIL_LINES} lines)`,
    tail,
  ].join("\n");

  const changedCount = entries.filter((e) => e.changed === true).length;
  const status: ReviewPack["status"] = (input.files ?? []).length > 0 && changedCount === 0 ? "nothing-changed" : "ok";
  return { status, text, entries };
}

// The three prompt builders are exported so the proof script can assert on the
// exact strings the pipeline sends (Order F6 acceptance criterion 9).
export function buildTesterPrompt(input: { subtask: string; brief: string; work: string; packText: string; request?: string }): string {
  return `${input.subtask}

WHAT THE CODERS REPORTED:
${input.work || "(no coder ran)"}

${ORIGINAL_ORDER_LABEL}:
${String(input.request ?? "")}

${TESTER_ORDER_RULE}

ENHANCED BRIEF (context only; acceptance is the ${ORIGINAL_ORDER_LABEL} section above):
${input.brief.slice(0, 3000)}

The ${REVIEW_PACK_LABEL} section below is ground truth: disk facts override the coder's summary wherever they disagree. A claimed PASS must be reproduced by running the check command named in the request before it is accepted (the tester performs this run).

${input.packText}`;
}

export function buildOpposerPrompt(input: { subtask: string; brief: string; work: string; packText: string }): string {
  return `${input.subtask}

WHAT THE CODERS REPORTED:
${input.work || "(no coder ran)"}

ACCEPTANCE (from the brief):
${input.brief.slice(0, 3000)}

The ${REVIEW_PACK_LABEL} section below is ground truth: disk facts override the coder's summary wherever they disagree. A claimed PASS must be reproduced by running the check command named in the request before it is accepted (the tester performs this run).

${input.packText}`;
}

export function buildManagerReviewPrompt(input: { request: string; plan: string; work: string; reviews: string; packText: string }): string {
  return `Review this task's outcome. You can read the files the coders wrote.

REQUEST:
${input.request}

${ORIGINAL_ORDER_LABEL}:
${String(input.request ?? "")}

${MANAGER_ORDER_RULE}

YOUR PLAN:
${input.plan}

CODERS:
${input.work}

TESTER/OPPOSER:
${input.reviews}

${input.packText}

${REVIEW_PACK_LABEL} is ground truth above: disk facts override the coder's summary wherever they disagree. When the tester claims a PASS, it must have been reproduced by running the check command named in the request.

Reply with the first line exactly "VERDICT: PASS" or "VERDICT: LOOP", then a short justification. If LOOP, list the precise fixes the coders must make.`;
}

// Early-fail guard (Order F6 item 3): fires BEFORE the tester/opposer/manager
// stages when the request named at least one deliverable and none of them
// changed since the task started (entries come straight from buildReviewPack,
// whose status is exactly this check). Reuses the merge-guard reason format.
export function evaluateNoChangeGuard(input: {
  listedDeliverables: string[];
  entries: ReviewPackEntry[];
}): { ok: boolean; reason?: string } {
  if (!input.listedDeliverables.length) return { ok: true }; // zero listed files never fires
  const anyChanged = input.entries.some((e) => e.changed === true);
  if (!anyChanged) return { ok: false, reason: NO_DELIVERABLE_CHANGED_REASON };
  return { ok: true };
}

// Order F4 rule 3: a plan that is a failed/incomplete model call must never be
// treated as an answer. Unusable = shorter than 80 chars, OR containing no
// sentence, OR equal to the enhanced brief (both sides trimmed first, so
// whitespace-only differences still count as "equals"). A sentence = a segment
// of at least 25 characters ending in . ! or ? with at least 5 word-like
// tokens, so junk like "Coder 2: Code (...)" (no space-separated prose) is not
// a sentence. Exported for the offline proof script.
export function isPlanUnusable(plan: string | undefined, brief: string): boolean {
  const text = String(plan ?? "").trim();
  if (text.length < 80) return true; // too short to be a real plan or answer
  let hasSentence = false;
  for (const seg of text.match(/[^.!?]+[.!?]/g) ?? []) {
    const words = seg.trim().split(/\s+/).filter((w) => /\w/.test(w));
    if (seg.trim().length >= 25 && words.length >= 5) {
      hasSentence = true;
      break;
    }
  }
  if (!hasSentence) return true; // no sentence
  return text === String(brief ?? "").trim(); // just echoes the enhanced brief
}

// Order F4: the single merge doorway. This is the ONLY code in pipeline.ts that
// may set status "merged" or post the merge message, and it evaluates the merge
// guard on EVERY route - including the shortcut route where the plan was treated
// as a finished answer and no coder ran (there coderOutput is "" and the guard
// must refuse). A refusal sets status "failed" with the guard's reason and posts
// exactly one thread message.
export type FinalizeMergeInput = {
  rootDir: string; // project root the deliverable files are checked against
  coderOutput?: string; // "" on the shortcut route -> the guard refuses
  testerStatus?: string;
  reviewVerdict?: string;
  auto?: boolean; // true skips GATE 3, as before
};

// OS-separator safe (Windows: request text uses "/", disk uses "\") and rooted:
// a planned path that escapes the project root is treated as missing, never as
// a real deliverable.
function fileExistsUnderRoot(rootDir: string, planned: string): boolean {
  const rel = String(planned ?? "").trim().replace(/^[\\/]+/, "");
  if (!rel) return false;
  const abs = path.resolve(rootDir, ...rel.split(/[\\/]+/));
  const root = path.resolve(rootDir);
  if (path.relative(root, abs).startsWith(`..${path.sep}`) || path.relative(root, abs) === ".." || path.isAbsolute(path.relative(root, abs))) {
    return false;
  }
  try {
    return fs.existsSync(abs) && fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

export async function finalizeMerge(projectId: string, taskId: string, input: FinalizeMergeInput): Promise<void> {
  const task = getTask(projectId, taskId);
  if (!task || task.status === "merged" || task.status === "rejected") return; // already terminal - idempotent
  const deliverableFiles = parseDeliverableFiles(String(task.rawRequest ?? "")).map((planned) => ({
    planned,
    exists: fileExistsUnderRoot(input.rootDir, planned),
  }));
  const guard = evaluateMergeGuard({
    reviewVerdict: String(input.reviewVerdict ?? ""),
    testerStatus: String(input.testerStatus ?? "PASS"),
    coderOutput: String(input.coderOutput ?? ""),
    deliverableFiles,
  });
  if (!guard.ok) {
    // Idempotent refusal: a repeated finalizeMerge for the same task must not
    // post a duplicate refusal message (the guard reason is stored verbatim on
    // the failed task, so a same-reason re-call is a no-op; a DIFFERENT reason
    // - inputs changed between calls - is recorded as a new refusal).
    if (task.status === "failed" && task.error === guard.reason) return;
    updateTask(projectId, taskId, { status: "failed", error: guard.reason });
    addTrace(projectId, taskId, { from: MANAGER, to: "Assistant", what: "merge guard blocked", detail: guard.reason });
    await log(projectId, "system", "manager", "error", `Task ${taskId} ${guard.reason}`);
    return;
  }
  // GATE 3 - before merge (moved here so every route passes the guard first).
  if (!task.gates.merge && !input.auto) {
    updateTask(projectId, taskId, { status: "pending_merge" });
    if (!(await waitGate("merge", task, false))) return;
  }
  updateTask(projectId, taskId, { status: "merged" });
  addTrace(projectId, taskId, { from: MANAGER, to: "Assistant", what: "done", detail: (task.result ?? "").slice(0, 500) });
  await log(projectId, "system", "manager", "merge", `Task ${taskId} merged.`);
  void notifyMerged({
    projectId,
    taskId,
    title: String(task.rawRequest ?? ""),
    detail: (task.result ?? "").slice(0, 400),
  });
}

// Task ids with a live pipeline in this process.
const active = new Set<string>();

export function isPipelineActive(taskId: string): boolean {
  return active.has(taskId);
}

const MAX_REVIEW_LOOPS = Number(process.env.PIPELINE_MAX_LOOPS ?? 1);
// How long a pipeline waits at a gate before parking. A parked task is picked
// up again by resumeTask() when the gate is approved.
const GATE_WAIT_MS = Number(process.env.GATE_WAIT_SECONDS ?? 600) * 1000;

// Isolated-drill pacing (docs/RESUME_SPEC.md §5, ops only). With MOCK_MODE on, every
// model stage returns instantly, so a whole run finishes in milliseconds and an ops
// restart drill cannot kill the router *inside* a stage. PIPELINE_MOCK_STAGE_DELAY_MS
// holds each in-motion stage for that long - and is a no-op unless MOCK_MODE is on,
// so production behaviour cannot change by setting it by accident. Default 0.
const mockStageDelayMs = () => {
  if (!config.mockMode) return 0;
  const n = Number(process.env.PIPELINE_MOCK_STAGE_DELAY_MS ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
async function holdMockStage(): Promise<void> {
  const ms = mockStageDelayMs();
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}

async function log(projectId: string, agentId: string, role: string, kind: string, text: string, slackThread?: string) {
  const entry = { ts: new Date().toISOString(), agent: agentId, role, kind, text };
  appendMessage(projectId, entry);
  // Mirror to Slack with the right persona (best-effort, non-blocking).
  if (!config.mockMode) {
    void postAs(personaForRoute(role === "manager" ? "claude-subscription" : "gateway", ROLES[role as keyof typeof ROLES]?.defaultModel ?? ""), `${role}: ${text.slice(0, 1500)}`, slackThread).catch(() => {});
  }
  return entry;
}

async function waitGate(gate: "intake" | "code" | "merge", task: TaskRec, auto: boolean): Promise<boolean> {
  if (auto) return true;
  if (getTask(task.projectId, task.id)?.gates[gate]) return true;
  // A human has to act: put it in front of the CEO on Slack with the exact
  // approve path (best effort - the mirror must never block the gate poll).
  void notifyGate(gate, {
    projectId: task.projectId,
    taskId: task.id,
    title: String(task.rawRequest ?? ""),
    status: getTask(task.projectId, task.id)?.status ?? task.status,
  });
  // Poll the gate flag without blocking the event loop.
  const deadline = Date.now() + GATE_WAIT_MS;
  while (Date.now() < deadline) {
    const t = getTask(task.projectId, task.id);
    if (t && t.gates[gate]) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false; // parked; approving the gate later resumes via resumeTask()
}

// The manager ends its plan with one machine-readable line:
//   DISPATCH: {"assignments":[{"role":"coder","subtask":"..."}]}
// Coders are spread round-robin over the team's coders.
function parseManagerDispatch(plan: string, agents: AgentType[]): Assignment[] {
  const m = plan.match(/DISPATCH:\s*(\{[\s\S]*\})\s*$/m) ?? plan.match(/DISPATCH:\s*(\{[\s\S]*?\})\s*(?:\n|$)/);
  if (!m) return [];
  let parsed: { assignments?: Array<{ role?: string; subtask?: string }> };
  try {
    parsed = JSON.parse(m[1]);
  } catch {
    return [];
  }
  const coders = agents.filter((a) => a.role === "coder");
  let ci = 0;
  const out: Assignment[] = [];
  for (const a of parsed.assignments ?? []) {
    if (!a.role || !a.subtask) continue;
    // Pipeline-stage roles never run in the work phase.
    if (a.role === "manager" || a.role === "prompt-enhancer" || a.role === "summarizer" || a.role === "assistant") continue;
    let agent: AgentType | undefined;
    if (a.role === "coder" && coders.length) agent = coders[ci++ % coders.length];
    else agent = agents.find((x) => x.role === a.role);
    if (agent) out.push({ agentId: agent.id, role: agent.role, subtask: a.subtask });
  }
  return out;
}

const DISPATCH_INSTRUCTIONS = (agents: AgentType[]) => {
  const coders = agents.filter((a) => a.role === "coder").length;
  return `\n\nYou are the brain of this team. You can read the project files (Read/Glob/Grep) - look before you plan.
Team: ${coders} coder(s) (implement with real file edits, each in its own subfolder agents/coder-N of the project), 1 tester (runs checks AFTER coders finish), 1 opposer (reviews AFTER coders finish).
If the request needs no code (a report, a status summary, a decision), answer it fully yourself in the PLAN and dispatch nothing.
End your reply with exactly one final line, valid JSON, no code fence:
DISPATCH: {"assignments":[{"role":"coder","subtask":"precise self-contained work order incl. exact file paths"}]}
Use "assignments":[] when no work should be dispatched. Give coders distinct, non-overlapping subtasks; only use 2 coders when the work genuinely splits.`;
};

export async function runPipeline(projectId: string, rawRequest: string, opts: PipelineOpts = {}): Promise<PipelineHandle> {
  rawRequest = String(rawRequest ?? "");
  const stored = getProject(projectId);
  if (!stored) throw new Error(`project not found: ${projectId}`);
  // PER-PROJECT TEAM CONFIG (docs/PROJECT_TEAM_SPEC.md): `team.coders` sets how
  // many coder agents this project's team has. withTeamConfig reconciles the
  // roster (no coders config -> the same object, so nothing changes); the
  // reconciled copy is what the stages build their agents from. ensureProjectDir
  // then creates the workdir of any coder this adds, so an added coder is
  // immediately usable.
  const project = withTeamConfig(stored);
  ensureProjectDir(project);
  const events: WorkerEvent[] = [];
  const onEvent = opts.onEvent ?? ((ev: WorkerEvent) => { events.push(ev); });
  const task = opts.taskId ? getTask(projectId, opts.taskId) ?? createTask(projectId, rawRequest) : createTask(projectId, rawRequest);
  const handle = () => ({ projectId, taskId: task.id, events, task: getTask(projectId, task.id)! });

  if (active.has(task.id)) return handle(); // already running in this process
  active.add(task.id);
  // Remember a gates-skipped (auto) start so a resume continues in the same mode
  // (RESUME_SPEC §2): an unattended task must not start needing approvals because a
  // restart happened to hit it.
  updateTask(projectId, task.id, { runnerPid: process.pid, ...(opts.auto ? { auto: true } : {}) });
  try {
    await stages(project, task, rawRequest, opts, onEvent);
  } catch (e) {
    const msg = String((e as Error)?.stack ?? e).slice(0, 1500);
    updateTask(projectId, task.id, { status: "failed", error: msg });
    addTrace(projectId, task.id, { from: "Pipeline", to: MANAGER, what: "failed", detail: msg.slice(0, 300) });
    await log(projectId, "system", "manager", "error", `Task ${task.id} failed: ${msg.slice(0, 500)}`);
  } finally {
    active.delete(task.id);
  }
  const done = getTask(projectId, task.id);
  if (done && (done.status === "merged" || done.status === "failed")) {
    try { opts.onFinish?.(done); } catch { /* reporting is best effort */ }
  }
  return handle();
}

// Continue a parked/interrupted task in the background (idempotent).
// `reason` only affects the trace: a "restart"/"shutdown" resume records the
// Router hop the dashboard renders distinctly (docs/RESUME_SPEC.md §4); a gate
// approval does not.
export type ResumeReason = "manual" | "gate" | "restart" | "shutdown";

export function resumeTask(projectId: string, taskId: string, reason: ResumeReason = "manual"): boolean {
  const t = getTask(projectId, taskId);
  if (!t || active.has(taskId)) return false;
  if (t.status === "merged" || t.status === "rejected") return false;
  if (reason === "restart" || reason === "shutdown") return startBootResume(projectId, taskId, reason);
  void runPipeline(projectId, t.rawRequest, { taskId, auto: t.auto === true }).catch(() => {});
  return true;
}

function pidAlive(pid: number | undefined): boolean {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check only
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// ── restart resume (docs/RESUME_SPEC.md §2) ──────────────────────────────────
// A restart orphans every pipeline that was mid-stage. Instead of failing those
// tasks (the old behaviour: a human had to press Resume), boot hands them to a
// staggered queue:
//   * one resume per RESUME_STAGGER_SECONDS (default 10 s) - the first starts
//     immediately, the stagger spaces the rest;
//   * at most RESUME_MAX_CONCURRENT (default 3) resumed pipelines in flight at
//     once; the rest wait in this queue;
//   * nothing at all while free RAM is below RESUME_MIN_FREE_RAM_MB (default
//     2048 MB, 0 disables the guard) - resumed coder runs spawn opencode workers.
// Stages already skip finished work, so a resumed task continues from the last
// finished step instead of redoing it.
const RESUME_MAX_INTERRUPTIONS = 2;

function resumeStaggerMs(): number {
  const n = Number(process.env.RESUME_STAGGER_SECONDS ?? 10);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) * 1000 : 10_000;
}
function resumeMaxConcurrent(): number {
  const n = Number(process.env.RESUME_MAX_CONCURRENT ?? 3);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
}
function resumeMinFreeRamMb(): number {
  const raw = process.env.RESUME_MIN_FREE_RAM_MB;
  if (raw === undefined || raw === "") return 2048;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 2048;
}
function freeRamMb(): number {
  try {
    return Math.round(os.freemem() / (1024 * 1024));
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

// Who owns the stage a task stopped in: the "to" of the restart hop.
function stageOwner(t: TaskRec): string {
  const coder = (t.assignments ?? []).find((a) => a.role === "coder");
  switch (t.status) {
    case "enhancing":
      return "prompt-enhancer";
    case "coding":
      return coder ? `${coder.modelId ?? "coder"} (${coder.agentId})` : "coder";
    case "testing":
      return (t.assignments ?? []).find((a) => a.role === "tester")?.agentId ?? "tester";
    case "opposing":
      return (t.assignments ?? []).find((a) => a.role === "opposer")?.agentId ?? "opposer";
    case "summarizing":
      return "summarizer";
    default:
      return MANAGER;
  }
}

type BootQueueItem = { projectId: string; taskId: string; stage: string; since: string; why: "restart" | "shutdown" };
const bootQueue: BootQueueItem[] = [];
const bootRunning = new Set<string>();
let bootTimer: NodeJS.Timeout | undefined;

export type BootResumeStatus = {
  queued: number;
  running: number;
  maxConcurrent: number;
  staggerMs: number;
  minFreeRamMb: number;
  freeRamMb: number;
  active: boolean;
};

export function bootResumeStatus(): BootResumeStatus {
  return {
    queued: bootQueue.length,
    running: bootRunning.size,
    maxConcurrent: resumeMaxConcurrent(),
    staggerMs: resumeStaggerMs(),
    minFreeRamMb: resumeMinFreeRamMb(),
    freeRamMb: freeRamMb(),
    active: !!bootTimer,
  };
}

// Start (or join) one resumed pipeline and record the restart hop the Flow/Fleet
// pages render as "restarted -> resumed at <stage>". `why` only changes the detail:
// a planned shutdown (docs/SHUTDOWN_SPEC.md) is not a crash, but it is still the
// router coming back and picking the work up, so the CEO sees the same hop.
function startBootResume(projectId: string, taskId: string, why: "restart" | "shutdown" = "restart"): boolean {
  const t = getTask(projectId, taskId);
  if (!t || active.has(taskId)) return false;
  const stage = t.status;
  bootRunning.add(taskId);
  addTrace(projectId, taskId, {
    from: "Router",
    to: stageOwner(t),
    what: `restarted \u2192 resumed at ${stage}`,
    detail:
      why === "shutdown"
        ? `the company was shut down on purpose while this task was in "${stage}"; it resumed from the last finished step when the router came back`
        : `the router restarted while this task was in "${stage}"; the pipeline resumed from the last finished step`,
  });
  // A planned shutdown is not an interruption, so its flag goes away here (the
  // task is running again). Recorded on the same write as the resume.
  if (t.pausedByShutdown) updateTask(projectId, taskId, { pausedByShutdown: undefined });
  void runPipeline(projectId, t.rawRequest, { taskId, auto: t.auto === true })
    .catch(() => {})
    .finally(() => bootRunning.delete(taskId));
  return true;
}

function bootResumeTick(): void {
  if (!bootQueue.length) {
    stopBootResumeQueue();
    return;
  }
  if (bootRunning.size >= resumeMaxConcurrent()) return;
  const floor = resumeMinFreeRamMb();
  const free = freeRamMb();
  if (floor > 0 && free < floor) {
    console.log(`[tasks] resume queue paused: ${free} MB free < RESUME_MIN_FREE_RAM_MB=${floor}`);
    return;
  }
  // One start per tick (that is the stagger). Entries that stopped being resumable
  // while they waited are dropped without burning a tick.
  while (bootQueue.length) {
    const item = bootQueue.shift()!;
    const t = getTask(item.projectId, item.taskId);
    if (!t || active.has(t.id)) continue;
    if (!IN_MOTION.includes(t.status)) continue; // parked at a gate / terminal now
    if (startBootResume(item.projectId, item.taskId, item.why)) {
      console.log(`[tasks] restart resume: ${item.projectId}/${item.taskId} was queued at "${item.stage}", now running (resumed at "${t.status}", ${item.why})`);
      return;
    }
  }
  if (!bootQueue.length) stopBootResumeQueue();
}

// Called once at boot (server.ts). Safe to call with an empty queue: it returns
// immediately and starts no timer.
export function startBootResumeQueue(): BootResumeStatus {
  if (!bootTimer && bootQueue.length) {
    bootTimer = setInterval(bootResumeTick, resumeStaggerMs());
    bootTimer.unref?.();
    // The first queued task starts now; the stagger spaces the ones after it.
    bootResumeTick();
  }
  return bootResumeStatus();
}

export function stopBootResumeQueue(): void {
  if (bootTimer) {
    clearInterval(bootTimer);
    bootTimer = undefined;
  }
}

export type ReconcileReport = { queued: number; failed: number; afterShutdown: number };

// At boot nothing is running, so tasks left mid-stage are orphans. Each one is
// queued for an automatic resume (startBootResumeQueue) instead of being marked
// failed, so a restart no longer needs a human. A task already interrupted
// RESUME_MAX_INTERRUPTIONS times is failed instead, with the reason the Briefing
// shows under "Needs you". POST .../run {taskId} still resumes by hand.
// A task carrying `pausedByShutdown` (a PLANNED stop, docs/SHUTDOWN_SPEC.md) is
// always resumed and its flag cleared: a deliberate shutdown is not an interruption.
export function reconcileStaleTasks(): ReconcileReport {
  const report: ReconcileReport = { queued: 0, failed: 0, afterShutdown: 0 };
  for (const p of loadOrg().projects) {
    for (const t of loadTasks(p.id)) {
      // Several server instances can share company/ (e.g. a test server on another
      // port): only touch a task whose runner process is gone.
      if (!IN_MOTION.includes(t.status) || active.has(t.id) || pidAlive(t.runnerPid)) continue;
      if (t.pausedByShutdown) {
        updateTask(p.id, t.id, { pausedByShutdown: undefined });
        bootQueue.push({ projectId: p.id, taskId: t.id, stage: t.status, since: t.updatedAt, why: "shutdown" });
        report.afterShutdown++;
        continue;
      }
      const interruptions = (t.interruptions ?? 0) + 1;
      if (interruptions >= RESUME_MAX_INTERRUPTIONS) {
        updateTask(p.id, t.id, {
          interruptions,
          status: "failed",
          error: `interrupted twice by restarts (caught in "${t.status}"). Resume with POST /company/projects/${p.id}/run {"taskId":"${t.id}"}`,
        });
        addTrace(p.id, t.id, {
          from: "Router",
          to: stageOwner(t),
          what: `restart limit reached (${interruptions})`,
          detail: "interrupted by restarts too often; marked failed instead of resumed, for the CEO to decide",
        });
        report.failed++;
        continue;
      }
      updateTask(p.id, t.id, { interruptions });
      bootQueue.push({ projectId: p.id, taskId: t.id, stage: t.status, since: t.updatedAt, why: "restart" });
      report.queued++;
    }
  }
  return report;
}

async function stages(
  project: NonNullable<ReturnType<typeof getProject>>,
  task: TaskRec,
  rawRequest: string,
  opts: PipelineOpts,
  onEvent: (ev: WorkerEvent) => void,
) {
  const projectId = project.id;
  const auto = opts.auto ?? false;
  const allAgents = project.teams.flatMap((t) => t.agents);
  const cur = () => getTask(projectId, task.id)!;

  // Dashboard hook: tag every session this run starts with the project + task it
  // belongs to, so sessions/budgets can be attributed correctly.
  let departmentName = project.departmentId;
  try {
    departmentName = loadOrg().departments.find((d) => d.id === project.departmentId)?.name ?? project.departmentId;
  } catch {
    // keep the fallback
  }
  const taskContext = (title?: string): TaskContext => ({
    projectId: project.id,
    projectName: project.name,
    departmentId: project.departmentId,
    departmentName,
    taskId: task.id,
    taskTitle: String(title ?? rawRequest ?? "").slice(0, 120),
  });
  const find = (role: RoleId) => allAgents.find((a) => a.role === role);

  // GATE 1 — intake approval.
  if (!cur().gates.intake && !auto) {
    updateTask(projectId, task.id, { status: "pending_intake" });
    if (!(await waitGate("intake", task, auto))) return;
  }

  // Project context digest (HANDOVER 7.2) so agents extend what exists.
  let projectCtx = "";
  try {
    projectCtx = projectContext(projectId, 3000);
  } catch {
    projectCtx = "";
  }
  const withCtx = (prompt: string) =>
    projectCtx
      ? `${prompt}\n\nPROJECT CONTEXT (auto-generated digest of this project's tree; use it instead of re-reading files):\n${projectCtx}`
      : prompt;

  // 1. Prompt enhancer enriches the brief.
  if (!cur().enhancedBrief) {
    updateTask(projectId, task.id, { status: "enhancing" });
    await log(projectId, "system", "manager", "intake", `New task accepted: ${String(rawRequest ?? "").slice(0, 300)}`);
    const enhancer = find("prompt-enhancer") ?? allAgents[0];
    const enhanced = await runAgent(enhancer, withCtx(`${ORIGINAL_ORDER_LABEL}:\n${String(rawRequest ?? "")}`), { onEvent, taskContext: taskContext() });
    if (enhanced.status === "error") throw new Error(`enhancer failed: ${enhanced.text?.slice(0, 300)}`);
    addTrace(projectId, task.id, { from: `${enhancer.modelId} (enhancer)`, to: MANAGER, what: "brief", detail: enhanced.text?.slice(0, 400) });
    updateTask(projectId, task.id, { enhancedBrief: enhanced.text, status: "planned" });
    await log(projectId, enhancer.id, enhancer.role, "enhanced", enhanced.text ?? "");
  }
  const brief = cur().enhancedBrief ?? "";

  // 2. Manager (Claude) plans AND decides the dispatch.
  const manager = find("manager") ?? allAgents[0];
  if (!cur().plan) {
    updateTask(projectId, task.id, { status: "planned" });
    const planPrompt = withCtx(`${String(rawRequest ?? "")}\n\nEnhanced brief:\n${brief}${DISPATCH_INSTRUCTIONS(allAgents)}`);
    // Order F4 rule 3: an unusable plan (too short / no sentence / equal to the
    // enhanced brief) is retried exactly once; a second unusable plan fails the
    // task as "manager plan unusable" instead of ever being used as an answer.
    let planRes = await runAgent(manager, planPrompt, { onEvent, taskContext: taskContext(`Plan: ${String(rawRequest ?? "")}`) });
    let planAttempts = 1;
    while (planRes.status !== "error" && planAttempts < 2 && isPlanUnusable(planRes.text, brief)) {
      planAttempts++;
      addTrace(projectId, task.id, { from: MANAGER, to: MANAGER, what: "plan retry", detail: "plan unusable; retried the plan stage once" });
      await log(projectId, manager.id, manager.role, "plan retry", "plan unusable; retrying the plan stage once");
      planRes = await runAgent(manager, planPrompt, { onEvent, taskContext: taskContext(`Plan: ${String(rawRequest ?? "")}`) });
    }
    if (planRes.status === "error") throw new Error(`manager failed: ${planRes.text?.slice(0, 300)}`);
    if (isPlanUnusable(planRes.text, brief)) {
      addTrace(projectId, task.id, { from: MANAGER, to: MANAGER, what: "plan unusable", detail: "plan still unusable after one retry; failing" });
      throw new Error("manager plan unusable");
    }
    const fellBack = /\[manager-fallback:/.test(planRes.text ?? "");
    addTrace(projectId, task.id, {
      from: fellBack ? `${config.models.standard} (Claude unavailable, fallback)` : MANAGER,
      to: MANAGER,
      what: "plan",
      detail: planRes.text?.replace(/DISPATCH:[\s\S]*$/, "").slice(0, 500),
    });
    updateTask(projectId, task.id, { plan: planRes.text });
    await log(projectId, manager.id, manager.role, "plan", planRes.text ?? "");
  }
  const plan = cur().plan ?? "";

  // 3. Dispatch: the manager's DISPATCH line wins; Laya only when it is missing.
  // Order F4 rule 2: a request whose Files section names files to create/change
  // is never satisfied by plan text alone - it must reach a coder. An already
  // stored EMPTY assignments list (the tmuy0ytzv shortcut stage) therefore
  // re-enters the dispatch decision for such requests, and after the existing
  // Laya fallback (which keeps its coder-1 guarantee) any still-uncoded Files
  // request is routed to the fallback coder too.
  const filesRequested = parseDeliverableFiles(String(rawRequest ?? "")).length > 0;
  const storedAssignments = cur().assignments ?? [];
  if (!cur().assignments || (storedAssignments.length === 0 && filesRequested)) {
    let assignments = parseManagerDispatch(plan, allAgents);
    let reason = `Manager dispatch: ${assignments.map((a) => a.agentId).join(", ") || "none (manager answered directly)"}`;
    if (!assignments.length && !/DISPATCH:/.test(plan)) {
      const d = await chooseAgent(String(rawRequest ?? ""), allAgents, opts.taskHint);
      assignments = d.assignments.filter((a) => a.role === "coder" || a.role === "tester" || a.role === "opposer");
      reason = `Manager gave no DISPATCH line; Laya fallback: ${d.reason}`;
      // Without an explicit "assignments":[] the manager did not say "no work", so
      // never silently drop the order: ensure at least one coder gets the brief.
      const coder = allAgents.find((a) => a.role === "coder");
      if (coder && !assignments.some((a) => a.role === "coder")) {
        assignments = [...assignments, { agentId: coder.id, role: coder.role, subtask: `${String(rawRequest ?? "")}\n\nMANAGER PLAN:\n${plan.slice(-6000)}` }];
        reason += `; no coder in dispatch, so ${coder.id} gets the order`;
      }
    }
    // Order F4 rule 2 (continued): even with a DISPATCH line whose parsed
    // assignments name no coder ("assignments":[]), a Files request must reach
    // a coder - fall back to coder-1 with the manager plan as the subtask.
    if (filesRequested && !assignments.some((a) => a.role === "coder")) {
      const coder = allAgents.find((a) => a.role === "coder");
      if (coder) {
        assignments = [...assignments, { agentId: coder.id, role: coder.role, subtask: `${String(rawRequest ?? "")}\n\nMANAGER PLAN:\n${plan.slice(-6000)}` }];
        reason += `; the request names deliverable files, so ${coder.id} takes the work`;
      }
    }
    // Claude decided WHAT; now Claude asks Laya WHO (which model) for each coding subtask.
    // CEO COST RULE CEILING (LAYA-TUNE, Stability 3) as reshaped by the MODEL POLICY
    // (Order F3): the escalation check keeps its structure, but the allowed escalation
    // target is now a GLM or DeepSeek model - never Kimi or Qwen (which enforceModel
    // swaps at every choke point anyway). An unchecked escalation pick is downgraded to
    // the cost-rule default (config.models.standard) with the reason recorded in the
    // trace; a justified pick escalates onto config.models.routine (GLM). The Laya trace
    // text keeps the 'noul escalate=' wording from the measured question intact.
    for (const a of assignments) {
      if (a.role !== "coder") continue;
      const pick = await chooseWorkerModel(a.subtask, { projectId, role: a.role });
      if (pick.modelId === config.models.complex) {
        const esc = escalationAllowed(a.subtask);
        if (!esc.escalate) {
          pick.modelId = config.models.standard;
          pick.confidence = 0;
          pick.reason = `escalation refused: no justification -> ${config.models.standard} (cost rule) | was: ${pick.reason}`;
        } else {
          pick.modelId = config.models.routine;
          pick.reason = `escalation allowed: ${esc.why} -> ${config.models.routine} (model policy: GLM/DeepSeek only) | was: ${config.models.complex}`;
        }
      }
      a.modelId = pick.modelId;
      addTrace(projectId, task.id, {
        from: MANAGER,
        to: "Laya",
        what: "which model?",
        detail: a.subtask.slice(0, 300),
      });
      addTrace(projectId, task.id, {
        from: "Laya",
        to: MANAGER,
        what: `pick: ${pick.modelId}`,
        detail: `${pick.reason} for ${a.agentId}`,
      });
      reason += `\n${a.agentId} -> ${pick.modelId} (${pick.reason})`;
    }
    updateTask(projectId, task.id, { assignments, status: "pending_code" });
    await log(projectId, "system", "manager", "dispatch", reason);
  }
  const assignments = cur().assignments ?? [];

  // GATE 2 — before code executes.
  if (assignments.length && !cur().gates.code && !auto) {
    updateTask(projectId, task.id, { status: "pending_code" });
    if (!(await waitGate("code", task, auto))) return;
  }

  // 4. Work phase: coders first, THEN tester + opposer on what the coders did,
  // THEN the manager reviews (PASS, or LOOP once with fix instructions).
  // Order F6: the task start time anchors every "changed since task start" check.
  // Field on the task record: createdAt (ISO). A resume of an older task keeps
  // that original start; a fresh task captures now.
  const taskStartMs = Math.max(
    Date.parse(task.createdAt) || 0,
    Date.parse(cur().createdAt) || 0,
    Date.now() - 60_000,
  );
  const listedDeliverables = parseDeliverableFiles(String(rawRequest ?? ""));
  const packInput = {
    root: project.rootDir,
    files: listedDeliverables,
    taskStartMs,
    coderOutput: "",
    taskId: task.id,
  };
  let work = "";
  let testerStatus = "PASS";
  if (!cur().result) {
    let fixNote = "";
    for (let loop = cur().loopCount; ; loop++) {
      const coderJobs = assignments
        .filter((a) => a.role === "coder")
        .map((a) => {
          const base = allAgents.find((x) => x.id === a.agentId);
          // Run with the model Laya picked for this subtask.
          const agent = base ? { ...base, modelId: a.modelId ?? base.modelId } : undefined;
          const prompt = `${a.subtask}\n\nFULL BRIEF (for context; do only your subtask):\n${brief}${fixNote}`;
          return { agent: agent!, prompt, taskContext: taskContext(a.subtask) };
        })
        .filter((j) => j.agent);
      if (coderJobs.length) {
        updateTask(projectId, task.id, { status: "coding" });
        await holdMockStage(); // ops drill only: see mockStageDelayMs()
        for (const j of coderJobs) {
          addTrace(projectId, task.id, { from: MANAGER, to: `${j.agent.modelId} (${j.agent.id})`, what: fixNote ? "fix order" : "work order", detail: j.prompt.slice(0, 300) });
        }
        const coded = await runParallel(coderJobs, { onEvent, taskContext: taskContext() });
        for (const r of coded) {
          const model = coderJobs.find((j) => j.agent.id === r.agentId)?.agent.modelId ?? "";
          addTrace(projectId, task.id, { from: `${model} (${r.agentId})`, to: MANAGER, what: r.status === "done" ? "result" : "error", detail: readable(r.text).slice(-400) });
        }
        for (const r of coded) await log(projectId, r.agentId, r.role, r.status === "done" ? "done" : "error", r.text ?? "");
        work = coded.map((r) => `## ${r.agentId} (${r.status}, workdir ${allAgents.find((a) => a.id === r.agentId)?.workdir})\n${readable(r.text).slice(-1500)}`).join("\n\n");
      }

      // Order F6: authoritative disk facts for the reviewers, rebuilt fresh in
      // every loop (a fix round rewrites files, so the pack must reflect them).
      // Section D is the coder's raw output; when no coder ran, the stored result
      // (or nothing) stands in so the pack is always complete.
      const coderRaw = coderJobs.length ? work : readable(cur().result ?? "");
      const pack = buildReviewPack({ ...packInput, coderOutput: coderRaw });
      // Early-fail guard: BEFORE the opposer/manager spend tokens. Only fires
      // when >= 1 deliverable is listed and none changed on disk.
      const noChange = evaluateNoChangeGuard({ listedDeliverables, entries: pack.entries });
      if (!noChange.ok) {
        updateTask(projectId, task.id, { status: "failed", error: noChange.reason });
        addTrace(projectId, task.id, { from: MANAGER, to: "Assistant", what: "merge guard blocked", detail: noChange.reason });
        await log(projectId, "system", "manager", "error", `Task ${task.id} ${noChange.reason}`);
        return;
      }

      const reviewJobs = assignments
        .filter((a) => a.role === "tester" || a.role === "opposer")
        .map((a) => {
          const agent = allAgents.find((x) => x.id === a.agentId)!;
          const prompt =
            a.role === "tester"
              ? buildTesterPrompt({ subtask: a.subtask, brief, work, packText: pack.text, request: String(rawRequest ?? "") })
              : buildOpposerPrompt({ subtask: a.subtask, brief, work, packText: pack.text });
          return { agent, prompt, taskContext: taskContext(a.subtask) };
        })
        .filter((j) => j.agent);
      let reviews = "";
      if (reviewJobs.length) {
        updateTask(projectId, task.id, { status: "testing" });
        const reviewed = await runParallel(reviewJobs, { onEvent, taskContext: taskContext() });
        for (const r of reviewed) {
          const model = reviewJobs.find((j) => j.agent.id === r.agentId)?.agent.modelId ?? "";
          addTrace(projectId, task.id, { from: `${model} (${r.role})`, to: MANAGER, what: r.role === "tester" ? "test report" : "objections", detail: readable(r.text).slice(-400) });
          await log(projectId, r.agentId, r.role, r.status === "done" ? "done" : "error", r.text ?? "");
        }
        reviews = reviewed.map((r) => `## ${r.role} (${r.status})\n${readable(r.text).slice(-1500)}`).join("\n\n");
        const testerResult = reviewed.find((r) => reviewJobs.find((j) => j.agent.id === r.agentId)?.agent.role === "tester");
        if (testerResult) {
          const text = readable(testerResult.text).toUpperCase();
          if (testerResult.status !== "done") testerStatus = "FAIL";
          else if (text.includes("BLOCKED")) testerStatus = "BLOCKED";
          else if (text.includes("FAIL")) testerStatus = "FAIL";
          else testerStatus = "PASS";
        }
      }

      if (!coderJobs.length && !reviewJobs.length) break; // manager answered directly

      updateTask(projectId, task.id, { status: "adjudicating" });
      const verdict = await runAgent(
        manager,
        buildManagerReviewPrompt({ request: String(rawRequest ?? ""), plan: plan.slice(0, 3000), work, reviews, packText: pack.text }),
        { onEvent, taskContext: taskContext(`Review ${task.id}`) },
      );
      await log(projectId, manager.id, manager.role, "review", verdict.text ?? "");
      updateTask(projectId, task.id, { review: verdict.text });
      const wantsLoop = /VERDICT:\s*LOOP/i.test(verdict.text ?? "");
      addTrace(projectId, task.id, { from: MANAGER, to: MANAGER, what: wantsLoop ? "review: LOOP" : "review: PASS", detail: verdict.text?.slice(0, 400) });
      if (!wantsLoop || loop >= MAX_REVIEW_LOOPS || !coderJobs.length) break;
      updateTask(projectId, task.id, { loopCount: loop + 1 });
      fixNote = `\n\nMANAGER REVIEW - FIX THESE BEFORE ANYTHING ELSE:\n${verdict.text}`;
    }

    if (!assignments.length) {
      // The manager answered directly (report, question, decision): its plan IS the result.
      updateTask(projectId, task.id, { result: plan.replace(/DISPATCH:[\s\S]*$/, "").trim(), status: "pending_merge" });
    } else {
    // 5. Summarizer condenses THIS task (not the whole project thread).
    updateTask(projectId, task.id, { status: "summarizing" });
    const summarizer = find("summarizer") ?? allAgents[0];
    const thread = readThread(projectId, 200)
      .filter((m) => Date.parse(m.ts) >= Date.parse(task.createdAt))
      .slice(-30)
      .map((m) => `${m.agent}: ${m.text}`)
      .join("\n");
    const summary = await runAgent(summarizer, `Summarize this task (${task.id}) for the CEO:\nREQUEST: ${String(rawRequest ?? "")}\n\n${thread}`, { onEvent, taskContext: taskContext(`Summarize ${task.id}`) });
    updateTask(projectId, task.id, { result: summary.text || cur().review || plan.slice(0, 2000), status: "pending_merge", testerStatus });
    await log(projectId, summarizer.id, summarizer.role, "summary", summary.text ?? "");
    }
  }

  // Order F4 (merge-all-paths): every route ends through finalizeMerge - the
  // only code that may set status "merged" or post the merge message - and the
  // guard runs there on real inputs for the normal route AND the shortcut route
  // (empty assignments: coderOutput is "" unless a past coder recorded output on
  // the task, and any named deliverable file must exist under the project root).
  await finalizeMerge(projectId, task.id, {
    rootDir: project.rootDir,
    coderOutput: work || cur().result || "",
    testerStatus: cur().testerStatus ?? testerStatus,
    reviewVerdict: cur().review ?? "",
    auto,
  });
}
