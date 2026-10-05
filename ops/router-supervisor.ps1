# ops/router-supervisor.ps1 - keep exactly ONE router alive on 127.0.0.1:8787.
#
# WHY THIS EXISTS (CRASHFIX, 2026-09-29)
# The router died silently at least three times today. Either cause - an agent
# running `ops/run-server-detached.ps1 -Stop` / `Stop-Process` / `taskkill`, or an
# agent's tool-call tree being torn down - terminates node with TerminateProcess,
# which runs NO JavaScript: no stack, no stderr, nothing in logs/router.err.log.
# A process can never defend itself against that, so the fix is not a guess about
# the killer: it is to stop depending on who started the router. This supervisor
# is the only thing allowed to own the router process, and it is started by the
# Windows Task Scheduler (see ops/run-server-detached.ps1), so it does not belong
# to any agent's or terminal's process tree.
#
# WHAT IT DOES
#   * single-instance lock (logs/router-supervisor.lock, PID identity checked)
#   * heartbeat (logs/router-supervisor.heartbeat, ISO stamp + own pid, one beat
#     per $HeartbeatSeconds) written from a path with no WMI and no CIM, so a
#     contended WMI/CIM call can never be why this process goes silent; the
#     separate, dependency-free ops/supervisor-watchdog.ps1 recovers a supervisor
#     whose heartbeat has gone stale while nothing answers on the port
#   * if 127.0.0.1:$Port serves a HEALTHY router -> do nothing but watch
#     (never a second listener on the same port, never a second Slack bridge)
#   * if nothing is listening -> start `npx tsx src/server.ts`, appending to
#     logs/router.out.log / logs/router.err.log
#   * wait for the child to exit, write the exit code + how long it ran to
#     logs/router.crash.log, restart after 3s (backoff to 30s after rapid crashes)
#
# PERF FIX (2026-09-30) - "alive but starved" is not "dead"
# Measured against logs/router.supervisor.log: the old watchdog treated
# "the port has a listener but GET /health is not ok" as "the router is dead" and
# killed it after 5 minutes of no /health answer. That guaranteed an outage - the
# observed restart windows were 7.9 s, 26.3 s, 109.6 s, 118.3 s and 48 s, and the
# dashboard cannot load at all during them. The router's real failure mode is
# "alive but the event loop is starved", not "dead", and a port with a listener is
# strong evidence of a live process: killing it turns a slow router into no router.
#
# /health (since 2026-09-29; src/server.ts ~269, eventLoopLag() in
# src/company/cache.ts) now returns lag fields, so the supervisor can tell a busy
# router from a gone one:
#     { ok, claude, credsPresent, mock, bind, authTokenConfigured,
#       lagMs, lagMaxMs, lagP95Ms, lagSamples }
#   lagMs    = how late the last 250 ms timer actually fired
#   lagP95Ms = p95 of that over the last 60 s window
#   lagMaxMs = worst since boot
#
# The decision rule implemented below:
#   listener? /health answered? -> action
#   no        no                -> nothing is there; start the router (after an
#                                  authoritative Get-NetTCPConnection double-check,
#                                  so a race can never start a second router)
#   yes       yes, ok=true      -> healthy; watch, never touch it
#   yes       yes, ok!=true or  -> ALIVE (a response came back, even a slow one);
#             non-JSON/empty        back off, log the lag, NEVER replace
#   yes       no answer         -> possible hang; count CONTINUOUS no-answer time
#                                  and only replace after the (long) threshold,
#                                  and only if free physical RAM is not below the
#                                  router's own MIN_FREE_RAM_MB floor
#
# Config:
#   ROUTER_SUPERVISOR_REPLACE_AFTER_MIN  continuous no-/health-answer minutes
#                                        before a replace is even considered
#                                        (default 30; the old hard-coded 5 was
#                                        below the observed starvation windows)
#   MIN_FREE_RAM_MB                      the router's own RAM floor (default
#                                        2048; 0 disables the guard). While free
#                                        physical RAM is below it, the supervisor
#                                        refuses to REPLACE an unresponsive
#                                        listener: restarting on a starved box
#                                        just re-starves it. It has never gated
#                                        STARTING the router - when nothing is
#                                        listening the router is started whatever
#                                        the free RAM is, so this floor can never
#                                        be why nothing is listening. Resolution
#                                        order: process environment, then this
#                                        repo's .env (dotenv-style, the same file
#                                        the router loads), then the default.
#
# Usage (normally started by the scheduled task, not by hand):
#   powershell -NoProfile -ExecutionPolicy Bypass -File ops/router-supervisor.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File ops/router-supervisor.ps1 -Status
#   powershell -NoProfile -ExecutionPolicy Bypass -File ops/router-supervisor.ps1 -DryRun
#   powershell -NoProfile -ExecutionPolicy Bypass -File ops/router-supervisor.ps1 -Once
#   powershell -NoProfile -ExecutionPolicy Bypass -File ops/router-supervisor.ps1 -Stop
#   powershell -NoProfile -ExecutionPolicy Bypass -File ops/router-supervisor.ps1 -Force
#     (-Force replaces an UNANSWERED listener immediately, ignoring the threshold
#      and the RAM floor; it never replaces a listener that answered /health)

