# HANDOVER — Local AI Company (to jcode)

> Read this fully first, then execute section 7. Everything below is verified current state.

## 0. MISSION

A **local multi-agent "company"**: departments → projects → teams of specialized AI agents
that constantly communicate, executed by **opencode sessions in separate terminals**,
dispatched by **Laya** (local decision model) with **Claude Code (`claude -p`) as the manager brain**,
**3 human gates**, a **two-way Slack bridge**, and a **single control panel**
(`http://localhost:8787`). No self-hosted LLMs: Claude runs on the Pro subscription CLI,
and GLM/DeepSeek/Kimi/Qwen go through the OpenCode Go gateway.

## 1. LOCATIONS

| Path | What |
|---|---|
| `C:\Users\user\Desktop\Default Project` | THE canonical project root (ignore any Documents copy) |
| `src/` | All TypeScript (router + company layer) |
| `src/company/` | org.ts · roles.ts · dispatch.ts · workers.ts · pipeline.ts · gates.ts · panel.ts · assistant.ts · flow.ts · ceoContext.ts · slackInbound.ts |
| `deps/venv` | Python 3.11 venv, `laya 0.3.21` |
| `deps/setup.ps1`, `deps/start-laya.bat`, `start-laya.bat` | install / start Laya on `127.0.0.1:8000` |
| `.env` | Secrets + config (MOCK_MODE, Laya, Go, Claude, Slack) |
| `company/` | org.json + per-project thread.jsonl + cost.jsonl + task files |
| `public/index.html` | Company control panel (dashboard) |
| `~/.claude/.credentials.json` | Claude subscription OAuth tokens |
| `~/.claude/settings.json` | `model: sonnet` (fixed from fable) |

Python must be invoked explicitly:
`C:\Users\user\Desktop\Default Project\deps\venv\Scripts\python.exe`

## 2. VERIFIED RUNNING NOW

- **Laya server**: UP on `127.0.0.1:8000`, all 3 checkpoints loaded (english, multilingual, typed-decisions), device cpu.
- **opencode CLI**: v1.18.33 installed; **Go credential present** (`opencode auth list` shows OpenCode Go).
- **Claude**: `claude auth status` → loggedIn true, subscriptionType **pro**. Sonnet 5.5 available.
- **Go key** in `.env`; gateway `https://opencode.ai/zen/go/v1`.
- **Chain verified end-to-end** (task tmummg5y2, ~90s): CEO → Assistant → Laya team → Claude plan (`claude -p`) → Laya worker-model pick (kimi) → coder → Claude review PASS → Assistant → CEO. The old coder hang is resolved (see §6).

## 3. ROUTER LAYER (src/ — do not rebuild)

- `config.ts` — env config; `CLAUDE_SONNET=claude-sonnet-5-5`, `CLAUDE_OPUS=claude-opus-5-5`; `MOCK_MODE=0`.
- `decision.ts` — Laya-backed (`/v1/systemone`): `classifyComplexity`, `classifyBrain`, `chooseBestModel` (Laya picks best model from full catalog), `reviewAnswer`.
- `orchestrator.ts` — `decideRoute` (chooseBestModel primary; low conf <0.5 → escalate to Claude brain, never downgrade); `generate` dispatches via gateway / qwen-messages / claude-subscription; Claude failure → fallback `CLAUDE_FALLBACK_MODEL` on the gateway.
- `gateway.ts` — Go calls with **`x-opencode-session` header** (fixed: was 400 MissingSessionID); Qwen via `{base}/messages` keeping `/v1` (fixed: was 404).
- `claudeSubscription.ts` — the Claude brain. `callClaudeSubscription` runs the official `claude -p` CLI headless (Read/Glob/Grep, scoped to `cwd`) on the Pro subscription by default; `CLAUDE_BACKEND=oauth` restores the old raw OAuth path (reads `~/.claude/.credentials.json`).
- `handoff.ts` — context packer + `parseClaudePlan` + labour prompt builder.
- `slack.ts` — persona floor (postAs with username+icon, mock fallback).
- `team.ts` — manager-employee one-thread loop.
- `server.ts` — Express; ALL endpoints (router + company).
- `mock.ts` — zero-spend mocks.

## 4. COMPANY LAYER (src/company/ — built + mock-verified)

