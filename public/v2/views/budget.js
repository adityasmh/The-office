/* public/v2/views/budget.js — BUDGET (docs/BUDGET_SPEC.md §3).
 *
 * Route: #/budget
 *
 * Plain words, not pretty: for each provider it shows what is actually left
 * (OpenCode Go's real remaining allowance from the Go API, Claude's 5-hour /
 * 7-day windows), when it resets, the measured burn, when it runs out at this
 * pace, a 24 h sparkline, and what the system is doing about it right now.
 *
 * Data: GET /company/budget -> { checkedAt, status, snapshot }
 *   snapshot = src/company/budgetGuard.ts BudgetSnapshot:
 *     { checkedAt, pollS, thresholds, levels:{go,claude},
 *       providers:{ go:{label,connected,remainingPct,resetsAt,resetsIn,bindingWindow,
 *                       burnPerHour,burnPctPerHour,runsOutAt,runsOutIn,level,source,detail},
 *                   claude:{...} },
 *       binding, rules:{go,claude}, effects:[string], needsYou, spend:{...},
 *       samples:[{ts,go,claude}] }
 * POST /company/budget/refresh forces one live poll (token-guarded by api.js).
 *
 * Below that, PANEL's provider-usage card reads a second route:
 *   GET /company/provider-usage -> { capturedAt, providers, measuredByModel }
 *   providers = src/company/usage.ts ProviderUsage[]:
 *     { provider, source:"cli"|"measured"|"unavailable", plan?,
 *       windows?:[{ label, usedPct?, resetsIn?, note? }], measuredSpendUsd?,
 *       calls?, detail, capturedAt }
 *   measuredByModel = [{ model, calls, costUsd }]
 * For each provider it shows the plan and its quota windows (used / left /
 * reset). A provider that exposes nothing is shown as "unavailable, because
 * <detail>" - the module's own honest reason, never an invented percentage.
 * docs/PROVIDER_USAGE.md is the module's spec.
 *
 * Owner: BUDGET (the quota/budget cards) + PANEL (the provider-usage card).
 * Uses only style.css classes/vars; the sparkline is one inline SVG (no <style>
 * block, per UI-CLEAN's rule in style.css's header).
 */

// esc comes straight from the shell's helpers: the card builders below are
// module-level, so they cannot read ctx.esc.
import { esc } from "../api.js";

export const title = "Budget";
export const goal =
  "What is really left at each provider, when it resets, and what the company is doing about it.";

const POLL_MS = 30000;

const LEVEL_PILL = { green: "pill pill-ok", amber: "pill pill-warn", red: "pill pill-err" };
const LEVEL_CLASS = { green: "ok", amber: "warn", red: "err" };
const LEVEL_WORD = { green: "green", amber: "amber", red: "red", unknown: "not measured" };

function hhmm(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes());
}

function pct(v) {
  return typeof v === "number" && isFinite(v) ? v.toFixed(v < 10 ? 2 : 0) + "%" : "not measured";
}

function money(v) {
  return typeof v === "number" && isFinite(v) ? "$" + v.toFixed(4) : "not measured";
}

/* 24 h sparkline of "remaining %" for one provider: one inline SVG polyline. */
function sparkline(samples, key, level) {
  const pts = (samples || [])
    .map((s) => ({ t: Date.parse(s.ts), v: s[key] }))
    .filter((p) => isFinite(p.t) && typeof p.v === "number");
  if (pts.length < 2) {
    return `<div class="tiny muted">Not enough history yet for a 24 h picture (one point per poll, ${
      pts.length === 1 ? "1 so far" : "none yet"
    }).</div>`;
  }
  const w = 260;
  const h = 40;
  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  const span = Math.max(1, t1 - t0);
  const y = (v) => h - (Math.max(0, Math.min(100, v)) / 100) * (h - 4) - 2;
  const d = pts
    .map((p, i) => `${i === 0 ? "M" : "L"}${((p.t - t0) / span * w).toFixed(1)},${y(p.v).toFixed(1)}`)
    .join(" ");
  const stroke = level === "red" ? "var(--err)" : level === "amber" ? "var(--warn)" : "var(--ok)";
  const first = pts[0].v.toFixed(0);
  const last = pts[pts.length - 1].v.toFixed(0);
  return (
    `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" ` +
    `aria-label="remaining percentage over the last 24 hours: from ${first}% to ${last}%">` +
    `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"/>` +
    `<line x1="0" y1="${y(15)}" x2="${w}" y2="${y(15)}" stroke="var(--line)" stroke-width="1" stroke-dasharray="3 3"/>` +
    `</svg>` +
    `<div class="tiny muted">last 24 h: ${first}% → ${last}% (dashed line = the 15% red threshold)</div>`
  );
}

