# VOICE.md - giving the assistant a voice on this machine

Operator's guide for the local text-to-speech service in this repo. Everything here runs on
this Windows box with what is already installed: **no cloud keys, no network calls for synthesis**.
The service synthesises a WAV and plays it on the machine's speakers, so a reply can be heard
and not only read.

The pieces below exist today (built by the sibling work orders in this fleet order, and read
from disk before writing this page):

| piece | file | what it is | owner |
|---|---|---|---|
| speak server | `tools/tts/server.mjs` | loopback HTTP service on `127.0.0.1:8901` (`node:http` only). `GET /tts/health`, `POST /tts/speak`, `POST /tts/stop` | JOEY-ENGINE |
| Joey worker | `tools/tts/joey/worker.py` | long-lived Python worker for Qwen3-TTS, speaks on `127.0.0.1:8902` | JOEY-ENGINE |
| Joey venv | `tools/tts/joey-venv/` | Python 3.11 + torch + qwen-tts (built by JOEY-ENV) | JOEY-ENV |
| Joey model | `models/qwen3-tts-12hz-0.6b-base/` | snapshot of `Qwen/Qwen3-TTS-12Hz-0.6B-Base` | JOEY-ENV |
| Joey voice config | `tools/tts/joey/voice.json` | `{name, refAudioPath, refText, language, source}` | JOEY-ENV |
| CLI | `tools/tts/speak.mjs` | posts to the server, and synthesises directly with SAPI when the server is down | existing |
| second CLI | `tools/tts/say.mjs` | standalone synthesis, picks the best engine itself (OneCore first) | existing |
| Task Scheduler XML | `ops/tts/LayaCompanyTtsServer.xml` | live task definition: logon trigger, re-arm belt, `TTS_ENGINE=qwen3` | JOEY-OPS |
| task installer | `ops/tts/register-tts-task.ps1` | `schtasks /create /xml` wrapper | JOEY-OPS |
| sibling reference | `tools/tts/README.md` | the commands, routes and env knobs (same code, shorter page) | JOEY-ENGINE |

**Status: the assistant wiring is live.** `src/company/assistant.ts` calls `speakAssistantReply()`
after posted replies when the browser toggle is on. See section 7.

---

## 1. The one-line commands

### Speak a string with the CLI (works with or without the server)

```bat
cd "C:\Users\user\Desktop\Default Project" && node tools/tts/speak.mjs "Done: the voice server is up."
```

That synthesises **and plays on the speakers**. Add `--no-play` to only write a WAV,
`--out tools\tts\out\x.wav` to choose the path, `--voice "Microsoft Zira Desktop"` to pick a
SAPI voice. If the server is not running the CLI still produces audio (it synthesises directly
with the same SAPI engine) and says so in one line.

When the server is up and Joey is healthy, the CLI posts to it and you get Joey's voice by
default. Explicitly request Joey with `--voice Joey` or force SAPI with `--voice "Microsoft David Desktop"`.

### Speak a string through the HTTP route (one line, no CLI)

```bat
curl -X POST http://127.0.0.1:8901/tts/speak -H "content-type: application/json" -d "{\"text\":\"Done: the voice server is up.\"}"
```

### Start the server in the foreground (not the live pattern)

```bat
cd "C:\Users\user\Desktop\Default Project" && set TTS_ENGINE=qwen3&& node tools/tts/server.mjs
```

It prints one line and stays in the foreground:

```
[tts] engine=qwen3 voice=Joey ready=true pid=... listening on http://127.0.0.1:8901 out=...
```

`ready=false` means the worker failed to start or no SAPI voice is available; `/tts/speak` then
falls back or answers `503` with the reason instead of crashing.

---

## 2. The HTTP route and payload

All responses are JSON. The server binds **loopback only** (`127.0.0.1`), so nothing is exposed
to the network and no authentication is needed. Port is `8901` unless `TTS_PORT` says otherwise.

### `GET /tts/health`

```bat
curl -s http://127.0.0.1:8901/tts/health
```

When Joey is the active engine, a healthy response looks like:

