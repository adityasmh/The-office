# Needs-You Cleanup Report

This report covers the 6 false-alarm items cleared from the CEO's Needs-you list per order FLEET-ORDER fomun4pog5/NY-CLEANUP.

## What was done

| ID | What it was | Action taken | New status |
|---|---|---|---|
| task:pmumhp51x:tmumi7iz3 | QA & Verification README comment plan, stuck at `pending_merge` | Chose the recommended **hidden HTML comment**, recorded the decision in the task plan, and approved the merge gate. | `merged` |
| task:pmumhg71w:tmumhg72u | LiveFinal `hello.txt` task, stuck at `pending_intake` for 94+ min | Approved the intake gate and resumed the task so coder-1 could proceed. | `coding` (past `pending_intake`) |
| fleet:fomumvpd3d | Old voice order that failed on Claude spend limit | Marked as superseded by later finished order `fomumvtp5p` (all 3 work orders PASSed). | `failed` (kept), `closedAs=superseded`, `supersededBy=fomumvtp5p` |
| fleet:fomumvo4sg | Old voice order that failed on Claude spend limit | Marked as superseded by later finished order `fomumvtp5p`. | `failed` (kept), `closedAs=superseded`, `supersededBy=fomumvtp5p` |
| fleet:fomumvmg57 | Old voice order that failed on missing Kimi key | Marked as superseded by later finished order `fomumvtp5p`. | `failed` (kept), `closedAs=superseded`, `supersededBy=fomumvtp5p` |
| task:pmumhp51r:tmumjkfgo | Executive Office failed smoke-test tracking task | Closed as dropped: `status=rejected`, `closedAs=dropped`, `closedReason=no-op smoke test`. | `rejected`, `closedAs=dropped` |

## Extra smoke-test tasks closed

Two more failed smoke-test tasks in `company/projects/pmumhp51r/tasks.json` were closed the same way:

- `tmumj7pmt` — `rejected`, `closedAs=dropped`, `closedReason=no-op smoke test`
- `tmumim00z` — `rejected`, `closedAs=dropped`, `closedReason=no-op smoke test`

## After regeneration

`company/reports/briefing.json` was regenerated with the new needs-you rule (`composeBriefing` + `needsYouRule`). The 6 false-alarm IDs are gone from `needsYou`.

`needsYou` now contains 4 real approval items:

- `budgetGuard` — OpenCode Go is nearly out (10% left); work is being restricted to the cheapest model
- `fleet:fomun56n41` — Joey voice plan approval
- `fleet:fomun56n8v` — voice-orders-to-Joey plan approval
- `jcode:session_bonehound_1790685796055_8dd83ba18f866ddd` — fleet backend / model-switch approval

The live acceptance probe `npx tsx ops/needs-you-rule-check.ts --live` passes all 6 forbidden IDs as absent from `needsYou`.

## Open issue

The router process on port 8787 was already running when the parallel NY-RULE code landed on disk. Its in-memory copy of the old rule may still rewrite `briefing.json` every ~30 seconds until the router is restarted. When that happens, some closed items can briefly reappear. The underlying data records are correctly closed, so a fresh `composeBriefing` or a restarted router keeps them out. The order explicitly says not to restart the router, so this was left as-is.
