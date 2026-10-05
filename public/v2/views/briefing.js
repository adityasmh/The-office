// UI-BRIEFING view: the CEO's home page. One plain-words page for everything running.
//
// Route:  #/briefing            live data (GET /company/briefing, GET /company/runs)
//         #/briefing?mock=1      sample data of exactly the same shape (use until the
//                                endpoints exist); no network calls at all in this mode.
//
// Contract (docs/UI_V2_SPEC.md): mount(el, ctx) -> cleanup().
// ctx = { api, poll, esc, ago, hm, navigate(hash), params }.
//
// Data shapes (docs/REPORTING_SPEC.md sections 1 and 2):
//   Briefing = { generatedAt, model, summary,
//                needsYou:[{id, text, runId?, kind:'approve'|'choice'|'provide'|'external',
//                           actions:[{id,label,effect,url?,params?}], question?, input?:{name,label,secret,placeholder?}}],
//                done:[{text, runId?, at}],
//                inProgress:[{text, runId?, owner, remaining:[string]}],
//                problems:[{text, runId?}],
//                counts:{running,done,failed,stuck} }
//   RunCard  = { runId, kind:"task"|"fleet"|"jcode", title, owner, state, headline,
//                done:[string], remaining:[string], needsCeo?, model, modelReason,
//                checkedAt, evidenceHash, ref:{ projectId?, taskId?, orderId?, sessionId?, sessionName? } }
//   GET /company/runs -> { cards:[RunCard], counts, manager }  (a bare array or {runs} also accepted)
//
// Run ids are NAMESPACED by src/company/runManagers.ts:
//   "task:<projectId>:<taskId>"  -> link #/flow/<taskId>   (NOT the whole runId)
//   "fleet:<orderId>"            -> link #/fleet/<orderId>
//   "jcode:<sessionId>"          -> expandable run card
// The link is taken from card.ref when the card is present, else parsed out of the runId.
//
// Every item links to its run: tasks -> #/flow/:taskId, fleet -> #/fleet/:orderId,
// jcode runs -> an expandable run card. Each item also has an "Ask the assistant
// about this" link to #/assistant?q=... (UI-ASSISTANT: parse ctx.params.q).
//
// Mutation endpoints (POST /company/briefing/refresh, POST /company/briefing/seen)
// are only called in live mode; in ?mock=1 they are simulated locally so the page
// can never touch the real briefing file while there is no endpoint behind it.
//
// Theme: only style.css classes/variables plus CSS namespaced .brief-* (defined here,
// like the .flow-* rail in views/flow.js).

export const title = "Briefing";

const BRIEFING_PATH = "/company/briefing";
const RUNS_PATH = "/company/runs";
const REFRESH_PATH = "/company/briefing/refresh";
const SEEN_PATH = "/company/briefing/seen";
const NEEDS_YOU_RESOLVE = (id) => "/company/needs-you/" + encodeURIComponent(id) + "/resolve";
const POLL_MS = 20000; // spec: poll every 20s
const STYLE_ID = "briefing-view-style";

/* --------------------------------------------------------------- pure helpers */

function escHtml(s) {
  return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function fallbackAgo(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const ms = Date.now() - d.getTime();
    if (!isFinite(ms)) return "";
    if (ms < 5000) return "just now";
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + "s ago";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    const h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    return Math.floor(h / 24) + "d ago";
  } catch { return ""; }
}

function fallbackHm(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "--:--:--";
    const p = (n) => String(n).padStart(2, "0");
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  } catch { return "--:--:--"; }
}

function fallbackPoll(fn, ms) {
  fn();
  const h = setInterval(() => { if (!document.hidden) fn(); }, Math.max(250, ms));
  return () => clearInterval(h);
}

function msg(e) {
  if (!e) return "unknown error";
  if (e.status) return "HTTP " + e.status + (e.message ? ": " + e.message : "");
  return e.message || String(e);
}

/** `?mock=1` (any value except 0/false/off) turns on sample data. */
export function isMockValue(v) {
  if (v === undefined || v === null) return false;
  const s = String(v).trim().toLowerCase();
  return !(s === "0" || s === "false" || s === "no" || s === "off");
}

/** The hash is the source of truth (ctx.params may lag a shell that reuses a view). */
function mockFromLocation() {
  try {
    const h = String(location.hash || "");
    const q = h.indexOf("?");
    if (q < 0) return false;
    const m = /(?:^|&)mock=([^&]*)/.exec(h.slice(q + 1));
    return m ? isMockValue(m[1]) : false;
  } catch { return false; }
}

const n = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/* ------------------------------------------------------------- mock sample data */

/* Timestamps are relative to now so "3m ago" reads correctly in a demo. */
const MIN = 60 * 1000;
const at = (minsAgo) => new Date(Date.now() - minsAgo * MIN).toISOString();

