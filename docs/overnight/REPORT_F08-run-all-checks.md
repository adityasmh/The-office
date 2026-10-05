# REPORT F08-run-all-checks (2026-10-06)

One command that runs every offline check in `ops/`, a manifest of the checks, and a
CI workflow that calls it. Worker: F08. Order: `docs/overnight/ORDER_F08-run-all-checks.md`.

## Changed files (new, nothing else touched)

| File | What |
|---|---|
| `ops/run-all-checks.ts` | The runner: `npx tsx ops/run-all-checks.ts [--include-network] [--only name] [--manifest file]` |
| `ops/checks.manifest.json` | 56 entries `{name, command, network, timeoutSec}` - every `ops/*-check.ts` / `ops/*-check.mjs` that existed while this was written |
| `ops/run-all-checks-check.ts` | The proof harness (temp dummy manifest under the OS temp dir) |
| `.github/workflows/ci.yml` | push + pull_request, ubuntu-latest, Node 24 (npm cache), `npm ci`, `npx tsc --noEmit`, `npx tsx ops/run-all-checks.ts`, `permissions: contents: read` |

## How the runner behaves

- Runs each selected check **one at a time, in the foreground**, through `cmd.exe`/`sh`,
  kills the whole process tree on timeout (`taskkill /T /F` on Windows, process group on POSIX).
- Table with `PASS` / `FAIL` / `TIMEOUT` / `SKIPPED-network` and seconds per check.
- Prints the **last 6 lines** of the output of every FAIL and TIMEOUT.
- Exit `0` when nothing FAILed or TIMEOUTed, `1` when something did, `2` for bad usage
  (unknown flag, unreadable/invalid manifest, `--only` that matches nothing).
- A `"network": true` check is **never executed** without `--include-network`; it is
  reported as `SKIPPED-network` (0.0s).
- Prints a note when `ops/*-check.*` files exist on disk that the manifest does not list
  (concurrent workers add checks; the manifest is a snapshot). The runner excludes itself
  and `ops/run-all-checks-check.ts` from that note: its own proof spawns the runner, so
  listing it would recurse forever.
- `"name"` is the file stem without the `-check` suffix (`ops/doctor-check.ts` -> `doctor`);
  `--only` matches the exact name first, then a case-insensitive substring.

### Network flags (14 of 56)

Flagged because the script itself opens a client socket (`fetch(`, `net.connect(`,
`new WebSocket(`) or names a real https host:
`adaptive`, `budget-real`, `deepseek-offpeak`, `fleet-github`, `fleet-live-vs-code`,
`fleet-planner-fallback`, `fleet-retry`, `loop-lag`, `metrics`, `order-report`,
`resume-view`, `stt-fallback`, `ui-assistant`, `voice-route`.

Conservative over-flags (they are offline, but a real host name appears in fixture text and
the order said to be conservative): `deepseek-offpeak` (`https://platform.deepseek.com` is
only inside a printed hint), `fleet-github` / `fleet-retry` / `order-report` (`github.com`
only inside fake `prUrl` strings). Flip these four to `false` if you prefer them to run.
`fleet-planner-fallback` IS genuinely networked: section A calls `GATEWAY_BASE_URL`
(default `https://opencode.ai/zen/go/v1`) for real.
`env-reload` (`https://example.test/...`) and `github` (`example.test`) are NOT flagged:
those hosts cannot resolve.

`ops/perf-backend/static-gzip-check.mjs` exists but is outside the `ops/*-check.mjs` glob,
so it is not in the manifest. `ops/supervisor-watchdog-check.ps1` and the `.py` GPU probes
are likewise not covered by the glob.

## Proof

Command: `npx tsx ops/run-all-checks-check.ts`

Exact output:

