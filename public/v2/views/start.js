// public/v2/views/start.js — the first-run page (docs/business/PLAN.md, Offer A).
//
// Route: #/start
// Contract (docs/UI_V2_SPEC.md): `export const title`, `export function mount(el, ctx) -> cleanup`.
// ctx = { api, poll, esc, ago, hm, navigate, params, route, ... }.
//
// The page is for a person who is not an AI expert. It answers three questions in
// one minute: what is this, is it working, and what do I do first.
//
//   1. four plain lines: what the fleet is, that a human approves, that work runs
//      in a safe workspace, and that every order shows its cost;
//   2. a live checklist from read-only routes ONLY:
//        GET /health                 router answering
//        GET /company/laya           the decision model (optional -> amber, never red)
//        GET /company/budget/real    OpenCode quota left + prepaid credit, in words
//        GET /company/routing/policy GitHub publishing, ONLY if that payload exposes
//                                    it (it does not today -> the line is omitted)
//        GET /company/workers        how many workers are running
//   3. "Your first order": a text area, three example orders that fill it, and a
//      button that creates the order through the SAME call the Fleet page uses
//      (POST /company/fleet/orders). The token is handled by api.js, never here.
//   4. "What it will cost": planned first, nothing spent until you approve.
//
// No key, token or environment value is ever read or shown here. Every figure
// comes from the route above; a missing figure is said to be missing.
//
// The two pure functions, checklistFromData(data) and canSubmit(text), have no DOM
// access, so ops/start-view-check.ts can import this file in Node and test them.

export const title = "Start here";
export const goal = "New here? What this is, whether it works, and your first order - in plain words.";

/* ==================================================================== *
 * Pure helpers (no DOM, no fetch, importable in Node)
 * ==================================================================== */

function s(v) {
  return v === null || v === undefined ? "" : typeof v === "string" ? v : String(v);
}
function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
/** A route value counts as failed when it is absent, an object with `.error`, or a thrown Error. */
function failed(v) {
  if (v === null || v === undefined) return true;
  if (v instanceof Error) return true;
  if (isObj(v) && (v.error !== undefined || v.status !== undefined)) return true;
  return false;
}

/** The longest order we will send; matches the fleet planner's practical input size. */
export const MAX_ORDER_CHARS = 2000;

/** Why this text cannot be sent, or "" when it can. One plain sentence. */
export function submitProblem(text) {
  const raw = s(text);
  const trimmed = raw.trim();
  if (!trimmed) return "Type what you want the team to do first.";
  if (trimmed.indexOf("<") >= 0) {
    return "Replace the <your file> placeholder with a real file name before sending.";
  }
  if (raw.length > MAX_ORDER_CHARS) {
    return "This order is " + raw.length + " characters; keep it under " + MAX_ORDER_CHARS + ".";
  }
  return "";
}

/** True when the order text is ready to send. */
export function canSubmit(text) {
  return submitProblem(text) === "";
}

/** OpenCode quota left + prepaid credit, in plain words, or { measured:false }. */
export function budgetPlainWords(budget) {
  const b = isObj(budget) ? budget : {};
  const provs = isObj(b.providers) ? b.providers : {};
  const go = isObj(provs.go) ? provs.go : {};
  const ds = isObj(provs.deepseek) ? provs.deepseek : isObj(provs.deepseekDirect) ? provs.deepseekDirect : {};

  let pct = numOrNull(go.remainingPct);
  if (pct === null && Array.isArray(go.windows)) {
    const binding = go.bindingWindow
      ? go.windows.filter((w) => isObj(w) && w.window === go.bindingWindow)[0]
      : null;
    const w = binding || go.windows[0];
    pct = numOrNull(w && w.remainingPct);
  }
  const balance = numOrNull(ds.balanceUsd);
  const currency = s(ds.currency) || "USD";

  const bits = [];
  if (pct !== null) bits.push("OpenCode quota: " + Math.round(pct) + "% left");
  if (balance !== null) bits.push("prepaid credit: $" + balance.toFixed(2) + (currency !== "USD" ? " " + currency : ""));
  if (!bits.length) return { measured: false, text: "" };
  return {
    measured: true,
    text:
      bits.join(". ") +
      ". The OpenCode quota is used first; the prepaid credit is only spent when it runs low.",
  };
}

