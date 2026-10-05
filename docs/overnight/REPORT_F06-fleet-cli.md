# REPORT F06-fleet-cli: fleet command line client

Order: `docs/overnight/ORDER_F06-fleet-cli.md`. Date: 2026-10-06.

## Changed files

| File | What |
|---|---|
| `ops/fleet-cli.ts` | NEW. The CLI: `status`, `orders [--status X]`, `show <id>`, `new "<text>" [--auto-approve]`, `approve <id>`, `cancel <id>`, `workers`, `tail <worker> [--lines N]`. `--json` on any command; base URL from `FLEET_URL` (default `http://127.0.0.1:8787`); token from `COMPANY_AUTH_TOKEN`, else `COMPANY_AUTH_TOKEN` in `.env` read only inside this tool; sent only as `x-company-token` on POST; never printed. |
| `ops/fleet-cli-check.ts` | NEW. Proof harness: a stub HTTP server on a free 127.0.0.1 port plus the real CLI run as a child process. Fake token, no `.env`, no router, no external network. |

No other file was touched.

## Design notes

- Endpoints used: `GET /health`, `GET /company/laya`, `GET /company/routing/policy`,
  `GET /company/sessions`, `GET /company/fleet`, `GET /company/fleet/orders/:id`,
  `POST /company/fleet/orders`, `POST .../approve`, `POST .../cancel`,
  `GET /company/sessions/:id?tail=1`. These are the routes `src/server.ts` already serves.
- A token is attached in `request()` only when the method is POST. GET requests send no
  `x-company-token`, matching the loopback read exemption.
- Plain-words failures: 401 says the token is missing or wrong and names `COMPANY_AUTH_TOKEN`;
  503 says the company is paused and how to resume. Network failures name the base URL. All
  exit 1.
- `tail <orderId>/<wid>` reads that work order's `live.tail` from the order detail; a bare
  argument is treated as a session id and read from `GET /company/sessions/:id?tail=1`.
- One small fix during the run: the `orders` status column was clipped to 14 chars, truncating
  `awaiting_approval`; widened to 18.

## Proof (exact command output)

`npx tsx ops/fleet-cli-check.ts`

```
PASS status exits 0 and prints health, Laya, routing policy and running sessions  -> exit=0
PASS orders prints both stub orders with state and progress  -> exit=0
PASS orders --status running filters out the other status  -> exit=0
PASS show prints the order and its work order row  -> exit=0
PASS new POSTs the text and prints the new order id  -> exit=0; body.text="a brand new order"
PASS approve prints the approved order  -> exit=0
PASS cancel prints the cancelled order  -> exit=0
PASS workers lists every work order across orders  -> exit=0
PASS tail --lines prints only the requested tail lines  -> exit=0
PASS GET calls send no x-company-token header  -> gets=9; with token=0
PASS POST calls send the token in x-company-token  -> posts=3; correct=3
PASS the token value never appears in any command output  -> checked 9 outputs
PASS --json prints one parsable JSON object for every command  -> parsed 5/5
PASS an unknown command prints usage and exits 1  -> exit=1
PASS a 401 gives the plain token message and exits 1  -> exit=1
PASS a 503 gives the plain paused-company message and exits 1  -> exit=1
fleet-cli-check: all checks passed
```

Exit code 0. The checks needed to confirm the first two fixes (status column width, and the
expected `0/1` progress in the proof) were done once each; the final run is the one above.

## Open issues

- The stub proves the CLI against the documented shapes; a live run against the real router was
  deliberately NOT performed (mutating commands would create/approve/cancel real orders).
- `workers` and `tail` expect the fleet view to carry `live.tail` per work order (it does on
  `GET /company/fleet/orders/:id`); if a future change dropped that field, `tail` would print
  `(none)` rather than fall back to the session journal.
- `tsc --noEmit` does not cover `ops/` (tsconfig `include` is `["src"]`), so these two files are
  validated by running them rather than by the typechecker.
