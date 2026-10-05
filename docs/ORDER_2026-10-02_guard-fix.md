# Work order: finish the worker guard (7 failing self-checks, one missing doc)

Repo: C:\Users\user\Desktop\Default Project (Windows PowerShell 5.1). Model: deepseek-flash. Narrow job: at most 6 edits, then a short report, then END your turn. Do not restart the router, Laya, Kafka or anything else. Do not read other workers' logs under logs\ (not needed, see the fixture below). No waiting, no polling, no repeated re-reading of this file.

State: ops\spawn-worker.ps1, ops\worker-guard.ps1 and ops\worker-guard-check.ps1 exist and parse with 0 errors. Running `powershell -NoProfile -ExecutionPolicy Bypass -File ops\worker-guard-check.ps1` gives 19 PASS and 7 FAIL:
1. `rule(a) fragmented thought Holding killed :: still alive`
2. `rule(f) idle>150s killed :: still alive`
3-7. `spawn concurrency cap refuses`, `spawn duplicate cap refuses`, `spawn daily cap refuses`, `spawn balance floor refuses`, `spawn passes gates in clean environment` -- all with `Cannot bind parameter because parameter 'Name' is ...`.
Facts: calling `ops\spawn-worker.ps1 -Name x-test -Message hi -DryRun` by hand works (prints `OK dry-run: ...`), so cases 3-7 are most likely a bug in how the CHECK invokes the script (wrong parameter passing/splatting/quoting), not in spawn-worker itself. Decide for each failing case, with a one-line reason, whether the CODE or the TEST is wrong, and fix the right one.

Fixture for case 1 (this is what a looping worker's log looks like; each thought token is its own line with a leading marker, the visible answer is a plain line). Build it inside the check from a here-string, repeated several times, then assert the guard kills the dummy worker. The loop phrase is the single word H-o-l-d-i-n-g (capital H) or "continue holding" in reassembled thought text, or the plain answer line equal to it:
```
💭 Respond
💭  "
💭 H
💭 olding
💭 ."
Holding.
[Tokens] upload: 108502 download: 14 cache_read: 108288 cache_write: 0
💭 Continue
💭  holding
💭 .
```
The guard must (a) reassemble consecutive thought lines into text (strip the marker, join, collapse whitespace), (b) count plain answer lines equal to the loop phrase (trimmed, case-insensitive, optional trailing period) and kill at 2 or more, and (c) count the reassembled phrases `keep holding|continue holding|I'll hold|Respond "Holding` and kill at 3 or more in the last 200 lines. A normal sentence containing the word "holding" must NOT trigger it (keep that existing passing case). Check the code path against the fixture first: write bytes with [System.IO.File]::WriteAllText using UTF-8 (the emoji marker must be read as UTF-8 by the guard; confirm the guard decodes the log as UTF-8 and that the marker you split on is the same character as in the fixture).

Case 2 (idle): a registered dummy with no log growth for more than 150 s (and older than 60 s, no child process) must be killed. The check can seed state (idleSec, elapsedSec) instead of really waiting; make sure the code path that adds idle time actually runs in the `-Once -TestRoot` mode used by the check, and that the 60 s startup grace and the "live child process extends the limit to 420 s" rules still pass their own cases.

Then: write `docs\WORKER_GUARD.md` (at most 25 lines): how to spawn (`ops\spawn-worker.ps1 -Name x -OrderFile docs\ORDER_x.md [-MaxMinutes 15 -MaxUsd 0.30]`), the kill rules (loop phrase, repeated lines, 90 s after a final report, MaxMinutes, MaxUsd, idle 150 s / 420 s with child processes, log-size backstop), the account limits (3 live workers, no duplicate names, daily cap USD 1.50, balance floor USD 1.00 refuse / 0.30 kill-all), where the files are (logs\workers.json, logs\worker-guard.log, logs\token-ledger.jsonl), that fleet terminals are NOT covered, and these ORDER-WRITING RULES: orders are narrow with an explicit end; never include waiting, polling or "verify periodically" steps (the manager does the waiting); never tell a worker to read another worker's log; never mention the loop phrase in an order.

REAL-LAUNCH BUGS in ops\spawn-worker.ps1 (found by running it for real at 07:25; the dry run hides them): (1) line 124 builds `$argStr = "-p deepseek -m deepseek-flash -C ..."` WITHOUT the `run` subcommand, so jcode.exe answered `error: unrecognized subcommand 'You are a jcode worker...'` and exited at once (the error is in logs\jcode-guard-fix-20261002.err.log if you want the proof; read only that 371-byte file): the command line must be `run -p deepseek -m deepseek-flash -C "<repo>" "<message>"` with the message as ONE argument (escape embedded double quotes, handle spaces and apostrophes). (2) `$p.StartTime` throws after the process has already exited, so `creationTime` was written EMPTY and the dead worker was registered anyway: after the 400 ms sleep, if `$p.HasExited` is true, do NOT register; print `REFUSE: worker exited immediately (code N): <first line of the err log>` and exit 2; capture the creation time (UTC, round-trip "o" format) BEFORE any sleep and never write an empty creationTime for a live worker. (3) Add a test hook: a `-JcodeExe` parameter (default the real path) and `-TestRoot` honoured for the log/registry paths; in ops\worker-guard-check.ps1 add cases that use a tiny stub (a .cmd or .ps1 written to the temp folder that appends its received arguments to a file and then sleeps 3 s): (a) the received argument vector is exactly `run`, `-p`, `deepseek`, `-m`, `deepseek-flash`, `-C`, <repo>, <message> with the message arriving as a single argument even when it contains spaces, double quotes and an apostrophe; (b) the registry entry has a non-empty creationTime and the stub's pid; (c) a stub that exits immediately is refused and NOT registered; (d) -Model containing "pro" is still refused. The real worker guard process (pid started by this wrapper) must keep working; do not stop or restart it.

Finish: run the full check again; ALL cases must pass (report the final count, e.g. `26 / 26`). If a failure remains after two honest attempts, report which and why, do not loop. Append one timestamped entry to docs\AGENT_COORDINATION.md. Final report at most 6 lines, then END your turn.
