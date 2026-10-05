# ops/watch-company.ps1 — live mission control for the local AI company.
# Reads company/sessions.jsonl, company/budgets.json and per-project thread.jsonl
# and repaints a terminal dashboard every few seconds. Read-only, never writes.

param(
  [string]$Root = "C:\Users\user\Desktop\Default Project",
  [int]$IntervalSec = 4,
  [int]$ThreadLines = 8
)

$company = Join-Path $Root "company"
$sessionsFile = Join-Path $company "sessions.jsonl"
$budgetsFile = Join-Path $company "budgets.json"

function Get-LiveSessions {
  if (-not (Test-Path $sessionsFile)) { return @() }
  $byId = @{}
  foreach ($line in (Get-Content $sessionsFile -ErrorAction SilentlyContinue)) {
    if (-not $line.Trim()) { continue }
    try { $r = $line | ConvertFrom-Json } catch { continue }
    if ($r.id) { $byId[$r.id] = $r }
  }
  $all = $byId.Values | Sort-Object { $_.startedAt } -Descending
  return $all
}

function Get-BudgetSummary {
  if (-not (Test-Path $budgetsFile)) { return $null }
  try { return (Get-Content $budgetsFile -Raw | ConvertFrom-Json) } catch { return $null }
}

function Get-ThreadTail {
  $rows = @()
  foreach ($dir in (Get-ChildItem $company -Directory -ErrorAction SilentlyContinue)) {
    $t = Join-Path $dir.FullName "thread.jsonl"
    if (Test-Path $t) {
      $rows += Get-Content $t -Tail 4 -ErrorAction SilentlyContinue | ForEach-Object {
        try { $o = $_ | ConvertFrom-Json; [pscustomobject]@{ p = $dir.Name; ts = $o.ts; who = $o.agent; role = $o.role; kind = $o.kind; text = ($o.text -replace "\s+", " ") } } catch { $null }
      }
    }
  }
  $rows | Where-Object { $_ } | Sort-Object ts -Descending | Select-Object -First $ThreadLines
}

while ($true) {
  Clear-Host
  $now = Get-Date -Format "HH:mm:ss"
  $sessions = Get-LiveSessions
  $running = @($sessions | Where-Object { $_.status -eq 'running' })
  $queued = @($sessions | Where-Object { $_.status -eq 'queued' })
  $budgets = Get-BudgetSummary

  Write-Host "  LAYA AI COMPANY - MISSION CONTROL " -NoNewline -ForegroundColor Black -BackgroundColor Cyan
  Write-Host "  $now" -ForegroundColor Cyan
  Write-Host ("  sessions: {0} running   {1} queued   {2} total" -f $running.Count, $queued.Count, $sessions.Count) -ForegroundColor Yellow
  if ($budgets) {
    $alloc = 0.0; $spent = 0.0
    foreach ($k in $budgets.agents.PSObject.Properties.Name) {
      $alloc += [double]$budgets.agents.$k.allocatedUsd
      $spent += [double]$budgets.agents.$k.spentUsd
    }
    Write-Host ("  budget: ${0:N2} allocated   ${1:N4} spent   ${2:N2} remaining" -f $alloc, $spent, ($alloc - $spent)) -ForegroundColor Green
  }
  Write-Host ""

  Write-Host "  RUNNING SESSIONS" -ForegroundColor Magenta
  if ($running.Count -eq 0) { Write-Host "    (none)" -ForegroundColor DarkGray }
  foreach ($s in $running) {
    $elapsed = ""
    if ($s.startedAt) { try { $elapsed = ("{0:mm\:ss}" -f ((Get-Date) - [datetime]$s.startedAt)) } catch { } }
    Write-Host ("    {0,-22} {1,-16} {2,-14} {3}" -f $s.agentName, $s.role, $elapsed, ($s.taskTitle -replace "\s+", " ").Substring(0, [Math]::Min(60, ($s.taskTitle -replace "\s+", " ").Length))) -ForegroundColor White
    Write-Host ("      dept={0}  project={1}  model={2}  runtime={3}  cost=${4}" -f $s.departmentName, $s.projectName, $s.model, $s.runtime, $s.costUsd) -ForegroundColor DarkGray
  }
  Write-Host ""

  Write-Host "  AGENT BUDGETS" -ForegroundColor Magenta
  if ($budgets) {
    foreach ($k in ($budgets.agents.PSObject.Properties.Name | Sort-Object)) {
      $a = $budgets.agents.$k
      $remaining = [double]$a.allocatedUsd - [double]$a.spentUsd
      $color = if ($remaining -le 0) { "Red" } elseif ($remaining -lt ([double]$a.allocatedUsd * 0.25)) { "Yellow" } else { "Green" }
      Write-Host ("    {0,-30} alloc ${1,7:N2}  spent ${2,8:N4}  left ${3,7:N2}" -f $k, [double]$a.allocatedUsd, [double]$a.spentUsd, $remaining) -ForegroundColor $color
    }
  }
  else { Write-Host "    (no budgets.json yet)" -ForegroundColor DarkGray }
  Write-Host ""

  Write-Host "  LATEST COMPANY CHATTER" -ForegroundColor Magenta
  foreach ($t in (Get-ThreadTail)) {
    $txt = $t.text
    if ($txt.Length -gt 110) { $txt = $txt.Substring(0, 110) + "..." }
    Write-Host ("    [{0}] {1}/{2}: {3}" -f $t.p, $t.who, $t.role, $txt) -ForegroundColor Gray
  }
  Start-Sleep -Seconds $IntervalSec
}
