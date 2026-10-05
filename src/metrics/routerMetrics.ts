// ---------------------------------------------------------------------------
// src/metrics/routerMetrics.ts - the router's own Prometheus text (spec:
// docs/METRICS_STACK_SPEC.md section "Sources to build" 1).
//
// Served at GET /company/metrics (loopback reads are exempt from the company
// token, like every other GET /company/*). It answers from memory plus the
// already-cached company readers; the heavier aggregations (fleet, tasks,
// queues, spend) sit behind a short TTL snapshot so a 5 s scrape does not turn
// into a per-scrape filesystem walk on a box where sync IO is the known hazard.
//
// Nothing here writes: it is a read-only view, so it can never spend budget.
// ---------------------------------------------------------------------------
import type { NextFunction, Request, Response } from "express";
import { eventLoopLag } from "../company/cache.js";
import { budgetTotals } from "../company/budget.js";
import { loadFleetOrders } from "../company/fleet.js";
import { loadTasks } from "../company/gates.js";
import { managerQueueSummary } from "../company/managerQueue.js";
import { openNeedsYouItems } from "../company/needsYouActions.js";
import { loadOrg } from "../company/org.js";
import { sessionCounts } from "../company/sessions.js";
import { loadTerminals } from "../company/terminalReaper.js";

// ── per-route request counters (in memory only) ────────────────────────────
// A bounded map: a route family, not one series per URL. The cap keeps a
// pathological caller from growing the map forever; once it is reached new
// labels are folded into "(other)" instead of being dropped silently.
const ROUTE_LIMIT = 200;
const OTHER = "(other)";
const DURATION_BUCKETS_MS = [5, 25, 100, 500, 2000, 5000];

type RouteStat = {
  count: number;
  sumMs: number;
  maxMs: number;
  /** cumulative count per bucket (len = DURATION_BUCKETS_MS.length + 1 for +Inf) */
  buckets: number[];
};

const routes = new Map<string, RouteStat>();
let requestsSkipped = 0;

/** Routes whose own traffic would only add noise (the scraper's loop). */
function skipped(path: string): boolean {
  return (
    path === "/health" ||
    path === "/company/metrics" ||
    path.startsWith("/company/metrics/") ||
    path.startsWith("/favicon")
  );
}

function routeLabel(req: Request): string {
  const r = req as unknown as { route?: { path?: string }; baseUrl?: string };
  if (r.route?.path) return `${r.baseUrl ?? ""}${r.route.path}`;
  // An unmatched path (404) or an error before routing: keep only the first two
  // segments so /company/projects/:id/... does not explode into one series per id.
  const parts = String(req.path ?? "").split("/").filter(Boolean);
  return "/" + parts.slice(0, 2).join("/");
}

const OVERFLOW: RouteStat = { count: 0, sumMs: 0, maxMs: 0, buckets: new Array(DURATION_BUCKETS_MS.length + 1).fill(0) };

function statFor(key: string): RouteStat {
  let s = routes.get(key);
  if (s) return s;
  if (routes.size >= ROUTE_LIMIT) {
    // Fold into "(other)" - and if THAT is the key we are already overflowing,
    // count into a throwaway row rather than recursing.
    if (key === OTHER) return OVERFLOW;
    return statFor(OTHER);
  }
  s = { count: 0, sumMs: 0, maxMs: 0, buckets: new Array(DURATION_BUCKETS_MS.length + 1).fill(0) };
  routes.set(key, s);
  return s;
}

/**
 * Express middleware: one Date.now() + one map bump per finished request.
 * Registered by installMetrics() (src/metrics/index.ts) before the routes.
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (skipped(String(req.path ?? ""))) {
    requestsSkipped += 1;
    next();
    return;
  }
  const start = Date.now();
  res.on("finish", () => {
    try {
      const durMs = Date.now() - start;
      const key = `${req.method} ${routeLabel(req)} ${res.statusCode}`;
      const s = statFor(key);
      s.count += 1;
      s.sumMs += durMs;
      if (durMs > s.maxMs) s.maxMs = durMs;
      for (let i = 0; i < DURATION_BUCKETS_MS.length; i++) {
        if (durMs <= DURATION_BUCKETS_MS[i]!) s.buckets[i]! += 1;
      }
      s.buckets[DURATION_BUCKETS_MS.length]! += 1; // +Inf
    } catch {
      // counting must never break a response
    }
  });
  next();
}

/** Test hook: how many request series are tracked (and how many were skipped). */
export function requestCounterStats(): { series: number; skipped: number } {
  return { series: routes.size, skipped: requestsSkipped };
}

/** Test hook: drop the counters. */
export function resetRequestCounters(): void {
  routes.clear();
  requestsSkipped = 0;
}

