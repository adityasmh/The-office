# REPORT R2-stuck-detector

Order: `docs/overnight/ORDER_R2-stuck-detector.md` (flag a worker that is burning time without progress).
Date: 2026-10-06. Status: **done, all proof lines PASS**.

## What was built

Env `FLEET_STUCK=1` turns the detector on (default OFF). `FLEET_STUCK_MINUTES` (default 8) and
`FLEET_STUCK_TOKENS` (default 80000) are the two limits. `src/company/stuck.ts` exports the pure
`isStuck({startedAt, now, tokens, reportExists, ownedChanged, alreadyFlagged}) -> {stuck, reason}`.
The watcher tick (`tickFleet`) calls it for each working work order; when it returns stuck and the
work order is not already flagged it sets `wo.stuck` + `wo.stuckReason`, adds ONE trace hop
(`from: "Fleet"`, `to: "CEO"`, `what: "possibly stuck"`, detail naming minutes, tokens and the
reason in plain words) and fires the existing `notify("stuck", order)` webhook (guarded, no-op
unless `NOTIFY_EVENTS` lists `stuck`). It never kills, stops or messages a worker. The flag is
cleared when a REPORT.md appears, an owned file changes, or the work order leaves the running
states. The session token total is read from the same journal reader the tick already uses
(`sessionLive`, extended with a `tokens` field); when the journal carries no `token_usage` the
minutes rule alone decides.

## Files and changed line ranges

- `src/company/stuck.ts` — NEW, 120 lines (whole file).
- `ops/stuck-check.ts` — NEW, 167 lines (whole file).
- `src/company/envReload.ts` — +4 lines at 34-37 (`FLEET_STUCK`, `FLEET_STUCK_MINUTES`,
  `FLEET_STUCK_TOKENS` added to `RELOADABLE_ENV_KEYS`).
- `src/company/fleet.ts` — 6 targeted insertions (no existing line rewritten except adding a
  field/argument; the only deletions are whitespace-normalised lines inside them):
  - 49-52: import of `isStuck`, `stuckEnabled`.
  - 132-136: `WorkOrder.stuck?` and `WorkOrder.stuckReason?`.
  - 606: `JournalMsg.token_usage?` type.
  - 617-620: `SessionLive.tokens?` field.
  - 697-700, 716-721, 738: `sessionLive` sums per-message `token_usage` (input+output) into `tokens`.
  - 3500-3561: `ownedFilesChanged()` + `repoChangedSince()` helpers (with `REPO_CHANGE_SKIP_DIRS`).
  - 3608-3642: the stuck check in `tickFleet`.
  (fleet.ts also carries lines 44-48 / 1357-1362 from the R1-env-scrub order; not mine.)

No deletes of existing files, no new dependencies, no `.env`/secret reads, no network calls in the
proof, `orders.json` schema only gains two optional fields.

## Commands (run once, foreground)

`npx tsc --noEmit` — exit 0, no output (clean).

`npx tsx ops/stuck-check.ts` — exit 0:

```
PASS  1: not stuck before the minutes limit -- {"stuck":false,"reason":""}
PASS  2: stuck after the minutes limit with no change -- {"stuck":true,"reason":"possibly stuck: 20 minutes since it started (limit 8) and 1000 tokens (limit 80000); no REPORT.md and no owned file changed since it started"}
PASS  8: the reason names minutes and tokens -- possibly stuck: 20 minutes since it started (limit 8) and 1000 tokens (limit 80000); no REPORT.md and no owned file changed since it started
PASS  3: stuck by tokens alone (minutes under the limit) -- {"stuck":true,"reason":"possibly stuck: 1 minute since it started (limit 8) and 500000 tokens (limit 80000); no REPORT.md and no owned file changed since it started"}
PASS  4: not stuck when an owned file changed -- {"stuck":false,"reason":""}
PASS  5: not stuck when a REPORT.md exists -- {"stuck":false,"reason":""}
PASS  6a: isStuck raises no second flag when the work order is already flagged -- {"stuck":false,"reason":""}
PASS  7a: stuckEnabled() is false when FLEET_STUCK is unset
PASS  7b: isStuck never flags while the detector is off -- {"stuck":false,"reason":""}
PASS  7c: with FLEET_STUCK unset the real tick adds no stuck flag and no trace hop -- tick={"advanced":0,"reviewed":0,"orders":1} stuck=undefined state=working hops=0
PASS  2-tick: the real tick flags the stuck work order -- stuck=true reason=possibly stuck: 20 minutes since it started (limit 8) and an unreadable number of tokens (limit 80000); no REPORT.md and no owned file changed since it started
PASS  2-tick: exactly ONE trace hop Fleet -> CEO named 'possibly stuck' -- {"ts":"2026-10-06T06:59:51.965Z","from":"Fleet","to":"CEO","what":"possibly stuck","detail":"WO1: possibly stuck: 20 minutes since it started (limit 8) and an unreadable number of tokens (limit 80000); no REPORT.md and no owned file changed since it started"}
PASS  6b: a second tick does not flag it twice (one hop, still flagged) -- hops=1 stuck=true
PASS  clear: an owned file change clears the stuck flag -- stuck=false reason=

[stuck-check] ALL CHECKS PASSED (temp dir C:\Users\user\AppData\Local\Temp\fleet-stuck-PI6BJ4)
```

Extra read-only sanity check (not part of the proof): `sessionLive(<a real session>)` now returns
`found true messages 111 tokens 3430034`, so the token read on the tick's existing journal reader
is live, not dead code.

## Open issues

1. **Webhook event name.** `notify.ts` is not in the order's file list, so I did not edit its
   `NOTIFY_DEFAULT_EVENTS`. `notify("stuck", ...)` is wired and guarded, but it only POSTs when the
   operator sets `NOTIFY_EVENTS=...stuck...`. Adding `"stuck"` to the default list is a one-line
   change if the manager wants it on by default.
2. **Token total is cumulative.** It sums every `token_usage` record in the journal tail
   (input+output), which grows fast (measured 3.4M over 111 messages on one live session). With the
   default 80000 the token gate can trip before 8 minutes; raise `FLEET_STUCK_TOKENS` (e.g.
   400000) if that proves noisy. The flag requires BOTH no REPORT.md and no owned-file change, so
   real progress still suppresses it.
3. **Empty owned list fallback.** "No file in the repo changed" is a bounded walk of `FLEET_REPO`
   (4000 entries, skipping `node_modules/.git/.jcode/dist/build/.next/.cache/tmp/coverage` and the
   company root). At the cap it answers "no change". Files under `ops/logs` that change constantly
   could mask a stuck worker that owns nothing.
4. The `sessionLive` memo now also caches `tokens` (same mtime+size key); the dashboard's
   `FleetWorkOrderView.live` is structurally typed and simply ignores the extra field.
