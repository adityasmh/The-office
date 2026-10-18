/**
 * autoRedo.ts - R3-auto-redo (docs/overnight/ORDER_R3-auto-redo.md, 2026-10-06): when the reviewer
 * says REDO and leaves usable notes, retry ONCE automatically with those notes in the new brief,
 * instead of waiting for the CEO to click "send back". One more small session at most.
 *
 * Settings (both optional; FLEET_AUTO_REDO unset means the feature is OFF and the tick is
 * byte-for-byte what it was before):
 *   FLEET_AUTO_REDO=1    turn the one automatic retry on (default off)
 *   FLEET_AUTO_REDO_MAX  automatic retries per work order (default 1, hard maximum 2)
 *
 * shouldAutoRedo() is deliberately PURE: no I/O, no clock, no mutation. The caller reads the
 * attempt count off the work order, knows where the REDO came from, checks for a free session
 * slot and the company pause flag, and passes the answers in. The one exception, exactly like
 * stuck.ts, is the master switch: with FLEET_AUTO_REDO unset every answer is "do not retry".
 *
 * It NEVER retries when:
 *   - the review carries no notes (there is nothing to hand the worker; a human should look),
 *   - the REDO came from a missing/empty REPORT.md rather than from review notes,
 *   - a red CI check is the ONLY reason (a human should look),
 *   - the notes are identical to the previous attempt's (the worker is not learning; ask the CEO),
 *   - the cap is reached, every session slot is busy, or the company is paused.
 *
 * Proof: ops/auto-redo-check.ts.
 */

/** Default cap: one automatic retry per work order. */
export const AUTO_REDO_DEFAULT_MAX = 1;
/** Hard ceiling: even a larger FLEET_AUTO_REDO_MAX is clamped to this. */
export const AUTO_REDO_HARD_MAX = 2;

function envRaw(name: string): string {
  return (process.env[name] ?? "").trim();
}

/** FLEET_AUTO_REDO=1 turns the automatic retry on; anything else (unset, 0, false) leaves it off. */
export function autoRedoEnabled(): boolean {
  const raw = envRaw("FLEET_AUTO_REDO").toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

/** FLEET_AUTO_REDO_MAX, clamped to [1, AUTO_REDO_HARD_MAX]; default AUTO_REDO_DEFAULT_MAX. */
export function autoRedoMax(): number {
  const raw = envRaw("FLEET_AUTO_REDO_MAX");
  if (!raw) return AUTO_REDO_DEFAULT_MAX;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return AUTO_REDO_DEFAULT_MAX;
  return Math.min(Math.floor(n), AUTO_REDO_HARD_MAX);
}

/** Clamp any cap again, so a caller cannot pass its way past the hard maximum. */
export function clampAutoRedoMax(max?: number | null): number {
  if (typeof max !== "number" || !Number.isFinite(max) || max < 1) return AUTO_REDO_DEFAULT_MAX;
  return Math.min(Math.floor(max), AUTO_REDO_HARD_MAX);
}

/** Everything shouldAutoRedo() needs. No I/O, no env beyond the two knobs above. */
export type AutoRedoInput = {
  /** the verdict just stored for this work order */
  verdict?: "PASS" | "REDO" | null;
  /** redos already spent on this work order (wo.attempts), so the cap counts every redo */
  attempts: number;
  /** the cap for this work order; omit for autoRedoMax(). Always clamped to the hard maximum */
  max?: number | null;
  /** the reviewer's notes for the attempt just graded (empty = nothing to hand the worker) */
  reviewText?: string | null;
  /** the notes the worker was given on the previous attempt, when one was recorded */
  prevReviewText?: string | null;
  /** where the REDO came from: "review" (the default), "empty-report", "ci-red" */
  reason?: string | null;
  /** true when a red CI check is the ONLY reason for the REDO */
  failedCiOnly?: boolean;
  /** is a session slot free right now? */
  slotsFree: boolean;
  /** is the company paused (a planned shutdown)? */
  paused: boolean;
};

export type AutoRedoVerdict = {
  /** true only when the retry should really run */
  redo: boolean;
  /** the retry this would be, 1-based (attempts + 1) */
  attempt: number;
  /** the cap actually applied, after the hard maximum */
  max: number;
  /** plain words for the trace, whether redo is true or false */
  reason: string;
};

/** Collapse whitespace so "the same notes" is a real comparison, not a formatting one. */
function notesKey(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/** Was this REDO the automated PASS floor rejecting a missing/empty REPORT.md? */
function isEmptyReportReason(reason: string | null | undefined): boolean {
  const r = (reason ?? "").trim().toLowerCase();
  return r === "empty-report" || r === "missing-report" || r === "empty report" || r === "missing report";
}

/** Was this REDO caused by a red CI check? (The caller only ever reports it as the sole reason.) */
function isCiReason(reason: string | null | undefined): boolean {
  const r = (reason ?? "").trim().toLowerCase();
  return r === "ci-red" || r === "ci red" || r === "ci";
}

/**
 * Should this REDO be retried automatically? The answer is yes ONLY when the feature is armed,
 * the verdict is REDO, the review left notes, those notes differ from the previous attempt's,
 * the cap is not reached, a session slot is free and the company is not paused.
 */
export function shouldAutoRedo(input: AutoRedoInput): AutoRedoVerdict {
  const max = clampAutoRedoMax(input.max ?? autoRedoMax());
  const attempts =
    typeof input.attempts === "number" && Number.isFinite(input.attempts) && input.attempts > 0
      ? Math.floor(input.attempts)
      : 0;
  const attempt = attempts + 1;
  const no = (reason: string): AutoRedoVerdict => ({ redo: false, attempt, max, reason });

  if (!autoRedoEnabled()) {
    return no("no automatic retry: FLEET_AUTO_REDO is not armed (set FLEET_AUTO_REDO=1 to retry a REDO once)");
  }
  if (input.verdict !== "REDO") {
    return no(`no automatic retry: the verdict is ${input.verdict ?? "unset"}, not REDO`);
  }

  const notes = notesKey(input.reviewText);
  if (!notes) {
    return no("no automatic retry: the review carried no notes to hand the worker (a human should look)");
  }
  if (isEmptyReportReason(input.reason)) {
    return no("no automatic retry: the REDO came from a missing or empty REPORT.md, not from review notes (a human should look)");
  }
  if (input.failedCiOnly || isCiReason(input.reason)) {
    return no("no automatic retry: a red CI check is the only reason for the REDO (a human should look)");
  }

  const previous = notesKey(input.prevReviewText);
  if (previous && previous === notes) {
    return no("no automatic retry: the reviewer's notes are identical to the previous attempt, so the worker is not learning (the CEO should look)");
  }

  if (attempts >= max) {
    return no(`no automatic retry: ${attempts} of ${max} automatic ${max === 1 ? "retry" : "retries"} already used`);
  }
  if (input.paused) {
    return no("no automatic retry: the company is paused for a planned shutdown");
  }
  if (!input.slotsFree) {
    return no("no automatic retry: every session slot is busy, so a retry would sit in the queue");
  }

  return {
    redo: true,
    attempt,
    max,
    reason: `auto redo (attempt ${attempt} of ${max}), with the reviewer's notes in the new brief`,
  };
}
