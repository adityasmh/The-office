# ---------------------------------------------------------------------------
# ops/metrics-up.ps1 - start the Laya metrics stack (detached, loopback only).
# Spec: docs/METRICS_STACK_SPEC.md section "Run".
#
#   victoria-metrics  http://127.0.0.1:8428   data in company/vm-data/
#   vmagent           http://127.0.0.1:8429   scrapes tools/vm/scrape.yml every 5 s
#   vmalert           http://127.0.0.1:8880   rules in tools/vm/alerts.yml
#   host exporter     http://127.0.0.1:9101   node ops/host-exporter.mjs
#
# Guarantees:
#   * RAM guard: nothing starts unless free physical RAM >= $MinFreeMb (1.5 GB).
#     Below that it reports and exits 0 (a full box is a reason not to add work).
#   * idempotent: only what is not already running is started.
#   * it never touches a process it does not own: the pid file
#     (company/vm-data/pids.json) is the only source of pids, and every pid is
#     re-checked against the executable it was started from.
#   * no admin, no service, no PATH/registry change, no Docker.
#
# Test hook (used by ops/metrics-check.ts, never in normal use):
#   METRICS_RAM_GUARD_STUB_MB = <number> forces the free-RAM reading, so the
#   guard's "too little RAM" path can be exercised without filling the box.
# ---------------------------------------------------------------------------
[CmdletBinding()]
param(
  [int]$MinFreeMb = 1536,
  [int]$RouterPort = 8787,
  [int]$WaitSeconds = 6
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$vmDir = Join-Path $root "tools\vm"
$dataDir = Join-Path $root "company\vm-data"
$logDir = Join-Path $root "logs"
$pidFile = Join-Path $dataDir "pids.json"

$vmExe = Join-Path $vmDir "victoria-metrics.exe"
$vmagentExe = Join-Path $vmDir "vmagent.exe"
$vmalertExe = Join-Path $vmDir "vmalert.exe"
$scrapeFile = Join-Path $vmDir "scrape.yml"
$alertsFile = Join-Path $vmDir "alerts.yml"
$runtimeAlerts = Join-Path $dataDir "alerts.runtime.yml"

function Write-Line([string]$text) { Write-Host $text }

function Get-FreeRamMb {
  if ($env:METRICS_RAM_GUARD_STUB_MB) {
    $stub = 0
    if ([int]::TryParse($env:METRICS_RAM_GUARD_STUB_MB, [ref]$stub)) {
      Write-Line ("RAM guard: STUBBED free RAM = {0} MB (METRICS_RAM_GUARD_STUB_MB)" -f $stub)
      return $stub
    }
  }
  try {
    $os = Get-CimInstance Win32_OperatingSystem
    return [int]($os.FreePhysicalMemory / 1024)
  } catch {
    Write-Line ("RAM guard: could not read free memory ({0}); refusing to start" -f $_.Exception.Message)
    return -1
  }
}

function Read-Pids {
  if (Test-Path $pidFile) {
    try {
      $j = Get-Content $pidFile -Raw | ConvertFrom-Json
      if ($j -and $j.services) { return $j.services }
    } catch { }
  }
  return [pscustomobject]@{}
}

function Write-Pids($services) {
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  $payload = [pscustomobject]@{ updatedAt = (Get-Date).ToString("o"); services = $services }
  # .NET WriteAllText writes UTF-8 WITHOUT a BOM; Set-Content -Encoding UTF8 would
  # add one, which breaks a plain JSON.parse (the ops/metrics-check.ts reader).
  [System.IO.File]::WriteAllText($pidFile, ($payload | ConvertTo-Json -Depth 6))
}

# A recorded pid only counts as "ours and running" when it is alive AND its image
# is the executable we recorded, so a recycled pid is never mistaken for ours.
function Get-Ours([int]$pid_, [string]$image) {
  if (-not $pid_ -or $pid_ -le 0) { return $null }
  try {
    $p = Get-Process -Id $pid_ -ErrorAction Stop
  } catch { return $null }
  try {
    $path = [string]$p.Path
    if ($image -and $path -and ($path -ne $image)) { return $null }
  } catch { }
  return $p
}

function Start-Ours {
  param(
    [string]$Name,
    [string]$File,
    [string[]]$Arguments,
    [string]$Image
  )
  $out = Join-Path $logDir ("metrics-{0}.out.log" -f $Name)
  $err = Join-Path $logDir ("metrics-{0}.err.log" -f $Name)
  # PowerShell 5.1 hands -ArgumentList to CreateProcess verbatim, so any argument
  # containing a space (this repo lives under "Default Project") must be quoted
  # here or the child sees two arguments instead of one.
  $quoted = ($Arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
  $p = Start-Process -FilePath $File -ArgumentList $quoted -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $out -RedirectStandardError $err
  Start-Sleep -Milliseconds 400
  return $p
}

function Get-RssMb([int]$pid_) {
  try {
    $p = Get-Process -Id $pid_ -ErrorAction Stop
    return [int]($p.WorkingSet64 / 1MB)
  } catch { return -1 }
}

# ── pre-flight ─────────────────────────────────────────────────────────────
foreach ($f in @($vmExe, $vmagentExe, $vmalertExe)) {
  if (-not (Test-Path $f)) {
    Write-Line ("metrics-up: missing {0} - run the download/verify step first (docs/perf/METRICS_SETUP.md)" -f $f)
    exit 1
  }
}

New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $dataDir "vmstorage") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $dataDir "vmagent-tmp") | Out-Null

