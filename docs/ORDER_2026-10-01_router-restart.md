# Work order: restart the main router (CEO ordered it) and prove the new budget page is live

From: manager. Model: deepseek-v4.1-flash. Repo: C:\Users\user\Desktop\Default Project (Windows PowerShell).
The CEO ordered this restart. It is routine for you; do exactly the steps, nothing else.

## Why
The running router (node pid 24984, booted 17:55 IST) predates: the real-budget work (GET /company/budget/real, no per-agent quotas), the budget-guard-direct change (Fleet orders that will run on DeepSeek direct are not held for OpenCode Go quota), plus earlier edits. It also lags badly (28 s, worst 115 s). A fresh boot picks all of it up.

## Steps
1. WAIT GATE (do this first): wait until it is 18:30 IST OR the process with pid 22100 (the budget-guard-direct worker) has exited, whichever comes first. Then run `.\node_modules\.bin\tsc.cmd --noEmit`; it must print nothing and exit 0. If it fails, wait up to 10 more minutes polling every 30 s (another worker is mid-edit); if still failing, STOP and report the first 10 error lines. Do not fix other workers' code.
2. Read docs/CEO_RUNBOOK.md (restart / lifecycle section) and ops/router-supervisor.ps1 header so you restart the supported way: through the supervisor watchdog (scheduled task `LayaCompanyRouterSupervisor` / ops/router-supervisor.ps1). Do NOT start a second router by hand, do NOT run `npm run dev`. Do NOT kill anything except the single router listener on 127.0.0.1:8787 (node server.ts process and its tsx wrapper, same as docs/ROUTER_RESTART_VERIFY_2026-09-30.md describes); the supervisor then starts the replacement.
3. Before stopping it: GET http://localhost:8787/company/fleet/orders (token via GET /company/auth/bootstrap, never print it; use 90 s timeouts) and record which orders are `running` and which work orders are `working`. Do not stop it during the middle of a `orders.json` write: if the file's mtime changed in the last 3 s, wait 5 s and recheck.
4. Stop the listener, then wait for the supervisor's replacement. Boot takes minutes under load; wait up to 10 minutes for GET /health to answer, polling every 15 s. Record the new node pid, boot time, and first /health numbers (lagMs, lagMaxMs).
5. After it is up, verify with real requests (long timeouts):
   - GET /company/budget/real -> 200. Print: Go windows (5h / weekly / monthly % left), DeepSeek balance and phase line, Claude status line, spend today / 7 days. The key must not appear anywhere you print.
   - GET /company/panel -> has `realBudget`; no per-agent allocated caps; dashboard http://localhost:8787/ returns 200 and its HTML/JS contains the new budget wording ("Provider limits" or similar from public/index.html and public/v2/views/budget.js; grep the served text).
   - POST /company/agents/<any agent key from GET /company/agents>/message with {"text":"ping","run":false} is NOT refused with 402/budget_exhausted. (run:false only; do not start any agent work.)
6. Reconcile: compare the running/working list from step 3 with now. For any order the restart marked `failed` that was running a moment ago (the boot reconcile can do that), re-queue it by POST /company/projects/:id/run {taskId} for pipeline tasks, or the fleet work-order redo route for fleet work orders (POST /company/fleet/orders/:id/work/:wid/redo). Routine only. List what you resumed.
7. Check the held orders fomupf7f4a (metrics stack) and fomupiu2hf (router stall fix): print their status, work order states and last trace line. Do not approve, cancel or override anything. If they still say "waiting: budget", say so in the report.

## Rules
No secrets printed. No deletes. Do not touch Laya serving (:8000), Kafka (:9092), scripts/serve-laya.ps1. Do not edit source files. Do not send Slack or any outbound message. Do not use any budget override or grant.
Append a timestamped entry to docs/AGENT_COORDINATION.md: restart times, pids, health numbers, the /company/budget/real numbers you saw, what you resumed. Report to the manager.
