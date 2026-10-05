/**
 * src/adaptive/events.ts — the outcome vocabulary shared by every Laya call site.
 *
 * An AI request is the "payment" of the CEO's diagram, so the event is exactly the
 * shape the estimator and the dashboard need and nothing more: ids, model, task
 * class, ok/fail, the failure kind, latency, tokens and cost. No prompt text is
 * ever put in an event (privacy + message size, see docs/LAYA_ADAPTIVE_ROUTING_SPEC.md
 * "Safety").
 */

/** Laya's own task classes; identical to decision.ts TaskComplexity on purpose. */
export type TaskClass = "ROUTINE" | "STANDARD" | "COMPLEX" | "DEMANDING";

export const TASK_CLASSES: TaskClass[] = ["ROUTINE", "STANDARD", "COMPLEX", "DEMANDING"];

/**
 * What counts as a failure (spec: "What counts as success"). `ok` is a failure
 * whenever one of these is recorded, so the estimator learns per kind.
 */
export type FailureKind =
  | "ok"
  | "http_429"
  | "http_5xx"
  | "timeout"
  | "planner_no_json"
  | "tool_call_instead_of_json"
  | "empty_answer"
  | "review_loop"
  | "budget_exceeded"
  | "error";

export const FAILURE_KINDS: FailureKind[] = [
  "ok",
  "http_429",
  "http_5xx",
  "timeout",
  "planner_no_json",
  "tool_call_instead_of_json",
  "empty_answer",
  "review_loop",
  "budget_exceeded",
  "error",
];

export const FAILURE_LABELS: Record<FailureKind, string> = {
  ok: "ok",
  http_429: "HTTP 429 (rate limited)",
  http_5xx: "HTTP 5xx",
  timeout: "timeout",
  planner_no_json: "planner returned no parseable JSON",
  tool_call_instead_of_json: "tool-call instead of JSON",
  empty_answer: "empty / too short answer",
  review_loop: "reviewer verdict LOOP/REDO",
  budget_exceeded: "budget exceeded",
  error: "other error",
};

export type Via = "gateway" | "qwen-messages" | "claude-subscription";

/** One completed Laya-routed request. Key in Kafka is `model` (ordering per model). */
export type OutcomeEvent = {
  id: string;
  ts: string;
  requestId: string;
  model: string;
  /** Model provider/via, for the dashboard; not used by the estimator. */
  via: Via;
  cls: TaskClass;
  ok: boolean;
  failureKind: FailureKind;
  latencyMs: number;
  tokens: number;
  /** USD estimate for this call; 0 when unknown. */
  cost: number;
  /** Which call site produced it: router, fleet-planner, fleet-worker, company-pipeline, tool. */
  source: string;
  /** Optional agent/role id (dashboard only). */
  agent?: string;
};

/** One routing decision plus its reason (topic `laya.decisions`, audit + dashboard). */
export type DecisionEvent = {
  id: string;
  ts: string;
  requestId: string;
  cls: TaskClass;
  prior: string;
  priorVia: Via;
  chosen: string;
  chosenVia: Via;
  changed: boolean;
  explored: boolean;
  circuit: Record<string, string>;
  /** The human-readable reason, the same string the trace shows. */
  reason: string;
  source: string;
};

let seq = 0;
export function newId(prefix: string): string {
  seq = (seq + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** The estimator input: a model+class pair is the state; the rest is what it keeps. */
export type Sample = {
  ok: boolean;
  failureKind: FailureKind;
  latencyMs: number;
  tokens: number;
  cost: number;
};

/**
 * Best-effort mapping from a thrown error / HTTP status to a failure kind, so the
 * existing call sites can record a real kind without each one inventing its own.
 * `hint` lets a caller that already knows the semantic kind (e.g. the planner
 * detecting a tool-call answer) override the generic HTTP mapping.
 */
export function classifyFailure(err: unknown, status?: number, hint?: FailureKind): FailureKind {
  if (hint) return hint;
  const msg = `${String((err as { message?: unknown })?.message ?? err ?? "")}`;
  if (status === 429 || /\b429\b|rate.?limit|quota|too many requests/i.test(msg)) return "http_429";
  if (status && status >= 500) return "http_5xx";
  if (status && status >= 400) return "error";
  if (/timeout|timed out|ETIMEDOUT|aborted/i.test(msg)) return "timeout";
  if (/ECONNREFUSED|ENOTFOUND|fetch failed|socket hang up|network/i.test(msg)) return "error";
  if (/no parseable JSON|not parseable JSON|no JSON/i.test(msg)) return "planner_no_json";
  if (/tool[- _]?call/i.test(msg)) return "tool_call_instead_of_json";
  if (/empty|too short|blank answer/i.test(msg)) return "empty_answer";
  if (/LOOP|REDO/i.test(msg)) return "review_loop";
  if (/budget/i.test(msg)) return "budget_exceeded";
  return "error";
}

/** Success = the HTTP call worked, the answer parsed/survived review, and `ok` was set. */
export function isFailureKind(kind: FailureKind): boolean {
  return kind !== "ok";
}
