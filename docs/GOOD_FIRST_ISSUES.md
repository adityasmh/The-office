# Good first issues

Twelve small, concrete issues a newcomer can take. Each one is small enough to finish in one
sitting, names the files involved, and states how to know it is done.

The sources are `docs/FEATURE_IDEAS_2026-10-06.md`, the "Open issues" sections of
`docs/overnight/REPORT_*.md`, and the checks that are known to be red or missing from the
offline suite (`ops/checks.manifest.json` lists 56 checks; the manager can run
`npx tsx ops/run-all-checks.ts` to see the current state on a machine).

## 1. Put `MOCK_MODE=1` in `.env.example`

- **Why:** `ops/setup.ts` appends `MOCK_MODE` because `.env.example` does not contain it, and
  the report recorded that as an open issue.
- **Files:** `.env.example`, `ops/setup.ts`, `ops/setup-check.ts`.
- **Done when:** a fresh `npx tsx ops/setup.ts` replaces the key in place instead of appending
  it, the file still has exactly one `MOCK_MODE` line, and `npx tsx ops/setup-check.ts` passes.
- **Source:** `docs/overnight/REPORT_F02-setup.md`, open issues.

## 2. Keep a timestamped copy of `.env` when `--force` runs

- **Why:** a second `npx tsx ops/setup.ts --force` overwrites `.env.bak` and the previous
  values are lost.
- **Files:** `ops/setup.ts`, `ops/setup-check.ts`.
- **Done when:** two `--force` runs leave two distinct backups, the setup check covers it, and
  `npx tsx ops/setup-check.ts` passes.
- **Source:** `docs/overnight/REPORT_F02-setup.md`, open issues.

## 3. Run the secret-scan hook once end to end

- **Why:** the hooks were verified by content and by install and uninstall behaviour, but the
  exact `npx tsx ops/secret-scan.ts --staged` line they run was never executed.
- **Files:** `ops/secret-scan.ts`, `ops/install-hooks.ts`, `ops/secret-scan-check.ts`.
- **Done when:** in a temporary git repository that contains a copy of the scanner, staging a
  fake key makes a commit fail through the hook, and the check harness records that case.
- **Source:** `docs/overnight/REPORT_F03-secret-scan.md`, open issues.

## 4. Give the cost report a provider record for every worker

- **Why:** rows whose worker has no `logs/worker-providers.jsonl` record land in the visible
  `unknown provider` block, which hides where the money actually went.
- **Files:** `ops/spawn-worker.ps1` (writes `logs/worker-providers.jsonl`),
  `ops/cost-report.ts`, `ops/cost-report-check.ts`.
- **Done when:** after a worker run, `npx tsx ops/cost-report.ts --by provider` shows no
  `unknown provider` row for that day, and `npx tsx ops/cost-report-check.ts` passes.
- **Source:** `docs/overnight/REPORT_F04-cost-report.md`, open issues.

## 5. Add the full trace detail to the order report

- **Why:** the timeline clips the trace `detail` to 160 characters and appends it to the "What"
  cell, so the full text is nowhere in the report.
- **Files:** `ops/order-report.ts`, `ops/order-report-check.ts`.
- **Done when:** a long detail is readable in full (for example a separate column or a
  details block) and `npx tsx ops/order-report-check.ts` passes.
- **Source:** `docs/overnight/REPORT_F05-order-report.md`, open issues.

## 6. Re-check the four over-flagged network entries in the check manifest

- **Why:** `deepseek-offpeak`, `fleet-github`, `fleet-retry` and `order-report` are marked
  `"network": true` even though the only real host names are inside fixture text, so the default
  run skips four checks that are actually offline.
- **Files:** `ops/checks.manifest.json`, `ops/run-all-checks-check.ts`.
- **Done when:** each of the four is `"network": false` if it really makes no call, and
  `npx tsx ops/run-all-checks.ts --only <name>` passes for each of them.
- **Source:** `docs/overnight/REPORT_F08-run-all-checks.md`, open issues.

## 7. Make `resume-view` and `ui-assistant` portable

- **Why:** both checks hard-code `C:\Program Files\Google\Chrome\Application\chrome.exe`, so
  they cannot pass on the CI runner, which is why `ci.yml` is expected to stay red on Linux.
