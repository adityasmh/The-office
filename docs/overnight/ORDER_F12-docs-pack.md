# Order F12-docs-pack: documentation so a stranger can clone, run and contribute

Open-source developers judge a project by its first ten minutes. Research (docs/overnight/RESEARCH.md) says they want a quickstart, a setup check, a clear architecture picture, safety notes and a list of good first issues.

## Files
`README.md`, `docs/QUICKSTART.md`, `docs/ARCHITECTURE.md`, `docs/FEATURES.md`, `docs/GOOD_FIRST_ISSUES.md`, `SECURITY.md`, `CONTRIBUTING.md`, `.github/ISSUE_TEMPLATE/bug_report.md`, `.github/ISSUE_TEMPLATE/feature_request.md`, `.github/pull_request_template.md`. Do NOT create a LICENSE file (the owner chooses it); say "see the repository's LICENSE" where a license is mentioned.

## Rule for every statement
Document ONLY what you verified by reading the code or the script header in this repository. Every command you write must be one whose file exists (check with a directory listing) and whose usage you read in its header comment. Never run any command that starts a server, sends a message, edits files, installs hooks or spends tokens. Where something does not work everywhere, say so plainly (for example: the real agents need the host's `jcode` command line tool and provider keys; Laya on GPU needs an NVIDIA card; the scripts were written and tested on Windows PowerShell). Do not invent a version number, a benchmark or a user count.

## What to write
- `README.md`: one paragraph on what the project is (a local multi-agent coding fleet: a manager plans, guarded workers execute, humans approve), a short "why" from RESEARCH.md, a 5-step quickstart (clone, `npx tsx ops/setup.ts`, `npx tsx ops/doctor.ts`, start the router the way the repo documents, open the dashboard), a table of the commands and what each does, the safety model (approval gates, worker guard, secret scan, policy file, OpenCode-first routing so credits are used only when quota runs out), a link to each doc, and an honest "Status and limits" section.
- `docs/QUICKSTART.md`: the same path in more detail, including mock mode, the dashboard URL, creating a first order from the dashboard and with `ops/fleet-cli.ts` and `ops/new-order.ts`, and reading the result with `ops/order-report.ts`.
- `docs/ARCHITECTURE.md`: a Mermaid flowchart of the pipeline (order, plan, approval gate, workers, review, publish to a pull request, report back) and one for the routing and budget logic, then a table of the main modules under `src/company/` with one verified line each.
- `docs/FEATURES.md`: a catalogue of the ten developer features from `docs/overnight/` (doctor, setup, secret scan and hooks, cost report, order report, fleet CLI, order templates, run-all-checks and CI, webhook notifications, policy file) plus Docker/devcontainer and the worktree design, each with its command, what it does, an example, and the report file that records how it was verified.
- `docs/GOOD_FIRST_ISSUES.md`: 12 small, concrete issues a newcomer can take, taken from `docs/FEATURE_IDEAS_2026-10-06.md`, the open issues in the `docs/overnight/REPORT_*.md` files, and the checks that currently fail in the offline suite (list them by name from `docs/overnight/` or by running nothing: read `ops/checks.manifest.json`). Each has a title, the files involved, and how to know it is done.
- `SECURITY.md`: how secrets are handled (never committed, `.env` ignored, scanner and hooks, the token is sent only in a header), how to report a problem privately (tell the reader to use GitHub's private vulnerability reporting for the repository, do not invent an email address), and what the agents are and are not allowed to touch (policy file, owned files, no deletes).
- `CONTRIBUTING.md`: setup, the doctor, running `npx tsx ops/run-all-checks.ts`, commit message style seen in `git log`, how to add a check, how to write an order that does not make workers loop (see `docs/WORKER_GUARD.md`), and the rule that agents never delete files.
- Issue and pull request templates: short, with the checkboxes "ran doctor", "ran the relevant check", "no secrets in the diff".

## Common rules
- Create ONLY the files listed. Edit nothing else. No deletes. Never read, print or edit `.env`. Never touch `company/`, Laya, Kafka or scheduled tasks. No network calls.
- Narrow job with an explicit end. Write `docs/overnight/REPORT_F12-docs-pack.md` (files written, and a list of every command you documented with the file you verified it against), print the same report and END your turn. Do not wait, poll, loop, or re-read this order.
