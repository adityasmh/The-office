# Report — STALE-CHECKS (2026-10-06)

Order: `docs/ORDER_2026-10-06_stale-checks.md` (follow-up to POLICY-GO-FIRST, `docs/REPORT_2026-10-06_POLICY-GO-FIRST.md` §4 item 1).

Result: **done, all checks pass.** Both older checks now assert the go-first rule (a healthy OpenCode
Go window keeps the call on Go at ANY hour, off-peak included) and the old "off-peak -> DeepSeek
direct" rule survives only behind the opt-in `DEEPSEEK_OFFPEAK_DIRECT=1`, which each file now pins
explicitly for the cases that still test it. Only the two allowed files were edited. No `.env`,
`src/`, router, Laya, Kafka or scheduled-task change; no new network call beyond the off-peak
check's own pre-existing opt-in live ping (see §4).

## 1. Diff summary (file + line ranges)

### `ops/deepseek-offpeak-check.ts` (now 234 lines)
- **5** — header: added one line naming the rule now tested (POLICY-GO-FIRST 2026-10-06).
- **82** — `saved` also captures `DEEPSEEK_OFFPEAK_DIRECT` (so the real value is restored).
- **87-89** — the clean gate baseline now also does `delete process.env.DEEPSEEK_OFFPEAK_DIRECT`,
  so the default cases below test the NEW default.
- **123-127** — case "armed, off-peak -> direct" (was 118-119): pinned with
  `process.env.DEEPSEEK_OFFPEAK_DIRECT = "1"` (line 125) and relabelled
  `armed, off-peak + DEEPSEEK_OFFPEAK_DIRECT=1 -> direct (the old rule)` (line 127).
- **142-147** — opt-in cleared after the boundary-buffer case (line 142), then the **new** default
  case (lines 143-147):
  `off-peak + healthy quota (no opt-in) -> OpenCode Go, no credits` (+ the why-line check).
- **162-177** — Kimi section (was 148-161): the off-peak mapping case (was 152-153) is pinned with
  the opt-in and relabelled `... at off-peak + DEEPSEEK_OFFPEAK_DIRECT=1`; `a kimi pick stays on Go
  at peak when the Go quota is UNKNOWN` now expects `false` (was `true`, the superseded CEO order B
  rule — see §4 note 1).
- **187-188** — restore `DEEPSEEK_OFFPEAK_DIRECT` alongside the other saved env vars.

### `ops/budget-guard-direct-check.ts` (now 239 lines)
- **6-7** — header: added one line naming the rule now tested; the case list (a)/(c) updated and
  (a2) added (lines 14-17).
- **102** — `saved.offpeakDirect = process.env.DEEPSEEK_OFFPEAK_DIRECT`.
- **110-112** — clean baseline `delete process.env.DEEPSEEK_OFFPEAK_DIRECT`.
- **138-140** — case (a) pinned with `DEEPSEEK_OFFPEAK_DIRECT = "1"` (label unchanged: "NOT held").
- **152** — opt-in cleared.
- **158-165** — **new** case (a2): the go-first default — `red + deepseek model + off-peak, default
  (no opt-in) -> held (go-first: stays on Go)`.
- **167-172** — case (c) Kimi at off-peak pinned with the opt-in for the duration of the case.
- **216-219** — finally-block restore now includes `DEEPSEEK_OFFPEAK_DIRECT`.

Nothing else was edited.

## 2. Order requirements vs what was done

| Order step | Done |
|---|---|
| offpeak-check 118-119 off-peak-direct case | opt-in pinned (kept meaningful: tests the preserved rule) |
| offpeak-check 152-153 kimi off-peak-direct case | opt-in pinned |
| budget-guard 131-142 case a | opt-in pinned |
| budget-guard 151-152 case c | opt-in pinned |
| one new case per file proving the default | offpeak `142-147`, budget-guard `158-165` (a2) |
| one header line per file | offpeak `5`, budget-guard `6` |
| run both checks + `tsc` once each | §3 |

## 3. Runs (once each, foreground)

### 3.1 `npx tsx ops/deepseek-offpeak-check.ts` — exact output

