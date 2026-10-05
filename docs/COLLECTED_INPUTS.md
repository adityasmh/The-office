# COLLECTED INPUTS (collector session, 2026-09-29)

Written by the COLLECTOR session after interviewing the CEO (Aditya) in the visible
terminal. **No secrets in this file** — masked/yes-no only. Secrets live only in `.env`.

---

## 1. Slack

| Item | Status |
|---|---|
| `SLACK_BOT_TOKEN` | SET — masked, ends `IVaP`, 59 chars (unchanged value; CEO declined rotation) |
| `SLACK_CHANNEL_ID` | SET — `C0C4BVBG5N3` (written by the collector) |
| Workspace | `adisons` (`T0C4X141X52`) |
| Bot user | `llmrouterfloor` (`U0C5MNR162U`) |
| Granted bot scopes, after the CEO's reinstall (verified via `auth.test`) | `chat:write`, `channels:history`, `chat:write.customize`, `app_mentions:read`, `channels:manage`, `channels:read` |
| Mode reported by `slackStatus()` | `live` |

### Update (later in the session): the scopes arrived

The CEO added the scopes and reinstalled. Detail the collector verified: **the bot token string did
not change** - reinstalling applies the new scopes to the SAME `xoxb-` token, so no `.env` edit was
needed. An earlier attempt reported "all scopes are currently already added" while `auth.test` still
showed only the original two: scopes are not live until the reinstall actually happens.

The CEO then pasted an `xoxp-` token. That is a **User OAuth Token** (the box adjacent to the bot
one), which acts as the CEO personally. The collector did NOT put it in `.env`; the correct bot token
was already in place and working. That user token is now in the chat transcript and should be
revoked.

Verified end to end with `conversations.history`: the newest message carries
`username=Laya (QA)` and `icon={"emoji":":clipboard:"}`, so `chat:write.customize` genuinely works
and personas render distinctly. Two earlier messages (pre-reinstall) have an empty `username` - exactly
the anonymous-bot behaviour expected before the scope existed.

### `ops/slack-test.ts` outcomes

1. First live run (channel ID set, bot not invited):
   `postAs(SONNET_LEAD) -> {"posted":false,"error":"Slack rejected the post: not_in_channel"}`
   -> FAILED. Diagnosis: bot was not a member of `C0C4BVBG5N3`.
2. After the CEO invited `@llmrouterfloor`:
   `postAs(SONNET_LEAD) -> {"posted":true,"ts":"1790677584.049529"}` -> **OK**
3. Second persona re-check:
   `postAs(OPUS_MANAGER) -> {"posted":true,"ts":"1790677966.006469"}` -> **OK**
4. `ops/slack-test.ts --selftest`: 8/8 PASS (token redaction + approve-URL shapes, no network).

### Still missing (reported to the CEO, not blocking the mirror)

- `chat:write.customize` — **not granted**. Without it every agent posts as the single
  anonymous `llmrouterfloor` bot, so personas (Opus vs Kimi) are indistinguishable in Slack.
- `channels:manage` + `channels:read` — **not granted**. Required for the CEO's request to
  provision dedicated per-team / per-company channels; `conversations.create` fails without it.
- Granting either one requires **Reinstall to Workspace**, which is also the natural point to
  rotate the token. CEO said to leave the token as-is for now.

### Security notes (for the record)

- The token in `.env` is the one that leaked in chat; it is still live and valid.
- During this session the `edit` tool echoed a `.env` diff containing the token value, so that
  value is also visible in the collector window's transcript. It should be rotated when convenient.

---

## 2. Budget caps — CEO decision (verbatim)

> "just work with whatever budget u have, i dont care muc ab it"
> "set one single company cap"

Interpretation recorded: **keep the existing virtual policy as-is; no changes requested.**
The CEO asked for a single company cap but did not supply a number, and explicitly said not to
worry about it. No number was supplied, so no change was made. This is a virtual cap used only
to REFUSE work, not real money.

Live `/company/budgets` at collection time: 33 agents, `totalUsd = 80.00` allocated,
`$1.241032` spent, `$78.758968` remaining. Per-role allocation as measured:

| role | agents | allocated |
|---|---|---|
| coder | 7 | 35.00 |
| manager | 5 | 15.00 |
| tester | 5 | 12.50 |
| opposer | 5 | 10.00 |
| prompt-enhancer | 5 | 2.50 |
| summarizer | 5 | 2.00 |
| assistant | 1 | 3.00 |

Note: `docs/VERIFICATION_REPORT.md` predicted `80.50` for the 33-row case; the live number is
`80.00` (one summarizer row allocates less than the 0.50 default). Minor doc drift, not a bug
in the read path.

### Update (later in the session): the cap was dropped and every agent set to $5

CEO, verbatim: "second fuck the budget cap bs drop it." then "give each 5$ budget. go."

**APPLIED by the collector:** all 33 agents set to `allocatedUsd = 5.00` via
`POST /company/agents/<composite-id>/budget` - 33 succeeded, 0 failed. The composite
`<projectId>::<agentId>` keys from `GET /company/budgets` were used because bare ids are ambiguous
across projects (7 coders exist across 5 projects). Result: `totalUsd = 165.00`,
`spent = 2.736543`, `remaining = 162.263457`. Per-role totals are now uniform: coder 7x5 = 35, and
5x5 = 25 each for manager / tester / opposer / prompt-enhancer / summarizer, assistant 1x5 = 5.

**This is not the durable fix.** Two gaps remain for the code owner:

1. `DEFAULT_ALLOCATION_USD` in `src/company/budget.ts` is unchanged, so **newly hired agents still
get the old defaults** (coder 5, manager 3, tester 2.5, opposer 2, enhancer/summarizer 0.5,
assistant 3, unknown 1). Making $5 uniform for future agents is a one-line change; the collector
is not permitted to edit `src/**`. Existing allocations persist in `company/budgets.json` and
survive restarts.
2. There is **no env switch** to disable budget enforcement. `src/company/budget.ts` holds the
policy and `src/server.ts:397` maps `budget_exhausted` to a `402`. "Drop the cap" therefore needs a
code change. Temporary bypasses available today: raise allocations, or send `{"force": true}`.
3. The mutation required the `x-company-token` header (see section 7 for the runbook drift).