[CmdletBinding()]
param(
  [int]$Port = 8787,
  [int]$PollSeconds = 3,
  [int]$BackoffSeconds = 3,
  [int]$MaxBackoffSeconds = 30,
  # How long a just-started router gets to answer /health before the supervisor
  # says so in the log. It never KILLS a still-running launch (see the wait loop
  # below), it only stops claiming "healthy" window-wise. 300 was measured too
  # small on 2026-10-01: under process-creation starvation the same cold start
  # that takes ~20 s healthy took 11 min 28 s (BOOT at 686 s), so 300 only ever
  # produced a misleading "did NOT become healthy within 300 s" line.
  [int]$StartupTimeoutSeconds = 900,
  # This host has been measured at 18s for a single /health response while other
  # agents pile work on it, so "no answer in 5s" must never be read as "dead".
  [int]$HealthTimeoutSeconds = 20,
  # A listener that never answers for this long may be hung, not just slow, and is
  # then replaced - but only if free RAM allows it (see $ramFloor). [double] so a
  # test instance can use a fraction of a minute. Overridden by
  # ROUTER_SUPERVISOR_REPLACE_AFTER_MIN when the env var is set and the param is
  # not passed explicitly.
  [double]$UnresponsiveMinutes = 30,
  # lagP95Ms at/above which an answering router is logged as "SLOW"/lagging (it is
  # never replaced for it; this only changes the wording and adds the lag numbers).
  [int]$LagWarnMs = 2000,
  # How long the free-RAM floor may HOLD a wedged router before the supervisor
  # replaces it anyway. 0 = hold forever. Without this cap a host that sits below
  # MIN_FREE_RAM_MB (this one does: ~1.7 GB free vs a 2048 MB floor) could never
  # recover a genuinely wedged router, so the dashboard would stay down for good.
  [int]$MaxRamHoldMinutes = 60,
  # Isolated-instance extras (defaults = the live router, unchanged):
  #   -LogPrefix  names the log/lock files (logs/<prefix>.out.log, ...)
  #   -ChildEnv   extra environment for the router child, e.g.
  #               -ChildEnv @{ SLACK_BRIDGE = '0'; COMPANY_ROOT = 'C:\tmp\copy' }
  [string]$LogPrefix = 'router',
  [hashtable]$ChildEnv = @{},
  # HEARTBEAT (2026-10-01). The supervisor writes logs\<LogPrefix>-supervisor.heartbeat
  # every $HeartbeatSeconds for as long as its own loop is running, paced so the
  # volume stays ~1 KB/min. It is the ONLY observable that tells "this supervisor is
  # alive and looping" from "this supervisor is wedged": the log file, the lock file
  # and the PID are byte-identical in both states (measured, see
  # docs/ROUTER_RESTART_VERIFY_2026-09-30.md section 15). The beat is written from the
  # supervisor's own loops and NOTHING on that path touches WMI or CIM, so a contended
  # WMI/CIM call can no longer be the reason a supervisor goes silent - see
  # ops/supervisor-watchdog.ps1, which recovers a supervisor whose heartbeat has gone
  # stale while nothing answers on the port. 0 disables the heartbeat.
  [int]$HeartbeatSeconds = 15,
  [switch]$Once,
  [switch]$Status,
  [switch]$Stop,
  [switch]$Force,
  # Evaluate the current port/health/RAM and print the action the loop would take,
  # without acquiring the lock, starting, or killing anything.
  [switch]$DryRun
)

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$outLog = Join-Path $logDir "$LogPrefix.out.log"
$errLog = Join-Path $logDir "$LogPrefix.err.log"
$crashLog = Join-Path $logDir "$LogPrefix.crash.log"
$supLog = Join-Path $logDir "$LogPrefix.supervisor.log"
$lockFile = Join-Path $logDir "$LogPrefix-supervisor.lock"
$heartbeatFile = Join-Path $logDir "$LogPrefix-supervisor.heartbeat"
$selfPath = $PSCommandPath

# ---- config resolution -----------------------------------------------------
# The replace threshold: explicit -UnresponsiveMinutes wins; otherwise the env var;
# otherwise the (raised) default of 30 minutes. 0 disables replacing entirely.
if (-not $PSBoundParameters.ContainsKey('UnresponsiveMinutes')) {
  $envReplaceAfter = "$env:ROUTER_SUPERVISOR_REPLACE_AFTER_MIN".Trim()
  $parsedMinutes = 0.0
  if ($envReplaceAfter -and [double]::TryParse($envReplaceAfter, [ref]$parsedMinutes) -and $parsedMinutes -ge 0) {
    $UnresponsiveMinutes = $parsedMinutes
  }
}

# How long the RAM floor may hold before we give up and replace anyway.
if (-not $PSBoundParameters.ContainsKey('MaxRamHoldMinutes')) {
  $envMaxHold = "$env:ROUTER_SUPERVISOR_MAX_RAM_HOLD_MIN".Trim()
  $parsedHold = 0
  if ($envMaxHold -and [int]::TryParse($envMaxHold, [ref]$parsedHold) -and $parsedHold -ge 0) {
    $MaxRamHoldMinutes = $parsedHold
  }
}

