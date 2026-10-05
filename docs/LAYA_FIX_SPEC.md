# Laya fixes (CEO-approved)

Written by Claude Code (manager). Audit at 19:25:
- All 15 jcode terminals run `deepseek-v4.1-flash`, jcode's default for `-p opencode-go`. Laya was never asked, and
  `src/company/fleet.ts` has no model choice at all.
- Laya made 13 decisions (7 team picks, 7 worker-model picks: kimi ×6, glm ×1) with confidence **min 0.02, avg 0.18,
  max 0.44**, i.e. barely better than chance.

## Fix 1: Laya picks each Fleet terminal's model (owner: FLEET-BACKEND / bonehound, `src/company/fleet.ts`)
- For every work order, before spawning, ask Laya to choose the jcode model from a catalog in one place (env-overridable):
  `kimi-k2.7-code`: hard, multi-file or UI work · `deepseek-v4.1-flash`: normal work, docs, scripts ·
  `glm-5.3-flash`: trivial edits and text. Confirm the exact model ids jcode accepts with `jcode model --help` /
  `jcode provider --help`. Do not guess.
- Reuse the dispatch.ts pattern (`chooseWorkerModel`) but with this catalog. State = work-order title + brief (≤1500
  chars) + `owns` count + a size hint.
- Guard: use Laya's pick only if confidence ≥ `LAYA_MODEL_MIN_CONF` (default 0.35). Otherwise use a rule-based default
  (UI/multi-file/`owns` > 3 files → kimi; docs-only → glm; else deepseek), and record `modelReason`.
- Spawn with `jcode -p opencode-go -m <model>`. Store `model`, `modelReason`, `layaConfidence` on the WorkOrder and in the
  trace ("Laya → Claude: pick kimi (0.41)"). The Fleet UI card and the Terminals page show it.
- Proof: a real 2-worker order where one work order is trivial and one is UI, showing the two picks and that the jcode
  journals' `meta.model` match. Keep MAX_PARALLEL_SESSIONS=20 / MIN_FREE_RAM_MB.

## Fix 2: make Laya decisive (owner: LAYA-TUNE, new session)
Owns: `src/decision.ts` (question wording/criteria only; keep function signatures), the question texts in
`src/company/dispatch.ts` (`chooseAgent`, `chooseTeam`, `chooseWorkerModel`; wording/criteria/state only, keep the
signatures; this is Claude Code's file, granted), the assistant's track question (ask ASSISTANT-BRAIN's file owner.
cactus is being closed, so LAYA-TUNE may edit ONLY the Laya question text inside assistant.ts), `ops/laya-probe.ts`,
`docs/LAYA_TUNING.md`, and a new `ops/laya-eval.ts`.
1. Build an eval set from today's real decisions: every `from: "Laya"` hop in `company/projects/*/tasks.json` traces,
   plus the orders in `company/assistant.jsonl` and `company/fleet/orders.json`. For each, write the answer a careful
   human would give (team / model / track). Aim for ≥ 30 cases. Add synthetic ones if needed, and label them as such.
2. Measure the baseline: accuracy and mean confidence per question, via local Laya (`http://127.0.0.1:8000/v1/systemone`).
3. Improve the questions. Laya is a small local model with a 512–1024 token context (see decision.ts header):
   - short, mutually exclusive options with concrete discriminating cues ("touches UI/CSS", "one text file");
   - put decisive features in `state` (type: code/docs/UI; files: N; risk: low/high) instead of long prose;
   - try `score`/`noul` question types where a choice is really a threshold;
   - drop options that are never right. Fewer options means higher confidence.
4. Re-measure. Report the before/after table (accuracy, mean confidence, % above 0.35). Only ship wording that improves
   accuracy. Confidence alone is not the goal.
5. Recommend thresholds (`LAYA_TEAM_MIN_CONF`, `LAYA_TRACK_MIN_CONF`, `LAYA_MODEL_MIN_CONF`, `RUN_MANAGER_LAYA_MIN_CONF`)
   from the data, and put them in `.env.example` + `docs/LAYA_TUNING.md`.
Never restart Laya on :8000 without asking in the log (the router depends on it). `npx tsc --noEmit` clean.
Log the proof in docs/AGENT_COORDINATION.md.
