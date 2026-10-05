# Work order: install the supervisor watchdog (CEO approved 2026-10-01 17:46)

From: manager. Model: deepseek-v4.1-flash. Repo: C:\Users\user\Desktop\Default Project

The CEO said "yes install the watchdog". Install `LayaSupervisorWatchdog` using the script the heartbeat worker wrote (ops/install-supervisor-watchdog.ps1). Read ops/install-supervisor-watchdog.ps1 and the header of ops/supervisor-watchdog.ps1 first; the installer re-runs ops/supervisor-watchdog-check.ps1 and a -WhatIf dry run before registering anything.

SAFETY ORDER (the router is still starting after today's outage; a watchdog that sees "no heartbeat + closed port" could kill the fresh supervisor mid-boot):
1. First create the pause switch `logs\supervisor-watchdog.pause` (empty file) so the task, once registered, cannot act.
2. Run `powershell -NoProfile -ExecutionPolicy Bypass -File ops\install-supervisor-watchdog.ps1 -DryRun` and read its output. If the tests fail, STOP and report; do not install. Do not edit ops\supervisor-watchdog.ps1 or ops\router-supervisor.ps1 (the heartbeat worker, pid 1132, may still be editing them: if it is alive, wait until it finishes or until its log logs\jcode-supervisor-heartbeat-20261001.log has been silent for 3 minutes, then proceed).
3. Run the installer for real (no -DryRun). Verify with `schtasks /query /tn LayaSupervisorWatchdog /fo list /v`: state Ready/Running, runs every 1 minute, current user, hidden. Verify the task fires: after 70-90 s `logs\supervisor-watchdog.log` has a new line and it says it did NOTHING because of the pause switch.
4. Enabling: only when ALL are true, delete `logs\supervisor-watchdog.pause`: (a) netstat shows a listener on :8787 and GET http://localhost:8787/health returns 200 (30 s timeout), (b) `logs\router-supervisor.heartbeat` exists and is younger than 60 s and names a live supervisor pid whose command line contains router-supervisor.ps1 of this repo, (c) exactly one such supervisor process is running. If any is false, leave the pause switch in place and report exactly which condition failed (the manager enables it later). After removing the pause switch, watch the log for 2-3 runs: each must say "no action" (router healthy, heartbeat fresh).
5. Do NOT stop, restart or edit the running supervisor or router, do not touch Laya, Kafka, the cuda session or other workers' processes. No secrets, no deletes except the pause switch you created.
6. Append a timestamped entry to docs/AGENT_COORDINATION.md: task state, pause-switch state, log lines proving it ran. Report to the manager, not the CEO.
