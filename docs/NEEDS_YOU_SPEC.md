# NEEDS-YOU ACTIONS SPEC (shared contract)

Four parallel orders build this: NY-MODEL (`src/company/briefing.ts`), NY-RESOLVER (`src/company/needsYouActions.ts`, `src/server.ts`, `fleet.ts`/`gates.ts`/`pipeline.ts` additive), NY-UI (`public/v2/views/briefing.js`, `public/v2/views/assistant.js`, `docs/CEO_RUNBOOK.md`), NY-CHAT (`src/company/assistant.ts`). Do not change this contract. If you must extend it, only ADD optional fields.

## 1. Item shape (exported from src/company/briefing.ts)

export type NeedsYouKind = 'approve' | 'choice' | 'provide' | 'external';
export type NeedsYouEffect =
  | 'approve_gate'     // params: {projectId, taskId, gate:'intake'|'code'|'merge', note?}
  | 'retry_task'       // params: {projectId, taskId}
  | 'drop_task'        // params: {projectId, taskId}
  | 'retry_order'      // params: {orderId}   reissue same text, normal model rules
  | 'reissue_kimi'     // params: {orderId}   reissue with planner/reviewer forced to Kimi
  | 'drop_order'       // params: {orderId}
  | 'provide_key'      // params: {orderId?, envName:'OPENCODE_API_KEY'} then retry_order
  | 'open_link'        // params: {url}  (UI opens it; resolver just logs, does NOT resolve the item)
  | 'recheck_budget';  // params: {provider:'claude'|'go'}
export type NeedsYouAction = { id: string; label: string; effect: NeedsYouEffect; params?: Record<string,string>; url?: string };
export type NeedsYouInput = { name: string; label: string; secret: boolean; placeholder?: string };
export type BriefingItem = {
  text: string; runId?: string;
  id?: string;             // present on every needsYou item (problems[] may omit)
  kind?: NeedsYouKind;
  actions?: NeedsYouAction[];
  question?: string;       // plain words, required for 'choice' and 'external'
  input?: NeedsYouInput;   // required for 'provide'
};

All new fields are optional in the TS type so `problems`/old readers still compile, but EVERY `needsYou` entry MUST carry id, kind, actions (at least 1).

## 2. Item ids
- Run-card items: `id = runId` (e.g. `task:pmumhp51x:tmumi7iz3`, `fleet:fomumvmg57`). Task runIds are `task:<projectId>:<taskId>`, fleet ones are `fleet:<orderId>`.
- Budget guard item: `id = budget:<provider>` (`budget:claude` / `budget:go`).
- In URLs, ids are passed through `encodeURIComponent`.

## 3. Action ids (fixed vocabulary)
`approve`, `approve_alt`, `retry`, `drop`, `use_kimi`, `raised_retry`, `open_limit_page`, `save_key_retry`.

## 4. Classification rules (NY-MODEL)
- **Task card `waiting_for_ceo`, task status pending_intake:** kind `approve`. Actions: approve (approve_gate intake) and drop (drop_task).
- **Task card `waiting_for_ceo`, task status pending_merge:** approve (approve_gate merge) and drop. pending_code works the same way with gate code. If the gate is unknown, infer it from the text (intake/merge/plan). A plan item defaults to merge when the task status is pending_merge.
- **Choice between alternatives:** if the needsCeo text offers two alternatives (e.g. 'Approve the recommended hidden comment (or choose the visible header)'), the kind is `choice`, with a question, `approve` (params.note = recommended option) and `approve_alt` (params.note = the alternative).
- **Failed task card:** kind `choice`, question 'Retry this task or drop it?', actions retry (retry_task) and drop (drop_task).
- **Failed fleet card mentioning a missing access key / API key / Kimi key:** kind `provide`, input {name:'OPENCODE_API_KEY', label:'Kimi access key (OpenCode Go gateway)', secret:true}. Actions: save_key_retry (provide_key, params {orderId, envName}) and drop (drop_order).
- **Failed fleet card mentioning the Claude spending/monthly/usage limit:** kind `external`, question 'Claude hit its spending limit. Raise it at claude.ai, use Kimi instead, or tell us you raised it.' Actions: open_limit_page (open_link, url 'https://claude.ai/settings/usage'), use_kimi (reissue_kimi), raised_retry (retry_order).
- **Any other failed fleet card:** kind `choice`, with retry (retry_order) and drop (drop_order).
- **budgetGuard `budgetNeedsYou()` non-null:** item id `budget:<provider>`, text = its text. For claude it is `external`, with open_limit_page, use_kimi (reissue_kimi of every failed fleet order whose card mentions the Claude limit; no orderId param) and raised_retry (recheck_budget). For go it is `external` with the link `https://opencode.ai` and raised_retry (recheck_budget).
- **Resolved items:** an item is hidden when `company/reports/needs-you-resolved.json` has its id with `at` >= the card's `updatedAt` (a card that changes after the click shows up again).

## 5. Resolver (NY-RESOLVER, src/company/needsYouActions.ts)

export type ResolveResult = { ok: boolean; message: string; newState?: string; itemId: string; actionId: string; needsYou?: BriefingItem[] };
export async function resolveNeedsYou(itemId: string, actionId: string, input?: Record<string,string>, who?: string): Promise<ResolveResult>;
export function openNeedsYouItems(): BriefingItem[]; // = getBriefing().needsYou

- It never throws; it always returns `{ok:false, message:<plain words>}` on error.
- **Unknown or stale id or action:** `ok:false`, message 'That item is no longer waiting on you (it may already be handled). Refresh the list.'
- **On success:** it writes `needs-you-resolved.json[itemId] = {at, actionId}` (except for open_link), rebuilds the briefing (`getBriefing()` and write-through via `refreshBriefing({maxChecks:0})` if cheap) and returns the new `needsYou`.
- **Decision log:** every call (ok or not) appends to `company/reports/needs-you-decisions.json`. This is a JSON array, capped at 500, with entries `{at, who, itemId, actionId, effect, ok, message}`. who defaults to 'ceo' (API) or 'ceo-chat' (Assistant). NEVER include `input` values.
- **Secrets:** they never go in logs, the JSON files, API responses or console output. Messages say 'Key saved.' only.

## 6. HTTP (NY-RESOLVER, src/server.ts)
`POST /api/needs-you/:itemId/resolve` and alias `POST /company/needs-you/:itemId/resolve`, body `{actionId, input?}` -> 200 `{ok, message, newState, needsYou}` when ok. A stale or unknown item returns 404 `{ok:false, message}`, a bad body returns 400, and an action failure returns 200 with `{ok:false, message}`. A thrown error returns 500 `{ok:false, message}` and the process stays up. `GET /api/needs-you` returns `{needsYou}`. Both sit behind the same auth middleware as `/company/*`.

## 7. Chat hook (NY-CHAT, src/company/assistant.ts)

export function askNeedsYouInChat(): number;   // appends one assistant thread message per newly-open question item; returns count
export async function tryResolveFromChat(text: string): Promise<ResolveResult | null>; // null = message is not an answer

- Items already asked are tracked in `company/reports/needs-you-asked.json`.
- NY-RESOLVER calls `askNeedsYouInChat()` from server.ts in an unref'd 30s interval, soft-imported and wrapped in try/catch. assistant.ts calls `tryResolveFromChat` itself at the start of handling a CEO message.
