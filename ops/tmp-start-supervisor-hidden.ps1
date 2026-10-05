# OPS-START recovery, step 3: start the supervisor as a HIDDEN child process and return at once.
#
# WHY: the scheduled task's supervisor instance (pid 7520, started 04:11:23) hung before its first
# log line (0.9 s CPU, 14 minutes, no lock file, no child) - the task mechanism is not usable right
# now. This uses the same primitive ops/router-supervisor.ps1 itself uses for the router child
# (Start-Process -WindowStyle Hidden), which gives the supervisor its own console that lives as long
# as the supervisor does, and then EXITS immediately so nothing depends on this session's shell.
# The supervisor's single-instance lock still prevents a second supervisor/router.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File ops\tmp-start-supervisor-hidden.ps1
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$supervisor = Join-Path $PSScriptRoot 'router-supervisor.ps1'

$already = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -like '*router-supervisor.ps1*' }
if ($already) {
  Write-Host ("NOTE: a supervisor process already exists: pid " + (($already | ForEach-Object { $_.ProcessId }) -join ',') + " (the lock will stop a second one)")
}

$p = Start-Process -FilePath 'powershell.exe' `
  -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $supervisor) `
  -WindowStyle Hidden -PassThru
Write-Host ("supervisor launched hidden: pid " + $p.Id)
Start-Sleep -Seconds 5
Write-Host ("alive after 5s: " + (-not $p.HasExited))
