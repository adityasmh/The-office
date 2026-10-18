import fs from "node:fs";
import path from "node:path";
import { notifySlack } from "../slack.js";
import { assistantMessage } from "./assistant.js";
import { budgetNeedsYou, readBudgetState } from "./budgetGuard.js";
import {
  approveFleetOrder,
  cancelFleetOrder,
  loadFleetOrders,
  redoWorkOrder,
} from "./fleet.js";
import { addTrace, approveGate, loadTasks, updateTask } from "./gates.js";
import { getCompanyRoot, loadOrg } from "./org.js";
import { resumeTask } from "./pipeline.js";
import { findSession, sendTerminalMessage } from "./terminalChat.js";

// ── CEO INBOX (docs/INBOX_SPEC.md; owner: session INBOX) ───────────────
// Every "Needs you" item in the Briefing is actionable in place: an approval gets
// Approve / Reject (with an optional note), a question gets the exact question plus a
// reply box (or option buttons). The answer goes STRAIGHT back to whoever asked, so
// there is no back and forth through the manager.
//
// This file owns: the item store (company/inbox/), the derivation of items from state
// that other modules already keep (pipeline gates, fleet orders, budget pressure),
// the answer delivery for every source type, and the two-channel bookkeeping
// (dashboard + Slack: the first answer wins, the other channel shows "answered via X").
//
// Rules honoured here:
//  1. Item creation never blocks and never throws at a caller: askCeo() returns an item
//     (new or the existing one for the same source) or throws only on a malformed input.
//  2. Delivery is best effort and fully reported: every answer records what happened
//     (state + plain-words detail) whether it worked or not.
//  3. Nothing here restarts processes, kills terminals or answers anything by itself.

// ── types (docs/INBOX_SPEC.md, plus the extensions marked EXT) ─────────

export type InboxKind = "approval" | "question" | "choice";

export type InboxSourceType =
  | "task-gate"
  | "fleet-plan"
  | "fleet-redo"
  | "terminal"
  | "assistant"
  | "budget"
  | "run-card";

export type InboxGate = "intake" | "code" | "merge";

export type InboxSource = {
  type: InboxSourceType;
  id: string;
  projectId?: string;
  sessionId?: string;
  gate?: InboxGate;
  /** EXT (fleet-redo only): the work order inside the order named by `id`. */
  wid?: string;
};

export type InboxAnswer = {
  decision?: "approve" | "reject";
  text?: string;
  option?: string;
  via: "dashboard" | "slack";
  /** EXT (assistant only): run the plan after the reply (default: yes, as the route does). */
  autoRun?: boolean;
};

export type InboxDeliveryState = "pending" | "sent" | "failed" | "noted";

export type InboxDelivery = {
  state: InboxDeliveryState;
  /** who received the answer, in plain words ("the pipeline", "session otter", ...) */
  to?: string;
  how?: string;
  at?: string;
  /** what actually happened, plainly - shown next to "Sent to X" in the UI */
  detail: string;
};

export type InboxSlack = {
  ts?: string;
  postedAt?: string;
  ok: boolean;
  error?: string;
};

export type InboxItem = {
  id: string;
  kind: InboxKind;
  title: string;
  question: string;
  options?: string[];
  context?: string;
  source: InboxSource;
  status: "open" | "answered" | "expired";
  createdAt: string;
  answeredAt?: string;
  answer?: InboxAnswer;
  /** EXT: what happened when the answer was delivered (never omitted on an answered item). */
  delivery?: InboxDelivery;
  /** EXT: the Slack post for this item, so the thread can answer it too. */
  slack?: InboxSlack;
  /** EXT: why it expired (only set together with status "expired"). */
  expiredReason?: string;
  /** EXT: "push" (a source called askCeo) or "derive" (reconciled from live state). */
  createdBy?: "push" | "derive";
  /** EXT: a caller-supplied dedupe key, for sources that want their own identity. */
  dedupeKey?: string;
};

export type InboxItemInput = {
  kind: InboxKind;
  title: string;
  question: string;
  options?: string[];
  context?: string;
  source: InboxSource;
  /** EXT: override the automatic per-source dedupe with your own key. */
  dedupeKey?: string;
  /** EXT: "derive" is set by reconcileInbox(); sources should leave this alone. */
  createdBy?: "push" | "derive";
  /** EXT: skip the Slack post (default: post when Slack is configured). */
  silent?: boolean;
};

type InboxFile = { version: 1; updatedAt: string; items: InboxItem[] };

// ── env knobs ─────────────────────────────────────────────────────────

function envNum(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}
function envFlag(name: string, fallback: boolean): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
}

/** Post new items to Slack (once each) so the CEO can answer from either place. */
const slackEnabled = () => envFlag("INBOX_SLACK", true);
/** Derive items from live state (gates, fleet orders, budget pressure). */
const deriveEnabled = () => envFlag("INBOX_DERIVE", true);
/** Minimum gap between two derived reconciles. */
const syncMinMs = () => envNum("INBOX_SYNC_MIN_MS", 3000);
/** How long an answer waits for its delivery before the route returns "pending". */
const deliverWaitMs = () => envNum("INBOX_DELIVER_WAIT_MS", 6000);
/** Cap on stored items; the oldest answered/expired ones are dropped first. */
const maxItems = () => envNum("INBOX_MAX_ITEMS", 500);

