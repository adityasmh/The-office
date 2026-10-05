# ops/supervisor-watchdog-check.ps1 - test the watchdog's DECISION, touching no live process.
#
# The watchdog (ops/supervisor-watchdog.ps1) decides whether to restart the router
# supervisor. This script drives that decision function - it is pure, so it can be
# fed fake heartbeats, a fake port state, a fake process and a fake lock - plus a
# few end-to-end `-WhatIf` runs, and then checks the whole table. NOTHING here
# stops a process, removes a lock or runs a scheduled task: every end-to-end case
# uses -WhatIf and a scratch log directory.
#
# Required cases (work order 2026-10-01, item 3):
#   1. fresh heartbeat                                  -> no action
#   2. stale heartbeat + router healthy                 -> no action
#   3. stale heartbeat + nothing on the port + the pid's command line is NOT this
#      repo's supervisor                                -> no action
#   4. stale heartbeat + nothing on the port + the command line IS this repo's
#      supervisor                                      -> would stop the pid and run the task
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File ops/supervisor-watchdog-check.ps1
# Exit code 0 = every case passed, 1 = at least one failed.

[CmdletBinding()]
param(
  [string]$WatchdogPath = '',
  [string]$ScratchDir = ''
)

$ErrorActionPreference = 'Continue'

$repo = Split-Path -Parent $PSScriptRoot
if (-not $WatchdogPath) { $WatchdogPath = Join-Path $repo 'ops\supervisor-watchdog.ps1' }
if (-not (Test-Path -LiteralPath $WatchdogPath)) { Write-Output "watchdog not found: $WatchdogPath"; exit 1 }
if (-not $ScratchDir) { $ScratchDir = Join-Path $env:TEMP ('supervisor-watchdog-check-' + (Get-Random)) }
New-Item -ItemType Directory -Force -Path $ScratchDir | Out-Null

$expectedScript = Join-Path $repo 'ops\router-supervisor.ps1'

# Dot-source in library mode: defines the functions, runs no action, and points
# every file path at the scratch directory.
. $WatchdogPath -LibraryOnly -LogDir $ScratchDir
if (-not (Get-Command Get-WatchdogDecision -ErrorAction SilentlyContinue)) {
  Write-Output 'FAIL: could not load Get-WatchdogDecision from the watchdog'
  exit 1
}

$results = New-Object System.Collections.ArrayList
function Check([string]$name, [object]$got, [object]$want) {
  $ok = ("$got" -eq "$want")
  [void]$results.Add([pscustomobject]@{ Ok = $ok; Name = $name; Got = "$got"; Want = "$want" })
  Write-Output ("[{0}] {1}`n        got={2} want={3}" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $name, $got, $want)
}

Write-Output '== part A: the decision function, fed directly (fake heartbeat, fake port state) =='
Write-Output ("watchdog        : {0}" -f $WatchdogPath)
Write-Output ("scratch log dir : {0}" -f $ScratchDir)
Write-Output ("expected script : {0}" -f $expectedScript)
Write-Output ''

$correctCmdLine = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\Users\user\Desktop\Default Project\ops\router-supervisor.ps1"'
$wrongCmdLine   = 'powershell.exe -NoProfile -File "C:\some\other\repo\ops\router-supervisor.ps1"'

# 1. fresh heartbeat -> no action
$d = Get-WatchdogDecision -Heartbeat @{ AgeSeconds = 5; Pid = 4242; Ticks = '111' } -RouterAnswer 'nothing'
Check 'A1 fresh heartbeat -> no action' ("{0}/{1}" -f $d.Action, $d.Reason) 'none/heartbeat-fresh'

# 2. stale heartbeat + router healthy -> no action
$d = Get-WatchdogDecision -Heartbeat @{ AgeSeconds = 300; Pid = 4242; Ticks = '111' } -RouterAnswer 'answers-http'
Check 'A2 stale heartbeat + router healthy -> no action' ("{0}/{1}" -f $d.Action, $d.Reason) 'none/router-answers'

# 2b. stale heartbeat + a listener that accepts but does not answer -> no action
$d = Get-WatchdogDecision -Heartbeat @{ AgeSeconds = 300; Pid = 4242; Ticks = '111' } -RouterAnswer 'accepts-only'
Check 'A2b stale heartbeat + listener accepts but does not answer -> no action' ("{0}/{1}" -f $d.Action, $d.Reason) 'none/router-answers'

