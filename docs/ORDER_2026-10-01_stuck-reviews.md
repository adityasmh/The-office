# Work order: two fleet orders are stuck in "reviewing" - find out why and get them moving

From: manager. Model: deepseek-v4.1-flash. Repo: C:\Users\user\Desktop\Default Project

Measured by the manager (17:13 local; trace times are UTC):
- fomupe3jzs (PERF_SPEC/panel): both work orders PERF-PANEL and PERF-SESS are `reviewed`, last trace `review PASS` at 11:15:25Z, order status still `reviewing` ~30 minutes later, even after the router came back (pid 24760, 17:02 local).
- fomupdu81a (air-gapped): work order WO1 `reviewed`, last trace `review REDO` at 10:51:02Z (three fixes requested: held queue capped at 5 rows drops work, plus 2 more points; see its trace in company/fleet/orders.json). The worker reworked src/company/airGap.ts and docs/perf/AIR_GAPPED.md afterwards (16:25-16:27 local) but the order shows no re-review and WO1 still says `reviewed`, no redo/attempt recorded.
- Other orders advance normally (fomupgip2e CACHE-CORE got `review PASS` at 11:41Z), so the tick works in general.

Do (read first, small changes only, never rewrite files, other workers are editing src/):
1. Read `tickFleet` in src/company/fleet.ts (around lines 3039-3300), `settleOrder`, and how a REDO verdict is supposed to re-open a work order (`/company/fleet/orders/:id/work/:wid/redo` in src/server.ts and the matching function). Say precisely what moves an order from `reviewing` to `done`, and what is missing for each of the two orders. Look at both orders' full trace + workOrders fields (reviewAttempts, reportedAt, redo flags) in company/fleet/orders.json, read-only.
2. If it is a code defect (e.g. an order whose WOs are all reviewed but whose settle step never runs, or a REDO that never re-opens the WO when the worker reworks on its own), write ops/fleet-stuck-review-check.ts that reproduces it on a temp FLEET_REPO/COMPANY_ROOT with the real tickFleet (see ops/fleet-review-verdict-check.ts for the pattern), fix it with a minimal diff, show the check failing before and passing after. `npx tsc --noEmit` exit 0 and the existing fleet checks (ops/fleet-selftest.ts and the ops/fleet-review-*.ts checks) still pass.
3. If it is a one-off state problem, nudge ONLY these two orders through the router's own API (token from GET /company/auth/bootstrap on loopback, never print it): for fomupe3jzs the normal settle path; for fomupdu81a the documented redo or re-review path so the reworked deliverable is reviewed. Do not edit company/fleet/orders.json by hand. Do not approve, cancel or drop any other order. Do not restart the router (code fixes take effect at the next restart; say so).
4. Verify: report each order's status before/after, with the trace lines that prove it. If the air-gapped re-review comes back REDO again, report the reasons and stop (the manager decides).
5. Append a timestamped entry to docs/AGENT_COORDINATION.md. Report to the manager, not the CEO. No secrets printed, no deletes.
