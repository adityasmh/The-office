<#
ops/kafka-up.ps1 - bring up the local single-node KRaft Kafka broker.
Owner: jcode fleet worker SCRIPTS (order fomupf08jc). Contract: docs/KAFKA_BROKER_CONTRACT.md.

USAGE
  powershell -NoProfile -ExecutionPolicy Bypass -File ops\kafka-up.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File ops\kafka-up.ps1 -WaitSeconds 90
  powershell -NoProfile -ExecutionPolicy Bypass -File ops\kafka-up.ps1 -IgnoreRamGuard

WHAT IT DOES
  1. resolves the repo root from $PSScriptRoot (never from the caller's cwd)
  2. exits 3 when tools\jdk\bin\java.exe or the Kafka launcher/storage bats are missing
  3. exits 0 when 127.0.0.1:9092 already answers (idempotent: "already up" is success)
  4. exits 2 when free physical RAM is below 1.5 GB - it prints FREE_RAM_GB=<n> and
     'use in-process topic' and starts no JVM at all (perf guard). The guard is skipped
     when -IgnoreRamGuard is passed or LAYA_IGNORE_RAM_GUARD=1 is set (CEO order 2026-10-01:
     the floor only DELAYS the broker, so it can be lifted deliberately)
  5. writes company\kafka-data\server.properties (the KRaft template with our
     listeners, quorum, replication and log.dirs applied, forward slashes)
  6. formats the storage ONCE (only when company\kafka-data\logs\meta.properties
     is missing) with kafka-storage.bat random-uuid + format
  7. starts kafka-server-start.bat DETACHED (hidden window, stdout/stderr to
     company\kafka-data\broker.out.log / broker.err.log) with JAVA_HOME and
     KAFKA_HEAP_OPTS=-Xms128m -Xmx256m set for the CHILD only. When the .bat
     launchers cannot run at this install path (their per-jar classpath overflows
     cmd.exe's 8191-char line limit - see docs/perf/KAFKA_SETUP.md sections 7-8)
     the same kafka.Kafka main class is started through tools\jdk with a wildcard
     classpath instead, so the broker still comes up
  8. writes company\kafka-data\broker.pid (the java broker pid when it can be
     resolved, else the launcher pid; the launcher pid always lands in
     broker.launcher.pid), waits up to -WaitSeconds for 127.0.0.1:9092 and then
     calls ops\kafka-topics.ps1

EXIT CODES (docs/KAFKA_BROKER_CONTRACT.md)
  0 = up (or already up)
  2 = refused, free RAM < 1.5 GB
  3 = tools missing (JDK or Kafka not unpacked yet, e.g. tools\DL_DONE.json absent)
  1 = other failure

NEVER changes the system PATH or the registry; the env vars it sets are restored
before the script returns. It does not touch the router (:8787) or Laya (:8000).
#>

[CmdletBinding()]
param(
  [int]$WaitSeconds = 60,
  [switch]$IgnoreRamGuard
)

$ErrorActionPreference = "Continue"   # native tools write to stderr; we check $LASTEXITCODE

$RepoRoot = Split-Path -Parent $PSScriptRoot
$JdkHome  = Join-Path $RepoRoot "tools\jdk"
$KafkaHome = Join-Path $RepoRoot "tools\kafka"

$JavaExe          = Join-Path $JdkHome "bin\java.exe"
$KafkaServerStart = Join-Path $KafkaHome "bin\windows\kafka-server-start.bat"
$KafkaStorage     = Join-Path $KafkaHome "bin\windows\kafka-storage.bat"
$TemplateProps    = Join-Path $KafkaHome "config\kraft\server.properties"

$DataDir   = Join-Path $RepoRoot "company\kafka-data"
$LogDir    = Join-Path $DataDir "logs"
$PropsPath = Join-Path $DataDir "server.properties"
$PidPath   = Join-Path $DataDir "broker.pid"
$LauncherPidPath = Join-Path $DataDir "broker.launcher.pid"
$OutLog    = Join-Path $DataDir "broker.out.log"
$ErrLog    = Join-Path $DataDir "broker.err.log"
$MetaProps = Join-Path $LogDir "meta.properties"

$BrokerHost = "127.0.0.1"
$BrokerPort = 9092

# Forward slashes in the properties file (docs/KAFKA_BROKER_CONTRACT.md).
$DataDirFwd = $DataDir.Replace("\", "/")
$LogDirFwd  = $LogDir.Replace("\", "/")

# ---------------------------------------------------------------- helpers ----

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

# Set one key in a list of properties lines (replace the first match, drop later
# duplicates, append when the key is absent). Name is matched literally at the
# start of the line so 'listeners' never rewrites 'advertised.listeners'.
function Set-PropLine {
  param([string[]]$Lines, [string]$Name, [string]$Value)
  $pattern = "^\s*#?\s*" + [regex]::Escape($Name) + "\s*="
  $found = $false
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($line in $Lines) {
    if ($line -match $pattern) {
      if (-not $found) { $out.Add("$Name=$Value"); $found = $true }
      continue
    }
    $out.Add($line)
  }
  if (-not $found) { $out.Add("$Name=$Value") }
  return $out.ToArray()
}

# Run a native tool (.bat) and return its merged output + exit code. The
# temporary SilentlyContinue keeps PowerShell 5.1 from wrapping the tool's own
# stderr in NativeCommandError records; the exit code is what we act on.
function Invoke-NativeTool {
  param([string]$FilePath, [string[]]$ToolArgs)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "SilentlyContinue"
  try {
    $out = & $FilePath @ToolArgs 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
  if ($null -eq $out) { $out = @() }
  if ($null -eq $code) { $code = 1 }
  return @{ Output = @($out); ExitCode = $code }
}

# ---------------------------------------------------------------------------
# The bin\windows launchers assemble CLASSPATH with one entry per jar in libs\\.
# At a long install path that line exceeds cmd.exe's 8191-char limit and every
# launcher dies with "The input line is too long." (measured here: 120 jars ->
# ~10.2k chars, docs/perf/KAFKA_SETUP.md sections 7-8). When that is the case the
# SAME bundled main class is run through the JDK with a wildcard classpath, which
# Java expands itself, instead of going through the broken .bat wrapper.
# ---------------------------------------------------------------------------
function Test-KafkaClasspathOverflowsCmd {
  $libsDir = Join-Path $KafkaHome "libs"
  if (-not (Test-Path -LiteralPath $libsDir)) { return $false }
  $len = 0
  foreach ($jar in @(Get-ChildItem -LiteralPath $libsDir -Filter *.jar -ErrorAction SilentlyContinue)) {
    $len += $jar.FullName.Length + 3      # "path";
  }
  return ($len -gt 8191)
}

# Run a Kafka main class through the JDK with a wildcard classpath and capture
# its merged output (same shape as Invoke-NativeTool; the pattern is the one
# ops\kafka-smoke.ps1 already uses for its own fallback).
function Invoke-KafkaToolDirect {
  param([string]$MainClass, [string[]]$ToolArgs, [int]$TimeoutSeconds = 180)
  $cp    = (Join-Path $KafkaHome "libs\*") + ";" + (Join-Path $KafkaHome "config")
  $log4j = Join-Path $KafkaHome "config\tools-log4j.properties"
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName  = $JavaExe
  $psi.Arguments = ('-Dkafka.logs.dir="{0}" -Dlog4j.configuration="file:{1}" -cp "{2}" {3} {4}' -f `
    $LogDir, $log4j, $cp, $MainClass, ($ToolArgs -join " "))
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  [void]$proc.Start()
  $outTask = $proc.StandardOutput.ReadToEndAsync()
  $errTask = $proc.StandardError.ReadToEndAsync()
  $timedOut = -not $proc.WaitForExit($TimeoutSeconds * 1000)
  if ($timedOut) { try { $proc.Kill() } catch { } }
  $outText = ""
  $errText = ""
  try { $outText = [string]$outTask.Result } catch { }
  try { $errText = [string]$errTask.Result } catch { }
  $code = 1
  if (-not $timedOut) { try { $code = [int]$proc.ExitCode } catch { $code = 1 } }
  $merged = @()
  foreach ($l in (($outText + "`n" + $errText) -split "`n")) {
    if ("$l".Trim().Length -gt 0) { $merged += $l }
  }
  return @{ Output = @($merged); ExitCode = $code }
}

# Storage goes through kafka-storage.bat when the classpath fits, otherwise the
# same kafka.tools.StorageTool class is run through the JDK.
function Invoke-StorageTool {
  param([string[]]$ToolArgs)
  if ($UseDirectJava) { return Invoke-KafkaToolDirect -MainClass "kafka.tools.StorageTool" -ToolArgs $ToolArgs }
  return Invoke-NativeTool -FilePath $KafkaStorage -ToolArgs $ToolArgs
}

# Find the java processes whose command line carries our properties file. This
# is the only process the up/down scripts ever treat as "our broker".
function Get-BrokerJavaProcesses {
  $needle = $PropsPath.Replace("/", "\").ToLowerInvariant()
  $hits = @()
  try {
    $procs = Get-CimInstance -ClassName Win32_Process -Filter "Name = 'java.exe'" -ErrorAction Stop
  } catch {
    return @()
  }
  foreach ($p in $procs) {
    if (-not $p.CommandLine) { continue }
    $cl = $p.CommandLine.Replace("/", "\").ToLowerInvariant()
    if ($cl.Contains($needle)) { $hits += $p }
  }
  return $hits
}

# Save/restore the child-only environment variables (never PATH, never the registry).
function Set-ChildEnv {
  param([string]$JavaHomePath, [string]$HeapOpts)
  $saved = @{}
  foreach ($name in @("JAVA_HOME", "KAFKA_HEAP_OPTS")) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
  }
  $env:JAVA_HOME = $JavaHomePath
  $env:KAFKA_HEAP_OPTS = $HeapOpts
  return $saved
}

function Restore-ChildEnv {
  param($Saved)
  foreach ($name in $Saved.Keys) {
    if ($null -eq $Saved[$name]) {
      Remove-Item -Path ("Env:" + $name) -ErrorAction SilentlyContinue
    } else {
      Set-Item -Path ("Env:" + $name) -Value $Saved[$name] -ErrorAction SilentlyContinue
    }
  }
}

# ------------------------------------------------------------------ start ----

Write-Output "kafka-up: repo root    = $RepoRoot"
Write-Output "kafka-up: kafka home   = $KafkaHome"
Write-Output "kafka-up: data dir     = $DataDir"

# 1. tools present? (exit 3)
$missing = @()
if (-not (Test-Path -LiteralPath $JavaExe))          { $missing += $JavaExe }
if (-not (Test-Path -LiteralPath $KafkaServerStart)) { $missing += $KafkaServerStart }
if (-not (Test-Path -LiteralPath $KafkaStorage))     { $missing += $KafkaStorage }
if ($missing.Count -gt 0) {
  Write-Output "kafka-up: TOOLS MISSING (exit 3):"
  foreach ($m in $missing) { Write-Output ("  missing: " + $m) }
  Write-Output "kafka-up: waiting for the download worker (tools\DL_DONE.json) - nothing was started."
  exit 3
}

# Do the bin\windows launchers work at this install path? When the expanded
# classpath overflows cmd.exe's line limit every .bat dies instantly, so the up
# script must go through the JDK directly (see the helpers above).
$UseDirectJava = Test-KafkaClasspathOverflowsCmd
Write-Output ("kafka-up: bin\\windows launchers usable = " + (-not $UseDirectJava))

# 2. already up? (exit 0, idempotent)
if (Test-TcpPort -TargetHost $BrokerHost -Port $BrokerPort -TimeoutMs 1000) {
  Write-Output "kafka-up: ${BrokerHost}:${BrokerPort} already answers - nothing to do."
  exit 0
}

# 3. free RAM guard (exit 2). FreePhysicalMemory is in KB.
# CEO order 2026-10-01: the floor only DELAYS the broker, so -IgnoreRamGuard or
# LAYA_IGNORE_RAM_GUARD=1 lifts it. The default guard is unchanged.
$ignoreRamGuard = [bool]$IgnoreRamGuard -or ($env:LAYA_IGNORE_RAM_GUARD -eq "1")
$freeKb = $null
try {
  $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
  $freeKb = [double]$os.FreePhysicalMemory
} catch {
  Write-Output ("kafka-up: could not read Win32_OperatingSystem.FreePhysicalMemory: " + $_.Exception.Message)
}
if ($null -ne $freeKb) {
  $freeGb = [math]::Round($freeKb / 1MB, 2)
  Write-Output ("FREE_RAM_GB=" + $freeGb.ToString([System.Globalization.CultureInfo]::InvariantCulture))
  if ($ignoreRamGuard) {
    Write-Output "kafka-up: RAM guard ignored (-IgnoreRamGuard / LAYA_IGNORE_RAM_GUARD=1) - starting anyway."
  } elseif ($freeKb -lt 1572864) {   # 1.5 GB = 1.5 * 1024 * 1024 KB
    Write-Output "use in-process topic"
    Write-Output "kafka-up: free RAM is under 1.5 GB - refusing to start a JVM (exit 2)."
    exit 2
  }
}

# 4. directories + properties file
New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
New-Item -ItemType Directory -Path $LogDir  -Force | Out-Null

$propSpec = [ordered]@{
  "process.roles"                          = "broker,controller"
  "node.id"                                = "1"
  # loopback only - these four literals are the contract (docs/KAFKA_BROKER_CONTRACT.md)
  "controller.quorum.voters"               = "1@127.0.0.1:9093"
  "listeners"                              = "PLAINTEXT://127.0.0.1:9092,CONTROLLER://127.0.0.1:9093"
  "advertised.listeners"                   = "PLAINTEXT://127.0.0.1:9092"
  "log.dirs"                               = "$LogDirFwd"
  "offsets.topic.replication.factor"       = "1"
  "transaction.state.log.replication.factor" = "1"
  "transaction.state.log.min.isr"          = "1"
  "auto.create.topics.enable"              = "false"
  "log.retention.hours"                    = "24"
  "num.partitions"                         = "1"
}

if (Test-Path -LiteralPath $TemplateProps) {
  $lines = @(Get-Content -LiteralPath $TemplateProps)
  Write-Output "kafka-up: properties from template $TemplateProps"
} else {
  # Kafka < 3.3 has no config\kraft template; write a minimal combined-mode file.
  Write-Output "kafka-up: template $TemplateProps not found - generating a minimal KRaft config"
  $lines = @(
    "# generated by ops/kafka-up.ps1 (no tools\kafka\config\kraft\server.properties in this Kafka)",
    "controller.listener.names=CONTROLLER",
    "listener.security.protocol.map=CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT",
    "inter.broker.listener.name=PLAINTEXT"
  )
}
foreach ($key in $propSpec.Keys) {
  $lines = Set-PropLine -Lines $lines -Name $key -Value $propSpec[$key]
}
$header = @(
  "# written by ops/kafka-up.ps1 - do not edit while the broker runs",
  "# single node KRaft: broker + controller, loopback only (docs/KAFKA_BROKER_CONTRACT.md)",
  "# log.dirs=$LogDirFwd",
  ""
)
Set-Content -LiteralPath $PropsPath -Value ($header + $lines) -Encoding ASCII
Write-Output "kafka-up: wrote $PropsPath"

# 5. format storage once (only when meta.properties is missing)
$savedEnv = Set-ChildEnv -JavaHomePath $JdkHome -HeapOpts "-Xms128m -Xmx256m"
try {
  if (Test-Path -LiteralPath $MetaProps) {
    Write-Output "kafka-up: storage already formatted ($MetaProps exists) - skipping format"
  } else {
    $uuid = ""
    $uuidRun = Invoke-StorageTool -ToolArgs @("random-uuid")
    $uuidOut = $uuidRun.Output
    $uuidCode = $uuidRun.ExitCode
    # kafka-storage.bat may add log4j/warning lines around the uuid: keep the
    # last output line that actually looks like a Kafka cluster id.
    foreach ($line in @($uuidOut)) {
      $candidate = "$line".Trim()
      if ($candidate -match "^[0-9A-Za-z_-]{16,32}$") { $uuid = $candidate }
    }
    if ($uuidCode -ne 0 -or $uuid -eq "") {
      Write-Output "kafka-up: kafka-storage.bat random-uuid failed (exit $uuidCode):"
      Write-Output ($uuidOut | Out-String)
      exit 1
    }
    Write-Output "kafka-up: cluster id = $uuid"

    # Kafka 3.6+ accepts --standalone; older versions do not. Try it, then fall back.
    $fmtRun = Invoke-StorageTool -ToolArgs @("format", "-t", $uuid, "-c", $PropsPath, "--standalone")
    $fmtOut = $fmtRun.Output
    $fmtCode = $fmtRun.ExitCode
    if ($fmtCode -ne 0 -and -not (Test-Path -LiteralPath $MetaProps)) {
      Write-Output "kafka-up: 'format ... --standalone' did not work on this Kafka version, retrying without it"
      Write-Output ($fmtOut | Out-String)
      $fmtRun = Invoke-StorageTool -ToolArgs @("format", "-t", $uuid, "-c", $PropsPath)
      $fmtOut = $fmtRun.Output
      $fmtCode = $fmtRun.ExitCode
    }
    if ($fmtCode -ne 0 -or -not (Test-Path -LiteralPath $MetaProps)) {
      Write-Output "kafka-up: kafka-storage.bat format failed (exit $fmtCode):"
      Write-Output ($fmtOut | Out-String)
      exit 1
    }
    Write-Output "kafka-up: storage formatted"
  }

  # 6. start the broker DETACHED, child-only env, output redirected
  New-Item -ItemType File -Path $OutLog -Force | Out-Null
  New-Item -ItemType File -Path $ErrLog -Force | Out-Null
  if ($UseDirectJava) {
    # kafka-server-start.bat dies on cmd.exe's 8191-char classpath limit here, so
    # run kafka.Kafka directly through the JDK with a wildcard classpath. The
    # properties path is still on the command line, so kafka-down.ps1 keeps
    # finding this process as "our broker".
    $serverLog4j = Join-Path $KafkaHome "config\log4j.properties"
    if (-not (Test-Path -LiteralPath $serverLog4j)) { $serverLog4j = Join-Path $KafkaHome "config\tools-log4j.properties" }
    $cpDirect = (Join-Path $KafkaHome "libs\*") + ";" + (Join-Path $KafkaHome "config")
    $javaArgLine = ('-Dkafka.logs.dir="{0}" -Dlog4j.configuration="file:{1}" -Xms128m -Xmx256m -cp "{2}" kafka.Kafka "{3}"' -f `
      $LogDir, $serverLog4j, $cpDirect, $PropsPath)
    Write-Output "kafka-up: starting kafka.Kafka through the JDK (wildcard classpath; the .bat launcher overflows cmd.exe)"
    $launcher = Start-Process -FilePath $JavaExe -ArgumentList $javaArgLine `
      -WorkingDirectory $DataDir -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog
  } else {
    # Start-Process joins ArgumentList with spaces, so cmd must get one fully
    # quoted string (""bat" "props""): cmd /c strips the outer pair and keeps the
    # inner quotes, which is what makes the path with a space work.
    $cmdLine = ('"{0}" "{1}"' -f $KafkaServerStart, $PropsPath)
    $cmdArgs = @("/c", ('"' + $cmdLine + '"'))
    $launcher = Start-Process -FilePath $env:ComSpec -ArgumentList $cmdArgs `
      -WorkingDirectory $DataDir -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog
  }
  if ($null -eq $launcher) {
    Write-Output "kafka-up: Start-Process did not return a process - the broker was not started (exit 1)"
    exit 1
  }
  Write-Output ("kafka-up: started launcher pid " + $launcher.Id)
  Set-Content -LiteralPath $LauncherPidPath -Value $launcher.Id -Encoding ASCII
  # Record the launcher pid right away so a start that never answers the port can
  # still be cleaned up by ops\kafka-down.ps1; once the port answers we replace
  # broker.pid with the real java broker pid.
  Set-Content -LiteralPath $PidPath -Value $launcher.Id -Encoding ASCII
} finally {
  Restore-ChildEnv -Saved $savedEnv
}

# 7. wait for the port, then record the broker pid
$up = $false
$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $deadline) {
  if (Test-TcpPort -TargetHost $BrokerHost -Port $BrokerPort -TimeoutMs 1000) { $up = $true; break }
  Start-Sleep -Milliseconds 1000
}

if (-not $up) {
  Write-Output "kafka-up: ${BrokerHost}:${BrokerPort} did not answer within $WaitSeconds s (exit 1)"
  Write-Output "kafka-up: last lines of $ErrLog :"
  Get-Content -LiteralPath $ErrLog -Tail 20 -ErrorAction SilentlyContinue | ForEach-Object { Write-Output ("  " + $_) }
  Write-Output "kafka-up: last lines of $OutLog :"
  Get-Content -LiteralPath $OutLog -Tail 20 -ErrorAction SilentlyContinue | ForEach-Object { Write-Output ("  " + $_) }
  Write-Output "kafka-up: run ops\kafka-down.ps1 to clean up the half-started process tree"
  exit 1
}

$brokerProc = @(Get-BrokerJavaProcesses)
if ($brokerProc.Count -gt 0) {
  $brokerPid = $brokerProc[0].ProcessId
  Write-Output ("kafka-up: broker java pid " + $brokerPid)
} else {
  $brokerPid = $launcher.Id
  Write-Output ("kafka-up: could not resolve the java pid, recording the launcher pid " + $brokerPid)
}
Set-Content -LiteralPath $PidPath -Value $brokerPid -Encoding ASCII
Write-Output "kafka-up: wrote $PidPath"

# 8. topics (idempotent; creates the three laya.* topics)
$TopicsScript = Join-Path $PSScriptRoot "kafka-topics.ps1"
& $TopicsScript -BootstrapServer "${BrokerHost}:${BrokerPort}"
if ($LASTEXITCODE -ne 0) {
  Write-Output "kafka-up: ops\kafka-topics.ps1 failed (exit $LASTEXITCODE) - broker is up but topics are not ready"
  exit 1
}

Write-Output "kafka-up: OK - broker on ${BrokerHost}:${BrokerPort}, topics ready"
exit 0
