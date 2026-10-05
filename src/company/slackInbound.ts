import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { getCompanyRoot, getProject } from "./org.js";
import { assistantMessage } from "./assistant.js";
import type { AssistantResult } from "./assistant.js";
import { redactSecrets } from "../slack.js";
import { getTask } from "./gates.js";

// ---------------------------------------------------------------------------
// TWO-WAY SLACK BRIDGE — the inbound half.
//
// Outbound (company -> Slack) has always existed in src/slack.ts: every gate,
// merge, budget refusal and assistant dispatch is mirrored into one channel.
// This module is the other direction: the CEO types in Slack, the company
// assistant answers, and the answer comes back as a threaded reply.
//
// TWO TRANSPORTS, ONE HANDLER
//   1. SOCKET MODE (preferred): needs an APP-LEVEL token (xapp-... with
//      connections:write) in SLACK_APP_TOKEN. Slack PUSHES events over a
//      WebSocket, so messages are picked up instantly and no polling quota is
//      used. Uses the global WebSocket (Node >= 22), no new dependency.
//   2. POLLING (fallback): without an app token it polls conversations.history
//      with the existing bot token. Works from behind NAT with no public URL and
//      no app token, which is why it exists. Slightly slower (interval, default
//      4s).
//   Both transports funnel into exactly one function, processMessage(), so the
//   loop guard, the dedupe set, the assistant call and the threaded reply are
//   identical no matter how the message arrived.
//
// ENV (all optional):
//   SLACK_BRIDGE=0             disables the bridge entirely (single clear log line)
//   SLACK_APP_TOKEN=xapp-...   enables Socket Mode (primary transport)
//   SLACK_SOCKET_MODE=0|1      force Socket Mode off/on regardless of the above
//   SLACK_BRIDGE_INTERVAL_MS   polling interval, default 4000 (fallback only)
//   SLACK_ASSISTANT_AUTORUN=0  plan but do NOT auto-start pipelines
//   SLACK_REPORT_INTERVAL_MS   finished-task report watcher, default 5000
//
// LOOP SAFETY (a bot replying to itself would be an infinite money loop):
//   - messages carrying bot_id are ignored (that is what the bot's own posts look like)
//   - messages with a subtype are ignored (edits, joins, thread broadcasts, ...)
//   - messages whose user is our own bot user id (resolved once via auth.test) are ignored
//   - messages whose channel is not the configured channel are ignored
//   - empty text, a per-ts dedupe set and a list of known collector test strings
//     are ignored too.
//   The poller additionally never re-reads history: the first run records a
//   baseline (no replies to old messages) and every advance is persisted to
//   company/slack-inbound.json, so a restart resumes instead of replaying.
//
// SAFETY: the bot token and the app token are NEVER logged, printed or returned.
// Log lines carry ids, counts and Slack error strings only.
// ---------------------------------------------------------------------------

const SLACK_API = "https://slack.com/api";
const DEFAULT_INTERVAL_MS = 4000;
const REQUEST_TIMEOUT_MS = 10_000;
// Slack rejects a single message body over 4000 chars; keep every post under it
// and stay in step with src/slack.ts (CHUNK_CHARS = 3400).
const CHUNK_CHARS = 3400;
const MAX_CHUNKS = 6;
const HISTORY_LIMIT = 25;
const BASELINE_SCAN = 20;
const SEEN_CAP = 500;
const MAX_PAGES_PER_TICK = 3;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_JITTER_MS = 500;
const POLL_BACKOFF_BASE_MS = 4000;
const POLL_BACKOFF_MAX_MS = 60_000;
const POLL_BACKOFF_JITTER_MS = 1000;
// A WebSocket that never finishes its handshake (observed once live: Slack accepted
// nothing and no error fired) must not leave the bridge silently dead, so the
// handshake is bounded and repeated failures fall back to the polling transport.
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_CONNECT_ATTEMPTS = 3;
const LOG_CAP = 200;

// The reply speaks as the assistant persona (same styling as src/slack.ts), so
// the CEO sees one consistent voice in the thread.
const ASSISTANT_USERNAME = "Chief of Staff (Assistant)";
const ASSISTANT_ICON = ":office:";

// Strings the collector/ops harnesses already post to this channel. They are
// test noise, not CEO instructions, so they must never reach the assistant.
const IGNORE_PATTERNS: RegExp[] = [/slack-test:/i, /collector:/i, /post-reinstall check/i];

// apps.connections.open errors that mean "an app token will never work here":
// retrying is pointless, so we degrade to the polling fallback instead.
const PERMANENT_APP_TOKEN_ERRORS = new Set([
  "not_allowed_token_type",
  "invalid_auth",
  "not_authed",
  "missing_scope",
  "token_revoked",
  "account_inactive",
  "no_permission",
]);

export type SlackMessage = {
  ts?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  channel?: string;
  thread_ts?: string;
  type?: string;
};

export type InboundTransport = "socket" | "poll" | "off";

export type InboundOutcome = {
  ts: string;
  skipped: boolean;
  /** why it was skipped (guard reason) or why it failed */
  reason?: string;
  assistantCalled: boolean;
  replied: boolean;
  /** ts of the FIRST post of the threaded reply (Slack's real returned ts) */
  replyTs?: string;
  chunks?: number;
  reply?: string;
  error?: string;
};

export type InboundStatus = {
  transport: InboundTransport;
  running: boolean;
  channel: string | null;
  /** presence flags only - never the values */
  appTokenPresent: boolean;
  botTokenPresent: boolean;
  socketState: string;
  botUserId: string | null;
  lastTs: string | null;
  baselineDone: boolean;
  intervalMs: number;
  polls: number;
  received: number;
  handled: number;
  skipped: number;
  replies: number;
  deduped: number;
  acks: number;
  reconnects: number;
  lastError?: string;
  recentLog: string[];
};

/** Everything is overridable so tests never have to touch .env. */
export type SlackInboundOptions = {
  botToken?: string;
  appToken?: string;
  channelId?: string;
  intervalMs?: number;
  autoRun?: boolean;
  /** true = socket, false = polling, undefined = decide from env */
  socketMode?: boolean;
  /** SLACK_BRIDGE=0 */
  disabled?: boolean;
  /** override the persisted last-seen-ts file (tests use a temp path) */
  stateFile?: string;
  /** override the bot's own user id (tests) */
  botUserId?: string;
  /** synthetic sender id used by __testHandleIncoming */
  testUser?: string;
};

type ResolvedOptions = {
  botToken: string;
  appToken: string;
  channelId: string;
  intervalMs: number;
  autoRun: boolean;
  socketMode: boolean | undefined;
  disabled: boolean;
  stateFile: string;
  botUserId: string;
  testUser: string;
};

type WsLike = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (ev: unknown) => void): void;
  readyState?: number;
};

type BridgeState = {
  opts: ResolvedOptions;
  transport: InboundTransport;
  running: boolean;
  socketStopped: boolean;
  socketState: string;
  initPromise: Promise<void> | null;
  timer: NodeJS.Timeout | null;
  reportTimer: NodeJS.Timeout | null;
  reportInFlight: boolean;
  reconnectTimer: NodeJS.Timeout | null;
  reconnectAttempt: number;
  pollInFlight: boolean;
  pollFailures: number;
  nextPollAfter: number;
  baselineDone: boolean;
  botUserId: string;
  lastTs: string | null;
  seen: Set<string>;
  seenQueue: string[];
  /** threads the bridge has joined (polling transport only), newest first */
  threads: Array<{ ts: string; lastSeen: string }>;
  threadRotation: number;
  socket: WsLike | null;
  connectTimer: NodeJS.Timeout | null;
  socketEverConnected: boolean;
  polls: number;
  received: number;
  handled: number;
  skipped: number;
  replies: number;
  deduped: number;
  acks: number;
  reconnects: number;
  lastError?: string;
  logLines: string[];
};

let state: BridgeState | null = null;
// auth.test is called at most once per bot token per process.
const botUserIdCache = new Map<string, string>();

function envTrim(name: string): string {
  return (process.env[name] ?? "").trim();
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.name === "TimeoutError" || e.name === "AbortError" ? `timed out after ${REQUEST_TIMEOUT_MS}ms` : e.message;
  if (e && typeof e === "object") {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string" && m) return m;
    const t = (e as { type?: unknown }).type;
    if (typeof t === "string" && t) return t;
  }
  return String(e ?? "unknown error");
}

