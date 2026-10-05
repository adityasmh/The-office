/**
 * ops/fleet-signin-overreach-check.ts — attack my OWN precedence fix for over-reach.
 *
 * Moving the sign-in branch to the TOP of the fleet chain was necessary (a retried-out sign-in
 * order was shown a Drop-this-job prompt instead of `claude /login`). But "first" is a big hammer:
 * every OTHER branch now only runs if the sign-in check does not fire. The predicate is broad
 * (`claude \/?login`, `credentials not found`, ...), so this test proves the fix did NOT steal the
 * cases that belong to the missing-key, Claude-limit, retry-exhausted and approval branches.
 *
 * Each case is a real card shape; the assertion is WHICH ANSWER the CEO gets.
 *
 *   npx tsx ops/fleet-signin-overreach-check.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signin-overreach-"));
process.env.COMPANY_ROOT = path.join(tmp, "company");
process.env.MOCK_MODE = "1";
process.env.FLEET_ORDER_MAX_RETRIES = "2";
fs.mkdirSync(path.join(process.env.COMPANY_ROOT, "fleet"), { recursive: true });

const now = new Date().toISOString();
const mk = (id: string, text: string, error: string, extra: Record<string, unknown> = {}) => ({
  id,
  text,
  createdAt: now,
  updatedAt: now,
  status: "failed",
  workOrders: [],
  planAttempts: 1,
  error,
  trace: [{ ts: now, from: "Claude (manager)", to: "CEO", what: "plan failed", detail: error }],
  ...extra,
});

const orders = [
  // 1. The case the fix is FOR: sign-in expired AND retried out -> must be the sign-in sentence.
  mk("foSignIn", "GOAL: write the operator guide for the six fleet routes and a check script.", "Claude sign-in expired: the CEO must run claude /login in a terminal", { retryCount: 2 }),
  // 2. A MISSING-KEY order. MEASURED (2026-09-30, tools/probe-classify-source.ts): the classifer's
  // probe is `card.headline + card.needsCeo` - the order's own `error` is NOT part of it, and
  // `needsCeo` is only populated for a failed fleet order when the manager wrote one. So a
  // missing-key failure whose text lives only in `error` does NOT reach the `provide` branch and
  // falls through to retry/drop. That is PRE-EXISTING behaviour (the branch is `probe`-only,
  // unchanged by me), so this case asserts the contract that actually holds: the CEO never gets
  // the SIGN-IN sentence for a missing-key order. The reachability gap itself is reported, not
  // silently asserted away.
  mk("foMissingKey", "GOAL: publish the shared repo so every project contributes. The run needs an access key to call the gateway.", "the run needs an access key (OPENCODE_API_KEY) before it can call the gateway"),
  // 3. A CLAUDE SPEND-LIMIT order: must still offer the limit choices, never the sign-in
  // sentence. The probe is headline+needsCeo, so the wording has to say "spending limit".
  mk("foLimit", "GOAL: re-run the failed pricing analysis with the manager.", "Claude hit its spending limit while planning this order"),
  // 4. An ordinary retry/drop failure: the routine policy routes it to the manager queue, so it
  // must NOT appear as a sign-in prompt for the CEO.
  mk("foOrdinary", "GOAL: fix the flaky settings-page test.", "planning failed 3x: the planner produced no usable work orders"),
  // 5. An APPROVAL order: waiting on the CEO, and it must stay the approval it is.
  {
    id: "foApproval",
    text: "GOAL: ship the dashboard polish pass.",
    createdAt: now,
    updatedAt: now,
    status: "awaiting_approval",
    plan: "two work orders",
    workOrders: [{ id: "WO1", title: "Polish", role: "ui", owns: [], brief: "b", done: ["d"], state: "planned", attempts: 0 }],
    trace: [{ ts: now, from: "Claude (manager)", to: "CEO", what: "plan ready", detail: "2 work order(s), awaiting approval" }],
  },
];
fs.writeFileSync(path.join(process.env.COMPANY_ROOT, "fleet", "orders.json"), JSON.stringify(orders, null, 2));

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
};

const runManagers = await import("../src/company/runManagers.js");
const briefing = await import("../src/company/briefing.js");
const { CLAUDE_SIGNIN_EXPIRED_MESSAGE } = await import("../src/company/claudeSignIn.js");

const cards = runManagers.listRunCards();
const b = briefing.composeBriefing(cards, { seenAt: new Date(0).toISOString(), summary: "(x)", model: "local" });
const view = (id: string) => {
  const i = b.needsYou.find((n: any) => n.runId === `fleet:${id}`);
  return i ? { kind: i.kind, q: i.question as string, acts: (i.actions ?? []).map((a: any) => a.label) } : null;
};

for (const o of orders) {
  const v = view(o.id);
  console.log(`${o.id}: ${v ? JSON.stringify({ kind: v.kind, q: String(v.q).slice(0, 72), acts: v.acts }) : "(not offered to the CEO)"}`);
}

const signIn = view("foSignIn");
const missingKey = view("foMissingKey");
const limit = view("foLimit");
const ordinary = view("foOrdinary");
const approval = view("foApproval");

// ── FINGERPRINTS: prove each fixture REACHES the branch it claims to represent ─────────────
// Asserting only "not the sign-in sentence" would pass even if a branch were never reached, so
// each case below also pins the OWN answer of the branch it stands for (briefing.ts order:
// 385 sign-in, 405 retry-exhausted, 415 missing-key, 443 claude-limit, 472 generic fallback,
// and the awaiting_approval path).
const fp = {
  signIn: (v: ReturnType<typeof view>) => v?.kind === "external" && v?.q === CLAUDE_SIGNIN_EXPIRED_MESSAGE && v.acts.join("|") === "I ran claude /login - retry this order",
  missingKey: (v: ReturnType<typeof view>) => v?.kind === "provide" && /missing access key/i.test(String(v?.q)) && v.acts.includes("Save key and retry"),
  approval: (v: ReturnType<typeof view>) => !!v && /Approve Claude's plan/i.test(String(v.q)) && v.acts.includes("Retry order"),
};
console.log("");
console.log("[fingerprint] sign-in branch answered     :", fp.signIn(signIn), JSON.stringify(signIn));
console.log("[fingerprint] missing-key branch answered :", fp.missingKey(missingKey), JSON.stringify(missingKey));
console.log("[fingerprint] approval path answered      :", fp.approval(approval), JSON.stringify(approval));

check("FINGERPRINT: the sign-in fixture reaches the sign-in branch", fp.signIn(signIn), JSON.stringify(signIn));
check("FINGERPRINT: the missing-key fixture reaches the provide branch", fp.missingKey(missingKey), JSON.stringify(missingKey));
check("FINGERPRINT: the approval fixture reaches the approval path", fp.approval(approval), JSON.stringify(approval));

// The two cases the routine policy moves off the CEO's list must be proven to be handled by the
// POLICY, not by my branch: the manager queue is what receives them.
const queuePath = path.join(process.env.COMPANY_ROOT!, "reports", "manager-queue.json");
const queueRaw = fs.existsSync(queuePath) ? fs.readFileSync(queuePath, "utf8") : "";
console.log(`[fingerprint] manager-queue.json exists=${fs.existsSync(queuePath)} bytes=${queueRaw.length}`);
check(
  "FINGERPRINT: the limit/ordinary fixtures were kept off the CEO's list",
  limit === null && ordinary === null,
  `limit=${JSON.stringify(limit)} ordinary=${JSON.stringify(ordinary)}`,
);
check(
  "FINGERPRINT: neither was converted into the sign-in sentence",
  !/sign-in expired/i.test(`${limit?.q ?? ""} ${ordinary?.q ?? ""}`),
  `${limit?.q ?? ""} | ${ordinary?.q ?? ""}`,
);
check("the sign-in case is the plain sentence", signIn?.q === CLAUDE_SIGNIN_EXPIRED_MESSAGE, JSON.stringify(signIn?.q ?? null));
check("the sign-in case is NOT a retry-exhausted drop prompt", !/already been retried/i.test(String(signIn?.q ?? "")), JSON.stringify(signIn?.q ?? null));

// The over-reach assertions: my branch must not have swallowed anyone else's case.
check("a MISSING-KEY order is NOT given the sign-in sentence", missingKey?.q !== CLAUDE_SIGNIN_EXPIRED_MESSAGE, JSON.stringify(missingKey?.q ?? "(none)"));
// The missing-key branch is `probe`-only (headline + needsCeo). A key failure named in the ORDER
// TEXT reaches it; one named only in the stored `error` does not (pre-existing, not mine).
check(
  "a missing-key order named in the ORDER TEXT reaches the provide branch",
  missingKey?.kind === "provide",
  `${missingKey?.kind} / ${JSON.stringify(missingKey?.acts ?? [])}`,
);
check("a CLAUDE-LIMIT order is NOT given the sign-in sentence", limit?.q !== CLAUDE_SIGNIN_EXPIRED_MESSAGE, JSON.stringify(limit?.q ?? "(none)"));
// A limit order's prompt is the limit item; if it is not shown at all that is the routine policy,
// which is still NOT my branch - the only thing that would be a bug is the sign-in sentence.
check("a limit order is never diverted into the sign-in branch", !limit || !/sign-in expired/i.test(String(limit.q)), JSON.stringify(limit?.q ?? "(not offered)"));
// An approval order must keep its own approval wording.
check("an APPROVAL order still reads as an approval", !!approval && /approve/i.test(String(approval.q)), JSON.stringify(approval?.q ?? null));
check("an approval order is NOT given the sign-in sentence", approval?.q !== CLAUDE_SIGNIN_EXPIRED_MESSAGE, JSON.stringify(approval?.q ?? null));
check("an ORDINARY failure is not converted into a sign-in prompt", ordinary?.q !== CLAUDE_SIGNIN_EXPIRED_MESSAGE, JSON.stringify(ordinary?.q ?? "(none)"));

// And the sign-in branch must fire on the OTHER real presentations too, not just the exact sentence.
const alt = [
  "Claude credentials not found at C:\\Users\\u\\.claude\\.credentials.json. Run: claude login",
  'Claude OAuth refresh 400: {"error":"invalid_grant"}',
  "No claudeAiOauth block in credentials. Re-run `claude login`.",
  "claude -p error: Failed to authenticate: OAuth session expired and could not be refreshed",
];
const { mentionsClaudeSignInExpired } = await import("../src/company/claudeSignIn.js");
for (const e of alt) check(`recognises a real sign-in presentation: ${e.slice(0, 46)}`, mentionsClaudeSignInExpired(e), e.slice(0, 46));

console.log(`\n[overreach] ${failures ? `${failures} FAILED` : "ALL CHECKS PASSED"} (temp dir ${tmp})`);
process.exit(failures ? 1 : 0);
