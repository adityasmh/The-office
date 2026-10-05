# opencode `run --format json` event capture

Captured so cost tracking (per-agent budget charging) reads the right fields.

## Command

```powershell
& "C:\Users\user\AppData\Roaming\npm\node_modules\opencode-ai\bin\opencode.exe" `
  run --dir "C:\Users\user\Desktop\Default Project\company\seed-probe" `
  --model opencode-go/deepseek-v4-flash --auto --format json "create hello.txt with content hello"
```

- opencode exe: `C:\Users\user\AppData\Roaming\npm\node_modules\opencode-ai\bin\opencode.exe`
- probe dir created first: `company\seed-probe`
- model `opencode-go/deepseek-v4-flash` accepted (no fallback to kimi needed)
- **exit code: 0**
- **wall time: 5454 ms (~5.45 s)** (`[Diagnostics.Stopwatch]`)
- stderr: empty

## Raw stdout (verbatim, one JSON object per line / NDJSON)

```json
{"type":"step_start","timestamp":1790675091462,"sessionID":"ses_f13728c48ffeONeYKdKN3xEPh3","part":{"id":"prt_0ec8d8004001DItB6S6869zLZL","messageID":"msg_0ec8d75ad001kMSymGypvp4jaY","sessionID":"ses_f13728c48ffeONeYKdKN3xEPh3","type":"step-start"}}
{"type":"tool_use","timestamp":1790675091672,"sessionID":"ses_f13728c48ffeONeYKdKN3xEPh3","part":{"type":"tool","tool":"write","callID":"call_3c136017ba3e415c88592571","state":{"status":"completed","input":{"filePath":"C:\\Users\\user\\Desktop\\Default Project\\company\\seed-probe\\hello.txt","content":"hello"},"output":"Wrote file successfully.","metadata":{"diagnostics":{},"filepath":"C:\\Users\\user\\Desktop\\Default Project\\company\\seed-probe\\hello.txt","exists":false,"truncated":false},"title":"Users\\user\\Desktop\\Default Project\\company\\seed-probe\\hello.txt","time":{"start":1790675091628,"end":1790675091648}},"id":"prt_0ec8d8028001XkKiWtLeQ8MIGA","sessionID":"ses_f13728c48ffeONeYKdKN3xEPh3","messageID":"msg_0ec8d75ad001kMSymGypvp4jaY"}}
{"type":"step_finish","timestamp":1790675091672,"sessionID":"ses_f13728c48ffeONeYKdKN3xEPh3","part":{"id":"prt_0ec8d80c7001cbNjXE6Fk55fll","reason":"tool-calls","messageID":"msg_0ec8d75ad001kMSymGypvp4jaY","sessionID":"ses_f13728c48ffeONeYKdKN3xEPh3","type":"step-finish","tokens":{"total":9794,"input":7923,"output":79,"reasoning":0,"cache":{"write":0,"read":1792}},"cost":0.001241226}}
{"type":"step_start","timestamp":1790675092450,"sessionID":"ses_f13728c48ffeONeYKdKN3xEPh3","part":{"id":"prt_0ec8d83de001IK56hDuO4qvlry","messageID":"msg_0ec8d80d3001Zo8S65y3Ttzbr2","sessionID":"ses_f13728c48ffeONeYKdKN3xEPh3","type":"step-start"}}
{"type":"text","timestamp":1790675092490,"sessionID":"ses_f13728c48ffeONeYKdKN3xEPh3","part":{"id":"prt_0ec8d83ed001VCXJ7KCdeMXYO3","messageID":"msg_0ec8d80d3001Zo8S65y3Ttzbr2","sessionID":"ses_f13728c48ffeONeYKdKN3xEPh3","type":"text","text":"Done.","time":{"start":1790675092461,"end":1790675092465}}}
{"type":"step_finish","timestamp":1790675092490,"sessionID":"ses_f13728c48ffeONeYKdKN3xEPh3","part":{"id":"prt_0ec8d83f6001kfYRZp2qKv3WR9","reason":"stop","messageID":"msg_0ec8d80d3001Zo8S65y3Ttzbr2","sessionID":"ses_f13728c48ffeONeYKdKN3xEPh3","type":"step-finish","tokens":{"total":9813,"input":81,"output":4,"reasoning":0,"cache":{"write":0,"read":9728}},"cost":0.000043734}}
```

## Event `type` values observed

Emitted as newline-delimited JSON. Top-level `type`:

| type | meaning | key fields |
|---|---|---|
| `step_start` | one model step begins | `sessionID`, `part.messageID`, `part.type="step-start"` |
| `tool_use` | a tool call completed | `part.tool` (`write`), `part.state.status`, `part.state.input`, `part.state.output` |
| `text` | assistant text chunk | `part.text` |
| `step_finish` | one model step ends (**carries tokens + cost**) | `part.reason` (`tool-calls` / `stop`), `part.tokens`, `part.cost` |

Every line also has `timestamp` (epoch ms), `sessionID`, and a `part` object.

## Where tokens and cost live (exact JSON paths)

- Token counts (**only on `step_finish` events**):
  - `part.tokens.total` — total tokens for the step
  - `part.tokens.input` — input (prompt) tokens
  - `part.tokens.output` — output (completion) tokens
  - `part.tokens.reasoning` — reasoning tokens
  - `part.tokens.cache.write` — cache-write tokens
  - `part.tokens.cache.read` — cache-read tokens
- Cost in USD: **`part.cost`** (number, USD) on each `step_finish` event.
  It is **per-step**, not cumulative. Total run cost = sum of `part.cost` over all
  `step_finish` lines.

This run:

| step_finish reason | tokens.total | tokens.input | tokens.output | part.cost (USD) |
|---|---|---|---|---|
| `tool-calls` | 9794 | 7923 | 79 | 0.001241226 |
| `stop` | 9813 | 81 | 4 | 0.000043734 |
| **total** | | | | **0.001284960** |

For cost accounting: `totalCostUsd = Σ event.part.cost where event.type === "step_finish"`.
Tokens: sum `event.part.tokens.input` / `.output` similarly. `part.cost` is absent on
non-`step_finish` event types (`step_start`, `tool_use`, `text`).

Text output: concatenate `part.text` from `text` events (`"Done."` here).

## Artifact verification

`hello.txt` was actually created by the `write` tool (evidenced by the `tool_use`
event with `output:"Wrote file successfully."`, then confirmed on disk):

```
$ type "company\seed-probe\hello.txt"
hello
```

## Cleanup

Probe dir `company\seed-probe` (including `hello.txt`, `stdout.txt`, `stderr.txt`) was
removed after capture. **Cleaned up: yes.**
