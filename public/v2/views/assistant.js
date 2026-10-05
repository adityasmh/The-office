/* UI-ASSISTANT — Assistant view (public/v2/views/assistant.js)
 *
 * Route: #/assistant  (the v2 default/home view)
 *
 * What it is: talk to the CEO assistant. Type an order, press Enter, and the
 * reply shows up with the tasks that order created as chips. Each chip links
 * to #/flow/:taskId and carries the task's LIVE status, refreshed by polling
 * GET /company/flow. "Done:" / "Failed:" report-backs (appended by
 * assistant.ts reportBack() when a pipeline settles) are rendered as
 * stand-out cards.
 *
 * Contract (docs/UI_V2_SPEC.md): export const title / export function mount(el, ctx)
 * with ctx = { api, poll, esc, ago, hm, navigate, params }.
 *
 * Deep links: Briefing emits `#/assistant?q=<url-encoded question>` ("Ask the
 * assistant about this"). On mount a non-empty `q` prefills the composer, the
 * caret goes to the end and the box is focused, so the CEO can read, edit and
 * press Send. It never auto-sends and nothing from the query is written as
 * HTML: only textarea.value is set.
 *
 * Endpoints used (all exist today, see src/server.ts):
 *   GET  /company/assistant/thread?limit=N -> { status, messages:[{ts,role,text,tasks?}] }
 *   GET  /company/assistant/stt/health -> { ok, model?, device?, warm?, uptime_s? } (STT-HEALTH;
 *        ok:false means speech-to-text is down: the hold-to-talk control is disabled and one
 *        plain-language line says to type the order instead. The typed path never reads it.)
 *   POST /company/assistant/message {text, autoRun, attachments?} -> { reply, plan, dispatched, decisions }
 *   GET  /company/flow?limit=N -> { tasks:[{taskId, projectId, projectName, status, ...}] }
 *   POST /company/uploads  (raw file body, name in x-file-name) -> { id, path, name, type, pages? }
 *
 * Attachments (ATTACH work order, 2026-09-29): the paperclip button and drag-and-drop
 * below the message box upload a PDF/PNG/JPG/WEBP straight away (one request per file,
 * the body IS the file - api() only speaks JSON, so this is a plain fetch) and keep a
 * chip per file with an x to remove it. The chips carry the upload ids and Send passes
 * them as `attachments`, so the assistant can open and read the real files. The CEO's
 * limits are reported, not enforced here: over 20 pages/images and over 25 MB in total
 * both WARN (the server's own limit is 25 MB per file), and the only thing that blocks
 * Send is a broken state - an upload still in flight, or one that failed. The names of
 * the attached files are recorded in the thread entry for the order, so reading the
 * thread later still shows what went with it.
 *
 * Speaking companion + live transcript (SPEAK work order fomunypg1k/WO1, 2026-09-30):
 * the CEO asked to see at a glance when Joey is talking versus silent. Two additions,
 * both inside this file:
 *   1. A dog-like companion card above the conversation whose mouth, ears, tail and level
 *      meter move ONLY while Joey is speaking, and which is completely still when silent
 *      (a silent reply animates nothing), plus a "Speaking…"/"Silent" state pill and a
 *      progress bar for the utterance being said.
 *   2. A "Live transcript" card BELOW the conversation that lists every assistant utterance
 *      (replies and Done:/Failed: report-backs), oldest first, newest last, auto-scrolled,
 *      with the words of the utterance being spoken revealed as they are said.
 *
 * Where the "speaking" signal comes from - stated plainly:
 *   The router hands the reply text to the machine's speech server
 *   (`speakAssistantReply` -> POST http://127.0.0.1:8901/tts/speak, src/company/assistant.ts)
 *   and that audio plays out of this machine's speakers. The page cannot read the speech
 *   server directly (it sends no CORS headers), so the router exposes the one field needed:
 *   `GET /company/assistant/speech` -> `{ok, speaking}` (an additive loopback route in
 *   src/server.ts proxying /tts/health -> lastPlayback.playing). While that route answers,
 *   the speech session is "router"-sourced: real playback ENDS it once it has been seen, and
 *   it is never cut short before then - "not playing yet" is not "not spoken", because the
 *   router hands the text over before the speech server starts (see speechTick(); measured on
 *   the live route, a healthy probe answering speaking:false used to end a 214-char reply's
 *   session at 2,998 ms against a 15,286 ms estimate).
 *   A router built before that route (every router up to its next supervised restart)
 *   answers 404, the probe stays quiet, and the session falls back to a duration estimated
 *   from the text (SPEAK_CHARS_PER_SEC, the same 1200-char cap the server speaks) - i.e.
 *   exactly how this view behaved before the route existed, so the companion never depends
 *   on a restart. One session starts where an utterance is born: the reply text arriving
 *   from POST /company/assistant/message (typed or spoken order) or a new assistant entry
 *   appearing in the polled thread (report-backs). If a real `<audio>` element is ever added
 *   to this view, playback wins over both: hookVoiceSpeaking() marks the session audio-driven
 *   and the element's own play/ended events decide when the companion stops. With the
 *   "Joey voice" toggle off the machine says nothing, so no session starts and the companion
 *   never moves - and the card says so ("Silent \u00b7 voice off"), so a still companion is never
 *   mistaken for a broken one.
 *   The transcript is built from the same messages() list the conversation renders, so a new
 *   utterance appears in both places or in neither - no second data source for utterances.
 *
 * Style note (why the CSS is in this file): the shell owns style.css, so this view uses the
 * contract classes for layout. The companion's animation needs @keyframes, which cannot be
 * expressed through element.style, so SPEAK_CSS is injected as one scoped <style> element
 * (all selectors namespaced `joey-`) and removed on cleanup. That keeps the change inside
 * this one file; nothing else in the project is touched.
 *
 * Layout note: the shell owns style.css, so this view uses only the contract
 * classes (.card .btn .btn-primary .pill .pill-ok .pill-warn .pill-err .muted
 * .row .col .grid, .who-*) and the :root CSS variables. The few inline styles
 * here are pure layout (wrap/gap/overscroll) and read from those variables,
 * never hard-coded colours, so the shell theme still controls the look.
 */

export const title = "Joey";

/**
 * The control-plane token, for the raw upload fetch. Taken from the shared client
 * module (api.js owns it, exported and unchanged; PERF-UI confirmed at 15:27Z that
 * importing it is additive-safe). api() itself only speaks JSON, so the file body
 * cannot go through it.
 */
import { companyToken } from "../api.js";

const POLL_MS = 5000;
const THREAD_LIMIT = 100;
const FLOW_LIMIT = 25;
const BODY_CLAMP = 700; // chars shown before "Show more"

// JOEY-WIRE: per-browser voice toggle. localStorage 'joey.voice' is "on" or "off"; default on.
const JOEY_VOICE_KEY = "joey.voice";
function readJoeyVoice() {
  return localStorage.getItem(JOEY_VOICE_KEY) !== "off";
}
function writeJoeyVoice(enabled) {
  localStorage.setItem(JOEY_VOICE_KEY, enabled ? "on" : "off");
}

// CEO BUG REPORT (2026-09-30): "view more automatically gets closed every 5 seconds".
// Cause: the Show more/less toggle and the "why (n planner notes)" <details> wrote their open
// state straight onto the DOM, and renderThread() rebuilds the whole conversation on every
// POLL_MS (5000 ms) tick - so each poll threw the expansion away.
//
// The state now lives at MODULE scope (not inside mount()) and is re-applied whenever a
// message is rebuilt, keyed by the message identity (keyOf: role + the first 200 chars of the
// text, which is stable across polls). Module scope on purpose, so an expansion the CEO opened
// also survives leaving the view and coming back - measured with a real click test over CDP:
// click Show more -> one 5 s poll tick -> still "Show less"; hash away and back -> still
// "Show less" (a per-mount Set failed that second case, which is how the first version of
// this comment was caught being wrong).
const expandedBodies = new Set(); // keyOf(m) -> body tail is showing
const openWhyBoxes = new Set(); // keyOf(m) -> the planner-notes <details> is open
const TASK_CACHE_CAP = 500;
/* Attachment limits (CEO's rule, ATTACH work order). */
const ATTACH_PAGES_LIMIT = 20; // PDF pages + images in total
const ATTACH_BYTES_LIMIT = 25 * 1024 * 1024; // 25 MB in total
const ATTACH_ACCEPT = ".pdf,.png,.jpg,.jpeg,.webp";
const ATTACH_NAME_RE = /\.(pdf|png|jpe?g|webp)$/i;

/* VOICE-IN: hold-to-talk constants (VOICE-UI work order fomun56n8v).
 * Recordings under VOICE_MIN_HOLD_MS are refused with "Didn't catch that"
 * (a click or key bounce is not a sentence), and the composer must mount even
 * on a terminal with no microphone (feature checks happen per press). */
const VOICE_MIN_HOLD_MS = 300;
const VOICE_MIME = "audio/webm;codecs=opus";

/* STT-HEALTH (work order fomunicug6/WO1): the composer asks
 * GET /company/assistant/stt/health (a loopback read on the router, which probes
 * the speech-to-text service's own GET /stt/health) and, while that answers
 * ok:false, the hold-to-talk control is disabled and one plain-language line says
 * why. The typed path is never gated on this: typing an order works whether or
 * not speech-to-text is up, which is the whole point of the fallback.
 *
 * Probed with {ttl:0} so a stale answer can never outvote reality, and at 15 s
 * because a health probe does not need to be faster than the CEO can react.
 * Only an explicit ok:false disables the mic - a probe that cannot be answered
 * (router down, tab offline) leaves the mic alone and lets a real attempt report
 * the real error. */
const STT_HEALTH_MS = 15000;
const STT_DOWN_MESSAGE = "Speech-to-text is down. Type your order instead.";

/* SPEAK (work order fomunypg1k/WO1): companion animation + live transcript.
 * SPEAK_CHARS_PER_SEC is the reading rate Joey's speech actually runs at (~170 wpm), used to
 * turn a reply into a speaking duration because the page cannot observe the machine's
 * speaker (see the module comment). SPEAK_SPEAK_MAX_CHARS mirrors TTS_MAX_CHARS in
 * src/company/assistant.ts: the server speaks at most 1200 chars of a reply, so the estimate
 * must not be longer than the audio for those. */
const SPEAK_CHARS_PER_SEC = 14;
const SPEAK_MIN_MS = 1200; // a two-word reply still animates long enough to be seen
const SPEAK_MAX_MS = 90000; // 1200 chars / 14 cps ~ 86 s: never shorter than what the server says
const SPEAK_SPEAK_MAX_CHARS = 1200;
const SPEAK_TICK_MS = 100; // reveal + progress cadence while speaking (nothing runs while silent)
const SPEAK_METER_BARS = 7;
/* An utterance only animates if it was born while this page was open. Priming (below) already
 * marks what the first successful load carried, but the very first load can be an empty or
 * failed fetch, so the entry's own timestamp is checked too: history stays silent. */
const SPEAK_FRESH_GRACE_MS = 2000;
const TRANSCRIPT_MAX_LINES = 120; // the thread window is 100, so nothing is ever dropped in practice

/* The companion: inline SVG, drawn here so there is no image file to load and CSS can
 * animate its parts by class. Idle = perfectly still (no blink, no bob): silence must not
 * animate. The classes are toggled on the card (.joey-speaking) by paintCompanion(). */
const SPEAK_DOG_SVG =
  '<svg class="joey-dog" viewBox="0 0 128 96" aria-hidden="true" focusable="false">' +
  '<path class="joey-part joey-tail" d="M30 74 q-17 4 -14 -20" fill="none" stroke="var(--accent, #48f)" stroke-width="6" stroke-linecap="round"/>' +
  '<g class="joey-part joey-head">' +
  '<path class="joey-part joey-ear-l" d="M38 34 l-9 -23 l23 7 z" fill="var(--panel2, #2a2a2a)" stroke="var(--accent, #48f)" stroke-width="2.5" stroke-linejoin="round"/>' +
  '<path class="joey-part joey-ear-r" d="M74 34 l9 -23 l-23 7 z" fill="var(--panel2, #2a2a2a)" stroke="var(--accent, #48f)" stroke-width="2.5" stroke-linejoin="round"/>' +
  '<ellipse cx="56" cy="54" rx="30" ry="26" fill="var(--panel2, #2a2a2a)" stroke="var(--accent, #48f)" stroke-width="2.5"/>' +
  '<circle class="joey-eye" cx="45" cy="48" r="3.6" fill="var(--txt, #e8e8e8)"/>' +
  '<circle class="joey-eye" cx="67" cy="48" r="3.6" fill="var(--txt, #e8e8e8)"/>' +
  '<ellipse cx="56" cy="68" rx="13" ry="10" fill="var(--bg, #111)" stroke="var(--line, #3a3a3a)" stroke-width="2"/>' +
  '<ellipse class="joey-part joey-mouth" cx="56" cy="72" rx="7.5" ry="4" fill="var(--accent, #48f)"/>' +
  "</g>" +
  '<g fill="none" stroke="var(--accent, #48f)" stroke-width="3" stroke-linecap="round">' +
  '<path class="joey-wave joey-wave-1" d="M94 46 q7 8 0 18"/>' +
  '<path class="joey-wave joey-wave-2" d="M104 40 q11 14 0 30"/>' +
  "</g>" +
  "</svg>";

