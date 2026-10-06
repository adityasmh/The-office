# Fleet health check - command and expected output

Read-only check for the fleet backend. It makes GET requests only, imports the
fleet module read-only (`fleetRoot`, `loadFleetOrders`, `liveClientSessions`,
`fleetWatcherStatus`), never spawns a process, never starts or restarts a
server, and NEVER queues or starts a work order.

## The exact command

```
npx tsx ops/fleet-health-check.ts
```

Optional: `--base <url>` to probe a non-default router (default
`http://127.0.0.1:8787`).

## Expected output (healthy fleet)

One `PASS`/`FAIL` line per check, then a summary. Exit code `0` when healthy,
`1` when anything fails or the router cannot be reached. The order id in the
last route line is just the first order in the store, so it will naturally
change over time; what matters is `HTTP 200`.

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
```

Actual observed output on 2026-10-06 ~17:17 UTC+05:30 (pasted verbatim, exit
code 0):

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
```

## If the router is not running

Disk checks still inline PASS, the router checks FAIL with a plain line, and
exit code is `1`. No server is started for you. Observed verbatim on
2026-10-06 (probe against port 59999, where nothing listens):

```
fleet root : C:\Users\user\Desktop\Default Project\company\fleet
PASS  fleet root directory exists -- C:\Users\user\Desktop\Default Project\company\fleet
PASS  fleet order store parses -- 61 order(s), no parse errors
PASS  running work orders hold live sessions -- 12 live client session(s)
FAIL  router answers GET /company/fleet -- router not reachable at http://127.0.0.1:59999 - is it running? (this check never starts it)

[health-check] 3/4 checks passed. FLEET BACKEND UNHEALTHY
```

## Note on a prior teardown crash

The very first run of this script called `process.exit()` after top-level
`await`, which on this Windows box tripped a libuv assertion
(`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c,
line 76`, exit `-1073740791`) AFTER the summary had already printed. The script
now sets `process.exitCode` instead so Node unwinds cleanly and the real exit
code survives. Both runs above were with the fixed script.

## What each line means

- `fleet root directory exists` - the `company/fleet` directory on disk.
- `fleet order store parses` - `fleet-orders.json` parses as `FleetOrder[]`.
- `running work orders hold live sessions` - every `working`/`idle` work order
  in a `running` order points at a live client session (no stale sessions).
- `router answers GET /company/fleet` - the live router serves the fleet view.
- `router and disk agree on order count` - the HTTP view matches disk (catches
  a router serving a stale or foreign COMPANY_ROOT).
- `fleet watcher is running on the live router` - the in-router tick loop is on.
- `GET /company/fleet -> ...` and `GET /company/fleet/orders/:id` - the two
  documented fleet routes answer 200.
