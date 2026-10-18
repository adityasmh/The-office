# Features

The evening feature set from `docs/overnight/`, one entry per feature. Every command is a file
in this repository, and every example is checked against that file's header. Each entry ends
with the report that records how the feature was verified.

The research that motivated the set is in `docs/overnight/RESEARCH.md` (a secret leak in
AI-assisted commits, invisible token spend in agent loops, parallel agents overwriting each
other, and the wish for one-command setup, a doctor, a dev container and a readable trace).

## 1. Setup wizard (F02)

- **Command:** `npx tsx ops/setup.ts [--live] [--dir <path>] [--force]`
- **What it does:** copies `.env.example` to `.env` if it is missing, sets `MOCK_MODE=1` by
  default (`0` with `--live`) so a first run costs nothing, fills an empty or placeholder
  `COMPANY_AUTH_TOKEN` with 32 random bytes as hex, and creates `company/` and `logs/`. It never
  overwrites an existing `.env` without `--force`, and with `--force` it copies the old file to
  `.env.bak` first. It prints what it did, never a value from `.env`.
- **Example:** `npx tsx ops/setup.ts` then look at the printed next steps.
- **Verified by:** `docs/overnight/REPORT_F02-setup.md` (proof harness `ops/setup-check.ts`, all
  checks pass, temp folders only).

## 2. Doctor (F01)

- **Command:** `npx tsx ops/doctor.ts [--json]`
- **What it does:** one `PASS`/`WARN`/`FAIL` line per check, each non-PASS line with a one-line
  fix. Checks Node 20+, git, the `jcode` CLI, `npx tsx`, that `.env` exists, that every key NAME
  in `.env.example` is set non-empty in `.env`, ports 8787 and 8000, an NVIDIA GPU via
  `nvidia-smi`, free RAM and free disk. Exits 1 if any check FAILs.
- **Example:** `npx tsx ops/doctor.ts --json` prints one object `{checks:[...],ok}`.
- **Verified by:** `docs/overnight/REPORT_F01-doctor.md` (proof harness `ops/doctor-check.ts`).
  Open issue recorded there: on the authoring machine the real run ends `ok=false` because some
  `.env` keys are missing or empty. Names are printed, values never are.

## 3. Secret scan and git hooks (F03)

- **Command:** `npx tsx ops/secret-scan.ts [--staged] [--all] [<paths>] [--json]` and
  `npx tsx ops/install-hooks.ts [--uninstall] [--force]`
- **What it does:** scans for secret-shaped strings (OpenAI `sk-`, Slack `xox*`/`xapp-`, GitHub
  `ghp_`/`gho_`/`ghs_`/`ghr_`/`github_pat_`, AWS `AKIA`, Google `AIza`, private-key headers and
  16+ character `KEY|TOKEN|SECRET|PASSWORD` assignments, skipped in `*.example`). Each hit
  prints file, line, rule and a 4-character mask, never the value. `--staged` reads the git
  index. Exit 1 on a hit, 0 clean, 2 for a usage error. `.secretscan-allow` holds allowed path
  globs or value regexes. `install-hooks.ts` writes `.git/hooks/pre-commit` and `pre-push` that
  run the scanner on staged files, refuses to clobber a foreign hook without `--force`, and
  `--uninstall` removes only hooks carrying its marker.
- **Example:**

  ```
  npx tsx ops/install-hooks.ts
  npx tsx ops/secret-scan.ts --staged
  npx tsx ops/secret-scan.ts --all --json
  ```

- **Verified by:** `docs/overnight/REPORT_F03-secret-scan.md` (proof harness
  `ops/secret-scan-check.ts`). Open issue: the hook's `npx tsx` line was verified by content,
  not executed end to end.

## 4. Cost report (F04)

- **Command:** `npx tsx ops/cost-report.ts [--days N] [--by day|provider|model|worker] [--csv|--json]`
- **What it does:** read-only report from `company/projects/*/cost.jsonl`,
  `logs/token-ledger.jsonl` and `logs/worker-providers.jsonl`. The output is always split into
  `Prepaid credits (deepseek)`, `Subscription / quota (opencode-go, claude, others)` and an
  `unknown provider` block for workers with no provider record. It prints one warning when
  prepaid credits were spent on a day that also had `opencode-go` entries. Malformed lines are
  skipped and counted. Nothing is written, no process is started, no network call is made.
- **Example:** `npx tsx ops/cost-report.ts --days 7 --by provider --csv`
- **Verified by:** `docs/overnight/REPORT_F04-cost-report.md` (proof harness
  `ops/cost-report-check.ts`).

