# Smoke tests: `ops/smoke-company.ts`

One-command regression harness for the live Laya AI Company control plane
(Express, `src/server.ts`, port 8787). It codes against the frozen contract in
`docs/CEO_DASHBOARD_API.md`; operator procedures live in `docs/CEO_RUNBOOK.md`.

## Run

```bat
npx tsx ops/smoke-company.ts                    :: full run, 12 checks
npx tsx ops/smoke-company.ts --skip-mutating    :: read-only, 11 checks (no POST)
npx tsx ops/smoke-company.ts --json             :: also prints one SMOKE_JSON line
npx tsx ops/smoke-company.ts --strict-dispatch  :: quiesced box: ANY new session in the 10s window fails
```

| flag | meaning |
| --- | --- |
| `--base <url>` | server base URL, default `http://localhost:8787` (or `SMOKE_BASE`) |
| `--root <dir>` | project root holding `company/org.json`; default: cwd, then the script's parent |
| `--timeout <ms>` | per-request timeout, default `15000` |
| `--skip-mutating` | skip check 12 (the only state-changing check) |
| `--strict-dispatch` | check 12 fails on any new session in the 10s window, not just attributable ones |
| `--json` | append `SMOKE_JSON {...}` with every check and its observed detail |

Exit code is `0` when every check passes and `1` when any check fails (or on a
fatal error). Output is one `PASS|FAIL [n] name (free|mutating)` line per check
with the trimmed observed payload underneath, then a SUMMARY table and the list
of failed checks. No secret is ever printed.

The router is expected to already be running; the harness never starts or stops
it (see `ops/start-company.ps1` and `ops/run-server-detached.ps1`).

### Trust boundary / auth

The control plane rejects `/company/*` mutations and the SSE stream without the
shared secret (`X-Company-Token`, `docs/CEO_RUNBOOK.md` §0). The harness resolves
that token from `COMPANY_AUTH_TOKEN`, else from the loopback-only bootstrap
`GET /company/auth/bootstrap`, bounded to 5 s so a silent bootstrap can never
block a run. The third header line reports it (`# auth: control-plane token
resolved` or `# auth: no token (unauthenticated)`); when no token is available
the checks still run and any `401`/`403` shows up explicitly.

## The checks and the invariant each one pins

| # | check | invariant | cost |
| --- | --- | --- | --- |
| 1 | `GET /health -> ok:true` | the server answers and reports `ok:true` | free |
| 2 | `GET /company/panel` shape | every required contract key exists with the right type (`company`, `ceo.name/title`, `generatedAt`, `visual.*`, `departments[]`, `projects[]`, `sessions.items[]`, `budgets.byAgent[]`, `budgets.byDepartment[]`, `agents[]`, `assistant{agentId,status,budget,thread[]}`, `gates[]`). Extra fields are allowed by contract and never asserted against | free |
| 3 | Composite agent keys | every agent (`panel.agents[]`, `projects[].teams[].agents[]`, `/company/agents`) has a **non-null** budget whose `agentId` is the composite `<projectId>::<agentId>` (the CEO assistant alone may also use `"assistant"`), whose `agentKey` matches, and whose values equal the `budgets.byAgent` row of the same id; the project-team key set equals the agent key set minus the assistant; `projects[].budget` equals the sum of that project's own rows; the same agent keeps the same budget row across two consecutive panel reads | free |
| 4 | Money invariants | per row: `remainingUsd === max(0, allocatedUsd - spentUsd)`, `pctUsed === min(100, spent/allocated*100)` and exactly `0` when allocated and spent are both `0`, no negative money, `sessionsRun >= 0`, `status ∈ {idle,running,budget_exhausted}` with `budget_exhausted` iff `remainingUsd <= 0`; `budgets.totalUsd/spentUsd/remainingUsd` equal the sum over `byAgent`; `budgets.byDepartment` sums equal the same totals; `visual.budget*` mirrors them | free |
| 5 | `GET /company/sessions` | `running`/`queued` are global counts, `items` is the newest-first window capped at 60 (`items.length === min(60, total)`), ids unique, statuses in the enum, required fields non-empty, no session exposed as `running` with a start older than 6 h (boot reconciliation), and the same numbers appear in `panel.sessions` and `panel.visual.sessions*` | free |
| 6 | `GET /company/agents` census | `32 team agents + assistant = 33` today, exactly one `assistant` entry, per-project identities unique, required fields present | free |
| 7 | Agent threads | `/company/agents/assistant/thread`, a composite-key thread (`<projectId>::<agentId>`) and a bare-id thread all return `{messages: []}` and echo the id the caller sent | free |
| 8 | `GET /company/stream` | one `event: panel` frame within 6 s, `content-type: text/event-stream`, `data:` parses as the panel JSON | free |
| 9 | Org integrity | every `projects[].rootDir` and agent `workdir` in `company/org.json` exists on disk, department ids/names and project ids are unique, no duplicate agent id inside a project, and the served panel covers every org project + department | free |
| 10 | Router background logs | `logs/router.out.log` non-empty and `logs/router.err.log` present (localhost bases only); prints the `reconciled N stale session(s)` boot line when present | free |
| 11 | Cross-view rollups | `departments[].budget` equals `budgets.byDepartment` for the same department id (two views of the same money in one payload) | free |
| 12 | `POST /company/assistant/message {autoRun:false}` | `200`, `plan >= 1`, `decisions[]`, every `dispatched[]` entry `status:"created"` and visible in its project's `tasks[]`, and **no session for those task ids within 10 s** (nothing was dispatched) | mutating |

