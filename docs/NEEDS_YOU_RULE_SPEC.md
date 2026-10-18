# NEEDS-YOU RULE SPEC (shared contract: NY-RULE and NY-CLEANUP)

This spec sits next to docs/NEEDS_YOU_SPEC.md (the action-buttons contract) and does not replace it. The item shape stays {text, runId, id?, kind?, actions?, question?, input?}. This spec ADDS one optional field: `reason?: string`. It says in plain words why a person must act.

The live company data is in `company/` at the repo root. The `%T%/company` tree is a test copy: never edit it.

## 1. Closing records on disk (NY-CLEANUP writes, NY-RULE reads)

### Fleet order (company/fleet/orders.json, one array entry)
Keep `status` as it is ("failed"). ADD these fields:
  "closedAs": "superseded",
  "supersededBy": "<orderId of the later finished order>",
  "closedReason": "<plain words>",
  "closedAt": "<ISO time>",
  "closedBy": "ceo-order"

### Task (company/projects/<projectId>/tasks.json, one array entry)
Set `status` to "rejected". ADD these fields:
  "closedAs": "dropped",
  "closedReason": "<plain words, e.g. no-op smoke test>",
  "closedAt": "<ISO time>",
  "closedBy": "ceo-order"

Never delete a record. Always re-read the file just before writing it, and write it atomically (write to a tmp file, then rename).

## 2. Card behaviour (NY-RULE, src/company/runManagers.ts)
- A record with `closedAs` (dropped or superseded) gets card state "done" and verdict undefined. Its headline starts with "Closed (superseded by X):" or "Closed (dropped):". It is not counted as failed and appears in neither needsYou nor problems.
- A failed fleet order counts as superseded IN MEMORY (derived, not written to disk) when a LATER order (createdAt greater) with status "done" has an explicit `supersedes` entry for it, or has similar text (normalised word-set Jaccard >= 0.5).
- A failed task whose rawRequest or result matches /smoke[- ]?test|tracking[- ]only|no-?op/i counts as dropped IN MEMORY.
- A task in pending_intake, pending_code or pending_merge is never `waiting_for_ceo`. Its state is "working" while updatedAt is under stuckMinutes old, and "stuck" after that. It carries no needsCeo.
  - Auto-restart: at most once per task per 10 minutes, call the existing `approveGate(projectId, taskId, gate)` and `resumeTask(projectId, taskId)`. These are the same calls the server route `/company/projects/:id/tasks/:tid/approve-<gate>` makes.
  - Append {at, runId, gate, ok, message} to company/reports/auto-nudges.json (JSON array, capped at 500).
  - The switch is `NEEDS_YOU_AUTO_NUDGE`, on by default. Setting it to 0 disables the restart but still keeps the item off the list.
  - Exception: a task that has `ceoChoice: {question, options:[..]}` with NO `recommended` value stays `waiting_for_ceo` (a real choice).

## 3. Who qualifies for needsYou (NY-RULE, src/company/needsYouRule.ts)
Export `classifyNeed(card): { need: boolean; reason?: string; category?: 'missing_key'|'spend_limit'|'real_choice' }`.
- `missing_key`: a failed card (not closed or superseded) whose headline, needsCeo or error mentions a missing/absent/invalid access key, API key, secret, token or credential. It is still blocking.
- `spend_limit`: a failed card (not closed or superseded) that mentions a spending/monthly/usage limit, AND budgetNeedsYou() from budgetGuard.ts is still non-null for that provider (the limit is still blocking live work). A budget-guard item that is itself non-null also qualifies.
- `real_choice`: a waiting_for_ceo card from a real choice with no default (see section 2), or a fleet order with status awaiting_approval.
- Everything else: need=false. Failed cards go to problems. Stuck and working cards go to inProgress/problems as today.

## 4. Acceptance probe
Run `npx tsx ops/needs-you-rule-check.ts` (owned by NY-RULE). It uses only synthetic cards/records passed to pure functions, never live files, and prints PASS/FAIL lines. It exits with code 0 only when:
- a fake pending_merge task is absent from needsYou;
- a fake failed order saying 'missing Kimi access key' is present, with a reason;
- a superseded order and a dropped smoke-test task are absent from both needsYou and problems;
- composing twice gives the same result.

With `--live` it composes from the live cards and fails if any of these ids is in needsYou: task:pmumhp51x:tmumi7iz3, task:pmumhg71w:tmumhg72u, fleet:fomumvpd3d, fleet:fomumvo4sg, fleet:fomumvmg57, task:pmumhp51r:tmumjkfgo.
