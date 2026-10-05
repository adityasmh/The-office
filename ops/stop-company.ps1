# ops/stop-company.ps1 - stop ONLY this company's own processes.
#
# Selector (verified against live processes - see docs/CEO_RUNBOOK.md):
#   Router   : node.exe / cmd.exe whose normalized command line names THIS project
#              root AND launches "src\server.ts". That covers the live npm/tsx chain:
#                cmd.exe  /d /s /c tsx src/server.ts                 (chain wrapper)
#                node.exe ...\node_modules\.bin\..\tsx\dist\cli.mjs src/server.ts
#                node.exe --require ...\tsx\dist\preflight.cjs ...  src/server.ts
#              ("%20" URL-encoding and "/" separators are normalized; the chain
#               wrapper is included only when its child is already a proven match.)
#   Laya     : only with -IncludeLaya: python.exe whose command line contains
#              "laya.serve" AND this project's "deps\venv" python path.
#              A Laya server started from a DIFFERENT python (e.g. the global
#              Python311 install) is deliberately NOT touched.
#
# Safety rules baked in:
#   - never matches a bare "node.exe"; the command line must carry THIS project
#   - never touches itself or its own parent chain (launcher cmd/powershell)
#   - never touches opencode.exe / claude / VS Code helpers / other projects
#   - -WhatIf (or -DryRun) lists exactly what WOULD be stopped and kills nothing
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File ops\stop-company.ps1 -DryRun
#   powershell -NoProfile -ExecutionPolicy Bypass -File ops\stop-company.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File ops\stop-company.ps1 -IncludeLaya