// ── tiny helpers ──────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}
function clip(s: unknown, n: number): string {
  const t = typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
/** A question/title is one line of plain words; anything huge is a bug in the caller. */
function oneLine(s: unknown, n: number): string {
  return clip(s, n);
}

const inboxDir = () => path.join(getCompanyRoot(), "inbox");
const itemsPath = () => path.join(inboxDir(), "items.json");
const auditPath = () => path.join(inboxDir(), "items.jsonl");
const overridesPath = () => path.join(inboxDir(), "budget-overrides.json");
const lockPath = () => path.join(inboxDir(), ".derive.lock");

function readItems(): InboxItem[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(itemsPath(), "utf8")) as InboxFile | InboxItem[];
    const items = Array.isArray(parsed) ? parsed : (parsed.items ?? []);
    return items.filter((i) => i && typeof i.id === "string");
  } catch {
    return [];
  }
}

/** Atomic write (temp file + rename) so a reader never sees half a JSON document. */
function writeItems(items: InboxItem[]): void {
  const dir = inboxDir();
  fs.mkdirSync(dir, { recursive: true });
  const trimmed = trimItems(items);
  const payload: InboxFile = { version: 1, updatedAt: nowIso(), items: trimmed };
  const tmp = `${itemsPath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, itemsPath());
}

function audit(line: Record<string, unknown>): void {
  try {
    fs.mkdirSync(inboxDir(), { recursive: true });
    fs.appendFileSync(auditPath(), `${JSON.stringify({ ts: nowIso(), ...line })}\n`);
  } catch {
    // The audit log must never fail an answer.
  }
}

/** Keep the store bounded: newest first, drop old answered/expired items only. */
function trimItems(items: InboxItem[]): InboxItem[] {
  const cap = maxItems();
  if (items.length <= cap) return items;
  const newestFirst = [...items].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const keep: InboxItem[] = [];
  for (const it of newestFirst) {
    // An open item is never dropped: the CEO has not seen it yet.
    if (keep.length < cap || it.status === "open") keep.push(it);
  }
  return keep.sort((a, b) => (a.createdAt > b.createdAt ? 1 : -1));
}

function newId(): string {
  return `inb_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** One open item per source. Exported for tests/diagnostics. */
export function sourceIdentity(src: InboxSource): string {
  return [src.type, src.id ?? "", src.gate ?? "", src.wid ?? "", src.sessionId ?? ""].join("|");
}

// ── askCeo / list / reword / answer ───────────────────────────────────

/**
 * Put an item in the CEO's inbox. Dedupes on the source (one OPEN item per source,
 * or on `dedupeKey` when the caller supplies one) so a source that re-asks every tick
 * cannot flood the page, and so a derived item is never duplicated by a source hook.
 * Returns the new item, or the existing open one.
 */
export function askCeo(input: InboxItemInput): InboxItem {
  if (!input || typeof input !== "object") throw new Error("askCeo: item required");
  const source = input.source;
  if (!source || typeof source.type !== "string" || typeof source.id !== "string") {
    throw new Error("askCeo: source.type and source.id are required");
  }
  const kind: InboxKind = input.kind === "question" || input.kind === "choice" ? input.kind : "approval";
  const question = oneLine(input.question, 600);
  if (!question) throw new Error("askCeo: question required");
  const title = oneLine(input.title, 120) || question;
  const options = Array.isArray(input.options)
    ? input.options.map((o) => oneLine(o, 40)).filter(Boolean).slice(0, 6)
    : undefined;
  const dedupeKey = input.dedupeKey ? oneLine(input.dedupeKey, 200) : undefined;

  const items = readItems();
  const open = items.find(
    (i) =>
      i.status === "open" &&
      ((dedupeKey && i.dedupeKey === dedupeKey) || sourceIdentity(i.source) === sourceIdentity(source)),
  );
  if (open) return open;

  const item: InboxItem = {
    id: newId(),
    kind,
    title,
    question,
    ...(options && options.length ? { options } : {}),
    ...(input.context ? { context: oneLine(input.context, 1200) } : {}),
    source: {
      type: source.type,
      id: source.id,
      ...(source.projectId ? { projectId: source.projectId } : {}),
      ...(source.sessionId ? { sessionId: source.sessionId } : {}),
      ...(source.gate ? { gate: source.gate } : {}),
      ...(source.wid ? { wid: source.wid } : {}),
    },
    status: "open",
    createdAt: nowIso(),
    createdBy: input.createdBy === "derive" ? "derive" : "push",
    ...(dedupeKey ? { dedupeKey } : {}),
  };

  items.push(item);
  writeItems(items);
  audit({ event: "open", id: item.id, kind: item.kind, source: item.source, title: item.title, question: item.question, createdBy: item.createdBy });
  if (!input.silent && slackEnabled()) void postItemToSlack(item.id);
  return item;
}

/**
 * Replace the wording of an OPEN item (used by sources whose exact question is only
 * known later - REPORTING extracts a worker's question from its journal). Never
 * touches the answer, the source or the Slack thread.
 */
export function rewordInbox(
  id: string,
  patch: { title?: string; question?: string; context?: string; options?: string[] },
): InboxItem | undefined {
  const items = readItems();
  const item = items.find((i) => i.id === id);
  if (!item) return undefined;
  if (item.status === "open") {
    if (patch.title) item.title = oneLine(patch.title, 120);
    if (patch.question) item.question = oneLine(patch.question, 600);
    if (patch.context !== undefined) item.context = oneLine(patch.context, 1200) || undefined;
    if (Array.isArray(patch.options) && patch.options.length) {
      item.options = patch.options.map((o) => oneLine(o, 40)).filter(Boolean).slice(0, 6);
    }
    writeItems(items);
    audit({ event: "reword", id, title: item.title, question: item.question });
  }
  return item;
}

export function getInboxItem(id: string): InboxItem | undefined {
  return readItems().find((i) => i.id === id);
}

export type InboxCounts = { open: number; answered: number; expired: number; total: number };

export function inboxCounts(items = readItems()): InboxCounts {
  return {
    open: items.filter((i) => i.status === "open").length,
    answered: items.filter((i) => i.status === "answered").length,
    expired: items.filter((i) => i.status === "expired").length,
    total: items.length,
  };
}

/** Newest first. `status` may be "open" | "answered" | "expired" | "all". */
export function listInbox(opts: { status?: string; limit?: number } = {}): {
  items: InboxItem[];
  counts: InboxCounts;
} {
  const want = (opts.status ?? "open").toLowerCase();
  const all = readItems().sort((a, b) => (a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : 0));
  const items = want === "all" ? all : all.filter((i) => i.status === want);
  const limit = Number.isFinite(opts.limit) && Number(opts.limit) > 0 ? Math.min(Number(opts.limit), 200) : undefined;
  return { items: limit ? items.slice(0, limit) : items, counts: inboxCounts(all) };
}

/**
 * Answer an item. The first answer wins: a second answer (the other channel, a
 * double-click) is refused with the item as it stands, so the UI can show
 * "answered via X".
 *
 * The answer is recorded synchronously, then delivered; delivery may still be
 * "pending" when this returns (the terminal transport allows up to ~40s) and is
 * written to the item when it lands.
 */
export async function answerInbox(
  id: string,
  answer: Partial<InboxAnswer> & { via?: "dashboard" | "slack" },
  opts: { waitMs?: number } = {},
): Promise<{ ok: boolean; error?: string; status: number; item?: InboxItem; delivery?: InboxDelivery }> {
  const items = readItems();
  const item = items.find((i) => i.id === id);
  if (!item) return { ok: false, error: `no such inbox item: ${id}`, status: 404 };

  if (item.status !== "open") {
    return {
      ok: false,
      status: 409,
      item,
      error:
        item.status === "answered"
          ? `already answered via ${item.answer?.via ?? "unknown"} at ${item.answeredAt ?? "?"}`
          : `this item expired (${item.expiredReason ?? "the thing behind it resolved"})`,
    };
  }

  const via: "dashboard" | "slack" = answer.via === "slack" ? "slack" : "dashboard";
  const text = clip(answer.text, 1200);
  const option = answer.option ? oneLine(answer.option, 40) : undefined;
  const decision = answer.decision === "approve" || answer.decision === "reject" ? answer.decision : undefined;

  // What does this answer mean for this item? Refuse early with a clear reason
  // rather than delivering a half-answer.
  const resolved: InboxAnswer = { via };
  if (item.kind === "question") {
    if (!text && !option) {
      return { ok: false, status: 400, error: "a reply is required for a question", item };
    }
    if (option) resolved.option = option;
    if (text) resolved.text = text;
  } else if (item.kind === "choice") {
    if (!option && !decision) {
      return { ok: false, status: 400, error: `choose one of: ${(item.options ?? []).join(" | ") || "option required"}`, item };
    }
    if (option) {
      if (item.options?.length && !item.options.includes(option)) {
        return { ok: false, status: 400, error: `"${option}" is not one of the options`, item };
      }
      resolved.option = option;
    }
    if (decision) resolved.decision = decision;
    if (text) resolved.text = text;
  } else {
    if (!decision && option) {
      // An approval answered from Slack or from option buttons: map the words.
      resolved.decision = /^(approve|approve it|yes|do it|ok|okay|go ahead|redo it|allow|allow it|allow once)$/i.test(option.trim())
        ? "approve"
        : "reject";
    } else if (decision) {
      resolved.decision = decision;
    } else if (!text && !option) {
      return { ok: false, status: 400, error: "decision required (approve | reject)", item };
    } else {
      // A plain yes/no (Slack reply, or the reply box on an approval item).
      const yes = /^\s*(y|ye(s|ah|p)?|ok(ay)?|approve[d]?|do it|go ahead|sure|allow( it)?|accept(ed)?)\b/i.test(text);
      const no = /^\s*(n|no|nope|reject(ed)?|deny|don'?t|stop|cancel|hold)\b/i.test(text);
      if (!yes && !no) {
        return {
          ok: false,
          status: 400,
          error: 'please start with "approve" or "reject" (or use the buttons)',
          item,
        };
      }
      resolved.decision = yes ? "approve" : "reject";
      if (text) resolved.text = text;
    }
    if (text && !resolved.text) resolved.text = text;
  }
  if (typeof answer.autoRun === "boolean") resolved.autoRun = answer.autoRun;

  item.status = "answered";
  item.answeredAt = nowIso();
  item.answer = resolved;
  item.delivery = { state: "pending", detail: "delivering your answer…", at: nowIso() };
  writeItems(items);
  audit({ event: "answered", id: item.id, via, answer: resolved, source: item.source });

  // Delivery runs in the background; the caller waits a bounded time for the fast
  // paths (gate/fleet/budget) and gets "pending" for the slow ones.
  const delivery = await deliverWithWait(item.id, opts.waitMs ?? deliverWaitMs());
  const fresh = getInboxItem(item.id) ?? item;
  return { ok: true, status: 200, item: fresh, delivery: fresh.delivery ?? delivery };
}

/** Deliver, but do not hold the HTTP response longer than `waitMs`. */
async function deliverWithWait(id: string, waitMs: number): Promise<InboxDelivery> {
  const pending = deliverAnswer(id);
  const timer = new Promise<null>((resolve) => {
    const t = setTimeout(() => resolve(null), waitMs);
    t.unref?.();
  });
  const winner = await Promise.race([pending, timer]);
  if (winner) return winner;
  // Still delivering: let it finish in the background.
  void pending.catch(() => undefined);
  return { state: "pending", detail: "delivery is still running (this can take up to ~40s for a busy terminal)", at: nowIso() };
}

/** Where an answer goes, per source type. Always writes the result onto the item. */
export async function deliverAnswer(id: string): Promise<InboxDelivery> {
  const item = getInboxItem(id);
  if (!item || !item.answer) {
    return { state: "failed", detail: "nothing to deliver", at: nowIso() };
  }
  let out: InboxDelivery;
  try {
    out = await deliver(item);
  } catch (e) {
    out = { state: "failed", detail: `delivery failed: ${clip(String(e), 300)}`, at: nowIso() };
  }
  out.at = out.at ?? nowIso();
  const items = readItems();
  const cur = items.find((i) => i.id === id);
  if (cur) {
    cur.delivery = out;
    writeItems(items);
  }
  audit({ event: "delivered", id, state: out.state, to: out.to, how: out.how, detail: out.detail });
  if (item.answer.via === "dashboard") void noteAnsweredInSlack(id);
  return out;
}

async function deliver(item: InboxItem): Promise<InboxDelivery> {
  switch (item.source.type) {
    case "task-gate":
      return deliverTaskGate(item);
    case "fleet-plan":
      return deliverFleetPlan(item);
    case "fleet-redo":
      return deliverFleetRedo(item);
    case "terminal":
      return deliverTerminal(item);
    case "assistant":
      return deliverAssistant(item);
    case "budget":
      return deliverBudget(item);
    case "run-card":
      // A run card is REPORTING's view of a run; when it names a session, the answer
      // belongs in that terminal. Otherwise there is nothing to send it to.
      return item.source.sessionId
        ? deliverTerminal(item)
        : {
            state: "noted",
            to: item.source.id,
            how: "note",
            detail: "recorded (this run has no session to answer into)",
            at: nowIso(),
          };
    default:
      return { state: "noted", detail: "recorded (unknown source type)", at: nowIso() };
  }
}

// ── delivery: task gate (owner crocodile/RESUME: gates.ts + pipeline.ts) ──

async function deliverTaskGate(item: InboxItem): Promise<InboxDelivery> {
  const { projectId, gate } = item.source;
  const taskId = item.source.id;
  const note = item.answer?.text;
  if (!projectId || !gate) {
    return { state: "failed", detail: "this item has no project/gate to act on", at: nowIso() };
  }
  if (item.answer?.decision === "reject") {
    // A reject stops the task where it stands, with the CEO's note on the record.
    const patch = {
      status: "rejected" as const,
      ...(note ? { error: `rejected by the CEO at gate ${gate}: ${note}` } : { error: `rejected by the CEO at gate ${gate}` }),
    };
    updateTask(projectId, taskId, patch);
    addTrace(projectId, taskId, { from: "CEO", to: "pipeline", what: "reject", detail: note || `rejected at gate ${gate} from the Briefing` });
    return {
      state: "sent",
      to: `task ${taskId}`,
      how: "reject",
      detail: `Task marked rejected at gate ${gate}${note ? ` with your note` : ""}.`,
      at: nowIso(),
    };
  }
  const t = approveGate(projectId, taskId, gate);
  const resumed = resumeTask(projectId, taskId, "manual");
  addTrace(projectId, taskId, { from: "CEO", to: "pipeline", what: `approve ${gate}`, detail: note || `approved gate ${gate} from the Briefing` });
  return {
    state: "sent",
    to: `task ${taskId}`,
    how: "approveGate + resumeTask",
    detail: `Gate ${gate} approved (status ${t.status}); pipeline ${resumed ? "resumed" : "not running, so nothing to resume"}.`,
    at: nowIso(),
  };
}

// ── delivery: fleet (owner bonehound: fleet.ts) ───────────────────────

async function deliverFleetPlan(item: InboxItem): Promise<InboxDelivery> {
  const orderId = item.source.id;
  if (item.answer?.decision === "reject") {
    const order = cancelFleetOrder(orderId);
    return {
      state: "sent",
      to: `fleet order ${orderId}`,
      how: "cancelFleetOrder",
      detail: `Order cancelled (${order.status}); queued work will not start and running terminals are left alone.`,
      at: nowIso(),
    };
  }
  const order = await approveFleetOrder(orderId, {});
  return {
    state: "sent",
    to: `fleet order ${orderId}`,
    how: "approveFleetOrder",
    detail: `Plan approved (${order.workOrders.length} work order(s), status ${order.status}); the workers are being opened.`,
    at: nowIso(),
  };
}

async function deliverFleetRedo(item: InboxItem): Promise<InboxDelivery> {
  const orderId = item.source.id;
  const wid = item.source.wid;
  if (!wid) return { state: "failed", detail: "this redo item has no work order id", at: nowIso() };
  const opt = (item.answer?.option ?? item.answer?.text ?? "").trim();
  const wantsRedo =
    item.answer?.decision === "approve" || /^(redo|redo it|retry|yes|do it)$/i.test(opt);
  const wantsLeave =
    item.answer?.decision === "reject" || /^(leave|leave it|leave it for now|no|drop|stop|cancel)$/i.test(opt);
  if (!wantsRedo && !wantsLeave) {
    return {
      state: "failed",
      detail: `could not tell whether to redo "${wid}" from "${clip(opt, 60)}"`,
      at: nowIso(),
    };
  }
  if (wantsRedo) {
    const order = await redoWorkOrder(orderId, wid);
    const wo = order.workOrders.find((w) => w.id === wid);
    return {
      state: "sent",
      to: `fleet order ${orderId} / ${wid}`,
      how: "redoWorkOrder",
      detail: `${wid} is queued for a fresh attempt (attempt ${(wo?.attempts ?? 0) + 1}) with Claude's review notes.`,
      at: nowIso(),
    };
  }
  const order = cancelFleetOrder(orderId);
  return {
    state: "sent",
    to: `fleet order ${orderId}`,
    how: "cancelFleetOrder",
    detail: `Left alone: the order is cancelled (${order.status}). Nothing new will start; running terminals are left alone.`,
    at: nowIso(),
  };
}

// ── delivery: a jcode terminal that asked something ───────────────────
// Transport is terminalChat's sendTerminalMessage: targeted
// `jcode transcript --mode send -S <sessionId>` (no focus fallback), and the text is
// confirmed as a NEW user message in that session's own journal. The transport adds
// its "[From the CEO via the dashboard] " prefix, so the session sees
// "[From the CEO via the dashboard] <question> → <answer>".

async function deliverTerminal(item: InboxItem): Promise<InboxDelivery> {
  const sessionId = item.source.sessionId ?? item.source.id;
  const answerText =
    item.answer?.text ??
    item.answer?.option ??
    (item.answer?.decision === "reject" ? "No - the CEO says no." : item.answer?.decision === "approve" ? "Yes - approved." : "");
  if (!answerText) return { state: "failed", detail: "no answer text to send", at: nowIso() };
  const payload = `${oneLine(item.question, 240)} → ${clip(answerText, 700)}`;
  const res = await sendTerminalMessage(sessionId, payload);
  if (!res.ok) {
    return { state: "failed", to: sessionId, how: "sendTerminalMessage", detail: clip(res.detail, 400), at: nowIso() };
  }
  return {
    state: "sent",
    to: `session ${res.name ?? sessionId}`,
    how: "sendTerminalMessage",
    detail: clip(res.detail, 400),
    at: nowIso(),
  };
}

// ── delivery: the assistant (shared file: coordinate in the log) ──────

async function deliverAssistant(item: InboxItem): Promise<InboxDelivery> {
  const answerText =
    item.answer?.text ??
    (item.answer?.decision === "reject"
      ? "No."
      : item.answer?.decision === "approve"
        ? "Yes - go ahead."
        : item.answer?.option ?? "");
  if (!answerText) return { state: "failed", detail: "no reply text to send", at: nowIso() };
  const text = `[Your question: "${oneLine(item.question, 300)}"] The CEO answers: ${clip(answerText, 900)}`;
  const autoRun = item.answer?.autoRun;
  const opts: { autoRun?: boolean } = typeof autoRun === "boolean" ? { autoRun } : {};
  const out = await assistantMessage(text, opts);
  return {
    state: "sent",
    to: "the assistant",
    how: "assistantMessage",
    detail: clip(
      `the assistant continued: ${out.dispatched.length} task(s) dispatched${out.reply ? `; it says: ${oneLine(out.reply, 160)}` : ""}`,
      400,
    ),
    at: nowIso(),
  };
}

// ── delivery: budget (owner otter/BUDGET: budgetGuard.ts) ─────────────
// The override is a one-time grant held in company/inbox/budget-overrides.json. BUDGET's
// guard honours it by calling budgetOverrideActive() (see the integration request in
// company/inbox/INTEGRATION.md); consumeBudgetOverride() spends it, at most once.

export type BudgetOverride = {
  id: string;
  itemId: string;
  question: string;
  answer: string;
  grantedAt: string;
  expiresAt: string;
  usedAt?: string;
  usedBy?: string;
};

function readOverrides(): BudgetOverride[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(overridesPath(), "utf8")) as { overrides?: BudgetOverride[] } | BudgetOverride[];
    return Array.isArray(parsed) ? parsed : (parsed.overrides ?? []);
  } catch {
    return [];
  }
}