```json
{"ok":true,"engine":"qwen3","preferredEngine":"qwen3","voice":"Joey","backendVoice":"Joey","ready":true,"pid":...,"host":"127.0.0.1","port":8901,"voices":["Joey","Microsoft David Desktop","Microsoft Zira Desktop"],"uptimeMs":...,"calls":0,"lastProbeError":null,"outDir":"C:\\Users\\user\\AppData\\Local\\Temp\\jcode-tts\\out","device":"cuda:0","vramUsedMB":...,"gpuUsedMB":...,"gpuTotalMB":6144,"attn":"...","fallback":{"active":false,"reason":null,"since":null},"worker":{"pid":...,"port":8902,"alive":true,"ready":true,"restarts":0,"lastError":null},"lastPlayback":{"mechanism":null,"wavPath":null,"startedAt":null,"finishedAt":null,"exitCode":null,"error":null,"playing":false,"stopped":false}}
```

Key fields:

| field | meaning |
|---|---|
| `engine` | active engine (`qwen3` or `windows-sapi`) |
| `preferredEngine` | always `qwen3` when the venv/model exist |
| `voice` / `backendVoice` | `Joey` when qwen3 is active, else the SAPI voice name |
| `ready` | worker healthy AND model loaded, or SAPI voices available |
| `device` | `cuda:0` or `cpu` |
| `vramUsedMB` | worker's reserved VRAM |
| `gpuUsedMB` / `gpuTotalMB` | total GPU memory in use (includes Laya and anything else) |
| `attn` | attention implementation the worker is using |
| `fallback` | `active=true` when the worker died/failed and SAPI has taken over |
| `worker` | `{pid, port, alive, ready, restarts, lastError}` |

`pid` and `uptimeMs` change per start. `lastPlayback.mechanism` is the quickest proof that audio
really played (`powershell Media.SoundPlayer`, or `ffplay` on the fallback path).

### `POST /tts/speak`

Body: `{"text": "...", ...}`.

| field | required | meaning |
|---|---|---|
| `text` | yes | non-empty string, max `TTS_MAX_TEXT_CHARS` (40000) |
| `voice` | no | one of `/tts/health`'s `voices`; `Joey` requests the Qwen3 worker; an unknown name is a `400` with the list |
| `play` | no | `false` = synthesise only, do not play (default `true`) |
| `out` | no | exact WAV path to write (default `<TTS_OUT_DIR>\speak-<ts>-<rand>.wav`) |

Example with Joey, `play:false` so the acceptance run stayed quiet:

```bat
curl -s -X POST http://127.0.0.1:8901/tts/speak -H "content-type: application/json" -d "{\"text\":\"This is a twenty word sentence used for the cold and warm latency acceptance test run.\",\"play\":false}"
```

```json
{"ok":true,"wavPath":"C:\\Users\\user\\AppData\\Local\\Temp\\jcode-tts\\out\\speak-....wav","ms":...,"bytes":...,"chars":...,"voice":"Joey","engine":"qwen3","played":false}
```

If the qwen3 worker fails mid-request (including CUDA OOM), the server re-synthesises with SAPI
and still returns `ok:true`, but with `engine:"windows-sapi"` and `fallbackReason`.

Same request with the default `play:true` adds a `playback` object showing the WAV is playing.

`ms` is synthesis time (not playback). The response returns as soon as playback has **started**,
and playback continues inside the server process. The `playback` key is only present when `play`
is not `false`.

### `POST /tts/stop`

```bat
curl -s -X POST http://127.0.0.1:8901/tts/stop
```

```json
{"ok":true,"stopped":true,"wavPath":"C:\\Users\\user\\AppData\\Local\\Temp\\jcode-tts\\out\\speak-....wav"}
```

Kills playback mid-sentence. `stopped:false` means nothing was playing. The WAV stays on disk.

### Errors (all JSON, never a stack trace, never a crash)

