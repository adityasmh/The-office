---
name: Bug report
about: Something did not work as documented
labels: bug
---

## What happened

<!-- What you did, what you expected, what actually happened. -->

## Where

<!-- The command or file, for example: npx tsx ops/doctor.ts, src/company/fleet.ts. -->

## Steps to reproduce

1.
2.
3.

## Output

<!-- Paste the relevant lines. Remove or replace any secret value first. -->

```

```

## Environment

- OS and shell:
- Node version (`node --version`):
- Mock mode or live (`MOCK_MODE`):
- Relevant feature flags (`FLEET_GITHUB`, `DEEPSEEK_DIRECT`, ...):

## Checks

- [ ] I ran `npx tsx ops/doctor.ts`
- [ ] I ran the relevant check with `npx tsx ops/run-all-checks.ts --only <name>`
- [ ] No secrets in this report (no `.env` values, no tokens)
