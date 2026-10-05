/**
 * src/adaptive/hook.ts — the two-line integration the router needs.
 *
 *   before the call:  route = withAdaptive(route, prompt, taskHint)
 *   after the call:   recordAdaptiveOutcome(route, ok, startedAtMs, {...})
 *
 * Both are no-ops unless `ADAPTIVE_ROUTING=1`, and both swallow their own errors:
 * adaptive routing must never be able to fail a request.
 */
import { modelCatalog, specFor } from "./catalog.js";
import { classifyFailure, type FailureKind, type TaskClass, type Via } from "./events.js";
import { getAdaptive } from "./index.js";

export type AdaptiveRouteLike = {
  complexity: TaskClass;
  confidence: number;
  modelId: string;
  via: Via;
  reason: string;
};

export function estimateCostUsd(model: string): number {
  return specFor(model, modelCatalog())?.costUsd ?? 0;
}

/** Before the call: ask the rule engine to adjust Laya's pick. */
export function withAdaptive<T extends AdaptiveRouteLike>(route: T, prompt: string, taskHint?: string): T {
  const engine = getAdaptive();
  if (!engine.enabled) return route;
  try {
    const res = engine.select(
      { modelId: route.modelId, via: route.via, reason: route.reason },
      route.complexity,
      taskHint ? `${prompt}\n${taskHint}` : prompt,
    );
    if (!res.changed) return route;
    return { ...route, modelId: res.modelId, via: res.via, reason: `${route.reason} | adaptive: ${res.reason}` };
  } catch {
    return route;
  }
}

export type OutcomeInfo = {
  tokens?: number;
  cost?: number;
  /** The answer text; an empty/too-short answer counts as a failure. */
  text?: string;
  error?: unknown;
  status?: number;
  failureKind?: FailureKind;
  source?: string;
};

/** After the call: record the outcome (fire-and-forget, idempotent, never blocks). */
export function recordAdaptiveOutcome(
  route: { complexity: TaskClass; modelId: string; via: Via },
  ok: boolean,
  startedAtMs: number,
  info: OutcomeInfo = {},
): void {
  const engine = getAdaptive();
  if (!engine.enabled) return;
  try {
    let success = ok;
    let hint = info.failureKind;
    if (success && info.text !== undefined && info.text.trim().length < 2) {
      success = false;
      hint = hint ?? "empty_answer";
    }
    engine.record({
      model: route.modelId,
      cls: route.complexity,
      via: route.via,
      ok: success,
      failureKind: success ? "ok" : hint ?? classifyFailure(info.error, info.status),
      latencyMs: Math.max(0, Date.now() - startedAtMs),
      tokens: info.tokens ?? 0,
      cost: info.cost ?? estimateCostUsd(route.modelId),
      source: info.source ?? "router",
      error: info.error,
      status: info.status,
    });
  } catch {
    /* adaptive must never break the request path */
  }
}