[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Low')]
param(
  [switch]$IncludeLaya,
  [switch]$DryRun,
  [string]$Root
)

$ErrorActionPreference = 'Stop'

if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
if (-not (Test-Path -LiteralPath $Root)) { throw "project root not found: $Root" }
$Root = (Resolve-Path -LiteralPath $Root).Path

# Keep -WhatIf quiet: module autoloading (Get-CimInstance) would otherwise echo
# "What if: Performing the operation Set Alias ...". Restored before ShouldProcess.
$whatIfSaved = $WhatIfPreference
$WhatIfPreference = $false

$rootNorm  = $Root.Replace('/', '\').ToLowerInvariant()
$rootToken = "$rootNorm\src\server.ts"
$rootPrefix = "$rootNorm\"   # pins the match to the root + a separator (so
                               # "...Default Project 2" cannot false-positive)
$venvToken = "$rootNorm\deps\venv"
$scriptToken = 'src\server.ts'

function ConvertTo-Normalized([string]$s) {
  if (-not $s) { return '' }
  $t = $s -replace '%20', ' '
  $t = $t -replace '/', '\'
  $t = $t -replace '\\\\', '\'
  return $t.ToLowerInvariant()
}

$all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue

# --- never stop ourselves or our own parent chain -------------------------
$selfIds = New-Object System.Collections.Generic.List[int]
$selfIds.Add([int]$PID)
$map = @{}
foreach ($p in $all) { $map[[int]$p.ProcessId] = $p }
$cur = [int]$PID
for ($i = 0; $i -lt 8; $i++) {
  if (-not $map.ContainsKey($cur)) { break }
  $ppid = [int]$map[$cur].ParentProcessId
  if ($ppid -le 0 -or $selfIds.Contains($ppid)) { break }
  $selfIds.Add($ppid)
  $cur = $ppid
}

function Test-Excluded($proc) {
  if (-not $proc) { return $true }
  if ($selfIds.Contains([int]$proc.ProcessId)) { return $true }
  $cl = $proc.CommandLine
  if ($cl -and $cl -like '*stop-company*') { return $true }
  return $false
}

# --- selectors ------------------------------------------------------------
$routerHits = @()
$layaHits = @()
$layaForeign = @()

foreach ($p in $all) {
  if (-not $p.CommandLine) { continue }
  $norm = ConvertTo-Normalized $p.CommandLine
  $name = ('{0}' -f $p.Name).ToLowerInvariant()

  # router: this project's root AND the server.ts entrypoint
  if (($name -eq 'node.exe' -or $name -eq 'cmd.exe') -and $norm.Contains($scriptToken) -and $norm.Contains($rootPrefix)) {
    if (Test-Excluded $p) { continue }
    $routerHits += $p
    continue
  }

  # laya: python + laya.serve + this project's venv
  if ($name -eq 'python.exe' -and $norm.Contains('laya.serve')) {
    if (Test-Excluded $p) { continue }
    if ($norm.Contains($venvToken)) { $layaHits += $p } else { $layaForeign += $p }
  }
}

# chain wrapper: the cmd.exe that ran "tsx src/server.ts" (relative, so it carries
# no root in its own command line). Include it only when its descendant is a
# proven router match - that keeps the selector specific.
foreach ($hit in @($routerHits)) {
  $cur = [int]$hit.ParentProcessId
  for ($i = 0; $i -lt 3; $i++) {
    if (-not $map.ContainsKey($cur)) { break }
    $par = $map[$cur]
    if (Test-Excluded $par) { break }
    $parNorm = ConvertTo-Normalized $par.CommandLine
    $parName = ('{0}' -f $par.Name).ToLowerInvariant()
    $already = @($routerHits | Where-Object { [int]$_.ProcessId -eq [int]$par.ProcessId }).Count -gt 0
    if (-not $already -and $parName -eq 'cmd.exe' -and $parNorm.Contains('tsx') -and $parNorm.Contains($scriptToken)) {
      $routerHits += $par
      break
    }
    if ($parNorm.Contains($scriptToken) -and $parNorm.Contains($rootPrefix)) { break }  # another router node
    $cur = [int]$par.ParentProcessId
  }
}

function Show-Hits([string]$label, $hits) {
  Write-Host ("  {0} ({1})" -f $label, @($hits).Count) -ForegroundColor Magenta
  if (@($hits).Count -eq 0) { Write-Host '    (none)' -ForegroundColor DarkGray; return }
  foreach ($h in $hits) {
    $cl = ConvertTo-Normalized $h.CommandLine
    if ($cl.Length -gt 130) { $cl = $cl.Substring(0, 130) + '...' }
    Write-Host ("    pid {0,-7} ppid {1,-7} {2,-12} {3}" -f $h.ProcessId, $h.ParentProcessId, $h.Name, $cl) -ForegroundColor Gray
  }
}

Write-Host ''
Write-Host '  LAYA AI COMPANY - stop (this project only)' -NoNewline -ForegroundColor Black -BackgroundColor Yellow
Write-Host ("   root: {0}" -f $Root) -ForegroundColor Yellow
Write-Host ("  selector: router = '{0}' OR (root + '{1}')   laya = '{2}' + 'laya.serve'{3}" -f $rootToken, $scriptToken, $venvToken, $(if ($IncludeLaya) { ' [INCLUDED]' } else { ' [not requested]' })) -ForegroundColor DarkGray
Write-Host ''
Show-Hits 'router / dashboard processes matched' $routerHits
if ($IncludeLaya) {
  Show-Hits 'Laya processes matched' $layaHits
} elseif (@($layaHits).Count -gt 0) {
  Show-Hits 'Laya processes HELD BACK (add -IncludeLaya to stop these)' $layaHits
} else {
  Write-Host '  Laya processes matched: (none running from this project venv)' -ForegroundColor DarkGray
}
if (@($layaForeign).Count -gt 0) {
  Show-Hits 'laya.serve NOT from this project venv - left untouched' $layaForeign
}
Write-Host ''

$targets = @()
$targets += $routerHits
if ($IncludeLaya) { $targets += $layaHits }

if (@($targets).Count -eq 0) {
  Write-Host '  nothing to stop - no matching process is running.' -ForegroundColor Green
  Write-Host '  (unrelated node.exe / opencode / VS Code processes are never selected)' -ForegroundColor DarkGray
  Write-Host ''
  exit 0
}

$WhatIfPreference = $whatIfSaved
$dryish = $DryRun -or ($whatIfSaved -eq $true)

$stopped = @()
foreach ($t in $targets) {
  $what = "{0} (pid {1})" -f $t.Name, $t.ProcessId
  if ($DryRun) {
    Write-Host ("  would stop  pid {0,-7} {1}" -f $t.ProcessId, $t.Name) -ForegroundColor Yellow
    continue
  }
  if ($PSCmdlet.ShouldProcess($what, 'Stop-Process -Force')) {
    try {
      Stop-Process -Id ([int]$t.ProcessId) -Force -ErrorAction Stop
      $stopped += $t
      Write-Host ("  stopped  pid {0,-7} {1}" -f $t.ProcessId, $t.Name) -ForegroundColor Green
    } catch {
      Write-Host ("  FAILED   pid {0,-7} {1}  {2}" -f $t.ProcessId, $t.Name, $_.Exception.Message) -ForegroundColor Red
    }
  }
}

Write-Host ''
if ($dryish) {
  Write-Host ("  DRY RUN (-WhatIf/-DryRun): listed {0} matching process(es), killed NOTHING." -f @($targets).Count) -ForegroundColor Yellow
  Write-Host '  Re-run without -WhatIf to actually stop exactly these PIDs.' -ForegroundColor DarkGray
} else {
  Write-Host ("  stopped {0} of {1} matched process(es)." -f @($stopped).Count, @($targets).Count) -ForegroundColor Green
  Write-Host '  Nothing else was touched. Watcher windows are read-only: close them with Ctrl+C.' -ForegroundColor DarkGray
}
Write-Host ''
exit 0
