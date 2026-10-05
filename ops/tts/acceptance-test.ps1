# ops/tts/acceptance-test.ps1 - JOEY-OPS acceptance tests against the live TTS server.
#
# Run this only after the Task Scheduler task is running and /tts/health shows ready.
# It writes logs/joey-ops-acceptance.log and logs/joey-ops-acceptance.json.

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
$logFile = [System.IO.Path]::Combine($root, 'logs', 'joey-ops-acceptance.log')
$resultFile = [System.IO.Path]::Combine($root, 'logs', 'joey-ops-acceptance.json')
$healthUrl = 'http://127.0.0.1:8901/tts/health'
$speakUrl = 'http://127.0.0.1:8901/tts/speak'
$layaHealthUrl = 'http://127.0.0.1:8000/health'
$sentence = 'This is a twenty word sentence used for the cold and warm latency acceptance test run today.'

function Write-Log($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss.fffZ') $msg"
  Write-Host $line
  Add-Content -LiteralPath $logFile -Value $line -Encoding utf8
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logFile) | Out-Null
Set-Content -LiteralPath $logFile -Value '' -Encoding utf8

function Get-Health {
  try {
    $raw = & curl.exe -s -m 5 $healthUrl 2>$null
    return ($raw | ConvertFrom-Json -ErrorAction SilentlyContinue), $raw
  } catch { return $null, $null }
}

function Speak-Once($text) {
  $body = @{ text = $text; play = $false } | ConvertTo-Json -Compress
  $t0 = Get-Date
  $raw = & curl.exe -s -m 60 -X POST $speakUrl -H 'content-type: application/json' -d $body 2>$null
  $ms = ([math]::Round(((Get-Date) - $t0).TotalMilliseconds))
  $resp = $raw | ConvertFrom-Json -ErrorAction SilentlyContinue
  return $resp, $raw, $ms
}

Write-Log 'JOEY-OPS acceptance started'

# Initial health
$h, $hRaw = Get-Health
Write-Log "initial health: $hRaw"
if (-not $h -or $h.engine -ne 'qwen3' -or $h.voice -ne 'Joey' -or -not $h.ready) {
  Write-Log 'ABORT: initial health does not show qwen3/Joey/ready'
  exit 1
}

$results = @{
  initialHealth = $h
  speak = @()
  fallback = @{}
  vram = @{}
}

# Cold + warm speak
for ($i = 1; $i -le 2; $i++) {
  $resp, $raw, $clientMs = Speak-Once $sentence
  Write-Log "speak $i server ms=$($resp.ms) client ms=$clientMs response: $raw"
  $results.speak += @{ iteration = $i; serverMs = $resp.ms; clientMs = $clientMs; ok = $resp.ok; engine = $resp.engine; voice = $resp.voice; bytes = $resp.bytes }
}

# Worker kill fallback test
$workerPid = $h.worker.pid
Write-Log "fallback test: killing worker pid=$workerPid"
$t0 = Get-Date
try { Stop-Process -Id $workerPid -Force -ErrorAction Stop } catch { Write-Log "failed to kill worker: $_"; exit 1 }
$fbMs = $null
$fbHealth = $null
while (((Get-Date) - $t0).TotalSeconds -lt 30) {
  Start-Sleep -Milliseconds 500
  $fb, $fbRaw = Get-Health
  if ($fb -and $fb.engine -eq 'windows-sapi') {
    $fbMs = ([math]::Round(((Get-Date) - $t0).TotalMilliseconds))
    $fbHealth = $fb
    Write-Log "fallback active after ${fbMs}ms: $fbRaw"
    break
  }
}
if (-not $fbMs) {
  Write-Log 'ABORT: fallback to windows-sapi did not happen within 30s'
  exit 1
}
$results.fallback.killedWorkerPid = $workerPid
$results.fallback.switchMs = $fbMs
$results.fallback.switchHealth = $fbHealth

# Wait for recovery
Write-Log 'waiting for qwen3 recovery...'
$t0 = Get-Date
$recovered = $false
while (((Get-Date) - $t0).TotalSeconds -lt 120) {
  Start-Sleep -Seconds 2
  $rec, $recRaw = Get-Health
  if ($rec -and $rec.engine -eq 'qwen3' -and $rec.ready) {
    $recMs = ([math]::Round(((Get-Date) - $t0).TotalMilliseconds))
    $results.fallback.recoveryMs = $recMs
    $results.fallback.recoveryHealth = $rec
    Write-Log "recovered to qwen3 after ${recMs}ms: $recRaw"
    $recovered = $true
    break
  }
}
if (-not $recovered) {
  Write-Log 'WARNING: did not recover to qwen3 within 120s'
  $results.fallback.recoveryMs = $null
}

# Laya + Joey VRAM test
Write-Log 'VRAM test: capturing nvidia-smi and health...'
$smi = & nvidia-smi 2>&1
$smi | ForEach-Object { Write-Log "nvidia-smi> $_" }
$results.vram.nvidiaSmi = ($smi -join "`n")

$lh, $lhRaw = Get-Health
Write-Log "health before stress: $lhRaw"
$results.vram.healthBefore = $lh

$layaHealth = & curl.exe -s -m 10 $layaHealthUrl 2>$null
Write-Log "Laya health: $layaHealth"
$results.vram.layaHealth = $layaHealth

# 5 speak calls
for ($i = 1; $i -le 5; $i++) {
  $resp, $raw, $clientMs = Speak-Once "Speak call number $i during the VRAM stress test."
  Write-Log "stress speak $i ms=$($resp.ms) ok=$($resp.ok) engine=$($resp.engine)"
  if (-not $resp.ok) { Write-Log "ABORT: speak $i failed: $raw"; exit 1 }
}

# Laya inference request (use a minimal systemone call via ops/laya-eval.ts if available)
Write-Log 'sending Laya inference request...'
$layaInferenceMs = $null
try {
  $lt0 = Get-Date
  # A minimal team decision question; no dispatch, read-only.
  $layaBody = @{
    state = "Choose which project owns this request: write a short README for the voice service."
    questions = @(
      @{ id = "team"; kind = "multiple_choice"; text = "Which active project should own this order?"; options = @(@{ id = "ops"; text = "ops" }; @{ id = "other"; text = "other" }) }
    )
  } | ConvertTo-Json -Compress -Depth 5
  $layaResp = & curl.exe -s -m 90 -X POST http://127.0.0.1:8000/v1/systemone -H 'content-type: application/json' -d $layaBody 2>$null
  $layaInferenceMs = ([math]::Round(((Get-Date) - $lt0).TotalMilliseconds))
  Write-Log "Laya inference returned in ${layaInferenceMs}ms: $layaResp"
  $results.vram.layaInferenceMs = $layaInferenceMs
  $results.vram.layaInferenceResponse = $layaResp
} catch {
  Write-Log "Laya inference request failed: $_"
  $results.vram.layaInferenceError = $_.ToString()
}

$lh2, $lh2Raw = Get-Health
Write-Log "health after stress: $lh2Raw"
$results.vram.healthAfter = $lh2

$results | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $resultFile -Encoding utf8
Write-Log 'acceptance finished'
exit 0
