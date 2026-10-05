/* UI-PROJECTS — Projects view (public/v2/views/projects.js)
 *
 * Routes:  #/projects       -> every project, grouped by department
 *          #/projects/:id   -> one project: what it is, tasks, thread, cost, team
 *
 * Contract (docs/UI_V2_SPEC.md): mount(el, ctx) where
 *   ctx = { api, poll, esc, ago, hm, navigate, params }
 * Classes come only from public/v2/style.css (UI-SHELL owns that file).
 *
 * Data (all read-only GETs, shapes verified against src/server.ts on 2026-09-29):
 *   GET /company/panel                    -> projects[projectSummary], departments[], visual, sessions.items[]
 *   GET /company/projects/:id             -> ProjectDef {id,name,description,departmentId,rootDir,teams,status}
 *   GET /company/projects/:id/tasks       -> TaskRec[]
 *   GET /company/projects/:id/thread      -> [{ts,agent,role,kind,text}]
 *   GET /company/projects/:id/cost        -> {totalUsd, events:[{ts,modelId,costUsd,note}]}
 *   GET /company/agents                   -> agents[] (agentId, agentKey, status, running, budget)
 *   GET /company/sessions                 -> {items: SessionRec[]}
 *
 * The only mutation is the "Resume" button on a failed task: POST
 * /company/projects/:id/run {taskId, auto:true} (same call public/index.html makes).
 */

export const title = "Projects";

/* Task lifecycle, in pipeline order (src/company/gates.ts TaskStatus).
   The shell also exports IN_MOTION/TERMINAL via ctx; these are the view's own
   fallback so it renders correctly even if those extras are absent. */
const STATUS_ORDER = [
  "pending_intake", "enhancing", "planned", "pending_code", "coding",
  "testing", "opposing", "summarizing", "adjudicating", "pending_merge",
  "merged", "rejected", "failed",
];
const GATE_STATUSES = ["pending_intake", "pending_code", "pending_merge"];
const TERMINAL = ["merged", "rejected", "failed"];

const POLL_MS = 10000; // PERF: list refresh (was 5 s) - this is the heaviest view
const DETAIL_POLL_MS = 8000; // PERF: detail refresh (was 5 s) - six endpoints per tick

/* PERF (docs/PERF_SPEC.md item 3, PERF-UI): the list used to fetch the whole
 * /company/panel - measured 1.49 MB / 12.2 s on the live router. It now asks
 * for the trimmed payload PERF-BACKEND is adding; the query parameter is
 * harmless when the backend does not know it yet (the full answer comes back
 * and api.js still dedupes/caches it), and this view never requests the bare
 * panel. Fields this view relies on from the lite answer, for coordination in
 * docs/AGENT_COORDINATION.md: departments[], projects[].{id,name,description,
 * status,departmentId,tasks,teams,budget} and sessions.items[].{projectId,
 * agentId,status} - the output tails / threads / cost / gates may all be
 * dropped. */
const PANEL_LITE = "/company/panel?lite=1";
let warnedNoLite = false;
const THREAD_ROWS = 20;
const TASK_ROWS = 60;

/* ── small helpers ────────────────────────────────────────────────────── */

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function clip(s, n) {
  const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "\u2026" : t;
}

function isoOf(v) {
  if (!v) return "";
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? "" : d.toISOString();
}

function timeOf(v) {
  const i = isoOf(v);
  return i ? new Date(i).getTime() : 0;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.round(n)) : "0";
}

function usd(v) {
  const n = Number(v);
  return "$" + (Number.isFinite(n) ? n : 0).toFixed(2);
}

function share(part, whole) {
  const p = Number(part), w = Number(whole);
  if (!Number.isFinite(p) || !Number.isFinite(w) || w <= 0) return 0;
  return Math.max(0, Math.min(100, (p / w) * 100));
}

function projectIdFromCtx(ctx) {
  const p = ctx && ctx.params;
  if (typeof p === "string" && p) return p;
  if (p && typeof p === "object") {
    if (typeof p.id === "string" && p.id) return p.id;
    if (!Array.isArray(p) && typeof p.projectId === "string" && p.projectId) return p.projectId;
    if (Array.isArray(p) && typeof p[0] === "string" && p[0]) return p[0];
  }
  const hash = (typeof location !== "undefined" && location.hash) || "";
  const m = /^#\/projects\/([^/?#]+)/.exec(hash);
  return m ? decodeURIComponent(m[1]) : "";
}

/* status -> pill class. merged ok, failed/rejected err, gates warn,
   in-flight run, anything unrecognised dim. */
function statusPill(status) {
  const s = String(status || "unknown");
  if (s === "merged") return "pill pill-ok";
  if (s === "failed" || s === "rejected") return "pill pill-err";
  if (GATE_STATUSES.includes(s)) return "pill pill-warn";
  if (TERMINAL.includes(s)) return "pill pill-dim";
  if (STATUS_ORDER.includes(s)) return "pill pill-run";
  return "pill pill-dim";
}

function projectPill(status) {
  const s = String(status || "active");
  if (s === "active") return "pill pill-ok";
  if (s === "paused") return "pill pill-warn";
  return "pill pill-dim";
}

