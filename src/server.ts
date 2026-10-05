import "dotenv/config";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { assertConfig, config } from "./config.js";
import { decideRoute, generate } from "./orchestrator.js";
// ADAPTIVE ROUTING (docs/perf/ADAPTIVE_ROUTING.md): read-only monitoring routes
// below. The engine is created lazily and is inert unless ADAPTIVE_ROUTING=1.
import { getAdaptive } from "./adaptive/index.js";
import { classifyBrain, reviewAnswer } from "./decision.js";
import { buildClaudePrompt, buildOpencodePrompt, parseClaudePlan, type HandoffBundle } from "./handoff.js";
import { callClaudeSubscription, hasClaudeCreds } from "./claudeSubscription.js";
import { brainSummary, notifySlack } from "./slack.js";
import { runTeamTask } from "./team.js";
import {
  loadOrg, saveOrg, getProject, createProject, createDepartment, updateProjectTeam, validateTeamConfig,
  readThread, readCost, type ProjectTeamConfig,
} from "./company/org.js";
import { runPipeline, resumeTask, reconcileStaleTasks, startBootResumeQueue, stopBootResumeQueue } from "./company/pipeline.js";
import { flowData } from "./company/flow.js";
import { createTask, getTask, approveGate, loadTasks, updateTask } from "./company/gates.js";
import { panelData, panelRevision, panelState, type PanelPayload } from "./company/panel.js";
import { listSessions, sessionCounts, getSession, getSessionTail, reconcileStaleSessions } from "./company/sessions.js";
import { budgetByDepartment, budgetTotals, getBudget, listBudgets, setAllocation } from "./company/budget.js";
import { agentThread, findAgent, listAgentsFlat, messageAgent } from "./company/agentchat.js";
import {
  assistantMessage, assistantStatus, assistantThread, resumeInflightPlanning,
  getAssistantVoiceEnabled, setAssistantVoiceEnabled,
} from "./company/assistant.js";
// ATTACH (2026-09-29): the CEO's paperclip/drag-drop. The module owns the magic-byte
// check and the safe file name; server.ts only wires one route to it.
import { MAX_UPLOAD_BYTES, saveUpload } from "./company/uploads.js";
import { TOKEN_HEADER, constantTimeEqual, hostAllowed, isLoopbackAddress, presentedToken } from "./company/authguard.js";
import { startSlackInbound, stopSlackInbound, inboundStatus } from "./company/slackInbound.js";
import { getNote, listNotes, memoryStatus, recall, rebuildGraph, remember } from "./company/memory.js";
import {
  getTerminal, listTerminals, reaperStatus, recordVerdict, runReaperPass, setKeepOpen, startTerminalReaper,
} from "./company/terminalReaper.js";
import {
  type ApproveOptions, approveFleetOrder, cancelFleetOrder, createFleetOrder, fleetOrderDetail,
  fleetOrdersData, loadFleetOrders, reconcileFleetOnBoot, redoWorkOrder, republishWorkOrder, startFleetWatcher, stopFleetWatcher,
} from "./company/fleet.js";
// ENV-RELOAD (order F2-ENVRELOAD, 2026-10-06): re-read the small allow-list in this module
// (GITHUB_TOKEN + the Fleet/budget knobs) into the RUNNING process, no restart. See the route
// below: POST /company/reload-env, behind the same secret as every other POST under /company.
import { reloadEnv } from "./company/envReload.js";
import { openNeedsYouItems, resolveNeedsYou, managerQueueTick, startManagerQueueWatcher } from "./company/needsYouActions.js";
// CEO APPROVAL POLICY (2026-09-30): routine retry/drop prompts are the manager's call.
// They land in company/reports/manager-queue.json and are served read-only here.
import { managerQueueSummary } from "./company/managerQueue.js";
import { getRunCard, listRunCards, runCounts, runManagerStatus } from "./company/runManagers.js";
import {
  closePlan, lifecycleKnobs, listSnapshots, readSnapshot, refuseNewWork, resumeJobStatus, shutdownJobStatus,
  startResume, startShutdown, systemStatus, takeSnapshot,
} from "./company/lifecycle.js";
// LAYA-CTL: status, stop and start controls for the Laya decision server (System page panel).
// LAYA-UX: `switchLaya()` is the one-action stop-then-start-the-other-device path.
import { layaStatus, startLaya, stopLaya, switchLaya } from "./company/layaControl.js";
import {
  briefingStatus, getBriefing, markBriefingSeen, refreshBriefing, startBriefingWatcher, stopBriefingWatcher,
} from "./company/briefing.js";
// BUDGET (docs/BUDGET_SPEC.md): real provider budget pressure (OpenCode Go
// remaining allowance + the Claude windows) and the rules that steer Laya, the
// Fleet and the assistant before a provider stops them. Read-only against the
// providers; the watcher is guarded/unref'd like the other four.
import {
  budgetStatus, readBudgetState, refreshBudgetState, startBudgetWatcher, stopBudgetWatcher,
} from "./company/budgetGuard.js";
// REAL BUDGET (CEO order 2026-10-01): the provider limits that actually stop work
// (OpenCode Go windows, the DeepSeek credit balance + off-peak phase, the Claude
// subscription) and the measured spend. No per-agent quotas. One builder feeds
// both GET /company/budget/real and the panel payload, so the page and the API
// cannot disagree.
import { buildRealBudget, realBudgetSync } from "./company/budgetReal.js";
// METRICS STACK (docs/METRICS_STACK_SPEC.md, 2026-10-01): one import + one call.
// installMetrics() adds the request counter, GET /company/metrics (Prometheus
// text), GET /company/metrics/query (VictoriaMetrics proxy) and
// POST /company/alerts/webhook. All three routes register after the /company
// guard, so they inherit the same trust boundary as everything else.
import { installMetrics } from "./metrics/index.js";
// DEEPSEEK DIRECT (work order 2026-10-01, budgetGuard->fleet hold): the fleet skips the
// red-budget hold when an order will really run on DeepSeek's own provider. Surfaced on
// the panel payload as two read-only fields; the readiness read never blocks (cached).
import { directPhase, fleetDirectReadyCached, routingPolicyStatus } from "./company/deepseekDirect.js";
// BUDGET x BRAIN ROUTING: today's tier counts for the Budget page's "Brain
// routing" box (which tier each purpose got, and how many Opus calls were avoided).
import { brainStats } from "./company/brainRouter.js";
import { listLiveTerminals, sendTerminalMessage, terminalTail } from "./company/terminalChat.js";
// GUARDED WORKERS (WORKERS-LIVE, 2026-10-06): workers started by ops/spawn-worker.ps1
// run headless (no window), so they never appear in the jcode terminal list above.
// These two read-only routes feed the Terminals page's headless section from
// logs/workers.json + logs/token-ledger.jsonl and a worker's own stdout log.
import { listWorkers, workerTail } from "./company/workersView.js";
import { eventLoopLag, precompressedStatic } from "./company/cache.js";
// ROUTER-HANG (2026-09-30): names what blocks the event loop, caps log spam, and
// leaves evidence in logs/router*.blocks.log WHILE the loop is still blocked.
import { installLoopWatchdog, loopWatchStatus } from "./company/loopWatchdog.js";
// CEO INBOX (docs/INBOX_SPEC.md; owner: session INBOX). The whole backend lives in
// src/company/inbox.ts; server.ts only wires these four routes. Read on GET (loopback
// exempt like every other read), X-Company-Token on the three mutations via companyGuard.
import {
  answerInbox, answerInboxFromSlack, askCeo, inboxStatus, listInbox, reconcileInbox, rewordInbox,
} from "./company/inbox.js";
// PROVIDER USAGE (docs/PROVIDER_USAGE.md): the REAL provider-side constraint -
// subscription quota windows (Claude 5-hour/7-day), OpenCode Go key state and
// locally measured spend, plus our own per-call cost ledger. Where nothing can be
// measured the module says "unavailable" with the reason; it never invents a
// percentage. Read-only: the CLIs are queried, no spend is incurred.
import { providerUsage, measuredSpendByModel, loadGoQuotaSnapshot, openCodeGoUsage } from "./company/usage.js";
// AIR-GAP (PERF item 7): when AIR_GAPPED=1, every non-loopback fetch in THIS process
// is refused before a socket opens, and every CLI hop (claude -p, opencode workers,
// Slack) is gated in its own module. The guard is installed first thing at boot so no
// module-level fetch can run before it. Flag OFF = wrapper still installs but only
// counts, so behaviour is unchanged.
import { airGapStatus, heldQueue, installAirGapFetchGuard } from "./company/airGap.js";
installAirGapFetchGuard();

// ── CRASH FORENSICS (CRASHFIX, 2026-09-29) ─────────────────────────────
// Why this exists: the router died silently at least three times today. The log
// had no timestamps, so "which line came before the death" was unanswerable, and
// an in-process crash and a forcible kill (Stop-Process/taskkill = TerminateProcess,
// which runs no JS at all) looked identical because nothing was ever written.
//
// Two changes, both deliberately tiny and side-effect-light:
//   1. every console line carries an ISO timestamp, so a log that stops
//      mid-stream tells you *when* it stopped;
//   2. every lifecycle event (boot, uncaughtException, unhandledRejection, exit,
//      SIGINT/SIGTERM/SIGBREAK) is appended synchronously to logs/router.crash.log
//      with a timestamp, the stack, the exit code and the signal.
//
// Semantics kept intact: an uncaughtException is still fatal (logged first, then
// exit(1) so the supervisor restarts a clean process), while an
// unhandledRejection is NOT fatal - a fire-and-forget `void runPipeline(...)`
// used to be able to take the whole control plane down with it.
//
// One lifecycle file for the live router, and per-port files for throwaway
// instances: every `src/server.ts` started from this repo (peers' test servers on
// 8791/8898/... included) used to append its BOOT lines to the same
// logs/router.crash.log, which made the live forensic trail noisy exactly when
// someone is trying to read it during an incident.
const crashLogPath =
  config.port === 8787
    ? path.join(process.cwd(), "logs", "router.crash.log")
    : path.join(process.cwd(), "logs", `router-${config.port}.crash.log`);

function crashLog(line: string): void {
  try {
    fs.mkdirSync(path.dirname(crashLogPath), { recursive: true });
    fs.appendFileSync(crashLogPath, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* never let the forensics log become the crash */
  }
}

// Timestamp every line the process prints. `router on ...` stays a substring, so
// ops/run-server-detached.ps1 and ops/router-supervisor.ps1 keep matching it.
for (const level of ["log", "info", "warn", "error"] as const) {
  const original = console[level].bind(console) as (...args: unknown[]) => void;
  console[level] = (...args: unknown[]) => original(`[${new Date().toISOString()}]`, ...args);
}

crashLog(
  `BOOT pid=${process.pid} ppid=${process.ppid} node=${process.version} ` +
    `cwd=${process.cwd()} port=${process.env.PORT ?? "(default)"}`,
);
console.log(`[crash] router pid=${process.pid} ppid=${process.ppid}; lifecycle log: ${crashLogPath}`);

// The loop watchdog goes up before any other boot work (the session/task/fleet
// reconciles below are synchronous reads of company data) so that a slow boot is
// attributed too, and so the log cap is in force for everything after it.
installLoopWatchdog({ port: config.port });

let exitSignal = "";
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) {
  process.on(signal, () => {
    exitSignal = signal;
  });
}