function clip(text: unknown, max: number): string {
  const s = typeof text === "string" ? text : String(text ?? "");
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function log(line: string): void {
  const text = `[slack-inbound] ${line}`;
  console.log(text);
  if (state) {
    state.logLines.push(text);
    if (state.logLines.length > LOG_CAP) state.logLines = state.logLines.slice(-LOG_CAP);
  }
}

function noteError(line: string): void {
  if (state) state.lastError = redactSecrets(clip(line, 300));
  log(line);
}

function resolveOptions(over: SlackInboundOptions = {}): ResolvedOptions {
  const intervalRaw = Number(over.intervalMs ?? envTrim("SLACK_BRIDGE_INTERVAL_MS"));
  const socketRaw = over.socketMode === undefined ? envTrim("SLACK_SOCKET_MODE") : undefined;
  return {
    botToken: over.botToken ?? (envTrim("SLACK_BOT_TOKEN") || config.slackBotToken),
    appToken: over.appToken ?? (envTrim("SLACK_APP_TOKEN") || config.slackAppToken),
    channelId: over.channelId ?? (envTrim("SLACK_CHANNEL_ID") || config.slackChannelId),
    intervalMs: Number.isFinite(intervalRaw) && intervalRaw >= 1000 ? Math.floor(intervalRaw) : DEFAULT_INTERVAL_MS,
    autoRun: over.autoRun ?? envTrim("SLACK_ASSISTANT_AUTORUN") !== "0",
    socketMode: over.socketMode ?? (socketRaw === "1" ? true : socketRaw === "0" ? false : undefined),
    disabled: over.disabled ?? envTrim("SLACK_BRIDGE") === "0",
    stateFile: over.stateFile ?? path.join(getCompanyRoot(), "slack-inbound.json"),
    botUserId: over.botUserId ?? "",
    testUser: over.testUser ?? "U_CEO_SYNTHETIC",
  };
}

function newState(opts: ResolvedOptions, transport: InboundTransport): BridgeState {
  return {
    opts,
    transport,
    running: false,
    socketStopped: false,
    socketState: transport === "socket" ? "idle" : "n/a",
    initPromise: null,
    timer: null,
    reportTimer: null,
    reportInFlight: false,
    reconnectTimer: null,
    reconnectAttempt: 0,
    pollInFlight: false,
    pollFailures: 0,
    nextPollAfter: 0,
    baselineDone: transport !== "poll",
    botUserId: opts.botUserId,
    lastTs: null,
    seen: new Set<string>(),
    seenQueue: [],
    threads: [],
    threadRotation: 0,
    socket: null,
    connectTimer: null,
    socketEverConnected: false,
    polls: 0,
    received: 0,
    handled: 0,
    skipped: 0,
    replies: 0,
    deduped: 0,
    acks: 0,
    reconnects: 0,
    logLines: [],
  };
}

function requireState(): BridgeState {
  if (!state) state = newState(resolveOptions(), "off");
  return state;
}

// Transport choice, logged verbatim so ops can see which path is live.
function selectTransport(opts: ResolvedOptions): { transport: InboundTransport; why: string } {
  if (opts.disabled) return { transport: "off", why: "SLACK_BRIDGE=0 disables the bridge" };
  const hasBot = !!opts.botToken && !!opts.channelId;
  if (opts.appToken && opts.socketMode !== false) {
    return { transport: "socket", why: "SLACK_APP_TOKEN is set and SLACK_SOCKET_MODE is not 0: Slack pushes events over a WebSocket" };
  }
  if (opts.appToken && opts.socketMode === false) {
    return hasBot
      ? { transport: "poll", why: "SLACK_SOCKET_MODE=0 forced the polling fallback even though SLACK_APP_TOKEN is set" }
      : { transport: "off", why: "SLACK_SOCKET_MODE=0 and no bot token/channel: nothing to poll" };
  }
  if (hasBot) return { transport: "poll", why: "no SLACK_APP_TOKEN: falling back to polling conversations.history" };
  const missing = [!opts.botToken ? "SLACK_BOT_TOKEN" : "", !opts.channelId ? "SLACK_CHANNEL_ID" : ""].filter(Boolean).join(" + ");
  return { transport: "off", why: `no SLACK_APP_TOKEN and ${missing} is empty: the bridge is a no-op` };
}

// ── Slack HTTP ────────────────────────────────────────────────────────────

// Slack API call with a bound timeout. Never throws: every failure is a value,
// because a flaky network must not kill the poller or the socket loop.
async function slackApi(
  method: string,
  payload: Record<string, string | number | boolean | undefined>,
  token: string,
  httpMethod: "GET" | "POST" = "GET",
): Promise<{ ok: boolean; data: Record<string, unknown>; error?: string }> {
  const empty = { ok: false, data: {} as Record<string, unknown> };
  if (!token) return { ...empty, error: "no token configured" };
  try {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(payload)) {
      if (v === undefined || v === null) continue;
      search.set(k, String(v));
    }
    const url = httpMethod === "GET" ? `${SLACK_API}/${method}?${search.toString()}` : `${SLACK_API}/${method}`;
    const res = await fetch(url, {
      method: httpMethod,
      headers: httpMethod === "POST"
        ? { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" }
        : { authorization: `Bearer ${token}` },
      ...(httpMethod === "POST" ? { body: search.toString() } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const j = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!j) return { ...empty, error: `non-JSON response (HTTP ${res.status})` };
    if (j.ok !== true) return { ok: false, data: j, error: typeof j.error === "string" ? j.error : `http_${res.status}` };
    return { ok: true, data: j };
  } catch (e) {
    return { ...empty, error: errText(e) };
  }
}

function tsOf(m: SlackMessage): string {
  return typeof m?.ts === "string" ? m.ts.trim() : "";
}

// Slack ts values are "<seconds>.<micros>" strings; numeric compare is correct.
function isNewer(a: string, than: string | null): boolean {
  if (!a) return false;
  if (!than) return true;
  const na = Number(a);
  const nb = Number(than);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na > nb;
  return a > than;
}

function byTsAsc(a: SlackMessage, b: SlackMessage): number {
  return Number(tsOf(a)) - Number(tsOf(b));
}

function normalizeMessages(raw: unknown): SlackMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: SlackMessage[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const rec = m as Record<string, unknown>;
    if (typeof rec.ts !== "string") continue;
    out.push({
      ts: rec.ts,
      ...(typeof rec.text === "string" ? { text: rec.text } : {}),
      ...(typeof rec.user === "string" ? { user: rec.user } : {}),
      ...(typeof rec.bot_id === "string" ? { bot_id: rec.bot_id } : {}),
      ...(typeof rec.subtype === "string" ? { subtype: rec.subtype } : {}),
      ...(typeof rec.channel === "string" ? { channel: rec.channel } : {}),
      ...(typeof rec.thread_ts === "string" ? { thread_ts: rec.thread_ts } : {}),
      ...(typeof rec.type === "string" ? { type: rec.type } : {}),
    });
  }
  return out;
}

function markSeen(s: BridgeState, ts: string): void {
  if (s.seen.has(ts)) return;
  s.seen.add(ts);
  s.seenQueue.push(ts);
  while (s.seenQueue.length > SEEN_CAP) {
    const oldest = s.seenQueue.shift();
    if (oldest) s.seen.delete(oldest);
  }
}

function threadTsFor(raw: SlackMessage): string {
  const parent = typeof raw.thread_ts === "string" ? raw.thread_ts.trim() : "";
  return parent || tsOf(raw);
}

function stripBotMention(text: string, botUserId: string): string {
  let out = text;
  if (botUserId) {
    out = out.replace(new RegExp(`<@${botUserId}(\\|[^>]*)?>`, "g"), " ");
  }
  // A mention we could not resolve (bot user id unknown) still gets stripped when
  // it is the leading token, so the assistant does not see raw "<@U...>".
  out = out.replace(/^\s*<@[UW][A-Z0-9]+>\s*/i, "");
  return out.replace(/[ \t]{2,}/g, " ").trim();
}

/**
 * THE loop guard. Returns a human-readable reason when a message must NOT reach
 * the assistant, or null when it is a genuine CEO message.
 */
function ignoreReason(s: BridgeState, raw: SlackMessage): string | null {
  if (!raw || typeof raw !== "object") return "not a message object";
  if (!tsOf(raw)) return "message has no ts";
  if (raw.bot_id) return `bot_id=${raw.bot_id} (the bot's own post)`;
  if (raw.subtype) return `subtype=${raw.subtype} (not a plain human message)`;
  if (raw.user && s.botUserId && raw.user === s.botUserId) return `user=${raw.user} is the bot itself`;
  if (raw.channel && s.opts.channelId && raw.channel !== s.opts.channelId) {
    return `channel=${raw.channel} is not the configured channel ${s.opts.channelId}`;
  }
  const text = stripBotMention(typeof raw.text === "string" ? raw.text : "", s.botUserId);
  if (!text) return "empty text";
  for (const re of IGNORE_PATTERNS) {
    if (re.test(text)) return `known test string (${re.source})`;
  }
  return null;
}

// ── State file (polling baseline / resume) ────────────────────────────────

type PersistedState = { channel?: string; lastTs?: string; threads?: Array<{ ts: string; lastSeen: string }> };

async function readStateFile(file: string): Promise<PersistedState> {
  try {
    if (!fs.existsSync(file)) return {};
    const raw = await fs.promises.readFile(file, "utf8");
    const j = JSON.parse(raw) as Record<string, unknown>;
    const threads: Array<{ ts: string; lastSeen: string }> = [];
    if (Array.isArray(j.threads)) {
      for (const t of j.threads) {
        if (!t || typeof t !== "object") continue;
        const rec = t as Record<string, unknown>;
        if (typeof rec.ts === "string" && typeof rec.lastSeen === "string") threads.push({ ts: rec.ts, lastSeen: rec.lastSeen });
      }
    }
    return {
      ...(typeof j.channel === "string" ? { channel: j.channel } : {}),
      ...(typeof j.lastTs === "string" ? { lastTs: j.lastTs } : {}),
      ...(threads.length ? { threads } : {}),
    };
  } catch {
    return {};
  }
}

async function writeStateFile(file: string, payload: { channel: string; lastTs: string; threads?: Array<{ ts: string; lastSeen: string }> }): Promise<void> {
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.promises.writeFile(
      tmp,
      JSON.stringify({ channel: payload.channel, lastTs: payload.lastTs, threads: payload.threads ?? [], updatedAt: new Date().toISOString() }, null, 2),
    );
    await fs.promises.rename(tmp, file);
  } catch (e) {
    noteError(`could not persist the last-processed ts (${errText(e)}); the in-memory cursor is still correct`);
  }
}

// ── Task report-back (work order #1) ───────────────────────────────────────────
// When the assistant dispatches work from a Slack message, remember WHICH thread
// that message was in, so the outcome can be posted back there instead of only
// showing up on the dashboard. Persisted (survives a restart), idempotent (a task
// is reported at most once, even across restarts), capped, and entirely inside
// this module - no hook in assistant.ts / pipeline.ts is required.

type TaskThreadEntry = {
  projectId: string;
  taskId: string;
  title: string;
  threadTs: string;
  reportedTs: string | null;
};

type TaskThreadMap = Record<string, TaskThreadEntry>;

const TASK_THREADS_CAP = 500;
const DEFAULT_REPORT_INTERVAL_MS = 5000;

function taskThreadsFile(s: BridgeState): string {
  // Deliberately beside the bridge's own state file: a caller (or a test) that
  // overrides stateFile into a temp dir automatically gets an isolated map too.
  return path.join(path.dirname(s.opts.stateFile), "slack-task-threads.json");
}

async function readTaskThreads(file: string): Promise<TaskThreadMap> {
  try {
    if (!fs.existsSync(file)) return {};
    const raw = await fs.promises.readFile(file, "utf8");
    const j = JSON.parse(raw) as Record<string, unknown>;
    const out: TaskThreadMap = {};
    for (const [key, v] of Object.entries(j)) {
      if (!v || typeof v !== "object") continue;
      const r = v as Record<string, unknown>;
      if (typeof r.taskId !== "string" || typeof r.projectId !== "string") continue;
      out[key] = {
        projectId: r.projectId,
        taskId: r.taskId,
        title: typeof r.title === "string" ? r.title : r.taskId,
        threadTs: typeof r.threadTs === "string" ? r.threadTs : "",
        reportedTs: typeof r.reportedTs === "string" ? r.reportedTs : null,
      };
    }
    return out;
  } catch {
    return {};
  }
}

async function writeTaskThreads(file: string, map: TaskThreadMap): Promise<void> {
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const keys = Object.keys(map);
    const trimmed: TaskThreadMap = {};
    for (const k of keys.slice(Math.max(0, keys.length - TASK_THREADS_CAP))) trimmed[k] = map[k]!;
    const tmp = `${file}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(trimmed, null, 2));
    await fs.promises.rename(tmp, file);
  } catch (e) {
    noteError(`could not persist the task report-back map (${errText(e)})`);
  }
}

/** Remember every task the assistant just dispatched, keyed `projectId::taskId`. */
async function recordDispatchedTasks(s: BridgeState, result: AssistantResult, threadTs: string): Promise<void> {
  try {
    const dispatched = Array.isArray(result?.dispatched) ? result.dispatched : [];
    if (!dispatched.length) return;
    const file = taskThreadsFile(s);
    const map = await readTaskThreads(file);
    let added = 0;
    for (const d of dispatched) {
      if (!d || typeof d.taskId !== "string" || typeof d.projectId !== "string") continue;
      const key = `${d.projectId}::${d.taskId}`;
      // Never resurrect an entry that has already been reported.
      if (map[key]?.reportedTs) continue;
      map[key] = {
        projectId: d.projectId,
        taskId: d.taskId,
        title: typeof d.title === "string" ? d.title : d.taskId,
        threadTs: threadTs || "",
        reportedTs: null,
      };
      added++;
    }
    if (!added) return;
    await writeTaskThreads(file, map);
    log(`tracking ${added} dispatched task(s) for Slack report-back (thread ${threadTs || "channel"})`);
  } catch (e) {
    // Bookkeeping must never break the reply path.
    noteError(`task report-back bookkeeping failed (${errText(e)})`);
  }
}

/** One pass: post an outcome for every tracked task that has reached a terminal state. */
async function reportFinishedTasks(s: BridgeState): Promise<number> {
  if (s.reportInFlight) return 0;
  s.reportInFlight = true;
  let posted = 0;
  try {
    const file = taskThreadsFile(s);
    const map = await readTaskThreads(file);
    let changed = false;
    for (const entry of Object.values(map)) {
      if (entry.reportedTs) continue;
      let task: ReturnType<typeof getTask>;
      try {
        task = getTask(entry.projectId, entry.taskId);
      } catch {
        task = undefined;
      }
      if (!task) {
        // The task is gone (removed/reconciled away). Stop retrying forever.
        entry.reportedTs = "missing";
        changed = true;
        continue;
      }
      if (task.status !== "merged" && task.status !== "failed") continue;
      const projectName = (() => {
        try {
          return getProject(entry.projectId)?.name ?? entry.projectId;
        } catch {
          return entry.projectId;
        }
      })();
      const ok = task.status === "merged";
      const title = clip(entry.title || task.id, 90);
      const text = ok
        ? `:white_check_mark: Done: ${title} (${projectName})`
        : `:x: Failed: ${title} (${projectName}) - ${clip(redactSecrets(String(task.error ?? "no reason recorded")), 160)}`;
      // No thread_ts when the originating thread is unknown: postReply then omits it
      // and the report lands in the channel. thread_ts must be a message ts, so
      // passing the channel id here would be rejected by Slack.
      const target = entry.threadTs;
      const outcome = await postReply(s, target, text);
      if (!outcome.posted) {
        if (outcome.mock) {
          // Nothing can be posted in mock/console mode: mark it so the tick does not
          // retry the same task forever.
          entry.reportedTs = "mock";
          changed = true;
          continue;
        }
        noteError(`could not report task ${entry.taskId} to Slack: ${outcome.error ?? "unknown"}`);
        continue;
      }
      // Persist IMMEDIATELY after a successful post: a crash here must not be able
      // to produce a second report on the next tick.
      entry.reportedTs = outcome.ts ?? new Date().toISOString();
      changed = true;
      posted++;
      log(`reported ${task.status} task ${entry.taskId} into ${target || "the channel"} (post ts ${entry.reportedTs})`);
    }
    if (changed) await writeTaskThreads(file, map);
  } catch (e) {
    noteError(`task report-back tick failed (${errText(e)})`);
  } finally {
    s.reportInFlight = false;
  }
  return posted;
}

/**
 * Start the report-back watcher. Runs for BOTH transports (it is independent of
 * how messages arrive) and is unref'd so it can never keep a process alive.
 * Interval: SLACK_REPORT_INTERVAL_MS (default 5000, minimum 500).
 */
function startTaskReporter(s: BridgeState): void {
  if (s.reportTimer) return;
  const raw = Number(process.env.SLACK_REPORT_INTERVAL_MS ?? DEFAULT_REPORT_INTERVAL_MS);
  const every = Number.isFinite(raw) && raw >= 500 ? Math.floor(raw) : DEFAULT_REPORT_INTERVAL_MS;
  s.reportTimer = setInterval(() => {
    void reportFinishedTasks(s);
  }, every);
  s.reportTimer.unref?.();
  log(`task report-back watcher every ${every}ms (interval is unref'd, so it never keeps the process alive)`);
}

// Threads the bridge has joined. conversations.history only returns TOP-LEVEL
// messages (a thread's child replies are not in it - verified live: the CEO replied
// inside the assistant's thread and history never showed it), so every thread the
// bridge answers is remembered here and polled with conversations.replies.
// Each entry keeps its OWN watermark: the global cursor cannot be used for children,
// because bot mirror traffic can push the cursor past a child that is still unhandled.
const THREADS_CAP = 20;
const THREADS_POLLED_PER_TICK = 1;

function rememberThread(s: BridgeState, ts: string, lastSeen?: string): void {
  if (!ts) return;
  const existing = s.threads.find((t) => t.ts === ts);
  if (existing) {
    if (lastSeen && isNewer(lastSeen, existing.lastSeen)) existing.lastSeen = lastSeen;
    return;
  }
  s.threads.unshift({ ts, lastSeen: lastSeen ?? ts });
  if (s.threads.length > THREADS_CAP) s.threads = s.threads.slice(0, THREADS_CAP);
  void persistCursor(s);
}

async function persistCursor(s: BridgeState): Promise<void> {
  if (s.transport !== "poll" || !s.lastTs) return;
  await writeStateFile(s.opts.stateFile, { channel: s.opts.channelId, lastTs: s.lastTs, threads: s.threads });
}

// Move the polling cursor forward and persist it. Never moves backwards.
function advance(s: BridgeState, ts: string): void {
  if (!isNewer(ts, s.lastTs)) return;
  s.lastTs = ts;
  void persistCursor(s);
}

// ── Outbound reply (threaded) ─────────────────────────────────────────────

function chunkText(text: string, size = CHUNK_CHARS): string[] {
  const s = typeof text === "string" ? text : String(text ?? "");
  if (s.length <= size) return [s];
  const out: string[] = [];
  let rest = s;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < Math.floor(size / 2)) {
      cut = rest.lastIndexOf(" ", size);
    }
    if (cut < Math.floor(size / 2)) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) out.push(rest);
  return out.length ? out : [""];
}

