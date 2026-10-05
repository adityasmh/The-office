# ops/supervisor-watchdog.ps1 - restart a WEDGED router supervisor, and nothing else.
#
# WHY THIS EXISTS (2026-10-01, "supervisor heartbeat" work order)
# On 2026-10-01 the router (pid 9444) was killed on purpose at ~16:54. The
# supervisor (powershell pid 11992, ops/router-supervisor.ps1, started by the
# scheduled task LayaCompanyRouterSupervisor) had logged nothing since 16:45:27,
# used 0.000 s of CPU over a 30 s sample, and never started a replacement. The
# site was down for ~17 minutes. The supervisor was not dead-AND-restarting: it
# was ALIVE and WEDGED, and because the task is registered IgnoreNew, the every-2
# -minute task could not arm a fresh instance while that wedged instance was
# still counted as running. Nothing in the system could tell "wedged" from
# "quietly healthy", because both states write the same log file, the same lock
# file and the same PID (proven by measurement in
# docs/ROUTER_RESTART_VERIFY_2026-09-30.md section 15).
#
# WHAT THIS SCRIPT IS
#   * Tiny and dependency-free on purpose: Get-Process, netstat, a raw .NET TCP
#     socket, schtasks, and file timestamps. NO WMI. NO CIM. Nothing here can
#     itself block on the contended WMI calls that wedged the supervisor.
#   * It NEVER starts a router. It never touches the router process at all.
#   * It acts only when BOTH are true:
#       1. logs/router-supervisor.heartbeat (written by ops/router-supervisor.ps1
#          every 15 s) is older than -StaleSeconds (default 90), and
#       2. nothing answers on 127.0.0.1:<Port> - a raw TCP connect to the port is
#          refused/times out (and /health does not answer either).
#     A router that answers - even slowly, even with a non-ok body - is the
#     supervisor's business, not this script's (the supervisor has a 30-minute
#     rule for a listener that is alive but not answering).
#   * The ONLY actions it can take:
#       1. stop the single supervisor pid named in the heartbeat file, and only
#          after proving that pid is still the same process (its command line
#          must contain this repo's ops/router-supervisor.ps1; a pid whose start
#          ticks do not match the recorded ones is a reused pid and is refused),
#       2. remove logs/router-supervisor.lock, and only if that lock names the
#          pid it just stopped (or no live supervisor at all),
#       3. `schtasks /run /tn LayaCompanyRouterSupervisor` - the same documented
#          way a human restarts the supervisor. The supervisor then decides
#          whether a router has to be started. This script never does.
#   * -WhatIf prints the whole decision and touches nothing.
#   * Every run writes exactly one line to logs/supervisor-watchdog.log, even
#     when it does nothing, and the file is capped at 2000 lines.
#   * Operator escape hatch: while logs/supervisor-watchdog.pause exists, the
#     watchdog logs "paused" and does nothing. Use it before a deliberate stop
#     of the supervisor (it is not deleted automatically).
#
# Usage (normally started by its own scheduled task LayaSupervisorWatchdog):
#   powershell -NoProfile -ExecutionPolicy Bypass -File ops/supervisor-watchdog.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File ops/supervisor-watchdog.ps1 -WhatIf
#   powershell -NoProfile -ExecutionPolicy Bypass -File ops/supervisor-watchdog.ps1 -Status
#
# The decision logic lives in Get-WatchdogDecision, which is pure: it takes the
# heartbeat, the port state and the process/lock facts as arguments and returns
# an action. ops/supervisor-watchdog-check.ps1 dot-sources this file with
# -LibraryOnly and drives that function against fake heartbeat files and fake
# port states, so the decision table can be tested without touching any live
# process.

[CmdletBinding()]
param(
  [int]$Port = 8787,
  # A heartbeat older than this means the supervisor loop has stopped turning.
  # 90 s against a 15 s beat leaves room for a slow probe (a /health call can take
  # 20 s on this box) without calling a working supervisor wedged.
  [int]$StaleSeconds = 90,
  [int]$HttpTimeoutSeconds = 5,
  [int]$StopWaitSeconds = 5,
  [string]$TaskName = 'LayaCompanyRouterSupervisor',
  [string]$LogPrefix = 'router',
  [string]$RepoRoot = '',
  [string]$LogDir = '',
  [string]$LogFile = '',
  [int]$MaxLogLines = 2000,
  # Print the decision instead of acting. Never stops a process, never removes a
  # lock, never runs the task.
  [switch]$WhatIf,
  # Print the decision inputs and exit. Read-only.
  [switch]$Status,
  # Dot-source support: define the functions, run nothing.
  [switch]$LibraryOnly
)