function statusLabel(status) {
  return String(status || "unknown").replace(/_/g, " ");
}

function taskCounts(tasks) {
  const by = {};
  for (const t of asArray(tasks)) {
    const s = String((t && t.status) || "unknown");
    by[s] = (by[s] || 0) + 1;
  }
  const rows = STATUS_ORDER.filter((s) => by[s]).map((s) => [s, by[s]]);
  for (const s of Object.keys(by).filter((k) => !STATUS_ORDER.includes(k)).sort()) rows.push([s, by[s]]);
  return { by, rows, total: asArray(tasks).length };
}

function inFlightCount(tasks) {
  return asArray(tasks).filter((t) => t && !TERMINAL.includes(t.status)).length;
}

function lastActivity(project) {
  let best = 0, bestIso = "";
  const consider = (v) => {
    const t = timeOf(v);
    if (t > best) { best = t; bestIso = isoOf(v); }
  };
  for (const t of asArray(project && project.tasks)) consider(t.updatedAt || t.createdAt);
  for (const e of asArray(project && project.thread)) consider(e.ts);
  for (const e of asArray(project && project.cost && project.cost.events)) consider(e.ts);
  return bestIso;
}

function runningSessions(panel, projectId) {
  return asArray(panel && panel.sessions && panel.sessions.items)
    .filter((s) => s && s.projectId === projectId && s.status === "running");
}

/* ── DOM builders ─────────────────────────────────────────────────────── */

function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
}

function pill(cls, text, title) {
  const n = node("span", cls, text);
  if (title) n.title = String(title);
  return n;
}

function link(ctx, hash, text, cls) {
  const a = node("a", cls, text);
  a.href = hash;
  if (typeof ctx.navigate === "function") {
    a.addEventListener("click", (ev) => {
      if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      ev.preventDefault();
      ctx.navigate(hash);
    });
  }
  return a;
}

function card(cls) {
  return node("div", "card" + (cls ? " " + cls : ""));
}

function cardHead(title, cls) {
  const head = node("div", "card-head");
  head.appendChild(node(cls || "h3", null, title));
  return head;
}

function kpi(value, label) {
  const k = node("div", "kpi");
  k.appendChild(node("div", "kpi-val", value));
  k.appendChild(node("div", "kpi-lbl", label));
  return k;
}

function bar(value, whole, tone) {
  const b = node("div", "bar");
  b.title = num(value) + " of " + num(whole);
  const fill = node("div", "bar-fill" + (tone ? " sev-" + tone : ""));
  fill.style.width = share(value, whole).toFixed(1) + "%";
  b.appendChild(fill);
  return b;
}

function stateCard(kind, titleText, bodyText, extra) {
  const c = card();
  c.setAttribute("data-state", kind);
  const s = node("div", "state" + (kind === "error" ? " state-error" : ""));
  if (kind === "loading") s.appendChild(node("span", "spinner"));
  s.appendChild(node("div", "state-title", titleText));
  if (bodyText) s.appendChild(node("div", "small", bodyText));
  if (extra) s.appendChild(extra);
  c.appendChild(s);
  return c;
}

/* ── list view ────────────────────────────────────────────────────────── */

/* MODEL ROLES (docs/PROJECT_TEAM_SPEC.md): one optional model override per role.
   A blank field means "use the global rule" - it is simply not sent. */
const MODEL_ROLES = ["manager", "coder", "tester", "opposer"];

/* Team-config API paths. Source: docs/PROJECT_TEAM_SPEC.md '## Final routes'.
   BACKEND has landed these in src/server.ts (verified by reading the file during
   this task): POST /company/departments, POST /company/projects (accepts name,
   department, team {coders, models}), PATCH /company/projects/:id/team. */
const API_DEPT_CREATE = "/company/departments";       // POST {name}
const API_PROJECT_CREATE = "/company/projects";       // POST {name, department, team?}
const API_PROJECT_TEAM = (id) =>
  "/company/projects/" + encodeURIComponent(id) + "/team"; // PATCH {coders?, models?}

function teamOf(project) {
  const t = project && (project.team !== undefined ? project.team : project.projectTeam);
  return t && typeof t === "object" && !Array.isArray(t) ? t : null;
}

function teamLine(project) {
  const t = teamOf(project);
  if (!t) return "default";
  const bits = [];
  if (Number(t.coders) > 0) bits.push(num(t.coders) + (Number(t.coders) === 1 ? " coder" : " coders"));
  const m = t.models && typeof t.models === "object" ? t.models : {};
  for (const role of MODEL_ROLES) if (m[role]) bits.push(role + "=" + String(m[role]));
  return bits.length ? bits.join(" \u00b7 ") : "default";
}

/* Inline error text for a form. Renders the server's HTTP 400 {error} verbatim
   (no decoration) and clears on the next submit. */
function formError() {
  const n = node("div", "small", "");
  n.setAttribute("data-role", "form-error");
  n.className = "small";
  n.style.color = "var(--err, #e5484d)";
  n.hidden = true;
  return n;
}

function setFormError(form, e) {
  const target = form.querySelector('[data-role="form-error"]');
  if (!target) return;
  target.textContent = e ? ((e && e.message) ? String(e.message) : String(e)) : "";
  target.hidden = !e;
}

