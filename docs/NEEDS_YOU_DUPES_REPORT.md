# Duplicate needs-you prompts: what was wrong and what changed

Job: DUPLICATE-PROMPTS (2026-09-30). The CEO kept seeing `Retry this order or drop it?`
from Joey, and `logs/router.out.log` held ~2267 copies of that line.

## Root causes

1. **A debug dump wrote the whole briefing on every poll.** `readOpenNeedsYouSync()`
   and `tryResolveFromChat()` in `src/company/assistant.ts` each `console.log`-ed the
   full briefing/asked/open objects. The 30 s chat interval called `readOpenNeedsYouSync`
   ~1230 times; every dump re-printed each needs-you item, so one open question became
   thousands of log lines. This is where the "2255 times" number came from.
2. **One prompt per failed order, however many copies of the job existed.** Every failed
   fleet order falls back to the same question (`Retry this order or drop it?`). The
   retry loop reissues an order as a NEW order id, so each copy raised its own identical
   prompt in the thread. Nothing collapsed copies of the same job.
3. **A dropped (cancelled) order was not closed.** `cancelFleetOrder` set `status =
   "cancelled"`, which the run manager read as `failed`; the prompt could come back
   after any card update unless a `needs-you-resolved.json` timestamp still hid it.
4. **Stale `needs-you-asked.json` records** piled up for runs that were already handled,
   so the chat's "asked once" ledger no longer meant anything.
5. **Joey could say `Needs you: nothing`** (the merged-task report tail) while the
   briefing had an open prompt.

## Changes

| File | Change |
|---|---|
| `src/company/assistant.ts` | Removed all `[DEBUG ...]` console dumps. `askNeedsYouInChat` groups items that share one question and asks once (marking every grouped run asked). `readOpenNeedsYouAsync` unions the briefing FILE with the resolver's live items, so chat and the page agree. New exported `reportTailLine()` never says `Needs you: nothing` while an item is open. Prompt rule updated to say the same. |
| `src/company/briefing.ts` | `composeBriefing` collects needs-you candidates with their card and keeps only the newest card per long title (`cardTitleKey`, >= 20 chars), so at most one prompt per run and per job. Items now carry `reason` (from `needsYouRule.classifyNeed`) and `title`. |
| `src/company/needsYouRule.ts` | New exported `orderTitleKey()`. `isSupersededOrder` now also treats a later order with the SAME title as superseding the older copy (not only a later finished one). |
| `src/company/runManagers.ts` | A cancelled fleet order gets a `dropped` closure, so it shows as done and never as failed. |
| `src/company/fleet.ts` | `cancelFleetOrder` records `closedAs="dropped"`, `closedReason`, `closedAt`, `closedBy` durably. |
| `src/company/needsYouActions.ts` | `reissueOrders` no longer mints a fresh copy when a newer order for the same job already exists; it just marks the old one superseded by that copy. This is what stops "retry" from regenerating duplicates. |
| `ops/needs-you-dedupe.ts` (new) | Data cleanup: closes older duplicate failed/cancelled orders, prunes `needs-you-asked.json` to the items still open, re-composes `briefing.json`, appends ONE consolidation note to Joey's thread. `--dry-run` supported. |
| `ops/needs-you-dedupe-test.ts` (new) | Acceptance probe for all of the above (isolated temp `COMPANY_ROOT`). |

## What the cleanup did on the live data

Ran `npx tsx ops/needs-you-dedupe.ts`:

- closed `fleet:fomumqiplo` and `fleet:fomumoiq1j` (cancelled) as `dropped`;
- cleared 10 stale entries from `needs-you-asked.json` (kept the 6 open ones);
- re-composed `briefing.json`; appended one consolidation note to `company/assistant.jsonl`;
- open needs-you items after cleanup: 6 distinct failed fleet jobs
  (`fomunz0ciu`, `fomunz0cbp`, `fomunyxv8p`, `fomunyyrme`, `fomunyq2z7`, `fomunyqgxm`).

