# REPORT F12-docs-pack: documentation so a stranger can clone, run and contribute

Date: 2026-10-06. Order: `docs/overnight/ORDER_F12-docs-pack.md`.

Status: DONE. All ten files in the order's Files list were created. Nothing else was created or
edited. No file was deleted. No LICENSE file was created; the docs say "see the repository's
LICENSE" where a licence is mentioned. `.env` was never read, printed or edited. Laya, Kafka,
`company/`, scheduled tasks and the network were not touched. No server was started, no message
was sent and no token was spent.

## Files written

| File | What is in it |
|---|---|
| `README.md` | What the project is, the "why" from `docs/overnight/RESEARCH.md`, a 5-step quickstart, the command table, the safety model, links to every doc, and a "Status and limits" section. |
| `docs/QUICKSTART.md` | The same path in detail: prerequisites, setup, doctor, starting the router, the dashboard URLs, mock mode, creating a first order from the dashboard and with `ops/fleet-cli.ts` and `ops/new-order.ts`, and reading the result with `ops/order-report.ts`. |
| `docs/ARCHITECTURE.md` | A Mermaid flowchart of the order pipeline and a Mermaid flowchart of the routing and budget logic, then a table of the main `src/company/` modules with one verified line each. |
| `docs/FEATURES.md` | The catalogue: setup, doctor, secret scan and hooks, cost report, order report, fleet CLI, order templates, run-all-checks and CI, webhook notifications, policy file, Docker/devcontainer and the worktree design, each with its command, what it does, an example and the report that verified it. |
| `docs/GOOD_FIRST_ISSUES.md` | Twelve small issues with the files involved and a "done when" line, drawn from `docs/FEATURE_IDEAS_2026-10-06.md`, the open issues in the `docs/overnight/REPORT_*.md` files, and the offline suite (`ops/checks.manifest.json`). |
| `SECURITY.md` | How secrets are handled (never committed, `.env` ignored, scanner and hooks, token only in a header, no values in reports or logs), how to report privately (GitHub private vulnerability reporting), the trust boundary, and what agents may and may not touch. |
| `CONTRIBUTING.md` | Setup, the doctor, running `npx tsx ops/run-all-checks.ts`, commit message style from `git log`, how to add a check, how to write an order that does not make a worker loop, and the "agents never delete files" rule. |
| `.github/ISSUE_TEMPLATE/bug_report.md` | Short bug template with the "ran doctor", "ran the relevant check" and "no secrets" checkboxes. |
| `.github/ISSUE_TEMPLATE/feature_request.md` | Short feature template with the same checkboxes. |
| `.github/pull_request_template.md` | Short PR template with the "ran doctor", "ran the relevant check", "no secrets in the diff" and "no files deleted" checkboxes. |

## Every documented command, and the file it was verified against

Each command was checked against the file that implements it: the file exists in a directory
listing (`dir /b`, `dir /b ops`, `dir /b orders\templates`, `dir /b public`) and its usage was
read in that file's header comment. No documented command was executed (the order forbids
starting servers, sending messages, editing files, installing hooks or spending tokens).

| Command as documented | Verified against |
|---|---|
| `npx tsx ops/setup.ts [--live] [--dir <path>] [--force]` | `ops/setup.ts` header (lines 1-20) |
| `npx tsx ops/doctor.ts [--json]` | `ops/doctor.ts` header (lines 1-15) |
| `npx tsx ops/secret-scan.ts [--staged\|--all\|<paths>] [--json]` | `ops/secret-scan.ts` header (lines 1-16) |
| `npx tsx ops/install-hooks.ts [--uninstall] [--force]` | `ops/install-hooks.ts` header (lines 1-15) |
| `npx tsx ops/cost-report.ts [--days N] [--by day\|provider\|model\|worker] [--csv\|--json]` | `ops/cost-report.ts` header (lines 1-29) |
| `npx tsx ops/order-report.ts <orderId> [--html] [--out <file>]` | `ops/order-report.ts` header (lines 1-23) |
| `npx tsx ops/fleet-cli.ts status \| orders \| show <id> \| new "<text>" \| approve <id> \| cancel <id> \| workers \| tail <worker>` | `ops/fleet-cli.ts` header (lines 1-24) |
| `npx tsx ops/new-order.ts <template> --set key=value ... [--print\|--out <file>\|--post]` | `ops/new-order.ts` header (lines 1-18) |
| `npx tsx ops/run-all-checks.ts [--include-network] [--only name] [--manifest file]` | `ops/run-all-checks.ts` header (lines 1-24) |
| `npx tsx ops/policy-check.ts` | `ops/policy-check.ts` header (lines 1-15) |
| `npx tsx ops/notify-check.ts` | `ops/notify-check.ts` header (lines 1-13) |
| `docker compose up --build`, `docker compose ps` | `docker-compose.yml` header (lines 1-6) and `docs/overnight/REPORT_F11-docker.md` |
| `npm install` | `package.json` (dependencies and devDependencies) |
| `npm run dev` (`tsx src/server.ts`), `npm run build` (`tsc -p tsconfig.json`), `npm start` (`node dist/server.js`), `npm run typecheck` (`tsc --noEmit`) | `package.json` `scripts` |
| `npx tsc --noEmit` | `package.json` `scripts.typecheck` and `.github/workflows/ci.yml` |
| `powershell -NoProfile -ExecutionPolicy Bypass -File ops\run-server-detached.ps1 [-Port 8787] [-Stop] [-Status] [-NoTask] [-Uninstall] [-TimeoutSec 180]` | `ops/run-server-detached.ps1` header (lines 1-20) |
| `powershell -NoProfile -ExecutionPolicy Bypass -File ops\start-company.ps1 [-Quiet] [-NoBrowser] [-NoWatch] [-TimeoutSec N] [-Root path]` | `ops/start-company.ps1` header (lines 1-22) |
| `powershell -NoProfile -ExecutionPolicy Bypass -File ops\worker-guard-check.ps1` | `docs/WORKER_GUARD.md` ("Self-test") and `ops/worker-guard-check.ps1` exists |
| `ops\spawn-worker.ps1 -Name x -OrderFile docs\ORDER_x.md [-MaxMinutes 15 -MaxUsd 0.30]` | `docs/WORKER_GUARD.md` and `ops/spawn-worker.ps1` header (lines 1-21) |