```
PASS a passing script is PASS  -> row="alpha  PASS                0.1  node \"C:\\Users\\user\\AppData\\Local\\Temp\\run-all-checks-check-ZX88fe\\alpha.mjs\""
PASS a failing script is FAIL (exit code 3 from the dummy)  -> row="beta   FAIL                0.1  node \"C:\\Users\\user\\AppData\\Local\\Temp\\run-all-checks-check-ZX88fe\\beta.mjs\""
PASS a script that outlives timeoutSec is TIMEOUT  -> row="gamma  TIMEOUT             2.4  node \"C:\\Users\\user\\AppData\\Local\\Temp\\run-all-checks-check-ZX88fe\\gamma.mjs\""
PASS a network-marked script is SKIPPED-network by default  -> row="delta  SKIPPED-network     0.0  node \"C:\\Users\\user\\AppData\\Local\\Temp\\run-all-checks-check-ZX88fe\\delta.mjs\""
PASS a skipped network script does not run at all  -> no sentinel written by delta
PASS the run exits 1 when a check FAILs or TIMEOUTs  -> exit=1
PASS the FAIL tail shows the last 6 output lines and stops there  -> line3=true; line2=false
PASS the TIMEOUT tail records the kill  -> killed-line="[run-all-checks] killed after 2s"
PASS the summary counts each status exactly once  -> summary="run-all-checks: 1 PASS, 1 FAIL, 1 TIMEOUT, 1 SKIPPED-network"
PASS the table has exactly one row per manifest entry  -> rows=4
PASS --only (substring) runs just the matching check  -> rows=["alpha  PASS                0.1  node \"C:\\Users\\user\\AppData\\Local\\Temp\\run-all-checks-check-ZX88fe\\alpha.mjs\""]
PASS a run with no FAIL and no TIMEOUT exits 0  -> exit=0
PASS --only reports how many of the manifest it selected  -> banner="run-all-checks: 1 of 4 check(s) from C:\\Users\\user\\AppData\\Local\\Temp\\run-all-checks-check-ZX88fe\\manifest.json"
PASS --only an exact name + default: the network check is skipped and the run exits 0  -> status=SKIPPED-network; ran=false; exit=0
PASS --include-network runs the network check and it PASSes  -> status=PASS; ran=true; exit=0
PASS a missing manifest exits 2 with a message  -> exit=2; msg="run-all-checks: cannot read manifest C:\\Users\\user\\AppData\\Local\\Temp\\run-all-checks-check-ZX88fe\\nope\\manifest.json - ENOENT: no such file or directory, open '...nope\\manifest.json'"
PASS the real manifest parses to a non-empty list with unique names  -> entries=56
PASS every real command's file exists and matches its name  -> missing=[]
PASS every ops/*-check script on disk is in the real manifest  -> listed=56/56; unlisted=[]
PASS the manifest flags some network checks, and each really names a client call or host  -> network=14/56
PASS no network=false entry hides a fetch( or socket client
PASS every timeoutSec is a positive number and every network flag a boolean  -> min=60s max=300s
run-all-checks-check: all checks passed
```

Evidence notes:

- "did the network dummy run?" is proved by a **sentinel file** the dummy appends to
  (inside the temp dir), because the runner intentionally prints child output only for
  failures; the sentinel is absent after the default run and present after
  `--include-network`.
- The real manifest is checked by parsing it with the runner's own `loadManifest`, verifying
  every command's file exists and that `name` matches its file stem, that all 56 on-disk
  `ops/*-check.*` files (minus the two self-proof harnesses) are listed, and that no
  `network: false` entry contains `fetch(` / `net.connect(` / `new WebSocket(`.
- Smoke run of the real runner first: `npx tsx ops/run-all-checks.ts --only budget-rows` ->
  `1 PASS, 0 FAIL, 0 TIMEOUT, 0 SKIPPED-network`, exit 0.

## Open issues / not verified

1. **Linux was never observed.** This box is Windows; the proof runs the real runner against
   temp dummies only. The CI job is the first Linux run. From the source, the checks that
   hard-code Windows-only resources are `resume-view` and `ui-assistant` (both pin
   `C:\Program Files\Google\Chrome\Application\chrome.exe`) - both are `network: true`, so
   CI skips them today. Among the 42 checks CI WILL run, none spawns PowerShell, `taskkill`,
   `cmd.exe` or a browser; their `C:\...`/`.exe` tokens are fake paths/tokens inside fixtures
   or `process.platform === "win32"` branches with a non-Windows fallback
   (`fleet-review-path`, `planner-toolcall`, `fleet-signin-*`, `fleet-review-*`,
   `fleet-fallback-flakiness`, `laya-control`, `cheap-default`, `doctor`, `fleet-cheapplan`,
   `secret-scan`). So no non-network check is *known* to need Windows - that is a guess from
   the source, and CI may still surface some.
2. **CI expects red until the fleet is portable.** The workflow does not skip anything, by
   design: a check that needs the live router, Chrome or a GPU shows as a real failure.
3. **Manifest drift.** Checks landing after this snapshot are not listed; the runner prints a
   note naming them instead of failing. `ops/run-all-checks-check.ts` is deliberately not a
   manifest entry (self-recursion).
4. **Timeouts are estimates** (60s for in-process checks, 120-300s for ones that spawn a
   server, git, a browser or the real gateway), not measured per check. No real check was
   run end-to-end by this order (several need the live router, which must not be started).
5. `--only` uses substring fallback when no exact match exists, so `--only fleet` selects 22
   checks; exit 2 is returned when nothing matches.
