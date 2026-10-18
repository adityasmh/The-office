/**
 * notify.ts - F09: tell a webhook when a fleet order finishes or needs a human.
 *
 * The need (docs/overnight/RESEARCH.md): a long fleet run has to be able to reach the CEO
 * outside the Slack bridge - Discord, Slack, ntfy or any endpoint that accepts a POST.
 *
 * Settings (all optional; NOTIFY_WEBHOOK_URL unset means the feature is OFF and nothing runs):
 *   NOTIFY_WEBHOOK_URL  the endpoint a short JSON/text POST is sent to
 *   NOTIFY_FORMAT       json (default) | slack | discord | ntfy
 *   NOTIFY_EVENTS       comma list; default: done,failed,awaiting_approval
 *   NOTIFY_DRY_RUN=1    build the payload and LOG it, send nothing
 *
 * Hard rules this module exists to honour:
 *   1. NEVER throw. A notification is a courtesy; it must not be able to fail an order.
 *   2. NEVER contain report text, file contents or any env value. The payload is the order id,
 *      the first 120 characters of the order text, the status and the PR links, nothing else.
 *   3. NEVER log the webhook URL. A log line names only its host (a token in the path stays out
 *      of the log), and any error text has the URL scrubbed out before it is printed.
 *   4. One POST per (order id, event) for the life of the process.
 *
 * Node built-ins only (fetch, AbortController).
 */

/** The events the fleet wires in: finished, failed, or waiting for the CEO's approval. */
export const NOTIFY_DEFAULT_EVENTS = ["done", "failed", "awaiting_approval"] as const;

/** How long a single POST may take before it is aborted. */
export const NOTIFY_TIMEOUT_MS = 5000;

/** How much of the order text the payload carries. */
export const NOTIFY_TEXT_MAX = 120;

export type NotifyFormat = "json" | "slack" | "discord" | "ntfy";

/**
 * The only fields of a fleet order notify() reads. Deliberately structural (no import of
 * fleet.ts, which imports this module) and deliberately narrow: report text, reviews, plans
 * and file paths are not part of it, so they cannot leak into a payload.
 */
export type NotifyOrder = {
  id?: string;
  text?: string;
  status?: string;
  workOrders?: Array<{ id?: string; prUrl?: string }>;
};

/** The exact payload for NOTIFY_FORMAT=json. Shape check: ops/notify-check.ts. */
export type NotifyPayload = {
  event: string;
  id: string;
  /** the first NOTIFY_TEXT_MAX characters of the order text */
  text: string;
  status: string;
  /** PR links, when the work orders have them */
  prs: Array<{ id: string; url: string }>;
};

export type NotifyOutcome = "sent" | "dry-run" | "off" | "skipped-event" | "duplicate" | "error";

export type NotifyResult = {
  outcome: NotifyOutcome;
  payload?: NotifyPayload;
  httpStatus?: number;
  detail?: string;
};

/** One entry per (order id, event) already handled in this process. */
const handled = new Set<string>();

function envStr(name: string): string {
  return (process.env[name] ?? "").trim();
}

/** NOTIFY_EVENTS split on commas, lower-cased; the default list when unset. */
function notifyEvents(): string[] {
  const raw = envStr("NOTIFY_EVENTS");
  const list = (raw || NOTIFY_DEFAULT_EVENTS.join(","))
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.length ? list : [...NOTIFY_DEFAULT_EVENTS];
}

/** NOTIFY_FORMAT, falling back to "json" for anything unknown or unset. */
function notifyFormat(): NotifyFormat {
  const raw = envStr("NOTIFY_FORMAT").toLowerCase();
  return raw === "slack" || raw === "discord" || raw === "ntfy" ? raw : "json";
}

function dryRun(): boolean {
  return envStr("NOTIFY_DRY_RUN") === "1";
}

/** The host of the webhook URL, or a safe placeholder. The only part of the URL ever logged. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(invalid url)";
  }
}

/** Remove the webhook URL from any text before it is logged (a token may live in the path). */
function scrub(text: string, url: string): string {
  return url ? String(text).split(url).join("[webhook]") : String(text);
}

