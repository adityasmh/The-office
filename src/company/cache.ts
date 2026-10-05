import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { NextFunction, Request, Response } from "express";

// ---------------------------------------------------------------------------
// mtime/size-keyed memo helpers for the dashboard read paths.
//
// Why: the CEO dashboard re-read and re-parsed whole files on every poll. A 2 s
// poll of /company/panel used to re-parse org.json, budgets.json, every project's
// tasks.json / thread.jsonl / cost.jsonl and the 4.4 MB memory graph, even when
// nothing had changed (measured on an isolated test server: panelData() 222 ms
// per call, memoryStatus() 149 ms per call).
//
// The rule here is the one PERF_BACKEND was asked for: a file is re-read only
// when its mtime or size changes, so a write is picked up on the next call and a
// no-op poll costs one stat() per file instead of a parse per file.
//
// Every entry is keyed by an arbitrary string, so callers can build composite
// keys (file + revision, several files, ...). The store is bounded; when it is
// full the oldest entry is dropped (a miss only costs a re-read).
// ---------------------------------------------------------------------------

export type Sig = string;

/** Cache key for "the content of this file as of now": mtime + size, or "missing". */
export function fileSig(file: string): Sig {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "missing";
  }
}

/** A composite key out of several signatures (order matters, values are escaped). */
export function sigOf(...parts: Array<string | number | boolean | null | undefined>): Sig {
  return parts.map((p) => (p === null || p === undefined ? "" : String(p).replace(/\|/g, "/"))).join("|");
}

const MAX_ENTRIES = 512;

type Entry = { sig: Sig; value: unknown };
const store = new Map<string, Entry>();
let hits = 0;
let misses = 0;

/**
 * Return the cached value for `key` while its signature is unchanged, else build
 * it. `build` is called at most once per (key, sig) pair.
 */
export function cachedBySig<T>(key: string, sig: Sig, build: () => T): T {
  const hit = store.get(key);
  if (hit && hit.sig === sig) {
    hits++;
    return hit.value as T;
  }
  misses++;
  const value = build();
  if (store.size >= MAX_ENTRIES && !store.has(key)) {
    const oldest = store.keys().next();
    if (!oldest.done) {
      store.delete(oldest.value);
      // A dropped FILE entry must also drop its cached errors/nothing: there is
      // nothing else to clean, entries are independent.
    }
  }
  store.set(key, { sig, value });
  return value;
}

/** Parse a JSON file only when it changed. Returns undefined for missing/corrupt. */
export function cachedJsonFile<T>(file: string): T | undefined {
  return cachedBySig<T | undefined>(`json:${file}`, fileSig(file), () => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as T;
    } catch {
      return undefined;
    }
  });
}

/**
 * Deep copy. Read paths that hand a cached structure to a caller that may mutate
 * it must copy, otherwise one caller's edit would be visible to the next request.
 */
export function cloneDeep<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  try {
    return structuredClone(value);
  } catch {
    // structuredClone is available in Node 18+; this is only a safety net for
    // exotic values (class instances, functions) inside a cached structure.
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

/** Cache size + hit/miss counters, for diagnostics and tests. */
export function cacheStats(): { entries: number; hits: number; misses: number } {
  return { entries: store.size, hits, misses };
}

/** Drop everything (tests; also useful after a bulk data change). */
export function resetCaches(): void {
  store.clear();
}

// ---------------------------------------------------------------------------
// eventLoopLag(): the event-loop-lag number served by GET /health
// (manager's order, 2026-09-29).
//
// Why /health needs it: this router's failure mode all day was "up but not
// answering", and a plain 200 tells you nothing about that. Lag is measured the
// standard way - a 250 ms interval that records how late it actually fired - so a
// value of 2000 ms means every timer and every response waited two seconds behind
// one synchronous chunk. The monitor starts on the first eventLoopLag() call, is
// unref'd (it never keeps the process alive) and keeps the last 240 samples (60 s
// at 250 ms), so p95 reflects the recent window rather than all of boot.
// ---------------------------------------------------------------------------

const LAG_INTERVAL_MS = 250;
const LAG_WINDOW = 240;

let lagSamples: number[] = [];
let lagMax = 0;
let lagTimer: NodeJS.Timeout | null = null;

function ensureLagMonitor(): void {
  if (lagTimer) return;
  try {
    let expected = Date.now() + LAG_INTERVAL_MS;
    lagTimer = setInterval(() => {
      const now = Date.now();
      const lag = Math.max(0, now - expected);
      expected = now + LAG_INTERVAL_MS;
      lagSamples.push(lag);
      if (lagSamples.length > LAG_WINDOW) lagSamples.shift();
      if (lag > lagMax) lagMax = lag;
    }, LAG_INTERVAL_MS);
    lagTimer.unref?.();
  } catch {
    // no timers available: /health simply reports 0
  }
}

export type EventLoopLag = { lagMs: number; lagMaxMs: number; lagP95Ms: number; lagSamples: number };

export function eventLoopLag(): EventLoopLag {
  ensureLagMonitor();
  if (!lagSamples.length) return { lagMs: 0, lagMaxMs: lagMax, lagP95Ms: 0, lagSamples: 0 };
  const sorted = [...lagSamples].sort((a, b) => a - b);
  return {
    lagMs: lagSamples[lagSamples.length - 1],
    lagMaxMs: lagMax,
    lagP95Ms: sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))],
    lagSamples: lagSamples.length,
  };
}

