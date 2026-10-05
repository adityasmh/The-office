# GRAPHIFY — shared project knowledge graph

**Status:** implemented and verified 2026-09-29 (HANDOVER section 7, step 2).
**Code:** `src/company/knowledge.ts` (extractor + cache) · `ops/graphify-extract.ts` (CLI + table)
**Cache:** `company/projects/<projectId>/knowledge.json`

---

## 1. What the graph is

Every project in `company/org.json` has a `rootDir` (its repo/work folder). All agents on
that project — enhancer, manager, coders, tester, opposer, summarizer — work inside that
same tree. Before this, each agent prompt had no structural knowledge of the tree, so
agents either received nothing or re-read the source files, paying for the same code over
and over on every task.

The knowledge graph is a **single compact text digest per project** that describes that
tree: the file inventory, the top-level symbols, and the markdown headings. It is one
string, built deterministically, cached on disk, and handed to agents as project context.

It is deliberately *not* a vector index or a service. It is a file on disk that any role
can read in one call:

```ts
import { projectContext } from "./knowledge.js";
const ctx = projectContext(projectId); // <= 4000 chars, cached
```

## 2. What a digest contains

```
# PROJECT KNOWLEDGE: pmumhp51u (Platform Core)
rootDir: C:\...\company\projects\pmumhp51u\repo
extractor: builtin
files: 6  symbols: 0  headings: 7
Use this digest as project context. Read a file only if you must edit it.

## FILES
  README.md [md, 218b]
  agents/coder-1/hello-company.mjs [js, 71b]
  ...

## SYMBOLS (top-level)
  alpha.ts: alphaOne (function)
  alpha.ts: AlphaService (class)

## HEADINGS
  README.md: Run
  notes.md: Design

## ISSUES                       (only when something went wrong)
  rootDir unreadable (C:\nope): ENOENT: no such file or directory
```

| Section | Source | Notes |
|---|---|---|
| `FILES` | every file under `rootDir` | relative POSIX path, `kind`, byte size |
| `SYMBOLS` | `.ts/.js/.mjs/.cjs/...` | top-level `export`/`function`/`class`/`const`/`type` names |
| `HEADINGS` | `.md` | `#` heading text |
| `ISSUES` | extractor | missing/unreadable paths; extraction never throws |

Rules:

- **Skips** `node_modules`, `.git`, `dist`, `build`, `out`, `coverage`, `.next`, `.venv`,
  `venv`, `__pycache__`, `.turbo`, `.cache` and symlinks. Caps: 5000 files, depth 12,
  256 KB read per file for symbol scanning.
- **`kind`** is derived from the extension: `ts js md json css html py script config text image pdf lock other`.
- **Deterministic**: no timestamps and no machine-specific ordering inside the digest, so
  two extractions of an unchanged project produce a **byte-identical digest** (verified,
  sha256 below). Only `generatedAt` outside the digest changes.
- **Bounded** to 4000 chars; sections are dropped from the end with an explicit
  `[digest truncated at 4000 chars: N section(s)/row(s) omitted]` note.

## 3. How to refresh it

```powershell
cd C:\Users\user\Desktop\Default Project

# Refresh every project in company/org.json and print the table
npx tsx ops/graphify-extract.ts

# One project
npx tsx ops/graphify-extract.ts --projectId pmumhg71w

# One project + print the digest text an agent would receive
npx tsx ops/graphify-extract.ts --digest pmumhg71w

# Cache probe: is the next prompt a cache HIT or will it regenerate?
npx tsx ops/graphify-extract.ts --check pmumhg71w
```

Real output (2026-09-29):

```
graphify CLI: (not installed) — not found on PATH (no graphify executable)
extractor    : builtin walker (graphify unavailable)

project    files  symbols  headings  digest  ms  extractor
---------  -----  -------  --------  ------  --  ---------
pmumhg71w  0      0        0         235c    5   builtin
pmumhp51r  0      0        0         255c    3   builtin
pmumhp51u  6      0        7         729c    5   builtin
pmumhp51x  4      0        7         628c    4   builtin
pmumhp520  0      0        0         255c    3   builtin

cache locations:
  pmumhg71w -> C:\Users\user\Desktop\Default Project\company\projects\pmumhg71w\knowledge.json (645b)
  pmumhp51u -> C:\Users\user\Desktop\Default Project\company\projects\pmumhp51u\knowledge.json (2388b)
  ...

refreshed 5 project(s); total 20ms
```

`--check` output shape:

```
--check pmumhp51u
  digest returned : 729 chars
  before          : {"mtimeMs":1790676290124,"generatedAt":"...","digestHash":"a60e6d9cd4c9f49a",...}
  after           : {"mtimeMs":1790676696686,"generatedAt":"...","digestHash":"a60e6d9cd4c9f49a",...}
  verdict         : MISS (regenerated)
```

