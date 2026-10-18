import { config } from "./config.js";
// AIR-GAP (PERF item 7): posts to Slack are outbound calls; AIR_GAPPED=1 blocks them.
import { airgappedBlock } from "./company/airGap.js";

// ---------------------------------------------------------------------------
// Slack mirror — humans read Slack, models never do.
//
// HARD RULES (see HANDOVER.md section 9):
//  - The bot token is NEVER printed, logged, returned or posted. Anything that
//    leaves this module goes through redact(), so a token that ever shows up in
//    pipeline text is stripped before it reaches Slack or the console.
//  - Every path is TOTAL: no token / no channel / MOCK_MODE / HTTP failure /
//    timeout / bad JSON all resolve to a value. postAs() never throws and never
//    returns a rejected promise, so a call site can do `void postAs(...)` and
//    still be safe if the pipeline forgets `.catch()`.
//  - The HTTP call is bounded by AbortSignal.timeout(REQUEST_TIMEOUT_MS) so
//    Slack can never wedge a pipeline stage.
// ---------------------------------------------------------------------------

const SLACK_API = "https://slack.com/api/chat.postMessage";
const REQUEST_TIMEOUT_MS = 10_000;
const CHUNK_CHARS = 3400;
// A single logical message never fans out to more than this many posts (Slack
// rate-limits bursts and the mirror must not be able to spam a channel).
const MAX_CHUNKS = 8;

// Slack credential shapes we must never emit anywhere.
const TOKEN_RE = /xox[abpors]-[A-Za-z0-9-]{6,}|xapp-[A-Za-z0-9-]{6,}/g;
const REDACTED = "[redacted-token]";

let lastError: string | undefined;

function token(): string {
  const t = config.slackBotToken;
  return typeof t === "string" ? t.trim() : "";
}

function channel(): string | null {
  const c = config.slackChannelId;
  const trimmed = typeof c === "string" ? c.trim() : "";
  return trimmed ? trimmed : null;
}

function forcedMock(): boolean {
  return !!config.mockMode;
}

// Strip anything that looks like a Slack credential, plus the exact configured
// token, before the text is posted or printed.
export function redactSecrets(text: string): string {
  let out = String(text ?? "").replace(TOKEN_RE, REDACTED);
  const t = token();
  if (t.length >= 8) out = out.split(t).join(REDACTED);
  return out;
}

export function slackEnabled(): boolean {
  return !!(token() && channel());
}

export type SlackMode = "live" | "mock";

export type SlackStatus = {
  configured: boolean;
  channel: string | null;
  mode: SlackMode;
  lastError?: string;
};

// Module-level health snapshot for ops (/health, ops/slack-test.ts). The token
// itself is NEVER part of this shape - only whether it is present.
export function slackStatus(): SlackStatus {
  const ch = channel();
  const configured = !!token() && !!ch;
  const status: SlackStatus = {
    configured,
    channel: ch,
    mode: configured && !forcedMock() ? "live" : "mock",
  };
  if (lastError) status.lastError = lastError;
  return status;
}

export type Persona =
  | "OPUS_MANAGER"
  | "SONNET_LEAD"
  | "KIMI_CODER"
  | "GLM_ROUTINE"
  | "DEEPSEEK_STANDARD"
  | "QWEN_CONTEXT"
  | "MUSE_FALLBACK"
  | "LAYA_QA"
  | "ASSISTANT_CHIEF";

const PERSONA_STYLE: Record<Persona, { username: string; icon: string }> = {
  OPUS_MANAGER: { username: "Opus (Manager)", icon: ":brain:" },
  SONNET_LEAD: { username: "Sonnet (Tech Lead)", icon: ":compass:" },
  KIMI_CODER: { username: "Kimi (Coder)", icon: ":hammer:" },
  GLM_ROUTINE: { username: "GLM (Routine)", icon: ":zap:" },
  DEEPSEEK_STANDARD: { username: "DeepSeek (Standard)", icon: ":gear:" },
  QWEN_CONTEXT: { username: "Qwen (Context)", icon: ":books:" },
  MUSE_FALLBACK: { username: "Muse (Fallback)", icon: ":lifebuoy:" },
  LAYA_QA: { username: "Laya (QA)", icon: ":clipboard:" },
  ASSISTANT_CHIEF: { username: "Chief of Staff (Assistant)", icon: ":office:" },
};

function styleFor(persona: Persona): { username: string; icon: string } {
  return PERSONA_STYLE[persona] ?? PERSONA_STYLE.SONNET_LEAD;
}

export function personaForRoute(via: string, modelId: string): Persona {
  if (via === "claude-subscription") return modelId.toLowerCase().includes("opus") ? "OPUS_MANAGER" : "SONNET_LEAD";
  if (via === "muse") return "MUSE_FALLBACK";
  if (via === "qwen-messages") return "QWEN_CONTEXT";
  if (modelId.includes("kimi")) return "KIMI_CODER";
  if (modelId.includes("glm")) return "GLM_ROUTINE";
  if (modelId.includes("deepseek")) return "DEEPSEEK_STANDARD";
  return "GLM_ROUTINE";
}

