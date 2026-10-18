# Security

This is a local, single-operator control plane. It spends provider money and runs coding agents
on your machine, so treat it like a password-protected admin tool: keep it on loopback, and
never port-forward it.

## How secrets are handled

- **Never committed.** `.gitignore` ignores `.env`, `.env.*`, `*.pem` and `*.key`, and it keeps
  only `.env.example`. `.env.example` holds key names and placeholders, never real values.
- **Generated, not defaulted.** `npx tsx ops/setup.ts` fills an empty or placeholder
  `COMPANY_AUTH_TOKEN` with 32 random bytes as hex (`crypto.randomBytes(32).toString("hex")`).
  It prints what it did, never a value from `.env`.
- **Scanned before commit.** `npx tsx ops/secret-scan.ts` finds secret-shaped strings (OpenAI,
  Slack, GitHub, AWS, Google, private-key headers, and 16+ character `KEY|TOKEN|SECRET|PASSWORD`
  assignments). Each hit reports the file, line, rule and only the first four characters of the
  match. `npx tsx ops/install-hooks.ts` wires that scan into `.git/hooks/pre-commit` and
  `pre-push`, so a staged secret blocks the commit. `.secretscan-allow` holds the operator's
  allow-list, one path glob or value regex per line.
- **The token travels only in a header.** Every mutating `/company/*` request must carry
  `x-company-token` (`TOKEN_HEADER` in `src/company/authguard.ts`), compared in constant time.
  `GET /company/stream` always needs the token, and it is the one route that accepts `?token=`
  because `EventSource` cannot set headers. `ops/fleet-cli.ts` and `ops/new-order.ts` read the
  token from `$COMPANY_AUTH_TOKEN`, or from `.env` only inside the tool, send it only on POST,
  and never print it.
- **No value in reports or logs.** `ops/doctor.ts` reports key names only. `ops/cost-report.ts`
  prints cost and token counts. `ops/order-report.ts` redacts token-shaped strings in both
  Markdown and HTML. `src/company/notify.ts` logs a webhook's host only, never its URL.
  `src/company/envReload.ts` returns key names only.
- **The bridge and the runners redact.** `src/company/fleetGithub.ts` routes all of its output
  through `redactForLog`, and the secret scanner is a built-in guard for the whole flow.

## Trust boundary

- The router binds `HOST=127.0.0.1` by default. `src/config.ts` (`assertConfig`) refuses to
  start when `HOST` is not loopback and `COMPANY_AUTH_TOKEN` is empty.
- A loopback peer may `GET` `/company/*` without the token, which is what the dashboard uses.
  Every mutation needs the token, loopback or not. A non-loopback peer is refused for everything
  under `/company/*` unless it presents the token.
- `GET /company/auth/bootstrap` hands the dashboard the secret, and answers loopback peers only,
  and only when the `Host` header is a loopback name. `GET /health` reports the posture
  (`bind`, `authTokenConfigured`).
- There is no TLS and no per-user identity. See `docs/CEO_RUNBOOK.md` section 0 for the
  operator-facing story and the verification scripts.

## What agents may and may not touch

- **Owned files only.** A work order carries an explicit `owns` list. Only those paths are
  committed by the publish step (`commitOwned` in `src/company/github.ts`).
- **The policy file wins.** `policy.json` at the repository root (example:
  `policy.example.json`) lists protected paths that a work order may never change on its own.
  The built-in defaults are `.env*` (except `.env.example`), `.github/workflows/**`, `.git/**`,
  `policy.json`, `*.pem` and `*.key`, with a `maxFilesPerWorkOrder` cap of 20. Owned-file
  derivation drops protected paths, and the publish step refuses a protected path or an
  over-cap list before any git or network work, naming the path and the rule. `policy.json` is
  itself protected, so only a human can change the policy.
- **No deletes.** The system never deletes worktrees, and the worktree design states that
  explicitly. Cancelling an order stops new spawns; it does not kill running terminals, which a
  human closes by hand.
- **Workers are guarded.** Every worker spawned through `ops/spawn-worker.ps1` runs under
  `ops/worker-guard.ps1`, which kills a looping, stalled, over-budget or over-time worker and
  never touches the router, Laya, Kafka or a fleet terminal.
- **Money is bounded.** `src/company/fleetGithub.ts` is a no-op that makes no git or network
  call until `FLEET_GITHUB=1`, and `src/company/deepseekDirect.ts` is inert until
  `DEEPSEEK_DIRECT=1` and a key are present. Routing and budget rules live in those modules and
  in `src/company/budgetGuard.ts`, and the default is to spend subscription quota before prepaid
  credits.

## Reporting a problem privately

Please do not open a public issue for a security problem. Use GitHub's private vulnerability
reporting for this repository: open the repository's **Security** tab and choose
**Report a vulnerability**. That keeps the report private until a fix is available. Include the
affected file or command, what you did, what happened, and the version you are running.

Do not include real secrets in a report. Use fake values that reproduce the shape, or describe
where the secret would appear.

## If a secret does leak

1. Rotate the secret at the provider first. Assume anything committed or printed is compromised.
2. Replace the value in `.env`. `npx tsx ops/setup.ts` never overwrites an existing `.env`
   without `--force`.
3. If the leak is in a commit, treat it as a rotation, not just a history edit, and follow
   GitHub's guidance for removing sensitive data from a repository.