function mockRuns() {
  /* runId + ref follow the REAL scheme in src/company/runManagers.ts, so the sample data
     exercises the same namespaced ids the live endpoint returns. */
  return [
    {
      runId: "task:pmumhp51u:tmummq62z", kind: "task", title: "Agent office clone",
      owner: "UI team: Office page", state: "failed",
      headline: "The office page stopped mid-build and needs a restart.",
      done: ["Picked the parts of the office project worth copying", "Wrote the notes on what to reuse"],
      remaining: ["Draw the desks for each team", "Show who is working right now"],
      needsCeo: "Say whether the office page is still worth finishing this week.",
      model: "claude-opus-5-5", modelReason: "The run failed, so it always gets the strongest reviewer.",
      checkedAt: at(12), evidenceHash: "a1b2c3d4",
      ref: { kind: "task", projectId: "pmumhp51u", taskId: "tmummq62z" },
    },
    {
      runId: "task:pmumhp51x:tmummg5y2", kind: "task", title: "Skinny dashboard page",
      owner: "UI team: Flow page", state: "done",
      headline: "The order chain page is finished and in use.",
      done: ["Shows every hand-off in order", "Colours the people involved", "Highlights the current step"],
      remaining: [],
      model: "sonnet-4.5", modelReason: "Normal work, the cheaper reviewer is enough.",
      checkedAt: at(41), evidenceHash: "e5f6a7b8",
      ref: { kind: "task", projectId: "pmumhp51x", taskId: "tmummg5y2" },
    },
    {
      runId: "fleet:fo-2026-09-29-01", kind: "fleet", title: "Fleet: run our own tools from the dashboard",
      owner: "Platform team: Fleet page", state: "working",
      headline: "The dashboard can now start work orders for our own tools.",
      done: ["Work orders can be created from the dashboard"],
      remaining: ["Show each order's progress live", "Report the result back into the dashboard"],
      model: "sonnet-4.5", modelReason: "Laya said the order was clear and routine.",
      checkedAt: at(6), evidenceHash: "0011aa22",
      ref: { kind: "fleet", orderId: "fo-2026-09-29-01" },
    },
    {
      runId: "jcode:session-kikazaru", kind: "jcode", title: "Assistant page session",
      owner: "jcode kikazaru (UI-ASSISTANT)", state: "working",
      headline: "The assistant page is being built and can already hold a conversation.",
      done: ["Chat with the assistant", "Show the orders its replies created"],
      remaining: ["Accept a prefilled question from another page"],
      model: "sonnet-4.5", modelReason: "Laya offline, so the plain reviewer was used.",
      checkedAt: at(3), evidenceHash: "77cc44dd",
      sessionId: "session-kikazaru", ref: { kind: "jcode", sessionId: "session-kikazaru", sessionName: "kikazaru" },
    },
    {
      runId: "jcode:session-tigress", kind: "jcode", title: "Router watch session",
      owner: "jcode tigress (OPS)", state: "stuck",
      headline: "No new activity for a while while watching the server.",
      done: ["Checked every time the server stopped today"],
      remaining: ["Finish the write-up of why it restarts"],
      needsCeo: "Decide if the server fix should be finished before new work starts.",
      model: "claude-opus-5-5", modelReason: "The run looks stuck and it may touch the CEO's own tooling.",
      checkedAt: at(21), evidenceHash: "9988ffee",
      sessionId: "session-tigress", ref: { kind: "jcode", sessionId: "session-tigress", sessionName: "tigress" },
    },
  ];
}

function mockBriefing() {
  return {
    generatedAt: at(2),
    model: "sonnet-4.5",
    summary:
      "Good progress this morning: the order chain page is done and the dashboard rebuild is nearly there. " +
      "Two things need you, and one session looks stuck.",
    needsYou: [
      {
        id: "task:pmumhp51u:tmummq62z",
        text: "Say whether the office page is still worth finishing this week.",
        runId: "task:pmumhp51u:tmummq62z",
        kind: "approve",
        actions: [
          { id: "approve", label: "Approve", effect: "approve_gate", params: { projectId: "pmumhp51u", taskId: "tmummq62z", gate: "intake" } },
          { id: "drop", label: "Drop", effect: "drop_task", params: { projectId: "pmumhp51u", taskId: "tmummq62z" } },
        ],
      },
      {
        id: "budget:claude",
        text: "Claude usage hit the monthly spending limit.",
        kind: "external",
        question: "Claude hit its spending limit. Raise it at claude.ai, use Kimi instead, or tell us you raised it.",
        actions: [
          { id: "open_limit_page", label: "Open Claude settings", effect: "open_link", url: "https://claude.ai/settings/usage" },
          { id: "use_kimi", label: "Use Kimi", effect: "reissue_kimi" },
          { id: "raised_retry", label: "I raised it", effect: "recheck_budget", params: { provider: "claude" } },
        ],
      },
      {
        id: "fleet:fo-2026-09-29-01",
        text: "Pick this morning's top priority for the team.",
        runId: "fleet:fo-2026-09-29-01",
        kind: "choice",
        question: "Which approach should the team take?",
        actions: [
          { id: "approve", label: "Recommended hidden comment", effect: "retry_order", params: { orderId: "fo-2026-09-29-01" } },
          { id: "approve_alt", label: "Visible header", effect: "retry_order", params: { orderId: "fo-2026-09-29-01" } },
        ],
      },
      {
        id: "fleet:missing-key",
        text: "A fleet order failed because the Kimi access key is missing.",
        kind: "provide",
        input: { name: "OPENCODE_API_KEY", label: "Kimi access key (OpenCode Go gateway)", secret: true, placeholder: "sk-opencode-..." },
        actions: [
          { id: "save_key_retry", label: "Save key and retry", effect: "provide_key", params: { orderId: "fo-missing", envName: "OPENCODE_API_KEY" } },
          { id: "drop", label: "Drop order", effect: "drop_order", params: { orderId: "fo-missing" } },
        ],
      },
    ],
    done: [
      { text: "Finished the order chain page the CEO asked for", runId: "task:pmumhp51x:tmummg5y2", at: at(23) },
      { text: "Slack now shows finished work in the thread it came from", at: at(48) },
      { text: "Wrote the notes on what to reuse from the office project", runId: "task:pmumhp51u:tmummq62z", at: at(64) },
      { text: "Every step of an order is now written down and shown", runId: "task:pmumhp51x:tmummg5y2", at: at(95) },
    ],
    inProgress: [
      {
        text: "Dashboard rebuild: briefing page the CEO lands on",
        runId: "fleet:fo-2026-09-29-01",
        owner: "UI team: Briefing page",
        remaining: ["Show what needs you first", "Show done and remaining as tick boxes", "Link every item to its run"],
      },
      {
        text: "Assistant page: talk to one assistant that knows every project",
        runId: "jcode:session-kikazaru",
        owner: "UI team: Assistant page",
        remaining: ["Accept a prefilled question", "Show live status on the orders it creates"],
      },
      {
        text: "Server keeps stopping; find out why before adding more work",
        runId: "jcode:session-tigress",
        owner: "Platform team: server watch",
        remaining: ["Write up the root cause", "Keep the server up for a full day"],
      },
    ],
    problems: [
      { text: "The office page stopped mid-build and cannot resume by itself.", runId: "task:pmumhp51u:tmummq62z" },
      { text: "The router watch session has been quiet for over fifteen minutes.", runId: "jcode:session-tigress" },
    ],
    counts: { running: 6, done: 4, failed: 1, stuck: 1 },
  };
}

