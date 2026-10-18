import { routingPolicy } from "./routingPolicy.js";

export const config = {
  // Decision backend: "laya" (default, open weights via Laya Studio) or "jev" (TypeSafe hosted).
  // Same /v1/systemone wire protocol; only base URL + key change.
  decisionBackend: process.env.DECISION_BACKEND ?? "laya",
  decisionBaseUrl: process.env.LAYA_BASE_URL ?? "http://127.0.0.1:8000",
  decisionKey: (process.env.LAYA_API_KEY ?? "").trim(),
  // Jev fallback (only used when DECISION_BACKEND=jev):
  typesafeApiKey: process.env.TYPESAFE_API_KEY ?? "",
  typesafeBaseUrl: process.env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai",
  jevModel: process.env.JEV_MODEL ?? "jev-1.13.0",
  // Gateway: GATEWAY_BASE_URL env, else routing.policy.json (gateway.baseUrl), else the built-in default.
  // The key is read from the env var NAMED by the policy (gateway.keyEnv, default OPENCODE_API_KEY).
  gatewayBaseUrl: process.env.GATEWAY_BASE_URL ?? routingPolicy.gateway.baseUrl,
  gatewayKeyEnv: routingPolicy.gateway.keyEnv,
  gatewayKey: process.env[routingPolicy.gateway.keyEnv] ?? process.env.OPENCODE_API_KEY ?? "",
  claudeSonnet: process.env.CLAUDE_SONNET ?? "claude-sonnet-5-5",
  claudeOpus: process.env.CLAUDE_OPUS ?? process.env.CLAUDE_MODEL ?? "claude-opus-5-5",
  claudeModel: process.env.CLAUDE_MODEL ?? "claude-opus-5-5",
  claudeFallback: process.env.CLAUDE_FALLBACK_MODEL ?? "space-bunny-free",
  slackBotToken: (process.env.SLACK_BOT_TOKEN ?? "").trim(),
  slackChannelId: (process.env.SLACK_CHANNEL_ID ?? "").trim(),
  // Socket Mode (src/company/slackInbound.ts): an APP-LEVEL token (xapp-...) with
  // connections:write makes Slack PUSH events to us over a WebSocket, which is the
  // preferred inbound transport. Without it the bridge falls back to polling
  // conversations.history with the bot token. SLACK_SOCKET_MODE=0 forces the
  // polling fallback even when an app token is present.
  slackAppToken: (process.env.SLACK_APP_TOKEN ?? "").trim(),
  slackSocketMode: (process.env.SLACK_SOCKET_MODE ?? "").trim(),
  mockMode: (process.env.MOCK_MODE ?? "") === "1" || (process.env.MOCK_MODE ?? "").toLowerCase() === "true",
  // Canonical IDs — Qwen 3.8 27B does not exist, use Flash:
  models: {
    routine: process.env.ROUTINE_MODEL ?? routingPolicy.tiers.routine,
    standard: process.env.STANDARD_MODEL ?? routingPolicy.tiers.standard,
    complex: process.env.COMPLEX_MODEL ?? routingPolicy.tiers.complex,
    complexQwen: process.env.QWEN_MODEL ?? routingPolicy.tiers.complexAlt,
  },
  port: Number(process.env.PORT ?? 8787),
  // ── Trust boundary (docs/CEO_RUNBOOK.md §0) ─────────────────────────────
  // The control plane spends money and executes code, so it binds to loopback
  // by default and every /company/* mutation (plus the SSE stream) must carry
  // the shared secret. Set HOST=0.0.0.0 deliberately to expose it on the LAN —
  // which then requires COMPANY_AUTH_TOKEN (assertConfig refuses to start
  // without it, so an exposed control plane can never be left unauthenticated).
  host: process.env.HOST ?? "127.0.0.1",
  authToken: (process.env.COMPANY_AUTH_TOKEN ?? "").trim(),
  allowedHosts: (process.env.COMPANY_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean),
  // AIR-GAP (PERF item 7): default OFF. See src/company/airGap.ts.
  airGapped: (process.env.AIR_GAPPED ?? "").trim() === "1",
};

