# Fleet backend: operator's self-check guide

The fleet turns one CEO order into parallel work: Claude (manager) splits it into work
orders, the CEO approves the plan, and one VISIBLE jcode terminal opens per work order.
This guide covers the routes, shapes, state machine, delivery and self-check scripts.

Code: `src/company/fleet.ts` (state machine), `src/server.ts:641-684` (routes).
Spec: `docs/FLEET_SPEC.md`. State: `company/fleet/orders.json` and, per work order,
`company/fleet/<orderId>/<workOrderId>/REPORT.md`.

## 1. Routes

Base URL `http://127.0.0.1:8787` (`PORT`, default in `src/config.ts:34`).
Everything that is not `GET`/`HEAD`/`OPTIONS` is treated as mutating by the auth guard
(`src/server.ts:151`) and must carry the `X-Company-Token` header. The two `GET` routes
are read-only and need no token. Errors come back as `{error: string}`; the code is 400
for a rejected mutation, 404 for an unknown order id, 500 for an unexpected throw.

| Method | Path | Purpose | Body | Response |
|---|---|---|---|---|
| POST | `/company/fleet/orders` | Create an order and start planning async | `{text, autoApprove?}` (`text` required, else 400) | the new `FleetOrder`, `status: "planning"` |
| GET | `/company/fleet` | List orders, newest first | none | `{orders: FleetOrderView[], limits: {maxSessions, running}, watcher: {running, intervalMs}}` |
| GET | `/company/fleet/orders/:id` | One order with live worker state | none | `FleetOrderView` (404 if unknown) |
| POST | `/company/fleet/orders/:id/approve` | Accept the plan (optionally edited) and spawn | `{workOrders?}` (only when the CEO edited the plan) | the updated `FleetOrder`, `status: "running"` |
| POST | `/company/fleet/orders/:id/work/:wid/redo` | Re-run one work order after a REDO verdict | none | the updated `FleetOrder` |
| POST | `/company/fleet/orders/:id/cancel` | Stop spawning queued work | none | the updated `FleetOrder`, `status: "cancelled"` |

`POST /orders` and `approve` both return before their work finishes: planning, then
spawning via `fillSlots()`, run in the background (`fleet.ts:923,969-971`).

## 2. Shapes

`FleetOrder` (`fleet.ts:52`):

```ts
{ id, text, createdAt, updatedAt,
  status: "planning"|"awaiting_approval"|"running"|"reviewing"|"done"|"failed"|"cancelled",
  plan?, specDoc?, workOrders: WorkOrder[], trace: TraceStep[], error?, summary? }
```

`WorkOrder` (`fleet.ts:30`):

```ts
{ id, title, role, owns: string[], brief, done: string[],
  state: "planned"|"queued"|"starting"|"working"|"idle"|"reported"|"reviewed"|"failed",
  sessionId?, windowPid?, startedAt?, reportedAt?,
  verdict?: "PASS"|"REDO", review?, attempts: number,
  error?, reviewAttempts?,
  delivery?: { how: "targeted"|"focused"|"none", at: string, detail: string } }
```

Fields the GET routes add on top of the stored record:

- per work order, `live: {streaming, lastActivity, tail}` (`fleet.ts:1381`, `withLive`).
  `tail` is the last ~15 lines of text/tool activity read from the session's journal, and
  `reportPath` is the repo-relative path to that work order's `REPORT.md`.
- on `GET /company/fleet` only: `limits: {maxSessions, running}` (`FLEET_MAX_SESSIONS`,
  busy work orders) and `watcher: {running, intervalMs}` (`fleet.ts:1396`).

## 3. Lifecycle

Order status values: `planning`, `awaiting_approval`, `running`, `reviewing`, `done`,
`failed`, `cancelled`. Work order state values: `planned`, `queued`, `starting`,
`working`, `idle`, `reported`, `reviewed`, `failed`.

```
POST /orders -> planning --plan ok--> awaiting_approval --approve--> running
                 |-- empty/failed plan --> failed
cancel --> cancelled      running --all reports PASS--> done
running --all reports reviewed, some REDO--> reviewing --redo--> running
running --a work order failed, nothing else running--> failed
```

Per work order (checked against `fleet.ts`):

