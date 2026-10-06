# Order R2-stuck-detector: flag a worker that is burning time without progress

## Why
Order fomuvs258c spent 8 minutes and about 147k tokens deliberating and never edited its file. Nobody noticed until it vanished. Fleet terminals are visible windows and are never killed by the system, so the answer is an early FLAG, not a kill.

## Files
`src/company/fleet.ts` (the watcher tick, small insertion), `src/company/stuck.ts` (new), `ops/stuck-check.ts` (new), `src/company/envReload.ts` (allow-list line).

## What to build
Env `FLEET_STUCK=1` turns it on (default off); `FLEET_STUCK_MINUTES` (default 8) and `FLEET_STUCK_TOKENS` (default 80000). `stuck.ts` exports a pure function `isStuck({startedAt, now, tokens, reportExists, ownedChanged, alreadyFlagged})` returning `{stuck, reason}`: stuck only when the work order is working, has run longer than the minutes limit OR spent more than the token limit, has no `REPORT.md`, and none of its owned files changed since it started (compare modified times; for an empty owned list use "no file in the repo changed"). In the watcher tick, for each working work order, call it (read the session token total from the same journal reader the tick already uses; if tokens cannot be read, use minutes only). When it returns stuck and the work order is not yet flagged: set `wo.stuck = true` and `wo.stuckReason`, add ONE trace step (`from: "Fleet"`, `to: "CEO"`, `what: "possibly stuck"`, detail with minutes, tokens and the reason in plain words), and call the existing webhook notifier if the module `src/company/notify.ts` exists (event name `stuck`, add it to the notifier's default event list only if that is a one-line change). Never kill, stop or message the worker. Clear the flag when a report appears or an owned file changes.

## Proof (`ops/stuck-check.ts`)
PASS or FAIL per line: not stuck before the limit; stuck after the minutes limit with no change; stuck by tokens; not stuck when an owned file changed; not stuck when a report exists; not flagged twice; off by default (the tick behaves as before); the reason text names minutes and tokens.
## Common rules
- Create or edit ONLY the files named in "Files". Other workers are not running at the same time, but keep edits small and targeted, never rewrite an entire existing file. Match the surrounding style (ES modules, `.js` import suffixes, no new dependencies).
- Never restart or start the router. Never read, print or edit `.env` or any secret value. Never touch `company/`, Laya, Kafka or scheduled tasks. No real network calls in tests (local stubs only). No deletes of existing files.
- Default OFF behind an env flag, so existing behaviour is byte-for-byte unchanged when the flag is unset. Add the new flag name(s) to the allow-list in `src/company/envReload.ts` (small insertion) so they can be reloaded without a restart.
- Run each command ONCE, in the foreground: `npx tsc --noEmit`, then the proof script. If a step fails, report the exact error and END your turn; do not retry in a loop.
- Narrow job with an explicit end: write `docs/overnight/REPORT_<id>.md` (changed line ranges, exact command output, open issues), print the same report and END your turn. Do not wait, poll, loop, or re-read this order.