function mockReason(s: BridgeState): string {
  if (!s.opts.botToken) return "no bot token configured - console fallback (no Slack post)";
  if (!s.opts.channelId) return "no channel configured - console fallback (no Slack post)";
  return "MOCK_MODE=1 - console fallback (no Slack post)";
}

/**
 * Post a threaded reply to the CEO's message and return the REAL ts of the first
 * post.
 *
 * This posts directly instead of calling slack.ts postAs() because postAs()
 * returns the thread parent's ts when given thread_ts (it posts all chunks into
 * one thread and only ever learns a new ts on the first message), and the bridge
 * needs the ts of the reply it just created - both for ops and for the
 * verification contract. The payload mirrors postAs() exactly (same persona
 * username/icon, same redaction, same 3400-char chunking, bounded timeout), and
 * errors resolve to a value instead of throwing.
 */
async function postReply(s: BridgeState, threadTs: string, text: string): Promise<{ posted: boolean; ts?: string; chunks: number; mock?: boolean; error?: string }> {
  const body = redactSecrets(typeof text === "string" ? text : String(text ?? ""));
  if (config.mockMode || !s.opts.botToken || !s.opts.channelId) {
    const reason = mockReason(s);
    console.log(`[slack:mock] [${ASSISTANT_USERNAME}] (${reason}) thread=${threadTs || "(none)"} ${clip(body, 300)}`);
    return { posted: false, mock: true, chunks: 0, error: reason };
  }
  const parts = chunkText(body).slice(0, MAX_CHUNKS);
  let firstTs: string | undefined;
  let chunks = 0;
  for (const part of parts) {
    const r = await slackApi(
      "chat.postMessage",
      {
        channel: s.opts.channelId,
        text: part,
        username: ASSISTANT_USERNAME,
        icon_emoji: ASSISTANT_ICON,
        // No thread_ts at all when the thread is unknown: posting with an empty
        // thread_ts addresses no thread instead of the channel.
        ...(threadTs ? { thread_ts: threadTs } : {}),
        unfurl_links: false,
      },
      s.opts.botToken,
      "POST",
    );
    if (!r.ok) {
      const detail = r.error === "ratelimited" ? "ratelimited" : (r.error ?? "unknown error");
      return { posted: chunks > 0, ts: firstTs, chunks, error: `chat.postMessage failed: ${detail}` };
    }
    chunks++;
    if (!firstTs && typeof r.data.ts === "string") firstTs = r.data.ts;
  }
  return { posted: true, ts: firstTs, chunks };
}

