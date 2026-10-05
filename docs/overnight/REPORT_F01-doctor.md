# REPORT F01-doctor: `npx tsx ops/doctor.ts [--json]`

Date: 2026-10-06. Order: `docs/overnight/ORDER_F01-doctor.md`.

## Changed files

- `ops/doctor.ts` (new) - the doctor. Exports `DoctorProbes`, `runDoctor(probes, options)`,
  `parseEnvFile`, `realProbes`, `renderText`, `renderJson`, `exitCodeFor`, `main`.
  CLI: one `PASS`/`WARN`/`FAIL` line per check, `fix:` appended for WARN/FAIL, `--json`
  prints one object `{checks:[{name,status,detail,fix}],ok}`, exit 1 if any FAIL else 0.
  Checks: node >= 20, git, jcode (PATH + default install paths), `npx tsx`, `.env` exists,
  every key NAME in `.env.example` set non-empty in `.env` (names only), ports 8787 and 8000
  (free / in use), GPU via `nvidia-smi` (WARN only), free RAM, free disk, `company/` and
  `logs/` writable (created when missing). Node built-ins only, no network calls.
- `ops/doctor-check.ts` (new) - the proof. Real `runDoctor` with faked probes against
  temporary folders under the OS temp dir; the repository `.env` is never opened by the
  harness and all secret-looking strings are fake.

Nothing else was edited. `ops/spawn-wave.ps1` was already modified before this order.

## Proof

Command (run once, foreground): `npx tsx ops/doctor-check.ts`

```
PASS all-pass fixture has no FAIL and ok=true  -> checks=13; fails=[]
PASS every non-PASS check carries a one-line fix (all-pass fixture)  -> statuses=["PASS",...]
PASS Render: one output line per check  -> lines=13; checks=13
PASS missing .env gives a FAIL with a fix text  -> status=FAIL; fix="Copy .env.example to .env, then fill in the values (never commit .env)."
PASS missing .env also FAILs the key check rather than skipping it  -> status=FAIL
PASS exit code is 1 on any FAIL  -> exit=1; ok=false
PASS exit code is 0 when nothing FAILs  -> exit=0; ok=true
PASS a present key with an empty value is reported by name  -> status=FAIL; detail="1 of 3 key(s) not set - empty: DT_EMPTY"
PASS the empty key's name is in the fix, and a key that IS set is not named  -> fix="Set DT_EMPTY in .env (take the values from .env.example)."
PASS every non-PASS check carries a fix (empty-value fixture)  -> statuses=[... "FAIL" ...]
PASS no fake secret value appears in the text output  -> value-free (names only)
PASS no fake secret value appears in the JSON output  -> value-free (names only)
PASS the parsed .env in memory really held the fake secrets (so the leak test is meaningful)  -> keys=["DT_ALPHA","DT_EMPTY","DT_SECRET"]
PASS renderJson() output parses to one object with checks[] and a boolean ok  -> checks=13; ok=false
PASS every JSON check has name/status/detail/fix and a valid status  -> sample={"name":"node","status":"PASS","detail":"v20.11.0 (>= 20)","fix":""}
PASS absent GPU is WARN not FAIL, with a fix, and does not fail the run  -> status=WARN; ok=true
PASS Node older than 20 is FAIL with a fix that says 20  -> status=FAIL; fix="Install Node.js 20+ from https://nodejs.org and make sure it is on PATH."
PASS ports in use are WARN with detail "in use" (and free ports say "free")  -> 8787=WARN/in use; 8000=WARN/in use
PASS low RAM and low disk are WARN (exit stays 0 when nothing FAILs)  -> ram=WARN; disk=WARN; exit=0
PASS real CLI `npx tsx ops/doctor.ts --json` prints one parsable JSON object  -> checks=13; ok=false
PASS real CLI exit code is 1 on any FAIL and 0 otherwise  -> exit=1; ok=false
PASS real CLI stdout leaks no fake test value  -> statuses=["node=PASS","git=PASS","jcode=PASS","npx tsx=PASS",".env=PASS",".env keys=FAIL","port 8787=WARN","port 8000=WARN","gpu=PASS","ram=PASS","disk=PASS","company/=PASS","logs/=PASS"]
doctor-check: all checks passed
```

Harness exit code: 0 (22/22 PASS).

## Open issues

- On this machine the real run ends `ok=false`: `.env keys` FAILs, i.e. some key NAME(s) in
  `.env.example` are missing or empty in `.env` (names only; the doctor prints them, values
  are never read out). Everything else is PASS or WARN here. This is the check working as
  ordered, but the manager may want the list of names attached to the overnight report.
- Ports 8787 and 8000 are reported `in use` on this box (router / Laya running). That is a
  WARN by design and does not change the exit code.
- RAM/disk thresholds are `minRamMB=2048`, `minDiskGB=2`, both WARN-only, overridable through
  `DoctorOptions`; the order did not fix numbers.
- The GPU probe shells out to `nvidia-smi`; when it is absent that is WARN, never FAIL.
- No test asserts the absence of network calls directly; the only outgoing processes are
  `git --version`, `tsx --version` / `npx --no-install tsx --version` and `nvidia-smi`, and the
  port probe binds loopback only.
