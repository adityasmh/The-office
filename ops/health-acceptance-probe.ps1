<#
ops/health-acceptance-probe.ps1 - isolated acceptance probe for the ROUTER-HANG fix
(/health first + zero-I/O, and the loop watchdog's evidence file).

Owner: jcode worker, 2026-09-30. Work order: "Router hang root cause".

It starts a THROWAWAY router with
  * its own port        (default 8799; -Port to change; 8787 is REFUSED - it is the live router)
  * its own cwd and COMPANY_ROOT under %TEMP% (so it can never write the live company\ or logs\)
  * MOCK_MODE=1, AUTOCLOSE=0, HOST=127.0.0.1
measures /health latency 50 times, prints the body (it must contain a "loop" object),
prints the watchdog evidence file (logs\router-<port>.blocks.log) and then stops ONLY the
process it started. It never touches the live router on :8787.

  powershell -NoProfile -ExecutionPolicy Bypass -File ops\health-acceptance-probe.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File ops\health-acceptance-probe.ps1 -PrerollSeconds 75

Recorded run: logs/loop-watchdog-acceptance.txt
#>
param(
  [int]$Port = 8799,
  [int]$PrerollSeconds = 75,
  [int]$Probes = 50
)

$ErrorActionPreference = "Continue"
if ($Port -eq 8787) {
  Write-Output "REFUSING: :8787 is the live router. Pick another port (-Port 8799)."
  exit 2
}
$root = Split-Path -Parent $PSScriptRoot
$tmp = Join-Path $env:TEMP ("router-health-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$company = Join-Path $tmp "company"
New-Item -ItemType Directory -Path $company -Force | Out-Null

$env:PORT = "$Port"
$env:COMPANY_ROOT = $company
$env:MOCK_MODE = "1"
$env:AUTOCLOSE = "0"
$env:HOST = "127.0.0.1"

$tsx = Join-Path $root "node_modules\.bin\tsx.cmd"
$scriptPath = Join-Path $root "src\server.ts"
$out = Join-Path $tmp "router.out.log"
$err = Join-Path $tmp "router.err.log"

Write-Output "root=$root"
Write-Output "tmp=$tmp  (isolated COMPANY_ROOT + cwd; the live :8787 is not touched)"
$p = Start-Process -FilePath $tsx -ArgumentList "`"$scriptPath`"" -WorkingDirectory $tmp `
  -RedirectStandardOutput $out -RedirectStandardError $err -PassThru -WindowStyle Hidden
Write-Output "started pid=$($p.Id) on :$Port"

$ok = $false
$waited = 0
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 500
  $waited = ($i + 1) * 0.5
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3 -UseBasicParsing
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch { }
}
Write-Output "health answered: $ok after ${waited}s"
if (-not $ok) {
  Write-Output "--- stdout ---"; Get-Content $out -Tail 30
  Write-Output "--- stderr ---"; Get-Content $err -Tail 30
  foreach ($h in (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).OwningProcess) { Stop-Process -Id $h -Force -ErrorAction SilentlyContinue }
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  exit 1
}

if ($PrerollSeconds -gt 0) {
  Write-Output "preroll: letting the watchers run for ${PrerollSeconds}s (so the watchdog can catch real slow sync work)..."
  Start-Sleep -Seconds $PrerollSeconds
}

$times = @()
for ($i = 0; $i -lt $Probes; $i++) {
  $sw = [diagnostics.stopwatch]::StartNew()
  $null = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 5 -UseBasicParsing
  $sw.Stop()
  $times += $sw.Elapsed.TotalMilliseconds
}
$sorted = $times | Sort-Object
Write-Output ("health latency over {0} probes: p50={1:N1}ms p95={2:N1}ms max={3:N1}ms" -f $Probes, $sorted[[int]($sorted.Count * 0.5)], $sorted[[int]($sorted.Count * 0.95)], $sorted[-1])

Write-Output "--- /health body (must contain a \"loop\" object) ---"
Write-Output (Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 5 -UseBasicParsing).Content

Write-Output "--- watchdog evidence file ---"
$blocks = Join-Path $tmp "logs\router-$Port.blocks.log"
if (Test-Path $blocks) { Get-Content $blocks } else { Write-Output "MISSING: $blocks" }

Write-Output "--- live :8787 untouched? ---"
Write-Output ("8787 listener pid: " + (((Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue).OwningProcess) -join ","))

Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
$holder = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).OwningProcess
foreach ($h in $holder) { Stop-Process -Id $h -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1
Write-Output "stopped pid=$($p.Id) (+listener $($holder -join ',')); temp tree left at $tmp"
