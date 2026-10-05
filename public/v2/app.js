/* public/v2/app.js — the dashboard shell: router, nav, top bar, theme, states.
 * Owned by UI-SHELL (docs/UI_V2_SPEC.md).
 *
 * Routes (hash based, default #/briefing):
 *   #/briefing   #/assistant   #/projects   #/projects/:id   #/terminals
 *   #/terminals/:sessionId      #/fleet      #/fleet/:orderId
 *   #/flow       #/flow/:taskId #/office     #/system
 *
 * A view is `public/v2/views/<name>.js` and must export:
 *   export const title = "Projects";
 *   export const goal  = "one plain sentence: what this page is for";  // optional
 *   export function mount(el, ctx) { ... return function cleanup() {} }
 * ctx = { api, poll, esc, ago, hm, navigate, params, route }
 * plus additive extras (usd, dur, trunc, statusTone, IN_MOTION, TERMINAL).
 *
 * Until a view file exists the router renders a friendly "not built yet" card
 * instead of an error, and re-tries with a fresh URL (cache buster) so a view
 * that lands while the page is open can be picked up without a hard refresh.
 */
import {
  api, poll, esc, ago, hm,
  usd, dur, trunc, statusTone, IN_MOTION, TERMINAL,
  peekData, storeInfo,
} from "./api.js";

/* PERF (docs/PERF_SPEC.md, PERF-UI): this shell is the only poller that runs
 * regardless of which view is open (the top-bar counts are always visible), so
 * it polls slowly (15 s) and every one of its GETs goes through the shared
 * api.js store - when the visible view asks for the same path, it costs
 * nothing extra. Views own their own polling and stop it on unmount. */

const $view = document.getElementById("appview");
const $navlinks = document.getElementById("navlinks");
const $stats = document.getElementById("topstats");
const $company = document.getElementById("company-name");

/* ================================================================== *
 * Routes
 * ================================================================== */
/* Nav order, one clear path for a non-engineer (CEO order 2026-09-29 19:41):
 * Briefing (home) -> Assistant -> Projects -> Terminals -> Fleet -> Flow ->
 * Office -> System. Plain labels, one icon each, and a count badge only where
 * it tells the CEO something: how much needs them, how many projects, how many
 * tasks in flight, how many agents running. */
const VIEWS = [
  { name: "briefing", label: "Briefing", icon: "◈", badge: "needs" },
  { name: "assistant", label: "Assistant", icon: "✦", badge: null },
  { name: "projects", label: "Projects", icon: "▦", badge: "projects" },
  { name: "terminals", label: "Terminals", icon: "❯", badge: null },
  { name: "fleet", label: "Fleet", icon: "⚑", badge: null },
  { name: "flow", label: "Flow", icon: "⇄", badge: "inflight" },
  { name: "office", label: "Office", icon: "⌂", badge: "running" },
  { name: "system", label: "System", icon: "⏻", badge: null },
  // BUDGET (docs/BUDGET_SPEC.md, BUDGET session): real provider quota, what the
  // guard is doing about it. Icon is an escape, so this line stays pure ASCII.
  { name: "budget", label: "Budget", icon: "\u25d0", badge: null },
];
const DEFAULT_ROUTE = "/briefing"; // manager 18:35: "make #/briefing the default route"

/* One plain sentence per page, shown under the title. A view may override it
 * with its own `export const goal`, so the sentence never goes missing. */
const GOALS = {
  briefing: "What needs you, what was done, and what is still running - in plain words.",
  assistant: "Say what you want in your own words and watch each order move through the company.",
  projects: "Every project, grouped by department, with what it is working on right now.",
  terminals: "Every open terminal, what it is doing, and a box to talk to it.",
  fleet: "Big multi-part jobs: the plan, the workers, the review and the result.",
  flow: "One order's journey, step by step, from your request to the result.",
  office: "The whole team at their desks, and who is working right now.",
  system: "Shut the company down safely and start it again where it left off.",
  budget: "What is really left at each provider, when it resets, and what the company is doing about it.",
};

/* Phones show the first 4 nav items in the bottom bar; the rest go under
 * "More" (CEO order: "the phone bottom bar shows the top 4"). */
const NAV_MORE_AFTER = 4;

