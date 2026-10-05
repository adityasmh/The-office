# REPORT F05-order-report: `npx tsx ops/order-report.ts <orderId> [--html] [--out <file>]`

Date: 2026-10-06. Order: `docs/overnight/ORDER_F05-order-report.md`.

## Changed files

- `ops/order-report.ts` (new) - read-only post-mortem for one fleet order. Reads
  `company/fleet/orders.json` and, per work order, `company/fleet/<orderId>/<workOrderId>/REPORT.md`.
  Markdown by default (stdout, or `--out <file>`), `--html` for ONE self-contained HTML file (inline
  CSS, no external assets of any kind; the only URL is a real PR link rendered as `<a href>`).
  Content: summary (order text, status, created/updated/closed, duration like `35m 0s`, work order
  count, PASS/REDO/none verdict counts, reports found, redaction count), a timeline table built from
  `order.trace` (time, from, to, what + clipped detail) **sorted chronologically** (the stored trace
  is append-ordered; unparsable timestamps sort last in file order), then per work order: title,
  role, state, owned files, verdict, review trimmed to 600 characters with a `... [trimmed]` marker,
  branch, PR link, CI state, the REPORT.md path or `no report`, and the report's first heading.
  Every token-shaped string (`sk-`, `ghp_`/`gho_`/`ghs_`/`ghr_`/`github_pat_`, `xox*`/`xapp-`,
  `AKIA`, `AIza`, JWT, `Bearer ...`, private-key blocks, `KEY=value` assignments) is redacted to
  `[REDACTED]` **in the model**, so Markdown and HTML are both safe. Exit codes: 0 report, 1 unknown
  id / unreadable state / unwritable `--out`, 2 bad arguments (`--help` exits 0). A missing
  REPORT.md is `no report`, never a crash. Node built-ins only, no network call, no process started,
  nothing in the repository is written (`--out` writes only the file the caller asked for).
- `ops/order-report-check.ts` (new) - the proof. Runs the real report code against fixture orders and
  REPORT.md files in temporary folders under the OS temp dir (timestamps fixed, so no clock
  dependency): a done order with 2 work orders, 4 trace hops written OUT of order, a >600-char
  review carrying a fake token, one work order with no REPORT.md, and a cancelled order with no work
  orders and no trace. Also proves nothing was written (SHA-256 of the fixture tree before/after)
  and runs the real CLI once on the real repo (read-only).

Nothing else was edited. `ops/spawn-wave.ps1`, `docs/overnight/ORDER_F02-setup.md` and
`docs/overnight/ORDER_F07-order-templates.md` were already modified before this order, and the
`doctor*`, `secret-scan*`, `install-hooks`, `cost-report*` files belong to other workers.

## Proof

Command (run once, foreground): `npx --no-install tsx ops/order-report-check.ts`

```
PASS markdown has all sections (summary, timeline, work orders, both work orders)  -> sections=summary,timeline,work-orders; labels=8
PASS summary carries the order text, status, duration, work order count and verdicts  -> status=done; duration=35m 0s; workOrders=2; verdicts=1/0/1
PASS the timeline is chronological and holds every hop (fixture trace is out of order)  -> rendered=2026-10-06T00:00:05.000Z | 2026-10-06T00:10:00.000Z | 2026-10-06T00:20:00.000Z | 2026-10-06T00:30:00.000Z
PASS each work order shows title, owned files, verdict, branch, PR link and CI state  -> WO-1 has verdict/branch/PR/CI, WO-2 renders 'none' without crashing
PASS a missing REPORT.md is shown as "no report" without a crash  -> reportsFound=1; WO2=company/fleet/foFixtureA/WO-2/REPORT.md
PASS an existing REPORT.md is read and its heading shown  -> heading="# WO-1 report"
PASS a fake token in a review is redacted in the model, the Markdown and the HTML  -> raw token in output: md=false; html=false
PASS tokens in the order text and in a trace detail are redacted too  -> order text and trace detail both carry [REDACTED]
PASS redactions are counted in the summary line  -> redactions=4
PASS the review is trimmed to 600 characters with a visible marker  -> reviewLength=583
PASS HTML is self-contained (doctype, inline style, zero external assets)  -> externalAsset=false; bytes=3620
PASS HTML carries the same content as the Markdown (sections, verdicts, no report)  -> summary/timeline/work orders all present in HTML
PASS an unknown order id exits 1 with one plain error line and no stack trace  -> exit=1; err="order-report: unknown order id \"foNope\""
PASS an order with no work orders and no trace renders empty sections, not a crash  -> exit=0
PASS bad arguments exit 2 with the usage, --help exits 0  -> noArgs=2; help=0
PASS --out writes the Markdown (byte-identical to stdout) and leaves stdout clean  -> exit=0; bytes=1810
PASS --html --out writes one self-contained HTML file  -> exit=0; bytes=3620
PASS the report wrote nothing into the tree it read (fixture tree byte-identical before/after)  -> before=11b5085bdc41; after=11b5085bdc41
PASS real CLI prints a Markdown report for a real order and exits 0  -> exit=0; id=fomuvst52z; stderr=""
order-report-check: all checks passed
```

Harness exit code: 0 (19/19 PASS).

Extra check (run once, foreground): `npx --no-install tsc --noEmit --strict --target es2022
--module esnext --moduleResolution bundler ops/order-report.ts ops/order-report-check.ts` -> exit 0
(no type errors; the repo-wide `npm run typecheck` was deliberately not used, to avoid unrelated
pre-existing noise).

## Open issues

- The `--root <dir>` flag exists for the proof (and is documented in `--help`); the order only named
  `<orderId> [--html] [--out <file>]`, so it is additive and changes nothing about the default path
  (default root = the repo containing the script).
- The timeline "What" cell appends the trace `detail` clipped to 160 characters (`what: detail`), so
  a very long detail is shortened in the table. The full detail is not printed anywhere else in the
  report; say so if the manager wants a detail column instead of a suffix.
- An empty REPORT.md: a REPORT.md that exists but is blank counts as `no report` (the worker never
  wrote content), and `reportsFound` counts only reports with content.
- Redaction is shape-based, like the F03 scanner, and deliberately over-redacts rather than leaks: a
  review that says e.g. `password=hunter2hunter2` loses the value (the `[REDACTED]` marker stays
  visible). The count is always shown in the summary, so a surprising count is at least noticeable.
- The PR link is the only external URL in the HTML, and it is only rendered as `<a href>` when it
  starts with `http(s)://`; any other scheme is printed as plain text (no `javascript:` href).
