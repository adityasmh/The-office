# CEO inbox: approve or answer straight from the Briefing (CEO-ordered)

Written by Claude Code (manager). Backend: the new session INBOX. UI: clover (BRIEFING-UI). Sources: mushroom (REPORTING)
and each owner below.

## Goal
Every "Needs you" item in the Briefing is actionable in place: an **approval** shows Approve / Reject (with an optional
note); a **question** shows the exact question with a reply box (or option buttons). The answer goes straight back to
whoever asked, so there's no back and forth through the manager.

## Backend (INBOX owns `src/company/inbox.ts`, `company/inbox/`, and ONLY the `/company/inbox*` routes in `src/server.ts`)
```ts
type InboxItem = { id: string; kind: "approval" | "question" | "choice"; title: string /* plain words, ≤15 words */;
  question: string; options?: string[]; context?: string /* short, plain; details behind a toggle */;
  source: { type: "task-gate" | "fleet-plan" | "fleet-redo" | "terminal" | "assistant" | "budget" | "run-card";
            id: string; projectId?: string; sessionId?: string; gate?: "intake"|"code"|"merge" };
  status: "open" | "answered" | "expired"; createdAt: string; answeredAt?: string;
  answer?: { decision?: "approve" | "reject"; text?: string; option?: string; via: "dashboard" | "slack" } };
```
- `askCeo(item)` (dedupes on source + question), `listInbox({status})`, `answerInbox(id, answer)`.
- Routes: `GET /company/inbox?status=open`, `POST /company/inbox/:id/answer` (token required).
- **Delivery of the answer** (the core of the feature), by source type:
  - `task-gate` → call the existing approve endpoint logic (approveGate + resumeTask). A reject sets the task `rejected`
    with the note.
  - `fleet-plan` / `fleet-redo` → fleet.ts approve / redo / cancel (bonehound exports; ask it for the function names).
  - `terminal` (a jcode worker asked something) → `jcode transcript --mode send -S <sessionId>` with
    "[CEO answer via dashboard] <question> → <answer>", verified in the journal (same method as terminalChat.ts).
  - `assistant` → append to the assistant thread as the CEO's reply and let the assistant continue.
  - `budget` → e.g. "Allow Kimi for this order despite amber?" → sets a one-time override that BUDGET's guard honours.
- **Sources that create items** (send each owner a targeted request with the exact `askCeo` call to add):
  - pipeline gates waiting on a human (pipeline.ts waitGate, owner crocodile/RESUME);
  - Fleet plans awaiting approval and REDO decisions (bonehound);
  - run cards with `needsCeo` (mushroom/REPORTING): when a worker's journal ends with a question to the CEO/manager,
    the run manager extracts the exact question and calls askCeo with `source.type="terminal"`;
  - the assistant, when it needs a decision (assistant.ts, shared, so coordinate in the log);
  - budget red/amber overrides (otter/BUDGET).
- **Slack:** post each new item once, with how to answer; a Slack reply in that thread answers it too (rose's
  slackInbound.ts owns inbound; ask rose for the hook). The first answer wins, and the other channel shows "answered via X".
- Expire items when the underlying thing resolves by itself (the gate got approved elsewhere, the session closed).

## UI (clover owns `public/v2/views/briefing.js`)
In "Needs you": each item shows its title and question. Approval → **Approve** (primary) / **Reject** + an optional note.
Question → the question in full + a reply box (Enter sends) or option buttons. After answering: "Sent to <who> ✓" and
the item moves to a collapsed "Answered" list. A count badge in the top bar (ask eagle/UI-CLEAN) and on the nav item.
Plain words. The CEO wants it useful, not pretty.

## Proof (real output in docs/AGENT_COORDINATION.md)
One of each on the live system: a pipeline task gate approved from the Briefing and resuming; a question from a
throwaway jcode session answered in the UI and arriving in that session's journal; a Fleet plan approved. Plus
`npx tsc --noEmit` clean.
