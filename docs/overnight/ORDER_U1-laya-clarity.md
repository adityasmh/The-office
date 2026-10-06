# Order U1-laya-clarity: make the Laya panel say plainly what happened

Context: the CEO switched Laya from GPU to CPU with the panel button. It worked (device in use: CPU), but the panel still showed "GPU 3.0 GB used" with no explanation, so it looked as if nothing had changed. The 3 GB belongs to other programs, not Laya.

## Files
`public/v2/views/system.js` (the Laya panel only), `src/company/layaControl.ts` (record the last control action, small insertion), `ops/laya-control-check.ts` (add cases)

## What to build
1. `layaControl.ts`: keep in memory the last control action `{kind: "start"|"stop"|"switch", device: "gpu"|"cpu", at: ISO time, ok: boolean, note?: string}`, set when `startLaya`, `stopLaya` or `switchLaya` finish (success or failure). `layaStatus()` returns it as `lastAction` (null when none yet).
2. The panel: (a) when the device in use is CPU, label the GPU memory bar "GPU memory used by other programs (Laya is on the CPU, so none of this is Laya)"; when it is GPU and Laya's own share is known, show "Laya uses X of Y"; when the share is unknown say "Laya's own share is not reported by Windows, the bar shows total GPU use". (b) Under the status line show the last action in plain words, for example "Switched to CPU at 15:02 (Laya is now answering on CPU)" or "Switch to GPU failed at 15:02: <reason>", kept visible until the next action. (c) After a click, show an immediate line "Switching to CPU... this takes up to a few minutes while the models load" and keep the existing starting state; if the status after 20 seconds still shows the old device and no start is in progress, show "Nothing changed yet: <reason from lastAction>" in the warning colour. (d) Buttons show their busy state while a request is in flight and are re-enabled if the request fails, with the error in plain words.
3. Do not change what the buttons do, only what the panel tells the user.

## Proof (`ops/laya-control-check.ts`, fakes only, never touch a real process)
Add PASS or FAIL cases: `lastAction` is null before any action; it records a successful switch with device and time; it records a failed switch with a reason; the status returns it; the text helper for the GPU bar returns the "other programs" wording for CPU and the "Laya uses" wording for GPU with a known share; the unknown-share wording appears when the share is null. Put the wording helpers in `layaControl.ts` or a small pure function in the view file as named exports so the check can test them. Keep every earlier case passing.

## Common rules
- Edit ONLY the files above. Small targeted edits, never rewrite an entire file. No new dependencies. Never restart the router or stop or start any real process. Never read or edit `.env`. No network calls.
- Run each command once: `npx tsc --noEmit`, then `npx tsx ops/laya-control-check.ts`. If a step fails, report the exact error and END your turn.
- Write `docs/overnight/REPORT_U1-laya-clarity.md` (changed line ranges, exact output, open issues), print the same report and END your turn. Do not wait, poll, loop, or re-read this order.