# REPORT B1-audit-tool: `npx tsx ops/audit/cost-audit.ts <usage.csv> [--prices prices.json] [--map field=Column ...] [--out report.md] [--html report.html] [--json]`

Date: 2026-10-06. Order: `docs/overnight/ORDER_B1-audit-tool.md`. Offer B in `docs/business/PLAN.md`.

## Changed files

- `ops/audit/cost-audit.ts` (new) - the audit tool. Reads ONE CSV usage export and prints a report
  computed only from it: totals, spend by day / model / project (when that column exists), the top
  10 cost drivers, the single biggest model's share, spike days (>3x the median day), average
  input:output ratio per model, rows above the 95th percentile input ("possible context bloat") and
  minute-level retry/loop bursts (>5x that model's median active minute). Column auto-detection is
  case- and punctuation-insensitive with per-field candidate lists and safe fallbacks;
  `--map field=Column` overrides it exactly. Cost is only read from a mapped column or one named
  like cost/amount/usd/spend/billed/charge/fee, so a numeric column called `value` is never taken
  as spend. A missing required column prints the columns found, the names looked for and the exact
  `--map` line, then exits 1. A savings estimate exists ONLY with `--prices`
  (`{ "model": { "inputPer1M": n, "outputPer1M": n } }`); `--compare modelA=modelB` prices model A's
  real token volume at model B's rates and labels it "if modelB were acceptable for these calls".
  The shipped `prices.example.json` is refused unless `--allow-example-prices` is given, and then
  every figure is labelled "illustrative only". Markdown ends with "What I measured", "What I am
  assuming" and the closing quality-test line; `--html` is one self-contained file with inline CSS
  bar charts, no external asset and no `http` anywhere. Local only: Node built-ins, no network.
- `ops/audit/cost-audit-check.ts` (new) - the proof. Runs the real pure code against CSV fixtures
  built in temporary folders under the OS temp dir (fixed dates, no clock) and spawns the real CLI
  for the cases judged by exit code. PASS/FAIL per line, exit 1 if anything fails.
- `ops/audit/sample/usage-sample-FAKE.csv` (new) - 28 invented rows, invented models
  (`atlas-small`, `atlas-large`, `nimbus-pro`), one spike day, one loop burst, one very large input.
  Clearly fake in the file name; CSV cannot carry a comment line, so the name is the label.
- `ops/audit/prices.example.json` (new) - four made-up round numbers with `_note` and
  `_example: true`, so the tool refuses them without `--allow-example-prices`.
- `docs/audit/README.md` (new) - how to run it, the recognised columns, what each section means,
  the never-guess-a-unit rule, the prices format, the fake sample, the proof command and the
  data-handling promise.

Nothing else was edited (`git status` shows only `ops/audit/` and `docs/audit/` from this order;
the other new paths belong to other workers running at the same time).

## Proof

Command (run once, foreground): `npx --no-install tsx ops/audit/cost-audit-check.ts`

```
PASS column auto-detection: header style 1 (snake_case) maps every field  -> {"date":"timestamp","model":"model","input":"prompt_tokens","output":"completion_tokens","cost":"cost_usd","group":"project_id"}
PASS column auto-detection: header style 2 (spaces, capitals, parentheses) maps every field  -> {"date":"Usage Date","model":"Model Name","input":"Input Tokens","output":"Output Tokens","cost":"Total Cost (USD)"}
PASS both header styles produce the same numbers without --map  -> {"cost":1.25,"input":3000,"output":600,"tokens":3600,"rows":2,"requests":null}
PASS an unnamed date column is refused with the columns found, a --map suggestion and exit 1  -> exit=1; "cost-audit: cannot read C:\Users\user\AppData\Local\Temp\cost-audit-check-map-zjs2z2\mapping.csv - missing required column(s)."
PASS --map overrides auto-detection and the same file then computes exact totals ($0.15, 300 in, 60 out)  -> exit=0; cost=0.15000000000000002; date=when; cost=charge_usd
PASS a missing cost column gives the helpful message and exit 1  -> exit=1; "cost-audit: cannot read C:\Users\user\AppData\Local\Temp\cost-audit-check-missing-4iDmLr\no-cost.csv - missing required column(s). |   columns found: "date", "model", "input_tokens", "output_tokens", "project", "value""
PASS a numeric column named "value" is never guessed to be spend (the unit is not guessed)  -> suggestion="--map cost="value""
PASS totals match the hand-computed fixture (20 rows, $12.70, 225,500 tokens)  -> {"cost":12.7,"input":219000,"output":6500,"tokens":225500,"rows":20,"requests":null,"skipped":0}
PASS per-model sums and shares match the hand-computed fixture  -> gpt-4o=$9.5/8r/74.80%, claude=$2.4/8r/18.90%, gpt-4o-mini=$0.8/4r/6.30%
PASS spend by day and the median day match the hand-computed fixture  -> days={"2026-10-01":2,"2026-10-02":0.8,"2026-10-03":1.2,"2026-10-04":1.2,"2026-10-05":7.5} median=1.2
PASS the single biggest model and its share are reported  -> {"model":"gpt-4o","cost":9.5,"share":0.7480314960629921}
PASS spend by project is available when the column exists (alpha $2.80, beta $9.90)  -> ["beta=$9.9","alpha=$2.8000000000000007"]
PASS the top cost drivers are ranked model + project  -> gpt-4o / beta=$7.5, claude / beta=$2.4, gpt-4o / alpha=$2, gpt-4o-mini / alpha=$0.8
PASS spike days are detected (only 2026-10-05, $7.50 = 6.25x the median day)  -> [{"day":"2026-10-05","cost":7.5,"medianDayCost":1.2,"multiple":6.25}]
PASS context-bloat share is computed from the 95th percentile input (1 row above, $6.00 = 47.24% of spend)  -> {"threshold":1000,"rowsAbove":1,"rowsTotal":20,"costAbove":6,"shareOfSpend":0.4724409448818898,"shareOfRows":0.05}
PASS average input:output ratio per model matches (gpt-4o 46, gpt-4o-mini 10, claude 5)  -> {"gpt-4o":46,"claude":5,"gpt-4o-mini":10}
PASS a loop burst is detected on the burst fixture (6 rows in one minute vs median 1; $0.50 of excess)  -> [{"model":"alpha-model","minute":"2026-10-01T09:00","count":6,"medianPerActiveMinute":1,"excessRows":5,"excessCost":0.5}]
PASS no loop burst is found on the flat fixture  -> []
PASS no loop burst is found on the main fixture  -> []
PASS no savings estimate without --prices (the report says why, and the JSON has no comparison)  -> prices=null; comparisons=0
PASS the shipped example prices are refused without --allow-example-prices (exit 1, names the flag)  -> exit=1; "cost-audit: refusing to estimate savings from ops\audit\prices.example.json."
PASS with --allow-example-prices every figure from those prices is labelled "illustrative only"  -> exit=0; illustrative=true
PASS with real-looking prices and --compare the arithmetic is exact  -> costOnTo=0.033749999999999995 expected=0.033749999999999995 actual=9.5
PASS the comparison is labelled "if gpt-4o-mini were acceptable for these calls" and claims nothing more  -> heading=### if gpt-4o-mini were acceptable for these calls
PASS the report contains "What I measured" and "What I am assuming"
PASS the report ends with the quality-test closing line (nothing after it)  -> " output is still good enough; run that test before switching anything."
PASS the HTML has no external URL (no "http" anywhere), no script, and an inline CSS bar chart  -> len=7820; bars=8
PASS --out and --html write both reports and the HTML stays self-contained  -> exit=0; md=true; html=7148B
PASS the bundled fake sample runs end to end with exit 0 (28 rows, $6.32, all three signals fire)  -> exit=0; rows=28; cost=6.3199999999999985; spikes=1; bursts=1; bloat=1
PASS the bundled sample is clearly labelled FAKE and is a plain CSV (no first-line comment)  -> usage-sample-FAKE.csv
cost-audit-check: all checks passed
```

Harness exit code: 0 (30/30 PASS).

Extra check (run once, foreground): `npx --no-install tsc --noEmit --strict --target es2022
--module esnext --moduleResolution bundler ops/audit/cost-audit.ts ops/audit/cost-audit-check.ts`
-> exit 0 (the repo-wide `npm run typecheck` was deliberately not used: `tsconfig.json` only
includes `src`, so the ops scripts are outside it).

## Open issues

- Definitions I had to choose, all printed in the report's "What I am assuming":
  the 95th percentile is nearest rank and "above" is strictly greater; spike days are measured
  against the median of the days that appear in the file (not calendar days); the loop-signal
  "cost of the excess" is the minute's cost pro-rated to the rows above the median
  (`minuteCost * (count - median) / count`); the top-10 drivers are model + project/key summed over
  the file; the day is the date as written, with no timezone conversion.
- The loop signal needs timestamps with at least minute resolution. A date-only file produces zero
  bursts with an explicit note, never a silent miss.
- `model` and `group` have no fuzzy name matching on purpose: a wrong guess would silently mix two
  models or two customers. If those columns are not in the candidate lists the tool stops and asks
  for `--map` (proven by the "when" date-column check).
- Cost is a required column: without it there is no spend figure, so the tool exits 1 instead of
  inventing one. It also never guesses the currency; if a mapped cost column is not dollars, the
  totals are wrong in the same proportion, and the report says so.
- Exit codes: 0 for a report, 1 for a missing column / refused example prices / unreadable or
  unusable file, 2 for bad arguments. With `--json`, stdout is one JSON object only; the
  "wrote <file>" notices go to stderr.
- Cleanup is covered: the sample end-to-end check and the `--map` fixture copy live in temp
  folders that are removed in a `finally`, and the repo copy holds only the clearly fake sample.
- Not in this order: no PDF, no email delivery of the report, and no network of any kind. The
  offer page that sells the audit is B2/B3, other workers' files.