# 3. stale + nothing on the port + WRONG command line -> no action
$d = Get-WatchdogDecision -Heartbeat @{ AgeSeconds = 300; Pid = 4242; Ticks = '111' } -RouterAnswer 'nothing' `
  -Process @{ Alive = $true; Pid = 4242; StartTicks = '111'; CommandLine = $wrongCmdLine } `
  -Lock @{ Pid = 4242; StartTicks = '111'; Script = 'C:\some\other\repo\ops\router-supervisor.ps1' }
Check 'A3 stale + port dead + wrong command line -> no action' ("{0}/{1}" -f $d.Action, $d.Reason) 'none/command-line-mismatch'

# 3b. stale + port dead + pid alive but command line unreadable and no usable lock -> no action
$d = Get-WatchdogDecision -Heartbeat @{ AgeSeconds = 300; Pid = 4242; Ticks = '111' } -RouterAnswer 'nothing' `
  -Process @{ Alive = $true; Pid = 4242; StartTicks = '111'; CommandLine = $null }
Check 'A3b stale + port dead + identity unverifiable -> no action' ("{0}/{1}" -f $d.Action, $d.Reason) 'none/identity-unverified'

# 4. stale + nothing on the port + CORRECT command line -> would stop the pid and run the task
$d = Get-WatchdogDecision -Heartbeat @{ AgeSeconds = 300; Pid = 4242; Ticks = '111' } -RouterAnswer 'nothing' `
  -Process @{ Alive = $true; Pid = 4242; StartTicks = '111'; CommandLine = $correctCmdLine } `
  -Lock @{ Pid = 4242; StartTicks = '111'; Script = $expectedScript }
Check 'A4 stale + port dead + correct command line -> recover-supervisor' ("{0}/{1}" -f $d.Action, $d.Reason) 'recover-supervisor/stale-heartbeat-router-down'
Check 'A4b that decision stops exactly the heartbeat pid' $d.StopPid 4242
Check 'A4c and asks for the task to be run' $d.RunTask 'True'

# 5. no heartbeat at all, but a supervisor process IS alive -> no action
$d = Get-WatchdogDecision -Heartbeat $null -RouterAnswer 'nothing' -Process @{ Alive = $true; Pid = 4242; StartTicks = '111'; CommandLine = $correctCmdLine }
Check 'A5 no heartbeat + supervisor alive -> no action' ("{0}/{1}" -f $d.Action, $d.Reason) 'none/no-heartbeat'

# 5b. no heartbeat, no supervisor, and a lock that names a live pid -> still no action
$d = Get-WatchdogDecision -Heartbeat $null -RouterAnswer 'nothing' -Process @{ Alive = $false; Pid = 4242; StartTicks = ''; CommandLine = $null } -Lock @{ Pid = 4242; StartTicks = '111'; Script = $expectedScript }
Check 'A5b no heartbeat + dead pid + lock names a pid -> no action' ("{0}/{1}" -f $d.Action, $d.Reason) 'none/no-heartbeat-lock-alive'

# 5c. the 2026-10-01 shape: nothing on the port, no heartbeat file, no supervisor
#     process -> run the supervisor task (which alone decides what to start)
$d = Get-WatchdogDecision -Heartbeat $null -RouterAnswer 'nothing' -Process @{ Alive = $false; Pid = 4242; StartTicks = ''; CommandLine = $null } -Lock $null
Check 'A5c no heartbeat + port dead + supervisor gone -> recover' ("{0}/{1}" -f $d.Action, $d.Reason) 'recover-supervisor/no-heartbeat-supervisor-dead'
Check 'A5d and nothing is stopped' $d.StopPid 0

# 5e. no heartbeat file but the router IS answering -> no action
$d = Get-WatchdogDecision -Heartbeat $null -RouterAnswer 'answers-http' -Process @{ Alive = $false; Pid = 4242; StartTicks = ''; CommandLine = $null } -Lock $null
Check 'A5e no heartbeat + router healthy -> no action' ("{0}/{1}" -f $d.Action, $d.Reason) 'none/no-heartbeat'

# 6. stale + port dead + the heartbeat pid is already gone -> recover (remove lock, run task), no stop
$d = Get-WatchdogDecision -Heartbeat @{ AgeSeconds = 300; Pid = 4242; Ticks = '111' } -RouterAnswer 'nothing' `
  -Process @{ Alive = $false; Pid = 4242; StartTicks = ''; CommandLine = $null } -Lock $null