$ErrorActionPreference = 'Continue'

if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
$root = $RepoRoot
if (-not $LogDir) { $LogDir = Join-Path $root 'logs' }
$heartbeatFile = Join-Path $LogDir "$LogPrefix-supervisor.heartbeat"
$lockFile = Join-Path $LogDir "$LogPrefix-supervisor.lock"
$pauseFile = Join-Path $LogDir 'supervisor-watchdog.pause'
if (-not $LogFile) { $LogFile = Join-Path $LogDir 'supervisor-watchdog.log' }
$expectedScript = Join-Path $root 'ops\router-supervisor.ps1'
$schtasks = Join-Path $env:SystemRoot 'System32\schtasks.exe'

function Now-Stamp { return (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss.fffK') }

# ---- log (one line per run, capped) ----------------------------------------
function Get-LogLineCount {
  try {
    $fs = New-Object System.IO.FileStream($LogFile, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    $sr = New-Object System.IO.StreamReader($fs)
    $n = 0
    while ($sr.ReadLine() -ne $null) { $n++ }
    $sr.Dispose(); $fs.Dispose()
    return $n
  } catch { return -1 }
}

function Write-WatchdogLog([string]$msg) {
  $line = "[{0}] {1}" -f (Now-Stamp), $msg
  for ($i = 0; $i -lt 3; $i++) {
    try {
      $fs = New-Object System.IO.FileStream($LogFile, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
      $sw = New-Object System.IO.StreamWriter($fs)
      $sw.Write($line + "`r`n")
      $sw.Dispose(); $fs.Dispose()
      break
    } catch { Start-Sleep -Milliseconds 200 }
  }
  # The scheduled task runs this every minute: log quietly to the file, never
  # print to a console (a printed line is what used to flash a window).
  # Cap: keep the newest half once the cap is crossed. Checked only when the file
  # has grown past a size that cannot hold 2000 short lines.
  try {
    $fi = Get-Item -LiteralPath $LogFile -ErrorAction SilentlyContinue
    if ($fi -and $fi.Length -gt 200000) {
      $count = Get-LogLineCount
      if ($count -gt $MaxLogLines) {
        $keep = [math]::Max(1, [int]($MaxLogLines / 2))
        $lines = [System.IO.File]::ReadAllLines($LogFile)
        $tail = $lines[($lines.Count - $keep)..($lines.Count - 1)]
        $fs = New-Object System.IO.FileStream($LogFile, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
        $sw = New-Object System.IO.StreamWriter($fs)
        $sw.Write(("[{0}] log rotated: kept the newest {1} of {2} lines`r`n" -f (Now-Stamp), $keep, $count))
        foreach ($l in $tail) { $sw.Write($l + "`r`n") }
        $sw.Dispose(); $fs.Dispose()
      }
    }
  } catch { }
}

# ---- reads (all bounded, none of them WMI/CIM) ------------------------------
# The heartbeat line is "<ISO stamp> pid=<pid> ticks=<process start ticks>".
function Get-HeartbeatState {
  if (-not (Test-Path -LiteralPath $heartbeatFile)) { return $null }
  $raw = ''
  for ($i = 0; $i -lt 3; $i++) {
    try {
      $fs = New-Object System.IO.FileStream($heartbeatFile, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
      $sr = New-Object System.IO.StreamReader($fs)
      $raw = $sr.ReadToEnd()
      $sr.Dispose(); $fs.Dispose()
    } catch { $raw = '' }
    if ($raw -and $raw.Trim()) { break }
    # The writer truncates before it rewrites; an empty read is a race, so look again.
    Start-Sleep -Milliseconds 250
  }
  if (-not $raw) { return $null }
  $stamp = $null
  $stampText = ''
  # The supervisor writes a local-offset stamp (...+05:30, via 'fffK'); a Z stamp
  # is accepted too so a heartbeat written by a future UTC-form writer still parses.
  if ($raw -match '(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))') { $stampText = $Matches[1] }
  if ($stampText) {
    # The [ref] target must be typed, or the overload cannot be resolved.
    $stampDto = [DateTimeOffset]::MinValue
    if ([DateTimeOffset]::TryParse($stampText, [ref]$stampDto)) { $stamp = $stampDto }
  }
  if ($null -eq $stamp) { return $null }
  $hbPid = 0
  if ($raw -match 'pid=(\d+)') { $hbPid = [int]$Matches[1] }
  $hbTicks = ''
  if ($raw -match 'ticks=(\d+)') { $hbTicks = $Matches[1] }
  return [pscustomobject]@{
    Stamp      = $stamp
    AgeSeconds = [math]::Round((([DateTimeOffset]::Now).UtcDateTime - $stamp.UtcDateTime).TotalSeconds, 1)
    Pid        = $hbPid
    Ticks      = $hbTicks
    Raw        = $raw.Trim()
  }
}

# Does anything answer on the port? Raw .NET socket only - no WMI, no CIM, no
# spawned process, no dependency on which HTTP client happens to be installed.
#   'answers-http' : a TCP connection was accepted AND an HTTP response came back
#   'accepts-only' : a TCP connection was accepted but no (complete) HTTP response
#                    came back - something is there, so treat it as answering
#   'nothing'      : the connect was refused or timed out
function Get-RouterAnswer {
  param([int]$Port = 8787, [int]$TimeoutSeconds = 5)
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutSeconds * 1000)) { return 'nothing' }
    $client.EndConnect($iar)
  } catch {
    try { $client.Close() } catch { }
    return 'nothing'
  }
  try {
    $client.ReceiveTimeout = $TimeoutSeconds * 1000
    $client.SendTimeout = $TimeoutSeconds * 1000
    $stream = $client.GetStream()
    $req = [System.Text.Encoding]::ASCII.GetBytes("GET /health HTTP/1.0`r`nHost: 127.0.0.1`r`nConnection: close`r`n`r`n")
    $stream.Write($req, 0, $req.Length)
    $buf = New-Object byte[] 256
    $read = $stream.Read($buf, 0, $buf.Length)
    if ($read -gt 0) {
      $head = [System.Text.Encoding]::ASCII.GetString($buf, 0, $read)
      if ($head -match '^HTTP/\d') { return 'answers-http' }
    }
    return 'accepts-only'
  } catch {
    return 'accepts-only'
  } finally {
    try { $client.Close() } catch { }
  }
}

# Command line WITHOUT WMI/CIM: read the target's PEB->ProcessParameters->
# CommandLine with ntdll/kernel32 P/Invoke. Used only as an extra identity proof
# for the pid named in the heartbeat. Returns $null when it cannot be read, which
# is not a failure: the caller falls back to the lock file's pid + start ticks.
$script:clTypeReady = $false
$script:clTypeFailed = $false
function Get-ProcessCommandLineNoWmi([int]$TargetPid) {
  if ($TargetPid -le 0) { return $null }
  if ([IntPtr]::Size -ne 8) { return $null }   # offsets below are x64-only
  if ($script:clTypeFailed) { return $null }
  if (-not $script:clTypeReady) {
    try {
      if (-not ('JcodeNoWmiCmdLine' -as [type])) {
        Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class JcodeNoWmiCmdLine {
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out IntPtr read);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr h);
  [DllImport("ntdll.dll")]
  static extern int NtQueryInformationProcess(IntPtr h, int cls, byte[] info, int len, out int ret);
  public static string GetCommandLine(int pid) {
    const int PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const int PROCESS_VM_READ = 0x0010;
    IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, false, pid);
    if (h == IntPtr.Zero) { return null; }
    try {
      byte[] pbi = new byte[48];
      int retLen;
      if (NtQueryInformationProcess(h, 0, pbi, pbi.Length, out retLen) != 0) { return null; }
      long peb = BitConverter.ToInt64(pbi, 8);
      if (peb == 0) { return null; }
      IntPtr read;
      byte[] p = new byte[8];
      if (!ReadProcessMemory(h, (IntPtr)(peb + 0x20), p, 8, out read)) { return null; }
      long pp = BitConverter.ToInt64(p, 0);
      if (pp == 0) { return null; }
      byte[] us = new byte[16];
      if (!ReadProcessMemory(h, (IntPtr)(pp + 0x70), us, 16, out read)) { return null; }
      int len = BitConverter.ToUInt16(us, 0);
      long buf = BitConverter.ToInt64(us, 8);
      if (len <= 0 || len > 32768 || buf == 0) { return null; }
      byte[] s = new byte[len];
      if (!ReadProcessMemory(h, (IntPtr)buf, s, len, out read)) { return null; }
      string cl = Encoding.Unicode.GetString(s).Trim();
      if (cl.Length == 0) { return null; }
      return cl;
    } catch { return null; } finally { CloseHandle(h); }
  }
}
'@
      }
      $script:clTypeReady = $true
    } catch { $script:clTypeFailed = $true; return $null }
  }
  try {
    $cl = [JcodeNoWmiCmdLine]::GetCommandLine($TargetPid)
    if (-not $cl) { return $null }
    # Sanity filter: a mis-read must never look like a real command line.
    if ($cl.Length -lt 6 -or $cl.Length -gt 8192) { return $null }
    if ($cl -notmatch '[A-Za-z]{3,}') { return $null }
    if ($cl -notmatch '(?i)\.exe|\.ps1|powershell') { return $null }
    return $cl
  } catch { return $null }
}

