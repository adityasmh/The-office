# REPORT R3-auto-redo: one automatic retry with the reviewer's notes

Date: 2026-10-06. Order: `docs/overnight/ORDER_R3-auto-redo.md`.
Status: done. `npx tsc --noEmit` clean; `ops/auto-redo-check.ts` all 21 lines PASS.

## What changed (exact line ranges)

### `src/company/autoRedo.ts` (new, 1-159)
- 1-24: header. 25-27: `AUTO_REDO_DEFAULT_MAX = 1`, `AUTO_REDO_HARD_MAX = 2`.
- 29-53: `autoRedoEnabled()` (FLEET_AUTO_REDO) and `autoRedoMax()` (FLEET_AUTO_REDO_MAX, clamped to
  `[1, 2]`), plus `clampAutoRedoMax()` so a caller cannot pass a larger cap.
- 55-84: `AutoRedoInput` / `AutoRedoVerdict`.
- 86-120: the pure `shouldAutoRedo({verdict, attempts, max, reviewText, prevReviewText, reason,
  failedCiOnly, slotsFree, paused})`. Retries ONLY when the flag is armed, the verdict is REDO, the
  notes are non-empty, the notes are not a repeat of the previous attempt's, the cap is not reached,
  a slot is free and the company is not paused. It refuses when the REDO came from a missing/empty
  report or when a red CI check is the only reason.
- `prevReviewText` is the one input beyond the order's list: it is what makes the "same notes as the
  previous attempt" rule testable and usable (the order names that rule but not its input).

### `src/company/fleet.ts` (modified)
- 53-57: `import { autoRedoEnabled, autoRedoMax, shouldAutoRedo } from "./autoRedo.js";` with the R3 comment.
- 2915-2925: `redoWorkOrder(orderId, wid, opts: { orders?: FleetOrder[]; by?: string } = {})`. The
  default is the old signature/behaviour, byte for byte (the CEO route and INBOX pass two args).
- 2940: the redo hop is `from: opts.by ?? "CEO"`, so an automatic retry is not labeled as a CEO action.
- 3126-3139: `companyPaused()`, a dynamic import of `lifecycle.js` (the same cycle-avoiding pattern
  `askCeoViaInbox` uses for `inbox.js`). A failed read means "not paused".
- 3141: `reviewWorkOrder(order, wo, allOrders)`; the tick passes its own in-memory array so the free-slot
  count and the retry use one authoritative copy.
- 3247-3250: `previousReviewText` captured before `wo.review` is overwritten (the rework path keeps
  `wo.review`, so this is the notes the worker was given last time).
- 3262-3301: the auto-redo block, right where the verdict is stored. `shouldAutoRedo` decides; on yes it
  calls the existing `redoWorkOrder` (which keeps `wo.review`, so the new brief carries the notes) and
  adds the hop `what: "auto redo (attempt N of M)"`; on no it adds `what: "auto redo skipped"` with the
  plain-words reason. The whole block is skipped unless `autoRedoEnabled()`, and a failure inside it is
  contained in a "auto redo failed" hop instead of looking like a review failure.
- 3777: `await reviewWorkOrder(order, wo, orders);` in `tickFleet`.

### `src/company/envReload.ts` (modified, 47-49)
- `"FLEET_AUTO_REDO"` and `"FLEET_AUTO_REDO_MAX"` added to `RELOADABLE_ENV_KEYS` (names only, unchanged
  value handling).

### `ops/auto-redo-check.ts` (new, 1-317)
Proof: the pure verdict on explicit inputs, plus the REAL exported `tickFleet()` driven against a
throwaway `COMPANY_ROOT`/`FLEET_REPO` with the gateway stubbed through `globalThis.fetch` (fixtures carry
`forceProvider: "kimi"`, so no Claude CLI and no real network) and `MIN_FREE_RAM_MB` above any real
machine's free RAM, so `fillSlots()` can never open a terminal.

## Commands run (once each, foreground)

```
> npx tsc --noEmit
(no output; exit 0)
```

