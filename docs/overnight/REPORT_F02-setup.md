# REPORT F02-setup: first-run wizard that creates a safe .env

Order: `docs/overnight/ORDER_F02-setup.md` (2026-10-06).
Status: DONE. All proof lines PASS on the first run. No other file was touched.

## Changed files

| File | Change |
| --- | --- |
| `ops/setup.ts` | NEW. The wizard (also the CLI: `npx tsx ops/setup.ts [--dir <path>] [--live] [--force]`). |
| `ops/setup-check.ts` | NEW. The proof harness (temp folders only). |

Nothing else changed. The repo `.env` was never read, printed or written (every run used
`--dir <temp folder>`); `company/`, Laya, Kafka and scheduled tasks were not touched.
Node built-ins only (`node:crypto`, `node:fs`, `node:path`, `node:url`); no new dependency.

## What it does

1. If `.env` is missing, copy `.env.example` to `.env`.
2. Set `MOCK_MODE=1` (default) or `MOCK_MODE=0` with `--live`, so a first run costs nothing.
   The key is replaced in place when the template has it, appended otherwise.
3. If `COMPANY_AUTH_TOKEN` is empty or a template value (`changeme`, `<...>`, `your-token-here`, ...),
   fill it with `crypto.randomBytes(32).toString("hex")` (64 chars). A real value is left alone.
4. Create `company/` and `logs/` when missing.
5. Never overwrite an existing `.env` without `--force`; with `--force` the old file is copied to
   `.env.bak` first, then `.env` is rebuilt from the template.
6. Prints only what it did and the next steps (doctor, `npm run dev`, dashboard
   `http://127.0.0.1:<PORT>/`, default 8787). It never prints a value from `.env` or the token,
   only key NAMES.

## Proof

Command (run once):

```
npx tsx ops/setup-check.ts
```

Exact output:

```
PASS creates .env from .env.example (exit 0, names are reported)  -> exit=0; envExists=true
PASS sets MOCK_MODE=1 by default (replaced in place, no duplicate key)  -> MOCK_MODE=1; keyLines=1
PASS keeps the rest of the template and adds nothing else  -> DT_ALPHA=setup_check_alpha_1122; PORT=8787
PASS fills a template COMPANY_AUTH_TOKEN with a random 32-byte hex value  -> length=64; hex=true; wasTemplate=false
PASS never prints the generated token or any .env value  -> tokenLeaked=false; declaredSecretLeaked=false
PASS prints the next steps (doctor, server, dashboard URL)  -> nextSteps=true
PASS --live sets MOCK_MODE=0 (not 1) and appends the key when the template lacks it  -> exit=0; MOCK_MODE=0; keyLines=1
PASS --live also fills the empty token with 64 hex chars and prints no value  -> length=64; hex=true
PASS a non-template COMPANY_AUTH_TOKEN in the template is left as is  -> preserved=true
PASS refuses to overwrite an existing .env (content byte-identical)  -> exit=0; unchanged=true; refused=true; bak=false
PASS --force writes .env.bak as an exact copy of the old file, then regenerates .env  -> exit=0; bakIsCopy=true; freshToken=true
PASS creates company/ and logs/ when missing  -> fresh: company=true logs=true
PASS running twice is safe (exit 0, .env unchanged, no .env.bak created)  -> exit=0; unchanged=true; bak=false
PASS keeps the template's CRLF line endings when it edits a key  -> crlf=true; MOCK_MODE=1
PASS an unknown flag is an error (usage, exit 1), not a guess  -> exit=1
PASS real CLI `npx tsx ops/setup.ts --dir <temp>` creates a safe .env and exits 0  -> exit=0; tokenLength=64; MOCK_MODE=1
PASS real CLI output leaks no value and mentions the next steps  -> tokenLeaked=false; nextSteps=true
setup-check: all checks passed
```

Exit code 0. Harness details: every temp folder comes from `os.tmpdir()`; every secret-looking
string in the harness is fake; the leak checks assert the token and the fake declared secret are
absent from both the in-process output and the real CLI stdout/stderr; no network call is made
(the wizard makes none either). The harness never prints a token or a value, only lengths/flags.

Extra check (not required by the order, run once): `npx tsc --noEmit` reported no error in
`ops/setup.ts` or `ops/setup-check.ts`.

## Mapping to the order's proof list

| Order line | Proof line(s) |
| --- | --- |
| creates `.env` from the example | 1, 3, 16 |
| `MOCK_MODE=1` by default and not with `--live` | 2, 7 |
| token of the right length, never printed | 4, 5, 8, 17 |
| refuses to overwrite an existing `.env` | 10 |
| `--force` writes `.env.bak` first | 11 |
| creates the two folders | 12 |
| running twice is safe | 13 |

## Open issues / notes

- `MOCK_MODE` is not in `.env.example`, so on a clean clone the wizard appends it (with a one-line
  comment). Adding `MOCK_MODE=1` to `.env.example` would make the wizard replace instead of append,
  but that file is outside this order's "Files" list, so it was left alone.
- `--live` writes `MOCK_MODE=0` explicitly. The order only fixes the default (`MOCK_MODE=1` unless
  `--live`); `0` is the only value that makes a live run actually live.
- With `--force` the `.env` is rebuilt from `.env.example`, so machine-specific values in the old
  file live on only in `.env.bak` (that is what "write .env.bak first" is for). Documented in the
  wizard's `--force` help line.
- Refusing an existing `.env` exits 0 (a friendly no-op, so a wrapper script does not fail on a
  second run); only real errors (no `.env.example`, unwritable folder, bad flag) exit 1.
- A second `--force` run overwrites an existing `.env.bak`; no timestamped history is kept.