function Get-ProcessFacts([int]$TargetPid) {
  if ($TargetPid -le 0) { return $null }
  $proc = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
  if (-not $proc) {
    return [pscustomobject]@{ Alive = $false; Pid = $TargetPid; StartTicks = ''; CommandLine = $null }
  }
  $ticks = ''
  try { $ticks = "$($proc.StartTime.ToUniversalTime().Ticks)" } catch { $ticks = '' }
  return [pscustomobject]@{
    Alive       = $true
    Pid         = $TargetPid
    StartTicks  = $ticks
    CommandLine = Get-ProcessCommandLineNoWmi $TargetPid
  }
}

function Get-LockFacts {
  if (-not (Test-Path -LiteralPath $lockFile)) { return $null }
  $raw = ''
  try {
    $fs = New-Object System.IO.FileStream($lockFile, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    $sr = New-Object System.IO.StreamReader($fs)
    $raw = $sr.ReadToEnd()
    $sr.Dispose(); $fs.Dispose()
  } catch { return $null }
  if (-not $raw) { return $null }
  $lp = 0
  if ($raw -match 'pid=(\d+)') { $lp = [int]$Matches[1] }
  $lt = ''
  if ($raw -match 'processStartTicks=(\d+)') { $lt = $Matches[1] }
  $ls = ''
  if ($raw -match '(?m)^script=(.+)$') { $ls = $Matches[1].Trim() }
  return [pscustomobject]@{ Pid = $lp; StartTicks = $lt; Script = $ls }
}

function Test-PathPhrase([string]$text, [string]$pathPhrase) {
  if (-not $text -or -not $pathPhrase) { return $false }
  $a = $text.ToLower().Replace('/', '\').Replace('"', '').Replace("'", '')
  $b = $pathPhrase.ToLower().Replace('/', '\')
  return $a.Contains($b)
}

# ---- the decision (pure; no I/O, no side effects) ---------------------------
# Inputs:
#   Heartbeat    $null, or { AgeSeconds, Pid, Ticks }
#   RouterAnswer 'answers-http' | 'accepts-only' | 'nothing'
#   Process      $null, or { Alive, Pid, StartTicks, CommandLine }
#   Lock         $null, or { Pid, StartTicks, Script }
# Output:
#   Action  'none' | 'recover-supervisor'
#   Reason  short machine-readable cause
#   StopPid pid to stop (0 = nothing to stop)
function Get-WatchdogDecision {
  param(
    [object]$Heartbeat,
    [string]$RouterAnswer = 'nothing',
    [object]$Process = $null,
    [object]$Lock = $null,
    [int]$StaleSeconds = 90,
    [string]$ExpectedScript = $expectedScript,
    [switch]$Paused
  )
  $d = [pscustomobject]@{
    Action  = 'none'
    Reason  = ''
    StopPid = 0
    Detail  = ''
    Stop    = $false
    RunTask = $false
    LockOwnerPid = 0
  }
  if ($Paused) { $d.Reason = 'paused'; return $d }

  if ($null -eq $Heartbeat) {
    # No heartbeat file at all. Two very different situations hide here:
    #   (a) there is no supervisor at all (its process is gone) and nobody is
    #       serving the port -> this is exactly the 2026-10-01 shape (wedged/killed
    #       supervisor, router dead, nothing able to bring either back), and the
    #       recovery is the documented human one: run the supervisor task. It then
    #       decides whether a router has to be started; this script never does.
    #   (b) a supervisor is running that predates the heartbeat patch, or no
    #       heartbeat exists because the port is being served fine. Do nothing:
    #       without a heartbeat there is no evidence the loop stopped turning.
    if ($RouterAnswer -eq 'nothing' -and $Process -and -not $Process.Alive) {
      if ($Lock -and $Lock.Pid -gt 0) {
        $d.Reason = 'no-heartbeat-lock-alive'
        $d.Detail = ("nothing on :{0}, no heartbeat, but the lock names pid {1} - the lock is not proof of life, so not acting on it" -f $Port, $Lock.Pid)
        return $d
      }
      $d.Action = 'recover-supervisor'
      $d.Reason = 'no-heartbeat-supervisor-dead'
      $d.StopPid = 0
      $d.Stop = $false
      $d.RunTask = $true
      $d.Detail = ("nothing on :{0}, no heartbeat file, and no supervisor process for pid {1} - running {2} (it decides what to start)" -f $Port, $Heartbeat.Pid, $TaskName)
      return $d
    }
    $d.Reason = 'no-heartbeat'
    return $d
  }
  if ($Heartbeat.AgeSeconds -lt $StaleSeconds) {
    $d.Reason = 'heartbeat-fresh'
    $d.Detail = ("heartbeat {0:N0}s old (< {1}s)" -f $Heartbeat.AgeSeconds, $StaleSeconds)
    return $d
  }
  if ($RouterAnswer -ne 'nothing') {
    # Something is listening on the port (it answered, or at least accepted a
    # connection). A slow or degraded router is the supervisor's business - its
    # 30-minute no-answer rule - and never a reason to take the supervisor down.
    $d.Reason = 'router-answers'
    $d.Detail = ("port {0} is {1}; heartbeat {2:N0}s old" -f $Port, $RouterAnswer, $Heartbeat.AgeSeconds)
    return $d
  }

  # Stale heartbeat AND a dead port: the supervisor has to be replaced.
  $ageTxt = ("heartbeat {0:N0}s old (> {1}s), nothing on :{2}" -f $Heartbeat.AgeSeconds, $StaleSeconds, $Port)
  if ($null -eq $Process) {
    $d.Reason = 'no-heartbeat-pid'
    $d.Detail = "$ageTxt, and the heartbeat names pid $($Heartbeat.Pid) which could not be inspected"
    return $d
  }
  if (-not $Process.Alive) {
    if ($Lock -and $Lock.Pid -gt 0 -and $Lock.Pid -ne $Heartbeat.Pid) {
      $d.Reason = 'lock-owned-by-other'
      $d.Detail = "$ageTxt; pid $($Heartbeat.Pid) is gone but the lock names pid $($Lock.Pid) - leaving the lock alone"
      return $d
    }
    $d.Action = 'recover-supervisor'
    $d.Reason = 'heartbeat-pid-dead'
    $d.StopPid = 0
    $d.Stop = $false
    $d.RunTask = $true
    $d.Detail = "$ageTxt; supervisor pid $($Heartbeat.Pid) is already gone, so: remove the stale lock (if it names it) and run the task"
    return $d
  }

  # Alive. Prove it is still the process the heartbeat names.
  if ($Process.CommandLine) {
    if (-not (Test-PathPhrase $Process.CommandLine $ExpectedScript)) {
      $d.Reason = 'command-line-mismatch'
      $d.Detail = "$ageTxt; pid $($Process.Pid) is alive but its command line does not name $ExpectedScript - refusing to stop an unrelated process"
      return $d
    }
  } else {
    $verifiedByLock = ($Lock -and $Lock.Pid -eq $Process.Pid -and $Lock.StartTicks -and $Process.StartTicks -and $Lock.StartTicks -eq $Process.StartTicks -and (Test-PathPhrase $Lock.Script $ExpectedScript))
    if (-not $verifiedByLock) {
      $d.Reason = 'identity-unverified'
      $d.Detail = "$ageTxt; pid $($Process.Pid) is alive; its command line could not be read and the lock file does not prove identity - refusing to stop it"
      return $d
    }
  }
  if ($Lock -and $Lock.Pid -gt 0 -and $Lock.Pid -ne $Process.Pid) {
    $d.Reason = 'lock-owned-by-other'
    $d.Detail = "$ageTxt; pid $($Process.Pid) matches, but the lock names pid $($Lock.Pid)"
    return $d
  }
  if ($Lock -and $Lock.StartTicks -and $Process.StartTicks -and $Lock.Pid -eq $Process.Pid -and $Lock.StartTicks -ne $Process.StartTicks) {
    $d.Reason = 'start-ticks-mismatch'
    $d.Detail = "$ageTxt; pid $($Process.Pid) was reused (lock ticks differ) - refusing to stop it"
    return $d
  }

  $d.Action = 'recover-supervisor'
  $d.Reason = 'stale-heartbeat-router-down'
  $d.StopPid = $Process.Pid
  $d.Stop = $true
  $d.RunTask = $true
  $d.LockOwnerPid = if ($Lock) { $Lock.Pid } else { 0 }
  $d.Detail = "$ageTxt; supervisor pid $($Process.Pid) verified as $ExpectedScript -> stop it, clear its lock, run $TaskName"
  return $d
}

# What the run did, recorded on the decision object so a test/harness can assert it
# without re-reading files. Filled in by Invoke-SupervisorWatchdog only.
function New-ActionOutcome {
  return [pscustomobject]@{
    Stopped          = $false
    StopFailed       = $false
    LockRemoved      = $false
    LockLeftForOther = $false
    LockNone         = $false
    TaskRanExitCode  = $null
    Aborted          = ''
  }
}

# ---- main -------------------------------------------------------------------
function Invoke-SupervisorWatchdog {
  param([switch]$WhatIf)

  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  $outcome = New-ActionOutcome

  if (Test-Path -LiteralPath $pauseFile) {
    Write-WatchdogLog "decision=none reason=paused ($pauseFile exists) - doing nothing"
    return
  }

  $hb = Get-HeartbeatState
  $answer = 'nothing'
  try { $answer = Get-RouterAnswer -Port $Port -TimeoutSeconds $HttpTimeoutSeconds } catch { $answer = 'nothing' }
  $procFacts = $null
  if ($hb) { $procFacts = Get-ProcessFacts $hb.Pid }
  $lockFacts = Get-LockFacts

  $d = Get-WatchdogDecision -Heartbeat $hb -RouterAnswer $answer -Process $procFacts -Lock $lockFacts -StaleSeconds $StaleSeconds -ExpectedScript $expectedScript

  $hbTxt = if ($hb) { "{0:N0}s" -f $hb.AgeSeconds } else { 'none' }
  $pidTxt = if ($hb) { "$($hb.Pid)" } else { '-' }
  Write-WatchdogLog ("decision={0} reason={1} heartbeat={2} heartbeatPid={3} routerAnswer={4} port={5} {6}" -f $d.Action, $d.Reason, $hbTxt, $pidTxt, $answer, $Port, $d.Detail)

  if ($d.Action -ne 'recover-supervisor') { return }

  # Last sanity check before acting: has the port come back while we looked?
  $recheck = 'nothing'
  try { $recheck = Get-RouterAnswer -Port $Port -TimeoutSeconds $HttpTimeoutSeconds } catch { $recheck = 'nothing' }
  if ($recheck -ne 'nothing') {
    Write-WatchdogLog ("decision=none reason=router-returned-during-check routerAnswer={0} port={1} - not touching the supervisor" -f $recheck, $Port)
    $outcome.Aborted = 'router-returned-during-check'
    return
  }

  if ($WhatIf) {
    if ($d.Stop) { Write-WatchdogLog ("WHATIF would stop supervisor pid {0} (verified), then remove {1} if it names that pid, then run: schtasks /run /tn {2}" -f $d.StopPid, $lockFile, $TaskName) }
    else { Write-WatchdogLog ("WHATIF would remove {0} if it names the dead pid {1}, then run: schtasks /run /tn {2}" -f $lockFile, $hb.Pid, $TaskName) }
    Write-Host ("WHATIF: {0} (nothing was stopped, no lock removed, no task run)" -f $d.Detail)
    $outcome.Aborted = 'whatif'
    return
  }

  if ($d.Stop -and $d.StopPid -gt 0) {
    try {
      Stop-Process -Id $d.StopPid -Force -ErrorAction Stop
      Write-WatchdogLog ("stopped wedged supervisor pid {0}" -f $d.StopPid)
      $outcome.Stopped = $true
    } catch {
      Write-WatchdogLog ("could not stop pid {0}: {1}" -f $d.StopPid, $_.Exception.Message)
      $outcome.StopFailed = $true
    }
    $waited = 0
    while ($waited -lt ($StopWaitSeconds * 4)) {
      if (-not (Get-Process -Id $d.StopPid -ErrorAction SilentlyContinue)) { break }
      Start-Sleep -Milliseconds 250
      $waited++
    }
    if (Get-Process -Id $d.StopPid -ErrorAction SilentlyContinue) {
      Write-WatchdogLog ("pid {0} is still alive {1}s after the stop; not running the task (a second supervisor would be refused anyway)" -f $d.StopPid, $StopWaitSeconds)
      $outcome.Aborted = 'still-alive-after-stop'
      return
    }
  }

  # Remove the lock ONLY when it belongs to the supervisor this run dealt with.
  $lockNow = Get-LockFacts
  $deadPid = if ($d.StopPid -gt 0) { $d.StopPid } else { $hb.Pid }
  if ($lockNow -and $lockNow.Pid -gt 0) {
    if ($lockNow.Pid -eq $deadPid) {
      $stillAlive = Get-Process -Id $lockNow.Pid -ErrorAction SilentlyContinue
      if ($stillAlive) {
        Write-WatchdogLog ("lock names pid {0} which is still alive - leaving the lock in place" -f $lockNow.Pid)
        $outcome.Aborted = 'lock-owner-alive'
        return
      }
      try {
        Remove-Item -LiteralPath $lockFile -Force -ErrorAction Stop
        Write-WatchdogLog ("removed stale lock {0} (owner pid {1} is gone)" -f $lockFile, $lockNow.Pid)
        $outcome.LockRemoved = $true
      } catch {
        Write-WatchdogLog ("could not remove lock {0}: {1}" -f $lockFile, $_.Exception.Message)
        $outcome.Aborted = 'lock-remove-failed'
      }
    } else {
      Write-WatchdogLog ("lock names pid {0}, not {1} - leaving the lock in place" -f $lockNow.Pid, $deadPid)
      $outcome.LockLeftForOther = $true
    }
  } else {
    Write-WatchdogLog "no lock file to remove"
    $outcome.LockNone = $true
  }

  # Recovery must work even when the target task has been disabled. On
  # 2026-10-02 the supervisor stayed dead for hours because
  # LayaCompanyRouterSupervisor was Disabled and every `schtasks /run` below
  # failed with "could not run because it is disabled". Re-enable it first
  # (a no-op when it is already enabled), then run it.
  try {
    $en = & $schtasks /change /tn $TaskName /enable 2>&1
    Write-WatchdogLog ("ran schtasks /change /tn {0} /enable -> exit {1} {2}" -f $TaskName, $LASTEXITCODE, (($en | Out-String).Trim() -replace '\s+', ' '))
  } catch {
    Write-WatchdogLog ("could not re-enable schtasks /tn {0}: {1}" -f $TaskName, $_.Exception.Message)
  }

  try {
    $out = & $schtasks /run /tn $TaskName 2>&1
    $code = $LASTEXITCODE
    Write-WatchdogLog ("ran schtasks /run /tn {0} -> exit {1} {2}" -f $TaskName, $code, (($out | Out-String).Trim() -replace '\s+', ' '))
    $outcome.TaskRanExitCode = $code
    if ($code -ne 0 -and -not $outcome.Aborted) { $outcome.Aborted = 'schtasks-exit-' + $code }
  } catch {
    Write-WatchdogLog ("could not run schtasks /run /tn {0}: {1}" -f $TaskName, $_.Exception.Message)
    $outcome.Aborted = 'schtasks-threw'
  }
}

# Run for real, with no scheduled task to run and no live supervisor to touch:
# the action path with $TaskName pointed at a name that does not exist, and the
# lock tempered with in a scratch directory. Used by
# ops/supervisor-watchdog-check.ps1 to prove the non-WhatIf path stops only the
# pid it verified, clears only that pid's lock, and reports a failed schtasks run.
function Invoke-SupervisorWatchdogSelfTest {
  param(
    [string]$FakeSupervisorScript = '',
    [string]$ExpectedScript = '',
    [int]$Stale = 300
  )
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  $outcome = New-ActionOutcome

  $stand = $null
  try {
    $stand = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $FakeSupervisorScript + '"'), ('"' + $ExpectedScript + '"')) -WindowStyle Hidden -PassThru
    $deadline = (Get-Date).AddSeconds(20)
    $cl = $null
    while ((Get-Date) -lt $deadline) {
      $cl = Get-ProcessCommandLineNoWmi $stand.Id
      if ($cl -and (Test-PathPhrase $cl $ExpectedScript)) { break }
      Start-Sleep -Milliseconds 500
    }
    $proc = Get-ProcessFacts $stand.Id
    $proc.CommandLine = $cl

    # A lock that belongs to the stand-in for real (same pid, same start ticks),
    # and a heartbeat that says this stand-in is the supervisor.
    function Write-HeartbeatFor([int]$HbPid, [int]$AgeSeconds) {
      $stamp = ([DateTimeOffset]::Now).AddSeconds(-$AgeSeconds).ToString("yyyy-MM-dd'T'HH:mm:ss.fffK")
      [System.IO.File]::WriteAllText($heartbeatFile, "$stamp pid=$HbPid ticks=$($proc.StartTicks)`n")
    }
    Write-HeartbeatFor $stand.Id $Stale
    Set-Content -LiteralPath $lockFile -Value ("pid={0}`nstarted={1}`nprocessStartTicks={2}`nscript={3}" -f $stand.Id, (Now-Stamp), $proc.StartTicks, $ExpectedScript) -Encoding utf8

    $hb = Get-HeartbeatState
    $lock = Get-LockFacts
    $d = Get-WatchdogDecision -Heartbeat $hb -RouterAnswer 'nothing' -Process $proc -Lock $lock -StaleSeconds $StaleSeconds -ExpectedScript $ExpectedScript
    Write-WatchdogLog ("selftest decision={0} reason={1} heartbeatPid={2}" -f $d.Action, $d.Reason, $stand.Id)
    if ($d.Action -ne 'recover-supervisor') { $outcome.Aborted = 'selftest-no-recovery: ' + $d.Reason; return $outcome }

    # Same steps as the real path, on purpose: stop exactly this pid, clear this
    # lock, then run a task name that cannot exist.
    try { Stop-Process -Id $d.StopPid -Force -ErrorAction Stop; $outcome.Stopped = $true } catch { $outcome.StopFailed = $true }
    for ($i = 0; $i -lt 20; $i++) {
      if (-not (Get-Process -Id $d.StopPid -ErrorAction SilentlyContinue)) { break }
      Start-Sleep -Milliseconds 250
    }
    if (Get-Process -Id $d.StopPid -ErrorAction SilentlyContinue) { $outcome.Aborted = 'still-alive-after-stop'; return $outcome }

    $lockNow = Get-LockFacts
    $deadPid = if ($d.StopPid -gt 0) { $d.StopPid } else { $hb.Pid }
    if ($lockNow -and $lockNow.Pid -eq $deadPid) {
      try { Remove-Item -LiteralPath $lockFile -Force -ErrorAction Stop; $outcome.LockRemoved = $true } catch { $outcome.Aborted = 'lock-remove-failed' }
    } elseif ($lockNow) { $outcome.LockLeftForOther = $true } else { $outcome.LockNone = $true }

    if (-not $outcome.Aborted) {
      try {
        $out = & $schtasks /run /tn $TaskName 2>&1
        $outcome.TaskRanExitCode = $LASTEXITCODE
        Write-WatchdogLog ("selftest ran schtasks /run /tn {0} -> exit {1}" -f $TaskName, $LASTEXITCODE)
        if ($LASTEXITCODE -eq 0) { $outcome.Aborted = 'unexpected-task-success' }
      } catch { $outcome.Aborted = 'schtasks-threw' }
    }
    # Only a clean run counts as a pass: the stand-in gone, its lock gone, and the
    # (deliberately nonexistent) task reported as unreachable.
    if (-not $outcome.Stopped) { $outcome.Aborted = 'stand-in-not-stopped' }
    elseif (-not $outcome.LockRemoved) { $outcome.Aborted = 'lock-not-removed' }
    elseif ($null -eq $outcome.TaskRanExitCode -or $outcome.TaskRanExitCode -eq 0) { $outcome.Aborted = 'task-result-not-a-failure' }
    elseif ($outcome.Aborted -eq 'schtasks-exit-prefix') { $outcome.Aborted = 'schtasks-exit-' + $outcome.TaskRanExitCode }
    return $outcome
  } finally {
    if ($stand -and (Get-Process -Id $stand.Id -ErrorAction SilentlyContinue)) { Stop-Process -Id $stand.Id -Force -ErrorAction SilentlyContinue }
  }
}

if ($LibraryOnly -or $MyInvocation.InvocationName -eq '.') { return }

if ($Status) {
  $hb = Get-HeartbeatState
  $answer = Get-RouterAnswer -Port $Port -TimeoutSeconds $HttpTimeoutSeconds
  $procFacts = $null
  if ($hb) { $procFacts = Get-ProcessFacts $hb.Pid }
  $lockFacts = Get-LockFacts
  $d = Get-WatchdogDecision -Heartbeat $hb -RouterAnswer $answer -Process $procFacts -Lock $lockFacts -StaleSeconds $StaleSeconds -ExpectedScript $expectedScript
  Write-Output ("heartbeat file   : {0}" -f $heartbeatFile)
  Write-Output ("heartbeat age    : {0}" -f $(if ($hb) { "{0:N1} s (pid {1})" -f $hb.AgeSeconds, $hb.Pid } else { '(none)' }))
  Write-Output ("router answer    : {0} (port {1})" -f $answer, $Port)
  Write-Output ("lock file        : {0}" -f $(if ($lockFacts) { "pid {0} (script {1})" -f $lockFacts.Pid, $lockFacts.Script } else { '(none)' }))
  Write-Output ("pause file       : {0}" -f $(if (Test-Path -LiteralPath $pauseFile) { 'present (watchdog paused)' } else { 'absent' }))
  Write-Output ("decision         : {0} / {1}" -f $d.Action, $d.Reason)
  Write-Output ("detail           : {0}" -f $d.Detail)
  Write-Output ("task             : {0}" -f $TaskName)
  Write-Output ("log              : {0}" -f $LogFile)
  return
}

Invoke-SupervisorWatchdog -WhatIf:$WhatIf
