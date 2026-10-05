// ---------------------------------------------------------------------------
// src/metrics/alerts.ts - the alert webhook receiver (docs/METRICS_STACK_SPEC.md
// section "Alerts").
//
// vmalert evaluates tools/vm/alerts.yml and POSTs Alertmanager-shaped JSON to
// POST /company/alerts/webhook. This module is the receiver:
//   * dedupe by alertname+labels (the alert's fingerprint), so a firing alert
//     that vmalert re-sends every evaluation creates exactly ONE manager-queue
//     item;
//   * a `routine` alert lands in the EXISTING manager queue
//     (company/reports/manager-queue.json, src/company/managerQueue.ts) - no
//     second queue is invented here;
//   * a `ceo` alert additionally posts ONE Slack message through the existing
//     Slack bridge (src/slack.ts), at most once per alert per 30 minutes;
//   * a `resolved` notification closes the queue item.
//
// No secrets and no prompt text ever reach this module's output: the alert
// payload only ever carries vmalert's own labels/annotations, and every string
// that goes to Slack is passed through slack.ts's redactSecrets().
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getCompanyRoot } from "../company/org.js";
import { readManagerQueue, updateQueueEntry, writeManagerQueue, type ManagerQueueEntry } from "../company/managerQueue.js";
import { postAs, redactSecrets, type Persona, type SlackPostResult } from "../slack.js";

export type AlertSeverity = "routine" | "ceo";

export type AlertmanagerAlert = {
  status?: string; // "firing" | "resolved"
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  startsAt?: string;
  endsAt?: string;
  fingerprint?: string;
  generatorURL?: string;
};

export type AlertmanagerPayload = {
  version?: string;
  /** group status; falls back to per-alert status */
  status?: string;
  groupKey?: string;
  groupLabels?: Record<string, string>;
  commonLabels?: Record<string, string>;
  commonAnnotations?: Record<string, string>;
  externalURL?: string;
  alerts?: AlertmanagerAlert[];
};

type ActiveAlert = {
  name: string;
  severity: AlertSeverity;
  firstAt: string;
  lastAt: string;
  lastSlackAt?: string;
  queueId: string;
};

type AlertState = {
  updatedAt: string;
  active: Record<string, ActiveAlert>;
};

export type AlertSlackReport = { fingerprint: string; alertname: string; posted: boolean; reason: string };

export type AlertReceiveResult = {
  ok: true;
  received: number;
  queued: string[];
  duplicates: string[];
  resolved: string[];
  slack: AlertSlackReport[];
  stateFile: string;
  at: string;
};

// ── knobs ──────────────────────────────────────────────────────────────────
const DEFAULT_SLACK_INTERVAL_MS = 30 * 60_000;

export function alertSlackIntervalMs(): number {
  const raw = Number(process.env.ALERT_SLACK_MIN_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SLACK_INTERVAL_MS;
}

export function alertStateFile(): string {
  return path.join(getCompanyRoot(), "vm-data", "alert-state.json");
}

// ── injected sender (the checks replace this; production uses the real bridge)
export type AlertSlackSender = (text: string) => Promise<SlackPostResult | { posted: boolean; error?: string; mock?: boolean }>;

const ALERT_PERSONA: Persona = "OPUS_MANAGER";

const defaultSlackSender: AlertSlackSender = (text: string) => postAs(ALERT_PERSONA, text);

let slackSender: AlertSlackSender = defaultSlackSender;
let clock: () => number = () => Date.now();

/** Test hook: replace the Slack sender. Pass null to restore the real bridge. */
export function setAlertSlackSender(fn: AlertSlackSender | null): void {
  slackSender = fn ?? defaultSlackSender;
}

/** Test hook: replace the clock (ms since epoch). Pass null to restore. */
export function setAlertClock(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now());
}

/** True when the tests have stubbed the sender (exposed so a check can assert it). */
export function alertSlackSenderIsStub(): boolean {
  return slackSender !== defaultSlackSender;
}

// ── state file ─────────────────────────────────────────────────────────────
function readState(): AlertState {
  try {
    const raw = fs.readFileSync(alertStateFile(), "utf8");
    const parsed = JSON.parse(raw) as AlertState;
    if (parsed && typeof parsed === "object" && parsed.active && typeof parsed.active === "object") {
      return { updatedAt: String(parsed.updatedAt ?? ""), active: parsed.active };
    }
  } catch {
    // missing / corrupt: start clean
  }
  return { updatedAt: "", active: {} };
}

function writeState(state: AlertState): void {
  try {
    const file = alertStateFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ updatedAt: new Date(clock()).toISOString(), active: state.active }, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    // best effort: a state write must never break the webhook response
  }
}

// ── helpers ────────────────────────────────────────────────────────────────
function severityOf(labels: Record<string, string>): AlertSeverity {
  const v = String(labels.severity ?? labels.laya_severity ?? "").trim().toLowerCase();
  return v === "ceo" ? "ceo" : "routine";
}

function alertName(labels: Record<string, string>): string {
  return String(labels.alertname ?? labels.alert ?? "Laya alert").trim() || "Laya alert";
}

