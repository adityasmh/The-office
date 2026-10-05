# Report to the manager: docs/ORDER_2026-10-01_supervisor-heartbeat.md DONE (jcode kangaroo)

Written 2026-10-01 ~17:50 local (12:20Z). Channel note: the report was appended to
`docs/AGENT_COORDINATION.md` and is filed here as well because the two channels the project
normally uses for a directed report were both unavailable: the cross-swarm DM failed with
"Not in a swarm. Use a git repository to enable swarm features" (this session was not spawned
into a swarm), and `jcode transcript --mode send -S session_mizaru_1790672881349_4175b85894443872`
answered "does not have a connected TUI client for transcript injection". Nothing was sent to
the CEO. Read this file for the directed report.

## Status

DONE, with one live incident outside the order's scope flagged below.

## Deliverables (all on disk, parser-checked)

1. **`ops/router-supervisor.ps1` (small diff only).**
   - Writes `logs/router-supervisor.heartbeat`: one line, `<ISO local-offset stamp> pid=<n> ticks=<process start ticks>`.
   - Written at the top of every loop (main loop, startup-wait loop, child-wait loop) and once right after the lock is taken, paced at 15 s (`-HeartbeatSeconds`, 0 disables).
   - In-process, on a FileStream held open for the process lifetime (1.6 ms per write per the measurement in `docs/ROUTER_RESTART_VERIFY_2026-09-30.md` section 16). No spawned process, no WMI, no CIM on that path.
   - `Get-ListenerPid` now treats a successful `netstat -ano` as authoritative: a ran-but-empty netstat no longer falls through to `Get-NetTCPConnection`.
   - The CIM fallback survives only for the case where netstat itself cannot run, and it is hard-timeout bounded: `Start-Job` + `Wait-Job -Timeout 8`, job removed in `finally`, and a supervisor log line when it is abandoned.
   - `-Status` now prints the heartbeat age, so a human can see the difference between "watching" and "wedged".

2. **`ops/supervisor-watchdog.ps1` (new).** Dependency-free on purpose: `Get-Process`, netstat, a raw .NET socket that speaks one `GET /health`, `schtasks`, file timestamps. No WMI, no CIM.
   - Acts ONLY when the heartbeat is older than 90 s AND nothing answers on `127.0.0.1:8787`. A router that answers (even slowly, even with a non-ok body) is never a reason to touch the supervisor - that is the supervisor's own 30-minute rule.
   - Stops ONLY the pid named in the heartbeat, and only after proving that pid is that process: the command line must contain this repo's `ops/router-supervisor.ps1`, read WITHOUT WMI/CIM by walking PEB -> ProcessParameters -> CommandLine with kernel32/ntdll P/Invoke. If that read fails, the lock file's pid AND process start ticks must both match.
   - Removes `logs/router-supervisor.lock` ONLY if the lock names the pid it just dealt with and that pid is gone.
   - Then runs `schtasks /run /tn LayaCompanyRouterSupervisor` - the same documented way a human recovers the supervisor. It never starts a router itself.
   - One line per run to `logs/supervisor-watchdog.log`, capped at 2000 lines, including every run that did nothing.
   - `-WhatIf` prints and touches nothing. `logs/supervisor-watchdog.pause`, if present, makes it log "paused" and do nothing.

3. **`ops/supervisor-watchdog-check.ps1` (new): 45/45 PASS, exit 0.**
   - The four required cases: fresh heartbeat -> no action; stale heartbeat + router healthy -> no action; stale + nothing on the port + a command line that is NOT this repo's supervisor -> no action; stale + nothing on the port + the command line IS this repo's supervisor -> would stop the pid and run the task.
   - Extra guards proven: no heartbeat + supervisor alive -> no action; no heartbeat + dead port + supervisor gone -> recover (the 2026-10-01 shape); lock owned by another pid -> no action; reused pid (start ticks differ) -> no action; pause file -> no action; unparseable heartbeat -> no action.
   - End-to-end `-WhatIf` runs against the live `:8787`, against a verified free port, and against a throwaway stand-in process I started myself.
   - The REAL action path (no `-WhatIf`) is exercised against that stand-in, with the task name pointed at a task that does not exist, so nothing can start: the stand-in IS stopped and its lock IS removed. `schtasks` returned exit 0 for that nonexistent name on this box, so the self-test rejects a non-failure result and reports FAIL rather than "success".
   - Part D asserts the live `:8787` listener and the live supervisor pid were untouched by the test.

