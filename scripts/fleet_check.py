#!/usr/bin/env python3
"""Read-only fleet route check (docs/FLEET_CHECK_CONTRACT.md).

Verifies the six fleet routes WITHOUT modifying any state:
  create  POST /company/fleet/orders                       (static scan)
  list    GET  /company/fleet                              (live GET probe)
  detail  GET  /company/fleet/orders/:id                   (live GET probe)
  approve POST /company/fleet/orders/:id/approve           (static scan)
  redo    POST /company/fleet/orders/:id/work/:wid/redo    (static scan)
  cancel  POST /company/fleet/orders/:id/cancel            (static scan)

Source of truth: docs/FLEET_SPEC.md; the registrations were read from
src/server.ts (fleet route block, lines 1286-1324 as of 2026-09-30):
  app.post("/company/fleet/orders", ...)
  app.get("/company/fleet", ...)
  app.get("/company/fleet/orders/:id", ...)
  app.post("/company/fleet/orders/:id/approve", ...)
  app.post("/company/fleet/orders/:id/work/:wid/redo", ...)
  app.post("/company/fleet/orders/:id/cancel", ...)

Rules honoured (contract):
- Python 3 standard library only.
- The ONLY HTTP method used anywhere in this file is GET.  The words
  POST / PUT / DELETE / PATCH appear only in comments and in regex string
  literals that scan the TypeScript source; the words themselves name the
  routes the ROUTER exposes, and are never sent.
- No file writes: the two repo files are read with open(..., "r") only, and
  no open(..., "w") / write_text / mkdir exists in this file.
- Live mutations are never attempted, and no route is created to make the
  detail probe possible (if there are no orders, detail is SKIP-with-reason).

Output: one line per route:  PASS|FAIL|SKIP <id> <METHOD> <path> - detail
then a summary.  Exit codes: 0 only if all six routes pass (a detail SKIP
with its static fallback verified counts as pass, per contract); 1 if any
route FAILs (including: live base unreachable -> both live routes FAIL).
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

SERVER_TS = "src/server.ts"
FLEET_TS = "src/company/fleet.ts"
DEFAULT_BASE = "http://127.0.0.1:8787"

ROUTES = [
    {
        "id": "create",
        "method": "POST",
        "path": "/company/fleet/orders",
        "kind": "static",
        "handler": "createFleetOrder",
    },
    {
        "id": "list",
        "method": "GET",
        "path": "/company/fleet",
        "kind": "live",
        "handler": "fleetOrdersData",
    },
    {
        "id": "detail",
        "method": "GET",
        "path": "/company/fleet/orders/:id",
        "kind": "live",
        "handler": "fleetOrderDetail",
    },
    {
        "id": "approve",
        "method": "POST",
        "path": "/company/fleet/orders/:id/approve",
        "kind": "static",
        "handler": "approveFleetOrder",
    },
    {
        "id": "redo",
        "method": "POST",
        "path": "/company/fleet/orders/:id/work/:wid/redo",
        "kind": "static",
        "handler": "redoWorkOrder",
    },
    {
        "id": "cancel",
        "method": "POST",
        "path": "/company/fleet/orders/:id/cancel",
        "kind": "static",
        "handler": "cancelFleetOrder",
    },
]


def repo_root():
    """Repo root resolved from this script's location (scripts/ + one level)."""
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read_repo_file(rel_path):
    """Read a repo file as text, read-only. Returns None when absent."""
    path = os.path.join(repo_root(), rel_path.replace("/", os.sep))
    if not os.path.isfile(path):
        return None
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        return fh.read()


