// public/v2/views/ops.js — Ops page parts 1+2 (orders D2A-ops-view-a, D2B-ops-view-b).
// Plain page for a non-developer CEO: health, money, queue (part 1) plus
// workers, tasks, alerts (part 2, added: exported pure renderWorkers,
// renderTasks, renderAlerts after renderQueue, plus click wiring in mount).
// View contract (docs/UI_V2_SPEC.md, public/v2/views/flow.js):
//   export const title; export function mount(el, ctx) -> cleanup.
//   ctx = { api, poll, esc, ago, hm, navigate, params }.
// Data: GET /company/ops/status (shape in src/company/opsView.ts; do not edit).
// Controls: POST /company/ops/queue/pause, POST /company/ops/queue/resume.

export const title = "Ops";

const STATUS_PATH = "/company/ops/status";
const PAUSE_PATH = "/company/ops/queue/pause";
const RESUME_PATH = "/company/ops/queue/resume";
const REFRESH_MS = 3000;
const STYLE_ID = "ops-view-style";
const FAILURE_TEXT = "The router is not answering";
const PERCENT_MAX = 100;

// Part 2 named constants (no magic numbers).
const NEW_MAX_MIN = 10;
const ALERT_AGE_UNKNOWN_MIN = 1000000000;
const TASK_FILTER_ALL = "all";
const TASK_FILTER_NEW = "new";
const TASK_FILTER_OLD = "old";
// Raw task status -> plain CEO words. coding/testing are active work
// ("building"); pending_code plus the manager-review stages (opposing,
// summarizing, adjudicating, pending_merge) mean the work is waiting on a
// reviewer ("being reviewed"); done/merged mean it is over ("finished");
// failed means it stopped ("gave up"). Anything else is shown as-is.
const TASK_STATUS_WORDS = {
  coding: "building",
  testing: "building",
  pending_code: "being reviewed",
  opposing: "being reviewed",
  summarizing: "being reviewed",
  adjudicating: "being reviewed",
  pending_merge: "being reviewed",
  done: "finished",
  merged: "finished",
  failed: "gave up",
};
const TAIL_NOT_CAPTURED = "This worker's output is not captured.";

function workerKillPath(pid) {
  return "/company/ops/worker/" + encodeURIComponent(String(pid)) + "/kill";
}

function workerTailPath(pid) {
  return "/company/ops/worker/" + encodeURIComponent(String(pid)) + "/tail";
}

function taskRetryPath(projectId, taskId) {
  return "/company/ops/task/" + encodeURIComponent(String(projectId)) + "/" + encodeURIComponent(String(taskId)) + "/retry";
}

function taskDropPath(projectId, taskId) {
  return "/company/ops/task/" + encodeURIComponent(String(projectId)) + "/" + encodeURIComponent(String(taskId)) + "/drop";
}

function taskAgeNew(task) {
  const a = task && typeof task.ageMin === "number" && Number.isFinite(task.ageMin) ? task.ageMin : null;
  return a !== null && a <= NEW_MAX_MIN;
}

function taskStatusWord(raw) {
  const key = String(raw === undefined || raw === null ? "" : raw);
  if (Object.prototype.hasOwnProperty.call(TASK_STATUS_WORDS, key)) return TASK_STATUS_WORDS[key];
  return key === "" ? "unknown" : key;
}

