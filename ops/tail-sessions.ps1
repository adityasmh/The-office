# ops/tail-sessions.ps1 — print the live session board every N seconds, N times.
# Usage: powershell -NoProfile -File ops/tail-sessions.ps1 [-Count 12] [-Seconds 7] [-Url http://localhost:8787]

param(
  [int]$Count = 12,
  [int]$Seconds = 7,
  [string]$Url = "http://localhost:8787"
)

for ($i = 1; $i -le $Count; $i++) {
  $stamp = Get-Date -Format "HH:mm:ss"
  try {
    $s = (curl.exe -s -m 8 "$Url/company/sessions") | ConvertFrom-Json
    $rows = @($s.items | Select-Object -First 4 | ForEach-Object {
      "{0}/{1}/{2} {3} ${4} pid={5} {6}s" -f $_.agentId, $_.role, $_.status, $_.projectName, $_.costUsd, $_.pid, [math]::Round((($_.durationMs) / 1000.0), 1)
    })
    Write-Host ("[{0}] running={1} queued={2} total={3}" -f $stamp, $s.running, $s.queued, $s.total) -ForegroundColor Yellow
    foreach ($r in $rows) { Write-Host ("         $r") }
    if ($rows.Count -eq 0) { Write-Host "         (no sessions yet)" -ForegroundColor DarkGray }
  } catch {
    Write-Host ("[{0}] request failed: {1}" -f $stamp, $_.Exception.Message) -ForegroundColor Red
  }
  if ($i -lt $Count) { Start-Sleep -Seconds $Seconds }
}
