# Routing policy

`routing.policy.json` (repo root; override the path with `ROUTING_POLICY_FILE`) decides which model gateway and which model ids the office uses.
Code: `src/routingPolicy.ts`. Consumers: `src/config.ts` (gateway URL, key variable, tier models, allowed families) and
`src/company/offpeak.ts` (peak windows of the optional DeepSeek-direct saver). The file is read once at start-up; restart to apply edits.

## Shape (every field optional; unknown keys ignored)

```json
{
  "gateway": { "baseUrl": "https://host/v1", "keyEnv": "NAME_OF_ENV_VAR_WITH_THE_KEY" },
  "tiers":   { "routine": "id", "standard": "id", "complex": "id", "complexAlt": "id" },
  "allowedFamilies": ["prefix", "prefix"],
  "direct":  { "provider": "deepseek", "model": "deepseek-flash",
               "peakUtcBlocks": [[1, 4], [6, 10]], "peakWeekdaysOnly": true,
               "offPeakMultiplier": 0.5, "boundaryBufferMinutes": 45 }
}
```

| Field | Meaning |
|---|---|
| `gateway.baseUrl` | OpenAI-compatible base URL (`…/chat/completions` is appended). Env `GATEWAY_BASE_URL` overrides. |
| `gateway.keyEnv` | NAME of the env var holding the key. The key itself never goes in the file. |
| `tiers.routine / standard / complex / complexAlt` | model ids for trivial text, normal coding, hard/escalation work, and an alternate hard model. Env `ROUTINE_MODEL`, `STANDARD_MODEL`, `COMPLEX_MODEL`, `QWEN_MODEL` override. |
| `allowedFamilies` | a model id must start with one of these (lower-case prefixes) or it is swapped for the standard model at the choke points (`enforceModel` in `config.ts`). `claude*` ids are always passed through. Env `MODEL_ALLOWLIST` overrides. |
| `direct.*` | the optional "provider's own API at off-peak prices" saver: peak windows in UTC hours `[from,to)`, whether peak is weekdays only, the off-peak price multiplier, and a safety buffer in minutes before a phase flips. Only matters when `DEEPSEEK_DIRECT=1` and `DEEPSEEK_API_KEY` is set. |

## Samples (`routing/`)

| File | Setup |
|---|---|
| `opencode-go.example.json` | the built-in defaults written out: OpenCode Go gateway + DeepSeek/GLM families |
| `openrouter.example.json` | OpenRouter, mixed vendors (`OPENROUTER_API_KEY`) |
| `openai.example.json` | plain OpenAI (`OPENAI_API_KEY`) |
| `ollama.example.json` | fully local Ollama server, no key |

Model ids in the samples are examples; use ids your account can call.

## Validation and troubleshooting

- `npx tsx ops/routing-policy-check.ts` (offline) checks parsing, merging, env override of the file name, the malformed-file fallback and every sample.
- A malformed file prints one warning (`[routing-policy] … malformed … using the built-in defaults`) and the defaults apply; the office keeps running.
- `npx tsx ops/doctor.ts` warns about missing keys; `GET /company/budget/real` and the dashboard Budget view show spend per provider.
- Not covered by the policy: the worker launcher and the provider-specific budget modules; see [EXTENDING.md](EXTENDING.md) §2.
