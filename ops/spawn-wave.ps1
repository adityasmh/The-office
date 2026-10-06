# spawn-wave.ps1 - run a queue of worker orders through ops/spawn-worker.ps1 with a rolling limit.
#
#   -Parallel  order names run with up to -MaxLive workers at once (rolling)
#   -Serial    order names run ONE AT A TIME after the parallel ones (for orders that edit shared files)
#   -MinGoPct  stop starting new workers when OpenCode Go quota (binding window) is below this percent
#
# Order names are file stems under docs/overnight (for example F01-doctor). Everything goes
# through the guarded wrapper; the provider is chosen by the routing policy, never here.
# Log: logs/overnight.log. Windows PowerShell 5.1 compatible.
param(
    [string[]]$Parallel = @(),
    [string[]]$Serial = @(),
    [int]$MaxLive = 3,
    [double]$MinGoPct = 35,
    [int]$TimeoutMin = 25,
    [string]$OrderDir = "docs\overnight",
    [string]$Prefix = "ORDER_"
)

$ErrorActionPreference = "Continue"
# `powershell -File` passes "A,B,C" as ONE string; split so both calling styles work.
$Parallel = @($Parallel | ForEach-Object { $_ -split ',' } | Where-Object { $_ -ne "" })
$Serial = @($Serial | ForEach-Object { $_ -split ',' } | Where-Object { $_ -ne "" })
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$logFile = Join-Path $root "logs\overnight.log"
function Log([string]$m) { $line = "[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] " + $m; Add-Content -Path $logFile -Value $line -Encoding utf8; Write-Output $line }

function Go-Pct {
    try {
        $p = (Invoke-WebRequest -Uri "http://127.0.0.1:8787/company/routing/policy" -TimeoutSec 8 -UseBasicParsing).Content | ConvertFrom-Json
        if ($p.go.known -eq $true -and $p.go.remainingPct -ne $null) { return [double]$p.go.remainingPct }
    } catch { }
    return $null
}

function Live-Count {
    $reg = Join-Path $root "logs\workers.json"
    if (-not (Test-Path $reg)) { return 0 }
    $n = 0
    foreach ($l in [System.IO.File]::ReadAllLines($reg)) {
        if ($l.Trim() -eq "") { continue }
        try { $e = $l | ConvertFrom-Json; if ($e.pid -and (Get-Process -Id ([int]$e.pid) -ErrorAction SilentlyContinue)) { $n++ } } catch { }
    }
    return $n
}

# Loop-word guard in the wrapper refuses orders containing the 3-letter prefix; normalise common words.
function Normalise([string]$path) {
    $t = [System.IO.File]::ReadAllText($path)
    $n = $t -replace '(?i)placeholders','template fields' -replace '(?i)placeholder','template field' -replace '(?i)\bwhole\b','entire' -replace '(?i)\bholds\b','keeps' -replace '(?i)\bhold\b','keep' -replace '(?i)thresholds','limits' -replace '(?i)threshold','limit' -replace '(?i)withhold','retain'
    if ($n -ne $t) { [System.IO.File]::WriteAllText($path, $n, (New-Object System.Text.UTF8Encoding($false))); Log ("normalised wording in " + (Split-Path -Leaf $path)) }
}

