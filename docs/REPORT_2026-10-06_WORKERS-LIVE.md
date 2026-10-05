# WORKERS-LIVE report: guarded workers visible on the Terminals page

Date: 2026-10-06 (Asia/Kolkata) · Order: `docs/ORDER_2026-10-06_workers-live.md` · Status: done, all checks PASS

## What changed (line ranges, current file state)

| File | Change | Lines |
| --- | --- | --- |
| `ops/spawn-worker.ps1` | registry entry now also carries `provider` and `model` (both were already computed and printed above; nothing else touched) | 254 total, added 230-233 (after `creationTime` at 229) |
| `src/company/workersView.ts` | NEW. `listWorkers(root?)`, `workerTail(name, lines=40, root?)`, types `Worker`/`WorkersView`/`WorkerTail`, exported `THOUGHT_MARKER` | 357 total (whole file new) |
| `src/server.ts` | import of `listWorkers, workerTail` | added 89-93 |
| `src/server.ts` | `GET /company/workers` + `GET /company/workers/:name/tail?lines=N` (400 invalid name, 404 no log; read-only, loopback like the other GETs) | added 1698-1719 (after the terminals/reap route, before the SYSTEM block) |
| `public/v2/views/terminals.js` | guarded-workers section, 3s live tail timer, cleanup, summary count, default filter | 831 total; added 14-17, 29-30, 64-90, 180-211, 216-229, 251-252, 264, 268-275, 325-388, 400, 409-410, 557-558, 568-577, 579-592, 594, 598-641, 740-744, 770-775, 824 |
| `ops/workers-view-check.ts` | NEW proof harness (temp `logs/` dir, fake files only, no network) | 169 total (whole file new) |

Not touched: `src/company/fleet.ts`, `.env`, `company/`, Laya, Kafka, scheduled tasks, `public/v2/style.css`, any running process.

### Behaviour

- `listWorkers`: a worker is `running` when its pid is alive (`process.kill(pid, 0)` in try/catch) and its run has no ledger line yet; runs of a repeated name are paired in order (the i-th registry row is settled by the i-th ledger line for that name). `recent` = last 15 ledger lines, newest first, joined to the registry row by name. `status` is `killed` when `endedBy` starts with `killed`, `stopped` for `stopped`, else `finished`. Malformed JSON lines in either file are skipped; a missing file is an empty list.
- `workerTail`: newest `logs/jcode-<name>-*.log` (the `.err.log` is ignored), name validated with `^[A-Za-z0-9-]+$`, only resolved inside `logs/`, ANSI stripped, consecutive thought-marker (U+1F4AD) lines joined into one line, at most `lines` lines and at most 8 KB. Invalid name throws (route 400); a missing log is `{ lines: [], error }` (route 404), never a crash.
- Terminals page: section at the top "Guarded workers (headless, no window)"; one card per live worker (name, status pill, mm:ss elapsed, provider, model, cost when known, pid) with a monospace auto-scrolling tail box that refreshes every 3 s while the page is open and the card is expanded (running workers start expanded); below it a collapsed "Recently finished (N)" list with status, turns, estimated cost and `endedBy` in plain words (a `killed:` reason is in the warning colour); "No guarded workers running right now." when there are none; the summary line now also says "N guarded workers running"; `cleanup()` stops the 3 s timer (`stopWTail`) as well as the existing two.
- Default filter is `all`. In this working copy it was already `all` (line 251) - no "working" default existed to change - so I kept `all` and added a comment saying why.

## Runs (exact output)

### 1. `npx tsc --noEmit`

```
src/company/workersView.ts(81,25): error TS1538: Unicode escape sequences are only available when the Unicode (u) flag or the Unicode Sets (v) flag is set.
src/company/workersView.ts(84,28): error TS1538: Unicode escape sequences are only available when the Unicode (u) flag or the Unicode Sets (v) flag is set.

Exit code: 2
```

Two of my own regexes used `\u{1F4AD}` without the `u` flag. Fixed (added `/u`), then re-ran:

```
TSC-CLEAN
```

(exit 0, no output; `&& echo TSC-CLEAN` printed only on success)

### 2. `npx tsx ops/workers-view-check.ts`

First run: 23/24 - one FAIL, and it was the fixture's fault (I had dropped the `","` fragment from the thought run while the expected sentence kept the comma). Fixed the fixture, then:

```
PASS  alive pid + no ledger line is running  [alive-one]
PASS  provider/model surface on a live worker
PASS  alive elapsed is counted from startedAt
PASS  dead pid is not live
PASS  a run with a ledger line is not live
PASS  ledger endedBy killed:... is status killed  [killed]
PASS  killed keeps the reason and the numbers
PASS  malformed registry/ledger lines are skipped
PASS  recent is capped at 15  [len=15]
PASS  recent is newest first (kill-one, then filler-20)  [kill-one,filler-20,filler-19,filler-18,filler-17,filler-16,filler-15,filler-14,filler-13,filler-12,filler-11,filler-10,filler-9,filler-8,filler-7]
PASS  recent keeps descending order
PASS  recent joins the registry row by name when present
PASS  tail reads the worker's log  [lines=4: ["I'll start by reading the work order.","[read] docs\\ORDER_2026-10-06_workers-live.md","Let me look at the fleet.ts file, specifically cheapPlan.","[bash] echo hi"]]
PASS  thought run is joined into one readable line  ["Let me look at the fleet.ts file, specifically cheapPlan."]
PASS  ANSI escapes are stripped  ["I'll start by reading the work order."]
PASS  tail is chronological (newest last)
PASS  tail honours the requested line count
PASS  tail caps the size at 8 KB  [178 lines / 8187 bytes]
PASS  tail keeps the newest line after the cap
PASS  workerTail("../x") is rejected
PASS  workerTail("a/b") is rejected
PASS  workerTail("") is rejected
PASS  missing log returns a not-found result  [no log found for this worker]
PASS  missing file on disk is not a crash for the list either

workers-view-check: 24/24 passed (logs=C:\Users\user\AppData\Local\Temp\workers-view-check-pVEJKE\logs)
```

Exit code 0. No network, no server, no real worker, fake files in a temp dir only.

### Extra (not in the order): view syntax check

The view is not covered by `tsc`, so I copied it to `%TEMP%\terminals-check.mjs` and ran `node --check`: `JS-SYNTAX-OK`.

## Open issues

1. **The new routes are not live yet on the running router.** A read-only probe of `http://127.0.0.1:8787/company/workers` answered `404 Not Found`: the router started before this change. The routes appear after the next router restart, which this order forbids me to do. Until then the page's guarded section shows its error card instead of the worker list; the static view change is already in place.
2. `elapsedSec` for `recent` rows is 0 by design: the ledger records no end time. The recent rows show turns, cost and `endedBy` instead.
3. `provider`/`model` only appear for workers spawned by the updated `spawn-worker.ps1`; the registry rows already written before this change have neither field, so their cards show name, status, elapsed and pid only.
4. `src/company/fleet.ts` and `public/v2/views/budget.js` show as modified in git - those are other workers' edits, untouched by me.
