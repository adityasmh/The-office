# Order F07-order-templates: order templates: well-formed orders that do not make workers loop

Open-source developer feature for the Laya fleet. Researched need: see docs/overnight/RESEARCH.md.

## Files
`orders/templates/add-docs-section.md`, `orders/templates/fix-small-bug.md`, `orders/templates/add-unit-check.md`, `orders/templates/small-refactor.md`, `orders/templates/update-readme-status.md`, `ops/new-order.ts`, `ops/new-order-check.ts`

## What to build
Five templates with `{{placeholders}}` (file path, what to change, acceptance check). Each states one narrow job with an explicit end ("print the final report and END your turn"), lists the single file the worker may edit, and contains no waiting, polling or "verify periodically" steps. `npx tsx ops/new-order.ts <template> --set key=value ... [--print | --out <file> | --post]`: fills placeholders, fails with a plain error naming any missing placeholder, and LINTS the result: reject text containing the words wait, poll, periodically, keep checking, or the three-letter prefix "hol" (case-insensitive), with the exact offending line. `--post` sends the order to `POST /company/fleet/orders` (same token handling as the fleet CLI: header only, never printed). Default is `--print`.

## Proof (`ops/new-order-check.ts`, temp folder, stub HTTP server for `--post`)
PASS or FAIL per line: every template renders with its placeholders; a missing placeholder errors by name; the lint rejects each banned word with its line number; a clean order passes; `--post` sends the right JSON with the token only in the header.
## Common rules (apply to every step)
- Create or edit ONLY the files named in "Files". Edit nothing else. Other workers run at the same time on other files.
- Make changes with small targeted edits, never rewrite an entire existing file. Match the surrounding style (ES modules, `.js` import suffixes, no new dependencies, Node built-ins only).
- Never restart or start the router. Never read, print or edit `.env` or any secret value (tests use fake values and temp folders). Never touch `company/`, Laya, Kafka or scheduled tasks. No real network calls in tests (use local stubs). No deletes of existing files.
- Run each command ONCE, in the foreground. If a step fails, report the exact error and END your turn; do not retry in a loop.
- Narrow job with an explicit end: print the final report and END your turn. Do not wait, poll, loop, or re-read this order.
- Finish by writing `docs/overnight/REPORT_<id>.md` (changed files, exact command output of the proof, open issues) and printing the same report.