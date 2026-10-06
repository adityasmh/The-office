# Order B1-audit-tool: AI cost audit tool: analyse a customer's usage export

Context: docs/business/PLAN.md (read the section for this offer first).

Offer B in the plan. A customer gives us a CSV export of their LLM usage; this tool turns it into a report computed only from their data.

## Files
`ops/audit/cost-audit.ts`, `ops/audit/cost-audit-check.ts`, `ops/audit/sample/usage-sample.csv` (FAKE data, clearly labelled in the file name and a first-line comment is not allowed in CSV so name it `usage-sample-FAKE.csv`), `ops/audit/prices.example.json`, `docs/audit/README.md`

## What to build
`npx tsx ops/audit/cost-audit.ts <usage.csv> [--prices prices.json] [--map field=Column ...] [--out report.md] [--html report.html] [--json]`:
- Flexible column mapping. Recognise common names case-insensitively for: date or timestamp, model, input tokens, output tokens, cost in dollars, project or API key or user (optional), request count (optional). `--map date=Day --map cost=Amount` overrides. If a needed column is missing, print which columns were found and which mappings to pass, exit 1. Never guess a unit: cost columns are taken as dollars only if mapped or named like cost/amount/usd.
- Measure, from the data only: total spend and tokens, spend by day, by model and by project/key, top 10 cost drivers, the share of spend from the single biggest model, days with spend above 3 times the median day (spikes) with the date and amount, average input-to-output token ratio per model, and requests (or rows) with unusually large input (above the 95th percentile, show how much spend sits above it, as "possible context bloat").
- Retry or loop signal: when a timestamp has minute resolution or better, find minutes where the row count for one model is more than 5 times that model's median per active minute, and report the minute, the count and the cost of the excess as "possible retry or loop burst". Say plainly it is a signal, not proof.
- Savings estimate ONLY when the user supplies `--prices` (a JSON file `{ "model-name": {"inputPer1M": number, "outputPer1M": number} }`). Ship `prices.example.json` with example model names and clearly fake round numbers marked as examples in a `_note` field; the tool must refuse to estimate with the example file unless `--allow-example-prices` is given, and print "illustrative only" in that case. With real prices it shows, for each model pair the user passes with `--compare modelA=modelB`, what the same token volume would cost on modelB, labelled "if modelB were acceptable for these calls", and never claims it is.
- The Markdown and HTML report ends with two sections: "What I measured" (facts from the file) and "What I am assuming" (every assumption, such as the prices and the comparison), and a closing line that savings need a quality test on a sample of real calls before any switch. The HTML is one self-contained file with no external assets and a simple inline bar chart made with CSS.
- Never print or store customer content: the tool only reads numbers and short labels. Local only, no network.

## Proof (`ops/audit/cost-audit-check.ts`, fixtures built in a temp folder)
PASS or FAIL per line: column auto-detection with two different header styles; `--map` override; missing column gives the helpful message and exit 1; totals and per-model sums match a hand-computed fixture; spike days detected; context-bloat share computed; loop burst detected on a fixture that has one and NOT on a flat fixture; no savings without `--prices`; the example prices are refused without `--allow-example-prices`; with real-looking prices and `--compare` the arithmetic is exact; the report contains both closing sections; HTML has no external URL (search for `http`); the bundled fake sample runs end to end with exit 0.
## Common rules
- Create or edit ONLY the files named in "Files". Other workers run at the same time on other files. Make small targeted edits to any existing file; never rewrite an entire existing file. Match the surrounding style. No new dependencies; Node built-ins only (ES modules, `.js` import suffixes where importing).
- Never restart or start the router. Never read, print or edit `.env`. Never touch `company/`, Laya, Kafka or scheduled tasks. No real network calls in tests. No deletes of existing files.
- Never invent a number, customer, testimonial, logo or price. Any figure shown to a user must come from the data the tool was given or from a clearly labelled assumption the user supplies.
- Run each command ONCE, in the foreground. If a step fails, report the exact error and END your turn; do not retry in a loop.
- Narrow job with an explicit end: write `docs/overnight/REPORT_<stem>.md` (files, exact command output, open issues), print the same report and END your turn. Do not wait, poll, loop, or re-read this order.