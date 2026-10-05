# The coder hang: root cause and fix

**Date:** 2026-09-29 · **Status:** FIXED and independently reproduced

## Symptom (as handed over)

`opencode run` executed by hand in a terminal worked (~10s, created `hello.txt`),
but the same command launched by the pipeline worker **never returned**: the task
sat at `coding` for 6+ minutes with the thread stuck at 4 messages, and the worker
produced no output at all.

## What was actually happening

`opencode run` blocks forever when **stdin is an open pipe nobody ever writes to
or closes**. The worker called

```ts
spawn(exe, args, { cwd, env })   // default stdio: ["pipe","pipe","pipe"]
```

so the child inherited an open stdin pipe. A human running the command in a
terminal gets a TTY (or a closed stdin), which is why the manual test worked.

## The experiment that proved it

`ops/probe-stdin.mjs` — four variants, identical command, run **concurrently**,
30s cap, only stdin differs:

| variant | model | stdin | result |
|---|---|---|---|
| kimi-stdin-pipe | kimi-k2.7-code | `pipe` | **TIMEOUT_KILLED**, 30.1s, **0 JSON lines**, 0 bytes |
| kimi-stdin-ignore | kimi-k2.7-code | `ignore` | EXITED 0, **10.0s**, 6 events, `step_finish:stop`, `hello.txt` = "hello", cost $0.01048 |
| deepseek-stdin-pipe | deepseek-v4-flash | `pipe` | **TIMEOUT_KILLED**, 30.1s, **0 JSON lines**, 0 bytes |
| deepseek-stdin-ignore | deepseek-v4-flash | `ignore` | EXITED 0, **7.1s**, 6 events, `step_finish:stop`, `hello.txt` = "hello", cost $0.001293 |

Both models hang identically with a piped stdin and both succeed with stdin
ignored, so the model, the prompt length, and `--dir` were all ruled out.

A companion probe (`ops/probe-node.mjs`, the faithful `spawn` shape) produced the
same zero-byte hang for all four combinations, confirming the worker path.

## The fix (`src/company/workers.ts`, `spawnOpencodeWorker`)

```ts
const child = spawn(opencodeBin, args, {
  cwd: opts.cwd ?? agent.workdir,
  env: { ...process.env },
  stdio: ["ignore", "pipe", "pipe"],   // <-- the one-line root-cause fix
});
```

Plus the hardening recommended in HANDOVER section 6.4, so a stuck or lingering
child can never wedge the pipeline again:

- a single guarded `settle()` resolves the worker promise exactly once;
- it fires on `{"type":"step_finish","part":{"reason":"stop"}}` (the terminal
  event) with a 5s grace kill, so a process that finishes but does not exit
  cannot hang the run;
- it still fires on process `close` with the real exit code;
- a hard ceiling `OPENCODE_TIMEOUT_SECONDS` (default 900s) kills the child and
  resolves as `error` with a `[timeout]` note;
- cost is still parsed from the JSON event stream (`part.cost` summed over
  `step_finish` events, see `docs/opencode-json-events.md`) on every path.

## Ruled out along the way

- **Model**: both the Kimi coder default and DeepSeek hang identically with piped
  stdin and both succeed with it ignored.
- **Prompt length**: the long (system prompt + TASK) and short prompts behave the
  same way; the cause is stdio, not prompt shape.
- **`cwd` + `--dir` both set**: not the cause - both were set in the successful
  `stdin=ignore` runs.
- **argv quoting**: `start`/`Start-Process -ArgumentList` in PowerShell joins
  arguments without quoting, which truncates `--dir "…\Default Project\…"` at the
  space ("Failed to change directory to C:\Users\user\Desktop\Default"). That is a
  *harness* bug, not the app's: Node's `spawn(..., shell:false)` quotes correctly,
  which is why the worker's `--dir` path was never mangled.

## Reproduce / verify

```powershell
cd "C:\Users\user\Desktop\Default Project"
node ops\probe-stdin.mjs 30      # expect the two *-ignore variants to EXIT 0 and write hello.txt
node ops\probe-node.mjs 100      # the full worker-shaped shape
```
