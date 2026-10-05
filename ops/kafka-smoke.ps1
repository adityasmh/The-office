# ops/kafka-smoke.ps1 (VERIFY lane, KAFKA-VERIFY order)
#
# Smoke test for the local single-node Kafka broker.
# Uses ONLY the console tools bundled with the Kafka download
# (tools\kafka\bin\windows). No npm install, no downloads, no new files
# outside %TEMP%. JAVA_HOME is pointed at tools\jdk for CHILD PROCESSES ONLY
# and restored on exit.
#
# What it does:
#   1. checks the bundled tools and the JDK exist
#   2. produces 3 JSON messages to laya.outcomes with a unique run id
#      (shape: {"id":"smoke-<runid>","model":"deepseek-v4.1-flash","class":"ROUTINE","ok":true},
#       no prompt text)
#   3. consumes them back from the beginning with a unique consumer group
#      and --timeout-ms, and asserts every one of the 3 arrived
#   4. lists the topics and the partition count of laya.outcomes
#   5. prints SMOKE PASS or SMOKE FAIL
#   6. FALLBACK, loudly logged: if a bin\windows launcher cannot run because
#      cmd.exe rejects its classpath line (every Kafka .bat builds one entry per
#      jar in libs\, which overflows the 8191-char limit at a long install path),
#      the SAME bundled tool class is re-run through the JDK with a wildcard
#      classpath. Still only Kafka's own bundled tools; nothing is installed.
#      The script reports which path it used. See docs/perf/KAFKA_SETUP.md.
#
# Exit code: 0 = SMOKE PASS, 1 = SMOKE FAIL.
# It never starts or stops the broker.

[CmdletBinding()]
param(
    [string]$BootstrapServer = '127.0.0.1:9092',
    [string]$Topic           = 'laya.outcomes',
    [int]$ConsumerTimeoutMs  = 15000,
    [int]$ExpectedPartitions = 3
)

$ErrorActionPreference = 'Continue'

$repoRoot = Split-Path -Parent $PSScriptRoot
$kafkaWin = Join-Path $repoRoot 'tools\kafka\bin\windows'
$jdkHome  = Join-Path $repoRoot 'tools\jdk'
$kafkaHome = Join-Path $repoRoot 'tools\kafka'
$logsDir   = Join-Path $repoRoot 'company\kafka-data\logs'

$producerBat = Join-Path $kafkaWin 'kafka-console-producer.bat'
$consumerBat = Join-Path $kafkaWin 'kafka-console-consumer.bat'
$topicsBat   = Join-Path $kafkaWin 'kafka-topics.bat'