// ── Reply text ────────────────────────────────────────────────────────────

const SUMMARY_LINE_CAP = 12;
const SUMMARY_CHARS_CAP = 1400;

function summaryLines(result: AssistantResult): string[] {
  const lines: string[] = [];
  let used = 0;
  const push = (line: string) => {
    if (lines.length >= SUMMARY_LINE_CAP || used + line.length > SUMMARY_CHARS_CAP) return false;
    lines.push(line);
    used += line.length + 1;
    return true;
  };
  const plan = Array.isArray(result?.plan) ? result.plan : [];
  const dispatched = Array.isArray(result?.dispatched) ? result.dispatched : [];
  const decisions = Array.isArray(result?.decisions) ? result.decisions : [];

  for (const d of dispatched.slice(0, 5)) {
    push(`task ${d.taskId} @ ${d.projectId} [${d.status}] ${clip(d.title, 60)}`);
  }
  for (const p of plan.slice(0, 5)) {
    push(`work order: "${clip(p.title, 60)}" -> ${p.departmentName || "unassigned"} (${p.role || "coder"})`);
  }
  const interesting = decisions.filter((d) => /skip|could not|capped|exhaust|budget|fail|unavailable|error|refus/i.test(d));
  const notes = (interesting.length ? interesting : decisions).slice(0, 4);
  for (const d of notes) push(`note: ${clip(d, 180)}`);

  const total = plan.length + dispatched.length + decisions.length;
  if (total > lines.length) {
    push(`(+${total - lines.length} more item(s); full plan: GET /company/assistant/thread)`);
  }
  return lines;
}

function buildReplyText(result: AssistantResult): string {
  const reply = typeof result?.reply === "string" ? result.reply.trim() : "";
  const lines = summaryLines(result);
  const out = [reply || "(the assistant returned no text)"];
  if (lines.length) out.push("", "---", ...lines);
  return out.join("\n");
}

// ── The one handler every transport funnels into ──────────────────────────

async function processMessage(raw: SlackMessage): Promise<InboundOutcome> {
  const s = requireState();
  const ts = tsOf(raw);
  const base: InboundOutcome = { ts, skipped: false, assistantCalled: false, replied: false };
  if (!s.running && s.transport !== "off" && !s.opts.botToken) {
    // nothing to do; keep the shape total
  }

  if (s.seen.has(ts)) {
    s.deduped++;
    s.skipped++;
    log(`skip ts=${ts}: already handled in this process (dedupe set)`);
    return { ...base, skipped: true, reason: "duplicate ts (already handled in this process)" };
  }

  const reason = ignoreReason(s, raw);
  if (reason) {
    markSeen(s, ts);
    advance(s, ts);
    s.skipped++;
    log(`skip ts=${ts}: ${reason}`);
    return { ...base, skipped: true, reason };
  }

  // Dedupe BEFORE the slow part: a Slack redelivery (or a poll racing a socket
  // event) must never produce a second assistant call.
  markSeen(s, ts);
  advance(s, ts);

  const text = stripBotMention(String(raw.text ?? ""), s.botUserId);
  const threadTs = threadTsFor(raw);
  // Watch this thread from now on (a CEO follow-up typed inside the thread never
  // shows up in conversations.history).
  // No watermark advance here on purpose: the thread's lastSeen is only persisted
  // once pollThreads() has finished handling the batch, so a crash mid-answer means
  // the message is picked up again on restart instead of being silently lost
  // (at-least-once; the rare cost is a duplicate reply, never a dropped instruction).
  if (threadTs) rememberThread(s, threadTs);
  s.handled++;
  log(`handling ts=${ts} thread=${threadTs} from ${raw.user ?? "unknown"}: "${clip(text, 80)}"`);

  let result: AssistantResult;
  try {
    result = await assistantMessage(text, { autoRun: s.opts.autoRun });
  } catch (e) {
    const detail = redactSecrets(clip(errText(e), 240));
    const post = await postReply(s, threadTs, `I could not handle that message: ${detail}`);
    s.replies++;
    noteError(`assistant failed for ts=${ts}: ${detail}`);
    return { ...base, assistantCalled: true, replied: post.posted, replyTs: post.ts, chunks: post.chunks, error: detail };
  }

  // Work order #1: remember which Slack thread this work came from, so the outcome
  // can be reported back there and the CEO sees the result where he asked for it.
  await recordDispatchedTasks(s, result, threadTs);

  const replyText = buildReplyText(result);
  const post = await postReply(s, threadTs, replyText);
  if (post.posted) {
    s.replies++;
    log(`replied to ts=${ts} as ${post.chunks} post(s), first ts=${post.ts ?? "?"}`);
  } else {
    noteError(`reply to ts=${ts} did not land: ${post.error ?? "unknown reason"}`);
  }
  return {
    ...base,
    assistantCalled: true,
    replied: post.posted,
    ...(post.ts ? { replyTs: post.ts } : {}),
    chunks: post.chunks,
    reply: replyText,
    ...(post.error ? { error: post.error } : {}),
  };
}

// ── Polling transport ─────────────────────────────────────────────────────

async function resolveBotUserId(s: BridgeState): Promise<string> {
  if (s.opts.botUserId) return s.opts.botUserId;
  if (s.botUserId) return s.botUserId;
  const cached = botUserIdCache.get(s.opts.botToken);
  if (cached) {
    s.botUserId = cached;
    return cached;
  }
  if (!s.opts.botToken) return "";
  const r = await slackApi("auth.test", {}, s.opts.botToken, "POST");
  if (!r.ok) {
    log(`auth.test failed (${r.error ?? "unknown"}); the loop guard still uses bot_id/subtype`);
    return "";
  }
  const id = typeof r.data.user_id === "string" ? r.data.user_id : "";
  if (id) {
    botUserIdCache.set(s.opts.botToken, id);
    s.botUserId = id;
    log(`bot identity resolved via auth.test (user_id=${id})`);
  }
  return id;
}

// First run (or a channel change): learn the newest ts and reply to NOTHING.
// This is what stops a restart from answering every old message in the channel.
async function establishBaseline(s: BridgeState): Promise<boolean> {
  const r = await slackApi("conversations.history", { channel: s.opts.channelId, limit: BASELINE_SCAN }, s.opts.botToken);
  if (!r.ok) {
    noteError(`baseline not established (conversations.history said ${r.error ?? "unknown"}); the poller will not read history until it is`);
    return false;
  }
  const msgs = normalizeMessages(r.data.messages);
  const newest = msgs.map(tsOf).filter(Boolean).sort((a, b) => Number(a) - Number(b)).pop() ?? "";
  for (const m of msgs) markSeen(s, tsOf(m));
  if (!newest) {
    s.baselineDone = true;
    log("baseline: channel history is empty, nothing to skip; resuming from now");
    return true;
  }
  s.lastTs = newest;
  s.baselineDone = true;
  persistCursor(s);
  log(`baseline: ${msgs.length} existing message(s) in history will NOT be replayed; resuming from ts=${newest} (cursor: ${s.opts.stateFile})`);
  return true;
}

/**
 * Remember the threads of recent HUMAN messages so follow-ups typed inside them are
 * picked up. Only non-bot parents qualify (bot mirror posts create thousands of
 * threads and are never addressed to us). Children are deliberately not seeded:
 * a child's own "thread" is its parent.
 */
async function seedThreadsFromHistory(s: BridgeState): Promise<void> {
  const r = await slackApi("conversations.history", { channel: s.opts.channelId, limit: BASELINE_SCAN }, s.opts.botToken);
  if (!r.ok) return;
  const human = normalizeMessages(r.data.messages)
    .filter((m) => !m.bot_id && !!m.user && m.user !== s.botUserId)
    .sort(byTsAsc)
    .slice(-5);
  for (const m of human) {
    const ts = tsOf(m);
    if (!s.threads.some((t) => t.ts === ts)) rememberThread(s, ts, ts);
  }
  if (human.length) log(`watching ${human.length} recent CEO thread(s) for in-thread follow-ups`);
}

function pollFailureDelay(failures: number): number {
  const base = Math.min(POLL_BACKOFF_MAX_MS, POLL_BACKOFF_BASE_MS * 2 ** Math.min(failures, 6));
  const jitter = Math.floor(Math.random() * POLL_BACKOFF_JITTER_MS);
  return base + jitter;
}

