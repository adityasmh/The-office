# Org hygiene (workstream Q2)

Owner: Q2 (CEO dashboard build).
Files changed: `company/org.json` (data only, via `ops/fix-org.ts`), `src/company/agentchat.ts` (one constant), `ops/fix-org.ts` (new), this doc.

Goal: the live panel must not show duplicate/near-duplicate departments. It reported 5:
`Eng`, `Executive`, `Engineering`, `Quality`, `Research` — two of them were wrong.

## 1. Stray department "Eng" -> merged into Engineering

`Eng` (`dmumhg71w`) was minted by an early manual `createProject` test. Its only project is
`pmumhg71w` "LiveFinal" (rootDir `company/final-repo`), which holds one stale test task
("create hello.txt ...", last event `coder-1 done` with an empty result) and no deliverables
on disk: `company/final-repo/` contains only `agents/coder-1` and `agents/coder-2` empty dirs.
`Engineering` (`dmumhp51u`) is the department with the real work (`README.md`,
`hello-company.mjs` in `company/projects/pmumhp51u/repo`). So "Eng" does **not** hold the only
real work, and the correct fix is the merge (rename would have left two engineering-ish
departments).

The merge, done by `ops/fix-org.ts`:

- `projects[pmumhg71w].departmentId`: `dmumhg71w` -> `dmumhp51u`
- `departments[dmumhp51u].projectIds`: `["pmumhp51u"]` -> `["pmumhp51u", "pmumhg71w"]`
- `departments` entry `dmumhg71w` "Eng" removed (it had no other projects)

Nothing else moved. Every project, team, agent, task, thread, cost entry and every file on
disk is preserved: the script writes only `company/org.json` (and only when the normalized
document actually differs), so `company/projects/**`, `company/final-repo/**`, `budgets.json`,
`sessions.jsonl` and `assistant.jsonl` are untouched.

### Before / after (departments)

Before (5):

```json
"departments": [
  { "id": "dmumhg71w", "name": "Eng",         "projectIds": ["pmumhg71w"] },
  { "id": "dmumhp51r", "name": "Executive",   "projectIds": ["pmumhp51r"] },
  { "id": "dmumhp51u", "name": "Engineering", "projectIds": ["pmumhp51u"] },
  { "id": "dmumhp51x", "name": "Quality",     "projectIds": ["pmumhp51x"] },
  { "id": "dmumhp520", "name": "Research",    "projectIds": ["pmumhp520"] }
]
```

After (4):

```json
"departments": [
  { "id": "dmumhp51r", "name": "Executive",   "projectIds": ["pmumhp51r"] },
  { "id": "dmumhp51u", "name": "Engineering", "projectIds": ["pmumhp51u", "pmumhg71w"] },
  { "id": "dmumhp51x", "name": "Quality",     "projectIds": ["pmumhp51x"] },
  { "id": "dmumhp520", "name": "Research",    "projectIds": ["pmumhp520"] }
]
```

Project change:

```diff
   {
     "id": "pmumhg71w",
     "name": "LiveFinal",
-    "departmentId": "dmumhg71w",
+    "departmentId": "dmumhp51u",
     "rootDir": "C:\\Users\\user\\Desktop\\Default Project\\company\\final-repo",
```

## 2. The assistant's "Executive" pseudo-department -> "Executive Office"

The panel showed **two** Executives because the CEO assistant registers itself under
`departmentId "d-ceo"` / `departmentName "Executive"` in `ensureAssistantAgent()`
(`src/company/agentchat.ts`). That is a code constant, not org data, so it is fixed there:

```diff
--- a/src/company/agentchat.ts
 const ASSISTANT_ID = "assistant";
 const ASSISTANT_DEPT_ID = "d-ceo";
-const ASSISTANT_DEPT_NAME = "Executive";
+const ASSISTANT_DEPT_NAME = "Executive Office";
 const ASSISTANT_PROJECT_ID = "p-ceo";
 const ASSISTANT_PROJECT_NAME = "Executive Office";
```

The id stays `d-ceo`, so nothing that keys on it changes. Dashboard result: one
`Executive` (seeded dept `dmumhp51r`, project `pmumhp51r` "Executive Office") and one
`Executive Office` (the assistant, `d-ceo`).

