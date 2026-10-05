/**
 * ops/deepseek-policy-live.ts — the CEO's live proof (CEO order 2026-10-02):
 * one 1-token call through `callGatewayModel('kimi-k2.7-code', ...)` showing it was mapped to
 * DeepSeek direct and succeeded. Prints ONLY status / latency / usage (never the key). If the
 * DeepSeek API errors (insufficient balance / 401), it prints the HTTP status + error type so the
 * CEO knows.
 *
 * Run:  npx tsx ops/deepseek-policy-live.ts
 */
import "dotenv/config";

async function main(): Promise<void> {
  const { openCodeGoUsage } = await import("../src/company/usage.js");
  const { deepseekDirectPlan } = await import("../src/company/deepseekDirect.js");
  const { callGatewayModel } = await import("../src/gateway.js");

  // Populate the real Go quota snapshot (the routing POLICY reads this cache synchronously).
  const go = await openCodeGoUsage();
  process.stdout.write(
    `Go quota: ${go.connected ? go.windows.map((w) => `${w.window} ${w.remainingPct}%`).join(", ") : "unavailable"} (binding ${go.bindingWindow ?? "?"} ${go.remainingPct ?? "?"}%)\n`,
  );

  const plan = deepseekDirectPlan("kimi-k2.7-code");
  process.stdout.write(`plan for kimi-k2.7-code -> ${plan.use ? "DIRECT" : "Go"} ${plan.model} :: ${plan.why}\n`);

  const t0 = Date.now();
  try {
    const r = await callGatewayModel("kimi-k2.7-code", undefined, "reply ok", { maxTokens: 1 });
    process.stdout.write(
      `RESULT ok latency_ms=${Date.now() - t0} via=${(r.meta as { via?: string } | undefined)?.via ?? "?"} usage=${JSON.stringify(r.usage)}\n`,
    );
  } catch (e) {
    const err = e as { status?: number; name?: string; message?: string };
    process.stdout.write(
      `RESULT error latency_ms=${Date.now() - t0} status=${err?.status ?? "?"} type=${err?.name ?? "Error"} ${String(err?.message ?? e).slice(0, 240)}\n`,
    );
  }
}

main().catch((e) => {
  process.stderr.write(`deepseek-policy-live failed: ${String(e)}\n`);
  process.exitCode = 1;
});
