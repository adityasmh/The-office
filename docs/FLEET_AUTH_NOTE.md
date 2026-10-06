GATE: PASS

Fleet order fomuo1rv2o - AUTH work order, evidence for the planning-step login gate.
Verified 2026-10-06 (local 22:41-22:55, UTC+05:30). No fleet order was retried or re-queued.

## How the planner logs in, and what this note proves

The planning step calls `callClaudeSubscription` (src/claudeSubscription.ts). Its default backend
is `callClaudeCode` (line ~265): it runs the real `claude.exe` CLI headless (`claude -p`) using the
Claude Code login on this machine. The raw OAuth path (`getSubscriptionAccessToken`, refresh token
in `~/.claude/.credentials.json`) runs only when `CLAUDE_BACKEND=oauth`. So the credential the
planner depends on is the CLI login, and that is what was tested here.

## THE gate check: one real `claude -p` call through the default CLI backend

The probe goes through the real brain router exactly like a planning call. Claude is named in the
text (the same override the fleet predicate check uses), so the router takes the Claude tier and
the default CLI backend spawns `claude -p` with the machine's real login. No MOCK_MODE, no fake
binary, no pinned fallback.

Exact command (run from the repo root):

```
cd /d "C:\Users\user\Desktop\Default Project"
npx tsx -e "(async()=>{ const { callClaudeSubscription } = await import('./src/claudeSubscription.ts'); try { const r = await callClaudeSubscription({ model: 'claude-sonnet-5-5', user: 'GOAL: use claude to verify the login. Reply with exactly the word: ALIVE', purpose: 'signin-gate-probe' }); console.log('CALL_OK text=' + JSON.stringify((r.text||'').slice(0,80)) + ' model=' + r.model); } catch (e) { console.log('CALL_ERR ' + e.message); } })();"
```

Raw output:

```
[brain] signin-gate-probe: tier=sonnet model=claude-sonnet-5-5 (the CEO named sonnet in the order -> sonnet [unknown purpose "signin-gate-probe" -> generate])
CALL_OK text="ALIVE" model=claude-sonnet-5-5
```

`callClaudeCode` spawned `claude.exe -p` with the real login; the CLI authenticated and answered.
That is the planner's own login path working today.

Transparency note (first probe attempt): a first probe with a purpose no one recognises and no
Claude named was routed by the brain router to the cheap gateway tier (`deepseek-v4.1-flash`) and
died there with `401 Missing API key` - it never reached the CLI, so it says nothing about the
login (also documented in the trace of this order). The CLI probe above is the one real
login-path call this work order ran.

## Predicate + harness checks (supporting, from the first pass)

The existing repo check was run once earlier in this work order, before the REDO review:

```
npx tsx ops/fleet-signin-predicate-check.ts
```

Result: ALL CHECKS PASSED, exit 0 (23/23: 6 must-match sign-in shapes, 12 must-NOT-match
negatives, and the signed-in healthy-path case where a fake `claude.exe` proves a signed-in
planner goes `via=claude` to `awaiting_approval` with 2 work orders, no fallback, no sign-in
sentence). Its full verbatim output is preserved in the session REPORT.md of the first pass and in
the board history; it exercises the predicate code, not the live login, which is why the CLI
probe above carries the gate.

`ops/fleet-live-signin-preview.ts` was read but not run: it is a read-only preview for the six
pre-existing failed orders (copies `orders.json` into a temp COMPANY_ROOT and shows what prompt
the CEO would now see). It does not re-queue anything, but running it was not needed for this
verdict; the CLI probe is the live evidence.

## Verdict

GATE: PASS. The planner's actual login path (default CLI backend, `claude -p` with the machine's
Claude Code login) authenticated and answered a real call on 2026-10-06. The predicate layer
correctly recognises every expired-sign-in shape (`invalid_grant`, refresh 401, missing
credentials, CLI "Failed to authenticate: OAuth session expired") and stays silent for 429s,
outages, and near-miss text. If the gate ever fails again, the expired credential is the
`claude.exe` CLI login (backed by the OAuth refresh token in `~/.claude/.credentials.json`), fixed
by the CEO running `claude /login` in a terminal. No secrets are printed in this note.

## File existence

- `docs/FLEET_SPEC.md`: EXISTS (read; worker preamble + fleet flow).
- `ops/fleet-*.ts`: EXIST (39 files, including `fleet-signin-predicate-check.ts`,
  `fleet-live-signin-preview.ts`, `fleet-signin-realmessages-check.ts`,
  `fleet-signin-precedence-check.ts`, `fleet-health-check.ts` added by CHECK).
- `docs/FLEET_HEALTHCHECK_EXPECTED.md`: EXISTS (CHECK's deliverable).
- `docs/FLEET_OPERATOR_GUIDE.md`: EXISTS (GUIDE's deliverable).

## No retry queued

No fleet order was retried, re-queued, or re-spawned by this work order. No server was started or
stopped. Only `docs/FLEET_AUTH_NOTE.md` (this file) was written.
