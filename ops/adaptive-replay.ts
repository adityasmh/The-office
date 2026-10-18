/**
 * ops/adaptive-replay.ts — replay REAL past outcomes into the estimator and print
 * what it would have learned. Read-only: nothing under company/ is written; the
 * replay engine persists to a temp dir.
 *
 * Run: npx tsx ops/adaptive-replay.ts
 *
 * Sources (all real, already on disk):
 *   1. logs/router.out.log `fleet:plan:debug` lines -> the planner call site. The
 *      line's own `{via, detail}` is NOT the model that ran: `via`/`detail` carry the
 *      route label ("claude"/"claude-sonnet-5-5") even when the router actually ran
 *      another model (see the 2026-10-01 10:12-10:27Z lines: `[brain] fleet-plan:
 *      tier=none model=deepseek-v4.1-flash` is printed just before the debug line).
 *      So the model comes from the `[brain] fleet-plan: tier=... model=...` line logged
 *      for the SAME plan. Plans run in parallel, so a debug line is paired with the
 *      nearest preceding brain line within PAIR_WINDOW_MS, and only when every brain
 *      line still pending in that window names the same model; otherwise the row is
 *      `unattributed` (never guessed). `parsed`/failure kind still come from the debug line.
 *   2. company/fleet/orders.json -> per-order planner outcome. Orders carry no model
 *      field, so the old code used "the model the log lines name (via=claude)" — the same
 *      label. Fix: a real planner failure is an order whose trace has a `plan failed` /
 *      `plan warning` entry (a later worker failure is NOT a planner failure), and its
 *      model is (a) the model on the trace's own `planner via ...` line when the call
 *      fell back (on 2026-09-30 claude was unavailable and the planner ran kimi), else
 *      (b) the `[brain] fleet-plan` line the brain logged right after the order was created.
 *   3. company/sessions.jsonl -> per-model worker outcomes (done/error/running). Checked
 *      for the same label problem: each session carries the model the router really ran
 *      (five different ids across roles, never the always-"claude" route label), so no
 *      change was needed here.
 *
 * Honest limits, printed with the numbers:
 *   - the log/order data does not name a task class, so plan events are COMPLEX
 *     (the planner's class) and sessions take the class their model is the default
 *     for; that is an assumption, not a measurement.
 *   - parallel plans: an exact brain -> debug pairing is impossible; rows that cannot be
 *     pinned to one model are reported as `unattributed` and are NOT fed to the estimator
 *     (a fake "unattributed" model would be worse than a smaller honest table).
 *   - `running` sessions are excluded (no outcome yet).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AdaptiveEngine, modelCatalog } from "../src/adaptive/index.js";
import type { FailureKind, TaskClass } from "../src/adaptive/events.js";

const ROOT = process.argv[2] ?? process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adaptive-replay-"));

/** brain -> plan-result gap for real planner calls is ~2-60 s; 120 s is a safe bound. */
const PAIR_WINDOW_MS = 120_000;
/** order created -> brain decision gap is well under a minute in the real data. */
const ORDER_BRAIN_WINDOW_MS = 60_000;

type Ev = { ts: string; model: string; cls: TaskClass; ok: boolean; failureKind: FailureKind; latencyMs: number; cost: number; source: string };
const events: Ev[] = [];
const problems: string[] = [];

const cat = modelCatalog();
const rankCls: Record<number, TaskClass> = { 0: "ROUTINE", 1: "STANDARD", 2: "COMPLEX", 3: "DEMANDING", 4: "DEMANDING" };
const classFor = (model: string): TaskClass => {
  const spec = cat.find((m) => m.id === model);
  return spec ? rankCls[spec.costRank] ?? "STANDARD" : "STANDARD";
};
// The brain's cheap-model id (`deepseek-v4.1-flash`, src/company/brainRouter.ts) and the
// catalog's Standard model (`deepseek-v4-flash`) are the same Go model — both spellings map
// to the DeepSeek API's `deepseek-flash` (src/company/deepseekDirect.ts) — so cost is
// looked up under the catalog id while events keep the id the source actually printed.
const COST_ALIAS: Record<string, string> = { "deepseek-v4.1-flash": "deepseek-v4-flash" };
const costOf = (model: string) => cat.find((m) => m.id === (COST_ALIAS[model] ?? model))?.costUsd ?? 0;

