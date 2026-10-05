# INCIDENT 2026-09-30: `/v2/` would not load (router event-loop starvation)

Status: root cause found and fixed in `src/company/knowledge.ts`; two further fixes delegated.
Reported by: jcode (diagnosing the CEO's "why is the website taking so long to load?").

## Symptom

`http://127.0.0.1:8787/v2/` sometimes does not load at all, and is very slow otherwise.

## What the user actually hit

Supervisor log (`logs/router.supervisor.log`):

```
02:18:20  router pid=24644 has not answered /health for 5.2 min - replacing it
02:18:30  router process exited after 954.7s (exit code -1)
02:18:38  starting router (attempt 3)
02:18:58  router is healthy on :8787 after 14.2s (pid 32656)
```

The CEO asked at **02:18:47**, i.e. inside the restart window with no server listening.
A hard crash also happened at 02:02:29: exit code `-1073740791` (`0xC0000409`).

## It is not the frontend

Measured on the live router while healthy:

| Request | Time | Size |
|---|---|---|
| `/v2/` | 2.6 ms | 2.6 KB |
| `/v2/style.css` | 5 ms | 48 KB |
| `/v2/app.js` | 3.5 ms | 30 KB |
| `/company/sessions` | 294 ms | 116 KB |
| `/company/flow?limit=30` | 217 ms | 96 KB |
| `/company/briefing` | 125 ms | 6.7 KB |
| `/company/org` | 59 ms | 7.5 KB |
| `/company/budget?lite=1` | 27 ms | 291 B |

All 200 OK. All 11 `public/v2/**` modules pass `node --check`. The frontend is fine.

## Root cause

The router is one Node process sharing a single event loop with every background
watcher. Because Node is single-threaded, any synchronous work in a request handler or
a watcher tick stops *everything*, including static files.

Independently reproduced: between 20:53 and 20:59 UTC **every** request timed out,
including `/v2/style.css`, while the router process itself showed only
`WS=85 MB CPU=12 s`. Low CPU + total unresponsiveness = blocked or starved, never a
busy loop. `docs/PERF_SPEC.md` had already measured the same thing
("/health timed out at 60 s", "static files taking 2-60 s").

### Primary cause (FIXED): synchronous `graphify` on the request path

`src/company/knowledge.ts`:

- `tryGraphify()` ran `execFileSync(bin, args, { timeout: 120_000, ... })` with
  `DEFAULT_GRAPHIFY_SYNC_TIMEOUT_MS = 120_000`.
- It tried **three** arg variants in sequence, so a worst case of **360 s** of frozen
  event loop, with `/health` and static files queued behind it.
- `findGraphify()` separately ran `execFileSync(candidate, ["--help"], { timeout: 15000 })`
  per candidate, synchronously.
- Reachable from `extractProjectKnowledge` <- `projectContext` <- pipeline stages.

This is why the freezes recurred roughly every 5 minutes (the CLI result cache is
`CLI_CACHE_MS` = 5 min, so the expensive path re-ran on expiry).

### Contributing cause (DELEGATED): PowerShell process-table storm

`src/company/fleet.ts`:

- `descendantsOf()` spawns
  `powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | ..."`.
- `identifySession()` calls it every **1000 ms** in a loop bounded by
  `spawnDetectMs()` = `FLEET_SPAWN_DETECT_MS` = **60000**.
- One call can therefore spawn up to ~60 full WMI process-table enumerations.
- Live evidence: **14 concurrent powershell.exe** processes, 30-106 MB each (~800 MB),
  with only ~1.7 GB free of 16 GB and Windows memory compression at 1.1 GB.
- Log signature: the 5-second fleet watcher showed a **60 s gap** (20:53:41 -> 20:54:41).
- `terminalReaper.ts:414` has a third `Get-CimInstance` site on a 30 s tick.

### Contributing cause (DELEGATED): supervisor turns "slow" into "down"

`ops/router-supervisor.ps1` kills the router after 5.2 min of `/health` silence. A starved
router is alive, and killing it *guarantees* an outage (observed restart windows of
7.9 s, 26.3 s, 48 s, 109.6 s, 118.3 s). `/health` now reports `lagMs` / `lagP95Ms` /
`lagMaxMs`, so the supervisor can distinguish "alive but lagging" from "dead".

## The fix applied now

`src/company/knowledge.ts` only. Backup at `src/company/knowledge.ts.bak-perf`.

1. `execFileSync` -> async `spawn` (`tryGraphifyAsync` + `spawnCapture`), with a
   deadline that kills the child. The event loop now turns while graphify runs.
2. `findGraphify()` no longer runs `--help`; it stats candidates (no process) and lets
   the async run validate the binary. A bad binary is remembered via
   `noteGraphifyFailure()` for `PROBE_RETRY_MS` (5 min).
3. `tryGraphifyCached()` stays synchronous **by contract** and never runs the CLI:
   a fresh cache hit is returned, otherwise the refresh is handed to the async runner
   (single-flighted per `rootDir` via `cliInFlight`). A cold cache falls back to the
   builtin walker for that one call and upgrades to the CLI result on a later call.
   This preserves every existing sync call site.

### Verification

`npx tsc --noEmit` clean. `findstr` confirms no executable `execFileSync` remains (only
comments), and `tsc` would fail if an unimported call survived.

Runtime test, all 5 live projects through `extractProjectKnowledge`:

```
TOTAL 148ms  maxLoopLagMs=0
pmumhp51u: 70ms files=376 symbols=1782
```

**`maxLoopLagMs=0`**: the loop never stalled even 100 ms. `symbols=1782` shows the
prebuilt company-memory graph won, so no CLI was needed on this path.

That run did not prove the CLI path itself, so I forced it with an A/B harness in an
ISOLATED COMPANY_ROOT (temp dir, no `memory/graphify-out/graph.json`, so the prebuilt
graph cannot win) and faked the graphify binary with `node ./extract`, an extensionless
script that sleeps 3000 ms, exits 0 and prints nothing. Same command, same fixture,
only the module differs:

| code | `extractProjectKnowledge` call | max event-loop lag |
|---|---|---|
| OLD `knowledge.ts.bak-perf` | **6297 ms** | **6215 ms** |
| NEW `knowledge.ts` | **16 ms** | **12 ms** |

Both produced the identical digest (`extractor: builtin`, `files: 2`, `headings: 1`), so
the extraction result is unchanged. The 6.2 s of blocked loop is exactly the pathology,
and with the real 120 s timeout the old worst case was 360 s, which is what the
multi-minute freezes were. All temp fixtures and the harness were deleted afterwards.

### Concurrency guard (regression insurance)

Going async removed a guarantee the old code had for free: `execFileSync` ran exactly one
graphify at a time, while a naive async version could start one child per cold `rootDir`
at once, on a box that is already short of RAM. `scheduleGraphifyRefresh()` now refuses to
schedule above `GRAPHIFY_MAX_CONCURRENT` (default 1); the TTL means a later call retries.

Proved with three cold projects and a fake CLI that logs its own START/END:

| setting | child runs | peak concurrent |
|---|---|---|
| `GRAPHIFY_MAX_CONCURRENT=1` (default) | 2 | **1** |
| `GRAPHIFY_MAX_CONCURRENT=3` | 6 | **3** |

At the cap a call is skipped rather than queued, so it never builds an unbounded backlog.

### Live status: fully deployed

The router was deliberately restarted at 21:31:11Z (`SUPERVISOR manual stop` of pid 34388,
new pid 34224) and the supervisor was restarted with the rewritten script: its own startup
line reads `replaceAfter=30min ramFloor=2048 MB`, which only exists in the new version, so
the rewrite plus the `MaxRamHoldMinutes` cap are loaded too. Every fix in this document is
now running:

| change | written | live |
|---|---|---|
| `knowledge.ts` async graphify | 21:03:41Z | yes |
| `knowledge.ts` concurrency guard | 21:16:11Z | yes |
| `fleet.ts` shared process snapshot | earlier | yes |
| `assistant.ts` Opus -> Sonnet ceiling | 21:22:40Z | yes |
| `router-supervisor.ps1` rewrite + hold cap | 21:26:37Z | yes |

Post-restart result, ~3.5 min after boot: `ok=true`, `lagMs=10`, `lagP95Ms=155`,
**`lagMaxMs=1444` (1.4 s)** against **24496 ms (24.5 s)** worst-case on the previous boot.
For reference, an earlier sample of the previous process read `lagMs` 1-111 with
`lagP95Ms` falling 395 -> 137; that 24.5 s spike was a one-off of that boot and was not
attributable to this change (the only Python processes were two `scripts/laya-gpu-boot.py`
predating the patch, and `projectContext()`, the only caller that can reach the CLI, is
reached from `pipeline.ts`, not at boot).

## Delegated workstreams

| Agent | File (exclusive) | Task |
|---|---|---|
| `fleet ps-storm` | `src/company/fleet.ts` | one TTL-cached, single-flighted process snapshot; raise the 1 s poll to 3-5 s |
| `supervisor policy` | `ops/router-supervisor.ps1` | use `lagP95Ms`; back off instead of killing; respect the 2048 MB RAM floor |
| `sync hotpath audit` | none (read-only) | rank the remaining blocking calls with file:line evidence |

## Remaining known risk

`docs/PERF_SPEC.md` items 1-4 are still open and were NOT fixed here:
`company/sessions.jsonl` is ~3.6 MB and re-read/re-parsed per request; `/company/panel`
was 1.49 MB / 12.2 s; `/company/v2` shell + views poll repeatedly. These keep the box
busy enough that the next sync offender will look like this incident again.

Machine load is itself a hazard: 11-12 real terminals against `MAX_PARALLEL_SESSIONS=10`,
12 node processes, and free RAM under the app's own 2048 MB floor.

## Corrected: the Opus-on-review leak is already fixed

An earlier version of this note said the review path was still spending Opus. That is now
stale. The CHEAP-DEFAULT workstream found and fixed it in `runManagers.ts`:

- Cause: `redoTwice = history.filter(c => c.verdict === "REDO").length >= 2`, i.e. TWO
  REDOs ANYWHERE in a run's accumulated history. A hard rule BYPASSES the measured Laya
  bars, so a run that had ever collected two REDOs emitted `hardRule: "redo2"` on every
  later re-check, forever.
- Measured impact: in the 15 min before the 21:31 restart, **15 of 52 gate decisions were
  Opus, every one `hardRule=redo2 purpose=review`, at 30-60 s intervals**; after the
  restart 6 of 20, again all `redo2`.
- Fix: `redoEscalation(history)` fires only on the transition into a second CONSECUTIVE
  REDO (`[REDO,REDO] -> true`; `[REDO,REDO,REDO] -> false`; `[REDO,REDO,PASS,REDO] ->`
  `false`; `[REDO,PASS,REDO] -> false`). `npx tsc --noEmit` exit 0.
- It is NOT live: `runManagers.ts` was edited after the 21:31 restart, so it needs the next
  one. The same agent independently verified the assistant ceiling in a sandbox
  (`claude-opus-5-5` ceiling: small -> deepseek, big -> sonnet, never Opus), which agrees
  with the live log evidence.

## In flight

A deep swarm plan (5 file-disjoint fixes + an adversarial verify gate) is running against
the residual blockers: `terminalReaper.ts` (session-meta 4 MB fallback, coordination doc
re-read per archive, journal tails), `runManagers.ts` discovery caches, `panel.ts`/
`org.ts` rebuild path, `gates.ts`/`usage.ts` uncached reads, and `sessions.ts`/
`flow.ts`. Those all need the next restart to take effect.