function providerCard(p, samples) {
  const level = p.level || "unknown";
  const pill = LEVEL_PILL[level] || "pill pill-dim";
  const sev = LEVEL_CLASS[level] || "";
  const barWidth = typeof p.remainingPct === "number" ? Math.max(0, Math.min(100, p.remainingPct)) : 0;

  const runsOut = p.runsOutAt
    ? `At this pace it runs out at <b>${hhmm(p.runsOutAt)}</b>${p.runsOutIn ? ` (in ${p.runsOutIn})` : ""}.`
    : p.connected && typeof p.burnPctPerHour === "number" && p.burnPctPerHour > 0
      ? `The window resets before it would run out${p.resetsIn ? ` (in ${p.resetsIn})` : ""}.`
      : p.connected
        ? "Not enough history yet to say when it runs out (one poll every " +
          `${p.pollS || "300"} s builds the slope).`
        : "Not connected, so nothing is counted.";

  const reset = p.resetsAt
    ? `${p.resetsIn ? p.resetsIn + " left" : "resets"} · ${new Date(p.resetsAt).toISOString().slice(0, 16).replace("T", " ")}Z`
    : "reset time not reported";

  return (
    `<div class="card card-pad">` +
    `<div class="row" style="justify-content:space-between">` +
      `<div class="row"><b>${esc(p.label)}</b><span class="${pill}">${esc(LEVEL_WORD[level] || level)}</span></div>` +
      `<span class="tiny muted">${esc(p.source)}${p.bindingWindow ? " · binding window: " + esc(p.bindingWindow) : ""}</span>` +
    `</div>` +
    `<div class="row" style="gap:var(--sp-3);align-items:baseline;margin-top:var(--sp-2)">` +
      `<span style="font-size:26px;font-weight:700">${esc(pct(p.remainingPct))}</span>` +
      `<span class="muted">left${typeof p.usedPct === "number" ? ` (${esc(pct(p.usedPct))} used)` : ""}</span>` +
    `</div>` +
    `<div class="bar" style="margin-top:6px"><div class="bar-fill ${sev ? "sev-" + sev : ""}" style="width:${barWidth}%"></div></div>` +
    `<div class="tiny muted" style="margin-top:4px">${esc(reset)}</div>` +
    `<div class="grid-2" style="margin-top:var(--sp-3)">` +
      `<div><div class="tiny muted">Measured burn (our own ledger, last 3 h)</div><div>${esc(money(p.burnPerHour))}/hour</div></div>` +
      `<div><div class="tiny muted">When it runs out</div><div>${runsOut}</div></div>` +
    `</div>` +
    `<div style="margin-top:var(--sp-3)">${sparkline(samples, p.id, level)}</div>` +
    `<div class="tiny mono muted wrap-any" style="margin-top:var(--sp-3)">${esc(p.detail)}</div>` +
    `<div class="tiny muted" style="margin-top:4px">checked ${esc(new Date(p.checkedAt).toLocaleTimeString())}</div>` +
    `</div>`
  );
}

