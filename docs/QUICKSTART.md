# Quickstart

The same five steps as the README, with the detail needed to actually run the fleet. All
commands are run from the repository root, and each one was checked against the file that
implements it.

## 0. Prerequisites

- Node.js 20 or newer. The package has `tsx` as a dev dependency, so `npx tsx <file>` runs the
  scripts in `ops/` without a build step.
- `git`.
- For a live run: the host's `jcode` command line tool (the fleet opens `jcode` terminals) and
  provider keys. `ops/doctor.ts` checks all of this and tells you what is missing.
- Windows PowerShell is what the operational scripts were written and tested on. `npm run dev`
  and the `ops/*.ts` helpers are the portable path.

Install dependencies once:

```
npm install
```

## 1. Make a safe environment file

```
npx tsx ops/setup.ts
```

This copies `.env.example` to `.env` if `.env` does not exist, sets `MOCK_MODE=1` so a first
run costs nothing, fills an empty or placeholder `COMPANY_AUTH_TOKEN` with 32 random bytes as
hex, and creates `company/` and `logs/`. It prints what it did and the next steps, and it never
prints a value from `.env`.

Useful flags:

- `npx tsx ops/setup.ts --live` sets `MOCK_MODE=0`. Fill the provider keys in first.
- `npx tsx ops/setup.ts --force` replaces an existing `.env` (the old file is copied to
  `.env.bak` first).
- `npx tsx ops/setup.ts --dir <path>` runs the wizard against another folder (this is how its
  proof harness works).

## 2. Check the machine

```
npx tsx ops/doctor.ts
```

One line per check: Node version, git, `jcode`, `npx tsx`, `.env`, the key names from
`.env.example` that are missing or empty in `.env`, ports 8787 and 8000, GPU, free RAM and free
disk. Non-PASS checks carry a `fix:` line. The process exits 1 if any check FAILs.

`npx tsx ops/doctor.ts --json` prints one JSON object `{checks:[...],ok}` instead.

The doctor reports key NAMES only. It never prints a key value. A missing or empty key is a
FAIL, which is the check working as designed; open `.env` and fill the named keys from
`.env.example`.

## 3. Start the router and dashboard

For a development run:

```
npm run dev
```

That runs `tsx src/server.ts`. The server reads `.env`, binds `HOST` (default `127.0.0.1`), and
listens on `PORT` (default `8787`).

On Windows, the repository's documented operational way is the supervised launcher:

```
powershell -NoProfile -ExecutionPolicy Bypass -File ops\run-server-detached.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File ops\run-server-detached.ps1 -Status
powershell -NoProfile -ExecutionPolicy Bypass -File ops\run-server-detached.ps1 -Stop
```

The supervised launcher owns the router through a Windows Scheduled Task, so the server is not
inside your terminal's process tree. `ops\start-company.ps1` additionally brings up the Laya
decision server (port 8000) and the mission-control watcher, waits for both health checks, and
opens the dashboard.

If you only want to look at the interface, the Docker path in section 7 needs no keys at all.

## 4. Open the dashboard

The dashboard is the files in `public/`, served at the root of the router:

- Main dashboard: `http://127.0.0.1:8787/`
- Fleet view: `http://127.0.0.1:8787/v2/#/fleet`
- Health (no token needed): `http://127.0.0.1:8787/health`

## Mock mode

`MOCK_MODE=1` (what `ops/setup.ts` writes by default) swaps every provider call for the
deterministic answers in `src/mock.ts`. Nothing is sent to a provider and no budget is spent, so
you can click through the dashboard, the fleet flow and the assistant without keys, a GPU or a
`jcode` login. `ops/setup.ts --live` writes `MOCK_MODE=0`, which is what a real run needs.

## Creating a first order

An order is plain text. A manager plans it, and the plan waits at the `awaiting_approval` gate
until a human approves it.

### From the dashboard

1. Open `http://127.0.0.1:8787/v2/#/fleet`.
2. Type the order into the order box and submit it. This calls
   `POST /company/fleet/orders {text, autoApprove?}` and the view moves to
   `#/fleet/<orderId>`.
3. Wait for the plan. The order status becomes `awaiting_approval` and the Plan tab shows the
   proposed work orders.
4. Approve the plan. This calls `POST /company/fleet/orders/:id/approve` and one worker terminal
   is spawned per work order. The view shows the chain strip, the workers and their live tails,
   and the review.

The Fleet view also has a built-in sample mode (`#/fleet?mock=1`) that simulates the lifecycle
with sample data, for looking at the interface without a backend.

