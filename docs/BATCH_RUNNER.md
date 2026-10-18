# Batch runner + department demo

Two pieces, one goal: drive the whole company in parallel from plain CEO instructions, and see it happen.

| File | What it is |
| --- | --- |
| `src/company/batch.ts` | `runBatch()` — bounded-concurrency fan-out over the assistant. No HTTP, no new deps. |
| `ops/run-department-demo.ts` | The visible proof: 5 tiny real deliverables (Engineering x2, Quality, Research, Executive), a live sessions table, a per-task summary and the on-disk file listing. |
| `docs/BATCH_RUNNER.md` | This page. |

`runBatch` calls the **same** code path the dashboard's assistant console uses (`assistantMessage` in
`src/company/assistant.ts`), so a batch run and a manually typed instruction cannot drift apart.

## 1. `runBatch` (src/company/batch.ts)

```ts
import { runBatch } from "./src/company/batch.js";

const run = await runBatch(
  [
    { id: "eng", departmentName: "Engineering", text: "Create src/hello.mjs that prints the company name." },
    { id: "qa", departmentName: "Quality", text: "Write a self-check script that verifies the other deliverable exists." },
  ],
  {
    concurrency: 3,                 // default 3, clamped to 1..32
    autoRun: true,                  // false = create tasks only, do not start pipelines
    onProgress: (r) => console.log(r.id, r.dispatched),   // fires as each item LANDS
  },
);

run.results;    // BatchResult[], in INPUT order
run.startedAt;  // ISO
run.finishedAt; // ISO
run.durationMs; // number
```

```ts
type BatchItem = { id: string; text: string; departmentName?: string; label?: string };

type BatchResult = {
  id: string;
  label?: string;
  departmentName?: string;     // caller's value, else the plan's, else the reported session's
  reply?: string;              // what the assistant told the CEO
  plan?: AssistantPlanItem[];  // the tasks it decomposed the instruction into
  decisions?: string[];        // routing + budget notes (incl. "Claude 429 -> fallback")
  dispatched: Array<{ projectId: string; taskId: string; title: string; status: string }>;
  error?: string;              // per-item failure, e.g. "assistant_model_unavailable"
  startedAt: string; finishedAt: string; durationMs: number;
};
```

Guarantees:

- **Never throws for a single item.** A failing instruction becomes a `BatchResult` with `error` set; the
  other items keep running.
- **Results in input order, progress in completion order.** `onProgress` is called exactly once per item, and a
  throwing callback is caught (it can never fail the batch).
- **Bounded concurrency.** A pool of `min(concurrency, items.length)` async workers pulls from one index;
  `concurrency` is clamped to 1..32, default 3.
- **No dependencies.** It imports only `assistant.js`; no npm packages, no HTTP, no globals.

## 2. The department demo (ops/run-department-demo.ts)

```bat
npx tsx ops/run-department-demo.ts
```

From the project root. It:

1. reads `company/org.json` and resolves **Engineering, Quality, Research, Executive** the same way the
   assistant's `resolveProject()` does (`projectIds` order first), and builds 5 instructions — one per
   department plus a repeat on Engineering;
2. fires them with `runBatch(items, { concurrency: 5, autoRun: true })` **in-process** (no HTTP needed for
   this step) and prints every dispatch the moment it lands: `department -> taskId -> status (project)`;
3. polls the live router `GET http://localhost:8787/company/sessions` every 5 s and prints a table
   (running/queued counts, then role, agentId, department, status, elapsed, cost per session);
4. polls task status (`GET /company/projects/<id>/tasks`, falling back to reading `tasks.json` off disk) and
   prints every status transition until each dispatched task is `merged`/`rejected`/`failed` or the ceiling hits;
5. flags a pipeline that has not moved for `DEMO_STALL_SECONDS` (default 180) **once**, with the stuck status,
   the session row (role, agent, model, elapsed, cost, pid), the last output tail and the project thread tail,
   then moves on instead of sitting on it;
6. prints the final summary: per task the worker chain (role/agent/model/duration/cost), wall time, total cost,
   `FOUND`/`MISSING` for each expected artifact, and a recursive file listing of each project repo.

The deliverables are deliberately tiny (a 10-line script, a 5-line brief, a 250-word note) — throughput
proofs, not products. Filenames are `s2-*` so they never collide with another workstream's artifacts.

### Knobs (env, all optional)