/* ------------------------------------------------------- view CSS (namespaced) */

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

  const params = c.params || {};
  const mockFromParams = params.mock !== undefined ? isMockValue(params.mock) : false;

  let mock = mockFromParams || mockFromLocation();
  let loaded = false;
  let error = "";
  let staleError = ""; // last refresh failed but we still have a briefing to show
  let notLive = false; // GET /company/briefing answered 404: endpoints not built yet
  let briefing = null;
  let runs = [];
  const openRuns = new Set(); // run cards the CEO expanded, kept across re-renders
  let notice = ""; // result of Refresh / Mark as read
  let noticeTone = "";
  let seenAt = null; // local "marked as read" time (mock mode) / server reply time
  let busy = false;
  let stopPoll = null;
  let disposed = false;
  let kicked = false; // has the first refresh happened yet?
  let seq = 0;
  let needsResult = null; // { text, tone } shown under the Needs you list
  let needsBusy = new Set(); // item ids currently resolving

  /* --------------------------------------------------------------- data access */

  function runCard(runId) {
    const id = String(runId || "");
    if (!id) return null;
    for (const r of runs) if (r && String(r.runId) === id) return r;
    return null;
  }

  /* Run ids are namespaced by src/company/runManagers.ts: "task:<projectId>:<taskId>",
     "fleet:<orderId>", "jcode:<sessionId>". A bare id (hand-written briefing) is guessed. */
  function runKind(runId, card) {
    if (card && card.kind) return String(card.kind);
    const id = String(runId || "");
    if (/^task:/i.test(id)) return "task";
    if (/^fleet:/i.test(id)) return "fleet";
    if (/^jcode:/i.test(id)) return "jcode";
    if (/^t[a-z0-9]{5,}$/i.test(id)) return "task"; // a bare pipeline task id, e.g. tmummq62z
    if (/^fo[-_]/i.test(id)) return "fleet";
    return "jcode";
  }

  /* The hash target for a run. The flow and fleet views key on the BARE taskId / orderId, so
     the link must not carry the whole namespaced runId. "" means "no page to open" (jcode
     runs are expanded in place instead). */
  function runHref(runId, card) {
    const kind = runKind(runId, card);
    const ref = (card && card.ref) || {};
    const raw = String(runId || "");
    const rest = raw.replace(/^[A-Za-z]+:/, "");
    const parts = rest.split(":");
    if (kind === "task") {
      const taskId = ref.taskId || (parts.length > 1 ? parts[parts.length - 1] : (/^t[a-z0-9]{5,}$/i.test(rest) ? rest : ""));
      return taskId ? "#/flow/" + encodeURIComponent(taskId) : "";
    }
    if (kind === "fleet") {
      const orderId = ref.orderId || parts[0] || "";
      return orderId ? "#/fleet/" + encodeURIComponent(orderId) : "";
    }
    return "";
  }

  function loadRunsBestEffort() {
    if (!api) return Promise.resolve();
    return api(RUNS_PATH, { fresh: true })
      .then((d) => {
        // The live endpoint answers { cards, counts, manager }; a bare array or {runs} is
        // accepted too so the view cannot break if that shape changes back.
        const list = Array.isArray(d) ? d
          : Array.isArray(d && d.cards) ? d.cards
            : Array.isArray(d && d.runs) ? d.runs
              : [];
        runs = list.filter((r) => r && r.runId);
      })
      .catch(() => { /* the briefing is still usable without the cards */ });
  }

  // GET helpers. The briefing must NEVER be served from the shell's shared GET cache
  // (public/v2/api.js caches every GET for 5s and will happily hand back an answer up to 5
  // minutes old, stale-while-revalidate). This page exists to show what is happening NOW, and
  // a cached answer would also hide a dead router. `fresh: true` skips the cache for this read
  // and still refreshes the cache for every other view.
  async function loadLive() {
    const mine = ++seq;
    try {
      const b = await api(BRIEFING_PATH, { fresh: true });
      if (disposed || mine !== seq) return;
      briefing = b && typeof b === "object" ? b : null;
      error = "";
      staleError = "";
      notLive = false;
      loaded = true;
      render(); // paint the briefing immediately: the run cards below must never delay it
      // The cards only add detail, so they load after the first paint. /company/runs can be
      // slow (it manager-checks runs), and a slow card fetch must not blank the CEO's page.
      loadRunsBestEffort().then(() => {
        if (!disposed && mine === seq) render();
      });
    } catch (e) {
      if (disposed || mine !== seq) return;
      loaded = true;
      if (e && (e.status === 404 || e.status === 501)) {
        notLive = true;
        error = "";
      } else if (briefing) {
        // The router is unreachable or answered 500 (this company's router restarts often).
        // Keep the briefing the CEO can still read and mark it stale, instead of replacing a
        // real page with an error card.
        staleError = msg(e);
        error = "";
      } else {
        error = msg(e);
        notLive = false;
      }
    }
    render();
  }

  async function loadMock() {
    const mine = ++seq;
    await new Promise((r) => setTimeout(r, 120)); // show the loading state briefly
    if (disposed || mine !== seq) return;
    runs = mockRuns();
    briefing = mockBriefing();
    loaded = true;
    error = "";
    notLive = false;
    render();
  }

  function reload() {
    return mock ? loadMock() : loadLive();
  }

  /* --------------------------------------------------------------- rendering */

  function stateCard(kind, titleTxt, body, action) {
    return (
      '<div class="card state ' + kind + '">' +
      (titleTxt ? '<div class="state-title">' + esc(titleTxt) + "</div>" : "") +
      (body ? "<div>" + esc(body) + "</div>" : "") +
      (action || "") +
      "</div>"
    );
  }

  function runningLabel() {
    return ago(briefing && briefing.generatedAt) || "just now";
  }

  function kpi(val, lbl, tone) {
    return (
      '<div class="kpi"><div class="kpi-val"' + (tone ? ' style="color:var(--' + tone + ')"' : "") + ">" +
      esc(String(val)) + '</div><div class="kpi-lbl">' + esc(lbl) + "</div></div>"
    );
  }

  function countsHtml(counts) {
    const k = counts || {};
    return (
      '<div class="brief-kpis">' +
      kpi(n(k.running), "running", null) +
      kpi(n(k.done), "done", "ok") +
      kpi(n(k.failed), "failed", n(k.failed) > 0 ? "err" : null) +
      kpi(n(k.stuck), "stuck", n(k.stuck) > 0 ? "warn" : null) +
      "</div>"
    );
  }

  function askLink(q) {
    const href = "#/assistant?q=" + encodeURIComponent(q);
    return '<a class="brief-ask" href="' + esc(href) + '" data-act="ask" ' +
      'title="Open the assistant with this question" ' +
      'aria-label="Ask the assistant about this">Ask the assistant about this</a>';
  }

  function runLinkHtml(runId, card, label) {
    const href = runHref(runId, card);
    const txt = esc(label || runId);
    if (href) {
      return '<a class="link" href="' + esc(href) + '" data-act="open" title="Open this run">' + txt + "</a>";
    }
    // No page of its own (jcode sessions): expand the run card in place instead.
    return '<button type="button" class="linkbtn" data-act="toggle-run" data-run="' + esc(runId) + '" ' +
      'title="Show the card for this run">' + txt + "</button>";
  }

  function stateTone(state) {
    const s = String(state || "");
    if (s === "done") return "ok";
    if (s === "failed") return "err";
    if (s === "stuck") return "warn";
    if (s === "waiting_for_ceo") return "warn";
    return "run";
  }

  function runCardHtml(card, runId) {
    if (!card) {
      return '<div class="brief-sub">No detailed card yet for this run' +
        (runId ? ' <span class="mono tiny wrap-any">' + esc(runId) + "</span>" : "") + ".</div>";
    }
    const tone = stateTone(card.state);
    const items = (arr, mark, cls) => (Array.isArray(arr) ? arr : [])
      .map((t) => '<li><span class="' + cls + '">' + esc(mark) + "</span><span>" + esc(t) + "</span></li>")
      .join("");
    return (
      '<div class="brief-card">' +
      '<div class="row">' +
      '<span class="pill pill-' + esc(tone) + '">' + esc(card.state || "unknown") + "</span>" +
      '<span class="small grow wrap-any">' + esc(card.headline || "") + "</span>" +
      "</div>" +
      (Array.isArray(card.done) && card.done.length
        ? '<ul class="brief-do">' + items(card.done, "✓", "tick") + "</ul>" : "") +
      (Array.isArray(card.remaining) && card.remaining.length
        ? '<ul class="brief-do">' + items(card.remaining, "☐", "box") + "</ul>" : "") +
      (card.needsCeo
        ? '<div class="brief-sub" style="color:var(--warn)">Needs you: ' + esc(card.needsCeo) + "</div>" : "") +
      '<div class="brief-sub">' +
      "<span>Owner: " + esc(card.owner || "unassigned") + "</span>" +
      "<span>· checked " + esc(ago(card.checkedAt) || "just now") + "</span>" +
      "<span>· model " + esc(card.model || "unknown") + "</span>" +
      "</div>" +
      (card.modelReason ? '<div class="brief-sub">Why that model: ' + esc(card.modelReason) + "</div>" : "") +
      (card.runId ? '<div class="brief-sub mono tiny wrap-any">run ' + esc(card.runId) +
        (card.ref && card.ref.sessionName ? " (" + esc(card.ref.sessionName) + ")" : "") + "</div>" : "") +
      "</div>"
    );
  }

  function subLine(parts) {
    const keep = parts.filter(Boolean);
    if (!keep.length) return "";
    return '<div class="brief-sub">' + keep.join("<span>·</span>") + "</div>";
  }

  /** Build the question / input / action buttons for a needs-you item. */
  function needsYouActionsHtml(o) {
    if (!o._needsYou || !o.id) return "";
    const busy = needsBusy.has(o.id);
    const actions = Array.isArray(o.actions) ? o.actions : [];
    let html = "";
    if (o.question && (o.kind === "choice" || o.kind === "external")) {
      html += '<div class="small muted" style="margin:4px 0 2px">' + esc(o.question) + "</div>";
    }
    if (o.input && o.kind === "provide") {
      html += (
        '<div class="row" style="align-items:center;gap:8px;flex-wrap:wrap;margin:4px 0 2px">' +
        '<label class="tiny muted" for="ny-in-' + esc(o.id) + '">' + esc(o.input.label) + "</label>" +
        '<input id="ny-in-' + esc(o.id) + '" type="password" autocomplete="off" class="in in-sm" ' +
        'data-input-id="' + esc(o.id) + '" data-input-name="' + esc(o.input.name || "value") + '"' +
        (o.input.placeholder ? ' placeholder="' + esc(o.input.placeholder) + '"' : "") +
        ' style="max-width:260px"' + (busy ? " disabled" : "") + ">" +
        "</div>"
      );
    }
    if (!actions.length) return html;
    html += '<div class="row" style="gap:8px;flex-wrap:wrap;margin-top:6px">';
    for (const a of actions) {
      if (!a || !a.id) continue;
      const label = esc(a.label || "Action");
      const actionId = esc(a.id);
      const isLink = a.effect === "open_link" && a.url;
      const dim = busy ? ' style="opacity:0.5;pointer-events:none"' : "";
      if (isLink) {
        html += '<a class="btn btn-sm" href="' + esc(a.url) + '" target="_blank" rel="noopener"' + dim +
          ' data-act="needs-link" data-item="' + esc(o.id) + '" data-action="' + actionId + '">' + label + "</a>";
      } else {
        html += '<button type="button" class="btn btn-sm"' + (busy ? " disabled" : "") +
          ' data-act="needs-action" data-item="' + esc(o.id) + '" data-action="' + actionId + '">' +
          label + "</button>";
      }
    }
    html += "</div>";
    return html;
  }

  /** One CEO-facing item: mark, text, optional run link, actions. */
  function itemHtml(o) {
    const runId = o.runId ? String(o.runId) : "";
    const card = runId ? runCard(runId) : null;
    const open = runId && openRuns.has(runId);
    const kindLabel = card ? String(card.kind || "") : runId ? runKind(runId, null) : "";
    const expanded = runId && (open || (o.expandWhenNoCard && !card));

    const textHtml = o.href
      ? runLinkHtml(runId || o.runId, card, o.text)
      : esc(o.text);

    const nyHtml = needsYouActionsHtml(o);

    const body =
      '<li class="brief-item ' + (o.cls || "") + '"' + (runId ? ' data-item-run="' + esc(runId) + '"' : "") + ">" +
      '<span class="brief-mark" aria-hidden="true">' + esc(o.mark || "•") + "</span>" +
      '<div class="brief-txt">' +
      '<div class="wrap-any">' + textHtml + "</div>" +
      nyHtml +
      subLine([
        o.ownerHtml || (o.owner ? "Owner: " + esc(o.owner) : ""),
        o.at ? esc(ago(o.at)) : "",
        kindLabel ? '<span class="tiny muted">' + esc(kindLabel) + " run</span>" : "",
        runId && card && runKind(runId, card) === "jcode" ? '<span class="tiny mono wrap-any">' + esc(runId) + "</span>" : "",
        runId && !card ? '<span class="tiny muted">no card yet</span>' : "",
      ]) +
      (Array.isArray(o.remaining) && o.remaining.length
        ? '<ul class="brief-do">' + o.remaining.map(
            (t) => '<li><span class="box">☐</span><span>' + esc(t) + "</span></li>",
          ).join("") + "</ul>"
        : "") +
      (expanded ? runCardHtml(card, runId) : "") +
      "</div>" +
      '<div class="brief-acts">' +
      (o.needsYouTone ? '<span class="pill pill-warn">needs you</span>' : "") +
      askLink(o.askText || (o.text + (o.askSuffix ? " " + o.askSuffix : ""))) +
      "</div>" +
      "</li>";
    return body;
  }

  function section(heading, hint, items, emptyTxt) {
    const list = Array.isArray(items) ? items : [];
    const resultHtml = heading === "Needs you" && needsResult
      ? '<div class="small" style="margin-top:8px;color:var(--' + esc(needsResult.tone || "dim") + ')">' +
        esc(needsResult.text) + "</div>"
      : "";
    return (
      '<div class="card card-pad brief-sect">' +
      '<div class="brief-sect-head"><span class="t">' + esc(heading) + "</span>" +
      '<span class="badge-count">' + esc(String(list.length)) + "</span>" +
      (hint ? '<span class="tiny muted">' + esc(hint) + "</span>" : "") +
      "</div>" +
      (list.length
        ? '<ul class="brief-items">' + list.map(itemHtml).join("") + "</ul>"
        : '<div class="small muted">' + esc(emptyTxt || "Nothing here right now.") + "</div>") +
      resultHtml +
      "</div>"
    );
  }

  function noticeHtml() {
    if (!notice) return "";
    return (
      '<div class="brief-note"><span class="pill pill-' + esc(noticeTone || "dim") + '">' +
      esc(notice) + "</span></div>"
    );
  }

  function headerHtml() {
    const b = briefing || {};
    const counts = b.counts || {};
    const needs = Array.isArray(b.needsYou) ? b.needsYou.length : 0;
    return (
      '<div class="card card-pad">' +
      '<div class="row brief-hdr">' +
      '<div class="grow">' +
      '<div class="small muted">Written ' + esc(runningLabel()) +
      (b.model ? ' by ' + esc(b.model) : "") +
      (seenAt ? " · you last read it " + esc(ago(seenAt) || "just now") : "") +
      "</div>" +
      "</div>" +
      '<button type="button" class="btn btn-sm" data-act="refresh"' + (busy ? " disabled" : "") + ">Refresh</button>" +
      '<button type="button" class="btn btn-sm' + (needs ? " btn-primary" : "") + '" data-act="seen"' +
      (busy ? " disabled" : "") + ">" + (needs ? "Mark as read (" + needs + ")" : "Mark as read") + "</button>" +
      "</div>" +
      noticeHtml() +
      (b.summary ? '<div class="small mt-1">' + esc(b.summary) + "</div>" : "") +
      '<div class="mt-2">' + countsHtml(counts) + "</div>" +
      "</div>"
    );
  }

  function mockBanner() {
    if (!mock) return "";
    return (
      '<div class="card card-pad">' +
      '<div class="row">' +
      '<span class="pill pill-warn">sample data</span>' +
      '<span class="small muted grow">This page is showing made-up examples ('
      + '<span class="mono">?mock=1</span>) because the briefing service is not live yet.</span>' +
      '<button type="button" class="btn btn-sm" data-act="live">Try live data</button>' +
      "</div></div>"
    );
  }

  function notLiveCard() {
    return stateCard(
      "notbuilt",
      "The briefing is not being written yet",
      "The page is ready, but GET /company/briefing does not answer yet (it answered 404). " +
      "Until the reporting service is live you can look at sample data of exactly the same shape.",
      '<div class="row row-center mt-1">' +
      '<button type="button" class="btn btn-primary" data-act="mock">View sample data</button>' +
      '<button type="button" class="btn" data-act="retry">Check again</button>' +
      '<a class="btn" href="/">old dashboard</a>' +
      "</div>",
    );
  }

  function errorCard() {
    if (!error) return "";
    return stateCard(
      "state-error",
      "Could not load your briefing",
      error,
      '<div class="row row-center mt-1">' +
      '<button type="button" class="btn btn-primary" data-act="retry">Retry</button>' +
      '<button type="button" class="btn" data-act="mock">View sample data</button>' +
      "</div>",
    );
  }

  function staleBanner() {
    if (!staleError) return "";
    return (
      '<div class="card card-pad">' +
      '<div class="row">' +
      '<span class="pill pill-warn">reconnecting</span>' +
      '<span class="small muted grow wrap-any">Could not reach the router just now (' +
      esc(staleError) + '). This is the last briefing it sent' +
      (briefing && briefing.generatedAt ? ', from ' + esc(ago(briefing.generatedAt) || "earlier") : "") +
      '. The page keeps trying every ' + POLL_MS / 1000 + "s.</span>" +
      "</div></div>"
    );
  }

  function briefingHtml() {
    const b = briefing || {};
    const needs = b.needsYou || [];
    const done = b.done || [];
    const inProg = b.inProgress || [];
    const problems = b.problems || [];

    const needsItems = needs.map((it) => ({
      _needsYou: true,
      id: it.id,
      kind: it.kind,
      question: it.question,
      input: it.input,
      actions: it.actions,
      text: it.text || "(no text)",
      runId: it.runId,
      mark: "❗",
      cls: "needs",
      needsYouTone: true,
      href: !!it.runId,
      askText: "What do you need from me about: " + (it.text || "this item"),
    }));

    const doneItems = done.map((it) => ({
      text: it.text || "(no text)",
      runId: it.runId,
      at: it.at,
      mark: "✅",
      href: !!it.runId,
      askText: "Tell me more about what was finished: " + (it.text || "this item"),
    }));

    const progItems = inProg.map((it) => ({
      text: it.text || "(no text)",
      runId: it.runId,
      owner: it.owner,
      remaining: it.remaining,
      mark: "◐",
      href: !!it.runId,
      askText: "What is left on: " + (it.text || "this item") + "?",
    }));

    const problemItems = problems.map((it) => ({
      text: it.text || "(no text)",
      runId: it.runId,
      mark: "!",
      cls: "problem",
      href: !!it.runId,
      askText: "What is going wrong with: " + (it.text || "this item") + "?",
    }));

    const nothingAtAll = !needs.length && !done.length && !inProg.length && !problems.length;

    return (
      '<div class="col brief">' +
      mockBanner() +
      staleBanner() +
      headerHtml() +
      errorCard() +
      section("Needs you", "These are waiting on a decision or a go-ahead from you.",
        needsItems, "Nothing needs you right now.") +
      section("Done", "Finished since you last looked.", doneItems, "Nothing finished yet.") +
      section("In progress", "Each line shows who has it and what is still open.",
        progItems, "Nothing is running right now.") +
      section("Problems", "Things that went wrong and may need a new start.", problemItems,
        "No problems reported.") +
      (nothingAtAll
        ? '<div class="card state state-empty"><div>The briefing is empty: nothing has run since it was written.</div></div>'
        : "") +
      '<div class="tiny muted">This page refreshes itself every ' + POLL_MS / 1000 + "s. " +
      'Sample data: <span class="mono">#/briefing?mock=1</span></div>' +
      "</div>"
    );
  }

  function loadingHtml() {
    return (
      '<div class="col brief">' +
      '<div class="card state state-loading"><div class="spinner"></div>' +
      "<div>" + (mock ? "Loading sample briefing…" : "Reading your briefing…") + "</div></div>" +
      "</div>"
    );
  }

  function render() {
    if (!loaded) {
      el.innerHTML = loadingHtml();
      return;
    }
    if (notLive) {
      el.innerHTML = '<div class="col brief">' + notLiveCard() + "</div>";
      return;
    }
    if (briefing === null) {
      el.innerHTML = '<div class="col brief">' +
        errorCard() +
        '<div class="card state state-empty"><div>No briefing yet.</div></div>' +
        "</div>";
      return;
    }
    el.innerHTML = briefingHtml();
  }

  /* ------------------------------------------------------------- data loading */

  function startMock() {
    mock = true;
    loaded = false;
    render();
    if (!isMockValue(params.mock)) {
      const base = String(location.hash || "#/briefing").split("?")[0];
      navigate(base + "?mock=1");
    }
    return reload();
  }

  function arm(ms) {
    if (stopPoll) { try { stopPoll(); } catch { /* ignore */ } stopPoll = null; }
    if (disposed) return;
    try { stopPoll = poll(tick, ms); } catch { stopPoll = null; }
  }

  // In sample-data mode there is no server to poll, so the tick only re-renders
  // (that keeps "written 3m ago" honest) and never touches the network.
  function tick() {
    kicked = true;
    if (disposed) return;
    if (mock) {
      if (!loaded) return loadMock(); // first pass still needs the sample data
      render(); // then just re-render, so "written 3m ago" stays honest
      return;
    }
    return loadLive();
  }

  /* ---------------------------------------------------------------- actions */

  function say(text, tone) {
    notice = text;
    noticeTone = tone || "dim";
    render();
    setTimeout(() => {
      if (disposed || notice !== text) return;
      notice = "";
      render();
    }, 6000);
  }

  async function onRefresh() {
    if (busy) return;
    busy = true;
    notice = "";
    render();
    if (mock) {
      const b = mockBriefing();
      b.generatedAt = new Date().toISOString();
      briefing = b;
      busy = false;
      await loadMock();
      say("Sample briefing regenerated (no server involved).", "warn");
      return;
    }
    try {
      const d = await api(REFRESH_PATH, { method: "POST", body: {} });
      // The endpoint answers { briefing, checked, regenerated, posted }. Render the briefing it
      // already returned instead of asking for it again; only fall back to a GET if the
      // response carried none. busy is cleared on BOTH paths, or the buttons stay dead.
      const fresh = d && d.briefing && typeof d.briefing === "object" ? d.briefing : null;
      busy = false;
      staleError = ""; // the router answered, so the "reconnecting" note must go
      error = "";
      if (fresh) {
        briefing = fresh;
        render();
      } else {
        await reload();
      }
      say(d && d.regenerated === false ? "Already up to date." : "Fresh briefing written.", "ok");
    } catch (e) {
      const live = !(e && (e.status === 404 || e.status === 501));
      busy = false;
      await reload();
      say(live ? "Refresh failed: " + msg(e) : "Refresh is not live yet on this server.", live ? "err" : "warn");
    }
  }

  async function onSeen() {
    if (busy) return;
    busy = true;
    notice = "";
    render();
    if (mock) {
      seenAt = new Date().toISOString();
      busy = false;
      await loadMock();
      say("Marked as read (sample data).", "ok");
      return;
    }
    try {
      const d = await api(SEEN_PATH, { method: "POST", body: {} });
      // { seenAt, briefing }: same rule as Refresh, use the briefing that came back.
      const fresh = d && d.briefing && typeof d.briefing === "object" ? d.briefing : null;
      seenAt = (d && (d.seenAt || d.at)) || new Date().toISOString();
      busy = false;
      staleError = ""; // the router answered, so the "reconnecting" note must go
      error = "";
      if (fresh) {
        briefing = fresh;
        render();
      } else {
        await reload();
      }
      say("Marked as read.", "ok");
    } catch (e) {
      const live = !(e && (e.status === 404 || e.status === 501));
      busy = false;
      await reload();
      say(live ? "Could not mark as read: " + msg(e) : "Mark as read is not live yet on this server.",
        live ? "err" : "warn");
    }
  }

  async function resolveNeedsYou(itemId, actionId, input, linkUrl) {
    if (!api) return;
    if (needsBusy.has(itemId)) return;
    needsBusy.add(itemId);
    needsResult = null;
    render();
    if (linkUrl) {
      const win = window.open(linkUrl, "_blank");
      if (win) win.opener = null;
    }
    const body = { actionId: actionId };
    if (input && Object.keys(input).length) body.input = input;
    try {
      const d = await api(NEEDS_YOU_RESOLVE(itemId), { method: "POST", body });
      const ok = !!(d && d.ok);
      needsResult = {
        text: (d && d.message) ? d.message : (ok ? "Done." : "Failed."),
        tone: ok ? "ok" : "err",
      };
      if (ok && d && Array.isArray(d.needsYou)) {
        briefing = { ...briefing, needsYou: d.needsYou };
      } else {
        await reload();
      }
    } catch (e) {
      needsResult = { text: msg(e), tone: "err" };
    } finally {
      needsBusy.delete(itemId);
      render();
      if (needsResult) {
        const saved = needsResult;
        setTimeout(() => {
          if (disposed || needsResult !== saved) return;
          needsResult = null;
          render();
        }, 6000);
      }
    }
  }

  function onClick(e) {
    const node = e.target && e.target.closest ? e.target.closest("[data-act]") : null;
    if (!node) return;
    const act = node.getAttribute("data-act");
    if (act === "refresh") { onRefresh(); return; }
    if (act === "seen") { onSeen(); return; }
    if (act === "mock") { startMock(); return; }
    if (act === "retry") { loaded = false; notLive = false; error = ""; render(); reload(); return; }
    if (act === "live") {
      mock = false;
      loaded = false;
      const base = String(location.hash || "#/briefing").split("?")[0];
      navigate(base); // drop ?mock=1 from the hash
      render();
      reload();
      return;
    }
    if (act === "toggle-run") {
      const id = String(node.getAttribute("data-run") || "");
      if (!id) return;
      if (openRuns.has(id)) openRuns.delete(id); else openRuns.add(id);
      render();
      return;
    }
    if (act === "open" || act === "ask") {
      // A real <a href="#/...">: let the browser change the hash too, so this works
      // whether or not the shell's navigate() does its own thing.
      const href = node.getAttribute("href");
      if (href) navigate(href);
      return;
    }
    if (act === "needs-action" || act === "needs-link") {
      const itemId = node.getAttribute("data-item");
      const actionId = node.getAttribute("data-action");
      if (!itemId || !actionId || needsBusy.has(itemId)) return;
      const linkUrl = act === "needs-link" ? node.getAttribute("href") : "";
      const input = {};
      const inp = itemId ? el.querySelector('input[data-input-id="' + esc(itemId) + '"]') : null;
      if (inp) {
        const name = inp.getAttribute("data-input-name") || "value";
        input[name] = inp.value;
        inp.value = "";
      }
      void resolveNeedsYou(itemId, actionId, input, linkUrl);
      return;
    }
  }

  function onToggle(e) {
    const t = e.target;
    if (!t || !t.dataset || !t.dataset.run) return;
    const id = String(t.dataset.run);
    if (t.open) openRuns.add(id); else openRuns.delete(id);
  }

  function onAskEnter(e) {
    if (e.key !== "Enter") return;
    const a = e.target && e.target.closest ? e.target.closest("[data-act='ask']") : null;
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href");
    if (href) navigate(href);
  }

  el.addEventListener("click", onClick);
  el.addEventListener("toggle", onToggle, true);
  el.addEventListener("keydown", onAskEnter);

  render(); // paint loading immediately, before the first fetch lands

  if (mock || api) {
    // api.js's poll() fires immediately; a poll implementation that does not is
    // kicked on the next microtask, so the first load happens exactly once.
    arm(POLL_MS);
    Promise.resolve().then(() => { if (!kicked && !disposed) tick(); });
  }
  if (!mock && !api) {
    loaded = true;
    error = "api() is unavailable (public/v2/api.js did not load).";
    render();
  }

  return function cleanup() {
    disposed = true;
    seq += 1;
    if (stopPoll) { try { stopPoll(); } catch { /* ignore */ } stopPoll = null; }
    el.removeEventListener("click", onClick);
    el.removeEventListener("toggle", onToggle, true);
    el.removeEventListener("keydown", onAskEnter);
    el.innerHTML = "";
  };
}
