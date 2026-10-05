# Work order: stop the router's biggest event-loop blockers (fixes 1 and 2 + exact attribution)

From: manager. Model: deepseek-v4.1-flash. Repo: C:\Users\user\Desktop\Default Project

Source: docs/perf/EVENT_LOOP_BLOCKS_2026-10-01.md (read sections 2, 4 and 5 first; the evidence is there). Summary: the router makes many synchronous fs calls on the event loop, and this box sometimes takes tens to hundreds of seconds to service one (Defender/memory pressure suspected), so every sync call is a potential multi-minute freeze. Stalls line up with ZERO CPU. Reduce the NUMBER of sync calls on the loop.

Do exactly these three, small diffs, never rewrite files, re-read each file right before editing (other workers edit src/; the router has `ADAPTIVE_ROUTING=0`, leave adaptive code alone):

1. FIX 1 (src/company/fleet.ts `tickFleet`, `saveFleetOrders`, around lines 3142 and 361): do not rewrite company\fleet\orders.json on a tick that changed nothing. Preferred: a dirty flag set by `pushTrace`/`touched()`/every state mutation (find all places that mutate an order or work order inside the tick: `advanced++`, `settleOrder`, `pushTrace`, state assignments); fallback if a reliable flag is hard: compare the new serialized string to the last-written string (keep it in memory per process, `JSON.stringify` once) and skip identical writes, and ALWAYS write when it differs. Keep the atomic tmp+rename and the state lock. Also stop calling `sleepSync()` (Atomics.wait) inside the save if it is only a retry backoff on failure: keep it only on the retry path.
2. FIX 2 (src/company/runManagers.ts `runsDirSignature()` ~line 1208, `storedCards()` ~1218): build the signature from ONE `statSync` of the runs directory (mtime + size) plus a 5-10 s TTL memo, instead of `readdirSync` + one `statSync` per card (133 stats per call). Keep `cachedBySig`. A card update may be noticed up to one briefing tick (30 s) later: acceptable; say so in the code comment.
3. ATTRIBUTION: wrap the four hot call sites with `withBusy(...)`/`markBusy()` from src/company/loopWatchdog.ts so BLOCK lines get a real label instead of `label="idle"`: "fleet tick" (tickFleet), "briefing storedCards" (runsDirSignature/storedCards), "reaper registry save" (terminalReaper writeFileAtomic), "brain failures" (brainRouter readFailures/noteCheapFailure). Read loopWatchdog.ts first to use its real API; if no such helper exists, add the smallest one. Diagnostic only, no behaviour change.

Prove it (new ops/loop-fix-check.ts, runs on a temp FLEET_REPO/COMPANY_ROOT, never the live company dir):
- fleet: run `tickFleet()` 5 times on an order set with nothing to change and count writes to orders.json (spy on fs.writeFileSync/renameSync for that path): before the fix N writes, after 0; then mutate one order (a real transition) and assert exactly one write with the new content and that reading it back gives the right state.
- runs signature: create 150 fake card files, count statSync calls for one `listRunCards()`/`storedCards()` call: before ~150, after 1-2; touch one card and assert the change is picked up after the TTL (or immediately if the dir mtime moved).
- Existing checks still pass: ops/fleet-selftest.ts, the ops/fleet-review-*.ts checks, `npx tsc --noEmit` (exit 0), `npx tsx ops/adaptive-check.ts`.
- Show before/after numbers in docs/perf/EVENT_LOOP_FIXES_1_2_2026-10-01.md.

Rules: DO NOT restart the router or touch the supervisor/watchdog, Laya, Kafka, the cuda session, ops/router-supervisor.ps1 or other workers' processes; the fixes take effect at the next router restart (say so). Do not implement fix 3 (fs.promises writers): it is medium risk and needs a reviewer. No secrets printed, no deletes. Append a timestamped entry to docs/AGENT_COORDINATION.md. Report to the manager, not the CEO.
