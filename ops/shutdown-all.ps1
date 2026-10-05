<#
ops/shutdown-all.ps1 - stop everything this company runs, in the order the CEO's spec
(docs/SHUTDOWN_SPEC.md §2) requires, and prove at the end that nothing of ours is left.

WHY A SEPARATE SCRIPT
The router cannot kill itself and then finish the job, and it must not tear down its own
supervisor. So the router (src/company/lifecycle.ts) pauses new work, collects the
terminals' checkpoints, writes company/snapshots/<ts>/, then spawns THIS file DETACHED and
answers the HTTP request. From here on, everything is closing.

ORDER (spec §2; every step logs what it did):
   0. log the plan, wait RouterGraceSeconds so the HTTP reply has gone out
   1. close every REAL jcode terminal window (the CEO's own window included); pid + command
      line re-checked right before the kill
   2. stop opencode workers and agents' stray test servers (not resumed)
   3. stop the shared jcode server (`jcode server stop`, then any pid it left behind)
   4. stop Laya on :8000 (the venv python child AND its launcher window)
   5. stop + disable the supervisor scheduled task (else it restarts the router)
   6. stop the ROUTER LAST - ONLY the process that owns the listener on -Port, plus that
      tree's own wrapper. Never every node.exe in the repo: a second (test) instance must
      not be able to take the live router down.
   7. verify: everything this run was responsible for; then the machine-wide scan of our
      processes (informational for a scoped/test run)

SAFETY RULES (each one exists because of a real failure mode)
  * `$pid` is a READ-ONLY automatic variable in PowerShell. An earlier revision of this
    script took a parameter named `$pid`, so EVERY kill failed with "Cannot overwrite
    variable pid" - the shutdown silently closed nothing. Parameters are `$procId` now.
  * The selector is always "a process that belongs to THIS company": this project's root,
    this project's venv, or a session named by -OnlySessionIds. A bare node.exe /
    python.exe / powershell.exe is NEVER touched.
  * This script never kills itself or its own ancestors in steps 1-4 (the router IS one of
    its ancestors, so step 6 is the one deliberate exception, and it uses Stop-Process
    without /T for exactly that reason).
  * Claude Code, Claude Desktop, browsers, editors and any other project are never touched.
  * `-OnlySessionIds` (test mode) limits step 1 to those sessions; `-Skip*` switches skip a
    whole step. Without them this is the real, full shutdown.
  * `-DryRun` prints exactly what it would do and kills nothing.

USAGE
  powershell -NoProfile -ExecutionPolicy Bypass -File ops\shutdown-all.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File ops\shutdown-all.ps1 -DryRun
  # the router calls it like this:
  ... -Port 8787 -Root <root> -SnapshotDir <snapshot> -RouterGraceSeconds 6
#>
[CmdletBinding()]
param(
  [int]$Port = 8787,
  [string]$Root,
  [string]$SnapshotDir = '',
  [string]$OnlySessionIds = '',
  [int]$RouterGraceSeconds = 6,
  [int]$PortFreeTimeoutSeconds = 25,
  [int]$TerminalCloseTimeoutSeconds = 15,
  [switch]$SkipTerminals,
  [switch]$SkipWorkers,
  [switch]$SkipJcodeServer,
  [switch]$SkipLaya,
  [switch]$SkipSupervisor,
  [switch]$SkipRouter,
  [switch]$DryRun,
  [string]$LogFile
)

$ErrorActionPreference = 'Continue'

if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
if (-not (Test-Path -LiteralPath $Root)) { throw "project root not found: $Root" }
$Root = (Resolve-Path -LiteralPath $Root).Path
$rootNorm = ($Root.Replace('/', '\')).ToLowerInvariant()
$rootPrefix = "$rootNorm\"
$venvToken = "$rootNorm\deps\venv"
$serverToken = 'src\server.ts'
$jcodeHome = if ($env:JCODE_HOME_DIR) { $env:JCODE_HOME_DIR } else { Join-Path $env:USERPROFILE '.jcode' }
$jcodeBin  = if ($env:JCODE_BIN) { $env:JCODE_BIN } else { 'jcode' }
$supervisorTask = if ($env:ROUTER_SUPERVISOR_TASK) { $env:ROUTER_SUPERVISOR_TASK } else { 'LayaCompanyRouterSupervisor' }
if (-not $LogFile) { $LogFile = Join-Path $Root 'logs\shutdown.log' }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogFile) | Out-Null

$script:ShutdownLog = $LogFile
$script:StepNo = 0
$script:StopTargets = @()   # { Label, Pid } - what this run is responsible for
$script:Stopped = @()   # { Label, Pid, Ok }

function Log([string]$msg, [string]$color = 'Gray') {
  $line = "[{0}] {1}" -f (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss.fffK'), $msg
  if (-not $DryRun) {
    try {
      $fs = New-Object System.IO.FileStream($script:ShutdownLog, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
      $sw = New-Object System.IO.StreamWriter($fs)
      $sw.Write($line + "`r`n")
      $sw.Dispose(); $fs.Dispose()
    } catch { }
  }
  Write-Host $line -ForegroundColor $color
}

function Step([string]$title) {
  $script:StepNo++
  Log ""
  Log ("=== STEP {0}: {1} ===" -f $script:StepNo, $title) 'Cyan'
}

function Normalize([string]$s) {
  if (-not $s) { return '' }
  $t = $s -replace '%20', ' '
  $t = $t -replace '/', '\'
  $t = $t -replace '\\\\', '\'
  return $t.ToLowerInvariant()
}

function Get-Procs { Get-CimInstance Win32_Process -ErrorAction SilentlyContinue }
function ProcName($p) { return ('{0}' -f $p.Name).ToLowerInvariant() }
function IsShellName([string]$n) { return ($n -match '^(powershell|pwsh|cmd|windowsterminal|conhost|wt)\.exe$') }

# This script + its ancestors: never killed in steps 1-4 (the router is one of them).
$script:SelfIds = New-Object System.Collections.Generic.List[int]
$script:SelfIds.Add([int]$PID)
$walk = [int]$PID
for ($i = 0; $i -lt 8; $i++) {
  $row = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $walk) -ErrorAction SilentlyContinue
  if (-not $row) { break }
  $parentId = [int]$row.ParentProcessId
  if ($parentId -le 0 -or $script:SelfIds.Contains($parentId)) { break }
  $script:SelfIds.Add($parentId)
  $walk = $parentId
}

function SelfProtected([int]$procId) { return $script:SelfIds.Contains($procId) }

function Note-Target([string]$label, [int]$procId) {
  if ($procId -le 0) { return }
  $script:StopTargets += [pscustomobject]@{ Label = $label; Pid = $procId }
}

function Stop-Tree([string]$label, [int]$procId, [string]$reason) {
  if ($procId -le 0) { return }
  Note-Target $label $procId
  if (SelfProtected $procId) { Log ("  refusing to stop {0} pid {1}: it hosts this script" -f $label, $procId) 'Red'; return }
  if ($DryRun) { Log ("  would stop {0} pid {1} ({2})" -f $label, $procId, $reason) 'Yellow'; return }
  try {
    $out = & taskkill.exe /PID $procId /T /F 2>&1
    $ok = ($LASTEXITCODE -eq 0)
    foreach ($l in $out) { if ($l) { Log ("    taskkill " + $l.ToString().Trim()) 'DarkGray' } }
    $script:Stopped += [pscustomobject]@{ Label = $label; Pid = $procId; Ok = $ok }
    if ($ok) { Log ("  stopped {0} pid {1} ({2})" -f $label, $procId, $reason) 'Green' }
    else { Log ("  taskkill reported failure for {0} pid {1}" -f $label, $procId) 'Red' }
  } catch {
    $script:Stopped += [pscustomobject]@{ Label = $label; Pid = $procId; Ok = $false }
    Log ("  FAILED to stop {0} pid {1}: {2}" -f $label, $procId, $_.Exception.Message) 'Red'
  }
}

function Stop-One([string]$label, [int]$procId, [string]$reason) {
  if ($procId -le 0) { return }
  Note-Target $label $procId
  if ($DryRun) { Log ("  would stop {0} pid {1} ({2})" -f $label, $procId, $reason) 'Yellow'; return }
  # No /T on purpose here: the router is stopped this way, so that THIS script (a child of
  # the router process) is not torn down with it.
  try {
    Stop-Process -Id $procId -Force -ErrorAction Stop
    $script:Stopped += [pscustomobject]@{ Label = $label; Pid = $procId; Ok = $true }
    Log ("  stopped {0} pid {1} ({2})" -f $label, $procId, $reason) 'Green'
  } catch {
    $script:Stopped += [pscustomobject]@{ Label = $label; Pid = $procId; Ok = $false }
    Log ("  could not stop {0} pid {1}: {2}" -f $label, $procId, $_.Exception.Message) 'DarkGray'
  }
}

# ---------------------------------------------------------------- header ----
Log ("=" * 78)
Log ("shutdown-all.ps1 start  pid=$PID  root=$Root  port=$Port")
Log ("  snapshot=" + $SnapshotDir + "  onlySessions='" + $OnlySessionIds + "'  dryRun=" + $DryRun + "  skips: terminals=" + $SkipTerminals + " workers=" + $SkipWorkers + " jcodeServer=" + $SkipJcodeServer + " laya=" + $SkipLaya + " supervisor=" + $SkipSupervisor + " router=" + $SkipRouter)
if ($RouterGraceSeconds -gt 0 -and -not $DryRun) {
  Log ("waiting $RouterGraceSeconds s so the router's HTTP reply reaches the dashboard first")
  Start-Sleep -Seconds $RouterGraceSeconds
}
$only = @()
if ($OnlySessionIds) {
  $only = $OnlySessionIds.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
  Log ("SCOPED RUN: only these sessions may be closed: " + ($only -join ', ')) 'Yellow'
}
$procs = Get-Procs
$procMap = @{}
foreach ($p in $procs) { $procMap[[int]$p.ProcessId] = $p }

# -------------------------------------------------- 1. terminals ------------
if (-not $SkipTerminals) {
  Step 'close every real jcode terminal window'

  $serverPids = @()
  $serversFile = Join-Path $jcodeHome 'servers.json'
  if (Test-Path -LiteralPath $serversFile) {
    try {
      $servers = Get-Content -LiteralPath $serversFile -Raw | ConvertFrom-Json
      foreach ($prop in $servers.PSObject.Properties) { if ($prop.Value.pid) { $serverPids += [int]$prop.Value.pid } }
    } catch { }
  }
  Log ("  jcode server pids (never close targets): " + $(if ($serverPids.Count) { $serverPids -join ', ' } else { '(none)' }))

  # Registry (AUTOCLOSE's allow-list): sessionId -> windowPid it already verified.
  $registry = @{}
  $regFile = Join-Path $Root 'company\terminals.json'
  if (Test-Path -LiteralPath $regFile) {
    try {
      $parsed = Get-Content -LiteralPath $regFile -Raw | ConvertFrom-Json
      $list = if ($parsed -is [System.Array]) { $parsed } else { $parsed.terminals }
      foreach ($rec in $list) { if ($rec.sessionId) { $registry[[string]$rec.sessionId] = $rec } }
    } catch { Log ("  registry unreadable: " + $_.Exception.Message) 'DarkGray' }
  }

  $termTargets = @()
  foreach ($p in $procs) {
    if ((ProcName $p) -notmatch '^jcode(\.exe)?$') { continue }
    $cmd = if ($p.CommandLine) { $p.CommandLine } else { '' }
    $low = $cmd.ToLowerInvariant()
    if ($low -match '\bserve\b' -or $low -match 'keepalive' -or $low -match 'setup-hotkey' -or $low -match '--version') { continue }
    $sessionId = ''
    if ($cmd -match '--resume\s+(session_[A-Za-z0-9_-]+)') { $sessionId = $Matches[1] }
    if (-not $sessionId) {
      $rec = Join-Path $jcodeHome ("client_sessions\" + $p.ProcessId)
      if (Test-Path -LiteralPath $rec) { $sessionId = (Get-Content -LiteralPath $rec -Raw).Trim() }
    }
    if (-not $sessionId) { Log ("  skipping jcode pid {0}: no session id on its command line or in client_sessions" -f $p.ProcessId) 'DarkGray'; continue }
    if ($only.Count -and ($only -notcontains $sessionId)) { Log ("  skipping {0} (pid {1}): not in -OnlySessionIds" -f $sessionId, $p.ProcessId) 'DarkGray'; continue }
    $short = if ($sessionId -match '^session_([a-z]+)_') { $Matches[1] } else { $sessionId }
    $windowPid = 0
    if ($registry.ContainsKey($sessionId) -and $registry[$sessionId].windowPid) { $windowPid = [int]$registry[$sessionId].windowPid }
    if (-not $windowPid -or -not $procMap.ContainsKey($windowPid)) {
      $cur = [int]$p.ProcessId
      for ($i = 0; $i -lt 10; $i++) {
        if (-not $procMap.ContainsKey($cur)) { break }
        $row = $procMap[$cur]
        if (IsShellName (ProcName $row)) { $windowPid = [int]$row.ProcessId; break }
        $ppid2 = [int]$row.ParentProcessId
        if ($ppid2 -le 0 -or $ppid2 -eq $cur) { break }
        $cur = $ppid2
      }
    }
    if ($serverPids -contains $windowPid) { Log ("  refusing to close {0}: windowPid {1} is the jcode server" -f $short, $windowPid) 'Red'; continue }
    $termTargets += [pscustomobject]@{ SessionId = $sessionId; Short = $short; ClientPid = [int]$p.ProcessId; WindowPid = $windowPid; Cmd = $cmd }
  }

  Log ("  {0} terminal(s) to close" -f $termTargets.Count)
  foreach ($t in $termTargets) {
    Log ("  - {0}  session={1}  client={2}  window={3}" -f $t.Short, $t.SessionId, $t.ClientPid, $(if ($t.WindowPid) { $t.WindowPid } else { '(none found)' }))
  }

  # Re-check each pid right before the kill: same process, still alive, still a jcode client
  # with the recorded command line. A pid that changed identity is skipped, never killed.
  foreach ($t in $termTargets) {
    $fresh = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $t.ClientPid) -ErrorAction SilentlyContinue
    if (-not $fresh) { Log ("  {0}: client pid {1} is already gone" -f $t.Short, $t.ClientPid) 'DarkGray'; continue }
    $freshCmd = if ($fresh.CommandLine) { $fresh.CommandLine } else { '' }
    if ((ProcName $fresh) -notmatch '^jcode(\.exe)?$' -or ($t.Cmd -ne $freshCmd)) {
      Log ("  {0}: pid {1} no longer matches what was recorded (reused?); skipping" -f $t.Short, $t.ClientPid) 'Red'
      continue
    }
    $winPid = $t.WindowPid
    $win = if ($winPid) { Get-CimInstance Win32_Process -Filter ("ProcessId=" + $winPid) -ErrorAction SilentlyContinue } else { $null }
    if ($win -and (IsShellName (ProcName $win))) {
      Stop-Tree ("terminal " + $t.Short) $winPid ("window hosting " + $t.SessionId)
    } else {
      Stop-Tree ("terminal " + $t.Short) $t.ClientPid "no live shell window found; closing the client tree"
    }
  }

  if (-not $DryRun) {
    $deadline = (Get-Date).AddSeconds($TerminalCloseTimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
      $alive = @($termTargets | Where-Object { $_.ClientPid -and (Get-Process -Id $_.ClientPid -ErrorAction SilentlyContinue) })
      if (-not $alive.Count) { break }
      Start-Sleep -Seconds 1
    }
    $alive = @($termTargets | Where-Object { $_.ClientPid -and (Get-Process -Id $_.ClientPid -ErrorAction SilentlyContinue) })
    if ($alive.Count) { Log ("  {0} of {1} terminal(s) still alive after {2}s: {3}" -f $alive.Count, $termTargets.Count, $TerminalCloseTimeoutSeconds, (($alive | ForEach-Object { $_.Short }) -join ', ')) 'Red' }
    else { Log ("  all {0} terminal(s) are closed" -f $termTargets.Count) 'Green' }
  }
} else { Log "STEP: terminals SKIPPED (-SkipTerminals)" 'DarkGray' }

# ------------------------------------------- 2. opencode + test servers -----
if (-not $SkipWorkers) {
  Step 'stop opencode workers and stray test servers'
  $procs = Get-Procs
  foreach ($p in $procs) {
    $name = ProcName $p
    if ($name -match '^opencode(\.exe)?$') {
      Stop-Tree "opencode worker" ([int]$p.ProcessId) "opencode worker"
      continue
    }
    if ($name -match '^node(\.exe)?$') {
      $cmd = Normalize $(if ($p.CommandLine) { $p.CommandLine } else { '' })
      if ($cmd.Contains($serverToken) -and $cmd.Contains($rootPrefix)) { continue }   # a router: STEP 6
      if ($cmd.Contains('router-supervisor')) { continue }                            # the supervisor: STEP 5
      if ($cmd.Contains($rootPrefix) -or $cmd.Contains("$rootNorm\company")) {
        Stop-Tree "stray test server" ([int]$p.ProcessId) "node started from this project"
      }
    }
  }
} else { Log "STEP: workers SKIPPED (-SkipWorkers)" 'DarkGray' }

# ----------------------------------------------- 3. jcode shared server -----
if (-not $SkipJcodeServer) {
  Step 'stop the shared jcode server'
  Log ("  running: & '{0}' server stop" -f $jcodeBin)
  if ($DryRun) {
    Log "  would run the jcode server stop command" 'Yellow'
  } else {
    try {
      $out = & $jcodeBin server stop 2>&1
      foreach ($l in $out) { if ($l) { Log ("    " + $l.ToString().Trim()) 'DarkGray' } }
    } catch {
      Log ("  jcode server stop failed (continuing): " + $_.Exception.Message) 'DarkGray'
    }
    Start-Sleep -Seconds 3
    $serversFile = Join-Path $jcodeHome 'servers.json'
    if (Test-Path -LiteralPath $serversFile) {
      try {
        $servers = Get-Content -LiteralPath $serversFile -Raw | ConvertFrom-Json
        foreach ($prop in $servers.PSObject.Properties) {
          $spid = [int]$prop.Value.pid
          if ($spid -le 0) { continue }
          if (Get-Process -Id $spid -ErrorAction SilentlyContinue) { Stop-One "jcode server" $spid "still alive after 'server stop'" }
        }
      } catch { }
    }
  }
} else { Log "STEP: jcode server SKIPPED (-SkipJcodeServer)" 'DarkGray' }

# ------------------------------------------------------------ 4. Laya -------
if (-not $SkipLaya) {
  Step 'stop Laya on :8000 (venv python child + its launcher window)'
  $procs = Get-Procs
  $layaPids = @()
  foreach ($p in $procs) {
    $cmd = Normalize $(if ($p.CommandLine) { $p.CommandLine } else { '' })
    if ((ProcName $p) -match '^python(\.exe)?$' -and $cmd.Contains('laya') -and $cmd.Contains($venvToken)) { $layaPids += [int]$p.ProcessId; continue }
    if ((ProcName $p) -match '^(cmd|powershell|pwsh)\.exe$' -and ($cmd.Contains('start-laya.bat') -or $cmd.Contains('serve-laya.ps1'))) { $layaPids += [int]$p.ProcessId }
  }
  # Anything still listening on :8000 that belongs to this project's venv python.
  $listener8000 = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener8000) {
    $lp = [int]$listener8000.OwningProcess
    $lpRow = $procMap[$lp]
    if ($lpRow -and (Normalize $lpRow.CommandLine).Contains($venvToken)) { $layaPids += $lp }
    else { Log ("  :8000 is held by pid {0} which is NOT this project's venv - left alone" -f $lp) 'Red' }
  }
  $layaPids = $layaPids | Sort-Object -Unique
  if (-not $layaPids.Count) { Log '  Laya is not running' 'DarkGray' }
  foreach ($lp in $layaPids) { Stop-Tree "Laya" $lp "python -m laya.serve (this project's venv)" }
} else { Log "STEP: Laya SKIPPED (-SkipLaya)" 'DarkGray' }

# ------------------------------------------------------ 5. supervisor -------
if (-not $SkipSupervisor) {
  Step ("stop and disable the supervisor scheduled task ({0}) - else it restarts the router" -f $supervisorTask)
  Note-Target "supervisor task" 0
  if ($DryRun) {
    Log ("  would run: schtasks /end /tn ""{0}""  then  schtasks /change /tn ""{0}"" /disable" -f $supervisorTask) 'Yellow'
  } else {
    foreach ($argSet in @(@('/end', '/tn', $supervisorTask), @('/change', '/tn', $supervisorTask, '/disable'))) {
      try {
        $out = & schtasks.exe @argSet 2>&1
        foreach ($l in $out) { if ($l) { Log ("    schtasks " + ($argSet -join ' ') + ": " + $l.ToString().Trim()) 'DarkGray' } }
      } catch {
        Log ("  schtasks {0} failed: {1}" -f ($argSet -join ' '), $_.Exception.Message) 'DarkGray'
      }
    }
    $procs = Get-Procs
    foreach ($p in $procs) {
      $cmd = Normalize $(if ($p.CommandLine) { $p.CommandLine } else { '' })
      if ($cmd.Contains('router-supervisor.ps1') -and [int]$p.ProcessId -ne $PID) {
        Stop-Tree "router supervisor" ([int]$p.ProcessId) "router-supervisor.ps1"
      }
    }
    $lock = Join-Path $Root 'logs\router-supervisor.lock'
    if (Test-Path -LiteralPath $lock) {
      try { Remove-Item -LiteralPath $lock -Force; Log "  released logs\router-supervisor.lock" 'Green' } catch { Log ("  could not remove the supervisor lock: " + $_.Exception.Message) 'DarkGray' }
    }
  }
} else { Log "STEP: supervisor SKIPPED (-SkipSupervisor)" 'DarkGray' }

# ------------------------------------------------------- 6. router LAST -----
if (-not $SkipRouter) {
  Step ("stop the router on :{0} LAST" -f $Port)
  $procs = Get-Procs
  $procMap2 = @{}
  foreach ($p in $procs) { $procMap2[[int]$p.ProcessId] = $p }

  $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  $routerPids = @()
  if ($listener) {
    $lp = [int]$listener.OwningProcess
    $lpRow = $procMap2[$lp]
    $lpCmd = Normalize $(if ($lpRow) { $lpRow.CommandLine } else { '' })
    if ($lpCmd.Contains($serverToken) -or $lpCmd.Contains($rootNorm)) {
      $routerPids += $lp
      # the wrapper that ran `tsx src/server.ts` (its parent), and the node/tsx process below
      # the wrapper: both belong to THIS listener and to nothing else.
      $cur = $lp
      for ($i = 0; $i -lt 3; $i++) {
        $row = $procMap2[$cur]
        if (-not $row) { break }
        $parentId = [int]$row.ParentProcessId
        $parent = $procMap2[$parentId]
        if (-not $parent) { break }
        $parentCmd = Normalize $(if ($parent.CommandLine) { $parent.CommandLine } else { '' })
        if (((ProcName $parent) -match '^(cmd|powershell|pwsh)\.exe$') -and ($parentCmd.Contains($serverToken) -or $parentCmd.Contains('tsx'))) {
          $routerPids += $parentId
          $cur = $parentId
          continue
        }
        break
      }
      Log ("  listener pid {0} (+ wrapper(s) {1}) is this router" -f $lp, (($routerPids | Where-Object { $_ -ne $lp }) -join ', '))
    } else {
      Log ("  :{0} is held by pid {1} which does NOT name this project - left alone" -f $Port, $lp) 'Red'
    }
  } else {
    Log ("  nothing is listening on :{0}" -f $Port) 'DarkGray'
  }
  # any leftover node/cmd of THIS port's tree that is still a router for this root is caught
  # by the port check below; processes of another instance are never touched.
  foreach ($rp in ($routerPids | Sort-Object -Unique)) { Stop-One "router" $rp ("listener/wrapper on :" + $Port) }

  if (-not $DryRun) {
    $deadline = (Get-Date).AddSeconds($PortFreeTimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
      $still = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
      if (-not $still) { break }
      Start-Sleep -Seconds 1
    }
    $still = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($still) { Log ("  :{0} is STILL listening (pid {1}) - see logs\router.crash.log" -f $Port, $still.OwningProcess) 'Red' }
    else { Log ("  :{0} is free; the router is down" -f $Port) 'Green' }
  }
} else { Log "STEP: router SKIPPED (-SkipRouter)" 'DarkGray' }

# ----------------------------------------------------------- 7. verify ------
Step 'verify: everything this run was responsible for'

$failed = @()
foreach ($t in $script:StopTargets) {
  if ($t.Pid -le 0) { continue }
  if (Get-Process -Id $t.Pid -ErrorAction SilentlyContinue) { $failed += $t }
}
if ($failed.Count -eq 0) {
  Log ("  END STATE: every target of this run is gone ({0} stopped)" -f $script:Stopped.Count) 'Green'
} else {
  Log ("  END STATE: {0} target(s) are STILL running:" -f $failed.Count) 'Red'
  foreach ($f in $failed) { Log ("    {0} pid {1}" -f $f.Label, $f.Pid) 'Red' }
}

$procs = Get-Procs
$ours = @()
foreach ($p in $procs) {
  $name = ProcName $p
  $cmd = Normalize $(if ($p.CommandLine) { $p.CommandLine } else { '' })
  $why = ''
  if ($name -match '^jcode(\.exe)?$' -and $cmd -notmatch '\bserve\b' -and $cmd -notmatch 'keepalive' -and $cmd -notmatch 'setup-hotkey') { $why = 'jcode terminal' }
  elseif ($name -match '^opencode(\.exe)?$') { $why = 'opencode worker' }
  elseif ($name -match '^python(\.exe)?$' -and $cmd.Contains('laya') -and $cmd.Contains($venvToken)) { $why = 'Laya' }
  elseif (($name -match '^(node|cmd)\.exe$') -and $cmd.Contains($serverToken) -and $cmd.Contains($rootPrefix)) { $why = 'router' }
  if ($why -and [int]$p.ProcessId -ne $PID) { $ours += [pscustomobject]@{ Pid = [int]$p.ProcessId; Name = $p.Name; Why = $why } }
}
Log ("  machine-wide scan of our processes: {0} still running" -f $ours.Count)
foreach ($o in $ours) { Log ("    pid {0,-7} {1}  ({2})" -f $o.Pid, $o.Name, $o.Why) 'DarkGray' }
if ($ours.Count -eq 0) { Log '  nothing of ours is left running' 'Green' }
elseif ($OnlySessionIds) { Log '  (this was a SCOPED run: the processes above belong to other instances/sessions and were never targets)' 'Yellow' }

Log ("shutdown-all.ps1 done  (log: {0})" -f $LogFile)
Log ("=" * 78)
exit 0
