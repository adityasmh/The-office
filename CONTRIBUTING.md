# Contributing to The Office

Welcome aboard! This document explains how the Laya AI Company works in this repo and how to
contribute without causing a departmental incident. The tone of the README is goofy. The rules
below are real and we do follow them.

## The One Rule That Rules Them All

**Every department works on its own branch. Branches do not overlap. Work never collapses
together.**

This is the company's answer to "how do five AI departments share one repo without deleting each
other's lunch from the fridge": they don't share the fridge. Each department has its own fridge
(its branch) inside the same office building (this repo).

## The Branch Map

| Branch | Department | Charter |
|---|---|---|
| `main` | Company HQ | Governance files and merged deliverables only |
| `platform-core` | Platform Core | Core platform engineering and product implementation |
| `livefinal` | LiveFinal | Live ops and final assembly of the company's output |
| `qa-verification` | QA & Verification | Test strategy, verification and release quality gates |
| `applied-research` | Applied Research | Applied research, prototypes and model evaluation |
| `executive-office` | Executive Office | Strategy, planning and cross-company coordination |

Branches are created by the company (the `org.json` org chart is the source of truth). If a new
department is chartered, it gets a new branch named after its slug. No exceptions, no squatters.

## Rules for departments (the employees)

1. **Commit every change.** Each code change is its own commit with a real message describing
   what changed and why. Commit messages follow the pattern
   `<Department>: <what changed>` (see `git log` on any branch for examples).
2. **Push after every commit.** A commit that only exists on your laptop is a rumor, not a
   contribution. `git push` after every commit.
3. **Stay on your branch.** Check out your department's branch and work there. If you find
   yourself on someone else's branch, stop, breathe, and `git checkout` your own.
4. **Directory prefixes.** Keep top-level directories on your branch prefixed with your
   department slug (for example `platform-core/ui/...`, `qa-verification/suites/...`). This is
   what makes merges between departments conflict-free.
5. **No secrets.** Never commit `.env` files, API keys, tokens, passwords, private keys.
   The repo is public. History is scanned. Violations are reverted and the secret is rotated.
   If you need config, use `.env.example` files with placeholder values.
6. **Deliverables go to `main` via PR.** When a department produces something the whole company
   should see, open a pull request from the department branch to `main`. Another department
   reviews it. Ceremony is minimal, snacks are virtual.

## Rules for outside contributors (the beloved public)

You are why this repo is open source. Really. The CEO said so, in writing, at 3am.

- **Pick a department.** Read the branch map above and find the branch whose charter matches
  what you want to do. If unsure, open an issue and ask; someone (an actual language model)
  will answer.
- **Fork and branch.** Fork the repo, then branch from the department branch you want to
  contribute to, e.g. `git checkout -b my-feature origin/platform-core`.
- **Small commits, real messages.** Same rule as employees. We can hear the difference between
  "stuff" and "Platform Core: add retry to adapter load".
- **Open PRs against the department branch**, not `main`. The department merges its own work
  into `main` when it is ready as a deliverable.
- **No secrets.** Same rule as everyone. We will hug you and revert your commit.
- **Be excellent.** See the Code of Conduct. AI employees read it too, and they hold grudges in
  vector databases.

## Commit message convention

```
<Department or Contributor slug>: <imperative summary of the change>

<optional body: what changed, why, and any acceptance notes>
```

Examples from real history:

- `Platform Core: commit in-progress tests work found in the working tree`
- `LiveFinal: add DEPARTMENT.md heritage charter`

## License

By contributing you agree that your contributions are licensed under the MIT License that
covers this repository. The company's lawyers are also language models, so this sentence is
surprisingly airtight.
