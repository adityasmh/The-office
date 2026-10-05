# Agent-to-agent talk for fleet workers (scope only, nothing built yet)

Status: PROPOSED 2026-10-06. Owner: manager scopes, workers build (narrow orders, guard wrapper, flash only).

## Goal
Workers on the same order can ask each other things and hand work over while they run, instead of only meeting at the final review. Example: the worker changing an API tells the worker that calls it, or a worker asks the owner of a file a question instead of guessing.

## Why it needs hard limits
Our worst past waste came from workers that looped and re-read each other's logs (docs/WORKER_GUARD.md). Free-form chat between agents is that failure with a bigger blast radius. So talk is a bounded mailbox, not an open channel.

## Today (verified 2026-10-05)
- Fleet workers are separate jcode sessions. They share the repo but have no channel to each other.
- `src/company/agentchat.ts` gives dashboard agents per-agent threads and a queue; fleet workers do not use it.
- Pushing text into a running jcode session is focus-based and racy (docs/FLEET_SPEC.md), so delivery cannot rely on it.

## Design: manager-side mailbox
State: `company/fleet/<orderId>/BOARD.jsonl` (append-only). One line per message:
`{id, ts, from, to, kind, text, inReplyTo?}` with `kind` one of `note | question | answer | handoff`. `from` and `to` are work order ids (`to:"*"` = everyone on the order).

Worker tools (two small scripts the brief tells the worker about, no model call):
- `ops/agent-msg.ps1 send -To <woId> -Kind question -Text "..."` appends one line to BOARD.jsonl and returns at once. It never waits for a reply.
- `ops/agent-msg.ps1 inbox` prints only messages addressed to this worker that it has not seen.

Delivery (the watcher does it, workers never poll):
- The 5 s watcher tick sees a new message for work order X. If X's session is idle or between steps, it delivers the message by the targeted mechanism chosen in step A below. If X is mid-generation, it waits for the next tick.
- Workers also run `inbox` exactly twice by instruction: once at the start and once just before writing REPORT.md. That is a plain one-shot read, never a loop.

## Hard limits (enforced by the script and the watcher, not by the prompt)
- Max 6 messages sent per worker per order; max 2 question-answer rounds between any pair; max 400 characters per message.
- A question with no answer after 10 minutes is closed with `kind:"answer"`, text "no reply", so nobody waits.
- A worker that sends the same text twice, or a message to itself, is refused.
- Messages never carry file contents, only short facts and file paths.
- The existing worker guard also treats a worker whose last 5 lines are all `agent-msg` calls as a loop and kills it.
- `FLEET_TALK=0` turns the whole thing off and is the default until proven.

## Review and audit
- Every message is added to the order trace, so the Flow view shows who asked whom what.
- The Claude review sees the board for that work order and can mark REDO if a worker ignored an answer that changed its task.

## Build steps (each a narrow worker order)
- A. Investigate and pick the targeted delivery mechanism for a running jcode session (jcode --help, debug socket, `jcode session`, resume plus message), proven on a throwaway session. Fall back to the transcript-send method only with a serialized mutex.
- B. `src/company/fleetTalk.ts` plus `ops/agent-msg.ps1`: board file, limits, redaction of tokens, unit proof in a temp COMPANY_ROOT.
- C. Hook into the fleet watcher tick and brief template, plus guard rule and trace steps.
- D. Dashboard: a small "talk" strip on the order view.

## Acceptance
One real small order with two workers where worker 2 asks worker 1 one question, gets the answer inside the limits, and both finish with reports; the board shows exactly 2 messages; with `FLEET_TALK=0` nothing changes.

## Open decision for the CEO
Delivery in step A decides how reliable this is. If no targeted mechanism exists, the safe fallback is note-only talk (workers leave notes that peers read at their two inbox reads, no live interruption). That is much simpler and cannot disturb a running session.

Status 2026-10-06: scoped only, nothing built yet.