function chunk(text: string, n = CHUNK_CHARS): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += n) out.push(text.slice(i, i + n));
  return out.length ? out : [""];
}

export type SlackPostResult = {
  posted: boolean;
  ts?: string;
  /** true when the message went to the console fallback instead of Slack. */
  mock?: boolean;
  /** why a mock/fallback happened, or the precise Slack error. Never a token. */
  error?: string;
};

function noteError(err: string): string {
  lastError = redactSecrets(err).slice(0, 300);
  return lastError;
}

// Clearly labelled console fallback: no token, no channel, or MOCK_MODE=1.
function mockPost(tag: string, preview: string, threadTs: string | undefined, reason: string): SlackPostResult {
  console.log(`[slack:mock] ${tag} (${reason}) ${redactSecrets(preview)}`);
  return { posted: false, mock: true, ts: threadTs ?? "mock-thread", error: reason };
}

function mockReason(): string {
  if (!token()) return "no SLACK_BOT_TOKEN configured - mock/console fallback";
  if (!channel()) return "no SLACK_CHANNEL_ID configured - mock/console fallback";
  return "MOCK_MODE=1 - mock/console fallback";
}

export async function notifySlack(text: string, opts?: { threadTs?: string }): Promise<SlackPostResult> {
  // AIR-GAP (PERF item 7): a Slack post is an outbound call. Air-gapped mode returns
  // the same console-fallback shape a misconfigured-Slack call already returns, so no
  // caller changes; the flag-off path is byte-for-byte what shipped before.
  if (airgappedBlock("slack", "slack chat.postMessage")) {
    return mockPost(`[${styleFor("SONNET_LEAD").username}]`, redactSecrets(String(text ?? "")).slice(0, 300), opts?.threadTs, "AIR_GAPPED=1 - Slack posting is an outbound call");
  }
  return postAs("SONNET_LEAD", text, opts?.threadTs);
}

