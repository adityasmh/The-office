# JOEY_SPEC - shared contract for the Joey voice (Qwen3-TTS)

Project root: `C:\Users\user\Desktop\Default Project`. Windows 11, RTX 4050 Laptop 6 GB. The GPU is shared with the local Laya model.

## Paths
| thing | path | owner |
|---|---|---|
| venv (Python 3.11) | `tools/tts/joey-venv/` (python = `tools/tts/joey-venv/Scripts/python.exe`) | JOEY-ENV |
| model | `models/qwen3-tts-12hz-0.6b-base/` (snapshot of `Qwen/Qwen3-TTS-12Hz-0.6B-Base`) | JOEY-ENV |
| voice config | `tools/tts/joey/voice.json` | JOEY-ENV |
| placeholder reference clip | `tools/tts/joey/ref/joey-placeholder.wav` | JOEY-ENV |
| env marker | `tools/tts/joey/ENV_READY.json` | JOEY-ENV |
| worker | `tools/tts/joey/worker.py` | JOEY-ENGINE |
| speak server | `tools/tts/server.mjs` | JOEY-ENGINE |
| engine marker | `tools/tts/joey/ENGINE_READY.json` | JOEY-ENGINE |
| assistant wiring | `src/company/assistant.ts`, `src/server.ts`, `public/v2/views/assistant.js` | JOEY-WIRE |
| scheduler + docs | `ops/tts/LayaCompanyTtsServer.xml`, `docs/VOICE.md` | JOEY-OPS |

## voice.json

{ "name": "Joey", "refAudioPath": "tools/tts/joey/ref/joey-placeholder.wav", "refText": "<exact transcript of the clip>", "language": "English", "source": "<how the clip was made>" }

`refAudioPath` may be relative to the project root or absolute. Swapping the voice means replacing the wav and editing `refText`, then restarting the worker (or the server). No code change is allowed to be needed. The worker reads voice.json at startup and rebuilds its cached clone prompt from it.

## ENV_READY.json (written by JOEY-ENV when everything below is true)

{ "python": "3.11.x", "torch": "2.x.x+cuXXX", "cuda": true, "flashAttn": false, "flashAttnError": "<exact last error line or null>", "attnImplementation": "flash_attention_2|sdpa|eager", "modelDir": "models/qwen3-tts-12hz-0.6b-base", "modelCommit": "<sha>", "modelSizeBytes": 0, "dtype": "bfloat16", "smokeSynthOk": true }

The worker should use `attnImplementation` from this file by default. Env `JOEY_ATTN` overrides it.

## Worker protocol (worker.py <-> server.mjs), loopback HTTP, JSON only
- Start: `tools/tts/joey-venv/Scripts/python.exe tools/tts/joey/worker.py --port 8902 --host 127.0.0.1` (the env var `JOEY_WORKER_PORT` has the same meaning). Load the model once and cache the voice-clone prompt from voice.json. Print exactly one line `[joey-worker] ready device=... attn=... vramMB=... loadMs=...` when ready.
- `GET /health` -> `{ok:true, ready:bool, loading:bool, device:"cuda:0"|"cpu", dtype, attn, model:"Qwen3-TTS-12Hz-0.6B-Base", modelDir, voice:"Joey", refAudioPath, vramAllocatedMB, vramReservedMB, gpuUsedMB, gpuTotalMB, loadMs, calls, lastError}`. The `gpu*` values come from `torch.cuda.mem_get_info`, so they include other processes such as Laya.
- `POST /synth {text, out}` -> `{ok:true, wavPath, ms, bytes, sampleRate, durationSec}`. On error: `{ok:false, error}` with status 4xx/5xx. Handle one synth at a time (serialise the requests). On CUDA OOM: return `{ok:false, error:"cuda out of memory", oom:true}`, call empty_cache, and never exit.
- `POST /shutdown` -> `{ok:true}`, then exit.

## Speak server engine qwen3 (server.mjs)
- `TTS_ENGINE` = `qwen3` (the default when the venv python and the model dir both exist) or `windows-sapi`. The server spawns and supervises the worker itself. Worker stdout and stderr are appended to `logs/joey-worker.log`.
- Health poll every 2 s. Two consecutive failures, or the child exiting, switch the active engine to windows-sapi. This must happen within 10 s of the worker dying. The server then respawns the worker with backoff (15 s, 30 s, 60 s, cap 5 min). When the worker is healthy again, the active engine returns to qwen3.
- If a qwen3 synth fails (including OOM), that request is re-synthesised with SAPI. The response is still `ok:true`, with `engine:"windows-sapi"` and `fallbackReason`.
- The HTTP API stays as it is. `/tts/health` adds these fields: `engine` (active), `preferredEngine`, `voice:"Joey"`, `backendVoice`, `ready`, `device`, `vramUsedMB` (the worker's reserved MB), `gpuUsedMB`, `gpuTotalMB`, `attn`, `fallback:{active, reason, since}`, `worker:{pid, port, alive, restarts, lastError}`. `voices` includes "Joey". Every response is JSON. No uncaught exception may kill the server (install process-level handlers).
- Test instances run on `TTS_PORT=8911` and `JOEY_WORKER_PORT=8912`. Only JOEY-OPS touches the live :8901 and :8902, and only through Task Scheduler.

## ENGINE_READY.json (written by JOEY-ENGINE)
`{ "serverEngines": ["qwen3","windows-sapi"], "coldSynthMs": n, "warmSynthMs": n, "fallbackSeconds": n, "vramUsedMB": n, "attn": "..." }`

## Assistant toggle
- Browser: `localStorage['joey.voice']` = `"on"|"off"` (default on). The UI sends `voice: true|false` in the body of `POST /company/assistant/message` and calls `POST /company/assistant/voice {enabled}` when the toggle changes. `GET /company/assistant/voice` -> `{ok:true, enabled}`.
- Server: an in-memory flag (default true), set by either call. reportBack and the replies both check it.
- `speakAssistantReply(text)`: remove fenced code blocks, inline code and Windows/POSIX file paths, collapse whitespace, trim to 1200 chars on a sentence boundary, POST `/tts/speak` without awaiting, 5 s timeout, and log exactly one `[voice]` warning line on failure.
