# Work order: fleet planner returns a tool call instead of JSON (fix it)

From: manager. Model: deepseek-v4.1-flash. Repo: C:\Users\user\Desktop\Default Project

## What the manager measured (do not re-derive, verify then fix)
- Failed orders fomupdu7ne, fomupdu7w2, fomupdu87j (10:19Z) all show `[fleet:plan:debug] {"via":"claude","detail":"claude-sonnet-5-5","textLen":~400,"parsed":false}`.
- In those cases the `[brain] fleet-plan` line says `tier=none model=deepseek-v4.1-flash` (Laya said "not big" -> no Claude). So the planner prompt went to DeepSeek.
- The stored `order.plan` is not a plan. It is DeepSeek's native tool-call markup, e.g.
  `<｜DSML｜ calls> <｜DSML｜ invoke name="Read"> ... file_path ... docs\PERF_PLAN_2026-10-01.md ...`.
  The order text said "Read docs/PERF_PLAN... first", and the model tried to call a Read tool the planner does not have, instead of answering with JSON.
- Orders that got `tier=sonnet` (textLen ~8000, parsed:true, keys plan/specDoc/workOrders) planned fine. So: weak tier + "read file X" wording = tool-call reply = no work orders.
- Related, already known: docs/PLANNER_FIX_SPEC.md, docs/FLEET_CHECK_CONTRACT.md. Read them first so you do not redo or contradict earlier fixes.

## Fix (planner code under src/company/ - find the fleet planner, grep "fleet:plan:debug" and "did not return parseable JSON")
1. Detect a tool-call reply (DSML markup, `<tool_call>`, `invoke name=`, `function_call`, empty/very short text with no `{`) as its own failure kind, separate from "prose, no JSON".
2. On that failure, retry ONCE on the same cheap model with an explicit extra instruction: "You have no tools and cannot read files. Everything you need is in the order text. Reply with ONLY the JSON object." Include the contents of any file the order text names (docs/*.md under the repo, size-capped ~12 KB each) inline in the planner input so "read X first" is actually satisfied.
3. If that also fails, escalate one tier (Sonnet) once, per the cheap-by-default rule (twice-failed tasks may climb). Record the reason in the trace.
4. The trace entry for each failure must say which kind it was (tool-call / prose / truncated), so the next failure is diagnosable without logs.
5. Do not change which model Laya picks. Routing stays as is.

## Verify
- ops/planner-toolcall-check.ts: a stub model that replies with the DSML text on the first call and valid JSON on the second -> order gets work orders; a stub that always replies with tool calls -> escalates once, then fails with the kind named. Both run through the real planner function.
- Re-run the existing planner checks (ops/fleet-planner-fallback-check.ts, ops/fleet-signin-*.ts) and `npx tsc --noEmit` (exit 0).

## Rules
- Do NOT restart the router (an order is running on it; the manager restarts it). Say what restart is needed.
- Do not edit scripts/serve-laya.ps1 or laya-gpu-boot.py (the cuda session owns those). No secrets printed, no deletes.
- Append a timestamped entry to docs/AGENT_COORDINATION.md. Report to the manager.