/** GitHub publishing from a routing-policy payload, only when that payload exposes it. */
function githubFromPolicy(policy) {
  if (!isObj(policy) || failed(policy)) return null;
  const g = policy.github;
  if (g === undefined || g === null) return null; // not exposed -> omit the line
  if (typeof g === "boolean") return { ok: g };
  if (isObj(g)) return g;
  return null;
}

function routerRow(d) {
  const h = d.health;
  if (!failed(h) && h.ok !== false) {
    return { key: "router", dot: "green", text: "The router is answering, so this page can talk to the company." };
  }
  return {
    key: "router",
    dot: "red",
    retry: true,
    text: "The router is not answering. Use Retry to check again.",
  };
}

function layaRow(d) {
  const l = d.laya;
  const up = !failed(l) && (l.ok === true || l.connected === true || l.running === true);
  if (up) {
    return { key: "laya", dot: "green", text: "The decision model (Laya) is answering, so orders are routed by the smarter rules." };
  }
  return {
    key: "laya",
    dot: "amber",
    retry: failed(l),
    text: "The decision model (Laya) is not answering. optional: routing falls back to simple rules.",
  };
}

function budgetRow(d) {
  const b = d.budget;
  if (failed(b)) {
    return {
      key: "budget",
      dot: "amber",
      retry: true,
      text: "The budget is not measured right now. You can still send an order; the cost page shows it after a check.",
    };
  }
  const words = budgetPlainWords(b);
  if (!words.measured) {
    return {
      key: "budget",
      dot: "amber",
      text: "The budget is not measured yet, so no number is claimed. The cost page will fill this in.",
    };
  }
  return { key: "budget", dot: "green", text: words.text };
}

function githubRow(d) {
  const g = githubFromPolicy(d.routing);
  if (!g) return null; // the payload does not expose it: omit, never guess
  const ok = g.ok === true || g.connected === true || g.enabled === true || g.publishing === true;
  if (ok) {
    return { key: "github", dot: "green", text: "GitHub publishing is set up, so finished work can be offered as a pull request." };
  }
  return {
    key: "github",
    dot: "amber",
    text: "GitHub publishing is not set up yet. You can still run orders; the results stay on this machine.",
  };
}

function workersRow(d) {
  const w = d.workers;
  if (failed(w)) {
    return {
      key: "workers",
      dot: "amber",
      retry: true,
      text: "Could not read how many workers are running. Use Retry to check again.",
    };
  }
  const live = Array.isArray(w.live) ? w.live.length : 0;
  if (live > 0) {
    return { key: "workers", dot: "green", text: live + (live === 1 ? " worker is" : " workers are") + " running right now." };
  }
  return {
    key: "workers",
    dot: "green",
    text: "No workers are running right now. That is normal until you send an order.",
  };
}

/**
 * The checklist, in order: router, Laya, budget, GitHub (only if exposed), workers.
 * `data` = { health, laya, budget, routing, workers }; each value is the route's
 * JSON, or missing / an Error / { error } when the route did not answer.
 * Each row: { key, dot: "green"|"amber"|"red", text, retry? }.
 */
export function checklistFromData(data) {
  const d = isObj(data) ? data : {};
  const rows = [routerRow(d), layaRow(d), budgetRow(d)];
  const gh = githubRow(d);
  if (gh) rows.push(gh);
  rows.push(workersRow(d));
  return rows;
}

/* ==================================================================== *
 * mount
 * ==================================================================== */

const CHECK_MS = 20000; // the checklist is a status panel, not a live tail
const STYLE_ID = "start-view-style";

