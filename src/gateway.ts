import { config } from "./config.js";
import {
  deepseekDirectArmed,
  deepseekDirectModel,
  deepseekDirectPlan,
  deepseekOnlyModel,
  goBindingExhausted,
  directInCoolOff,
  markDirectCoolOff,
  markGoExhausted,
  recordDirectOutcome,
  recordGoOutcome,
  recordFallback,
  recordFailure,
} from "./company/deepseekDirect.js";

// Hosted-only gateway calls. One OPENCODE_API_KEY covers GLM / DeepSeek / Kimi / Qwen.

// A hung HTTP call must never wedge a pipeline stage again: every gateway request
// is bounded. 180s default, override with JCODE_GATEWAY_TIMEOUT_SECONDS.
// (Observed 2026-09-29: an unbounded GLM router call left the enhancer session
// "running" forever, which blocked the whole task at `coding`.)
const GATEWAY_TIMEOUT_MS = Number(process.env.JCODE_GATEWAY_TIMEOUT_SECONDS ?? 180) * 1000;

function boundedFetch(url: string, init: RequestInit, label: string): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS) }).catch((e) => {
    throw new Error(`${label} request failed after ${GATEWAY_TIMEOUT_MS / 1000}s: ${String(e)}`);
  });
}

export async function callOpenAIChatCompletions(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  system?: string;
  user: string;
  maxTokens?: number;
  extra?: Record<string, unknown>;
}) {
  const sessionId = `router-${Date.now().toString(36)}`;
  const res = await boundedFetch(`${opts.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.apiKey}`,
      // OpenCode Go requires a stable session id for routing + prompt caching.
      "x-opencode-session": sessionId,
    },
    body: JSON.stringify({
      model: opts.model,
      messages: [
        ...(opts.system ? [{ role: "system", content: opts.system }] : []),
        { role: "user", content: opts.user },
      ],
      max_tokens: opts.maxTokens ?? 4096,
      ...(opts.extra ?? {}),
    }),
  }, opts.model);
  if (!res.ok) {
    const e = new Error(`${opts.model} ${res.status}: ${await res.text()}`) as Error & { status: number };
    e.status = res.status;
    throw e;
  }
  const j = (await res.json()) as {
    choices: Array<{ finish_reason?: string; message: { content?: string; reasoning_content?: string } }>;
    usage?: { completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
  };
  const choice = j.choices?.[0];
  const content = choice?.message?.content ?? "";
  // MEASURED 2026-09-30: kimi-k2.7-code can return `content: ""` with finish_reason "stop"
  // while its `reasoning_content` holds the whole answer. relaying only `content` looked like an
  // empty reply. Prefer content; fall back to reasoning (and say so).
  const reasoning = choice?.message?.reasoning_content ?? "";
  const text = content.trim() ? content : reasoning;
  return {
    text,
    usage: j.usage,
    // enough for the caller to tell "the model answered nothing" from "the model only reasoned"
    meta: { finishReason: choice?.finish_reason, contentLen: content.length, reasoningLen: reasoning.length },
  };
}

