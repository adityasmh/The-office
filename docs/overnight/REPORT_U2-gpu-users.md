# REPORT U2-gpu-users: show which programs use the GPU, by name

Order: `docs/overnight/ORDER_U2-gpu-users.md`. Status: DONE, all checks pass.

## What changed

`src/company/layaControl.ts`
- lines 6-7: header note that `layaStatus()` now also names the GPU users.
- lines 49-52: new constants `GPU_USER_MIN_MIB` (20) and `GPU_USER_HEAVY_MIB` (1024).
- lines 286-290: `ProcInput` gains an optional `created` field and `procsFromTable()` passes the
  process creation time through, so equal-size GPU users can be ordered newest-first.
- lines 422-563: the ORDER U2 block.
  - `GpuUser` / `GpuUsersResult` types (429-430).
  - `GPU_COUNTER_ARGS`: fixed PowerShell command
    `Get-Counter '\GPU Process Memory(*)\Dedicated Usage'` piped to
    `ForEach-Object { "$($_.InstanceName) $($_.CookedValue)" }` (one line per sample, bytes).
  - `parseGpuCounter(stdout)` (446): reads `pid_<n>_...` instance rows with the value on the same
    line (space or CSV) or the next line (pretty `Get-Counter` form), sums per pid, drops anything
    at or below 20 MB, never throws.
  - `gpuUserLabel(name, commandLine)` (489): python + `laya` -> "Laya", python + `tts` ->
    "Voice, text to speech", python + `stt` -> "Voice, speech to text", otherwise the process name.
    Only these words are inspected; the command line is never returned.
  - `gpuUsers(exec = runCommand, processes?)` (505): runs the counter through the injectable runner,
    maps each pid to its process name/label/creation time, sorts biggest-first and newest-first on
    ties, and returns `{ users, reason }`. An unavailable counter returns `users: []` plus a short
    reason - never an error and never a throw.
  - `gpuUserLine(user)` (549) and `gpuUsersNotice(device, users)` (560): the panel wording, kept
    pure so the proof can drive them (the browser cannot import this module).
- lines 576-579: `LayaStatus` gains `gpuUsers: GpuUser[]` and `gpuUsersReason: string | null`.
- line 633: `layaStatus()` calls `gpuUsers(exec, list)` (reusing the process table it already has).
- lines 662-663: `layaStatus()` returns `gpuUsers` and `gpuUsersReason`.

`public/v2/views/system.js` (the Laya panel only)
- line 35: comment lists the two new fields.
- lines 134-149: `gpuUserLineText()` / `gpuUsersNoticeText()`, mirroring the server helpers.
- lines 325-333: the panel builds one line per GPU user and the CPU sentence.
- lines 383-385: the lines, the sentence and (only when the list is empty) the reason are drawn
  under the GPU bar. No button that stops another program was added - the panel describes only.

`ops/laya-control-check.ts`
- lines 27-36: header case list for ORDER U2.
- lines 40-45: imports of the new helpers.
- lines 383-492: new PASS/FAIL cases 13, 13b, 14, 15, 16, 17, 18 (parsing both counter forms and
  the 20 MB cut, label mapping, no command line in the result, unavailable counter, sorting,
  the CPU sentence and the per-user line).
- line 497: refreshed all-pass summary line.

No other files were touched. No new dependencies. No real process was started, stopped or
restarted. `.env` was not read. No network calls.

## Exact output

`npx tsc --noEmit` (run once): no output, exit 0.

`npx tsx ops/laya-control-check.ts` (run once, verbatim):

