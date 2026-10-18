# muse-run.ps1 - run ONE order on the free Muse model directly (no router pipeline), headless, output to logs\muse-direct\<id>.txt
#   powershell -File ops\muse-run.ps1 -Id REG5      (reads logs\muse-direct\prompt-REG5.txt)
# The manager reviews the result with ops\review-diff.ps1 and ops\quality-gate.ps1 (docs\QUALITY_PROTOCOL.md). Windows PowerShell 5.1.
param([Parameter(Mandatory = $true)][string]$Id)
$root = Split-Path -Parent $PSScriptRoot; Set-Location $root
$oc = "$env:APPDATA\npm\node_modules\opencode-ai\bin\opencode.exe"
$promptFile = "$root\logs\muse-direct\prompt-$Id.txt"
if (-not (Test-Path $promptFile)) { "missing $promptFile"; exit 2 }
$prompt = [System.IO.File]::ReadAllText($promptFile)
$out = "$root\logs\muse-direct\$Id.txt"
"[muse-run] $Id started $(Get-Date -Format s)" | Set-Content $out -Encoding utf8
& $oc run --dir $root --model opencode/muse-spark-1.3-contributor-free $prompt *>> $out
"[muse-run] $Id finished $(Get-Date -Format s) exit=$LASTEXITCODE" | Add-Content $out -Encoding utf8
