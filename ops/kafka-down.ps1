<#
ops/kafka-down.ps1 - stop the local Kafka broker that ops\kafka-up.ps1 started.
Owner: jcode fleet worker SCRIPTS (order fomupf08jc). Contract: docs/KAFKA_BROKER_CONTRACT.md.

USAGE
  powershell -NoProfile -ExecutionPolicy Bypass -File ops\kafka-down.ps1

WHAT IT DOES
  * resolves the repo root from $PSScriptRoot
  * identifies ONLY our broker:
      - java processes whose command line contains
        company\kafka-data\server.properties (the data props file), and
      - the pid stored in company\kafka-data\broker.pid, accepted only when that
        pid is still the matching java process (or the cmd.exe launcher whose
        command line carries the same props file)
  * tries a GRACEFUL stop first: taskkill without /F on the process tree; after a
    short wait it falls back to taskkill /F, then verifies the port is gone
  * removes company\kafka-data\broker.pid and broker.launcher.pid
  * exits 0 even when the broker was not running

It never kills another java process: a java process is stopped only when its
command line carries our props file. Never touches the router (:8787) or Laya.

EXIT CODES (docs/KAFKA_BROKER_CONTRACT.md)
  0 = stopped, or was not running
#>

[CmdletBinding()]
param(
  [int]$GracefulWaitSeconds = 15
)

$ErrorActionPreference = "Continue"

$RepoRoot  = Split-Path -Parent $PSScriptRoot
$DataDir   = Join-Path $RepoRoot "company\kafka-data"
$PropsPath = Join-Path $DataDir "server.properties"
$PidPath   = Join-Path $DataDir "broker.pid"
$LauncherPidPath = Join-Path $DataDir "broker.launcher.pid"
$BrokerHost = "127.0.0.1"
$BrokerPort = 9092

function Test-TcpPort {
  param([string]$TargetHost, [int]$Port, [int]$TimeoutMs = 1000)
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect($TargetHost, $Port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
    $client.EndConnect($iar)
    return $true
  } catch {
    return $false
  } finally {
    try { $client.Close() } catch { }
  }
}