function escHtml(v) {
  return s(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function errText(e) {
  if (!e) return "unknown error";
  const st = e.status ? "HTTP " + e.status : "";
  const m = e.message || String(e);
  return st ? st + " - " + m : m;
}
function fallbackPoll(fn, ms) {
  const h = setInterval(() => {
    if (typeof document === "undefined" || !document.hidden) Promise.resolve().then(fn).catch(() => {});
  }, Math.max(1000, Number(ms) || CHECK_MS));
  return () => clearInterval(h);
}

function injectStyle() {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.start { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.start-intro-lines { margin: 6px 0 0; padding-left: 20px; }
.start-intro-lines li { margin: 3px 0; overflow-wrap: anywhere; }
.start-row { display: flex; align-items: flex-start; gap: 9px; padding: 6px 0; min-width: 0; }
.start-row + .start-row { border-top: 1px solid var(--line, #2a2a2a); }
.start-dot { flex: 0 0 auto; width: 10px; height: 10px; border-radius: 50%; margin-top: 5px; background: var(--dim, #888); }
.start-dot.is-green { background: var(--ok, #4ade80); }
.start-dot.is-amber { background: var(--warn, #fbbf24); }
.start-dot.is-red { background: var(--err, #f87171); }
.start-text { min-width: 0; overflow-wrap: anywhere; }
.start-text a { color: var(--accent, #7dd3fc); }
.start-examples { flex-wrap: wrap; gap: 6px; margin: 8px 0; }
.start svg, .start img { max-width: 100%; }
.start textarea { width: 100%; box-sizing: border-box; min-width: 0; }
.start-example { max-width: 100%; white-space: normal; text-align: left; }
.start-cost { border: 1px solid var(--line, #2a2a2a); border-radius: 10px; padding: 10px 12px; background: var(--panel2, rgba(255,255,255,0.02)); }
`;
  document.head.appendChild(style);
}

export function mount(el, ctx) {
  const c = ctx || {};
  const api = typeof c.api === "function" ? c.api : null;
  const esc = typeof c.esc === "function" ? c.esc : escHtml;
  const poll = typeof c.poll === "function" ? c.poll : fallbackPoll;

  injectStyle();

  let disposed = false;
  let sending = false;
  let stopPoll = null;
  let data = {}; // the five route payloads (or an Error for the ones that failed)
  let checkedAt = 0;

  const EXAMPLES = [
    {
      label: "Document a file",
      text: "Read <your file> and add a short description at the top: what it does and who it is for. Change nothing else.",
    },
    {
      label: "Fix a small bug",
      text: "Find and fix one small bug in <your file>. Say in the report what was wrong and what you changed.",
    },
    {
      label: "Add a test",
      text: "Add one test for <your file> that fails before the fix and passes after it. Do not change the behaviour of the file.",
    },
  ];

  el.innerHTML =
    '<div class="start">' +
    '<div class="card">' +
    '<div class="card-head"><h2>What this is</h2></div>' +
    '<ul class="start-intro-lines">' +
    "<li>This is a small company of AI workers: you describe a job in plain English and they do it.</li>" +
    "<li>Nothing risky happens on its own: a human approves the plan before any worker starts.</li>" +
    "<li>The work happens in a safe workspace, and you see the changes before anything ships.</li>" +
    "<li>Every order shows what it cost, so there are no surprise bills.</li>" +
    "</ul></div>" +
    '<div class="card">' +
    '<div class="card-head"><h2>Is it working?</h2>' +
    '<span class="grow"></span>' +
    '<span class="muted small" id="start-checked"></span>' +
    '<button class="btn btn-sm" data-act="retry">Retry</button></div>' +
    '<div class="col" id="start-checklist"></div>' +
    "</div>" +
    '<div class="card">' +
    '<div class="card-head"><h2>Your first order</h2>' +
    '<span class="muted small">Fill in a file name, or write your own.</span></div>' +
    '<div class="row start-examples" id="start-examples"></div>' +
    '<textarea class="in" id="start-order" rows="4" aria-label="Your order" ' +
    'placeholder="Example: Add a short description at the top of docs/HANDOVER.md explaining what it does."></textarea>' +
    '<div class="row mt-2" style="flex-wrap:wrap;gap:8px">' +
    '<button class="btn btn-primary" id="start-send" data-act="send">Send for planning</button>' +
    '<span class="muted small" id="start-order-msg" role="status"></span>' +
    "</div></div>" +
    '<div class="start-cost">' +
    "<strong>What it will cost:</strong> your order is planned first, and nothing is spent until you approve the plan. " +
    'The <a href="#/budget">Budget page</a> shows what is left at each provider.' +
    "</div>" +
    "</div>";

  const $checklist = el.querySelector("#start-checklist");
  const $checked = el.querySelector("#start-checked");
  const $msg = el.querySelector("#start-order-msg");
  const $order = el.querySelector("#start-order");
  const $send = el.querySelector("#start-send");
  const $examples = el.querySelector("#start-examples");

  for (const ex of EXAMPLES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn btn-sm start-example";
    b.dataset.act = "example";
    b.dataset.text = ex.text;
    b.textContent = ex.label;
    $examples.appendChild(b);
  }

  function setMsg(text, isErr) {
    $msg.textContent = text || "";
    $msg.style.color = isErr ? "var(--err, #f87171)" : "";
  }

  function renderChecklist() {
    const rows = checklistFromData(data);
    $checklist.innerHTML = rows
      .map((r) => {
        const retry = r.retry
          ? ' <a href="#" data-act="retry">Retry</a>'
          : "";
        return (
          '<div class="start-row">' +
          '<span class="start-dot is-' + esc(r.dot) + '" aria-hidden="true"></span>' +
          '<span class="start-text">' + esc(r.text) + retry + "</span>" +
          "</div>"
        );
      })
      .join("");
    $checked.textContent = checkedAt ? "checked " + new Date(checkedAt).toLocaleTimeString() : "";
  }

  function renderSendState() {
    $send.disabled = sending;
    $send.textContent = sending ? "Planning…" : "Send for planning";
  }

  async function loadAll() {
    if (!api) {
      data = { health: new Error("the dashboard API is not available") };
      checkedAt = Date.now();
      renderChecklist();
      return;
    }
    const paths = {
      health: "/health",
      laya: "/company/laya",
      budget: "/company/budget/real",
      routing: "/company/routing/policy",
      workers: "/company/workers",
    };
    const keys = Object.keys(paths);
    const results = await Promise.allSettled(keys.map((k) => api(paths[k], { ttl: 0 })));
    if (disposed) return;
    const next = {};
    keys.forEach((k, i) => {
      const r = results[i];
      next[k] = r.status === "fulfilled" ? r.value : r.reason;
    });
    data = next;
    checkedAt = Date.now();
    renderChecklist();
  }

  async function send() {
    const text = s($order && $order.value);
    const problem = submitProblem(text);
    if (problem) {
      setMsg(problem, true);
      if ($order) $order.focus();
      return;
    }
    if (!api) {
      setMsg("Could not send: the dashboard API is not available.", true);
      return;
    }
    sending = true;
    setMsg("Sending…", false);
    renderSendState();
    try {
      const created = await api("/company/fleet/orders", {
        method: "POST",
        body: { text: text.trim(), autoApprove: false },
      });
      if (disposed) return;
      const id = s(created && created.id);
      $order.value = "";
      $msg.innerHTML =
        "Order created - Claude is planning it now. Nothing is spent until you approve the plan." +
        (id ? ' <a href="#/fleet/' + esc(encodeURIComponent(id)) + '">Watch it on the Fleet page</a>' : "");
      $msg.style.color = "";
    } catch (e) {
      if (disposed) return;
      setMsg("Could not create the order: " + errText(e) + ". You can try again.", true);
    } finally {
      sending = false;
      if (!disposed) renderSendState();
    }
  }

  el.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target.closest("[data-act]") : null;
    if (!t) return;
    const act = t.dataset.act;
    if (act === "retry") {
      e.preventDefault();
      loadAll();
    } else if (act === "example") {
      e.preventDefault();
      if ($order) {
        $order.value = t.dataset.text || "";
        $order.focus();
      }
      setMsg("", false);
    } else if (act === "send") {
      e.preventDefault();
      send();
    }
  });

  renderChecklist();
  renderSendState();
  loadAll();
  stopPoll = poll(loadAll, CHECK_MS);

  return function cleanup() {
    disposed = true;
    if (stopPoll) {
      try {
        stopPoll();
      } catch {
        /* ignore */
      }
      stopPoll = null;
    }
  };
}
