# Fleet operator guide

How to operate the fleet over HTTP: one CEO order goes to a Claude (manager) plan, the plan is
approved, and one visible jcode terminal opens per work order. This guide is written from the real
implementation (`src/server.ts` routes at lines 1282-1330, `src/company/fleet.ts` state machine) and
cross-checked against `docs/FLEET_SPEC.md` and `docs/FLEET_CHECK_CONTRACT.md`.

Route IDs used by docs and the check script: **create, list, detail, approve, redo, cancel**.
Verified missing/needed files (2026-10-06): none are missing. `docs/FLEET_SPEC.md`, `docs/FLEET_SELFCHECK.md`, `docs/FLEET_GATE_SPEC.md`, `docs/FLEET_CHECK_CONTRACT.md`, `src/company/fleet.ts`, `src/company/claudeSignIn.ts`, `ops/fleet-run.ts`, `ops/fleet-status.ts`, `ops/fleet-tick.ts`, `ops/fleet-write-plan.ts`, `ops/fleet-selftest.ts`, `ops/fleet-http-probe.ts`, `ops/fleet-deliver-probe.ts` and `scripts/fleet_check.py` all exist.

## 1. Overview

Base URL: `http://127.0.0.1:8787` (config PORT, default 8787; bind host default 127.0.0.1).

Auth (`companyGuard` in `src/server.ts`, `src/company/authguard.ts`):

- `GET`/`HEAD`/`OPTIONS` from a loopback peer are exempt: no token needed for reads.
- Every mutating request (`POST` etc.) must carry the header `x-company-token`
  (constant `TOKEN_HEADER` in `src/company/authguard.ts`, matched against `COMPANY_AUTH_TOKEN`
  from `.env`; constant-time compare). Off-host peers are refused either way; reads need the
  token too when the peer is not loopback.
- A wrong or missing token is `401 {error:"unauthorized", detail, header:"x-company-token", hint}`.
- Do not print the token value in logs or reports.

Fleet state lives under `company/fleet/`:

- `orders.json`: the array of `FleetOrder` records (planner writes, watcher advances, cancel marks).
- `<orderId>/<workOrderId>/REPORT.md`: each worker's finish report; its appearance flips the work
  order to `reported`, then the manager reviews it (PASS/REDO).
- `WATCHER.json`: watcher lock (pid + startedAt). A second router process refuses to start a second
  watcher unless `FLEET_FORCE=1`.

Order lifecycle (`FleetOrder.status`): `planning`, `awaiting_approval`, `running`, `reviewing`,
`done`, `failed`, `cancelled`.

Work-order lifecycle (`WorkOrder.state`): `planned`, `queued`, `starting`, `working`, `idle`,
`reported`, `reviewed`, `failed`.

Flow sketch:

```
POST create -> planning --plan written--> awaiting_approval --approve--> running
running --REPORT.md per worker--> reported --manager review--> reviewed (PASS|REDO)
all PASS -> done; some REDO -> reviewing --redo--> running (fresh session)
cancel -> cancelled (queued work never starts; running terminals are NOT killed)
empty text (400 at the route) or a failed plan -> failed
```

A watcher tick (default every 5 s, `FLEET_WATCH_INTERVAL_MS`) advances states: session journal
activity -> `working`/`idle`, `REPORT.md` appears -> `reported` -> manager review -> `reviewed`;
a worker whose session died without a report after 120 s is marked `failed`.

Order settlement (`settleOrder`, fleet.ts:2544) runs after every tick and review:
- every work order `reviewed` with verdict PASS -> order `done` (+ `summary`, a report-back to
  the assistant thread);
- all reviewed but some REDO -> order `reviewing` (a "Redo it?" question is pushed to INBOX per
  REDO work order);
- nothing running and at least one failed -> order `failed` (failed work-order errors join into
  `order.error`);
- otherwise the order stays/becomes `running`.
A PASS is downgraded to REDO automatically when the work order's REPORT.md is missing or empty.