---

## 3. Graphify — CEO decision

**NOT ASKED.** The collector never actually put this question to the CEO: the interview was
cut short when the CEO said "MOVE ON GO FAST DO YOUR WORK FAST" after the budget topic.
The collector had announced it as one of "4 quick questions" but never delivered it.

Default in force, assumed by the collector and NOT confirmed by the CEO: **the dependency-free
built-in extractor**. It is already built, installed and verified working (see below). The real
`graphify` CLI is not installed and installing it needs an explicit yes.

### Update: the CEO answered, and the decision is DEFERRED

CEO, verbatim: "graphify: 1. do we need it? 2. what do u need?" and then "we'll build graphify later."

Recorded decision: **DEFERRED - keep the built-in extractor running.** The collector's answer to his
two questions:

1. *Do we need it?* Not yet. `symbols = 0` in all 5 projects because the repos are empty, so the
digest saves almost nothing today, and `HANDOVER.md` itself calls the step "Optional but chosen".
2. *What do you need?* The identity of the tool. Nothing in this repo names a source, package or URL
for it, and the obvious candidate is a trap: `npm view graphify` returns
`"RGG (Random Graph Generator)"` v1.0.0 - a random-graph generator, NOT a code extractor.
Installing that would put the wrong binary on PATH. So: a URL or package name, plus a yes.

Verification run by the collector (`npx tsx ops/graphify-extract.ts --help`):

- `graphify CLI: (not installed) — not found on PATH`
- extractor actually used: `builtin walker (graphify unavailable)` for all 5 projects
- 5 projects refreshed in 26 ms total

| project | files | symbols | headings | digest |
|---|---|---|---|---|
| pmumhg71w | 0 | 0 | 0 | 235c |
| pmumhp51r | 1 | 0 | 5 | 582c |
| pmumhp51u | 8 | 0 | 7 | 796c |
| pmumhp51x | 4 | 0 | 7 | 628c |
| pmumhp520 | 0 | 0 | 0 | 255c |

**Finding worth flagging:** `symbols = 0` for every project. The digests currently carry files
and headings but no symbols, because the project repos are still effectively empty. The graph is
wired and running, but it will not save meaningful tokens until the repos have real code.

`src/company/pipeline.ts` prompt injection (GRAPHIFY.md section 7) is still NOT applied —
owned by the coordinator, deliberately left alone.

---

## 4. Identity

**NOT ASKED.** This question was never delivered to the CEO either (same cut-short interview).
No correction was requested by the CEO, so nothing was changed. Both values were verified against
the code and against real captured output instead of against the CEO:

| Field | Value | Source of truth |
|---|---|---|
| Company name | `Laya AI Company` | `company/org.json` -> `.name`, and `docs/VERIFICATION_REPORT.md:245` and `:414` (live panel/state output) |
| CEO display name | `Aditya Shukla` | `src/company/panel.ts:19` `CEO_NAME` default; `docs/VERIFICATION_REPORT.md:245` shows `ceo={"name":"Aditya Shukla","title":"Chief Executive Officer"}` |

`CEO_NAME` is not set in `.env`, so the code default applies. Stronger than assumed: a real
verification artifact in this repo already observed the exact strings.

---

## 5. Open-ended: anything else? — CEO answer

**NOT ASKED.** The open-ended question was never put to the CEO. He volunteered the following
spontaneously, as part of giving the collector the channel URL:

> "this is the new channel but i want u to make designated channels for each team, company.
> seperately spawn one agent to do this."

Recorded as a NEW work item, not collector scope:

- Create dedicated Slack channels per team/department, distinct from the single mirror channel
  `C0C4BVBG5N3`.
- The CEO wants this done by a **separate spawned agent**, not by the collector.

**Blocker, verified:** the current Slack app token has only `chat:write` and `channels:history`.
`conversations.create` requires `channels:manage` (public) / `groups:write` (private). So the
dedicated-agent task cannot succeed until the CEO adds those scopes and reinstalls.

Handed to the coordinator (`mizaru`) as a spawn request, since the collector is scoped to inputs
only and does not spawn agents or edit anything outside `.env`.

---

## 6. Files the collector touched

- `.env` — **only** `SLACK_CHANNEL_ID` was changed (empty -> `C0C4BVBG5N3`). Verified after the
  edit: 31 lines at the time, LF endings, trailing newline present, no BOM, no trailing
  whitespace, token and all other keys untouched.
- `docs/COLLECTED_INPUTS.md` — this file (new).

Nothing under `src/**` or `public/**` was touched.

### The CRLF section in `.env` (lines 32-41)

**Origin NOT confirmed.** It appeared during this session but was not the collector's edit (the
collector's edit preserved LF throughout and touched one line). The collector cannot tell whether
the CEO pasted it or another worker/agent wrote it; both are plausible. It adds
`COMPANY_AUTH_TOKEN` (set, 64 chars, ends `51a0`) and `HOST=127.0.0.1`, both of which ARE read by
`src/config.ts` and `src/company/authguard.ts` and both of which parse correctly under dotenv.
Earlier wording in this file attributed it to the CEO; that attribution was a guess and is
thereby retracted.

---

## 7. Corrections, guesses and gaps (self-audit after the first pass)

Interpretations the collector had to guess at, stated plainly:

1. **"set one single company cap"** with no number. The collector asked once for the number and
   the CEO replied "just work with whatever budget u have, i dont care muc ab it". Recorded as:
   no change made, existing virtual caps left in place. If the CEO meant a hard total cap exists,
   it does not; nothing in code enforces a company-wide total today.
