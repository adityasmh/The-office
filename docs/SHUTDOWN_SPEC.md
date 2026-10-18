# Shut down everything / start everything again (with full snapshots)

Written by Claude Code (manager), ordered by the CEO. Built by the jcode session SHUTDOWN.

## CEO's ask
A button in the dashboard that shuts the whole company down so it uses no RAM, after saving what every
terminal/script was doing, so that when it starts again everything picks up where it left off.

## Ownership
SHUTDOWN owns: new `src/company/lifecycle.ts`, `ops/shutdown-all.ps1`, `ops/start-all.ps1`, a Desktop shortcut
"Start Laya Company", new `public/v2/views/system.js` (route `#/system`), `company/snapshots/**`, and ONLY the
`/company/system/*` routes in `src/server.ts` (small exact edits). Coordinate using targeted messages
(`jcode transcript --mode send -S <sessionId>`) with:
- UI-SHELL mizaru (`session_mizaru_1790685591683_c6e9ea8ce232697f`): add a red "Shut down" button in the top bar that
  opens `#/system`, plus a "System" nav item. Do not edit app.js yourself unless mizaru is closed.
- CRASHFIX piglet (`session_piglet_1790685679878_236ce98ea869a4b1`): how to stop/start the supervisor scheduled task
  `LayaCompanyRouterSupervisor` and the router cleanly.
- RESUME crocodile (`session_crocodile_1790690347296_70dc549120a2f09e`): tasks paused by shutdown must be resumed by
  its boot logic, not marked failed. Agree on a status/flag (e.g. `pausedByShutdown: true`, which does NOT count as an
  interruption).
- AUTOCLOSE hibiscus: its terminal registry has window pids. Reuse `company/terminals.json`.
- FLEET bonehound: Fleet orders in flight get snapshotted and resumed the same way.

## 1. Snapshot (`POST /company/system/snapshot`, also step 1 of shutdown)
Writes `company/snapshots/<ISO-timestamp>/` with `index.json` plus one file per item:
- **Every real jcode terminal** (jcode.exe clients, excluding serve/server/keepalive/setup-hotkey; map each to its
  session id via its command line `--resume <id>` or the journal/registry; include the CEO's own window, **rose**):
  `terminals/<name>.json` = { sessionId, name, role, workOrder (full), state (working/idle), lastActivity, runCard
  (headline/done/remaining/verdict if REPORTING has one), ownedFiles, lastSteps (the last ~40 readable journal lines),
  **resumeBrief** }. The **resumeBrief** is a self-contained message for when it comes back: "You were interrupted by a
  planned shutdown at <time>. Your order was: … Done so far: … You were in the middle of: … Remaining: … Check the
  files before continuing."
- **Checkpoint from each working terminal:** before closing, send each one (targeted `-S`):
  "[Manager] Planned shutdown in 60s: write a checkpoint of what you're doing and what's left to
  company/snapshots/<ts>/checkpoints/<name>.md now, then stop." Wait up to `SHUTDOWN_CHECKPOINT_S` (default 90s) for the
  files, and use whatever arrived. Merge them into the resumeBrief.
- **Pipeline tasks** in motion (status in IN_MOTION): record them and mark them `pausedByShutdown`.
- **Fleet orders** not done: record them (bonehound's fields).
- **Assistant**: the last N thread messages, plus any in-flight planning marker.
- **Test servers / opencode workers** still running: list them (they get stopped, not resumed).
Snapshots must never contain secrets. Redact key/token-looking strings.

## 2. Shut down (`POST /company/system/shutdown {confirm:true}`, token required)
Order: pause new work (a flag that makes the assistant/fleet/pipeline refuse new starts) → snapshot (incl. checkpoints)
→ close all jcode terminal windows (the window process tree; re-check pid + command line first) → stop opencode workers and
agents' test servers → stop the jcode shared server (`jcode server stop`; find the exact command) → stop Laya (:8000,
both the venv launcher and the python child) → disable/stop the supervisor task → stop the router LAST. Since the
router dies, the endpoint returns immediately with the snapshot path, and a detached `ops/shutdown-all.ps1` does the
closing. The script writes progress to `logs/shutdown.log`. **Do not** touch Claude Code / Claude Desktop, browsers, or
anything not in this list. End state: none of our processes left (verify: no node/jcode/opencode/python-laya processes from us).
`ops/shutdown-all.ps1` must also work standalone (from a terminal) with the same behaviour.

## 3. Start again
- `ops/start-all.ps1` + a Desktop shortcut "Start Laya Company": start Laya → wait for health → enable and start the
  supervisor task → wait for router health → open `http://127.0.0.1:8787/v2/#/system` in the default browser.
- The dashboard's System page shows the latest snapshot: "Saved at 21:10: 13 terminals, 2 tasks, 1 fleet order", with
  per-terminal checkboxes (all checked by default) and a **"Resume all"** button.
- Resume: for each selected terminal, open a visible window `jcode --resume <sessionId>` (so it keeps its context), then
  deliver its resumeBrief with `-S`. Stagger (one every ~8 s) and obey `MAX_PARALLEL_SESSIONS` (the CEO raised it to
  **30**) and `MIN_FREE_RAM_MB` (2048); queue the rest. Tasks with `pausedByShutdown` → resumed via RESUME's logic.
  Fleet orders → bonehound's resume. Mark the snapshot `restoredAt`.
- The trace gets a step "Shut down by CEO at <t> → resumed at <step>" for tasks and fleet orders.

## 4. UI (`#/system`, v2 contract in docs/UI_V2_SPEC.md)
- A status panel: router, Laya, jcode server, supervisor, number of terminals, opencode workers, free RAM.
- A red **Shut down everything** button → a confirm dialog listing exactly what will close and saying "each terminal saves
  a checkpoint first (~90 s)" → progress view (checkpoints arriving) until the router goes away → then a final screen:
  "Everything is off. To start again, double-click 'Start Laya Company' on your Desktop."
- The latest snapshots list (time, counts) and **Resume all** / per-terminal resume.
- "Snapshot now" (without shutting down).

## Proof (real output in docs/AGENT_COORDINATION.md)
Do NOT shut down the live company to test. Test `lifecycle.ts` with a TEST router (other PORT, SLACK_BRIDGE=0, temp
COMPANY_ROOT) and 2 throwaway jcode sessions you spawn yourself: snapshot → checkpoints arrive → shutdown closes only
those two plus the test router → start-all (with a test flag pointing at the test port) → resume reopens both with
their briefs. Show the snapshot index, a resumeBrief, and the process list before and after. The real live shutdown is
the CEO's button, not yours.