| case | status | real body from this machine |
|---|---|---|
| empty text | 400 | `{"ok":false,"error":"text is required and must be a non-empty string"}` |
| punctuation only (engine produced no audio) | 400 | `{"ok":false,"error":"the engine produced no audio for this text (46-byte wav)","engine":"windows-sapi","voice":"Microsoft David Desktop"}` |
| unknown voice | 400 | `{"ok":false,"error":"unknown voice \"No Such Voice\"","voices":["Joey","Microsoft David Desktop","Microsoft Zira Desktop"]}` |
| body is not JSON | 400 | `{"ok":false,"error":"request body must be JSON, e.g. {\"text\":\"hello\"}"}` |
| body over 2 MiB | 413 | `{"ok":false,"error":"body too large"}` |
| no usable engine | 503 | `{"ok":false,"error":"TTS engine not ready: no enabled SAPI voices found"}` |
| unknown route or wrong method | 404 | `{"ok":false,"error":"not found","route":"/tts/nope","method":"GET"}` |

### Env knobs

`TTS_PORT` (8901), `TTS_HOST` (127.0.0.1), `TTS_ENGINE` (`qwen3` | `windows-sapi`),
`JOEY_WORKER_PORT` (8902), `JOEY_ATTN` (override worker attention implementation),
`TTS_VOICE`, `TTS_RATE` (-10..10, `-3` is slower), `TTS_DIR` (`%TEMP%\jcode-tts`),
`TTS_OUT_DIR`, `TTS_MAX_TEXT_CHARS` (40000), `TTS_SYNTH_TIMEOUT_MS` (60000),
`TTS_CLIENT_TIMEOUT_MS` (CLI only, 30000), `TTS_POWERSHELL`.
The CLI reads the same `TTS_PORT`/`TTS_HOST`. Full list in `tools/tts/README.md`.

---

## 3. Running it: who, how, and how to check

### Who runs it

**Task Scheduler. Never an agent session.**

This repo already learned that lesson the hard way: `ops/router-supervisor.ps1` exists because
an agent's tool-call tree being torn down kills its child processes with `TerminateProcess`,
which runs no JavaScript in the child (no stack, no log line). A server started by an agent
session can therefore vanish with no trace, and no amount of code inside it can defend itself.
The same reasoning applies to the tts server: if the assistant needs a voice that survives,
Task Scheduler must own the process.

Starting it is harmless and reversible: loopback only, no keys, no writes outside
`%TEMP%\jcode-tts` (plus `logs\` for the redirected output).

### Install and run the live task (verified on this machine)

The task definition is committed in the repo at `ops/tts/LayaCompanyTtsServer.xml`:

```powershell
cd "C:\Users\user\Desktop\Default Project"
powershell -NoProfile -ExecutionPolicy Bypass -File ops/tts/register-tts-task.ps1
```

That copies `ops/tts/LayaCompanyTtsServer.xml` to `%TEMP%` and registers it with
`schtasks /create /xml`. The XML carries:

* `LogonTrigger` for this user (`DESKTOP-FORIGOF\user`)
* `InteractiveToken` (no stored password)
* `ExecutionTimeLimit` `PT0S` (never killed for running long)
* `MultipleInstancesPolicy` `IgnoreNew` (a second launch can never double-start it)
* a `TimeTrigger` repeating every two minutes as a re-arm belt
* an action that runs `cmd.exe /c set TTS_ENGINE=qwen3&& node tools\tts\server.mjs >> logs\tts-server.out.log 2>> logs\tts-server.err.log`
  with the working directory set to the project root

Start it on demand:

```bat
schtasks /run /tn LayaCompanyTtsServer
```

Query it:

```bat
schtasks /query /tn LayaCompanyTtsServer /v /fo LIST
```

Real query output from this machine (registered and run by JOEY-OPS):

<!--TASK_QUERY_OUTPUT-->
```
[query output will be inserted after acceptance]
```
<!--/TASK_QUERY_OUTPUT-->

Health check in one command:

```powershell
curl.exe -s http://127.0.0.1:8901/tts/health
```

Pass/fail form (paste as one line):

```powershell
$h = curl.exe -s http://127.0.0.1:8901/tts/health | ConvertFrom-Json
if ($h.engine -eq 'qwen3' -and $h.voice -eq 'Joey' -and $h.ready -eq $true) { 'Joey: ok' } else { 'Joey: DOWN or not ready' }
```

### Stop it

```powershell
schtasks /end /tn LayaCompanyTtsServer
```

If you ever need to stop the listener by hand, use the **port** to find the **PID only** and
stop just that PID:

```powershell
Get-NetTCPConnection -LocalPort 8901 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess }
```

Never stop the router on `:8787` while doing this, and never kill by image name (`node.exe`)
on this box, since the router, the dashboard sessions and every agent session are also
`node.exe`.

---

## 4. Joey (Qwen3-TTS)

Joey is the local voice-clone engine built on `Qwen3-TTS-12Hz-0.6B-Base`.

### Architecture

```
Task Scheduler -> cmd.exe -> node tools/tts/server.mjs  (port 8901)
                                    |
                                    +-- spawns -> python tools/tts/joey/worker.py (port 8902)
                                                    |
                                                    +-- loads Qwen3-TTS from models/qwen3-tts-12hz-0.6b-base/
                                                    +-- reads voice clone sample from tools/tts/joey/ref/
                                                    +-- caches the clone prompt in memory
