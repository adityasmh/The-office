# Order WORKERS-LIVE: see guarded workers live on the Terminals page

Narrow job. Do exactly these steps, print the final report, and END your turn. Do not wait, poll, loop, or re-read this order.

## Why
Guarded workers (started by `ops/spawn-worker.ps1`) run headless: no window, so they never appear on the dashboard's Terminals page, which only lists jcode terminals. The CEO wants to watch every running worker live, even when it has no window. Also the page opens on the "working" filter, which hides everything that is idle.

## Rules
- You may create `src/company/workersView.ts` and `ops/workers-view-check.ts`. You may edit `src/server.ts` (two new GET routes plus the import, small insertions), `public/v2/views/terminals.js`, and `ops/spawn-worker.ps1` (ONLY to add two fields to the registry entry it already writes, see step 1). Edit nothing else. Other workers edit `src/company/fleet.ts`: do NOT touch it.
- Make changes with small targeted edits, never rewrite an entire file.
- Never restart or start the router. Never stop, signal or touch any running worker or process. Never touch `.env`, `company/`, Laya, Kafka, or scheduled tasks. No network calls in your tests. Do not print secrets.
- Run each command ONCE, in the foreground. If a step fails, report the exact error and END your turn; do not retry in a loop.
- Plain words in the UI, no visual polish. Match the surrounding style.

## What to build
1. `ops/spawn-worker.ps1`: where it writes the worker's entry to `logs/workers.json` (one JSON object per line: name, pid, log, startedAt, maxMinutes, maxUsd, creationTime), also write `provider` and `model` (the values it already computed and printed). Nothing else in the file changes.
2. `src/company/workersView.ts` exports:
   - `listWorkers(root?)`: reads `logs/workers.json` and `logs/token-ledger.jsonl` (both are JSON lines; skip malformed lines). Returns `{ live: Worker[], recent: Worker[] }`. A worker is live when its pid is alive (`process.kill(pid, 0)` in a try/catch) and it has no ledger line yet. `Worker` = `{ name, pid, status: "running" | "finished" | "killed" | "stopped", provider?, model?, startedAt, elapsedSec, maxMinutes, maxUsd, turns?, estUsd?, endedBy? }`. `recent` is the last 15 ledger entries (newest first) joined with their registry entry by name when present. `status` is `killed` when `endedBy` starts with `killed`.
   - `workerTail(name, lines = 40, root?)`: returns `{ name, lines: string[] }` for `logs/jcode-<name>-*.log` (newest match). Validate `name` with `^[A-Za-z0-9-]+$`; resolve only inside `logs/` (no path traversal). Strip ANSI codes. The log streams the model's thoughts as many tiny lines that each start with the thought marker followed by one word or one punctuation mark: join consecutive thought-marker lines into ONE line of text so the tail is readable. Return at most `lines` lines and at most 8 KB.
3. `src/server.ts`: `GET /company/workers` returns `listWorkers()`; `GET /company/workers/:name/tail?lines=40` returns `workerTail`, with 400 for an invalid name and 404 when no log exists. Read-only; no token needed from loopback (like the other GET routes).
4. `public/v2/views/terminals.js`:
   - Change the default filter from "working" to "all".
   - Add a section at the TOP titled "Guarded workers (headless, no window)". One card per live worker: name, a status pill, elapsed (mm:ss), provider and model when known, a cost estimate when known, and a live tail box (monospace, newest at the bottom, auto-scroll) that refreshes every 3 seconds while the page is open and the card is expanded; running workers start expanded. Below, a collapsed list "Recently finished" with name, status, turns, estimated cost, and `endedBy` in plain words (a `killed:` reason shows in the warning colour). When there are no live workers say "No guarded workers running right now."
   - The page summary line also counts the headless workers ("N guarded workers running").
   - Stop the timers in the page's cleanup.

## Proof (`ops/workers-view-check.ts`, temp `logs/` dir, fake files only)
Print PASS or FAIL per line:
- A registry entry whose pid is alive (use the current process pid) and with no ledger line is `running`; one with a ledger line `endedBy:"killed:repeat-line x6"` is `killed`; malformed lines are skipped.
- `recent` is newest first and capped at 15.
- `workerTail` joins a run of thought-marker lines into one readable line, strips ANSI, and caps the size.
- `workerTail("../x")`, `workerTail("a/b")` and an empty name are rejected.
- A missing log returns a not-found result, not a crash.

## Finish
1. Run `npx tsc --noEmit` once.
2. Run `npx tsx ops/workers-view-check.ts` once.
3. Write `docs/REPORT_2026-10-06_WORKERS-LIVE.md` with the changed line ranges, the exact output of the runs, and any open issue. Print the same report and END your turn.
