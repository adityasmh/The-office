# REPORT F1-OWNS: auto-fill the owned files for the PR step

Date: 2026-10-06
Order: docs/ORDER_2026-10-06_f1-owns.md
Status: DONE - all three commands pass (tsc clean, github-check 12/12, fleet-github-check 16/16).

## What changed (line ranges are the new file's numbers)

### src/company/github.ts
- L83-98: new private `unquoteGitPath(p)` - undoes git's C-style quoting for paths with spaces/exotic bytes.
- L100-120: new export `changedPaths(dir)` - `git status --porcelain --untracked-files=all`, one entry per file, renames report the destination, always forward slashes, read-only, throws only when git cannot answer.
  - Note: `--untracked-files=all` was added so an untracked directory is listed as its files, honouring "one entry per file" (plain `--porcelain` collapses it to `dir/`).

### src/company/fleetGithub.ts
- L23: import `changedPaths` from `./github.js`.
- L41: `PublishResult` success variant gains optional `derivedOwns?: string[]`.
- L75-152: new derivation block (all new exports only):
  - L77 `export const DERIVED_OWNS_CAP = 20`
  - L80 `UNSAFE_OWNED_EXTENSIONS = [".pem", ".key", ".log", ".pid"]`
  - L83-96 private `unsafeOwnedPath(p)`: drops `..`/absolute, `company/`, `logs/`, `node_modules/`, `.git/`, `.env` / `.env.*` except `.env.example`, and the unsafe extensions.
  - L99-111 `export function ownablePaths(paths)`: the removal filter, de-duped, order kept.
  - L113-118 private `mentionedIn(text, needle)`: full-word (path/file-name) match.
  - L125-152 `export function deriveOwns(workOrder, repoDir, reportText)` -> `{ owns, why }`. Never throws. Owns = changed AND named in the report, minus unsafe paths, refusing (empty `owns` + cap reason in `why`) when more than 20 qualify.
- L178-231 `publishWorkOrder`:
  - L190-196: when `owns` is empty, derive it (read report with the existing `readReport`); non-empty `owns` unchanged.
  - L198-208: dry-run logs the derived list and returns `derivedOwns`; starts no git change.
  - L210-213: live mode with nothing derivable returns `{ skipped: why }` (never a failure).
  - L225: `commitOwned` uses the effective `owns`.
  - L229-231: success log and result carry `derivedOwns`.

### ops/github-check.ts
- L15: import `changedPaths`.
- L181-208: case 10 - modified + untracked files listed (one per file), clean file absent, throws on a plain (non-repo) folder.

### ops/fleet-github-check.ts
- L235-363: cases 11-16.
  - 11: empty owns -> changed+named derived and committed; changed+unnamed left uncommitted.
  - 12: report-named but unchanged file is not derived.
  - 13: `.env`, `company/x.json`, `../outside.txt` removed even when changed + named (plus a direct filter check).
  - 14: >20 qualifying files -> empty owns with the cap reason; exactly 20 -> 20.
  - 15: non-empty owns behaves exactly as before (no `derivedOwns`, decoy not committed).
  - 16: dry-run with empty owns logs the derived list and changes nothing.

## Runs (each command run once, in the foreground)

### npx tsc --noEmit
Exit 0, no output.

