# REPORT F13-worktree-spec: design for git worktree isolation per work order

Order: `docs/overnight/ORDER_F13-worktree-spec.md`. Documentation only, no code.

## Changed files
- `docs/WORKTREE_MODE_SPEC.md` (new, 306 lines, 15 sections). Nothing else edited.

## What the spec covers (each requirement of the order)
- Why: developers report parallel agents overwrite each other unless isolated; the fix is a `git worktree` per work
  order (research row cited from `docs/overnight/RESEARCH.md`).
- Where worktrees live: a sibling folder `FLEET_WORKTREE_ROOT` default `<dirname(repoRoot())>/_fleet-wt`, layout
  `<root>/<orderId>/<woId>`, Windows MAX_PATH 260 rules (short root, sanitised ids, a 240-char guard, `core.longpaths`).
- Branch naming: exactly the existing `fleet/<order>/<wo>` from `src/company/github.ts` -> `branchFor()`.
- Creating from the configured base: `FLEET_WORKTREE_BASE` else `prBase()` (`FLEET_GITHUB_BASE` else `main`),
  resolved `origin/<base>` then local `<base>`, refused if neither resolves.
- Worker cwd and `owns`: `launcherScript()`, `spawnWorkerWindow()`, `identifySession()` (loose `working_dir`),
  `briefBody()`, `ownedFileSnips()` all take the worktree dir; `owns` stay repo-relative; report path stays in the
  main COMPANY_ROOT.
- Publish: `publishPass()` and `republishWorkOrder()` pass the worktree dir to `publishWorkOrder()`; commit/push/PR
  run in the worktree; the main copy is never switched.
- Main working copy: untouched by the fleet; uncommitted main-copy changes are not visible to workers.
- Stale worktrees: `listWorktrees()` + `ops/fleet-worktree-list.ts` print and hint; the system NEVER deletes.
- Ports and caches: shared `:8787` etc. is unchanged by isolation; node_modules junction for read-only checks, no
  installs; `company/` state is outside the worktree.
- Disk cost: worktree = checked-out tracked files only (shared object store), node_modules via junction.
- Failure/cleanup: 10-row table (path too long, base missing, branch checked out elsewhere, half-created orphan,
  failed spawn, dead session, publish-after-push, flag flipped mid-run, `FLEET_GITHUB` off, human removes worktree).
- Env flag: `FLEET_WORKTREES=1`, default off; plus `FLEET_WORKTREE_ROOT` and `FLEET_WORKTREE_BASE`.
- Build plan: WT-1 `fleetWorktree.ts` + check, WT-2 `fleet.ts` (only order allowed to edit it) + check,
  WT-3 `fleetGithub.ts` + check, WT-4 `ops/fleet-worktree-list.ts` + check, WT-5 docs; each lists the files it owns.
- Acceptance: unit proofs on a temp repo, a real 2-worker end-to-end order with the flag on, and a default-off
  regression.

Every statement about current behaviour cites `file` -> `function()` (line). Read before writing: `docs/FLEET_SPEC.md`,
`docs/AGENT_TALK_SPEC.md`, `docs/overnight/RESEARCH.md`, `docs/FLEET_OPERATOR_GUIDE.md` (env knobs),
`src/company/fleet.ts` (config/locks, launcher 1328-1462, delivery 1477-1566, briefing 1570-1603, queue/spawn
2678-2876, review/publish 2960-3078, tick 3469-3535), `src/company/fleetGithub.ts`, `src/company/github.ts`,
`src/company/org.ts` `getCompanyRoot()`, `.gitignore`.

## Proof (one command, run once, foreground)
```
> git status --porcelain docs/WORKTREE_MODE_SPEC.md
?? docs/WORKTREE_MODE_SPEC.md
> findstr /n /r "^##" docs\WORKTREE_MODE_SPEC.md
13:## 1. Why
27:## 2. Current behaviour this design has to fit (verified)
29:### 2.1 Where a worker runs
43:### 2.2 How `owns` is used
56:### 2.3 The publish step
69:### 2.4 The report
78:### 2.5 Caps and locks
84:## 3. The mode
100:## 4. Where worktrees live
121:## 5. Branch naming, and creating from the configured base
143:## 6. Worker working directory, brief and `owns`
167:## 7. The publish step, and what happens to the main working copy
182:## 8. Listing stale worktrees (the system NEVER deletes)
193:## 9. Ports and caches
209:## 10. Disk cost
218:## 11. Failure and cleanup cases
233:## 12. Env flag
246:## 13. Build plan (narrow worker orders)
281:## 14. Acceptance test
298:## 15. Open questions for the manager
> find /c /v "" docs\WORKTREE_MODE_SPEC.md
---------- DOCS\WORKTREE_MODE_SPEC.md: 306
```

## Open issues
- The build plan's WT-5 wants to edit `docs/FLEET_OPERATOR_GUIDE.md`, which is NOT in this order's `Files` list
  (only `docs/WORKTREE_MODE_SPEC.md` was allowed here, so I did not touch it). The manager must either add that file
  to the WT-5 order or keep the env rows in the spec only.
- Two design decisions are left to the manager: whether a REDO reuses the same worktree/branch (proposed) and
  whether the `node_modules` junction is on by default (proposed) or opt-in.
- No code was written and no test was run beyond the proof above, by design: the order is documentation only. The
  realistic path-length figures depend on the operator's actual `FLEET_REPO` and should be checked on the real
  machine before WT-1 hard-codes the 240-char guard.
