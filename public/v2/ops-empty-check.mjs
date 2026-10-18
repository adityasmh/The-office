// public/v2/ops-empty-check.mjs — proof for order OPSF1B-empty-state-typo.
// Run once: node public/v2/ops-empty-check.mjs
// Node built-ins only; no network, no services, no DOM.
// The fake fixture below copies the shape of the ok/paused fixtures in
// public/v2/ops-check.mjs (fakeOkStatus/fakePausedStatus), with an empty
// orders object so renderQueue takes the empty-queue branch.

import { renderQueue } from "./views/ops.js";

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

// Clearly fake fixture status with an empty queue; shape copied from the
// ok/paused fixtures in public/v2/ops-check.mjs (see renderQueue(ok) at
// ops-check.mjs:129). orders is an empty object on purpose.
function fakeEmptyStatus() {
  return {
    generatedAt: "2026-10-13T00:00:00.000Z",
    infra: {},
    money: {},
    queue: {
      state: "ok",
      orders: {},
      counts: { done: 0, active: 0, waiting: 0, failed: 0 },
      paused: false,
      ageMin: 2,
    },
    workers: { workers: [] },
    tasks: [],
    alerts: [],
  };
}

const html = renderQueue(fakeEmptyStatus());

// 1. The empty-queue message ends with the period directly followed by the
//    closing tag (no stray double quote).
check(
  "empty-queue message is exactly 'No orders in the queue right now.</div>'",
  html.includes("No orders in the queue right now.</div>"),
);
check("HTML contains no '.\"' sequence", !html.includes(".\""));

// 2. Counts line is still present.
check(
  "counts line is still present",
  html.includes('class="ops-counts"') &&
    ["done:", "running:", "waiting:", "failed:"].every((w) => html.includes(w)),
);

// 3. Pause or Resume button is still present.
check(
  "Pause or Resume button is still present",
  html.includes(">Pause<") || html.includes(">Resume<"),
);

console.log("---");
console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exitCode = 1;