`d-ceo` is **not** stored in `org.json` (it is registered at runtime), so no data hack was
needed or done.

## 3. Commands

```bat
:: apply (idempotent; writes org.json only if it differs)
npx tsx ops/fix-org.ts

:: report only, never writes
npx tsx ops/fix-org.ts --dry-run

:: typecheck
npx tsc --noEmit
```

Idempotence proof (second run changes nothing):

```bat
npx tsx ops/fix-org.ts
copy /y company\org.json "%TEMP%\org-after-run1.json"
npx tsx ops/fix-org.ts
fc /b "%TEMP%\org-after-run1.json" company\org.json   :: -> "FC: no differences encountered"
```

Both post-fix runs print `== changes == none — org.json is already normalized (this run is a
no-op)` and `written: no`.

## 4. Verification output (last run)

```
mode     : apply (idempotent, writes only if org.json differs)
[merge] no stray department "Eng" (dmumhg71w) — nothing to merge
== changes == none — org.json is already normalized (this run is a no-op)
== verification ==
team agents in org.json : 32 (expected 32)
agents total (+assistant): 33 (expected 33)
departments             : 4
projects                : 5
teams                   : 5
rootDir missing on disk : none
assistant pseudo-dept   : d-ceo "Executive Office" (code constant in src/company/agentchat.ts, not stored in org.json)
problems                : none
written: no
```

- 33 agents = 32 team agents in org.json + the code-registered assistant (`listAgentsFlat().length === 33`).
- No project has a missing `rootDir` (checked with `fs.existsSync` per project rootDir):
  `final-repo` + `projects/pmumhp51r|pmumhp51u|pmumhp51x|pmumhp520/repo` all exist.
- Every `project.departmentId` resolves to a real department; no project is listed by two
  departments; no dangling/duplicate `projectIds`.
- `loadOrg()` -> `saveOrg()` round-trip rewrites `org.json` byte-identically, so future server
  saves will not re-diff the file.

## 5. Live panel without a restart

`panelData()` calls `loadOrg()` per request, so org.json edits show up on the next poll from a
server that started before the change (`curl -s http://localhost:8787/company/panel`):

```
before (server pre-dates the change): Eng, Executive, Engineering, Quality, Research
after  (same running server, next request):
  dmumhp51r Executive    (6 agents, pmumhp51r)
  dmumhp51u Engineering  (14 agents, pmumhp51u + pmumhg71w)
  dmumhp51x Quality      (6 agents, pmumhp51x)
  dmumhp520 Research     (6 agents, pmumhp520)
  visual: departments 4, projects 5, teams 5, agents 32; agents[] length 33
```

The one thing that needs a restart is the `ASSISTANT_DEPT_NAME` constant (it is compiled into
the running process). Verified in a fresh process (`npx tsx` importing `agentchat.js`):
`assistant | d-ceo | Executive Office | Executive Office`, and the `d-ceo` rollup card reads
`Executive Office` from the second panel request onward.

## 6. Known residue (not mine to fix)

1. `src/company/budget.ts` (`identityFromOrg`, ~line 180) hardcodes
   `departmentName: "Executive"` for the assistant. On the **first** dashboard request after a
   cold start, `panelData()` calls `listBudgets()` before `listAgentsFlat()`, so
   `budgets.byDepartment` shows `d-ceo / "Executive"` for exactly one frame (2 s poll) before
   agentchat's registration makes it `"Executive Office"`. Verified. Fix belongs to the
   budget.ts owner.
2. `src/company/workers.ts` (~line 84) still falls back to
   `departmentName: task?.departmentName ?? "Executive"` when a task carries no department.
   Session records written before the rename would keep the old string (historical JSONL rows
   are immutable snapshots); today there are no assistant sessions on disk, so nothing stale is
   displayed.
3. `docs/SEED_NOTES.md` still describes the pre-fix 5-department org (it is a generated record
   of the 09:44 seed run, intentionally frozen). `scripts/seed-company.ts` does not recreate
   "Eng": it only seeds when the org is empty.
