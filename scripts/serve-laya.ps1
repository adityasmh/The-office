# Local Laya decision server (Jev-compatible POST /v1/systemone).
# Runs from the project-local venv in deps\venv - fully self-contained on this PC.
#
# Default device is the CUDA GPU (RTX 4050 Laptop, 6 GB). Everything GPU-specific -
# the per-process VRAM budget, the fp16 resident weights, and the automatic CPU
# fallback - lives in scripts\laya-gpu-boot.py, NOT in site-packages. See
# docs\LAYA_TUNING.md ("Laya on GPU") for the measured before/after and the way back.
#
# Usage:
#   powershell -File scripts/serve-laya.ps1            # GPU (default); CPU if CUDA is unusable
#   powershell -File scripts/serve-laya.ps1 -Cpu       # force CPU: the pre-GPU behaviour exactly
#   powershell -File scripts/serve-laya.ps1 -Device cpu
# Knobs (env, all optional):
#   LAYA_GPU_MEM_FRACTION   fraction of VRAM for this process (default 0.65 ~= 4.0 GB of 6.1 GB)
#   LAYA_GPU_WEIGHTS        fp16 (default) | bf16 | fp32     resident weight dtype on CUDA
#   LAYA_DEVICE             "cpu" disables the GPU path entirely

param(
    [switch]$Cpu,
    [string]$Device = "",
    [string]$LogDir = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$PY = Join-Path $root "deps\venv\Scripts\python.exe"
$BOOT = Join-Path $root "scripts\laya-gpu-boot.py"

if (-not (Test-Path $PY)) {
    throw "Project venv not found at $PY. Run: deps\setup.ps1"
}
& $PY -c "import laya" 2>$null
if ($LASTEXITCODE -ne 0) {
    throw "laya not installed in project venv. Run: deps\setup.ps1"
}

# Device selection: explicit argument > existing environment > GPU default.
if (-not [string]::IsNullOrWhiteSpace($Device)) {
    $env:LAYA_DEVICE = $Device
} elseif ([string]::IsNullOrWhiteSpace($env:LAYA_DEVICE)) {
    $env:LAYA_DEVICE = "cuda"
}
if ($Cpu) {
    # Both knobs: LAYA_GPU stops the VRAM cap and the fp16 weight cast, LAYA_DEVICE is
    # what laya itself reads. Setting only one of them leaves the GPU in play.
    $env:LAYA_GPU = "cpu"
    $env:LAYA_DEVICE = "cpu"
} elseif ([string]::IsNullOrWhiteSpace($env:LAYA_GPU)) { $env:LAYA_GPU = "auto" }

if ([string]::IsNullOrWhiteSpace($env:LAYA_HOST)) { $env:LAYA_HOST = "127.0.0.1" }
if ([string]::IsNullOrWhiteSpace($env:LAYA_PORT)) { $env:LAYA_PORT = "8000" }
$env:LAYA_PRELOAD = "1"
# Unbuffered so the [laya-gpu] boot lines and uvicorn's startup lines land in
# logs\laya.out.log as they happen, not when the buffer flushes.
$env:PYTHONUNBUFFERED = "1"
# Fragmentation hint for the caching allocator; the boot script also sets this.
if ([string]::IsNullOrWhiteSpace($env:PYTORCH_CUDA_ALLOC_CONF)) {
    $env:PYTORCH_CUDA_ALLOC_CONF = "expandable_segments:True"
}

Write-Host "Starting laya-serve on $($env:LAYA_HOST):$($env:LAYA_PORT) - preload all checkpoints, device=$($env:LAYA_DEVICE), gpu=$($env:LAYA_GPU)"
if (Test-Path $BOOT) {
    $bootTarget = $BOOT
} else {
    Write-Host "WARNING scripts\laya-gpu-boot.py not found - using the plain 'python -m laya.serve' path (no VRAM cap, fp32 weights)."
    $bootTarget = ""
}
if (-not [string]::IsNullOrWhiteSpace($LogDir)) {
    # Service mode (ops\laya-restart.ps1): capture the boot log WITHOUT PowerShell's
    # native redirection. Two PowerShell 5.1 traps measured on 2026-09-29:
    #   1. '1>> file 2>> file' under $ErrorActionPreference='Stop' turns a native
    #      command's stderr write (tqdm's "Fetching 5 files", uvicorn's INFO lines)
    #      into a terminating NativeCommandError, which killed the freshly started
    #      Laya after its first three boot lines.
    #   2. Start-Process -RedirectStandardOutput leaves the caller's pipe handles
    #      inherited by Laya, so a caller waiting for EOF blocks until Laya exits.
    # cmd.exe does the redirection instead: no PowerShell error semantics involved.
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    $outFile = Join-Path $LogDir "laya.out.log"
    $errFile = Join-Path $LogDir "laya.err.log"
    $target = if ($bootTarget) { $bootTarget } else { '' }
    if ($target) {
        & cmd.exe /c "`"$PY`" `"$target`" 1>> `"$outFile`" 2>> `"$errFile`""
    } else {
        & cmd.exe /c "`"$PY`" -m laya.serve 1>> `"$outFile`" 2>> `"$errFile`""
    }
} else {
    if ($bootTarget) { & $PY $bootTarget } else { & $PY -m laya.serve }
}
