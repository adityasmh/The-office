# Order LAYA-UX: make the Laya start, stop and switch controls usable

Narrow job. Do exactly these steps, print the final report, and END your turn. Do not wait, poll, loop, or re-read this order.

## Why
The System page already has a "Laya (decision model)" panel (see `docs/REPORT_2026-10-06_LAYA-CTL.md`). It is hard to use: Start buttons are disabled while Laya answers, so switching device takes two manual steps; loading takes several minutes with no feedback; and nothing warns when the GPU lacks free memory.

## Rules
- Edit ONLY `src/company/layaControl.ts`, `src/server.ts` (the three existing Laya routes plus at most one new route, small insertions), `public/v2/views/system.js` (the Laya panel only) and `ops/laya-control-check.ts`. Edit nothing else.
- NEVER stop, start or restart Laya, the router on :8787, or any real process while testing. Proofs use fake process lists, fake health, fake nvidia-smi output and fake spawn only. Never start a server on the live `company/`.
- Do not print secrets. Mutating routes keep the existing company guard (`x-company-token`).
- Run each command ONCE, in the foreground. If a step fails, report the exact error and END your turn; do not retry in a loop.
- Plain words in the UI, no visual polish. Match the surrounding style (ES modules, `.js` import suffixes, no new dependencies).

## What to build
1. **Always-usable buttons.** When Laya is DOWN: "Start on GPU" and "Start on CPU" (both enabled). When Laya is UP on a device: "Switch to CPU" or "Switch to GPU" (only the one that is not the current device) plus "Stop (free the GPU)". Switch = stop, wait until health is down (max 15 s), then start on the other device, as one action behind one confirm dialog that says what will happen and that routing uses fallbacks while Laya reloads. If the stop part fails, do not start, and say so.
2. **Starting state.** Remember in `layaControl.ts` when a start was requested (device, time). `layaStatus()` returns `starting: {device, sinceSec} | null` when a Laya process exists (use the existing pid finder) but health does not answer yet. The panel then shows: "Starting on GPU. Loading models, usually 1 to 7 minutes. Elapsed mm:ss", disables Start and Switch, keeps Stop enabled (it cancels the start), and refreshes every 3 seconds while starting (5 seconds otherwise).
3. **Start failed.** If a start was requested, no Laya process exists, and health does not answer after 20 seconds, return `lastStartError` with the last 5 lines of `logs/laya.err.log` and `logs/laya.out.log` (read-only, at most 600 characters, redact anything shaped like a token) and show it in the panel in plain words.
4. **GPU headroom warning.** Before "Start on GPU" or "Switch to GPU", the panel shows a plain line using nvidia-smi numbers already returned by `layaStatus()`: "GPU has X.X GB free; Laya needs about 4 GB. It may fall back to CPU or load slowly." Show it only when free memory is below 4.0 GB. Never block the action.
5. **After load.** Show the device actually used (from health). If any checkpoint reports a CPU fallback count above 0, or its device is cpu while GPU was requested, show "Some models fell back to CPU" in plain words.
6. Start options: GPU uses `scripts/serve-laya.ps1` with no flag; CPU uses `-Cpu`; always pass `-LogDir logs`. Keep refusing a start when Laya already answers.
7. Buttons show a busy state while a request is in flight, and every error shows in plain words in the panel.

## Proof (`ops/laya-control-check.ts`, fakes only)
Add PASS or FAIL cases:
- Status derivation: Laya process present plus health down is `starting`; no process plus health down after the grace period is `lastStartError`; health up is running; nothing is down.
- Switch sequence with fakes: stop is called before start, the start device is the opposite of the current one, and when the fake stop fails no start happens.
- The headroom message appears for free memory 1.6 GB and does not appear for 5.0 GB.
- The CPU-fallback notice appears when a fake health reports a fallback count above 0.
- The log-tail helper redacts a token-shaped string and is capped at 600 characters.
Keep all earlier cases passing.

## Finish
1. Run `npx tsc --noEmit` once.
2. Run `npx tsx ops/laya-control-check.ts` once.
3. Write `docs/REPORT_2026-10-06_LAYA-UX.md` with the changed line ranges, the exact output of both runs, and any open issue. Print the same report and END your turn.
