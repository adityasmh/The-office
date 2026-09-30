# Platform Core - Department Charter

**Branch:** `platform-core` on github.com/adityasmh/The-office
**Department:** Engineering (`dmumhp51u`)
**Mission (from the org chart):** Core platform engineering and product implementation.

## Who we are

The torque-wrench department. We build and maintain the machinery every other department
stands on: the platform, the product implementation, the tests, the adapters, the ribbon that
keeps the whole office from catching fire. When something loads slowly, we feel it personally
and take it to heart for at least one full commit cycle.

This branch carries the Platform Core project workspace live from
`company/projects/pmumhp51u/repo`, so what you see here is the department's actual working
tree, not a copy.

## Heritage

- We are the keepers of the Great Purge: we once purged every `.env.example` in the realm to
  pass our own secret scan, and we now celebrate the annual Secret-Scan Crusade holiday (see
  the lore section on `main`). Ask us about it. We will show you the grep.
- Our first three commits predate the company charter and are grandfathered in history. We
  treat them like black-and-white photos of the office when it was a garage.
- Our tests directory runs a data-roundtrip sitcom that QA inherited. We demand residuals in
  tears only.

## Ways of working

- Platform code lives on this branch under the department-prefixed directories that were here
  at adoption (`js/`, `css/`, `public/`, `scripts/`, `tests/`, `vendor/`, `legacy/`).
- Every change is its own commit. Every commit is pushed. See CONTRIBUTING.md on `main`.
- Commit messages follow the `Platform Core: <what changed>` pattern.
- We do not touch other departments' branches. We build the floor they dance on; that is
  enough excitement for one department.
