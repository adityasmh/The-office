<#
scripts/dev-router.ps1 - per-agent DEV instance of the company router (CEO order 2026-09-30).

WHY THIS EXISTS
  PROD is the live router on :8787 and it serves a FROZEN release copy (release\), so nobody's edit
  can change it and nobody needs to restart it. DEV is where agents test THEIR work: one instance per
  job, on its own port, against an isolated COMPANY_ROOT, so a test can never touch live company data.

CONTRACT
  * refuses :8787 - always, with no override. Prod is manager/CRASHFIX territory (rule 6).
  * picks a free port in 8801-8899 (override with -Port, still inside that range).
  * isolated data: COMPANY_ROOT = dev\<name>\company and dev\<name>\.env is the config this instance
    loads (a copy of the repo .env; its keys are parsed, never echoed, and never put on a command line).
    It is created fresh; -FromProd copies the LIVE company\ into it when a test needs real data.
  * never enables the Slack bridge (only PROD may hold it): SLACK_BRIDGE=0, SLACK_SOCKET_MODE=0.
  * runs the WORKING TREE (that is the point of DEV): <root>\node_modules\.bin\tsx.cmd src/server.ts
  * prints the URL, the pid and the log paths; writes dev\<name>\dev.json so -Stop/-List/-Restart find it.

USAGE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev-router.ps1 -Name ui-briefing
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev-router.ps1 -Name fleet -FromProd
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev-router.ps1 -Name ui-briefing -Status
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev-router.ps1 -Name ui-briefing -Restart
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev-router.ps1 -Name ui-briefing -Stop
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev-router.ps1 -List
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev-router.ps1 -Selftest   # start, edit, restart, stop
#>
[CmdletBinding()]
param(
  [string]$Name = "",
  [int]$Port = 0,
  [switch]$Stop,
  [switch]$Restart,
  [switch]$Status,
  [switch]$List,
  [switch]$Purge,
  [switch]$FromProd,
  [switch]$Selftest,
  [int]$TimeoutSec = 120
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$devRoot = Join-Path $root 'dev'
$prodPort = 8787
$portLow = 8801
$portHigh = 8899

function Say([string]$m) { Write-Host $m }

function Test-PortFree([int]$p) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect('127.0.0.1', $p, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(300)) { return $true }
    try { $client.EndConnect($iar); return $false } catch { return $true }
  } catch { return $true } finally { try { $client.Close() } catch { } }
}

function Get-FreePort {
  $busy = @()
  foreach ($f in (Get-ChildItem $devRoot -Directory -ErrorAction SilentlyContinue)) {
    $j = Join-Path $f.FullName 'dev.json'
    if (Test-Path $j) { try { $busy += [int]((Get-Content $j -Raw | ConvertFrom-Json).port) } catch { } }
  }
  for ($p = $portLow; $p -le $portHigh; $p++) {
    if ($busy -contains $p) { continue }
    if (Test-PortFree $p) { return $p }
  }
  throw "no free port in $portLow-$portHigh"
}

function Get-Health([int]$p, [int]$timeoutSec = 5) {
  $raw = & curl.exe -s -m $timeoutSec "http://127.0.0.1:$p/health" 2>$null
  if (-not $raw) { return $null }
  try { return ($raw | ConvertFrom-Json) } catch { return $null }
}

function State-File([string]$n) { return (Join-Path (Join-Path $devRoot $n) 'dev.json') }
function Read-State([string]$n) {
  $f = State-File $n
  if (-not (Test-Path $f)) { return $null }
  try { return (Get-Content $f -Raw | ConvertFrom-Json) } catch { return $null }
}
function Test-Alive($st) {
  if (-not $st) { return $false }
  $p = Get-Process -Id ([int]$st.pid) -ErrorAction SilentlyContinue
  return [bool]$p
}