async function pollOnce(): Promise<number> {
  const s = requireState();
  if (s.pollInFlight) return 0;
  if (Date.now() < s.nextPollAfter) return 0;
  s.pollInFlight = true;
  let handled = 0;
  let failed = false;
  try {
    if (!s.lastTs) {
      const ok = await establishBaseline(s);
      if (!ok) {
        failed = true;
        return 0;
      }
    }
    // Drain the backlog. This channel carries a mirror post per pipeline step, so a
    // single 25-message page can hide the CEO's message behind bot noise; walking
    // forward while Slack says has_more (bounded) means no CEO message is skipped
    // just because the company was busy.
    for (let page = 0; page < MAX_PAGES_PER_TICK; page++) {
      s.polls++;
      const r = await slackApi(
        "conversations.history",
        { channel: s.opts.channelId, limit: HISTORY_LIMIT, ...(s.lastTs ? { oldest: s.lastTs } : {}) },
        s.opts.botToken,
      );
      if (!r.ok) {
        noteError(`poll failed: conversations.history said ${r.error ?? "unknown"}`);
        failed = true;
        break;
      }
      const msgs = normalizeMessages(r.data.messages).sort(byTsAsc);
      s.received += msgs.length;
      const fresh = msgs.filter((m) => isNewer(tsOf(m), s.lastTs));
      if (fresh.length) log(`poll: ${fresh.length} new message(s) since ts=${s.lastTs ?? "(start)"}`);
      for (const m of fresh) {
        const o = await processMessage(m);
        if (!o.skipped) handled++;
      }
      if (!fresh.length || r.data.has_more !== true) break;
      await sleepMs(250);
    }
    if (!failed) {
      const threadResult = await pollThreads(s);
      // pollThreads logs its own failures; do not treat a thread failure as a
      // channel-poll failure because the main cursor already advanced.
      handled += threadResult;
    }
    return handled;
  } catch (e) {
    // Belt and braces: a poll must never kill the interval.
    failed = true;
    noteError(`poll crashed (continuing): ${errText(e)}`);
    return 0;
  } finally {
    s.pollInFlight = false;
    if (failed) {
      s.pollFailures++;
      s.nextPollAfter = Date.now() + pollFailureDelay(s.pollFailures);
      log(`poll backing off ${s.nextPollAfter - Date.now()}ms after ${s.pollFailures} consecutive failure(s)`);
    } else {
      s.pollFailures = 0;
      s.nextPollAfter = 0;
    }
  }
}

// Poll remembered threads round-robin, one (or a few) per tick to stay inside
// Slack's per-method rate limits: 1 extra call per tick keeps the bridge at roughly
// 30 calls/minute. With many live threads, pickup for an individual thread is slower
// - which is one more reason Socket Mode is the preferred transport.
async function pollThreads(s: BridgeState): Promise<number> {
  let handled = 0;
  if (!s.threads.length) return 0;
  for (let i = 0; i < THREADS_POLLED_PER_TICK; i++) {
    const entry = s.threads[s.threadRotation % s.threads.length];
    s.threadRotation++;
    if (!entry) continue;
    const r = await slackApi(
      "conversations.replies",
      { channel: s.opts.channelId, ts: entry.ts, oldest: entry.lastSeen, limit: "20" },
      s.opts.botToken,
    );
    if (!r.ok) {
      noteError(`thread poll failed for ts=${entry.ts}: conversations.replies said ${r.error ?? "unknown"}`);
      continue;
    }
    const children = normalizeMessages(r.data.messages)
      .filter((m) => tsOf(m) !== entry.ts)
      .sort(byTsAsc);
    const fresh = children.filter((m) => isNewer(tsOf(m), entry.lastSeen));
    if (!fresh.length) continue;
    log(`thread ${entry.ts}: ${fresh.length} new in-thread message(s)`);
    for (const m of fresh) {
      const o = await processMessage(m);
      if (!o.skipped) handled++;
    }
    // Only advance this thread's watermark after its new messages were handled.
    const newest = fresh.map(tsOf).sort((a, b) => Number(a) - Number(b)).pop();
    if (newest) {
      entry.lastSeen = newest;
      await persistCursor(s);
    }
  }
  return handled;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function initPoll(s: BridgeState): Promise<void> {
  s.transport = "poll";
  s.baselineDone = false;
  await resolveBotUserId(s);
  const persisted = await readStateFile(s.opts.stateFile);
  if (persisted.lastTs && persisted.channel && persisted.channel === s.opts.channelId) {
    s.lastTs = persisted.lastTs;
    s.baselineDone = true;
    log(`resuming from the persisted cursor ts=${persisted.lastTs} (${s.opts.stateFile})`);
  } else if (persisted.lastTs && persisted.channel && persisted.channel !== s.opts.channelId) {
    log(`persisted cursor is for channel ${persisted.channel}, not ${s.opts.channelId}: re-baselining`);
  }
  // Threads we (or a previous process) already joined survive a restart.
  if (persisted.threads?.length) {
    s.threads = persisted.threads.slice(0, THREADS_CAP);
    log(`resuming ${s.threads.length} remembered thread(s) for in-thread follow-ups`);
  }
  await seedThreadsFromHistory(s);
  await pollOnce();
  if (!s.running) return;
  s.timer = setInterval(() => {
    void pollOnce();
  }, s.opts.intervalMs);
  // unref: the bridge must never be the reason this process cannot exit.
  s.timer.unref?.();
  log(`polling every ${s.opts.intervalMs}ms (interval is unref'd, so it never keeps the process alive)`);
}

// ── Socket Mode transport ─────────────────────────────────────────────────

function wsCtor(): (new (url: string) => WsLike) | undefined {
  const g = globalThis as unknown as { WebSocket?: new (url: string) => WsLike };
  return typeof g.WebSocket === "function" ? g.WebSocket : undefined;
}

async function openConnectionUrl(s: BridgeState): Promise<{ url?: string; error?: string }> {
  const r = await slackApi("apps.connections.open", {}, s.opts.appToken, "POST");
  if (!r.ok) return { error: r.error ?? "unknown error" };
  const url = typeof r.data.url === "string" ? r.data.url : "";
  return url ? { url } : { error: "apps.connections.open returned ok with no url" };
}

function scheduleReconnect(s: BridgeState, reason: string): void {
  if (!s.running || s.socketStopped || s.transport !== "socket") return;
  // Repeated failures to ever connect: stop pretending and use the fallback.
  if (!s.socketEverConnected && s.reconnects + 1 >= MAX_CONNECT_ATTEMPTS && s.opts.botToken && s.opts.channelId) {
    log(`socket mode never connected after ${s.reconnects + 1} attempt(s) (${reason}); switching to the polling fallback`);
    void initPoll(s);
    return;
  }
  s.reconnects++;
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(s.reconnectAttempt, 5));
  const jitter = Math.floor(Math.random() * RECONNECT_JITTER_MS);
  const delay = base + jitter;
  s.reconnectAttempt++;
  log(`reconnect #${s.reconnects} in ${delay}ms (${reason})`);
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  s.reconnectTimer = setTimeout(() => {
    s.reconnectTimer = null;
    void connectSocket(s);
  }, delay);
  s.reconnectTimer.unref?.();
}

function ackEnvelope(s: BridgeState, envelopeId: string): boolean {
  try {
    if (!s.socket) return false;
    s.socket.send(JSON.stringify({ envelope_id: envelopeId }));
    s.acks++;
    log(`acked envelope_id=${envelopeId} (acks total ${s.acks})`);
    return true;
  } catch (e) {
    noteError(`ack failed for envelope_id=${envelopeId}: ${errText(e)}`);
    return false;
  }
}

/**
 * One Socket Mode frame. Slack redelivers anything not acked within ~3 seconds,
 * so the ack happens FIRST, before any handling.
 */
async function handleFrame(frame: unknown): Promise<{ action: "ack" | "ignored" | "handled"; acked: boolean; type: string; outcome?: InboundOutcome }> {
  const s = requireState();
  if (!frame || typeof frame !== "object") {
    log("ignored a socket frame that was not an object");
    return { action: "ignored", acked: false, type: "" };
  }
  const f = frame as Record<string, unknown>;
  const type = typeof f.type === "string" ? f.type : "";
  const envelopeId = typeof f.envelope_id === "string" ? f.envelope_id : "";
  const acked = envelopeId ? ackEnvelope(s, envelopeId) : false;

  if (type === "hello") {
    s.socketState = "hello";
    s.socketEverConnected = true;
    if (s.connectTimer) {
      clearTimeout(s.connectTimer);
      s.connectTimer = null;
    }
    const count = typeof f.num_connections === "number" ? f.num_connections : undefined;
    log(`hello envelope received: socket is ready${count === undefined ? "" : ` (num_connections=${count})`}`);
    return { action: "ack", acked, type };
  }
  if (type === "disconnect") {
    log(`disconnect envelope (reason=${String(f.reason ?? "unknown")}); Slack will be reconnected`);
    s.socketState = "disconnected";
    try {
      s.socket?.close();
    } catch {
      // close is best effort
    }
    return { action: "ack", acked, type };
  }
  if (type !== "events_api") {
    log(`ignored envelope type="${type || "(none)"}"${acked ? " (acked anyway)" : ""}`);
    return { action: "ack", acked, type };
  }

  const payload = f.payload as Record<string, unknown> | undefined;
  const event = payload?.event as SlackMessage | undefined;
  if (!event || typeof event !== "object") {
    log("events_api envelope carried no event (acked, nothing to do)");
    return { action: "ack", acked, type };
  }
  const outcome = await processMessage(event);
  return { action: "handled", acked, type, outcome };
}

