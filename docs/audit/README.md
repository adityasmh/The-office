# The AI cost audit tool (`ops/audit/`)

Offer B in `docs/business/PLAN.md`: a customer sends you the CSV export of their LLM usage
(OpenAI, Anthropic, an agent tool, a gateway - any of them), and this tool turns it into a report
computed **only from their file**. It is local, offline and read-only: no network call, no upload,
no database, and it never reads anything except the usage file you point it at and, if you give
one, a prices file you wrote.

## Run it

```
npx tsx ops/audit/cost-audit.ts <usage.csv> [options]
```

| Option | Meaning |
|---|---|
| `--map field=Column` | Force a column mapping. Repeatable. Fields: `date`, `model`, `input`, `output`, `cost`, `group`, `requests` |
| `--prices prices.json` | Your real prices, `{ "model": { "inputPer1M": n, "outputPer1M": n } }` |
| `--compare modelA=modelB` | With `--prices`: what modelA's tokens would cost on modelB. Repeatable |
| `--out report.md` | Write the Markdown report to a file |
| `--html report.html` | Write a one-file HTML report (inline CSS bar charts, no external assets) |
| `--json` | Print the whole audit as one JSON object on stdout (the version to script against) |
| `--allow-example-prices` | Allow the shipped example prices; every figure from them is then labelled illustrative only |

Without `--out`, `--html` or `--json` the Markdown report goes to stdout. Exit code: `0` for a
report, `1` for a missing column / a refusal / an unreadable file, `2` for bad arguments.

```
npx tsx ops/audit/cost-audit.ts ops/audit/sample/usage-sample-FAKE.csv --html /tmp/audit.html
```

## Columns it recognises

Header names are matched case-insensitively and ignore punctuation, so `Cost (USD)`, `cost_usd`
and `COST` all work.

| Field | Required | Example names |
|---|---|---|
| date or timestamp | yes | `date`, `day`, `timestamp`, `time`, `created_at`, `Usage Date` |
| model | yes | `model`, `model_name`, `model_id`, `engine`, `deployment` |
| input tokens | yes | `input_tokens`, `prompt_tokens`, `tokens_in`, `Input Tokens` |
| output tokens | yes | `output_tokens`, `completion_tokens`, `tokens_out`, `Completion Tokens` |
| cost in dollars | yes | `cost`, `cost_usd`, `amount`, `amount_usd`, `total_cost`, `spend`, `Total Cost (USD)` |
| project / API key / user | no | `project`, `project_id`, `api_key`, `key_name`, `user`, `email`, `team`, `workspace` |
| request count | no | `requests`, `request_count`, `calls`, `n_requests` |

Two rules keep the numbers honest:

- **The unit is never guessed.** A column is taken as spend only when you map it with `--map cost=`
  or its name looks like cost/amount/usd/spend/billed/charge/fee. A numeric column called `value`
  or `total` is not spend, and the tool will say so and ask for `--map` rather than guess.
- **When a required column is missing** the tool prints every column it found, the names it looked
  for, and the exact `--map field=Column` line to pass, then exits 1.

## What the report measures

All of it comes from the rows in the file:

- total spend and tokens, spend by day, by model, and by project/key/user when that column exists
- the top 10 cost drivers (model + project) and the share of spend held by the single biggest model
- **spike days**: days above 3x the median day, with the date and amount
- **possible context bloat**: rows whose input is above the 95th percentile, with the share of
  spend sitting above that line. A long input can be a real document, so this is a signal, not proof
- **possible retry or loop bursts**: minutes where one model's row count is more than 5x that
  model's median active minute, with the count and the excess cost. Also a signal, not proof
- **average input:output ratio per model**
- a **savings estimate**, only when you pass `--prices`, and only as "if modelB were acceptable for
  these calls" - the tool never claims a cheaper model is good enough

Every report ends with **What I measured** (facts from the file), **What I am assuming** (every
assumption, including the prices and the comparison), and a closing line saying a cheaper model is
only a saving after a quality test on a sample of real calls.

## Prices

`prices.example.json` holds made-up round numbers so the tool can be demonstrated. Its `_note`
says so and its `_example: true` flag makes the tool **refuse to estimate savings** with it unless
`--allow-example-prices` is given, and then every figure is labelled *illustrative only*.

Write your own file with the prices you actually pay:

```json
{
  "gpt-4o": { "inputPer1M": 2.5, "outputPer1M": 10 },
  "gpt-4o-mini": { "inputPer1M": 0.15, "outputPer1M": 0.6 }
}
```

Then `--prices my-prices.json --compare gpt-4o=gpt-4o-mini`. The comparison uses the token volume
that model A actually used in the file and prices it at model B's rates. It answers a question, it
does not recommend a switch.

## The sample file

`sample/usage-sample-FAKE.csv` is **fake data** - invented models (`atlas-small`, `atlas-large`,
`nimbus-pro`), invented projects, invented numbers. It exists to prove the tool runs end to end
(28 rows, six days, one spike day, one loop burst, one very large input). Never present it as a
customer's data. CSV cannot carry a comment line, so the name is the label.

## Proof

```
npx tsx ops/audit/cost-audit-check.ts
```

One PASS/FAIL line per check, exit 1 if anything fails. It runs the real code against fixtures in
a temp folder (fixed dates, no clock) and spawns the real CLI for the cases that are judged by exit
code: column auto-detection on two header styles, `--map` overrides, the missing-column message,
hand-computed totals and per-model sums, spike days, the context-bloat share, a loop burst on a
burst fixture and none on a flat one, no savings without `--prices`, the example prices refused
without `--allow-example-prices`, exact `--compare` arithmetic, both closing sections, no `http`
anywhere in the HTML, and the bundled sample running end to end.

## Data handling

Analyse the file locally, do not copy it into the repository, and delete it once the report is
delivered. The tool only reads numbers and short labels (model names, project names); it never
prints raw request or prompt content. Say that in writing to the customer before they send
data, and use an NDA when they ask for one.