### Free vs paid

Checks 1–11 are read-only HTTP GETs plus local file existence checks: they cost
nothing. Only **check 12 mutates state**: it creates one real task, appends the
assistant thread, and charges the assistant's planning call to the assistant
budget (observed `$0.050000` per run, printed as a delta). It dispatches no agent
and starts no pipeline, so no *agent* budget is spent. Use `--skip-mutating` for
a zero-cost pass; the task it creates is harmless but permanent.

## How to read a failure

* The indented line under a `FAIL` is the observed payload, trimmed to the first
  three problems plus a count (`…(N problems)`). Re-run with `--json` for the
  check list, or inspect the specific endpoint by hand.
* `request error: … | cause=ECONNREFUSED` means the router is not answering:
  check `logs/router.out.log` / `logs/router.err.log` and bring it back with
  `ops\run-server-detached.ps1` (or `ops\start-company.ps1`). Server reloads kill
  in-flight requests, so a run executed during a reload reports connection
  errors or missing payloads — re-run before believing it.
* `status=401` / `403` on checks 8 or 12 (and `# auth: no token
  (unauthenticated)`) means the control-plane token could not be resolved.
* Ownership: panel/budget binding and rollups → `src/company/panel.ts` +
  `src/company/budget.ts`; session windowing → `src/company/sessions.ts`; org and
  disk state → `company/org.json` + `src/company/org.ts`; SSE/auth → `src/server.ts`
  and `src/company/authguard.ts`; shapes → whoever owns `docs/CEO_DASHBOARD_API.md`.
  The harness reports, it does not patch other modules.

### Caveats on a shared / live box

* Check 12 attributes new sessions: only sessions whose `taskId` is one of the
  smoke tasks, or that belong to a target project, count as a dispatch failure;
  unrelated traffic is printed as a note. Use `--strict-dispatch` on a quiesced
  router to fail on any new session at all.
* Check 5 retries its cross-endpoint (sessions vs panel) comparison up to three
  back-to-back reads, because another client can slip a session between two
  fetches.
* Checks 4 and 11 fail while any budget row is **over-spent** (`spentUsd >
  allocatedUsd`): the per-row `remainingUsd` is clamped to `0`, so
  `sum(rows.remainingUsd)` exceeds `max(0, Σallocated − Σspent)` by exactly the
  over-spend, which is what `budgets.remainingUsd` reports. The harness prints
  that arithmetic inline, including the offending agent ids. Whether the
  aggregate or the per-row view should change is a budget-owner decision.

## Latest run (2026-09-29 16:53 local, router on :8787)

