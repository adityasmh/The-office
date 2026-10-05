# GitHub integration for the fleet (scope only, nothing built yet)

Status: PROPOSED. Owner: manager scopes, workers build (narrow orders, guard wrapper, flash only).

## Goal
Make every fleet work order land as a reviewable GitHub pull request, so the existing PASS/REDO review is grounded in a real diff and real CI results instead of a report's claims.

## Today (verified 2026-10-05)
- The project folder is not a git repository and no code opens PRs, pushes or comments. Only GitHub-token redaction exists (memory.ts, terminalChat.ts).
- Review reads `REPORT.md` plus the work order's files. Slack gets the report-back; GitHub gets nothing.

## Flow
1. Work order reaches `reported` (REPORT.md written), as today.
2. Claude review returns PASS or REDO, as today.
3. On PASS only: create branch `fleet/<orderId>/<workOrderId>`, stage ONLY the paths in the work order's `owns`, commit, push.
4. Open a DRAFT pull request. Title = work order title. Body = REPORT.md + the review verdict + link to the order trace.
5. CI (optional GitHub Action: `npx tsc --noEmit` and the project's check scripts) runs on the PR. The review step reads the check result on the next tick; a red check downgrades PASS to REDO.
6. REDO: no PR is opened. If a PR already exists, the redo session pushes to the same branch and the PR updates.
7. All work orders PASS and checks green: one summary comment on the order's PRs and a Slack report-back with the PR links.
8. Merge stays human (the existing merge gate). The agent never merges.

## Safety rules
- Off by default: `FLEET_GITHUB=0`. `FLEET_GITHUB_DRY_RUN=1` logs every git/GitHub action without running it.
- Never force-push, never touch `main`, never `git add -A`; only the `owns` paths.
- Token from env (`GITHUB_TOKEN`), fine-grained, ONE repo, scopes contents:write + pull_requests:write only. Never printed, logged or written to disk (reuse the redaction in memory.ts).
- Refuse to run if the working folder is not a git repo with a remote.

## Work orders (each narrow, one end, no waiting)
- GH-1: `src/company/github.ts` + `ops/github-check.ts`. Functions: ensureRepo, branchFor, commitOwned, push, openDraftPr, readChecks. Proven in a temp repo with a local bare remote and dry-run. Owns only those two files.
- GH-2: hook into the fleet settle path and Slack report-back; add the CI-red downgrade; env flags. Owns the fleet hook lines only (coordinate with the fleet owner in AGENT_COORDINATION.md first).
- GH-3: `.github/workflows/fleet-check.yml` running tsc and the check scripts. Owns that file only.

## Acceptance
One real small order split across two workers produces two draft PRs from the right branches, each with the report as its description, a green or red check shown on it, and a Slack message with both links. Dry-run produces the same log with zero network writes.

## Needs from the CEO before building
1. Which repo (or confirm a new private repo), and that the folder may be turned into a git repo.
2. A fine-grained token for that one repo, set in `.env` by you (I will not handle it).

## Effort
Three small workers. GH-1 first; GH-2 and GH-3 after it passes its check.

Status 2026-10-06: GH-1 to GH-4 are built and the live pull request flow is enabled for adityasmh/The-office.
