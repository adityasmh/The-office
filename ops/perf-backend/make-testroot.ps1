# PERF-BACKEND test root builder (2026-09-29).
#
# Creates a throw-away COMPANY_ROOT that contains the REAL live data files that the
# dashboard read paths touch (org.json, budgets.json, sessions.jsonl, per-project
# tasks.json / thread.jsonl / cost.jsonl, company memory notes + graph.json) but
# never the multi-hundred-MB project repo trees or the graphify build caches.
#
# Usage:  powershell -NoProfile -File ops\perf-backend\make-testroot.ps1 [-Dest <dir>]
# Prints the created root on the last line.
param(
  [string]$Dest = (Join-Path $env:TEMP "jcode-perfbe\company")
)

$src = Join-Path (Get-Location) "company"
if (-not (Test-Path $src)) { throw "run this from the repo root (company/ not found)" }
$src = (Resolve-Path $src).Path

if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
New-Item -ItemType Directory -Force -Path $Dest | Out-Null

# Root-level files the dashboard reads.
foreach ($f in @("org.json", "budgets.json", "sessions.jsonl", "terminals.json", "assistant.jsonl", "slack-inbound.json", "fleet")) {
  $from = Join-Path $src $f
  if (Test-Path $from) { Copy-Item -Recurse -Force $from (Join-Path $Dest $f) }
}

# Per-project hot files only.
$pDst = Join-Path $Dest "projects"
New-Item -ItemType Directory -Force -Path $pDst | Out-Null
Get-ChildItem (Join-Path $src "projects") -Directory | ForEach-Object {
  $out = Join-Path $pDst $_.Name
  New-Item -ItemType Directory -Force -Path $out | Out-Null
  foreach ($f in @("tasks.json", "thread.jsonl", "cost.jsonl")) {
    $from = Join-Path $_.FullName $f
    if (Test-Path $from) { Copy-Item -Force $from (Join-Path $out $f) }
  }
}

# Company memory: notes + the graph.json that /company/memory/status parses.
$mDst = Join-Path $Dest "memory"
New-Item -ItemType Directory -Force -Path $mDst | Out-Null
Get-ChildItem (Join-Path $src "memory") -File | Where-Object { $_.Name -notlike "*.html" } | ForEach-Object {
  Copy-Item -Force $_.FullName (Join-Path $mDst $_.Name)
}
Get-ChildItem (Join-Path $src "memory") -Directory | Where-Object { $_.Name -ne ".graphify-build" } | ForEach-Object {
  Copy-Item -Recurse -Force $_.FullName (Join-Path $mDst $_.Name)
}
# Drop the graphify AST cache and the (large) interactive graph html from the copy.
Remove-Item -Recurse -Force (Join-Path $mDst "graphify-out\cache") -ErrorAction SilentlyContinue
Remove-Item -Force (Join-Path $mDst "graphify-out\graph.html") -ErrorAction SilentlyContinue

$bytes = (Get-ChildItem $Dest -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ("test root: {0}  ({1:N0} bytes)" -f $Dest, $bytes)
$Dest