// Escape choice (reported): pure render functions take an `esc` param that
// defaults to this local escapeHtml. mount() passes ctx.esc. Node imports the
// module without touching the DOM.
export function escapeHtml(s) {
  return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function numOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function ageText(ageMin) {
  const n = typeof ageMin === "number" && Number.isFinite(ageMin) ? Math.max(0, Math.floor(ageMin)) : 0;
  return "since " + n + " min";
}

// Infra keys in src/company/opsView.ts -> plain CEO labels.
const HEALTH_DEFS = [
  { key: "router", label: "Router" },
  { key: "laya", label: "Laya" },
  { key: "orderQueue", label: "Queue" },
  { key: "watchdog", label: "Watchdog" },
  { key: "keepAwake", label: "Keep-awake" },
];

function infraOf(status) {
  if (status && typeof status === "object" && status.infra && typeof status.infra === "object") {
    return status.infra;
  }
  return {};
}

// (1) Red banner at the very top when any health item is red.
export function renderBanner(status, esc = escapeHtml) {
  const e = typeof esc === "function" ? esc : escapeHtml;
  const infra = infraOf(status);
  const down = HEALTH_DEFS.filter((d) => infra[d.key] && infra[d.key].ok === false);
  if (down.length === 0) return "";
  const parts = down.map((d) => {
    const item = infra[d.key] || {};
    return e(d.label) + " is down (" + e(ageText(item.ageMin)) + ")";
  });
  return (
    '<div class="ops-banner" role="alert">' +
    "<strong>Attention needed: </strong>" +
    e(parts.join("; ")) +
    "</div>"
  );
}

// (2) Health strip: five chips with detail text and "since N min".
export function renderHealth(status, esc = escapeHtml) {
  const e = typeof esc === "function" ? esc : escapeHtml;
  const infra = infraOf(status);
  const chips = HEALTH_DEFS.map((d) => {
    const item = infra[d.key] || {};
    const ok = item.ok === true;
    const cls = ok ? "ops-chip ops-chip-ok" : "ops-chip ops-chip-bad";
    const word = ok ? "working" : "down";
    return (
      '<div class="' + cls + '">' +
      '<div class="ops-chip-name">' + e(d.label) + ": " + e(word) + "</div>" +
      '<div class="ops-chip-detail">' + e(item.detail === undefined ? "no report yet" : item.detail) + "</div>" +
      '<div class="ops-chip-age">' + e(ageText(item.ageMin)) + "</div>" +
      "</div>"
    );
  }).join("");
  return (
    '<section class="ops-card" aria-label="Health">' +
    "<h2>Health</h2>" +
    '<div class="ops-grid">' + chips + "</div>" +
    "</section>"
  );
}

const MONEY_WINDOWS = [
  { key: "fiveHour", label: "5-hour window" },
  { key: "weekly", label: "Weekly window" },
  { key: "monthly", label: "Monthly window" },
];

function resetText(w) {
  if (!w || typeof w !== "object") return "reset time unknown";
  if (w.resetsIn !== undefined && w.resetsIn !== null && String(w.resetsIn) !== "") {
    return "resets " + String(w.resetsIn);
  }
  if (w.resetsAt !== undefined && w.resetsAt !== null && String(w.resetsAt) !== "") {
    return "resets at " + String(w.resetsAt);
  }
  return "reset time unknown";
}

// (3) Money strip: OpenCode remaining percent per window, DeepSeek balance,
// credit spent vs cap as a bar.
export function renderMoney(status, esc = escapeHtml) {
  const e = typeof esc === "function" ? esc : escapeHtml;
  const money = (status && status.money && typeof status.money === "object") ? status.money : {};
  const opencode = (money.opencode && typeof money.opencode === "object") ? money.opencode : {};
  const rows = MONEY_WINDOWS.map((w) => {
    const win = opencode[w.key] || {};
    const pct = numOrNull(win.remainingPct);
    const pctText = pct === null ? "not measured" : pct + "% left";
    return (
      '<div class="ops-money-row">' +
      "<span>" + e(w.label) + "</span>" +
      "<strong>" + e(pctText) + "</strong>" +
      '<span class="ops-dim">' + e(resetText(win)) + "</span>" +
      "</div>"
    );
  }).join("");
  const balance = numOrNull(money.deepseekBalance);
  const spent = numOrNull(money.creditSpent);
  const cap = numOrNull(money.cap);
  const balanceText = balance === null ? "not measured" : "$" + balance.toFixed(2);
  const spentText = spent === null ? "not measured" : "$" + spent.toFixed(2);
  const capText = cap === null ? "not set" : "$" + cap.toFixed(2);
  const fillPct = (spent !== null && cap !== null && cap > 0)
    ? Math.max(0, Math.min(PERCENT_MAX, (spent / cap) * PERCENT_MAX))
    : 0;
  return (
    '<section class="ops-card" aria-label="Money">' +
    "<h2>Money</h2>" +
    '<div class="ops-sub">OpenCode remaining per window</div>' +
    rows +
    '<div class="ops-money-row"><span>DeepSeek balance</span><strong>' + e(balanceText) + "</strong></div>" +
    '<div class="ops-money-row"><span>Credit spent vs cap</span><strong>' +
    e(spentText) + " of " + e(capText) + "</strong></div>" +
    '<div class="ops-bar" role="img" aria-label="Credit spent versus cap">' +
    '<div class="ops-bar-fill" style="width:' + e(String(Math.round(fillPct))) + '%"></div>' +
    "</div>" +
    "</section>"
  );
}

function orderWord(raw) {
  const v = String(raw === undefined || raw === null ? "" : raw);
  if (v === "need") return "waiting";
  if (v === "active") return "running";
  if (v === "done") return "done";
  if (v === "exhausted") return "gave up";
  return v === "" ? "unknown" : v;
}

const STATE_PRIORITY = ["active", "need", "exhausted", "failed", "done"];

// (4) Queue panel: counts, Pause/Resume button, order list in plain words.
export function renderQueue(status, esc = escapeHtml) {
  const e = typeof esc === "function" ? esc : escapeHtml;
  const q = (status && status.queue && typeof status.queue === "object") ? status.queue : {};
  const counts = (q.counts && typeof q.counts === "object") ? q.counts : {};
  const done = numOrNull(counts.done) === null ? 0 : counts.done;
  const running = numOrNull(counts.active) === null ? 0 : counts.active;
  const waiting = numOrNull(counts.waiting) === null ? 0 : counts.waiting;
  const failed = numOrNull(counts.failed) === null ? 0 : counts.failed;
  const paused = q.paused === true;
  const btnLabel = paused ? "Resume" : "Pause";
  const stateNote = paused ? "paused" : "running";
  const orders = (q.orders && typeof q.orders === "object") ? q.orders : {};
  const names = Object.keys(orders);
  const rowFor = (name) => (
    '<li><span class="ops-order-name">' + e(name) + '</span> ' +
    '<span class="ops-order-state">' + e(orderWord(orders[name])) + "</span></li>"
  );
  const stateRank = (state) => {
    const i = STATE_PRIORITY.indexOf(String(state === undefined || state === null ? "" : state));
    return i !== -1 ? i : (STATE_PRIORITY.indexOf("failed") + STATE_PRIORITY.indexOf("done")) / 2;
  };
  const sorted = names.slice().sort((a, b) => stateRank(orders[a]) - stateRank(orders[b]));
  const open = sorted.filter((name) => orders[name] !== "done");
  const finished = sorted.filter((name) => orders[name] === "done");
  const list = names.length === 0
    ? '<div class="ops-dim">No orders in the queue right now.</div>'
    : (open.length === 0 ? "" : '<ul class="ops-orders">' + open.map(rowFor).join("") + "</ul>") +
      (finished.length === 0 ? "" : (
        '<details><summary>' + e(finished.length === 1 ? "1 finished order" : finished.length + " finished orders") + "</summary>" +
        '<ul class="ops-orders">' + finished.map(rowFor).join("") + "</ul></details>"
      ));
  return (
    '<section class="ops-card" aria-label="Queue">' +
    "<h2>Work queue</h2>" +
    '<div class="ops-counts">' +
    "<span>done: <strong>" + e(String(done)) + "</strong></span> " +
    "<span>running: <strong>" + e(String(running)) + "</strong></span> " +
    "<span>waiting: <strong>" + e(String(waiting)) + "</strong></span> " +
    "<span>failed: <strong>" + e(String(failed)) + "</strong></span>" +
    "</div>" +
    '<div class="ops-row"><span class="ops-dim">The queue is ' + e(stateNote) + ".</span>" +
    '<button class="btn" data-act="pause-toggle">' + e(btnLabel) + "</button></div>" +
    list +
    "</section>"
  );
}

// (4b) Workers panel: real processes only.
export function renderWorkers(status, esc = escapeHtml) {
  const e = typeof esc === "function" ? esc : escapeHtml;
  const head = '<section class="ops-card" aria-label="Workers"><h2>Workers</h2>';
  const w = (status && status.workers && typeof status.workers === "object") ? status.workers : null;
  if (w && w.unavailable === true) {
    return head + '<div class="ops-dim">Worker list is not available right now: ' + e(w.reason) + "</div></section>";
  }
  const list = (w && Array.isArray(w.workers)) ? w.workers : [];
  if (list.length === 0) {
    return head + '<div class="ops-dim">No workers running.</div></section>';
  }
  const rows = list.map((row) => {
    const r = (row && typeof row === "object") ? row : {};
    const orderName = r.orderId ? String(r.orderId) : "unknown order";
    const kindWord = r.kind === "opencode" ? "worker" : (r.kind === "jcode" ? "terminal" : String(r.kind === undefined || r.kind === null ? "" : r.kind));
    const memText = (typeof r.memMB === "number" && Number.isFinite(r.memMB)) ? String(r.memMB) + " MB" : "unknown";
    const runText = (typeof r.runningMin === "number" && Number.isFinite(r.runningMin))
      ? String(Math.max(0, Math.floor(r.runningMin))) + " min"
      : "0 min";
    const badgeText = r.headless === true ? "headless, no window" : "has a window";
    return (
      "<tr>" +
      '<td class="ops-order-name">' + e(orderName) + "</td>" +
      "<td>" + e(kindWord) + "</td>" +
      "<td>" + e(String(r.pid)) + "</td>" +
      "<td>" + e(memText) + "</td>" +
      "<td>" + e(runText) + "</td>" +
      '<td><span class="ops-badge">' + e(badgeText) + "</span></td>" +
      "<td>" +
      '<button class="btn" data-act="tail" data-pid="' + e(String(r.pid)) + '">Live output</button> ' +
      '<button class="btn" data-act="kill" data-pid="' + e(String(r.pid)) + '" data-confirm="1">Kill</button>' +
      "</td>" +
      "</tr>"
    );
  }).join("");
  return (
    head +
    '<table class="ops-table"><thead><tr><th>Order</th><th>Kind</th><th>PID</th>' +
    "<th>Memory</th><th>Running</th><th>Window</th><th>Actions</th></tr></thead>" +
    "<tbody>" + rows + "</tbody></table></section>"
  );
}

// (4c) Tasks panel with All/New/Old filter.
export function renderTasks(status, filter, esc = escapeHtml) {
  const e = typeof esc === "function" ? esc : escapeHtml;
  const f = filter === TASK_FILTER_NEW ? TASK_FILTER_NEW : (filter === TASK_FILTER_OLD ? TASK_FILTER_OLD : TASK_FILTER_ALL);
  const all = (status && Array.isArray(status.tasks)) ? status.tasks : [];
  const shown = f === TASK_FILTER_NEW
    ? all.filter(taskAgeNew)
    : (f === TASK_FILTER_OLD ? all.filter((t) => !taskAgeNew(t)) : all.slice());
  const btn = (value, label) => (
    '<button class="btn" data-act="task-filter" data-filter="' + e(value) + '">' + e(label) + "</button>"
  );
  const bar =
    '<div class="ops-row">' + btn(TASK_FILTER_ALL, "All") + btn(TASK_FILTER_NEW, "New") + btn(TASK_FILTER_OLD, "Old") + "</div>";
  const head = '<section class="ops-card" aria-label="Tasks"><h2>Tasks</h2>' + bar;
  if (shown.length === 0) {
    return head + '<div class="ops-dim">No tasks.</div></section>';
  }
  const rows = shown.map((t) => {
    const task = (t && typeof t === "object") ? t : {};
    const orderName = task.orderId ? String(task.orderId) : String(task.id === undefined || task.id === null ? "unknown" : task.id);
    const age = (typeof task.ageMin === "number" && Number.isFinite(task.ageMin))
      ? Math.max(0, Math.floor(task.ageMin))
      : 0;
    const tag = taskAgeNew(task)
      ? '<span class="ops-tag-new">NEW</span>'
      : '<span class="ops-tag-old">OLD</span>';
    const plain = task.errorPlain === undefined || task.errorPlain === null ? "" : String(task.errorPlain);
    const raw = task.error === undefined || task.error === null ? "" : String(task.error);
    return (
      '<div class="ops-task">' +
      '<div class="ops-row"><span class="ops-order-name">' + e(orderName) + "</span>" + tag + "</div>" +
      '<div class="ops-dim">' + e(taskStatusWord(task.status)) + " · " + e("updated " + String(age) + " min ago") + "</div>" +
      (plain !== "" ? '<div class="ops-dim">' + e(plain) + "</div>" : "") +
      (raw !== "" ? "<details><summary>details</summary><div>" + e(raw) + "</div></details>" : "") +
      '<div class="ops-row">' +
      '<button class="btn" data-act="retry" data-project="' + e(String(task.projectId)) + '" data-task="' + e(String(task.id)) + '">Retry</button>' +
      '<button class="btn" data-act="drop" data-project="' + e(String(task.projectId)) + '" data-task="' + e(String(task.id)) + '">Drop</button>' +
      "</div>" +
      "</div>"
    );
  }).join("");
  return head + rows + "</section>";
}

// (4d) Alerts panel, newest first.
export function renderAlerts(status, esc = escapeHtml) {
  const e = typeof esc === "function" ? esc : escapeHtml;
  const head = '<section class="ops-card" aria-label="Alerts"><h2>Alerts</h2>';
  const all = (status && Array.isArray(status.alerts)) ? status.alerts.slice() : [];
  if (all.length === 0) {
    return head + '<div class="ops-dim">No alerts.</div></section>';
  }
  const ageOf = (a) => (
    (a && typeof a.ageMin === "number" && Number.isFinite(a.ageMin)) ? a.ageMin : ALERT_AGE_UNKNOWN_MIN
  );
  all.sort((a, b) => ageOf(a) - ageOf(b));
  const rows = all.map((a) => {
    const item = (a && typeof a === "object") ? a : {};
    const age = (typeof item.ageMin === "number" && Number.isFinite(item.ageMin))
      ? Math.max(0, Math.floor(item.ageMin))
      : 0;
    const isNew = item.fresh === true || taskAgeNew(item);
    const tag = isNew ? '<span class="ops-tag-new">NEW</span>' : '<span class="ops-tag-old">OLD</span>';
    return (
      '<div class="ops-alert">' +
      "<span>" + e(item.text === undefined || item.text === null ? "" : item.text) + "</span> " +
      '<span class="ops-dim">' + e(String(age) + " min ago") + "</span> " +
      tag +
      "</div>"
    );
  }).join("");
  return head + rows + "</section>";
}

// (5) Failure box.
export function renderFailure() {
  return '<div class="ops-fail" role="alert">' + escapeHtml(FAILURE_TEXT) + "</div>";
}

function ensureStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement("style");
  st.id = STYLE_ID;
  st.textContent =
    ".ops-wrap{display:flex;flex-direction:column;gap:12px;max-width:720px}" +
    ".ops-big{font-size:24px;font-weight:700}" +
    ".ops-banner{background:var(--panel);border:1px solid var(--err);color:var(--err);" +
    "border-radius:8px;padding:10px 12px}" +
    ".ops-fail{background:var(--panel);border:1px solid var(--err);color:var(--err);" +
    "border-radius:8px;padding:16px;text-align:center;font-weight:600}" +
    ".ops-card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px}" +
    ".ops-card h2{margin:0 0 8px;font-size:17px}" +
    ".ops-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px}" +
    ".ops-chip{border:1px solid var(--line);border-radius:8px;padding:8px;background:var(--panel2)}" +
    ".ops-chip-ok{border-color:var(--ok)}" +
    ".ops-chip-bad{border-color:var(--err)}" +
    ".ops-chip-name{font-weight:700}" +
    ".ops-chip-detail{color:var(--dim);font-size:12px;overflow-wrap:anywhere}" +
    ".ops-chip-age{color:var(--dim);font-size:12px}" +
    ".ops-money-row{display:flex;gap:8px;flex-wrap:wrap;align-items:baseline;justify-content:space-between}" +
    ".ops-sub{color:var(--dim);font-size:12px;margin-bottom:4px}" +
    ".ops-dim{color:var(--dim);font-size:12px}" +
    ".ops-bar{height:8px;border:1px solid var(--line);border-radius:99px;overflow:hidden;background:var(--panel2)}" +
    ".ops-bar-fill{height:100%;background:var(--accent)}" +
    ".ops-counts{display:flex;gap:12px;flex-wrap:wrap}" +
    ".ops-row{display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin:8px 0}" +
    ".ops-orders{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:4px}" +
    ".ops-orders li{display:flex;gap:8px;justify-content:space-between;border-top:1px solid var(--line);padding:4px 0}" +
    ".ops-order-name{overflow-wrap:anywhere}" +
    ".ops-tag-new{border:1px solid var(--ok);border-radius:99px;padding:0 8px;font-size:12px;font-weight:700}" +
    ".ops-tag-old{border:1px solid var(--line);border-radius:99px;padding:0 8px;font-size:12px;color:var(--dim)}" +
    ".ops-badge{border:1px solid var(--line);border-radius:99px;padding:0 8px;font-size:12px;color:var(--dim)}" +
    ".ops-table{width:100%;border-collapse:collapse;font-size:13px}" +
    ".ops-table th,.ops-table td{border-top:1px solid var(--line);padding:6px 4px;text-align:left;vertical-align:top}" +
    ".ops-task{border-top:1px solid var(--line);padding:8px 0}" +
    ".ops-alert{display:flex;gap:8px;flex-wrap:wrap;align-items:baseline;border-top:1px solid var(--line);padding:6px 0}" +
    ".ops-panel{border:1px solid var(--line);border-radius:8px;padding:8px;background:var(--panel2)}" +
    ".ops-pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}";
  document.head.appendChild(st);
}

