# CEO DASHBOARD API CONTRACT (frozen — code against this)

Project root: `C:\Users\user\Desktop\Default Project`
Server: Express, `src/server.ts`, port 8787 (`npm run dev`, tsx). UI: `public/index.html`.
Stack: TypeScript ESM (`import x from "./y.js"`), express + dotenv only. **No new npm deps.**
Company state root: `company/` (org.json, budgets.json, projects/<id>/thread.jsonl, cost.jsonl, sessions.jsonl).

Roles (src/company/roles.ts, already defined): `prompt-enhancer, manager, coder, tester, opposer, summarizer, assistant`.
Departments are seeded in `company/org.json`; each project belongs to one department and holds one team of agents
(`AgentType = {id, role, name, modelId, workdir}`).

## Shared types (src/company/sessions.ts exports SessionRec; src/company/budget.ts exports AgentBudget)

```ts
export type SessionStatus = "queued" | "running" | "done" | "error";
export type SessionRec = {
  id: string;              // unique, e.g. s<ts>-<agentId>
  agentId: string;         // e.g. "coder-1", "manager", "assistant"
  agentName: string;       // display name
  role: string;            // RoleId
  departmentId: string;    // "d..." id or "d-ceo" for the assistant
  departmentName: string;  // "Engineering", "Executive", ...
  projectId: string;
  projectName: string;
  taskId: string | null;
  taskTitle: string;       // the exact work item this session is doing
  model: string;           // modelId used
  status: SessionStatus;
  startedAt: string;       // ISO
  finishedAt?: string;
  durationMs?: number;
  pid?: number;            // child process pid when opencode-backed
  lastText?: string;       // last chunk of output (<= 2000 chars)
  costUsd?: number;        // charged to the agent budget for this run
  runtime?: "opencode" | "router";
};

export type AgentBudget = {
  agentId: string; name: string; role: string; tier: "cheap" | "mid" | "frontier";
  departmentId: string; departmentName: string; projectId: string; projectName: string;
  modelId: string;
  allocatedUsd: number;   // total budget granted for the job
  spentUsd: number;       // charged spend
  remainingUsd: number;   // allocated - spent (never below 0)
  pctUsed: number;        // 0..100
  sessionsRun: number;
  status: "idle" | "running" | "budget_exhausted";
};
```

## Endpoints (all JSON; errors `{error: string}` with 4xx/5xx)

### Agent identity keys (NORMATIVE)

Bare agent ids repeat across projects (every project owns its own `coder-1`, `manager`, ...), so the
canonical identifier is the **composite key** `"<projectId>::<agentId>"`:

- `AgentBudget.agentId` IS that composite key. `GET /company/budgets` -> `byAgent[].agentId` and
  `panel.agents[].agentKey` are composite.
- Every `:agentId` route ALSO accepts a bare id and resolves it to the first registered match
  (convenience only, never an identity claim).
- The CEO assistant is the single exception: its key is exactly `"assistant"`.
- When a response echoes an id, it echoes the id the caller sent as `agentId` and the canonical
  composite as `agentKey`.
- Extra fields beyond this contract are allowed (additive only). Clients must ignore unknown keys.
- A failed agent run is `status:"error"` (server maps it to 502). `"queued"` means only "the agent was
  busy, the message was parked". `budget_exhausted` is 402.

1. `GET /company/panel` → the single dashboard payload:
```jsonc
{
  "company": "string",
  "ceo": { "name": "string", "title": "Chief Executive Officer" },
  "generatedAt": "ISO",
  "visual": { "departments": 3, "projects": 4, "teams": 5, "agents": 26, "tasks": 9,
              "sessionsRunning": 3, "sessionsQueued": 1, "sessionsTotal": 12,
              "budgetTotalUsd": 30, "budgetSpentUsd": 1.2, "budgetRemainingUsd": 28.8 },
  "departments": [ { "id","name","projectIds":[""], "agents": n, "running": n,
                     "budget": { "allocatedUsd","spentUsd","remainingUsd" },
                     "projects": [ /* projectSummary */ ] } ],
  "projects": [ /* projectSummary */ ],
  "sessions": { "running": n, "queued": n, "total": n, "items": [ /* SessionRec, newest first, max 60 */ ] },
  "budgets": { "totalUsd": n, "spentUsd": n, "remainingUsd": n, "byAgent": [ /* AgentBudget */ ],
               "byDepartment": [ { "departmentId","departmentName","allocatedUsd","spentUsd","remainingUsd" } ] },
  "agents": [ { "agentId","name","role","roleName","departmentId","departmentName","projectId","projectName",
                "modelId","status","running","budget": /* AgentBudget */, "lastMessage": "string",
                "threadDepth": n } ],
  "assistant": { "agentId": "assistant", "name": "string", "status": "idle|thinking",
                 "budget": /* AgentBudget */, "thread": [ { "ts","role":"ceo|assistant","text","tasks":[/*taskId*/] } ] },
  "gates": [ { "projectId","projectName","taskId","request","status","awaiting": "intake|code|merge"|null } ]
}
```
`projectSummary` (existing shape plus fields): `{id,name,description,departmentId,status,rootDir,teams:[{id,name,agents:[{id,role,name,modelId,workdir,budget}]}],thread,tasks,cost,running}`.
Keep `thread`, `tasks`, `cost` keys as they are today so the old view keeps working.

