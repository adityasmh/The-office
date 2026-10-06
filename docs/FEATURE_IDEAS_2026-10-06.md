# Feature ideas for the fleet (ranked by what we hit in practice, 2026-10-06)

Every item below comes from a real gap seen today, not a guess. Each would be a narrow worker order on OpenCode Go.

## Do first (they remove friction we just felt)
1. **Auto-fill `owns` for small orders.** The local planner for small orders leaves `owns` empty, so the PR step cannot know which files to commit; today it needs a manual edit at approval. Derive the list from the files the worker's report says it changed, checked against the repo's real changes, and refuse anything outside the repo.
2. **Reload secrets without a router restart.** The router read `GITHUB_TOKEN` once at boot, so a replaced token gave `401 Bad credentials` until a restart. Add a guarded `POST /company/reload-env` that re-reads only the GitHub, provider and flag keys and never prints values.
3. **Retry publish.** When the PR step fails after a push (permission, token, network), add `POST /company/fleet/orders/:id/work/:wid/publish` and a button on the order, so the CEO retries in one click instead of opening the PR by hand.
4. **GitHub strip on the order view.** Per work order: branch, PR link, draft state, CI state. The data is already in the trace; it only needs to be shown.

## Do next (cost and safety, your top priority)
5. **Provider and cost per order.** Show on each order which provider ran each step (OpenCode Go or DeepSeek credits) and the measured cost, plus a banner when credits are used at all. Today credits can be spent silently.
6. **Guard false positives.** The loop guard counted streamed thought fragments such as a single punctuation mark as a repeated line and killed finished workers (gh-2, gh-5). Ignore thought-only lines in the repeat rule; keep the real loop rules.
7. **Graphify digest in fleet briefs.** Fleet workers do not get the project digest the old pipeline used. Put it in the work order brief so workers stop re-reading files (saves tokens).

## Bigger
8. **Agent-to-agent mailbox** (`docs/AGENT_TALK_SPEC.md`): step A first (find a reliable targeted delivery into a running session), note-only fallback.
9. **CI that actually runs.** Make the `fleet-check` workflow run (see below) so a red check really downgrades a PASS. Needs Actions enabled and allowed to run on the repo; then the check-reading path, already verified to work with the token, closes the loop.
10. **Branch hygiene.** A job that lists `fleet/*` branches whose PR is closed or merged and prints them for the CEO to delete (the system never deletes).

## Not recommended
- Auto-merge of fleet PRs. The merge gate should stay human.

Shipped 2026-10-06: env scrub, stuck detector, auto redo, agent mailbox and a safe web reader.
Trial: scrub on, second attempt.
