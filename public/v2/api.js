/* public/v2/api.js — shared client helpers for the v2 dashboard.
 *
 * Contract (docs/UI_V2_SPEC.md):
 *   api(path, {method, body}) -> Promise<JSON>   (bootstraps x-company-token)
 *   poll(fn, ms) -> stop function                (skips while document.hidden)
 *   esc(s)   HTML-escape
 *   ago(iso) "3m ago"
 *   hm(iso)  "17:42:05"
 *
 * PERF (docs/PERF_SPEC.md, PERF-UI): every GET goes through ONE shared store
 * (dedupe of identical in-flight requests + a TTL cache + a sessionStorage
 * mirror), so the shell's stats and the visible view asking for the same path
 * cost one request, and a fresh page load paints from the last cache entry
 * before the network answers. Additive extras: peekData(), invalidate(),
 * storeInfo(). Passing {fresh:true} or {ttl:0} to api() bypasses the cache.
 *
 * Owned by UI-SHELL. Views must not be broken by changes here: everything in
 * this module is additive-only.
 */

/* ------------------------------------------------------------------ *
 * Auth: the control plane requires X-Company-Token on mutating
 * /company/* calls. This page is served from the same loopback origin, so
 * the secret is fetched once from the loopback-only bootstrap endpoint and
 * reused (same logic as companyToken()/api() in public/index.html).
 * ------------------------------------------------------------------ */
let tokenPromise = null;

export function companyToken() {
  if (tokenPromise !== null) return tokenPromise;
  tokenPromise = fetch("/company/auth/bootstrap", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => (d && d.token) || "")
    .catch(() => "");
  return tokenPromise;
}

/* ------------------------------------------------------------------ *
 * The shared data store (PERF-UI, docs/PERF_SPEC.md)
 *
 * Before: every view polled its own endpoints and the shell polled the same
 * ones again, so opening one page could cost 5+ overlapping requests for the
 * same JSON, and the router was re-asked every 2-6 s no matter how slow it
 * was. Now every GET goes through here:
 *   1. identical in-flight requests are deduped (same promise, one request);
 *   2. an answer that arrived less than FRESH_MS ago is reused outright, and a
 *      brand new page load may paint from the last copy ONCE per path (that is
 *      the instant-render case), refreshing behind the caller;
 *   3. every other expired entry is awaited from the network - deliberately, so
 *      a timed poller never keeps rendering its own previous answer: with
 *      stale-while-revalidate on *every* expiry a 10 s poller displays data one
 *      fetch behind forever (the first acceptance run showed exactly that:
 *      `hits=0 staleHits=5` on the Projects list). See the amendment in
 *      docs/AGENT_COORDINATION.md (PERF-UI, 15:25Z).
 *   4. small payloads are mirrored into sessionStorage, so a brand new page
 *      load paints from the last answer before any network call returns.
 * Anything older than MAX_STALE_MS falls back to a real (error-surfacing)
 * request, so a dead router still shows as a dead router.
 * ------------------------------------------------------------------ */
const FRESH_MS = 2000; // only covers requests that arrive together (shell + view)
const MAX_STALE_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 100;
const PERSIST_MAX_BYTES = 200 * 1024; // the old 1.5 MB /company/panel is never mirrored
const PERSIST_KEEP = 40;
const PERSIST_PREFIX = "v2.cache.";

const mem = new Map(); // key -> { data, at, ttl, maxStale }
const inflight = new Map(); // key -> Promise (identical GET already on the wire)
const paintedStale = new Set(); // paths that already used their one stale paint this page load
const counters = { hits: 0, staleHits: 0, revalidated: 0, dedupes: 0, network: 0, persisted: 0, evicted: 0 };

function persistEnabled() {
  try {
    return typeof sessionStorage !== "undefined" && sessionStorage !== null;
  } catch {
    return false; // private mode / storage disabled
  }
}

function readPersist(key) {
  if (!persistEnabled()) return null;
  try {
    const raw = sessionStorage.getItem(PERSIST_PREFIX + key);
    if (!raw) return null;
    const rec = JSON.parse(raw);
    if (!rec || typeof rec.at !== "number" || rec.data === undefined) return null;
    return rec;
  } catch {
    return null;
  }
}

