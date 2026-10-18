// Verification for public/v2/views/assistant.js (UI-ASSISTANT work order).
//
// One-shot headless Chrome, NO debug port and no server of our own: each pass is
// `chrome --headless=new --dump-dom` pointed at the LIVE router on :8787, so
// Chrome exits by itself and nothing is left listening.
//
// Pass 1 (harness, 375x720): a throwaway page is written to public/v2/, which
//   imports the real view and mounts it with the documented ctx contract. It
//   records what the view actually rendered, exercises Enter-to-send against a
//   stubbed /company/assistant/message fetch, and writes its findings into
//   <pre id="uia-result">. The file is deleted again in cleanup() below.
// Pass 2/3 (real shell, 1280 and 375): /v2/#/assistant as the CEO sees it; the
//   dumped DOM is checked for the view's content and for shell error states.
//
// Usage: npx tsx ops/ui-assistant-check.ts
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Google\\Chrome\\Application\\chrome.exe") : "",
].find((p) => p && fs.existsSync(p));
if (!CHROME) throw new Error("no chrome found");

const BASE = "http://127.0.0.1:8787";
const HARNESS = path.join(process.cwd(), "public", "v2", "__uia-check.html");

function rmtree(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    // Chrome can still hold a lock for a moment after it exits; the temp dir
    // is in %TEMP%, so a miss here is harmless and must never fail the run.
  }
}

function dumpDom(url: string, width: number, height: number, budgetMs: number): string {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "uia-check-"));
  try {
    const r = spawnSync(
      CHROME,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-sync",
        `--user-data-dir=${profile}`,
        `--window-size=${width},${height}`,
        `--virtual-time-budget=${budgetMs}`,
        "--dump-dom",
        url,
      ],
      { encoding: "utf8", timeout: 120000, maxBuffer: 64 * 1024 * 1024 },
    );
    if (r.error) throw r.error;
    return String(r.stdout || "");
  } finally {
    rmtree(profile);
  }
}

