# Worktree mode: one `git worktree` per work order

Status: PROPOSED 2026-10-06 (docs only, nothing built yet). Order: `docs/overnight/ORDER_F13-worktree-spec.md`.
Research: `docs/overnight/RESEARCH.md` (parallel agents overwrite each other unless isolated; git worktrees are the
fix developers report). Env flag: **`FLEET_WORKTREES=1`**, **default off** - with the flag unset every behaviour below
is exactly today's behaviour.

How to read the citations: every claim about current behaviour names `file` -> `function()` (line). Line numbers are
the file as it stood at 2026-10-06 04:30 (+05:30) and may move; the function name is the stable reference.

---

## 1. Why

Today every fleet worker for every order runs in the SAME working copy. `repoRoot()` returns one path
(`src/company/fleet.ts` -> `repoRoot()`, line 277), the launcher sets that path as the worker's directory
(`src/company/fleet.ts` -> `launcherScript()`, line 1334: `Set-Location -LiteralPath <repo>`), and the visible
PowerShell window starts there (`src/company/fleet.ts` -> `spawnWorkerWindow()`, line 1451: `-WorkingDirectory`).
The planner is asked not to overlap `owns` between work orders and the UI warns when it does
(`src/company/fleet.ts` -> `normalizeWorkOrders()`/`done()`, lines 2038-2062), but nothing enforces it: two workers
that edit the same file, or one worker that runs `git add -A`, or a REDO that reworks while a peer still edits,
all touch the same files. The publish step then commits from that shared copy
(`src/company/fleet.ts` -> `publishPass()` line 3030 passes `repoRoot()`; `src/company/fleetGithub.ts` ->
`publishWorkOrder()` line 234+). A worktree per work order turns the `owns` discipline from a prompt into a
filesystem boundary.

## 2. Current behaviour this design has to fit (verified)

### 2.1 Where a worker runs
- One repo root: `repoRoot()` = `path.resolve(FLEET_REPO ?? process.cwd())` (`src/company/fleet.ts` -> `repoRoot()`, 277).
- The worker window is a real PowerShell process started with `-WorkingDirectory <repo>` and executes a generated
  `run.ps1` whose first line is `Set-Location -LiteralPath <repo>`
  (`src/company/fleet.ts` -> `launcherScript()`, 1328-1343; `spawnWorkerWindow()`, 1444-1462).
- The script lives at `workOrderDir(orderId, wid)/run.ps1` (`src/company/fleet.ts` -> `workOrderDir()`, 347), which
  is under the COMPANY ROOT, not the repo: `fleetRoot()` = `<getCompanyRoot()>/fleet` (`src/company/fleet.ts` ->
  `fleetRoot()`, 341), and `getCompanyRoot()` = `COMPANY_ROOT ?? <cwd>/company` resolved at import time
  (`src/company/org.ts` -> `getCompanyRoot()`, 127-132).
- The spawned jcode session is identified by process descent from the window pid
  (`src/company/fleet.ts` -> `identifySession()`, 1477-1491). The loose fallback (`FLEET_LOOSE_MATCH=1`) matches
  on the session record's `working_dir` compared to `repoRoot().toLowerCase()` (same function, 1503). A per-worktree
  directory changes that string, so the loose match must compare against the work order's own directory.

### 2.2 How `owns` is used
- The brief prints `owns` verbatim as "create/edit ONLY these paths"
  (`src/company/fleet.ts` -> `briefBody()`, 1589-1590).
- The reviewer reads snippets of the owned paths from `repoRoot()` (`src/company/fleet.ts` -> `ownedFileSnips()`,
  2969-2977). In worktree mode this MUST read the work order's worktree, or the review grades the untouched main
  copy while the real edit sits in the worktree.
- When the plan left `owns` empty it is derived from `git status --porcelain --untracked-files=all`
  (`src/company/github.ts` -> `changedPaths()`, 106-122) run in `repoDir` (`src/company/fleetGithub.ts` ->
  `deriveOwns()`, 136), so the derivation must also run in the worktree.
