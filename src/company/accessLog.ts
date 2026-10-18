// ---------------------------------------------------------------------------
// accessLog.ts - request access log + event-loop-lag correlation
// (a2-hotpath-correlate, 2026-09-30).
//
// Why: the lag canary in cache.ts says WHEN the event loop was blocked, but
// nothing said WHICH request (or that NO request) was in flight at the time.
// This module keeps a bounded, in-memory access log of every request's method,
// path, start/end timestamp and status, and pairs it with the lag events the
// canary records. hotpathReport() answers "for each recent lag spike, which
// routes were in flight?" - and, crucially, distinguishes a request-triggered
// block (a route is in flight across the spike) from a background block (no
// HTTP request in flight at all; the event loop was held by a watcher tick).
//
// Ring buffers only; nothing is written to disk from here and the cost of a
// request is one Date.now() + one map insert + one array push.
// ---------------------------------------------------------------------------
import type { NextFunction, Request, Response } from "express";
import { recentLagEvents, type LagEvent } from "./cache.js";

export type AccessEntry = {
  seq: number;
  method: string;
  path: string;
  startMs: number; // Date.now() at entry
  endMs: number;   // Date.now() at response finish (0 while in flight)
  status: number;
  durMs: number;
};

const MAX_ENTRIES = 8192;
const entries: AccessEntry[] = [];
let seq = 0;

// In-flight requests keyed by seq so a lag event can be matched against what is
// running right now without scanning the whole ring.
const inFlight = new Map<number, AccessEntry>();

/** Express middleware: record every request's path + start/end timestamps. */
export function accessLogMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startMs = Date.now();
  const rec: AccessEntry = {
    seq: seq++,
    method: req.method,
    path: (req.originalUrl || req.url || "").split("?")[0],
    startMs,
    endMs: 0,
    status: 0,
    durMs: 0,
  };
  inFlight.set(rec.seq, rec);
  res.on("finish", () => {
    rec.endMs = Date.now();
    rec.status = res.statusCode;
    rec.durMs = rec.endMs - rec.startMs;
    inFlight.delete(rec.seq);
    entries.push(rec);
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  });
  next();
}

/**
 * A request is "in flight across" a lag event when it had started by the event's
 * block-start estimate (`at`) and had not yet finished by the event's end
 * (`endedAt`). Because a synchronous handler blocks the loop and only finishes
 * (fires `finish`) after the block, this overlap is the request-triggered signal.
 */
function overlapping(ev: LagEvent): AccessEntry[] {
  const out: AccessEntry[] = [];
  for (const rec of inFlight.values()) {
    if (rec.startMs <= ev.endedAt && (rec.endMs === 0 || rec.endMs >= ev.at)) out.push(rec);
  }
  // Also include requests that ended within the spike window (they are the most
  // likely culprits and may have just finished before the report is read).
  const windowStart = ev.at;
  const windowEnd = ev.endedAt;
  for (let i = entries.length - 1; i >= 0; i--) {
    const r = entries[i];
    if (r.endMs < windowStart) break; // entries are appended in finish order
    if (r.startMs <= windowEnd && r.endMs >= windowStart) out.push(r);
  }
  return out;
}

export type HotpathEvent = LagEvent & {
  inFlight: Array<{ method: string; path: string; durMs: number; status: number }>;
};

/**
 * Recent lag spikes with the routes that were in flight across each one.
 * `minLagMs` filters noise (the canary records >= LAG_EVENT_MIN_MS only).
 */
export function hotpathEvents(minLagMs = 200): HotpathEvent[] {
  const evs = recentLagEvents().filter((e) => e.lagMs >= minLagMs);
  return evs.map((e) => ({
    ...e,
    inFlight: overlapping(e).map((r) => ({ method: r.method, path: r.path, durMs: r.durMs, status: r.status })),
  }));
}

/** Tail of the raw access log, newest last (for the debug endpoint). */
export function accessLogTail(limit = 100): AccessEntry[] {
  return entries.slice(-limit);
}

export function accessLogStats(): { entries: number; inFlight: number } {
  return { entries: entries.length, inFlight: inFlight.size };
}
