# REPORT F09-notify-webhook: notifications to any webhook (Discord, Slack, ntfy), not only the Slack bridge

## Changed files
| File | Change |
|---|---|
| `src/company/notify.ts` | NEW. `notify(event, order)` plus `buildNotifyPayload()` / `notifyRequest()` helpers. Env: `NOTIFY_WEBHOOK_URL` (unset = off), `NOTIFY_FORMAT` (`json` default, `slack`, `discord`, `ntfy`), `NOTIFY_EVENTS` (default `done,failed,awaiting_approval`), `NOTIFY_DRY_RUN=1`. One `fetch` POST, `AbortController` 5 s timeout, top-level try/catch + inner catch so it **never throws**, de-dup per `(order id, event)` for the life of the process, host-only logging. |
| `ops/notify-check.ts` | NEW. Local stub HTTP server on `127.0.0.1:<random>` (`/hook` 200, `/err` 500, `/hang` never answers), no real network. 14 PASS/FAIL lines. |
| `src/company/fleet.ts` | 1 import line + **3** guarded calls: `notify("awaiting_approval", order)` right after `order.status = "awaiting_approval"` in `planOrder`; `notify("done", order)` in `settleOrder`'s all-PASS branch; `notify("failed", order)` in `settleOrder`'s failed branch. Each is `try { void notify(...).catch(() => undefined); } catch {}`. Nothing else touched. |
| `src/company/envReload.ts` | `NOTIFY_WEBHOOK_URL`, `NOTIFY_FORMAT`, `NOTIFY_EVENTS`, `NOTIFY_DRY_RUN` appended to `RELOADABLE_ENV_KEYS`. Nothing else touched. |

## Behaviour
- **Off by default**: with `NOTIFY_WEBHOOK_URL` unset, `notify()` returns `{outcome:"off"}` before any payload is built; no fetch, no log.
- **Payload is short and boring**: `{ event, id, text, status, prs:[{id,url}] }` where `text` is `order.text.slice(0,120)`. Report/review/plan/error text and file contents are never read (the structural `NotifyOrder` type does not even declare them), and no env value is ever read into the payload. Only `http(s)` PR links are relayed.
- **Formats**: `json` = the payload object; `slack` = `{"text": message}`; `discord` = `{"content": message}`; `ntfy` = plain-text message body to the topic URL plus a `Title` header. An unknown/unset format falls back to `json`.
- **Filtering + de-dup**: an event not in `NOTIFY_EVENTS` returns `{outcome:"skipped-event"}`; a second `(order id, event)` returns `{outcome:"duplicate"}`. The key is recorded *before* the send, so a 500 or a hang is not retried for that event.
- **Never throws, never blocks**: 5 s abort, response body drained, all failures become `{outcome:"error"}` plus one `[notify]` line. Call sites are fire-and-forget inside try/catch, so a webhook cannot change an order's state.
- **No URL in logs**: log lines name only the host (`[notify] ... -> 127.0.0.1:PORT ...`); any error text has the URL scrubbed to `[webhook]` first. The URL is allow-listed in `envReload` like a token/secret name, and `reloadEnv` still returns key names only.

## Proof: `npx tsx ops/notify-check.ts` (exact output)
```
PASS off: NOTIFY_WEBHOOK_URL unset means the feature is off and nothing is sent  -> outcome=off; requests=0
PASS NOTIFY_FORMAT=json produces the right body shape  -> outcome=sent; requests=1; keys=event,id,prs,status,text; text.len=120
PASS NOTIFY_FORMAT=slack produces the right body shape  -> outcome=sent; requests=1; keys=text
PASS NOTIFY_FORMAT=discord produces the right body shape  -> outcome=sent; requests=1; keys=content
PASS NOTIFY_FORMAT=ntfy produces the right body shape  -> outcome=sent; requests=1; title=Fleet order fo-fmt-ntfy done
PASS events outside NOTIFY_EVENTS are skipped (cancelled, and done when only failed is listed)  -> outcomes=skipped-event/skipped-event; requests=0
PASS awaiting_approval is a default event and is sent  -> outcome=sent; requests=1
PASS a second identical (order id, event) is de-duplicated  -> outcomes=sent/duplicate; requests=1
PASS a stub that returns 500 does not throw  -> outcome=error; httpStatus=500
PASS a stub that hangs is aborted at the 5s timeout without throwing  -> outcome=error; elapsed=5009ms
[notify] dry-run done fo-dry -> 127.0.0.1:50370 (json, 302 bytes): {"event":"done","id":"fo-dry","text":"Fix the flaky publish step in the fleet so a red CI result never publishes a draft PR. Fix the flaky publish step in the","status":"done","prs":[{"id":"WO1","url":"https://github.com/acme/repo/pull/123"},{"id":"WO2","url":"https://github.com/acme/repo/pull/124"}]}
PASS dry-run sends nothing and logs the payload  -> outcome=dry-run; requests=0; logged=true
PASS no env value and no report/plan/error text appears in any payload  -> requests=8; leaked=0
PASS the webhook URL never appears in the logs (only its host is logged)  -> urlInLogs=false; hostInLogs=true
PASS the payload text is the first 120 characters of the order text  -> len=120
notify-check: all checks passed

[notify] done fo-500: 127.0.0.1:50370 answered 500
[notify] failed fo-hang: POST to 127.0.0.1:50370 failed: This operation was aborted
```
(14/14 PASS. The two trailing `[notify]` lines are the 500 and hang cases logging their failure; the port is the stub's random port, printed here because it is not a secret.)

## Regression checks (run once)
- `npx tsx ops/env-reload-check.ts` -> `env-reload-check: all checks passed` (the new keys appear in `skipped`; the file-absent count is computed from `RELOADABLE_ENV_KEYS.length`, so it stays correct: `unchanged=5; skipped=12`).
- `npx tsc --noEmit` -> no output (clean).

## Open issues
- The three wired moments are the order-level ones (`awaiting_approval`, and `done`/`failed` from `settleOrder`). `order.status = "failed"` also happens on the planning-failure paths (Claude sign-in expired, plan retries exhausted, planner produced no work orders, empty order text) and in `reconcileBoot`; those are NOT wired, because the order asks for exactly one guarded call at each of the three moments. If plan-time failures should notify too, add `notify("failed", order)` at those sites (de-dup already makes repeats harmless).
- `settleOrder` decides `done`/`failed` before emitting the assistant entry, so the notification goes out at the same moment the order flips; a cancelled order (`cancelFleetOrder`) does not notify.
- ntfy is sent as a plain-text body to the topic URL with a `Title` header. If a deployment points `NOTIFY_WEBHOOK_URL` at the ntfy JSON publish root (`https://ntfy.sh`) instead of a topic URL, the plain body will not contain a `topic` and ntfy will reject it; the topic-URL form is the documented one and is what the proof checks.
- No live router, Laya, Kafka, Slack bridge or scheduled task was started or touched; no real network call was made and no `.env` was read.
