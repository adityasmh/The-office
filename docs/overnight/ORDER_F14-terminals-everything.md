# Order F14-terminals-everything: one list of every worker, what it is doing, and what is queued

The CEO wants to see EVERY terminal in the Terminals section, headless or not, so he knows who is working on what. Today the page shows only live guarded workers and a collapsed "recently finished" list, without the task each one has.

## Files
`src/company/workersView.ts`, `public/v2/views/terminals.js`, `ops/workers-view-check.ts` (extend it). Edit nothing else; `ops/spawn-worker.ps1` and `ops/spawn-wave.ps1` are already updated by the manager.

## New data (already written by the manager)
- `logs/workers.json` (JSON lines) entries now also carry `order` (the order file path) and `title` (the order's first heading).
- `logs/queue.json` (a JSON array, may be absent) lists the current batch: `{name, order (number), title, state: "queued"|"running"|"refused"|"skipped", note, updatedAt}`.

## What to build
1. `listWorkers()` additionally returns: `title` and `order` for each worker (from the registry; fall back to the log's first non-empty line when missing), `lastActivity` (the newest line of its log in one short readable line, thoughts joined, 120 characters max) and `idleSec` (seconds since the log last changed), and a new array `queued` built from `logs/queue.json`: entries with state `queued` (waiting for a free slot), plus `refused` and `skipped` ones with their note. A queue entry whose state is `running` but whose worker is no longer alive counts as finished and is not listed as queued.
2. `public/v2/views/terminals.js`: replace the "Guarded workers" section with ONE list titled "All workers", newest activity first, grouped by status in this order: running, queued, finished in the last 24 hours, killed. EVERY worker is a row or card, never hidden behind a collapsed section (a plain "show older" toggle for entries older than 24 hours is fine). Each card shows: the TASK title in bold (so you can see who works on what), the worker name, a status pill, provider and model, elapsed or total time, turns and estimated cost when known, and for running ones the last-activity line plus the live tail box that refreshes every 3 seconds (running cards start expanded, others collapsed with a "show tail" toggle). Queued cards say "waiting for a free slot" with their position. Refused and skipped entries show their note in the warning colour. A running worker with no log change for 60 seconds shows "quiet for N s" in the warning colour. The page header counts running, queued and finished today.
3. Keep the jcode terminal cards below as they are, and keep the page working when the queue file or titles are missing.

## Proof (`ops/workers-view-check.ts`, temp `logs/` with fake files only)
Add PASS or FAIL cases: titles come from the registry and fall back to the log; `queued` lists only queued, refused and skipped entries and drops a `running` one whose pid is dead; `lastActivity` is one readable line; `idleSec` is computed from the log's modified time; a missing queue file gives an empty `queued` array. Keep every earlier case passing.

## Common rules
- Make changes with small targeted edits, never rewrite an entire existing file. Match the surrounding style; no new dependencies.
- Never restart or start the router. Never read, print or edit `.env`. Never touch `company/`, Laya, Kafka or scheduled tasks. No real network calls. No deletes.
- Run each command ONCE, in the foreground: `npx tsc --noEmit`, then `npx tsx ops/workers-view-check.ts`. If a step fails, report the exact error and END your turn; do not retry in a loop.
- Narrow job with an explicit end. Write `docs/overnight/REPORT_F14-terminals-everything.md` (changed line ranges, exact command output, open issues), print the same report and END your turn.
