# Order F11-docker: Docker and dev container: clone, open, run in mock mode

Open-source developer feature for the Laya fleet. Researched need: see docs/overnight/RESEARCH.md.

## Files
`Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.devcontainer/devcontainer.json`, `docs/DOCKER.md`

## What to build
A Node 24 image that installs dependencies with `npm ci` and runs the router in mock mode (`MOCK_MODE=1`, port 8787, no GPU, no jcode inside the container). `docker-compose.yml`: one service, port 8787, named volumes for `company/` and `logs/`, `env_file` OPTIONAL (`required: false`) so nothing needs a `.env` to start, a healthcheck on `/health`. `.dockerignore` must exclude `.env`, `.env.*` (except `.env.example`), `node_modules`, `company`, `logs`, `deps`, `models`, `.git`. `.devcontainer/devcontainer.json`: the same image or a Node 24 base, forwards 8787, runs `npm ci` after create, and recommends the TypeScript extension. `docs/DOCKER.md`: how to use it, and plainly what does NOT work in the container (real agents need the host's jcode, Laya on GPU, provider keys).
Check first whether `docker` exists (`docker --version`). If it does, validate with `docker compose config` and DO NOT run `docker build`, `docker run` or pull anything. If it does not, validate the YAML and JSON by parsing them and say in the report and in `docs/DOCKER.md` that the build was not tested on this machine.

## Proof
Print PASS or FAIL per line: files parse; `.dockerignore` excludes the secret patterns; compose has the healthcheck and the optional env file; the Dockerfile contains no `COPY .env` and no secret value.
## Common rules (apply to every step)
- Create or edit ONLY the files named in "Files". Edit nothing else. Other workers run at the same time on other files.
- Make changes with small targeted edits, never rewrite an entire existing file. Match the surrounding style (ES modules, `.js` import suffixes, no new dependencies, Node built-ins only).
- Never restart or start the router. Never read, print or edit `.env` or any secret value (tests use fake values and temp folders). Never touch `company/`, Laya, Kafka or scheduled tasks. No real network calls in tests (use local stubs). No deletes of existing files.
- Run each command ONCE, in the foreground. If a step fails, report the exact error and END your turn; do not retry in a loop.
- Narrow job with an explicit end: print the final report and END your turn. Do not wait, poll, loop, or re-read this order.
- Finish by writing `docs/overnight/REPORT_<id>.md` (changed files, exact command output of the proof, open issues) and printing the same report.