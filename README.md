# The Office

> **A tiny company where every employee is an AI, the manager has trust issues, and you (the CEO) only get
> pinged for the scary stuff.** Plans orders, runs guarded coding agents in parallel, reviews their homework,
> and refuses to touch your secrets. Local-first. Mock mode included, so it costs nothing to watch it work.

You hand it a plain-text **order** ("add a unit check for the invoice rounding"). A **manager** turns that into small
**work orders**. Each work order gets its own **worker** terminal (a coding-agent CLI such as `jcode`) running under a
**guard** that kills loops, stalls and overspending. A **reviewer** reads the result, a **tester** pokes it, and a human
(**you**) approves the plan and anything risky before it is published. Everything lives in plain files on your machine,
the control plane binds to localhost, and a dashboard shows who is doing what.

```
  you ──order──▶ manager ──plan──▶ [ you approve ] ──▶ workers (one terminal per work order, guarded)
                    ▲                                        │
                    └──── reviewer / tester ◀── report ──────┘          ▶ branch / PR ▶ [ you approve the risky bits ]
        routing policy picks the model for each hop        budget guard watches the money        notify webhook pings you
```

It is **product-agnostic**: the office never knows what the products *are*. You attach any repo through `products.json`
([Leadscout](https://github.com/adityasmh/Leadscout) is the worked example), pick providers in `routing.policy.json`, and
plug in integrations (Slack, Discord, ntfy, n8n, any webhook) through env vars. See [docs/EXTENDING.md](docs/EXTENDING.md).

## Try it in 3 minutes (no keys, no money)

You need Node 20+ and git. Windows is the home turf (see [Honest limits](#honest-limits)); the dashboard and the Node scripts also run elsewhere.

```bash
git clone https://github.com/adityasmh/the-office.git
cd the-office
npm install
npx tsx ops/setup.ts      # writes .env with MOCK_MODE=1 and a random COMPANY_AUTH_TOKEN
npx tsx ops/doctor.ts     # PASS / WARN / FAIL per requirement, with a one-line fix for each
npm run dev               # router + dashboard on http://127.0.0.1:8787
```

Open <http://127.0.0.1:8787/> for the dashboard and <http://127.0.0.1:8787/v2/#/fleet> for the Fleet view where you create
an order and approve its plan. In mock mode no provider is called; `src/mock.ts` plays the models. When you want the real
thing: put your keys in `.env`, choose a policy (below), install a worker CLI, and run `npx tsx ops/setup.ts --live`.

## Bring your own providers

Models are chosen by a **routing policy**, not by code. Copy a sample and edit:

```bash
cp routing/openrouter.example.json routing.policy.json    # or opencode-go / openai / ollama
```

```json
{ "gateway": { "baseUrl": "https://openrouter.ai/api/v1", "keyEnv": "OPENROUTER_API_KEY" },
  "tiers":   { "routine": "openai/gpt-4o-mini", "standard": "deepseek/deepseek-chat", "complex": "anthropic/claude-sonnet-4.5", "complexAlt": "google/gemini-2.5-pro" },
  "allowedFamilies": ["openai/", "deepseek/", "anthropic/", "google/"] }
```

Put the key in `.env` under the name you wrote in `keyEnv`. Any OpenAI-compatible endpoint works (OpenAI, OpenRouter, Ollama,
vLLM, LM Studio...). Env vars still override the file value by value. Details: [docs/ROUTING_POLICY.md](docs/ROUTING_POLICY.md).
Optional extras (DeepSeek direct off-peak pricing, Claude Code CLI as the "brain", the Laya decision server) are documented
there too and are all off unless you configure them.

## Attach a product

```bash
cp products.example.json products.json     # then edit: id, path to the repo, how to start it, how to prove a change is good
curl -s localhost:8787/company/products     # lists each product, whether its folder exists, whether its health URL answers
```

Work orders run inside the product's own repo with the product's own checks as the quality gate. The office needs nothing from
the product beyond a git repo and (optionally) a health URL. See [docs/EXTENDING.md](docs/EXTENDING.md) for adding a product,
a provider and an integration.

## Integrations

`NOTIFY_WEBHOOK_URL` + `NOTIFY_FORMAT=json|slack|discord|ntfy` sends a short message when an order finishes, fails or needs your
approval ([src/company/notify.ts](src/company/notify.ts)). Pointing it at an **n8n** Webhook node works out of the box (use `json`).
A two-way Slack bridge (`SLACK_*` vars) lets you talk to the assistant from Slack.

## Safety model (the part that earns the jokes)

- **Humans approve.** `planning → awaiting_approval → running`: workers only start after an approve call. Risky things (deleting data,
  spending money, credentials, sending messages, publishing, anything that could break the live system) always reach you;
  routine retries are handled by the manager queue ([docs/AGENT_COORDINATION.md](docs/AGENT_COORDINATION.md)).
- **Worker guard.** `ops/worker-guard.ps1` kills looping, stalled, over-budget or over-time workers and never touches the router
  ([docs/WORKER_GUARD.md](docs/WORKER_GUARD.md)).
- **Policy file.** `policy.json` (example: `policy.example.json`) lists protected paths a work order may never change
  (`.env*`, `.github/workflows/**`, `.git/**`, keys) and caps files per work order.
- **Secret scan + hooks.** `ops/secret-scan.ts` and `ops/install-hooks.ts` keep secret-shaped strings out of commits.
- **Loopback by default.** Every mutating `/company/*` call needs `X-Company-Token`; a non-loopback bind is refused without a token
  ([docs/CEO_RUNBOOK.md](docs/CEO_RUNBOOK.md) §0). "CEO" in this codebase simply means *you, the human operator*.
- **Budget guard.** Spend is tracked per provider; amber/red levels shrink parallelism and downgrade models ([docs/BUDGET_SPEC.md](docs/BUDGET_SPEC.md)).

## Commands

| Command | What it does |
|---|---|
| `npx tsx ops/setup.ts [--live]` | first-run wizard: `.env` from `.env.example`, MOCK_MODE, random token |
| `npx tsx ops/doctor.ts` | checks Node, git, the worker CLI, `.env`, ports, RAM, disk, GPU |
| `npm run dev` | router + dashboard (`tsx src/server.ts`, port `PORT`, default 8787) |
| `npm run typecheck` | `tsc --noEmit` (clean) |
| `npm run check:all` | every offline check in `ops/checks.manifest.json`; add `-- --include-network` for the rest |
| `npx tsx ops/fleet-cli.ts new "<text>" \| status \| approve <id> \| workers` | drive the fleet without the dashboard |
| `npx tsx ops/secret-scan.ts --all` | scan for secret-shaped strings |
| `npx tsx ops/cost-report.ts` | read-only cost report from the fleet logs |
| `docker compose up --build` | mock-mode stack on 127.0.0.1:8787 |

More in [docs/FEATURES.md](docs/FEATURES.md) and [docs/QUICKSTART.md](docs/QUICKSTART.md).

## For humans and LLMs reading this repo

[AGENTS.md](AGENTS.md) is the orientation page (rules, code map, vocabulary). [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the
diagrams. [llms.txt](llms.txt) is the index for crawlers. Vocabulary in one breath: **order** (what you ask) → **work order** (one
worker's slice) → **worker** (a coding-agent terminal) → **gate** (a place a human must say yes) → **needs-you** (the short list that
actually requires you) → **Laya** (a small decision model that picks teams/models; optional) → **brain** (the Claude CLI used for
planning and review; optional).

## Honest limits

- **Windows-first.** Written and tested on Windows + PowerShell. `ops/*.ts` and the server are Node and portable in principle; the
  supervision scripts (`ops/*.ps1`, scheduled tasks) are PowerShell. A few checks pin Windows behaviour.
- **A worker CLI is required for real runs.** The fleet drives `jcode` (`JCODE_BIN`); without it only mock mode works. The model
  gateway part is generic, the worker launcher is not (yet).
- **Some checks are red** in a fresh clone, on purpose-labelled lists: see [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md).
- Git-worktree isolation is a spec ([docs/WORKTREE_MODE_SPEC.md](docs/WORKTREE_MODE_SPEC.md)), not code. The voice add-on server and the
  metrics stack mentioned in some docs are separate pieces that are not part of this repository.
- Comments and docs mention internal order ids, `REPORT_*` files and `docs/overnight/`: history from the private project this was
  extracted from. They are not shipped and are safe to ignore.

## Credits, license, contributing

Office view inspired by [harishkotra/agent-office](https://github.com/harishkotra/agent-office) (MIT), which credits
[pablodelucca/pixel-agents](https://github.com/pablodelucca/pixel-agents) (MIT): see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
Licensed under the [MIT license](LICENSE). [CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md)