function writeOverrides(list: BudgetOverride[]): void {
  fs.mkdirSync(inboxDir(), { recursive: true });
  const tmp = `${overridesPath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: nowIso(), overrides: list }, null, 2));
  fs.renameSync(tmp, overridesPath());
}

export function listBudgetOverrides(): BudgetOverride[] {
  return readOverrides();
}

/** The one-time grant a guard should honour right now (unused + unexpired), if any. */
export function budgetOverrideActive(now = Date.now()): BudgetOverride | undefined {
  return readOverrides().find((o) => !o.usedAt && Date.parse(o.expiresAt) > now);
}

/** Spend the grant (at most once). Returns the grant that was consumed. */
export function consumeBudgetOverride(by = "budgetGuard", now = Date.now()): BudgetOverride | undefined {
  const list = readOverrides();
  const hit = list.find((o) => !o.usedAt && Date.parse(o.expiresAt) > now);
  if (!hit) return undefined;
  hit.usedAt = nowIso();
  hit.usedBy = oneLine(by, 80) || "budgetGuard";
  writeOverrides(list);
  audit({ event: "budget-override-used", id: hit.id, by: hit.usedBy });
  return hit;
}

async function deliverBudget(item: InboxItem): Promise<InboxDelivery> {
  const text =
    item.answer?.text ??
    item.answer?.option ??
    (item.answer?.decision === "reject" ? "No - keep the restriction." : "Yes - allow it once.");
  const approved = item.answer?.decision !== "reject" && !/^(no|deny|keep|don'?t)\b/i.test(text.trim());
  if (!approved) {
    return {
      state: "noted",
      to: "the budget guard",
      how: "note",
      detail: "Recorded: the budget restriction stays as it is.",
      at: nowIso(),
    };
  }
  const minutes = envNum("INBOX_BUDGET_OVERRIDE_MINUTES", 60);
  const grant: BudgetOverride = {
    id: `bo_${Date.now().toString(36)}`,
    itemId: item.id,
    question: oneLine(item.question, 300),
    answer: clip(text, 300),
    grantedAt: nowIso(),
    expiresAt: new Date(Date.now() + minutes * 60_000).toISOString(),
  };
  writeOverrides([...readOverrides(), grant]);
  audit({ event: "budget-override-granted", id: grant.id, itemId: item.id, expiresAt: grant.expiresAt });
  return {
    state: "sent",
    to: "the budget guard",
    how: "budget-overrides.json",
    detail: `One-time budget override granted until ${grant.expiresAt} (BUDGET's guard honours it by calling budgetOverrideActive(), one use).`,
    at: nowIso(),
  };
}

