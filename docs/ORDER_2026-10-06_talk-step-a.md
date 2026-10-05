# Order TALK-A: can a message be delivered into a RUNNING jcode session, reliably and to the right session?

Narrow investigation. Do exactly these steps, print the final report, and END your turn. Do not wait, poll, loop, or re-read this order. Read `docs/AGENT_TALK_SPEC.md` first (section "Design" and "Build steps", step A).

## What we need to know
Agent-to-agent talk needs the manager side to push a short text message into ONE specific running worker session, without racing with the CEO's focus, and then see proof that the session received it. The fleet already does this for the FIRST brief of a newly opened terminal (`jcode transcript --mode send -S <sessionId>`, see `deliver` and `targeted` in `src/company/fleet.ts`). Step A answers: does that same targeted method work for later messages, and what happens when the session is idle versus busy?

## Rules
- You may create ONLY these files: `docs/AGENT_TALK_STEP_A.md` and `ops/talk-probe.ps1`. Edit nothing else, in particular NO file under `src/`.
- Read-only toward everything that exists: never send anything to, signal, close or otherwise touch any existing jcode session, window, process, the shared jcode server, the router on :8787, Laya, Kafka or any scheduled task. Never write into `%USERPROFILE%\.jcode` (read only).
- You may start exactly ONE throwaway jcode session for the experiment: provider `opencode-go`, working directory a new temp folder under `%TEMP%`, started the same way the fleet starts a visible terminal (read `src/company/fleet.ts` for the launch command; a minimized window is fine). Record its process id and session id. Only that process may be closed by you at the end, and only after you checked its command line really is your throwaway session.
- Budget: at most 4 test messages in total, each a tiny text such as `Reply with the single word ok.` or `Say yes.`. Never ask it to edit or read project files. Do not print secrets.
- Run each command ONCE, in the foreground. If a step fails, record the exact error in the report and END your turn; do not retry in a loop.

## Steps
1. Read-only survey. Run `jcode --help`, `jcode transcript --help`, `jcode session --help` and `jcode debug --help` (and the help of any subcommand that looks like it sends a message to a session). Read how `src/company/fleet.ts` delivers a brief and how it verifies delivery. List every method that could target a specific session id.
2. Write `ops/talk-probe.ps1`: given a session id and a text, send it with the best targeted method found in step 1, then poll that session's journal (`%USERPROFILE%\.jcode\sessions\<id>.journal.jsonl`, read only) for up to 20 seconds until the text appears as a user message; print `delivered in N s` or `NOT delivered` and the method used. It must refuse an empty session id and must never fall back to the focus-based method.
3. Start the throwaway session. Wait until its journal exists and it is idle.
4. Experiment (record time-to-delivery and what the session did, for each):
   a. Send message 1 while the session is IDLE. Did it arrive, and did the session answer?
   b. Send message 2 immediately after, so the session is BUSY generating. Was it queued, did it interrupt the answer, or was it lost?
   c. Send message 3 to a session id that does not exist (use a made-up id). Does it fail clearly and without touching any other session? Check that the CEO's last-focused session file `%USERPROFILE%\.jcode\last_focused_client_session` was not read or changed by the targeted method.
   d. Send message 4 with text containing quotes, a newline and a unicode character. Does it arrive intact?
5. Close ONLY your throwaway process (verify its command line first), and confirm the temp folder keeps nothing important. Do not delete anything else.
6. Write `docs/AGENT_TALK_STEP_A.md` with: the methods found (with the exact commands), a table of experiments a to d (result, latency, notes), whether a mutex is needed, whether queued delivery while busy is safe, and a clear recommendation: either "targeted live delivery works, use method X with these limits" or "not reliable, use note-only talk (workers read a mailbox at two fixed points)". Include every exact error text you saw.

## Finish
Print the same report and END your turn. Do not edit `docs/AGENT_TALK_SPEC.md`; the manager updates it.