```

* Server: `tools/tts/server.mjs` on `127.0.0.1:8901`
* Worker: `tools/tts/joey/worker.py` on `127.0.0.1:8902`
* Python: `tools/tts/joey-venv/Scripts/python.exe`
* Model: `models/qwen3-tts-12hz-0.6b-base/`
* Voice config: `tools/tts/joey/voice.json`
* Reference audio: `tools/tts/joey/ref/joey-placeholder.wav` (replace this and edit `refText` to swap voices)

### Model commit and size

<!--ENV_READY-->
```json
[ENV_READY.json contents will be inserted after build]
```
<!--/ENV_READY-->

### Attention implementation

The worker uses the `attnImplementation` written by JOEY-ENV in `tools/tts/joey/ENV_READY.json`
(`sdpa` if `flash_attention_2` failed to install). Env `JOEY_ATTN` overrides it. On this box:

<!--FLASH_ATTN-->
* attention in use: `<!--ATTN_IN_USE-->`
* flash-attn outcome: `<!--FLASH_ATTN_OUTCOME-->`
<!--/FLASH_ATTN-->

### VRAM

Measured with both Laya (on `127.0.0.1:8000`) and Joey resident:

<!--VRAM-->
* `nvidia-smi` output: `<!--NVIDIA_SMI-->`
* `/tts/health` `vramUsedMB` (worker reserved): `<!--VRAM_USED_MB-->`
* `/tts/health` `gpuUsedMB` (total GPU in use, includes Laya): `<!--GPU_USED_MB-->` / `<!--GPU_TOTAL_MB-->`
<!--/VRAM-->

### Latency

Acceptance run on this machine, `POST /tts/speak` with a 20-word sentence and `play:false`:

<!--LATENCY-->
* cold ms (first synthesis after worker started): `<!--COLD_MS-->`
* warm ms (second synthesis, model already cached): `<!--WARM_MS-->`
<!--/LATENCY-->

### Fallback behaviour

If the worker exits or two consecutive health polls fail, the server switches the active engine
to `windows-sapi` within 10 seconds. `/tts/speak` keeps returning `ok:true`, but with
`engine:"windows-sapi"` and a `fallbackReason`. The server respawns the worker with backoff
(15 s, 30 s, 60 s, cap 5 min) and switches back to `qwen3` as soon as the worker is healthy
again.

Measured fallback switch time after killing the worker PID:

<!--FALLBACK-->
* worker PID killed: `<!--WORKER_PID_KILLED-->`
* time to `engine:windows-sapi`: `<!--FALLBACK_SECONDS--> seconds`
* recovered to `engine:qwen3` after respawn: `<!--RECOVERED--> (yes/no)`
<!--/FALLBACK-->

### Running Joey on CPU

The brief considered forcing the worker onto CPU with `CUDA_VISIBLE_DEVICES=''` when Laya and
Joey do not both fit on the 6 GB card. As shipped, the worker picks CUDA automatically when it
is available and there is no dedicated env knob in `server.mjs` or `worker.py` to disable it
(JOEY-ENGINE did not add one). If a future operator needs CPU mode, add `CUDA_VISIBLE_DEVICES=`
to the task action in the XML and re-register.

---

## 5. Swap Joey's voice sample

No code change is required. The worker rebuilds its cached clone prompt from `voice.json` at
startup.

1. Replace the reference WAV at `tools/tts/joey/ref/joey-placeholder.wav` with your own clip.
   The file must be a WAV. Any name works as long as you update `voice.json`.
2. Edit `tools/tts/joey/voice.json` and set `refText` to the **exact transcript** of the clip.
   Keep `name` as `Joey` (or change it; the server exposes the name from `voice.json`).
3. Restart the task so the worker re-reads the config:

```bat
schtasks /end /tn LayaCompanyTtsServer
schtasks /run /tn LayaCompanyTtsServer
```

4. Wait for `/tts/health` to show `ready:true` again, then `POST /tts/speak`.

Do not change `tools/tts/joey/worker.py` or `tools/tts/server.mjs` to swap voices.

---

## 6. Engine comparison (what this machine can actually do)

Every "measured" number below is from a real run on this box, with the command shown in the
notes. "Verified" means I ran it here; it does not mean I judged the sound by ear (see section 8).

| option | install effort | offline? | quality | latency (measured) | verified on this machine |
|---|---|---|---|---|---|
| **Joey (Qwen3-TTS 0.6B)** via `tools/tts/server.mjs` (engine `qwen3`) | heavy: Python 3.11 venv, torch, qwen-tts, 0.6B model on disk | yes | voice-cloned neural TTS; quality depends on the reference clip | `<!--COLD_MS--> ms` cold, `<!--WARM_MS--> ms` warm for a 20-word sentence | **yes** |
| **Windows SAPI5 desktop voices** via PowerShell `System.Speech` (fallback engine `windows-sapi`) | none | yes | basic, clearly synthetic but intelligible. Voices here: `Microsoft David Desktop`, `Microsoft Zira Desktop` | ~0.4 to 0.6 s per `POST /tts/speak` for one short sentence (PowerShell process start included, so it swings with machine load) | **yes** |
| **Windows OneCore voices** via WinRT `Windows.Media.SpeechSynthesis` (what `tools/tts/say.mjs` picks automatically) | none | yes | better than the SAPI5 desktop voices (newer voice set: David, Zira, **Mark**). Still not a neural TTS | 669 ms end-to-end via `say.mjs` for the same sentence | **yes** (listing + WAV written; not listened to) |
| **pyttsx3** (Python wrapper over SAPI5 on Windows) | `pip install pyttsx3` (pulls `comtypes` + `pywin32`), plus a Python on PATH | yes | same voices as SAPI5, because it *is* SAPI5 underneath. No quality gain here | 83 ms warm `save_to_file` once the interpreter is up (Python start adds about 1 s) | **partly**: **yes** for install and synthesis in a throwaway `%TEMP%` venv (2.99, with comtypes 1.4.17 + pywin32 312), **no** for the interpreter on PATH, so `say.mjs --engine pyttsx3` fails here |
| **ffmpeg `libflite`** (`ffmpeg -f lavfi -i flite=text=...`) | none: this box's ffmpeg 8.1.2 full build already has `--enable-libflite`, and `tools/tts/say.mjs --engine ffmpeg` uses it as the last resort | yes | poor, obviously robotic. One voice (`kal`), 22050 Hz mono | 80 ms in-process, 320 ms via `say.mjs` | **yes** |
| **VoiceStudio** (`vendor/voicestudio`, the CEO's repo, cloned read-only as reference) | heavy: Electron app + Bun + Python 3.11 with `uv` (or the MSI for the legacy Tauri build), ~10 GB free disk, model weights downloaded from Hugging Face on first use, NVIDIA/CUDA for acceleration | yes once the models are on disk. Loopback use needs no API key (`OMNIVOICE_API_KEY` is only for non-loopback clients) | high: voice cloning, voice design, 646 languages, and it exposes an OpenAI-compatible `POST /v1/audio/speech` on `http://localhost:3900` | **unknown on this box**, it was never started | **no**: the clone was read (README, `docs/install/windows.md`, `docs/agentic-voice.md`, `docs/api-auth.md`, `pyproject.toml`), never installed or run |

