# Known issues

## Checks that are red on a fresh clone

`npm run check:all` runs `ops/checks.manifest.json` (52 offline checks pass, 13 network checks are skipped unless `--include-network`).
Thirteen more checks live in `ops/checks.known-failing.json` (`npm run check:known-failing`). They fail in the source tree this repo was extracted from as well
(10 of the original 12 also fail on that tree's last commit, on the same machine); they are kept, not deleted, so they can be fixed:

| Check | Why it is red |
|---|---|
| `fleet-review-gullibility`, `fleet-review-path`, `fleet-review-shipped`, `fleet-review-verdict`, `fleet-review-verdict-second-pair`, `fleet-fallback-flakiness`, `fleet-signin-fallback-variant`, `fleet-signin-overreach` | still red with the fake-credentials home (re-tested 2026-10-18): they exercise the fleet planner/reviewer "Claude is dead" fallback paths and assert on text and call counts that changed after the checks were written. Needs someone to re-read each against current `fleet.ts` behaviour |
| `fleet-signin-predicate` | needs a Windows `claude.exe` stub plus a genuinely signed-in Claude Code login; fails under the fake-credentials home and skips itself off Windows |
| `manager-queue` | not hermetic: its fixtures depend on prompt classification that changed after the check was written |
| `planner-toolcall` | expects a repo doc (`docs/PERF_PLAN_*.md`) that is not shipped, and a stubbed Claude binary |
| `deepseek-only`, `budget-laya-state` | stale expectations: they assert a Kimi pick / a Kimi entry in the worker-model catalog, but the current policy maps everything onto the DeepSeek flash model |

## Other limits

- Worker launching is `jcode`-specific (`JCODE_BIN`); the model gateway side is generic. No real fleet run was performed for this release (mock mode and offline checks only).
- Windows-first: supervision is PowerShell/scheduled tasks. `ops/order-queue.ps1` (an optional order-queue runner the Ops view can display) is not shipped; the view shows "missing".
- The routing policy covers gateway, tiers, allowed families and the DeepSeek-direct clock. Provider-specific optimisers (`deepseekDirect.ts`, `budgetGuard.ts`, `budgetReal.ts`, `usage.ts`) are still OpenCode Go / DeepSeek shaped.
- The voice server, metrics stack and Laya model server are separate pieces not included; the related code degrades to "unavailable".
- Docs mention `REPORT_*`, `ORDER_*` and `docs/overnight/` files from the private origin; they are not shipped.

## Linux / macOS

- Verified on Ubuntu 24.04 aarch64 (Node 24, no Docker): install, typecheck, mock-mode server on a custom port (/health ok, dashboard 200, /company/products ok) and the offline suite.
- Skipped automatically off Windows: the child-PowerShell part of `scrub-env` and `fleet-signin-predicate` (needs a Windows `claude.exe` stub).
- `npx tsx ops/doctor.ts` fails on `jcode` and an empty `OPENCODE_API_KEY` in a fresh mock-mode clone; both are expected without a worker CLI and keys.
- Supervision scripts (`ops/*.ps1`, scheduled tasks) are Windows-only; run the server with `npm run dev` or your own process manager.
