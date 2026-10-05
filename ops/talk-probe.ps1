# ops/talk-probe.ps1 — targeted live delivery probe (order TALK-A, step 2).
#
# Gives a session id and a text, sends it with the ONE targeted method the fleet
# already uses for a worker's first brief:
#
#     jcode transcript --mode send -S <sessionId>      (text on stdin, UTF-8)
#
# then polls that session's own state, READ ONLY, for up to -TimeoutSeconds
# (default 20) until the text shows up as a USER message
# (`role=user`, text content containing the text):
#
#   * %USERPROFILE%\.jcode\sessions\<sessionId>.json            the session snapshot
#       — where `jcode transcript -S` really records the injected input, e.g.
#         role=user content[type=text] "[transcription] <the text>"   (measured)
#   * %USERPROFILE%\.jcode\sessions\<sessionId>.journal.jsonl   the session journal
#       — the file this order names. Measured on this install it records the
#         ASSISTANT reply and (only for the FIRST injection) meta.title =
#         "[transcription] <the text>"; it did NOT contain a role=user text
#         message for the injected input. So the snapshot is the proof, and the
#         journal is polled too and reported honestly.
#
# Prints exactly `delivered in N s` or `NOT delivered`, plus the method used,
# the jcode exit code/stdout/stderr, and the evidence (file + the stored text).
#
# Hard rules (order TALK-A):
#   * refuses an empty session id (exit 2) and refuses empty text (exit 2);
#   * NEVER falls back to the focus-based method (`jcode transcript --mode send`
#     without -S, which needs %USERPROFILE%\.jcode\last_focused_client_session).
#     There is exactly one send in this script and it always carries -S.
#   * writes nothing into %USERPROFILE%\.jcode.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File ops/talk-probe.ps1 -SessionId session_x_1_ab -Text "Reply with the single word ok."
#   ... -TimeoutSeconds 20 -Needle "distinctive-part"
#
# Exit codes: 0 delivered, 1 not delivered, 2 refused.

[CmdletBinding()]
param(
    [Parameter(Position = 0)][string]$SessionId = "",
    [Parameter(Position = 1)][string]$Text = "",
    [int]$TimeoutSeconds = 20,
    [string]$Needle = "",
    [string]$JcodeExe = "",
    [int]$PollMs = 500
)

$ErrorActionPreference = "Stop"

function Fail([string]$why, [int]$code) {
    Write-Output ("REFUSE: " + $why)
    exit $code
}

if ($SessionId -eq $null) { $SessionId = "" }
if ($Text -eq $null) { $Text = "" }
$SessionId = $SessionId.Trim()
if ($SessionId -eq "") { Fail "empty session id (a targeted send needs a session id; refusing)" 2 }
if ($Text.Trim() -eq "") { Fail "empty text" 2 }
if ($JcodeExe -eq "") {
    if ($env:JCODE_BIN) { $JcodeExe = $env:JCODE_BIN } else { $JcodeExe = "jcode" }
}

$sessions = Join-Path $env:USERPROFILE ".jcode\sessions"
$journal = Join-Path $sessions ($SessionId + ".journal.jsonl")
$snapshot = Join-Path $sessions ($SessionId + ".json")

# ── the needle: the distinctive bit of the text we look for again ──────────────
# First line: a newline inside the text is stored escaped, so a normalized
# whole-text needle would never match. Long text: a 48-char window from a fifth of
# the way in, exactly like src/company/terminalChat.ts, so an echo of the text by
# the agent cannot be mistaken for the delivery.
$oneLine = ($Text -replace "[`r`n]+", " ").Trim()
$firstLine = (($Text -split "[`r`n]")[0]).Trim()
if ($Needle -eq "") {
    if ($firstLine.Length -ge 6) { $Needle = $firstLine }
    else { $Needle = $oneLine }
}
if ($Needle.Length -gt 48) {
    $start = [Math]::Min($Needle.Length - 48, [Math]::Max(0, [int][Math]::Floor($Needle.Length * 0.2)))
    $Needle = $Needle.Substring($start, 48).Trim()
}

# ── readers (READ ONLY) ───────────────────────────────────────────────────────
function Get-Text([string]$file) {
    try { if (Test-Path -LiteralPath $file) { return [System.IO.File]::ReadAllText($file) } } catch { }
    return ""
}

# User messages whose text contains the needle, from the snapshot's `messages`.
function Get-SnapshotUserHits([string]$snapText) {
    $out = @()
    if ($snapText -eq "") { return $out }
    $o = $null
    try { $o = $snapText | ConvertFrom-Json } catch { return $out }
    if ($o -eq $null -or $o.messages -eq $null) { return $out }
    foreach ($m in @($o.messages)) {
        if ([string]$m.role -ne "user") { continue }
        foreach ($c in @($m.content)) {
            if ($c.text -ne $null -and ([string]$c.text).IndexOf($Needle) -ge 0) { $out += ([string]$c.text); break }
        }
    }
    return $out
}

# User messages in the journal's append_messages that contain the needle.
function Test-JournalUserMessage([string]$journalText) {
    foreach ($line in ($journalText -split "`n")) {
        if ($line -eq "" -or $line.IndexOf($Needle) -lt 0) { continue }
        $o = $null
        try { $o = $line | ConvertFrom-Json } catch { continue }
        if ($o -eq $null -or $o.append_messages -eq $null) { continue }
        foreach ($m in @($o.append_messages)) {
            if ([string]$m.role -ne "user") { continue }
            foreach ($c in @($m.content)) {
                if ($c.text -ne $null -and ([string]$c.text).IndexOf($Needle) -ge 0) { return $true }
            }
        }
    }
    return $false
}

