# Provider usage — the real constraints (not the virtual budget)

**Short version.** The dashboard's `$80.50 budget` is a *virtual policy cap*. It is not money,
not a provider limit, and nothing is charged when it is "exhausted". The constraints that
actually stop work are **provider subscription quota windows**, and those are what this module
surfaces. Where nothing can be measured, the answer is `unavailable, because X` — never a
made-up percentage.

| | Dashboard "$80.50 budget" | `src/company/usage.ts` |
|---|---|---|
| Where it comes from | `budget.ts` `DEFAULT_ALLOCATION_USD` (coder $5, manager $3, assistant $3, tester $2.50, opposer $2, enhancer/summarizer $0.50, …) | `jcode usage --json`, `opencode auth list`, `claude auth status`, and our own `company/projects/*/cost.jsonl` |
| What it is | An internal throttle this codebase invented | Provider-reported quota + measured spend |
| What happens at the limit | `canAfford()` returns false; the agent is refused (a soft, self-imposed stop) | Claude returns **429**, opencode/provider calls fail, roles fall back |
| Is it real money? | No. No card, no invoice, no provider awareness | For Claude, yes — it is the subscription you actually pay for |
| Can it be wrong? | Yes, it is arbitrary | Only as wrong as the CLI it reads from (and it says so) |

## What is measurable

Run these from the project root. All are read-only, no spend.

```powershell
# Quota JSON for every connected provider (the primary source).
# --no-update matters: without it jcode performs an update check first and can
# block for minutes when the network is unreachable (observed 2026-09-29).
jcode usage --json --no-update

# Human-readable form (same data, progress bars). Also needs --no-update.
jcode usage --no-update

# Which credentials opencode actually holds.
opencode auth list

# Subscription plan behind the Claude OAuth token.
claude auth status

# Measured spend from opencode's own local session DB (all projects, 3 days).
opencode stats
opencode stats --models      # per-model cost/token breakdown
opencode stats --days 7 --models
```

### 1. Anthropic (Claude) — real quota windows (`source: "cli"`)

`jcode usage --json` reports the rolling windows directly:

```json
{ "name": "5-hour window", "usage_percent": 2.0, "reset_in": "3h 22m" }
{ "name": "7-day window",  "usage_percent": 0.0, "reset_in": "23h 32m" }
```

This is the genuine limit on Claude roles (manager, opposer, the CEO assistant). When a window
fills, `claudeSubscription.ts` gets a **429** and the role falls back (`runRouterRole` already
routes to DeepSeek on 429). `plan` comes from `claude auth status` -> `subscriptionType: "pro"`.

> Reliability note: `usage.ts` always passes `--no-update`. A plain `jcode usage` can stall on
> its automatic update check when outbound network is unavailable; if the CLI ever fails or
> times out (25 s), `providerUsage()` returns a single `source: "unavailable"` entry naming the
> command and the reason instead of hanging or guessing.

### 2. OpenCode Go — key state + local measured spend (`source: "cli"`)

```json
"Key status": "valid"
"Local spend (this machine)": "$0.81 today · $0.81 this month · $0.81 all-time"
```

One key covers GLM / DeepSeek / Kimi / Qwen (`gateway.ts`). **No quota percentage is exposed
here** — the CLI reports validity and locally measured spend only. This module therefore leaves
`windows` empty and sets `measuredSpendUsd` from the all-time figure. It does not invent a
remaining-quota percentage.

### 3. Our own per-call ledger (`source: "measured"`)

`company/projects/<id>/cost.jsonl` gets one line per real call:

```json
{"ts":"2026-09-29T09:55:19.857Z","modelId":"kimi-k2.7-code","costUsd":0.013421,"note":"coder-2 smumi2lz2-coder-2"}
```

`measuredSpendByModel()` aggregates every `cost.jsonl` into `{ model, calls, costUsd }`.
`providerUsage()` also emits this ledger as one `source: "measured"` row (`provider: "Local cost
ledger (measured per call)"`) so the dashboard can put real measured spend next to the quota
windows.
Caveat, stated honestly: opencode runs carry the runtime's own per-call cost (`part.cost` from
`--format json`), while router roles use a flat per-run estimate
(`budget.ts ROUTER_RUN_COST_USD`) when the provider reports no cost. So the `measured` numbers
are the best available record of what was spent, not a provider invoice.
If no `cost.jsonl` exists, it falls back to the latest record per session in
`company/sessions.jsonl`.

## What is NOT measurable here

- **OpenCode Go remaining quota as a percentage.** The CLI exposes key validity and local
  spend, not a quota endpoint. → `windows` omitted, `measuredSpendUsd` set,
  `detail` says "Local spend (this machine)…".
- **OpenAI (ChatGPT).** Currently *unavailable*: the OAuth refresh token is broken
  (`refresh_token_reused`), so `jcode usage` returns an `error` for that provider. The module
  reports `source: "unavailable"` with that exact reason and no numbers. Fix with
  `/login openai`, then it becomes measurable again.
- **DeepSeek / Kimi / GLM individual quotas.** These are reached through the single OpenCode Go
  key; the provider exposes no separate quota. → unavailable as separate quotas, covered by (2).
- **Anything not in `jcode usage --json`.** If the CLI does not report it, we do not guess.

## Code

`src/company/usage.ts`:

```ts
export type ProviderUsage = {
  provider: string;
  source: "cli" | "measured" | "unavailable";
  plan?: string;
  windows?: Array<{ label: string; usedPct?: number; resetsIn?: string; note?: string }>;
  measuredSpendUsd?: number;
  calls?: number;
  detail: string;
  capturedAt: string;
};

export function providerUsage(): Promise<ProviderUsage[]>;
export function measuredSpendByModel(): Array<{ model: string; calls: number; costUsd: number }>;
```

`maskSensitive()` redacts emails, UUID account/org ids, and tokens before anything leaves the
module. `ops/usage-probe.ts` prints the tables **plus the raw evidence it used** (masked).

```powershell
npx tsx ops/usage-probe.ts            # provider table + measured spend + raw evidence
npx tsx ops/usage-probe.ts --json     # machine-readable
npx tsx ops/usage-probe.ts --no-raw   # tables only
```

## Route for `src/server.ts` (hand this to whoever owns server.ts)

Import (next to the other `./company/*.js` imports):

```ts
import { providerUsage, measuredSpendByModel } from "./company/usage.js";
```

Route (goes with the other `GET /company/*` endpoints):

```ts
app.get("/company/provider-usage", async (_req, res) => {
  try {
    res.json({ capturedAt: new Date().toISOString(), providers: await providerUsage(), measuredByModel: measuredSpendByModel() });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
```