- Unsafe and protected paths are stripped before any commit (`src/company/fleetGithub.ts` -> `ownablePaths()`,
  103-114; `src/company/policy.ts` `isProtected`/`checkPublish` via 98 and 222). `node_modules/` is already unsafe
  (line 93), which matters for the junction option in §5.

### 2.3 The publish step
- `publishPass()` calls the publisher with `repoRoot()` (`src/company/fleet.ts` -> `publishPass()`, 3030); the tick
  calls it right after a PASS verdict (`src/company/fleet.ts`, line 3198); `republishWorkOrder()` (3061-3078) uses
  the same path for the F34 retry route.
- The publisher is `publishWorkOrder()` (`src/company/fleetGithub.ts`, 182-263): it is off unless `FLEET_GITHUB=1`,
  dry-run unless `FLEET_GITHUB_DRY_RUN=1` (`src/company/github.ts` -> `ghConfig()`, 19-24), names the branch with
  `branchFor(orderId, workOrderId)` = `fleet/<order>/<wo>` (`src/company/github.ts` -> `branchFor()`, 162-172),
  switches the copy to that branch (`ensureBranch()`, 165-172), commits ONLY the owned paths
  (`src/company/github.ts` -> `commitOwned()`, 181-207; it refuses `main`/`master`, 184), pushes without force
  (`push()`, 212-222) and opens a draft PR against `prBase()` = `FLEET_GITHUB_BASE ?? "main"`
  (`src/company/fleetGithub.ts` -> `prBase()`, 60-62). Its `finally` returns the copy to the branch it started on
  (`checkoutBranch()`, 255-261) - today that is a real branch switch of the shared main copy.

### 2.4 The report
- The worker is told to write `reportPath(orderId, wid)` (`src/company/fleet.ts` -> `briefBody()`, 1579) =
  `<COMPANY_ROOT>/fleet/<order>/<wo>/REPORT.md` (`src/company/fleet.ts` -> `reportPath()`/`workOrderDir()`, 347-352).
  The path is absolute in the brief, so it stays outside the worktree. `/company/` is gitignored
  (`.gitignore` line 11), so a fresh worktree contains no reports and needs none.
- The watcher reads that exact path to decide "reported" and re-review the new report
  (`src/company/fleet.ts` -> `reportNewerThanLastReview()`, 3459). The report location must NOT move with the
  worktree.

### 2.5 Caps and locks
- Spawns are serialized by `withSpawnLock()` (`src/company/fleet.ts`, 1055; used at 2798) and state writes by
  `withStateLock()` (2572-2574); the queue is drained by `fillSlotsNow()` (2678) and the cap is `maxSessions()`
  (270). Worktree creation must happen inside the existing spawn lock so two orders cannot race on the same parent
  folder or on shared git metadata.

## 3. The mode

`FLEET_WORKTREES=1` makes each work order run in its own `git worktree` for the whole life of the work order:

1. When `fillSlotsNow()` is about to spawn a queued work order (`src/company/fleet.ts`, 2691-2694), and the flag is
   on, it calls the new worktree module to create/reuse `<worktreeRoot>/<orderId>/<woId>` on branch
   `fleet/<orderId>/<woId>` based on the configured base.
2. The launcher script and the spawned window use the worktree path instead of `repoRoot()`; the brief still names
   the repo-relative `owns` paths and the absolute REPORT.md path under the main COMPANY_ROOT.
3. `identifySession()`'s loose fallback compares the session's `working_dir` against the worktree path.
4. The review reads owned-file snippets from the worktree.
5. The publish step runs git in the worktree, so the commit and the push come from that checkout; the main copy is
   never checked out, switched, staged or committed by the fleet.

With the flag off, steps 1-5 are the untouched current code paths.

## 4. Where worktrees live

Root: a sibling of the repo, **not inside it** - recommended `FLEET_WORKTREE_ROOT` default
`path.join(path.dirname(repoRoot()), "_fleet-wt")`. Two constraints decide this:

- Inside the repo the worktree would appear in the main copy's `git status` as an untracked directory, and the
  fleet's own `changedPaths()` (used by `deriveOwns`, `src/company/fleetGithub.ts`, 136) would start naming it.
  A sibling folder is invisible to the main copy.
