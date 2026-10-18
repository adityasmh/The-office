// NY-CHAT unit tests for the needs-you chat flow in src/company/assistant.ts.
// Runs in isolation via a temporary COMPANY_ROOT so the live company/ tree is untouched.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ny-chat-test-"));
process.env.COMPANY_ROOT = tmpDir;

// Ensure the reports directory exists before any import tries to read it.
fs.mkdirSync(path.join(tmpDir, "reports"), { recursive: true });

const {
  askNeedsYouInChat,
  tryResolveFromChat,
  setNeedsYouResolverForTest,
} = await import("../src/company/assistant.js");

type ActionStub = { id: string; label: string; effect?: string };
type ItemStub = {
  id: string;
  text: string;
  kind?: "approve" | "choice" | "provide" | "external";
  question?: string;
  input?: { name: string; label: string; secret: boolean };
  actions?: ActionStub[];
};

function writeBriefing(needsYou: ItemStub[]) {
  fs.mkdirSync(path.join(tmpDir, "reports"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "reports", "briefing.json"), JSON.stringify({ needsYou }, null, 2));
}

function writeAsked(asked: Record<string, { at: string }>) {
  fs.mkdirSync(path.join(tmpDir, "reports"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "reports", "needs-you-asked.json"), JSON.stringify(asked, null, 2));
}

function clearState() {
  const threadFile = path.join(tmpDir, "assistant.jsonl");
  const askedFile = path.join(tmpDir, "reports", "needs-you-asked.json");
  for (const f of [threadFile, askedFile]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      // ignore
    }
  }
  // Reset the injected resolver between tests.
  setNeedsYouResolverForTest(undefined);
}

function readThread(): { role: string; text: string }[] {
  const file = path.join(tmpDir, "assistant.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { role: string; text: string });
}

function readAsked(): Record<string, { at: string }> {
  const file = path.join(tmpDir, "reports", "needs-you-asked.json");
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, { at: string }>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// 1. A numbered reply resolves the right action on the most recently asked item.
{
  clearState();
  const calls: { itemId: string; actionId: string; who?: string }[] = [];
  setNeedsYouResolverForTest(async (itemId, actionId, _input, who) => {
    calls.push({ itemId, actionId, who });
    return { ok: true, message: "Done.", itemId, actionId, needsYou: [] };
  });

  writeBriefing([
    {
      id: "fleet:fomun56n41",
      text: "Fleet order voice project",
      kind: "choice",
      question: "Retry this order or drop it?",
      actions: [
        { id: "retry", label: "Retry order", effect: "retry_order" },
        { id: "drop", label: "Drop order", effect: "drop_order" },
      ],
    },
  ]);
  writeAsked({ "fleet:fomun56n41": { at: new Date().toISOString() } });

  const result = await tryResolveFromChat("2");
  console.log("DEBUG asked file:", fs.existsSync(path.join(tmpDir, "reports", "needs-you-asked.json")));
  console.log("DEBUG briefing file:", fs.existsSync(path.join(tmpDir, "reports", "briefing.json")));
  console.log("DEBUG briefing content:", fs.readFileSync(path.join(tmpDir, "reports", "briefing.json"), "utf8"));
  console.log("DEBUG asked content:", fs.readFileSync(path.join(tmpDir, "reports", "needs-you-asked.json"), "utf8"));
  console.log("DEBUG calls:", calls, "result:", result);
  assert.notStrictEqual(result, null, "numbered reply should resolve");
  assert.strictEqual(result!.itemId, "fleet:fomun56n41");
  assert.strictEqual(result!.actionId, "drop");
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].who, "ceo-chat");
  console.log("PASS: numbered reply resolves the right action");
}

// 2. 'use kimi' picks the use_kimi action.
{
  clearState();
  const calls: { itemId: string; actionId: string }[] = [];
  setNeedsYouResolverForTest(async (itemId, actionId) => {
    calls.push({ itemId, actionId });
    return { ok: true, message: "Switched to Kimi.", itemId, actionId, needsYou: [] };
  });

  writeBriefing([
    {
      id: "budget:claude",
      text: "Claude is nearly out.",
      kind: "external",
      question: "Claude hit its spending limit. Raise it at claude.ai, use Kimi instead, or tell us you raised it.",
      actions: [
        { id: "open_limit_page", label: "Open Claude usage settings", effect: "open_link" },
        { id: "use_kimi", label: "Retry every Claude-limit order with Kimi", effect: "reissue_kimi" },
        { id: "raised_retry", label: "I raised the limit - recheck budget", effect: "recheck_budget" },
      ],
    },
  ]);
  writeAsked({ "budget:claude": { at: new Date().toISOString() } });

  const result = await tryResolveFromChat("use kimi");
  assert.notStrictEqual(result, null, "'use kimi' should resolve");
  assert.strictEqual(result!.itemId, "budget:claude");
  assert.strictEqual(result!.actionId, "use_kimi");
  console.log("PASS: 'use kimi' picks use_kimi");
}

