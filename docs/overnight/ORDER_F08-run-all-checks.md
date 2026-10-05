# Order F08-run-all-checks: one command that runs every offline check, plus CI

Open-source developer feature for the Laya fleet. Researched need: see docs/overnight/RESEARCH.md.

## Files
`ops/run-all-checks.ts`, `ops/checks.manifest.json`, `.github/workflows/ci.yml`, `ops/run-all-checks-check.ts`

## What to build
A manifest listing every `ops/*-check.ts` and `ops/*-check.mjs` that exists today: `{name, command, network (true when the script itself makes real network calls: search the file for fetch( and https hosts and be conservative), timeoutSec}`. `npx tsx ops/run-all-checks.ts [--include-network] [--only name] [--manifest file]` runs them one at a time, prints a table (PASS, FAIL, TIMEOUT, SKIPPED-network) with seconds, shows the last 6 lines of any failure, and exits 1 on any FAIL or TIMEOUT. Never run a check that is marked `network` unless `--include-network`. `.github/workflows/ci.yml`: on push and pull_request, `ubuntu-latest`, Node 24 with npm cache, `npm ci`, `npx tsc --noEmit`, `npx tsx ops/run-all-checks.ts`, `permissions: contents: read`. Note in a comment that some checks assume Windows and list any that fail on Linux in the report instead of guessing.

## Proof (`ops/run-all-checks-check.ts`, a temp manifest of tiny dummy scripts)
PASS or FAIL per line: a passing script is PASS; a failing one is FAIL with its output tail and exit 1; a slow one hits TIMEOUT; a network-marked one is SKIPPED by default and runs with `--include-network`; `--only` filters; the real manifest parses and every command in it points at a file that exists.
## Common rules (apply to every step)
- Create or edit ONLY the files named in "Files". Edit nothing else. Other workers run at the same time on other files.
- Make changes with small targeted edits, never rewrite an entire existing file. Match the surrounding style (ES modules, `.js` import suffixes, no new dependencies, Node built-ins only).
- Never restart or start the router. Never read, print or edit `.env` or any secret value (tests use fake values and temp folders). Never touch `company/`, Laya, Kafka or scheduled tasks. No real network calls in tests (use local stubs). No deletes of existing files.
- Run each command ONCE, in the foreground. If a step fails, report the exact error and END your turn; do not retry in a loop.
- Narrow job with an explicit end: print the final report and END your turn. Do not wait, poll, loop, or re-read this order.
- Finish by writing `docs/overnight/REPORT_<id>.md` (changed files, exact command output of the proof, open issues) and printing the same report.