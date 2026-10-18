# Terminals page: see every jcode terminal and talk to it from the dashboard

Written by Claude Code (manager). Built by the jcode session TERMINALS.

## CEO's ask
"See all these running terminals on the UI dashboard, with a description of what task each terminal is doing, so
I can directly talk into that terminal if I want."

## Ownership
TERMINALS owns `src/company/terminalChat.ts` (new), `public/v2/views/terminals.js` (new), and ONLY these routes in
`src/server.ts` (small exact edits): `GET /company/terminals/live`, `GET /company/terminals/:sessionId/tail`,
`POST /company/terminals/:sessionId/message`. AUTOCLOSE (hibiscus) owns the registry (`company/terminals.json`,
`terminalReaper.ts`, `GET /company/terminals`, `.../keep-open`). Read its exports; don't edit its files. Register
`/company/terminals/live` BEFORE any `/company/terminals/:sessionId` route so "live" is not captured as an id.
FLEET-BACKEND's fleet.ts is mid-edit (it currently has type errors), so do NOT import from it. Implement your own
small delivery function; the manager will dedupe later.

## Data (all read-only from `%USERPROFILE%\.jcode\`; never write there)
Discover every jcode session active today:
- `active_pids\<sessionId>` (pid of its client) → alive? `streaming_pids\<sessionId>` present → **working** (generating
  right now); alive and not streaming → **idle / waiting**; client gone → **closed** (show for 2h, then hide).
- `sessions\<sessionId>.journal.jsonl`: meta has `short_name` (e.g. "tigress"), `title`, `updated_at`, `model`,
  `provider_key`. The first user message is the work order.
- The **role** comes from the work order ("You are UI-FLOW" → UI-FLOW; "CRASHFIX", "OPS", ...), or from the
  `docs/AGENT_COORDINATION.md` log lines that name the session (e.g. "UI-SHELL=mizaru"), or from the AUTOCLOSE registry.
  Session **rose** = "CEO's own jcode window".
- The **description**: one plain-words sentence of what the terminal is doing. Take the RunCard headline from
  REPORTING (`listRunCards()` in `src/company/runManagers.ts`, if it exists) when present. Otherwise build it from the
  work order's "YOUR WORK ORDER" text, cut to ~20 words, with no file paths. No Claude call is needed for this page.
- **Last activity** time, plus a **tail**: the last ~30 human-readable lines (assistant text, tool names plus short
  args, and user messages). Strip JSON noise and never show secrets. Redact anything that looks like a key or token.

`GET /company/terminals/live` →
`{terminals:[{sessionId, name, role, description, state:"working"|"idle"|"closed", model, lastActivity, startedAt,
  workOrderExcerpt, runCard?:{headline, done, remaining, verdict}, keepOpen?: boolean}]}`, working first.
`GET /company/terminals/:sessionId/tail?lines=60` → `{lines:[{ts, who:"ceo"|"manager"|"agent"|"tool", text}]}`.

## Talking to a terminal
`POST /company/terminals/:sessionId/message {text}` (needs x-company-token, like every mutation):
- Deliver with `jcode transcript --mode send -S <sessionId>`, text on **stdin** (no quoting problems). Prefix the text with
  `[From the CEO via the dashboard] ` so the agent knows who is talking.
- Verify delivery: wait up to 20s for the text to appear as a user message in that session's journal. Return
  `{ok, how:"targeted", detail}`. If `-S` fails, return ok:false with the error. **Never** fall back to the
  focus-based method from this page, because it could land in the wrong terminal.
- Log each message to `company/reports/terminal-messages.jsonl` (ts, sessionId, text) and add a trace-style line
  to the coordination log only if the text looks like an instruction (keep it short).
- Refuse (400) if the session is closed.

## UI (`#/terminals`, built on the v2 contract in docs/UI_V2_SPEC.md)
- A grid of cards, one per terminal, working first. Card: name + role badge, state dot (green = working, pulsing;
  grey = idle; dark = closed), the description sentence, model, "active 2m ago", and, if there is a RunCard,
  ✅ done / ⏳ remaining counts plus the verdict.
- Clicking a card opens a side panel (full screen on a phone): the live tail (monospace, auto-scroll, polled every 3s),
  the work order (collapsible), and at the bottom a **chat box**: "Message tigress…", Enter sends, then a
  delivered ✓ / failed ✗ receipt. The CEO's messages appear in the tail when the terminal reads them.
- Filters: all / working / idle / closed; search by name or role.
- Warn in the chat box when the terminal is mid-generation: "It's busy — your message will be read when it finishes
  its current step."
- `?mock=1` sample data until the routes are live. Ask UI-SHELL (mizaru) in the coordination log for a
  "Terminals" nav item (second, after Briefing).

## Proof (real output in docs/AGENT_COORDINATION.md)
1. `GET /company/terminals/live` on a test server (SLACK_BRIDGE=0, other PORT, temp COMPANY_ROOT; it reads the real
   `%USERPROFILE%\.jcode` read-only) lists today's sessions (rose, tigress, duckling, piglet, mizaru, kikazaru,
   iwazaru, retriever, pawprint, bonehound, sabertooth, mushroom, cactus, clover, hibiscus, blossom, tulip...) with
   correct roles and descriptions.
2. One real message delivered to YOUR OWN session with `-S` and verified in its journal. Do not message other terminals
   while testing.
3. `npx tsc --noEmit`: your files are clean (fleet.ts currently has errors that belong to FLEET-BACKEND; list them
   separately). Router restart: ask in the log. OPS/CRASHFIX restart when tsc is clean and no task is in flight.
