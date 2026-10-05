<#
ops/start-all.ps1 - start the whole company again after a planned shutdown, in the order
docs/SHUTDOWN_SPEC.md §3 requires, and hand the CEO back to the dashboard.

  1. start Laya (scripts\serve-laya.ps1, its own window) and wait for /health
  2. enable + start the supervisor scheduled task (LayaCompanyRouterSupervisor) and wait
     for the router's /health
  3. open http://127.0.0.1:<port>/v2/#/system in the default browser, where the System page
     shows the latest snapshot and its "Resume all" button

`shutdown-all.ps1` DISABLES the supervisor task on purpose (otherwise it would restart the
router while the shutdown was still closing things), so step 2 always re-enables it first.

Idempotent: anything already healthy is reused, nothing is ever killed here.

USAGE
  powershell -NoProfile -ExecutionPolicy Bypass -File ops\start-all.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File ops\start-all.ps1 -NoBrowser -Quiet
  powershell -NoProfile -ExecutionPolicy Bypass -File ops\start-all.ps1 -InstallShortcut
  # a throwaway instance (the SHUTDOWN proof): -Port 8791 -RouterLauncher <ps1> -SkipLaya -SkipSupervisor
#>
[CmdletBinding()]
param(
  [string]$Root,
  [int]$Port = 8787,
  [int]$TimeoutSec = 180,
  [switch]$NoBrowser,
  [switch]$Quiet,
  [switch]$SkipLaya,
  [switch]$SkipSupervisor,
  [switch]$InstallShortcut,
  # Start the router with this script instead of the supervisor task (used by the
  # SHUTDOWN proof to bring up a test router on another port / temp COMPANY_ROOT).
  [string]$RouterLauncher = '',
  [string]$LogFile
)

$ErrorActionPreference = 'Continue'

if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
if (-not (Test-Path -LiteralPath $Root)) { throw "project root not found: $Root" }
$Root = (Resolve-Path -LiteralPath $Root).Path
if (-not $LogFile) { $LogFile = Join-Path $Root 'logs\shutdown.log' }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogFile) | Out-Null

$supervisorTask = if ($env:ROUTER_SUPERVISOR_TASK) { $env:ROUTER_SUPERVISOR_TASK } else { 'LayaCompanyRouterSupervisor' }
$systemUrl = "http://127.0.0.1:$Port/v2/#/system"
$routerHealth = "http://127.0.0.1:$Port/health"
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $ps)) { $ps = 'powershell.exe' }

function Log([string]$msg, [string]$color = 'Gray') {
  $line = "[{0}] {1}" -f (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss.fffK'), $msg
  try {
    $fs = New-Object System.IO.FileStream($LogFile, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
    $sw = New-Object System.IO.StreamWriter($fs)
    $sw.Write($line + "`r`n"); $sw.Dispose(); $fs.Dispose()
  } catch { }
  if (-not $Quiet) { Write-Host $line -ForegroundColor $color }
}

function Test-Health([string]$url, [int]$timeoutSec = 5) {
  try {
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec $timeoutSec
    return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300)
  } catch { return $false }
}

function Wait-Health([string]$url, [string]$what, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Health $url) { return $true }
    Start-Sleep -Seconds 2
  }
  return (Test-Health $url)
}

# ---------------------------------------------------- the Desktop shortcut --
if ($InstallShortcut) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $lnk = Join-Path $desktop 'Start Laya Company.lnk'
  try {
    $shell = New-Object -ComObject WScript.Shell
    $sc = $shell.CreateShortcut($lnk)
    $sc.TargetPath = $ps
    $sc.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $Root 'ops\start-all.ps1') + '"'
    $sc.WorkingDirectory = $Root
    $sc.IconLocation = "$env:SystemRoot\System32\shell32.dll,137"   # a green "play" arrow
    $sc.Description = 'Start the Laya AI Company (Laya, router, supervisor, dashboard)'
    $sc.Save()
    Log ("desktop shortcut written: " + $lnk) 'Green'
  } catch {
    Log ("could not write the desktop shortcut: " + $_.Exception.Message) 'Red'
  }
}

Log ("=" * 78)
Log ("start-all.ps1 start  root=$Root  port=$Port")

