# Work order: do not hold Fleet orders for OpenCode Go quota when they will run on DeepSeek direct

From: manager. Model: deepseek-v4.1-flash. Repo: C:\Users\user\Desktop\Default Project

## Problem (measured 2026-10-01 18:16 IST)
`src/company/fleet.ts` ~line 2449-2460: `fleetQueueForBudget(orderUrgent)` (src/company/budgetGuard.ts ~line 1008) makes every non-urgent Fleet order wait while OpenCode Go is RED (weekly window at 6% left). "Urgent" only means an escalation. Orders fomupf7f4a (metrics stack) and fomupiu2hf (router stall fix) sit at `waiting: budget` with 4.7 GB RAM free. But DeepSeek's own API is funded and armed (DEEPSEEK_DIRECT=1, key in .env, src/company/deepseekDirect.ts `deepseekDirectPlan(model)`), and during its off-peak hours (15:30-06:30 IST, all weekend) DeepSeek work does not touch the Go quota at all. Holding those orders protects nothing.

## Do
1. In the Fleet launch gate (fleet.ts around the budget check and `applyBudgetFilter` call ~line 2493), skip the "wait for budget" hold when this work order will really run direct: `deepseekDirectPlan(<the model that will be used>).use === true` AND direct is launchable for fleet terminals. The model is picked AFTER the budget check today: restructure minimally (peek the pick, or run the check after the pick) without changing the pick logic itself.
2. "Launchable for fleet terminals" = `jcode -p deepseek` works non-interactively. Today it does not until the CEO runs `jcode login --provider deepseek` (it refuses on the old, invalid opencode credential). Implement `fleetDirectReady()`: true when env `FLEET_DEEPSEEK_DIRECT_READY=1`, else a cached (10 min, async, 5 s timeout, never on the event loop) probe of `jcode model list -p deepseek` exiting 0 and listing deepseek-flash. Put it in src/company/deepseekDirect.ts (or a tiny new file). When not ready, behaviour is exactly as today.
3. Trace/log: when the hold is skipped, add a trace hop "budget: skipped hold, runs on DeepSeek direct (off-peak, no Go quota)". When it runs direct but a work order falls back to Go, the existing fallback stays.
4. Do NOT change budgetGuard's real thresholds, the red/amber logic, or `fleetQueueForBudget` itself. Peak hours, non-DeepSeek models (Kimi/GLM/Qwen), and a missing key all keep waiting exactly as before.
5. Also: expose it for the dashboard in one line of the existing budget panel payload if cheap (`fleetDirectReady` and `directPhase`); another worker (real-budget, pid 13280) is editing budget panels, so re-read before editing and keep it to a tiny addition or skip it.

## Verify
- ops/budget-guard-direct-check.ts through the real functions: (a) Go red + deepseek model + off-peak 11:00Z + armed + ready -> not held; (b) same at peak 02:00Z -> held; (c) Kimi model -> held; (d) not ready (no login) -> held; (e) Go amber/green -> unchanged. ALL PASS. Re-run the existing budget checks (ops/budget-*check*.ts / selftests) and `npx tsc --noEmit` exit 0.
- Do not restart the router (the manager does). Do not touch Laya serving, Kafka, VictoriaMetrics, or the real-budget files beyond what step 5 says.
- Append a timestamped entry to docs/AGENT_COORDINATION.md. Report to the manager.
