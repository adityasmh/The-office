# Morning summary (overnight run, 2026-10-06)

Everything below was built by guarded workers on OpenCode Go (no DeepSeek credits used; balance unchanged at $2.39), verified by me, and pushed to the `fleet-orchestrator` branch. Reddit could not be read by my search tool, so the research used developer blogs and security write-ups (see `docs/overnight/RESEARCH.md`).

## 14 features
| # | Feature | Command | Proof |
|---|---|---|---|
| F01 | Doctor: what is missing on this machine | `npm run doctor` | `ops/doctor-check.ts` |
| F02 | Setup wizard: safe first `.env`, mock mode on | `npm run setup` | `ops/setup-check.ts` |
| F03 | Secret scanner plus git hooks | `npm run scan:secrets`, `npm run hooks:install` | `ops/secret-scan-check.ts` |
| F04 | Cost report: credits vs quota, by day/provider/model/worker | `npm run cost` | `ops/cost-report-check.ts` |
| F05 | Order report: shareable post-mortem (Markdown or HTML) | `npm run order:report -- <id>` | `ops/order-report-check.ts` |
| F06 | Fleet CLI: status, orders, new, approve, cancel, workers, tail | `npm run fleet -- status` | `ops/fleet-cli-check.ts` |
| F07 | Order templates that cannot make workers loop | `npm run order:new -- <template>` | `ops/new-order-check.ts` |
| F08 | Run every offline check, plus a CI workflow | `npm run check:all` | `ops/run-all-checks-check.ts` |
| F09 | Webhook notifications (Slack, Discord, ntfy, JSON) | env `NOTIFY_WEBHOOK_URL` | `ops/notify-check.ts` |
| F10 | Policy file: protected paths agents may not change | `policy.example.json` | `ops/policy-check.ts` |
| F11 | Docker and dev container (mock mode) | `docker-compose.yml` | parsed only, not built here |
| F12 | Docs pack: README, quickstart, architecture, security, contributing | `README.md` | audited against the repo |
| F13 | Design: git worktree isolation per work order | `docs/WORKTREE_MODE_SPEC.md` | design only |
| F14 | Terminals page: every worker, its task, the queue | dashboard, Terminals | `ops/workers-view-check.ts` |

## Also fixed along the way
- Worker guard no longer kills a worker for reading the same file repeatedly.
- Daily worker cap counts credit spend only.
- Wrapper refuses orders containing the loop-word letters; `ops/spawn-wave.ps1` runs a queue with a quota stop at 35%.
- Agent talk step A done: live delivery works only for an idle session (`docs/AGENT_TALK_STEP_A.md`).

## Needs you
1. Claude CLI login has expired on this machine ("OAuth session expired"): real planning falls back to a cheaper model until you log in again.
2. 4 older orders are still waiting for approval and 4 are in "reviewing" in the dashboard. I did NOT approve them: they are stale and approving would start old work. Tell me if you want them approved or cancelled.
3. Offline suite: 39 pass, 5 fail, 1 timeout, 14 skipped (network). The failures are in older checks (budget-override, fleet-fallback-flakiness, fleet-review-gullibility, fleet-signin-shipped, loop-fix, manager-queue), not in tonight's features.
4. Trim the GitHub token to Contents and Pull requests only. Close the 4 test PRs and branches.
5. Docker files were validated by parsing only; the image has not been built on this machine.