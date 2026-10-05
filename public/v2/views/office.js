/* public/v2/views/office.js - the Office view: every agent at a desk, by department.
 *
 * Look and interaction model adapted from github.com/harishkotra/agent-office
 * (MIT, Copyright (c) 2026 Harish Kotra) - zone = room, desk per agent,
 * action -> emote bubble, click-to-focus, inspector panel. See
 * public/v2/vendor-notes/AGENT_OFFICE.md for what was studied and what was
 * deliberately left behind (Phaser/Colyseus/React and their art assets).
 * No code was copied; this is original DOM + CSS. Credited anyway.
 *
 * Owned by UI-OFFICE (docs/UI_V2_SPEC.md). Read-only calls:
 *   GET /company/org       structure: departments -> projects -> teams -> agents
 *   GET /company/agents    roster with per-agent live status + budget + last message
 *   GET /company/sessions  live session board (source of truth for "working on X")
 *   GET /company/budgets   company-wide allocated/spent
 *
 * Click behaviour:
 *   - a WORKING desk jumps to its task: #/flow/<taskId>   (as the brief asks)
 *   - an idle/failed desk focuses it and opens the inspector card
 *   - clicking the focused desk again unfocuses it (same gesture as agent-office)
 */

export const title = "Office";

const SESSIONS_MS = 4000; // live state
const ROSTER_MS = 20000; // agents/budgets rarely change shape
const STALE_AFTER_MS = 15000; // a poll this late is worth flagging in the header
const FAILED_RECENT_MS = 2 * 3600 * 1000; // a failure older than this is just history
const DENSITY_KEY = "v2.office.density";
const STYLE_ID = "v2-office-style";

/* Focus survives a remount: clicking a working desk navigates away to Flow,
 * and coming back should land you on the same desk. Module-scoped on purpose. */
let focusedKey = null;
let density = null;

const ROLE_ICON = {
  "prompt-enhancer": "✨",
  manager: "🧠",
  coder: "⌨️",
  tester: "🧪",
  opposer: "⚔️",
  summarizer: "📝",
  assistant: "🎩",
};

const STATE_META = {
  working: { label: "working", emote: "💻", dot: "dot-run", pill: "pill-run" },
  queued: { label: "queued", emote: "⏳", dot: "dot-warn", pill: "pill-warn" },
  failed: { label: "last run failed", emote: "⚠️", dot: "dot-err", pill: "pill-err" },
  nobudget: { label: "no budget", emote: "🪫", dot: "dot-warn", pill: "pill-warn" },
  idle: { label: "idle", emote: "😌", dot: "", pill: "pill-dim" },
};

const DEPT_ACCENTS = ["#6f9cf6", "#b088f9", "#4cc46a", "#f0a35e", "#6ed68a", "#ef6b62", "#6cb6ff"];

/* ------------------------------------------------------------------ *
 * Small helpers. The shell passes these in ctx; the local versions only
 * matter if this view is mounted by a harness that passes less.
 * ------------------------------------------------------------------ */
const str = (v) => (v === null || v === undefined ? "" : typeof v === "string" ? v : String(v));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const usd = (v) => "$" + num(v).toFixed(2);
const plural = (n, word) => n + " " + word + (Number(n) === 1 ? "" : "s");