// ── the heavier company view, behind a short TTL ───────────────────────────
export type CompanySnapshot = {
  at: number;
  fleetOrders: Record<string, number>;
  fleetFailedRecent: number;
  fleetFailedByCause: Record<string, number>;
  workOrders: Record<string, number>;
  tasks: Record<string, number>;
  sessions: { running: number; queued: number; total: number };
  terminals: Record<string, number>;
  needsYouOpen: number;
  managerQueue: { pending: number; autoRetried: number; escalated: number; resolved: number; total: number };
  spendUsd: number;
};

const SNAPSHOT_TTL_MS = Math.max(1000, Number(process.env.METRICS_SNAPSHOT_TTL_MS) || 10_000);
const FAILED_WINDOW_MS = 15 * 60_000;
let snapshot: CompanySnapshot | null = null;

function bump(map: Record<string, number>, key: string | undefined): void {
  const k = key && key.trim() ? key.trim() : "unknown";
  map[k] = (map[k] ?? 0) + 1;
}

function buildSnapshot(): CompanySnapshot {
  const now = Date.now();
  const orders = loadFleetOrders();
  const fleetOrders: Record<string, number> = {};
  const workOrders: Record<string, number> = {};
  const fleetFailedByCause: Record<string, number> = {};
  let fleetFailedRecent = 0;
  for (const o of orders) {
    bump(fleetOrders, o.status);
    for (const wo of o.workOrders ?? []) bump(workOrders, wo.state);
    if (o.status === "failed") {
      const at = Date.parse(o.updatedAt || o.createdAt || "");
      if (Number.isFinite(at) && now - at <= FAILED_WINDOW_MS) {
        fleetFailedRecent += 1;
        bump(fleetFailedByCause, o.failureCause);
      }
    }
  }

  const tasks: Record<string, number> = {};
  for (const p of loadOrg().projects) {
    for (const t of loadTasks(p.id)) bump(tasks, t.status);
  }

  const terminals: Record<string, number> = {};
  for (const t of loadTerminals()) bump(terminals, t.state);

  const q = managerQueueSummary();
  return {
    at: now,
    fleetOrders,
    fleetFailedRecent,
    fleetFailedByCause,
    workOrders,
    tasks,
    sessions: sessionCounts(),
    terminals,
    needsYouOpen: openNeedsYouItems().length,
    managerQueue: { pending: q.pending, autoRetried: q.autoRetried, escalated: q.escalated, resolved: q.resolved, total: q.total },
    spendUsd: budgetTotals().spentUsd,
  };
}

export function companySnapshot(): CompanySnapshot {
  if (snapshot && Date.now() - snapshot.at < SNAPSHOT_TTL_MS) return snapshot;
  snapshot = buildSnapshot();
  return snapshot;
}

/** Test hook: force the next read to rebuild. */
export function resetCompanySnapshot(): void {
  snapshot = null;
}

// ── rendering ──────────────────────────────────────────────────────────────
// HELP/TYPE are declared ONCE per family (a duplicate declaration is a parse
// error for a Prometheus/VM scraper), then the series follow.
const GAUGES: Array<[string, string]> = [
  ["laya_router_up", "1 while the router answers this scrape."],
  ["laya_router_uptime_seconds", "Seconds since the router process started."],
  ["laya_router_build_info", "Router build/version label."],
  ["laya_router_eventloop_lag_ms", "How late a 250 ms timer actually fired (last sample)."],
  ["laya_router_eventloop_lag_p95_ms", "p95 event-loop lag over the last 60 s."],
  ["laya_router_eventloop_lag_max_ms", "Worst event-loop lag since boot."],
  ["laya_router_eventloop_lag_samples", "Lag samples in the ring."],
  ["laya_router_fleet_orders", "Fleet orders by status."],
  ["laya_router_fleet_work_orders", "Fleet work orders by state."],
  ["laya_router_fleet_orders_failed_recent", "Fleet orders that failed in the last 15 minutes."],
  ["laya_router_fleet_orders_failed_by_cause", "Fleet orders that failed in the last 15 minutes, by failure cause."],
  ["laya_router_tasks", "Pipeline tasks by status (every project)."],
  ["laya_router_sessions_total", "Company sessions recorded."],
  ["laya_router_sessions", "Sessions by status."],
  ["laya_router_terminals", "Terminals (jcode/opencode windows) by state."],
  ["laya_router_terminals_total", "Terminals recorded in the registry."],
  ["laya_router_needs_you_open", "Open needs-you items waiting for a person."],
  ["laya_router_manager_queue_total", "Manager-queue entries."],
  ["laya_router_manager_queue_items", "Manager-queue entries by state."],
  ["laya_router_spend_usd_total", "Measured spend from the agent budget ledger (USD)."],
  ["laya_router_metrics_error", "1 when this endpoint could not build its view."],
];

const COUNTERS: Array<[string, string]> = [
  ["laya_router_http_requests_total", "HTTP requests by method, route and status."],
  ["laya_router_http_request_duration_ms_bucket", "Request duration histogram buckets (ms)."],
  ["laya_router_http_request_duration_ms_sum", "Total time spent in requests (ms)."],
  ["laya_router_http_request_duration_ms_count", "Requests observed (ms histogram)."],
];

