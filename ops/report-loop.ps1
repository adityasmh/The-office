# report-loop.ps1 - writes the facts (ops\status.ps1) to logs\status.txt every 10 minutes and keeps a history, so the morning report is ready.
$root = Split-Path -Parent $PSScriptRoot; Set-Location $root
while ($true) {
  try {
    $out = & powershell -NoProfile -ExecutionPolicy Bypass -File "$root\ops\status.ps1" 2>&1 | Out-String
    [System.IO.File]::WriteAllText("$root\logs\status.txt", $out)
    Add-Content "$root\logs\status-history.txt" ("`n===== " + (Get-Date -Format "yyyy-MM-dd HH:mm") + " =====`n" + $out) -Encoding utf8
  } catch {}
  Start-Sleep 600
}
