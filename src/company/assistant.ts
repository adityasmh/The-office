import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config } from "../config.js";
import { getCompanyRoot, loadOrg, getProject, createProject, saveOrg } from "./org.js";
import type { ProjectDef, RoleId } from "./org.js";
import { ROLES } from "./roles.js";
import { callClaudeSubscription } from "../claudeSubscription.js";
import { callGatewayModel } from "../gateway.js";
import { notifyAssistantDispatch } from "../slack.js";
import { createTask, addTrace, loadTasks } from "./gates.js";
import type { TaskRec } from "./gates.js";
import { runPipeline } from "./pipeline.js";
import { chooseTeam } from "./dispatch.js";
import { ensureAssistantAgent, listAgentsFlat } from "./agentchat.js";
import type { AgentView } from "./agentchat.js";
import { ensureAgentBudget, budgetTotals, budgetByDepartment, estimateCostForRole, getBudget, charge } from "./budget.js";
import { listSessions } from "./sessions.js";
import type { SessionRec } from "./sessions.js";
import { ceoContextDigest } from "./ceoContext.js";
// ATTACH (2026-09-29 work order): the CEO's paperclip/drag-drop files. The ids the
// page sends are resolved to absolute paths here, Claude is told to open them, and the
// description it writes is what the DeepSeek workers (who cannot see images) get.
import { resolveUploads, setUploadNote, uploadsRoot } from "./uploads.js";
import type { UploadRec } from "./uploads.js";
import { remember } from "./memory.js";
// BUDGET (2026-09-29, its request via docs/BUDGET_SPEC.md §2, plus its 21:44 lostFileRead
// addition): the assistant's model choice respects the measured Claude amber/red state, and
// because an attached file needs a model that can read it, the guard is asked with
// needsFileRead so it can report lostFileRead instead of silently returning a model that
// cannot open the CEO's file.
import { applyBudgetFilter } from "./budgetGuard.js";
// CHEAP BY DEFAULT (CEO order, docs/CHEAP_BY_DEFAULT_SPEC.md Job 2): the assistant asks the
// gate (brainRouter) which tier this order needs instead of naming a model by hand.
import { ceoNamedTier, cheapModel } from "./brainRouter.js";

// The CEO's assistant (chief of staff). Takes one plain instruction from the CEO,
// plans it into work orders, routes each to the right department/project, hires agents
// (budget-checked) and fires the pipeline without blocking the HTTP response.

export type AssistantPlanItem = {
  title: string;
  departmentName: string;
  projectId?: string;
  role: string;
  request: string;
  // ASSISTANT-BRAIN (docs/REPORTING_SPEC.md §3): which track the planner thinks this
  // task belongs to. Laya re-checks it at dispatch time (chooseTrack) and its answer
  // wins only when it clears LAYA_TRACK_MIN_CONF.
  track?: AssistantTrack;
};

export type AssistantDispatch = { projectId: string; taskId: string; title: string; status: string };

// Work the assistant handed to FLEET-BACKEND's fleet track (src/company/fleet.ts)
// instead of a company pipeline. Optional: absent when no task took that track.
export type AssistantFleetDispatch = { title: string; orderId?: string; status: string };

export type AssistantResult = {
  reply: string;
  plan: AssistantPlanItem[];
  dispatched: AssistantDispatch[];
  sessions: SessionRec[];
  budgets: { remainingUsd: number; capsRemoved?: true; spentUsd?: number };
  decisions: string[];
  fleet?: AssistantFleetDispatch[];
  /** ATTACH: the files the CEO attached to this order (resolved), when there were any. */
  attachments?: UploadRec[];
  error?: string;
};

export type AssistantThreadEntry = {
  ts: string;
  role: "ceo" | "assistant";
  text: string;
  tasks?: string[];
  /** VOICE-ROUTE: true only for a CEO entry created from a spoken order. */
  spoken?: true;
  /** ATTACH: the names of the files the CEO attached to this order, so the thread itself
   *  records what went with it (the chips are gone once the order is sent). */
  attachments?: string[];
};

const PIPELINE_ROLES: RoleId[] = ["prompt-enhancer", "manager", "coder", "tester", "opposer", "summarizer"];
const MAX_PLAN_TASKS = 8;

// Dispatched (fire-and-forget) pipelines that have not settled yet.
let inFlight = 0;

// ── JOEY-WIRE: per-browser voice toggle (docs/JOEY_SPEC.md, docs/VOICE.md §5) ──
// In-memory default is on; the browser sends its preference with each message and
// through POST /company/assistant/voice, so the assistant speaks when the CEO wants it.
let assistantVoiceEnabled = true;

export function setAssistantVoiceEnabled(enabled: boolean): void {
  assistantVoiceEnabled = !!enabled;
}

export function getAssistantVoiceEnabled(): boolean {
  return assistantVoiceEnabled;
}

// Voice: fire-and-forget text-to-speech for a posted assistant reply.
// Local only (loopback), no keys. Never awaited by the caller, so a down or slow
// tts server can delay nothing: the reply is already posted.
const TTS_PORT = process.env.TTS_PORT ?? "8901";
const TTS_URL = `http://127.0.0.1:${TTS_PORT}/tts/speak`;
const TTS_MAX_CHARS = 1200; // the whole reply is usually too long to listen to

function cleanSpeakableText(text: string): string {
  let t = text
    .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
    .replace(/`[^`\n]+`/g, " ") // inline code
    .replace(/[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]+/g, " ") // Windows paths (C:\...)
    .replace(/https?:\/\/\S+/g, " ") // URLs
    .replace(/(?:\.\.?\/|~\/|\/)?[^\s/]+\/[^\s]*\.[A-Za-z0-9]{1,20}(?:\?[A-Za-z0-9=&]*)?/g, " ") // relative/POSIX paths with extension
    .replace(/[#*|>\-=_{}]+/g, " ") // markdown/table symbols
    .replace(/\s+/g, " ")
    .trim();
  if (t.length > TTS_MAX_CHARS) {
    // Trim to the last sentence boundary within the cap so speech does not cut mid-thought.
    const prefix = t.slice(0, TTS_MAX_CHARS);
    const idx = Math.max(prefix.lastIndexOf(". "), prefix.lastIndexOf("! "), prefix.lastIndexOf("? "));
    if (idx > TTS_MAX_CHARS * 0.5) {
      t = prefix.slice(0, idx + 1).trim();
    } else {
      t = prefix.trim();
    }
  }
  return t;
}

export function speakAssistantReply(text: string): void {
  if (!assistantVoiceEnabled) return;
  const spoken = cleanSpeakableText(text);
  if (!spoken) return;
  void fetch(TTS_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: spoken }),
    signal: AbortSignal.timeout(5000), // 5 s is far more than the ~0.5 s measured per reply
  })
    .then(async (res) => {
      if (!res.ok) {
        console.warn(`[voice] tts server answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return;
      }
      const info = (await res.json().catch(() => null)) as { ms?: number; wavPath?: string } | null;
      console.log(`[voice] spoke ${spoken.length} chars in ${info?.ms ?? "?"} ms -> ${info?.wavPath ?? "?"}`);
    })
    .catch((err: unknown) => {
      // Server down, slow, or refusing: log one line and carry on. The reply is already out.
      const e = err as { cause?: { code?: string }; name?: string };
      console.warn(`[voice] tts server unreachable (${e?.cause?.code ?? e?.name ?? "error"}): reply posted without audio`);
    });
}

function nowIso(): string {
  return new Date().toISOString();
}

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function assistantThreadFile(): string {
  return path.join(getCompanyRoot(), "assistant.jsonl");
}

function appendAssistantThread(entry: AssistantThreadEntry) {
  try {
    fs.mkdirSync(getCompanyRoot(), { recursive: true });
    fs.appendFileSync(assistantThreadFile(), JSON.stringify(entry) + "\n");
  } catch {
    // thread logging is best effort
  }
}

export function assistantStatus(): "idle" | "thinking" {
  return inFlight > 0 ? "thinking" : "idle";
}

export function assistantThread(limit = 100): AssistantThreadEntry[] {
  const n = typeof limit === "number" && limit > 0 ? limit : 100;
  try {
    const file = assistantThreadFile();
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, "utf8").trim();
    if (!raw) return [];
    const out: AssistantThreadEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as Record<string, unknown>;
        const tasks = Array.isArray(rec.tasks) ? (rec.tasks.filter((t) => typeof t === "string") as string[]) : undefined;
        // ATTACH: this function rebuilds each entry field by field, so a field that is not
        // listed here is dropped on read even though it is on disk. `attachments` must be
        // passed through, or the file names would only ever be visible from the local
        // optimistic entry in the page and would vanish on the next reload.
        const files = Array.isArray(rec.attachments)
          ? (rec.attachments.filter((f) => typeof f === "string") as string[])
          : undefined;
        const spoken = rec.spoken === true ? true : undefined;
        out.push({
          ts: typeof rec.ts === "string" ? rec.ts : "",
          role: rec.role === "ceo" ? "ceo" : "assistant",
          text: typeof rec.text === "string" ? rec.text : "",
          ...(tasks && tasks.length ? { tasks } : {}),
          ...(files && files.length ? { attachments: files } : {}),
          ...(spoken ? { spoken: true } : {}),
        });
      } catch {
        // skip a corrupt line
      }
    }
    return out.slice(-n);
  } catch {
    return [];
  }
}

// ── in-flight planning marker (docs/RESUME_SPEC.md §3) ───────────────────────
// A restart in the middle of the CEO assistant's planning call would otherwise
// lose that order silently: the CEO typed it, nothing was dispatched, and no task
// exists to resume. So the marker is written to company/assistant-inflight.json
// immediately BEFORE the planning call and cleared immediately AFTER it. At boot
// (server.ts -> resumeInflightPlanning) a marker whose pid is dead means planning
// was interrupted: that one message is planned again, once, and the thread records
// "(redone after restart)". The marker is cleared before the re-run, so a crash
// during the re-run cannot loop.
export type AssistantInflight = {
  id: string; // the CEO thread entry's ts - the message's id
  text: string;
  autoRun: boolean;
  pid: number;
  started: string;
};

function inflightFile(): string {
  return path.join(getCompanyRoot(), "assistant-inflight.json");
}

function writeInflight(rec: AssistantInflight): void {
  try {
    fs.mkdirSync(getCompanyRoot(), { recursive: true });
    fs.writeFileSync(inflightFile(), JSON.stringify(rec, null, 2));
  } catch {
    // the marker is best effort: losing it only loses the auto-redo
  }
}

export function readInflight(): AssistantInflight | undefined {
  try {
    const raw = fs.readFileSync(inflightFile(), "utf8");
    const rec = JSON.parse(raw) as AssistantInflight;
    return rec && typeof rec.text === "string" && rec.text.trim() ? rec : undefined;
  } catch {
    return undefined;
  }
}

// Only remove OUR marker: a newer message may already have written its own.
function clearInflight(id: string): void {
  try {
    const cur = readInflight();
    if (cur && cur.id !== id) return;
    fs.rmSync(inflightFile(), { force: true });
  } catch {
    // best effort
  }
}

