# REPORT R4-agent-mailbox

Order: `docs/overnight/ORDER_R4-agent-mailbox.md` (2026-10-06). Status: **DONE, all proof lines PASS**.

Mailbox for workers on one order: an append-only board file, a CLI (`ops/agent-msg.ts`), hard
limits enforced in code, a "Teammates" block in each brief, and one trace hop per new board line.
Off by default behind `FLEET_TALK=1`.

## Files and changed line ranges

| File | Change | Lines |
|---|---|---|
| `src/company/fleetTalk.ts` | **new** mailbox module (board, limits, redaction, inbox, commands) | 1-301 |
| `ops/agent-msg.ts` | **new** CLI: `send` and `inbox` | 1-111 |
| `ops/agent-talk-check.ts` | **new** proof script, temp COMPANY_ROOT | 1-266 |
| `src/company/fleet.ts` | import of the mailbox helpers | 58-60 |
| `src/company/fleet.ts` | `teammatesSection()` + doc comment | 1618-1636 |
| `src/company/fleet.ts` | Teammates block appended in `briefBody()` | 1656 |
| `src/company/fleet.ts` | watcher trace hop per new board line, once | 3807-3826 |
| `src/company/envReload.ts` | `FLEET_TALK` added to the reload allow-list | 50-51 |

No existing file was rewritten; every edit is an insertion. No deletes. `company/`, Laya, Kafka,
scheduled tasks and `.env` were not touched.

## What was built (as ordered)

- `FLEET_TALK=1` turns talk on; unset is OFF and every entry point refuses.
- Board `company/fleet/<orderId>/BOARD.jsonl`, append-only, one `{id, ts, from, to, kind, text}`
  per line; `kind` in `note|question|answer|handoff`; `to` a work order id or `*`.
- `fleetTalk.ts` exports `postMessage`, `readInbox(orderId, woId, sinceId?)`, `limitsFor` (plus
  `readBoard`, `readNewMessages`, `markSeen`/`seenId`, `traceMark`/`setTraceMark`,
  `sendCommand`/`inboxCommand`, `talkEnabled`, `redactTokens` used by the fleet and the CLI).
- Hard limits in code: 6 messages per work order per order; 2 question-and-answer rounds per
  pair; 400 characters; no empty text; no self message; no exact duplicate of the sender's
  previous text; sender and named recipient must be work orders of that order; token-shaped
  strings replaced with `[redacted]`.
- `ops/agent-msg.ts`: `send ...` and `inbox ...`, talks to the board file directly (no server),
  plain refusal text and exit 1 on a limit; state file `BOARD.seen.json` beside the board so
  `inbox` shows each message once.
- `fleet.ts`: with `FLEET_TALK=1` and 2+ work orders, each brief gets a short `TEAMMATES` block
  (peer ids, roles, owned files, the exact send/inbox commands with its ids, and the two rules).
  The watcher adds one `from:"Fleet"`, `what:"worker message"` hop per new board line, once,
  watermark in `BOARD.trace.json`. No live session delivery in this step.

## Commands and exact output

`npx tsc --noEmit` (run once) - clean, no output.

`npx tsx ops/agent-talk-check.ts` (final run, once) - **ALL CHECKS PASSED**:

```
# throwaway COMPANY_ROOT=C:\Users\user\AppData\Local\Temp\agent-talk-Fx7ruk\company
# FLEET_TALK off by default; no server, no network, no terminal

PASS  off by default (brief identical, posting refused) -- talk is off (set FLEET_TALK=1)
PASS  post and read round trip -- 1 on the board
PASS  '*' reaches everyone but the sender -- B sees 2, A sees 0
PASS  inbox shows each message once (seen watermark) -- first=2 second=0
PASS  limitsFor reports the hard limits -- {"maxMessagesPerOrder":6,"maxRoundsPerPair":2,"maxChars":400}
PASS  7th message refused with a plain reason -- WO-A already sent 6 messages on ORD-CAP
PASS  3rd question-and-answer round refused with a plain reason -- 2 question-and-answer rounds between WO-A and WO-B are already used
PASS  401 characters refused -- message is longer than 400 characters
PASS  message to itself refused -- a work order cannot send a message to itself
PASS  exact duplicate of the sender's previous text refused -- that is an exact duplicate of your previous message
PASS  foreign sender refused -- WO-ZZ is not a work order of ORD-FOREIGN
PASS  a fake token is redacted -- the key is [redacted] ok
PASS  Teammates section only with 2+ work orders -- solo=none
PASS  the command line tool works end to end (inbox once per message) -- sent m000001: WO-A -> WO-B (note) | m000001 WO-A -> WO-B [note] cli hello | inbox: no new messages for WO-B
PASS  the command line tool prints a plain error and exits 1 on a refusal -- agent-msg: refused: WO-ZZ is not a work order of ORD-CLI ...
PASS  the watcher traces each new board line once -- after tick 1: 1, after tick 2: 1 (WO-A -> WO-B [handoff] trace me please)

ALL CHECKS PASSED
```

The proof runs against a throwaway `COMPANY_ROOT`/`FLEET_REPO` in `%TEMP%`, with
`MIN_FREE_RAM_MB=1000000` so the tick's `fillSlots()` stops at its RAM floor: no server, no
network, no terminal spawned.

### One failure, reported honestly

The first proof run had **1 FAIL**, not a product defect: the trace check read
`company/fleet/orders.json` straight after `tickFleet()`, but `saveFleetOrders()` writes through
an async queue, so the file had not been written yet.

```
FAIL  the watcher traces each new board line once -- after tick 1: 0, after tick 2: 0
```

Fixed in the proof only (read the post-tick value via `fleet.loadFleetOrders()`, which tickFleet
mutates synchronously). The final run above is the result after that one fix, not a retry loop.

## Open issues

- Live idle delivery into a running session (step C in `docs/AGENT_TALK_SPEC.md`) is **not** in
  this step; only the board + the two fixed inbox reads are.
- The "2 rounds" cap counts questions between a pair in both directions combined (the stricter
  reading of "between any pair"); an `answer` never counts toward it.
- Redaction is shape-based. It catches prefixed keys (`sk-`/`rk-`/`ghp_`/`github_pat_`/`xox*`/
  `AKIA`), JWTs, `Bearer ...`, and long base64-ish blobs. A secret with no recognisable shape
  still passes (the 400-char cap and the two-read discipline are the remaining guards).
- The board is per-order at `company/fleet/<orderId>/BOARD.jsonl`; `BOARD.seen.json` and
  `BOARD.trace.json` sit beside it. Nothing reads or writes `%USERPROFILE%\.jcode`.
- `FLEET_TALK` reaches a worker's shell through the router's own environment (visible windows
  inherit it), which is the intended switch; `ops/agent-msg.ts` deliberately does not read `.env`.
