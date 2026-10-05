# Research behind the overnight features (2026-10-06)

Reddit could not be read (the search tool blocks that domain), so this uses developer blogs, security write-ups and engineering articles.

| Need developers report | Source | Feature |
|---|---|---|
| AI-assisted commits leak secrets at about twice the human rate; pre-commit scanning is the standard defence | https://blog.gitguardian.com/ai-coding-agents-credential-security/ | F03 secret scanner and hooks, F10 policy file |
| Token spend inside agent loops stays invisible until the bill arrives | https://dev.to/maximsaplin/the-ai-bill-grows-in-the-agent-loop-87n | F04 cost report |
| Parallel agents overwrite each other unless isolated (git worktrees) | https://dev.to/battyterm/5-lessons-from-running-ai-coding-agents-in-parallel-53on | F13 worktree design |
| Contributors want one-command setup, a doctor check, a dev container | https://www.zenml.io/blog/dev-containers-vscode-extension-a-new-onboarding-experience-for-zenml | F01 doctor, F02 setup, F11 Docker |
| Developers want a readable trace of what an agent actually did | https://www.augmentcode.com/guides/agent-observability-for-ai-coding | F05 order report |
| Human approval for risky actions, audit trail | https://www.apono.io/blog/top-agent-observability-tools/ | F10 policy file, existing gates |
| Terminal-first workflows and scripting | general practice | F06 fleet CLI, F07 order templates |
| Fast feedback and CI for contributors | general practice | F08 run-all-checks and CI |
| Know when a long run finished or needs you | general practice | F09 webhook notifications |