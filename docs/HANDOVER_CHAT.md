# Handover for a fresh manager chat (written by Claude Code, 2026-09-30)

## CEO APPROVAL POLICY (CEO order, 2026-09-30) - READ THIS FIRST
The CEO no longer approves routine work. **You (the manager) decide it yourself**, and workers report
to you through docs/AGENT_COORDINATION.md - they do not wait on the CEO for it: retry/drop of a failed
or stale order or task, re-queueing, cleanups, routine fixes, which worker/model to use, test runs.

Ask the CEO ONLY for these seven things:
1. deleting data
2. spending money or budget changes
3. logins / credentials / secrets
4. sending messages to people
5. publishing/promoting to the real site (incl. the first real `promote.ps1` run)
6. killing the CEO's own apps
7. anything that could break the live system (restarting the router, etc.)

Routine retry/drop prompts are already routed out of the CEO's "needs you" list into the manager queue:
`company/reports/manager-queue.json`, `GET /api/manager-queue`, one decision pass every 60s
(`POST /api/manager-queue/tick` forces one). The queue retries a transiently-failed job by itself at
most twice, then raises exactly ONE prompt for the CEO. Details: docs/AGENT_COORDINATION.md (top).

Read this next. It is short on purpose. Details live in docs/AGENT_COORDINATION.md (the log) and docs/CEO_STATUS.md.

## Your role
You are the **manager**: plan, decide, review, and command. You do NOT implement. All execution goes to jcode
terminals (visible windows, DeepSeek flash by default). Check status cheaply, and don't poll. The dashboard's
Briefing and docs/CEO_STATUS.md already show status. Ask the CEO only for real decisions.

## CEO's standing rules (also in your memory notes)
- Delegate everything to jcode sessions; spawn several in parallel, but check RAM first (>= 2 GB free) and the terminal count (max 30 real jcode clients).
- Cost: deepseek-v4.1-flash is the default for ALL work, incl. UI. Kimi = escalation only, with a recorded reason. The UI should be useful and plain, not pretty.
- Name each session "<job> (<animal>)" (jcode session rename). Refer to workers by job name. Lookup: docs/SESSION_NAMES.md.
- Never print secrets; agents never log in for the CEO. Don't restart the router on :8787 while a task is in flight; the watchdog (LayaCompanyRouterSupervisor) restarts crashes.
- The CEO games at times: work slowly and don't spawn if RAM is low.

## System in one paragraph
Router (Express, 127.0.0.1:8787, `npx tsx src/server.ts`, supervised) + Laya (local decision model, :8000, should run on the RTX 4050, device=cuda) + jcode shared server + dashboard at http://127.0.0.1:8787/v2/ (old one at `/`). Chain: CEO -> Assistant -> Laya picks team -> Claude manager plans -> Laya picks worker model -> worker -> tester/opposer -> Claude review (PASS/LOOP) -> Assistant -> CEO. Fleet = Claude plans and spawns visible jcode terminals from the UI. Briefing = plain-words done/remaining + Inbox (approve/answer in place). Also built: run managers, auto-close of verified-done terminals, Terminals page (talk to a terminal), System page (Shut down / Start again with snapshots), Budget monitor, PDF/picture attachments, company memory + graphify, Slack two-way + report-back.

## Spawn helpers (in the old chat's scratchpad; recreate if missing)
`spawn-worker.ps1 -Name <job> -Order <text>`: checks terminal count + RAM, asks Laya for a model (`laya-pick.ps1`, gates on top-probability >= 0.33 and lead >= 0.08, NOT on `confidence`), opens a visible `jcode -p opencode-go` window, renames the session, and delivers the order with `jcode transcript --mode send -S <sessionId>` (targeted; never the focus method). Note: `-m <model>` does not actually change a session's model; option: jcode debug socket (enabled in ~/.jcode/config.toml at 00:55, applies after the jcode server restarts). Message any session: `"text" | jcode transcript --mode send -S <sessionId>`.
Count REAL terminals: jcode.exe processes without ' serve', ' server ', 'keepalive', 'setup-hotkey' in the command line. `.jcode\active_pids` is misleading (all point at the shared server).

## State at hand-over (verify first with a light check: /health lagMs, Laya /health, terminal count, RAM)
Running/reopened: **Startup + page check (badger)** starts Laya + restarts the router (the live router was pid 25808 from 20:01 yesterday, stale and freezing 20-30 s; suspected cause: background loops scanning ~95 jcode session journals), profiles it and smokes every v2 page. **Fleet builder (bonehound)**: F1, model switch via the debug socket + noul-based fleet model pick. **Survive restarts (crocodile)**: F2 proof (kill mid-coding; kill twice -> failed + Needs you). **Budget monitor (otter)**: F3 open item, then NEXT JOB **Laya decides the Claude tier before every company Claude call** (deepseek/sonnet/opus per purpose; Sonnet default; Opus rare; brainRouter.ts hooked in callClaudeSubscription).
Finished and archived (reopen from #/system or `jcode --resume <id>` if needed): shell + all v2 pages, Fleet, Briefing/run managers, Terminals, auto-close, Shut down/Start, Laya tuning, Laya on GPU, Inbox, Attachments, Speed fixes, Cleaner UI, Company memory, Voice order.

## Next steps
1. Confirm the slowness fix landed (health lag near 0, /v2/ fast, Laya cuda, Inbox/Budget routes live).
2. Review badger, bonehound, crocodile, otter reports in the log (check evidence, not claims), then close finished terminals.
3. Then the CEO gives the FIRST REAL TASK through the whole pipeline: watch it on Briefing/Flow.

## Only the CEO can do
Paste OPENCODE_SESSION_COOKIE into .env for the OpenCode Go balance; rotate the two exposed keys; add the graphify API key (if wanted) to .env; use the "Start Laya Company" desktop shortcut after a shutdown. Optional: keep this manager chat on Sonnet.