$workDir = Join-Path $env:TEMP ('kafka-smoke-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $workDir | Out-Null

$failures = New-Object System.Collections.Generic.List[string]
$cmdLineOverflow = $false
$usedDirectJava = $false
function Note($m) { Write-Host $m }
function Fail($m) { [void]$script:failures.Add($m); Write-Host ('  [FAIL] ' + $m) }
function Good($m) { Write-Host ('  [ok]   ' + $m) }

# ---------------------------------------------------------------- environment
$prevJavaHome = $env:JAVA_HOME
$env:JAVA_HOME = $jdkHome

function Invoke-ProcessCapture {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$StdinFile,
        [int]$TimeoutSeconds = 60
    )
    # System.Diagnostics.Process (not Start-Process) so the real exit code is
    # always readable and stdin/stdout/stderr are captured without deadlock.
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    $psi.Arguments = ($Arguments -join ' ')
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    if ($StdinFile) { $psi.RedirectStandardInput = $true }

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    [void]$proc.Start()

    $outTask = $proc.StandardOutput.ReadToEndAsync()
    $errTask = $proc.StandardError.ReadToEndAsync()

    if ($StdinFile) {
        try {
            # Raw bytes straight to the pipe: the StreamWriter would emit its
            # encoding preamble (a UTF-8 BOM) ahead of the first line.
            $bytes = [System.IO.File]::ReadAllBytes($StdinFile)
            $proc.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
            $proc.StandardInput.BaseStream.Flush()
            $proc.StandardInput.Close()
        } catch { }
    }

    $timedOut = -not $proc.WaitForExit($TimeoutSeconds * 1000)
    if ($timedOut) {
        try { $proc.Kill() } catch { }
        [void]$proc.WaitForExit(5000)
        Note ('  [warn] ' + (Split-Path -Leaf $FilePath) + ' did not exit within ' + $TimeoutSeconds + 's; killed')
    }

    $outText = ''
    $errText = ''
    try { $outText = [string]$outTask.Result } catch { }
    try { $errText = [string]$errTask.Result } catch { }
    # cmd.exe refuses a batch line longer than 8191 chars; Kafka's bin\windows
    # launchers build one classpath entry per jar and overflow it on a long
    # install path. Flag it so the failure is diagnosable, not just red.
    if ($errText -match 'input line is too long') { $script:cmdLineOverflow = $true }

    $code = -1
    if (-not $timedOut) {
        try { if ($null -ne $proc.ExitCode) { $code = [int]$proc.ExitCode } } catch { $code = -1 }
    }

    return [pscustomobject]@{
        ExitCode = $code
        Stdout   = $outText
        Stderr   = $errText
        TimedOut = $timedOut
    }
}

function Invoke-BatCapture {
    param([string]$Bat, [string[]]$Arguments, [string]$StdinFile, [int]$TimeoutSeconds = 60)
    return Invoke-ProcessCapture -FilePath $Bat -Arguments $Arguments -StdinFile $StdinFile -TimeoutSeconds $TimeoutSeconds
}

# The bin\windows launcher cannot run when cmd.exe rejects its classpath line
# (one entry per jar in libs\, > 8191 chars at a long install path). The same
# bundled tool class is then run through the JDK with a wildcard classpath.
function Invoke-KafkaTool {
    param(
        [string]$Bat,
        [string]$MainClass,
        [string[]]$Arguments,
        [string]$StdinFile,
        [int]$TimeoutSeconds = 60
    )
    $res = Invoke-BatCapture -Bat $Bat -Arguments $Arguments -StdinFile $StdinFile -TimeoutSeconds $TimeoutSeconds
    if ($res.Stderr -notmatch 'input line is too long') { return $res }

    Note ('  [warn] ' + (Split-Path -Leaf $Bat) + ' cannot run at this install path')
    Note ('  [warn] (classpath exceeds cmd.exe''s 8191-char line limit) - running the same bundled')
    Note ('  [warn] tool class directly with the JDK: ' + $MainClass)
    $script:usedDirectJava = $true

    if (-not (Test-Path $logsDir)) { New-Item -ItemType Directory -Force -Path $logsDir | Out-Null }
    # Values that contain a space carry their own quotes (Start-Process/.NET join
    # ArgumentList with spaces).
    $cp = (Join-Path $kafkaHome 'libs\*') + ';' + (Join-Path $kafkaHome 'config')
    $javaExe = Join-Path $jdkHome 'bin\java.exe'
    $javaArgs = @(
        ('-Dkafka.logs.dir="' + $logsDir + '"'),
        ('-Dlog4j.configuration="file:' + (Join-Path $kafkaHome 'config\tools-log4j.properties') + '"'),
        '-cp', ('"' + $cp + '"'),
        $MainClass
    ) + $Arguments

    # The JVM's first cold start on this machine has taken over a minute, so the
    # fallback gets at least 150 s regardless of the caller's budget.
    $fallbackTimeout = [math]::Max($TimeoutSeconds, 150)
    if ($StdinFile) {
        # Feed stdin from the file through cmd's redirect: the .NET stdin writer
        # would emit its encoding preamble (a UTF-8 BOM) ahead of the first line
        # and corrupt the first JSON message, and .NET Framework 4.x has no
        # ProcessStartInfo.StandardInputEncoding to suppress that.
        $inner = ('"' + $javaExe + '" ' + ($javaArgs -join ' ')) + ' < "' + $StdinFile + '"'
        return Invoke-ProcessCapture -FilePath $env:ComSpec -Arguments @('/c', ('"' + $inner + '"')) -TimeoutSeconds $fallbackTimeout
    }

    return Invoke-ProcessCapture -FilePath $javaExe -Arguments $javaArgs -TimeoutSeconds $fallbackTimeout
}

