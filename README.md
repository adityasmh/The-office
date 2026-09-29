# Laya AI Company — Platform Core

Platform Core is a dependency-free project dashboard. It now ships with an **AgentOffice-themed** default UI while preserving the original legacy UI for rollback.

## Quick start

```powershell
npm install
npm run build
npm run dev
```

Open http://localhost:3000.

- Default UI: AgentOffice theme at `/`
- Legacy UI: `/legacy/index.html` or `/?ui=legacy`
- Rollback tag: `pre-agent-office-ui`

## Agent scripts

All existing agent entry scripts remain unchanged and exit 0:

```powershell
node hello-company.mjs
node agents/coder-1/hello-company.mjs
node agents/coder-2/hello-company.mjs
node s2-eng-heartbeat.mjs
node s2-eng-throughput.mjs
node s2b-eng-heartbeat.mjs
node s2b-eng-throughput.mjs
```

## Documentation

- `SETUP_AGENT_OFFICE.md` — install, env vars, launch, build, rollback, license, attribution.
- `UPSTREAM.md` — upstream repository URL and pinned commit SHA.
- `THIRD_PARTY_NOTICES.md` — AgentOffice MIT license and attribution.
- `CHANGE_REPORT.md` — what changed, commands run, compatibility decisions, limitations.
- `UI_IMPROVEMENT_REPORT.md` — prior UI improvement report (untouched).

## Architecture

- `index.html` — default AgentOffice-themed entry.
- `css/agent-office.css` — AgentOffice theme styles.
- `js/data.js` — existing data layer (untouched).
- `js/agent-office-adapter.js` — thin adapter re-exposing `loadProjects` / `getProjectById` / `updateProjectStatus` unchanged.
- `js/agent-office-app.js` — overview / list / detail views using query-parameter routing.
- `legacy/` — full copy of the original UI.
- `vendor/agent-office/` — upstream source snapshot.

## License

Platform Core files are provided as part of the project. AgentOffice components are used under the MIT License; see `THIRD_PARTY_NOTICES.md` and `vendor/agent-office/LICENSE`.