4. **`ops/install-supervisor-watchdog.ps1` (new): WRITTEN, NOT RUN.** Registers `LayaSupervisorWatchdog` (every 1 minute, hidden, `/it` so it runs as the current interactive user like `LayaCompanyRouterSupervisor`); refuses to install unless the check suite exits 0; `-Remove` unregisters it. Needs your approval per order item 4.

5. **Parser check: 0 errors** on `router-supervisor.ps1`, `supervisor-watchdog.ps1`, `supervisor-watchdog-check.ps1`, `install-supervisor-watchdog.ps1`.

6. **Heartbeat proven live, not asserted.** An isolated supervisor instance (`-Port 8801 -LogPrefix hbprobe`, watching a dev router it could not start or kill, own log files) wrote 4 distinct beats at 15.0 s intervals over 46 s, holding the same pid and ticks. The `:8801` listener pid was unchanged before and after; the live `:8787` router and supervisor were untouched.

## Two things the manager needs to act on

**A. The running supervisor predates the heartbeat, and is gone.** Pid 16656 started at 17:06 from the OLD script, so it has no heartbeat file at all. It also disappeared during the 17:37-17:40 window - I did not stop it, and I have no record of who did. `logs/router-supervisor.lock` is gone and the task `LayaCompanyRouterSupervisor` still reports Status: Running. A supervisor started from the NEW script is needed before this fix is armed.

**B. The live router on `:8787` is DOWN and has been since ~17:27-17:31.** Pid 24760 booted 17:02:18 and is gone: nothing listening, `curl /health` returns 000, no BOOT line in `logs/router.crash.log`, and no line in `logs/router.supervisor.log` after 17:08:47. I did not stop it and did not restart it (order item 4 forbids both). Restarting the live router is on the CEO-only list in `docs/TODAY_QUEUE_2026-10-01.md`. Note that the new watchdog covers exactly this failure shape once its supervisor is installed: no heartbeat (or a stale one) plus nothing on the port -> run the supervisor task, which then starts the router.

## What this does NOT fix

- The router's own synchronous `orders.json` save stalls (`src/company/fleet.ts:313-342`, `docs/ROUTER_RESTART_VERIFY_2026-09-30.md` section 19) - self-inflicted stalls that can wedge the router itself.
- The supervisor's log still records state CHANGES, so a quiet log is still not evidence of anything. The heartbeat is, which is the point of this order.

## Nothing else touched

No router or supervisor start/stop by me, no scheduled task registered, no `src/` edit, no secrets printed, no deletes. Laya `:8000`, Kafka, the cuda session and other workers' processes untouched. The only processes I ever stopped were the throwaway test stand-ins I started myself and my isolated supervisor instance.

## Addendum, ~17:52 local (written after the notes above)

While this order was finishing, someone on the manager side armed the patched supervisor, so the
heartbeat is now live in production. Measured facts, so the manager does not have to re-derive them:

- **`logs/router-supervisor.lock` and `logs/router-supervisor.heartbeat` now exist for pid 14004**, started 17:39:53, whose lock records `script=...\ops\router-supervisor.ps1`. `logs/router.supervisor.log` shows `17:40:22 supervisor started pid=14004 ... ramFloor=256 MB source=.env`.
- **The heartbeat works in production**: `router-supervisor.heartbeat` read `2026-10-01T17:52:23.528+05:30 pid=14004 ticks=639264531343927271`, i.e. 4.5 s old when read, and it is still advancing.
- **`ops/supervisor-watchdog.ps1 -Status` sees everything correctly** (heartbeat file, age, pid, lock owner, port answer, decision). Note it reports the lock script as this repo's `ops/router-supervisor.ps1`, which also demonstrates the no-WMI command-line/lock identity path against a real process.
- **`logs/supervisor-watchdog.pause` was created at 17:45:37 by that same manager-side action, not by me.** The watchdog therefore reports `reason=heartbeat-fresh` and would log `reason=paused` if the heartbeat went stale. That pause is worth a deliberate decision: while it exists, the new watchdog cannot recover anything. Its own log is empty, so nothing has been auto-recovered yet.
- **The router restart is NOT succeeding.** At 17:45:05 pid 14004 logged `starting router (attempt 1)` and at 17:46:34 `router command pid 24552`; at 17:51:41 it logged `router still running but /health was not ok within 300 s`. Two `node ... src/server.ts` processes exist (pids 8244 and 24984, started 17:47:47 and 17:50:30) but **nothing is listening on `127.0.0.1:8787`** and `/health` returns 000 as of 17:52. `logs/router.out.log` and `router.err.log` have no new lines, so the server is hanging before it binds. This is a router/code problem, not a heartbeat/watchdog problem, and it needs an owner: the patched supervisor is correctly supervising, it simply cannot make a server bind.

## What this does NOT fix
