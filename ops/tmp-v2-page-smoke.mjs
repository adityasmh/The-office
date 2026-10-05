// OPS-START: smoke every v2 page on the LIVE router (session badger).
//
// Why this file: the work order wants every v2 page checked headlessly with a
// harness that already exists rather than a new dependency. There is no
// playwright/puppeteer in this repo - the UI sessions drive Chrome over the
// DevTools protocol with Node's BUILT-IN WebSocket (see ops/resume-view-check.ts,
// same pattern, whose identifiers this file reuses). Nothing is installed here.
//
// For each page it reports, from the live browser:
//   * did the page finish rendering (the shell's loading spinner is gone)
//   * console errors + uncaught exceptions + failed/4xx-5xx requests
//   * whether the "Router unreachable" stale banner is showing
//   * how much the view actually rendered (elements, text length, sample text)
//
// Read-only: it only GETs the live router. No dispatch, no writes.
//
// Usage: node ops/tmp-v2-page-smoke.mjs [--base http://127.0.0.1:8787] [--json]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const BASE = arg("base", "http://127.0.0.1:8787");
const AS_JSON = args.includes("--json");
const CHROME = arg("chrome", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");

const PAGES = ["briefing", "assistant", "projects", "terminals", "fleet", "flow", "office", "system", "budget"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

// What the page looks like after the view has rendered. Kept generic on purpose:
// every view is a hash route rendered into #appview by public/v2/app.js.
const PROBE = `(() => {
  const view = document.querySelector("#appview");
  const banner = document.querySelector("#stale-banner");
  const bannerShown = !!banner && getComputedStyle(banner).display !== "none" && banner.getBoundingClientRect().height > 0;
  const err = document.querySelector("#appview .state-error, #appview .state.state-error");
  const txt = (view ? view.innerText : "").replace(/\\s+/g, " ").trim();
  return {
    hash: location.hash,
    spinner: !!document.querySelector("#appview .spinner"),
    staleBanner: bannerShown,
    staleText: (document.querySelector("#stale-text") || {}).textContent || null,
    stateError: err ? err.innerText.replace(/\\s+/g, " ").trim().slice(0, 300) : null,
    textLen: txt.length,
    elements: view ? view.querySelectorAll("*").length : 0,
    cards: document.querySelectorAll("#appview .card").length,
    rows: document.querySelectorAll("#appview tbody tr, #appview .row, #appview .list-row").length,
    title: (document.querySelector("#appview h1, #appview h2, #appview .view-title") || {}).textContent || null,
    text: txt.slice(0, 220)
  };
})()`;

const READY = `(() => {
  const v = document.querySelector("#appview");
  if (!v) return false;
  if (v.querySelector(".spinner")) return false;
  return v.querySelectorAll("*").length > 3;
})()`;

async function probe(url, cdpPort, timeoutMs = 30000) {
  const res = await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  const target = await res.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  const exceptions = [];
  const netFailures = [];
  const httpErrors = [];

  ws.addEventListener("message", (m) => {
    let msg;
    try {
      msg = JSON.parse(String(m.data));
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    const p = msg.params || {};
    if (msg.method === "Runtime.consoleAPICalled" && (p.type === "error" || p.type === "warning")) {
      const text = (p.args || []).map((a) => a.value ?? a.description ?? a.type).join(" ");
      (p.type === "error" ? consoleErrors : []).push(text.slice(0, 300));
    } else if (msg.method === "Runtime.exceptionThrown") {
      const d = p.exceptionDetails || {};
      exceptions.push(`${d.text ?? "exception"} ${d.exception?.description ?? ""}`.replace(/\s+/g, " ").slice(0, 300));
    } else if (msg.method === "Log.entryAdded" && (p.entry?.level === "error" || p.entry?.level === "warning")) {
      if (p.entry.level === "error") consoleErrors.push(`log: ${p.entry.text}`.slice(0, 300));
    } else if (msg.method === "Network.loadingFailed") {
      netFailures.push(`${p.type ?? "?"} ${p.errorText ?? "?"} ${(p.requestId ?? "").slice(0, 8)}`.slice(0, 200));
    } else if (msg.method === "Network.responseReceived" && (p.response?.status ?? 0) >= 400) {
      httpErrors.push(`${p.response.status} ${String(p.response.url).replace(BASE, "")}`.slice(0, 200));
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const myId = ++id;
      pending.set(myId, resolve);
      ws.send(JSON.stringify({ id: myId, method, params }));
    });

  try {
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", (e) => reject(new Error(`ws error: ${String(e?.message ?? e)}`)));
    });
    await send("Runtime.enable");
    await send("Log.enable");
    await send("Page.enable");
    await send("Network.enable");
    await send("Page.navigate", { url });

    const deadline = Date.now() + timeoutMs;
    let ready = false;
    while (Date.now() < deadline) {
      const r = await send("Runtime.evaluate", { expression: READY, returnByValue: true });
      if (r?.result?.result?.value) {
        ready = true;
        break;
      }
      await sleep(300);
    }
    // Let the view's own fetches land before reading the DOM.
    await sleep(2500);
    const out = await send("Runtime.evaluate", { expression: PROBE, returnByValue: true });
    const value = out?.result?.result?.value ?? null;
    return { url, ready, value, consoleErrors, exceptions, netFailures, httpErrors };
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    try {
      await fetch(`http://127.0.0.1:${cdpPort}/json/close/${target.id}`);
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "v2-smoke-"));
const cdpPort = await freePort();
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${path.join(tempRoot, "chrome")}`,
    `--remote-debugging-port=${cdpPort}`,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "ignore"] },
);

let cdpUp = false;
for (let i = 0; i < 100; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
    if (r.ok) {
      cdpUp = true;
      break;
    }
  } catch {
    /* not up */
  }
  await sleep(200);
}
if (!cdpUp) {
  console.error("headless Chrome did not expose CDP");
  process.exit(2);
}
console.log(`headless Chrome up (CDP :${cdpPort}); base=${BASE}`);

const results = [];
for (const p of PAGES) {
  const url = `${BASE}/v2/#/${p}`;
  let r;
  try {
    r = await probe(url, cdpPort);
  } catch (e) {
    r = { url, ready: false, value: null, consoleErrors: [], exceptions: [String(e.message)], netFailures: [], httpErrors: [] };
  }
  const v = r.value || {};
  const problems = [];
  if (!r.ready) problems.push("never finished rendering");
  if (r.exceptions.length) problems.push(`${r.exceptions.length} uncaught exception(s)`);
  if (v.staleBanner) problems.push("stale banner shown (router unreachable)");
  if (v.stateError) problems.push(`view error state: ${v.stateError.slice(0, 120)}`);
  if (!v || (v.textLen ?? 0) < 20) problems.push("view rendered (almost) no text");
  const ok = problems.length === 0;

  results.push({ page: p, url, ok, problems, probe: v, consoleErrors: r.consoleErrors, netFailures: r.netFailures, httpErrors: r.httpErrors });
  console.log(
    `${ok ? "PASS" : "FAIL"} ${p.padEnd(9)} ready=${r.ready} textLen=${v.textLen ?? "-"} elements=${v.elements ?? "-"} ` +
      `cards=${v.cards ?? "-"} rows=${v.rows ?? "-"} title=${JSON.stringify((v.title || "").slice(0, 40))}`,
  );
  if (v.text) console.log(`      text: ${v.text}`);
  if (problems.length) console.log(`      FAIL: ${problems.join("; ")}`);
  for (const e of r.exceptions) console.log(`      exception: ${e}`);
  for (const e of r.consoleErrors) console.log(`      console.error: ${e}`);
  for (const e of r.netFailures) console.log(`      netfail: ${e}`);
  for (const e of r.httpErrors) console.log(`      http>=400: ${e}`);
}

try {
  chrome.kill();
} catch {
  /* ignore */
}
try {
  fs.rmSync(tempRoot, { recursive: true, force: true });
} catch {
  /* ignore */
}

const failed = results.filter((r) => !r.ok);
console.log(`\nv2 page smoke: ${results.length - failed.length}/${results.length} pass`);
if (AS_JSON) console.log(JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