/** Alertmanager's own fingerprint rule: alertname + the sorted label set. */
function fingerprintOf(alert: AlertmanagerAlert, labels: Record<string, string>): string {
  const given = String(alert.fingerprint ?? "").trim();
  if (given) return given;
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k] ?? ""}`);
  return crypto.createHash("sha1").update(parts.join(",")).digest("hex").slice(0, 16);
}

/** Plain words for a human. Never the raw payload, never prompt text. */
function plainWords(alert: AlertmanagerAlert, labels: Record<string, string>): string {
  const a = alert.annotations ?? {};
  const summary = String(a.summary ?? a.description ?? a.message ?? "").trim();
  const name = alertName(labels);
  const detail = Object.entries(labels)
    .filter(([k]) => !["alertname", "severity", "laya_severity"].includes(k))
    .slice(0, 4)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  const head = summary || `${name} is firing`;
  const tail = detail ? ` (${detail})` : "";
  const line = redactSecrets(`${head}${tail}`).replace(/[\r\n]+/g, " ").trim();
  return line.length > 300 ? `${line.slice(0, 297)}...` : line;
}

function queueText(severity: AlertSeverity, words: string): string {
  return severity === "ceo"
    ? `CEO alert from the metrics stack: ${words}. The manager queue is looking at it and Slack has been told.`
    : `Routine alert from the metrics stack: ${words}. The manager queue is looking at it.`;
}

/** Insert one entry, or return false when the same alert is already queued. */
function enqueueAlert(queueId: string, name: string, severity: AlertSeverity, words: string, at: string): boolean {
  const items = readManagerQueue();
  const existing = items.find((e) => e.id === queueId && e.state !== "resolved");
  if (existing) return false;
  const entry: ManagerQueueEntry = {
    id: queueId,
    at,
    updatedAt: at,
    kind: "unknown",
    title: name,
    text: queueText(severity, words),
    failureCause: `alert:${severity}`,
    stale: false,
    attempts: 0,
    state: "pending",
    decision: "queued by the metrics alert webhook",
  };
  const resolved = items.findIndex((e) => e.id === queueId);
  if (resolved >= 0) items[resolved] = entry; // reopen an entry that was closed earlier
  else items.push(entry);
  writeManagerQueue(items);
  return true;
}

function closeAlert(queueId: string, at: string): boolean {
  const updated = updateQueueEntry(queueId, { state: "resolved", resolvedAt: at, decision: "the alert resolved" });
  return Boolean(updated);
}

// ── the receiver ───────────────────────────────────────────────────────────
export async function receiveAlerts(payload: AlertmanagerPayload): Promise<AlertReceiveResult> {
  const at = new Date(clock()).toISOString();
  const state = readState();
  const alerts = Array.isArray(payload.alerts) ? payload.alerts : [];
  const queueIds = new Set(readManagerQueue().map((e) => e.id));

  const out: AlertReceiveResult = {
    ok: true,
    received: alerts.length,
    queued: [],
    duplicates: [],
    resolved: [],
    slack: [],
    stateFile: alertStateFile(),
    at,
  };

  for (const alert of alerts) {
    if (!alert || typeof alert !== "object") continue;
    const labels = { ...(payload.commonLabels ?? {}), ...(alert.labels ?? {}) };
    const name = alertName(labels);
    const severity = severityOf(labels);
    const fp = fingerprintOf(alert, labels);
    const queueId = `alert:${fp}`;
    const status = String(alert.status ?? payload.status ?? "firing").toLowerCase() === "resolved" ? "resolved" : "firing";

    if (status === "resolved") {
      const wasActive = Boolean(state.active[fp]);
      delete state.active[fp];
      const closed = closeAlert(queueId, at);
      if (closed || wasActive) out.resolved.push(queueId);
      continue;
    }

    const words = plainWords(alert, labels);
    const active = state.active[fp];

    if (active && queueIds.has(queueId)) {
      // Same alert, still firing: one queue item, no second notice.
      out.duplicates.push(fp);
      active.lastAt = at;
      active.name = name;
    } else {
      const created = enqueueAlert(queueId, name, severity, words, at);
      if (created) {
        queueIds.add(queueId);
        out.queued.push(queueId);
      } else {
        out.duplicates.push(fp);
      }
      state.active[fp] = {
        name,
        severity,
        firstAt: active?.firstAt ?? at,
        lastAt: at,
        ...(active?.lastSlackAt ? { lastSlackAt: active.lastSlackAt } : {}),
        queueId,
      };
    }

    // CEO alerts additionally reach Slack, at most once per alert per interval.
    if (severity === "ceo") {
      const record = state.active[fp]!;
      const last = record.lastSlackAt ? Date.parse(record.lastSlackAt) : 0;
      const now = clock();
      const interval = alertSlackIntervalMs();
      if (last && now - last < interval) {
        out.slack.push({ fingerprint: fp, alertname: name, posted: false, reason: `rate limited: last Slack message ${Math.round((now - last) / 1000)}s ago` });
      } else {
        record.lastSlackAt = new Date(now).toISOString();
        const text = `${words} Manager is looking at it.`;
        let posted = false;
        let reason = "";
        try {
          // The stub in ops/metrics-check.ts is what the tests exercise; the real
          // bridge never rejects and never throws.
          const res = await slackSender(text);
          posted = Boolean(res?.posted);
          reason = String(res?.error ?? (posted ? "posted" : "not posted (mock/console fallback)"));
        } catch (e) {
          reason = `sender threw: ${String(e instanceof Error ? e.message : e)}`;
        }
        out.slack.push({ fingerprint: fp, alertname: name, posted, reason });
      }
    }
  }

  writeState(state);
  return out;
}
