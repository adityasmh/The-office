# Survive restarts (resume on boot)

The CEO ordered this. Written up by Claude Code (manager). Complements CRASHFIX (piglet): that work stops the restarts;
this work makes restarts harmless when they happen anyway.

## 1. Fleet planning (owner: bonehound, `src/company/fleet.ts`)
On router boot, any Fleet order still at `planning` whose planner is not a live process gets its planning restarted
automatically. Track the owner with a `plannerPid` field, the same way pipeline tasks use `runnerPid`. After 3 failed
planning attempts in a row, mark the order `failed` with the reason (no endless retries). Same for any other Fleet
state that is "in progress in this process" (e.g. `reviewing`): redo it once at boot.

## 2. Pipeline tasks (owner: RESUME; grant: `src/company/pipeline.ts`, `src/company/gates.ts`)
Change `reconcileStaleTasks()`: an interrupted task (status in `IN_MOTION` and `runnerPid` dead) is **auto-resumed**
(`resumeTask`), not marked failed. Stages already skip finished work, so it continues from the last finished step.
- Stagger: one resume every ~10 s. Cap: at most `RESUME_MAX_CONCURRENT` (default 3) resumed pipelines running at once;
  the rest wait in a boot queue.
- Count interruptions per task (`interruptions` field). After 2 interrupted attempts on the same task → mark `failed`,
  reason "interrupted twice by restarts", and make sure it shows in the Briefing under "Needs you" (message REPORTING/
  mushroom with the field name if the Briefing does not pick up failed tasks already).
- Respect the 20-session / low-RAM limits: resumed coder runs spawn opencode workers, so don't resume more while free
  RAM < 2 GB.

## 3. Claude calls in flight (owner: RESUME; grants below)
Anything left "in progress" on disk by a dead process is redone at boot, once:
- CEO assistant planning (`src/company/assistant.ts`; grant to RESUME for this only). Write a small
  `company/assistant-inflight.json` marker (message id, pid, started) before planning and clear it after. At boot, a
  marker with a dead pid → re-run that message's planning once and note "(redone after restart)" in the thread. Never
  create duplicate tasks: check whether tasks for that message already exist.
- Run-manager checks / Briefing (`runManagers.ts`, `briefing.ts`, owner REPORTING/mushroom): send mushroom a
  targeted message with the same rule. Edit them yourself only if mushroom is closed and no one owns them.

## 4. Show it (owner: RESUME; grants: `public/v2/views/flow.js`, and the trace-rendering part of
`public/v2/views/fleet.js`; their builders are closed)
Every resume adds a trace step `{from:"Router", to:<stage owner>, what:"restarted → resumed at <step>"}` (pipeline:
in `task.trace`; Fleet: bonehound adds the same to `order.trace`). The Flow and Fleet pages render it distinctly (restart icon
+ muted colour) so the CEO sees it happened.

## 5. Proof: on a TEST instance, never the live :8787
Use a test router (other PORT, `SLACK_BRIDGE=0`, `COMPANY_ROOT` = a temp copy of company/) under its own supervisor
(piglet's supervisor supports a test instance; see logs/router-test.supervisor.log, and ask piglet in the log how to run
it). Then:
- start a real small order, kill the test router mid-**planning**, let the supervisor restart it, and show the order finishes on its own;
- kill it mid-**coding**, then show the task resumes at coding and merges;
- kill it twice on one task, then show it is marked failed and appears under "Needs you".
Log timestamps, trace excerpts and final statuses in docs/AGENT_COORDINATION.md. Stop the test router/supervisor after.
Live :8787 picks this up at the next restart, which piglet does when `npx tsc --noEmit` is clean and no task is in flight.
