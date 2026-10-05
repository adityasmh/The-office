# DeepSeek direct API + off-peak routing (CEO order, 2026-10-01)

**The problem.** OpenCode Go is a $10/mo subscription with rolling quota windows, and the
window that actually stops work is the **weekly** one. Measured 2026-10-01 16:30 IST:

| Go window | state |
|---|---|
| 5-hour | 84% left |
| **weekly** | **13% left, resets in 3d 12h** |
| monthly | 57% left |

DeepSeek is the fleet's default model (`FLEET_MODEL_STANDARD=deepseek-v4.1-flash`), so most
of the traffic that will flow once the fleet runs freely is DeepSeek-shaped. DeepSeek is
also the only mainstream provider that prices by the **clock**: its own API is **half price**
outside peak hours.

**The order.** Run DeepSeek's own API during its off-peak hours, keep OpenCode Go for peak
and for Kimi/GLM/Qwen. Spend DeepSeek credit instead of Go weekly quota.

## 1. The clock, in India

DeepSeek's pricing footnote, verbatim: *"Off-peak rates are half of the peak rates. Peak
hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday (all other hours are
off-peak)."*

The windows are published in UTC and never move; DST changes only the local mapping, and
**India does not observe DST**, so this table is right all year:

| | IST | UTC |
|---|---|---|
| **Peak** (full price) | **06:30-09:30** and **11:30-15:30**, Mon-Fri | 01:00-04:00, 06:00-10:00 |
| **Off-peak** (0.5x) | **15:30 -> 06:30 next day**, plus **all** Saturday & Sunday | everything else |

So ~79% of the week is off-peak. In IST, peak eats **56% of a 09:00-17:00 working day**,
which is the opposite of the US: the lever here is real, and it is the evening, the night
and the whole weekend.

Boundary caveat, stated honestly: DeepSeek's docs do **not** say whether a request is
priced by its start or its completion, and straddling a boundary is undocumented. The code
therefore refuses to start a direct call in the last 45 minutes of an off-peak window
(`DEEPSEEK_BOUNDARY_BUFFER_MINUTES`).

## 2. What it costs (the estimate)

DeepSeek V4-Flash direct, USD per 1M tokens:

| token type | off-peak | peak |
|---|---|---|
| input, cache hit | $0.007 | $0.014 |
| input, cache miss | $0.22 | $0.44 |
| output | $0.66 | $1.32 |

Measured DeepSeek-shaped traffic on this machine, last 7 days (`opencode stats --days 7
--models`, only the DeepSeek row): 1.4M input, 132.7K output, 60.8M cache read.

Same tokens through DeepSeek direct:

- **off-peak** 60.8x0.007 + 1.4x0.22 + 0.1327x0.66 = **~$0.82 / week**
- peak = **~$1.64 / week**

Honest comparison: OpenCode Go billed **$0.48** for those same tokens. **Go is cheaper per
token than DeepSeek direct.** Nothing about this change makes tokens cheaper - it makes
them *possible*, by moving un-urgent DeepSeek work off a subscription that is 87% through
its weekly window. That is the whole reason to do it.

## 3. How much to buy

Everything is pay-as-you-go credit that does not expire and tops up instantly, so start
lower and add more rather than over-buying. Runway = credit / weekly DeepSeek-direct cost:

| top-up | today's volume (~$0.8/wk) | fleet running freely (~4x, ~$3/wk) | fleet at full tilt (~10x, ~$8/wk) |
|---|---|---|---|
| $5 | ~6 weeks | ~1.5 weeks | ~4 days |
| **$20 (recommended)** | **~6 months** | **~6 weeks** | **~2.5 weeks** |
| $50 | ~15 months | ~4 months | ~6 weeks |

**Buy $20 to start.** It is ~2 weeks of a hard-running fleet and months of today's traffic,
it is instantly topped up again, and it cannot be "wasted" (the credit never expires). Go to
$50 if the fleet is going to be run hard for a month.

## 4. How it works in code

New:

- `src/company/offpeak.ts` - the clock. `isDeepseekPeak`, `deepseekClock`, `formatIst`, and
  the IST window table. Pure, no I/O, no key: testable anywhere.