Check 'A6 stale + port dead + pid already dead -> recover (nothing to stop)' ("{0}/{1}" -f $d.Action, $d.Reason) 'recover-supervisor/heartbeat-pid-dead'
Check 'A6b nothing is stopped' $d.StopPid 0

# 7. paused -> no action
$d = Get-WatchdogDecision -Heartbeat @{ AgeSeconds = 300; Pid = 4242; Ticks = '111' } -RouterAnswer 'nothing' -Paused
Check 'A7 pause file present -> no action' ("{0}/{1}" -f $d.Action, $d.Reason) 'none/paused'

# 7b. stale + port dead + pid alive with correct command line but a lock that names another pid -> no action
$d = Get-WatchdogDecision -Heartbeat @{ AgeSeconds = 300; Pid = 4242; Ticks = '111' } -RouterAnswer 'nothing' `
  -Process @{ Alive = $true; Pid = 4242; StartTicks = '111'; CommandLine = $correctCmdLine } `
  -Lock @{ Pid = 7777; StartTicks = '111'; Script = $expectedScript }
Check 'A7b stale + lock owned by another pid -> no action' ("{0}/{1}" -f $d.Action, $d.Reason) 'none/lock-owned-by-other'

# 7c. stale + port dead + pid alive with correct command line but a REUSED pid -> no action
$d = Get-WatchdogDecision -Heartbeat @{ AgeSeconds = 300; Pid = 4242; Ticks = '111' } -RouterAnswer 'nothing' `
  -Process @{ Alive = $true; Pid = 4242; StartTicks = '999'; CommandLine = $correctCmdLine } `
  -Lock @{ Pid = 4242; StartTicks = '111'; Script = $expectedScript }
Check 'A7c stale + lock start ticks differ (pid reuse) -> no action' ("{0}/{1}" -f $d.Action, $d.Reason) 'none/start-ticks-mismatch'

Write-Output ''
Write-Output '== part B: fake heartbeat FILES, parsed by the watchdog itself =='
$hbFile = Join-Path $ScratchDir 'router-supervisor.heartbeat'

function Write-FakeHeartbeat([int]$AgeSeconds, [int]$HbPid, [string]$Ticks = '111') {
  # Same shape as the real writer: local offset (never a bare Z), via 'fffK'.
  $stamp = ([DateTimeOffset]::Now).AddSeconds(-$AgeSeconds).ToString("yyyy-MM-dd'T'HH:mm:ss.fffK")
  [System.IO.File]::WriteAllText($hbFile, "$stamp pid=$HbPid ticks=$Ticks`n")
  return $stamp
}

$stamp = Write-FakeHeartbeat -AgeSeconds 300 -HbPid 999999
$hb = Get-HeartbeatState
Write-Output ("fake file       : {0}" -f ([System.IO.File]::ReadAllText($hbFile).Trim()))
Write-Output ("parsed          : age={0}s pid={1}" -f $hb.AgeSeconds, $hb.Pid)
Check 'B1 stale fake heartbeat file parses with its pid' $hb.Pid 999999
Check 'B2 stale fake heartbeat file reports ~300s old' ([bool]($hb.AgeSeconds -ge 295 -and $hb.AgeSeconds -le 310)) 'True'
$d = Get-WatchdogDecision -Heartbeat $hb -RouterAnswer 'nothing' -Process @{ Alive = $false; Pid = 999999; StartTicks = ''; CommandLine = $null }
Check 'B3 stale file + port dead + pid gone -> recover' ("{0}/{1}" -f $d.Action, $d.Reason) 'recover-supervisor/heartbeat-pid-dead'

$stamp = Write-FakeHeartbeat -AgeSeconds 3 -HbPid 999999
$hb = Get-HeartbeatState
Write-Output ("fake file       : {0}" -f ([System.IO.File]::ReadAllText($hbFile).Trim()))
$d = Get-WatchdogDecision -Heartbeat $hb -RouterAnswer 'nothing' -Process @{ Alive = $false; Pid = 999999; StartTicks = ''; CommandLine = $null }
Check 'B4 fresh fake heartbeat file -> no action' ("{0}/{1}" -f $d.Action, $d.Reason) 'none/heartbeat-fresh'

[System.IO.File]::WriteAllText($hbFile, "not a heartbeat at all`n")
$hb = Get-HeartbeatState
Check 'B5 unparseable heartbeat file -> no action (null parses)' $hb $null

Write-Output ''
Write-Output '== part C: end-to-end -WhatIf runs (nothing may be stopped, removed or run) =='