/* Scoped styles for the companion and the transcript. Only the `.joey-*` namespaces, only
 * theme variables with fallbacks, and every animation is gated on `.joey-speaking`, so a
 * silent companion has no running animation at all. prefers-reduced-motion keeps the visual
 * difference (bars lit, line highlighted, "Speaking…" pill) but drops the motion. */
const SPEAK_CSS = [
  ".joey-stage{align-items:center}",
  ".joey-dog{width:118px;height:86px;flex:0 0 auto;display:block}",
  ".joey-dog .joey-part{transform-box:fill-box}",
  ".joey-dog .joey-mouth{transform-box:fill-box;transform-origin:50% 0%;transform:scaleY(.45)}",
  ".joey-dog .joey-tail{transform-box:fill-box;transform-origin:100% 100%}",
  ".joey-dog .joey-ear-l{transform-box:fill-box;transform-origin:100% 100%}",
  ".joey-dog .joey-ear-r{transform-box:fill-box;transform-origin:0% 100%}",
  ".joey-dog .joey-wave{opacity:0}",
  ".joey-meter{display:flex;align-items:flex-end;gap:3px;height:38px;flex:0 0 auto}",
  ".joey-meter .joey-bar{display:block;width:6px;height:5px;border-radius:3px;background:var(--dim, #555);opacity:.45}",
  ".joey-say-col{flex:1 1 220px;min-width:180px}",
  ".joey-saying{font-size:13px;color:var(--dim, #888);min-height:34px;overflow-wrap:anywhere}",
  ".joey-prog{margin-top:6px;height:4px;border-radius:2px;background:var(--line, #333);overflow:hidden}",
  ".joey-prog > i{display:block;height:100%;width:0%;background:var(--accent, #48f)}",
  ".joey-transcript{margin-top:8px;max-height:240px;overflow:auto;border:1px solid var(--line, #333);border-radius:6px;padding:6px 8px;background:var(--panel2, transparent)}",
  ".joey-line{padding:5px 0;border-top:1px solid var(--line, #333)}",
  ".joey-line:first-child{border-top:0;padding-top:0}",
  ".joey-line-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}",
  ".joey-who{font-weight:600;font-size:12px;color:var(--accent, #48f)}",
  ".joey-when{font-size:11px}",
  ".joey-line-body{margin-top:3px;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font-size:13px}",
  ".joey-line-now{background:var(--panel2, transparent);border-radius:4px;padding-left:6px;padding-right:6px}",
  ".joey-caret{color:var(--accent, #48f)}",
  ".joey-card.joey-speaking .joey-dog .joey-mouth{animation:joey-jaw .24s ease-in-out infinite alternate}",
  ".joey-card.joey-speaking .joey-dog .joey-head{animation:joey-bob 1.05s ease-in-out infinite}",
  ".joey-card.joey-speaking .joey-dog .joey-tail{animation:joey-wag .4s ease-in-out infinite alternate}",
  ".joey-card.joey-speaking .joey-dog .joey-ear-l{animation:joey-ear-l .5s ease-in-out infinite alternate}",
  ".joey-card.joey-speaking .joey-dog .joey-ear-r{animation:joey-ear-r .55s ease-in-out infinite alternate}",
  ".joey-card.joey-speaking .joey-dog .joey-wave-1{animation:joey-wave 1s ease-out infinite}",
  ".joey-card.joey-speaking .joey-dog .joey-wave-2{animation:joey-wave 1s ease-out .25s infinite}",
  ".joey-card.joey-speaking .joey-meter .joey-bar{animation:joey-bar .5s ease-in-out infinite alternate}",
  ".joey-card.joey-speaking .joey-meter .joey-bar:nth-child(1){animation-delay:0s}",
  ".joey-card.joey-speaking .joey-meter .joey-bar:nth-child(2){animation-delay:.06s}",
  ".joey-card.joey-speaking .joey-meter .joey-bar:nth-child(3){animation-delay:.12s}",
  ".joey-card.joey-speaking .joey-meter .joey-bar:nth-child(4){animation-delay:.18s}",
  ".joey-card.joey-speaking .joey-meter .joey-bar:nth-child(5){animation-delay:.24s}",
  ".joey-card.joey-speaking .joey-meter .joey-bar:nth-child(6){animation-delay:.3s}",
  ".joey-card.joey-speaking .joey-meter .joey-bar:nth-child(7){animation-delay:.36s}",
  ".joey-card.joey-speaking .joey-saying{color:var(--txt, #e8e8e8)}",
  "@keyframes joey-jaw{from{transform:scaleY(.3)}to{transform:scaleY(1)}}",
  "@keyframes joey-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}",
  "@keyframes joey-wag{from{transform:rotate(-11deg)}to{transform:rotate(11deg)}}",
  "@keyframes joey-ear-l{from{transform:rotate(-7deg)}to{transform:rotate(6deg)}}",
  "@keyframes joey-ear-r{from{transform:rotate(7deg)}to{transform:rotate(-6deg)}}",
  "@keyframes joey-wave{0%{opacity:0}30%{opacity:1}100%{opacity:0}}",
  "@keyframes joey-bar{from{height:5px;opacity:.5}to{height:34px;opacity:1}}",
  "@media (prefers-reduced-motion: reduce){",
  ".joey-card.joey-speaking .joey-dog .joey-mouth,",
  ".joey-card.joey-speaking .joey-dog .joey-head,",
  ".joey-card.joey-speaking .joey-dog .joey-tail,",
  ".joey-card.joey-speaking .joey-dog .joey-ear-l,",
  ".joey-card.joey-speaking .joey-dog .joey-ear-r,",
  ".joey-card.joey-speaking .joey-dog .joey-wave-1,",
  ".joey-card.joey-speaking .joey-dog .joey-wave-2,",
  ".joey-card.joey-speaking .joey-meter .joey-bar{animation:none}",
  ".joey-card.joey-speaking .joey-meter .joey-bar{height:24px;opacity:1;background:var(--accent, #48f)}",
  ".joey-card.joey-speaking .joey-dog .joey-wave{opacity:1}",
  "}",
].join("\n");

/* Task lifecycle, mirrored from src/company/gates.ts. */
const GATE_STATUSES = ["pending_intake", "pending_code", "pending_merge"];
const OK_STATUSES = ["merged"];
const BAD_STATUSES = ["failed", "rejected"];
const TERMINAL_STATUSES = OK_STATUSES.concat(BAD_STATUSES);

const STATUS_LABEL = {
  pending_intake: "waiting for your intake approval",
  enhancing: "enhancing the brief",
  planned: "planned",
  pending_code: "waiting for your code approval",
  coding: "coding",
  testing: "testing",
  opposing: "opposing",
  summarizing: "summarizing",
  adjudicating: "adjudicating",
  pending_merge: "waiting for your merge approval",
  merged: "merged",
  rejected: "rejected",
  failed: "failed",
};

/* ── local helpers (kept local so the view never depends on api.js internals) ── */

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function str(v) {
  return v === null || v === undefined ? "" : String(v);
}

function clip(s, n) {
  const t = str(s).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "\u2026" : t;
}

function tsOf(v) {
  const d = v instanceof Date ? v : new Date(str(v));
  return isNaN(d.getTime()) ? "" : d.toISOString();
}

function pillClass(status) {
  if (OK_STATUSES.includes(status)) return "pill pill-ok";
  if (BAD_STATUSES.includes(status)) return "pill pill-err";
  if (GATE_STATUSES.includes(status)) return "pill pill-warn";
  return "pill";
}

/* Report-backs from reportBack() in src/company/assistant.ts look like:
 *   Done: "title" (Project Name, task tmum123).\n<body>
 *   Failed: "title" (Project Name, task tmum123).\nfailed: <reason> */
const REPORT_RE = /^(Done|Failed):\s*"([^"]*)"\s*\(([^,]*),\s*task\s+([A-Za-z0-9_-]+)\)/;

function reportOf(text) {
  const m = REPORT_RE.exec(str(text).trim());
  if (!m) return null;
  return { ok: m[1] === "Done", title: m[2], project: m[3].trim(), taskId: m[4] };
}

/** Markdown-lite: escape first, then only **bold** and `code`. */
function fmt(esc, text) {
  return esc(str(text))
    .replace(/\*\*([^*\n][^*]*)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>");
}

function h(tag, cls) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}

/** "412 KB" / "1.4 MB" for the chips. */
function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "";
  if (v < 1024) return v + " B";
  if (v < 1024 * 1024) return Math.round(v / 1024) + " KB";
  return (v / (1024 * 1024)).toFixed(1) + " MB";
}

/** One page for an image, the PDF's own page count when it could be read. */
function attachPages(a) {
  if (!a) return 0;
  if (str(a.kind) === "pdf") return Number(a.pages) > 0 ? Number(a.pages) : 0;
  return 1;
}

/** Short label for one attachment chip. */
function attachLabel(a) {
  const bits = [];
  const size = fmtBytes(a && a.bytes);
  if (size) bits.push(size);
  if (str(a && a.kind) === "pdf") bits.push(Number(a.pages) > 0 ? a.pages + " pages" : "pages unknown");
  else bits.push("image");
  return bits.join(" \u00b7 ");
}

/**
 * Read one hash-query value as the shell hands it over.
 *
 * public/v2/app.js resolve() parses `#/<view>/<seg>?a=1&b=two` with parseQuery()
 * into `params = { ...query, query }`, i.e. `params.q` and `params.query.q` are
 * the SAME string and it is already decoded (parseQuery does decodeURIComponent
 * and maps `+` to a space; a malformed escape stays raw instead of throwing).
 * So the value is used verbatim here - decoding it a second time would corrupt
 * text like "100% off" (URIError) or double-unescape "%2520".
 *
 * Returns null when the key is absent or not a string (so `?q=` alone - empty
 * value - means "no prefill", exactly like today's `#/assistant`).
 */
function queryParam(ctx, key) {
  const p = ctx && ctx.params ? ctx.params : null;
  if (!p || typeof p !== "object") return null;
  let v = p[key];
  if (v === undefined && p.query && typeof p.query === "object") v = p.query[key];
  if (typeof v !== "string" || !v) return null;
  return v;
}

/* ── the view ──────────────────────────────────────────────────────────── */

