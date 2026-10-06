// ops/start-view-check.ts — proof for order B3 (docs/overnight/ORDER_B3-start-page.md).
//
// The Start here view (public/v2/views/start.js) is browser code, so this check
// tests only its pure parts and makes no network calls and touches no DOM:
//   checklistFromData(data)  -> rows with a green/amber/red dot and one sentence
//   canSubmit(text)          -> whether an order is ready to send
//
// Run:  npx tsx ops/start-view-check.ts

import { canSubmit, checklistFromData, MAX_ORDER_CHARS } from "../public/v2/views/start.js";

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n        ${detail}`);
  if (!ok) failures += 1;
}

type Row = { key: string; dot: string; text: string; retry?: boolean };
const rowsOf = (data: unknown): Row[] => checklistFromData(data) as Row[];
const row = (data: unknown, key: string): Row | undefined => rowsOf(data).find((r) => r.key === key);
const textOf = (data: unknown, key: string): string => (row(data, key) || { text: "" }).text;

// A key-shaped string: anything that looks like an API key or a long hex token.
const KEY_SHAPED = /\b(sk-[A-Za-z0-9_-]{12,}|[A-Fa-f0-9]{32,}|[A-Za-z0-9_-]{40,})\b/;

// The live data shape of the five routes the page reads, all healthy.
const ALL_GREEN = {
  health: { ok: true },
  laya: { ok: true },
  budget: {
    providers: {
      go: { id: "opencode-go", remainingPct: 82, bindingWindow: "weekly" },
      deepseek: { id: "deepseek-direct", balanceUsd: 4.5, currency: "USD" },
    },
  },
  // The live routing policy does NOT expose GitHub publishing: no github field.
  routing: { generatedAt: "2026-10-06T07:00:00.000Z", go: { known: true, remainingPct: 82 } },
  workers: { live: [{ name: "w1" }, { name: "w2" }], recent: [], queued: [] },
};

// ---------------------------------------------------------------------------
// 1. all-green data gives all green
// ---------------------------------------------------------------------------
{
  const rows = rowsOf(ALL_GREEN);
  const bad = rows.filter((r) => r.dot !== "green");
  check(
    "all-green data gives all green",
    rows.length >= 4 && bad.length === 0 && rows.every((r) => r.text.length > 0),
    `${rows.length} rows, dots=[${rows.map((r) => r.dot).join(", ")}]`,
  );
}

// ---------------------------------------------------------------------------
// 2. Laya down -> amber with the optional wording, never red
// ---------------------------------------------------------------------------
{
  const down = { ...ALL_GREEN, laya: { ok: false } };
  const err = { ...ALL_GREEN, laya: new Error("connect ECONNREFUSED 127.0.0.1:8000") };
  const r1 = row(down, "laya");
  const r2 = row(err, "laya");
  const wording = /optional: routing falls back to simple rules/;
  check(
    "Laya down gives amber with the optional wording and not red",
    !!r1 && r1.dot === "amber" && wording.test(r1.text) && r1.dot !== "red" &&
      !!r2 && r2.dot === "amber" && wording.test(r2.text) && r2.dot !== "red",
    `ok:false -> ${r1 && r1.dot} "${r1 && r1.text}" | error -> ${r2 && r2.dot}`,
  );
}

// ---------------------------------------------------------------------------
// 3. router down -> red with a retry hint
// ---------------------------------------------------------------------------
{
  const down = { ...ALL_GREEN, health: new Error("fetch failed") };
  const r = row(down, "router");
  check(
    "router down gives red with a retry hint",
    !!r && r.dot === "red" && /retry/i.test(r.text),
    `${r && r.dot} "${r && r.text}"`,
  );
}

// ---------------------------------------------------------------------------
// 4. budget numbers in plain words, no key-shaped string
// ---------------------------------------------------------------------------
{
  const text = textOf(ALL_GREEN, "budget");
  const hasQuota = /OpenCode quota: 82% left/.test(text);
  const hasCredit = /prepaid credit: \$4\.50/.test(text);
  const saysFirst = /used first/.test(text);
  check(
    "budget numbers are rendered in plain words and contain no key-shaped string",
    hasQuota && hasCredit && saysFirst && !KEY_SHAPED.test(text),
    `"${text}"`,
  );
}

// ---------------------------------------------------------------------------
// 5. a missing GitHub field omits the line (and an exposed one is shown)
// ---------------------------------------------------------------------------
{
  const omitted = !row(ALL_GREEN, "github");
  const exposed = row({ ...ALL_GREEN, routing: { github: { connected: true } } }, "github");
  check(
    "a missing GitHub field omits the line",
    omitted && omitted === true && !!exposed && exposed.dot === "green",
    `missing -> ${omitted ? "omitted" : "PRESENT"} | exposed -> ${exposed ? exposed.dot : "absent"}`,
  );
}

// ---------------------------------------------------------------------------
// 6. canSubmit
// ---------------------------------------------------------------------------
{
  const longText = "x".repeat(MAX_ORDER_CHARS + 1);
  const empty = canSubmit("") === false && canSubmit("   \n  ") === false;
  const placeholder = canSubmit("Add a comment to <your file> explaining the header.") === false;
  const tooLong = canSubmit(longText) === false;
  const normal = canSubmit("Add a short description at the top of docs/HANDOVER.md.") === true;
  check(
    "canSubmit rejects empty text, <your file> and text over the limit, and accepts a normal order",
    empty && placeholder && tooLong && normal,
    `empty=${empty} placeholder=${placeholder} tooLong=${tooLong} normal=${normal}`,
  );
}

console.log(
  failures === 0
    ? `\nPASS all checks (${MAX_ORDER_CHARS} char limit)`
    : `\nFAIL ${failures} check(s)`,
);
process.exitCode = failures === 0 ? 0 : 1;
