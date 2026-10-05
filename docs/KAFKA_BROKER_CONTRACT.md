# Kafka broker provisioning: shared contract

Repo root = C:\Users\user\Desktop\Default Project. All paths are repo-relative.

## Layout
- tools/_dl/ : downloaded archives and checksum files (gitignored)
- tools/jdk/ : unpacked Temurin 17 so that tools/jdk/bin/java.exe exists (strip the single top-level folder)
- tools/kafka/ : unpacked Apache Kafka 3.x (Scala 2.13) so that tools/kafka/bin/windows/kafka-server-start.bat and tools/kafka/config/kraft/server.properties exist (strip the top-level folder)
- tools/DL_DONE.json : written by DL last. Shape: {"jdk":{"url":"","file":"","bytes":0,"algo":"sha256","sha":"","verified":true},"kafka":{"url":"","file":"","bytes":0,"algo":"sha512","sha":"","verified":true,"version":""}}
- company/kafka-data/ : KRaft log dir, created by up script
- company/kafka-data/broker.pid : PID of the detached broker, written by up script, read and deleted by down script
- ops/kafka-up.ps1, ops/kafka-down.ps1, ops/kafka-topics.ps1 : SCRIPTS
- ops/kafka-smoke.ps1 : VERIFY

## Broker
- 127.0.0.1:9092 only (listeners=PLAINTEXT://127.0.0.1:9092, advertised the same). Single node KRaft, controller on 127.0.0.1:9093.
- KAFKA_HEAP_OPTS=-Xms128m -Xmx256m. JAVA_HOME is set for the child process only, to tools/jdk. No PATH or registry changes.
- Topics: laya.outcomes (3 partitions), laya.decisions (1), laya.dlq (1). All with replication-factor 1, retention.ms=86400000, retention.bytes=268435456.

## Script exit codes
- kafka-up.ps1: 0 = up (or already up), 2 = refused because free RAM < 1.5 GB (prints FREE_RAM_GB and 'use in-process topic'), 3 = tools missing, 1 = other failure.
- kafka-down.ps1: 0 = stopped or not running.
- kafka-topics.ps1: 0 = all 3 topics exist (idempotent, uses --if-not-exists).
