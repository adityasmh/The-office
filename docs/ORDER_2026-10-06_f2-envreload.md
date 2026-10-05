# Order F2-ENVRELOAD: reload selected settings without restarting the router

Narrow job. Do exactly these steps, print the final report, and END your turn. Do not wait, poll, loop, or re-read this order.

## Why
The router reads `.env` once at boot. When the GitHub token was replaced, the router kept the old one and the PR step failed with `401 Bad credentials` until a restart. Add a guarded way to re-read a small allow-list of settings.

## Rules
- You may create `src/company/envReload.ts` and `ops/env-reload-check.ts`. You may make ONE small insertion in `src/server.ts` (the route below, placed next to the existing `/company/system/*` routes) plus its import. Edit nothing else. Other workers are editing `src/company/fleet.ts`, `src/company/fleetGithub.ts` and `public/v2/views/fleet.js` right now: do NOT touch those.
- Make changes with small targeted edits, never rewrite an entire file.
- Never restart or start the router. Never touch `.env` itself (read it only through the function below), `company/`, Laya, Kafka, or scheduled tasks. Never print, log or return any VALUE from `.env`; only key names. No network calls in your tests.
- Run each command ONCE, in the foreground. If a step fails, report the exact error and END your turn; do not retry in a loop.
- Match the surrounding style (ES modules, `.js` import suffixes, no new dependencies).

## What to build
1. `src/company/envReload.ts` exports `reloadEnv(envPath?)`. It parses the `.env` file (simple `KEY=VALUE` lines, ignore comments and blank lines, strip one pair of surrounding quotes) and copies into `process.env` ONLY keys on this allow-list: `GITHUB_TOKEN`, `FLEET_GITHUB`, `FLEET_GITHUB_REPO`, `FLEET_GITHUB_DRY_RUN`, `FLEET_GITHUB_BASE`, `DEEPSEEK_DIRECT`, `DEEPSEEK_DIRECT_ALL_HOURS`, `DEEPSEEK_OFFPEAK_DIRECT`, `GO_QUOTA_DEEPSEEK_BELOW_PCT`, `FLEET_MAX_SESSIONS`, `MAX_PARALLEL_SESSIONS`, `MIN_FREE_RAM_MB`, `FLEET_AUTO_APPROVE`. It must NOT touch any other key (no API keys other than `GITHUB_TOKEN`, no `COMPANY_AUTH_TOKEN`, no Slack keys). It returns `{ changed: string[], unchanged: number, skipped: string[] }` where `changed` lists key NAMES whose value differs from the current `process.env` and `skipped` lists allow-listed keys that were absent from the file. Values are never returned.
2. `POST /company/reload-env` in `src/server.ts`: behind the existing company guard (`x-company-token`, like every other POST under `/company`). Calls `reloadEnv()` and returns its result. Refuse with 409 while an order is being planned or a work order is `starting`, to avoid changing settings mid-step (use the existing fleet orders accessor; if there is no simple accessor, skip this refusal and say so in the report).

## Proof (`ops/env-reload-check.ts`, a temp `.env` file and a copy of `process.env`, no real file touched)
Print PASS or FAIL per line:
- An allow-listed key whose value changed is listed in `changed` and `process.env` has the new value.
- A key not on the allow-list (for example `SOME_OTHER_KEY` and `COMPANY_AUTH_TOKEN`) is NOT copied into `process.env`.
- The returned object contains no value (search the JSON text for the secret-looking test values).
- Comments, blank lines and quoted values parse correctly.
- An allow-listed key missing from the file appears in `skipped` and leaves `process.env` unchanged.
- Calling it twice in a row returns an empty `changed` the second time.

## Finish
1. Run `npx tsc --noEmit` once.
2. Run `npx tsx ops/env-reload-check.ts` once.
3. Write `docs/REPORT_2026-10-06_F2-ENVRELOAD.md` with the changed line ranges, the exact output of both runs, and any open issue. Print the same report and END your turn.
