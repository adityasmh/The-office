# Order F02-setup: setup: first-run wizard that creates a safe .env

Open-source developer feature for the Laya fleet. Researched need: see docs/overnight/RESEARCH.md.

## Files
`ops/setup.ts`, `ops/setup-check.ts`

## What to build
`npx tsx ops/setup.ts [--dir <path>] [--live] [--force]`: if `.env` is missing, copy `.env.example` to `.env`; set `MOCK_MODE=1` unless `--live` is given (so a first run costs nothing); if `COMPANY_AUTH_TOKEN` is empty or a template field, fill it with a random 32-byte hex value from `node:crypto`; create `company/` and `logs/` if missing. NEVER overwrite an existing `.env` unless `--force`, and then write `.env.bak` first. Never print any secret value; print only what was done and the next steps (run the doctor, start the server, open the dashboard URL). `--dir` lets tests run in a temp folder.

## Proof (`ops/setup-check.ts`, temp folders only)
PASS or FAIL per line: creates `.env` from the example; sets MOCK_MODE=1 by default and not with `--live`; generates a token of the right length and never prints it; refuses to overwrite an existing `.env`; `--force` writes `.env.bak` first; creates the two folders; running twice is safe.
## Common rules (apply to every step)
- Create or edit ONLY the files named in "Files". Edit nothing else. Other workers run at the same time on other files.
- Make changes with small targeted edits, never rewrite an entire existing file. Match the surrounding style (ES modules, `.js` import suffixes, no new dependencies, Node built-ins only).
- Never restart or start the router. Never read, print or edit `.env` or any secret value (tests use fake values and temp folders). Never touch `company/`, Laya, Kafka or scheduled tasks. No real network calls in tests (use local stubs). No deletes of existing files.
- Run each command ONCE, in the foreground. If a step fails, report the exact error and END your turn; do not retry in a loop.
- Narrow job with an explicit end: print the final report and END your turn. Do not wait, poll, loop, or re-read this order.
- Finish by writing `docs/overnight/REPORT_<id>.md` (changed files, exact command output of the proof, open issues) and printing the same report.