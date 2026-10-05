# Work order: lift the last two RAM floors (CEO: use the full RAM)

From: manager. Model: deepseek-v4.1-flash. Repo: C:\Users\user\Desktop\Default Project

The ram-floors worker lifted MIN_FREE_RAM_MB (Fleet spawn) and the Kafka/metrics start guards, and handed over two more floors for decision. The CEO already said "use the full RAM, nothing else is happening", so lift them too:
1. `src/company/pipeline.ts` (~lines 238-245): `RESUME_MIN_FREE_RAM_MB`, default 2048, pauses the resume queue. Set the value in `.env` to 256 (edit that single line or add it; never print/copy other .env lines, it holds secrets). Do not change the code default, only the env override, and document it in `.env.example`.
2. `ops/router-supervisor.ps1`: `$ramFloor` (default 2048, read from an env var; find which). IMPORTANT, probable root cause of today's outage: the supervisor probably refuses to START the router while free RAM is under this floor, and free RAM was 0.7-1.9 GB when the router died at 16:45, so no replacement started for ~17 minutes. Confirm by reading the script. Set its env override to 256 in `.env`, and if the floor makes the supervisor wait silently, make it log one line every minute while waiting ("not starting router: free RAM X < floor Y") so this can never be silent again. Small diff only.
3. Do NOT restart the router or the supervisor; do not touch the running supervisor or any process. The values take effect at the next supervisor/router start; say that.
4. Verify: `npx tsc --noEmit` exit 0 for anything under src/; run the PowerShell parser check on ops/router-supervisor.ps1 (`[System.Management.Automation.Language.Parser]::ParseFile`) with zero errors.
5. Append a timestamped entry to docs/AGENT_COORDINATION.md. Report to the manager.
