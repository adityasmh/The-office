# REPORT - Order F2-ENVRELOAD: reload selected settings without restarting the router

Date: 2026-10-06 (UTC) / order file `docs/ORDER_2026-10-06_f2-envreload.md`
Worker: F2-ENVRELOAD. Status: **DONE, both runs PASS.**

## What changed (line ranges)

| File | Lines | Change |
| --- | --- | --- |
| `src/company/envReload.ts` | 1-105 (new file) | `RELOADABLE_ENV_KEYS` (13-key allow-list), `parseEnvText()`, `reloadEnv(envPath?)` returning `{ changed, unchanged, skipped }`. Key names only, never values. |
| `src/server.ts` | 41 (modified) | Added `loadFleetOrders` to the existing `./company/fleet.js` import list (the existing fleet orders accessor, used for the 409 refusal). |
| `src/server.ts` | 43-46 (inserted) | 3-line ENV-RELOAD comment + `import { reloadEnv } from "./company/envReload.js";` |
| `src/server.ts` | 1772-1793 (inserted) | `POST /company/reload-env`, placed immediately after `POST /company/system/resume` and before the LAYA-CTL block (i.e. next to the existing `/company/system/*` routes). Rides the existing `companyGuard` (`x-company-token`). Returns 409 `{error:"busy"}` when `loadFleetOrders()` shows an order with `status === "planning"` or any work order with `state === "starting"`; otherwise returns `reloadEnv()`. |
| `ops/env-reload-check.ts` | 1-149 (new file) | Proof harness. Uses a temp `.env` in the OS temp dir and a copy of `process.env` (restored in `finally`). No network, never opens the repository `.env`. |

No other file was touched. `src/company/fleet.ts`, `src/company/fleetGithub.ts` and `public/v2/views/fleet.js` were not edited. `.env` was never read, written or printed.

`reloadEnv()` copies **only** these keys into `process.env`: `GITHUB_TOKEN`, `FLEET_GITHUB`, `FLEET_GITHUB_REPO`, `FLEET_GITHUB_DRY_RUN`, `FLEET_GITHUB_BASE`, `DEEPSEEK_DIRECT`, `DEEPSEEK_DIRECT_ALL_HOURS`, `DEEPSEEK_OFFPEAK_DIRECT`, `GO_QUOTA_DEEPSEEK_BELOW_PCT`, `FLEET_MAX_SESSIONS`, `MAX_PARALLEL_SESSIONS`, `MIN_FREE_RAM_MB`, `FLEET_AUTO_APPROVE`. Everything else in the file is parsed but never copied. Values are never returned or logged.

## Run 1 - `npx tsc --noEmit` (once, foreground)

```
Command completed successfully (no output)
```

Exit code 0. No diagnostics.

## Run 2 - `npx tsx ops/env-reload-check.ts` (once, foreground)

```
PASS changed allow-listed key is listed and process.env has the new value  -> changed=["GITHUB_TOKEN","FLEET_GITHUB_DRY_RUN","FLEET_GITHUB_BASE"]; token matches=true
PASS non-allow-listed keys (SOME_OTHER_KEY, COMPANY_AUTH_TOKEN, OPENCODE_API_KEY) are not copied  -> none present in process.env
PASS returned object contains no value  -> result keys=["changed","unchanged","skipped"]
PASS comments, blank lines, whitespace and quoted values parse correctly  -> changed=["FLEET_GITHUB_BASE","FLEET_GITHUB_DRY_RUN","GITHUB_TOKEN"]; quoted values match=true
PASS allow-listed key missing from the file is skipped and unchanged  -> skipped=["FLEET_GITHUB","FLEET_GITHUB_REPO","DEEPSEEK_DIRECT_ALL_HOURS","DEEPSEEK_OFFPEAK_DIRECT","GO_QUOTA_DEEPSEEK_BELOW_PCT","MAX_PARALLEL_SESSIONS","MIN_FREE_RAM_MB","FLEET_AUTO_APPROVE"]
PASS second call in a row returns an empty changed  -> changed=[]; unchanged=5; skipped=8
env-reload-check: all checks passed
```

Exit code 0. The six required claims map to the six PASS lines in order (changed key copied, off-list keys not copied, no value in the result, comments/blank/quotes parse, missing key skipped and left alone, second call idempotent).

## Open issues

1. **The route itself was not exercised at runtime.** The order forbids starting or restarting the router, so `POST /company/reload-env` is verified by `tsc` plus source inspection only (guard inherited from `app.use("/company", companyGuard)` at line 368, which every POST under `/company` already uses). The module logic behind it is covered by the six proof checks.
2. **The 409 refusal uses the existing accessor** `loadFleetOrders()` from `src/company/fleet.ts` (its `FleetOrder[]`, `status === "planning"`, `workOrders[].state === "starting"`). That is the simple accessor the order asked for, so the refusal is implemented rather than skipped. If the file cannot be read, `loadFleetOrders()` returns `[]`, so a missing orders file cannot block a reload.
3. **`reloadEnv()` with no argument defaults to `<cwd>/.env`.** The proof never calls it without a path, so the repository's `.env` is never opened by the harness.
4. **Unrelated working-tree change noticed:** `src/company/github.ts` shows as modified in `git status`, and `company-temp-perf6/` and `.bak-*` files exist. These are other workers' changes, not part of this order; my typecheck run passed with them in place.
5. No retry was made for either command; each ran exactly once.
