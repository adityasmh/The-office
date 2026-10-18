// UI-FLOW view: recent orders + the hand-off chain timeline.
//
// Routes:  #/flow            -> recent orders (newest first)
//          #/flow/:taskId    -> the chain for one order, as a vertical timeline of hops
//
// Contract (docs/UI_V2_SPEC.md): mount(el, ctx) -> cleanup().
// ctx = { api, poll, esc, ago, hm, navigate(hash), params }.
// Data: GET /company/flow?limit=N ->
//   { tasks:[{ taskId, projectId, projectName, departmentName, request, status,
//              createdAt, updatedAt, result, error,
//              trace:[{ ts, from, to, what, detail }] }] }
//
// Theme: only style.css classes (.card .card-head .card-pad .btn .btn-sm .pill
// .pill-ok .pill-warn .pill-err .pill-run .pill-dim .muted .small .tiny .row
// .col .grow .right .wrap-any .pre .item .item-title .item-sub .item-meta .dot
// .dot-ok .dot-warn .dot-err .dot-run .state .state-error .spinner .who
// .who-ceo .who-assistant .who-laya .who-claude .who-worker) plus CSS variables
// are used. The only CSS this view adds is namespaced under .flow-* (the timeline
// rail, which style.css does not provide) and reads theme variables only.

export const title = "Flow";

// Work is actively moving (mirrors IN_MOTION in src/company/gates.ts).
const IN_FLIGHT = new Set(["enhancing", "planned", "coding", "testing", "opposing", "summarizing", "adjudicating"]);
// Parked at a human approval gate: not moving, but still unsettled.
const GATES = new Set(["pending_intake", "pending_code", "pending_merge"]);

const LIMIT = 40; // orders fetched per refresh (list + detail lookup)
const MS_LIVE = 4000; // refresh cadence while something is in flight
const MS_IDLE = 20000; // refresh cadence when everything has settled
const PREVIEW = 320; // chars of a hop's detail shown inline before the toggle

const STYLE_ID = "flow-view-style";

/* ------------------------------------------------------------------ helpers */

