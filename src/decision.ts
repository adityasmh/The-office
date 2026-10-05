import { config } from "./config.js";
import { cacheGet, cacheKey, cacheSet } from "./decisionCache.js";

// Decision backend: Laya (default, open weights via Laya Studio) or Jev fallback.
// Same /v1/systemone wire protocol (choice/score/noul + probabilities + confidence),
// so only base URL + key change.
// Laya differences that matter here:
// - confidence = 1 - H(p)/log k (reads LOWER than Jev's formula; re-tune thresholds, don't copy them)
// - context 512-1024 tokens/question: keep states short (ours are: prompt + hint + short review fields)
// - keep choice options under ~20 (ours: 4 complexity, 2 brain) — Jev needed only for 20-255 options or 32k states
// - Laya ignores Jev model IDs and routes automatically, so model is sent only for Jev.

export type TaskComplexity = "ROUTINE" | "STANDARD" | "COMPLEX" | "DEMANDING";

type DecisionQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string }
  | { type: "score"; instructions: string; criteria: string[] };

type DecisionAnswer = {
  type: string;
  choice?: string;
  noul?: number;
  score?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
};

type DecisionResponse = {
  model: string;
  answers: Record<string, DecisionAnswer>;
  usage?: { input_tokens: number; output_tokens: number };
};

