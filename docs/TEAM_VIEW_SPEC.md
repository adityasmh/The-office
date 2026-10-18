# Team view spec (v2 dashboard)

## Route
- `#/team`: the full roster.
- `#/team/:agentId`: the roster with that agent's detail panel open. `agentId` is the canonical key `<projectId>::<agentId>` or `assistant`, URL-encoded in the hash.
- The router (`public/v2/app.js`) passes `ctx.params.agentId` (alias `ctx.params.id`) when the second segment is present.
- Nav entry: `{ name: "team", label: "Team", icon: "☺", badge: null }`, placed after `office`.

## View module
- File: `public/v2/views/team.js`, an ES module.
- `export const title = "Team"`.
- `export function mount(el, ctx)` returns a cleanup function that stops all polls and listeners.
- `ctx = { api, poll, esc, ago, hm, navigate, params, route, usd, dur, trunc, statusTone, IN_MOTION, TERMINAL, companyRoot }`.
- `ctx.api(path, opts)` resolves to parsed JSON. It already attaches the auth token for POSTs (see `public/v2/api.js`).

## Data (existing endpoints, no server changes)
- `GET /company/agents` returns `AgentView[]`, where `AgentView` = `{ agentId, agentKey, name, role, roleName, departmentId, departmentName, projectId, projectName, modelId, status: 'idle'|'running'|'budget_exhausted', running, budget: AgentBudget, lastMessage, threadDepth }`.
  - Use `agentKey` as the unique id in URLs and API calls.
  - The first element is the CEO assistant (`agentKey` `assistant`).
- `AgentBudget` includes `agentId` (canonical key), `name`, `role`, `tier` ('cheap'|'mid'|'frontier'), `departmentId`/`departmentName`, `projectId`/`projectName`, `modelId`, `allocatedUsd` and `spentUsd` (read `src/company/budget.ts` for the rest).
- `GET /company/agents/:agentKey/thread?limit=50` returns `{ agentId, messages: [{ ts, from: 'ceo'|'agent', text, kind? }] }`.
- `POST /company/agents/:agentKey/message` with body `{ text, run?: boolean }` returns `{ status: 'replied'|'queued'|'error', reply?, error? }`. HTTP 402 means budget_exhausted.
- `POST /company/agents/:agentKey/budget` with body `{ allocatedUsd: number >= 0 }` returns the updated `AgentBudget`.
- `GET /company/sessions` provides a running count (optional).

## Behaviour
- Poll `/company/agents` every 5s using `ctx.poll`.
- Group agents by department, then by project. The assistant goes in its own 'Executive' group at the top.
- Each card shows: name, roleName, model, status pill, budget bar (spent/allocated), last message (truncated) and threadDepth.
- Header: counts (total / running / budget-exhausted), a status filter, and a text search over name, role and project.
- Clicking a card calls `ctx.navigate('#/team/' + encodeURIComponent(agentKey))`. The detail panel shows the thread, a message box and a budget edit field.
- All text is escaped with `ctx.esc`.
- Loading, empty and error states must use the shell's `.card` / `.state` classes.
