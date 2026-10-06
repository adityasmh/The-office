// SYSTEM view: the CEO's "shut down everything / start everything again" page.
//
// Route:  #/system
// Spec:   docs/SHUTDOWN_SPEC.md §3-§4 (owned by the jcode session SHUTDOWN)
// Contract (docs/UI_V2_SPEC.md): export const title, export function mount(el, ctx) -> cleanup().
// ctx = { api, poll, esc, ago, hm, navigate, params }.
//
// What it shows and does:
//   1. status panel: router, Laya, the shared jcode server, the supervisor task, how many
//      terminals are alive, opencode workers, free RAM;
//   2. a red "Shut down everything" button -> a confirm dialog that lists EXACTLY what will
//      close (each terminal re-verified by the backend) and says "each terminal saves a
//      checkpoint first (~90 s)" -> then a progress view (checkpoints arriving, terminal by
//      terminal) -> and when the router stops answering, the final screen:
//      "Everything is off. To start again, double-click 'Start Laya Company' on your Desktop."
//   3. the latest snapshots (time + counts), each with per-terminal checkboxes (all ticked)
//      and a "Resume all" button (plus a per-terminal Resume);
//   4. "Snapshot now" (no shutdown).
//
// API used (all in src/server.ts, reads are loopback-exempt, writes need x-company-token):
//   GET  /company/system/status            systemStatus()
//   GET  /company/system/close-plan        closePlan()   (what the confirm dialog lists)
//   GET  /company/system/snapshots         { snapshots:[summary], knobs, resume }
//   GET  /company/system/snapshots/:ts     { summary, terminals:[{...resumeBrief}] }
//   GET  /company/system/shutdown/status   { phase, steps, checkpointsArrived, ... }
//   GET  /company/system/resume/status     ResumeResult | null
//   POST /company/system/snapshot          { checkpoints?:bool }
//   POST /company/system/shutdown          { confirm:true }
//   POST /company/system/resume            { sessionIds:[...], snapshotTs }
//
// LAYA-CTL/U-X (the "Laya (decision model)" panel):
//   GET  /company/laya                     { ok, device, checkpointDevices, cpuFallbacks,
//                                             pids, gpu, layaGpuMiB, requestedDevice,
//                                             starting, lastStartError, gpuHeadroom,
//                                             fallbackNotice, gpuUsers, gpuUsersReason }
//   POST /company/laya/stop                stop ONLY Laya's python processes
//   POST /company/laya/start               { device: "gpu" | "cpu" }
//   POST /company/laya/switch              { device } - stop, wait for health down, then start
//                                          the other device as one action

export const title = "System";

const STATUS_MS = 4000; // status panel refresh
const PROGRESS_MS = 2000; // while a shutdown is running
const RESUME_MS = 3000; // while terminals are being resumed
const STYLE_ID = "system-view-style";
const LS_OFF = "laya.system.offAt"; // set when we watched the router die under a shutdown

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
    return isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}

function fallbackPoll(fn, ms) {
  const h = setInterval(() => { if (!document.hidden) fn(); }, ms);
  return () => clearInterval(h);
}

function msg(e) {
  if (!e) return "unknown error";
  if (e.status) return "HTTP " + e.status + (e.message ? ": " + e.message : "");
  return e.message || String(e);
}

function mb(n) {
  const v = Number(n);
  if (!isFinite(v)) return "?";
  return v >= 1024 ? (v / 1024).toFixed(1) + " GB" : Math.round(v) + " MB";
}

// LAYA-UX helpers: plain words for a device, and mm:ss for the elapsed load time.
function deviceWord(d) {
  return d === "cpu" ? "CPU" : d === "gpu" ? "GPU" : "unknown";
}
function fmtElapsed(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return (m < 10 ? "0" : "") + m + ":" + (r < 10 ? "0" : "") + r;
}

// ORDER U1 (a) and (b): plain words for the GPU memory bar and for the last control action.
// These mirror gpuBarLabel()/lastActionText() in src/company/layaControl.ts (which the proof
// tests); this file runs in the browser and cannot import the server module.
function gpuBarText(L) {
  const raw = L && L.device ? String(L.device) : "";
  const kind = /cuda|gpu|nvidia/i.test(raw) ? "gpu" : /cpu/i.test(raw) ? "cpu" : null;
  const own = L && typeof L.layaGpuMiB === "number" && isFinite(L.layaGpuMiB) ? L.layaGpuMiB : null;
  if (kind === "cpu") return "GPU memory used by other programs (Laya is on the CPU, so none of this is Laya)";
  if (own === null) return "Laya's own share is not reported by Windows, the bar shows total GPU use";
  const total = L && L.gpu && typeof L.gpu.totalMiB === "number" && isFinite(L.gpu.totalMiB) && L.gpu.totalMiB > 0 ? L.gpu.totalMiB : null;
  return total === null ? "Laya uses " + mb(own) : "Laya uses " + mb(own) + " of " + mb(total);
}
function lastActionWords(a, hmFn) {
  if (!a) return "";
  const word = deviceWord(a.device);
  let at = "";
  try { at = a.at && hmFn ? hmFn(a.at) : ""; } catch { at = ""; }
  const when = at ? "at " + at : "just now";
  const note = String(a.note || "").trim();
  if (a.ok) {
    if (a.kind === "switch") return "Switched to " + word + " " + when + " (Laya is now answering on " + word + ")";
    if (a.kind === "start") return "Started on " + word + " " + when + (note ? " (" + note + ")" : "");
    return "Stopped Laya " + when + (note ? " (" + note + ")" : "");
  }
  const what = a.kind === "switch" ? "Switch to " + word : a.kind === "start" ? "Start on " + word : "Stop";
  return what + " failed " + when + (note ? ": " + note : "");
}

