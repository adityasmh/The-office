// public/v2/views/fleet.js — the Fleet view: run the "Claude manages, jcode
// executes" flow from the dashboard (docs/FLEET_SPEC.md).
//
// Routes:  #/fleet             -> order box + the order list
//          #/fleet/:orderId    -> one order: chain strip + Plan / Workers / Review
//
// Contract (docs/UI_V2_SPEC.md): `export const title`, `mount(el, ctx) -> cleanup`.
// ctx = { api, poll, esc, ago, hm, navigate, params, route, usd, dur, trunc, ... }.
//
// Data (FLEET-BACKEND owns the routes; shapes from docs/FLEET_SPEC.md):
//   POST /company/fleet/orders {text, autoApprove?}         -> FleetOrder
//   GET  /company/fleet                                     -> {orders, limits:{maxSessions, running}}
//   GET  /company/fleet/orders/:id                          -> FleetOrder + per work order `live`
//   POST /company/fleet/orders/:id/approve {workOrders?}    -> spawns
//   POST /company/fleet/orders/:id/work/:wid/redo           -> fresh session with the review notes
//   POST /company/fleet/orders/:id/work/:wid/publish        -> retry the draft PR (F34, never force-pushes)
//   POST /company/fleet/orders/:id/cancel                   -> stop spawning queued work
//
// MOCK: `#/fleet?mock=1` uses built-in sample data (exact shapes above) instead
// of the API, and simulates the lifecycle (planning -> approval -> workers ->
// review -> done) so the view can be built and reviewed before the backend
// lands. Nothing is removed when the real API arrives: the mock is opt-in, and
// the default path is always the live API. If the API answers 404 the view says
// so (it never silently pretends sample data is real).
//
// Theme: only the documented style.css classes/vars (.card .btn .pill .pill-*
// .muted .row .col .grid .who-* .mono .pre .small .tiny .state ...) plus CSS
// namespaced under `.fleet`, which reads theme variables only.

export const title = "Fleet";

/* ==================================================================== *
 * Tunables
 * ==================================================================== */
const LIST_LIMIT = 30;
const MS_LIST = 5000; // order list refresh
const MS_WORK = 3000; // live worker tails (spec: every 3s)
const MS_WORK_IDLE = 8000; // nothing is moving: poll slowly
const TAIL_LINES = 15; // lines of journal tail shown per worker
const STYLE_ID = "fleet-view-style";

// Work-order states (docs/FLEET_SPEC.md).
const WO_STATES = ["planned", "queued", "starting", "working", "idle", "reported", "reviewed", "failed"];

/* ==================================================================== *
 * Small helpers (all have fallbacks; ctx normally supplies esc/ago/hm/poll)
 * ==================================================================== */
function s(v) {
  return v === null || v === undefined ? "" : typeof v === "string" ? v : String(v);
}

// RESUME (docs/RESUME_SPEC.md §4): a hop the Router wrote to record that it
// restarted and resumed work. The literal is agreed with the pipeline side
// (src/company/pipeline.ts) and with bonehound's order.trace.
const RESTART_ICON = "\u21bb";
function isRestartHop(h) {
  return !!h && s(h.from).trim() === "Router" && /^restarted/i.test(s(h.what));
}

