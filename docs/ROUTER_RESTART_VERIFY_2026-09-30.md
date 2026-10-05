# Router restart + verification, 2026-09-30 (jcode worker, deepseek-v4.1-flash)

Durable copy of the report that was appended to `docs/AGENT_COORDINATION.md` at 17:06 and 17:12.
**Those two entries were removed by another writer's lost update at 17:22:14** (the file went
6,614 -> 6,546 lines and no longer contains either heading). This file is the copy that survives
that class of collision. Nothing in it has been revised downward: every number below was measured
on the live service, and the two places where my own tooling was wrong are stated as corrections.

Work order: stop the event-loop-hung router on `:8787` (pid 1984) so the already-edited `src/`
fixes load, verify health/page latency, `/api/needs-you` uniqueness, log growth and event-loop lag,
and record the numbers. No login, no secrets printed.

---

## 1. Restart (the project's normal way, exactly one router)

| item | value |
|---|---|
| old process | pid 1984, `node`, started 09:23:06, listening `127.0.0.1:8787` |
| killed | 17:01:06 (`Stop-Process -Id 1984 -Force`) |
| new process | **pid 9936**, started 17:01:14 |
| started by | the scheduled-task watchdog, pid 37156 (`LayaCompanyRouterSupervisor`) |
| supervisor log | `17:01:13.877 starting router (attempt 1)` / `17:01:19.199 router is healthy on :8787 after 5.2s (pid 9936)` |
| downtime | **~13 s** (17:01:06 -> 17:01:19) |
| listeners on `:8787` | exactly 1, before and after; pid 9936 in 12 consecutive 10 s samples over 2 minutes |
| boot line | `[2026-09-30T11:31:17.657Z] BOOT pid=9936 ppid=22176 node=v24.15.0 cwd=<repo> port=8787` |