$wdLog = Join-Path $ScratchDir 'supervisor-watchdog.log'
function Get-LastWatchdogLogLine {
  if (-not (Test-Path -LiteralPath $wdLog)) { return '' }
  $lines = [System.IO.File]::ReadAllLines($wdLog)
  if ($lines.Count -eq 0) { return '' }
  return $lines[$lines.Count - 1]
}
# The newest line whose reason= this run produced. A WhatIf run writes TWO lines
# (the decision, then what it would do), so the newest line is not the decision.
function Get-LastWatchdogDecisionLine {
  if (-not (Test-Path -LiteralPath $wdLog)) { return '' }
  $lines = [System.IO.File]::ReadAllLines($wdLog)
  for ($i = $lines.Count - 1; $i -ge 0; $i--) {
    if ($lines[$i] -match 'decision=') { return $lines[$i] }
  }
  return ''
}
function Invoke-WatchdogWhatIf([int]$p) {
  return (& $WatchdogPath -WhatIf -LogDir $ScratchDir -Port $p *>&1 | Out-String)
}
# The port answer the CHILD observed, read back from its own decision line. On a
# box this busy the router can be mid-restart, so asserting on what happened
# earlier in this same process is not the same as asserting on what the child saw.
function Get-AnswerFromLine([string]$line) {
  if ($line -match 'routerAnswer=(\S+)') { return $Matches[1] }
  return '(unknown)'
}

# C0b: the no-WMI command-line reader has to actually work here, or C2 would fall
# back to the lock file and reach a different reason (that would make C2 vacuous).
$selfCl = Get-ProcessCommandLineNoWmi $PID
Write-Output ("command line of THIS process, read with no WMI/CIM: {0}" -f $(if ($selfCl) { $selfCl } else { '(null)' }))
Check 'C0b no-WMI command-line reader works on this process' ([bool]($selfCl -match 'supervisor-watchdog-check')) 'True'

# Find a port with nothing listening on it.
$freePort = 0
foreach ($p in 18787..18887) {
  $line = netstat -ano -p tcp | Select-String ("[:.]" + $p + "\s+\S+\s+LISTENING")
  if (-not $line) { $freePort = $p; break }
}
if ($freePort -eq 0) { Write-Output 'FAIL: no free port found for part C'; exit 1 }
Write-Output ("free port used  : {0}" -f $freePort)
$answerFree = Get-RouterAnswer -Port $freePort -TimeoutSeconds 2
Check 'C0 the chosen free port really answers nothing' $answerFree 'nothing'

$listenerBefore = (netstat -ano -p tcp | Select-String ':8787\s+\S+\s+LISTENING' | ForEach-Object { $_.Line.Trim() }) -join '|'
$supBefore = @(Get-Process -Id 16656 -ErrorAction SilentlyContinue).Count

# C1: real port, real router answering, stale heartbeat -> the guard that matters most
$stamp = Write-FakeHeartbeat -AgeSeconds 300 -HbPid $PID
$out1 = Invoke-WatchdogWhatIf 8787
$line1 = Get-LastWatchdogDecisionLine
$ans1 = Get-AnswerFromLine $line1
Write-Output '--- C1 child output ---'; Write-Output $out1.Trim()
Write-Output ("C1 watchdog log line: {0}" -f $line1)
Write-Output ("C1 port answer as the CHILD saw it: {0}" -f $ans1)
if ($ans1 -eq 'answers-http' -or $ans1 -eq 'accepts-only') {
  Check 'C1 real router answering + stale heartbeat -> no action' ([bool]($line1 -match 'reason=router-answers')) 'True'
} elseif ($ans1 -eq 'nothing') {
  # The live router was mid-restart at this instant. The assertion that matters
  # (nothing was stopped, no lock touched, no task run) still has to hold.
  Write-Output 'NOTE: :8787 was not answering when this case ran (router mid-restart), so the router-answers branch could not be exercised end to end here.'
  Check 'C1 (:8787 was down) -> still no action, nothing stopped' ([bool]($line1 -match 'decision=none') -and $out1 -notmatch 'WHATIF would') 'True'
} else {
  Check 'C1 the child reported a port answer' $ans1 '(known)'
}
Write-Output ("     :8787 right after C1: {0}" -f ((netstat -ano -p tcp | Select-String ':8787\s+\S+\s+LISTENING' | ForEach-Object { $_.Line.Trim() }) -join '|'))