async function connectSocket(s: BridgeState): Promise<void> {
  if (!s.running || s.socketStopped || s.transport !== "socket") return;
  if (!s.opts.appToken) {
    log("socket mode requested but no app token is configured: using the polling fallback");
    await initPoll(s);
    return;
  }
  const Ctor = wsCtor();
  if (!Ctor) {
    log("no global WebSocket in this Node runtime (needs Node >= 22): using the polling fallback");
    if (s.opts.botToken && s.opts.channelId) await initPoll(s);
    else s.running = false;
    return;
  }

  const open = await openConnectionUrl(s);
  if (!open.url) {
    const detail = open.error ?? "unknown error";
    noteError(`apps.connections.open failed: ${detail}`);
    if (PERMANENT_APP_TOKEN_ERRORS.has(detail)) {
      log(`that error is permanent for this app token, so socket mode is abandoned: falling back to polling`);
      if (s.opts.botToken && s.opts.channelId) await initPoll(s);
      else {
        log("no bot token/channel to poll with either: the bridge stays idle");
        s.running = false;
      }
      return;
    }
    scheduleReconnect(s, `apps.connections.open ${detail}`);
    return;
  }
  log(`apps.connections.open ok: wss url received (host=${open.url.split("?")[0].replace(/^wss:\/\//, "")})`);

  let ws: WsLike;
  try {
    ws = new Ctor(open.url);
  } catch (e) {
    noteError(`could not open the WebSocket: ${errText(e)}`);
    scheduleReconnect(s, `socket construction failed`);
    return;
  }
  s.socket = ws;
  s.socketState = "connecting";

  // Bound the handshake: without this a stalled WSS connect leaves the bridge in
  // "connecting" forever while the CEO's messages go nowhere.
  if (s.connectTimer) clearTimeout(s.connectTimer);
  s.connectTimer = setTimeout(() => {
    s.connectTimer = null;
    if (s.socketState === "open" || s.socketState === "hello") return;
    noteError(`socket handshake did not complete within ${CONNECT_TIMEOUT_MS}ms; retrying`);
    try {
      ws.close();
    } catch {
      // close is best effort; the close handler (or the next attempt) recovers
    }
  }, CONNECT_TIMEOUT_MS);
  s.connectTimer.unref?.();

  ws.addEventListener("open", () => {
    s.socketState = "open";
    s.reconnectAttempt = 0;
    log("socket open; waiting for the hello envelope");
  });
  ws.addEventListener("message", (ev) => {
    const data = (ev as { data?: unknown })?.data;
    const rawText = typeof data === "string" ? data : "";
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      log("ignored a socket frame that was not JSON");
      return;
    }
    void handleFrame(parsed).catch((e) => noteError(`frame handling crashed (continuing): ${errText(e)}`));
  });
  ws.addEventListener("error", (ev) => {
    // A socket we closed ourselves (stop/shutdown, or a disconnect envelope) fires
    // error/close during teardown; that is expected and must not look like a fault.
    if (s.socketStopped || !s.running) return;
    s.socketState = "error";
    const detail = ev as { error?: unknown; message?: unknown };
    const inner = detail?.error instanceof Error ? detail.error.message : typeof detail?.message === "string" ? detail.message : "";
    noteError(`socket error: ${inner || errText(ev)}`);
  });
  ws.addEventListener("close", (ev) => {
    s.socket = null;
    const code = (ev as { code?: unknown })?.code;
    const reason = (ev as { reason?: unknown })?.reason;
    if (s.socketStopped || !s.running) {
      s.socketState = "stopped";
      return;
    }
    s.socketState = "closed";
    log(`socket closed by Slack (code=${typeof code === "number" ? code : "?"}${typeof reason === "string" && reason ? `, reason=${reason}` : ""})`);
    if (s.transport === "socket") scheduleReconnect(s, "socket closed by Slack");
  });
}