function prunePersist() {
  if (!persistEnabled()) return;
  const rows = [];
  for (let i = 0; i < sessionStorage.length; i++) {
    const k = sessionStorage.key(i);
    if (!k || !k.startsWith(PERSIST_PREFIX)) continue;
    let at = 0;
    try {
      const r = JSON.parse(sessionStorage.getItem(k) || "null");
      at = (r && Number(r.at)) || 0;
    } catch {
      at = 0;
    }
    rows.push([k, at]);
  }
  rows.sort((a, b) => a[1] - b[1]); // oldest first
  const drop = Math.max(1, rows.length - PERSIST_KEEP);
  for (let i = 0; i < drop && i < rows.length; i++) {
    try {
      sessionStorage.removeItem(rows[i][0]);
    } catch {
      /* ignore */
    }
  }
}

function writePersist(key, rec) {
  if (!persistEnabled()) return;
  let text;
  try {
    text = JSON.stringify(rec);
  } catch {
    return;
  }
  if (text.length > PERSIST_MAX_BYTES) return;
  try {
    sessionStorage.setItem(PERSIST_PREFIX + key, text);
    counters.persisted++;
  } catch {
    try {
      prunePersist();
      sessionStorage.setItem(PERSIST_PREFIX + key, text);
      counters.persisted++;
    } catch {
      /* quota full: the in-memory cache still works */
    }
  }
}

function evictMem() {
  while (mem.size > MAX_ENTRIES) {
    let oldestKey = null;
    let oldest = Infinity;
    for (const [k, v] of mem) {
      if (v.at < oldest) {
        oldest = v.at;
        oldestKey = k;
      }
    }
    if (oldestKey === null) break;
    mem.delete(oldestKey);
    counters.evicted++;
  }
}

/**
 * Last cached answer for a GET path (memory first, then sessionStorage), or
 * null. Additive export for views that want to paint before the network
 * answers: `const hit = peekData(path); if (hit) render(hit.data);`
 * -> { data, at, ageMs, ttl, maxStale, fresh, stale }
 */
export function peekData(path) {
  const key = String(path);
  let rec = mem.get(key);
  if (!rec) {
    const p = readPersist(key);
    if (p) {
      rec = { data: p.data, at: p.at, ttl: p.ttl, maxStale: p.maxStale };
      mem.set(key, rec);
      evictMem();
    }
  }
  if (!rec) return null;
  const ageMs = Math.max(0, Date.now() - rec.at);
  return {
    data: rec.data,
    at: rec.at,
    ageMs,
    ttl: rec.ttl,
    maxStale: rec.maxStale,
    fresh: ageMs < rec.ttl,
    stale: ageMs >= rec.ttl,
  };
}

/** Drop cached GET answers whose path starts with `prefix`; returns the count. */
export function invalidate(prefix) {
  const p = prefix === undefined || prefix === null ? "" : String(prefix);
  let n = 0;
  for (const k of [...mem.keys()]) {
    if (!p || k.startsWith(p)) {
      mem.delete(k);
      n++;
    }
  }
  for (const k of [...paintedStale]) {
    if (!p || k.startsWith(p)) paintedStale.delete(k); // re-arm the instant paint
  }
  if (persistEnabled()) {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith(PERSIST_PREFIX) && (!p || k.slice(PERSIST_PREFIX.length).startsWith(p))) {
        try {
          sessionStorage.removeItem(k);
        } catch {
          /* ignore */
        }
      }
    }
  }
  return n;
}

/** Counters for verification (docs/PERF_SPEC.md): hits, dedupes, network, ... */
export function storeInfo() {
  return {
    entries: mem.size,
    inflight: inflight.size,
    maxEntries: MAX_ENTRIES,
    ttlMs: FRESH_MS,
    maxStaleMs: MAX_STALE_MS,
    paintedStale: paintedStale.size,
    persistEnabled: persistEnabled(),
    ...counters,
  };
}

