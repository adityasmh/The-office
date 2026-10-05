# Reporting chain + the CEO's assistant

Written by Claude Code (manager). Built by the jcode sessions REPORTING, ASSISTANT-BRAIN and BRIEFING-UI.

## The problem (CEO's words)
"Looking at so many sessions running it is difficult for me to keep track." The CEO wants every run watched by a
manager, with updates coming UP the chain as a plain-words checklist: **what's done, what's remaining**. They also
want one assistant they can talk to properly, which knows everything across projects and managers and delegates
new work using Laya.

## 1. Run managers (REPORTING owns `src/company/runManagers.ts`)
A **run** is either a company pipeline task (`company/projects/*/tasks.json`, with `trace`) or a fleet work order
(`company/fleet/orders.json`, a jcode session; see docs/FLEET_SPEC.md; FLEET-BACKEND is building it now, so read
its files and handle their absence gracefully). Live jcode sessions not started by the fleet (rose, OPS, CRASHFIX,
UI-*) count as runs too: discover them from `%USERPROFILE%\.jcode\sessions\*.journal.jsonl` (read-only; meta +
the first user message = the work order) and match them to their entries in `docs/AGENT_COORDINATION.md` by
session name.

Every run gets a **manager check**: a Claude call that reads the run's evidence (the work order, trace/thread,
the journal tail, REPORT.md, the files it changed) and returns a **run card**:
```ts
type RunCard = { runId: string; kind: "task"|"fleet"|"jcode"; title: string; owner: string /* e.g. "jcode kikazaru (UI-ASSISTANT)" */;
  state: "working"|"stuck"|"done"|"failed"|"waiting_for_ceo";
  headline: string;          // one sentence a non-engineer understands
  done: string[];            // plain words, most important first, max 6
  remaining: string[];       // plain words, max 6
  needsCeo?: string;         // only if the CEO must decide/do something
  model: string; modelReason: string; checkedAt: string; evidenceHash: string };
```
Rules:
- **Model choice (Laya + guard rails):** first check Laya `GET {LAYA_BASE_URL}/health`. If it is up, call `classifyBrain`
  from `src/decision.ts` on the run's order. Use its pick only if confidence ≥ `RUN_MANAGER_LAYA_MIN_CONF` (default 0.35).
  Otherwise use **Sonnet**. **Always Opus** when the run is failed/stuck, or when REDO happened twice. If Laya is down,
  use Sonnet and record `modelReason: "Laya offline"`. (Laya answered today but with confidence 0.03 on this
  question, so the guard rails matter.) Put the choice in `model`/`modelReason`.
- **Cost control:** re-check a run ONLY when its evidence changed (`evidenceHash`), at most once per
  `RUN_MANAGER_MIN_INTERVAL_S` (default 180s) per run, max `RUN_MANAGER_CONCURRENCY` (default 2) Claude calls at once.
  Done/failed runs get one final card and are never re-checked. Use `callClaudeSubscription` (Claude Code CLI,
  read-only tools) with `cwd` = repo and `addDirs` = company root.
- **Stuck detection** without Claude: no journal/trace activity for `RUN_STUCK_MINUTES` (default 15) while not done
  → state `stuck`.
- Store the cards in `company/reports/runs/<runId>.json`, with history appended to `company/reports/runs.jsonl`.