/** Build the short payload. Reads only the fields NotifyOrder declares. */
export function buildNotifyPayload(event: string, order: NotifyOrder | null | undefined): NotifyPayload {
  const prs: Array<{ id: string; url: string }> = [];
  for (const wo of Array.isArray(order?.workOrders) ? order!.workOrders! : []) {
    const url = typeof wo?.prUrl === "string" ? wo.prUrl.trim() : "";
    // Only real links: a stray value must never be relayed to a third party.
    if (!/^https?:\/\//i.test(url)) continue;
    prs.push({ id: typeof wo?.id === "string" ? wo.id : "", url });
  }
  return {
    event: String(event ?? "").trim().toLowerCase(),
    id: String(order?.id ?? ""),
    text: String(order?.text ?? "").slice(0, NOTIFY_TEXT_MAX),
    status: String(order?.status ?? ""),
    prs,
  };
}

/** The one-line human sentence used by slack/discord/ntfy. Never includes report text. */
function messageFor(payload: NotifyPayload): string {
  const first = payload.text.replace(/\s+/g, " ").trim();
  const head = `Fleet order ${payload.id} ${payload.event}`;
  const lines = [first ? `${head}: ${first}` : head];
  for (const pr of payload.prs) lines.push(`- ${pr.id ? `${pr.id}: ` : ""}${pr.url}`);
  return lines.join("\n");
}

/** The POST body and headers per format. Each shape matches what the service documents. */
export function notifyRequest(
  format: NotifyFormat,
  payload: NotifyPayload,
): { body: string; contentType: string; headers: Record<string, string> } {
  const message = messageFor(payload);
  if (format === "slack") {
    // Slack incoming webhook: { "text": "..." }
    return { body: JSON.stringify({ text: message }), contentType: "application/json", headers: {} };
  }
  if (format === "discord") {
    // Discord webhook: { "content": "..." }
    return { body: JSON.stringify({ content: message }), contentType: "application/json", headers: {} };
  }
  if (format === "ntfy") {
    // ntfy topic URL: the plain body is the message, Title carries the headline.
    return {
      body: message,
      contentType: "text/plain; charset=utf-8",
      headers: { Title: `Fleet order ${payload.id} ${payload.event}` },
    };
  }
  // json (default): the payload itself.
  return { body: JSON.stringify(payload), contentType: "application/json", headers: {} };
}

/**
 * Notify the webhook about one order event. Never throws, never mutates `order`, and never
 * lets a slow or failing endpoint change an order's state: the caller fires and forgets.
 */
export async function notify(event: string, order: NotifyOrder | null | undefined): Promise<NotifyResult> {
  try {
    const url = envStr("NOTIFY_WEBHOOK_URL");
    if (!url) return { outcome: "off" };

    const ev = String(event ?? "").trim().toLowerCase();
    if (!ev || !notifyEvents().includes(ev)) return { outcome: "skipped-event", detail: "event not in NOTIFY_EVENTS" };

    const key = `${String(order?.id ?? "")}:${ev}`;
    const payload = buildNotifyPayload(ev, order);
    if (handled.has(key)) return { outcome: "duplicate", payload };
    // Recorded before the send: a failed or hanging endpoint is not retried for this event.
    handled.add(key);

    const format = notifyFormat();
    const { body, contentType, headers } = notifyRequest(format, payload);
    const host = hostOf(url);

    if (dryRun()) {
      console.log(`[notify] dry-run ${ev} ${payload.id} -> ${host} (${format}, ${body.length} bytes): ${scrub(body, url)}`);
      return { outcome: "dry-run", payload };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NOTIFY_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": contentType, ...headers },
        body,
        signal: controller.signal,
      });
      // Drain the body so the socket is released (a stub that never ends is still aborted).
      try {
        await res.arrayBuffer();
      } catch {
        /* the response body is irrelevant */
      }
      if (!res.ok) {
        console.warn(`[notify] ${ev} ${payload.id}: ${host} answered ${res.status}`);
        return { outcome: "error", payload, httpStatus: res.status, detail: `HTTP ${res.status}` };
      }
      return { outcome: "sent", payload, httpStatus: res.status };
    } catch (e) {
      const why = scrub(e instanceof Error ? e.message : String(e), url).slice(0, 160);
      console.warn(`[notify] ${ev} ${payload.id}: POST to ${host} failed: ${why}`);
      return { outcome: "error", payload, detail: why };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    // Reached only by an unexpected bug (a broken getter, a bad env): still never throw.
    try {
      const why = String(e instanceof Error ? e.message : e).slice(0, 160);
      console.warn(`[notify] ignored an unexpected error: ${why}`);
    } catch {
      /* ignore */
    }
    return { outcome: "error", detail: "unexpected error" };
  }
}
