# REPORT F04-cost-report: `npx tsx ops/cost-report.ts [--days N] [--by day|provider|model|worker] [--csv|--json]`

Date: 2026-10-06. Order: `docs/overnight/ORDER_F04-cost-report.md`.

## Changed files

- `ops/cost-report.ts` (new) - read-only cost report. Reads `company/projects/*/cost.jsonl`,
  `logs/token-ledger.jsonl` and `logs/worker-providers.jsonl` (JSON lines, malformed lines
  skipped and counted). Prints a table with CALLS, TURNS, TOKENS and COST, and ALWAYS splits it
  into `== Prepaid credits (deepseek) ==` and `== Subscription / quota (opencode-go, claude,
  others) ==`; a worker with no provider record gets a third `Unknown provider (no
  worker-providers record)` block labelled `unknown provider` instead of being folded into the
  other two. One `WARNING:` line when prepaid credits were spent on a day that also had
  `opencode-go` entries. `--by` groups rows inside each block (default `day`, biggest cost
  first), `--days N` keeps the N most recent days present in the data (clock-free), `--csv`
  prints `block,key,calls,turns,tokens,cost_usd` (header + one row per group), `--json` prints
  one object with `blocks[]`, `totals`, `windowDays`, `warning`, `malformedLines`, `sources`.
  Tokens/turns are shown only when a source recorded them (`-` / `null` / empty field). Empty
  data prints a friendly `no data` line and exits 0. Node built-ins only, no network call, no
  process started, nothing written.
- `ops/cost-report-check.ts` (new) - the proof. Runs the real report code against fixture JSONL
  files in temporary folders under the OS temp dir (fixed dates, so no clock dependency) and
  spawns the real CLI once on the real repo (read-only).

Nothing else was edited. `ops/spawn-wave.ps1` was already modified before this order.

## Proof

Command (run once, foreground): `npx --no-install tsx ops/cost-report-check.ts`

```
PASS two blocks are separated: credits first, subscription second, unknown last  -> credits@247; subscription@461; unknown@699
PASS credits block holds only deepseek rows and the subscription block holds only non-deepseek rows  -> credits=2026-10-05|2026-10-06 $0.09; subscription=$0.11; unknown=$0.01
PASS subscription block names the quota providers from the order (opencode-go, claude)  -> keys=opencode-go|claude
PASS grouping by day sums correctly  -> rows=2/2/1
PASS grouping by provider sums correctly  -> credits=deepseek; subscription=opencode-go|claude; unknown=unknown provider
PASS grouping by model sums correctly  -> credits=deepseek-v4-pro
PASS grouping by worker sums correctly
PASS totals are identical for every grouping (calls 5, turns 12, tokens 4611, $0.21)  -> totals={"calls":5,"turns":12,"tokens":4611,"costUsd":0.21}
PASS rows inside a block sort by cost, biggest first  -> subscription by provider: opencode-go=$0.06, claude=$0.05
PASS --days 2 keeps the two most recent days present in the data  -> window=2026-10-05,2026-10-06; totals={"calls":4,"turns":8,"tokens":3011,"costUsd":0.18}
PASS --days 1 keeps only the newest day and its rows  -> window=2026-10-06; rows=1; totals={"calls":1,"turns":0,"tokens":0,"costUsd":0.04}
PASS days larger than the data keeps everything  -> window=2026-10-04,2026-10-05,2026-10-06
PASS malformed lines are skipped and counted (1 provider + 1 ledger + 1 cost + 1 bad day)  -> malformed=4; text has note=true
PASS a malformed cost line's amount never reaches the totals  -> total=$0.21
PASS CSV has a header and the right row count  -> header="block,key,calls,turns,tokens,cost_usd"; lines=6; rows=5
PASS CSV rows carry the right blocks, a raw cost that sums to the total, and a blank for absent tokens  -> costSum=$0.2100; line="credits,2026-10-06,1,0,,0.040000"
PASS JSON parses and carries both blocks, the totals and the warning  -> blocks=credits,subscription,unknown; total=0.21
PASS a worker with no provider record is shown as "unknown provider"  -> unknown rows=2026-10-05
PASS tokens are shown when a source recorded them and "-" / null when it did not  -> oct6 tokens=null; oct4 tokens=1600
PASS exactly one warning line, for the credit day that also had quota (2026-10-05)  -> warning="WARNING: prepaid credits were used on 1 day(s) when quota was available (opencode-go): 2026-10-05"
PASS no warning when the reported window has no quota day (--days 1)  -> warning=null
PASS empty folder prints a friendly "no data" message, exits 0, and still parses as JSON  -> text="cost-report: no data - nothing recorded in company/projects/*/cost.jsonl under C:\\Users\\us"; exit=0; jsonExit=0
PASS the CLI path renders --by/--days and rejects a bad --by with exit 2  -> good=0; bad=2; err="cost-report: --by needs one of day|provider|model|worker, got \"nope\""
PASS real CLI `npx tsx ops/cost-report.ts --json` prints one parsable JSON report and exits 0  -> exit=0; empty=false; rows=7; total=$11.01261199999999
cost-report-check: all checks passed
```

Harness exit code: 0 (24/24 PASS).

Extra check (run once, foreground): `npx --no-install tsc --noEmit --strict --target es2022
--module esnext --moduleResolution bundler ops/cost-report.ts ops/cost-report-check.ts` -> exit 0
(no type errors; the repo-wide `npm run typecheck` was deliberately not used, to avoid unrelated
pre-existing noise).

## Open issues

- Provider attribution needs a `logs/worker-providers.jsonl` record for the same day and worker
  name. `cost.jsonl` notes look like `"enhancer smumi4qyz-enhancer"`, so the whole note and its
  last token are both tried; the real `cost.jsonl` data (2026-09-29) has no provider record for
  those days, so those rows land in the (correct, visible) `unknown provider` block. Real CLI
  totals today: 7 rows, $11.0126, of which the unclassified share is what the manager may want
  to backfill.
- `--days N` means "the N most recent days present in the data", not "the last N calendar days".
  This was chosen so the report is deterministic (no clock in tests) and never empty just
  because the fleet has not run recently. `--days` has no default: without it, every day found
  is reported.
- In `--csv` mode the block is a column (`credits`/`subscription`/`unknown`) rather than blank
  separator lines, so the CSV stays machine-readable and its row count is exactly the number of
  groups. On empty data the CSV prints only the header and the friendly note goes to stderr.
- Exit codes: 0 for a report (including "no data"), 2 for bad arguments. A malformed source line
  is never fatal, it only adds to `malformedLines` / the `note: skipped N malformed line(s)` line.
- Block classification is by provider name only: anything whose provider record is exactly
  `deepseek` is credits, `unknown provider` is the no-record sentinel, everything else is the
  subscription/quota block. A future provider must be classified by that rule (it defaults to
  the subscription block).
