# ops/guard-protected.ps1
# Protect boot-critical files and the live company/ data dir from unauthorized edits.
#
# Windows PowerShell 5.1 compatible. No external dependencies. No network.
#
# Modes (exactly one of the three switches):
#   -Snapshot Write path + size + SHA256 + mtime for every existing protected path
#             to ops/.protected-baseline.json. This is the ONLY file it writes.
#   -Check    Re-hash every protected path and exit non-zero listing each path that
#             changed, appeared, or vanished. Also refuses (non-zero) when a router
#             boot is in flight, because editing src/ mid-boot is one of the harms.
#   -Booting  Inspect the tail of logs/router.supervisor.log and logs/router.out.log
#             and report whether a router boot is IN FLIGHT (a "starting router
#             (attempt" line newer than the last "router is UP"/"is healthy" line).
#             Exit non-zero when a boot is in flight.
#
# Exit codes:
#   0 = OK / not booting / no changes
#   1 = runtime or I/O error
#   2 = usage error (not exactly one mode selected)
#   3 = boot in flight (used by -Booting, and by -Check when it refuses)
#   4 = changes detected (-Check)
#
# Options (defaults are relative to the repo root, the parent of this file's folder):
#   -Root <dir>          Override the repo root.
#   -ListPath <file>     Override the protected-paths list.
#   -BaselinePath <file> Override the baseline JSON path.
#   -LogsDir <dir>       Override the logs directory.
#
# Directory entries (a path that resolves to a folder, e.g. "company/") are
# fingerprinted by a SHA256 over the sorted manifest of every file below them
# ("relpath|size|mtimeTicks"). This detects added/removed/renamed/resized/re-touched
# files without reading the whole tree's content on every -Check (the live company/
# tree is large).

[CmdletBinding()]
param(
    [switch]$Snapshot,
    [switch]$Check,
    [switch]$Booting,
    [string]$Root = "",
    [string]$ListPath = "",
    [string]$BaselinePath = "",
    [string]$LogsDir = ""
)

$ErrorActionPreference = "Stop"

function Fail([string]$msg, [int]$code) {
    Write-Output ("[guard] " + $msg)
    exit $code
}

function As-Array($x) {
    if ($null -eq $x) { return @() }
    return @($x)
}

function Resolve-Config {
    if ($Root -ne "") {
        if (Test-Path -LiteralPath $Root) {
            $script:RepoRoot = (Resolve-Path -LiteralPath $Root).Path
        } else {
            Fail ("-Root does not exist: " + $Root) 1
        }
    } else {
        $script:RepoRoot = Split-Path -Parent $PSScriptRoot
    }

    $script:ListFile = $ListPath
    if ($ListFile -eq "") { $script:ListFile = Join-Path $RepoRoot "ops\protected-paths.txt" }
    elseif (-not [System.IO.Path]::IsPathRooted($ListFile)) { $script:ListFile = Join-Path $RepoRoot $ListFile }

    $script:BaselineFile = $BaselinePath
    if ($BaselineFile -eq "") { $script:BaselineFile = Join-Path $RepoRoot "ops\.protected-baseline.json" }
    elseif (-not [System.IO.Path]::IsPathRooted($BaselineFile)) { $script:BaselineFile = Join-Path $RepoRoot $BaselineFile }

    $script:LogDir = $LogsDir
    if ($LogDir -eq "") { $script:LogDir = Join-Path $RepoRoot "logs" }
    elseif (-not [System.IO.Path]::IsPathRooted($LogsDir)) { $script:LogDir = Join-Path $RepoRoot $LogsDir }
}

function Read-ProtectedList {
    if (-not (Test-Path -LiteralPath $ListFile -PathType Leaf)) {
        Fail ("protected-paths list not found: " + $ListFile) 1
    }
    $paths = @()
    foreach ($line in (Get-Content -LiteralPath $ListFile)) {
        $t = $line.Trim()
        if ($t -eq "" -or $t.StartsWith("#")) { continue }
        $paths += $t
    }
    return $paths
}

