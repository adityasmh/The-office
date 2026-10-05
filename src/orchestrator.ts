import { config } from "./config.js";
import { chooseBestModel, classifyComplexity } from "./decision.js";
import { callClaudeSubscription } from "./claudeSubscription.js";
import { callGatewayModel, callQwenMessages } from "./gateway.js";
// DEEPSEEK DIRECT (docs/DEEPSEEK_DIRECT.md, CEO order 2026-10-01): off-peak DeepSeek
// traffic goes to DeepSeek's own API (half price, its own credit) instead of spending
// the OpenCode Go weekly quota. The decision is env-gated (DEEPSEEK_DIRECT=1) and the
// Go gateway stays the fallback, so an unconfigured or keyless box is unchanged.
import { deepseekOnlyModel } from "./company/deepseekDirect.js";
// ADAPTIVE ROUTING (docs/perf/ADAPTIVE_ROUTING.md, default OFF): both helpers are
// no-ops unless ADAPTIVE_ROUTING=1, so this file behaves exactly as before by default.
import { recordAdaptiveOutcome, withAdaptive } from "./adaptive/hook.js";
// AIR-GAP (PERF item 7): when AIR_GAPPED=1 the claude-subscription path cannot run (the
// flag blocks the claude -p child AND any hosted gateway fetch). The existing
// 429-fallback shape below is reused instead of a new failure path: the primary error
// is captured verbatim in `primaryError`, and the un-served work lands in the
// held-air-gapped queue (company/held-air-gapped.json) instead of throwing, exactly
// like a throttled call used to fall back. The local decision backend (Laya) is
// loopback and keeps working, so routing/decision questions still answer.
import { airgappedBlock, holdUnserved } from "./company/airGap.js";
import type { TaskComplexity } from "./decision.js";

export type Route = {
  complexity: TaskComplexity;
  confidence: number;
  modelId: string;
  via: "gateway" | "qwen-messages" | "claude-subscription";
  reason: string;
};

const rank: Record<TaskComplexity, number> = { ROUTINE: 0, STANDARD: 1, COMPLEX: 2, DEMANDING: 3 };

// Primary path: Laya chooses the best model directly from the full catalog.
// Secondary: complexity used for the low-confidence escalation rule (never downgrade).
export async function decideRoute(prompt: string, opts?: { taskHint?: string; minConfidence?: number }): Promise<Route> {
  const minConf = opts?.minConfidence ?? 0.5;
  const b = await chooseBestModel(prompt, opts?.taskHint ?? "");
  const c = await classifyComplexity(prompt, opts?.taskHint ?? "");

  // Low confidence on ANY choice -> never downgrade to a weaker brain, but do not name Claude
  // either: CHEAP BY DEFAULT (docs/CHEAP_BY_DEFAULT_SPEC.md Job 2) leaves the tier to the
  // brainRouter gate in `generate` below, and the model returned here is only the CEILING.
  // Opus is therefore requested only for genuinely DEMANDING work or an order naming it.
  if (b.confidence < minConf) {
    const hardBrain = rank[c.predicted] >= rank.DEMANDING || (opts?.taskHint ?? "").toLowerCase().includes("opus");
    const modelId = hardBrain ? config.claudeOpus : config.claudeSonnet;
    // ADAPTIVE HOOK (a): the rules only ever ADJUST this pick, and only when the
    // flag is on; with ADAPTIVE_ROUTING unset the object below is returned as-is.
    return withAdaptive(
      { complexity: c.predicted, confidence: Math.min(b.confidence, c.confidence), modelId, via: "claude-subscription" as const, reason: `${b.reason}; low conf -> ceiling ${hardBrain ? "OPUS" : "SONNET"} (min ${minConf}); the Laya gate picks the tier that runs` },
      prompt,
      opts?.taskHint,
    );
  }

  return withAdaptive(
    { complexity: c.predicted, confidence: b.confidence, modelId: b.modelId, via: b.via, reason: b.reason },
    prompt,
    opts?.taskHint,
  );
}

// ADAPTIVE HOOK (b): the outcome is recorded here, around the whole call, so every
// failure kind (429/5xx/timeout/empty answer) reaches the estimator. With the flag
// off both calls return immediately and the behaviour is byte-for-byte the old one.
export async function generate(prompt: string, route: Route, system?: string) {
  const startedAtMs = Date.now();
  try {
    const out = await generateCore(prompt, route, system);
    const asAny = out as { text?: unknown; usage?: { input_tokens?: number; output_tokens?: number } } | null | undefined;
    recordAdaptiveOutcome(route, true, startedAtMs, {
      text: typeof asAny?.text === "string" ? asAny.text : undefined,
      tokens: (asAny?.usage?.input_tokens ?? 0) + (asAny?.usage?.output_tokens ?? 0),
    });
    return out;
  } catch (err) {
    recordAdaptiveOutcome(route, false, startedAtMs, { error: err });
    throw err;
  }
}