2. `GET /company/sessions` → `{ running, queued, total, items: SessionRec[] }`
3. `GET /company/budgets` → `{ totalUsd, spentUsd, remainingUsd, byAgent: AgentBudget[], byDepartment }`
4. `POST /company/agents/:agentId/budget { "allocatedUsd": number }` → updated `AgentBudget` (persists to `company/budgets.json`)
5. `GET /company/agents` → the `agents` array above (all agents across all projects, plus `assistant`)
6. `GET /company/agents/:agentId/thread?limit=100` → `{ agentId, messages: [{ts,from:"ceo|agent",text,kind?}] }`
7. `POST /company/agents/:agentId/message { "text": string, "run"?: boolean }` →
   `{ agentId, status: "replied"|"queued", reply?: string, sessionId?: string, budget?: AgentBudget, error?: string }`
   - If the agent is idle and `run !== false`, execute the message NOW as that agent's persona
     (`runAgent()` from workers.ts: opencode roles spawn a real process, router roles call the model),
     append both CEO message and reply to the agent thread, charge budget, register a session.
   - If the agent is already running, queue the message (status `queued`) and return immediately; drained on completion.
   - Refuse with 402 `{error:"budget_exhausted"}` when the agent has no remaining budget, unless `"force": true`.
8. `POST /company/assistant/message { "text": string, "autoRun"?: boolean }` → the CEO's assistant:
   `{ reply: string, plan: [{title,departmentName,projectId?,role}], dispatched: [{projectId,taskId,title,status}],
      sessions: [SessionRec], budgets: {remainingUsd}, decisions: string[], error?: string }`
   - The assistant decomposes the CEO instruction (Claude subscription, DeepSeek fallback), picks the target
     department/project (creating a project if the department has none), creates the task(s), and with
     `autoRun !== false` starts `runPipeline(projectId, request, {taskId, auto:true})` **without blocking the HTTP
     response** (fire-and-forget; return the dispatched ids immediately, progress flows to sessions/thread).
   - Budget-check every hired agent before dispatch; drop targets that cannot afford the work and say so in `decisions`.
   - Append the CEO message + assistant reply to `company/assistant.jsonl` (thread).
9. `GET /company/assistant/thread?limit=100` → `{ messages: [{ts,role:"ceo"|"assistant",text,tasks?}] }`
10. `GET /company/stream` → Server-Sent Events, `event: panel`, one `data:` line = the `/company/panel` payload, every 2000 ms (plus an immediate first frame). Must never crash the server; close cleanly on client disconnect.
11. Existing routes keep working unchanged (`/health /route /chat /handoff/* /team/run /notify/slack` and all `/company/projects*` task/gate routes).

## UI requirements (public/index.html, single file, inline CSS+JS, no CDN)

- Header: company name, `CEO · <name>`, live counts (running sessions / agents / tasks / budget remaining), pause+refresh.
- **Sessions board**: every session with department, role, agent, task title, model, status, elapsed, cost, budget bar. Running sessions highlighted; auto-refresh every 2s.
- **Budgets**: per-agent allocated / spent / remaining with bars, sorted by remaining; per-department rollup; total spend meter.
- **Assistant console**: chat with the CEO assistant (POST /company/assistant/message); shows its plan + which tasks it dispatched.
- **Agent console**: pick any agent → read thread, send a message, see the reply stream in (POST /company/agents/:id/message), view that agent's budget and running state.
- **Org view**: departments → projects → teams → agents with per-agent status dots (green idle, amber running, red exhausted).
- **Gates**: awaiting approvals with approve buttons (existing endpoints).
- Dark theme, vanilla JS, `fetch` polling (SSE optional), no external requests.

## Rules
- Never print or expose `.env` values. No secrets in JSON responses.
- Every file write is atomic-ish (write temp + rename is fine, or fs.writeFileSync).
- Typecheck must pass: `npx tsc --noEmit`. Run it before reporting done.
- Do not modify files owned by another workstream (see the workstream prompt you were given).
