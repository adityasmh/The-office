# ops/start-company.ps1 - one-command local launch for the Laya AI Company.
#
# Brings up the whole control plane on this PC:
#   1. Laya decision server   http://127.0.0.1:8000   (scripts/serve-laya.ps1, own window)
#   2. Router + dashboard     http://localhost:8787   (npm run dev, own window)
#   3. Mission control        ops/watch-company.ps1   (own window, read-only)
#   4. Waits (max 60s) until BOTH health checks answer, prints the URLs in green.
#   5. Opens http://localhost:8787 in the default browser unless -NoBrowser.
#
# Idempotent by design: it only starts what is NOT already healthy, and it NEVER
# kills or restarts anything. If a service already answers /health it is reused.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File ops\start-company.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File ops\start-company.ps1 -Quiet -NoBrowser
#
# Switches:
#   -Quiet      suppress progress chatter (the final summary is always printed)
#   -NoBrowser  do not open the dashboard in the default browser
#   -NoWatch    do not open the mission-control watcher window
#   -TimeoutSec seconds to wait for both health checks (default 60)
#   -Root       project root (defaults to the parent of this script's folder)

[CmdletBinding()]
param(
  [switch]$Quiet,
  [switch]$NoBrowser,
  [switch]$NoWatch,
  [int]$TimeoutSec = 60,
  [string]$Root
)

$ErrorActionPreference = 'Stop'

if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
if (-not (Test-Path -LiteralPath $Root)) { throw "project root not found: $Root" }
$Root = (Resolve-Path -LiteralPath $Root).Path

$LayaHealthUrl   = 'http://127.0.0.1:8000/health'
$RouterHealthUrl = 'http://localhost:8787/health'
$DashboardUrl    = 'http://localhost:8787'

$PS = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $PS)) { $PS = 'powershell.exe' }

$ServeLaya  = Join-Path $Root 'scripts\serve-laya.ps1'
$WatchPs1   = Join-Path $Root 'ops\watch-company.ps1'

function Say([string]$msg, [string]$color = 'Gray') {
  if (-not $Quiet) { Write-Host $msg -ForegroundColor $color }
}

function Test-Health([string]$url) {
  try {
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
    return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300)
  } catch {
    return $false
  }
}

