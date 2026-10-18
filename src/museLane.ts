// Free-model lane policy (CEO 2026-10-13: "try not to hit the rate limit ceiling, and if you do find another source").
// Pure logic, no I/O: which free model to try next, cooldown for a model that was rate limited or hung, pacing between
// launches, and how to read the opencode client's error text. src/gateway.ts runs the actual `opencode run` process.
// Why: OpenCode's free tier rate limited muse-spark-1.3-contributor-free on 2026-10-13 after six parallel workers and
// large prompts; the client then retried silently and every router-side step timed out at 180 s.

const MUSE = "opencode/muse-spark-1.3-contributor-free";
const LONGCAT = "opencode/longcat-2.5-preview-free";
const MIMO = "opencode/mimo-v2.6-flash-free";
const STEP5 = "opencode/step-5-preview-free";
const ULTRA = "opencode/nemotron-3-ultra-free";
const SPACE = "opencode/space-bunny-free";
const CATJAM = "opencode/cat-jam-free";

/**
 * All free models used together (CEO 2026-10-14: "use these free models best performances combined"). Every model has its own
 * rate limit, so spreading calls multiplies the capacity, and each kind of job starts with the models that did best on it in
 * ops/free-models-bench2.mjs (three passes, 8 tasks each, docs/MODEL_COMPARISON_2026-10-13.md):
 *  - routine (enhancer, summarizer: short strict outputs, ids glm-*): longcat 24/24 and mimo 8/8 lead, step-5 24/24 next;
 *  - standard (planner and review steps, ids deepseek-*): Muse (proven in this pipeline, 90% of tasks merged on 2026-10-13),
 *    step-5, then nemotron-ultra;
 *  - default (anything else, for example the Claude fallback): Muse first.
 * Left at the end: space-bunny (7/7 valid tasks but its tool use is unmeasured) and cat-jam (fast but misses JSON tasks often).
 * Left out: nemotron-3.5-lightning (a JSON task failed in every pass) and ling-3.1-flash (49-51 s on half the tasks).
 */
export type ChainRole = "routine" | "standard" | "default";
export const FREE_MODEL_PROFILES: Record<ChainRole, string[]> = {
  routine: [LONGCAT, MIMO, STEP5, MUSE, ULTRA, SPACE, CATJAM],
  standard: [MUSE, STEP5, ULTRA, LONGCAT, MIMO, SPACE, CATJAM],
  default: [MUSE, LONGCAT, STEP5, MIMO, ULTRA, CATJAM, SPACE],
};
export const DEFAULT_FREE_MODELS: string[] = FREE_MODEL_PROFILES.default;

/** The pipeline's role model ids (glm-* routine roles, deepseek-* standard roles) pick the profile. */
export function roleForModelId(modelId: string): ChainRole {
  const id = String(modelId ?? "").toLowerCase();
  if (id.startsWith("glm")) return "routine";
  if (id.startsWith("deepseek")) return "standard";
  return "default";
}

/** Alternate the first two entries on every other call, so the two best models share the load instead of one taking all of it. */
export function rotateTopTwo(list: string[], rotation: number): string[] {
  if (list.length < 2 || rotation % 2 === 0) return [...list];
  return [list[1], list[0], ...list.slice(2)];
}

/** The chain for one call. An explicit JCODE_MUSE_MODELS env list wins for every role. */
export function chainFor(role: ChainRole, rotation: number, env: Record<string, string | undefined> = process.env): string[] {
  if (String(env.JCODE_MUSE_MODELS ?? "").trim()) return freeModels(env);
  return rotateTopTwo(FREE_MODEL_PROFILES[role], rotation);
}

export const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000; // a rate limited model rests this long
export const DEFAULT_HUNG_COOLDOWN_MS = 5 * 60 * 1000; // a model that did not answer in time rests this long
export const DEFAULT_MIN_GAP_MS = 1500; // minimum spacing between two launches
export const DEFAULT_MAX_PARALLEL = 3;

export function freeModels(env: Record<string, string | undefined> = process.env): string[] {
  const raw = String(env.JCODE_MUSE_MODELS ?? "").trim();
  if (!raw) return [...DEFAULT_FREE_MODELS];
  const list = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return list.length > 0 ? list : [...DEFAULT_FREE_MODELS];
}

export const DEFAULT_EMPTY_COOLDOWN_MS = 2 * 60 * 1000; // a model that answered with nothing rests this long (likely a transient)
export const DEFAULT_MAX_WAIT_MS = 90 * 1000; // when every model is resting, wait at most this long for the first one

export type FailKind = "rate-limit" | "privacy-gate" | "hung" | "empty" | "other";

/** Classify the text the opencode client printed (stderr with --print-logs) or the error message. */
export function classifyFailure(text: string): FailKind {
  const t = String(text ?? "");
  if (/trains on request data|train(s|ing)? on (your )?(request )?data/i.test(t)) return "privacy-gate";
  if (/rate limit exceeded|rate limit|too many requests|\b429\b/i.test(t)) return "rate-limit";
  if (/returned no text/i.test(t)) return "empty";
  if (/timed out|no answer in/i.test(t)) return "hung";
  return "other";
}

export class ModelCooldowns {
  private until = new Map<string, number>();
  constructor(private readonly now: () => number = () => Date.now()) {}

  mark(
    model: string,
    kind: FailKind,
    cooldownMs = DEFAULT_COOLDOWN_MS,
    hungMs = DEFAULT_HUNG_COOLDOWN_MS,
    emptyMs = DEFAULT_EMPTY_COOLDOWN_MS,
  ): void {
    if (kind === "other") return;
    const span = kind === "hung" ? hungMs : kind === "empty" ? emptyMs : cooldownMs;
    this.until.set(model, this.now() + span);
  }

  /** Models still resting, with the epoch milliseconds when each is usable again (ops/provider-sync.ps1 reads this to steer the coders). */
  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [model, t] of this.until) if (t > this.now()) out[model] = t;
    return out;
  }

  isCooling(model: string): boolean {
    const t = this.until.get(model);
    return t !== undefined && t > this.now();
  }

  /** Models to try now, in preference order. A cooling model is skipped. */
  available(models: string[]): string[] {
    return models.filter((m) => !this.isCooling(m));
  }

  /** Milliseconds until the first cooling model is usable again (0 if none is cooling). */
  soonestMs(models: string[]): number {
    let best = 0;
    for (const m of models) {
      const t = this.until.get(m);
      if (t === undefined) continue;
      const left = t - this.now();
      if (left > 0 && (best === 0 || left < best)) best = left;
    }
    return best;
  }

  clear(): void {
    this.until.clear();
  }
}

/** Spacing between launches: reserve() returns how long the caller must wait before it may start. */
export class Pacer {
  private nextAt = 0;
  constructor(
    private readonly gapMs: number = DEFAULT_MIN_GAP_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  reserve(): number {
    const t = this.now();
    const start = Math.max(t, this.nextAt);
    this.nextAt = start + this.gapMs;
    return start - t;
  }
}
