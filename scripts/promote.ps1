<#
scripts/promote.ps1 - PROMOTE the working tree to PROD (CEO order 2026-09-30).

WHAT PROD/DEV/RELEASE MEAN HERE
  DEV   = scripts\dev-router.ps1 -Name <job>   (working tree, isolated COMPANY_ROOT, port 8801-8899)
  RELEASE = release\  a frozen copy of the tree that PROD serves. Agents never edit it.
  PROD  = the router on :8787, supervised by the LayaCompanyRouterSupervisor task, serving RELEASE.
  PROMOTE = this script: preflight -> snapshot the current release -> build a new one in release-staging
            -> smoke it on a throwaway port with a TEMP company root -> copy it into release\ -> swap PROD
            onto the release (the scheduled task starts its supervisor from release\ops\router-supervisor.ps1)
            -> verify; on any failure restore the previous release and swap back.

WHO RUNS IT: the manager or the CEO only (CEO order). It requires -Approved, and it is the ONLY thing
allowed to touch :8787 (docs/AGENT_COORDINATION.md rule 6). Agents that want to test run DEV.

WHY IT IS SAFE TO REHEARSE: -Port/-TaskName default to PROD (8787 / LayaCompanyRouterSupervisor) but can
be pointed at a throwaway port+task, so the whole promote including the swap can be proven without
touching the live dashboard. The proof in docs/AGENT_COORDINATION.md was made with -Port 8899.

USAGE
  # rehearse end to end on a throwaway port (builds release\, smokes it, swaps the test port):
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\promote.ps1 -Approved -Port 8899 -TaskName LayaCompanyRouterSupervisor-8899
  # build + smoke only, touch nothing:
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\promote.ps1 -Approved -DryRun
  # the real thing (manager/CEO):
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\promote.ps1 -Approved
#>
# ================================================================================================
# FIXED 2026-09-30 (PROMOTE-FIX). READ THIS BEFORE THE FIRST REAL RUN.
#
# INCIDENT: this script destroyed the live company data at 09:52. Its robocopy /MIR calls walked
# THROUGH the release\ junctions (release\company, release\logs, release\node_modules -> the live
# dirs) and deleted the live contents. node_modules was left present but EMPTY; company\org.json was
# reset to an empty shell.
#
# WHAT CHANGED (all proven on a %TEMP% sandbox, old vs new, including the forced-rollback leg):
#   1. NO /MIR ANYWHERE. Every mirror is now /E (overwrite + add, NEVER delete). The mirror's cleanup
#      semantics come from an explicit prune (Remove-StaleFromMirror) that REFUSES to enter or touch
#      any reparse point.
#   2. /XJ is on every robocopy anyway (the order's requirement). MEASURED on the sandbox: /XJ excludes
#      junction points on the SOURCE side (with a source junction present /XJ skipped it; without /XJ
#      robocopy descended it and materialised a real copy), but it does NOT protect the DESTINATION - a
#      destination junction's target was still written through by /E, and still walked/deleted by /MIR,
#      with /XJ set. So /E + the source-side /XD are the load-bearing protections; /XJ is belt and braces.
#   3. HARD GUARD (section 0b): refuses any delete/mirror whose target path is a junction/symlink or
#      whose resolved target is under the live company\, logs\ or node_modules\, and refuses if
#      release\company|logs|node_modules is not a junction into the live dir.
#   4. The throwaway tree clear (release-staging, release-prev, the smoke temp root) never descends a
#      reparse point: a junction inside it is removed AS A LINK (`cmd rmdir` removes only the link; the
#      target is untouched). Needed because release-staging still holds the previous build's three
#      junctions - a clear that refused would abort EVERY promote after the first (found by re-running
#      the sandbox proof twice; see docs/AGENT_COORDINATION.md).
#
# STATUS: fixed, proven on a disposable sandbox ONLY. It has NOT been run against the real tree since
# the fix. The manager or the CEO must approve the FIRST REAL RUN: scripts\promote.ps1 -Approved.
# ================================================================================================
[CmdletBinding()]
param(
  [int]$Port = 8787,
  [string]$TaskName = "LayaCompanyRouterSupervisor",
  [int]$ProdPort = 8787,
  [int]$LagLimitMs = 250,
  [int]$SmokePort = 0,
  [int]$TimeoutSec = 180,
  [switch]$Approved,
  [switch]$DryRun,
  [switch]$SmokeOnly,
  [switch]$SkipPreflight,
  [switch]$IgnoreInFlight,
  # REHEARSAL ONLY: a temp COMPANY_ROOT + no Slack for the swapped supervisor, so a throwaway-port
  # rehearsal can never touch live company data. Leave empty for a real promote (prod's data stays put
  # via release\company -> ..\company).
  [string]$SwapCompanyRoot = "",
  # TEST ONLY: point the release task at a path that does not exist, so the swap fails on purpose and the
  # rollback leg runs for real. Used to prove the rollback end to end on a throwaway port.
  [switch]$ForceSwapFail
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$release = Join-Path $root 'release'
$staging = Join-Path $root 'release-staging'
$prev = Join-Path $root 'release-prev'
$promoteLog = Join-Path $root 'logs\promote.log'
New-Item -ItemType Directory -Force -Path (Join-Path $root 'logs') | Out-Null

function Say([string]$m, [string]$color = 'Gray') {
  Write-Host $m -ForegroundColor $color
  $line = "[{0}] {1}" -f (Get-Date).ToString('s'), $m
  try { Add-Content -LiteralPath $promoteLog -Value $line -ErrorAction SilentlyContinue } catch { }
}
function Fail([string]$m) { Say ("ABORT: " + $m) 'Red'; exit 1 }
function Test-Http([int]$p, [string]$path = '/health', [int]$timeoutSec = 10) {
  $raw = & curl.exe -s -m $timeoutSec "http://127.0.0.1:$p$path" 2>$null
  return $raw
}
function Test-HealthJson([int]$p, [int]$timeoutSec = 10) {
  $raw = Test-Http $p '/health' $timeoutSec
  if (-not $raw) { return $null }
  try { return ($raw | ConvertFrom-Json) } catch { return $null }
}
function Get-ListenerPid([int]$p) {
  $l = (& netstat.exe -ano -p tcp | Select-String ":$p " | Select-String 'LISTENING' | Select-Object -First 1)
  if (-not $l) { return 0 }
  $parts = ($l.ToString().Trim() -split '\s+')
  if ($parts.Length -ge 5) { return [int]$parts[4] }
  return 0
}
function Test-PortFree([int]$p) {
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $c.BeginConnect('127.0.0.1', $p, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(300)) { return $true }
    try { $c.EndConnect($iar); return $false } catch { return $true }
  } catch { return $true } finally { try { $c.Close() } catch { } }
}

