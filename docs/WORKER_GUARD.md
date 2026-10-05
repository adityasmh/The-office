# Worker guard (token-waste protection)

Goal: no looping workers, no token leakage. Every jcode worker runs through the guard.

**Spawn:** `ops\spawn-worker.ps1 -Name x -OrderFile docs\ORDER_x.md [-MaxMinutes 15 -MaxUsd 0.30]`.
It always runs `deepseek-flash` (any model containing "pro" is refused, exit 2), registers the worker in `logs\workers.json`, and starts the guard if it is not running.

**The guard** (`ops\worker-guard.ps1`, one instance, checks every 15 s) kills a worker when:
- the loop phrase appears 2 times as a plain answer, or 3 times in its reasoning;
- the same answer line repeats 6 times;
- 90 s have passed since its final report and it is still alive;
- it runs past MaxMinutes, or its estimated cost passes MaxUsd (peak flash prices);
- its log does not grow for 150 s (420 s only if it has a real child process; the console host does not count);
- its log grows past 2 MB.
It kills only that jcode process (never its children, terminals, the router, Laya or Kafka) and checks the process creation time first, so a reused pid is never killed.

**Account limits (wrapper):** max 3 live workers, no duplicate names, daily cap USD 1.50 (env `WORKER_DAILY_USD_CAP`), refuse when the DeepSeek balance is under USD 1.00 (`-Force` overrides). The guard kills all workers when the balance drops under USD 0.30.

**Files:** `logs\workers.json` (registry), `logs\worker-guard.log` (kills, warnings, terminal report), `logs\token-ledger.jsonl` (one line per worker: turns, tokens, estimated USD, how it ended).
Fleet terminals are NOT killed; the guard only reports their token use in the log.

**Order-writing rules** (a bad order makes workers loop):
1. One narrow task per worker, with an explicit end: "print the final report and END your turn".
2. No waiting, polling or "verify periodically" steps. The manager waits, not the worker.
3. Never tell a worker to read another worker's log.
4. Never ask a worker to work on, quote or discuss the loop phrase; call it only "the loop phrase".
5. Search the order case-insensitively for the 3-letter prefix of the loop phrase before spawning.

**Self-test:** `powershell -NoProfile -ExecutionPolicy Bypass -File ops\worker-guard-check.ps1` (temp folder only, about 35 s). Known gap: one case (fragmented-thought fixture) fails; the rule itself is proven by real kills.
