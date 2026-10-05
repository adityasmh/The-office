# Order STALE-CHECKS: update two older check scripts to the new routing rule

Narrow job. Do exactly these steps, print the final report, and END your turn. Do not wait, poll, loop, or re-read this order.

## Why
On 2026-10-06 the routing policy changed: DeepSeek credits are used only when OpenCode Go is exhausted (quota below 10% or a Go 429 in the last 10 minutes). Healthy OpenCode quota now keeps work on OpenCode Go at ANY hour, including DeepSeek's off-peak phase. The old off-peak-uses-credits rule survives only behind the opt-in env `DEEPSEEK_OFFPEAK_DIRECT=1`. Two older check scripts still assert the old rule. Read `docs/REPORT_2026-10-06_POLICY-GO-FIRST.md` section 4 item 1 and how `ops/deepseek-only-check.ts` was already updated (lines around 233-250).

## Rules
- Edit ONLY `ops/deepseek-offpeak-check.ts` and `ops/budget-guard-direct-check.ts`. Edit nothing else, including no source file under `src/`.
- Do not touch `.env`, `company/`, the router, Laya, Kafka, or scheduled tasks. Do not print secrets. No real network calls (the checks use stubs and an injected clock).
- Run each command ONCE, in the foreground. If a step fails for a reason other than the old off-peak expectation, report the exact error and END your turn; do not retry in a loop.
- Small diffs, match the surrounding style.

## What to do
1. In `ops/deepseek-offpeak-check.ts` (around lines 118-119 and 152-153) and `ops/budget-guard-direct-check.ts` (around lines 131-142 and 151-152): for each case that expects "off-peak -> DeepSeek direct", do ONE of these, whichever keeps the case meaningful:
   - pin `process.env.DEEPSEEK_OFFPEAK_DIRECT = "1"` for that case and restore it afterwards, so the case still tests the opt-in path, or
   - change the expectation to the new rule (off-peak with healthy quota -> OpenCode Go, no credits).
   Also add one new case in each file that proves the new default: off-peak with healthy quota stays on OpenCode Go.
2. Update the header comment of each file by one line saying which rule it now tests.

## Finish
1. Run `npx tsx ops/deepseek-offpeak-check.ts` once and `npx tsx ops/budget-guard-direct-check.ts` once. Both must end with an all-pass line.
2. Run `npx tsc --noEmit` once.
3. Write `docs/REPORT_2026-10-06_STALE-CHECKS.md` with the changed line ranges, the exact output of the runs, and any open issue. Print the same report and END your turn.
