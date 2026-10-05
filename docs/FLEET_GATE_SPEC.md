# Fleet gate contract

AUTH writes `docs/FLEET_AUTH_NOTE.md`. Its first line is exactly `GATE: PASS` or `GATE: FAIL`.

On FAIL, the note names the expired credential in plain words, gives the exact evidence (command and output), and says that no retry was queued.

GUIDE and CHECK poll for this file every 20 seconds for up to 15 minutes.
- On `GATE: FAIL`, they stop, produce no deliverables, and report that the gate failed.
- On `GATE: PASS`, they proceed.
- If the file never appears, they report that the gate timed out and stop.

No agent may queue more than one attempt at the planning step.
