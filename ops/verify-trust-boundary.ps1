# ops/verify-trust-boundary.ps1 — regression check for the control-plane trust boundary.
#
# Contract: docs/CEO_RUNBOOK.md section 0.
#   1. default bind is loopback (off-host cannot even connect);
#   2. every mutating /company/* request needs X-Company-Token;
#   3. GET /company/stream needs the secret (X-Company-Token or ?token=);
#   4. loopback reads stay frictionless (the dashboard keeps working);
#   5. the secret bootstrap answers loopback clients only.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File ops/verify-trust-boundary.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File ops/verify-trust-boundary.ps1 `
#       -Base http://127.0.0.1:8799 -LanIp 192.168.29.242 -SkipBindCheck
#
# -LanIp runs the off-host assertions: a request from this machine to its own LAN
# address arrives with a NON-loopback peer address, which is exactly what an
# attacker on the network looks like (use it against a deliberate HOST=0.0.0.0
# instance to prove the secret is what refuses them).
#
# Exits 1 if any check fails. Uses curl.exe (present on Windows 10+) so it works
# on Windows PowerShell 5.1 where Invoke-WebRequest cannot read a 401 body.

param(
  [string]$Base = "http://localhost:8787",
  [string]$LanIp = "",
  [switch]$SkipBindCheck,
  [int]$TimeoutSec = 10
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$script:pass = 0
$script:fail = 0

function Check([string]$name, [bool]$ok, [string]$detail) {
  if ($ok) { $script:pass++; Write-Host ("PASS  " + $name) -ForegroundColor Green }
  else { $script:fail++; Write-Host ("FAIL  " + $name) -ForegroundColor Red }
  if ($detail) { Write-Host ("      " + $detail) -ForegroundColor DarkGray }
}

function Read-EnvToken {
  $envFile = Join-Path $root '.env'
  if (-not (Test-Path $envFile)) { return '' }
  $m = Select-String -Path $envFile -Pattern '^COMPANY_AUTH_TOKEN=(.*)$' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $m) { return '' }
  return $m.Matches[0].Groups[1].Value.Trim()
}

# Returns @{ code = <int http status, 0 = could not connect>; body = <string> }
# Bodies used by this script are quote-free JSON ({}), because Windows PowerShell
# strips the inner quotes of an inline JSON argument before it reaches a native
# exe; a mangled body would test body-parser instead of the guard.
function Invoke-Http([string]$method, [string]$url, [hashtable]$headers = @{}, [string]$body = '') {
  $out = [System.IO.Path]::GetTempFileName()
  $curlArgs = @('-s', '-m', "$TimeoutSec", '-o', $out, '-w', '%{http_code}', '-X', $method)
  foreach ($k in $headers.Keys) { $curlArgs += @('-H', ("{0}: {1}" -f $k, $headers[$k])) }
  if ($body) { $curlArgs += @('-H', 'content-type: application/json', '--data-binary', $body) }
  $curlArgs += $url
  $code = (& curl.exe @curlArgs) -join ''
  $text = ''
  if (Test-Path $out) {
    $raw = Get-Content -LiteralPath $out -Raw -ErrorAction SilentlyContinue
    if ($null -ne $raw) { $text = [string]$raw }
    Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
  }
  $n = 0
  if (-not [int]::TryParse((($code -join '') -replace '\s', ''), [ref]$n)) { $n = 0 }
  return @{ code = $n; body = $text }
}

$base = $Base.TrimEnd('/')
$uri = [System.Uri]$base
$port = if ($uri.IsDefaultPort) { 80 } else { $uri.Port }
$token = Read-EnvToken

Write-Host ("# trust-boundary verification against " + $base) -ForegroundColor Cyan
Write-Host ("# token from .env: " + $(if ($token) { "present (len " + $token.Length + ")" } else { "MISSING" })) -ForegroundColor DarkGray
Write-Host ""

# --- 1. health posture -------------------------------------------------------
$h = Invoke-Http 'GET' "$base/health"
Check 'health answers' ($h.code -eq 200) ("HTTP " + $h.code)
if ($h.code -eq 200) {
  $j = $null
  try { $j = $h.body | ConvertFrom-Json } catch { }
  Check 'health reports bind + authTokenConfigured' ($null -ne $j -and ($null -ne $j.bind) -and ($j.authTokenConfigured -eq $true)) `
    ("bind=" + $(if ($j) { $j.bind } else { '?' }) + " authTokenConfigured=" + $(if ($j) { $j.authTokenConfigured } else { '?' }))
}

# --- 2. bind is loopback-only ------------------------------------------------
if (-not $SkipBindCheck) {
  $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty LocalAddress -Unique)
  $nonLoop = @($listeners | Where-Object { $_ -notin @('127.0.0.1', '::1') })
  Check ("port " + $port + " listens on loopback only") ($listeners.Count -gt 0 -and $nonLoop.Count -eq 0) `
    ("listeners: " + ($listeners -join ', '))
}

# --- 3. loopback reads stay open --------------------------------------------
$r = Invoke-Http 'GET' "$base/company/panel"
Check 'loopback GET /company/panel works without a token (dashboard)' ($r.code -eq 200) ("HTTP " + $r.code)