```
PASS  [1]  GET /health -> ok:true  (free)
PASS  [2]  GET /company/panel shape (required keys; extra fields allowed)  (free)
FAIL  [3]  Composite agent keys: non-null budget + agentKey binding across 3 endpoints  (free)
PASS  [4]  Money invariants (rows, totals, department rollup, pctUsed)  (free)
PASS  [5]  GET /company/sessions counts/order/fields + panel.visual agreement  (free)
PASS  [6]  GET /company/agents census (33 expected today)  (free)
PASS  [7]  Agent threads: assistant + composite key + bare-id resolution  (free)
PASS  [8]  GET /company/stream one `event: panel` frame parses as JSON (6s)  (free)
PASS  [9]  Org integrity (rootDirs, workdirs, unique ids/names, panel covers org)  (free)
PASS  [10] Router background logs present (logs/router.*.log)  (free)
FAIL  [11] Cross-view rollups: departments[].budget == budgets.byDepartment  (free)
PASS  [12] POST /company/assistant/message {autoRun:false}: task created, nothing dispatched  (mutating)
10/12 passed; 2 failed
failed: [3] Composite agent keys | [11] Cross-view rollups
```

Failures 3 and 11 have one root cause (finding 1 below). An earlier run the
same day also failed check 4 while a budget row was over-spent (finding 2).

## Known findings from the live run (2026-09-29)

Both are reported, not fixed, because the modules belong to other workstreams.

1. **Project-summary agent budgets bind to another project (check 3, 51
   problems).** In `GET /company/panel`, `projects[].teams[].agents[].budget`
   resolves by *bare* id to the first registered match, so every project except
   the first (`pmumhg71w`) shows that project's budget rows. Observed:
   `projects.pmumhp51r.teams.tmumhp51r.manager.budget.agentId = "pmumhg71w::manager"`
   while `agentKey = "pmumhp51r::manager"`; 25 bindings, 21 value mismatches and
   4 project rollups (e.g. at 16:36 local `pmumhp51r` reported
   `alloc 13 / spent 0.01` instead of `13.5 / 0.175777`; the live numbers drift as
   budgets move). `panel.agents[]`, `/company/agents` and `budgets.byAgent` are
   correct, while `departments[].budget` (built from the same mis-bound rows)
   disagrees with `budgets.byDepartment` — check 11's failure, observed as
   `spent 0.09` vs `0.255777` for `dmumhp51r`. Note the *first* panel request
   after a server start can be correct, which is why check 3 validates the warmed
   (second) read: the dashboard polls, so the broken payload is what a user
   actually sees. Likely origin: `primeBudget()` in `src/company/panel.ts`
   falling back to `getBudget(bareId)`, which `src/company/budget.ts` resolves to
   the first registered match.
2. **`budgets.remainingUsd` ≠ `sum(rows.remainingUsd)` while a row over-spends
   (check 4).** Observed with `pmumhg71w::summarizer` at `allocated 0 / spent
   0.02 / remaining 0`: `sum(byAgent).remainingUsd = 77.333457` but
   `budgets.remainingUsd = 77.313457` (= `max(0, 80 − 2.686543)`); the same
   `0.02` showed up against `budgets.byDepartment` and
   `visual.budgetRemainingUsd`. Both `budgetTotals()` and the row builder are
   internally consistent; the contract's `remainingUsd never below 0` rule is what
   makes the two views diverge. The check passes again once no row is over-spent.

---

# `ops/smoke-flow.ts` — isolated chain + gate/resume regression

`ops/smoke-company.ts` asserts the live control-plane contract on `:8787`. This
second harness is the end-to-end regression for the **hand-off chain** and the
**gate/resume wiring**, and it is fully self-contained and hermetic, so it can be
run any time without touching the live `company/` or spending anything:

* it creates a throw-away `COMPANY_ROOT` under the OS temp dir and builds the
  project with the real `createProject()` (a default 7-role team), so it can
  never read or write the live `company/`;
* it starts its **own** `node --import tsx src/server.ts` on a free port with
  `MOCK_MODE=1`, `SLACK_BRIDGE=0`, `SLACK_SOCKET_MODE=0` and blank Slack creds,
  so no provider is called and no Slack message can be posted;