function Resolve-ProtectedPath([string]$p) {
    $p = $p.Trim()
    $p = $p.TrimEnd('\', '/')
    if ($p -eq "") { return "" }
    if ([System.IO.Path]::IsPathRooted($p)) { return $p }
    return (Join-Path $RepoRoot $p)
}

function New-Sha256Hex([byte[]]$bytes) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $h = $sha.ComputeHash($bytes)
        $sb = New-Object System.Text.StringBuilder
        foreach ($b in $h) { [void]$sb.Append($b.ToString("x2")) }
        return $sb.ToString().ToUpperInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Get-FileEntry([string]$absPath) {
    $fi = Get-Item -LiteralPath $absPath
    $hash = (Get-FileHash -LiteralPath $absPath -Algorithm SHA256).Hash
    return @{
        kind       = "file"
        size       = [long]$fi.Length
        sha256     = $hash
        mtimeTicks = [long]$fi.LastWriteTimeUtc.Ticks
        mtimeUtc   = $fi.LastWriteTimeUtc.ToString("o")
    }
}

function Get-DirEntry([string]$absPath) {
    $rows = New-Object System.Collections.Generic.List[object]
    foreach ($f in (Get-ChildItem -LiteralPath $absPath -Recurse -File -ErrorAction SilentlyContinue)) {
        $rel = $f.FullName.Substring($absPath.Length).TrimStart('\', '/')
        $rows.Add([pscustomobject]@{ p = $rel; s = [long]$f.Length; m = [long]$f.LastWriteTimeUtc.Ticks })
    }
    $sorted = @($rows | Sort-Object -Property p)

    $sizeSum = 0L
    $maxTicks = 0L
    $manifest = New-Object System.Collections.Generic.List[string]
    $fileRows = New-Object System.Collections.Generic.List[object]
    foreach ($r in $sorted) {
        $sizeSum += $r.s
        if ($r.m -gt $maxTicks) { $maxTicks = $r.m }
        [void]$manifest.Add([string]::Format("{0}|{1}|{2}", $r.p, $r.s, $r.m))
        $fileRows.Add($r)
    }

    $joined = [string]::Join("`n", $manifest.ToArray())
    $hashHex = New-Sha256Hex ([System.Text.Encoding]::UTF8.GetBytes($joined))

    $mtimeUtc = ""
    if ($maxTicks -ne 0L) { $mtimeUtc = ([datetime]$maxTicks).ToString("o") }

    return @{
        kind       = "dir"
        size       = $sizeSum
        sha256     = $hashHex
        mtimeTicks = $maxTicks
        mtimeUtc   = $mtimeUtc
        files      = $fileRows.ToArray()
    }
}

function Get-PathEntry([string]$absPath) {
    if ($null -eq $absPath -or $absPath -eq "") { return $null }
    if (Test-Path -LiteralPath $absPath -PathType Container) { return Get-DirEntry $absPath }
    if (Test-Path -LiteralPath $absPath -PathType Leaf) { return Get-FileEntry $absPath }
    return $null
}

function Get-LineTimestamp([string]$line) {
    $m = [regex]::Match($line, '\[([^\]]+)\]')
    if (-not $m.Success) { return $null }
    $s = $m.Groups[1].Value
    $dto = [DateTimeOffset]::MinValue
    if ([DateTimeOffset]::TryParse($s, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$dto)) {
        return $dto
    }
    return $null
}

function Test-BootInFlight {
    $lines = @()
    $supPath = Join-Path $LogDir "router.supervisor.log"
    $outPath = Join-Path $LogDir "router.out.log"
    if (Test-Path -LiteralPath $supPath) { $lines += @(Get-Content -LiteralPath $supPath -Tail 4000 -ErrorAction SilentlyContinue) }
    if (Test-Path -LiteralPath $outPath) { $lines += @(Get-Content -LiteralPath $outPath -Tail 4000 -ErrorAction SilentlyContinue) }

    $lastStart = $null
    $lastHealthy = $null
    foreach ($line in $lines) {
        if ($null -eq $line) { continue }
        $low = $line.ToLowerInvariant()
        $isStart = $low.Contains("starting router (attempt")
        $isHealthy = ($low.Contains("router is up") -or $low.Contains("is healthy"))
        if (-not ($isStart -or $isHealthy)) { continue }
        $ts = Get-LineTimestamp ([string]$line)
        if ($null -eq $ts) { continue }
        if ($isStart) { if ($null -eq $lastStart -or $ts -gt $lastStart) { $lastStart = $ts } }
        if ($isHealthy) { if ($null -eq $lastHealthy -or $ts -gt $lastHealthy) { $lastHealthy = $ts } }
    }

    $inFlight = $false
    if ($null -ne $lastStart) {
        if ($null -eq $lastHealthy) { $inFlight = $true }
        elseif ($lastStart -gt $lastHealthy) { $inFlight = $true }
    }
    return @{ inFlight = $inFlight; lastStart = $lastStart; lastHealthy = $lastHealthy }
}

function Format-When($dto) {
    if ($null -eq $dto) { return "(none)" }
    return $dto.ToString("o")
}

function Invoke-Booting {
    $r = Test-BootInFlight
    $start = Format-When $r.lastStart
    $healthy = Format-When $r.lastHealthy
    if ($r.inFlight) {
        Write-Output ("[booting] BOOT IN FLIGHT: last 'starting router (attempt' = " + $start + " ; last 'router is UP/is healthy' = " + $healthy)
        exit 3
    }
    Write-Output ("[booting] no boot in flight: last 'starting router (attempt' = " + $start + " ; last 'router is UP/is healthy' = " + $healthy)
    exit 0
}

function Invoke-Snapshot {
    $paths = Read-ProtectedList
    $entries = @()
    foreach ($p in $paths) {
        $abs = Resolve-ProtectedPath $p
        $entry = Get-PathEntry $abs
        if ($null -eq $entry) {
            Write-Output ("[snapshot] skipped (does not exist): " + $p)
            continue
        }
        $entry.path = $p
        $entries += $entry
    }
    $baseline = @{
        generatedAtUtc = [DateTime]::UtcNow.ToString("o")
        root           = $RepoRoot
        listPath       = $ListFile
        hashAlgorithm  = "SHA256"
        entries        = $entries
    }
    $parent = Split-Path -Parent $BaselineFile
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $json = $baseline | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText($BaselineFile, $json, (New-Object System.Text.UTF8Encoding($false)))
    Write-Output ("[snapshot] wrote " + $entries.Count + " entries -> " + $BaselineFile)
    exit 0
}

function Diff-Dir([string]$pathLabel, $prevFiles, $curFiles, [System.Collections.Generic.List[string]]$problems) {
    $prevMap = @{}
    foreach ($f in (As-Array $prevFiles)) {
        if ($null -eq $f) { continue }
        $prevMap[[string]$f.p] = $f
    }
    $curMap = @{}
    foreach ($f in (As-Array $curFiles)) {
        if ($null -eq $f) { continue }
        $curMap[[string]$f.p] = $f
    }
    foreach ($cp in $curMap.Keys) {
        if (-not $prevMap.ContainsKey($cp)) { $problems.Add("    appeared in dir: " + $cp) }
    }
    foreach ($pp in $prevMap.Keys) {
        if (-not $curMap.ContainsKey($pp)) { $problems.Add("    vanished from dir: " + $pp) }
        else {
            $pv = $prevMap[$pp]
            $cv = $curMap[$pp]
            if ([long]$pv.s -ne [long]$cv.s -or [long]$pv.m -ne [long]$cv.m) {
                $problems.Add("    changed in dir: " + $pp)
            }
        }
    }
}

function Invoke-Check {
    $boot = Test-BootInFlight
    if ($boot.inFlight) {
        Write-Output ("[check] refusing: a router boot is IN FLIGHT (last 'starting router (attempt' = " + (Format-When $boot.lastStart) + " ; last 'router is UP/is healthy' = " + (Format-When $boot.lastHealthy) + "). Do not edit protected files mid-boot.")
        exit 3
    }
    if (-not (Test-Path -LiteralPath $BaselineFile -PathType Leaf)) {
        Fail ("no baseline found; run -Snapshot first: " + $BaselineFile) 1
    }
    $baseline = Get-Content -LiteralPath $BaselineFile -Raw | ConvertFrom-Json
    $known = @{}
    foreach ($e in (As-Array $baseline.entries)) {
        if ($null -eq $e) { continue }
        $known[[string]$e.path] = $e
    }
    $paths = Read-ProtectedList
    $problems = New-Object System.Collections.Generic.List[string]

    foreach ($p in $paths) {
        $abs = Resolve-ProtectedPath $p
        $cur = Get-PathEntry $abs
        $prev = $null
        if ($known.ContainsKey($p)) { $prev = $known[$p] }

        if ($null -eq $prev) {
            if ($null -ne $cur) {
                $problems.Add("APPEARED: " + $p + " (was absent at snapshot, now exists)")
            }
            continue
        }
        if ($null -eq $cur) {
            $problems.Add("VANISHED: " + $p)
            continue
        }
        if ([string]$prev.kind -ne [string]$cur.kind) {
            $problems.Add("CHANGED (kind): " + $p + " (" + $prev.kind + " -> " + $cur.kind + ")")
            continue
        }
        if ([string]$prev.sha256 -ne [string]$cur.sha256 -or [long]$prev.size -ne [long]$cur.size) {
            $problems.Add("CHANGED: " + $p + " (size " + $prev.size + " -> " + $cur.size + ")")
            if ([string]$cur.kind -eq "dir") {
                Diff-Dir $p $prev.files $cur.files $problems
            }
        }
    }

    if ($problems.Count -gt 0) {
        foreach ($x in $problems) { Write-Output ("[check] " + $x) }
        Write-Output ("[check] FAIL: " + $problems.Count + " protected path(s) changed/appeared/vanished")
        exit 4
    }
    Write-Output ("[check] OK: " + $known.Count + " protected path(s) unchanged")
    exit 0
}

# Main
Resolve-Config
$modes = 0
if ($Snapshot) { $modes++ }
if ($Check) { $modes++ }
if ($Booting) { $modes++ }
if ($modes -ne 1) {
    Write-Output "usage: powershell -NoProfile -ExecutionPolicy Bypass -File ops\guard-protected.ps1 -Snapshot|-Check|-Booting [-Root <dir>] [-ListPath <file>] [-BaselinePath <file>] [-LogsDir <dir>]"
    exit 2
}

if ($Snapshot) { Invoke-Snapshot }
if ($Check) { Invoke-Check }
if ($Booting) { Invoke-Booting }