```
DeepSeek off-peak check (docs/DEEPSEEK_DIRECT.md)
==============================================================================

WINDOW MATH (peak = 01:00-04:00 and 06:00-10:00 UTC, Mon-Fri)
PASS  Thu 11:00Z (16:30 IST) off-peak  got="off-peak" want="off-peak"
PASS  Thu 02:00Z (07:30 IST) peak  got="peak" want="peak"
PASS  Thu 08:00Z (13:30 IST) peak  got="peak" want="peak"
PASS  Thu 05:00Z (10:30 IST) off-peak (gap between blocks)  got="off-peak" want="off-peak"
PASS  Thu 01:00Z boundary -> peak  got="peak" want="peak"
PASS  Thu 04:00Z boundary -> off-peak  got="off-peak" want="off-peak"
PASS  Thu 10:00Z boundary -> off-peak  got="off-peak" want="off-peak"
PASS  Sat 02:00Z (weekend) off-peak  got="off-peak" want="off-peak"
PASS  Sun 08:00Z (weekend) off-peak  got="off-peak" want="off-peak"
PASS  Fri 23:00Z next change = Mon 01:00Z (whole weekend off-peak)  got="2026-10-05T01:00:00.000Z" want="2026-10-05T01:00:00.000Z"
PASS  IST rendering  got="2026-10-01 16:30 IST (Thu)" want="2026-10-01 16:30 IST (Thu)"

NOW
  UTC            2026-10-05 20:00 UTC
  IST            2026-10-06 01:30 IST (Tue)
  phase          off-peak (0.5x)
  next change    2026-10-06 01:00 UTC  |  2026-10-06 06:30 IST (Tue)  (in 300m)
  clear of the 45m boundary buffer: true
  IST windows    peak 06:30-09:30 & 11:30-15:30 | off-peak 15:30-06:30 (overnight), all Saturday and Sunday

ROUTING
  DEEPSEEK_DIRECT armed: true   key present: true
  fleet provider: deepseek
  sample (deepseek-flash): use=false -> deepseek-flash @ https://api.deepseek.com
  why: Go quota unknown: using OpenCode Go and learning from a Go 429 (no credits spent on a guess)

GATE (fake key in-process; no call is made)
PASS  DEEPSEEK_DIRECT unset -> no direct  got=false want=false
PASS  DEEPSEEK_DIRECT unset -> no direct bank in Laya's catalogue  got=false want=false
PASS  no key -> no direct  got=false want=false
PASS  no key -> no direct bank in Laya's catalogue  got=false want=false
PASS  no key -> the reason names the missing key  got=true want=true
PASS  armed, off-peak + DEEPSEEK_OFFPEAK_DIRECT=1 -> direct (the old rule)  got=true want=true
PASS  fleet id deepseek-v4.1-flash -> direct id deepseek-flash  got="deepseek-flash" want="deepseek-flash"
PASS  Go id deepseek-v4-flash -> direct id deepseek-flash  got="deepseek-flash" want="deepseek-flash"
PASS  an already-direct id stays deepseek-flash  got="deepseek-flash" want="deepseek-flash"
PASS  pro -> deepseek-flash (CEO order A: flash only)  got="deepseek-flash" want="deepseek-flash"
PASS  reasoner -> deepseek-flash (CEO order A: flash only)  got="deepseek-flash" want="deepseek-flash"
PASS  direct plan names the direct provider  got="deepseek" want="deepseek"
PASS  armed -> Laya's catalogue names the direct bank  got=true want=true
PASS  armed -> no new model id is invented for the catalogue  got=false want=false
PASS  peak 02:00Z -> stays on Go  got=false want=false
PASS  30m before a peak block -> stays on Go (boundary buffer)  got=false want=false
PASS  off-peak + healthy quota (no opt-in) -> OpenCode Go, no credits  got=false want=false
PASS  ...and the why is the go-first sentence  got=true want=true
PASS  peak 02:00Z + DEEPSEEK_DIRECT_ALL_HOURS=1 -> direct (the .env line)  got=true want=true
PASS  peak 08:00Z + DEEPSEEK_DIRECT_ALL_HOURS=1 -> direct  got=true want=true
PASS  a kimi pick maps to DeepSeek direct at off-peak + DEEPSEEK_OFFPEAK_DIRECT=1  got=true want=true
PASS  a kimi pick maps to deepseek-flash  got="deepseek-flash" want="deepseek-flash"
PASS  a kimi pick stays on Go at peak with a KNOWN healthy quota  got=false want=false
PASS  a kimi pick stays on Go at peak when the Go quota is UNKNOWN (POLICY-GO-FIRST)  got=false want=false

LIVE
  model sent: deepseek-flash
  reply: "OK"  (542ms)
  usage: {"prompt_tokens":42,"completion_tokens":15,"total_tokens":57,"prompt_tokens_details":{"cached_tokens":0},"completion_tokens_details":{"reasoning_tokens":13},"prompt_cache_hit_tokens":0,"prompt_cache_miss_tokens":42}

OK
```

All-pass line: **`OK`** (exit 0).

### 3.2 `npx tsx ops/budget-guard-direct-check.ts` — exact output

