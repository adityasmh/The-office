import { config, enforceModel } from "./config.js";
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
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAX_PARALLEL, DEFAULT_MAX_WAIT_MS, ModelCooldowns, Pacer, chainFor, classifyFailure, roleForModelId } from "./museLane.js";

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

async function callGatewayPaid(
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
  // MODEL POLICY (Order F3): the gateway call is a choke point. A blocked id
  // (kimi/qwen/unknown) never leaves here: it is swapped onto the standard model first.
  model = enforceModel(model).id;
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

// ---- MUSE LANE (CEO 2026-10-13): paid credit is at zero, so the router's own steps (enhancer, plan, review) run on the FREE
// Muse model. OpenCode's free tier answers only inside its own client, so this goes through the real `opencode run` binary
// (never a direct HTTP call). The queue creates logs\muse-mode.flag when credit runs out and removes it when credit is back.
const MUSE_FLAG = resolve(fileURLToPath(new URL("../logs/muse-mode.flag", import.meta.url)));
// Rate-limit policy (2026-10-13: the free tier rate limited us after 6 parallel calls): fewer parallel calls, spacing between
// launches, fail fast when the client reports a rate limit, a cooldown for that model, then the next free model (see museLane.ts).
const MUSE_MAX_PARALLEL = Math.max(1, Number(process.env.JCODE_MUSE_PARALLEL ?? DEFAULT_MAX_PARALLEL));
const MUSE_ATTEMPT_MS = Math.min(GATEWAY_TIMEOUT_MS, Number(process.env.JCODE_MUSE_ATTEMPT_SECONDS ?? 100) * 1000);
const museCooldowns = new ModelCooldowns();
const musePacer = new Pacer();
let museRunning = 0;
const museRotation: Record<string, number> = {}; // one counter per role, so alternating roles cannot lock each other onto one model
const MUSE_COOLING_FILE = resolve(fileURLToPath(new URL("../logs/free-model-cooling.json", import.meta.url)));

/** Publish which free models are resting, so ops/provider-sync.ps1 keeps the coder workers off them too. Best effort. */
function writeCoolingFile(): void {
  try {
    const tmp = `${MUSE_COOLING_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify({ at: Date.now(), until: museCooldowns.snapshot() }), "utf8");
    renameSync(tmp, MUSE_COOLING_FILE);
  } catch {
    /* the cooling file only helps the coders; the lane itself keeps working without it */
  }
}

// The prompt goes in on stdin: no command line length limit, and no attached file (careful models treat instructions found in a
// file as untrusted data and refuse them; measured on longcat-2.5-preview-free 2026-10-13).
function runOpencodeOnce(bin: string, model: string, prompt: string, dir: string): Promise<string> {
  return new Promise<string>((ok, bad) => {
    const child = spawn(
      bin,
      ["run", "-m", model, "--format", "json", "--print-logs", "--log-level", "ERROR"],
      { cwd: dir, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stdin.on("error", () => {
      /* the process may exit or be killed before reading all of stdin; the close handler reports the outcome */
    });
    child.stdin.end(prompt);
    let buf = "";
    let err = "";
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => bad(new Error(`muse lane timed out after ${MUSE_ATTEMPT_MS / 1000}s on ${model}`)));
    }, MUSE_ATTEMPT_MS);
    child.stdout.on("data", (d) => (buf += String(d)));
    child.stderr.on("data", (d) => {
      err += String(d);
      const kind = classifyFailure(err);
      // the client retries a rate limit silently for minutes: stop at the first sign of it
      if (kind === "rate-limit" || kind === "privacy-gate") {
        child.kill();
        finish(() => bad(new Error(`${kind === "rate-limit" ? "rate limit exceeded" : "privacy gate: model trains on request data"} on ${model}`)));
      }
    });
    child.on("error", (e) => finish(() => bad(e)));
    child.on("close", (code) => finish(() => (code === 0 ? ok(buf) : bad(new Error(`muse lane exited ${code} on ${model}: ${err.slice(0, 200)}`)))));
  });
}

export function museLaneActive(): boolean {
  if (process.env.JCODE_MUSE_LANE === "off") return false; // checks that test the paid-provider path set this
  return existsSync(MUSE_FLAG);
}

function parseOpencodeEvents(out: string): { text: string; outTokens: number | undefined; eventTypes: string } {
  let text = "";
  let outTokens: number | undefined;
  const counts: Record<string, number> = {};
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const ev = JSON.parse(line) as { type?: string; part?: { text?: string; tokens?: { output?: number } } };
      counts[String(ev.type)] = (counts[String(ev.type)] ?? 0) + 1;
      if (ev.type === "text" && ev.part?.text) text += ev.part.text;
      if (ev.type === "step_finish" && typeof ev.part?.tokens?.output === "number") outTokens = ev.part.tokens.output;
    } catch {
      /* ignore a partial line */
    }
  }
  return { text, outTokens, eventTypes: JSON.stringify(counts) };
}

async function callMuseViaOpencode(system: string | undefined, user: string, modelHint: string) {
  // wait for a free slot instead of failing: many orders run at once and each needs several router-side calls
  const waitUntil = Date.now() + GATEWAY_TIMEOUT_MS;
  while (museRunning >= MUSE_MAX_PARALLEL) {
    if (Date.now() > waitUntil) throw new Error(`muse lane busy for ${GATEWAY_TIMEOUT_MS / 1000}s (${MUSE_MAX_PARALLEL} calls running)`);
    await new Promise((r) => setTimeout(r, 500));
  }
  museRunning++;
  // An empty temp folder is the working directory, so the model cannot touch the project even if it tried a tool.
  const dir = mkdtempSync(join(tmpdir(), "muse-lane-"));
  try {
    const prompt =
      // The free tier only accepts requests shaped like a normal coding-agent session, so the tools cannot be removed; models that
      // are told to "read the project" call them and end with no text (measured 2026-10-14: 4-8 tool calls, 0 text). This wording
      // fixed it on cat-jam-free and nemotron-3-ultra-free (1 step, plain text answer).
      `IMPORTANT: this is a plain text-in, text-out request. You have NO access to files, the codebase, a shell or the web in this session, and nothing is installed here. ` +
      `Every fact you need is written in this message. Do NOT call any tool. If the request below tells you to read or look at files, skip that step and answer from the text of this message alone. ` +
      `Your whole reply is one plain text answer.\n\n` +
      `${system ? `SYSTEM INSTRUCTIONS:\n${system}\n\n` : ""}REQUEST:\n${user}\n`;
    const bin =
      process.env.OPENCODE_BIN ?? "%APPDATA%\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe";
    const role = roleForModelId(modelHint);
    museRotation[role] = (museRotation[role] ?? 0) + 1;
    const models = chainFor(role, museRotation[role]);
    const tried: string[] = [];
    let usedModel = "";
    let text = "";
    let outTokens: number | undefined;
    let lastErr: unknown;
    let candidates = museCooldowns.available(models);
    if (candidates.length === 0) {
      // every model is resting: wait for the first one to recover instead of falling straight into the exhausted paid providers
      const waitMs = Math.min(museCooldowns.soonestMs(models), DEFAULT_MAX_WAIT_MS);
      if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs + 250));
      candidates = museCooldowns.available(models);
    }
    for (const model of candidates) {
      tried.push(model);
      const wait = musePacer.reserve();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        const out = await runOpencodeOnce(bin, model, prompt, dir);
        const parsed = parseOpencodeEvents(out);
        // a model that exits normally but says nothing is a failed attempt: try the next one instead of failing the whole step
        if (!parsed.text.trim()) throw new Error(`${model} returned no text (prompt ${prompt.length} chars, events ${parsed.eventTypes}, output ${out.length} bytes)`);
        text = parsed.text;
        outTokens = parsed.outTokens;
        usedModel = model;
        break;
      } catch (e) {
        lastErr = e;
        const kind = classifyFailure(String(e));
        museCooldowns.mark(model, kind);
        writeCoolingFile();
        console.error(`[gateway] free model ${model} failed (${kind}): ${String(e).slice(0, 120)} -> next`);
      }
    }
    if (!usedModel) {
      const resting = tried.length === 0 ? `all free models resting for ${Math.ceil(museCooldowns.soonestMs(models) / 1000)}s` : `tried ${tried.join(", ")}`;
      throw new Error(`muse lane: no free model answered (${resting}): ${String(lastErr ?? "").slice(0, 160)}`);
    }
    return {
      text,
      usage: outTokens === undefined ? undefined : { completion_tokens: outTokens },
      meta: { finishReason: "stop" as string | undefined, contentLen: text.length, reasoningLen: 0, model: usedModel },
    };
  } finally {
    museRunning--;
    // a client process that was just killed can still hold the folder for a moment on Windows: retry instead of leaking it
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {
      /* temp folder cleanup is best effort */
    });
  }
}

export async function callGatewayModel(
  model: string,
  system: string | undefined,
  user: string,
  opts?: { maxTokens?: number },
) {
  if (museLaneActive()) {
    try {
      return await callMuseViaOpencode(system, user, model);
    } catch (e) {
      console.error(`[gateway] muse lane failed (${String(e).slice(0, 160)}) -> paid providers`);
    }
  }
  return callGatewayPaid(model, system, user, opts);
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
  // MODEL POLICY (Order F3): this endpoint is not reachable with a blocked id. A
  // blocked (or non-Qwen) pick is remapped onto the standard gateway call instead.
  const enforced = enforceModel(model);
  if (enforced.swapped) {
    const fb = await callGatewayModel(enforced.id, system, user);
    return { text: fb.text };
  }
  model = enforced.id;
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