* the CEO assistant's planning call is the one model path that `MOCK_MODE` does
  **not** stub (`assistant.ts` → `callGatewayModel`), so the harness serves it
  from a tiny in-process HTTP stub and points the child at it with
  `GATEWAY_BASE_URL` plus `ASSISTANT_MODEL=smoke-stub-planner`;
* it kills the server it started and deletes the temp root on exit (the temp root
  path is printed up front if you want to keep it).

It never talks to `:8787` and never starts anything on the live company/.

## Run

```bat
npx tsx ops/smoke-flow.ts                    :: 7 checks, ~15s, offline
npx tsx ops/smoke-flow.ts --keep             :: keep the temp COMPANY_ROOT
npx tsx ops/smoke-flow.ts --json             :: also print one SMOKE_JSON line
npx tsx ops/smoke-flow.ts --gate-seconds 1   :: shorter gate wait for the child server
```

| flag | meaning |
| --- | --- |
| `--gate-seconds <n>` | `GATE_WAIT_SECONDS` for the child server, default `2` |
| `--timeout <ms>` | per-request timeout and poll budget, default `20000` |
| `--keep` | do not delete the temp `COMPANY_ROOT` on exit |
| `--json` | append `SMOKE_JSON {...}` with every check and its observed detail |

Exit code is `0` when all 7 checks pass, `1` otherwise.

## The checks

| # | check | invariant | tag |
| --- | --- | --- | --- |
| 1 | `GET /health` of the isolated server | the harness's own server answers with `ok:true` and `mock:true`, bound to `127.0.0.1` | free |
| 2 | boot reconcile | the fixture task left in `coding` (no live `runnerPid`) is marked `failed` by `reconcileStaleTasks()` at boot, with the resumable error text `interrupted in "coding" …` | free |
| 3 | (a) full ordered chain | `POST /company/assistant/message {autoRun:true}` dispatches a task that settles `merged`, and `task.trace` carries the CEO-anchored hops in order (see the hop table) | mutating |
| 4 | (b) Flow endpoint | `GET /company/flow` returns that task with a trace byte-identical to `tasks.json` (and `status:"merged"`) | free |
| 5 | (c) parked intake gate | a fresh task + `POST …/run {auto:false}` parks at `pending_intake` (`gates.intake:false`); `POST …/tasks/:tid/approve-intake` returns `resumed:true` and `gates.intake:true` | mutating |
| 6 | (c) it proceeds | the resumed task runs through the code and merge gates to `merged` with the work-phase hops present | mutating |
| 7 | (d) failed task resumes | the task failed in check 2 resumes via `POST /company/projects/:id/run {"taskId":…}` (status leaves `failed`, `error` cleared) and proceeds to `merged` | mutating |

The `resumed:true` requirement is check 5, exactly as the work order asked. For
checks 6-7 the harness approves each gate as the task parks (and tolerates the
gate-poll race described in finding 1 below), so it also proves the task really
*proceeds* rather than merely receiving a flag.

## The exact hop labels (check 3)

The labels come straight from `src/company/pipeline.ts` (`MANAGER =
"Claude (manager)"`) and `src/company/assistant.ts`. The harness asserts this
order (it does not just assert membership):

| from | to | what | written by |
| --- | --- | --- | --- |
| `CEO` | `Assistant` | `order` | assistant.ts, on task creation |
| `Assistant` | `Laya` | `which team?` | assistant.ts |
| `Laya` | `Assistant` | `team: <project name>` | assistant.ts |
| `Assistant` | `Claude (manager)` | `work order` | assistant.ts |
| `<enhancer model> (enhancer)` | `Claude (manager)` | `brief` | pipeline.ts, enhancer stage |
| `Claude (manager)` | `Claude (manager)` | `plan` | pipeline.ts, manager stage |
| `Claude (manager)` | `Laya` | `which model?` | pipeline.ts, per coding subtask |
| `Laya` | `Claude (manager)` | `pick: <modelId>` | pipeline.ts |
| `Claude (manager)` | `<modelId> (coder-N)` | `work order` | pipeline.ts, work phase |
| `<modelId> (coder-N)` | `Claude (manager)` | `result` | pipeline.ts, work phase |
| `Claude (manager)` | `Claude (manager)` | `review: PASS` (or `review: LOOP`) | pipeline.ts, adjudication |
| `Claude (manager)` | `Assistant` | `done` | pipeline.ts, merge |
| `Assistant` | `CEO` | `report` | assistant.ts `reportBack()` |

