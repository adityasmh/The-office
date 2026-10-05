# REPORT 2026-10-06 F34-RETRY-STRIP

Order: `docs/ORDER_2026-10-06_f34-retry-strip.md` (retry publish button + a GitHub strip on the order view).

Files touched: `src/company/fleet.ts`, `src/server.ts`, `public/v2/views/fleet.js`, new `ops/fleet-retry-check.ts`, plus this report.
Not touched (other workers own them): `src/company/fleetGithub.ts`, `src/company/github.ts`, `src/company/envReload.ts`. No `.env`, no `company/`, no router start, no network calls, no real token.

## A. Retry publish

| file | lines | what |
| --- | --- | --- |
| `src/company/fleet.ts` | 36 | imports the existing `PublishResult` type from `fleetGithub.ts` (alongside `publishWorkOrder`, `applyCiDowngrade`) |
| `src/company/fleet.ts` | 2938-2942 | new `PublishOutcome` type: `{ok:true, prUrl?, branch?}` or `{ok:false, reason, branch?, notFound?}` |
| `src/company/fleet.ts` | 2944-2980 | `publishPass` now returns that outcome instead of `void`, and takes an optional `publisher` seam defaulting to the real `publishWorkOrder`. The tick paths are unchanged (they ignore the return). |
| `src/company/fleet.ts` | 2982-3005 | new exported `republishWorkOrder(orderId, workOrderId, publisher?)`: loads the order, refuses (`{ok:false, reason}`) unless the verdict is PASS and there is no `prUrl` (unknown order/work order returns `notFound:true`), otherwise re-runs the same `publishPass` path, persists the order, and returns `{ok:true, prUrl?, branch?}` or the failure reason. |
| `src/server.ts` | 41, 1515-1522 | `POST /company/fleet/orders/:id/work/:wid/publish`, next to the existing fleet routes (so it sits behind the same `/company` guard), returning the result and `404` when `notFound`. |

The retry reuses an existing branch rather than re-creating it (`publishWorkOrder` -> `ensureBranch` -> `git checkout -b` then `git checkout <branch>`) and pushes without a force flag; check 9 below exercises exactly that on a local bare remote.

## B. CI state

| file | lines | what |
| --- | --- | --- |
| `src/company/fleet.ts` | 89-94 | optional `ciState?: "RED" \| "GREEN" \| "PENDING"` and `ciCheckedAt?: string` on `WorkOrder` |
| `src/company/fleet.ts` | 3461-3465 | in the tick, inside the existing CI block (`3458`: `if (wo.state === "reviewed" && wo.verdict === "PASS" && wo.prUrl && !wo.ciDowngraded)`), the verdict that block's `applyCiDowngrade` call already computed is stored in `ciState`, with `ciCheckedAt = nowIso()`. No new call, no new network read; when the block does not run the fields stay unset. |

## C. Dashboard strip

`public/v2/views/fleet.js`:

- `16` - the new publish route added to the contract comment.
- `730` - `publishingWid` busy state.
- `1132-1179` - `githubHopsFor` / `ciWords` / `githubStripHtml`: one compact line per work order (branch, PR link with `target="_blank"` + "draft", `checks: passing / failing / not reported yet`, plus the check time); when the last GitHub hop for that work order is `PR publish failed`, the reason in plain words and a **Retry publish** button. Returns `""` for a work order with no branch and no GitHub hop.
- `1208` - the strip rendered in the work-order (Workers column) card.
- `1614-1660` - `retryPublish`: `window.confirm` first, busy button ("Publishing…", disabled), then the POST; a refusal (`{ok:false}`) or an HTTP error is shown in plain words and the detail refreshes afterwards.
- `1807-1810` - click routing for `data-act="publish"`.

The order trace is order-level, so a hop is attributed to a work order by the branch name inside its detail (the fallback is "all GitHub hops" when the work order has a branch but no matching hop).

## Command 1: `npx tsc --noEmit`

```
(no output; exit 0)
```

## Command 2: `npx tsx ops/fleet-retry-check.ts`

Run twice. The first run failed on a bug in the harness fixture itself (the live-publish fixture had no uncommitted change to the owned path, so the very first publish had nothing to commit); the fixture was fixed and the command re-run once. The first run's only failures were:

```
FAIL 8. a live publish on a local remote makes the branch, pushes it and returns to main - out={"ok":false,"reason":"Error: github: git commit failed: On branch fleet/foReal/wo-real\nnothing to commit, working tree clean","branch":"fleet/foReal/wo-real"} ...
FAIL 9. the retry on an existing branch is safe: branch reused, never force-pushed, no crash - ... remoteIntact=false
```

Exact output of the final run (all checks pass, exit 0; temp root differs per run):

