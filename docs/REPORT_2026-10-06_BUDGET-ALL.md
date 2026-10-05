# Report - BUDGET-ALL: the Budget page shows every budget, not only the binding one

Order: `docs/ORDER_2026-10-06_budget-all.md`. Worker: jcode. Date: 2026-10-06.

## What changed

Only two files were touched (`git diff --stat` shows `public/v2/views/budget.js`; the
check is new and untracked):

| File | Line range | Change |
|---|---|---|
| `public/v2/views/budget.js` | 66-193 | New pure `export function budgetRows(real)` (66-139) and new `allBudgetsCard(real, thresholds)` (141-193). Inserted between `money()` and `sparkline()`. |
| `public/v2/views/budget.js` | 227-230 | `providerCard` comment + signature: added the third argument `realBlock`. |
| `public/v2/views/budget.js` | 261-267 | In `providerCard`, below the binding number / reset line: one compact line listing every window of that provider, from `realBlock.windows` (nothing printed when there are no windows). |
| `public/v2/views/budget.js` | 378 | Wiring fix: `p.id === "deepseek-direct"` -> `p.id === "deepseek-direct" || p.id === "deepseek"`, so the live DeepSeek block takes the balance branch instead of the "no quota window was reported" branch. |
| `public/v2/views/budget.js` | 695-702 | In `mount`, the first card pushed is `allBudgetsCard(real, snap.thresholds)` (the new card is at the TOP of the page); `realGo` / `realClaude` are passed into `providerCard`. |
| `public/v2/views/budget.js` | 710 | `providerCard(...)` calls now pass the matching real block. |
| `public/v2/views/budget.js` | 691 | No-snapshot branch: `allBudgetsCard(real, null)` is rendered first (empty string when the real feed has not answered). |
| `ops/budget-rows-check.mjs` | new, 1-172 | Proof harness: imports `budgetRows` from the view, fixtures the live shape, prints PASS/FAIL per line, no network. |

`budgetRows` is pure (no DOM, no `window`, no network, no imports of its own) and sits
in `budget.js` itself: `budget.js` imports cleanly in Node (verified), so no separate
`budgetRows.js` was needed and the order's fallback was not used.

Row shape, exactly as ordered: `{provider, label, remainingPct, usedPct, resetsIn, binding, note}`.
- OpenCode Go / Claude: one row per window; `binding` true only on the provider's `bindingWindow`;
  Claude's `note` carries `subscription, no dollar budget` (from `noDollarBudget`).
- DeepSeek: one row, `label: "credit balance"`, `remainingPct: null`, note
  "$2.39 of prepaid credit, used only when OpenCode Go runs low. off-peak (0.5x) until 06:30 IST. Direct routing armed."
  (non-USD currency is shown after the amount; USD is left off, as in the order's example).
- Not connected: one row, label `not measured`, `remainingPct: null`, note = `notMeasured || detail`.
- Connected with no windows and no balance: one row, label `nothing reported`, no number.

Bar colour reuses `LEVEL_CLASS` (`sev-ok` / `sev-warn` / `sev-err`) with the snapshot's own
`thresholds.greenMin` / `thresholds.amberMin`; when those are absent (no-snapshot branch,
or an older snapshot) it falls back to 15% red / 40% amber. The strip also prints the
measured spend line: today / 7 days / all recorded.

## Exact output

Command: `node ops/budget-rows-check.mjs`

```
PASS - OpenCode Go yields 3 rows (got 3)
PASS - OpenCode Go rows carry the right percentages ([97,99,50])
PASS - OpenCode Go has exactly one binding row and it is monthly (["monthly"])
PASS - OpenCode Go window rows carry reset text (["3h 1m","6d 2h","23d 23h"])
PASS - Claude yields 2 rows (got 2)
PASS - Claude rows say it is a subscription with no dollar budget (["subscription, no dollar budget","subscription, no dollar budget"])
PASS - DeepSeek yields one balance row (got 1)
PASS - DeepSeek row is the credit balance with remainingPct null (credit balance / remainingPct=null)
PASS - DeepSeek row shows the right dollar text, the phase and armed state ($2.39 of prepaid credit, used only when OpenCode Go runs low. off-peak (0.5x) until 06:30 IST. Direct routing armed.)
PASS - Disconnected provider yields one row (got 1)
PASS - Disconnected provider row says "not measured" with the reason and no number (not measured / remainingPct=null / no GEMINI_API_KEY in .env)
PASS - Provider with no windows and no balance does not crash and yields one row (got 1)
PASS - That row reports nothing was measured, with no invented number (nothing reported / remainingPct=null)
PASS - Every row has the exact required shape (checked 8 rows)
PASS - budgetRows tolerates null/empty/partial input (no throw)
PASS - budgetRows returns the expected total row count (got 8)

ALL PASS - 8 rows from the live-shape fixture
```

Exit code 0. The first run of the check FAILED one line ("DeepSeek row shows the right
dollar text...") because the note read `$2.39 USD of prepaid credit`; the amount is now
formatted to the order's wording (`$2.39 of prepaid credit`), and the single re-run above
is the output reported here.

## Verification / scope

- Import check: `node --input-type=module -e "import('.../public/v2/views/budget.js')"` -> `IMPORT_OK goal,mount,title`.
  (One probe, before editing.) The check itself imports the view, so the whole file parses.
- Server, `.env`, `company/`, Laya, Kafka and scheduled tasks were not touched.
- No network calls in the check; no secret is read or printed.
- Every existing section (provider cards, brain gate, spend tables, provider-usage panel,
  rules, effects) is unchanged except the two additive lines described above.

## Open issues

1. Not rendered in a browser. This job's proof is the pure-function harness the order asked
   for; the card was not loaded in a live page (V8/Chrome DOM). The card reuses only existing
   classes (`card`, `card-head`, `row`, `bar`, `bar-fill`, `sev-*`, `pill pill-warn`, `tiny muted`),
   so it should render, but a visual smoke test was out of scope and was not run.
2. `budgetRows` reads `real.providers` only. The page passes `data.real` from `GET /company/budget`;
   if that field is absent but `GET /company/budget/real` succeeded, the strip is empty while the
   "Provider limits (real)" card is also empty today (same input), so the two stay consistent.
3. `docs/ORDER_2026-10-06_budget-all.md` already showed as modified in git before this job started;
   nothing here changed it.
