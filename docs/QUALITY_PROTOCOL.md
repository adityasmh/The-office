# Quality protocol (for weak or cheap coder models)

Cheap and free models write code quickly and unreliably. The **manager** (a stronger model, or you) makes every decision; the cheap model only types what the order says. Quality must never drop.

## Before a batch
1. Make sure the baseline is green: `npm run typecheck` and `npm run check:all` (and the product's own gate from `products.json`).
2. Write orders with: exact files, exact behaviour, decisions already made in the text, one check that can fail, and the regression checks that must stay green (`docs/WORKER_GUARD.md` has the order-writing rules).

## After each order (the manager does ALL of this)
1. Re-run the gate: typecheck errors may not rise, no check that passed may fail.
2. Read every changed file's diff. Look for: weakened or deleted assertions, magic numbers, swallowed errors, `any`/`@ts-ignore`, stubs, fake data, edits outside the order's Files list.
3. Run the order's own check AND the checks of neighbouring modules yourself. Do not trust the worker's pasted output: a passing check only proves the check passed, not that the check is meaningful.
4. Accept, or revert the touched files and re-order with a sharper spec.
5. Edit-only orders are never accepted on a worker's word: run the check by hand.

## Known traps
- An order that changes behaviour breaks old checks that encode the old behaviour. The order must name those checks and say which contract wins.
- A data field added for one purpose can break a validator elsewhere. Round-trip tests (GET then PUT) catch it.
- The root `tsconfig.json` covers `src/` only; a product repo has its own gate (list it in `products.json`).
- A pause file or a router restart does not stop spending: the router resumes tasks. Stop the router to stop spending.