export async function postAs(persona: Persona, text: string, threadTs?: string): Promise<SlackPostResult> {
  // AIR-GAP (PERF item 7): postAs is the one function that actually writes to Slack
  // (notifySlack delegates here). Gated at THIS level too so every persona caller is
  // covered, not just the notifySlack wrapper; the global fetch guard remains the
  // backstop for any fetch path added later.
  if (airgappedBlock("slack", `slack chat.postMessage as ${persona}`)) {
    return mockPost(`[${styleFor(persona).username}]`, redactSecrets(String(text ?? "")).slice(0, 300), threadTs, "AIR_GAPPED=1 - Slack posting is an outbound call");
  }
  try {
    const style = styleFor(persona);
    const tag = `[${style.username}]`;
    const body = redactSecrets(typeof text === "string" ? text : String(text ?? ""));
    if (forcedMock() || !slackEnabled()) return mockPost(tag, body.slice(0, 300), threadTs, mockReason());

    const tokenValue = token();
    const channelValue = channel()!;
    let ts = threadTs;
    try {
      const parts = chunk(body).slice(0, MAX_CHUNKS);
      for (const part of parts) {
        const res = await fetch(SLACK_API, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${tokenValue}` },
          body: JSON.stringify({
            channel: channelValue,
            text: `${style.icon} ${part}`,
            username: style.username,
            icon_emoji: style.icon,
            thread_ts: ts,
            unfurl_links: false,
          }),
          // Bound the call: Slack must never wedge a pipeline stage.
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const j = (await res.json().catch(() => null)) as { ok?: boolean; ts?: string; error?: string } | null;
        if (!j) {
          const msg = noteError(`Slack returned a non-JSON response (HTTP ${res.status})`);
          return { posted: false, ts, error: msg };
        }
        if (!j.ok) {
          const retryAfter = res.headers.get("retry-after");
          const detail = j.error === "ratelimited" && retryAfter ? `ratelimited (retry-after ${retryAfter}s)` : (j.error ?? `http_${res.status}`);
          const msg = noteError(`Slack rejected the post: ${detail}`);
          return { posted: false, ts, error: msg };
        }
        if (!ts) ts = j.ts;
      }
      lastError = undefined;
      return { posted: true, ts };
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      const raw =
        name === "TimeoutError" || name === "AbortError"
          ? `Slack did not answer within ${REQUEST_TIMEOUT_MS}ms (timed out; pipeline continues)`
          : `Slack request failed: ${String(e instanceof Error ? e.message : e)}`;
      const msg = noteError(raw);
      return { posted: false, ts, error: msg };
    }
  } catch (e) {
    // Belt and braces: postAs must never reject, whatever happens above.
    const msg = noteError(`Slack mirror failed: ${String(e instanceof Error ? e.message : e)}`);
    console.log(`[slack:mock] (${msg}) ${redactSecrets(String(text ?? "").slice(0, 300))}`);
    return { posted: false, mock: true, ts: threadTs ?? "mock-thread", error: msg };
  }
}

export function brainSummary(brain: string, modelId: string, taskCount: number, promptChars: number, truncated: boolean) {
  return `:brain: Brain=${brain} (${modelId}) | tasks=${taskCount} | prompt=${promptChars} chars${truncated ? " [TRUNCATED]" : ""}`;
}

// ---------------------------------------------------------------------------
// CEO-facing events. All of these are best effort: they return a resolved
// SlackPostResult and are meant to be called as `void notifyX(...)`.
// ---------------------------------------------------------------------------

export type GateKind = "intake" | "code" | "merge";

const GATE_LABEL: Record<GateKind, string> = {
  intake: "GATE 1 - intake approval",
  code: "GATE 2 - approve before code runs",
  merge: "GATE 3 - approve merge",
};

// The exact route that approves a gate (src/server.ts):
//   POST /company/projects/:id/tasks/:tid/approve-intake|approve-code|approve-merge
export function approveUrlPath(projectId: string, taskId: string, gate: GateKind): string {
  return `/company/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/approve-${gate}`;
}

function clip(text: unknown, max: number): string {
  const s = typeof text === "string" ? text : String(text ?? "");
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

/** A task reached a human gate: title + the exact approve URL path. */
export function notifyGate(
  gate: GateKind,
  input: { projectId: string; taskId: string; title: string; status?: string }
): Promise<SlackPostResult> {
  const path = approveUrlPath(input.projectId, input.taskId, gate);
  const text = [
    `:rotating_light: ${GATE_LABEL[gate]} - CEO action needed`,
    `Task: ${clip(input.title, 160)}`,
    `Project: ${input.projectId} | task: ${input.taskId}${input.status ? ` | status: ${input.status}` : ""}`,
    `Approve: POST ${path}`,
  ].join("\n");
  return postAs("OPUS_MANAGER", text);
}

/** A task reached `merged`. */
export function notifyMerged(input: { projectId: string; taskId: string; title: string; detail?: string }): Promise<SlackPostResult> {
  const text = [
    `:white_check_mark: MERGED - task ${input.taskId} is done`,
    `Task: ${clip(input.title, 160)}`,
    `Project: ${input.projectId}`,
    ...(input.detail ? [`Result: ${clip(input.detail, 400)}`] : []),
  ].join("\n");
  return postAs("LAYA_QA", text);
}

/** An agent was refused work because its budget is exhausted. */
export function notifyBudgetExhausted(input: {
  agentId: string;
  agentKey?: string;
  name?: string;
  role?: string;
  departmentName?: string;
  projectName?: string;
  requiredUsd?: number;
  remainingUsd?: number;
  taskTitle?: string;
  reason?: string;
}): Promise<SlackPostResult> {
  const usd = (n?: number) => (typeof n === "number" && isFinite(n) ? `$${n.toFixed(4)}` : "n/a");
  const who = [input.name, input.role].filter(Boolean).join(" / ") || input.agentId;
  const text = [
    `:warning: BUDGET EXHAUSTED - work refused`,
    `Agent: ${who}${input.departmentName ? ` (${input.departmentName})` : ""}`,
    `Wanted: ${usd(input.requiredUsd)} | remaining: ${usd(input.remainingUsd)}`,
    ...(input.projectName ? [`Project: ${input.projectName}`] : []),
    ...(input.taskTitle ? [`Requested: ${clip(input.taskTitle, 160)}`] : []),
    input.reason ? `Reason: ${clip(input.reason, 200)}` : `Action: raise this agent's allocation (POST /company/agents/:agentId/budget).`,
  ].join("\n");
  return postAs("SONNET_LEAD", text);
}

/** What the CEO's assistant just routed, and to which department. */
export function notifyAssistantDispatch(input: {
  reply?: string;
  plan?: Array<{ title?: string; departmentName?: string; role?: string }>;
  dispatched?: Array<{ projectId?: string; taskId?: string; title?: string; status?: string }>;
  decisions?: string[];
}): Promise<SlackPostResult> {
  const plan = Array.isArray(input.plan) ? input.plan.slice(0, 8) : [];
  const dispatched = Array.isArray(input.dispatched) ? input.dispatched : [];
  const lines: string[] = [`:office: Assistant dispatch summary`];
  if (input.reply) lines.push(`CEO's assistant: ${clip(input.reply, 300)}`);
  if (plan.length) {
    lines.push(`Routed ${plan.length} work order(s):`);
    for (const item of plan) {
      const landed = dispatched.find((d) => d.title === item.title);
      lines.push(
        `  - "${clip(item.title, 90)}" -> ${item.departmentName || "unassigned"} (${item.role || "coder"} track)` +
          (landed ? ` [task ${landed.taskId} @ ${landed.projectId}, ${landed.status}]` : " [not dispatched]")
      );
    }
  } else {
    lines.push("No work orders were planned (nothing dispatched).");
  }
  lines.push(`Dispatched: ${dispatched.length} of ${plan.length}`);
  const rejected = (input.decisions ?? []).filter((d) => /skip|exhaust|budget|unauthor|could not|no agent/i.test(d));
  for (const d of rejected.slice(0, 3)) lines.push(`  ! ${clip(d, 200)}`);
  return postAs("ASSISTANT_CHIEF", lines.join("\n"));
}
