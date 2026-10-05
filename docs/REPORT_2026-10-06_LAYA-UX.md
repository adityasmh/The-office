# REPORT LAYA-UX: usable Laya start, stop and switch controls

Order: `docs/ORDER_2026-10-06_laya-ux.md` · Date: 2026-10-06 · Status: done, both commands pass.

## Files changed

Only the four allowed files. Nothing was stopped, started or restarted at any point: every
proof case uses fake process lists, fake health and fake nvidia-smi output, and the stop/start
seams of `switchLaya()` were driven with fakes.

| File | Change | Line ranges |
| --- | --- | --- |
| `src/company/layaControl.ts` | Header: LAYA-UX additions. | 26-33 |
| | LAYA-UX constants (`START_GRACE_MS`, `SWITCH_STOP_WAIT_MS`, `LOG_TAIL_LINES/CHARS`, `LAYA_NEEDS_MIB`). | 43-49 |
| | `sleep()`: no longer `unref()`s its timer (see open issue 1). | 62-69 |
| | Remembered start (`pendingStart`), test seams, `deviceWord()`, `deviceOf()`. | 71-103 |
| | `redactTokens()`, `lastLines()`, `logTail()`, `layaStartLogTail()` (read-only, redacted, 600 chars). | 105-166 |
| | `gpuHeadroomWarning()`. | 168-180 |
| | `FallbackInput` + `cpuFallbackNotice()`. | 182-196 |
| | `LayaHealthJson` gains `cpu_fallbacks`. | 230-233 |
| | `LayaStatus` gains `cpuFallbacks`, `requestedDevice`, `starting`, `lastStartError`, `gpuHeadroom`, `fallbackNotice`; `LayaDeps` gains `now`. | 338-364 |
| | `fallbackCounts()`. | 378-387 |
| | `layaStatus()`: derives `starting`, `lastStartError`, the two notices. | 390-433 |
| | `stopLaya()`: clears the remembered start (a stop cancels a start). | 441-443 |
| | `startLaya()`: clears the memory on a refusal, records `{device, at}` after a real spawn. | 476-491 |
| | `SwitchResult` / `SwitchDeps`. | 493-519 |
| | `switchLaya()`: stop -> wait for health down (max 15 s) -> start the other device. | 521-569 |
| `src/server.ts` | Import `switchLaya`. | 53-54 |
| | `POST /company/laya/switch` (the one new route). | 1793-1803 |
| `public/v2/views/system.js` | Header: documented the Laya API. | 30-39 |
| | `deviceWord()`, `fmtElapsed()`. | 95-104 |
| | Panel state: `layaBusyAct`, `layaStartAt`. | 171-176 |
| | `loadLaya()`: keeps the local clock for "Elapsed mm:ss". | 207-221 |
| | `renderLayaPanel()`: buttons by state, starting line, headroom line, fallback notice, log-tail error, per-button busy labels. | 249-325 |
| | `stopLayaNow()` / `startLayaNow()` (busy label, plain-word wording, re-arm the poll). | 515-564 |
| | `switchLayaNow()`: one confirm + `POST /company/laya/switch`. | 566-600 |
| | Button wiring for `laya-switch`. | 710 |
| | `stopLayaWatch()` / `startLayaWatch()`: 3 s while starting, 5 s otherwise. | 728-742 |
| | `cleanup()` uses `stopLayaWatch()`. | tail of `mount()` |
| `ops/laya-control-check.ts` | Rewritten: the 5 earlier cases kept, 5 new LAYA-UX cases added. | whole file (1-294) |

## How the order's items are met

1. **Always-usable buttons.** Down: `Start on GPU` + `Start on CPU` (both enabled). Up: `Switch
   to CPU`/`Switch to GPU` (only the opposite device) + `Stop (free the GPU)`. Switch is one
   `POST /company/laya/switch` behind one confirm whose words say Laya stops first, that
   routing uses fallbacks while it reloads, and that a failed stop means no start. The module
   refuses to start if the stop throws or if health still answers after the 15 s wait.
2. **Starting state.** `layaStatus().starting = {device, sinceSec}` when a Laya process exists
   but health is silent. The panel prints "Starting on GPU. Loading models, usually 1 to 7
   minutes. Elapsed mm:ss", disables Start/Switch, keeps `Stop (cancels the start)` enabled, and
   the watch runs every 3 s (5 s otherwise).