async function generateCore(prompt: string, route: Route, system?: string) {
  if (config.mockMode) {
    const { mockGenerate } = await import("./mock.js");
    return mockGenerate(prompt, `${route.via}:${route.modelId}`);
  }
  // FLEET_DEEPSEEK_ONLY (CEO order 2026-10-01 18:30, docs/ORDER_2026-10-01_deepseek-only.md): a
  // route Laya sent to GLM / Kimi / Qwen spends the OpenCode Go weekly quota. With the switch
  // armed it is served on DeepSeek's own API instead: the id is mapped onto a model the direct
  // API lists and the hop is pulled onto the `gateway` branch below, which already asks
  // `deepseekDirectPlan` and keeps the Go gateway as the fallback. Claude-subscription routes and
  // DeepSeek ids are left exactly as they were (identity when the switch is off, the default).
  const only = deepseekOnlyModel(route.modelId);
  const r: Route = only.mapped ? { ...route, modelId: only.model, via: "gateway", reason: `${route.reason} | ${only.why}` } : route;
  try {
    switch (r.via) {
      case "claude-subscription":
        // CHEAP BY DEFAULT (Job 2): `purpose: "generate"` puts this one-shot behind the Laya
        // gate, and `generate` is in brainRouter's never-Claude set (a plain answer, not
        // planning), so this hop costs nothing unless the CEO names Claude in the text.
        // `route.modelId` is only the CEILING - including in the low-confidence branch above.
        return await callClaudeSubscription({ model: r.modelId, system, user: prompt, purpose: "generate" });
      case "qwen-messages":
        return { text: (await callQwenMessages(r.modelId, system, prompt)).text };
      case "gateway":
      default: {
        // DEEPSEEK DIRECT + FLEET_DEEPSEEK_ONLY mapping + both-ways fallback now all live inside
        // callGatewayModel (ONE choke point, src/gateway.ts), so this hop no longer duplicates the
        // direct call or its fallback. The `deepseekOnlyModel` remap above (kimi/glm/qwen -> a
        // DeepSeek id, and qwen-messages -> gateway) still runs first; callGatewayModel applies its
        // own mapping idempotently. With the flags off this is byte-for-byte the old Go call.
        return await callGatewayModel(r.modelId, system, prompt);
      }
    }
  } catch (err) {
    // Subscription throttling is expected: fall back to the hosted gateway
    // (config.claudeFallback, e.g. space-bunny-free) rather than hard-failing.
    // The fallback gets its own try/catch so its failure cannot mask the primary
    // Claude error (which operators report as the real cause, e.g. a 429).
    if (route.via === "claude-subscription") {
      // AIR-GAP (PERF item 7): with the flag ON the hosted gateway call is itself an
      // outbound call, so the 429-fallback shape skips straight to the
      // held-air-gapped queue plus the local model stub (reviews require keeping
      // this and the hosted-gateway catch below in the same fallback shape).
      if (airgappedBlock("fleet-agent", `gateway fallback ${config.claudeFallback}`)) {
        const held = holdUnserved(prompt, `claude refused under AIR_GAPPED=1 (gateway fallback gated): ${String(err).slice(0, 160)}`, "generate");
        return {
          text: "",
          heldAirGapped: true,
          heldId: held.id,
          primaryError: String(err),
          fallbackError: "AIR_GAPPED=1 gates the hosted gateway fallback",
        };
      }
      // AIR-GAP (PERF item 7): same fallback shape as the hosted-gateway catch below,
      // but the "fallback" in air-gapped mode is the held-air-gapped queue plus the
      // local model stub, not another hosted call.
      try {
        const fb = await callGatewayModel(config.claudeFallback, system, prompt);
        return { ...fb, fallback: true, primaryError: String(err) };
      } catch (fbErr) {
        if (config.airGapped) {
          const held = holdUnserved(prompt, `claude + gateway fallback both refused (AIR_GAPPED=1): ${String(err).slice(0, 160)}`, "generate");
          return {
            text: "",
            heldAirGapped: true,
            heldId: held.id,
            primaryError: String(err),
            fallbackError: String(fbErr),
          };
        }
        throw new Error(
          `Claude failed: ${String(err)} | fallback (${config.claudeFallback}) also failed: ${String(fbErr)}`,
        );
      }
    }
    throw err;
  }
}