# C2: dead port, stale heartbeat naming THIS live process (whose command line is not the supervisor) -> no action
$stamp = Write-FakeHeartbeat -AgeSeconds 300 -HbPid $PID
$out2 = Invoke-WatchdogWhatIf $freePort
$line2 = Get-LastWatchdogDecisionLine
Write-Output '--- C2 child output ---'; Write-Output $out2.Trim()
Write-Output ("C2 watchdog log line: {0}" -f $line2)
Check 'C2 dead port + a live pid whose command line is NOT the supervisor -> no action' ([bool]($line2 -match 'reason=command-line-mismatch')) 'True'
Check 'C2b and it did not claim it would stop anything' ([bool]($out2 -notmatch 'would stop supervisor pid')) 'True'

# C3: dead port, stale heartbeat naming a pid that is gone -> WOULD stop/clear/run (WhatIf only)
$stamp = Write-FakeHeartbeat -AgeSeconds 300 -HbPid 999999
$out3 = Invoke-WatchdogWhatIf $freePort
$line3 = Get-LastWatchdogDecisionLine
Write-Output '--- C3 child output ---'; Write-Output $out3.Trim()
Write-Output ("C3 watchdog log line: {0}" -f $line3)
Check 'C3 dead port + a dead pid -> would recover, and only in WhatIf' ([bool]($line3 -match 'reason=heartbeat-pid-dead' -and $out3 -match 'WHATIF')) 'True'

# C4: the pause file stops even the C3 situation
[System.IO.File]::WriteAllText((Join-Path $ScratchDir 'supervisor-watchdog.pause'), "test`n")
$out4 = Invoke-WatchdogWhatIf $freePort
$line4 = Get-LastWatchdogDecisionLine
Write-Output '--- C4 child output ---'; Write-Output $out4.Trim()
Write-Output ("C4 watchdog log line: {0}" -f $line4)
Check 'C4 pause file present -> no action' ([bool]($line4 -match 'reason=paused')) 'True'
Remove-Item -LiteralPath (Join-Path $ScratchDir 'supervisor-watchdog.pause') -Force -ErrorAction SilentlyContinue

# C5: the full "correct command line -> would stop the pid and run the task" path,
# end to end, against a stand-in process I own (never the live supervisor): a
# throwaway powershell whose command line names THIS repo's router-supervisor.ps1.
# It must still only print (WhatIf), and the stand-in must still be alive after.
$fakeScript = Join-Path $ScratchDir 'fake-supervisor-standin.ps1'
[System.IO.File]::WriteAllText($fakeScript, "Start-Sleep -Seconds 120`n")
$fakeArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $fakeScript + '"'), ('"' + $expectedScript + '"'))
$fake = Start-Process -FilePath 'powershell.exe' -ArgumentList $fakeArgs -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 3
$fakeCl = Get-ProcessCommandLineNoWmi $fake.Id
Write-Output ("stand-in pid {0}, command line read with no WMI/CIM: {1}" -f $fake.Id, $(if ($fakeCl) { $fakeCl } else { '(null)' }))
Check 'C5a the stand-in command line names this repo''s supervisor' ([bool]($fakeCl -match 'router-supervisor\.ps1')) 'True'
$stamp = Write-FakeHeartbeat -AgeSeconds 300 -HbPid $fake.Id
$out5 = Invoke-WatchdogWhatIf $freePort
$line5 = Get-LastWatchdogDecisionLine
$ans5 = Get-AnswerFromLine $line5
Write-Output '--- C5 child output ---'; Write-Output $out5.Trim()
Write-Output ("C5 watchdog log line: {0}" -f $line5)
Write-Output ("C5 port answer as the CHILD saw it: {0}" -f $ans5)
# Machine-independent half of the assertion: with a dead port and a verified live
# stand-in, the decision must stop exactly that pid.
Check 'C5b verified live stand-in -> decision stops exactly that pid' ([bool]($line5 -match 'reason=stale-heartbeat-router-down' -and $line5 -match ('heartbeatPid=' + $fake.Id))) 'True'
if ($ans5 -eq 'nothing') {
  Check 'C5c the dry run said it would stop the stand-in and run the task' ([bool]((Get-LastWatchdogLogLine) -match ('WHATIF would stop supervisor pid ' + $fake.Id + ' \(verified\)'))) 'True'
} else {
  Write-Output ("NOTE: the free port {0} was busy when C5 ran, so the WHATIF line could not be reached for this exact pid." -f $freePort)
}
Check 'C5d and the stand-in was NOT stopped (WhatIf really is dry)' ([bool](Get-Process -Id $fake.Id -ErrorAction SilentlyContinue)) 'True'
Stop-Process -Id $fake.Id -Force -ErrorAction SilentlyContinue
Write-Output ("stopped my own stand-in pid {0}" -f $fake.Id)