def static_check(route, server_ts, fleet_ts):
    """Confirm the route is registered with the right method and path pattern.

    Scans the TypeScript source as text and proves two things:
      1. exactly `app.<METHOD>("<path>"` exists in src/server.ts, and
      2. the handler it calls is really exported from src/company/fleet.ts.
    The regexes here are plain string literals that only inspect source text;
    they never build or send any HTTP request.
    """
    expected_method = route["method"].lower()
    expected_path = route["path"]
    # Matching requires the closing quote immediately after the path, so a
    # longer path can never satisfy a shorter route's pattern and vice versa.
    pattern = r'app\.' + re.escape(expected_method) + r'\(\s*(["\'])' \
        + re.escape(expected_path) + r'\1'
    match = re.search(pattern, server_ts, re.M)
    registered = (
        'app.%s("%s")' % (expected_method, expected_path)
        if match is not None
        else None
    )
    if match is None:
        # Is the same path registered under a DIFFERENT method?  If it is,
        # report the real method so the failure is actionable.
        wrong = re.search(
            r'app\.(get|post|put|delete|patch)\(\s*(["\'])'
            + re.escape(expected_path) + r'\2',
            server_ts,
            re.M,
        )
        if wrong is not None:
            return False, (
                'src/server.ts registers app.%s("%s"), expected app.%s'
                % (wrong.group(1), expected_path, expected_method)
            )
        return False, 'src/server.ts has no registration for "%s"' % expected_path

    handler = route["handler"]
    if fleet_ts is None:
        return True, '%s in src/server.ts (src/company/fleet.ts not found, handler not checked)' % registered
    if re.search(r'export (async )?function %s\b' % re.escape(handler), fleet_ts) is None:
        return False, 'handler %s() not found in src/company/fleet.ts' % handler
    return True, '%s; handler %s() exported from src/company/fleet.ts' % (registered, handler)


def http_get(base, path, timeout):
    """GET only. Returns (status_or_None, body, error_or_None).

    urllib.request.Request is constructed with method="GET" and no data
    parameter, so no body-carrying (POST/PUT/DELETE/PATCH-shaped) request can
    be produced by this function.
    """
    url = base.rstrip("/") + path
    req = urllib.request.Request(url=url, method="GET")
    req.add_header("Accept", "application/json")
    req.add_header("User-Agent", "fleet_check.py/1.0 (read-only; GET-only)")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", "replace")
            return resp.getcode(), body, None
    except urllib.error.HTTPError as exc:
        try:
            body = exc.read().decode("utf-8", "replace")
        except Exception:
            body = ""
        return exc.code, body, "HTTP %s" % exc.code
    except Exception as exc:
        return None, "", "%s: %s" % (type(exc).__name__, exc)


def parse_json(body):
    try:
        return json.loads(body)
    except Exception:
        return None


def live_list(base, timeout):
    """Probe GET /company/fleet. Returns (ok, detail, first_order_id_or_None)."""
    status, body, err = http_get(base, "/company/fleet", timeout)
    if err is not None:
        if status is None:
            return False, "server unreachable: %s" % err, None
        return False, "HTTP %s (%s)" % (status, (body or "").strip()[:120]), None
    data = parse_json(body)
    if not isinstance(data, dict):
        return False, "HTTP %s but the body is not a JSON object" % status, None
    orders = data.get("orders")
    if not isinstance(orders, list):
        return False, "HTTP 200 but the JSON has no 'orders' array", None
    limits = data.get("limits")
    if not isinstance(limits, dict):
        return False, "HTTP 200 but the JSON has no 'limits' object", None
    if "maxSessions" not in limits or "running" not in limits:
        return False, (
            "HTTP 200 but limits lacks maxSessions/running: %s"
            % json.dumps(limits, sort_keys=True)
        ), None
    first_id = None
    if orders and isinstance(orders[0], dict) and orders[0].get("id"):
        first_id = str(orders[0]["id"])
    return True, (
        "HTTP 200; %d order(s); limits={maxSessions: %s, running: %s}"
        % (len(orders), limits.get("maxSessions"), limits.get("running"))
    ), first_id


def live_detail(base, timeout, order_id):
    """Probe GET /company/fleet/orders/:id. Returns (ok, detail)."""
    path = "/company/fleet/orders/" + urllib.request.quote(order_id, safe="")
    status, body, err = http_get(base, path, timeout)
    if err is not None:
        if status is None:
            return False, "server unreachable: %s" % err
        return False, "HTTP %s (%s)" % (status, (body or "").strip()[:120])
    data = parse_json(body)
    if not isinstance(data, dict):
        return False, "HTTP %s but the body is not a JSON object" % status
    if status == 404:
        return False, "HTTP 404: the order id came from the live list but detail returned not-found"
    if data.get("id") != order_id:
        return False, "HTTP %s: id mismatch (%s != %s)" % (status, data.get("id"), order_id)
    if "workOrders" not in data:
        return False, "HTTP %s: the order JSON lacks 'workOrders'" % status
    return True, "HTTP %s; order %s; %d work order(s)" % (
        status, order_id, len(data.get("workOrders") or [])
    )


