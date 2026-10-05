# Work order: make the website budget show the REAL numbers, drop per-agent quotas

From: manager, on the CEO's order. Model: deepseek-v4.1-flash (kimi only if deepseek already failed this same job, say why).
Repo: C:\Users\user\Desktop\Default Project

## What the CEO said
"fix the budget on the website. make it sync with our actual budget and the real numbers. if you want divide the real numbers between employees, or I'm saying just don't give them quotas and stuff."

## Problem
The dashboard shows invented per-agent allocations/"spend cap (policy)" (src/company/budget.ts: coder $5, manager $3, ... $80.50 total, per-agent bars, Set controls) that do not match what we actually have or spend. The real constraints are the provider quotas and balances.

## Do this
1. Read docs/BUDGET_SPEC.md, docs/PROVIDER_USAGE.md, src/company/budget.ts, budgetGuard.ts, usage.ts, and the budget panels in public/index.html (and public/v2 if it exists) so you know what is shown today and where.
2. Replace the invented caps with REAL numbers, measured, refreshed on the existing poll (cache 30-60 s; never block the router: timeout 3 s per source, last good value + a "stale" flag):
   - OpenCode Go: the real windows (5-hour, weekly, monthly: % left and when each resets). Source: `opencode stats` / whatever src/company/usage.ts already uses; the 2026-10-01 16:30 reading was 5h 84% left, weekly 13% left (resets in ~3d 12h), monthly 57% left. Use the same method.
   - DeepSeek direct API: the real credit balance from DeepSeek's balance endpoint (GET https://api.deepseek.com/user/balance with the key from .env DEEPSEEK_API_KEY; never print, log or send the key anywhere else, never return it from any endpoint), plus a clear phase line: "off-peak (0.5x) until 06:30 IST" / "peak" from src/company/offpeak.ts, and whether direct is armed.
   - Claude subscription: whatever real signal exists (rate-limit/429 state from the router, last sign-in state); say "subscription, no dollar budget" if nothing real exists. Do not invent a number.
   - Measured spend: sum of real per-call cost already recorded (company/sessions.jsonl, cost.jsonl, budgets.json spend ledger): today, last 7 days, by provider and by model, and by department/project. Show DeepSeek direct spend separately from Go.
3. Employees: do NOT give them quotas. Remove per-agent allocated caps, "Set" controls and the 402 "budget exhausted" refusal in POST /company/agents/:id/message and anywhere else an agent is blocked for exceeding its own cap (budget.canAfford gating). Keep the measured per-agent spend as a plain read-only column ("spent so far") so the CEO can see who uses what; share of total is fine. Keep the REAL protections: budgetGuard.ts reacting to real Go/Claude quota pressure (amber/red) stays exactly as is, and it is the only thing that may slow work.
4. Dashboard wording: plain. Replace "spend cap (policy)" and every invented number with: a Provider limits block (Go windows, DeepSeek balance + phase, Claude status), a Spend block (today / 7 days / by provider / by model), and the read-only per-agent "spent" list. Mark anything unmeasured as "not measured" instead of a number.
5. Add `GET /company/budget/real` (loopback read-only, same auth rules as other GET /company/*) returning that JSON, and make the existing panel payload use it so the website and the API cannot disagree. Keep old endpoints responding (same shape where possible, caps null) so nothing else breaks.

## Verify
- ops/budget-real-check.ts: asserts the JSON has no invented numbers (every number traces to a source; caps are null), the key never appears in any response body (grep the JSON text for the key value without printing it), per-agent message is no longer refused for budget, budgetGuard behaviour unchanged (existing ops/budget checks still pass).
- Show the CEO-visible result: fetch GET /company/panel and the new endpoint from the RUNNING router if it already serves them, else from a throwaway instance on another port (e.g. 8793, COMPANY_ROOT copy not needed, read-only) and paste the real numbers you got into docs/perf/BUDGET_REAL.md next to the numbers from the sources.
- `npx tsc --noEmit` exit 0.

## Rules
- Do NOT restart the main router on :8787 (the manager does it right after you finish; say "router restart needed").
- Do not touch Laya serving, Kafka/VM/adaptive files. Other workers are editing src/server.ts and public/*: re-read right before editing, small edits only.
- No secrets printed, no deletes of data (stop reading the old allocations; do not delete budgets.json).
- Append a timestamped entry to docs/AGENT_COORDINATION.md. Report to the manager.
