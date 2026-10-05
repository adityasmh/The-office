# Real budget monitoring that steers Laya (CEO-ordered)

Written by Claude Code (manager). Built by the jcode session BUDGET.

## Why
The dashboard's "$5 per agent" caps are virtual (docs/PROVIDER_USAGE.md). The limits that actually stop work are:
- **OpenCode Go** (DeepSeek/Kimi/GLM/Qwen for every jcode terminal and worker): the remaining allowance is shown only on
  OpenCode's website. `jcode usage` shows local spend only ($1.14 today at 20:35).
- **Claude subscription** (manager, reviews, the Opus assistant, run managers): `jcode usage --json --no-update` already
  reports it. At 20:35 the **5-hour window was 91% used** (reset in 3h20m) and the 7-day window 14%.

## 1. Read the numbers (BUDGET owns `src/company/usage.ts`, extended, and a new `src/company/budgetGuard.ts`, `ops/budget-*.ts`)
- **OpenCode Go remaining:** find the least fragile source, in this order, and document which one you used:
  a. an API endpoint that accepts the existing `OPENCODE_API_KEY` (check OpenCode's docs and the network calls their usage
     page makes);
  b. the JSON endpoint behind the opencode.ai usage/billing page, called with a **session cookie the CEO pastes into
     `.env` themselves** (`OPENCODE_SESSION_COOKIE`; add a placeholder to `.env.example` with instructions on where to
     copy it from);
  c. only if neither works: a headless browser page read using that same cookie (ask the manager in
     docs/AGENT_COORDINATION.md before adding any npm dependency such as playwright).
  **Hard rules:** never type or store the CEO's password, never automate a login, never print the cookie or key, and
  read-only (no clicks that change settings or billing). If there's no cookie yet, show "not connected: add
  OPENCODE_SESSION_COOKIE" instead of guessing.
- **Claude:** reuse `jcode usage --json --no-update` (5-hour + 7-day windows, reset times), async, never on the request
  path. Cache it for 2 minutes.
- **Measured spend:** `opencode stats --models` + `company/projects/*/cost.jsonl` for the burn rate.
- Poll every `BUDGET_POLL_S` (default 300 s) in a guarded background loop (async only; it must never block the event
  loop; PERF just fixed that). Store `company/budget/state.json` + history `company/budget/history.jsonl`.

## 2. Budget pressure → behaviour (`budgetGuard.ts` exports `budgetPressure()`)
Per provider: `{ remainingPct, resetsAt, burnPerHour, runsOutAt, level: "green"|"amber"|"red", source, checkedAt }`.
Default levels: green > 40% left, amber 15–40%, red < 15% (env-overridable). Rules (the manager's decisions; implement
them as data so they are easy to tune):
| Provider pressure | Effect |
|---|---|
| OpenCode Go amber | Worker model picks never choose Kimi or deepseek-v4-pro unless the CEO overrides; Fleet parallelism stays at the CEO's MAX_PARALLEL_SESSIONS (set BUDGET_FLEET_MAX_PARALLEL_AMBER to cap it) |
| OpenCode Go red | Only the cheapest (glm-5.3-flash / deepseek-v4.1-flash); new non-urgent Fleet orders queue with "waiting for budget"; Fleet parallelism stays at MAX_PARALLEL_SESSIONS (set BUDGET_FLEET_MAX_PARALLEL_RED to cap it) |
| Claude amber | Assistant uses Sonnet instead of Opus; run-manager checks every 10 min instead of 3; Briefing at most every 15 min |
| Claude red | Assistant → DeepSeek (Claude only for plan + final review); run managers use the no-Claude path (stuck detection only); a "Needs you" item |
- **Laya:** add the budget state to the `state` of every Laya decision (team/model/track), e.g.
  `budget: {go: "amber", claude: "red"}`, and mention cost in the choice descriptions. The guard rules above apply AFTER
  Laya, as a hard filter (a Kimi pick under Go amber becomes deepseek-v4.1-flash, and the reason is recorded).
- Integration is in other owners' files, so send each owner a targeted request (`jcode transcript --mode send -S <id>`)
  with the exact call to add: bonehound (fleet.ts: model pick + parallelism), cricket/LAYA-TUNE (dispatch.ts Laya
  state), mushroom (runManagers/briefing intervals), and assistant.ts (it's shared: crocodile, cricket and llama have
  grants there, so coordinate in the log). The manager's own spawn helper reads `company/budget/state.json` itself.

## 3. Dashboard
- Top bar: one small budget chip per provider ("Go 62% · Claude 9%") coloured by level; clicking opens `#/budget`.
- `#/budget` page (`public/v2/views/budget.js`, owned by BUDGET; ask UI-CLEAN/eagle for the nav entry): per provider,
  remaining %, when it resets, burn per hour, "at this pace it runs out at 22:40", a 24 h sparkline from the history, and
  what the system is doing about it right now ("Kimi disabled because OpenCode Go is amber"). Plain words; the CEO wants
  useful, not pretty.
- The existing virtual "$5 caps" section gets a one-line note that it's an internal throttle, not real money.
- The Briefing gets a "Needs you" item when anything is red.

## Proof (real output in docs/AGENT_COORDINATION.md)
Real current numbers from both providers (or the exact reason one isn't connected yet), `budgetPressure()` output, a
forced-amber test (env override) showing a Kimi pick turning into DeepSeek and the assistant switching Opus → Sonnet, and
the page rendering. `npx tsc --noEmit` clean.
