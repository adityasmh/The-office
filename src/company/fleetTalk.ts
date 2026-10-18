/**
 * fleetTalk (order R4-agent-mailbox, 2026-10-06): a bounded mailbox so workers on the SAME
 * fleet order can leave each other short notes while they run.
 *
 * Spec: docs/AGENT_TALK_SPEC.md. Step A (docs/AGENT_TALK_STEP_A.md) proved that live delivery
 * into a running jcode session only works while the session is IDLE, so the guaranteed path is
 * a board file that each worker reads at two fixed points (a one-shot read, never a loop):
 *
 *   company/fleet/<orderId>/BOARD.jsonl   append-only, one JSON object per line
 *   {id, ts, from, to, kind, text}        kind is one of note | question | answer | handoff
 *
 * `to` is a work order id or "*" (everyone on the order). There is NO server involved: the two
 * ops tools (ops/agent-msg.ts) talk to the file directly. `FLEET_TALK=1` turns the whole thing
 * on; unset means OFF and every entry point refuses (existing behaviour is unchanged).
 *
 * HARD LIMITS, enforced here in code (never left to a prompt):
 *   - at most 6 messages sent per work order per order;
 *   - at most 2 question-and-answer rounds between any pair;
 *   - at most 400 characters per message;
 *   - no empty text, no message to itself, no exact duplicate of the sender's previous text;
 *   - a sender (and a named recipient) must be a work order of that order;
 *   - token-shaped strings are replaced with "[redacted]" before the line is written.
 *
 * Two small state files live beside the board: BOARD.seen.json (what each worker has already
 * printed from its inbox) and BOARD.trace.json (the last board id the fleet watcher put in the
 * order trace), so an inbox read and a trace hop each happen ONCE.
 */
import fs from "node:fs";
import path from "node:path";
import { getCompanyRoot } from "./org.js";

export type TalkKind = "note" | "question" | "answer" | "handoff";
export const TALK_KINDS: readonly TalkKind[] = ["note", "question", "answer", "handoff"];

export type TalkMessage = {
  id: string;
  ts: string;
  from: string;
  to: string;
  kind: TalkKind;
  text: string;
};

export type PostResult = { ok: true; message: TalkMessage } | { ok: false; reason: string };

/** The hard limits. `limitsFor()` is the reader callers (and proofs) use. */
export const TALK_LIMITS = { maxMessagesPerOrder: 6, maxRoundsPerPair: 2, maxChars: 400 } as const;

export function limitsFor(_orderId?: string): { maxMessagesPerOrder: number; maxRoundsPerPair: number; maxChars: number } {
  return {
    maxMessagesPerOrder: TALK_LIMITS.maxMessagesPerOrder,
    maxRoundsPerPair: TALK_LIMITS.maxRoundsPerPair,
    maxChars: TALK_LIMITS.maxChars,
  };
}

/** FLEET_TALK=1 turns talk on. Anything else (unset, "0", "true") keeps it OFF. */
export function talkEnabled(): boolean {
  return process.env.FLEET_TALK === "1";
}

// Same path sanitising as fleet.ts sanitizeId(), so a board lands beside the work order dirs.
function sanitizeId(id: string): string {
  return String(id).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "unnamed";
}

function orderDir(orderId: string): string {
  return path.join(getCompanyRoot(), "fleet", sanitizeId(orderId));
}

/** The board file for an order (append-only JSONL). Exported for the ops tools. */
export function boardPath(orderId: string): string {
  return path.join(orderDir(orderId), "BOARD.jsonl");
}

function seenPath(orderId: string): string {
  return path.join(orderDir(orderId), "BOARD.seen.json");
}

function tracePath(orderId: string): string {
  return path.join(orderDir(orderId), "BOARD.trace.json");
}

// ── reading the board ─────────────────────────────────────────────────