So the chain is CEO → Assistant → Laya → Assistant → Claude (manager) → worker →
Claude (manager) review → Assistant (done) → CEO (report). Checks 6 and 7 assert a
slightly weaker subset (plan, work order, result, review) because only an
un-gated `auto` run is guaranteed to reach `done`/`report` — see finding 1.

## Findings from the isolated run (2026-09-29)

1. **`done` hop is missing when a *fully parked* merge gate is approved later.**
   `approveGate(…, "merge")` sets `status:"merged"` itself, and
   `resumeTask()` refuses a task that is already `merged`
   (`src/company/pipeline.ts`), so the pipeline never re-enters `stages()` and
   never appends `Claude (manager) -> Assistant [done]`. The harness shows both
   sides of the race: check 6 reports `doneHop=true` (the approval arrived while
   the pipeline was still in its `waitGate()` poll loop, so it picked the flag up
   and wrote the hop), while check 7 reports `doneHop=false` (the pipeline had
   already parked and returned). Effect is cosmetic — status, result and the Flow
   endpoint are correct, the panel just misses the last arrow. Not fixed here:
   `pipeline.ts` / `gates.ts` belong to the Claude Code row in
   `docs/AGENT_COORDINATION.md`.
2. **`MOCK_MODE=1` does not cover the assistant's planning call.**
   `pipeline.ts`/`workers.ts` mock every pipeline role, but
   `assistant.ts` `callAssistantModel()` calls `callGatewayModel()` directly, so
   an assistant run under `MOCK_MODE=1` still performs a real network call (and
   needs a key). That is why this harness ships a stub gateway. A `MOCK_MODE`
   branch in `callAssistantModel` would remove the need for it; `assistant.ts` is
   a shared file, so that change must be announced first.

## Latest run (2026-09-29 18:45 local)

```
# smoke-flow: isolated server on http://127.0.0.1:56324
# temp COMPANY_ROOT: %TEMP%\jcode-smoke-flow-4rDEWC\company
# project: pmumo673g ("Flow Smoke", department "Engineering")
# stub gateway: http://127.0.0.1:56325/v1 | gate wait: 2s | mockMode: 1 | slack bridge: off
PASS [1] isolated server answers GET /health with mock:true (free)
PASS [2] boot reconcile marks the interrupted ("coding") task failed (free)
PASS [3] (a) chain task settles merged with trace CEO -> Assistant -> Laya -> Claude (manager) -> worker -> review -> Assistant -> CEO (mutating)
PASS [4] (b) GET /company/flow returns the task with the identical trace (free)
PASS [5] (c) approve-intake on the parked task returns resumed:true (mutating)
PASS [6] (c) the resumed task proceeds through the code/merge gates to merged (mutating)
PASS [7] (d) the failed task resumes with POST /run {"taskId"} and proceeds to merged (mutating)
SMOKE_FLOW 7/7 passed; 0 failed
```

Observed trace for check 3 (13 hops, real output):

```
CEO -> Assistant [order]
Assistant -> Laya [which team?]
Laya -> Assistant [team: Flow Smoke]
Assistant -> Claude (manager) [work order]
glm-5.3-flash (enhancer) -> Claude (manager) [brief]
Claude (manager) -> Claude (manager) [plan]
Claude (manager) -> Laya [which model?]
Laya -> Claude (manager) [pick: kimi-k2.7-code]
Claude (manager) -> kimi-k2.7-code (coder-1) [work order]
kimi-k2.7-code (coder-1) -> Claude (manager) [result]
Claude (manager) -> Claude (manager) [review: PASS]
Claude (manager) -> Assistant [done]
Assistant -> CEO [report]
```