/* Submit helper: parse the JSON answer (api() already throws Error with .status
   and usually .message from the {error} body), then call back or surface it. */
async function submitForm(form, run, onDone) {
  const btn = form.querySelector("button[type=submit]");
  setFormError(form, null);
  if (btn) btn.disabled = true;
  try {
    await run();
    if (typeof onDone === "function") await onDone();
  } catch (e) {
    setFormError(form, e);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function field(label, input) {
  const row = node("label", "col");
  row.style.gap = "3px";
  row.appendChild(node("span", "tiny muted", label));
  row.appendChild(input);
  return row;
}

function textInput(placeholder, attrs) {
  const i = node("input", null, "");
  i.type = "text";
  if (placeholder) i.placeholder = String(placeholder);
  for (const k of Object.keys(attrs || {})) i.setAttribute(k, attrs[k]);
  return i;
}

/* ── create department ── */

function departmentForm(ctx, onDone) {
  const c = card();
  c.setAttribute("data-form", "create-department");
  c.appendChild(cardHead("New department", "h3"));
  const form = node("form", "row");
  form.style.gap = "8px";
  form.style.alignItems = "flex-end";
  const name = textInput("Department name", { "data-field": "name", required: "" });
  form.appendChild(field("Name", name));
  const btn = node("button", "btn btn-primary", "Create department");
  btn.type = "submit";
  form.appendChild(btn);
  form.appendChild(formError());
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    submitForm(form, async () => {
      await api(API_DEPT_CREATE, { method: "POST", body: { name: name.value.trim() } });
      name.value = "";
    }, onDone);
  });
  c.appendChild(form);
  return c;
}

/* ── create project ── */

function projectForm(ctx, departments, onDone) {
  const c = card();
  c.setAttribute("data-form", "create-project");
  c.appendChild(cardHead("New project", "h3"));
  const form = node("form", "col");
  form.style.gap = "8px";

  const grid = node("div", "row");
  grid.style.gap = "8px";
  grid.style.alignItems = "flex-end";
  grid.style.flexWrap = "wrap";
  const name = textInput("Project name", { "data-field": "name", required: "" });
  const dept = node("select");
  dept.setAttribute("data-field", "department");
  const deptOpts = asArray(departments);
  const blank = node("option", null, "(no department)");
  blank.value = "";
  dept.appendChild(blank);
  for (const d of deptOpts) {
    const o = node("option", null, d.name || d.id);
    o.value = String(d.id || "");
    dept.appendChild(o);
  }
  if (!deptOpts.length) dept.disabled = true;
  const coders = textInput("", { "data-field": "coders", type: "number", min: "1", max: "6", step: "1", value: "2" });
  coders.type = "number";
  grid.appendChild(field("Name", name));
  grid.appendChild(field("Department", dept));
  grid.appendChild(field("Coders (1-6)", coders));
  form.appendChild(grid);

  form.appendChild(node("div", "tiny muted",
    "Optional model per role (model id). Leave blank to use the company default."));
  const roles = node("div", "row");
  roles.style.gap = "8px";
  roles.style.flexWrap = "wrap";
  for (const role of MODEL_ROLES) {
    const inp = textInput("model id", { "data-field": "model-" + role });
    roles.appendChild(field("Model: " + role, inp));
  }
  form.appendChild(roles);

  const btnRow = node("div", "row");
  btnRow.style.gap = "8px";
  const btn = node("button", "btn btn-primary", "Create project");
  btn.type = "submit";
  btnRow.appendChild(btn);
  btnRow.appendChild(formError());
  form.appendChild(btnRow);

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const coderCount = Math.max(1, Math.min(6, Math.round(Number(coders.value) || 0)));
    const team = { coders: coderCount };
    const models = {};
    let anyModel = false;
    for (const role of MODEL_ROLES) {
      const inp = form.querySelector('[data-field="model-' + role + '"]');
      const v = inp && inp.value ? inp.value.trim() : "";
      if (v) { models[role] = v; anyModel = true; }
    }
    if (anyModel) team.models = models;
    const body = { name: name.value.trim(), team };
    if (dept.value) body.department = dept.value;
    if (!coderCount) { setFormError(form, "Coder count must be a number between 1 and 6."); return; }
    submitForm(form, async () => {
      await api(API_PROJECT_CREATE, { method: "POST", body });
      name.value = "";
      for (const role of MODEL_ROLES) {
        const inp = form.querySelector('[data-field="model-' + role + '"]');
        if (inp) inp.value = "";
      }
    }, onDone);
  });
  c.appendChild(
    form);
  return c;
}

/* ── edit team ── */

