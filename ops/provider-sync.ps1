# provider-sync.ps1 - make opencode workers use the provider the routing policy chooses.
# ROOT CAUSE it fixes (2026-10-08): src/company/workers.ts always spawns `opencode run --model opencode-go/<id>`.
# With the OpenCode Go quota at 0% every worker died instantly with "Go usage limit exceeded" (no file written,
# the progress guard killed it 20 min later), while the routing policy already said "use DeepSeek credits".
# This script reads GET /company/routing/policy and, while it says deepseek, writes a project-level opencode.json
# that points the opencode-go model ids at the DeepSeek direct API (api key from env DEEPSEEK_API_KEY, which the
# router passes to its workers; no secret is ever written to a file). When the policy returns to opencode-go the
# file it wrote is removed. Only a file carrying our marker is ever replaced or deleted. No router restart needed:
# every new worker reads the file at start. Called by ops\order-queue.ps1 every loop; safe to run by hand.
param([string]$Root = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
$marker = 'managed by ops/provider-sync.ps1'
$file = Join-Path $Root 'opencode.json'
# MUSE MODE (CEO 2026-10-12): when logs\muse-mode.flag exists (the queue creates it when the DeepSeek balance reaches 0.10 USD) every
# worker model id is pointed at the FREE OpenCode model opencode/muse-spark-1.3-contributor-free (OpenAI-style protocol, apiKey "public").
# This takes precedence over the routing policy and works even when the router is down. Remove the flag to go back to DeepSeek.
$museFlag = Join-Path $Root 'logs\muse-mode.flag'
if (Test-Path $museFlag) {
  $ours = $false
  if (Test-Path $file) { try { $ours = ([System.IO.File]::ReadAllText($file)).Contains($marker) } catch {} }
  if ((Test-Path $file -PathType Leaf) -and -not $ours) { Write-Output "an opencode.json that is not ours exists; not touching it"; exit 0 }
  # ALL FREE MODELS TOGETHER (CEO 2026-10-14): each worker role id gets the best free model that is not resting. glm-* ids (enhancer,
  # summarizer, coder 2) favour the strict short-output models; deepseek-* ids (coder 1, tester, planner) favour Muse and step-5. Four ids
  # map to four different models, so the load is spread over several rate limit buckets. Muse speaks the Responses protocol (a per-model
  # override inside the same provider); the others use chat completions. All four were proven with a real tool test (file created).
  $profiles = [ordered]@{
    # (space-bunny is NOT here: the opencode client drops it as an alias, so it can only serve the router steps; cat-jam and
    # nemotron-ultra passed the real tool test as aliases on 2026-10-14)
    'glm-5.3-flash'       = @('longcat-2.5-preview-free','mimo-v2.6-flash-free','step-5-preview-free','muse-spark-1.3-contributor-free','nemotron-3-ultra-free','cat-jam-free')
    'deepseek-v4-flash'   = @('muse-spark-1.3-contributor-free','step-5-preview-free','nemotron-3-ultra-free','longcat-2.5-preview-free','mimo-v2.6-flash-free','cat-jam-free')
    'deepseek-v4.1-flash' = @('step-5-preview-free','mimo-v2.6-flash-free','longcat-2.5-preview-free','muse-spark-1.3-contributor-free','nemotron-3-ultra-free','cat-jam-free')
    'deepseek-flash'      = @('mimo-v2.6-flash-free','longcat-2.5-preview-free','step-5-preview-free','muse-spark-1.3-contributor-free','nemotron-3-ultra-free','cat-jam-free')
  }
  # Resting models: the router writes logs\free-model-cooling.json ({ until: { "opencode/<id>": epochMs } }) when the lane rests a model;
  # ops\muse-probe.ps1 writes logs\free-model-health.json ({ "<id>": { ok, at } }); a model that failed its last probe rests for 60 minutes.
  $resting = @{}
  $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $coolFile = Join-Path $Root 'logs\free-model-cooling.json'
  if (Test-Path $coolFile) { try { $cj = [System.IO.File]::ReadAllText($coolFile) | ConvertFrom-Json; foreach ($p in $cj.until.PSObject.Properties) { if ([double]$p.Value -gt $nowMs) { $resting[($p.Name -replace '^opencode/', '')] = 1 } } } catch {} }
  $healthFile = Join-Path $Root 'logs\free-model-health.json'
  if (Test-Path $healthFile) { try { $hj = [System.IO.File]::ReadAllText($healthFile) | ConvertFrom-Json; foreach ($p in $hj.PSObject.Properties) { if ($p.Value.ok -eq $false -and ($nowMs - [double]$p.Value.at) -lt 3600000) { $resting[$p.Name] = 1 } } } catch {} }
  $mname = "via free models ($marker)"; $mm = [ordered]@{}; $picked = @()
  foreach ($rid in $profiles.Keys) {
    $pick = @($profiles[$rid] | Where-Object { -not $resting.ContainsKey($_) } | Select-Object -First 1)[0]
    if (-not $pick) { $pick = $profiles[$rid][0] }
    $entry = [ordered]@{ id = $pick; name = "$rid $mname" }
    if ($pick -like 'muse-spark*') { $entry['provider'] = [ordered]@{ npm = '@ai-sdk/openai' } }
    $mm[$rid] = $entry; $picked += "$rid=$($pick -replace '-free$','')"
  }
  $mcfg = [ordered]@{ '$schema' = 'https://opencode.ai/config.json'; provider = [ordered]@{ 'opencode-go' = [ordered]@{ npm = '@ai-sdk/openai-compatible'; options = [ordered]@{ baseURL = 'https://opencode.ai/zen/v1'; apiKey = 'public' }; models = $mm } } }
  $mjson = $mcfg | ConvertTo-Json -Depth 6
  if (-not (Test-Path $file) -or ([System.IO.File]::ReadAllText($file)) -ne $mjson) { [System.IO.File]::WriteAllText($file, $mjson, (New-Object System.Text.UTF8Encoding($false))); Write-Output ("FREE MODELS: " + ($picked -join ', ')) } else { Write-Output ("already on free models: " + ($picked -join ', ')) }
  exit 0
}
try { $pol = Invoke-RestMethod 'http://localhost:8787/company/routing/policy' -TimeoutSec 30 } catch { Write-Output "policy unreadable; leaving provider config unchanged"; exit 0 }
$wantDirect = ($pol.sampleStandard.use -eq $true -and [string]$pol.sampleStandard.provider -eq 'deepseek')
$ours = $false
if (Test-Path $file) { try { $ours = ([System.IO.File]::ReadAllText($file)).Contains($marker) } catch {} }
if ($wantDirect) {
  if (Test-Path $file -PathType Leaf) { if (-not $ours) { Write-Output "an opencode.json that is not ours exists; not touching it"; exit 0 } }
  $name = "via DeepSeek credits ($marker)"
  $models = [ordered]@{}
  foreach ($m in 'glm-5.3-flash','deepseek-v4.1-flash','deepseek-v4-flash','deepseek-flash') { $models[$m] = [ordered]@{ id = 'deepseek-flash'; name = "$m $name" } }
  $cfg = [ordered]@{ '$schema' = 'https://opencode.ai/config.json'; provider = [ordered]@{ 'opencode-go' = [ordered]@{ options = [ordered]@{ baseURL = 'https://api.deepseek.com/v1'; apiKey = '{env:DEEPSEEK_API_KEY}' }; models = $models } } }
  $json = $cfg | ConvertTo-Json -Depth 6
  if (-not $ours -or ([System.IO.File]::ReadAllText($file)) -ne $json) { [System.IO.File]::WriteAllText($file, $json, (New-Object System.Text.UTF8Encoding($false))); Write-Output "workers now use DeepSeek credits (policy: $($pol.sampleStandard.why))" } else { Write-Output "already on DeepSeek credits" }
} else {
  # a transient policy answer (quota fetch failed under load) must not flip workers back to the exhausted Go quota:
  # remove the override only when the policy has a KNOWN Go reading with real quota left
  $goHealthy = ($pol.go.known -eq $true -and [double]$pol.go.remainingPct -ge 5)
  if ($ours -and $goHealthy) { Remove-Item $file -Force; Write-Output "OpenCode Go has quota again ($($pol.go.remainingPct)%); removed the DeepSeek override" }
  elseif ($ours) { Write-Output "policy answered OpenCode Go but its quota reading is not known-healthy; keeping the DeepSeek override" }
  else { Write-Output "OpenCode Go in use; nothing to do" }
}