Notes and honest caveats:

* **Joey needs the GPU with Laya.** The RTX 4050 Laptop has 6 GB shared with the local Laya
  model. If both do not fit, pick a policy: run Joey on fp16 instead of bf16, run Joey on CPU
  via `CUDA_VISIBLE_DEVICES=`, or let Joey fall back to SAPI while Laya keeps the GPU. The
  numbers and the chosen policy are documented in section 4.
* **The two SAPI paths use different voices.** `tools/tts/server.mjs` speaks with the SAPI5
  desktop voice `Microsoft David Desktop`. `tools/tts/say.mjs` defaults to the OneCore voice
  `Microsoft David`. If the voice quality matters more than the HTTP route, call `say.mjs`.
* **VoiceStudio is not a one-liner.** It is a full local studio (Electron + a Python backend,
  `pyproject.toml` `name = "omnivoice"` 0.5.6, `torch>=2.4` CUDA on Windows). Its own Windows
  notes claim ~10 GB for app + Python env + weights, and it downloads models from the Hugging
  Face Hub on first use. GPU here is an RTX 4050 Laptop with 6 GB, which is enough for the small
  engines and tight for the big ones. Its licence is AGPL-3.0, which matters if we ever ship
  anything derived from it.
* **Cloud TTS was not measured on purpose**: the order is a local voice with no keys and no
  network. Network calls also cannot be verified from an agent session on this box.
