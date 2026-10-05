# ops/run-server-detached.ps1 - THE way to run the router (CRASHFIX, 2026-09-29).
#
# The router is no longer started directly. It is owned by ops/router-supervisor.ps1,
# which is started by a Windows Scheduled Task, so the router does NOT live inside
# any agent's, tool call's or terminal's process tree and is restarted within
# seconds if something kills it (Stop-Process/taskkill cannot be caught in-process,
# which is why the router used to die silently with an empty logs/router.err.log).
#
#   ops\run-server-detached.ps1              # install the task if needed, run it, wait for /health
#   ops\run-server-detached.ps1 -Status      # health, listener pid, supervisor pid, task state
#   ops\run-server-detached.ps1 -Stop         # stop the scheduled task AND the router
#   ops\run-server-detached.ps1 -Uninstall    # stop everything and remove the task
#   ops\run-server-detached.ps1 -NoTask       # fallback: supervisor detached from THIS shell
#   ops\run-server-detached.ps1 -Port 8791    # supervise another port (own task name/lock)
#
# Startup logs: logs/router.out.log, logs/router.err.log
# Lifecycle :  logs/router.crash.log       (boot / uncaughtException / exit / supervisor restarts)
# Supervisor:  logs/router.supervisor.log
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File ops/run-server-detached.ps1 [-Port 8787] [-Stop] [-Status] [-NoTask] [-Uninstall] [-TimeoutSec 180]

param(
  [int]$Port = 8787,
  [switch]$Stop,
  [switch]$Status,
  [switch]$NoTask,
  [switch]$Uninstall,
  # Rewrite the scheduled task definition even if it already exists (use after
  # changing the task XML in this script, e.g. the supervisor re-arm trigger).
  [switch]$Reinstall,
  [int]$TimeoutSec = 180
)

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$outLog = Join-Path $logDir "router.out.log"
$errLog = Join-Path $logDir "router.err.log"
$crashLog = Join-Path $logDir "router.crash.log"
$supervisor = Join-Path $PSScriptRoot "router-supervisor.ps1"

$taskName = if ($Port -eq 8787) { 'LayaCompanyRouterSupervisor' } else { "LayaCompanyRouterSupervisor-$Port" }
# An instance on another port must never share the live lock/log files.
$extraArgs = if ($Port -ne 8787) { " -Port $Port -LogPrefix router-$Port" } else { '' }

function Get-ListenerPid {
  $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return [int]$c.OwningProcess }
  return 0
}

function Test-Health {
  try {
    $raw = & curl.exe -s -m 5 "http://127.0.0.1:$Port/health" 2>$null
    if (-not $raw) { return $false }
    return [bool](($raw | ConvertFrom-Json).ok)
  } catch { return $false }
}

function Get-TaskState {
  try { return [string](Get-ScheduledTask -TaskName $taskName -ErrorAction Stop).State }
  catch { return $null }
}

function Install-Task {
  # Registered from a task XML through schtasks.exe. Verified on this machine:
  # it works WITHOUT elevation (Register-ScheduledTask returned 0x80070005
  # "Access is denied" for the same task, so the cmdlet is not used).
  #   LogonTrigger        = the company comes back by itself after reboot + login
  #   InteractiveToken    = runs as this user in this session, no stored password
  #   ExecutionTimeLimit 0 = the supervisor is never killed for running "too long"
  #   MultipleInstances IgnoreNew = a second launch can never double-start it
  $user = "$env:USERDOMAIN\$env:USERNAME"
  $xmlPath = Join-Path $env:TEMP "$taskName.xml"
  $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Keeps the Laya AI Company router (127.0.0.1:$Port) alive. Owns the router outside any agent process tree. See ops/router-supervisor.ps1 and docs/CEO_RUNBOOK.md.</Description>
    <URI>\$taskName</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$user</UserId>
    </LogonTrigger>
    <!-- Re-arm belt: if the supervisor itself is ever killed, the scheduler brings
         it back within 2 minutes. MultipleInstancesPolicy=IgnoreNew means this can
         never start a second supervisor while one is alive. -->
    <TimeTrigger>
      <StartBoundary>$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')</StartBoundary>
      <Enabled>true</Enabled>
      <Repetition>
        <Interval>PT2M</Interval>
        <Duration>P365D</Duration>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$user</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$supervisor"$extraArgs</Arguments>
    </Exec>
  </Actions>
</Task>
"@
  Set-Content -LiteralPath $xmlPath -Value $xml -Encoding Unicode
  $create = & schtasks /create /tn $taskName /xml $xmlPath /f 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Host "could not create scheduled task '$taskName':" -ForegroundColor Red
    $create | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    return $false
  }
  Write-Host "scheduled task '$taskName' created (runs at logon; started by this script now)." -ForegroundColor Green
  return $true
}