No order was deleted. The CEO's existing thread messages were not rewritten.

## How to verify

```
npx tsc --noEmit
npx tsx ops/needs-you-dedupe-test.ts      # 33 PASS checks
npx tsx ops/needs-you-rule-check.ts       # 8 PASS checks
npx tsx ops/needs-you-rule-check.ts --live
npx tsx ops/needs-you-classify-test.ts    # 14 PASS checks
npx tsx ops/needs-you-chat-test.ts        # 6 PASS checks
npx tsx ops/needs-you-resolver-test.ts    # 6 PASS checks
```

## Further validation (round 2)

* **Hot path is not slowed.** `classifyNeed` (now called per card for the `reason` field)
  reads budget state through `readBudgetState()`, which is cached (5 s disk cache plus the
  watcher's live snapshot), so the briefing GET stays cheap.
* **Dedupe edge cases proven:** newest copy wins; if the newest copy is already resolved
  the older copy is still shown (dedupe never drops the only actionable prompt); the
  `NEEDS_MAX` cap still holds and there are no duplicate ids; short/generic titles and
  empty text are never merged; an older copy never supersedes a newer one.
* **Reissue guard proven:** with a newer copy of the same job on disk, `retry` mints no
  new order, marks the old one superseded, and points at the existing copy.
* **One source of truth:** `GET /api/needs-you` and the resolver both read
  `openNeedsYouItems()` (the deduped briefing). The inbox does not raise failed-run
  prompts of its own (it only does fleet plan approvals, REDO verdicts and budget).

## Live convergence (round 3)

* The fleet worker produced a SECOND copy of the chat-UI job after the first cleanup
  (`fomunypebj`, which then failed). Re-running the cleanup detected it as a duplicate of
  the newer `fomunyphtc`, closed it, and left 0 duplicates; a follow-up `--dry-run`
  reported `0 duplicate(s), 0 cancelled, 0 stale asked, 6 open`, i.e. the tool reaches a
  fixed point and is safe to re-run.
* Pruning caused no re-asks: after the first pass the only new chat prompt was for the
  genuinely new order `fomunypebj` (one prompt); no prompt was repeated for an id that was
  already asked.
* `npx tsc --noEmit` is now clean (the earlier single `loopWatchdog.ts` error was another
  worker's in-flight edit and is gone).

## Round 4 (route view + tie-break)

* **Live route view validated read-only.** `openNeedsYouItems()` - exactly what
  `GET /api/needs-you` returns - gave 6 items on the live root: unique ids, every item
  with `id` + `kind` + at least one action, every run currently `failed`, and `<= 6`.
  No duplicate prompts.
* **Deterministic tie-break.** Equal-timestamp duplicates now resolve to the higher
  runId, so the winner cannot flip with card order; an order-dependent winner could make
  the chat ask two different copies across ticks.

## Round 5 (safety of the tool + kind coverage)

* **`--dry-run` writes nothing.** SHA-256 of `company/fleet/orders.json`,
  `company/reports/needs-you-asked.json` and `company/assistant.jsonl` was identical
  before and after a dry-run, and no `*.tmp-*` files were left behind.
* **Dedupe is not fleet-only.** Two failed TASK cards whose title is the same long job
  text collapse to the single newest prompt, exactly like fleet orders.
* **Ledger matches the served list.** On the live root the ids in `needs-you-asked.json`
  are exactly the ids `openNeedsYouItems()` (`GET /api/needs-you`) returns (6 = 6), so no
  open prompt is un-asked and none is asked twice.
* **Ledger semantics pinned by test:** a stale entry for a run that is no longer open is
  harmless (asks nothing, sits until the next cleanup); clearing the entry for a
  still-open item re-asks it exactly once, never once per poll.

## Round 6 (tool robustness + a real race)

* **Corrupt files are never clobbered.** With a malformed `fleet/orders.json` and a
  malformed `reports/needs-you-asked.json`, the tool exits 0, prints
  `[SKIP] ... not an order array`, writes nothing to either file (SHA-256 identical), and
  does not crash. `readJson` returning `undefined` on a parse error is what makes this
  safe.
* **Live composition is stable.** `getBriefing()` (the exact view `GET /api/needs-you`
  serves) returned the same 6 ids on 3 consecutive calls, and again 35 s later - which
  spans a live 30 s watcher tick and its `briefing.json` rewrite. The file the running
  router wrote held exactly the same 6 ids, so the live (old) code and the new code agree
  on the open set for the current data: no oscillation, no extra prompt.
* **`cancelFleetOrder` (the resolver's `drop_order` effect) records the durable drop at
  runtime.** In an isolated root, cancelling an order wrote `status=cancelled`,
  `closedAs=dropped`, `closedReason`, `closedAt` and `closedBy=ceo` to `orders.json`, so a
  dropped run can never come back as "failed".
* **`drop_order` end-to-end through the resolver.** In an isolated root the duplicated-job
  prompt appeared with `retry`/`drop` actions; resolving `drop` returned
  `Order cancelled.`, set the order to `cancelled` with `closedAs=dropped`, and wrote the
  `needs-you-resolved.json` record.
* **The UI adds no prompts of its own.** `public/v2/app.js`, `views/assistant.js` and
  `views/briefing.js` only read `needsYou` from `/api/needs-you` (or `/company/briefing`)
  and POST resolves back; nothing generates a prompt client-side, so the server-side
  dedupe is the single source for the CEO's screen (the mock block in `briefing.js` is
  sample data for `test-ny-ui.html`).
* **A live process can revert a disk closure (honest limitation).** `saveFleetOrders`
  writes the whole in-memory array, so a fleet worker that loaded `orders.json` before a
  cleanup run overwrites the closure on its next save. Observed: the tool re-closed
  `fomunypebj` at 11:06 after a live save had dropped the 10:59 closure; once the worker
  went idle the closure persisted (checked over 45 s). This is why the CODE fixes (the
  same-title supersede rule, the dropped closure, the reissue guard) are the durable
  answer - they take effect when the router next starts - and why re-running this tool
  converges each time. Running it in a loop, or right before a router start, is safe.

* **HTTP acceptance against the real service.** `GET /api/needs-you` on the running
  `:8787` returned `200` in 1.2 s with 6 unique ids - exactly the deduped set - so the
  real route the UI calls serves no duplicates.

## Round 7 (live HTTP acceptance + a load observation)

* **Live route passes:** `GET /api/needs-you` -> `200`, 1230 ms, `httpNeedsYouCount=6`,
  `allUnique=True`, ids identical to the composed view. The UI's own endpoint is clean.
  Five further hits returned the same 6 ids every time (41-1866 ms), i.e. stable, not a
  one-off; a clean data-only comparison of 5 more hits gave `uniqueResponses=1`,
  `DATA_IDENTICAL=True`. `/health` answered 200 on all five (12-608 ms), so the earlier
  >30 s timeouts were transient event-loop starvation, not a wedged process.
* **Observation for whoever owns the event-loop hang (NOT this change):** during a busy
  window the router's HTTP surface was intermittently starved - `/health` and
  `/api/needs-you` both timed out (>30 s) and then returned `200` after ~40 s, while the
  logs kept advancing. The router is started as `tsx src/server.ts` (no watch), so none of
  this job's edits are loaded in it; local `getBriefing()` costs 4-6 ms (first call 339 ms
  with module load), so composition is not the bottleneck. Worth a look by the
  EVENT_LOOP_HANG owner.

## Caveat: the running router on :8787

The router process keeps the modules it already loaded, so the log-spam removal, the
chat de-duplication, the `Needs you: nothing` guard and the same-title/dropped closure
rules take effect on its next start. Until then a fleet worker can also revert a closure
this tool wrote into `orders.json` (it saves the whole array from memory); re-running the
tool re-applies it. The DATA fixes are read from disk on every tick, so the CEO's page is
already clean. Per the job rules the router was NOT restarted.