// ── Slack: one post per item, and the thread answers it too ───────────
// rose owns inbound (src/company/slackInbound.ts). The hook it needs is
// answerInboxFromSlack() below; until it is wired, the post still carries the exact
// route to answer from (POST /company/inbox/:id/answer).

async function postItemToSlack(id: string): Promise<void> {
  const item = getInboxItem(id);
  if (!item || item.slack?.postedAt) return;
  const how =
    item.kind === "approval" && item.source.type === "fleet-redo"
      ? "Reply here with `redo` or `leave it`"
      : item.kind === "approval"
        ? "Reply here with `approve` or `reject` (add a note after it)"
        : item.kind === "choice"
          ? `Reply here with one of: ${(item.options ?? []).join(" / ")}`
          : "Reply here with your answer";
  const body = [`*${item.title}*`, item.question, "", `${how} - or open the Briefing on the dashboard. (${item.id})`].join("\n");
  let slack: InboxSlack;
  try {
    const res = await notifySlack(body);
    slack = res.posted
      ? { ts: res.ts, postedAt: nowIso(), ok: true }
      : { ts: res.ts, postedAt: nowIso(), ok: false, error: clip(res.error ?? "Slack did not accept the post", 200) };
  } catch (e) {
    slack = { postedAt: nowIso(), ok: false, error: clip(String(e), 200) };
  }
  const items = readItems();
  const cur = items.find((i) => i.id === id);
  if (cur && !cur.slack?.postedAt) {
    cur.slack = slack;
    writeItems(items);
  }
  audit({ event: "slack-post", id, ok: slack.ok, ts: slack.ts, error: slack.error });
}