function editTeamForm(ctx, project, onDone) {
  const t = teamOf(project) || {};
  const models = t.models && typeof t.models === "object" ? t.models : {};
  const details = node("details");
  details.setAttribute("data-form", "edit-team");
  const summary = node("summary", "btn btn-sm", "Edit team");
  details.appendChild(summary);
  const form = node("form", "col");
  form.style.gap = "8px";
  form.style.marginTop = "8px";

  const row = node("div", "row");
  row.style.gap = "8px";
  row.style.alignItems = "flex-end";
  const coders = textInput("", { "data-field": "coders", type: "number", min: "1", max: "6", step: "1" });
  coders.type = "number";
  coders.value = Number(t.coders) > 0 ? String(t.coders) : "";
  row.appendChild(field("Coders (1-6, blank = default)", coders));
  const save = node("button", "btn btn-sm btn-primary", "Save team");
  save.type = "submit";
  row.appendChild(save);
  form.appendChild(row);

  for (const role of MODEL_ROLES) {
    const inp = textInput("model id", { "data-field": "model-" + role });
    inp.value = models[role] ? String(models[role]) : "";
    form.appendChild(field("Model: " + role, inp));
  }
  form.appendChild(formError());

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const body = {};
    const coderV = coders.value.trim() === "" ? null : Math.round(Number(coders.value));
    if (coderV !== null) {
      if (!(coderV >= 1 && coderV <= 6)) {
        setFormError(form, "Coder count must be a number between 1 and 6.");
        return;
      }
      body.coders = coderV;
    }
    const modelsOut = {};
    let touchModels = false;
    for (const role of MODEL_ROLES) {
      const inp = form.querySelector('[data-field="model-' + role + '"]');
      const v = inp && inp.value ? inp.value.trim() : "";
      if (v) { modelsOut[role] = v; touchModels = true; }
      else if (models[role]) {
        /* Backend merges per role and rejects empty model ids (400
           "team.models.<role> must be a non-empty model id"), so an override
           can be REPLACED but not removed via this route. Say so instead of
           sending "" (which would just 400). */
        inp.placeholder = "cannot clear; replace with another model id";
        inp.setAttribute("data-was-override", "");
      }
    }
    if (touchModels) body.models = modelsOut;
    const blocked = form.querySelector('[data-was-override]');
    if (blocked && !touchModels) {
      setFormError(form, "This route replaces model overrides but cannot clear them (backend rejects empty ids). Replace with a model id instead.");
      for (const inp of form.querySelectorAll('[data-was-override]')) inp.removeAttribute("data-was-override");
      return;
    }
    if (!Object.keys(body).length) { details.open = false; return; }
    submitForm(form, async () => {
      await api(API_PROJECT_TEAM(project.id), { method: "PATCH", body });
      details.open = false;
    }, onDone);
  });
  details.appendChild(form);
  return details;
}

/* ── list view ────────────────────────────────────────────────────────── */

function projectItem(ctx, panel, p, onTeamChanged) {
  const counts = taskCounts(p.tasks);
  const running = runningSessions(panel, p.id);
  const last = lastActivity(p);
  const budget = p.budget || {};

  const item = node("div", "item");
  item.setAttribute("data-project", p.id);
  item.style.alignItems = "flex-start";

  const main = node("div", "col grow");
  const titleRow = node("div", "row");
  titleRow.appendChild(link(ctx, "#/projects/" + encodeURIComponent(p.id), p.name || "(unnamed project)", "item-title"));
  titleRow.appendChild(pill(projectPill(p.status), statusLabel(p.status || "active")));
  if (running.length) titleRow.appendChild(pill("pill pill-run", running.length + " running"));
  main.appendChild(titleRow);

  if (p.description) {
    const d = node("div", "item-sub", clip(p.description, 180));
    main.appendChild(d);
  }

  const facts = node("div", "item-sub");
  const parts = [counts.total + (counts.total === 1 ? " task" : " tasks")];
  for (const pair of counts.rows) parts.push(pair[1] + " " + statusLabel(pair[0]));
  parts.push(last ? "last activity " + ctx.ago(last) : "no activity yet");
  facts.textContent = parts.join(" \u00b7 ");
  main.appendChild(facts);

  if (running.length) {
    main.appendChild(node("div", "item-sub", "Working now: " + running.map((s) =>
      (s.agentName || s.agentId) + " \u2192 " + clip(s.taskTitle || s.taskId || "", 50)
    ).join("; ")));
  }

  /* Team line (docs/PROJECT_TEAM_SPEC.md): coders + model overrides, or "default". */
  const teamRow = node("div", "item-sub");
  teamRow.setAttribute("data-team-line", "");
  teamRow.appendChild(node("span", "tiny muted", "Team: "));
  teamRow.appendChild(node("span", "tiny", teamLine(p)));
  teamRow.appendChild(editTeamForm(ctx, p, onTeamChanged));
  /* PANEL payload gap (validated live on :8787): panelData's slimProject does
     not copy the per-project team CONFIG field, only the agent ROSTER
     (`teams`). teamLine(p) then shows "default" here even after a successful
     PATCH until the page reloads through a payload that carries it. Read the
     roster as a best-effort signal so the list is not stuck on a stale
     "default" between reloads. */
  if (!teamOf(p) && (p.teams || []).length) {
    const coderAgents = [];
    for (const t of p.teams) for (const a of t.agents || []) if (a.role === "coder") coderAgents.push(a);
    teamRow.appendChild(node("span", "tiny muted",
      "· roster " + coderAgents.length + " coders (panel payload does not carry team config; reload shows exact state)"));
  }
  main.appendChild(teamRow);

  if (Number(budget.allocatedUsd) > 0) {
    const used = share(budget.spentUsd, budget.allocatedUsd);
    const wrap = node("div", "col");
    wrap.style.gap = "4px";
    wrap.appendChild(bar(budget.spentUsd, budget.allocatedUsd, used > 90 ? "err" : used > 70 ? "warn" : "ok"));
    wrap.appendChild(node("div", "tiny muted", usd(budget.spentUsd) + " of " + usd(budget.allocatedUsd) + " budget used (" + num(used) + "%)"));
    main.appendChild(wrap);
  }
  item.appendChild(main);

  const metaCol = node("div", "item-meta");
  metaCol.style.flexDirection = "column";
  metaCol.style.alignItems = "flex-end";
  const agents = asArray(p.teams).reduce((n, t) => n + asArray(t && t.agents).length, 0);
  metaCol.appendChild(node("span", null, agents + " agents"));
  if (counts.by.failed) metaCol.appendChild(pill("pill pill-err", counts.by.failed + " failed"));
  metaCol.appendChild(node("span", "tiny", "open \u203a"));
  item.appendChild(metaCol);

  return item;
}