/* The harness page: exactly the documented ctx contract, nothing else. */
const HARNESS_JS = `
const out = { ok: false, steps: [], errors: [] };
function step(name, detail) { out.steps.push({ name, detail }); }
window.addEventListener("error", (e) => out.errors.push("window.error: " + (e.message || e)));
window.addEventListener("unhandledrejection", (e) => out.errors.push("rejection: " + ((e.reason && e.reason.message) || e.reason)));
const realError = console.error;
console.error = function () { out.errors.push("console.error: " + Array.from(arguments).map(String).join(" ")); return realError.apply(console, arguments); };
const api = (p, o) => fetch(p, Object.assign({}, o || {}, {
  cache: "no-store",
  headers: Object.assign({ "x-company-token": window.__tok || "" }, (o && o.body) ? { "content-type": "application/json" } : {}),
  body: o && o.body ? JSON.stringify(o.body) : undefined,
})).then((r) => r.text().then((t) => {
  let d = null; try { d = t ? JSON.parse(t) : null; } catch (e) {}
  if (!r.ok) { const e = new Error((d && d.error) || ("HTTP " + r.status)); e.status = r.status; throw e; }
  return d;
}));
const poll = (fn, ms) => { fn().catch(() => {}); const t = setInterval(() => { fn().catch(() => {}); }, Math.max(250, ms)); return () => clearInterval(t); };
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const ago = (iso) => { const d = new Date(iso); const s = Math.floor((Date.now() - d.getTime()) / 1000); return isFinite(s) ? (s < 60 ? s + "s ago" : Math.floor(s / 60) + "m ago") : ""; };
const hm = (iso) => { const d = new Date(iso); const p = (n) => String(n).padStart(2, "0"); return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds()); };
const navs = [];
const navigate = (h) => { navs.push(h); location.hash = h; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  try {
    const boot = await fetch("/company/auth/bootstrap", { cache: "no-store" });
    const bd = await boot.json();
    window.__tok = (bd && bd.token) || "";
    step("auth bootstrap", "status=" + boot.status + " token=" + (window.__tok ? "present(" + window.__tok.length + " chars)" : "absent"));

    const mod = await import("/v2/views/assistant.js");
    step("module", "title=" + JSON.stringify(mod.title) + " mount=" + typeof mod.mount);

    const host = document.getElementById("view");
    const cleanup = mod.mount(host, { api, poll, esc, ago, hm, navigate, params: {} });
    step("mount", "returned " + typeof cleanup);

    await sleep(4000); // let the first thread + flow GETs land (real router)

    const q = (sel) => Array.from(document.querySelectorAll(sel));
    const txt = (el) => (el.textContent || "").replace(/\\s+/g, " ").trim();

    const ceo = q("#view .who-ceo").map(txt);
    const asst = q("#view .who-assistant").map(txt);
    step("thread rendered", "ceo messages=" + ceo.length + " assistant messages=" + asst.length + " first ceo=" + JSON.stringify(ceo[0] || "").slice(0, 60));

    const cards = q("#view .card");
    step("cards", "count=" + cards.length + " with borderLeft=" + cards.filter((c) => c.style.borderLeft).length);

    // Report-backs stand out only if they are detected and toned, so measure
    // the tone pill and the resolved border colour, not the card's first text.
    const reports = cards.map((c) => {
      const pill = c.querySelector(".pill-ok,.pill-err");
      const label = pill ? txt(pill) : "";
      return { label, hasReport: label === "done" || label === "failed", border: getComputedStyle(c).borderLeftColor, head: txt(c).slice(0, 46) };
    }).filter((r) => r.hasReport);
    step("report-backs", "count=" + reports.length + " kinds=" + JSON.stringify(reports.slice(0, 3)));

    const chips = q("#view a.pill").map((a) => ({ href: a.getAttribute("href"), cls: a.className, t: txt(a).slice(0, 70) }));
    step("chips", "count=" + chips.length + " first3=" + JSON.stringify(chips.slice(0, 3)));
    step("chip links", "all to #/flow/: " + chips.every((c) => /^#\\/flow\\/.+/.test(c.href || "")) + " with real status: " + chips.filter((c) => !/status unknown/.test(c.t)).length + "/" + chips.length);

    const live = document.querySelector("#view .card");
    step("status strip", JSON.stringify(txt(live).slice(0, 200)));

    // ---- Enter-to-send, with a stubbed assistant POST (no money spent) ----
    const input = document.querySelector("#view textarea");
    const sendBtn = q("#view button").find((b) => /Send/.test(b.textContent));
    step("composer", "textarea=" + !!input + " sendButton=" + !!sendBtn + " disabledWhenEmpty=" + (sendBtn ? sendBtn.disabled : null) + " autoRunDefault=" + JSON.stringify(txt(q("#view button").find((b) => /Run now/.test(b.textContent)) || document.createElement("i"))));
    input.value = "harness order";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    step("send enabled after typing", sendBtn.disabled === false);
    const shift = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(shift);
    step("shift+enter not hijacked", "defaultPrevented=" + shift.defaultPrevented);

    const realFetch = window.fetch;
    let posted = null;
    window.fetch = (url, init) => {
      if (String(url).indexOf("/company/assistant/message") >= 0) {
        posted = { url: String(url), method: (init && init.method) || "GET", body: init && init.body };
        return Promise.resolve(new Response(JSON.stringify({
          reply: "HARNESS REPLY **bold** and \\u0060code\\u0060",
          plan: [{ title: "harness task" }],
          dispatched: [{ projectId: "pmumhp51u", taskId: "tmummzave", title: "Harness dispatched task", status: "running" }],
          decisions: ["harness decision one", "harness decision two"],
        }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      return realFetch(url, init);
    };
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    input.dispatchEvent(enter);
    step("enter sends", "defaultPrevented=" + enter.defaultPrevented);
    await sleep(1200);
    step("posted body", JSON.stringify(posted));
    const after = q("#view .card").filter((c) => /HARNESS REPLY/.test(txt(c)));
    step("optimistic reply", "cards=" + after.length + " hasBoldMarkup=" + (after[0] ? /<strong>bold<\\/strong>/.test(after[0].innerHTML) : false) + " hasChip=" + (after[0] ? !!after[0].querySelector("a.pill") : false) + " hasWhy=" + (after[0] ? !!after[0].querySelector("details") : false));
    step("optimistic reply text", JSON.stringify(after[0] ? txt(after[0]).slice(0, 160) : ""));
    window.fetch = realFetch;

    // ---- send failure path ----
    input.value = "this one fails";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    window.fetch = (url, init) => String(url).indexOf("/company/assistant/message") >= 0
      ? Promise.resolve(new Response(JSON.stringify({ error: "harness forced failure" }), { status: 500, headers: { "content-type": "application/json" } }))
      : realFetch(url, init);
    const enter2 = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    input.dispatchEvent(enter2);
    await sleep(900);
    step("failure banner", JSON.stringify(txt(document.querySelector("#view .card")).slice(0, 120)) + " | " + JSON.stringify(txt(document.querySelector("#view .card:nth-of-type(1)")).slice(0, 200)));
    step("order preserved after failure", JSON.stringify(input.value));
    const retry = q("#view button").find((b) => /Retry/.test(b.textContent));
    step("retry button present", !!retry);
    window.fetch = realFetch;

    // ---- layout: real 375px container, since a headless window has a wider
    // minimum width than a phone (window-size=375 gave innerWidth=504) ----
    const host2 = document.getElementById("view");
    const prevWidth = host2.style.width;
    const wideAt = (px) => {
      host2.style.width = px + "px";
      const limit = host2.getBoundingClientRect().width;
      const bad = q("#view *").filter((el) => Math.round(el.getBoundingClientRect().width) > Math.ceil(limit)).map((el) => (el.tagName + "." + (el.className || "")).slice(0, 50));
      const clipped = q("#view .pill, #view button, #view a").filter((el) => el.scrollWidth > el.clientWidth + 1).length;
      return { containerWidth: Math.round(limit), docScrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, tooWide: bad.slice(0, 6), clippedEls: clipped };
    };
    out.layout = { narrow375: wideAt(375), full: wideAt(window.innerWidth) };
    host2.style.width = prevWidth;
    step("layout@375", JSON.stringify(out.layout.narrow375));
    step("layout@window", JSON.stringify(out.layout.full));

    // ---- cleanup ----
    cleanup();
    step("cleanup", "#view children after cleanup=" + document.getElementById("view").children.length);
    out.ok = out.errors.length === 0;
  } catch (e) {
    out.errors.push("harness threw: " + ((e && e.stack) || e));
  }
  const pre = document.createElement("pre");
  pre.id = "uia-result";
  pre.textContent = "UIA_RESULT " + JSON.stringify(out);
  document.body.appendChild(pre);
  document.title = "UIA " + (out.ok ? "OK" : "ERRORS");
})();
`;