try {
    # ------------------------------------------------------------ preconditions
    Note '=== kafka smoke test ==='
    $missing = @()
    foreach ($p in @($producerBat, $consumerBat, $topicsBat)) {
        if (-not (Test-Path $p)) { $missing += $p }
    }
    if (-not (Test-Path (Join-Path $jdkHome 'bin\java.exe'))) { $missing += (Join-Path $jdkHome 'bin\java.exe') }
    if ($missing.Count -gt 0) {
        foreach ($m in $missing) { Fail ('missing required file: ' + $m) }
        Write-Host 'SMOKE FAIL'
        exit 1
    }
    Good ('bundled tools present: ' + $kafkaWin)
    Good ('JAVA_HOME for children: ' + $jdkHome)

    $runId = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 6)

    # ------------------------------------------------------------- unique msgs
    $ids = @()
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($i in 1..3) {
        $id = 'smoke-' + $runId + '-' + $i
        $ids += $id
        $lines.Add(('{"id":"' + $id + '","model":"deepseek-v4.1-flash","class":"ROUTINE","ok":true}'))
    }
    $stdinFile = Join-Path $workDir 'messages.jsonl'
    # BOM-free ASCII: a leading BOM would corrupt the first JSON message.
    [System.IO.File]::WriteAllText($stdinFile, (($lines -join "`r`n") + "`r`n"), (New-Object System.Text.ASCIIEncoding))
    Note ('run id: ' + $runId)
    Note ('producing 3 messages to ' + $Topic + ' via ' + $BootstrapServer)

    # --------------------------------------------------------------- produce
    $prod = Invoke-KafkaTool -Bat $producerBat -MainClass 'kafka.tools.ConsoleProducer' -StdinFile $stdinFile -TimeoutSeconds 90 -Arguments @(
        '--bootstrap-server', $BootstrapServer,
        '--topic', $Topic
    )
    if ($prod.ExitCode -ne 0) {
        Fail ('kafka-console-producer.bat exit code ' + $prod.ExitCode)
        Note ('  stderr tail: ' + (($prod.Stderr -split "`n" | Select-Object -Last 4) -join ' | '))
    } else {
        Good 'producer exit code 0'
    }

    # --------------------------------------------------------------- consume
    $group = 'smoke-group-' + $runId
    Note ('consuming back with group ' + $group + ' (--from-beginning --timeout-ms ' + $ConsumerTimeoutMs + ')')
    $cons = Invoke-KafkaTool -Bat $consumerBat -MainClass 'org.apache.kafka.tools.consumer.ConsoleConsumer' -TimeoutSeconds ([int]([math]::Ceiling($ConsumerTimeoutMs / 1000.0)) + 45) -Arguments @(
        '--bootstrap-server', $BootstrapServer,
        '--topic', $Topic,
        '--from-beginning',
        '--group', $group,
        '--timeout-ms', "$ConsumerTimeoutMs"
    )

    $seen = 0
    foreach ($id in $ids) {
        if ($cons.Stdout -match [regex]::Escape($id)) { $seen++ }
    }
    if ($seen -eq $ids.Count) {
        Good ('all ' + $ids.Count + ' messages consumed back')
    } else {
        Fail ('only ' + $seen + ' of ' + $ids.Count + ' messages came back within ' + $ConsumerTimeoutMs + 'ms')
        Note ('  consumer stderr tail: ' + (($cons.Stderr -split "`n" | Select-Object -Last 4) -join ' | '))
    }
    $consumedAll = @($cons.Stdout -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_.Length -gt 0 })
    Note ('  consumer read ' + $consumedAll.Count + ' message(s) from the beginning of ' + $Topic + ':')
    $mine = @($cons.Stdout | Where-Object { $_ -match [regex]::Escape($runId) })
    if ($mine.Count -eq 0) {
        Note '    (none from this run)'
    } else {
        foreach ($l in $mine) { Note ('    ' + $l) }
    }
    # ---------------------------------------------------------------- topics
    $list = Invoke-KafkaTool -Bat $topicsBat -MainClass 'org.apache.kafka.tools.TopicCommand' -TimeoutSeconds 60 -Arguments @(
        '--bootstrap-server', $BootstrapServer, '--list'
    )
    $topics = @($list.Stdout -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_.Length -gt 0 })
    Note '  topics (kafka-topics.bat --list):'
    foreach ($t in $topics) { Note ('    ' + $t) }
    if ($list.ExitCode -ne 0) { Fail ('kafka-topics.bat --list exit code ' + $list.ExitCode) }

    foreach ($required in @($Topic, 'laya.decisions', 'laya.dlq')) {
        if ($topics -contains $required) { Good ('topic exists: ' + $required) }
        else { Fail ('topic missing: ' + $required) }
    }

    $desc = Invoke-KafkaTool -Bat $topicsBat -MainClass 'org.apache.kafka.tools.TopicCommand' -TimeoutSeconds 60 -Arguments @(
        '--bootstrap-server', $BootstrapServer, '--describe', '--topic', $Topic
    )
    $partCount = ([regex]::Matches($desc.Stdout, 'Partition:\s*\d+')).Count
    $repFactor = 'n/a'
    $m = [regex]::Match($desc.Stdout, 'ReplicationFactor:\s*(\d+)')
    if ($m.Success) { $repFactor = $m.Groups[1].Value }
    Note ('  ' + $Topic + ' partitions: ' + $partCount + ', replication-factor: ' + $repFactor)
    if ($partCount -eq $ExpectedPartitions) {
        Good ($Topic + ' has ' + $ExpectedPartitions + ' partitions')
    } else {
        Fail ($Topic + ' has ' + $partCount + ' partitions, expected ' + $ExpectedPartitions)
    }
    $retM = [regex]::Match($desc.Stdout, 'retention\.ms=(\d+)')
    if ($retM.Success) { Note ('  ' + $Topic + ' retention.ms=' + $retM.Groups[1].Value) }
}
finally {
    $env:JAVA_HOME = $prevJavaHome
    Remove-Item -Recurse -Force -Path $workDir -ErrorAction SilentlyContinue
}

Note ''
if ($cmdLineOverflow -and $usedDirectJava) {
    Write-Host 'NOTE: the tools\kafka\bin\windows launchers could not run (cmd.exe 8191-char'
    Write-Host 'NOTE: classpath limit at this install path); the same bundled tool classes were'
    Write-Host 'NOTE: run through the JDK instead. The ops scripts now embed that fallback.'
    Write-Host ''
}
if ($failures.Count -eq 0) {
    Write-Host 'SMOKE PASS'
    exit 0
} else {
    Write-Host ('SMOKE FAIL (' + $failures.Count + ' check(s))')
    foreach ($f in $failures) { Write-Host ('  - ' + $f) }
    if ($cmdLineOverflow) {
        Write-Host ''
        Write-Host '  DIAGNOSIS: a Kafka bin\windows\*.bat launcher died with'
        Write-Host '  "The input line is too long." - its accumulated classpath (one entry'
        Write-Host '  per jar in tools\kafka\libs) is longer than cmd.exe''s 8191-char limit'
        Write-Host '  at this install path. See docs/perf/KAFKA_SETUP.md.'
    }
    exit 1
}