# Opens a real, separate terminal window running $CommandLine inside the project root.
function Start-CompanyWindow([string]$Title, [string]$CommandLine) {
  $inner = "`$Host.UI.RawUI.WindowTitle='$Title'; $CommandLine"
  $argString = "-NoProfile -ExecutionPolicy Bypass -NoExit -Command `"$inner`""
  Start-Process -FilePath $PS -ArgumentList $argString -WorkingDirectory $Root | Out-Null
}

function Get-WatcherProcess {
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='cmd.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*watch-company.ps1*' -and $_.ProcessId -ne $PID } |
    Select-Object -First 1
}

# ---------------------------------------------------------------------------
Say ''
Say ("  LAYA AI COMPANY - launcher   root: {0}" -f $Root) 'Cyan'
Say '  (idempotent: healthy services are reused, nothing is ever killed)' 'DarkGray'
Say ''

$layaStarted = $false
$routerStarted = $false

# --- 1. Laya ---------------------------------------------------------------
$layaWasUp = Test-Health $LayaHealthUrl
if ($layaWasUp) {
  Say ("  [1/4] Laya        127.0.0.1:8000   already healthy - reusing") 'Green'
} else {
  if (-not (Test-Path -LiteralPath $ServeLaya)) { throw "missing $ServeLaya" }
  Say ("  [1/4] Laya        127.0.0.1:8000   not answering - starting scripts\serve-laya.ps1 in a new window") 'Yellow'
  Start-CompanyWindow 'Laya decision server (8000)' "& '$ServeLaya'"
  $layaStarted = $true
}

# --- 2. Router / dashboard -------------------------------------------------
$routerWasUp = Test-Health $RouterHealthUrl
if ($routerWasUp) {
  Say ("  [2/4] Router      127.0.0.1:8787   already healthy - reusing") 'Green'
} else {
  # The router is supervised since 2026-09-29 (CRASHFIX): it is started through the
  # scheduled-task supervisor, not as a foreground `npm run dev` in a window that
  # takes the router down with it when it is closed. The launcher is idempotent and
  # waits for /health itself, so no window is needed.
  Say ("  [2/4] Router      127.0.0.1:8787   not answering - starting the supervised router") 'Yellow'
  $launcher = Join-Path $PSScriptRoot 'run-server-detached.ps1'
  if (Test-Path -LiteralPath $launcher) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $launcher -TimeoutSec $TimeoutSec | ForEach-Object { Say ("        $_") 'Gray' }
  } else {
    Say '        run-server-detached.ps1 missing - falling back to npm run dev in a window' 'Red'
    Start-CompanyWindow 'Laya router + dashboard (8787)' "Set-Location -LiteralPath '$Root'; npm run dev"
  }
  $routerStarted = $true
}

# --- 3. Mission control ----------------------------------------------------
if ($NoWatch) {
  Say ("  [3/4] Mission     watcher skipped (-NoWatch)") 'DarkGray'
} else {
  $existingWatch = Get-WatcherProcess
  if ($existingWatch) {
    Say ("  [3/4] Mission     watcher already running (pid {0}) - reusing" -f $existingWatch.ProcessId) 'Green'
  } else {
    if (-not (Test-Path -LiteralPath $WatchPs1)) { throw "missing $WatchPs1" }
    Say ("  [3/4] Mission     starting ops\watch-company.ps1 in a new window") 'Yellow'
    Start-CompanyWindow 'Company mission control' "& '$WatchPs1' -Root '$Root'"
  }
}

# --- 4. Wait for both health checks ---------------------------------------
$layaOk = $layaWasUp
$routerOk = $routerWasUp

if (-not ($layaOk -and $routerOk)) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  Say ("  [4/4] waiting up to {0}s for both health checks ..." -f $TimeoutSec) 'Gray'
  while ((Get-Date) -lt $deadline) {
    $layaOk = Test-Health $LayaHealthUrl
    $routerOk = Test-Health $RouterHealthUrl
    if ($layaOk -and $routerOk) { break }
    if (-not $Quiet) {
      $state = ''
      if ($layaOk) { $state += 'laya:ok ' } else { $state += 'laya:.. ' }
      if ($routerOk) { $state += 'router:ok' } else { $state += 'router:..' }
      Write-Host ("        {0}" -f $state) -ForegroundColor DarkGray
    }
    Start-Sleep -Seconds 2
  }
  if (-not $Quiet) { Write-Host '' }
}

if ($layaOk -and $routerOk) {
  Write-Host '  =============================================================' -ForegroundColor Green
  Write-Host '   LAYA AI COMPANY IS LIVE' -NoNewline -ForegroundColor Black -BackgroundColor Green
  Write-Host '   (all health checks green)' -ForegroundColor Green
  Write-Host '  =============================================================' -ForegroundColor Green
  Write-Host ("   Dashboard     {0}" -f $DashboardUrl) -ForegroundColor Green
  Write-Host ("   Panel API     {0}/company/panel" -f $DashboardUrl) -ForegroundColor Green
  Write-Host ("   SSE stream    {0}/company/stream  (event: panel every 2s)" -f $DashboardUrl) -ForegroundColor Green
  Write-Host ("   Laya health   {0}" -f $LayaHealthUrl) -ForegroundColor Green
  Write-Host  '   Mission ctrl  ops/watch-company.ps1 (its own window)' -ForegroundColor Green
  Write-Host  '   Talk to CEO   POST /company/assistant/message' -ForegroundColor Green
  Write-Host  '   Stop          ops/stop-company.ps1   (add -IncludeLaya for Laya)' -ForegroundColor Green
  Write-Host  '   Guide         docs/CEO_RUNBOOK.md' -ForegroundColor Green
  Write-Host '  =============================================================' -ForegroundColor Green
  if ($layaStarted -or $routerStarted) {
    if (-not $Quiet) {
      Write-Host ''
      Write-Host '  Note: services marked "starting" above are in their own terminal windows;' -ForegroundColor DarkGray
      Write-Host '        closing those windows stops them.' -ForegroundColor DarkGray
    }
  }
  Write-Host ''

  if (-not $NoBrowser) {
    Start-Process $DashboardUrl | Out-Null
    Say ("  opened {0} in your default browser" -f $DashboardUrl) 'Cyan'
  }
  exit 0
}

# --- failure ---------------------------------------------------------------
Write-Host '  =============================================================' -ForegroundColor Red
Write-Host '   COMPANY DID NOT COME UP IN TIME' -ForegroundColor Red
Write-Host '  =============================================================' -ForegroundColor Red
Write-Host ("   Laya   {0}  {1}" -f $LayaHealthUrl, $(if ($layaOk) { 'OK' } else { 'NOT RESPONDING' })) -ForegroundColor $(if ($layaOk) { 'Green' } else { 'Red' })
Write-Host ("   Router {0}  {1}" -f $RouterHealthUrl, $(if ($routerOk) { 'OK' } else { 'NOT RESPONDING' })) -ForegroundColor $(if ($routerOk) { 'Green' } else { 'Red' })
Write-Host ''
Write-Host '   Check the service windows for errors. Common causes:' -ForegroundColor Yellow
Write-Host '     - Laya first run downloads/preloads checkpoints (can take a while);' -ForegroundColor DarkGray
Write-Host '       if the venv is missing run deps\setup.ps1.' -ForegroundColor DarkGray
Write-Host '     - Router window shows "EADDRINUSE" -> port 8787 belongs to another process.' -ForegroundColor DarkGray
Write-Host '     - doc: docs/CEO_RUNBOOK.md (troubleshooting table).' -ForegroundColor DarkGray
Write-Host ''
exit 1
