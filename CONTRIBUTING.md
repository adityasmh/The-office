# Contributing

Thanks for taking a look. This repository is a local, single-operator tool, so the workflow is
simple: get the machine healthy, make a narrow change, run the offline checks, and keep secrets
out of the diff.

## Setup

1. Install Node.js 20 or newer and git.
2. `npm install`
3. `npx tsx ops/setup.ts` creates a safe `.env` (mock mode on by default, random
   `COMPANY_AUTH_TOKEN`, `company/` and `logs/` created).
4. `npx tsx ops/doctor.ts` checks the machine. It prints one `PASS`/`WARN`/`FAIL` line per check
   and a one-line fix for each non-PASS line.
5. Optional but recommended: `npx tsx ops/install-hooks.ts` installs the secret-scan git hooks.

For a live run you also need the `jcode` command line tool and provider keys. Everything above
works in mock mode without them.

## Running the checks

```
npx tsx ops/run-all-checks.ts
```

That runs every check listed in `ops/checks.manifest.json`, one at a time. A check marked
`"network": true` is skipped unless you pass `--include-network`, so the default run is offline.
Useful flags:

- `--only <name>` runs one check (exact name first, then a case-insensitive substring).
- `--include-network` also runs the checks that make real calls. Do not pass this casually: some
  of them spend provider money.

Exit codes are 0 for all pass, 1 for any FAIL or TIMEOUT, and 2 for bad usage.

Two related commands:

```
npx tsc --noEmit                  # same type check CI runs
npx tsx ops/secret-scan.ts --all  # secret scan over the worktree
```

A few checks are known to be red or skipped today. They are listed with their reasons in
`docs/overnight/REPORT_F08-run-all-checks.md` and `docs/GOOD_FIRST_ISSUES.md`. Do not paper over
them by widening a skip; a check that needs the live router or a Windows-only binary should say
so plainly.

## Commit message style

Look at `git log` for the pattern in use. Commit subjects are single sentences, capitalised,
with no `type:` prefix and no trailing period. Longer commits join clauses with semicolons.

```
Budget page shows every window; live guarded-workers view; small orders carry owned files; credit-only daily cap
Fleet: auto-derive owned files, env reload route, retry publish, GitHub strip; retry-safe commit
Publish step restores the branch and reports failures; wrapper refuses loop-word orders
```

Keep the subject specific about what changed. If a change is a fix to a named issue, say which
one.

## Adding a check

A check is a Node script whose name ends in `-check.ts` (or `-check.mjs`) under `ops/`. It
prints one `PASS`/`FAIL` line per case and exits non-zero when anything fails. Follow the
existing harnesses:

1. Write `ops/<name>-check.ts`. Prefer temporary folders from `os.tmpdir()` and fake,
   runtime-assembled secrets. Never open the repository `.env`.
2. Register it in `ops/checks.manifest.json`:

   ```json
   { "name": "<name>", "command": "npx tsx ops/<name>-check.ts", "network": false, "timeoutSec": 120 }
   ```

   `name` is the file stem without the `-check` suffix. `timeoutSec` must be a positive number.
   Set `"network": true` if the script opens a client socket or names a real host, and prefer
   being conservative: a check that is needlessly skipped is better than one that spends money
   in CI.
3. Run `npx tsx ops/run-all-checks.ts --only <name>` and then the whole suite.

The runner prints a note when an `ops/*-check.*` file on disk is not in the manifest, so an
unregistered check is visible rather than silently ignored. `ops/run-all-checks-check.ts` is
deliberately not a manifest entry, because its own proof spawns the runner.

Harness style rules that the existing checks follow:

- Each case prints `PASS <what>` or `FAIL <what>` and the observed values, so a failure explains
  itself without a rerun.
- No test opens the repository `.env`, reads a real token, or prints a secret-shaped value. Fake
  secrets are assembled from pieces at runtime.
- Network is off by default. A check that needs a server starts a stub on `127.0.0.1`.

## Writing an order that does not make a worker loop

The rules are in `docs/WORKER_GUARD.md`. The short version:

1. One narrow task per worker, with an explicit end: "print the final report and END your turn".
2. No waiting, polling or "verify periodically" steps. The manager waits, not the worker.
3. Never tell a worker to read another worker's log.
4. Never ask a worker to work on, quote or discuss the loop phrase. Call it only "the loop
   phrase".
5. Search the order case-insensitively for the three-letter prefix of the loop phrase before
   spawning.

`ops/new-order.ts` enforces the same rule for templated orders: it lints the rendered order and
rejects wording that tells a worker to wait, poll, keep checking or stall, naming the offending
line.

## Ground rules

- **Agents never delete files.** The system never deletes files, branches or worktrees. If
  something needs to go away, list it and let a human remove it.
- **Only the owned files.** A work order carries an explicit `owns` list. Keep changes inside it.
- **Respect the policy file.** `policy.json` (example: `policy.example.json`) lists protected
  paths such as `.env*`, `.github/workflows/**`, `.git/**`, `*.pem` and `*.key`. Only a human
  changes the policy, and the publish step refuses a protected path or an over-cap list.
- **Never commit secrets.** `.env` is git-ignored, and the scanner and hooks exist to catch
  mistakes. If a secret does leak, rotate it first. See `SECURITY.md`.
- **Do not start servers, spawn workers or send messages** just to explore. The dashboard and
  the checks can be run in mock mode, and the reports cover what has already been verified.
- **Document what you verified.** The overnight feature reports are the model: state the changed
  files, the exact command, the exact output, and the open issues you did not close.

## Reporting a problem

- Bugs and feature requests: open an issue using one of the templates in
  `.github/ISSUE_TEMPLATE/`.
- Security problems: do not open a public issue. Use GitHub's private vulnerability reporting,
  as described in `SECURITY.md`.

## Licence

See the repository's `LICENSE`.
