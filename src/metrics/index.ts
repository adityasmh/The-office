// ---------------------------------------------------------------------------
// src/metrics/index.ts - the single wiring point for the metrics stack.
//
// src/server.ts adds exactly ONE line:  installMetrics(app);
// That one call registers the request counter (before the routes), the
// Prometheus endpoint GET /company/metrics, the VictoriaMetrics query proxy
// GET /company/metrics/query?q= and the vmalert receiver
// POST /company/alerts/webhook.
//
// It is registered AFTER the /company guard (src/server.ts line ~344) and AFTER
// express.json(), so the metrics routes inherit the same trust boundary as the
// rest of the control plane: loopback GETs are frictionless, the webhook POST
// carries X-Company-Token like any other mutation.
// ---------------------------------------------------------------------------
import type { Express, Request, Response } from "express";
import { metricsMiddleware, renderRouterMetrics } from "./routerMetrics.js";
import { receiveAlerts, type AlertmanagerPayload } from "./alerts.js";

export { receiveAlerts, setAlertSlackSender, setAlertClock, alertStateFile, alertSlackIntervalMs } from "./alerts.js";
export { renderRouterMetrics, requestCounterStats, resetRequestCounters, companySnapshot, resetCompanySnapshot } from "./routerMetrics.js";

const QUERY_TIMEOUT_MS = 5_000;

/** VictoriaMetrics single-node base URL (the only outbound call this module makes). */
export function vmBaseUrl(): string {
  return (process.env.VM_URL ?? "http://127.0.0.1:8428").replace(/\/+$/, "");
}

/** Install the metrics routes and the request counter. Idempotent per app. */
export function installMetrics(app: Express): void {
  // 1. Request counter. Must be registered before the routes it counts.
  app.use(metricsMiddleware);

  // 2. Prometheus text for the scraper (loopback GET -> no token needed).
  app.get("/company/metrics", (_req: Request, res: Response) => {
    try {
      res.type("text/plain; version=0.0.4; charset=utf-8").send(renderRouterMetrics());
    } catch (e) {
      res.status(500).json({ error: "metrics failed", detail: String(e) });
    }
  });

  // 3. The dashboard's proxy to VictoriaMetrics, so the browser never needs CORS.
  //    Only the read-only instant query path is proxied, with the query bounded.
  app.get("/company/metrics/query", async (req: Request, res: Response) => {
    const q = String(req.query.q ?? "").trim();
    if (!q) {
      res.status(400).json({ error: "q is required", hint: "GET /company/metrics/query?q=up" });
      return;
    }
    if (q.length > 4000) {
      res.status(400).json({ error: "the query is too long" });
      return;
    }
    try {
      const url = `${vmBaseUrl()}/api/v1/query?query=${encodeURIComponent(q)}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(QUERY_TIMEOUT_MS) });
      const body = await r.text();
      res.type("application/json").status(r.status).send(body);
    } catch (e) {
      res.status(502).json({
        error: "VictoriaMetrics is not answering",
        detail: String(e instanceof Error ? e.message : e),
        hint: "start the stack with ops/metrics-up.ps1",
      });
    }
  });

  // 4. The vmalert notifier. Alertmanager-compatible JSON in, bookkeeping out.
  app.post("/company/alerts/webhook", async (req: Request, res: Response) => {
    try {
      const payload = (req.body ?? {}) as AlertmanagerPayload;
      const result = await receiveAlerts(payload);
      res.status(200).json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e instanceof Error ? e.message : e) });
    }
  });
}
