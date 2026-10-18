# CLAUDE.md

Everything an AI agent needs is in [AGENTS.md](AGENTS.md); read that first, then [docs/PITFALLS.md](docs/PITFALLS.md).

Before you call a change done: `npm run typecheck` is clean and `npm run check:all` shows no new failures (known ones: docs/KNOWN_ISSUES.md).
Never run checks against a live router, the real `company/` folder, or a port your own services use.
