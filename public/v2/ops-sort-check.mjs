// public/v2/ops-sort-check.mjs — proof for order OPSF1-queue-list-sort.
// Run once: node public/v2/ops-sort-check.mjs
// Node built-ins only; no network, no services, no DOM.
// Sample statuses below are clearly fake fixture data; queue shape copied
// from public/v2/ops-check.mjs (which copied it from src/company/opsView.ts).
// Order states are the RAW strings the queue carries (need/active/exhausted/
// done/failed); orderWord() maps them to the display words waiting/running/
// gave up/failed/done.

import { escapeHtml, renderQueue } from "./views/ops.js";

const HOSTILE = "<img src=x onerror=alert(1)>";
const escHostile = escapeHtml(HOSTILE);

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

function fakeQueueStatus(orders, counts, paused) {
  return {
    generatedAt: "2026-10-13T00:00:00.000Z",
    infra: {},
    money: {},
    queue: { state: "ok", orders, counts, paused: !!paused, ageMin: 2 },
    workers: { workers: [] },
    tasks: [],
    alerts: [],
  };
}

// Scrambled: done, running, gave up, done, waiting, failed — plus a hostile
// order name in a non-done row and a hostile done order, so the same hostile
// payload must come out escaped in both places. Object key insertion order
// is the scrambled order.
const scrambledOrders = {
  [HOSTILE]: "done",
  "ord-running": "active",
  "ord-gave-up": "exhausted",
  "ord-done-a": "done",
  "ord-waiting": "need",
  "ord-failed": "failed",
  [HOSTILE + "-row"]: "need",
};

const html = renderQueue(fakeQueueStatus(scrambledOrders, { done: 2, active: 1, waiting: 2, failed: 1 }, false));
const pos = (needle) => html.indexOf(needle);
const foldAt = html.indexOf("<summary>2 finished orders</summary>");
const nonDone = ["ord-running", "ord-waiting", "ord-gave-up", "ord-failed", escHostile + "-row"];

// 1. Priority order: running < waiting < gave up < failed.
check("running order appears before waiting order", pos("ord-running") !== -1 && pos("ord-running") < pos("ord-waiting"));
check("waiting order appears before gave up order", pos("ord-waiting") < pos("ord-gave-up"));
check("gave up order appears before failed order", pos("ord-gave-up") < pos("ord-failed"));

// 2. Every done order appears after all non-done orders.
check(
  "every done order appears after all non-done orders",
  foldAt !== -1 &&
    nonDone.every((n) => pos(n) !== -1 && pos(n) < foldAt) &&
    html.indexOf("ord-done-a", foldAt) !== -1 &&
    html.indexOf(escHostile, foldAt) !== -1,
);

// 3. The two done orders are inside ONE closed <details> (no open attribute)
// whose summary reads "2 finished orders".
check(
  "done orders are in one closed details whose summary reads 2 finished orders",
  foldAt !== -1 &&
    html.indexOf("<details><summary>2 finished orders</summary>") !== -1 &&
    !html.includes("<details open") &&
    html.indexOf("</details>") > foldAt,
);

// 4. Original order is preserved within a state group (stable sort).
check(
  "original order preserved within a state group (stable sort)",
  pos("ord-waiting") < pos(escHostile + "-row") &&
    html.indexOf(escHostile, foldAt) < html.indexOf("ord-done-a", foldAt),
);

// 5. Exactly one done order: summary reads "1 finished order".
const oneDone = renderQueue(
  fakeQueueStatus({ "ord-running": "active", "ord-done-a": "done" }, { done: 1, active: 1, waiting: 0, failed: 0 }, false),
);
check("one done order summary reads 1 finished order", oneDone.includes("<summary>1 finished order</summary>"));

// 6. Zero done orders: the whole <details> element is omitted.
const noDone = renderQueue(
  fakeQueueStatus({ "ord-running": "active", "ord-waiting": "need" }, { done: 0, active: 1, waiting: 1, failed: 0 }, false),
);
check("no done orders means no details element", !noDone.includes("<details"));

// 7. Hostile order name is escaped in the non-done row and inside the fold.
check(
  "hostile order name escaped in non-done row and inside details fold",
  html.includes(escHostile + "-row") &&
    html.indexOf(escHostile, foldAt) !== -1 &&
    !html.includes(HOSTILE),
);

// 8. Pause/Resume button and counts line are untouched.
check("Pause button text is still present", html.includes(">Pause<"));
check(
  "counts line still renders done/running/waiting/failed",
  ["done:", "running:", "waiting:", "failed:"].every((w) => html.includes(w)),
);

console.log("---");
console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exitCode = 1;
