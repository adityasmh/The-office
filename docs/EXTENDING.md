# Extending the Office: add a product, a provider, an integration

The office is deliberately ignorant of what it builds. Three extension points, all file/env based, no code changes needed.

## 1. Add a product (any repo)

A *product* is a git repo the fleet builds and verifies. Tell the office about it in `products.json` (copy `products.example.json`):

```json
{ "products": [ {
    "id": "my-web-app",                       // lowercase, digits, hyphens
    "name": "My web app",
    "path": "../my-web-app",                  // relative to products.json, or absolute
    "description": "optional",
    "start":  { "command": "npm run dev", "port": 3000, "healthUrl": "http://127.0.0.1:3000/" },
    "checks": ["npm test"],                   // the product's own quality gate
    "env":    ["DATABASE_URL"]                // names only, never values
} ] }
```

- `GET /company/products` (loopback or with `X-Company-Token`) returns every product with `repo.exists`, `repo.isGit` and a live `health` probe.
  Only `localhost` health URLs are allowed; the office never probes the internet for this.
- Validation lives in `src/company/products.ts` (`parseProducts`); the offline proof is `ops/products-check.ts`.
- When you write an order for the fleet, name the product and put its `checks` in the order text ("done when `npm run check:all` is green").
  Work orders then run inside that repo and its checks are the gate. Keep product state out of this repo: the products live in their own repos.
- Leadscout is the shipped example entry. Delete it or keep it.

## 2. Add or switch a model provider

Routing is data. `routing.policy.json` (see `routing/*.example.json`, full reference in [ROUTING_POLICY.md](ROUTING_POLICY.md)):

1. Pick the sample closest to your provider and copy it to `routing.policy.json`.
2. Set `gateway.baseUrl` to any OpenAI-compatible `/chat/completions` base, and `gateway.keyEnv` to the NAME of the env var that holds the key.
3. Put the key in `.env` under that name. Set `tiers.*` to model ids your provider serves and `allowedFamilies` to their prefixes.
4. Restart the router. `npx tsx ops/routing-policy-check.ts` validates the shape of your file.

Lookup order is always **env var → routing.policy.json → built-in default**, so one-off overrides (`STANDARD_MODEL=...`) still work.

What the policy does *not* cover: the worker launcher (`jcode -p <provider> -m <model>`, `JCODE_BIN`, `DEEPSEEK_PROVIDER`) and the optional
DeepSeek-direct / OpenCode-Go budget modules (`src/company/deepseekDirect.ts`, `budgetGuard.ts`, `budgetReal.ts`, `usage.ts`). They are provider-specific
optimisers, inert without their keys. To support a different worker CLI, start from `ops/spawn-worker.ps1` and `src/company/workers.ts`.

## 3. Add an integration

- **Outbound notifications (no code):** `NOTIFY_WEBHOOK_URL`, `NOTIFY_FORMAT=json|slack|discord|ntfy`, `NOTIFY_EVENTS=done,failed,awaiting_approval`,
  `NOTIFY_DRY_RUN=1` to log without sending. n8n: create a *Webhook* node (POST), paste its URL, keep `json`. The payload carries only the order id, the first
  120 characters of the order text, the status and PR links (never report text or secrets). Proof: `ops/notify-check.ts`.
- **Slack (two-way):** `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`, optional `SLACK_APP_TOKEN` for Socket Mode. See [SLACK_SETUP.md](SLACK_SETUP.md).
- **Your own inbound call:** the fleet is plain HTTP: `POST /company/fleet/orders` creates an order, `POST /company/fleet/orders/:id/approve` approves it
  (header `X-Company-Token`). Full route list: [FLEET_OPERATOR_GUIDE.md](FLEET_OPERATOR_GUIDE.md); a CLI wrapper: `ops/fleet-cli.ts`.
- **A new integration in code:** copy the shape of `src/company/notify.ts` (never throw, never log URLs or secrets, one POST per event), add an offline `ops/<name>-check.ts`
  against a local stub server, and list the check in `ops/checks.manifest.json`.

## Adding a check

Every check is `ops/<name>-check.ts`: offline, prints PASS/FAIL lines, exits non-zero on failure, uses a temp `COMPANY_ROOT` (`import "./sandbox-company-root.js"` first
if you import `src/company/*`). Add `{ "name", "command": "npx tsx ops/<name>-check.ts", "network": false, "timeoutSec": 60 }` to `ops/checks.manifest.json`.