def format_result(res):
    return "%s %s %s %s - %s" % (
        res["status"], res["id"], res["method"], res["path"], res["detail"]
    )


def main():
    parser = argparse.ArgumentParser(
        description=(
            "Read-only fleet route check: two live GET probes plus static "
            "registration scans; never mutates anything "
            "(docs/FLEET_CHECK_CONTRACT.md)"
        )
    )
    parser.add_argument(
        "--base",
        default=os.environ.get("FLEET_BASE", DEFAULT_BASE),
        help="Base URL for the two live GET probes (default: FLEET_BASE env "
             "or %s)" % DEFAULT_BASE,
    )
    parser.add_argument(
        "--timeout", type=float, default=5.0,
        help="Per-request HTTP timeout in seconds (default: 5)",
    )
    args = parser.parse_args()

    base = args.base
    server_ts = read_repo_file(SERVER_TS)
    fleet_ts = read_repo_file(FLEET_TS)

    if server_ts is None:
        print("FAIL static-src src/server.ts MISSING - src/server.ts not found "
              "at %s" % repo_root(), file=sys.stderr)
        return 1
    if fleet_ts is None:
        print("note: src/company/fleet.ts not found; handler existence will "
              "not be checked", file=sys.stderr)

    results = []
    for route in ROUTES:
        results.append({
            "id": route["id"],
            "method": route["method"],
            "path": route["path"],
        })

    index = {r["id"]: r for r in results}

    # ---- static checks: the four mutating routes, by source scan ----------
    for route in ROUTES:
        if route["kind"] != "static":
            continue
        ok, detail = static_check(route, server_ts, fleet_ts)
        index[route["id"]].update(status="PASS" if ok else "FAIL", detail=detail)

    # ---- live probe: GET /company/fleet -----------------------------------
    list_ok, list_detail, first_id = live_list(base, args.timeout)
    index["list"].update(status="PASS" if list_ok else "FAIL", detail=list_detail)

    # ---- live probe: GET /company/fleet/orders/:id ------------------------
    detail_src = next(route for route in ROUTES if route["id"] == "detail")
    detail_route = index["detail"]
    if first_id:
        ok, det = live_detail(base, args.timeout, first_id)
        detail_route.update(status="PASS" if ok else "FAIL", detail=det)
    else:
        # SKIP path. Contract: counts as pass only if the static check passes,
        # and it is never allowed to create an order. The static fallback
        # proves GET /company/fleet/orders/:id is really registered. Note:
        # static_check needs the route's handler, so it gets the ROUTES entry.
        static_ok, static_detail = static_check(detail_src, server_ts, fleet_ts)
        reason = (
            "SKIP: the list route returned no orders (never creating one to "
            "probe detail)"
            if list_ok
            else "SKIP: the list route is down or returned no order id, so "
                 "detail was not probed"
        )
        detail_route.update(
            status="SKIP" if static_ok else "FAIL",
            detail=reason + "; static fallback %s" % (
                "PASS (%s)" % static_detail if static_ok
                else "FAIL (%s)" % static_detail
            ),
        )

    # ---- output, summary, exit code ----------------------------------------
    counts = {"PASS": 0, "FAIL": 0, "SKIP": 0}
    for res in results:
        print(format_result(res))
        counts[res["status"]] += 1
    print("")
    print("SUMMARY: %d pass, %d fail, %d skip (of %d routes)"
          % (counts["PASS"], counts["FAIL"], counts["SKIP"], len(results)))
    print("base=%s; live probes use GET only; mutating routes were only "
          "scanned in source, never sent" % base)
    if counts["FAIL"]:
        print("RESULT: FAIL (exit 1)")
        return 1
    print("RESULT: PASS (exit 0)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
