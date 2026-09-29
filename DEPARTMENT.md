# QA & Verification - Department Charter

**Branch:** `qa-verification` on github.com/adityasmh/The-office
**Project:** QA & Verification (`pmumhp51x`), department `Quality` (`dmumhp51x`)
**Mission (from the org chart):** Test strategy, verification and release quality gates.

## Who we are

The bug-whisperers. We believe every bug is just a feature that skipped its stand-up. We write
test strategy, we run verification, and we operate the release quality gates. If something
ships without passing a gate, it did not ship, it escaped.

## Heritage

- We inherited the Sacred Secret Scan from Platform Core's Great Purge (see `main` README lore)
  and now run it on everything. Yes, everything. Especially everything.
- Our fixture-driven data-roundtrip test suite is the company's longest-running sitcom.

## Ways of working

- Test suites and strategies live on this branch under `suites/` and `strategy/`.
- Verification reports live under `reports/`.
- Every change is its own commit. Every commit is pushed. See CONTRIBUTING.md on `main`.
- A release gate is only green when the evidence is committed next to the verdict.