# The weak journal marker this install actually writes for the FIRST injection.
function Test-JournalTitle([string]$journalText) {
    foreach ($line in ($journalText -split "`n")) {
        if ($line -eq "" -or $line.IndexOf($Needle) -lt 0) { continue }
        $o = $null
        try { $o = $line | ConvertFrom-Json } catch { continue }
        if ($o -ne $null -and $o.meta -ne $null -and [string]$o.meta.title -like ("*" + $Needle + "*")) { return $true }
    }
    return $false
}

function Count-Occurrences([string]$hay, [string]$what) {
    if ($hay -eq "" -or $what -eq "") { return 0 }
    $n = 0
    $i = $hay.IndexOf($what)
    while ($i -ge 0) { $n++; $i = $hay.IndexOf($what, $i + $what.Length) }
    return $n
}

$beforeSnap = @(Get-SnapshotUserHits (Get-Text $snapshot)).Count
$beforeJournalText = Get-Text $journal
$beforeJournalUser = Test-JournalUserMessage $beforeJournalText
$beforeTitle = Test-JournalTitle $beforeJournalText
$beforeRaw = Count-Occurrences $beforeJournalText $Needle

Write-Output ("session : " + $SessionId)
Write-Output ("text    : " + ($oneLine.Substring(0, [Math]::Min(120, $oneLine.Length))))
Write-Output ("needle  : " + $Needle)
Write-Output ("method  : jcode transcript --mode send -S " + $SessionId + " (targeted; stdin UTF-8)")
Write-Output ("watch   : " + $journal)
Write-Output ("          " + $snapshot)
Write-Output ("baseline: snapshotUserMsgs=" + $beforeSnap + " journalUserMsg=" + $beforeJournalUser + " journalTitle=" + $beforeTitle + " journalRaw=" + $beforeRaw)
if (-not (Test-Path -LiteralPath $journal)) { Write-Output "note    : no journal yet (a session writes one on its first turn); still polling" }

# ── the single send (targeted only, never focus-based) ────────────────────────
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $JcodeExe
$psi.Arguments = "transcript --mode send -S " + $SessionId + " --no-update --quiet"
$psi.WorkingDirectory = (Get-Location).Path
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
$psi.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false)
try { $psi.StandardInputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $psi
[void]$proc.Start()
$proc.StandardInput.Write($Text)
$proc.StandardInput.Close()
$stdout = $proc.StandardOutput.ReadToEnd()
$stderr = $proc.StandardError.ReadToEnd()
$proc.WaitForExit()
$sw.Stop()
$exit = $proc.ExitCode
$sendMs = [int]$sw.ElapsedMilliseconds

$outTrim = $stdout.Trim()
$errTrim = $stderr.Trim()
if ($outTrim.Length -gt 300) { $outTrim = $outTrim.Substring(0, 300) + "..." }
if ($errTrim.Length -gt 300) { $errTrim = $errTrim.Substring(0, 300) + "..." }
Write-Output ("send    : exit=" + $exit + " in " + $sendMs + "ms" + $(if ($outTrim -ne "") { " stdout=" + $outTrim } else { "" }) + $(if ($errTrim -ne "") { " stderr=" + $errTrim } else { "" }))

# ── poll both session files for the text as a user message ────────────────────
$sentAt = Get-Date
$deadline = $sentAt.AddSeconds($TimeoutSeconds)
$delivered = $false
$evidence = ""
$storedText = ""
$titleSeen = $false
$rawSeen = $false
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds $PollMs
    $jt = Get-Text $journal
    $st = Get-Text $snapshot
    if ((Count-Occurrences $jt $Needle) -gt $beforeRaw) { $rawSeen = $true }
    if (-not $beforeTitle -and (Test-JournalTitle $jt)) { $titleSeen = $true }

    $hits = @(Get-SnapshotUserHits $st)
    if ($hits.Count -gt $beforeSnap) {
        $delivered = $true
        $storedText = $hits[$hits.Count - 1]
        $evidence = "new role=user text message in the SNAPSHOT (" + $snapshot + ")"
        break
    }
    if (-not $beforeJournalUser -and (Test-JournalUserMessage $jt)) {
        $delivered = $true
        $evidence = "new role=user text message in the JOURNAL (" + $journal + ")"
        break
    }
}
$seconds = [Math]::Round(((Get-Date) - $sentAt).TotalSeconds, 1)

if ($delivered) {
    Write-Output ("delivered in " + $seconds + " s")
    Write-Output ("evidence: " + $evidence + " (jcode exit " + $exit + ")")
    if ($storedText -ne "") {
        $shown = $storedText -replace "[`r`n]+", " \n "
        if ($shown.Length -gt 200) { $shown = $shown.Substring(0, 200) + "..." }
        Write-Output ("stored  : " + $shown)
    }
    if ($titleSeen) { Write-Output "note    : journal meta.title also carries it (weak marker: only the first injected text becomes the title)" }
    exit 0
}

Write-Output ("NOT delivered")
$why = "no role=user text message containing the needle appeared in the snapshot or the journal within " + $TimeoutSeconds + "s"
Write-Output ("detail  : " + $why + " (jcode exit " + $exit + "; journal raw needle seen: " + $rawSeen + "; journal meta.title seen: " + $titleSeen + ")")
if ($exit -ne 0) { Write-Output ("send error: jcode exited " + $exit + " - " + $errTrim) }
exit 1