# ---------------------------------------------------------------- -List ----
function Show-List {
  if (-not (Test-Path $devRoot)) { Say "no dev instances (nothing under $devRoot)"; return }
  $any = $false
  foreach ($d in (Get-ChildItem $devRoot -Directory -ErrorAction SilentlyContinue)) {
    $st = Read-State $d.Name
    if (-not $st) { continue }
    $any = $true
    $alive = Test-Alive $st
    $h = if ($alive) { Get-Health ([int]$st.port) 3 } else { $null }
    Say ("{0,-14} port={1,-5} pid={2,-7} alive={3,-5} health={4,-5} company={5}" -f `
      $d.Name, $st.port, $st.pid, $alive, $(if ($h -and $h.ok) { 'ok' } else { '-' }), $st.companyRoot)
    Say ("               url={0}  logs={1}" -f $st.url, $st.logs)
  }
  if (-not $any) { Say "no dev instances" }
}

function Get-Body([string]$u, [int]$timeoutSec = 20) {
  $r = & curl.exe -s -m $timeoutSec $u 2>$null
  if ($null -eq $r) { return '' }
  return (($r | Out-String).Trim())
}

# Start-Process -Wait waits for the process AND its descendants - and this script's child starts a dev
# SERVER, so -Wait never returns (the first selftest run hung for 17 minutes proving that). WaitForExit
# waits for that one process only, with a bound.
function Invoke-Child([string[]]$a, [int]$timeoutMs = 300000) {
  $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $a -PassThru
  if (-not $p.WaitForExit($timeoutMs)) { try { & taskkill.exe /PID $p.Id /T /F 2>&1 | Out-Null } catch { }; return -999 }
  return $p.ExitCode
}

# ------------------------------------------------------------ -Selftest ---
# The CEO's proof, in one command: start DEV, edit a file, restart DEV, and show that PROD's pid and
# health are UNCHANGED throughout. The edit is a file in the WORKING TREE that the dev server serves
# (public\dev-probe.txt) and that no other agent owns; it is deleted afterwards. PROD is only ever
# OBSERVED here - this script never touches :8787 (see the guards above).
function Get-ProdSnapshot {
  $l = (& netstat.exe -ano -p tcp | Select-String ":$prodPort " | Select-String 'LISTENING' | Select-Object -First 1)
  $pid2 = 0
  if ($l) { $parts = ($l.ToString().Trim() -split '\s+'); if ($parts.Length -ge 5) { $pid2 = [int]$parts[4] } }
  $h = $null
  if ($pid2 -gt 0) { $h = Get-Health $prodPort 10 }
  return [pscustomobject]@{ pid = $pid2; lagMs = $(if ($h) { $h.lagMs } else { $null }); ok = [bool]($h -and $h.ok) }
}

function Invoke-Selftest {
  $nm = 'selftest'
  $dir = Join-Path $devRoot $nm
  $probeFile = Join-Path $root 'public\dev-probe.txt'
  $script:stResults = @()
  function Step([string]$what, [bool]$ok, [string]$detail) {
    $script:stResults += [pscustomobject]@{ what = $what; ok = $ok; detail = $detail }
    Write-Host ("{0} {1} - {2}" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $what, $detail)
  }

  if (Test-Path $dir) { & $PSCommandPath -Name $nm -Purge | Out-Null }
  Remove-Item $probeFile -Force -ErrorAction SilentlyContinue
  $prodBefore = Get-ProdSnapshot
  Write-Host ("PROD before: pid={0} ok={1} lagMs={2}" -f $prodBefore.pid, $prodBefore.ok, $prodBefore.lagMs)

  $p = Get-FreePort
  # The script path can contain a space ("Default Project"): Start-Process joins -ArgumentList with
  # spaces and does NOT quote, so -File must be quoted here or the child powershell dies at startup
  # (observed: exit -196608 and every step failing).
  $self = '"' + $PSCommandPath + '"'
  $common = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $self, '-Name', $nm, '-Port', "$p")

  # 1. start
  $c1 = Invoke-Child $common
  $st = Read-State $nm
  Step 'dev instance starts and is healthy' (($c1 -eq 0) -and (Test-Alive $st)) ("exit=$c1 port=$p pid=$(if ($st) { $st.pid } else { '-' })")

  # 2. serves the dashboard
  $v2 = & curl.exe -s -m 20 -o NUL -w '%{http_code}' "http://127.0.0.1:$p/v2/"
  $appjs = & curl.exe -s -m 20 -o NUL -w '%{http_code}' "http://127.0.0.1:$p/v2/app.js"
  Step 'dev serves /v2/ and /v2/app.js' (("$v2" -eq '200') -and ("$appjs" -eq '200')) "/v2/=$v2 /v2/app.js=$appjs"

  # 3. isolated data: the dev company root is NOT the live one
  $isolated = $st -and ($st.companyRoot -ne (Join-Path $root 'company')) -and (Test-Path $st.companyRoot)
  Step 'dev has its own COMPANY_ROOT (live company\ untouched)' ([bool]$isolated) ("companyRoot=$(if ($st) { $st.companyRoot } else { '-' })")

  # 4. edit a file in the working tree
  $marker = 'dev-probe-' + (Get-Random -Minimum 100000 -Maximum 999999)
  Set-Content -LiteralPath $probeFile -Value $marker -Encoding utf8
  $before = Get-Body "http://127.0.0.1:$p/dev-probe.txt" 20
  Step 'edit reaches the WORKING TREE only (before restart the running dev may not serve it yet)' $true ("file=$probeFile written='$marker' served-before-restart='$before'")

  # 5. restart dev (same port) and re-read
  $c2 = Invoke-Child ($common + '-Restart')
  $st2 = Read-State $nm
  $after = Get-Body "http://127.0.0.1:$p/dev-probe.txt" 20
  Step 'restarting dev picks the edit up (same port, new pid)' (($c2 -eq 0) -and ($after -eq $marker) -and $st2) ("exit=$c2 port=$p pid=$($st2.pid) served='$after'")

  # 6. PROD untouched
  $prodAfter = Get-ProdSnapshot
  $same = ($prodBefore.pid -eq $prodAfter.pid) -and ($prodBefore.ok -eq $prodAfter.ok)
  Step 'PROD pid/health UNCHANGED across the whole dev cycle' ([bool]$same) ("before pid=$($prodBefore.pid) ok=$($prodBefore.ok) | after pid=$($prodAfter.pid) ok=$($prodAfter.ok) lagMs=$($prodAfter.lagMs)")

  # 7. clean stop (the script path is quoted in $common, and for -Stop here)
  $c3 = Invoke-Child @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'), '-Name', $nm, '-Stop') 60000
  Start-Sleep -Seconds 1
  $gone = -not (Test-Alive (Read-State $nm))
  Step 'dev stops cleanly' (($c3 -eq 0) -and $gone) ("exit=$c3 pid-gone=$gone")

  Remove-Item $probeFile -Force -ErrorAction SilentlyContinue
  $failed = @($script:stResults | Where-Object { -not $_.ok })
  Write-Host ''
  Write-Host ("SELFTEST {0}: {1}/{2} pass" -f $(if ($failed.Count -eq 0) { 'PASS' } else { 'FAIL' }), ($script:stResults.Count - $failed.Count), $script:stResults.Count)
  if ($failed.Count -gt 0) { exit 1 }
  exit 0
}

if ($Selftest) { Invoke-Selftest }

# ------------------------------------------------------- argument guards ----
if ($Port -eq $prodPort) {
  Say "REFUSING: :8787 is PROD. This script never binds PROD - use a dev port ($portLow-$portHigh)."
  exit 2
}
if ($Port -ne 0 -and ($Port -lt $portLow -or $Port -gt $portHigh)) {
  Say "REFUSING: -Port $Port is outside the dev range $portLow-$portHigh. PROD (:8787) is manager/CRASHFIX only."
  exit 2
}
if ($List) { Show-List; exit 0 }

if (-not $Name) { Say "usage: dev-router.ps1 -Name <job> [-Port n] [-FromProd] [-Restart|-Stop|-Status|-Purge|-List]"; exit 2 }
$Name = ($Name -replace '[^A-Za-z0-9._-]', '-').ToLower()
if ($Name.Length -gt 40) { $Name = $Name.Substring(0, 40) }
$dir = Join-Path $devRoot $Name
$state = Read-State $Name

if ($Status) {
  if (-not $state) { Say "no dev instance named '$Name'"; exit 1 }
  Say ("name={0} port={1} pid={2} alive={3} company={4}" -f $Name, $state.port, $state.pid, (Test-Alive $state), $state.companyRoot)
  $h = Get-Health ([int]$state.port) 5
  if ($h) { Say ("health: " + ($h | ConvertTo-Json -Compress)) } else { Say "health: no answer" }
  exit 0
}

if ($Stop -or $Purge) {
  if (-not $state) { Say "no dev instance named '$Name' (nothing to stop)"; exit 0 }
  if (Test-Alive $state) {
    # /T so the cmd -> tsx -> node chain dies together; this only ever kills OUR OWN dev pid tree.
    & taskkill.exe /PID ([int]$state.pid) /T /F 2>&1 | ForEach-Object { Say ("  " + $_) }
  } else { Say "pid $($state.pid) was already gone" }
  if ($Purge) { Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue; Say "purged $dir" }
  else { Remove-Item (State-File $Name) -Force -ErrorAction SilentlyContinue; Say "stopped '$Name' (data kept in $dir)" }
  exit 0
}

# ------------------------------------------------------------- start -------
if ((Test-Alive $state) -and -not $Restart) {
  Say "dev instance '$Name' is ALREADY RUNNING on :$($state.port) (pid $($state.pid)). Use -Restart to restart it."
  exit 0
}
if ($Restart -and $state) {
  if (Test-Alive $state) {
    & taskkill.exe /PID ([int]$state.pid) /T /F 2>&1 | ForEach-Object { Say ("  " + $_) }
    Start-Sleep -Milliseconds 500
  }
  $state = $null
}

if (-not $Port) { $Port = Get-FreePort }
if (-not (Test-PortFree $Port)) { Say "REFUSING: :$Port is already in use"; exit 2 }

$companyRoot = Join-Path $dir 'company'
$logDir = Join-Path $dir 'logs'
New-Item -ItemType Directory -Force -Path $companyRoot, $logDir | Out-Null

if ($FromProd) {
  $live = Join-Path $root 'company'
  Say "copying live company data (read-only source) into $companyRoot ..."
  & robocopy.exe $live $companyRoot /E /NFL /NDL /NJH /NJS /NP /XD snapshots | Out-Null
  Say ("  copied " + ((Get-ChildItem $companyRoot -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count) + " file(s)")
}

# A copy of the config, so the dev instance has the same keys as prod but its own PORT/COMPANY_ROOT.
$envSrc = Join-Path $root '.env'
$envDst = Join-Path $dir '.env'
if (Test-Path $envSrc) { Copy-Item $envSrc $envDst -Force } else { Say "WARNING: no .env at $envSrc (dev will start with defaults)" }

$outLog = Join-Path $logDir 'dev.out.log'
$errLog = Join-Path $logDir 'dev.err.log'
$tsx = Join-Path $root 'node_modules\.bin\tsx.cmd'
if (-not (Test-Path $tsx)) { Say "REFUSING: $tsx not found"; exit 2 }

# The dev's OWN config copy is honored: its KEY=VALUE lines are loaded into THIS launcher process and
# the child inherits them. Values are never written to a command line (no secret in `netstat`/WMI) and
# never echoed. The dev-only overrides below win over anything in the file.
$loaded = 0
if (Test-Path $envDst) {
  foreach ($line in (Get-Content $envDst -ErrorAction SilentlyContinue)) {
    if ($line -match '^\s*#' -or $line.Trim().Length -eq 0) { continue }
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
      $k = $Matches[1]
      $v = $Matches[2].Trim()
      if ($v.Length -ge 2 -and (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'")))) { $v = $v.Substring(1, $v.Length - 2) }
      Set-Item -Path ("Env:" + $k) -Value $v -ErrorAction SilentlyContinue
      $loaded++
    }
  }
}
$env:PORT = "$Port"
$env:HOST = '127.0.0.1'
$env:COMPANY_ROOT = $companyRoot
$env:SLACK_BRIDGE = '0'
$env:SLACK_SOCKET_MODE = '0'
$env:SLACK_BOT_TOKEN = ''
$env:SLACK_APP_TOKEN = ''
$env:SLACK_CHANNEL_ID = ''
$env:LAYAD_DEV = '1'

Say "DEV '$Name' -> :$Port  (working tree src/, isolated company root, $loaded config key(s) from its own .env)"
# Redirection is done by cmd.exe, NOT by Start-Process -RedirectStandardOutput: a redirected child
# inherits the CALLER's pipe handles, so any caller that waits for EOF (a terminal, the jcode bash
# tool) blocks until the dev server exits - the same trap scripts\serve-laya.ps1 documents.
$inner = "cd /d `"$root`" && `"$tsx`" src/server.ts 1>> `"$outLog`" 2>> `"$errLog`""
$child = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $inner -WindowStyle Hidden -PassThru

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$h = $null
while ((Get-Date) -lt $deadline) {
  $h = Get-Health $Port 5
  if ($h -and $h.ok) { break }
  if ($child.HasExited) { break }
  Start-Sleep -Seconds 2
}

if (-not ($h -and $h.ok)) {
  Say "DEV '$Name' did NOT become healthy on :$Port within ${TimeoutSec}s."
  Say "  last dev.out.log lines:"; Get-Content $outLog -Tail 8 -ErrorAction SilentlyContinue | ForEach-Object { Say ("    " + $_) }
  Say "  last dev.err.log lines:"; Get-Content $errLog -Tail 8 -ErrorAction SilentlyContinue | ForEach-Object { Say ("    " + $_) }
  if (-not $child.HasExited) { & taskkill.exe /PID $child.Id /T /F 2>&1 | Out-Null }
  exit 1
}

# the listener pid (the node child), not the cmd wrapper: that is what a tester should kill
$listener = (& netstat.exe -ano -p tcp | Select-String ":$Port " | Select-String 'LISTENING' | Select-Object -First 1)
$listenPid = $child.Id
if ($listener) {
  $parts = ($listener.ToString().Trim() -split '\s+')
  if ($parts.Length -ge 5) { $listenPid = [int]$parts[4] }
}

$st = [pscustomobject]@{
  name        = $Name
  port        = $Port
  pid         = $listenPid
  cmdPid      = $child.Id
  startedAt   = (Get-Date).ToString('s')
  companyRoot = $companyRoot
  url         = "http://127.0.0.1:$Port/v2/"
  logs        = $logDir
  servedFrom  = $root
}
$st | ConvertTo-Json | Set-Content -LiteralPath (State-File $Name) -Encoding utf8

Say ""
Say ("DEV '$Name' is UP")
Say ("  url          : http://127.0.0.1:$Port/v2/    (health: http://127.0.0.1:$Port/health)")
Say ("  port / pid   : $Port / $listenPid (cmd wrapper $($child.Id))")
Say ("  company data : $companyRoot")
Say ("  logs         : $outLog , $errLog")
Say ("  code         : $root  (the working tree - edit and use -Restart)")
Say ("  stop         : powershell -File scripts\dev-router.ps1 -Name $Name -Stop")
exit 0
