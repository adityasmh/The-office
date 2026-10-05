# ops/probe-opencode.ps1 — reproduce the pipeline coder hang with variants.
# Launches several `opencode run --format json` shapes CONCURRENTLY, each with a
# hard timeout, then summarizes: exit code, wall time, event types, cost, files.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File ops/probe-opencode.ps1 [-TimeoutSec 100]

param(
  [string]$Root = "C:\Users\user\Desktop\Default Project",
  [int]$TimeoutSec = 100
)

$exe = "C:\Users\user\AppData\Roaming\npm\node_modules\opencode-ai\bin\opencode.exe"
$probeRoot = Join-Path $Root "company\probe-hang"
New-Item -ItemType Directory -Force -Path $probeRoot | Out-Null

$coderSystem = "You are a Coder. Implement the assigned subtask: edit the files, keep the diff minimal and focused, and report exactly what you changed and why. Follow the acceptance criteria. Run relevant checks if feasible."
$longPrompt = "$coderSystem`n`nTASK:`ncreate hello.txt with content hello"
$shortPrompt = "create hello.txt with content hello"

$variants = @(
  @{ Name = "deepseek-long";    Model = "opencode-go/deepseek-v4-flash"; Prompt = $longPrompt;  Cwd = $false },
  @{ Name = "kimi-long";        Model = "opencode-go/kimi-k2.7-code";    Prompt = $longPrompt;  Cwd = $false },
  @{ Name = "kimi-long-cwd";    Model = "opencode-go/kimi-k2.7-code";    Prompt = $longPrompt;  Cwd = $true },
  @{ Name = "kimi-short";       Model = "opencode-go/kimi-k2.7-code";    Prompt = $shortPrompt; Cwd = $false }
)

Write-Host "probe root: $probeRoot" -ForegroundColor Cyan
Write-Host "timeout per run: ${TimeoutSec}s (all variants run concurrently)" -ForegroundColor Cyan
Write-Host ""

$started = @()
foreach ($v in $variants) {
  $dir = Join-Path $probeRoot $v.Name
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $out = Join-Path $probeRoot "$($v.Name).stdout.txt"
  $err = Join-Path $probeRoot "$($v.Name).stderr.txt"
  Remove-Item $out, $err -ErrorAction SilentlyContinue
  $sp = @{
    FilePath               = $exe
    ArgumentList           = @("run", "--dir", $dir, "--model", $v.Model, "--auto", "--format", "json", $v.Prompt)
    RedirectStandardOutput = $out
    RedirectStandardError  = $err
    PassThru               = $true
    NoNewWindow            = $true
  }
  if ($v.Cwd) { $sp["WorkingDirectory"] = $dir }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $proc = Start-Process @sp
  $started += [pscustomobject]@{ V = $v; Proc = $proc; Dir = $dir; Out = $out; Err = $err; Sw = $sw; Status = $null }
}

# Shared deadline: they are all running in parallel, so poll until all are done
# or the deadline passes, then kill whatever is still alive.
$deadline = (Get-Date).AddSeconds($TimeoutSec + 15)
$results = @()
foreach ($s in $started) {
  $remainingMs = [math]::Max(0, [int]($deadline - (Get-Date)).TotalMilliseconds)
  $exited = $false
  try { $exited = $s.Proc.WaitForExit($remainingMs) } catch { $exited = $true }
  $s.Sw.Stop()
  if (-not $exited) {
    try { $s.Proc.Kill() } catch { }
    $status = "TIMEOUT_KILLED"
    $exitCode = "n/a"
  } else {
    $status = "EXITED"
    $exitCode = $s.Proc.ExitCode
  }
  Start-Sleep -Milliseconds 400

  $types = @{}
  $cost = 0.0
  $stopSeen = $false
  $lines = 0
  $lastEvent = ""
  if (Test-Path $s.Out) {
    foreach ($line in (Get-Content $s.Out -ErrorAction SilentlyContinue)) {
      if (-not $line.Trim()) { continue }
      $lines++
      try { $ev = $line | ConvertFrom-Json } catch { continue }
      if ($ev.type) {
        $cur = 0
        if ($types.ContainsKey($ev.type)) { $cur = [int]$types[$ev.type] }
        $types[$ev.type] = $cur + 1
        $lastEvent = $ev.type
        if ($ev.type -eq "step_finish") { $lastEvent = "step_finish:" + $ev.part.reason }
      }
      if ($ev.type -eq "step_finish") {
        if ($null -ne $ev.part.cost) { $cost += [double]$ev.part.cost }
        if ($ev.part.reason -eq "stop") { $stopSeen = $true }
      }
    }
  }
  $files = @(Get-ChildItem $s.Dir -File -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
  $errLen = 0
  if (Test-Path $s.Err) { $errLen = (Get-Item $s.Err).Length }

  $results += [pscustomobject]@{
    Name       = $s.V.Name
    Model      = $s.V.Model
    CwdSet     = [bool]$s.V.Cwd
    Status     = $status
    ExitCode   = $exitCode
    Seconds    = [math]::Round($s.Sw.Elapsed.TotalSeconds, 1)
    JsonLines  = $lines
    StopEvent  = $stopSeen
    LastEvent  = $lastEvent
    CostUsd    = [math]::Round($cost, 6)
    Types      = (($types.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Key)x$($_.Value)" }) -join " ")
    FilesMade  = ($files -join ",")
    ErrBytes   = $errLen
  }
}

$results | Format-Table Name, Model, CwdSet, Status, ExitCode, Seconds, JsonLines, StopEvent, LastEvent, CostUsd, FilesMade, ErrBytes -AutoSize | Out-String -Width 400 | Write-Host

Write-Host "EVENT TYPES SEEN" -ForegroundColor Magenta
foreach ($r in $results) { Write-Host ("  {0,-16} {1}" -f $r.Name, $r.Types) }
Write-Host ""
Write-Host "RAW TAIL (last 2 JSON lines per variant)" -ForegroundColor Magenta
foreach ($r in $results) {
  $f = Join-Path $probeRoot "$($r.Name).stdout.txt"
  Write-Host "  --- $($r.Name) ---" -ForegroundColor DarkGray
  if (Test-Path $f) {
    Get-Content $f -Tail 2 | ForEach-Object { if ($_.Length -gt 300) { $_.Substring(0, 300) + "..." } else { $_ } } | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
  } else { Write-Host "    (no stdout file)" -ForegroundColor DarkGray }
}