function rulesCard(snapshot) {
  const r = snapshot.rules || {};
  const rows = [];
  if (r.go) rows.push(`<li><b>OpenCode Go (${esc(r.go.level)}):</b> ${esc(r.go.note)}${
    r.go.forbiddenModels && r.go.forbiddenModels.length
      ? ` Disabled models: <span class="mono">${esc(r.go.forbiddenModels.join(", "))}</span>.`
      : ""}${
    r.go.fleetMaxParallel ? ` Fleet runs at most ${esc(String(r.go.fleetMaxParallel))} workers at once.` : ""}</li>`);
  if (r.claude) rows.push(`<li><b>Claude (${esc(r.claude.level)}):</b> ${esc(r.claude.note)}${
    r.claude.assistantModel ? ` Assistant model: <span class="mono">${esc(r.claude.assistantModel)}</span>.` : ""}${
    r.claude.assistantGoModel ? ` Assistant runs on <span class="mono">${esc(r.claude.assistantGoModel)}</span>.` : ""}${
    r.claude.runManagerIntervalMinutes ? ` Run-manager checks every ${esc(String(r.claude.runManagerIntervalMinutes))} min.` : ""}${
    r.claude.briefingMinIntervalMinutes ? ` Briefing at most every ${esc(String(r.claude.briefingMinIntervalMinutes))} min.` : ""}</li>`);
  return (
    `<div class="card card-pad">` +
    `<div class="card-head"><h3>The rules in force right now</h3></div>` +
    `<ul style="margin:0;padding-left:18px">${rows.join("")}</ul>` +
    `<div class="tiny muted" style="margin-top:var(--sp-2)">Thresholds: green above ${esc(String(snapshot.thresholds?.greenMin ?? 40))}% left, ` +
    `amber ${esc(String(snapshot.thresholds?.amberMin ?? 15))}–${esc(String(snapshot.thresholds?.greenMin ?? 40))}%, ` +
    `red below ${esc(String(snapshot.thresholds?.amberMin ?? 15))}% (set BUDGET_GREEN_MIN / BUDGET_AMBER_MIN to tune). ` +
    `The CEO can suspend a rule for one run with BUDGET_OVERRIDE=1.</div>` +
    `</div>`
  );
}

function effectsCard(snapshot) {
  const items = (snapshot.effects || []).map((e) => `<li>${esc(e)}</li>`).join("");
  return (
    `<div class="card card-pad">` +
    `<div class="card-head"><h3>What the company is doing about it</h3></div>` +
    `<ul style="margin:0;padding-left:18px">${items || "<li>Nothing to report.</li>"}</ul>` +
    (snapshot.needsYou
      ? `<div class="pill pill-err" style="margin-top:var(--sp-2)">Needs you: ${esc(snapshot.needsYou.text)}</div>`
      : "") +
    `</div>`
  );
}

function brainCard(brain) {
  // BRAIN GATE (docs/CHEAP_BY_DEFAULT_SPEC.md, Job 1): which tier each Claude-capable
  // call got today, and how many Claude calls the gate avoided.
  if (!brain || !brain.calls) {
    return (
      `<div class="card card-pad"><div class="card-head"><h3>Brain routing</h3></div>` +
      `<div class="muted">No routed call yet today. Laya decides the tier per call: ` +
      `<b>none</b> (no Claude: deepseek-v4.1-flash) / <b>sonnet</b> / <b>opus</b>. ` +
      `Claude is only used when Laya says the work is big or the CEO names Claude; a call that reads files cannot ` +
      `use the cheap tier, so those are flagged.</div></div>`
    );
  }
  const t = brain.byTier || {};
  const purposes = Object.entries(brain.byPurpose || {})
    .sort((a, b) => String(b[1]).localeCompare(String(a[1])))
    .map(([p, n]) => `${p} ${n}`)
    .join(" · ");
  const reasons = Object.entries(brain.byReason || {})
    .map(([r, n]) => `${r} ${n}`)
    .join(" · ");
  return (
    `<div class="card card-pad">` +
    `<div class="card-head"><h3>Brain routing</h3></div>` +
    `<div class="row" style="gap:var(--sp-4)">` +
      `<span>no Claude: <b>${esc(String(t.none ?? 0))}</b></span>` +
      `<span>sonnet: <b>${esc(String(t.sonnet ?? 0))}</b></span>` +
      `<span>opus: <b>${esc(String(t.opus ?? 0))}</b></span>` +
      `<span class="pill pill-ok">Claude calls avoided: ${esc(String(brain.claudeAvoided ?? 0))}</span>` +
      `<span class="pill ${brain.opusAvoided ? "pill-ok" : "pill-dim"}">Opus calls avoided: ${esc(String(brain.opusAvoided ?? 0))}</span>` +
    `</div>` +
    `<div class="tiny muted" style="margin-top:4px">${esc(String(brain.calls))} routed calls today` +
      (brain.medianMs ? ` · median Laya decision ${esc(String(brain.medianMs))} ms` : "") +
      (reasons ? ` · why: ${esc(reasons)}` : "") +
    `.</div>` +
    (purposes ? `<div class="tiny muted" style="margin-top:2px">by purpose: ${esc(purposes)}</div>` : "") +
    (brain.layaDown ? `<div class="tiny" style="margin-top:2px;color:var(--warn)">Laya could not answer ${esc(String(brain.layaDown))} time(s): those calls took the cheap tier (cheap by default, never a silent Claude call).</div>` : "") +
    (brain.fileBlind ? `<div class="tiny" style="margin-top:2px;color:var(--warn)">${esc(String(brain.fileBlind))} cheap-tier call(s) read files, which that tier cannot: their answer had no file access (flagged, not hidden).</div>` : "") +
    `<div class="tiny muted" style="margin-top:4px">Laya picks the tier BEFORE Claude is called; the budget rules on this page are applied after it. ` +
    `An order that says "use Claude" always reaches Claude, and a small task that fails twice on the cheap model climbs once to Sonnet.</div>` +
    `</div>`
  );
}

