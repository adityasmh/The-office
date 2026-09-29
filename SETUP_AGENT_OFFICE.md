# Setup: AgentOffice UI for Platform Core

This guide covers installing, running, and rolling back the AgentOffice-themed UI integration.

## Prerequisites

- **Node.js** >= 18.0.0 (the upstream `agent-office` monorepo requires Node >= 18; Platform Core itself is dependency-free).
- **npm** >= 9 (used to install the local dev server).
- No API keys are required for the default static UI; it loads with placeholder data and degrades gracefully when no backend is configured.

## Install

From the repo root:

```powershell
cd "C:\Users\user\Desktop\Default Project\company\projects\pmumhp51u\repo"
npm install
npm run build
```

`npm run build` copies AgentOffice public assets from `vendor/agent-office/packages/ui/public/assets` into `public/assets/` so the UI can render them.

## Environment variables

The default UI does **not** require any environment variables. The original upstream project optionally uses:

```bash
# Optional upstream variable (only needed if running the full agent-office server stack)
TAVILY_API_KEY=...
```

Do not commit `.env` files; `.gitignore` already excludes them.

## Launch

### Development / start

```powershell
npm run dev
```

Then open http://localhost:3000.

### Production-style serve

```powershell
npm start
```

Both scripts use `serve` on port 3000 to avoid clashing with the upstream default port 5173.

## Switch to the legacy UI

Two options:

1. Click **Legacy UI** in the top navigation or footer.
2. Open http://localhost:3000/legacy/index.html, or append `?ui=legacy` to the root URL.

## Core smoke flow

1. Open the root URL.
2. **Overview** shows project cards with `statusBadge`, `formatCurrency`, and `computeStats` summary stats.
3. Click **Projects** or **View all** to open the list.
4. Click a project row/card to open the detail view.
5. Change the status dropdown and click **Save**; `updateProjectStatus` persists the change in-session.

## Build

```powershell
npm run build
```

This only stages static assets. No JavaScript bundling is required for the default static UI.

## Rollback

The pre-integration state is tagged `pre-agent-office-ui`.

```powershell
git checkout pre-agent-office-ui
```

This restores the original `index.html`, CSS, and JS. Serve the folder with any static file server, e.g.:

```powershell
npx serve . -l 3000
```

## License and attribution

- AgentOffice is released under the MIT License by Harish Kotra.
- The full upstream license is at `vendor/agent-office/LICENSE`.
- Third-party attribution is in `THIRD_PARTY_NOTICES.md`.
- Upstream URL and pinned commit SHA are recorded in `UPSTREAM.md`.

## Limitations

- The integrated UI is a **thin themed adapter**, not the full React/Phaser/Colyseus simulation. The full upstream requires a running server, SQLite, and Ollama / an OpenAI-compatible API key.
- Real-time multi-agent behavior, chat, task board, and persistent memory are not wired into Platform Core.
- The UI uses query-parameter routing (`?view=overview`) to avoid collisions with the legacy hash router (`#/overview`).