/** Tell the Slack thread what happened, so the other channel shows "answered via X". */
async function noteAnsweredInSlack(id: string): Promise<void> {
  const item = getInboxItem(id);
  if (!item?.slack?.ts || !item.slack.ok || item.answer?.via !== "dashboard") return;
  try {
    await notifySlack(
      `Answered via the dashboard: ${item.answer?.text ?? item.answer?.option ?? item.answer?.decision ?? ""}`.trim(),
      { threadTs: item.slack.ts },
    );
  } catch {
    // Best effort only.
  }
}

/** The Slack thread this item was posted in (for inbound matching). */
export function slackThreadForItem(id: string): string | undefined {
  return getInboxItem(id)?.slack?.ts;
}

/**
 * A Slack reply in an item's thread answers the item (rose hooks this into
 * slackInbound.ts). Matches on the thread ts, or on the "(inb_...)" reference.
 * The first answer wins, so a dashboard answer arriving first is reported back.
 */
export async function answerInboxFromSlack(opts: {
  threadTs?: string;
  text: string;
  user?: string;
  itemId?: string;
}): Promise<{ ok: boolean; error?: string; item?: InboxItem; delivery?: InboxDelivery }> {
  const text = typeof opts.text === "string" ? opts.text.trim() : "";
  if (!text) return { ok: false, error: "empty Slack reply" };
  let item: InboxItem | undefined;
  if (opts.itemId) item = getInboxItem(opts.itemId);
  if (!item && opts.threadTs) {
    item = readItems().find((i) => i.slack?.ts && i.slack.ts === opts.threadTs);
  }
  if (!item) {
    const m = /\((inb_[a-z0-9]+)\)/i.exec(text);
    if (m) item = getInboxItem(m[1]);
  }
  if (!item) return { ok: false, error: "no inbox item matches this Slack thread" };
  const res = await answerInbox(item.id, { text, via: "slack" });
  return { ok: res.ok, error: res.error, item: res.item, delivery: res.delivery };
}