function virtualCapsCard(real) {
  // CEO order 2026-10-01: there are no per-agent dollar caps any more. This card
  // now shows the REAL numbers only - provider limits, measured spend, and a
  // read-only "spent so far" per agent. `real` is the same JSON
  // GET /company/budget/real returns (src/company/budgetReal.ts), so the page
  // and the API cannot disagree. Anything unmeasured says so.
  if (!real || !real.providers) {
    return (
      `<div class="card card-pad"><div class="card-head"><h3>Real budget numbers</h3></div>` +
      `<div class="muted">Waiting for the real budget feed (the server reads the providers and caches them for 30-60 s). ` +
      `Nothing is shown rather than an invented cap.</div></div>`
    );
  }
  const amount = (v) => (typeof v === "number" && isFinite(v) ? "$" + v.toFixed(2) : "not measured");
  const prov = (p) => {
    let body;
    if (!p.connected) {
      body = `<div class="muted small wrap-any">not measured - ${esc(oneLine(p.notMeasured || p.detail))}</div>`;
    } else if (p.id === "deepseek-direct") {
      body = `<div><b>${esc(amount(p.balanceUsd))}</b> <span class="muted small">${esc(p.currency || "credit")} credit - ${esc(p.phaseLine || "")}` +
        ` - ${p.armed ? "direct routing armed" : "direct routing off"}</span></div>`;
    } else {
      const ws = Array.isArray(p.windows) ? p.windows : [];
      body =
        (ws.length
          ? ws
              .map(
                (w) =>
                  `<div class="row" style="justify-content:space-between;gap:8px"><span>${esc(w.window)}</span>` +
                  `<span class="muted small">${typeof w.remainingPct === "number" ? esc(w.remainingPct + "% left") : "not measured"}` +
                  `${w.resetsIn ? " - resets in " + esc(w.resetsIn) : ""}</span></div>`,
              )
              .join("")
          : `<div class="muted small">connected, but no quota window was reported</div>`) +
        (p.noDollarBudget ? `<div class="muted small">subscription, no dollar budget</div>` : "");
    }
    return (
      `<div class="card card-pad"><div class="row" style="justify-content:space-between;gap:8px"><b>${esc(p.label)}</b>` +
      `<span class="tiny muted">${esc(p.kind)} - ${esc(p.source)}${p.stale ? " - stale (last good reading)" : ""}</span></div>` +
      body + `</div>`
    );
  };
  const sp = real.spend || {};
  const bp = sp.byProvider || {};
  const bucketRows = (rows, label) =>
    !Array.isArray(rows) || !rows.length
      ? `<div class="muted small">no ${esc(label)} recorded</div>`
      : `<table class="tbl"><thead><tr><th>${esc(label)}</th><th>calls</th><th>measured spend</th></tr></thead><tbody>` +
        rows
          .map(
            (r) =>
              `<tr><td class="wrap-any">${esc(r.key)}</td><td>${esc(String(r.calls || 0))}</td><td>${esc(
                typeof r.costUsd === "number" ? "$" + r.costUsd.toFixed(4) : "not measured",
              )}</td></tr>`,
          )
          .join("") +
        `</tbody></table>`;
  const agents = Array.isArray(real.agents) ? real.agents : [];
  return (
    `<div class="card card-pad"><div class="card-head"><h3>Provider limits (real)</h3></div>` +
    `<div class="grid-2">${[real.providers.go, real.providers.deepseek, real.providers.claude].map(prov).join("")}</div>` +
    (Array.isArray(real.notMeasured) && real.notMeasured.length
      ? `<div class="tiny muted wrap-any" style="margin-top:6px">Not measured right now: ${esc(real.notMeasured.join(" | "))}</div>`
      : "") +
    `<div class="divider"></div>` +
    `<div class="row" style="justify-content:space-between"><b>Spend (measured)</b>` +
    `<span class="tiny muted">today ${esc(amount(sp.todayUsd))} - 7 days ${esc(amount(sp.last7dUsd))} - all recorded ${esc(amount(sp.allTimeUsd))}</span></div>` +
    `<div class="tiny muted">DeepSeek direct ${esc(amount(bp.deepseekDirectUsd))} (shown separately from Go) - Go/other ${esc(amount(bp.opencodeGoUsd))} - Claude ${esc(amount(bp.claudeUsd))}</div>` +
    `<div class="grid-2" style="margin-top:6px"><div>${bucketRows(sp.byDepartment, "department")}</div><div>${bucketRows(sp.byModel, "model")}</div></div>` +
    `<div class="tiny muted" style="margin-top:4px">${esc(oneLine(sp.note || ""))}</div>` +
    `<div class="divider"></div>` +
    `<div class="row" style="justify-content:space-between"><b>Spent so far (read-only, no quotas)</b><span class="tiny muted">per agent</span></div>` +
    (agents.length
      ? `<table class="tbl"><thead><tr><th>agent</th><th>role</th><th>department</th><th>spent so far</th><th>spent today</th><th>share</th></tr></thead><tbody>` +
        agents
          .map(
            (a) =>
              `<tr><td class="wrap-any">${esc(a.name || a.agentId)}</td><td>${esc(a.role)}</td><td>${esc(a.departmentName)}</td>` +
              `<td>${esc(amount(a.spentUsd))}</td><td>${esc(amount(a.spentTodayUsd))}</td><td>${esc(
                (typeof a.sharePct === "number" ? a.sharePct.toFixed(1) : "0") + "%",
              )}</td></tr>`,
          )
          .join("") +
        `</tbody></table>`
      : `<div class="muted small">no agent spend recorded yet</div>`) +
    `<div class="tiny muted" style="margin-top:4px">There are no per-agent quotas: nobody is refused work for a spend cap. ` +
    `Provider pressure (amber/red) is the only thing that may slow work.</div>` +
    `</div>`
  );
}