function allOk(status) {
  const infra = infraOf(status);
  return HEALTH_DEFS.every((d) => !infra[d.key] || infra[d.key].ok !== false);
}

export function mount(el, ctx) {
  const c = ctx || {};
  const esc = typeof c.esc === "function" ? c.esc : escapeHtml;
  const api = typeof c.api === "function" ? c.api : null;
  ensureStyles();

  let status = null;
  let failed = false;
  let busy = false;
  let disposed = false;
  let timer = null;
  // Part 2 closure state (survives the 3s re-render).
  let taskFilter = TASK_FILTER_ALL;
  let openTailPid = null;
  let tailLines = [];
  let tailNote = "";
  let actionBusy = false;
  let actionMsg = "";

  function headline() {
    if (failed) return "Cannot reach the router right now.";
    if (!status) return "Loading…";
    return allOk(status) ? "All good." : "Something needs attention.";
  }

  function actionBox() {
    if (!actionMsg) return "";
    return '<div class="ops-fail" role="alert">' + esc(actionMsg) + "</div>";
  }

  function tailPanelInner() {
    if (openTailPid === null) return "";
    const lines = Array.isArray(tailLines) ? tailLines : [];
    const note = String(tailNote === undefined || tailNote === null ? "" : tailNote);
    let inner = "";
    if (note !== "") {
      inner = '<div class="ops-dim">' + esc(note) + "</div>";
    } else if (lines.length === 0) {
      inner = '<div class="ops-dim">' + esc(TAIL_NOT_CAPTURED) + "</div>";
    } else {
      inner = '<pre class="ops-pre">' + esc(lines.join("\n")) + "</pre>";
    }
    return (
      '<div class="ops-panel" data-panel="tail">' +
      "<h3>Live output for worker " + esc(String(openTailPid)) + "</h3>" +
      inner +
      '<button class="btn" data-act="tail-close">Close</button>' +
      "</div>"
    );
  }

  function render() {
    const boundBanner = (s) => renderBanner(s, esc);
    const boundHealth = (s) => renderHealth(s, esc);
    const boundMoney = (s) => renderMoney(s, esc);
    const boundQueue = (s) => renderQueue(s, esc);
    let body = "";
    if (failed || !status) {
      body = failed
        ? renderFailure()
        : '<div class="ops-card"><div class="ops-dim">Loading…</div></div>';
    } else {
      body = boundBanner(status) + boundHealth(status) + boundMoney(status) + boundQueue(status) +
        renderWorkers(status, esc) + renderTasks(status, taskFilter, esc) + renderAlerts(status, esc) +
        actionBox() + tailPanelInner();
    }
    el.innerHTML =
      '<div class="ops-wrap">' +
      '<div class="ops-big">' + esc(headline()) + "</div>" +
      body +
      "</div>";
    // PART 2 added: workers/tasks/alerts sections above plus the tail side panel.
  }

  async function loadTail(pid) {
    if (!api) {
      tailNote = "Live output is not available: the page has no api.";
      render();
      return;
    }
    try {
      const data = await api(workerTailPath(pid));
      if (disposed || openTailPid !== pid) return;
      const d = (data && typeof data === "object") ? data : {};
      tailLines = Array.isArray(d.lines) ? d.lines.map((l) => String(l)) : [];
      tailNote = d.note === undefined || d.note === null ? "" : String(d.note);
    } catch (err) {
      if (disposed || openTailPid !== pid) return;
      tailNote = "Live output could not be loaded: " + (err && err.message ? err.message : String(err));
    }
    // Refill the side panel after the re-render without losing filter/tail state.
    render();
  }

  async function tick() {
    if (disposed || busy) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    if (!api) {
      failed = true;
      render();
      return;
    }
    busy = true;
    try {
      const data = await api(STATUS_PATH);
      if (disposed) return;
      status = data;
      failed = false;
    } catch {
      if (disposed) return;
      failed = true;
    } finally {
      busy = false;
    }
    render();
  }

  async function onClick(ev) {
    const node = ev.target && ev.target.closest ? ev.target.closest("[data-act]") : null;
    if (!node) return;
    const act = node.getAttribute("data-act");
    // Pause toggle keeps its exact part-1 behaviour (poll busy guard).
    if (act === "pause-toggle") {
      const t = node;
      if (!api || busy) return;
      t.disabled = true;
      const path = status && status.queue && status.queue.paused === true ? RESUME_PATH : PAUSE_PATH;
      try {
        await api(path, { method: "POST" });
      } catch (err) {
        actionMsg = "Pause/Resume failed: " + (err && err.message ? err.message : String(err));
      }
      t.disabled = false;
      await tick();
      return;
    }
    if (act === "task-filter") {
      const f = node.getAttribute("data-filter");
      taskFilter = f === TASK_FILTER_NEW ? TASK_FILTER_NEW : (f === TASK_FILTER_OLD ? TASK_FILTER_OLD : TASK_FILTER_ALL);
      render();
      return;
    }
    if (act === "tail") {
      const pid = Number(node.getAttribute("data-pid"));
      if (!Number.isFinite(pid)) return;
      openTailPid = pid;
      tailLines = [];
      tailNote = "";
      render();
      await loadTail(pid);
      return;
    }
    if (act === "tail-close") {
      openTailPid = null;
      tailLines = [];
      tailNote = "";
      render();
      return;
    }
    if (act === "kill") {
      if (!api || actionBusy) return;
      const pid = Number(node.getAttribute("data-pid"));
      if (!Number.isFinite(pid)) return;
      if (typeof window !== "undefined" && typeof window.confirm === "function") {
        if (!window.confirm("Kill worker " + String(pid) + "?")) return;
      }
      actionBusy = true;
      try {
        await api(workerKillPath(pid), { method: "POST" });
        actionMsg = "";
      } catch (err) {
        actionMsg = "Kill failed: " + (err && err.message ? err.message : String(err));
      } finally {
        actionBusy = false;
      }
      render();
      await tick();
      return;
    }
    if (act === "retry" || act === "drop") {
      if (!api || actionBusy) return;
      const projectId = String(node.getAttribute("data-project") || "");
      const taskId = String(node.getAttribute("data-task") || "");
      if (!projectId || !taskId) return;
      const path = act === "retry" ? taskRetryPath(projectId, taskId) : taskDropPath(projectId, taskId);
      actionBusy = true;
      try {
        await api(path, { method: "POST" });
        actionMsg = "";
      } catch (err) {
        actionMsg = (act === "retry" ? "Retry failed: " : "Drop failed: ") + (err && err.message ? err.message : String(err));
      } finally {
        actionBusy = false;
      }
      render();
      await tick();
      return;
    }
  }

  function onVisible() {
    if (typeof document !== "undefined" && document.visibilityState === "visible") void tick();
  }

  el.addEventListener("click", onClick);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
  render();
  void tick();
  if (typeof setInterval !== "undefined") timer = setInterval(() => { void tick(); }, REFRESH_MS);

  return function cleanup() {
    disposed = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    el.removeEventListener("click", onClick);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
    el.innerHTML = "";
  };
}
