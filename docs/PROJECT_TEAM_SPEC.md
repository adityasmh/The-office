# Project team config spec

A project record in org (src/company/org.ts) gets an optional field:


team?: { coders?: number /* int 1..6 */; models?: { [role: string]: string } /* role in manager|coder|tester|opposer; value = model id */ }


Rules:
- Absent team or absent key means the existing global rule applies (chooseWorkerModel in dispatch.ts, CEO cost rule: cheap DeepSeek default, Kimi only on escalation).
- If team.models[role] is set and the model id is known, it wins over the global rule for that project's workers of that role. The reason string must contain `project override`.
- team.coders sets how many coder agents the project's team has (pipeline.ts round-robins over coders).
- Validation: coders integer 1..6; unknown role or empty model id is rejected with HTTP 400 and {error}.

API (reuse the existing org/project routes in src/server.ts; BACKEND adds what is missing):
- POST /api/org/departments {name} -> {ok:true, department}
- POST /api/org/projects {name, department, team?} -> {ok:true, project}
- PATCH /api/org/projects/:id/team {coders?, models?} -> {ok:true, project}
- GET existing org/project list returns team on each project.
If an equivalent route already exists, keep its path and shape and only add the team field. BACKEND records the final paths at the bottom of this file, and UI and PROOF read them from there.

chooseWorkerModel gains an optional second argument `opts?: {projectId?: string; role?: string}`. It stays backward compatible, never throws, and checks the project override first.

## Final routes

BACKEND (src/server.ts). The existing `/company` routes were reused (the `/api/*` shape in the draft above is not used for these: the only /api routes in this server are needs-you and manager-queue). All of these sit behind the existing `/company` guard: mutating calls need the `X-Company-Token` header, loopback GETs are open.

- `GET  /company/org` -> `CompanyDef`; every project may now carry `team`.
- `POST /company/departments` `{name}` -> `{ok:true, department:{id,name,projectIds:[]}}`; `400 {error}` when `name` is missing.
- `POST /company/projects` `{name|projectName?, department|departmentName?, description?, rootDir?, coderCount?, team?}` -> `{ok:true, project, department}`. `team` is persisted on the project and `team.coders` builds the default team with that many coders. `400 {error}` on an invalid team. Without `team` the response/behaviour is as before (`ok` is additive).
- `PATCH /company/projects/:id/team` `{coders?, models?}` -> `{ok:true, project}`; `404 {error:"not found"}`; `400 {error}` on an invalid team. `coders` replaces the count, `models` merges per role.

`team` shape: `{ coders?: number /* int 1..6 */; models?: { [role: "manager"|"coder"|"tester"|"opposer"]: string /* model id */ } }`.
Validation (`400 {error}`): `coders` not an integer 1..6; unknown role; empty model id. Records written before this field existed load unchanged (no `team` = global rule).

`chooseWorkerModel(subtask, {projectId, role})` returns `team.models[role]` for that project with a reason containing `project override`; with no `opts` (or no override) it is exactly the previous behaviour. Call sites: `src/company/pipeline.ts` (`{projectId, role:a.role}`) and `src/company/fleet.ts` (`pickFleetModel`, `{projectId: wo.projectId, role: wo.role}`).

`team.coders` is applied to the roster when the pipeline runs (`runPipeline` -> `withTeamConfig` in org.ts), so the stored agent list keeps the creation-time count while a run round-robins over `team.coders` coders. `coderCount` (old field) still works when `team.coders` is absent.