/* ==================================================================
 * PANEL: provider usage (GET /company/provider-usage)
 *
 * The real provider quota windows and the measured spend by model, next to
 * the virtual budget above. Nothing here is invented: a field the provider
 * does not report renders as "not measured", and a provider that exposes
 * nothing renders as "unavailable, because <reason>".
 * ================================================================== */

function usedSeverity(usedPct) {
  if (typeof usedPct !== "number" || !isFinite(usedPct)) return "";
  return usedPct >= 85 ? "sev-err" : usedPct >= 60 ? "sev-warn" : "sev-ok";
}

/* Smaller amounts need more decimals than money() gives, or a real $0.0034
 * measured call would print as "$0.0000". */
function spendUsd(v) {
  if (typeof v !== "number" || !isFinite(v)) return "not measured";
  return "$" + (Math.abs(v) < 0.01 ? v.toFixed(6) : v.toFixed(4));
}

function oneLine(s) {
  return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
}

/* ProviderUsage has no separate `reason` field: the honest reason IS `detail`
 * (src/company/usage.ts). For a provider error it is prefixed "Quota
 * unavailable: "; strip that so the card reads "unavailable, because
 * <reason>" without saying "unavailable" twice. */
function unavailableReason(p) {
  const d = oneLine(p && p.detail)
    .replace(/^quota\s+unavailable\s*[:\-]\s*/i, "")
    .replace(/^unavailable\s*[:\-]\s*/i, "");
  return d || "the provider reported no reason";
}

