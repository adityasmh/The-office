# REPORT F10-policy-file: policy file - protected paths agents may never change

## Changed files
| File | Change |
|---|---|
| `src/company/policy.ts` | NEW. `loadPolicy()` / `isProtected()` / `protectedRuleFor()` / `protectedPathsIn()` / `parsePolicy()` / `checkPublish()`, built-in defaults, glob matching (`*`, `**`, `?`, case-insensitive, forward-slash, slashless rules match the basename anywhere, `!` negation). |
| `policy.example.json` | NEW. Example policy: the built-in defaults plus `maxFilesPerWorkOrder: 20`. |
| `ops/policy-check.ts` | NEW. 10-line proof in temp folders and temp git repos, no network. |
| `src/company/fleetGithub.ts` | `ownablePaths(paths, policy)` and `unsafeOwnedPath(p, policy)` drop policy-protected paths; `deriveOwns` passes `loadPolicy(repoDir)`; `publishWorkOrder` refuses (returns `{ skipped: reason }`) when a staged path is protected or the count exceeds `maxFilesPerWorkOrder`, naming the path and the rule. |
| `src/company/fleet.ts` | `pathsNamedInOrder` loads the repo policy and drops protected paths; one import line added. Nothing else touched. |

## Behaviour
- `policy.json` at the repo root is used when present; otherwise built-in defaults: `.env*` (except `.env.example`), `.github/workflows/**`, `.git/**`, `policy.json`, `*.pem`, `*.key`, `maxFilesPerWorkOrder = 20`.
- Enforcement point 1: owned-file derivation (`ownablePaths` / `deriveOwns` in fleetGithub.ts, `pathsNamedInOrder` in fleet.ts) drops protected paths, so a work order never owns CI files or secrets.
- Enforcement point 2: the publish step refuses before any git/network work when an explicitly set `owns` contains a protected path (reason names the path and the rule) or lists more files than the cap. A work order that edits CI files therefore stops at the human.
- A malformed `policy.json` warns once and falls back to the defaults; a missing file is silent.

## Proof: `npx tsx ops/policy-check.ts` (exact output)
```
[fleetGithub] publishWorkOrder: REFUSED: refusing to publish ".github/workflows/ci.yml": it matches the protected path rule ".github/workflows/**" in the fleet policy, so a human must make this change, not a work order
[fleetGithub] publishWorkOrder: REFUSED: refusing to publish 3 files: the fleet policy rule maxFilesPerWorkOrder allows only 2, so this work order must be split or approved by a human
PASS 1. defaults protect .env, .github/workflows/ci.yml, .git/config, a.pem and a .key - rules=.env* | !.env.example | .github/workflows/** | .git/** | policy.json | *.pem | *.key -> .env:true .github/workflows/ci.yml:true .git/config:true a.pem:true certs/server.key:true
PASS 2. defaults leave .env.example and src/a.ts unprotected - .env.example:false src/a.ts:false README.md:false .env.example rule=null
PASS 3. glob forms: **, *, ?, basename-anywhere, case-insensitive, backslashes - wrong=[] caseInsensitive/backslash=true
PASS 4. a custom policy.json overrides the defaults; a partial one fills the gaps - custom={"protectedPaths":["config/secrets/**"],"maxFilesPerWorkOrder":3} customOk=true partial={"protectedPaths":[".env*","!.env.example",".github/workflows/**",".git/**","policy.json","*.pem","*.key"],"maxFilesPerWorkOrder":2} partialOk=true
PASS 5. owned-file derivation drops the protected .github/workflows path - ownablePaths=["src/a.ts","README.md",".env.example"] deriveOwns.owns=["src/a.ts"] why=derived 1 owned path(s) for wo-derive: src/a.ts
PASS 6. pathsNamedInOrder drops .github/workflows and policy.json - owns=["src/a.ts"]
PASS 7. publish refuses a protected staged path, naming the path and the rule - reason="refusing to publish \".github/workflows/ci.yml\": it matches the protected path rule \".github/workflows/**\" in the fleet policy, so a human must make this change, not a work order" headSame=true branchesSame=true
PASS 8. publish refuses more files than maxFilesPerWorkOrder - reason="refusing to publish 3 files: the fleet policy rule maxFilesPerWorkOrder allows only 2, so this work order must be split or approved by a human" headSame=true
PASS 9. a malformed policy.json falls back to the defaults with a warning - defaults=true warned=true warning="[policy] policy.json is malformed (Expected property name or '}' in JSON at position 2 (line 1 column 3)): using the built-in defaults"
PASS 10. a missing policy.json uses the defaults without a warning - defaults=true warnings=0

ALL PASS (10/10 checks, fetches=0)
```

## Regression checks (existing suites, run once)
- `npx tsx ops/fleet-github-check.ts` -> `ALL PASS (16/16 checks, fetches=0)`.
- `npx tsx ops/fleet-cheapplan-check.ts` -> `CHEAPPLAN-OWNS CHECK ALL PASS`.

## Open issues
- `policy.json` is itself a protected path by default, so only a human can edit the policy. Intended, but worth stating.
- The `!` negation prefix is a small addition beyond the order's minimum: it expresses the built-in `.env.example` exception inside the same `protectedPaths` list. A custom policy that writes `.env*` without `!.env.example` will protect `.env.example` too.
- `ownablePaths(paths)` now defaults its policy to `loadPolicy()` (the process cwd). Existing callers are unaffected today because no `policy.json` exists at the repo root (only `policy.example.json`), and the publish path passes `loadPolicy(repoDir)` explicitly.
- No live router, Laya, Kafka or scheduled task was started or touched; no real network call was made.