function localEsc(s) {
  return str(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function localAgo(iso) {
  const t = Date.parse(str(iso));
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}

function localHm(iso) {
  const t = Date.parse(str(iso));
  if (!Number.isFinite(t)) return "--:--:--";
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

function cut(s, n) {
  const t = str(s).replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  const head = t.slice(0, n);
  const sp = head.lastIndexOf(" ");
  return (sp > n * 0.6 ? head.slice(0, sp) : head).trimEnd() + "…";
}

function firstLine(s) {
  const t = str(s).trim();
  if (!t) return "";
  return (t.split(/\r?\n/).find((l) => l.trim().length > 0) || t).trim();
}

/* ------------------------------------------------------------------ *
 * Scoped styles. Every rule is prefixed .off- and the whole <style> node is
 * removed on cleanup, so this cannot leak into the shell or another view.
 * Colours come from the shell tokens only.
 * ------------------------------------------------------------------ */
/* UI-CLEAN: the office CSS moved to public/v2/style.css (one visual system for
 * the whole dashboard), so this view no longer injects a <style> block. */
const CSS = "";

const CREDIT =
  'Office layout inspired by <a href="https://github.com/harishkotra/agent-office" target="_blank" rel="noreferrer noopener">harishkotra/agent-office</a> (MIT, © 2026 Harish Kotra). No code copied; notes in <span class="mono">public/v2/vendor-notes/AGENT_OFFICE.md</span>.';

function ensureStyle() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

/* ------------------------------------------------------------------ *
 * Data model
 * ------------------------------------------------------------------ */
function currentDensity() {
  if (density !== null) return density;
  density = "roomy";
  try {
    const v = localStorage.getItem(DENSITY_KEY);
    if (v === "compact" || v === "roomy") density = v;
  } catch (e) {
    /* private mode: keep the default */
  }
  return density;
}

function setDensity(v) {
  density = v;
  try {
    localStorage.setItem(DENSITY_KEY, v);
  } catch (e) {
    /* ignore */
  }
}

const keyOf = (a) => str(a.agentKey) || str(a.projectId) + "::" + str(a.agentId);

/** Live state of one roster agent, computed from the session board. */
function liveFor(a, sessions) {
  // listSessions() is newest-first and filter() preserves order.
  const mine = sessions.filter(
    (s) => str(s.projectId) === str(a.projectId) && str(s.agentId) === str(a.agentId),
  );
  const running = mine.find((s) => s.status === "running");
  const queued = mine.find((s) => s.status === "queued");
  const last = mine[0];
  const startedMs = last ? Date.parse(str(last.startedAt)) : NaN;
  const lastFailed =
    Boolean(last) && last.status === "error" && Number.isFinite(startedMs)
      ? Date.now() - startedMs < FAILED_RECENT_MS
      : Boolean(last) && last.status === "error";
  // CEO order 2026-10-01: agents have no per-agent quota, so there is no
  // "no budget" state any more. Provider pressure live elsewhere (budgetGuard).

  let state = "idle";
  if (running) state = "working";
  else if (queued) state = "queued";
  else if (lastFailed) state = "failed";

  const current = running || queued || null;
  const task = running
    ? { id: running.taskId, title: running.taskTitle, kind: "current" }
    : lastFailed
      ? { id: last.taskId, title: last.taskTitle, kind: "failed" }
      : last && last.taskId
        ? { id: last.taskId, title: last.taskTitle, kind: "last" }
        : null;

  return {
    state,
    task,
    liveText: current ? str(current.lastText) : "",
    lastText: str(last && last.lastText),
    since: current ? current.startedAt : last ? last.finishedAt || last.startedAt : null,
    error: lastFailed ? str(last.lastText) : "",
  };
}

/** /company/org + /company/agents -> the rooms (departments) we draw. */
function buildRooms(org, agentList) {
  const byDept = new Map();
  for (const a of agentList) {
    const dId = str(a.departmentId) || "?";
    if (!byDept.has(dId)) byDept.set(dId, []);
    byDept.get(dId).push(a);
  }

  const declared = [];
  const seen = new Set();
  for (const d of Array.isArray(org && org.departments) ? org.departments : []) {
    seen.add(str(d.id));
    declared.push({
      id: str(d.id),
      name: str(d.name) || str(d.id),
      projects: (Array.isArray(d.projectIds) ? d.projectIds : []).map((pid) => {
        const p = (org.projects || []).find((x) => str(x.id) === str(pid));
        return { id: str(pid), name: p ? str(p.name) : str(pid) };
      }),
      synthetic: false,
    });
  }

  // A department the org does not list (the CEO assistant lives in "d-ceo",
  // created on first use) still deserves a room. Those go first: it is the
  // CEO's own office.
  const extras = [];
  for (const [dId, list] of byDept) {
    if (seen.has(dId)) continue;
    extras.push({
      id: dId,
      name: str(list[0].departmentName) || dId,
      projects: [],
      synthetic: true,
    });
  }

  for (const r of extras.concat(declared)) {
    r.desks = [];
    const list = byDept.get(r.id) || [];
    const projectIds = r.projects.map((p) => p.id);
    for (const a of list) {
      const pid = str(a.projectId);
      if (!projectIds.includes(pid)) projectIds.push(pid);
    }
    for (const pid of projectIds) {
      const group = list.filter((a) => str(a.projectId) === pid);
      if (!group.length) continue;
      const named = r.projects.find((p) => p.id === pid);
      r.desks.push({
        projectId: pid,
        projectName: (named && named.name) || str(group[0].projectName) || pid,
        agents: group,
      });
    }
  }
  // Keep empty declared departments (they are real rooms, just unstaffed).
  return extras.concat(declared).filter((r) => r.desks.length > 0 || !r.synthetic);
}

/* ------------------------------------------------------------------ *
 * mount
 * ------------------------------------------------------------------ */
export function mount(el, ctx) {
  const c = ctx || {};
  const api = c.api;
  const pollFn = typeof c.poll === "function" ? c.poll : null;
  const esc = typeof c.esc === "function" ? c.esc : localEsc;
  const ago = typeof c.ago === "function" ? c.ago : localAgo;
  const hm = typeof c.hm === "function" ? c.hm : localHm;
  const navigate =
    typeof c.navigate === "function"
      ? c.navigate
      : (h) => {
          if (typeof location !== "undefined") location.hash = str(h).replace(/^#/, "");
        };

  ensureStyle();
  el.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "off-wrap";
  wrap.setAttribute("data-density", currentDensity());
  el.appendChild(wrap);

  let org = null;
  let agents = [];
  let totals = { spentUsd: 0, capsRemoved: true };
  let sessions = [];
  let lastOk = 0;
  let fatal = null; // first load failed: show the error state instead of rooms
  let loadedOnce = false;
  let selected = focusedKey;
  let sig = ""; // roster signature, to detect structure changes
  let running = false; // one refresh at a time
  const desks = new Map(); // agentKey -> desk element
  let stateByKey = new Map(); // agentKey -> last rendered state (drives the emote pop)
  const stops = [];
  let disposed = false;

  const rooms = () => buildRooms(org, agents);
  const kpi = (val, lbl) =>
    '<div class="kpi"><div class="kpi-val">' + esc(val) + '</div><div class="kpi-lbl">' + esc(lbl) + "</div></div>";

  /* ---------- header ---------- */
  function renderHead() {
    const head = wrap.querySelector(".off-head");
    const kpis = wrap.querySelector(".off-kpis");
    if (!head || !kpis) return;

    const lives = agents.map((a) => liveFor(a, sessions));
    const working = lives.filter((l) => l.state === "working").length;
    const queued = lives.filter((l) => l.state === "queued").length;
    const failed = lives.filter((l) => l.state === "failed").length;
    const stale = lastOk > 0 && Date.now() - lastOk > STALE_AFTER_MS;

    head.innerHTML =
      '<div class="muted small">' +
      esc(plural(agents.length, "agent")) + " · " + esc(plural(rooms().length, "department")) + "</div>" +
      '<div class="grow"></div>' +
      (fatal
        ? ""
        : '<div class="off-legend"><span class="dot dot-run"></span>working ' + esc(working) +
          " &nbsp;<span class=\"dot dot-warn\"></span>queued " + esc(queued) +
          (failed ? " &nbsp;<span class=\"dot dot-err\"></span>failed " + esc(failed) : "") +
          "</div>") +
      '<button class="btn btn-sm" type="button" data-act="density" title="Change desk size">' +
      (wrap.getAttribute("data-density") === "compact" ? "Roomy" : "Compact") +
      "</button>" +
      '<button class="btn btn-sm" type="button" data-act="refresh">Refresh</button>' +
      (stale
        ? '<div class="off-stale">live data stale · last ok ' + esc(hm(new Date(lastOk).toISOString())) + "</div>"
        : "");

    kpis.innerHTML =
      kpi(agents.length, "agents") +
      kpi(working, "working now") +
      kpi(usd(totals.spentUsd) + (num(totals.totalUsd) > 0 ? " / " + usd(totals.totalUsd) : ""), "spend") +
      kpi(lastOk ? hm(new Date(lastOk).toISOString()) : "--:--:--", "last update");

    for (const b of head.querySelectorAll("[data-act]")) {
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const act = b.getAttribute("data-act");
        if (act === "refresh") {
          refresh(true);
        } else if (act === "density") {
          setDensity(wrap.getAttribute("data-density") === "compact" ? "roomy" : "compact");
          wrap.setAttribute("data-density", density);
          renderHead();
        }
      });
    }
  }

  /* ---------- desk + room markup ---------- */
  function taskLineHtml(live) {
    if (!live.task || !live.task.id) return '<div class="off-task dimmed">no task yet</div>';
    const mark = live.task.kind === "current" ? "▸ " : live.task.kind === "failed" ? "✗ " : "◦ ";
    return (
      '<a class="off-task' + (live.task.kind === "current" ? "" : " dimmed") + '" href="#/flow/' +
      esc(live.task.id) + '" data-task="' + esc(live.task.id) + '" title="' + esc(live.task.title) + '">' +
      mark + esc(cut(live.task.title || live.task.id, 60)) + "</a>"
    );
  }

  function barHtml(budget) {
    const allocated = num(budget && budget.allocatedUsd);
    if (allocated <= 0) return "";
    const spent = num(budget.spentUsd);
    const pct = Math.min(100, Math.round((spent / allocated) * 100));
    const sev = pct >= 100 ? "sev-err" : pct >= 80 ? "sev-warn" : "sev-ok";
    return (
      '<div class="off-budget"><div class="bar"><div class="bar-fill ' + sev + '" style="width:' + pct +
      '"></div></div><small>' + esc(usd(spent)) + " of " + esc(usd(allocated)) + " · " +
      esc(num(budget.sessionsRun)) + " runs</small></div>"
    );
  }

  function deskHtml(a, live, accent) {
    const key = keyOf(a);
    const meta = STATE_META[live.state] || STATE_META.idle;
    const icon = ROLE_ICON[str(a.role)] || "•";
    return (
      '<div class="off-desk item" role="button" tabindex="0" data-key="' + esc(key) +
      '" data-state="' + esc(live.state) + '" data-taskkey="' +
      esc(live.task && live.task.id ? str(live.task.id) + "|" + str(live.task.title) + "|" + live.task.kind : "") +
      '" aria-pressed="' + (key === selected ? "true" : "false") + '" style="--c:' + esc(accent) + '"' +
      ' title="' + esc(str(a.name) + " · " + str(a.roleName || a.role) + " · " + (live.task ? live.task.title : meta.label)) + '">' +
      '<div class="off-stage" aria-hidden="true">' +
      '<span class="off-monitor"><i></i><u></u></span>' +
      '<span class="off-chair"></span>' +
      '<span class="off-avatar">' + esc(icon) + '<span class="off-emote" data-emote="1">' + meta.emote + "</span></span>" +
      "</div>" +
      '<div class="off-name"><b>' + esc(a.name || a.agentId) + "</b>" +
      (str(a.agentId) === "assistant" ? '<span class="pill pill-dim">CEO</span>' : "") + "</div>" +
      '<div class="off-roleline"><span>' + esc(str(a.roleName || a.role)) + "</span>" +
      '<span class="off-model">' + esc(str(a.modelId)) + "</span></div>" +
      '<div class="off-stateline"><span class="dot ' + meta.dot + '"></span><span data-statetext="1">' +
      esc(meta.label) + "</span></div>" +
      taskLineHtml(live) +
      barHtml(a.budget) +
      "</div>"
    );
  }

  function roomHtml(r, i) {
    const accent = DEPT_ACCENTS[i % DEPT_ACCENTS.length];
    const all = r.desks.reduce((acc, g) => acc.concat(g.agents), []);
    const working = all.filter((a) => liveFor(a, sessions).state === "working").length;
    const spent = all.reduce((s, a) => s + num(a.budget && a.budget.spentUsd), 0);
    const projects = r.desks
      .map(
        (g) =>
          '<div class="off-proj"><div class="off-proj-head"><span>' + esc(g.projectName) + "</span>" +
          '<span class="mono tiny">' + esc(g.projectId) + "</span>" +
          '<span class="grow"></span><span class="tiny">' + esc(plural(g.agents.length, "desk")) + "</span></div>" +
          '<div class="off-desks">' + g.agents.map((a) => deskHtml(a, liveFor(a, sessions), accent)).join("") +
          "</div></div>",
      )
      .join("");
    return (
      '<section class="card off-room" style="--c:' + esc(accent) + '" data-room="' + esc(r.id) + '">' +
      // The department id is shown because two departments can legitimately
      // share a name (the CEO assistant's synthetic "Executive" and the org's).
      '<div class="card-head"><div class="off-room-name"><h3>' + esc(r.name) + "</h3></div>" +
      '<span class="mono tiny">' + esc(r.id) + "</span>" +
      '<span class="muted tiny">' + esc(plural(all.length, "agent")) + "</span>" +
      (working
        ? '<span class="pill pill-run">' + esc(working) + " working</span>"
        : '<span class="pill pill-dim">no one working</span>') +
      '<span class="off-door" title="door"></span><span class="grow"></span>' +
      '<span class="muted tiny">' + esc(usd(spent)) + " spent</span></div>" +
      (projects || '<div class="muted small">No desks in this department yet.</div>') +
      "</section>"
    );
  }

  /* ---------- inspector ---------- */
  function inspectorHtml() {
    if (!selected) {
      return (
        '<div class="card"><div class="state"><div class="state-title">Nothing focused</div>' +
        "<div>Click a desk to see who that agent is, what it is working on, and what it last said.</div>" +
        '<div class="tiny">While an agent is working, clicking its desk jumps straight to its task in Flow.</div>' +
        "</div></div>"
      );
    }
    const a = agents.find((x) => keyOf(x) === selected);
    if (!a) return '<div class="card"><div class="state">That agent is no longer in the roster.</div></div>';

    const live = liveFor(a, sessions);
    const meta = STATE_META[live.state] || STATE_META.idle;
    const row = (k, v) =>
      '<div class="off-inspect-row"><span>' + esc(k) + "</span><span>" + esc(v) + "</span></div>";
    const allocated = num(a.budget && a.budget.allocatedUsd);
    const spent = num(a.budget && a.budget.spentUsd);
    const pct = allocated > 0 ? Math.min(100, Math.round((spent / allocated) * 100)) : 0;
    const sev = pct >= 100 ? "sev-err" : pct >= 80 ? "sev-warn" : "sev-ok";

    const taskBlock =
      live.task && live.task.id
        ? '<div class="row" style="gap:6px;margin-top:8px"><a class="btn btn-primary btn-sm" href="#/flow/' +
          esc(live.task.id) + '">Open task in Flow</a><span class="muted tiny">' +
          esc(live.task.kind === "current" ? "current" : live.task.kind === "failed" ? "failed" : "most recent") +
          "</span></div>" +
          '<div class="small mt-1">' + esc(cut(live.task.title || "", 220)) + "</div>"
        : '<div class="muted small mt-2">No task recorded for this agent yet.</div>';

    const text = live.liveText || live.lastText;
    const quote = text ? '<div class="off-quote">' + esc(cut(text, 700)) + "</div>" : "";
    const last = !text && a.lastMessage ? '<div class="off-quote">' + esc(cut(str(a.lastMessage), 400)) + "</div>" : "";

    return (
      '<div class="card" data-inspector="' + esc(selected) + '">' +
      '<div class="card-head"><div class="off-name" style="font-size:14px">' +
      '<span class="off-avatar off-desk-inline" style="--c:var(--accent)">' + esc(ROLE_ICON[str(a.role)] || "•") +
      "</span><b>" + esc(a.name || a.agentId) + "</b></div>" +
      '<span class="pill ' + meta.pill + '">' + esc(meta.label) + "</span>" +
      '<span class="grow"></span><button class="btn btn-sm btn-ghost" type="button" data-act="unfocus" title="Unfocus">✕</button></div>' +
      '<div class="off-inspect-body">' +
      row("Role", str(a.roleName || a.role)) +
      row("Department", str(a.departmentName)) +
      row("Project", str(a.projectName)) +
      row("Model", str(a.modelId)) +
      row("Agent id", str(a.agentId)) +
      row("Last activity", live.since ? ago(live.since) + " · " + hm(live.since) : "never") +
      "</div>" +
      taskBlock +
      (allocated > 0
        ? '<div class="mt-2"><div class="bar"><div class="bar-fill ' + sev + '" style="width:' + pct +
          '%"></div></div><div class="tiny muted mt-1">' + esc(usd(spent)) + " of " +
          esc(usd(allocated)) + " · " + esc(num(a.budget.sessionsRun)) + " runs</div></div>"
        : "") +
      (live.state === "failed" && live.error
        ? '<div class="off-quote" style="color:var(--err)">' + esc(cut(firstLine(live.error), 500)) + "</div>"
        : "") +
      quote +
      last +
      (a.running && live.state !== "working"
        ? '<div class="tiny muted mt-1">The roster still marks this agent as running.</div>'
        : "") +
      "</div>"
    );
  }

  /* ---------- render ---------- */
  function renderError(err) {
    fatal = err;
    wrap.innerHTML =
      '<div class="card state-error"><div class="state">' +
      '<div class="state-title">Could not load the office</div>' +
      '<div class="mono small">' + esc(str(err && err.message ? err.message : err)) + "</div>" +
      (err && err.status ? '<div class="tiny">HTTP ' + esc(err.status) + " from /company/*.</div>" : "") +
      '<button class="btn btn-primary btn-sm" type="button" data-act="retry">Retry</button>' +
      "</div></div>" +
      '<details class="off-credit"><summary>Credits</summary>' + CREDIT + "</details>";
    const b = wrap.querySelector("[data-act='retry']");
    if (b) b.addEventListener("click", () => refresh(true));
  }

  function renderLoading() {
    wrap.innerHTML =
      '<div class="off-head"><div class="skel" style="width:180px;height:18px"></div></div>' +
      '<div class="off-kpis"><div class="skel" style="height:44px"></div><div class="skel" style="height:44px"></div>' +
      '<div class="skel" style="height:44px"></div><div class="skel" style="height:44px"></div></div>' +
      '<div class="off-rooms"><div class="card"><div class="state"><span class="spinner"></span>' +
      "<div>Loading the office…</div>" +
      '<div class="tiny">Reading /company/org, /company/agents, /company/sessions, /company/budgets.</div>' +
      "</div></div></div>";
  }

  function renderAll() {
    fatal = null;
    wrap.innerHTML =
      '<div class="off-head"></div><div class="off-kpis"></div>' +
      '<div class="off-layout"><div class="off-rooms"></div><div class="off-aside"></div></div>' +
      '<details class="off-credit"><summary>Credits</summary>' + CREDIT + "</details>";

    const rs = rooms();
    wrap.querySelector(".off-rooms").innerHTML = rs.length
      ? rs.map((r, i) => roomHtml(r, i)).join("")
      : '<div class="card"><div class="state"><div class="state-title">No agents yet</div>' +
        "<div>No department here has agents. Order something through the Assistant, or create a project, " +
        "and it will appear as a room with desks.</div></div></div>";
    wrap.querySelector(".off-aside").innerHTML = inspectorHtml();

    desks.clear();
    stateByKey = new Map();
    for (const d of wrap.querySelectorAll(".off-desk")) {
      const key = d.getAttribute("data-key");
      desks.set(key, d);
      stateByKey.set(key, d.getAttribute("data-state"));
    }
    renderHead();
    wire();
  }

  /* ---------- interaction ---------- */
  function refocusAside() {
    for (const [k, node] of desks) node.setAttribute("aria-pressed", k === selected ? "true" : "false");
    const aside = wrap.querySelector(".off-aside");
    if (aside) aside.innerHTML = inspectorHtml();
    wire();
  }

  function wire() {
    for (const node of wrap.querySelectorAll(".off-desk")) {
      if (node.__offWired) continue;
      node.__offWired = true;

      const activate = () => {
        const key = node.getAttribute("data-key");
        const a = agents.find((x) => keyOf(x) === key);
        if (!a) return;
        if (key === selected) {
          // second activation unfocuses (same gesture as agent-office)
          selected = null;
          focusedKey = null;
          refocusAside();
          return;
        }
        selected = key;
        focusedKey = key;
        refocusAside();
        if (node.scrollIntoView) node.scrollIntoView({ block: "nearest" });
        const live = liveFor(a, sessions);
        // A working agent's desk is a shortcut to its current task.
        if (live.state === "working" && live.task && live.task.id) navigate("#/flow/" + live.task.id);
      };

      node.addEventListener("click", (ev) => {
        // the task link and the Flow button inside the desk navigate on their own
        if (ev.target && ev.target.closest && ev.target.closest("a[href]")) return;
        activate();
      });
      node.addEventListener("keydown", (ev) => {
        if (ev.target !== node) return; // let the inner link handle its own keys
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          activate();
        }
      });
    }
    for (const b of wrap.querySelectorAll("[data-act='unfocus']")) {
      if (b.__offWired) continue;
      b.__offWired = true;
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        selected = null;
        focusedKey = null;
        refocusAside();
      });
    }
  }

  /* ---------- live patching (keeps scroll position and focus) ---------- */
  function applyLive() {
    for (const [key, node] of desks) {
      const a = agents.find((x) => keyOf(x) === key);
      if (!a) continue;
      const live = liveFor(a, sessions);
      const meta = STATE_META[live.state] || STATE_META.idle;
      node.setAttribute("data-state", live.state);

      const st = node.querySelector("[data-statetext]");
      if (st) st.textContent = meta.label;
      const dot = node.querySelector(".dot");
      if (dot) dot.className = "dot " + meta.dot;

      const em = node.querySelector("[data-emote]");
      if (em) {
        if (em.textContent !== meta.emote) {
          em.textContent = meta.emote;
          em.setAttribute("data-fresh", "1");
          setTimeout(() => em.removeAttribute("data-fresh"), 600);
        } else if (stateByKey.get(key) !== live.state) {
          em.setAttribute("data-fresh", "1");
          setTimeout(() => em.removeAttribute("data-fresh"), 600);
        }
      }

      const want = live.task && live.task.id ? str(live.task.id) + "|" + str(live.task.title) + "|" + live.task.kind : "";
      if (node.getAttribute("data-taskkey") !== want) {
        node.setAttribute("data-taskkey", want);
        const old = node.querySelector(".off-task");
        if (old && old.parentNode) {
          const box = document.createElement("div");
          box.innerHTML = taskLineHtml(live);
          const next = box.firstElementChild;
          if (next) old.replaceWith(next);
        }
      }
      stateByKey.set(key, live.state);
    }
    renderHead();
    if (selected) refocusAside();
  }

  /* ---------- fetching ---------- */
  async function refresh(full) {
    if (disposed || running) return;
    if (typeof api !== "function") {
      renderError(new Error("api() was not provided by the shell (ctx.api)"));
      return;
    }
    running = true;
    try {
      const jobs = [api("/company/sessions")];
      if (full || !org || !agents.length) {
        jobs.push(api("/company/org"), api("/company/agents"), api("/company/budgets"));
      }
      const res = await Promise.all(jobs);
      if (disposed) return;
      const s = res[0];
      sessions = Array.isArray(s && s.items) ? s.items : [];
      if (res.length > 1) {
        org = res[1] || org;
        agents = Array.isArray(res[2]) ? res[2] : [];
        totals = res[3] || totals;
      }
      lastOk = Date.now();
      loadedOnce = true;
      const nextSig = agents.map(keyOf).join(",") + "|" + str(org && org.name);
      if (fatal || !wrap.querySelector(".off-rooms") || nextSig !== sig) {
        sig = nextSig;
        renderAll();
      } else {
        applyLive();
      }
    } catch (e) {
      if (!loadedOnce) renderError(e);
      else renderHead(); // keep the last good view, flag it as stale
    } finally {
      running = false;
    }
  }

  renderLoading();
  refresh(true);

  if (pollFn) {
    stops.push(pollFn(() => refresh(false), SESSIONS_MS));
    stops.push(pollFn(() => refresh(true), ROSTER_MS));
  } else {
    const t1 = setInterval(() => refresh(false), SESSIONS_MS);
    const t2 = setInterval(() => refresh(true), ROSTER_MS);
    stops.push(() => {
      clearInterval(t1);
      clearInterval(t2);
    });
  }

  return function cleanup() {
    disposed = true;
    for (const stop of stops) {
      try {
        stop();
      } catch (e) {
        /* ignore */
      }
    }
    stops.length = 0;
    const s = document.getElementById(STYLE_ID);
    if (s && s.parentNode) s.parentNode.removeChild(s);
    el.innerHTML = "";
  };
}
