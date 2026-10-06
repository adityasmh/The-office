# FLEET_LOGIN root cause: Claude CLI OAuth refresh token was invalid

## Symptom

Fleet orders failed before producing work orders. The orders.json error is the generic
`"the planner produced no usable work orders"`, but the underlying cause is that the
manager planner (`src/company/fleet.ts` -> `planOrder` -> `callClaudeSubscription` ->
`callClaudeCode`) could not log in to Claude.

## Specific cause

**The Claude CLI OAuth refresh token in `~/.claude/.credentials.json` was invalid (expired / revoked / unable to refresh).**

Evidence from the dead orders on 2026-09-30:

1. `company/fleet/orders.json` trace for `fomunvwzli` (created 2026-09-30T09:10:09.462Z, failed):

   ```
   2026-09-30T09:10:16.902Z Fleet -> Claude (manager) | planner via kimi |
   kimi-k2.7-code (Claude claude-sonnet-5-5 unavailable: Error: claude -p error:
   Failed to authenticate: OAuth session expired and could not be refreshed)
   ```

2. The same OAuth failure appears in the run card for `fomunvwzli` in
   `company/reports/runs.jsonl`:

   ```json
   {
     "runId": "fleet:fomunvwzli",
     "state": "failed",
     "verdict": "FAIL",
     "modelReason": "Opus ceiling: the run failed (the gate decides); the manager check failed: claude -p error: Failed to authenticate: OAuth session expired and could not be refreshed"
   }
   ```

3. `logs/router.err.log` shows the exact sign-in failure during planning at the same
   timestamps as the dead orders. The failures cluster at 09:10, 10:28, 10:34-10:36
   on 2026-09-30, matching the creation times of the failed orders:

   ```
   [2026-09-30T09:10:11.789Z] [fleet] planning: Claude claude-sonnet-5-5 unavailable (Error: claude -p error: Failed to authenticate: OAuth session expired and could not be refreshed); falling back to kimi-k2.7-code
   [2026-09-30T10:28:11.231Z] [fleet] planning: Claude claude-sonnet-5-5 unavailable (Error: claude -p error: Failed to authenticate: OAuth session expired and could not be refreshed); falling back to kimi-k2.7-code
   [2026-09-30T10:28:14.871Z] [fleet] planning: Claude claude-sonnet-5-5 unavailable (Error: claude -p error: Failed to authenticate: OAuth session expired and could not be refreshed); falling back to kimi-k2.7-code
   [2026-09-30T10:34:42.321Z] [fleet] planning: Claude claude-sonnet-5-5 unavailable (Error: claude -p error: Failed to authenticate: OAuth session expired and could not be refreshed); falling back to kimi-k2.7-code
   [2026-09-30T10:34:51.601Z] [fleet] planning: Claude claude-sonnet-5-5 unavailable (Error: claude -p error: Failed to authenticate: OAuth session expired and could not be refreshed); falling back to kimi-k2.7-code
   [2026-09-30T10:35:34.182Z] [fleet] planning: Claude claude-sonnet-5-5 unavailable (Error: claude -p error: Failed to authenticate: OAuth session expired and could not be refreshed); falling back to kimi-k2.7-code
   [2026-09-30T10:36:47.158Z] [fleet] planning: Claude claude-sonnet-5-5 unavailable (Error: claude -p error: Failed to authenticate: OAuth session expired and could not be refreshed); falling back to kimi-k2.7-code
   [2026-09-30T10:36:47.763Z] [fleet] planning: Claude claude-sonnet-5-5 unavailable (Error: claude -p error: Failed to authenticate: OAuth session expired and could not be refreshed); falling back to kimi-k2.7-code
   ```

4. The affected orders are `fomunvwzli`, `fomunyq2z7`, `fomunyqgxm`, `fomunyxo58`,
   `fomunyxv8p`, `fomunypa98`, `fomunypcu4`, `fomunyyrme`, `fomunz0cbp`, and
   `fomunz0ciu` on 2026-09-30. Several review failures on the same day show the same
   string.

## Mechanism

