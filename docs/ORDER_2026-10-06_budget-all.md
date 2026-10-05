# Order BUDGET-ALL: the Budget page must show every budget, not only the binding one

Narrow job. Do exactly these steps, print the final report, and END your turn. Do not wait, poll, loop, or re-read this order.

## Why
`public/v2/views/budget.js` shows, per provider, one big number: the BINDING window (for OpenCode Go that is the monthly 50%). The data already carries every window, and the CEO wants all of them visible at once.

Live data shape from `GET /company/budget/real` (read it, do not change the server):
- `providers.go.windows`: `[{window:"5-hour",usedPct:3,remainingPct:97,resetsAt,resetsIn:"3h 1m"}, {window:"weekly",remainingPct:99,resetsIn:"6d 2h"}, {window:"monthly",remainingPct:50,resetsIn:"23d 23h"}]`, plus `bindingWindow`.
- `providers.claude.windows`: `[{window:"5-hour window",remainingPct:70,resetsIn:"2h 7m"}, {window:"7-day window",remainingPct:61,resetsIn:"1d 12h"}]` and `noDollarBudget:true`.
- `providers.deepseek`: no windows; `balanceUsd`, `currency`, `armed`, `phase`, `phaseLine`, `keyPresent`.
- `spend`: measured spend today, 7 days, all recorded.

## Rules
- Edit ONLY `public/v2/views/budget.js` and create `ops/budget-rows-check.mjs`. Do NOT edit the server or any other file.
- Make changes with small targeted edits, never rewrite an entire file.
- Never restart or start the router. Never touch `.env`, `company/`, Laya, Kafka, or scheduled tasks. No network calls in your check. Do not print secrets.
- Plain words and clear numbers, no visual polish. Keep every existing section working (provider cards, brain gate, spend tables); this is an addition and a wiring fix.
- Run each command ONCE, in the foreground. If a step fails, report the exact error and END your turn; do not retry in a loop.

## What to build
1. A pure function `budgetRows(real)` in `budget.js` (export it; it must not touch the DOM or `window`) that returns one array for the "all budgets" strip: for OpenCode Go one row per window, for Claude one row per window, for DeepSeek one row with the credit balance. Each row: `{provider, label, remainingPct (number or null), usedPct, resetsIn, binding (true when it is the provider's binding window), note}`. The DeepSeek row has `remainingPct: null`, `label: "credit balance"`, `note` like "$2.39 of prepaid credit, used only when OpenCode Go runs low" and shows `armed` and `phaseLine` in plain words. A provider that is not connected yields one row saying "not measured" with the reason (never an invented number).
2. A new card at the TOP of the Budget page, titled "All budgets", rendering those rows: provider heading, then per row the label, a bar of the percent left, the number ("97% left"), "resets in ...", and a small "limiting" tag on the binding window. Colour the bar using the same severity classes the page already uses (reuse `LEVEL_CLASS` or the same thresholds the page already reads from the data); if no thresholds are available use: 15% or less red, 40% or less amber, otherwise green. Also show the measured spend line (today, 7 days, all recorded) under it.
3. Wiring fix: in the existing "Provider limits (real)" section the DeepSeek card is chosen with `p.id === "deepseek-direct"`, but the live id is `deepseek`, so that card falls into the windows branch and says "no quota window was reported". Accept both ids.
4. In the existing large `providerCard`, below the binding number, add one compact line listing every window of that provider ("5-hour 97% - weekly 99% - monthly 50%") using the data already on the page (`real.providers` for the same provider id); show nothing extra if the provider has no windows.

## Proof
`ops/budget-rows-check.mjs` must import `budgetRows` from `public/v2/views/budget.js` (if the file cannot be imported in Node because of top-level browser imports, move the pure function into a new file `public/v2/views/budgetRows.js` that has no imports, import it from `budget.js`, and test that file instead). Print PASS or FAIL per line, using the live data shape above as a fixture:
- OpenCode Go yields 3 rows with the right percentages and exactly one `binding` row (monthly).
- Claude yields 2 rows and `noDollarBudget` shows in a note.
- DeepSeek yields one balance row with the right dollar text and `remainingPct` null.
- A disconnected provider yields one "not measured" row and no percentage.
- A provider with no windows and no balance does not crash and yields one row saying nothing was reported.

## Finish
1. Run `node ops/budget-rows-check.mjs` once.
2. Write `docs/REPORT_2026-10-06_BUDGET-ALL.md` with the changed line ranges, the exact output, and any open issue. Print the same report and END your turn.
