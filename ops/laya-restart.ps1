# ops/laya-restart.ps1 - switch the local Laya decision server between the CPU and
# CUDA PyTorch builds and restart it, once, inside one short, scripted window.
#
# Why a script and not "pip install then restart": Laya runs out of deps\venv, and
# torch cannot be replaced while the old process holds torch\lib\*.dll open (Windows
# file locks). A pip uninstall+install of the 2.8 GB CUDA tree takes ~100 s of that
# window; renaming the trees is instant and leaves the previous install on disk as an
# equally instant rollback. So the default is a rename swap against a tree that was
# unpacked earlier (while Laya was still serving), and pip is the fallback.
#
# It NEVER touches the router on :8787, the jcode server, or any other session: the
# only processes it stops are python.exe running `laya.serve` / `laya-gpu-boot.py`.
#
#   ops\laya-restart.ps1                    # swap in the staged CUDA tree, start on the GPU, wait for /health
#   ops\laya-restart.ps1 -Cpu                # restart on the CPU (keeps whatever torch is installed)
#   ops\laya-restart.ps1 -Rollback           # restore the previous torch tree, start on the CPU
#   ops\laya-restart.ps1 -InstallFromWheel    # use pip (deps\wheels-cu132) instead of the rename swap
#   ops\laya-restart.ps1 -SkipInstall          # just stop and start with the current torch
#   ops\laya-restart.ps1 -Status               # report only
#
# Staging the CUDA tree (once, while Laya keeps serving; 2.8 GB on disk):
#   deps\venv\Scripts\python.exe -m pip download "torch==2.14.0+cu132" --index-url https://download.pytorch.org/whl/cu132 --only-binary=:all: --no-deps --dest deps\wheels-cu132
#   deps\venv\Scripts\python.exe -m pip install --no-index --find-links deps\wheels-cu132 "torch==2.14.0+cu132" --no-deps --target deps\staged-torch-cu132
# and, for the offline rollback path:
#   deps\venv\Scripts\python.exe -m pip download "torch==2.14.0" --index-url https://download.pytorch.org/whl/cpu --only-binary=:all: --no-deps --dest deps\wheels-cpu
#
# -SiteDir / -SwapRoot / -SwapOnly exist so the swap logic can be exercised on a mock
# tree (see the -SwapOnly test in docs\AGENT_COORDINATION.md) and on another venv.

param(
    [switch]$Cpu,
    [switch]$Status,
    [switch]$Rollback,
    [switch]$InstallFromWheel,
    [switch]$SkipInstall,
    [switch]$SwapOnly,
    [string]$Stage = "",
    [string]$SiteDir = "",
    [string]$SwapRoot = "",
    [int]$Port = 8000,
    [int]$TimeoutSec = 150
)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$PY = Join-Path $root "deps\venv\Scripts\python.exe"
$launcher = Join-Path $root "scripts\serve-laya.ps1"
$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$outLog = Join-Path $logDir "laya.out.log"
$errLog = Join-Path $logDir "laya.err.log"

if (-not $SiteDir) { $SiteDir = Join-Path $root "deps\venv\Lib\site-packages" }
if (-not $SwapRoot) { $SwapRoot = Join-Path $root "deps\torch-swap" }
if (-not $Stage) { $Stage = Join-Path $root "deps\staged-torch-cu132" }

# The pieces a torch wheel owns in site-packages. Exactly these four names were present
# in deps\venv\Lib\site-packages on 2026-09-29, and the same four ship in the wheel.
$TorchNames = @('torch', 'functorch', 'torchgen')

function Write-Step([string]$msg) { Write-Host ("[{0}] {1}" -f (Get-Date -Format HH:mm:ss), $msg) }

function Test-LayaHealth {
    try {
        $raw = & curl.exe -s -m 5 "http://127.0.0.1:$Port/health" 2>$null
        if (-not $raw) { return $null }
        return ($raw | ConvertFrom-Json)
    } catch { return $null }
}

