# Tests

This directory contains the coder-2 smoke, fixture-capture, secret-scan, and headless UI checks.

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

## Headless UI check

The headless browser test uses Playwright (pinned in `tests/package.json`). It starts a local static server, loads `/` and `/?ui=legacy`, asserts there are no console errors or 404 network responses, and exercises `updateProjectStatus` through the adapter on the detail view.

```powershell
# Install test dependencies (one time)
cd tests
npm install

# Run the headless UI check from the repository root
cd ..
node tests/ui-headless.mjs
```

All scripts are plain Node ESM. The headless UI check is the only test with an external dependency (Playwright).
