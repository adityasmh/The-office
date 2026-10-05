# AGENT_TALK STEP A — can a message be delivered into ONE running jcode session?

Order: TALK-A (docs/ORDER_2026-10-06_talk-step-a.md). Measured 2026-10-06, ~03:48-03:56 local.
New files: `ops/talk-probe.ps1`, this document. Nothing under `src/` was touched.

**Verdict (short).** Targeted live delivery works for an **IDLE** session:
`jcode transcript --mode send -S <sessionId>` with the text on stdin. It cannot land in another
session, does not use or change the CEO's focus file, and the text is visible as a user message in
under 1 s. It is **not** safe to inject while the target is mid-generation: one measurement, a send
into a busy session left no trace anywhere. So: deliver only when idle, verify, and keep the
mailbox + two fixed inbox reads as the guaranteed path (the busy case falls back to the next tick).

## 1. Methods that can target one session id (exact commands)

| Method | Command | Targeted by id? | Exercised |
|---|---|---|---|
| transcript inject (the fleet's method) | `jcode transcript --mode send -S <sessionId>` (text on stdin) | yes | **yes, proven** |
| debug socket message | `jcode debug -S <sessionId> message:<text>` (`-w` waits) | yes (`-S, --session`) | no |
| debug socket client submit | `jcode debug -S <sessionId> client:message:<text>` | yes | no |
| debug socket display-only inject | `jcode debug -S <sessionId> client:inject:<role>:<text>` (no send) | yes | no |
| debug socket swarm DM | `jcode debug -S <sessionId> swarm:notify:<sid> <msg>` | yes (swarm members only) | no |
| focus-based transcript | `jcode transcript --mode send` (no `-S`) | **no** (uses `%USERPROFILE%\.jcode\last_focused_client_session`) | no |
| resume + focus send | `jcode --resume <sessionId>` then focus-based send | no | no |
| dictation | `jcode dictate ...` | no (last-focused client) | no |

Read from `jcode --help`, `jcode transcript --help`, `jcode session --help` (only `rename`),
`jcode debug --help`/`jcode debug help`. The `jcode debug` family was **not executed**: it drives the
shared server, and this order allowed only one throwaway session (the `transcript -S` path itself
also goes through the shared jcode server, which the throwaway session is a client of).

How the fleet already does it (`src/company/fleet.ts`, read-only):
- `deliverInto()` (line ~1523): primary `jcode transcript --mode send -S <sessionId>` with the text on
  stdin; `waitForMarker()` polls `sessionHasMarker()`; the focus-based method is only a fallback and it
  waits for `last_focused_client_session` to equal the target.
- `sessionHasMarker()` (line ~726): checks the session **snapshot** `sessions/<id>.json` messages
  first, then the **journal** `sessions/<id>.journal.jsonl` — a plain substring search.
- `src/company/terminalChat.ts` `sendTerminalMessage()` (line ~1023): targeted only, **no**
  focus fallback, same `-S` command, then a count-increase check over journal+state files.

## 2. `ops/talk-probe.ps1`

```
powershell -NoProfile -ExecutionPolicy Bypass -File ops/talk-probe.ps1 -SessionId <id> -Text "<text>" [-TimeoutSeconds 20] [-Needle "..."]
```
- sends once with `jcode transcript --mode send -S <sessionId>` (UTF-8 stdin, `jcode` or `$env:JCODE_BIN`);
- polls read-only for up to 20 s and prints `delivered in N s` or `NOT delivered`, the method, the
  jcode exit code and, on success, the stored text it matched;
- refuses an empty session id (exit 2) and an empty text (exit 2);
- never falls back to the focus-based method and never references `last_focused_client_session`;
- writes nothing under `%USERPROFILE%\.jcode`.

What "appears as a user message" turned out to mean (measured, see §4a): the injected text lands in the
**snapshot** `sessions/<id>.json` as `role=user`, `content[].type=text`, prefixed `"[transcription] "`.
The **journal** does not hold a user message for a session's **first** turn at all (it records the
assistant reply, and for the first injection only `meta.title = "[transcription] <text>"`); from the
second turn on it does record the injected user message as its own journal line. The probe therefore
polls both files. A journal-only, role-based check reports a **false `NOT delivered`** on a session's
first turn — that is exactly what the probe's first version did on message 1.

