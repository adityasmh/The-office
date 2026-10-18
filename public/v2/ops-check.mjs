// public/v2/ops-check.mjs — proof for orders D2A-ops-view-a + D2B-ops-view-b.
// Run once: node public/v2/ops-check.mjs
// Does NOT import from src/company/ (per order, prefer not importing it).
// Sample status below is clearly fake fixture data; shape copied from
// src/company/opsView.ts OpsStatus/InfraItem/MoneyView/QueueView.

import {
  renderBanner,
  renderHealth,
  renderMoney,
  renderQueue,
  renderFailure,
  renderWorkers,
  renderTasks,
  renderAlerts,
} from "./views/ops.js";

import fs from "node:fs";

const HOSTILE = "<img src=x onerror=alert(1)>";

function okInfra(detail) {
  return { ok: true, detail, ageMin: 4 };
}

// Clearly fake fixture status: everything working.
function fakeOkStatus() {
  return {
    generatedAt: "2026-10-13T00:00:00.000Z",
    infra: {
      router: okInfra("own health answers (fake)"),
      laya: okInfra("Laya answered (fake)"),
      orderQueue: okInfra("queue process running (fake)"),
      watchdog: okInfra("scheduled task OfficeQueueWatch: Ready (fake)"),
      keepAwake: okInfra("keep-awake.ps1 running as pid 1 (fake)"),
    },
    money: {
      opencode: {
        fiveHour: { remainingPct: 80, resetsIn: "in 2h" },
        weekly: { remainingPct: 60, resetsAt: "2099-01-01" },
        monthly: { remainingPct: 50, resetsAt: "2099-02-01" },
      },
      deepseekBalance: 5.0,
      creditStart: 9.0,
      creditSpent: 4.0,
      cap: 9.0,
    },
    queue: {
      state: "ok",
      orders: { "fake-order-a": "need", "fake-order-b": "active", "fake-order-c": "done", "fake-order-d": "exhausted" },
      counts: { done: 1, active: 1, waiting: 1, failed: 1 },
      paused: false,
      ageMin: 2,
    },
    workers: { workers: [] },
    tasks: [],
    alerts: [],
  };
}

function fakeRedStatus() {
  const s = fakeOkStatus();
  s.infra.router = { ok: false, detail: "no answer (fake)", ageMin: 7 };
  return s;
}

function fakeHostileStatus() {
  const s = fakeOkStatus();
  s.infra.laya = { ok: true, detail: HOSTILE, ageMin: 3 };
  return s;
}

function fakePausedStatus() {
  const s = fakeOkStatus();
  s.queue.paused = true;
  s.queue.pausedAgeMin = 6;
  return s;
}

// Clearly fake part-2 fixtures: two workers (one headless, hostile orderId),
// tasks NEW (ageMin 3) and OLD (ageMin 45) with a hostile error, alerts.
function fakePart2Status() {
  const s = fakeOkStatus();
  s.workers = {
    workers: [
      { pid: 1111, kind: "opencode", orderId: HOSTILE, memMB: 120.5, startTime: "2026-10-13T00:00:00.000Z", runningMin: 12, headless: true, lastLines: [] },
      { pid: 2222, kind: "jcode", orderId: "fake-order-b", memMB: 80, startTime: "2026-10-13T00:00:00.000Z", runningMin: 5, headless: false, lastLines: [] },
    ],
  };
  s.tasks = [
    { id: "t-new", projectId: "fake-proj", project: "Fake Proj", orderId: "fake-order-new", status: "coding", ageMin: 3, isStale: false, error: HOSTILE, errorPlain: "plain sentence " + HOSTILE },
    { id: "t-old", projectId: "fake-proj", project: "Fake Proj", orderId: "fake-order-old", status: "failed", ageMin: 45, isStale: false, error: "boom", errorPlain: "it gave up" },
  ];
  s.alerts = [
    { kind: "quota", target: "opencode", text: "oldest alert (fake)", ageMin: 30, fresh: false },
    { kind: "infra", target: "laya", text: "newest alert (fake)", ageMin: 2, fresh: true },
    { kind: "credit", target: "deepseek", text: "middle alert (fake)", ageMin: 12, fresh: false },
  ];
  return s;
}

function fakeUnavailableWorkersStatus() {
  const s = fakeOkStatus();
  s.workers = { unavailable: true, reason: "powershell failed (fake)" };
  return s;
}

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    pass++;
    console.log("PASS " + name);
  } else {
    fail++;
    console.log("FAIL " + name);
  }
}

const ok = fakeOkStatus();
const red = fakeRedStatus();
const hostile = fakeHostileStatus();
const paused = fakePausedStatus();

