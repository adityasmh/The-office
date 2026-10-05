# Order CHEAPPLAN-OWNS: small orders must carry their owned files and a short brief

Narrow job. Do exactly these steps, print the final report, and END your turn. Do not wait, poll, loop, or re-read this order.

## Why (measured today, order fomuvs258c)
For a small order the planner builds ONE work order locally (`cheapPlan` in `src/company/fleet.ts`, search for `cheapPlan`). Its `owns` is empty and its brief still tells the worker to read `docs/AGENT_COORDINATION.md` and obey file ownership. That file is about 1 MB. The worker searched it for an ownership entry, found none, and spent 8 minutes and about 147k tokens deliberating instead of making a one-line edit; the session then closed with no change and no report. The brief must say exactly which files the worker may edit and must not send it into the coordination file.

## Rules
- Edit ONLY `src/company/fleet.ts` (inside `cheapPlan` and the brief text it builds, small targeted edits, never rewrite an entire file) and create `ops/fleet-cheapplan-check.ts`. Other workers edit `public/v2/views/terminals.js`, `src/server.ts`, `src/company/workersView.ts` and `ops/spawn-worker.ps1`: do NOT touch those.
- Never restart or start the router. Never touch `.env`, `company/`, Laya, Kafka, or scheduled tasks. No network calls in your tests. Do not print secrets.
- Run each command ONCE, in the foreground. If a step fails, report the exact error and END your turn; do not retry in a loop.
- Match the surrounding style (ES modules, `.js` import suffixes, no new dependencies).

## What to change
1. Add a small pure helper (export it for the check) `pathsNamedInOrder(text, repoDir)` that finds repo-relative file paths written in the order text (tokens that contain a `/` or end in a known extension: `.ts .js .mjs .md .json .ps1 .html .css .yml .yaml .txt .bat`), keeps only those that EXIST on disk inside `repoDir`, normalises to forward slashes, and removes anything that is absolute, contains `..`, is under `company/`, `logs/`, `node_modules/` or `.git/`, is named `.env` or `.env.*` (except `.env.example`), or ends in `.pem`, `.key`, `.log`, `.pid`. Cap at 10 paths, de-duplicated.
2. In `cheapPlan`, set the work order's `owns` to that list.
3. In the brief that `cheapPlan` builds: when `owns` is non-empty, state plainly "You may edit ONLY these files: <list>. Edit nothing else." and do NOT include any instruction to read `docs/AGENT_COORDINATION.md`; add one sentence "This is a small order: make the edit, write REPORT.md, and stop." When `owns` is empty, say "The order text names what to edit; there is no file ownership list for this order. Do not search docs/AGENT_COORDINATION.md." Keep the existing REPORT.md instructions and the rule that the worker must finish by writing the report with real command output.
4. Orders planned by the real Claude planner (not `cheapPlan`) are unchanged.

## Proof (`ops/fleet-cheapplan-check.ts`, temp repo dir and temp COMPANY_ROOT, no network)
Print PASS or FAIL per line:
- An order naming an existing file gets that file in `owns`; a path that does not exist is not included.
- `.env`, `company/x.json`, `../outside.txt` and an absolute path are removed even when they exist or are named.
- More than 10 qualifying paths returns exactly 10.
- The brief for an order with owned files contains the "ONLY these files" sentence and does NOT contain the text `AGENT_COORDINATION`.
- The brief for an order with no derivable files says there is no ownership list and does not tell the worker to read the coordination file.
- A planner-built (non-cheap) plan is unchanged (its brief still contains whatever it contained before: compare against a saved copy in the check).

## Finish
1. Run `npx tsc --noEmit` once.
2. Run `npx tsx ops/fleet-cheapplan-check.ts` once.
3. Write `docs/REPORT_2026-10-06_CHEAPPLAN-OWNS.md` with the changed line ranges, the exact output of the runs, and any open issue. Print the same report and END your turn.
