# ops/tts/poll-and-start.ps1 - background poller for JOEY-OPS
#
# Waits for tools/tts/joey/ENGINE_READY.json (up to 4 hours), then:
#   1. stops any existing listener on 127.0.0.1:8901
#   2. registers the LayaCompanyTtsServer scheduled task
#   3. starts it with schtasks /run
#   4. queries the task state
#   5. polls /tts/health until engine=qwen3, voice=Joey, ready=true
#
# All output is written to logs/joey-ops-poll.log and to a marker JSON file.

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
$engineReady = [System.IO.Path]::Combine($root, 'tools', 'tts', 'joey', 'ENGINE_READY.json')
$registerScript = [System.IO.Path]::Combine($root, 'ops', 'tts', 'register-tts-task.ps1')
$logFile = [System.IO.Path]::Combine($root, 'logs', 'joey-ops-poll.log')
$markerFile = [System.IO.Path]::Combine($root, 'logs', 'joey-ops-poll-marker.json')
$maxWaitSec = 4 * 60 * 60
$intervalSec = 60

function Write-Log($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss.fffZ') $msg"
  Write-Host $line
  Add-Content -LiteralPath $logFile -Value $line -Encoding utf8
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logFile) | Out-Null
Set-Content -LiteralPath $logFile -Value '' -Encoding utf8

Write-Log "JOEY-OPS poller started"
Write-Log "waiting for $engineReady"

$elapsed = 0
while (-not (Test-Path -LiteralPath $engineReady)) {
  if ($elapsed -ge $maxWaitSec) {
    Write-Log "TIMEOUT after $maxWaitSec seconds; ENGINE_READY never appeared"
    @{ status = 'timeout'; engineReady = $false } | ConvertTo-Json | Set-Content -LiteralPath $markerFile -Encoding utf8
    exit 1
  }
  Start-Sleep -Seconds $intervalSec
  $elapsed += $intervalSec
  Write-Log "still waiting... elapsed=${elapsed}s"
  $pct = [math]::Min(100, [math]::Round($elapsed / $maxWaitSec * 100))
  $msg = "Waiting for ENGINE_READY ($($elapsed)s elapsed)"
  Write-Host ("JCODE_PROGRESS " + (@{ percent = $pct; message = $msg } | ConvertTo-Json -Compress))
}

Write-Log "ENGINE_READY found after ${elapsed}s"
try {
  $engineJson = Get-Content -LiteralPath $engineReady -Raw | ConvertFrom-Json
  Write-Log "ENGINE_READY contents: $(($engineJson | ConvertTo-Json -Compress))"
} catch {
  Write-Log "could not parse ENGINE_READY: $_"
}

# 1. Stop any existing listener on 8901 (by PID only, never by image name).
$listener = Get-NetTCPConnection -LocalPort 8901 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  $pid = $listener.OwningProcess
  Write-Log "stopping existing listener pid=$pid on :8901"
  try {
    Stop-Process -Id $pid -Force -ErrorAction Stop
    Write-Log "stopped pid=$pid"
    Start-Sleep -Seconds 2
  } catch {
    Write-Log "failed to stop pid=$pid : $_"
  }
} else {
  Write-Log "no existing listener on :8901"
}

# 2. Register the scheduled task.
Write-Log "registering scheduled task using $registerScript"
$reg = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$registerScript" 2>&1
$reg | ForEach-Object { Write-Log "register> $_" }
if ($LASTEXITCODE -ne 0) {
  Write-Log "registration failed with exit $LASTEXITCODE"
  @{ status = 'register_failed'; exitCode = $LASTEXITCODE } | ConvertTo-Json | Set-Content -LiteralPath $markerFile -Encoding utf8
  exit 1
}

# 3. Run the task.
Write-Log "running scheduled task..."
$run = & schtasks /run /tn LayaCompanyTtsServer 2>&1
$run | ForEach-Object { Write-Log "run> $_" }

Start-Sleep -Seconds 3

# 4. Query the task.
Write-Log "querying scheduled task..."
$query = & schtasks /query /tn LayaCompanyTtsServer /v /fo LIST 2>&1
$query | ForEach-Object { Write-Log "query> $_" }

# 5. Poll health.
Write-Log "polling /tts/health ..."
$health = $null
$healthTries = 0
$maxHealthTries = 60
while ($healthTries -lt $maxHealthTries) {
  Start-Sleep -Seconds 5
  $healthTries++
  try {
    $raw = & curl.exe -s -m 5 http://127.0.0.1:8901/tts/health 2>$null
    Write-Log "health try $healthTries : $raw"
    if ($raw) {
      $health = $raw | ConvertFrom-Json -ErrorAction SilentlyContinue
      if ($health.engine -eq 'qwen3' -and $health.voice -eq 'Joey' -and $health.ready -eq $true) {
        Write-Log "HEALTH OK: engine=$($health.engine) voice=$($health.voice) ready=$($health.ready)"
        break
      }
    }
  } catch {
    Write-Log "health try $healthTries error: $_"
  }
}

if (-not ($health.engine -eq 'qwen3' -and $health.voice -eq 'Joey' -and $health.ready -eq $true)) {
  Write-Log "health never reached expected state"
  @{ status = 'health_failed'; health = $health } | ConvertTo-Json | Set-Content -LiteralPath $markerFile -Encoding utf8
  exit 1
}

$marker = @{
  status = 'ready'
  engineReadyFoundSec = $elapsed
  health = $health
  queryOutput = ($query -join "`n")
}
$marker | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $markerFile -Encoding utf8
Write-Log "poller finished successfully"
exit 0
