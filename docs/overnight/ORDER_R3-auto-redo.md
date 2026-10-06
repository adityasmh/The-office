# Order R3-auto-redo: one automatic retry with the reviewer's notes

## Why
When the reviewer says REDO, the order waits for the CEO to click "send back". One automatic retry, with the reviewer's notes in the brief, makes agents correct themselves and costs one more small session at most.

## Files
`src/company/fleet.ts` (where a verdict REDO is stored, and the existing redo function behind `POST /company/fleet/orders/:id/work/:wid/redo`; small insertion), `src/company/autoRedo.ts` (new), `ops/auto-redo-check.ts` (new), `src/company/envReload.ts` (allow-list line).

## What to build
Env `FLEET_AUTO_REDO=1` turns it on (default off) and `FLEET_AUTO_REDO_MAX` (default 1, hard maximum 2) caps automatic retries per work order. `autoRedo.ts` exports a pure `shouldAutoRedo({verdict, attempts, max, reviewText, reason, failedCiOnly, slotsFree, paused})`. Retry only when: the verdict is REDO, `attempts` is below the cap, the review text is non-empty (the notes are the point), a session slot is free, and the company is not paused. NEVER retry when the REDO came from a missing or empty report with no review text, when a CI-red downgrade is the only reason (a human should look), or when the same review text as the previous attempt repeats (the worker is not learning; stop and ask the CEO). In the code that stores a REDO, when `shouldAutoRedo` says yes, call the existing redo function and add a trace step "auto redo (attempt N of M)"; when it says no for a reason worth showing, add a trace step with the reason in plain words. The new session's brief must include the reviewer's notes (the existing redo already does this; reuse it, do not duplicate).

## Proof (`ops/auto-redo-check.ts`)
PASS or FAIL per line: off by default; retries once on a REDO with notes; respects the cap; does not retry with empty notes, on a CI-red-only reason, on repeated identical notes, when paused or with no free slot; the hard maximum of 2 is enforced even if a larger number is configured; the trace text names the attempt.
## Common rules
- Create or edit ONLY the files named in "Files". Other workers are not running at the same time, but keep edits small and targeted, never rewrite an entire existing file. Match the surrounding style (ES modules, `.js` import suffixes, no new dependencies).
- Never restart or start the router. Never read, print or edit `.env` or any secret value. Never touch `company/`, Laya, Kafka or scheduled tasks. No real network calls in tests (local stubs only). No deletes of existing files.
- Default OFF behind an env flag, so existing behaviour is byte-for-byte unchanged when the flag is unset. Add the new flag name(s) to the allow-list in `src/company/envReload.ts` (small insertion) so they can be reloaded without a restart.
- Run each command ONCE, in the foreground: `npx tsc --noEmit`, then the proof script. If a step fails, report the exact error and END your turn; do not retry in a loop.
- Narrow job with an explicit end: write `docs/overnight/REPORT_<id>.md` (changed line ranges, exact command output, open issues), print the same report and END your turn. Do not wait, poll, loop, or re-read this order.