# Cheap by default: Laya gates every Claude call (CEO order, 2026-09-30)

Rule from the CEO: Claude is only for BIG tasks or when the CEO names it ("use Claude", "have Opus review this").
Small tasks must never be assigned to or through Claude. Default model for everything else: deepseek-v4.1-flash.

## Gate (one choke point: src/company/brainRouter.ts, hooked into callClaudeSubscription)
Every caller passes a `purpose` string. Tier returned: `none` (DeepSeek or a plain rule) | `sonnet` (default for real
planning) | `opus` (rare). Claude runs only when:
1. Laya says the task is big (size/complexity question, gate on top-probability >= 0.33 and lead >= 0.08, NOT `confidence`).
2. The CEO named Claude/Sonnet/Opus in the order (keyword check, overrides Laya, no model call).
3. Laya is below threshold AND the purpose is plan or review (never chat replies): take the CHEAPER tier.
Safety net: a small task that fails on DeepSeek twice escalates once to Sonnet, reason recorded. Kimi stays escalation-only.
Log every decision: purpose, tier, reason (laya | ceo-override | fallback), cost. Show avoided Claude spend on the Budget page.

## Job 1: BUDGET (otter), core gate
Build the gate above in brainRouter.ts and put every existing call site behind it (assistant.ts, orchestrator.ts,
workers.ts, briefing.ts, fleet.ts, runManagers.ts, server.ts). No caller may reach claudeSubscription.ts directly.

## Job 2: CHEAP-DEFAULT (queued, starts AFTER otter's gate lands; same files, do not run in parallel)
- assistant.ts: ASSISTANT_MODEL is claude-opus-5-5 today. Default to DeepSeek; escalate only through the gate.
- orchestrator.ts: for small tasks skip the Claude manager plan and send ONE order straight to a worker; Claude plans only big tasks.
- Review step: small tasks get a DeepSeek review or an automated check; Claude reviews only big tasks.
- briefing.ts, runManagers.ts, fleet.ts: DeepSeek by default, Sonnet only when Laya says large.

## Acceptance
- 10 test orders: small ones (rename a label, fix a typo, a status question) make ZERO Claude calls; big ones (multi-file feature) still get a Claude plan + review.
- An order containing "use Claude" always reaches Claude.
- Claude calls per day before/after visible on the Budget page. Existing behaviour (Laya team/track/model picks, trace hops, reportBack) unchanged.
- Do not restart the router on :8787 while a task is in flight.