// ---------------------------------------------------------------------------
// precompressedStatic: gzip for the dashboard's own static assets
// (docs/PERF_SPEC.md item 6, PERF-BACKEND).
//
// The spec asked for Cache-Control + gzip on /v2/. `compression` is not
// installed and installing it needs manager approval, so this is the Node zlib
// route the spec allows. Design rules, all chosen to keep express.static
// authoritative for everything it is good at:
//   * GET only - HEAD goes to express.static (no body handling here);
//   * conditional/range requests (If-None-Match, If-Modified-Since, If-Range,
//     Range) are passed through, so 304 revalidation and partial content still
//     come from express.static;
//   * directories and unknown extensions fall through, so "/" still serves
//     index.html from express.static;
//   * the file is gzipped once and reused until its mtime+size changes (the same
//     rule as the rest of this module), so a request costs a stat() and a hash
//     lookup after the first hit;
//   * V2_STATIC_GZIP=0 disables the whole thing.
// Mount it immediately BEFORE express.static, on the same root.
// ---------------------------------------------------------------------------

const COMPRESSIBLE: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

export type PrecompressedStaticOptions = {
  /** Cache-Control max-age for the compressed responses (default 30 s). */
  maxAgeSeconds?: number;
  /** Do not bother below this size (default 1024 bytes). */
  minBytes?: number;
};

export function precompressedStatic(rootDir: string, opts: PrecompressedStaticOptions = {}): (req: Request, res: Response, next: NextFunction) => void {
  const root = path.resolve(rootDir);
  const maxAge = Math.max(0, opts.maxAgeSeconds ?? 30);
  const minBytes = Math.max(0, opts.minBytes ?? 1024);
  const enabled = (process.env.V2_STATIC_GZIP ?? "1") !== "0";
  const MAX_ASSETS = 64;
  const gzCache = new Map<string, { sig: string; buf: Buffer }>();

  return function precompressedStaticMiddleware(req: Request, res: Response, next: NextFunction): void {
    try {
      if (!enabled || req.method !== "GET") return next();
      const acceptEncoding = String(req.headers["accept-encoding"] ?? "");
      if (!/\bgzip\b/i.test(acceptEncoding)) return next();
      if (
        req.headers["if-none-match"] ||
        req.headers["if-modified-since"] ||
        req.headers["if-range"] ||
        req.headers["range"]
      ) {
        return next();
      }

      let urlPath: string;
      try {
        urlPath = decodeURIComponent(String(req.path ?? ""));
      } catch {
        return next();
      }
      if (!urlPath) return next();
      // A directory request ("/", "/v2/") serves index.html, exactly like
      // express.static does; resolve to that file so the shell page is gzipped too.
      const rel = urlPath.endsWith("/") ? `${urlPath}index.html` : urlPath;
      const file = path.resolve(root, `.${rel}`);
      if (file !== root && !file.startsWith(root + path.sep)) return next();
      const mime = COMPRESSIBLE[path.extname(file).toLowerCase()];
      if (!mime) return next();

      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        return next();
      }
      if (!st.isFile() || st.size < minBytes) return next();

      const sig = `${Math.round(st.mtimeMs)}:${st.size}`;
      const hit = gzCache.get(file);
      let buf: Buffer;
      if (hit && hit.sig === sig) {
        buf = hit.buf;
      } else {
        buf = zlib.gzipSync(fs.readFileSync(file), { level: 6 });
        if (gzCache.size >= MAX_ASSETS && !gzCache.has(file)) gzCache.clear();
        gzCache.set(file, { sig, buf });
      }

      res.setHeader("Content-Type", mime);
      res.setHeader("Content-Encoding", "gzip");
      res.setHeader("Vary", "Accept-Encoding");
      res.setHeader("Content-Length", String(buf.length));
      res.setHeader("ETag", `W/"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`);
      res.setHeader("Last-Modified", st.mtime.toUTCString());
      res.setHeader("Cache-Control", `public, max-age=${maxAge}`);
      res.status(200).end(buf);
    } catch {
      // Never turn an asset request into an error: fall back to express.static.
      next();
    }
  };
}

// JOEY-WIRE: build-fix stub for accessLog.ts (a2-hotpath-correlate). The real lag-event
// history should be wired here by the owner of that feature; this keeps the tree compiling.
export type LagEvent = { lagMs: number; at: number; endedAt: number };
export function recentLagEvents(): LagEvent[] {
  return [];
}