function listView(ctx, panel, onTeamChanged) {
  const projects = asArray(panel.projects);
  const departments = asArray(panel.departments);
  const frag = document.createDocumentFragment();

  const head = card();
  const hh = cardHead("Projects", "h2");
  hh.appendChild(pill("pill", projects.length + (projects.length === 1 ? " project" : " projects")));
  hh.appendChild(pill("pill", departments.length + (departments.length === 1 ? " department" : " departments")));
  const visual = panel.visual || {};
  hh.appendChild(pill("pill", num(visual.tasks) + " tasks"));
  hh.appendChild(pill("pill", usd(visual.budgetSpentUsd) + " spent"));
  head.appendChild(hh);
  frag.appendChild(head);

  /* Team-config forms (docs/PROJECT_TEAM_SPEC.md). Shown before the groups so
     they are always reachable, even with zero departments/projects. */
  frag.appendChild(departmentForm(ctx, onTeamChanged));
  frag.appendChild(projectForm(ctx, departments, onTeamChanged));

  if (!projects.length) {
    frag.appendChild(stateCard("empty", "No projects yet", "Ask the assistant to start one.", link(ctx, "#/assistant", "Go to the assistant", "btn btn-primary")));
    return frag;
  }

  const byId = new Map(projects.map((p) => [p.id, p]));
  const placed = new Set();
  const groups = [];
  for (const d of departments) {
    const list = asArray(d.projectIds).map((id) => byId.get(id)).filter(Boolean);
    for (const p of list) placed.add(p.id);
    groups.push({ id: d.id, name: d.name || d.id || "Department", running: d.running, projects: list });
  }
  const orphans = projects.filter((p) => !placed.has(p.id));
  if (orphans.length) groups.push({ id: "orphans", name: "Unassigned", running: 0, projects: orphans });

  for (const g of groups) {
    if (!g.projects.length) continue;
    const c = card();
    c.setAttribute("data-department", g.id || g.name);
    const gh = cardHead(g.name, "h3");
    gh.appendChild(pill("pill", g.projects.length + (g.projects.length === 1 ? " project" : " projects")));
    const inFlight = g.projects.reduce((n, p) => n + inFlightCount(p.tasks), 0);
    if (inFlight) gh.appendChild(pill("pill pill-run", inFlight + " in flight"));
    c.appendChild(gh);
    const body = node("div", "col");
    for (const p of g.projects) body.appendChild(projectItem(ctx, panel, p, onTeamChanged));
    c.appendChild(body);
    frag.appendChild(c);
  }
  return frag;
}

/* ── detail view ──────────────────────────────────────────────────────── */

function tasksNewestFirst(tasks) {
  return asArray(tasks).slice().sort((a, b) =>
    timeOf(b.createdAt) - timeOf(a.createdAt) || timeOf(b.updatedAt) - timeOf(a.updatedAt));
}

function countPills(tasks) {
  const row = node("div", "row");
  const c = taskCounts(tasks);
  row.appendChild(pill("pill", c.total + (c.total === 1 ? " task" : " tasks")));
  for (const pair of c.rows) row.appendChild(pill(statusPill(pair[0]), pair[1] + " " + statusLabel(pair[0])));
  return row;
}

