# worker-guard-check.ps1 - self-test for spawn-worker.ps1 + worker-guard.ps1.
# Uses temp folders and harmless `ping` dummy processes. Never touches real logs.
# Windows PowerShell 5.1 compatible: no ??, no ternary, no -AsHashtable.
$ErrorActionPreference = "Stop"

$Ops      = $PSScriptRoot
$Guard    = Join-Path $Ops "worker-guard.ps1"
$Spawn    = Join-Path $Ops "spawn-worker.ps1"
$RepoRoot = Split-Path -Parent $Ops
$Utf8     = New-Object System.Text.UTF8Encoding($false)

$script:Passed = 0
$script:Failed = 0
$script:Dummies = New-Object System.Collections.ArrayList

function Pass([string]$name) { $script:Passed = $script:Passed + 1; Write-Output ("PASS  " + $name) }
function Fail([string]$name, [string]$why) { $script:Failed = $script:Failed + 1; Write-Output ("FAIL  " + $name + " :: " + $why) }

function New-TestDir {
    $d = Join-Path $env:TEMP ("wg-check-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $d -Force | Out-Null
    return $d
}

function Start-Dummy {
    $p = Start-Process -FilePath "ping.exe" -ArgumentList "-n","600","127.0.0.1" -WindowStyle Hidden -PassThru
    [void]$script:Dummies.Add($p)
    Start-Sleep -Milliseconds 200
    return $p
}

function Start-DummyWithChild {
    $p = Start-Process -FilePath "cmd.exe" -ArgumentList "/c","ping -n 600 127.0.0.1 > nul" -WindowStyle Hidden -PassThru
    [void]$script:Dummies.Add($p)
    Start-Sleep -Milliseconds 500
    return $p
}

function Proc-Alive([int]$procId) {
    try { Get-Process -Id $procId -ErrorAction Stop | Out-Null; return $true } catch { return $false }
}

function Seed-State([string]$dir, [string]$key, $ov) {
    $s = [ordered]@{
        name=''; pid=0; creationTime=''; maxMinutes=15.0; maxUsd=0.30; maxLogMb=2.0; testDummy=$false;
        offset=0; turns=0; upload=0; download=0; cache_read=0; cache_write=0; estUsd=0.0;
        elapsedSec=0.0; idleSec=0.0; lastPassUtc=$null; firstFinalElapsed=$null; logGrowth=0;
        tokenSeen=$false; warned70=$false; ledgerWritten=$false; plainLines=@(); thoughtChunks=@();
        curThought=''; curThoughtLines=0; log=''
    }
    foreach ($k in $ov.Keys) { $s[$k] = $ov[$k] }
    $obj = @{}
    $obj[$key] = $s
    [System.IO.File]::WriteAllText((Join-Path $dir "worker-guard-state.json"), ($obj | ConvertTo-Json -Depth 8 -Compress), $Utf8)
}

function Register([string]$dir, $hashtable) {
    $path = Join-Path $dir "workers.json"
    [System.IO.File]::AppendAllText($path, (($hashtable | ConvertTo-Json -Compress) + "`r`n"), $Utf8)
}

function New-Log([string]$dir, [string]$name, [string]$content) {
    $p = Join-Path $dir ($name + ".log")
    [System.IO.File]::WriteAllText($p, $content, $Utf8)
    return $p
}

function Run-Guard([string]$dir) {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Guard -Once -TestRoot $dir 2>&1
    return $LASTEXITCODE
}

function GuardLog([string]$dir) {
    $p = Join-Path $dir "worker-guard.log"
    if (Test-Path $p) { return [System.IO.File]::ReadAllText($p) }
    return ""
}

function Entry([string]$name, [int]$procId, [string]$log, [string]$creation, $extra) {
    $h = [ordered]@{ name=$name; pid=$procId; log=$log; startedAt=(Get-Date).ToString("o"); maxMinutes=15.0; maxUsd=0.30; creationTime=$creation }
    if ($extra -ne $null) { foreach ($k in $extra.Keys) { $h[$k] = $extra[$k] } }
    return $h
}

function Creation([object]$proc) {
    try { return $proc.StartTime.ToUniversalTime().ToString("o") } catch { return "" }
}

# Parse a Windows command line the way CommandLineToArgvW does, so we can
# prove the stub really received N separate arguments.
function Split-CmdLine([string]$s) {
    $res = New-Object System.Collections.ArrayList
    $len = $s.Length
    $i = 0
    while ($i -lt $len) {
        while ($i -lt $len -and ($s[$i] -eq ' ' -or $s[$i] -eq "`t")) { $i++ }
        if ($i -ge $len) { break }
        $sb = New-Object System.Text.StringBuilder
        $inQ = $false
        while ($i -lt $len) {
            $c = $s[$i]
            if ($c -eq '\') {
                $n = 0
                while ($i -lt $len -and $s[$i] -eq '\') { $n++; $i++ }
                if ($i -lt $len -and $s[$i] -eq '"') {
                    [void]$sb.Append('\' * [int][math]::Floor($n / 2))
                    if (($n % 2) -eq 1) { [void]$sb.Append('"'); $i++ }
                    else { $inQ = -not $inQ; $i++ }
                } else {
                    [void]$sb.Append('\' * $n)
                }
            } elseif ($c -eq '"') {
                $inQ = -not $inQ; $i++
            } elseif (($c -eq ' ' -or $c -eq "`t") -and (-not $inQ)) {
                break
            } else {
                [void]$sb.Append($c); $i++
            }
        }
        [void]$res.Add($sb.ToString())
    }
    return ,$res.ToArray()
}

# A tiny stub launched through spawn-worker.ps1 via -JcodeExe. It appends its
# received argument line to <name>.args.txt, then either sleeps (~3s) or exits.
function New-Stub([string]$dir, [string]$name, [int]$sleepPings, [switch]$Immediate) {
    $p = Join-Path $dir ($name + ".cmd")
    $lines = @("@echo off", ('echo %* >> "%~dp0' + $name + '.args.txt"'))
    if ($Immediate) { $lines += 'echo stub failed instantly 1>&2' }
    else { $lines += ("ping -n " + $sleepPings + " 127.0.0.1 > nul") }
    [System.IO.File]::WriteAllText($p, (($lines -join "`r`n") + "`r`n"), $Utf8)
    return $p
}

function Out-Pid($out) {
    $ls = @($out -split "`n" | Where-Object { $_.Trim() -ne "" })
    if ($ls.Count -gt 0) { try { return [int]($ls[$ls.Count-1].Trim()) } catch { return -1 } }
    return -1
}

# Invoke spawn-worker.ps1 in a child PowerShell via -EncodedCommand. This avoids
# the PowerShell 5.1 native-argument bug that strips embedded double quotes, so
# the -Message value reaches spawn-worker.ps1 exactly as intended.
function Invoke-Spawn([string[]]$tokens) {
    $parts = @()
    foreach ($t in $tokens) {
        if ($t.Length -gt 0 -and $t[0] -eq '-') { $parts += $t }
        else { $parts += ("'" + ($t -replace "'", "''") + "'") }
    }
    # Run spawn-worker.ps1 in a child PowerShell. The child sends ALL of its
    # output to a temp file (not a pipe, which a long-lived worker would hold
    # open) and then exits with the script's own exit code. That way a refusal
    # really does exit 2, the captured text is complete, and a registered
    # worker is still alive when we come back to look at it.
    $outFile = [System.IO.Path]::GetTempFileName()
    $inner = "`$ProgressPreference='SilentlyContinue'; & '" + ($Spawn -replace "'", "''") + "' " + ($parts -join " ") + " *>> '" + $outFile + "'; `$ec = `$LASTEXITCODE; if (`$ec -eq `$null) { `$ec = 0 }; exit `$ec"
    $b64 = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "powershell.exe"
    $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -EncodedCommand " + $b64
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $p.WaitForExit()
    $code = $p.ExitCode
    $out = ""
    if (Test-Path $outFile) { $out = [System.IO.File]::ReadAllText($outFile) }
    Remove-Item $outFile -Force -ErrorAction SilentlyContinue
    return @{ code = $code; out = $out }
}

function New-BaseState($name, $procId, $creation, $extra) {
    $s = @{ name=$name; pid=$procId; creationTime=$creation; log=''; testDummy=$true; plainLines=@(); thoughtChunks=@() }
    if ($extra -ne $null) { foreach ($k in $extra.Keys) { $s[$k] = $extra[$k] } }
    return $s
}

function Spawn-DryRun([string]$dir, [string]$name, $extraArgs) {
    $t = @("-Name",$name,"-Message","hi","-DryRun","-TestRoot",$dir,"-Repo",$RepoRoot)
    if ($extraArgs -ne $null) { $t = $t + $extraArgs }
    return Invoke-Spawn $t
}

function Spawn-Real([string]$dir, [string]$name, [string]$message, [string]$exe, $extraArgs) {
    $t = @("-Name",$name,"-Message",$message,"-TestRoot",$dir,"-Repo",$RepoRoot)
    if ($exe -ne "") { $t = $t + @("-JcodeExe",$exe) }
    if ($extraArgs -ne $null) { $t = $t + $extraArgs }
    return Invoke-Spawn $t
}

$env:JCODE_WORKER_BALANCE_USD = "5"

Write-Output "=== worker-guard-check ==="

# ---------------------------------------------------------------- 1. word rule (plain Holding. x2)
try {
    $d = New-TestDir; $dm = Start-Dummy; $log = New-Log $d "w1" ("💭 thinking`n[Tokens] upload: 100 download: 10 cache_read: 90 cache_write: 0`nHolding.`nHolding.`n")
    Register $d (Entry "w1" $dm.Id $log (Creation $dm) @{ testDummy=$true })
    $c = Run-Guard $d
    if (-not (Proc-Alive $dm.Id)) { Pass "rule(a) plain Holding x2 killed" } else { Fail "rule(a) plain Holding x2 killed" "still alive" }
} catch { Fail "rule(a) plain Holding x2 killed" $_.Exception.Message }

# ---------------------------------------------------------------- 2. fragmented-thought Holding loop
try {
    $d = New-TestDir; $dm = Start-Dummy
    $t = ""
    for ($i=0; $i -lt 3; $i++) { $t = $t + "💭 Continue`n💭  holding`n💭  now`n" + "`n" }
    $log = New-Log $d "w2" ($t + "[Tokens] upload: 100 download: 10 cache_read: 90 cache_write: 0`n")
    Register $d (Entry "w2" $dm.Id $log (Creation $dm) @{ testDummy=$true })
    $c = Run-Guard $d
    if (-not (Proc-Alive $dm.Id)) { Pass "rule(a) fragmented thought Holding killed" } else { Fail "rule(a) fragmented thought Holding killed" "still alive" }
} catch { Fail "rule(a) fragmented thought Holding killed" $_.Exception.Message }

# ---------------------------------------------------------------- 3. 'holding' in a normal sentence does NOT count
try {
    $d = New-TestDir; $dm = Start-Dummy
    $log = New-Log $d "w3" ("We are holding the lock while the job runs`nstep one complete`nstep two complete`n[Tokens] upload: 1000 download: 20 cache_read: 900 cache_write: 0`nall good here`nno pending work`nmoving on`n")
    Register $d (Entry "w3" $dm.Id $log (Creation $dm) @{ testDummy=$true })
    $c = Run-Guard $d
    if (Proc-Alive $dm.Id) { Pass "normal-sentence 'holding' not killed" } else { Fail "normal-sentence 'holding' not killed" "was killed" }
} catch { Fail "normal-sentence 'holding' not killed" $_.Exception.Message }

# ---------------------------------------------------------------- 4. repeated plain line rule
try {
    $d = New-TestDir; $dm = Start-Dummy
    $body = ""
    for ($i=0; $i -lt 6; $i++) { $body = $body + "Still waiting for the same state.`n" }
    $log = New-Log $d "w4" ($body + "[Tokens] upload: 100 download: 10 cache_read: 90 cache_write: 0`n")
    Register $d (Entry "w4" $dm.Id $log (Creation $dm) @{ testDummy=$true })
    $c = Run-Guard $d
    if (-not (Proc-Alive $dm.Id)) { Pass "rule(b) repeated line x6 killed" } else { Fail "rule(b) repeated line x6 killed" "still alive" }
} catch { Fail "rule(b) repeated line x6 killed" $_.Exception.Message }

# ---------------------------------------------------------------- 5. final report > 90s
try {
    $d = New-TestDir; $dm = Start-Dummy; $log = New-Log $d "w5" ("## Final report`n[Tokens] upload: 100 download: 10 cache_read: 90 cache_write: 0`n")
    $key = "w5|" + $dm.Id
    Register $d (Entry "w5" $dm.Id $log (Creation $dm) @{ testDummy=$true })
    Seed-State $d $key (New-BaseState "w5" $dm.Id (Creation $dm) @{ log=$log; elapsedSec=100.0; firstFinalElapsed=0.0 })
    $c = Run-Guard $d
    if (-not (Proc-Alive $dm.Id)) { Pass "rule(c) final report >90s killed" } else { Fail "rule(c) final report >90s killed" "still alive" }
} catch { Fail "rule(c) final report >90s killed" $_.Exception.Message }

# ---------------------------------------------------------------- 6. max minutes
try {
    $d = New-TestDir; $dm = Start-Dummy; $log = New-Log $d "w6" ("working`n[Tokens] upload: 100 download: 10 cache_read: 90 cache_write: 0`n")
    $key = "w6|" + $dm.Id
    Register $d (Entry "w6" $dm.Id $log (Creation $dm) @{ testDummy=$true; maxMinutes=0.05 })
    Seed-State $d $key (New-BaseState "w6" $dm.Id (Creation $dm) @{ log=$log; maxMinutes=0.05; elapsedSec=10.0 })
    $c = Run-Guard $d
    if (-not (Proc-Alive $dm.Id)) { Pass "rule(d) max-minutes killed" } else { Fail "rule(d) max-minutes killed" "still alive" }
} catch { Fail "rule(d) max-minutes killed" $_.Exception.Message }

# ---------------------------------------------------------------- 7. max usd
try {
    $d = New-TestDir; $dm = Start-Dummy; $log = New-Log $d "w7" ("working`n[Tokens] upload: 1000000 download: 10 cache_read: 0 cache_write: 0`n")
    $key = "w7|" + $dm.Id
    Register $d (Entry "w7" $dm.Id $log (Creation $dm) @{ testDummy=$true; maxUsd=0.0001 })
    Seed-State $d $key (New-BaseState "w7" $dm.Id (Creation $dm) @{ log=$log; maxUsd=0.0001 })
    $c = Run-Guard $d
    if (-not (Proc-Alive $dm.Id)) { Pass "rule(e) max-usd killed" } else { Fail "rule(e) max-usd killed" "still alive" }
} catch { Fail "rule(e) max-usd killed" $_.Exception.Message }

# ---------------------------------------------------------------- 8. idle (hung)
try {
    $d = New-TestDir; $dm = Start-Dummy; $log = New-Log $d "w8" ("working`n[Tokens] upload: 100 download: 10 cache_read: 90 cache_write: 0`n")
    $key = "w8|" + $dm.Id
    Register $d (Entry "w8" $dm.Id $log (Creation $dm) @{ testDummy=$true })
    Seed-State $d $key (New-BaseState "w8" $dm.Id (Creation $dm) @{ log=$log; elapsedSec=200.0; idleSec=200.0; offset=(Get-Item $log).Length })
    $c = Run-Guard $d
    if (-not (Proc-Alive $dm.Id)) { Pass "rule(f) idle>150s killed" } else { Fail "rule(f) idle>150s killed" "still alive" }
} catch { Fail "rule(f) idle>150s killed" $_.Exception.Message }

# ---------------------------------------------------------------- 9. idle with live child not killed before 420s
try {
    $d = New-TestDir; $dm = Start-DummyWithChild; $log = New-Log $d "w9" ("working`n[Tokens] upload: 100 download: 10 cache_read: 90 cache_write: 0`n")
    $key = "w9|" + $dm.Id
    Register $d (Entry "w9" $dm.Id $log (Creation $dm) @{ testDummy=$true })
    Seed-State $d $key (New-BaseState "w9" $dm.Id (Creation $dm) @{ log=$log; elapsedSec=200.0; idleSec=200.0; offset=(Get-Item $log).Length })
    $c = Run-Guard $d
    if (Proc-Alive $dm.Id) { Pass "idle+live-child not killed at 200s" } else { Fail "idle+live-child not killed at 200s" "was killed" }
} catch { Fail "idle+live-child not killed at 200s" $_.Exception.Message }

# ---------------------------------------------------------------- 10. simulated 10h gap
try {
    $d = New-TestDir; $dm = Start-Dummy; $log = New-Log $d "w10" ("working`n[Tokens] upload: 100 download: 10 cache_read: 90 cache_write: 0`n")
    $key = "w10|" + $dm.Id
    Register $d (Entry "w10" $dm.Id $log (Creation $dm) @{ testDummy=$true })
    Seed-State $d $key (New-BaseState "w10" $dm.Id (Creation $dm) @{ log=$log; elapsedSec=5.0; idleSec=5.0; lastPassUtc=((Get-Date).AddHours(-10).ToUniversalTime().ToString("o")); offset=(Get-Item $log).Length })
    $c = Run-Guard $d
    $gl = GuardLog $d
    if ((Proc-Alive $dm.Id) -and ($gl -match "gap")) { Pass "10h pass gap -> no false MaxMinutes/idle (+gap logged)" } else { Fail "10h pass gap -> no false MaxMinutes/idle (+gap logged)" ("alive=" + (Proc-Alive $dm.Id) + " gapLog=" + ($gl -match "gap")) }
} catch { Fail "10h pass gap -> no false MaxMinutes/idle (+gap logged)" $_.Exception.Message }

# ---------------------------------------------------------------- 11. partial last line not parsed
try {
    $d = New-TestDir; $dm = Start-Dummy
    $p = Join-Path $d "w11.log"
    [System.IO.File]::WriteAllText($p, "Holding.`nHolding.", $Utf8)
    Register $d (Entry "w11" $dm.Id $p (Creation $dm) @{ testDummy=$true })
    $c1 = Run-Guard $d
    $aliveAfter1 = Proc-Alive $dm.Id
    [System.IO.File]::AppendAllText($p, "`n", $Utf8)
    $c2 = Run-Guard $d
    $aliveAfter2 = Proc-Alive $dm.Id
    if ($aliveAfter1 -and (-not $aliveAfter2)) { Pass "partial last line ignored (then fires when complete)" } else { Fail "partial last line ignored (then fires when complete)" ("after1=" + $aliveAfter1 + " after2=" + $aliveAfter2) }
} catch { Fail "partial last line ignored (then fires when complete)" $_.Exception.Message }

# ---------------------------------------------------------------- 12. truncated log resets without crash
try {
    $d = New-TestDir; $dm = Start-Dummy; $log = New-Log $d "w12" ("working`n[Tokens] upload: 100 download: 10 cache_read: 90 cache_write: 0`n")
    $key = "w12|" + $dm.Id
    Register $d (Entry "w12" $dm.Id $log (Creation $dm) @{ testDummy=$true })
    Seed-State $d $key (New-BaseState "w12" $dm.Id (Creation $dm) @{ log=$log; offset=999999; elapsedSec=10.0 })
    $c = Run-Guard $d
    if (($c -eq 0) -and (Proc-Alive $dm.Id)) { Pass "truncated log resets without crash" } else { Fail "truncated log resets without crash" ("code=" + $c) }
} catch { Fail "truncated log resets without crash" $_.Exception.Message }

# ---------------------------------------------------------------- 13. pid reuse / wrong creation time not killed
try {
    $d = New-TestDir; $dm = Start-Dummy; $log = New-Log $d "w13" ("Holding.`nHolding.`n[Tokens] upload: 100 download: 10 cache_read: 90 cache_write: 0`n")
    Register $d (Entry "w13" $dm.Id $log "2000-01-01T00:00:00.0000000Z" @{ testDummy=$true })
    $c = Run-Guard $d
    $gl = GuardLog $d
    if ((Proc-Alive $dm.Id) -and ($gl -match "skip kill \(identity\)")) { Pass "wrong creation time (pid reuse) not killed" } else { Fail "wrong creation time (pid reuse) not killed" ("alive=" + (Proc-Alive $dm.Id)) }
} catch { Fail "wrong creation time (pid reuse) not killed" $_.Exception.Message }

# ---------------------------------------------------------------- 14. registered pid that is not jcode not killed
try {
    $d = New-TestDir; $dm = Start-Dummy; $log = New-Log $d "w14" ("Holding.`nHolding.`n")
    Register $d (Entry "w14" $dm.Id $log (Creation $dm) $null)
    $c = Run-Guard $d
    if (Proc-Alive $dm.Id) { Pass "registered non-jcode pid not killed" } else { Fail "registered non-jcode pid not killed" "was killed" }
} catch { Fail "registered non-jcode pid not killed" $_.Exception.Message }

# ---------------------------------------------------------------- 15. unregistered process never touched
try {
    $d = New-TestDir; $dm = Start-Dummy
    $c = Run-Guard $d
    if (Proc-Alive $dm.Id) { Pass "unregistered process not touched" } else { Fail "unregistered process not touched" "was killed" }
} catch { Fail "unregistered process not touched" $_.Exception.Message }

# ---------------------------------------------------------------- 16. guard survives a bad registry line
try {
    $d = New-TestDir; $dm = Start-Dummy; $log = New-Log $d "w16" ("working`n[Tokens] upload: 100 download: 10 cache_read: 90 cache_write: 0`n")
    Register $d (Entry "w16" $dm.Id $log (Creation $dm) @{ testDummy=$true })
    [System.IO.File]::AppendAllText((Join-Path $d "workers.json"), "{ this is not json`n", $Utf8)
    $c = Run-Guard $d
    $gl = GuardLog $d
    if (($c -eq 0) -and (Proc-Alive $dm.Id) -and ($gl -match "unparsable")) { Pass "survives bad registry line" } else { Fail "survives bad registry line" ("code=" + $c + " alive=" + (Proc-Alive $dm.Id)) }
} catch { Fail "survives bad registry line" $_.Exception.Message }

# ---------------------------------------------------------------- 17. healthy varied worker not killed
try {
    $d = New-TestDir; $dm = Start-Dummy
    $log = New-Log $d "w17" ("Reading the work order`n[read] docs/ORDER.md`nstep one done`n[Tokens] upload: 1000 download: 50 cache_read: 900 cache_write: 0`nrunning the checks`nall cases pass so far`n[Tokens] upload: 1200 download: 40 cache_read: 1150 cache_write: 0`nclosing out the task`n")
    $key = "w17|" + $dm.Id
    Register $d (Entry "w17" $dm.Id $log (Creation $dm) @{ testDummy=$true })
    Seed-State $d $key (New-BaseState "w17" $dm.Id (Creation $dm) @{ log=$log; elapsedSec=30.0 })
    $c = Run-Guard $d
    if (Proc-Alive $dm.Id) { Pass "healthy varied worker not killed" } else { Fail "healthy varied worker not killed" "was killed" }
} catch { Fail "healthy varied worker not killed" $_.Exception.Message }

# ---------------------------------------------------------------- 18. missing token lines -> log-size backstop
try {
    $d = New-TestDir; $dm = Start-Dummy
    $big = ("noise line that is not a token line - " + ("x" * 60) + "`n")
    $body = ""
    for ($i=0; $i -lt 60; $i++) { $body = $body + $big }
    $log = New-Log $d "w18" $body
    Register $d (Entry "w18" $dm.Id $log (Creation $dm) @{ testDummy=$true; maxLogMb=0.001 })
    $c = Run-Guard $d
    if (-not (Proc-Alive $dm.Id)) { Pass "missing token lines -> log-size backstop killed" } else { Fail "missing token lines -> log-size backstop killed" "still alive" }
} catch { Fail "missing token lines -> log-size backstop killed" $_.Exception.Message }

# ---------------------------------------------------------------- 19. guard balance floor kills all
try {
    $d = New-TestDir; $dm = Start-Dummy; $log = New-Log $d "w19" ("working`n[Tokens] upload: 100 download: 10 cache_read: 90 cache_write: 0`n")
    Register $d (Entry "w19" $dm.Id $log (Creation $dm) @{ testDummy=$true })
    $old = $env:JCODE_WORKER_BALANCE_USD
    $env:JCODE_WORKER_BALANCE_USD = "0.10"
    $c = Run-Guard $d
    $env:JCODE_WORKER_BALANCE_USD = $old
    if (-not (Proc-Alive $dm.Id)) { Pass "guard balance<0.30 kills all registered" } else { Fail "guard balance<0.30 kills all registered" "still alive" }
} catch { Fail "guard balance<0.30 kills all registered" $_.Exception.Message }

# ---------------------------------------------------------------- 20. spawn-worker refuses model with pro
try {
    $d = New-TestDir
    $r = Spawn-DryRun $d "probe" @("-Model","deepseek-v4-pro")
    if (($r.code -eq 2) -and ($r.out -match "REFUSE")) { Pass "spawn refuses model containing 'pro'" } else { Fail "spawn refuses model containing 'pro'" ("code=" + $r.code + " out=" + $r.out) }
} catch { Fail "spawn refuses model containing 'pro'" $_.Exception.Message }

# ---------------------------------------------------------------- 21. spawn concurrency cap
try {
    $d = New-TestDir
    $dms = @(); for ($i=0; $i -lt 3; $i++) { $dms += Start-Dummy }
    $i = 0
    foreach ($dm in $dms) {
        $log = New-Log $d ("c" + $i) ("working`n")
        Register $d (Entry ("conc" + $i) $dm.Id $log (Creation $dm) @{ testDummy=$true })
        $i++
    }
    $r = Spawn-DryRun $d "newone" $null
    if (($r.code -eq 2) -and ($r.out -match "concurrency")) { Pass "spawn concurrency cap refuses" } else { Fail "spawn concurrency cap refuses" ("code=" + $r.code + " out=" + $r.out) }
} catch { Fail "spawn concurrency cap refuses" $_.Exception.Message }

# ---------------------------------------------------------------- 22. spawn duplicate cap
try {
    $d = New-TestDir; $dm = Start-Dummy; $log = New-Log $d "dup" ("working`n")
    Register $d (Entry "dupname" $dm.Id $log (Creation $dm) @{ testDummy=$true })
    $r = Spawn-DryRun $d "dupname" $null
    if (($r.code -eq 2) -and ($r.out -match "duplicate")) { Pass "spawn duplicate cap refuses" } else { Fail "spawn duplicate cap refuses" ("code=" + $r.code + " out=" + $r.out) }
} catch { Fail "spawn duplicate cap refuses" $_.Exception.Message }

# ---------------------------------------------------------------- 23. spawn daily cap
try {
    $d = New-TestDir
    $today = (Get-Date).ToString("yyyy-MM-dd")
    $line = (@{ date=$today; name="old"; turns=1; upload=1; download=1; cache_read=0; estUsd=2.0; endedBy="finished" } | ConvertTo-Json -Compress)
    [System.IO.File]::AppendAllText((Join-Path $d "token-ledger.jsonl"), ($line + "`r`n"), $Utf8)
    $r = Spawn-DryRun $d "daily" $null
    if (($r.code -eq 2) -and ($r.out -match "daily cap")) { Pass "spawn daily cap refuses" } else { Fail "spawn daily cap refuses" ("code=" + $r.code + " out=" + $r.out) }
} catch { Fail "spawn daily cap refuses" $_.Exception.Message }

# ---------------------------------------------------------------- 24. spawn balance floor
try {
    $d = New-TestDir
    $old = $env:JCODE_WORKER_BALANCE_USD
    $env:JCODE_WORKER_BALANCE_USD = "0.50"
    $r = Spawn-DryRun $d "lowbal" $null
    $env:JCODE_WORKER_BALANCE_USD = $old
    if (($r.code -eq 2) -and ($r.out -match "balance floor")) { Pass "spawn balance floor refuses" } else { Fail "spawn balance floor refuses" ("code=" + $r.code + " out=" + $r.out) }
} catch { Fail "spawn balance floor refuses" $_.Exception.Message }

# ---------------------------------------------------------------- 25. spawn ok dry-run passes gates
try {
    $d = New-TestDir
    $r = Spawn-DryRun $d "healthy" $null
    if (($r.code -eq 0) -and ($r.out -match "OK dry-run")) { Pass "spawn passes gates in clean environment" } else { Fail "spawn passes gates in clean environment" ("code=" + $r.code + " out=" + $r.out) }
} catch { Fail "spawn passes gates in clean environment" $_.Exception.Message }

# ---------------------------------------------------------------- 26. stub receives the exact jcode argv
try {
    $d = New-TestDir
    $stub = New-Stub $d "stubA" 4
    $msg = 'hi "there" it''s me'
    $r = Spawn-Real $d "stubby" $msg $stub $null
    $sp = Out-Pid $r.out
    if ($sp -gt 0) { try { [void]$script:Dummies.Add((Get-Process -Id $sp -ErrorAction Stop)) } catch { } }
    Start-Sleep -Milliseconds 1500
    $af = Join-Path $d "stubA.args.txt"
    $raw = ""
    if (Test-Path $af) { $raw = ([System.IO.File]::ReadAllText($af)).Trim() }
    $got = Split-CmdLine $raw
    $want = @("run","-p","deepseek","-m","deepseek-flash","-C",$RepoRoot,$msg)
    $ok = ($r.code -eq 0) -and ($got.Count -eq $want.Count)
    if ($ok) { for ($i=0; $i -lt $want.Count; $i++) { if ($got[$i] -ne $want[$i]) { $ok = $false } } }
    if ($ok) { Pass "stub argv: message one arg (spaces + quotes + apostrophe)" } else { Fail "stub argv: message one arg (spaces + quotes + apostrophe)" ("code=" + $r.code + " wantN=" + $want.Count + " gotN=" + $got.Count + " raw=[" + $raw + "]") }
} catch { Fail "stub argv: message one arg (spaces + quotes + apostrophe)" $_.Exception.Message }

# ---------------------------------------------------------------- 27. live registry entry has creationTime + stub pid
try {
    $d = New-TestDir
    $stub = New-Stub $d "stubB" 6
    $r = Spawn-Real $d "reg" "hi" $stub $null
    $sp = Out-Pid $r.out
    if ($sp -gt 0) { try { [void]$script:Dummies.Add((Get-Process -Id $sp -ErrorAction Stop)) } catch { } }
    Start-Sleep -Milliseconds 500
    $reg = $null
    $rp = Join-Path $d "workers.json"
    if (Test-Path $rp) {
        foreach ($l in [System.IO.File]::ReadAllLines($rp)) {
            if ($l.Trim() -eq "") { continue }
            try { $e = $l | ConvertFrom-Json; if ([string]$e.name -eq "reg") { $reg = $e } } catch { }
        }
    }
    $ok = ($reg -ne $null) -and ([string]$reg.creationTime -ne "") -and ([int]$reg.pid -eq $sp) -and (Proc-Alive $sp)
    if ($ok) { Pass "registry: live worker has non-empty creationTime + stub pid" } else { Fail "registry: live worker has non-empty creationTime + stub pid" ("code=" + $r.code + " pid=" + $sp + " reg=" + ($reg | ConvertTo-Json -Compress)) }
} catch { Fail "registry: live worker has non-empty creationTime + stub pid" $_.Exception.Message }

# ---------------------------------------------------------------- 28. instant-exit stub refused and not registered
try {
    $d = New-TestDir
    $stub = New-Stub $d "stubC" 0 -Immediate
    $r = Spawn-Real $d "dead" "hi" $stub $null
    $registered = $false
    $rp = Join-Path $d "workers.json"
    if (Test-Path $rp) {
        foreach ($l in [System.IO.File]::ReadAllLines($rp)) {
            if ($l.Trim() -eq "") { continue }
            try { $e = $l | ConvertFrom-Json; if ([string]$e.name -eq "dead") { $registered = $true } } catch { }
        }
    }
    if (($r.code -eq 2) -and ($r.out -match "REFUSE") -and ($r.out -match "exited immediately") -and (-not $registered)) { Pass "instant-exit stub refused and not registered" } else { Fail "instant-exit stub refused and not registered" ("code=" + $r.code + " registered=" + $registered + " out=" + $r.out) }
} catch { Fail "instant-exit stub refused and not registered" $_.Exception.Message }

# ---------------------------------------------------------------- 29. -Model containing 'pro' refused (stub exe)
try {
    $d = New-TestDir
    $stub = New-Stub $d "stubD" 4
    $r = Spawn-Real $d "promodel" "hi" $stub @("-Model","deepseek-v4-pro")
    if (($r.code -eq 2) -and ($r.out -match "REFUSE") -and ($r.out -match "pro")) { Pass "spawn refuses -Model containing 'pro' (stub exe)" } else { Fail "spawn refuses -Model containing 'pro' (stub exe)" ("code=" + $r.code + " out=" + $r.out) }
} catch { Fail "spawn refuses -Model containing 'pro' (stub exe)" $_.Exception.Message }

# ---------------------------------------------------------------- 30. parser check all three scripts
try {
    $errs = 0
    foreach ($f in @($Spawn, $Guard, (Join-Path $Ops "worker-guard-check.ps1"))) {
        $tok = $null; $err = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$tok, [ref]$err)
        $errs = $errs + @($err).Count
    }
    if ($errs -eq 0) { Pass "parser: 0 errors on all three scripts" } else { Fail "parser: 0 errors on all three scripts" ($errs.ToString() + " errors") }
} catch { Fail "parser: 0 errors on all three scripts" $_.Exception.Message }

# ---------------------------------------------------------------- 31. finished-before-pass drains log into ledger
try {
    $d = New-TestDir
    $dead = Start-Process -FilePath "ping.exe" -ArgumentList "-n","1","127.0.0.1" -WindowStyle Hidden -PassThru
    [void]$script:Dummies.Add($dead)
    $dp = $dead.Id
    try { [void]$dead.WaitForExit(5000) } catch { }
    Start-Sleep -Milliseconds 300
    $log = New-Log $d "w20" ("[Tokens] upload: 100 download: 20 cache_read: 90 cache_write: 0`n[Tokens] upload: 200 download: 30 cache_read: 150 cache_write: 10`n")
    $key = "w20|" + $dp
    Register $d (Entry "w20" $dp $log "" @{ testDummy=$true })
    Seed-State $d $key (New-BaseState "w20" $dp "" @{ log=$log; offset=0 })
    $c = Run-Guard $d
    $line = $null
    $led = Join-Path $d "token-ledger.jsonl"
    if (Test-Path $led) {
        foreach ($l in [System.IO.File]::ReadAllLines($led)) {
            if ($l.Trim() -eq "") { continue }
            try { $line = $l | ConvertFrom-Json } catch { }
        }
    }
    $ok = ($line -ne $null) -and ([int]$line.turns -eq 2) -and ([long]$line.upload -eq 300) -and ([long]$line.download -eq 50) -and ([long]$line.cache_read -eq 240)
    if ($ok) { Pass "finished-before-pass ledger turns=2 + summed tokens" } else { Fail "finished-before-pass ledger turns=2 + summed tokens" ("alive=" + (Proc-Alive $dp) + " line=" + ($line | ConvertTo-Json -Compress)) }
} catch { Fail "finished-before-pass ledger turns=2 + summed tokens" $_.Exception.Message }

# ---------------------------------------------------------------- cleanup
foreach ($dm in $script:Dummies) {
    try { if (Proc-Alive $dm.Id) { Stop-Process -Id $dm.Id -Force -ErrorAction SilentlyContinue } } catch { }
}
try { Get-Process -Name "ping" -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -gt (Get-Date).AddMinutes(-10) } | Stop-Process -Force -ErrorAction SilentlyContinue } catch { }

Write-Output ("=== cases passed: " + $script:Passed + " / " + ($script:Passed + $script:Failed) + " (failed: " + $script:Failed + ") ===")
if ($script:Failed -gt 0) { exit 1 }
exit 0