const tsOf = (line: string): string => {
  const m = /^\[([^\]]+)\]/.exec(line);
  return m && Number.isFinite(Date.parse(m[1])) ? m[1] : "";
};

// ---- 1. planner outcomes from the router log ---------------------------------
type BrainLine = { ts: string; t: number; model: string };
type DebugLine = { ts: string; t: number; textLen?: number; parsed?: boolean; ok: boolean };
const brainLines: BrainLine[] = [];
const debugLines: DebugLine[] = [];
let malformed = 0;

for (const file of ["logs/router.out.log", "logs/router.out.log.1", "logs/router.out.log.bak"]) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (line.includes("[brain] fleet-plan:")) {
      const ts = tsOf(line);
      const mm = /tier=(\S+)\s+model=(\S+)/.exec(line);
      if (ts && mm) brainLines.push({ ts, t: Date.parse(ts), model: mm[2] });
      continue;
    }
    if (!line.includes("fleet:plan:debug")) continue;
    const ts = tsOf(line);
    const at = line.indexOf("{");
    let payload: { textLen?: number; parsed?: boolean } | null = null;
    try {
      payload = at > 0 ? (JSON.parse(line.slice(at)) as { textLen?: number; parsed?: boolean }) : null;
    } catch {
      payload = null;
    }
    if (!ts || !payload || Object.keys(payload).length === 0) {
      malformed += 1;
      continue;
    }
    debugLines.push({ ts, t: Date.parse(ts), textLen: payload.textLen, parsed: payload.parsed === true, ok: true });
  }
}
brainLines.sort((a, b) => a.t - b.t);
debugLines.sort((a, b) => a.t - b.t);

// Pair each debug line with the brain line of the SAME plan. Plans run in parallel, so:
// take every brain line still unconsumed, preceding the debug line and inside the window;
// attribute only if they all name the same model, else the row is ambiguous -> `unattributed`.
const consumed = new Set<number>();
let logLines = 0;
let attributed = 0;
let unattributed = 0;
let ambiguous = 0;
let noBrainLine = 0;
const unattributedRows: { ts: string; ok: boolean }[] = [];
const logTally = new Map<string, { n: number; ok: number }>();

for (const d of debugLines) {
  const pending: number[] = [];
  for (let i = 0; i < brainLines.length; i++) {
    if (consumed.has(i)) continue;
    const b = brainLines[i];
    if (b.t <= d.t && d.t - b.t <= PAIR_WINDOW_MS) pending.push(i);
  }
  if (pending.length === 0) {
    unattributed += 1;
    noBrainLine += 1;
    unattributedRows.push({ ts: d.ts, ok: d.parsed === true });
    continue;
  }
  // Plans are matched in order: the oldest pending brain line belongs to the oldest unfinished plan.
  consumed.add(pending[0]);
  const models = new Set(pending.map((i) => brainLines[i].model));
  if (models.size > 1) {
    unattributed += 1;
    ambiguous += 1;
    unattributedRows.push({ ts: d.ts, ok: d.parsed === true });
    continue;
  }
  const model = brainLines[pending[0]].model;
  attributed += 1;
  logLines += 1;
  const ok = d.parsed === true;
  events.push({
    ts: d.ts,
    model,
    cls: "COMPLEX",
    ok,
    failureKind: ok ? "ok" : "planner_no_json",
    latencyMs: Math.min(60000, (200 * Math.max(1, d.textLen ?? 1)) / 10),
    cost: costOf(model),
    source: "fleet-planner(log)",
  });
  const t = logTally.get(model) ?? { n: 0, ok: 0 };
  t.n += 1;
  if (ok) t.ok += 1;
  logTally.set(model, t);
}
const unmatchedBrainLines = brainLines.filter((_, i) => !consumed.has(i)).length;

// ---- 2. per-order planner outcomes from orders.json ---------------------------
type TraceEntry = { ts?: string; what?: string; detail?: string };
type Order = { id: string; status: string; plan: string; createdAt: string; planAttempts?: number; trace?: TraceEntry[] };
let orders: Order[] = [];
try {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, "company/fleet/orders.json"), "utf8"));
  orders = (Array.isArray(raw) ? raw : (raw as { orders?: unknown[] }).orders ?? []) as Order[];
} catch {
  problems.push("company/fleet/orders.json unreadable");
}
const orderStatus = new Map<string, number>();
let plannerFailures = 0;
let orderAttributed = 0;
let orderUnattributed = 0;
let orderNotAPlannerFailure = 0;
let toolCallOrders = 0;
let proseOrders = 0;

