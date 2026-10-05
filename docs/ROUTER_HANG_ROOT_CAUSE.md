# ROUTER HANG: root cause, fix, and how to verify

Owner: jcode worker (work order "Router hang root cause", 2026-09-30). Model deepseek-v4.1-flash.
Scope: `src/company/loopWatchdog.ts` (new), `src/server.ts` (health route moved + watchdog wired),
`ops/loop-watchdog-selftest.ts` (new test), `logs/loop-watchdog-*.txt` (evidence).
I did **not** restart the router, did **not** touch pid 1984, and did **not** touch the supervisor.

Evidence file: `logs/loop-watchdog-hang-evidence.txt` (all read-only observations).

## 1. What the CEO/manager reported, restated

The company site on `:8787` hangs (HTTP times out) although pid 1984 is listening;
`logs/router.supervisor.log` says `/health` did not answer and it waits 30 min before
replacing; earlier the same process reported `lagMaxMs=410062` (6 min 50 s).

## 2. What I measured on the live router (read-only)

| Observation | Value | What it rules in/out |
|---|---|---|
| CPU of pid 1984 while `/health` timed out | **0 ms over 4 s** (twice) | NOT JS work, NOT a busy loop, NOT GC - a **blocking call** holds the thread |
| Threads | 13, one Ready, working set 68 MB | process is alive, not swapping out of existence |
| Raw TCP connect to 8787 during the hang window | **CONNECTED in 124 ms** | the socket was still there; nothing was being *answered* |
| Supervisor's 1 s connect probe, local 16:12:00 / 16:13:57 / 16:15:09 (= 10:42:00 / 10:43:57 / 10:45:09Z) | failed, while `Get-NetTCPConnection` showed pid 1984 | the loop was not being serviced; the socket itself was fine (see next-but-one row) |
| PowerShell child of pid 1984, started **16:14:36 local** | still alive at **16:17:45** and **16:18:15** (`>3 min` past its **10 s** deadline, `PROC_PS_TIMEOUT_MS`); its `process table unavailable ... (child killed)` line appears at **16:20:04**, ~5.4 min late | parent timers were not running: the loop was **blocked**, not slow |
| Live log, re-read line by line | **stdout silent 10:44:34 -> 10:49:40 (5 min 06 s)**, with 3 stderr lines *inside* it (10:46:03 fleet, 10:48:16 + 10:48:25 brain); the 5 s fleet watcher had a 4 min 49 s gap and no 30 s `[briefing] tick:` fired | the loop was blocked in stretches of up to ~2 min, turning briefly - not one continuous 7 min block (this corrects an earlier claim of "6 min 49 s with zero output") |
| Machine during that window | my own WMI query answered in 1.5 s; TCP connect 124 ms | the *machine* was fine; only this process was stuck |

The worst stretch starts **2 seconds after** the live process wrote a whole-object log
dump, which is the strongest correlate I have:

```
16:14:34.294  [DEBUG readOpenNeedsYouSync] briefing: {        <- start of a 7.6 KB dump
16:14:36      powershell.exe child spawned by pid 1984         <- last thing that ran
10:46:03Z     brief turn: a 5 s fleet tick gets through (stderr line)
10:48:16/25Z  brief turn: async fetch-failure callbacks land
10:49:40.532Z stdout resumes; 10:50:52Z the watchers are back on cadence
16:20:04      the child's 10 s kill finally runs (5.4 min late)
```

## 3. Root cause

The router shares one Node event loop with every watcher, and **on Windows a write to a
file-backed stdout/stderr is synchronous**. `ops/router-supervisor.ps1` starts the router
with `... 1>> logs\router.out.log 2>> logs\router.err.log`, so **every `console.log` in
this process is a blocking write syscall on the event loop**.