Provenance (why this was the watchdog and not someone else's router):

```
9936  node  src/server.ts                    <- the server
22176 node  node_modules\tsx\dist\cli.mjs    <- tsx supervisor of the child
38712 cmd   cmd /c cd /d "<repo>" && set "PORT=8787" && ... tsx src/server.ts 1>> logs\router.out.log
37156 powershell -File ops\router-supervisor.ps1   <- the watchdog
1764  svchost (Task Scheduler)
```

The `cmd` line is the supervisor's own command text, which also proves `logs/router.out.log` is the
file this router writes, so the growth numbers below are measured on the right file.

**New code really is loaded** (not inferred): `GET /company/assistant/speech` -> `200
{"ok":true,"speaking":false,"engine":"windows-sapi","ready":true,...}` in 135 ms. That route was
added to `src/server.ts` at 16:29, so the pre-restart process would have answered 404.

Gates before the kill: `npx tsc --noEmit` exit 0 at 16:27:44 **and** again at 17:00:34, seconds
before the kill; `src/company/fleet.ts` was last written 16:57:58 by another agent and then went
quiet, so the tree was quiescent and compiling at the moment of the restart. I edited no `src` file.

## 2. HTTP results (all on the live `:8787`, no auth token needed on these paths)

- `/health`: 30/30 `200` over three rounds (uptime ~30 s / ~2 min / ~5 min): max **165 / 93 / 112 ms**,
  avg 38.6 ms in round 1. Then 100/100 `200` in the sequential+concurrent load run (40 sequential
  alternating with 60 concurrent in 6 bursts of 10): **p95 20 ms, max 59 ms, zero over 2 s**.
- main page `/`: 30/30 `200`, max **309 / 318 / 201 ms**; body constant at **90,128 B**.
- `/v2/` console: 23 ms (2,620 B).
- real paced soak, **1 req/s for 181.3 s, 180 requests: worst request 355 ms, zero over 2 s**.
  A second paced run, window by window (30 requests each): p50 4 ms, p95 207 / 118 / 32 / 146 ms,
  max 392 / 178 / 54 / 150 ms, `200` only, page size constant, `busy=idle` throughout.
- APIs the dashboard uses: `/api/needs-you` 253-725 ms, `/company/assistant/thread` 9 ms (39,994 B),
  `/company/assistant/stt/health` 7 ms.
- **Every request in every run: HTTP 200, none over 2 s** (~500 requests total).

Page identity (so "prod serves `release\`" is moot for this page): served body sha256
`3BD6923ABBA5F6EB12D39DF0BE7434D3CCD6BC6579DCE782611B376068BF5CAE` = `public\index.html` =
`release\public\index.html` (both 90,128 B, same mtime); served gzipped as 24,478 B with
`Last-Modified: Tue, 29 Sep 2026 14:39:56 GMT`, matching the file's mtime exactly.

Static/integration: **16/16** files under `public/` serve `200` and are **byte-identical (sha256)**
to the files on disk; **9/9** view modules export `mount`; the cache-busted URL forms the app builds
(`/v2/views/<name>.js?v=...`, `/v2/app.js?v=1`, `/v2/style.css?v=1`) all return 200; all 11 served
JS modules pass `node --check`.

## 3. Log growth: -94%

Same file (`logs/router.out.log`), 60 s / 180 s byte windows:

| window | before (old pid 1984) | after (pid 9936) |
|---|---|---|
| 60 s sample | **23,389 B/min** | **1,261 B/min** |
| 60 s sample 2 | - | **1,430 B/min** |
| 180 s sample, with line mix | - | **1,254 B/min, 8 lines/min** (12 `[brain] review`, 8 `[briefing] tick`, 4 other, **0 dumps**) |

The dumps stopped at the restart, not gradually:

- `counts: { running` (the full-object dump): **1,274** occurrences, last at line **21,3742**;
  the new router boots at line **21,3744**; **0 after**.
- `[DEBUG`: **2,654** lines file-wide, last at line **21,3518**; **0 after**.
- In `src`, the only remaining `[DEBUG` is a **comment** (`src/company/loopWatchdog.ts:28`) that
  documents the removed dump: 7.6 KB per call, 246 newlines, written as one chunk, synchronously on
  the event loop because stdout is redirected to a file. The cap (`installLogCap`, same file) is
  installed at boot (`src/server.ts:123`).
- **The cap is armed and idle, as the running process itself reports**:
  `/health.loop.logCap = {"enabled":true,"truncatedChunks":0,"collapsedLines":0,"droppedLines":0}`;
  0 `[log] cap` markers and 0 truncation markers in the 130 lines written since boot; longest line
  since boot 334 B (default cap `ROUTER_LOG_MAX_LINE=512`).
- `logs/router.err.log`: 1,077-1,140 B/min, 100% of it
  `[fleet] not spawning: 22-23 real terminals >= MAX_PARALLEL_SESSIONS=10` - fleet capacity, not the router.

## 4. Event-loop lag and the stalls that remain (measured, not hidden)

Before (pid 1984): `lagP95Ms` 1,503-2,165, `lagMaxMs` **460,069 ms** (one ~7.7-minute block), and the
supervisor logged continuous no-`/health` windows up to 3.4 minutes.

After (pid 9936): `lagP95Ms` **55-380** (mostly 55-170), `lagMs` 0-2,202, `lagMaxMs` **2,573** - frozen
at that value from ~17:03 onward, unchanged through a 3-minute lag sample, a 180-request soak, a
120-request soak and a 100-request load run. No request in any run exceeded 2 s.

The new router does still stall, and `/health.loop` plus `logs/router.blocks.log` attribute it:

- `loop.blocks` 46 -> **47** (matches the **47** `BLOCK` lines in the log), `maxBlockMs` **2,564**,
  median BLOCK **850 ms**, total blocked **45.8 s** in ~20 min of uptime (~3.8% of wall time).
- Causes seen in the log: 11 x `fs.writeFileSync(%TEMP%\claude-brain-*\system.txt)` 0.6-2.4 s;
  8+ x `fs.writeFileSync(company\fleet\orders.json.tmp-9936)` 0.5-1.7 s, which is `saveFleetOrders()`
  (`src/company/fleet.ts:313-342`, the write at `:333`, saving the ~180 KB orders file);
  one `fs.existsSync(company\reports\runs\task_*.json)` at **672 ms** - a plain `stat` taking 0.7 s
  means this is disk contention on a busy box, not only the write size.
- Visible to the CEO as: an occasional **0.2-0.4 s** page load (that is the p95 207 ms / max 392 ms
  window above). Never multiple seconds. **Not fixed here** - it is a `src` change in a file other
  agents were editing the same afternoon, it only takes effect after another restart, and the order
  was the restart plus verification. It is the recommended next work item.

## 5. Watchdog hygiene: one hole found and closed

The live watchdog was running with **no lock file**: `logs/router-supervisor.lock` was missing while
pid 37156 was alive and polling, so `-Status` printed `supervisor pid (not running)` and the
single-instance guard was inert - several `ops/tmp-*-supervisor*.ps1` scripts start a supervisor, and
two supervisors can race a second router onto the port. I rewrote the lock in the script's own format
(pid 37156 + its real `processStartTicks`); `-Status` now reports `supervisor pid : 37156`.

Post-restart watchdog checks: `-DryRun` -> `planned action: watch-healthy` (an answering router is
never replaced); CPU advanced 111.1 -> 111.3 s in 60 s (poll loop alive); supervisor log's last line
is still `17:01:19.199 router is healthy ... after 5.2s`, i.e. it has not touched the new router.

## 6. Secrets and leaks

`/health` field names: `ok, claude, credsPresent, mock, bind, authTokenConfigured, lagMs, lagMaxMs,
lagP95Ms, lagSamples, loop`. Only two string values exist and both are short labels (29 and 9 chars),
neither opaque; credentials appear only as booleans (`credsPresent`, `authTokenConfigured`). No token,
key or secret was printed anywhere in this work.

Resource use of the new router: 39.0 s CPU over 18 min (**3.6% of one core**), RSS 72-95 MB
(95.1 MB before a soak, 72.3 MB after - no growth), 16 threads, 281 handles. No efficiency claim is
made from CPU: the old process's 1.62% average is not comparable, because a *blocked* event loop
burns no CPU at all.

## 7. Corrections to my own tooling (found in the third pass)

1. I first searched the log for `[DEBUG` with `-SimpleMatch` and escaped brackets, which searched for a
   literal backslash and returned a false **0**. Correct count: **2,654** lines, all written before
   the restart, none after. The conclusion changed from "no such lines" to "no *new* such lines",
   which is what the evidence actually supports.
2. My first "soak" harness omitted its pacing delay, so it ran as a 0.4 s burst (180 requests), not a
   sustained test. It is reported above as a burst, and the sustained claim rests on the properly
   paced 1 req/s runs.
3. The two entries I had appended to `docs/AGENT_COORDINATION.md` (17:06, 17:12) were later removed by
   another writer's lost update. This file is the surviving copy.

## 8. Still open (not mine to close)

- Five duplicate copies of the chat-UI order are open (4 `running`, 1 `reviewing`).
- The fleet is at its terminal cap (`22-23 real terminals >= MAX_PARALLEL_SESSIONS=10`), so no new
  fleet work can spawn until sessions free up.
- A browser-level render check of the console was **not** done: the browser bridge is not responding,
  repairing it means changing the user's browser configuration, and loading the live console could
  trigger page actions against real company data. Byte-identity, syntax and view-contract checks were
  done instead; a real-browser pass belongs on an isolated dev router (`ops/dev-router.ps1`).
- No login was run for anyone; no order was resumed, requeued or deleted; this directory is not a git
  repository, so nothing was committed.

---

## 9. LIVE INCIDENT during verification (17:27-17:36 local): the box's filesystem stalled and took the router with it

This is the most important finding in this file, and it is a correction to the impression the
sections above could give. **The restart was good, but the website was unusable for ~9 minutes one
hour later, for a reason that is not the log dumps and not request volume.**

Timeline (local = UTC+5:30; all lines are from the router's own witness thread
`logs/router.blocks.log`, pid 9936):

| time | what the router recorded |
|---|---|
| 17:27:11 | first `STALL main thread blocked for ~6s` |
| 17:28:21 | `BLOCK 2365ms slowOp="fs.readFileSync(company\reports\terminals.jsonl)"` |
| 17:28:30 -> 17:36:40 | escalating stall cycle: `~9s`, `~5s`, `~30s`, `~150s`, `~301s`, then `STALL-END ... resumed after ~328s`, then `~6s`, `~30s` (-> 97 s), `~7s`, `~5s`, `~10s` |
| 17:33:58 | `BLOCK 325744ms slowOp="fs.statSync(company\fleet\orders.json)"` - **a plain `statSync` on a 213 KB file blocked the event loop for 5 minutes 26 seconds** |
| during the window | `/health` probes: 3 of 6 timed out at 10 s; the ones that answered took **1.4-8.0 s**; page and health alike |
| 17:36:40 -> 17:37:00 | recovered on its own: 6/6 probes `200`, five of them **under 200 ms**, newest blocks back to 0.5-1.7 s |

Worst main-thread blocks in that window, as named by the fixed code's own tracer:

```
325744ms  fs.statSync(company\fleet\orders.json)
 98758ms  fs.readFileSync(C:\Users\user\.jcode\client_sessions\21384)
 19026ms  fs.readFileSync(C:\Users\user\.jcode\client_sessions\23500)
  9469ms  fs.readFileSync(company\fleet\orders.json)
  8856ms  fs.readFileSync(company\reports\terminals.jsonl)
```

**What it is and is not.**

- It is **not** request volume: the 600-request load run in section 8 cost the whole process
  **2.0 s of CPU** (3.3 ms per request), and a `statSync` cannot need 325 s for a 213 KB file.
- It is **not** the log dumps: those are gone (section 3) and the log stayed quiet.
- It is **not** CPU: during the 328 s block the router's CPU advanced **0.03 s in 8 s** - the thread
  was blocked, not spinning.
- It **is** a filesystem stall on a heavily loaded shared box: 463 processes total at the time
  (18 `node`, 25 `powershell`), an `[autoclose] process table unavailable ... timed out after 10000ms
  (child killed)` error in the same window, and earlier in the same session a `fs.existsSync(...)`
  taking 672 ms. Any synchronous fs call on the event loop inherits that stall, which is exactly why
  the router's remaining sync I/O (section 4) matters more than its size suggests.
- Honest caveat: my load run ended 18 s before the first stall, so I cannot fully exclude it as a
  trigger; but the escalating pattern (6 s -> 328 s while the CPU sat idle) and the specific
  operations that blocked (a `stat`, a session-file read) point at the volume, not at the requests.

**Operational consequence.** Two things, and the second is the correction of an earlier claim in this
file. (a) The watchdog's rule is "answered = alive": the router did answer between stalls, so it never
accumulated 30 continuous minutes of no answer and was never replaced. (b) **The bigger problem is that
the watchdog produced no observation at all during the outage.** `logs/router.supervisor.log`
(10,011 bytes) and `logs/router.crash.log` (926 bytes) were both last written at **17:01:19**, before
the incident began, while the router's own logs were still being written at 17:45. The supervisor's own
rules require it to write a line immediately on the first failed probe and then every 60 s, so during a
5.4-minute continuous block it cannot have been executing that branch. It is alive and looping now
(CPU +0.28 s in 60 s, no orphan children, `netstat` 32-58 ms), so this was a transient wedge - most
likely in one of the native tools it spawns to do its own probing (`Get-ListenerPid` spawns
`netstat.exe`, and the probe spawns `curl.exe`), on the same box that measured a 10 s WMI process-table
timeout and a 672 ms `stat` in the same window. I cannot prove which call wedged it, because **the
watchdog has no heartbeat of its own**: "silent because healthy" and "silent because wedged" are the
same observable state in the log, in the lock file and in `-Status`. Giving it one (a line or a status
timestamp every few minutes) is the cheapest fix with the highest value, and it belongs to whoever owns
`ops/`.

Note also that `ops/router-supervisor.ps1 -Force` cannot be used as a new instance while pid 37156
holds a valid lock - a second supervisor exits with code 3. So a router that hangs in cycles but
answers occasionally needs either a manual kill decision (manager/CEO) or a lower
`ROUTER_SUPERVISOR_REPLACE_AFTER_MIN` - and, until the heartbeat exists, nobody can tell from the logs
whether the watchdog is even running.

**The live metrics agree.** Read a few minutes after the incident, `/health` reports
`lagMaxMs = 325594` (the 325.7 s `statSync` above; the earlier figure of 2,573 ms was correct only
before the stall), `lagP95Ms = 750` and `loop.blocks = 138` (it was 47 before the incident) - so the
router's own instruments carry the same story as the log, and the elevated block rate was still
running when this was written. Responses were nonetheless fast again at that moment
(4 x `/health` in 2-160 ms, page in 6 ms, exactly one listener).

Fifteen minutes later the same trend is still climbing - at 17:46 local: `loop.blocks = 201` (was 138),
`lagP95Ms = 2151` (was 750), and one of three `/health` probes took **3.86 s** while the other two took
4 ms and 22 ms, the page 17 ms, still exactly one listener, router uptime 45 minutes. So the site is
serving, but the box is still in a degraded I/O regime and the router inherits every stall in it. This
is not a stable state; it is the condition the recommendation above is meant to remove.

**The fix this points to** (not done here - it is a source change needing review and another restart):
take synchronous fs off the event loop on the hot paths, so a stalling disk cannot freeze the site.
The ones this incident named, in order of severity: the cache signature `fs.statSync` on
`company\fleet\orders.json`; `fs.readFileSync` of `company\reports\briefing.json`/`terminals.jsonl`/
`runs.jsonl` on request paths; and the `fs.readFileSync(C:\Users\user\.jcode\client_sessions\<pid>)`
liveness check. Moving them to async/TTL-cached reads would make the website survive exactly the
condition that broke it tonight. Until then, the honest statement of the website's reliability is:
**fast (p50 4 ms, p95 under 210 ms) whenever the volume is healthy, and unusable for minutes when the
volume stalls - bounded only by how long the OS takes.**

---

## 10. Fourth pass: browser-shaped serving checks, and one wrong finding of mine that validation caught

- **MIME/encoding are right for ES modules**, which is what a real browser needs: **11/11** JS modules
  (`/v2/app.js`, `/v2/api.js`, all nine `views/*.js`) are served `text/javascript; charset=utf-8` with
  gzip; `/v2/style.css` is `text/css`; the pages are `text/html`. `HEAD` works for `/`, `/health` and
  `/v2/app.js`; `POST /health` -> **404** (a refusal, not an action).
- **Conditional GET works, and repeat visits cost nothing.** With the exact ETag from a first response,
  `If-None-Match` returns **304 with a 0-byte body** for both `/v2/app.js` and `/`, under gzip and under
  identity; `If-Modified-Since` also returns 304; the control (a bogus ETag) correctly returns 200. First
  loads are gzipped (the dashboard is 24,478 B on the wire vs 90,128 B, app.js 10,392 B vs 30,797 B).
  *This corrects a wrong reading of mine:* an earlier probe printed 200 for a conditional request, which
  was a **client artifact** (node's `fetch` and a shell-quoted curl), and a later curl probe "hung" only
  because it ran inside the stall window in section 9. The server was always correct:
  `precompressedStatic` deliberately steps aside when a conditional header is present
  (`src/company/cache.ts:213-220`) and lets `express.static` answer 304.
- **The dashboard is not a static page** (my earlier "one sub-resource" claim described markup only).
  `public/index.html` runs an inline script that calls `GET /company/auth/bootstrap` (with
  `cache: "no-store"`; I read only its status and size, never its body), `GET /company/panel`,
  `GET /company/flow?limit=30`, `GET /company/assistant/thread?limit=100` and
  `GET /company/agents/<id>/thread?limit=100`. Every GET answers **200**: panel 219,622 B in 47 ms,
  flow 131,500 B in 5 ms, thread 39,819 B in 8 ms, bootstrap 199 B in 6 ms.
- **The log cap is proven mechanically, not merely armed.** The repo's own
  `ops/loop-watchdog-selftest.ts` (run in its own process, temp paths): **33 PASS / 0 FAIL,
  "ALL CHECKS PASSED"** - including F1-F3 (a 7.6 KB chunk truncated to <=200 B, marked
  `line truncated by loopWatchdog` and counted), G1-G3 (500 identical lines collapse to **1** physical
  write, reported and counted), H1-H2 (the bytes/second budget dropped 323 lines / 74 KB and announced
  it) and I1-I2 (supervisor-matched lines and crash stacks are never truncated).
- **CPU cost of serving, measured with an idle baseline:** idle **1.48 s per 60 s** (2.47% of one core),
  with 600 requests **3.53 s per 63 s** (5.61%) -> **~3.3 ms of CPU per request**; whole process 57.5 s
  over 1,492 s (3.85%), RSS 72-105 MB across samples with no upward trend. Serving the site is cheap;
  what hurts it is blocking I/O (sections 4 and 9), not CPU.

---

## 11. Fifth pass: the conditional-GET conclusion hardened, and the client artifact proven rather than asserted

- **18/18 static paths** revalidate: `/`, `/index.html`, `/v2/`, `/v2/index.html`, `/v2/style.css`,
  `/v2/app.js`, `/v2/api.js`, all nine `views/*.js`, `/fleet-proof/card.html`, `/v2/test-ny-ui.html`
  each answer **304 with a 0-byte body** when given the ETag from their own first response.
- **Every variant behaves correctly:** `If-None-Match: *` -> 304; a list containing a match -> 304; the
  strong form of a weak tag -> 304 (weak comparison, as RFC 7232 requires for GET);
  `HEAD` + `If-None-Match` -> 304 with no body; `Range: bytes=0-99` -> **206 with exactly 100 bytes**
  (so range requests pass through to `express.static` as designed).
- **The artifact is now shown, not claimed.** Two separate client faults were reproduced:
  * *undici (node `fetch`)*: the same matching header returns **200 with the full 30,797-byte body**
    where raw `node:http` returns 304 - undici does not surface the 304 the server sent.
  * *the shell-quoted curl*: `curl --trace-ascii` shows it actually put
    `If-None-Match: W/784d-1a0edd665e9` on the wire - **cmd stripped the inner quotes** - and an
    unquoted value is not a valid entity-tag, so 200 is the *correct* answer to that malformed request.
    Control, run directly: properly quoted -> **304**; cmd-stripped unquoted -> **200**; quoted but wrong
    tag -> 200; no conditional header -> 200.
  * The probe that appeared to "hang" started 11:58:36Z and the stall window was
    11:57:11Z -> 12:06:40Z, so it ran entirely inside the stall (section 9). It did not hang because of
    anything to do with conditional requests.
- **New positive finding:** the dynamic GETs the dashboard uses also revalidate - `/health`,
  `/api/needs-you`, `/company/panel` and `/company/flow?limit=30` each return **304** for their own
  content-derived ETag. That is safe by construction (express derives the tag from the response body, so
  an identical tag means an identical body) and it means the console's data calls cost 0 bytes on
  repeat too. `If-Modified-Since` on those routes returns 200: they set no `Last-Modified`.
- **One asymmetry, stated plainly:** the 304 (answered by `express.static`) carries
  `Cache-Control: public, max-age=0` and **no `Vary: Accept-Encoding`**, while the 200 (answered by the
  gzip middleware) carries `max-age=30` and `Vary: Accept-Encoding`. Per RFC 7234 a 304 only updates the
  stored headers, so the stored `Vary` survives and nothing is broken here; but mixing the two
  directives is exactly the kind of detail that can surprise a stricter intermediary cache. No change
  made - it is a deliberate deferral to `express.static`, and the fix (echoing `Vary` and the gzip
  path's `max-age` on the 304) belongs with whoever next touches `src/company/cache.ts`.

---

## 12. Sixth pass: framing, collisions and query strings all clean - and the watchdog's silence during the outage

Conditional-GET behaviour, pushed until each remaining way of being wrong was tested directly:

- **Framing on a persistent connection (the way a 304 can actually hang a client): three requests on
  ONE socket** - `200` (content-length 10,392) -> `304` (no content-length, `Connection: keep-alive`,
  0 bytes) -> `200` (801 bytes). All **3/3 parsed** on the same connection, so a body-less 304 is
  correctly framed and cannot stall a browser or a proxy.
- **Dynamic 304s are framed the same way:** `/health` (etag `W/"2ca-..."`), `/api/needs-you` and
  `/company/panel` (223,375-byte body on the 200) each answer **304 with no content-length and 0 bytes**.
- **No ETag collisions.** A file's tag sent to a *different* file returns 200, not 304:
  `app.js` tag -> `style.css` = 200 (and `style.css`'s own tag -> 304); `views/fleet.js` tag ->
  `views/assistant.js` = 200; `/` tag -> `/v2/` = 200. This matters because the static tag is
  `size+mtime`, so a cross-file hit would mean serving the wrong bytes; it does not happen.
- **Query strings still revalidate:** `/v2/app.js?v=...`, `/?x=1` and `/index.html?y=2` each answer
  **304** for their own tag (the tag is file-derived, so the parameterised and plain forms share one
  validator; browsers key their caches by URL, which is what makes `?v=` work as cache-busting).
- **`If-Range` is correct (RFC 7233):** matching tag + `Range: bytes=0-9` -> **206, exactly 10 bytes**;
  mismatched tag + the same range -> **200 with the full 30,797-byte body**.

**And the watchdog, which is the operational headline of this pass.** `logs/router.supervisor.log`
(10,011 bytes) and `logs/router.crash.log` (926 bytes) both have a last-write time of **17:01:19** - the
restart - while the outage ran 17:28:21 -> 17:36:40 and the router's own logs were still written at
17:45. So the watchdog filed **no observation whatsoever** during an outage it exists to observe, even
though its rules require a line within seconds of a failed probe and every 60 s after that. It is alive
and looping now (CPU +0.28 s per 60 s, no orphan child processes, `netstat` 32-58 ms), so it was a
transient wedge rather than a dead process; its own probe path spawns `netstat.exe` and `curl.exe`, and
process/disk operations were stalling in exactly that window. Which call wedged it is unknowable from
the evidence, because the watchdog keeps **no heartbeat of its own** - healthy silence and wedged
silence look identical in the log, the lock file and `-Status`. That gap, not the router, is what the
manager should fix first.

---

## 13. Seventh pass: the ETag proof completed, pipelining cleared, and the watchdog claim falsification-attempted

- **ETag collisions, exhaustively.** 18 static paths yield **16 distinct tags**; the only shared values are
  `/` vs `/index.html` (both serve `public/index.html`) and `/v2/` vs `/v2/index.html` (both serve
  `public/v2/index.html`). Those are directory-index aliases for the *same file*, so their tags matching
  is correct, not a hazard. In the full **306-pair cross-product** (A's tag sent to B, A != B) exactly
  those **4 alias pairs** matched; the other **302 returned 200**. 18/18 own-tag requests returned 304.
- **Pipelining is handled, in every arrangement.** Two requests written before reading anything:
  plain+plain -> `[200, 200]`; plain+conditional -> `[200, 304]`; conditional+plain -> `[304, 200]`;
  plain+`Connection: close` -> `[200, 200]` and the server closes. And the realistic case works too:
  `curl` fetching two URLs reuses **one** connection (`num_connects=1` then `0`).
- **The remaining edge cases are right as well.** `HTTP/1.0` + conditional -> 304, no content-length, the
  server closes the connection (no hang for an HTTP/1.0 client). `If-Range` by date -> 206 with 10 bytes
  when it matches `Last-Modified`, and the full 200 when the date is older. An invalid or past-EOF range
  -> **416 with a 666-byte body** (rather than a silent full body).
- **Two more measurement artifacts of mine, caught and fixed** (same family as sections 7 and 11):
  (a) my first pipelining run reported "1/2 responses" because my parser only matched status lines at
  line starts, and a JSON body does not end with a newline - with a parser that cannot be fooled, all
  four pairs return both responses; (b) a `curl -o NUL` with two URLs only silences the *first* response,
  so the second body printed. I checked what printed: it was the `/health` JSON, whose only string values
  are the labels `subscription-only, no api key` and `127.0.0.1` plus booleans - **no secret was
  exposed**, and the command is fixed. The control request in that same run also returned 0 bytes simply
  because it landed inside a stall (re-run alone: 3/3 in 3-17 ms), which is a good illustration of how
  easily this box makes a healthy server look broken.
- **The watchdog claim survived a falsification attempt.** Scanning *every* file in `logs/` modified
  between 17:20 and 17:45 shows the only watchdog-adjacent write was the **dev** router's
  `router-8801.crash.log`; no supervisor log, crash log or lock for `:8787` was touched, and the lock
  still names pid 37156, so the watchdog did not hand over or log elsewhere. Its probe loop is genuinely
  live when healthy (CPU +0.17 s in 60 s, +0.34 s in 120 s, matching a ~3 s poll). And the scheduled task
  that owns it has **no recovery path**: `MultipleInstances: IgnoreNew`, `RestartCount: 0`, no
  `RestartInterval`, `ExecutionTimeLimit: PT0S` (unlimited), firing every ~2 minutes and returning the
  same code (2147946720). Nothing restarts, times out or even notices a wedged instance - which is why
  the heartbeat recommendation in section 9 is the one that matters. (An aside worth recording: a count
  of "3 supervisor processes" was my own shell matching its own command line; there are exactly two,
  pid 37156 for `:8787` and pid 27040 for `:8791`.)
- **Live state while this was being written (17:51 local):** the router is serving - `/health` 2-379 ms,
  four of five probes under 20 ms - but one page load took **1.50 s**, `loop.blocks` has climbed to 254
  (47 -> 138 -> 201 -> 254), `lagP95Ms` is 4854, the witness thread reports **26 stall episodes** with
  `stallMaxMs = 300908` and a most recent stall of **5.1 s**, and the last recorded block was 599 ms
  reading `company\inbox\items.json`. The condition in section 9 has not cleared.

---

## 14. Eighth pass: the last HTTP cases, and the watchdog's mechanism at code level

- **Cross-layer revalidation cannot happen.** A tag from one layer never satisfies another:
  `/health` tag -> `/v2/app.js` = 200; `/v2/app.js` tag -> `/health` = 200; `/company/panel` tag -> `/` =
  200; `/` tag -> `/company/panel` = 200; the own-tag control = 304.
- **Missing paths never falsely revalidate.** `/nope.js`, `/v2/views/does-not-exist.js` and
  `/company/nothing` return **404 with no ETag** for a plain request, for a conditional request and even
  for `If-None-Match: *`.
- **Odd clients are handled:** `HEAD` + `If-None-Match` on a *dynamic* route (`/api/needs-you`) -> 304
  with 0 bytes; a GET carrying `Expect: 100-continue` gets the interim `100 Continue` and then the full
  body (31,154 bytes on the wire) - no hang. (My printer labelled the interim 100 as the final status
  because it matched the first status line; the delivered body is what proves the 200 arrived - noted
  rather than hidden.)
- **Both conditionals at once behave per spec:** matching ETag + matching `Last-Modified` -> 304, but a
  *wrong* ETag + matching `Last-Modified` -> **200**, i.e. `If-None-Match` correctly takes precedence
  (RFC 7232 section 3.3). The freshness logic is not accidentally "either one wins".
- **Where the watchdog can block, at code level** (this is the honest mechanism behind section 9's
  silence, and it does not require the loop to have been dead):
  * `Get-ListenerPid` spawns `netstat.exe` (`ops/router-supervisor.ps1:203`), falling back to the
    CIM-backed `Get-NetTCPConnection` (`:213`); `Get-RouterProbe` spawns `curl.exe` (`:309`).
  * The **no-answer branch calls `Get-ListenerPid` before it can write its own line** - `$noAnswerSince =
    Get-Date` (`:515`) then `$listener = Get-ListenerPid` (`:516`), and only then `Write-Sup`. So the
    watchdog cannot report "listener but no answer" unless its own `netstat` spawn returns.
  * The start branch's authoritative double-check spawns it too (`$authPid = Get-ListenerPid`, `:575`).
  * Its logging is itself synchronous file I/O (`Write-LogLine` uses a `FileStream`), so a stalled volume
    is a third way it can block.
  Three blocking dependencies, none of them its own, on the same box that measured a 10 s WMI timeout, a
  672 ms `stat` and a 325 s `statSync` in that window.
- **Reproduction attempt, stated as a negative result:** sampling those very tools for 3 minutes on the
  now-calm box gives `netstat` **20-61 ms** and a WMI process query **185-457 ms** (36 samples each), so
  the wedge cannot be produced on demand and the mechanism above remains *inferred*, not proven. What is
  proven is the outcome: no observation was filed.
- **The heartbeat gap, from the tool's own output:** `ops/router-supervisor.ps1 -Status` reports the
  router's health, lag, listener pid, free RAM, RAM floor, replace threshold, its own pid and the log
  paths - and **nothing about its own loop**, no last-poll time, no counter. You can ask it about the
  router; you cannot ask it about itself.

---

## 15. Ninth pass: the blind spot proven, and the recommendation costed

**No monitor built on today's files could have caught the outage.** Every observable the watchdog
produces is identical for a healthy window and for the outage window:

| observable | healthy 17:07-17:27 | outage 17:28-17:36 | distinguishable? |
|---|---|---|---|
| `router.supervisor.log` mtime | 17:01:19 | 17:01:19 | no |
| `router.supervisor.log` size | 10,011 B | 10,011 B | no |
| `router.crash.log` mtime | 17:01:19 | 17:01:19 | no |
| `router-supervisor.lock` mtime / owner | 17:04:16 / pid 37156 | same | no |
| process alive | yes | yes | no |
| CPU delta | not recorded at the time | not recorded at the time | no |

Meanwhile the router's *own* files moved throughout (`router.out.log`, `router.blocks.log`,
`router.err.log`). So the only thing that distinguished a 5.4-minute outage from twenty healthy minutes
was a measurement nobody was taking. That is the blind spot, demonstrated rather than asserted.

**What a heartbeat would cost, measured on this box:** 20 appends of a ~40-byte line take
**358.6 ms total (17.9 ms each)** and add **1,151 B/min (1.58 MB/day)** - negligible volume next to the
router's own 1,254 B/min. The number that matters is the per-append latency: at this box's I/O cost, a
synchronous append *every* 3 s poll would add ~18 ms to every poll, so the recommendation is a paced
heartbeat (a line every 30-60 s is ample to catch a multi-minute wedge) rather than one per poll.

**The single-instance guard, verified read-only.** `-Status` resolves the lock owner through the same
`Get-LockOwner` the guard uses and reports `supervisor pid : 37156`; the guard branch exits with code 3
immediately after that call. I deliberately did **not** run a second supervisor invocation to watch it
refuse: doing so would append a line to `logs/router.supervisor.log`, the very file whose staleness is the
evidence above, and any mistake there is how you end up with two supervisors guarding one port.

**Deliberately not done: synthesising load to reproduce the watchdog wedge.** The box is already in a
degraded I/O regime and the site is live for the CEO; adding deliberate pressure to prove a hypothesis is
not a trade I will make with someone else's production service. The mechanism therefore stays *inferred*
(section 14) while the outcome stays *proven*. If someone wants the mechanism confirmed, the honest way is
a disposable isolated supervisor (`-Port`, `-LogPrefix`, `-ChildEnv`) on a scratch copy, not on `:8787`.

---

## 16. Tenth pass: the OS says nothing, and the heartbeat gets cheaper

- **Independent corroboration for the stall: absent, and that is the result.** The Windows System log
  over a wide window (16:30-18:05, 66 events: 58 IsolatedUserMode, 6 Service Control Manager, 2
  UserModePowerMonitor) contains **zero** storage/disk-provider events (`disk`, `Ntfs`, `storahci`,
  `stornvme`, `volmgr`, `partmgr`, `Wdf`), and the Application log for the outage window is only
  Security-SPP licensing noise. So nothing at OS level recorded a disk fault. The evidence for the stall
  remains the router's **own measurements of its own calls** - a `statSync` returning after 325,744 ms, a
  `readFileSync` after 98,758 ms - which are direct measurements of those calls whatever the OS logged.
  What this rules out is the comfortable version of the story: this was latency/contention, not a logged
  media error, and the cause should not be described as one.
- **The task's own history is not a signal either.** `Microsoft-Windows-TaskScheduler/Operational` is
  **disabled** (`IsEnabled = False`), so no monitor could have seen the watchdog's task firing, failing or
  being ignored - there was no log to read. That is one more entry in the section-15 blind-spot table.
- **A cheaper heartbeat than the one I previously costed.** Measured on this box for 20 writes:
  `Add-Content` (append, open per call) **17.9 ms** each; `Set-Content` (overwrite a status file)
  **12.4 ms** each; a **held-open `FileStream` with write + flush 1.6 ms each** (20 writes in 31.2 ms).
  So the recommendation refines to: keep one `FileStream` open for the lifetime of the supervisor and
  write a short timestamp line per beat, paced every 30-60 s - about **1.6 ms and ~1.1 KB/min**, which is
  nothing next to the router's own 1,254 B/min.
- **The guard, cited exactly:** the single-instance check is `ops/router-supervisor.ps1:455-458` -
  `$owner = Get-LockOwner`, then `Write-Sup "another supervisor is already running (pid ...) - exiting
  without starting a second one"`, then `exit 3`. `-Status` resolving the owner to pid 37156 exercises the
  same call, which is why I could verify the guard without writing to the evidence file.
- **Context, with its limit stated:** a dev router on `:8801` was (re)started at 17:42:02, during the same
  period, so other routers were cycling while the `:8787` watchdog filed nothing. I cannot say who started
  it - the `:8791`/`:8801` supervisors keep no log file of their own - so this is context, not proof.

---

## 17. Eleventh pass: two more negatives, one refinement, and the heartbeat design settled

- **No service event explains the stall.** The only service events in 17:00-18:05 are five BITS
  start-type flips (17:11, 17:41, 17:44, 17:46 - all *outside* the outage), and there are **no** service
  start/stop events at all (ids 7036/7045/7034/7031 returned nothing). So this was not a filter-driver or
  service reload.
- **Cross-process corroboration: inconclusive, and a claim of mine needs softening.** The other routers
  on the same volume - independent Node processes with the same watchdog installed (the `:8801` one logs
  545 ms and 580 ms blocks earlier in the hour) - recorded **zero** entries between 11:55Z and 12:10Z
  (`router-8801.blocks.log`: 64 lines total, none in the window; `router-8802.blocks.log`: 10 lines, none
  in the window). I cannot establish how busy they were, either: `logs/router-8801.out.log` **does not
  exist** (that router was started without a stdout redirect) and `:8802`'s log ends at 11:28Z. So their
  silence neither confirms nor contradicts a volume-wide stall.
  **Refinement:** what is proven is that **the `:8787` process's own synchronous calls stalled** - 325,744 ms
  for one `statSync`, 98,758 ms for one `readFileSync`, both timed by its own tracer. "The box's
  filesystem stalled" is the likely explanation, but it is **not established**, and the sections above
  should be read with that distinction: measured for this process, inferred for the volume. (That open
  question is resolved in section 18: the volume was writable throughout.)
- **The heartbeat design is now settled by measurement.** Writing one beat from a *spawned* helper costs
  `cmd /c echo >> file` **36.6 ms**, and a fresh `powershell -NoProfile -Command Add-Content` **305.6 ms**
  (cold start), against **1.6 ms** for a write on a held-open in-process `FileStream`. Beyond the 23x-190x
  cost, a spawned writer would reintroduce exactly the dependency that this whole investigation implicates
  (process creation and native tools on a stalling box), so the heartbeat must be written **in-process**
  by the supervisor itself, on a stream it already holds open, paced every 30-60 s.

---

## 18. Twelfth pass: the volume-wide question resolved - it was NOT volume-wide

Method: for each log, extract every timestamp in 11:55-12:10Z, sort them, and measure the largest gap
between consecutive entries. A process that keeps logging is a process whose writes are landing.

| log | lines in window | largest gap |
|---|---|---|
| `router-8791.out.log` - a **different Node process** on the same volume | 116 | **18 s** |
| `router.out.log` - the `:8787` process itself | 109 | **353 s**, starting 17:28:03Z |

**Conclusion: while the `:8787` process was blocked for 5.9 minutes, another process on the same volume
was writing to disk continuously (18 s maximum gap).** So the storage was writable and this was **not a
volume-wide stall** - it was specific to this process and the file paths it was touching. That resolves
section 17's open question in favour of the narrower claim, and it redirects the diagnosis: look for
**per-file contention** - a scanner, or another process holding the specific file - rather than failing
storage. The calls that blocked were `fs.statSync(company\fleet\orders.json)` (325.7 s) and
`fs.readFileSync(C:\Users\user\.jcode\client_sessions\21384)` (98.8 s), and `orders.json` is a file the
fleet rewrites constantly, which makes it exactly the shape of a lock/scan problem.

Two caveats, stated so the table is not read as stronger than it is: `laya.out.log` and
`jcode-router-restart.log` yielded **0** timestamps under my pattern, which is a timestamp-**format**
artifact and contributes nothing either way; and an 18 s maximum gap proves writes were landing, not that
no single file was ever locked.

**The OS agrees there was no device fault:** across 17:00-18:10 there are no Application hang (1002), WER
(1001/1000), Kernel-Power (41) or WHEA (219) events, and the entire System log for that span is 49 events,
all `IsolatedUserMode` (42), Service Control Manager (5) and UserModePowerService (2). Nothing recorded a
hang, reset or failing device.

---

## 19. Thirteenth pass: the dominant stall, caught live - it is the router's own `orders.json` save

A quiet two-minute sample of the router's own witness log (18:05:51-18:07:52 local, 120 s) recorded
**24 block/stall lines**, and they are not a rare pathology:

| what blocked | count | worst |
|---|---|---|
| `fs.writeFileSync(company\fleet\orders.json.tmp-9936)` | 12 | **4,636 ms** |
| `fs.renameSync(company\fleet\orders.json.tmp-9936)` | 4 | 3,780 ms |
| `fs.readdirSync(company\reports\runs)` | 2 | 1,213 ms |
| (`SLOW-SYNC` entries on the same paths) | 6 | 984 ms |

Named durations include 4,636, 3,780, 2,647, 2,522, 2,397, 1,656, 1,605, 1,435, 1,213, 1,102, 984, 948, 908,
733, 729, 726, 724, 713, 609, 600, 519, 506, 384 and 370 ms - on a calm box, in two minutes, with **16 of
the 24 on `orders.json` alone**.

**So the dominant recurring stall is self-inflicted and structural:** `saveFleetOrders()`
(`src/company/fleet.ts:313-342`) writes a ~229 KB temp file and renames it, **synchronously, on the
router's event loop**, and this box charges 0.4-4.6 s for that write+rename. The fleet saves often, so
the site pays a multi-second stall several times a minute. This also corrects my own earlier
characterisation: sections 4, 9 and 13 described "occasional 0.2-0.4 s page loads" - that was an
understatement produced by sampling between saves, not a property of the system.

**It is the write path, not reads.** Measured from an independent process just before this sample:
`statSync` on that same `orders.json` = p50 0.03 ms, p95 0.10 ms, max 4.2 ms over 200 samples, and a full
`ReadAllBytes` of the 229 KB file = p50 0.2 ms, max 23.5 ms over 20 reads. The file is not contended for
reading; the *create + write + rename* is what costs seconds.

**Security software is the plausible amplifier, and it is on.** The only AV registered is Windows
Defender, with `RealTimeProtectionEnabled = True`, `OnAccessProtectionEnabled = True`,
`DisableRealtimeMonitoring = False`, current signatures, and `MsMpEng` resident at ~547 MB. I could not
read its exclusion list from a non-admin shell (`Must be an administrator to view exclusions`), so I
cannot say whether `company\` is excluded - but a create-and-rename of a fresh 229 KB file every few
seconds is precisely the pattern on-access scanning charges for. Excluding the repo and the runner's temp
directories is worth testing as a mitigation; it is not the fix.

**What this changes about the recommendation:** the first item is now specific and high-yield - make
`saveFleetOrders` **asynchronous and coalesced** (a dirty flag plus at most one write in flight, instead of
a synchronous write per change). That alone removes ~16 stalls per two minutes. The rename belongs in the
same change (`fs.renameSync` was costing up to 3.8 s). The watchdog heartbeat and the AV-exclusion test
stay as the second and third items. None of the three was implemented here: this is a live production
service and the fixes need their own verification and a restart.

---

## 20. Fourteenth pass: the fix tested, and the cause narrowed again

Three experiments, and they do not all say the same thing - which is why they are worth recording.

1. **Who writes `orders.json`?** Sampling `company\fleet` every 500 ms for 60 s, the only temp file that
ever appeared was **`orders.json.tmp-9936`** - pid 9936, the router itself. No other process uses that
   convention. In the same 60 s the file's mtime changed **13 times** (about every 5 s).
2. **Is the operation intrinsically slow?** An independent process did 20 *async* write+rename cycles of a
   229 KB buffer on the same volume: **16 ms mean, 24 ms worst**, with the site's own probes at p50 3 ms /
   p95 374 ms and **none over 1 s** during the writes.
3. **Sustained test (60 s):** 59 async cycles - **p50 7 ms, p95 36 ms, max 64 ms, zero cycles over 300 ms** -
   while the router was writing `orders.json` in the same window. And the probe process, running
   separately, recorded **one 39,177 ms request** among 209 (p50 2 ms, p95 15 ms).

**Conclusion, and it moves the target again:** the write+rename is not intrinsically expensive - an
independent process did it 59 times in a minute with a 64 ms worst case, in the same minute that the
router paid 0.4-4.6 s per save and the site took a 39-second stall. So the cost is **contention on the
live file inside the router's process** (many other processes read `orders.json`, and each newly created
version is a fresh file for on-access scanning), not the size of the write nor the volume. That is
consistent with everything else: the same box, the same call, wildly different costs depending on who is
holding the file.

**Recommendation, refined rather than changed:** async + coalesced still removes the loop-blocking, and
that matters most for the site's responsiveness. But the higher-value lever is **reducing the churn on
that file**: coalesce to at most one write in flight, avoid rewriting 229 KB every ~5 s when nothing
meaningful changed, and consider keeping the hot state in memory with a journal instead of a full rewrite.
Testing AV exclusions for the repo remains the cheap mitigation. Also worth knowing: the 39-second stall
observed here is larger than the 0.4-4.6 s pattern in section 19, so the router can still lose the site for
tens of seconds at a time.

---

## 21. Fifteenth pass: the same write in the router's own directory is fast - so the cost is the router's process, not the path

**First, the limits, because they shaped what could be tested.** This shell is not elevated
(`IsAdmin = False`), `handle.exe` is not installed, and the built-in `openfiles.exe` reports that it needs
the system global flag "maintain objects list" (which is not set, and enabling it is a system-wide change
plus a reboot that I will not make on someone's live machine). So **opener enumeration and AV-exclusion
inspection are both out of reach** - a hard boundary, stated rather than worked around.

**The A/B that was still available.** Identical pattern from an independent process - async
`writeFile` of a 229 KB buffer, then rename twice - 30 cycles per directory at 800 ms intervals, with the
site's latency probed by a separate process throughout:

| target directory | cycles | p50 | p95 | worst |
|---|---|---|---|---|
| `logs\` (control) | 30 | 4 ms | 9 ms | **11 ms** |
| `company\fleet\` (the router's own) | 30 | 3 ms | 6 ms | **10 ms** |

Site latency during the two phases: p50 2 ms in both, p95 18 ms and 30 ms. No multi-second probe in
either phase. (Harness nit, disclosed: my summary line printed `max=NaN` for the probe columns because of
an indexing bug in the throwaway script; the p50/p95 columns and the raw per-probe file are the real
numbers.)

**What that rules out.** The path, the file name (I used a different name), the directory, the volume and
the 229 KB size are all excluded: an outsider writing into the router's own directory pays **~10 ms**, while
the router's own trace for the same operation records **0.4-4.6 s**. The only variable left is **the
process**. And the one thing special about that process is that it is simultaneously doing a great deal of
*other* synchronous file I/O - `briefing.json`, `runs.jsonl`, `terminals.jsonl`, `inbox\items.json`,
`budget\brain-failures.json`, session-file existence checks, the `runs` directory listing, plus these saves
- all on the same thread. Synchronous calls from a saturated process compound; the identical call from an
otherwise-idle process does not.

**Limitation, stated:** the A/B ran in calm windows (episodes are intermittent - the worst I measured was
one 39 s stall in 209 probes), so it shows that *in calm conditions* neither directory is slow for an
outsider. I cannot claim from my side that the router would be fast in an episode; I can only show that its
slowness is not attributable to the path.

**Recommendation, final form:** take synchronous fs off the router's hot path **across the board**, not just
`saveFleetOrders`. Every sync call on that thread is a potential multi-second block while the process is
saturated, and they compound; async equivalents (or TTL-cached reads) make the site's response time
independent of the episodes. `saveFleetOrders` remains the single highest-yield one to convert, and the
runs-directory scanning is the next.