if ($Status) {
  Write-Host ""
  Write-Host "  LAYA AI COMPANY - router supervisor status" -NoNewline -ForegroundColor Black -BackgroundColor Yellow
  Write-Host ""
  Write-Host ("  scheduled task : {0} -> {1}" -f $taskName, $(if (Get-TaskState) { Get-TaskState } else { '(not installed)' }))
  Write-Host ("  health ok      : {0}" -f (Test-Health))
  $listener = Get-ListenerPid
  Write-Host ("  listener pid   : {0}" -f $(if ($listener) { $listener } else { '(none)' }))
  $sup = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*router-supervisor.ps1*" -and ($_.CommandLine -like "*$Port*" -or $Port -eq 8787) }
  Write-Host ("  supervisor pid : {0}" -f $(if ($sup) { ($sup | ForEach-Object { $_.ProcessId }) -join ',' } else { '(not running)' }))
  Write-Host ("  logs           : {0}" -f $crashLog)
  Write-Host ("  supervisor log : {0}" -f (Join-Path $logDir 'router.supervisor.log'))
  Write-Host ""
  exit 0
}

if ($Stop -or $Uninstall) {
  $state = Get-TaskState
  if ($state) {
    schtasks /end /tn $taskName 2>&1 | Out-Null
    Write-Host "scheduled task '$taskName' ended (was: $state)" -ForegroundColor Yellow
  }
  # Stop the supervisor (if it is running outside the task, e.g. -NoTask) and the router.
  # Arguments are passed as a list, never as one concatenated token: "-LogPrefix router-8899"
  # as a single string made powershell -File reject it with "A parameter cannot be found that
  # matches parameter name 'LogPrefix router-8899'" (found by running this path for real).
  $supStop = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $supervisor, '-Port', "$Port")
  if ($Port -ne 8787) { $supStop += @('-LogPrefix', "router-$Port") }
  $supStop += '-Stop'
  & powershell @supStop
  if ($Uninstall) {
    if ($state) {
      schtasks /delete /tn $taskName /f 2>&1 | Out-Null
      Write-Host "scheduled task '$taskName' deleted - the router will NOT come back by itself." -ForegroundColor Yellow
    } else {
      Write-Host "no scheduled task '$taskName' to delete." -ForegroundColor DarkGray
    }
  }
  $listener = Get-ListenerPid
  Write-Host ("  port :$Port listener now: {0}" -f $(if ($listener) { "pid $listener STILL UP" } else { '(none)' })) -ForegroundColor Gray
  exit 0
}

# ---- start (idempotent) ----------------------------------------------------
# The task/ supervisor is ensured FIRST, even when the router already answers:
# a healthy router that nobody supervises is exactly how today's silent deaths
# went unnoticed.
$state = Get-TaskState
if (-not $NoTask -and ((-not $state) -or $Reinstall)) {
  if (-not (Install-Task)) {
    Write-Host "falling back to a detached supervisor (no scheduled task)." -ForegroundColor Yellow
    $NoTask = $true
  }
  $state = Get-TaskState
}

if (Test-Health) {
  $listener = Get-ListenerPid
  if ($NoTask) {
    Write-Host "router already healthy on :$Port (pid $listener); supervisor detached from this shell to watch it." -ForegroundColor DarkGray
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$supervisor`"")
    if ($Port -ne 8787) { $argList += @('-Port', "$Port", '-LogPrefix', "router-$Port") }
    Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -WindowStyle Hidden | Out-Null
  } else {
    schtasks /run /tn $taskName 2>&1 | Out-Null
    Write-Host "router already healthy on :$Port (pid $listener); task '$taskName' is now watching it." -ForegroundColor DarkGray
  }
  exit 0
}

if ($NoTask) {
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$supervisor`"")
  if ($Port -ne 8787) { $argList += @('-Port', "$Port", '-LogPrefix', "router-$Port") }
  Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -WindowStyle Hidden | Out-Null
  Write-Host "supervisor started detached from this shell (no scheduled task)." -ForegroundColor Green
} else {
  # The Task Scheduler starts the supervisor in its own tree (parent = the Task
  # Scheduler service), so nothing an agent or a terminal does to its own process
  # tree can reach the router.
  schtasks /run /tn $taskName 2>&1 | Out-Null
  Start-Sleep -Seconds 2
  if (-not (Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -like "*router-supervisor.ps1*" })) {
    Write-Host "the scheduled task did not start a supervisor; starting one detached instead." -ForegroundColor Yellow
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$supervisor`"")
    if ($Port -ne 8787) { $argList += @('-Port', "$Port", '-LogPrefix', "router-$Port") }
    Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -WindowStyle Hidden | Out-Null
  } else {
    Write-Host "scheduled task '$taskName' started (supervisor owns the router from here)." -ForegroundColor Green
  }
}

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$started = Get-Date
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 3
  if (Test-Health) {
    $listener = Get-ListenerPid
    $secs = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
    Write-Host "router is UP on http://localhost:$Port after ${secs}s (pid $listener, supervised, logs in logs/)" -ForegroundColor Green
    exit 0
  }
}
Write-Host "router did not come up within ${TimeoutSec}s - check logs/router.err.log and logs/router.supervisor.log" -ForegroundColor Red
exit 1
