# Order: re-register the supervisor watchdog task with no visible window

Narrow job. Do exactly these steps, print the final report, and END your turn. Do not wait, poll, loop, or re-read this order.

## Facts (already established, do not re-investigate)
- Scheduled task `LayaSupervisorWatchdog` is registered with action `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ...supervisor-watchdog.ps1` every 1 minute and is currently DISABLED. That form flashes a console window every minute.
- `ops/install-supervisor-watchdog.ps1` was already edited so it registers the task as `conhost.exe --headless powershell.exe ...`, which never shows a window. The old registration was never replaced.
- The router (port 8787) and `LayaCompanyRouterSupervisor` are healthy right now. Do NOT touch them, do not run `schtasks /run` on them, do not restart the router, do not touch Laya serving files, STT or TTS tasks.

## Steps
1. Syntax-check only, no behavior change: run `powershell -NoProfile -ExecutionPolicy Bypass -File ops\supervisor-watchdog.ps1 -WhatIf` and confirm it exits 0 and prints a decision of "healthy / nothing to do" (the supervisor heartbeat is fresh). If it prints any action decision, STOP and report that instead.
2. Run `powershell -NoProfile -ExecutionPolicy Bypass -File ops\supervisor-watchdog-check.ps1` and record pass/fail counts.
3. Run `node --check tools/tts/server.mjs` and `python -m py_compile tools/tts/joey/worker.py` (those two files were edited by an earlier worker that died mid-job). Report if either fails. Do not edit them unless there is a plain syntax error; if so, fix only that error.
4. Re-register the task by running `powershell -NoProfile -ExecutionPolicy Bypass -File ops\install-supervisor-watchdog.ps1`. Then run `Export-ScheduledTask -TaskName LayaSupervisorWatchdog` and confirm the action starts with `conhost.exe --headless`.
5. The install may leave the task enabled. Disable it again with `Disable-ScheduledTask -TaskName LayaSupervisorWatchdog` (the manager will enable it after review). Confirm state is Disabled.
6. Print the final report: what steps 1-5 showed (exit codes, pass/fail counts, the registered action text, final task state), then END your turn.

## Rules
- Touch no file other than the ones named above, and only to fix a plain syntax error.
- Never read another worker's log.
- If any step fails, report the exact error and END your turn; do not retry in a loop.