function parseQuery(q) {
  const out = {};
  if (!q) return out;
  for (const part of q.split("&")) {
    if (!part) continue;
    const i = part.indexOf("=");
    const k = i < 0 ? part : part.slice(0, i);
    let v = i < 0 ? "" : part.slice(i + 1);
    try {
      v = decodeURIComponent(v.replace(/\+/g, " "));
    } catch {
      /* keep raw */
    }
    try {
      out[decodeURIComponent(k)] = v;
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/** hash -> { key, name, params, path, known } */
function resolve(hash) {
  let h = String(hash || "").replace(/^#/, "");
  if (h.endsWith("/") && h.length > 1) h = h.slice(0, -1);
  if (!h || h === "/") h = DEFAULT_ROUTE;

  const qi = h.indexOf("?");
  const pathPart = qi >= 0 ? h.slice(0, qi) : h;
  const query = parseQuery(qi >= 0 ? h.slice(qi + 1) : "");

  const segs = pathPart.split("/").filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });

  const name = segs[0] || "assistant";
  const params = { ...query, query };
  // Any route with a second path segment exposes it both specifically and as the
  // generic `id`, so a view never sees `undefined` for `#/<view>/<x>`.
  if (segs[1]) {
    params.segment = segs[1];
    params.id = segs[1];
  }
  params.segments = segs.slice(1);
  if (name === "projects" && segs[1]) {
    params.projectId = segs[1]; // alias, so a view may use either name
  }
  if (name === "flow" && segs[1]) {
    params.taskId = segs[1];
  }
  if (name === "fleet" && segs[1]) {
    params.orderId = segs[1];
  }
  if (name === "terminals" && segs[1]) {
    params.sessionId = segs[1];
  }

  const known = VIEWS.some((v) => v.name === name);
  return {
    key: "/" + segs.join("/") || "/",
    name,
    params,
    path: "#/" + segs.join("/") + (qi >= 0 ? h.slice(qi) : ""),
    hash: "#" + (pathPart || "/") + (qi >= 0 ? h.slice(qi) : ""),
    known,
  };
}

export function navigate(to) {
  const t = String(to || "").trim();
  const hash = t.startsWith("#") ? t : "#/" + t.replace(/^\/+/, "");
  if (location.hash === hash) {
    render();
    return;
  }
  location.hash = hash; // triggers hashchange -> render()
}

/* ================================================================== *
 * Nav
 * ================================================================== */
/* PERF-UI: current badge values, merged by setBadges. `needs` is the CEO
 * briefing's needsYou count (UI-CLEAN owns the nav item that shows it). */
const badgeState = { running: null, inflight: null, projects: null, needs: null };
function makeNavLink(v) {
  const a = document.createElement("a");
  a.className = "nav-link";
  a.href = "#/" + v.name;
  a.dataset.view = v.name;
  a.innerHTML =
    `<span class="ico" aria-hidden="true">${esc(v.icon)}</span>` +
    `<span class="lbl">${esc(v.label)}</span>` +
    (v.badge ? `<span class="nav-badge" data-badge="${esc(v.badge)}" hidden></span>` : "");
  return a;
}

VIEWS.forEach((v, i) => {
  const a = makeNavLink(v);
  // Phones fit 4 items; the rest are hidden there and listed under "More".
  if (i >= NAV_MORE_AFTER) a.classList.add("deep");
  $navlinks.appendChild(a);
});

/* Phone only: a "More" item that opens the remaining four as a small sheet. */
const moreBtn = document.createElement("button");
moreBtn.type = "button";
moreBtn.id = "navmore";
moreBtn.className = "nav-link nav-more-btn";
moreBtn.setAttribute("aria-expanded", "false");
moreBtn.innerHTML = `<span class="ico" aria-hidden="true">⋯</span><span class="lbl">More</span>`;

const morePanel = document.createElement("div");
morePanel.id = "navmorepanel";
morePanel.className = "nav-more-panel";
for (const v of VIEWS.slice(NAV_MORE_AFTER)) morePanel.appendChild(makeNavLink(v));

function closeMore() {
  morePanel.classList.remove("is-open");
  moreBtn.setAttribute("aria-expanded", "false");
}
moreBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const open = morePanel.classList.toggle("is-open");
  moreBtn.setAttribute("aria-expanded", open ? "true" : "false");
});
morePanel.addEventListener("click", () => closeMore());
document.addEventListener("click", (e) => {
  if (!morePanel.classList.contains("is-open")) return;
  if (morePanel.contains(e.target) || moreBtn.contains(e.target)) return;
  closeMore();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMore();
});