Exit codes: `0` clean, `1` when at least one project reported issues. Refreshing is not
required for correctness — `projectContext()` self-heals — it is how you warm the cache
and inspect what agents will read.

### Automatic refresh

You do not need a cron job. `projectContext(projectId)`:

1. walks the tree and computes a cheap signature (path + size + mtime per file);
2. compares it with the signature stored in `knowledge.json`;
3. on a match returns the cached digest; on any difference re-extracts, rewrites the
   cache, and returns the fresh digest.

So an edited file, a new file, or even a bare `touch` invalidates the cache on the next
call. If `rootDir` is missing or unreadable the caller still gets a digest, with the
failure written into its `ISSUES` section — extraction never throws.

## 4. Where the cache lives

```
company/projects/<projectId>/knowledge.json
```

File shape (`version 1`):

```jsonc
{
  "version": 1,
  "signature": "<sha256 of path+size+mtime per file>",
  "extractor": "builtin",          // or "graphify"
  "knowledge": {
    "projectId": "pmumhp51u",
    "rootDir": "C:\\...\\repo",
    "generatedAt": "2026-09-29T10:06:35.001Z",
    "fileCount": 6,
    "files":     [{ "path": "README.md", "bytes": 218, "kind": "md" }],
    "symbols":   [{ "file": "alpha.ts", "symbol": "alphaOne", "kind": "function" }],
    "headings":  [{ "file": "notes.md", "text": "Design" }],
    "digest":    "# PROJECT KNOWLEDGE: ..."
  }
}
```

The cache root follows `COMPANY_ROOT` (defaults to `./company`), so tests and probes can
point it at a scratch directory without touching the real company state.

## 5. How it saves tokens

Instead of an agent reading or being sent whole files, it reads one digest.

Measured on this repo's own `src/` tree (23 source files, the `probe-src` fixture):

| | value |
|---|---|
| scanned source | 23 files, 207,990 bytes (~52k tokens) |
| digest | 4,000 chars (~1k tokens) |
| reduction | **~52x** |

Because the digest is cached, that cost is paid once per change, not once per prompt.
Because it is deterministic, prompt prefixes stay stable across a run (friendly to prompt
caching, and reproducible when debugging "why did the agent think that?").

The tradeoff: the digest gives *shape*, not *content*. It lists
`pipeline.ts` and the symbols it exports; it does not contain their bodies. That is the
point — an agent should read a source file when it must edit it, not to discover what
exists.

## 6. graphify CLI

The real `graphify` CLI **is not installed** on this machine (see section 8). `knowledge.ts`
probes for it on every cold start:

1. `GRAPHIFY_BIN` env var, else `graphify` on `PATH` (respecting `PATHEXT`);
2. confirms it is runnable via `graphify --help`;
3. runs `graphify extract <rootDir> --json`, tolerating JSON or JSONL and several node
   shapes (`files` / `nodes` / `entries`, `{path,kind,symbol,name,text}`);
4. on **any** failure — missing, non-zero exit, timeout, unparseable output — falls back
   to the built-in walker.

The digest records which extractor ran on its `extractor:` line, and the ops table has an
`extractor` column. Installing graphify later requires no code change; the next cold
extraction simply switches to it. To force the built-in path, leave `GRAPHIFY_BIN` unset
and do not install the CLI.

## 7. Injecting the digest into agent prompts

`src/company/pipeline.ts` is owned by the coordinator, so this is the patch to apply —
**not applied here**. It is exactly 5 lines: one import, one call, and one edit to each of
the three prompt call sites (enhancer, manager, coder). Metrics/logging and gates are
untouched.

```diff
--- a/src/company/pipeline.ts
+++ b/src/company/pipeline.ts
@@ -6,6 +6,7 @@ import { runAgent, runParallel, type TaskContext, type WorkerEvent } from "./worker
 import { createTask, updateTask, getTask, type TaskRec } from "./gates.js";
 import { postAs, personaForRoute } from "../slack.js";
+import { projectContext } from "./knowledge.js";
@@ -72,6 +73,7 @@
     taskTitle: (title ?? rawRequest).slice(0, 120),
   });
+  const projectKnowledge = projectContext(projectId);
@@ -85,7 +87,7 @@
   // 1. Prompt enhancer enriches the brief.
   const enhancer = allAgents.find((a) => a.role === "prompt-enhancer") ?? allAgents[0];
-  const enhanced = await runAgent(enhancer, rawRequest, { onEvent, taskContext: taskContext() });
+  const enhanced = await runAgent(enhancer, `${projectKnowledge}\n\nREQUEST:\n${rawRequest}`, { onEvent, taskContext: taskContext() });
@@ -90,7 +92,7 @@
   // 2. Manager plans (router role).
   const manager = allAgents.find((a) => a.role === "manager") ?? enhancer;
-  const planRes = await runAgent(manager, `${rawRequest}\n\nEnhanced brief:\n${enhanced.text ?? ""}`, { onEvent, taskContext: taskContext(`Plan: ${rawRequest}`) });
+  const planRes = await runAgent(manager, `${rawRequest}\n\nEnhanced brief:\n${enhanced.text ?? ""}\n\nProject context:\n${projectKnowledge}`, { onEvent, taskContext: taskContext(`Plan: ${rawRequest}`) });
@@ -129,7 +131,7 @@
       const agent = allAgents.find((x) => x.id === a.agentId);
-      return agent ? { agent, prompt: a.subtask, taskContext: taskContext(a.subtask) } : null;
+      return agent ? { agent, prompt: `${a.subtask}\n\nProject context:\n${projectKnowledge}`, taskContext: taskContext(a.subtask) } : null;
     })
```