// ── MODEL POLICY (Order F3) ──────────────────────────────────────────────────
// Only the DeepSeek and GLM families are served to workers and gateway calls.
// Kimi and Qwen stay KNOWN in the catalog above but are BLOCKED: any pick outside
// the allowlist is swapped onto the standard model at the choke points
// (workers.ts / gateway.ts / dispatch.ts / pipeline.ts / orchestrator.ts).
// MODEL_ALLOWLIST overrides the family prefixes (comma separated: parsed, trimmed,
// lowercased, blanks dropped). Read from env on EVERY call (never cached) so the
// override is testable without a re-import.
export function modelAllowlist(): string[] {
  const raw = String(process.env.MODEL_ALLOWLIST ?? "").trim().toLowerCase();
  const source = raw.length ? raw : routingPolicy.allowedFamilies.join(",");
  return source.split(",").map((p) => p.trim()).filter(Boolean);
}

export type EnforcedModel = { id: string; swapped: boolean; was: string | null };

/**
 * Enforce the model policy on a model id. Pure-ish: never throws, no network.
 * - id starting with an allowlisted family prefix -> pass through unchanged;
 * - id starting with "claude" -> out of scope (subscription models), pass through;
 * - anything else (kimi, qwen, unknown) -> `fallbackId` (default models.standard),
 *   swapped=true, was=<original id>, one log line.
 * Non-string input (defensive) -> the fallback, not marked as a swap.
 */
export function enforceModel(modelId: string, fallbackId: string = config.models.standard): EnforcedModel {
  try {
    if (typeof modelId !== "string" || modelId.trim() === "") {
      return { id: fallbackId, swapped: false, was: null };
    }
    const id = modelId.trim();
    const low = id.toLowerCase();
    if (low.startsWith("claude")) return { id, swapped: false, was: null };
    if (modelAllowlist().some((p) => low.startsWith(p))) return { id, swapped: false, was: null };
    console.log(`[model-policy] swapped ${id} -> ${fallbackId}`);
    return { id: fallbackId, swapped: true, was: id };
  } catch {
    return { id: fallbackId, swapped: false, was: null };
  }
}

export function assertConfig() {
  // Runs before the mock-mode early return: an unauthenticated off-host bind is
  // a security failure whether or not providers are mocked.
  const loopbackHost =
    config.host === "127.0.0.1" ||
    config.host === "localhost" ||
    config.host === "::1" ||
    config.host === "[::1]";
  if (!loopbackHost && !config.authToken) {
    throw new Error(
      `Refusing to start: HOST=${config.host} exposes the company control plane off-host with no COMPANY_AUTH_TOKEN. ` +
        "Set COMPANY_AUTH_TOKEN to a long random string, or leave HOST unset (binds 127.0.0.1).",
    );
  }
  if (config.authToken && config.authToken.length < 16) {
    console.warn("[auth] COMPANY_AUTH_TOKEN is shorter than 16 chars; use a long random string (see docs/CEO_RUNBOOK.md §0).");
  }
  if (config.mockMode) return;
  const local = config.decisionBaseUrl.includes("127.0.0.1") || config.decisionBaseUrl.includes("localhost");
  // Local Laya needs no key; hosted Laya Studio needs lsk_live_...
  if (!config.decisionKey && config.decisionBackend === "laya" && !local) throw new Error("Missing LAYA_API_KEY (local Laya needs none; hosted needs lsk_live_...)");
  if (!config.typesafeApiKey && config.decisionBackend === "jev") throw new Error("Missing TYPESAFE_API_KEY (or set MOCK_MODE=1)");
  if (!config.gatewayKey) throw new Error(`Missing ${config.gatewayKeyEnv} (the gateway key named in the routing policy) or set MOCK_MODE=1`);
}