Useful env knobs: `FLEET_AUTO_APPROVE=1` (skip the approval gate), `FLEET_MAX_SESSIONS` (the
fleet's own spawn cap; it can only be stricter than the machine-wide limit
`MAX_PARALLEL_SESSIONS`, default 30, which a budget guard can lower further),
`FLEET_WATCH_INTERVAL_MS` (default 5000), `FLEET_REVIEW_RETRY_DELAY_S` (default 60),
`FLEET_IDLE_SECONDS` (default 90, when a quiet session counts as idle) and
`MIN_FREE_RAM_MB` (default 2048, a queued work order waits below this much free memory).

## 2. The six routes

Every route returns errors as a JSON object `{"error": "..."}` (plus a `detail` string when the
guard produced it). Status codes below come straight from the route handlers.

### 2.1 Create order (create)

- **Endpoint:** `POST /company/fleet/orders`
- **Purpose:** create a fleet order from plain text and start the Claude (manager) planning pass
  asynchronously. The POST returns immediately with `status: "planning"`.
- **Request:** header `x-company-token` (required, mutation). Body JSON
  `{ "text": "...", "autoApprove": false }`. `text` is required (non-empty after trim).
  `autoApprove` is optional; when omitted the server falls back to the `FLEET_AUTO_APPROVE` env
  (default off).
- **Response 200:** the new `FleetOrder` (see 2.3 for the full shape; no `live` fields here yet).

```json
{
  "id": "fo186a2b3c4",
  "text": "Add a README section about the fleet and a comment in src/config.ts",
  "createdAt": "2026-09-30T18:00:00.000Z",
  "updatedAt": "2026-09-30T18:00:00.000Z",
  "status": "planning",
  "workOrders": [],
  "trace": []
}
```

(The planner may add `planAttempts`, `plannerPid` and more as it runs; the immediate response is
exactly what `createFleetOrder` stores: id, text, createdAt, updatedAt, status planning,
empty workOrders, empty trace.)

- **Common errors:**
  - `400 {"error":"text required"}` when the body is empty (`!text || !text.trim()`, server.ts 1289).
  - `401 {"error":"unauthorized"}` when the `x-company-token` header is missing or wrong.
  - `503 {"error":"company_paused","detail":"..."}` when the company is paused for shutdown
    (`refuseNewWork`, `src/company/lifecycle.ts:718`); resume via the System page or Start Laya
    Company.
  - `500 {"error":"<stringified exception>"}` on an unexpected throw.
- **Notes:** the request body is not echoed back, so a curl/PowerShell run prints just the new
  order JSON; order ids are `fo` + base36 epoch ms, so they sort roughly by creation. Empty text
  that slips past the route marks the order `failed` with `error: "empty order text"`.
- **Local verify (mutating, use with care):** the examples below hit the real router and start a
  real planning pass.

PowerShell (mutating; the token value comes from `COMPANY_AUTH_TOKEN` in `.env` - do not echo it,
do not run this casually against the live `company/` because it starts a real planning pass):

```powershell
$tok = (Get-Content .env | Where-Object { $_ -match '^COMPANY_AUTH_TOKEN=' }) -replace '^COMPANY_AUTH_TOKEN=',''
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8787/company/fleet/orders" `
  -Headers @{ "x-company-token" = $tok } `
  -ContentType "application/json" `
  -Body '{"text":"Add a README section about the fleet","autoApprove":false}'
```

curl equivalent:

```bash
curl -s http://127.0.0.1:8787/company/fleet/orders \
  -H "x-company-token: $COMPANY_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"Add a README section about the fleet"}'