- **Files:** `ops/resume-view-check.ts`, `ops/ui-assistant-check.ts`,
  `ops/checks.manifest.json`, `.github/workflows/ci.yml`.
- **Done when:** both checks pass on a machine without that Chrome path, or skip with a clear
  reason, and the CI note about expected red checks is updated.
- **Source:** `docs/overnight/REPORT_F08-run-all-checks.md`, open issues.

## 8. Ignore thought-only lines in the worker-guard repeat rule

- **Why:** the guard counted streamed thought fragments (a single punctuation mark) as a
  repeated line and killed finished workers, and one fixture in the guard self-test still fails.
- **Files:** `ops/worker-guard.ps1`, `ops/worker-guard-check.ps1`.
- **Done when:** the fragmented-thought fixture passes, the real loop rules still kill a
  genuinely repeating worker, and `docs/WORKER_GUARD.md` no longer lists the known gap.
- **Source:** `docs/FEATURE_IDEAS_2026-10-06.md` item 6 and `docs/WORKER_GUARD.md`.

## 9. Pass the graphify digest into fleet briefs

- **Why:** the old pipeline gave agents the project digest and fleet workers do not get it, so
  they re-read files and spend tokens.
- **Files:** `src/company/fleet.ts` (the brief builder), `src/company/knowledge.ts`, a check in
  `ops/`.
- **Done when:** a worker brief contains the digest and a measured before/after shows fewer
  tokens per work order.
- **Source:** `docs/FEATURE_IDEAS_2026-10-06.md` item 7.

## 10. Build and start the Docker image once

- **Why:** `docker compose config` was validated, but the image was never built and the
  container never started, so the `npm ci` layers, the build inside the image and the
  healthcheck are unexercised.
- **Files:** `Dockerfile`, `docker-compose.yml`, `.devcontainer/devcontainer.json`,
  `docs/DOCKER.md`.
- **Done when:** `docker compose up --build` reaches `healthy`, `http://127.0.0.1:8787/health`
  answers, and `docs/DOCKER.md` records the observed result instead of "never built".
- **Source:** `docs/overnight/REPORT_F11-docker.md`, open issues.

## 11. Implement worktree WT-1 from the design

- **Why:** `docs/WORKTREE_MODE_SPEC.md` designs one git worktree per work order so parallel
  agents cannot overwrite each other, but no code exists yet.
- **Files:** new `src/company/fleetWorktree.ts` and `ops/fleet-worktree-check.ts` (the spec's
  WT-1 step), `docs/WORKTREE_MODE_SPEC.md`.
- **Done when:** the check proves create, list and refuse cases on a temporary git repository,
  the flag is off by default, and the spec's acceptance section is updated.
- **Source:** `docs/overnight/REPORT_F13-worktree-spec.md` and `docs/WORKTREE_MODE_SPEC.md`.

## 12. Make the `fleet-check` workflow actually run

- **Why:** a red `fleet-check` on a draft pull request downgrades a fleet PASS to REDO, but the
  workflow needs Actions enabled and allowed to run on the repository, so the loop is open.
- **Files:** `.github/workflows/fleet-check.yml`, `src/company/fleetGithub.ts`,
  `ops/fleet-github-check.ts`, `ops/fleet-review-shipped-check.ts`.
- **Done when:** the workflow runs on a draft fleet pull request, a red result downgrades a PASS
  to REDO, and a check harness records the downgrade.
- **Source:** `docs/FEATURE_IDEAS_2026-10-06.md` item 9 and `.github/workflows/fleet-check.yml`.

## Also recorded, but a little bigger

- **Branch hygiene** (`docs/FEATURE_IDEAS_2026-10-06.md` item 10): a read-only job that lists
  `fleet/*` branches whose pull request is closed or merged, for the human to delete. The system
  never deletes.
- **The doctor on the authoring machine** (`docs/overnight/REPORT_F01-doctor.md`): the real run
  ends `ok=false` because some key names from `.env.example` are missing or empty in `.env`.
  Filling them in is a one-minute fix, and the doctor prints the names, never the values.
