# Voice orders to Joey: shared contract

There are three parts: the STT service (tools/stt), the route (src/server.ts + src/company/assistant.ts) and the UI (public/v2/views/assistant.js). Each builds against this file. Do not change a shape here without updating this file and saying so in your report.

## 1. STT server (owned by STT-SVC)
- Listens on 127.0.0.1:8902 ONLY (never 0.0.0.0 or ::).
- Implementation: Python in tools/stt/server.py, run with tools/stt/stt-venv/Scripts/python.exe, using faster-whisper.
- Environment knobs, read at startup:
  - STT_MODEL: default `small.en`, fallback `base.en`.
  - STT_DEVICE: `auto` | `cuda` | `cpu`. Default `auto`, which picks cuda if enough VRAM is free at startup, otherwise cpu.
  - STT_COMPUTE: default `int8_float16` on cuda, `int8` on cpu.
  - STT_PORT: default 8902.
  - The chosen defaults are also written to tools/stt/config.json, so switching model means editing that file or setting the env var, then restarting the task.
- Model files are cached under tools/stt/models (not the global HF cache).

### GET /stt/health
200 `{"ok":true,"model":"small.en","device":"cuda"|"cpu","compute_type":"int8_float16"|"int8","vram":{"total_mb":6141,"free_mb_before_load":1234,"free_mb_after_load":987}|null,"uptime_s":12,"warm":true}`
The vram field is null only if nvidia-smi is unavailable.

### POST /stt/transcribe
- Body: the raw audio bytes. Content-Type is audio/webm, audio/ogg, audio/wav, audio/x-wav or application/octet-stream. The server does not trust the type; it decodes with faster-whisper/PyAV.
- Max 25 MB. Optional query `?lang=en`.
- 200 `{"ok":true,"text":"Create a task to update the budget report.","ms":812,"language":"en"}`. The text is stripped. `ms` is the server-side decode+transcribe time.
- Errors use 4xx/5xx with `{"ok":false,"error":"empty_audio"|"decode_failed"|"too_large"|"internal","detail":"..."}`.

## 2. Route (owned by VOICE-ROUTE)
### POST /company/assistant/voice
- Body: the raw audio bytes (any audio/* or application/octet-stream, max 25 MB), parsed with express.raw on this route only.
- Query: `autoRun=true|false`. When absent, it is omitted from the call exactly as the typed route would omit it.
- Steps:
  1. The pause check refuseNewWork("POST /company/assistant/voice"). If blocked, return 503 `{ok:false,error:"company_paused",detail}`.
  2. POST the bytes to http://127.0.0.1:8902/stt/transcribe with a 20 s timeout.
  3. Count the words in the transcript. If there are fewer than 2, return 200 `{ok:false,error:"didnt_catch",message:"Didn't catch that",transcript}` and DO NOT call assistantMessage.
  4. Otherwise call `assistantMessage(transcript, { autoRun, spoken: true })`. That is the same function and the same approval path as typed text.
- Success is 200 `{ok:true,transcript,spoken:true,sttMs,reply,tasks,plan,dispatched,decisions}`. Here tasks = the ids/titles recorded on the thread entry (string[], [] if none); the rest is the AssistantResult passed through.
- If the STT server is unreachable or errors, return 502 `{ok:false,error:"stt_unavailable",message:"Speech-to-text server (127.0.0.1:8902) is not reachable. Start it: schtasks /run /tn LayaCompanySttServer",detail}`.
- An empty body returns 400 `{ok:false,error:"audio required"}`.

### GET /company/assistant/stt/health  (STT-HEALTH, work order fomunicug6/WO1)
- Always 200 (never 4xx/5xx for a down service), so the page can tell "speech-to-text is
  down" (`ok:false`) apart from "the router is unreachable" (the request itself fails).
- Proxies the STT service's own `GET /stt/health` (section 1). Its URL is `STT_URL` with
  `/stt/transcribe` replaced by `/stt/health`; `STT_HEALTH_URL` overrides it and
  `STT_HEALTH_TIMEOUT_MS` (default 1500) bounds the probe.
- Up: `{"ok":true,"model":"small.en","device":"cuda","compute_type":"int8_float16","warm":true,"uptime_s":12,"url":"http://127.0.0.1:8902/stt/health"}`
  (a field the service did not report is left out).
- Down: `{"ok":false,"error":"stt_unavailable","message":"<the same wording as the 502 in the voice route>","detail":"ECONNREFUSED"|"no answer in 1500 ms"|"HTTP 502"}`.
- Read-only, so the loopback exemption in companyGuard covers the dashboard. The typed route
  `POST /company/assistant/message` reads none of this: typing an order works with STT down.

### Thread entry
AssistantThreadEntry gains the optional field `spoken?: true`, set only on the CEO entry of a voice order. GET /company/assistant/thread returns it unchanged. assistantMessage opts gain `spoken?: boolean`; it has NO other effect on behaviour.

## 3. UI (owned by VOICE-UI)
- Records with MediaRecorder (audio/webm;codecs=opus, falling back to the browser default) and POSTs the blob to /company/assistant/voice?autoRun=<same toggle value the typed send uses>.
- States: idle, listening, thinking, speaking, error.
- Shows the three errors: mic denied, stt_unavailable, didnt_catch ("Didn't catch that").
- A thread entry with spoken:true is rendered with a "🎤 spoken" tag.
- STT-HEALTH: polls GET /company/assistant/stt/health every 15 s (uncached). While it answers
  ok:false the hold-to-talk button is disabled, its label reads "🎤 Voice unavailable", its
  title carries the reason, and one plain line under the row reads "Speech-to-text is down.
  Type your order instead." The Space hold is off as well (Space then just types). A probe
  that cannot be answered at all (router down) leaves the mic alone, because that is not an
  STT verdict. Typing and sending are never gated on any of this.