```
PASS  layaPids returns exactly the two Laya pids from the mixed list
        got [4103, 4104] (expected [4103, 4104]; router/jcode/http.server excluded)
PASS  layaPids returns [] when no Laya process is present
        got []
PASS  the nvidia-smi parser handles a normal line, empty output and a not-found error
        normal={"name":"NVIDIA GeForce RTX 4050 Laptop GPU","usedMiB":1234,"totalMiB":6144} empty=null notFound={"gpu":null,"layaGpuMiB":null} threw=false
PASS  startLaya refuses when a fake health check says Laya already answers
        result={"started":false,"refused":true,"reason":"Laya is already answering on :8000"} spawnCalled=false
PASS  a fake-health layaStatus returns gpu: null when nvidia-smi is unavailable
        status={"ok":true,"device":"cuda:0","checkpointDevices":{"typed-decisions":"cuda:0"},"cpuFallbacks":{},"loaded":["typed-decisions"],"pids":[],"gpu":null,"layaGpuMiB":null,"gpuUsers":[],"gpuUsersReason":"'nvidia-smi' is not recognized as an internal or external command, operable program or batch file.","requestedDevice":null,"starting":null,"lastStartError":null,"gpuHeadroom":null,"fallbackNotice":null,"lastAction":{"kind":"start","device":"gpu","at":"2026-10-06T09:43:32.097Z","ok":false,"note":"Laya is already answering on :8000"}}
PASS  lastAction: null before any action (status and helper both say null)
        status.lastAction=null helper=null
PASS  lastAction: records a successful switch with device and time, and layaStatus returns it
        result={"switched":true,"from":"gpu","to":"cpu","stopped":[7001]} action={"kind":"switch","device":"cpu","at":"2026-10-06T09:43:32.100Z","ok":true} status={"kind":"switch","device":"cpu","at":"2026-10-06T09:43:32.100Z","ok":true} words="Switched to CPU at 15:02 (Laya is now answering on CPU)"
PASS  lastAction: records a failed switch with a reason, and layaStatus returns it
        result={"switched":false,"from":"gpu","to":"cpu","stopped":[],"failedAt":"stop","reason":"Laya could not be stopped (Error: access denied). Nothing was started."} action={"kind":"switch","device":"cpu","at":"2026-10-06T09:43:32.101Z","ok":false,"note":"Laya could not be stopped (Error: access denied). Nothing was started."} status={"kind":"switch","device":"cpu","at":"2026-10-06T09:43:32.101Z","ok":false,"note":"Laya could not be stopped (Error: access denied). Nothing was started."} words="Switch to CPU failed at 15:02: Laya could not be stopped (Error: access denied). Nothing was started."
PASS  gpu bar wording: other-programs for CPU, Laya uses X of Y for a known GPU share, not-reported for a null share
        cpu="GPU memory used by other programs (Laya is on the CPU, so none of this is Laya)" gpu="Laya uses 1.2 GB of 6.0 GB" unknown="Laya's own share is not reported by Windows, the bar shows total GPU use"
PASS  status: process + health down is `starting`; no process + health down past the grace period is `lastStartError`
        starting={"device":"gpu","sinceSec":30} failedError="Laya did not start on CPU and no Laya process is running. Last log lines:\nlogs/laya.err.log\nFetching 5 files:   0%|          | 0/5 [00:00<?, ?it/s]\rFetching 5 files: 100%|##########| 5/5 [00:00<00:00, 248.33it/s]\nINFO:     Started server process [25452]\nINFO:     Waiting for application startup.\nINFO:     Application startup complete.\nINFO:     Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)\nlogs/laya.out.log\nINFO:     127.0.0.1:49218 - \"GET /health HTTP/1.1\" 200 OK\nINFO:     127.0.0.1:49218 - \"GET /health HTTP/1.1\" 200 OK\nINFO:     127.0.0.1:52379 - \"GET /health HTTP/1.1\" 200 OK\nINFO:     127.0.0.1:52379 - \"GET /health HTTP/1.1\" 200 OK\nINFO:     12…"
PASS  status: health up is running; nothing is down
        running={ok:true,starting:null} down={ok:false,starting:null,err:null}
PASS  switch: stop runs before start and starts the opposite device
        calls=[stop, start:cpu] result={"switched":true,"from":"gpu","to":"cpu","stopped":[7001]}
PASS  switch: a failing fake stop means no start (thrown error and still-answering cases)
        thrown={"switched":false,"from":"gpu","to":"cpu","stopped":[],"failedAt":"stop","reason":"Laya could not be stopped (Error: access denied). Nothing was started."} thrownCalls=[stop] stuck={"switched":false,"from":"gpu","to":"cpu","stopped":[7001],"failedAt":"wait","reason":"Laya was stopped but is still answering after 0.1 seconds, so it was not started on CPU."} stuckCalls=[stop]
PASS  headroom: the warning appears for 1.6 GB free and not for 5.0 GB
        1.6GB="GPU has 1.6 GB free; Laya needs about 4.0 GB. It may fall back to CPU or load slowly." 5.0GB=null
PASS  fallback: the CPU-fallback notice appears when a count is above 0
        statusNotice="Some models fell back to CPU" counts={"typed-decisions":2} clean=null
PASS  log tail: redacts a token-shaped string and is capped at 600 characters
        length=195 redacted=true tokenLeaked=false
PASS  gpuUsers parsing: fake counter rows become entries and anything at or below 20 MB is dropped
        parsed=[{"pid":6668,"mb":2960},{"pid":7001,"mb":50}]
PASS  gpuUsers parsing: the two-line Get-Counter form is read too
        pretty=[{"pid":6668,"mb":2960}]
PASS  gpuUsers labels: laya, tts and stt map to plain phrases, anything else uses the process name
        laya="Laya" tts="Voice, text to speech" stt="Voice, speech to text" plain="python.exe" node="node.exe"
PASS  gpuUsers result carries a plain label and never the command line
        users=[{"pid":6668,"name":"python.exe","label":"Voice, text to speech","mb":2960},{"pid":7001,"name":"python.exe","label":"Laya","mb":50}] leaked=false
PASS  gpuUsers: an unavailable counter returns an empty list with a reason, never an error
        threw=false result={"users":[],"reason":"'nvidia-smi' is not recognized as an internal or external command, operable program or batch file."}
PASS  gpuUsers sorting: biggest first, and the newest process first when two sizes tie
        order=[300:2000mb, 200:100mb, 100:100mb]
PASS  gpuUsers panel wording: the sentence appears only for Laya-on-CPU with a non-Laya user over 1 GB
        cpu="To give Laya the GPU, this program has to stop or restart first" gpu=null layaOnly=null small=null line="Voice, text to speech (python, pid 6668): 2.9 GB"

LAYA-CONTROL CHECK ALL PASS (layaPids narrow, nvidia-smi parser safe, startLaya refuses early, starting/lastStartError derived, switch stops before it starts, headroom + fallback + redacted log tail, GPU users named by plain label)
```

