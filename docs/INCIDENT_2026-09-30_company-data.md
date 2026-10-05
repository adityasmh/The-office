# INCIDENT 2026-09-30 - live `company\` data reset (and `node_modules` emptied)

Author: `owl` (jcode worker, job INCIDENT-COMPANY-DATA). Written 2026-09-30 ~10:30 local.
Scope: root cause, exact loss inventory, every recovery source checked, and the restore that was applied.

**All times are local (UTC+05:30).** Nothing on `:8787` was restarted, stopped or killed during this
investigation, no file anywhere was deleted, and no secret was printed.

---

## 1. Root cause (confirmed)

**The rollback leg of `scripts/promote.ps1` ran a `robocopy /MIR` whose destination was the live
`release\`, and `release\` contains three directory junctions pointing straight at the live data
directories. Robocopy's mirror delete pass follows directory junctions, so it recursively deleted the
live targets.**

The fatal line - identical text in the copy that ran and in the working tree:

```powershell
# scripts/promote.ps1 - section "7. rollback" (line 375 in the copy that ran,
#                                      line 395 in the working-tree copy at 10:12 today)
& robocopy.exe $prev $release /MIR /NFL /NDL /NJH /NJS /NP @(Release-Xd $prev) | Out-Null
Say "  release\ restored from release-prev"
```

### Why this line destroys live data

1. `promote.ps1` itself creates the junctions it later destroys (`scripts/promote.ps1` lines 209-214 for
   the staging tree, lines 274-278 for the published release):

   ```
   link: company      -> C:\Users\user\Desktop\Default Project\company
   link: logs         -> C:\Users\user\Desktop\Default Project\logs
   link: node_modules -> C:\Users\user\Desktop\Default Project\node_modules
   ```

   So `release\company`, `release\logs`, `release\node_modules` are junctions (verified: `release\company`
   resolves to `Default Project\company`).

2. Step 2 of the script snapshots `release\` into `release-prev\` **with** `/XD` for those three
   (`Release-Xd`, line 166-172), i.e. `release-prev\` deliberately has **no** `company`, `logs` or
   `node_modules` entry. Verified: `dir release-prev` shows no `company`/`logs`/`node_modules`.

3. The rollback then mirrors `release-prev\` **back into** `release\` with `/MIR`. To `/MIR`, the three
   junctions are "EXTRA in the destination", so the delete pass removes them - and because robocopy
   follows directory reparse points unless `/XJ` is given, it deletes their **contents first**, i.e. the
   live `company\`, `logs\` and `node_modules\` trees, and only then the links.

4. The `/XD` list cannot save it: `@(Release-Xd $prev)` passes the **source** paths
   `release-prev\node_modules`, `release-prev\company`, `release-prev\logs` - all three do not exist
   (step 2 excluded them). Nothing in the command names the destination's `release\company` etc.

Note the script already documents this exact hazard for the *publish* step, and only there:
lines 266-270 explain why publish uses `/E` and not `/MIR` ("a mirror would DELETE release\node_modules,
release\company and release\logs"). The rollback leg kept the `/MIR`.

### Independent reproduction (measured, isolated sandbox)

In `%TEMP%\robtest1` (no repo paths, no live data):

```
mkdir robtest1\src                                  (empty source, mimicking release-prev)
mkdir robtest1\live\company\projects
echo REALDATA  > robtest1\live\company\org.json
echo REALDATA2 > robtest1\live\company\projects\tasks.json
mkdir robtest1\dest
mklink /J robtest1\dest\company robtest1\live\company

robocopy robtest1\src robtest1\dest /MIR /NFL /NDL /NJH /NJS /NP \
    /XD %TEMP%\robtest1\src\company /XD %TEMP%\robtest1\src\logs /XD %TEMP%\robtest1\src\node_modules
```

Robocopy output (real):

```
  *EXTRA Dir        -1  C:\Users\user\AppData\Local\Temp\robtest1\dest\company\
  *EXTRA File           12  C:\Users\user\AppData\Local\Temp\robtest1\dest\company\org.json
  *EXTRA Dir        -1  C:\Users\user\AppData\Local\Temp\robtest1\dest\company\projects\
  *EXTRA File           13  C:\Users\user\AppData\Local\Temp\robtest1\dest\company\projects\tasks.json
