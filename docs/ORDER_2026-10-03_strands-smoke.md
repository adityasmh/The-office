# Order: install Strands Decider 2B locally and run one smoke test (CPU only)

Narrow job. Do exactly these steps, print the final report, and END your turn. Do not wait, poll, loop, or re-read this order.

## Background
Strands Decider 2B (AWS, Apache 2.0, about 1.9B parameters) is a local model that scores developer-supplied answer options instead of writing text. We want to know if it could replace Laya as our local decision model. This job only installs it and proves it runs. The real comparison against Laya comes later and is NOT part of this job.

## Rules
- CPU only. Do not use the GPU (the laptop GPU is shared and has about 3 GB free).
- Create a NEW venv at `tools/strands-decider/venv` (Python 3.11 is on PATH). Do not touch any other venv (`tools/tts/joey-venv`, `tools/stt/stt-venv`), do not touch Laya serving files, the router, or any scheduled task.
- Do not edit any existing file in the repo. Only create files under `tools/strands-decider/`.
- Free RAM is limited (about 5 to 7 GB). If a step fails for memory reasons, report the exact error and END your turn.
- If any step fails, report the exact error and END your turn; do not retry in a loop.

## Steps
1. `python -m venv tools\strands-decider\venv`
2. `tools\strands-decider\venv\Scripts\python -m pip install strands-decider` (this pulls PyTorch; it can take several minutes). If it installs the CUDA build of torch that is fine, but run on CPU.
3. Smoke test, CPU, one question, run once:
   `tools\strands-decider\venv\Scripts\strands-decider ask StrandsAgents/strands-decider-2B-hobson-v19 --state "Task: rename a variable in one small file." --choice "Which model tier is enough?=cheap,standard,strong"`
   If the CLI name or the model id is wrong, read the package's own `--help` or its README inside the venv (site-packages) to find the correct form, and use that. Do not browse the web.
4. Measure and record: wall-clock seconds of the first call (includes model download/load), disk used by the Hugging Face cache for this model (size of the folder under `%USERPROFILE%\.cache\huggingface\hub` for it), and peak RAM of the python process if you can read it cheaply (Get-Process peak working set after the call). Run the same ask a second time in one process only if the CLI supports it cheaply; otherwise skip.
5. Write the result to `tools/strands-decider/SMOKE_RESULT.md`: the exact commands that worked, the output (options with scores/confidence), the numbers from step 4, and any error. Then print the same as your final report and END your turn.