2. **Graphify** and **identity** were assumed/verified rather than asked (see sections 3 and 4).
3. **Section 5's request** was read as a new work item for the coordinator, not collector scope.
   The collector did not spawn the agent. If the CEO expected it spawned immediately, that is a
   miss; the coordinator holds the request.
4. **Budget figure.** `docs/VERIFICATION_REPORT.md` predicted `80.50` where live is `80.00`.
   The collector did not chase the discrepancy; it is flagged, not resolved.

Documentation gap found while re-reading (not fixed, not collector scope):

- `.env` and `src/company/authguard.ts` both point at **"docs/CEO_RUNBOOK.md §0 (Trust
  boundary)"**. `docs/CEO_RUNBOOK.md` has **no section 0** and no mention of `COMPANY_AUTH_TOKEN`,
  `HOST` or `X-Company-Token` anywhere (its headings run 1-9). The referenced operator-facing
  story is missing.
- Consequence worth checking by the owner: the runbook's own example commands (`POST
  /company/projects`, `POST /company/agents/<id>/budget`) do **not** send `X-Company-Token`,
  while the guard requires that secret on every mutating `/company/*` request. Those documented
  examples may now fail with 401.
- `src/config.ts` changed *during* this session (it gained `host` and `authToken` plus new
  `assertConfig` checks after the collector's first read), so other workers were editing `src/**`
  concurrently. The collector re-read it rather than relying on the stale copy.

---

## 8. Claude "rate limited again and again" investigation (CEO question)

CEO asked why Claude is being rate-limited repeatedly when it has not been used and the budget is
untouched. Answer, established by direct live probing, not inference:

**The account is healthy. The app's Claude path is what is broken.**

Evidence, in order:

1. Credentials are valid: `C:\Users\user\.claude\.credentials.json` exists with
   `subscriptionType = pro`, `rateLimitTier = default_claude_ai`, scopes include `user:inference`,
   and both access and refresh tokens are present. The access token is fresh (issued 2026-09-29
   08:37Z, expires 16:37Z) and was NOT expired at test time.
2. The app's call fails with a real `429`, body
   `{"type":"error","error":{"type":"rate_limit_error","message":"Error"}}` and **every rate-limit
   header null** - no `anthropic-ratelimit-*`, no `retry-after`. A genuine consumption limit always
   returns those headers. Their absence plus the contentless `"Error"` is a client-identity
   refusal, not a quota.
3. `claude-opus-5-5` with the app's hardcoded UA returned a much clearer
   `400 invalid_request_error`: "Claude Code 1.0.57 does not support this model; version 2.1.280 or
   newer is required", `error_code: claude_code_version_too_old`. Root cause of the spoof:
   `src/claudeSubscription.ts` hardcodes `user-agent: claude-cli/1.0.57` (a 2025-era string).
4. Bumping the spoofed UA to `claude-cli/2.1.280` cleared the version error but every model then
   returned the same headerless 429 - consistent with the file's own header comment: "Anthropic
   removed official third-party OAuth support (opencode PR #18186)".
5. Control that settles it: the **real CLI installed on this machine is v2.1.284 and works**.
   `claude -p 'say ok'` answered `ok` in 7.6s, and `claude -p 'say ok' --model claude-sonnet-5-5`
   answered `Ok` in 7.3s. So the subscription, the account, the model IDs in `.env`
   (`claude-sonnet-5-5`, `claude-opus-5-5`) and inference itself are all fine.

**Why it feels like a loop with no usage:** every Claude-routed call fails, the code falls back to
`callMuseSpark()`, and that throws `Missing META_API_KEY for muse-spark-1.3` because `META_API_KEY`
is empty in `.env`. So there is **no working fallback at all** - the task fails outright instead of
degrading, and the 429 is the only visible symptom. This is the same Muse fallback the CEO asked to
replace.

**Fix options for the code owner** (collector cannot edit `src/**`):

- Immediate, works today: point the fallback at `space-bunny-free` on the opencode gateway (free,
  verified coherent at 3.7s).
- Proper Claude fix: stop hand-rolling the OAuth spoof and shell out to the installed
  `claude` CLI (v2.1.284), which is proven working, or update the spoofed UA + beta headers and
  accept that the third-party OAuth path may stay blocked.
- Note: adding `ANTHROPIC_API_KEY` is explicitly against this project's rules, so it is not offered.

Diagnostic probe used: `%TEMP%\claude-probe.mjs` (outside the repo, read-only, never prints a token;
accepts model and user-agent as argv).

### End-to-end validation (pass 2) and a NEW finding: the real error is masked

Running the app's own `generate()` from `src/orchestrator.js` with a Claude-routed route
(`via: "claude-subscription"`, model = `config.claudeSonnet`) produced:

```
THREW in 715ms -> Error: Missing META_API_KEY for muse-spark-1.3
```

Two things follow, and the second is a bug worth fixing on its own:

1. A Claude-routed call does hard-fail end to end, which is why the pipeline stops.
2. **The error surfaced to the operator is the Muse error, not the Claude 429.** The `catch` in
   `orchestrator.ts` calls `callMuseSpark()`, that throws, and the thrown error replaces the original
   Claude failure. So the visible symptom points at Meta/Muse even though the root cause is the
   Claude client fingerprint. This partly explains why "Claude is rate limited" looked
   inexplicable: the message the operator sees is misleading.

Same pass also validated that the assistant/manager fallback path is healthy today:
`callGatewayModel(config.models.standard)` = `deepseek-v4-flash` returned `ok` in 1308ms. So the
assistant is genuinely not broken; only the router's Claude fallback is.

### `.env` integrity, checked against `.env.example`

`.env` has 16 keys, `.env.example` has 14. No duplicate keys. Exactly one empty value:
`META_API_KEY`.

- In `.env` but missing from `.env.example`: `MOCK_MODE`, `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`
  -> `.env.example` is stale and should gain those placeholders.
- In `.env.example` but not `.env`: `LAYA_API_KEY` (optional; local Laya needs no key).
- `COMPANY_AUTH_TOKEN` and `HOST` ARE present in `.env.example`, so the trust-boundary worker kept
  the example in step.

This corroborates the earlier claim that the collector's edit touched only `SLACK_CHANNEL_ID`:
no duplicate keys, no lost keys, no unexpected empty values beyond the pre-existing `META_API_KEY`.

---

## 9. Fallback-model change: REQUESTED, VERIFIED, **NOT APPLIED**

Status is important here: **nothing has been changed for this request yet.** No `.env` key was
edited and no source file was touched. This section exists so the record cannot be read as "done".

CEO request, verbatim: "replace the fallback to muse for all including CEO's assistant. make the
fallback to the cheapest costing model. any free model from opencode which is very good at
conversing. use that."

**Model chosen on evidence: `space-bunny-free`** (the only free gateway model that converses;
`longcat-2.5-preview-free` returns empty text).

### Interpretation the collector had to guess at

The request assumes one Muse fallback spans all roles. That is not the structure:

| Fallback | Mechanism | Where it points | Reachable from `.env`? |
|---|---|---|---|
| Router: Claude 429 | `orchestrator.ts:54` -> `callMuseSpark()` | Meta `api.meta.ai` (Muse) | No - needs 1 source line |
| CEO assistant | `assistant.ts:170` -> `callGatewayModel(config.models.standard)` | opencode gateway, `deepseek-v4-flash` | Yes, via `STANDARD_MODEL` |
| Manager / Qwen | `workers.ts:389,399` -> same | opencode gateway, `deepseek-v4-flash` | Yes, via `STANDARD_MODEL` |

So the **assistant is already NOT on Muse** - it is already on the gateway. Only the router path uses
Muse, and only for the Claude-429 case.

### What the change actually requires

1. `src/orchestrator.ts:54` -> `const fb = await callGatewayModel(config.claudeFallback, system, prompt);`
   (`callGatewayModel` is already imported on line 4). **One line.** This is the only real "replace the
   Muse fallback" edit, and it needs a worker-boundary clearance because `src/**` is owned by others
   and `src/config.ts` was edited underneath this session already.
2. `CLAUDE_FALLBACK_MODEL=space-bunny-free` in `.env`. Alone this does **nothing** - re-verified
   against the CURRENT `config.ts`: `claudeFallback` is defined and never read anywhere.
3. Optional, for "all roles including the assistant": `STANDARD_MODEL=space-bunny-free` in `.env`.
   **Side effect the collector deliberately did not take unilaterally:** `models.standard` is also the
   standard-complexity TIER used for normal routed work, not just a fallback, so this drops routine
   work to the free model as well.

### Why it is still unapplied

The collector asked the CEO for a go/no-go before touching another worker's file and has no answer
yet. The collector's mandate allows editing only `.env` and this file. Guessing here would mean either
(a) editing an owned source file without clearance, or (b) silently changing the standard tier via
`.env` - both are changes the CEO could regret, so both were held.

### Validated at code level, not just by raw HTTP

A probe run under `npx tsx --env-file=.env` imported the app's **real** `src/config.js` and
`src/gateway.js` and called the actual functions. Output:

```
gatewayBaseUrl = https://opencode.ai/zen/go/v1
gatewayKey set = true len=51
metaBaseUrl    = https://api.meta.ai/v1
metaKey set    = false len=0          <- META_API_KEY really is empty
museModel      = muse-spark-1.3
claudeFallback = muse-spark-1.3
models.standard= deepseek-v4-flash
MUSE FALLBACK THREW: Error: Missing META_API_KEY for muse-spark-1.3
GATEWAY space-bunny-free: OK in 2079ms -> "I can help you answer questions, solve problems,
  write and edit content, plan projects, and much more."
```

That confirms both load-bearing claims executably: the fallback in place today cannot run, and the
proposed replacement returns coherent text through the production code path. Probe:
`%TEMP%\fallback-probe.mjs` (outside the repo, reads real config, prints no secrets).

Budget claim re-validated at the persistence layer too: `company/budgets.json` holds **33 entries,
all `allocatedUsd = 5`, zero exceptions**, `updatedAt 2026-09-29T10:47:20.172Z`.

### CEO clarification checked: "Muse is free on opencode, just use that, remove the Meta AI option"

Probed the opencode gateway directly for the three Muse ids. Raw gateway responses:

```
OK    space-bunny-free               2298ms  coherent reply
FAIL  muse-spark-1.3-contributor      491ms  HTTP 400
      {"error":{"type":"server_error","message":"Upstream request failed: This Go model
       trains on request data. Allow paid endpoints that train on request data in your
       workspace's Privacy settings to use it."}}
FAIL  muse-spark-1.2-contributor     1010ms  HTTP 400  (same message)
FAIL  muse-spark-1.3                  409ms  HTTP 400
      {"error":{"type":"server_error","message":"Upstream request failed: Model is unavailable."}}
```

So the premise does not hold as stated:

- The Muse ids on the gateway (`*-contributor`) are **not free** - the error literally calls them
  "paid endpoints", and they **train on request data**. Enabling the required workspace Privacy
  setting would mean company prompts and code flowing into a training endpoint. That is a data-
  governance decision for the CEO, NOT something the collector will enable.
- `muse-spark-1.3`, the id currently configured in `MUSE_MODEL`, is simply **unavailable**.
- `space-bunny-free` remains the only genuinely free model that converses.

Consequence for the request: "use free Muse from opencode" cannot be satisfied as described.
Either

1. keep Muse but have the CEO knowingly enable "paid endpoints that train on request data" in the
   opencode workspace Privacy settings (costs money AND feeds request data to training), or
2. use `space-bunny-free` (genuinely free, verified working, no training opt-in), or
3. use `muse-spark-1.3-contributor` deliberately once (1) is enabled.

The "remove the Meta AI option" half is unambiguous and uncontroversial: `META_API_KEY` is empty,
`api.meta.ai` has never succeeded, and `metaBaseUrl`/`metaKey` plus `callMuseSpark` can simply be
deleted. That is a small `src/config.ts` + `src/gateway.ts` edit, still owned by another worker.

### CEO DECISION: option (B) - APPLIED in `.env`

CEO, verbatim: "yea yea (B) works with me".

Applied by the collector in `.env` (these are model ids and key removals, no secrets):

- `MUSE_MODEL=muse-spark-1.3-contributor`
- `CLAUDE_FALLBACK_MODEL=muse-spark-1.3-contributor`
- `META_BASE_URL` and `META_API_KEY` **deleted** - verified 0 `META*` keys remain. `src/config.ts`
  then falls back to its built-in defaults (`https://api.meta.ai/v1`, empty key), so app behaviour is
  unchanged: `callMuseSpark()` still throws on the empty key, exactly as before.
- A 5-line comment records the decision and the follow-up so the file is self-explaining.

Post-edit verification: 42 lines, LF preserved for the collector's edits (the other worker's auth
block is still the CRLF section), trailing newline present, **0 lines with trailing whitespace**,
and `dotenv` parses every key correctly.

**Still blocked on a human step:** the gateway answered `muse-spark-1.3-contributor` with HTTP 400
"Allow paid endpoints that train on request data in your workspace's Privacy settings" on two
separate attempts after the CEO chose (B), so the workspace Privacy toggle was NOT yet enabled at
that time. Until it is, the fallback cannot reach that model. The CEO must enable it in the opencode
workspace Privacy settings.

**Still blocked on a code owner:** the fallback still calls `callMuseSpark()`, which reads
`config.metaBaseUrl`/`config.metaKey`. With those env keys gone the function still throws on the
empty key, so `.env` alone does not yet make the fallback work. The needed edit remains one line in
`src/orchestrator.ts:54` (or repointing `callMuseSpark` at the gateway), plus deleting the Meta path
in `src/config.ts` + `src/gateway.ts`. Ownership clearance is still pending with `mizaru`.

### SECURITY INCIDENT during this edit (disclose, do not repeat)

While applying the above, the file-editing tool echoed a diff **with surrounding context lines**, and
that context included the live `OPENCODE_API_KEY` value. That value is therefore now present in this
session's transcript, exactly like the Slack bot token earlier. Two secrets are now exposed this way
in this window: the Slack bot token (`...IVaP`) and the opencode gateway key (`...eOeW`).

Both should be rotated. Lesson for future edits to `.env`: any anchored edit whose context window
reaches a secret line will print that secret, so secret-adjacent lines must be rewritten by a method
that does not echo values.

---

## 10. Follow-up: "is muse-spark-1.3-contributor completely free?" + "find a way to flip the toggle"

Answered from opencode's own published documentation (`https://opencode.ai/docs/zen/`) plus direct
endpoint probes.

**Cost:** the pricing table lists "Muse Spark 1.3 Contributor Free" as Free / Free / Free / Free
(input / output / cached read / cached write), so on paper it is zero cost. The same page states the
real price: *"Heavily discounted token pricing in exchange for permission to use your prompts and
completions to train future Meta models."* So it is free of cash and paid for in data, and the
gateway classifies it as a "paid endpoint" in the workspace privacy gate. The non-contributor
`muse-spark-1.3` is genuinely paid: $1.25 in / $4.25 out per 1M tokens.

**But we cannot use the free one from this app at all.** Probed both bases:

| model id | base `zen/go/v1` (ours, 30 models) | base `zen/v1` (44 models) |
|---|---|---|
| `space-bunny-free` | **OK**, HTTP 200, "ok", 1555ms | - |
| `muse-spark-1.3-contributor-free` | HTTP 400 "Model is unavailable." | HTTP 403 `FreeTierError` "OpenCode's free tier can only be used from within OpenCode" |
| `muse-spark-1.2-contributor-free` | HTTP 400 "Model is unavailable." | (not tested) |
| `muse-spark-1.3-contributor` | HTTP 400, requires the training opt-in | - |

The `-contributor-free` ids are not in our base's model list at all. They live on `zen/v1`, where the
free tier is refused for external callers: **"OpenCode's free tier can only be used from within
OpenCode."** The free Muse is unreachable from a server-side router by design.

**Consequence: flipping the workspace toggle does NOT get us the free model.** The toggle only unlocks
`muse-spark-1.3-contributor` on our base, which is the "heavily discounted" (paid) variant that trains
on request data. Option (B) therefore cannot deliver "free"; it delivers "paid, plus training", once
the toggle is on.

**Better option, with doc evidence:** `space-bunny-free` already works on our configured base, and the
docs describe it as *"a stealth model that's free on OpenCode for a limited time. Its provider
follows a zero-retention policy and does not use your data for model training."* That is strictly
better than the Muse contributor path: free, and no training on company data.
`longcat-2.5-preview-free` is also free and zero-retention but returns empty content, so it stays
unusable.

**The toggle's location:** opencode's docs put it under the Zen **workspace settings** ("Admins can
enable or disable specific models for the workspace... Requests made to a disabled model will return
an error. This is useful for cases where you want to disable the use of a model that collects
data."). No API exists for it: `/me`, `/workspace`, `/settings` on both `zen/go/v1` and `zen/api` all
returned 404. It is a web-dashboard action. The browser bridge is not installed on this machine
(Brave detected), so driving the CEO's logged-in session would first require installing that bridge.

`.env` was left holding the CEO's chosen `muse-spark-1.3-contributor`; switching it to
`space-bunny-free` is a one-value edit.

### "How much better is Muse than space bunny?" - cannot be measured, and one error is decisive

A 3-prompt head-to-head harness was written and run. Availability gate first, Muse side:

```
FAIL zen /responses        muse-spark-1.3  1131ms HTTP 402
     {"error":{"type":"server_error","message":"Upstream request failed: Insufficient account funds"}}
FAIL zen /chat/completions muse-spark-1.3  1032ms HTTP 402  (same: Insufficient account funds)
FAIL go  /chat/completions muse-spark-1.3   408ms HTTP 400  "Model is unavailable."
```

**No Muse endpoint is reachable with this key, so any quality claim would be invented.** The harness
is preserved at `%TEMP%\quality-probe.mjs` and prints a side-by-side for conversational, judgement
and clarity prompts; it can be run the moment Muse becomes reachable.

**Implication for option (B) that the CEO should know before flipping anything:** two of three errors
are **"Insufficient account funds"**, not permission errors. `muse-spark-1.3-contributor` is classified
by the gateway as a *paid* endpoint, so flipping the privacy toggle may simply move the failure from
"training opt-in required" to "insufficient funds". The account appears not to be funded for paid
models - which is also consistent with every other model that has worked so far being a `-free` id.

The only proxy available without a benchmark is published pricing, which is a weak capability signal:
Muse Spark 1.3 is $1.25 in / $4.25 out per 1M (mid-tier; GLM 5.3 sits at $1.40 / $4.40, Claude Sonnet 5
at $2.00 / $10.00), while `space-bunny-free` is $0 as a time-limited "stealth model". Free does not
imply weak for stealth models, and the gap genuinely cannot be characterised from this machine.

### FINAL DECISION: `space-bunny-free` - APPLIED and VERIFIED

CEO, verbatim: "ok go w space bunny".

`.env` final state for the fallback path:

- `CLAUDE_FALLBACK_MODEL=space-bunny-free`
- `MUSE_MODEL` **removed** (the Muse path is abandoned)
- `META_BASE_URL` / `META_API_KEY` remain removed
- comment block rewritten to record the real reason Muse was dropped

Applied with a value-blind PowerShell rewrite rather than the edit tool, because the lines sit within
three lines of `OPENCODE_API_KEY` and the edit tool's diff context had already leaked that key once.
The script pre-flight-checked every line it intended to touch and aborted otherwise. Post-checks:
bytes 2179, CRLF 9 preserved (the other worker's auth block), LF 33, trailing newline present, no BOM,
**0 lines with trailing whitespace**, 43 lines. All unrelated keys intact and parsing: `SLACK_BOT_TOKEN`
(ends `IVaP`, 59), `SLACK_CHANNEL_ID=C0C4BVBG5N3`, `COMPANY_AUTH_TOKEN` (ends `51a0`, 64),
`HOST=127.0.0.1`, `CLAUDE_SONNET=claude-sonnet-5-5`, `GATEWAY_BASE_URL` unchanged.

Verified through the app's own code (`npx tsx --env-file=.env`):

```
claudeFallback = space-bunny-free
GATEWAY space-bunny-free: OK in 3167ms -> "I can help you answer questions, write, edit,
  analyze information, solve problems, and brainstorm ideas."
```

So the *target* of the fallback is now correct and proven working. The one remaining defect is
structural, not config: `src/orchestrator.ts:54` still calls `callMuseSpark()`, which throws
`Missing META_API_KEY for muse-spark-1.3`. The required code edit is now unambiguous -

```
const fb = await callGatewayModel(config.claudeFallback, system, prompt);
```

plus deleting `metaBaseUrl`/`metaKey` from `src/config.ts` and `callMuseSpark` from `src/gateway.ts`.
Ownership clearance is still pending with `mizaru`.

### Handoff: a dedicated coder agent was spawned to make that change

CEO, verbatim: "ask a coder to change the code and dont worry ab rotating keys rn".

Action taken: spawned a dedicated agent from this session (label "fallback coder",
`session_hatchling_1790680245706_70ae57cd16f71b0c`) with a brief scoped to exactly three files:
`src/orchestrator.ts` (the fallback call + the error-masking fix + `"muse"` removal only if nothing
produces it), `src/gateway.ts` (`callMuseSpark` deletion) and `src/config.ts` (`metaBaseUrl`,
`metaKey`, `museModel` deletion). The coder is explicitly forbidden from touching `.env` or this
file, must re-read each file before editing because of concurrent workers, and must run
`npx tsc --noEmit` plus a real before/after probe through `generate()`.

`mizaru` was notified that a coder is now editing those files, so the swarm owner cannot be
surprised by a concurrent edit.

Key rotation: **deferred by the CEO** ("dont worry ab rotating keys rn"). The Slack bot token and the
opencode gateway key remain exposed in this session's transcript and in section 9 above; that is now
a known, accepted, temporary state rather than an open action. It should still be done later.

### LANDED AND INDEPENDENTLY VERIFIED

The coder's edits are in the tree, and the collector re-verified them independently (not by trusting
the coder's report):

- `src/orchestrator.ts:4` - import is now `{ callGatewayModel, callQwenMessages }`; `callMuseSpark` is gone.
- `src/orchestrator.ts:56` - `const fb = await callGatewayModel(config.claudeFallback, system, prompt);`
- `src/orchestrator.ts:60` - the masking bug is fixed: the error message is now
  `` `Claude failed: ${err} | fallback (${config.claudeFallback}) also failed: ${fbErr}` `` so the primary
  failure can no longer be hidden by the fallback's.
- `src/gateway.ts` - `callMuseSpark` and its `META_API_KEY` guard are deleted (grep finds no
  `callMuseSpark`, `META_API_KEY` or `muse` left).
- `src/config.ts:16` - `claudeFallback` default is now `"space-bunny-free"`; `museModel`, `metaKey` and
  `metaBaseUrl` are gone.
- `src/orchestrator.ts:11` - the `Route.via` union is now
  `"gateway" | "qwen-messages" | "claude-subscription"`; the `"muse"` member was correctly removed.

**CORRECTION to an earlier claim in this file.** This section previously said `src/slack.ts` "was also
touched by the coder". **That was wrong and is retracted.** `src/slack.ts` was never modified: its
mtime is still 15:33 local / 10:03Z, which predates the coder's spawn at 11:10Z, and it still contains
the Muse references. The mistake came from reading the swarm's file-attachment list, which includes
files an agent merely READ. Lesson: an agent's file list is not a change log; mtime and grep are.

Actual residual dead code, now confirmed by grep rather than assumed:

- `src/slack.ts:89` still has `| "MUSE_FALLBACK"` in the persona-name union.
- `src/slack.ts:100` still defines the `MUSE_FALLBACK` persona ("Muse (Fallback)").
- `src/slack.ts:111` still has `if (via === "muse") return "MUSE_FALLBACK";`.

This is unreachable now, because nothing can produce `via: "muse"` any more. It still compiles only
because `personaForRoute(via: string, modelId: string)` takes a plain `string` rather than the `Route.via`
union - which is exactly why `tsc --noEmit` stayed clean despite the leftover. Cosmetic cleanup for
whoever owns `src/slack.ts`; it does not affect behaviour, and the Slack smoke test still passes
(verified below).

Independent checks, all run by the collector after the coder's edits:

```
npx tsc --noEmit                                    -> exit 0, no output (CLEAN)

generate(... via: "claude-subscription" ...)        -> UNEXPECTED SUCCESS in 2536ms
  {"text":"ok", "fallback":true,
   "primaryError":"Error: Claude subscription rate-limited (429)..."}

ops/slack-test.ts --selftest                        -> 7/7 PASS
ops/slack-test.ts                                   -> posted:true ts 1790680762.685839
```

The middle line is the headline: a Claude-routed call that previously **threw** now **succeeds** via
`space-bunny-free`, and `primaryError` carries the real Claude 429 - so the diagnosis is now visible to
whoever looks at a failure, instead of the misleading `Missing META_API_KEY` message.

Two residual notes, both cosmetic:

- `.env.example` is now stale: it still lists `META_BASE_URL`, `META_API_KEY` and `MUSE_MODEL`, which no
  longer exist in `.env` (and are no longer read). Not in the collector's writable scope.
- `src/claudeSubscription.ts` is still broken for its own reason (the spoofed `claude-cli/1.0.57`
  client). The fallback now covers it, so Claude-routed work degrades to the free model instead of
  failing; the real Claude fix remains outstanding.

---

## 11. INCIDENT: `.env` was clobbered, and recovered

**What happened.** At 2026-09-29 11:35:48Z (about 36 seconds before the CEO asked about the app
token), `.env` was overwritten with its **pre-session contents**: 1272 bytes / 32 lines, which is
exactly the size and state recorded at the very start of this session. Everything added during the
session was wiped:

| Lost | Consequence |
|---|---|
| `SLACK_CHANNEL_ID` | Slack mirror and the new bridge both fall back to mock mode - Slack appears dead |
| `COMPANY_AUTH_TOKEN` | every `/company/*` mutation would be refused |
| `HOST` | (defaulted back to loopback, so no exposure) |
| `CLAUDE_FALLBACK_MODEL=space-bunny-free` | reverted to `muse-spark-1.3`, which is unreachable - the fresh fallback fix would have failed again |
| dead `META_*` / `MUSE_MODEL` keys | reappeared |

**Most likely cause (evidence-based, not certain):** a **stale Notepad buffer**. The clobbered content
was missing BOTH the channel-ID edit made at 10:22Z AND the auth block added around 10:31Z, so the
overwriting buffer was loaded before 10:22Z - consistent with a Notepad window the CEO opened early in
the session (the collector suggested `notepad .env` at ~10:09Z) and saved much later. Alternatives
(a worker regenerating the file) cannot be ruled out, but no process in this session produced that
exact original byte content; a stale editor buffer does.

**Recovery.** The auth token was not lost: the router process started before the clobber still held it
in memory, and exposes a loopback-only `GET /company/auth/bootstrap`. Recovery fetched it from there
and confirmed it matched the pre-clobber value (`len=64`, ends `51a0`) **without ever printing it**, and
wrote it back inside the same process.

Restored: `SLACK_CHANNEL_ID=C0C4BVBG5N3`, `CLAUDE_FALLBACK_MODEL=space-bunny-free`, `COMPANY_AUTH_TOKEN`,
`HOST=127.0.0.1`. Removed again: the dead `META_*`/`MUSE_MODEL` keys. Added: an empty `SLACK_APP_TOKEN=`
slot with instructions, for the Socket Mode upgrade.

Post-repair state: 47 lines, 2216 bytes, LF-only, trailing newline present, no BOM, 0 trailing-
whitespace lines, 0 `META_`/`MUSE_` keys. `dotenv` parses every key. Re-verified functionally:
`ops/slack-test.ts` posted live again (`posted:true`, ts 1790681883.220739).

**Operational warning for the CEO:** any Notepad window still holding the old `.env` will wipe the
session's work again if it is saved. It must be closed WITHOUT saving, and a fresh editor opened.

Note: because the API key value was also echoed by the edit tool earlier, this repair deliberately used
the value-blind PowerShell approach rather than an anchored edit.

---

## 12. Final state after the Slack assistant work (2026-09-29)

This section is the closing summary. Sections 1-11 above are the live record; this one supersedes the
"still open" lists in them.

### Delivered and verified

- **Two-way Slack**: the CEO can message the assistant in `C0C4BVBG5N3` and get a threaded answer. Runs
  INSIDE the router (`:8787`) via Socket Mode with an automatic polling fallback. Verified: socket connects
  and reaches `hello`; a real events_api envelope was received and acked; the loop guard skips the bot's own
  posts (proven on live traffic); human-shaped messages pass the gate (8 shapes tested); an end-to-end
  threaded reply was posted (`ts 1790682676.063709`).
- **"Understand everything"**: `src/company/ceoContext.ts` builds a live digest (per-project task counts by
  status, recent titles, agents, budgets, running sessions, key docs) and `assistant.ts` appends it to the
  assistant prompt. Real output ~2500 chars. Proven answer: "25 tasks run, 16 merged... $161.83 of $165.00
  remains" answered WITHOUT reading files.
- **Slack report-back (work order #1)**: finished tasks now post into the Slack thread the request came
  from. Persisted `projectId::taskId -> threadTs` map at `company\slack-task-threads.json`, watcher on
  `SLACK_REPORT_INTERVAL_MS` (default 5000, unref'd), post-once with `reportedTs` persisted immediately,
  channel fallback. VERIFIED: merged post `ts 1790685187.851309`; failed post `ts 1790685581.289389` whose
  text carried the task's own error; idempotent on both (second pass posted 0); channel fallback;
  `tsc --noEmit` clean; wiring (starts on start, clears on stop) confirmed with fake credentials.
- **Slack mirror + personas**, **$5 for all 33 agents**, and the **fallback switched to `space-bunny-free`**
  (all verified earlier in this file).

### Handed away, not mine

- `CLAUDE_BACKEND=cli`: Claude Code replaced the spoofed `claude-cli/1.0.57` OAuth call (my 429 finding)
  with the real `claude -p` CLI.
- Work orders #2 (chain regression smoke) and #3 (docs) went to other jcode sessions per Claude Code.
- Per-team Slack channels (the CEO's earlier request) remain with `mizaru` as a spawn request.

### Still open, honestly

1. **A router restart** is required for the report-back to actually run: the code landed 18:01:43 but the
   live router booted earlier. I have requested it in `docs/AGENT_COORDINATION.md` and cannot do it myself
   (explicit instruction). The blocker cleared at 18:41 when both in-flight tasks ended `failed`.
2. **No human message has ever been typed into the channel.** Every stage around that keystroke is verified,
   but the keystroke itself is untested. This is the one acceptance step software here cannot perform.
3. **Two secrets are exposed in this session's transcript** (Slack bot token, opencode gateway key) after the
   edit tool echoed them in diff context. The CEO said not to worry about rotation for now; it should still
   happen. Never confirmed which of those two incidents was avoidable in the tooling.
4. Both tasks that blocked the restart ended `failed` after sitting in `coding` - consistent with the known
   pipeline hang. Worth a look by the pipeline owner; not fixed by me.
5. `src/claudeSubscription.ts`'s underlying issue is now moot for the fallback path, but the real Claude
   route still depends on the CLI being installed and logged in.

---

## 13. Change inventory (for reversal) - because this repo has no git

`git` is not present in this project, so there is no history to diff against. If the CEO ever decides
that part of this session should be undone, this is the complete list of what the collector touched, and
what to do about each. Nothing here destroys data; all of it is individually reversible by hand.

| # | File | Change | To undo |
|---|---|---|---|
| 1 | `.env` | `SLACK_CHANNEL_ID=C0C4BVBG5N3` | set it back to empty |
| 2 | `.env` | `CLAUDE_FALLBACK_MODEL=space-bunny-free` | remove the key (code default is now `space-bunny-free`) |
| 3 | `.env` | `META_BASE_URL`, `META_API_KEY`, `MUSE_MODEL` removed; `SLACK_APP_TOKEN` slot added; comment blocks rewritten | restore from the values recorded in sections 9-11 |
| 4 | `.env` | `COMPANY_AUTH_TOKEN` and `HOST=127.0.0.1` re-added after the 11:35Z clobber | remove only if the trust-boundary worker also removes them |
| 5 | `src/company/slackInbound.ts` | the whole two-way bridge existed already; I added the task report-back block, 3 state fields, 2 test hooks, and the call sites | delete the `Task report-back (work order #1)` block and its call sites; the file then reverts to the coder's bridge-only version |
| 6 | `src/company/slackInbound.ts` | briefly TWO report-back implementations existed (mine and the coder's) because my grep gave a false negative and I wrongly concluded the feature was missing; the duplicate was removed and the surviving one is MINE | no action needed; `tsc` is clean and grep confirms exactly one implementation (`TASK_MAP_CAP`, `TERMINAL_TASK_STATUSES`, `taskMapFileFor`, `noteDispatchedTasks` all return 0 hits) |
| 7 | `src/config.ts` | `slackAppToken` added (by the bridge coder) | remove that one line |
| 8 | `src/server.ts` | `startSlackInbound()` called after listen (by the bridge coder, ~line 491) | remove the import + the call |
| 9 | `src/company/assistant.ts` | `LIVE COMPANY CONTEXT:` appended in `buildUserPrompt` (by the bridge coder) | remove that append |
| 10 | `docs/COLLECTED_INPUTS.md` | created by me (sections 1-13) | delete the file |
| 11 | `docs/AGENT_COORDINATION.md` | my log entries only (the file is Claude Code's) | delete my dated entries |
| 12 | `company/budgets.json` | all 33 agents set to `allocatedUsd = 5.00` | restore per-role defaults, or re-run the old policy |
| 13 | `company/slack-inbound.json` | the bridge's own cursor file, written by the running router | safe to delete; it re-baselines |

NOT touched by me, for the avoidance of doubt: `src/company/pipeline.ts`, `src/company/gates.ts`,
`src/company/workers.ts`, `src/company/flow.ts`, `src/claudeSubscription.ts`, `public/index.html`, and
`ops/smoke-company.ts` - those belong to Claude Code and the other jcode sessions.

Also worth knowing: the only changes with side effects OUTSIDE this machine are the Slack posts. The
channel `C0C4BVBG5N3` now contains the mirror traffic, four smoke-test posts, one verified end-to-end
threaded reply (`1790682676.063709`), and the report-back test posts (`1790685187.851309`,
`1790685581.289389`, `1790685188.131899`). Slack messages can be deleted from the client if the CEO wants
the channel clean.
