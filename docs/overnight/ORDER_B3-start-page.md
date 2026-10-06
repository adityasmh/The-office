# Order B3-start-page: first-run page so a non-expert can start the fleet

Context: docs/business/PLAN.md (read the section for this offer first).

Offer A in the plan. A person who is not an AI expert opens the dashboard and needs to know in one minute what this is, whether it is working, and what to do first.

## Files
`public/v2/views/start.js` (new), `public/v2/app.js` (ONLY the navigation and route list: add one entry "Start here" as the FIRST item; small insertion), `ops/start-view-check.ts` (new)

## What to build
Read `public/v2/UI_V2_SPEC.md` or `docs/UI_V2_SPEC.md` (whichever exists) and an existing small view such as `public/v2/views/system.js` for the view contract (mount, cleanup, polling, how the page calls the API). Build a view at route `#/start`:
1. A plain-words explanation in 4 short lines: what the fleet is, that a human approves before anything risky, that work happens in a safe workspace, and that cost is shown on every order.
2. A live checklist with a green, amber or red dot and ONE plain sentence each, built only from existing read-only routes: router answering (`GET /health`), the decision model Laya (`GET /company/laya`, amber with the words "optional: routing falls back to simple rules" when it is down), the model budget (`GET /company/budget/real`: show the OpenCode quota left and the prepaid credit balance in plain words, and say which one is used first), GitHub publishing (derived from `GET /company/routing/policy` only if it exposes it; otherwise omit this line rather than guess), and the number of workers running (`GET /company/workers`). Never show a key, a token or an environment value.
3. A "Your first order" box: a text area and one button that creates an order through the same call the Fleet page uses for new orders (find it in `public/v2/views/fleet.js`; reuse its API helper and its token handling; do not copy a token into the page), plus three example orders as buttons that fill the text area: one documentation edit, one small bug fix, one test to add, each naming a file template field the user must replace (write the file name field as `<your file>` and refuse to submit while a `<` is still in the text, with a plain message).
4. A "What it will cost" line that says the order is planned first and nothing is spent until the user approves, and links to the Budget page.
5. Errors in plain words, a retry link when a route fails, and no layout that breaks at 360 px.

## Proof (`ops/start-view-check.ts`)
The view is browser code, so test its pure parts. Put the pure functions (`checklistFromData(data)`, `canSubmit(text)`) in the view file as named exports with no DOM access at import time, import them from the check, and print PASS or FAIL per line: all-green data gives all green; Laya down gives amber with the optional wording and not red; router down gives red with a retry hint; budget numbers are rendered in plain words and contain no key-shaped string; a missing GitHub field omits the line; `canSubmit` rejects empty text, text still containing `<your file>` and text over 2000 characters, and accepts a normal order. If importing the view file in Node fails because of top-level browser imports, move the pure functions into `public/v2/views/startLogic.js` (no imports) and import that instead.
## Common rules
- Create or edit ONLY the files named in "Files". Other workers run at the same time on other files. Make small targeted edits to any existing file; never rewrite an entire existing file. Match the surrounding style. No new dependencies; Node built-ins only (ES modules, `.js` import suffixes where importing).
- Never restart or start the router. Never read, print or edit `.env`. Never touch `company/`, Laya, Kafka or scheduled tasks. No real network calls in tests. No deletes of existing files.
- Never invent a number, customer, testimonial, logo or price. Any figure shown to a user must come from the data the tool was given or from a clearly labelled assumption the user supplies.
- Run each command ONCE, in the foreground. If a step fails, report the exact error and END your turn; do not retry in a loop.
- Narrow job with an explicit end: write `docs/overnight/REPORT_<stem>.md` (files, exact command output, open issues), print the same report and END your turn. Do not wait, poll, loop, or re-read this order.