# Laya tuning (LAYA-TUNE, 2026-09-29)

Fix 2 of `docs/LAYA_FIX_SPEC.md`: build an eval set from the company's own decisions,
measure the wording that was on disk, change the wording/state/question type, measure
again, and set the confidence thresholds from the data.

Everything below is a measurement of the **live local Laya** on `http://127.0.0.1:8000`,
made through `ops/laya-eval.ts`. Raw results are in `logs/laya-eval-*.json`; the run logs
are `logs/laya-eval-run1.txt`, `logs/laya-eval-run3.txt`,
`logs/laya-eval-model-costrule.txt`, `logs/laya-eval-fleetmodel.txt`.

> This file replaces an earlier `docs/LAYA_TUNING.md` (the `ops/laya-probe.ts` measurement
> from the same day, 207 lines). I overwrote it without reading it first - my mistake. It is
> recovered verbatim as `docs/LAYA_TUNING_PROBE_2026-09-29.md`, and its two findings that are
> not repeated here (the 0.5 model-escalation threshold firing on 16/16 routes, and one
> prompt-injection that routed a trivial rename to Opus) are worth reading before anyone
> re-tunes the router path.

## Scope: the request, and what I had to assume

The work order is Fix 2 of `docs/LAYA_FIX_SPEC.md`, in the order it is written: build the eval
set, measure the baseline, improve the questions, re-measure, recommend thresholds, log the
proof. Reading it back now, these are the points where the task did not spell something out and
I chose an interpretation - stated here so the choices can be overruled:

1. **Which questions are in scope.** The spec names three answer kinds ("team / model / track").
   I graded six, because the goal is "make Laya decisive" and Laya is asked three more questions
   in the files I was granted: `chooseAgent` (the role pick the pipeline runs on every task),
   `classifyComplexity` and `classifyBrain` (both live callers). The extra three are additive -
   they cannot break anything the spec asked for - but they did change code
   (`decision.ts`), so they are worth knowing about.
2. **How far "the questions" reaches into code.** The spec says "wording/criteria/state only,
   keep the signatures". I read that as *not* touching caller logic, so I did not implement
   three fixes I believe are correct and instead documented them with their evidence: the
   named-team short-circuit in `chooseTeam`, the missing Kimi ceiling in the pipeline call site,
   and the Kimi fallback when Laya is down. **If the intent was "do whatever makes Laya
   decisive", those three are in scope and each is a few lines.**
   *(2026-10-01: all three are now done by the CODE worker - see "Call-site fixes applied"
   at the end of this file.)*
3. **Grading the fleet's own question.** `fleet.ts` is bonehound's and Fix 1 my spec does not
   own, but the spec does say to use the fleet orders in the eval set, so I measured its
   question read-only (verbatim copy, checked against the file at runtime) and never edited it.
4. **Gold labels.** Real cases take the answer the company actually gave where one exists; the
   rest are my judgement as "the answer a careful human would give", each with a `note` in the
   harness. Synthetic cases are labelled `synthetic`. Where my label is arguable (a
   "self-check script": tester or coder?) the note says so, and the Stability section lists the
   ones that decide whole percentage points.
5. **The mid-task cost rule.** The CEO changed the model policy while I was working. I chose to
   relabel the model cases and re-measure rather than freeze the earlier labels, so the model
   numbers describe the policy now in force. Both sets of numbers are in the logs.
6. **`docs/LAYA_TUNING.md` looked like a file I was meant to write from scratch** - it was not,
   and my first write replaced an earlier session's 207-line measurement. That is the one
   assumption here that cost real work; it is recovered verbatim as
   `docs/LAYA_TUNING_PROBE_2026-09-29.md` and the earlier doc still matters for the router
   path.

## Deploying this: the router needs a restart to pick the wording up

The router runs `tsx src/server.ts` with no hot reload, so these changes reach the live company
only when the router process restarts. **At the time of writing it has not**, and that matters:

```
live router : [2026-09-29T14:31:14.360Z] BOOT pid=25808 ... port=8787   (logs/router.crash.log)
decision.ts     written 14:22Z  -> loaded by that process       (complexity + brain are live)
assistant.ts    written 14:32Z  -> NOT loaded (edit is 70s after boot)
dispatch.ts     written 15:09Z  -> NOT loaded
```

So the running company still has the **old model question (24% on the eval)** and - because the
assistant's file was mid-edit when that process booted - my **first, worse track draft (62%)**
rather than the reverted original (85%). Both files on disk are the measured-best versions; a
restart fixes both. I did not restart anything: `docs/AGENT_COORDINATION.md` says the router is
CRASHFIX/OPS territory and the rules forbid it, and the supervisor only starts a router when
`:8787` has no listener, so the restart has to be deliberate (or the next crash will do it).

How to confirm the new wording is live after any restart:

1. `Select-String logs/router.crash.log -Pattern 'BOOT pid=' | Select-Object -Last 1` - the boot
   time must be later than the file times above.
2. After the next Laya hop, a fresh task trace contains `noul escalate=` (the new model
   question); the old code emitted `Laya best_worker=<model> conf=` and no noul numbers. One
   line: `findstr /S /C:"noul escalate=" company\projects\*\tasks.json`.