/* The actual network call. `init` is built once per request. */
function fetchJson(path, method, body, signal) {
  const init = { method, cache: "no-store", headers: {} };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  if (signal) init.signal = signal;

  return companyToken()
    .then((t) => {
      if (t) init.headers["x-company-token"] = t;
      return fetch(path, init);
    })
    .then((r) =>
      r.text().then((txt) => {
        let data = null;
        if (txt) {
          try {
            data = JSON.parse(txt);
          } catch {
            data = null;
          }
        }
        if (!r.ok) {
          const msg = (data && (data.error || data.message)) || "HTTP " + r.status;
          const err = new Error(msg);
          err.status = r.status;
          err.data = data;
          err.kind = "http";
          throw err;
        }
        if (data === null) {
          const e2 = new Error(
            "invalid JSON from " + path + " (content-type " + r.headers.get("content-type") + ")",
          );
          e2.kind = "parse";
          e2.status = r.status;
          throw e2;
        }
        return data;
      }),
    )
    .catch((e) => {
      if (e && e.kind) throw e; // already an http/parse error from above
      const err = new Error(e && e.message ? e.message : String(e));
      err.kind = e && e.name === "AbortError" ? "abort" : "network";
      throw err;
    });
}

/** One request per path, shared by everyone waiting on it, cached on success. */
function requestCached(path, method, signal, cacheOpts) {
  const key = String(path);
  const existing = inflight.get(key);
  if (existing) {
    counters.dedupes++;
    return existing;
  }
  counters.network++;
  const p = fetchJson(path, method, undefined, signal)
    .then((data) => {
      const rec = { data, at: Date.now(), ttl: cacheOpts.ttl, maxStale: MAX_STALE_MS };
      mem.set(key, rec);
      evictMem();
      if (cacheOpts.persist !== false) writePersist(key, rec);
      return data;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

export function api(path, opts) {
  const o = opts || {};
  const method = (o.method || (o.body !== undefined ? "POST" : "GET")).toUpperCase();
  const canCache = method === "GET" && o.body === undefined && o.cache !== false && o.ttl !== 0;

  if (!canCache) return fetchJson(path, method, o.body, o.signal);

  const ttl = Number.isFinite(o.ttl) ? Math.max(0, Number(o.ttl)) : FRESH_MS;
  const hit = o.fresh === true ? null : peekData(path);
  if (hit && hit.ageMs < ttl) {
    counters.hits++;
    return Promise.resolve(hit.data); // fresh: no request at all
  }
  const key = String(path);
  if (hit && hit.ageMs < MAX_STALE_MS && !paintedStale.has(key)) {
    // Instant paint, ONCE per path per page load: hand the caller the last copy
    // (a warm reload renders immediately) and refresh behind it. After this the
    // path always awaits the network, so a running poller stays live instead of
    // re-rendering its own previous answer for the life of the page.
    paintedStale.add(key);
    counters.staleHits++;
    requestCached(path, method, undefined, { ttl, persist: o.persist }).catch(() => {});
    return Promise.resolve(hit.data);
  }
  if (hit && o.fresh !== true) counters.revalidated++;
  return requestCached(path, method, o.signal, { ttl, persist: o.persist });
}

/* ------------------------------------------------------------------ *
 * poll(fn, ms, opts): calls fn() immediately, then again ms later.
 *
 * PERF (docs/PERF_SPEC.md item 2): only the visible view polls, and a slow or
 * failing router is not hammered. Guarantees:
 *   - one call at a time (never overlapping; a slow call is not re-entered);
 *   - nothing fires while the tab is hidden, and exactly one call fires as
 *     soon as it becomes visible again (interval resets to the base);
 *   - if a call fails, or takes longer than `slowMs` (default 3x the base,
 *     capped at 10 s), the interval doubles up to `maxMs` (default 60 s);
 *     one quick success resets it to the base.
 * Returns a stop function. fn may return a promise; rejections are swallowed
 * (views render their own error state).
 * ------------------------------------------------------------------ */
export function poll(fn, ms, opts) {
  const o = opts || {};
  const base = Math.max(250, Number(ms) || 5000);
  const maxEvery = Math.max(base, Number(o.maxMs) || 60000);
  const slowMs = Math.max(250, Number(o.slowMs) || Math.min(base * 3, 10000));

  let every = base;
  let stopped = false;
  let timer = null;
  let inFlight = false;

  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

  const schedule = (delay) => {
    if (stopped || timer) return;
    timer = setTimeout(run, Math.max(0, delay));
  };

  const run = () => {
    timer = null;
    if (stopped || inFlight) return;
    if (typeof document !== "undefined" && document.hidden) return; // resume on visibilitychange
    inFlight = true;
    const t0 = now();
    let failed = false;
    Promise.resolve()
      .then(fn)
      .catch(() => {
        failed = true;
      })
      .then(() => {
        const took = now() - t0;
        inFlight = false;
        if (stopped) return;
        if (failed || took > slowMs) {
          every = Math.min(maxEvery, Math.round(every * 2)); // back off
        } else {
          every = base; // healthy again
        }
        schedule(every);
      });
  };

  const stopTimers = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const onVisibility = () => {
    if (stopped) return;
    if (document.hidden) {
      stopTimers();
    } else {
      every = base;
      run();
    }
  };

  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
  run();

  return function stop() {
    stopped = true;
    stopTimers();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibility);
    }
  };
}

/* ------------------------------------------------------------------ *
 * Formatting helpers
 * ------------------------------------------------------------------ */
export function str(v) {
  if (v === null || v === undefined) return "";
  return typeof v === "string" ? v : String(v);
}

export function esc(s) {
  return str(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toDate(iso) {
  if (iso === null || iso === undefined) return null;
  if (iso instanceof Date) return isNaN(iso.getTime()) ? null : iso;
  if (typeof iso === "number") {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  }
  const s = str(iso).trim();
  if (!s) return null;
  // The API emits ISO strings; a bare "2026-09-29 12:00:00" also appears in
  // hand-written company JSON, so accept it too.
  let d = new Date(s);
  if (isNaN(d.getTime()) && s.includes(" ") && !s.includes("T")) {
    d = new Date(s.replace(" ", "T"));
  }
  return isNaN(d.getTime()) ? null : d;
}

/** "17:42:05" in the viewer's local time. Invalid/empty input -> "--:--:--". */
export function hm(iso) {
  const d = toDate(iso);
  if (!d) return "--:--:--";
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

/** "3m ago" / "just now" / "2d ago". Invalid input -> "". */
export function ago(iso) {
  const d = toDate(iso);
  if (!d) return "";
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const days = Math.floor(h / 24);
  if (days < 30) return days + "d ago";
  return d.toISOString().slice(0, 10);
}

/** "$161.83" (2 decimals, dollar sign). Non-finite -> "$0.00". */
export function usd(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "$0.00";
  return "$" + v.toFixed(2);
}

/** ms -> "1.2s" / "2m 03s" / "1h 04m". */
export function dur(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1000) return Math.round(n) + "ms";
  const s = n / 1000;
  if (s < 60) return s.toFixed(1) + "s";
  const whole = Math.floor(s);
  const m = Math.floor(whole / 60);
  const rs = whole % 60;
  if (m < 60) return m + "m " + String(rs).padStart(2, "0") + "s";
  const h = Math.floor(m / 60);
  return h + "h " + String(m % 60).padStart(2, "0") + "m";
}

/** Truncate on a word boundary. */
export function trunc(s, n) {
  const t = str(s);
  if (t.length <= n) return t;
  const cut = t.slice(0, Math.max(0, n - 1));
  const sp = cut.lastIndexOf(" ");
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + "…";
}

/* Task statuses that mean "a pipeline is working on it". Mirrors
 * IN_MOTION in src/company/gates.ts. Views can import this so the shell, the
 * nav counters and every view agree on what "in flight" means. */
export const IN_MOTION = [
  "pending_intake",
  "enhancing",
  "planned",
  "pending_code",
  "coding",
  "testing",
  "opposing",
  "summarizing",
  "adjudicating",
  "pending_merge",
];
export const TERMINAL = ["merged", "rejected", "failed"];

/** Tone name for a task status: "ok" | "warn" | "err" | "run" | "dim". */
export function statusTone(status) {
  const s = str(status);
  if (s === "merged") return "ok";
  if (s === "failed" || s === "rejected") return "err";
  if (s === "pending_intake" || s === "pending_code" || s === "pending_merge") return "warn";
  if (TERMINAL.includes(s)) return "dim";
  return "run";
}