process.on("uncaughtException", (err: unknown) => {
  const stack = err instanceof Error ? (err.stack ?? err.message) : String(err);
  crashLog(`UNCAUGHT_EXCEPTION pid=${process.pid}\n${stack}`);
  console.error(`[crash] uncaughtException (exiting 1 so the supervisor restarts cleanly): ${stack}`);
  try { stopSlackInbound(); } catch { /* dying anyway */ }
  process.exit(1);
});

process.on("unhandledRejection", (reason: unknown) => {
  const stack = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  crashLog(`UNHANDLED_REJECTION pid=${process.pid} (non-fatal, router keeps running)\n${stack}`);
  console.error(`[crash] unhandledRejection (logged, NOT exiting): ${stack}`);
});

process.on("exit", (code: number) => {
  crashLog(`EXIT pid=${process.pid} code=${code} signal=${exitSignal || "none"}`);
});

assertConfig();

// A restart orphans in-flight sessions (the child processes died with the old
// process). Clear them so the dashboard never reports a ghost as running.
try {
  const stale = reconcileStaleSessions();
  if (stale > 0) console.log(`[sessions] reconciled ${stale} stale session(s) left by a previous process`);
} catch (e) {
  console.error("[sessions] reconcile failed:", e);
}
// Same for tasks: nothing is running at boot, so mid-stage tasks are orphans.
// RESUME (docs/RESUME_SPEC.md §2): instead of failing them, they are queued for an
// automatic resume (started in the listen callback) - a restart no longer needs a
// human. Only a task already interrupted twice by restarts is failed.
try {
  const rec = reconcileStaleTasks();
  if (rec.queued || rec.failed || rec.afterShutdown) {
    console.log(
      `[tasks] restart resume: ${rec.queued} interrupted task(s) queued for auto-resume, ` +
        `${rec.afterShutdown} resumed after a planned shutdown, ` +
        `${rec.failed} marked failed (interrupted twice by restarts)`,
    );
  }
} catch (e) {
  console.error("[tasks] reconcile failed:", e);
}

// And for the fleet (docs/RESUME_SPEC.md §1): an order the dying process left at
// `planning` gets its planning restarted (bounded by FLEET_PLAN_MAX_ATTEMPTS, then
// failed with the reason), and a work order caught mid-spawn is adopted if its session
// survived the restart or re-queued once if it did not. Orders the SHUTDOWN session
// paused are skipped here on purpose - the System page's "Resume all" resumes those.
try {
  const fleetBoot = reconcileFleetOnBoot();
  if (fleetBoot.resumed.length || fleetBoot.requeued.length || fleetBoot.adopted.length || fleetBoot.failed.length) {
    console.log(
      `[fleet] restart resume: ${fleetBoot.resumed.length} order(s) planning again, ` +
        `${fleetBoot.requeued.length} work order(s) re-queued, ${fleetBoot.adopted.length} adopted, ` +
        `${fleetBoot.failed.length} failed | resumed=[${fleetBoot.resumed.join(",")}] requeued=[${fleetBoot.requeued.join(",")}] ` +
        `adopted=[${fleetBoot.adopted.join(",")}] failed=[${fleetBoot.failed.join(",")}] skipped=[${fleetBoot.skipped.join(",")}]`,
    );
  }
} catch (e) {
  console.error("[fleet] boot reconcile failed:", e);
}

// DEEPSEEK ROUTING (CEO order 2026-10-02): restore the LAST KNOWN OpenCode Go snapshot before any
// routing decision, so a restart with a cold cache is not blind. An unknown Go quota routes work to
// DeepSeek instead of guessing Go has headroom; a snapshot within the 15-minute staleness window
// keeps the known-quota rules exact. Synchronous, guarded, non-fatal.
try {
  const restored = loadGoQuotaSnapshot();
  if (restored) {
    console.log(
      `[usage] restored last known Go snapshot (${restored.remainingPct}% ${restored.bindingWindow ?? "window"}, checked ${restored.checkedAt})`,
    );
  }
} catch (e) {
  console.error("[usage] Go snapshot restore failed (continuing):", e);
}

const app = express();

// ── HEALTH FIRST (ROUTER-HANG, 2026-09-30) ─────────────────────────────────
// Registered BEFORE every other middleware and with zero file I/O, because
// /health is the one route that must answer while the process is busy:
//   * it used to sit AFTER express.json({limit:"5mb"}), companyGuard and
//     precompressedStatic. precompressedStatic calls fs.statSync() for any GET
//     whose path has a compressible extension or a trailing slash, i.e. the
//     probe itself paid for a blocking stat on this box's AV-inflated FS;
//   * it used to call hasClaudeCreds() per probe, which is existsSync +
//     readFileSync of the credentials file on the event loop. credsPresent is
//     now a cached boolean refreshed by an unref'd timer (plus one warm-up read
//     at boot), so the handler only touches memory.
// Being first means no other route, body parser or static handler can queue ahead
// of it. It still cannot answer while a synchronous call HOLDS the loop - that is
// what src/company/loopWatchdog.ts records (BLOCK / SLOW-SYNC / WATCHER STALL
// lines) and what the supervisor reports as "busy, not dead".
let credsPresentCache = false;
function refreshCredsPresent(): void {
  try {
    credsPresentCache = hasClaudeCreds();
  } catch {
    credsPresentCache = false;
  }
}
refreshCredsPresent();
setInterval(refreshCredsPresent, 30_000).unref?.();

app.get("/health", (_req, res) => {
  const loop = loopWatchStatus();
  res.json({
    ok: true,
    claude: "subscription-only, no api key",
    credsPresent: credsPresentCache,
    mock: config.mockMode,
    // Trust-boundary posture, so a health check shows whether the control plane
    // is locked down (never the secret itself).
    bind: config.host,
    authTokenConfigured: Boolean(config.authToken),
    // Event-loop lag (PERF-BACKEND): this router's failure mode is "200 but
    // seconds late", which a plain ok:true hides. lagMs is the last 250 ms-sample
    // of how late a timer actually fired; lagP95Ms is the p95 over the last 60 s,
    // lagMaxMs the worst since boot. See eventLoopLag() in src/company/cache.ts.
    ...eventLoopLag(),
    // ROUTER-HANG: the same question in more detail, including what was running
    // when the loop was last late and how much log volume the cap removed.
    loop: {
      busy: loop.busy,
      lagNowMs: loop.lagNowMs,
      maxBlockMs: loop.maxBlockMs,
      blocks: loop.blocks,
      lastBlock: loop.lastBlock ?? null,
      lastSlowOp: loop.lastSlowOp ?? null,
      stall: loop.worker,
      logCap: {
        enabled: loop.logCap.enabled,
        truncatedChunks: loop.logCap.truncatedChunks,
        collapsedLines: loop.logCap.collapsedLines,
        droppedLines: loop.logCap.droppedLines,
      },
    },
  });
});

// ── TRUST BOUNDARY (docs/CEO_RUNBOOK.md §0) ────────────────────────────
// The company control plane is not a public surface: /company/* mutations
// spend money (agent runs) and execute code (opencode workers, --auto, in
// arbitrary per-agent workdirs), and GET /company/stream continuously streams
// the whole company state. Two independent controls:
//   1. bind: app.listen binds config.host (default 127.0.0.1), so off-host
//      peers cannot even open a socket;
//   2. secret: every mutating /company/* request and the SSE stream must
//      present COMPANY_AUTH_TOKEN via X-Company-Token (or ?token= for
//      EventSource, which cannot set headers). Loopback reads are exempt so
//      the dashboard and the ops/ harnesses keep working unchanged.
// A non-loopback peer is refused for everything under /company/* unless the
// secret is presented (assertConfig also refuses to bind off-host at all when
// no secret is configured, so the exposed case can never be silent).
function tokenMatches(req: express.Request): boolean {
  const expected = config.authToken;
  if (!expected) return false;
  const presented = presentedToken(req as unknown as { headers?: Record<string, unknown>; query?: unknown });
  return presented.length > 0 && constantTimeEqual(presented, expected);
}

function companyGuard(req: express.Request, res: express.Response, next: express.NextFunction) {
  // The bootstrap endpoint authenticates itself (loopback peer + loopback Host)
  // and must stay reachable for the local dashboard; it is the only exemption.
  if (req.method === "GET" && req.path === "/auth/bootstrap") return next();

  if (tokenMatches(req)) return next();

  const peer = req.socket.remoteAddress;
  const loopback = isLoopbackAddress(peer);
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  const isStream = req.path === "/stream";
  const suffix = req.path === "/" ? "" : req.path;

  // Loopback reads (dashboard polling, ops/ harnesses, the watcher) stay
  // frictionless. Everything else needs the shared secret.
  if (loopback && !mutating && !isStream) return next();

  const detail = !loopback
    ? `peer ${peer ?? "unknown"} is not loopback: the control plane refuses off-host access unless ${TOKEN_HEADER} matches COMPANY_AUTH_TOKEN`
    : mutating
      ? `${req.method} /company${suffix} requires ${TOKEN_HEADER}`
      : `GET /company${suffix} requires ${TOKEN_HEADER} (?token= is accepted for EventSource)`;

  res.status(401).json({
    error: "unauthorized",
    detail,
    header: TOKEN_HEADER,
    hint:
      "Value is COMPANY_AUTH_TOKEN in .env. Bootstrap (loopback only): GET /company/auth/bootstrap. " +
      "See docs/CEO_RUNBOOK.md section 0.",
  });
}

app.use("/company", companyGuard);
app.use("/api", companyGuard);

// The legacy router/handoff endpoints also spend money (Claude subscription,
// Go gateway) and can post to Slack. They stay usable from this machine (the
// dashboard and the ops/ scripts never call them, but hand-run curl does), and
// an off-host peer must present the same secret. Only reachable off-host at all
// when the operator deliberately sets HOST=0.0.0.0.
const OFF_HOST_GUARDED = ["/chat", "/handoff/to-claude", "/handoff/to-opencode", "/team/run", "/notify/slack", "/route"];
app.use(OFF_HOST_GUARDED, (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const peer = req.socket.remoteAddress;
  if (isLoopbackAddress(peer) || tokenMatches(req)) return next();
  res.status(401).json({
    error: "unauthorized",
    detail: `peer ${peer ?? "unknown"} is not loopback: ${req.method} ${req.path} spends provider budget and requires ${TOKEN_HEADER}`,
    header: TOKEN_HEADER,
  });
});

app.use(express.json({ limit: "5mb" }));
// PERF (docs/PERF_SPEC.md item 6, PERF-BACKEND): gzip + Cache-Control for the
// dashboard's own static assets (public/). Uses zlib rather than the
// `compression` package (not installed; installing it needs approval). It only
// handles plain GETs that accept gzip and are not conditional/range requests -
// everything else (directories, 304 revalidation, unknown types) still goes to
// express.static right below, which stays authoritative. V2_STATIC_GZIP=0 turns
// it off. The handler lives in src/company/cache.ts.
app.use(precompressedStatic(path.join(process.cwd(), "public")));
app.use(express.static(path.join(process.cwd(), "public")));