### npx tsx ops/github-check.ts
```
[github] commitOwned: committed 1 owned path(s) on fleet/ord-1/wo-1 [owned.txt]
[github] push: pushed fleet/ord-1/wo-1 to origin (no force)
[github] commitOwned: DRY-RUN (FLEET_GITHUB_DRY_RUN=1) would stage 1 owned path(s) on fleet/ord-1/wo-1 [owned.txt] and commit: dry commit
[github] push: DRY-RUN (FLEET_GITHUB_DRY_RUN=1) would push fleet/ord-1/wo-1 to origin (no force)
PASS 1. ensureRepo rejects a plain folder with no git - github: C:\Users\user\AppData\Local\Temp\fleet-gh1-kq2mVm\plain is not a git working tree (fatal: not a git repository (or any of the parent directories): .git)
PASS 2. branchFor gives the expected name - branchFor("ord-1","wo-1")=fleet/ord-1/wo-1; branchFor("ord 1","wo/2")=fleet/ord-1/wo-2
PASS 3. commitOwned commits only the owned file - commit files=[owned.txt] committed=true other.txt still dirty=true
PASS 4. commitOwned refuses on main - github: refusing to commit on protected branch "main"
PASS 5. push lands the branch and leaves main unchanged - pushed=true remoteTip=8683a6ed localTip=8683a6ed main 61a5dd0c->61a5dd0c
PASS 6. dry-run: no commit, push, or state change - committed=false pushed=false head unchanged=true
PASS 7. dry-run: openDraftPr/readChecks make no network call - pr=null checks=0 fetches=0
PASS 8. token never logged (redaction holds) - no token-shaped text in log lines
PASS 9. shortSubject leaves a short title unchanged - -> "tiny title"
PASS 10. shortSubject cuts a 500-char title to at most 72 - len=72 endsWithEllipsis=true
PASS 11. currentBranch reports the branch and "" when detached; checkoutBranch switches - on=fleet/ord-1/wo-1 detached="" afterCheckoutBranch=main
PASS 12. changedPaths lists modified+untracked files (one per file, no clean ones) and throws outside a repo - changed=[newdir/untracked.txt, sub/tracked.txt] threwOnPlain=true

ALL PASS (12 checks, fetches=0)
```