3. **Start failed.** A remembered start, no Laya process, health still down after 20 s -> the
   status returns `lastStartError` with the last 5 lines of `logs/laya.err.log` and
   `logs/laya.out.log`, read-only, redacted, capped at 600 characters, shown in the panel.
4. **GPU headroom.** `gpuHeadroomWarning()` returns "GPU has 1.6 GB free; Laya needs about 4.0
   GB. It may fall back to CPU or load slowly." only below 4.0 GB free, and the panel shows it
   only when a GPU start or a switch to GPU is on offer. It never blocks the action.
5. **After load.** The panel shows `device in use:` from health, and `Some models fell back to
   CPU` when a checkpoint's fallback count is above 0 (or a checkpoint is on CPU after a GPU
   start was asked for).
6. Start options unchanged: `scripts/serve-laya.ps1`, `-Cpu` for CPU, always `-LogDir logs`,
   and a start still refuses when Laya already answers.
7. Every button shows a per-button busy label ("Working…") while its request is in flight, and
   every error/failure is shown in plain words in the panel.

## Run 1: `npx tsc --noEmit`

```
TSC_OK
```

Exit 0. The command itself printed no compiler output (the marker line above is the shell's).

## Run 2: `npx tsx ops/laya-control-check.ts`

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
        status={"ok":true,"device":"cuda:0","checkpointDevices":{"typed-decisions":"cuda:0"},"cpuFallbacks":{},"loaded":["typed-decisions"],"pids":[],"gpu":null,"layaGpuMiB":null,"requestedDevice":null,"starting":null,"lastStartError":null,"gpuHeadroom":null,"fallbackNotice":null}
PASS  status: process + health down is `starting`; no process + health down past the grace period is `lastStartError`
        starting={"device":"gpu","sinceSec":30} failedError="Laya did not start on CPU and no Laya process is running. Last log lines:\nlogs/laya.err.log\nFetching 5 files:   0%|          | 0/5 [00:00<?, ?it/s]\rFetching 5 files: 100%|██████████| 5/5 [00:00<00:00, 716.93it/s]\nINFO:     Started server process [11488]\nINFO:     Waiting for application startup.\nINFO:     Application startup complete.\nINFO:     Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)\nlogs/laya.out.log\nINFO:     127.0.0.1:62497 - \"GET /health HTTP/1.1\" 200 OK\nINFO:     127.0.0.1:62502 - \"GET /health HTTP/1.1\" 200 OK\nINFO:     127.0.0.1:62509 - \"GET /health HTTP/1.1\" 200 OK\nINFO:     127.0.0.1:52056 - \"GET /health HTTP/1.1\" 200 OK\nINFO:     12…"
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

LAYA-CONTROL CHECK ALL PASS (layaPids narrow, nvidia-smi parser safe, startLaya refuses early, starting/lastStartError derived, switch stops before it starts, headroom + fallback + redacted log tail)
```

Exit 0.

## Open issues

1. **The proof found a real bug, and that cost extra invocations.** The first runs of the proof
   stopped silently after the `starting`/`lastStartError` checks: `sleep()` used
   `setTimeout(...).unref()`, so with no other pending handle node exited mid-wait. Because the
   early runs were therefore invalid (and the terminal truncated one of them), I re-ran
   `npx tsc --noEmit` and `npx tsx ops/laya-control-check.ts` after the fix (and once more after
   a wording tweak to the switch timeout message). The two runs quoted above are the final,
   complete ones. `stopLaya()`'s wait loop had the same latent early-return hazard; the fix
   covers both. There was no retry loop and nothing was ever stopped or started.
2. `lastStartError` reads the real `logs/laya.err.log` and `logs/laya.out.log` (read-only, via
   the default reader). The proof case in run 2 therefore shows real, already-redacted log
   lines. `logs/laya-control.out.log` / `.err.log` are written by the existing start path and
   are not read here.
3. `switchLaya()` waits for `/health` to go down, not for the driver to release VRAM, so a
   switch on a slow driver can start the new process while the old memory is still draining.
   15 s is the ceiling; a stop that never goes down leaves Laya down and says so.
4. `requestedDevice` comes from the remembered start, which a stop clears. So the "checkpoint on
   CPU while GPU was requested" half of the fallback notice needs a start from this process's
   memory; the "fallback count above 0" half always works from health alone.
5. Nothing else was edited; `git status` shows only the four order files modified plus the two
   pre-existing untracked docs.