// 3. An unrelated order returns null.
{
  clearState();
  let called = false;
  setNeedsYouResolverForTest(async () => {
    called = true;
    return { ok: true, message: "unexpected", itemId: "", actionId: "" };
  });

  writeBriefing([
    {
      id: "fleet:fomun56n41",
      text: "Fleet order voice project",
      kind: "choice",
      question: "Retry this order or drop it?",
      actions: [
        { id: "retry", label: "Retry order" },
        { id: "drop", label: "Drop order" },
      ],
    },
  ]);
  writeAsked({ "fleet:fomun56n41": { at: new Date().toISOString() } });

  const result = await tryResolveFromChat("what is the weather today");
  assert.strictEqual(result, null, "unrelated order should return null");
  assert.strictEqual(called, false, "resolver should not be called for unrelated order");
  console.log("PASS: unrelated order returns null");
}

// 4. Ambiguous input returns null when it could match multiple items.
{
  clearState();
  let called = false;
  setNeedsYouResolverForTest(async () => {
    called = true;
    return { ok: true, message: "unexpected", itemId: "", actionId: "" };
  });

  writeBriefing([
    {
      id: "readme-approve",
      text: "Approve the README update",
      kind: "approve",
      question: "Approve the README update?",
      actions: [
        { id: "approve", label: "Approve" },
        { id: "drop", label: "Drop" },
      ],
    },
    {
      id: "voice-approve",
      text: "Approve the voice feature",
      kind: "approve",
      question: "Approve the voice feature?",
      actions: [
        { id: "approve", label: "Approve" },
        { id: "drop", label: "Drop" },
      ],
    },
  ]);
  writeAsked({
    "readme-approve": { at: "2026-09-29T20:00:00.000Z" },
    "voice-approve": { at: "2026-09-29T21:00:00.000Z" },
  });

  const result = await tryResolveFromChat("approve");
  assert.strictEqual(result, null, "ambiguous 'approve' should return null");
  assert.strictEqual(called, false, "resolver should not be called for ambiguous input");
  console.log("PASS: ambiguous input returns null");
}

// 5. A provide item is never resolved from chat.
{
  clearState();
  let called = false;
  setNeedsYouResolverForTest(async () => {
    called = true;
    return { ok: true, message: "unexpected", itemId: "", actionId: "" };
  });

  writeBriefing([
    {
      id: "fleet:key",
      text: "Missing Kimi access key",
      kind: "provide",
      input: { name: "OPENCODE_API_KEY", label: "Kimi access key", secret: true },
      actions: [
        { id: "save_key_retry", label: "Save key and retry", effect: "provide_key" },
        { id: "drop", label: "Drop order", effect: "drop_order" },
      ],
    },
  ]);
  writeAsked({ "fleet:key": { at: new Date().toISOString() } });

  const result = await tryResolveFromChat("save key");
  assert.strictEqual(result, null, "provide item should never resolve from chat");
  assert.strictEqual(called, false, "resolver should not be called for provide item");
  console.log("PASS: provide item is never resolved from chat");
}

// 6. askNeedsYouInChat asks each item only once.
{
  clearState();
  writeBriefing([
    {
      id: "budget:claude",
      text: "Claude is nearly out.",
      kind: "external",
      question: "Claude hit its spending limit?",
      actions: [
        { id: "use_kimi", label: "Use Kimi" },
        { id: "raised_retry", label: "I raised it" },
      ],
    },
    {
      id: "fleet:key",
      text: "Missing Kimi access key",
      kind: "provide",
      input: { name: "OPENCODE_API_KEY", label: "Kimi access key", secret: true },
      actions: [{ id: "save_key_retry", label: "Save key and retry" }],
    },
  ]);

  const first = askNeedsYouInChat();
  assert.strictEqual(first, 2, "first pass should ask both items");

  const threadAfterFirst = readThread();
  assert.strictEqual(threadAfterFirst.length, 2, "two assistant messages should be appended");
  assert.ok(
    threadAfterFirst.every((m) => m.role === "assistant"),
    "thread entries should be assistant role"
  );
  assert.ok(
    threadAfterFirst[1].text.includes("masked field"),
    "provide item should ask to use the masked field"
  );

  const asked = readAsked();
  assert.ok(asked["budget:claude"], "budget:claude should be recorded as asked");
  assert.ok(asked["fleet:key"], "fleet:key should be recorded as asked");

  const second = askNeedsYouInChat();
  assert.strictEqual(second, 0, "second pass should ask nothing");

  const threadAfterSecond = readThread();
  assert.strictEqual(threadAfterSecond.length, 2, "thread should not grow on second pass");
  console.log("PASS: askNeedsYouInChat asks each item only once");
}

console.log("\nAll NY-CHAT tests passed.");
