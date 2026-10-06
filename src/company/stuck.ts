/**
 * stuck.ts - R2-stuck-detector: flag a worker that is burning time without progress.
 *
 * Why (order R2, 2026-10-06): order fomuvs258c spent ~8 minutes and ~147k tokens deliberating
 * and never edited its file. Nobody noticed until it vanished. Fleet terminals are visible
 * windows and are never killed by the system, so the answer is an early FLAG, never a kill.
 *
 * Settings (all optional; FLEET_STUCK unset means the feature is OFF and the tick is unchanged):
 *   FLEET_STUCK=1           turn the detector on (default off)
 *   FLEET_STUCK_MINUTES     how long a work order may run without progress (default 8)
 *   FLEET_STUCK_TOKENS      how many session tokens it may spend without progress (default 400000; the journal total is cumulative and grows fast on healthy sessions)
 *
 * isStuck() is deliberately PURE: no I/O, no clock, no mutation. The caller does the file
 * comparisons ("did an owned file change?") and the token read, and passes the answers in.
 * A verdict of `stuck: false` when `alreadyFlagged` is true means "do not raise a SECOND flag";
 * the caller still clears an existing flag when progress appears (see tickFleet).
 *
 * Never kills, stops or messages a worker: this module only ever answers a yes/no question.
 *
 * Proof: ops/stuck-check.ts.
 */

/** Default "too long with no progress" limit, in minutes. */
export const STUCK_DEFAULT_MINUTES = 8;
/** Default "too many tokens with no progress" limit. */
export const STUCK_DEFAULT_TOKENS = 400000;

function envRaw(name: string): string {
  return (process.env[name] ?? "").trim();
}

function envNum(name: string, fallback: number): number {
  const raw = envRaw(name);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** FLEET_STUCK=1 turns the detector on; anything else (unset, 0, false) leaves it off. */
export function stuckEnabled(): boolean {
  const raw = envRaw("FLEET_STUCK").toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

/** FLEET_STUCK_MINUTES, or STUCK_DEFAULT_MINUTES. */
export function stuckMinutesLimit(): number {
  return envNum("FLEET_STUCK_MINUTES", STUCK_DEFAULT_MINUTES);
}

/** FLEET_STUCK_TOKENS, or STUCK_DEFAULT_TOKENS. */
export function stuckTokensLimit(): number {
  return envNum("FLEET_STUCK_TOKENS", STUCK_DEFAULT_TOKENS);
}

/** Everything isStuck() needs. No I/O, no env beyond the three knobs above. */
export type StuckInput = {
  /** when the work order started (ISO string or epoch ms); the caller falls back to the order */
  startedAt?: string | number | null;
  /** epoch ms "now" */
  now: number;
  /** the session's total tokens so far, or undefined when the journal gives none (minutes only) */
  tokens?: number | null;
  /** does the work order's REPORT.md exist? */
  reportExists: boolean;
  /** did ANY file the work order owns change since it started? (empty owns: any repo file) */
  ownedChanged: boolean;
  /** is the work order already carrying the stuck flag? */
  alreadyFlagged: boolean;
};

export type StuckVerdict = {
  /** true only when a NEW flag should be raised (false when already flagged / off / making progress) */
  stuck: boolean;
  /** plain-words reason naming minutes and tokens; empty when not stuck */
  reason: string;
};

/** ISO string or epoch ms -> epoch ms, or undefined when it cannot be read. */
function toMs(value: string | number | null | undefined): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || !value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Is this work order stuck? Stuck ONLY when, with the detector on, the work order is not
 * already flagged, it has no REPORT.md, none of its owned files changed since it started,
 * and it has either run longer than the minutes limit OR spent more than the token limit.
 *
 * `tokens` may be undefined (the jcode journal had no token_usage): then the minutes rule
 * alone decides, exactly as the order requires.
 */
export function isStuck(input: StuckInput): StuckVerdict {
  if (!stuckEnabled()) return { stuck: false, reason: "" };
  if (input.alreadyFlagged) return { stuck: false, reason: "" };
  if (input.reportExists) return { stuck: false, reason: "" };
  if (input.ownedChanged) return { stuck: false, reason: "" };

  const now = Number(input.now);
  if (!Number.isFinite(now)) return { stuck: false, reason: "" };

  const startedMs = toMs(input.startedAt);
  const minutes = startedMs === undefined ? 0 : Math.max(0, Math.floor((now - startedMs) / 60000));
  const tokens =
    typeof input.tokens === "number" && Number.isFinite(input.tokens) ? input.tokens : undefined;

  const minutesLimit = stuckMinutesLimit();
  const tokensLimit = stuckTokensLimit();
  const byMinutes = startedMs !== undefined && minutes > minutesLimit;
  const byTokens = tokens !== undefined && tokens > tokensLimit;
  if (!byMinutes && !byTokens) return { stuck: false, reason: "" };

  const tokenText = tokens === undefined ? "an unreadable number of" : String(tokens);
  const minuteText = `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const reason =
    `possibly stuck: ${minuteText} since it started (limit ${minutesLimit}) and ` +
    `${tokenText} tokens (limit ${tokensLimit}); no REPORT.md and no owned file changed since it started`;
  return { stuck: true, reason };
}