# ---- reparse-point (junction/symlink) safety ---------------------------------
# A junction is a reparse point: reading through it is fine, but DELETING or MIRRORING "through" it
# (robocopy /MIR, Remove-Item -Recurse) reaches the live target. That is exactly the 09:52 data loss.
# These helpers make that impossible.
function Test-IsReparse([string]$p) {
  try { $i = Get-Item -LiteralPath $p -Force -ErrorAction Stop } catch { return $false }
  return [bool]($i.Attributes -band [IO.FileAttributes]::ReparsePoint)
}
function Resolve-FinalTarget([string]$p) {
  # follow junctions/symlinks to the physical path (bounded, loop-safe) - used only for the guard test
  $cur = $p
  for ($i = 0; $i -lt 16; $i++) {
    if (-not (Test-Path -LiteralPath $cur)) { break }
    $it = Get-Item -LiteralPath $cur -Force -ErrorAction SilentlyContinue
    if (-not $it -or -not ($it.Attributes -band [IO.FileAttributes]::ReparsePoint)) { break }
    $t = @($it.Target) | Where-Object { $_ } | Select-Object -First 1
    if (-not $t) { break }
    if (-not [IO.Path]::IsPathRooted($t)) { $t = Join-Path (Split-Path -Parent $cur) $t }
    $cur = [IO.Path]::GetFullPath($t)
  }
  try { return [IO.Path]::GetFullPath($cur) } catch { return $cur }
}
function Get-LiveDirs { return @((Join-Path $root 'company'), (Join-Path $root 'logs'), (Join-Path $root 'node_modules')) }
function Test-UnderLive([string]$p) {
  $full = (Resolve-FinalTarget $p).TrimEnd('\')
  foreach ($l in (Get-LiveDirs)) {
    $lf = [IO.Path]::GetFullPath($l).TrimEnd('\')
    if ($full.Equals($lf, [StringComparison]::OrdinalIgnoreCase)) { return $lf }
    if ($full.StartsWith($lf + '\', [StringComparison]::OrdinalIgnoreCase)) { return $lf }
  }
  return $null
}
function Assert-SafeTarget([string]$p, [string]$what) {
  # HARD GUARD: refuse a delete/mirror whose target path is a junction/symlink, or resolves through a
  # junction under the live company\, logs\ or node_modules\.
  if (-not (Test-Path -LiteralPath $p)) { return }
  if (Test-IsReparse $p) {
    Fail ("GUARD: refusing to run a delete/mirror against `"$p`" ($what) - it is a junction/symlink (-> " + (Resolve-FinalTarget $p) + "). Robocopy/Remove-Item must never be pointed at a reparse point.")
  }
  $under = Test-UnderLive $p
  if ($under) {
    Fail ("GUARD: refusing to run a delete/mirror against `"$p`" ($what) - it resolves under live `"$under`". That is the 09:52 data-loss path.")
  }
}
function Assert-ReleaseLinks {
  # release\company|logs|node_modules MUST be junctions into $root. A real directory there would be
  # served as if it were live prod data; a wrong target would point prod at the wrong tree.
  foreach ($n in @('company', 'logs', 'node_modules')) {
    if (-not (Test-Path $release)) { continue }
    $lp = Join-Path $release $n
    if (-not (Test-Path -LiteralPath $lp)) { continue }
    if (-not (Test-IsReparse $lp)) {
      Fail ("GUARD: `"$lp`" is a REAL directory, not a junction - release\ must link " + $n + " to the live " + $n + "\ (a real release\" + $n + " would shadow/duplicate live data).")
    }
    $want = [IO.Path]::GetFullPath((Join-Path $root $n)).TrimEnd('\')
    $got = (Resolve-FinalTarget $lp).TrimEnd('\')
    if (-not $got.Equals($want, [StringComparison]::OrdinalIgnoreCase)) {
      Fail ("GUARD: release\" + $n + " is a junction to `"$got`" but expected `"$want`".")
    }
  }
  Say "guard: release\company, release\logs, release\node_modules are junctions into the live dirs (expected)" 'Green'
}
function Get-ReparsePoints([string]$p) {
  # List reparse points in a tree WITHOUT descending into them. The walk is manual and attribute-based
  # on purpose: whether Get-ChildItem -Recurse follows a junction has varied across PowerShell builds
  # (measured on this box, 5.1.26100.9444: it lists the junction itself and does NOT descend - so this
  # is version-independent defence, not a workaround for a confirmed recursion).
  $hits = New-Object System.Collections.Generic.List[string]
  if (-not (Test-Path -LiteralPath $p)) { return $hits }
  $stack = New-Object System.Collections.Stack
  $stack.Push($p)
  while ($stack.Count -gt 0) {
    $d = $stack.Pop()
    foreach ($c in (Get-ChildItem -LiteralPath $d -Force -ErrorAction SilentlyContinue)) {
      if ([bool]($c.Attributes -band [IO.FileAttributes]::ReparsePoint)) { [void]$hits.Add($c.FullName) }
      elseif ($c.PSIsContainer) { $stack.Push($c.FullName) }
    }
  }
  return $hits
}
function Remove-ReparseLinks([string]$dir) {
  # Remove every junction/symlink INSIDE a throwaway tree we are about to delete, AS A LINK ONLY
  # (`cmd rmdir` on a junction removes just the link - measured: liveTop/liveNested stayed True - and a
  # plain Remove-Item on a junction instead PROMPTS, which would hang an unattended run), and never
  # descend into it. Needed because after a promote release-staging still holds that build's three
  # junctions: a clear that refused would abort every promote after the first.
  foreach ($c in (Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue)) {
    if ([bool]($c.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      $link = $c.FullName
      if ($c.PSIsContainer) { & cmd.exe /c "rmdir `"$link`"" 2>&1 | Out-Null }
      else { Remove-Item -LiteralPath $link -Force -Confirm:$false -ErrorAction SilentlyContinue }
      Say ("  guard: removed reparse LINK, target untouched: " + $link) 'Yellow'
      continue
    }
    if ($c.PSIsContainer) { Remove-ReparseLinks $c.FullName }
  }
}
function Remove-SafeTree([string]$p) {
  # the explicit safe delete of a throwaway tree. It never descends into a reparse point: links inside
  # are removed as links first, and if any link survives the whole delete is refused rather than risk
  # Remove-Item -Recurse walking it.
  if (-not (Test-Path -LiteralPath $p)) { return $true }
  if (Test-IsReparse $p) { Say ("  guard: NOT deleting `"$p`" - it is a junction/symlink") 'Yellow'; return $false }
  Remove-ReparseLinks $p
  $left = Get-ReparsePoints $p
  if ($left.Count -gt 0) {
    Say ("  guard: NOT deleting `"$p`" - " + $left.Count + " reparse point(s) could not be removed (first: " + $left[0] + "); deleting through a junction is the 09:52 bug") 'Yellow'
    return $false
  }
  Remove-Item -LiteralPath $p -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue
  return (-not (Test-Path -LiteralPath $p))
}
function Remove-StaleFromMirror([string]$ref, [string]$target) {
  # /MIR's cleanup semantics without /MIR: delete entries in $target absent from $ref, never entering
  # or touching a reparse point (so release\company|logs|node_modules are untouchable here).
  if (-not (Test-Path -LiteralPath $target)) { return }
  foreach ($c in (Get-ChildItem -LiteralPath $target -Force -ErrorAction SilentlyContinue)) {
    if ([bool]($c.Attributes -band [IO.FileAttributes]::ReparsePoint)) { continue }
    $r = Join-Path $ref $c.Name
    if (-not (Test-Path -LiteralPath $r)) { [void](Remove-SafeTree $c.FullName); continue }
    if ($c.PSIsContainer) { Remove-StaleFromMirror $r $c.FullName }
  }
}

# Exclusions, in two kinds - and the difference matters:
#   * ABSOLUTE paths: the top-level directories that belong to the live company (company\ logs\ dev\ deps\
#     models\ vendor\ dist\), never part of a release.
#   * bare NAMES: directories that can appear anywhere (node_modules, python venvs, caches).
# The first version of this list used bare names for everything, so `/XD company` also excluded
# `src\company\` - 39 of the 49 source files vanished from the staging and the smoke caught it with
# `ERR_MODULE_NOT_FOUND ... release-staging/src/company/brainRouter.js`. Absolute for the top level,
# names only for what is genuinely nested.
$PayloadXabs = @('company', 'logs', 'dev', 'deps', 'models', 'vendor', 'dist', 'release', 'release-staging', 'release-prev')
$PayloadXnames = @('node_modules', '*-venv', '.venv', 'venv', '__pycache__', 'snapshots', '.next', 'build', '.git')

# ---------------------------------------------------------------- 0. guard ---
if (-not $Approved) {
  Say "REFUSING: promote.ps1 requires -Approved. Only the manager or the CEO promotes (CEO order 2026-09-30)." 'Red'
  Say "          Agents test on DEV:  scripts\dev-router.ps1 -Name <job>" 'Yellow'
  exit 2
}
Say ("=" * 78)
Say ("promote.ps1 start  port=$Port task=$TaskName dryRun=$DryRun smokeOnly=$SmokeOnly release=$release")

# A swap away from :8787 is a rehearsal: it MUST NOT serve live company data. Refuse unless the caller
# says which throwaway COMPANY_ROOT to use (rule 5: never start a server against the live company\).
if ($Port -ne $ProdPort -and -not $SwapCompanyRoot) {
  Fail ("a swap on :$Port (not the prod port :$ProdPort) needs -SwapCompanyRoot <temp dir> so the rehearsal cannot touch live company data")
}

# ====================================================== 0b. HARD GUARD =======
# Nothing below may delete or mirror a path that IS a junction/symlink or that resolves under the live
# company\, logs\ or node_modules\ (the 09:52 data-loss path), and release\ must keep its junctions.
Assert-SafeTarget $release "snapshot/publish/rollback target (release\)"
Assert-SafeTarget $staging "staging build target (release-staging\)"
Assert-SafeTarget $prev    "rollback source (release-prev\)"
Say "guard: release\, release-staging\, release-prev\ are plain directories (not junction/live targets)" 'Green'
Assert-ReleaseLinks

# ------------------------------------------------------------ 1. preflight ---
if (-not $SkipPreflight) {
  # 1a. a router boot must not be in flight (ops/guard-protected.ps1 -Check refuses in that case)
  $c = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'ops\guard-protected.ps1') -Check 2>&1
  $cek = ($c | Out-String)
  if ($LASTEXITCODE -ne 0) {
    if ($cek -match 'IN FLIGHT|in flight') { Fail "a router boot is in flight - refusing to promote (ops\guard-protected.ps1 -Check said: $($cek.Trim()))" }
    Say "  note: ops\guard-protected.ps1 -Check exits $LASTEXITCODE (protected files differ from the baseline). Reason:" 'Yellow'
    Say ("    " + ($cek.Trim() -replace "`r?`n", " | ")) 'Yellow'
  } else { Say "  guard: protected paths clean" 'Green' }

  # 1b. nothing mid-run in the pipeline
  $mid = @()
  $pj = Join-Path $root 'company\projects'
  if (Test-Path $pj) {
    foreach ($d in (Get-ChildItem $pj -Directory -ErrorAction SilentlyContinue)) {
      $tf = Join-Path $d.FullName 'tasks.json'
      if (-not (Test-Path $tf)) { continue }
      try { $tasks = Get-Content $tf -Raw | ConvertFrom-Json } catch { continue }
      foreach ($t in @($tasks)) {
        if ($t -and (@('planning', 'coding', 'testing', 'queued', 'starting') -contains $t.status)) { $mid += ("task " + $t.id + " (" + $t.status + ")") }
      }
    }
  }
  # 1c. fleet orders that are still moving
  $of = Join-Path $root 'company\fleet\orders.json'
  if (Test-Path $of) {
    try {
      $orders = Get-Content $of -Raw | ConvertFrom-Json
      foreach ($o in @($orders)) {
        if ($o -and (@('starting', 'working', 'idle', 'reported', 'queued') -contains $o.status)) { $mid += ("order " + $o.id + " (" + $o.status + ")") }
      }
    } catch { }
  }
  if ($mid.Count -gt 0) {
    if (-not $IgnoreInFlight) { Fail ("work is in flight: " + (($mid | Select-Object -First 6) -join '; ') + $(if ($mid.Count -gt 6) { " (+$($mid.Count - 6) more)" } else { "" })) }
    Say ("  WARNING -IgnoreInFlight: " + $mid.Count + " item(s) in flight: " + (($mid | Select-Object -First 6) -join '; ')) 'Yellow'
  } else { Say "  in flight: none (tasks + fleet orders are all terminal)" 'Green' }

  # 1d. the current PROD must be healthy and not lagging, or the swap has no healthy state to return to
  $h = Test-HealthJson $ProdPort 15
  if (-not $h) { Say "  WARNING: no /health on the current prod :$ProdPort (the swap will be the first bring-up)" 'Yellow' }
  elseif (-not $h.ok) { Fail "current prod :$ProdPort /health is not ok" }
  else {
    $p95 = 0
    if ($h.PSObject.Properties.Name -contains 'lagP95Ms') { $p95 = [int]$h.lagP95Ms }
    if ($p95 -gt $LagLimitMs) { Fail ("current prod :$ProdPort lagP95Ms=$p95 > LagLimitMs=$LagLimitMs - fix the stall first, promoting onto a lagging router hides it") }
    Say ("  prod health ok, lagMs=$($h.lagMs) lagP95Ms=$p95 (limit $LagLimitMs)") 'Green'
  }
} else { Say "  preflight SKIPPED (-SkipPreflight)" 'Yellow' }

function Release-Xd([string]$dir, [string]$dstDir = '') {
  # The three directories a release must never traverse or mirror: the junctions (so a copy cannot walk
  # into node_modules) and the live data/log dirs. ABSOLUTE paths on purpose - a bare `/XD company` also
  # excludes `src\company\`, which silently produced a release that crashed at boot with
  # `ERR_MODULE_NOT_FOUND release/src/company/brainRouter.js`. When $dstDir is given, the destination-
  # side junction paths are excluded too (belt and braces; the measured copy-into hazard is what this
  # covers).
  $xd = @('/XD', (Join-Path $dir 'node_modules'), '/XD', (Join-Path $dir 'company'), '/XD', (Join-Path $dir 'logs'))
  if ($dstDir) { $xd += @('/XD', (Join-Path $dstDir 'node_modules'), '/XD', (Join-Path $dstDir 'company'), '/XD', (Join-Path $dstDir 'logs')) }
  return $xd
}

# --------------------------------------------------- 2. snapshot the release -
if (Test-Path $release) {
  Say "snapshotting the current release -> release-prev (rollback copy)"
  Assert-SafeTarget $release "snapshot source (release\)"
  Assert-SafeTarget $prev    "snapshot destination (release-prev\)"
  # /E + /XJ, NOT /MIR: a mirror's delete pass walks the destination and (measured on the sandbox)
  # follows a junction even with /XJ, which is how it deleted live data. /E never deletes; the clean
  # start comes from Remove-SafeTree, which refuses to enter a reparse point.
  if (-not (Remove-SafeTree $prev)) { Fail "could not clear release-prev\ safely (it is or contains a junction/symlink) - refusing to snapshot on top of it" }
  & robocopy.exe $release $prev /E /XJ /NFL /NDL /NJH /NJS /NP @(Release-Xd $release $prev) | Out-Null
  $rc = $LASTEXITCODE
  if ($rc -ge 8) { Fail "robocopy snapshot failed (exit $rc)" }
  Say "  snapshot done (robocopy exit $rc, /E + /XJ: overwrite+add only, no deletes)"
} else { Say "no release\ yet - this is the first promote (no rollback copy needed)" 'Yellow' }

# ------------------------------------------------------ 3. build the staging -
Say "building release-staging from the working tree (excluding $($PayloadXabs -join ', ') + $($PayloadXnames -join ', '))"
Assert-SafeTarget $staging "staging build destination (release-staging\)"
# safe clear: Remove-SafeTree never descends a reparse point; the junctions a previous build left in
# release-staging are removed as LINKS (their targets - the live dirs - are untouched), so a second
# promote works. (A plain Remove-Item on a junction prompts, which would hang an unattended run.)
if (-not (Remove-SafeTree $staging)) { Fail "could not clear release-staging\ safely (it is or contains a junction/symlink)" }
$xd = @(); foreach ($d in $PayloadXabs) { $xd += @('/XD', (Join-Path $root $d)) }; foreach ($d in $PayloadXnames) { $xd += @('/XD', $d) }
# /E + /XJ, not /MIR (see step 2). The source-side /XD list is what keeps this from copying a real
# company\/logs\ dir into a junction; /E guarantees this pass deletes nothing anywhere.
& robocopy.exe $root $staging /E /XJ /NFL /NDL /NJH /NJS /NP /XF '.env' @xd | Out-Null
$rc = $LASTEXITCODE
if ($rc -ge 8) { Fail "robocopy build failed (exit $rc)" }
Say "  staged (robocopy exit $rc, /E + /XJ: overwrite+add only, no deletes)"

# The release must carry the same source tree as the working tree (minus the exclusions above). A
# source-file count mismatch has already bitten this script once; check it before publishing.
$srcWork = (Get-ChildItem (Join-Path $root 'src') -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count
$srcRel = (Get-ChildItem (Join-Path $staging 'src') -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count
Say "  src files: working=$srcWork staged=$srcRel"
if ($srcRel -ne $srcWork) { Fail "the staged src has $srcRel files but the working tree has $srcWork - an exclusion is eating source files" }

# Size guard: a release is src + assets (a few MB to tens of MB). Anything near a gigabyte means an
# exclusion broke and a venv/node_modules tree got staged - fail loudly instead of publishing it.
$staged = Get-ChildItem $staging -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum
$stagedMB = [math]::Round($staged.Sum / 1MB, 1)
Say ("  staging: " + $staged.Count + " file(s), " + $stagedMB + " MB")
if ($stagedMB -gt 400 -or $staged.Count -gt 20000) { Fail ("staging looks wrong (" + $stagedMB + " MB / " + $staged.Count + " files) - check the /XD exclusions before promoting") }

# The release's config, and the links that keep PROD's data and logs where they are.
$envSrc = Join-Path $root '.env'
if (Test-Path $envSrc) { Copy-Item $envSrc (Join-Path $staging '.env') -Force; Say "  config: .env copied into the release" } else { Say "  WARNING: no .env to copy" }
foreach ($link in @(@('company', (Join-Path $root 'company')), @('logs', (Join-Path $root 'logs')), @('node_modules', (Join-Path $root 'node_modules')))) {
  $lp = Join-Path $staging $link[0]
  if (Test-Path $lp) { continue }
  & cmd.exe /c "mklink /J `"$lp`" `"$($link[1])`"" | Out-Null
  if (Test-Path $lp) { Say ("  link: " + $link[0] + " -> " + $link[1]) } else { Fail ("could not create the " + $link[0] + " junction") }
}
$files = $staged.Count
Say "  staging has $files file(s)"

# ---------------------------------------------------------------- 4. smoke ---
if (-not $SmokePort) { $SmokePort = 8899 }
if (-not (Test-PortFree $SmokePort)) { Fail "smoke port $SmokePort is in use" }
$smokeCompany = Join-Path $env:TEMP ("promote-smoke-" + (Get-Random))
New-Item -ItemType Directory -Force -Path $smokeCompany | Out-Null
$smokeOut = Join-Path $root 'logs\promote-smoke.out.log'
$smokeErr = Join-Path $root 'logs\promote-smoke.err.log'
Say "smoking the staged release on :$SmokePort with a TEMP company root ($smokeCompany)"
$tsx = Join-Path $root 'node_modules\.bin\tsx.cmd'
$smokeInner = "cd /d `"$staging`" && set `"PORT=$SmokePort`" && set `"HOST=127.0.0.1`" && set `"COMPANY_ROOT=$smokeCompany`" && " +
              "set `"SLACK_BRIDGE=0`" && set `"SLACK_SOCKET_MODE=0`" && set `"SLACK_BOT_TOKEN=`" && set `"SLACK_APP_TOKEN=`" && set `"SLACK_CHANNEL_ID=`" && " +
              "`"$tsx`" src/server.ts 1>> `"$smokeOut`" 2>> `"$smokeErr`""
$smokeChild = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $smokeInner -WindowStyle Hidden -PassThru
$ok = $false
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
  $sh = Test-HealthJson $SmokePort 5
  if ($sh -and $sh.ok) { $ok = $true; break }
  if ($smokeChild.HasExited) { break }
  Start-Sleep -Seconds 2
}
$smokeResults = @()
if ($ok) {
  foreach ($p in @('/health', '/v2/', '/v2/app.js', '/company/flow')) {
    $code = & curl.exe -s -m 30 -o NUL -w '%{http_code}' "http://127.0.0.1:$SmokePort$p"
    $smokeResults += "$p=$code"
  }
  $bad = @($smokeResults | Where-Object { $_ -notmatch '=200$' })
  Say ("  smoke: " + ($smokeResults -join ' ')) $(if ($bad.Count -eq 0) { 'Green' } else { 'Red' })
  if ($bad.Count -gt 0) { $ok = $false }
} else {
  Say "  smoke: the staged release did NOT answer /health within ${TimeoutSec}s" 'Red'
  Get-Content $smokeOut -Tail 6 -ErrorAction SilentlyContinue | ForEach-Object { Say ("    out: " + $_) }
  Get-Content $smokeErr -Tail 6 -ErrorAction SilentlyContinue | ForEach-Object { Say ("    err: " + $_) }
}
if (-not $smokeChild.HasExited) { & taskkill.exe /PID $smokeChild.Id /T /F 2>&1 | Out-Null }
[void](Remove-SafeTree $smokeCompany)   # temp dir we made; refuses if it somehow became a reparse point
if (-not $ok) {
  Say "SMOKE FAILED - the release staging is left at $staging for inspection, prod was NOT touched." 'Red'
  exit 1
}
Say "  smoke PASSED" 'Green'

if ($SmokeOnly) { Say "SMOKEONLY: stopping here (prod untouched). Staging left at $staging."; exit 0 }
if ($DryRun) { Say "DRYRUN: build + smoke done; prod untouched. Staging left at $staging."; exit 0 }

# ------------------------------------------------------- 5. publish release --
Say "publishing the staged release into release\"
Assert-SafeTarget $staging "publish source (release-staging\)"
Assert-SafeTarget $release "publish destination (release\)"
# /E, NOT /MIR: a mirror would DELETE release\node_modules, release\company and release\logs (they are not
# in the staging tree), and re-creating those junctions afterwards is not something to rely on - the first
# attempt left release\node_modules missing, so a release-based supervisor fell back to `npx tsx` and
# blocked on an interactive "Ok to proceed?" prompt with no error in any log. /E overwrites and adds,
# never deletes, so the junctions survive by construction. /XJ is belt-and-braces: MEASURED it excludes
# junction points on the SOURCE side (so the staging junctions are skipped even without /XD), but it does
# NOT protect a destination junction - /E still wrote through one, and /MIR still deleted through one,
# with /XJ set. The source-side /XD (Release-Xd $staging $release) is what keeps the copy out of the
# release junctions.
& robocopy.exe $staging $release /E /XJ /NFL /NDL /NJH /NJS /NP @(Release-Xd $staging $release) | Out-Null
$rc = $LASTEXITCODE
if ($rc -ge 8) { Fail "robocopy publish failed (exit $rc)" }
foreach ($link in @(@('company', (Join-Path $root 'company')), @('logs', (Join-Path $root 'logs')), @('node_modules', (Join-Path $root 'node_modules')))) {
  $lp = Join-Path $release $link[0]
  if (-not (Test-Path $lp)) { & cmd.exe /c "mklink /J `"$lp`" `"$($link[1])`"" | Out-Null }
  if (-not (Test-Path $lp)) { Fail ("release\" + $link[0] + " is missing after publishing - a release without it cannot boot (see the /E comment above)") }
}
# A release that cannot find the local tsx CLI boots into an interactive npx prompt instead of failing.
$relTsx = Join-Path $release 'node_modules\.bin\tsx.cmd'
if (-not (Test-Path $relTsx)) { Fail "release\node_modules\.bin\tsx.cmd is not reachable - do not swap prod onto a release that would fall back to npx" }
Say "  junctions + release tsx verified"
$manifest = [pscustomobject]@{
  promotedAt = (Get-Date).ToString('s')
  promotedBy = "$env:USERDOMAIN\$env:USERNAME"
  sourceTree = $root
  files      = (Get-ChildItem $release -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count
  smoke      = ($smokeResults -join ' ')
  port       = $Port
  task       = $TaskName
}
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $release 'RELEASE.json') -Encoding utf8
Say ("  release\ published (" + $manifest.files + " files); manifest at release\RELEASE.json")

# Final check on the PUBLISHED tree, not just the staging: the publish/snapshot robocopy calls have their
# own exclusion lists, and getting them wrong is exactly how a release shipped without src\company.
$srcRel2 = (Get-ChildItem (Join-Path $release 'src') -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count
$srcWork2 = (Get-ChildItem (Join-Path $root 'src') -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count
Say "  published src files: $srcRel2 (working tree $srcWork2)"
if ($srcRel2 -ne $srcWork2) { Fail "the PUBLISHED release has $srcRel2 source files but the working tree has $srcWork2 - do not swap prod onto it" }

# ------------------------------------------------------------ 6. swap prod ---
$supRel = Join-Path $release 'ops\router-supervisor.ps1'
if ($ForceSwapFail) {
  $supRel = Join-Path $release 'ops\this-does-not-exist-on-purpose.ps1'
  Say "  -ForceSwapFail: the release task will be pointed at a missing script on purpose" 'Yellow'
}
if (-not (Test-Path $supRel)) {
  if (-not $ForceSwapFail) { Fail "release\ops\router-supervisor.ps1 is missing - cannot hand prod to the release" }
  else { Say "  (expected: that path is missing, this is the failure injection)" 'Yellow' }
}

function Set-ProdTask([string]$task, [string]$supervisorPath, [int]$port) {
  $user = "$env:USERDOMAIN\$env:USERNAME"
  $xmlPath = Join-Path $env:TEMP "$task.xml"
  # A hashtable CANNOT be passed through a scheduled task's action: with `-File`, PowerShell splits the
  # argument list on spaces, so `-ChildEnv @{ COMPANY_ROOT = 'x'; SLACK_BRIDGE = '0' }` arrives in
  # pieces, parameter binding fails and the task exits 1 without ever starting a router (that is exactly
  # what the first :8899 rehearsal did). When a rehearsal needs a different COMPANY_ROOT, point the task
  # at a one-line wrapper script instead, which is plain and quoting-safe.
  if ($SwapCompanyRoot) {
    New-Item -ItemType Directory -Force -Path $SwapCompanyRoot | Out-Null
    $wrapper = Join-Path $env:TEMP "promote-swap-$port.ps1"
    $logPrefix = if ($port -eq 8787) { 'router' } else { "router-$port" }
    $body = @(
      "# written by scripts/promote.ps1 for the :$port swap (-SwapCompanyRoot)",
      "& `"$supervisorPath`" -Port $port -LogPrefix $logPrefix -ChildEnv @{ COMPANY_ROOT = '$SwapCompanyRoot'; SLACK_BRIDGE = '0'; SLACK_SOCKET_MODE = '0' }"
    )
    Set-Content -LiteralPath $wrapper -Value $body -Encoding utf8
    $args = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$wrapper`""
  } else {
    $args = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$supervisorPath`""
    if ($port -ne 8787) { $args += " -Port $port -LogPrefix router-$port" }
  }
  $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>PROD router for the Laya AI Company (127.0.0.1:$port), served from the frozen release. Re-pointed by scripts/promote.ps1. See docs/AGENT_COORDINATION.md.</Description><URI>\$task</URI></RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>$user</UserId></LogonTrigger>
    <TimeTrigger><StartBoundary>$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')</StartBoundary><Enabled>true</Enabled>
      <Repetition><Interval>PT2M</Interval><Duration>P365D</Duration><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>$user</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled><Hidden>false</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>7</Priority>
  </Settings>
  <Actions Context="Author"><Exec><Command>powershell.exe</Command><Arguments>$args</Arguments></Exec></Actions>
</Task>
"@
  Set-Content -LiteralPath $xmlPath -Value $xml -Encoding Unicode
  $out = & schtasks.exe /create /tn $task /xml $xmlPath /f 2>&1
  Say ("  task '$task' -> $supervisorPath (schtasks: " + (($out | Out-String).Trim()) + ")")
  return $LASTEXITCODE
}

$oldPid = Get-ListenerPid $Port
Say "swapping prod on :$Port (old listener pid $(if ($oldPid) { $oldPid } else { 'none' }))"
if (Set-ProdTask $TaskName $supRel $Port -ne 0) { Fail "could not write the scheduled task" }
# stop whatever serves the port now, then let the task's supervisor own it from the release
& schtasks.exe /end /tn $TaskName 2>&1 | Out-Null
if ($oldPid -gt 0) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'ops\router-supervisor.ps1') -Stop -Port $Port 2>&1 | Out-Null
  if ((Get-ListenerPid $Port) -gt 0) { & taskkill.exe /PID (Get-ListenerPid $Port) /T /F 2>&1 | Out-Null }
}
& schtasks.exe /run /tn $TaskName 2>&1 | Out-Null

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$up = $false
while ((Get-Date) -lt $deadline) {
  $h2 = Test-HealthJson $Port 5
  if ($h2 -and $h2.ok) { $up = $true; break }
  Start-Sleep -Seconds 3
}
$newPid = Get-ListenerPid $Port
if ($up) {
  $after = @()
  foreach ($p in @('/health', '/v2/', '/company/flow')) {
    $code = & curl.exe -s -m 30 -o NUL -w '%{http_code}' "http://127.0.0.1:$Port$p"
    $after += "$p=$code"
  }
  $h3 = Test-HealthJson $Port 10
  Say ("SWAPPED: prod :$Port now serves release\ (pid $newPid)" + "  " + ($after -join ' ') + "  lagMs=" + $h3.lagMs + " lagP95Ms=" + $h3.lagP95Ms) 'Green'
  Say "promote.ps1 done"
  exit 0
}

# ------------------------------------------------------------ 7. rollback ----
Say "the release did NOT come up on :$Port - ROLLING BACK" 'Red'
if (Test-Path $prev) {
  Assert-SafeTarget $prev    "rollback source (release-prev\)"
  Assert-SafeTarget $release "rollback destination (release\)"
  # WAS /MIR - the worst offender: its delete pass walks release\ and (measured) follows
  # release\company / release\logs / release\node_modules into the LIVE dirs even with /XJ. Now:
  # /E (overwrite+add, never delete) + /XJ, then an explicit prune that REFUSES to enter or touch any
  # reparse point - so a restore can never delete live data again.
  & robocopy.exe $prev $release /E /XJ /NFL /NDL /NJH /NJS /NP @(Release-Xd $prev $release) | Out-Null
  $rcrb = $LASTEXITCODE
  if ($rcrb -ge 8) { Say "  WARNING: robocopy restore exited $rcrb" 'Red' }
  Remove-StaleFromMirror $prev $release
  Say "  release\ restored from release-prev (/E + /XJ + reparse-safe prune; live data untouched)"
}
if (Set-ProdTask $TaskName (Join-Path $root 'ops\router-supervisor.ps1') $Port -ne 0) { Say "  could not re-point the task at the working-tree supervisor" 'Red' }
& schtasks.exe /run /tn $TaskName 2>&1 | Out-Null
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
  $h4 = Test-HealthJson $Port 5
  if ($h4 -and $h4.ok) { Say ("ROLLED BACK: :$Port is healthy again (pid " + (Get-ListenerPid $Port) + ")") 'Yellow'; exit 1 }
  Start-Sleep -Seconds 3
}
Say "ROLLBACK FAILED: :$Port is still down - needs a human (manager/CRASHFIX)" 'Red'
exit 2
