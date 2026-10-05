# UI v2 — plan and contract (Claude Code = manager; jcode sessions build)

## Goal (CEO's words)
"Easily see everything, navigate and understand my projects." Talk to the assistant, give orders, and watch
each order move: CEO -> Assistant -> Laya (team) -> Claude (manager) -> Laya (model) -> worker -> Claude review
-> Assistant -> CEO. The current `public/index.html` is one 82KB page that shows everything at once.

## Approach
Build a NEW dashboard at `public/v2/` (served at http://127.0.0.1:8787/v2/). The old `public/index.html` stays
untouched as the fallback until the CEO approves v2. No build step: plain ES modules, no framework, no npm deps.
Each session owns separate files, so five sessions can work in parallel without conflicts.

## File ownership (only edit your own files)
| Session | Owns |
|---|---|
| UI-SHELL | `public/v2/index.html`, `public/v2/app.js`, `public/v2/api.js`, `public/v2/style.css` |
| UI-ASSISTANT | `public/v2/views/assistant.js` |
| UI-PROJECTS | `public/v2/views/projects.js` |
| UI-FLOW | `public/v2/views/flow.js` |
| UI-OFFICE | `public/v2/views/office.js`, `public/v2/vendor-notes/AGENT_OFFICE.md` |

Nobody edits `src/**`, `public/index.html` or `company/**`. If you need a new API endpoint, write the request in
the Log of `docs/AGENT_COORDINATION.md` and Claude Code will decide.

## Contract (everyone codes against this; UI-SHELL implements it)
`public/v2/api.js` exports:
- `api(path, {method, body})` -> Promise<JSON>. Bootstraps the auth token exactly like `api()` / `companyToken()`
  in `public/index.html` (copy that logic) and sends it as `x-company-token`. Throws Error with `.status`.
- `poll(fn, ms)` -> stop function. Skips while `document.hidden`.
- `esc(s)` HTML-escape. `ago(iso)` "3m ago". `hm(iso)` "17:42:05".

Each view module `public/v2/views/<name>.js` exports:
```js
export const title = "Projects";          // nav label
export function mount(el, ctx) { ... return () => {/* cleanup: stop polls */}; }
```
`ctx = { api, poll, esc, ago, hm, navigate(hash), params }`. Routes are hash-based: `#/assistant`,
`#/projects`, `#/projects/:id`, `#/flow`, `#/flow/:taskId`, `#/office`. The shell renders the nav, calls
`mount` for the active route and calls the cleanup when leaving. Default route: `#/assistant`.
Views must render a loading state, an empty state and an error state, and work at 375px wide.

## Theme (UI-SHELL defines in style.css; views use only these)
CSS variables on `:root`: `--bg --panel --panel2 --line --txt --dim --accent --ok --warn --err`, plus classes
`.card .btn .btn-primary .pill .pill-ok .pill-warn .pill-err .muted .row .col .grid`.
Actor colours for the chain (used by flow/office/assistant): `.who-ceo .who-assistant .who-laya .who-claude
.who-worker`. Dark default, readable, calm; no neon.

## Endpoints available (all exist today)
- `GET /company/panel` — org, sessions, budgets, gates (big payload).
- `GET /company/flow?limit=N` — `{tasks:[{taskId, projectId, projectName, departmentName, request, status,
  createdAt, updatedAt, result, error, trace:[{ts, from, to, what, detail}]}]}`.
- `POST /company/assistant/message {text, autoRun:true}` -> `{reply, plan, dispatched, decisions}`;
  `GET /company/assistant/thread?limit=100` -> `{messages:[{ts, role:"ceo"|"assistant", text, tasks?}]}`.
- `GET /company/org`, `GET /company/projects/:id`, `GET /company/projects/:id/tasks`, `/thread`, `/cost`.
- `GET /company/sessions`, `GET /company/agents`, `GET /company/budgets`.
- `POST /company/projects/:id/run {taskId, auto:true}` resumes a failed task.
Read `src/server.ts` for exact shapes before using one.

## Per-view briefs
- **Assistant (home):** chat with the CEO assistant, big input, Enter sends. Each assistant reply shows the tasks
  it created as chips linking to `#/flow/:taskId`, with live status. "Done:/Failed:" report-backs stand out.
- **Projects:** list of projects grouped by department (name, status, task counts by status, last activity,
  running agents). Detail page `#/projects/:id`: what the project is, its tasks (newest first, status pill,
  resume button for failed ones), recent thread, cost, and the agent team with who is working now.
- **Flow:** list of recent orders; the detail shows the chain as a vertical timeline of hops with actor colours
  and time between hops; highlights the current hop for in-flight tasks; shows result/error at the end.
- **Office:** study github.com/harishkotra/agent-office (the CEO wants its look). Clone it to a TEMP folder
  OUTSIDE this repo, read it, do NOT run its install scripts. Write what is worth adopting to
  `vendor-notes/AGENT_OFFICE.md` (with its license) and build `office.js`: a visual "office" where every agent is a
  desk/avatar grouped by department, live state from `/company/sessions` (idle / working on <task> / error),
  click an agent -> its current task in `#/flow/:taskId`. Only copy code if the license allows it, and credit it.
- **Shell:** top bar (company name, live counts: running sessions, tasks in flight, spend), left nav (collapses to
  a bottom bar on phones), router, "old dashboard" link to `/`, connection indicator that shows "reconnecting"
  when the router is down instead of stale data.

## Done means
Each session: page loads at http://127.0.0.1:8787/v2/#/<route> with no console errors, against the live router
(read-only calls only while testing, except the Assistant view, which may send ONE test message). Log what you
built and how you checked it in `docs/AGENT_COORDINATION.md`. Claude Code reviews and reports to the CEO.