async function decisionCall(state: unknown, questions: Record<string, DecisionQuestion>): Promise<DecisionResponse> {
  const isJev = config.decisionBackend === "jev";
  const base = isJev ? config.typesafeBaseUrl : config.decisionBaseUrl;
  const key = isJev ? config.typesafeApiKey : config.decisionKey;
  const body: Record<string, unknown> = isJev ? { state, model: config.jevModel, questions } : { state, questions };
  const res = await fetch(`${base}/v1/systemone`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Decision (${config.decisionBackend}) ${res.status}: ${await res.text()}`);
  return (await res.json()) as DecisionResponse;
}

// ---------------------------------------------------------------------------
// Deterministic text cues.
//
// Laya is a small local model with a 512-1024 token context (see the header), so
// the decisive features are extracted HERE, in TypeScript, and handed to Laya as a
// handful of short fields instead of a wall of prose. Every field is a count or a
// boolean read straight off the text. Nothing here calls a model, reads config or
// touches the disk, so the question text stays testable off-line (ops/laya-eval.ts).
// ---------------------------------------------------------------------------
export type TextCues = {
  /** What the work touches: a user interface, only documents, or ordinary code. */
  type: "ui" | "docs" | "code";
  /** Distinct file names mentioned in the text (paths with a known extension). */
  files: number;
  /** high = UI, more than three files, or a refactor/migration/rewrite/integration word. */
  risk: "low" | "high";
  size: "small" | "medium" | "large";
  /** Reads as a question or a status request rather than an instruction. */
  question: boolean;
  /** Rough count of "1) 2)", numbered lines and "and"/"plus" joins = separate parts. */
  parts: number;
  /** Names our own platform/tooling rather than one product the company sells. */
  platform: boolean;
  /** long = migration/audit/rebuild/company-wide words, i.e. where a plan must survive many steps. */
  horizon: "short" | "long";
};

export function clip(text: string, max: number): string {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function textCues(text: string): TextCues {
  const raw = String(text ?? "");
  const t = raw.toLowerCase();
  const paths = t.match(/[a-z0-9_./\\-]+\.(ts|tsx|js|jsx|mjs|cjs|md|txt|json|css|html|vue|svelte|yml|yaml)\b/g) ?? [];
  const files = new Set(paths.map((p) => p.split(/[\\/]/).pop() ?? p)).size;
  const ui = /\b(ui|css|html|view|views|button|layout|page|pill|card|style|styles|component|render|responsive|dashboard|nav|navigation|front-?end)\b/.test(t);
  const docs = /\b(doc|docs|documentation|readme|markdown|changelog|guide|note|notes|handbook|runbook)\b/.test(t);
  const hard = ui || files > 3 || /\b(refactor|migrate|migration|rewrite|architecture|multi-file|integrat\w*|clone|port)\b/.test(t);
  const longHorizon = /\b(migrat\w*|audit|rebuild|overhaul|company-wide|entire|all projects|long-horizon|no downtime)\b/.test(t);
  const question =
    /\?\s*$/.test(raw.trim()) ||
    /^(what|why|how|when|who|which|where|is|are|was|do|does|did|can|could|should|list|show|tell|summari[sz]e)\b/i.test(raw.trim());
  const parts = (raw.match(/(^|\n)\s*(\(\d+\)|\d+[.)])\s|\band\b|\bplus\b|\balso\b/gi) ?? []).length;
  const platform = /\b(dashboard|fleet|terminals?|router|platform core|our own platform|ops\/|public\/|v2|nav(igation)?|panel|agent office|briefing|ceo dashboard|docs?\/)\b/.test(t);
  return {
    type: ui ? "ui" : docs ? "docs" : "code",
    files,
    risk: hard ? "high" : "low",
    size: raw.length > 1200 ? "large" : raw.length > 300 ? "medium" : "small",
    question,
    parts,
    platform,
    horizon: longHorizon ? "long" : "short",
  };
}

// ---------------------------------------------------------------------------
// Question specs.
//
// Each spec is the exact `state` + `instructions` + `criteria` sent to Laya. The
// real callers below use these functions, and ops/laya-eval.ts measures these same
// functions, so what is measured is exactly what ships (no copies to drift).
// ---------------------------------------------------------------------------

export type ChoiceSpec = {
  state: Record<string, unknown>;
  question: { type: "choice"; instructions: string; criteria: Record<string, string> };
};
// ---------------------------------------------------------------------------
// Question specs.
//
// Each spec is the exact `state` + questions sent to Laya, plus `decide()`, which
// turns the raw answers into the decision and the note that goes in the trace. The
// real callers below use these functions, and ops/laya-eval.ts measures these same
// functions, so what is measured is exactly what ships (no copies to drift).
//
// Why `noul` for some questions: measured on the live local Laya (docs/LAYA_TUNING.md),
// a 3-or-4-way choice collapses onto one option no matter how the criteria are
// written or ordered (a 3-way model choice answered "kimi" for 80% of cases,
// including a one-word README typo). A pair of yes/no probability questions asked in
// the same call separates the cases instead, so where the decision is really a
// threshold the spec asks for a probability and thresholds it here, in TypeScript.
// ---------------------------------------------------------------------------

export type LayaQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string };

export type LayaAnswer = {
  choice?: string;
  noul?: number;
  confidence?: number;
  answer_confidence?: number;
  probabilities?: Record<string, number>;
};

export type LayaSpec = {
  state: Record<string, unknown>;
  questions: Record<string, LayaQuestion>;
  /** The decision, plus the note for the trace and the numbers the gate uses. */
  decide: (a: Record<string, LayaAnswer | undefined>) => { choice: string; note: string; value?: number; margin?: number };
};

/** The winner and its lead in a set of probabilities. */
export function topTwo(values: number[]): { top: number; lead: number } {
  const sorted = [...values].sort((x, y) => y - x);
  return { top: sorted[0] ?? 0, lead: (sorted[0] ?? 0) - (sorted[1] ?? 0) };
}

const COMPLEXITY_QUESTIONS = {
  tiny: {
    type: "noul" as const,
    instructions: "Is this ONE small change in ONE file: a lookup, a format, a rename, a one-line fix or a short text file, with no multi-step reasoning? Answer high only for that.",
  },
  multi: {
    type: "noul" as const,
    instructions: "Does this take several files or several areas and a chain of steps (multi-file edit, tool orchestration, code-heavy work)? Answer high only for that.",
  },
  long: {
    type: "noul" as const,
    instructions: "Is this long-horizon or unclear: architecture, a migration, an audit, a high-risk change, or requirements nobody has pinned down? Answer high only for that.",
  },
};

export function complexityQuestionSpec(prompt: string, taskHint = ""): LayaSpec {
  const c = textCues(prompt);
  return {
    state: {
      task: clip(prompt, 700),
      hint: clip(taskHint, 200),
      files: c.files,
      risk: c.risk,
      horizon: c.horizon,
      size: c.size,
    },
    questions: COMPLEXITY_QUESTIONS,
    decide: (a) => {
      const l = a.long?.noul ?? 0;
      const m = a.multi?.noul ?? 0;
      const t = a.tiny?.noul ?? 0;
      const { top, lead } = topTwo([l, m, t]);
      const predicted: TaskComplexity = l >= 0.5 ? "DEMANDING" : m >= 0.5 ? "COMPLEX" : t >= 0.5 ? "ROUTINE" : "STANDARD";
      return { choice: predicted, note: `noul long=${l.toFixed(2)} multi=${m.toFixed(2)} tiny=${t.toFixed(2)}`, value: top, margin: lead };
    },
  };
}

export function brainQuestionSpec(prompt: string, taskHint = ""): LayaSpec {
  const c = textCues(prompt);
  return {
    state: {
      task: clip(prompt, 700),
      hint: clip(taskHint, 200),
      risk: c.risk,
      horizon: c.horizon,
      size: c.size,
      files: c.files,
    },
    questions: {
      hard: {
        type: "noul",
        instructions:
          "Does this need the HARD brain rather than the standard one: ambiguous requirements, system architecture, a large migration or audit, a high-risk or safety-critical change, or a scope nobody has pinned down? Answer high only when one of those is really true.",
      },
    },
    decide: (a) => {
      const hard = a.hard?.noul ?? 0;
      return { choice: hard >= 0.5 ? "OPUS" : "SONNET", note: `noul hard=${hard.toFixed(2)}`, value: hard, margin: hard >= 0.5 ? hard - 0.5 : 0.5 - hard };
    },
  };
}

export async function classifyComplexity(prompt: string, taskHint = ""): Promise<ComplexityResult> {
  if (config.mockMode) {
    const { mockClassify } = await import("./mock.js");
    return mockClassify(prompt);
  }
  const key = cacheKey("complexity", prompt, taskHint);
  const hit = cacheGet<unknown>(key);
  if (hit !== undefined) return { ...(hit as object) } as Awaited<ReturnType<typeof classifyComplexity>>;
  const spec = complexityQuestionSpec(prompt, taskHint);
  const out = await decisionCall(spec.state, spec.questions);
  const d = spec.decide(out.answers);
  const a = out.answers.complexity ?? {};
  const result = {
    predicted: d.choice as TaskComplexity,
    confidence: a.confidence ?? d.value ?? 0,
    probabilities: a.probabilities ?? {},
    model: out.model,
    usage: out.usage,
    reason: d.note,
  };
  cacheSet(key, result);
  return result;
}

export type BrainChoice = "SONNET" | "OPUS";
export type ComplexityResult = { predicted: TaskComplexity; confidence: number; probabilities: Record<string, number>; model: string; usage?: { input_tokens: number; output_tokens: number }; reason?: string };
export type BrainResult = { brain: BrainChoice; confidence: number; reason: string };

export async function classifyBrain(prompt: string, taskHint = ""): Promise<BrainResult> {
  if (config.mockMode) {
    const { mockBrain } = await import("./mock.js");
    return mockBrain(prompt);
  }
  const key = cacheKey("brain", prompt, taskHint);
  const hit = cacheGet<unknown>(key);
  if (hit !== undefined) return { ...(hit as object) } as Awaited<ReturnType<typeof classifyBrain>>;
  const spec = brainQuestionSpec(prompt, taskHint);
  const out = await decisionCall(spec.state, spec.questions);
  const d = spec.decide(out.answers);
  const result = {
    brain: (d.choice.toUpperCase() === "OPUS" ? "OPUS" : "SONNET") as BrainChoice,
    confidence: d.value ?? 0,
    reason: `Decision brain=${d.choice} ${d.note}`,
  };
  cacheSet(key, result);
  return result;
}

export type ModelCandidate = { id: string; via: "gateway" | "qwen-messages" | "claude-subscription"; description: string };

// Full catalog of models the router can use. Laya picks the best one per situation.
// Descriptions encode strength + cost so Laya optimizes quality-per-dollar.
// Each line also says WHEN to pick it, so the choice is a comparison between
// concrete cues instead of a vague "best model" judgement.
export function buildModelCatalog(): ModelCandidate[] {
  return [
    { id: config.models.routine, via: "gateway", description: "Cheapest. One tiny change in one file: a typo, a rename, a format, a single text or markdown file, a small well-defined edit." },
    { id: config.models.standard, via: "gateway", description: "Cheap standard coding. One code file, a small script, an ordinary fix, moderate reasoning, a short tool chain." },
    { id: config.models.complex, via: "gateway", description: "Strong coder. Several files or areas, multi-step coding, tool orchestration, UI work, code-heavy changes." },
    { id: config.models.complexQwen, via: "qwen-messages", description: "Long context and office documents: large files, long documents, research, summarization." },
    { id: config.claudeSonnet, via: "claude-subscription", description: "Brain work with a clear scope: planning, code review, a well-scoped refactor, debugging one area. Fast and efficient." },
    { id: config.claudeOpus, via: "claude-subscription", description: "Hard brain, only when it is really needed: ambiguous requirements, system architecture, a large migration or audit, a high-risk or safety-critical change." },
  ];
}

const BEST_MODEL_INSTRUCTIONS =
  "Pick the single best model for THIS task. Read the state fields (type, files, risk, horizon, size) as well as the task text. Balance required capability against cost: one small change must never use a frontier brain, and ambiguous or high-risk architecture must use Opus.";

export function bestModelQuestionSpec(prompt: string, taskHint = ""): ChoiceSpec {
  const c = textCues(prompt);
  const criteria: Record<string, string> = {};
  for (const m of buildModelCatalog()) criteria[m.id] = m.description;
  return {
    state: {
      task: clip(prompt, 700),
      hint: clip(taskHint, 200),
      type: c.type,
      files: c.files,
      risk: c.risk,
      horizon: c.horizon,
      size: c.size,
    },
    question: { type: "choice", instructions: BEST_MODEL_INSTRUCTIONS, criteria },
  };
}

export async function chooseBestModel(prompt: string, taskHint = "") {
  if (config.mockMode) {
    const { mockChooseModel } = await import("./mock.js");
    return mockChooseModel(prompt);
  }
  const catalog = buildModelCatalog();
  const spec = bestModelQuestionSpec(prompt, taskHint);
  const out = await decisionCall(spec.state, { best_model: spec.question });
  const a = out.answers.best_model;
  const chosenId = (a.choice ?? "") as string;
  const chosen = catalog.find((m) => m.id === chosenId);
  return {
    modelId: chosen?.id ?? config.claudeSonnet,
    via: chosen?.via ?? ("claude-subscription" as const),
    confidence: a.confidence ?? 0,
    probabilities: a.probabilities ?? {},
    reason: `Laya best_model=${a.choice} conf=${(a.confidence ?? 0).toFixed(2)}`,
  };
}

export async function reviewAnswer(question: string, reference: string, answer: string) {
  if (config.mockMode) {
    const { mockReview } = await import("./mock.js");
    return mockReview();
  }
  const out = await decisionCall(
    { question, reference, answer },
    {
      grounded: { type: "noul", instructions: "Is the answer grounded in the reference? Return high probability only if every claim is supported." },
      completeness: {
        type: "score",
        instructions: "How completely does the answer address the question?",
        criteria: ["Missing: ignores question", "Partial: addresses part, omits key qualifications", "Complete: fully addresses with needed qualifications"],
      },
    }
  );
  const grounded = out.answers.grounded?.noul ?? 0;
  const completeness = out.answers.completeness?.score ?? 0;
  const conf = out.answers.completeness?.confidence ?? 0;
  const pass = grounded >= 0.85 && completeness >= 1.5 && conf >= 0.7;
  return { pass, grounded, completeness, confidence: conf, verdict: pass ? "PASS" : "NEEDS_REVIEW" as const };
}
