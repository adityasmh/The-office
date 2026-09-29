# Tests

This directory contains the coder-2 smoke, fixture-capture, and secret-scan checks.

## Run commands

From the repository root (`C:\Users\user\Desktop\Default Project\company\projects\pmumhp51u\repo`):

```powershell
# 1. Capture / refresh the data-layer round-trip fixture
node tests/capture-fixture.mjs

# 2. Run the full smoke suite (UI helpers, stats, round-trip, script exits)
node tests/smoke.mjs

# 3. Scan for secrets in git-tracked files (falls back to tree walk)
node tests/secret-scan.mjs
```

All three scripts are plain Node ESM and have no external dependencies.