### With the fleet CLI

`ops/fleet-cli.ts` is the same API from a terminal. It talks to `$FLEET_URL` (default
`http://127.0.0.1:8787`) and reads the company token from `$COMPANY_AUTH_TOKEN`, or from
`COMPANY_AUTH_TOKEN` in `.env` only inside the tool. It sends the token only in the
`x-company-token` header on POST calls and never prints it.

```
npx tsx ops/fleet-cli.ts status
npx tsx ops/fleet-cli.ts new "Add a short setup section to docs/FEATURES.md"
npx tsx ops/fleet-cli.ts orders
npx tsx ops/fleet-cli.ts show <orderId>
npx tsx ops/fleet-cli.ts approve <orderId>
npx tsx ops/fleet-cli.ts workers
npx tsx ops/fleet-cli.ts tail <orderId>/<workOrderId> --lines 20
npx tsx ops/fleet-cli.ts cancel <orderId>
```

Add `--json` to any command for the raw payload.

### With an order template

`orders/templates/*.md` are narrow order templates (add a docs section, fix a small bug, add a
unit check, small refactor, update a README status line). `ops/new-order.ts` fills one in, lints
the result, and can post it as a new order.

```
npx tsx ops/new-order.ts add-docs-section \
  --set file=docs/FEATURES.md \
  --set change="Add a short note about mock mode" \
  --set check="the file contains the new section"
```

Modes: `--print` (default), `--out <file>` writes the rendered order, `--post` sends it to
`POST /company/fleet/orders`. The lint rejects wording that would make a worker loop (`wait`,
`poll`, `periodically`, `keep checking` and the loop-word prefix) and names the offending line.

## Reading the result

`ops/order-report.ts` is a read-only post-mortem for one order. It reads
`company/fleet/orders.json` and each work order's `REPORT.md`.

```
npx tsx ops/order-report.ts <orderId>
npx tsx ops/order-report.ts <orderId> --out order.md
npx tsx ops/order-report.ts <orderId> --html --out order.html
```

The report has a summary (order text, status, duration, work-order count and PASS/REDO counts),
a chronologically sorted timeline built from the order trace, and per work order: title, owned
files, verdict, review, branch, PR link, CI state and the report. Token-shaped strings are
redacted in both Markdown and HTML. An unknown order id exits 1 with one plain error line.

To see where the money and tokens went, use the cost report:

```
npx tsx ops/cost-report.ts
npx tsx ops/cost-report.ts --days 7 --by provider
npx tsx ops/cost-report.ts --json
```

## 5. Stopping

- A development run stops with Ctrl-C in the terminal that runs `npm run dev`.
- A supervised run stops with `ops\run-server-detached.ps1 -Stop`.
- `ops\shutdown-all.ps1` is the full shutdown path used by the dashboard's company shutdown; it
  is described in `docs/CEO_RUNBOOK.md`.

## 6. Day-to-day commands

```
npx tsx ops/doctor.ts                         # is this machine ready?
npx tsx ops/run-all-checks.ts                 # every offline check (network ones skipped)
npx tsx ops/secret-scan.ts --staged           # scan what you are about to commit
npx tsx ops/install-hooks.ts                  # run that scan automatically before commit/push
```

## 7. Docker (optional, mock mode only)

```
docker compose up --build
docker compose ps
```

Then `http://127.0.0.1:8787/health`. This stack runs mock mode, so it needs no provider keys,
no GPU and no `jcode`; it mounts named volumes for `company/` and `logs/`. The image and the
dev container were validated with `docker compose config` but never built or started, and
`docs/DOCKER.md` lists what does not work in the container. Compose needs a\r\n`COMPANY_AUTH_TOKEN` from your shell or `.env` (`npx tsx ops/setup.ts` creates one) and binds the port to localhost only.

## Where things are

| Path | What lives there |
|---|---|
| `src/server.ts` | HTTP routes, the trust-boundary guard, static dashboard serving. |
| `src/company/` | The control plane modules (fleet, gates, budgets, routing, policy). See `docs/ARCHITECTURE.md`. |
| `ops/` | Setup, checks, reports, the CLI and the operational PowerShell scripts. |
| `orders/templates/` | Order templates for `ops/new-order.ts`. |
| `public/` | The dashboard and its views. |
| `company/` | Runtime state: org, sessions, fleet orders, worker reports, budgets, logs. Git-ignored. |
| `policy.example.json` | Example for the protected-path policy file. |
| `docs/overnight/` | The feature orders (F01 and up), their proof reports and the research note. |
