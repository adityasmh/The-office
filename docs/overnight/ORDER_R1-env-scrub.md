# Order R1-env-scrub: fleet terminals must not inherit secrets

## Why
Fleet terminals are started by the router, so they inherit the router's environment, which contains the GitHub token, the company auth token and Slack tokens. A worker only needs to edit files. Anything in its environment can be printed, logged or leaked into a report.

## Files
`src/company/fleet.ts` (only the function that writes or runs the terminal launcher script, search for `launcherScript`), `src/company/scrubEnv.ts` (new), `ops/scrub-env-check.ts` (new), `src/company/envReload.ts` (allow-list line).

## What to build
`scrubEnv.ts` exports `scrubList()` and `launcherScrubLines(shell)`. Env `FLEET_SCRUB_ENV=1` turns it on (default off). The default deny-list: `GITHUB_TOKEN`, `COMPANY_AUTH_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET`, `NOTIFY_WEBHOOK_URL`, plus any name matching `*_SECRET`, `*_PASSWORD`; extra names from env `FLEET_SCRUB_EXTRA` (comma list). It must NOT include provider keys the `jcode` command line tool may need to start (`DEEPSEEK_API_KEY`, anything starting with `OPENCODE`, `ANTHROPIC`, `CLAUDE`, `LAYA`): leave those alone and say so in a comment. `launcherScrubLines` returns the PowerShell lines that blank each denied variable that exists, inserted at the top of the generated launcher script before `jcode` starts, and printing only the NAMES that were cleared. Logs and traces show names only, never values.

## Proof (`ops/scrub-env-check.ts`)
PASS or FAIL per line: off by default (the launcher text is identical to before); on, the launcher clears `GITHUB_TOKEN` and `COMPANY_AUTH_TOKEN` and a `*_SECRET` name; provider keys are never in the list; `FLEET_SCRUB_EXTRA` adds names; the generated lines contain no value from a fake environment used in the test; running the generated lines in a child PowerShell with fake values set really leaves those variables empty while a provider-style variable survives.
## Common rules
- Create or edit ONLY the files named in "Files". Other workers are not running at the same time, but keep edits small and targeted, never rewrite an entire existing file. Match the surrounding style (ES modules, `.js` import suffixes, no new dependencies).
- Never restart or start the router. Never read, print or edit `.env` or any secret value. Never touch `company/`, Laya, Kafka or scheduled tasks. No real network calls in tests (local stubs only). No deletes of existing files.
- Default OFF behind an env flag, so existing behaviour is byte-for-byte unchanged when the flag is unset. Add the new flag name(s) to the allow-list in `src/company/envReload.ts` (small insertion) so they can be reloaded without a restart.
- Run each command ONCE, in the foreground: `npx tsc --noEmit`, then the proof script. If a step fails, report the exact error and END your turn; do not retry in a loop.
- Narrow job with an explicit end: write `docs/overnight/REPORT_<id>.md` (changed line ranges, exact command output, open issues), print the same report and END your turn. Do not wait, poll, loop, or re-read this order.