# ── RAM guard ──────────────────────────────────────────────────────────────
$freeMb = Get-FreeRamMb
if ($freeMb -lt 0) { exit 0 }
Write-Line ("Free RAM: {0} MB (guard needs {1} MB, whole stack is expected to use ~150-250 MB)" -f $freeMb, $MinFreeMb)
if ($freeMb -lt $MinFreeMb) {
  Write-Line ("metrics-up: NOT starting - free RAM {0} MB is below the {1} MB guard. Nothing was started, nothing was stopped." -f $freeMb, $MinFreeMb)
  exit 0
}

# ── the spend cap, substituted into a runtime copy of the rules ────────────
$services = Read-Pids
$cap = $env:SPEND_CAP_USD_PER_HOUR
if (-not $cap) { $cap = "2" }
try {
  $rules = Get-Content $alertsFile -Raw
  $rules = [regex]::Replace($rules, "increase\(laya_router_spend_usd_total\[1h\]\) > [0-9.]+", ("increase(laya_router_spend_usd_total[1h]) > " + $cap))
  [System.IO.File]::WriteAllText($runtimeAlerts, $rules)
  Write-Line ("Spend cap: {0} USD/hour (SPEND_CAP_USD_PER_HOUR) -> {1}" -f $cap, $runtimeAlerts)
} catch {
  Write-Line ("metrics-up: could not build the runtime rules file: {0}" -f $_.Exception.Message)
  exit 1
}

# ── the vmalert notifier token (never printed) ─────────────────────────────
$token = $env:COMPANY_AUTH_TOKEN
if (-not $token) { $token = "" }
if (-not $token) {
  try {
    $boot = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/company/auth/bootstrap" -f $RouterPort) -TimeoutSec 5
    if ($boot -and $boot.token) { $token = [string]$boot.token }
  } catch {
    Write-Line ("metrics-up: WARNING - could not read the company token from the router bootstrap; the alert webhook will be refused (401) until it is set")
  }
}

# ── start what is not running ──────────────────────────────────────────────
$started = @()
$status = @()

# victoria-metrics single node (insert + storage + select)
$existing = Get-Ours -pid_ ([int]($services.'victoria-metrics'.pid)) -image $vmExe
if ($existing) {
  Write-Line ("victoria-metrics: already running (pid {0})" -f $existing.Id)
} else {
  $p = Start-Ours -Name "victoria-metrics" -File $vmExe -Image $vmExe -Arguments @(
    "-httpListenAddr=127.0.0.1:8428",
    ("-storageDataPath=" + (Join-Path $dataDir "vmstorage")),
    "-retentionPeriod=14d",
    "-memory.allowedPercent=10"
  )
  $services | Add-Member -NotePropertyName "victoria-metrics" -NotePropertyValue ([pscustomobject]@{ pid = $p.Id; image = $vmExe; startedAt = (Get-Date).ToString("o") }) -Force
  Write-Line ("victoria-metrics: started pid {0}" -f $p.Id)
}
Write-Pids $services
Start-Sleep -Seconds 2

