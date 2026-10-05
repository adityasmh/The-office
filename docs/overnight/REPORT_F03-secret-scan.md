# REPORT F03-secret-scan: secret scanner plus git hooks

Date: 2026-10-06. Order: `docs/overnight/ORDER_F03-secret-scan.md`.

## Changed files

- `ops/secret-scan.ts` (new) - the scanner. Exports `RULES`, `scanContent`, `scanPaths`,
  `scanStaged`, `listStaged`, `readStaged`, `listAllFiles`, `expandPaths`, `parseAllow`,
  `loadAllow`, `globToRegExp`, `mask`, `renderText`, `renderJson`, `exitCodeFor`, `parseArgs`,
  `main`. CLI `npx tsx ops/secret-scan.ts [--staged | --all | <paths>] [--json] [--root <dir>]`:
  rules for OpenAI `sk-`, Slack `xox*` / `xapp-`, GitHub `ghp_`/`gho_`/`ghs_`/`ghr_`/`github_pat_`,
  AWS `AKIA`, Google `AIza`, private-key headers, and `KEY|TOKEN|SECRET|PASSWORD` assignments of
  16+ chars (skipped in `*.example`). Each hit prints file, line, rule and `mask=` the first four
  characters only; exit 1 on a hit, 0 clean, 2 for a usage error. `--staged` reads the git index
  (`git show :path`), not the worktree. Binary files and `node_modules/`, `.git/` are skipped.
  `.secretscan-allow` (path glob or value regex per line, `#` comments) suppresses matches.
  Node built-ins only, no network calls.
- `ops/install-hooks.ts` (new) - writes `.git/hooks/pre-commit` and `.git/hooks/pre-push`, both
  bare POSIX `sh` (works in Git for Windows), each starting with the marker
  `# jcode-secret-scan-hook:v1` and running `npx tsx ops/secret-scan.ts --staged`. Re-install is
  idempotent; an existing hook without the marker is `skipped-foreign` unless `--force`;
  `--uninstall` removes only hooks carrying the marker. Exports `HOOK_MARKER`, `HOOKS`,
  `hookScript`, `findGitDir`, `installHooks`, `uninstallHooks`, `main`.
- `ops/secret-scan-check.ts` (new) - the proof. Temp git repos under the OS temp dir, all fake
  credentials assembled at runtime from pieces, plus a self-scan of the three source files.

Nothing else was edited. `ops/spawn-wave.ps1` was already modified before this order, and the F01
files (`ops/doctor.ts`, `ops/doctor-check.ts`, `docs/overnight/REPORT_F01-doctor.md`) belong to
another worker.

## Proof

Command (run once, foreground): `npx tsx ops/secret-scan-check.ts`

```
PASS a staged fake key is detected  -> findings=[{"file":"app.ts","line":1,"rule":"openai-key","masked":"sk-p"}]
PASS the hit carries the rule name and masks to the first four characters  -> masked=sk-p
PASS the rendered line never contains the full value  -> app.ts:1: openai-key mask=sk-p
PASS exit code is 1 on a hit and 0 on a clean result  -> hit=1
PASS JSON output parses to findings plus an ok flag and leaks no value  -> ok=false; findings=1
PASS an allow-listed value passes  -> findings=[]
PASS a key that is not allow-listed is still reported  -> findings=["github-token"]
PASS allow-file comments and blank lines are ignored, globs are kept  -> entries=1
PASS a clean file passes  -> scanned=1
PASS an assignment-shaped secret in a normal file is detected  -> masked=Zq7p
PASS *.example files are ignored for assignment rules  -> findings=[]
PASS a real key shape in a *.example file is still detected  -> findings=["openai-key"]
PASS OpenAI, GitHub, AWS, Google and private-key shapes are all detected  -> aws-access-key-id,github-token,google-api-key,openai-key,private-key
PASS no finding ever carries more than the four masked characters  -> masks=sk-p ghp_ AKIA AIza ----
PASS node_modules/ and .git/ are not walked  -> blob.bin,clean.ts,dirty.ts
PASS a binary file is skipped rather than scanned  -> skipped=blob.bin
PASS the walk finds exactly the one real hit outside those folders  -> findings=["dirty.ts:github-token"]
PASS expanding a skipped folder yields nothing  -> expanded=0
PASS the scanner, the installer and this harness are not flagged by the scanner  -> findings=[]
PASS both hooks install and report installed  -> pre-commit:installed,pre-push:installed
PASS each hook carries the marker and runs the scanner on the staged files  -> first line=#!/bin/sh
PASS the hook script is bare POSIX sh (no bashisms)  -> bytes=399
PASS installing twice is idempotent  -> pre-commit:unchanged,pre-push:unchanged
PASS a foreign hook is not clobbered without --force  -> pre-commit:skipped-foreign,pre-push:unchanged
PASS --force replaces a foreign hook with ours  -> pre-commit:updated,pre-push:unchanged
PASS --uninstall removes only the hooks it wrote  -> pre-commit:removed,pre-push:skipped-foreign
PASS --uninstall is a no-op when there is no hook to remove  -> pre-commit:absent,pre-push:skipped-foreign
PASS CLI --staged --json detects a staged key and exits 1  -> exit=1; findings=1
PASS CLI --staged --json masks the value in its output  -> masked=sk-p
PASS the staged file list comes from the git index  -> staged=app.ts
PASS CLI exits 0 on a clean staged tree  -> exit=0
PASS CLI --all scans the worktree and exits 1 on the one hit  -> exit=1
PASS CLI --help prints usage and exits 0  -> exit=0
PASS CLI --staged outside a git repo fails loudly (exit 2) instead of passing  -> exit=2; stderr=secret-scan: not a git repository: C:\Users\user\AppData\Loc
PASS CLI install-hooks installs both hooks in the working directory's repo  -> installed: .git\hooks\pre-commit installed: .git\hooks\pre-push
PASS CLI refuses a foreign hook and --force replaces it  -> before=skipped-foreign: .git\hooks\pre-commit; after=updated: .git\hooks\pre-commit
PASS CLI --uninstall removes the hooks it installed  -> removed: .git\hooks\pre-commit removed: .git\hooks\pre-push
secret-scan-check: all checks passed
```

Harness exit code: 0 (37/37 PASS).

## Open issues

- The hooks were verified by content (`sh` shebang, marker, exact scanner command) and by the
  install/idempotency/clobber/uninstall behaviour; their `npx tsx` line was not executed end to
  end, because the temp repos do not contain a copy of `ops/secret-scan.ts` and the CLI checks
  drive the same script through `node <tsx-cli>`. Executing the hook once inside the real repo
  would be the remaining check.
- The allow-list matches an entry against both the path glob and the value regex, so a broad
  entry (for example just `sk-`) would allow every match. That is the operator's choice; the
  proof confirms a narrower entry does not leak blanket approval.
- Assignment rule guard: values containing `process.env` or starting with `$`/`` ` `` are treated
  as code and not reported, to avoid flagging `const TOKEN = process.env.TOKEN`. This is narrower
  than the plain "16+ chars" wording in the order.
- `--all` walks the filesystem (skips `node_modules/`, `.git/`, binary files) rather than
  `git ls-files`, so git-ignored files are still scanned. Deliberate: a `.env` sitting on disk
  should be seen before it is ever added.
- Running `--staged` outside a git repository exits 2 with `not a git repository: <dir>`; a hook
  owns that path, so a blocked commit fails closed there.
- `--root` was added to both CLIs (the order listed only `--staged|--all|--json` and
  `--uninstall|--force`); the defaults are `process.cwd()`, which is what git passes to a hook.