| Variable | Default | Meaning |
| --- | --- | --- |
| `DEMO_CONCURRENCY` | `5` | Instructions in flight at once. |
| `DEMO_CEILING_MINUTES` | `12` | Hard stop for the whole run (1..60). |
| `DEMO_STALL_SECONDS` | `180` | No status change for this long ⇒ report a stall (60..3600). |
| `DEMO_NO_HTTP` | unset | `1` = never call the router; task status and sessions come from disk only. |
| `DEMO_DRY_RUN` | unset | `1` = print the plan + one live table and exit, **zero spend**. |
| `DEMO_ROUTER_URL` | `http://localhost:8787` | Router base URL. |
| `DEMO_TAG` | `s2` | Prefix for the deliverable filenames (`<TAG>-eng-throughput.mjs`, ...). Use a fresh tag to run the demo again without overwriting the previous run's artifacts. |
| `OPENCODE_TIMEOUT_SECONDS` | `540` (set by the demo if unset) | Hard kill for a stuck `opencode` child, so a demo exit leaves no orphan coders. |

Exit codes: `0` every dispatched task reached a terminal status, `1` ceiling/stall, `2` a required department is
missing from `org.json`, `3` the demo itself crashed, `4` the assistant planned nothing for every instruction.

### Reading the live table

`SRC=router` is the running server's in-memory session view; `SRC=disk` is `company/sessions.jsonl`, which also
carries the runs this script starts. The server caches sessions in memory after boot, so **sessions started by a
separate process show up under `SRC=disk` and may never appear under `SRC=router`** — that is expected, not a bug.
Task status, in contrast, is read from `tasks.json` on every request, so `/company/projects/<id>/tasks` does
reflect an external process's work.

## 3. Cost expectations

Measured on 2026-09-29 (Laya AI Company, Claude subscription rate-limited to 429, so every assistant planning
call fell back to `deepseek-v4-flash` on the gateway):

| Line item | Order of magnitude |
| --- | --- |
| Assistant planning call, per instruction | ~$0.05 (gateway fallback); subscription path is the same order, charged to the assistant budget |
| Per pipeline: prompt-enhancer (router, GLM) | ~$0.01 |
| Per pipeline: manager (router, Claude or DeepSeek fallback) | ~$0.05 |
| Per pipeline: coder/tester (`opencode`, real file edits) | ~$0.003-$0.02 parsed from opencode JSON, else the role estimate |
| Per pipeline: opposer (router) | ~$0.04 |
| Per pipeline: summarizer (router, Qwen -> fallback) | ~$0.01 |
| **One tiny task, end to end** | **~$0.08-$0.14** |
| **This 5-instruction demo** | **~$0.81 per run** (2 observed runs: $0.82 and $0.81, incl. 5 planning calls) |

Observed, 2026-09-29 (`DEMO_TAG=s2b`, all 5 pipelines run concurrently): 5 tasks dispatched in 12 s,
28 pipeline sessions, every task `merged`, wall time 4 m 12 s for the whole demo, `$0.8088` total
(`$0.2500` assistant planning + `$0.5588` pipeline workers), 0 stalls, 5/5 artifacts written to disk.

Cost is **charged per agent** against `company/budgets.json`; the assistant checks affordability before dispatch
and drops targets it cannot pay for (saying so in `decisions`). Raising `concurrency` raises peak spend rate (N
pipelines run at once), not the total per task. `DEMO_DRY_RUN=1` proves the wiring for $0.

Two caveats worth knowing before you crank the knobs:

- `budgets.json` is cached in memory per process and rewritten whole on every charge. A batch run in a second
  process (this demo) alongside the live server means the last writer wins; the demo's own spend numbers come from
  its own cache and are the reliable ones for that run.
- `org.json` is live state. The demo resolves departments and paths at startup and prints the `org.json` mtime in
  its header, so a re-routing during a run is visible in the output rather than silent.

## 4. Verification

```bat
npx tsc --noEmit
npx tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --esModuleInterop --skipLibCheck --types node ops/run-department-demo.ts
```

`tsconfig.json` has `"include": ["src"]`, so the ops script is **not** covered by the project typecheck; run the
second command whenever you touch it. Then, for the real thing:

```bat
set DEMO_DRY_RUN=1 && npx tsx ops/run-department-demo.ts   :: wiring + org mapping, no spend
npx tsx ops/run-department-demo.ts                          :: the real run (spends money)
```
