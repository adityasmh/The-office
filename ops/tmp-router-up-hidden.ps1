# OPS-START recovery, step 4: start the router the way the supervisor does, with correct quoting.
#
# WHY: ops/tmp-router-up-now.ps1 (Win32_Process.Create) DID boot - `router on 127.0.0.1:8787` at
# 22:43:51Z - and then the process died on a console Ctrl+C right after binding (the literal ^C is in
# logs/router.err.log). A second attempt with Start-Process died from MY OWN quoting bug: PowerShell
# does not treat \" as an escape, so the literal backslash-quotes reached cmd.exe, `cd /d \"...\"`
# failed, and the && chain aborted before tsx ever ran.
#
# This uses the supervisor's own child line (same cwd, same PORT, same log files) through
# Start-Process -WindowStyle Hidden -PassThru, which is the primitive that has kept the router alive
# for hours all night. The launcher stays alive while it waits for /health, then exits; the hidden
# console belongs to the cmd child, so the router does not lose it.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File ops\tmp-router-up-hidden.ps1
param([int]$Port = 8787, [int]$WaitSec = 240)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$outLog = Join-Path $root 'logs\router.out.log'
$errLog = Join-Path $root 'logs\router.err.log'

function Test-Health {
  $raw = & curl.exe -s -m 5 "http://127.0.0.1:$Port/health" 2>$null
  if (-not $raw) { return $false }
  try { return [bool](($raw | ConvertFrom-Json).ok) } catch { return $false }
}

if (Test-Health) { Write-Host "already healthy on :$Port"; exit 0 }

$inner = "cd /d `"$root`" && set `"PORT=$Port`" && `"node_modules\.bin\tsx.cmd`" src/server.ts 1>> `"$outLog`" 2>> `"$errLog`""
Write-Host "inner: $inner"
$child = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $inner -WindowStyle Hidden -PassThru
Write-Host ("router cmd pid=" + $child.Id)

$deadline = (Get-Date).AddSeconds($WaitSec)
while ((Get-Date) -lt $deadline) {
  if (Test-Health) {
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    Write-Host ("router is UP on :$Port (pid " + [int]$c.OwningProcess + ")")
    exit 0
  }
  if ($child.HasExited) { Write-Host ("router cmd exited early (code " + $child.ExitCode + ") - see logs"); break }
  Start-Sleep -Seconds 3
}
Write-Host "not healthy yet; launcher exit; last log lines:"
Get-Content $outLog -Tail 4 | ForEach-Object { Write-Host ("  " + $_) }
Get-Content $errLog -Tail 4 | ForEach-Object { Write-Host ("  " + $_) }
exit 1
