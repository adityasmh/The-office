# Fleet guide/check contract

Six routes (source of truth: docs/FLEET_SPEC.md, verified against src/server.ts):
1. POST /company/fleet/orders
2. GET  /company/fleet
3. GET  /company/fleet/orders/:id
4. POST /company/fleet/orders/:id/approve
5. POST /company/fleet/orders/:id/work/:wid/redo
6. POST /company/fleet/orders/:id/cancel

Route IDs used in both files: create, list, detail, approve, redo, cancel.

Read-only check method (scripts/fleet_check.py):
- list: live GET http://127.0.0.1:8787/company/fleet (base URL overridable via --base or FLEET_BASE env). Expect JSON with `orders` array and `limits.maxSessions`/`limits.running`.
- detail: live GET /company/fleet/orders/<id> using the first order id from list. If there are no orders, report SKIP-with-reason (counts as pass only if the static check passes), never create one.
- create/approve/redo/cancel: STATIC check only. Read src/server.ts (and src/company/fleet.ts) as text and confirm the route is registered with the right method and path pattern. Never send POST/PUT/DELETE/PATCH.
- Output: one line per route `PASS|FAIL <id> <METHOD> <path> - detail`, then a summary; exit 0 only if all six pass, otherwise exit 1. No file writes, no state changes.

The guide documents this same method under 'How to verify locally' for each route, and mutating routes require header x-company-token.