## 3. The throwaway session

Started the fleet way (`launcherScript()` → a visible PowerShell window running `jcode -p opencode-go`
with the temp folder as the working directory; the window was minimized):

- temp working dir: `C:\Users\user\AppData\Local\Temp\talk-step-a-20261006-034807` (contains only
  `run.ps1`, 112 bytes — nothing important; left in place, not deleted)
- window pid 22640 (powershell, cmdline points at that temp `run.ps1`), jcode child pid **24968**
  (`"C:\Users\user\AppData\Local\jcode\bin\jcode.exe" -p opencode-go`)
- session id **`session_deer_1791238714141_ffca83e60e4d41f0`** (`client_sessions/24968` maps to it,
  `working_dir` = the temp folder)
- at start: **no journal, no snapshot** — only `client_sessions/<pid>`. `streaming_pids/<id>` absent and
  no turn in flight = idle. The journal cannot exist before the first turn (fleet.ts says the same), so
  "wait until its journal exists" was satisfied only after message 1. Exact error text on the very
  first read attempt: `Get-Content : Cannot find path 'C:\Users\user\.jcode\sessions\session_deer_...json' because it does not exist.`
- closed at the end after verifying its command line and the pid→session mapping:
  `taskkill /PID 22640 /T /F` → `SUCCESS: The process with PID 9452 / 24968 / 22640 ... has been
  terminated.` The four pre-existing `jcode.exe` (16144, 19452, 26844, 30340) were still running
  afterwards; nothing else was touched.

Budget: exactly 4 test messages were sent (`Reply with the single word ok.`, `Count slowly from one to
thirty, one number per line, then say done.`, the quotes/newline/unicode text, `Say yes.`).

## 4. Experiments

| # | Test | Result | Latency | Notes |
|---|---|---|---|---|
| a | msg 1 while **IDLE**: `Reply with the single word ok.` | **DELIVERED**, and the session answered `ok` | send `exit=0 in 64ms`; user message in the snapshot at 03:52:09.664 (~0.4 s after the send); journal record with the answer at 03:52:13.118 (~3.8 s) | probe v1 (journal-only) printed `NOT delivered` = **false negative** (see §2). Stored text: `[transcription] Reply with the single word ok.` |
| b | msg 2 while **IDLE** to create a busy turn, then msg 3 sent **0.6 s later while BUSY** | msg 2: DELIVERED in 0.6 s, answer complete (`1..30` + `done`), **not** interrupted. msg 3: **no trace at all — not queued, not recorded; evidence points to LOST** | msg 2: send `exit=0 in 59ms`, journal user line 03:53:57.656, turn end 03:54:01.470. msg 3: probe ran its full 20 s | msg 3 text is absent from the journal, the snapshot **and** the jcode client log (`%USERPROFILE%\.jcode\logs\jcode-2026-10-06.log`, no deer line between 03:54:01.607 and 03:54:18). The probe's own stdout for msg 3 was not captured and that tool call ended after ~20.1 s without an exit code; no probe or jcode process was left behind. So: at best unverified, and nothing was queued for the next turn |
| c | msg 4 to a made-up id `session_ghost_1791239999999_deadbeefcafe0001` | **FAILS CLEARLY** | `exit=1 in 37ms` | no `session_ghost*` file was created; no other session's file gained the text (the only file containing `Say yes.` before and after is my own session's, which holds the order text); the focus file's **value** never changed (`session_deer_...`). Its mtime did bump, but a control sample shows the same bump happens with no send at all (03:56:00.385, then stable for 30 s), so mtime is not evidence about the send |
| d | msg 3 text with a `"` and `'` quote, a newline and unicode (`café → ünïcode ✓`, built from code points, UTF-8 stdin like the fleet) | **NOT OBSERVED** | — | message 3 was the carrier (sent while busy) and it left no trace, so intactness could not be read. Merging d into the busy send is what kept the run inside the 4-message cap. The probe encodes stdin as UTF-8 without BOM, the same as `fleet.ts` `runJcode` (which sends with `stdin` UTF-8), but that is not proof |

