# Order POLICY-GO-FIRST: use DeepSeek credits only when OpenCode Go is exhausted

Narrow job. Do exactly these steps, print the final report, and END your turn. Do not wait, poll, loop, or re-read this order.

## Why
CEO order 2026-10-06: "only use DeepSeek with credits when OpenCode is exhausted." The current routing policy still has an extra rule that sends work to DeepSeek direct whenever DeepSeek is in its off-peak (half price) phase, even when OpenCode Go has plenty of quota. Remove that rule. The 2026-10-02 policy order is `docs/ORDER_2026-10-02_deepseek-routing-policy.md` (read its items 1 and 4 only).

## Rules
- Edit ONLY `src/company/deepseekDirect.ts` (a small change inside the existing policy function `deepseekDirectPlan`; keep its name, inputs and output shape) and `ops/deepseek-policy-check.ts` (update the expected results and add cases). Edit nothing else.
- Never restart or start the router on :8787. Never touch `.env`, `company/`, Laya, Kafka, or scheduled tasks. Do not print secrets. No network calls to DeepSeek or OpenCode in your tests (use the injected clock and injected usage snapshot the check already has).
- Run each command ONCE, in the foreground. If a step fails, report the exact error and END your turn; do not retry in a loop.
- Small diffs, match the surrounding style.

## What to change
New behaviour of `deepseekDirectPlan` (provider decision):
1. OpenCode Go quota known and the binding window remaining is at or above `GO_QUOTA_DEEPSEEK_BELOW_PCT` (default 10): use OpenCode Go, at ANY time of day, including DeepSeek off-peak. The `why` sentence says so plainly (for example "OpenCode quota 50% left: using OpenCode Go, no credits spent").
2. Quota below that line, or a Go 429 `GoUsageLimitError` within the last 10 minutes (the existing go-exhausted memory): use DeepSeek direct. Keep the existing fallback rules and the 5-minute auth/balance cool-off.
3. Quota unknown or stale: use OpenCode Go and learn from a 429 as today; never send to credits just because the quota is unknown.
4. Keep an explicit opt-in env `DEEPSEEK_OFFPEAK_DIRECT=1` that restores the old "off-peak is cheaper, use DeepSeek direct" rule; default is off (0 or unset). `DEEPSEEK_DIRECT_ALL_HOURS=1` still means always direct (explicit override).
5. When `DEEPSEEK_DIRECT` is 0 or unset the whole policy stays inert, as today.

## Proof
Update `ops/deepseek-policy-check.ts` so the matrix reflects the new rule, and make sure it covers: off-peak with quota 63% -> Go; off-peak with quota 9% -> DeepSeek; off-peak with quota 0% (weekly window binding) -> DeepSeek; peak with quota 63% -> Go; quota unknown off-peak -> Go; a fresh Go 429 -> DeepSeek for 10 minutes; `DEEPSEEK_OFFPEAK_DIRECT=1` restores the old off-peak result; flags off -> unchanged.

## Finish
1. Run `npx tsc --noEmit` once.
2. Run `npx tsx ops/deepseek-policy-check.ts` once, then `npx tsx ops/deepseek-fallback-check.ts` and `npx tsx ops/deepseek-only-check.ts` once each. If either of the last two fails only because it expected the old off-peak rule, update that expectation in its own file and say so in the report; if it fails for any other reason, report the exact error and do not edit it.
3. Write `docs/REPORT_2026-10-06_POLICY-GO-FIRST.md` with the diff summary (file and line ranges), the exact output of the runs, and any open issue. Print the same report and END your turn.
