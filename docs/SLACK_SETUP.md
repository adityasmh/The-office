# SLACK SETUP (the mirror floor)

The Slack mirror is how the CEO sees the company without opening the dashboard:
every pipeline step, every human gate, every merge, every budget refusal and every
assistant dispatch is mirrored into ONE Slack channel, each message spoken as the
agent's persona (custom username + emoji).

Humans read Slack. Models never read Slack. The mirror is one-way and best-effort:
if Slack is down, rate-limited or unconfigured, the company keeps running (see
[Failure behaviour](#failure-behaviour)).

**Never paste the bot token into chat, a doc, a commit or a log.** If a token is ever
seen in a chat/transcript, treat it as compromised and rotate it immediately
([Rotating a leaked token](#rotating-a-leaked-token)).

---

## 1. What the CEO must provide

| # | Item | Where it goes |
|---|------|---------------|
| 1 | A Slack app with **`chat:write`** and **`chat:write.customize`** bot scopes | api.slack.com/apps |
| 2 | The app installed to the workspace → **Bot User OAuth Token** (`xoxb-...`) | `SLACK_BOT_TOKEN` in `.env` |
| 3 | A channel to mirror into, with the bot **invited to it** | `SLACK_CHANNEL_ID` in `.env` |

That is the whole list. No channel ID means the mirror runs in mock/console mode
(nothing is sent), which is safe but invisible to the CEO.

---

## 2. Create the app (5 minutes, one time)

1. Go to <https://api.slack.com/apps> → **Create New App** → **From scratch**.
2. Name it (e.g. `Company Mirror`) and pick the workspace.
3. Left sidebar → **OAuth & Permissions** → **Scopes** → **Bot Token Scopes** → add:
   - `chat:write` — post messages as the bot.
   - `chat:write.customize` — REQUIRED for the persona floor. Without it Slack
     silently ignores `username` / `icon_emoji`, so every model would appear as one
     anonymous bot and the CEO could not tell Opus from Kimi.
   - Optional: `chat:write.public` if you want to post to public channels the bot
     has not been invited to. The recommended path is still to invite the bot (step 4).
4. Scroll up → **Install to Workspace** → **Allow**.
5. Copy the **Bot User OAuth Token** (`xoxb-...`) from that page.
   - Copy it straight into `.env`. Do not paste it into chat, an issue, or a commit.
   - If you ever have to show it to a human, show only the last 4 characters.

## 3. Set the env vars

Add these two names to `.env` (values are yours; **no real value belongs in this doc
or any tracked file**):

```
SLACK_BOT_TOKEN=xoxb-...        # from OAuth & Permissions; secret
SLACK_CHANNEL_ID=C0XXXXXXXXX    # the channel to mirror into; not a secret
```

Notes:

- `.env` is local only. `.env.example` lists the same two names with empty values, so
  a fresh clone knows they exist.
- `MOCK_MODE=1` forces console mode even when both values are set (useful for dry runs).
- `SLACK_CHANNEL_ID` is a workspace-visible identifier (everyone in the channel can see
  it in the URL and the channel details pane), not a credential. `slackStatus()`
  therefore reports it. `SLACK_BOT_TOKEN` is a credential and is **never** reported,
  logged or returned by any code path.

## 4. Invite the bot to the channel

Open the target channel in Slack and send:

```
/invite @Company Mirror
```

Without the invite (or `chat:write.public`), every post fails with
`not_in_channel` and the mirror reports that exact error.

### Channel ID format

| Kind | Format | Example shape |
|------|--------|---------------|
| Public channel | `C` + 8–11 alphanumerics | `C0XXXXXXXXX` |
| Private channel | `G` + 8–11 alphanumerics | `G0XXXXXXXXX` |
| Direct message | `D` + 8–11 alphanumerics | `D0XXXXXXXXX` |

How to find it:

- Slack desktop/web: open the channel → channel name at the top → **channel details**
  (or **About**) → scroll to the bottom → copy the **Channel ID**.
- Or copy the channel link: `https://<workspace>.slack.com/archives/**C0XXXXXXXXX**`
  — the last path segment is the ID.
- It is **not** the `#channel-name` and not the workspace name.

## 5. Verify

Dry check first (no network, no token used):

```
npx tsx ops/slack-test.ts --selftest
```

Then the real smoke test — this sends exactly ONE message:

```
npx tsx ops/slack-test.ts
```

Then, if `SLACK_CHANNEL_ID` is not in `.env` yet, post to a specific channel for that
one run (nothing is written to `.env`):

```
npx tsx ops/slack-test.ts --channel C0XXXXXXXXX
```

What good looks like (`status` never contains the token):

```
[slack-test] slackStatus() = {"configured":true,"channel":"C0XXXXXXXXX","mode":"live"}
[slack-test] postAs(SONNET_LEAD) -> {"posted":true,"ts":"1727433600.123456"} in 348ms
[slack-test] OK: live post accepted by Slack (ts=1727433600.123456).
```

With no token configured the mirror is total and the script exits 0:

```
[slack-test] slackStatus() = {"configured":false,"channel":null,"mode":"mock"}
[slack:mock] [Sonnet (Tech Lead)] (no SLACK_BOT_TOKEN configured - mock/console fallback) slack-test: ...
[slack-test] postAs(SONNET_LEAD) -> {"posted":false,"mock":true,"ts":"mock-thread","error":"no SLACK_BOT_TOKEN configured - mock/console fallback"} in 0ms
[slack-test] MOCK mode: nothing was sent to Slack. This is the expected result with no token configured.
```

Exit codes: `0` when posted or mocked, `1` when live mode was active but Slack
refused the post. On failure the script prints the **precise Slack error**:

| Slack error | Meaning | Fix |
|-------------|---------|-----|
| `invalid_auth` / `not_authed` | token missing, revoked or wrong workspace | reinstall the app, update `SLACK_BOT_TOKEN` |
| `channel_not_found` | wrong `SLACK_CHANNEL_ID` (or not a channel ID) | copy the ID from channel details |
| `not_in_channel` | bot not a member | `/invite @<bot>` in the channel |
| `missing_scope` | scope not granted or app not reinstalled | add `chat:write` + `chat:write.customize`, reinstall |
| `ratelimited` | too many posts too fast | wait; the error carries `retry-after` |
| `msg_too_long` | a single post exceeded Slack's limit | already chunked at 3400 chars x 8 |

## 6. What the mirror posts

| Event | Persona (Slack username / emoji) | Content |
|-------|----------------------------------|---------|
| Pipeline step (`log()` in `src/company/pipeline.ts`) | the agent's own route persona (`personaForRoute`) | `role: <text>` per pipeline stage |
| **Gate 1 — intake** | `Opus (Manager)` `:brain:` | task title, project + task id, `POST /company/projects/<pid>/tasks/<tid>/approve-intake` |
| **Gate 2 — before code** | `Opus (Manager)` `:brain:` | `.../approve-code` |
| **Gate 3 — before merge** | `Opus (Manager)` `:brain:` | `.../approve-merge` |
| **Merged** | `Laya (QA)` `:clipboard:` | `MERGED - task <tid> is done` + title + result excerpt |
| **Budget exhausted** | `Sonnet (Tech Lead)` `:compass:` | agent, department, wanted vs remaining USD, the refused request, how to raise the allocation (`POST /company/agents/:agentId/budget`) |
| **Assistant dispatch** | `Chief of Staff (Assistant)` `:office:` | the assistant's reply, each work order routed per department (role track, task id, project), and any skipped/unaffordable work |
| Team run (`/team/run`) | manager + employee + `Laya (QA)` | one thread; QA verdict |
| Handoff / manual ping (`/handoff/*`, `/notify/slack`) | `Sonnet (Tech Lead)` | brain summary + task |

Per-agent personas (used by the pipeline mirror): `Opus (Manager)`, `Sonnet (Tech Lead)`,
`Kimi (Coder)`, `GLM (Routine)`, `DeepSeek (Standard)`, `Qwen (Context)`,
`Muse (Fallback)`, `Laya (QA)`, `Chief of Staff (Assistant)`. All of them need
`chat:write.customize` to render as themselves.

Gates, merges, budget alerts and assistant dispatches are **only** emitted when the
corresponding call site invokes them (the pipeline/agentchat/assistant wiring).

## 7. Failure behaviour

`src/slack.ts` is deliberately total. An unconfigured or broken mirror must never
delay or crash a pipeline stage:

- **No token, no channel, or `MOCK_MODE=1`** → clearly labelled
  `[slack:mock] ... (reason)` line on the console and a resolved
  `{ posted: false, mock: true }`. No throw, no request.
- **Every request is bounded** by `AbortSignal.timeout(10000)`, so a hanging Slack
  can never wedge a pipeline stage.
- **HTTP errors, non-JSON bodies, timeouts and rate limits** resolve to
  `{ posted: false, error: "<precise reason>" }`. `postAs()` never throws and never
  returns a rejected promise, so `void postAs(...)` is safe even without `.catch()`.
- **Rate/spam bound**: one logical message fans out to at most 8 chunks (3400 chars
  each), threaded after the first.
- **Token redaction**: everything leaving the module goes through
  `redactSecrets()`, which strips `xox*`/`xapp-` shaped strings and the exact
  configured token. A token that ends up in pipeline text is replaced with
  `[redacted-token]` before it reaches Slack or the console.
- **`slackStatus()`** returns
  `{ configured, channel, mode: "live" | "mock", lastError? }` — no token, ever —
  where `configured` means both env values are present and `mode` is `"live"` only
  when it will really post.
- `lastError` keeps the last precise failure for ops; it is cleared by the next
  successful post.

Run `npx tsx ops/slack-test.ts --selftest` to re-verify redaction and the exact
approve URL shapes without sending anything.

## 8. Rotating a leaked token

A bot token seen in a chat, transcript, screenshot, log or commit is compromised:
anyone holding it can post as the bot in every channel the bot is in. Revoke first,
then reinstall — changing `.env` alone does **not** invalidate the leaked value.

1. **Revoke**: <https://api.slack.com/apps> → your app → **OAuth & Permissions** →
   **Revoke All OAuth Tokens for Your Workspace** (or press **Reinstall to Workspace**
   if Slack offers it; the old token is invalidated at that step). You can also see and
   kill active tokens under **Bot User OAuth Token → Manage**.
2. **Reinstall**: **Install to Workspace** → **Allow**, so a fresh token is issued.
3. **Update `.env`**: replace `SLACK_BOT_TOKEN` with the new `xoxb-...` value. Never
   paste the new value into chat, docs, commits or logs; mask to the last 4 characters
   if a human must confirm it.
4. **Restart the server** (`npm run dev` / restart the company service) so the new
   value is read at startup. `SLACK_CHANNEL_ID` does not change.
5. **Re-verify**: `npx tsx ops/slack-test.ts` → expect `posted: true`. A still-leaked
   token would instead have produced `invalid_auth` before step 3.
6. **Confirm the old token is dead**: `npx tsx ops/slack-test.ts --channel <ID>` with
   the old value would return `invalid_auth`. Never re-add it to `.env` to test.
7. **Scrub the leak**: delete/redact the message or commit that contained the token
   (and rewrite history if it was committed), then note the rotation in `HANDOVER.md`.