function taskItem(ctx, projectId, t, onResume) {
  const item = node("div", "item");
  item.setAttribute("data-task", t.id || "");
  item.setAttribute("data-task-status", String(t.status || ""));
  item.style.alignItems = "flex-start";

  const main = node("div", "col grow");
  const head = node("div", "row");
  head.appendChild(pill(statusPill(t.status), statusLabel(t.status)));
  const req = node("span", "item-title", clip(t.rawRequest || t.enhancedBrief || "(no request text)", 150));
  req.title = clip(t.rawRequest || "", 400);
  head.appendChild(req);
  main.appendChild(head);

  const facts = ["created " + (t.createdAt ? ctx.ago(t.createdAt) : "?"), "updated " + (t.updatedAt ? ctx.ago(t.updatedAt) : "?")];
  if (Number(t.loopCount) > 0) facts.push(t.loopCount + (t.loopCount === 1 ? " loop" : " loops"));
  facts.push(t.id);
  main.appendChild(node("div", "item-sub", facts.join(" \u00b7 ")));

  if (t.error) main.appendChild(pill("pill pill-err", "Failed: " + clip(t.error, 200), t.error));

  if (t.result || t.review || t.plan) {
    const details = node("details");
    const summary = node("summary", "small muted", "details");
    details.appendChild(summary);
    for (const part of [["plan", t.plan], ["result", t.result], ["review", t.review]]) {
      if (!part[1]) continue;
      const wrap = node("div", "col");
      wrap.appendChild(node("div", "tiny muted", part[0]));
      wrap.appendChild(node("div", "pre", clip(part[1], 1500)));
      details.appendChild(wrap);
    }
    main.appendChild(details);
  }
  item.appendChild(main);

  const meta = node("div", "item-meta");
  meta.style.flexDirection = "column";
  meta.style.alignItems = "flex-end";
  meta.appendChild(link(ctx, "#/flow/" + encodeURIComponent(t.id), "View chain", "btn btn-sm"));
  if (t.status === "failed" && onResume) {
    const b = node("button", "btn btn-sm btn-primary", "Resume");
    b.type = "button";
    b.setAttribute("data-action", "resume");
    b.addEventListener("click", () => {
      b.disabled = true;
      onResume(projectId, t);
    });
    meta.appendChild(b);
  }
  item.appendChild(meta);
  return item;
}

function teamSection(ctx, project, panel, agents) {
  const c = card();
  const head = cardHead("Agent team", "h3");
  const running = runningSessions(panel, project.id);
  const workingBy = new Map(running.map((s) => [s.agentId, s]));
  head.appendChild(pill("pill", asArray(project.teams).reduce((n, t) => n + asArray(t && t.agents).length, 0) + " agents"));
  if (running.length) head.appendChild(pill("pill pill-run", running.length + " working now"));
  c.appendChild(head);

  const byAgent = new Map();
  for (const a of asArray(agents)) {
    if (!a) continue;
    if (a.agentKey) byAgent.set(a.agentKey, a);
    if (a.projectId === project.id && a.agentId) byAgent.set(a.agentId, a);
  }

  const teams = asArray(project.teams);
  if (!teams.length) {
    c.appendChild(node("div", "muted small", "No team assigned to this project yet."));
    return c;
  }
  const body = node("div", "col");
  for (const team of teams) {
    if (team && team.name) body.appendChild(node("div", "tiny muted", team.name));
    for (const a of asArray(team && team.agents)) {
      const row = node("div", "row");
      row.setAttribute("data-agent", a.id || "");
      const work = workingBy.get(a.id);
      const rec = byAgent.get(project.id + "::" + a.id) || byAgent.get(a.id);
      const dot = work ? "dot dot-run" : "dot dot-ok";
      row.appendChild(node("span", dot));
      row.appendChild(node("span", null, a.name || a.id || "agent"));
      row.appendChild(node("span", "muted small", a.role || ""));
      row.appendChild(node("span", "muted small", a.modelId || ""));
      if (work) row.appendChild(pill("pill pill-run", "working: " + clip(work.taskTitle || work.taskId || "", 50)));
      else row.appendChild(pill("pill pill-dim", "idle"));
      const b = (rec && rec.budget) || {};
      if (b.spentUsd != null) row.appendChild(node("span", "tiny muted", usd(b.spentUsd) + " spent"));
      body.appendChild(row);
    }
  }
  c.appendChild(body);
  return c;
}

function threadSection(ctx, thread) {
  const c = card();
  const head = cardHead("Recent thread", "h3");
  const rows = asArray(thread).slice(-THREAD_ROWS).reverse();
  head.appendChild(pill("pill", "last " + rows.length));
  c.appendChild(head);
  if (!rows.length) {
    c.appendChild(node("div", "muted small", "No thread activity yet."));
    return c;
  }
  const body = node("div", "col");
  for (const e of rows) {
    const row = node("div", "col");
    row.style.gap = "2px";
    const line = node("div", "row");
    line.appendChild(node("span", "tiny muted mono", e && e.ts ? ctx.hm(e.ts) : ""));
    line.appendChild(pill("pill pill-dim", (e && (e.kind || e.role)) || "note"));
    line.appendChild(node("span", "tiny muted", (e && e.agent) || ""));
    row.appendChild(line);
    row.appendChild(node("div", "small wrap-any", clip((e && e.text) || "", 400)));
    body.appendChild(row);
  }
  c.appendChild(body);
  return c;
}

function costSection(ctx, cost) {
  const c = card();
  c.appendChild(cardHead("Cost", "h3"));
  const total = Number(cost && cost.totalUsd) || 0;
  const byModel = new Map();
  for (const ev of asArray(cost && cost.events)) {
    const m = (ev && ev.modelId) || "unknown";
    byModel.set(m, (byModel.get(m) || 0) + (Number(ev && ev.costUsd) || 0));
  }
  const rows = Array.from(byModel.entries()).sort((a, b) => b[1] - a[1]);
  const head = node("div", "grid-3");
  head.appendChild(kpi(usd(total), "spend to date"));
  head.appendChild(kpi(rows.length + (rows.length === 1 ? " model" : " models"), "used"));
  head.appendChild(kpi(String(asArray(cost && cost.events).length), "charge events"));
  c.appendChild(head);
  if (!rows.length) {
    c.appendChild(node("div", "muted small", "No spend recorded yet."));
    return c;
  }
  const body = node("div", "col");
  for (const pair of rows) {
    const row = node("div", "col");
    row.style.gap = "3px";
    const line = node("div", "row");
    line.appendChild(node("span", "small mono", pair[0]));
    line.appendChild(node("span", "small muted right", usd(pair[1]) + " (" + num(share(pair[1], total)) + "%)"));
    row.appendChild(line);
    row.appendChild(bar(pair[1], total || 1));
    body.appendChild(row);
  }
  c.appendChild(body);
  return c;
}

