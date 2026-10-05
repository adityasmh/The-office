# Docker and the dev container (mock mode) - order F11-docker

Run the router in **mock mode** (`MOCK_MODE=1`) inside a container: no provider keys, no
GPU, no Laya, no jcode. `src/mock.ts` answers instead of a provider and `assertConfig()`
in `src/config.ts` returns early, so the stack starts with zero configuration.

Files: `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.devcontainer/devcontainer.json`.

## Quick start

```
docker compose up --build          # build + start, foreground
docker compose ps                  # router: healthy
curl http://127.0.0.1:8787/health  # {"ok":true,...,"mock":true,...}
docker compose down                # stop (add -v to drop the company/ and logs/ volumes)
```

One service (`router`), port `8787`, two named volumes, a healthcheck on `/health`.

## Without Compose

```
docker build -t internal-llm-router:local .
docker run --rm -p 127.0.0.1:8787:8787 \
  -e HOST=0.0.0.0 -e COMPANY_AUTH_TOKEN=<a token you generate> \
  -v router-company:/app/company -v router-logs:/app/logs \
  internal-llm-router:local
```

Both variables are required for a published port: the router binds `127.0.0.1` by default
(which a published port cannot reach) and `assertConfig()` refuses `HOST=0.0.0.0` without a
token. Compose does NOT ship a default token (a public default would be a known credential): it reads\r\n`COMPANY_AUTH_TOKEN` from your shell or from `./.env` and refuses to start without one. Run\r\n`npx tsx ops/setup.ts` to create a `.env` with a random token. The published port is bound to\r\n`127.0.0.1` only.

## Dev container (VS Code)

Open the folder, then **Dev Containers: Reopen in Container**. The container is built from
the same `Dockerfile`, forwards `8787`, runs `npm ci` after create (postCreateCommand) and
recommends the TypeScript extension (`ms-vscode.vscode-typescript-next`).

```
npm run dev                        # tsx src/server.ts, mock mode from containerEnv
```

The dev container has no Docker CLI inside it, so run `docker compose up` on the host, not
in the container. The host folder is bind-mounted at `/workspaces/app`.

## Configuration

| Variable | Default in the image/compose | Meaning |
|---|---|---|
| `MOCK_MODE` | `1` | canned answers from `src/mock.ts`; also skips the key checks in `assertConfig()` |
| `PORT` | `8787` | router listen port |
| `HOST` | `0.0.0.0` in compose (unset in the image) | bind address; off-loopback requires a token |
| `COMPANY_AUTH_TOKEN` | none: supply it (shell or `.env`) | required because `HOST=0.0.0.0`; compose refuses to start without it |

Compose has **no** `env_file` on purpose: it injects only the four variables above, so none of the secrets in your `.env` ever enter the container. Compose reads `./.env` only to substitute `COMPANY_AUTH_TOKEN`. Warning: `docker compose config` prints the resolved values of whatever it injects, so never paste its output; to check the file, use `docker compose config --format json` and read only the key names.

## Data

- `company/` -> `/app/company`: org state, memory, fleet watcher locks, uploads.
- `logs/` -> `/app/logs`: `router.crash.log`, `workers.json`, `token-ledger.jsonl`.

Both are named volumes, so the image itself stays clean and `.dockerignore` keeps the
repo's `company/` and `logs/` out of the build context. The container's `company/` starts
empty, so the dashboard shows an empty fleet unless you copy data in
(`docker run --rm -v router-company:/data -v "$PWD/company:/src:ro" alpine cp -a /src/. /data`).

## What does NOT work in the container

Plain list, so nobody debugs the wrong thing:

- **Real agent runs.** Workers are spawned through the host's `jcode` and
  `ops/spawn-worker.ps1` (PowerShell, Windows paths). Neither exists in the image: every
  answer comes from `src/mock.ts`.
- **Laya / the decision model.** `DECISION_BACKEND=laya` points at
  `http://127.0.0.1:8000`, which inside the container is the container itself. Laya needs
  the host install (GPU, `deps/`, `models/`) and mock mode bypasses it anyway.
- **Provider keys.** `OPENCODE_API_KEY`, `TYPESAFE_API_KEY`, `CLAUDE_MODEL`, Slack tokens
  and the rest are ignored in mock mode. Passing them in changes nothing except that
  off-host `/company/*` calls will then accept them.
- **The dashboard's live data.** `public/` is in the image and served, but the fleet,
  projects, memory and gates read from `company/`, which is an empty volume.
- **Slack, Kafka, STT/TTS, GitHub.** All need host services, host credentials or the
  Windows-only `tools/` and `ops/` scripts. The image contains neither `tools/` nor
  `ops/` or `deps/` or `models/`.
- **Killing, restarting or supervising host processes.** `ops/shutdown-all.ps1`,
  `ops/router-supervisor.ps1` and `scripts/serve-laya.ps1` are host-only.

## Verification status

Validated on the author's machine with `docker --version` (29.5.2) and
`docker compose config` (YAML parse, port, volumes, healthcheck), plus a JSON parse of
`.devcontainer/devcontainer.json`. **The image was not built and the container was not
run** (the order forbids `docker build`, `docker run` and pulls), so the first
`docker compose up --build` is the real test of the two `npm ci` layers and of the
healthcheck's `start_period`. Report a failure with the exact build log.