## 5. Every exact error text seen

- Bad session id (the method's own error, the useful one):
  `Error: Session 'session_ghost_1791239999999_deadbeefcafe0001' does not have a connected TUI client for transcript injection`
  (exit code 1, 37 ms; stderr).
- First read of the fresh session (no snapshot yet, not an experiment error):
  `Get-Content : Cannot find path 'C:\Users\user\.jcode\sessions\session_deer_1791238714141_ffca83e60e4d41f0.json' because it does not exist.`
- Harness error while building the throwaway launcher (my quoting bug, no session was created; the
  botched window was verified and closed before retrying): the launcher was written as one line and
  PowerShell reported `Unexpected token 'Host.UI.RawUI.WindowTitle' in expression or statement.` /
  `+ CategoryInfo : ParserError: (:) [], ParentContainsErrorRecordException`.
- Message 3: no error text exists to quote — the send left no record and its probe output was lost.

## 6. Is a mutex needed?

- **For focus safety: no.** The targeted method never reads or writes
  `last_focused_client_session` (verified: its value never changed across the bad-id send, and the
  probe has no reference to that file). It therefore cannot steal the CEO's focus.
- **A mutex is needed for the focus-based fallback only** — and then a real one. Recommendation: do not
  use the fallback for fleet talk at all.
- **Per-session serialization: yes.** Two senders injecting into the same session at the same moment
  can both reach the same input buffer, so the watcher needs one delivery at a time per session
  (a per-session lock, not a global mutex).

## 7. Is queued delivery while the session is busy safe?

**No, and do not rely on it.** The spec's own rule ("if X is mid-generation, it waits for the next
tick") is the right one. The single busy-time send was not visible as a user message afterwards and
was never taken up when the turn ended, so a queued message cannot be assumed to survive. Idle-only
delivery plus the mailbox solves this: the text stays on `BOARD.jsonl` and the worker picks it up at
its next fixed `inbox` read.

## 8. Recommendation

**Targeted live delivery works, for an IDLE session — use
`jcode transcript --mode send -S <sessionId>` (text on stdin, UTF-8), with these limits:**

1. The session must have a **connected TUI client** on the same jcode server; otherwise the command
   exits 1 with the exact error in §5 within ~40 ms. A closed or headless session cannot receive talk.
2. **Send only when idle** (`streaming_pids/<id>` absent and no turn in flight). While busy the text
   was not recorded and may be lost (§4b). In the fleet watcher, keep the "wait for the next 5 s tick"
   rule and re-check idleness immediately before the send.
3. **Verify by reading the session's own files, both of them:** `sessions/<id>.json` (snapshot,
   `role=user`/`type=text`, `"[transcription] "` prefix, ~0.4 s when idle) and
   `sessions/<id>.journal.jsonl` (records the injected user message from the second turn on). A
   journal-only check gives a **false `NOT delivered`** on a session's first turn. Expected time to
   proof when idle: **under 1 s**; a busy/queued send shows nothing even after 20 s.
4. Keep the **mailbox + two fixed inbox reads** as the guaranteed path, exactly as the spec says:
   live delivery is an optimisation for a worker that is idle, the board is what makes talk reliable.
5. Treat a bad session id as a hard failure (exit 1) — never retry it on another session, and never
   fall back to the focus-based method.
6. `ops/talk-probe.ps1` is the ready-made probe for the watcher: same command, refuses an empty id,
   no focus fallback, prints `delivered in N s` / `NOT delivered`.

## 9. Open items (not covered, budget-capped)

- Message 4 (quotes/newline/unicode) intactness is unmeasured (§4d). One extra idle send with such a
  payload would settle it; the probe stores the matched text, so it is a one-line check.
- The busy-time behaviour has exactly one measurement and it is a negative one; a clean re-test
  (a long turn, then a second idle-gated send) would turn "points to LOST" into a firm statement.
- `jcode debug -S <id> message:<text>` was not tried. It may be a cleaner in-process path (no TUI
  injection), but it drives the shared server and was out of scope for this order.