- `org.ts` — Company/Department/Project/Team/Agent JSON under `company/`; `createProject`, thread.jsonl, cost.jsonl, readThread, readCost, getProject, ensureProjectDir.
- `roles.ts` — 7 roles: prompt-enhancer (GLM), manager (Claude Sonnet 5.5), coder ×2 (Kimi via opencode), tester (DeepSeek via opencode), opposer (Claude), summarizer (Qwen). `execution: "opencode" | "router"`.
- `dispatch.ts` — Laya decisions: `chooseTeam` (which project owns an order), `chooseAgent` (fallback dispatcher), `chooseWorkerModel` (Claude plans WHAT, Laya picks WHO per coding subtask), `planAssignments`, `agentChoices`.
- `workers.ts` — `spawnOpencodeWorker` (direct exe path, **no shell** — spaces fixed; mock branch), `runRouterRole` (**Claude 429 → fallback DeepSeek via Go** so brain never stalls), `runAgent`, `runParallel`.
- `pipeline.ts` — lifecycle: intake → enhance → Claude plan+dispatch → gate2 → coders (parallel) → tester/opposer → Claude review (PASS/LOOP) → summarize → gate3 → merge. Resumable (each stage skips already-saved output), gate wait parks instead of dropping tasks, `runnerPid` guards against cross-process reaping, a thrown error marks the task `failed`.
- `gates.ts` — TaskRec with `gates:{intake,code,merge}` flags; `createTask`, `approveGate`, `updateTask`, `loadTasks`, `getTask`.
- `panel.ts` — `panelData()` assembles the full CEO dashboard payload (org + sessions + budgets + assistant + gates).
- `sessions.ts` — live session registry: one record per agent run (opencode child or router call) with agent, role, department, project, task, model, status, pid, cost, output tail. Append-only `company/sessions.jsonl`, replayed on boot, plus `reconcileStaleSessions()` so a restart cannot leave ghost "running" rows.
- `budget.ts` — per-agent budgets keyed by `projectId::agentId`, job-based allocation policy (coder $5, manager $3, assistant $3, tester $2.50, opposer $2, enhancer/summarizer $0.50), spend ledger in `company/budgets.json`, `canAfford`/`charge`/`setAllocation`.
- `assistant.ts` — the CEO's assistant (chief of staff): instruction in → plan (`ASSISTANT_MODEL`, default cheapest gateway model, currently `claude-opus-5-5`) → Laya `chooseTeam` → budget check → fire the pipeline without blocking HTTP → `reportBack()` to the CEO thread when it settles. Persists `company/assistant.jsonl`.
- `agentchat.ts` — per-agent threads (`company/agents/<id>/thread.jsonl`), message queue for busy agents, `listAgentsFlat()` roster.
- `batch.ts` — bounded-concurrency batch dispatch across departments (S2).
- `knowledge.ts` — per-project context digest so agents read a summary instead of re-reading files (S3, HANDOVER 7.2).
- `flow.ts` — read-only Flow view: per task, the hand-off chain CEO → Assistant → Laya → Claude (manager) → Laya → worker → Claude → Assistant → CEO, straight from `task.trace`.
- `ceoContext.ts` — live read-only company digest (~2500 chars, 3000 bound) injected into the assistant prompt as LIVE COMPANY CONTEXT.
- `slackInbound.ts` — two-way Slack bridge (Socket Mode primary via `SLACK_APP_TOKEN`, polling fallback; `SLACK_BRIDGE=0` disables). One handler `processMessage()` serves both transports.

### Verified (mock, `MOCK_MODE=1`)
- Full pipeline runs zero-spend: enhancer(GLM)→manager(Sonnet)→Laya dispatch(2 coders Kimi parallel)→summarizer(Qwen)→opposer(Sonnet)→tester(DeepSeek)→merged. 12 thread msgs.
- **3 gates verified end-to-end**: `pending_intake →(approve-intake)→ …→pending_code →(approve-code)→ …→pending_merge →(approve-merge)→ merged`.

### Endpoints (server.ts)
`/company/org` · `POST /company/projects` · `GET /company/projects/:id` · `POST …/tasks` · `POST …/tasks/:tid/approve-intake|approve-code|approve-merge` · `GET …/thread` · `GET …/cost` · `GET …/tasks` · `POST …/pause|resume` · `POST …/run` (taskId or request; auto skips gates) · `GET /company/panel` · plus legacy `/route /chat /handoff/* /team/run /notify/slack /health`.

