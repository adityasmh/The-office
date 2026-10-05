# REPORT LAYA-CTL: Laya status, stop and start controls on the System page

Order: docs/ORDER_2026-10-06_laya-ctl.md · Date: 2026-10-06 · Status: done, all checks pass.

## Files changed

| File | Change | Line ranges |
| --- | --- | --- |
| `src/company/layaControl.ts` | NEW. `layaStatus()`, `layaPids()`, `stopLaya()`, `startLaya()` + exported nvidia-smi parsers (`parseGpuQuery`, `parseComputeApps`, `readGpu`). | whole file (1-375) |
| `src/server.ts` | Import of the module. | 52-53 (import); routes 1767-1790 |
| `src/server.ts` | `GET /company/laya`, `POST /company/laya/stop`, `POST /company/laya/start` (next to the `/company/system/*` routes). | 1767-1790 |
| `public/v2/views/system.js` | GPU-bar CSS. | 121-122 |
| `public/v2/views/system.js` | Panel state vars (`stopLayaPoll`, `laya`, `layaBusy`, `layaError`, `layaNote`). | 139, 149-153 |
| `public/v2/views/system.js` | `loadLaya()` (GET /company/laya, `ttl:0` so the poll is live). | 184-193 |
| `public/v2/views/system.js` | `renderLayaPanel()`: health, device (GPU/CPU), pids, checkpoints, GPU memory bar with Laya's own share, Stop / Start-on-GPU / Start-on-CPU, plain-word errors. | 220-266 |
| `public/v2/views/system.js` | Panel rendered in `render()` after the status tiles. | 406 |
| `public/v2/views/system.js` | `stopLayaNow()` (confirm: "routing will use fallbacks while Laya is down") and `startLayaNow(device)`. | 456-496 |
| `public/v2/views/system.js` | Button wiring. | 605-607 |
| `public/v2/views/system.js` | 5 s status poll (`startLayaWatch`) started at boot, initial `loadLaya()`, stopped in `cleanup()`. | 623-631, 634, 644, 659 |
| `ops/laya-control-check.ts` | NEW. The five PASS/FAIL checks. | whole file (1-117) |

No other file was edited. Mutations ride the existing global `app.use("/company", companyGuard)` (`x-company-token`), same as every other POST under `/company`.

## Design notes

- Health reuses the lifecycle convention exactly: env `LAYA_HEALTH_URL` (default `http://127.0.0.1:8000/health`), short `AbortSignal.timeout` fetch.
- `layaPids()` is pure and narrow: only `python.exe` whose command line contains `laya.serve` or `laya-gpu-boot.py`. The router (node), jcode and unrelated python never match.
- `stopLaya()` reads the real process table from `terminalReaper.snapshotProcessesAsync` (PowerShell `Get-CimInstance Win32_Process`; no shell string built from user input), kills only the matched pids, waits up to 10 s for `/health` to go down, and reports `{stopped, freedMiB}` (VRAM used before minus after).
- `startLaya({device})` refuses when `/health` already answers, else launches `scripts/serve-laya.ps1` (`-Cpu` for cpu, plus `-LogDir logs`) as a hidden detached process using the same Start-Process mechanics as `lifecycle.spawnDetachedShutdown` (both streams redirected to files so the caller never blocks on an inherited pipe), and returns `{started:true}` at once.
- Test seams (`health`, `processes`, `exec`, `spawn`) exist only so the proof can run with fake data and never touch the live box.

## Run 1: `npx tsc --noEmit`

Command completed with no output (exit 0). No type errors.

```
(no output)
```

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
        status={"ok":true,"device":"cuda:0","checkpointDevices":{"typed-decisions":"cuda:0"},"loaded":["typed-decisions"],"pids":[],"gpu":null,"layaGpuMiB":null}

LAYA-CONTROL CHECK ALL PASS (layaPids narrow, nvidia-smi parser safe, startLaya refuses early)
```

Exit code 0. Both commands were run once, in the foreground.

## Open issues

- None blocking. Two notes:
  1. `stopLaya()` waits for `/health` to go down, not for the driver to release VRAM, so `freedMiB` can read 0 if the GPU frees memory slowly (before/after are sampled around the kill). The panel still reports the pids that were stopped.
  2. The order said "reuse the lifecycle helper" for health; lifecycle's `fetchWithTimeout`/`layaHealthUrl` are module-private and the rules allowed no lifecycle edit, so `layaControl.ts` re-implements the same URL + timeout convention (documented in the file header).
