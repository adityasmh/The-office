# Triage of the six stale fleet orders (FLEET-TRIAGE, 2026-10-06)

Read-only triage. No order state was changed, no order was retried/requeued/approved/cancelled, and no source file was edited.

Source of record: `company/fleet/orders.json` (written by `saveFleetOrders()` in `src/company/fleet.ts`). Stale-prompt evidence: `company/assistant.jsonl` at `2026-09-30T12:15:39.587Z`. Root cause: expired/missing Claude CLI OAuth session at the planner step, confirmed by the FLEET-LOGIN note in `company/fleet/fomuo1s1p1/BOARD.jsonl` and `docs/FLEET_LOGIN_ROOT_CAUSE.md`.

The six CEO-facing "Retry this order or drop it?" prompts that were closed as stale at `2026-09-30T12:15:39.587Z` map to the following store ids:

## The six one-line entries

1. `fomunz0ciu` — **RETRY-WORTHY** — submitted `2026-09-30T10:36` — root-cause guard/fix is live, but the requested `docs/FLEET_PLANNING_POSTMORTEM.md` was never written and is still wanted (`company/fleet/orders.json` trace; file check).
2. `fomunz0cbp` — **DUPLICATE of `fomuo5fjcr`** — submitted `2026-09-30T10:36` — same operator-guide + check-script job; `fomuo5fjcr` is done with both work orders PASS and the deliverables exist (`docs/FLEET_OPERATOR_GUIDE.md`, `scripts/fleet_check.py`) (`company/fleet/orders.json`).
3. `fomunyxv8p` — **DUPLICATE of `fomuo5fjcr`** — submitted `2026-09-30T10:34` — same two-fleet-deliverables text; the store marks `supersededBy=fomuo59nn1`, but `fomuo59nn1` is an empty cancelled placeholder, and `fomuo5fjcr` already delivered the intent (`company/fleet/orders.json`).
4. `fomunyyrme` — **DUPLICATE of `fomunyphtc`** — submitted `2026-09-30T10:35` — the canonical chat-UI copy; the companion + live-transcription upgrade shipped via `fomunyp01t`/`fomunyp86b`/`fomunypf44`/`fomunyphtc` (all PASS) and `fomunypg1k` is the live re-review (`company/fleet/orders.json`, work-order reports).
5. `fomunyq2z7` — **DUPLICATE of `fomunyphtc`** — submitted `2026-09-30T10:28` — a user-wording copy of the same chat-UI upgrade; intent already delivered by the done chat-UI orders (`company/fleet/orders.json`).
6. `fomunyqgxm` — **DUPLICATE of `fomump2apz`** — submitted `2026-09-30T10:29` — same `docs/FLEET_SELFCHECK.md` + `ops/fleet-http-probe.ts` deliverables; `fomump2apz` is done with both work orders PASS (`company/fleet/orders.json`).

## Secondary list: earlier login-dead orders

These orders also died at the planning step with no work orders. Source: `company/fleet/orders.json` and `docs/TODAY_QUEUE_2026-10-01.md`.

- `fomunvwzli` (`2026-09-30T09:10`) — chat-UI copy; `supersededBy=fomunypa98`; intent delivered by the done chat-UI orders.
- `fomunypa98` (`2026-09-30T10:28`) — chat-UI copy; `supersededBy=fomunyq2z7`; intent delivered by the done chat-UI orders.
- `fomunypcu4` (`2026-09-30T10:28`) — selfcheck + probe copy; `supersededBy=fomunyqgxm`; intent delivered by `fomump2apz`.
- `fomunyxo58` (`2026-09-30T10:34`) — canonical chat-UI copy; `supersededBy=fomunyyrme`; intent delivered by the done chat-UI orders.
- `fomuo59nn1` (`2026-09-30T13:31`) — empty cancelled placeholder that `fomunyxv8p` points to; the real delivered copy is `fomuo5fjcr`.

### 2026-10-01 planning-failure wave

All died at planning; later live or done orders cover the intent unless noted otherwise (`docs/TODAY_QUEUE_2026-10-01.md` R1–R8 mapping).

- R1 needs-you classifier: `fomupdi1hb` (`10:10`) cancelled, re-issued as `fomupdll58` (`10:12`) failed; still open / RETRY-WORTHY.
- R3 ATR agreement PDF: `fomupdi4my` (`10:10`) cancelled, `fomupdlnhp` (`10:12`) failed; still open / RETRY-WORTHY.
- R5 open/duplicate cleanup: `fomupdi7td` (`10:10`) cancelled, `fomupdlpwc` (`10:13`) failed; superseded by this triage work (`fomuo1s1p1`).
- R6 router hot-path sync I/O: `fomupdi9e9` (`10:10`) cancelled, `fomupdls8r` (`10:13`) failed; superseded by later PERF work (`fomupiu2hf` and follow-ups).
- R8 planner tool-call block: `fomupdq0ml` (`10:16`) failed; superseded by the tool-call fix in `src/company/fleet.ts` / `ops/planner-toolcall-check.ts`.
- PERF item 5 decision cache: `fomupdu7ne`/`fomupe3092` (`10:19`/`10:26`) failed; superseded by `fomupgip2e` (done).
- PERF item 6 mtime/tails: `fomupdu7w2` (`10:19`) failed; superseded by `fomupe3jzs` (done).
- PERF item 8 triage cascade: `fomupdu87j`/`fomupe43re` (`10:19`/`10:27`) failed; superseded by `fomupgip32` (`docs/perf/TRIAGE_CASCADE.md`).
- Kafka broker: `fomupez9em` (`10:51`) failed; superseded by `fomupf08jc` (reviewing).
- VictoriaMetrics: `fomupez9gk` (`10:51`) failed; superseded by `fomupf7f4a` (failed on worker session loss).
- `fomupdchue` (`10:05`) failed on brief delivery, not the planner-login defect; intent covered by outage coordination-log entries.

## What was NOT touched

No `orders.json` mutation, no `/company/fleet/*` POST, no source-file edit, no router restart, no secret printed. This file and `company/fleet/fomuo1s1p1/FLEET-TRIAGE/REPORT.md` are the only files this work order wrote.