```

Read-only verification (do this instead): `python scripts/fleet_check.py` performs the static check
of this route and never sends a POST. See section 4.

### 2.2 List orders (list)

- **Endpoint:** `GET /company/fleet`
- **Purpose:** list all fleet orders (newest first) plus slot limits and watcher status.
- **Request:** no body; from loopback no token (read exemption).
- **Response 200:** `{ orders: FleetOrderView[], limits: {...}, watcher: {...} }`
  (`fleetOrdersData`, `fleet.ts:2925`). `FleetOrderView` per order is the stored `FleetOrder` with
  each work order extended by `live` and `reportPath` (see 2.3).

```json
{
  "orders": [
    {
      "id": "fo186a2b3c4",
      "text": "Add a README section about the fleet",
      "status": "running",
      "createdAt": "2026-09-30T18:00:00.000Z",
      "updatedAt": "2026-09-30T18:05:00.000Z",
      "workOrders": []
    }
  ],
  "limits": { "maxSessions": 6, "running": 2, "maxParallelSessions": 30, "realTerminals": 7 },
  "watcher": { "running": true, "intervalMs": 5000 }
}
```

`limits.maxSessions` is the spawn cap (`FLEET_MAX_SESSIONS`), `running` is the count of work orders
in a running state, `realTerminals` is a measured live terminal count or `null` before the first
measurement. Ordering is `createdAt` descending so the newest order is `orders[0]`.

- **Common errors:** `500 {"error":"<stringified exception>"}` (e.g. `orders.json` unreadable).
  No auth error from loopback; off-host reads are refused with `401 {"error":"unauthorized"}`.
- **Local verify (safe, read-only):**

PowerShell:

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:8787/company/fleet" | ConvertTo-Json -Depth 6
```

curl:

```bash
curl -s http://127.0.0.1:8787/company/fleet
```

Or simply: `python scripts/fleet_check.py` (see section 4). You may pass `--base http://127.0.0.1:8787`.

### 2.3 Order detail (detail)

- **Endpoint:** `GET /company/fleet/orders/:id`
- **Purpose:** one order plus live per-worker state (`fleetOrderDetail`, `fleet.ts:2955`).
- **Request:** no body; from loopback no token.
- **Response 200:** one `FleetOrderView`. Per work order the code adds:

  - `live: { streaming: boolean, lastActivity?: string, tail: string[], model?: string }` -
    `tail` is the last ~15 lines of text/tool activity from the worker session's journal
    (`sessionLive`, default maxLines 15, `fleet.ts:569`); `streaming` means the session is
    mid-generation; `lastActivity` comes from the journal's meta timestamp (or file mtimes as a
    fallback); `model` is the model the session itself reports (journal meta, then snapshot,
    then falling back to the picked `model` in `withLive`).
  - `reportPath: string` - repo-relative path to that work order's `REPORT.md`
    (absolute path when the company root sits outside the repo, e.g. test servers).

```json
{
  "id": "fo186a2b3c4",
  "status": "running",
  "workOrders": [
    {
      "id": "WO1",
      "title": "README section",
      "role": "DOCS",
      "owns": ["README.md"],
      "state": "working",
      "verdict": null,
      "attempts": 0,
      "model": "kimi-free",
      "modelSource": "laya",
      "live": { "streaming": true, "lastActivity": "2026-09-30T18:04:59.000Z", "tail": ["Edit README.md section 3"] },
      "reportPath": "company/fleet/fo186a2b3c4/WO1/REPORT.md"
    }
  ]
}
```

- **Common errors:**
  - `404 {"error":"not found"}` for an unknown order id (server.ts 1303).
  - `500 {"error":"<stringified exception>"}` on an unexpected throw. Off-host reads are `401`.
- **Local verify (safe, read-only):** take the id of the first order from the list (`orders[0].id`).

PowerShell:

```powershell
$list = Invoke-RestMethod -Uri "http://127.0.0.1:8787/company/fleet"
Invoke-RestMethod -Uri "http://127.0.0.1:8787/company/fleet/orders/$($list.orders[0].id)" | ConvertTo-Json -Depth 6
```

curl:

```bash
curl -s http://127.0.0.1:8787/company/fleet/orders/fo186a2b3c4
```

The contract's read-only check also covers the detail route (see section 4). If the live list
is empty, the check script reports SKIP-with-reason for detail rather than creating an order.