function Get-ProcessInfo {
  param([int]$ProcessId)
  try { return Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = " + $ProcessId) -ErrorAction Stop }
  catch { return $null }
}

# True when this pid is a java process whose command line carries our props file
# (i.e. our broker, and only our broker).
function Test-IsOurBrokerJava {
  param([int]$ProcessId)
  $p = Get-ProcessInfo -ProcessId $ProcessId
  if ($null -eq $p) { return $false }
  if ($p.Name -notlike "java*") { return $false }
  if (-not $p.CommandLine) { return $false }
  $cl = $p.CommandLine.Replace("/", "\").ToLowerInvariant()
  return $cl.Contains($PropsPath.Replace("/", "\").ToLowerInvariant())
}

# True when this pid is a cmd.exe launcher whose command line carries our props file.
function Test-IsOurLauncher {
  param([int]$ProcessId)
  $p = Get-ProcessInfo -ProcessId $ProcessId
  if ($null -eq $p) { return $false }
  if ($p.Name -notlike "cmd*") { return $false }
  if (-not $p.CommandLine) { return $false }
  $cl = $p.CommandLine.Replace("/", "\").ToLowerInvariant()
  return $cl.Contains($PropsPath.Replace("/", "\").ToLowerInvariant())
}

function Stop-PidTree {
  param([int]$ProcessId, [switch]$Force)
  $killArgs = @("/PID", "$ProcessId", "/T")
  if ($Force) { $killArgs += "/F" }
  $out = & taskkill @killArgs 2>&1
  Write-Output ("kafka-down: taskkill " + ($killArgs -join " ") + " -> exit " + $LASTEXITCODE)
  if ($null -ne $out) { $out | ForEach-Object { Write-Output ("  " + $_) } }
  return $LASTEXITCODE
}

Write-Output "kafka-down: repo root = $RepoRoot"

# ---------------------------------------------------------------------------
# 1. find our processes (command line match is the authoritative signal)
# ---------------------------------------------------------------------------
$javaPids = @()
try {
  $procs = Get-CimInstance -ClassName Win32_Process -Filter "Name = 'java.exe'" -ErrorAction Stop
} catch {
  $procs = @()
}
$needle = $PropsPath.Replace("/", "\").ToLowerInvariant()
foreach ($p in @($procs)) {
  if (-not $p.CommandLine) { continue }
  if ($p.CommandLine.Replace("/", "\").ToLowerInvariant().Contains($needle)) { $javaPids += [int]$p.ProcessId }
}

$pidFileBroker = $null      # pid from broker.pid, when it is our broker java process
$launcherPids = @()         # cmd.exe launchers for our broker

if (Test-Path -LiteralPath $PidPath) {
  $raw = (Get-Content -LiteralPath $PidPath -ErrorAction SilentlyContinue | Select-Object -First 1)
  $raw = "$raw".Trim()
  $pidValue = 0
  if ([int]::TryParse($raw, [ref]$pidValue)) {
    if (Test-IsOurBrokerJava -ProcessId $pidValue) {
      $pidFileBroker = $pidValue
      if ($javaPids -notcontains $pidValue) { $javaPids += $pidValue }
    } elseif (Test-IsOurLauncher -ProcessId $pidValue) {
      $launcherPids += $pidValue
      Write-Output ("kafka-down: broker.pid " + $pidValue + " is the launcher (broker java pid not recorded)")
    } else {
      Write-Output ("kafka-down: broker.pid " + $pidValue + " is not our broker (stale or reused pid) - ignoring it")
    }
  } else {
    Write-Output ("kafka-down: broker.pid does not contain a pid ('" + $raw + "') - ignoring it")
  }
} else {
  Write-Output "kafka-down: no broker.pid - relying on the command line match"
}

if (Test-Path -LiteralPath $LauncherPidPath) {
  $raw2 = "$(Get-Content -LiteralPath $LauncherPidPath -ErrorAction SilentlyContinue | Select-Object -First 1)".Trim()
  $lpid = 0
  if ([int]::TryParse($raw2, [ref]$lpid) -and $launcherPids -notcontains $lpid -and (Test-IsOurLauncher -ProcessId $lpid)) {
    $launcherPids += $lpid
  }
}

if ($javaPids.Count -eq 0 -and $launcherPids.Count -eq 0) {
  Write-Output "kafka-down: no broker process found - nothing to stop."
  Remove-Item -LiteralPath $PidPath -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $LauncherPidPath -ErrorAction SilentlyContinue
  exit 0
}

Write-Output ("kafka-down: broker java pid(s): " + (($javaPids | ForEach-Object { "$_" }) -join ", "))
if ($launcherPids.Count -gt 0) {
  Write-Output ("kafka-down: launcher pid(s):    " + (($launcherPids | ForEach-Object { "$_" }) -join ", "))
}

# ---------------------------------------------------------------------------
# 2. graceful stop first (taskkill without /F), then force
# ---------------------------------------------------------------------------
foreach ($jp in $javaPids)   { [void](Stop-PidTree -ProcessId $jp) }
foreach ($lp in $launcherPids) { [void](Stop-PidTree -ProcessId $lp) }

$deadline = (Get-Date).AddSeconds($GracefulWaitSeconds)
while ((Get-Date) -lt $deadline) {
  $alive = $false
  foreach ($jp in $javaPids) {
    if ($null -ne (Get-Process -Id $jp -ErrorAction SilentlyContinue)) { $alive = $true }
  }
  if (-not $alive -and -not (Test-TcpPort -TargetHost $BrokerHost -Port $BrokerPort -TimeoutMs 500)) { break }
  Start-Sleep -Milliseconds 500
}

foreach ($jp in $javaPids) {
  if ($null -ne (Get-Process -Id $jp -ErrorAction SilentlyContinue)) {
    Write-Output ("kafka-down: pid $jp still alive after the graceful attempt - forcing")
    [void](Stop-PidTree -ProcessId $jp -Force)
  }
}
foreach ($lp in $launcherPids) {
  if ($null -ne (Get-Process -Id $lp -ErrorAction SilentlyContinue)) {
    [void](Stop-PidTree -ProcessId $lp -Force)
  }
}

# verify the port is released (informational; we still exit 0)
if (Test-TcpPort -TargetHost $BrokerHost -Port $BrokerPort -TimeoutMs 1000) {
  Write-Output "kafka-down: WARNING - ${BrokerHost}:${BrokerPort} still answers after the stop"
} else {
  Write-Output "kafka-down: ${BrokerHost}:${BrokerPort} is closed"
}

Remove-Item -LiteralPath $PidPath -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $LauncherPidPath -ErrorAction SilentlyContinue
Write-Output "kafka-down: removed the pid file(s)"
exit 0