// ORDER U2: the GPU bar now names the programs holding memory. These mirror gpuUserLine() and
// gpuUsersNotice() in src/company/layaControl.ts (which the proof tests; this file runs in the
// browser and cannot import the server module). Description only: there is no button here that
// stops another program.
function gpuUserLineText(u) {
  const name = String((u && u.name) || "").replace(/\.exe$/i, "") || "unknown";
  const label = String((u && u.label) || "").trim() || name;
  return label + " (" + name + ", pid " + (Number(u && u.pid) || 0) + "): " + mb(u && u.mb);
}
function gpuUsersNoticeText(device, users) {
  const raw = String(device || "");
  const kind = /cuda|gpu|nvidia/i.test(raw) ? "gpu" : /cpu/i.test(raw) ? "cpu" : null;
  if (kind !== "cpu") return "";
  const heavy = (users || []).some((u) => u && u.label !== "Laya" && Number(u.mb) > 1024);
  return heavy ? "To give Laya the GPU, this program has to stop or restart first" : "";
}

function countsLine(c) {
  if (!c) return "";
  return [
    c.terminals + " terminal" + (c.terminals === 1 ? "" : "s"),
    c.tasks + " task" + (c.tasks === 1 ? "" : "s"),
    c.fleetOrders + " fleet order" + (c.fleetOrders === 1 ? "" : "s"),
    c.checkpoints + " checkpoint" + (c.checkpoints === 1 ? "" : "s"),
  ].join(", ");
}

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
.sys-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; }
.sys-tile { border: 1px solid var(--line, #2a2a2a); border-radius: 10px; padding: 10px 12px; background: var(--panel2, rgba(255,255,255,0.02)); }
.sys-tile .sys-k { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; opacity: .65; }
.sys-tile .sys-v { font-size: 16px; margin-top: 3px; }
.sys-ok { color: var(--ok, #4ade80); }
.sys-err { color: var(--err, #f87171); }
.sys-warn { color: var(--warn, #fbbf24); }
.sys-danger { background: #b91c1c; border: 1px solid #ef4444; color: #fff; }
.sys-danger[disabled] { opacity: .5; }
.sys-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sys-snap { border-top: 1px solid var(--line, #2a2a2a); padding: 10px 0; }
.sys-snap:first-child { border-top: 0; }
.sys-term { display: flex; align-items: center; gap: 8px; padding: 2px 0; font-size: 13px; }
.sys-term input { margin: 0; }
.sys-mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
.sys-log { max-height: 260px; overflow: auto; border: 1px solid var(--line, #2a2a2a); border-radius: 8px; padding: 8px; background: rgba(0,0,0,.25); }
.sys-big { font-size: 18px; font-weight: 600; margin: 4px 0 10px; }
.sys-delivered { color: var(--ok, #4ade80); }
.sys-failed { color: var(--err, #f87171); }
.sys-queued { color: var(--warn, #fbbf24); }
.sys-off { border: 1px solid var(--err, #f87171); border-radius: 10px; padding: 16px; background: rgba(185,28,28,.12); }
.sys-gpubar { height: 10px; border-radius: 6px; background: rgba(255,255,255,.08); overflow: hidden; margin: 6px 0 2px; }
.sys-gpufill { height: 100%; background: linear-gradient(90deg, #22c55e, #eab308); }
`;
  document.head.appendChild(s);
}

/* ------------------------------------------------------------------- mount */

export function mount(el, ctx) {
  injectStyle();
  const api = ctx && ctx.api;
  const esc = (ctx && ctx.esc) || escHtml;
  const ago = (ctx && ctx.ago) || fallbackAgo;
  const hm = (ctx && ctx.hm) || fallbackHm;
  const poll = (ctx && ctx.poll) || fallbackPoll;

  let stopped = false;
  let stopPoll = null;
  let stopLayaPoll = null;
  let mode = "idle"; // idle | confirm | shutdown | off | resume
  let status = null;
  let plan = null;
  let snapshots = [];
  let picked = null; // ts of the snapshot open for resume
  let selected = new Set();
  let resumeState = null;
  let shutdownState = null;
  let error = "";
  // LAYA-CTL: the "Laya (decision model)" panel (GET /company/laya).
  let laya = null;
  let layaBusy = false;
  let layaBusyAct = ""; // which button is in flight: stop | switch | start-gpu | start-cpu
  let layaError = "";
  let layaNote = "";
  let layaStartAt = 0; // local clock for "Elapsed mm:ss" while a start is in progress
  let layaClickAt = 0; // ORDER U1 (c): when the last start/switch click sent its request
  let layaClickFrom = ""; // the raw device the panel showed at that moment
  let offAt = 0;
  try { offAt = Number(localStorage.getItem(LS_OFF) || 0); } catch { offAt = 0; }

  el.innerHTML = '<div class="wrap"><p class="muted">Loading the system page…</p></div>';

  /* --------------------------------------------------------------- loading */

  async function loadStatus() {
    const s = await api("/company/system/status");
    status = s;
    if (s && s.shutdown && s.shutdown.phase === "idle" && mode === "shutdown") mode = "idle";
    if (s && s.shutdown && (s.shutdown.phase === "checkpointing" || s.shutdown.phase === "closing")) {
      shutdownState = s.shutdown;
      mode = "shutdown";
    }
    return s;
  }

  async function loadSnapshots() {
    const r = await api("/company/system/snapshots?limit=20");
    snapshots = (r && r.snapshots) || [];
    if (!picked && snapshots.length) picked = snapshots[0].ts;
    return snapshots;
  }

  async function openSnapshot(ts) {
    const s = await api("/company/system/snapshots/" + encodeURIComponent(ts));
    return s;
  }

  // LAYA-CTL: Laya status. ttl:0 bypasses the shared GET cache so the poll is live.
  // LAYA-UX: keep a local clock for the elapsed time while a start is loading.
  async function loadLaya() {
    try {
      laya = await api("/company/laya", { ttl: 0 });
      layaError = "";
      if (laya && laya.starting) {
        if (!layaStartAt) layaStartAt = Date.now() - (Number(laya.starting.sinceSec) || 0) * 1000;
      } else {
        layaStartAt = 0;
      }
    } catch (e) {
      layaError = "Could not read Laya status: " + msg(e);
    }
    return laya;
  }

  /* -------------------------------------------------------------- rendering */

  function tile(key, value, tone) {
    const cls = tone ? " " + tone : "";
    return '<div class="sys-tile"><div class="sys-k">' + esc(key) + '</div><div class="sys-v' + cls + '">' + value + "</div></div>";
  }

  function renderStatus() {
    if (!status) return '<p class="muted">Reading status…</p>';
    const t = status.terminals || { total: 0, working: 0, names: [] };
    const ramTone = status.freeRamMb < (status.limits ? status.limits.minFreeRamMb : 2048) ? "sys-warn" : "sys-ok";
    const tiles = [
      tile("Router", esc(status.router.host + ":" + status.router.port) + ' <span class="sys-ok">up</span>'),
      tile("Laya (:8000)", status.laya.ok ? '<span class="sys-ok">healthy</span>' : '<span class="sys-err">not answering</span>'),
      tile("jcode server", status.jcodeServer.running ? '<span class="sys-ok">running</span> (pid ' + esc((status.jcodeServer.pids || []).join(", ")) + ")" : '<span class="sys-err">stopped</span>'),
      tile("Supervisor task", esc(status.supervisor.task) + ": " + esc(status.supervisor.state), /running|ready/i.test(status.supervisor.state) ? "sys-ok" : "sys-warn"),
      tile("Terminals", esc(String(t.total)) + " alive (" + esc(String(t.working)) + " working)"),
      tile("opencode workers", esc(String(status.opencodeWorkers)) + (status.testServers ? " + " + esc(String(status.testServers)) + " test server(s)" : "")),
      tile("Free RAM", esc(mb(status.freeRamMb) + " of " + mb(status.totalRamMb)), ramTone),
      tile("Limits", esc("max " + (status.limits ? status.limits.maxParallelSessions : 30) + " terminals, floor " + mb(status.limits ? status.limits.minFreeRamMb : 2048))),
    ].join("");
    const paused = status.paused ? '<p class="sys-warn">New work is PAUSED (a shutdown is in progress or was interrupted). Resuming clears it.</p>' : "";
    return '<div class="sys-grid">' + tiles + "</div>" + paused;
  }

  // LAYA-UX: the "Laya (decision model)" panel. Health/device/pids from GET /company/laya.
  // Buttons follow the state, and every one of them is usable exactly when it should be:
  //   - Laya down:            Start on GPU (with a headroom line when VRAM is tight), Start on CPU
  //   - starting (item 2):    "Starting on GPU. Loading models, usually 1 to 7 minutes. Elapsed
  //                           mm:ss", Start/Switch disabled, Stop enabled to cancel the start
  //   - Laya up:              Switch to <the other device> (one confirm, one action) + Stop
  // A failed start (item 3), a CPU fallback (item 5) and every error show in plain words.
  function renderLayaPanel() {
    const L = laya || {};
    const ok = L.ok === true;
    const starting = L.starting || null;
    const dev = !L.device ? "unknown" : (/cuda|gpu|nvidia/i.test(L.device) ? "GPU" : "CPU");
    const pids = (L.pids || []).join(", ") || "none";
    const loaded = (L.loaded || []).length ? (L.loaded || []).join(", ") : "none loaded";
    let gpuRows;
    if (L.gpu) {
      const total = Number(L.gpu.totalMiB) || 0;
      const used = Number(L.gpu.usedMiB) || 0;
      const pct = total > 0 ? Math.min(100, Math.max(0, Math.round((used / total) * 100))) : 0;
      const share = gpuBarText(L);
      gpuRows =
        '<div class="sys-row"><span>' + esc(L.gpu.name) + "</span>" +
        '<span class="muted">' + esc(mb(used) + " / " + mb(total) + " used") + "</span></div>" +
        '<div class="sys-gpubar"><div class="sys-gpufill" style="width:' + pct + '%"></div></div>' +
        '<div class="muted">' + esc(share) + "</div>";
    } else {
      gpuRows = '<div class="muted">GPU memory unavailable (nvidia-smi not found).</div>';
    }

    // ORDER U2: who is holding the GPU memory, one line per program, and (only when Laya is on
    // the CPU and another program keeps more than 1 GB) one sentence about what has to happen.
    // Description only: nothing here offers to stop another program.
    const users = Array.isArray(L.gpuUsers) ? L.gpuUsers : [];
    const userLines = users.map((u) => '<div class="muted sys-mono">' + esc(gpuUserLineText(u)) + "</div>").join("");
    const usersNotice = gpuUsersNoticeText(L.device, users);
    const usersReason = !users.length && L.gpuUsersReason
      ? '<div class="muted">' + esc("GPU users unavailable: " + L.gpuUsersReason) + "</div>"
      : "";

    // Item 4: the headroom line only matters when a GPU start or a switch to GPU is on offer.
    const gpuActionOffered = !ok || dev === "CPU";
    const headroom = gpuActionOffered && L.gpuHeadroom ? '<div class="sys-warn">' + esc(L.gpuHeadroom) + "</div>" : "";

    // ORDER U1 (b): the last action stays visible until the next one, in plain words.
    const lastWords = lastActionWords(L.lastAction, hm);
    // ORDER U1 (c): after a click, if the device has not changed and nothing is starting
    // 20 s later, say so in the warning colour, with the reason from the last action.
    if (layaClickAt > 0 && (starting || ((laya && laya.device) || "") !== layaClickFrom)) layaClickAt = 0;
    const stale = layaClickAt > 0 && !starting && (Date.now() - layaClickAt) > 20000 &&
      ((laya && laya.device) || "") === layaClickFrom;
    const staleReason = L.lastAction
      ? (String(L.lastAction.note || "").trim() || lastActionWords(L.lastAction, hm))
      : "no Laya action has been recorded yet";
    const staleLine = stale ? '<div class="sys-warn">Nothing changed yet: ' + esc(staleReason) + "</div>" : "";

    // Items 1 and 2: exactly the buttons the current state allows (item 7: busy state per button).
    const off = layaBusy ? " disabled" : "";
    const label = (act, text) => (layaBusyAct === act ? "Working…" : text);
    let buttons;
    let stateLine = "";
    if (starting) {
      const since = layaStartAt ? Math.round((Date.now() - layaStartAt) / 1000) : (Number(starting.sinceSec) || 0);
      stateLine = '<div class="sys-warn">Starting on ' + esc(deviceWord(starting.device)) +
        ". Loading models, usually 1 to 7 minutes. Elapsed " + esc(fmtElapsed(since)) + ".</div>";
      buttons = '<button class="btn sys-danger" data-act="laya-stop"' + off + ">" + label("stop", "Stop (cancels the start)") + "</button>";
    } else if (ok) {
      const other = dev === "GPU" ? "cpu" : "gpu";
      buttons =
        '<button class="btn btn-primary" data-act="laya-switch" data-device="' + other + '"' + off + ">" + label("switch", "Switch to " + deviceWord(other)) + "</button>" +
        '<button class="btn sys-danger" data-act="laya-stop"' + off + ">" + label("stop", "Stop (free the GPU)") + "</button>";
    } else {
      buttons =
        '<button class="btn btn-primary" data-act="laya-start-gpu"' + off + ">" + label("start-gpu", "Start on GPU") + "</button>" +
        '<button class="btn" data-act="laya-start-cpu"' + off + ">" + label("start-cpu", "Start on CPU") + "</button>";
    }

    return (
      '<h2 style="margin-top:18px">Laya (decision model)</h2>' +
      '<div class="card">' +
      '<div class="sys-row">' +
      '<strong>' + (ok ? '<span class="sys-ok">healthy</span>' : starting ? '<span class="sys-warn">starting</span>' : '<span class="sys-err">not answering</span>') + "</strong>" +
      '<span class="muted">device in use: ' + esc(dev) + "</span>" +
      '<span class="muted">pids: ' + esc(pids) + "</span>" +
      '<span class="muted">checkpoints: ' + esc(loaded) + "</span>" +
      "</div>" +
      (lastWords ? '<div class="muted">Last action: ' + esc(lastWords) + "</div>" : "") +
      gpuRows +
      userLines +
      (usersNotice ? '<div class="sys-warn">' + esc(usersNotice) + "</div>" : "") +
      usersReason +
      headroom +
      (L.fallbackNotice ? '<div class="sys-warn">' + esc(L.fallbackNotice) + "</div>" : "") +
      stateLine +
      staleLine +
      '<div class="sys-row" style="margin-top:8px">' + buttons + "</div>" +
      (layaBusy ? '<div class="muted">Working…</div>' : "") +
      (layaNote ? '<div class="muted">' + esc(layaNote) + "</div>" : "") +
      (L.lastStartError ? '<div class="sys-err sys-mono">' + esc(L.lastStartError) + "</div>" : "") +
      (layaError ? '<div class="sys-err">' + esc(layaError) + "</div>" : "") +
      "</div>"
    );
  }

  function renderSnapshots() {
    if (!snapshots.length) {
      return '<p class="muted">No snapshots yet. "Snapshot now" writes one without stopping anything.</p>';
    }
    return snapshots.map((s) => {
      const c = s.counts || {};
      const open = picked === s.ts;
      const terms = (s.terminals || []).map((t) => {
        const on = selected.has(t.sessionId);
        return (
          '<label class="sys-term"><input type="checkbox" data-term="' + esc(t.sessionId) + '"' + (open && on ? " checked" : "") + ' data-ts="' + esc(s.ts) + '">' +
          "<span>" + esc(t.name) + " <span class=\"muted\">" + esc(t.role || t.state) + (t.checkpoint ? " · checkpoint" : "") + "</span></span></label>"
        );
      }).join("");
      return (
        '<div class="sys-snap">' +
        '<div class="sys-row"><strong>Saved ' + esc(hm(s.createdAt || s.ts)) + "</strong>" +
        '<span class="muted">' + esc(countsLine(c)) + "</span>" +
        (s.restoredAt ? '<span class="pill pill-ok">resumed ' + esc(hm(s.restoredAt)) + "</span>" : "") +
        '<span style="flex:1"></span>' +
        '<button class="btn" data-act="toggle" data-ts="' + esc(s.ts) + '">' + (open ? "Hide" : "Show") + "</button>" +
        '<button class="btn btn-primary" data-act="resume" data-ts="' + esc(s.ts) + '">Resume all</button>' +
        "</div>" +
        '<div class="muted sys-mono">' + esc(s.reason || "") + "</div>" +
        (open ? '<div class="mt-1">' + terms + "</div>" : "") +
        "</div>"
      );
    }).join("");
  }

  function renderProgress() {
    const st = shutdownState || {};
    const steps = (st.steps || []).map((s) => esc(hm(s.ts) + "  " + s.text)).join("\n");
    const want = st.terminals || 0;
    const got = st.checkpointsArrived || 0;
    const warnings = (st.warnings || []).map((w) => '<div class="sys-warn">' + esc(w) + "</div>").join("");
    return (
      '<div class="card">' +
      '<div class="sys-big">Shutting down — ' + esc(st.phase || "starting") + "</div>" +
      '<p>Checkpoints: <strong>' + esc(String(got)) + " / " + esc(String(want)) + "</strong> terminal(s) reported. " +
      "Each terminal writes what it was doing before it closes; this takes up to ~90 s in total.</p>" +
      '<div class="sys-log sys-mono">' + steps + "</div>" +
      warnings +
      '<p class="muted">The router stops last. When this page stops answering, everything is off.</p>' +
      "</div>"
    );
  }

  function renderOff() {
    const when = offAt ? new Date(offAt).toLocaleTimeString() : "";
    return (
      '<div class="sys-off">' +
      '<div class="sys-big">Everything is off.</div>' +
      '<p>Everything was stopped' + (when ? " at " + esc(when) : "") + " and the machine is using no RAM for the company." +
      " Laya, the router, the shared jcode server, the supervisor task and every terminal window are closed; each terminal's" +
      " checkpoint is in the latest snapshot.</p>" +
      '<p><strong>To start again, double-click "Start Laya Company" on your Desktop.</strong> ' +
      "Then come back to this page and press <strong>Resume all</strong> to bring the terminals back where they left off.</p>" +
      "</div>"
    );
  }

  function renderResume() {
    const r = resumeState || {};
    const items = (r.items || []).map((i) => {
      const tone = i.status === "delivered" ? "sys-delivered" : i.status === "failed" ? "sys-failed" : i.status === "queued" ? "sys-queued" : "muted";
      return '<div class="sys-term"><span class="' + tone + '">' + esc(i.name) + "</span> " +
        '<span class="muted">' + esc(i.status) + (i.detail ? " · " + esc(i.detail) : "") + "</span></div>";
    }).join("");
    const notes = (r.notes || []).map((n) => '<div class="muted">' + esc(n) + "</div>").join("");
    return (
      '<div class="card">' +
      '<div class="sys-big">Starting the company again</div>' +
      "<p>" + esc(String((r.items || []).filter((i) => i.status === "delivered").length)) + " of " + esc(String((r.items || []).length)) +
      " terminal(s) resumed, " + esc(String((r.tasksResumed || []).length)) + " task(s) and " + esc(String((r.fleetResumed || []).length)) +
      " fleet order(s) picked up. Terminals open one every ~8 s so the machine is not swamped.</p>" +
      '<div class="sys-log">' + items + "</div>" + notes +
      (r.finishedAt ? "" : '<p class="muted">Working…</p>') +
      "</div>"
    );
  }

  function renderConfirm() {
    const list = (plan && plan.terminals) || [];
    const rows = list.map((t) => (
      '<div class="sys-term"><span>' + esc(t.name) + "</span>" +
      '<span class="muted">' + esc(t.sessionId) + (t.windowPid ? " · window pid " + esc(String(t.windowPid)) : "") + "</span>" +
      '<span class="' + (t.verified ? "sys-ok" : "sys-warn") + '">' + esc(t.verified ? "verified" : "not verified") + "</span>" +
      '<span class="muted" style="flex:1">' + esc(t.detail || "") + "</span></div>"
    )).join("");
    const other = plan
      ? '<div class="muted">Also stopped: ' + esc(String(plan.opencode)) + " opencode worker(s), " +
        esc(String(plan.testServers)) + " stray test server(s), the shared jcode server (pid " +
        esc((plan.jcodeServerPids || []).join(", ") || "none") + "), Laya on :8000, the supervisor task " +
        esc(plan.supervisorTask) + ", and finally the router itself (: " + esc(String(plan.router.port)) + "). " +
        "Claude Code, Claude Desktop, your browser and every other program are NOT touched.</div>"
      : "";
    return (
      '<div class="card">' +
      '<div class="sys-big">Shut down everything?</div>' +
      "<p>This closes every terminal below (including your own jcode window), stops Laya, the shared jcode server and the" +
      " supervisor task, and stops the router last. <strong>Each terminal saves a checkpoint first (~90 s)</strong>, so when" +
      " you start the company again every terminal comes back with its context and knows what it was doing.</p>" +
      '<div class="sys-log">' + (rows || '<span class="muted">No terminals are alive right now.</span>') + "</div>" +
      other +
      '<div class="sys-row mt-2">' +
      '<button class="btn sys-danger" data-act="confirm-shutdown">Yes, shut everything down</button>' +
      '<button class="btn" data-act="cancel">Cancel</button>' +
      "</div>" +
      '<div class="muted">Nothing is ever resumed automatically: you press "Resume all" after starting the company again.</div>' +
      "</div>"
    );
  }

  function render() {
    const body = mode === "confirm" ? renderConfirm()
      : mode === "shutdown" ? renderProgress()
      : mode === "off" ? renderOff()
      : mode === "resume" ? renderResume()
      : "";
    const head = mode === "off" ? "" : (
      '<div class="sys-row" style="margin-bottom:10px">' +
      '<button class="btn sys-danger" data-act="ask-shutdown"' + (mode === "shutdown" ? " disabled" : "") + ">Shut down everything</button>" +
      '<button class="btn" data-act="snapshot"' + (mode === "shutdown" ? " disabled" : "") + ">Snapshot now (no shutdown)</button>" +
      '<span style="flex:1"></span>' +
      (status ? '<span class="muted">router pid ' + esc(String(status.router.pid)) + " · up " + esc(String(status.router.uptimeS)) + "s</span>" : "") +
      "</div>"
    );
    el.innerHTML =
      '<div class="wrap">' +
      // UI-CLEAN: the shell now renders the page title + one purpose sentence
      // above every view (#page-title / #page-goal), so the local <h1>System</h1>
      // and its duplicate one-liner were removed - the page was printing the
      // heading and the same sentence twice. Restore them only if the shell
      // header is ever dropped. (DMed to SHUTDOWN/dove 21:01Z.)
      (error ? '<p class="sys-err">' + esc(error) + "</p>" : "") +
      head +
      renderStatus() +
      renderLayaPanel() +
      '<h2 style="margin-top:18px">Snapshots</h2>' +
      renderSnapshots() +
      body +
      "</div>";
    wire();
    void ctx;
  }

  /* --------------------------------------------------------------- actions */

  async function askShutdown() {
    error = "";
    mode = "confirm";
    render();
    try {
      plan = await api("/company/system/close-plan");
    } catch (e) {
      error = "Could not list what would close: " + msg(e);
    }
    render();
  }

  async function doShutdown() {
    mode = "shutdown";
    error = "";
    shutdownState = null;
    render();
    try {
      await api("/company/system/shutdown", { method: "POST", body: { confirm: true } });
    } catch (e) {
      error = "Shutdown request failed: " + msg(e);
    }
    startShutdownWatch();
  }

  async function snapshotNow() {
    error = "";
    try {
      const r = await api("/company/system/snapshot", { method: "POST", body: { checkpoints: false } });
      error = "Snapshot written: " + (r && r.dir ? String(r.dir).split("\\").pop() : "") + " (" + countsLine(r && r.counts) + ")";
      await loadSnapshots();
      picked = r && r.ts ? r.ts : picked;
      await openSnapshot(picked).then((s) => { selected = new Set((s.terminals || []).map((t) => t.sessionId)); });
    } catch (e) {
      error = "Snapshot failed: " + msg(e);
    }
    render();
  }

  // LAYA-CTL/U-X: stop Laya after a confirm that names the routing consequence.
  async function stopLayaNow() {
    const sure = window.confirm(
      "Stop Laya? Routing will use fallbacks while Laya is down, so decisions are made without the local model until you start it again.",
    );
    if (!sure) return;
    layaBusy = true;
    layaBusyAct = "stop";
    layaError = "";
    layaNote = "";
    render();
    try {
      const r = await api("/company/laya/stop", { method: "POST" });
      const freed = r && typeof r.freedMiB === "number" ? r.freedMiB : 0;
      const stopped = r && Array.isArray(r.stopped) ? r.stopped : [];
      layaNote = "Laya stopped" + (stopped.length ? " (pids " + stopped.join(", ") + ")" : " (no Laya process was running)") +
        (freed > 0 ? ", " + mb(freed) + " of GPU memory freed" : "") + ".";
      await loadLaya();
    } catch (e) {
      layaError = "Could not stop Laya: " + msg(e);
    } finally {
      // ORDER U1 (d): a failed request must re-enable the buttons, not leave them stuck on "Working…".
      layaBusy = false;
      layaBusyAct = "";
      render();
    }
    startLayaWatch();
  }

  // LAYA-CTL/U-X: start Laya on GPU or CPU. Returns at once; /company/laya is polled every 3 s
  // while it loads (5 s otherwise) so the panel shows the elapsed time and when it is healthy.
  async function startLayaNow(device) {
    layaBusy = true;
    layaBusyAct = "start-" + device;
    layaError = "";
    layaClickAt = Date.now(); // ORDER U1 (c): the immediate line + the 20 s nothing-changed check
    layaClickFrom = (laya && laya.device) || "";
    layaNote = "Starting on " + deviceWord(device) + "... this takes up to a few minutes while the models load.";
    render();
    try {
      const r = await api("/company/laya/start", { method: "POST", body: { device: device } });
      if (r && r.refused) {
        layaError = "Laya was not started: " + (r.reason || "it is already answering") + ".";
        layaNote = "";
      }
      await loadLaya();
    } catch (e) {
      layaError = "Could not start Laya: " + msg(e);
    } finally {
      // ORDER U1 (d): a failed request must re-enable the buttons, not leave them stuck on "Working…".
      layaBusy = false;
      layaBusyAct = "";
      render();
    }
    startLayaWatch();
  }

  // LAYA-UX item 1: switch device as ONE action behind ONE confirm: stop, wait for health to go
  // down (max 15 s, done by the server), then start on the other device. The words say what will
  // happen and that routing uses fallbacks while Laya reloads. If stopping fails, nothing starts.
  async function switchLayaNow(device) {
    const to = deviceWord(device);
    const sure = window.confirm(
      "Switch Laya to " + to + "?\n\n" +
      "Laya will be stopped first and then started on " + to + ". Routing will use fallbacks while Laya reloads " +
      "(usually 1 to 7 minutes), so decisions are made without the local model until it is healthy again.\n\n" +
      "If stopping fails, Laya is NOT started again.",
    );
    if (!sure) return;
    layaBusy = true;
    layaBusyAct = "switch";
    layaError = "";
    layaClickAt = Date.now(); // ORDER U1 (c): the immediate line + the 20 s nothing-changed check
    layaClickFrom = (laya && laya.device) || "";
    layaNote = "Switching to " + to + "... this takes up to a few minutes while the models load.";
    render();
    try {
      const r = await api("/company/laya/switch", { method: "POST", body: { device: device } });
      if (r && r.switched) {
        layaNote = "Laya is now starting on " + to + ". Loading models, usually 1 to 7 minutes.";
        layaStartAt = 0;
      } else {
        layaError = "Switch to " + to + " did not finish: " + ((r && r.reason) || "unknown reason");
        layaNote = "";
      }
      await loadLaya();
    } catch (e) {
      layaError = "Could not switch Laya: " + msg(e);
    } finally {
      // ORDER U1 (d): a failed request must re-enable the buttons, not leave them stuck on "Working…".
      layaBusy = false;
      layaBusyAct = "";
      render();
    }
    startLayaWatch();
  }

  async function toggleSnapshot(ts) {
    picked = picked === ts ? null : ts;
    if (picked) {
      try {
        const s = await openSnapshot(picked);
        selected = new Set((s.terminals || []).map((t) => t.sessionId)); // all ticked by default
      } catch (e) { error = "Could not read that snapshot: " + msg(e); }
    }
    render();
  }

  async function doResume(ts) {
    error = "";
    mode = "resume";
    resumeState = { items: [], notes: [] };
    render();
    let ids = [...selected];
    if (ts !== picked || !ids.length) {
      try {
        const s = await openSnapshot(ts);
        ids = (s.terminals || []).map((t) => t.sessionId);
        picked = ts;
      } catch (e) { error = "Could not read that snapshot: " + msg(e); }
    }
    try {
      const r = await api("/company/system/resume", { method: "POST", body: { sessionIds: ids, snapshotTs: ts } });
      resumeState = r;
      startResumeWatch();
    } catch (e) {
      error = "Resume failed: " + msg(e);
      mode = "idle";
    }
    render();
  }

  /* ----------------------------------------------------------- the watchers */

  // While a shutdown runs, poll the progress. The moment the router stops answering the
  // company is off, and that is the end state the CEO must see (the API cannot tell us).
  function startShutdownWatch() {
    stopWatch();
    let sawClosing = false;
    stopPoll = poll(async () => {
      if (stopped) return;
      try {
        const st = await api("/company/system/shutdown/status");
        shutdownState = st;
        if (st.phase === "closing" || st.phase === "done") sawClosing = true;
        render();
      } catch (e) {
        // The router is gone (or the page lost it): with a shutdown in flight, say so.
        if (sawClosing || mode === "shutdown") {
          mode = "off";
          offAt = Date.now();
          try { localStorage.setItem(LS_OFF, String(offAt)); } catch { /* private mode */ }
          stopWatch();
          render();
        }
      }
    }, PROGRESS_MS);
  }

  function startResumeWatch() {
    stopWatch();
    stopPoll = poll(async () => {
      if (stopped) return;
      try {
        const r = await api("/company/system/resume/status");
        if (r) resumeState = r;
        render();
        if (r && r.finishedAt) stopWatch();
      } catch { /* the router restarted: keep trying */ }
    }, RESUME_MS);
  }

  function stopWatch() {
    if (stopPoll) { try { stopPoll(); } catch { /* ignore */ } stopPoll = null; }
  }

  function startMainPoll() {
    stopWatch();
    stopPoll = poll(async () => {
      if (stopped || mode === "off") return;
      try {
        await loadStatus();
        await loadSnapshots();
        if (mode === "idle" && !shutdownState) {
          const s = picked ? await openSnapshot(picked).catch(() => null) : null;
          if (s && !selected.size) selected = new Set((s.terminals || []).map((t) => t.sessionId));
        }
        error = "";
      } catch (e) {
        error = "The router is not answering: " + msg(e);
      }
      render();
    }, mode === "shutdown" ? PROGRESS_MS : STATUS_MS);
  }

  function wire() {
    el.querySelectorAll("button[data-act]").forEach((b) => {
      b.addEventListener("click", () => {
        const act = b.getAttribute("data-act");
        const ts = b.getAttribute("data-ts");
        if (act === "ask-shutdown") askShutdown();
        else if (act === "confirm-shutdown") doShutdown();
        else if (act === "cancel") { mode = "idle"; plan = null; render(); }
        else if (act === "snapshot") snapshotNow();
        else if (act === "laya-stop") stopLayaNow();
        else if (act === "laya-switch") switchLayaNow(b.getAttribute("data-device"));
        else if (act === "laya-start-gpu") startLayaNow("gpu");
        else if (act === "laya-start-cpu") startLayaNow("cpu");
        else if (act === "toggle") toggleSnapshot(ts);
        else if (act === "resume") doResume(ts);
      });
    });
    el.querySelectorAll("input[data-term]").forEach((c) => {
      c.addEventListener("change", () => {
        const id = c.getAttribute("data-term");
        picked = c.getAttribute("data-ts");
        if (c.checked) selected.add(id); else selected.delete(id);
      });
    });
  }

  /* ------------------------------------------------------------------ boot */

  // LAYA-CTL/U-X: refresh the Laya panel every 3 s while a start is loading (so the elapsed
  // time moves), and every 5 s otherwise. Changing cadence restarts the poll at the new rate.
  function stopLayaWatch() {
    if (stopLayaPoll) { try { stopLayaPoll(); } catch { /* ignore */ } stopLayaPoll = null; }
  }
  function startLayaWatch() {
    const ms = laya && laya.starting ? 3000 : 5000;
    stopLayaWatch();
    stopLayaPoll = poll(async () => {
      if (stopped || mode === "off" || mode === "shutdown") return;
      await loadLaya();
      render();
      if (((laya && laya.starting) ? 3000 : 5000) !== ms) startLayaWatch();
    }, ms);
  }

  void (async () => {
    startLayaWatch();
    try {
      await loadStatus();
      if (status.shutdown && (status.shutdown.phase === "checkpointing" || status.shutdown.phase === "closing")) {
        shutdownState = status.shutdown;
        mode = "shutdown";
        render();
        startShutdownWatch();
        return;
      }
      await Promise.all([loadLaya(), loadSnapshots()]);
      if (picked) {
        const s = await openSnapshot(picked).catch(() => null);
        if (s) selected = new Set((s.terminals || []).map((t) => t.sessionId));
      }
    } catch (e) {
      error = "Could not read the system status: " + msg(e);
    }
    render();
    startMainPoll();
  })();

  return function cleanup() {
    stopped = true;
    stopWatch();
    stopLayaWatch();
  };
}
