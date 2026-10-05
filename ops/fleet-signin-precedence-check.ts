/**
 * ops/fleet-signin-precedence-check.ts — the coexistence case I got wrong.
 *
 * A card can be BOTH retry-exhausted AND sign-in-expired. The retry-exhausted branch was added
 * by another agent at briefing.ts:~381, ABOVE my sign-in branch at ~452 - so for an order that has
 * already been retried out, the CEO was shown "already retried N times ... Drop it here" instead of
 * the one action that fixes it (`claude /login`). That is the exact prompt this work order asked me
 * to remove.
 *
 * This test builds that card and asserts the sign-in answer WINS.
 *
 *   npx tsx ops/fleet-signin-precedence-check.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signin-precedence-"));
process.env.COMPANY_ROOT = path.join(tmp, "company");
process.env.MOCK_MODE = "1";
process.env.FLEET_ORDER_MAX_RETRIES = "2";
fs.mkdirSync(path.join(process.env.COMPANY_ROOT, "fleet"), { recursive: true });

const SIGNIN = "Claude sign-in expired: the CEO must run claude /login in a terminal";
const now = new Date().toISOString();

// The newest copy of a job: failed on the sign-in, explicitly marked as retried out.
const order = {
  id: "foSigninAndExhausted",
  text: "GOAL: write the operator guide for the six fleet routes and a read-only check script.",
  createdAt: now,
  updatedAt: now,
  status: "failed",
  workOrders: [],
  planAttempts: 1,
  plan: "(empty plan)",
  error: SIGNIN,
  retryCount: 2, // the resolver wrote this down: the retry budget is spent
  trace: [
    { ts: now, from: "CEO", to: "Claude (manager)", what: "order", detail: "GOAL: write the operator guide..." },
    { ts: now, from: "Claude (manager)", to: "CEO", what: "plan failed", detail: `${SIGNIN} (Claude: Error: claude -p error: Failed to authenticate: OAuth session expired and could not be refreshed; fallback: no fallback model answered)` },
  ],
};
// An older copy superseded by it, so the depth walk also sees 2 if retryCount were ignored.
const older = {
  ...order,
  id: "foSigninAndExhaustedOld",
  retryCount: undefined,
  supersededBy: order.id,
  updatedAt: now,
  error: "planning failed 1x: the planner produced no usable work orders",
  trace: [{ ts: now, from: "Claude (manager)", to: "CEO", what: "plan failed", detail: "the planner produced no usable work orders" }],
};
fs.writeFileSync(path.join(process.env.COMPANY_ROOT, "fleet", "orders.json"), JSON.stringify([order, older], null, 2));

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
};

const runManagers = await import("../src/company/runManagers.js");
const briefing = await import("../src/company/briefing.js");
const rule = await import("../src/company/needsYouRule.js");
const { CLAUDE_SIGNIN_EXPIRED_MESSAGE } = await import("../src/company/claudeSignIn.js");

const cards = runManagers.listRunCards();
const card = cards.find((c) => c.runId === `fleet:${order.id}`)!;
console.log("[precedence] card:", JSON.stringify({ state: card?.state, needsCeo: card?.needsCeo, fleetRetryExhausted: (card as any)?.fleetRetryExhausted, fleetFailureCause: (card as any)?.fleetFailureCause }));
console.log("[precedence] rule says: exhausted=" + rule.orderRetryExhausted(order as any, [order, older] as any) + " cause=" + rule.orderFailureCause(order as any));

const b = briefing.composeBriefing(cards, { seenAt: new Date(0).toISOString(), summary: "(x)", model: "local" });
const item = b.needsYou.find((n: any) => n.runId === `fleet:${order.id}`);
console.log("[precedence] prompt:", JSON.stringify(item ? { kind: item.kind, q: item.question, acts: (item.actions ?? []).map((a: any) => a.label) } : null));

check("the card is retry-exhausted (the collision is real)", (card as any)?.fleetRetryExhausted === true, String((card as any)?.fleetRetryExhausted));
check("the prompt is the sign-in sentence, not the retry-exhausted warning", item?.question === CLAUDE_SIGNIN_EXPIRED_MESSAGE, JSON.stringify(item?.question ?? null));
check("it is not a retry/drop choice", item?.kind === "external", String(item?.kind));
check("exactly one action is offered", (item?.actions ?? []).length === 1, String((item?.actions ?? []).length));
check("the action re-runs the order after sign-in", item?.actions?.[0]?.effect === "retry_order", String(item?.actions?.[0]?.effect));
check("no 'Drop' button is offered", !(item?.actions ?? []).some((a: any) => /drop/i.test(String(a.label))), JSON.stringify((item?.actions ?? []).map((a: any) => a.label)));
check("the retry-exhausted wording is NOT shown instead", !/already been retried/i.test(String(item?.question ?? "")), JSON.stringify(item?.question ?? null));

console.log(`\n[precedence] ${failures ? `${failures} FAILED` : "ALL CHECKS PASSED"} (temp dir ${tmp})`);
process.exit(failures ? 1 : 0);