const bannerOk = renderBanner(ok);
const bannerRed = renderBanner(red);
const health = renderHealth(ok);
const money = renderMoney(ok);
const queueRun = renderQueue(ok);
const queuePaused = renderQueue(paused);
const hostileHealth = renderHealth(hostile);
const failure = renderFailure();

// 1. Each of the four sections renders its labels.
check("health renders Router/Laya/Queue/Watchdog/Keep-awake", ["Router", "Laya", "Queue", "Watchdog", "Keep-awake"].every((w) => health.includes(w)));
check("money renders OpenCode/DeepSeek/credit/cap", money.includes("OpenCode") && money.includes("DeepSeek") && money.includes("Credit spent") && money.includes("cap"));
check("queue renders done/running/waiting/failed", queueRun.includes("done") && queueRun.includes("running") && queueRun.includes("waiting") && queueRun.includes("failed"));
check("queue renders order states waiting/running/done/gave up", queueRun.includes("waiting") && queueRun.includes("running") && queueRun.includes("done") && queueRun.includes("gave up"));
check("banner section exists as function output", typeof bannerRed === "string" && bannerRed.length > 0);

// 2. Hostile detail is escaped.
check("hostile detail escaped", hostileHealth.includes("&lt;img") && !hostileHealth.includes("<img src=x"));

// 3. Pause/Resume labels.
check("queue running shows Pause", queueRun.includes(">Pause<") && !queueRun.includes(">Resume<"));
check("queue paused shows Resume", queuePaused.includes(">Resume<") && !queuePaused.includes(">Pause<"));

// 4. Banner conditional.
check("banner empty when nothing red", bannerOk === "");
check("banner names Router when router red", bannerRed.includes("Router") && bannerRed.includes("since"));

// 5. Failure box.
check("renderFailure returns failure text", failure.includes("The router is not answering"));

// 6. Part 2: each of the three sections renders from the sample status.
const p2 = fakePart2Status();
const workersHtml = renderWorkers(p2);
const tasksHtml = renderTasks(p2, "all");
const alertsHtml = renderAlerts(p2);
check("workers section renders", workersHtml.includes("Workers") && workersHtml.includes("1111"));
check("tasks section renders", tasksHtml.includes("Tasks") && tasksHtml.includes("fake-order-new"));
check("alerts section renders", alertsHtml.includes("Alerts") && alertsHtml.includes("newest alert"));
check("workers unavailable shows reason", renderWorkers(fakeUnavailableWorkersStatus()).includes("powershell failed (fake)"));

// 7. Hostile strings escaped in worker name and in error.
check("hostile worker name escaped", workersHtml.includes("&lt;img") && !workersHtml.includes("<img src=x"));
check("hostile error escaped", tasksHtml.includes("&lt;img") && !tasksHtml.includes("<img src=x"));
check("raw error only inside details fold", tasksHtml.includes("<details><summary>details</summary>"));

// 8. NEW for ageMin 3 and OLD for 45.
check("NEW tag for ageMin 3", tasksHtml.includes("NEW"));
check("OLD tag for ageMin 45", tasksHtml.includes("OLD"));

// 9. Filter 'new' returns only the NEW task.
const onlyNew = renderTasks(p2, "new");
check("filter new returns only NEW task", onlyNew.includes("fake-order-new") && !onlyNew.includes("fake-order-old"));

// 10. Headless vs window badge text.
check("headless badge text", workersHtml.includes("headless, no window"));
check("window badge text", workersHtml.includes("has a window"));

// 11. Kill markup carries confirmation flag.
check("kill markup has data-confirm", workersHtml.includes('data-act="kill"') && workersHtml.includes('data-confirm="1"'));

// 12. Alerts newest first.
check(
  "alerts newest first",
  alertsHtml.indexOf("newest alert") !== -1 &&
  alertsHtml.indexOf("newest alert") < alertsHtml.indexOf("middle alert") &&
  alertsHtml.indexOf("middle alert") < alertsHtml.indexOf("oldest alert"),
);

// 13. Tail panel not-captured text (static: source states it plainly).
const opsSource = fs.readFileSync(new URL("./views/ops.js", import.meta.url), "utf8");
check("tail panel not-captured text", opsSource.includes("not captured") && opsSource.includes("workerTailPath") && workersHtml.includes('data-act="tail"'));

console.log("---");
console.log("checks are static string checks (no network, no services, no DOM)");
console.log("the confirm dialog, click wiring and tail fetch are NOT exercised (static only)");
console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exitCode = 1;