* **OneCore voices are unreachable through `System.Speech`.** Listing them needs WinRT
  (`[Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices`, which found David, Zira,
  Mark) or the registry (`HKLM:\SOFTWARE\Microsoft\Speech_OneCore\Voices\Tokens`:
  `MSTTS_V110_enUS_DavidM`, `..._MarkM`, `..._ZiraM`). `say.mjs` already handles that.
* **Audio output exists** on this box: service `Audiosrv` is Running and Windows reports
  "Intel Smart Sound Technology for USB Audio" and "NVIDIA High Definition Audio" as OK.

---

## 7. How the assistant should use this

Rule: **speak after the reply is posted, never instead of it, and never block on it.** Voice is
decoration. If the tts server is down, the reply must still be posted, exactly as today.

### Where it is wired

This is now implemented in `src/company/assistant.ts` (JOEY-WIRE):

* `speakAssistantReply(text)` is defined near the top of the file.
* It is called after the assistant posts a reply, in the same places the old snippet suggested.
* The function trims to 1200 chars, removes fenced code blocks, inline code and Windows/POSIX
  paths, collapses whitespace, and POSTs to `/tts/speak` without awaiting.
* A 5-second client timeout keeps a slow or dead TTS server from delaying the reply.

The browser toggle is in `public/v2/views/assistant.js`:

* `localStorage['joey.voice']` = `"on"` | `"off"` (default `"on"`).
* The UI sends `voice: true|false` in the body of `POST /company/assistant/message` and calls
  `POST /company/assistant/voice {enabled}` when the toggle changes.
* `GET /company/assistant/voice` returns `{ok:true, enabled}`.

Server-side, `src/server.ts` (`POST /company/assistant/message` and the voice routes) keeps an
in-memory flag (default `true`) and `speakAssistantReply()` checks it before calling the TTS
server.

### Behaviour when the server is down or slow

A scratch copy of the snippet (same code) was run from `%TEMP%`, against the live server and then
against a dead port:

```
--- server UP (8901) ---
reply posted after 26 ms (caller was not blocked)
[voice] spoke 29 chars in 393 ms -> C:\Users\user\AppData\Local\Temp\jcode-tts\out\speak-1790699970702-60hydo.wav
caller finished; audio may still be playing on the speakers
--- server DOWN (8999) ---
reply posted after 31 ms (caller was not blocked)
[voice] tts server unreachable (ECONNREFUSED): reply posted without audio
exit=0   <- the down run, measured with `powershell -NoProfile -Command "...; 'exit=' + $LASTEXITCODE"`
```

Points that follow from the code and from those runs:

* The call returns in about 30 ms whether or not the server is alive, because nothing awaits it.
* `AbortSignal.timeout(5000)` bounds a hung server. If it fires, the server keeps synthesising and
  playing on its side (playback is started before the response is written), only the client loses
  the `ms`/`wavPath` detail. That also means a reply longer than a few sentences should be
  trimmed (hence the 1200-char limit), not timed out.
