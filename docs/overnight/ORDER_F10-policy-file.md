# Order F10-policy-file: policy file: protected paths agents may never change

Open-source developer feature for the Laya fleet. Researched need: see docs/overnight/RESEARCH.md.

## Files
`policy.example.json`, `src/company/policy.ts`, `ops/policy-check.ts`; small insertions in `src/company/fleetGithub.ts` (the owned-file derivation and the publish step) and `src/company/fleet.ts` (only inside `pathsNamedInOrder` / `cheapPlan`, if those exist; otherwise only fleetGithub.ts).

## What to build
A JSON policy (`policy.json` if present, else built-in defaults, example in `policy.example.json`): `{ "protectedPaths": [globs], "maxFilesPerWorkOrder": number }`. Built-in defaults protect `.env*` (except `.env.example`), `.github/workflows/**`, `.git/**`, `policy.json`, `*.pem`, `*.key`. `src/company/policy.ts` exports `loadPolicy()` and `isProtected(path)` (forward-slash, case-insensitive, supports `*`, `**`, `?`). Enforcement: (1) owned-file derivation and the cheap plan drop protected paths; (2) the publish step REFUSES to commit when any staged path is protected or the count exceeds `maxFilesPerWorkOrder`, with a plain reason that names the path and the rule. A work order that edits CI files must therefore stop at the human.

## Proof (`ops/policy-check.ts`, temp repo)
PASS or FAIL per line: defaults protect `.env`, `.github/workflows/ci.yml`, `.git/config`, `a.pem` but not `.env.example` or `src/a.ts`; glob forms behave; a custom `policy.json` overrides; derivation drops protected paths; publish refuses a protected staged path with the named reason; the file-count limit refuses; a malformed policy file falls back to defaults with a warning.
## Common rules (apply to every step)
- Create or edit ONLY the files named in "Files". Edit nothing else. Other workers run at the same time on other files.
- Make changes with small targeted edits, never rewrite an entire existing file. Match the surrounding style (ES modules, `.js` import suffixes, no new dependencies, Node built-ins only).
- Never restart or start the router. Never read, print or edit `.env` or any secret value (tests use fake values and temp folders). Never touch `company/`, Laya, Kafka or scheduled tasks. No real network calls in tests (use local stubs). No deletes of existing files.
- Run each command ONCE, in the foreground. If a step fails, report the exact error and END your turn; do not retry in a loop.
- Narrow job with an explicit end: print the final report and END your turn. Do not wait, poll, loop, or re-read this order.
- Finish by writing `docs/overnight/REPORT_<id>.md` (changed files, exact command output of the proof, open issues) and printing the same report.