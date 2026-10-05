// TERMINALS view: every running jcode terminal, what it is doing, and a way to talk to it.
//
// Route:  #/terminals        (also #/terminals/:sessionId to open one directly)
//         #/terminals?mock=1 sample data, for looking at the layout without the routes
//
// Contract (docs/UI_V2_SPEC.md): mount(el, ctx) -> cleanup(); ctx = { api, poll, esc, ago, hm,
// navigate, params }. Spec: docs/TERMINALS_SPEC.md (sections "UI").
// Data (read-only):
//   GET  /company/terminals/live                    -> { terminals:[{sessionId,name,role,description,
//        state:"working"|"idle"|"closed",model,lastActivity,startedAt,workOrderExcerpt,
//        runCard?:{headline,done,remaining,doneCount,remainingCount,verdict},keepOpen,streaming}] }
//   GET  /company/terminals/:sessionId/tail?lines=N -> { lines:[{ts,who:"ceo"|"manager"|"agent"|"tool",text}] }
//   POST /company/terminals/:sessionId/message {text} -> { ok, how:"targeted", detail }
//   GET  /company/workers                           -> { live:[{name,pid,status:"running"|"finished"|
//        "killed"|"stopped",provider,model,startedAt,elapsedSec,maxMinutes,maxUsd,turns,estUsd,
//        endedBy}], recent:[...] } — the headless guarded workers (ops/spawn-worker.ps1)
//   GET  /company/workers/:name/tail?lines=N         -> { name, lines:[string] }
// The message goes in with `jcode transcript --mode send -S <sessionId>` (targeted; it can
// only land in that one terminal). A closed terminal refuses it.
//
// Theme: only style.css tokens/classes plus a small block of .term-* CSS defined here
// (grid, side panel, tail) that reads theme variables only.

export const title = "Terminals";

const LIST_MS = 5000; // terminal list refresh
const TAIL_MS = 3000; // live tail refresh while the panel is open
const TAIL_LINES = 80; // lines requested per tail refresh
const WTAIL_MS = 3000; // guarded-worker tail refresh while a card is open
const WTAIL_LINES = 40; // lines requested per guarded-worker tail refresh
const STATE_ORDER = { working: 0, idle: 1, closed: 2 };

const STYLE_ID = "terminals-view-style";

/* ------------------------------------------------------------------ helpers */