### Proof-harness commands named in `docs/FEATURES.md` and `docs/GOOD_FIRST_ISSUES.md`

These are documented as the commands the feature authors ran, and each is quoted from the
matching overnight report and its file exists in the `ops/` listing: `ops/setup-check.ts`,
`ops/doctor-check.ts`, `ops/secret-scan-check.ts`, `ops/cost-report-check.ts`,
`ops/order-report-check.ts`, `ops/fleet-cli-check.ts`, `ops/new-order-check.ts`,
`ops/run-all-checks-check.ts`. The `ops/policy-check.ts` and `ops/notify-check.ts` proof files
were read directly.

## Facts stated in the docs, and where each one was verified

- The router and dashboard run from `npm run dev` (package.json) on `PORT` 8787 with
  `HOST=127.0.0.1` (`src/config.ts`, `.env.example`).
- The dashboard is `public/` served statically at the router root
  (`app.use(express.static(path.join(process.cwd(), "public")))` in `src/server.ts`), the Fleet
  view is `#/fleet` in `public/v2/views/fleet.js`, and `/health` is the health route
  (`docs/CEO_RUNBOOK.md` section 0).
- Mock mode is `MOCK_MODE=1` and is answered by `src/mock.ts` ("Deterministic mocks so the
  internal tool runs without spending budget").
- Order and work-order states, the approval gate, the watcher interval, the PASS-downgrade rule
  and the settle behaviour come from `docs/FLEET_OPERATOR_GUIDE.md` and `src/company/fleet.ts`.
- The safety model comes from `src/company/authguard.ts` (loopback plus constant-time
  `x-company-token`), `src/company/policy.ts` (defaults and the cap), `ops/secret-scan.ts` and
  `ops/install-hooks.ts`, `docs/WORKER_GUARD.md`, and `src/company/deepseekDirect.ts`
  ("quota healthy (>= 10%) -> OpenCode Go, at ANY hour").
- The routing and budget diagram comes from `src/company/brainRouter.ts`,
  `src/company/budgetGuard.ts`, `src/company/deepseekDirect.ts` and `src/company/offpeak.ts`.
- The `src/company/` module table comes from each module's own header comment.
- Commit message style examples were copied verbatim from `git log --oneline -25`.
- The 56 check names in `docs/GOOD_FIRST_ISSUES.md` and `docs/FEATURES.md` were read from
  `ops/checks.manifest.json` (`findstr /C:"\"name\"" ops\checks.manifest.json`).
- The failing or limited checks named in the docs (`resume-view` and `ui-assistant` pinning a
  Chrome path, CI expected red, the worker-guard fragmented-thought fixture, the Docker image
  never built, the worktree design not implemented, the doctor's `.env keys` FAIL) are quoted
  from `docs/overnight/REPORT_F01-doctor.md`, `REPORT_F03-secret-scan.md`,
  `REPORT_F04-cost-report.md`, `REPORT_F05-order-report.md`, `REPORT_F08-run-all-checks.md`,
  `REPORT_F11-docker.md`, `REPORT_F13-worktree-spec.md` and `docs/WORKER_GUARD.md`.

## Open issues / honest notes

- The order's list of features to catalogue names ten, then adds Docker and the worktree design,
  so `docs/FEATURES.md` has 12 numbered entries.
- No command in this pack was executed. Every statement is either read from a header comment, a
  report, or the module source. Where a feature's own report says something was not verified
  (the Docker image was never built, the hooks were never executed end to end, `--post` was only
  proven against a stub, the worktree has no code), the doc says so in the same words.
- Two commands that the repository documents elsewhere are deliberately absent: the Slack and
  Kafka operational paths, because they are outside the ten features and would need a live
  service to state honestly.
- No version number, benchmark or user count was invented. The README says the package is
  `private` and that there is no release process, which is what `package.json` shows.
- `docs/GOOD_FIRST_ISSUES.md` ends with two extra recorded items (branch hygiene and filling
  `.env` keys on the authoring machine) after the twelve numbered issues.
