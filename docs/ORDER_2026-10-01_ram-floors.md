# Work order: lift the free-RAM floors (CEO order 2026-10-01)

From: manager. Model: deepseek-v4.1-flash. Repo: C:\Users\user\Desktop\Default Project

CEO said: use the full RAM, nothing else is happening on the machine. Free RAM shows ~0.7 GB because our own workers, Laya, Kafka downloads and the VM hold the rest. The floors only DELAY work, so lift them. This does not make the router less fragile, so keep the safety that matters (see "Keep").

Do, in this order, small diffs, never rewrite files, re-read right before editing (other workers are editing src/):
1. Fleet spawn floor: find `MIN_FREE_RAM_MB` (default 2048, src/company/fleet.ts or budgetGuard.ts and `.env.example`). Set the value in `.env` to 256 (edit ONLY that one line, or add it; never print, copy or log other lines of .env: it holds secrets). Update `.env.example` with the same key + a comment. Keep `MAX_PARALLEL_SESSIONS=30`.
2. Kafka: in `ops/kafka-up.ps1` the broker only starts when free RAM >= 1.5 GB. Make it honor `-IgnoreRamGuard` and env `LAYA_IGNORE_RAM_GUARD=1`, default guard unchanged. Same for `ops/metrics-up.ps1` if it exists yet (the metrics order fomupf7f4a is still building it; if the file is not there, leave a note in docs/AGENT_COORDINATION.md for that order's workers: "RAM guard must honor LAYA_IGNORE_RAM_GUARD=1; CEO wants it set").
3. Set `LAYA_IGNORE_RAM_GUARD=1` in `.env` (same single-line rule).
4. Do NOT restart the router, do NOT start Kafka or metrics yourself (the owning orders do that, they will now be allowed to), do NOT kill anything, do NOT touch Laya serving or the cuda session. Do not run `wsl --shutdown` or touch Docker/WSL: it belongs to the CEO.
5. Verify: `npx tsc --noEmit` exit 0 (if it fails in a file you did not touch, say whose it is and stop). Show the diff of each changed line (for .env show only the two key names and values, nothing else).
6. Append a timestamped entry to docs/AGENT_COORDINATION.md: what changed, and "takes effect after the next router restart (router restart worker is waiting for the router)".

Keep: the Kafka producer must stay fire-and-forget with a bounded buffer; the adaptive Kafka fallback to the in-process topic stays. Those are about survival under load, not about RAM floors.

Report to the manager, not the CEO.
