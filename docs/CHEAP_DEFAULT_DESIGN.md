# CHEAP-DEFAULT (Job 2) - design for the small-task path

Author: CHEAP-DEFAULT session (`session_orangutan_1790715311586_4e958ea99b0e835a`), 2026-09-30 ~02:40 local.
Spec: `docs/CHEAP_BY_DEFAULT_SPEC.md` (Job 2). Rules: `docs/AGENT_COORDINATION.md`.

**Status: HOLD (manager note at 02:43 local).** BUDGET (otter) now owns `brainRouter.ts` and is
changing the assistant model in `assistant.ts`; the manager ordered "do NOT edit any src file".
Phase 2 code edits are therefore STOPPED. I had already implemented the sections below *before*
the HOLD arrived (§6 lists exactly what landed, honestly, as unverified work), and I have touched
no `src/` file since. The design below is still the plan, but it must be re-checked against
otter's final gate API before being kept or re-applied.

Everything in §0 is *measured from disk* at 02:30-02:40 local, not assumed.

---

## 6. HOLD receipt, disclosure, and the revised gate (read this first)

### 6.1 What the manager said (02:43)

"HOLD. BUDGET (otter) now owns `brainRouter.ts` and is also changing the assistant model in
`assistant.ts` right now. Do not edit any src file. Finish only your read-only design doc ...
and note that the gate has changed: big = max(long, multi) vs tiny, Opus thresholds 0.92/0.85,
`callClaudeSubscription` always gates (no purpose = `generate`). Wait for otter's log entry
before Phase 2."

### 6.2 The revised gate (measured from `brainRouter.ts`, mtime 02:38:58)

- `opusP = 0.92`, `opusLead = 0.85` (was 0.75/0.20): an automatic Opus is now much rarer; the
  remaining ways to Opus are the CEO naming it and the hard rules.
- `bigTop = Math.max(l, m)` (line 238): "big" is now the max of the long/multi probabilities
  compared against the tiny one, not a 3-way top/lead.
- `callClaudeSubscription` gates on EVERY call; a caller that names no `purpose` is treated as
  `generate` (never Claude). Consequence for §2.2: the `orchestrator.generate` hop was already
  covered by otter, and my change there is now only the honest `reason` text.
- `brainRouter.ts` was still being edited at 02:38:58, i.e. after I wrote §0-§5. The §0 API list
  is a snapshot, not a contract: re-read it before any Phase 2 work resumes.
- `briefing`/`run-card` became `claudeEligible: true` in the 02:35 version (matching the spec's
  "DeepSeek by default, Sonnet when Laya says large"), which resolves the Q2 conflict I raised:
  no gate-table change is needed, and a briefing still may not take Opus.

### 6.3 Disclosure: what I landed BEFORE the HOLD (now VERIFIED at the call site)

