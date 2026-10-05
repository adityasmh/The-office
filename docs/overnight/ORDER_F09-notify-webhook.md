# Order F09-notify-webhook: notifications to any webhook (Discord, Slack, ntfy), not only the Slack bridge

Open-source developer feature for the Laya fleet. Researched need: see docs/overnight/RESEARCH.md.

## Files
`src/company/notify.ts`, `ops/notify-check.ts`; small insertions in `src/company/fleet.ts` (where an order becomes done or failed, and where it becomes awaiting approval) and in `src/company/envReload.ts` (add the new key names to its allow-list). Edit nothing else in those two files.

## What to build
`notify(event, order)` in `src/company/notify.ts`: env `NOTIFY_WEBHOOK_URL` (unset means the feature is off and nothing happens), `NOTIFY_FORMAT` = `json` (default), `slack`, `discord` or `ntfy`, `NOTIFY_EVENTS` (comma list, default `done,failed,awaiting_approval`), `NOTIFY_DRY_RUN=1` logs the payload without sending. The payload is short: order id, first 120 characters of the order text, status, and PR links when present; it never contains report text, file contents or any env value. Send with `fetch`, a 5 second timeout, never throw, de-duplicate per (order id, event) for the life of the process, and never log the webhook URL (log only its host). Wire it into `fleet.ts` with one guarded call at each of the three moments (inside try/catch, never able to change an order's state). Add `NOTIFY_WEBHOOK_URL`, `NOTIFY_FORMAT`, `NOTIFY_EVENTS`, `NOTIFY_DRY_RUN` to the env reload allow-list.

## Proof (`ops/notify-check.ts`, a local stub HTTP server)
PASS or FAIL per line: off when the URL is unset; the four formats produce the right body shape; events outside `NOTIFY_EVENTS` are skipped; a second identical event is de-duplicated; a stub that returns 500 or hangs does not throw; dry-run sends nothing; the payload has no env value and the URL never appears in logs.
## Common rules (apply to every step)
- Create or edit ONLY the files named in "Files". Edit nothing else. Other workers run at the same time on other files.
- Make changes with small targeted edits, never rewrite an entire existing file. Match the surrounding style (ES modules, `.js` import suffixes, no new dependencies, Node built-ins only).
- Never restart or start the router. Never read, print or edit `.env` or any secret value (tests use fake values and temp folders). Never touch `company/`, Laya, Kafka or scheduled tasks. No real network calls in tests (use local stubs). No deletes of existing files.
- Run each command ONCE, in the foreground. If a step fails, report the exact error and END your turn; do not retry in a loop.
- Narrow job with an explicit end: print the final report and END your turn. Do not wait, poll, loop, or re-read this order.
- Finish by writing `docs/overnight/REPORT_<id>.md` (changed files, exact command output of the proof, open issues) and printing the same report.