function pidIsAlive(pid: number): boolean {
  if (!pid || !Number.isFinite(pid) || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// "Never create duplicate tasks: check whether tasks for that message already
// exist." A dispatched task's first trace hop carries the CEO instruction
// (addTrace({from:"CEO", to:"Assistant", what:"order", detail: instruction})),
// so the instruction text itself is the key.
function tasksForInstruction(instruction: string): string[] {
  const probe = instruction.trim().slice(0, 60);
  if (!probe) return [];
  const found: string[] = [];
  try {
    for (const p of loadOrg().projects) {
      for (const t of loadTasks(p.id)) {
        if (t.status === "rejected") continue;
        const hit = (t.trace ?? []).some(
          (h) => h.from === "CEO" && h.to === "Assistant" && h.what === "order" && String(h.detail ?? "").startsWith(probe),
        );
        if (hit) found.push(`${p.id}/${t.id}`);
      }
    }
  } catch {
    // an unreadable org must not block the redo decision
  }
  return found;
}

export type InflightRedoResult = { redone: boolean; reason: string; taskIds?: string[] };

// Called once at boot (server.ts). Redoes a single interrupted planning call.
// Never throws: a broken marker must not take boot down.
export async function resumeInflightPlanning(): Promise<InflightRedoResult> {
  try {
    const rec = readInflight();
    if (!rec) return { redone: false, reason: "no marker" };
    if (pidIsAlive(rec.pid)) return { redone: false, reason: `pid ${rec.pid} is still alive; not an orphan` };

    const existing = tasksForInstruction(rec.text);
    if (existing.length) {
      appendAssistantThread({
        ts: nowIso(),
        role: "assistant",
        text: `(redone after restart) My planning of "${clamp(rec.text, 120)}" was interrupted by a restart, but its task(s) already exist (${existing.join(", ")}), so nothing was duplicated.`,
        tasks: existing.map((x) => x.split("/")[1] ?? x),
      });
      clearInflight(rec.id);
      return { redone: false, reason: "tasks for that message already exist", taskIds: existing };
    }

    // Clear BEFORE re-running: if the re-run crashes the router again, boot must
    // not find the same marker and loop forever.
    clearInflight(rec.id);
    appendAssistantThread({
      ts: nowIso(),
      role: "assistant",
      text: `(redone after restart) The router restarted while I was planning "${clamp(rec.text, 200)}", so no task was dispatched. Redoing that planning now.`,
      tasks: [],
    });
    const res = await assistantMessage(rec.text, { autoRun: rec.autoRun });
    return { redone: true, reason: "planning re-run", taskIds: res.dispatched.map((d) => d.taskId) };
  } catch (e) {
    return { redone: false, reason: `redo failed: ${clamp(String(e), 200)}` };
  }
}

export const __testInflightFile = inflightFile;
export const __testWriteInflight = writeInflight;
export const __testTasksForInstruction = tasksForInstruction;
export const __testReadInflight = readInflight;

// CEO order 2026-10-01: no per-agent quotas. This used to report the company's
// remaining allocation; there is none any more, so it reports the MEASURED
// spend and says the caps are gone (callers keep their shape).
function budgetSummary(): { remainingUsd: number; capsRemoved: true; spentUsd: number } {
  try {
    const t = budgetTotals();
    return { remainingUsd: 0, capsRemoved: true, spentUsd: t.spentUsd };
  } catch {
    return { remainingUsd: 0, capsRemoved: true, spentUsd: 0 };
  }
}

function remainingUsdTotal(): number {
  return 0;
}

// Compact org digest: company, departments, their projects (with ids) and tool budget left.
function orgDigest(): string {
  const org = loadOrg();
  const lines: string[] = [`Company: ${org.name}`];
  if (!org.departments.length) lines.push("Departments: (none yet - name the department this work belongs to)");
  for (const dept of org.departments) {
    let deptRemaining = 0;
    try {
      const rollup = budgetByDepartment().find((d) => d.departmentId === dept.id);
      deptRemaining = typeof rollup?.remainingUsd === "number" ? rollup.remainingUsd : 0;
    } catch {
      deptRemaining = 0;
    }
    const projects = dept.projectIds
      .map((pid) => org.projects.find((p) => p.id === pid))
      .filter((p): p is ProjectDef => !!p);
    lines.push(
      `Department "${dept.name}" (budget remaining $${deptRemaining.toFixed(2)}) - ${projects.length} project(s)`
    );
    for (const p of projects) {
      const agents = p.teams.flatMap((t) => t.agents);
      lines.push(
        `  - project id="${p.id}" name="${p.name}" status=${p.status} agents=${agents.length} roles=[${[...new Set(agents.map((a) => a.role))].join(", ")}]`
      );
    }
    if (!projects.length) lines.push("  - (no project yet; one will be created if you route work here)");
  }
  return lines.join("\n");
}

function buildSystemPrompt(): string {
  // JOEY-WIRE: the assistant introduces itself to the CEO as Joey.
  return `Your name is Joey, the CEO's assistant (chief of staff). ${ROLES.assistant.systemPrompt}`;
}

// ATTACH: the files block. This is deliberately explicit about the path and about
// reading the file first - the whole point of the feature is that the answer quotes
// what is actually in the file, not what its name suggests. When the model that will run
// this call cannot open files (BUDGET's lostFileRead), the block says so instead of asking
// for a reading it cannot do, so the model has no reason to pretend.
function attachmentsPromptBlock(files: UploadRec[], readable = true): string {
  if (!files.length) return "";
  return [
    "THE CEO ATTACHED THESE FILES:",
    ...files.map(
      (f) => `- ${f.path}  (${f.name}, ${f.type}${f.pages ? `, about ${f.pages} page(s)` : ""})`,
    ),
    readable
      ? "They are on this computer: open each of them with the Read tool BEFORE you answer, then answer from what you actually found in them. If you cannot open them on this run, say so plainly and never claim to have read them."
      : "You CANNOT open them on this run (your model cannot read PDFs or images). Do not describe or quote them: say plainly that attached files need the Claude assistant, and never claim to have read them.",
  ].join("\n");
}

// One extra reply rule, only when files are attached. Kept out of the normal prompt so
// a plain order reads exactly as it did before this feature.
const ATTACHMENT_RULE =
  '- the CEO attached files (their paths are listed above). Read every one of them with the Read tool FIRST, then '
  + 'add to your JSON: "attachments":[{"path":"<the exact path>","what":"2-3 sentences in plain words saying what the '
  + 'file shows, including any numbers, names or labels that are on it"}]. This description is NOT optional: the '
  + 'workers who run your tasks cannot open a PDF or an image, so a task that depends on a file must repeat the file '
  + 'paths AND a short version of "what" inside its "request". Never describe a file you have not read.';

// The same rule when the model for this call cannot open files (Claude amber/red routed it
// elsewhere). Say so in the reply itself; do not guess at contents.
const ATTACHMENT_UNREADABLE_RULE =
  '- the CEO attached files, but YOU CANNOT OPEN THEM on this run (your model has no file reading). Do not quote, '
  + 'summarise or guess at their contents, and do not offer to; start your "reply" by saying plainly in one sentence '
  + 'that the attached files need the Claude assistant, name the files, and then answer only the parts of the order '
  + 'that do not depend on the files (or say you are waiting).';

function buildUserPrompt(text: string, history: string, runReport: string, attached = "", attachReadable = true): string {
  return [
    "ORG DIGEST:",
    orgDigest(),
    "",
    // Live work/budget/session state (src/company/ceoContext.ts): read-only, cheap,
    // and bounded to ~3000 chars, so the prompt stays a fixed size. This is what lets
    // the assistant answer "what work has been done?" with real task counts instead
    // of guessing. It is added AFTER the org digest and never reorders it.
    "LIVE COMPANY CONTEXT:",
    ceoContextDigest(),
    "",
    // ASSISTANT-BRAIN: the live conversation, so follow-ups ("and what about the
    // second one?") resolve. Captured before the new message is appended, so the
    // CEO's current instruction is not duplicated here.
    "RECENT CONVERSATION (oldest first):",
    history || "(this is the first message in the thread)",
    "",
    // ASSISTANT-BRAIN: REPORTING's briefing + run cards in plain words (what is done,
    // what is left, what needs the CEO). Degrades to a labelled "not available yet"
    // line when briefing.ts has not shipped, so the prompt never breaks.
    "RUN REPORT (manager checks on every run, plain words):",
    runReport,
    "",
    `CEO INSTRUCTION: ${text}`,
    // ATTACH: the CEO's files, right after the order they belong to. Empty (and the
    // prompt byte-identical to before) when nothing was attached.
    ...(attached ? ["", attached] : []),
    "",
    "REPLY RULES:",
    "- plain words a non-engineer understands; no file paths or jargon unless the CEO asked for them; ~15 words per item",
    '- when you report status, use exactly this checklist shape: "Done: ..." then "Remaining: ..." then "Needs you: ..." (skip a line only when it is empty)',
    '- the RUN REPORT above lists "NEEDS YOU:" items: if it lists any, never write "Needs you: nothing" - say how many items are waiting and that they are on the Briefing page',
    '- never invent status: for every claim about state, name what you checked ("I checked the run report", "I read the tasks file")',
    '- each task may carry "track": "pipeline" (one product project builds it), "fleet" (change to our own platform, or big multi-part work needing parallel workers) or "answer" (no work, just a reply)',
    ...(attached ? [attachReadable ? ATTACHMENT_RULE : ATTACHMENT_UNREADABLE_RULE] : []),
    "",
    'Answer with ONLY the JSON object {"reply":"...","decisions":["..."],"tasks":[{"title","departmentName","projectId","role","track","request"}]}.',
  ].join("\n");
}

// The assistant runs on the CHEAP model by default and reaches Claude only through the
// gate (CEO's rule: Claude is for BIG tasks or when the CEO names it -
// docs/CHEAP_BY_DEFAULT_SPEC.md). ASSISTANT_MODEL names the MAX tier, not the model used;
// `claude`/a full Claude id means "up to that, if Laya says the order is big".
// ATTACH: the caller needs to know whether the answering model could actually open
// files, because that decides whether the CEO is told "attachments need the Claude
// assistant" and whether a hand-off to a worker may claim what a file shows.
type AssistantModelAnswer = { text: string; model: string; canReadFiles: boolean };

async function callAssistantModel(
  system: string,
  user: string,
  decisions: string[],
  chosen: string,
  /**
   * The CEO's OWN words for this order (not the assembled prompt). The gate must
   * classify the order, not the context bolted onto it: measured 2026-09-30, a
   * "fix a typo" order scored top=0.46/lead=0.09 as part of the full assistant
   * prompt (history + run cards + company digest) and therefore took Sonnet, even
   * though the order itself is one file. Passing the order text is what makes the
   * CEO's rule ("small tasks never go through Claude") actually hold here.
   */
  brainText?: string,
  /**
   * CHEAP PLANNER (finding 3): the retry after a cheap-tier answer came back as tool-call
   * syntax. With `noTools` the prompt ends with a hard prohibition instead of the usual
   * file-reading advice - the tier has no tools, so inviting them produced `<||DSML||...>`
   * markup that the JSON parser could not read and the CEO got an empty plan.
   */
  noTools?: boolean,
): Promise<AssistantModelAnswer> {
  // BUDGET: the guarded choice is computed once by the caller (assistantMessage), so the
  // prompt, the call and the recorded cost all agree on which model ran this order, and the
  // reason for a clamped choice is pushed to `decisions` exactly once, there.
  const choice = chosen;
  // ASSISTANT_MODEL=claude (the assistant's own default Sonnet) or a full Claude id (e.g.
  // claude-opus-5-5) is the CEILING. `purpose: "assistant"` below is what actually decides.
  const claudeModel = choice === "claude" ? ROLES.assistant.defaultModel : choice.startsWith("claude-") ? choice : "";
  // CHEAP BY DEFAULT: there is ONE path now. The gate inside callClaudeSubscription picks the
  // tier from Laya's size answer (plus a CEO naming of Claude, plus the hard rules) and a
  // small order is answered on deepseek-v4.1-flash over the Go gateway without touching the
  // subscription. The model name is therefore NOT the decision any more - the tier that came
  // back is - and the honest source for `canReadFiles` is the gate's tier, because a cheap
  // answer can never have opened a file (ATTACH's bug class: claiming it did).
  try {
    // Claude Code runs where it can read the projects (read-only), so the CEO can
    // ask questions about any project and get answers from the real files.
    // ASSISTANT-BRAIN widens that read access to the whole company folder (run cards,
    // briefings, traces, fleet orders) and the live jcode session journals, and asks
    // for the plain-words checklist style on status answers.
    const r = await callClaudeSubscription({
      model: claudeModel || choice || cheapModel(),
      // CHEAP BY DEFAULT (assistant): classify the CEO's ORDER TEXT, never the assembled
      // prompt - see the note on this function's `brainText` parameter.
      brainText: brainText ?? user,
      // BRAIN ROUTING: the assistant names its purpose; the model above is the MAX
      // tier (ASSISTANT_MODEL). cwd/addDirs below mean this call reads files, so the
      // router flags a file-blind tier instead of hiding it.
      purpose: "assistant",
      system: `${system}\n\nYou can read files (Read/Glob/Grep), and only the Claude-backed assistant can. Company projects live under ${getCompanyRoot()}\\projects\\<projectId>\\repo. When the CEO asks a question, look at the real files and answer it in "reply" with "tasks":[] - only create tasks when the CEO orders work. You can also read: ${getCompanyRoot()} (projects/*/tasks.json hold each task's trace, reports/runs/*.json and reports/briefing.json hold the run manager's checks, fleet/orders.json holds fleet work orders) and ${path.join(os.homedir(), ".jcode", "sessions")} (live jcode session journals). Read what you need before answering anything about status and name what you checked, for example "I checked the run cards". If you CANNOT open files on this call, answer only from the digests in this prompt, say plainly that you could not open the files, and never claim to have read one. When you report status, reply in plain words as "Done: ... / Remaining: ... / Needs you: ...", one short line each, no file paths and no jargon.${noTools ? " CRITICAL for this call: you have NO tools and NO file access - do not emit tool calls, do not emit any <||...||> markup, and do not claim to have read anything. Reply with the required JSON object only, and start it with {" : ""}`,
      user,
      cwd: path.dirname(getCompanyRoot()),
      // ATTACH: the uploads folder is inside the company root, which is already listed;
      // it is named explicitly as well so an attachment can never be missed because the
      // company root was narrowed later.
      addDirs: [...assistantReadRoots(), uploadsRoot()],
    });
    const text = (r?.text ?? "").trim();
    if (!text) throw new Error("empty response");
    // The gate's tier is the only honest statement about what ran and what it could read.
    const brain = r.brain;
    const ranCheap = brain?.tier === "none";
    const used = brain?.model || r.model || claudeModel || choice;
    if (ranCheap) {
      decisions.push(
        `Answered on ${used} with no Claude call: the Laya gate read this order as small (${brain?.reason ?? "cheap by default"}), so status claims come from the digests in the prompt, not from the files.`
      );
    }
    return { text, model: used, canReadFiles: !ranCheap };
  } catch (claudeErr) {
    decisions.push(
      `Claude subscription (${ROLES.assistant.defaultModel}) unavailable: ${clamp(String(claudeErr), 160)}. Fell back to ${config.models.standard} on the gateway.`
    );
    const fb = await callGatewayModel(config.models.standard, system, user);
    const text = (fb?.text ?? "").trim();
    if (!text) throw new Error(`assistant fallback (${config.models.standard}) returned no text`);
    return { text: `${text}\n\n[assistant-fallback: Claude -> ${config.models.standard}]`, model: config.models.standard, canReadFiles: false };
  }
}

function firstBalancedObject(s: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

// Strip markdown fences, then take the first balanced {...} block that actually parses.
function extractJsonObject(raw: string): unknown | null {
  const cleaned = String(raw ?? "").replace(/```[a-zA-Z]*/g, "");
  let idx = cleaned.indexOf("{");
  while (idx >= 0) {
    const block = firstBalancedObject(cleaned, idx);
    if (block) {
      try {
        return JSON.parse(block);
      } catch {
        // not valid JSON yet: try the next opening brace
      }
    }
    idx = cleaned.indexOf("{", idx + 1);
  }
  return null;
}

function normalizeRole(rawRole: string, decisions: string[]): RoleId {
  const role = rawRole.trim().toLowerCase() as RoleId;
  if ((PIPELINE_ROLES as string[]).includes(role)) return role;
  decisions.push(`Role "${rawRole}" is not a pipeline role; defaulted that task to the coder track.`);
  return "coder";
}

type ResolvedProject = { project: ProjectDef; created: boolean };

function resolveProject(item: AssistantPlanItem, decisions: string[]): ResolvedProject | undefined {
  const org = loadOrg();

  if (item.projectId) {
    const explicit = org.projects.find((p) => p.id === item.projectId);
    if (explicit) {
      decisions.push(`Routed "${item.title}" to the project the plan named: ${explicit.name} (${explicit.id}) in ${departmentNameOf(explicit)}.`);
      return { project: explicit, created: false };
    }
    decisions.push(`The plan named project id "${item.projectId}", which is not in the org; used the ${item.departmentName} department instead.`);
  }

  const named = item.departmentName.trim().toLowerCase();
  const dept = org.departments.find((d) => d.name.trim().toLowerCase() === named);
  if (dept) {
    const existing = dept.projectIds
      .map((pid) => org.projects.find((p) => p.id === pid))
      .filter((p): p is ProjectDef => !!p);
    if (existing.length) {
      decisions.push(`Routed "${item.title}" to ${dept.name}'s existing project ${existing[0].name} (${existing[0].id}).`);
      return { project: existing[0], created: false };
    }
  }

  // No usable project: hire one. createProject mints a department too, so fold the new
  // project back into the existing department when we matched one by name.
  try {
    const { project } = createProject({
      companyName: org.name,
      departmentName: dept?.name ?? (item.departmentName.trim() || "Engineering"),
      projectName: item.title.slice(0, 60),
      description: item.request.slice(0, 200),
    });
    if (dept) {
      try {
        const after = loadOrg();
        const dup = after.departments.find((d) => d.id === project.departmentId);
        const target = after.departments.find((d) => d.id === dept.id);
        if (dup && target && dup.id !== target.id) {
          target.projectIds.push(project.id);
          after.departments = after.departments.filter((d) => d.id !== dup.id);
          const proj = after.projects.find((p) => p.id === project.id);
          if (proj) proj.departmentId = target.id;
          saveOrg(after);
        }
      } catch {
        // keep the freshly created department/project pairing if the merge fails
      }
      decisions.push(
        `${dept.name} had no project, so I created "${project.name}" (${project.id}) for "${item.title}" with its own default team.`
      );
    } else {
      decisions.push(
        `No department named "${item.departmentName}" existed, so I created department "${item.departmentName || "Engineering"}" with project "${project.name}" (${project.id}).`
      );
    }
    return { project: getProject(project.id) ?? project, created: true };
  } catch (e) {
    decisions.push(`Could not create a project for "${item.title}" in ${item.departmentName}: ${clamp(String(e), 120)}.`);
    return undefined;
  }
}

function dispatchedSessions(taskIds: Set<string>, projectIds: Set<string>): SessionRec[] {
  try {
    // Sessions that belong to the tasks we just dispatched, plus anything still live in
    // those projects (covers the moment before the first agent session exists).
    return listSessions(80).filter(
      (s) =>
        (!!s.taskId && taskIds.has(s.taskId)) ||
        (s.status === "running" && projectIds.has(s.projectId))
    );
  } catch {
    return [];
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function departmentNameOf(project: ProjectDef): string {
  return loadOrg().departments.find((d) => d.id === project.departmentId)?.name ?? "Unassigned";
}

// ---------------------------------------------------------------------------
// ASSISTANT-BRAIN (docs/REPORTING_SPEC.md §3, 2026-09-29)
//
// Three additions on top of the original chief-of-staff behaviour:
//   1. real conversation history, so follow-ups ("and what about the second one?")
//      resolve instead of being answered in a vacuum;
//   2. the CEO briefing + run cards from REPORTING (src/company/briefing.ts), so the
//      assistant knows the state of every run, not just the tasks it dispatched;
//   3. a Laya track choice per planned task (pipeline | fleet | answer) with a
//      confidence guard, so "add X to the platform" reaches the fleet and a plain
//      question stays a question.
//
// briefing.ts (REPORTING) and fleet.ts (FLEET-BACKEND) are built in parallel and may
// not exist on disk yet, so both are loaded through softImport(): the assistant keeps
// working, and says plainly what it could not check, until they land.
// ---------------------------------------------------------------------------

export type AssistantTrack = "pipeline" | "fleet" | "answer";

// REVERTED ON EVIDENCE. An earlier draft of this text used concrete "our own
// platform" cues for fleet and a sentence starting "Answer only if..." on the
// pipeline line. Measured with ops/laya-eval.ts (repeat 2, 13 tracks x 2): the
// old wording scored 77%, the new draft 62%, i.e. it LOST five pipeline cases to
// fleet/answer. Per the task rule (ship only what improves accuracy) the wording,
// instructions and state below are byte-for-byte the pre-LAYA-TUNE text. Details
// and the losing cases: docs/LAYA_TUNING.md.
const TRACK_CRITERIA: Record<AssistantTrack, string> = {
  pipeline:
    "Work inside one of our existing product projects: a single well-scoped change (a feature, fix, page, test) that one team's pipeline can build and merge today.",
  fleet:
    "A change to our own platform or tooling, or big multi-part work: several files or areas, needs planning and several parallel workers (e.g. dashboard rebuild, new backend API, docs overhaul).",
  answer: "No work at all: the CEO is asking a question or asking for status, so reply with words only.",
};

// Exported so ops/laya-eval.ts measures the exact wording that ships. Pure: it
// only reads the text, it never calls Laya or touches the disk.
export function trackQuestionSpec(title: string, request: string) {
  return {
    state: { order: `${title}\n${request}`.slice(0, 1500) },
    questions: {
      track: {
        type: "choice" as const,
        instructions:
          "Which track should this work take? pipeline = one existing product team's pipeline builds it. fleet = a change to our own platform/tooling, or big multi-part work needing planning and several parallel workers. answer = no work at all, the CEO is only asking a question.",
        criteria: TRACK_CRITERIA,
      },
    },
    decide: (a: Record<string, { choice?: string } | undefined>) => {
      const pick = a.track?.choice ?? "";
      const conf = (a.track as { confidence?: number } | undefined)?.confidence ?? 0;
      return { choice: pick, note: `Laya track=${pick} conf=${conf.toFixed(2)}` };
    },
  };
}

// Bound on the RUN REPORT block pasted into the prompt, so a long briefing cannot
// crowd out the org digest. The assistant runs on a frontier model (ASSISTANT_MODEL),
// so ~5k chars is a small slice of its context.
export const RUN_REPORT_MAX_CHARS = 5000;

const ASSISTANT_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

// Sibling company modules are written by other workers in parallel (REPORTING owns
// briefing.ts, FLEET-BACKEND owns fleet.ts). Load one only if the file is actually
// there, and never let an import failure reach the assistant turn.
async function softImport(name: string): Promise<Record<string, unknown> | undefined> {
  for (const ext of [".js", ".ts"]) {
    const file = path.join(ASSISTANT_MODULE_DIR, `${name}${ext}`);
    try {
      if (!fs.existsSync(file)) continue;
      return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    } catch (e) {
      console.warn(`[assistant] could not load ${name}${ext}: ${String(e)}`);
      return undefined;
    }
  }
  return undefined;
}

type NeedsYouAction = { id: string; label: string; effect?: string; params?: Record<string, unknown>; url?: string };
type NeedsYouInput = { name: string; label: string; secret: boolean; placeholder?: string };
type BriefingItem = {
  text?: string;
  runId?: string;
  owner?: string;
  at?: string;
  remaining?: string[];
  // NEEDS-YOU (NY-CHAT): optional fields that appear on needs-you items.
  id?: string;
  kind?: "approve" | "choice" | "provide" | "external";
  question?: string;
  input?: NeedsYouInput;
  actions?: NeedsYouAction[];
};
type BriefingLike = {
  generatedAt?: string;
  model?: string;
  summary?: string;
  needsYou?: BriefingItem[];
  done?: BriefingItem[];
  inProgress?: BriefingItem[];
  problems?: BriefingItem[];
  counts?: { running?: number; done?: number; failed?: number; stuck?: number };
};
type RunCardLike = {
  runId?: string;
  kind?: string;
  title?: string;
  owner?: string;
  state?: string;
  headline?: string;
  done?: string[];
  remaining?: string[];
  needsCeo?: string;
  model?: string;
  modelReason?: string;
  checkedAt?: string;
  updatedAt?: string;
};

function readJsonFile<T>(file: string): T | undefined {
  try {
    if (!fs.existsSync(file)) return undefined;
    const raw = fs.readFileSync(file, "utf8").trim();
    if (!raw) return undefined;
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object";
}

function textList(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && !!x.trim()).slice(0, max);
}

// ---------------------------------------------------------------------------
// NEEDS-YOU CHAT (NY-CHAT, docs/NEEDS_YOU_SPEC.md §7)
//
// The CEO can answer needs-you items by replying in the assistant thread. We
// ask each open question once, record that we asked it, and match the CEO's
// reply to the most recently asked item. The resolver lives in
// src/company/needsYouActions.ts (NY-RESOLVER) and is soft-imported so the
// assistant keeps working before that file ships.
// ---------------------------------------------------------------------------

export type ResolveResult = {
  ok: boolean;
  message: string;
  newState?: string;
  itemId: string;
  actionId: string;
  needsYou?: BriefingItem[];
};

type NeedsYouResolver = (
  itemId: string,
  actionId: string,
  input?: Record<string, string>,
  who?: string,
) => Promise<ResolveResult>;

let injectedNeedsYouResolver: NeedsYouResolver | undefined;
let resolverLoadAttempted = false;
let cachedNeedsYouResolver: NeedsYouResolver | undefined;

/** Test hook: replace the real resolver with a stub. */
export function setNeedsYouResolverForTest(resolver: NeedsYouResolver | undefined): void {
  injectedNeedsYouResolver = resolver;
  cachedNeedsYouResolver = resolver;
  resolverLoadAttempted = true;
}

async function loadNeedsYouResolver(): Promise<NeedsYouResolver | undefined> {
  if (injectedNeedsYouResolver) return injectedNeedsYouResolver;
  if (resolverLoadAttempted) return cachedNeedsYouResolver;
  resolverLoadAttempted = true;
  const mod = await softImport("needsYouActions");
  if (!mod) return undefined;
  const fn = mod.resolveNeedsYou;
  if (typeof fn === "function") {
    cachedNeedsYouResolver = fn as NeedsYouResolver;
  }
  return cachedNeedsYouResolver;
}

function needsYouAskedFile(): string {
  return path.join(getCompanyRoot(), "reports", "needs-you-asked.json");
}

function readNeedsYouAsked(): Record<string, { at: string }> {
  const file = needsYouAskedFile();
  try {
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, "utf8").trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!isObj(parsed)) return {};
    const out: Record<string, { at: string }> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (isObj(v) && typeof v.at === "string") out[k] = { at: v.at };
    }
    return out;
  } catch {
    return {};
  }
}

function writeNeedsYouAsked(asked: Record<string, { at: string }>): void {
  try {
    fs.mkdirSync(path.dirname(needsYouAskedFile()), { recursive: true });
    fs.writeFileSync(needsYouAskedFile(), JSON.stringify(asked, null, 2));
  } catch {
    // best effort
  }
}

function markNeedsYouAsked(id: string): void {
  const asked = readNeedsYouAsked();
  asked[id] = { at: nowIso() };
  writeNeedsYouAsked(asked);
}

function isQuestionKind(kind: string | undefined): kind is "approve" | "choice" | "external" {
  return kind === "approve" || kind === "choice" || kind === "external";
}

function isNeedsYouItem(v: unknown): v is BriefingItem {
  return isObj(v) && typeof v.id === "string" && !!v.id;
}

/** Synchronous read of open needs-you items from the briefing file. */
function readOpenNeedsYouSync(): BriefingItem[] {
  const file = path.join(getCompanyRoot(), "reports", "briefing.json");
  const briefing = readJsonFile<BriefingLike>(file);
  if (!briefing || !Array.isArray(briefing.needsYou)) return [];
  return briefing.needsYou.filter(isNeedsYouItem);
}

/**
 * Open needs-you items for the chat. The briefing FILE is the record the CEO's page is
 * built from, and the resolver's live composition is fresher; we union them by id so
 * chat can never miss a prompt the page is showing (DUPLICATE-PROMPTS: the page and the
 * chat must agree on what is open, or Joey contradicts the briefing).
 */
async function readOpenNeedsYouAsync(): Promise<BriefingItem[]> {
  const byId = new Map<string, BriefingItem>();
  for (const item of readOpenNeedsYouSync()) if (item.id) byId.set(item.id, item);
  const mod = await softImport("needsYouActions");
  if (mod && typeof mod.openNeedsYouItems === "function") {
    try {
      const items = await Promise.resolve((mod.openNeedsYouItems as () => unknown)());
      if (Array.isArray(items)) {
        for (const item of items.filter(isNeedsYouItem)) if (item.id) byId.set(item.id, item);
      }
    } catch {
      // fall through to the file items
    }
  }
  return [...byId.values()];
}

/** Ask the CEO each open needs-you question once. Returns the number asked. */
export function askNeedsYouInChat(): number {
  try {
    const asked = readNeedsYouAsked();
    const open = readOpenNeedsYouSync();
    // DUPLICATE-PROMPTS: several runs can raise the SAME question (the retry loop
    // reissues an order, and every failed fleet order falls back to "Retry this order
    // or drop it?"). Group them so the CEO is asked once, not once per run.
    const groups = new Map<string, BriefingItem[]>();
    for (const item of open) {
      const id = item.id!;
      if (asked[id]) continue;
      const sig = `${item.kind ?? ""}|${normalizeText(item.question || item.text || "")}`;
      const list = groups.get(sig);
      if (list) list.push(item);
      else groups.set(sig, [item]);
    }

    let count = 0;
    for (const group of groups.values()) {
      const item = group[0]!;
      const id = item.id!;
      if (item.kind === "provide") {
        const label = item.input?.label ?? item.text ?? "this item";
        const msg =
          `${label} needs a secret. Please use the masked field on the Briefing page; ` +
          "never send the secret here in chat.";
        appendAssistantThread({ ts: nowIso(), role: "assistant", text: msg });
        for (const it of group) if (it.id) markNeedsYouAsked(it.id);
        count++;
        continue;
      }
      if (!isQuestionKind(item.kind)) continue;
      const actions = Array.isArray(item.actions) ? item.actions.filter((a) => isObj(a)) : [];
      if (!actions.length) continue;
      const question = item.question || item.text || "This needs your decision.";
      const lines: string[] = [question];
      for (let i = 0; i < actions.length; i++) {
        const label = typeof actions[i].label === "string" ? actions[i].label : actions[i].id;
        lines.push(`${i + 1}. ${label}`);
      }
      lines.push("Reply with the option name or number.");
      if (group.length > 1) {
        lines.push(
          `(${group.length} runs are waiting on this same question; I am showing the newest and closing the rest.)`
        );
      }
      appendAssistantThread({ ts: nowIso(), role: "assistant", text: lines.join("\n") });
      for (const it of group) if (it.id) markNeedsYouAsked(it.id);
      count++;
    }
    return count;
  } catch {
    return 0;
  }
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function wordOverlap(a: string, b: string): number {
  const wordsA = new Set<string>(normalizeText(a).split(" ").filter(Boolean));
  const wordsB = new Set<string>(normalizeText(b).split(" ").filter(Boolean));
  if (!wordsA.size || !wordsB.size) return 0;
  let hit = 0;
  for (const w of wordsB) if (wordsA.has(w)) hit++;
  return hit / Math.max(wordsA.size, wordsB.size);
}

function findActionByText(actions: NeedsYouAction[], text: string): NeedsYouAction | undefined {
  const norm = normalizeText(text);
  // Direct id match first (e.g. "use_kimi" -> use_kimi).
  for (const a of actions) {
    if (a.id && normalizeText(a.id) === norm) return a;
  }
  // Fuzzy keyword maps for common actions.
  const keywordMap: Record<string, string[]> = {
    approve: ["approve", "yes", "ok", "approve_alt"],
    approve_alt: ["alt", "alternative", "other", "second"],
    retry: ["retry", "retry_task", "retry_order", "again", "resume"],
    drop: ["drop", "delete", "cancel", "give up"],
    use_kimi: ["kimi", "use kimi", "use_kimi"],
    raised_retry: ["raised", "recheck", "raised_retry"],
    open_limit_page: ["open", "page", "limit", "settings"],
    save_key_retry: ["save", "key", "retry"],
  };
  let best: NeedsYouAction | undefined;
  let bestScore = 0;
  for (const a of actions) {
    const keywords = keywordMap[a.id] ?? [];
    const labelNorm = normalizeText(a.label);
    const idNorm = normalizeText(a.id);
    // Number match handled separately.
    if (/^\d+$/.test(norm)) return undefined;
    let score = 0;
    if (labelNorm && norm.includes(labelNorm)) score += 2;
    if (idNorm && norm.includes(idNorm)) score += 2;
    for (const kw of keywords) {
      if (norm.includes(kw)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = a;
    }
  }
  return bestScore > 0 ? best : undefined;
}

/** Find an item the CEO referred to by name in their reply. */
function findItemByText(items: BriefingItem[], text: string): BriefingItem | undefined {
  if (!items.length) return undefined;
  const norm = normalizeText(text);
  // Number-only replies never refer to a named item.
  if (/^\d+$/.test(norm)) return undefined;
  let best: BriefingItem | undefined;
  let bestScore = 0;
  for (const item of items) {
    const probe = item.question || item.text || "";
    const score = wordOverlap(probe, text);
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  // Threshold: at least one content word in common.
  return bestScore >= 0.25 ? best : undefined;
}

/**
 * Try to match a CEO reply to an open needs-you question. Returns the resolver
 * result on a clear match, or null when the message is not an answer or is
 * ambiguous.
 */
export async function tryResolveFromChat(text: string): Promise<ResolveResult | null> {
  try {
    const trimmed = typeof text === "string" ? text.trim() : String(text ?? "").trim();
    if (!trimmed) return null;
    const asked = readNeedsYouAsked();
    const open = await readOpenNeedsYouAsync();
    const askedOpen = open.filter((item) => item.id && asked[item.id]);
    if (!askedOpen.length) return null;

    // Most recently asked first.
    askedOpen.sort((a, b) => {
      const atA = a.id ? asked[a.id].at : "";
      const atB = b.id ? asked[b.id].at : "";
      return atB.localeCompare(atA);
    });

    const numberMatch = /^\s*(\d+)\s*(?:\.\s*)?$/.exec(trimmed);
    const itemByName = findItemByText(askedOpen, trimmed);

    let item: BriefingItem | undefined;
    let action: NeedsYouAction | undefined;

    if (numberMatch) {
      const idx = parseInt(numberMatch[1], 10) - 1;
      item = askedOpen[0];
      const actions = Array.isArray(item.actions) ? item.actions.filter((a) => isObj(a)) : [];
      if (idx >= 0 && idx < actions.length) action = actions[idx];
    } else if (itemByName) {
      item = itemByName;
      const actions = Array.isArray(item.actions) ? item.actions.filter((a) => isObj(a)) : [];
      action = findActionByText(actions, trimmed);
      if (!action) return null; // named item but action is unclear
    } else {
      // No named item: assume the most recently asked item and look for an action.
      item = askedOpen[0];
      const actions = Array.isArray(item.actions) ? item.actions.filter((a) => isObj(a)) : [];
      action = findActionByText(actions, trimmed);
    }

    if (!item || !action || !item.id) return null;
    if (item.kind === "provide") return null; // never resolve provide from chat

    // Ambiguity guard: if multiple items match and we are not using a number reply,
    // require that the matched action is unique across matching items.
    if (!numberMatch && askedOpen.length > 1) {
      const matches = askedOpen.filter((it) => {
        if (it.kind === "provide") return false;
        const acts = Array.isArray(it.actions) ? it.actions.filter((a) => isObj(a)) : [];
        return !!findActionByText(acts, trimmed);
      });
      if (matches.length > 1) return null;
    }

    const resolver = await loadNeedsYouResolver();
    if (!resolver) {
      return {
        ok: false,
        message: "The needs-you resolver is not loaded yet; please use the Briefing page.",
        itemId: item.id,
        actionId: action.id,
      };
    }
    return await resolver(item.id, action.id, undefined, "ceo-chat");
  } catch {
    return null;
  }
}

// Run cards as written by REPORTING: company/reports/runs/<runId>.json with the
// history appended to company/reports/runs.jsonl. Used only as the fallback when
// briefing.ts is not on disk yet.
function readRunCardFiles(): RunCardLike[] {
  const out: RunCardLike[] = [];
  const runsDir = path.join(getCompanyRoot(), "reports", "runs");
  try {
    if (fs.existsSync(runsDir)) {
      for (const f of fs.readdirSync(runsDir).filter((n) => n.endsWith(".json")).slice(0, 40)) {
        const card = readJsonFile<RunCardLike>(path.join(runsDir, f));
        if (isObj(card)) out.push(card);
      }
    }
  } catch {
    // unreadable folder: fall through to the history file
  }
  if (!out.length) {
    try {
      const hist = path.join(getCompanyRoot(), "reports", "runs.jsonl");
      if (fs.existsSync(hist)) {
        const lines = fs.readFileSync(hist, "utf8").trim().split("\n").filter(Boolean).slice(-200);
        const byId = new Map<string, RunCardLike>();
        for (const line of lines) {
          try {
            const card = JSON.parse(line) as RunCardLike;
            if (isObj(card) && card.runId) byId.set(card.runId, card);
          } catch {
            // skip a corrupt line
          }
        }
        out.push(...byId.values());
      }
    } catch {
      // best effort
    }
  }
  return out;
}

// Plain-words rendering of the briefing + run cards. This is the material the
// assistant composes its "Done: / Remaining: / Needs you:" answers from. Every item
// is clamped individually, because a run's raw work-order text can be paragraphs long
// and one verbose card must not crowd the others out of the prompt.
function renderRunReport(briefing: BriefingLike | undefined, cards: RunCardLike[]): string {
  const lines: string[] = [];
  const one = (v: unknown, n: number) => clamp(String(v ?? "").replace(/\s+/g, " ").trim(), n);
  if (briefing) {
    const head = [briefing.generatedAt ? `generated ${briefing.generatedAt}` : "", briefing.model ? `by ${briefing.model}` : ""]
      .filter(Boolean)
      .join(" ");
    if (head) lines.push(`Briefing ${head}.`);
    if (briefing.summary) lines.push(`Summary: ${one(briefing.summary, 320)}`);
    const pick = (v: unknown) => (Array.isArray(v) ? v.filter((i): i is BriefingItem => isObj(i) && !!i.text) : []);
    const needs = pick(briefing.needsYou);
    if (needs.length) {
      lines.push("NEEDS YOU:");
      for (const n of needs.slice(0, 6)) {
        const q = one(n.question || n.text || "(no question)", 140);
        const labels = Array.isArray(n.actions)
          ? n.actions
              .slice(0, 6)
              .map((a, i) => `${i + 1}. ${one(typeof a.label === "string" ? a.label : a.id, 60)}`)
              .join(", ")
          : "";
        lines.push(`- ${q}${labels ? ` [${labels}]` : ""}`);
      }
    }
    const done = pick(briefing.done);
    if (done.length) lines.push(`DONE: ${done.slice(0, 6).map((d) => one(d.text, 150)).join(" | ")}`);
    for (const p of pick(briefing.inProgress).slice(0, 6)) {
      const rem = textList(p.remaining, 4).map((r) => one(r, 100)).join("; ");
      lines.push(
        `IN PROGRESS: ${one(p.text, 140)}${p.owner ? ` (${one(p.owner, 60)})` : ""}${rem ? ` - remaining: ${rem}` : ""}`
      );
    }
    const probs = pick(briefing.problems);
    if (probs.length) lines.push(`PROBLEMS: ${probs.slice(0, 6).map((p) => one(p.text, 160)).join(" | ")}`);
    const c = briefing.counts;
    if (c) lines.push(`COUNTS: running ${c.running ?? 0}, done ${c.done ?? 0}, failed ${c.failed ?? 0}, stuck ${c.stuck ?? 0}`);
  }
  if (cards.length) {
    const stamp = (c: RunCardLike) => String(c.checkedAt ?? c.updatedAt ?? "");
    const sorted = [...cards].sort((a, b) => stamp(b).localeCompare(stamp(a)));
    lines.push(`RUN CARDS (${sorted.length}, newest check first):`);
    for (const c of sorted.slice(0, 12)) {
      const parts: string[] = [];
      if (c.state) parts.push(c.state);
      if (c.headline) parts.push(one(c.headline, 140));
      const d = textList(c.done, 3).map((x) => one(x, 90));
      const r = textList(c.remaining, 3).map((x) => one(x, 90));
      if (d.length) parts.push(`done: ${d.join("; ")}`);
      if (r.length) parts.push(`remaining: ${r.join("; ")}`);
      if (c.needsCeo) parts.push(`needs CEO: ${one(c.needsCeo, 120)}`);
      if (c.model) parts.push(`model ${c.model}${c.modelReason ? ` (${one(c.modelReason, 80)})` : ""}`);
      lines.push(`- ${one(c.title ?? c.runId ?? "run", 90)}${c.kind ? ` [${c.kind}]` : ""}${c.owner ? ` - ${one(c.owner, 60)}` : ""}: ${parts.join(" | ")}`);
    }
  }
  const text = lines.join("\n");
  if (!text) return "(no briefing and no run cards yet)";
  return text.length > RUN_REPORT_MAX_CHARS
    ? `${text.slice(0, RUN_REPORT_MAX_CHARS)}... (run report truncated)`
    : text;
}

// The RUN REPORT block for the prompt. Prefers REPORTING's exports (agreed in
// docs/AGENT_COORDINATION.md): getBriefing() from src/company/briefing.ts and
// listRunCards() from src/company/runManagers.ts. Falls back to the files those
// functions read, and finally to a labelled "nothing yet" line. Never throws.
export async function assistantBriefingContext(): Promise<string> {
  try {
    const briefingMod = await softImport("briefing");
    const runsMod = await softImport("runManagers");
    if (briefingMod || runsMod) {
      const getBriefing = briefingMod?.getBriefing as (() => unknown) | undefined;
      const listRunCards = (runsMod?.listRunCards ?? briefingMod?.listRunCards) as (() => unknown) | undefined;
      let briefing: BriefingLike | undefined;
      let cards: RunCardLike[] = [];
      if (typeof getBriefing === "function") {
        const b = await Promise.resolve(getBriefing());
        if (isObj(b)) briefing = b as BriefingLike;
      }
      if (typeof listRunCards === "function") {
        const c = await Promise.resolve(listRunCards());
        if (Array.isArray(c)) cards = c.filter((x): x is RunCardLike => isObj(x));
      }
      const where = [briefingMod ? "briefing.ts" : "no briefing.ts", runsMod ? "runManagers.ts" : "no runManagers.ts"].join(", ");
      if (briefing || cards.length) {
        return `source: ${where} (${briefing ? "briefing" : "no briefing yet"}${cards.length ? `, ${cards.length} run card(s)` : ""})\n${renderRunReport(briefing, cards)}`;
      }
      return `source: ${where} (loaded, but no briefing and no run cards yet - say you have no manager checks yet).`;
    }
  } catch (e) {
    console.warn(`[assistant] reporting context failed: ${String(e)}`);
  }
  const briefing = readJsonFile<BriefingLike>(path.join(getCompanyRoot(), "reports", "briefing.json"));
  const cards = readRunCardFiles();
  if (briefing || cards.length) {
    return `source: company/reports files (briefing.ts not loaded yet)\n${renderRunReport(briefing, cards)}`;
  }
  return "source: none. No briefing and no run cards exist yet (the reporting watcher has not produced one, or briefing.ts has not shipped). Say so plainly if the CEO asks about run status; never invent status.";
}

// The last `limit` CEO/assistant messages, oldest first, condensed to one line each.
export function conversationHistory(limit: number): string {
  const turns = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  if (!turns) return "";
  return assistantThread(turns)
    .map(
      (t) =>
        `${t.role === "ceo" ? "CEO" : "Assistant"}: ${clamp(String(t.text ?? "").replace(/\s+/g, " ").trim(), 600)}`
    )
    .join("\n");
}

// Laya picks the track for one planned task (a 3-way choice on the same
// /v1/systemone protocol the rest of the decision layer uses). Returns undefined
// when Laya is offline, slow or answers with an unknown option, so the caller keeps
// the plan's own track. Laya's confidence formula reads low, hence the guard.
async function chooseTrack(
  title: string,
  request: string
): Promise<{ track: AssistantTrack; confidence: number; reason: string } | undefined> {
  if (config.mockMode) return undefined;
  const rawTimeout = Number(process.env.LAYA_TRACK_TIMEOUT_MS ?? 20000);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const spec = trackQuestionSpec(title, request);
  try {
    const res = await fetch(`${config.decisionBaseUrl}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.decisionKey}` },
      body: JSON.stringify({ state: spec.state, questions: spec.questions }),
      signal: controller.signal,
    });
    if (!res.ok) return undefined;
    const j = (await res.json()) as { answers?: Record<string, { choice?: string; confidence?: number } | undefined> };
    const d = spec.decide(j.answers ?? {});
    if (!d.choice || !(d.choice in TRACK_CRITERIA)) return undefined;
    const confidence = j.answers?.track?.confidence ?? 0;
    return { track: d.choice as AssistantTrack, confidence, reason: `${d.note}` };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

// FLEET-BACKEND's entry point (src/company/fleet.ts, docs/FLEET_SPEC.md). A soft
// import: when the module is not on disk yet the caller says so in the reply and
// keeps the task on the pipeline track.
async function startFleetOrder(text: string): Promise<{ ok: boolean; orderId?: string; detail: string }> {
  const mod = await softImport("fleet");
  if (!mod) {
    return { ok: false, detail: "src/company/fleet.ts is not on disk yet (FLEET-BACKEND is still building it)" };
  }
  for (const name of ["createFleetOrder", "createFleetOrderFromText", "createOrder"]) {
    const fn = mod[name];
    if (typeof fn !== "function") continue;
    try {
      const out = await (fn as (t: string) => Promise<unknown>)(text);
      const rec = isObj(out) ? out : {};
      const orderId =
        typeof rec.id === "string" ? rec.id : typeof rec.orderId === "string" ? rec.orderId : undefined;
      const status = typeof rec.status === "string" ? rec.status : "planning";
      return { ok: true, ...(orderId ? { orderId } : {}), detail: `fleet order ${orderId ?? "(no id)"} status=${status}` };
    } catch (e) {
      return { ok: false, detail: `fleet.ts ${name}() threw: ${clamp(String(e), 200)}` };
    }
  }
  return { ok: false, detail: "src/company/fleet.ts exists but exports no createFleetOrder(text)" };
}

// Extra read-only roots for the assistant's Claude Code call: the whole company
// folder (projects, reports/run cards, fleet orders) plus the live jcode session
// journals, so it can dig into any project, run or manager when the CEO asks.
function assistantReadRoots(): string[] {
  return [getCompanyRoot(), path.join(os.homedir(), ".jcode", "sessions")];
}

// Test hooks for ops/assistant-brain-check.ts: they expose the soft module loader and
// the Laya track choice without making either public API. No behaviour of its own.
export const __testSoftImport = softImport;
export const __testChooseTrack = chooseTrack;
export const __testStartFleetOrder = startFleetOrder;
export const __testBriefingContext = assistantBriefingContext;
export const __testConversationHistory = conversationHistory;

export async function assistantMessage(
  text: string,
  opts: { autoRun?: boolean; attachments?: unknown; spoken?: boolean } = {}
): Promise<AssistantResult> {
  const decisions: string[] = [];
  const instruction = typeof text === "string" ? text.trim() : String(text ?? "").trim();

  // ATTACH: resolve the upload ids the CEO's page sent to real paths on this machine.
  // A missing/malformed id is reported in decisions and never guessed at.
  const resolved = resolveUploads(opts.attachments);
  const attachments = resolved.found;
  if (resolved.missing.length) {
    decisions.push(
      `Could not find ${resolved.missing.length} attached file(s) (${resolved.missing.join(", ")}); the rest of the order was handled as usual.`
    );
  }

  // The assistant always exists, always has a budget row.
  const assistant = ensureAssistantAgent();
  let assistantBudgetKey = assistant.agentKey;
  try {
    const registered = ensureAgentBudget({
      agentId: assistant.agentId,
      name: assistant.name,
      role: "assistant",
      tier: ROLES.assistant.costTier,
      departmentId: assistant.departmentId,
      departmentName: assistant.departmentName,
      projectId: assistant.projectId,
      projectName: assistant.projectName,
      modelId: assistant.modelId,
    });
    if (registered?.agentId) assistantBudgetKey = registered.agentId;
  } catch {
    decisions.push("Budget store was unavailable while registering the assistant; spend may not be tracked.");
  }

  const assistantBudget = getBudget(assistantBudgetKey) ?? assistant.budget;
  decisions.push(
    `Budget: there are no per-agent quotas (removed 2026-10-01). Company measured spend so far: $${budgetSummary().spentUsd.toFixed(2)}. ` +
      `My own (assistant) measured spend: $${assistantBudget.spentUsd.toFixed(2)}.`
  );

  if (!instruction) {
    return {
      reply: "Send me an instruction and I will plan it, route it to a department and dispatch the work.",
      plan: [],
      dispatched: [],
      sessions: [],
      budgets: budgetSummary(),
      decisions,
      ...(attachments.length ? { attachments } : {}),
    };
  }

  // ASSISTANT-BRAIN: history is captured BEFORE this message is appended, so the
  // current instruction is part of the CEO line at the end of the prompt and is not
  // duplicated in the conversation block.
  const rawHistoryTurns = Number(process.env.ASSISTANT_HISTORY_TURNS ?? 12);
  const historyTurns = Number.isFinite(rawHistoryTurns) && rawHistoryTurns >= 0 ? Math.floor(rawHistoryTurns) : 12;
  const history = conversationHistory(historyTurns);
  const messageId = nowIso(); // the CEO thread entry's ts doubles as the message id
  appendAssistantThread({
    ts: messageId,
    role: "ceo",
    text: instruction,
    // VOICE-ROUTE: mark the CEO entry as spoken when the order arrived by voice.
    ...(opts.spoken ? { spoken: true } : {}),
    // ATTACH: name the files in the thread entry, so reading the thread later still shows
    // which files went with this order (the page's chips are cleared once it is sent).
    ...(attachments.length ? { attachments: attachments.map((a) => a.name) } : {}),
  });

  // NEEDS-YOU (NY-CHAT): if the CEO is replying to a question we asked in chat,
  // resolve it and skip the normal planning/dispatch path.
  const needsYouResolution = await tryResolveFromChat(instruction);
  if (needsYouResolution) {
    const remaining = needsYouResolution.needsYou?.length ?? (await readOpenNeedsYouAsync()).length;
    const reply = `${needsYouResolution.message}\n\nStill waiting on you: ${remaining} item(s).`;
    appendAssistantThread({ ts: nowIso(), role: "assistant", text: reply, tasks: [] });
    speakAssistantReply(reply);
    return {
      reply,
      plan: [],
      dispatched: [],
      sessions: [],
      budgets: budgetSummary(),
      decisions: [`Resolved needs-you item ${needsYouResolution.itemId} with action ${needsYouResolution.actionId}: ${needsYouResolution.message}`],
      ...(attachments.length ? { attachments } : {}),
    };
  }

  // REPORTING's briefing + run cards (plain words), or a labelled "nothing yet" line
  // while src/company/briefing.ts is still being built. Never throws.
  const runReport = await assistantBriefingContext();

  const system = buildSystemPrompt();
  // BUDGET + ATTACH: one guarded model choice per order, asked with needsFileRead when the
  // CEO attached something, so the guard itself tells us when the model it returns cannot
  // open the file (lostFileRead) instead of us guessing from the model name.
  const requestedModel = (process.env.ASSISTANT_MODEL ?? cheapModel()).trim();
  // CEO ORDER (cheap by default, 2026-09-30): ASSISTANT_MODEL is a CEILING only, and OPUS is
  // reachable through it ONLY when the CEO names opus in the order itself (pickBrain checks
  // that first, before Laya). So the `.env` line `ASSISTANT_MODEL=claude-opus-5-5` can no
  // longer make an ordinary order run on Opus: without a CEO naming it, the assistant's
  // ceiling is Sonnet and the gate decides whether even that is spent. I did not touch .env
  // (rose's row) - the code now makes the setting harmless instead, and lowering the line is
  // still worth doing for clarity.
  const ceilingModel = /opus/i.test(requestedModel) && !ceoNamedTier(instruction) ? config.claudeSonnet : requestedModel;
  const modelChoice = applyBudgetFilter({ model: ceilingModel, role: "assistant", needsFileRead: attachments.length > 0 });
  const chosenModel = modelChoice.model || ceilingModel;
  const attachReadable = !modelChoice.lostFileRead;
  if (modelChoice.changed) {
    decisions.push(
      `Claude budget guard: asked for ${requestedModel}, running ${chosenModel} for this call. ${modelChoice.reason}`
    );
  }
  if (modelChoice.lostFileRead) {
    decisions.push(
      `BUDGET flagged lostFileRead for ${attachments.length} attached file(s): ${chosenModel} cannot open them, so the reply says so and no worker will be given a description of their contents.`
    );
  }

  // ATTACH: the CEO's files are injected right after the instruction; the wording depends on
  // whether the model that will actually run can open them. An order with no attachments is
  // byte-identical to before this feature.
  const user = buildUserPrompt(
    instruction,
    history,
    runReport,
    attachmentsPromptBlock(attachments, attachReadable),
    attachReadable,
  );

  // In-flight marker (RESUME_SPEC §3): written before the planning call, cleared
  // right after it, so a restart mid-planning is redone once at the next boot.
  const inflight: AssistantInflight = {
    id: messageId,
    text: instruction,
    autoRun: opts.autoRun !== false,
    pid: process.pid,
    started: messageId,
  };
  writeInflight(inflight);

  let modelText = "";
  // ATTACH: whether the model that actually answered could open the attached files.
  let modelCanReadFiles = false;
  let answeringModel = "";
  try {
    const answer = await callAssistantModel(system, user, decisions, chosenModel, instruction);
    modelText = answer.text;
    modelCanReadFiles = answer.canReadFiles;
    answeringModel = answer.model;
  } catch (e) {
    const reply = `I could not reach my planning model: ${clamp(String(e), 300)}. Nothing was dispatched.`;
    decisions.push("No plan was produced because both the Claude subscription and the gateway fallback failed.");
    appendAssistantThread({ ts: nowIso(), role: "assistant", text: reply, tasks: [] });
    speakAssistantReply(reply);
    return {
      reply,
      plan: [],
      dispatched: [],
      sessions: [],
      budgets: budgetSummary(),
      decisions,
      error: "assistant_model_unavailable",
      ...(attachments.length ? { attachments } : {}),
    };
  } finally {
    clearInflight(inflight.id);
  }

  // ATTACH: the CEO must be told plainly, not misled, when the model in use cannot open
  // files. This is the "attachments need the Claude assistant" case: the cheap gateway
  // models can plan from the text, but nothing here can see inside a PDF or an image.
  const attachmentModelNote =
    attachments.length && !modelCanReadFiles
      ? `Attached files: I could not open ${attachments.length} attached file(s). The model I am running on right now (${answeringModel || "a non-Claude model"}) cannot read PDFs or images - attachments need the Claude assistant. `
        + `Ask the manager to set ASSISTANT_MODEL to a Claude model, then send the order again. `
        + `IGNORE anything in my answer below about the contents of those files: it was written without opening them. The files are saved on this machine:\n`
        + attachments.map((f) => `- ${f.path}`).join("\n")
      : "";
  if (attachmentModelNote) {
    decisions.push(
      `Answered on ${answeringModel}, which cannot read files: told the CEO that attachments need the Claude assistant. No claim about the file contents was made.`
    );
  }
  // ATTACH: "what the file shows" per attachment, written by the reading model. Used for
  // the worker hand-off (workers cannot open images) and for the memory note.
  const descriptions = new Map<string, string>();
  const whatFor = (f: UploadRec): string =>
    descriptions.get(f.path.toLowerCase()) ?? descriptions.get(f.name.toLowerCase()) ?? f.note ?? "";

  // The planning call itself costs money.
  try {
    // Free gateway models cost nothing; only the Claude path carries the frontier estimate.
    // BUDGET: the same guarded choice as the call above, so the cost recorded is the cost of
    // the model that actually ran (a red Claude window books the cheap rate).
    // CHEAP BY DEFAULT: the answering model is the gate's tier, NOT `chosenModel` (the
    // ceiling) - with ASSISTANT_MODEL=claude-opus-5-5 a small order runs on deepseek-v4.1-flash
    // and must not be booked at the frontier rate.
    const assistantModel = answeringModel || chosenModel;
    const callCost = assistantModel.startsWith("claude") ? estimateCostForRole("assistant", "router") : /free/i.test(assistantModel) ? 0 : 0.001;
    charge(assistantBudgetKey, callCost, "assistant planning call");
    decisions.push(`This planning call cost about $${callCost.toFixed(4)} from my budget.`);
  } catch {
    // charging is best effort
  }

  let parsed = extractJsonObject(modelText);
  let plan: AssistantPlanItem[] = [];
  let reply = "";
  let modelDecisions: string[] = [];

  // CHEAP PLANNER (finding 3): a file-blind tier sometimes answers with tool-call markup
  // (`<||DSML|| invoke name="Read">`) instead of the JSON object, so the plan came out empty.
  // Retry ONCE with the tools prohibition (the whole point of the picked tier is that it has
  // no tools), then fall through to the raw-text fallback if that fails too.
  if (parsed === null && !modelCanReadFiles && /<\|/.test(modelText)) {
    decisions.push(
      "The cheap planner answered with tool-call markup instead of JSON, so I asked it again with tools disabled."
    );
    try {
      const retry = await callAssistantModel(system, user, decisions, chosenModel, instruction, true);
      modelText = retry.text;
      answeringModel = retry.model;
      parsed = extractJsonObject(modelText);
    } catch (e) {
      decisions.push(`The tools-disabled retry failed too: ${clamp(String(e), 200)}`);
    }
  }

  if (!parsed || typeof parsed !== "object") {
    reply = clamp(modelText.trim(), 4000);
    if (attachmentModelNote) reply = clamp(`${attachmentModelNote}\n\n${reply}`, 4000);
    decisions.push("The planning model did not return parseable JSON, so it produced no tasks; its raw text is returned as the reply.");
    // ATTACH: the files still get their memory note, so they can be recalled later.
    rememberAttachments(attachments, whatFor, modelCanReadFiles);
    appendAssistantThread({ ts: nowIso(), role: "assistant", text: reply, tasks: [] });
    speakAssistantReply(reply);
    return {
      reply,
      plan: [],
      dispatched: [],
      sessions: [],
      budgets: budgetSummary(),
      decisions,
      ...(attachments.length ? { attachments } : {}),
    };
  }

  const obj = parsed as Record<string, unknown>;
  reply = typeof obj.reply === "string" ? obj.reply.trim() : "";
  if (Array.isArray(obj.decisions)) {
    modelDecisions = obj.decisions.filter((d): d is string => typeof d === "string" && !!d.trim());
  }
  // ATTACH: {"attachments":[{"path":"...","what":"..."}]} from the reading model. Two
  // rules, both about not putting a guess in front of a worker:
  //   - the descriptions are used ONLY from a model that could actually open the files,
  //     otherwise a text-only model can (and did, at 15:35Z one level below) restate file
  //     "contents" it never read straight into a task request;
  //   - a description that names no file we sent is dropped.
  // A stored note from an earlier read of the SAME upload id is still trusted: the file
  // behind an id never changes, and that note came from a reader (whatFor falls back to it).
  if (attachments.length && Array.isArray(obj.attachments) && !modelCanReadFiles) {
    decisions.push(
      `Ignored the description(s) my model offered for the attached files: it cannot open them, so any claim about their contents would be a guess.`
    );
  } else if (attachments.length && Array.isArray(obj.attachments)) {
    for (const rawNote of obj.attachments) {
      if (!rawNote || typeof rawNote !== "object") continue;
      const noteObj = rawNote as Record<string, unknown>;
      const notePath = typeof noteObj.path === "string" ? noteObj.path.trim().toLowerCase() : "";
      const noteFile = typeof noteObj.file === "string" ? noteObj.file.trim().toLowerCase() : "";
      const what = typeof noteObj.what === "string" ? noteObj.what.trim() : "";
      if (!what) continue;
      const cited = [notePath, noteFile].filter(Boolean).map((p) => path.basename(p));
      const match = attachments.find(
        (f) =>
          (notePath && (notePath === f.path.toLowerCase() || notePath.endsWith(path.basename(f.path).toLowerCase()))) ||
          (noteFile && noteFile === f.path.toLowerCase()) ||
          (cited.length > 0 && cited.some((b) => b === f.name.toLowerCase()))
      );
      if (!match) {
        decisions.push(`Ignored an attachment description that named no file we sent (${clamp(notePath || noteFile || "(no path)", 80)}).`);
        continue;
      }
      descriptions.set(match.path.toLowerCase(), what);
      descriptions.set(match.name.toLowerCase(), what);
    }
    for (const f of attachments) {
      if (!whatFor(f)) decisions.push(`The model did not describe ${f.name}; the task hand-off says so instead of inventing it.`);
    }
  }
  // ATTACH: the memory note (remember(), type reference): the path plus the 2-3 sentence
  // summary, so the file can be recalled later by name or by what it showed.
  rememberAttachments(attachments, whatFor, modelCanReadFiles);

  if (Array.isArray(obj.tasks)) {
    for (const raw of obj.tasks) {
      if (!raw || typeof raw !== "object") {
        decisions.push("Dropped one planned task that was not an object.");
        continue;
      }
      const rec = raw as Record<string, unknown>;
      const title = typeof rec.title === "string" ? rec.title.trim() : "";
      const departmentName = typeof rec.departmentName === "string" ? rec.departmentName.trim() : "";
      const role = typeof rec.role === "string" ? rec.role.trim() : "";
      const requestRaw = typeof rec.request === "string" ? rec.request.trim() : "";
      const projectIdRaw = typeof rec.projectId === "string" ? rec.projectId.trim() : "";
      const trackRaw = typeof rec.track === "string" ? rec.track.trim().toLowerCase() : "";
      if (!title || !departmentName || !role) {
        decisions.push(`Dropped one planned task missing title/departmentName/role (${clamp(JSON.stringify(rec), 120)}).`);
        continue;
      }
      plan.push({
        title,
        departmentName,
        role,
        request: requestOrInstruction(requestRaw, title, instruction),
        ...(projectIdRaw ? { projectId: projectIdRaw } : {}),
        ...(trackRaw in TRACK_CRITERIA ? { track: trackRaw as AssistantTrack } : {}),
      });
      if (plan.length >= MAX_PLAN_TASKS) {
        decisions.push(`Capped the plan at ${MAX_PLAN_TASKS} tasks to protect the budget; the remaining planned tasks were deferred.`);
        break;
      }
    }
  } else {
    decisions.push("The model returned no tasks array; nothing was dispatched.");
  }

  if (modelDecisions.length) decisions.push(...modelDecisions);
  if (!reply) {
    reply = plan.length
      ? `Planned ${plan.length} task(s) and dispatched the affordable ones; progress shows up in the sessions board.`
      : "I did not find an actionable task in that instruction.";
  }
  // ATTACH: a plan built without being able to read the files must not look like an
  // answer about the files, so the plain notice goes on top of the reply.
  if (attachmentModelNote) reply = `${attachmentModelNote}\n\n${reply}`;

  // ATTACH: what every task handed to a worker carries when the CEO attached files.
  // The workers (DeepSeek/opencode) cannot open a PDF or an image, so each request gets
  // the file paths AND the description written by the model that did read them.
  const attachmentHandoff =
    attachments.length
      ? [
          "",
          "ATTACHED FILES FROM THE CEO (you cannot open a PDF or an image; where a description is given below it was written by the Claude assistant that read the file):",
          ...attachments.map(
            (f) =>
              `- ${f.name} (${f.type}${f.pages ? `, about ${f.pages} page(s)` : ""}) - ${
                whatFor(f) ||
                "no description of what this file shows is available (nothing that could read it has been run), so ask the CEO or the Claude assistant instead of guessing"
              }\n  file: ${f.path}`
          ),
        ].join("\n")
      : "";

  // Dispatch.
  const dispatched: AssistantDispatch[] = [];
  const taskIds: string[] = [];
  const rosterCache = new Map<string, AgentView[]>();
  const cheapestOpencode = Math.min(
    estimateCostForRole("coder", "opencode"),
    estimateCostForRole("tester", "opencode")
  );

  const teamCatalog = (() => {
    try {
      const org = loadOrg();
      return org.projects
        .filter((p) => p.status === "active" && p.teams.some((t) => t.agents.length))
        .map((p) => ({
          id: p.id,
          name: p.name,
          department: org.departments.find((d) => d.id === p.departmentId)?.name ?? "",
          description: p.description ?? "",
        }));
    } catch {
      return [];
    }
  })();
  const LAYA_TEAM_MIN_CONF = Number(process.env.LAYA_TEAM_MIN_CONF ?? 0.3);
  // How sure Laya must be about a track before its pick overrides the plan's own.
  // Measured on the live local Laya on 2026-09-29 (ops/assistant-brain-check.ts track):
  // 0.19 / 0.10 / 0.34 for a product change / a platform change / a plain question.
  // Laya's confidence formula reads low (see src/decision.ts), so 0.2 accepts a
  // moderately sure pick and rejects the near-guesses; the plan's own track stands
  // whenever Laya is below it or offline.
  const rawTrackConf = Number(process.env.LAYA_TRACK_MIN_CONF ?? 0.2);
  const TRACK_MIN_CONF = Number.isFinite(rawTrackConf) ? rawTrackConf : 0.2;
  const fleetStarted: AssistantFleetDispatch[] = [];
  const replyNotes: string[] = [];

  for (const item of plan) {
    // --- Track routing (ASSISTANT-BRAIN). Laya picks the track per task; its pick
    // wins only above the confidence guard, otherwise the plan's own track stands.
    let track: AssistantTrack = item.track && item.track in TRACK_CRITERIA ? item.track : "pipeline";
    const layaTrack = await chooseTrack(item.title, item.request);
    let trackNote: string;
    if (layaTrack) {
      if (layaTrack.confidence >= TRACK_MIN_CONF) {
        trackNote = layaTrack.reason;
        if (layaTrack.track !== track) {
          decisions.push(`Laya track for "${item.title}": ${layaTrack.reason} (planned as "${track}"; Laya overrode it).`);
        } else {
          decisions.push(`Laya track for "${item.title}": ${layaTrack.reason}.`);
        }
        track = layaTrack.track;
      } else {
        trackNote = `${layaTrack.reason} (below the ${TRACK_MIN_CONF} guard)`;
        decisions.push(
          `Laya read the track as "${layaTrack.track}" at low confidence ${layaTrack.confidence.toFixed(2)} (< ${TRACK_MIN_CONF}), so the planned "${track}" track stands for "${item.title}".`
        );
      }
    } else {
      trackNote = "Laya unavailable; planned track used";
      decisions.push(`Laya track unavailable for "${item.title}"; used the planned "${track}" track.`);
    }

    if (track === "answer") {
      decisions.push(`"${item.title}" is an answer-only item: nothing was dispatched for it.`);
      continue;
    }

    if (track === "fleet") {
      const outcome = await startFleetOrder(item.request);
      if (outcome.ok) {
        fleetStarted.push({
          title: item.title,
          ...(outcome.orderId ? { orderId: outcome.orderId } : {}),
          status: "planning",
        });
        decisions.push(
          `Sent "${item.title}" to the fleet track (${outcome.detail}); the fleet plans the work orders and asks for your approval before spawning anyone.`
        );
        continue;
      }
      decisions.push(`Fleet track unavailable for "${item.title}": ${outcome.detail}. Kept it on the pipeline track.`);
      replyNotes.push(`Note: the fleet track is not available yet (${outcome.detail}), so I kept "${item.title}" on the pipeline.`);
      track = "pipeline";
    }

    // The assistant asks Laya which team should own this order. Laya wins when it
    // is confident; otherwise the assistant's own routing stands.
    const assistantPick = item.projectId || item.departmentName;
    const laya = await chooseTeam(item.request, teamCatalog);
    let layaNote = "Laya unavailable; assistant routed it";
    if (laya) {
      const name = teamCatalog.find((p) => p.id === laya.projectId)?.name ?? laya.projectId;
      if (laya.confidence >= LAYA_TEAM_MIN_CONF) {
        item.projectId = laya.projectId;
        layaNote = `${name} (${laya.reason})`;
      } else {
        layaNote = `low confidence for ${name} (${laya.reason}); kept assistant's pick ${assistantPick}`;
      }
      decisions.push(`Laya team pick for "${item.title}": ${layaNote}.`);
    }

    const target = resolveProject(item, decisions);
    if (!target) continue;

    const role = normalizeRole(item.role, decisions);
    const requiredUsd = estimateCostForRole(role, "router") + cheapestOpencode;

    let roster = rosterCache.get(target.project.id);
    if (!roster) {
      roster = listAgentsFlat().filter((a) => a.projectId === target.project.id && a.agentId !== "assistant");
      rosterCache.set(target.project.id, roster);
    }

    const affordable = roster;

    if (!roster.length) {
      decisions.push(`Skipped "${item.title}": ${target.project.name} (${target.project.id}) has no agents to run it.`);
      continue;
    }
    void requiredUsd; // cost estimate kept for the log; it no longer gates a pick

    let taskId = "";
    // ATTACH: every task this order hands to a worker carries the CEO's file paths plus
    // the description of what they show (workers cannot open images or PDFs).
    const taskRequest = attachmentHandoff ? `${item.request}\n${attachmentHandoff}` : item.request;
    try {
      const task = createTask(target.project.id, taskRequest);
      taskId = task.id;
    } catch (e) {
      decisions.push(`Could not create the task for "${item.title}" in ${target.project.name}: ${clamp(String(e), 120)}.`);
      continue;
    }

    taskIds.push(taskId);
    addTrace(target.project.id, taskId, { from: "CEO", to: "Assistant", what: "order", detail: instruction.slice(0, 400) });
    addTrace(target.project.id, taskId, { from: "Assistant", to: "Laya", what: "which track?", detail: item.title });
    addTrace(target.project.id, taskId, { from: "Laya", to: "Assistant", what: `track: ${track}`, detail: trackNote });
    addTrace(target.project.id, taskId, { from: "Assistant", to: "Laya", what: "which team?", detail: item.title });
    addTrace(target.project.id, taskId, { from: "Laya", to: "Assistant", what: `team: ${target.project.name}`, detail: layaNote });
    addTrace(target.project.id, taskId, { from: "Assistant", to: "Claude (manager)", what: "work order", detail: taskRequest.slice(0, 400) });

    if (opts.autoRun !== false) {
      inFlight++;
      const projectName = target.project.name;
      void runPipeline(target.project.id, taskRequest, { taskId, auto: true, onFinish: (t) => reportBack(t, projectName, item.title) })
        .catch((e) => console.error(`[assistant] pipeline ${target.project.id}/${taskId} failed: ${String(e)}`))
        .finally(() => {
          inFlight = Math.max(0, inFlight - 1);
        });
      dispatched.push({ projectId: target.project.id, taskId, title: item.title, status: "running" });
      decisions.push(
        `Dispatched "${item.title}" as task ${taskId} to ${target.project.name} (${target.project.id}), ${role} track, pipeline running now (~$${requiredUsd.toFixed(4)} of budget per agent).`
      );
    } else {
      dispatched.push({ projectId: target.project.id, taskId, title: item.title, status: "created" });
      decisions.push(`Created task ${taskId} for "${item.title}" in ${target.project.name}; autoRun was off so the pipeline was not started.`);
    }
  }

  if (replyNotes.length) reply = `${reply}\n\n${replyNotes.join("\n")}`;

  appendAssistantThread({
    ts: nowIso(),
    role: "assistant",
    text: clamp(reply, 4000),
    tasks: taskIds,
  });
  speakAssistantReply(clamp(reply, 4000));

  // Never block on the pipelines themselves, but give the just-started runs a short
  // bounded moment so the response carries their session records (progress then keeps
  // flowing to /company/sessions on its own).
  const taskIdSet = new Set(taskIds);
  const projectIds = new Set(dispatched.map((d) => d.projectId));
  let sessions: SessionRec[] = [];
  if (dispatched.length) {
    for (let i = 0; i < 8; i++) {
      sessions = dispatchedSessions(taskIdSet, projectIds);
      if (sessions.length) break;
      await sleepMs(100);
    }
    sessions = sessions.length ? sessions : dispatchedSessions(taskIdSet, projectIds);
  }

  // Mirror what the assistant routed (and any budget refusals) to Slack. Best
  // effort and non-blocking: the CEO sees it, the HTTP response never waits.
  void notifyAssistantDispatch({ reply, plan, dispatched, decisions });

  return {
    reply: clamp(reply, 4000),
    plan,
    dispatched,
    sessions,
    budgets: budgetSummary(),
    decisions,
    ...(fleetStarted.length ? { fleet: fleetStarted } : {}),
    ...(attachments.length ? { attachments } : {}),
  };
}

// ── ATTACH helpers ────────────────────────────────────────────────────
// The memory note for each attached file: path + the 2-3 sentence description of what
// it shows (from the model that read it), so it can be recalled later. `id` is derived
// from the upload id, so re-attaching the same file updates one note instead of piling
// up duplicates. Best effort: a memory failure never breaks an order.
function rememberAttachments(files: UploadRec[], whatFor: (f: UploadRec) => string, read: boolean): void {
  for (const f of files) {
    try {
      const what = whatFor(f).trim();
      const facts = [
        f.path,
        `${f.type}, ${(f.bytes / 1024).toFixed(0)} KB${f.pages ? `, about ${f.pages} page(s)` : ""}, attached ${f.uploadedAt}`,
      ].join("\n");
      const summary = what
        ? what
        : read
          ? "The assistant read this file but did not describe it."
          : "The CEO attached this file to an assistant order; the assistant model in use could not read it (attachments need a Claude assistant).";
      remember({
        id: `attachment-${f.id}`,
        type: "reference",
        title: `Attachment: ${f.name}`,
        body: `${facts}\n\n${summary}`,
        source: "assistant-attachment",
        tags: ["attachment", f.kind],
      });
      if (what) setUploadNote(f.id, what);
    } catch {
      /* memory is best effort: never fail an order over a note */
    }
  }
}

// Last hop of the chain: Claude's result comes back to the assistant, which
// reports it to the CEO in the assistant thread (dashboard + Slack mirror).
// The first line is unchanged from before; ASSISTANT-BRAIN appends the plain-words
// checklist tail (Remaining / Needs you) so the CEO always sees what is left.
/**
 * The "Remaining / Needs you" tail Joey appends to a pipeline report.
 * DUPLICATE-PROMPTS: it never says "Needs you: nothing" while a prompt is open, or
 * Joey would contradict the briefing the CEO is looking at. Exported so a test can
 * check that without running a model.
 */
export function reportTailLine(ok: boolean, taskId: string): string {
  const openNeedsYou = readOpenNeedsYouSync().length;
  if (!ok) {
    return `Remaining: the work is not done (the task stopped before it finished). Needs you: say whether to rerun task ${taskId} or drop it.`;
  }
  return openNeedsYou > 0
    ? `Remaining: nothing on this task - it is merged. Needs you: ${openNeedsYou} item(s) still waiting - open the Briefing page to answer them.`
    : "Remaining: nothing on this task - it is merged. Needs you: nothing.";
}

function reportBack(t: TaskRec, projectName: string, title: string) {
  const ok = t.status === "merged";
  const body = ok ? (t.result ?? t.review ?? "done").trim() : `failed: ${(t.error ?? "unknown error").slice(0, 400)}`;
  const tail = reportTailLine(ok, t.id);
  const text = `${ok ? "Done" : "Failed"}: "${title}" (${projectName}, task ${t.id}).\n${clamp(body, 1500)}\n${tail}`;
  appendAssistantThread({ ts: nowIso(), role: "assistant", text, tasks: [t.id] });
  speakAssistantReply(text);
  addTrace(t.projectId, t.id, { from: "Assistant", to: "CEO", what: ok ? "report" : "failure report", detail: clamp(body, 400) });
}

function requestOrInstruction(request: string, title: string, instruction: string): string {
  if (request) return request;
  return `${title}\n\n(CEO instruction: ${instruction})`;
}
