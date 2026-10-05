# spawn-worker.ps1 - the ONLY way the manager spawns workers.
# Always runs the DeepSeek flash model via `jcode.exe run`. Refuses any other model.
# PROVIDER IS DECIDED BY THE ROUTING POLICY, not by the manager (CEO order 2026-10-06):
# -Provider auto (default) asks GET /company/routing/policy. OpenCode Go is used while
# it has quota; DeepSeek direct (prepaid credits) only when the policy says OpenCode is
# exhausted. If the policy cannot be read, it falls back to OpenCode Go, never to credits.
# Windows PowerShell 5.1 compatible: no ??, no ternary, no -AsHashtable.
param(
    [Parameter(Mandatory=$true)][string]$Name,
    [string]$Message = "",
    [string]$OrderFile = "",
    [double]$MaxMinutes = 15,
    [double]$MaxUsd = 0.30,
    [string]$Provider = "auto",
    [string]$Model = "deepseek-flash",
    [switch]$Force,
    [switch]$DryRun,
    [string]$TestRoot = "",
    [string]$Repo = "",
    [string]$JcodeExe = "C:\Users\user\AppData\Local\jcode\bin\jcode.exe"
)

$ErrorActionPreference = "Stop"
$guarded = "ops\worker-guard.ps1"

function Refuse([string]$why) {
    Write-Output ("REFUSE: " + $why)
    exit 2
}

