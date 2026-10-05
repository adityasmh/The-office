# ops/install-supervisor-watchdog.ps1 - register the supervisor watchdog task.
#
# WRITTEN AS PART OF THE 2026-10-01 WORK ORDER. It is DELIBERATELY NOT RUN by the
# worker that wrote it: the order says the task may be registered ONLY after the
# dry run passes AND the manager approves. Run it yourself when you approve.
#
# What it does (and nothing else):
#   1. re-runs ops/supervisor-watchdog-check.ps1 and refuses to install if any check fails
#   2. runs ops/supervisor-watchdog.ps1 -WhatIf against the live port and prints the decision
#   3. registers (or updates) the task LayaSupervisorWatchdog:
#        every 1 minute, for the current user, hidden, run at logon
#        conhost.exe --headless powershell.exe -NoProfile -ExecutionPolicy Bypass
#          -WindowStyle Hidden -File "<repo>\ops\supervisor-watchdog.ps1"
#      The headless conhost wrapper is what actually stops the every-minute
#      console flash (plain powershell.exe -WindowStyle Hidden still flashes).
#      The watchdog is single-shot and exits; multiple instances are fine
#      (Parallel), because two watchdogs racing would still only ever stop the one
#      pid the heartbeat names, and the second would fail the single-instance check
#      of the supervisor it started.
#   4. prints the registered task and the watchdog log path
#
# It never stops a process, never deletes anything, and never touches the router.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File ops/install-supervisor-watchdog.ps1            (installs)
#   powershell -NoProfile -ExecutionPolicy Bypass -File ops/install-supervisor-watchdog.ps1 -DryRun    (checks only, registers nothing)
#   powershell -NoProfile -ExecutionPolicy Bypass -File ops/install-supervisor-watchdog.ps1 -Remove    (unregisters the task)

[CmdletBinding()]
param(
  [string]$TaskName = 'LayaSupervisorWatchdog',
  [int]$EveryMinutes = 1,
  [switch]$DryRun,
  [switch]$Remove
)

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot
$watchdog = Join-Path $root 'ops\supervisor-watchdog.ps1'
$check = Join-Path $root 'ops\supervisor-watchdog-check.ps1'
$logDir = Join-Path $root 'logs'
$schtasks = Join-Path $env:SystemRoot 'System32\schtasks.exe'

if (-not (Test-Path -LiteralPath $watchdog)) { Write-Output "missing: $watchdog"; exit 1 }
if (-not (Test-Path -LiteralPath $check)) { Write-Output "missing: $check"; exit 1 }

if ($Remove) {
  Write-Output ("unregistering task {0} ..." -f $TaskName)
  & $schtasks /delete /tn $TaskName /f
  Write-Output ("exit {0}" -f $LASTEXITCODE)
  exit $LASTEXITCODE
}

Write-Output '== step 1: the watchdog decision tests must pass =='
$checkOut = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $check 2>&1
$checkCode = $LASTEXITCODE
$checkOut | ForEach-Object { Write-Output ("  " + $_) }
if ($checkCode -ne 0) {
  Write-Output ("FAILED: tests exited {0} - not installing anything." -f $checkCode)
  exit 1
}
Write-Output 'tests: PASS'

Write-Output ''
Write-Output '== step 2: a dry run against the live port =='
$dry = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $watchdog -WhatIf 2>&1
Write-Output ("  exit {0}" -f $LASTEXITCODE)
$dry | ForEach-Object { Write-Output ("  " + $_) }

if ($DryRun) {
  Write-Output ''
  Write-Output '-DryRun given: nothing was registered.'
  exit 0
}

Write-Output ''
Write-Output '== step 3: register the task =='
# The repo path contains a space, so the -File argument is quoted. The same shape
# of quoting is used by the existing LayaCompanyRouterSupervisor task.
# The inner quotes MUST be backslash-escaped. PowerShell 5.1 passes an argument
# that contains spaces verbatim, WITHOUT escaping embedded double quotes, so a
# plain "{0}" reaches schtasks already split:
#   ... -File "C:\Users\user\Desktop\Default   becomes two arguments ->
#   ERROR: Invalid argument/option - 'Project\ops\supervisor-watchdog.ps1'
# (observed 2026-10-01 17:55 by the install-watchdog worker; schtasks /create
#  exited -2147467259 and registered nothing).
# /it: run as the current interactive user, exactly like the supervisor task
# (which the working recovery on 2026-10-01 used with schtasks /run).
# conhost --headless wraps powershell.exe in a hidden console so the every-minute
# watchdog NEVER flashes a visible window (powershell.exe -WindowStyle Hidden alone
# still briefly opens a console under InteractiveToken).
$tr = ('conhost.exe --headless powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"{0}\"' -f $watchdog)
& $schtasks /create /tn $TaskName /tr $tr /sc minute /mo $EveryMinutes /it /f
$code = $LASTEXITCODE
Write-Output ("schtasks /create exit {0}" -f $code)
if ($code -ne 0) { exit $code }

Write-Output ''
Write-Output '== step 4: verify the registration =='
& $schtasks /query /tn $TaskName /fo list /v
$q = $LASTEXITCODE
Write-Output ("schtasks /query exit {0}" -f $q)
Write-Output ''
Write-Output ("watchdog log : {0}" -f (Join-Path $logDir 'supervisor-watchdog.log'))
Write-Output ("heartbeat    : {0}" -f (Join-Path $logDir 'router-supervisor.heartbeat'))
Write-Output ("pause switch : create {0} to stop the watchdog acting without unregistering it" -f (Join-Path $logDir 'supervisor-watchdog.pause'))
Write-Output ''
Write-Output 'Note: the task runs at logon and every minute, for the current user, hidden.'
Write-Output 'The supervisor it recovers is still started by LayaCompanyRouterSupervisor.'
exit $q