$navlinks.appendChild(moreBtn);
// Inside #navlinks so the shell's existing badge pass (.nav-badge[data-badge])
// reaches the copies; it is position:fixed on phones, so it does not sit in the row.
$navlinks.appendChild(morePanel);

/** Nav labels may be overridden by the view's own exported `title`. */
function setNavLabel(name, label) {
  if (!label) return;
  for (const el of document.querySelectorAll(`.nav-link[data-view="${name}"] .lbl`)) {
    el.textContent = label;
  }
}

function setActiveNav(name) {
  // cover both the sidebar/bar links and the copies inside the "More" sheet
  for (const a of document.querySelectorAll(".nav-link[data-view]")) {
    if (a.dataset.view === name) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
}

function setBadges(patch) {
  // Merge, not replace: a caller that only knows some of the counts (loadOrg
  // knows `projects`) must not blank the badges it did not mention.
  if (patch) for (const k of Object.keys(patch)) badgeState[k] = patch[k];
  for (const el of $navlinks.querySelectorAll(".nav-badge")) {
    const kind = el.dataset.badge;
    const n = badgeState[kind];
    if (n === null || n === undefined) {
      el.textContent = "";
      el.hidden = true;
      continue;
    }
    el.hidden = false;
    el.textContent = String(n);
    el.classList.toggle(
      "hot",
      Number(n) > 0 && (kind === "inflight" || kind === "running" || kind === "needs"),
    );
  }
}

/* ================================================================== *
 * View loading
 * ================================================================== */
let stamp = Date.now().toString(36); // fresh URL each page load: no stale views
let bust = 0; // bumped by the Retry buttons
let token = 0; // render generation, so a slow import cannot clobber a newer route
let cleanupCurrent = null;

function viewUrl(name) {
  return `./views/${name}.js?v=${stamp}.${bust}`;
}

function retryButton(label = "Retry") {
  return `<button class="btn btn-primary" data-act="retry">${esc(label)}</button>`;
}

function card(inner, extraClass = "") {
  return `<div class="card ${extraClass}">${inner}</div>`;
}

function showState(inner, extraClass = "", retry = false) {
  $view.innerHTML = card(`<div class="state ${extraClass}">${inner}</div>`, extraClass);
  if (retry) {
    const b = $view.querySelector('[data-act="retry"]');
    if (b) b.addEventListener("click", () => {
      bust += 1;
      render();
    });
  }
}

function showLoading(route) {
  const label = viewLabel(route.name);
  showState(
    `<span class="spinner" aria-hidden="true"></span>` +
      `<span>loading ${esc(label)}…</span>`,
  );
}

function viewLabel(name) {
  const v = VIEWS.find((x) => x.name === name);
  return v ? v.label : name;
}

function showNotBuilt(route, detail) {
  const name = route.name;
  const label = viewLabel(name);
  showState(
    `<span class="state-title">${esc(label)} view not built yet</span>` +
      `<span class="muted">The shell is ready; <span class="mono">public/v2/views/${esc(name)}.js</span> ` +
      `does not exist yet. Another session is building it right now.</span>` +
      (detail
        ? `<span class="tiny mono muted wrap-any">${esc(detail)}</span>`
        : "") +
      `<div class="row" style="justify-content:center;margin-top:4px">` +
      retryButton("Check again") +
      `<a class="btn" href="/">old dashboard</a>` +
      `</div>`,
    "notbuilt",
    true,
  );
}

function showViewError(route, err) {
  const name = route.name;
  const msg = (err && (err.message || err.toString())) || "unknown error";
  showState(
    `<span class="state-title">${esc(viewLabel(name))} view failed to load</span>` +
      `<span class="muted wrap-any">${esc(msg)}</span>` +
      `<span class="tiny muted mono">${esc(viewUrl(name))}</span>` +
      `<div class="row" style="justify-content:center;margin-top:4px">` +
      retryButton() +
      `<a class="btn" href="/">old dashboard</a>` +
      `</div>`,
    "state-error",
    true,
  );
}

function showNotFound(route) {
  const links = VIEWS.map(
    (v) => `<a class="btn btn-sm" href="#/${esc(v.name)}">${esc(v.label)}</a>`,
  ).join(" ");
  showState(
    `<span class="state-title">No such view: ${esc(route.hash)}</span>` +
      `<span class="muted">Routes are hash based. Pick one:</span>` +
      `<div class="row" style="justify-content:center">${links}</div>`,
    "",
    false,
  );
}

async function loadView(name) {
  const url = viewUrl(name);
  try {
    return await import(url);
  } catch (err) {
    // Distinguish "the file does not exist yet" (the expected state while other
    // sessions are still writing views) from a real load error in a view that
    // does exist (syntax error, wrong MIME type, router down).
    let missing = false;
    try {
      const r = await fetch(url, { method: "HEAD", cache: "no-store" });
      missing = r.status === 404;
    } catch {
      missing = false; // network failure: report it as an error, not "missing"
    }
    if (missing) {
      const e = new Error(
        "public/v2/views/" + name + ".js -> the server answered 404 (file not created yet)",
      );
      e.missing = true;
      throw e;
    }
    throw err;
  }
}

async function render() {
  const route = resolve(location.hash);
  const job = ++token;

  if (cleanupCurrent) {
    try {
      cleanupCurrent();
    } catch (e) {
      console.warn("[v2] view cleanup failed:", e);
    }
    cleanupCurrent = null;
  }

  setActiveNav(route.known ? route.name : null);
  paintTitle(`${route.known ? viewLabel(route.name) : "Not found"} — CEO Dashboard v2`);

  if (!route.known) {
    showNotFound(route);
    return;
  }

  // Already loaded during this page session? Then mount straight away.
  showLoading(route);

  let mod;
  try {
    mod = await loadView(route.name);
  } catch (e) {
    if (job !== token) return; // a newer navigation won
    if (e && e.missing) showNotBuilt(route, e.message);
    else showViewError(route, e);
    return;
  }
  if (job !== token) return;

  if (!mod || typeof mod.mount !== "function") {
    showViewError(route, new Error(`views/${route.name}.js does not export mount(el, ctx)`));
    return;
  }
  if (typeof mod.title === "string" && mod.title.trim()) {
    setNavLabel(route.name, mod.title);
    paintTitle(`${mod.title} — CEO Dashboard v2`);
  }

  /* Every page opens the same way (CEO order): a clear title, then one plain
   * sentence saying what the page is for. The view may export `goal`; otherwise
   * the route's default sentence is used, so no page is ever titleless. */
  const head = document.createElement("div");
  head.className = "page-head";
  head.id = "page-head";
  const headTxt = document.createElement("div");
  headTxt.className = "grow";
  const titleEl = document.createElement("h1");
  titleEl.className = "page-title";
  titleEl.id = "page-title";
  titleEl.textContent = (typeof mod.title === "string" && mod.title.trim()) || viewLabel(route.name);
  headTxt.appendChild(titleEl);
  const goal = (typeof mod.goal === "string" && mod.goal.trim()) || GOALS[route.name] || "";
  if (goal) {
    const goalEl = document.createElement("div");
    goalEl.className = "page-goal";
    goalEl.id = "page-goal";
    goalEl.textContent = goal;
    headTxt.appendChild(goalEl);
  }
  head.appendChild(headTxt);

  // Views mount into their own body element, so the header survives whatever
  // they render. It is still a plain flex column, exactly like #appview was,
  // so a view that appends cards keeps working unchanged.
  $view.innerHTML = "";
  $view.appendChild(head);
  const el = document.createElement("div");
  el.className = "view-body";
  $view.appendChild(el);

  const ctx = {
    api,
    poll,
    esc,
    ago,
    hm,
    navigate,
    params: route.params,
    route: { name: route.name, path: route.path, hash: location.hash, key: route.key },
    // additive extras (announced in docs/AGENT_COORDINATION.md and style.css)
    usd,
    dur,
    trunc,
    statusTone,
    IN_MOTION,
    TERMINAL,
    // PERF-UI (docs/PERF_SPEC.md): last cached answer for a GET path, so a view
    // can paint immediately, and the store counters (debug/verification).
    peekData,
    storeInfo,
    companyRoot: location.origin,
  };

  try {
    const c = mod.mount(el, ctx);
    cleanupCurrent = typeof c === "function" ? c : null;
  } catch (e) {
    console.error("[v2] view mount threw:", e);
    if (job !== token) return;
    showViewError(route, e);
  }
}

/* ================================================================== *
 * Top bar: company, live counts, connection indicator, theme
 * ================================================================== */
/* shell-level state, also read by the views (window event below) */
const stats = { lastSync: null, projects: null };
let baseTitle = "CEO Dashboard v2";

const conn = document.createElement("button");
conn.type = "button";
conn.className = "conn is-connecting";
conn.id = "conn";
conn.title = "Click to re-check the router";
conn.innerHTML = `<span class="dot" aria-hidden="true"></span><span id="conn-text">connecting…</span>`;

const themeBtn = document.createElement("button");
themeBtn.type = "button";
themeBtn.className = "btn btn-sm btn-ghost";
themeBtn.title = "Switch light/dark theme";

function applyTheme(t) {
  const theme = t === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", theme);
  themeBtn.textContent = theme === "light" ? "☀" : "☾";
  try {
    localStorage.setItem("v2.theme", theme);
  } catch {
    /* private mode */
  }
}
applyTheme(document.documentElement.getAttribute("data-theme") || "dark");
themeBtn.addEventListener("click", () => {
  applyTheme(document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light");
});

/* Top bar = exactly three numbers (CEO order relayed by UI-CLEAN 14:19Z, who
 * owns its markup/labels): working now, needs you, done today. The budget
 * "spend" number moved off the bar, so the shell no longer fetches
 * /company/budgets at all. Each .stat keeps the <b>value + trailing <span>
 * label shape that style.css and UI-CLEAN rely on. */
const statEls = {
  working: mkStat("working now", "agent sessions running right now"),
  needs: mkStat("needs you", "briefing items waiting for your decision"),
  done: mkStat("done today", "tasks the company finished today"),
};
function mkStat(label, title) {
  const el = document.createElement("span");
  el.className = "stat";
  el.title = title;
  el.innerHTML = `<b>–</b><span>${esc(label)}</span>`;
  return el;
}

$stats.appendChild(statEls.working);
$stats.appendChild(statEls.needs);
$stats.appendChild(statEls.done);

/* ------------------------------------------------------------------ *
 * BUDGET chip (docs/BUDGET_SPEC.md §3, built by the BUDGET session)
 *
 * ONE small chip, not two: "Go 35% · Claude 0%", coloured by the binding
 * provider level, and clicking it opens #/budget. UI-CLEAN owns this file -
 * this block is additive, self-contained and the only contract is the element
 * id `#budget-chip`; move or restyle it freely. It never fakes a number: a
 * missing route or an unreachable router shows "budget -" and says why.
 * ------------------------------------------------------------------ */
const budgetChip = document.createElement("a");
budgetChip.id = "budget-chip";
budgetChip.className = "pill pill-dim";
budgetChip.href = "#/budget";
budgetChip.title = "Real provider budget: OpenCode Go and Claude";
budgetChip.textContent = "budget -";
$stats.appendChild(budgetChip);

const BUDGET_LEVEL_PILL = { green: "pill pill-ok", amber: "pill pill-warn", red: "pill pill-err", unknown: "pill pill-dim" };

function worstBudgetLevel(levels) {
  const g = levels && levels.go;
  const c = levels && levels.claude;
  if (g === "red" || c === "red") return "red";
  if (g === "amber" || c === "amber") return "amber";
  if (!g || !c || g === "unknown" || c === "unknown") return "unknown";
  return "green";
}

async function loadBudgetChip() {
  try {
    const b = await api("/company/budget?lite=1");
    const p = b && b.providers;
    if (!p || !b.levels) throw new Error("no budget measurement yet");
    const part = (v, label) => (v && typeof v.remainingPct === "number" ? `${label} ${Math.round(v.remainingPct)}%` : `${label} -`);
    budgetChip.textContent = `${part(p.go, "Go")} · ${part(p.claude, "Claude")}`;
    const level = worstBudgetLevel(b.levels);
    budgetChip.className = BUDGET_LEVEL_PILL[level] || "pill pill-dim";
    const bits = [];
    if (p.go && p.go.resetsIn) bits.push(`Go resets in ${p.go.resetsIn}`);
    if (p.claude && p.claude.resetsIn) bits.push(`Claude resets in ${p.claude.resetsIn}`);
    budgetChip.title = `${level.toUpperCase()} - click for the budget page${bits.length ? " (" + bits.join(", ") + ")" : ""}`;
  } catch (e) {
    budgetChip.textContent = "budget -";
    budgetChip.className = "pill pill-dim";
    budgetChip.title =
      e && e.status === 404
        ? "the budget feed arrives with the next router restart (GET /company/budget)"
        : "budget feed unreachable: " + (e && e.message ? e.message : e);
  }
}

loadBudgetChip();
// The snapshot behind it is refreshed every BUDGET_POLL_S (300 s) on the router,
// so 60 s is plenty and stays trivial for the event loop.
setInterval(() => {
  if (!document.hidden) loadBudgetChip();
}, 60000);
$stats.appendChild(themeBtn);
$stats.appendChild(conn);

/* The one dangerous action, always in the same corner (CEO order). SHUTDOWN
 * (dove) owns #/system, the confirm dialog and the POST; the shell only links
 * there, so a stray click can never shut the company down by itself. */
const shutBtn = document.createElement("a");
shutBtn.className = "btn btn-sm btn-danger";
shutBtn.id = "shutdown";
shutBtn.href = "#/system";
shutBtn.title = "Shut the whole company down safely - each terminal saves a checkpoint first";
shutBtn.innerHTML = `<span aria-hidden="true">⏻</span> Shut down`;
$stats.appendChild(shutBtn);

let online = null; // null = unknown (first check pending)

/** The tab title carries the ⚠ marker while the router is unreachable. */
function paintTitle(base) {
  if (base) baseTitle = base;
  document.title = (online === false ? "⚠ " : "") + baseTitle;
}

function setStat(el, value, suffix) {
  el.querySelector("b").textContent = value;
  const lbl = el.querySelector("span:last-child");
  if (lbl && suffix) lbl.textContent = suffix;
  el.dataset.stale = online === false ? "1" : "0";
}

function setOnline(isOnline, note) {
  if (online === isOnline && !note) return;
  const first = online === null;
  online = isOnline;
  document.documentElement.classList.toggle("is-offline", !isOnline);

  const text = conn.querySelector("#conn-text");
  conn.classList.toggle("is-live", isOnline);
  conn.classList.toggle("is-down", !isOnline);
  conn.classList.remove("is-connecting");
  const last = stats.lastSync ? ago(stats.lastSync) : "";
  text.textContent = isOnline ? "live" : "reconnecting";
  conn.title = isOnline
    ? `Router reachable on ${location.host}${last ? " · last sync " + last : ""}`
    : `Router unreachable${note ? " (" + note + ")" : ""} — click to re-check`;

  for (const el of Object.values(statEls)) el.dataset.stale = isOnline ? "0" : "1";
  paintTitle();

  window.dispatchEvent(new CustomEvent("company:connection", { detail: { online: isOnline, first } }));
}

/* company name + project count (cached so the header paints instantly) */
function paintCompany(name) {
  if (name) $company.textContent = name;
}
try {
  const cached = localStorage.getItem("v2.company");
  if (cached) paintCompany(cached);
} catch {
  /* ignore */
}

/* CEO top-bar numbers from the briefing (UI-CLEAN, 14:19Z). null = "no
 * answer", which the bar renders as "–" and which must NOT look like an
 * outage: /company/briefing missing or erroring is caught locally. */
function briefingNeeds(b) {
  return b && Array.isArray(b.needsYou) ? b.needsYou.length : null;
}
function briefingDone(b) {
  const n = b && b.counts ? Number(b.counts.done) : NaN;
  return Number.isFinite(n) ? n : null;
}
const DASH = "\u2013";

async function loadStats() {
  // PERF: while the heartbeat says the router is unreachable, do not pile more
  // requests on it - the heartbeat's own backoff owns recovery, and it calls
  // loadStats() again the moment the router answers.
  if (online === false) return false;
  try {
    // PERF: /company/budgets is gone from this cycle (the spend number left the
    // top bar), so the shell makes one request fewer every 15 s. The briefing
    // GET is the CEO's "needs you"/"done today" source and is cached/shared
    // with the Briefing view's own 20 s poll.
    const [sessions, flow, briefing] = await Promise.all([
      api("/company/sessions"),
      api("/company/flow?limit=30"),
      api("/company/briefing").catch(() => null), // missing/404 is not an outage
    ]);
    stats.lastSync = new Date().toISOString();

    const running = Number(sessions && sessions.running) || 0;
    const tasks = Array.isArray(flow && flow.tasks) ? flow.tasks : [];
    const inflight = tasks.filter((t) => IN_MOTION.includes(t.status)).length;
    const needs = briefingNeeds(briefing);
    const done = briefingDone(briefing);

    setStat(statEls.working, String(running), "working now");
    setStat(statEls.needs, needs === null ? DASH : String(needs), "needs you");
    setStat(statEls.done, done === null ? DASH : String(done), "done today");

    setBadges({
      running,
      inflight,
      projects: stats.projects,
      needs: needs === null ? null : needs,
    });
    if (online === false) setOnline(true);
    return true;
  } catch (e) {
    // The heartbeat owns the connection indicator; here we only stop showing
    // stale numbers as if they were fresh.
    for (const el of Object.values(statEls)) el.dataset.stale = "1";
    return false;
  }
}

async function loadOrg() {
  try {
    const org = await api("/company/org");
    if (org && org.name) {
      paintCompany(org.name);
      try {
        localStorage.setItem("v2.company", org.name);
      } catch {
        /* ignore */
      }
    }
    const projects = Array.isArray(org && org.projects) ? org.projects.length : null;
    stats.projects = projects;
    setBadges({ projects }); // merge: the other badges keep their own values
  } catch {
    /* the heartbeat reports connection problems */
  }
}

/* ------------------------------------------------------------------ *
 * Instant paint from the shared store (docs/PERF_SPEC.md item 4)
 *
 * api.js mirrors every small GET answer into sessionStorage, so a fresh page
 * load can show the real company name and real numbers in the first frame and
 * let the polls correct them, instead of showing "–" until the router answers
 * (which is exactly what took 2-12 s when the event loop was blocked).
 * Cached values older than 30 s are painted dimmed via data-stale so nobody
 * mistakes them for freshly verified numbers.
 * ------------------------------------------------------------------ */
const CACHE_PAINT_STALE_MS = 30000;

function paintFromCache() {
  try {
    const sessions = peekData("/company/sessions");
    const flow = peekData("/company/flow?limit=30");
    const briefing = peekData("/company/briefing");
    const org = peekData("/company/org");
    const hits = [sessions, flow, briefing].filter(Boolean);
    if (hits.length) {
      const age = Math.max(...hits.map((h) => h.ageMs));
      const running = Number(sessions && sessions.data && sessions.data.running) || 0;
      const tasks = flow && flow.data && Array.isArray(flow.data.tasks) ? flow.data.tasks : [];
      const inflight = tasks.filter((t) => IN_MOTION.includes(t.status)).length;
      const needs = briefingNeeds(briefing && briefing.data);
      const done = briefingDone(briefing && briefing.data);

      setStat(statEls.working, String(running), "working now");
      setStat(statEls.needs, needs === null ? DASH : String(needs), "needs you");
      setStat(statEls.done, done === null ? DASH : String(done), "done today");
      if (org && org.data && Array.isArray(org.data.projects)) stats.projects = org.data.projects.length;
      setBadges({
        running,
        inflight,
        projects: stats.projects,
        needs: needs === null ? null : needs,
      });

      if (age > CACHE_PAINT_STALE_MS) {
        for (const el of Object.values(statEls)) el.dataset.stale = "1";
      }
      stats.lastSync = new Date(Date.now() - age).toISOString();
    }
    if (org && org.data && org.data.name) paintCompany(org.data.name);
  } catch (e) {
    console.warn("[v2] cache paint skipped:", e);
  }
}

async function heartbeat() {
  try {
    const r = await fetch("/health", { cache: "no-store" });
    if (!r.ok) {
      setOnline(false, "HTTP " + r.status);
      return false;
    }
    if (online !== true) {
      setOnline(true);
      loadStats();
    }
    return true;
  } catch (e) {
    setOnline(false, "no response from " + location.host);
    return false;
  }
}

conn.addEventListener("click", () => {
  heartbeat();
  loadStats();
});
window.addEventListener("online", () => heartbeat());

/* ================================================================== *
 * Boot
 * ================================================================== */
window.addEventListener("hashchange", render);
window.addEventListener("pagehide", () => {
  if (cleanupCurrent) {
    try {
      cleanupCurrent();
    } catch {
      /* ignore */
    }
  }
});

/* PERF (docs/PERF_SPEC.md item 2): heartbeat 15 s (was 4 s) and the top-bar
 * stats 15 s (was 6 s), both with exponential backoff on failure/slowness; the
 * shell never overlaps its own requests and both paths are served from the
 * shared store whenever a view already asked for the same data. */
paintFromCache(); // item 4: real numbers in the first frame when we have them
poll(heartbeat, 15000, { maxMs: 120000 });
poll(loadStats, 15000, { maxMs: 120000 });
poll(loadOrg, 60000);
loadOrg();
render();
