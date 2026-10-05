# REPORT F07-order-templates: order templates that do not make workers loop

Order: `docs/overnight/ORDER_F07-order-templates.md`. Date: 2026-10-06.

## Changed files

| File | What |
|---|---|
| `orders/templates/add-docs-section.md` | NEW. One narrow job: add one section to one file. Fields `{{file}}`, `{{change}}`, `{{check}}`. |
| `orders/templates/fix-small-bug.md` | NEW. One narrow job: fix exactly one bug in one file. Same three fields. |
| `orders/templates/add-unit-check.md` | NEW. One narrow job: add one check to one file. Same three fields. |
| `orders/templates/small-refactor.md` | NEW. One narrow job: one refactor of one file, no behavior change. Same three fields. |
| `orders/templates/update-readme-status.md` | NEW. One narrow job: update one status line in one file. Same three fields. |
| `ops/new-order.ts` | NEW. Renders a template with `--set key=value`, errors by name on a missing field, lints the result, and prints, writes (`--out`) or posts (`--post`) it. |
| `ops/new-order-check.ts` | NEW. Proof harness: the real CLI as a child process, a temp folder for probe/out files and a stub HTTP server for `--post`. Fake token, no `.env`, no router, no external network. |
| `docs/overnight/REPORT_F07-order-templates.md` | NEW. This report. |

No other file was touched.

## Design notes

- Every template states one job, names the single file the worker may edit, gives an
  acceptance check, and ends with `Print the final report and END your turn.` None has a
  waiting, polling or "verify periodically" step.
- The lint rejects `wait`, `poll`, `periodically`, `keep checking` and the loop-word prefix.
  The prefix is the three-letter string built at runtime with
  `String.fromCharCode(104, 111, 108)` in both `ops/new-order.ts` and `ops/new-order-check.ts`,
  so neither source file ever contains the literal (verified with `findstr /I /C:hol`: no
  match in any of the seven new files). Matching is case-insensitive and the error names the
  exact line, for example: `new-order: line 4 contains "poll": please POLL before reporting`.
- `--post` sends `{"text": <rendered order>}` to `POST /company/fleet/orders`. The company
  token is read from `$COMPANY_AUTH_TOKEN` (else `COMPANY_AUTH_TOKEN` in `.env`, read only
  inside the tool, exactly like `ops/fleet-cli.ts`) and rides on the `x-company-token` header
  only; it is never printed. Base URL is `$FLEET_URL`, default `http://127.0.0.1:8787`.
- `<template>` accepts a bare name (`fix-small-bug` or `fix-small-bug.md`) under
  `orders/templates` or a path to a template file, so the harness can point the CLI at probe
  templates in a temp folder.
- One fix during the run: the probe for the loop-word case expected the full word in the
  report, but the lint (correctly) reports the three-letter prefix. The harness now carries
  the word in the probe line and the prefix in the expected message.

## Proof (exact command output)

`npx tsx ops/new-order-check.ts`

```
PASS add-docs-section renders with its template fields and ends the turn  -> exit=0; fields=file,change,check
PASS fix-small-bug renders with its template fields and ends the turn  -> exit=0; fields=file,change,check
PASS add-unit-check renders with its template fields and ends the turn  -> exit=0; fields=file,change,check
PASS small-refactor renders with its template fields and ends the turn  -> exit=0; fields=file,change,check
PASS update-readme-status renders with its template fields and ends the turn  -> exit=0; fields=file,change,check
PASS a missing template field errors by name  -> exit=1
PASS the lint rejects a template with banned words and exits 1  -> exit=1
PASS the lint rejects "wait" with line 3
PASS the lint rejects "poll" with line 4
PASS the lint rejects "periodically" with line 5
PASS the lint rejects "keep checking" with line 6
PASS the lint rejects the loop-word prefix with line 7
PASS a clean order passes the lint and is printed by default  -> exit=0
PASS --out writes the rendered order to a file  -> exit=0; bytes=124
PASS --post sends the rendered order text as JSON  -> exit=0; text matches=true
PASS --post sends the token only in the x-company-token header  -> header ok=true; body/output clean=true
PASS the token value never appears in any output  -> checked 10 outputs
new-order-check: all checks passed
```

Exit code 0.

## Open issues

- `tsc --noEmit` does not cover `ops/` (tsconfig `include` is `["src"]`), so the two new
  tools are validated by running them, not by the typechecker.
- The harness proves `--post` against a local stub only; no order was ever posted to the real
  router, and no live order was created, approved or cancelled.
- The lint is a word-prefix check, so a legitimate order that contains one of the banned
  substrings for another reason (for example an identifier containing the loop-word prefix) is
  rejected too. That is deliberate for this order; a future allow-list could add exceptions.
- `--set key=value` has no quoting or escaping for values that contain `=`; the value keeps
  everything after the first `=`, which is enough for paths, instructions and commands.
