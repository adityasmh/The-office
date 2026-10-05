# Local AI Company: a local multi-agent coding fleet

This project is a local, single-operator multi-agent coding fleet. You give it a plain-text
order. A manager plans that order into narrow work orders, one guarded `jcode` worker terminal
runs per work order, and a human approves the plan and the risky steps before anything is
published. The fleet runs on your own machine: it binds to loopback, keeps all state in plain
files under `company/`, and can be exercised end to end in mock mode without any provider keys.

## Why this exists

`docs/overnight/RESEARCH.md` collects the developer pain this feature set answers. In short:

- AI-assisted commits leak secrets about twice as often as human ones, so pre-commit scanning
  should be the standard defence.
- Token spend inside agent loops stays invisible until the bill arrives.
- Parallel agents overwrite each other unless they are isolated.
- Contributors want one-command setup, a doctor check, a dev container, and a readable trace of
  what an agent actually did.

The `docs/overnight/` feature orders (F01 through F14) implement one answer per pain, and each
one ships with a proof harness and a report. See `docs/FEATURES.md` for the catalogue.

## Quickstart

These five steps get you to a running dashboard. Nothing here spends money: `ops/setup.ts`
turns mock mode on by default.

1. Clone the repository and open a terminal in its folder.

2. Create a safe `.env` (copies `.env.example`, sets `MOCK_MODE=1`, and generates a random
   `COMPANY_AUTH_TOKEN`):

   ```
   npx tsx ops/setup.ts
   ```

3. Check the machine (Node version, git, `jcode`, `.env` keys, ports, GPU, RAM, disk). Every
   FAIL and WARN prints a one-line fix:

   ```
   npx tsx ops/doctor.ts
   ```

4. Start the router. For a development run, the repository's `dev` script starts the HTTP
   server and the dashboard:

   ```
   npm run dev
   ```

   On Windows the repository's documented way to run it supervised (so it does not live inside
   your terminal's process tree) is:

   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File ops\run-server-detached.ps1
   ```

5. Open the dashboard at `http://127.0.0.1:8787/`. The Fleet view, where an order is created
   and the plan is approved, is at `http://127.0.0.1:8787/v2/#/fleet`.

For the same path with more detail, including how to create a first order and read its
post-mortem, see `docs/QUICKSTART.md`.

## Commands

Every command below is a file in this repository and its usage is the usage in that file's
header comment.

| Command | What it does |
|---|---|
| `npx tsx ops/setup.ts [--live] [--dir <path>] [--force]` | First-run wizard. Copies `.env.example` to `.env`, sets `MOCK_MODE=1` (or `0` with `--live`), fills an empty `COMPANY_AUTH_TOKEN`, creates `company/` and `logs/`. Never overwrites an existing `.env` without `--force` (which copies the old one to `.env.bak` first). |
| `npx tsx ops/doctor.ts [--json]` | One `PASS`/`WARN`/`FAIL` line per check, each non-PASS check with a fix. Checks Node, git, `jcode`, `npx tsx`, `.env`, `.env` key names, ports 8787 and 8000, GPU, RAM and disk. Exit 1 on any FAIL. |
| `npx tsx ops/secret-scan.ts [--staged] [--all] [<paths>] [--json]` | Scans for secret-shaped strings (OpenAI, Slack, GitHub, AWS, Google, private keys, 16+ char assignments). Prints file, line, rule and a 4-character mask, never the value. Exit 1 on a hit. |
| `npx tsx ops/install-hooks.ts [--uninstall] [--force]` | Writes `.git/hooks/pre-commit` and `.git/hooks/pre-push` that run the secret scan on staged files. Refuses to clobber a foreign hook without `--force`. |
| `npx tsx ops/cost-report.ts [--days N] [--by day\|provider\|model\|worker] [--csv\|--json]` | Read-only cost and token report from the fleet's JSONL sources, always split into prepaid credits, subscription/quota, and unknown provider. |
| `npx tsx ops/order-report.ts <orderId> [--html] [--out <file>]` | Read-only post-mortem for one fleet order: summary, chronological trace, per work order verdict, review, branch, PR link, CI state and report. Token-shaped strings are redacted. |
| `npx tsx ops/fleet-cli.ts status \| orders \| show <id> \| new "<text>" \| approve <id> \| cancel <id> \| workers \| tail <worker>` | Command-line client for the fleet, so the dashboard is optional. `--json` works on every command. |
| `npx tsx ops/new-order.ts <template> --set key=value ... [--print] [--out <file>] [--post]` | Renders one of the `orders/templates/*.md` order templates, lints the result against waiting/polling wording, then prints, writes or posts it as a new fleet order. |
| `npx tsx ops/run-all-checks.ts [--include-network] [--only name] [--manifest file]` | Runs every check listed in `ops/checks.manifest.json` one at a time. Network checks are skipped unless `--include-network`. Exit 1 on any FAIL or TIMEOUT. |
| `npx tsx ops/policy-check.ts` | Proof harness for the policy file: protected paths, glob matching, owned-file derivation and the publish refusal. |
| `npx tsx ops/notify-check.ts` | Proof harness for webhook notifications, run against a local stub server (no real network). |
| `docker compose up --build` | Built mock-mode stack (no provider keys, no GPU, no `jcode`), then `http://127.0.0.1:8787/health`. |
| `npm run dev` | `tsx src/server.ts`: the router and dashboard on `PORT` (default 8787). |
| `npm run build` / `npm start` | `tsc -p tsconfig.json`, then `node dist/server.js`. |
| `npm run typecheck` | `tsc --noEmit`. |
| `powershell -NoProfile -ExecutionPolicy Bypass -File ops\run-server-detached.ps1` | The repository's documented way to run the router supervised on Windows (with `-Status`, `-Stop`, `-Uninstall`). |
| `powershell -NoProfile -ExecutionPolicy Bypass -File ops\start-company.ps1` | One-command local launch of the whole control plane (Laya decision server, router and dashboard, mission-control watcher), idempotent, never kills anything. |
| `powershell -NoProfile -ExecutionPolicy Bypass -File ops\worker-guard-check.ps1` | Self-test for the worker guard, in a temp folder only. |

