/**
 * ops/notify-check.ts - proof for order F09-notify-webhook (2026-10-06).
 *
 * Checks the REAL src/company/notify.ts against a LOCAL stub HTTP server on 127.0.0.1 (a random
 * port). No real network call is made and nothing outside this process is touched.
 *
 * Every value used here is fake, and no repository .env is opened: the few env values the test
 * needs are set in this process only and restored in a finally block.
 *
 *   npx tsx ops/notify-check.ts
 *
 * Prints PASS or FAIL per line; exit code is 1 if any line is FAIL.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { notify, NOTIFY_TEXT_MAX, type NotifyOrder } from "../src/company/notify.js";

// ── fake, secret-looking values (none is real) ────────────────────────────────
const ENV_SECRETS: Record<string, string> = {
  GITHUB_TOKEN: "ghp" + "_FAKE_NOTIFY_CHECK_TOKEN_0001",
  COMPANY_AUTH_TOKEN: "fake_notify_check_company_token",
  SLACK_BOT_TOKEN: "xox" + "b-fake-notify-check-token",
};
const LEAK_MARKERS = ["PLAN_TEXT_MUST_NOT_LEAK", "ERROR_TEXT_MUST_NOT_LEAK", "REPORT_TEXT_MUST_NOT_LEAK"];
// Longer than NOTIFY_TEXT_MAX so the truncation is observable.
const LONG_TEXT =
  "Fix the flaky publish step in the fleet so a red CI result never publishes a draft PR. ".repeat(6);

type FakeOrder = NotifyOrder & { plan: string; error: string; review: string };

/** A fake order carrying the extra fields a real order has: they must never reach the webhook. */
function order(id: string, status: string, withPr = true): FakeOrder {
  return {
    id,
    text: LONG_TEXT,
    status,
    workOrders: [
      { id: "WO1", ...(withPr ? { prUrl: "https://github.com/acme/repo/pull/123" } : {}) },
      { id: "WO2", ...(withPr ? { prUrl: "https://github.com/acme/repo/pull/124" } : {}) },
    ],
    // A stray value that is not a link must be dropped, not relayed.
    ...(withPr ? {} : {}),
    plan: "PLAN_TEXT_MUST_NOT_LEAK",
    error: "ERROR_TEXT_MUST_NOT_LEAK",
    review: "REPORT_TEXT_MUST_NOT_LEAK",
  } as FakeOrder;
}

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? `  -> ${detail}` : ""}`);
}

// ── log capture (so "the URL never appears in logs" can be checked) ───────────
const logs: string[] = [];
const unpatchers: Array<() => void> = [];
function capture(stream: NodeJS.WriteStream): void {
  const original = stream.write.bind(stream) as (...args: unknown[]) => boolean;
  (stream as unknown as { write: unknown }).write = (chunk: unknown, ...args: unknown[]) => {
    logs.push(typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    return original(chunk, ...args);
  };
  unpatchers.push(() => {
    (stream as unknown as { write: unknown }).write = original;
  });
}
capture(process.stdout);
capture(process.stderr);

// ── local stub server ─────────────────────────────────────────────────────────
type Recorded = { path: string; method: string; headers: http.IncomingHttpHeaders; body: string };
const requests: Recorded[] = [];

const server = http.createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (c: string) => (body += c));
  req.on("end", () => {
    const path = req.url ?? "";
    requests.push({ path, method: req.method ?? "", headers: req.headers, body });
    if (path.startsWith("/err")) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("boom");
    } else if (path.startsWith("/hang")) {
      // Never respond: the client's own timeout must abort the request.
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    }
  });
});

const envBefore: NodeJS.ProcessEnv = { ...process.env };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function setNotifyEnv(url: string | null, format?: string, events?: string, dry?: string): void {
  if (url === null) delete process.env.NOTIFY_WEBHOOK_URL;
  else process.env.NOTIFY_WEBHOOK_URL = url;
  if (format === undefined) delete process.env.NOTIFY_FORMAT;
  else process.env.NOTIFY_FORMAT = format;
  if (events === undefined) delete process.env.NOTIFY_EVENTS;
  else process.env.NOTIFY_EVENTS = events;
  if (dry === undefined) delete process.env.NOTIFY_DRY_RUN;
  else process.env.NOTIFY_DRY_RUN = dry;
}

async function main(): Promise<void> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const HOST = `127.0.0.1:${port}`;
  const URL = `http://${HOST}`;
  const urlOf = (route: string) => `${URL}${route}`;

  for (const [k, v] of Object.entries(ENV_SECRETS)) process.env[k] = v;

  // 1. Off when the URL is unset.
  setNotifyEnv(null);
  const off = await notify("done", order("fo-off", "done"));
  check(
    "off: NOTIFY_WEBHOOK_URL unset means the feature is off and nothing is sent",
    off.outcome === "off" && requests.length === 0,
    `outcome=${off.outcome}; requests=${requests.length}`,
  );

  // 2. The four formats produce the right body shape (one line each).
  const collapsed = LONG_TEXT.slice(0, NOTIFY_TEXT_MAX).replace(/\s+/g, " ").trim();
  const cases: Array<{ fmt: string; id: string }> = [
    { fmt: "json", id: "fo-fmt-json" },
    { fmt: "slack", id: "fo-fmt-slack" },
    { fmt: "discord", id: "fo-fmt-discord" },
    { fmt: "ntfy", id: "fo-fmt-ntfy" },
  ];
  for (const c of cases) {
    setNotifyEnv(urlOf("/hook"), c.fmt);
    const before = requests.length;
    const r = await notify("done", order(c.id, "done"));
    await sleep(25);
    const rec = requests[before];
    let ok = false;
    let detail = `outcome=${r.outcome}; requests=${requests.length - before}`;
    if (r.outcome === "sent" && rec) {
      const bodyText = rec.body;
      const ct = String(rec.headers["content-type"] ?? "");
      if (c.fmt === "json") {
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = JSON.parse(bodyText) as Record<string, unknown>;
        } catch {
          parsed = null;
        }
        const keys = parsed ? Object.keys(parsed).sort().join(",") : "";
        const prs = parsed && Array.isArray(parsed.prs) ? (parsed.prs as Array<{ id?: string; url?: string }>) : [];
        ok =
          !!parsed &&
          ct.startsWith("application/json") &&
          keys === "event,id,prs,status,text" &&
          parsed.event === "done" &&
          parsed.id === c.id &&
          parsed.status === "done" &&
          parsed.text === LONG_TEXT.slice(0, NOTIFY_TEXT_MAX) &&
          prs.length === 2 &&
          prs[0]?.url === "https://github.com/acme/repo/pull/123" &&
          prs[0]?.id === "WO1";
        detail += `; keys=${keys}; text.len=${String(parsed?.text ?? "").length}`;
      } else if (c.fmt === "slack") {
        const parsed = JSON.parse(bodyText) as Record<string, unknown>;
        ok =
          ct.startsWith("application/json") &&
          Object.keys(parsed).join(",") === "text" &&
          typeof parsed.text === "string" &&
          parsed.text.includes(`Fleet order ${c.id} done`) &&
          parsed.text.includes(collapsed) &&
          parsed.text.includes("https://github.com/acme/repo/pull/124");
        detail += `; keys=${Object.keys(parsed).join(",")}`;
      } else if (c.fmt === "discord") {
        const parsed = JSON.parse(bodyText) as Record<string, unknown>;
        ok =
          ct.startsWith("application/json") &&
          Object.keys(parsed).join(",") === "content" &&
          typeof parsed.content === "string" &&
          parsed.content.includes(`Fleet order ${c.id} done`) &&
          parsed.content.includes(collapsed);
        detail += `; keys=${Object.keys(parsed).join(",")}`;
      } else {
        // ntfy: the plain body is the message; Title carries the headline.
        ok =
          ct.startsWith("text/plain") &&
          bodyText ===
            `Fleet order ${c.id} done: ${collapsed}\n- WO1: https://github.com/acme/repo/pull/123\n- WO2: https://github.com/acme/repo/pull/124` &&
          rec.headers.title === `Fleet order ${c.id} done`;
        detail += `; title=${String(rec.headers.title ?? "")}`;
      }
    }
    check(`NOTIFY_FORMAT=${c.fmt} produces the right body shape`, ok, detail);
  }

  // 3. Events outside NOTIFY_EVENTS are skipped.
  setNotifyEnv(urlOf("/hook"), "json", "done,failed,awaiting_approval");
  const beforeSkip = requests.length;
  const skipped1 = await notify("cancelled", order("fo-skip-1", "cancelled"));
  setNotifyEnv(urlOf("/hook"), "json", "failed");
  const skipped2 = await notify("done", order("fo-skip-2", "done"));
  await sleep(25);
  check(
    "events outside NOTIFY_EVENTS are skipped (cancelled, and done when only failed is listed)",
    skipped1.outcome === "skipped-event" && skipped2.outcome === "skipped-event" && requests.length === beforeSkip,
    `outcomes=${skipped1.outcome}/${skipped2.outcome}; requests=${requests.length - beforeSkip}`,
  );

  // awaiting_approval is one of the three default events and really goes out.
  setNotifyEnv(urlOf("/hook"), "json");
  const beforeAwait = requests.length;
  const awaitEv = await notify("awaiting_approval", order("fo-await", "awaiting_approval"));
  await sleep(25);
  check(
    "awaiting_approval is a default event and is sent",
    awaitEv.outcome === "sent" &&
      requests.length === beforeAwait + 1 &&
      (JSON.parse(requests[beforeAwait]!.body) as { event?: string }).event === "awaiting_approval",
    `outcome=${awaitEv.outcome}; requests=${requests.length - beforeAwait}`,
  );

  // 4. A second identical event is de-duplicated.
  setNotifyEnv(urlOf("/hook"), "json");
  const beforeDup = requests.length;
  const firstDup = await notify("failed", order("fo-dup", "failed"));
  const secondDup = await notify("failed", order("fo-dup", "failed"));
  await sleep(25);
  check(
    "a second identical (order id, event) is de-duplicated",
    firstDup.outcome === "sent" && secondDup.outcome === "duplicate" && requests.length === beforeDup + 1,
    `outcomes=${firstDup.outcome}/${secondDup.outcome}; requests=${requests.length - beforeDup}`,
  );

  // 5. A stub that returns 500 or hangs does not throw.
  setNotifyEnv(urlOf("/err"), "json");
  const err500 = await notify("done", order("fo-500", "done"));
  check(
    "a stub that returns 500 does not throw",
    err500.outcome === "error" && err500.httpStatus === 500,
    `outcome=${err500.outcome}; httpStatus=${String(err500.httpStatus)}`,
  );

  setNotifyEnv(urlOf("/hang"), "json");
  const t0 = Date.now();
  const hang = await notify("failed", order("fo-hang", "failed"));
  const elapsed = Date.now() - t0;
  check(
    "a stub that hangs is aborted at the 5s timeout without throwing",
    hang.outcome === "error" && elapsed >= 4000 && elapsed < 12000,
    `outcome=${hang.outcome}; elapsed=${elapsed}ms`,
  );

  // 6. Dry-run sends nothing (but logs the payload).
  setNotifyEnv(urlOf("/hook"), "json", undefined, "1");
  const beforeDry = requests.length;
  const dry = await notify("done", order("fo-dry", "done"));
  await sleep(25);
  const dryLogged = logs.some((l) => l.includes("[notify] dry-run") && l.includes("fo-dry"));
  check(
    "dry-run sends nothing and logs the payload",
    dry.outcome === "dry-run" && requests.length === beforeDry && dryLogged,
    `outcome=${dry.outcome}; requests=${requests.length - beforeDry}; logged=${dryLogged}`,
  );

  // 7. Payload hygiene: no env value, no report/plan/error text, and the URL never in the logs.
  const bodies = requests.map((r) => r.body).join("\n");
  const headerText = JSON.stringify(requests.map((r) => r.headers));
  const leaked = [...Object.values(ENV_SECRETS), ...LEAK_MARKERS].filter(
    (s) => bodies.includes(s) || headerText.includes(s),
  );
  check(
    "no env value and no report/plan/error text appears in any payload",
    leaked.length === 0 && requests.length > 0,
    `requests=${requests.length}; leaked=${leaked.length}`,
  );

  const logText = logs.join("");
  check(
    "the webhook URL never appears in the logs (only its host is logged)",
    logText.length > 0 && !logText.includes(URL) && logText.includes(HOST),
    `urlInLogs=${logText.includes(URL)}; hostInLogs=${logText.includes(HOST)}`,
  );

  // 8. The payload keeps the order text to the documented length.
  const jsonReq = requests.find((r) => r.path === "/hook" && r.body.includes('"event"'));
  const parsedAny = jsonReq ? (JSON.parse(jsonReq.body) as { text?: string; prs?: unknown }) : null;
  check(
    `the payload text is the first ${NOTIFY_TEXT_MAX} characters of the order text`,
    !!parsedAny && typeof parsedAny.text === "string" && parsedAny.text.length === NOTIFY_TEXT_MAX,
    `len=${parsedAny && typeof parsedAny.text === "string" ? parsedAny.text.length : "?"}`,
  );
}

try {
  await main();
} catch (e) {
  check("harness completed without throwing", false, String(e instanceof Error ? e.message : e));
} finally {
  for (const unpatch of unpatchers) unpatch();
  for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
  for (const [key, value] of Object.entries(envBefore)) process.env[key] = value;
  try {
    (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  } catch {
    /* ignore */
  }
  await new Promise<void>((r) => server.close(() => r()));
}

console.log(failures === 0 ? "notify-check: all checks passed" : `notify-check: ${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
