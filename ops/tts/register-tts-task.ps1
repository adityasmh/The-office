# ops/tts/register-tts-task.ps1 - Register the Joey TTS server as a Task Scheduler task.
#
# This is the only supported way for the live TTS server to start: it must be owned by
# Task Scheduler, never by an agent session. If the server is started from an agent's
# process tree, the agent's teardown will kill it silently.
#
# The task uses the XML in ops/tts/LayaCompanyTtsServer.xml:
#   - LogonTrigger for the current user
#   - InteractiveToken (no stored password)
#   - ExecutionTimeLimit PT0S (never killed for running too long)
#   - MultipleInstancesPolicy IgnoreNew (cannot double-start)
#   - TimeTrigger every 2 minutes as a re-arm belt
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File ops/tts/register-tts-task.ps1
#
# After registering, start the server with:
#   schtasks /run /tn LayaCompanyTtsServer

param(
  [switch]$Run
)

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
$xmlSource = [System.IO.Path]::Combine($root, 'ops', 'tts', 'LayaCompanyTtsServer.xml')
$taskName = 'LayaCompanyTtsServer'
$logDir = [System.IO.Path]::Combine($root, 'logs')

if (-not (Test-Path -LiteralPath $xmlSource)) {
  Write-Host "task XML not found: $xmlSource" -ForegroundColor Red
  exit 1
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# schtasks /create /xml requires an XML file on disk. Copy the repo XML to TEMP
# so the source file is never locked or modified by registration.
$xmlTemp = Join-Path $env:TEMP "$taskName.xml"
Copy-Item -LiteralPath $xmlSource -Destination $xmlTemp -Force

$create = & schtasks /create /tn $taskName /xml $xmlTemp /f 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "could not create scheduled task '$taskName':" -ForegroundColor Red
  $create | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
  exit 1
}

Write-Host "scheduled task '$taskName' registered." -ForegroundColor Green

if ($Run) {
  & schtasks /run /tn $taskName
  if ($LASTEXITCODE -ne 0) {
    Write-Host "could not start scheduled task '$taskName'" -ForegroundColor Red
    exit 1
  }
  Write-Host "scheduled task '$taskName' started." -ForegroundColor Green
}

Write-Host ""
Write-Host "Useful commands:" -ForegroundColor Cyan
Write-Host "  schtasks /query /tn $taskName /v /fo LIST"
Write-Host "  schtasks /run   /tn $taskName"
Write-Host "  schtasks /end   /tn $taskName"
Write-Host "  curl.exe -s http://127.0.0.1:8901/tts/health"
exit 0