function usageWindow(w) {
  const used = typeof w.usedPct === "number" && isFinite(w.usedPct) ? w.usedPct.toFixed(0) + "%" : "not measured";
  const right = [
    used + " used",
    w.note ? w.note : null,
    w.resetsIn ? "resets in " + w.resetsIn : "reset time not reported",
  ]
    .filter(Boolean)
    .join(" · ");
  const sev = usedSeverity(w.usedPct);
  return (
    `<div style="margin-top:var(--sp-2)">` +
    `<div class="row" style="justify-content:space-between;gap:var(--sp-2)"><span>${esc(w.label)}</span>` +
    `<span class="tiny muted">${esc(right)}</span></div>` +
    (sev
      ? `<div class="bar" style="margin-top:4px"><div class="bar-fill ${sev}" style="width:${Math.max(0, Math.min(100, w.usedPct))}%"></div></div>`
      : "") +
    `</div>`
  );
}

function usageProviderCard(p) {
  const unavailable = p.source === "unavailable";
  const pill = unavailable ? "pill pill-err" : p.source === "measured" ? "pill pill-dim" : "pill pill-ok";
  const head = `<div class="row" style="flex-wrap:wrap;gap:var(--sp-2)">` +
    `<b>${esc(p.provider)}</b>` +
    `<span class="${pill}">${esc(p.source || "unknown")}</span>` +
    (p.plan ? `<span class="tiny muted">plan: ${esc(p.plan)}</span>` : "") +
    `</div>`;

  const windows = (p.windows || []).map(usageWindow).join("");
  const spend =
    typeof p.measuredSpendUsd === "number"
      ? `measured spend ${spendUsd(p.measuredSpendUsd)}` +
        (typeof p.calls === "number" ? ` over ${p.calls} recorded call(s)` : "")
      : null;

  const body = unavailable
    ? `<div class="muted wrap-any" style="margin-top:var(--sp-2)"><b>unavailable, because</b> ${esc(unavailableReason(p))}</div>` +
      windows
    : windows ||
      `<div class="tiny muted wrap-any" style="margin-top:var(--sp-2)">${esc(oneLine(p.detail) || "No quota window reported.")}</div>`;

  return (
    `<div class="card card-pad">` +
    head +
    body +
    (spend ? `<div class="tiny muted" style="margin-top:var(--sp-2)">${esc(spend)}</div>` : "") +
    (!unavailable && p.detail
      ? `<div class="tiny mono muted wrap-any" style="margin-top:var(--sp-2)">${esc(oneLine(p.detail))}</div>`
      : "") +
    `</div>`
  );
}

function measuredSpendTable(rows) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  if (!list.length) {
    return (
      `<div class="muted" style="margin-top:var(--sp-2)">No measured per-call spend recorded yet ` +
      `(company/projects/*/cost.jsonl on this company root).</div>`
    );
  }
  list.sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0));
  const calls = list.reduce((n, r) => n + (r.calls || 0), 0);
  const cost = list.reduce((n, r) => n + (r.costUsd || 0), 0);
  const body = list
    .map(
      (r) =>
        `<tr><td class="mono wrap-any">${esc(r.model)}</td><td>${esc(String(r.calls ?? 0))}</td>` +
        `<td>${esc(spendUsd(r.costUsd))}</td></tr>`,
    )
    .join("");
  return (
    `<div class="table-wrap" style="margin-top:var(--sp-2)"><table class="tbl">` +
    `<thead><tr><th>Model</th><th>Calls</th><th>Measured spend</th></tr></thead>` +
    `<tbody>${body}</tbody></table></div>` +
    `<div class="tiny muted" style="margin-top:4px">Total: ${esc(String(calls))} calls, ${esc(spendUsd(cost))}. ` +
    `From company/projects/*/cost.jsonl - measured, but the runtime's own per-call figure, not a provider invoice.</div>`
  );
}