# ------------------------------------------------------------ 1. Laya -------
if (-not $SkipLaya) {
  if (Test-Health 'http://127.0.0.1:8000/health' 3) {
    Log '  [1/3] Laya    :8000 already healthy - reusing' 'Green'
  } else {
    $serveLaya = Join-Path $Root 'scripts\serve-laya.ps1'
    if (Test-Path -LiteralPath $serveLaya) {
      Log '  [1/3] Laya    :8000 not answering - opening scripts\serve-laya.ps1 in its own window' 'Yellow'
      $inner = "`$Host.UI.RawUI.WindowTitle='Laya decision server (8000)'; & '$serveLaya'"
      Start-Process -FilePath $ps -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -NoExit -Command "' + $inner + '"') -WorkingDirectory $Root | Out-Null
      if (Wait-Health 'http://127.0.0.1:8000/health' 'Laya' $TimeoutSec) { Log '  [1/3] Laya    :8000 healthy' 'Green' }
      else { Log '  [1/3] Laya    :8000 did NOT answer in time (the company still starts; Laya is only the decision brain)' 'Red' }
    } else {
      Log ("  [1/3] Laya    missing " + $serveLaya + ' - skipped') 'Red'
    }
  }
} else { Log '  [1/3] Laya    SKIPPED (-SkipLaya)' 'DarkGray' }

# -------------------------------------------------------- 2. router ---------
if (Test-Health $routerHealth 3) {
  Log ("  [2/3] Router  :{0} already healthy - reusing" -f $Port) 'Green'
} else {
  if ($RouterLauncher) {
    Log ("  [2/3] Router  :{0} not answering - starting it with {1}" -f $Port, $RouterLauncher) 'Yellow'
    Start-Process -FilePath $ps -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "' + $RouterLauncher + '"') -WorkingDirectory $Root -WindowStyle Hidden | Out-Null
  } elseif (-not $SkipSupervisor) {
    Log ("  [2/3] Router  :{0} not answering - enabling + starting the supervisor task {1}" -f $Port, $supervisorTask) 'Yellow'
    foreach ($argSet in @(@('/change', '/tn', $supervisorTask, '/enable'), @('/run', '/tn', $supervisorTask))) {
      try {
        $out = & schtasks.exe @argSet 2>&1
        foreach ($l in $out) { if ($l) { Log ("        schtasks " + ($argSet -join ' ') + ": " + $l.ToString().Trim()) 'DarkGray' } }
      } catch {
        Log ("  schtasks {0} failed: {1}" -f ($argSet -join ' '), $_.Exception.Message) 'Red'
      }
    }
    $detached = Join-Path $PSScriptRoot 'run-server-detached.ps1'
    if (-not (Wait-Health $routerHealth 'router' 25) -and (Test-Path -LiteralPath $detached)) {
      Log '  the task did not bring the router up in 25s - falling back to ops\run-server-detached.ps1' 'Yellow'
      & powershell -NoProfile -ExecutionPolicy Bypass -File $detached | ForEach-Object { Log ("        " + $_) 'DarkGray' }
    }
  } else {
    Log ("  [2/3] Router  :{0} not answering and -SkipSupervisor was given - nothing to start" -f $Port) 'Red'
  }
  if (Wait-Health $routerHealth 'router' $TimeoutSec) { Log ("  [2/3] Router  :{0} healthy" -f $Port) 'Green' }
  else { Log ("  [2/3] Router  :{0} did NOT answer within {1}s - check logs\router.out.log / logs\router.err.log" -f $Port, $TimeoutSec) 'Red' }
}

# ------------------------------------------------- 3. dashboard + hint ------
if (Test-Health $routerHealth 3) {
  Log ("  [3/3] System  page: " + $systemUrl) 'Green'
  if (-not $NoBrowser) {
    try { Start-Process $systemUrl | Out-Null; Log '  opened the System page in the default browser' 'Cyan' } catch { Log ("  could not open the browser: " + $_.Exception.Message) 'DarkGray' }
  }
  Log ''
  Log '  The System page shows the latest snapshot: tick the terminals you want back and press "Resume all".' 'White'
  Log ('  Nothing is resumed automatically: terminals start again only when you ask for them.') 'DarkGray'
} else {
  Log ''
  Log '  THE COMPANY DID NOT COME UP. Check:' 'Red'
  Log '    - logs\router.out.log / logs\router.err.log (router)' 'DarkGray'
  Log '    - the Laya window (python -m laya.serve) if :8000 is down' 'DarkGray'
  Log ("    - is the supervisor task still disabled? schtasks /query /tn " + $supervisorTask) 'DarkGray'
  Log ("start-all.ps1 done (log: " + $LogFile + ")")
  Log ("=" * 78)
  exit 1
}
Log ("start-all.ps1 done (log: " + $LogFile + ")")
Log ("=" * 78)
exit 0
