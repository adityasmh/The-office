# Auto-close finished terminals (after report + manager verification)

Written by Claude Code (manager). Built by the jcode session AUTOCLOSE. It works alongside docs/FLEET_SPEC.md and docs/REPORTING_SPEC.md.

## CEO's rule
When a jcode terminal has finished its work, it closes itself, but only AFTER it has reported and the manager has
verified the work. Goal: no clutter of finished windows.

## Lifecycle of a worker terminal
`working` → `reported` (REPORT.md written, or, for sessions started before the Fleet existed, its entry in
docs/AGENT_COORDINATION.md) → **manager verification** (a Claude check of the report against the real files/output) →
- **PASS** → wait `AUTOCLOSE_GRACE_S` (default 60s) with the session NOT streaming → archive → **close the window** → state `closed`.
- **REDO** → stay open. The Fleet sends it back (FLEET_SPEC). No close.
- **FAIL / stuck / needs CEO** → stay open, flagged in the Briefing under "Needs you".

## Verification (REPORTING adds this to the RunCard; AUTOCLOSE consumes it)
`RunCard` gets `verdict?: "PASS"|"REDO"|"FAIL"`, `verdictReason?: string`, `verifiedAt?: string`. A verdict is given only
when the run has reported. The manager must check evidence (files exist, the claimed commands/output are real,
`npx tsc --noEmit` if TS was touched), not just summarise. Fleet work orders already get PASS/REDO from the Fleet review;
AUTOCLOSE treats those the same.

## Closing safely (AUTOCLOSE owns `src/company/terminalReaper.ts`, `company/terminals.json`, and ONLY a startup hook for it in `src/server.ts`)
- **Registry** `company/terminals.json`: `{sessionId, sessionName, role, windowPid, clientPid, spawnedBy, spawnedAt, state, closedAt?, archive?}`.
  The Fleet registers every window it spawns (FLEET-BACKEND: call AUTOCLOSE's exported `registerTerminal()`).
  For the sessions Claude Code opened by hand today, backfill them: session id → `%USERPROFILE%\.jcode\active_pids\<id>`
  gives the jcode client pid → walk parent processes to the `powershell.exe` whose command line contains
  `jcode -p opencode-go` and whose cwd/`Set-Location` is this repo → that is the window.
- **Only ever close windows that are in the registry with `spawnedBy` = "fleet" or "claude-code".** NEVER close the
  CEO's own jcode window (session **rose**), the jcode server/daemon processes, the router, Laya, or anything else.
  Before killing, re-verify the pid is still that same powershell.exe (command line + creation time match the
  registry). A reused pid must never be killed.
- Do not close while `%USERPROFILE%\.jcode\streaming_pids\<sessionId>` exists (still generating), or while activity is
  younger than the grace period.
- **Archive first:** copy the final report plus the last ~200 lines of the journal's text to
  `company/reports/terminals/<sessionName>.md`, and put the link in the registry and the RunCard. The jcode session stays saved,
  so it can be reopened with `jcode --resume <sessionId>`. Show that command in the archive.
- **Close:** kill the powershell window's process tree (the jcode client inside it), not the jcode server. Record `closedAt`.
- **Switches:** `AUTOCLOSE=1` default on; `AUTOCLOSE=0` disables. A per-terminal "keep open" flag in the registry
  (the UI can set it: `POST /company/terminals/:sessionId/keep-open`). `GET /company/terminals` lists the registry for the UI.
- **Report up the chain:** each close adds a Done item to the Briefing ("UI team: Flow page, verified and closed").
- Runs in the same guarded loop style as the Briefing watcher: every 30s, try/catch, and it can never crash the router.

## Proof (log real output in docs/AGENT_COORDINATION.md)
1. A dry run (`AUTOCLOSE_DRY_RUN=1`) listing which of today's terminals WOULD be closed and why.
2. One real close: a test session spawned for this purpose, with a trivial order, which reports, gets PASS, and closes by itself.
   Show the registry entry, the archive file, and that the window pid is gone.
