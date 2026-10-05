# Report — POLICY-GO-FIRST (2026-10-06)

Order: `docs/ORDER_2026-10-06_policy-go-first.md` (CEO: "only use DeepSeek with credits when
OpenCode is exhausted").

Result: **done, all checks pass.** DeepSeek credits are now spent only when OpenCode Go is
exhausted (binding quota < 10%, or a Go 429 within the last 10 minutes). A healthy Go window
carries the call at ANY hour, off-peak included. The old off-peak rule is preserved behind the
explicit opt-in `DEEPSEEK_OFFPEAK_DIRECT=1`.

## 1. Diff summary (file + line ranges)

### `src/company/deepseekDirect.ts` (only functional change)
- **6-12** — header WHY block rewritten: credits only when Go is exhausted; opt-in named.
- **27** — env list: added `DEEPSEEK_OFFPEAK_DIRECT=1          opt-in: restore "off-peak is half price, use direct"`.
- **190-204** — routing-POLICY comment block rewritten to POLICY-GO-FIRST.
- **215-220** — `GO_QUOTA_UNKNOWN_WHY` re-documented and reworded to the go-first sentence:
  `"Go quota unknown: using OpenCode Go and learning from a Go 429 (no credits spent on a guess)"`.
- **337-377** — `deepseekDirectPlan` decision body (name/inputs/output shape unchanged):
  - 337-338: quota view + `below` unchanged (`remainingPct < goQuotaBelowPct()`, default 10).
  - 340-342: `below` -> direct (`quotaWhy`), unchanged.
  - 344-346: `goExhausted()` -> direct, unchanged.
  - 349-373: **new** known-healthy branch: OpenCode Go at ANY hour with
    `OpenCode quota <%> left: using OpenCode Go, no credits spent`; when
    `DEEPSEEK_OFFPEAK_DIRECT=1` and off-peak, restores the old direct rule (with the 45-min
    boundary buffer).
  - 375-377: **changed** unknown/stale/disconnected -> OpenCode Go (`GO_QUOTA_UNKNOWN_WHY`)
    instead of direct.
  - Removed: the old off-peak-by-default direct block and the `!quota.known && !directInCoolOff()`
    direct rule. `DEEPSEEK_DIRECT_ALL_HOURS=1` override (line 327) and the inert-when-off /
    no-key / Claude guards are untouched.

### `ops/deepseek-policy-check.ts`
- **9-22** — header matrix description updated (a, g, j, k).
- **44** — added `delete process.env.DEEPSEEK_OFFPEAK_DIRECT;` to the clean baseline.
- **175-181** — matrix expectation: `expectDirect = below` (0%/9% only); healthy (10%,63%) and
  unknown/stale -> Go.
- **229-241** — section g: buffer now gates the opt-in only; off-peak in buffer + 63% -> Go.
- **243-263** — **new** section j: healthy quota -> Go at any hour; unknown off-peak -> Go.
- **265-281** — **new** section k: `DEEPSEEK_OFFPEAK_DIRECT=1` restores the old off-peak result;
  peak still Go; quota<10% still wins; buffer holds under the opt-in.

### `ops/deepseek-only-check.ts` (one expectation updated, as the order allows)
- **8-12** — header bullet A updated to the go-first off-peak behaviour.
- **233-250** — section A: "off-peak + ready terminal -> old skip" changed to "off-peak + healthy
  quota -> now held (go-first)"; added a companion check that `DEEPSEEK_OFFPEAK_DIRECT=1` restores
  the old `FLEET_DIRECT_SKIP_REASON` skip.
  This was the only failure of the three checks after the policy change, and it failed **only**
  because it expected the old off-peak rule (hold=false with `DEEPSEEK_DIRECT_ALL_HOURS` unset and
  a healthy 63% quota). No other reason.

Nothing else was edited.

## 2. Coverage vs the order's Proof list

| Required case | Covered | Result |
|---|---|---|
| off-peak, quota 63% -> Go | matrix a (off-peak/63%) + j | PASS |
| off-peak, quota 9% -> DeepSeek | matrix a (off-peak/9%) | PASS |
| off-peak, quota 0% (weekly binding) -> DeepSeek | matrix a + b | PASS |
| peak, quota 63% -> Go | matrix a (peak/63%) + j | PASS |
| quota unknown off-peak -> Go | matrix a (off-peak/unknown) + j | PASS |
| fresh Go 429 -> DeepSeek for 10 min | f + f2 (through the real choke point) | PASS |
| `DEEPSEEK_OFFPEAK_DIRECT=1` restores old off-peak result | k | PASS |
| flags off -> unchanged | h | PASS |

## 3. Runs (once each, foreground)

### 3.1 `npx tsc --noEmit` (run twice: once before, once after the allowed only-check edit)
Exact output both times: **no output, exit 0.**

### 3.2 `npx tsx ops/deepseek-policy-check.ts` — exact output

```
DeepSeek routing POLICY (injected clock + snapshot + stub HTTP)
====================================================================================

a. {off-peak,peak} x {0%,9%,10%,63%,unknown,stale} x {deepseek,kimi,glm}
PASS  off-peak / 0% / deepseek-v4.1-flash -> deepseek
        deepseek :: quota 0% < 10%: weekly window, resets Mon 05:30 IST
PASS  ...the why names the rule (off-peak/0%/deepseek-v4.1-flash)
        quota 0% < 10%: weekly window, resets Mon 05:30 IST
PASS  ...the direct id is deepseek-flash (deepseek-v4.1-flash)
        model=deepseek-flash
PASS  off-peak / 0% / kimi-k2.7-code -> deepseek
        deepseek :: quota 0% < 10%: weekly window, resets Mon 05:30 IST
PASS  ...the why names the rule (off-peak/0%/kimi-k2.7-code)
        quota 0% < 10%: weekly window, resets Mon 05:30 IST
PASS  ...the direct id is deepseek-flash (kimi-k2.7-code)
        model=deepseek-flash
PASS  off-peak / 0% / glm-5.3-flash -> deepseek
        deepseek :: quota 0% < 10%: weekly window, resets Mon 05:30 IST
PASS  ...the why names the rule (off-peak/0%/glm-5.3-flash)
        quota 0% < 10%: weekly window, resets Mon 05:30 IST
PASS  ...the direct id is deepseek-flash (glm-5.3-flash)
        model=deepseek-flash
PASS  off-peak / 9% / deepseek-v4.1-flash -> deepseek
        deepseek :: quota 9% < 10%: weekly window, resets Mon 05:30 IST
PASS  ...the why names the rule (off-peak/9%/deepseek-v4.1-flash)
        quota 9% < 10%: weekly window, resets Mon 05:30 IST
PASS  ...the direct id is deepseek-flash (deepseek-v4.1-flash)
        model=deepseek-flash
PASS  off-peak / 9% / kimi-k2.7-code -> deepseek
        deepseek :: quota 9% < 10%: weekly window, resets Mon 05:30 IST
PASS  ...the why names the rule (off-peak/9%/kimi-k2.7-code)
        quota 9% < 10%: weekly window, resets Mon 05:30 IST
PASS  ...the direct id is deepseek-flash (kimi-k2.7-code)
        model=deepseek-flash
PASS  off-peak / 9% / glm-5.3-flash -> deepseek
        deepseek :: quota 9% < 10%: weekly window, resets Mon 05:30 IST
PASS  ...the why names the rule (off-peak/9%/glm-5.3-flash)
        quota 9% < 10%: weekly window, resets Mon 05:30 IST
PASS  ...the direct id is deepseek-flash (glm-5.3-flash)
        model=deepseek-flash
PASS  off-peak / 10% / deepseek-v4.1-flash -> opencode-go
        opencode-go :: OpenCode quota 10% left: using OpenCode Go, no credits spent
PASS  ...the why names the rule (off-peak/10%/deepseek-v4.1-flash)
        OpenCode quota 10% left: using OpenCode Go, no credits spent
PASS  off-peak / 10% / kimi-k2.7-code -> opencode-go
        opencode-go :: OpenCode quota 10% left: using OpenCode Go, no credits spent
PASS  ...the why names the rule (off-peak/10%/kimi-k2.7-code)
        OpenCode quota 10% left: using OpenCode Go, no credits spent
PASS  off-peak / 10% / glm-5.3-flash -> opencode-go
        opencode-go :: OpenCode quota 10% left: using OpenCode Go, no credits spent
PASS  ...the why names the rule (off-peak/10%/glm-5.3-flash)
        OpenCode quota 10% left: using OpenCode Go, no credits spent
PASS  off-peak / 63% / deepseek-v4.1-flash -> opencode-go
        opencode-go :: OpenCode quota 63% left: using OpenCode Go, no credits spent
PASS  ...the why names the rule (off-peak/63%/deepseek-v4.1-flash)
        OpenCode quota 63% left: using OpenCode Go, no credits spent
PASS  off-peak / 63% / kimi-k2.7-code -> opencode-go
        opencode-go :: OpenCode quota 63% left: using OpenCode Go, no credits spent
PASS  ...the why names the rule (off-peak/63%/kimi-k2.7-code)
        OpenCode quota 63% left: using OpenCode Go, no credits spent
PASS  off-peak / 63% / glm-5.3-flash -> opencode-go
        opencode-go :: OpenCode quota 63% left: using OpenCode Go, no credits spent
PASS  ...the why names the rule (off-peak/63%/glm-5.3-flash)
        OpenCode quota 63% left: using OpenCode Go, no credits spent
PASS  off-peak / unknown / deepseek-v4.1-flash -> opencode-go
        opencode-go :: Go quota unknown: using OpenCode Go and learning from a Go 429 (no credits spent on a guess)
PASS  ...the why names the rule (off-peak/unknown/deepseek-v4.1-flash)
        Go quota unknown: using OpenCode Go and learning from a Go 429 (no credits spent on a guess)
PASS  off-peak / unknown / kimi-k2.7-code -> opencode-go
        opencode-go :: Go quota unknown: using OpenCode Go and learning from a Go 429 (no credits spent on a guess)
PASS  ...the why names the rule (off-peak/unknown/kimi-k2.7-code)
        Go quota unknown: using OpenCode Go and learning from a Go 429 (no credits spent on a guess)
PASS  off-peak / unknown / glm-5.3-flash -> opencode-go
        opencode-go :: Go quota unknown: using OpenCode Go and learning from a Go 429 (no credits spent on a guess)
PASS  ...the why names the rule (off-peak/unknown/glm-5.3-flash)
        Go quota unknown: using OpenCode Go and learning from a Go 429 (no credits spent on a guess)
PASS  off-peak / stale / deepseek-v4.1-flash -> opencode-go
        opencode-go :: Go quota unknown: using OpenCode Go and learning from a Go 429 (no credits spent on a guess)
PASS  ...the why names the rule (off-peak/stale/deepseek-v4.1-flash)
        Go quota unknown: using OpenCode Go and learning from a Go 429 (no credits spent on a guess)
PASS  off-peak / stale / kimi-k2.7-code -> opencode-go
        opencode-go :: Go quota unknown: using OpenCode Go and learning from a Go 429 (no credits spent on a guess)
PASS  ...the why names the rule (off-peak/stale/kimi-k2.7-code)
        Go quota unknown: using OpenCode Go and learning from a Go 429 (no credits spent on a guess)
PASS  off-peak / stale / glm-5.3-flash -> opencode-go
        opencode-go :: Go quota unknown: using OpenCode Go and learning from a Go 429 (no credits spent on a guess)
PASS  ...the why names the rule (off-peak/stale/glm-5.3-flash)
        Go quota unknown: using OpenCode Go and learning from a Go 429 (no credits spent on a guess)
PASS  peak / 0% / deepseek-v4.1-flash -> deepseek
        deepseek :: quota 0% < 10%: weekly window, resets Mon 05:30 IST
PASS  ...the why names the rule (peak/0%/deepseek-v4.1-flash)
        quota 0% < 10%: weekly window, resets Mon 05:30 IST
PASS  ...the direct id is deepseek-flash (deepseek-v4.1-flash)
        model=deepseek-flash
PASS  peak / 0% / kimi-k2.7-code -> deepseek
        deepseek :: quota 0% < 10%: weekly window, resets Mon 05:30 IST
PASS  ...the why names the rule (peak/0%/kimi-k2.7-code)
        quota 0% < 10%: weekly window, resets Mon 05:30 IST
PASS  ...the direct id is deepseek-flash (kimi-k2.7-code)
        model=deepseek-flash
PASS  peak / 0% / glm-5.3-flash -> deepseek
        deepseek :: quota 0% < 10%: weekly window, resets Mon 05:30 IST
PASS  ...the why names the rule (peak/0%/glm-5.3-flash)
        quota 0% < 10%: weekly window, resets Mon 05:30 IST
PASS  ...the direct id is deepseek-flash (glm-5.3-flash)
        model=deepseek-flash
PASS  peak / 9% / deepseek-v4.1-flash -> deepseek
        deepseek :: quota 9% < 10%: weekly window, resets Mon 05:30 IST
PASS  ...the why names the rule (peak/9%/deepseek-v4.1-flash)
        quota 9% < 10%: weekly window, resets Mon 05:30 IST
PASS  ...the direct id is deepseek-flash (deepseek-v4.1-flash)
        model=deepseek-flash
PASS  peak / 9% / kimi-k2.7-code -> deepseek
        deepseek :: quota 9% < 10%: weekly window, resets Mon 05:30 IST
PASS  ...the why names the rule (peak/9%/kimi-k2.7-code)
        quota 9% < 10%: weekly window, resets Mon 05:30 IST
PASS  ...the direct id is deepseek-flash (kimi-k2.7-code)
        model=deepseek-flash
PASS  peak / 9% / glm-5.3-flash -> deepseek
        deepseek :: quota 9% < 10%: weekly window, resets Mon 05:30 IST
PASS  ...the why names the rule (peak/9%/glm-5.3-flash)
        quota 9% < 10%: weekly window, resets Mon 05:30 IST
PASS  ...the direct id is deepseek-flash (glm-5.3-flash)
        model=deepseek-flash
PASS  peak / 10% / deepseek-v4.1-flash -> opencode-go
        opencode-go :: OpenCode quota 10% left: using OpenCode Go, no credits spent
PASS  ...the why names the rule (peak/10%/deepseek-v4.1-flash)
        OpenCode quota 10% left: using OpenCode Go, no credits spent
PASS  peak / 10% / kimi-k2.7-code -> opencode-go
        opencode-go :: OpenCode quota 10% left: using OpenCode Go, no credits spent
PASS  ...the why names the rule (peak/10%/kimi-k2.7-code)
        OpenCode quota 10% left: using OpenCode Go, no credits spent
PASS  peak / 10% / glm-5.3-flash -> opencode-go
        opencode-go :: OpenCode quota 10% left: using OpenCode Go, no credits spent
PASS  ...the why names the rule (peak/10%/glm-5.3-flash)
        OpenCode quota 10% left: using OpenCode Go, no credits spent
PASS  peak / 63% / deepseek-v4.1-flash -> opencode-go
        opencode-go :: OpenCode quota 63% left: using OpenCode Go, no credits spent
PASS  ...the why names the rule (peak/63%/deepseek-v4.1-flash)
        OpenCode quota 63% left: using OpenCode Go, no credits spent
PASS  peak / 63% / kimi-k2.7-code -> opencode-go
        opencode-go :: OpenCode quota 63% left: using OpenCode Go, no credits spent
PASS  ...the why names the rule (peak/63%/kimi-k2.7-code)
        OpenCode quota 63% left: using OpenCode Go, no credits spent
PASS  peak / 63% / glm-5.3-flash -> opencode-go
        opencode-go :: OpenCode quota 63% left: using OpenCode Go, no credits spent
PASS  ...the why names the rule (peak/63%/glm-5.3-flash)
        OpenCode quota 63% left: using OpenCode Go, no credits spent
PASS  peak / unknown / deepseek-v4.1-flash -> opencode-go
        opencode-go :: Go quota unknown: using OpenCode Go and learning from a Go 429 (no credits spent on a guess)
PASS  ...the why names the rule (peak/unknown/deepseek-v4.1-flash)
        Go quota unknown: using OpenCode Go and learning from a Go 429 (no credits spent on a guess)
PASS  peak / unknown / kimi-k2.7-code -> opencode-go
        opencode-go :: Go quota unknown: using OpenCode Go and learning from a Go 429 (no credits spent on a guess)
PASS  ...the why names the rule (peak/unknown/kimi-k2.7-code)
        Go quota unknown: using OpenCode Go and learning from a Go 429 (no credits spent on a guess)
PASS  peak / unknown / glm-5.3-flash -> opencode-go
        opencode-go :: Go quota unknown: using OpenCode Go and learning from a Go 429 (no credits spent on a guess)
PASS  ...the why names the rule (peak/unknown/glm-5.3-flash)
        Go quota unknown: using OpenCode Go and learning from a Go 429 (no credits spent on a guess)
PASS  peak / stale / deepseek-v4.1-flash -> opencode-go
        opencode-go :: Go quota unknown: using OpenCode Go and learning from a Go 429 (no credits spent on a guess)
PASS  ...the why names the rule (peak/stale/deepseek-v4.1-flash)
        Go quota unknown: using OpenCode Go and learning from a Go 429 (no credits spent on a guess)
PASS  peak / stale / kimi-k2.7-code -> opencode-go
        opencode-go :: Go quota unknown: using OpenCode Go and learning from a Go 429 (no credits spent on a guess)
PASS  ...the why names the rule (peak/stale/kimi-k2.7-code)
        Go quota unknown: using OpenCode Go and learning from a Go 429 (no credits spent on a guess)
PASS  peak / stale / glm-5.3-flash -> opencode-go
        opencode-go :: Go quota unknown: using OpenCode Go and learning from a Go 429 (no credits spent on a guess)
PASS  ...the why names the rule (peak/stale/glm-5.3-flash)
        Go quota unknown: using OpenCode Go and learning from a Go 429 (no credits spent on a guess)

b. 5-hour window 99% but weekly 0% -> binding weekly -> direct
PASS  binding weekly at 0% -> direct at PEAK
        quota 0% < 10%: weekly window, resets Mon 05:30 IST
PASS  the why names the weekly window + reset
        quota 0% < 10%: weekly window, resets Mon 05:30 IST

c. no DeepSeek key -> Go (even at quota 0%)
PASS  no key -> use=false
        no DEEPSEEK_API_KEY in .env (top up and paste the key)
PASS  the why names the missing key
        no DEEPSEEK_API_KEY in .env (top up and paste the key)

g. after POLICY-GO-FIRST the boundary buffer gates the off-peak opt-in only
PASS  off-peak in the buffer + quota 9% -> direct
        quota 9% < 10%: weekly window, resets Mon 05:30 IST
PASS  off-peak in the buffer + quota 63% -> Go (go-first; the buffer only gates the opt-in)
        OpenCode quota 63% left: using OpenCode Go, no credits spent

j. healthy quota -> OpenCode Go, off-peak included (no credits spent)
PASS  off-peak / quota 10% -> OpenCode Go, no credits
        OpenCode quota 10% left: using OpenCode Go, no credits spent
PASS  off-peak / quota 63% -> OpenCode Go, no credits
        OpenCode quota 63% left: using OpenCode Go, no credits spent
PASS  peak / quota 10% -> OpenCode Go, no credits
        OpenCode quota 10% left: using OpenCode Go, no credits spent
PASS  peak / quota 63% -> OpenCode Go, no credits
        OpenCode quota 63% left: using OpenCode Go, no credits spent
PASS  off-peak / quota unknown -> OpenCode Go (never guess credits)
        Go quota unknown: using OpenCode Go and learning from a Go 429 (no credits spent on a guess)

k. DEEPSEEK_OFFPEAK_DIRECT=1 restores "off-peak -> DeepSeek direct"
PASS  opt-in + off-peak + 63% -> direct (the old rule)
        off-peak: half price (0.5x, 2026-10-01 16:30 IST (Thu)), 840m to the next change, no Go quota spent
PASS  opt-in + peak + 63% -> still OpenCode Go
        OpenCode quota 63% left: using OpenCode Go, no credits spent
PASS  opt-in + off-peak + 9% -> direct (quota rule wins)
        quota 9% < 10%: weekly window, resets Mon 05:30 IST
PASS  opt-in + off-peak in the buffer + 63% -> Go (buffer holds)
        off-peak but only 30m from the next phase change (buffer 45m; pricing uses an undocumented start/end rule)

f. Go 429 GoUsageLimitError sets go-exhausted (10 min) -> direct at peak + 63%
PASS  peak + 63% -> Go before the 429
        OpenCode quota 63% left: using OpenCode Go, no credits spent
PASS  go-exhausted -> direct even at peak + 63%
        go-exhausted: OpenCode Go 429'd within the last 10 minutes, routing direct
PASS  goExhausted() reports true
        true
f2. the choke point marks go-exhausted on a Go 429 usage limit
PASS  Go 429 -> served direct (one fallback)
        direct ok
PASS  go-exhausted was marked
        true

d. direct in cool-off + Go at 0% -> error surfaces (no pointless fallback)
PASS  error surfaces (both providers unusable)
        deepseek-v4.1-flash 429: {"type":"error","error":{"type":"GoUsageLimitError","message":"Go usage limit exceeded"}}
PASS  direct was NOT dialed (cool-off respected)
        dsCalls=0

e. direct 429 + Go binding 0% -> error surfaces (no fallback to exhausted Go)
PASS  error surfaces and names the exhausted Go window
        gateway: deepseek direct (deepseek-flash) failed: Error: deepseek-direct deepseek-flash 429: {"error":{"message":"too many requests"}} | Go binding window is 0%/exhausted, no fallback
PASS  Go was NOT dialed (binding window 0%)
        goCalls=0

h. flags off -> byte-for-byte today's behaviour (no direct)
PASS  flags off -> use=false
        DEEPSEEK_DIRECT is not 1 (feature off)
PASS  a kimi pick is NOT mapped to deepseek
        FLEET_DEEPSEEK_ONLY is not 1 (DeepSeek-only switch off)

i. every DeepSeek direct model id is deepseek-flash (CEO order A)
PASS  deepseekDirectModel(kimi-k2.7-code) === deepseek-flash
        deepseek-flash
PASS  deepseekDirectModel(qwen3.8-flash) === deepseek-flash
        deepseek-flash
PASS  deepseekDirectModel(glm-5.3-flash) === deepseek-flash
        deepseek-flash
PASS  deepseekDirectModel(deepseek-v4-pro) === deepseek-flash
        deepseek-flash
PASS  deepseekDirectModel(deepseek-reasoner) === deepseek-flash
        deepseek-flash
PASS  deepseekDirectModel(deepseek-v4.1-flash) === deepseek-flash
        deepseek-flash
PASS  deepseekDirectModel(deepseek-v4-flash) === deepseek-flash
        deepseek-flash
PASS  deepseekDirectModel(r1) === deepseek-flash
        deepseek-flash
PASS  deepseekDirectModel(thinking-max) === deepseek-flash
        deepseek-flash
PASS  deepseekDirectModel(totally-unknown-model) === deepseek-flash
        deepseek-flash
PASS  deepseekDirectModel((empty)) === deepseek-flash
        deepseek-flash
i2. no `"deepseek-v4-pro"` model literal in any launch/call path
PASS  no quoted deepseek-v4-pro model literal in a launch/call path
        none

Isolation
PASS  ran against its own temp COMPANY_ROOT
        fleetRoot=C:\Users\user\AppData\Local\Temp\jcode-deepseek-policy-18596\fleet
PASS  no orders.json was written
        C:\Users\user\AppData\Local\Temp\jcode-deepseek-policy-18596\fleet\orders.json

OK - all cases pass
```

(The gateway log lines printed after this by the stub runs: `[gateway] go failed (429) -> deepseek direct` and `[gateway] deepseek direct failed (429) -> go`.)

### 3.3 `npx tsx ops/deepseek-fallback-check.ts`
Result line: **`OK - all cases pass`** (exit 0). All cases a, c, d, f, e, e2, b passed, e.g.:
```
PASS  served by direct (direct ok)
PASS  Go 429 -> served by direct
PASS  Go attempted once, direct retried once
        go=1 direct=1
OK - all cases pass
```
No expectation of the old off-peak rule was present; no edit needed.

### 3.4 `npx tsx ops/deepseek-only-check.ts`
First run: **1 FAILURE** — only
`FAIL  red + off-peak + ready terminal -> the OLD skip (unchanged)` with
`hold=true :: waiting for budget: OpenCode Go is red (6% left) and this order is not urgent`.
That is precisely the superseded off-peak rule, so its expectation was updated in its own file
(and a companion `DEEPSEEK_OFFPEAK_DIRECT=1` case added). Re-run: **`OK - all cases pass`**
(exit 0), including:
```
PASS  red + off-peak + healthy quota -> now held (go-first: off-peak stays on Go)
        hold=true :: waiting for budget: OpenCode Go is red (6% left) and this order is not urgent
PASS  red + off-peak + DEEPSEEK_OFFPEAK_DIRECT=1 -> the OLD skip is back
        hold=false :: budget: skipped hold, runs on DeepSeek direct (off-peak, no Go quota)
OK - all cases pass
```

## 4. Open issues

1. **Two older ops checks still assert the pre-2026-10-06 off-peak rule and were NOT edited**
   (outside this order's allowed edit set), so they will fail if run as-is:
   - `ops/deepseek-offpeak-check.ts` lines 118-119 (`armed, off-peak -> direct`) and 152-153
     (`a kimi pick maps to DeepSeek direct at off-peak`).
   - `ops/budget-guard-direct-check.ts` lines 131-142 (case a) and 151-152 (case c): off-peak ->
     not held / direct.
   These are the same class of stale expectation that was fixed in `ops/deepseek-only-check.ts`.
   They need either `DEEPSEEK_OFFPEAK_DIRECT=1` pinned, or the new go-first expectation, in a
   follow-up.
2. **`DEEPSEEK_DIRECT_ALL_HOURS=1` remains an explicit always-direct override** for
   DeepSeek-family ids (kept, as required). If the live `.env` still sets it to 1, DeepSeek-family
   work will still run direct at all hours by operator choice; the off-peak rule itself no longer
   spends credits. `.env` was not read or modified per the order.
3. No router restart, no `.env`/`company/`/Laya/Kafka/scheduled-task change, no network call to
   DeepSeek or OpenCode was made (all checks used injected clock/snapshot and local stubs).