## 2. The CEO briefing (REPORTING owns `src/company/briefing.ts`)
Rolls all run cards up into ONE page for the CEO, regenerated (Sonnet, or Opus if anything failed) only when a
card changed, and at most every `BRIEFING_MIN_INTERVAL_S` (default 300s):
```ts
type Briefing = { generatedAt: string; model: string;
  summary: string;                 // 2-3 sentences, plain words
  needsYou: { text: string; runId?: string }[];      // decisions/actions only the CEO can take — FIRST
  done: { text: string; runId?: string; at: string }[];         // since the last briefing the CEO opened
  inProgress: { text: string; runId?: string; owner: string; remaining: string[] }[];
  problems: { text: string; runId?: string }[];
  counts: { running: number; done: number; failed: number; stuck: number } };
```
Plain-language rules for every string a CEO reads: no file paths unless asked, no jargon (say "the dashboard
rebuild", not "public/v2/views/flow.js"), a person or team name for owner ("UI team: Flow page"), past tense for
done, max ~15 words per item.
Endpoints (read = loopback-exempt like the other GETs; mutations need the token):
- `GET /company/briefing` → the latest Briefing. `POST /company/briefing/refresh` → force regeneration.
- `GET /company/runs` → all RunCards (newest activity first). `GET /company/runs/:runId` → card + history.
- `POST /company/briefing/seen` → marks now as "last opened" (drives "done since last time").
**Slack:** when the briefing changes in a way that matters (a run finished, failed, got stuck, or a new needsYou item),
post ONE short message via `postAs` in `src/slack.ts` (✅ done / ⏳ remaining / ❗ needs you). Never more than one post per
`BRIEFING_SLACK_MIN_INTERVAL_S` (default 600s) unless there is a new needsYou item. Do not edit `slackInbound.ts`
(rose owns it).
Routes: add ONLY the `/company/briefing*` and `/company/runs*` routes to `src/server.ts` with small exact edits, and start
the watcher loop (every 30s, fully guarded; it must never crash the process) after listen.

## 3. The assistant (ASSISTANT-BRAIN owns `src/company/assistant.ts`)
Keep all existing behaviour (Laya team pick, trace hops, reportBack, the free/Claude model switch, ceoContext) and add:
- **Real conversation:** include the last `ASSISTANT_HISTORY_TURNS` (default 12) CEO/assistant messages from
  `company/assistant.jsonl` in the prompt, so follow-ups work ("and what about the second one?").
- **Knows everything:** include the latest Briefing plus the RunCards (compact) in the prompt, next to the
  ceoContext digest. It runs on `ASSISTANT_MODEL` (currently claude-opus-5-5) through Claude Code with read-only file
  access to the repo, `company/` and `%USERPROFILE%\.jcode\sessions`, so it can dig into any project, run or manager
  when asked, and answer from evidence. It must say "I checked X" for claims and never invent status.
- **Delegates with Laya:** for each task in its plan, ask Laya (a choice question, with confidence guard, fallback to its own
  judgement) which **track** it goes to: `pipeline` (work inside a company project; today's runPipeline path),
  `fleet` (changes to our own platform or big multi-part work; call FLEET-BACKEND's exported function from
  `src/company/fleet.ts`, e.g. `createFleetOrder(text)`; if fleet.ts is not ready yet, say so in the reply and keep the
  task as pipeline), or `answer` (no work, just reply). Record the choice + Laya confidence in `decisions` and in the trace.
- **Answers in plain words** with the same checklist style: "Done: … / Remaining: … / Needs you: …" whenever it
  reports status.
- FLEET-BACKEND was told to propose an assistant.ts edit. You own assistant.ts now, so implement the fleet
  track yourself against fleet.ts's exported API, and note in the coordination log that FLEET-BACKEND should NOT edit assistant.ts.

## 4. UI (BRIEFING-UI owns `public/v2/views/briefing.js`)
Route `#/briefing`, built on the v2 contract in docs/UI_V2_SPEC.md. This should become the CEO's home: ask UI-SHELL
(mizaru) in the coordination log to make `#/briefing` the default route and the first nav item.
- Top: the summary sentence + counts.
- **Needs you** first (highlighted), then **Done** (✅ checklist), **In progress** (per item: owner + its remaining items
  as unchecked boxes), then **Problems**. Every item links to its run: tasks → `#/flow/:taskId`, fleet → `#/fleet/:orderId`,
  jcode runs → an expandable card showing the RunCard (headline, done/remaining, model used and why, last checked).
- "Refresh" button (POST refresh), and "Mark as read" (POST seen). Poll every 20s.
- A compact "Ask the assistant about this" link on each item, which goes to `#/assistant` with the question
  prefilled (`#/assistant?q=...`). Tell UI-ASSISTANT (kikazaru) about the `q` param in the coordination log.
Develop against `?mock=1` sample data with the exact shapes above until the endpoints exist.

## Coordination
- REPORTING and ASSISTANT-BRAIN both touch `src/server.ts` routes? No: only REPORTING adds routes. ASSISTANT-BRAIN
  changes assistant.ts only. If ASSISTANT-BRAIN needs data, import it from briefing.ts/runManagers.ts (REPORTING
  exports `getBriefing()` and `listRunCards()`; agree on this in the log).
- Router restart needed for the new code: ask in the coordination log. OPS/CRASHFIX do it when no task is in flight.
- Done means: `GET /company/briefing` returns a real briefing covering the jcode sessions running today, in plain
  words; the Briefing page shows it; the assistant answers "what's done and what's left on the dashboard work?"
  correctly from evidence and routes "add X to the platform" to the fleet track with the Laya confidence recorded.
  Log proof (real output) in docs/AGENT_COORDINATION.md.
