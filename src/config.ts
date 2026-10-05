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
  gatewayBaseUrl: process.env.GATEWAY_BASE_URL ?? "https://opencode.ai/zen/go/v1",
  gatewayKey: process.env.OPENCODE_API_KEY ?? "",
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
    routine: process.env.ROUTINE_MODEL ?? "glm-5.3-flash",
    standard: process.env.STANDARD_MODEL ?? "deepseek-v4-flash",
    complex: process.env.COMPLEX_MODEL ?? "kimi-k2.7-code",
    complexQwen: process.env.QWEN_MODEL ?? "qwen3.8-flash",
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
  if (!config.gatewayKey) throw new Error("Missing OPENCODE_API_KEY (Go key) or set MOCK_MODE=1");
}