## Safety model

- **Human approval gates.** A fleet order moves `planning` -> `awaiting_approval` -> `running`,
  and only an approve call (from the dashboard or `ops/fleet-cli.ts approve`) spawns workers.
  The older pipeline has three gates, `pending_intake`, `pending_code` and `pending_merge`
  (`src/company/gates.ts`).
- **Worker guard.** Every worker spawned through `ops/spawn-worker.ps1` runs under
  `ops/worker-guard.ps1`, which kills a looping, stalled, over-budget or over-time worker and
  never touches the router, Laya, Kafka or a fleet terminal. See `docs/WORKER_GUARD.md`.
- **Secret scan and hooks.** `ops/secret-scan.ts` finds secret-shaped strings before they are
  committed, and `ops/install-hooks.ts` wires it into git's pre-commit and pre-push hooks.
  `.env` is in `.gitignore` and is never read by the scanners.
- **Policy file.** `policy.json` at the repository root (example: `policy.example.json`) lists
  protected paths that a work order may never change on its own (`.env*` except `.env.example`,
  `.github/workflows/**`, `.git/**`, `policy.json`, `*.pem`, `*.key`) and a
  `maxFilesPerWorkOrder` cap. Owned-file derivation drops protected paths and the publish step
  refuses them.
- **OpenCode-first routing.** Credits are spent only when the OpenCode Go quota runs out.
  `src/company/deepseekDirect.ts` is the single decision point: healthy quota (10% or more)
  stays on OpenCode Go at any hour, quota below 10% or a Go 429 falls back to the DeepSeek
  direct API on its own credit, and off-peak direct use is opt-in only.
- **Loopback by default.** The router binds `127.0.0.1`. Every mutating `/company/*` request
  must carry the shared secret in the `x-company-token` header, compared in constant time
  (`src/company/authguard.ts`). A non-loopback bind is refused at startup without a token.

## Documentation

| Document | What is in it |
|---|---|
| `docs/QUICKSTART.md` | The quickstart in detail: mock mode, the dashboard, creating the first order and reading its result. |
| `docs/ARCHITECTURE.md` | Mermaid diagrams of the order pipeline and of the routing/budget logic, plus a table of the main `src/company/` modules. |
| `docs/FEATURES.md` | The developer feature catalogue (setup, doctor, secret scan, cost report, order report, fleet CLI, order templates, checks and CI, webhooks, policy file, Docker, worktrees), each with its command, an example, and the report that verified it. |
| `docs/GOOD_FIRST_ISSUES.md` | Twelve small, concrete issues a newcomer can take. |
| `SECURITY.md` | How secrets are handled, how to report a problem privately, and what agents may not touch. |
| `CONTRIBUTING.md` | Setup, the doctor, the check suite, commit style, adding a check, and how to write an order that does not make a worker loop. |
| `docs/WORKER_GUARD.md` | The worker guard rules and the order-writing rules that keep workers from looping. |
| `docs/FLEET_OPERATOR_GUIDE.md` | The fleet HTTP API (routes, auth, order and work-order shapes). |
| `docs/DOCKER.md` | The Docker and dev-container path, and what does not work in the container. |
| `docs/CEO_RUNBOOK.md` | The trust boundary, the supervised launch, and shutdown. |

## Status and limits

- This repository was written and tested on Windows with PowerShell. The `ops/` helpers are
  Node scripts (portable where noted), but several operational scripts are PowerShell and the
  CI workflow explicitly expects some checks to stay red on Linux until they are made portable
  (`.github/workflows/ci.yml`).
- A real run needs the host's `jcode` command line tool and provider keys (OpenCode Go, and a
  DeepSeek key if you want the credit fallback). Laya on GPU needs an NVIDIA card. Without
  keys, mock mode still runs the whole dashboard and fleet flow.
- There is no release process, no published package and no hosted service. The package manifest
  is `private`.
- The Docker image and dev container were validated with `docker compose config` but never
  built or started (`docs/overnight/REPORT_F11-docker.md`).
- Git worktree isolation is a design document (`docs/WORKTREE_MODE_SPEC.md`), not implemented
  code yet.
- A few checks in the offline suite are Windows-only today (`resume-view` and `ui-assistant`
  pin a Chrome path), and the worker-guard self-test has one known failing fixture
  (`docs/WORKER_GUARD.md`).
- Licensing is not stated here. See the repository's `LICENSE`.
