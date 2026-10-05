# Planner fix contract

DIAG writes docs/PLANNER_DIAGNOSIS.md. It starts with a line `VERDICT: EXPIRED_CREDENTIAL | GATEWAY_TIMEOUT | OTHER | NEEDS_HUMAN`, followed by the evidence (log lines, file paths, timestamps) and a plain-words summary.

FIX reads that file before acting. If the verdict is NEEDS_HUMAN, FIX stops and reports; it does not retry.

DUPES writes docs/PLANNER_DUPES_NOTE.md. It starts with `STATUS: GONE | STILL_GENERATED` and gives the evidence.

Only FIX edits company/fleet/orders.json, the run cards and src. DIAG and DUPES are read-only apart from their own note file.