export async function callGatewayModel(
  model: string,
  system: string | undefined,
  user: string,
  /**
   * Output budget. Omit and the gateway default (4096) is used. Pass a larger one for the
   * reasoning models on this gateway (deepseek-v4.1-flash, kimi-k2.7-code): their
   * `reasoning_content` is billed inside `max_tokens`, so at 4096 a full plan JSON gets
   * truncated (finish_reason "length") or the answer comes back with EMPTY content.
   */
  opts?: { maxTokens?: number },
) {
  // ONE choke point: the routing POLICY (CEO order 2026-10-02) decides DeepSeek direct vs
  // OpenCode Go for EVERY OpenCode-Go-bound call (DeepSeek models AND Kimi/GLM/Qwen picks).
  // `deepseekDirectPlan` is quota-aware (off-peak, or Go binding window < 10%, -> direct) and
  // maps a Go pick onto the direct API's own id when it routes direct. FLEET_DEEPSEEK_ONLY=1 is
  // kept only as an explicit "always DeepSeek" override (deepseekOnlyModel); with it off the
  // CEO's rule alone decides.
  const plan = deepseekDirectPlan(model);
  const only = deepseekOnlyModel(model);
  const directFirst = plan.use || only.mapped;
  const directModel = only.mapped ? deepseekDirectModel(only.model) : plan.model;
  const goModel = only.mapped ? only.model : model;

  if (directFirst) {
    if (!directInCoolOff()) {
      const direct = await tryDirect(directModel, system, user, opts);
      if (direct.ok) {
        recordDirectOutcome(true);
        return direct.value;
      }
      const kind = failKind(direct.err);
      console.error(`[gateway] deepseek direct failed (${kind}) -> go`);
      recordDirectOutcome(false);
      recordFailure(`direct:${kind}`);
      if (kind === "401" || kind === "402") markDirectCoolOff();
      // Fall back to Go ONCE, EXCEPT when Go's binding window is 0%/exhausted (it will 429 again).
      if (goBindingExhausted()) {
        throw new Error(
          `gateway: deepseek direct (${directModel}) failed: ${String(direct.err)} | Go binding window is 0%/exhausted, no fallback`,
        );
      }
      recordFallback("direct");
      const go = await tryGo(goModel, system, user, opts);
      if (go.ok) {
        recordGoOutcome(true);
        return go.value;
      }
      recordGoOutcome(false);
      recordFailure(`go:${failKind(go.err)}`);
      throw new Error(
        `gateway: deepseek direct (${directModel}) failed: ${String(direct.err)} | go (${goModel}) also failed: ${String(go.err)}`,
      );
    }
    // direct is in cool-off: skip it and go straight to Go below.
  }

  const go = await tryGo(model, system, user, opts);
  if (go.ok) {
    recordGoOutcome(true);
    return go.value;
  }
  recordGoOutcome(false);
  const kind = failKind(go.err);
  if (isGoUsageLimit(go.err)) markGoExhausted(); // learn: a Go 429 usage limit -> direct for 10 min
  // Go -> direct fallback (ONCE) for any OpenCode-Go-bound model, while the direct bank is armed
  // (DEEPSEEK_DIRECT + key) and not in its 5-minute auth/balance cool-off.
  if (deepseekDirectArmed() && !directInCoolOff()) {
    console.error(`[gateway] go failed (${kind}) -> deepseek direct`);
    recordFallback("go");
    const direct = await tryDirect(directModel, system, user, opts);
    if (direct.ok) {
      recordDirectOutcome(true);
      return direct.value;
    }
    recordDirectOutcome(false);
    recordFailure(`direct:${failKind(direct.err)}`);
    throw new Error(`gateway: go (${model}) failed: ${String(go.err)} | deepseek direct also failed: ${String(direct.err)}`);
  }
  recordFailure(`go:${kind}`);
  throw go.err;
}

// ---- fallback helpers (never loop, never retry the same provider twice) ----

type FailKind = "429" | "go-limit" | "5xx" | "401" | "402" | "transport" | "other";

function failKind(err: unknown): FailKind {
  const e = err as { status?: number; message?: string } | undefined;
  const msg = String(e?.message ?? err);
  if (e?.status) {
    if (e.status === 429) return "429";
    if (e.status === 401) return "401";
    if (e.status === 402) return "402";
    if (e.status >= 500) return "5xx";
    return "other";
  }
  if (/GoUsageLimitError|usage limit/i.test(msg)) return "go-limit";
  if (/request failed after|fetch failed|timeout|abort/i.test(msg)) return "transport";
  return "other";
}

/** A Go 429 whose body says it is the usage limit (not a plain rate limit). */
function isGoUsageLimit(err: unknown): boolean {
  const e = err as { status?: number; message?: string } | undefined;
  const msg = String(e?.message ?? err);
  return (e?.status === 429 || /429/.test(msg)) && /GoUsageLimitError|usage limit/i.test(msg);
}