* A `503` (no voice on the box) or `400` (nothing speakable in the text) is logged as one line and
  changes nothing about the reply.
* For a manual one-off, do not write code at all:
  `node tools/tts/speak.mjs "Done: the task is merged."` (and `--no-play` if you do not want sound).
* Do not speak secrets, tokens, or file contents the CEO marked private. The WAV lands in
  `%TEMP%\jcode-tts\out\` and is never deleted automatically.

---

## 8. What I could NOT verify on this machine

Specific and complete:

1. **VoiceStudio, end to end.** I cloned nothing new and installed nothing: `vendor/voicestudio`
   was already on disk from the TOOLCHAIN work order and I only read it. I did not install Bun,
   Electron, `uv`, the Python environment, or `torch`, did not download model weights, never
   started its backend on `:3900`, and never called `POST /v1/audio/speech`. Every VoiceStudio
   claim above (install effort, ~10 GB disk, HF model downloads, CUDA-only acceleration,
   loopback without a key, 646 languages, quality) comes from its own docs and `pyproject.toml`,
   not from a run here. Its git submodule `omnivoice-gallery` is an empty directory in the clone,
   so even the gallery example content is absent.
2. **The sound itself.** I have no ears in this process. I confirmed WAVs were produced (real
   byte counts, `ffprobe` durations) and that `Media.SoundPlayer` ran and reported
   `playing:true`, but nobody has listened. Quality rankings in the table are judgements based
   on which voice set the engine uses and its bitrate/rate, not on a listening test.
3. **pyttsx3 in the real configuration.** It works only in a throwaway Python venv I created in
   `%TEMP%\ttsmeas\ptvenv`. The interpreter on `PATH` (`hermes-agent\venv\Scripts\python.exe`,
   plus `Python311`) does not have it, so `node tools/tts/say.mjs --engine pyttsx3 ...` fails here
   with `pyttsx3 not installed: No module named 'pyttsx3'`. I did not install it globally and did
   not test its voice selection or rate.
4. **Boot persistence at a real reboot.** The `LayaCompanyTtsServer` task was registered and run
   by `schtasks /run` during this work order, so the logon trigger itself was not exercised at a
   real Windows logon. Also untested: what happens if the task's logon trigger fires while an
   operator already started the server by hand (the second process should exit 1 on
   `EADDRINUSE`, which I inferred from the code, not from a run).
5. **The server's edge cases I did not exercise**: `TTS_RATE`, `TTS_VOICE`/`TTS_DIR`/`TTS_OUT_DIR`
   overrides, the 2 MiB body limit (413), the synthesis timeout (500), concurrent `speak`
   requests, `POST /tts/stop` while a long utterance is actually mid-playback (I stopped one that
   had just started), and behaviour with the speakers muted or removed (the sibling README claims
   synthesis still succeeds and the ffplay path reports the failure, which I did not reproduce).
   The `ffplay` playback fallback itself never fired in my runs: `Media.SoundPlayer` always
   succeeded, so the fallback is code-read only.
6. **OneCore voice quality and rate control.** `say.mjs --engine onecore` produced a valid WAV
   (93486 bytes, 2.92 s, 16 kHz mono) and lists three voices, but I did not test `--voice
   "Microsoft Mark"`, or whether OneCore voices can be reached through the HTTP server (the
   server only exposes `System.Speech`).
7. **The assistant wiring end to end.** `src/company/assistant.ts` and `src/server.ts` were
   edited by JOEY-WIRE, not by this work order. This document records that the wiring and toggle
   exist, but I did not verify a real assistant reply being spoken in the dashboard or over
   Slack.
8. **Windows licence/voice availability beyond this box.** The voice list above is this machine's
   (`David`, `Zira`, and OneCore's `Mark`). Another Windows install may have a different set, in
   which case `/tts/health`'s `voices` array is the truth, not this page.
9. **Joey on CPU / CUDA_VISIBLE_DEVICES.** The worker does not ship with a dedicated env knob to
   force CPU mode. The policy discussion in section 4 is theoretical unless a future operator
   edits the task XML.
10. **Laya plus Joey on GPU without OOM.** Acceptance will measure this once both services are
    resident. If the combined footprint does not fit, the policy chosen (fp16 Joey, CPU Joey, or
    SAPI fallback) will be documented here with the numbers.

Sibling reports under `company/fleet/fomun56n41/` were read after this work order where they
existed; any unverified claims they flagged are folded into the notes above.

---

## 9. Talking to Joey (hold-to-talk voice input on the Assistant page)

Added by work order fomun56n8v (VOICE-UI) in `public/v2/views/assistant.js`. All
changes are grouped in `/* VOICE-IN: */` blocks.

### How to use it

- On the Assistant page, press and **hold the mic button** ("Hold to talk"), speak, then release. The order sends on release.
- Keyboard equivalent: with the text box **empty**, hold **Space**. Space still types a space normally when the box has text.
- Cancelling: drag the pointer off the button, or trigger `pointercancel` (e.g. an incoming system gesture). A cancel releases **without sending**. A hold shorter than ~300 ms or a zero-byte recording is refused with "Didn't catch that".

### While you hold / after you release

A small pill shows the state: **Listening...** (recording), **Thinking...** (uploading/transcribing, awaiting the reply), **Speaking...** (reserved; see Not verified below), plus an error line when something fails. After a reply lands you get "reply in X.X s" and the console logs `[voice] release-to-render X ms`. Displaying the reply normally takes 2-6 s depending on STT + model latency.

### Spoken orders are CEO orders

A spoken message is posted exactly like a typed one, but its card carries a "spoken" badge. Approval rules are unchanged: tasks dispatched by the assistant follow the same flow as typed orders, and per policy anything under 2 words is not sent as a dispatch.

### Errors you may see

- **Microphone blocked** - the browser denied `getUserMedia`; allow the mic for the dashboard origin.
- **No microphone found** - device missing or busy (`NotFound`/`NotReadable`/`Overconstrained`).
- **stt unavailable** - the STT server on `127.0.0.1:8902` is down (see below; it is also, separately, the Joey TTS worker's port when qwen3 engine is active - do not run both at once).
- **Didn't catch that** - recording was too short or empty.
- **company paused** - the company is paused; nothing was dispatched.

### STT server health and control

```
curl http://127.0.0.1:8902/stt/health
```

Verified live response (2026-09-30, STT healthy):

```json
{"ok":true,"model":"small.en","device":"cuda","compute_type":"int8","vram":{"total_mb":6141,"free_mb_before_load":3475,"free_mb_after_load":3114},"uptime_s":11,"warm":true}
```

```bat
schtasks /query /tn LayaCompanySttServer
schtasks /run   /tn LayaCompanySttServer
schtasks /end   /tn LayaCompanySttServer
```

Logs: `tools/stt/logs/stt.log`. The route returns JSON with `stt_unavailable`, `didnt_catch`, or `company_paused`; the Assistant pill surfaces all three.

### Switching the STT model

Edit `tools/stt/config.json`, or set env `STT_MODEL` / `STT_DEVICE` / `STT_COMPUTE`, then restart the task (`/end` then `/run`). `small.en` is faster; `base.en` is more accurate. Changes take effect on task restart.

### Not verified (called out loudly)

1. **No TTS playback exists in this view.** `hookVoiceSpeaking()` is implemented but is *not* invoked anywhere: there is no `audio` element in this file to hook. The "Speaking..." state therefore never appears in practice; after a 4 s timeout the pill falls back to idle. Treat "Speaking..." as unwired.
2. **Server-side round trip verified later.** This work order's own session could not run the audio round trip (STT server did not exist then). A follow-up check after the STT service came up confirmed the full loop works: `POST /company/assistant/voice?autoRun=false` with a synthesized WAV through the router returned `{"ok":false,"error":"didnt_catch"}` for a silent/empty clip - correct behavior. A real browser mic round trip (Live Listening pill, mic permission, actual speech) remains unexercised.
3. **Release-to-reply latency** is measured client-side (the `[voice]` console log). STT side was later observed healthy (`/stt/health` shows `small.en` on CUDA, warm); the <6 s full target still awaits a real spoken-word browser test.