const HARNESS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>UIA harness</title>
<style>
:root{--bg:#14161a;--panel:#1b1e24;--panel2:#22262e;--line:#31363f;--txt:#e6e8ec;--dim:#98a0ae;--accent:#6ea8fe;--ok:#57b57f;--warn:#d8a657;--err:#d96a6a}
body{background:var(--bg);color:var(--txt);font:15px/1.5 system-ui,sans-serif;margin:0;padding:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px}
.pill{display:inline-block;background:var(--panel2);border:1px solid var(--line);border-radius:999px;padding:1px 8px;font-size:12px}
.pill-ok{border-color:var(--ok);color:var(--ok)}.pill-warn{border-color:var(--warn);color:var(--warn)}.pill-err{border-color:var(--err);color:var(--err)}
.muted{color:var(--dim)}.row{display:flex;gap:8px}.col{display:flex;flex-direction:column;gap:8px}
.btn{background:var(--panel2);color:var(--txt);border:1px solid var(--line);border-radius:6px;padding:6px 10px}.btn-primary{background:var(--accent);color:var(--bg);border-color:var(--accent)}
.who-ceo{color:var(--dim)}.who-assistant{color:var(--accent)}.grid{display:grid;gap:8px}
</style></head><body><div id="view" class="col"></div>
<script>${HARNESS_JS.replace(/<\/script>/g, "<\\/script>")}</script>
</body></html>`;

function pick(stdout: string, re: RegExp): string {
  const m = re.exec(stdout);
  return m ? m[1] : "";
}

function countOccurrences(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

function shellPass(label: string, width: number, height: number): Record<string, unknown> {
  let dom = "";
  try {
    dom = dumpDom(`${BASE}/v2/#/assistant`, width, height, 30000);
  } catch (e) {
    return { label, dumpFailed: String((e as Error).message || e) };
  }
  // The shell ships a <noscript> fallback that also uses these class names;
  // strip it so the check reflects what a JS-enabled browser actually renders.
  const live = dom.replace(/<noscript>[\s\S]*?<\/noscript>/g, "");
  const chips = Array.from(live.matchAll(/<a[^>]*class="pill[^"]*"[^>]*href="(#\/flow\/[^"]+)"[^>]*>/g)).map((m) => m[1]);
  return {
    label,
    bytes: live.length,
    title: pick(live, /<title>([^<]*)<\/title>/),
    errorState: /class="state state-error"|state-title/.test(live),
    notBuilt: /not built yet/.test(live),
    cards: countOccurrences(live, 'class="card'),
    ceoMarks: countOccurrences(live, "who-ceo"),
    assistantMarks: countOccurrences(live, "who-assistant"),
    chipLinks: chips.length,
    chipSamples: chips.slice(0, 3),
    hasTextarea: /<textarea/.test(live),
    hasSend: />Send</.test(live),
    hasLiveStrip: /Live work/.test(live),
    flowLinks: Array.from(live.matchAll(/#\/flow\/([A-Za-z0-9_-]+)/g)).map((m) => m[1]).slice(0, 5),
  };
}

/* runner */
const results: Record<string, unknown> = {};
try {
  fs.writeFileSync(HARNESS, HARNESS_HTML, "utf8");
  const dom = dumpDom(`${BASE}/v2/__uia-check.html`, 375, 720, 20000);
  const json = pick(dom, /UIA_RESULT (\{[\s\S]*?\})<\/pre>/);
  results.harness375 =
    json && json.length > 0 ? JSON.parse(json) : { parseFailed: true, domHead: dom.slice(0, 600) };
  results.shell1280 = shellPass("shell1280", 1280, 900);
} catch (e) {
  results.runFailed = String((e && (e as Error).stack) || e);
} finally {
  // the harness page is throwaway: it must never survive a run
  try {
    fs.rmSync(HARNESS, { force: true });
  } catch {
    /* ignore */
  }
}
console.log(JSON.stringify(results, null, 2));
