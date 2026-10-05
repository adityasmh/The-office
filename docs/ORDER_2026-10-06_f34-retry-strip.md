# Order F34-RETRY-STRIP: retry publish button and a GitHub strip on the order view

Narrow job. Do exactly these steps, print the final report, and END your turn. Do not wait, poll, loop, or re-read this order.

## Why
1. When the PR step fails after the push (permission, token, network) the CEO has to open the PR by hand. Add a retry.
2. The order view does not show GitHub state. The data exists (branch, `prUrl`, trace steps with `to: "GitHub"`); show it, plus the CI state.

## Rules
- Edit ONLY `src/company/fleet.ts` (small insertions: type fields, one new exported function, and a few lines in the tick where CI is already checked), `src/server.ts` (one new route plus its import), `public/v2/views/fleet.js`, and the new file `ops/fleet-retry-check.ts`. Other workers are editing `src/company/fleetGithub.ts`, `src/company/github.ts` and `src/company/envReload.ts` right now: do NOT touch them, and only IMPORT existing exports from `fleetGithub.ts` (`publishWorkOrder`, `ciVerdict`, `applyCiDowngrade`); do not rely on any export that is not already there.
- Make changes with small targeted edits, never rewrite an entire file.
- Never restart or start the router. Never touch `.env`, `company/`, Laya, Kafka, or scheduled tasks. No network calls and no real token in your tests. Do not print secrets.
- Run each command ONCE, in the foreground. If a step fails, report the exact error and END your turn; do not retry in a loop.
- Plain words in the UI, no visual polish. Match the surrounding style.

## What to build
A. **Retry publish.** In `src/company/fleet.ts` export `republishWorkOrder(orderId, workOrderId)`: finds the work order; refuses (returns `{ok:false, reason}`) unless its verdict is PASS and it has no `prUrl`; otherwise calls the existing `publishPass` logic again (the same code path as the first publish) and returns `{ok:true, prUrl?, branch?}` or the failure reason. Add `POST /company/fleet/orders/:id/work/:wid/publish` in `src/server.ts`, behind the existing company guard, returning that result (404 for an unknown order or work order). The retry must work even if the branch already exists on the remote and in the local repo (reuse it; never force-push).
B. **CI state.** Add optional `ciState?: "RED" | "GREEN" | "PENDING"` and `ciCheckedAt?: string` to the work order type. In the tick, where the existing CI check for PASSed work orders with a `prUrl` already runs, store the verdict in `ciState` and the time in `ciCheckedAt` (no new network calls: reuse the value that check already computes; when it does not run, leave them unset).
C. **Dashboard strip.** In `public/v2/views/fleet.js`, for each work order that has a `branch` or a GitHub trace step, show one compact line: branch name, a link to the PR when `prUrl` exists (opens in a new tab), "draft", and the CI state in plain words ("checks: passing / failing / not reported yet"). When the last GitHub trace step for that work order is "PR publish failed", show its reason in plain words and a **Retry publish** button that calls the new route (confirm dialog, busy state, error shown in plain words, refresh after success). Show nothing for work orders with no GitHub activity.

## Proof (`ops/fleet-retry-check.ts`; temp COMPANY_ROOT, stubs only, no router, no network)
Print PASS or FAIL per line:
- `republishWorkOrder` refuses a work order that is not PASS, and one that already has a `prUrl`.
- For a PASS work order with no `prUrl`, a stubbed publish that succeeds stores `prUrl` and `branch` and adds one trace step.
- A stubbed publish that fails again leaves the work order unchanged and returns the reason (no crash).
- The tick stores `ciState` from a stubbed CI result (RED, GREEN, PENDING) and does nothing when no PR exists.
If the existing code makes a stub impossible without editing `fleetGithub.ts`, test the pure pieces you can and say exactly what you could not test in the report.

## Finish
1. Run `npx tsc --noEmit` once.
2. Run `npx tsx ops/fleet-retry-check.ts` once.
3. Write `docs/REPORT_2026-10-06_F34-RETRY-STRIP.md` with the changed line ranges, the exact output of both runs, and any open issue. Print the same report and END your turn.
