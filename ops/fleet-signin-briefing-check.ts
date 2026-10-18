/**
 * ops/fleet-signin-briefing-check.ts — INDEPENDENT verification of the expired-sign-in path.
 *
 * Deliberately NOT a re-run of ops/fleet-planner-fallback-check.ts: this one never plans
 * anything and never calls a model. It writes a fleet order the way the planner would leave it
 * after the fix (status failed, error = the plain sign-in sentence), then asks the REAL
 * run-manager + briefing code - the same code the dashboard polls - what the CEO would see.
 *
 * That is the requirement the planner-fallback harness could only check by construction:
 * "the CEO must see ONE plain message, not a retry/drop prompt".
 *
 *   npx tsx ops/fleet-signin-briefing-check.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-signin-check-"));
process.env.COMPANY_ROOT = path.join(tmp, "company");
process.env.MOCK_MODE = "1";
fs.mkdirSync(path.join(process.env.COMPANY_ROOT, "fleet"), { recursive: true });

const SIGNIN = "Claude sign-in expired: the CEO must run claude /login in a terminal";
const now = new Date().toISOString();

// Two orders: one with the new error, one with the OLD error text, so the control is real.
const orders = [
  {
    id: "foNewSignin",
    text: "GOAL: write the operator guide for the six fleet routes and a read-only health check script.",
    createdAt: now,
    updatedAt: now,
    status: "failed",
    workOrders: [],
    planAttempts: 1,
    plan: "(empty plan)",
    error: SIGNIN,
    trace: [
      { ts: now, from: "CEO", to: "Claude (manager)", what: "order", detail: "GOAL: write the operator guide..." },
      {
        ts: now,
        from: "Claude (manager)",
        to: "CEO",
        what: "plan failed",
        detail: `${SIGNIN} (Claude: Error: claude -p error: Failed to authenticate: OAuth session expired and could not be refreshed; fallback: no fallback model answered (tried deepseek-v4.1-flash, kimi-k2.7-code))`,
      },
    ],
  },
  {
    id: "foOldGeneric",
    text: "GOAL: an ordinary order that failed for some other reason.",
    createdAt: now,
    updatedAt: now,
    status: "failed",
    workOrders: [],
    planAttempts: 3,
    plan: "(empty plan)",
    error: "planning failed 3x: the planner produced no usable work orders",
    trace: [{ ts: now, from: "Claude (manager)", to: "CEO", what: "plan failed", detail: "the planner produced no usable work orders" }],
  },
];
fs.writeFileSync(path.join(process.env.COMPANY_ROOT, "fleet", "orders.json"), JSON.stringify(orders, null, 2));

const runManagers = await import("../src/company/runManagers.js");
const briefing = await import("../src/company/briefing.js");

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
}

const cards = runManagers.listRunCards();
const b = briefing.composeBriefing(cards, { seenAt: new Date(0).toISOString(), summary: "(sign-in check)", model: "local" });
const item = (id: string) => b.needsYou.find((n: any) => n.runId === `fleet:${id}`);
const card = (id: string) => cards.find((c) => c.runId === `fleet:${id}`);
const labels = (i: any) => (i?.actions ?? []).map((a: any) => a.label);

const newCard = card("foNewSignin");
const newItem = item("foNewSignin");
const oldItem = item("foOldGeneric");

console.log("[check] CARD (what the runs list shows):");
console.log(`  state=${newCard?.state} needsCeo=${JSON.stringify(newCard?.needsCeo)}`);
console.log("[check] PROMPT (what the dashboard asks):");
console.log(`  kind=${newItem?.kind}`);
console.log(`  question=${JSON.stringify(newItem?.question)}`);
console.log(`  actions=${JSON.stringify(labels(newItem))}`);
console.log("[check] CONTROL (an ordinary failure):");
console.log(`  question=${JSON.stringify(oldItem?.question)} actions=${JSON.stringify(labels(oldItem))}`);

check("the failed order is a card", !!newCard, String(newCard?.state));
check("the card keeps the deterministic reason", newCard?.needsCeo === SIGNIN, JSON.stringify(newCard?.needsCeo));
check("the CEO is asked the plain sentence", newItem?.question === SIGNIN, JSON.stringify(newItem?.question));
check("it is not a retry/drop choice", newItem?.kind === "external", String(newItem?.kind));
check("no 'Retry order' / 'Drop order' buttons", !labels(newItem).some((l: string) => /retry order|drop order/i.test(l)), JSON.stringify(labels(newItem)));
check("exactly ONE way to clear it", labels(newItem).length === 1, JSON.stringify(labels(newItem)));
check("that one action re-runs the order after sign-in", newItem?.actions?.[0]?.effect === "retry_order", String(newItem?.actions?.[0]?.effect));
// The CONTROL: an ORDINARY retry/drop failure. Under the CEO APPROVAL POLICY (2026-09-30,
// needsYouRule.classifyApprovalRisk) a prompt whose ONLY actions are retry/drop is classified
// "routine" and moved to the manager queue instead of the CEO's list. That is the policy working
// as designed - my first version of this assertion predated it and was simply wrong.
// What matters for THIS work order is that the policy does not swallow the sign-in item.
check(
  "the ordinary retry/drop failure is NOT offered as a sign-in prompt",
  !oldItem || oldItem.question !== SIGNIN,
  JSON.stringify(oldItem?.question ?? null),
);

// The sign-in order must be OFFERED to the CEO (not swallowed by the routine policy).
check("the sign-in order is present in needsYou", !!newItem, newItem ? "present" : "missing");
check(
  "the sign-in item was classified as the CEO's call, not routine",
  newItem?.kind === "external",
  String(newItem?.kind),
);
check("counts say one failed run", b.counts.failed >= 1, JSON.stringify(b.counts));

console.log(`\n[check] ${failures ? `${failures} FAILED` : "ALL CHECKS PASSED"} (temp dir ${tmp})`);
process.exit(failures ? 1 : 0);
