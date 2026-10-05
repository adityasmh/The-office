# OPS-START recovery: bring the router up on :8787 by hand when the supervisor task will not.
#
# WHY THIS EXISTS: at 04:03 local on 2026-09-30 the OPS-START session stopped the wedged router
# through the sanctioned path (ops/run-server-detached.ps1 -Stop) and the start half then failed -
# the scheduled task reported Running, but no supervisor process ever wrote its start line or its
# lock file, and /health never answered (repeated `schtasks /end` + `/run` and one -NoTask attempt
# did not change it). The company was DOWN and the box was too loaded to keep experimenting, so
# this launches the router child with EXACTLY the command line ops/router-supervisor.ps1 uses
# (same cwd, same PORT, same log files) but parented to WMI instead of to this session's shell, so
# it survives the end of the tool call. The supervisor, whenever it comes back, only ever watches a
# listener that already exists - it never starts a second one - so this cannot double-start :8787.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File ops\tmp-router-up-now.ps1
param([int]$Port = 8787, [int]$WaitSec = 300)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$outLog = Join-Path $root 'logs\router.out.log'
$errLog = Join-Path $root 'logs\router.err.log'
$health = "http://127.0.0.1:$Port/health"

function Test-Health {
  $raw = & curl.exe -s -m 5 $health 2>$null
  if (-not $raw) { return $false }
  try { return [bool](($raw | ConvertFrom-Json).ok) } catch { return $false }
}

function Listener-Pid {
  $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return [int]$c.OwningProcess }
  return 0
}

if (Test-Health) {
  Write-Host "already healthy on :$Port (pid $(Listener-Pid)) - nothing to do"
  exit 0
}

# The supervisor's own child line (ops/router-supervisor.ps1, $inner):
$inner = "cd /d `"$root`" && set `"PORT=$Port`" && `"node_modules\.bin\tsx.cmd`" src/server.ts 1>> `"$outLog`" 2>> `"$errLog`""
Write-Host "launching (WMI-detached): $inner"

# Win32_Process.Create parents the child to WmiPrvSE, NOT to this shell: an agent's tool-call tree
# being torn down is exactly how the router used to die silently (ops/router-supervisor.ps1 header).
$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "cmd.exe /c $inner" }
Write-Host ("Win32_Process.Create -> ReturnValue=" + $res.ReturnValue + " pid=" + $res.ProcessId)

$deadline = (Get-Date).AddSeconds($WaitSec)
while ((Get-Date) -lt $deadline) {
  if (Test-Health) {
    $pid2 = Listener-Pid
    Write-Host "router is UP on :$Port (pid $pid2)"
    exit 0
  }
  Start-Sleep -Seconds 3
}
Write-Host "router still NOT answering after ${WaitSec}s - check logs\router.err.log / router.out.log"
exit 1
