# Work order: bring the router back up (it is DOWN)

From: manager. Model: deepseek-v4.1-flash. Repo: C:\Users\user\Desktop\Default Project

Facts measured by the manager at 17:01 local:
- No listener on :8787, GET /health gives no answer. The old router (pid 9444) is not running. logs\router.out.log last line 16:45:25; logs\router.supervisor.log last line 16:45:27; logs\router.crash.log last line 16:45:32 (all "healthy pid=9444"), nothing since.
- The supervisor process (powershell pid 11992, `ops\router-supervisor.ps1`) and the scheduled task LayaCompanyRouterSupervisor (state Running) are alive but silent: it probably hung on a contended process table (router.err.log shows "[autoclose] process table unavailable ... timed out after 10000ms (WMI is contended)").
- The guarded restart worker (docs/ORDER_2026-10-01_router-restart.md, jcode pid 23532) killed pid 9444 as planned (~16:54) and is still running. Do not kill or disturb that worker; it needs the router back to re-queue two orders.
- Other workers (adaptive, kafka, metrics) have left throwaway `tsx src/server.ts` dev routers (tmp-adaptive-dev*.out.log) on other ports. Leave them alone (they are not :8787).

Do:
1. Idempotent first: check again that nothing listens on 8787 (use `netstat -ano | findstr :8787` as well as Get-NetTCPConnection; WMI may be slow). If a router is already up and /health answers, do nothing except report.
2. Read docs/ROUTER_RESTART_VERIFY_2026-09-30.md and ops/router-supervisor.ps1 (header + start logic) so you use the documented method.
3. Decide why the supervisor is silent: is pid 11992 hung (no CPU, no log)? If it is hung, stop ONLY that supervisor process (verify its command line is ops\router-supervisor.ps1 of this repo first) and its stale lock logs\router-supervisor.lock (verify the pid in it is dead or is that supervisor), then start the supervisor the documented way: `schtasks /run /tn LayaCompanyRouterSupervisor` (or the documented launcher) so exactly ONE supervisor owns the router. Do not start a second router by hand and never run the router in a visible window.
4. Wait for the router: poll GET /health up to 3 minutes (timeouts 20-30 s). Verify like before: one listener on 8787 with a fresh pid; 5x /health 200 (report max ms); GET / 200; GET /api/needs-you answers; router.err.log no UNCAUGHT/fatal lines after start.
5. Check that no running fleet order was hurt: compare company/fleet/orders.json statuses now with the snapshot %TEMP%\orders-before-restart.json if it exists (restart worker made it). Report any order that went running -> failed.
6. Do NOT touch Laya on :8000, Kafka, the cuda session, jcode sessions, or any other process. No secrets printed. No deletes except the stale supervisor lock described above. If the router cannot start (code error), read logs\router.crash.log and router.err.log, report the exact error and which file/worker owns it (adaptive = fomuperagy, air-gapped = fomupdu81a, metrics = fomupf7f4a, planner fix is done) and STOP.
7. Append a timestamped entry to docs/AGENT_COORDINATION.md: what was wrong, what you did, new pid, health numbers.

Report to the manager, not the CEO.