const isPlannerFailure = (o: Order): boolean =>
  (o.trace ?? []).some((t) => /plan failed|plan warning/i.test(String(t.what ?? "")));

const orderConsumed = new Set<number>();

const orderModel = (o: Order): string => {
  // (a) a fallback names the model that really ran: `planner via kimi: kimi-k2.7-code (...)`.
  const via = (o.trace ?? []).find((t) => /planner via/i.test(`${t.what ?? ""} ${t.detail ?? ""}`));
  const first = via?.detail ? String(via.detail).trim().split(/[\s(,]+/)[0] : "";
  if (first) return first;
  // (b) otherwise the FIRST brain line the brain logged after this order was created (the
  // order is created, then the brain decides; the gap is under a second in the real data,
  // and the order's own "plan failed" timestamp then matches the plan's debug line).
  const created = Date.parse(String(o.createdAt ?? ""));
  if (!Number.isFinite(created)) return "unattributed";
  for (let i = 0; i < brainLines.length; i++) {
    if (orderConsumed.has(i)) continue;
    const b = brainLines[i];
    if (b.t >= created && b.t - created <= ORDER_BRAIN_WINDOW_MS) {
      orderConsumed.add(i);
      return b.model;
    }
  }
  return "unattributed";
};

// Orders carry no model, so match them in creation order (one brain line per plan).
const orderModelById = new Map<Order, string>();
for (const o of [...orders].filter(isPlannerFailure).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) {
  orderModelById.set(o, orderModel(o));
}

for (const o of orders) {
  orderStatus.set(o.status, (orderStatus.get(o.status) ?? 0) + 1);
  if (!isPlannerFailure(o)) {
    orderNotAPlannerFailure += 1;
    continue;
  }
  plannerFailures += 1;
  const plan = String(o.plan ?? "");
  const toolCall = /DSML|invoke name=|tool_calls|<\|tool/.test(plan);
  if (toolCall) toolCallOrders += 1;
  else proseOrders += 1;
  const model = orderModelById.get(o) ?? "unattributed";
  if (model === "unattributed") {
    orderUnattributed += 1;
    continue;
  }
  orderAttributed += 1;
  events.push({
    ts: o.createdAt || new Date().toISOString(),
    model,
    cls: "COMPLEX",
    ok: false,
    failureKind: toolCall ? "tool_call_instead_of_json" : "planner_no_json",
    latencyMs: 4000,
    cost: costOf(model),
    source: "fleet-planner(order)",
  });
}

// ---- 3. worker outcomes from sessions.jsonl ------------------------------------
let sessions = 0;
let running = 0;
const sessionModels = new Set<string>();
try {
  const lines = fs.readFileSync(path.join(ROOT, "company/sessions.jsonl"), "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    let s: { model?: string; status?: string; startedAt?: string; finishedAt?: string; durationMs?: number; costUsd?: number };
    try {
      s = JSON.parse(line);
    } catch {
      continue;
    }
    const model = String(s.model ?? "");
    const status = String(s.status ?? "");
    if (!model) continue;
    sessionModels.add(model);
    if (/running/i.test(status)) {
      running += 1;
      continue;
    }
    const ok = /done|complete|finish|review/i.test(status);
    if (!ok && !/error|fail|cancel/i.test(status)) continue;
    sessions += 1;
    events.push({
      ts: s.finishedAt || s.startedAt || new Date().toISOString(),
      model,
      cls: classFor(model),
      ok,
      failureKind: ok ? "ok" : "error",
      latencyMs: Math.max(0, Math.round(s.durationMs ?? 0)),
      cost: s.costUsd ?? costOf(model),
      source: "fleet-worker(pipeline)",
    });
  }
} catch {
  problems.push("company/sessions.jsonl unreadable");
}

// ---- replay into a fresh estimator --------------------------------------------
events.sort((a, b) => a.ts.localeCompare(b.ts));
const eng = new AdaptiveEngine({ root: tmp, brokers: null, enabled: true, persist: true, subscribe: true, source: "replay" });
for (const e of events) eng.record(e);
eng.flush();

// The planner model with the most real COMPLEX plan outcomes: the busiest pair the
// planner data actually measures (deepseek-v4.1-flash on 2026-10-01; sonnet on 2026-09-30).
const plannerTotals = new Map<string, number>();
for (const e of events) {
  if (!e.source.startsWith("fleet-planner")) continue;
  plannerTotals.set(e.model, (plannerTotals.get(e.model) ?? 0) + 1);
}
const plannerModel = [...plannerTotals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown-planner";

console.log("== adaptive-replay (real past outcomes) ==");
console.log(
  `sources: router.out.log plan-debug lines=${logLines} (malformed=${malformed}, attributed=${attributed}, unattributed=${unattributed})` +
    ` | orders=${orders.length} (planner failures=${plannerFailures}, attributed=${orderAttributed}, unattributed=${orderUnattributed})` +
    ` | sessions=${sessions} (running skipped=${running})`,
);
console.log(`orders by status: ${[...orderStatus.entries()].map(([k, v]) => `${k}=${v}`).join(" ")}  | tool-call plans=${toolCallOrders} prose plans=${proseOrders}`);
console.log(`orders with no planner failure in trace (not planner outcomes): ${orderNotAPlannerFailure}`);
console.log(`log pairing: rows dropped as unattributed=${unattributed} (ambiguous=${ambiguous}, no brain line in the ${Math.round(PAIR_WINDOW_MS / 1000)}s window=${noBrainLine}); unmatched brain lines=${unmatchedBrainLines}`);
for (const r of unattributedRows) console.log(`  unattributed: ${r.ts} parsed=${r.ok}`);
if (problems.length) console.log(`problems: ${problems.join("; ")}`);
console.log("");
console.log("learned table (model | class | n | P(success) | failure kinds):");
for (const s of eng.est.table()) {
  const kinds = Object.entries(s.kinds)
    .filter(([k, v]) => k !== "ok" && v > 0)
    .map(([k, v]) => `${k} x${v}`)
    .join(", ");
  console.log(`  ${s.model} | ${s.cls} | n=${s.n} | P=${s.p === null ? "cold" : s.p.toFixed(3)} | p50=${s.latencyP50}ms p95=${s.latencyP95}ms | $/call=${s.costPerCall} | ${kinds || "-"}`);
}
console.log("");
const plannerRow = eng.est.stats(plannerModel, "COMPLEX");
console.log(`headline: ${plannerModel} planning on COMPLEX -> P(success)=${plannerRow?.p === null || !plannerRow ? "cold" : plannerRow.p.toFixed(3)} over n=${plannerRow?.n ?? 0} real outcomes`);
for (const [m, t] of [...logTally.entries()].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  log-only: ${m} planner calls=${t.n} parseable=${t.ok} (${((t.ok / t.n) * 100).toFixed(1)}%)`);
}
console.log(`  session models seen: ${[...sessionModels].join(", ")}`);
console.log("  (a session's model field is the model the router really ran for that role, not the route label)");

// What the rule engine would do with that data, for the planner request.
const last = events.length ? events[events.length - 1].ts : new Date().toISOString();
const nowMs = Date.parse(last) || Date.now();
const pickFailing = eng.select(
  { modelId: plannerModel, via: "gateway", reason: `Laya best_model=${plannerModel} conf=0.72` },
  "COMPLEX",
  "GOAL: plan a fleet order (the planner call site)",
  { nowMs, rng: () => 1 },
);
console.log("");
console.log(`rule engine with this data, prior = the measured failing planner ${plannerModel}: -> ${pickFailing.modelId}`);
console.log(`  reason: ${pickFailing.reason}`);
console.log(`  circuit states: ${JSON.stringify(pickFailing.circuit)}`);
const pickSonnet = eng.select(
  { modelId: "claude-sonnet-5-5", via: "claude-subscription", reason: "Laya best_model=claude-sonnet-5-5 conf=0.71" },
  "COMPLEX",
  "GOAL: plan a fleet order (the planner call site)",
  { nowMs, rng: () => 1 },
);
console.log(`rule engine with sonnet as prior (the model the OLD replay blamed): -> ${pickSonnet.modelId}`);
console.log(`  reason: ${pickSonnet.reason}`);
console.log(`decisions recorded during replay: ${eng.decisions.length}`);
console.log(`dlq (unparseable debug payloads): ${malformed}`);
console.log(`\n(temp dir: ${tmp})`);