# vmagent (the scraper)
$existing = Get-Ours -pid_ ([int]($services.'vmagent'.pid)) -image $vmagentExe
if ($existing) {
  Write-Line ("vmagent: already running (pid {0})" -f $existing.Id)
} else {
  $p = Start-Ours -Name "vmagent" -File $vmagentExe -Image $vmagentExe -Arguments @(
    ("-promscrape.config=" + $scrapeFile),
    # v1.153 requires the FULL path here (its own help says
    # "Example url: http://<victoriametrics-host>:8428/api/v1/write"). A bare
    # host:port makes vmagent POST to "/" and every block is rejected with
    # "unsupported path requested".
    "-remoteWrite.url=http://127.0.0.1:8428/api/v1/write",
    "-httpListenAddr=127.0.0.1:8429",
    ("-remoteWrite.tmpDataPath=" + (Join-Path $dataDir "vmagent-tmp")),
    "-remoteWrite.maxDiskUsagePerURL=256MB",
    "-memory.allowedPercent=10"
  )
  $services | Add-Member -NotePropertyName "vmagent" -NotePropertyValue ([pscustomobject]@{ pid = $p.Id; image = $vmagentExe; startedAt = (Get-Date).ToString("o") }) -Force
  Write-Line ("vmagent: started pid {0}" -f $p.Id)
}
Write-Pids $services
Start-Sleep -Seconds 2

# vmalert (rules -> webhook)
$existing = Get-Ours -pid_ ([int]($services.'vmalert'.pid)) -image $vmalertExe
if ($existing) {
  Write-Line ("vmalert: already running (pid {0})" -f $existing.Id)
} else {
  $vmalertArgs = @(
    ("-rule=" + $runtimeAlerts),
    "-datasource.url=http://127.0.0.1:8428",
    # vmalert writes the ALERTS series (and recorded rules) here, so the dashboard
    # can show what is firing. Same "full path" rule as vmagent's remote write.
    "-remoteWrite.url=http://127.0.0.1:8428/api/v1/write",
    ("-notifier.url=http://127.0.0.1:{0}/company/alerts/webhook" -f $RouterPort),
    "-httpListenAddr=127.0.0.1:8880",
    "-evaluationInterval=15s",
    "-datasource.queryStep=15s"
  )
  if ($token) { $vmalertArgs += ("-notifier.headers=X-Company-Token:" + $token) }
  $p = Start-Ours -Name "vmalert" -File $vmalertExe -Image $vmalertExe -Arguments $vmalertArgs
  $services | Add-Member -NotePropertyName "vmalert" -NotePropertyValue ([pscustomobject]@{ pid = $p.Id; image = $vmalertExe; startedAt = (Get-Date).ToString("o") }) -Force
  Write-Line ("vmalert: started pid {0}" -f $p.Id)
}
Write-Pids $services
Start-Sleep -Seconds 1

# host exporter (node). The pid file stores node.exe as the image because that is
# what is really started; the script path is in the arguments.
$nodeExe = (Get-Command node.exe).Source
$exporterScript = Join-Path $root "ops\host-exporter.mjs"
$existing = Get-Ours -pid_ ([int]($services.'host-exporter'.pid)) -image $nodeExe
if ($existing) {
  Write-Line ("host-exporter: already running (pid {0})" -f $existing.Id)
} else {
  $p = Start-Ours -Name "host-exporter" -File $nodeExe -Image $nodeExe -Arguments @($exporterScript)
  $services | Add-Member -NotePropertyName "host-exporter" -NotePropertyValue ([pscustomobject]@{ pid = $p.Id; image = $nodeExe; startedAt = (Get-Date).ToString("o") }) -Force
  Write-Line ("host-exporter: started pid {0}" -f $p.Id)
}
Write-Pids $services

# ── report (measured RSS, not an estimate) ─────────────────────────────────
Start-Sleep -Seconds $WaitSeconds
Write-Line ""
Write-Line "service            pid     rss(MB)  url"
Write-Line "-----------------  ------  -------  -------------------------------"
foreach ($name in @("victoria-metrics", "vmagent", "vmalert", "host-exporter")) {
  $entry = $services.$name
  if (-not $entry -or -not $entry.pid) { continue }
  $pid_ = [int]$entry.pid
  $alive = Get-Ours -pid_ $pid_ -image ([string]$entry.image)
  $rss = if ($alive) { Get-RssMb $pid_ } else { -1 }
  $url = switch ($name) {
    "victoria-metrics" { "http://127.0.0.1:8428/vmui" }
    "vmagent" { "http://127.0.0.1:8429/targets" }
    "vmalert" { "http://127.0.0.1:8880/vmalert/alerts" }
    default { "http://127.0.0.1:9101/metrics" }
  }
  $state = if ($alive) { "up" } else { "DOWN" }
  Write-Line ("{0,-17}  {1,-6}  {2,-7}  {3} ({4})" -f $name, $pid_, $rss, $url, $state)
}
Write-Line ""
Write-Line ("dashboard: http://127.0.0.1:{0}/metrics.html   VictoriaMetrics UI: http://127.0.0.1:8428/vmui" -f $RouterPort)
Write-Line "metrics-up: done."
exit 0