- `src/company/deepseekDirect.ts` - **the single decision point**. `deepseekDirectPlan(model)`
  returns `{use, provider, model, baseUrl, key, why}` and never throws. Gates, in order:
  not a DeepSeek model -> `DEEPSEEK_DIRECT` not set -> no key -> peak (unless
  `DEEPSEEK_DIRECT_ALL_HOURS=1`) -> inside the 45-minute boundary buffer.
- `src/gateway.ts` `callDeepseekDirect()` - the OpenAI-compatible call to DeepSeek's own
  API (no `x-opencode-session` header; that is Go's routing signal, and DeepSeek does not
  know it).

**Model ids (measured 2026-10-01 against `GET https://api.deepseek.com/models`):** the direct
API accepts exactly **`deepseek-flash`** (DeepSeek-V4.1-Flash, 1M context) and
**`deepseek-v4-pro`**. Both Go spellings of the flash model - `deepseek-v4.1-flash` (the
fleet default) and `deepseek-v4-flash` - map to `deepseek-flash`; pro/reasoner work stays on
`deepseek-v4-pro`. Sending a Go id verbatim is a `400 ... model`, which is exactly what the
first live probe hit; the raw id is never sent any more.
- `ops/deepseek-offpeak-check.ts` - the proof: window math against known timestamps, the
  current clock, and (with a valid key) one real call.

Changed, all additive and env-gated:

- `src/orchestrator.ts` - the `gateway` case asks `deepseekDirectPlan`; if it says use, the
  call goes direct and **OpenCode Go stays the fallback** on any error, so a key problem can
  never fail a call the subscription could have served.
- `src/company/fleet.ts` - `launchTarget(model)` picks the *provider* for a spawned work
  order: DeepSeek's own provider off-peak, the configured `FLEET_PROVIDER` otherwise. The
  `set_model` debug call uses the same mapped id.
- `src/adaptive/catalog.ts` - **this is how Laya is told.** Once the feature is armed (flag
  + key), DeepSeek's own API appears in Laya's catalog as a second bank at the same cost
  rank, labelled with the 0.5x off-peak rate. Before that the catalog is byte-for-byte
  unchanged.

Env (`docs/../.env`, documented in `.env.example`):

```
DEEPSEEK_DIRECT=1            # master switch
DEEPSEEK_API_KEY=sk-...      # platform.deepseek.com -> API keys
DEEPSEEK_DIRECT_MODEL=       # optional: force deepseek-v4-flash / deepseek-v4-pro
DEEPSEEK_PROVIDER=deepseek   # jcode provider id for fleet terminals
DEEPSEEK_DIRECT_ALL_HOURS=0  # 1 = also at peak (2x price, still saves Go quota)
```

## 5. Turning it on

1. Top up at <https://platform.deepseek.com> (the balance is visible there; there is no
   auto-recharge).
2. Create an API key and paste it into `DEEPSEEK_API_KEY` in `.env`.
3. `npx tsx ops/deepseek-offpeak-check.ts` - expect `use: true` outside peak hours and a
   real reply from the live call.
4. Restart the router (`:8787`) when the CEO chooses to; the fleet picks the new provider
   up at the next spawn.

## 6. What this does NOT do

- It does **not** move Claude work (`claude-subscription` is a different bank).
- It does **not** move Kimi/GLM/Qwen traffic; those still spend Go quota.
- It does **not** run at peak unless `DEEPSEEK_DIRECT_ALL_HOURS=1`, because direct at peak
  is 2x off-peak while Go is flat.
- It does **not** verify the `deepseek` provider id inside jcode. Check it with
  `jcode model list -p deepseek` after `jcode login --provider deepseek`; the fleet terminal
  must be launched as `jcode -p deepseek -m deepseek-flash`. The router path needs no
  provider id at all.
- The DeepSeek key opencode stores separately (`.local/share/opencode/auth.json`) was
  invalid on 2026-10-01; the direct path uses `DEEPSEEK_API_KEY` from `.env` instead, and
  the two are unrelated.
