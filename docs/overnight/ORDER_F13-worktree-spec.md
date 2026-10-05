# Order F13-worktree-spec: design for git worktree isolation per work order

Open-source developer feature for the Laya fleet. Researched need: see docs/overnight/RESEARCH.md.

## Files
`docs/WORKTREE_MODE_SPEC.md` (documentation only; no code)

## What to write
Read `docs/FLEET_SPEC.md`, `docs/AGENT_TALK_SPEC.md`, `src/company/fleet.ts` (launch and delivery), `src/company/fleetGithub.ts` and `src/company/github.ts`. Write a design for an opt-in mode where each work order runs in its own `git worktree` so parallel agents cannot overwrite each other, which developers report as the main fix for parallel agent collisions. Cover: where worktrees live (a sibling folder, Windows path length limits), branch naming that matches the existing `fleet/<order>/<wo>` scheme, creating from the configured base, how the worker's working directory and the `owns` list map to it, how the publish step commits and pushes from the worktree, what happens to the main working copy, listing stale worktrees for the human to remove (the system itself NEVER deletes), port and cache conflicts, disk cost, failure and cleanup cases, an env flag `FLEET_WORKTREES=1` default off, a step-by-step build plan split into narrow worker orders with files each would own, and an acceptance test. Cite the file and function for every statement about current behaviour; do not claim anything you did not read.
## Common rules (apply to every step)
- Create or edit ONLY the files named in "Files". Edit nothing else. Other workers run at the same time on other files.
- Make changes with small targeted edits, never rewrite an entire existing file. Match the surrounding style (ES modules, `.js` import suffixes, no new dependencies, Node built-ins only).
- Never restart or start the router. Never read, print or edit `.env` or any secret value (tests use fake values and temp folders). Never touch `company/`, Laya, Kafka or scheduled tasks. No real network calls in tests (use local stubs). No deletes of existing files.
- Run each command ONCE, in the foreground. If a step fails, report the exact error and END your turn; do not retry in a loop.
- Narrow job with an explicit end: print the final report and END your turn. Do not wait, poll, loop, or re-read this order.
- Finish by writing `docs/overnight/REPORT_<id>.md` (changed files, exact command output of the proof, open issues) and printing the same report.