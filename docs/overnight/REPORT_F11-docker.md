# REPORT F11-docker: Docker and dev container (mock mode)

Status: **DONE**, all proof lines PASS. Docker exists on this machine (29.5.2), so the
compose file was validated with `docker compose config`; per the order, no `docker build`,
`docker run` or pull was executed.

## Changed files

| File | What |
|---|---|
| `Dockerfile` | new. Two stages on `node:24-slim` (build with `npm ci` + `tsc`, runtime with `npm ci --omit=dev`), `ENV MOCK_MODE=1 PORT=8787`, copies `dist/` and `public/`, creates `/app/company` + `/app/logs` and chowns `/app` to `node`, `USER node`, `EXPOSE 8787`, `CMD ["node","dist/server.js"]`. No `COPY .env`, no `COPY .`, no secret value. |
| `docker-compose.yml` | new. One service `router` (`build: .`), `8787:8787`, named volumes `company` -> `/app/company` and `logs` -> `/app/logs`, `env_file` with `required: false`, healthcheck on `/health` via node `fetch`. Top-level `name: internal-llm-router` because the project folder name contains a space. |
| `.dockerignore` | new. Excludes `.env`, `.env.*` (`!.env.example` kept), `node_modules`, `company`, `logs`, `deps`, `models`, `.git`, plus `dist`, `vendor`, `dev`, `tools`, `release*`, `tmp-*`, editor state and local-only docs. |
| `.devcontainer/devcontainer.json` | new. Builds the same `Dockerfile`, `workspaceFolder /workspaces/app`, `forwardPorts [8787]`, `postCreateCommand "npm ci"`, `remoteUser node`, `containerEnv` mock mode on 8787, recommends `ms-vscode.vscode-typescript-next`. |
| `docs/DOCKER.md` | new. Quick start, `docker run` path, dev container, env table, volumes/data, health, an explicit list of what does NOT work in the container, and the verification status. |

Nothing outside this list was created or edited (`git status --porcelain` shows exactly
`Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.devcontainer/`, `docs/DOCKER.md` as new
and no modified file).

## Proof (exact command output)

Command 1: `docker --version`

```
Docker version 29.5.2, build 79eb04c
```

Command 2:
`set "ROUTER_ENV_FILE=C:\Users\user\AppData\Local\Temp\f11probe\none.env" && docker compose config > %TEMP%\f11probe\resolved.yml`
(exit 0). `ROUTER_ENV_FILE` points at a file that does not exist so the validation proves
the "no .env needed" path, and because `docker compose config` prints injected `env_file`
values the host's real `.env` was never read or printed. Note the resolved output has no
`env_file:` key at all: Compose folds it into `environment:`, which is why the optional
env file is proven from the source line `required: false` plus this successful run.

```
name: internal-llm-router
services:
  router:
    build:
      context: C:\Users\user\Desktop\Default Project
      dockerfile: Dockerfile
    environment:
      COMPANY_AUTH_TOKEN: local-mock-mode-not-a-secret
      HOST: 0.0.0.0
      MOCK_MODE: "1"
      PORT: "8787"
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - fetch('http://127.0.0.1:8787/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))
      timeout: 5s
      interval: 10s
      retries: 12
      start_period: 30s
    image: internal-llm-router:local
    networks:
      default: null
    ports:
      - mode: ingress
        target: 8787
        published: "8787"
        protocol: tcp
    restart: unless-stopped
    volumes:
      - type: volume
        source: company
        target: /app/company
        volume: {}
      - type: volume
        source: logs
        target: /app/logs
        volume: {}
networks:
  default:
    name: internal-llm-router_default
volumes:
  company:
    name: internal-llm-router_company
  logs:
    name: internal-llm-router_logs
```

Command 3: `node %TEMP%\f11probe\proof.mjs "<repo>" %TEMP%\f11probe\resolved.yml`

```
PASS exists Dockerfile
PASS exists docker-compose.yml
PASS exists .dockerignore
PASS exists .devcontainer/devcontainer.json
PASS exists docs/DOCKER.md
PASS devcontainer.json parses as JSON
PASS YAML parses: docker compose config ran
PASS devcontainer forwards 8787
PASS devcontainer runs npm ci after create
PASS devcontainer recommends the TypeScript extension
PASS devcontainer builds the repo Dockerfile
PASS devcontainer sets MOCK_MODE=1
PASS .dockerignore has .env
PASS .dockerignore has .env.*
PASS .dockerignore has !.env.example
PASS .dockerignore has node_modules
PASS .dockerignore has company
PASS .dockerignore has logs
PASS .dockerignore has deps
PASS .dockerignore has models
PASS .dockerignore has .git
PASS .dockerignore negates .env.example after .env.*
PASS compose healthcheck present
PASS compose healthcheck probes /health
PASS compose healthcheck has start_period/interval/retries/timeout
PASS compose publishes 8787
PASS compose mounts company/ and logs/ volumes
PASS compose declares the two named volumes
PASS compose runs mock mode on 8787
PASS compose has exactly one service (  router:)
PASS compose env_file is optional (required: false)
PASS Dockerfile has no COPY of .env
PASS Dockerfile has no ADD of .env
PASS Dockerfile has no secret-looking value (0 markers matched)
PASS Dockerfile uses node 24
PASS Dockerfile installs with npm ci
PASS Dockerfile sets MOCK_MODE=1 and EXPOSE 8787
PASS Dockerfile runs the router as non-root node
ALL CHECKS PASS
```

Exit code 0. Two earlier FAILs in the same run were bugs in the checker script (a missing
`/m` flag and a service-count regex that also counted `networks.default`); the checker was
fixed and re-run once. The compose file itself never changed after that.

Also run, read-only: `npm run typecheck` -> exit 0 (`tsc --noEmit` clean), which is what
the image's `RUN npm run build` compiles.

## Open issues

1. **The image was never built and the container never started** (forbidden by the order:
   no `docker build`/`docker run`/pull). So the two `npm ci` layers, the `tsc` build inside
   the image, the `node`-owned named volumes and the healthcheck's `start_period: 30s` are
   unexercised. First real test: `docker compose up --build`. `docs/DOCKER.md` says this.
2. The dev container JSON was parsed but VS Code was not used to open it (it would need a
   build). The dev container uses the repo `Dockerfile`, so it inherits the same Dockerfile
   risk as (1).
3. `HOST=0.0.0.0` is required for a published port and `assertConfig()` (src/config.ts)
   refuses it without `COMPANY_AUTH_TOKEN`, so compose ships the throwaway literal
   `local-mock-mode-not-a-secret`. It guards nothing in mock mode, is labelled as such in
   both the compose file and `docs/DOCKER.md`, and must not be reused for a deployment.
4. The container's `company/` volume starts empty, so the dashboard renders an empty fleet;
   `docs/DOCKER.md` gives a copy-in command. No repo data is baked into the image.
5. `docker compose config` prints `env_file` values, so validating in a checkout with a real
   `.env` would echo its secrets. `docs/DOCKER.md` documents the safe form
   (`ROUTER_ENV_FILE=<missing path> docker compose config`), which is the form used here.
6. The dev container has no Docker CLI, so `docker compose` must be run on the host.