function escHtml(s) {
  return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
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

function fallbackHm(iso) {
  try {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch { return ""; }
}

/** "03:12" from seconds: the elapsed clock on a guarded-worker card. */
function mmss(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
}

/** "$0.0706" — the guard's estimate, kept at 4 decimals because it is small. */
function usd4(n) {
  const v = Number(n);
  return Number.isFinite(v) ? "$" + v.toFixed(4) : "";
}

function workerPill(w) {
  if (w.status === "running") return '<span class="pill pill-ok">running</span>';
  if (w.status === "killed") return '<span class="pill pill-warn">killed</span>';
  if (w.status === "stopped") return '<span class="pill pill-warn">stopped</span>';
  return '<span class="pill">finished</span>';
}

/** "killed:repeat-line x6" -> plain words; the reason carries the warning colour. */
function endedByWords(w) {
  const e = String(w.endedBy || "finished");
  if (e.indexOf("killed") === 0) {
    const why = e.replace(/^killed:?\s*/, "").replace(/-/g, " ").replace(/\bx\d+$/, (m) => "(" + m.slice(1) + " times)");
    return { text: why ? "killed: " + why : "killed", warn: true };
  }
  if (e === "stopped") return { text: "stopped", warn: true };
  return { text: "finished on its own", warn: false };
}

function fallbackPoll(fn, ms) {
  const h = setInterval(() => { if (!document.hidden) fn(); }, ms);
  return () => clearInterval(h);
}

function msg(e) {
  if (!e) return "unknown error";
  if (e.status) return "HTTP " + e.status + (e.message ? " — " + e.message : "");
  return e.message || String(e);
}

function stateLabel(state) {
  return state === "working" ? "working right now" : state === "idle" ? "idle (waiting)" : "closed";
}

function stateDot(state) {
  if (state === "working") return "dot dot-ok term-pulse";
  if (state === "idle") return "dot";
  return "dot dot-dim";
}

function verdictPill(verdict) {
  if (!verdict) return "";
  const cls = verdict === "PASS" ? "pill pill-ok" : verdict === "REDO" ? "pill pill-warn" : "pill pill-err";
  return '<span class="' + cls + '">' + escHtml(verdict) + "</span>";
}

/* -------------------------------------------------------- sample (?mock=1) */

const MOCK_LIST = {
  generatedAt: new Date().toISOString(),
  counts: { total: 3, working: 1, idle: 1, closed: 1 },
  mock: true,
  terminals: [
    {
      sessionId: "session_tigress_1790685218034_d200d20acadb2559",
      name: "tigress",
      role: "OPS (router uptime)",
      state: "working",
      streaming: true,
      model: "deepseek-v4.1-flash",
      lastActivity: new Date(Date.now() - 12_000).toISOString(),
      description: "Watching the router, checking why tasks keep failing and reporting to the manager.",
      workOrderExcerpt: "OPS: keep the router up on :8787, find the root cause of the restarts, resume tmummq62z.",
      runCard: { headline: "OPS is working on the router uptime", done: ["router restarts root-caused"], remaining: ["watch tmummq62z"], doneCount: 1, remainingCount: 1, verdict: undefined, state: "working" },
      idleSeconds: 12,
    },
    {
      sessionId: "session_maple_1790686910793_b9bba4247c47ac99",
      name: "maple",
      role: "TERMINALS",
      state: "idle",
      streaming: false,
      model: "deepseek-v4.1-flash",
      lastActivity: new Date(Date.now() - 320_000).toISOString(),
      description: "Built the Terminals page: the live list, the tail and the message box.",
      workOrderExcerpt: "You are TERMINALS. Read docs/TERMINALS_SPEC.md fully and build it.",
      runCard: { headline: "Terminals page built", done: ["backend routes", "the view"], remaining: [], doneCount: 2, remainingCount: 0, verdict: "PASS", state: "done" },
      idleSeconds: 320,
    },
    {
      sessionId: "session_rose_1790676464482_e8d725d4b3e59692",
      name: "rose",
      role: "CEO's own jcode window",
      state: "closed",
      streaming: false,
      model: "deepseek-v4.1-flash",
      lastActivity: new Date(Date.now() - 800_000).toISOString(),
      description: "The CEO's own terminal: collecting the inputs the company still needs.",
      workOrderExcerpt: "You are the COLLECTOR. The CEO talks to you directly in this window.",
      idleSeconds: 800,
    },
  ],
};

const MOCK_TAIL = {
  lines: [
    { ts: new Date(Date.now() - 240_000).toISOString(), who: "manager", text: "You are OPS. Keep the router up and find the root cause of the restarts." },
    { ts: new Date(Date.now() - 220_000).toISOString(), who: "tool", text: "→ bash · Get-Content logs/router.crash.log -Tail 40" },
    { ts: new Date(Date.now() - 200_000).toISOString(), who: "agent", text: "Four boots in one log. Each boot starts its own Slack bridge, so two bridges can answer the CEO twice." },
    { ts: new Date(Date.now() - 120_000).toISOString(), who: "tool", text: "→ grep · restart" },
    { ts: new Date(Date.now() - 60_000).toISOString(), who: "ceo", text: "[From the CEO via the dashboard] why does it keep restarting?" },
    { ts: new Date(Date.now() - 30_000).toISOString(), who: "agent", text: "Reading the crash log now: the exits are all SIGTERM from the supervisor, not crashes." },
  ],
};

const MOCK_WORKERS = {
  live: [
    {
      name: "workers-live",
      pid: 29472,
      status: "running",
      provider: "deepseek",
      model: "deepseek-flash",
      startedAt: new Date(Date.now() - 62_000).toISOString(),
      elapsedSec: 62,
      maxMinutes: 30,
      maxUsd: 0.5,
    },
  ],
  recent: [
    { name: "budget-all", pid: 30440, status: "finished", provider: "deepseek", model: "deepseek-flash", startedAt: "", elapsedSec: 0, maxMinutes: 20, maxUsd: 0.4, turns: 19, estUsd: 0.0706, endedBy: "finished" },
    { name: "gh-5", pid: 0, status: "killed", provider: "opencode-go", model: "deepseek-v4-flash", startedAt: "", elapsedSec: 0, maxMinutes: 15, maxUsd: 0.3, turns: 22, estUsd: 0.0662, endedBy: "killed:repeat-line x6" },
  ],
};

const MOCK_WORKER_TAILS = {
  "workers-live": {
    name: "workers-live",
    lines: [
      "I'll start by reading the work order.",
      "[read] docs\\ORDER_2026-10-06_workers-live.md",
      "Let me look at the registry and the ledger the guard writes.",
      "[bash] Get-Content logs\\workers.json -Tail 3",
    ],
  },
};

/* ------------------------------------------------- view CSS (namespaced) */

function ensureStyles() {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  /* UI-CLEAN: this view's CSS lives in public/v2/style.css (one visual system for the
   * whole dashboard). The one block left here is the guarded-worker tail box: a
   * scrollable, wrapping, monospace box that reads theme variables only. */
  const st = document.createElement("style");
  st.id = STYLE_ID;
  st.textContent =
    ".gw-section{margin-bottom:14px}" +
    ".gw-title{font-size:var(--fs-lg);font-weight:600;margin-bottom:6px}" +
    ".gw-tail{max-height:220px;overflow:auto;padding:6px 8px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--bg)}" +
    ".gw-tail .gw-line{white-space:pre-wrap;word-break:break-word}" +
    ".gw-warn{color:var(--warn)}" +
    ".gw-row{display:flex;flex-wrap:wrap;gap:var(--sp-2);align-items:center;padding:3px 0}" +
    ".gw-recent{margin-top:10px}";
  document.head.appendChild(st);
}

/* ---------------------------------------------------------------------- mount */

export function mount(el, ctx) {
  const c = ctx || {};
  const esc = typeof c.esc === "function" ? c.esc : escHtml;
  const ago = typeof c.ago === "function" ? c.ago : fallbackAgo;
  const hm = typeof c.hm === "function" ? c.hm : fallbackHm;
  const api = typeof c.api === "function" ? c.api : null;
  const poll = typeof c.poll === "function" ? c.poll : fallbackPoll;
  const params = c.params || {};

  ensureStyles();

  const mock = String(params.mock || "") === "1"
    || (typeof location !== "undefined" && /[?&]mock=1\b/.test(String(location.search || "") + String(location.hash || "")));

  let terminals = [];
  let loaded = false;
  let error = "";
  let filter = "all"; // WORKERS-LIVE: the page opens on "all", so idle and closed
  // terminals are never hidden behind a filter the reader did not choose.
  let query = "";
  let openId = String(params.sessionId || params.id || "");
  let tail = null;
  let tailError = "";
  let tailBusy = false;
  let sending = false;
  let receipt = null; // { ok, detail }
  let draft = "";
  let woOpen = false; // is the "work order" disclosure open?
  let stopList = null;
  let stopTail = null;
  let stopWTail = null; // the 3s guarded-worker tail timer
  let disposed = false;
  let seq = 0;

  // Guarded workers (headless: started by ops/spawn-worker.ps1 without a window).
  // They arrive with the terminal list; their tails run on their own 3s timer, and
  // only while at least one card is expanded. Running workers start expanded.
  let workers = { live: [], recent: [] };
  let workersError = "";
  const wtails = {}; // name -> { lines, error }
  const wopen = {}; // name -> is that card expanded?

  function currentOpenId() {
    const h = typeof location !== "undefined" ? String(location.hash || "") : "";
    const m = h.match(/^#\/terminals\/([^/?#]+)/);
    if (m) return decodeURIComponent(m[1]);
    return openId;
  }

  function visible() {
    const q = query.trim().toLowerCase();
    return terminals
      .filter((t) => filter === "all" || t.state === filter)
      .filter((t) => !q || String(t.name || "").toLowerCase().includes(q) || String(t.role || "").toLowerCase().includes(q))
      .sort((a, b) => (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9));
  }

  function openTerminal() {
    return terminals.filter((t) => t.sessionId === currentOpenId())[0] || null;
  }

  /* ------------------------------------------------------------ rendering */

  function cardHtml(t) {
    const card = t.runCard;
    const counts = card
      ? '<span class="term-meta">✅ ' + esc(String(card.doneCount ?? (card.done || []).length)) +
        " · ⏳ " + esc(String(card.remainingCount ?? (card.remaining || []).length)) + "</span>" +
        (card.verdict ? " " + verdictPill(card.verdict) : "")
      : "";
    return (
      '<div class="term-card' + (t.sessionId === currentOpenId() ? " is-open" : "") +
      (t.state === "closed" ? " is-closed" : "") + '" data-act="open" data-sid="' + esc(t.sessionId) + '" tabindex="0" role="button">' +
      '<div class="term-head">' +
      '<span class="' + stateDot(t.state) + '" title="' + esc(stateLabel(t.state)) + '"></span>' +
      '<span class="term-name">' + esc(t.name || t.sessionId) + "</span>" +
      '<span class="grow"></span>' +
      '<span class="tiny muted">' + esc(ago(t.lastActivity)) + "</span>" +
      "</div>" +
      '<div class="term-role">' + esc(t.role || "unassigned role") + "</div>" +
      '<div class="term-desc">' + esc(t.description || "no description yet") + "</div>" +
      '<div class="term-meta">' +
      '<span class="tiny">' + esc(t.model || "?") + "</span>" +
      '<span class="tiny">' + esc(stateLabel(t.state)) + "</span>" +
      (t.keepOpen ? '<span class="tiny">keep open</span>' : "") +
      counts +
      "</div>" +
      "</div>"
    );
  }

  /* ------------------------------------------- guarded workers (headless) */

  function workerTailHtml(name) {
    const t = wtails[name];
    if (!t) return '<div class="muted small">loading the tail…</div>';
    if (t.error) return '<div class="muted small">' + esc(t.error) + "</div>";
    const lines = Array.isArray(t.lines) ? t.lines : [];
    if (!lines.length) return '<div class="muted small">nothing readable in this log yet.</div>';
    return lines.map((l) => '<div class="gw-line">' + esc(l) + "</div>").join("");
  }

  function guardCardHtml(w) {
    const open = !!wopen[w.name];
    const meta = [];
    if (w.provider) meta.push('<span class="tiny">' + esc(w.provider) + "</span>");
    if (w.model) meta.push('<span class="tiny">' + esc(w.model) + "</span>");
    if (typeof w.estUsd === "number") meta.push('<span class="tiny">~' + esc(usd4(w.estUsd)) + " spent</span>");
    meta.push('<span class="tiny">pid ' + esc(String(w.pid)) + "</span>");
    return (
      '<div class="term-card' + (open ? " is-open" : "") + '">' +
      '<div class="term-head" data-act="wtoggle" data-wname="' + esc(w.name) + '" tabindex="0" role="button">' +
      '<span class="dot dot-ok term-pulse"></span>' +
      '<span class="term-name">' + esc(w.name) + "</span>" +
      workerPill(w) +
      '<span class="grow"></span>' +
      '<span class="tiny">' + esc(mmss(w.elapsedSec)) + "</span>" +
      "</div>" +
      '<div class="term-meta">' + meta.join("") + "</div>" +
      (open ? '<div class="gw-tail term-tail" data-wtail="' + esc(w.name) + '">' + workerTailHtml(w.name) + "</div>" : "") +
      "</div>"
    );
  }

  function recentRowHtml(w) {
    const end = endedByWords(w);
    const bits = [];
    bits.push('<span class="tiny">' + esc(w.status) + "</span>");
    if (typeof w.turns === "number") bits.push('<span class="tiny">' + esc(String(w.turns)) + " turns</span>");
    if (typeof w.estUsd === "number") bits.push('<span class="tiny">~' + esc(usd4(w.estUsd)) + "</span>");
    bits.push('<span class="tiny' + (end.warn ? " gw-warn" : " muted") + '">' + esc(end.text) + "</span>");
    return '<div class="gw-row"><span class="term-name">' + esc(w.name) + "</span>" + bits.join("") + "</div>";
  }

  function guardSectionHtml() {
    const live = Array.isArray(workers.live) ? workers.live : [];
    const recent = Array.isArray(workers.recent) ? workers.recent : [];
    return (
      '<div class="gw-section">' +
      '<div class="gw-title">Guarded workers (headless, no window)</div>' +
      (workersError ? errorCard(workersError) : "") +
      '<div class="small muted">These are started by ops/spawn-worker.ps1 and run without a ' +
      "window, so they never appear in the jcode list. A live tail refreshes every 3 seconds " +
      "while a card is open.</div>" +
      (live.length
        ? '<div class="term-grid">' + live.map(guardCardHtml).join("") + "</div>"
        : emptyCard("No guarded workers running right now.")) +
      (recent.length
        ? '<details class="gw-recent"><summary class="small muted">Recently finished (' + esc(String(recent.length)) + ")</summary>" +
          recent.map(recentRowHtml).join("") + "</details>"
        : "") +
      "</div>"
    );
  }

  function listHtml() {
    if (!loaded) {
      return '<div class="col term"><div class="card state"><div class="spinner"></div><div>Loading terminals…</div></div></div>';
    }
    const rows = visible();
    const counts = terminals.reduce((acc, t) => { acc[t.state] = (acc[t.state] || 0) + 1; return acc; }, {});
    const filterBtn = (key, label) =>
      '<button class="btn btn-sm' + (filter === key ? " btn-primary" : "") + '" data-act="filter" data-f="' + key + '"' +
      ">" + esc(label) + "</button>";
    return (
      '<div class="col term">' +
      guardSectionHtml() +
      '<div class="row">' +
      '<div class="grow">' +
      '<div class="small muted">' +
      esc(String(terminals.length)) + " jcode terminals today · " +
      // "of them" ties this number to the terminals above, so it cannot be read
      // as the company-wide "working now" in the top bar (which counts agents).
      esc(String(counts.working || 0)) + " of them working right now · " +
      esc(String(counts.idle || 0)) + " idle · " +
      esc(String(counts.closed || 0)) + " closed · " +
      esc(String((workers.live || []).length)) + " guarded workers running" +
      (mock ? ' · <b>sample data</b> (?mock=1)' : "") +
      "</div>" +
      "</div>" +
      '<input class="in in-sm term-search" data-act="search" placeholder="search name or role…" value="' + esc(query) + '" />' +
      "</div>" +
      '<div class="term-bar">' +
      filterBtn("all", "all") + filterBtn("working", "working") + filterBtn("idle", "idle") + filterBtn("closed", "closed") +
      '<span class="grow"></span>' +
      '<button class="btn btn-sm" data-act="retry">Refresh</button>' +
      "</div>" +
      (error ? errorCard() : "") +
      (rows.length
        ? '<div class="term-grid">' + rows.map(cardHtml).join("") + "</div>"
        : emptyCard(filter === "all" && !query
          ? "No jcode terminals have been active in the last two hours."
          : "No terminal matches this filter.")) +
      '<div class="tiny muted">A dashboard message goes to exactly one terminal via ' +
      "<span class=\"mono\">jcode transcript --mode send -S &lt;sessionId&gt;</span>. Closed terminals cannot receive one.</div>" +
      "</div>"
    );
  }

  function tailHtml() {
    const t = openTerminal();
    const id = currentOpenId();
    if (!id) return "";
    const header =
      '<div class="term-panel-head">' +
      '<span class="' + (t ? stateDot(t.state) : "dot") + '"></span>' +
      '<div class="grow" style="min-width:0">' +
      '<div class="term-name">' + esc(t ? (t.name || id) : id) + "</div>" +
      '<div class="term-role">' + esc(t ? (t.role || "unassigned role") : "not in today's list") + "</div>" +
      '<div class="tiny muted">' + esc(t ? stateLabel(t.state) + " · " + (t.model || "?") + " · active " + ago(t.lastActivity) : "") + "</div>" +
      "</div>" +
      '<button class="btn btn-sm" data-act="close">Close</button>' +
      "</div>";

    const workOrder = t && t.workOrderExcerpt
      ? '<details class="term-workorder" data-act="wo"' + (woOpen ? " open" : "") +
        '><summary>work order</summary><div class="small mt-1">' +
        esc(t.workOrderExcerpt) + "</div></details>"
      : "";

    const card = t && t.runCard;
    const cardHtml2 = card
      ? '<div class="term-workorder"><div class="small">' +
        (card.done || []).map((d) => '<div>✅ ' + esc(d) + "</div>").join("") +
        (card.remaining || []).map((r) => '<div>⏳ ' + esc(r) + "</div>").join("") +
        (card.verdict ? "<div>" + verdictPill(card.verdict) + "</div>" : "") +
        "</div></div>"
      : "";

    const lines = tail && Array.isArray(tail.lines) ? tail.lines : [];
    const body =
      '<div class="term-panel-body">' +
      (tailError ? errorCard(tailError) : "") +
      workOrder + cardHtml2 +
      '<div class="term-tail" data-tail="1">' + tailLinesHtml(lines) + "</div>" +
      "</div>";

    const open = t && t.state !== "closed";
    const chat =
      '<div class="term-chat">' +
      (t && t.streaming
        ? '<div class="term-warn">It\'s busy — your message will be read when it finishes its current step.</div>'
        : "") +
      (!open
        ? '<div class="muted small">This terminal is closed, so it cannot receive a message. Bring it back with <span class="mono">jcode --resume ' + esc(id) + "</span>.</div>"
        : '<div class="row">' +
          '<input class="in in-sm grow" data-act="draft" placeholder="Message ' + esc(t ? t.name : "terminal") + '…"' +
          ' value="' + esc(draft) + '"' + (sending ? " disabled" : "") + " />" +
          '<button class="btn btn-primary btn-sm" data-act="send"' + (sending ? " disabled" : "") + ">" +
          esc(sending ? "sending…" : "Send") + "</button>" +
          "</div>") +
      (receipt
        ? '<div class="term-receipt ' + (receipt.ok ? "ok" : "err") + '">' +
          esc((receipt.ok ? "delivered ✓ " : "failed ✗ ") + (receipt.detail || "")) + "</div>"
        : "") +
      '<div class="tiny muted">Enter sends. It carries the prefix “' +
      esc("[From the CEO via the dashboard]") + "” so the terminal knows who is talking.</div>" +
      "</div>";

    return '<div class="term-panel" data-panel="1" role="dialog" aria-label="terminal ' + esc(id) + '">' + header + body + chat + "</div>";
  }

  function errorCard(extra) {
    const text = extra || error;
    if (!text) return "";
    return '<div class="card state state-error"><div class="state-title">Could not reach the terminals</div>' +
      '<div class="wrap-any">' + esc(text) + "</div>" +
      '<button class="btn btn-sm" data-act="retry">Retry</button></div>';
  }

  function emptyCard(text) {
    return '<div class="card state state-empty"><div>' + esc(text) + "</div></div>";
  }

  function tailLinesHtml(lines) {
    if (!lines.length) {
      return '<div class="muted small">' + esc(tailBusy ? "loading the tail…" : "nothing readable in this journal yet.") + "</div>";
    }
    return lines.map((l) =>
      '<div class="term-line term-l-' + esc(l.who || "agent") + '">' +
      '<span class="t-ts tiny">' + esc(hm(l.ts)) + "</span>" +
      '<span class="t-who">' + esc(l.who || "") + "</span>" +
      '<span class="t-txt">' + esc(l.text) + "</span>" +
      "</div>").join("");
  }

  /**
   * Swaps in ONLY the tail lines, so the chat box keeps its text and its focus while the
   * 3s tail poll runs (a full re-render would steal the caret out of the message box).
   * Scroll stays put unless the reader was already at the bottom.
   */
  function paintTail() {
    const box = el.querySelector(".term-panel-body");
    const host = el.querySelector('[data-tail="1"]');
    if (!box || !host) return;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    host.innerHTML = tailLinesHtml(tail && Array.isArray(tail.lines) ? tail.lines : []);
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  /** Full repaint. Focus, the draft and the scroll position survive it (the 5s list poll). */
  function render() {
    const active = typeof document !== "undefined" ? document.activeElement : null;
    const act = active && el.contains(active) && active.getAttribute ? active.getAttribute("data-act") : "";
    let caret = 0;
    if (act) {
      try { caret = active.selectionStart || 0; } catch { caret = 0; }
    }
    const box = el.querySelector(".term-panel-body");
    const wasAtBottom = box ? (box.scrollHeight - box.scrollTop - box.clientHeight < 60) : true;
    const keepScroll = box ? box.scrollTop : 0;

    const id = currentOpenId();
    el.innerHTML = listHtml() + (id ? tailHtml() : "");

    const nextBox = el.querySelector(".term-panel-body");
    if (nextBox) nextBox.scrollTop = wasAtBottom ? nextBox.scrollHeight : keepScroll;
    if (act) {
      const next = el.querySelector('[data-act="' + act + '"]');
      if (next) {
        try { next.focus(); next.setSelectionRange(caret, caret); } catch { /* not a text field */ }
      }
    }
    // Keep the 3s guarded-worker tail timer in step with what is expanded.
    armWorkerTails();
  }

  /* --------------------------------------------------------------- data */

  function msgOf(e) { return msg(e); }

  async function loadList() {
    if (disposed) return;
    const mine = ++seq;
    // The terminal list and the guarded-worker list are independent: one failing
    // must not blank the other, so both are settled and handled separately.
    const settled = (p) => p.then((d) => ({ ok: true, d }), (e) => ({ ok: false, e }));
    const [termRes, workRes] = await Promise.all([
      settled(mock ? Promise.resolve(MOCK_LIST) : api("/company/terminals/live")),
      settled(mock ? Promise.resolve(MOCK_WORKERS) : api("/company/workers")),
    ]);
    if (disposed || mine !== seq) return;
    if (termRes.ok) {
      terminals = Array.isArray(termRes.d && termRes.d.terminals) ? termRes.d.terminals : [];
      error = "";
    } else {
      error = msgOf(termRes.e);
    }
    if (workRes.ok) {
      const d = workRes.d || {};
      workers = {
        live: Array.isArray(d.live) ? d.live : [],
        recent: Array.isArray(d.recent) ? d.recent : [],
      };
      workersError = "";
      // A running worker starts expanded (the CEO wants to watch it, not click first).
      for (const w of workers.live) if (wopen[w.name] === undefined) wopen[w.name] = true;
    } else {
      workersError = msgOf(workRes.e);
    }
    loaded = true;
    render();
  }

  /** Fetch the tail of every expanded live worker, then repaint just those boxes. */
  async function loadWorkerTails() {
    if (disposed) return;
    const names = (workers.live || []).filter((w) => wopen[w.name]).map((w) => w.name);
    if (!names.length) return;
    await Promise.all(names.map(async (n) => {
      try {
        const d = mock
          ? (MOCK_WORKER_TAILS[n] || { lines: [] })
          : await api("/company/workers/" + encodeURIComponent(n) + "/tail?lines=" + WTAIL_LINES);
        if (disposed) return;
        wtails[n] = { lines: Array.isArray(d && d.lines) ? d.lines : [], error: "" };
      } catch (e) {
        if (!disposed) wtails[n] = { lines: [], error: msgOf(e) };
      }
    }));
    if (!disposed) paintWorkerTails();
  }

  /** The 3s timer runs only while the page is open AND a live card is expanded. */
  function armWorkerTails() {
    if (stopWTail) {
      try { stopWTail(); } catch { /* ignore */ }
      stopWTail = null;
    }
    if (disposed) return;
    const any = (workers.live || []).some((w) => wopen[w.name]);
    if (!any) return;
    try { stopWTail = poll(loadWorkerTails, WTAIL_MS); } catch { stopWTail = null; }
    if (stopWTail) loadWorkerTails();
  }

  /** Swap only the tail boxes, so the rest of the page (and any focus) stays put. */
  function paintWorkerTails() {
    for (const w of workers.live || []) {
      if (!wopen[w.name]) continue;
      const box = el.querySelector('[data-wtail="' + w.name + '"]');
      if (!box) continue;
      const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
      box.innerHTML = workerTailHtml(w.name);
      if (atBottom) box.scrollTop = box.scrollHeight;
    }
  }

  async function loadTail() {
    const id = currentOpenId();
    if (disposed || !id) return;
    tailBusy = true;
    try {
      const data = mock ? MOCK_TAIL : await api("/company/terminals/" + encodeURIComponent(id) + "/tail?lines=" + TAIL_LINES);
      if (disposed || currentOpenId() !== id) return;
      tail = data && Array.isArray(data.lines) ? data : { lines: [] };
      tailError = "";
    } catch (e) {
      if (disposed || currentOpenId() !== id) return;
      tailError = msgOf(e);
    } finally {
      tailBusy = false;
    }
    if (currentOpenId() !== id) return;
    paintTail();
  }

  function armTail(on) {
    if (stopTail) {
      try { stopTail(); } catch { /* ignore */ }
      stopTail = null;
    }
    if (!on || disposed) return;
    try { stopTail = poll(loadTail, TAIL_MS); } catch { stopTail = null; }
    if (stopTail) loadTail();
  }

  async function open(id) {
    openId = id;
    tail = null;
    tailError = "";
    receipt = null;
    draft = "";
    render();
    armTail(true);
    // Keep the URL in step with the open panel (the shell's router owns the hash).
    const want = "#/terminals/" + id;
    if (typeof location !== "undefined" && location.hash !== want && !String(location.hash).startsWith(want)) {
      try { history.replaceState(null, "", want); } catch { /* older browsers */ }
    }
  }

  function close() {
    openId = "";
    tail = null;
    receipt = null;
    armTail(false);
    if (typeof location !== "undefined" && String(location.hash).startsWith("#/terminals/")) {
      try { history.replaceState(null, "", "#/terminals"); } catch { /* ignore */ }
    }
    render();
  }

  async function send() {
    const id = currentOpenId();
    const text = draft.trim();
    if (!id || !text || sending) return;
    sending = true;
    receipt = null;
    render();
    try {
      const out = mock
        ? { ok: true, detail: "sample mode: nothing was really sent." }
        : await api("/company/terminals/" + encodeURIComponent(id) + "/message", { method: "POST", body: { text } });
      if (disposed) return;
      receipt = { ok: !!out.ok, detail: out.detail || (out.ok ? "sent" : "not sent") };
      if (out.ok) {
        draft = "";
        setTimeout(() => { if (!disposed && currentOpenId() === id) loadTail(); }, 900);
      }
    } catch (e) {
      if (!disposed) receipt = { ok: false, detail: msgOf(e) };
    } finally {
      sending = false;
      if (!disposed) render();
    }
  }

  /* ------------------------------------------------------------- wiring */

  function onClick(e) {
    const node = e.target && e.target.closest ? e.target.closest("[data-act]") : null;
    if (!node) return;
    const act = node.getAttribute("data-act");
    if (act === "open") {
      const sid = node.getAttribute("data-sid");
      if (sid && sid !== currentOpenId()) open(sid);
      else if (sid) { openId = sid; render(); }
      return;
    }
    if (act === "close") { close(); return; }
    if (act === "filter") {
      filter = node.getAttribute("data-f") || "all";
      render();
      return;
    }
    if (act === "wtoggle") {
      const n = node.getAttribute("data-wname");
      if (n) { wopen[n] = !wopen[n]; render(); }
      return;
    }
    if (act === "retry") { loadList(); if (currentOpenId()) loadTail(); return; }
    if (act === "send") { send(); return; }
    if (act === "wo") {
      // The disclosure is rebuilt by every render, so its state lives here. Only a click on
      // the summary toggles it, and the browser flips `open` after this handler runs.
      const summary = e.target && e.target.closest ? e.target.closest("summary") : null;
      if (summary) woOpen = !node.hasAttribute("open");
      return;
    }
  }

  function onInput(e) {
    const t = e.target;
    if (!t || !t.getAttribute) return;
    const act = t.getAttribute("data-act");
    if (act === "search") {
      query = t.value;
      render();
      return;
    }
    if (act === "draft") draft = t.value;
  }

  function onKeydown(e) {
    const t = e.target;
    if (e.key === "Enter" && t && t.getAttribute && t.getAttribute("data-act") === "wtoggle") {
      e.preventDefault();
      const n = t.getAttribute("data-wname");
      if (n) { wopen[n] = !wopen[n]; render(); }
      return;
    }
    if (e.key === "Enter" && t && t.getAttribute && t.getAttribute("data-act") === "draft") {
      e.preventDefault();
      draft = t.value;
      send();
      return;
    }
    if (e.key === "Escape" && currentOpenId()) close();
  }

  function onHash() {
    if (disposed) return;
    const id = currentOpenId();
    if (id && id !== openId) {
      open(id);
      return;
    }
    if (!id && openId) { close(); return; }
    render();
  }

  el.addEventListener("click", onClick);
  el.addEventListener("input", onInput);
  el.addEventListener("keydown", onKeydown);
  if (typeof window !== "undefined") window.addEventListener("hashchange", onHash);

  render();

  if (!api && !mock) {
    error = "api() is unavailable (public/v2/api.js did not load).";
    loaded = true;
    render();
  }

  if (mock) {
    loaded = true;
    terminals = MOCK_LIST.terminals;
    tail = currentOpenId() ? MOCK_TAIL : tail;
    render();
  } else if (api) {
    try { stopList = poll(loadList, LIST_MS); } catch { stopList = null; }
    loadList();
    if (currentOpenId()) armTail(true);
  }

  return function cleanup() {
    disposed = true;
    if (stopList) { try { stopList(); } catch { /* ignore */ } stopList = null; }
    if (stopTail) { try { stopTail(); } catch { /* ignore */ } stopTail = null; }
    if (stopWTail) { try { stopWTail(); } catch { /* ignore */ } stopWTail = null; }
    el.removeEventListener("click", onClick);
    el.removeEventListener("input", onInput);
    el.removeEventListener("keydown", onKeydown);
    if (typeof window !== "undefined") window.removeEventListener("hashchange", onHash);
    el.innerHTML = "";
  };
}
