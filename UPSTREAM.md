# Upstream: AgentOffice

- **Repository:** https://github.com/harishkotra/agent-office.git
- **Commit SHA:** 58f11f9b31770c10bcf3d7a0618325d22bd0ee9e
- **Branch:** main
- **License:** MIT License (see `vendor/agent-office/LICENSE`)

## Integration decision

Direct adoption of the upstream React/Phaser/Colyseus monorepo was not feasible for Platform Core because:

- It requires a running Colyseus game server + SQLite + Ollama (or OpenAI-compatible API key) to render useful screens.
- It is a real-time agent simulation, not a project-management dashboard, and does not map to the existing `loadProjects` / `getProjectById` / `updateProjectStatus` data contract.
- The upstream hash/client routing and dev-server port would collide with the existing legacy UI.

Instead, a **thin adapter / themed port** is used: the upstream visual theme and public assets are referenced, but the default UI is a lightweight, API-key-free dashboard that re-uses the existing data layer through an adapter that exposes the three core methods unchanged.