async function tryDirect(
  model: string,
  system: string | undefined,
  user: string,
  opts?: { maxTokens?: number },
): Promise<{ ok: true; value: Awaited<ReturnType<typeof callDeepseekDirect>> } | { ok: false; err: unknown }> {
  try {
    return { ok: true, value: await callDeepseekDirect(model, system, user, opts) };
  } catch (err) {
    return { ok: false, err };
  }
}

async function tryGo(
  model: string,
  system: string | undefined,
  user: string,
  opts?: { maxTokens?: number },
): Promise<{ ok: true; value: Awaited<ReturnType<typeof callOpenAIChatCompletions>> } | { ok: false; err: unknown }> {
  try {
    return {
      ok: true,
      value: await callOpenAIChatCompletions({
        baseUrl: config.gatewayBaseUrl,
        apiKey: config.gatewayKey,
        model,
        system,
        user,
        ...(opts?.maxTokens ? { maxTokens: opts.maxTokens } : {}),
      }),
    };
  } catch (err) {
    return { ok: false, err };
  }
}

// Qwen via Go Anthropic-messages path: https://opencode.ai/zen/go/v1/messages
export async function callQwenMessages(model: string, system: string | undefined, user: string) {
  const base = config.gatewayBaseUrl.replace(/\/$/, ""); // keep /v1
  const res = await boundedFetch(`${base}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.gatewayKey}`,
      "anthropic-version": "2023-06-01",
      "x-opencode-session": `router-${Date.now().toString(36)}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system,
      messages: [{ role: "user", content: user }],
    }),
  }, model);
  if (!res.ok) throw new Error(`Qwen ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as { content: Array<{ type: string; text?: string }> };
  return { text: j.content.map((b) => b.text ?? "").join("") };
}

/**
 * DeepSeek's OWN API (docs/DEEPSEEK_DIRECT.md, CEO order 2026-10-01).
 *
 * Same wire shape as the Go gateway path - DeepSeek is OpenAI-compatible - with two
 * deliberate differences:
 *   1. no `x-opencode-session` header: that header is OpenCode Go's routing/caching
 *      signal, and DeepSeek's API does not know it;
 *   2. the key and base URL come from DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL.
 *
 * DeepSeek's API accepts `https://api.deepseek.com/chat/completions` and also the
 * `/v1` spelling, so a base URL with or without `/v1` works.
 *
 * The caller decides WHETHER to use this (src/company/deepseekDirect.ts owns that
 * decision) and must keep the Go gateway as its fallback: this function throws on any
 * transport/HTTP problem, exactly like the gateway path, so the existing fallback shape
 * applies unchanged.
 */
export async function callDeepseekDirect(
  model: string,
  system: string | undefined,
  user: string,
  opts?: { maxTokens?: number; baseUrl?: string; apiKey?: string },
) {
  const base = (opts?.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").trim().replace(/\/+$/, "");
  const key = (opts?.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "").trim();
  if (!key) throw new Error("DeepSeek direct: no DEEPSEEK_API_KEY configured");
  const res = await boundedFetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: user },
      ],
      max_tokens: opts?.maxTokens ?? 4096,
      stream: false,
    }),
  }, `deepseek-direct:${model}`);
  if (!res.ok) {
    const e = new Error(`deepseek-direct ${model} ${res.status}: ${await res.text()}`) as Error & { status: number };
    e.status = res.status;
    throw e;
  }
  const j = (await res.json()) as {
    choices?: Array<{ finish_reason?: string; message?: { content?: string; reasoning_content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  const choice = j.choices?.[0];
  const content = choice?.message?.content ?? "";
  const reasoning = choice?.message?.reasoning_content ?? "";
  return {
    text: content.trim() ? content : reasoning,
    usage: j.usage,
    meta: {
      finishReason: choice?.finish_reason,
      contentLen: content.length,
      reasoningLen: reasoning.length,
      via: "deepseek-direct" as const,
    },
  };
}