```
PASS 1. republishWorkOrder refuses a non-PASS verdict and a work order that already has a prUrl - nopass={"ok":false,"reason":"verdict is REDO, not PASS"} haspr={"ok":false,"reason":"this work order already has a pull request"}
PASS 2. an unknown order or work order returns notFound (the route's 404) - missingWo={"ok":false,"notFound":true,"reason":"no work order wo-nope on order foRetryRefuse"} missingOrder={"ok":false,"notFound":true,"reason":"no work order wo-ok on order no-such-order"}
PASS 3. a stubbed publish that succeeds stores prUrl and branch and adds one trace step - out={"ok":true,"branch":"fleet/foRetryRefuse/wo-ok","prUrl":"https://github.com/example-org/example-repo/pull/42"} woBranch=fleet/foRetryRefuse/wo-ok hop={"ts":"2026-10-05T21:38:56.293Z","from":"Fleet","to":"GitHub","what":"draft PR","detail":"fleet/foRetryRefuse/wo-ok https://github.com/example-org/example-repo/pull/42"} secondCall={"ok":false,"reason":"this work order already has a pull request"}
PASS 4. a stubbed publish that fails again returns the reason, opens nothing and does not crash - fail={"ok":false,"reason":"github: git push failed for fleet/foRetryFail/wo-fail (403)","branch":"fleet/foRetryFail/wo-fail"} verdict=PASS prUrl=undefined hop={"ts":"2026-10-05T21:38:56.295Z","from":"Fleet","to":"GitHub","what":"PR publish failed","detail":"github: git push failed for fleet/foRetryFail/wo-fail (403)"} skip={"ok":false,"reason":"FLEET_GITHUB is off (default)"} plainWoUnchanged=true
PASS 5. the tick stores ciState RED / GREEN / PENDING from the stubbed CI result - tick={"advanced":1,"reviewed":0,"orders":7} RED="RED"@2026-10-05T21:38:56.298Z "GREEN"@2026-10-05T21:38:56.370Z "PENDING"@2026-10-05T21:38:56.371Z
PASS 6. the tick writes nothing for a work order with no PR (and made no other fetch) - noPr=undefined/undefined stubFetches=3 strayFetches=0
PASS 7. the RED result still downgrades the PASS to REDO exactly once (the same check) - verdict=REDO ciDowngraded=true
[github] commitOwned: committed 1 owned path(s) on fleet/foReal/wo-real [seed.txt]
[github] push: pushed fleet/foReal/wo-real to origin (no force)
[github] openDraftPr: skipped: no token passed in (repo=example-org/example-repo head=fleet/foReal/wo-real)
[fleetGithub] publishWorkOrder: branch fleet/foReal/wo-real pushed; draft PR (not opened: no token) on base main
PASS 8. a live publish on a local remote makes the branch, commits the owned change, pushes it and returns to main - out={"ok":true,"branch":"fleet/foReal/wo-real"} local=5a12afe5 remote=5a12afe5 committed="seed v2 (the work)" backOn=main
PASS 9. the retry on an existing branch reuses it, never force-pushes and does not crash (the empty-commit stop is the NOTE below) - retry={"ok":false,"reason":"Error: github: git commit failed: On branch fleet/foReal/wo-real\nYour branch is up to date with 'origin/fleet/foReal/wo-real'.\n\nnothing to commit, working tree clean","branch":"fleet/foReal/wo-real"} headSame=true remoteIntact=true
NOTE OPEN ISSUE (not mine to fix: src/company/github.ts commitOwned, another worker's file) - with the branch already carrying the work, the retry stops at git's empty commit: "Error: github: git commit failed: On branch fleet/foReal/wo-real\nYour branch is up to date with 'origin/fleet/foReal/wo-real'.\n\nnothing to commit, working tree clean". publishing needs commitOwned to treat "nothing to commit" as committed:false instead of throwing

[fleet-retry] ALL CHECKS PASSED (9 checks, stubFetches=3, strayFetches=0, temp C:\Users\user\AppData\Local\Temp\fleet-retry-WWhPJI)
```

The harness sets a temp `COMPANY_ROOT`/`FLEET_REPO`, has no real token and no router; the only `fetch` is a stub that answers the check-runs URL for three fixtures (RED / GREEN / PENDING), and any other fetch throws and is counted as a stray fetch (`strayFetches=0`). Stubbed publishes are injected through `republishWorkOrder`'s `publisher` seam.

## Open issues

1. **The retry does not finish the job when the branch already carries the work** (measured above, check 9 + NOTE). Requirement A's last line ("must work even if the branch already exists on the remote and in the local repo") holds for the branch itself: it is reused, never force-pushed, and the order is never corrupted. But the retry runs the *same* publish path, and that path always commits first, so on the exact case this order names (the PR call failed after the push, the branch already has the commit) `commitOwned` hits `git commit` with nothing staged and the publish ends as `{ok:false, reason:"github: git commit failed: ... nothing to commit, working tree clean"}`. The one-line fix is in `commitOwned` (`src/company/github.ts`, another worker's file right now): treat "nothing to commit" as `{committed:false}` instead of throwing, so the retry falls through to `push` (up to date, no force) and `openDraftPr`. I did not make that edit because the order forbids touching `github.ts`; with the push step's `push()` unchanged, the CEO still gets a plain-words failure from the route in the meantime.
2. The route itself is not exercised by the proof (no router may be started), so it is verified by `tsc` plus the existing route pattern it copies; the `404` path is proven at the function level via `notFound`.
3. The GitHub strip attributes order-level trace hops to a work order by the branch name in the hop detail, and falls back to the last GitHub hop when the work order has a branch but no hop matches. A work order with neither a branch nor a hop renders nothing (as required).
4. The tick only refreshes `ciState` while a work order is PASS + has a `prUrl` + is not yet `ciDowngraded`; after a RED downgrade the stored `RED` stays on the strip (verdict is REDO by then), and no second CI read happens. This matches "when it does not run, leave them unset".
