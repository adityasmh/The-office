# Today's queue - remaining work as of 2026-10-01 morning

From: today-queue worker (jcode, deepseek-v4.1-flash). Repo: C:\Users\user\Desktop\Default Project
Written: 2026-10-01 ~10:10Z (15:40 local). Source: docs/AGENT_COORDINATION.md (last entries),
HANDOVER.md section 11, docs/CEO_STATUS.md, docs/FLEET_OPERATOR_GUIDE.md, company/fleet/orders.json,
company/system/paused.json + company/snapshots, docs/*.md "still open / not live / next" items.

### Notes on the sources (interpretations I had to guess at)

- The order names `docs/HANDOVER.md` section 11, but there is no `docs/HANDOVER.md` in this repo; the file is
  `HANDOVER.md` at the repo root, and its section 11 is "NEXT STEPS (remaining)". I used that. (`docs/CEO_RUNBOOK.md`
  also has a section 11, "Needs you buttons", which is a how-to, not a work list.)
- `company/system/runs.jsonl` named in the order does not exist. The real run log is `company/reports/runs.jsonl`
  (1,052,863 bytes); I read that instead.
- The order document is not in git, so nothing was committed.
- The table below is "numbered" by the R1..R8 queue ids (one row each) rather than a 1..N row counter; the columns
  are exactly the requested id | job | why not done | risk | model.

## Already done / no longer open (checked this morning, not queued)

- **Planner-fallback / sign-in fix is NOW LIVE.** The router restarted as part of today's startup:
  `BOOT pid=9444 ... 2026-10-01T10:04:49Z`, which is newer than every edit (`fleet.ts` 2026-09-30 18:16,
  `needsYouRule.ts` 18:01, `briefing.ts` 18:24, `runManagers.ts` 17:38, `budgetGuard.ts` 17:34).
  Live checks: `GET /api/needs-you` -> `{"needsYou":[]}`; `GET /api/manager-queue` -> total 4, pending 0;
  no new `[fleet] not spawning` line since boot (last one 2026-09-30T12:06:05Z).
- **Graphify knowledge injection into the pipeline is done.** `src/company/pipeline.ts` imports
  `projectContext` (line 10) and calls it (line 448). HANDOVER section 11.2 is closed.
- **Startup is done.** Startup worker report at 2026-10-01T10:06Z: Laya :8000 healthy (cuda, 3 checkpoints),
  router :8787 healthy (pid 9444), all pages 200.
- **Website outage order already in flight.** The CEO's Slack message ("the website is not loading") created
  Fleet order `fomupdchue` ("Diagnose and fix website outage", 1 work order, `awaiting_approval`) at
  2026-10-01T10:05:52Z. Not duplicated here.

## Queue table

| id | job (plain name) | why it is not done | risk | model |
|---|---|---|---|---|
| R1 | Needs-you classifier misses a failed order's own error | The probe is `headline + needsCeo` only, so a failed fleet order's own `error` (missing key / Claude limit) never reaches the `mentionsMissingKey` / `mentionsClaudeLimit` branches and falls through to generic retry/drop. Measured and reported 2026-09-30 12:39 as "worth its own work order"; never queued. | routine | deepseek-v4.1-flash |
| R2 | Provider usage panel | `src/company/usage.ts` and the exact `GET /company/provider-usage` route patch in `docs/PROVIDER_USAGE.md` exist, but the route was never added to `src/server.ts` and there is no dashboard panel. | routine | deepseek-v4.1-flash |
| R3 | ATR service agreement PDF - verify it | The CEO's 19:03 order (2026-09-30) turned the quotation into a service agreement PDF; `ATR-Quotation-Lead-Platform.pdf` was built 19:58, but nothing verified its text against the frozen 6-month numbers (`BREAKDOWN-6mo.md`). | routine | deepseek-v4.1-flash |
| R4 | Laya call-site tuning | `docs/LAYA_TUNING.md` fixed wording only. Its section "Scope" item 2 lists three call-site fixes left undone (named-team short-circuit in `chooseTeam`; missing Kimi ceiling at the pipeline call site; Kimi fallback when Laya is down) plus the recommended `LAYA_TEAM_MIN_CONF=0.20`. | routine | deepseek-v4.1-flash |
| R5 | Open + duplicate fleet orders unresolved | The shutdown paused 4 orders (`fomuo2d1hb`, `fomuo1s1p1`, `fomuo1rv2o` awaiting_approval; `fomunypg1k` reviewing) and several failed duplicates are still open (5 chat-UI copies `fomunyp01t`/`fomunyp86b`/`fomunypf44`/`fomunyphtc` done, `fomunypg1k` reviewing, `fomunypebj` failed; Engineering-pipeline dupes `fomunyxv8p`/`fomunyxo58`/`fomunypa98`/`fomunypcu4`/`fomunvwzli` failed). `fomunyxv8p.supersededBy` dangles at the cancelled `fomuo59nn1`. | routine | deepseek-v4.1-flash |
| R6 | Router still stalls on synchronous file I/O | PERF_SPEC items 1-4 are open. `saveFleetOrders()` writes a ~229 KB temp file and renames it synchronously on the event loop (0.4-4.6 s per save; a `fs.statSync` on it blocked for 5 min 26 s on 2026-09-30); `company/reports/runs.jsonl`/`sessions.jsonl` are re-read per request; `/company/panel` was 1.49 MB / 12.2 s. | routine to write + verify on dev router; loading it needs a live restart (CEO-only) | deepseek-v4.1-flash |
| R7 | Company expansion (HANDOVER section 11.3) | Add more departments/projects via the panel and per-project team config (coder count, model overrides). Not built. | routine | deepseek-v4.1-flash |

Model note: deepseek-v4.1-flash for every item. No item here has a recorded deepseek failure, so
kimi-k2.7-code is not used.

## NEEDS CEO (one plain sentence each, not queued)

1. Run the real promote to the live site: `scripts\promote.ps1 -Approved` (it has never been run for real; `release\scripts\promote.ps1` is the pre-fix copy, do not run it).
2. Restart the live `:8787` router when a verified code fix (e.g. R6) needs loading - restarting the live router is yours to do.
3. The five failed fleet orders from the 2026-09-30 sign-in incident need `claude /login` run first, then re-issue - or drop them (a login is yours).
4. Paste your `opencode.ai` session cookie into `.env` so the real OpenCode Go balance shows (BUDGET says exactly where).
5. Rotate the two exposed keys (Slack bot token, opencode gateway key) - you said "not now", but it is still owed.
6. Send the ATR service agreement PDF to the client (a message to a person is yours to send).
7. Say whether to stop Laya while you game (it holds ~2.4 GB of your GPU).
8. Decide on deleting data: the junk folders in the repo root (`%T%`, `map)`, `POLLING`, `'`, `$($_.to)`) and the zombie windows (tigress pid 16516, daisy window 31100).

## Paused work (company/system/paused.json + snapshot 2026-09-30T14-37-05-695Z)

The planned shutdown paused 8 terminals (dove, fish, lobster, mosquito, orangutan, owl, ox, ram) and 4
fleet orders. The ATR quotation/service-agreement work of the media/SEO/website terminals is covered by
R3; the fleet coder `ram`'s order is already `done` (`fomuo5fjcr`). Nothing was resumed here
("Resume all" was not clicked), per the order.

## Queued (Part 2) - Fleet order ids and outcome at 2026-10-01T10:15Z

Queued through `POST /company/fleet/orders {text, autoApprove:true}` (token read from the loopback
`/company/auth/bootstrap` and never printed). Health was up (boot pid 9444). Cap check at queue time:
free RAM ~1.97 GB (just under the 2048 MB floor) and 2 real jcode terminals, so the Fleet will start
work orders as RAM frees.

| queue id | Fleet order id | status at 10:15Z |
|---|---|---|
| R1 classifier probe | fomupdi1hb (re-issued as fomupdll58) | failed (planning) |
| R2 provider usage panel | fomupdi32g | running (2 work orders) |
| R3 ATR agreement PDF | fomupdi4my (re-issued as fomupdlnhp) | failed (planning) |
| R4 Laya call-site tuning | fomupdi68g | running (2 work orders) |
| R5 open/duplicate orders | fomupdi7td (re-issued as fomupdlpwc) | failed (planning) |
| R6 router hot-path sync I/O | fomupdi9e9 (re-issued as fomupdls8r) | failed (planning) |
| R7 company expansion | fomupdiaz6 | running (3 work orders) |

## New finding (needs its own work order) - R8

**The fleet planner sometimes returns Claude tool-call blocks instead of the plan JSON.** On 4 of 7 new
orders today the planner's output was a `<||DSML|| ... Read ...>` block (404-621 chars) rather than the
JSON object, so `planOrder` reported "the planner produced no usable work orders (The planner did not
return parseable JSON)" and the order failed. Re-issuing all 4 failed the same way, so I stopped after
two attempts per the fleet's own two-failure rule. Raw evidence: `logs/router.out.log`
`[fleet:plan:debug] {"via":"claude","detail":"claude-sonnet-5-5","textLen":404,"parsed":false}`, and the
stored `plan` for `fomupdll58` is the tool-call block. Queued as R8 -> Fleet order `fomupdq0ml`, which
failed planning the same way (further confirming the bug). The 4 superseded originals were cancelled
(`fomupdi1hb`, `fomupdi4my`, `fomupdi7td`, `fomupdi9e9` -> `cancelled/dropped`) so one order per job
remains.

### Final state at 2026-10-01T10:19Z

- Running: `fomupdi32g` (R2, 2 work orders), `fomupdi68g` (R4, 2), `fomupdiaz6` (R7, 3).
- Failed at planning, blocked by the planner bug (R8): `fomupdll58` (R1), `fomupdlnhp` (R3),
  `fomupdlpwc` (R5), `fomupdls8r` (R6). Two attempts each, then stopped.
- R8 itself (`fomupdq0ml`) also failed planning, so the planner bug cannot be fixed through the Fleet
  until it is fixed another way (it needs a code change to `planOrder`).
- The existing paused/duplicate orders (`fomuo2d1hb`, `fomuo1s1p1`, `fomuo1rv2o`, `fomunypg1k`, and the
  failed Engineering-pipeline copies) are untouched and remain R5's target.