function Get-ListenerPid {
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { return [int]$c.OwningProcess }
    return 0
}

# The venv python.exe on this machine is a launcher that re-execs the base interpreter,
# so one logical Laya server is two PIDs - both carry the same script argument.
function Get-LayaProcesses {
    Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and ($_.CommandLine -like '*laya.serve*' -or $_.CommandLine -like '*laya-gpu-boot.py*') }
}

function Get-Descendants([int]$ParentPid) {
    $kids = Get-CimInstance Win32_Process -Filter "ParentProcessId=$ParentPid" -ErrorAction SilentlyContinue
    foreach ($k in $kids) {
        $k.ProcessId
        Get-Descendants -ParentPid $k.ProcessId
    }
}

function Find-TorchPieces([string]$dir) {
    $pieces = @()
    foreach ($n in $TorchNames) {
        $p = Join-Path $dir $n
        if (Test-Path $p) { $pieces += $p }
    }
    $pieces += (Get-ChildItem $dir -Directory -Filter 'torch-*.dist-info' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
    return $pieces
}

# Move every torch piece out of $From into $Into (a timestamped backup dir).
function Move-TorchPieces([string]$From, [string]$Into) {
    New-Item -ItemType Directory -Force -Path $Into | Out-Null
    $moved = @()
    foreach ($p in (Find-TorchPieces -dir $From)) {
        $dest = Join-Path $Into (Split-Path $p -Leaf)
        Move-Item -LiteralPath $p -Destination $dest -Force
        $moved += (Split-Path $p -Leaf)
    }
    return $moved
}

function Get-TorchInfo {
    # Fed to 'python -' over stdin on purpose: PowerShell 5.1 re-quotes a native
    # argument containing double quotes without escaping them, so an inline
    # -c "...print('x', \"| cuda\", ...)" arrives at python split mid-statement.
    # (Measured: this exact line refused to start Laya on the first GPU restart.)
    $code = @'
import torch
print(torch.__version__, "| cuda", torch.version.cuda, "| available", torch.cuda.is_available(), "|", (torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu"))
'@
    return ($code | & $PY - 2>&1 | Out-String).Trim()
}

function Start-LayaProcess {
    # UseShellExecute=$true so the launcher inherits NOTHING from this process: with
    # Start-Process (UseShellExecute=$false) the new Laya holds a copy of the caller's
    # stdout pipe, and any caller that waits for EOF - an agent's tool call, a CI step,
    # a pipe - blocks until the day Laya exits. Measured twice on 2026-09-29.
    $argLine = '-NoProfile -ExecutionPolicy Bypass -File "' + $launcher + '" -LogDir "' + $logDir + '"'
    if ($Cpu) { $argLine += ' -Cpu' }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'powershell.exe'
    $psi.Arguments = $argLine
    $psi.UseShellExecute = $true
    $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    [System.Diagnostics.Process]::Start($psi) | Out-Null
}

$gpuMem = { (nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader 2>$null) }

if ($Status) {
    $h = Test-LayaHealth
    Write-Host "laya health : $(if ($h) { ($h | ConvertTo-Json -Compress) } else { '(no response)' })"
    Write-Host "listener pid: $(if (Get-ListenerPid) { Get-ListenerPid } else { '(none)' })"
    Write-Host "laya pids   : $((Get-LayaProcesses | ForEach-Object { $_.ProcessId }) -join ',')"
    Write-Host "gpu memory  : $(& $gpuMem)"
    Write-Host "torch       : $(Get-TorchInfo)"
    Write-Host "site-pkgs   : $((Find-TorchPieces -dir $SiteDir | ForEach-Object { Split-Path $_ -Leaf }) -join ', ')"
    Write-Host "staged      : $(if (Test-Path $Stage) { (Find-TorchPieces -dir $Stage | ForEach-Object { Split-Path $_ -Leaf }) -join ', ' } else { '(nothing staged)' })"
    Write-Host "backups     : $(if (Test-Path $SwapRoot) { (Get-ChildItem $SwapRoot -Directory | Sort-Object Name -Descending | Select-Object -First 3 | ForEach-Object { $_.Name }) -join ', ' } else { '(none)' })"
    exit 0
}

# ------------------------------------------------------------------ the swap
function Invoke-TorchSwap([string]$From, [string]$Stamp) {
    $backup = Join-Path $SwapRoot $Stamp
    Write-Step "backing up the installed torch pieces into $backup"
    $movedOut = Move-TorchPieces -From $SiteDir -Into $backup
    if (-not $movedOut) {
        Write-Host "REFUSING to swap: nothing named torch*/functorch/torchgen/*.dist-info in $SiteDir" -ForegroundColor Red
        exit 1
    }
    Write-Step "moved out: $($movedOut -join ', ')"
    $movedIn = Move-TorchPieces -From $From -Into $SiteDir
    Write-Step "moved in : $($movedIn -join ', ')"
    if (-not ($movedIn -contains 'torch')) {
        Write-Host "swap FAILED: $From has no 'torch' directory - restoring" -ForegroundColor Red
        Move-TorchPieces -From $SiteDir -Into (Join-Path $backup 'failed-attempt') | Out-Null
        Move-TorchPieces -From $backup -Into $SiteDir | Out-Null
        exit 1
    }
    Set-Content -LiteralPath (Join-Path $backup 'swapped-out-at.txt') -Value ("$(Get-Date -Format o)  site-packages torch pieces replaced from $From") -Encoding UTF8
    return $backup
}

if ($SwapOnly) {
    # Test/escape path: swap only, no stop/start, no torch verification.
    if ($Cpu) {
        $newest = Get-ChildItem $SwapRoot -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
        if (-not $newest) { Write-Host "no backup under $SwapRoot to roll back to" -ForegroundColor Red; exit 1 }
        Write-Step "-SwapOnly -Cpu: restoring $($newest.Name)"
        $cur = Join-Path $SwapRoot ("rolled-back-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
        $movedOut = Move-TorchPieces -From $SiteDir -Into $cur
        Write-Step "moved out: $($movedOut -join ', ')"
        $movedIn = Move-TorchPieces -From $newest.FullName -Into $SiteDir
        Write-Step "moved in : $($movedIn -join ', ')"
        exit 0
    }
    if (-not (Test-Path $Stage)) { Write-Host "$Stage does not exist" -ForegroundColor Red; exit 1 }
    Invoke-TorchSwap -From $Stage -Stamp ("swap-" + (Get-Date -Format 'yyyyMMdd-HHmmss')) | Out-Null
    exit 0
}

# ---------------------------------------------------------------- stop Laya
$procs = @(Get-LayaProcesses)
if ($procs.Count -eq 0) {
    Write-Step "no Laya process found (nothing to stop)"
} else {
    $listener = Get-ListenerPid
    foreach ($p in $procs) {
        $who = if ($p.ProcessId -eq $listener) { "LISTENER on :$Port" } else { "launcher/child of a Laya server" }
        Write-Step ("stopping pid {0} ({1}) :: {2}" -f $p.ProcessId, $who, $p.CommandLine)
    }
    $targets = @()
    foreach ($p in $procs) { $targets += $p.ProcessId; $targets += (Get-Descendants -ParentPid $p.ProcessId) }
    $targets = $targets | Sort-Object -Unique
    foreach ($t in $targets) { Stop-Process -Id $t -Force -ErrorAction SilentlyContinue }
    $deadline = (Get-Date).AddSeconds(25)
    while ((Get-Date) -lt $deadline -and (Get-LayaProcesses).Count -gt 0) { Start-Sleep -Milliseconds 500 }
    $left = @(Get-LayaProcesses)
    if ($left.Count -gt 0) {
        Write-Host "REFUSING to continue: Laya processes survived the stop: $($left.ProcessId -join ',')" -ForegroundColor Red
        exit 1
    }
    Write-Step "stopped: $($targets -join ',')"
}
if (Get-ListenerPid) {
    Write-Host "REFUSING to continue: something is still listening on :$Port (pid $(Get-ListenerPid))" -ForegroundColor Red
    exit 1
}
Write-Step "port :$Port is free"

# ---------------------------------------------------------------- rollback
if ($Rollback) {
    $newest = Get-ChildItem $SwapRoot -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
    if (-not $newest) {
        Write-Host "no torch backup under $SwapRoot - nothing to roll back to; starting on the CPU with the current torch" -ForegroundColor Yellow
    } else {
        Write-Step "restoring $($newest.Name)"
        $cur = Join-Path $SwapRoot ("rolled-back-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
        $movedOut = Move-TorchPieces -From $SiteDir -Into $cur
        Write-Step "moved out: $($movedOut -join ', ')"
        $movedIn = Move-TorchPieces -From $newest.FullName -Into $SiteDir
        Write-Step "moved in : $($movedIn -join ', ')"
    }
    $Cpu = $true
}

# ---------------------------------------------------------------- torch build
if (-not $SkipInstall -and -not $Cpu) {
    if ($InstallFromWheel) {
        $wheelDir = Join-Path $root "deps\wheels-cu132"
        if (-not (Test-Path $wheelDir)) {
            Write-Host "REFUSING: $wheelDir has no staged wheels" -ForegroundColor Red
            exit 1
        }
        Write-Step "pip install torch==2.14.0+cu132 from $wheelDir (local, no network)"
        $sw = [Diagnostics.Stopwatch]::StartNew()
        & $PY -m pip install --no-index --find-links $wheelDir "torch==2.14.0+cu132" --quiet
        $code = $LASTEXITCODE
        $sw.Stop()
        Write-Step ("pip exit {0} after {1:N1}s" -f $code, $sw.Elapsed.TotalSeconds)
        if ($code -ne 0) {
            Write-Host "torch install FAILED - Laya is down. Roll back with: ops\laya-restart.ps1 -Rollback" -ForegroundColor Red
            exit 1
        }
    } else {
        if (-not (Test-Path $Stage)) {
            Write-Host "REFUSING to swap: $Stage does not exist (stage it first, see the header). Use -InstallFromWheel or -Cpu to proceed without it." -ForegroundColor Red
            exit 1
        }
        Invoke-TorchSwap -From $Stage -Stamp ("swap-" + (Get-Date -Format 'yyyyMMdd-HHmmss')) | Out-Null
    }
}

$torchInfo = Get-TorchInfo
Write-Step "torch now: $torchInfo"

# Gate: do not start Laya on a torched venv. A broken import or a CUDA build that cannot
# see the device must be caught here, in seconds, while the backup is still on disk.
$needGpu = (-not $Cpu) -and ($torchInfo -match "available True")
if (-not $Cpu -and -not $needGpu) {
    Write-Host "WARNING: CUDA is not available to deps\venv - Laya will start on the CPU (scripts\laya-gpu-boot.py forces LAYA_DEVICE=cpu)." -ForegroundColor Yellow
}
if ($torchInfo -notmatch "^2\.14\.0") {
    Write-Host "REFUSING to start: 'import torch' did not report a usable build ($torchInfo). Roll back with: ops\laya-restart.ps1 -Rollback" -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------- start Laya
Write-Step "starting the launcher (detached, hidden, logs -> $logDir)"
Start-LayaProcess

$started = Get-Date
$deadline = $started.AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $h = Test-LayaHealth
    if ($h -and $h.status -eq 'ok' -and @($h.loaded).Count -ge 3) {
        $secs = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
        Write-Step "laya is UP on 127.0.0.1:$Port after ${secs}s (pid $(Get-ListenerPid))"
        Write-Host ($h | ConvertTo-Json -Compress)
        Write-Host "gpu memory: $(& $gpuMem)"
        exit 0
    }
}
Write-Host "laya did NOT come up within ${TimeoutSec}s - see $errLog and $outLog" -ForegroundColor Red
exit 1
