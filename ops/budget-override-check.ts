// ops/budget-override-check.ts - BUDGET x INBOX (company/inbox/INTEGRATION.md §8):
// proves the CEO's one-time grant is honoured, spent exactly once, and never
// burned on a decision that needed no change.
//
// Run it against a THROWAWAY company root (it writes and consumes grants there):
//
//   set COMPANY_ROOT=%TEMP%\budget-grant\company
//   npx tsx ops/budget-override-check.ts
//
// What it checks, in order:
//   1. a held grant rescues the pick the guard would have downgraded (Kimi under
//      Go amber), and the grant is marked used (usedBy=applyBudgetFilter);
//   2. with the grant spent, the same pick is downgraded again;
//   3. a pick that needed NO change does not burn the grant (it is still held);
//   4. the assistant's Opus pick is rescued too (Claude red);
//   5. a RED fleet queue is released once by a grant, then queues again;
//   6. reading the grant (budgetGrantHeld / buildSnapshot's status read) never spends it.
//
// Exits non-zero on any failure. Never touches the live company root.

import fs from "node:fs";
import path from "node:path";
import { getCompanyRoot } from "../src/company/org.js";
import {
  applyBudgetFilter, assistantModelFor, budgetGrantHeld, fleetQueueForBudget, readBudgetState,
  rulesFor, type BudgetSnapshot,
} from "../src/company/budgetGuard.js";

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n        ${detail}`);
  if (!ok) failures += 1;
}

const root = getCompanyRoot();
const overridesPath = path.join(root, "inbox", "budget-overrides.json");

type Grant = {
  id: string; itemId: string; question: string; answer: string;
  grantedAt: string; expiresAt: string; usedAt?: string; usedBy?: string;
};

function writeGrant(id: string, minutes = 60): void {
  const now = Date.now();
  const grant: Grant = {
    id,
    itemId: `inbox_${id}`,
    question: "Claude is nearly out - allow this one anyway?",
    answer: "Yes - allow it once.",
    grantedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + minutes * 60_000).toISOString(),
  };
  fs.mkdirSync(path.dirname(overridesPath), { recursive: true });
  fs.writeFileSync(overridesPath, JSON.stringify({ version: 1, updatedAt: new Date(now).toISOString(), overrides: [grant] }, null, 2));
}

function readGrants(): Grant[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(overridesPath, "utf8")) as { overrides?: Grant[] };
    return parsed.overrides ?? [];
  } catch {
    return [];
  }
}

// A synthetic snapshot with real rules: Go amber + Claude red, which is the live
// state right now. Only levels + rules are read by the filter.
const snapshot = {
  ...({} as BudgetSnapshot),
  levels: { go: "amber", claude: "red" },
  rules: rulesFor("amber", "red"),
  providers: { go: { remainingPct: 20 }, claude: { remainingPct: 0 } },
} as unknown as BudgetSnapshot;

// The queue rule only applies at Go RED (spec §2: "new non-urgent Fleet orders
// queue with 'waiting for budget'"), so the fleet case gets its own snapshot.
const redSnapshot = {
  ...({} as BudgetSnapshot),
  levels: { go: "red", claude: "red" },
  rules: rulesFor("red", "red"),
  providers: { go: { remainingPct: 5 }, claude: { remainingPct: 0 } },
} as unknown as BudgetSnapshot;

function main(): void {
  console.log(`company root: ${root}`);
  console.log(`grant file:   ${overridesPath}`);
  if (path.resolve(root) === path.resolve(process.cwd(), "company")) {
    console.log("REFUSING: COMPANY_ROOT points at the live company/ folder. Set it to a throwaway copy.");
    process.exit(2);
  }
  fs.rmSync(overridesPath, { force: true });

  // 1. a held grant rescues the pick and is spent
  writeGrant("g1");
  const rescued = applyBudgetFilter({ model: "kimi-k2.7-code", role: "worker" }, snapshot);
  const after1 = readGrants()[0]!;
  check(
    "a held grant keeps the CEO's Kimi pick (amber would have downgraded it)",
    rescued.model === "kimi-k2.7-code" && !rescued.changed,
    `kimi-k2.7-code -> ${rescued.model} | ${rescued.reason}`,
  );
  check(
    "the grant is marked used, by the filter, with the CEO's answer in the reason",
    after1.usedAt !== undefined && after1.usedBy === "applyBudgetFilter" && /allowed this once/.test(rescued.reason),
    `usedAt=${after1.usedAt} usedBy=${after1.usedBy} answer="${after1.answer}"`,
  );

  // 2. spent -> the rule applies again
  const after2 = applyBudgetFilter({ model: "kimi-k2.7-code", role: "worker" }, snapshot);
  check(
    "with the grant spent the same pick is downgraded again",
    after2.model === "deepseek-v4.1-flash" && after2.changed,
    `kimi-k2.7-code -> ${after2.model} (${after2.reason})`,
  );

  // 3. a no-op pick must NOT burn the grant
  writeGrant("g3");
  const noop = applyBudgetFilter({ model: "glm-5.3-flash", role: "worker" }, snapshot);
  const held3 = budgetGrantHeld();
  check(
    "a pick that needed no change does not spend the grant",
    noop.model === "glm-5.3-flash" && held3 !== undefined && held3.id === "g3",
    `glm-5.3-flash -> ${noop.model} | grant still held: ${held3 ? held3.id : "none"} | ${noop.reason}`,
  );

  // 4. the assistant's Opus pick is rescued (Claude red) and spends that grant
  const asst = assistantModelFor("claude-opus-5-5", "assistant", snapshot);
  check(
    "the grant also rescues the assistant's Opus pick under Claude red",
    asst === "claude-opus-5-5",
    `claude-opus-5-5 -> ${asst} | grant after: ${readGrants()[0]!.usedBy ?? "still held"}`,
  );

  // 5. a RED fleet queue is released once, then queues again
  writeGrant("g5");
  const released = fleetQueueForBudget(false, redSnapshot);
  const queued = fleetQueueForBudget(false, redSnapshot);
  check(
    "one grant releases one non-urgent Fleet order that Go red would have queued",
    released.queue === false && /allowed this once/.test(released.reason) && queued.queue === true,
    `first: queue=${released.queue} (${released.reason}) | then: queue=${queued.queue} (${queued.reason})`,
  );
  const urgentNeverQueued = fleetQueueForBudget(true, redSnapshot);
  check(
    "an urgent order is never queued (and never spends a grant)",
    urgentNeverQueued.queue === false && !/allowed this once/.test(urgentNeverQueued.reason),
    `urgent: queue=${urgentNeverQueued.queue} (${urgentNeverQueued.reason})`,
  );

  // 6. reading never spends
  writeGrant("g6");
  const a = budgetGrantHeld();
  const b = budgetGrantHeld();
  const c = readBudgetState();
  const stillThere = readGrants()[0]!.usedAt === undefined && a?.id === "g6" && b?.id === "g6";
  check(
    "a status read (budgetGrantHeld twice + readBudgetState) never spends the grant",
    stillThere,
    `held=${a?.id}/${b?.id} readBudgetState=${c === undefined ? "undefined" : "snapshot"} usedAt=${readGrants()[0]!.usedAt ?? "none"}`,
  );

  console.log("");
  if (failures > 0) {
    console.log(`OVERRIDE CHECK FAILED: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("OVERRIDE CHECK ALL PASS (honoured once, spent once, never burned on a no-op)");
}

main();