```
planned --approve--> queued --fillSlots, free slot--> starting --session matched--> working
working <-- new activity -- idle        (journal goes quiet: working -> idle)
starting/working/idle --REPORT.md appears--> reported --Claude review--> reviewed (PASS|REDO)
any running state --session gone + no REPORT.md after 120s--> failed
redo --> queued again (fresh session)
```

Checked against the code:

- `planned` comes from the planner; `approve` queues every not-yet-spawned order
  (`fleet.ts:948,955,961`). `starting` is set by `fillSlots` before spawn, deterministic
  `working` after the brief is verified (`fleet.ts:1007,1054`).
- `working`/`idle` are recomputed every watcher tick from `streaming` and last activity
  (`tickFleet`, `fleet.ts:1277-1281`). `reported` on `REPORT.md`, then `reviewed` once Claude
  returns PASS/REDO (`fleet.ts:1294-1306`); a gone session with no report for >120s fails it
  (`fleet.ts:1287-1290`).
- **approve** spawns async (trace hop `CEO -> Claude (manager) approve`). **redo** clears the
  session, bumps `attempts`, re-queues, and reuses the brief plus the old `review` notes
  (`briefBody`, `fleet.ts:676`). **cancel** stops queued spawns and does NOT kill running
  terminals: the CEO closes those (`fleet.ts:1093-1098`).

Note vs spec: the spec's `FleetOrder`/`WorkOrder` types do not mention `summary`,
`specDoc`, `error`, `reviewAttempts` or `delivery`; the code carries all of them. The code is
the authority here.

## 4. Delivery

A brief reaches exactly one terminal by **targeted** delivery:
`jcode transcript --mode send -S <sessionId>`, with the brief piped on stdin, into that
work order's own session (`deliverInto`, `fleet.ts:609-636`). The send is verified by
waiting for the brief's marker line (`FLEET-ORDER <orderId>/<wid>`) to appear in that
session's journal, so a silent failure is detected.

Focus-based delivery is only a fallback: if targeting does not land, the code waits until
`%USERPROFILE%\.jcode\last_focused_client_session` equals the session, then sends with
`jcode transcript --mode send` (no `-S`). That is racy, because focus can point at the wrong
window if the CEO clicks elsewhere, which is why it is second.

`WorkOrder.delivery` records what happened: `{how: "targeted"|"focused"|"none", at, detail}`
(`fleet.ts:49`, written at `fleet.ts:1053`). `how` is the method that was verified, `detail`
carries the exit codes, the focus match and the failure reason, and `how: "none"` means the
brief never appeared, which fails the work order (`fleet.ts:1054-1055`).

## 5. Self-check commands

| Command | Needs the router on :8787? | What it proves |
|---|---|---|
| `npx tsx ops/fleet-status.ts` | no | orders, limits, watcher state, one line per work order |
| `npx tsx ops/fleet-status.ts --order <id>` | no | full detail for one order (JSON + plan + per-worker tail) |
| `npx tsx ops/fleet-status.ts --order <id> --tail N` | no | same, with `N` tail lines (default 15) |
| `npx tsx ops/fleet-deliver-probe.ts [--keep] [--repo <dir>]` | no | opens one real visible window in a throwaway repo and proves targeted delivery lands in that session only |
| `npx tsx ops/fleet-selftest.ts` | no | the state machine: working -> reported -> reviewed, all PASS -> done with exactly one report-back, cancel, live tail |
| `npx tsx ops/fleet-http-probe.ts [--order <id>]` | yes | read-only HTTP check of the routes above over the live API |

`ops/fleet-status.ts` prints exactly what `GET /company/fleet` and
`GET /company/fleet/orders/:id` return, so a UI bug can be told apart from a backend bug.
It imports `src/company/fleet.js` in-process, so it talks to `company/` directly and does
not need (or contact) the router. Because of that, its `watcher.running` is false in that
standalone process even when the router's own watcher is live.

`ops/fleet-deliver-probe.ts` and `ops/fleet-selftest.ts` run against a throwaway
`COMPANY_ROOT` / `FLEET_REPO`, never the live `company/`; the selftest sets `MOCK_MODE=1`
and the probe never touches the router. The deliver probe does open a real visible jcode
window (that is the point). Close it, or pass `--keep` to leave it up on purpose.

`ops/fleet-http-probe.ts` is the only one that needs the router running: it is a read-only
HTTP probe written alongside this guide, so trust its header comment for current flags.

## Notes

Last verified by a fleet worker.