The live process (booted 09:23, i.e. *before* today's fixes to `src/company/assistant.ts`)
dumped the entire parsed `company/reports/briefing.json` object on every
`readOpenNeedsYouSync()` call:

```js
console.log("[DEBUG readOpenNeedsYouSync] briefing:", briefing)   // ~200 lines, 7,576 bytes, ONE write
```

Measured in the live log: **2,488 such dumps** in a **10.5 MB** `logs/router.out.log**
(206,295 lines), still growing while the process runs. When such a write (or any of the
147 remaining synchronous `fs.*Sync` call sites in `src`) meets this box's AV-inflated,
I/O-saturated filesystem, the write does not return, and the whole control plane goes
silent: no timers, no `/health`, no static files, CPU 0.

**How strong is that attribution, exactly?** Measured: the shape of the failure (0 CPU at
two points inside the window, timers of known length missed by minutes, blocked stretches
inside a window where stdout stopped while a few stderr lines still escaped) and the
size/cadence of the blocking writes that share that timeline. Inferred: that these
particular writes are what held the loop in that particular stretch - a live process
cannot be introspected for *which* syscall is pending without a restart, which this order
forbade. That inference is exactly what `src/company/loopWatchdog.ts` replaces with a
measurement (`BLOCK <ms> label=... slowOp=...`, `SLOW-SYNC <ms> <op>`), so the next
occurrence is attributed instead of argued.

Contributing, in order of measured weight:

1. **Log volume.** Whole-object dumps at 7.6 KB per call; no cap, no rotation, no dedupe.
2. **WMI/child-process churn.** `Get-CimInstance Win32_Process` is wedged on this box
   (its own 10 s deadline expires repeatedly: `[autoclose] process table unavailable ...
   timed out after 10000ms`). The child that hung at 16:14:36 was the reaper's process
   table query. The parent cannot kill it while blocked, so WMI contention compounds.
3. **`/health` was neither cheap nor first.** It sat *after* `express.json({limit:"5mb"})`,
   the guards and `precompressedStatic` (which calls `fs.statSync` for GETs on
   compressible/`/`-terminated paths) and it called `hasClaudeCreds()` (**existsSync +
   readFileSync**) on every probe - i.e. the one route that must answer during an incident
   was paying for blocking file I/O and queuing behind other work.

**Honest limitation:** while a synchronous call *holds* the loop, nothing on that loop can
answer `/health` - not a handler, not a worker, not a timer. The fix therefore has to do
three separate things: (a) shrink the blocking writes that cause it, (b) make `/health` as
close to free as possible, and (c) **make the next hang diagnosable while it is happening**.
That last part is what was missing in this incident.

## 4. What I changed

### `src/company/loopWatchdog.ts` (new)
* **Block detection with attribution.** A 100 ms sampler records every block >= 500 ms with
  the *breadcrumb that was running* (`markBusy()` / `timeSyncOp()`), not just a number:
  `BLOCK 1181ms label="reaper pass" slowOp="fs.readFileSync(company/sessions.jsonl)"`.
* **Sync-op tracing.** `installSyncOpTracing()` wraps the 14 `fs.*Sync` primitives this
  codebase calls through `import fs from "node:fs"` and names any call >= 250 ms with its
  path. Two `Date.now()` reads per fs sync call; no allocation unless it is slow.
* **Evidence while the loop is blocked.** A worker thread shares a heartbeat
  (`SharedArrayBuffer` + `Atomics`) and writes `STALL main thread blocked for ~Ns
  label="..."` to `logs/router*.blocks.log` **from its own thread while the main thread is
  still stuck**, then `STALL-END` when it resumes. This is the piece the incident lacked:
  the supervisor's "no /health answer" now has a timestamped, attributed cause next to it,
  written before anyone restarts anything.
* **Log-spam cap** (`installLogCap()`, `ROUTER_LOG_CAP=0` to disable):
  truncates a single chunk to 512 chars (a 7.6 KB dump becomes bounded), collapses
  consecutive identical lines and enforces a 1 MB/s budget, announcing what it removed.
  Startup/lifecycle lines the supervisor and ops scripts grep for are never capped.
* Every knob is env-overridable (`ROUTER_LOG_MAX_LINE`, `ROUTER_LOG_BUDGET_BPS`,
  `ROUTER_BLOCK_REPORT_MS`, `ROUTER_SYNC_OP_REPORT_MS`, `ROUTER_STALL_REPORT_MS`,
  `ROUTER_LOOP_WORKER`, `ROUTER_SYNC_TRACE`) and the module never throws into boot.

### `src/server.ts`
* `/health` is now registered **immediately after `const app = express()`**, i.e. before
  `express.json`, the guards, `precompressedStatic` and `express.static`, so nothing this
  process does can queue in front of it.
* The handler does **no file I/O**: `credsPresent` is a cached boolean refreshed by an
  unref'd 30 s timer (plus one warm-up read at boot) instead of `hasClaudeCreds()` per probe.
* The response keeps every existing field (`ok`, `lagMs`, `lagP95Ms`, `lagMaxMs`,
  `lagSamples`, ...) so `ops/router-supervisor.ps1` and the ops scripts keep working, and
  adds a `loop` object: `busy`, `lagNowMs`, `maxBlockMs`, `blocks`, `lastBlock`,
  `lastSlowOp`, `stall`, `logCap`.
* `installLoopWatchdog({ port })` runs before all other boot work (the session/task/fleet
  reconciles are synchronous reads of company data, so a slow boot is attributed too).

### `src/company/brainRouter.ts`
* `brainStats()` re-read and `JSON.parse`d the **whole** `company/budget/brain-decisions.jsonl`
  on **every** call, and `/company/budget` is polled by the dashboard (it rides along with
  the budget poll). The live log is **214 KB / 472 decisions** and grows with every routing
  decision, so each poll paid a blocking read + ~470 parses on the event loop - on a box
  whose fs metadata is AV-inflated. It is now memoised on the file's `mtime+size` with the
  repo's existing `cachedBySig`/`fileSig` (the rule `cache.ts` applies everywhere), and
  callers get a copy so the memo cannot be poisoned by mutation. Measured over two runs: **cold 2.1-2.9 ms of
  blocking loop time per poll -> warm 0.02-0.04 ms** (idle box; the per-poll read is what
  the memo removes, and it grows with the log).
  A write is picked up on the very next call (`Q8`).

### `ops/loop-watchdog-selftest.ts` (new)
33 checks, throwaway process, temp evidence file, no server and no company data touched.

## 5. Verification (copy/paste)

```powershell
cd "C:\Users\user\Desktop\Default Project"
npx tsc --noEmit                                  # must be silent
npx tsx ops\loop-watchdog-selftest.ts             # expect: ALL CHECKS PASSED (33 checks)
npx tsx ops\brain-stats-cache-check.ts            # expect: ALL CHECKS PASSED (10 checks)
powershell -NoProfile -ExecutionPolicy Bypass -File ops\health-acceptance-probe.ps1
```

Saved run: `logs/loop-watchdog-selftest.txt` (33 checks) and `logs/brain-stats-cache-check.txt`
(10 checks: today's lines folded, other days ignored, malformed line skipped, write
invalidates, returned object cannot poison the memo, warm call is a stat). The watchdog
selftest proves, among others:

* a 1.2 s block is recorded **with its breadcrumb** (`B1-B4`);
* the watchdog **thread** wrote its STALL line at a timestamp **inside** the blocked
  window, with the label of what was running (`C1-C5`) - i.e. evidence exists before a
  restart;
* a slow synchronous op names itself, both through `timeSyncOp()` and through the traced
  `fs.readFileSync(...)` (`D1-D3`), and the tracing is transparent (`E1-E3`);
* a 4 KB log line is truncated to <=235 chars, 500 identical lines become **1** physical
  write, the byte budget drops and announces volume (`F1-H2`), and supervisor-matched
  lines are never capped (`I1`);
* `/health` is registered before every middleware and its handler contains no file I/O
  (`J1-J4`).

Live acceptance on an **isolated** instance (never `:8787`; `PORT=8799`, temp
`COMPANY_ROOT`, temp cwd, `MOCK_MODE=1`, `AUTOCLOSE=0`). Reproducible script (it refuses
to run on 8787 and stops only the process it started):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ops\health-acceptance-probe.ps1
```

Recorded runs: `logs/loop-watchdog-acceptance.txt` (runs A-C, including a run that caught a
real 488 ms synchronous `fs.openSync` of a session journal on this box with the loop 598 ms late).

Result: boot 0.5 s, `/health` answered, `p50=11.9-12.1 ms p95=13.6-21.6 ms max=27.8 ms`
over 50 probes (that is PowerShell's `Invoke-WebRequest` overhead; the payload itself measures
`0.001 ms/call`), body includes the new `loop` block, and the watchdog created
`logs\router-8799.blocks.log` with its `WATCHDOG installed ...` and `WATCHER started` lines.

### How to verify after the CEO restarts the router

```powershell
# 1. the new shape is live
curl.exe -s http://127.0.0.1:8787/health        # expect a "loop" object inside the JSON

# 2. the watchdog is up (one line per boot, plus one per reported block)
Get-Content logs\router.blocks.log -Tail 20

# 3. the log cap is working: dumps can no longer be 7.6 KB lines
Get-Content logs\router.out.log -Tail 5         # long lines end with "…[line truncated by loopWatchdog]"

# 4. next incident: the supervisor's "no /health answer" now has a cause next to it
Get-Content logs\router.blocks.log | Select-String "STALL|BLOCK|SLOW-SYNC"
```

Expected in a healthy hour: one `WATCHDOG installed` line, `blocks: 0`, `stallReports: 0`
in `/health`, and **no** `router.out.log` growth from whole-object dumps.

## 6. Residual risk / what this does NOT fix

* `/health` still cannot answer while a synchronous call holds the loop. It is now first in
  the chain, free of I/O, and the watchdog records the block from another thread - but the
  cure is removing the blocking call, which the next `STALL`/`SLOW-SYNC` line will name.
* `src` changes only take effect on the next router start. **The CEO decides that** (order:
  do not restart `:8787`, do not kill pid 1984). Until then the live process keeps running
  the 09:23 code, including the dumps counted above.
* The watchdog adds one worker thread (~a few MB) to a RAM-constrained box;
  `ROUTER_LOOP_WORKER=0` disables it (block detection + sync-op attribution still work).
* `precompressedStatic` still calls `fs.statSync` per compressible GET (owner: the PERF
  workstream). It is now *behind* `/health` at least, and each such stat is attributed by
  the new tracing instead of being invisible.
* `company/sessions.jsonl` (4.8 MB), `/company/panel` and the other PERF_SPEC items 1-4
  remain; this change does not address them.
* The same pattern as `brainStats()` exists in a few more uncached synchronous readers on
  poll paths (`budgetGuard.ledgerEvents`, `assistant.readRunCardFiles`, `briefing.lines`).
  I left those to their owners rather than widen this change into six files: they are now
  *attributed* by the watchdog when they stall the loop, which is the point of the
  instrumentation. `cachedBySig` + `fileSig` is the one-line fix for each of them.