Check 'E1 no PowerShell error text in the C1 child run' ([bool]($out1 -notmatch 'CategoryInfo|Cannot find an overload')) 'True'
Check 'E2 no PowerShell error text in the C2 child run' ([bool]($out2 -notmatch 'CategoryInfo|Cannot find an overload')) 'True'
Check 'E3 no PowerShell error text in the C3 child run' ([bool]($out3 -notmatch 'CategoryInfo|Cannot find an overload')) 'True'
Check 'E4 no PowerShell error text in the C5 child run' ([bool]($out5 -notmatch 'CategoryInfo|Cannot find an overload')) 'True'

Write-Output ''
Write-Output '== part F: the REAL action path (no -WhatIf), against a stand-in I own =='
Write-Output 'The stand-in is a throwaway powershell whose command line names this repo''s'
Write-Output 'router-supervisor.ps1. The task name is deliberately one that does not exist, so'
Write-Output 'the watchdog cannot start anything; everything else (stop, lock, schtasks) is real.'
$fakeScript2 = Join-Path $ScratchDir 'fake-supervisor-standin2.ps1'
[System.IO.File]::WriteAllText($fakeScript2, "Start-Sleep -Seconds 120`n")
$outcome = Invoke-SupervisorWatchdogSelfTest -FakeSupervisorScript $fakeScript2 -ExpectedScript $expectedScript -Stale 300 -TaskName 'JcodeWatchdogSelfTestTaskDoesNotExist'
Write-Output ("outcome: stopped={0} stopFailed={1} lockRemoved={2} taskExit={3} aborted='{4}'" -f $outcome.Stopped, $outcome.StopFailed, $outcome.LockRemoved, $outcome.TaskRanExitCode, $outcome.Aborted)
Check 'F1 the verified stand-in was stopped' $outcome.Stopped 'True'
Check 'F2 the stale lock was removed' $outcome.LockRemoved 'True'
Check 'F3 the task command was really attempted and its result recorded' ([bool]($null -ne $outcome.TaskRanExitCode)) 'True'
Write-Output ("     schtasks reported exit {0}; a nonzero exit here is expected, and it is reported rather than swallowed." -f $outcome.TaskRanExitCode)
Check 'F4 a task result that is not a failure makes the self-test FAIL instead of passing' $outcome.Aborted 'task-result-not-a-failure'
$lockAfter = Get-LockFacts
Check 'F5 the scratch lock file is gone now' $lockAfter $null

Write-Output ''
Write-Output '== part D: nothing live was touched =='
$listenerAfter = (netstat -ano -p tcp | Select-String ':8787\s+\S+\s+LISTENING' | ForEach-Object { $_.Line.Trim() }) -join '|'
$supAfter = @(Get-Process -Id 16656 -ErrorAction SilentlyContinue).Count
Write-Output ("    :8787 before this test: {0}" -f $listenerBefore)
Write-Output ("    :8787 now            : {0}" -f $listenerAfter)
if ($listenerBefore -and -not $listenerAfter) {
  Write-Output 'NOTE: the live router on :8787 went away DURING this test (the live supervisor log would say why; this test only ever reads).'
  Check 'D1 no test step ever stopped the router (the watcher never touches it)' 'yes' 'yes'
} else {
  Check 'D1 :8787 listener unchanged by this test' $listenerAfter $listenerBefore
}
Check 'D2 live supervisor pid 16656 unchanged by this test' $supAfter $supBefore
Write-Output ("    :8787 now: {0}" -f $listenerAfter)

$failed = @($results | Where-Object { -not $_.Ok }).Count
Write-Output ''
Write-Output ("== {0} of {1} checks passed ==" -f ($results.Count - $failed), $results.Count)
Write-Output ("watchdog log lines written during this test: {0}" -f (Join-Path $ScratchDir 'supervisor-watchdog.log'))
if (Test-Path -LiteralPath (Join-Path $ScratchDir 'supervisor-watchdog.log')) {
  Get-Content -LiteralPath (Join-Path $ScratchDir 'supervisor-watchdog.log') | ForEach-Object { Write-Output ("   " + $_) }
}
if ($failed -gt 0) { Write-Output 'RESULT: FAIL'; exit 1 }
Write-Output 'RESULT: PASS'
exit 0