# ---- Windows argument quoting (CommandLineToArgvW / MSVC rules).
# Returns a bare token when no quoting is needed, else a double-quoted token
# with embedded quotes escaped as \" so the whole value arrives as ONE argument.
function Quote-Arg([string]$a) {
    if ($a -eq $null) { $a = "" }
    if ($a.Length -gt 0 -and ($a -notmatch '[ \t"]')) { return $a }
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    $bs = 0
    foreach ($ch in $a.ToCharArray()) {
        if ($ch -eq '\') { $bs = $bs + 1; continue }
        if ($ch -eq '"') {
            if ($bs -gt 0) { [void]$sb.Append('\' * ((2 * $bs) + 1)); $bs = 0 } else { [void]$sb.Append('\"') }
            [void]$sb.Append('"')
        } else {
            if ($bs -gt 0) { [void]$sb.Append('\' * $bs); $bs = 0 }
            [void]$sb.Append($ch)
        }
    }
    if ($bs -gt 0) { [void]$sb.Append('\' * (2 * $bs)) }
    [void]$sb.Append('"')
    return $sb.ToString()
}

# ---- name / message / model
if ($Name -notmatch '^[A-Za-z0-9-]+$') { Refuse ("name must be letters/digits/dashes: " + $Name) }
if ($Message -eq "" -and $OrderFile -eq "") { Refuse "need -Message or -OrderFile" }

$lowModel = $Model.ToLower()
if ($lowModel.Contains("pro")) { Refuse ("model contains 'pro' (forbidden): " + $Model) }
if ($lowModel -ne "deepseek-flash" -and $lowModel -ne "deepseek-v4-flash") { Refuse ("model must be deepseek flash: " + $Model) }

# ---- provider: ask the routing policy (it knows the OpenCode Go quota), never guess here.
# DeepSeek direct id is deepseek-flash; the OpenCode Go id for the same model is deepseek-v4-flash.
$Provider = $Provider.ToLower()
$providerWhy = "explicit -Provider " + $Provider
if ($Provider -eq "auto") {
    $Provider = "opencode-go"
    $providerWhy = "routing policy unreadable: default to OpenCode Go (never spend credits unasked)"
    try {
        $pol = (Invoke-WebRequest -Uri "http://127.0.0.1:8787/company/routing/policy" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop).Content | ConvertFrom-Json
        # `use` is the decision (true = DeepSeek direct); `provider` is only a label.
        if ($pol.sampleStandard.use -eq $true) { $Provider = "deepseek" } else { $Provider = "opencode-go" }
        $providerWhy = [string]$pol.sampleStandard.why
    } catch { }
}
if ($Provider -ne "deepseek" -and $Provider -ne "opencode-go") { Refuse ("provider must be auto, deepseek or opencode-go: " + $Provider) }
if ($Provider -eq "deepseek") { $Model = "deepseek-flash" } else { $Model = "deepseek-v4-flash" }
Write-Output ("provider=" + $Provider + " model=" + $Model + " why: " + $providerWhy)
# jcode's own "final confidence check" re-prompt made a finished worker loop (gh-2, 2026-10-06).
$env:JCODE_RUN_AUTO_POKE = "0"

if ($OrderFile -ne "") {
    $orderFull = $OrderFile
    if (-not [System.IO.Path]::IsPathRooted($orderFull) -and $Repo -ne "") { $orderFull = Join-Path $Repo $OrderFile }
    # Loop-word guard (docs/WORKER_GUARD.md rule 5): an order that contains the loop phrase's
    # 3-letter prefix can prime a worker to repeat it. Enforced here, not left to the manager.
    $chk = $orderFull
    if (-not (Test-Path -LiteralPath $chk)) { $chk = Join-Path (Split-Path -Parent $PSScriptRoot) $OrderFile }
    if ((Test-Path -LiteralPath $chk) -and (-not $Force)) {
        $loopHits = @(Select-String -LiteralPath $chk -Pattern 'hol' -CaseSensitive:$false)
        if ($loopHits.Count -gt 0) {
            Refuse ("order contains the loop-word prefix on line " + $loopHits[0].LineNumber + ": rephrase it (for example use 'entire' for the word before 'order'), or pass -Force")
        }
    }
    $msg = "You are a jcode worker for the manager. Read and execute the work order in " + $OrderFile + " exactly as written. When the job is done print the final report and END your turn; never wait, hold, loop, re-read your own order again, or say Holding."
} else {
    $msg = $Message
}

# ---- paths
if ($Repo -eq "") { $Repo = Split-Path -Parent $PSScriptRoot }
if ($TestRoot -ne "") { $Root = $TestRoot } else { $Root = Join-Path $Repo "logs" }
if (-not (Test-Path $Root)) { New-Item -ItemType Directory -Path $Root -Force | Out-Null }
$RegistryPath = Join-Path $Root "workers.json"
$LedgerPath   = Join-Path $Root "token-ledger.jsonl"
$PidPath      = Join-Path $Root "worker-guard.pid"
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Test-EntryAlive($e) {
    try {
        $p = Get-Process -Id ([int]$e.pid) -ErrorAction Stop
        if ($e.testDummy -eq $true) { return $true }
        if ($p.ProcessName -eq "jcode") { return $true }
    } catch { }
    return $false
}

# ---- load registry
$entries = @()
if (Test-Path $RegistryPath) {
    foreach ($l in [System.IO.File]::ReadAllLines($RegistryPath)) {
        if ($l -eq $null -or $l.Trim() -eq "") { continue }
        try { $e = $l | ConvertFrom-Json; if ($e.pid -ne $null) { $entries += $e } } catch { }
    }
}
$live = @()
foreach ($e in $entries) { if (Test-EntryAlive $e) { $live += $e } }

# ---- concurrency cap
if ($live.Count -ge 3) { Refuse ("concurrency cap: " + $live.Count + " live workers (max 3)") }

# ---- duplicate cap
foreach ($e in $live) {
    if ([string]$e.name -eq $Name) { Refuse ("duplicate: a live worker named '" + $Name + "' already exists (pid " + $e.pid + ")") }
}

# ---- daily cap
$cap = 1.50
if ($env:WORKER_DAILY_USD_CAP -ne $null -and $env:WORKER_DAILY_USD_CAP -ne "") {
    try { $cap = [double]$env:WORKER_DAILY_USD_CAP } catch { }
}
$today = (Get-Date).ToString("yyyy-MM-dd")
$spent = 0.0
$goEst = 0.0
# provider per worker (date|name); a worker with no record counts as credits (conservative)
$provByKey = @{}
$provPath = Join-Path $Root "worker-providers.jsonl"
if (Test-Path $provPath) {
    foreach ($pl in [System.IO.File]::ReadAllLines($provPath)) {
        if ($pl -eq $null -or $pl.Trim() -eq "") { continue }
        try { $po = $pl | ConvertFrom-Json; $provByKey[([string]$po.date + "|" + [string]$po.name)] = [string]$po.provider } catch { }
    }
}
if (Test-Path $LedgerPath) {
    foreach ($l in [System.IO.File]::ReadAllLines($LedgerPath)) {
        if ($l -eq $null -or $l.Trim() -eq "") { continue }
        try {
            $o = $l | ConvertFrom-Json
            if ([string]$o.date -eq $today -and $o.estUsd -ne $null) {
                $k = [string]$o.date + "|" + [string]$o.name
                if ($provByKey.ContainsKey($k) -and $provByKey[$k] -eq "opencode-go") { $goEst = $goEst + [double]$o.estUsd }
                else { $spent = $spent + [double]$o.estUsd }
            }
        } catch { }
    }
}
if (($spent) -ge $cap) { Refuse ("daily cap: today CREDIT-priced estUsd " + [math]::Round($spent,4) + " >= " + $cap + " (OpenCode Go workers, est " + [math]::Round($goEst,4) + ", are not counted)") }

# ---- balance floor
$bal = $null
$balKnown = $false
if ($env:JCODE_WORKER_BALANCE_USD -ne $null -and $env:JCODE_WORKER_BALANCE_USD -ne "") {
    try { $bal = [double]$env:JCODE_WORKER_BALANCE_USD; $balKnown = $true } catch { }
} else {
    try {
        $resp = Invoke-WebRequest -Uri "http://localhost:8787/company/budget/real" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        $j = $resp.Content | ConvertFrom-Json
        if ($j.providers.deepseek.balanceUsd -ne $null) { $bal = [double]$j.providers.deepseek.balanceUsd; $balKnown = $true }
    } catch { }
}
if (-not $balKnown) {
    Write-Output "balance unknown"
} elseif ($Provider -eq "deepseek" -and $bal -lt 1.00 -and (-not $Force)) {
    Refuse ("balance floor: deepseek balance " + $bal + " < 1.00 (use -Force to override)")
}

if ($DryRun) {
    Write-Output ("OK dry-run: name=" + $Name + " model=" + $Model + " live=" + $live.Count + " spentToday=" + [math]::Round($spent,4))
    exit 0
}

# ---- spawn
$stamp = (Get-Date).ToString("yyyyMMdd")
$outLog = Join-Path $Root ("jcode-" + $Name + "-" + $stamp + ".log")
$errLog = Join-Path $Root ("jcode-" + $Name + "-" + $stamp + ".err.log")

# Build the jcode command line. The subcommand MUST come first ("run").
# Every element is quoted for CommandLineToArgvW so the message (spaces,
# embedded double quotes, apostrophes) reaches jcode as exactly ONE argument.
$jargs = @("run", "-p", $Provider, "-m", $Model, "-C", $Repo, $msg)
$quoted = @()
foreach ($x in $jargs) { $quoted += (Quote-Arg $x) }
$argStr = ($quoted -join " ")

$p = Start-Process -FilePath $JcodeExe -ArgumentList $argStr -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru

# Capture the creation time immediately, before any sleep: StartTime throws
# once a short-lived process has already exited.
$created = ""
try { $created = $p.StartTime.ToUniversalTime().ToString("o") } catch { }
if ($created -eq "") {
    try {
        $ci = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $p.Id) -ErrorAction Stop
        $created = ([System.Management.ManagementDateTimeConverter]::ToDateTime($ci.CreationDate)).ToUniversalTime().ToString("o")
    } catch { }
}

Start-Sleep -Milliseconds 400
if ($p.HasExited) {
    # Reap the process so $p.ExitCode is populated (Start-Process -PassThru can
    # hand back a process object whose ExitCode is not readable without this).
    try { $p.WaitForExit() } catch { }
    $code = $p.ExitCode
    $first = ""
    try {
        if (Test-Path $errLog) {
            $lines = [System.IO.File]::ReadAllLines($errLog)
            if ($lines.Count -gt 0) { $first = $lines[0] }
        }
    } catch { }
    Refuse ("worker exited immediately (code " + $code + "): " + $first)
}
if ($created -eq "") { Refuse ("could not read worker creation time (pid " + $p.Id + ")") }

$rec = [ordered]@{
    name = $Name
    pid = $p.Id
    log = $outLog
    startedAt = (Get-Date).ToString("o")
    maxMinutes = $MaxMinutes
    maxUsd = $MaxUsd
    creationTime = $created
    # WORKERS-LIVE: the dashboard shows which provider/model this worker got
    # (both were already decided and printed above; nothing new is computed here).
    provider = $Provider
    model = $Model
}
[System.IO.File]::AppendAllText($RegistryPath, (($rec | ConvertTo-Json -Compress) + "`r`n"), $utf8)
# Provider sidecar (CEO order 2026-10-06): the daily USD cap must count prepaid CREDITS only.
# OpenCode Go workers use quota, which the routing policy tracks; their estUsd is a DeepSeek-price
# estimate and would otherwise block new workers while no credit is being spent.
$ProviderLog = Join-Path $Root "worker-providers.jsonl"
$provRec = @{ date = (Get-Date).ToString("yyyy-MM-dd"); name = $Name; provider = $Provider; model = $Model }
[System.IO.File]::AppendAllText($ProviderLog, (($provRec | ConvertTo-Json -Compress) + "`r`n"), $utf8)

# ---- start guard if not already running (never in a test root)
if ($TestRoot -eq "") {
    $needStart = $true
    if (Test-Path $PidPath) {
        try {
            $gpid = [int](([System.IO.File]::ReadAllText($PidPath)).Trim())
            $gp = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $gpid) -ErrorAction Stop
            if ($gp -ne $null -and [string]$gp.Name -match '(?i)powershell' -and ([string]$gp.CommandLine) -match '(?i)worker-guard\.ps1') { $needStart = $false }
        } catch { }
    }
    if ($needStart) {
        $guardPath = Join-Path $PSScriptRoot "worker-guard.ps1"
        $guardArgs = "-NoProfile -ExecutionPolicy Bypass -File `"" + $guardPath + "`""
        Start-Process -FilePath "powershell.exe" -ArgumentList $guardArgs -WindowStyle Hidden | Out-Null
    }
}

Write-Output $p.Id
