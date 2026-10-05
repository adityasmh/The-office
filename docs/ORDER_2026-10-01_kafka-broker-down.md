# Work order: the Kafka broker is down - bring it up and find out why it stopped

From: manager. Model: deepseek-v4.1-flash. Repo: C:\Users\user\Desktop\Default Project

Measured at 17:25 local: nothing listens on 127.0.0.1:9092. The only java process is pid 14312, a ConsoleConsumer smoke client (started 17:18:44), NOT a broker. The broker log logs\kafka-adaptive.out.log stopped growing at 17:15:10 (a smoke-group rebalance was its last activity). The broker WAS up and reachable until about 17:13-17:15 (the adaptive worker proved produce/consume against it; fleet order fomupf08jc has KAFKA-DL and KAFKA-SCRIPTS reviewed PASS and KAFKA-VERIFY still working).

Do (small changes only; other workers are active, do not touch their processes):
1. Read ops/kafka-up.ps1, ops/kafka-down.ps1, ops/kafka-smoke.ps1 and the KRaft config under tools/kafka/config and company/kafka-data/. Find WHY the broker stopped: the broker's own server.log under company/kafka-data/logs, the exit/crash lines, whether kafka-smoke.ps1 or kafka-down.ps1 stops it by design (a restart proof), and whether a failed restart left the data dir or a port lock in a bad state (meta.properties/cluster id mismatch, stale lock, port still in TIME_WAIT).
2. Do NOT kill java pid 14312 unless you confirm it belongs to the stale smoke test of this repo and is blocking the restart; if you stop it, say so. Do NOT touch the KAFKA-VERIFY fleet session (company/fleet/fomupf08jc/KAFKA-VERIFY) or any other jcode worker.
3. Start the broker with `ops/kafka-up.ps1 -IgnoreRamGuard` (the CEO lifted RAM floors; env LAYA_IGNORE_RAM_GUARD=1 is set). Wait for 127.0.0.1:9092 (netstat -ano). Verify produce+consume on `laya.outcomes` with a unique key, then confirm the three topics exist (laya.outcomes, laya.decisions, laya.dlq) via the repo's own topics script.
4. Keep it up: report the broker's java pid and RSS. Say whether it survives 2 minutes idle.
5. If the cause is a script defect (the smoke/down script kills the broker without restarting it), fix it with a minimal diff and parser-check (`[System.Management.Automation.Language.Parser]::ParseFile`, zero errors); note which fleet worker owns that script (KAFKA-SCRIPTS/KAFKA-VERIFY of fomupf08jc) in your report.
6. Do NOT turn on ADAPTIVE_ROUTING, do not restart the router, do not touch Laya or the cuda session. No secrets, no deletes except the stale smoke artifacts you prove are stale.
7. Append a timestamped entry to docs/AGENT_COORDINATION.md. Report to the manager, not the CEO.
