# REPORT B3-start-page

Order: docs/overnight/ORDER_B3-start-page.md
Status: done. All checks pass.

## Files

- `public/v2/views/start.js` (new, 470 lines) — the first-run page at `#/start`.
  - Four plain lines: what the fleet is, that a human approves, that work runs in
    a safe workspace, that every order shows its cost.
  - Live checklist (green/amber/red dot + one sentence), polled every 20 s from
    read-only routes only: `GET /health` (router), `GET /company/laya` (decision
    model; amber, never red, with the words "optional: routing falls back to
    simple rules"), `GET /company/budget/real` (OpenCode quota left and prepaid
    credit, says the quota is used first), `GET /company/routing/policy` (GitHub
    publishing ONLY if that payload exposes it; it does not today, so the line is
    omitted), `GET /company/workers` (how many workers are running).
  - "Your first order": a text area, three example orders that fill it (a
    documentation edit, a small bug fix, a test to add; each names `<your file>`),
    and a send button that creates the order through the same call the Fleet page
    uses: `POST /company/fleet/orders {text, autoApprove:false}` via `ctx.api`,
    so api.js owns the token. A `<` left in the text blocks the send with a plain
    message, as does empty text or more than 2000 characters.
  - "What it will cost": the order is planned first and nothing is spent until
    the user approves, with a link to `#/budget`.
  - Errors in plain words, a Retry link/button when a route fails, responsive
    layout (namespaced `.start` CSS, `min-width:0`, `overflow-wrap:anywhere`) that
    does not break at 360 px.
  - Pure exports (`checklistFromData`, `canSubmit`) have no DOM access at import
    time, so the Node check imports the view file directly; no separate
    `startLogic.js` was needed.
- `public/v2/app.js` (small insertion, navigation/route list only) — added
  `{ name: "start", label: "Start here", icon: "\u25b6", badge: null }` as the
  FIRST item of `VIEWS`. `DEFAULT_ROUTE` is unchanged.
- `ops/start-view-check.ts` (new) — imports the pure functions, no DOM, no
  network, prints PASS/FAIL per line.

No key, token or environment value is read or shown by any of this. No other
file was created or edited; no new dependency; `company/`, Laya, Kafka and the
router were not touched.

## Commands and exact output

```
> npx tsx ops/start-view-check.ts
PASS  all-green data gives all green
        4 rows, dots=[green, green, green, green]
PASS  Laya down gives amber with the optional wording and not red
        ok:false -> amber "The decision model (Laya) is not answering. optional: routing falls back to simple rules." | error -> amber
PASS  router down gives red with a retry hint
        red "The router is not answering. Use Retry to check again."
PASS  budget numbers are rendered in plain words and contain no key-shaped string
        "OpenCode quota: 82% left. prepaid credit: $4.50. The OpenCode quota is used first; the prepaid credit is only spent when it runs low."
PASS  a missing GitHub field omits the line
        missing -> omitted | exposed -> green
PASS  canSubmit rejects empty text, <your file> and text over the limit, and accepts a normal order
        empty=true placeholder=true tooLong=true normal=true

PASS all checks (2000 char limit)
```

```
> node --check public\v2\views\start.js && echo START_OK
START_OK

> node --check public\v2\app.js && echo APP_OK
APP_OK
```

## Open issues

- The page was not opened in a live browser (the order says browser code is tested
  through its pure parts, and the router was not to be restarted). The route list
  and mount contract were checked against `public/v2/app.js` and `system.js`;
  first paint in a browser is the one thing still unobserved.
- `GET /company/routing/policy` does not expose GitHub publishing (confirmed from
  `RoutingPolicyStatus` in `src/company/deepseekDirect.ts`), so the GitHub line is
  omitted by design. It appears automatically if that payload ever adds a
  `github` field.
- The view reads `/company/laya` and `/company/budget/real`; both are existing,
  read-only routes. Nothing here starts or stops Laya.