Until both are true, the eval numbers in this document describe the code on disk, not what the
running company is currently doing.

## How to reproduce

```powershell
npx tsx ops/laya-eval.ts                              # both arms, all 7 question groups
npx tsx ops/laya-eval.ts --only model --repeat 2      # one group, twice (stability)
npx tsx ops/laya-eval.ts --variant live --cross-check # live arm + real-function cross-check
npx tsx ops/laya-eval.ts --only fleetmodel            # the fleet's own question (read-only)
```

The harness is read-only: no dispatch, no server, no writes outside `logs/`, and it
sleeps `--gap` ms between calls so Laya is never flooded (Laya runs on CPU; the manager
measured 30 s timeouts under eval load, so the default timeout is now 90 s).

## The eval set

70 labelled cases, **repeat 2** (140 calls per arm). Labels are "the answer a careful
human would give", taken from the decision the company actually made where one exists:

| group | cases | real | synthetic | what it grades |
|---|---|---|---|---|
| team | 15 | 11 | 4 | `chooseTeam`: which project owns the order |
| track | 13 | 7 | 6 | the assistant's track question (pipeline / fleet / answer) |
| agent | 13 | 5 | 8 | `chooseAgent`: role, plus the parallel flag |
| model | 17 | 13 | 4 | `chooseWorkerModel`: glm / deepseek / kimi |
| brain | 6 | 3 | 3 | `classifyBrain`: SONNET vs OPUS |
| complexity | 6 | 3 | 3 | `classifyComplexity`: ROUTINE..DEMANDING |
| fleetmodel | 17 | 13 | 4 | the fleet's own model question (`fleet.ts`, unchanged) |

Sources: every `from "Laya"` hop in `company/projects/*/tasks.json` traces, the CEO
orders in `company/assistant.jsonl`, the work orders in `company/fleet/orders.json`,
and the assignment/role the pipeline actually made. Synthetic cases are labelled
`synthetic` in the harness and in the results JSON.

Two mechanics that make the comparison honest:

* the **baseline arm** is a frozen copy of the wording that was on disk before this
  task (in `ops/laya-eval.ts`), i.e. the control;
* the **live arm** is imported from the real modules (`*QuestionSpec()` in
  `src/decision.ts`, `src/company/dispatch.ts`, `src/company/assistant.ts`), so the
  thing measured is the thing that ships. After the reverts below, the harness reports
  `track 13/13 identical | agent 13/13 identical` - the reverted text is byte-for-byte
  the baseline.

## Before / after

Accuracy, both arms, repeat 2. `meanConf` is Laya's own `confidence`, `meanTop` the top
probability, `meanLead` top minus runner-up.

| question | baseline | live | meanConf b→l | meanTop b→l | shipped? |
|---|---|---|---|---|---|
| team | 67% | **73%** | 0.21 → 0.22 | 0.50 → 0.53 | **yes** |
| track | 85% | 85% (identical text) | 0.10 → 0.10 | 0.50 → 0.50 | reverted |
| agent | 69% | 69% (identical text) | 0.48 → 0.48 | 0.68 → 0.68 | reverted |
| model | 12% | **59%** | 0.11 → 0.78 | 0.55 → 0.41 | **yes** |
| brain | 67% | **83%** | 0.12 → 0.74 | 0.67 → 0.43 | **yes** |
| complexity | 33% | **67%** | 0.17 → 0.65 | 0.50 → 0.61 | **yes** |
| agent, parallel flag | 85% | **92%** | - | - | **yes** |

Run 1 (before the reverts) is the reason the rule "ship only what improves accuracy" was
applied strictly: the first draft of the track wording scored 62% (it lost five pipeline
cases to fleet/answer), and the first complexity/brain drafts were no better than their
baselines. Those drafts are gone.

Two footnotes on that table, because the numbers move with the gold labels, not the code:

* The **model** row compares like with like: the same 17 work orders, the same (post-cost-rule)
  gold labels, only the question changed. The baseline arm is the old 3-way `choice`
  (`best_worker` over the three worker models) and scores **12%**; as a `choice` the old
  question always answered `kimi`. Graded against the *earlier* labels - the ones I wrote
  before the CEO's cost rule arrived, where UI work counted as a Kimi case - the very same
  baseline arm scores **24%**. Both numbers are in `logs/laya-eval-model-costrule.json`
  and `logs/laya-eval-run3.json`; neither is comparable to the other, and the 59% after is
  measured against the cost-rule labels.
* The **track** and **agent** rows are 85% and 69% in both arms because the wording is now
  byte-for-byte the baseline (the harness reports `identical` for those groups), so any
  small difference there is Laya's sampling, not a code change.

## What changed and why (the findings, not the fixes)

1. **A 3-way or 4-way `choice` collapses onto one option.** The model question answered
   `kimi-k2.7-code` for 14 of 17 work orders, including "fix the typo in README.md",
   whatever the criteria said. `ops/tmp-model-order.mjs` tested the same question with
   the criteria in three different orders (strongest first, cheapest first, mixed) and
   got 2/7 correct every time - **criteria order is not the cause; the choice form is.**
   The same question as a `choice` in the fleet's own wording (`fleet.ts`, unchanged)
   scores 24% over the same 17 work orders.

