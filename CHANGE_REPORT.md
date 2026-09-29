# CHANGE_REPORT.md

AgentOffice UI integration into Platform Core.

## Summary

Integrated the AgentOffice visual theme and public assets as the default UI for Platform Core while preserving the original UI under `legacy/`. A thin adapter (`js/agent-office-adapter.js`) re-exposes the existing data contract (`loadProjects`, `getProjectById`, `updateProjectStatus`) unchanged, so `js/data.js` and `js/views/*` were not modified.

## Upstream metadata

- **Repository:** https://github.com/harishkotra/agent-office.git
- **Pinned commit SHA:** `58f11f9b31770c10bcf3d7a0618325d22bd0ee9e`
- **License:** MIT License (see `vendor/agent-office/LICENSE`)
- **Verification:** `git ls-remote https://github.com/harishkotra/agent-office.git HEAD` returned the same SHA.

## Integration decision

Direct adoption of the upstream React/Phaser/Colyseus monorepo was not feasible for Platform Core:

- The upstream is a real-time agent simulation requiring a Colyseus server, SQLite, and Ollama or an OpenAI-compatible API key.
- It does not map to the existing `loadProjects` / `getProjectById` / `updateProjectStatus` project-dashboard contract.
- Its default dev-server port (5173) and client-side hash routing would collide with the existing legacy UI.

Therefore, a **thin themed adapter / port** was implemented: upstream public assets are copied into `public/assets/`, and the new default UI is a lightweight, API-key-free dashboard that consumes the existing data layer through the adapter.

## Modified files

- `README.md` — updated quick start, architecture, and documentation links.
- `index.html` — replaced legacy hash-router entry with AgentOffice-themed default UI; redirects `?ui=legacy` to `legacy/index.html`.
- `.gitignore` — already excluded `node_modules`, `.env*`, `dist`, `build`, `*.log`.

## New files

- `package.json` — project metadata, `engines.node >= 18.0.0`, scripts `dev`, `start`, `build`.
- `package-lock.json` — pinned dependency lockfile (only `serve@14.2.4` as dev dependency).
- `css/agent-office.css` — AgentOffice theme stylesheet.
- `js/agent-office-adapter.js` — thin adapter exposing `loadProjects`, `getProjectById`, `updateProjectStatus`.
- `js/agent-office-app.js` — overview / list / detail views using query-parameter routing.
- `legacy/` — self-contained copy of the original UI (`index.html`, `css/styles.css`, `js/*`, `js/views/*`).
- `public/assets/` — copied upstream AgentOffice assets (`agent.png`, `characters/char_*.png`).
- `scripts/build.js` — asset-staging build script.
- `SETUP_AGENT_OFFICE.md` — install, env vars, launch, build, rollback, license, attribution.
- `UPSTREAM.md` — upstream URL, pinned commit SHA, integration rationale.
- `THIRD_PARTY_NOTICES.md` — AgentOffice MIT license and attribution.
- `regression-fixture.md` — data-layer round-trip regression note.
- `vendor/agent-office/` — upstream source snapshot (nested `.git` removed so it commits cleanly).
- `tests/` — coder-2 smoke and secret-scan tests (included in commit as requested).

## Commands run and results

```powershell
git ls-remote https://github.com/harishkotra/agent-office.git HEAD
# 58f11f9b31770c10bcf3d7a0618325d22bd0ee9e	HEAD

npm install
# up to date, audited 89 packages

npm run build
# copied upstream assets into public/assets/

node tests/smoke.mjs
# All smoke assertions passed.

node tests/secret-scan.mjs
# No secret patterns found.

node hello-company.mjs
node agents/coder-1/hello-company.mjs
node agents/coder-2/hello-company.mjs
node s2-eng-heartbeat.mjs
node s2b-eng-heartbeat.mjs
node s2-eng-throughput.mjs
node s2b-eng-throughput.mjs
# all exit 0
```

## UI smoke results

Served the integrated entry with `npx serve . -l 3000` and verified HTTP 200 for:

- `/`
- `/?view=list`
- `/?view=detail&id=alpha`
- `/css/agent-office.css`
- `/js/agent-office-app.js`
- `/js/agent-office-adapter.js`
- `/js/data.js`
- `/js/ui.js`
- `/public/assets/agent.png`
- `/public/assets/characters/char_*.png`
- `/legacy/index.html`
- `/legacy/css/styles.css`
- `/legacy/js/app.js`
- `/legacy/js/data.js`

The default UI loads without API keys and renders placeholder/empty states gracefully. Status updates via `updateProjectStatus` persist in-session.

## Rollback drill

Pre-integration state is tagged `pre-agent-office-ui`. Rolling back:

```powershell
git checkout pre-agent-office-ui
npx serve . -l 3000
```

The original `index.html`, CSS, and JS are restored and the legacy UI serves correctly.

## Compatibility decisions and limitations

- **Routing:** The new UI uses query parameters (`?view=overview`) to avoid collisions with the legacy hash router (`#/overview`).
- **Port:** Scripts serve on port 3000 to avoid clashing with the upstream default port 5173.
- **Node version:** Documented `engines.node >= 18.0.0` to match upstream requirements; no silent force-upgrade performed.
- **API keys:** The default UI requires no API keys. The full upstream stack (Colyseus, SQLite, Ollama/OpenAI) is not wired into Platform Core.
- **Real-time features:** Multi-agent simulation, chat, task board, and persistent memory are out of scope for this integration.
- **Data layer:** `js/data.js`, `js/views/*`, `agents/*` (other than `agents/coder-1`), `s2*.mjs`, `hello-company.mjs`, and `UI_IMPROVEMENT_REPORT.md` were left untouched.
- **Tests:** `tests/` was not modified; it is included in the commit.
- **Assets:** `public/assets/` is generated by `npm run build` and should not be edited directly; it is committed so the UI works out-of-the-box on a fresh checkout.

## Skipped checks

- No production deployment was performed (out of scope).
- Browser-based visual regression testing was not automated; verified via HTTP fetch and existing smoke tests only.
