# Lists MY fleet worker/probe sessions and the window that hosts each one.
# Read-only: it never kills anything. Killing is done by ops/close-fleet-windows.ps1.
$cs = Join-Path $env:USERPROFILE '.jcode\client_sessions'
$jd = Join-Path $env:USERPROFILE '.jcode\sessions'
$mine = @('microbe','daisy','evergreen','palmtree','seedling','herb','ant')

$map = @{}
foreach ($f in Get-ChildItem $cs) {
  $sid = (Get-Content $f.FullName -Raw).Trim()
  if ($sid) { $map[$sid] = [int]$f.Name }
}

$procs = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CommandLine
$byId = @{}
foreach ($p in $procs) { $byId[[int]$p.ProcessId] = $p }

Write-Output '--- my fleet sessions ---'
foreach ($sid in ($map.Keys | Sort-Object)) {
  $short = ($sid -split '_')[1]
  if ($mine -notcontains $short) { continue }
  $cpid = $map[$sid]
  $alive = [bool](Get-Process -Id $cpid -ErrorAction SilentlyContinue)

  $cur = $byId[$cpid]
  $win = 0
  $winCmd = ''
  for ($i = 0; $i -lt 6 -and $cur; $i++) {
    $cmd = [string]$cur.CommandLine
    if ($cmd -like '*\company\fleet\*' -or $cmd -like '*run.ps1*') {
      $win = [int]$cur.ProcessId
      $winCmd = $cmd
      break
    }
    $cur = $byId[[int]$cur.ParentProcessId]
  }

  $j = Join-Path $jd ($sid + '.journal.jsonl')
  $idle = -1
  if (Test-Path $j) { $idle = [int]((Get-Date) - (Get-Item $j).LastWriteTime).TotalMinutes }

  $streaming = Test-Path (Join-Path $env:USERPROFILE ('.jcode\streaming_pids\' + $sid))
  $shortCmd = if ($winCmd.Length -gt 80) { $winCmd.Substring(0, 80) } else { $winCmd }
  Write-Output ("{0,-10} sid={1}" -f $short, $sid)
  Write-Output ("           client={0} alive={1} window={2} idleMin={3} streaming={4}" -f $cpid, $alive, $win, $idle, $streaming)
  if ($shortCmd) { Write-Output ("           winCmd={0}" -f $shortCmd) }
}
