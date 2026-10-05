/**
 * src/adaptive/catalog.ts — the model providers ("banks") and their cost ranks.
 *
 * Kept here rather than imported from decision.ts so the adaptive layer cannot be
 * broken by another worker's concurrent edit to the decision cache / planner fix,
 * and so the rule engine has a stable, ordered cost model. The ids default to the
 * same env vars decision.ts reads, so the two catalogs agree on a normal config.
 */
import type { TaskClass, Via } from "./events.js";
// DEEPSEEK DIRECT (docs/DEEPSEEK_DIRECT.md, CEO order 2026-10-01): lets Laya see DeepSeek's
// own API as a second "bank" with a half-price off-peak rate. The ARMED check decides whether
// the fact is shown at all; nothing is added when the flag is off or no key is present, so an
// unconfigured box keeps today's catalog byte-for-byte.
import { deepseekDirectArmed, isDeepseekModel } from "../company/deepseekDirect.js";

export type ModelSpec = {
  id: string;
  via: Via;
  /** 0 = cheapest. Used for ordering and for the per-class capability floor. */
  costRank: number;
  /** Rough USD per call, for the sim's "mean cost per request" (not billing truth). */
  costUsd: number;
  /** Can this model return a tool call when the request needs tools? */
  toolCapable: boolean;
  label: string;
};

export function modelCatalog(): ModelSpec[] {
  const list: ModelSpec[] = [
    {
      id: process.env.ROUTINE_MODEL ?? "glm-5.3-flash",
      via: "gateway",
      costRank: 0,
      costUsd: 0.0004,
      toolCapable: true,
      label: "cheapest small coder",
    },
    {
      id: process.env.STANDARD_MODEL ?? "deepseek-v4-flash",
      via: "gateway",
      costRank: 1,
      costUsd: 0.0009,
      toolCapable: true,
      label: "cheap standard coder",
    },
    {
      id: process.env.COMPLEX_MODEL ?? "kimi-k2.7-code",
      via: "gateway",
      costRank: 2,
      costUsd: 0.0035,
      toolCapable: true,
      label: "strong coder",
    },
    {
      id: process.env.QWEN_MODEL ?? "qwen3.8-flash",
      via: "qwen-messages",
      costRank: 2,
      costUsd: 0.0012,
      toolCapable: false,
      label: "long context / documents",
    },
    {
      id: process.env.CLAUDE_SONNET ?? "claude-sonnet-5-5",
      via: "claude-subscription",
      costRank: 3,
      costUsd: 0.012,
      toolCapable: true,
      label: "brain, clear scope",
    },
    {
      id: process.env.CLAUDE_OPUS ?? process.env.CLAUDE_MODEL ?? "claude-opus-5-5",
      via: "claude-subscription",
      costRank: 4,
      costUsd: 0.06,
      toolCapable: true,
      label: "hard brain",
    },
  ];
  // DEEPSEEK DIRECT (CEO order 2026-10-01): DeepSeek's own API as a second "bank", at HALF
  // PRICE outside DeepSeek's peak hours. Laya is told the FACT here - the label of the
  // DeepSeek entry - and deliberately NOT a new model id: the direct API's own ids
  // (`deepseek-flash`, `deepseek-v4-pro`, measured from GET /models on 2026-10-01) are mapped
  // at the call site by `deepseekDirectModel()`. That way no pick can ever name an id the Go
  // gateway does not serve, which would break the peak-hours fallback.
  if (deepseekDirectArmed()) {
    const note = "DeepSeek direct API available off-peak (0.5x; spends DeepSeek credit, not Go quota)";
    const wanted = process.env.DEEPSEEK_DIRECT_MODEL;
    const target =
      (wanted ? list.find((m) => m.id === wanted) : undefined) ??
      list.find((m) => m.id === (process.env.STANDARD_MODEL ?? "deepseek-v4-flash")) ??
      list.find((m) => isDeepseekModel(m.id));
    if (target) target.label = `${target.label}; ${note}`;
  }
  return list;
}

/** The floor the rule engine may NOT go below for a task class (never downgrade). */
export const CLASS_FLOOR: Record<TaskClass, number> = {
  ROUTINE: 0,
  STANDARD: 1,
  COMPLEX: 2,
  DEMANDING: 3,
};

export function specFor(modelId: string, catalog = modelCatalog()): ModelSpec | undefined {
  return catalog.find((m) => m.id === modelId);
}

/** Cheapest-first ordering with a deterministic tie-break by id. */
export function byCost(a: ModelSpec, b: ModelSpec): number {
  return a.costRank - b.costRank || a.id.localeCompare(b.id);
}

/**
 * Words a CEO order / task hint can use to NAME a model. Used by the hard rule
 * "CEO-named model wins, no exploration".
 */
export const NAME_ALIASES: Record<string, string[]> = {
  glm: ["glm", "glm-5.3-flash"],
  deepseek: ["deepseek", "deepseek-v4-flash"],
  kimi: ["kimi", "kimi-k2.7-code"],
  qwen: ["qwen", "qwen3.8-flash"],
  claude: ["claude", "sonnet", "claude-sonnet-5-5"],
  opus: ["opus", "claude-opus-5-5"],
};

/** If the text names a model, return its specific id where we know one, else the alias. */
export function namedModel(text: string, catalog = modelCatalog()): { alias: string; modelId?: string } | null {
  const t = String(text ?? "").toLowerCase();
  if (!t) return null;
  // Explicit model ids first (most specific).
  for (const m of catalog) if (t.includes(m.id.toLowerCase())) return { alias: m.id, modelId: m.id };
  for (const [alias, words] of Object.entries(NAME_ALIASES)) {
    if (words.some((w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.]/g, "\\.")}([^a-z0-9]|$)`, "i").test(t))) {
      const pick = alias === "opus" ? catalog.find((m) => m.costRank === 4) : catalog.find((m) => m.id.toLowerCase().includes(alias));
      return { alias, modelId: pick?.id };
    }
  }
  return null;
}