function escHtml(v) {
  return s(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fallbackHm(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

function fallbackAgo(iso) {
  const t = new Date(iso).getTime();
  if (!isFinite(t)) return "";
  const sec = Math.round((Date.now() - t) / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return sec + "s ago";
  const m = Math.floor(sec / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}

/** ms -> "1.2s" / "2m 03s" / "1h 04m" (same shape as api.js dur, which ctx may supply). */
function fallbackDur(ms) {
  const n = Number(ms);
  if (!isFinite(n) || n < 0) return "";
  if (n < 1000) return Math.round(n) + "ms";
  const sec = n / 1000;
  if (sec < 60) return sec.toFixed(1) + "s";
  const whole = Math.floor(sec);
  const m = Math.floor(whole / 60);
  const rs = whole % 60;
  if (m < 60) return m + "m " + String(rs).padStart(2, "0") + "s";
  const h = Math.floor(m / 60);
  return h + "h " + String(m % 60).padStart(2, "0") + "m";
}

function fallbackPoll(fn, ms) {
  const every = Math.max(250, Number(ms) || 5000);
  const h = setInterval(() => {
    if (!document.hidden) Promise.resolve().then(fn).catch(() => {});
  }, every);
  Promise.resolve().then(fn).catch(() => {});
  return () => clearInterval(h);
}

function errText(e) {
  if (!e) return "unknown error";
  const st = e.status ? "HTTP " + e.status : "";
  const m = e.message || String(e);
  return st ? st + " — " + m : m;
}

function isMissing(e) {
  return !!e && (e.status === 404 || e.kind === "parse");
}

/** "session_macaque_1790683942086_61cae7eb144ccd73" -> "macaque ·4ccd73" */
function shortSid(sid) {
  const v = s(sid);
  const m = v.match(/^session_([A-Za-z0-9]+)_/);
  if (m) return m[1] + " ·" + v.slice(-6);
  return v.length > 20 ? v.slice(0, 8) + "…" + v.slice(-6) : v;
}

/** Split a textarea/plan field into a clean list (also accepts comma lists). */
function toList(v) {
  if (Array.isArray(v)) return v.map((x) => s(x).trim()).filter(Boolean);
  return s(v)
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function woState(st) {
  const v = s(st).trim().toLowerCase();
  return WO_STATES.includes(v) ? v : v || "planned";
}

/* ==================================================================== *
 * Tone / pill helpers
 * ==================================================================== */
function orderPillClass(status) {
  switch (s(status)) {
    case "done":
      return "pill pill-ok";
    case "failed":
      return "pill pill-err";
    case "awaiting_approval":
    case "reviewing":
      return "pill pill-warn";
    case "planning":
    case "running":
      return "pill pill-run";
    default:
      return "pill pill-dim";
  }
}

function woPillClass(state) {
  switch (s(state)) {
    case "reviewed":
      return "pill pill-ok";
    case "failed":
      return "pill pill-err";
    case "reported":
    case "idle":
      return "pill pill-warn";
    case "starting":
    case "working":
      return "pill pill-run";
    default:
      return "pill pill-dim";
  }
}

function verdictPillClass(v) {
  const t = s(v).toUpperCase();
  if (t === "PASS") return "pill pill-ok";
  if (t === "REDO") return "pill pill-err";
  return "pill pill-dim";
}

function orderLabel(status) {
  const map = {
    planning: "Claude is planning",
    awaiting_approval: "waiting for your approval",
    running: "running",
    reviewing: "Claude is reviewing",
    done: "done",
    failed: "failed",
    cancelled: "cancelled",
  };
  return map[s(status)] || s(status) || "unknown";
}

/** Work orders of an order, tolerant of a missing/foreign shape. */
function workOrdersOf(order) {
  const w = order && order.workOrders;
  return Array.isArray(w) ? w : [];
}

function passedCount(order) {
  return workOrdersOf(order).filter((w) => s(w.verdict).toUpperCase() === "PASS").length;
}

/** How many workers are actively generating right now (for the poll cadence). */
function isOrderLive(order) {
  const st = s(order && order.status);
  if (st === "running" || st === "reviewing" || st === "planning") return true;
  return workOrdersOf(order).some((w) => {
    const live = w.live || {};
    return (
      w.state === "starting" || w.state === "working" || live.streaming === true
    );
  });
}

/* ==================================================================== *
 * Mock data (#/fleet?mock=1) — exact FleetOrder/WorkOrder/live shapes
 * ==================================================================== */
const MOCK_LINES = {
  ui: [
    "$ npx tsc --noEmit",
    "read public/v2/app.js (routes + nav contract)",
    "edit public/v2/views/fleet.js",
    "grep \"GET /company/fleet\" src/server.ts -> 0 hits (backend not landed yet)",
    "building against ?mock=1 sample data",
    "checking the view in the browser at 375px and 1280px",
    "no console errors; writing REPORT.md next",
    "REPORT.md written; moving to review",
  ],
  backend: [
    "read docs/FLEET_SPEC.md + docs/AGENT_COORDINATION.md",
    "add src/company/fleet.ts (orders.json store, spawn mutex)",
    "edit src/server.ts: fleet routes only",
    "npx tsc --noEmit -> clean",
    "GET /company/fleet -> {\"orders\":[],\"limits\":{\"maxSessions\":6,\"running\":0}}",
  ],
  docs: [
    "edit HANDOVER.md (fleet section)",
    "edit .env.example (FLEET_* knobs)",
    "grep FLEET_MAX_SESSIONS src/ -> 1 file",
  ],
};

function mockIso(deltaMs) {
  return new Date(Date.now() + deltaMs).toISOString();
}

/** Fresh sample state on every mount, so the demo always starts clean. */
function buildMock() {
  const orders = [
    // A finished order: every work order reviewed PASS.
    {
      id: "fo_mock_done",
      text: "Document the fleet API and add the FLEET_* env knobs to .env.example.",
      createdAt: mockIso(-62 * 60000),
      updatedAt: mockIso(-5 * 60000),
      status: "done",
      plan:
        "Two independent touch points, so two workers cannot collide:\n" +
        "1. DOCS owns HANDOVER.md; 2. ENV owns .env.example.\n" +
        "Both are text-only, no code change, so no gate is needed between them.",
      specDoc: "",
      trace: [
        { ts: mockIso(-62 * 60000), from: "CEO", to: "Assistant", what: "order", detail: "Document the fleet API." },
        { ts: mockIso(-61 * 60000), from: "Assistant", to: "Claude (manager)", what: "plan", detail: "2 work orders" },
        { ts: mockIso(-60 * 60000), from: "CEO", to: "Claude (manager)", what: "approve", detail: "plan approved in the dashboard" },
        { ts: mockIso(-59 * 60000), from: "jcode:session_lynx (DOCS)", to: "Claude (manager)", what: "report", detail: "REPORT.md written" },
        { ts: mockIso(-12 * 60000), from: "Claude (manager)", to: "Assistant", what: "review PASS", detail: "both reports match the diff" },
        { ts: mockIso(-5 * 60000), from: "Assistant", to: "CEO", what: "report", detail: "Done: 2/2 passed" },
      ],
      workOrders: [
        {
          id: "wo_mock_docs",
          title: "Document the fleet API in HANDOVER.md",
          role: "DOCS",
          owns: ["HANDOVER.md"],
          brief: "Write the fleet section: routes, state file, spawn rules.",
          done: ["HANDOVER.md mentions every /company/fleet route", "npx tsc --noEmit clean"],
          state: "reviewed",
          sessionId: "session_lynx_1790683942187_a1b2c3d4e5f60718",
          startedAt: mockIso(-59 * 60000),
          reportedAt: mockIso(-14 * 60000),
          verdict: "PASS",
          review: "Report quotes real grep output and the file matches the diff. Accepted.",
          attempts: 1,
        },
        {
          id: "wo_mock_env",
          title: "Add FLEET_MAX_SESSIONS / FLEET_PLANNER_MODEL to .env.example",
          role: "ENV",
          owns: [".env.example"],
          brief: "Placeholders only. Do not touch .env.",
          done: ["both keys present", ".env untouched"],
          state: "reviewed",
          sessionId: "session_marmot_1790683942991_9988776655443322",
          startedAt: mockIso(-59 * 60000),
          reportedAt: mockIso(-13 * 60000),
          verdict: "PASS",
          review: ".env.example diff is placeholders only; .env hash unchanged.",
          attempts: 1,
        },
      ],
    },

    // A running order: 3 workers, one sent back, live tails.
    {
      id: "fo_mock_run",
      text: "Build the Fleet view in the new dashboard and keep the backend honest.",
      createdAt: mockIso(-26 * 60000),
      updatedAt: mockIso(-40 * 1000),
      status: "running",
      plan:
        "Three orders with disjoint files, so they can run in parallel:\n" +
        "  UI-FLEET  owns public/v2/views/fleet.js\n" +
        "  BACKEND   owns src/company/fleet.ts + the fleet routes in src/server.ts\n" +
        "  DOCS      owns HANDOVER.md\n" +
        "The UI codes against docs/UI_V2_SPEC.md and the ?mock=1 sample shapes, so it\n" +
        "does not wait for the routes to exist. Router restart stays with CRASHFIX/OPS.",
      specDoc: "docs/FLEET_SPEC.md",
      trace: [
        { ts: mockIso(-26 * 60000), from: "CEO", to: "Assistant", what: "order", detail: "Build the Fleet view." },
        { ts: mockIso(-25 * 60000), from: "Assistant", to: "Claude (manager)", what: "plan", detail: "3 work orders" },
        { ts: mockIso(-24 * 60000), from: "CEO", to: "Claude (manager)", what: "approve", detail: "approved (autoApprove off)" },
        { ts: mockIso(-23 * 60000), from: "jcode:session_otter (UI-FLEET)", to: "Claude (manager)", what: "start", detail: "3 visible terminals opened" },
        { ts: mockIso(-9 * 60000), from: "jcode:session_badger (BACKEND)", to: "Claude (manager)", what: "report", detail: "REPORT.md written" },
        { ts: mockIso(-8 * 60000), from: "Claude (manager)", to: "jcode:session_badger (BACKEND)", what: "review REDO", detail: "tail window unbounded; add a cap and re-report" },
      ],
      workOrders: [
        {
          id: "wo_mock_ui",
          title: "Build public/v2/views/fleet.js",
          role: "UI-FLEET",
          owns: ["public/v2/views/fleet.js"],
          brief: "Build the Fleet view against the v2 contract, mock first. Do not edit app.js.",
          done: ["#/fleet and #/fleet/:orderId render", "no console errors at 375px"],
          state: "working",
          sessionId: "session_otter_1790683943122_7f3a91c4de88b210",
          windowPid: 27120,
          startedAt: mockIso(-23 * 60000),
          attempts: 1,
          live: { streaming: true, lastActivity: mockIso(-4 * 1000), tail: MOCK_LINES.ui.slice(0, 6) },
        },
        {
          id: "wo_mock_be",
          title: "src/company/fleet.ts + fleet routes",
          role: "BACKEND",
          owns: ["src/company/fleet.ts", "src/server.ts (fleet routes only)"],
          brief: "Orders store, spawn mutex, 5s watcher, review loop.",
          done: ["GET /company/fleet answers", "npx tsc --noEmit clean"],
          state: "reported",
          sessionId: "session_badger_1790683943400_51c8a7b93e2d0f44",
          startedAt: mockIso(-23 * 60000),
          reportedAt: mockIso(-9 * 60000),
          verdict: "REDO",
          review:
            "The tail is read straight out of the journal with no bound: a chatty session will ship megabytes to the\n" +
            "browser. Cap at 15 lines and 4 KB per work order, then re-report with the measured payload size.",
          attempts: 1,
          live: { streaming: false, lastActivity: mockIso(-9 * 60000), tail: MOCK_LINES.backend },
        },
        {
          id: "wo_mock_docs2",
          title: "HANDOVER.md: fleet section",
          role: "DOCS",
          owns: ["HANDOVER.md"],
          brief: "Document the fleet routes and the spawn rules.",
          done: ["every route listed"],
          state: "starting",
          sessionId: "session_heron_1790683943555_c0ffee1122334455",
          startedAt: mockIso(-9 * 60000),
          attempts: 2,
          live: { streaming: true, lastActivity: mockIso(-2 * 1000), tail: MOCK_LINES.docs },
        },
      ],
    },

    // Waiting for approval: the CEO can still edit or remove work orders.
    {
      id: "fo_mock_approve",
      text: "Make the dashboard load faster and stop the router from dying.",
      createdAt: mockIso(-3 * 60000),
      updatedAt: mockIso(-50 * 1000),
      status: "awaiting_approval",
      plan:
        "Split by risk, not by file:\n" +
        "  1. CRASHFIX: process-level handlers + a supervisor task. Owns src/server.ts, ops/router-supervisor.ps1.\n" +
        "  2. PERF: the dashboard's 6s full-panel poll -> per-view polls. Owns public/v2/views/projects.js.\n" +
        "Order 2 depends on nothing, so both start together. Nothing here needs a router restart mid-flight.",
      specDoc: "",
      trace: [
        { ts: mockIso(-3 * 60000), from: "CEO", to: "Assistant", what: "order", detail: "Make the dashboard faster, stop the crashes." },
        { ts: mockIso(-2 * 60000), from: "Assistant", to: "Laya", what: "which team?", detail: "platform" },
        { ts: mockIso(-1 * 60000), from: "Laya", to: "Claude (manager)", what: "team: Platform", detail: "team pick confidence 0.61" },
        { ts: mockIso(-50 * 1000), from: "Claude (manager)", to: "CEO", what: "plan", detail: "2 work orders, disjoint files" },
      ],
      workOrders: [
        {
          id: "wo_mock_crash",
          title: "Stop the router dying: handlers + supervisor",
          role: "CRASHFIX",
          owns: ["src/server.ts", "ops/router-supervisor.ps1"],
          brief: "Add crash handlers and a supervisor scheduled task. Boss is not here to fix it by hand.",
          done: ["a killed router comes back within 30s"],
          state: "planned",
          attempts: 0,
        },
        {
          id: "wo_mock_perf",
          title: "Replace the 6s full-panel poll",
          role: "PERF",
          owns: ["public/v2/views/projects.js"],
          brief: "Each view polls only what it renders.",
          done: ["no /company/panel call from the projects view"],
          state: "planned",
          attempts: 0,
        },
      ],
    },
  ];

  return { orders, limits: { maxSessions: 6, running: 4 } };
}

/** Mutable mock store + a fake backend so mock mode is clickable end to end. */
function createMockBackend() {
  const state = buildMock();
  let seq = 0;
  let tick = 0;
  const timers = new Set();
  let interval = null; // the fake watcher; runs only while a view has it attached
  let attached = 0;

  const later = (ms, fn) => {
    const h = setTimeout(() => {
      timers.delete(h);
      fn();
    }, ms);
    timers.add(h);
  };

  function findOrder(id) {
    return state.orders.filter((o) => o.id === id)[0] || null;
  }

  /** One "backend watcher" step: journals advance, reports appear, reviews land. */
  function step() {
    tick += 1;
    for (const o of state.orders) {
      if (o.status !== "running") continue;
      for (const w of o.workOrders) {
        if (w.state === "starting") {
          w.state = "working";
          w.live = w.live || { streaming: true, lastActivity: mockIso(0), tail: [] };
        }
        if (w.state !== "working") continue;
        const lines = MOCK_LINES[w.role === "BACKEND" ? "backend" : w.role === "DOCS" ? "docs" : "ui"];
        w.live = w.live || { streaming: true, lastActivity: mockIso(0), tail: [] };
        w.live.tail = (w.live.tail || []).concat(["[" + mockIso(0).slice(11, 19) + "] " + lines[tick % lines.length]]);
        if (w.live.tail.length > 40) w.live.tail = w.live.tail.slice(-40);
        w.live.streaming = true;
        w.live.lastActivity = mockIso(0);
        o.updatedAt = mockIso(0);
        if ((w.live.tail || []).length >= 12) {
          w.state = "reported";
          w.reportedAt = mockIso(0);
          w.live.streaming = false;
          o.trace.push({ ts: mockIso(0), from: "jcode:" + shortSid(w.sessionId) + " (" + w.role + ")", to: "Claude (manager)", what: "report", detail: "REPORT.md written" });
          later(4000, () => {
            const o2 = findOrder(o.id);
            const w2 = o2 && workOrdersOf(o2).filter((x) => x.id === w.id)[0];
            if (!w2 || w2.state !== "reported") return;
            w2.state = "reviewed";
            w2.verdict = w2.attempts > 1 || w2.id === "wo_mock_docs2" ? "PASS" : "REDO";
            w2.review =
              w2.verdict === "PASS"
                ? "Report matches the diff and quotes real command output. Accepted."
                : "Report claims a fix but the diff does not cap the payload. Fix and re-report with numbers.";
            o2.trace.push({ ts: mockIso(0), from: "Claude (manager)", to: "jcode:" + shortSid(w2.sessionId) + " (" + w2.role + ")", what: "review " + w2.verdict, detail: w2.review.slice(0, 160) });
            o2.updatedAt = mockIso(0);
            const settled = workOrdersOf(o2).every((x) => x.state === "reviewed" || x.state === "failed");
            const allPass = settled && workOrdersOf(o2).every((x) => s(x.verdict).toUpperCase() === "PASS");
            if (allPass) {
              o2.status = "done";
              o2.trace.push({ ts: mockIso(0), from: "Claude (manager)", to: "Assistant", what: "review PASS", detail: "all work orders accepted" });
              o2.trace.push({ ts: mockIso(0), from: "Assistant", to: "CEO", what: "report", detail: "Done: all work orders passed" });
            } else {
              // a REDO means more work is coming, so the order stays in flight
              o2.status = "reviewing";
            }
            o2.updatedAt = mockIso(0);
          });
        }
      }
    }
    // Keep the "updated N ago" column honest while workers are generating.
    for (const o of state.orders) {
      if (o.status === "running") o.updatedAt = mockIso(0);
    }
  }

  /** The fake 2.2s "backend watcher": starts when a view attaches, stops when it leaves. */
  function attach() {
    attached += 1;
    if (!interval) interval = setInterval(step, 2200);
    return attached;
  }

  function detach() {
    attached = Math.max(0, attached - 1);
    if (attached === 0 && interval) {
      clearInterval(interval);
      interval = null;
    }
    return attached;
  }

  function planFor(text) {
    const t = s(text).slice(0, 160);
    return (
      "Planned from: \"" + t + "\"\n" +
      "Two orders on disjoint files so they can run in parallel:\n" +
      "  1. FLEET-DEMO owns docs/FLEET_DEMO.md\n" +
      "  2. FLEET-DEMO-2 owns README.md (one added section)\n" +
      "Both are text-only; the worker preamble from docs/FLEET_SPEC.md is prefixed to every brief."
    );
  }

  return {
    attach,
    detach,
    list: () => ({ orders: state.orders.slice(), limits: state.limits }),
    detail: (id) => {
      const o = findOrder(id);
      return o ? { order: o, limits: state.limits } : null;
    },
    create(text, autoApprove) {
      const id = "fo_mock_" + ++seq + "_" + Math.random().toString(36).slice(2, 6);
      const o = {
        id,
        text: s(text),
        createdAt: mockIso(0),
        updatedAt: mockIso(0),
        status: "planning",
        plan: "",
        specDoc: "",
        workOrders: [],
        trace: [
          { ts: mockIso(0), from: "CEO", to: "Assistant", what: "order", detail: s(text).slice(0, 400) },
          { ts: mockIso(0), from: "Assistant", to: "Claude (manager)", what: "plan", detail: "planning…" },
        ],
      };
      state.orders.unshift(o);
      later(2600, () => {
        o.plan = planFor(text);
        o.workOrders = [
          {
            id: "wo_" + id + "_1",
            title: "Write docs/FLEET_DEMO.md",
            role: "FLEET-DEMO",
            owns: ["docs/FLEET_DEMO.md"],
            brief: "One page: what the fleet flow is, and the two commands to run it.",
            done: ["the file exists", "no secrets in it"],
            state: "planned",
            attempts: 0,
          },
          {
            id: "wo_" + id + "_2",
            title: "Add a README section",
            role: "FLEET-DEMO-2",
            owns: ["README.md"],
            brief: "Add one section that links docs/FLEET_DEMO.md.",
            done: ["README.md links the doc"],
            state: "planned",
            attempts: 0,
          },
        ];
        o.status = autoApprove ? "running" : "awaiting_approval";
        o.trace.push({ ts: mockIso(0), from: "Claude (manager)", to: "CEO", what: "plan", detail: "2 work orders" });
        o.updatedAt = mockIso(0);
        if (autoApprove) mockSpawn(o);
      });
      return o;
    },
    approve(id, workOrders) {
      const o = findOrder(id);
      if (!o) return null;
      if (Array.isArray(workOrders) && workOrders.length) o.workOrders = workOrders;
      o.trace.push({ ts: mockIso(0), from: "CEO", to: "Claude (manager)", what: "approve", detail: workOrders ? "edited plan approved" : "plan approved" });
      return mockSpawn(o);
    },
    redo(id, wid) {
      const o = findOrder(id);
      const w = o && workOrdersOf(o).filter((x) => x.id === wid)[0];
      if (!w) return null;
      w.attempts = (Number(w.attempts) || 0) + 1;
      w.state = "starting";
      w.verdict = undefined;
      w.reportedAt = undefined;
      w.startedAt = mockIso(0);
      w.sessionId = "session_retry_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
      w.live = { streaming: true, lastActivity: mockIso(0), tail: ["sent back with the review notes", "attempt " + w.attempts] };
      o.status = "running";
      o.updatedAt = mockIso(0);
      o.trace.push({ ts: mockIso(0), from: "CEO", to: "jcode:" + shortSid(w.sessionId) + " (" + w.role + ")", what: "redo", detail: "brief + review notes delivered" });
      return o;
    },
    cancel(id) {
      const o = findOrder(id);
      if (!o) return null;
      if (o.status === "planning" || o.status === "awaiting_approval" || o.status === "running") o.status = "cancelled";
      o.updatedAt = mockIso(0);
      return o;
    },
    stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      attached = 0;
      for (const h of timers) clearTimeout(h);
      timers.clear();
    },
  };

  function mockSpawn(o) {
    o.status = "running";
    o.updatedAt = mockIso(0);
    o.workOrders.forEach((w, i) => {
      if (w.state === "planned" || w.state === "queued") {
        w.state = "starting";
        w.startedAt = mockIso(0);
        w.sessionId = "session_demo" + (i + 1) + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
        w.live = { streaming: true, lastActivity: mockIso(0), tail: ["visible terminal opened: jcode -p opencode-go", "delivering the work order…"] };
      }
    });
    o.trace.push({ ts: mockIso(0), from: "Claude (manager)", to: "jcode ×" + o.workOrders.length, what: "spawn", detail: o.workOrders.map((w) => w.role).join(", ") });
    return o;
  }
}

/* Once any list fetch has succeeded we know the fleet API is live on this
 * router; the shell remounts the view on every navigation, so this lives at
 * module scope (it is a fact about the router, not about one mount). */
let API_LIVE_ONCE = false;

/* One mock store per page session: the shell mounts a fresh view instance on
 * every navigation, so the sample orders (and anything you did to them) must
 * live outside the instance to behave like a real backend. */
let MOCK_SINGLETON = null;
function mockStore() {
  if (!MOCK_SINGLETON) MOCK_SINGLETON = createMockBackend();
  return MOCK_SINGLETON;
}
function dropMockStore() {
  if (MOCK_SINGLETON) {
    MOCK_SINGLETON.stop();
    MOCK_SINGLETON = null;
  }
}

/* ==================================================================== *
 * View styles (namespaced under .fleet, theme variables only)
 * ==================================================================== */

function ensureStyles() {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  /* UI-CLEAN: this view's CSS moved to public/v2/style.css (one visual system
   * for the whole dashboard), so there is nothing to inject here. */
}

/* ==================================================================== *
 * mount
 * ==================================================================== */
export function mount(el, ctx) {
  const c = ctx || {};
  const esc = typeof c.esc === "function" ? c.esc : escHtml;
  const ago = typeof c.ago === "function" ? c.ago : fallbackAgo;
  const hm = typeof c.hm === "function" ? c.hm : fallbackHm;
  const dur = typeof c.dur === "function" ? c.dur : fallbackDur;
  const api = typeof c.api === "function" ? c.api : null;
  const poll = typeof c.poll === "function" ? c.poll : fallbackPoll;
  const navigate = typeof c.navigate === "function" ? c.navigate : (h) => { window.location.hash = h; };

  ensureStyles();

  const params = c.params || {};
  const paramsOrderId = s(params.orderId || params.id);

  /* ------------------------------------------------------------ state */
  let orders = [];
  let limits = null;
  let watcher = null; // {running, intervalMs} from the list payload (real backend)
  let detail = null; // the FleetOrder currently shown
  let detailId = "";
  let loadedList = false;
  let listErr = "";
  let detailLoading = false;
  let detailErr = "";
  let detailNotFound = false; // 404 from the detail route (not a missing-route 404)
  let apiMissing = false; // GET /company/fleet answered 404: backend not landed
  let posting = false;
  let postMsg = "";
  let postErr = "";
  let actionMsg = "";
  let actionErr = "";
  let confirmCancelUntil = 0;
  let stopListPoll = null;
  let stopDetailPoll = null;
  let stopMockPaint = null;
  let disposed = false;
  let listSeq = 0;
  let detailSeq = 0;
  let lastLive = null;

  // mock=1 builds the view against the built-in sample data instead of the API.
  // The choice sticks for the page session (like a real backend would), so
  // navigating inside the view cannot silently drop it; ?mock=0 forces the API.
  const wantMock = s(params.mock) === "1" || (s(params.mock) !== "0" && !!MOCK_SINGLETON);
  let mockBackend = wantMock ? mockStore() : null;
  if (mockBackend) mockBackend.attach();

  // Work-order edits made in the approval column (keyed by work order id).
  const edits = Object.create(null);
  const removed = Object.create(null);
  let editingWid = "";
  let publishingWid = ""; // F34: the work order whose Retry publish request is in flight
  let planRevision = 0; // bumped whenever the edit UI itself changes (edit/save/remove)

  /* -------------------------------------------------------- route read */
  function currentOrderId() {
    const h = typeof location !== "undefined" ? s(location.hash) : "";
    const m = h.match(/^#\/fleet(?:\/([^/?#]+))?/);
    if (m) return m[1] ? decodeURIComponent(m[1]) : "";
    return paramsOrderId;
  }

  function queryMock() {
    const h = typeof location !== "undefined" ? s(location.hash) : "";
    const m = h.match(/[?&]mock=(\d)/);
    return m ? m[1] === "1" : null;
  }

  /* ------------------------------------------------------------ helpers */
  function dataApi(path, opts) {
    if (mockBackend) return Promise.resolve(null); // handled by the mock branch
    if (!api) return Promise.reject(new Error("api() is unavailable (public/v2/api.js not loaded)"));
    return api(path, opts);
  }

  function go(hash) {
    // Keep the data source on the URL, so a copied link shows the same thing.
    const suffix = mockBackend && !/[?&]mock=/.test(hash) ? (hash.indexOf("?") >= 0 ? "&mock=1" : "?mock=1") : "";
    const full = hash + suffix;
    if (location.hash === full) return;
    navigate(full);
  }

  function copy(text, btn) {
    const t = s(text);
    const done = () => {
      if (!btn) return;
      const old = btn.textContent;
      btn.textContent = "copied";
      setTimeout(() => { if (btn.isConnected) btn.textContent = old; }, 1500);
    };
    const legacy = () => {
      try {
        const ta = document.createElement("textarea");
        ta.value = t;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        if (ok) done();
      } catch { /* nothing else to try */ }
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t).then(done, legacy);
        return;
      }
    } catch { /* fall through to the legacy path */ }
    legacy();
  }

  /* ============================================================ mock switch */
  /** Turn the built-in sample data on/off (the hash says ?mock=1 / ?mock=0). */
  function setMock(on) {
    if (on === !!mockBackend) return;
    if (on) {
      mockBackend = mockStore();
      mockBackend.attach();
    } else if (mockBackend) {
      mockBackend.detach();
      dropMockStore();
      mockBackend = null;
    }
    if (mockBackend) startMockPaint();
    else if (stopMockPaint) {
      try { stopMockPaint(); } catch { /* ignore */ }
      stopMockPaint = null;
    }
    orders = [];
    limits = null;
    watcher = null;
    loadedList = false;
    listErr = "";
    detail = null;
    detailErr = "";
    detailLoading = false;
    apiMissing = false;
    postMsg = "";
    postErr = "";
    actionMsg = "";
    actionErr = "";
    editingWid = "";
    for (const k of Object.keys(removed)) delete removed[k];
    syncSkeleton(true);
    paint();
    scheduleMode();
  }

  /* ============================================================ LIST */
  function listSkeletonHtml() {
    return (
      '<div class="fleet" data-mode="list">' +
      '<div class="fleet-head">' +
      '<div class="grow"><div class="fleet-title">Fleet</div>' +
      '<div class="muted small">Claude plans &rarr; you approve &rarr; jcode works in visible terminals &rarr; Claude reviews. ' +
      'Every hop lands in the order\u2019s trace.</div></div>' +
      '<div class="fleet-bar"><button class="btn btn-sm" data-act="refresh-list">Refresh</button></div>' +
      "</div>" +
      '<div class="card fleet-orderbox">' +
      '<div class="card-head"><h2>What should the team do?</h2>' +
      '<span class="muted small">Claude splits it into parallel work orders with disjoint files.</span></div>' +
      '<textarea class="in" id="fleet-order-text" rows="3" placeholder="e.g. Add a README section X and a comment in file Y, split across 2 workers."></textarea>' +
      '<div class="fleet-bar mt-2">' +
      '<button class="btn btn-primary" data-act="plan" id="fleet-plan-btn">Plan it</button>' +
      '<label class="row small muted" style="gap:6px"><input type="checkbox" id="fleet-autoapprove"> auto-approve the plan</label>' +
      '<span class="grow"></span><span class="muted small" id="fleet-limits"></span>' +
      "</div>" +
      '<div class="small" id="fleet-postmsg" role="status"></div>' +
      "</div>" +
      '<div id="fleet-listwrap" class="col"></div>' +
      "</div>"
    );
  }

  function listRowHtml(o) {
    const wos = workOrdersOf(o);
    const passed = passedCount(o);
    const total = wos.length;
    const workish = wos.filter((w) => w.state === "working" || w.state === "starting").length;
    const pct = total ? Math.round((passed / total) * 100) : 0;
    const tone = o.status === "failed" ? "err" : o.status === "done" ? "ok" : total && passed === total ? "ok" : "warn";
    return (
      '<div class="fleet-row" role="button" tabindex="0" data-act="open" data-oid="' + esc(o.id) + '">' +
      '<div class="fleet-row-main">' +
      '<div class="fleet-req">' + esc(o.text || "(no order text)") + "</div>" +
      '<div class="muted small mt-1">' +
      esc(o.id) + (total ? " · " + esc(String(wos.length)) + " work orders" : "") +
      (workish ? " · " + esc(String(workish)) + " working" : "") +
      " · " + esc(ago(o.createdAt)) + " · updated " + esc(ago(o.updatedAt)) +
      "</div>" +
      "</div>" +
      '<div class="fleet-side">' +
      '<span class="' + orderPillClass(o.status) + '">' + esc(orderLabel(o.status)) + "</span>" +
      (total
        ? '<div class="fleet-prog"><span class="tiny muted nowrap">' + esc(String(passed)) + "/" + esc(String(total)) +
          " passed</span><span class=\"bar\"><span class=\"bar-fill sev-" + tone + '" style="width:' + pct + '%"></span></span></div>'
        : '<span class="tiny muted">planning…</span>') +
      "</div></div>"
    );
  }

  function updateList() {
    const wrap = el.querySelector("#fleet-listwrap");
    if (!wrap) return;
    const msg = el.querySelector("#fleet-postmsg");
    if (msg) {
      msg.className = "small" + (postErr ? " fleet-err" : " muted");
      msg.textContent = postMsg || postErr || "";
    }
    const lim = el.querySelector("#fleet-limits");
    if (lim) {
      lim.textContent = limits
        ? s(limits.running) + " of " + s(limits.maxSessions) + " session slots in use" +
          (watcher ? " · watcher " + (watcher.running ? "running" : "STOPPED") + " every " + Math.round((Number(watcher.intervalMs) || 0) / 1000) + "s" : "")
        : "";
      lim.style.color = watcher && watcher.running === false ? "var(--err)" : "";
    }
    const btn = el.querySelector("#fleet-plan-btn");
    if (btn) {
      btn.disabled = posting;
      btn.textContent = posting ? "Planning…" : "Plan it";
    }

    if (apiMissing) {
      wrap.innerHTML =
        '<div class="card">' +
        '<div class="state state-empty">' +
        '<span class="state-title">Fleet backend is not live yet</span>' +
        '<span class="muted">This view is ready; the router has no fleet routes yet ' +
        '(<span class="mono">GET /company/fleet</span> answered HTTP 404). ' +
        "FLEET-BACKEND is building <span class=\"mono\">src/company/fleet.ts</span> and the routes in " +
        '<span class="mono">src/server.ts</span>. The routes need a router restart to go live.</span>' +
        '<div class="row row-center mt-1">' +
        '<button class="btn btn-primary" data-act="refresh-list">Retry</button>' +
        '<button class="btn" data-act="show-mock">Show sample data</button>' +
        "</div></div></div>";
      return;
    }
    if (listErr && !loadedList) {
      wrap.innerHTML =
        '<div class="card fleet-err"><div class="state state-error">' +
        '<span class="state-title">Could not load orders</span>' +
        '<span class="muted wrap-any">' + esc(listErr) + "</span>" +
        '<div class="row row-center mt-1">' +
        '<button class="btn btn-primary" data-act="refresh-list">Retry</button></div>' +
        "</div></div>";
      return;
    }
    if (!loadedList) {
      wrap.innerHTML = '<div class="card"><div class="state"><span class="spinner" aria-hidden="true"></span><span>loading orders…</span></div></div>';
      return;
    }
    const rows = orders.map(listRowHtml).join("");
    wrap.innerHTML =
      (listErr ? '<div class="card fleet-err small">Could not refresh: ' + esc(listErr) + "</div>" : "") +
      '<div class="card">' +
      '<div class="card-head"><h2>Orders</h2><span class="muted small">' + esc(String(orders.length)) +
      (orders.length === 1 ? " order" : " orders") + " · newest first</span>" +
      '<span class="right row"><button class="btn btn-sm" data-act="refresh-list">Refresh</button></span></div>' +
      (rows
        ? '<div class="col">' + rows + "</div>"
        : '<div class="state state-empty"><span class="state-title">No orders yet</span>' +
          '<span class="muted">Type an order above and press <span class="mono">Plan it</span>. Claude answers with work orders you can edit before anything spawns.</span></div>') +
      "</div>";
  }

  /* ========================================================== DETAIL */
  function detailSkeletonHtml(oid) {
    return (
      '<div class="fleet" data-mode="detail" data-oid="' + esc(oid) + '">' +
      '<div class="fleet-strip">' +
      '<button class="btn btn-sm" data-act="back">&larr; Orders</button>' +
      '<span id="fleet-opill"></span>' +
      '<span class="muted small" id="fleet-ometa"></span>' +
      '<span class="grow"></span>' +
      '<button class="btn btn-sm" data-act="stop" id="fleet-stopbtn">Stop spawning</button>' +
      '<button class="btn btn-sm" data-act="refresh-detail">Refresh</button>' +
      "</div>" +
      '<div class="card"><div class="card-head"><h2 id="fleet-req"></h2></div>' +
      '<div class="small muted" id="fleet-trace-last"></div></div>' +
      '<div class="card" id="fleet-chainwrap"></div>' +
      '<div class="small" id="fleet-actionmsg" role="status"></div>' +
      '<div class="fleet-cols">' +
      '<div class="card"><div class="fleet-colhead"><h3>Plan</h3><span class="muted tiny" id="fleet-planmeta"></span></div><div id="fleet-plan"></div></div>' +
      '<div class="card"><div class="fleet-colhead"><h3>Workers</h3><span class="muted tiny">live · refreshed every ' +
      esc(String(MS_WORK / 1000)) + 's</span></div><div id="fleet-workers"></div></div>' +
      '<div class="card"><div class="fleet-colhead"><h3>Review</h3><span class="muted tiny" id="fleet-reviewmeta"></span></div><div id="fleet-review"></div></div>' +
      "</div>" +
      "</div>"
    );
  }

  /** Chain strip: CEO -> Claude -> jcode xN -> Claude -> CEO, lit to the stage. */
  function chainHtml(o) {
    const wos = workOrdersOf(o);
    const st = s(o.status);
    const nodes = [
      { label: "CEO", cls: "who-ceo", hint: "order" },
      { label: "Claude", cls: "who-claude", hint: "plan" },
      { label: "jcode ×" + (wos.length || "N"), cls: "who-worker", hint: wos.length ? wos.length + " workers" : "workers" },
      { label: "Claude", cls: "who-claude", hint: "review" },
      { label: "CEO", cls: "who-ceo", hint: "report" },
    ];
    let active = 1;
    let tone = "is-active";
    if (st === "planning") { active = 1; tone = "is-active"; }
    else if (st === "awaiting_approval") { active = 1; tone = "is-wait"; }
    else if (st === "running") { active = 2; tone = "is-active"; }
    else if (st === "reviewing") { active = 3; tone = "is-active"; }
    else if (st === "done") { active = 4; tone = "is-done"; }
    else if (st === "failed" || st === "cancelled") { active = 4; tone = "is-err"; }

    const step = Math.max(0, Math.min(4, active));
    const reviewedSomething = workOrdersOf(o).some((w) => s(w.verdict));
    const html = nodes
      .map((n, i) => {
        let state;
        if (i < step) state = "is-done";
        else if (i === step) state = tone;
        else state = "is-todo";
        if (st === "done") state = "is-done";
        // A running order whose worker already got a verdict has been through
        // the review hop once (that is how a REDO comes back).
        if (st === "running" && i === 3 && reviewedSomething) state = "is-done";
        return (
          '<span class="fleet-node ' + state + '">' +
          '<span class="who-txt ' + n.cls + '">' + esc(n.label) + "</span>" +
          '<span class="hint">' + esc(n.hint) + "</span></span>"
        );
      })
      .join('<span class="fleet-arrow">&rarr;</span>');

    const waiting = st === "awaiting_approval"
      ? '<div class="small" style="color:var(--warn);margin-top:6px">Waiting for your approval — edit or remove work orders in the Plan column, then spawn.</div>'
      : "";
    const bad = o.error
      ? '<div class="small" style="color:var(--err);margin-top:6px">' + esc(o.error) + "</div>"
      : "";
    return '<div class="fleet-chain">' + html + "</div>" + waiting + bad;
  }

  function woCardPlanHtml(o, w) {
    const editable = s(o.status) === "awaiting_approval";
    const isEditing = editable && editingWid === w.id;
    const e = edits[w.id] || {};
    const title = s(e.title !== undefined ? e.title : w.title);
    const role = s(e.role !== undefined ? e.role : w.role);
    const owns = e.owns !== undefined ? e.owns : (Array.isArray(w.owns) ? w.owns.join("\n") : s(w.owns));
    const brief = s(e.brief !== undefined ? e.brief : w.brief);
    const done = e.done !== undefined ? e.done : (Array.isArray(w.done) ? w.done.join("\n") : s(w.done));

    if (isEditing) {
      return (
        '<div class="fleet-wo" data-wid="' + esc(w.id) + '">' +
        '<div class="fleet-field"><label for="e-title-' + esc(w.id) + '">Title</label>' +
        '<input class="in in-sm" id="e-title-' + esc(w.id) + '" data-field="title" value="' + esc(title) + '"></div>' +
        '<div class="fleet-field"><label for="e-role-' + esc(w.id) + '">Role</label>' +
        '<input class="in in-sm" id="e-role-' + esc(w.id) + '" data-field="role" value="' + esc(role) + '"></div>' +
        '<div class="fleet-field"><label for="e-owns-' + esc(w.id) + '">Owns (one path per line)</label>' +
        '<textarea class="in in-sm" id="e-owns-' + esc(w.id) + '" data-field="owns" rows="2">' + esc(owns) + "</textarea></div>" +
        '<div class="fleet-field"><label for="e-brief-' + esc(w.id) + '">Brief</label>' +
        '<textarea class="in in-sm" id="e-brief-' + esc(w.id) + '" data-field="brief" rows="4">' + esc(brief) + "</textarea></div>" +
        '<div class="fleet-field"><label for="e-done-' + esc(w.id) + '">Done means (one check per line)</label>' +
        '<textarea class="in in-sm" id="e-done-' + esc(w.id) + '" data-field="done" rows="2">' + esc(done) + "</textarea></div>" +
        '<div class="fleet-bar"><button class="btn btn-sm btn-primary" data-act="wo-save" data-wid="' + esc(w.id) + '">Save</button>' +
        '<button class="btn btn-sm" data-act="wo-cancel">Cancel</button>' +
        (w.state && w.state !== "planned" ? "" : '<span class="grow"></span><button class="btn btn-sm btn-err" data-act="wo-remove" data-wid="' + esc(w.id) + '">Remove order</button>') +
        "</div></div>"
      );
    }

    const ownsList = toList(owns);
    const doneList = toList(done);
    const briefText = s(brief).trim();
    return (
      '<div class="fleet-wo" data-wid="' + esc(w.id) + '">' +
      '<div class="fleet-wo-head">' +
      '<span class="who who-worker">' + esc(role || "worker") + "</span>" +
      '<span class="fleet-wo-title grow">' + esc(title || "(untitled work order)") + "</span>" +
      '<span class="' + woPillClass(w.state) + '">' + esc(woState(w.state)) + "</span>" +
      "</div>" +
      (ownsList.length
        ? '<div class="fleet-owns muted">owns: ' + ownsList.map((p) => "<code>" + esc(p) + "</code>").join(" ") + "</div>"
        : '<div class="fleet-owns muted">owns: <em>nothing declared</em></div>') +
      (doneList.length ? '<div class="muted small">done: ' + esc(doneList.join(" · ")) + "</div>" : "") +
      (briefText
        ? '<details class="fleet-brief"><summary>brief</summary><div class="fleet-note">' + esc(briefText) + "</div></details>"
        : "") +
      (editable
        ? '<div class="fleet-bar"><button class="btn btn-sm" data-act="wo-edit" data-wid="' + esc(w.id) + '">Edit</button>' +
          '<button class="btn btn-sm btn-err" data-act="wo-remove" data-wid="' + esc(w.id) + '">Remove</button></div>'
        : "") +
      "</div>"
    );
  }

  function planHtml(o) {
    const wos = workOrdersOf(o);
    const editable = s(o.status) === "awaiting_approval";
    if (s(o.status) === "planning") {
      return '<div class="state"><span class="spinner" aria-hidden="true"></span><span>Claude is planning… (split into parallel work orders)</span></div>';
    }
    const spec = s(o.specDoc);
    const specHtml = spec
      ? '<details class="small muted mt-1"><summary>Contract document</summary>' +
        (/^https?:/.test(spec)
          ? '<a href="' + esc(spec) + '" target="_blank" rel="noopener">' + esc(spec) + "</a>"
          : "<code>" + esc(spec) + "</code>") +
        '<button class="btn btn-sm" data-act="copy" data-copy="' + esc(spec) + '" style="margin-left:6px">Copy path</button></details>'
      : "";
    const keep = wos.filter((w) => !removed[w.id]);
    return (
      (s(o.plan) ? '<div class="fleet-note">' + esc(o.plan) + "</div>" : '<div class="muted small">No plan text.</div>') +
      specHtml +
      '<hr class="divider">' +
      '<div class="card-head" style="margin-bottom:6px"><h3>Work orders</h3>' +
      '<span class="muted tiny">' + esc(String(keep.length)) + " to spawn" +
      (wos.length !== keep.length ? " (" + esc(String(wos.length - keep.length)) + " removed)" : "") + "</span></div>" +
      (keep.length
        ? '<div class="col">' + keep.map((w) => woCardPlanHtml(o, w)).join("") + "</div>"
        : '<div class="state state-empty"><span class="state-title">Every work order was removed</span>' +
          '<span class="muted">Add the plan back by cancelling this order and planning again.</span></div>') +
      (editable
        ? '<div class="fleet-bar mt-2">' +
          '<button class="btn btn-primary" data-act="approve"' + (keep.length ? "" : " disabled") + ">Approve &amp; spawn " +
          esc(String(keep.length)) + (keep.length === 1 ? " worker" : " workers") + "</button>" +
          '<span class="muted tiny">opens one visible jcode terminal per work order</span></div>'
        : "")
    );
  }

  function tailHtml(w) {
    const live = w.live || {};
    const tail = Array.isArray(live.tail) ? live.tail.slice(-TAIL_LINES) : [];
    if (!tail.length) {
      return '<div class="fleet-tail muted">' + (live.streaming ? "streaming…" : "no activity yet") + "</div>";
    }
    return (
      '<div class="fleet-tail mono">' +
      tail.map((l, i) => '<span class="ln' + (i < tail.length - 1 ? " dim" : "") + '">' + esc(l) + "</span>").join("") +
      "</div>"
    );
  }

  function elapsedMs(w) {
    const start = new Date(w.startedAt || "").getTime();
    if (!isFinite(start)) return 0;
    const end = w.reportedAt ? new Date(w.reportedAt).getTime() : Date.now();
    return isFinite(end) && end > start ? end - start : 0;
  }

  // F34 (docs/ORDER_2026-10-06_f34-retry-strip.md): the GitHub state of one work order - its
  // branch, its draft PR and the CI verdict the tick last read. The trace lives on the order, so
  // a hop is attributed to a work order by the branch name in its detail; a work order with no
  // branch and no GitHub hop has no GitHub activity and renders nothing.
  function githubHopsFor(o, w) {
    const tr = o && Array.isArray(o.trace) ? o.trace : [];
    const gh = tr.filter((h) => s(h.to).trim() === "GitHub");
    const branch = s(w && w.branch).trim();
    if (!branch) return [];
    const mine = gh.filter((h) => s(h.detail).indexOf(branch) >= 0);
    return mine.length ? mine : gh;
  }

  /** The CI verdict in plain words (fleetGithub's RED/GREEN/PENDING). */
  function ciWords(state) {
    const v = s(state).toUpperCase();
    if (v === "GREEN") return "checks: passing";
    if (v === "RED") return "checks: failing";
    return "checks: not reported yet";
  }

  function githubStripHtml(o, w) {
    const branch = s(w && w.branch).trim();
    const hops = githubHopsFor(o, w);
    if (!branch && !hops.length) return ""; // no GitHub activity for this work order
    const prUrl = s(w && w.prUrl).trim();
    const last = hops.length ? hops[hops.length - 1] : null;
    const failed = !!last && s(last.what).trim() === "PR publish failed";
    const checked = s(w && w.ciCheckedAt);
    const busy = publishingWid === s(w.id);
    return (
      '<div class="muted small fleet-github">' +
      (branch ? 'branch <code class="mono">' + esc(branch) + "</code>" : "<span>no branch yet</span>") +
      (prUrl
        ? ' · <a href="' + esc(prUrl) + '" target="_blank" rel="noopener">pull request</a> (draft)'
        : " · draft pull request not opened") +
      " · " + esc(ciWords(w && w.ciState)) +
      (checked ? ' <span class="tiny">(checked ' + esc(ago(checked)) + ")</span>" : "") +
      (failed
        ? '<div class="fleet-note" style="color:var(--err)">PR publish failed: ' + esc(s(last.detail) || "no reason recorded") + "</div>" +
          '<div class="fleet-bar">' +
          '<button class="btn btn-sm" data-act="publish" data-wid="' + esc(w.id) + '"' + (busy ? " disabled" : "") + ">" +
          (busy ? "Publishing…" : "Retry publish") + "</button>" +
          '<span class="muted tiny">reuses the existing branch (never a force push) and opens the draft PR</span></div>'
        : "") +
      "</div>"
    );
  }

  function workerCardHtml(o, w) {
    const live = w.live || {};
    const st = woState(w.state);
    const streaming = live.streaming === true;
    const canRedo = s(w.verdict).toUpperCase() === "REDO";
    return (
      '<div class="fleet-wo" data-wid="' + esc(w.id) + '">' +
      '<div class="fleet-wo-head">' +
      '<span class="who who-worker">' + esc(w.role || "worker") + "</span>" +
      '<span class="' + woPillClass(w.state) + '">' + (streaming ? '<span class="dot dot-run"></span>' : "") + esc(st) + "</span>" +
      (Number(w.attempts) > 1 ? '<span class="pill pill-dim">attempt ' + esc(String(w.attempts)) + "</span>" : "") +
      (s(w.verdict) ? '<span class="' + verdictPillClass(w.verdict) + '">' + esc(s(w.verdict).toUpperCase()) + "</span>" : "") +
      "</div>" +
      '<div class="fleet-wo-title">' + esc(w.title || w.id) + "</div>" +
      '<div class="muted small">' +
      (w.sessionId
        ? 'session <span class="mono" title="' + esc(w.sessionId) + '">' + esc(shortSid(w.sessionId)) + "</span>"
        : "no session yet") +
      (w.startedAt ? " · started " + esc(hm(w.startedAt)) + " (" + esc(dur(elapsedMs(w))) + ")" : "") +
      (w.windowPid ? " · pid " + esc(String(w.windowPid)) : "") +
      "</div>" +
      '<div class="muted tiny">' +
      (live.lastActivity ? "last activity " + esc(ago(live.lastActivity)) : "no activity recorded") +
      (streaming ? ' · <span style="color:var(--accent)">generating</span>' : "") +
      (w.delivery && w.delivery.how ? " · brief delivered: " + esc(w.delivery.how) : "") +
      "</div>" +
      (s(w.error) ? '<div class="fleet-note" style="color:var(--err)">' + esc(w.error) + "</div>" : "") +
      githubStripHtml(o, w) +
      tailHtml(w) +
      (canRedo
        ? '<div class="fleet-bar"><button class="btn btn-sm btn-err" data-act="redo" data-wid="' + esc(w.id) + '">Send back (redo)</button>' +
          '<span class="muted tiny">spawns a fresh session with the review notes</span></div>'
        : "") +
      "</div>"
    );
  }

  function workersHtml(o) {
    const wos = workOrdersOf(o);
    if (!wos.length) return '<div class="muted small">No workers yet — the plan has not been approved.</div>';
    return '<div class="col">' + wos.map((w) => workerCardHtml(o, w)).join("") + "</div>";
  }

  function reviewHtml(o) {
    const wos = workOrdersOf(o);
    const withReview = wos.filter((w) => s(w.review) || s(w.verdict) || w.state === "reported" || w.state === "reviewed");
    const passed = passedCount(o);
    const parts = [];
    parts.push(
      '<div class="muted small">' + esc(String(passed)) + " of " + esc(String(wos.length)) + " passed" +
      (s(o.status) === "done" ? " — order done." : "") + "</div>"
    );
    if (withReview.length) {
      parts.push(
        withReview
          .map((w) => {
            const v = s(w.verdict).toUpperCase();
            const cls = v === "PASS" ? "is-ok" : v === "REDO" ? "is-err" : "";
            return (
              '<div class="fleet-reviewitem ' + cls + '">' +
              '<div class="fleet-wo-head"><span class="who who-worker">' + esc(w.role || "worker") + "</span>" +
              '<span class="grow fleet-wo-title">' + esc(w.title || w.id) + "</span>" +
              (v ? '<span class="' + verdictPillClass(v) + '">' + esc(v) + "</span>" : '<span class="pill pill-warn">awaiting review</span>') +
              "</div>" +
              (s(w.review) ? '<div class="fleet-note">' + esc(w.review) + "</div>" : "") +
              '<details class="small muted"><summary>Report file</summary><code>' + esc(reportPath(o.id, w.id, w)) + "</code>" +
              '<button class="btn btn-sm" data-act="copy" data-copy="' + esc(reportPath(o.id, w.id, w)) + '" style="margin-left:6px">Copy path</button>' +
              "</details></div>"
            );
          })
          .join("")
      );
    } else {
      parts.push('<div class="muted small">Nothing reviewed yet. Each worker writes REPORT.md; Claude then returns PASS or REDO with reasons.</div>');
    }
    if (s(o.status) === "done") {
      parts.push(
        s(o.summary)
          ? '<div class="fleet-note" style="color:var(--ok)">' + esc(o.summary) + "</div>"
          : '<div class="small" style="color:var(--ok)">All work orders passed. The assistant thread gets a summary; Slack gets it via the report-back bridge.</div>',
      );
    }
    return parts.join("");
  }

  function reportPath(orderId, wid, wo) {
    // The API sends a repo-relative reportPath (src/company/fleet.ts); fall back
    // to the documented location if an older payload omits it.
    const fromApi = s(wo && wo.reportPath);
    return fromApi || "company/fleet/" + s(orderId) + "/" + s(wid) + "/REPORT.md";
  }

  function updateDetail() {
    const o = detail;
    const pillEl = el.querySelector("#fleet-opill");
    const meta = el.querySelector("#fleet-ometa");
    const reqEl = el.querySelector("#fleet-req");
    const lastTrace = el.querySelector("#fleet-trace-last");
    const stopBtn = el.querySelector("#fleet-stopbtn");
    const actionEl = el.querySelector("#fleet-actionmsg");
    if (!pillEl) return;

    if (actionEl) {
      actionEl.className = "small" + (actionErr ? " fleet-err" : " muted");
      actionEl.textContent = actionMsg || actionErr || "";
    }

    if (!o) {
      const chain = el.querySelector("#fleet-chainwrap");
      const plan = el.querySelector("#fleet-plan");
      const workers = el.querySelector("#fleet-workers");
      const review = el.querySelector("#fleet-review");
      if (detailLoading && !detailErr) {
        if (chain) chain.innerHTML = '<div class="state"><span class="spinner" aria-hidden="true"></span><span>loading order…</span></div>';
        if (plan) plan.innerHTML = "";
        if (workers) workers.innerHTML = "";
        if (review) review.innerHTML = "";
        pillEl.innerHTML = "";
        if (meta) meta.textContent = "";
        if (reqEl) reqEl.textContent = "";
        if (lastTrace) lastTrace.textContent = "";
        if (stopBtn) stopBtn.hidden = true;
        return;
      }
      const html =
        '<div class="state ' + (detailErr ? "state-error" : "state-empty") + '">' +
        '<span class="state-title">' + (detailNotFound ? "Order not found" : detailErr ? "Could not load this order" : "Order not found") + "</span>" +
        '<span class="muted wrap-any">' + esc(detailErr || detailId) + "</span>" +
        '<div class="row row-center mt-1">' +
        '<button class="btn btn-primary" data-act="refresh-detail">Retry</button>' +
        '<button class="btn" data-act="back">&larr; Orders</button></div></div>';
      if (chain) chain.innerHTML = html;
      if (plan) plan.innerHTML = "";
      if (workers) workers.innerHTML = "";
      if (review) review.innerHTML = "";
      pillEl.innerHTML = "";
      if (meta) meta.textContent = "";
      if (reqEl) reqEl.textContent = detailErr ? "Order " + detailId : "Order " + detailId + " not found";
      if (lastTrace) lastTrace.textContent = "";
      if (stopBtn) stopBtn.hidden = true;
      return;
    }

    const wos = workOrdersOf(o);
    pillEl.innerHTML =
      '<span class="' + orderPillClass(o.status) + ' pill-lg">' + esc(orderLabel(o.status)) + "</span>";
    if (meta) {
      meta.textContent =
        s(o.id) + " · " + wos.length + " work orders · " + passedCount(o) + " passed · created " + ago(o.createdAt) + " · updated " + ago(o.updatedAt);
    }
    if (reqEl) reqEl.textContent = s(o.text) || "(no order text)";

    if (lastTrace) {
      const tr = Array.isArray(o.trace) ? o.trace : [];
      const last = tr[tr.length - 1];
      // RESUME (docs/RESUME_SPEC.md §4): restart hops (written by the Router) render
      // muted with a restart icon, exactly like the Flow page, so a restart the CEO
      // slept through is visible here instead of looking like normal traffic.
      const restarts = tr.filter(isRestartHop).length;
      const hopCount = tr.length > 1 ? ' <span class="muted tiny">(' + tr.length + " hops)</span>" : "";
      lastTrace.innerHTML = last
        ? (isRestartHop(last)
            ? '<span class="fleet-restart">' + RESTART_ICON + " restarted " + esc(hm(last.ts)) + ": " +
              esc(last.what) + " → " + esc(last.to) + "</span>" + hopCount
            : esc("last hop " + hm(last.ts) + ": " + last.from + " → " + last.what + " → " + last.to) + hopCount +
              (restarts ? ' <span class="fleet-restart">' + RESTART_ICON + " restarted ×" + restarts + "</span>" : ""))
        : "no trace recorded yet";
    }

    if (stopBtn) {
      const stoppable = o.status === "planning" || o.status === "awaiting_approval" || o.status === "running";
      stopBtn.hidden = !stoppable;
      stopBtn.classList.toggle("btn-err", Date.now() < confirmCancelUntil);
      stopBtn.textContent = Date.now() < confirmCancelUntil ? "Click again to stop" : "Stop spawning";
    }

    const chain = el.querySelector("#fleet-chainwrap");
    if (chain) chain.innerHTML = chainHtml(o);

    const plan = el.querySelector("#fleet-plan");
    const planKey = planSignature(o);
    if (plan && plan.getAttribute("data-sig") !== planKey) {
      // The signature covers the order data AND the edit/add-remove state, so
      // this re-renders when the CEO opens/cancels the editor but never while
      // they are just typing (typing only touches the edit buffer).
      plan.innerHTML = planHtml(o);
      plan.setAttribute("data-sig", planKey);
    }
    const planMeta = el.querySelector("#fleet-planmeta");
    if (planMeta) {
      planMeta.textContent = s(o.status) === "awaiting_approval" ? "editable until you spawn" : "";
    }

    const workers = el.querySelector("#fleet-workers");
    if (workers) {
      workers.innerHTML = workersHtml(o);
      // Live tail: always show the newest line.
      workers.querySelectorAll(".fleet-tail").forEach((t) => {
        t.scrollTop = t.scrollHeight;
      });
    }

    const review = el.querySelector("#fleet-review");
    if (review) review.innerHTML = reviewHtml(o);
    const reviewMeta = el.querySelector("#fleet-reviewmeta");
    if (reviewMeta) reviewMeta.textContent = wos.length ? passedCount(o) + "/" + wos.length + " PASS" : "";
  }

  /** Changes here mean the Plan column's content (not just its state) changed. */
  function planSignature(o) {
    const wos = workOrdersOf(o);
    return [
      s(o.status),
      s(o.plan).length,
      s(o.specDoc),
      wos.map((w) => [w.id, w.title, w.role, (w.owns || []).join("|"), w.state, w.attempts].join("~")).join("§"),
      Object.keys(removed).join(","),
      editingWid,
      planRevision,
    ].join("|");
  }

  /* ======================================================= data layer */
  function armList(ms) {
    if (stopListPoll) { try { stopListPoll(); } catch { /* ignore */ } stopListPoll = null; }
    if (disposed) return;
    stopListPoll = poll(() => tickList(), ms);
  }

  function armDetail(ms) {
    if (stopDetailPoll) { try { stopDetailPoll(); } catch { /* ignore */ } stopDetailPoll = null; }
    if (disposed) return;
    stopDetailPoll = poll(() => tickDetail(), ms);
  }

  async function tickList() {
    if (disposed) return;
    const mine = ++listSeq;
    if (mockBackend) {
      const d = mockBackend.list();
      if (disposed || mine !== listSeq) return;
      orders = d.orders;
      limits = d.limits;
      listErr = "";
      loadedList = true;
      apiMissing = false;
      updateList();
      return;
    }
    try {
      const d = await dataApi("/company/fleet?limit=" + LIST_LIMIT);
      if (disposed || mine !== listSeq) return;
      const list = Array.isArray(d) ? d : Array.isArray(d && d.orders) ? d.orders : [];
      orders = list;
      limits = (d && d.limits) || null;
      watcher = (d && d.watcher) || null;
      listErr = "";
      apiMissing = false;
      API_LIVE_ONCE = true;
      loadedList = true;
    } catch (e) {
      if (disposed || mine !== listSeq) return;
      if (isMissing(e)) apiMissing = true;
      else listErr = errText(e);
      loadedList = true;
    }
    if (currentOrderId()) return; // the detail view owns the screen
    updateList();
  }

  async function tickDetail() {
    if (disposed) return;
    const oid = currentOrderId();
    if (!oid) return;
    const mine = ++detailSeq;
    if (mockBackend) {
      const d = mockBackend.detail(oid);
      if (disposed || mine !== detailSeq) return;
      detail = d && d.order ? d.order : d;
      detailErr = detail ? "" : "No order with id " + oid + " in the sample data.";
      detailLoading = false;
      updateDetail();
      return;
    }
    try {
      const d = await dataApi("/company/fleet/orders/" + encodeURIComponent(oid));
      if (disposed || mine !== detailSeq) return;
      detail = (d && d.order) || d || null;
      if (d && d.limits) limits = d.limits;
      if (detail && !Array.isArray(detail.workOrders)) detail.workOrders = [];
      detailErr = detail ? "" : "The router answered, but there is no order " + oid + ".";
      detailLoading = false;
    } catch (e) {
      if (disposed || mine !== detailSeq) return;
      const status = Number(e && e.status) || 0;
      if (status === 404 && !API_LIVE_ONCE) {
        // A deep link never polls the list, so ask once whether the fleet routes
        // exist at all: "no such order" must not be confused with "no API yet".
        try {
          await dataApi("/company/fleet?limit=1");
          if (!disposed) API_LIVE_ONCE = true;
        } catch {
          /* routes still missing, or the router is unreachable */
        }
        if (disposed || mine !== detailSeq) return;
      }
      detail = null;
      detailLoading = false;
      detailNotFound = status === 404 && API_LIVE_ONCE;
      detailErr = detailNotFound
        ? "No fleet order " + oid + " on this router (the API answered 404). It may have been created by another session or removed."
        : isMissing(e)
          ? "HTTP 404 — the fleet routes are not live on this router yet. FLEET-BACKEND owns them; a router restart is needed once they land."
          : errText(e);
    }
    updateDetail();
    const live = isOrderLive(detail);
    if (live !== lastLive) {
      lastLive = live;
      armDetail(live ? MS_WORK : MS_WORK_IDLE);
    }
  }

  /* ========================================================== actions */
  async function planOrder() {
    const ta = el.querySelector("#fleet-order-text");
    const auto = !!(el.querySelector("#fleet-autoapprove") && el.querySelector("#fleet-autoapprove").checked);
    const text = s(ta && ta.value).trim();
    if (!text) {
      postErr = "Type what the team should do first.";
      postMsg = "";
      updateList();
      if (ta) ta.focus();
      return;
    }
    posting = true;
    postErr = "";
    postMsg = "";
    updateList();
    try {
      const created = mockBackend
        ? mockBackend.create(text, auto)
        : await dataApi("/company/fleet/orders", { method: "POST", body: { text, autoApprove: auto } });
      if (disposed) return;
      const id = s(created && created.id);
      postMsg = id ? "Order " + id + " created — Claude is planning." : "Order created — Claude is planning.";
      if (ta) ta.value = "";
      await tickList();
      if (id) go("#/fleet/" + encodeURIComponent(id));
    } catch (e) {
      if (disposed) return;
      postErr = "Could not create the order: " + errText(e);
    } finally {
      posting = false;
      updateList();
    }
  }

  function collectedWorkOrders(o) {
    return workOrdersOf(o)
      .filter((w) => !removed[w.id])
      .map((w) => {
        const e = edits[w.id] || {};
        return {
          id: w.id,
          title: s(e.title !== undefined ? e.title : w.title),
          role: s(e.role !== undefined ? e.role : w.role),
          owns: toList(e.owns !== undefined ? e.owns : w.owns),
          brief: s(e.brief !== undefined ? e.brief : w.brief),
          done: toList(e.done !== undefined ? e.done : w.done),
          state: w.state || "planned",
          attempts: Number(w.attempts) || 0,
        };
      });
  }

  async function approveOrder() {
    const oid = currentOrderId();
    const o = detail;
    if (!oid || !o) return;
    const wos = collectedWorkOrders(o);
    if (!wos.length) {
      actionErr = "Nothing to spawn: every work order was removed.";
      actionMsg = "";
      updateDetail();
      return;
    }
    actionErr = "";
    actionMsg = "Spawning " + wos.length + " worker" + (wos.length === 1 ? "" : "s") + "…";
    updateDetail();
    try {
      if (mockBackend) mockBackend.approve(oid, wos);
      else await dataApi("/company/fleet/orders/" + encodeURIComponent(oid) + "/approve", { method: "POST", body: { workOrders: wos } });
      if (disposed) return;
      editingWid = "";
      for (const k of Object.keys(removed)) delete removed[k];
      actionMsg = "Approved. " + wos.length + " visible terminal" + (wos.length === 1 ? "" : "s") + " opening — watch the Workers column.";
      await tickDetail();
      await tickList();
      armDetail(MS_WORK);
    } catch (e) {
      if (disposed) return;
      actionErr = "Approve failed: " + errText(e);
      actionMsg = "";
    }
    updateDetail();
  }

  async function redoWorkOrder(wid) {
    const oid = currentOrderId();
    if (!oid || !wid) return;
    actionErr = "";
    actionMsg = "Sending " + wid + " back with the review notes…";
    updateDetail();
    try {
      if (mockBackend) mockBackend.redo(oid, wid);
      else await dataApi("/company/fleet/orders/" + encodeURIComponent(oid) + "/work/" + encodeURIComponent(wid) + "/redo", { method: "POST", body: {} });
      if (disposed) return;
      await tickDetail(); // refresh first, so the attempt number in the message is real
      const w2 = workOrdersOf(detail).filter((w) => w.id === wid)[0];
      const attempt = w2 ? Number(w2.attempts) || 0 : 0;
      actionMsg =
        "Sent back. A fresh session is starting for " + wid +
        (attempt ? " (attempt " + attempt + ")" : "") + ", with the review notes as the brief.";
      armDetail(MS_WORK);
    } catch (e) {
      if (disposed) return;
      actionErr = "Redo failed: " + errText(e);
      actionMsg = "";
    }
    updateDetail();
  }

  // F34: retry the draft-PR publish for a work order whose PR step failed (the ordered route).
  async function retryPublish(wid) {
    const oid = currentOrderId();
    if (!oid || !wid) return;
    const w = workOrdersOf(detail).filter((x) => x.id === wid)[0];
    const branch = s(w && w.branch).trim();
    const confirmed =
      typeof window === "undefined" || typeof window.confirm !== "function"
        ? true
        : window.confirm(
            "Publish " + wid + " again" + (branch ? " on " + branch : "") +
              "?\n\nThis pushes the existing branch (never a force push) and opens the draft pull request.",
          );
    if (!confirmed) return;
    actionErr = "";
    actionMsg = "Publishing " + wid + "…";
    publishingWid = s(wid);
    updateDetail();
    let out = null;
    try {
      out = await dataApi(
        "/company/fleet/orders/" + encodeURIComponent(oid) + "/work/" + encodeURIComponent(wid) + "/publish",
        { method: "POST", body: {} },
      );
      if (disposed) return;
      await tickDetail();
      const w2 = workOrdersOf(detail).filter((x) => x.id === wid)[0];
      if (out && out.ok === false) {
        actionErr = "Publish refused: " + s(out.reason);
        actionMsg = "";
      } else if (s(w2 && w2.prUrl)) {
        actionMsg = "Published. Draft pull request: " + s(w2.prUrl);
      } else {
        actionMsg =
          "Published " + wid + (s(w2 && w2.branch) ? " on " + s(w2.branch) : "") +
          ". No pull request was opened: see the order trace.";
      }
      armDetail(MS_WORK);
    } catch (e) {
      if (disposed) return;
      actionErr = "Publish failed: " + errText(e);
      actionMsg = "";
    } finally {
      publishingWid = "";
    }
    updateDetail();
  }

  async function cancelOrder(btn) {
    const oid = currentOrderId();
    if (!oid) return;
    if (Date.now() >= confirmCancelUntil) {
      confirmCancelUntil = Date.now() + 5000;
      actionMsg = "Queued work will stop spawning. Running terminals are NOT closed — close them yourself.";
      actionErr = "";
      updateDetail();
      setTimeout(() => { if (!disposed) updateDetail(); }, 5100);
      return;
    }
    confirmCancelUntil = 0;
    try {
      if (mockBackend) mockBackend.cancel(oid);
      else await dataApi("/company/fleet/orders/" + encodeURIComponent(oid) + "/cancel", { method: "POST", body: {} });
      if (disposed) return;
      actionMsg = "Stopped spawning queued work for " + oid + ".";
      actionErr = "";
      await tickDetail();
      await tickList();
      if (btn) btn.hidden = true;
    } catch (e) {
      if (disposed) return;
      actionErr = "Stop failed: " + errText(e);
      actionMsg = "";
    }
    updateDetail();
  }

  /* ============================================================ render */
  function syncSkeleton(force) {
    const oid = currentOrderId();
    const mode = oid ? "detail" : "list";
    const cur = el.querySelector(".fleet");
    const curMode = cur ? cur.getAttribute("data-mode") : "";
    const curOid = cur ? s(cur.getAttribute("data-oid")) : "";
    if (!force && cur && curMode === mode && curOid === oid) return false;
    if (oid) detailId = oid;
    el.innerHTML = mode === "detail" ? detailSkeletonHtml(oid) : listSkeletonHtml();
    return true;
  }

  function paint() {
    if (disposed) return;
    const fresh = syncSkeleton();
    if (currentOrderId()) {
      if (fresh) {
        detail = null;
        detailErr = "";
        detailNotFound = false;
        detailLoading = true;
        const chain = el.querySelector("#fleet-chainwrap");
        if (chain) chain.innerHTML = '<div class="state"><span class="spinner" aria-hidden="true"></span><span>loading order…</span></div>';
      }
      updateDetail();
    } else {
      updateList();
    }
  }

  function scheduleMode() {
    const oid = currentOrderId();
    if (oid) {
      if (stopListPoll) { try { stopListPoll(); } catch { /* ignore */ } stopListPoll = null; }
      lastLive = null;
      if (!detail) detailLoading = true;
      armDetail(MS_WORK);
      tickDetail();
    } else {
      if (stopDetailPoll) { try { stopDetailPoll(); } catch { /* ignore */ } stopDetailPoll = null; }
      editingWid = "";
      armList(MS_LIST);
      tickList();
    }
  }

  /* ============================================================ events */
  function onInput(e) {
    const t = e.target;
    if (!t || !t.getAttribute) return;
    const field = t.getAttribute("data-field");
    if (!field) return;
    const card = t.closest ? t.closest("[data-wid]") : null;
    if (!card) return;
    const wid = card.getAttribute("data-wid");
    if (!wid) return;
    const cur = edits[wid] || {};
    cur[field] = t.value;
    edits[wid] = cur;
  }

  function onKey(e) {
    const t = e.target;
    const isRow = t && t.closest && t.closest('[data-act="open"]');
    if (isRow && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      const oid = isRow.getAttribute("data-oid");
      if (oid) go("#/fleet/" + encodeURIComponent(oid));
      return;
    }
    // Ctrl/Cmd+Enter in the order box plans it.
    if (t && t.id === "fleet-order-text" && e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      planOrder();
    }
  }

  function onClick(e) {
    const node = e.target && e.target.closest ? e.target.closest("[data-act]") : null;
    if (!node) return;
    const act = node.getAttribute("data-act");
    switch (act) {
      case "open": {
        const oid = node.getAttribute("data-oid");
        if (oid) go("#/fleet/" + encodeURIComponent(oid));
        return;
      }
      case "back": {
        go("#/fleet");
        return;
      }
      case "refresh-list": {
        tickList();
        return;
      }
      case "refresh-detail": {
        tickDetail();
        return;
      }
      case "show-mock": {
        go("#/fleet?mock=1");
        return;
      }
      case "plan": {
        planOrder();
        return;
      }
      case "approve": {
        approveOrder();
        return;
      }
      case "redo": {
        redoWorkOrder(node.getAttribute("data-wid"));
        return;
      }
      case "publish": {
        retryPublish(node.getAttribute("data-wid"));
        return;
      }
      case "stop": {
        cancelOrder(node);
        return;
      }
      case "copy": {
        copy(node.getAttribute("data-copy"), node);
        return;
      }
      case "wo-edit": {
        editingWid = node.getAttribute("data-wid");
        planRevision += 1;
        updateDetail();
        return;
      }
      case "wo-cancel": {
        editingWid = "";
        planRevision += 1;
        updateDetail();
        return;
      }
      case "wo-save": {
        const wid = node.getAttribute("data-wid");
        const card = node.closest ? node.closest("[data-wid]") : null;
        if (card && wid) {
          const cur = edits[wid] || {};
          card.querySelectorAll("[data-field]").forEach((f) => {
            cur[f.getAttribute("data-field")] = f.value;
          });
          edits[wid] = cur;
        }
        editingWid = "";
        planRevision += 1;
        updateDetail();
        return;
      }
      case "wo-remove": {
        const wid = node.getAttribute("data-wid");
        if (!wid) return;
        removed[wid] = true;
        if (editingWid === wid) editingWid = "";
        planRevision += 1;
        updateDetail();
        return;
      }
      default:
        return;
    }
  }

  function onHash() {
    if (disposed) return;
    const m = queryMock();
    if (m !== null && m !== (mockBackend ? 1 : 0)) {
      // mock=0/1 in the hash swaps the data source: reset and refetch.
      setMock(m === 1);
      return;
    }
    paint();
    scheduleMode();
  }

  /* Mock only: repaint so the simulated journals/verdicts move on screen. */
  function startMockPaint() {
    if (stopMockPaint) return;
    const h = setInterval(() => {
      if (disposed || document.hidden) return;
      if (currentOrderId()) tickDetail();
      else tickList();
    }, 2200);
    stopMockPaint = () => clearInterval(h);
  }

  /* ============================================================== boot */
  el.addEventListener("click", onClick);
  el.addEventListener("input", onInput);
  el.addEventListener("keydown", onKey);
  if (typeof window !== "undefined") window.addEventListener("hashchange", onHash);

  if (!api && !mockBackend) {
    apiMissing = true;
    loadedList = true;
    listErr = "api() is unavailable (public/v2/api.js not loaded).";
  }

  paint();
  scheduleMode();
  if (mockBackend) startMockPaint();

  const currentCleanup = () => {
    disposed = true;
    if (stopListPoll) { try { stopListPoll(); } catch { /* ignore */ } stopListPoll = null; }
    if (stopDetailPoll) { try { stopDetailPoll(); } catch { /* ignore */ } stopDetailPoll = null; }
    if (stopMockPaint) { try { stopMockPaint(); } catch { /* ignore */ } stopMockPaint = null; }
    if (mockBackend) mockBackend.detach();
    el.removeEventListener("click", onClick);
    el.removeEventListener("input", onInput);
    el.removeEventListener("keydown", onKey);
    if (typeof window !== "undefined") window.removeEventListener("hashchange", onHash);
    el.innerHTML = "";
  };

  return currentCleanup;
}
