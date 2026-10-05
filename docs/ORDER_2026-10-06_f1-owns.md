# Order F1-OWNS: auto-fill the owned files for the PR step

Narrow job. Do exactly these steps, print the final report, and END your turn. Do not wait, poll, loop, or re-read this order.

## Why
Small orders are planned locally and their work order has `owns: []`, so `publishWorkOrder` (in `src/company/fleetGithub.ts`) cannot know which files to commit. Today the CEO must set `owns` by hand at approval. Derive it automatically, safely.

## Rules
- Edit ONLY `src/company/fleetGithub.ts`, `src/company/github.ts`, `ops/fleet-github-check.ts` and `ops/github-check.ts`. Other workers are editing `src/company/fleet.ts`, `src/server.ts` and `public/v2/views/fleet.js` right now: do NOT touch those. Do NOT change the signature of any function that is already exported from `fleetGithub.ts` or `github.ts` (add new exports only).
- Make changes with small targeted edits, never rewrite an entire file.
- Never restart or start the router. Never touch `.env`, `company/`, Laya, Kafka, or scheduled tasks. No network calls and no real token in your tests (temp repo with a local bare remote). Do not print secrets.
- Run each command ONCE, in the foreground. If a step fails, report the exact error and END your turn; do not retry in a loop.
- Match the surrounding style (ES modules, `.js` import suffixes, no new dependencies).

## What to build
1. In `src/company/github.ts` add `changedPaths(dir)`: the repo-relative paths that currently differ from HEAD (modified, added or untracked, from `git status --porcelain`, one entry per file, forward slashes).
2. In `src/company/fleetGithub.ts` add `deriveOwns(workOrder, repoDir, reportText)` returning `{owns: string[], why: string}`. A path is owned only if BOTH are true: it appears in the changed paths from step 1, AND it is named in the work order's REPORT.md text (match the repo-relative path or its file name as a full word). Then REMOVE any path that is: outside the repo (contains `..` or is absolute), under `company/`, `logs/`, `node_modules/` or `.git/`, named `.env` or `.env.*` (except `.env.example`), or ends in `.pem`, `.key`, `.log`, `.pid`. Cap the list at 20 files; if more qualify, return an empty list with a `why` that says so.
3. In `publishWorkOrder`, when `workOrder.owns` is empty, call `deriveOwns` (read the report with the existing `readReport`). If the result is non-empty, use it for `commitOwned` and include the derived list in the log line and in the result as `derivedOwns`. If it is empty, return `{ skipped: <the why> }` as today (no failure). When `workOrder.owns` is already non-empty, behaviour is unchanged.
4. Dry-run must still change nothing: it may compute and log the derived list, but starts no git change.

## Proof (temp repo with a local bare remote, `FLEET_GITHUB=1`, `FLEET_GITHUB_DRY_RUN` unset, no token)
Add PASS or FAIL cases in `ops/fleet-github-check.ts` (and a `changedPaths` case in `ops/github-check.ts`):
- A file changed and named in the report is derived and committed; a file changed but NOT named in the report is left uncommitted.
- A file named in the report that did not change is not derived.
- `.env`, `company/x.json` and `../outside.txt` are removed even if changed and named.
- More than 20 qualifying files returns empty owns with the cap reason.
- Non-empty `owns` behaves exactly as before.
- Dry-run with empty owns logs the derived list and changes nothing.
Keep every earlier case passing.

## Finish
1. Run `npx tsc --noEmit` once.
2. Run `npx tsx ops/github-check.ts` once and `npx tsx ops/fleet-github-check.ts` once. Both must end with an all-pass line.
3. Write `docs/REPORT_2026-10-06_F1-OWNS.md` with the changed line ranges, the exact output of the runs, and any open issue. Print the same report and END your turn.