1. `src/claudeSubscription.ts` uses the official Claude Code CLI (`claude -p`) for the
   manager planner/reviewer when `CLAUDE_BACKEND` is not set to `oauth`.
2. The CLI reads the OAuth session from `%USERPROFILE%\.claude\.credentials.json`
   (or `~/.claude/.credentials.json`).
3. The credential file contained a `claudeAiOauth` block with an `accessToken`,
   `refreshToken`, and `expiresAt`. When the access token expired, the CLI tried to
   refresh it with the refresh token.
4. The refresh failed (`OAuth session expired and could not be refreshed`), which
   means the refresh token itself was invalid, expired, or revoked by Anthropic.
   `claude -p` therefore returned `is_error: true` with a sign-in message instead of
   a plan.
5. `planOrReviewModel` in `src/company/fleet.ts` recognises the sign-in shape via
   `mentionsClaudeSignInExpired()` and tries the gateway fallback, but the fallback
   models often return prose, tool-call markup, or reasoning-only output instead of the
   required JSON plan. The order then dies with `"the planner produced no usable work
   orders"`.

The refresh-failure shape `Claude OAuth refresh 400: {"error":"invalid_grant"}` is
already recognised by the sign-in predicate, confirming that an invalid refresh token
is the known failure mode.

## Reproduction: exact planner command with a broken credential

The planner runs `claude -p` with these arguments (see `callClaudeCode` in
`src/claudeSubscription.ts`):

```powershell
claude -p --model claude-sonnet-5-5 --output-format json --no-session-persistence --strict-mcp-config --tools Read
```

With a valid session the command answers (cost measured below).

To prove the failure mode, move the credential file aside temporarily and run the same
command. The output is an explicit sign-in failure:

```powershell
$cred = Join-Path $env:USERPROFILE '.claude\.credentials.json'
$bak = "$cred.bak-fleet-login-test"
Copy-Item $cred $bak -Force
Remove-Item $cred -Force
try {
  'Say login-ok' | claude -p --model claude-sonnet-5-5 --output-format json --no-session-persistence --strict-mcp-config --tools Read
} finally {
  Copy-Item $bak $cred -Force
  Remove-Item $bak -Force
}
```

Real output (credential restored immediately after):

```text
credential file moved aside
--- claude -p output ---
{
  "duration_api_ms": 0,
  "stop_reason": "stop_sequence",
  "session_id": "19ce746a-d64d-4d19-a189-6c2911e7c62b",
  "total_cost_usd": 0,
  "is_error": true,
  "result": "Not logged in · Please run /login",
  "type": "result"
}
credential file restored
```

## Current credential status

As of this writing the credential file exists, is readable, and the session is valid:

```text
path: C:\Users\user\.claude\.credentials.json
exists: True
has claudeAiOauth: True
accessToken present: True
refreshToken present: True
expiresAt ms: 1791335466980
expiresAt ISO: 2026-10-07T01:11:06.980000+00:00
expiresInMin: ~455
```

The session currently refreshes and runs. A real `claude -p` probe with the restored
credential answers successfully (cost ~$0.06-$0.08).

## Why the fix must probe, not just read the file

The old guard read the credential file and treated an access token within one hour of
`expiresAt` as a hard failure. That was wrong: the Claude CLI normally refreshes a
short-lived access token on its own using the refresh token. A refreshable session is
healthy even when `expiresAt` is close. The new guard uses the credential file only as
an early warning and confirms login health with a cheap real `claude -p` probe before
blocking.

## Files changed

- `src/company/claudeSignIn.ts` — added `probeClaudeSignIn()`; `claudeSignInCheck()` no
  longer false-refuses near-expiry credentials.
- `src/company/fleet.ts` — startup guard and per-plan preflight now await the real
  probe; planner cost is logged in the debug line.
- `ops/fleet-planning-login-guard.ts` — probe exercises the real credential and a
  temporarily broken real credential.
- `src/server.ts`, `ops/fleet-run.ts`, `ops/loop-fix-check.ts` — await the now-async
  `startFleetWatcher()`.
