# REPORT F14-terminals-everything: one list of every worker, what it is doing, and what is queued

Status: **DONE**. `npx tsc --noEmit` exit 0 (no output); `npx tsx ops/workers-view-check.ts`
PASS 39/39. Only the three files named by the order were edited; nothing else was created
except this report.

## Changed files

| File | Lines | What |
|---|---|---|
| `src/company/workersView.ts` | 7-19, 30-38 | module doc: queue.json, the new fields, TERMINALS-ALL note |
| | 66-100 | `Worker.title/order/lastActivity/idleSec`; new `QueuedWorker` type; `WorkersView.queued` |
| | 115-117 | knobs: `ACTIVITY_MAX=120`, `TITLE_MAX=200`, `TITLE_READ_BYTES` |
| | 180-196 | `readJsonArray`: a missing/malformed `logs/queue.json` is `[]`, never a throw |
| | 237-379 | log-derived helpers: `clip`, `newestLogFile`, `readableLines`, `firstLineOf`, `logInfo`, `decorate`, `queuedRows` |
| | 415-417 | `recentWorker`: elapsed comment (decorate now fills it from the log mtime) |
| | 437-442, 461-482 | `listWorkers`: decorate every live/recent row, return `queued` |
| | 511-527 | `workerTail` reuses `newestLogFile`/`readableLines` (same behaviour, one definition) |
| `public/v2/views/terminals.js` | 14-18 | `/company/workers` contract comment (new fields + `queued`) |
| | 182-225 | mock data: two running workers, a finished and a killed one, four queue rows |
| | 248-259 | the view's small CSS block: group headings, bold task, activity line, dashed not-started cards |
| | 296-305 | `workers` gains `queued`; `wopen` is keyed per row |
| | 355-488 | the section is now ONE list "All workers": `allWorkerRows`, `isOpen`, `quietHtml`, `workerCardHtml`, `queueCardHtml`, `workerGroupHtml`, `workerCounts`, `guardSectionHtml` |
| | 506-527 | header counts: running / queued / finished today |
| | 701-708 | `loadList` stores `queued` |
| | 712-762 | `loadWorkerTails`/`armWorkerTails`/`paintWorkerTails` follow every expanded card, not only live ones |
| | 858-862, 889-892 | the "show tail" toggle keyed per row |
| | 929-933 | `?mock=1` now also loads the worker sample data |
| `ops/workers-view-check.ts` | 7-23 | doc: cases 6 and 7 |
| | 75-92 | registry fixtures: titled-one, untitled-one, long-one, q-deadrun |
| | 124-155 | log fixtures (title fallback, trailing thought run, 202-char line), pinned mtime, `queue.json` |
| | 223-250 | the new PASS/FAIL cases |

Behaviour, as ordered:

- `listWorkers()` now also returns per worker `title` and `order` (registry, else the log's
  first non-empty line), `lastActivity` (newest readable line, thoughts joined, ≤120 chars)
  and `idleSec` (seconds since the log mtime), plus a `queued` array from `logs/queue.json`
  holding only `queued` (with a 1-based `position`), `refused` and `skipped` entries, ordered
  by the wave's `order`. `running` and `finished` queue rows are dropped; a `running` row
  whose worker is gone is therefore never shown as queued (it is in `recent` from the ledger).
- The Terminals page has one section titled **All workers**, newest activity first, grouped
  running → queued → finished (last 24 h) → killed. Every worker and every queue row is a
  card; only finished entries older than 24 h sit behind a plain "show older" toggle. Cards
  show the bold task title, the worker name, a status pill, provider, model, elapsed/total
  time, turns and estimated cost. Running cards start expanded with the last-activity line and
  the 3 s live tail; any other card has a "show tail" toggle. Queued cards say "waiting for a
  free slot · position N"; refused/skipped show their note in the warning colour; a running
  worker with no log change for ≥60 s shows "quiet for N s" in the warning colour. The header
  counts running, queued and finished today. The jcode terminal cards below are untouched.

## Proof (exact command output)

Command 1: `npx tsc --noEmit` — exit 0, no output.

Command 2: `npx tsx ops/workers-view-check.ts`

```
PASS  alive pid + no ledger line is running  [alive-one,titled-one,untitled-one,long-one]
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
PASS  title comes from the registry when present  [Order F14: one list of every worker]
PASS  order comes from the registry  [docs/overnight/ORDER_F14-terminals-everything.md]
PASS  title falls back to the log's first line  [I'll start by reading the work order.]
PASS  lastActivity is the newest readable log line  [[bash] echo hi]
PASS  lastActivity joins a trailing thought run  [Waiting for a free slot.]
PASS  lastActivity is one line capped at 120 chars  [120 chars]
PASS  idleSec is computed from the log's modified time  [125]
PASS  queued lists queued, refused and skipped entries only  [q-first:queued,q-third:queued,q-refused:refused,q-skipped:skipped]
PASS  a running queue entry whose pid is dead is dropped
PASS  a finished queue entry is not queued
PASS  a nameless queue row is skipped
PASS  queued is ordered by the wave's order number  [q-first,q-third,q-refused,q-skipped]
PASS  waiting entries carry their 1-based position
PASS  refused and skipped keep their note
PASS  a missing queue file gives an empty queued array

workers-view-check: 39/39 passed (logs=C:\Users\user\AppData\Local\Temp\workers-view-check-bFzOT5\logs)
```

Extra (not part of the ordered proof): `node --check public/v2/views/terminals.js` → `SYNTAX_OK`.

## Open issues

1. Two runs of the same worker name share one log file name (`jcode-<name>-<date>.log`), so
   `lastActivity`/`idleSec`/`title` for the older run point at the newest log of that name.
   This is the same limitation the existing tail route already had.
2. "finished today" in the header counts the same 24-hour window as the "Finished (last 24 h)"
   group: the ledger has no end timestamp, so the log mtime is the only age signal available.
3. `recent` is still capped at the last 15 ledger entries (`RECENT_MAX`), so "every worker" is
   bounded by that pre-existing cap; older finished workers are not listed.
4. The view itself has no automated DOM test (no such harness in the repo); its proof here is
   the backend check plus `node --check`, and the layout is visible with `#/terminals?mock=1`.
5. "quiet for N s" reads the `idleSec` value from the last list fetch, so it can lag the real
   log by up to one 5 s list poll.
6. Right now `logs/queue.json` holds only the running F14 entry, so the live page shows no
   queued cards until the manager's wave writes queued rows; the mock data demonstrates them.
