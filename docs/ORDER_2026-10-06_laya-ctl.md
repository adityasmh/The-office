# Order LAYA-CTL: Laya status, stop and start controls on the System page

Narrow job. Do exactly these steps, print the final report, and END your turn. Do not wait, poll, loop, or re-read this order.

## Rules
- You may create `src/company/layaControl.ts` and `ops/laya-control-check.ts`. You may make SMALL insertions in `src/server.ts` (the three routes below, next to the existing `/company/system/*` routes) and in `public/v2/views/system.js` (one new panel). Edit nothing else.
- NEVER stop, start or restart Laya, the router on :8787, or any process while testing. Your proof uses fake process lists and fake command output only. Never start a server on the live `company/`.
- Do not print secrets. Mutating routes must use the existing company guard (the `x-company-token` header) exactly like the other POST routes.
- Run each command ONCE, in the foreground. If a step fails, report the exact error and END your turn; do not retry in a loop.
- Match the surrounding TypeScript and JavaScript style (ES modules, `.js` import suffixes, no new dependencies).

## Read first
`src/company/lifecycle.ts` (how `systemStatus` and the Laya health URL work), `ops/laya-restart.ps1` (which processes it is allowed to stop: ONLY python.exe whose command line runs `laya.serve` or `laya-gpu-boot.py`), `scripts/serve-laya.ps1` (how Laya is started, and its `-Cpu` / `-Device` options), `public/v2/views/system.js` and `public/v2/api.js` (how the page calls the API and sends the token).

## What to build
In `src/company/layaControl.ts` export:
- `layaStatus()`: returns `{ok, device, checkpointDevices, loaded, pids, gpu: {name, usedMiB, totalMiB} | null, layaGpuMiB | null}`. Health comes from `http://127.0.0.1:8000/health` (reuse the lifecycle helper). GPU numbers come from `nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv,noheader,nounits` and, for Laya's own share, `nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits` filtered to Laya's pids. If `nvidia-smi` is missing, `gpu` is null.
- `layaPids(processList)`: pure function. Given a list of `{pid, name, commandLine}`, returns ONLY the pids of python processes whose command line contains `laya.serve` or `laya-gpu-boot.py`. It must never return the router, jcode, or any other python process.
- `stopLaya()`: finds Laya pids from the real process list (PowerShell `Get-CimInstance Win32_Process`, no shell string building from user input), stops only those, waits up to 10 seconds for health to go down, and returns `{stopped: pids, freedMiB}`.
- `startLaya({device})`: `device` is `"gpu"` or `"cpu"`. Refuses if Laya already answers. Starts `scripts/serve-laya.ps1` (with `-Cpu` for cpu) as a hidden detached process and returns at once with `{started: true}`; loading takes minutes, so the caller reads status afterwards.
In `src/server.ts` add:
- `GET /company/laya` returns `layaStatus()`.
- `POST /company/laya/stop` calls `stopLaya()`.
- `POST /company/laya/start` with body `{device}` calls `startLaya`.
In `public/v2/views/system.js` add a "Laya (decision model)" panel: health, device (GPU or CPU), a GPU memory bar (used / total, with Laya's own share), buttons "Stop Laya (free the GPU)" with a confirm dialog that says routing will use fallbacks while Laya is down, "Start on GPU" and "Start on CPU", and a status line that refreshes every 5 seconds while the page is open. Show errors in plain words. The Start buttons are disabled while Laya answers; Stop is disabled while it does not.

## Proof: `ops/laya-control-check.ts`
Print PASS or FAIL per line:
1. `layaPids` returns the two Laya pids from a fake list containing a router node process, a jcode process, an unrelated python.exe, and python.exe processes running `laya.serve` and `laya-gpu-boot.py`.
2. `layaPids` returns an empty list for a list with no Laya process.
3. The nvidia-smi parser handles a normal line, an empty output, and a "not found" error without throwing.
4. `startLaya` refuses when a fake health check says Laya already answers.
5. A fake-health `layaStatus` returns `gpu: null` when nvidia-smi is unavailable.

## Finish
1. Run `npx tsc --noEmit` once.
2. Run `npx tsx ops/laya-control-check.ts` once.
3. Write `docs/REPORT_2026-10-06_LAYA-CTL.md` with the files changed (line ranges in server.ts and system.js), the exact output of both runs, and any open issue. Print the same report and END your turn.