All 20 checks PASS, including every earlier LAYA-CTL / LAYA-UX / ORDER U1 case.

## Open issues

1. The counter output format is an assumption. The command emits `"<InstanceName> <CookedValue>"`
   per sample (bytes). `parseGpuCounter()` also accepts the pretty two-line `Get-Counter` text and
   a CSV form, and skips anything it cannot read. On a locale or Windows build that renders the
   counter differently the list comes back empty with no error, so the panel would say
   "GPU users unavailable" rather than showing wrong names. No live run of the real counter was
   done from here (read-only order).
2. `gpuUsers()` runs a PowerShell `Get-Counter` on every `GET /company/laya`, and the panel polls
   that route every 5 s. On this box the counter costs roughly a second per poll. The order did not
   ask for a cache, so none was added.
3. The label priority follows the order literally: a python command line containing `laya` is
   labelled "Laya" before the `tts` / `stt` checks. If the real voice worker's path itself
   contained the word "laya", it would read as "Laya". No real command lines were inspected (no
   live process list was read beyond the proof's fakes).
4. `Dedicated Usage` counts dedicated VRAM only; shared GPU memory is not included, and a process
   with several engines (or on two GPUs) is summed into one `mb`. That matches the panel's purpose
   (who is holding the VRAM) but it is a deliberate choice.
5. In proof case 5 the fake `exec` serves both nvidia-smi and the counter, so `gpuUsersReason`
   shows the nvidia-smi not-found text; on the real box the reason comes from the counter's own
   stderr. No production impact.
