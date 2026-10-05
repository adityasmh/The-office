# Order: measure Strands Decider 2B on CPU and write the result file

Narrow job. Do exactly these steps, print the final report, and END your turn. Do not wait, poll, loop, or re-read this order.

## Background
Strands Decider is already installed in `tools/strands-decider/venv` and its model is already downloaded (cached). A previous run proved it works: for the state "Task: rename a variable in one small file." with choices cheap/standard/strong it answered `standard` (0.704), cheap 0.210, strong 0.086. That worker was stopped before it could write the numbers. Your job is only to measure and write them down.

## Rules
- CPU only. Do not use the GPU. Do not install or download anything. Do not edit any existing file; only create or overwrite `tools/strands-decider/SMOKE_RESULT.md` and `tools/strands-decider/measure.ps1`.
- Do not touch Laya, the router, any scheduled task, or any other venv.
- Run each measured command ONCE, in the foreground, with its output going to a file under `tools/strands-decider/`, then read that file. Print one short progress line to the console before each command so the log keeps moving.
- If any step fails, report the exact error and END your turn; do not retry in a loop.

## Steps
1. Look at `tools/strands-decider/run_smoke.ps1` (already there) to see the exact working command line.
2. Write `tools/strands-decider/measure.ps1` that runs that same ask command 3 separate times (3 separate processes), and for each run records: wall-clock seconds (Stopwatch), and the python process peak working set in MB (poll the child with a short loop inside the script, 0.5 s steps, until it exits). Use `Start-Process -PassThru -Wait:$false` with redirected output files, and print one line per run when it ends.
3. Run `powershell -NoProfile -ExecutionPolicy Bypass -File tools\strands-decider\measure.ps1` once.
4. Measure the disk size of the cached model folders under `%USERPROFILE%\.cache\huggingface\hub` that belong to Strands Decider and to `Qwen--Qwen3.5-2B-Base` (sum, in GB). Also record the size of `tools\strands-decider\venv` in GB.
5. Write `tools/strands-decider/SMOKE_RESULT.md` with: the exact working command, the output of one run (options with scores), the three wall-clock times, the peak RAM per run, the disk sizes, and a one-line verdict on whether it is practical to run on this laptop (about 5 to 8 GB free RAM, CPU only). Then print the same as your final report and END your turn.