async function initSocket(s: BridgeState): Promise<void> {
  s.transport = "socket";
  await resolveBotUserId(s);
  await connectSocket(s);
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Start the inbound bridge. Synchronous, never throws, safe to call twice.
 * Picks Socket Mode when an app token is configured, otherwise the polling
 * fallback; with neither it logs one line and does nothing.
 */
export function startSlackInbound(over: SlackInboundOptions = {}): InboundStatus {
  try {
    if (state?.running) {
      log("startSlackInbound() called while already running: no-op");
      return inboundStatus();
    }
    const opts = resolveOptions(over);
    const { transport, why } = selectTransport(opts);
    state = newState(opts, transport);
    if (transport === "off") {
      state.running = false;
      log(`bridge disabled: ${why}`);
      return inboundStatus();
    }
    state.running = true;
    log(`transport=${transport}: ${why}`);
    startTaskReporter(state);
    const init = transport === "socket" ? initSocket(state) : initPoll(state);
    state.initPromise = init.catch((e) => {
      const detail = redactSecrets(clip(errText(e), 240));
      state!.lastError = detail;
      log(`transport init failed (the router is unaffected): ${detail}`);
    });
    return inboundStatus();
  } catch (e) {
    // startSlackInbound is called from src/server.ts: it must never break boot.
    console.error(`[slack-inbound] start failed (router continues): ${errText(e)}`);
    return inboundStatus();
  }
}

/** Stop both transports: clears the poll interval and closes any socket. */
export function stopSlackInbound(): InboundStatus {
  const s = state;
  if (!s) return inboundStatus();
  s.running = false;
  s.socketStopped = true;
  if (s.timer) {
    clearInterval(s.timer);
    s.timer = null;
  }
  if (s.reportTimer) {
    clearInterval(s.reportTimer);
    s.reportTimer = null;
  }
  if (s.reconnectTimer) {
    clearTimeout(s.reconnectTimer);
    s.reconnectTimer = null;
  }
  if (s.connectTimer) {
    clearTimeout(s.connectTimer);
    s.connectTimer = null;
  }
  const hadSocket = !!s.socket;
  try {
    s.socket?.close();
  } catch {
    // closing is best effort
  }
  s.socket = null;
  s.socketState = s.transport === "socket" ? "stopped" : "n/a";
  log(`stopped (poll interval cleared${hadSocket ? ", socket closed" : ""})`);
  return inboundStatus();
}

export function inboundStatus(): InboundStatus {
  const s = state;
  if (!s) {
    return {
      transport: "off",
      running: false,
      channel: null,
      appTokenPresent: false,
      botTokenPresent: false,
      socketState: "not started",
      botUserId: null,
      lastTs: null,
      baselineDone: false,
      intervalMs: DEFAULT_INTERVAL_MS,
      polls: 0,
      received: 0,
      handled: 0,
      skipped: 0,
      replies: 0,
      deduped: 0,
      acks: 0,
      reconnects: 0,
      recentLog: [],
    };
  }
  return {
    transport: s.transport,
    running: s.running,
    channel: s.opts.channelId || null,
    appTokenPresent: !!s.opts.appToken,
    botTokenPresent: !!s.opts.botToken,
    socketState: s.socketState,
    botUserId: s.botUserId || null,
    lastTs: s.lastTs,
    baselineDone: s.baselineDone,
    intervalMs: s.opts.intervalMs,
    polls: s.polls,
    received: s.received,
    handled: s.handled,
    skipped: s.skipped,
    replies: s.replies,
    deduped: s.deduped,
    acks: s.acks,
    reconnects: s.reconnects,
    ...(s.lastError ? { lastError: s.lastError } : {}),
    recentLog: s.logLines.slice(-25),
  };
}

// ── Test / ops entry points ───────────────────────────────────────────────
// These exist so the inbound path can be driven without a human typing in
// Slack. They route through processMessage(), i.e. exactly the same code the
// poller and the socket use - no test-only branch inside the handler.

function ensureStateForTests(over: SlackInboundOptions = {}): BridgeState {
  // Reuse whatever state exists (a running transport, or the state a previous test
  // hook created) so cross-call behaviour like the dedupe set is observable. Each
  // CLI mode runs in its own process, so tests never leak into each other.
  if (state) return state;
  const opts = resolveOptions(over);
  const { transport } = selectTransport(opts);
  state = newState(opts, transport === "off" ? "off" : "poll");
  return state;
}

/** Drop the in-process bridge state (ops/tests only). */
export function __testResetState(): void {
  state = null;
}

/**
 * Run one synthetic CEO message through the real path: the same guard, the same
 * assistantMessage() call, the same threaded Slack post. `ts` should be a REAL
 * Slack message ts (Slack rejects a thread_ts it has never seen).
 */
/** Test hook: record a synthetic dispatch result without calling the assistant. */
export function __testRecordDispatched(
  result: AssistantResult,
  threadTs: string,
  over: SlackInboundOptions = {},
): void {
  const s = state ?? newState(resolveOptions(over), "off");
  recordDispatchedTasks(s, result, threadTs);
}

/** Test hook: run exactly one report-back pass; returns how many reports were posted. */
export async function __testReportOnce(over: SlackInboundOptions = {}): Promise<number> {
  const s = state ?? newState(resolveOptions(over), "off");
  return reportFinishedTasks(s);
}

/** Test hook: where the task->thread map for these options lives. */
export function __testTaskThreadsFile(over: SlackInboundOptions = {}): string {
  const s = state ?? newState(resolveOptions(over), "off");
  return taskThreadsFile(s);
}

export async function __testHandleIncoming(text: string, ts: string, over: SlackInboundOptions = {}): Promise<InboundOutcome> {
  const s = ensureStateForTests(over);
  return processMessage({ ts, text, user: s.opts.testUser, type: "message" });
}

/** Feed a RAW message object (e.g. one the bot itself posted) through the guard. */
export async function __testHandleMessage(raw: SlackMessage, over: SlackInboundOptions = {}): Promise<InboundOutcome> {
  ensureStateForTests(over);
  return processMessage(raw);
}

/** Feed a raw Socket Mode envelope through the frame handler (ack included). */
export async function __testHandleEnvelope(
  envelope: unknown,
  over: SlackInboundOptions = {},
): Promise<{ action: string; acked: boolean; type: string; outcome?: InboundOutcome }> {
  ensureStateForTests(over);
  return handleFrame(envelope);
}

/** Start a transport and wait for its init (baseline / socket connect) to settle. */
export async function __testStartAndWait(over: SlackInboundOptions = {}): Promise<InboundStatus> {
  const s = startSlackInbound(over);
  await (state?.initPromise ?? Promise.resolve());
  return s.running ? inboundStatus() : s;
}

/** Force one poll tick (used to prove the baseline leaves history untouched). */
export async function __testPollOnce(over: SlackInboundOptions = {}): Promise<number> {
  ensureStateForTests(over);
  return pollOnce();
}

export function __testLog(lines = 40): string[] {
  return (state?.logLines ?? []).slice(-lines);
}

/**
 * The pure loop guard, exposed for verification: returns the skip reason for a
 * message, or null when it would be handed to the assistant. Lets the guard be
 * asserted for every shape without spending a model call.
 */
export function __testIgnoreReason(raw: SlackMessage, over: SlackInboundOptions = {}): string | null {
  return ignoreReason(ensureStateForTests(over), raw);
}

// ── CLI (ops / verification) ──────────────────────────────────────────────
//   node_modules/.bin/tsx --env-file=.env src/company/slackInbound.ts --test
// Modes: --test | --guard-test | --baseline-test | --no-config-test |
//        --socket-test | --transport | --status

// Flags that are not the mode selector.
const PASSTHROUGH_FLAGS = new Set([
  "--channel",
  "--seconds",
  "--no-app-token",
  "--socket-off",
  "--socket-on",
  "--post-probe",
  "--help",
  "-h",
]);

function usageText(): string {
  return [
    "Usage: tsx [--env-file=.env] src/company/slackInbound.ts <mode> [--channel ID] [--seconds N]",
    "",
    "  --test            post a labelled synthetic 'CEO' message, run it through the real inbound",
    "                    path (assistant + threaded reply) and print the reply ts",
    "  --guard-test      fetch the newest message the BOT itself posted and prove the loop guard skips it",
    "  --baseline-test   start the polling fallback against history and prove old messages are not replayed",
    "  --no-config-test  start the bridge with empty credentials and prove it no-ops without throwing",
    "  --socket-test     start Socket Mode (needs SLACK_APP_TOKEN) and print connect/hello/ack evidence",
    "                    add --post-probe to post a bot message and watch Slack push it back",
    "  --envelope-test   feed a synthetic events_api envelope whose event has bot_id (loop-guard proof)",
    "  --guard-matrix    assert every loop-guard shape (bot_id, subtype, own user, empty, test strings,",
    "                    wrong channel, dedupe) without spending a model call",
    "  --transport       print which transport would be selected, then start+stop it",
    "  --status          print inboundStatus() JSON",
    "",
    "  --channel ID      override SLACK_CHANNEL_ID for this run only",
    "  --seconds N       how long --socket-test stays connected (default 15)",
    "  --no-app-token    ops/test only: pretend SLACK_APP_TOKEN is absent (forces the polling fallback)",
    "  --socket-off      ops/test only: force SLACK_SOCKET_MODE=0",
    "  --socket-on       ops/test only: force SLACK_SOCKET_MODE=1",
  ].join("\n");
}

function isEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return path.resolve(argv1) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

async function slackApiRaw(method: string, payload: Record<string, string | number | boolean>, token: string, httpMethod: "GET" | "POST" = "GET") {
  return slackApi(method, payload, token, httpMethod);
}

async function cliMain(argv: string[]): Promise<void> {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const valueOf = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1]?.trim() : undefined;
  };
  const channel = valueOf("--channel");
  const over: SlackInboundOptions = { ...(channel ? { channelId: channel } : {}) };
  // Test/ops only: pretend the app token is absent, so the polling fallback can be
  // demonstrated on a machine whose .env does have one (a cmd `set VAR=` does not
  // beat Node's --env-file, and .env must never be edited for a test).
  if (flags.has("--no-app-token")) over.appToken = "";
  if (flags.has("--socket-off")) over.socketMode = false;
  if (flags.has("--socket-on")) over.socketMode = true;
  const seconds = Number(valueOf("--seconds") ?? "15") || 15;
  const mode = [...flags].find((f) => !PASSTHROUGH_FLAGS.has(f)) ?? "--status";

  if (flags.has("--help") || flags.has("-h")) {
    console.log(usageText());
    return;
  }

  // A stable temp state file keeps the ops runs from touching the live cursor.
  const tmpState = path.join(process.env.TEMP ?? process.env.TMP ?? ".", "slack-inbound-ops-test.json");

  if (mode === "--test") {
    const st = startSlackInbound({ ...over, stateFile: tmpState });
    console.log(`[cli] transport=${st.transport} channel=${st.channel ?? "(none)"} botTokenPresent=${st.botTokenPresent}`);
    const opts = resolveOptions(over);
    if (!opts.botToken || !opts.channelId) {
      console.log("[cli] no bot token/channel available: cannot post the synthetic message (expected with empty credentials)");
      return;
    }
    const label = `[bridge-selftest] synthetic inbound test from src/company/slackInbound.ts at ${new Date().toISOString()}. Not a human message; the reply below is threaded and automated.`;
    const parent = await slackApiRaw("chat.postMessage", { channel: opts.channelId, text: label, unfurl_links: false }, opts.botToken, "POST");
    if (!parent.ok) {
      console.log(`[cli] could not post the synthetic parent message: ${parent.error}`);
      return;
    }
    const parentTs = typeof parent.data.ts === "string" ? parent.data.ts : "";
    console.log(`[cli] synthetic message posted: ts=${parentTs}`);

    const question = "Status report only, no action needed: what work has been completed across the projects so far, and what is still in progress? Do not create or dispatch any tasks.";
    const outcome = await __testHandleIncoming(question, parentTs, { ...over, stateFile: tmpState, autoRun: false });
    console.log(`[cli] outcome=${JSON.stringify({ skipped: outcome.skipped, reason: outcome.reason, assistantCalled: outcome.assistantCalled, replied: outcome.replied, replyTs: outcome.replyTs, chunks: outcome.chunks })}`);
    console.log(`[cli] assistant reply text:\n----\n${outcome.reply ?? "(none)"}\n----`);
    if (outcome.replyTs && outcome.replyTs !== parentTs) {
      console.log(`[cli] PASS: threaded reply landed with its own ts=${outcome.replyTs} (parent=${parentTs})`);
    } else {
      console.log(`[cli] FAIL: no distinct reply ts (replied=${outcome.replied}, error=${outcome.error ?? "none"})`);
      process.exitCode = 1;
    }
    // A live transport (the Socket Mode socket especially) is an active handle that
    // would keep this CLI process alive forever; stop it so the run exits cleanly.
    stopSlackInbound();
    return;
  }

  if (mode === "--guard-test") {
    const opts = resolveOptions(over);
    if (!opts.botToken || !opts.channelId) {
      console.log("[cli] no bot token/channel available: cannot fetch a bot message (expected with empty credentials)");
      return;
    }
    const hist = await slackApiRaw("conversations.history", { channel: opts.channelId, limit: 30 }, opts.botToken);
    if (!hist.ok) {
      console.log(`[cli] conversations.history failed: ${hist.error}`);
      process.exitCode = 1;
      return;
    }
    const botMsg = normalizeMessages(hist.data.messages).find((m) => !!m.bot_id);
    if (!botMsg) {
      console.log("[cli] no bot-posted message found in history to test the guard with");
      process.exitCode = 1;
      return;
    }
    console.log(`[cli] raw Slack message chosen: ${JSON.stringify({ ts: botMsg.ts, bot_id: botMsg.bot_id, user: botMsg.user ?? null, subtype: botMsg.subtype ?? null, username: "<omitted>", text: clip(botMsg.text, 50) })}`);
    const outcome = await __testHandleMessage(botMsg, { ...over, stateFile: tmpState });
    console.log(`[cli] outcome=${JSON.stringify(outcome)}`);
    if (outcome.skipped && !outcome.assistantCalled && !outcome.replied) {
      console.log(`[cli] PASS: loop guard skipped the bot's own message (reason: ${outcome.reason}) with no assistant call and no reply`);
    } else {
      console.log("[cli] FAIL: the bot's own message was NOT skipped");
      process.exitCode = 1;
    }
    return;
  }

  if (mode === "--baseline-test") {
    try {
      fs.rmSync(tmpState, { force: true });
    } catch {
      // ignore
    }
    const st = await __testStartAndWait({ ...over, stateFile: tmpState, intervalMs: 60_000 });
    console.log(`[cli] started: transport=${st.transport} baselineDone=${st.baselineDone} lastTs=${st.lastTs ?? "(none)"}`);
    const handledFirst = await __testPollOnce({ ...over, stateFile: tmpState });
    await new Promise((r) => setTimeout(r, 300));
    const handledSecond = await __testPollOnce({ ...over, stateFile: tmpState });
    console.log(`[cli] forced poll ticks handled ${handledFirst} then ${handledSecond} message(s)`);
    console.log(`[cli] persisted cursor: ${JSON.stringify(readStateFile(tmpState))}`);
    const after = inboundStatus();
    console.log(`[cli] counters: received=${after.received} handled=${after.handled} skipped=${after.skipped} replies=${after.replies}`);
    console.log("[cli] pass criteria: baselineDone=true, handled=0, replies=0 (old history was not replayed)");
    if (after.baselineDone && after.handled === 0 && after.replies === 0) {
      console.log("[cli] PASS");
    } else {
      console.log("[cli] FAIL");
      process.exitCode = 1;
    }
    stopSlackInbound();
    return;
  }

  if (mode === "--no-config-test") {
    let threw = false;
    let status: InboundStatus | null = null;
    try {
      status = startSlackInbound({ botToken: "", appToken: "", channelId: "", stateFile: tmpState });
    } catch (e) {
      threw = true;
      console.log(`[cli] THREW: ${String(e)}`);
    }
    console.log(`[cli] status=${JSON.stringify({ transport: status?.transport, running: status?.running, channel: status?.channel })}`);
    console.log(`[cli] log tail: ${JSON.stringify(__testLog(3))}`);
    if (!threw && status?.transport === "off" && status.running === false) {
      console.log("[cli] PASS: empty credentials -> no-op, no throw");
    } else {
      console.log("[cli] FAIL");
      process.exitCode = 1;
    }
    return;
  }

  if (mode === "--socket-test") {
    const opts = resolveOptions(over);
    console.log(`[cli] app token present=${!!opts.appToken} (len=${opts.appToken.length}), bot token present=${!!opts.botToken}, channel=${opts.channelId || "(none)"}`);
    if (opts.appToken) {
      const probe = await slackApiRaw("apps.connections.open", {}, opts.appToken, "POST");
      console.log(`[cli] apps.connections.open -> ok=${probe.ok} error=${probe.error ?? "none"} urlHost=${typeof probe.data.url === "string" ? probe.data.url.split("?")[0] : "(none)"}`);
    } else {
      // Honest negative: the endpoint is reachable, but this token type is wrong
      // for it. Slack's exact error is printed as-is.
      const probe = await slackApiRaw("apps.connections.open", {}, opts.botToken, "POST");
      console.log(`[cli] no SLACK_APP_TOKEN: apps.connections.open called with the BOT token for reference -> ok=${probe.ok} error=${probe.error ?? "none"}`);
    }
    const st = await __testStartAndWait({ ...over, socketMode: true, stateFile: tmpState });
    console.log(`[cli] status after init: ${JSON.stringify({ transport: st.transport, running: st.running, socketState: st.socketState, acks: st.acks, reconnects: st.reconnects, lastError: st.lastError })}`);
    await new Promise((r) => setTimeout(r, 3000));

    // Optional live-envelope exercise: post a labelled message with the BOT token
    // while the socket is connected. Slack pushes it back as an events_api
    // envelope, which proves acking + the loop guard on a REAL envelope.
    if (flags.has("--post-probe") && opts.botToken && opts.channelId) {
      const posted = await slackApiRaw(
        "chat.postMessage",
        { channel: opts.channelId, text: `[bridge-selftest] socket-mode probe from src/company/slackInbound.ts at ${new Date().toISOString()}. Bot-authored, so the bridge must ack it and then IGNORE it.`, unfurl_links: false },
        opts.botToken,
        "POST",
      );
      console.log(`[cli] probe message posted with the bot token: ok=${posted.ok} ts=${typeof posted.data.ts === "string" ? posted.data.ts : "?"} error=${posted.error ?? "none"}`);
    }

    console.log(`[cli] waiting for socket envelopes (${seconds}s)...`);
    await new Promise((r) => setTimeout(r, seconds * 1000));
    const after = inboundStatus();
    console.log(`[cli] after ${seconds}s: ${JSON.stringify({ transport: after.transport, socketState: after.socketState, acks: after.acks, reconnects: after.reconnects, received: after.received, handled: after.handled, skipped: after.skipped, replies: after.replies, lastError: after.lastError })}`);
    console.log(`[cli] log tail:\n${__testLog(20).join("\n")}`);
    stopSlackInbound();
    return;
  }

  if (mode === "--envelope-test") {
    // A synthetic Socket Mode envelope whose event carries bot_id: the guard must
    // drop it with no assistant call and no reply. The ack is attempted too, but a
    // synthetic envelope has no live socket, so acking is only truly exercised by
    // --socket-test --post-probe against a real Slack push.
    const synth = {
      type: "events_api",
      envelope_id: "synth-envelope-0001",
      payload: {
        event: {
          type: "message",
          bot_id: "B0C4RDKKGQN",
          channel: resolveOptions(over).channelId || "C0C4BVBG5N3",
          ts: "1790682999.000001",
          text: "synthetic envelope whose event has bot_id set; must be ignored",
        },
      },
    };
    const res = await __testHandleEnvelope(synth, { ...over, stateFile: tmpState, botUserId: "U0C5MNR162U" });
    console.log(`[cli] envelope result: ${JSON.stringify(res)}`);
    if (res.outcome?.skipped && !res.outcome.assistantCalled && !res.outcome.replied) {
      console.log(`[cli] PASS: socket-mode loop guard ignored the envelope (reason: ${res.outcome.reason})`);
    } else {
      console.log("[cli] FAIL: the synthetic bot envelope was NOT ignored");
      process.exitCode = 1;
    }
    // A genuine CEO envelope through the same frame handler proves the handler
    // itself is reachable and would call the assistant (not run here: it would
    // spend real budget), so only the guard path is asserted above.
    return;
  }

  if (mode === "--guard-matrix") {
    // Every shape the loop guard has to catch, asserted without spending a model
    // call (only the envelope case touches the real handler, and it is a bot one).
    const cfg = resolveOptions(over);
    const botUser = cfg.botUserId || "U0C5MNR162U";
    const chan = cfg.channelId || "C0C4BVBG5N3";
    const guardOver: SlackInboundOptions = { ...over, stateFile: tmpState, botUserId: botUser };
    const cases: Array<{ name: string; msg: SlackMessage; expectSkip: boolean }> = [
      { name: "human message (must be handled)", msg: { ts: "1790683001.000001", user: "U0ADITYA01", channel: chan, text: "what work is done?" }, expectSkip: false },
      { name: "bot_id present (the bot's own post)", msg: { ts: "1790683001.000002", bot_id: "B0C4RDKKGQN", channel: chan, text: "status report" }, expectSkip: true },
      { name: "subtype set (message_changed)", msg: { ts: "1790683001.000003", user: "U0ADITYA01", subtype: "message_changed", channel: chan, text: "edited" }, expectSkip: true },
      { name: "user is our own bot user id", msg: { ts: "1790683001.000004", user: botUser, channel: chan, text: "hello" }, expectSkip: true },
      { name: "empty text", msg: { ts: "1790683001.000005", user: "U0ADITYA01", channel: chan, text: "" }, expectSkip: true },
      { name: "bot mention only", msg: { ts: "1790683001.000006", user: "U0ADITYA01", channel: chan, text: `<@${botUser}>` }, expectSkip: true },
      { name: "collector test string (slack-test:)", msg: { ts: "1790683001.000007", user: "U0ADITYA01", channel: chan, text: "slack-test: mirror smoke test" }, expectSkip: true },
      { name: "collector test string (collector:)", msg: { ts: "1790683001.000008", user: "U0ADITYA01", channel: chan, text: "collector: notes" }, expectSkip: true },
      { name: "collector test string (post-reinstall check)", msg: { ts: "1790683001.000009", user: "U0ADITYA01", channel: chan, text: "post-reinstall check" }, expectSkip: true },
      { name: "different channel", msg: { ts: "1790683001.000010", user: "U0ADITYA01", channel: "C0OTHERCHAN", text: "hello" }, expectSkip: true },
      { name: "a mention in front of real text (must be handled)", msg: { ts: "1790683001.000011", user: "U0ADITYA01", channel: chan, text: `<@${botUser}> please summarise` }, expectSkip: false },
    ];
    let failed = 0;
    for (const c of cases) {
      const reason = __testIgnoreReason(c.msg, guardOver);
      const skipped = reason !== null;
      const ok = skipped === c.expectSkip;
      if (!ok) failed++;
      console.log(`[cli] ${ok ? "PASS" : "FAIL"}  ${c.name} -> ${skipped ? `skipped (${reason})` : "handled"}`);
    }
    // Dedupe: the same ts twice must be handled once and skipped the second time.
    const dupOver: SlackInboundOptions = { ...guardOver };
    ensureStateForTests(dupOver);
    const dupMsg: SlackMessage = { ts: "1790683002.000001", user: "U0ADITYA01", channel: chan, text: "slack-test: dedupe probe" };
    const first = await __testHandleMessage(dupMsg, dupOver);
    const second = await __testHandleMessage(dupMsg, dupOver);
    const dedupeOk = first.skipped && second.skipped && /duplicate ts/.test(second.reason ?? "");
    if (!dedupeOk) failed++;
    console.log(`[cli] ${dedupeOk ? "PASS" : "FAIL"}  dedupe set: first=${first.reason ?? "handled"} second=${second.reason ?? "handled"}`);
    console.log(`[cli] guard matrix: ${cases.length + 1 - failed}/${cases.length + 1} passed (no model calls, nothing posted)`);
    if (failed) process.exitCode = 1;
    return;
  }

  if (mode === "--transport") {
    const st = startSlackInbound({ ...over, stateFile: tmpState });
    await (state?.initPromise ?? Promise.resolve());
    console.log(`[cli] ${JSON.stringify({ transport: st.transport, running: st.running, channel: st.channel, appTokenPresent: st.appTokenPresent, botTokenPresent: st.botTokenPresent })}`);
    console.log(`[cli] log tail:\n${__testLog(6).join("\n")}`);
    stopSlackInbound();
    return;
  }

  // default: --status
  console.log(JSON.stringify(inboundStatus(), null, 2));
}

if (isEntryPoint()) {
  void cliMain(process.argv.slice(2))
    .catch((e) => {
      console.error(`[slack-inbound] cli failed: ${errText(e)}`);
      process.exitCode = 1;
    })
    .finally(() => {
      // Whatever mode ran, never leave a poll interval or a socket behind: the
      // process must be able to exit. (Reactivating the bridge is a server job.)
      try {
        if (state?.running) stopSlackInbound();
      } catch {
        // ignore
      }
    });
}
