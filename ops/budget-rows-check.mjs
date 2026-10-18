// ops/budget-rows-check.mjs — proof for CEO order BUDGET-ALL.
//
// The Budget page used to show one big number per provider: the BINDING window.
// `budgetRows(real)` in public/v2/views/budget.js now flattens every window of
// every provider (plus the DeepSeek credit balance) into one list for the new
// "All budgets" strip at the top of the page.
//
// This check imports that pure function and feeds it a fixture in the LIVE shape
// of GET /company/budget/real (the same shape the work order documents). It makes
// no network calls and prints PASS or FAIL per line. Run:
//   node ops/budget-rows-check.mjs

import { budgetRows } from "../public/v2/views/budget.js";

// The fixture: exactly the live data shape from the work order.
const fixture = {
  providers: {
    go: {
      id: "opencode-go",
      label: "OpenCode Go",
      kind: "quota",
      connected: true,
      windows: [
        { window: "5-hour", usedPct: 3, remainingPct: 97, resetsAt: "2026-10-06T02:00:00.000Z", resetsIn: "3h 1m" },
        { window: "weekly", remainingPct: 99, resetsIn: "6d 2h" },
        { window: "monthly", remainingPct: 50, resetsIn: "23d 23h" },
      ],
      bindingWindow: "monthly",
    },
    claude: {
      id: "claude",
      label: "Claude",
      kind: "subscription",
      connected: true,
      noDollarBudget: true,
      windows: [
        { window: "5-hour window", remainingPct: 70, resetsIn: "2h 7m" },
        { window: "7-day window", remainingPct: 61, resetsIn: "1d 12h" },
      ],
      bindingWindow: "5-hour window",
    },
    deepseek: {
      id: "deepseek-direct",
      label: "DeepSeek direct API",
      kind: "balance",
      connected: true,
      windows: [],
      balanceUsd: 2.39,
      currency: "USD",
      armed: true,
      keyPresent: true,
      phaseLine: "off-peak (0.5x) until 06:30 IST",
      detail: "DeepSeek credit: USD 2.39 (topped up 2.39, granted 0.00).",
    },
    // Not connected: must yield one "not measured" row with the reason.
    gemini: {
      id: "gemini",
      label: "Gemini",
      connected: false,
      windows: [],
      balanceUsd: null,
      notMeasured: "no GEMINI_API_KEY in .env",
    },
    // Connected but nothing to report: must not crash, one row.
    mistral: {
      id: "mistral",
      label: "Mistral",
      connected: true,
      windows: [],
      balanceUsd: null,
      detail: "connected, but no quota window and no balance was reported",
    },
  },
  spend: { todayUsd: 1.23, last7dUsd: 8.5, allTimeUsd: 42.125 },
};

let failed = 0;
function check(label, ok, evidence) {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} - ${label}${evidence === undefined ? "" : ` (${evidence})`}`);
}

const rows = budgetRows(fixture);
const only = (provider) => rows.filter((r) => r.provider === provider);

// --- 1. OpenCode Go: one row per window, exactly one binding row (monthly). ---
const go = only("OpenCode Go");
check("OpenCode Go yields 3 rows", go.length === 3, `got ${go.length}`);
check(
  "OpenCode Go rows carry the right percentages",
  JSON.stringify(go.map((r) => r.remainingPct)) === JSON.stringify([97, 99, 50]),
  JSON.stringify(go.map((r) => r.remainingPct)),
);
const goBinding = go.filter((r) => r.binding);
check(
  "OpenCode Go has exactly one binding row and it is monthly",
  goBinding.length === 1 && goBinding[0].label === "monthly",
  JSON.stringify(goBinding.map((r) => r.label)),
);
check(
  "OpenCode Go window rows carry reset text",
  go.every((r) => typeof r.resetsIn === "string" && r.resetsIn.length > 0),
  JSON.stringify(go.map((r) => r.resetsIn)),
);

// --- 2. Claude: 2 rows, and noDollarBudget shows in a note. ---
const claude = only("Claude");
check("Claude yields 2 rows", claude.length === 2, `got ${claude.length}`);
check(
  "Claude rows say it is a subscription with no dollar budget",
  claude.length === 2 && claude.every((r) => /no dollar budget/i.test(r.note || "")),
  JSON.stringify(claude.map((r) => r.note)),
);

// --- 3. DeepSeek: one balance row, right dollar text, remainingPct null. ---
const ds = only("DeepSeek direct API");
check("DeepSeek yields one balance row", ds.length === 1, `got ${ds.length}`);
check(
  "DeepSeek row is the credit balance with remainingPct null",
  ds.length === 1 && ds[0].label === "credit balance" && ds[0].remainingPct === null,
  ds.length === 1 ? `${ds[0].label} / remainingPct=${ds[0].remainingPct}` : "no row",
);
check(
  "DeepSeek row shows the right dollar text, the phase and armed state",
  ds.length === 1 &&
    /\$2\.39 of prepaid credit/.test(ds[0].note || "") &&
    /off-peak \(0\.5x\) until 06:30 IST/.test(ds[0].note || "") &&
    /direct routing armed/i.test(ds[0].note || ""),
  ds.length === 1 ? ds[0].note : "no row",
);

// --- 4. A disconnected provider: one "not measured" row, no percentage. ---
const gem = only("Gemini");
check("Disconnected provider yields one row", gem.length === 1, `got ${gem.length}`);
check(
  'Disconnected provider row says "not measured" with the reason and no number',
  gem.length === 1 &&
    gem[0].label === "not measured" &&
    gem[0].remainingPct === null &&
    /no GEMINI_API_KEY/.test(gem[0].note || ""),
  gem.length === 1 ? `${gem[0].label} / remainingPct=${gem[0].remainingPct} / ${gem[0].note}` : "no row",
);

// --- 5. No windows and no balance: must not crash, one "nothing reported" row. ---
const mis = only("Mistral");
check("Provider with no windows and no balance does not crash and yields one row", mis.length === 1, `got ${mis.length}`);
check(
  "That row reports nothing was measured, with no invented number",
  mis.length === 1 && mis[0].remainingPct === null && /reported/i.test(mis[0].label),
  mis.length === 1 ? `${mis[0].label} / remainingPct=${mis[0].remainingPct}` : "no row",
);

// --- Shape and robustness. ---
const shapeKeys = ["provider", "label", "remainingPct", "usedPct", "resetsIn", "binding", "note"];
check(
  "Every row has the exact required shape",
  rows.every((r) => shapeKeys.every((k) => k in r) && typeof r.binding === "boolean"),
  `checked ${rows.length} rows`,
);
let threw = null;
try {
  budgetRows(null);
  budgetRows({});
  budgetRows({ providers: { x: { connected: true } } });
} catch (e) {
  threw = String(e && e.message ? e.message : e);
}
check("budgetRows tolerates null/empty/partial input", threw === null, threw || "no throw");
check("budgetRows returns the expected total row count", rows.length === 8, `got ${rows.length}`);

console.log(`\n${failed === 0 ? "ALL PASS" : `${failed} FAILED`} - ${rows.length} rows from the live-shape fixture`);
process.exitCode = failed === 0 ? 0 : 1;
