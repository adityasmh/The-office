# Order F03-secret-scan: secret scanner plus git hooks, because AI-assisted commits leak keys

Open-source developer feature for the Laya fleet. Researched need: see docs/overnight/RESEARCH.md.

## Files
`ops/secret-scan.ts`, `ops/install-hooks.ts`, `ops/secret-scan-check.ts`

## What to build
1. `npx tsx ops/secret-scan.ts [--staged | --all | <paths>] [--json]`: scans for common secret shapes (OpenAI-style `sk-` keys, Slack `xox*` and `xapp-`, GitHub `ghp_`/`gho_`/`ghs_`/`github_pat_`, AWS `AKIA`, Google `AIza`, private key headers, and `KEY|TOKEN|SECRET|PASSWORD = <16 or more chars>` assignments in files that are not `*.example`). Output: file, line, rule name, and a MASKED value (first 4 characters only, never the full value). Exit 1 on any hit, 0 otherwise. Support an allow-list file `.secretscan-allow` (one regex or path glob per line, `#` comments). Skip binary files and `node_modules/`, `.git/`.
2. `npx tsx ops/install-hooks.ts [--uninstall] [--force]`: writes `.git/hooks/pre-commit` and `.git/hooks/pre-push` (POSIX shell scripts that also work in Git for Windows) that run `npx tsx ops/secret-scan.ts --staged`, each containing a marker comment. Never overwrite an existing hook without the marker unless `--force`; `--uninstall` removes only hooks that contain the marker.

## Proof (`ops/secret-scan-check.ts`, a temp git repo, fake secrets built from pieces at runtime so this file itself is not flagged)
PASS or FAIL per line: a staged fake key is detected and masked; an allow-listed one passes; a clean file passes; `.example` files are ignored for assignment rules; hooks install, are idempotent, refuse to clobber a foreign hook, and uninstall removes only ours.
## Common rules (apply to every step)
- Create or edit ONLY the files named in "Files". Edit nothing else. Other workers run at the same time on other files.
- Make changes with small targeted edits, never rewrite an entire existing file. Match the surrounding style (ES modules, `.js` import suffixes, no new dependencies, Node built-ins only).
- Never restart or start the router. Never read, print or edit `.env` or any secret value (tests use fake values and temp folders). Never touch `company/`, Laya, Kafka or scheduled tasks. No real network calls in tests (use local stubs). No deletes of existing files.
- Run each command ONCE, in the foreground. If a step fails, report the exact error and END your turn; do not retry in a loop.
- Narrow job with an explicit end: print the final report and END your turn. Do not wait, poll, loop, or re-read this order.
- Finish by writing `docs/overnight/REPORT_<id>.md` (changed files, exact command output of the proof, open issues) and printing the same report.