// ── derived items: reconcile the inbox with the live state ────────────
// Some sources have their own hook (a worker that asks a question, the assistant). The
// others are DERIVED here from state that already exists on disk, so the feature works
// even if a source hook is missing, and so nothing can go stale: a derived item is
// expired the moment the thing behind it resolves (the gate was approved elsewhere,
// the order was cancelled, the terminal closed). Source hooks are still wanted for
// their better wording and for the sources that only they can see.

export type InboxSyncReport = {
  at: string;
  created: number;
  expired: number;
  open: number;
  skipped?: string;
  sources: { taskGates: number; fleetPlans: number; fleetRedos: number; budget: number };
};

let lastSyncMs = 0;
let cachedReport: InboxSyncReport | undefined;

export function reconcileInbox(opts: { force?: boolean } = {}): InboxSyncReport {
  const stamp = () => {
    lastSyncMs = Date.now();
  };
  const now = Date.now();
  if (!opts.force && cachedReport && now - lastSyncMs < syncMinMs()) return cachedReport;
  if (!opts.force) {
    // Best-effort cross-process gate: another router instance with the same COMPANY_ROOT
    // may be deriving right now, and the second one would only duplicate work.
    if (!takeDeriveLock()) {
      stamp();
      return cachedReport ?? { at: nowIso(), created: 0, expired: 0, open: inboxCounts().open, sources: { taskGates: 0, fleetPlans: 0, fleetRedos: 0, budget: 0 } };
    }
    try {
      cachedReport = derive(opts);
    } finally {
      releaseDeriveLock();
      stamp();
    }
    return cachedReport;
  }
  try {
    cachedReport = derive(opts);
    return cachedReport;
  } finally {
    stamp();
  }
}

