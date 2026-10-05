$Ops = 'C:\Users\user\Desktop\Default Project\ops'
$d = Join-Path $env:TEMP ('dbg-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $d -Force | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)
$p = Start-Process -FilePath ping.exe -ArgumentList '-n','600','127.0.0.1' -WindowStyle Hidden -PassThru
Start-Sleep -Milliseconds 200
$t = ''
for ($i=0; $i -lt 3; $i++) {
    $t = $t + ([char]0xD83D + [char]0xDCAD + ' Continue' + "`n" + [char]0xD83D + [char]0xDCAD + '  holding' + "`n" + [char]0xD83D + [char]0xDCAD + '  now' + "`n" + "`n")
}
$log = Join-Path $d 'w2.log'
[System.IO.File]::WriteAllText($log, $t + "[Tokens] upload: 100 download: 10 cache_read: 90 cache_write: 0`n", $utf8)
$rec = [ordered]@{ name='w2'; pid=$p.Id; log=$log; startedAt=(Get-Date).ToString('o'); maxMinutes=15.0; maxUsd=0.30; creationTime=$p.StartTime.ToUniversalTime().ToString('o'); testDummy=$true }
[System.IO.File]::AppendAllText((Join-Path $d 'workers.json'), (($rec | ConvertTo-Json -Compress) + "`r`n"), $utf8)
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Ops 'worker-guard.ps1') -Once -TestRoot $d 2>&1 | Out-Null
Write-Output '--- guard log ---'
Get-Content (Join-Path $d 'worker-guard.log') -Encoding UTF8
Write-Output '--- state ---'
Get-Content (Join-Path $d 'worker-guard-state.json') -Encoding UTF8
Write-Output ('alive=' + [bool](Get-Process -Id $p.Id -ErrorAction SilentlyContinue))
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
