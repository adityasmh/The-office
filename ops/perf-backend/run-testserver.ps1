# PERF-BACKEND isolated test server (2026-09-29).
#
# Starts (or stops) a router on a scratch PORT against a TEMP COMPANY_ROOT copy.
# It never touches the live :8787 instance and never uses the live company/ folder:
#
#   * PORT defaults to 8801 (free; not one of the ports the live router has used)
#   * SLACK_BRIDGE=0 and SLACK_SOCKET_MODE=0, so no second Slack bridge can exist
#   * COMPANY_ROOT must be under $env:TEMP and contain "jcode-perfbe" (hard guard
#     below), so a typo can never point the test server at the live company/
#   * MOCK_MODE=1, so background loops cannot spend gateway budget
#
# Usage:
#   powershell -NoProfile -File ops\perf-backend\run-testserver.ps1 -Start -CpuProf
#   powershell -NoProfile -File ops\perf-backend\run-testserver.ps1 -Stop
param(
  [switch]$Start,
  [switch]$Stop,
  [switch]$CpuProf,
  [string]$Port = "8801",
  [string]$CpuProfDir = "logs/cpuprof-be"
)

$root = (Get-Location).Path
$pidFile = Join-Path $root "logs/perf-backend-testserver.pid"
$logFile = Join-Path $root "logs/perf-backend-testserver.out.log"
$errFile = Join-Path $root "logs/perf-backend-testserver.err.log"
$companyRoot = Join-Path $env:TEMP "jcode-perfbe\company"

if ($Stop) {
  if (-not (Test-Path $pidFile)) { Write-Host "no pid file; nothing to stop"; exit 0 }
  $raw = Get-Content $pidFile -Raw
  $m = [regex]::Match($raw, '"pid"\s*:\s*(\d+)')
  if (-not $m.Success) { Write-Host "no pid in $pidFile; nothing to stop"; exit 0 }
  $p = [int]$m.Groups[1].Value
  try {
    $proc = Get-Process -Id $p -ErrorAction Stop
    if ($proc.ProcessName -eq "node") {
      Stop-Process -Id $p -Force
      Write-Host "stopped node pid $p"
    } else {
      Write-Host ("refusing to stop pid {0}: process name is {1}, not node" -f $p, $proc.ProcessName)
    }
  } catch { Write-Host "pid $p is already gone" }
  Remove-Item -Force $pidFile -ErrorAction SilentlyContinue
  exit 0
}

if (-not $Start) { Write-Host "pass -Start or -Stop"; exit 2 }

if (-not (Test-Path (Join-Path $companyRoot "org.json"))) {
  throw "test COMPANY_ROOT not built: run ops/perf-backend/make-testroot.ps1 first ($companyRoot)"
}
if ($companyRoot -notlike "*jcode-perfbe*" -or $companyRoot -eq (Join-Path $root "company")) {
  throw "refusing: COMPANY_ROOT must be the temp copy, got $companyRoot"
}
if (Test-Path $pidFile) {
  $old = Get-Content $pidFile -Raw | ConvertFrom-Json
  if (Get-Process -Id $old.pid -ErrorAction SilentlyContinue) { throw "a test server is already running (pid $($old.pid)); stop it first" }
}

New-Item -ItemType Directory -Force -Path (Join-Path $root "logs") | Out-Null
if ($CpuProf) { New-Item -ItemType Directory -Force -Path (Join-Path $root $CpuProfDir) | Out-Null }

$env:PORT = $Port
$env:HOST = "127.0.0.1"
$env:SLACK_BRIDGE = "0"
$env:SLACK_SOCKET_MODE = "0"
$env:COMPANY_ROOT = $companyRoot
$env:MOCK_MODE = "1"
$env:COMPANY_AUTH_TOKEN = "perf-backend-test-token"
# Keep the memory auto-rebuild loop out of the measurement unless asked for.
if (-not $env:MEMORY_AUTOREBUILD) { $env:MEMORY_AUTOREBUILD = "1" }

$nodeArgs = @()
if ($CpuProf) { $nodeArgs += @("--cpu-prof", "--cpu-prof-dir=$CpuProfDir", "--cpu-prof-name=before-after.cpuprofile") }
$nodeArgs += @("--import", "tsx", "src/server.ts")

$p = Start-Process -FilePath "node" -ArgumentList $nodeArgs -PassThru -NoNewWindow `
  -RedirectStandardOutput $logFile -RedirectStandardError $errFile

$cpuFlag = if ($CpuProf) { "true" } else { "false" }
"{ `"pid`": $($p.Id), `"port`": `"$Port`", `"companyRoot`": `"$($companyRoot -replace '\\','\\')`", `"cpuProf`": $cpuFlag, `"startedAt`": `"$(Get-Date -Format o)`" }" |
  Set-Content -Path $pidFile -Encoding utf8
Write-Host "started node pid $($p.Id) on port $Port (log: $logFile)"
