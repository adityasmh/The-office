# VERIFICATION REPORT — CEO Dashboard API contract

Verifier: **W6 (independent verifier, read-only w.r.t. other workstreams' files).**
Contract under test: `docs/CEO_DASHBOARD_API.md` (frozen).
Report scope: **PASS 1 (static audit + typecheck) AND PASS 2 (live HTTP verification, executed).**
Both passes are complete; §7 is the measured live behaviour on `http://localhost:8787`.

Rules I obeyed: I only created/edited this file. I did **not** modify `src/**`, `public/**`, `company/**`, `ops/**`, `scripts/**`. I did **not** start the server in PASS 1 (starting it writes `company/budgets.json` + `company/sessions.jsonl`, which belong to other workstreams, and it would have invalidated the cold-start test that PASS 2 needs). No `.env` value is printed, read into this report, or inferred here.

---

## 0. Revision anchors (read this first)

Other workstreams were writing while I audited. `src/company/agentchat.ts`, `src/company/assistant.ts`, `src/company/panel.ts`, `src/company/budget.ts`, `src/company/workers.ts` and `public/index.html` all changed **during** this audit (some of my early findings were fixed by their authors while I was reading; those are listed in §5 so nobody re-reports them).

**Every finding below is tied to the revision below.** MD5 taken at 2026-09-29T09:53:50Z (**revision 2**).

I captured **two snapshots** because the tree moved under me. Revision 1 (09:51:42Z) had one compile error; revision 2 (09:53:50Z) compiles clean. Where a finding changed between the two snapshots I say so explicitly. Revision 1 hashes, for traceability: `agentchat.ts` `053a9ebbc4d5b489d8e01d7e8b7e3f17`, `dispatch.ts` `1097914f6c817b20e9ea244a01240004`, `workers.ts` `bd84517ea6b971fe170581611e6c8ab9`.

| File | MD5 (revision 2) | Notes |
|---|---|---|
| `src/company/sessions.ts` | `bf1f9fbee0235890a0521988e88cb855` | unchanged across both snapshots; matches contract types exactly |
| `src/company/budget.ts` | `4a8871430a007f1248a306d76005d8a7` | changed twice during audit |
| `src/company/agentchat.ts` | `67bd569ee48f96746c489d52231956ac` | fully rewritten twice during audit |
| `src/company/assistant.ts` | `b5116d3295c349f293a5fb6df631b6a8` | created during audit |
| `src/company/panel.ts` | `131f7b32f02a002b2da4c221d0cdd769` | unchanged across both snapshots |
| `src/company/workers.ts` | `31d5ff51bafb7d4152fc7ad628077c50` | changed during audit between snapshots |
| `src/company/pipeline.ts` | (unchanged during audit) | |
| `src/server.ts` | `ba7e76ea30dda85be7c6be68a3252747` | unchanged across both snapshots |
| `public/index.html` | `83b566527498c97edd8d7a14dc4f0702` | replaced wholesale during audit (193 → 1589 lines) |
| `company/org.json` | `d4e2df9f305d0d65e19263dea69abb4b` | 5 departments, 5 projects, 32 agent instances |
| `src/company/dispatch.ts` | `38cd97b2de3f31d1d974ab697d962228` | **fixed during audit; typecheck now clean** |

Command used:
```
certutil -hashfile src\company\panel.ts MD5
```

Agent-instance census of `company/org.json` used for the money math below: 5 projects → `pmumhg71w` (2 coders), `pmumhp51r`, `pmumhp51u` (2 coders), `pmumhp51x`, `pmumhp520` = **32 agent instances**, 7 distinct bare ids (`manager, enhancer, summarizer, opposer, tester, coder-1, coder-2`).

---

## 1. Typecheck — **PASS at revision 2** (was **FAIL** at revision 1)

Exact command:
```
cd /d "C:\Users\user\Desktop\Default Project" && npx tsc --noEmit
```

Observed output at **revision 1** (09:51Z, exit code 2) — verbatim:
```
src/company/dispatch.ts(52,34): error TS2366: Function lacks ending return statement and return type does not include 'undefined'.
```

Observed output at **revision 2** (09:53:50Z):
```
(no output; exit code 0)
```

**Verdict: PASS at revision 2.** Contract §Rules line 119 (*"Typecheck must pass"*) is now satisfied.

### F-01 — **FIXED during the audit** (was BREAKS-RUNTIME) — `dispatch.ts` non-exhaustive switch
- At revision 1, `src/company/dispatch.ts:52` `function roleHint(role: RoleId): string` had cases for `prompt-enhancer, manager, coder, tester, opposer, summarizer` and no `assistant` case / no default, while `src/company/org.ts:10-17` includes `"assistant"` in `RoleId` ⇒ TS2366, and `npm run build` (`tsc -p tsconfig.json`) failed. `npm run dev` (tsx) masked it.
- Revision 2 (`dispatch.ts` `38cd97b2…`) adds at `:60`: `case "assistant": return "chief of staff: decompose the CEO's instruction and dispatch the work";` ⇒ switch is exhaustive and `tsc --noEmit` is silent.
- Kept here for traceability: this was the only contract-blocking compile error in the tree, and it is now closed. If it reappears, treat as BREAKS-RUNTIME.

Note: an earlier run in this same session also reported `panel.ts(183,43) TS2339: Property 'agentKey' does not exist on type 'AgentView'` and `TS2307` for the then-missing `./assistant.js`. Both were resolved by their authors mid-audit (§5). Revision 2 has zero errors.

---

## 2. Shared types — **PASS**

**F-02 PASS — `SessionRec` is field-exact.** `sessions.ts:19-41` defines `SessionStatus` and `SessionRec` with exactly the contract's 15 fields and the same optionality (`finishedAt?`, `durationMs?`, `pid?`, `lastText?`, `costUsd?`, `runtime?`, `taskId: string | null`). No extra required fields, no renames.

**F-03 PASS — `AgentBudget` is field-exact.** `budget.ts` (type block, lines 23-39 at audit start / 23-39 now) matches all 16 contract fields including the literal unions `tier: "cheap" | "mid" | "frontier"` and `status: "idle" | "running" | "budget_exhausted"`.

**F-04 DEVIATES-FROM-CONTRACT — `AgentBudget.agentId` carries a composite key, not an agent id.**
- Contract line 38-39 / 69-71: `AgentBudget.agentId: string` sits beside `name/role/...` and the panel nests it as `agents[].budget`, i.e. it reads as the agent's id (`"coder-1"`, `"manager"`, `"assistant"` — the same values `SessionRec.agentId` uses and the same values `GET /company/agents/:agentId` accepts).
- Code: `budget.ts:309` returns `agentId: key` where `key` is `` `${projectId}::${agentId}` `` (`budget.ts` `budgetKeyFor`). So `GET /company/budgets → byAgent[].agentId` is `"pmumhp51u::coder-1"`, and `panel.budgets.byAgent`, `session → agent budget` joins, and every `budget.agentId` are composite.
- This is **deliberate and documented** (`budget.ts` header comment lines 15-16; `agentchat.ts:229-230`), because bare ids repeat across 5 projects. But it contradicts the contract as written, and any consumer matching `budget.agentId === session.agentId` gets a miss.
- Consequence already visible: `public/index.html` had to build a two-key index (`index.html:618-631`) to paper over it.
- PASS 2 will measure exactly where this leaks: `byAgent[].agentId` vs `agents[].agentId` vs `agents[].budget.agentId` on the same payload.

**F-05 DEVIATES-FROM-CONTRACT (minor) — `pctUsed` is `100` when `allocatedUsd === 0`.**
- `budget.ts:305`: `const pctUsed = allocatedUsd > 0 ? round6(Math.min(100, (spentUsd / allocatedUsd) * 100)) : 100;`
- With `POST /company/agents/:agentId/budget {"allocatedUsd":0}` the response is `{allocatedUsd:0, spentUsd:0, remainingUsd:0, pctUsed:100, status:"budget_exhausted"}`. `remainingUsd == max(0, allocated-spent)` holds (contract line 44 ✓), but `pctUsed` reports 100% used with zero spend.
- My PASS 2 formula check will special-case `allocatedUsd === 0` and report `pctUsed` as informational, otherwise it would emit a false FAIL.

---

## 3. Endpoint-by-endpoint audit (`src/server.ts` @ `ba7e76ea…`)

All 11 contract endpoints exist with the contract's method and path. Line numbers below are `src/server.ts` at this revision.

| # | Contract path | Declared at | Handler | Static verdict |
|---|---|---|---|---|
| 1 | `GET /company/panel` | `:217` | `panelData()` | **PASS (shape)** — see §4 for reconciliation caveats |
| 2 | `GET /company/sessions` | `:228` | `{...sessionCounts(), items: listSessions(60)}` | **PASS** — `{running,queued,total,items}` exact |
| 3 | `GET /company/budgets` | `:243` | `{...budgetTotals(), byAgent: listBudgets(), byDepartment: budgetByDepartment()}` | **PASS** — key names exact |
| 4 | `POST /company/agents/:agentId/budget` | `:273` | `setAllocation()`; 400 on non-numeric/<0; 404 unknown | **PASS** |
| 5 | `GET /company/agents` | `:252` | `listAgentsFlat()` (bare array) | **PASS**, array shape matches "the `agents` array above"; extra `agentKey` field is additive |
| 6 | `GET /company/agents/:agentId/thread` | `:285` | `{agentId, messages: agentThread(...)}` | **PASS** — `from:"ceo"|"agent"` coerced in `agentchat.ts:407-412` |
| 7 | `POST /company/agents/:agentId/message` | `:294` | `messageAgent(id, text, {run, force})`; 400 empty text; 402 `budget_exhausted`; 404 `unknown agent` | **PASS on status codes**, `force` is honoured end-to-end (`server.ts:295` → `agentchat.ts:601`) — see F-06/F-07 |
| 8 | `POST /company/assistant/message` | `:308` | `assistantMessage(text, {autoRun})` | **PASS** — see F-08 |
| 9 | `GET /company/assistant/thread` | `:318` | `{status, messages}` | **PASS with additive key** — contract documents `{messages}`; `status` is extra (harmless) |
| 10 | `GET /company/stream` | `:329` | SSE | **PASS (static)** — `event: panel`, `data:` = `JSON.stringify(panelData())`, immediate `send()` then `setInterval(send, 2000)`, `req.on("close")` clears the interval and ends the response, `send()` is try/caught |
| 11 | Existing routes | `:28,:31,:42,:60,:81,:95,:106,:118,:123,:135,:142,:151,:157,:163,:168,:172,:176,:180,:191,:204` | all present | **PASS** |

Extra (non-contract) routes, additive, do not conflict: `GET /company/org` `:118`, `GET /company/sessions/:id` `:236`, `GET /company/agents/:agentId` `:260`, `GET /company/agents/:agentId/budget` `:266`.

**Route-ordering check (adversarial, PASS):** `GET /company/agents/:agentId` (`:260`) is registered *before* `:266/:285/:294`, but Express 4 does not let a `:param` match across `/`, so the more specific routes still win. No shadowing.

**F-06 DEVIATES-FROM-CONTRACT — `POST /company/agents/:agentId/message` echoes a *different* `agentId` than it was called with.**
- Contract 7: response `{agentId, status: ...}`.
- Code: the path param is passed to `messageAgent` (`server.ts:298`), which resolves it and returns `agentId: key` = the canonical composite (`agentchat.ts:602`, `:614`, `:542`). Calling `POST /company/agents/coder-1/message` returns `{"agentId":"pmumhg71w::coder-1", ...}`.
- Impact: a client that keys its own state off the id it sent cannot match the reply. `public/index.html:1179-1191` survives only because it ignores `r.agentId` and re-derives state from the bare id it sent (and uses `r.budget.agentId` for the budget index).
- PASS 2 will show the literal request/response pair.

**F-07 DEVIATES-FROM-CONTRACT — a failed agent run returns HTTP 200 with `status:"queued"`.**
- Contract 7 restricts `status` to `"replied" | "queued"`, and the error rule says errors are `{error: string}` with 4xx/5xx.
- Code: on `ev.status === "error"` `agentchat.ts:514-520` returns `{status:"queued", error:"run failed: …"}`. `server.ts:299-301` only maps `"unknown agent"` → 404 and `"budget_exhausted"` → 402, so a genuine run failure is **HTTP 200 + status queued**.
- Concrete consequence in the UI: `index.html:1179-1184` treats `status === "queued"` as success and renders *"queued — the agent is busy, your message waits for the current session to finish"*, which is the wrong explanation for a crashed run (the `error` string is dropped).
- PASS 2 will provoke this cheaply (message a router-role agent with MOCK/bad model is not needed — I will note it as a code-path finding and, if a real failure occurs, capture it).

**F-08 PASS (static) — assistant dispatch is genuinely fire-and-forget.**
- `assistant.ts:489-499`: `inFlight++`, `void runPipeline(target.project.id, item.request, {taskId, auto:true}).catch(...).finally(() => inFlight--)`, then `dispatched.push({..., status:"running"})` and return. No `await` on the pipeline ⇒ the HTTP response is not blocked, matching contract line 97-98. `assistantStatus()` (`assistant.ts:70-72`) is driven by that same counter, so `"idle" | "thinking"` is real, not a stub.
- Budget-check-before-dispatch (contract line 99) is implemented at `assistant.ts:454-476` with explicit `decisions` strings for "cannot afford" / "tight budget" / "no agents".
- Note (COSMETIC): `assistantStatus()` reports `idle` during the *planning* model call (before dispatch), so the panel can show `idle` while a POST is still in flight.

---

## 4. `GET /company/panel` payload audit (`panel.ts` @ `131f7b32…`)

Top-level keys versus contract lines 54-76: `company` ✓, `ceo{name,title}` ✓ (`title` hard-coded to `"Chief Executive Officer"` ✓), `generatedAt` ✓, `visual` ✓ (all 11 counters present), `departments` ✓, `projects` ✓, `sessions{running,queued,total,items}` ✓ (`items` = `listSessions(60)`, newest-first, max 60 ✓ contract line 66), `budgets{totalUsd,spentUsd,remainingUsd,byAgent,byDepartment}` ✓, `agents` ✓, `assistant{agentId,name,status,budget,thread}` ✓, `gates` ✓ (`awaiting: intake|code|merge|null` ✓ `panel.ts:92`).

`projectSummary`: `{id,name,description,departmentId,status,rootDir,teams,thread,tasks,cost,running}` all present; `thread`/`tasks`/`cost` keys preserved per contract line 78 (`thread: readThread(p.id,60)`, `tasks: loadTasks(...).slice(-20)`, `cost: readCost(p.id)`) ✓. Additive extras: `departmentName`, `budget`, and on each team agent `agentKey`/`running`/`budget` — additive only, contract's required keys intact ✓.

**F-09 DEVIATES-FROM-CONTRACT — `visual.agents` does not count the same population as `agents[]`.**
- `panel.ts:194` `agents: rows.length` where `rows` = `agentRows(org)` = **32** org agent instances (assistant excluded, since the assistant is not in `org.json`).
- `panel.ts:181` `agents = listAgentsFlat()` = **33** (assistant first, then 32 instances — `agentchat.ts:369-373`).
- So the header chip "agents" (`index.html:695` prefers `v.agents`, `:728`) reads **32** while the Agent console lists **33**. Contract example `visual.agents: 26` and the sentence "all agents across all projects, plus `assistant`" (line 83) imply one consistent population.
- PASS 2 will print both numbers.

**F-10 BREAKS-RUNTIME (cold start; latent, deterministic order-of-operations bug) — on the first `/company/panel` after a cold start, `budgets.byAgent` is empty while `budgets.byDepartment` and `totalUsd` are populated.**
- `panel.ts:109` `const budgets = listBudgets();` runs **before** any budget row exists.
- `panel.ts:117` `agentRows(org)` calls `primeBudget` → `ensureAgentBudget` (`panel.ts:32`) which **creates** the 32 rows and persists `company/budgets.json` as a side effect.
- `panel.ts:180` `budgetTotals()` and `panel.ts:206` `budgetByDepartment()` are evaluated **after** that priming; `panel.ts:181` `listAgentsFlat()` then creates the 33rd row (the assistant) **after** `budgetTotals()` already ran.
- Predicted cold-start payload: `budgets.byAgent = []`, `budgets.totalUsd = 77.50` (32 instance rows), `budgets.byDepartment` summing to `77.50` in 5 groups, `visual.budgetTotalUsd = 77.50`; the second request onward: `byAgent` = 33 rows / `totalUsd = 80.50`.
- `company/budgets.json` does **not exist** right now (`if exist company\budgets.json` → `NO`), so PASS 2 can reproduce this exactly by taking the very first `/company/panel` of a fresh server.
- Silver lining: the UI's defensive fallback (`index.html:637-645` `budgetList()` falls back to `P.agents[].budget` when `byAgent` is empty) hides the empty-array symptom but **not** the contradiction, because the meter at `index.html:869` prefers `b.totalUsd` (77.50) while the per-department rollup at `:885-895` sums to a different number (§F-11).

**F-11 DEVIATES-FROM-CONTRACT — the CEO office is invisible to `departments[]`, so panel money totals do not reconcile.**
- `budgetTotals()` (`budget.ts:432-436`) sums **all** rows in `budgets.json`, including the assistant's row `p-ceo::assistant`.
- `departments[]` is built from `org.departments` (`panel.ts:164`) and hardened with `departmentId === "d-ceo"` nowhere; the assistant's `agentKey` is exactly `"assistant"` and its budget row is keyed `p-ceo::assistant` (`agentchat.ts:81, 344-363`, `assistant.ts:305-315`).
- Therefore `Σ departments[].budget.allocatedUsd` (5 real departments, 32 instances = **77.50** with default policy) ≠ `budgets.totalUsd` / `visual.budgetTotalUsd` (**80.50** once the assistant's default `$3.00` row exists; `DEFAULT_ALLOCATION_USD.assistant = 3`).
- `budgets.byDepartment` **does** include a sixth group `d-ceo` ("Executive"), so the panel simultaneously has a 5-group `departments[]` rollup and a 6-group `byDepartment` rollup with different totals, plus a name collision: the org already has a real department named **"Executive"** (`dmumhp51r`, `org.json:12-17`) and `agentchat.ts:357-358` labels the assistant's `d-ceo` **"Executive"** too. Two rows named "Executive" in one UI panel.
- Contract requirement being checked in PASS 2 ("the panel totals equal the sum over the agents") will therefore produce: `Σ agents[].budget` == `budgets.totalUsd` ✓ (both 33 rows), but `Σ departments[]` == `totalUsd − 3.00` ✗ and two "Executive" department rows.
- `panel.ts:113` `budgetIndex.set(budgetKey(b.projectId, b.agentId), b)` is also **dead code**: `b.agentId` is already composite, so the key built is `p::p::a` and can never be looked up.

**F-12 DEVIATES-FROM-CONTRACT (data source split) — the assistant's thread lives in two places.**
- Contract 1 nests the assistant thread in the panel (`assistant.thread` from `company/assistant.jsonl`, contract line 100) and endpoint 9 exposes `{messages}`.
- `panel.ts:215` `assistantThread(60)` reads `company/assistant.jsonl` ✓; `panel.ts:209` also surfaces the assistant's `agents[]` row, whose `threadDepth` comes from `company/agents/assistant/thread.jsonl` (`agentchat.ts:344-363`) — a **different file**. A CEO who messages the assistant directly via `/company/agents/assistant/message` writes the second file, so `assistant.thread` (the console) will not show it.
- Not a crash; a real "two sources of truth" trap. Contract only mandates the first one, so this is a *deviation of surface behaviour*, not of a required field.

---

## 5. Fixed by peer workstreams **during** this audit (do not re-report; verify instead)

These were real defects in the revisions I read at ~09:46-09:48Z and were corrected by their owners before I finished reading. I record them because they were genuine and because PASS 2 should confirm the fixes hold, not assume it.

1. `sessions.ts` / `workers.ts` `pid`: was never populated for opencode sessions (contract line 32 documents it). Now set in `workers.ts:269-275` via `updateSession(session.id, {pid: child.pid})`. **Confirm in PASS 2 with a real opencode run (or mark UNVERIFIED if no opencode session occurs).**
2. `agentchat.ts` `finishOpts` used to return `{costUsd, lastText}` while `finishSession` only reads `opts.text` ⇒ the reply text was silently never written to the session record for router-role runs (no streamed chunks for `router` runtime). Now `agentchat.ts:432-434` returns `{costUsd, text}` → `finishSession` populates `lastText` ✓.
3. `budget.ts` `listBudgets()` used to report `sessionsRun` from the in-process counter while `getBudget()` reported `max(counter, observed-in-sessions.jsonl)` ⇒ `/company/budgets.byAgent[].sessionsRun` (0 after restart) disagreed with `/company/agents/:id/budget.sessionsRun` (non-zero). Now both use `sessionsRunFor(key)`.
4. `agentchat.ts` used to `charge(bareAgentId, …)` (resolved via a first-wins alias ⇒ could charge a *different project's* row) and returned a stale `view.budget` snapshot captured before the charge. Now it derives `budgetKey = view.budget.agentId` (`:462`) and returns `getBudget(budgetKey) ?? view.budget` (`:542`) ⇒ charged to the right row, and the response budget reflects the charge. **This is the behaviour PASS 2 must confirm** (F-05 in an earlier draft of my notes is now closed).
5. `agentchat.ts` used to dedupe the roster by bare `agentId` across projects (9 rows) and share one thread dir per bare id. Now one row per project instance with `agentKey`, and thread dirs are `company/agents/<label>/…` where the label is `safeId(key)` = `pmumhp51u__coder-1` (`:104-114`) ⇒ no cross-project thread clobbering.
6. `public/index.html` was, at the start of my audit, the **old** project UI: it fetched `/company/org` + `/company/projects/:id/{tasks,thread,cost}` and contained **zero** references to `/company/panel`, `/company/sessions`, `/company/budgets`, `/company/agents`, `/company/assistant`, and no sessions board / budgets / assistant console / agent console / status dots, and refreshed every 4000 ms. It has been replaced (see §6).

If any of these regresses, treat it as BREAKS-RUNTIME.

---

## 6. UI audit — `public/index.html` @ `83b566527498c97edd8d7a14dc4f0702` (1589 lines)

Requirement-by-requirement (contract lines 105-114):

| Requirement | Verdict | Evidence |
|---|---|---|
| Single file, inline CSS+JS, no CDN | **PASS** | one `<style>` (`:7-264`), one inline `<script>` (`:378-1586`) |
| No external requests | **PASS** | `findstr /i /c:"http" /c:"cdn" /c:"@import" /c:"url(" /c:"src=" /c:"integrity" public\index.html` returns only string literals `"HTTP 404 …"`, `"HTTP " + r.status` and the CSS token `kind:"http"` — no URL, no `src=`, no `@import`, no CDN |
| Header: company, `CEO · <name>`, live counts, pause+refresh | **PASS** | `:274-275` name + `CEO ·`; chips at `:724-731` (running/queued/total/agents/tasks/budget left); pause toggle `:281-283`, refresh `:284` |
| Sessions board: dept, role, agent, task, model, status, elapsed, cost, budget bar; running highlighted; 2 s refresh | **PASS** | 9 columns `:814-818` ↔ 9 row cells `:767-783`; `.srow.isrunning` `:149`; `setInterval(… , 2000)` `:1577` |
| Budgets: per-agent alloc/spent/remaining + bars, sorted by remaining, per-department rollup, total meter | **PASS** | `:903` sort by `remainingUsd`; meter `:877-883`; rollup `:885-898`; per-agent rows `:842-863` |
| Assistant console: chat via POST, shows plan + dispatched | **PASS** | `:1014` POST `/company/assistant/message`; plan `:933-938`; dispatched `:939-946` |
| Agent console: pick agent, read thread, send, see reply, budget + running state | **PASS with a defect (F-13)** | `:1177` POST message, `:1470` GET thread, `:1092-1096` budget, `:1086-1090` running |
| Org view: departments → projects → teams → agents with status dots (green idle / amber running / red exhausted) | **PASS** | `:1341-1389`; `agentDot()` `:498-507` = `d-ok` green idle, `d-warn` amber running, `d-err` red exhausted — matches the contract's colour semantics |
| Gates: awaiting approvals with approve buttons (existing endpoints) | **PASS** | `:1232` `GATE_PATH = {intake:"approve-intake", code:"approve-code", merge:"approve-merge"}`; buttons `:1255-1259`. (The *old* UI had no intake button at all; that gap is now closed.) |
| Dark theme, vanilla JS, fetch polling | **PASS** | `:8-12` palette; `:379` IIFE, no framework import; `fetch` `:589` |

**F-13 DEVIATES-FROM-CONTRACT / wrong-agent addressing (highest-value UI finding) — the Agent console can only ever talk to the *first* instance of a duplicated agent id.**
- The panel's `agents[]` now contains **33 rows**, five of which share the bare id `manager` (one per project), etc.
- The UI selects and addresses agents by the **bare** id: list item attr `data-agent="<bare>"` (`:1137`, and same in the org view `:1378`), `S.selectedAgent = bare` (`:1117`), then `POST /company/agents/<bare>/message` (`:1177`), `GET /company/agents/<bare>/thread` (`:1470`), `POST /company/agents/<bare>/budget` (`:1215`).
- Server side, a bare id is resolved to the **first org-order match**: `agentchat.ts:384-386` (`located.find(l => l.agentId === bare)`) for message/thread, and `budget.ts` `resolveKey` first-wins alias for budget.
- Net effect: click **"Manager · Research"**, send a message → the message, the thread you read, and the budget you set all belong to **Engineering's** manager (`pmumhg71w::manager`, first in `org.json`). The correct key is already in the payload (`AgentView.agentKey`, passed through by `panel.ts:183` and `index.html`'s own `agentList()`), and the UI never uses it.
- PASS 2 will demonstrate it: `POST /company/agents/manager/message` returns `agentId: "pmumhg71w::manager"` while `GET /company/agents` lists five agents whose `agentId` is `"manager"` with different `agentKey`s.

**F-14 COSMETIC — `.brow` grid declares 12 columns, rows supply 11 cells.** `index.html:176` `grid-template-columns:172px 84px 118px 66px 84px 84px 88px minmax(130px,1fr) 122px 54px 106px 150px` (12 tracks) versus the header's 11 `<span>`s (`:905-907`) and `budgetRow`'s 11 cells (`:848-861`) → a permanently empty 150 px column on the right, and the status/budget-input columns get the wrong widths.
Contrast `:141` `.sgrid` (9 tracks ↔ 9 cells ✓) and `:241` `.tbrow` (4 ↔ 4 ✓).

**F-15 COSMETIC — dead read of a non-contract field.** `index.html:764` `(x.sessionHint ? "" : "")` reads `sessionHint`, which exists nowhere in `SessionRec` (contract lines 16-36) nor in `sessions.ts`. The whole expression is a no-op.

**F-16 COSMETIC — a typed allocation is destroyed by the next repaint.** Drafts are only captured for `TEXTAREA` (`:1544`), but the budget input is `type="number"` with `id="bud-<agentId>"` (`:859`) and is regenerated from `x.allocatedUsd` on every repaint (`:555` skips only checkboxes). Typing `4.5` and then receiving a poll that changes any budget repaints the row via `paint()` and reverts the field to the stored allocation.

**F-17 COSMETIC — two sticky elements fight for `top:0`.** `.banner` `:33` (`z-index:60`) and `.hdr` `:45` (`z-index:50`) are both `position:sticky;top:0`, so the red "server unreachable" banner paints over the header instead of pushing it down.

**F-18 COSMETIC — the sessions header can never stick.** `.shead` `:145` is `position:sticky;top:0` but its scroll container `.sess` (`:138`) only scrolls horizontally; the page scrolls on `<body>`, so the header scrolls away.

**F-19 COSMETIC (informational) — `window.__dash` is exposed** (`:1581-1585`), including `S`, `render`, `pollNow`. Harmless, deliberate test hook; noting it only because it is a public global, not part of the contract.

---

## 7. PASS 2 — LIVE HTTP verification (RUN, 2026-09-29T09:54:40Z → 09:59:40Z)

Target: the freshly restarted `npm run dev` on `http://localhost:8787` (started by mizaru). I started nothing and restarted nothing. All probes are read-only clients except the two POSTs that the brief explicitly sanctioned (one agent message, one assistant message with `autoRun:false`, which creates a task but starts no work).

Probe scripts live in `%TEMP%` (`w6_pass2_read.js`, `w6_pass2_write.js`, `w6_pass2_alias.js`, `w6_pass2_rest.js`, `w6_pass2_attrib.js`) — **nothing was written into the project** except this report. (Inline `node -e` was abandoned early because `cmd.exe` mangled `===` inside the argument; the file-based probes avoid that entirely.)

Server-side code under test at run time: the revisions in §0 (revision 2). `npx tsc --noEmit` was clean before and after.

### 7.1 Health — **PASS**
```
curl -s -m 10 -w "\nHTTP %{http_code}\n" http://localhost:8787/health
{"ok":true,"claude":"subscription-only, no api key","credsPresent":true,"mock":false}
HTTP 200
```
`mock:false` ⇒ real model calls, so the router-role message test below was a real end-to-end agent run.

### 7.2 `GET /company/panel` — **PASS on shape, FAIL on two money invariants**
Command:
```
node %TEMP%\w6_pass2_read.js   (fetches /company/panel, /company/budgets, /company/agents, /company/sessions, /company/assistant/thread)
```
Observed (trimmed):
```
top-level keys=company,ceo,generatedAt,visual,departments,projects,sessions,budgets,agents,assistant,gates
ceo={"name":"Aditya Shukla","title":"Chief Executive Officer"} company=Laya AI Company
visual={"departments":5,"projects":5,"teams":5,"agents":32,"tasks":2,"sessionsRunning":1,"sessionsQueued":0,"sessionsTotal":8,"budgetTotalUsd":80.5,"budgetSpentUsd":0.19064,"budgetRemainingUsd":80.30936}
sessions keys=running,queued,total,items items=8   newest-first? true
assistant keys=agentId,name,status,budget,thread   status=thinking   thread=2   item shape ok=true
projectSummary keys=id,name,description,departmentId,departmentName,status,rootDir,running,budget,teams,thread,tasks,cost
projectSummary has thread/tasks/cost=true
team agent keys=id,agentKey,role,name,modelId,workdir,running,budget
departments keys=id,name,projectIds,agents,running,budget,projects
```
- All 11 top-level keys present; `projectSummary` keeps `thread`/`tasks`/`cost` (contract line 78) **PASS**; `gates[]` present with the contract's 6 fields and `awaiting:"intake"` for the task I created later in §7.8 **PASS**; `sessions.items` newest-first, 8 ≤ 60 **PASS**.
- **FAIL (contract line 77 + the brief's money check)** — the panel's own money totals disagree with each other and with `/company/budgets`. Single `GET /company/panel`:
```
SUM departments[].budget      = {"allocatedUsd":77.5, "spentUsd":0, "remainingUsd":77.5}
SUM byDepartment              = {"allocatedUsd":80.5, "spentUsd":0.19064, "remainingUsd":80.30936}
SUM byAgent                   = {"allocatedUsd":80.5, "spentUsd":0.19064, "remainingUsd":80.30936}
budgets totals                = {"totalUsd":80.5, "spentUsd":0.19064, "remainingUsd":80.30936}
visual.budgetTotalUsd=80.5  visual.budgetSpentUsd=0.19064
byDepartment groups           = [dmumhg71w/Eng 18.5, dmumhp51r/Executive 13.5, dmumhp51u/Engineering 18.5, dmumhp51x/Quality 13.5, dmumhp520/Research 13.5, d-ceo/Executive 3]
departments[]                 = 5 rows, "Executive" present once
visual.agents=32 vs agents.length=33
```
  - **F-11 CONFIRMED LIVE:** `departments[]` is short by exactly **3.00** (= the assistant's default allocation, `DEFAULT_ALLOCATION_USD.assistant`), because the assistant's row `p-ceo::assistant` belongs to `d-ceo`, which is not in `org.departments`. And **"Executive" appears twice** in `byDepartment` (`dmumhp51r` and `d-ceo`).
  - **F-09 CONFIRMED LIVE:** `visual.agents` (32) ≠ `agents[]` (33).

### 7.3 Your finding #1 — `budgets.byAgent` empty while `visual.budgetTotalUsd` = 77.5 — **CONFIRMED BY MECHANISM + ARITHMETIC; not reproduced live (deliberately)**

**Current server state does not show it:** `byAgent.length=33`, and 33 rows reconcile exactly with `totalUsd`. So the symptom you saw is a **one-request-wide window**, and it is the same defect I filed as F-10. Here is the exact answer to "which function registers rows, which one enumerates them".

- **Registration** (writes the rows): `ensureAgentBudget` → `ensureRow` → `registerIdentity` + `persist()` in `src/company/budget.ts`. It is *called* from `src/company/panel.ts:32` inside `primeBudget()`, which `agentRows(org)` invokes at `panel.ts:117`. Registering a row is a **side effect of building the org tree** — the panel mutates `company/budgets.json` while answering a GET.
- **Enumeration** (reads the rows back):
  - `listBudgets()` (`budget.ts:369-380`) enumerates the file's keys but **skips any key whose identity cannot be resolved** (`const ctx = identityFor(key); if (!row || !ctx) continue;` at `budget.ts:374-375`). That is what feeds `budgets.byAgent`.
  - `budgetTotals()` (`budget.ts:432-436`) sums **every** row in the file with no identity check. That is what feeds `budgets.totalUsd` / `visual.budgetTotalUsd`.
  - `budgetByDepartment()` iterates `listBudgets()` (so identity-checked).
- **The divergence is evaluation order inside `panelData()`:**
  - `panel.ts:109` `const budgets = listBudgets();` — runs **before** any row has been registered, so on a cold start this is `[]` and it is captured forever into `budgets.byAgent` (`panel.ts:206`).
  - `panel.ts:117` `agentRows(org)` — **now** registers the 32 org rows.
  - `panel.ts:180` `budgetTotals()` — evaluated **after** that priming ⇒ non-zero (`77.50`).
  - `panel.ts:181` `listAgentsFlat()` — registers the 33rd row (`p-ceo::assistant`) **after** `budgetTotals()` already read the file.
  - `panel.ts:206` `budgetByDepartment()` — evaluated last ⇒ sees all 33 rows.
- **Arithmetic proof that these are exactly your numbers:** today `Σ departments[].allocatedUsd = 77.5` = the 32 org rows with the assistant row absent, and `Σ byAgent = 80.5` = the same 32 rows **plus** the assistant's `3.00`. Your `77.5` is therefore the 32-row total captured before the assistant row existed, and your empty `byAgent` is the pre-priming snapshot — the same response.
- **Verdict: CONFIRMED (code + arithmetic).** I did **not** reproduce it live because doing so requires deleting `company/budgets.json` (another workstream's state file); that is destructive and I will not do it. Current server has self-healed to 33 rows, so any single warm `GET /company/panel` now looks correct — **which is precisely why this is dangerous: it is invisible on the second request.**

### 7.4 Your finding #2 — every `panel.agents[]` row must carry a non-null `budget` — **PASS**
```
agents.length=33
null budgets=0
missing agentKey=0
unique agentIds=8 (assistant + 7)
assistant row={"agentId":"assistant","agentKey":"assistant",...,"budget":{"agentId":"p-ceo::assistant","tier":"frontier","departmentId":"d-ceo",...}}
```
Every row has a full `AgentBudget` (and the additive `agentKey` the UI needs). Roster spends also match `budgets.byAgent` exactly (`roster spend mismatches=0`).

### 7.5 Your finding #3 — money math — **PASS on `/company/budgets`, FAIL inside `panel.projects/departments`**
```
rows=33 mismatches=0 zeroAllocRows=0
remaining == max(0, allocated-spent): 0 violations (33 rows)
pctUsed consistent: 0 violations, including fractional rows (0.11172, 1.666667, 2, 5 ...)
SUM alloc=80.5 vs totalUsd=80.5 | SUM spent=0.22064 vs spentUsd=0.22064 | totalUsd-spentUsd=80.17936 vs remainingUsd=80.17936
statuses={"idle":28,"running":5}  == sessions running=5
```
**PASS for every row of `GET /company/budgets` and for `panel.agents[]`.** The failure is one level up:

**F-20 — BREAKS-RUNTIME (wrong data shown to the CEO) — every project/team/department row in the panel gets the *first project's* budget object.**
```
### SMOKING GUN: budget object attached to each team agent (agentId inside it vs the team it sits in)
  project=pmumhg71w teamAgent=tester  agentKey=pmumhg71w::tester  a.budget.agentId=pmumhg71w::tester  a.budget.projectId=pmumhg71w  spent=0
  project=pmumhp51r teamAgent=tester  agentKey=pmumhp51r::tester  a.budget.agentId=pmumhg71w::tester  a.budget.projectId=pmumhg71w  spent=0
  project=pmumhp51u teamAgent=tester  agentKey=pmumhp51u::tester  a.budget.agentId=pmumhg71w::tester  a.budget.projectId=pmumhg71w  spent=0
  project=pmumhp51u teamAgent=coder-1 agentKey=pmumhp51u::coder-1 a.budget.agentId=pmumhg71w::coder-1 a.budget.projectId=pmumhg71w  spent=0
  project=pmumhp520 teamAgent=enhancer agentKey=pmumhp520::enhancer a.budget.agentId=pmumhg71w::enhancer a.budget.projectId=pmumhg71w spent=0.01
  ... (25 of 32 rows are the wrong project's budget; all 7 of pmumhg71w's are correct only by accident)

### panel.projects[].budget / panel.departments[].budget
  LiveFinal 18.5/0.01   Executive Office 13.5/0.01   Platform Core 18.5/0.01   QA & Verification 13.5/0.01   Applied Research 13.5/0.01

### /company/budgets.byDepartment (correct composite keys)
  Eng 18.5/0.01   Executive 13.5/0   Engineering 18.5/0.16064   Quality 13.5/0   Research 13.5/0   d-ceo 3/0.05

SUM projects[].budget.spentUsd    = 0.05      <- should be 0.22064
SUM departments[].budget.spentUsd = 0.05      <- should be 0.22064
SUM budgets.byAgent.spentUsd      = 0.22064
```
- **Cause, precisely:** `panel.ts:27-36` `primeBudget()`:
```ts
function primeBudget(ctx: AgentBudgetContext): AgentBudget | undefined {
  const key = budgetKey(ctx.projectId, ctx.agentId);        // "<projectId>::<agentId>"  (correct)
  if (primed.has(key)) return getBudget(ctx.agentId) ?? getBudget(key);   // <-- line 29: BARE id
  primed.add(key);
  try { return ensureAgentBudget(ctx); }
  catch { return getBudget(ctx.agentId) ?? getBudget(key); }              // <-- line 34: BARE id
}
```
  `getBudget(ctx.agentId)` passes the **bare** id. In `budget.ts`, `resolveKey()` (`:275`) finds no row under the bare id and falls through to `const alias = aliasToKey.get(idOrKey)` (`:282`), and `aliasToKey` is documented and implemented as **"bare agentId -> composite key (first registered wins)"** (`budget.ts:98`, written at `:165` `if (!aliasToKey.has(ctx.agentId)) aliasToKey.set(ctx.agentId, key)`).
- **Why it is per-request, not just once:** `primeBudget` only calls `ensureAgentBudget` on the *first* call (the `primed` Set, `panel.ts:21/30`). Every later panel request takes the `if (primed.has(key)) return getBudget(ctx.agentId)` branch for **every** agent, so all 22 duplicate-id instances permanently resolve to `pmumhg71w::*`. The correct call (`getBudget(key)`) is sitting right there in the `??` fallback but is unreachable because the bare lookup never returns `undefined`.
- **Impact:** the CEO sees Platform Core's real spend `$0.16064` reported as `$0.01`, and 25 of 32 org rows display another project's money. It also makes `Σ projects[]` / `Σ departments[]` diverge from `visual.budgetSpentUsd`/`budgets.spentUsd` (`0.05` vs `0.22064`) — exactly the "panel totals equal the sum over the agents" check in my brief.
- **Not fixed here (my rules); owner call.** The minimal fix is `getBudget(key) ?? getBudget(ctx.agentId)` at `panel.ts:29/34` (composite first, bare only as fallback).

### 7.6 Your finding #4 — threads, composite vs bare vs assistant — **PASS with one observation**
```
GET /company/agents/pmumhp51u::coder-1/thread?limit=100 -> 200 keys=agentId,messages agentId=pmumhp51u::coder-1 n=0
GET /company/agents/coder-1/thread?limit=100           -> 200 keys=agentId,messages agentId=coder-1           n=0
GET /company/agents/pmumhg71w::coder-1/thread?limit=100 -> 200 ... n=0
GET /company/agents/pmumhp51x::coder-1/thread?limit=100 -> 200 ... n=0
GET /company/agents/assistant/thread?limit=100          -> 200 keys=agentId,messages agentId=assistant        n=0
GET /company/agents/does-not-exist/thread?limit=100     -> 200 keys=agentId,messages agentId=does-not-exist   n=0   <-- no 404
from-enum violations=0  shape violations=0
```
`{agentId, messages:[{ts,from,text,kind?}]}` matches contract 6 exactly, `from` always `ceo|agent` **PASS**. After the message test (§7.7) the aliasing became visible and proves the addressing model:
```
AFTER thread(bare enhancer).n=2                       ["ceo","message","reply with the single word: ack"],["agent","reply","ack"]
AFTER thread(pmumhg71w::enhancer).n=2                  (same 2 messages)
AFTER thread(pmumhp51u::enhancer).n=0                  (a DIFFERENT project's enhancer)
```
**F-22 (DEVIATES, minor) — an unknown agent id on `/thread` returns `200` + `messages: []`** instead of a 404/error (contract's error rule is `{error:string}` + 4xx/5xx). A typo is indistinguishable from "no messages yet".

### 7.7 Your finding #5 — POST a cheap router-role agent — **PASS (real reply, real charge, real session)**
```
POST /company/agents/enhancer/message  body={"text":"reply with the single word: ack"}
HTTP status=200  elapsedMs=29507
response keys=agentId,status,reply,sessionId,budget
response.agentId=pmumhg71w::enhancer      <-- requested :agentId was 'enhancer'
response.status=replied
response.sessionId=smumi4qyz-enhancer
response.reply=ack                        <-- a real model reply, not an echo/mock
response.budget={...,"allocatedUsd":0.5,"spentUsd":0.01,"remainingUsd":0.49,"pctUsed":2,...}

BEFORE budget={"agentId":"pmumhg71w::enhancer","alloc":0.5,"spent":0,"remaining":0.5,"pct":0,"sessionsRun":0,"status":"idle"}
AFTER  budget={"agentId":"pmumhg71w::enhancer","alloc":0.5,"spent":0.01,"remaining":0.49,"pct":2,"sessionsRun":1,"status":"idle"}
AFTER  budget(pmumhg71w::enhancer composite) = same row, spent=0.01, sessionsRun=1

sessions BEFORE={"running":1,"queued":0,"total":8}  -> AFTER={"running":1,"queued":0,"total":9}
new session row=[{"id":"smumi4qyz-enhancer","agentId":"enhancer","agentName":"Prompt Enhancer","role":"prompt-enhancer",
  "departmentId":"dmumhg71w","departmentName":"Eng","projectId":"pmumhg71w","projectName":"LiveFinal","taskId":null,
  "taskTitle":"CEO message: reply with the single word: ack","model":"glm-5.3-flash","status":"done",
  "startedAt":"2026-09-29T09:56:30.731Z","runtime":"router","finishedAt":"2026-09-29T09:57:00.211Z","durationMs":29480,
  "lastText":"ack","costUsd":0.01}]
```
Everything the contract asks for on endpoint 7 is real: reply, charged budget (`0 → 0.01`, `remaining 0.49`, `pctUsed 2`), a registered session with `lastText`/`costUsd`/`durationMs`/`runtime:"router"` populated, and the agent thread gaining exactly one `ceo` + one `agent` entry. This also **confirms the fix** noted in §5.2 (session `lastText` is populated for router roles) and §5.4 (the charge landed on the right composite row and the returned budget reflects it, not a stale snapshot).

- **F-06 CONFIRMED LIVE:** I called `…/agents/enhancer/message` and got `agentId:"pmumhg71w::enhancer"` back.
- **F-13 CONFIRMED LIVE:** the bare id resolved to the **first project in org order** (`pmumhg71w`), the same instance for thread, budget and message. `GET /company/agents` returns five rows with `agentId:"manager"` and five different `agentKey`s (`pmumhg71w::manager … pmumhp520::manager`), so a UI that addresses by bare id can only ever reach the Eng instance.
- Note (not a defect, worth knowing): `SessionRec.agentId` is the **bare** id while `AgentBudget.agentId` is the **composite** id on the same run, so a client must join the session to a budget row via `projectId` + `agentId`, not via a single field.

### 7.8 Your finding #6 — `POST /company/assistant/message` with `autoRun:false` — **PASS (plan + decisions, no work started)**
```
sessions before={"running":0,"queued":0,"total":10}
body={"text":"Plan only, do not start work: add a one-line header comment to the README of the QA & Verification project.","autoRun":false}
HTTP status=200  elapsedMs=17464
response keys=reply,plan,dispatched,sessions,budgets,decisions      <- exactly the contract's key set
plan.length=1  plan=[{"title":"Plan one-line header comment for QA & Verification README","departmentName":"Quality","role":"manager","request":"Plan-only work order: ..."}]
dispatched=[{"projectId":"pmumhp51x","taskId":"tmumi7iz3","title":"Plan one-line header comment...","status":"created"}]
budgets={"remainingUsd":80.22936}   sessions.length=0   error=undefined
decisions.length=8
  decision[0]=Company tools budget: $80.28 remaining. My own (assistant) budget: $2.95 remaining of $3.00.
  decision[1]=Claude subscription (claude-sonnet-5-5) unavailable: Error: Claude subscription rate-limited (429). ... Fell back to deepseek-v4-flash on the gateway.
  decision[2]=This planning call cost about $0.0500 from my budget.
  decision[7]=Created task tmumi7iz3 for "..." in QA & Verification; autoRun was off so the pipeline was not started.
```
- The response carries `reply + plan[] + dispatched[] + sessions[] + budgets.remainingUsd + decisions[]` — **PASS** on contract 8.
- **No work started:** the created task `tmumi7iz3` sits at `pending_intake` and appears in the gate queue (`gates=[{…"taskId":"tmumi7iz3","status":"pending_intake","awaiting":"intake"}]`) — **PASS**, and the Claude→DeepSeek fallback path plus the budget-aware `decisions` are observable, as contract 8 requires ("say so in decisions").
- **Honest caveat on the session count:** between my two reads `sessions.total` went `10 → 11` and `running 0 → 1`. I verified this is **not** my call: the new session is `enhancer`, `projectId=pmumhp51x`, `taskId=tmumi7k1y` ("Create a small Node.js script dept-report.mjs…"), a *different* task from my `tmumi7iz3`. It is another workstream driving real work through the same live server. Likewise the assistant thread grew by 3 entries while my call appends exactly 2, so a concurrent assistant call happened. I am reporting the environment as shared rather than claiming an isolated measurement.

### 7.9 Your finding #7 — `GET /company/stream` — **PASS**
```
HTTP status=200  content-type=text/event-stream; charset=utf-8
frames received in 2.6s=2   rawBytes=373214
first frame line count=2  firstLine="event: panel"  secondLineStartsWithData=true
first frame data parses as JSON=true
parsed keys=company,ceo,generatedAt,visual,departments,projects,sessions,budgets,agents,assistant,gates
  company=Laya AI Company  generatedAt=2026-09-29T09:58:43.856Z
  visual={"departments":5,"projects":5,"teams":5,"agents":32,"tasks":4,"sessionsRunning":1,"sessionsQueued":0,"sessionsTotal":11,"budgetTotalUsd":80.5,"budgetSpentUsd":0.32064,"budgetRemainingUsd":80.17936}
server still alive after abort: GET /company/panel -> 200
```
`event: panel`, one `data:` line, valid JSON equal in shape to `/company/panel`, immediate first frame, second frame ~2 s later, correct `content-type`, and the server survived an abrupt client abort — **PASS on contract 10 including "never crash the server; close cleanly on client disconnect"**.

**F-23 (COSMETIC / operational) — each frame is ~186 KB** (`373214 bytes / 2 frames`), i.e. ~93 KB/s **per** SSE client, because the payload embeds `projects[].thread` (60 msgs/project) and `sessions.items[].lastText` (up to 2000 chars each). The dashboard UI polls the same endpoint every 2 s instead, so this cost is currently theoretical — but any client that actually uses `/company/stream` multiplies it. Nothing in the contract caps this.

### 7.10 Your finding #8 — served UI — **PASS**
```
GET / -> HTTP 200  content-type=text/html; charset=UTF-8  bytes=75943
title=CEO Dashboard — Local AI Company
references /company/panel=true   /company/assistant/message=true   /company/agents/=true
absolute http(s) URLs found=0        []
src/href attributes=[]               has <style>=true   has inline fetch=true
```
The served HTML is the dashboard, references `/company/panel`, and has **zero** absolute `http(s)` URLs and **zero** `src`/`href` attributes ⇒ no external resources, no CDN — **PASS on contract 114** (matches the static grep in §6).

### 7.11 Out-of-contract observation worth acting on (found while verifying sessions)
**F-24 — the `summarizer` role is 100% broken right now: `qwen3.8-flash` returns `401 Missing API key`.**
```
GET /company/sessions -> error sessions=2, both:
  summarizer proj=pmumhp51u model=qwen3.8-flash runtime=router dur=313ms
    lastText=Error: Qwen 401: {"type":"error","error":{"type":"AuthError","message":"Missing API key."}}
  summarizer proj=pmumhp51u model=qwen3.8-flash runtime=router dur=1087ms
    lastText=Error: Qwen 401: {"type":"error","error":{"type":"AuthError","message":"Missing API key."}}
```
`src/gateway.ts:73-90` posts to `${gatewayBaseUrl}/messages` with `authorization: Bearer config.gatewayKey` (= `OPENCODE_API_KEY`), while the *same* key works on the chat path (`glm-5.3-flash` replied "ack" in §7.7). So the Anthropic-style `/messages` route rejects that key. Impact on the dashboard: `runPipeline` step 5 (`pipeline.ts:114-118`) always ends with an error string in `tasks[].result` and two red `error` sessions per task — the pipeline still reaches `merged` (`tmumi1kvj` is `merged`), so it is **degraded, not fatal**. Owner is `gateway.ts`/config, not the dashboard workstreams. I did not print any key value.

### 7.12 PASS 2 verdict table

| # | Check | Verdict |
|---|---|---|
| 7.1 | `/health` | **PASS** |
| 7.2 | `/company/panel` shape (`company,ceo,generatedAt,visual,departments,projects,sessions,budgets,agents,assistant,gates`) | **PASS** |
| 7.2 | panel money invariants / totals vs agent rows | **FAIL** (F-11 + F-20) |
| 7.3 | `byAgent` empty while total = 77.5 (your #1) | **CONFIRMED by code+arithmetic; live repro deliberately not run** |
| 7.4 | every `agents[].budget` non-null (your #2) | **PASS** (0 nulls of 33) |
| 7.5 | `remainingUsd == max(0, allocated-spent)` + `pctUsed` on every row (your #3) | **PASS** (0 violations, 33 rows) |
| 7.5 | `Σ byAgent == budgets.totalUsd` | **PASS** |
| 7.5 | `Σ departments[] / Σ projects[] == totals` | **FAIL** (F-20 substitution, F-11 assistant excluded) |
| 7.6 | `/company/agents/:key/thread` composite + bare + assistant (your #4) | **PASS** (shape/PASS, unknown id returns 200+empty: F-22) |
| 7.7 | POST agent message, real reply + charge + session (your #5) | **PASS** |
| 7.8 | assistant `autoRun:false` → plan + decisions, no work started (your #6) | **PASS** |
| 7.9 | `/company/stream` first frame valid JSON, cadence, clean abort (your #7) | **PASS** (size caveat F-23) |
| 7.10 | `GET /` serves dashboard, references panel, no external URLs (your #8) | **PASS** |
| 7.11 | typecheck `npx tsc --noEmit` (see §1) | **PASS** (clean) |
| 7.11 | `summarizer` role functional | **FAIL** (F-24, out of contract scope, owner = gateway) |

**Nothing in PASS 2 was left UNVERIFIED except:** (a) live reproduction of the cold-start `byAgent`-empty window (would require deleting `company/budgets.json` — refused), and (b) `override`-style checks I never ran: approving a gate, `autoRun:true` assistant dispatch, and `POST /company/projects` (all destructive/expensive, and outside the brief).


---

## 8. Summary — final, ranked (PASS 1 static + PASS 2 live)

### BREAKS-RUNTIME
- **F-20 (NEW, PASS 2, highest impact)** — `panel.projects[].budget`, `panel.departments[].budget` and `panel.projects[].teams[].agents[].budget` are replaced by the **first project's** budget object for 25 of 32 org rows. Root cause: `panel.ts:29`/`:34` call `getBudget(ctx.agentId)` with the **bare** id, and `budget.ts` `resolveKey` falls back to `aliasToKey` (`budget.ts:98`, first-registered-wins at `:165`, read at `:282`). Measured: Platform Core's real spend `$0.16064` is shown as `$0.01`; `Σ projects[].spent = Σ departments[].spent = 0.05` vs the true `0.22064`. Minimal fix: swap to `getBudget(key) ?? getBudget(ctx.agentId)`.
- **F-10 / your #1** — cold-start `/company/panel`: `budgets.byAgent` is captured (`panel.ts:109`) before `agentRows`/`primeBudget` registers the rows (`:117`), and `budgetTotals()` (`:180`) is captured before `listAgentsFlat()` creates the assistant row (`:181`). **Mechanism confirmed by code + arithmetic** (`77.5` = the 32-row sum, `80.5` = the same + the assistant's `3.00`); live state has self-healed to 33 rows, so it is invisible on every request after the first.

### DEVIATES-FROM-CONTRACT
- **F-13** — the Agent console (and any bare-id client) can only reach the **first org-order instance** of a duplicated id; five `"manager"` rows exist and only `pmumhg71w::manager` is ever addressed. The payload already carries `agentKey`; the UI ignores it (`index.html:1137, 1177, 1470, 1215`).
- **F-11** — `Σ departments[]` excludes the CEO office (`d-ceo` is not an org department) while `budgets.totalUsd`/`byDepartment` include it: `77.5` vs `80.5`, and **"Executive" appears twice** in the department rollup.
- **F-07** — a failed agent run returns HTTP 200 + `status:"queued"` instead of an error status; the UI then renders "the agent is busy" for a crashed run.
- **F-06** — `POST …/message` echoes a canonicalised `agentId` (`pmumhg71w::enhancer`) that differs from the requested one (`enhancer`). Confirmed live.
- **F-09** — `visual.agents` (32) ≠ `agents[].length` (33). Confirmed live.
- **F-04** — `AgentBudget.agentId` is the composite `` `${projectId}::${agentId}` `` rather than an agent id (deliberate and documented in `budget.ts`/`agentchat.ts`, but it is not what the contract says).
- **F-12** — assistant thread has two sources (`company/assistant.jsonl` vs `company/agents/assistant/thread.jsonl`); direct messages to the assistant do not appear in the assistant console.
- **F-22 (NEW, PASS 2)** — `GET /company/agents/<unknown>/thread` returns `200 {messages: []}` instead of a 4xx error, so a typo looks like an empty thread.
- **F-05** — `pctUsed: 100` when `allocatedUsd === 0` with zero spend (`budget.ts:305`). **Not live-verified** (would need a `POST …/budget {allocatedUsd:0}` write; code-level finding only).

### COSMETIC / operational
- **F-24 (NEW, PASS 2, out of contract scope)** — the `summarizer` role is fully broken: `qwen3.8-flash` → `Qwen 401 Missing API key`, on `gateway.ts:73-90`'s `/messages` path. Degraded, not fatal (pipeline still reaches `merged`).
- **F-23 (NEW, PASS 2)** — each `/company/stream` frame is ~186 KB (~93 KB/s per SSE client).
- **F-14** `.brow` 12 grid tracks vs 11 cells. **F-15** dead read of `sessionHint`. **F-16** typed budget value lost on repaint. **F-17** banner/header both sticky at `top:0`. **F-18** `.shead` sticky inside a horizontal scroller. **F-19** `window.__dash` global exposed.

### Verified clean — PASS, with live evidence
- `npx tsc --noEmit` clean (§1, §7.12).
- `SessionRec` / `AgentBudget` field-for-field match; all 11 contract endpoints present with the right methods, paths, status codes (`force`/402/404/400).
- `remainingUsd == max(0, allocatedUsd − spentUsd)` and `pctUsed` consistent on **all 33 rows, 0 violations**; `Σ byAgent == totals` (§7.5).
- `panel.agents[]`: **0 null budgets**, every row has `agentKey`, roster spends identical to `budgets.byAgent` (§7.4).
- Real end-to-end agent run: reply `"ack"`, budget charged `0 → 0.01`, `sessionsRun 0 → 1`, session row with `lastText`/`costUsd`/`durationMs`/`runtime:"router"`, thread gained exactly 2 entries (§7.7).
- Assistant: exact contract key set, `plan[]` + `dispatched[].status="created"` + 8 `decisions[]`, Claude→DeepSeek fallback visible, **no work started**, task gated at `pending_intake` (§7.8).
- `/company/stream`: immediate `event: panel` frame, valid JSON, ~2 s cadence, survives client abort (§7.9).
- `GET /`: served dashboard references `/company/panel`, **0 absolute http(s) URLs, 0 `src`/`href` attributes** (§7.10).
- UI meets all 8 UI requirement groups, dark theme, vanilla JS, 2 s polling (§6).

### The three things I would fix first
1. **F-20** — the dashboard is currently showing wrong per-project money; it is the one defect that actively misinforms the CEO, and it is a two-token change at `panel.ts:29/34`.
2. **F-10 / your #1** — the first request after any restart answers with `byAgent: []` and a total that excludes the assistant; moving `const budgets = listBudgets()` below the priming (or reading the file once after priming) removes it.
3. **F-13** — address agents by the `agentKey` already in the payload; otherwise five of every seven roster entries silently act on the Eng instance.

---

## PASS 3 - post-fix verification

Run 2026-09-29T10:07Z → 10:13Z against the restarted `npm run dev` on `http://localhost:8787`. Nothing was started, restarted or killed by me; all probes are read-only (`GET`) and the only non-GET actions were the probe script the brief told me to run. `npx tsc --noEmit` was not re-run as a gate this pass (it was clean at PASS 2 and no new type errors surfaced in the files I read).

### PASS 3 revision anchors (fresh MD5s, 10:10:31Z)

| File | MD5 | vs PASS 2 |
|---|---|---|
| `src/company/workers.ts` | `0ab35c79878c0b01e027557ce7b61030` | **changed** (was `31d5ff51…`) |
| `src/gateway.ts` | `aaf44dfbeaa5b9704b8fe5e63ff730da` | changed |
| `src/company/sessions.ts` | `85d058dba60d0f558b44a2a45eb5cde3` | **changed** (was `bf1f9fbe…`) |
| `src/company/agentchat.ts` | `1d69091e2a3c7ee49994467024c04278` | **changed** (was `67bd569e…`) |
| `src/server.ts` | `20c63b85a862c86eb2ce81abfdc0ebbf` | **changed** (was `ba7e76ea…`) |
| `src/company/budget.ts` | `f957e5f53c2ea048e5c8e2c9d0662415` | changed (was `4a887143…`) |
| `src/company/panel.ts` | `131f7b32f02a002b2da4c221d0cdd769` | **UNCHANGED — byte-identical to PASS 2** |
| `public/index.html` | `66bf4296c3e5ad223549580e999486ca` | **changed** (was `83b56652…`) |
| `company/org.json` | `9953427cb3695eaff382e637094ff26a` | **changed** — "Eng" (`dmumhg71w`) merged away; now 4 departments |
| `docs/CEO_DASHBOARD_API.md` | `bea6d6c59347a7cfdbc4430c739e6416` | **changed** (the revision under review) |

### 3.1 Item 1 — the coder stdin hang — **PASS (reproduced, both models)**

Command (the brief's own probe, 30 s budget, 4 variants concurrently, stdin mode is the only variable):
```
node ops/probe-stdin.mjs 30      (exit 0, total 30.1s)

timeout: 30s, 4 variants concurrent (stdin mode is the variable)

--- kimi-stdin-pipe  [stdin=pipe]
    status=TIMEOUT_KILLED exit=null wall=30.1s firstEvent=nullms json=0 stop=false last= cost=$0 hello=null
--- kimi-stdin-ignore  [stdin=ignore]
    status=EXITED exit=0 wall=20.4s firstEvent=13822ms json=6 stop=true last=step_finish:stop cost=$0.010336 hello="hello"
--- deepseek-stdin-pipe  [stdin=pipe]
    status=TIMEOUT_KILLED exit=null wall=30.1s firstEvent=nullms json=0 stop=false last= cost=$0 hello=null
--- deepseek-stdin-ignore  [stdin=ignore]
    status=EXITED exit=0 wall=15.8s firstEvent=11591ms json=6 stop=true last=step_finish:stop cost=$0.001293 hello="hello"
```
**Verdict: your claim is TRUE and independently reproduced.** With an open pipe stdin the identical command produces **0 bytes and 0 JSON events** and must be killed at the deadline; with stdin ignored it emits 6 events, terminates on its own with exit 0, and reaches `step_finish:stop`. Two different models (kimi, deepseek) reproduce it, so it is not a model artefact. This is a genuine root cause, not a coincidence.

**Code claim — one correction.** `workers.ts:273` does pass `stdio: ["ignore", "pipe", "pipe"]` ✓, and the `settle()` guard is correct: `if (settled) return; settled = true;` (`workers.ts:298-299`) with the single `resolve(ev)` living *only* inside `settle` (`:319`). So **exactly-once holds: true.** But it is not "five exit paths through one settle()" — counted precisely there are **four** child-process paths through `settle()` plus **one bypass**:

| # | Path | Where | Calls `settle()`? |
|---|---|---|---|
| 1 | hard timeout `OPENCODE_TIMEOUT_SECONDS ?? 900` → `child.kill()` | `:322-325` | yes (one site) |
| 2 | `step_finish` with `reason:"stop"` + 5 s grace → `child.kill()` | `:349-355` | yes (one site) |
| 3 | `child.on("error")` | `:358-360` | yes (one site, no `return` after but the guard handles it) |
| 4 | `child.on("close")` | `:361-363` | yes (one site) |
| 5 | `config.mockMode` early return | `:245-250` | **NO — `return Promise.resolve(ev)` at `:249`** |

Path 5 is harmless (no child, no timers, `closeSession` called exactly once at `:248`), but it means "all exit paths funnel through one `settle()`" is one path too strong. Two further notes: `OPENCODE_TIMEOUT_SECONDS` is **not set** in `.env` (`find /c /i "OPENCODE_TIMEOUT_SECONDS" .env` → `0`), so the effective hard ceiling is the **900 s default**, not the 30 s of the probe; and the grace path settles `done` with `exitCode: undefined` regardless of the eventual exit code (deliberate, and it tags the text with `[resolved on step_finish:stop; process did not exit in time]`).

### 3.2 Item 2 — the unbounded router call — **PASS inside `gateway.ts`, INCOMPLETE across the pipeline**

Code (`src/gateway.ts` @ `aaf44dfb…`):
```ts
:10  const GATEWAY_TIMEOUT_MS = Number(process.env.JCODE_GATEWAY_TIMEOUT_SECONDS ?? 180) * 1000;
:12  function boundedFetch(url: string, init: RequestInit, label: string): Promise<Response> {
:13    return fetch(url, { ...init, signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS) }).catch((e) => {
:14      throw new Error(`${label} request failed after ${GATEWAY_TIMEOUT_MS / 1000}s: ${String(e)}`);
```
The default and the env override are exactly as you described, and **both** model call sites funnel through the helper: `callOpenAIChatCompletions` (`:28`, which also carries `callGatewayModel` `:51` and `callMuseSpark` `:61`) and `callQwenMessages` (`:75`). The only raw `fetch(` in the file is inside `boundedFetch` itself. `JCODE_GATEWAY_TIMEOUT_SECONDS` is **not set** in `.env` (`find /c` → `0`), so the effective bound is **180 s**. An aborted call surfaces as a labelled error rather than an unhandled rejection. **Within gateway.ts your claim holds exactly as stated.**

**But the hang class is not closed.** Every `fetch(` in the tree:
```
findstr /s /n /c:"fetch(" src\*.ts src\company\*.ts
src\claudeSubscription.ts:37   <- OAuth token refresh          UNBOUNDED
src\claudeSubscription.ts:83   <- the Claude MODEL call        UNBOUNDED
src\company\dispatch.ts:20     <- Laya /v1/systemone dispatch  UNBOUNDED
src\decision.ts:39             <- Laya /v1/systemone decision  UNBOUNDED
src\gateway.ts:13              <- boundedFetch (bounded)
src\slack.ts:168               <- Slack notify (best-effort)   UNBOUNDED
```
`claudeSubscription.ts:83` and `decision.ts:39`/`dispatch.ts:20` are **on the pipeline's critical path** (Claude is the manager/opposer/assistant model; the Laya call is pipeline step 3's dispatcher). A hung Claude or Laya socket can still wedge a task at `coding` exactly the way the GLM call did, and the new UI copy would show the run as `running` again. Slack is best-effort and fine as-is.

### 3.3 Item 3 — Qwen 401 / summarizer — **PASS**

Command: `node %TEMP%\w6_pass3_live.js` (issues `GET /company/sessions`).
```
summarizer sessions=6
  status=done project=pmumhp51u model=qwen3.8-flash runtime=router durationMs=7290   qwenFallbackNote=true
  status=done project=pmumhp51u model=qwen3.8-flash runtime=router durationMs=7715   qwenFallbackNote=true
  status=done project=pmumhp51x model=qwen3.8-flash runtime=router durationMs=6004   qwenFallbackNote=true
  status=error ... durationMs=313    tail=Error: Qwen 401: {"type":"error","error":{"type":"AuthError","message":"Missing API key."}}   <- historical
  status=error ... durationMs=1087   tail=Error: Qwen 401: ...                                                                                 <- historical
  status=error ... tail=[stale: server restarted while this session was in flight]
```
The literal tail of a `done` summarizer (last 260 chars of `lastText`):
```
steps:** Confirm throughput task merge; decide whether to relocate files into an Engineering/Platform Core directory if required.

[qwen-fallback: Error: Qwen 401: {"type":"error","error":{"type":"AuthError","message":"Missing API key."}} -> deepseek-v4-flash]
```
**Confirmed exactly as you described:** summarizer sessions now reach `done`, the fallback note is present and self-documenting, and the two remaining `error` rows are the pre-fix 09:54 and 09:57 runs (historical, not new). Code: `workers.ts:392-401` wraps `callQwenMessages` and falls back to `config.models.standard`. Note the root cause is *not* fixed — Qwen still 401s — it is now covered rather than repaired.

### 3.4 Item 4 — stale/ghost sessions — **PASS (live), with three design limits**

Code: `sessions.ts:134-151` `reconcileStaleSessions(reason = "server restarted while this session was in flight")`. For every in-memory record with `status === "running" || status === "queued"` it writes `status: "error"`, `finishedAt: now`, `durationMs: now - startedAt` (falling back to the old value if `startedAt` is unparseable) and appends `\n[stale: <reason>]` to `lastText` (trimmed to the 2000-char cap). It returns the count. Invocation: `server.ts:26-31`, inside a `try/catch` that logs `[sessions] reconciled N stale session(s) left by a previous process` — placed **before** `const app = express()` (`:33`) and therefore long before `app.listen(...)` (`:363`), so it runs before any request is served. Good placement.

Live scan of all 43 session items (`node %TEMP%\w6_pass3_live.js`):
```
sessions in error=7
  - 5 of them carry the marker: [stale: server restarted while this session was in flight]
suspicious sessions=5      <- exactly those 5; every one is status="error" with finishedAt set
counts={"running":0,"queued":0,"total":43} (running == items with status running: 0)
any [stale:] marker present=true
```
Checks that found **zero** violations: no session with `status:"running"` AND a `finishedAt`; no `running` session older than 60 min; no `running` session with `durationMs > 1 h`; no `finishedAt` in the future; no terminal-status record missing `finishedAt`; `sessions.running` equal to the number of running items. **PASS.** The five flagged rows are the reconconciler's own output, i.e. the feature working.

**How I would deliberately falsify it (designed, NOT executed — the CEO is on that server and I will not restart or signal it):**
1. Append one hand-crafted record to `company/sessions.jsonl` — e.g. `{"id":"w6-stale-probe","agentId":"w6-probe","agentName":"probe","role":"coder","departmentId":"","departmentName":"","projectId":"","projectName":"","taskId":null,"taskTitle":"probe","model":"none","status":"running","startedAt":"<2 hours ago>"}` — plus a **negative control** `{"id":"w6-done-probe", ... "status":"done","startedAt":"<now>","finishedAt":"<now>"}`.
2. Restart only the *router* process (the one action I am refusing). On boot it must log `[sessions] reconciled 1 stale session(s)`.
3. Observe `GET /company/sessions/:id`: the stale row must read `status:"error"`, `finishedAt` ≈ boot time, `durationMs` ≈ 7 200 000, `lastText` ending in `[stale: server restarted while this session was in flight]`; the control row must be **byte-identical** to what was written.
4. **Falsification outcomes:** (a) the probe still reads `running` after boot → the reconciler does not run or does not see the record; (b) the *control* row was rewritten → it clobbers healthy history; (c) `reconciled 0` with the probe present → the id/status field names or the replay path changed.
**Three limits I can state without that experiment.** (i) It only repairs records **at boot**: a session that hangs *while the current process is alive* is invisible to it by construction, so that class is now covered only by the 900 s `OPENCODE_TIMEOUT_SECONDS` ceiling and the 180 s gateway bound. (ii) It also flips `queued → error`, but parked messages live on in `company/agents/<key>/queue.jsonl`, so after a restart the board says `error` for work that is still queued on disk. (iii) `durationMs` for a reconciled record is the *elapsed-to-restart* time, so a long-hung session legitimately produces a very large `durationMs`; any future "absurd duration" alarm must not treat that as corruption.

### 3.5 Item 5 — the revised contract vs F-04 / F-06 / F-07 — **one closed, one fixed, one still open**

The revision adds a normative block at `docs/CEO_DASHBOARD_API.md:53-67`.

- **F-04 (`AgentBudget.agentId` composite) — NOW CONFORMANT. Closed.** `:55-56` "the canonical identifier is the **composite key** `"<projectId>::<agentId>"`"; `:58` "`AgentBudget.agentId` IS that composite key. `GET /company/budgets` -> `byAgent[].agentId` and `panel.agents[].agentKey` are composite." Verified live: `byAgent[].agentId` is `pmumhg71w::enhancer`-shaped and `panel.agents[].agentKey` is composite. **This is positive legitimation, not mere silence** — the contract was amended to match the code rather than the code changed, which is your prerogative, but it means the finding is resolved by definition, not by repair. Any old client that assumed a bare id is now formally wrong per spec.
- **F-06 (echoed `agentId`) — FIXED, conformant.** `:63-64` now requires: "When a response echoes an id, it echoes the id the caller sent as `agentId` and the canonical composite as `agentKey`." The code matches: `agentchat.ts:604` `const requestedId = …`, threaded as the new `echoId` parameter (`:456`, call site `:634`) and returned as `agentId: echoId, agentKey: key` on both the failure path (`:533-540`) and the success path (`:548-555`), plus `agentId: requestedId, agentKey: …` for unknown-agent (`:607`), budget-exhausted (`:619`) and queued (`:631`). PASS 2's live observation (composite echoed, no `agentKey`) was the pre-fix revision; in PASS 3 I verified the **code**, not a new live POST. Nit: the `/thread` route still returns `{agentId, messages}` with the id you sent but **no `agentKey`**, so a client cannot learn the canonical key from endpoint 6 the way `:63-64` implies — easy to add.
- **F-07 (failed run reported as `queued` at HTTP 200) — STILL OPEN, and now a positive violation.** `:66-67` requires "A failed agent run is `status:"error"` (**server maps it to 502**)." The first half is fixed (`agentchat.ts:536` returns `status:"error"`); the second half is not implemented: `server.ts:305-311` maps only `out.error === "unknown agent"` → 404 (`:308`) and `out.error === "budget_exhausted"` → 402 (`:309`), and otherwise `res.json(out)` → **HTTP 200**. There is no `502` anywhere in `server.ts` and no `out.status === "error"` branch. So a crashed run still arrives as `200` with `status:"error"`, which is precisely what the revised contract forbids. Two-line fix (`if (out.status === "error") return res.status(502).json(out);`) belongs to the `server.ts` owner.
- **NEW — the revision contradicts itself.** `:102` still types the message response as `status: "replied"|"queued"` while `:66` mandates `status:"error"`. The literal union on the endpoint definition was not updated, so a client generated from endpoint 7 rejects the value the server now sends. F-05 (`pctUsed: 100` at zero allocation) is untouched by the revision and remains open on code inspection.

### 3.6 Item 6 — UI honesty — **cap labelling PASS, "measured spend" now over-claims**

`GET /` → 200, 81 184 bytes. The chips are client-rendered (`<div id="chips" class="chips"></div>` is empty in the served HTML), and `chip(label, value, tone)` renders `<b>value</b>label` (`index.html:759-761`), so the literal strings the CEO sees are the arguments at `:773-780`:
```
<b>n</b>running · <b>n</b>queued · <b>n</b>sessions total · <b>n</b>agents · <b>n</b>tasks
<b>$80.00</b>spend cap (policy, virtual)
<b>$1.24</b>measured spend
<b>$78.76</b>cap left (virtual)
```
Other literals: `:333` `<h2>Agent spend caps &mdash; virtual, set by the CEO</h2>`; `:330` section comment `3. BUDGETS (honest naming: virtual spend caps, not provider credit)`; `:324` `bar = share of that agent's spend cap used (virtual)`; `:929` meter label `measured spend`; `:930-931` `of $80.00 CEO-set spend cap (virtual, policy not credit) · X% of cap used · $78.76 cap left`; `:944` rollup `measured spend X / cap Y · cap left Z`; `:958` headers `cap (USD) | measured spend | cap left`; `:910` input title `virtual spend cap in USD (not provider credit)`; `:1005` `assistant cap left … (virtual)`; `:1107-1109` `cap exhausted (server: HTTP 402 budget_exhausted) … Agent spend caps panel`; `:1294` `Spend cap for X set to $Y (virtual, not provider credit)`.

**Answer to your four sub-questions:** (1) **Yes** — the $80.00-style figure is now explicitly `spend cap (policy, virtual)` and the meter/table headers say `cap`, not money. (2) **Yes, one phrasing still over-claims, but about spend, not the cap.** `:345` reads *"Measured spend is real observed cost, not an estimate: it sums the per-call `part.cost` values reported on …"* and `:347-348` *"the measured spend is what the providers actually billed per call"*. That is **false for every router-role run.** (3) `measured spend` and `cap` are clearly separated everywhere in the labels. (4) The contrast to watch is exactly the one above: cap numbers are labelled, spend numbers are asserted as billed.

**New finding — F-25 (BREAKS-TRUST, not a crash): 88.6 % of "measured spend" is a flat per-role invention.** `workers.ts:207-212` charges `estimateCostForRole(role, runtime)` whenever the runtime reports no cost of its own, and router roles *never* report one; `budget.ts` holds the flat table (`ROUTER_RUN_COST_USD`: manager 0.05, opposer 0.04, enhancer 0.01, summarizer 0.01, assistant 0.05, coder/tester 0.03). Measured live:
```
/company/budgets.spentUsd  = 1.241032          <- what the UI calls "measured spend"
  opencode-role spend      = 0.141032 (coders/testers: parsed provider part.cost -> REAL)
  router-role spend        = 1.100000 (flat constants)   == 88.6% invented

sessions: router n=27 -> 25 have costUsd EXACTLY equal to a flat constant; opencode n=16 -> 16 fractional (real)
  manager=0.05, opposer=0.04, prompt-enhancer=0.01, summarizer=0.01 (every router row)  vs  coder=0.024302/0.008202/0.011548 …, tester=0.001179/0.001899 …

per-agent rollup: pmumhp51u::manager 0.15 = 3.000 x flat; pmumhp51u::enhancer 0.04 = 4.000 x flat;
  pmumhp51u::opposer 0.12 = 3.000 x flat; pmumhp51u::summarizer 0.04 = 4.000 x flat; p-ceo::assistant 0.40 = 8.000 x flat
  (coders/testers are NOT multiples: 0.810, 1.181, 0.703, 0.196 …)
```
The CEO's complaint was that $80.50 looked like real money. The relabelling fixed the cap half honestly and well. The spend half is now the same class of problem in the opposite direction: `$1.24 measured spend` is presented as billed-to-the-provider, when `$1.10` of it is a constant your own code invented per call. Two smaller consequences of the same root: the assistant's own decision text says *"This planning call cost about $0.0500"* (a flat constant), and `p-ceo::assistant spent=$0.40 sessionsRun=0` — eight planning calls charged with no session row, so spend appears with no session behind it. My recommendation is to label router-role spend as `estimated` (e.g. `measured spend $0.14 · estimated $1.10`) rather than to change the copy only, since the number itself is what the CEO will act on.

Also fixed in this UI revision, for the record: **F-09** — `agentCount = agentList(P).length` (`:771`, with a comment citing the report) so the header now reads 33, matching the Agent console, instead of `visual.agents` = 32. 

### 3.7 Still open from PASS 2 (none of these were in scope, and `panel.ts` is byte-identical)

Re-ran the PASS 2 alias probe unchanged at this revision (`node %TEMP%\w6_pass2_alias.js`):
```
project=pmumhp51u teamAgent=tester  agentKey=pmumhp51u::tester  a.budget.agentId=pmumhg71w::tester  a.budget.projectId=pmumhg71w
project=pmumhp520 teamAgent=enhancer agentKey=pmumhp520::enhancer a.budget.agentId=pmumhg71w::enhancer a.budget.projectId=pmumhg71w
SUM projects[].budget.spentUsd    = 0.05        <- should be 1.241032
SUM departments[].budget.spentUsd = 0.05        <- should be 1.241032
SUM budgets.byAgent.spentUsd      = 1.241032
SUM projects[].budget.allocatedUsd = 75   SUM byAgent.allocatedUsd = 80
byDepartment = [Engineering 36.5/0.432528, Executive 13.5/0.094302, Quality 13.5/0.235398, Research 13.5/0.078804, Executive 3/0.4]
```
- **F-20 (BREAKS-RUNTIME, wrong money on the board): still present and 24x worse.** Every org row still gets `pmumhg71w::*`'s budget; the project/department rollups now understate spend as `$0.05` against a true `$1.241032`. `panel.ts` is unchanged (`131f7b32…`), so `primeBudget`'s `getBudget(ctx.agentId)` (`panel.ts:29/34`) is untouched. One-line fix stands.
- **F-11: still present, and now visible as a duplicate row.** `byDepartment` has 5 groups including **two named "Executive"** (the real department at 13.5 and the CEO office `d-ceo` at 3.0). The new UI discloses this in prose (`index.html:349`, "The cap total and the department rollup include the CEO office") rather than fixing the rollup — disclosure, not repair.
- **F-10: still present** (`panel.ts:109` before `panel.ts:117`); unchanged and still one request wide.
- **F-13 / F-22 / F-23 / F-24-as-root-cause / F-05: unchanged.** Note F-24 is now *covered* (the Qwen fallback works) rather than fixed — the 401 remains.
- `org.json` changed under me: `dmumhg71w` ("Eng") was merged into "Engineering", so the panel now reports 4 departments and `visual.departments` = 4; any published count of "5 departments" is stale.

### 3.8 PASS 3 verdict table

| # | Item | Verdict |
|---|---|---|
| 1 | `opencode run` stdin hang (probe) | **PASS — reproduced on kimi + deepseek** |
| 1 | `stdio:["ignore",…]` + exactly-once `settle()` | **PASS with correction — 4 settle paths + 1 mock bypass, guard holds** |
| 2 | `gateway.ts` bounds every request | **PASS (180 s default, both call sites)** |
| 2 | "unbounded router call" class closed | **FAIL — 4 unbounded call sites remain, 2 on the pipeline's critical path** |
| 3 | summarizer `done` + `[qwen-fallback: …]` | **PASS (live, literal tail shown)** |
| 4 | no stale/ghost "running" sessions | **PASS (live, 43 rows; 5 reconciled, 0 violations)** |
| 4 | reconciler falsification procedure | **DESIGNED, not executed (would need a restart — refused)** |
| 5 | F-04 vs revised contract | **CLOSED — conformant by spec amendment** |
| 5 | F-06 vs revised contract | **FIXED in code, conformant** (live re-POST not run) |
| 5 | F-07 vs revised contract | **STILL OPEN — `status:"error"` yes, the contract's 502 mapping does not exist** |
| 5 | contract self-consistency | **NEW — `:102` still types `status:"replied"|"queued"`, contradicting `:66`** |
| 6 | `$80.50` labelled as a policy cap | **PASS (literal strings shown)** |
| 6 | does any remaining copy imply real money | **FAIL — "measured spend is what the providers actually billed" is false for 88.6 % of spend (F-25)** |
| 6b | F-20/F-11/F-10 re-check at this revision | **STILL OPEN** (wrong-project money, duplicate Executive, cold-start window) |

### 3.9 What I would do next, in order
1. **F-20** — `panel.ts:29/34` → `getBudget(key) ?? getBudget(ctx.agentId)`. Right now the board says the company spent `$0.05` when it spent `$1.24`.
2. **F-25** — split "measured" from "estimated" in `AgentBudget` (or label router-role spend as estimated in the UI). Do not leave `$1.24 measured spend` next to copy claiming it is provider-billed.
3. **F-07 502** — `server.ts:305-311` needs the `out.status === "error"` → 502 branch its own contract now demands, and `:102`'s union needs `| "error"`.
4. **Item 2 gap** — wrap `claudeSubscription.ts:83`, `decision.ts:39` and `dispatch.ts:20` in a bounded fetch; the Claude and Laya paths can still hang a task at `coding`.
5. **F-11 / F-10** — include `d-ceo` in the department rollup (or exclude it from `totalUsd`) and move `listBudgets()` after the priming.


