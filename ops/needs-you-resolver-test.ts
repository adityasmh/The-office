/**
 * ops/needs-you-resolver-test.ts - unit-style test for the needs-you resolver.
 *
 * Run with: npx tsx ops/needs-you-resolver-test.ts
 *
 * CEO APPROVAL POLICY (2026-09-30): a plain "Retry this order or drop it?" prompt for a
 * failed order is no longer the CEO's decision, so it is NOT in the needs-you list any more
 * (it is handed to the manager queue). The resolver is therefore exercised with the items the
 * CEO still answers: a key/secret prompt, a spending-limit prompt and a gate approval.
 *
 * Safety: uses a temp COMPANY_ROOT and backs up/restores the repo .env.
 * Exits non-zero on failure.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert";

const repoRoot = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ny-resolver-test-"));
const companyRoot = path.join(tmpDir, "company");
fs.mkdirSync(companyRoot, { recursive: true });

// Back up the real .env because the provide_key effect writes into it.
const envPath = path.join(repoRoot, ".env");
const envBackup = path.join(tmpDir, ".env.backup");
let envExisted = false;
if (fs.existsSync(envPath)) {
  fs.copyFileSync(envPath, envBackup);
  envExisted = true;
}

// Set environment BEFORE the dynamic imports so modules see the temp root.
process.env.COMPANY_ROOT = companyRoot;
process.env.MOCK_MODE = "1";
process.env.COMPANY_AUTH_TOKEN = "test-token";
process.env.OPENCODE_API_KEY = "old-key";
process.env.BRIEFING_SLACK = "0";

const { getBriefing, refreshBriefing } = await import("../src/company/briefing.js");
const { resolveNeedsYou, openNeedsYouItems } = await import("../src/company/needsYouActions.js");

const TEST_KEY = "oc_sk_test_secret_value_12345_xyz";

const cases: string[] = [];
function pass(name: string) {
  cases.push(name);
  console.log(`PASS ${name}`);
}

function readJson<T>(file: string): T | undefined {
  try {
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeRunCard(runId: string, card: unknown) {
  const dir = path.join(companyRoot, "reports", "runs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${runId.replace(/:/g, "_")}.json`), JSON.stringify(card));
}

function makeFleetCard(runId: string, headline: string, needsCeo?: string): unknown {
  const orderId = runId.replace("fleet:", "");
  return {
    runId,
    kind: "fleet",
    title: "test order",
    owner: "Fleet (Claude plans, jcode executes)",
    state: "failed",
    headline,
    done: [],
    remaining: [],
    ...(needsCeo ? { needsCeo } : {}),
    model: "local",
    modelReason: "test",
    checkedAt: new Date().toISOString(),
    evidenceHash: "test",
    reported: false,
    updatedAt: new Date().toISOString(),
    ref: { kind: "fleet", orderId },
    verdict: "FAIL",
    verdictReason: "test",
    verifiedAt: new Date().toISOString(),
  };
}

function writeFleetOrder(id: string, status: string, error: string) {
  const dir = path.join(companyRoot, "fleet");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "orders.json");
  let orders: Array<Record<string, unknown>> = [];
  try {
    orders = JSON.parse(fs.readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
  } catch {
    orders = [];
  }
  orders.push({
    id,
    text: `test order ${id}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status,
    workOrders: [],
    trace: [],
    error,
  });
  fs.writeFileSync(file, JSON.stringify(orders, null, 2));
}

const keyOrderId = "fomukeytest";
const claudeOrderId = "fomuclaudetest";
const plainOrderId = "fomoplaintest";

writeFleetOrder(keyOrderId, "failed", "Missing access key");
writeFleetOrder(claudeOrderId, "failed", "Claude hit its monthly spending limit");
// A plain failure: no risk keywords, so the prompt is routine (the manager's call).
writeFleetOrder(plainOrderId, "failed", "planning failed: TypeError: fetch failed");

writeRunCard(
  `fleet:${keyOrderId}`,
  makeFleetCard(
    `fleet:${keyOrderId}`,
    "The planning assistant's access key is missing.",
    "Add the missing access key for the Kimi assistant, then resend the order.",
  ),
);
writeRunCard(
  `fleet:${claudeOrderId}`,
  makeFleetCard(
    `fleet:${claudeOrderId}`,
    "Claude hit its monthly spending limit and could not plan.",
    "Claude hit its spending limit. Raise it, or approve a retry using only Kimi.",
  ),
);

// A plain failed order (routine retry/drop prompt: the manager's call, not the CEO's).
writeRunCard(
  `fleet:${plainOrderId}`,
  makeFleetCard(`fleet:${plainOrderId}`, "The order failed before any work started.", "Retry this order or drop it?"),
);

// A stored card for a fleet order that no longer exists on disk -> retry_order will fail.
// Its prompt mentions publishing to the real site, which is on the CEO's risk list, so this
// retry/drop prompt DOES stay with the CEO (the routine ones do not).
const badOrderId = "npmnonexistent";
writeRunCard(
  `fleet:${badOrderId}`,
  makeFleetCard(
    `fleet:${badOrderId}`,
    "The order failed before it could publish the update.",
    "Publish the update to the real site, or drop this order.",
  ),
);

await refreshBriefing({ force: true });
const initial = openNeedsYouItems();
assert.ok(initial.length >= 3, `expected at least 3 needs-you items, got ${initial.length}`);

const keyItem = initial.find((n) => n.id === `fleet:${keyOrderId}`);
assert.ok(keyItem, "key item should exist");
assert.strictEqual(keyItem!.kind, "provide");
const saveAction = keyItem!.actions?.find((a) => a.id === "save_key_retry");
assert.ok(saveAction, "save_key_retry action should exist");
assert.strictEqual(saveAction!.params?.envName, "OPENCODE_API_KEY");

const claudeItem = initial.find((n) => n.id === `fleet:${claudeOrderId}`);
assert.ok(claudeItem, "claude-limit item should exist");
assert.strictEqual(claudeItem!.kind, "external");
const claudeActionIds = (claudeItem!.actions ?? []).map((a) => a.id).sort();
assert.deepStrictEqual(claudeActionIds, ["open_limit_page", "raised_retry", "use_kimi"]);

const badItem = initial.find((n) => n.id === `fleet:${badOrderId}` || n.runId === `fleet:${badOrderId}`);
assert.ok(badItem, "bad retry item should exist");

// CEO APPROVAL POLICY: the plain retry/drop prompt is NOT shown to the CEO; it is handed to
// the manager queue, keyed on the job. (The queue's own lifecycle is proved in
// ops/manager-queue-check.ts.)
assert.ok(
  !initial.some((n) => n.id === `fleet:${plainOrderId}` || n.runId === `fleet:${plainOrderId}`),
  "a plain retry/drop prompt is not shown to the CEO",
);
const brief = getBriefing();
assert.ok(
  (brief.managerQueue ?? []).some((r) => r.runId === `fleet:${plainOrderId}`),
  "and it was handed to the manager queue instead",
);

pass("items-classified");

// ---------------------------------------------------------------------------
// 1. Unknown item returns ok:false.
// ---------------------------------------------------------------------------
const unknown = await resolveNeedsYou("does-not-exist", "approve");
assert.strictEqual(unknown.ok, false, "unknown item should fail");
assert.ok(unknown.message.includes("no longer waiting"), "unknown item message plain words");
pass("unknown-item-ok-false");

// ---------------------------------------------------------------------------
// 2. Save key, retry, and verify the key never leaks.
// ---------------------------------------------------------------------------
const captured: string[] = [];
const originalLog = console.log;
console.log = (...args: unknown[]) => {
  captured.push(args.map((a) => String(a)).join(" "));
};

const keyResult = await resolveNeedsYou(keyItem!.id!, "save_key_retry", { OPENCODE_API_KEY: TEST_KEY });

console.log = originalLog;

assert.strictEqual(keyResult.ok, true, "save_key_retry should succeed");
assert.ok(!keyResult.message.includes(TEST_KEY), "key must not appear in result message");

const resolved = JSON.stringify(readJson<Record<string, unknown>>(path.join(companyRoot, "reports", "needs-you-resolved.json")));
const decisions = JSON.stringify(readJson<unknown[]>(path.join(companyRoot, "reports", "needs-you-decisions.json")));
const output = captured.join("\n");

assert.ok(!resolved.includes(TEST_KEY), "key must not appear in resolved.json");
assert.ok(!decisions.includes(TEST_KEY), "key must not appear in decisions.json");
assert.ok(!output.includes(TEST_KEY), "key must not appear in captured console output");

// The .env line must have been updated.
const envText = fs.readFileSync(envPath, "utf8");
assert.ok(envText.includes(`OPENCODE_API_KEY=${TEST_KEY}`), ".env should contain the new key");
pass("key-saved-and-scrubbed");

// ---------------------------------------------------------------------------
// 3. Stale item returns ok:false.
// ---------------------------------------------------------------------------
const stale = await resolveNeedsYou(keyItem!.id!, "save_key_retry", { OPENCODE_API_KEY: TEST_KEY });
assert.strictEqual(stale.ok, false, "stale item should fail");
pass("stale-item-ok-false");

// ---------------------------------------------------------------------------
// 4. A failing effect leaves the item unresolved.
// ---------------------------------------------------------------------------
const failResult = await resolveNeedsYou(badItem!.id!, "retry");
assert.strictEqual(failResult.ok, false, "retry on missing order should fail");
assert.ok(
  openNeedsYouItems().some((n) => n.id === badItem!.id || n.runId === `fleet:${badOrderId}`),
  "bad item should still be present",
);
pass("failing-effect-keeps-item");

// ---------------------------------------------------------------------------
// 5. Exactly one decision log entry per resolve call.
// ---------------------------------------------------------------------------
const decisionLog = readJson<Array<Record<string, unknown>>>(path.join(companyRoot, "reports", "needs-you-decisions.json")) ?? [];
assert.strictEqual(decisionLog.length, 4, "one decision entry per call");
for (const entry of decisionLog) {
  assert.ok(entry.at && entry.itemId && entry.actionId && entry.effect, "decision entry has required fields");
  assert.strictEqual(typeof entry.ok, "boolean");
  assert.strictEqual(typeof entry.message, "string");
  assert.ok(!JSON.stringify(entry).includes(TEST_KEY), "decision entry must not contain key");
}
pass("one-decision-per-call");

// ---------------------------------------------------------------------------
// Cleanup.
// ---------------------------------------------------------------------------
if (envExisted) {
  fs.copyFileSync(envBackup, envPath);
} else {
  fs.rmSync(envPath, { force: true });
}
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log("\nALL NEEDS-YOU RESOLVER TESTS PASSED");
console.log(cases.join(", "));
