# Fleet — run the "Claude manages, jcode executes" flow from the dashboard

Owner: Claude Code (manager) wrote this; jcode sessions build it. Builders: FLEET-BACKEND, FLEET-UI.

## The flow the CEO wants, end to end, from the UI
1. The CEO types an order in the dashboard (Fleet view, or the Assistant view routes it here).
2. **Claude plans** (manager, `callClaudeSubscription`, model `FLEET_PLANNER_MODEL`, default `claude-opus-5-5`, read-only
   access to the repo). The output is N work orders. Each has: `id`, `title`, `role` (e.g. UI-FLOW), `owns` (files/globs
   this worker may edit, no overlaps between orders), `brief` (a self-contained instruction), `done` (acceptance checks).
   Claude splits the work so the orders can run in PARALLEL. It also writes a spec doc when workers share a contract
   (as it did for docs/UI_V2_SPEC.md).
3. **CEO approves the plan** in the UI (gate). They can edit or remove orders before approving. `FLEET_AUTO_APPROVE=1` skips this.
4. **Spawn**: one VISIBLE jcode terminal per work order (a real PowerShell window running `jcode -p opencode-go` in
   the repo). The work order is delivered into that session. Cap: `FLEET_MAX_SESSIONS` (default 6) at once; the rest queue.
5. **Watch live** in the UI: each worker card shows the session name, role, order title, state
   (starting / working / idle / reported / reviewed / failed), last activity, and a live tail of what the session is
   saying and doing.
6. **Report**: every order tells its worker to finish by writing `company/fleet/<orderId>/<workOrderId>/REPORT.md`
   (what changed, files, the commands it ran with REAL output, open issues) and then stop.
7. **Claude reviews** each report plus the actual diff/files → verdict `PASS` or `REDO` with reasons. On REDO the UI
   offers "send back", which spawns a fresh session with the original brief plus the review notes. When all orders
   PASS, the order is done and the assistant thread gets a summary. (Slack gets it too, via the report-back rose is building.)
8. Every hop is recorded in the order's `trace` (same `TraceStep` shape as `src/company/gates.ts`), so the Flow view
   can show it: CEO → Claude (plan) → CEO (approve) → jcode:<session> (work order) → jcode:<session> (report) →
   Claude (review PASS/REDO) → Assistant → CEO.

## Lessons from doing this by hand today (FLEET-BACKEND must handle these)
- `jcode run "<msg>"` is headless and invisible. The CEO wants **visible terminals**, so spawn
  `powershell -NoExit -Command "Set-Location -LiteralPath '<repo>'; jcode -p opencode-go"`.
