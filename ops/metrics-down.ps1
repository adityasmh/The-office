# ---------------------------------------------------------------------------
# ops/metrics-down.ps1 - stop the Laya metrics stack.
# Spec: docs/METRICS_STACK_SPEC.md section "Run".
#
# Only pids recorded in company/vm-data/pids.json are considered, and only when
# the live process image still matches what was recorded (a recycled pid is
# skipped, never killed). Nothing else on the machine is touched: not the
# router, not Laya, not Kafka, not the supervisor.
# ---------------------------------------------------------------------------
[CmdletBinding()]
param()

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $root "company\vm-data"
$pidFile = Join-Path $dataDir "pids.json"

function Write-Line([string]$text) { Write-Host $text }

if (-not (Test-Path $pidFile)) {
  Write-Line "metrics-down: no pid file (company/vm-data/pids.json) - nothing of ours to stop."
  exit 0
}

$services = $null
try {
  $j = Get-Content $pidFile -Raw | ConvertFrom-Json
  $services = $j.services
} catch {
  Write-Line ("metrics-down: could not read the pid file ({0}); nothing stopped." -f $_.Exception.Message)
  exit 1
}

if (-not $services) {
  Write-Line "metrics-down: the pid file has no services - nothing of ours to stop."
  exit 0
}

$stopped = 0
$skipped = 0
foreach ($name in @("host-exporter", "vmalert", "vmagent", "victoria-metrics")) {
  $entry = $services.$name
  if (-not $entry -or -not $entry.pid) { continue }
  $pid_ = [int]$entry.pid
  $image = [string]$entry.image

  $proc = $null
  try { $proc = Get-Process -Id $pid_ -ErrorAction Stop } catch { $proc = $null }
  if (-not $proc) {
    Write-Line ("{0}: pid {1} is not running" -f $name, $pid_)
    continue
  }
  $path = ""
  try { $path = [string]$proc.Path } catch { $path = "" }
  if ($image -and $path -and ($path -ne $image)) {
    Write-Line ("{0}: pid {1} is a DIFFERENT process ({2}) - left alone" -f $name, $pid_, $path)
    $skipped += 1
    continue
  }

  try {
    Stop-Process -Id $pid_ -Force -ErrorAction Stop
    $stopped += 1
    Write-Line ("{0}: stopped pid {1}" -f $name, $pid_)
  } catch {
    Write-Line ("{0}: could not stop pid {1} ({2})" -f $name, $pid_, $_.Exception.Message)
  }
}

# Retire the pid file: the stack is down, so the next up starts fresh.
try {
  $payload = [pscustomobject]@{ updatedAt = (Get-Date).ToString("o"); stoppedAt = (Get-Date).ToString("o"); services = [pscustomobject]@{} }
  ($payload | ConvertTo-Json -Depth 6) | Set-Content -Path $pidFile -Encoding UTF8
} catch {
  Write-Line ("metrics-down: could not rewrite the pid file ({0})" -f $_.Exception.Message)
}

Write-Line ("metrics-down: stopped {0}, skipped {1}. Data kept in company/vm-data/." -f $stopped, $skipped)
exit 0