2. **`noul` (yes/no probability) questions do separate the cases.** Two questions in one
   call - "should this escalate to the expensive coder?" and "is this a trivial one-text-file
   edit?" - scored **59%** where the choice form scored 12-24%. `classifyComplexity` and
   `classifyBrain` were converted the same way (three nouls for the four difficulty
   levels; one noul for the brain), taking them from 33% to 67% and 67% to 83%.

3. **A criterion that starts with the other option's name gets read as that option.**
   The first track draft began the *pipeline* criterion with "Answer only if the order is
   a question..." - Laya read it as the answer track and flipped two pipeline cases. The
   answer rule belongs in `instructions`, not inside a criterion.

4. **State fields beat prose for a 512-1024 token model.** Each question now carries
   deterministic cues computed in TypeScript (`textCues()`: `type` ui/docs/code, `files`,
   `risk`, `size`, `horizon`, `parts`, `question`) plus `names_a_team` for the team
   question (the team or department the order itself names). The team score rose 67% → 73%
   on the strength of that field and of labelling a team with no description
   ("has no description yet - choose it only if the order names this team"), which stops
   Laya falling back to it.

5. **Text that is not in the eval is not fixed.** The revert of the agent role hints is
   the clearest example: the longer, more concrete hints *look* better and measured
   exactly the same (69%), so they are not shipped. Its misses are genuinely arguable
   cases, not wording failures: "create a Node ESM **self-check** script" (Laya: tester,
   the pipeline assigned coder) and "condense this thread into a **memory note**" (Laya:
   coder, gold: summarizer).

## Thresholds, from the data

Gate = "use Laya's pick only when `<statistic> >= T`". `confidence` is Laya's
`1 - H(p)/log k`; `top` is the top probability and `lead` = top − second.

### team (`assistant.ts` → `chooseTeam`, gate on `confidence`)

| gate | picks kept | of those, right |
|---|---|---|
| none | 30/30 | 73% |
| `confidence>=0.15` | 20/30 | 90% |
| **`confidence>=0.20`** | **18/30** | **100%** |
| `confidence>=0.30` | 4/30 | 100% |
| `confidence>=0.35` | 4/30 | 100% |
| top>=0.60 & lead>=0.08 | 10/30 | 100% |

**Recommend `LAYA_TEAM_MIN_CONF=0.20`** (currently 0.3 in `.env.example` and in the code
default). 0.20 keeps 60% of picks at 100% precision; 0.30 keeps 13%, i.e. the assistant's
own routing wins almost always even though Laya is right on those picks.

### track (`assistant.ts` → `chooseTrack`, gate on `confidence`)

Wording reverted, so baseline = live:

| gate | picks kept | of those, right |
|---|---|---|
| none | 26/26 | 85% |
| **`confidence>=0.20`** | **4/26** | **100%** |
| `confidence>=0.30` | 2/26 | 100% |
| top>=0.30 & lead>=0.08 | 14/26 | 100% |
| top>=0.40 & lead>=0.08 | 14/26 | 100% |

**Recommend keeping `LAYA_TRACK_MIN_CONF=0.2`**: it is safe but nearly never fires (4 of 26),
so the assistant's planned track stands. If the gate's owner (ASSISTANT-BRAIN) is willing
to switch the statistic from `confidence` to top-probability+lead, `top>=0.30 & lead>=0.08`
triples the coverage (14/26) at the same 100% precision. That is a two-line change in
`chooseTrack` and its `TRACK_MIN_CONF` check; I did not make it because my grant on
`assistant.ts` covers the Laya question text only.

### model (`dispatch.ts` → `chooseWorkerModel`; `fleet.ts` → `pickFleetModel`)

Two attempts were made at the UI escalation case and the second was **rejected on measurement**:
adding a deterministic `ui_only` field to `state` plus a "when ui_only is true, answer LOW"
clause to the escalation question scored **29%** on the same 17 work orders x 3, down from 59%
(the clause made the escalation noul fire on nine cases instead of two). It is reverted, and
the case is left to the call-site guard recommended below rather than to more wording.

Dispatch question, shipped (escalation form), 17 work orders x 2:

| gate | picks kept | of those, right |
|---|---|---|
| none | 34/34 | 59% |
| `confidence>=0.85` | 4/34 | 100% |
| top>=0.35 & lead>=0.08 | 18/34 | **78%** |
| top>=0.45 & lead>=0.08 | 10/34 | 80% |
| top>=0.60 & lead>=0.08 | 6/34 | 100% |

The two knobs inside the shipped question are measured too: `escalate>=0.35` gives 20/34
correct, `escalate>=0.25` gives 16/34, so `WORKER_ESCALATE_MIN=0.35` stays. Both of the
"should have been kimi" cases fall below the bar, i.e. the residual error is on the
**cheap** side (deepseek does the work instead of escalating).

Fleet's own question (`fleet.ts`, not mine to change), same 17 work orders x 2:

| gate | picks kept | of those, right |
|---|---|---|
| none | 34/34 | **24%** |
| `confidence>=0.35` | 0/34 | - (its `confidence` never exceeds 0.22) |
| top>=0.35 & lead>=0.08 | 28/34 | 29% |
| top>=0.50 & lead>=0.08 | 18/34 | 44% |
| top>=0.60 & lead>=0.08 | 6/34 | 67% |