function escHtml(s) {
  return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function fallbackHm(iso) {
  try {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch { return ""; }
}

function fallbackAgo(iso) {
  try {
    const ms = Date.now() - new Date(iso).getTime();
    if (!isFinite(ms) || ms < 0) return "just now";
    const s = Math.round(ms / 1000);
    if (s < 60) return s + "s ago";
    const m = Math.round(s / 60);
    if (m < 60) return m + "m ago";
    const h = Math.round(m / 60);
    if (h < 24) return h + "h ago";
    return Math.round(h / 24) + "d ago";
  } catch { return ""; }
}

function fallbackPoll(fn, ms) {
  const h = setInterval(() => { if (!document.hidden) fn(); }, ms);
  return () => clearInterval(h);
}

// "3s", "1m 12s", "2h 5m", "4d 2h"
function dur(ms) {
  if (!isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60), rs = s % 60;
  if (m < 60) return rs ? m + "m " + rs + "s" : m + "m";
  const h = Math.floor(m / 60), rm = m % 60;
  if (h < 24) return rm ? h + "h " + rm + "m" : h + "h";
  const d = Math.floor(h / 24), rh = h % 24;
  return rh ? d + "d " + rh + "h" : d + "d";
}

function between(aIso, bIso) {
  const a = new Date(aIso).getTime(), b = new Date(bIso).getTime();
  if (!isFinite(a) || !isFinite(b) || b < a) return "";
  return dur(b - a);
}

function actorClass(name) {
  const n = String(name || "").toLowerCase().trim();
  if (n === "ceo" || n.startsWith("ceo ")) return "who-ceo";
  if (n.startsWith("assistant")) return "who-assistant";
  if (n.startsWith("laya")) return "who-laya";
  if (n.startsWith("claude")) return "who-claude";
  return "who-worker";
}

function isInFlight(t) { return !!t && IN_FLIGHT.has(t.status); }
function isGate(t) { return !!t && GATES.has(t.status); }
function isLive(t) { return isInFlight(t) || isGate(t); }

// RESUME (docs/RESUME_SPEC.md §4): a hop the Router wrote to record that it
// restarted and resumed a task. Same rule as fleet.js and bonehound's order.trace.
const RESTART_ICON = "\u21bb";
function isRestartHop(h) {
  return !!h && String(h.from || "").trim() === "Router" && /^restarted/i.test(String(h.what || ""));
}

// Same mapping as statusTone() in api.js: ok | err | warn | run | dim.
function pillClass(status) {
  if (status === "merged") return "pill pill-ok";
  if (status === "failed" || status === "rejected") return "pill pill-err";
  if (GATES.has(status)) return "pill pill-warn";
  if (IN_FLIGHT.has(status)) return "pill pill-run";
  return "pill pill-dim";
}

function pill(status) {
  return '<span class="' + pillClass(status) + '">' + escHtml(status || "unknown") + "</span>";
}

function dotClass(status) {
  if (status === "merged") return "dot dot-ok";
  if (status === "failed" || status === "rejected") return "dot dot-err";
  if (GATES.has(status)) return "dot dot-warn";
  if (IN_FLIGHT.has(status)) return "dot dot-run";
  return "dot";
}

function hopWord(t) {
  const n = Array.isArray(t.trace) ? t.trace.length : 0;
  return n + (n === 1 ? " hop" : " hops");
}

function msg(e) {
  if (!e) return "unknown error";
  if (e.status) return "HTTP " + e.status + (e.message ? " — " + e.message : "");
  return e.message || String(e);
}

/* ---------------------------------------------------- view CSS (namespaced) */

function ensureStyles() {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  /* UI-CLEAN: this view's CSS moved to public/v2/style.css (one visual system
   * for the whole dashboard), so there is nothing to inject here. */
}

/* ---------------------------------------------------------------------- mount */

export function mount(el, ctx) {
  const c = ctx || {};
  const esc = typeof c.esc === "function" ? c.esc : escHtml;
  const ago = typeof c.ago === "function" ? c.ago : fallbackAgo;
  const hm = typeof c.hm === "function" ? c.hm : fallbackHm;
  const api = typeof c.api === "function" ? c.api : null;
  const poll = typeof c.poll === "function" ? c.poll : fallbackPoll;
  const navigate = typeof c.navigate === "function" ? c.navigate : (h) => { window.location.hash = h; };

  ensureStyles();

  const params = (c && c.params) || {};
  const paramsTaskId = String(params.taskId || params.id || "");

  let tasks = [];
  let loaded = false;
  let error = "";
  let filterLive = false;
  let stopPoll = null;
  let armedMs = 0; // cadence the poll is currently running at (0 = not armed yet)
  let lastLive = null; // last observed live-state, so the cadence only changes on a transition
  let disposed = false;
  let kicked = false;
  let seq = 0;

  // The hash is the source of truth (the shell may reuse this instance when only
  // the :taskId part of the route changes); ctx.params is the fallback.
  function currentTaskId() {
    const h = typeof location !== "undefined" ? String(location.hash || "") : "";
    const m = h.match(/^#\/flow(?:\/([^/?#]+))?/);
    if (m) return m[1] ? decodeURIComponent(m[1]) : "";
    return paramsTaskId;
  }

  /* ------------------------------------------------------------ rendering */

  function stateCard(kind, title, body, action) {
    return (
      '<div class="card state ' + kind + '">' +
      (title ? '<div class="state-title">' + esc(title) + "</div>" : "") +
      (body ? "<div>" + esc(body) + "</div>" : "") +
      (action || "") +
      "</div>"
    );
  }

  function loadingCard(what) {
    return '<div class="card state state-loading"><div class="spinner"></div><div>' + esc(what) + "</div></div>";
  }

  function errorCard() {
    if (!error) return "";
    return stateCard(
      "state-error",
      "Could not refresh",
      error,
      '<button class="btn btn-sm" data-act="retry">Retry</button>'
    );
  }

  function emptyCard(what) {
    return '<div class="card state state-empty"><div>' + esc(what) + "</div></div>";
  }

  function listRow(t) {
    const live = isInFlight(t) ? " · live" : isGate(t) ? " · waiting for approval" : "";
    return (
      '<a class="item" href="#/flow/' + encodeURIComponent(t.taskId) + '" data-act="open" data-tid="' + esc(t.taskId) + '">' +
      '<span class="' + dotClass(t.status) + '"></span>' +
      '<div class="grow">' +
      '<div class="item-title">' + esc(t.request || "(no request text)") + "</div>" +
      '<div class="item-sub">' + esc(t.projectName || t.projectId) + " · " + esc(t.departmentName || "") +
      " · " + esc(hopWord(t)) + esc(live) + "</div>" +
      "</div>" +
      '<div class="item-meta">' + pill(t.status) + '<span class="tiny">' + esc(ago(t.updatedAt)) + "</span></div>" +
      "</a>"
    );
  }

  function listHtml() {
    if (!loaded) {
      return '<div class="col flow">' + loadingCard("Loading recent orders…") + "</div>";
    }
    const liveCount = tasks.filter(isLive).length;
    const rows = filterLive ? tasks.filter(isLive) : tasks;
    const body = rows.length
      ? '<div class="flow-list">' + rows.map(listRow).join("") + "</div>"
      : emptyCard(
          filterLive
            ? "No orders are in flight right now."
            : "No orders yet. Give the assistant an order to watch its chain here."
        );
    return (
      '<div class="col flow">' +
      '<div class="row">' +
      '<div class="grow">' +
      '<div class="small muted">' + esc(String(tasks.length)) + " recent orders · " + esc(String(liveCount)) +
      " in flight</div>" +
      "</div>" +
      '<button class="btn btn-sm" data-act="filter">' + esc(filterLive ? "Showing: in flight" : "Showing: all") + "</button>" +
      '<button class="btn btn-sm" data-act="retry">Refresh</button>' +
      "</div>" +
      errorCard() +
      body +
      "</div>"
    );
  }

  function hopDetail(h) {
    const d = String(h.detail || "");
    if (!d) return "";
    if (d.length <= PREVIEW) return '<div class="pre mt-1">' + esc(d) + "</div>";
    return (
      '<details class="flow-more"><summary>' + esc(d.slice(0, 72).replace(/\s+/g, " ")) + "…</summary>" +
      '<div class="pre mt-1">' + esc(d) + "</div></details>"
    );
  }

  function hopHtml(h, prevTs, isCurrent, isTerminalHop, taskStatus) {
    const gap = prevTs ? between(prevTs, h.ts) : "";
    const restart = isRestartHop(h);
    // The restart hop is muted: it is the router telling the CEO what survived a
    // crash, not another agent doing work.
    const dot = restart ? "dot"
      : isCurrent ? (isGate({ status: taskStatus }) ? "dot dot-warn" : "dot dot-run")
        : isTerminalHop ? dotClass(taskStatus)
          : "dot";
    const note = restart
      ? '<span class="flow-restart-note">' + esc(RESTART_ICON + " resumed by the router after a restart") + "</span>" +
        (gap ? ' <span class="tiny muted">(gap ' + esc(gap) + " idle)</span>" : "")
      : isCurrent
        ? '<span class="flow-now">current hop</span> · started ' + esc(ago(h.ts))
        : gap ? "+" + esc(gap) + " after previous hop" : "";
    return (
      '<li class="flow-hop' + (isCurrent ? " is-live" : "") + (restart ? " is-restart" : "") + '">' +
      '<div class="flow-rail"><span class="' + dot + '"></span></div>' +
      '<div class="card flow-hop-card">' +
      '<div class="row">' +
      '<span class="who ' + actorClass(h.from) + '">' +
      (restart ? '<span class="flow-restart-icon" title="after a router restart">' + RESTART_ICON + "</span> " : "") +
      esc(h.from || "?") + "</span>" +
      '<span class="small muted">&rarr; ' + esc(h.what || "hand-off") + " &rarr;</span>" +
      '<span class="who ' + actorClass(h.to) + '">' + esc(h.to || "?") + "</span>" +
      '<span class="tiny muted right">' + esc(hm(h.ts)) + "</span>" +
      "</div>" +
      (note ? '<div class="tiny muted">' + note + "</div>" : "") +
      hopDetail(h) +
      "</div></li>"
    );
  }

  function detailHtml() {
    if (!loaded) {
      return '<div class="col flow">' + loadingCard("Loading the chain…") + "</div>";
    }
    const taskId = currentTaskId();
    const t = tasks.filter((x) => x.taskId === taskId)[0];
    const back = '<div class="row"><button class="btn btn-sm" data-act="back">&larr; All orders</button>' +
      (t ? '<button class="btn btn-sm" data-act="open-proj" data-pid="' + esc(t.projectId) + '">Project</button>' : "") +
      "</div>";

    if (!t) {
      return (
        '<div class="col flow">' + back +
        emptyCard("No order " + taskId + " among the last " + LIMIT + " orders — it may be older than the recent window.") +
        "</div>"
      );
    }

    const trace = Array.isArray(t.trace) ? t.trace : [];
    const live = isLive(t);
    const currentIdx = live && trace.length ? trace.length - 1 : -1;
    const last = trace.length - 1;

    const chain = trace.length
      ? '<ol class="flow-timeline">' +
        trace.map((h, i) => hopHtml(h, i > 0 ? trace[i - 1].ts : "", i === currentIdx, i === last, t.status)).join("") +
        "</ol>"
      : emptyCard("No hand-off trace for this task — it ran before tracing was added.");

    const liveNote = live
      ? '<div class="small muted">' +
        esc(isGate(t) ? "Waiting for approval — this view refreshes every " + MS_LIVE / 1000 + "s."
          : "In flight — this view refreshes every " + MS_LIVE / 1000 + "s.") +
        "</div>"
      : "";

    const outcome = t.error
      ? '<div class="card card-pad"><div class="card-head"><b class="h3" style="color:var(--err)">Error</b></div>' +
        '<div class="pre">' + esc(t.error) + "</div></div>"
      : t.result
        ? '<div class="card card-pad"><div class="card-head"><b class="h3">Result</b></div>' +
          '<div class="pre">' + esc(t.result) + "</div></div>"
        : "";

    return (
      '<div class="col flow">' + back +
      errorCard() +
      '<div class="card card-pad">' +
      '<div class="card-head"><div class="h2 grow wrap-any">' + esc(t.request || t.taskId) + "</div>" + pill(t.status) + "</div>" +
      '<div class="small muted wrap-any">task ' + esc(t.taskId) + " · " + esc(t.projectName || t.projectId) +
      " · " + esc(t.departmentName || "") + " · " + esc(hopWord(t)) + " · started " + esc(hm(t.createdAt)) +
      " · updated " + esc(ago(t.updatedAt)) + "</div>" +
      liveNote +
      "</div>" +
      chain + outcome +
      "</div>"
    );
  }

  function render() {
    el.innerHTML = currentTaskId() ? detailHtml() : listHtml();
  }

  /* ---------------------------------------------------------------- data */

  function arm(ms) {
    if (stopPoll) { try { stopPoll(); } catch { /* ignore */ } stopPoll = null; }
    if (disposed) return;
    try { stopPoll = poll(tick, ms); armedMs = ms; } catch { stopPoll = null; armedMs = 0; }
  }

  async function tick() {
    if (disposed) return;
    kicked = true;
    const mine = ++seq;
    try {
      const data = await api("/company/flow?limit=" + LIMIT);
      if (disposed || mine !== seq) return;
      tasks = Array.isArray(data && data.tasks) ? data.tasks : [];
      error = "";
      loaded = true;
    } catch (e) {
      if (disposed || mine !== seq) return;
      error = msg(e);
      loaded = true; // show the error state instead of spinning forever
    }
    render();
    // Only re-arm when the cadence must actually change (an in-flight task means
    // "live"; everything settled means polling can back off). Re-arming costs an
    // immediate refetch, so it is avoided when the armed cadence already matches.
    const live = tasks.some(isLive);
    if (live !== lastLive) {
      lastLive = live;
      const want = live ? MS_LIVE : MS_IDLE;
      if (want !== armedMs) arm(want);
    }
  }

  /* -------------------------------------------------------------- wiring */

  function onClick(e) {
    const node = e.target && e.target.closest ? e.target.closest("[data-act]") : null;
    if (!node) return;
    const act = node.getAttribute("data-act");
    if (act === "open") {
      // A real <a href="#/flow/:id">: let the browser change the hash as well, so
      // navigation works whether or not the shell's navigate() does its own thing.
      const href = node.getAttribute("href");
      if (href) navigate(href);
      return;
    }
    if (act === "open-proj") {
      const pid = node.getAttribute("data-pid");
      if (pid) navigate("#/projects/" + encodeURIComponent(pid));
      return;
    }
    if (act === "back") { navigate("#/flow"); return; }
    if (act === "filter") { filterLive = !filterLive; render(); return; }
    if (act === "retry") { tick(); return; }
  }

  function onHash() {
    if (disposed) return;
    if (!currentTaskId()) filterLive = false; // returning to the list
    render();
  }

  el.addEventListener("click", onClick);
  if (typeof window !== "undefined") window.addEventListener("hashchange", onHash);

  render(); // paint the loading state immediately, before the first fetch lands

  if (api) {
    arm(MS_LIVE); // api.js's poll fires immediately; a poll that does not gets kicked below
    Promise.resolve().then(() => { if (!kicked && !disposed) tick(); });
  } else {
    error = "api() is unavailable (public/v2/api.js did not load).";
    loaded = true;
    render();
  }

  return function cleanup() {
    disposed = true;
    if (stopPoll) { try { stopPoll(); } catch { /* ignore */ } stopPoll = null; }
    el.removeEventListener("click", onClick);
    if (typeof window !== "undefined") window.removeEventListener("hashchange", onHash);
    el.innerHTML = "";
  };
}
