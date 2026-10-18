# Dashboard speed: measured causes and the fix plan

Written by Claude Code (manager), measured 19:10 on the live router. Built by PERF-BACKEND and PERF-UI.

## Measurements (live :8787)
| Call | Time | Size |
|---|---|---|
| `/health` | **timed out at 60 s** (event loop blocked) | - |
| `/v2/`, `/v2/app.js` | **timed out at 60 s** | - |
| `/company/panel` | **12.2 s** | **1.49 MB** |
| `/company/flow?limit=30` | **5.2 s** | 90 KB |
| `/company/memory/status` | 2.1 s | 1 KB |
| `/v2/style.css` (static file!) | 2.0 s | 23 KB |
| `/company/assistant/thread` | 1.4 s | 34 KB |
| `/company/sessions` | 0.3 s | 119 KB |
| briefing / runs / fleet / terminals | 0.1–0.7 s | fine |

Data: `company/sessions.jsonl` is **3.6 MB** and growing (every output chunk is appended and the whole file is
replayed). Machine: 17 node processes (agents' leftover test servers), 17 jcode, CPU ~50%, ~2.8 GB RAM free.
**Static files taking 2–60 s = the Node event loop is blocked by synchronous work.** Every page waits behind it.

## Root causes (to confirm with a profiler before fixing)
1. Synchronous heavy work on the request path: `/company/panel` and `/company/flow` re-read and re-parse whole
   files (sessions.jsonl, every project's tasks.json with traces, budgets, org) on EVERY request.
2. Background loops (fleet tick, run managers/briefing watcher, terminal reaper, memory rebuild, Slack bridge)
   probably do synchronous file scans/`execFileSync` on the main thread (the jcode journals total 3.8 MB).
3. Polling: the v2 shell polls sessions+flow+budgets every 6 s and a heartbeat every 4 s. Projects/Fleet views call
   `/company/panel` (1.5 MB). The OLD dashboard (`/`) polls `/company/panel` every 2 s. If any tab has it open, the
   server never catches up.
4. Output tails stored inside every session record inflate `/company/sessions` and `/company/panel`.

## Targets (verify with real numbers)
- `/health` and static files < 50 ms, even while background loops run.
- Every `/company/*` GET used by v2 < 300 ms and < 100 KB (paged or trimmed).
- First paint of `/v2/` < 1 s; each view shows cached data immediately and refreshes in the background.

## PERF-BACKEND owns (temporary grant, announce in the log): `src/company/panel.ts`, `src/company/sessions.ts`,
`src/company/flow.ts`, `src/company/org.ts` / `gates.ts` read paths (caching only, no behaviour change), plus a new
`src/company/cache.ts`. For `fleet.ts`, `runManagers.ts`/`briefing.ts`, `terminalReaper.ts`, `terminalChat.ts`,
`memory.ts`, `knowledge.ts`: send the owner (bonehound, mushroom, hibiscus, maple, MEMORY closed → you may edit
memory.ts/knowledge.ts) a targeted message with the exact slow spot and fix. Edit them yourself only if the owner
agrees in the log or is closed.
1. Profile first: `node --cpu-prof` on a TEST server (other PORT, SLACK_BRIDGE=0, temp COMPANY_ROOT copied from
   company/) under a replay of the v2 polling. Name the top 5 blocking functions with evidence.
2. mtime-keyed in-memory caches for every file read on hot paths (re-read only when mtime/size changes).
3. `sessions.jsonl`: keep a live in-memory index, so replay happens only at boot. Stop appending every output chunk
   (store tails separately, capped, e.g. `company/sessions/<id>.tail`). Add compaction/rotation at boot (keep the last
   state per session). Keep the file format backward compatible for `reconcileStaleSessions`.
4. `/company/panel`: build it incrementally/cached, drop output tails from it, add `?lite=1`. `/company/flow`: cache
   per project, invalidated by tasks.json mtime.
5. Any `readFileSync`/`execFileSync` in background loops over big data → async, or move off the request path. Loops
   must yield (no > 50 ms synchronous chunk).
6. Serve `/v2/` static with `Cache-Control` (short max-age + ETag) and gzip (express `compression` is not installed;
   installing it needs manager approval: ask in the log, or use Node's zlib).

## PERF-UI owns (temporary grant, announce in the log): polling/fetch code in `public/v2/app.js`, `api.js`, and the
data-loading parts of `views/*.js` (not their layout).
1. One shared data store in api.js: dedupe identical in-flight requests, cache responses for N seconds, share them
   across views (the shell's stats and the views ask for the same data).
2. Poll only what the visible view needs. Back off when the tab is hidden or the router is slow (exponential backoff,
   never overlapping requests). Heartbeat every 15 s, not 4 s.
3. Replace `/company/panel` in Projects/Fleet with the smaller endpoints (or `?lite=1` once PERF-BACKEND adds it).
4. Render instantly from the last cached data (sessionStorage), then refresh.
5. Put a banner on the OLD dashboard (`public/index.html`): a notice + link to `/v2/`, and make its poll 10 s instead
   of 2 s (only the poll interval; announce it).

## Proof (real numbers in docs/AGENT_COORDINATION.md)
A before/after table of the same calls on the live router after the restart (restart requests go to CRASHFIX/piglet),
plus the profiler's top functions before and after. `npx tsc --noEmit` clean. Stop your test servers when done.