**Recommendation for `LAYA_MODEL_MIN_CONF`:** with the choice form there is no bar that is
both accurate and useful - 0.33/0.35 on `confidence` (today's default) means the rule
default decides in practice, which is the safe outcome; the top+lead gate admits mostly
wrong picks. Two better options, both for FLEET-BACKEND: (a) keep `needsEscalation()` as
the decider and treat Laya as advisory, or (b) switch the question to the same two-noul
form used in `dispatch.ts`, which measured 59% overall and 78-86% behind
`top>=0.35..0.40 & lead>=0.08`. If the form changes, set
`LAYA_MODEL_MIN_CONF=0.40` and `LAYAA_MODEL_MIN_LEAD=0.08` (the numbers are in
`.env.example`).

### brain (`runManagers.ts` / `server.ts` → `classifyBrain`)

`classifyBrain` now returns the probability of its "does this need the hard brain?"
question and picks OPUS only at `>= 0.50`. Measured: 83% correct with no gate,
and every pick clears 0.35, so **`RUN_MANAGER_LAYA_MIN_CONF=0.5`** matches the question's
own decision rule (0.35 would also work: it admits the same picks).

## Cross-check: the harness measures the shipped path

The strongest evidence here is `npx tsx ops/laya-eval.ts --variant live --real-functions`
(`logs/laya-eval-realfunctions.txt`). It does not use the harness's own question call at all: it
calls the shipped functions - `chooseTeam`, `chooseAgent`, `chooseWorkerModel`, `classifyBrain`,
`classifyComplexity` and the assistant's real `chooseTrack` (through its exported test hook) -
on all 70 cases and grades their answers.

```
group      n    real-caller acc harness live acc agreement
team       15   73%             73%              15/15 same answer
track      13   85%             85%              13/13 same answer
agent      13   69%             69%              13/13 same answer
model      17   59%             59%              17/17 same answer
brain      6    83%             83%              6/6 same answer
complexity 6    67%             67%              6/6 same answer
  real-caller answers that differ from the harness live arm: 0
```

So the improvement is observed on the code the pipeline and the assistant actually run, not
inferred from the wording: every group's real-caller accuracy equals the harness figure, case by
case, with zero disagreements. (Track is 85% because its wording is the reverted original - the
point there is that the real caller and the harness agree, not that it changed.)

A narrower version of the same check runs with `--cross-check` (a 2-3 case sample per group).
That is also how I noticed that the parallel-flag label for "plan the overhaul and split it
into subtasks" is arguable (Laya says splittable at 0.68, I labelled it sequential), so read
the 92% as 12/13 or 13/13 depending on that one label.

## Stability (repeat 3) and what is still wrong

The four shipped questions were re-run **repeat 3** (44 cases, 264 calls,
`logs/laya-eval-stability.json`). Every headline number came back identical to repeat 2:

| group | baseline | live | repeat 2 -> repeat 3 |
|---|---|---|---|
| team | 67% | 73% | 73% -> 73% |
| model | 12% | 59% | 59% -> 59% |
| brain | 67% | 83% | 83% -> 83% |
| complexity | 33% | 67% | 67% -> 67% |

And **not one case flipped between repeats**: every live case is 3/3 or 0/3. Laya is
deterministic given identical input, so repeating a run adds no independent evidence - only
more *cases* (and better labels) do. That also means the accuracies above are exact for this
case set, not a sample mean.

The residual misses are stable too, which makes them actionable rather than noise:

| case | gold | Laya (3/3) | read |
|---|---|---|---|
| team-real-hello-livefinal | LiveFinal | Platform Core | the order *names* LiveFinal and `state.names_a_team` says so; Laya overrides it anyway |
| team-real-exec-audit, team-real-smoke-record | Executive Office | QA & Verification | cross-company bookkeeping read as verification work |
| team-syn-model-eval | Applied Research | Platform Core | "evaluate two models" read as engineering |
| model-real-ui-overhaul | deepseek (cost rule) | kimi | Laya's prior still says UI -> strongest coder |
| model-real-heartbeat, model-real-smoke-log-edit, model-real-plan-md, model-real-status-report | glm / deepseek | one tier up | longer markdown and small scripts read as "not trivial" (arguable labels) |
| model-real-agent-office-coder1, model-syn-hard-refactor | kimi | deepseek | under-escalation: cheap direction, quality risk |
| brain-real-plan-ui | SONNET | OPUS | a plan for a UI overhaul reads as "hard brain" |
| cx-syn-ambiguous | DEMANDING | STANDARD | "no metric, no definition of done" did not read as unclear |
| cx-syn-log-refactor | COMPLEX | DEMANDING | a six-call-site refactor read as long-horizon (arguable) |

Three consequences worth handing to the owners, none of which I can fix from my grant:

1. **A named team should win deterministically.** `state.names_a_team` already tells Laya the
   order names LiveFinal, and Laya still ignores it (0/3). `chooseTeam` should short-circuit to
   `confidence 1` when exactly one team name matches the order, and only ask Laya otherwise.
   That is caller logic, not question wording.
2. **The COMPLEX level is never produced** by the live complexity question (1/3 ROUTINE,
   9/18 STANDARD, 6/18 DEMANDING, 0 COMPLEX, where the baseline choice did produce COMPLEX).
   The router only reads `rank >= DEMANDING`, so nothing breaks today; if any caller ever uses
   COMPLEX as a level, lower the `multi` bar (currently `>= 0.5`).
3. **The pipeline path has no cost-rule ceiling.** `fleet.ts` refuses a confident kimi pick
   unless `needsEscalation()` justifies it; `pipeline.ts` takes `chooseWorkerModel`'s pick as
   is, so Laya's UI prior can put a worker on Kimi outside the CEO's rule. Same two-line
   pattern (`needsEscalation`-style guard at the call site) would close it - and the
   Laya-unavailable fallback (Kimi, see the limitations) is the same class of problem.

## Honest limitations

* **13-17 cases per group is small.** One case is 6-8 percentage points. Repeats do not buy
  evidence here (Laya answered every case identically three times - see Stability above), so
  the only way to sharpen these numbers is more cases and better labels, not more runs.
* **The gold labels are my judgement**, informed by what the pipeline actually did. Every
  label carries a `note` in the harness saying where it came from; the arguable ones
  (a "self-check script" being tester or coder) are flagged there.
* **The fleetmodel arm is a verbatim copy** of `fleet.ts`'s question, checked against the
  file at runtime (the harness prints a warning if the text drifts). The option ids come
  from `FLEET_MODEL_*` defaults, which differ from the router's `config.models.standard`
  (`deepseek-v4-flash` vs `deepseek-v4.1-flash`).
* **The CEO cost rule arrived mid-task** (deepseek is the default for all work including
  UI; kimi is escalation-only). The model question, its criteria and the model gold labels
  were changed to match and re-measured; the numbers in this document are all from after
  that change. `fleet.ts` is bonehound's file and already implements the rule
  (`needsEscalation()`, `LAYAA_MODEL_CEILING`); the fleet question's own wording was only
  measured here, never edited.
* Nothing here was verified against a live CEO order end-to-end: the eval replays recorded
  decisions through the real question functions and the real Laya, but no new work order
  was dispatched by me (that is the pipeline owners' path, and the fleet proof is
  bonehound's).
* **Open risk found while reading the call site, not fixed (outside my grant):**
  `dispatch.ts`'s `chooseWorkerModel` falls back to `config.models.complex` (kimi) when Laya
  is unreachable, and `pipeline.ts` assigns that `modelId` to the worker. Under the CEO cost
  rule (deepseek default, kimi escalation-only) that fallback should be
  `config.models.standard`. It is one line in a file I may only touch for question wording,
  so it is flagged in `docs/AGENT_COORDINATION.md` instead.
  *(2026-10-01: fixed - `chooseWorkerModel` now falls back to `config.models.standard`
  (deepseek) with the reason "Laya unavailable; cost-rule default (standard)"; measured
  in "Call-site fixes applied" at the end of this file.)*

---

## Laya on GPU (LAYA-GPU, 2026-09-29)

Laya now runs on this laptop's **NVIDIA RTX 4050 Laptop GPU** (6 GB, driver 596.36, CUDA 13.2)
instead of the CPU. Same host and port: `http://127.0.0.1:8000`. Same checkpoints, same
revisions, same answers - only faster.

### Measured before / after (live `:8000`, same fixed inputs)

| metric | before (CPU, torch 2.14.0+cpu) | after (GPU, torch 2.14.0+cu132) |
|---|---|---|
| 20 sequential `/v1/systemone` calls, the exact `chooseAgent` payload | p50 **1604 ms**, p95 **2949 ms**, min 1360, max 3958, mean 1823 | p50 **46 ms**, p95 **141 ms**, min 35, max 277, mean 64 |
| answers across those 20 calls | `coder-1` conf 0.38, `parallel` noul 0.48 - 1 distinct answer | identical: `coder-1` 0.38 / 0.48, 1 distinct answer |
| 5 fixed questions through the real pipeline functions | 5.3-8.0 s per question | 0.22-0.59 s per question |
| `GET /health` | `device: cpu`, 3/3 checkpoints on cpu | `device: cuda`, 3/3 on cuda, `device_is_preference: false`, `cpu_fallbacks` 0/0/0 |
| `nvidia-smi` memory used | 62 MiB of 6141 | **2436-2468 MiB** of 6141 (3.6 GB left for the display) |
| Laya process RSS | 1497 MB | 1070 MB at boot, 1854 MB after serving the two runs |

### Answer parity (the point of the exercise)

All 5 fixed questions (`ops/laya-gpu-bench.ts --parity`) produce **identical values in every
field** on CPU and GPU - `agent` + confidence, `parallel`, `complexity` + confidence,
`model`, `brain`, `route`. Files: `ops/laya-before-parity.txt`, `ops/laya-after-parity.txt`.
The 20-call bench answers match exactly too. So this is a pure speed change, not a behaviour
change.

That claim is a command, not an eyeball:

```
node ops/laya-parity-diff.mjs ops/laya-before-parity.txt ops/laya-after-parity.txt
  -> IDENTICAL: all 5 answer lines match field for field (latency excluded)   [exit 0]
node ops/laya-parity-diff.mjs ops/laya-before-bench.txt  ops/laya-after-bench.txt
  -> IDENTICAL: all 21 answer lines match field for field (latency excluded)  [exit 0]
```

The 21 lines are the 20 calls plus the `ANSWERS distinct=1 -> coder-1/0.38` aggregate, so all
20 calls returned the same single answer before and after. Everything except the trailing
latency number is compared, so a change in any answer field would fail the check.

### Why fp16 resident weights, and the VRAM budget

The three checkpoints ship fp16 but load as **fp32 parameters: 4.67 GB total** (measured with
`ops/laya-size-probe.py`: english 1.69 GB + multilingual 1.29 GB + typed-decisions 1.69 GB).
That does not fit 6.1 GB with a desktop attached - an accidental fp32-on-GPU run measured
**4650 MiB** used, leaving 1.4 GB. So `scripts/laya-gpu-boot.py` builds each checkpoint in
`torch.float16` (cast on CPU, inside `build_model`, *before* `model.to(device)`, so the GPU
never holds fp32 and fp16 at once) and caps the process:

* `torch.cuda.set_per_process_memory_fraction(0.65)` = 3.90 GiB of the 6.1 GB card
  (`LAYA_GPU_MEM_FRACTION`), with `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`.
  Verified enforced: `ops/laya-gpu-check.py --probe-cap` allocates until it is refused at
  3.85 GiB reserved, well below the card's 5.9 GiB. Weights settle at ~2.4 GB.
* `LAYA_CUDA_AMP=fp16` so autocast matches the resident weight dtype. laya's own comment says
  fp16 stays 2-10x closer to the fp32 forward than bf16 at the same speed, which is why fp16
  and not bf16.
* Real CUDA work is confirmed, not just `is_available()`: a 1024x1024 matmul on the device
  matches the fp64 CPU result to 2.0e-06 relative error.

### How the device is chosen (nothing in site-packages was edited)

`laya` already prefers CUDA when `LAYA_DEVICE=cuda` and already falls back on its own:
`Agent.__init__` forces CPU when `torch.cuda.is_available()` is false, and catches
`RuntimeError`/`OutOfMemoryError` from `model.to(device)` and reloads that one checkpoint on
CPU. The wrapper adds only the two things laya has no env var for (the VRAM cap and the fp16
cast) by rebinding one module-level function for the life of the process, then runs
`runpy.run_module("laya.serve")`. /health reports `cuda` or `cpu` honestly in both cases.
Four fallback paths were tested: no CUDA in the build (`LAYA_DEVICE=cuda` + CPU torch ->
"CUDA is not available ... -> LAYA_DEVICE=cpu", healthy on cpu), explicit `-Cpu`, a CUDA build
that cannot see the device, and a checkpoint that does not fit (laya's own per-agent fallback).

### How to switch back to the CPU

```powershell
# full service path: stop the GPU instance, choose the torch, start, wait for /health
powershell -File ops\laya-restart.ps1 -Cpu            # -> starts on the CPU
powershell -File ops\laya-restart.ps1 -SkipInstall    # -> restart only, keep the current torch
powershell -File ops\laya-restart.ps1 -Status         # -> health, pids, torch, GPU, backups
# or, starting from a stopped state (this does NOT stop a running instance):
powershell -File scripts\serve-laya.ps1 -Cpu
set LAYA_DEVICE=cpu && start-laya.bat
```

**Rollback to the old CPU PyTorch build** (kept on disk, so it is instant):
`powershell -File ops\laya-restart.ps1 -Rollback` restores
`deps\torch-swap\swap-<stamp>\{torch,functorch,torchgen,torch-2.14.0.dist-info}` into
`deps\venv\Lib\site-packages` and starts Laya on the CPU. `deps\wheels-cpu` also holds the
CPU wheel, and `deps\wheels-cu132` the CUDA one, so pip can reinstall either offline with
`--no-index --find-links`.

### Files

* `scripts/laya-gpu-boot.py` (new) - VRAM cap, fp16 weights, honest CPU fallback, then `laya.serve`.
* `scripts/serve-laya.ps1` - GPU by default (`LAYA_DEVICE=cuda`); `-Cpu` forces CPU by setting
  both `LAYA_GPU=cpu` and `LAYA_DEVICE=cpu`; `-LogDir` is the service-mode log sink.
* `deps/setup.ps1` - installs `torch==2.14.0` from `https://download.pytorch.org/whl/cu132`
  (the index for the driver's CUDA 13.2 runtime), with a CPU wheel fallback and a CUDA sanity op.
* `ops/laya-restart.ps1` (new) - the one-window stop/switch/start/verify, with `-Rollback`.
* `ops/laya-gpu-bench.ts` (bench + parity), `ops/laya-parity-diff.mjs` (the field-by-field
  before/after comparison), `ops/laya-gpu-check.py`, `ops/laya-size-probe.py`, `ops/laya-gpu-inspect.py`.
* Knobs: `LAYA_GPU_MEM_FRACTION` (0.65), `LAYA_GPU_WEIGHTS` (fp16|bf16|fp32), `LAYA_GPU=cpu`, `LAYA_DEVICE`.

### Honest limitations

* The first restart window took ~4 minutes, not 2: two PowerShell 5.1 quoting bugs of mine
  (an inline `python -c` re-quoted by PS, and an unquoted `-File` path containing a space)
  killed the first launch attempt. Fixed and re-measured: the clean window is **15.9 s from
  stop to healthy**. A third trap (`1>>` under `ErrorActionPreference=Stop` turning a native
  stderr write into a terminating error) is fixed by letting `cmd.exe` do the redirection.
* The 20-call p50 is measured with the CPU instance busy on the same machine before and an
  idle GPU after; the CPU number is the honest "in place, shared" figure, and the first GPU
  call is 944 ms (cold) versus 33-46 ms warm.
* `LAYA_GPU_WEIGHTS=fp32` fits (4650 MiB) but leaves ~1.4 GB for the display - not recommended
  on this 6 GB card; it is supported for comparison and for cards with more VRAM.
* Long-context accuracy on the GPU was not re-measured: the parity set is short company-shaped
  inputs, and nothing here re-ran `ops/laya-eval.ts` (`laya-eval`, `max_len` up to 8192) on the GPU.
* The parity claim is about *choices*, not about floating-point bits: every field of every answer
  matched, which is what the pipeline consumes (it reads `choice`/`noul` and a confidence), but
  the underlying probabilities were not diffed to the last decimal.

---

## Call-site fixes applied (OPS-DOCS, 2026-10-01)

The three call-site fixes the LAYA-TUNE section listed as "documented, not implemented"
(Scope item 2, Stability 1 and 3, Honest limitations last bullet) were implemented by the
CODE worker on 2026-10-01 and measured here, before and after, against the same live local
Laya on `http://127.0.0.1:8000` (cuda). Nothing was restarted: see "Not live yet" below.

### (a) The threshold change: `LAYA_TEAM_MIN_CONF=0.20`

The gate table under *team* above is the reason: `confidence>=0.20` keeps **18/30 picks at
100% precision**, while the shipped `0.30` keeps only **4/30** at the same 100% precision -
same precision, 4.5x the coverage. So 0.20 is the value now shipped:

* `.env.example` line ~54 carries the knob **active**: `LAYA_TEAM_MIN_CONF=0.20`
  (it was commented `# LAYA_TEAM_MIN_CONF=0.2`), with a one-line note giving the 18/30 vs
  4/30 measurement.
* `.env` did **not** contain the knob (grep for `LAYA_TEAM_MIN_CONF` in `.env` returns
  nothing), so nothing was added there - the file is unchanged.
* **The code default is still `0.3`.** `src/company/assistant.ts:1778` reads
  `process.env.LAYA_TEAM_MIN_CONF ?? 0.3`, so the 0.20 above only takes effect once that
  process actually loads the env value (and a restart). That file is ASSISTANT-BRAIN's, was
  not edited here, and its own hard-coded default was not changed; the doc and the
  coordination log both say so.

### The three fixes, with the functions that changed

1. **Named-team short-circuit** - `namedTeams()` / `chooseTeam()` in
   `src/company/dispatch.ts`: when the order text names exactly one team from the catalog,
   `chooseTeam` returns it with `confidence 1` and reason `"named team"` **without asking
   Laya**. This is the case Laya overrode 0/3 times (the LiveFinal case in Stability 1).
2. **CEO cost-rule ceiling at the pipeline call site** - the dispatch loop in
   `src/company/pipeline.ts` (~line 526, `for (const a of assignments)`): a kimi pick from
   `chooseWorkerModel` is refused unless `escalationAllowed()` justifies it
   (`escalationAllowed` is exported by `dispatch.ts` and mirrors `fleet.ts`
   `needsEscalation()`; fleet.ts imports dispatch.ts, so the shared predicate lives there to
   avoid an import cycle). Refused -> `config.models.standard` (deepseek), confidence 0, and
   the reason records `kimi refused: no escalation justification -> ... (cost rule) | was: ...`;
   justified -> `kimi allowed: <why> | ...`.
3. **Laya-unavailable fallback** - `chooseWorkerModel()` in `src/company/dispatch.ts` now
   falls back to `config.models.standard` (deepseek) with reason
   `"Laya unavailable; cost-rule default (standard)"`, where it used to fall back to
   `config.models.complex` (kimi). Escalation-only kimi no longer rides in on an outage.
   (Also landed in the same file, not one of the three: an optional per-project override,
   `WorkerModelOpts`, which is a no-op for callers that pass no opts.)

### Before / after, raw numbers

Same command both times, `npx tsx ops/laya-eval.ts` (both arms, repeat 1, 140 results).
Raw logs: `logs/laya-eval-ceo-before.txt` (10:14:43-10:15:26Z) and
`logs/laya-eval-ceo-after.txt` (10:22:50-10:23:08Z).

```
group      variant  n    acc    meanConf  meanAnsConf %conf>=0.35 %conf>=0.20 %conf>=0.10 errors
team       baseline 15   60%    0.14      0.48        7%          27%         53%         0     before
team       live     15   53%    0.10      0.44        0%          7%          47%         0     before
model      baseline 17   12%    0.11      0.55        0%          6%          47%         0     before
model      live     17   29%    0.68      0.62        100%        100%        100%        0     before
brain      baseline 6    67%    0.12      0.67        0%          17%         33%         0     before
brain      live     6    83%    0.74      0.43        100%        100%        100%        0     before

team       baseline 15   60%    0.14      0.48        7%          27%         53%         0     after
team       live     15   47%    0.10      0.44        0%          7%          47%         0     after
model      baseline 17   12%    0.11      0.55        0%          6%          47%         0     after
model      live     17   29%    0.67      0.61        100%        100%        100%        0     after
brain      baseline 6    67%    0.12      0.67        0%          17%         33%         0     after
brain      live     6    83%    0.74      0.43        100%        100%        100%        0     after
```

| group | before (live) | after (live) | after, REAL callers |
|---|---|---|---|
| team | 53% (8/15) | 47% (7/15) | **53% (8/15)** |
| model | 29% (5/17) | 29% (5/17) | 29% (5/17) |
| brain | 83% (5/6) | 83% (5/6) | 83% (5/6) |

The wording arms are the *same wording* - the fixes are caller logic, so this arm could only
move by sampling drift, and it did: team flipped by exactly one borderline case
(`team-real-research-brief`, Laya `top 0.32 lead 0.01`), agent by one the other way
(62% -> 69%), and every model confidence moved by <=0.05 (`model-real-heartbeat`
`escalate 0.57 -> 0.52`). The state handed to Laya now carries a **live cost sentence**
whose text changes as budget is spent (`budgetCostNote()`, "OpenCode Go amber (N% left);
Claude green (N% left)"), so the *input* is not frozen between runs either. A repeat-2 run of
the same after code (`logs/laya-eval-ceo-repeat2-live.txt`) reproduced 47% / 29% / 83% exactly.

The call-site change shows in the third column, which grades the shipped functions instead of
re-asking the question - `npx tsx ops/laya-eval.ts --variant live --real-functions`,
`logs/laya-eval-ceo-after-realfunctions.txt`:

```
group      n    real-caller acc harness live acc agreement
team       15   53%             47%              12/15 same answer
agent      13   69%             69%              13/13 same answer
model      17   29%             29%              17/17 same answer
brain      6    83%             83%              6/6 same answer
complexity 6    67%             67%              6/6 same answer
track      13   85%             85%              13/13 same answer
  real-caller answers that differ from the harness live arm: 3
    team/team-real-hello-livefinal: real=pmumhg71w harness=pmumhp51u
    team/team-real-eng-script:     real=pmumhg71w harness=pmumhp51u
    team/team-real-research-brief: real=pmumhp520 harness=pmumhp51u
```

Team is the only group where the shipped caller differs from Laya's own pick, and it differs on
exactly the three cases whose order names one team - the short-circuit in (1) answering
deterministically where Laya was wrong (2 of the 3 differing answers are the gold label). The
model group does not move here because the ceiling lives in `pipeline.ts`, not in
`chooseWorkerModel`; it is proven instead by `ops/laya-callsite-proof.ts`, which runs a
realistic pipeline subtask through the real `chooseWorkerModel` plus the ceiling block and
prints the trace line:

```
model chosen : deepseek-v4-flash
ceiling      : REFUSED kimi -> downgraded to the cost-rule default
trace from="Laya" to="pick: deepseek-v4-flash"
trace detail : kimi refused: no escalation justification -> deepseek-v4-flash (cost rule) | was: Laya best_worker=kimi-k2.7-code noul escalate=0.38 trivial=0.51 (>= 0.35 / 0.37) | budget go=unknown claude=green for coder-1
RAW 'noul escalate=' LINE: noul escalate=0.38 trivial=0.51 (>= 0.35 / 0.37)
```

Two honest notes on that proof, both measured. First, it is not reproducible to the last decimal:
the same UI subtask gave `escalate=0.64 trivial=0.42` on one run and `0.38 / 0.51` on the next,
and the state's budget sentence changed from `go=amber` to `go=unknown` between them - the
same live-input drift the eval showed above. Second, the control subtask that *should* stay on
deepseek did **not**: "Add exponential backoff and a retry counter to the Laya client call in
`src/decision.ts`, with a unit test for it" came back `Laya best_worker=glm-5.3-flash noul
escalate=0.15 trivial=0.57` - the cheap side, no ceiling applied. Three ad-hoc probes
(extra subtask arguments to the same script: a refactor-plus-tests subtask, a pagination
subtask, and a budget-guard refresh) gave glm 0.93, glm 0.84 and kimi 0.79 (that one refused
-> deepseek).
Across the whole after run, Laya picked **deepseek 0 times of 17**, glm 6 and kimi 11: the
question almost never lands on the configured default, so fixes (b) and (c) - the ceiling and
the honest fallback - are what actually enforce the CEO cost rule on this path. That is a
finding about the question, not about the ceiling.

### Not live yet

All of this is code on disk. The router runs `tsx src/server.ts` with no hot reload, so the
running process still enforces the old threshold, the old fallback and no ceiling until it is
restarted - a deliberate, separate action (CRASHFIX/OPS territory). `.env.example` is a
template; the active value in `.env` is whatever that file says, and today it has no
`LAYA_TEAM_MIN_CONF` line at all, so the running company still uses the `0.3` code default.
