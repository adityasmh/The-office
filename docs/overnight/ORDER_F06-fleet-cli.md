# Order F06-fleet-cli: fleet command line client, so developers do not need the dashboard

Open-source developer feature for the Laya fleet. Researched need: see docs/overnight/RESEARCH.md.

## Files
`ops/fleet-cli.ts`, `ops/fleet-cli-check.ts`

## What to build
`npx tsx ops/fleet-cli.ts <command>`: `status` (health, Laya, routing policy line, running sessions), `orders [--status X]`, `show <id>`, `new "<text>" [--auto-approve]`, `approve <id>`, `cancel <id>`, `workers`, `tail <worker> [--lines N]`. Base URL from env `FLEET_URL` (default `http://127.0.0.1:8787`). The auth token for mutating calls comes from env `COMPANY_AUTH_TOKEN` or, if unset, from `.env` read only inside this tool; it is sent only in the `x-company-token` header on POST calls and NEVER printed or logged. Plain aligned tables, `--json` for raw output, exit 1 on any HTTP error with a plain-words message (401 explains the token, 503 explains a paused company).

## Proof (`ops/fleet-cli-check.ts`, a local stub HTTP server on a free port)
PASS or FAIL per line: GET calls send no token and POST calls send it; each command prints the expected rows from the stub; the token value never appears in output; a 401 and a 503 give the plain messages; `--json` parses; an unknown command prints usage and exits 1.
## Common rules (apply to every step)
- Create or edit ONLY the files named in "Files". Edit nothing else. Other workers run at the same time on other files.
- Make changes with small targeted edits, never rewrite an entire existing file. Match the surrounding style (ES modules, `.js` import suffixes, no new dependencies, Node built-ins only).
- Never restart or start the router. Never read, print or edit `.env` or any secret value (tests use fake values and temp folders). Never touch `company/`, Laya, Kafka or scheduled tasks. No real network calls in tests (use local stubs). No deletes of existing files.
- Run each command ONCE, in the foreground. If a step fails, report the exact error and END your turn; do not retry in a loop.
- Narrow job with an explicit end: print the final report and END your turn. Do not wait, poll, loop, or re-read this order.
- Finish by writing `docs/overnight/REPORT_<id>.md` (changed files, exact command output of the proof, open issues) and printing the same report.