# The router's own RAM floor. Same env var name and default as the router
# (src/company/fleet.ts / lifecycle.ts: MIN_FREE_RAM_MB, default 2048). 0 = off.
# Precedence: the process environment wins; when it is unset, the repo's .env is
# read (dotenv-style, the same file the router loads via `import "dotenv/config"`).
# The scheduled task starts this script with -NoProfile and no env block, so a
# .env-only override used to be invisible here: the live log still said
# ramFloor=2048 MB on 2026-10-01T17:07 after .env had been set to 256.
function Get-DotEnvValue([string]$name) {
  try {
    $p = Join-Path $root '.env'
    if (-not (Test-Path -LiteralPath $p)) { return $null }
    foreach ($line in [System.IO.File]::ReadAllLines($p)) {
      if ($line -match ('^\s*' + [regex]::Escape($name) + '\s*=\s*(.*)$')) {
        $v = $Matches[1].Trim()
        if ($v.Length -ge 2 -and (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'")))) {
          $v = $v.Substring(1, $v.Length - 2)
        }
        if ($v) { return $v }
      }
    }
  } catch { }
  return $null
}

$ramFloor = 2048
$ramFloorSrc = 'default'
$envRamFloor = "$env:MIN_FREE_RAM_MB".Trim()
if (-not $envRamFloor) {
  $envRamFloor = "$(Get-DotEnvValue 'MIN_FREE_RAM_MB')".Trim()
  if ($envRamFloor) { $ramFloorSrc = '.env' }
}
$parsedRam = 0
if ($envRamFloor -and [int]::TryParse($envRamFloor, [ref]$parsedRam) -and $parsedRam -ge 0) {
  $ramFloor = $parsedRam
  if ($ramFloorSrc -eq 'default') { $ramFloorSrc = 'env' }
}

function Now-Stamp { return (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss.fffK') }

function Write-Sup([string]$msg) {
  $line = "[{0}] {1}" -f (Now-Stamp), $msg
  Write-LogLine $supLog $line
  Write-Host $line
}

# Append with a short retry: Add-Content throws if another process holds the file
# for writing (observed once, and a lost supervisor log line is a lost answer to
# "why is the router down"). Shared write access avoids the conflict entirely.
function Write-LogLine([string]$file, [string]$line) {
  for ($i = 0; $i -lt 5; $i++) {
    try {
      $fs = New-Object System.IO.FileStream($file, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
      $sw = New-Object System.IO.StreamWriter($fs)
      $sw.Write($line + "`r`n")
      $sw.Dispose()
      $fs.Dispose()
      return
    } catch {
      Start-Sleep -Milliseconds 200
    }
  }
}

# Same destination the router's own crash handlers write to, so the restart
# history and the in-process lifecycle are in ONE file, in order.
function Write-CrashLog([string]$msg) {
  Write-LogLine $crashLog ("[{0}] {1}" -f (Now-Stamp), $msg)
}

# ---- heartbeat -------------------------------------------------------------
# One short line: "<ISO timestamp> pid=<pid> ticks=<process start ticks>". It is
# written on a FileStream held open for the process lifetime (measured 1.6 ms per
# write here, against 17.9 ms for open-append-close and 305 ms for a spawned
# powershell), and paced to at most one line per $HeartbeatSeconds.
#
# Why in-process and not a spawned writer: every measurement in
# docs/ROUTER_RESTART_VERIFY_2026-09-30.md points at process creation and native
# tools being exactly what stalls on this box, so a heartbeat that needs either
# would go silent for the same reason the supervisor does.
#
# Nothing here touches WMI or CIM. Nothing here blocks: if the file cannot be
# written the beat is simply skipped and retried on the next loop iteration
# (a stale heartbeat is the signal the watchdog is built to read).
$script:hbStream = $null
$script:hbLastWrite = $null
$script:hbStartTicks = ''
try { $script:hbStartTicks = "$((Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks)" } catch { $script:hbStartTicks = '' }
function Write-Heartbeat([switch]$Force) {
  if ($HeartbeatSeconds -le 0) { return }
  $now = Get-Date
  if (-not $Force -and $script:hbLastWrite -and ($now - $script:hbLastWrite).TotalSeconds -lt $HeartbeatSeconds) { return }
  $line = "{0} pid={1} ticks={2}" -f (Now-Stamp), $PID, $script:hbStartTicks
  for ($i = 0; $i -lt 2; $i++) {
    try {
      if (-not $script:hbStream) {
        # FileShare.ReadWrite so the watchdog (and a human with Get-Content) can read
        # the file while this process still holds it open.
        $script:hbStream = New-Object System.IO.FileStream($heartbeatFile, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
      }
      $bytes = [System.Text.Encoding]::UTF8.GetBytes($line + "`n")
      $script:hbStream.SetLength(0)
      $script:hbStream.Position = 0
      $script:hbStream.Write($bytes, 0, $bytes.Length)
      $script:hbStream.Flush()
      $script:hbLastWrite = $now
      return
    } catch {
      try { if ($script:hbStream) { $script:hbStream.Dispose() } } catch { }
      $script:hbStream = $null
      $script:hbLastWrite = $null
    }
  }
}

$script:lastWaitLog = $null
function Write-SupEvery([string]$msg, [int]$everySeconds = 60) {
  $now = Get-Date
  if (-not $script:lastWaitLog -or ($now - $script:lastWaitLog).TotalSeconds -ge $everySeconds) {
    $script:lastWaitLog = $now
    Write-Sup $msg
  }
}

function Get-ListenerPidViaCim([int]$Port) {
  # ONLY reached when netstat.exe itself is unavailable (see Get-ListenerPid).
  # Get-NetTCPConnection is CIM-backed and has been measured blocking for tens of
  # seconds - and minutes - on this box when WMI is contended. A single stuck CIM
  # call must never be able to freeze the supervisor loop, so it runs in a job and
  # is abandoned after a hard 8 s. Timing out is safe: the caller's raw TCP probe
  # (Test-PortListening) still guards the "nothing is listening -> start" decision,
  # and a wrong "no listener known" only ever makes the supervisor wait, never
  # start a second router on a port that already has one.
  $job = $null
  try {
    $job = Start-Job -ScriptBlock {
      param($p)
      $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($c) { return [int]$c.OwningProcess }
      return 0
    } -ArgumentList $Port
    if (Wait-Job -Job $job -Timeout 8) {
      $r = Receive-Job -Job $job -ErrorAction SilentlyContinue | Select-Object -First 1
      $v = 0
      if ($null -ne $r -and [int]::TryParse("$r", [ref]$v) -and $v -gt 0) { return $v }
      return 0
    }
    Write-Sup "Get-NetTCPConnection (CIM) did not answer within 8 s - abandoning the call; netstat was unavailable, so the listener pid is unknown this time"
    return 0
  } catch {
    return 0
  } finally {
    if ($job) { Remove-Job -Job $job -Force -ErrorAction SilentlyContinue }
  }
}

function Get-ListenerPid {
  # RELIABILITY (2026-09-30 incident): this used `Get-NetTCPConnection`, a CIM-backed cmdlet
  # that this file's own notes describe as taking tens of seconds here under load - and load
  # is exactly when a watchdog needs it. Measured: a supervisor wedged for 14 minutes with no
  # log line at all while holding this call, so nothing ever restarted the router and the
  # dashboard stayed down. `netstat -ano` is a native tool with no WMI in the path.
  #
  # 2026-10-01: netstat is now the *only* answer whenever it runs; the CIM fallback is used
  # ONLY if netstat itself cannot run (missing/exited non-zero), and it is hard-timeout
  # bounded by Get-ListenerPidViaCim. Previously a successful-but-empty netstat still fell
  # through to CIM, which is how a contended WMI call still got to sit on the hot path.
  $netstatOk = $false
  try {
    $lines = & "$env:SystemRoot\System32\netstat.exe" -ano -p tcp 2>$null
    if ($LASTEXITCODE -eq 0 -and $null -ne $lines) {
      $netstatOk = $true
      foreach ($line in $lines) {
        if ($line -match ('^\s*TCP\s+\S+:' + $Port + '\s+\S+\s+LISTENING\s+(\d+)')) {
          return [int]$Matches[1]
        }
      }
    }
  } catch { }
  if ($netstatOk) { return 0 }
  return Get-ListenerPidViaCim $Port
}

# Hot-path listening check: a raw .NET TCP connect, NOT Get-NetTCPConnection.
# The CIM-backed cmdlet took tens of seconds on this box under load, and that delay
# lands exactly when the router is down and the clock matters (observed: 85 s between
# the watchdog killing a hung router and the replacement being spawned).
function Test-PortListening([int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(1000)) { return $false }
    $client.EndConnect($iar)
    return $true
  } catch { return $false } finally { try { $client.Close() } catch { } }
}

# Free physical RAM in MB, or $null when it cannot be read. Uses GlobalMemoryStatusEx
# via Add-Type (compiled once, lazily) instead of WMI/CIM: Win32_OperatingSystem can
# block for minutes when WMI is contended on this box, and this call sits on the
# replace decision, which must not itself hang. No new dependencies, no external
# module - just a P/Invoke to kernel32.
$script:memTypeReady = $false
$script:memTypeFailed = $false
function Get-FreePhysicalMemoryMB {
  if ($script:memTypeFailed) { return $null }
  if (-not $script:memTypeReady) {
    try {
      if (-not ('JcodeWin32Mem' -as [type])) {
        Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class JcodeWin32Mem {
  [StructLayout(LayoutKind.Sequential)]
  public class MEMORYSTATUSEX {
    public uint dwLength;
    public uint dwMemoryLoad;
    public ulong ullTotalPhys;
    public ulong ullAvailPhys;
    public ulong ullTotalPageFile;
    public ulong ullAvailPageFile;
    public ulong ullTotalVirtual;
    public ulong ullAvailVirtual;
    public ulong ullAvailExtendedVirtual;
    public MEMORYSTATUSEX() { dwLength = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX)); }
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool GlobalMemoryStatusEx([In, Out] MEMORYSTATUSEX lpBuffer);
}
'@
      }
      $script:memTypeReady = $true
    } catch { $script:memTypeFailed = $true; return $null }
  }
  try {
    $st = [JcodeWin32Mem+MEMORYSTATUSEX]::new()
    if ([JcodeWin32Mem]::GlobalMemoryStatusEx($st)) {
      return [int][math]::Round($st.ullAvailPhys / 1048576)
    }
  } catch { }
  return $null
}

# One non-throwing probe of the port + /health. Returns a plain object so every
# branch can be reasoned about:
#   Listening : a TCP connect to 127.0.0.1:$Port succeeded
#   Answered  : curl got an HTTP response (any status code) - the process is alive
#   Ok        : the response body was JSON with ok=true
#   HttpCode  : the HTTP status curl reported (0 if none)
#   LagMs/LagP95Ms/LagMaxMs/LagSamples : lag fields when the JSON had them
# Every failure mode - non-JSON body, 200 with missing fields, empty body, hang,
# connection refused - leaves Answered=false or ok=false and NEVER throws.
function Get-RouterProbe {
  $probe = [pscustomobject]@{
    Listening  = $false
    Answered   = $false
    Ok         = $false
    HttpCode   = 0
    LagMs      = $null
    LagP95Ms   = $null
    LagMaxMs   = $null
    LagSamples = $null
    Body       = ''
  }
  try { $probe.Listening = [bool](Test-PortListening $Port) } catch { $probe.Listening = $false }

  $raw = $null
  $curlExit = 1
  try {
    # -s silent, -m total time cap (covers connect AND read, so a hang cannot block
    # us forever), -w appends the HTTP code on its own final line. No -f: a 4xx/5xx
    # still means a process answered.
    $raw = & curl.exe -s -m $HealthTimeoutSeconds -w "`n%{http_code}" "http://127.0.0.1:$Port/health" 2>$null
    $curlExit = $LASTEXITCODE
  } catch {
    $curlExit = 1
    $raw = $null
  }
  if ($null -eq $curlExit) { $curlExit = 1 }

  $text = ''
  if ($raw -is [array]) { $text = ($raw -join "`n") } elseif ($null -ne $raw) { $text = [string]$raw }

  if ($curlExit -eq 0 -and $text) {
    $nl = $text.LastIndexOf("`n")
    $body = if ($nl -ge 0) { $text.Substring(0, $nl) } else { $text }
    $codeStr = if ($nl -ge 0) { $text.Substring($nl + 1) } else { '' }
    $code = 0
    [void][int]::TryParse($codeStr.Trim(), [ref]$code)
    $probe.HttpCode = $code
    $probe.Body = if ($body.Length -gt 200) { $body.Substring(0, 200) } else { $body }
    if ($code -gt 0) { $probe.Answered = $true }
    if ($body) {
      try {
        $h = $body | ConvertFrom-Json
        if ($null -ne $h) {
          if ($h.PSObject.Properties['ok']) { $probe.Ok = [bool]$h.ok }
          foreach ($f in 'lagMs', 'lagP95Ms', 'lagMaxMs', 'lagSamples') {
            if ($h.PSObject.Properties[$f]) {
              $n = 0.0
              if ([double]::TryParse([string]$h.$f, [ref]$n)) { $probe.$f = [int]$n }
            }
          }
        }
      } catch {
        # Non-JSON body: answered (so alive), just unparseable.
        $probe.Ok = $false
      }
    }
  }
  return $probe
}

function Format-Lag($probe) {
  if ($null -eq $probe) { return '' }
  $parts = @()
  if ($null -ne $probe.LagP95Ms) { $parts += "lagP95Ms=$($probe.LagP95Ms)" }
  if ($null -ne $probe.LagMs) { $parts += "lagMs=$($probe.LagMs)" }
  if ($null -ne $probe.LagMaxMs) { $parts += "lagMaxMs=$($probe.LagMaxMs)" }
  if ($null -ne $probe.LagSamples) { $parts += "lagSamples=$($probe.LagSamples)" }
  if (-not $parts.Count) { return '' }
  $slow = ($null -ne $probe.LagP95Ms -and $probe.LagP95Ms -ge $LagWarnMs)
  return (' [' + $(if ($slow) { 'SLOW ' } else { '' }) + ($parts -join ' ') + ']')
}

function Get-Plan($probe, [double]$stuckFor) {
  if ($probe.Answered) { if ($probe.Ok) { return 'watch-healthy' } else { return 'watch-degraded' } }
  if ($probe.Listening) {
    if ($Force) { return 'replace-forced' }
    if ($UnresponsiveMinutes -gt 0 -and $stuckFor -ge $UnresponsiveMinutes) { return 'consider-replace' }
    return 'wait-listener-no-answer'
  }
  return 'start'
}

# Read the heartbeat back (read-only; used by -Status). Returns $null when the
# file is missing or unparseable. Opens with FileShare.ReadWrite so it works
# while the live supervisor still holds the write handle.
function Get-Heartbeat {
  try {
    if (-not (Test-Path -LiteralPath $heartbeatFile)) { return $null }
    $fs = New-Object System.IO.FileStream($heartbeatFile, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    $sr = New-Object System.IO.StreamReader($fs)
    $raw = $sr.ReadToEnd()
    $sr.Dispose()
    $fs.Dispose()
    if (-not $raw) { return $null }
    $stamp = $null
    $pid2 = 0
    $stampText = ''
    if ($raw -match '(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))') { $stampText = $Matches[1] }
    if ($stampText) {
      # The [ref] target must be typed, or the overload cannot be resolved.
      $stampDto = [DateTimeOffset]::MinValue
      if ([DateTimeOffset]::TryParse($stampText, [ref]$stampDto)) { $stamp = $stampDto }
    }
    if ($raw -match 'pid=(\d+)') { $pid2 = [int]$Matches[1] }
    if ($null -eq $stamp) { return $null }
    return [pscustomobject]@{
      Stamp      = $stamp
      Pid        = $pid2
      AgeSeconds = [math]::Round((([DateTimeOffset]::Now).UtcDateTime - $stamp.UtcDateTime).TotalSeconds, 1)
      Raw        = $raw.Trim()
    }
  } catch { return $null }
}

function Get-LockOwner {
  # NOTE: no WMI/CIM call here on purpose. Get-CimInstance Win32_Process can block
  # for minutes when WMI is contended (observed on this box: 13 minutes between
  # process start and the first log line), and this runs on the startup path of a
  # process whose entire job is to be the thing that never hangs. PID + process
  # start time is enough to prove identity: a reused PID cannot also match the
  # recorded start time.
  if (-not (Test-Path -LiteralPath $lockFile)) { return $null }
  $raw = (Get-Content -LiteralPath $lockFile -Raw -ErrorAction SilentlyContinue)
  if (-not $raw) { return $null }
  $ownerPid = 0
  if ($raw -match 'pid=(\d+)') { $ownerPid = [int]$Matches[1] }
  if ($ownerPid -le 0) { return $null }
  $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
  if (-not $proc) { return $null }
  $recordedTicks = ''
  if ($raw -match 'processStartTicks=(\d+)') { $recordedTicks = $Matches[1] }
  $actualTicks = ''
  try { $actualTicks = "$($proc.StartTime.ToUniversalTime().Ticks)" } catch { return $null }
  if ($recordedTicks -and $recordedTicks -ne $actualTicks) { return $null }
  return [pscustomobject]@{ Pid = $ownerPid; StartTime = $proc.StartTime }
}

function Release-Lock {
  if (Test-Path -LiteralPath $lockFile) { Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue }
}

if ($Status) {
  $probe = Get-RouterProbe
  $listener = Get-ListenerPid
  $owner = Get-LockOwner
  $freeMb = Get-FreePhysicalMemoryMB
  Write-Output ("health answered : {0}" -f $probe.Answered)
  Write-Output ("health ok       : {0}" -f $probe.Ok)
  Write-Output ("http code       : {0}" -f $probe.HttpCode)
  Write-Output ("lag             : lagMs={0} lagP95Ms={1} lagMaxMs={2} lagSamples={3}" -f $probe.LagMs, $probe.LagP95Ms, $probe.LagMaxMs, $probe.LagSamples)
  Write-Output ("listener pid    : {0}" -f $(if ($listener) { $listener } else { '(none)' }))
  Write-Output ("free RAM MB     : {0}" -f $(if ($null -ne $freeMb) { $freeMb } else { '(unknown)' }))
  Write-Output ("RAM floor       : {0}" -f $(if ($ramFloor -gt 0) { "$ramFloor MB" } else { '(disabled)' }))
  Write-Output ("replace after   : {0}" -f $(if ($UnresponsiveMinutes -gt 0) { "$UnresponsiveMinutes min of continuous no-answer" } else { '(disabled)' }))
  Write-Output ("supervisor pid  : {0}" -f $(if ($owner) { $owner.Pid } else { '(not running)' }))
  $hbAgeTxt = '(none)'
  $hb = Get-Heartbeat
  if ($hb) {
    $hbAgeTxt = "{0:N0} s ago (pid {1}, {2})" -f $hb.AgeSeconds, $hb.Pid, $heartbeatFile
  }
  Write-Output ("heartbeat       : {0}" -f $hbAgeTxt)
  Write-Output ("heartbeat file  : {0}" -f $heartbeatFile)
  Write-Output ("crash log       : {0}" -f $crashLog)
  Write-Output ("supervisor log  : {0}" -f $supLog)
  exit 0
}

if ($DryRun) {
  $probe = Get-RouterProbe
  $freeMb = Get-FreePhysicalMemoryMB
  $plan = Get-Plan $probe 0.0
  Write-Output "DRY RUN (no lock taken, nothing started or killed)"
  Write-Output ("  listener          : {0}" -f $probe.Listening)
  Write-Output ("  /health answered  : {0} (http {1}, ok={2})" -f $probe.Answered, $probe.HttpCode, $probe.Ok)
  Write-Output ("  lag               : lagMs={0} lagP95Ms={1} lagMaxMs={2} lagSamples={3}" -f $probe.LagMs, $probe.LagP95Ms, $probe.LagMaxMs, $probe.LagSamples)
  Write-Output ("  free RAM MB       : {0} (floor {1})" -f $(if ($null -ne $freeMb) { $freeMb } else { 'unknown' }), $(if ($ramFloor -gt 0) { $ramFloor } else { 'off' }))
  Write-Output ("  replace threshold : {0} min" -f $UnresponsiveMinutes)
  Write-Output ("  planned action    : {0}" -f $plan)
  exit 0
}

if ($Stop) {
  $owner = Get-LockOwner
  if ($owner) {
    Write-Sup "stopping supervisor pid $($owner.Pid)"
    Stop-Process -Id $owner.Pid -Force -ErrorAction SilentlyContinue
  } else {
    Write-Sup "no live supervisor lock found (nothing to stop)"
  }
  Release-Lock
  $listener = Get-ListenerPid
  if ($listener) {
    try {
      Write-Sup "stopping router listener pid $listener"
      Stop-Process -Id $listener -Force -ErrorAction Stop
      Write-CrashLog "SUPERVISOR manual stop: killed router pid=$listener"
    } catch { Write-Sup "could not stop pid ${listener}: $($_.Exception.Message)" }
  } else {
    Write-Sup "nothing listening on :$Port"
  }
  exit 0
}

# ---- single instance -------------------------------------------------------
$owner = Get-LockOwner
if ($owner) {
  Write-Sup "another supervisor is already running (pid $($owner.Pid)) - exiting without starting a second one"
  exit 3
}

Set-Content -LiteralPath $lockFile -Value ("pid={0}`nstarted={1}`nprocessStartTicks={2}`nscript={3}" -f $PID, (Now-Stamp), (Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks, $selfPath) -Encoding utf8
Write-Sup "supervisor started pid=$PID root=$root port=$Port replaceAfter=$($UnresponsiveMinutes)min ramFloor=$ramFloor MB source=$ramFloorSrc"
Write-CrashLog ("SUPERVISOR start pid={0} script={1} port={2}" -f $PID, $selfPath, $Port)
# First beat immediately: from here on, a heartbeat older than the watchdog's
# threshold while nothing answers on the port means THIS process is wedged.
Write-Heartbeat -Force

# LAUNCH (2026-10-01 incident): launch node DIRECTLY with tsx's own loader instead
# of through `tsx.cmd`. The shim costs one extra process creation and one extra
# node.exe image load per cold start (cmd -> tsx's node CLI -> the server node),
# and the CLI does nothing but re-exec node with exactly the two flags below
# (node_modules/tsx/dist/cli.mjs, run()). During the incident this box made each
# of those creations take 82 s, 163 s and 213 s (process StartTime deltas), so the
# chain took 11 min 28 s to listen; one creation fewer is one installed stall
# fewer. Measured with a dummy .ts entry, same output: 0.24 s direct, 1.17 s via
# the shim. The shim and `npx tsx` stay as fallbacks if tsx's files are missing.
$preflight = Join-Path $root 'node_modules\tsx\dist\preflight.cjs'
$loader = Join-Path $root 'node_modules\tsx\dist\loader.mjs'
$tsxCmd = Join-Path $root 'node_modules\.bin\tsx.cmd'
$nodeExe = $null
try { $nodeExe = (Get-Command node.exe -ErrorAction Stop).Source } catch { $nodeExe = $null }
if ($nodeExe -and (Test-Path -LiteralPath $preflight) -and (Test-Path -LiteralPath $loader)) {
  # --import needs a file URL; [uri] escapes the space in this path
  # ("Default%20Project") exactly the way tsx's own CLI does.
  $loaderUri = ([uri]$loader).AbsoluteUri
  $launch = ('"{0}" --no-maglev --require "{1}" --import "{2}" src/server.ts' -f $nodeExe, $preflight, $loaderUri)
} elseif (Test-Path -LiteralPath $tsxCmd) {
  $launch = '"node_modules\.bin\tsx.cmd" src/server.ts'
} else {
  $launch = 'npx tsx src/server.ts'
}
# The child must listen on the port THIS supervisor watches, so PORT is always
# exported for it (an explicit -ChildEnv PORT still wins).
if (-not $ChildEnv.ContainsKey('PORT')) { $ChildEnv['PORT'] = "$Port" }
# V8 Maglev JIT fast-fails (0xC0000409) on this Windows build (nodejs#62260); the
# --no-maglev flag is on the node command line above (it cannot go through
# NODE_OPTIONS). Leave a V8 report if the child still hits a fatal error.
$reportDir = Join-Path $root 'logs\node-reports'
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
$v8ReportOpts = '--report-on-fatalerror --report-directory=logs\node-reports'
if ($ChildEnv.ContainsKey('NODE_OPTIONS') -and $ChildEnv['NODE_OPTIONS']) {
  $ChildEnv['NODE_OPTIONS'] = "$($ChildEnv['NODE_OPTIONS']) $v8ReportOpts"
} else {
  $ChildEnv['NODE_OPTIONS'] = $v8ReportOpts
}
$sets = ''
foreach ($k in $ChildEnv.Keys) { $sets += "set `"$k=$($ChildEnv[$k])`" && " }
$inner = "cd /d `"$root`" && $sets $launch 1>> `"$outLog`" 2>> `"$errLog`""
$consecutiveFast = 0
$attempt = 0
$wasServing = $false
$noAnswerSince = $null
$ramHoldLogged = $false

try {
  while ($true) {
    # Beat first, before any probe: the beat proves the loop turned, and it is
    # written on a path with no WMI, no CIM and no spawned process.
    Write-Heartbeat
    $probe = Get-RouterProbe

    # --- the router answered /health (fast or slow): it is ALIVE ---------------
    if ($probe.Answered) {
      $noAnswerSince = $null
      $ramHoldLogged = $false
      $script:lastWaitLog = $null
      $lagTxt = Format-Lag $probe
      if (-not $wasServing -or -not $probe.Ok) {
        $listener = Get-ListenerPid
        if ($probe.Ok) {
          Write-Sup "router is healthy on :$Port (pid $listener) - watching, not starting anything$lagTxt"
          Write-CrashLog "SUPERVISOR healthy pid=$listener (idle watch)"
        } else {
          # Answered but ok is absent/false, or the body was not JSON. A response
          # came back, so the process is alive: log it and back off. Replacing here
          # is exactly the measured outage bug.
          Write-Sup "router on :$Port (pid $listener) answered /health but ok is not true (http $($probe.HttpCode)) - ALIVE, backing off, NOT replacing$lagTxt"
          Write-CrashLog "SUPERVISOR alive-but-degraded pid=$listener http=$($probe.HttpCode)"
        }
        $wasServing = $true
      }
      Start-Sleep -Seconds $PollSeconds
      continue
    }

    # --- no answer: either a starved listener, or nothing on the port ----------
    $wasServing = $false

    if ($probe.Listening) {
      if (-not $noAnswerSince) {
        $noAnswerSince = Get-Date
        $listener = Get-ListenerPid
        Write-Sup "port $Port has a listener (pid $listener) but /health did not answer - it may be busy, not dead; NOT starting a second router. Replace only after $UnresponsiveMinutes continuous min (ROUTER_SUPERVISOR_REPLACE_AFTER_MIN)"
      }
      $stuckFor = ((Get-Date) - $noAnswerSince).TotalMinutes

      $replaceNow = $false
      if ($Force) {
        $replaceNow = $true
      } elseif ($UnresponsiveMinutes -gt 0 -and $stuckFor -ge $UnresponsiveMinutes) {
        $freeMb = Get-FreePhysicalMemoryMB
        $holdCapHit = ($MaxRamHoldMinutes -gt 0 -and $stuckFor -ge $MaxRamHoldMinutes)
        if (-not $holdCapHit -and $ramFloor -gt 0 -and $null -ne $freeMb -and $freeMb -lt $ramFloor) {
          if (-not $ramHoldLogged) {
            # Log the "holding" decision once per episode even if the below-threshold
            # "waiting" line just throttled the shared timer.
            $ramHoldLogged = $true
            $script:lastWaitLog = $null
            Write-Sup ("router has not answered /health for {0:N1} min (>= threshold {1} min) but free RAM {2} MB < MIN_FREE_RAM_MB={3} - box is starved; holding instead of replacing (a restart would just re-starve it)" -f $stuckFor, $UnresponsiveMinutes, $freeMb, $ramFloor)
          } else {
            # Once a minute, never silently: a RAM-floor hold must always say so.
            Write-SupEvery ("still holding: no /health for {0:N1} min, free RAM {1} MB < MIN_FREE_RAM_MB={2}" -f $stuckFor, $freeMb, $ramFloor) 60
          }
        } else {
          if ($holdCapHit) {
            Write-Sup ("free RAM {0} MB still below MIN_FREE_RAM_MB={1} after {2:N1} min of no /health (>= MaxRamHoldMinutes {3}) - replacing anyway" -f $freeMb, $ramFloor, $stuckFor, $MaxRamHoldMinutes)
          }
          $replaceNow = $true
        }
      } else {
        $ramHoldLogged = $false
        Write-SupEvery ("port $Port has a listener but /health did not answer for {0:N1} min (< threshold {1} min) - waiting, not replacing" -f $stuckFor, $UnresponsiveMinutes) 60
      }

      if ($replaceNow) {
        $stuckPid = Get-ListenerPid
        if ($stuckPid -le 0) { $stuckPid = 0 }
        $freeMb = Get-FreePhysicalMemoryMB
        $freeTxt = if ($null -ne $freeMb) { "$freeMb MB" } else { 'unknown' }
        Write-Sup ("router pid=$stuckPid has not answered /health for {0:N1} min (threshold {1} min, free RAM {2}) - replacing it" -f $stuckFor, $UnresponsiveMinutes, $freeTxt)
        Write-CrashLog ("SUPERVISOR unresponsive pid={0} for {1:N1} min -> killing it" -f $stuckPid, $stuckFor)
        if ($stuckPid -gt 0) { Stop-Process -Id $stuckPid -Force -ErrorAction SilentlyContinue }
        $noAnswerSince = $null
        $ramHoldLogged = $false
        $script:lastWaitLog = $null
        Start-Sleep -Seconds 2
      } else {
        Start-Sleep -Seconds 10
      }
      continue
    }

    # --- nothing listening and no answer: safe to start ------------------------
    $noAnswerSince = $null
    $ramHoldLogged = $false
    $script:lastWaitLog = $null

    # Authoritative double-check right before starting. The raw 1s TCP probe is
    # cheap but can miss a listener on a loaded box; Get-NetTCPConnection is the
    # ground truth. If it says anything is listening, wait - never race into a
    # second router on :$Port.
    $authPid = Get-ListenerPid
    if ($authPid -gt 0) {
      Write-Sup "raw connect says :$Port is free but Get-NetTCPConnection reports listener pid $authPid - waiting instead of starting a second router"
      Start-Sleep -Seconds 5
      continue
    }

    $attempt++
    $startedAt = Get-Date
    Write-Sup ("starting router (attempt {0}) -> logs/$LogPrefix.out.log" -f $attempt)
    Write-CrashLog ("SUPERVISOR starting router attempt={0}" -f $attempt)

    $child = $null
    try {
      $child = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $inner -WindowStyle Hidden -PassThru
    } catch {
      Write-Sup "could not start the router: $($_.Exception.Message)"
      Write-CrashLog "SUPERVISOR start FAILED: $($_.Exception.Message)"
      Start-Sleep -Seconds $MaxBackoffSeconds
      continue
    }
    Write-Sup ("router command pid {0}" -f $child.Id)
    Write-CrashLog ("SUPERVISOR router cmd pid={0}" -f $child.Id)

    # Wait for it to answer, or to die trying.
    $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
    $up = $false
    $startProbe = $null
    while ((Get-Date) -lt $deadline) {
      Write-Heartbeat
      Start-Sleep -Seconds 2
      try { $null = $child.Refresh() } catch { }
      if ($child.HasExited) { break }
      $startProbe = Get-RouterProbe
      if ($startProbe.Answered) { $up = $true; break }
    }

    if ($up) {
      $upSecs = [math]::Round(((Get-Date) - $startedAt).TotalSeconds, 1)
      $listener = Get-ListenerPid
      $lagTxt = Format-Lag $startProbe
      if ($startProbe.Ok) {
        Write-Sup ("router is healthy on :$Port after ${upSecs}s (pid $listener)$lagTxt")
        Write-CrashLog ("SUPERVISOR router UP pid={0} after {1}s" -f $listener, $upSecs)
      } else {
        Write-Sup ("router on :$Port answered /health after ${upSecs}s (pid $listener) but ok is not true - treating as ALIVE$lagTxt")
        Write-CrashLog ("SUPERVISOR router UP-degraded pid={0} after {1}s http={2}" -f $listener, $upSecs, $startProbe.HttpCode)
      }
      $consecutiveFast = 0
      $noAnswerSince = $null
    } elseif ($child.HasExited) {
      Write-Sup "router exited before it answered on :$Port - see logs/$LogPrefix.err.log, backing off"
      Write-CrashLog "SUPERVISOR router exited before answering (health never ok)"
    } else {
      Write-Sup "router still running but /health was not ok within $StartupTimeoutSeconds s"
      Write-CrashLog "SUPERVISOR router did NOT become healthy within $StartupTimeoutSeconds s"
    }

    # Wait for the child to exit - but keep watching whether it is still ANSWERING.
    # Any answer (even a slow one) means alive; only a long CONTINUOUS stretch of
    # no answer, with enough free RAM, is treated as a hang.
    while (-not $child.HasExited) {
      Write-Heartbeat
      Start-Sleep -Seconds $PollSeconds
      $p = Get-RouterProbe
      if ($p.Answered) { $noAnswerSince = $null; $script:lastWaitLog = $null; continue }
      if (-not $p.Listening) { continue }
      if ($UnresponsiveMinutes -le 0) { continue }
      if (-not $noAnswerSince) { $noAnswerSince = Get-Date }
      $stuckFor = ((Get-Date) - $noAnswerSince).TotalMinutes
      if (-not $Force -and $stuckFor -lt $UnresponsiveMinutes) { continue }
      $freeMb = Get-FreePhysicalMemoryMB
      $holdCapHit2 = ($MaxRamHoldMinutes -gt 0 -and $stuckFor -ge $MaxRamHoldMinutes)
      if (-not $Force -and -not $holdCapHit2 -and $ramFloor -gt 0 -and $null -ne $freeMb -and $freeMb -lt $ramFloor) {
        Write-SupEvery ("router has not answered /health for {0:N1} min but free RAM {1} MB < MIN_FREE_RAM_MB={2} - waiting, not replacing" -f $stuckFor, $freeMb, $ramFloor) 60
        continue
      }
      $stuckPid = Get-ListenerPid
      if ($stuckPid -le 0) { $stuckPid = [int]$child.Id }
      Write-Sup ("router pid=$stuckPid has not answered /health for {0:N1} min - replacing it" -f $stuckFor)
      Write-CrashLog ("SUPERVISOR unresponsive pid={0} for {1:N1} min -> killing it" -f $stuckPid, $stuckFor)
      Stop-Process -Id $stuckPid -Force -ErrorAction SilentlyContinue
      $noAnswerSince = $null
      $script:lastWaitLog = $null
      Start-Sleep -Seconds 2
      break
    }
    try { $child.WaitForExit() } catch { }
    $ranFor = [math]::Round(((Get-Date) - $startedAt).TotalSeconds, 1)
    $code = $null
    try { $code = $child.ExitCode } catch { $code = 'unknown' }
    Write-Sup ("router process exited after ${ranFor}s (exit code $code)")
    Write-CrashLog ("SUPERVISOR child-exit cmdPid={0} exitCode={1} ranFor={2}s" -f $child.Id, $code, $ranFor)

    if ($Once) { Write-Sup '-Once given: supervisor exiting after one supervised run'; break }

    # A run that died fast is a crash loop (bad build, port clash): back off.
    if ($ranFor -lt 90) { $consecutiveFast++ } else { $consecutiveFast = 0 }
    $wait = $BackoffSeconds
    if ($consecutiveFast -gt 1) {
      $wait = [int][math]::Min($MaxBackoffSeconds, $BackoffSeconds * [math]::Pow(2, $consecutiveFast - 1))
    }
    Write-Sup ("restarting in ${wait}s")
    Start-Sleep -Seconds $wait
  }
} finally {
  try { if ($script:hbStream) { $script:hbStream.Dispose() } } catch { }
  $script:hbStream = $null
  Release-Lock
  Write-Sup "supervisor exiting"
  Write-CrashLog "SUPERVISOR exit pid=$PID"
}
exit 0