- Delivering the order: what worked today was waiting until `%USERPROFILE%\.jcode\last_focused_client_session` changes
  to the NEW session id, then piping the brief to `jcode transcript --mode send` (stdin, which avoids quoting problems).
  That is **focus-based and racy**: spawns MUST be serialized (one at a time, with a mutex), and delivery must be verified
  (the new session's journal shows the brief as a user message). If the CEO clicks another jcode window mid-spawn,
  the order can land in the wrong session. **First investigate a targeted mechanism** (e.g. `jcode --help`, whether
  `jcode` accepts an initial prompt, `jcode --resume <id>` + message, `jcode debug message` with
  `JCODE_DEBUG_CONTROL=1` set ONLY in the spawned process env) and use it if it works. Keep the focus method as the fallback.
- Window titles are overwritten by jcode, so never identify windows by title. Track by session id.
- Session state lives in `%USERPROFILE%\.jcode\`: `sessions/<id>.journal.jsonl` (meta.updated_at, messages),
  `active_pids/<id>`, `streaming_pids/<id>` (present = currently generating). Read-only; never write there.
- Workers must never start a second router on the live `company/`, and never restart :8787 while a task is in
  flight. Put the standard rules from the worker preamble (see "Worker preamble" below) into every brief.

## Backend (FLEET-BACKEND owns `src/company/fleet.ts`, `ops/fleet-*.ts`, and ONLY the fleet routes in `src/server.ts`)
State: `company/fleet/orders.json` (orders), `company/fleet/<orderId>/<workOrderId>/REPORT.md` (reports).
```ts
type WorkOrder = { id: string; title: string; role: string; owns: string[]; brief: string; done: string[];
  state: "planned"|"queued"|"starting"|"working"|"idle"|"reported"|"reviewed"|"failed";
  sessionId?: string; windowPid?: number; startedAt?: string; reportedAt?: string;
  verdict?: "PASS"|"REDO"; review?: string; attempts: number };
type FleetOrder = { id: string; text: string; createdAt: string; updatedAt: string;
  status: "planning"|"awaiting_approval"|"running"|"reviewing"|"done"|"failed"|"cancelled";
  plan?: string; specDoc?: string; workOrders: WorkOrder[]; trace: TraceStep[]; error?: string };
```
Endpoints (mutations need `x-company-token`, same as the other `/company/*` routes):
- `POST /company/fleet/orders {text, autoApprove?}` → creates an order and starts planning async; returns the order.
- `GET  /company/fleet` → `{orders: FleetOrder[] (newest first), limits: {maxSessions, running}}`.
- `GET  /company/fleet/orders/:id` → the order plus, per work order, `live: {streaming: boolean, lastActivity, tail: string[] (last ~15 lines of text/tool activity from the journal)}`.
- `POST /company/fleet/orders/:id/approve {workOrders?}` (edited orders optional) → spawns.
- `POST /company/fleet/orders/:id/work/:wid/redo` → new session with brief + review notes.
- `POST /company/fleet/orders/:id/cancel` → stop spawning queued work; do NOT kill running terminals (the CEO closes them).
- A watcher loop (every 5s) moves states forward: journal activity → working/idle; REPORT.md appears → reported →
  Claude review → reviewed; all PASS → done + a report-back to the assistant thread (reuse `reportBack`'s pattern:
  append to `company/assistant.jsonl`).
The assistant can route here: add `"track":"fleet"` to the assistant's task JSON (for work on the platform itself /
large multi-part work). FLEET-BACKEND: propose the exact `assistant.ts` edit in the coordination log FIRST. The
manager approves before that edit is made.

## UI (FLEET-UI owns `public/v2/views/fleet.js` only)
Route `#/fleet` and `#/fleet/:orderId`, built on the v2 contract in `docs/UI_V2_SPEC.md` (mount/cleanup, ctx.api, poll).
- Top: a big order box ("What should the team do?") + "Plan it" button.
- The order list: status pill, age, "3/5 passed".
- Order detail, 3 columns on desktop and stacked on a phone:
  **Plan** (Claude's plan text, spec doc link, work order list with title/role/owns; while awaiting approval each
  one is editable/removable, plus an "Approve & spawn" button) →
  **Workers** (live card per work order: session name, state pill, elapsed, last activity, live tail in a monospace
  box polled every 3s, "REDO" button when the verdict is REDO) →
  **Review** (per work order: verdict, Claude's review text, report link; overall summary when done).
- A small chain strip at the top of the detail, with actor colours: CEO → Claude → jcode ×N → Claude → CEO,
  lit up to the current stage.
Until the backend exists, develop against a mock: `?mock=1` makes the view use built-in sample data with the exact
shapes above. Remove nothing when the real API arrives; just stop using the mock by default.
Nav entry: UI-SHELL (mizaru) owns `app.js`/nav. If `#/fleet` is not in the nav when you finish, write the
one-line request in the coordination log. Do not edit `app.js` yourself.

## Worker preamble (every brief the planner writes starts with this)
Read docs/AGENT_COORDINATION.md first and obey the file ownership. Edit ONLY the files in your `owns` list. Never
stop/restart the router on :8787 or start another server on the live company/ (test servers: SLACK_BRIDGE=0, other
PORT, temp COMPANY_ROOT). Never print secrets. Run `npx tsc --noEmit` if you touched TypeScript. Finish by writing
REPORT.md at the path given, with real command output, then stop.

## Done means
From http://127.0.0.1:8787/v2/#/fleet the CEO types an order, sees Claude's plan, approves, watches ≥2 visible jcode
terminals open and work in parallel with live tails in the UI, and sees each report get a Claude verdict, all without
touching a terminal. FLEET-BACKEND proves it with one real small order (e.g. "add a README section X and a comment
in file Y" split across 2 workers) and logs the order id and result in docs/AGENT_COORDINATION.md. Router restart
needed for the new routes: ask in the coordination log. CRASHFIX/OPS do the restart when no task is in flight.
