# Work order: start the company for today (2026-10-01)

From: manager (Claude). Model: deepseek-v4.1-flash. Repo: C:\Users\user\Desktop\Default Project

Goal: bring the whole system up after last night's planned shutdown and prove it is healthy.

Steps:
1. Read docs/SHUTDOWN_SPEC.md section 3 and ops/start-all.ps1 header. Do not kill anything.
2. Run: powershell -NoProfile -ExecutionPolicy Bypass -File ops\start-all.ps1 -NoBrowser
   (it starts Laya on :8000, re-enables the LayaCompanyRouterSupervisor task, waits for router :8787).
   A first attempt at 01:39 today left Laya and the router down - read logs\shutdown.log tail and
   logs\laya.out.log / logs\router.err.log to see why, and fix the cause if it is routine
   (stale lock logs\router-supervisor.lock, leftover node pids 6100/9448/15600, port held).
3. Verify with real requests: GET http://127.0.0.1:8000/health, GET http://localhost:8787/health,
   GET http://localhost:8787/ (dashboard), GET /api/needs-you, GET /api/manager-queue.
   Router is known to be slow (lagMax 30 s): use long timeouts before calling it down.
4. Do NOT click "Resume all" and do NOT approve/resume/drop any order. Another worker (today-queue) owns that.
5. Report to docs/AGENT_COORDINATION.md (append one entry, timestamped, numbers measured):
   what was down, what you did, final health results, free RAM, live jcode terminal count.

Rules: no secrets printed; no claude /login; no deletes. If something needs the CEO (login, secret,
deleting data) write it as one plain sentence under "NEEDS CEO" in your report and stop on that item only.
Report to the manager, not the CEO.
