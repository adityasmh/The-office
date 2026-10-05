<#
ops/kafka-topics.ps1 - create (idempotently) and list the three laya.* topics.
Owner: jcode fleet worker SCRIPTS (order fomupf08jc). Contract: docs/KAFKA_BROKER_CONTRACT.md.

USAGE
  powershell -NoProfile -ExecutionPolicy Bypass -File ops\kafka-topics.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File ops\kafka-topics.ps1 -BootstrapServer 127.0.0.1:9092

WHAT IT DOES
  * uses tools\kafka\bin\windows\kafka-topics.bat --bootstrap-server 127.0.0.1:9092
    with JAVA_HOME=tools\jdk set for the CHILD process only (PATH and the
    registry are never touched)
  * creates, with --if-not-exists and replication-factor 1:
      laya.outcomes   3 partitions
      laya.decisions  1 partition
      laya.dlq        1 partition
    each with --config retention.ms=86400000 (24 h) and
    --config retention.bytes=268435456 (256 MB)
  * then lists the topics and verifies all three are present

EXIT CODES (docs/KAFKA_BROKER_CONTRACT.md)
  0 = all 3 topics exist
  3 = tools missing (Kafka not unpacked yet)
  1 = any kafka-topics.bat call failed, or a topic is missing after creation
#>

[CmdletBinding()]
param(
  [string]$BootstrapServer = "127.0.0.1:9092"
)

$ErrorActionPreference = "Continue"   # native tools write to stderr; we check $LASTEXITCODE

$RepoRoot  = Split-Path -Parent $PSScriptRoot
$JdkHome   = Join-Path $RepoRoot "tools\jdk"
$KafkaHome = Join-Path $RepoRoot "tools\kafka"
$KafkaTopics = Join-Path $KafkaHome "bin\windows\kafka-topics.bat"
$JavaExe     = Join-Path $JdkHome "bin\java.exe"

$RetentionMs    = "86400000"     # 24 h
$RetentionBytes = "268435456"    # 256 MB

$topics = @(
  @{ Name = "laya.outcomes";  Partitions = 3 },
  @{ Name = "laya.decisions"; Partitions = 1 },
  @{ Name = "laya.dlq";       Partitions = 1 }
)

if (-not (Test-Path -LiteralPath $JavaExe) -or -not (Test-Path -LiteralPath $KafkaTopics)) {
  Write-Output "kafka-topics: TOOLS MISSING (exit 3)"
  if (-not (Test-Path -LiteralPath $JavaExe))     { Write-Output ("  missing: " + $JavaExe) }
  if (-not (Test-Path -LiteralPath $KafkaTopics)) { Write-Output ("  missing: " + $KafkaTopics) }
  exit 3
}

# The bin\windows launchers build one classpath entry per jar in libs\; at a long
# install path that overflows cmd.exe's 8191-char limit and every launcher dies
# with "The input line is too long." (docs/perf/KAFKA_SETUP.md sections 7-8). In
# that case the same org.apache.kafka.tools.TopicCommand class is run through the
# JDK with a wildcard classpath instead of the .bat wrapper.
$KafkaLibs = Join-Path $KafkaHome "libs"
$UseDirectJava = $false
if (Test-Path -LiteralPath $KafkaLibs) {
  $cpLen = 0
  foreach ($jar in @(Get-ChildItem -LiteralPath $KafkaLibs -Filter *.jar -ErrorAction SilentlyContinue)) {
    $cpLen += $jar.FullName.Length + 3      # "path";
  }
  $UseDirectJava = ($cpLen -gt 8191)
}

function Invoke-KafkaTopicsTool {
  param([string[]]$ToolArgs)
  if (-not $UseDirectJava) { return Invoke-NativeTool -FilePath $KafkaTopics -ToolArgs $ToolArgs }
  $cp    = (Join-Path $KafkaHome "libs\*") + ";" + (Join-Path $KafkaHome "config")
  $log4j = Join-Path $KafkaHome "config\tools-log4j.properties"
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName  = $JavaExe
  $psi.Arguments = ('-Dkafka.logs.dir="{0}" -Dlog4j.configuration="file:{1}" -cp "{2}" org.apache.kafka.tools.TopicCommand {3}' -f `
    (Join-Path $RepoRoot "company\kafka-data\logs"), $log4j, $cp, ($ToolArgs -join " "))
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  [void]$proc.Start()
  $outTask = $proc.StandardOutput.ReadToEndAsync()
  $errTask = $proc.StandardError.ReadToEndAsync()
  $timedOut = -not $proc.WaitForExit(120000)
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

# Child-only JAVA_HOME: save, set, restore (never PATH, never the registry).
$savedJavaHome = [Environment]::GetEnvironmentVariable("JAVA_HOME", "Process")
$env:JAVA_HOME = $JdkHome

# Run kafka-topics.bat and return its merged output + exit code, without the
# PowerShell 5.1 NativeCommandError noise a .bat writing to stderr produces.
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

$failed = 0
foreach ($t in $topics) {
  $topicArgs = @(
    "--bootstrap-server", $BootstrapServer,
    "--create",
    "--topic", $t.Name,
    "--partitions", "$($t.Partitions)",
    "--replication-factor", "1",
    "--config", ("retention.ms=" + $RetentionMs),
    "--config", ("retention.bytes=" + $RetentionBytes),
    "--if-not-exists"
  )
  Write-Output ("kafka-topics: create " + $t.Name + " (" + $t.Partitions + " partitions, retention 24h/256MB)")
  $createRun = Invoke-KafkaTopicsTool -ToolArgs $topicArgs
  $out = $createRun.Output
  $code = $createRun.ExitCode
  if ($null -ne $out) { $out | ForEach-Object { Write-Output ("  " + $_) } }
  if ($code -ne 0) { $failed = 1 }
}

if ($failed -ne 0) {
  if ($null -eq $savedJavaHome) { Remove-Item -Path "Env:JAVA_HOME" -ErrorAction SilentlyContinue }
  else { $env:JAVA_HOME = $savedJavaHome }
  Write-Output "kafka-topics: at least one create failed (exit 1)"
  exit 1
}

# List and verify (idempotent: an existing topic with the right config is success).
$listRun = Invoke-KafkaTopicsTool -ToolArgs @("--bootstrap-server", $BootstrapServer, "--list")
$listOut = $listRun.Output
$listCode = $listRun.ExitCode
$listText = ""
if ($null -ne $listOut) { $listText = ($listOut | Out-String) }
Write-Output "kafka-topics: --list ->"
if ($null -ne $listOut) { $listOut | ForEach-Object { Write-Output ("  " + $_) } }

if ($null -eq $savedJavaHome) { Remove-Item -Path "Env:JAVA_HOME" -ErrorAction SilentlyContinue }
else { $env:JAVA_HOME = $savedJavaHome }

if ($listCode -ne 0) {
  Write-Output "kafka-topics: --list failed (exit 1)"
  exit 1
}

$missingTopics = @()
foreach ($t in $topics) {
  if ($listText -notmatch ("(?m)^\s*" + [regex]::Escape($t.Name) + "\s*$")) { $missingTopics += $t.Name }
}
if ($missingTopics.Count -gt 0) {
  Write-Output ("kafka-topics: missing after create: " + ($missingTopics -join ", ") + " (exit 1)")
  exit 1
}

Write-Output ("kafka-topics: OK - " + (($topics | ForEach-Object { $_.Name }) -join ", ") + " exist on " + $BootstrapServer)
exit 0