Line-by-line:

| # | Where | Change |
|---|---|---|
| 1 | after the `../slack.js` import | `import { projectContext } from "./knowledge.js";` |
| 2 | after the `const taskContext = ...` block | `const projectKnowledge = projectContext(projectId);` |
| 3 | enhancer `runAgent` call | prompt becomes `` `${projectKnowledge}\n\nREQUEST:\n${rawRequest}` `` |
| 4 | manager `runAgent` call | append `` `\n\nProject context:\n${projectKnowledge}` `` |
| 5 | the `parallelJobs` mapping (line ~131) | prompt becomes `` `${a.subtask}\n\nProject context:\n${projectKnowledge}` `` |

Why line 5 rather than the coder subtask on line 113: the `parallelJobs` mapping is the
single funnel through which *every* assignment reaches a worker, so editing it covers both
the Laya-parallel path and the sequential `planAssignments` path. Editing line 113 would
cover only the parallel branch.

Two things to know:

- `projectContext` is called once per task, outside the gate polling, so it adds no
  latency to the gates and does not re-run while the pipeline waits.
- It never throws, so it cannot break a run; worst case the prompt gains an `ISSUES`
  section saying the rootDir was unreadable.
- The coder prompt grows by the digest, which is extra input tokens per coder call. If
  that is ever a problem, pass a smaller budget: `projectContext(projectId, 1200)`.

## 8. Verification (2026-09-29)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean (exit 0) |
| `ops/graphify-extract.ts` typecheck | clean (exit 0) |
| Refresh all 5 real projects | table in section 3, 20ms total |
| Determinism, real project `pmumhp51u` | run1 `a60e6d9c…92146d` = run2 `a60e6d9c…92146d` |
| Determinism, controlled fixture, 3 runs | all three `8a744586…cb4edf` |
| Cache hit on unchanged project | `HIT (cache reused)`, cache mtime unchanged |
| `touch` a file in `rootDir` | `MISS (regenerated)`, new `generatedAt`, digest hash **unchanged** (content identical) |
| Add a new source file | `MISS (regenerated)`, `ce16d4d3…` -> `8a744586…`, fileCount 2 -> 3 |
| Missing `rootDir` | no throw; digest reports the ENOENT in `ISSUES`; exit code 1 |
| Project id not in org.json | no throw; digest reports `project not found in org.json`; exit code 1 |
| graphify CLI present? | **No** — `where graphify` empty, not in npm global, not in `deps/venv` |

On determinism: the digest is a pure function of the tree contents, so it is stable for a
stable tree but **changes when the tree changes** — which is the point. A run against this
repo's own live `src/` produced matching hashes back-to-back (`75991287…4d9267` twice in a
row) and a different hash ~60s later, because other agents were writing
`src/company/{agentchat,batch,budget}.ts` in between. For a stable-tree proof, use a real
project (nobody else writes to `company/projects/*/repo`) or the controlled fixture.

Known limitation: `company/final-repo` (project `pmumhg71w`) currently has only empty
`agents/coder-1|coder-2` directories, so its digest is a valid but empty inventory
(0 files, 235 chars). It will fill in as coders write files.

### Running the verification yourself

```powershell
# deterministic double extraction on a real project
npx tsx ops/graphify-extract.ts --projectId pmumhp51u | Out-Null
node -e "const c=require('./company/projects/pmumhp51u/knowledge.json');console.log(require('crypto').createHash('sha256').update(c.knowledge.digest).digest('hex'))"
npx tsx ops/graphify-extract.ts --projectId pmumhp51u | Out-Null
node -e "const c=require('./company/projects/pmumhp51u/knowledge.json');console.log(require('crypto').createHash('sha256').update(c.knowledge.digest).digest('hex'))"

# stale cache: touch a file, then probe
node -e "const fs=require('fs');fs.utimesSync('./company/projects/pmumhp51u/repo/README.md',new Date(),new Date())"
npx tsx ops/graphify-extract.ts --check pmumhp51u
```
