# OPS-START recovery, step 2: start ops/router-supervisor.ps1 DETACHED from this session.
#
# WHY: ops/tmp-router-up-now.ps1 launched the router child itself and it worked - the boot reached
# `router on 127.0.0.1:8787` (22:43:51Z) - but the child then died on a console Ctrl+C as soon as
# the one-shot launcher exited (a WMI-created console is destroyed with its launcher, and the log
# shows the literal ^C in logs/router.err.log). The supervisor is designed to hold that console open
# for the lifetime of the router, so the right recovery is to keep a SUPERVISOR alive, not a router.
#
# This creates cmd.exe -> powershell -File ops/router-supervisor.ps1 via Win32_Process.Create, so the
# cmd parent (which waits on the supervisor) stays attached to the console for as long as the
# supervisor runs, and the supervisor starts the router exactly as it always does (Start-Process
# cmd.exe -WindowStyle Hidden). The supervisor's own single-instance lock still applies: if the
# scheduled task's supervisor comes back, it exits rather than starting a second router.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File ops\tmp-supervisor-up-now.ps1
param([int]$Port = 8787, [int]$WaitSec = 300)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$supervisor = Join-Path $PSScriptRoot 'router-supervisor.ps1'
$health = "http://127.0.0.1:$Port/health"

function Test-Health {
  $raw = & curl.exe -s -m 5 $health 2>$null
  if (-not $raw) { return $false }
  try { return [bool](($raw | ConvertFrom-Json).ok) } catch { return $false }
}

# Is a supervisor already alive (lock owner or a live router-supervisor.ps1 process)?
$already = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -like '*router-supervisor.ps1*' }
if ($already) {
  Write-Host ("a supervisor is already running: pid " + (($already | ForEach-Object { $_.ProcessId }) -join ','))
} else {
  $cmdline = "cmd.exe /c powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$supervisor`" -Port $Port"
  Write-Host "launching detached: $cmdline"
  $res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdline }
  Write-Host ("Win32_Process.Create -> ReturnValue=" + $res.ReturnValue + " pid=" + $res.ProcessId)
}

$deadline = (Get-Date).AddSeconds($WaitSec)
while ((Get-Date) -lt $deadline) {
  if (Test-Health) {
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    Write-Host ("router is UP on :$Port (pid " + [int]$c.OwningProcess + ")")
    Write-Host ("supervisor log tail:")
    Get-Content (Join-Path $root 'logs\router.supervisor.log') -Tail 4 | ForEach-Object { Write-Host ("  " + $_) }
    exit 0
  }
  Start-Sleep -Seconds 3
}
Write-Host "router still NOT answering after ${WaitSec}s"
Get-Content (Join-Path $root 'logs\router.supervisor.log') -Tail 6 | ForEach-Object { Write-Host ("  " + $_) }
exit 1