# --- 4. mutations require the secret ----------------------------------------
# Body '{}' is valid JSON with no quotes to mangle: with the guard passed, the
# route itself answers 400 ("allocatedUsd (number >= 0) required"), which is a
# clean "reached the route" signal. 401/403 means the guard refused.
$probeUrl = "$base/company/agents/__trust_boundary_probe__/budget"
$noTok = Invoke-Http 'POST' $probeUrl @{} '{}'
Check 'POST /company/* without token is refused' ($noTok.code -eq 401) ("HTTP " + $noTok.code + " " + ("" + $noTok.body).Trim())

$badTok = Invoke-Http 'POST' $probeUrl @{ 'X-Company-Token' = 'not-the-token' } '{}'
Check 'POST /company/* with a wrong token is refused' ($badTok.code -eq 401) ("HTTP " + $badTok.code)

# The same pair on the most dangerous route: starting an agent run.
$msgUrl = "$base/company/agents/__trust_boundary_probe__/message"
$msgNo = Invoke-Http 'POST' $msgUrl @{} '{}'
Check 'POST /company/agents/:id/message without token is refused' ($msgNo.code -eq 401) ("HTTP " + $msgNo.code)

if ($token) {
  $good = Invoke-Http 'POST' $probeUrl @{ 'X-Company-Token' = $token } '{}'
  Check 'POST /company/* with the correct token passes the guard' ($good.code -eq 400) ("HTTP " + $good.code + " " + ("" + $good.body).Trim())
  $msgOk = Invoke-Http 'POST' $msgUrl @{ 'X-Company-Token' = $token } '{}'
  Check 'POST /company/agents/:id/message with the correct token passes the guard' ($msgOk.code -eq 400) ("HTTP " + $msgOk.code + " " + ("" + $msgOk.body).Trim())
}

# --- 5. the SSE stream requires the secret ----------------------------------
$sseNo = Invoke-Http 'GET' "$base/company/stream"
Check 'GET /company/stream without token is refused' ($sseNo.code -eq 401) ("HTTP " + $sseNo.code)

if ($token) {
  $sseOk = Invoke-Http 'GET' "$base/company/stream?token=$token"
  $hasFrame = $sseOk.body -match 'event: panel'
  Check 'GET /company/stream?token=<secret> streams a panel frame' ($sseOk.code -eq 200 -and $hasFrame) `
    ("HTTP " + $sseOk.code + " firstBytes=" + ($sseOk.body.Substring(0, [Math]::Min(40, $sseOk.body.Length)) -replace "`r?`n", ' | '))
}

# --- 6. secret bootstrap is loopback-only -----------------------------------
$boot = Invoke-Http 'GET' "$base/company/auth/bootstrap"
Check 'bootstrap answers a loopback client' ($boot.code -eq 200) ("HTTP " + $boot.code)

# --- 7. off-host behaviour ---------------------------------------------------
if ($LanIp) {
  $lanBase = "http://$LanIp`:$port"
  Write-Host ("# off-host assertions via " + $lanBase + " (non-loopback peer address)") -ForegroundColor Cyan

  $lanRead = Invoke-Http 'GET' "$lanBase/company/panel"
  $lanReadOk = ($lanRead.code -eq 401) -or ($lanRead.code -eq 0)
  $why = if ($lanRead.code -eq 0) { "connection refused (bind is loopback only)" } else { "HTTP 401 (secret required)" }
  Check 'off-host GET /company/panel is refused' $lanReadOk $why

  $lanPost = Invoke-Http 'POST' "$lanBase/company/agents/__trust_boundary_probe__/budget" @{} '{}'
  Check 'off-host POST /company/* without secret is refused' (($lanPost.code -eq 401) -or ($lanPost.code -eq 0)) ("HTTP " + $lanPost.code)

  $lanBoot = Invoke-Http 'GET' "$lanBase/company/auth/bootstrap"
  Check 'off-host cannot bootstrap the secret' (($lanBoot.code -eq 403) -or ($lanBoot.code -eq 0)) ("HTTP " + $lanBoot.code)

  # Legacy spenders must also refuse off-host. The body is '{}' on purpose: if the
  # guard were missing, the route still fails validation (400 "prompt required")
  # instead of spending provider budget on this probe. Expected: 401, or 0 when the
  # bind is loopback-only.
  $lanChat = Invoke-Http 'POST' "$lanBase/chat" @{} '{}'
  Check 'off-host POST /chat (legacy spender) is refused' (($lanChat.code -eq 401) -or ($lanChat.code -eq 0)) ("HTTP " + $lanChat.code)

  $lanRoute = Invoke-Http 'POST' "$lanBase/route" @{} '{}'
  Check 'off-host POST /route is refused' (($lanRoute.code -eq 401) -or ($lanRoute.code -eq 0)) ("HTTP " + $lanRoute.code)

  if ($token) {
    $lanAuth = Invoke-Http 'POST' "$lanBase/company/agents/__trust_boundary_probe__/budget" @{ 'X-Company-Token' = $token } '{}'
    # 400 = guard passed and the route answered; 0 = the default loopback bind
    # gives an off-host caller no path in at all (also acceptable here).
    Check 'off-host with the secret reaches the route (not 401)' (($lanAuth.code -eq 400) -or ($lanAuth.code -eq 0)) ("HTTP " + $lanAuth.code)
  }
}

Write-Host ""
Write-Host ("summary: " + $script:pass + " passed, " + $script:fail + " failed") -ForegroundColor $(if ($script:fail -eq 0) { 'Green' } else { 'Red' })
if ($script:fail -gt 0) { exit 1 }
exit 0
