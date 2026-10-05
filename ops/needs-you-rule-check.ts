// Acceptance probe for docs/NEEDS_YOU_RULE_SPEC.md §4.
//
// Synthetic mode builds cards directly and checks classification + composition.
// --live reads the live company cards and fails if any known false-alarm id is in
// needsYou.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunCard } from "../src/company/runManagers.js";
import type { OrderLike } from "../src/company/needsYouRule.js";

const live = process.argv.slice(2).includes("--live");

if (!live) {
  // Keep the probe isolated from the live company tree.  A green budget state means
  // spend_limit classifications do not fire unless the test specifically sets one.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ny-rule-check-"));
  process.env.COMPANY_ROOT = tmp;
  process.env.NEEDS_YOU_AUTO_NUDGE = "0";
  fs.mkdirSync(path.join(tmp, "budget"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "budget", "state.json"),
    JSON.stringify(
      {
        version: 1,
        checkedAt: new Date().toISOString(),
        levels: { go: "green", claude: "green" },
        needsYou: null,
      },
      null,
      2,
    ),
  );
} else {
  // Live composition check must not auto-nudge real tasks.
  process.env.NEEDS_YOU_AUTO_NUDGE = "0";
}

const { composeBriefing } = await import("../src/company/briefing.js");
const { classifyNeed, isNoOpTask, isSupersededOrder } = await import("../src/company/needsYouRule.js");

function makeTaskCard(
  state: RunCard["state"],
  projectId: string,
  taskId: string,
  headline: string,
  extra?: Partial<RunCard>,
): RunCard {
  return {
    runId: `task:${projectId}:${taskId}`,
    kind: "task",
    title: "Test task",
    owner: "Engineering",
    state,
    headline,
    done: [],
    remaining: [],
    model: "local",
    modelReason: "synthetic",
    checkedAt: new Date().toISOString(),
    evidenceHash: "synthetic",
    reported: false,
    updatedAt: new Date().toISOString(),
    ref: { kind: "task", projectId, taskId },
    ...extra,
  } as RunCard;
}

function makeFleetCard(
  state: RunCard["state"],
  orderId: string,
  headline: string,
  extra?: Partial<RunCard>,
): RunCard {
  return {
    runId: `fleet:${orderId}`,
    kind: "fleet",
    title: "Test order",
    owner: "Fleet",
    state,
    headline,
    done: [],
    remaining: [],
    model: "local",
    modelReason: "synthetic",
    checkedAt: new Date().toISOString(),
    evidenceHash: "synthetic",
    reported: false,
    updatedAt: new Date().toISOString(),
    ref: { kind: "fleet", orderId },
    ...extra,
  } as RunCard;
}

let pass = true;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`PASS ${msg}`);
  } else {
    console.log(`FAIL ${msg}`);
    pass = false;
  }
}

async function syntheticChecks() {
  // 1. pending_merge task is working/stuck, never waiting_for_ceo, so it is absent
  //    from needsYou.
  const pendingMerge = makeTaskCard("working", "ptest", "tmerge", "In progress: merge the report (Test project)");
  const b1 = composeBriefing([pendingMerge], {
    seenAt: new Date().toISOString(),
    summary: "",
    model: "local",
  });
  assert(!b1.needsYou.some((n) => n.runId === pendingMerge.runId), "pending_merge task absent from needsYou");

  // 2. Missing-key failed order is present with a reason.
  const missingKey = makeFleetCard("failed", "okimi", "Fleet order failed: missing Kimi access key");
  const cls = classifyNeed(missingKey);
  assert(cls.need && cls.category === "missing_key" && !!cls.reason, "missing-key card classified as need with reason");
  const b2 = composeBriefing([missingKey], {
    seenAt: new Date().toISOString(),
    summary: "",
    model: "local",
  });
  const found = b2.needsYou.find((n) => n.runId === missingKey.runId);
  assert(!!found && !!found.reason, "missing-key order present in needsYou with reason");

  // 3. Superseded order is absent from both needsYou and problems.
  const failedOrder: OrderLike = {
    id: "old",
    text: "build the dashboard",
    createdAt: "2026-09-29T10:00:00Z",
    status: "failed",
  };
  const laterOrder: OrderLike = {
    id: "new",
    text: "build the dashboard v2",
    createdAt: "2026-09-29T11:00:00Z",
    status: "done",
  };
  assert(isSupersededOrder(failedOrder, [failedOrder, laterOrder]), "superseded order detected in memory");
  const supersededCard = makeFleetCard("done", "old", "Closed (superseded by new): build the dashboard");
  const b3 = composeBriefing([supersededCard], {
    seenAt: new Date().toISOString(),
    summary: "",
    model: "local",
  });
  assert(
    !b3.needsYou.some((n) => n.runId === supersededCard.runId) &&
      !b3.problems.some((p) => p.runId === supersededCard.runId),
    "superseded order absent from needsYou and problems",
  );

  // 4. Dropped smoke-test task is absent from both needsYou and problems.
  const smokeTask = { rawRequest: "Run a smoke test for tracking only" };
  assert(isNoOpTask(smokeTask), "smoke-test task detected as no-op");
  const droppedCard = makeTaskCard("done", "ptest", "tsmoke", "Closed (dropped): Run a smoke test for tracking only");
  const b4 = composeBriefing([droppedCard], {
    seenAt: new Date().toISOString(),
    summary: "",
    model: "local",
  });
  assert(
    !b4.needsYou.some((n) => n.runId === droppedCard.runId) &&
      !b4.problems.some((p) => p.runId === droppedCard.runId),
    "dropped smoke-test task absent from needsYou and problems",
  );

  // 5. Composition is stable across two calls.
  const cards = [pendingMerge, missingKey, supersededCard, droppedCard];
  const b5a = composeBriefing(cards, { seenAt: new Date().toISOString(), summary: "", model: "local" });
  const b5b = composeBriefing(cards, { seenAt: new Date().toISOString(), summary: "", model: "local" });
  assert(
    JSON.stringify(b5a.needsYou) === JSON.stringify(b5b.needsYou) &&
      JSON.stringify(b5a.problems) === JSON.stringify(b5b.problems),
    "composition stable across two calls",
  );
}

async function liveChecks() {
  const { listRunCards } = await import("../src/company/runManagers.js");
  const cards = listRunCards();
  const b = composeBriefing(cards, { seenAt: new Date().toISOString(), summary: "", model: "local" });
  const forbidden = [
    "task:pmumhp51x:tmumi7iz3",
    "task:pmumhg71w:tmumhg72u",
    "fleet:fomumvpd3d",
    "fleet:fomumvo4sg",
    "fleet:fomumvmg57",
    "task:pmumhp51r:tmumjkfgo",
  ];
  for (const id of forbidden) {
    assert(!b.needsYou.some((n) => n.runId === id), `live: forbidden id ${id} absent from needsYou`);
  }
}

(async () => {
  if (live) {
    await liveChecks();
  } else {
    await syntheticChecks();
  }
  process.exit(pass ? 0 : 1);
})();
