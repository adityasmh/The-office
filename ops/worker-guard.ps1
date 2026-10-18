# worker-guard.ps1 - long running, hidden, single instance.
# Watches registered jcode workers, kills loops/overruns, writes a token ledger.
# Windows PowerShell 5.1 compatible: no ??, no ternary, no -AsHashtable.
param(
    [switch]$Once,
    [string]$TestRoot = "",
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------- paths
if ($TestRoot -ne "") {
    $Root = $TestRoot
} else {
    $Repo = Split-Path -Parent $PSScriptRoot
    $Root = Join-Path $Repo "logs"
}
if (-not (Test-Path $Root)) { New-Item -ItemType Directory -Path $Root -Force | Out-Null }

$RegistryPath = Join-Path $Root "workers.json"
$StatePath    = Join-Path $Root "worker-guard-state.json"
$GuardLog     = Join-Path $Root "worker-guard.log"
$LedgerPath   = Join-Path $Root "token-ledger.jsonl"
$PidPath      = Join-Path $Root "worker-guard.pid"

# Price constants (peak DeepSeek flash, conservative).
$PRICE_CACHE_HIT  = 0.014
$PRICE_CACHE_MISS = 0.44
$PRICE_OUTPUT     = 1.32
$M = 1000000.0

$BALANCE_URL = "http://localhost:8787/company/budget/real"
$BALANCE_FLOOR_GUARD = 0.30

$SCRIPT:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# ---------------------------------------------------------------- helpers
function Append-Text([string]$path, [string]$text) {
    [System.IO.File]::AppendAllText($path, $text, $SCRIPT:Utf8NoBom)
}

function Append-GuardLog([string]$line) {
    if ($Once -and $Quiet) { return }
    try {
        if ((Test-Path $GuardLog) -and ((Get-Item $GuardLog).Length -gt 1048576)) {
            $all = [System.IO.File]::ReadAllLines($GuardLog)
            $keep = $all
            if ($all.Length -gt 500) { $keep = $all[($all.Length - 500)..($all.Length - 1)] }
            [System.IO.File]::WriteAllLines($GuardLog, $keep, $SCRIPT:Utf8NoBom)
        }
        $ts = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
        Append-Text $GuardLog ("[" + $ts + "] " + $line + "`r`n")
    } catch { }
}

function Write-Ledger([string]$name, $st, [string]$endedBy) {
    try {
        $date = (Get-Date).ToString("yyyy-MM-dd")
        $obj = [ordered]@{
            date       = $date
            name       = $name
            turns      = [int]$st.turns
            upload     = [long]$st.upload
            download   = [long]$st.download
            cache_read = [long]$st.cache_read
            estUsd     = [math]::Round([double]$st.estUsd, 4)
            endedBy    = $endedBy
        }
        $json = ($obj | ConvertTo-Json -Compress)
        Append-Text $LedgerPath ($json + "`r`n")
    } catch { }
}

function Get-ProcStart([int]$procId) {
    try {
        $p = Get-Process -Id $procId -ErrorAction Stop
        return $p.StartTime.ToUniversalTime()
    } catch { return $null }
}

function Get-CreationFromEntry($entry) {
    if ($entry.creationTime -eq $null) { return $null }
    try { return [datetime]::Parse($entry.creationTime, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime() }
    catch { return $null }
}

function Test-Protected([int]$procId) {
    if ($procId -eq $PID) { return $true }
    try {
        $me = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $PID) -ErrorAction Stop
        if ($me -ne $null -and $me.ParentProcessId -eq $procId) { return $true }
    } catch { }
    return $false
}

function New-WorkerState($entry) {
    $st = @{}
    $st.name = [string]$entry.name
    $st.pid = [int]$entry.pid
    $st.creationTime = [string]$entry.creationTime
    $st.maxMinutes = 15.0
    if ($entry.maxMinutes -ne $null) { $st.maxMinutes = [double]$entry.maxMinutes }
    $st.maxUsd = 0.30
    if ($entry.maxUsd -ne $null) { $st.maxUsd = [double]$entry.maxUsd }
    $st.maxLogMb = 2.0
    if ($entry.maxLogMb -ne $null) { $st.maxLogMb = [double]$entry.maxLogMb }
    $st.testDummy = $false
    if ($entry.testDummy -ne $null) { $st.testDummy = [bool]$entry.testDummy }
    $st.offset = [long]0
    $st.turns = 0
    $st.upload = [long]0
    $st.download = [long]0
    $st.cache_read = [long]0
    $st.cache_write = [long]0
    $st.estUsd = 0.0
    $st.elapsedSec = 0.0
    $st.idleSec = 0.0
    $st.lastPassUtc = $null
    $st.firstFinalElapsed = $null
    $st.logGrowth = [long]0
    $st.tokenSeen = $false
    $st.warned70 = $false
    $st.ledgerWritten = $false
    $st.plainLines = @()
    $st.thoughtChunks = @()
    $st.curThought = ""
    $st.curThoughtLines = 0
    $st.log = [string]$entry.log
    return $st
}

function Convert-StateObj($o) {
    $st = @{}
    $st.name = [string]$o.name
    $st.pid = [int]$o.pid
    $st.creationTime = [string]$o.creationTime
    $st.maxMinutes = [double]$o.maxMinutes
    $st.maxUsd = [double]$o.maxUsd
    $st.maxLogMb = [double]$o.maxLogMb
    $st.testDummy = [bool]$o.testDummy
    $st.offset = [long]$o.offset
    $st.turns = [int]$o.turns
    $st.upload = [long]$o.upload
    $st.download = [long]$o.download
    $st.cache_read = [long]$o.cache_read
    $st.cache_write = [long]$o.cache_write
    $st.estUsd = [double]$o.estUsd
    $st.elapsedSec = [double]$o.elapsedSec
    $st.idleSec = [double]$o.idleSec
    $st.lastPassUtc = $o.lastPassUtc
    $st.firstFinalElapsed = $o.firstFinalElapsed
    $st.logGrowth = [long]$o.logGrowth
    $st.tokenSeen = [bool]$o.tokenSeen
    $st.warned70 = [bool]$o.warned70
    $st.ledgerWritten = [bool]$o.ledgerWritten
    $st.plainLines = @()
    if ($o.plainLines -ne $null) { $st.plainLines = @($o.plainLines) }
    $st.thoughtChunks = @()
    if ($o.thoughtChunks -ne $null) { $st.thoughtChunks = @($o.thoughtChunks) }
    $st.curThought = ""
    if ($o.curThought -ne $null) { $st.curThought = [string]$o.curThought }
    $st.curThoughtLines = 0
    if ($o.curThoughtLines -ne $null) { $st.curThoughtLines = [int]$o.curThoughtLines }
    $st.log = [string]$o.log
    return $st
}

function Save-State($state) {
    try {
        $json = ($state | ConvertTo-Json -Depth 8 -Compress)
        [System.IO.File]::WriteAllText($StatePath, $json, $SCRIPT:Utf8NoBom)
    } catch { Append-GuardLog ("state save failed: " + $_.Exception.Message) }
}

function Load-Registry {
    $entries = @()
    if (-not (Test-Path $RegistryPath)) { return $entries }
    try {
        $lines = [System.IO.File]::ReadAllLines($RegistryPath)
    } catch { return $entries }
    foreach ($l in $lines) {
        if ($l -eq $null -or $l.Trim() -eq "") { continue }
        try {
            $e = $l | ConvertFrom-Json
            if ($e.name -ne $null -and $e.pid -ne $null) { $entries += $e }
        } catch {
            Append-GuardLog ("registry line unparsable (skipped): " + $_.Exception.Message)
        }
    }
    return $entries
}

function Read-Appended([string]$path, [long]$offset) {
    $res = @{ lines = @(); newOffset = $offset; truncated = $false; missing = $false; bytes = 0 }
    if (-not (Test-Path $path)) { $res.missing = $true; return $res }
    $fs = $null
    try {
        $fs = New-Object System.IO.FileStream($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    } catch { $res.missing = $true; return $res }
    try {
        $len = $fs.Length
        if ($len -lt $offset) { $offset = 0; $res.truncated = $true }
        $fs.Seek($offset, [System.IO.SeekOrigin]::Begin) | Out-Null
        $remaining = $len - $offset
        if ($remaining -le 0) { $res.newOffset = $offset; return $res }
        $cap = $remaining
        if ($cap -gt 5242880) { $cap = 5242880 }
        $buf = New-Object byte[] $cap
        $read = $fs.Read($buf, 0, $cap)
        $lastNL = -1
        for ($i = $read - 1; $i -ge 0; $i--) { if ($buf[$i] -eq 10) { $lastNL = $i; break } }
        if ($lastNL -lt 0) { $res.newOffset = $offset; return $res }
        $text = [System.Text.Encoding]::UTF8.GetString($buf, 0, $lastNL + 1)
        $res.newOffset = $offset + $lastNL + 1
        $res.bytes = $lastNL + 1
        $raw = $text -split "`n"
        $list = New-Object System.Collections.ArrayList
        foreach ($ln in $raw) {
            if ($ln -eq "") { continue }
            $t = $ln
            if ($t.EndsWith("`r")) { $t = $t.Substring(0, $t.Length - 1) }
            [void]$list.Add($t)
        }
        $res.lines = $list.ToArray()
    } catch {
        Append-GuardLog ("log read failed: " + $_.Exception.Message)
    } finally { if ($fs -ne $null) { $fs.Close() } }
    return $res
}

function Test-IsFragment([string]$line) {
    return ($line -match '^[\uD83D][\uDCAD]')
}

function Strip-Fragment([string]$line) {
    return ($line -replace '^[\uD83D][\uDCAD] ?', '')
}

function Test-IsPlainLine([string]$line) {
    if ($line -eq $null) { return $false }
    $t = $line.Trim()
    if ($t -eq "") { return $false }
    if (Test-IsFragment $line) { return $false }
    if ($t.StartsWith("[")) { return $false }
    if ($t.StartsWith("->")) { return $false }
    if ($t.StartsWith([char]0x2192)) { return $false }
    if ($t.StartsWith("$")) { return $false }
    if ($t.StartsWith("---")) { return $false }
    if ($t.StartsWith("dY'")) { return $false }
    return $true
}

function Add-ThoughtChunk($st, [string]$text, [int]$nlines) {
    if ($text.Trim() -eq "") { return }
    $st.thoughtChunks += @{ t = $text; n = $nlines }
    $total = 0
    for ($i = $st.thoughtChunks.Count - 1; $i -ge 0; $i--) {
        $total += [int]$st.thoughtChunks[$i].n
        if ($total -gt 200) { break }
    }
    if ($total -gt 200) {
        $keep = New-Object System.Collections.ArrayList
        $acc = 0
        for ($i = $st.thoughtChunks.Count - 1; $i -ge 0; $i--) {
            [void]$keep.Insert(0, $st.thoughtChunks[$i])
            $acc += [int]$st.thoughtChunks[$i].n
            if ($acc -ge 200) { break }
        }
        $st.thoughtChunks = $keep.ToArray()
    }
}

function Process-Line($st, [string]$line, [double]$elapsed) {
    if ($line -eq $null) { return }
    if (Test-IsFragment $line) {
        $st.curThought = "" + $st.curThought + (Strip-Fragment $line)
        $st.curThoughtLines = $st.curThoughtLines + 1
        return
    }
    if ($line.Trim() -eq "") { return }
    # flush current thought on any non-fragment non-empty line
    if ($st.curThoughtLines -gt 0) {
        Add-ThoughtChunk $st $st.curThought $st.curThoughtLines
        $st.curThought = ""
        $st.curThoughtLines = 0
    }
    if ($line -match '\[Tokens\]') {
        $m = [regex]::Match($line, 'upload:\s*(\d+)\s+download:\s*(\d+)\s+cache_read:\s*(\d+)\s+cache_write:\s*(\d+)')
        if ($m.Success) {
            $st.turns = $st.turns + 1
            $st.upload = $st.upload + [long]$m.Groups[1].Value
            $st.download = $st.download + [long]$m.Groups[2].Value
            $st.cache_read = $st.cache_read + [long]$m.Groups[3].Value
            $st.cache_write = $st.cache_write + [long]$m.Groups[4].Value
            $st.tokenSeen = $true
        }
        return
    }
    if ($line -match '(?i)final report') {
        if ($st.firstFinalElapsed -eq $null) { $st.firstFinalElapsed = $elapsed }
    }
    if (Test-IsPlainLine $line) {
        $t = $line.Trim()
        $st.plainLines += $t
        if ($st.plainLines.Count -gt 80) {
            $st.plainLines = @($st.plainLines[($st.plainLines.Count - 80)..($st.plainLines.Count - 1)])
        }
    }
}

function Test-WordRule($st) {
    $exact = 0
    foreach ($p in $st.plainLines) {
        if ($p -match '(?i)^(holding\.?|continue holding\.?)$') { $exact = $exact + 1 }
    }
    if ($exact -ge 2) { return ("holding-word plain x" + $exact) }
    $text = ""
    foreach ($c in $st.thoughtChunks) { $text = $text + " " + [string]$c.t }
    $pat = '(?i)(keep\s+holding|continue\s+holding|i''ll\s+hold|respond\s+"?holding)'
    $n = ([regex]::Matches($text, $pat)).Count
    if ($n -ge 3) { return ("holding-phrase thought x" + $n) }
    return $null
}

function Test-RepeatRule($st) {
    if ($st.plainLines.Count -lt 6) { return $null }
    $counts = @{}
    foreach ($p in $st.plainLines) {
        if ($counts.ContainsKey($p)) { $counts[$p] = $counts[$p] + 1 } else { $counts[$p] = 1 }
    }
    foreach ($k in $counts.Keys) {
        # A bare file path is the tool echoing which file it read; reading the same file six
        # times is normal work, not a loop (it killed a spec writer on 2026-10-06).
        if ($k -match '^[A-Za-z0-9_\-\\/\.: ]+\.(ts|tsx|js|mjs|md|json|ps1|html|css|yml|yaml|txt|bat)$') { continue }
        if ($counts[$k] -ge 6) { return ("repeat-line x" + $counts[$k]) }
    }
    return $null
}

function Get-LiveChildren([int]$procId) {
    try {
        $c = Get-CimInstance Win32_Process -Filter ("ParentProcessId=" + $procId) -ErrorAction Stop
        if ($c -eq $null) { return 0 }
        # conhost.exe is the console-host helper every console process gets; it is
        # not real work, and counting it would disable the idle rule for jcode workers.
        $n = 0
        foreach ($ch in @($c)) { if ($ch.Name -ieq "conhost.exe") { continue }; $n = $n + 1 }
        return $n
    } catch { return 0 }
}

function Get-BalanceUsd {
    if ($env:JCODE_WORKER_BALANCE_USD -ne $null -and $env:JCODE_WORKER_BALANCE_USD -ne "") {
        try { return [double]$env:JCODE_WORKER_BALANCE_USD } catch { return $null }
    }
    try {
        $resp = Invoke-WebRequest -Uri $BALANCE_URL -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        $j = $resp.Content | ConvertFrom-Json
        $b = $j.providers.deepseek.balanceUsd
        if ($b -eq $null) { return $null }
        return [double]$b
    } catch { return $null }
}

function Estimate-Usd($st) {
    $miss = [double]$st.upload - [double]$st.cache_read
    if ($miss -lt 0) { $miss = 0 }
    $miss = $miss + [double]$st.cache_write
    if ($miss -lt 0) { $miss = 0 }
    $hit = [double]$st.cache_read
    if ($hit -lt 0) { $hit = 0 }
    $out = [double]$st.download
    if ($out -lt 0) { $out = 0 }
    return (($hit * $PRICE_CACHE_HIT) + ($miss * $PRICE_CACHE_MISS) + ($out * $PRICE_OUTPUT)) / $M
}

function Test-IdentityForKill($st, $proc) {
    if ($st.testDummy) {
        # test mode: only the creation time must match
        $want = Get-CreationFromEntry @{ creationTime = $st.creationTime }
        if ($want -ne $null) {
            $got = $proc.StartTime.ToUniversalTime()
            if ([math]::Abs(($got - $want).TotalSeconds) -gt 2) { return $false }
        }
        return $true
    }
    if ($proc.ProcessName -ne "jcode") { return $false }
    try {
        $ci = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $st.pid) -ErrorAction Stop
        if ($ci -eq $null) { return $false }
        $cmd = [string]$ci.CommandLine
        if ($cmd -notmatch ' run ') { return $false }
        $low = $cmd.ToLower()
        foreach ($bad in @("worker-guard.ps1", "router", "supervisor", "laya", "java", "kafka")) {
            if ($low.Contains($bad)) { return $false }
        }
    } catch { return $false }
    $want = Get-CreationFromEntry @{ creationTime = $st.creationTime }
    if ($want -ne $null) {
        $got = $proc.StartTime.ToUniversalTime()
        if ([math]::Abs(($got - $want).TotalSeconds) -gt 2) { return $false }
    }
    return $true
}

function Kill-Worker($st, [string]$reason) {
    $proc = $null
    try { $proc = Get-Process -Id $st.pid -ErrorAction Stop } catch { return $false }
    if (Test-Protected $st.pid) { Append-GuardLog ("skip kill (protected pid) " + $st.name + " pid=" + $st.pid); return $false }
    if (-not (Test-IdentityForKill $st $proc)) {
        Append-GuardLog ("skip kill (identity) " + $st.name + " pid=" + $st.pid)
        return $false
    }
    try { Stop-Process -Id $st.pid -Force -ErrorAction Stop } catch { }
    Start-Sleep -Milliseconds 300
    $gone = $false
    try { Get-Process -Id $st.pid -ErrorAction Stop | Out-Null } catch { $gone = $true }
    if (-not $gone) {
        try { Stop-Process -Id $st.pid -Force -ErrorAction Stop } catch { }
        Start-Sleep -Milliseconds 300
        try { Get-Process -Id $st.pid -ErrorAction Stop | Out-Null } catch { $gone = $true }
    }
    Append-GuardLog ("KILL " + $st.name + " pid=" + $st.pid + " reason=" + $reason + " gone=" + $gone)
    return $true
}

# ---------------------------------------------------------------- single instance
function Start-GuardMain {
$mutexName = "JcodeWorkerGuard"
if ($TestRoot -ne "") { $mutexName = "JcodeWorkerGuard_" + ([math]::Abs($TestRoot.GetHashCode())) }
$mutex = $null
if (-not $Once) {
    try {
        $mutex = New-Object System.Threading.Mutex($false, $mutexName)
        $owned = $mutex.WaitOne(0)
        if (-not $owned) { exit 0 }
    } catch {
        # abandoned mutex: proceed as owner
    }
    try { [System.IO.File]::WriteAllText($PidPath, ([string]$PID), $SCRIPT:Utf8NoBom) } catch { }
}

# ---------------------------------------------------------------- main
$script:LastStatusAt = [datetime]::MinValue
$script:LastBalanceAt = [datetime]::MinValue
$script:NoLiveSince = $null
$script:Known = @{}

Append-GuardLog ("guard start pid=" + $PID + " root=" + $Root)

$running = $true
while ($running) {
    try {
        Invoke-Pass
    } catch {
        Append-GuardLog ("pass exception: " + $_.Exception.Message)
    }

    # exit after 30 min with no live registered worker
    if ($script:NoLiveSince -ne $null) {
        if (((Get-Date) - $script:NoLiveSince).TotalMinutes -ge 30) { $running = $false }
    } else {
        $script:NoLiveSince = $null
    }

    if ($Once) { $running = $false; break }
    Start-Sleep -Seconds 15
}
}

function Invoke-Pass {
    $now = (Get-Date).ToUniversalTime()

    # load state
    $state = @{}
    if (Test-Path $StatePath) {
        try {
            $obj = [System.IO.File]::ReadAllText($StatePath) | ConvertFrom-Json
            foreach ($p in $obj.PSObject.Properties) {
                $state[$p.Name] = (Convert-StateObj $p.Value)
            }
        } catch { Append-GuardLog ("state load failed: " + $_.Exception.Message) }
    }
    $script:Known = $state

    $entries = Load-Registry
    $liveCount = 0
    $seenKeys = @{}

    foreach ($e in $entries) {
        $key = ([string]$e.name) + "|" + ([string]$e.pid)
        if ($seenKeys.ContainsKey($key)) { continue }
        $seenKeys[$key] = $true

        try {
            if (-not $state.ContainsKey($key)) { $state[$key] = New-WorkerState $e }
            $st = $state[$key]
            if ($st.plainLines -eq $null) { $st.plainLines = @() }
            if ($st.thoughtChunks -eq $null) { $st.thoughtChunks = @() }

            # elapsed/idle with capped per-pass delta
            $d = 0.0
            if ($st.lastPassUtc -ne $null -and $st.lastPassUtc -ne "") {
                try { $last = [datetime]::Parse([string]$st.lastPassUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime(); $d = ($now - $last).TotalSeconds } catch { $d = 0.0 }
            }
            if ($d -lt 0) { $d = 0.0 }
            $add = $d
            if ($d -gt 120) { $add = 15.0; Append-GuardLog ("gap " + $st.name + " pid=" + $st.pid + " d=" + [int]$d + "s -> +15s") }
            elseif ($d -gt 60) { $add = 60.0 }
            $st.elapsedSec = $st.elapsedSec + $add
            $st.idleSec = $st.idleSec + $add
            $st.lastPassUtc = $now.ToString("o")

            # alive?
            $proc = $null
            try { $proc = Get-Process -Id $st.pid -ErrorAction Stop } catch { $proc = $null }
            $alive = $false
            if ($proc -ne $null) {
                if ($st.testDummy) { $alive = $true }
                elseif ($proc.ProcessName -eq "jcode") { $alive = $true }
            }

            if (-not $alive) {
                if (-not $st.ledgerWritten) {
                    # worker may have finished before this pass: drain any log bytes
                    # not yet read so the ledger reflects its final token lines.
                    $rd = Read-Appended $st.log $st.offset
                    $st.offset = [long]$rd.newOffset
                    if ($rd.bytes -gt 0) {
                        $st.logGrowth = $st.logGrowth + [long]$rd.bytes
                        foreach ($ln in $rd.lines) { Process-Line $st $ln $st.elapsedSec }
                    }
                    $st.estUsd = Estimate-Usd $st
                    Write-Ledger $st.name $st $("finished")
                    Append-GuardLog ("finished " + $st.name + " pid=" + $st.pid + " turns=" + $st.turns + " estUsd=" + [math]::Round([double]$st.estUsd, 4))
                    $st.ledgerWritten = $true
                }
                $state[$key] = $st
                continue
            }

            $liveCount = $liveCount + 1

            # read new bytes
            $rd = Read-Appended $st.log $st.offset
            if ($rd.truncated) { Append-GuardLog ("log truncated/rotated " + $st.name + " pid=" + $st.pid + "; offset reset") }
            $st.offset = [long]$rd.newOffset
            if ($rd.bytes -gt 0) {
                $st.idleSec = 0.0
                $st.logGrowth = $st.logGrowth + [long]$rd.bytes
                foreach ($ln in $rd.lines) { Process-Line $st $ln $st.elapsedSec }
            }
            $st.estUsd = Estimate-Usd $st

            # 70% warning
            if (-not $st.warned70) {
                if ([double]$st.maxUsd -gt 0 -and ([double]$st.estUsd -ge (0.7 * [double]$st.maxUsd))) {
                    Append-GuardLog ("WARN " + $st.name + " pid=" + $st.pid + " estUsd=" + [math]::Round([double]$st.estUsd, 4) + " >= 70% of maxUsd=" + $st.maxUsd)
                    $st.warned70 = $true
                }
            }

            # kill rules
            $reason = $null
            $reason = Test-WordRule $st
            if ($reason -eq $null) { $reason = Test-RepeatRule $st }
            if ($reason -eq $null) {
                if ($st.firstFinalElapsed -ne $null) {
                    if (($st.elapsedSec - [double]$st.firstFinalElapsed) -ge 90) { $reason = "final-report>90s" }
                }
            }
            if ($reason -eq $null) {
                if ($st.elapsedSec -gt ([double]$st.maxMinutes * 60.0)) { $reason = "max-minutes" }
            }
            if ($reason -eq $null) {
                if ($st.estUsd -gt [double]$st.maxUsd) { $reason = "max-usd" }
            }
            if ($reason -eq $null) {
                $capBytes = [long]([double]$st.maxLogMb * 1048576.0)
                if ($st.logGrowth -gt $capBytes -and (-not $st.tokenSeen)) { $reason = "log-size-backstop" }
            }
            if ($reason -eq $null) {
                if ($st.elapsedSec -ge 60) {
                    $lim = 150.0
                    if ($st.idleSec -gt 90) {
                        $kids = Get-LiveChildren $st.pid
                        if ($kids -gt 0) { $lim = 420.0 }
                    }
                    if ($st.idleSec -ge $lim) { $reason = ("idle>" + [int]$lim + "s") }
                }
            }

            if ($reason -ne $null) {
                $killed = Kill-Worker $st $reason
                $st.estUsd = Estimate-Usd $st
                if ($killed) {
                    Write-Ledger $st.name $st ("killed:" + $reason)
                } else {
                    Write-Ledger $st.name $st ("finished")
                }
                $st.ledgerWritten = $true
            }

            $state[$key] = $st
        } catch {
            Append-GuardLog ("worker pass exception (" + ([string]$e.name) + "): " + $_.Exception.Message)
        }
    }

    # drop ledgered+dead entries so the guard can exit when idle
    if ($liveCount -eq 0) {
        if ($script:NoLiveSince -eq $null) { $script:NoLiveSince = Get-Date }
    } else {
        $script:NoLiveSince = $null
    }

    Save-State $state

    # 5-minute status per live worker
    if (((Get-Date) - $script:LastStatusAt).TotalMinutes -ge 5) {
        $script:LastStatusAt = Get-Date
        foreach ($k in $state.Keys) {
            $st = $state[$k]
            $p = $null
            try { $p = Get-Process -Id $st.pid -ErrorAction Stop } catch { $p = $null }
            $isLive = $false
            if ($p -ne $null) { if ($st.testDummy) { $isLive = $true } elseif ($p.ProcessName -eq "jcode") { $isLive = $true } }
            if ($isLive) {
                $reason = "ok"
                if ($st.estUsd -gt [double]$st.maxUsd) { $reason = "over-usd" }
                Append-GuardLog ("status " + $st.name + " pid=" + $st.pid + " turns=" + $st.turns + " estUsd=" + [math]::Round([double]$st.estUsd, 4) + " " + $reason)
            }
        }
        # report-only fleet journal section
        Write-JournalReport
    }

    # balance floor: kill all when low and readable
    if (((Get-Date) - $script:LastBalanceAt).TotalMinutes -ge 5) {
        $script:LastBalanceAt = Get-Date
        $bal = Get-BalanceUsd
        if ($bal -eq $null) {
            Append-GuardLog "balance unknown"
        } elseif ($bal -lt $BALANCE_FLOOR_GUARD) {
            Append-GuardLog ("balance low " + $bal + " < " + $BALANCE_FLOOR_GUARD + " -> kill all")
            foreach ($k in $state.Keys) {
                $st = $state[$k]
                if ($st.ledgerWritten) { continue }
                try { $p = Get-Process -Id $st.pid -ErrorAction Stop } catch { continue }
                $isLive = $false
                if ($st.testDummy) { $isLive = $true } elseif ($p.ProcessName -eq "jcode") { $isLive = $true }
                if ($isLive) {
                    if (Kill-Worker $st "balance-low") { Write-Ledger $st.name $st "killed:balance-low" }
                    else { Write-Ledger $st.name $st "finished" }
                    $st.ledgerWritten = $true
                }
            }
            $script:Known = $state
            Save-State $state
        }
    }
}

function Write-JournalReport {
    try {
        if ($TestRoot -ne "") { return }
        $dir = Join-Path $env:USERPROFILE ".jcode\sessions"
        if (-not (Test-Path $dir)) { return }
        $cut = (Get-Date).AddMinutes(-10)
        $files = Get-ChildItem -Path $dir -Filter "session_*.journal.jsonl" -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-10) }
        foreach ($f in $files) {
            # cheap: count turns + tokens in the last 10 min from the tail of the journal
            $turns = 0
            $tok = [long]0
            $edits = 0
            try {
                $fs = New-Object System.IO.FileStream($f.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
                $len = $fs.Length
                $start = 0
                if ($len -gt 524288) { $start = $len - 524288 }
                $fs.Seek($start, [System.IO.SeekOrigin]::Begin) | Out-Null
                $buf = New-Object byte[] ($len - $start)
                $rd = $fs.Read($buf, 0, $buf.Length)
                $fs.Close()
                $txt = [System.Text.Encoding]::UTF8.GetString($buf, 0, $rd)
                foreach ($jl in ($txt -split "`n")) {
                    if ($jl.Trim() -eq "") { continue }
                    if ($jl -notmatch 'token_usage') { continue }
                    try {
                        $o = $jl | ConvertFrom-Json
                        $u = $o.append_messages[0].token_usage
                        if ($u -ne $null) {
                            $turns = $turns + 1
                            $tok = $tok + [long]$u.input_tokens + [long]$u.output_tokens
                        }
                        foreach ($mm in $o.append_messages) {
                            foreach ($c in $mm.content) {
                                if ($c.type -eq "tool_use") {
                                    if ($c.name -in @("edit", "write", "apply_patch", "replace")) { $edits = $edits + 1 }
                                }
                            }
                        }
                    } catch { }
                }
            } catch { }
            $flag = ""
            if ($turns -gt 20 -and $edits -eq 0) { $flag = " FLAG:many-turns-no-edits" }
            Append-GuardLog ("terminal-report " + $f.Name + " turns10m=" + $turns + " tokens10m~" + $tok + $flag)
        }
    } catch { Append-GuardLog ("journal report failed: " + $_.Exception.Message) }
}

Start-GuardMain