// METRICS STACK (docs/METRICS_STACK_SPEC.md): the ONE line. Registered after the
// /company guard and the body parser so the metrics routes inherit the guard and
// the webhook sees a parsed body.
installMetrics(app);

// /health moved to the top of this file (immediately after `const app = express()`)
// on 2026-09-30 so that no body parser, guard or static handler runs before it.
// Do not re-add a health route here: two handlers for one path would re-introduce
// the middleware ordering this change removed.

// Inspect routing without spending generation budget.
app.post("/route", async (req, res) => {
  try {
    const { prompt, taskHint, minConfidence } = req.body as { prompt: string; taskHint?: string; minConfidence?: number };
    if (!prompt) return res.status(400).json({ error: "prompt required" });
    res.json(await decideRoute(prompt, { taskHint, minConfidence }));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Full flow: Jev classify -> generate -> optional Jev review.
app.post("/chat", async (req, res) => {
  try {
    const { prompt, system, taskHint, review, reference } = req.body as {
      prompt: string; system?: string; taskHint?: string; review?: boolean; reference?: string;
    };
    if (!prompt) return res.status(400).json({ error: "prompt required" });
    const route = await decideRoute(prompt, { taskHint });
    const gen = await generate(prompt, route, system);
    if (!review) return res.json({ route, answer: gen.text, usage: (gen as { usage?: unknown }).usage });
    const verdict = await reviewAnswer(prompt, reference ?? "", gen.text);
    res.json({ route, answer: gen.text, review: verdict });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// OpenCode -> Claude: distill labour context into a brain prompt.
// Dry-run (or no creds, or mock) returns the packaged prompt + which brain would handle it — no purchase needed to validate.
app.post("/handoff/to-claude", async (req, res) => {
  try {
    const { bundle, taskHint, dryRun } = req.body as { bundle: HandoffBundle; taskHint?: string; dryRun?: boolean };
    if (!bundle?.task) return res.status(400).json({ error: "bundle.task required" });
    const brain = await classifyBrain(bundle.task, taskHint ?? "");
    const modelId = brain.brain === "OPUS" ? config.claudeOpus : config.claudeSonnet;
    const pack = buildClaudePrompt(bundle);
    if (dryRun || config.mockMode || !hasClaudeCreds()) {
      return res.json({ brain: brain.brain, modelId, dryRun: true, promptChars: pack.stats.chars, truncated: pack.stats.truncated, system: pack.system, prompt: pack.user });
    }
    const gen = await callClaudeSubscription({
      model: modelId,
      system: pack.system,
      user: pack.user,
      // CHEAP BY DEFAULT (Job 1): this route plans a handoff, so its purpose is "plan".
      // The classifyBrain choice above stays the ceiling; the Laya gate is what decides
      // whether Claude is spent at all, and it reads the ORIGINAL task text.
      purpose: "plan",
      brainText: bundle.task,
    });
    const parsed = parseClaudePlan(gen.text);
    // Mirror to Slack, never block the handoff on it.
    void notifySlack(`${brainSummary(brain.brain, modelId, parsed.tasks.length, pack.stats.chars, pack.stats.truncated)}\nTask: ${bundle.task.slice(0, 200)}`).catch((e) => console.error(e));
    res.json({ brain: brain.brain, modelId, answer: gen.text, tasks: parsed.tasks, stats: pack.stats });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Claude -> OpenCode: turn a brain answer into executable labour prompts for gateway models.
app.post("/handoff/to-opencode", async (req, res) => {
  try {
    const { claudeAnswer, contextRef } = req.body as { claudeAnswer: string; contextRef?: string };
    if (!claudeAnswer) return res.status(400).json({ error: "claudeAnswer required" });
    const parsed = parseClaudePlan(claudeAnswer);
    const labour = parsed.tasks.map((t) => ({ ...t, labourPrompt: buildOpencodePrompt(t, contextRef ?? "see handoff bundle") }));
    res.json({ tasks: labour, count: labour.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Manager-employee team run: one Slack thread where models speak as staff.
// POST { bundle:{task, files[]}, taskHint?, system? } -> thread + route + answer + QA verdict.
app.post("/team/run", async (req, res) => {
  try {
    const { bundle, taskHint, system } = req.body as { bundle: HandoffBundle; taskHint?: string; system?: string };
    if (!bundle?.task) return res.status(400).json({ error: "bundle.task required" });
    res.json(await runTeamTask(bundle, { taskHint, system }));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Manual Slack ping (approvals, Jev verdicts). Models do not read Slack; humans do.
app.post("/notify/slack", async (req, res) => {
  try {
    const { text, threadTs } = req.body as { text: string; threadTs?: string };
    if (!text) return res.status(400).json({ error: "text required" });
    res.json(await notifySlack(text, { threadTs }));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── COMPANY CONTROL PLANE ─────────────────────────────────────────────

// Hands the shared secret to the local dashboard only. Guarded twice: the peer
// must be loopback AND the Host header must be a loopback name (a DNS-rebinding
// page presents its own hostname, never localhost). Off-host callers get 403.
app.get("/company/auth/bootstrap", (req, res) => {
  const peer = req.socket.remoteAddress;
  if (!isLoopbackAddress(peer) || !hostAllowed(req.headers.host, config.allowedHosts)) {
    return res.status(403).json({
      error: "forbidden",
      detail: "the control-plane secret is only issued to loopback clients",
    });
  }
  res.json({
    header: TOKEN_HEADER,
    token: config.authToken,
    tokenConfigured: Boolean(config.authToken),
    requiredFor: "all mutating /company/* requests and GET /company/stream",
  });
});

app.get("/company/org", (_req, res) => {
  res.json(loadOrg());
});

// Create a department on its own (PROJECT_TEAM_SPEC). `{name}` -> `{ok, department}`.
app.post("/company/departments", (req, res) => {
  const { name } = req.body as { name?: unknown };
  if (typeof name !== "string" || !name.trim()) return res.status(400).json({ error: "name required" });
  try {
    const department = createDepartment(name);
    res.json({ ok: true, department });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Seed a department + project with a default 7-role team. An optional `team`
// config (docs/PROJECT_TEAM_SPEC.md) sets the coder count and per-role model
// overrides and is persisted on the project. Shape is unchanged for existing
// callers; `ok` and `team` are additive.
app.post("/company/projects", async (req, res) => {
  try {
    const { companyName, departmentName, department, projectName, name, description, rootDir, coderCount, team } = req.body as {
      companyName?: string; departmentName?: string; department?: string; projectName?: string; name?: string;
      description?: string; rootDir?: string; coderCount?: number; team?: ProjectTeamConfig;
    };
    const checked = validateTeamConfig(team);
    if (!checked.ok) return res.status(400).json({ error: checked.error });
    const { project, department: dept } = createProject({
      companyName,
      departmentName: departmentName ?? department,
      projectName: projectName ?? name,
      description,
      rootDir,
      coderCount,
      team: checked.team,
    });
    res.json({ ok: true, project, department: dept });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Per-project team config (PROJECT_TEAM_SPEC): `{coders?, models?}` -> `{ok, project}`.
// `models` merges per role; `coders` replaces the count. Validation is the spec's:
// coders integer 1..6, unknown role or empty model id -> 400 {error}.
app.patch("/company/projects/:id/team", (req, res) => {
  const p = getProject(req.params.id);
  if (!p) return res.status(404).json({ error: "not found" });
  const checked = validateTeamConfig(req.body as unknown);
  if (!checked.ok) return res.status(400).json({ error: checked.error });
  try {
    const project = updateProjectTeam(req.params.id, checked.team);
    if (!project) return res.status(404).json({ error: "not found" });
    res.json({ ok: true, project });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/company/projects/:id", (req, res) => {
  const p = getProject(req.params.id);
  if (!p) return res.status(404).json({ error: "not found" });
  res.json(p);
});

// Gate 1: create a task (pending_intake).
app.post("/company/projects/:id/tasks", (req, res) => {
  const p = getProject(req.params.id);
  if (!p) return res.status(404).json({ error: "not found" });
  const { request } = req.body as { request?: string };
  if (!request) return res.status(400).json({ error: "request required" });
  res.json(createTask(p.id, request));
});

// Gates 1-3. Approving also resumes the task if its pipeline is not running
// (it parked at the gate, or the server restarted) - no more orphaned approvals.
for (const gate of ["intake", "code", "merge"] as const) {
  app.post(`/company/projects/:id/tasks/:tid/approve-${gate}`, (req, res) => {
    try {
      const t = approveGate(req.params.id, req.params.tid, gate);
      const resumed = resumeTask(req.params.id, req.params.tid);
      res.json({ ...t, resumed });
    } catch (e) { res.status(404).json({ error: String(e) }); }
  });
}

// The hand-off chain per task (CEO -> Assistant -> Laya -> Claude -> worker -> back).
app.get("/company/flow", (req, res) => {
  try { res.json(flowData(Number(req.query.limit ?? 25))); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get("/company/projects/:id/thread", (req, res) => {
  res.json(readThread(req.params.id, 200));
});

app.get("/company/projects/:id/cost", (req, res) => {
  res.json(readCost(req.params.id));
});

app.get("/company/projects/:id/tasks", (req, res) => {
  res.json(loadTasks(req.params.id));
});

app.post("/company/projects/:id/pause", (req, res) => {
  const p = getProject(req.params.id);
  if (!p) return res.status(404).json({ error: "not found" });
  p.status = "paused";
  const org = loadOrg();
  const i = org.projects.findIndex((x) => x.id === p.id);
  org.projects[i] = p;
  saveOrg(org);
  res.json(p);
});

app.post("/company/projects/:id/resume", (req, res) => {
  const p = getProject(req.params.id);
  if (!p) return res.status(404).json({ error: "not found" });
  p.status = "active";
  const org = loadOrg();
  const i = org.projects.findIndex((x) => x.id === p.id);
  org.projects[i] = p;
  saveOrg(org);
  res.json(p);
});

// Run the pipeline. If taskId provided, runs that existing task (created at Gate 1).
// Otherwise creates one. auto=true skips gates (autonomous mode).
app.post("/company/projects/:id/run", async (req, res) => {
  try {
    const { request, taskId, taskHint, auto } = req.body as { request?: string; taskId?: string; taskHint?: string; auto?: boolean };
    const blocked = refuseNewWork("POST /company/projects/:id/run");
    if (blocked) return res.status(503).json({ error: "company_paused", detail: blocked });
    const existing = taskId ? getTask(req.params.id, taskId) : undefined;
    if (!existing && !request) return res.status(400).json({ error: "request (or existing taskId) required" });
    // Resuming a failed task: clear the failure so the stages continue.
    if (existing?.status === "failed") updateTask(req.params.id, existing.id, { status: "pending_intake", error: undefined });
    const handle = await runPipeline(req.params.id, request ?? existing!.rawRequest, { taskId, taskHint, auto: auto ?? false });
    res.json(handle);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Full control-panel payload.
// `?lite=1` (PERF, docs/PERF_SPEC.md item 4, PERF-BACKEND): the trimmed payload
// that public/v2/views/projects.js already asks for - it drops the display-only
// sections (per-project thread/cost, the gate queue and output tails, and the
// nested copy of projects[] inside departments[]) and marks the answer
// `lite: true`. Anything else is the full payload, byte-for-byte as before.
app.get("/company/panel", (req, res) => {
  try {
    res.json(panelData({ lite: req.query.lite === "1" }));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── CEO DASHBOARD: sessions, budgets, agents, assistant ───────────────

// Live session board: which agent, in which department, on which task, right now.
app.get("/company/sessions", (_req, res) => {
  try {
    res.json({ ...sessionCounts(), items: listSessions(60) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/company/sessions/:id", (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: "not found" });
  if (req.query.tail === "1") {
    const tail = getSessionTail(req.params.id);
    return res.json({ ...s, tail });
  }
  res.json(s);
});

// Budgets: allocated vs spent vs remaining, per agent and per department.
// NOTE: these per-agent USD numbers are a virtual internal throttle
// (budget.ts DEFAULT_ALLOCATION_USD), NOT money and NOT a provider limit. The
// real constraints are the subscription quota windows at GET /company/budget.
app.get("/company/budgets", (_req, res) => {
  try {
    res.json({ ...budgetTotals(), byAgent: listBudgets(), byDepartment: budgetByDepartment() });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// BUDGET (docs/BUDGET_SPEC.md): the REAL remaining allowance per provider, the
// green/amber/red levels, the active rules and what they are doing right now.
// Reads the watcher's cached snapshot (company/budget/state.json) so the
// dashboard is never on the provider-CLI path. `?lite=1` returns only the few
// fields the top-bar chip needs (BUDGET's chip), so the bar stays cheap.
app.get("/company/budget", (req, res) => {
  try {
    const snapshot = readBudgetState();
    if (req.query.lite === "1") {
      const pick = (p?: { label: string; level: string; remainingPct?: number; resetsIn?: string; connected: boolean }) =>
        p ? { label: p.label, level: p.level, remainingPct: p.remainingPct, resetsIn: p.resetsIn, connected: p.connected } : null;
      res.json({
        checkedAt: snapshot?.checkedAt ?? null,
        levels: snapshot?.levels ?? null,
        providers: snapshot ? { go: pick(snapshot.providers.go), claude: pick(snapshot.providers.claude) } : null,
        needsYou: snapshot?.needsYou ?? null,
        running: budgetStatus().running,
      });
      return;
    }
    res.json({
      checkedAt: snapshot?.checkedAt ?? null,
      status: budgetStatus(),
      snapshot: snapshot ?? null,
      // REAL BUDGET (CEO order 2026-10-01): the provider limits + measured spend,
      // the same object GET /company/budget/real returns.
      real: realBudgetSync(),
      // DEEPSEEK DIRECT: can a fleet terminal run DeepSeek's own provider (cached, never
      // blocks), and which phase DeepSeek is billing in. Why the fleet skips a red-budget hold.
      fleetDirectReady: fleetDirectReadyCached(),
      directPhase: directPhase(),
      // The brain-routing numbers ride along with the budget: one poll, one page.
      brain: brainStats(),
      hint: snapshot ? undefined : "no budget poll yet: run npx tsx ops/budget-poll.ts (or wait for the watcher's first tick)",
      freshRequested: req.query.fresh === "1",
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Force one poll now (a write: guarded by the same token rule as other
// mutating /company/* routes). Used by the Budget page's Refresh button and by
// the manager before it spawns a fleet.
app.post("/company/budget/refresh", async (_req, res) => {
  try {
    const snapshot = await refreshBudgetState({ fresh: true });
    res.json({ checkedAt: snapshot.checkedAt, status: budgetStatus(), snapshot, real: await buildRealBudget({ fresh: true }) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// REAL BUDGET (CEO order 2026-10-01): the real numbers only — provider limits
// (OpenCode Go 5-hour/weekly/monthly windows, the DeepSeek credit balance and
// its off-peak/peak phase, the Claude subscription windows) plus the measured
// spend (today / 7 days / by provider / by model / by department) and a
// READ-ONLY per-agent "spent so far". No invented caps: `caps` is null and
// every number traces to a source; anything unmeasured says "not measured".
// Read-only GET, so the same loopback read rule as the other GET /company/*
// routes covers the dashboard. Each source is bounded (3 s) and cached
// (BUDGET_REAL_CACHE_MS, 30-60 s), so this never holds the router.
app.get("/company/budget/real", async (_req, res) => {
  try {
    res.json(await buildRealBudget());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ROUTING POLICY (CEO order 2026-10-02): read-only, loopback, no token, no model call. Shows
// the current direct-vs-Go decision for a sample standard + hard model, the Go binding window,
// the DeepSeek phase, key/cool-off state, and the in-memory counters (since boot + last 60 min).
app.get("/company/routing/policy", (_req, res) => {
  try {
    res.json(routingPolicyStatus());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// PROVIDER USAGE (docs/PROVIDER_USAGE.md): per-provider quota windows and
// measured spend, the constraint that actually stops work (the per-agent USD
// budgets above are a virtual throttle). `providerUsage()` queries the provider
// CLIs (`jcode usage --json --no-update`, `claude auth status`, `opencode auth
// list`) and masks emails/ids/tokens before anything is returned here; where a
// provider exposes nothing, the row comes back `source: "unavailable"` with the
// reason. `measuredByModel` is our own cost.jsonl ledger. This is a read-only
// GET, so the loopback read exemption in companyGuard covers the dashboard.
app.get("/company/provider-usage", async (_req, res) => {
  try {
    res.json({ capturedAt: new Date().toISOString(), providers: await providerUsage(), measuredByModel: measuredSpendByModel() });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ADAPTIVE ROUTING (docs/perf/ADAPTIVE_ROUTING.md): the Laya adaptive routing layer
// (Kafka topic + online success estimator + rule engine), read-only. With
// ADAPTIVE_ROUTING unset this answers `enabled:false` with zeroed stats and never
// starts the bus, the timers or anything on disk. Loopback read exemption applies.
app.get("/company/adaptive", (_req, res) => {
  try {
    res.json(getAdaptive().snapshot());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Same data as Prometheus text for scraping.
app.get("/company/adaptive/metrics", (_req, res) => {
  try {
    res.type("text/plain; version=0.0.4").send(getAdaptive().metrics());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// The roster: every agent in every project, plus the CEO assistant.
app.get("/company/agents", (_req, res) => {
  try {
    res.json(listAgentsFlat());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/company/agents/:agentId", (req, res) => {
  const a = findAgent(req.params.agentId);
  if (!a) return res.status(404).json({ error: "unknown agent" });
  res.json(a);
});

app.get("/company/agents/:agentId/budget", (req, res) => {
  const b = getBudget(req.params.agentId);
  if (!b) return res.status(404).json({ error: "unknown agent budget" });
  res.json(b);
});

// Give an agent a new budget for its job.
// CEO order 2026-10-01: per-agent quotas are GONE, so this is a compatibility
// shim. It still answers 200 with the agent's (cap-free) row instead of a 404,
// and it no longer writes anything: `allocatedUsd` is ignored.
app.post("/company/agents/:agentId/budget", (req, res) => {
  const raw = (req.body as { allocatedUsd?: unknown }).allocatedUsd;
  const allocatedUsd = typeof raw === "string" ? Number(raw) : raw;
  if (typeof allocatedUsd !== "number" || !Number.isFinite(allocatedUsd) || allocatedUsd < 0) {
    return res.status(400).json({ error: "allocatedUsd (number >= 0) required" });
  }
  const updated = setAllocation(req.params.agentId, allocatedUsd);
  if (!updated) return res.status(404).json({ error: "unknown agent" });
  res.json({ ...updated, capsRemoved: true, note: "per-agent quotas were removed on 2026-10-01; allocatedUsd is ignored (caps are null)." });
});

// Talk to one agent: read its thread, send it a message, get the reply.
app.get("/company/agents/:agentId/thread", (req, res) => {
  const limit = Number(req.query.limit ?? 100) || 100;
  try {
    res.json({ agentId: req.params.agentId, messages: agentThread(req.params.agentId, limit) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/company/agents/:agentId/message", async (req, res) => {
  const { text, run, force } = req.body as { text?: string; run?: boolean; force?: boolean };
  if (!text || !text.trim()) return res.status(400).json({ error: "text required" });
  try {
    const out = await messageAgent(req.params.agentId, text, { run, force });
    if (out.error === "unknown agent") return res.status(404).json(out);
    // CEO order 2026-10-01: no 402 for a per-agent cap. Agents have no quotas,
    // so a message is never refused for budget (provider pressure is handled by
    // budgetGuard.ts elsewhere).
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── ATTACH: the CEO's file attachments (docs/AGENT_COORDINATION.md, 2026-09-29) ──
// One route. The body IS the file (raw bytes, one file per request), which is why no
// multipart parser is needed: express.raw is already part of this router and the
// browser's fetch can post a File directly. The browser sends the name in
// x-file-name (URI-encoded, headers cannot carry arbitrary bytes); the TYPE is
// decided by magic bytes inside src/company/uploads.ts, never by that name or by the
// request's content-type, and the stored name is generated there too. Mutating, so
// companyGuard above already demands X-Company-Token and refuses off-host peers.
// A PDF/PNG/JPG/WEBP can legitimately be large, hence the route-level limit
// (MAX_UPLOAD_BYTES + a megabyte of slack) instead of the global 5 MB JSON limit.
app.post(
  "/company/uploads",
  express.raw({ type: () => true, limit: `${Math.ceil(MAX_UPLOAD_BYTES / (1024 * 1024)) + 1}mb` }),
  (req, res) => {
    const rawName = String(req.header("x-file-name") ?? req.query.name ?? "attachment");
    let name = rawName;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      /* not URI-encoded: use it as sent, saveUpload sanitises it either way */
    }
    const out = saveUpload({ name, bytes: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0) });
    if (!out.ok) return res.status(out.status).json({ error: out.error, detail: out.detail });
    res.json(out.upload);
  },
);

// The CEO's assistant: instruction in, decomposition + dispatch out.
app.post("/company/assistant/message", async (req, res) => {
  // ATTACH: `attachments` is the list of upload ids the paperclip produced (see
  // POST /company/uploads above); they are resolved to file paths here.
  const { text, autoRun, attachments, voice } = req.body as {
    text?: string;
    autoRun?: boolean;
    attachments?: unknown;
    voice?: boolean;
  };
  // JOEY-WIRE: per-browser voice toggle. The browser sends its preference with every message.
  if (typeof voice === "boolean") setAssistantVoiceEnabled(voice);
  if (!text || !text.trim()) return res.status(400).json({ error: "text required" });
  const blocked = refuseNewWork("POST /company/assistant/message");
  if (blocked) return res.status(503).json({ error: "company_paused", detail: blocked });
  try {
    res.json(await assistantMessage(text, { autoRun, attachments }));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── VOICE-ROUTE (docs/VOICE_STT_SPEC.md §2, docs/AGENT_COORDINATION.md 2026-09-30) ──
// Spoken orders hit the same assistantMessage path as typed text. The body is raw
// audio bytes (any audio/* or application/octet-stream), parsed here so the global
// express.json() middleware does not try to read it.
const STT_URL = process.env.STT_URL ?? "http://127.0.0.1:8902/stt/transcribe";
// One wording for "the STT service is not there", used by the voice route's 502
// and by the health probe below, so the page and curl never disagree.
const STT_DOWN_MESSAGE =
  "Speech-to-text server (127.0.0.1:8902) is not reachable. Start it: schtasks /run /tn LayaCompanySttServer";

// JOEY-WIRE: GET/POST voice toggle. GET returns the current flag; POST with JSON
// {enabled:boolean} sets it. The same path also accepts raw audio for STT below.
app.get("/company/assistant/voice", (req, res) => {
  res.json({ ok: true, enabled: getAssistantVoiceEnabled() });
});

app.post(
  "/company/assistant/voice",
  express.raw({ type: () => true, limit: "25mb" }),
  async (req, res) => {
    // JOEY-WIRE: JSON toggle request? express.json() may already have parsed it,
    // or express.raw() left it as a Buffer; accept both.
    let toggleBody: Record<string, unknown> | undefined;
    if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) && typeof (req.body as Record<string, unknown>).enabled === "boolean") {
      toggleBody = req.body as Record<string, unknown>;
    } else if (Buffer.isBuffer(req.body) && req.body.length > 0 && req.body[0] === 0x7b /* { */) {
      try {
        toggleBody = JSON.parse(req.body.toString("utf8")) as Record<string, unknown>;
      } catch {
        // not JSON: fall through to audio path
      }
    }
    if (toggleBody && typeof toggleBody.enabled === "boolean") {
      setAssistantVoiceEnabled(toggleBody.enabled);
      return res.json({ ok: true, enabled: toggleBody.enabled });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ ok: false, error: "audio required" });
    }
    const blocked = refuseNewWork("POST /company/assistant/voice");
    if (blocked) return res.status(503).json({ ok: false, error: "company_paused", detail: blocked });

    let sttMs = 0;
    let transcript = "";
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      const sttRes = await fetch(STT_URL, {
        method: "POST",
        headers: { "content-type": String(req.header("content-type") || "application/octet-stream") },
        body: new Uint8Array(req.body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const sttJson = (await sttRes.json().catch(() => ({}))) as Record<string, unknown>;
      if (!sttRes.ok || sttJson.ok !== true) {
        return res.status(502).json({
          ok: false,
          error: "stt_unavailable",
          message: STT_DOWN_MESSAGE,
          detail: typeof sttJson.detail === "string" ? sttJson.detail : `HTTP ${sttRes.status}`,
        });
      }
      transcript = typeof sttJson.text === "string" ? sttJson.text.trim() : "";
      sttMs = typeof sttJson.ms === "number" ? sttJson.ms : 0;
    } catch (e) {
      return res.status(502).json({
        ok: false,
        error: "stt_unavailable",
        message: STT_DOWN_MESSAGE,
        detail: e instanceof Error ? e.message : String(e),
      });
    }

    const words = transcript
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .split(/\s+/)
      .filter(Boolean);
    if (words.length < 2) {
      return res.status(200).json({ ok: false, error: "didnt_catch", message: "Didn't catch that", transcript });
    }

    const autoRun = req.query.autoRun === "true" ? true : req.query.autoRun === "false" ? false : undefined;
    try {
      const result = await assistantMessage(transcript, { autoRun, spoken: true });
      // tasks: id:title derived from result.dispatched (the thread entry only stores ids).
      const tasks = result.dispatched.map((d) => `${d.taskId}: ${d.title}`);
      res.json({ ok: true, transcript, spoken: true, sttMs, ...result, tasks });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  },
);

// ── VOICE-ROUTE: STT health probe (work order fomunicug6/WO1) ──────────────
// The Assistant page asks this before it offers hold-to-talk, so a speech-to-text
// service that is down is visible on the page instead of failing silently on
// release. Shape mirrors the STT service's own GET /stt/health
// (docs/VOICE_STT_SPEC.md §1) so there is one health vocabulary in the system.
//
// Deliberate choices:
//   - GET, so the loopback read exemption in companyGuard above covers the
//     dashboard (no token needed, exactly like GET /company/assistant/thread).
//   - Always 200. The page must tell "the STT service is down" (ok:false) apart
//     from "the router is unreachable" (the fetch itself throws); only the
//     former may disable the mic, so a probe that cannot be answered must not
//     look like an STT outage.
//   - Short timeout (1.5 s default): this is polled, it must never hang.
//   - No cache headers needed: the client asks with {ttl:0} so it never reads a
//     stale answer.
const STT_HEALTH_URL =
  process.env.STT_HEALTH_URL ?? STT_URL.replace(/\/stt\/transcribe\/?$/, "/stt/health");
const STT_HEALTH_TIMEOUT_MS = Number(process.env.STT_HEALTH_TIMEOUT_MS ?? 1500) || 1500;

app.get("/company/assistant/stt/health", async (_req, res) => {
  const down = (detail: unknown) =>
    res.json({ ok: false, error: "stt_unavailable", message: STT_DOWN_MESSAGE, detail: String(detail) });
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STT_HEALTH_TIMEOUT_MS);
    let probe: Response;
    try {
      probe = await fetch(STT_HEALTH_URL, { method: "GET", signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    const body = (await probe.json().catch(() => ({}))) as Record<string, unknown>;
    if (!probe.ok) return down(`HTTP ${probe.status}`);
    if (body.ok !== true) return down("health endpoint did not report ok:true");
    res.json({
      ok: true,
      model: typeof body.model === "string" ? body.model : undefined,
      device: typeof body.device === "string" ? body.device : undefined,
      compute_type: typeof body.compute_type === "string" ? body.compute_type : undefined,
      warm: body.warm === true,
      uptime_s: typeof body.uptime_s === "number" ? body.uptime_s : undefined,
      url: STT_HEALTH_URL,
    });
  } catch (e) {
    const err = e as { name?: string; message?: string; cause?: { code?: string } };
    const why = err?.name === "AbortError" ? `no answer in ${STT_HEALTH_TIMEOUT_MS} ms` : err?.cause?.code ?? err?.message ?? "error";
    down(why);
  }
});

// ── COMPANION: "is the assistant talking out loud right now?" (work order fomunyphtc/WO1) ──
// The Assistant page's companion animates ONLY while this says speaking:true, so the
// on-screen dog and the machine's own speaker can never disagree. The truth lives in
// the TTS server (tools/tts/server.mjs reports lastPlayback.playing on GET /tts/health),
// and the page cannot read :8901 itself: that server answers the preflight with 404 and
// sends no Access-Control-Allow-Origin, so a browser fetch from the dashboard is blocked.
// This route is the loopback read that hands the page the one field it needs.
//
// Deliberate choices, mirroring the STT health probe above:
//   - GET, so the loopback read exemption in companyGuard covers the dashboard.
//   - Always 200: {ok:false} means "the TTS server did not answer", which the page must
//     be able to tell apart from a 404 ("this router predates the route"). On a 404 the
//     page falls back to its own local speech estimate, so nothing here is load-bearing
//     until the next supervised router restart.
//   - Short timeout: the page polls this about once a second while the view is open.
const TTS_HEALTH_URL =
  process.env.TTS_HEALTH_URL ?? `http://127.0.0.1:${process.env.TTS_PORT ?? "8901"}/tts/health`;
const TTS_HEALTH_TIMEOUT_MS = Number(process.env.TTS_HEALTH_TIMEOUT_MS ?? 1500) || 1500;

app.get("/company/assistant/speech", async (_req, res) => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TTS_HEALTH_TIMEOUT_MS);
    let probe: Response;
    try {
      probe = await fetch(TTS_HEALTH_URL, { method: "GET", signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    const body = (await probe.json().catch(() => ({}))) as Record<string, unknown>;
    const last = (body && typeof body.lastPlayback === "object" ? body.lastPlayback : null) as
      | Record<string, unknown>
      | null;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    res.json({
      ok: probe.ok && body.ok === true,
      // The one field the companion needs: the speaker is playing right now.
      speaking: last ? last.playing === true : false,
      engine: typeof body.engine === "string" ? body.engine : undefined,
      ready: body.ready === true,
      startedAt: last ? num(last.startedAt) : undefined,
      finishedAt: last ? num(last.finishedAt) : undefined,
      checkedAt: Date.now(),
      url: TTS_HEALTH_URL,
    });
  } catch (e) {
    const err = e as { name?: string; message?: string; cause?: { code?: string } };
    const why =
      err?.name === "AbortError" ? `no answer in ${TTS_HEALTH_TIMEOUT_MS} ms` : err?.cause?.code ?? err?.message ?? "error";
    res.json({ ok: false, speaking: false, error: "tts_unavailable", detail: String(why), url: TTS_HEALTH_URL });
  }
});

app.get("/company/assistant/thread", (req, res) => {
  const limit = Number(req.query.limit ?? 100) || 100;
  try {
    res.json({ status: assistantStatus(), messages: assistantThread(limit) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── COMPANY MEMORY (docs/MEMORY_SPEC.md) ──────────────────────────────
// One memory for the whole company, stored under company/memory/ and indexed by
// graphify (company/memory/graphify-out/graph.json). These are the only routes the
// MEMORY session owns here; the guard above already makes reads loopback-exempt and
// requires X-Company-Token for the mutations.
app.get("/company/memory/recall", (req, res) => {
  const q = String(req.query.q ?? "");
  const limit = Number(req.query.limit ?? 8) || 8;
  const projects = String(req.query.projects ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  try {
    const t0 = Date.now();
    const hits = recall(q, { limit, projects });
    res.json({ q, count: hits.length, ms: Date.now() - t0, hits });
  } catch (e) {
    res.status(500).json({ q, count: 0, hits: [], error: String(e) });
  }
});

app.get("/company/memory/notes", (req, res) => {
  try {
    const notes = listNotes({
      type: req.query.type ? String(req.query.type) : undefined,
      q: req.query.q ? String(req.query.q) : undefined,
      limit: Number(req.query.limit ?? 200) || 200,
    });
    res.json({ count: notes.length, notes });
  } catch (e) {
    res.status(500).json({ count: 0, notes: [], error: String(e) });
  }
});

app.get("/company/memory/notes/:id", (req, res) => {
  try {
    const note = getNote(req.params.id);
    if (!note) return res.status(404).json({ error: "not found", id: req.params.id });
    res.json(note);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Write or update a note. Re-remembering the same subject updates it in place, so
// callers (assistant, reporting, autoclose) can fire and forget.
app.post("/company/memory/notes", (req, res) => {
  const { type, title, body, source, projects, tags, id, folder } = req.body as {
    type?: string; title?: string; body?: string; source?: string;
    projects?: string[]; tags?: string[]; id?: string; folder?: string;
  };
  if (!body && !title) return res.status(400).json({ error: "title or body required" });
  try {
    const out = remember({
      type: type ?? "reference",
      title: title ?? "",
      body: body ?? "",
      source: source ?? "api",
      projects,
      tags,
      id,
      folder,
    });
    res.json({ ...out, note: getNote(out.id) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Rebuild the graphify graph over the notes + this repo + every project rootDir.
// Debounced: pass force=true (or ?force=1) to ignore MEMORY_REBUILD_MIN_S.
app.post("/company/memory/rebuild", async (req, res) => {
  try {
    const force = (req.body as { force?: boolean })?.force === true || req.query.force === "1";
    res.json(await rebuildGraph({ force }));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/company/memory/status", (_req, res) => {
  try {
    res.json(memoryStatus());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── CEO BRIEFING + RUN CARDS (docs/REPORTING_SPEC.md sections 1-2) ─────
// The one page the CEO reads: what needs them, what finished since they last looked,
// what is in progress, what broke. Reads are loopback-exempt like the other GETs;
// the two POSTs need X-Company-Token. GET never calls a model and never blocks: the
// page shape is composed locally from the run cards, and the summary sentence comes
// from the last generation (the watcher / POST refresh regenerate it when a card
// changed). Cards live in company/reports/runs/<runId>.json.
app.get("/company/briefing", (_req, res) => {
  try { res.json(getBriefing()); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

// Force a regeneration: manager-check the runs now, then rebuild the page + summary.
app.post("/company/briefing/refresh", async (_req, res) => {
  try { res.json(await refreshBriefing({ force: true })); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

// The CEO opened the page: "done since last time" restarts from now.
app.post("/company/briefing/seen", (_req, res) => {
  try { res.json(markBriefingSeen()); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

// Every run card, newest activity first (manager-checked cards plus free local
// placeholders for runs the manager has not reached yet).
app.get("/company/runs", (_req, res) => {
  try {
    const cards = listRunCards();
    res.json({ cards, counts: runCounts(cards), manager: runManagerStatus() });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// One card plus its history (every checked/changed card is appended to runs.jsonl).
app.get("/company/runs/:runId", (req, res) => {
  try {
    const found = getRunCard(req.params.runId);
    if (!found) return res.status(404).json({ error: "not found", runId: req.params.runId });
    res.json(found);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get("/company/briefing/status", (_req, res) => {
  try { res.json(briefingStatus()); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get("/company/airgap", (_req, res) => {
  try {
    res.json({ status: airGapStatus(), held: heldQueue() });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Live dashboard feed (SSE). Polling /company/panel works too; this is for
// browsers that want push without hammering the endpoint.
//
// PERF (n3-panel-org, 2026-09-30): this used to re-serialise the WHOLE payload
// (224 KB on the live data) and push it to every client every 2 s, changed or
// not - measured on an isolated router over a copy of the live company data, one
// idle client received 6 frames / 1.35 MB in 12 s (6.7 MB/min). The tick now asks
// panelState() FIRST: while the memoised payload is still authoritative it returns
// the signature that payload was built from, so a tick where no file the panel
// reads has changed costs the stat() set and nothing else - no rebuild, no
// serialise, no write. Only a genuinely changed state (signature differs, or the
// TTL lapsed so there is no built-from signature) falls through to panelData(),
// which rebuilds once and produces a NEW object; object identity is therefore a
// sound "did anything change?" test on that path and needs no serialise either.
// A comment heartbeat (EventSource ignores a `:` line, proxies see traffic) keeps
// an idle connection open.
const STREAM_TICK_MS = 2000;
const STREAM_HEARTBEAT_MS = 15000;

app.get("/company/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  let closed = false;
  let lastSent: PanelPayload | null = null;
  let lastSig = "";
  let lastWriteAt = Date.now();
  const send = (force = false) => {
    if (closed) return;
    try {
      const state = panelState();
      if (!force && state.locked && state.sig === lastSig) {
        if (Date.now() - lastWriteAt >= STREAM_HEARTBEAT_MS) {
          lastWriteAt = Date.now();
          res.write(": heartbeat\n\n");
        }
        return;
      }
      const data = panelData();
      if (!force && data === lastSent) return;
      lastSent = data;
      lastSig = state.sig || panelRevision();
      lastWriteAt = Date.now();
      res.write(`event: panel\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
      try { res.write(`event: error\ndata: ${JSON.stringify({ error: String(e) })}\n\n`); } catch { /* client gone */ }
    }
  };
  send(true);
  const timer = setInterval(send, STREAM_TICK_MS);
  req.on("close", () => {
    closed = true;
    clearInterval(timer);
    if (!res.writableEnded) res.end();
  });
});

// ── CEO INBOX (docs/INBOX_SPEC.md; owner: session INBOX) ───────────────
// Every "Needs you" item is answerable in place: approvals get Approve/Reject, questions
// get a reply, and the answer is delivered straight back to whoever asked (the gate, the
// fleet order, the terminal session, the assistant, the budget guard). Listing reconciles
// the inbox with the live state first, so a gate that was approved elsewhere expires by
// itself instead of sitting on the page. See src/company/inbox.ts.
app.get("/company/inbox", (req, res) => {
  try {
    reconcileInbox();
    const status = req.query.status ? String(req.query.status) : "open";
    const limit = Number(req.query.limit ?? 100);
    const { items, counts } = listInbox({ status, limit: Number.isFinite(limit) ? limit : 100 });
    res.json({ status, counts, items });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/company/inbox/status", (_req, res) => {
  try { res.json(inboxStatus()); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

// Push an item (the same call a source module makes: askCeo). This exists so a session
// whose own file we do not share (REPORTING, a worker) can add an item without importing
// the module, and so an item can be created by hand for a test.
app.post("/company/inbox/ask", (req, res) => {
  try {
    const body = req.body as {
      kind?: "approval" | "question" | "choice"; title?: string; question?: string; options?: string[];
      context?: string; source?: { type?: string; id?: string; projectId?: string; sessionId?: string; gate?: "intake" | "code" | "merge"; wid?: string };
    };
    const src = body.source;
    if (!src?.type || !src?.id) return res.status(400).json({ error: "source.type and source.id are required" });
    if (!body.question) return res.status(400).json({ error: "question is required" });
    const item = askCeo({
      kind: body.kind ?? "question",
      title: body.title ?? body.question,
      question: body.question,
      ...(body.options ? { options: body.options } : {}),
      ...(body.context ? { context: body.context } : {}),
      source: {
        type: src.type as "task-gate" | "fleet-plan" | "fleet-redo" | "terminal" | "assistant" | "budget" | "run-card",
        id: src.id,
        ...(src.projectId ? { projectId: src.projectId } : {}),
        ...(src.sessionId ? { sessionId: src.sessionId } : {}),
        ...(src.gate ? { gate: src.gate } : {}),
        ...(src.wid ? { wid: src.wid } : {}),
      },
    });
    // One open item per source: this returns the existing one when there already is
    // one, so a source can call it on every tick without flooding the page.
    res.json({ item });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// Force a reconcile (the GET does it on a throttle; this ignores the throttle).
app.post("/company/inbox/sync", (_req, res) => {
  try { res.json(reconcileInbox({ force: true })); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

// Correct the wording of an open item (REPORTING: the exact question from a journal).
app.post("/company/inbox/:id/reword", (req, res) => {
  try {
    const { title, question, context, options } = req.body as { title?: string; question?: string; context?: string; options?: string[] };
    const item = rewordInbox(req.params.id, { title, question, context, options });
    if (!item) return res.status(404).json({ error: "not found" });
    res.json(item);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// The answer. First answer wins (a second one gets 409 with the item, so the UI can show
// "answered via X"). Delivery may still be "pending" when this returns: the fast paths
// (gate / fleet / budget) are waited for, a busy terminal's confirmation is not.
app.post("/company/inbox/:id/answer", async (req, res) => {
  try {
    const { decision, text, option, via, autoRun } = req.body as {
      decision?: "approve" | "reject"; text?: string; option?: string; via?: "dashboard" | "slack"; autoRun?: boolean;
    };
    const out = await answerInbox(req.params.id, {
      ...(decision ? { decision } : {}),
      ...(text ? { text } : {}),
      ...(option ? { option } : {}),
      ...(typeof autoRun === "boolean" ? { autoRun } : {}),
      via: via === "slack" ? "slack" : "dashboard",
    });
    if (!out.ok) {
      return res.status(out.status === 404 ? 404 : out.status === 409 ? 409 : 400).json({
        error: out.error ?? "could not answer",
        item: out.item ?? null,
      });
    }
    res.json({ ok: true, item: out.item, delivery: out.delivery });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Slack replies in an item's thread answer the item (rose's slackInbound.ts calls the
// same function; this route makes the hook testable and usable from anywhere local).
app.post("/company/inbox/slack-reply", async (req, res) => {
  try {
    const { threadTs, text, user, itemId } = req.body as { threadTs?: string; text?: string; user?: string; itemId?: string };
    if (!text) return res.status(400).json({ error: "text required" });
    const out = await answerInboxFromSlack({ threadTs, text, user, itemId });
    res.status(out.ok ? 200 : 400).json(out);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── FLEET: "Claude manages, jcode executes" (docs/FLEET_SPEC.md) ───────
// One CEO order -> Claude splits it into parallel work orders -> the CEO approves
// -> one VISIBLE jcode terminal per work order, watched by the fleet watcher.
// Mutating routes need X-Company-Token like every other /company/* write.
app.post("/company/fleet/orders", async (req, res) => {
  try {
    const { text, autoApprove } = req.body as { text?: string; autoApprove?: boolean };
    if (!text || !text.trim()) return res.status(400).json({ error: "text required" });
    const blocked = refuseNewWork("POST /company/fleet/orders");
    if (blocked) return res.status(503).json({ error: "company_paused", detail: blocked });
    res.json(await createFleetOrder(text, { autoApprove }));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get("/company/fleet", (_req, res) => {
  try { res.json(fleetOrdersData()); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get("/company/fleet/orders/:id", (req, res) => {
  try {
    const order = fleetOrderDetail(req.params.id);
    if (!order) return res.status(404).json({ error: "not found" });
    res.json(order);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Approve the plan (optionally with the CEO's edits) and spawn the workers.
app.post("/company/fleet/orders/:id/approve", async (req, res) => {
  try {
    const { workOrders } = req.body as { workOrders?: ApproveOptions["workOrders"] };
    res.json(await approveFleetOrder(req.params.id, { workOrders }));
  } catch (e) { res.status(400).json({ error: String(e) }); }
});

// A REDO verdict: fresh session, same brief plus Claude's review notes.
app.post("/company/fleet/orders/:id/work/:wid/redo", async (req, res) => {
  try { res.json(await redoWorkOrder(req.params.id, req.params.wid)); }
  catch (e) { res.status(400).json({ error: String(e) }); }
});

// F34: retry the draft-PR publish for a PASSed work order whose PR step failed (never force-pushes).
app.post("/company/fleet/orders/:id/work/:wid/publish", async (req, res) => {
  try {
    const out = await republishWorkOrder(req.params.id, req.params.wid);
    if (!out.ok && out.notFound) return res.status(404).json({ error: "not found", detail: out.reason });
    res.json(out);
  } catch (e) { res.status(400).json({ error: String(e) }); }
});

// Stop spawning queued work. Running terminals are NOT killed (the CEO closes them).
app.post("/company/fleet/orders/:id/cancel", (req, res) => {
  try { res.json(cancelFleetOrder(req.params.id)); }
  catch (e) { res.status(400).json({ error: String(e) }); }
});

// ── "NEEDS YOU" RESOLVER (docs/NEEDS_YOU_SPEC.md section 6) ─────────────
// GET returns the current list; POST resolves one item. The /api routes are the
// canonical surface, /company aliases are kept for backward-compatible dashboards.
function needsYouResolveHandler(prefix: string) {
  return async (req: express.Request, res: express.Response) => {
    try {
      const itemId = decodeURIComponent(req.params.itemId);
      const body = req.body as { actionId?: unknown; input?: unknown };
      const actionId = typeof body.actionId === "string" ? body.actionId : "";
      const input =
        body.input && typeof body.input === "object" && !Array.isArray(body.input)
          ? (body.input as Record<string, string>)
          : undefined;

      if (!actionId) {
        return res.status(400).json({ ok: false, message: "actionId is required", itemId, actionId: "" });
      }

      // A stale or unknown item must return 404 before we log a decision.
      const current = openNeedsYouItems();
      if (!current.some((n) => n.id === itemId)) {
        return res.status(404).json({ ok: false, message: "That item is no longer waiting on you (it may already be handled). Refresh the list.", itemId, actionId });
      }

      const result = await resolveNeedsYou(itemId, actionId, input, "ceo");
      if (!result.ok) {
        // Action failure stays 200 with ok:false; only stale/unknown is 404 above.
        return res.json(result);
      }
      return res.json(result);
    } catch (e) {
      // Never let this route crash the router.
      console.error(`[needs-you] ${prefix} resolve error: ${String(e)}`);
      return res.status(500).json({ ok: false, message: "Something went wrong handling that choice.", itemId: req.params.itemId, actionId: "" });
    }
  };
}

function needsYouListHandler(_req: express.Request, res: express.Response) {
  try {
    res.json({ needsYou: openNeedsYouItems() });
  } catch (e) {
    console.error(`[needs-you] list error: ${String(e)}`);
    res.status(500).json({ ok: false, message: "Could not read the needs-you list." });
  }
}

app.get("/api/needs-you", needsYouListHandler);
app.post("/api/needs-you/:itemId/resolve", needsYouResolveHandler("/api"));
app.post("/company/needs-you/:itemId/resolve", needsYouResolveHandler("/company"));

// ── MANAGER QUEUE (CEO APPROVAL POLICY, 2026-09-30) ─────────────────────
// What the CEO is NOT asked about: routine retry/drop decisions for failed or
// stale orders and tasks. GET lists the queue (what the manager has to decide);
// POST /tick runs one decision pass now instead of waiting for the watcher.
app.get("/api/manager-queue", (_req: express.Request, res: express.Response) => {
  try {
    res.json(managerQueueSummary());
  } catch (e) {
    console.error(`[manager-queue] list error: ${String(e)}`);
    res.status(500).json({ ok: false, message: "Could not read the manager queue." });
  }
});

app.post("/api/manager-queue/tick", async (_req: express.Request, res: express.Response) => {
  try {
    const tick = await managerQueueTick();
    res.json({ ok: tick.ok, tick, queue: managerQueueSummary() });
  } catch (e) {
    console.error(`[manager-queue] tick error: ${String(e)}`);
    res.status(500).json({ ok: false, message: "The manager-queue tick failed." });
  }
});

// ── LIVE TERMINALS (see and talk to them; docs/TERMINALS_SPEC.md) ──────
// Every jcode session alive today (plus anything closed in the last 2h), what it is
// for and what it is doing, its last ~60 readable journal lines, and one way to talk
// INTO it: `jcode transcript --mode send -S <sessionId>` (targeted; never focus-based,
// because a focus-based send can land in the wrong terminal).
// ORDER MATTERS: /company/terminals/live is registered BEFORE /company/terminals/:sessionId
// below, so "live" is never captured as a session id.
app.get("/company/terminals/live", async (_req, res) => {
  try { res.json(await listLiveTerminals()); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get("/company/terminals/:sessionId/tail", (req, res) => {
  try {
    const lines = Number(req.query.lines);
    res.json(terminalTail(req.params.sessionId, Number.isFinite(lines) ? lines : 60));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post("/company/terminals/:sessionId/message", async (req, res) => {
  try {
    const { text } = req.body as { text?: string };
    const out = await sendTerminalMessage(req.params.sessionId, text);
    res.status(out.ok ? 200 : out.status || 400).json(out);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── FINISHED TERMINALS (auto-close; docs/AUTOCLOSE_SPEC.md) ────────────
// The registry company/terminals.json is the ALLOW-LIST: a window is only ever
// closed if it is registered with spawnedBy "fleet" or "claude-code", has a
// manager PASS verdict, is past AUTOCLOSE_GRACE_S with the session idle, and its
// pid still verifies (same creation time + the session's live client inside it).
// The CEO's own window (rose), the jcode server and the router are never touched.
app.get("/company/terminals", (_req, res) => {
  try {
    const terminals = listTerminals();
    res.json({
      reaper: reaperStatus(),
      counts: {
        total: terminals.length,
        open: terminals.filter((t) => t.state !== "closed").length,
        closed: terminals.filter((t) => t.state === "closed").length,
        streaming: terminals.filter((t) => t.streaming).length,
      },
      terminals,
    });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get("/company/terminals/:sessionId", (req, res) => {
  try {
    const rec = getTerminal(req.params.sessionId);
    if (!rec) return res.status(404).json({ error: "not found" });
    res.json({ terminal: listTerminals().find((t) => t.sessionId === rec.sessionId) ?? rec, reaper: reaperStatus() });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// "Keep this one open" (the UI can set it; it overrides a PASS verdict).
app.post("/company/terminals/:sessionId/keep-open", (req, res) => {
  try {
    const { keepOpen } = req.body as { keepOpen?: boolean };
    const rec = setKeepOpen(req.params.sessionId, keepOpen ?? true);
    if (!rec) return res.status(404).json({ error: "not found" });
    res.json(rec);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// The manager's verdict for a terminal (same PASS/REDO/FAIL the Fleet review uses).
app.post("/company/terminals/:sessionId/verdict", (req, res) => {
  try {
    const { verdict, reason } = req.body as { verdict?: string; reason?: string };
    if (verdict !== "PASS" && verdict !== "REDO" && verdict !== "FAIL") {
      return res.status(400).json({ error: 'verdict must be "PASS", "REDO" or "FAIL"' });
    }
    const rec = recordVerdict(req.params.sessionId, { verdict, reason, source: "POST /company/terminals/:sessionId/verdict" });
    if (!rec) return res.status(404).json({ error: "not found" });
    res.json(rec);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// One reaper pass on demand. Dry by default so an accidental call cannot close
// anything; pass {"dryRun": false} to actually close.
app.post("/company/terminals/reap", (req, res) => {
  try {
    const { dryRun } = req.body as { dryRun?: boolean };
    res.json(runReaperPass({ dryRun: dryRun ?? true }));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── GUARDED WORKERS (headless; WORKERS-LIVE, 2026-10-06) ───────────────
// Read-only, loopback-exempt like every other GET here. /company/workers returns
// { live, recent }; the tail route returns 400 for a bad name and 404 when there
// is no log for that worker. Nothing here starts, stops or signals a process.
app.get("/company/workers", (_req, res) => {
  try { res.json(listWorkers()); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get("/company/workers/:name/tail", (req, res) => {
  try {
    const lines = Number(req.query.lines);
    const out = workerTail(req.params.name, Number.isFinite(lines) ? lines : 40);
    if (out.error) return res.status(404).json({ error: out.error });
    res.json(out);
  } catch (e) {
    const m = String(e);
    if (m.includes("invalid worker name")) return res.status(400).json({ error: "invalid worker name" });
    res.status(500).json({ error: m });
  }
});

// ── SYSTEM: shut down everything / start everything again (docs/SHUTDOWN_SPEC.md) ────
// The CEO's button. Reads are loopback-exempt like every other GET here; the mutations
// (snapshot, shutdown, resume) go through the same companyGuard secret as all writes.
// The KILLING never happens in this process: POST /company/system/shutdown writes the
// snapshot, spawns the detached ops/shutdown-all.ps1 and answers 202 immediately, because
// that script stops this router LAST.
app.get("/company/system/status", async (_req, res) => {
  try { res.json(await systemStatus()); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

// What the confirm dialog lists: every terminal the shutdown would close, each one
// re-verified from a fresh process table (AUTOCLOSE's own verifyWindow rules).
app.get("/company/system/close-plan", async (_req, res) => {
  try { res.json(await closePlan()); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get("/company/system/snapshots", (req, res) => {
  try {
    const limit = Number(req.query.limit ?? 20) || 20;
    res.json({ snapshots: listSnapshots(limit), knobs: lifecycleKnobs(), resume: resumeJobStatus() });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get("/company/system/snapshots/:ts", (req, res) => {
  try {
    const snap = readSnapshot(req.params.ts);
    if (!snap) return res.status(404).json({ error: "not found", ts: req.params.ts });
    res.json(snap);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// "Snapshot now", without shutting anything down. checkpoints:true also asks the working
// terminals to write one (they keep working); it then waits SHUTDOWN_CHECKPOINT_S.
app.post("/company/system/snapshot", async (req, res) => {
  try {
    const { checkpoints } = (req.body ?? {}) as { checkpoints?: boolean };
    res.json(await takeSnapshot({
      reason: "snapshot now (from the System page, no shutdown)",
      withCheckpoints: checkpoints === true,
      markPaused: false,
    }));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Progress of the run above: phase + the steps a checkpoint came in as it arrives.
app.get("/company/system/shutdown/status", (_req, res) => {
  try { res.json(shutdownJobStatus()); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

// The button. confirm:true is required so an accidental POST can never stop the company.
app.post("/company/system/shutdown", (req, res) => {
  const { confirm } = (req.body ?? {}) as { confirm?: boolean };
  if (confirm !== true) {
    return res.status(400).json({
      error: "confirm required",
      detail: "POST {\"confirm\":true} - this stops every terminal, Laya, the jcode server, the supervisor task and this router",
    });
  }
  try {
    const job = startShutdown({ requestedBy: "the CEO (dashboard)" });
    if (!job.snapshotDir) {
      return res.status(202).json({
        ok: true, accepted: true, job,
        detail: "shutdown started; checkpoints are being collected (progress: GET /company/system/shutdown/status); the router dies last",
      });
    }
    res.status(202).json({ ok: true, accepted: true, snapshotDir: job.snapshotDir, job });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get("/company/system/resume/status", (_req, res) => {
  try { res.json(resumeJobStatus()); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

// Bring the company back: jcode --resume <sessionId> per selected terminal (staggered,
// limits honoured), each one handed its resumeBrief; then RESUME's tasks and FLEET's orders.
app.post("/company/system/resume", (req, res) => {
  const { sessionIds, snapshotTs } = (req.body ?? {}) as { sessionIds?: string[]; snapshotTs?: string };
  try {
    const ids = Array.isArray(sessionIds) ? sessionIds.filter((s) => typeof s === "string") : undefined;
    res.status(202).json(startResume({ sessionIds: ids, snapshotTs }));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ENV-RELOAD (order F2-ENVRELOAD, 2026-10-06): re-read .env for the allow-list in
// src/company/envReload.ts, so a rotated GITHUB_TOKEN (or a flipped Fleet/budget knob) takes
// effect without a restart. The mutation rides the same companyGuard secret as every other
// POST under /company. Refused 409 while an order is being PLANNED or a work order is
// STARTING, because swapping settings mid-step is what the refusal exists to prevent. The
// answer carries key NAMES only - never a value from .env.
app.post("/company/reload-env", (req, res) => {
  try {
    const busy = loadFleetOrders().find(
      (o) => o.status === "planning" || o.workOrders.some((w) => w.state === "starting"),
    );
    if (busy) {
      return res.status(409).json({
        error: "busy",
        detail: busy.status === "planning"
          ? `order ${busy.id} is being planned; retry once planning settles`
          : `order ${busy.id} has a work order starting; retry once it is running`,
      });
    }
    res.json(reloadEnv());
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── LAYA-CTL: Laya status + stop/start controls (System page panel) ────────────────
// GET is a loopback-exempt read like the other status routes; the two mutations ride the
// same companyGuard (X-Company-Token) as every other POST under /company.
// stopLaya() targets ONLY python.exe running laya.serve / laya-gpu-boot.py; startLaya()
// refuses if /health already answers and otherwise launches scripts/serve-laya.ps1
// detached, hidden, and returns at once (loading takes minutes).
app.get("/company/laya", async (_req, res) => {
  try { res.json(await layaStatus()); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post("/company/laya/stop", async (_req, res) => {
  try { res.json(await stopLaya()); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post("/company/laya/start", async (req, res) => {
  const { device } = (req.body ?? {}) as { device?: string };
  if (device !== "gpu" && device !== "cpu") {
    return res.status(400).json({ error: 'device must be "gpu" or "cpu"' });
  }
  try { res.json(await startLaya({ device })); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

// LAYA-UX: one action behind the panel's single confirm. Stops Laya, waits up to 15 s for
// /health to go down, then starts the other device. The body's `device` is only a hint for
// the case where health cannot say which device Laya is on; the module derives the target.
app.post("/company/laya/switch", async (req, res) => {
  const { device } = (req.body ?? {}) as { device?: string };
  if (device !== undefined && device !== "gpu" && device !== "cpu") {
    return res.status(400).json({ error: 'device must be "gpu" or "cpu"' });
  }
  try { res.json(await switchLaya(device ? { device } : {})); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── TWO-WAY SLACK BRIDGE (inbound) ─────────────────────────────────────
// The CEO types in Slack -> the company assistant answers in the same thread.
// Transport is chosen inside the module: Socket Mode when SLACK_APP_TOKEN is
// set, otherwise polling conversations.history with the bot token. Both are
// optional and the bridge no-ops safely when nothing is configured, so the
// router must never depend on it: it starts AFTER the server is listening and
// inside a try/catch.
const server = app.listen(config.port, config.host, () => {
  console.log(
    `router on ${config.host}:${config.port} (claude=subscription oauth, ` +
      `auth=${config.authToken ? "X-Company-Token required" : "loopback-only, no secret set"})`,
  );
  // ONE usage refresh at boot (CEO order 2026-10-02): kick the Go quota read immediately so the
  // routing policy gets a real snapshot instead of staying blind until the first budget tick. The
  // bind has already succeeded, and this is async + fire-and-forget, so it never delays listen.
  void openCodeGoUsage({ fresh: true })
    .then((q) =>
      console.log(`[usage] boot Go refresh: connected=${q.connected} ${q.remainingPct ?? "?"}% ${q.bindingWindow ?? ""}`),
    )
    .catch((e) => console.error(`[usage] boot Go refresh failed (continuing): ${String(e)}`));
  try {
    // AIR-GAP (PERF item 7): in air-gapped mode the inbound Slack bridge stays down:
    // both of its transports (Socket Mode websockets and channel polling) are
    // outbound calls to slack.com and cannot run. Nothing else in this boot block
    // leaves the machine, so the rest of the watchers start unchanged.
    const inbound = airGapStatus().enabled ? { transport: "disabled-air-gapped", running: false } : startSlackInbound();
    console.log(`[slack-inbound] bridge status: transport=${inbound.transport} running=${inbound.running}`);
  } catch (e) {
    // A broken bridge must not take the control plane down with it.
    console.error(`[slack-inbound] bridge failed to start (router continues): ${String(e)}`);
  }
  // The fleet watcher moves work orders forward (journal activity -> report ->
  // Claude review -> done). Same rule as the bridge: it must never take the
  // router down, and a second watcher refuses to start (company/fleet/WATCHER.json).
  try {
    const fleetWatch = startFleetWatcher();
    console.log(`[fleet] watcher status: running=${fleetWatch.running} interval=${fleetWatch.intervalMs}ms`);
  } catch (e) {
    console.error(`[fleet] watcher failed to start (router continues): ${String(e)}`);
  }
  // Terminal auto-close (docs/AUTOCLOSE_SPEC.md): every 30s, close ONLY registered
  // windows that reported and got a manager PASS. Same rule as the two watchers
  // above - guarded, unref'd, and it can never crash the router.
  try {
    const reaper = startTerminalReaper();
    console.log(`[autoclose] reaper status: running=${reaper.running} enabled=${reaper.enabled} dryRun=${reaper.dryRun}`);
  } catch (e) {
    console.error(`[autoclose] reaper failed to start (router continues): ${String(e)}`);
  }
  // The CEO briefing (docs/REPORTING_SPEC.md): every 30s, manager-check the runs
  // whose evidence changed and roll the cards up into one page for the CEO. Same
  // rule again - guarded, unref'd, non-overlapping, and a broken tick is logged and
  // retried by the next one instead of taking the control plane down.
  try {
    const brief = startBriefingWatcher();
    console.log(`[briefing] watcher status: running=${brief.running} enabled=${brief.enabled} interval=${brief.intervalMs}ms`);
  } catch (e) {
    console.error(`[briefing] watcher failed to start (router continues): ${String(e)}`);
  }
  // MANAGER QUEUE (CEO APPROVAL POLICY, 2026-09-30): every 60s, decide the routine
  // retry/drop prompts the CEO must not be asked about. Retries a transient failure
  // at most twice, then raises ONE prompt. Guarded and unref'd like the rest.
  try {
    const mq = startManagerQueueWatcher();
    console.log(`[manager-queue] watcher status: running=${mq.running} enabled=${mq.enabled} interval=${mq.intervalMs}ms`);
  } catch (e) {
    console.error(`[manager-queue] watcher failed to start (router continues): ${String(e)}`);
  }
  // BUDGET (docs/BUDGET_SPEC.md §1): every BUDGET_POLL_S (default 300 s), read the
  // real OpenCode Go remaining allowance and the Claude windows asynchronously and
  // write company/budget/state.json + history.jsonl. Same rule as the watchers
  // above: guarded, unref'd, serial (never overlapping), and a broken tick is
  // logged and retried by the next one instead of taking the control plane down.
  try {
    const bud = startBudgetWatcher();
    console.log(`[budget] watcher status: running=true poll=${bud.pollS}s (unref'd, async only)`);
  } catch (e) {
    console.error(`[budget] watcher failed to start (router continues): ${String(e)}`);
  }
  // RESUME (docs/RESUME_SPEC.md §2): run the resumes queued at boot. One start per
  // stagger interval, capped, and never below the free-RAM floor. Guarded like every
  // other watcher: it can never take the control plane down.
  try {
    const q = startBootResumeQueue();
    if (q.queued || q.running) {
      console.log(
        `[tasks] resume queue: ${q.queued} queued, ${q.running} running ` +
          `(stagger ${q.staggerMs}ms, cap ${q.maxConcurrent}, RAM floor ${q.minFreeRamMb}MB, free ${q.freeRamMb}MB)`,
      );
    }
  } catch (e) {
    console.error(`[tasks] resume queue failed to start (router continues): ${String(e)}`);
  }
  // RESUME (docs/RESUME_SPEC.md §3): if a restart killed the assistant mid-planning,
  // that message left a marker and no tasks. Redo it once and say so in the thread.
  try {
    void resumeInflightPlanning()
      .then((redo) => {
        if (redo.redone || /already exist/.test(redo.reason)) {
          console.log(`[assistant] interrupted planning: ${redo.redone ? "redone" : "not redone"} (${redo.reason})`);
        }
      })
      .catch((e) => console.error(`[assistant] in-flight planning redo failed (router continues): ${String(e)}`));
  } catch (e) {
    console.error(`[assistant] in-flight planning redo failed (router continues): ${String(e)}`);
  }

  // NY-CHAT hook (docs/NEEDS_YOU_SPEC.md section 7): soft-import the assistant's
  // chat resolver and nudge newly-open question items into the assistant thread.
  // Tolerates the module/export being absent (another worker is landing it now).
  try {
    const interval = setInterval(async () => {
      try {
        const mod = await import("./company/assistant.js");
        if (typeof mod.askNeedsYouInChat === "function") {
          const count = mod.askNeedsYouInChat();
          if (count > 0) console.log(`[needs-you] assistant asked ${count} new item(s) in chat`);
        }
      } catch {
        // assistant.ts may not exist yet; keep trying every 30s until it does.
      }
    }, 30000);
    interval.unref?.();
  } catch (e) {
    console.error(`[needs-you] chat interval failed to start (router continues): ${String(e)}`);
  }
});

// Clean shutdown: stop the bridge (clears the poll interval, closes the socket)
// and close the listener, so Ctrl+C never leaves a dangling socket behind.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    try {
      stopSlackInbound();
    } catch (e) {
      console.error(`[slack-inbound] stop failed on ${signal}: ${String(e)}`);
    }
    try {
      stopFleetWatcher();
    } catch (e) {
      console.error(`[fleet] watcher stop failed on ${signal}: ${String(e)}`);
    }
    try {
      stopBriefingWatcher();
    } catch (e) {
      console.error(`[briefing] watcher stop failed on ${signal}: ${String(e)}`);
    }
    try {
      stopBudgetWatcher();
    } catch (e) {
      console.error(`[budget] watcher stop failed on ${signal}: ${String(e)}`);
    }
    try {
      stopBootResumeQueue();
    } catch (e) {
      console.error(`[tasks] resume queue stop failed on ${signal}: ${String(e)}`);
    }
    server.close(() => {
      console.log(`[server] closed on ${signal} (inbound bridge: ${inboundStatus().transport}, running=${inboundStatus().running})`);
      process.exit(0);
    });
    // Do not hang forever if a keep-alive connection refuses to drain.
    setTimeout(() => process.exit(0), 2000).unref?.();
  });
}