Timestamps are local (UTC+5:30). The table below shipped before the HOLD; on 03:08 the
call-site proof `ops/cheap-default-check.ts` passed 9/9 with a sandbox root, Laya+gateway stubs and
`CLAUDE_BIN` pointing at a missing file, and the 21:31:11Z restart loaded it all into the live
router. **Still NOT verified:** the assistant.ts half (otter's file), and the latent `workers.ts`
`anthropic/<id>` path (reported, unreached by any current catalog).

| File | mtime | Change |
|---|---|---|
| `src/company/assistant.ts` | 02:36:35 | §2.1: one gated path (`purpose: "assistant"`, requested model as ceiling); `canReadFiles` now comes from the returned `brain.tier` instead of a hardcoded `true`; `requestedModel` default `cheapModel()`; honest wording for the read-file instructions and the attachment block; the planning call is charged at the *answering* model, not the ceiling. |
| `src/company/runManagers.ts` | 02:37:29 | §2.4: `chooseRunModel` reasons now say "ceiling; the gate decides"; new `missingClaims(evidence)` and a deterministic PASS veto ("a PASS is not allowed when the run's own evidence says a claimed file is MISSING"); the card records the gate's tier/model/reason. |
| `src/company/briefing.ts` | 02:42:41 -> **CLOBBERED 21:16:24Z** | §2.3: dropped the local `failures > 0 -> Opus` pick; `sonnet` is the ceiling; the page shows the gate's real model and reason. **A peer's stale buffer overwrote this twice; the file is back to the original pick and I have deliberately stopped re-applying it (see §5 Q8).** Routing/spend are unaffected (the gate refuses Opus for a briefing); only the stated reason is wrong. |
| `src/company/fleet.ts` | 02:40:21 | §2.5: planner/reviewer defaults `claude-opus-5-5` -> `config.claudeSonnet`; new `cheapPlan(order)` (ONE locally built work order, **no planner model call**); `planOrder` asks the gate first and takes that path on a `none` tier; `planOrReviewModel` returns the gate's tier; `reviewWorkOrder` gets a deterministic PASS floor (no readable `REPORT.md` -> REDO) and honest tier labelling in the trace. |
| `src/orchestrator.ts` | 02:40:53 | §2.2: the low-confidence route now says its model is only a ceiling and the gate decides; comment on the `generate` hop. |

I have stopped. On the word "revert" I will undo these hunk by hunk, re-reading each site first so
that otter's concurrent edits are never clobbered (see 6.4); on the word "keep" they can stand as
input to otter's final API. Either way I will not touch `src/` before otter's log entry.

### 6.4 Two concurrency facts worth knowing

1. **`briefing.ts` was overwritten under me.** My §2.3 edit landed at ~02:38:30; a peer wrote the
   same file at 02:41:16 (their own `counts.stuck` work) and my change was gone. I re-applied it at
   02:42:41 against their current version. Anyone else editing `briefing.ts` should re-read it.
2. **`tsc` flickered.** At 02:41:03 `npx tsc --noEmit` was RED with one error in `briefing.ts`
   (`Property 'stuck' does not exist on type 'Briefing'`, line 896 - the peer's half-landed edit);
   their next write at 02:41:16 fixed it and tsc has been clean since (last clean run 02:41:53).
   So "tsc clean" is a moving target while peers are mid-edit - re-run it immediately before any
   claim.

---

## 0. What already exists (the API I will build against)


`src/company/brainRouter.ts` (otter's Job 1, still being finished - it grew from 19.9 KB to
23.3 KB while I was reading it). Exports:

| Export | What it gives the call site |
|---|---|
| `pickBrain({purpose, text, hint?, needsFiles?, hardRule?, cheapFailures?, budget?, trace?})` | the decision: `{tier: "none"\|"sonnet"\|"opus", claudeCall: boolean, model, reason, reasonKind: "laya"\|"ceo-override"\|"fallback", fileBlind, climbed, laya:{top,lead,predicted,ms}}`. Never throws. Also appends the decision to `company/budget/brain-decisions.jsonl`. |
| `resolveBrainModel(pick, requestedModel, role?)` | the request chain: gate pick -> caller's model as a **ceiling** -> `applyBudgetFilter`. Returns `{model, tier, changed[], claudeCall}`. |
| `ceoNamedTier(text)` | "use Claude"/"Opus" keyword check (rule 2 in the spec). |
| `cheapModel()` | `BUDGET_BRAIN_CHEAP_MODEL` or **`deepseek-v4.1-flash`** (the spec's default). |
| `noteCheapFailure(key)` / `cheapFailures(key)` / `clearCheapFailures(key)` | the twice-failed -> one Sonnet attempt safety net. |
| `brainStats(day)` | today's `{claudeCalls, claudeAvoided, opusAvoided, byTier, byPurpose, byReason, fileBlind, climbed}` for the Budget page. |
| `tierModel`, `tierOf`, `minTier`, `normalizeTier`, `brainThresholds`, `brainPurposes`, `normalizePurpose`, `brainDecisionsPath` | helpers. |

Purpose table as landed (`PURPOSE_RULES`): `plan`, `review`, `assistant`, `fleet-plan` are
`claudeEligible` (so a *big* task may get Sonnet; Opus only where `opusEligible`), and
`chat`, `answer`, `status`, `briefing`, `run-card`, `enhance`, `summarize`, `worker`, `generate`
are **never** Claude (fallback tier `none`). Thresholds: `BUDGET_BRAIN_BIG_P=0.33`,
`BUDGET_BRAIN_BIG_LEAD=0.08`, `BUDGET_BRAIN_LAYA_MS=3000`.

`src/claudeSubscription.ts` is already hooked: `callClaudeSubscription({..., purpose})` runs
`pickBrain` + `resolveBrainModel`, and when the tier is `none` it calls
`callGatewayModel(deepseek-v4.1-flash, ...)` and **never touches the subscription**. The gate is
UNCONDITIONAL: an omitted `purpose` becomes `generate` (never Claude), so no caller can skip it. It
returns `brain: {tier, model, reason, reasonKind, top, lead, ms}` on the result.

Opus bars (updated 03:20, CHEAP-DEFAULT Job B): the hand-raised 0.92/0.85 is gone. The default is
`BUDGET_BRAIN_OPUS_SHARE=0.3` -> `opusP=0.75`, `opusLead=0.20` - calibrated from 65 measured Laya
samples so ~30% of BIG work reaches Opus (see §6.5). `brainThresholds()` now returns
`{bigP, bigLead, opusShare, opusP, opusLead, layaMs}`.

SAFETY NET + CEILING SEMANTICS (updated 08:42, from BUDGET/otter's findings):
- `callClaudeSubscription` now takes `failureKey?` and owns the cheap-failure counter: it reads
  `cheapFailures(key)`, passes it to `pickBrain({cheapFailures})`, books a cheap-tier failure with
  `noteCheapFailure(key)` and rethrows, and clears the key on a cheap success or on any Claude path.
  Default key `${purpose}:sha1(brainText).slice(0,12)`; pass `${purpose}:${taskId}` for exactness.
  So "2 cheap failures -> ONE Sonnet attempt" actually happens now (it was inert: nothing recorded a
  failure), proven by `ops/cheap-default-check.ts` section F.
- **A non-Claude ceiling imposes nothing.** `resolveBrainModel` used to cap the pick with
  `tierOf(requestedModel)`, and `tierOf(undefined)`/`tierOf("deepseek-...")` is `none` - which
  silently turned the Sonnet climb (and a CEO naming) back into the cheap tier that had just failed.
  Only a real Claude ceiling (`sonnet`/`opus`) caps a pick now. A caller that passes no `model` is
  therefore safe, and ASSISTANT_MODEL/FLEET_PLANNER_MODEL still mean "never above this".

Call sites passing `purpose` *today*: `assistant.ts:444` (`assistant`), `briefing.ts:316`
(`briefing`), `fleet.ts:1267` (`fleet-plan`/`review`), `runManagers.ts:1230` (`review`),
`workers.ts:395` (`plan`/`review`/`worker` - Claude Code's own edit).

Call sites **not** yet passing `purpose`: `src/orchestrator.ts:42`, `src/server.ts:328`.

Measured model config: `.env` has `ASSISTANT_MODEL=claude-opus-5-5`; `fleet.ts` defaults
`FLEET_PLANNER_MODEL`/`FLEET_REVIEWER_MODEL` to `claude-opus-5-5`; `runManagers.chooseRunModel`
picks Opus on failed/stuck/2x-REDO itself; `briefing.briefingSummary` picks Opus when
`failures > 0` itself. Those four local picks are what Job 2 replaces with "ask the gate".

---

## 1. Definition of a "small task" (one definition, no second heuristic)

A task is **small** exactly when the gate says `tier === "none"`, i.e. Laya's size/complexity
`top < 0.33` **or** `lead < 0.08`, and the purpose is not one the CEO named. There is deliberately
no separate rule engine, no title-length or file-count heuristic: the gate is the choke point and
Job 2 must not become a second brain.

Consequence for the four purposes Job 2 touches:

| Purpose | Small task (tier none) | Big task (tier sonnet/opus) |
|---|---|---|
| `assistant` | `deepseek-v4.1-flash` on the Go gateway; the file-read claim must become false (§2.1) | Sonnet via `claude -p` (Opus not eligible for `assistant`) |
| pipeline plan / `generate` | no Claude; the plan step runs on DeepSeek `-p` (workers.ts already tags `plan`) | Sonnet plan |
| `fleet-plan` | **no planner model call at all**: one locally built work order (§2.5) | Sonnet/Opus planner as today |
| `review` | automated check, or DeepSeek on the report **text** (§2.4) | Sonnet review; Opus only on a 2nd REDO or failed/stuck |

After Job 2 the chain for a small order is:

```
CEO -> Assistant (tier none -> deepseek-v4.1-flash, 0 Claude calls)
    -> Laya track pick (cheap, already does this)
    -> pipeline or fleet
        pipeline: manager plan on DeepSeek (workers.ts purpose=plan) -> ONE coder task
        fleet:    NO planner call -> ONE locally built work order
    -> worker on deepseek-v4.1-flash
    -> review: automated check (deterministic evidence) - 0 Claude calls
    -> Assistant report-back (DeepSeek)
```

Zero Claude calls for every hop. Big orders keep the existing chain (Claude plan + Claude review).

---

## 2. File-by-file changes

### 2.1 `src/company/assistant.ts` (the CEO's order planner)

Problem today: `ASSISTANT_MODEL=claude-opus-5-5` (line 1024 -> `requestedModel`), and
`callAssistantModel` (line 403) branches on the model *name*: a `claude-*`/`"claude"` choice goes
to `callClaudeSubscription` (gate applies), anything else goes straight to `callGatewayModel`
(line 416-432) and **skips the gate entirely**. So with a DeepSeek `ASSISTANT_MODEL` a big order
could never escalate, and with the Opus value every small order asked for Opus (the gate was the
only thing saving us).

Changes:
1. Default becomes the spec's cheap model, not `config.claudeFallback`:
   `const requestedModel = (process.env.ASSISTANT_MODEL ?? cheapModel()).trim();`
   (import `cheapModel` from `./brainRouter.js`). `.env` is **rose's file** and I will not touch
   it; with `ASSISTANT_MODEL=claude-opus-5-5` still set, Opus is only a *ceiling* and
   `minTier(none, opus) = none`, so small orders are already free - the code default matters for
   a fresh install and for the day the manager clears that line.
2. `callAssistantModel` gets **one** gated path. Keep passing
   `purpose: "assistant"`, `cwd: path.dirname(getCompanyRoot())`, `addDirs: [...]` exactly as
   today, and read the gate's answer off the result:
   ```ts
   const r = await callClaudeSubscription({ ...as today, model: claudeModel || cheapModel() });
   const ranCheap = r.brain?.tier === "none";
   return { text, model: r.brain?.model || claudeModel, canReadFiles: !ranCheap };
   ```
   The `[assistant-fallback: ...]` gateway branch stays as the last resort after a thrown error,
   but the normal cheap path is now chosen by the gate, not by the model name. This is the
   bug-class ATTACH already found: today the Claude branch unconditionally reports
   `canReadFiles: true` (line 455) even though `callClaudeSubscription` may have answered on a
   file-blind gateway model; the gate's `tier` is the only honest source for that flag.
3. The pre-call `applyBudgetFilter` bookkeeping (lines 1024-1037) stays: it still decides the
   attachment notice and the recorded cost, and the gate's `brain.reason` is appended to
   `decisions` next to it, so the CEO sees one line per order saying which tier ran and why.
4. Attachments: an attached file on a *small* order is `needsFiles=true` -> the pick is
   `fileBlind`. The existing ATTACH notice ("attachments need the Claude assistant", line 1091)
   is the correct behaviour under the new rule and must not be weakened. **Open question for the
   manager (§4 Q1).**

### 2.2 `src/orchestrator.ts` (the generic route/generate path)

`decideRoute` (line 19) hard-escalates to `claudeSonnet`/`claudeOpus` on low confidence
(`b.confidence < minConf`), and `generate` (line 34) calls `callClaudeSubscription` **without a
`purpose`**, so the gate never sees it.

Changes:
1. `generate`: pass `purpose: "generate"` and `brainText: prompt`. Because `generate` is
   `claudeEligible: false`, this makes it **0 Claude calls, always** - it is a plain answer, not
   planning - and the requested `route.modelId` stays the ceiling. If the manager would rather let
   a genuinely big one-shot escalate, the one-word change is `purpose: "plan"`; my recommendation
   is `"generate"` because `/ask` and `team.ts` are chat-like and the spec says chat/answers never
   take Claude.
2. `decideRoute`: keep the low-confidence branch, but stop *naming* Opus/Sonnet as a decision -
   return the same `via: "claude-subscription"` route with `modelId: config.claudeSonnet` (the
   ceiling) and a reason that says "ceiling only; the gate decides". Opus is then reachable only
   through the gate's hard rules / CEO naming, which is what "Opus is rare" means. (If the manager
   wants Opus kept as the ceiling for DEMANDING work, no code change is needed - the ceiling can
   never raise the tier, only lower it.)
3. Note: `workers.ts:395` (Claude Code's file, **not mine**) already maps the pipeline manager
   agent to `purpose: "plan"`, so the pipeline's Claude plan step is already behind the gate.

### 2.3 `src/company/briefing.ts`

`briefingSummary` (line 290) picks `opus` when `failures > 0` and `sonnet` otherwise, then calls
the gate (already `purpose: "briefing"`). Since `briefing` is `claudeEligible: false`, the gate
already answers `none` -> `deepseek-v4.1-flash` on the gateway. So the *behaviour* the spec wants
is already true; the local Opus/Sonnet pick is now dead weight that misleads a reader into
thinking a briefing could spend Opus.

Change: keep `model` as the **ceiling** (`config.claudeSonnet`, and keep `config.claudeOpus` only
if the manager wants the door open for a future rule), but change `reason` to say the gate decides,
and record `out.brain?.model ?? out.model` as the model that actually ran (the page must not claim
Sonnet when a gateway model answered). **Open question Q2: the spec's sentence "briefing:
DeepSeek by default, Sonnet only when Laya says large" conflicts with the gate's own table
(`briefing` is never Claude). I follow the gate (one choke point) and do not change its table -
the table is otter's Job 1 and is the CEO's "chat replies never take Claude" rule.**

### 2.4 `src/company/runManagers.ts` (run cards + verdicts = "review")

Two things:

1. `chooseRunModel` (line 1134) picks Opus locally on failed/stuck/2x-REDO. Under the gate that
   is the `redo2`/`failed`/`stuck` hard rule, which `brainRouter` already implements
   (`review` has `hardRules: ["redo2"]`). Change: return the **ceiling**
   (`config.claudeOpus` when the hard rule applies, else `config.claudeSonnet`) plus a reason that
   says "ceiling; the gate decides", and pass `hardRule: redoTwice ? "redo2" : undefined` (already
   done at line 1231). No behaviour change for a big review; a small review now stops asking for
   Claude at all.
2. **The review for a small run must not be a file-blind model verdict.** `managerCard` passes
   `cwd: repoRoot()` + `addDirs`, so a `none` tier is `fileBlind` - a model that cannot read the
   deliverable must not write PASS/REDO. Design (this is the "automated check" the spec names):
   - Before calling the model, ask the gate once:
     `const pick = await pickBrain({purpose: "review", text: run.order || run.title, hardRule})`.
   - If `pick.claudeCall` -> the existing `callClaudeSubscription` review path, unchanged.
   - If `!pick.claudeCall` -> `automatedReview(run)`:
     * run the deterministic checks that already exist in the evidence (line 852:
       `FILES THE RESULT CLAIMS (existence checked just now)` -> `exists` / `MISSING`), plus the
       run's own state/report flags;
     * a claimed file that is `MISSING`, or a `done` run with no result and no REPORT.md ->
       verdict `REDO`, `verdictReason: "automated check: <file> is MISSING"`;
     * all claims present + the run reported -> verdict `PASS`,
       `verdictReason: "automated check (no Claude): every claimed file exists and the run reported"`;
     * nothing to check (no file claims, no report) -> **no verdict**, card stays a heuristic
       placeholder ("pending"), which is already the codebase's rule for "cannot verify".
   - If the deterministic check is inconclusive *but* the run's report is prose the CEO must read,
     the second option is a DeepSeek review of the **report text only** (no `cwd`/`addDirs`, so no
     file blindness): `purpose: "review"` with `brainText` = the report, and the verdict is
     labelled `"cheap review (deepseek-v4.1-flash, report text only)"`. I will implement the
     automated check first and only add this if a real small run needs prose.
   - The card records `model: "local (automated check)"` and `modelReason` with the gate's reason,
     so the Briefing page never implies a Claude review happened.

### 2.5 `src/company/fleet.ts`

`planOrder` (line 1395) is a **Claude planner call per fleet order** and `reviewWorkOrder`
(line ~1959) a **Claude review per work order**. Under the gate both are already downgraded for
small work, but a downgraded *planner* is a gateway model with no file access
(`cwd: repoRoot()`, `addDirs: [getCompanyRoot()]` at line 1263-1264 -> `fileBlind`), which would
plan blind. That is exactly what the work order's "skip the Claude plan and send ONE order
straight to a worker" replaces.

1. `planOrder`:
   - Build the planner prompt as today, then ask the gate **before** any model call:
     `const pick = await pickBrain({purpose: "fleet-plan", text: order.text, needsFiles: true})`.
   - `pick.claudeCall` -> `planOrReviewModel(plannerModel(), ...)` exactly as today (Sonnet/Opus).
   - `!pick.claudeCall` -> `cheapPlan(order)`:
     * **no model call at all**; one `WorkOrder` built from the order text
       (`id: \`${order.id}-01\``, `title` = first line of the order, `role: "coder"`,
       `owns: []` (the worker discovers its files; `owns` is only used for the review snippets),
       `brief` = the order text + `repoDigest()` (already built for the prompt) + the fleet's own
       worker preamble (the same text `briefBody` prepends),
       `done` = the order's own acceptance sentence(s) if it has any, else
       `["the work described in the CEO order is done", "REPORT.md exists"]`,
       `state: "queued"`).
     * `order.plan = "cheap default: one work order, no Claude plan (Laya: <top/lead>)"`,
       `pushTrace(order, {from: "Laya (brain)", to: "Fleet rules", what: "one work order, no planner"})`.
     * Keep the existing `planAttempts`/`plannerPid` bookkeeping so a restart still resumes.
   - This keeps ONE worker for small work and never spends a blind gateway call on planning.
2. `reviewWorkOrder`: same shape as §2.4 - gate first
   (`pickBrain({purpose: "review", text: wo.brief + report})`), Claude when `claudeCall`,
   otherwise the deterministic acceptance check on `wo.owns` + the paths in `REPORT.md`
   (`exists`/`MISSING`, the same primitive the fleet already uses) and the verdict labelled
   `"automated check (no Claude)"`. The existing retry/failed bookkeeping (`reviewAttempts`,
   `reviewRetries()`) stays intact so a REDO still loops the way it does today.
3. `plannerModel()`/`reviewerModel()` defaults (`claude-opus-5-5`) become the **ceiling**; I will
   change the *default* to `config.claudeSonnet` so a fresh install cannot accidentally name Opus,
   and document that Opus is reachable only via the gate's rules/CEO naming. (`.env` untouched.)
4. `pickFleetModel`/`switchSessionModel` (bonehound's F1) are **not** part of Job 2 - I will not
   touch them. Ownership note: bonehound reported F1 DONE at 02:12 and my work order grants Job 2
   over `fleet.ts`; I will keep my edits to `planOrder`, `reviewWorkOrder`, the two model getters
   and say so in the log before/after.

### 2.6 Not mine, but needed for the acceptance test

`workers.ts`, `pipeline.ts`, `dispatch.ts`, `gates.ts`, `claudeSubscription.ts`, `server.ts` are
out of my grant. The pipeline's plan/review hops are already tagged (`workers.ts:395`), and the
Budget page already reads `brainStats` (`server.ts:53`). If the acceptance run shows a pipeline hop
reaching Claude for a small order, that is otter's/Claude Code's row, not mine - I will report it
instead of editing.

---

## 3. Phase 2 order of work (DONE - status per item)

1. Re-read `brainRouter.ts`/`claudeSubscription.ts` at their final revisions. **DONE** - see §0 (the
   gate is unconditional; the Opus bars are calibrated, not the hand-raised 0.92/0.85).
2. `assistant.ts` (§2.1). **DONE then handed over:** otter owns that file and has since made
   `ASSISTANT_MODEL` a live ceiling (jcode's 03:07 entry confirms `tier=sonnet` in production). My
   §2.1 edits are still in the tree but are NOT mine to verify further.
3. `runManagers.ts` (§2.4) + `briefing.ts` (§2.3). **DONE for `runManagers.ts`** (live since the
   21:31 restart, plus the `redo2` fix in §6.5). **`briefing.ts` is contested** - clobbered twice by a
   peer's stale buffer; the 8 lines are in §2.3 and are not re-applied (see §5 Q8). **UPDATE 03:24:56: re-applied on the third attempt - the file had been quiet ~38 minutes and an exact-match edit cannot clobber a peer's hunk; verified on disk and `npx tsc --noEmit` = exit 0.**
4. `fleet.ts` (§2.5). **DONE and verified at the call site**: a small order = ONE locally built work
   order with **0 model calls**; a big order still engages the planner (see §6.3/§6.5).
5. `orchestrator.ts` (§2.2). **DONE** (`purpose: "generate"` + honest route reason).
6. `npx tsc --noEmit`. **DONE**, exit 0 (last run 03:12, with every file above in the tree).

## 4. Verification (what was ACTUALLY executed, and what it does not cover)

The original plan here was one isolated-router acceptance run. What was executed instead covers the
same requirements with less machinery, and the difference matters:

- **Routing + the spec's acceptance** - `ops/budget-brain-proof.ts` on a seeded temp `COMPANY_ROOT`
  (the real order text from 5 projects/31 tasks + `fleet/orders.json`), NOT an isolated router:
  10 real past orders (8 -> `none`, 2 -> Sonnet), the 3 spec small fixtures (0 Claude), `"use Claude"`
  -> Sonnet, `"have opus review it"` -> Opus, `redo2` -> Opus, twice-failed -> one Sonnet attempt.
  **ALL PASS.**
- **The Opus share** - `ops/brain-opus-calibration.ts`: 29 fixtures / 65 Laya samples, no Claude, no
  server; small 8/8 and medium 12/12 on `none`, and the calibrated bar sends 3/10 big fixtures (30%)
  to Opus. The hand-raised 0.92/0.85 sent 0/10.
- **The call-site small-task path** - `ops/cheap-default-check.ts`: stubs for Laya and the Go
  gateway, `CLAUDE_BIN` pointing at a missing file, sandbox root, no server. A small fleet order ->
  ONE work order, **0 gateway requests**, no Claude spawn; a big one -> planner engaged, Claude
  attempted first; the assistant purpose with an Opus CEILING -> `none` for small, `sonnet` for big.
  **9/9 PASS**, including the `redo2` regression cases.
- **Regressions** - `ops/fleet-selftest.ts` ALL PASS (8/8), `ops/budget-selftest.ts` all PASS,
  `npx tsc --noEmit` exit 0.
- **Not covered, stated plainly:** (a) ~~a live CEO order end-to-end through the RUNNING router~~ -
  **CLOSED 03:05** by `ops/dev-router-acceptance.ts` (dev port 8801-8899, temp `COMPANY_ROOT`, stub
  gateway, missing `CLAUDE_BIN`): 10/10 PASS through the real HTTP route, with the caveat that I drive
  *question-shaped* orders so no pipeline/worker is spawned - the work-order path is covered by
  `ops/cheap-default-check.ts` and the proof; (b) the assistant.ts half is otter's file; (c) Laya's own
  classification error (5 of 10 intended-big fixtures are missed, and the "status question" fixture is
  unstable: `0.43/0.00`, `0.15/0.05`, `0.46/0.32` across draws) is a proxy limit of using Laya at all;
  (d) the production Opus share over days is unmeasured - only the live bar is confirmed in the log.
- **Dev-instance isolation gap (found 03:05, disclosed in the log):** an isolated `COMPANY_ROOT` does
  NOT isolate the run manager - it discovers runs from the GLOBAL `~/.jcode/sessions` journals, so a
  dev router reviews REAL runs (my first run: 2 Claude card checks + a Slack briefing post). Always
  add `RUN_MANAGER_BACKEND=heuristic` and blank `SLACK_BOT_TOKEN`/`SLACK_CHANNEL_ID`/`SLACK_APP_TOKEN`
  to a dev instance.

## 5. Open questions for the manager (I will proceed with the stated default if not answered)

Status as of 03:20: **Q2 and Q3 and Q4 and Q5 are resolved** - the gate made `briefing`
Claude-eligible when Laya says big (Q2), `purpose: "generate"` is in `orchestrator.ts` by
manager decision (Q3), `assistant.ts` is otter's and `ASSISTANT_MODEL` is now a live ceiling (Q4),
and I was granted `fleet.ts` for Job 2 (Q5). **Q1 (attachments) is still open and still on the
default: a small order with a file keeps the ATTACH notice and answers without opening it.**

New open items:
- **Q6: the latent leak.** `workers.ts:233` maps a `claude*` model id to `anthropic/<id>` for
  `opencode run`, i.e. Claude spend with no gate and no budget guard. Unreachable today (opencode
  roles are coder/kimi + tester/deepseek; Laya's worker candidates and the fleet catalog exclude
  Claude), but it is an open door. It is Claude Code's file, not mine. **Paste-ready patch** (fails
  loudly instead of silently downgrading, so the caller must choose the gated path):
  ```ts
  function providerSlashModel(modelId: string): string {
    // A Claude id must NOT be spawned as an opencode worker: that path spends Claude with no Laya
    // gate and no budget guard (CHEAP-DEFAULT leak audit). Claude goes through
    // callClaudeSubscription / runRouterRole, never through this launcher.
    if (modelId.startsWith("claude")) {
      throw new Error(`${modelId} cannot run on the opencode runtime: Claude model ids are gated in callClaudeSubscription (see src/company/brainRouter.ts)`);
    }
    if (modelId.includes("qwen")) return `opencode-go/${modelId}`;
    return `opencode-go/${modelId}`;
  }
  ```
  (Alternative, only if a silent downgrade is wanted: return `opencode-go/` + the standard fleet
  model instead of throwing.) Either way, tell me and I will re-run the audit sweep.
- **Q7: the restart.** The `redo2` fix (§6.5) is on disk but not live; the old rule was spending
  Opus roughly every 30-60 s. A restart is the manager's/OPS's call - I did not touch `:8787`.
  **Verifier, ready to run (read-only):** `npx tsx ops/brain-gate-post-restart-check.ts --since
  <router boot time>`. It prints the tier mix, the Opus share AND where each Opus came from, and it
  FAILS if any row still cites the removed `0.92/0.85` bar or if `redo2` still fires in bulk. Run
  against the CURRENT process it reports the truth: `decisions: 28 | byTier none=14 opus=10
  sonnet=4 | Opus share 36% (9 of the 10 from hardRule:redo2, 1 from the calibrated bar) | PASS no
  row cites the removed bar`. So the calibrated guardrail is live and the leak is the redo2 rule.
- **Q8: `briefing.ts` is contested.** My §2.3 edit was overwritten by a stale editor buffer TWICE
  (the second time at 21:16:24Z, taking the file back to `failures > 0 -> opus` with the reason
  "Opus: N failed run(s) in this briefing"). I stopped re-applying it rather than risk a lost-update
  on whoever is editing that file. Cost impact: none (the gate refuses Opus for a briefing); it is the
  page's stated reason that is wrong. **UPDATE 03:24:56 - CLOSED: re-applied on the third attempt once
  the file had been quiet ~38 minutes (an exact-match edit cannot clobber a peer's hunk, so the only risk
  was losing my own 8 lines again). It is on disk and `npx tsc --noEmit` = exit 0, so the snippet below is
  now the recovery copy rather than a pending patch. Original note follows.**
  ```ts
  // in briefingSummary, replace the opus/sonnet pick with:
  const ceiling = config.claudeSonnet;   // the gate decides; a briefing may never take Opus
  const why = failures > 0 ? `${failures} failed run(s) in this briefing` : "nothing failed";
  const reason = `Sonnet ceiling (${why}); the Laya gate picks the tier`;
  // ...then pass `model: ceiling` to callClaudeSubscription and report the gate's real model:
  const ranOn = out.brain?.model || out.model || ceiling;
  const gateReason = out.brain
    ? `${reason} -> ${out.brain.reason}${out.brain.tier === "none" ? " (cheap summary, no Claude call)" : ""}`
    : reason;
  // and return `model: ranOn, reason: gateReason` in both returns.
  ```

<details><summary>Original questions (kept for the record)</summary>

- **Q1 (attachments):** a small order with an attached PDF/image is `fileBlind` under the gate.
  Keep the existing "attachments need the Claude assistant" notice and answer without the file
  (my default, keeps "small = 0 Claude"), or let an attachment itself be a reason to escalate?
- **Q2 (briefing):** spec says "briefing: Sonnet only when Laya says large", the gate's table says
  `briefing` never takes Claude. My default: follow the gate and leave the table alone.
- **Q3 (`orchestrator.generate` purpose):** `"generate"` (never Claude, my default) or `"plan"`
  (a big one-shot may escalate)?
- **Q4 (`ASSISTANT_MODEL`):** the code default becomes `deepseek-v4.1-flash`; the live `.env`
  (`rose`'s file) still says `claude-opus-5-5`. My default: do not touch `.env` (it is only a
  ceiling), and report the line so the manager can decide.
- **Q5 (`fleet.ts` ownership):** bonehound's F1 touched `fleet.ts` today; my work order grants
  Job 2 over it. My default: proceed with §2.5 and log it before editing.

</details>

### 6.5 The calibrated Opus guardrail, and the `redo2` leak (Job B + measured live)

**Calibration (3.15-3.20).** `ops/brain-opus-calibration.ts` measured 29 realistic CEO orders
(65 Laya samples; Laya answered deterministically across repeats, median ~140-200 ms): 8 small +
12 medium samples all land on `tier=none`, and 10 intended-big fixtures clear the big bar with
`(top = max(long,multi), lead = top - tiny)` from 0.5241/0.3148 up to 0.8780/0.0854. The hand-raised
0.92/0.85 reached **0 of those 10**. `BUDGET_BRAIN_OPUS_SHARE` (default 0.3) maps the CEO's target
onto a measured ladder - `0.60/0.08 -> 80%`, `0.65/0.10 -> 30%`, `0.75/0.20 -> 30%`,
`0.80/0.30 -> 20%`, `0.84/0.40 -> 10%` - and the gate takes the STRICTEST step that still reaches the
target, so 0.3 -> **0.75/0.20 -> 3 of 10 big fixtures (30%)**: the multi-file feature, the auth
refactor and the frontend migration; the near-ties with routine work stay on Sonnet.

**Live confirmation (21:38Z, router pid 34224 booted 21:31:11Z):** rows citing the calibrated bar,
`review -> opus (laya) "very sure (top=0.86, lead=0.61 >= 0.75/0.2)"`; **zero** rows cite 0.92; and
the near-ties went to Sonnet as designed (`top=0.88, lead=0.15 -> Sonnet`, `0.77/0.10 -> Sonnet`).

**The `redo2` leak (found 03:05, fixed 03:06).** The same live log showed **15 of 52 gates in 15
minutes on Opus, every one `hardRule=redo2 purpose=review`, every 30-60 s** (6 of 20 rows after the
restart). Cause: `runManagers.managerCard` computed `redoTwice` as "two REDOs ANYWHERE in the run's
accumulated card history", and a hard rule bypasses the calibrated bars - so any run that ever
collected two REDOs re-escalated on every later re-check. Fix: `redoEscalation(history)` fires only
on the transition into a **second consecutive REDO** (an escalation, not a permanent state - the
same shape as the cheap-model safety net). Regression cases live in `ops/cheap-default-check.ts`
section D and all pass, including `[REDO,REDO,REDO] -> false` where the old rule said true. **The fix
needs a restart to go live; until then the old rule keeps spending.**