## 5. Order report (F05)

- **Command:** `npx tsx ops/order-report.ts <orderId> [--html] [--out <file>]`
- **What it does:** read-only post-mortem for one fleet order. Reads
  `company/fleet/orders.json` and each work order's `REPORT.md`. Content: a summary (order text,
  status, created/updated/closed, duration, work-order count, PASS/REDO counts, reports found,
  redaction count), a timeline built from the order trace and sorted chronologically, then per
  work order the title, role, state, owned files, verdict, a review trimmed to 600 characters,
  branch, PR link, CI state and the report (or `no report`). Every token-shaped string is
  redacted in both Markdown and HTML. `--html` writes one self-contained file, no external
  assets.
- **Example:** `npx tsx ops/order-report.ts <orderId> --html --out order.html`
- **Verified by:** `docs/overnight/REPORT_F05-order-report.md` (proof harness
  `ops/order-report-check.ts`).

## 6. Fleet CLI (F06)

- **Command:** `npx tsx ops/fleet-cli.ts status | orders [--status X] | show <id> | new "<text>" [--auto-approve] | approve <id> | cancel <id> | workers | tail <worker> [--lines N]`
- **What it does:** the fleet HTTP API from a terminal. Base URL `$FLEET_URL` (default
  `http://127.0.0.1:8787`). The token is read from `$COMPANY_AUTH_TOKEN`, or from
  `COMPANY_AUTH_TOKEN` in `.env` only inside the tool. It is sent only in the `x-company-token`
  header on POST calls and is never printed. `--json` works on every command. A 401 explains the
  token, a 503 explains a paused company, network failures name the base URL.
- **Example:**

  ```
  npx tsx ops/fleet-cli.ts status
  npx tsx ops/fleet-cli.ts new "Add a short setup section to docs/FEATURES.md"
  npx tsx ops/fleet-cli.ts approve <orderId>
  ```

- **Verified by:** `docs/overnight/REPORT_F06-fleet-cli.md` (proof harness
  `ops/fleet-cli-check.ts`, a stub HTTP server on loopback; no live order was created).

## 7. Order templates (F07)

- **Command:** `npx tsx ops/new-order.ts <template> --set key=value ... [--print | --out <file> | --post]`
- **What it does:** renders one of `orders/templates/add-docs-section.md`,
  `fix-small-bug.md`, `add-unit-check.md`, `small-refactor.md` or `update-readme-status.md`.
  Each template states one job, names the single file the worker may edit, gives an acceptance
  check and ends with an explicit end-of-turn line. A missing field is a plain error that names
  the field. The rendered order is linted and rejected if it tells a worker to wait, poll, keep
  checking or stall, and the error names the offending line. `--post` sends the order to
  `POST /company/fleet/orders` with the token only in the `x-company-token` header.
- **Example:**

  ```
  npx tsx ops/new-order.ts fix-small-bug \
    --set file=src/config.ts \
    --set change="Treat an empty PORT as unset" \
    --set check="npm run typecheck passes"
  ```

- **Verified by:** `docs/overnight/REPORT_F07-order-templates.md` (proof harness
  `ops/new-order-check.ts`; `--post` was proven against a local stub only).

## 8. Run-all-checks and CI (F08)

- **Command:** `npx tsx ops/run-all-checks.ts [--include-network] [--only name] [--manifest file]`
- **What it does:** runs every check in `ops/checks.manifest.json` one at a time in the
  foreground, killing the whole process tree on timeout. It prints a table with `PASS`, `FAIL`,
  `TIMEOUT` or `SKIPPED-network` and seconds per check, prints the last 6 output lines of each
  failure, and exits 1 on any FAIL or TIMEOUT (2 for bad usage). Entries with `"network": true`
  are never executed without `--include-network`. The manifest has 56 entries. The CI workflow
  `.github/workflows/ci.yml` runs on push and pull request with Node 24: `npm ci`,
  `npx tsc --noEmit`, then the runner.
- **Example:** `npx tsx ops/run-all-checks.ts --only fleet`
- **Verified by:** `docs/overnight/REPORT_F08-run-all-checks.md` (proof harness
  `ops/run-all-checks-check.ts`). Recorded limits: Linux was never observed, CI deliberately
  stays red until the fleet is portable, and `resume-view` and `ui-assistant` hard-code a
  Windows Chrome path.

## 9. Webhook notifications (F09)

- **Command:** no CLI. Configure with `NOTIFY_WEBHOOK_URL`, `NOTIFY_FORMAT` (`json`, `slack`,
  `discord`, `ntfy`), `NOTIFY_EVENTS` (default `done,failed,awaiting_approval`) and
  `NOTIFY_DRY_RUN=1`, then restart (or reload via the env-reload route).
