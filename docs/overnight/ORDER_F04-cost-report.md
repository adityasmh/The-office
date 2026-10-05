# Order F04-cost-report: cost report: where did the tokens and money go

Open-source developer feature for the Laya fleet. Researched need: see docs/overnight/RESEARCH.md.

## Files
`ops/cost-report.ts`, `ops/cost-report-check.ts`

## What to build
`npx tsx ops/cost-report.ts [--days N] [--by day|provider|model|worker] [--csv|--json]`: read-only. Reads `company/projects/*/cost.jsonl`, `logs/token-ledger.jsonl` and `logs/worker-providers.jsonl` (JSON lines; skip malformed lines). Prints a table with calls, turns, tokens when present, and cost, and ALWAYS separates prepaid credit spend (provider `deepseek`) from subscription or quota usage (`opencode-go`, Claude) in two blocks. A worker with no provider record is shown as "unknown provider". Add one warning line when credits were used on a day when quota was available (any day that also has opencode-go entries).

## Proof (`ops/cost-report-check.ts`, fixture files in a temp folder)
PASS or FAIL per line: the two blocks are separated; grouping by each option sums correctly; `--days` filters; malformed lines are skipped; CSV has a header and the right row count; JSON parses; empty folders print a friendly "no data" message and exit 0.
## Common rules (apply to every step)
- Create or edit ONLY the files named in "Files". Edit nothing else. Other workers run at the same time on other files.
- Make changes with small targeted edits, never rewrite an entire existing file. Match the surrounding style (ES modules, `.js` import suffixes, no new dependencies, Node built-ins only).
- Never restart or start the router. Never read, print or edit `.env` or any secret value (tests use fake values and temp folders). Never touch `company/`, Laya, Kafka or scheduled tasks. No real network calls in tests (use local stubs). No deletes of existing files.
- Run each command ONCE, in the foreground. If a step fails, report the exact error and END your turn; do not retry in a loop.
- Narrow job with an explicit end: print the final report and END your turn. Do not wait, poll, loop, or re-read this order.
- Finish by writing `docs/overnight/REPORT_<id>.md` (changed files, exact command output of the proof, open issues) and printing the same report.