- Windows path length. `C:\Users\user\Desktop\Default Project` is already deep; adding
  `\_fleet-wt\<orderId>\<woId>\` plus the deepest tracked path (`public/v2/views/...`, `src/company/...`) can pass
  MAX_PATH 260 for tools that do not use long paths. Rules:
  - keep the root name short (`_fleet-wt`) and the per-order folder to the sanitised ids
    (`sanitizeId()`, `src/company/fleet.ts`, 354: `[A-Za-z0-9._-]`, max 80);
  - the create helper refuses (records an error, work order waits for the human) when
    `worktreePath.length + longestTrackedPathLength + 12 > 240`, rather than failing later inside tsc/git;
  - the operator guide tells humans to set `git config --global core.longpaths true` once, and the module passes
    `-c core.longpaths=true` on its own `git worktree` calls so creation is not the first failure.
- One folder per WORK ORDER, laid out `<root>/<orderId>/<woId>`, so the human can map a folder back to the trace
  hop `jcode:<woId>` (`src/company/fleet.ts` -> `pushTrace`, 496) and to `company/fleet/<orderId>/<woId>/REPORT.md`.
- The folder is created by `git worktree add`, so the module never `mkdir`s a directory it will also `git add`.

## 5. Branch naming, and creating from the configured base

- The branch is exactly `branchFor(orderId, woId)` = `fleet/<order>/<wo>` (`src/company/github.ts`, 162-172). The
  worktree is created with
  `git -c core.longpaths=true worktree add -b <branch> <dir> <base>`.
  Because the worktree already has `<branch>` checked out, `publishWorkOrder()`'s `ensureBranch()`
  (`src/company/fleetGithub.ts`, 236) must not try to create it again: it fails `checkout -b` and succeeds on the
  plain `checkout <branch>` fallback inside `ensureBranch()` (165-172), which is already harmless. A one-line
  guard is still wanted (skip `ensureBranch` when `currentBranch(dir) === branch`) so the failure path never
  depends on that fallback.
- Base branch: `prBase()` (`src/company/fleetGithub.ts`, 60-62) is the existing "configured base"
  (`FLEET_GITHUB_BASE`, default `main`). The module uses `FLEET_WORKTREE_BASE` when set, else `prBase()`, else
  `main`, and resolves it off `origin/<base>` when that ref exists (`git rev-parse --verify origin/<base>`), else
  off the local `<base>`. If neither resolves, creation is refused with a plain reason - never a silent branch off
  whatever HEAD happens to be.
- `git worktree add` refuses a branch already checked out in another worktree. That is the desired behaviour for a
  concurrent duplicate: the second spawn records the git error and the work order waits. For a REDO of the SAME
  work order the helper first checks `git worktree list --porcelain`; if `<dir>` is already a registered worktree
  for `<branch>` it is REUSED (a redo is not a new branch), otherwise creation is refused and the human decides.
- The git-side name of the worktree (`worktrees/<name>` under the main `.git`) is set with
  `--no-checkout`-free plain add; the derived name is the sanitised `<orderId>-<woId>`.

## 6. Worker working directory, brief and `owns`

- `launcherScript()` (1328) and `spawnWorkerWindow()` (1444) take a `dir` (default `repoRoot()`); in worktree mode
  `dir` is the work order's worktree. Both the `Set-Location -LiteralPath` line (1334) and `-WorkingDirectory`
  (1451) use it, so the jcode session's own `working_dir` is the worktree.
- `identifySession()` (1477) takes the same `dir` for the loose fallback's `working_dir` comparison (1503). The
  precise pid-descent match (1487-1493) is unaffected.
- The brief (`briefBody()`, 1578) changes only its `REPO:` line: it prints the worktree path, and one added line
  says "this is a git worktree on branch `fleet/<order>/<wo>`; the main copy is elsewhere and is not yours to
  touch". The absolute REPORT.md path (1579) and the relative `owns` entries (1589-1590) are unchanged: `owns` stay
  REPO-RELATIVE so the same planner output works with and without the mode, and so `commitOwned()`'s `git add --`
  (181-207) resolves them against the worktree's index.
- Review: `ownedFileSnips()` (2969) takes the same `dir`, so the snippets the reviewer sees are the worktree's
  files. `changedPaths()`/`deriveOwns()` already take a `dir` (`src/company/fleetGithub.ts`, 136) and are called
  with the worktree there.
- The brief's `npx tsc --noEmit` instruction (`workerPreamble()`, 1574) needs `node_modules`. A fresh worktree has
  none. The launcher creates a Windows directory junction
  `node_modules -> <main copy>/node_modules` (`New-Item -ItemType Junction`) when the main copy has one and the
  worktree does not. This is a convenience only: it is never committed (`node_modules/` is unsafe ->
  `src/company/fleetGithub.ts`, 93) and its absence must not fail a work order (the brief says so).
- `.env` is gitignored (`.gitignore` lines 2-4) so it is absent from the worktree. If the launcher copies it, it
  uses a plain `Copy-Item` of the file and NEVER reads, prints or logs its contents (the repo-wide rule). Tests use
  temp folders and fake values only.

## 7. The publish step, and what happens to the main working copy

- `publishPass()` (3024) gains `const dir = worktreeDirFor(order, wo) ?? repoRoot()` and passes `dir` to the
  publisher (3030). `republishWorkOrder()` (3061) does the same, so the F34 retry publishes from the worktree too.
- Inside `publishWorkOrder()` everything already runs with `spawnSync("git", ["-C", dir, ...])`
  (`src/company/github.ts`, 54-63), so commit, push and PR are unchanged in shape: stage ONLY `owns`, refuse
  `main`/`master`, never force-push, return `{ skipped }` on failure (`src/company/fleetGithub.ts`, 214-262).
- The `finally`'s `checkoutBranch(dir, startBranch)` (251-261) becomes a no-op in effect: the worktree stays on its
  own `fleet/...` branch. The MAIN copy is never switched, so the side effect that today leaves the shared copy on
  a fleet branch during a publish disappears in worktree mode.
- Consequence the operator must know: uncommitted changes in the main copy are NOT visible to a worker
  (worktrees share history and the object store, not the working files). A worker that needs an uncommitted peer
  edit must get it through a commit or a `git worktree`-visible file. This is the point of the mode.
- If the fleet falls back (flag off) the old path is byte-for-byte the current one.

## 8. Listing stale worktrees (the system NEVER deletes)

- The module exposes `listWorktrees()`: parse `git worktree list --porcelain` in `repoRoot()` and map each entry to
  `{ path, branch, orderId, woId, registered, orderState }` by matching the path under the worktree root and the
  ids against `orders.json` (`loadFleetOrders()`, `src/company/fleet.ts`, 391).
- `ops/fleet-worktree-list.ts` prints one line per worktree with `orderId/woId`, the branch, the work order state
  (`reviewed`/`failed`/`done` -> stale candidates), on-disk size, and the exact command the human can run. It
  prints and exits; it never runs `git worktree remove`, `git worktree prune`, `rmdir` or any delete. Deleting is
  the human's decision alone, matching the repo rule that no worker deletes files.
- The same listing is what the acceptance test asserts on.

## 9. Ports and caches

- One worktree per work order means N copies of any file that identifies a process or a socket: a dev server,
  a TTS server, a watcher, anything that binds `:8787` or another fixed port. The worker preamble already forbids
  starting or restarting the router / another server (`src/company/fleet.ts` -> `workerPreamble()`, 1570-1575);
  worktree mode adds nothing to that rule, and the brief restates it because a separate checkout makes "I am not
  touching the live tree" feel true while the port is still shared.
- Caches: `node_modules` is shared by the junction (§6), which is fine for read-only tools (`npx tsc --noEmit`) and
  can collide for tools that write into `node_modules/.cache` from two worktrees at once. The brief says: read-only
  build checks only; no `npm install`, no `npm run build` that writes shared caches, unless the order explicitly
  owns that work.
- Per-worktree caches (`tsconfig.tsbuildinfo`, local `.cache/` outside `node_modules`) are separate by construction
  and need no design.
- The `company/` state (orders, reports, BOARD) lives at `COMPANY_ROOT` (`src/company/org.ts`, 127) outside the
  worktree, so no worktree can fork the fleet's own state.

## 10. Disk cost

- `git worktree add` does NOT copy the object database: the new folder has a `.git` FILE pointing at
  `<main>/.git/worktrees/<name>`, plus metadata there. Cost is the checked-out tracked files only (this repo: a few
  MB) per work order, not a second clone.
- `node_modules` is a junction, so it costs nothing extra; without a junction a worker would need its own install
  (hundreds of MB and minutes) - which is why the junction is the default and the brief forbids installs.
- The listing CLI (§8) shows the size so the human can judge what to remove.

## 11. Failure and cleanup cases

| Case | Behaviour |
|---|---|
| `FLEET_WORKTREES=1` but root path too long / not writable | creation refused with the exact reason in `wo.error` and a trace hop; the work order stays `queued` for the next tick, then the operator sees it in the listing |
| base branch does not resolve | refused with the reason; never branches off HEAD silently |
| branch already checked out in another worktree | refused by git; REDO reuses its own worktree instead |
| `git worktree add` fails halfway (dir left after a crash) | listing shows the orphan; the helper detects a directory that exists but is not a registered worktree and refuses (a human removes it); the system never deletes |
| spawn fails after creation | the worktree is left in place and visible in the listing; `wo.error` names it |
| session dies, no report | existing 120 s rule marks the work order `failed` (`src/company/fleet.ts` -> `tickFleet()`, 3507-3511); the worktree stays for the human |
| report written, review PASSes, publish fails after push | existing F34 retry (`republishWorkOrder()`, 3061) republishes from the worktree; never force-pushes |
| flag turned off mid-order (router reload) | already-spawned workers keep running in their worktrees; a new spawn runs in the main copy; the listing still shows the old worktrees. The mode is per-spawn, not per-order |
| `FLEET_GITHUB` off (default) | the whole mode still isolates workers; it just skips the publish step (`src/company/fleetGithub.ts`, 188) |
| worktree removed by hand while a worker runs | the worker's next git command fails, its report may still be written to the main `company/` path, the tick marks the work order `failed` on the 120 s rule |

## 12. Env flag

| Variable | Default | Meaning |
|---|---|---|
| `FLEET_WORKTREES` | unset/`0` | `1` = one git worktree per work order |
| `FLEET_WORKTREE_ROOT` | `<dirname(repoRoot())>/_fleet-wt` | where the worktrees live (sibling of the repo) |
| `FLEET_WORKTREE_BASE` | `FLEET_GITHUB_BASE`, else `main` | the branch/ref each worktree is created from |

`FLEET_WORKTREES` must be read at call time (like `ghConfig()`, `src/company/github.ts`, 19-24), not at import
time, so the router's env-reload path (`docs/ORDER_2026-10-06_f2-envreload.md`) can flip it without a restart.
Because it changes the meaning of `FLEET_REPO` for workers, it should be added to the F2 reload allow-list only
after the mode has run once live.

## 13. Build plan (narrow worker orders)

Each order owns ONLY the files listed. No new dependencies, Node built-ins only. All proofs run once, foreground,
on a temp `FLEET_REPO`/`COMPANY_ROOT` with a locally created git repo (no network, fake values, no `.env`).

- **WT-1 `src/company/fleetWorktree.ts` (new) + `ops/fleet-worktree-check.ts` (new).**
  Pure module: `worktreeRoot()`, `worktreePathFor(orderId, woId)`, `createOrReuse(order, wo, opts)` (add/reuse,
  base resolution, long-path guard, `--porcelain` reuse check), `listWorktrees(repoDir)`, `removeHint(path)` (text
  only - NEVER deletes), and `worktreeUsage()`. No import of `fleet.ts` (avoids a cycle; takes ids and paths as
  arguments). Proof: temp repo, add two worktrees, assert branches `fleet/<o>/<w1|w2>`, assert `git worktree list`
  shows both, assert reuse on the second call with the same ids, assert a too-long root is refused, assert nothing
  is deleted. Depends on nothing.
- **WT-2 `src/company/fleet.ts` (existing, the ONLY order allowed to edit it) + `ops/fleet-worktree-launch-check.ts` (new).**
  Thread a `dir` through `launcherScript()`, `spawnWorkerWindow()`, `identifySession()`, `briefBody()`,
  `ownedFileSnips()` and `publishPass()`, resolving it via WT-1 when `FLEET_WORKTREES=1`. Create the worktree
  inside the existing `withSpawnLock()` block (2798) before the window opens, record the path on the work order
  (new optional field `worktree?: string`), add the trace hop. Proof: temp repo + temp COMPANY_ROOT, a stub spawn
  that writes the launcher path, assert `run.ps1`'s `Set-Location` and the brief's `REPO:` name the worktree, and
  that `FLEET_WORKTREES` unset produces the old `repoRoot()`. Depends on WT-1.
- **WT-3 `src/company/fleetGithub.ts` (existing) + `ops/fleet-worktree-publish-check.ts` (new).**
  Skip `ensureBranch()` when the current branch already equals `branchFor(...)`; make the `finally` branch-restore
  a no-op on a worktree path; run `deriveOwns` against the passed `dir` (already does). Proof: temp repo with a
  worktree, `FLEET_GITHUB=1 FLEET_GITHUB_DRY_RUN=1`, assert the dry-run result names the right branch and that no
  git state changed; then a stub-token live path is out of scope (no network). Depends on WT-1.
- **WT-4 `ops/fleet-worktree-list.ts` (new) + `ops/worktree-list-check.ts` (new).**
  The human-facing listing from §8. Proof: temp repo with one live worktree and one orphan directory; assert the
  listing names both, marks the orphan, prints a `git worktree remove` hint, and that running the CLI changes
  nothing on disk. Depends on WT-1.
- **WT-5 `docs/FLEET_OPERATOR_GUIDE.md` (existing) + `docs/WORKTREE_MODE_SPEC.md` (this file).**
  Flip this file's status to BUILT with the real proof output, add the three env rows and the "how to remove a
  stale worktree" paragraph to the operator guide. Depends on WT-1..WT-4.

Sequencing: WT-1 first; WT-2, WT-3, WT-4 can run in parallel after it (three different files); WT-5 last, by the
manager or one worker, after the proofs exist.

## 14. Acceptance test

1. Unit/integration (WT-1..WT-4 proofs): on a throwaway git repo with a temp `COMPANY_ROOT` and
   `FLEET_WORKTREES=1`, spawn two stub work orders. Assert: two distinct worktrees exist under the temp root, each
   on `fleet/<order>/<wo>`; a file written in one is absent from the other and from the main copy; the main copy's
   branch and `git status` are unchanged; `publishWorkOrder` in dry-run names the worktree branch; the listing
   shows both plus an orphan and deletes nothing.
2. Real end-to-end (manager runs it, one small order, 2 work orders editing different files): with
   `FLEET_WORKTREES=1`, the CEO approves the plan from `#/fleet`, both workers' briefs name their own worktree,
   both reports land at the unchanged `company/fleet/<order>/<wo>/REPORT.md` paths, both PASS, the draft PRs (or
   dry-run log lines) come from the worktrees, and `git worktree list` in the main copy shows the two folders.
   Then `npx tsx ops/fleet-worktree-list.ts` prints them as removable, and the human removes them by hand.
3. Regression (default off): the same order with `FLEET_WORKTREES` unset behaves exactly as before - `run.ps1`'s
   `Set-Location` is `repoRoot()`, no `_fleet-wt` folder is created, `git worktree list` is unchanged.

Only step 2 proves the feature end to end; the unit proofs are the fast loop, not the acceptance.

## 15. Open questions for the manager

- Should worktrees be created for a REDO that reuses the same branch, or should a REDO get a fresh `-2` branch?
  The design above reuses the folder and the branch (fewer moving parts, and the branch name still matches
  `branchFor`).
- Should the junction for `node_modules` be the default, or an opt-in `FLEET_WORKTREE_LINK_MODULES=1`? The design
  above defaults it on because `npx tsc --noEmit` is in the worker preamble and a fresh checkout cannot run it.
- May `docs/FLEET_OPERATOR_GUIDE.md` be edited by WT-5 (it is not in this order's `Files` list), or should the
  env rows go into this spec only?