function providerUsageSection(data, err) {
  const head = `<div class="card-head"><h3>Provider usage - the real quota windows</h3></div>`;

  if (err) {
    const status = err && err.status ? String(err.status) + " " : "";
    return (
      `<div class="card card-pad">` +
      head +
      `<div class="state-title">Provider usage could not be read</div>` +
      `<div class="muted wrap-any">GET /company/provider-usage -> ${esc((status + (err.message || String(err))).trim())}</div>` +
      `<div class="tiny muted" style="margin-top:var(--sp-2)">These numbers come from the provider CLIs through that route ` +
      `(docs/PROVIDER_USAGE.md). Until it answers, this panel shows the error rather than a guess.</div>` +
      `</div>`
    );
  }
  if (!data || !Array.isArray(data.providers)) {
    return `<div class="card card-pad">` + head + `<div class="muted">The route answered but carried no providers.</div></div>`;
  }

  const captured = data.capturedAt ? new Date(data.capturedAt) : null;
  const capturedText =
    captured && !isNaN(captured.getTime())
      ? captured.toLocaleString()
      : data.capturedAt
        ? String(data.capturedAt)
        : "not reported";

  const cards = data.providers.map(usageProviderCard).join("");

  return (
    `<div class="card card-pad">` +
    head +
    `<div class="row" style="justify-content:space-between;gap:var(--sp-2);flex-wrap:wrap">` +
    `<span class="tiny muted">captured at <b>${esc(capturedText)}</b> · the provider CLIs report this, we do not compute it</span>` +
    `<button class="btn btn-sm" data-act="usage-refresh">Refresh provider usage</button>` +
    `</div>` +
    (cards ? `<div class="grid-2" style="margin-top:var(--sp-2)">${cards}</div>` : `<div class="muted">No provider rows.</div>`) +
    `<div class="divider"></div>` +
    `<div class="row" style="justify-content:space-between"><b>Measured spend by model</b>` +
    `<span class="tiny muted">our own per-call ledger</span></div>` +
    measuredSpendTable(data.measuredByModel) +
    `</div>`
  );
}

function missingRouteCard(detail) {
  return (
    `<div class="card card-pad">` +
    `<div class="state-title">The budget feed is not on this router yet</div>` +
    `<div class="muted">\`GET /company/budget\` is part of the running router only after the next restart ` +
    `(the route is in src/server.ts, ready). Until then this page cannot read the numbers.</div>` +
    `<div class="tiny muted mono wrap-any" style="margin-top:var(--sp-2)">${esc(detail || "")}</div>` +
    `<div class="muted" style="margin-top:var(--sp-2)">Meanwhile, from the project root:` +
    `<div class="mono">npx tsx ops/budget-poll.ts</div>` +
    `writes company/budget/state.json and prints the same table.</div>` +
    `</div>`
  );
}