/** Escape a Prometheus label value. */
function esc(v: string | number): string {
  return String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}

const num = (v: number): string => (Number.isFinite(v) ? String(v) : "0");

/** The full Prometheus text for GET /company/metrics. Never throws. */
export function renderRouterMetrics(): string {
  const series: string[] = [];
  const g = (name: string, value: number | string, labels = ""): void => {
    series.push(`${name}${labels} ${typeof value === "number" ? num(value) : value}`);
  };
  try {
    g("laya_router_up", 1);
    g("laya_router_uptime_seconds", process.uptime());
    g("laya_router_build_info", 1, `{version="${esc(process.env.npm_package_version ?? "0.1.0")}"}`);

    const lag = eventLoopLag();
    g("laya_router_eventloop_lag_ms", lag.lagMs);
    g("laya_router_eventloop_lag_p95_ms", lag.lagP95Ms);
    g("laya_router_eventloop_lag_max_ms", lag.lagMaxMs);
    g("laya_router_eventloop_lag_samples", lag.lagSamples);

    const snap = companySnapshot();
    for (const s of ["planning", "awaiting_approval", "running", "reviewing", "done", "failed", "cancelled"]) {
      g("laya_router_fleet_orders", snap.fleetOrders[s] ?? 0, `{status="${s}"}`);
    }
    for (const s of ["planned", "queued", "starting", "working", "idle", "reported", "reviewed", "failed"]) {
      g("laya_router_fleet_work_orders", snap.workOrders[s] ?? 0, `{state="${s}"}`);
    }
    g("laya_router_fleet_orders_failed_recent", snap.fleetFailedRecent);
    for (const [cause, n] of Object.entries(snap.fleetFailedByCause)) {
      g("laya_router_fleet_orders_failed_by_cause", n, `{cause="${esc(cause)}"}`);
    }

    for (const s of [
      "pending_intake", "enhancing", "planned", "pending_code", "coding", "testing",
      "opposing", "summarizing", "adjudicating", "pending_merge", "merged", "rejected", "failed",
    ]) {
      g("laya_router_tasks", snap.tasks[s] ?? 0, `{status="${s}"}`);
    }

    g("laya_router_sessions_total", snap.sessions.total);
    g("laya_router_sessions", snap.sessions.running, `{status="running"}`);
    g("laya_router_sessions", snap.sessions.queued, `{status="queued"}`);

    let terminalsTotal = 0;
    for (const v of Object.values(snap.terminals)) terminalsTotal += v;
    for (const s of ["working", "reported", "redo", "failed", "needs_ceo", "closed", "kept", "unknown"]) {
      g("laya_router_terminals", snap.terminals[s] ?? 0, `{state="${s}"}`);
    }
    g("laya_router_terminals_total", terminalsTotal);

    g("laya_router_needs_you_open", snap.needsYouOpen);
    g("laya_router_manager_queue_total", snap.managerQueue.total);
    g("laya_router_manager_queue_items", snap.managerQueue.pending, `{state="pending"}`);
    g("laya_router_manager_queue_items", snap.managerQueue.autoRetried, `{state="auto_retried"}`);
    g("laya_router_manager_queue_items", snap.managerQueue.escalated, `{state="escalated"}`);
    g("laya_router_manager_queue_items", snap.managerQueue.resolved, `{state="resolved"}`);
    g("laya_router_spend_usd_total", snap.spendUsd);

    for (const [key, s] of routes) {
      const [method = "GET", route = OTHER, status = "0"] = key.split(" ");
      const m = esc(method);
      const r = esc(route);
      g("laya_router_http_requests_total", s.count, `{method="${m}",route="${r}",status="${esc(status)}"}`);
      for (let i = 0; i < DURATION_BUCKETS_MS.length; i++) {
        g("laya_router_http_request_duration_ms_bucket", s.buckets[i] ?? 0, `{method="${m}",route="${r}",le="${DURATION_BUCKETS_MS[i]}"}`);
      }
      g("laya_router_http_request_duration_ms_bucket", s.buckets[DURATION_BUCKETS_MS.length] ?? 0, `{method="${m}",route="${r}",le="+Inf"}`);
      g("laya_router_http_request_duration_ms_sum", s.sumMs, `{method="${m}",route="${r}"}`);
      g("laya_router_http_request_duration_ms_count", s.count, `{method="${m}",route="${r}"}`);
    }
  } catch (e) {
    // A metrics endpoint that throws is worse than one that is incomplete.
    g("laya_router_metrics_error", 1);
    series.push(`# error: ${String(e instanceof Error ? e.message : e).replace(/[\r\n]+/g, " ")}`);
  }

  const out: string[] = ["# Prometheus text for the Laya metrics stack (docs/METRICS_STACK_SPEC.md)."];
  for (const [name, help] of GAUGES) out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
  for (const [name, help] of COUNTERS) out.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`);
  out.push(...series);
  return out.join("\n") + "\n";
}