## 5. CONTROL PANEL (now the CEO dashboard)
`public/index.html` — single-file dark dashboard, vanilla JS, 2s polling of `GET /company/panel` (SSE also available at `GET /company/stream`). Panels: header with live counts + budget, **flow panel** (top: each task's hand-off chain from `GET /company/flow`), **sessions board** (which agent, which department, which role, which task, model, elapsed, cost, per-agent budget bar), **budgets** (per-agent allocated/spent/remaining with bars + inline `Set` control, per-department rollup, total spend meter), **assistant console** (chat with the CEO assistant, shows its plan/decisions/dispatches, autoRun toggle), **agent console** (pick any agent, read its thread, message it, see the reply and its budget), **org view** (departments -> projects -> teams -> agents with status dots), **gates** (awaiting approvals with approve buttons).

### New endpoints (all in `src/server.ts`)
`GET /company/sessions` · `GET /company/sessions/:id` · `GET /company/budgets` · `GET /company/agents` · `GET /company/agents/:agentId` · `GET|POST /company/agents/:agentId/budget` · `GET /company/agents/:agentId/thread` · `POST /company/agents/:agentId/message` (`{text, run?, force?}`, 402 on budget exhaustion) · `POST /company/assistant/message` (`{text, autoRun?}`) · `GET /company/assistant/thread` · `GET /company/stream` (SSE).
Agent keys are `"<projectId>::<agentId>"` (bare ids still resolve); the CEO assistant's key is `"assistant"`.

Operator helpers in `ops/`: `start-company.ps1` / `stop-company.ps1` (launch/stop Laya + router + watcher), `watch-company.ps1` (live mission-control terminal), `tail-sessions.ps1`, `probe-stdin.mjs` / `probe-node.mjs` / `probe-opencode.ps1` (hang diagnostics), `run-department-demo.ts` (S2), `graphify-extract.ts` (S3), `slack-test.ts` (S1).

## 6. ✅ BLOCKER RESOLVED 2026-09-29 — coder hang (root cause found and proven)

> **RESOLVED.** The hang was not the args, the model, the prompt, or `cwd`+`--dir`.
> `opencode run` **blocks forever when stdin is an open pipe nobody writes to**; a
> terminal gives it a TTY, which is why the identical manual command worked. The
> worker now spawns with `stdio: ["ignore","pipe","pipe"]` plus a single guarded
> `settle()` (resolve on `step_finish{reason:"stop"}` with a 5s grace kill, or on
> process close, or on a hard `OPENCODE_TIMEOUT_SECONDS` ceiling).
> Proof: `ops/probe-stdin.mjs` (4 variants, identical command, only stdin differs) —
> stdin=pipe: TIMEOUT, **0 bytes**, both models; stdin=ignore: **exit 0 in 7-10s**,
> 6 JSON events, `step_finish:stop`, real file written, real cost.
> Full write-up: `docs/OPENCODE_STDIN_HANG.md`. Live acceptance: two tasks ran
> enhancer→manager→dispatch→coders→tester→opposer→summarizer→**merged** with real
> files created by the coders.

### Original diagnostic (kept for history)

**Manual `opencode run` works** (10.5s, exit 0, `hello.txt` created via direct exe + `--format json`).
**But the pipeline worker still hangs at `coding`** — dispatch assigns `coder-1`, thread reaches
4 messages, then `opencode run` never returns (waited 6+ min). Manual run and worker run differ in:

1. **Args**: worker passes `["run","--dir",workdir,"--model","opencode-go/kimi-k2.7-code","--auto","--format","json", fullPrompt]` via `spawn(exe, args, {cwd: workdir})`. The manual test used the SAME shape and worked — so test again after a fresh server start; the hang may have been from a stale server process running pre-fix code.
2. **cwd + --dir both set**: worker sets both `cwd: workdir` and `--dir workdir`. Try dropping `cwd` (let `--dir` be the only dir) or vice versa.
3. **fullPrompt is long** (systemPrompt + TASK). The manual test used a short prompt. The model may loop/refuse a multi-part prompt with `--auto`. Test the worker prompt text manually.
4. **stdout buffering / resolve-on-close**: the worker resolves on `close` after accumulating stdout. If opencode keeps the process alive (e.g. waiting on a permission prompt that `--auto` didn't cover, or a background agent), `close` never fires. Consider resolving on the first `{"type":"step_finish","reason":"stop"}` JSON event instead of process close, with a hard timeout fallback.

Diagnostic command (reproduce worker exactly):
```powershell
& 'C:\Users\user\AppData\Roaming\npm\node_modules\opencode-ai\bin\opencode.exe' run --dir "C:\Users\user\Desktop\Default Project\company\final-repo\agents\coder-1" --model opencode-go/kimi-k2.7-code --auto --format json "You are a Coder. Implement the assigned subtask... TASK: create hello.txt with content hello" 
```
If that hangs, it's the prompt/model, not the spawn. If it works, it's the worker's resolve/close logic — switch to event-based resolution.

Still open:
- **META_API_KEY empty** → Muse fallback only via Go (set `CLAUDE_FALLBACK_MODEL` to a Go model, e.g. `glm-5.3-flash`) OR add Meta key.
- Claude **Pro** quota limited — manager/opposer fall back to DeepSeek on 429 (already wired).

## 10. RESOLVED 2026-09-29 — what changed in this session

**Critical path (HANDOVER §7.1) is DONE.**

| Item | Status | Evidence |
|---|---|---|
| Coder hang (§6) | **FIXED** | `ops/probe-stdin.mjs` table; `docs/OPENCODE_STDIN_HANG.md`; live tasks reached `merged` with real coder files |
| Unbounded router call that wedged a task at `coding` | **FIXED** | `src/gateway.ts` `boundedFetch` with `AbortSignal.timeout(JCODE_GATEWAY_TIMEOUT_SECONDS \|\| 180)` on both call sites |
| Summarizer hard-failing (`Qwen 401 Missing API key`) | **FIXED** | `runRouterRole` falls back to the standard gateway model on Qwen error; live session shows `[qwen-fallback: ... -> deepseek-v4-flash]` and status `done` |
| Enhancer/summarizer re-run inside the parallel phase (caused a 40-min stall) | **FIXED** | `pipeline.ts` dispatch branch excludes pipeline-stage roles from the parallel workers |
| Ghost "running" sessions after a restart | **FIXED** | `reconcileStaleSessions()` at boot; log line observed: `[sessions] reconciled 5 stale session(s)` |
| Fake-money framing ($80.50 read like real budget) | **FIXED** | Dashboard relabelled to "spend cap (policy)" + "measured spend"; the cap is a local accounting limit, real limits are provider quotas (see `docs/PROVIDER_USAGE.md`) |
| Composite agent keys undocumented | **FIXED** | `docs/CEO_DASHBOARD_API.md` now declares `"<projectId>::<agentId>"` normative |
| `pctUsed` = 100 with zero allocation | **FIXED** | 0 when allocated and spent are both 0 (verified live) |
| Duplicate/stray departments (`Eng` vs `Engineering`, two `Executive`) | **FIXED** | `ops/fix-org.ts`; live departments are now Executive, Engineering, Quality, Research + the assistant's "Executive Office" |
| CEO-assistant product surface (the new ask) | **SHIPPED** | `assistant.ts`, `agentchat.ts`, `sessions.ts`, `budget.ts` + 11 endpoints + the dashboard at `http://localhost:8787` |
| Regression harness | in progress | `ops/smoke-company.ts` + `docs/SMOKE_TESTS.md` (W4b) |
| Real provider quota panel | in progress | `src/company/usage.ts` + `ops/usage-probe.ts` (S4b) |
| Laya dispatch tuning (§7.4) | in progress | `ops/laya-probe.ts` + `docs/LAYA_TUNING.md` (W5) |
| Graphify / project knowledge (§7.2) | in progress | `src/company/knowledge.ts` + `ops/graphify-extract.ts` (S3) |
| Slack mirror (two-way bridge) | **DONE** | `src/company/slackInbound.ts`: Socket Mode primary (`SLACK_APP_TOKEN`), polling fallback; verified real threaded reply posted end-to-end (see AGENT_COORDINATION.md 17:32). `SLACK_BRIDGE=0` disables |
| Claude as manager brain via real CLI (`claude -p`) | **DONE** | `callClaudeSubscription` runs `claude -p` headless (Read/Glob/Grep); `CLAUDE_BACKEND=oauth` restores the old path; fixes the spoofed-UA 429 |
| CEO→Assistant→Laya→Claude→worker→review chain | **DONE** | `task.trace` records every hop; Flow panel + `GET /company/flow`; live task tmummg5y2 ran the full chain ~90s |
| Resumable tasks + `runnerPid` | **DONE** | `GATE_WAIT_SECONDS` parks at gates, `resumeTask()` resumes; `reconcileStaleTasks()` only reaps tasks whose `runnerPid` is dead |

**Live state at the time of writing:** 4 departments + Executive Office, 5 projects, 33 agents,
43 sessions, ~11 tasks of which 8 reached `merged` across Engineering, Quality, Research and
Executive (real files on disk: `hello-company.mjs`, `dept-report.mjs`, `s2-eng-heartbeat.mjs`,
`s2-eng-throughput.mjs`, `s2-quality-selfcheck.mjs`, `s2-executive-cadence.md`), measured spend
**$1.24** (sum of real per-call `part.cost`), clean `npx tsc --noEmit`.

The router now runs **window-independent** (`ops/run-server-detached.ps1`, hidden process, logs in
`logs/router.*.log`) so no terminal window has to stay open for the dashboard to live.

## 11. NEXT STEPS (remaining)

1. ~~Fix the coder hang~~ **DONE — see §6 and §10** (root cause: open pipe stdin; live tasks reach `merged` with real coder files).
2. Wire **graphify** (phase 2): `graphify extract` each project `rootDir` → shared knowledge graph so all agents query project context instead of re-reading files. **In progress**: `src/company/knowledge.ts` + `ops/graphify-extract.ts` exist; the pipeline prompt injection is the remaining step.
3. Expand company: more departments/projects via the panel; per-project team config (coder count, model overrides).
4. Tune Laya thresholds from live data (dispatch confidence 0.52 seen — verify it picks coder correctly; low-conf escalation to Claude brain).
5. Consider jcode as an alternate coder runtime if opencode hang persists (jcode not installed yet).

## 8. COMMANDS

```powershell
# Start Laya (keep open) — currently running
powershell -File "C:\Users\user\Desktop\Default Project\scripts\serve-laya.ps1"

# Start router (second terminal)
cd C:\Users\user\Desktop\Default Project
npm run dev            # port 8787; open http://localhost:8787

# Typecheck
npx tsc --noEmit

# Fresh install
powershell -File "C:\Users\user\Desktop\Default Project\deps\setup.ps1"

# Laya health
curl http://127.0.0.1:8000/health

# opencode manual coder test (BLOCKER debugging)
opencode run --dir "C:\Users\user\Desktop\Default Project\company\<proj>\repo\agents\coder-1" --model opencode-go/kimi-k2.7-code --auto --format json "create hello.txt with content hello"
```

## 9. RULES
- Never print/commit `.env` secrets. Rotate the Slack token seen in chat.
- Claude: subscription only (`claude -p` CLI, or `CLAUDE_BACKEND=oauth`), no `ANTHROPIC_API_KEY`.
- Laya calls stay short (512-1024 tokens/question).
- Keep Opus minimal on Pro: Sonnet-default, Opus reserved, DeepSeek/gateway fallback on 429.
- Opencode spawn uses the direct exe path (no shell) so paths with spaces work.

## 12. CURRENT ARCHITECTURE (chain, Flow panel, resumable tasks)

**The chain.** Every hop is appended to `task.trace` and rendered by the dashboard Flow panel:

CEO
→ **Assistant** (`src/company/assistant.ts`, `ASSISTANT_MODEL`, currently `claude-opus-5-5`)
→ **Laya picks the team** (`chooseTeam`, gated by `LAYA_TEAM_MIN_CONF`)
→ **Claude manager plans** (`claude -p`, `CLAUDE_BACKEND=cli`, Read/Glob/Grep on the repo; the plan ends with a `DISPATCH:` line)
→ **Laya picks the worker model per subtask** (`chooseWorkerModel`: kimi / deepseek / glm)
→ **worker** (opencode coder, each in its own `agents/coder-N` subfolder)
→ **tester / opposer** (run AFTER the coders)
→ **Claude review** (`VERDICT: PASS` or `VERDICT: LOOP`; LOOP re-runs the coders with fix instructions up to `PIPELINE_MAX_LOOPS`)
→ **Assistant** (`reportBack()` appends Done/Failed to the assistant thread)
→ **CEO** (dashboard + Slack).

**Flow panel.** `public/index.html` polls `GET /company/flow` (read-only, `src/company/flow.ts`); for each recent task it shows the hand-off chain, status, result and error straight from `task.trace`.

**Resumable tasks + `runnerPid`.** Every stage skips work whose output is already saved on the task, so re-running continues where it stopped. `POST /company/projects/:id/run {taskId}` resumes a failed or parked task (and clears a `failed` status first). At a gate the pipeline polls for `GATE_WAIT_SECONDS` (default 600s) then parks instead of dropping the order; approving the gate later resumes it. Each task records the pid of the process running its pipeline; `reconcileStaleTasks()` at boot marks only tasks whose runner process is dead as `failed`, so a second server instance sharing `company/` can never reap a live task.

**Env knobs** (placeholders in `.env.example`): `ASSISTANT_MODEL`, `CLAUDE_BACKEND` (`cli`|`oauth`), `CLAUDE_BIN`, `CLAUDE_CLI_TIMEOUT_SECONDS`, `GATE_WAIT_SECONDS`, `PIPELINE_MAX_LOOPS`, `LAYA_TEAM_MIN_CONF`, `SLACK_APP_TOKEN`, `SLACK_BRIDGE`.