/** Parse the board. A torn or unparseable line is skipped, never fatal. */
export function readBoard(orderId: string): TalkMessage[] {
  let raw: string;
  try {
    raw = fs.readFileSync(boardPath(orderId), "utf8");
  } catch {
    return [];
  }
  const out: TalkMessage[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const m = JSON.parse(trimmed) as Partial<TalkMessage>;
      if (!m || typeof m.id !== "string" || typeof m.from !== "string" || typeof m.to !== "string" || typeof m.text !== "string") continue;
      out.push({
        id: m.id,
        ts: typeof m.ts === "string" ? m.ts : "",
        from: m.from,
        to: m.to,
        kind: TALK_KINDS.includes(m.kind as TalkKind) ? (m.kind as TalkKind) : "note",
        text: m.text,
      });
    } catch {
      // a half-written last line is ignored, exactly like the other JSONL readers here
    }
  }
  return out;
}

/** Board lines newer than `sinceId` (ids are "m000001"-style, so string compare is order). */
export function readNewMessages(orderId: string, sinceId: string): TalkMessage[] {
  return readBoard(orderId).filter((m) => m.id > sinceId);
}

/**
 * Messages this work order has not seen: addressed to it or to "*", never its own, and newer
 * than the watermark. `sinceId` overrides the stored watermark (used by the proof).
 */
export function readInbox(orderId: string, woId: string, sinceId?: string): TalkMessage[] {
  const since = sinceId !== undefined ? String(sinceId) : readMark(seenPath(orderId), woId);
  return readBoard(orderId).filter((m) => (m.to === woId || m.to === "*") && m.from !== woId && m.id > since);
}

// ── state marks (small JSON maps beside the board) ────────────────────

function readMarkMap(file: string): Record<string, string> {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (j && typeof j === "object" && !Array.isArray(j)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(j as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
      return out;
    }
  } catch {
    // no mark file yet
  }
  return {};
}

function readMark(file: string, key: string): string {
  const v = readMarkMap(file)[key];
  return typeof v === "string" ? v : "";
}

function writeMark(file: string, key: string, id: string): void {
  const map = readMarkMap(file);
  map[key] = id;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(map, null, 2), "utf8");
  } catch {
    // a failed mark must never break an inbox read
  }
}

/** The watermark of the last message a work order has seen in its inbox. */
export function seenId(orderId: string, woId: string): string {
  return readMark(seenPath(orderId), woId);
}

export function markSeen(orderId: string, woId: string, id: string): void {
  writeMark(seenPath(orderId), woId, id);
}

/** The last board id the watcher already wrote into the order trace. */
export function traceMark(orderId: string): string {
  return readMark(tracePath(orderId), "trace");
}

export function setTraceMark(orderId: string, id: string): void {
  writeMark(tracePath(orderId), "trace", id);
}

// ── token redaction ───────────────────────────────────────────────────

/**
 * Token-shaped strings, replaced with "[redacted]" before a line is written. Deliberately
 * shape-based (prefixes, key lengths, a JWT, a long base64 blob): a note never needs to carry a
 * credential, so anything that looks like one is scrubbed rather than the message being refused.
 */
const TOKEN_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /\brk-[A-Za-z0-9_-]{12,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{16,}/gi,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
];

export function redactTokens(text: string): string {
  let out = text;
  for (const re of TOKEN_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, "[redacted]");
  }
  return out;
}

// ── posting ───────────────────────────────────────────────────────────

type OrdersFile = Array<{ id?: string; workOrders?: Array<{ id?: string }> }>;

/** The work order ids of an order, or undefined when orders.json has no such order. */
function orderWorkOrderIds(orderId: string): string[] | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(getCompanyRoot(), "fleet", "orders.json"), "utf8");
  } catch {
    return undefined;
  }
  try {
    const list = JSON.parse(raw) as OrdersFile;
    if (!Array.isArray(list)) return undefined;
    const order = list.find((o) => o && o.id === orderId);
    if (!order) return undefined;
    return (order.workOrders ?? []).map((w) => String(w?.id ?? "")).filter(Boolean);
  } catch {
    return undefined;
  }
}