export function mount(el, ctx) {
  const esc = ctx.esc;
  const ago = ctx.ago;
  const hm = ctx.hm;
  const api = ctx.api;
  const navigate = ctx.navigate;

  let stopped = false;

  /* state */
  let thread = []; // authoritative GET /company/assistant/thread
  let optimistic = []; // local-only entries not yet visible in the server thread
  let notes = new Map(); // textKey -> { decisions:[], plan:[] } for the last orders
  let titles = new Map(); // taskId -> human title (dispatch + report-backs)
  let statuses = new Map(); // taskId -> { status, projectName, updatedAt }
  let statusOrder = []; // insertion order, for the cache cap
  let assistantStatus = ""; // "idle" | "thinking"
  let loaded = false;
  let loadErr = null;
  let flowErr = null;
  let stale = false; // last poll failed but we still show the previous data
  let sending = false;
  let sendErr = null;
  let lastSent = "";
  let autoRun = true;
  /* Attachments (ATTACH): uploaded one by one as soon as they are chosen; Send only
   * ever carries the ids the server already accepted. */
  let attachments = [];
  let attachBusy = 0;
  let attachWarn = "";
  let needsYou = []; // items from GET /api/needs-you (or /company/briefing fallback)
  let needsErr = null;
  let needsBusy = new Set(); // item ids currently resolving
  let needsResult = null; // { text, tone } shown under the needs-you list

  /* VOICE-IN: hold-to-talk state. voiceState is one of
   * "idle" | "listening" | "thinking" | "speaking" | "error" (docs/VOICE_STT_SPEC.md
   * section 3). The state label is shared with the plain typed flow on purpose:
   * a typed send also means "thinking" while the reply is in flight. voiceErr
   * holds a human message for the label row, and voiceReplyMs the measured
   * release-to-rendered time of the last voice order. */
  let voiceState = "idle";
  let voiceErr = null;
  let voiceReplyMs = null;
  let voiceAbort = null;
  let voiceRecordStart = 0;
  let voiceRecorder = null;
  let voiceStream = null;
  let voiceChunks = [];
  let turnVoiceTimer = 0;
  let voicePlayHooks = [];
  const VOICE_SPEAK_TIMEOUT = 4000;

  /* SPEAK: one speech session at a time, for the utterance Joey is saying right now.
   * speech === null means silent, and silent means the companion has no running animation. */
  let speech = null; // { key, text, startedAt, durationMs, source: "estimate" | "audio" }
  let speechTimer = 0; // the 100 ms tick that drives the reveal + progress bar (only while speaking)
  let spokenKeys = new Set(); // keyOf(assistant message) already turned into a session
  let speakPrimed = false; // the first thread load only marks history, it never animates
  let speakFreshSince = Date.now() - SPEAK_FRESH_GRACE_MS; // utterances older than this page-open moment never animate
  let lastUtteranceText = ""; // for a real <audio> element that starts without a new message
  let audioEl = null; // sibling TTS playback element, if one ever lands in this view
  let liveText = null; // text node of the transcript line whose words are still arriving
  let liveCaret = null;
  let liveFull = "";

  /* ── COMPANION-TRUTH (work order fomunyphtc/WO1): the real speaker, when it can be read ──
   * The estimate above is a stand-in, and the module comment says so. The missing piece was
   * a way for the page to observe the machine's speaker: the speech server (tools/tts/
   * server.mjs) sends no CORS headers, so a browser cannot read it, and no router route
   * exposed it. `GET /company/assistant/speech` now does (an additive loopback route in
   * src/server.ts that proxies the speech server's own /tts/health and answers
   * {ok, speaking} from lastPlayback.playing).
   *
   * While that route answers, a speech session is "router"-sourced: playback ENDS it once it
   * has actually been seen, and it is never cut short before then - the router hands the text
   * to the speech server before that server starts playing it, so "not playing yet" is normal
   * for the first seconds. A reply the machine never plays at all (speech server down) runs to
   * its estimated length instead of freezing early; with the voice toggle off no session
   * starts. On a router built before the route - every router until its next supervised
   * restart - the probe is a 404, `route` stays false, and the estimate governs exactly as
   * before, so this wiring can never make the page depend on a restart. */
  const SPEECH_PROBE_MS = 1500; // loopback read cadence while the view is open
  const SPEECH_PROBE_RETRY_MS = 300000; // route absent: re-check every 5 min, NOT every tick
  const ROUTER_SILENT_GRACE_MS = 1500; // playback stopped: how long before calling it silence
  const speechProbe = { route: false, speaking: false, askedAt: 0 };

  /* cadence note: while the route is there this is polled every SPEECH_PROBE_MS. While it is
   * NOT (every router until its next restart, so the live page today) the page asks once and
   * then once per SPEECH_PROBE_RETRY_MS. That matters because Chromium prints its own
   * "Failed to load resource: 404" console line for the response no matter how this code
   * catches it, and a page open for hours must not fill the console with it: one line per
   * five minutes while the route is missing, zero once the router is restarted onto it. */

  async function refreshSpeechProbe() {
    if (!api) return;
    const now = Date.now();
    if (!speechProbe.route && now - speechProbe.askedAt < SPEECH_PROBE_RETRY_MS) return;
    speechProbe.askedAt = now;
    let r = null;
    try {
      r = await api("/company/assistant/speech", { ttl: 0 });
    } catch (e) {
      if (stopped) return;
      if (speechProbe.route) {
        // It answered before and does not now (router restarted onto an older build, or a
        // network hiccup): fall back to the estimate rather than freezing a stale "speaking".
        speechProbe.route = false;
        speechProbe.speaking = false;
        console.warn("[speak] speech probe gone (" + str(e && e.status) + "): back to the estimate");
      }
      return;
    }
    if (stopped || !r) return;
    const first = !speechProbe.route;
    speechProbe.route = true;
    speechProbe.speaking = r.speaking === true;
    if (first) console.log("[speak] speech probe live: the machine's own playback is the source of truth");
    // The machine is talking about something this page never saw born (a report-back written
    // while the tab was hidden, say): follow it, the same way the <audio> hook does.
    if (speechProbe.speaking && !speech && lastUtteranceText) startSpeech(lastUtteranceText, "router");
  }

  /* STT-HEALTH: "unknown" until the first probe answers, then "up" or "down".
   * Only "down" disables the mic and prints the fallback line (see the module
   * comment on STT_HEALTH_MS for why "unknown" does not). */
  let sttHealth = "unknown";
  let sttDetail = "";
  async function refreshSttHealth() {
    try {
      const r = await api("/company/assistant/stt/health", { ttl: 0 });
      if (stopped) return;
      const ok = !!(r && r.ok === true);
      const next = ok ? "up" : "down";
      sttDetail = ok ? "" : str(r && (r.detail || r.message));
      if (next !== sttHealth) {
        sttHealth = next;
        // Waking up after an outage: a stale "Didn't catch that"/"not reachable"
        // line from the failed attempt would otherwise sit under an enabled mic.
        if (ok && voiceState === "error" && voiceErr) {
          voiceErr = null;
          voiceState = "idle";
        }
        console.log(`[stt] health ${next}${sttDetail ? " (" + sttDetail + ")" : ""}`);
      }
      paintVoice();
    } catch (e) {
      // The router itself did not answer. Not an STT verdict: leave the mic as it
      // is, and let a real press report the real failure.
      if (stopped) return;
      if (sttHealth === "down") {
        sttHealth = "unknown";
        sttDetail = str(e && e.message ? e.message : e);
        paintVoice();
      }
    }
  }
  const sttDown = () => sttHealth === "down";
  const voiceClearSpeaking = () => {
    for (const fn of voicePlayHooks) {
      try {
        fn();
      } catch {
        /* never let a stale TTS hook break the view */
      }
    }
    voicePlayHooks = [];
  };

  /* ── status cache ── */
  function mergeTitles(list) {
    for (const d of asArray(list)) {
      if (d && d.taskId) titles.set(d.taskId, str(d.title) || str(d.subtask) || str(d.taskId));
    }
  }

  function ingestFlow(tasks) {
    for (const t of asArray(tasks)) {
      if (!t || !t.taskId) continue;
      const prev = statuses.get(t.taskId);
      // Never downgrade a status we already saw as terminal (the flow window
      // only carries the newest N tasks, so old ones age out).
      if (prev && TERMINAL_STATUSES.includes(prev.status) && !TERMINAL_STATUSES.includes(t.status)) continue;
      if (!prev) statusOrder.push(t.taskId); // order is only for the cache cap
      statuses.set(t.taskId, {
        status: str(t.status) || "unknown",
        projectName: str(t.projectName) || (prev ? prev.projectName : ""),
        updatedAt: tsOf(t.updatedAt),
      });
    }
    // Bound the cache: drop unknown tasks oldest-first, but never a task this
    // conversation still points at. Bounded passes, so a poll can't spin.
    let guard = statusOrder.length;
    while (statusOrder.length > TASK_CACHE_CAP && guard-- > 0) {
      const drop = statusOrder.shift();
      if (referencedTaskIds().has(drop)) {
        statusOrder.push(drop);
        continue;
      }
      statuses.delete(drop);
    }
  }

  function referencedTaskIds() {
    const set = new Set();
    for (const m of thread.concat(optimistic)) {
      for (const id of asArray(m.tasks)) if (id) set.add(str(id));
    }
    return set;
  }

  /* ── conversation assembly ── */
  function keyOf(m) {
    const t = str(m.text).replace(/\s+/g, " ").trim();
    return str(m.role) + "\u0000" + t.slice(0, 200);
  }

  function sameText(a, b) {
    const x = str(a).replace(/\s+/g, " ").trim();
    const y = str(b).replace(/\s+/g, " ").trim();
    if (!x || !y) return x === y;
    if (x === y) return true;
    const n = Math.min(120, x.length, y.length);
    return x.slice(0, n) === y.slice(0, n);
  }

  function messages() {
    const list = thread.map((m) => ({
      ts: tsOf(m.ts),
      role: m.role === "ceo" ? "ceo" : "assistant",
      text: str(m.text),
      tasks: asArray(m.tasks).map(str).filter(Boolean),
      // ATTACH: file names recorded with the order (older entries have none).
      attachments: asArray(m.attachments).map(str).filter(Boolean),
      pending: false,
    }));
    for (const o of optimistic) {
      // drop a local entry as soon as the server thread carries it
      const known = list.some((m) => m.role === o.role && sameText(m.text, o.text));
      if (known) continue;
      list.push(o);
    }
    list.sort((a, b) => (b.ts || "").localeCompare(a.ts || "")); // newest first
    return list;
  }

  /* ── DOM skeleton (built once; only the parts change on re-render) ── */
  el.innerHTML = "";
  const root = h("div", "col");
  root.style.gap = "10px";

  /* composer */
  const composer = h("div", "card");
  const cHead = h("div", "row");
  cHead.style.alignItems = "center";
  cHead.style.gap = "8px";
  cHead.style.flexWrap = "wrap";
  const cTitle = h("strong");
  cTitle.textContent = "Ask the CEO assistant";
  const cStatus = h("span", "pill");
  cStatus.textContent = "loading\u2026";
  cStatus.setAttribute("aria-live", "polite");
  cHead.appendChild(cTitle);
  cHead.appendChild(cStatus);

  const input = h("textarea");
  input.rows = 3;
  input.placeholder = "Give an order\u2026  Enter sends, Shift+Enter adds a line.";
  input.setAttribute("aria-label", "Message to the CEO assistant");
  input.style.width = "100%";
  input.style.boxSizing = "border-box";
  input.style.minHeight = "72px";
  input.style.resize = "vertical";
  input.style.font = "inherit";
  input.style.padding = "8px";
  input.style.marginTop = "8px";
  input.style.background = "var(--panel2, transparent)";
  input.style.color = "var(--txt, inherit)";
  input.style.border = "1px solid var(--line, #333)";
  input.style.borderRadius = "6px";

  const sendRow = h("div", "row");
  sendRow.style.gap = "8px";
  sendRow.style.alignItems = "center";
  sendRow.style.flexWrap = "wrap";
  sendRow.style.marginTop = "8px";

  const sendBtn = h("button", "btn btn-primary");
  sendBtn.type = "button";
  sendBtn.textContent = "Send";
  sendBtn.style.minHeight = "40px";
  sendBtn.style.padding = "8px 16px";

  const runBtn = h("button", "btn");
  runBtn.type = "button";
  runBtn.style.minHeight = "40px";

  const hint = h("span", "muted");
  hint.textContent = "Enter sends \u00b7 Shift+Enter new line \u00b7 runs spend model budget";
  hint.style.fontSize = "12px";

  // JOEY-WIRE: plain "Joey voice" checkbox, persisted in localStorage.
  const voiceCheck = h("label", "muted");
  voiceCheck.style.fontSize = "12px";
  voiceCheck.style.display = "inline-flex";
  voiceCheck.style.alignItems = "center";
  voiceCheck.style.gap = "4px";
  const voiceInput = h("input");
  voiceInput.type = "checkbox";
  voiceInput.checked = readJoeyVoice();
  voiceCheck.appendChild(voiceInput);
  const voiceLabel = h("span");
  voiceLabel.textContent = "Joey voice";
  voiceCheck.appendChild(voiceLabel);

  sendRow.appendChild(sendBtn);
  sendRow.appendChild(runBtn);
  sendRow.appendChild(hint);
  sendRow.appendChild(voiceCheck);

  const composerErr = h("div", "muted");
  composerErr.style.display = "none";
  composerErr.style.marginTop = "8px";
  composerErr.style.color = "var(--err, inherit)";

  composer.appendChild(cHead);
  composer.appendChild(input);

  /* VOICE-IN: hold-to-talk button + its state/error line, built so Joey can be
   * dictated to without touching the keyboard. Plain layout on purpose: the
   * button sits next to Send (and holding Space while the text box is empty
   * does the same thing), and one muted line under that carries the state and
   * any voice-specific error. If MediaRecorder/getUserMedia are missing the
   * button still mounts, clicks are refused with a real message, and typed
   * orders work exactly as before. */
  const voiceBtn = h("button", "btn");
  voiceBtn.type = "button";
  voiceBtn.textContent = "🎤 Hold to talk";
  voiceBtn.title = "Hold the mouse button down (or hold Space with the text box empty), talk, and release to send";
  voiceBtn.style.minHeight = "40px";
  voiceBtn.style.touchAction = "none"; // the press is a touch hold, not a scroll: never let the page take it

  const voiceRow = h("div", "row");
  voiceRow.style.gap = "8px";
  voiceRow.style.alignItems = "center";
  voiceRow.style.flexWrap = "wrap";
  voiceRow.style.marginTop = "4px";
  voiceRow.appendChild(voiceBtn);

  const voiceStatePill = h("span", "pill");
  voiceStatePill.style.display = "none";
  voiceStatePill.setAttribute("aria-live", "polite");
  voiceStatePill.textContent = "Mic ready";
  voiceRow.appendChild(voiceStatePill);

  const voiceTime = h("span", "muted");
  voiceTime.style.fontSize = "12px";
  voiceTime.style.display = "none";
  voiceTime.textContent = "";
  voiceRow.appendChild(voiceTime);

  const voiceNote = h("div", "muted");
  voiceNote.style.fontSize = "12px";
  voiceNote.style.marginTop = "4px";
  voiceNote.style.color = "var(--warn, inherit)";
  voiceNote.style.display = "none";
  voiceNote.textContent = "";

  composer.appendChild(voiceRow);
  composer.appendChild(voiceNote);

  /* attachments (ATTACH): paperclip + drag-and-drop, one chip per file */
  const fileInput = h("input");
  fileInput.type = "file";
  fileInput.multiple = true;
  fileInput.accept = ATTACH_ACCEPT;
  fileInput.style.display = "none";
  fileInput.setAttribute("aria-hidden", "true");

  const attachRow = h("div", "row");
  attachRow.style.gap = "8px";
  attachRow.style.alignItems = "center";
  attachRow.style.flexWrap = "wrap";
  attachRow.style.marginTop = "6px";

  const clipBtn = h("button", "btn");
  clipBtn.type = "button";
  clipBtn.textContent = "\u{1F4CE} Attach files";
  clipBtn.title = "Attach a PDF, PNG, JPG or WEBP to this message";
  clipBtn.style.minHeight = "32px";
  clipBtn.style.padding = "4px 10px";

  const attachHint = h("span", "muted");
  attachHint.style.fontSize = "12px";
  attachHint.textContent =
    "PDF, PNG, JPG or WEBP \u00b7 drop a file here or press Attach \u00b7 up to 20 pages/images and 25 MB in total";

  attachRow.appendChild(clipBtn);
  attachRow.appendChild(fileInput);
  attachRow.appendChild(attachHint);

  const attachChipBox = h("div", "row");
  attachChipBox.style.gap = "6px";
  attachChipBox.style.flexWrap = "wrap";
  attachChipBox.style.marginTop = "6px";
  attachChipBox.style.display = "none";

  const attachNote = h("div", "muted");
  attachNote.style.fontSize = "12px";
  attachNote.style.marginTop = "4px";
  attachNote.style.display = "none";

  composer.appendChild(attachRow);
  composer.appendChild(attachChipBox);
  composer.appendChild(attachNote);
  composer.appendChild(sendRow);
  composer.appendChild(composerErr);

  /* live strip */
  const live = h("div", "card");
  live.style.display = "none";

  /* conversation */
  const threadBox = h("div", "col");
  threadBox.style.gap = "8px";

  /* ── SPEAK: companion card (above the conversation) and live transcript (below it) ──
   * Built once here like the rest of the skeleton; only their contents change on render.
   * The companion starts in the idle class, i.e. completely still, which is the state the
   * page must be in when Joey is not speaking. */
  const speakStyle = h("style");
  speakStyle.setAttribute("data-owner", "assistant-speak");
  speakStyle.textContent = SPEAK_CSS;

  const companionCard = h("div", "card joey-card joey-idle");
  const compHead = h("div", "row");
  compHead.style.alignItems = "center";
  compHead.style.gap = "8px";
  compHead.style.flexWrap = "wrap";
  const compTitle = h("strong");
  compTitle.textContent = "Joey";
  const compState = h("span", "pill");
  compState.textContent = "Silent";
  compState.setAttribute("aria-live", "polite");
  compState.title = "Speaking animates the mouth, ears, tail and level meter; silent means none of them move.";
  const compHint = h("span", "muted");
  compHint.style.fontSize = "12px";
  compHint.textContent = "talking vs silent";
  compHead.appendChild(compTitle);
  compHead.appendChild(compState);
  compHead.appendChild(compHint);

  const stage = h("div", "row joey-stage");
  stage.style.gap = "12px";
  stage.style.flexWrap = "wrap";
  stage.style.marginTop = "8px";
  const dogBox = h("div");
  dogBox.innerHTML = SPEAK_DOG_SVG;
  const meter = h("div", "joey-meter");
  for (let i = 0; i < SPEAK_METER_BARS; i++) meter.appendChild(h("i", "joey-bar"));
  meter.title = "Level meter: moves only while Joey is speaking";
  const sayCol = h("div", "joey-say-col");
  const sayEl = h("div", "joey-saying");
  const prog = h("div", "joey-prog");
  const progFill = h("i");
  prog.appendChild(progFill);
  sayCol.appendChild(sayEl);
  sayCol.appendChild(prog);
  stage.appendChild(dogBox);
  stage.appendChild(meter);
  stage.appendChild(sayCol);
  companionCard.appendChild(compHead);
  companionCard.appendChild(stage);

  const transcriptCard = h("div", "card joey-card");
  const trHead = h("div", "row");
  trHead.style.alignItems = "center";
  trHead.style.gap = "8px";
  trHead.style.flexWrap = "wrap";
  const trTitle = h("strong");
  trTitle.textContent = "Live transcript";
  const trCount = h("span", "pill");
  trCount.textContent = "0";
  const trHint = h("span", "muted");
  trHint.style.fontSize = "12px";
  trHint.textContent = "everything Joey says, as it is said \u00b7 newest at the bottom";
  trHead.appendChild(trTitle);
  trHead.appendChild(trCount);
  trHead.appendChild(trHint);
  const transcriptScroll = h("div", "joey-transcript");
  const transcriptBox = h("div", "joey-lines");
  transcriptScroll.appendChild(transcriptBox);
  transcriptCard.appendChild(trHead);
  transcriptCard.appendChild(transcriptScroll);

  root.appendChild(composer);
  root.appendChild(live);
  root.appendChild(companionCard);
  root.appendChild(threadBox);
  root.appendChild(transcriptCard);
  el.appendChild(root);
  el.appendChild(speakStyle); // the view's own stylesheet; removed again on cleanup

  /* Needs-you panel: compact decisions list above the composer. */
  const needsPanel = h("div", "card");
  needsPanel.style.display = "none";
  root.insertBefore(needsPanel, composer);

  /* Deep link prefill (#/assistant?q=…, the Briefing "Ask the assistant about
   * this" links). Text only: the query never reaches innerHTML, and the order is
   * NOT sent - the CEO reviews the text and presses Send (or Enter) himself.
   * `#/assistant` with no q (or an empty q) leaves the composer exactly as
   * before, and a re-mount (hashchange -> cleanup -> mount) picks up a new q. */
  const prefill = queryParam(ctx, "q");
  if (prefill) {
    input.value = prefill;
    input.focus();
    // Caret at the end so the CEO can keep typing; setSelectionRange is absent in
    // some minimal DOM stubs, and focus alone is a fine fallback there.
    if (typeof input.setSelectionRange === "function") {
      try {
        input.setSelectionRange(prefill.length, prefill.length);
      } catch {
        /* ignore: not a text-like control in this environment */
      }
    }
  }

  /* ── attachments (ATTACH) ─────────────────────────────────────────────
   * One file per request, uploaded the moment it is chosen or dropped: the CEO sees a
   * real result per file (size, pages) and Send only ever carries ids the server has
   * accepted. The limits are the CEO's: warn over 20 pages/images, refuse over 25 MB. */
  function attachmentTotals() {
    let bytes = 0;
    let pages = 0;
    for (const a of attachments) {
      bytes += Number(a.bytes) || 0;
      pages += attachPages(a);
    }
    return { bytes, pages };
  }

  function attachBlocked() {
    // Only a broken state blocks Send. The CEO's 20 pages/images and 25 MB rules are
    // warnings, per the work order ("warn if ..."), and the server accepts a set of
    // files that is over 25 MB in total, so the CEO stays in control of sending it.
    return attachments.some((a) => a.error) || attachBusy > 0;
  }

  function paintAttachments() {
    attachChipBox.innerHTML = "";
    attachChipBox.style.display = attachments.length ? "" : "none";
    for (const a of attachments) {
      const pill = h("span", "pill" + (a.error ? " pill-err" : a.busy ? " pill-warn" : ""));
      if (a.error) pill.title = a.error;
      pill.appendChild(document.createTextNode(clip(a.name, 42)));
      const meta = h("span", "muted");
      meta.style.fontSize = "11px";
      meta.style.marginLeft = "6px";
      meta.textContent = a.busy ? "uploading\u2026" : a.error ? "failed" : attachLabel(a);
      pill.appendChild(meta);
      const rm = h("button", "btn");
      rm.type = "button";
      rm.textContent = "\u00d7";
      rm.title = "Remove this file";
      rm.style.marginLeft = "6px";
      rm.style.minHeight = "20px";
      rm.style.padding = "0 6px";
      rm.addEventListener("click", () => {
        attachments = attachments.filter((x) => x !== a);
        paintAttachments();
        updateComposer();
      });
      pill.appendChild(rm);
      attachChipBox.appendChild(pill);
    }
    const { bytes, pages } = attachmentTotals();
    const notes = [];
    // A failed upload must explain itself in words the CEO can act on (on a stale router that
    // is the "needs a restart" message), not just show a red "failed" chip.
    for (const a of attachments) {
      if (a.error) notes.push(clip(a.name, 40) + " could not be attached: " + str(a.error));
    }
    if (attachWarn) notes.push(attachWarn);
    if (pages > ATTACH_PAGES_LIMIT) {
      notes.push(
        "Heads-up: " + pages + " pages/images in total, over the " + ATTACH_PAGES_LIMIT +
          " you asked about. The assistant can still read them.",
      );
    }
    if (bytes > ATTACH_BYTES_LIMIT) {
      notes.push(
        "Heads-up: " + fmtBytes(bytes) + " in total, over the 25 MB you asked about. Send still works.",
      );
    }
    attachNote.textContent = notes.join(" ");
    attachNote.style.display = notes.length ? "" : "none";
    attachNote.style.color = attachBlocked() ? "var(--err, inherit)" : "";
  }

  async function uploadOne(file) {
    const entry = { name: str(file.name) || "attachment", bytes: Number(file.size) || 0, busy: true };
    attachments.push(entry);
    paintAttachments();
    updateComposer();
    try {
      const token = await companyToken();
      const headers = { "x-file-name": encodeURIComponent(entry.name) };
      if (file.type) headers["content-type"] = file.type;
      if (token) headers["x-company-token"] = token;
      const res = await fetch("/company/uploads", { method: "POST", headers: headers, body: file });
      const data = await res.json().catch(() => null);
      if (res.status === 404) {
        // The route is newer than the running router: say so instead of a bare "HTTP 404".
        throw new Error("this router does not have POST /company/uploads yet - it needs a restart to pick up the attachment feature");
      }
      if (!res.ok) throw new Error((data && (data.detail || data.error)) || "HTTP " + res.status);
      Object.assign(entry, data, { busy: false });
    } catch (e) {
      entry.busy = false;
      entry.error = str(e && e.message ? e.message : e);
    }
    attachBusy = Math.max(0, attachBusy - 1);
    if (!stopped) {
      paintAttachments();
      updateComposer();
    }
  }

  function addFiles(fileList) {
    const files = Array.prototype.slice.call(fileList || []);
    attachWarn = "";
    for (const f of files) {
      const name = str(f.name);
      const type = str(f.type);
      if (Number(f.size) > ATTACH_BYTES_LIMIT) {
        attachWarn = clip(name, 40) + " is " + fmtBytes(f.size) + ", bigger than the 25 MB limit.";
        continue;
      }
      // A cheap client-side gate so an obviously wrong file is not uploaded at all.
      // The server still decides for real, from the magic bytes.
      if (!ATTACH_NAME_RE.test(name) && type.indexOf("image/") !== 0 && type !== "application/pdf") {
        attachWarn = clip(name, 40) + " is not a PDF, PNG, JPG or WEBP.";
        continue;
      }
      attachBusy++;
      void uploadOne(f);
    }
    paintAttachments();
    updateComposer();
  }

  function updateComposer() {
    const empty = !input.value.trim();
    sendBtn.disabled = sending || empty || attachBusy > 0 || attachBlocked();
    sendBtn.title = attachBusy > 0
      ? "Waiting for the attached file to finish uploading"
      : attachments.some((a) => a.error)
        ? "Remove the file that failed to upload first"
        : "";
    sendBtn.textContent = sending ? "Sending\u2026" : "Send";
    sendBtn.setAttribute("aria-busy", sending ? "true" : "false");
    // The textarea stays usable while an order is being planned (the reply can
    // take a minute); only the Send button locks, so an order can't double-fire.
    runBtn.disabled = sending;
    runBtn.textContent = autoRun ? "Run now: on" : "Run now: off";
    runBtn.setAttribute(
      "title",
      autoRun
        ? "On: each planned task starts its pipeline immediately (spends budget)."
        : "Off: tasks are created but nothing runs until you start it. No model spend.",
    );
    if (sendErr) {
      composerErr.style.display = "";
      composerErr.innerHTML = "";
      const strong = h("strong");
      strong.textContent = "Send failed: ";
      composerErr.appendChild(strong);
      composerErr.appendChild(document.createTextNode(sendErr));
      const retry = h("button", "btn");
      retry.type = "button";
      retry.textContent = "Retry";
      retry.style.marginLeft = "8px";
      retry.style.minHeight = "32px";
      retry.addEventListener("click", () => {
        sendErr = null;
        updateComposer();
        void send(lastSent);
      });
      composerErr.appendChild(retry);
      if (!input.value.trim()) input.value = lastSent;
    } else {
      composerErr.style.display = "none";
      composerErr.innerHTML = "";
    }
    if (cStatus) {
      cStatus.className = assistantStatus === "thinking" || sending || optimistic.length > 0 ? "pill pill-warn" : "pill";
      cStatus.textContent = sending
        ? "sending\u2026"
        : assistantStatus === "thinking"
          ? "thinking\u2026"
          : optimistic.length > 0
            ? "handing off\u2026"
            : "idle";
    }
  }

  /* chip for one task: links to #/flow/:taskId, carries the live status */
  function chip(taskId, opts) {
    const info = statuses.get(taskId);
    const status = info ? info.status : "unknown";
    const gate = GATE_STATUSES.includes(status);
    const a = h("a", pillClass(status));
    a.href = "#/flow/" + encodeURIComponent(taskId);
    a.style.display = "inline-block";
    a.style.maxWidth = "100%";
    a.style.overflowWrap = "anywhere";
    a.style.lineHeight = "1.5";
    a.title =
      (titles.get(taskId) || taskId) +
      " \u2014 " +
      (STATUS_LABEL[status] || "status unknown (older than the live window)") +
      (info && info.projectName ? " \u00b7 " + info.projectName : "") +
      "\nClick for the full chain timeline.";
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      if (typeof navigate === "function") navigate("#/flow/" + encodeURIComponent(taskId));
      else location.hash = "#/flow/" + encodeURIComponent(taskId);
    });
    const label = opts && opts.short ? clip(titles.get(taskId) || taskId, 34) : clip(titles.get(taskId) || taskId, 52);
    a.innerHTML =
      esc(label) +
      ' <span class="muted">' +
      esc(STATUS_LABEL[status] || (statuses.has(taskId) ? status : "status unknown")) +
      "</span>";
    if (gate) a.setAttribute("data-gate", "1");
    return a;
  }

  function chipRow(ids) {
    const row = h("div", "row");
    row.style.display = "flex";
    row.style.flexWrap = "wrap";
    row.style.gap = "6px";
    row.style.marginTop = "8px";
    for (const id of asArray(ids)) row.appendChild(chip(str(id)));
    return row;
  }

  function bodyNode(text, key) {
    const wrap = h("div");
    wrap.style.whiteSpace = "pre-wrap";
    wrap.style.overflowWrap = "anywhere";
    wrap.style.wordBreak = "break-word";
    const full = str(text);
    if (full.length <= BODY_CLAMP) {
      wrap.innerHTML = fmt(esc, full);
      return wrap;
    }
    const head = h("div");
    const rest = h("div");
    rest.innerHTML = fmt(esc, full.slice(BODY_CLAMP));
    const more = h("button", "btn");
    more.type = "button";
    more.style.marginTop = "6px";
    more.style.minHeight = "28px";
    // apply() is the single place that touches the DOM for this control, so the open state
    // can be restored after every rebuild instead of living only on the element.
    const apply = (open) => {
      if (key && open) expandedBodies.add(key);
      else if (key) expandedBodies.delete(key);
      rest.style.display = open ? "" : "none";
      head.innerHTML = open ? fmt(esc, full.slice(0, BODY_CLAMP)) : fmt(esc, full.slice(0, BODY_CLAMP)) + "\u2026";
      more.textContent = open ? "Show less" : "Show more";
    };
    more.addEventListener("click", () => apply(!(key && expandedBodies.has(key))));
    apply(!!key && expandedBodies.has(key));
    wrap.appendChild(head);
    wrap.appendChild(rest);
    wrap.appendChild(more);
    return wrap;
  }

  function notesNode(entry) {
    const n = notes.get(keyOf(entry));
    if (!n) return null;
    const parts = [];
    for (const d of asArray(n.decisions).slice(0, 8)) parts.push("\u2022 " + str(d));
    if (!parts.length) return null;
    const box = h("details", "muted");
    box.style.marginTop = "6px";
    box.style.fontSize = "12px";
    // Same bug class as "Show more": a rebuild every 5 s closed this <details>, so its open
    // state is persisted by message identity too.
    const whyKey = keyOf(entry);
    box.open = openWhyBoxes.has(whyKey);
    box.addEventListener("toggle", () => {
      if (box.open) openWhyBoxes.add(whyKey);
      else openWhyBoxes.delete(whyKey);
    });
    const sum = h("summary");
    sum.textContent = "why (" + parts.length + " planner note" + (parts.length === 1 ? "" : "s") + ")";
    const ul = h("div");
    ul.style.whiteSpace = "pre-wrap";
    ul.style.overflowWrap = "anywhere";
    ul.textContent = parts.join("\n");
    box.appendChild(sum);
    box.appendChild(ul);
    return box;
  }

  function messageCard(m) {
    const rep = reportOf(m.text);
    const card = h("div", "card");
    card.style.borderLeft = "3px solid " + (rep ? (rep.ok ? "var(--ok, #3a7)" : "var(--err, #c33)") : m.role === "ceo" ? "var(--dim, #888)" : "var(--accent, #48f)");

    const head = h("div", "row");
    head.style.display = "flex";
    head.style.flexWrap = "wrap";
    head.style.alignItems = "baseline";
    head.style.gap = "8px";

    const who = h("strong", m.role === "ceo" ? "who-ceo" : "who-assistant");
    who.textContent = m.role === "ceo" ? "CEO" : "Joey";
    head.appendChild(who);

    const when = h("span", "muted");
    when.textContent = hm(m.ts) + (ago(m.ts) ? " (" + ago(m.ts) + ")" : "");
    head.appendChild(when);

    if (rep) {
      const tag = h("span", rep.ok ? "pill pill-ok" : "pill pill-err");
      tag.textContent = rep.ok ? "done" : "failed";
      head.appendChild(tag);
      if (rep.project) {
        const p = h("span", "muted");
        p.textContent = rep.project;
        head.appendChild(p);
      }
      titles.set(rep.taskId, rep.title || titles.get(rep.taskId) || rep.taskId);
    }
    if (m.pending) {
      const pend = h("span", "pill pill-warn");
      pend.textContent = "not yet confirmed by the router";
      head.appendChild(pend);
    }
    // VOICE-IN: the CEO must see which orders came in by voice (docs/VOICE_STT_SPEC.md
    // section 3). The thread only sets spoken:true on the CEO entry of a spoken order.
    if (m.spoken) {
      const spokenTag = h("span", "pill");
      spokenTag.textContent = "\u{1F3A4} spoken";
      spokenTag.title = "This order came in by voice; the text is what the speech-to-text server heard.";
      head.appendChild(spokenTag);
    }
    card.appendChild(head);

    const body = bodyNode(m.text, keyOf(m));
    body.style.marginTop = "6px";
    card.appendChild(body);

    // ATTACH: which files went with this order. Plain words, one line, no links: the
    // paths are long and the CEO only needs to recognise the file here.
    const attached = asArray(m.attachments).map(str).filter(Boolean);
    if (attached.length) {
      const files = h("div", "muted");
      files.style.marginTop = "4px";
      files.style.fontSize = "12px";
      files.textContent =
        "Attached " + attached.length + (attached.length === 1 ? " file: " : " files: ") + attached.join(", ");
      card.appendChild(files);
    }

    const nn = notesNode(m);
    if (nn) card.appendChild(nn);

    if (asArray(m.tasks).length) card.appendChild(chipRow(m.tasks));
    return card;
  }

  function renderLive() {
    const ids = Array.from(referencedTaskIds());
    const inFlight = ids.filter((id) => {
      const st = statuses.get(id);
      return st && !TERMINAL_STATUSES.includes(st.status);
    });
    const gates = ids.filter((id) => {
      const st = statuses.get(id);
      return st && GATE_STATUSES.includes(st.status);
    });
    const errs = ids.filter((id) => {
      const st = statuses.get(id);
      return st && BAD_STATUSES.includes(st.status);
    });

    live.innerHTML = "";
    live.style.display = "";
    const head = h("div", "row");
    head.style.display = "flex";
    head.style.flexWrap = "wrap";
    head.style.alignItems = "center";
    head.style.gap = "8px";
    const t = h("strong");
    t.textContent = ids.length ? "Live work from this conversation" : "Live work";
    head.appendChild(t);

    const counts = [
      [inFlight.length, inFlight.length === 1 ? "order in flight" : "orders in flight", ""],
      [gates.length, gates.length === 1 ? "needs your approval" : "need your approval", "pill pill-warn"],
      [errs.length, errs.length === 1 ? "failed" : "failed", "pill pill-err"],
    ];
    let any = false;
    for (const [n, label, cls] of counts) {
      if (!n) continue;
      any = true;
      const p = h("span", cls || "pill");
      p.textContent = n + " " + label;
      head.appendChild(p);
    }
    if (!any) {
      const p = h("span", "muted");
      p.textContent = loaded ? "nothing in flight right now" : "loading\u2026";
      head.appendChild(p);
    }
    if (stale) {
      const p = h("span", "pill pill-warn");
      p.textContent = "can't reach the router \u2014 showing the last known state";
      head.appendChild(p);
    } else if (flowErr && ids.length) {
      const p = h("span", "muted");
      p.textContent = "live status unavailable (" + str(flowErr.message || flowErr) + ")";
      head.appendChild(p);
    }
    live.appendChild(head);

    if (ids.length) live.appendChild(chipRow(inFlight.length ? inFlight : ids.slice(0, 12)));
    else if (loaded) {
      const p = h("div", "muted");
      p.textContent = "Type an order above and the tasks it creates will appear here with their live status.";
      live.appendChild(p);
    }
  }

  function renderThread() {
    threadBox.innerHTML = "";

    if (!loaded && !thread.length && !optimistic.length) {
      if (loadErr) {
        threadBox.appendChild(errorCard(loadErr));
      } else {
        const c = h("div", "card muted");
        c.textContent = "Loading the conversation\u2026";
        threadBox.appendChild(c);
      }
      return;
    }

    if (loadErr) threadBox.appendChild(errorCard(loadErr));

    const list = messages();
    if (!list.length) {
      threadBox.appendChild(emptyCard());
      return;
    }
    for (const m of list) threadBox.appendChild(messageCard(m));
  }

  function errorCard(err) {
    const c = h("div", "card state-error");
    const t = h("div", "state-title");
    t.textContent = "Can't load the conversation";
    c.appendChild(t);
    const d = h("div", "muted small wrap-any");
    d.textContent = str(err && err.message ? err.message : err) + (err && err.status ? " (HTTP " + err.status + ")" : "");
    c.appendChild(d);
    const btn = h("button", "btn btn-primary btn-sm");
    btn.type = "button";
    btn.textContent = "Retry";
    btn.addEventListener("click", () => {
      loadErr = null;
      renderThread();
      void refresh();
    });
    c.appendChild(btn);
    return c;
  }

  function emptyCard() {
    const c = h("div", "card");
    const t = h("strong");
    t.textContent = "No orders yet";
    c.appendChild(t);
    const d = h("div", "muted");
    d.style.marginTop = "4px";
    d.textContent =
      "This is Joey: an order here is planned, dispatched to a department, worked and reported back. Try one of these:";
    c.appendChild(d);
    const row = h("div", "row");
    const samples = [
      "List my projects with their status and spend, and do not create any tasks.",
      "Why did the last failed tasks fail? Report only, do not create or dispatch tasks.",
      "Create docs/status.md with a one-line status of each project.",
    ];
    for (const s of samples) {
      const b = h("button", "btn btn-sm btn-wrap");
      b.type = "button";
      b.textContent = s;
      b.addEventListener("click", () => {
        input.value = s;
        updateComposer();
        input.focus();
      });
      row.appendChild(b);
    }
    c.appendChild(row);
    return c;
  }

  /* ── SPEAK: speaking sessions, companion paint, live transcript ────────────────
   * Read-only with respect to the chat: nothing here writes thread/optimistic/statuses.
   * It reads the same messages() list the conversation renders and paints the two cards. */

  /** How long Joey spends saying this text (an estimate - see the module comment). */
  function estimateSpeechMs(text) {
    // The server drops fenced and inline code before speaking (src/company/assistant.ts,
    // TTS_MAX_CHARS = 1200), so the estimate uses the same text and the same cap.
    const spoken = str(text)
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`[^`\n]*`/g, " ")
      .slice(0, SPEAK_SPEAK_MAX_CHARS);
    const chars = spoken.replace(/\s+/g, " ").trim().length;
    const ms = Math.round((chars / SPEAK_CHARS_PER_SEC) * 1000);
    return Math.max(SPEAK_MIN_MS, Math.min(SPEAK_MAX_MS, ms));
  }

  /** 0..1 through the current session; 1 when nothing is being said. */
  function speechProgress() {
    if (!speech || !(speech.durationMs > 0)) return 1;
    const elapsed = performance.now() - speech.startedAt;
    return Math.max(0, Math.min(1, elapsed / speech.durationMs));
  }

  function startSpeech(text, source) {
    const clean = str(text).trim();
    if (!clean || stopped) return;
    // The machine only speaks while the "Joey voice" toggle is on. Off means silence, and
    // silence must not animate anything.
    if (!readJoeyVoice()) return;
    speech = {
      key: keyOf({ role: "assistant", text: clean }),
      text: clean,
      startedAt: performance.now(),
      durationMs: estimateSpeechMs(clean),
      source: source || "estimate",
    };
    paintCompanion();
    paintSpeechProgress();
    renderTranscript();
    startSpeechTick();
  }

  function stopSpeech() {
    if (speechTimer) {
      clearInterval(speechTimer);
      speechTimer = 0;
    }
    if (!speech) return;
    speech = null;
    liveText = null;
    liveCaret = null;
    liveFull = "";
    if (stopped) return;
    paintCompanion();
    paintSpeechProgress();
    renderTranscript();
  }

  function startSpeechTick() {
    if (speechTimer) return; // one ticker, and it exists only while speaking
    speechTimer = setInterval(speechTick, SPEAK_TICK_MS);
  }

  function speechTick() {
    if (stopped) {
      stopSpeech();
      return;
    }
    if (!speech) {
      if (speechTimer) {
        clearInterval(speechTimer);
        speechTimer = 0;
      }
      return;
    }
    if (speech.source === "audio") {
      // A real playback element decides when the voice stops (its own ended/error event
      // fires stopSpeech too; this catches an element that went away or was paused).
      if (!audioEl || audioEl.paused) {
        stopSpeech();
        return;
      }
    } else if (speech.source === "router") {
      // COMPANION-TRUTH: once the probe has actually SEEN this reply play, the machine's own
      // playback decides when the session ends. Until then the estimate is a FLOOR, not a
      // ceiling: the router posts the text to the speech server before that server plays it,
      // so "not playing yet" is normal for the first seconds and must not freeze the dog
      // mid-reply. (Measured against a healthy probe that answers speaking:false: the removed
      // ROUTER_START_GRACE_MS ended a 214-char reply at 2,998 ms against a 15,286 ms estimate,
      // i.e. the dog stopped wagging while Joey was still audibly talking.)
      if (speechProbe.speaking) {
        speech.ttsSeenAt = performance.now();
      } else if (speech.ttsSeenAt) {
        if (performance.now() - speech.ttsSeenAt > ROUTER_SILENT_GRACE_MS) {
          // Heard, then stopped: Joey is silent now, so the dog freezes.
          stopSpeech();
          return;
        }
      } else if (speechProgress() >= 1) {
        // Never heard a thing and the estimate is spent: this reply was not spoken aloud.
        stopSpeech();
        return;
      }
    } else if (speechProgress() >= 1) {
      stopSpeech();
      return;
    }
    paintSpeechProgress();
    revealLive();
  }

  function paintSpeechProgress() {
    progFill.style.width = (speech ? Math.round(speechProgress() * 100) : 0) + "%";
  }

  /** Reveal the words of the line being said, in place (no rebuild: keeps scroll/selection). */
  function revealLive() {
    if (!speech || !liveText || !liveFull) return;
    const n = Math.min(liveFull.length, Math.max(2, Math.round(speechProgress() * liveFull.length)));
    const head = liveFull.slice(0, n);
    if (liveText.nodeValue !== head) liveText.nodeValue = head;
    if (liveCaret) liveCaret.style.display = n >= liveFull.length ? "none" : "";
  }

  /**
   * The companion's state, and the only place that toggles .joey-speaking: every animation
   * in SPEAK_CSS is gated on that class, so removing it (silence) freezes the dog completely.
   */
  function paintCompanion() {
    const on = !!speech;
    companionCard.classList.toggle("joey-speaking", on);
    companionCard.classList.toggle("joey-idle", !on);
    // VOICE-OFF CLARITY: with the "Joey voice" toggle off the machine really is silent, so
    // "Silent" is honest - but a viewer has to be able to tell "muted on purpose" from "this
    // should be moving and is not", which is the exact question this card exists to answer.
    // So the pill says why, and the line says what the replies still do.
    const muted = !readJoeyVoice();
    compState.className = on ? "pill pill-run" : "pill";
    compState.textContent = on ? "Speaking\u2026" : muted ? "Silent \u00b7 voice off" : "Silent";
    sayEl.textContent = on
      ? clip(speech.text, 160)
      : muted
        ? "Joey voice is off, so nothing is said out loud and the companion stays still. Replies still arrive in the chat and in the transcript below."
        : "Nothing is being said. Every reply and report-back appears in the transcript below as it is said.";
  }

  /**
   * One assistant utterance = one speech session. Called where an utterance is born: the
   * POST reply (typed or spoken order) and a new entry in the polled thread (a Done:/Failed:
   * report-back is spoken by reportBack() too). spokenKeys makes the two paths idempotent,
   * so the same reply is never animated twice.
   */
  function noteAssistantUtterance(text) {
    const clean = str(text).trim();
    if (!clean) return;
    const key = keyOf({ role: "assistant", text: clean });
    if (spokenKeys.has(key)) return;
    spokenKeys.add(key);
    lastUtteranceText = clean;
    startSpeech(clean, speechProbe.route ? "router" : "estimate");
  }

  /** A real <audio> element is playing: prefer it over the estimate (see hookVoiceSpeaking). */
  function speechFollowAudio() {
    if (stopped || !audioEl) return;
    if (!speech && lastUtteranceText) startSpeech(lastUtteranceText, "audio");
    if (!speech) return;
    speech.source = "audio"; // the element's ended/error now decides when this stops
    startSpeechTick();
    paintCompanion();
  }

  function transcriptPinned() {
    return transcriptScroll.scrollHeight - transcriptScroll.scrollTop - transcriptScroll.clientHeight < 24;
  }

  /**
   * The panel below the chat: every assistant utterance, oldest first, newest last, with the
   * one being said right now revealed at the speaking rate. Built from messages() - the same
   * list the conversation above renders - so the two can never disagree, and a poll or a POST
   * reply shows up in both places or in neither.
   */
  function renderTranscript() {
    const keepTop = transcriptScroll.scrollTop;
    const pinned = transcriptPinned(); // read before the rebuild
    const list = messages().filter((m) => m.role === "assistant");
    const lines = list.slice(0, TRANSCRIPT_MAX_LINES).reverse(); // messages() is newest-first
    transcriptBox.innerHTML = "";
    liveText = null;
    liveCaret = null;
    liveFull = "";
    if (!lines.length) {
      const empty = h("div", "muted");
      empty.textContent = loaded
        ? "Nothing yet. When Joey answers, each reply and report-back lands here as it is said."
        : "Loading the conversation\u2026";
      transcriptBox.appendChild(empty);
    }
    for (const m of lines) transcriptBox.appendChild(transcriptLine(m));
    trCount.textContent = String(list.length);
    trCount.title = list.length + " assistant utterance" + (list.length === 1 ? "" : "s") + " in the thread window";
    // Follow the newest line while the reader is already at the bottom; never yank the panel
    // back down while the CEO is reading something older up top.
    transcriptScroll.scrollTop = pinned ? transcriptScroll.scrollHeight : keepTop;
  }

  function transcriptLine(m) {
    const key = keyOf(m);
    const saying = !!speech && speech.key === key;
    const row = h("div", "joey-line" + (saying ? " joey-line-now" : ""));
    const head = h("div", "joey-line-head");
    const who = h("span", "joey-who");
    who.textContent = "Joey (assistant)";
    const when = h("span", "muted joey-when");
    when.textContent = hm(m.ts);
    head.appendChild(who);
    head.appendChild(when);
    const rep = reportOf(m.text);
    if (rep) {
      const tag = h("span", rep.ok ? "pill pill-ok" : "pill pill-err");
      tag.textContent = rep.ok ? "done" : "failed";
      head.appendChild(tag);
    }
    if (saying) {
      const liveTag = h("span", "pill pill-run");
      liveTag.textContent = "speaking\u2026";
      head.appendChild(liveTag);
    }
    const body = h("div", "joey-line-body");
    const full = str(m.text);
    if (saying) {
      const start = Math.max(2, Math.round(speechProgress() * full.length));
      const textNode = document.createTextNode(full.slice(0, start));
      const caret = h("span", "joey-caret");
      caret.textContent = "\u258d";
      body.appendChild(textNode);
      body.appendChild(caret);
      liveText = textNode;
      liveCaret = caret;
      liveFull = full;
      revealLive();
    } else {
      body.textContent = full; // text, never HTML
    }
    row.appendChild(head);
    row.appendChild(body);
    return row;
  }

  function render() {
    renderNeedsPanel();
    renderLive();
    renderThread();
    renderCompanionSafe();
    renderTranscript();
    updateComposer();
  }

  /** The companion and its transcript must never be able to break the chat render. */
  function renderCompanionSafe() {
    try {
      paintCompanion();
      paintSpeechProgress();
    } catch (e) {
      console.warn("[speak] companion paint failed:", e && e.message ? e.message : e);
    }
  }

  // JOEY-WIRE: when the voice toggle changes, persist it and tell the server.
  async function pushJoeyVoice(enabled) {
    writeJoeyVoice(enabled);
    try {
      await api("/company/assistant/voice", { method: "POST", body: { enabled } });
    } catch (e) {
      // best effort: localStorage is the source of truth for this browser
      console.warn("[joey.voice] could not sync voice toggle:", e && e.message ? e.message : e);
    }
  }
  voiceInput.addEventListener("change", () => {
    pushJoeyVoice(voiceInput.checked);
    // SPEAK: turning the voice off silences the machine mid-sentence, so the companion must
    // agree with reality at once instead of finishing an animation for audio never played.
    if (!voiceInput.checked) stopSpeech();
    // VOICE-OFF CLARITY: the muted state is part of the at-a-glance reading, so the pill and
    // the line must change the moment the toggle moves, not on the next 5 s poll (and not only
    // when a session happened to be running: stopSpeech() above returns early when it is not).
    paintCompanion();
  });
  // Sync once on load so the server matches this browser's preference.
  pushJoeyVoice(readJoeyVoice()).catch(() => {});

  /* ── data ── */
  async function refreshThread() {
    try {
      const d = await api("/company/assistant/thread?limit=" + THREAD_LIMIT);
      if (stopped) return;
      thread = asArray(d && d.messages)
        .filter((m) => m && (m.text !== undefined || m.role))
        // ATTACH: this projection must name `attachments` too - it rebuilds each entry field
        // by field, so anything not listed here is silently dropped (the server-side
        // assistantThread() had the same trap). Without it the file names only ever showed
        // up from the local optimistic entry and vanished on the next page load.
        // VOICE-IN: same lesson for `spoken` - a voice order must still show its
        // 🎤 spoken tag after a reload.
        .map((m) => ({
          ts: m.ts,
          role: m.role,
          text: m.text,
          tasks: m.tasks,
          attachments: m.attachments,
          spoken: m.spoken === true ? true : undefined,
        }));
      assistantStatus = str(d && d.status) || "";
      loaded = true;
      loadErr = null;
      stale = false;
      for (const m of thread) {
        const rep = reportOf(m.text);
        if (rep) titles.set(rep.taskId, rep.title || titles.get(rep.taskId) || rep.taskId);
      }
      /* SPEAK: assistant entries that arrived since the last poll are new utterances - a
       * Done:/Failed: report-back is spoken by reportBack() too, so the companion reacts to
       * it as well. The FIRST successful load only marks what is already in the thread: a
       * page opened on a long conversation must not animate for old replies. */
      if (!speakPrimed) {
        speakPrimed = true;
        for (const m of thread) {
          if (m.role === "assistant") spokenKeys.add(keyOf({ role: "assistant", text: m.text }));
        }
      } else {
        for (const m of thread) {
          if (m.role !== "assistant") continue;
          const born = Date.parse(str(m.ts));
          if (Number.isFinite(born) && born < speakFreshSince) continue; // said before this page opened
          noteAssistantUtterance(m.text);
        }
      }
    } catch (e) {
      if (stopped) return;
      if (thread.length) stale = true;
      else loadErr = e;
    }
  }

  async function refreshFlow() {
    try {
      const d = await api("/company/flow?limit=" + FLOW_LIMIT);
      if (stopped) return;
      ingestFlow(d && d.tasks);
      flowErr = null;
    } catch (e) {
      if (stopped) return;
      flowErr = e;
    }
  }

  async function refreshNeeds() {
    if (!api) return;
    try {
      const d = await api("/api/needs-you");
      needsYou = asArray(d && d.needsYou);
      needsErr = null;
    } catch (e) {
      try {
        const d = await api("/company/briefing", { fresh: true });
        needsYou = asArray(d && d.needsYou);
        needsErr = null;
      } catch (e2) {
        if (!stopped) needsErr = e2;
      }
    }
  }

  function renderNeedsPanel() {
    needsPanel.innerHTML = "";
    if (!needsYou.length && !needsErr) {
      needsPanel.style.display = "none";
      return;
    }
    needsPanel.style.display = "";

    const head = h("div", "row");
    head.style.alignItems = "center";
    head.style.gap = "8px";
    head.style.flexWrap = "wrap";
    const title = h("strong");
    title.textContent = "Needs you";
    head.appendChild(title);
    const count = h("span", "pill pill-warn");
    count.textContent = String(needsYou.length);
    head.appendChild(count);
    const hint = h("span", "muted");
    hint.style.fontSize = "12px";
    hint.textContent = "Decisions waiting on you";
    head.appendChild(hint);
    needsPanel.appendChild(head);

    const list = h("div", "col");
    list.style.gap = "8px";
    list.style.marginTop = "8px";
    for (const it of needsYou) list.appendChild(needsYouItemNode(it));
    needsPanel.appendChild(list);

    if (needsResult) {
      const line = h("div", "small");
      line.style.marginTop = "8px";
      line.style.color = "var(--" + (needsResult.tone || "dim") + ")";
      line.textContent = needsResult.text;
      needsPanel.appendChild(line);
    }
    if (needsErr) {
      const err = h("div", "small");
      err.style.marginTop = "8px";
      err.style.color = "var(--err)";
      err.textContent = str(needsErr && needsErr.message ? needsErr.message : needsErr) +
        (needsErr && needsErr.status ? " (HTTP " + needsErr.status + ")" : "");
      needsPanel.appendChild(err);
    }
  }

  function needsYouItemNode(item) {
    const id = item && item.id ? String(item.id) : "";
    const kind = str(item.kind);
    const busy = needsBusy.has(id);
    const wrap = h("div");
    wrap.style.display = "flex";
    wrap.style.flexDirection = "column";
    wrap.style.gap = "4px";

    const text = h("div");
    text.textContent = str(item.text) || "(no text)";
    wrap.appendChild(text);

    if (item.question && (kind === "choice" || kind === "external")) {
      const q = h("div", "small muted");
      q.textContent = item.question;
      wrap.appendChild(q);
    }

    if (item.input && kind === "provide") {
      const row = h("div", "row");
      row.style.alignItems = "center";
      row.style.gap = "8px";
      row.style.flexWrap = "wrap";
      const label = h("label", "tiny muted");
      label.textContent = item.input.label;
      label.htmlFor = "ny-in-" + id;
      const inp = h("input", "in in-sm");
      inp.type = "password";
      inp.autocomplete = "off";
      inp.id = "ny-in-" + id;
      inp.disabled = busy;
      inp.style.maxWidth = "260px";
      if (item.input.placeholder) inp.placeholder = str(item.input.placeholder);
      inp.dataset.inputId = id;
      inp.dataset.inputName = item.input.name || "value";
      row.appendChild(label);
      row.appendChild(inp);
      wrap.appendChild(row);
    }

    const actions = Array.isArray(item.actions) ? item.actions : [];
    if (actions.length) {
      const row = h("div", "row");
      row.style.gap = "8px";
      row.style.flexWrap = "wrap";
      for (const a of actions) {
        if (!a || !a.id) continue;
        const isLink = a.effect === "open_link" && a.url;
        let btn;
        if (isLink) {
          btn = h("a", "btn btn-sm");
          btn.href = a.url;
          btn.target = "_blank";
          btn.rel = "noopener";
          btn.textContent = a.label || "Action";
          if (busy) {
            btn.style.opacity = "0.5";
            btn.style.pointerEvents = "none";
          }
          btn.dataset.act = "needs-link";
        } else {
          btn = h("button", "btn btn-sm");
          btn.type = "button";
          btn.textContent = a.label || "Action";
          btn.disabled = busy;
          btn.dataset.act = "needs-action";
        }
        btn.dataset.item = id;
        btn.dataset.action = a.id;
        btn.dataset.url = a.url || "";
        btn.addEventListener("click", onNeedsActionClick);
        row.appendChild(btn);
      }
      wrap.appendChild(row);
    }
    return wrap;
  }

  function onNeedsActionClick(e) {
    const node = e.currentTarget;
    const act = node.dataset.act;
    const itemId = node.dataset.item;
    const actionId = node.dataset.action;
    if (!itemId || !actionId || needsBusy.has(itemId)) return;
    const linkUrl = act === "needs-link" ? node.getAttribute("href") : "";
    const input = {};
    const inp = itemId ? needsPanel.querySelector('input[data-input-id="' + itemId + '"]') : null;
    if (inp) {
      const name = inp.dataset.inputName || "value";
      input[name] = inp.value;
      inp.value = "";
    }
    e.preventDefault();
    void resolveNeedsYou(itemId, actionId, input, linkUrl);
  }

  async function resolveNeedsYou(itemId, actionId, input, linkUrl) {
    if (!api) return;
    if (needsBusy.has(itemId)) return;
    needsBusy.add(itemId);
    needsResult = null;
    renderNeedsPanel();
    if (linkUrl) {
      const win = window.open(linkUrl, "_blank");
      if (win) win.opener = null;
    }
    const body = { actionId: actionId };
    if (input && Object.keys(input).length) body.input = input;
    try {
      const d = await api("/company/needs-you/" + encodeURIComponent(itemId) + "/resolve", { method: "POST", body });
      const ok = !!(d && d.ok);
      needsResult = {
        text: (d && d.message) ? d.message : (ok ? "Done." : "Failed."),
        tone: ok ? "ok" : "err",
      };
      if (ok && d && Array.isArray(d.needsYou)) {
        needsYou = d.needsYou;
      } else {
        await refreshNeeds();
      }
    } catch (e) {
      needsResult = {
        text: str(e && e.message ? e.message : e) + (e && e.status ? " (HTTP " + e.status + ")" : ""),
        tone: "err",
      };
    } finally {
      needsBusy.delete(itemId);
      renderNeedsPanel();
      if (needsResult) {
        const saved = needsResult;
        setTimeout(() => {
          if (stopped || needsResult !== saved) return;
          needsResult = null;
          renderNeedsPanel();
        }, 6000);
      }
    }
  }

  async function refresh() {
    await refreshNeeds();
    await refreshThread();
    await refreshFlow();
    if (!stopped) render();
  }

  /* ── sending ── */
  async function send(text) {
    const body = str(text === undefined ? input.value : text).trim();
    if (!body || sending) return;
    sending = true;
    sendErr = null;
    lastSent = body;
    input.value = "";
    const at = new Date().toISOString();
    const mine = { ts: at, role: "ceo", text: body, tasks: [], attachments: attachments.map((a) => str(a.name)), pending: true };
    optimistic.push(mine);
    render();

    // ATTACH: the ids the server returned for the attached files. Kept if the send
    // fails, so Retry still carries the same files.
    const ids = attachments.filter((a) => a.id).map((a) => str(a.id));
    const payload = { text: body, autoRun: autoRun, voice: readJoeyVoice() };
    if (ids.length) payload.attachments = ids;

    try {
      const r = await api("/company/assistant/message", { method: "POST", body: payload });
      if (stopped) return;
      const dispatched = asArray(r && r.dispatched);
      mergeTitles(dispatched);
      const reply = str(r && r.reply).trim() || "(Joey returned an empty reply)";
      const entry = {
        ts: new Date().toISOString(),
        role: "assistant",
        text: reply,
        tasks: dispatched.map((d) => str(d && d.taskId)).filter(Boolean),
        pending: true,
      };
      optimistic.push(entry);
      notes.set(keyOf(entry), { decisions: asArray(r && r.decisions), plan: asArray(r && r.plan) });
      // SPEAK: this reply is what Joey is about to say out loud - the router hands the text
      // to the speech server as soon as it has it. An empty reply means the server says
      // nothing, so no session starts and the companion stays still.
      noteAssistantUtterance(str(r && r.reply));
      // The POST response itself confirms the CEO side, even before the thread
      // file is re-read; the reply stays "pending" until the thread carries it.
      mine.pending = false;
      // The order (and its files) were accepted: the chips have done their job.
      if (attachments.length) {
        attachments = [];
        attachWarn = "";
        paintAttachments();
        updateComposer();
      }
      render();
      // The poll already refreshes both feeds every POLL_MS; clearing the
      // "pending" marks here (not now) keeps the POST response as the single
      // freshness guarantee for this order.
      await refresh();
    } catch (e) {
      if (stopped) return;
      optimistic = optimistic.filter((o) => o !== mine);
      sendErr = str(e && e.message ? e.message : e) + (e && e.status ? " (HTTP " + e.status + ")" : "") + " \u2014 your order was not sent.";
      if (!input.value.trim()) input.value = body;
    } finally {
      sending = false;
      if (!stopped) {
        render();
        input.focus();
      }
    }
  }

  /* ── voice: hold-to-talk (VOICE-IN) ────────────────────────────────────────
   * MediaRecorder (audio/webm;codecs=opus when supported), started on pointerdown
   * (or on Space while the empty text box holds focus) and posted raw to
   * /company/assistant/voice?autoRun=<same autoRun value as the typed send> on
   * pointerup/pointerleave/pointercancel/keyup. api() JSON-encodes bodies
   * (public/v2/api.js fetchJson always sets content-type application/json), so
   * this is a plain fetch with companyToken() from ../api.js, exactly like
   * uploadOne() above. The reply lands through the same thread/refresh/render
   * path the typed send uses, so it looks identical on the page.
   *
   * Blob capture note: Chrome/Edge give the first dataavailable chunk late
   * (only after the first real audio frame), so the instant stop of a very short
   * hold produces no chunk and an empty/zero-byte blob. blob.size === 0 is
   * therefore reported exactly like a sub-minimum hold: "Didn't catch that".
   */
  function paintVoice() {
    const down = sttDown();
    const states = {
      idle: ["", ""],
      listening: ["pill pill-run", "Listening\u2026"],
      thinking: ["pill pill-run", "Thinking\u2026"],
      speaking: ["pill pill-run", "Speaking\u2026"],
      error: ["pill pill-err", voiceErr || "Microphone error"],
    };
    const [cls, label] = states[voiceState] || states.idle;
    voiceStatePill.className = cls || "pill";
    voiceStatePill.textContent = label || "";
    voiceStatePill.style.display = voiceState === "idle" && !voiceErr ? "none" : "";
    voiceBtn.textContent =
      down ? "🎤 Voice unavailable" : voiceState === "listening" ? "🎤 Listening\u2026" : "🎤 Hold to talk";
    voiceBtn.title = down
      ? STT_DOWN_MESSAGE + " " + sttDetail
      : "Hold the mouse button down (or hold Space with the text box empty), talk, and release to send";
    voiceBtn.setAttribute("aria-pressed", voiceState === "listening" ? "true" : "false");
    // STT-HEALTH: a down STT service is a disabled control PLUS the sentence that
    // says what to do instead - never a control that looks ready and then fails.
    voiceBtn.disabled = stopped === true || down;
    const note = voiceErr || (down ? STT_DOWN_MESSAGE : "");
    voiceNote.style.display = note ? "" : "none";
    if (note) voiceNote.textContent = note;
    paintVoiceTime();
  }

  function paintVoiceTime() {
    if (voiceReplyMs === null) {
      voiceTime.style.display = "none";
      voiceTime.textContent = "";
    } else {
      voiceTime.style.display = "";
      voiceTime.textContent = "reply in " + (voiceReplyMs / 1000).toFixed(1) + " s";
    }
  }

  /** Text-box Space hold is only valid while the box is focused and empty. */
  function spaceHoldAllowed() {
    return typeof document !== "undefined" && document.activeElement === input && input.value.length === 0;
  }

  /** Common release-time bookkeeping for both the pointer and the Space hold. */
  function voiceReleasedAt() {
    return performance.now();
  }

  async function voiceBegin(force) {
    // Refuse guard (any press while a hold is already active, or while thinking):
    // purely a client-side guard, never a change to the text box.
    if (voiceState === "listening" || (!force && stopped)) return false;
    // STT-HEALTH: never start a recording that cannot be transcribed. The button is
    // disabled already, so this only catches the Space-hold race and a probe that
    // landed between the press and here.
    if (sttDown()) {
      voiceState = "error";
      voiceErr = STT_DOWN_MESSAGE;
      paintVoice();
      return false;
    }
    if (typeof navigator === "undefined" || !navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
      voiceState = "error";
      voiceErr = "Microphone blocked, allow it in the browser";
      paintVoice();
      return false;
    }
    if (typeof MediaRecorder === "undefined") {
      voiceState = "error";
      voiceErr = "Microphone blocked, allow it in the browser";
      paintVoice();
      return false;
    }
    voiceErr = null;
    voiceState = "listening";
    paintVoice();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (voiceState !== "listening" || stopped) {
        for (const t of stream.getTracks()) t.stop();
        return false;
      }
      const opts = typeof MediaRecorder.isTypeSupported === "function" && MediaRecorder.isTypeSupported(VOICE_MIME) ? { mimeType: VOICE_MIME } : undefined;
      voiceRecorder = new MediaRecorder(stream, opts);
      voiceChunks = [];
      voiceRecorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) voiceChunks.push(ev.data);
      };
      voiceStream = stream;
      await new Promise((resolve) => {
        voiceRecorder.onstart = () => resolve();
        voiceRecorder.onerror = () => resolve();
        voiceRecorder.start();
        setTimeout(resolve, 250);
      });
      return true;
    } catch (e) {
      voiceState = "error";
      const name = str(e && e.name);
      if (name === "NotAllowedError" || name === "SecurityError") voiceErr = "Microphone blocked, allow it in the browser";
      else if (name === "NotFoundError" || name === "OverconstrainedError" || name === "NotReadableError") voiceErr = "No microphone found on this machine";
      else voiceErr = str(e && e.message ? e.message : e) || "Microphone error";
      paintVoice();
      return false;
    }
  }

  async function voiceEnd(send) {
    const rec = voiceRecorder;
    const heldFor = performance.now() - (voiceRecordStart || performance.now());
    voiceRecordStart = 0;
    voiceRecorder = null;
    voiceState = "idle";
    paintVoice();
    let blob = null;
    if (rec && rec.state !== "inactive") {
      await new Promise((resolve) => {
        const done = () => {
          try {
            blob = new Blob(voiceChunks, { type: rec.mimeType || "audio/webm" });
          } catch {
            blob = null;
          }
          resolve();
        };
        rec.onstop = done;
        try {
          rec.stop();
          setTimeout(done, 400);
        } catch {
          done();
        }
      });
    }
    if (voiceStream) {
      for (const t of voiceStream.getTracks()) {
        try {
          t.stop();
        } catch {
          /* already gone */
        }
      }
      voiceStream = null;
    }
    if (!send || !blob || blob.size === 0 || heldFor < VOICE_MIN_HOLD_MS) {
      if (send && (blob === null || blob.size === 0 || heldFor < VOICE_MIN_HOLD_MS)) {
        voiceState = "error";
        voiceErr = "Didn't catch that";
        paintVoice();
      }
      return;
    }
    await voiceSend(blob);
  }

  /* ── voice send (VOICE-IN): raw blob POST, then the same reply path as the typed send ─────────────────—— */
  async function voiceSend(blob) {
    if (stopped) return;
    // measure from release to the reply being rendered (work order item 6)
    const t0 = performance.now();
    voiceState = "thinking";
    paintVoice();
    let result = null;
    try {
      const token = await companyToken();
      const headers = { "content-type": blob.type || "application/octet-stream" };
      if (token) headers["x-company-token"] = token;
      const res = await fetch("/company/assistant/voice?autoRun=" + (autoRun ? "true" : "false"), {
        method: "POST",
        headers: headers,
        body: blob,
        signal: voiceAbort,
      });
      if (stopped) return;
      const data = await res.json().catch(() => null);
      result = data;
      // Dead-route clue for a router not yet restarted onto the voice build:
      // keep the offence in the console (traceability), tell the CEO in words.
      if (res.status === 404) console.warn("[voice] router has no POST /company/assistant/voice yet (restart needed)");
      if (!res.ok) {
        const errName = str(result && result.error);
        let msg = str(result && (result.message || result.detail || result.error)) || "HTTP " + res.status;
        if (errName === "stt_unavailable") {
          msg = str(result && result.message) || "Speech-to-text server (127.0.0.1:8902) is not reachable. Start it: schtasks /run /tn LayaCompanySttServer";
        } else if (errName === "didnt_catch") {
          msg = "Didn't catch that";
        } else if (errName === "company_paused") {
          msg = str(result && result.message) || "The company is paused right now, so the order was not sent";
        }
        throw mkVoiceError(msg, res.status, errName);
      }
      if (result && result.ok === false) {
        throw mkVoiceError(str(result.message || result.error) || "Not understood", res.status, str(result.error));
      }
      const transcript = str(result && result.transcript);
      const dispatched = asArray(result && result.dispatched);
      mergeTitles(dispatched);
      const replyText = str(result && result.reply).trim() || "(Joey returned an empty reply)";
      const ceoEntry = {
        ts: new Date().toISOString(),
        role: "ceo",
        text: transcript || "(spoken order, no transcript came back)",
        tasks: asArray(result && result.tasks).map(str).filter(Boolean),
        spoken: true,
        pending: true,
      };
      const replyEntry = {
        ts: new Date().toISOString(),
        role: "assistant",
        text: replyText,
        tasks: dispatched.map((d) => str(d && d.taskId)).filter(Boolean),
        pending: true,
      };
      optimistic.push(ceoEntry);
      optimistic.push(replyEntry);
      notes.set(keyOf(replyEntry), { decisions: asArray(result && result.decisions), plan: asArray(result && result.plan) });
      // SPEAK: the spoken reply is an utterance like any other (same idempotent path).
      noteAssistantUtterance(str(result && result.reply));
      // The POST response itself confirms both sides, and the poll clears the
      // pending marks when the thread carries them (same contract as send()).
      render();
      await refresh();
      if (stopped) return;
      const took = performance.now() - t0;
      voiceReplyMs = took;
      console.log("[voice] release-to-render " + Math.round(took) + " ms (autoRun=" + (autoRun ? "true" : "false") + ")");
      voiceState = "speaking";
      paintVoice();
      turnVoiceTimer = setTimeout(() => {
        turnVoiceTimer = 0;
        if (voiceState !== "speaking" || stopped) return;
        voiceState = "idle";
        voiceErr = null;
        paintVoice();
      }, VOICE_SPEAK_TIMEOUT);
    } catch (e) {
      if (stopped) return;
      if (e && e.name === "AbortError") {
        voiceState = "idle";
        voiceErr = null;
        paintVoice();
        return;
      }
      voiceState = "error";
      voiceErr = str(e && e.message ? e.message : e) || "The spoken order did not go through";
      if (e && e.status) voiceErr += " (HTTP " + e.status + ")";
      paintVoice();
      // STT-HEALTH: the attempt just proved the service is unreachable (it may have
      // died between two probes). Re-check now so the mic is taken away within the
      // same second instead of waiting for the next 15 s tick.
      if (e && e.voiceError === "stt_unavailable") void refreshSttHealth();
    }
  }

  /* ── voice support helpers (VOICE-IN) ── */
  function mkVoiceError(msg, status, name) {
    const e = new Error(msg);
    if (status) e.status = status;
    if (name) e.voiceError = name;
    return e;
  }

  /**
   * Try to hook the sibling TTS work order's playback, if it landed in this file.
   * Returns true when a hook now owns the "speaking" state (the audio element's
   * play/ended events clear it through voiceClearSpeaking + the idle state),
   * false when no TTS playback exists in this view (the brief
   * VOICE_SPEAK_TIMEOUT flash applies instead, and the report says so).
   * turnVoiceTimer aborts that fallback flash if a hook takes over.
   */
  function hookVoiceSpeaking() {
    const audio = root.querySelector("audio"); // sibling TTS playback element, if any
    if (!audio || typeof audio.addEventListener !== "function") return false;
    const clear = () => {
      voiceClearSpeaking();
      stopSpeech(); // SPEAK: the voice went quiet, so the companion freezes with it
      if (turnVoiceTimer) clearTimeout(turnVoiceTimer);
      turnVoiceTimer = 0;
      voiceState = "idle";
      voiceErr = null;
      paintVoice();
    };
    // SPEAK: real playback outranks the text-length estimate - the element's own events now
    // decide when the speech session ends.
    const clearOnPlay = () => {
      clear();
      speechFollowAudio();
    };
    const clearOnEnd = () => clear();
    const clearOnError = () => clear();
    voicePlayHooks.push(() => audio.removeEventListener("play", clearOnPlay));
    voicePlayHooks.push(() => audio.removeEventListener("ended", clearOnEnd));
    voicePlayHooks.push(() => audio.removeEventListener("error", clearOnError));
    audio.addEventListener("play", clearOnPlay);
    audio.addEventListener("ended", clearOnEnd);
    audio.addEventListener("error", clearOnError);
    if (!audio.paused) {
      clear();
      return true;
    }
    return true; // hooked: the audio element owns the state from here
  }

  /* ── wiring ── */
  function onSubmit() {
    void send();
  }
  sendBtn.addEventListener("click", onSubmit);
  input.addEventListener("input", updateComposer);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      onSubmit();
    }
  });
  runBtn.addEventListener("click", () => {
    autoRun = !autoRun;
    updateComposer();
  });

  /* ── voice wiring (VOICE-IN): pointer hold + Space-key hold ── */
  voiceBtn.addEventListener("pointerdown", async (ev) => {
    if (stopped || ev.button > 0) return;
    ev.preventDefault();
    try {
      voiceBtn.focus();
    } catch {
      /* focus is a nicety, not a correctness requirement */
    }
    if (!(await voiceBegin(false))) return;
    voiceRecordStart = performance.now();
  });
  voiceBtn.addEventListener("pointerup", () => {
    if (stopped) return;
    void voiceEnd(voiceState === "listening");
  });
  voiceBtn.addEventListener("pointerleave", () => {
    if (stopped) return;
    void voiceEnd(voiceState === "listening");
  });
  voiceBtn.addEventListener("pointercancel", () => {
    if (stopped) return;
    void voiceEnd(false); // never send a cancelled hold
  });

  /* Space-bar hold-to-talk, but ONLY while the text box is focused and empty:
   * with text in it, Space is a plain typing key and must never be swallowed. */
  input.addEventListener("keydown", (ev) => {
    if (ev.key !== " ") return;
    if (stopped || ev.repeat || ev.isComposing) return;
    if (sttDown()) return; // STT-HEALTH: the hold-to-talk path is off; Space types normally
    if (!spaceHoldAllowed()) return; // typed text present: Space types normally
    ev.preventDefault(); // no space is inserted while the hold lasts
    if (voiceState === "listening") return; // ignore auto-repeat while held
    void voiceBegin(false).then((ok) => {
      if (!ok) return;
      voiceRecordStart = performance.now();
    });
  });
  input.addEventListener("keyup", (ev) => {
    if (ev.key !== " ") return;
    if (stopped || voiceState !== "listening") return;
    ev.preventDefault(); // the space was never typed, so none to restore
    void voiceEnd(true);
  });
  // If focus jumps away mid-hold (Tab, or a click on the mic button), the text
  // box never sees keyup: a window-level fallback releases the hold for real.
  window.addEventListener("keyup", (ev) => {
    if (stopped || voiceState !== "listening") return;
    if (ev.key !== " ") return;
    void voiceEnd(true);
  });

  /* ── attachment wiring (ATTACH) ── */
  clipBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    addFiles(fileInput.files);
    fileInput.value = ""; // so choosing the same file twice still works
  });
  composer.addEventListener("dragover", (ev) => {
    if (ev.dataTransfer && Array.prototype.indexOf.call(ev.dataTransfer.types || [], "Files") >= 0) {
      ev.preventDefault();
      composer.style.borderColor = "var(--accent, #888)";
    }
  });
  composer.addEventListener("dragleave", () => {
    composer.style.borderColor = "";
  });
  composer.addEventListener("drop", (ev) => {
    ev.preventDefault();
    composer.style.borderColor = "";
    addFiles(ev.dataTransfer && ev.dataTransfer.files);
  });
  // A file dropped anywhere else would navigate the page away from the dashboard.
  const stopStrayDrop = (ev) => ev.preventDefault();
  document.addEventListener("dragover", stopStrayDrop);
  document.addEventListener("drop", stopStrayDrop);

  render(); // loading state immediately
  void refresh();
  // STT-HEALTH: paint the mic state from the real service, not from an assumption,
  // before the first poll tick (poll() runs fn once immediately as well).
  void refreshSttHealth();

  const stopPoll = ctx.poll(() => {
    if (stopped) return Promise.resolve();
    return refresh();
  }, POLL_MS);
  const stopSttPoll = ctx.poll(() => {
    if (stopped) return Promise.resolve();
    return refreshSttHealth();
  }, STT_HEALTH_MS);
  // COMPANION-TRUTH: one loopback read while the view is open, so the companion follows the
  // machine's real playback when the router has the route (see refreshSpeechProbe).
  const stopSpeechProbePoll = ctx.poll(() => {
    if (stopped) return Promise.resolve();
    return refreshSpeechProbe();
  }, SPEECH_PROBE_MS);

  return function cleanup() {
    stopped = true;
    stopPoll();
    stopSttPoll();
    stopSpeechProbePoll();
    document.removeEventListener("dragover", stopStrayDrop);
    document.removeEventListener("drop", stopStrayDrop);
    sendBtn.disabled = true;
    clipBtn.disabled = true;
    /* VOICE-IN: release any held microphone and any in-flight voice request. */
    try {
      if (voiceAbort) voiceAbort.abort();
    } catch {
      /* nothing in flight */
    }
    if (turnVoiceTimer) clearTimeout(turnVoiceTimer);
    // SPEAK: stop the speech ticker and take the view's stylesheet with the view.
    stopSpeech();
    try {
      speakStyle.remove();
    } catch {
      /* already gone */
    }
    // voiceEnd() itself stops the recorder and its stream tracks; a plain call
    // from cleanup also covers an unload mid-hold.
    void voiceEnd(false);
    voiceClearSpeaking();
    el.innerHTML = "";
  };
}
