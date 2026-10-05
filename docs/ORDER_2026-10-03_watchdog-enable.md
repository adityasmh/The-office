# Order: enable the supervisor watchdog task

Narrow job, one command. Do it, print the final report, and END your turn. Do not wait, poll, loop, or re-read this order.

1. Run: `Enable-ScheduledTask -TaskName LayaSupervisorWatchdog`
2. Run: `(Get-ScheduledTask -TaskName LayaSupervisorWatchdog).State` and `([xml](Export-ScheduledTask -TaskName LayaSupervisorWatchdog)).Task.Actions.Exec.Command`
3. Print the final report: the state (expect Ready) and the action command (expect conhost.exe). Then END your turn.

Rules: touch nothing else. Do not run the watchdog script, do not run schtasks /run, do not touch the router, its supervisor, Laya, STT or TTS. If a command fails, print the exact error and END your turn.
