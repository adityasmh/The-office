# Work order: Fix the Laya supervisor watchdog

SYMPTOM: Windows scheduled task LayaSupervisorWatchdog runs ops/supervisor-watchdog.ps1 every 1 minute and a console window keeps flashing on the user's screen. Last visible output: "decision=recover-supervisor reason=heartbeat-pid-dead heartbeat=27,270s heartbeatPid=14004 routerAnswer=nothing port=8787 ... remove the stale lock (if it names it) and run the task" then "no lock file to remove". The supervisor has been dead about 7.5h and recovery does nothing useful. The user calls these fatal bugs and does NOT want terminals opening and closing constantly.

STEPS
1. FIRST, as a stop-gap, run: Disable-ScheduledTask -TaskName LayaSupervisorWatchdog (reversible; re-enable only after your fix is verified).
2. Read ops/supervisor-watchdog.ps1 and the scheduled task definitions (LayaSupervisorWatchdog, LayaCompanySttServer, LayaCompanyTtsServer; use Get-ScheduledTask | Export-ScheduledTask). Find out:
   a. why a console window is visible even though -WindowStyle Hidden is set (powershell.exe still flashes a console; use conhost --headless, a wscript/vbs launcher, or a hidden non-interactive task),
   b. why the heartbeat stopped for 7.5h,
   c. why "recover-supervisor" ends with "no lock file to remove" and never actually starts the supervisor/router on port 8787.
3. Fix both: the watchdog must really recover the supervisor when it is dead, and must never show a window. Make it log quietly to logs/ instead of printing.
4. Check LayaCompanySttServer and LayaCompanyTtsServer (they relaunch every 2 min with conhost --headless): confirm they do not pile up duplicate python/node processes or waste RAM; fix if they do.
5. Verify: re-enable the watchdog, watch 3 consecutive runs, confirm no visible window, confirm port 8787 answers or that failure is logged with a clear reason. Leave no stray processes.

RULES
- Do not touch unrelated files. Keep changes small and plain.
- Free RAM is limited (about 2.8 GB): do not start heavy services you do not need.
- Do NOT start the Laya Python model process (PID 7024 was deliberately stopped by the user to free RAM).
- Report back in plain words: root cause, files changed, verification evidence.
