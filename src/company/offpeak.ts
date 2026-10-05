/**
 * src/company/offpeak.ts — the DeepSeek clock (CEO order 2026-10-01).
 *
 * DeepSeek is the only mainstream provider that prices by the CLOCK. Its own pricing
 * footnote, verbatim:
 *
 *   "Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00 and
 *    06:00 - 10:00 UTC, Monday through Friday (all other hours are off-peak)."
 *
 * Three things in that sentence matter:
 *   - TWO peak blocks a day (a 3h block and a 4h block, split by a 2h off-peak gap);
 *   - peak is WEEKDAYS only, so Saturday and Sunday bill off-peak for all 48 hours;
 *   - the discount is uniform (half price on every token type), so the only thing that
 *     decides the bill is WHEN the request runs.
 *
 * The windows are published in UTC and never move. Daylight saving changes only the
 * local mapping; India (IST, UTC+5:30) does not observe DST, so the IST table below is
 * correct all year round:
 *
 *   peak      06:30 - 09:30 and 11:30 - 15:30 IST, Monday to Friday
 *   off-peak  15:30 IST -> 06:30 IST next day, plus all of Saturday and Sunday
 *             (~79% of the week is off-peak)
 *
 * Honest caveat (from DeepSeek's own docs, which we could not resolve): it is NOT stated
 * whether a request is priced by its start or its completion time, and straddling a
 * boundary is undocumented. `DEEPSEEK_BOUNDARY_BUFFER_MINUTES` is therefore a safety
 * margin - we do not start a direct call in the last stretch of an off-peak window.
 *
 * Pure and dependency-free on purpose: the fleet, the router and the ops probes all
 * need the same answer, and it must be testable without a network or a key.
 */

/** Peak blocks in UTC hours [from, to) on a weekday. */
export const DEEPSEEK_PEAK_UTC_BLOCKS: ReadonlyArray<readonly [number, number]> = [
  [1, 4],
  [6, 10],
];

/** Off-peak is exactly half of peak, on every token type. */
export const DEEPSEEK_OFFPEAK_MULTIPLIER = 0.5;

/**
 * Safety margin at a phase boundary. Docs do not say whether a call is priced by start
 * or completion, so a call begun just before a peak block starts could bill at peak.
 */
export const DEEPSEEK_BOUNDARY_BUFFER_MINUTES = 45;

const IST_OFFSET_MINUTES = 330;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export type DeepseekPhase = "peak" | "off-peak";

/** True inside 01:00-04:00 or 06:00-10:00 UTC on a Monday-Friday (UTC weekday). */
export function isDeepseekPeak(at: Date = new Date()): boolean {
  const day = at.getUTCDay(); // 0 Sun .. 6 Sat
  if (day === 0 || day === 6) return false; // the whole UTC weekend is off-peak
  const hour = at.getUTCHours();
  return DEEPSEEK_PEAK_UTC_BLOCKS.some(([from, to]) => hour >= from && hour < to);
}

export function isDeepseekOffPeak(at: Date = new Date()): boolean {
  return !isDeepseekPeak(at);
}

/**
 * The next top-of-hour UTC at which the phase flips. Bounded to 8 days (the week always
 * flips, so the loop always returns early); never throws, never loops forever.
 */
export function nextDeepseekPhaseChange(at: Date = new Date()): Date {
  const base = new Date(at.getTime());
  base.setUTCMinutes(0, 0, 0);
  const was = isDeepseekPeak(base);
  for (let i = 1; i <= 24 * 8; i++) {
    const probe = new Date(base.getTime() + i * 3600_000);
    if (isDeepseekPeak(probe) !== was) return probe;
  }
  return new Date(base.getTime() + 24 * 3600_000); // unreachable, keeps the type honest
}

/** "2026-10-01 16:30 IST (Thu)" — what the CEO asked for: the time in India. */
export function formatIst(at: Date = new Date()): string {
  const t = new Date(at.getTime() + IST_OFFSET_MINUTES * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())} IST (${DAY_NAMES[t.getUTCDay()]})`;
}

/** "2026-10-01 11:00 UTC" — the clock DeepSeek actually bills on. */
export function formatUtc(at: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${at.getUTCFullYear()}-${p(at.getUTCMonth() + 1)}-${p(at.getUTCDate())} ${p(at.getUTCHours())}:${p(at.getUTCMinutes())} UTC`;
}

export type DeepseekClock = {
  phase: DeepseekPhase;
  /** 0.5 off-peak, 1.0 peak: multiply the peak rate card by this. */
  multiplier: number;
  utc: string;
  ist: string;
  nextChangeUtc: string;
  nextChangeIst: string;
  minutesToChange: number;
  /** false when we are inside the boundary buffer (do not start a long call). */
  clearOfBoundary: boolean;
};

export function deepseekClock(at: Date = new Date()): DeepseekClock {
  const phase: DeepseekPhase = isDeepseekPeak(at) ? "peak" : "off-peak";
  const next = nextDeepseekPhaseChange(at);
  const minutesToChange = Math.max(0, Math.round((next.getTime() - at.getTime()) / 60_000));
  return {
    phase,
    multiplier: phase === "peak" ? 1 : DEEPSEEK_OFFPEAK_MULTIPLIER,
    utc: formatUtc(at),
    ist: formatIst(at),
    nextChangeUtc: formatUtc(next),
    nextChangeIst: formatIst(next),
    minutesToChange,
    clearOfBoundary: minutesToChange >= DEEPSEEK_BOUNDARY_BUFFER_MINUTES,
  };
}

/**
 * The IST windows as a human table, used by docs and the ops probe so the doc and the
 * code cannot drift apart.
 */
export const DEEPSEEK_IST_WINDOWS = {
  peak: ["06:30-09:30", "11:30-15:30"],
  offPeak: ["15:30-06:30 (overnight)", "all Saturday and Sunday"],
  peakShareOfWorkday: "56% of a 09:00-17:00 IST day is peak",
  offPeakShareOfWeek: "~79% of the week",
} as const;