ROBOCOPY_RC=0
```

Result after the run: `dest\company` is gone **and the junction target `live\company` is empty** -
`org.json` and `projects\tasks.json` were destroyed. That is the incident, reproduced in 1 second.
`/XJ` alone does **not** fix it (the same measurement was repeated by another session with `/XJ` set and
the delete pass still walked the junction, which is now recorded in the fixed script's own comments at
`scripts/promote.ps1` lines 40-42).

### What actually triggered it

A promote **rehearsal** run with the failure injection switch, i.e. a run that was *designed* to
exercise the rollback:

`scripts\promote.ps1 -Approved -Port 8899 -TaskName LayaCompanyRouterSupervisor-8899 -ForceSwapFail`
(started 09:49:24; `-ForceSwapFail` points the release task at `release\ops\this-does-not-exist-on-purpose.ps1`
on purpose so the swap fails and the rollback leg runs for real).

Evidence trail (all real file content):

| evidence | content |
|---|---|
| `logs\promote.log` | `[2026-09-30T09:52:56] release\ restored from release-prev` then `[2026-09-30T09:55:59] ROLLBACK FAILED: :8899 is still down - needs a human (manager/CRASHFIX)` |
| `logs\promote-rollback-proof.txt` | the full transcript of that run: `-ForceSwapFail: the release task will be pointed at a missing script on purpose`, then `the release did NOT come up on :8899 - ROLLING BACK`, then `release\ restored from release-prev`, then `ROLLBACK FAILED` |
| `logs\promote.log` (first line) | is the 09:52:56 line - the log file itself was deleted mid-rollback and recreated by the next `Say` |
| `logs\router-8899.supervisor.log` / `.crash.log` | first entries are 09:52:58 / 09:53:04 (the rollback re-pointing the task at the working-tree supervisor) - nothing older survives |
| `logs\router.out.log` | the live router kept serving normally through 04:22:38Z (=09:52:38), i.e. prod did **not** crash or restart: the data was deleted underneath a healthy process |
| `logs\router.out.log` | at 04:23:09Z (=09:53:09) `[DEBUG readOpenNeedsYouSync] briefing: undefined` - the first read after the wipe |

### Timing: the house-shaped fingerprint of a junction walk

Robocopy walks the destination in name order and deletes as it goes, which is exactly what the
filesystem shows:

| time | what | why this order |
|---|---|---|
| 09:52:37 | live `company\` gutted | `company` is the first of the three junctions in name order |
| ~09:52:38-40 | live `logs\` gutted | `logs` sorts next |
| **09:52:56** | live `node_modules\` emptied | `node_modules` is a huge tree: ~18 s of deleting |
| 09:52:56 | `Say "release\ restored from release-prev"` | written when the mirror finally returns |

### Proof that a recursive delete walked those trees (the survivors)

Robocopy can only delete what no process holds open. Every single pre-incident file that survived is a
file some live process had open - which is positive evidence of a recursive delete, not of a "reset by
the app":

* `logs\` survivors and their holders: `router.out.log` + `router.err.log` (prod router, pid 1984 /
  pid 16704), `tts-server.out.log` + `tts-server.err.log` (`node tools\tts\server.mjs`, pid 31108),
  `laya.err.log` (laya), `router-8791.out.log` + `router-8791.err.log` (the dev router on 8791),
  `router.err.log`. Every file written by a one-shot command (`promote.log`, `promote-rehearsal4.txt`,
  `promote-smoke.*.log`, `npm-ci-restore.txt`) is only present from after 09:52.
* `company\projects\pmumhp51u\repo\vendor\agent-office\node_modules` - exactly **two** files survived the
  whole company tree: `@esbuild\win32-x64\esbuild.exe` and
  `@rollup\rollup-win32-x64-msvc\rollup.win32-x64-msvc.node`. Those two are precisely the files that are
  memory-mapped / in use right now:

  ```
  pid 34472  esbuild.exe  ...\company\projects\pmumhp51u\repo\vendor\agent-office\node_modules\@esbuild\win32-x64\esbuild.exe --service=0.28.2 --ping
  pid 35416  node  "node" ...\vendor\agent-office\node_modules\.bin\..\vite\bin\vite.js --port 5174
  ```

  Their parent directory mtimes (`@esbuild\win32-x64` = 09:00, `@rollup\rollup-win32-x64-msvc` = 09:02)
  are untouched, while every ancestor directory was modified at 09:52 - i.e. the delete descended the
  tree, removed everything deletable, and stopped only where a locked file made a directory unremovable.
* The prod router stayed up, so when it next needed `org.json` it wrote a fresh default one
  (`company\org.json`, 71 bytes, 09:52, `"name": "Local AI Company"` with `departments: []`,
  `projects: []`). That is the CEO's "1 agent, 1 department" Office page.

### Secondary finding (same script, same leg): the rollback ran a router against LIVE company data

At 09:52:58 the rollback re-pointed the `:8899` task at the **working-tree** supervisor with no
`-ChildEnv` (`logs\router-8899.supervisor.log`: `supervisor started pid=32916 root=C:\Users\user\Desktop\Default Project port=8899`),
so that throwaway-port instance booted with the **default** company root, i.e. the live `company\`.
`promote.ps1` guards against exactly this for the swap (lines 109-113 refuse a non-prod swap without
`-SwapCompanyRoot`) but the rollback path at line 398 does not. Worth fixing alongside the `/MIR`.

Status of the fix: the working-tree `scripts\promote.ps1` was already rewritten at **10:27** today
(34,493 bytes) to `/E` + `/XJ` everywhere, plus a `Remove-SafeTree` helper that refuses reparse points,
and comments at lines 40-42 / 316-317 / 419 / 550-557 documenting the measured caveat. The two comments
worth keeping an eye on are that `/XJ` alone did not stop a `/MIR` delete pass, and that rollback now
uses `/E` + an explicit reparse-safe prune instead of `/MIR`.

---

## 2. What was lost

Source of truth for "what the company was": the pre-incident snapshot at
`%T%\company` (org.json written 2026-09-29 15:35, rest of the tree 2026-09-29 19:53).

| item | what was there |
|---|---|
| **org.json** | 11,830 bytes. `name: "Laya AI Company"`. Replaced by a 71-byte shell. |
| **Departments (4)** | Executive `dmumhp51r`, Engineering `dmumhp51u`, Quality `dmumhp51x`, Research `dmumhp520` |
| **Projects (5)** | LiveFinal `pmumhg71w`, Executive Office `pmumhp51r`, Platform Core `pmumhp51u`, QA & Verification `pmumhp51x`, Applied Research `pmumhp520` (+ a legacy `projects\p-ceo`) |
| **Teams/agents per project** | one Default Team each with 6-7 agents (`manager`, `enhancer`/prompt-enhancer, `summarizer`, `opposer`, `tester`, `coder-1`, `coder-2`) and their models (`claude-sonnet-5-5`, `glm-5.3-flash`, `qwen3.8-flash`, `deepseek-v4-flash`, `kimi-k2.7-code`) |
| **Company-level agents** | `agents\assistant`, `agents\pmumhg71w__coder-1`, `agents\pmumhg71w__enhancer`, `final-repo\agents\{coder-1,coder-2}` (live tree now has only an empty `agents\assistant\workdir`) |
| **Per-project work** | `tasks.json`, `thread.jsonl`, `cost.jsonl`, `knowledge.json` for all six project dirs: `pmumhp51u` 134 KB tasks / 172 KB thread / 353 KB knowledge / 7.3 KB cost; `pmumhp51r` 91 KB / 74 KB / 3.2 KB / 3.4 KB; `pmumhp51x` 79 KB / 75 KB; `pmumhg71w` 29 KB / 25 KB; `pmumhp520` 24 KB / 28 KB; `p-ceo` cost 472 B |
| **Project repos** | `company\projects\*\repo\` trees, incl. `pmumhp51u\repo\{css,js,legacy,node_modules (~300 pkgs),graphify-out,vendor\agent-office}`, and each repo's `agents\coder-*\` workdirs |
| **Run cards / reports** | `reports\runs.jsonl` (110,916 B, 43 cards: `fleet_fomumqiplo.json`, `fleet_fomumrem6m.json`, `task_pmumhg51?*` -> `task_pmumh*_t*.json`, plus ~34 `jcode_session_*.json`), `reports\briefing.json` (13,584 B), `reports\briefing-meta.json` (4,189 B), `reports\terminals.jsonl` (7,483 B), `reports\terminals\*.md` (18 transcripts, 718 KB) |
| **Budget** | `budgets.json` (24,599 B, 2026-09-29 19:45) and the budget history/state under `company\budget\` |
| **Fleet** | `fleet\orders.json` and 4 orders with their work-order dirs + `REPORT.md`/`run.ps1`: `fomumoiq1j` (`FLEET-DOC`, `FLEET-PROBE`), `fomump2apz` (`DOC`, `PROBE`), `fomumqiplo` (`CLOSEOUT`, `PERF-PANEL`, `REAPER-ASYNC`, `UI-PREFILL`), `fomumrem6m` (`DOC-NOTE`, `UI-CARD`) |
| **Memory** | `memory\.memory-state.json`, `.graphifyignore`, `memory\decisions\` (20 `coord-*.md`), `memory\failures\` (17, incl. `run-*`), `memory\runs\` (16 `run-*.md`), `memory\imported\`, `memory\preferences\`, `memory\graphify-out\` (`graph.json`, `graph.html`, `GRAPH_REPORT.md`, `manifest.json`, AST cache) |
| **Sessions / terminals** | `sessions.jsonl` (3,618,126 B), `terminals.json` (26,806 B), `assistant.jsonl` (34,923 B), `slack-inbound.json` (293 B) |
| **uploads** | `src/company/uploads.ts` stores attachments at `<companyRoot>\uploads\<YYYY-MM-DD>\` with an `uploads\index.json`. **No `uploads\` directory exists in any surviving source** and none existed in the pre-incident snapshot either, so if any attachment was uploaded between the snapshot (2026-09-29 19:53) and the wipe (2026-09-30 09:52:37) it is gone with no recovery path - this is the one category with no copy anywhere. |
| **outside `company\`** | root `node_modules\` was emptied at 09:52:56 (restored by badger with `npm ci` at ~09:59, `logs\npm-ci-restore.txt`: `added 86 packages in 2s`) |

Live tree as found at 10:11 (copied before anything else): `company\{agents\assistant\workdir, budget\{brain-decisions,history,state}, fleet\orders.json(2 B), org.json(71 B), projects\pmumhp51u\repo\vendor\agent-office\{node_modules\{@esbuild,@rollup},packages\ui}, reports\{briefing.json,briefing-meta.json,runs.jsonl,runs\7 files}}`.

---

## 3. Recovery sources, ranked by freshness

| # | source | state | usable? |
|---|---|---|---|
| 1 | `%T%\company` (repo root, stray dir from a `-Dest "%T%\company"` cmd-ism) | org.json 9/29 15:35 (11,830 B, full), budgets.json 9/29 19:45, projects/reports/fleet/memory/agents 9/29 19:53. 747 non-node_modules files / 23.9 MB (16,892 files / 372.5 MB incl. project `node_modules`) | **YES - primary source** |
| 2 | `release\%T%\company`, `release-prev\%T%\company`, `release-staging\%T%\company` | byte-identical copies of #1 (org.json SHA-256 `15D6CE474FF03DBD...` in all four) | YES - redundant copies of #1 |
| 3 | `company\` live survivors | `budget\*` (regenerated 09:53+), `reports\*` (regenerated 10:12), the 2 locked binaries under `pmumhp51u\...\node_modules`, empty `agents\assistant\workdir` | keep as-is (newer / locked), do not overwrite |
| 4 | `logs\router.out.log` (5.8 MB) | still holds pre-incident ticks/briefings (project and agent names, counts) | YES - cross-check evidence |
| 5 | `C:\Users\user\Desktop\company-incident-2026-09-30\current-as-found\company` | the damaged state, copied at 10:11 before any restore | YES - as-found record |
| 6 | `docs\*.md` (`AGENT_COORDINATION.md` 716 KB, `CEO_STATUS.md`, `COLLECTED_INPUTS.md`, ...) | narrative context, project ids | partial |
| 7 | `C:\Users\user\.jcode\sessions\*.journal.jsonl`, `.jcode\logs\memory-events-2026-09-30.jsonl` | session journals that quote org/project data | partial, not needed for the restore |
| 8 | `dev\ops-check\company`, `dev\selftest\company` | fresh 71-byte `org.json` shells only | NO |
| 9 | Windows Recycle Bin | nothing relevant (checked); and note `robocopy` deletes bypass the Recycle Bin entirely | NO |
| 10 | Shadow copies / Previous Versions | `vssadmin list shadows` -> `Error: You don't have the correct permissions to run this command` (needs elevation); `Win32_ShadowCopy` -> none; no system restore points | NO (from this session) |
| 11 | Browser (CEO's Brave tabs, `http://127.0.0.1:8787/` and `/v2/`) | the old dashboard responses may still be in the tab/cache | not touched - REPORT ONLY, per the work order; if the tabs are still open, a screenshot is the cheapest independent record of the pre-incident Office page |
| 12 | Slack report-back copies | the bot's briefing/needs-you posts | not queried |

Note on `%T%` / `%TMPDIR%`: these are stray directories created by cmd-isms (an undefined `%T%` stays
literal in cmd, so `-Dest %T%\company` created a literal folder). They are junk, but this particular junk
is now the reason the company is recoverable at all. `%TMPDIR%` is empty.

---

## 4. Restore plan (and what was actually done)

Principle: **add-only, never delete, never overwrite a newer file**, `org.json` merged so that the
departments/projects/agents come back *and* `pmumhp51u` is kept.

1. **Stop the bleeding (done, 10:11).** Full copy of the as-found tree:
   `robocopy "Default Project\company" "Desktop\company-incident-2026-09-30\current-as-found\company" /E /COPY:DAT`
   -> `20 dirs, 16 files, 13.74 MB, 0 failed` (`backup-log.txt`).
2. **Restore the snapshot (add-only).**
   `robocopy <repo>\%T%\company company /E /XO /XJ /COPY:DAT /R:1 /W:1`
   * `/E` never deletes. `/XO` never overwrites a file that is newer in the destination (so the
     post-incident `reports\briefing.json`, `budget\*`, `runs.jsonl` stay). `/XJ` never follows a
     reparse point. Every file that only exists in the snapshot (org.json, budgets.json, sessions.jsonl,
     terminals.json, assistant.jsonl, slack-inbound.json, all of `memory\`, `fleet\*`, `reports\*`,
     `agents\*`, `projects\*`) comes back.
3. **Merge `org.json` by hand** (never blindly overwrite): take the snapshot's `departments[]` and
   `projects[]`, keep any id that exists only in the live file, and write it back as
   `company\org.json`. Today the live file is an empty shell, so the result equals the snapshot's
   4 departments / 5 projects (including `pmumhp51u`).

### Executed (real output)

```
robocopy "%T%\company" company /E /XO /XJ /COPY:DAT /R:1 /W:1
   Dirs : 2699  2679 copied  20 skipped  0 FAILED  1 extras
   Files: 16892 16883 copied  9 skipped  0 FAILED  26 extras
   Bytes: 372.45 m 358.41 m 14.03 m 0 FAILED 149.0 k

org.json merge:  snapshot: name=Laya AI Company departments=4 projects=5
                 live    : name=Local AI Company departments=0 projects=0
                 merged  : name=Laya AI Company departments=4 projects=5   (11831 bytes)
                 merged departments: Executive (dmumhp51r), Engineering (dmumhp51u), Quality (dmumhp51x), Research (dmumhp520)
                 merged projects   : LiveFinal (pmumhg71w), Executive Office (pmumhp51r), Platform Core (pmumhp51u),
                                     QA & Verification (pmumhp51x), Applied Research (pmumhp520)
                 pmumhp51u present: true   total agents: 32

add-only index merges (key-deduped, nothing live dropped):
  reports\runs.jsonl  38 -> 118 lines (+80 run cards)
  fleet\orders.json   [] -> 4 orders (fomumrem6m, fomumqiplo, fomump2apz, fomumoiq1j)
  reports\terminals.jsonl 18 -> 29 events

verification instance (fresh copy, :8872, SLACK_BRIDGE=0, working-tree src/server.ts):
  GET /health /v2/ /company/flow /company/org /company/panel /company/agents /company/runs
      /company/fleet /company/memory/status /company/budget /company/briefing   -> ALL 200
  org: name=Laya AI Company departments=4 projects=5 agents=32
  fleet.orders count = 4 ids fomumrem6m,fomumqiplo,fomump2apz,fomumoiq1j
  agents count = 33
  stopping listener pid 25316 (only this pid) -> port 8872 still listening: False
  :8787 still LISTENING 1984 (prod never touched)

npx tsc --noEmit -> exit 0
```

One nuance worth knowing: `/XO` ("never overwrite a newer file") also protected files the *post-wipe
router* had regenerated from its empty in-memory state, so `fleet\orders.json` (2-byte `[]`),
`reports\runs.jsonl` and `reports\terminals.jsonl` were left as the regenerated versions. Those three are
indexes, so they were merged add-only by key instead of overwritten (see the numbers above), and each
pre-merge file is kept next to the as-found copy.
4. **Verify on an isolated DEV instance, never on prod.** Start a router with
   `PORT=<free 8801-8899>`, `SLACK_BRIDGE=0`, `SLACK_SOCKET_MODE=0`, `HOST=127.0.0.1` and
   `COMPANY_ROOT=<a COPY of company\>`; check `/health`, `/v2/`, `/company/flow` and the org/panel
   payload for 4 departments / 5 projects; then stop that pid. Prod `:8787` is untouched. (Done twice:
   :8871 on the first copy, then :8872 on a fresh copy after the index merges - see the output block above.)
5. **Hand over the prod restart to the manager/CEO.** The running prod router (pid 1984, started 09:23)
   booted against the pre-incident in-memory org, so it may rewrite `company\org.json` from that empty
   in-memory state, and it will not show the restored company until it reloads. Per rule 6/7-10 this
   session must not restart it: the manager should make prod pick the restore up through the sanctioned
   path and confirm `/health` + the Office page afterwards.
6. Log the whole thing in `docs\AGENT_COORDINATION.md`, run `npx tsc --noEmit`, done.

### Expected end state

The CEO's Office page returns to 4 departments / 5 projects with their teams and agent rosters, the run
cards, briefings, memory notes, fleet orders and budget come back, and `pmumhp51u` (which survived) is
still there. Losses that are *not* recoverable from any source: anything written into `company\` between
the snapshot (2026-09-29 19:53) and the wipe (2026-09-30 09:52:37) that was not also copied elsewhere -
i.e. roughly the overnight window. `logs\router.out.log` is the best surviving trace of that window.

---

## 5. Recommendations (beyond the fix already made to `promote.ps1`)

1. **Never `robocopy /MIR` a tree that can contain junctions into live data.** The rewrite of
   `scripts\promote.ps1` (10:27) already does `/E` + `/XJ` + a reparse-point-refusing prune; keep the
   comment that `/XJ` alone did not stop a `/MIR` delete pass.
2. **Make the rollback honour the same guard as the swap** - it must pass `-ChildEnv COMPANY_ROOT=<temp>`
   (rule 5), or refuse to run at all, so a rehearsal rollback can never boot a router on live data.
3. **Assert before every promote/rollback that the live data dirs still exist and are non-empty**
   (`company\org.json` has departments, `logs\` is writable) and abort otherwise. A 4-line preflight
   check would have caught this at 09:52:38 instead of 10:00.
4. **Back up `company\` on a schedule** (e.g. every 15 min to a rotated copy outside the repo). The only
   reason this incident is recoverable is an accidental byproduct of a cmd typo.
5. **Clean up the stray literal-variable directories** (`%T%`, `%TMPDIR%`, `'`, `DOWN`, `map)`, `no`,
   `POLLING`, `{lagMs`, `x.sessionName`) at the repo root - they are copied into every release by the
   deploy and they are what made the recovery possible, so move `%T%\company` somewhere deliberate
   before deleting the rest.