export function mount(el, ctx) {
  const { api, poll, esc } = ctx;
  let stopped = false;

  function render(body) {
    if (stopped) return;
    el.innerHTML = body;
  }

  async function load(force, usageForce) {
    let data = null;
    let err = null;
    let usage = null;
    let usageErr = null;
    // All in parallel: the real-budget cards and the provider-usage panel are
    // separate cards, but they have to be part of the SAME render or a later
    // render would wipe them. GET /company/budget carries `real`, the same
    // object GET /company/budget/real returns.
    const [budgetRes, usageRes] = await Promise.all([
      (force ? api("/company/budget/refresh", { method: "POST" }) : api("/company/budget"))
        .then((d) => ({ ok: true, d }))
        .catch((e) => ({ ok: false, e })),
      api("/company/provider-usage", usageForce ? { fresh: true } : undefined)
        .then((d) => ({ ok: true, d }))
        .catch((e) => ({ ok: false, e })),
    ]);
    if (!budgetRes.ok) err = budgetRes.e;
    else data = budgetRes.d;
    const real = data && data.real && data.real.providers ? data.real : null;
    if (usageRes.ok) usage = usageRes.d;
    else usageErr = usageRes.e;
    if (stopped) return;

    // PANEL: the provider-usage card renders in every state, including when the
    // budget snapshot itself is missing, so one broken route never hides the other.
    const usagePanel = providerUsageSection(usage, usageErr);

    function wire() {
      const btn = el.querySelector('[data-act="refresh"]');
      if (btn) {
        btn.addEventListener("click", () => {
          btn.disabled = true;
          btn.textContent = "Polling…";
          load(true);
        });
      }
      const ubtn = el.querySelector('[data-act="usage-refresh"]');
      if (ubtn) {
        ubtn.addEventListener("click", () => {
          ubtn.disabled = true;
          ubtn.textContent = "Polling…";
          load(false, true);
        });
      }
    }

    const snap = data && data.snapshot ? data.snapshot : null;
    if (!snap) {
      const detail = err
        ? `GET /company/budget -> ${err.status || ""} ${err.message || err}`.trim()
        : data && data.hint
          ? data.hint
          : "no snapshot yet";
      render(missingRouteCard(detail) + virtualCapsCard(real) + usagePanel);
      wire();
      return;
    }

    const parts = [];
    parts.push(
      `<div class="row" style="justify-content:space-between">` +
        `<span class="tiny muted">checked ${esc(new Date(snap.checkedAt).toLocaleTimeString())} · every ${esc(String(snap.pollS))} s` +
        `${data.status && data.status.running ? "" : " · watcher not running (a manual poll is fine)"}</span>` +
        `<button class="btn btn-sm" data-act="refresh">Refresh now</button>` +
      `</div>`,
    );
    parts.push(`<div class="grid-2">${providerCard(snap.providers.go, snap.samples)}${providerCard(snap.providers.claude, snap.samples)}</div>`);
    if (snap.override) {
      // The CEO answered a budget item in the inbox, so a one-time grant is held.
      parts.push(
        `<div class="card card-pad"><div class="row" style="justify-content:space-between"><b>The CEO allowed one override</b>` +
          `<span class="pill pill-warn">held</span></div>` +
          `<div class="muted">Answer: "${esc(snap.override.answer)}"` +
          `${snap.override.expiresAt ? ` - expires ${esc(new Date(snap.override.expiresAt).toLocaleString())}` : ""}. ` +
          `The next pick the guard would have changed keeps its model, and the grant is spent on that one decision.</div></div>`,
      );
    }
    parts.push(effectsCard(snap));
    parts.push(rulesCard(snap));
    parts.push(
      `<div class="card card-pad"><div class="card-head"><h3>Measured spend (our own per-call ledger)</h3></div>` +
        `<div class="row" style="gap:var(--sp-4)">` +
          `<span>Today: <b>${esc(money(snap.spend?.todayUsd))}</b></span>` +
          `<span>Last hour: <b>${esc(money(snap.spend?.lastHourUsd))}</b></span>` +
          `<span>Last 24 h: <b>${esc(money(snap.spend?.last24hUsd))}</b></span>` +
        `</div>` +
        `<div class="tiny muted" style="margin-top:4px">From company/projects/*/cost.jsonl (the runtime's own per-call cost). ` +
        `It is the best record of what was spent, not a provider invoice.</div>` +
      `</div>`,
    );
    if (data && data.brain) parts.push(brainCard(data.brain));
    // REAL NUMBERS (CEO order 2026-10-01): provider limits, measured spend and a
    // read-only "spent so far" list. No per-agent caps exist any more.
    parts.push(virtualCapsCard(real));
    // PANEL: the provider-usage card (quota windows + measured spend by model).
    parts.push(usagePanel);
    render(parts.join(""));
    wire();
  }

  load(false);
  const stop = poll(() => load(false), POLL_MS);
  return function cleanup() {
    stopped = true;
    stop();
  };
}