function detailView(ctx, data, onResume, onTeamChanged) {
  const { project, tasks, thread, cost, agents, sessions } = data;
  const frag = document.createDocumentFragment();

  const back = node("div", "row");
  back.appendChild(link(ctx, "#/projects", "\u2039 All projects", "btn btn-sm"));
  frag.appendChild(back);

  const running = runningSessions({ sessions }, project.id);
  const sorted = tasksNewestFirst(tasks);

  const head = card();
  const hh = node("div", "card-head");
  hh.appendChild(node("h2", null, project.name || project.id));
  hh.appendChild(pill(projectPill(project.status), statusLabel(project.status || "active")));
  if (running.length) hh.appendChild(pill("pill pill-run", running.length + " running now"));
  head.appendChild(hh);

  const deptName = (asArray(agents).find((a) => a && a.projectId === project.id) || {}).departmentName || "";
  head.appendChild(node("div", "small muted", [deptName, project.rootDir].filter(Boolean).join(" \u00b7 ")));
  if (project.description) head.appendChild(node("div", "small wrap-any", project.description));

  /* Per-project team config (docs/PROJECT_TEAM_SPEC.md): coder count + per-role
     model overrides (or "default") with an inline Edit team form that PATCHes
     /company/projects/:id/team. onTeamChanged re-runs the current tick. */
  const cfgRow = node("div", "row");
  cfgRow.style.marginTop = "6px";
  cfgRow.appendChild(node("span", "tiny muted", "Team: "));
  cfgRow.appendChild(node("span", "tiny", teamLine(project)));
  cfgRow.appendChild(editTeamForm(ctx, project, onTeamChanged));
  head.appendChild(cfgRow);

  const kpis = node("div", "grid-3");
  kpis.style.marginTop = "8px";
  const counts = taskCounts(sorted);
  kpis.appendChild(kpi(String(counts.total), "tasks"));
  kpis.appendChild(kpi(String(inFlightCount(sorted)), "in flight"));
  kpis.appendChild(kpi(String(counts.by.failed || 0), "failed"));
  kpis.appendChild(kpi(usd(cost && cost.totalUsd), "project spend"));
  const spentByAgents = asArray(agents)
    .filter((a) => a && a.projectId === project.id && a.budget)
    .reduce((n, a) => n + (Number(a.budget.spentUsd) || 0), 0);
  if (asArray(agents).some((a) => a && a.projectId === project.id && a.budget)) {
    kpis.appendChild(kpi(usd(spentByAgents), "agent spend (measured)"));
  }
  kpis.appendChild(kpi(sorted.length ? ctx.ago(sorted[0].createdAt) : "-", "latest task"));
  head.appendChild(kpis);
  frag.appendChild(head);

  const tasksCard = card();
  const th = cardHead("Tasks (newest first)", "h3");
  for (const child of Array.from(countPills(sorted).childNodes)) th.appendChild(child);
  tasksCard.appendChild(th);
  if (!sorted.length) {
    tasksCard.appendChild(node("div", "muted small", "No tasks for this project yet."));
  } else {
    const body = node("div", "col");
    for (const t of sorted.slice(0, TASK_ROWS)) body.appendChild(taskItem(ctx, project.id, t, onResume));
    tasksCard.appendChild(body);
  }
  frag.appendChild(tasksCard);

  frag.appendChild(teamSection(ctx, project, { sessions }, agents));
  frag.appendChild(threadSection(ctx, thread));
  frag.appendChild(costSection(ctx, cost));
  return frag;
}

/* ── mount ────────────────────────────────────────────────────────────── */