function nextId(board: TalkMessage[]): string {
  let max = 0;
  for (const m of board) {
    const n = Number(/^m(\d+)$/.exec(m.id)?.[1] ?? 0);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `m${String(max + 1).padStart(6, "0")}`;
}

/**
 * Append one message to the board, or refuse with a plain reason. The seven hard limits are all
 * checked here, so the command line tool, the fleet and a direct caller get the same answer.
 */
export function postMessage(input: { orderId: string; from: string; to: string; kind: string; text: string }): PostResult {
  if (!talkEnabled()) return { ok: false, reason: "talk is off (set FLEET_TALK=1)" };
  const orderId = String(input.orderId ?? "").trim();
  const from = String(input.from ?? "").trim();
  const to = String(input.to ?? "").trim();
  const kind = String(input.kind ?? "").trim();
  const rawText = String(input.text ?? "");
  if (!orderId || !from || !to) return { ok: false, reason: "--order, --from and --to are required" };
  if (!TALK_KINDS.includes(kind as TalkKind)) return { ok: false, reason: `kind must be one of ${TALK_KINDS.join(", ")}` };
  if (from === to) return { ok: false, reason: "a work order cannot send a message to itself" };
  const text = redactTokens(rawText.trim());
  if (!text) return { ok: false, reason: "empty message" };
  if (rawText.trim().length > TALK_LIMITS.maxChars || text.length > TALK_LIMITS.maxChars) {
    return { ok: false, reason: `message is longer than ${TALK_LIMITS.maxChars} characters` };
  }

  const ids = orderWorkOrderIds(orderId);
  if (!ids) return { ok: false, reason: `unknown order ${orderId}: no entry in company/fleet/orders.json` };
  if (!ids.includes(from)) return { ok: false, reason: `${from} is not a work order of ${orderId}` };
  if (to !== "*" && !ids.includes(to)) return { ok: false, reason: `${to} is not a work order of ${orderId}` };

  const board = readBoard(orderId);
  const mine = board.filter((m) => m.from === from);
  if (mine.length >= TALK_LIMITS.maxMessagesPerOrder) {
    return { ok: false, reason: `${from} already sent ${TALK_LIMITS.maxMessagesPerOrder} messages on ${orderId}` };
  }
  const last = mine[mine.length - 1];
  if (last && last.text === text) return { ok: false, reason: "that is an exact duplicate of your previous message" };
  if (kind === "question") {
    const rounds = board.filter(
      (m) => m.kind === "question" && ((m.from === from && m.to === to) || (m.from === to && m.to === from)),
    ).length;
    if (rounds >= TALK_LIMITS.maxRoundsPerPair) {
      return { ok: false, reason: `${TALK_LIMITS.maxRoundsPerPair} question-and-answer rounds between ${from} and ${to} are already used` };
    }
  }

  const message: TalkMessage = { id: nextId(board), ts: new Date().toISOString(), from, to, kind: kind as TalkKind, text };
  try {
    fs.mkdirSync(orderDir(orderId), { recursive: true });
    fs.appendFileSync(boardPath(orderId), `${JSON.stringify(message)}\n`, "utf8");
  } catch (e) {
    return { ok: false, reason: `cannot write the board: ${String((e as Error)?.message ?? e)}` };
  }
  return { ok: true, message };
}

// ── the two commands the brief hands a worker ─────────────────────────

/** The exact `send` command line, with the order and sender filled in. */
export function sendCommand(orderId: string, from: string, to = "*", kind: TalkKind = "note"): string {
  return `npx tsx ops/agent-msg.ts send --order ${orderId} --from ${from} --to ${to} --kind ${kind} --text "..."`;
}

/** The exact `inbox` command line, with the order and worker filled in. */
export function inboxCommand(orderId: string, woId: string): string {
  return `npx tsx ops/agent-msg.ts inbox --order ${orderId} --wo ${woId}`;
}