### 2.4 Approve plan (approve)

- **Endpoint:** `POST /company/fleet/orders/:id/approve`
- **Purpose:** accept the plan (optionally with the CEO's edits) and spawn one visible jcode
  terminal per work order. Spawning is async: the POST returns as soon as the plan is accepted and
  `status` becomes `running` (`fillSlots()` runs in the background and the watcher keeps calling it).
- **Request:** header `x-company-token` (required, mutation). Body optional:
  `{ "workOrders": [ { "id": "WO1", "title": "...", "role": "...", "owns": ["README.md"],
  "brief": "...", "done": ["acceptance check"] } ] }`. When `workOrders` is present with at least
  one usable entry the plan is REPLACED by the edited list; entries with an empty `title` or
  `brief` are dropped, and none surviving throws.
  Pass no body (or an empty one) to approve the plan as-is.
- **Response 200:** the updated `FleetOrderView`, `status: "running"`; queued/edited work orders
  are `state: "queued"`.
- **Common errors:**
  - `400 {"error":"unknown fleet order <id>"}` unknown order id.
  - `400 {"error":"order <id> is <status>, not awaiting approval"}` when the order is not
    awaiting_approval (or running, which re-triggers queueing for unspawned work).
  - `400 {"error":"the edited plan had no usable work orders"}` when an edited plan rounds down to
    nothing.
  - `401 {"error":"unauthorized"}` without a valid token.
  - Unexpected throws also come back as `400` on this route (its catch-all uses 400, unlike the
    GETs that use 500).
- **Local verify:** static only against the live company. Do NOT run approve casually against the
  real `company/` on `:8787` - it opens real terminals, spends session budget, and starts real
  workers. For an actual test, spin a throwaway root instead, e.g.
  `SLACK_BRIDGE=0 PORT=8790 COMPANY_ROOT=%TEMP%\fleet-test` on a temp copy (never a second server
  on the live company root), or (pure, no HTTP): `python scripts/fleet_check.py`, whose approve
  check reads `src/server.ts` and confirms the route/method/path exist without sending anything.

### 2.5 Redo work order (redo)

- **Endpoint:** `POST /company/fleet/orders/:id/work/:wid/redo`
- **Purpose:** a REDO verdict: schedule a fresh session for one work order with the same brief plus
  the manager's review notes (`redoWorkOrder`, `fleet.ts:2319`).
- **Request:** header `x-company-token` (required, mutation). Body: none.
- **Response 200:** the updated `FleetOrderView`. On success the code:
  1. `attempts += 1`
  2. `verdict` cleared (`review` remains on the record as the next brief's notes)
  3. `sessionId`, `windowPid`, `startedAt`, `reportedAt`, `error` cleared
  4. `state` -> `queued`, `order.status` -> `running`
  5. `fillSlots()` spawn runs in the background.
- **Common errors:**
  - `400 {"error":"unknown fleet order <id>"}` unknown order id.
  - `400 {"error":"unknown work order <wid>"}` unknown or mistyped `wid`.
  - `401 {"error":"unauthorized"}` without a valid token. Other throws also surface as `400`.
- **Local verify:** same rule as approve - never against the live `company/` on `:8787` (it would
  open a real terminal and burn a work-order attempt). It is verified statically by
  `python scripts/fleet_check.py`. Delivery mechanics (what actually opens windows) can be probed
  with `npx tsx ops/fleet-deliver-probe.ts` (see `docs/FLEET_SELFCHECK.md`).

### 2.6 Cancel order (cancel)

- **Endpoint:** `POST /company/fleet/orders/:id/cancel`
- **Purpose:** stop the fleet from spawning queued work for this order. Running jcode terminals are
  NOT killed: the CEO closes those windows by hand. (`cancelFleetOrder`, `fleet.ts:2375`).
- **Request:** header `x-company-token` (required, mutation). Body: none.
- **Response 200:** the updated `FleetOrder`, with:
  `status: "cancelled"`, `closedAs: "dropped"`, `closedReason: "cancelled by the CEO"`,
  `closedAt` ISO timestamp, `closedBy: "ceo"`, and a trace hop `cancel`.
- **Common errors:**
  - `400 {"error":"unknown fleet order <id>"}` unknown order id.
  - `401 {"error":"unauthorized"}` without a valid token. Other throws also surface as `400`.
  - Re-cancel is not blocked by the code: an already-cancelled order just gets its closed fields
    re-written (idempotent effect). Nothing stops a cancelled order from being re-approved, but its
    work orders would then carry their previous state (`sessionId ? prev.state : "queued"`) rather
    than be reset.
- **Local verify:** cancel touches real fleet state on the live `company/`, so prefer the
  read-only static check (`python scripts/fleet_check.py`) and only ever cancel an order you
  created yourself for testing.

## 3. FleetOrder / WorkOrder shapes (the code is the authority)

`FleetOrder` (fleet.ts:85, stored in company/fleet/orders.json):

```ts
{
  id: string;                 // "fo" + base36 epoch ms
  text: string; createdAt: string; updatedAt: string;
  status: "planning"|"awaiting_approval"|"running"|"reviewing"|"done"|"failed"|"cancelled";
  plan?: string; specDoc?: string; workOrders: WorkOrder[]; trace: TraceStep[];
  error?: string; summary?: string;
  // restart/shutdown/retry bookkeeping (beyond FLEET_SPEC.md's type):
  plannerPid?: number; planAttempts?: number; retryCount?: number; retriedFrom?: string;
  supersededBy?: string; forceProvider?: "kimi"|"claude";
  closedAs?: "dropped"; closedReason?: string; closedAt?: string; closedBy?: string;
}
```

`WorkOrder` (`fleet.ts:44`): `{ id, title, role, owns: string[], brief, done: string[],
state: WorkOrderState, sessionId?, windowPid?, startedAt?, reportedAt?, verdict?: "PASS"|"REDO",
review?, attempts: number, error?, model?, modelReason?, modelSource?: "laya"|"rules",
sessionModel?, delivery?: { how: "targeted"|"focused"|"none", at, detail } }`.

Model selection: every work order gets a model pick (`pickFleetModel`, Laya when confidence is
above the guard, rules otherwise: `modelSource: "laya"|"rules"`), recorded on the work order and
shown through `live.model`. This is invisible in the spec, but operators reading a stuck card in the
UI should check `model` and `modelSource` before blaming the worker.

## 4. Quick check without touching anything: scripts/fleet_check.py

A read-only python checker. It never sends a POST/PUT/DELETE/PATCH (contract in
`docs/FLEET_CHECK_CONTRACT.md`). For a TypeScript health check that also compares disk state with
the HTTP answer, use `npx tsx ops/fleet-health-check.ts` (section 4b).

```powershell
python scripts/fleet_check.py            # against http://127.0.0.1:8787
python scripts/fleet_check.py --base http://127.0.0.1:8790
```

(The base URL can also come from the `FLEET_BASE` env var, per the contract.)

What it does (contract in `docs/FLEET_CHECK_CONTRACT.md`):

- `list` and `detail` are the live GETs: it calls `GET /company/fleet`, expects
  `{orders: [...], limits.maxSessions, limits.running}`, then calls
  `GET /company/fleet/orders/<first order id>` (if there are no orders it reports
  SKIP-with-reason, which counts as pass only if the static checks pass, and never creates
  an order).
- `create`, `approve`, `redo`, `cancel` are STATIC: reads `src/server.ts` (and
  `src/company/fleet.ts`) as text and confirms each route is registered with the right method
  and path pattern. It never sends POST/PUT/DELETE/PATCH.
- Output: one `PASS|FAIL <id> <METHOD> <path> - detail` line per route, then a summary.
- **Exit code 0** = all six contract checks pass; **exit 1** = at least one check failed.
  No files are written and no fleet state changes.

This is the safe way to "run something locally" against the live router: the two GETs touch nothing,
and the four mutating routes are proven by parsing the source rather than firing real requests.

## 4b. TypeScript health check: ops/fleet-health-check.ts

```powershell
npx tsx ops/fleet-health-check.ts
```

Observed 2026-10-06 against the live router (the same output, pasted verbatim, lives in
`docs/FLEET_HEALTHCHECK_EXPECTED.md`, written by the CHECK teammate):

```
fleet root : C:\Users\user\Desktop\Default Project\company\fleet
PASS  fleet root directory exists -- C:\Users\user\Desktop\Default Project\company\fleet
PASS  fleet order store parses -- 61 order(s), no parse errors
PASS  running work orders hold live sessions -- 12 live client session(s)
PASS  router answers GET /company/fleet -- 61 order(s) over HTTP at http://127.0.0.1:8787
PASS  router and disk agree on order count -- disk=61 http=61
PASS  fleet watcher is running on the live router -- http running=true interval=5000ms; module running=false interval=5000ms
PASS  GET /company/fleet -> orders + limits + watcher -- HTTP 200 for /company/fleet
PASS  GET /company/fleet/orders/:id (fomuwctyjf) -- HTTP 200 for /company/fleet/orders/fomuwctyjf

[health-check] 8/8 checks passed. FLEET BACKEND HEALTHY
EXIT=0
```

The rule, confirmed by reading the script: exit **0** plus `FLEET BACKEND HEALTHY` means the fleet
backend is healthy. exit **1** plus one plain `FAIL` line means the router is not reachable (the
script never starts a server, never spawns anything, and only ever sends GETs).

## 5. Spec vs code

Where `docs/FLEET_SPEC.md` (and `docs/FLEET_CHECK_CONTRACT.md`) and the implementation disagree,
the code is what runs; this guide documents the code.

1. **Limits.** The spec's `limits` shape says `{maxSessions, running}`. The code returns
   `limits: {maxSessions, running, maxParallelSessions, realTerminals}` and separately
   `watcher: {running, intervalMs}`. The spec omits `watcher`.
2. **Types.** The spec's `FleetOrder`/`WorkOrder` types do not mention `summary`, `specDoc`,
   `planAttempts`, `plannerPid`, `retryCount`, `retriedFrom`, `supersededBy`, `closedAs`,
   `closedReason`, `closedAt`, `closedBy`, `error` (order), `model*`, `reviewAttempts`,
   `lastReviewAttemptAt` or `delivery`; the code carries all of them (the first-order shape in
   `orders.json` on the live system today carries `planAttempts`, `summary`, `plannerPid`,
   `retryCount`, `retriedFrom`, `supersededBy`, `forceProvider` and the four `closed*` fields are
   set at cancel time). The code is the authority.
3. **Redo path.** Spec says `POST /company/fleet/orders/:id/work/:wid/redo` - code and UI match
   (`server.ts` line 1318), no change.
4. **Error status policy.** The spec does not specify codes. In the code, create 400s for its own
   validation ("text required") and 503 when the company is paused, with a 500 catch-all;
   list/detail use 500 catch-alls (detail also 404 for unknown id); approve, redo and cancel use a
   **400** catch-all for every throw, so a 400 from those routes can mean "unknown order/work
   order", a handler rejection, or an internal error string - read `error` to tell which. A
   thrown-exception 500 therefore only appears on create/list/detail.
5. **Auth guard details.** The spec says mutations need `x-company-token`; the code's guard
   additionally lets loopback GETs through without a token (the `/stream` SSE is the exception: it
   always needs the token, `?token=` accepted for EventSource). Off-host peers need the token for
   everything, and the server never binds off-host at all unless COMPANY_AUTH_TOKEN is configured
   (`assertConfig`).
6. **Live tail field.** The spec's detail response says `live: {streaming, lastActivity, tail}` -
   the code matches (`sessionLive(..., maxLines = 15)` supplies the ~15 tail lines) and additionally
   adds `live.model` (the model the session itself reports, falling back to the picked `model`),
   plus `reportPath` per work order. The spec mentions neither.
7. **Order ids.** The spec shows no id format; the code uses `fo` + base36 epoch ms (`fleet.ts`
   createFleetOrder), which the guide's examples reflect.

## 6. What to do when something fails (plain-language walkthrough)

(Cross-checked against `docs/FLEET_SPEC.md`; the distinction between the two failure kinds below
is verified in `src/company/fleet.ts` and `src/company/claudeSignIn.ts`.)

When a fleet order fails, first READ what printed on its card. The failure lands in one of two
broad kinds, and the right move differs:

**Kind A - Something a retry CAN fix (transient).** Examples (from the real code paths):

- A spend limit or rate limit from a provider (never classified as sign-in; `orderFailureCause`
  puts those in the `provider-limit` bucket, `needsYouRule.ts:150`).
- A gateway or fallback that did not answer (an outage; the order error says the planner's main
  AND fallback `LLM` both failed, with both errors included).
- A worker session died and no `REPORT.md` appeared (the watcher marks the WORK ORDER `failed`
  after `120s` of a missing session with no report; other work may still be running).

For kind A, the fleet retries on its own, in two layers, each already bounded in code:

1. **Bounded automatic retries within one order.** The planner retries at most
   `FLEET_PLAN_MAX_ATTEMPTS` times in a row (constant `planMaxAttempts()`, default **3**,
   `fleet.ts:316`); before it retries the order's `error` reads
   `planning attempt N/FLEET_PLAN_MAX_ATTEMPTS failed: ...` and a trace hop says so.
   Per-work-order REVIEW retries are similarly bounded (`reviewAttempts` vs `reviewRetries()`;
   when the cap is spent the error says `review failed Nx` or `review could not run`).
2. **Bounded re-issue of the whole job by the manager layer.** If the order still fails, the
   needs-you manager layer automatically re-issues the job (a fresh order id carrying the same
   text) at most `FLEET_ORDER_MAX_RETRIES` times, default **2** (`maxOrderRetries()`,
   `needsYouRule.ts:140`). After that the resolver refuses to mint another copy and raises ONE
   plain "this keeps failing, the cause has to be fixed first" briefing item instead of an endless
   retry prompt. When you see that item, DO NOT just re-run the same order again - the retry
   budget is deliberately spent; find the root cause or drop it (cancel) and re-order differently.

So the human rule is simple: **for kind A, wait one manager retry cycle. If the same failure
returns after the bounded retries are used, do NOT queue another retry of the same order -
troubleshoot the root cause instead.**

**Kind B - The expired-login case (the special one).** When Claude's sign-in has EXPIRED, the
planner cannot authenticate at all, and retrying cannot fix it (only a person re-logging in can).
We measured this before (`claudeSignIn.ts` comments, 2026-09-30) and the code now fails the order
ONCE with exactly one plain sentence and NO retry prompt:

> `Claude sign-in expired: the CEO must run claude /login in a terminal`

If you see that sentence on the order card (`order.error`) or in the order's trace
(what="plan failed"), the ONLY fix is a human re-login at a terminal (not a retry button):

```powershell
claude /login
```

After re-login, start a NEW fleet order for the same GOAL (do not try to revive the failed
order id). The expired-login case is specifically NOT put into the bounded retry loop
(`fleet.ts:2448-2456`) precisely because nothing automatic fixes it.

To TELL kind B apart from anything else (how the predicate decides),
`mentionsClaudeSignInExpired` (src/company/claudeSignIn.ts:48) matches these shapes and nothing
else: `failed to authenticate`, `oauth session expired`, `could not be refreshed`,
`claude oauth refresh`, `invalid_grant`, `credentials not found`, `no claudeaioauth block`,
`claude /login`. It deliberately does NOT match a 429 spend/rate limit, a timeout, a spawn
ENOENT, or a message that merely contains the word "login" - those keep their own (retryable)
handling. If you need the live check run against the real machine, that is AUTH work
(`ops/fleet-signin-predicate-check.ts`, `ops/fleet-live-signin-preview.ts`); this guide does not
duplicate it.

## 7. Existing scripts the operator may see, and what each one is for (do not run casually)

| Script | Read-only? | What it does |
|---|---|---|
| `ops/fleet-status.ts` | yes | prints every order, one line each (or one order in full with `--order`) |
| `ops/fleet-tick.ts` | no | runs exactly ONE watcher pass (advances real state; used when a review is stuck) |
| `ops/fleet-run.ts` | no | drives a whole order end to end without HTTP (same code the routes run); flags: `--text --auto-approve --approve --watch --redo <order>:<wid> --cancel --spawn-order --mock --force --max --timeout` |
| `ops/fleet-write-plan.ts` | no | hand-writes (or replaces) a plan+workorders on an existing order, manager-only; use `--order <id> --file plan.json [--approve]` |
| `ops/fleet-status.ts --order <id> --tail N` | yes | full detail of one order incl. per-worker live tail |
| `npx tsx ops/fleet-run.ts` (no args) | yes | prints its own usage and exits (no state change) |
| `python scripts/fleet_check.py [--base URL]` | yes | the six-route contract check (2 live GETs, 4 static source checks) |
| `npx tsx ops/fleet-health-check.ts` | yes | 8 PASS/FAIL lines + summary; compares disk with HTTP (section 4b) |
| `npx tsx ops/fleet-selftest.ts` | no | state-machine selftest against a THROWAWAY company root; never touches live company/ |
| `npx tsx ops/fleet-deliver-probe.ts` | no | opens one real visible jcode window in a throwaway repo to prove targeted delivery (`--keep` to leave it open); never touches live company/ |
| `npx tsx ops/fleet-http-probe.ts [--order <id>]` | yes | read-only HTTP check of the routes over the live API; needs the router running |

Real outputs you can compare with (all run 2026-10-06 on the live repo):

- `npx tsx ops/fleet-status.ts --order fomuo1rv2o` printed a full detail record (order
  status, per work order state/verdict/review/live tail) plus the `plan:` text and the `trace`
  hops - see the `company/fleet/fomuo1rv2o/GUIDE/REPORT.md` of this work order for the full dump.
- `npx tsx ops/fleet-run.ts` (no args) printed:

  ```
  usage: tsx ops/fleet-run.ts --text "<order>" [--auto-approve] [--timeout 900] [--mock]
         tsx ops/fleet-run.ts --approve <orderId> [--timeout 900]
         tsx ops/fleet-run.ts --watch <orderId>
         tsx ops/fleet-run.ts --redo <orderId>:<workOrderId>
         tsx ops/fleet-run.ts --cancel <orderId>
         tsx ops/fleet-run.ts --spawn-order <orderId>[/<wid>] [--max N]
  ```

- `npx tsx ops/fleet-status.ts --order nousuchid` printed exactly `no such fleet order: nousuchid`.
- `npx tsx ops/fleet-health-check.ts` printed `8/8 checks passed. FLEET BACKEND HEALTHY` with exit 0
  (full output in section 4b).

## 8. Files every operator may want open

- `company/fleet/orders.json`: the whole order list (61 Orders as of 2026-10-06), one JSON object
  per order with its work orders, trace, plan and error fields - the same data the dashboard
  polls, but on disk.
- `company/fleet/<orderId>/<workOrderId>/REPORT.md`: each worker's finish report; its existence is
  what moves the work order to `reported` and triggers the manager's review.
- `company/fleet/<orderId>/BOARD.jsonl`: the peer-note board between work orders (AUTH -> GUIDE
  notes etc.), written by `ops/agent-msg.ts` (needs `FLEET_TALK=1`).
- `docs/FLEET_SELFCHECK.md` (by an earlier work order): remembers the self-check scripts in other
  words, with route and shape references.

