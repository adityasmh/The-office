# Order F05-order-report: order report: a shareable post-mortem of any fleet order

Open-source developer feature for the Laya fleet. Researched need: see docs/overnight/RESEARCH.md.

## Files
`ops/order-report.ts`, `ops/order-report-check.ts`

## What to build
`npx tsx ops/order-report.ts <orderId> [--html] [--out <file>]`: read-only. Reads `company/fleet/orders.json` and each work order's `REPORT.md`. Produces Markdown (default, to stdout or `--out`): a summary (order text, status, duration, number of work orders and verdicts), a timeline table built from `order.trace` (time, from, to, what), then per work order: title, owned files, verdict, the review text trimmed to 600 characters, branch, PR link, CI state. `--html` produces one self-contained HTML file with the same content and no external assets. Redact any token-shaped string. Unknown order id: plain error, exit 1.

## Proof (`ops/order-report-check.ts`, fixture orders file and reports in a temp folder)
PASS or FAIL per line: markdown has all sections; the timeline is chronological; a missing REPORT.md is shown as "no report" without a crash; HTML is self-contained; a fake token in a review is redacted; an unknown id exits 1.
## Common rules (apply to every step)
- Create or edit ONLY the files named in "Files". Edit nothing else. Other workers run at the same time on other files.
- Make changes with small targeted edits, never rewrite an entire existing file. Match the surrounding style (ES modules, `.js` import suffixes, no new dependencies, Node built-ins only).
- Never restart or start the router. Never read, print or edit `.env` or any secret value (tests use fake values and temp folders). Never touch `company/`, Laya, Kafka or scheduled tasks. No real network calls in tests (use local stubs). No deletes of existing files.
- Run each command ONCE, in the foreground. If a step fails, report the exact error and END your turn; do not retry in a loop.
- Narrow job with an explicit end: print the final report and END your turn. Do not wait, poll, loop, or re-read this order.
- Finish by writing `docs/overnight/REPORT_<id>.md` (changed files, exact command output of the proof, open issues) and printing the same report.