/** Best-effort cross-process lock: only one process derives at a time. */
function takeDeriveLock(): boolean {
  try {
    fs.mkdirSync(inboxDir(), { recursive: true });
    const raw = fs.readFileSync(lockPath(), "utf8");
    const holder = JSON.parse(raw) as { pid?: number; at?: number };
    const alive = (() => {
      try {
        if (typeof holder.pid === "number") process.kill(holder.pid, 0);
        return true;
      } catch {
        return false;
      }
    })();
    if (alive && typeof holder.at === "number" && Date.now() - holder.at < 30_000) return false;
  } catch {
    // No lock file (or unreadable): take it.
  }
  try {
    fs.writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, at: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

function releaseDeriveLock(): void {
  try {
    fs.unlinkSync(lockPath());
  } catch {
    // Already gone.
  }
}

function derive(_opts: { force?: boolean }): InboxSyncReport {
  void _opts;
  const items = readItems();
  const byId = new Map(items.map((i) => [i.id, i]));
  let created = 0;
  let expired = 0;
  const sources = { taskGates: 0, fleetPlans: 0, fleetRedos: 0, budget: 0 };

  const openOf = (pred: (i: InboxItem) => boolean) => items.filter((i) => i.status === "open" && pred(i));
  const expire = (item: InboxItem, why: string) => {
    if (item.status !== "open") return;
    item.status = "expired";
    item.expiredReason = why;
    expired += 1;
    audit({ event: "expired", id: item.id, why, source: item.source });
  };
  const add = (input: InboxItemInput) => {
    const item = askCeo({ ...input, createdBy: "derive" });
    if (!byId.has(item.id)) {
      byId.set(item.id, item);
      items.push(item);
      created += 1;
    }
    return item;
  };

  if (!deriveEnabled()) {
    return { at: nowIso(), created: 0, expired: 0, open: openOf(() => true).length, skipped: "INBOX_DERIVE=0", sources };
  }

  // 1. Pipeline gates waiting on a human (owner crocodile/RESUME).
  //    A gate whose flag is already true is NOT waiting (the CEO approved it elsewhere and
  //    the pipeline resumes on its own), even while the status still reads pending_*.
  const gated = new Map<string, { projectId: string; taskId: string; gate: InboxGate; request: string; plan?: string; brief?: string; result?: string; review?: string }>();
  const unwaiting = new Set<string>();
  try {
    for (const project of loadOrg().projects) {
      for (const t of loadTasks(project.id)) {
        const gate: InboxGate | undefined =
          t.status === "pending_intake" ? "intake" : t.status === "pending_code" ? "code" : t.status === "pending_merge" ? "merge" : undefined;
        if (!gate) continue;
        if (t.gates?.[gate]) {
          unwaiting.add(`${project.id}|${t.id}|${gate}`);
          continue;
        }
        gated.set(`${project.id}|${t.id}|${gate}`, {
          projectId: project.id,
          taskId: t.id,
          gate,
          request: oneLine(t.rawRequest, 160),
          plan: t.plan ? oneLine(t.plan, 700) : undefined,
          brief: t.enhancedBrief ? oneLine(t.enhancedBrief, 700) : undefined,
          result: t.result ? oneLine(t.result, 700) : undefined,
          review: t.review ? oneLine(t.review, 700) : undefined,
        });
      }
    }
  } catch {
    // A missing/unreadable org.json must not break the inbox.
  }
  for (const g of gated.values()) {
    sources.taskGates += 1;
    const gateLabel = g.gate === "intake" ? "start" : g.gate === "code" ? "coding" : "merge";
    add({
      kind: "approval",
      title: `Approve the ${gateLabel} stage${g.request ? `: ${oneLine(g.request, 60)}` : ""}`,
      question:
        g.gate === "intake"
          ? `Start work on this task? "${g.request}"`
          : g.gate === "code"
            ? `Approve the plan and let the coding start? "${g.request}"`
            : `Approve merging the finished work? "${g.request}"`,
      context: [
        `Project ${g.projectId}, task ${g.taskId} (gate ${g.gate}).`,
        g.brief ? `Brief: ${g.brief}` : "",
        g.plan ? `Plan: ${g.plan}` : "",
        g.result ? `Result: ${g.result}` : "",
        g.review ? `Review: ${g.review}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      source: { type: "task-gate", id: g.taskId, projectId: g.projectId, gate: g.gate },
      silent: false,
    });
  }
  for (const item of openOf((i) => i.source.type === "task-gate")) {
    // Keyed by gate: a task that moved on to its NEXT gate produces a new item, and the
    // item for the gate it already left expires here.
    const key = `${item.source.projectId}|${item.source.id}|${item.source.gate ?? ""}`;
    if (!gated.has(key)) {
      expire(item, unwaiting.has(key) ? "this gate was approved somewhere else" : "the task left this gate");
    }
  }

  // 2. Fleet: a plan awaiting approval, and REDO verdicts the CEO must act on.
  const awaiting = new Map<string, { count: number; plan?: string }>();
  const redos = new Map<string, { wid: string; title: string; review?: string }>();
  try {
    for (const order of loadFleetOrders()) {
      if (order.status === "awaiting_approval") {
        awaiting.set(order.id, { count: order.workOrders.length, plan: order.plan ? oneLine(order.plan, 900) : undefined });
      }
      if (order.status === "reviewing") {
        for (const wo of order.workOrders) {
          if (wo.verdict === "REDO") {
            redos.set(`${order.id}|${wo.id}`, { wid: wo.id, title: oneLine(`${wo.id} ${wo.title}`, 80), review: wo.review ? oneLine(wo.review, 900) : undefined });
          }
        }
      }
    }
  } catch {
    // orders.json unreadable: skip the fleet part.
  }
  for (const [orderId, info] of awaiting) {
    sources.fleetPlans += 1;
    add({
      kind: "approval",
      title: `Approve Claude's plan${info.count ? ` (${info.count} workers)` : ""}`,
      question: `Approve the plan so the workers can start? (order ${orderId})`,
      context: info.plan ? oneLine(info.plan, 1200) : undefined,
      source: { type: "fleet-plan", id: orderId },
    });
  }
  for (const item of openOf((i) => i.source.type === "fleet-plan")) {
    if (!awaiting.has(item.source.id)) expire(item, "the order is no longer waiting for approval");
  }
  for (const [key, info] of redos) {
    sources.fleetRedos += 1;
    const [orderId] = key.split("|");
    add({
      kind: "choice",
      title: `Redo ${info.title}?`.slice(0, 120),
      question: `Claude asked for a REDO here. Redo it, or leave it for now?`,
      options: ["Redo it", "Leave it"],
      context: [`Order ${orderId}, work order ${info.wid}.`, info.review ? `Claude's notes: ${info.review}` : ""].filter(Boolean).join("\n"),
      source: { type: "fleet-redo", id: orderId, wid: info.wid },
    });
  }
  for (const item of openOf((i) => i.source.type === "fleet-redo")) {
    if (!redos.has(`${item.source.id}|${item.source.wid ?? ""}`)) expire(item, "that work order is no longer asking for a redo");
  }

  // 3. Budget: BUDGET's own red-level "needs you" line (owner otter).
  try {
    const needs = budgetNeedsYou(readBudgetState());
    if (needs?.text) {
      sources.budget += 1;
      const state = readBudgetState();
      add({
        kind: "approval",
        title: needs.provider === "claude" ? "Claude budget is nearly out" : "OpenCode Go budget is nearly out",
        question: `${oneLine(needs.text, 300)} Allow it once anyway?`,
        context: state ? `Levels: go=${state.levels.go}, claude=${state.levels.claude}. Checked ${state.checkedAt}.` : undefined,
        source: { type: "budget", id: needs.provider },
      });
    } else {
      for (const item of openOf((i) => i.source.type === "budget")) expire(item, "budget pressure is back to normal");
    }
  } catch {
    // No budget state yet: nothing to say.
  }

  // 4. Terminal questions: expire the ones whose session has closed (nobody left to
  // answer), and never expire the rest - a busy terminal's question still stands.
  for (const item of openOf((i) => i.source.type === "terminal" || (i.source.type === "run-card" && Boolean(i.source.sessionId)))) {
    const sid = item.source.sessionId ?? item.source.id;
    const session = findSession(sid);
    if (!session || session.state === "closed") expire(item, "the terminal closed before you answered");
  }

  if (created || expired) writeItems(items);
  audit({ event: "sync", created, expired, sources });
  return { at: nowIso(), created, expired, open: openOf(() => true).length, sources };
}

// ── status (for the log line / the ops probe / the UI badge) ──────────

export function inboxStatus(): {
  counts: InboxCounts;
  open: Array<{ id: string; kind: InboxKind; title: string; source: InboxSourceType; createdAt: string }>;
  lastSync?: InboxSyncReport;
  slack: { enabled: boolean; posted: number; failed: number; threads: number };
  budgetOverride?: { expiresAt: string; itemId: string };
  knobs: { derive: boolean; syncMinMs: number; deliverWaitMs: number; maxItems: number };
} {
  const items = readItems();
  const posted = items.filter((i) => i.slack?.postedAt && i.slack.ok).length;
  const failed = items.filter((i) => i.slack?.postedAt && !i.slack.ok).length;
  const grant = budgetOverrideActive();
  return {
    counts: inboxCounts(items),
    open: items
      .filter((i) => i.status === "open")
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((i) => ({ id: i.id, kind: i.kind, title: i.title, source: i.source.type, createdAt: i.createdAt })),
    lastSync: cachedReport,
    slack: { enabled: slackEnabled(), posted, failed, threads: items.filter((i) => i.slack?.ts).length },
    ...(grant ? { budgetOverride: { expiresAt: grant.expiresAt, itemId: grant.itemId } } : {}),
    knobs: { derive: deriveEnabled(), syncMinMs: syncMinMs(), deliverWaitMs: deliverWaitMs(), maxItems: maxItems() },
  };
}

/** Test hook: forget the derive throttle (never used by the routes). */
export function __resetInboxSyncThrottle(): void {
  lastSyncMs = 0;
  cachedReport = undefined;
}

/** Test hook: the paths this module owns, so a probe can assert them. */
export const __inboxPaths = { itemsPath, auditPath, overridesPath, inboxDir };