```
> npx tsx ops/auto-redo-check.ts
PASS  1a: autoRedoEnabled() is false when FLEET_AUTO_REDO is unset
PASS  1b: shouldAutoRedo never retries while the flag is off -- {"redo":false,"attempt":1,"max":1,"reason":"no automatic retry: FLEET_AUTO_REDO is not armed (set FLEET_AUTO_REDO=1 to retry a REDO once)"}
PASS  2: retries once on a REDO with notes -- {"redo":true,"attempt":1,"max":1,"reason":"auto redo (attempt 1 of 1), with the reviewer's notes in the new brief"}
PASS  10a: the trace text names the attempt -- auto redo (attempt 1 of 1), with the reviewer's notes in the new brief
PASS  3: respects the cap (1 attempt already used of max 1) -- {"redo":false,"attempt":2,"max":1,"reason":"no automatic retry: 1 of 1 automatic retry already used"}
PASS  4: does not retry with empty notes -- {"redo":false,"attempt":1,"max":1,"reason":"no automatic retry: the review carried no notes to hand the worker (a human should look)"}
PASS  4b: does not retry when the REDO came from a missing/empty report -- {"redo":false,"attempt":1,"max":1,"reason":"no automatic retry: the REDO came from a missing or empty REPORT.md, not from review notes (a human should look)"}
PASS  5: does not retry when CI-red is the only reason -- {"redo":false,"attempt":1,"max":1,"reason":"no automatic retry: a red CI check is the only reason for the REDO (a human should look)"}
PASS  6: does not retry on repeated identical notes -- {"redo":false,"attempt":1,"max":1,"reason":"no automatic retry: the reviewer's notes are identical to the previous attempt, so the worker is not learning (the CEO should look)"}
PASS  7: does not retry when the company is paused -- {"redo":false,"attempt":1,"max":1,"reason":"no automatic retry: the company is paused for a planned shutdown"}
PASS  8: does not retry with no free session slot -- {"redo":false,"attempt":1,"max":1,"reason":"no automatic retry: every session slot is busy, so a retry would sit in the queue"}
PASS  9: the hard maximum of 2 is enforced even when a larger number is configured -- autoRedoMax=2 over={"redo":false,"attempt":3,"max":2,"reason":"no automatic retry: 2 of 2 automatic retries already used"} oneMore={"redo":true,"attempt":2,"max":2,"reason":"auto redo (attempt 2 of 2), with the reviewer's notes in the new brief"}
[auto-redo] tick 1 - FLEET_AUTO_REDO is unset (the default)
[auto-redo] tick 1 -> {"advanced":0,"reviewed":1,"orders":1}
PASS  1c: with the flag unset the real tick stores the REDO and does NOT redo it -- state=reviewed verdict=REDO attempts=0
PASS  1d: ... and adds NO auto-redo trace step -- hops=0
PASS  1e: ... and the reviewer is called exactly once (unchanged review path) -- calls=1
[auto-redo] tick 2 - FLEET_AUTO_REDO=1
[auto-redo] tick 2 -> {"advanced":0,"reviewed":4,"orders":5}
PASS  2b: the real tick re-queues the REDO'd work order automatically -- state=queued verdict=undefined attempts=1
PASS  2c: the retry keeps the reviewer's notes, so the new brief carries them -- review="still no error path in the widget; add one and re-run the tests"
PASS  10b: the trace step names the attempt -- {"ts":"2026-10-06T07:08:36.005Z","from":"Fleet","to":"jcode:WOB","what":"auto redo (attempt 1 of 1)","detail":"the reviewer asked for a REDO and left notes; retrying automatically with those notes in the new brief (attempt 1 of 1)"}
PASS  2d: no terminal was opened for the retry (the RAM floor stopped fillSlots) -- sessionId=undefined windowPid=undefined
PASS  4c: a REDO from an empty REPORT.md is not retried by the real tick -- verdict=REDO state=reviewed attempts=0
PASS  4d: ... and the skip is explained in plain words -- {"ts":"2026-10-06T07:08:36.006Z","from":"Fleet","to":"CEO","what":"auto redo skipped","detail":"no automatic retry: the REDO came from a missing or empty REPORT.md, not from review notes (a human should look)"}
PASS  6b: identical notes to the previous attempt are not retried by the real tick -- verdict=REDO state=reviewed attempts=1
PASS  6c: ... and the skip names the repeat -- {"ts":"2026-10-06T07:08:36.012Z","from":"Fleet","to":"CEO","what":"auto redo skipped","detail":"no automatic retry: the reviewer's notes are identical to the previous attempt, so the worker is not learning (the CEO should look)"}
PASS  3b: the cap stops a second automatic retry in the real tick -- verdict=REDO state=reviewed attempts=1
PASS  3c: ... and the skip says how many retries were used -- {"ts":"2026-10-06T07:08:36.019Z","from":"Fleet","to":"CEO","what":"auto redo skipped","detail":"no automatic retry: 1 of 1 automatic retry already used"}

[auto-redo] ALL CHECKS PASSED (temp dir C:\Users\user\AppData\Local\Temp\auto-redo-ZGQbZS)

[fleet] not spawning: 4943 MB free < MIN_FREE_RAM_MB=1000000
```

The last line is proof that the retry re-queued the work order and the check's RAM floor, not a terminal,
absorbed the spawn (`2d`).

## Notes and open issues

1. Cap accounting: the cap counts EVERY redo for the work order, because the fleet has one counter
   (`wo.attempts`) and `redoWorkOrder` increments it. A CEO-driven "send back" therefore spends one of
   the automatic retries. This is the conservative reading of "caps automatic retries per work order"
   and is stated in `autoRedo.ts`.
2. Repeat detection needs a previous attempt: `prevReviewText` is empty on the first review, so the
   "same notes" rule can only fire from the second attempt on. That is its purpose.
3. The retry runs inside `reviewWorkOrder`, on the same path the CEO's "send back" uses. The pre-existing
   behaviour where the tick can pick up a not-yet-rewritten REPORT.md after a redo (the report pickup at
   `fleet.ts` line ~3686) is unchanged by this order and applies equally to both redo paths.
4. `tsconfig.json` includes only `src`, so `npx tsc --noEmit` does not type-check `ops/`. The proof ran
   clean under `tsx`; there was no tsc coverage of the proof file itself.
5. Two earlier proof runs failed on bugs in the harness (the pure checks left `FLEET_AUTO_REDO=1` set for
   the "off" tick, then a stale async `orders.json` write overwrote the fixtures). Both were fixed in the
   proof only; the final run above is the one reported, and no failure repeated after the fix.
6. Nothing was committed: `src/company/fleet.ts` and `src/company/envReload.ts` already carried other
   workers' uncommitted edits (R1/R2) when this job started, so the `git diff` hunks in those files mix
   their changes with mine. My ranges are the ones listed above.
7. Not exercised: a live REDO with the real Claude reviewer and a real spawned second session (the check
   is offline by design), and the paused case only through the pure verdict (the in-memory pause flag
   needs a running router to set).