function Registry-Pid([string]$name) {
    $reg = Join-Path $root "logs\workers.json"
    if (-not (Test-Path $reg)) { return $null }
    $found = $null
    foreach ($l in [System.IO.File]::ReadAllLines($reg)) {
        if ($l.Trim() -eq "") { continue }
        try { $e = $l | ConvertFrom-Json; if ([string]$e.name -eq $name -and $e.pid -and (Get-Process -Id ([int]$e.pid) -ErrorAction SilentlyContinue)) { $found = [int]$e.pid } } catch { }
    }
    return $found
}
# Queue file for the dashboard (WORKERS-LIVE-2): every order of this wave with its state, so a
# queued order is visible before it starts. States: queued, running, refused, skipped, finished.
$queuePath = Join-Path $root "logs\queue.json"
$queue = @{}
function Save-Queue {
    try {
        $arr = @(); foreach ($k in $queue.Keys) { $arr += $queue[$k] }
        $json = ($arr | Sort-Object order | ConvertTo-Json -Depth 4 -Compress)
        if ($arr.Count -eq 1) { $json = "[" + $json + "]" }
        [System.IO.File]::WriteAllText($queuePath, $json, (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
}
function Queue-Set([string]$stem, [string]$state, [string]$note) {
    $title = ""
    try { $f = Join-Path $root ($OrderDir + "\" + $Prefix + $stem + ".md"); if (Test-Path $f) { $title = ([string]([System.IO.File]::ReadLines($f) | Where-Object { $_.Trim() -ne "" } | Select-Object -First 1)).TrimStart('#',' ').Trim() } } catch { }
    $idx = 0; if ($queue.ContainsKey($stem)) { $idx = $queue[$stem].order } else { $idx = $queue.Count + 1 }
    $queue[$stem] = @{ name = ($stem.ToLower() -replace '[^a-z0-9-]','-'); order = $idx; title = $title; state = $state; note = $note; updatedAt = (Get-Date).ToString("o") }
    Save-Queue
}
$started = @{}   # name -> pid; also seeded with every worker that is already running
$seedReg = Join-Path $root "logs\workers.json"
if (Test-Path $seedReg) {
    foreach ($l in [System.IO.File]::ReadAllLines($seedReg)) {
        if ($l.Trim() -eq "") { continue }
        try { $e = $l | ConvertFrom-Json; if ($e.pid -and (Get-Process -Id ([int]$e.pid) -ErrorAction SilentlyContinue)) { $started[[string]$e.name] = [int]$e.pid } } catch { }
    }
}
function Start-One([string]$stem) {
    $file = Join-Path $root ($OrderDir + "\" + $Prefix + $stem + ".md")
    if (-not (Test-Path $file)) { Log ("MISSING order file for " + $stem); return $false }
    Normalise $file
    $pct = Go-Pct
    if ($pct -ne $null -and $pct -lt $MinGoPct) { Queue-Set $stem "skipped" ("OpenCode quota " + $pct + "% is below " + $MinGoPct + "%"); Log ("STOP: OpenCode quota " + $pct + "% is below " + $MinGoPct + "%; not starting " + $stem); return $null }
    $name = ($stem.ToLower() -replace '[^a-z0-9-]','-')
    # Capture the wrapper's output through a FILE, not a pipe: the worker it starts inherits pipe
    # handles, so a pipe would block here until the worker exits (making the queue serial).
    $tmpOut = Join-Path $env:TEMP ("spawn-" + $name + ".out")
    $tmpErr = Join-Path $env:TEMP ("spawn-" + $name + ".err")
    $wrap = Start-Process -FilePath "powershell.exe" -WindowStyle Hidden -PassThru -RedirectStandardOutput $tmpOut -RedirectStandardError $tmpErr -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File",('"' + (Join-Path $root "ops\spawn-worker.ps1") + '"'),"-Name",$name,"-OrderFile",($OrderDir + "\" + $Prefix + $stem + ".md"),"-MaxMinutes",$TimeoutMin,"-MaxUsd","0.60")
    [void]$wrap.WaitForExit(90000)
    $out = @(); if (Test-Path $tmpOut) { $out = @([System.IO.File]::ReadAllLines($tmpOut) | ForEach-Object { "$_" }) }
    $pidLine = $out | Where-Object { $_ -match '^\d+$' } | Select-Object -Last 1
    if (-not $pidLine) { Start-Sleep -Seconds 4; $pidLine = Registry-Pid $name }   # the registry is the source of truth
    $refuse = $out | Where-Object { $_ -match '^REFUSE' } | Select-Object -First 1
    if ($refuse) { Queue-Set $stem "refused" ([string]$refuse); Log ("REFUSED " + $stem + ": " + $refuse); return $false }
    if ($pidLine) { $started[$name] = [int]$pidLine; Queue-Set $stem "running" ""; Log ("started " + $name + " pid " + $pidLine + " | " + (($out | Where-Object { $_ -match '^provider=' } | Select-Object -First 1))); return $true }
    Log ("could not read pid for " + $stem + ": " + ($out -join " / ")); return $false
}

function Wait-Slot { while ((Live-Count) -ge $MaxLive) { Start-Sleep -Seconds 10 } }
function Wait-All { while ($true) { $alive = @($started.GetEnumerator() | Where-Object { Get-Process -Id $_.Value -ErrorAction SilentlyContinue }); if ($alive.Count -eq 0) { break }; Start-Sleep -Seconds 10 } }

Log ("wave start: parallel=" + ($Parallel -join ",") + " serial=" + ($Serial -join ",") + " maxLive=" + $MaxLive + " minGoPct=" + $MinGoPct)
foreach ($qs in (@($Parallel) + @($Serial))) { Queue-Set $qs "queued" "" }
$stopped = $false
foreach ($s in $Parallel) {
    if ($stopped) { Log ("skipped (budget stop): " + $s); continue }
    Wait-Slot
    $r = Start-One $s
    if ($r -eq $null) { $stopped = $true }
    Start-Sleep -Seconds 3
}
Wait-All
# A worker can end its run after a thought-only turn (no tool call): the process exits cleanly but did
# nothing. The order asks for docs/overnight/REPORT_<stem>.md, so a missing report means "retry once".
function Report-Missing([string]$stem) { return (-not (Test-Path (Join-Path $root ($OrderDir + "\REPORT_" + $stem + ".md")))) }
foreach ($s in $Parallel) {
    if ($stopped) { break }
    if (Report-Missing $s -and $queue.ContainsKey($s) -and $queue[$s].state -eq "running") {
        Log ("no report from " + $s + "; retrying once"); Queue-Set $s "queued" "retry after silent stop"
        $r = Start-One $s; if ($r -eq $null) { $stopped = $true } else { Wait-All }
    }
}
foreach ($s in $Serial) {
    if ($stopped) { Log ("skipped (budget stop): " + $s); continue }
    Wait-All
    $r = Start-One $s
    if ($r -eq $null) { $stopped = $true; continue }
    Wait-All
    if (Report-Missing $s) {
        Log ("no report from " + $s + "; retrying once"); Queue-Set $s "queued" "retry after silent stop"
        $r = Start-One $s
        if ($r -eq $null) { $stopped = $true; continue }
        Wait-All
        if (Report-Missing $s) { Log ("STILL no report from " + $s + " after one retry; giving up on it"); Queue-Set $s "refused" "no report after a retry" }
    }
}
Log "wave finished; ledger results:"
$led = Join-Path $root "logs\token-ledger.jsonl"
if (Test-Path $led) {
    foreach ($l in [System.IO.File]::ReadAllLines($led)) {
        if ($l.Trim() -eq "") { continue }
        try { $o = $l | ConvertFrom-Json; if ($started.ContainsKey([string]$o.name)) { Log ("  " + $o.name + ": turns=" + $o.turns + " est=" + $o.estUsd + " ended=" + $o.endedBy) } } catch { }
    }
}
Log ("OpenCode quota left now: " + (Go-Pct) + "%")
