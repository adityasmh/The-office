# Work order: build today's queue of remaining work (2026-10-01)

From: manager (Claude). Model: deepseek-v4.1-flash. Repo: C:\Users\user\Desktop\Default Project

Goal: work out everything that is still unfinished as of this morning, write it down as one list,
then queue it into the Fleet so the workers do it. Plain words, no polish.

Part 1 - inventory (read-only, start now; the server may still be booting):
- Sources: docs/AGENT_COORDINATION.md (last ~25 entries), docs/HANDOVER.md section 11, docs/CEO_STATUS.md,
  docs/FLEET_OPERATOR_GUIDE.md, company/fleet/orders.json (status of every order: anything not
  done/cancelled/merged), company/system/paused.json + company/snapshots (work paused by last night's
  shutdown), company/system/runs.jsonl, any "Still open"/"not live"/"next" items in docs/*.md.
- Known open items to check first: the planner-fallback / sign-in fix is NOT live until the router restarts
  (router restart happens as part of startup - verify it is now live); scripts\promote.ps1 real promote
  (CEO-only, do NOT run); the pre-existing classifier gap (a failed order's own `error` text is not in
  the probe) which was reported as needing its own work order; graphify knowledge injection into the
  pipeline prompt; Laya tuning; the ATR service agreement PDF (lobster); provider usage panel.
- Write the result to docs/TODAY_QUEUE_2026-10-01.md: a numbered table with columns
  id | job (plain name) | why it is not done | risk (routine / CEO-only) | model (deepseek-v4.1-flash by default;
  kimi-k2.7-code only if deepseek already failed that same job, say so).

Part 2 - queue (only after GET http://localhost:8787/health answers; startup worker is bringing it up,
poll up to 10 min):
- For every ROUTINE item, create one Fleet order: POST http://localhost:8787/company/fleet/orders
  {text:"GOAL: ... DELIVERABLES: ... VERIFY: ...", autoApprove:true}. Each order text must be fully
  self-contained (see order fomuo5fjcr in company/fleet/orders.json for the shape). The token for
  mutating calls comes from GET /company/auth/bootstrap (loopback only; never print it).
- Respect the cap: at most 30 real terminals and free RAM >= ~2 GB (see memory rule: count jcode.exe
  processes excluding serve/server/keepalive/setup-hotkey, plus opencode workers). If RAM is low, queue
  anyway but let the Fleet start them as RAM frees; do not spawn extra sessions yourself.
- Before queuing, drop duplicates of orders that already exist and are still running/reviewing.
- NEVER queue as autoApprove: deleting data, spending/budget changes, logins/secrets, outbound messages
  (email/Slack to people), real promote to the live site, killing the CEO's apps. List those under
  "NEEDS CEO" in the queue doc, one plain sentence each, and do not queue them.
- Do not use "Resume all" blindly: read company/system/paused.json first and queue only the paused items
  that are routine.

Part 3 - report: append one timestamped entry to docs/AGENT_COORDINATION.md: counts (found / queued /
held for CEO), order ids, and the file path of the queue doc. Report to the manager, not the CEO.
