# Order F01-doctor: doctor: one command that tells a new developer what is missing

Open-source developer feature for the Laya fleet. Researched need: see docs/overnight/RESEARCH.md.

## Files
`ops/doctor.ts`, `ops/doctor-check.ts`

## What to build
`npx tsx ops/doctor.ts [--json]` prints one PASS, WARN or FAIL line per check, each FAIL/WARN with a one-line fix, and exits 1 if any FAIL. Checks: Node version (20 or newer), git installed, the `jcode` CLI found on PATH or at the default install path, `npx tsx` available, `.env` exists, every key NAME listed in `.env.example` is present in `.env` with a non-empty value (print names only, never values), ports 8787 and 8000 (report "free" or "in use"), optional GPU via `nvidia-smi` (WARN only, never FAIL), free RAM, free disk, and `company/` and `logs/` writable (create them if missing). `--json` prints a single valid JSON object `{checks:[{name,status,detail,fix}],ok}`. No network calls. Make probes injectable so the check can fake them.

## Proof (`ops/doctor-check.ts`)
PASS or FAIL per line: missing `.env` gives a FAIL with a fix text; a present key with an empty value is reported by name only; no fake secret value from the test appears anywhere in text or JSON output; `--json` output parses; absent GPU is WARN not FAIL; exit code is 1 on any FAIL and 0 otherwise.
## Common rules (apply to every step)
- Create or edit ONLY the files named in "Files". Edit nothing else. Other workers run at the same time on other files.
- Make changes with small targeted edits, never rewrite an entire existing file. Match the surrounding style (ES modules, `.js` import suffixes, no new dependencies, Node built-ins only).
- Never restart or start the router. Never read, print or edit `.env` or any secret value (tests use fake values and temp folders). Never touch `company/`, Laya, Kafka or scheduled tasks. No real network calls in tests (use local stubs). No deletes of existing files.
- Run each command ONCE, in the foreground. If a step fails, report the exact error and END your turn; do not retry in a loop.
- Narrow job with an explicit end: print the final report and END your turn. Do not wait, poll, loop, or re-read this order.
- Finish by writing `docs/overnight/REPORT_<id>.md` (changed files, exact command output of the proof, open issues) and printing the same report.