### npx tsx ops/fleet-github-check.ts
```
[fleetGithub] publishWorkOrder: DRY-RUN (FLEET_GITHUB_DRY_RUN=1) would branch fleet/ord-1/wo-1, commit [seed.txt], push and open a draft PR on base main
[fleetGithub] publishWorkOrder: DRY-RUN (FLEET_GITHUB_DRY_RUN=1) would branch fleet/ord-1/wo-1, commit [seed.txt], push and open a draft PR on base main
[fleetGithub] publishWorkOrder: DRY-RUN (FLEET_GITHUB_DRY_RUN=1) would branch fleet/ord-1/wo-1, commit [seed.txt], push and open a draft PR on base fleet-orchestrator
[github] commitOwned: committed 1 owned path(s) on fleet/ord-1/wo-8 [seed.txt]
[github] push: pushed fleet/ord-1/wo-8 to origin (no force)
[github] openDraftPr: skipped: no token passed in (repo=example-org/example-repo head=fleet/ord-1/wo-8)
[fleetGithub] publishWorkOrder: branch fleet/ord-1/wo-8 pushed; draft PR (not opened: no token) on base main
[github] commitOwned: committed 1 owned path(s) on fleet/ord-1/wo-9 [seed.txt]
[github] push: pushed fleet/ord-1/wo-9 to origin (no force)
[github] openDraftPr: skipped: no token passed in (repo=example-org/example-repo head=fleet/ord-1/wo-9)
[fleetGithub] publishWorkOrder: branch fleet/ord-1/wo-9 pushed; draft PR (not opened: no token) on base main
[github] commitOwned: committed 1 owned path(s) on fleet/ord-1/wo-10 [seed.txt]
[fleetGithub] publishWorkOrder: derived owns for wo-11: [owned.txt] (derived 1 owned path(s) for wo-11: owned.txt)
[github] commitOwned: committed 1 owned path(s) on fleet/ord-1/wo-11 [owned.txt]
[github] push: pushed fleet/ord-1/wo-11 to origin (no force)
[github] openDraftPr: skipped: no token passed in (repo=example-org/example-repo head=fleet/ord-1/wo-11)
[fleetGithub] publishWorkOrder: branch fleet/ord-1/wo-11 pushed; draft PR (not opened: no token) on base main derivedOwns=[owned.txt]
[github] commitOwned: committed 1 owned path(s) on fleet/ord-1/wo-15 [seed.txt]
[github] push: pushed fleet/ord-1/wo-15 to origin (no force)
[github] openDraftPr: skipped: no token passed in (repo=example-org/example-repo head=fleet/ord-1/wo-15)
[fleetGithub] publishWorkOrder: branch fleet/ord-1/wo-15 pushed; draft PR (not opened: no token) on base main
PASS 1. 1. FLEET_GITHUB unset -> skipped and does nothing - res={"skipped":"FLEET_GITHUB is off (default)"} headSame=true branchesSame=true
PASS 2. 2. dry-run PASS -> branch fleet/ord-1/wo-1, no git/network change - res={"branch":"fleet/ord-1/wo-1","base":"main","dryRun":true} headSame=true branchesSame=true fetches=0
PASS 3. 3. publishWorkOrder never throws on a non-git repo dir - threw=false res={"skipped":"Error: github: C:\\Users\\user\\AppData\\Local\\Temp\\fleet-gh2-jWVmPL\\plain is not a git working tree (fatal: not a git repository (or any of the parent directories): .git)"}
PASS 4. 4. ciVerdict in dry-run -> PENDING - verdict=PENDING
PASS 5. 5. RED CI stub downgrades PASS -> REDO exactly once - d1={"downgraded":true,"verdict":"RED","failed":["fleet-check"]} verdict=REDO d2={"downgraded":false,"verdict":"PENDING","failed":[]}
PASS 6. 6. FLEET_GITHUB_BASE unset -> dry-run base is "main" - res={"branch":"fleet/ord-1/wo-1","base":"main","dryRun":true}
PASS 7. 7. FLEET_GITHUB_BASE=fleet-orchestrator -> dry-run base follows it - res={"branch":"fleet/ord-1/wo-1","base":"fleet-orchestrator","dryRun":true}
PASS 8. 8. live publish (no token) -> repo back on its starting branch - res={"branch":"fleet/ord-1/wo-8","base":"main","dryRun":false} backOn=main branchExists=true pushed=8a609620 fetches=0
PASS 9. 9. commit subject is at most 72 chars for a 500-char title - subjectLen=72 subject="TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT…"
PASS 10. 10. push failure -> failed:true, repo back on its starting branch - res={"skipped":"Error: github: git push failed for fleet/ord-1/wo-10: fatal: 'C:\\Users\\user\\AppData\\Local\\Temp\\fleet-gh2-jWVmPL\\does-not-exist.git' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.","failed":true,"branch":"fleet/ord-1/wo-10"} backOn=main
PASS 11. 11. empty owns -> changed+named derived+committed; changed+unnamed left uncommitted - res={"branch":"fleet/ord-1/wo-11","base":"main","dryRun":false,"derivedOwns":["owned.txt"]} committed=[owned.txt] unownedDirty=true
PASS 12. 12. a report-named file that did not change is not derived - owns=[] why=none of the 1 changed file(s) is named in the report, or all are unsafe to commit
PASS 13. 13. .env, company/x.json and ../outside.txt are removed even when changed and named - owns=[] why=none of the 3 changed file(s) is named in the report, or all are unsafe to commit filtered=[.env.example, ok.txt]
PASS 14. 14. >20 qualifying files -> empty owns with the cap reason; exactly 20 -> 20 - over=0 why=more than 20 files qualify as owned; refusing an unbounded commit list at20=20
PASS 15. 15. a non-empty owns commits exactly as before (no derivation) - res={"branch":"fleet/ord-1/wo-15","base":"main","dryRun":false} committed=[seed.txt] decoyDirty=true
PASS 16. 16. dry-run with empty owns logs the derived list and changes nothing - logged=true res={"branch":"fleet/ord-1/wo-16","base":"main","dryRun":true,"derivedOwns":["dry.txt"]} headSame=true branchesSame=true

ALL PASS (16/16 checks, fetches=0)
```

## Open issues / notes
- None blocking. No network call, no real token, no change to the real repo; every check used a temp folder and a local bare remote (`fetches=0` in both suites).
- Design choice: the safety-removal step is exposed as a second new export `ownablePaths(paths)` so the `.env` / `company/` / `../outside.txt` rules can be proven directly; `deriveOwns` calls it, so the behaviour the order asks for is unchanged.
- `changedPaths` uses `--untracked-files=all` so untracked directories are reported as files, matching "one entry per file".
- The `why` text for an empty derive is deliberately shared with the live skip reason, so `{ skipped: <the why> }` explains itself.
