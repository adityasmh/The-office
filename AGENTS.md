# AGENTS.md: orientation for AI coding agents (and humans in a hurry)

Read this first. It is written so an LLM with no prior context can work in this repo safely. (`CLAUDE.md` and `llms.txt` point here.)

## What this is

**The Office** is a local, single-operator control plane that runs a small "AI company": an operator gives a plain-text **order**; a **manager** plans it into
**work orders**; each work order runs in a guarded **worker** terminal; a **reviewer/tester** checks it; a human **approves** the plan and risky steps.
Express server (`src/server.ts`, default port 8787) + static dashboard (`public/`), state in plain files under `company/` (git-ignored). TypeScript run by `tsx`.
It is product-agnostic: products are separate repos attached through `products.json`.

## Vocabulary (the code uses these words everywhere)

| Word | Meaning |
|---|---|
| **CEO** | the human operator (you). Not a person's name: the role. "needs the CEO" = needs a human decision |
| **order** | a request in plain text. Fleet order states: `planning → awaiting_approval → running → reviewing → done / failed` |
| **work order (WO)** | one narrow slice of an order; one worker terminal each |
| **worker** | a coding-agent terminal (`jcode`), launched via `ops/spawn-worker.ps1` under `ops/worker-guard.ps1` |
| **gate** | a point where a human must approve (`src/company/gates.ts`, fleet approval) |
| **needs-you** | the short list of prompts that really need the human; routine ones go to the **manager queue** |
| **Laya** | an optional small decision model/server (`DECISION_BACKEND=laya`) that picks teams/models; heavy parts need a GPU. `MOCK_MODE=1` bypasses it |
| **brain** | the Claude Code CLI used for planning/review (`src/claudeSubscription.ts`, `brainRouter.ts`); optional |
| **gateway** | the OpenAI-compatible model endpoint workers/planners call; chosen by `routing.policy.json` |
| **product** | a repo the office builds; listed in `products.json` |

## Commands

```bash
npm install
npx tsx ops/setup.ts          # .env with MOCK_MODE=1 + random COMPANY_AUTH_TOKEN
npm run dev                   # router + dashboard on http://127.0.0.1:8787
npm run typecheck             # tsc --noEmit  (must stay clean)
npm run check:all             # offline checks from ops/checks.manifest.json (add: -- --include-network)
npx tsx ops/<name>-check.ts   # one check
```

Quality gate: `typecheck` clean and `check:all` with no NEW failures. Known failures are listed in [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md);
never delete or loosen a check to get green.

## Hard rules

1. **Never run anything against the real `company/` folder, `.env`, or a live router/port from a check.** Checks use a temp `COMPANY_ROOT`
   (`import "./sandbox-company-root.js";` must be the FIRST import of any check that imports `src/company/*`: ES imports run before top-level code).
2. **No secrets in files.** Env var names only. `ops/secret-scan.ts` enforces it. `.env` is git-ignored.
3. **Never open a visible terminal / never start a background process without hiding it** (Windows: `conhost.exe --headless`). See [docs/PITFALLS.md](docs/PITFALLS.md): read it fully.
4. **Humans approve risky things.** Do not add code that deletes data, spends money, sends messages or publishes without going through a gate.
5. **Small targeted edits** in big files (`fleet.ts` ~200 KB, `server.ts` ~100 KB, `assistant.ts`, `terminalReaper.ts`): `grep -n`, read the range, edit the range.
6. Read env vars at use time with safe defaults; document every new one in `.env.example`.

## Map of the code

| Area | Files |
|---|---|
| Server | `src/server.ts` (all HTTP routes: `/company/*`, `/api/*`, SSE stream, auth guard), `src/config.ts`, `src/routingPolicy.ts`, `src/gateway.ts` (model calls), `src/orchestrator.ts`, `src/decision*.ts` (Laya/Jev) |
| Fleet (the core) | `src/company/fleet.ts` (orders, planning, workers, review, publish), `fleetGithub.ts`, `fleetTalk.ts`, `workers.ts`, `sessions.ts`, `terminalReaper.ts`, `lifecycle.ts`, `runManagers.ts` |
| Pipeline (older) | `src/company/pipeline.ts`, `gates.ts`, `dispatch.ts`, `flow.ts`, `org.ts`, `roles.ts`, `panel.ts` |
| Money | `budget*.ts`, `usage.ts`, `deepseekDirect.ts`, `offpeak.ts`, `ops/cost-report.ts` |
| Brain/routing | `brainRouter.ts`, `claudeSubscription.ts`, `claudeSignIn.ts`, `src/adaptive/*` |
| Human interface | `assistant.ts`, `briefing.ts`, `inbox.ts`, `needsYou*.ts`, `managerQueue.ts`, `slack*.ts`, `notify.ts`, `public/v2/*` (views: office, fleet, flow, ops, budget, system, terminals) |
| Safety | `authguard.ts`, `policy.ts`, `scrubEnv.ts`, `airGap.ts`, `ops/worker-guard.ps1`, `ops/secret-scan.ts` |
| Ops view | `opsView.ts` (workers, infra, order-queue/watchdog state: shows "missing" if you run no order-queue runner) |
| Products | `src/company/products.ts` + `products.json` |
| Metrics | `src/metrics/*` (router metrics, alerts), optional |
| Checks | `ops/*-check.ts`, `ops/checks.manifest.json`, `ops/run-all-checks.ts`, `public/v2/*-check.mjs` |

Docs index: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (diagrams), [docs/EXTENDING.md](docs/EXTENDING.md) (add a product/provider/integration),
[docs/ROUTING_POLICY.md](docs/ROUTING_POLICY.md), [docs/FLEET_SPEC.md](docs/FLEET_SPEC.md), [docs/FLEET_OPERATOR_GUIDE.md](docs/FLEET_OPERATOR_GUIDE.md) (HTTP API),
[docs/CEO_RUNBOOK.md](docs/CEO_RUNBOOK.md) (trust boundary, launch, shutdown), [docs/AGENT_COORDINATION.md](docs/AGENT_COORDINATION.md) (rules for agents).

## Things that surprise newcomers

- **"CEO", "Laya", "Muse", "Joey"** are role/persona names (operator, decision model, a cheap coder model lane, the voice assistant persona), not people.
- Comments cite internal order ids (`F11`, `WO1`, `RP1`), `REPORT_*`/`ORDER_*` files and `docs/overnight/`. Those documents belong to the private project this was extracted from
  and are not shipped. The code is self-contained.
- Many provider-specific modules (`deepseekDirect.ts`, `budgetGuard.ts`, `budgetReal.ts`, `usage.ts`) are optional optimisers for OpenCode Go + DeepSeek. They are inert without their keys.
- The worker launcher is `jcode`-specific. The model side (routing policy, gateway) is generic OpenAI-compatible.
- Windows is the home platform; PowerShell scripts supervise the router. The server itself is plain Node.