```
budget guard x DeepSeek direct: does a Fleet order still wait?
==============================================================================

PASS  precondition: Go red + non-urgent -> the guard queues
        queue=true :: waiting for budget: OpenCode Go is red (6% left) and this order is not urgent
PASS  (a) red + deepseek model + off-peak 11:00Z + armed + ready -> NOT held
        hold=false :: budget: skipped hold, runs on DeepSeek direct (off-peak, no Go quota)
PASS  (a) ... and the plan really is DeepSeek direct
        {"use":true,"provider":"deepseek","model":"deepseek-flash","baseUrl":"https://api.deepseek.com","key":"check-only-not-a-real-key","why":"off-peak: half price (0.5x, 2026-10-01 16:30 IST (Thu)), 840m to the next change, no Go quota spent"}
PASS  (b) same at peak 02:00Z -> held
        hold=true :: waiting for budget: OpenCode Go is red (6% left) and this order is not urgent
PASS  (a2) red + deepseek model + off-peak, default (no opt-in) -> held (go-first: stays on Go)
        hold=true :: waiting for budget: OpenCode Go is red (6% left) and this order is not urgent
PASS  (c) red + Kimi model + off-peak -> NOT held (kimi maps to DeepSeek direct)
        hold=false :: budget: skipped hold, runs on DeepSeek direct (off-peak, no Go quota)
PASS  (d) an unlaunchable provider -> fleetDirectReady() is false
        fleetDirectReady=false
PASS  (d) not ready -> held
        hold=true :: waiting for budget: OpenCode Go is red (6% left) and this order is not urgent
INFO  real `jcode model list -p deepseek` probe on this box: fleetDirectReady=true (the CEO has logged the provider in)
PASS  (e) Go amber -> not held, unchanged (deepseek model at 2026-10-01T11:00:00Z)
        hold=false :: OpenCode Go amber
PASS  (e) Go amber -> not held, unchanged (deepseek model at 2026-10-01T02:00:00Z)
        hold=false :: OpenCode Go amber
PASS  (e) Go green -> not held, unchanged (deepseek model at 2026-10-01T11:00:00Z)
        hold=false :: OpenCode Go green
PASS  (e) Go green -> not held, unchanged (deepseek model at 2026-10-01T02:00:00Z)
        hold=false :: OpenCode Go green
PASS  extra: DEEPSEEK_DIRECT=1 but no key -> held
        hold=true :: waiting for budget: OpenCode Go is red (6% left) and this order is not urgent

OK - all cases pass
```

All-pass line: **`OK - all cases pass`** (exit 0).

### 3.3 `npx tsc --noEmit`

Exact output: **no output, exit 0** (`TS_EXIT=0`).

## 4. Open issues / notes

1. **One extra superseded expectation had to change to make the run pass, inside the allowed
   file.** `ops/deepseek-offpeak-check.ts` old lines 156-161 asserted "a kimi pick routes direct at
   peak when the Go quota is UNKNOWN (CEO order B)". POLICY-GO-FIRST (§1, `375-377`) also replaced
   that rule with `unknown/stale -> OpenCode Go`, so it failed with the exact go-first why line
   `Go quota unknown: using OpenCode Go and learning from a Go 429 (no credits spent on a guess)`.
   That is the same class of stale pre-2026-10-06 expectation the order targets (not a new defect),
   so its expectation was flipped to `false` and the label now says `(POLICY-GO-FIRST)`. The
   budget-guard check needed no equivalent extra change: its post-policy failures were exactly
   cases (a) and (c).
2. **The off-peak check makes its own one minimal live DeepSeek call** because this box's `.env` has
   `DEEPSEEK_API_KEY` and the order required running `npx tsx ops/deepseek-offpeak-check.ts` exactly
   (no `--no-live`). Output: `reply: "OK"`, 57 tokens, 542ms. Every checkbox case used stubs and the
   injected clock; no other network call was made (`ops/budget-guard-direct-check.ts` uses synthetic
   guard snapshots only, and its one subprocess is a local `jcode model list -p deepseek` probe).
   Use `--no-live` if a token-free run is wanted next time.
3. **`DEEPSEEK_DIRECT_ALL_HOURS=1`** still routes DeepSeek-family ids direct at all hours, and both
   files keep testing it explicitly (off-peak check lines 148-161). Unchanged by this order.
4. **Method note:** `git diff` produced no output for these paths — this working tree shows all repo
   files staged-deleted with `ops/` present as untracked copies (`git status --short` = `D` + `??`),
   so the line ranges above were taken by reading the final files directly, not from a diff.
5. **Timing note (honest bookkeeping):** the three commands in §3 were each run once, and after them
   the off-peak header was tidied by restoring the dropped `* Three things, in order:` heading next
   to the new rule line (a JSDoc-comment-only change, +2 lines, lines 6-7). A comment cannot change
   the checked behaviour or `tsc`, and no command was re-run (the order says once each), so §3 is the
   output of the same logic the final files contain.