- **What it does:** posts a short payload (`event`, `id`, the first 120 characters of the order
  text, `status`, PR links) when a fleet order finishes, fails or needs approval. Off unless
  `NOTIFY_WEBHOOK_URL` is set. One POST per `(order id, event)` for the life of the process, a
  5-second abort, and it never throws, so a webhook cannot change an order's state. It logs the
  host only, never the URL.
- **Example:** set `NOTIFY_WEBHOOK_URL=https://ntfy.sh/<topic>`, `NOTIFY_FORMAT=ntfy`, then run
  an order. `NOTIFY_DRY_RUN=1` logs the payload without sending.
- **Verified by:** `docs/overnight/REPORT_F09-notify-webhook.md` (proof harness
  `ops/notify-check.ts`, against a local stub server).

## 10. Policy file (F10)

- **Command:** no CLI to run it; the policy is read from `policy.json` at the repository root.
  `npx tsx ops/policy-check.ts` proves it.
- **What it does:** lists protected paths that a work order may never change on its own and a
  `maxFilesPerWorkOrder` cap. Built-in defaults: `.env*` except `.env.example`,
  `.github/workflows/**`, `.git/**`, `policy.json`, `*.pem`, `*.key`, and a cap of 20. Globs
  support `*`, `**` and `?`, are case-insensitive, use forward slashes, and a rule without `/`
  matches the basename anywhere. A `!` prefix is an exception. Enforcement: owned-file
  derivation drops protected paths, and the publish step refuses a protected path or an
  over-cap list before any git or network work, naming the path and the rule. A malformed file
  warns once and falls back to the defaults.
- **Example:** copy `policy.example.json` to `policy.json` and edit it. Note that `policy.json`
  is itself protected, so only a human can change the policy.
- **Verified by:** `docs/overnight/REPORT_F10-policy-file.md` (proof harness
  `ops/policy-check.ts`, plus `ops/fleet-github-check.ts` and `ops/fleet-cheapplan-check.ts` as
  regressions).

## 11. Docker and dev container (F11)

- **Command:** `docker compose up --build`, then `docker compose ps`
- **What it does:** builds and runs the router in mock mode (`MOCK_MODE=1`, `PORT=8787`), with
  named volumes for `company/` and `logs/`, no `env_file` (your `.env` is never copied into the container; only `COMPANY_AUTH_TOKEN` is substituted and compose refuses to start without it), the port bound to `127.0.0.1`, and a healthcheck on `/health`. It needs no provider keys, no GPU
  and no `jcode`. `.devcontainer/devcontainer.json` builds the same Dockerfile for VS Code with
  port 8787 forwarded and `npm ci` as the post-create step. `.dockerignore` excludes `.env`,
  `.env.*` (keeping `.env.example`), `node_modules`, `company/`, `logs/` and more.
- **Example:** `docker compose up --build` then open `http://127.0.0.1:8787/health`.
- **Verified by:** `docs/overnight/REPORT_F11-docker.md`. The compose file was validated with
  `docker compose config`; the image was deliberately never built or started, and the report
  says so. `docs/DOCKER.md` lists what does not work in the container.

## 12. Git worktree isolation (F13, design only)

- **Command:** none yet. The design is `docs/WORKTREE_MODE_SPEC.md`.
- **What it does:** specifies one git worktree per work order so parallel agents cannot
  overwrite each other. A sibling folder `FLEET_WORKTREE_ROOT` (default
  `<dirname(repoRoot())>/_fleet-wt`), layout `<root>/<orderId>/<woId>`, the existing
  `fleet/<order>/<wo>` branch name, an opt-in `FLEET_WORKTREES=1` flag (default off), a build
  plan (WT-1 to WT-5) and an acceptance test. The system never deletes a worktree.
- **Example:** not runnable yet. It is a spec with a build plan for future narrow orders.
- **Verified by:** `docs/overnight/REPORT_F13-worktree-spec.md` (documentation only, verified by
  reading the file and its section headings).

## Supporting material

- `docs/WORKER_GUARD.md`: the worker guard rules and the order-writing rules that keep workers
  from looping.
- `docs/FLEET_OPERATOR_GUIDE.md`: the fleet HTTP API, auth, and the order and work-order shapes.
- `docs/CEO_RUNBOOK.md`: the trust boundary and the supervised launch and shutdown procedure.
- `docs/overnight/ORDER_*.md` and `docs/overnight/REPORT_*.md`: the order and the proof report
  for each feature above.
