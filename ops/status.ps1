# status.ps1 - THE source for every progress report. Facts only, from disk and live endpoints. Never report from memory.
$root = Split-Path -Parent $PSScriptRoot; Set-Location $root
function AgeMin($s) { try { $d = [datetime]::Parse([string]$s, $null, [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime(); return [int](((Get-Date).ToUniversalTime() - $d).TotalMinutes) } catch { return -1 } }
"STATUS at " + (Get-Date -Format "HH:mm")

# infrastructure
$inf = @()
try { Invoke-RestMethod http://localhost:8787/health -TimeoutSec 8 | Out-Null; $inf += "router OK" } catch { $inf += "router DOWN" }
try { Invoke-RestMethod http://127.0.0.1:8000/health -TimeoutSec 8 | Out-Null; $inf += "laya OK" } catch { $inf += "laya DOWN" }
foreach ($n in 'order-queue', 'accept-loop', 'keep-awake', 'worker-guard') { $inf += ($n + $(if (@(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -match $n }).Count -gt 0) { " OK" } else { " DOWN" })) }
"INFRA: " + ($inf -join " | ")
"visible terminal windows: " + @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -match 'powershell|pwsh|cmd|WindowsTerminal|conhost|OpenConsole|opencode|jcode' }).Count

# source health
$o = & "$root\node_modules\.bin\tsc.cmd" --noEmit 2>&1; "typecheck errors (src): " + @($o | Where-Object { $_ -match 'error TS' }).Count

# acceptance (independent ground truth)
$pass = @(); $fail = @()
foreach ($f in (Get-ChildItem "$root\logs\acceptance" -Filter "*.json" -ErrorAction SilentlyContinue)) { try { $r = Get-Content $f.FullName -Raw | ConvertFrom-Json; if ($r.passed) { $pass += $r.id } else { $fail += ($r.id + "(" + $r.passLines + " pass/" + $r.failLines + " fail)") } } catch {} }
"ACCEPTED by our own check run (" + $pass.Count + "): " + ($pass -join ", ")
"CHECK FAILING (" + $fail.Count + "): " + ($fail -join ", ")

# queue
$sf = "$root\logs\order-queue-state.json"
if (Test-Path $sf) { $s = Get-Content $sf -Raw | ConvertFrom-Json; $c = @{}; foreach ($p in $s.orders.PSObject.Properties) { $c[$p.Value] = 1 + [int]$c[$p.Value] }; "QUEUE (state " + (AgeMin $s.updatedAt) + " min old): done=" + [int]$c['done'] + " active=" + [int]$c['active'] + " waiting=" + [int]$c['need'] + " gave-up=" + [int]$c['exhausted'] + " paused=" + $s.paused; "gave up: " + ((@($s.orders.PSObject.Properties | Where-Object { $_.Value -eq 'exhausted' } | ForEach-Object { $_.Name })) -join ", ") } else { "QUEUE: no state file" }

# tasks and workers
try {
  $t = @(Invoke-RestMethod http://localhost:8787/company/projects/pmuwxx58q/tasks -TimeoutSec 20 | ForEach-Object { $_ })
  "working: " + ((@($t | Where-Object { $_.status -notin 'merged', 'failed' } | ForEach-Object { $m = [regex]::Match([string]$_.rawRequest, '^# Order ([^\s:]+)'); $m.Groups[1].Value + "=" + $_.status + "(" + (AgeMin $_.updatedAt) + "m)" })) -join "  ")
  "last 30 min:"; foreach ($x in $t) { if ($x.status -in 'merged', 'failed') { $a = AgeMin $x.updatedAt; if ($a -ge 0 -and $a -le 30) { $m = [regex]::Match([string]$x.rawRequest, '^# Order ([^\s:]+)'); $e = ([string]$x.error -replace '\s+', ' '); if ($e.Length -gt 70) { $e = $e.Substring(0, 70) }; "  {0,3} min ago {1,-26} {2,-7} {3}" -f $a, $m.Groups[1].Value, $x.status, $e } } }
} catch { "tasks: router not answering" }
"workers (headless): " + ((@(Get-CimInstance Win32_Process -Filter "Name='opencode.exe'" | ForEach-Object { $m = [regex]::Match([string]$_.CommandLine, 'Order ([A-Za-z0-9-]+)'); $m.Groups[1].Value })) -join ", ")

# money and machine
try { $pn = Invoke-RestMethod "http://localhost:8787/company/panel?lite=1" -TimeoutSec 40; $b = $pn.realBudget.providers.PSObject.Properties | Where-Object { $_.Value.id -eq 'deepseek-direct' }; "MONEY: deepseek balance $" + $b.Value.balanceUsd + " | opencode " + (($pn.realBudget.providers.go.windows | ForEach-Object { $_.window + "=" + $_.remainingPct + "%" }) -join " ") } catch { "MONEY: panel not answering" }
$cm = Get-Content "$root\logs\order-queue.log" -ErrorAction SilentlyContinue | Where-Object { $_ -match 'credit mode' } | Select-Object -Last 1; if ($cm) { "credit: " + $cm.Substring(0, [Math]::Min(120, $cm.Length)) }
"free RAM GB: " + [math]::Round(((Get-Counter '\Memory\Available MBytes').CounterSamples[0].CookedValue / 1024), 1)
"first dossier files: " + (@(Get-ChildItem "$root\products\leadscout\data\first-run" -Filter *.md -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }) -join ", ")