export function mount(el, ctx) {
  const c = ctx || {};
  const api = c.api;
  const projectId = projectIdFromCtx(c);

  const root = node("div", "col");
  root.style.gap = "12px";
  el.innerHTML = "";
  el.appendChild(root);
  // Loading state first: the shell shows this until the first answer arrives.
  root.appendChild(stateCard("loading", projectId ? "Loading project\u2026" : "Loading projects\u2026", null));

  let stopped = false;
  let stopPoll = null;
  let inFlight = false;
  let lastSig = "";
  let notice = "";

  const stop = () => {
    stopped = true;
    if (typeof stopPoll === "function") {
      try { stopPoll(); } catch { /* the shell owns its timer */ }
    }
    stopPoll = null;
  };

  if (typeof api !== "function") {
    root.appendChild(stateCard("error", "View unavailable", "The shell did not provide api()."));
    return stop;
  }

  const paint = (sig, build) => {
    if (sig === lastSig) return;
    lastSig = sig;
    root.innerHTML = "";
    root.appendChild(build());
  };

  const showError = (e) => {
    const status = e && e.status;
    const title = status === 404 ? "Project not found" : "Could not load " + (projectId ? "this project" : "projects");
    const body = status === 404
      ? projectId
      : ((e && e.message) || "unknown error");
    const extra = status === 404
      ? link(c, "#/projects", "Back to all projects", "btn")
      : null;
    root.innerHTML = "";
    root.appendChild(stateCard("error", title, body, extra));
    lastSig = "error:" + title + ":" + body;
  };

  const noticeLine = (msg) => {
    const n = node("div", "row");
    n.appendChild(pill("pill pill-warn", msg));
    return n;
  };

  /* After a create/edit succeeds, refresh so the new entity/team shows. */
  const onTeamChanged = () => {
    lastSig = "";
    return tick();
  };
  const loadList = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const panel = await api(PANEL_LITE);
      if (!warnedNoLite && panel && panel.lite !== true) {
        warnedNoLite = true;
        console.warn(
          "[projects] " + PANEL_LITE + " answered without lite:true - PERF-BACKEND has not landed the trimmed payload yet; using the full response.",
        );
      }
      const sig = "list:" + JSON.stringify([
        asArray(panel && panel.departments).map((d) => [d.id, d.name, asArray(d.projectIds), d.running]),
        asArray(panel && panel.projects).map((p) => [
          p.id, p.name, p.status, p.departmentId,
          taskCounts(p.tasks).rows,
          runningSessions(panel, p.id).map((s) => [s.agentId, s.taskId]),
          lastActivity(p),
          (p.budget || {}).spentUsd,
          teamOf(p) ? [(teamOf(p) || {}).coders, (teamOf(p) || {}).models] : null,
        ]),
        notice,
      ]);
      paint(sig, () => {
        const frag = document.createDocumentFragment();
        if (notice) frag.appendChild(noticeLine(notice));
        frag.appendChild(listView(c, panel || {}, onTeamChanged));
        return frag;
      });
    } catch (e) {
      showError(e);
    } finally {
      inFlight = false;
    }
  };

  /* ---------- detail ---------- */
  const resumeTask = async (pid, task) => {
    notice = "Resuming " + clip(task.rawRequest || task.id, 50) + "\u2026";
    lastSig = "";
    paint("pending-resume-" + Date.now(), () => {
      const frag = document.createDocumentFragment();
      frag.appendChild(noticeLine(notice));
      return frag;
    });
    try {
      await api("/company/projects/" + encodeURIComponent(pid) + "/run", {
        method: "POST",
        body: { taskId: task.id, auto: true },
      });
      notice = "Resume requested for " + task.id + ".";
    } catch (e) {
      notice = "Resume failed: " + ((e && e.message) || "unknown error");
    }
    lastSig = "";
    await loadDetail();
  };

  const loadDetail = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const [project, tasks, thread, cost, agents, sessions] = await Promise.all([
        api("/company/projects/" + encodeURIComponent(projectId)),
        api("/company/projects/" + encodeURIComponent(projectId) + "/tasks").catch(() => []),
        api("/company/projects/" + encodeURIComponent(projectId) + "/thread").catch(() => []),
        api("/company/projects/" + encodeURIComponent(projectId) + "/cost").catch(() => ({ totalUsd: 0, events: [] })),
        api("/company/agents").catch(() => []),
        api("/company/sessions").catch(() => ({ items: [] })),
      ]);
      const sorted = tasksNewestFirst(tasks);
      const sig = "detail:" + projectId + ":" + JSON.stringify([
        project && project.name, project && project.status, project && project.rootDir,
        asArray(project && project.teams).map((t) => [t.id, asArray(t.agents).map((a) => [a.id, a.modelId])]),
        teamOf(project) ? [(teamOf(project) || {}).coders, (teamOf(project) || {}).models] : null,
        sorted.map((t) => [t.id, t.status, t.updatedAt, Boolean(t.error), t.loopCount]),
        asArray(thread).length, asArray(thread).slice(-1).map((e) => e.ts),
        cost && cost.totalUsd, asArray(cost && cost.events).length,
        asArray(sessions && sessions.items).filter((s) => s.projectId === projectId && s.status === "running").map((s) => [s.agentId, s.taskId]),
        notice,
      ]);
      const data = { project, tasks: sorted, thread, cost, agents, sessions };
      paint(sig, () => {
        const frag = document.createDocumentFragment();
        if (notice) frag.appendChild(noticeLine(notice));
        frag.appendChild(detailView(c, data, resumeTask, onTeamChanged));
        return frag;
      });
    } catch (e) {
      showError(e);
    } finally {
      inFlight = false;
    }
  };

  const tick = projectId ? loadDetail : loadList;
  const pollMs = projectId ? DETAIL_POLL_MS : POLL_MS;
  tick();
  if (typeof c.poll === "function") {
    try { stopPoll = c.poll(tick, pollMs); } catch { stopPoll = null; }
  } else {
    const id = setInterval(() => { if (!document.hidden) tick(); }, pollMs);
    stopPoll = () => clearInterval(id);
  }

  return stop;
}
