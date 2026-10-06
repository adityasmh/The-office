# Order U2-gpu-users: show which programs use the GPU, by name

Context: the Laya panel's GPU bar showed 3 GB used with Laya on the CPU, and nothing said who was using it. It was the voice text-to-speech worker. The panel should name the users.

## Files
`src/company/layaControl.ts` (small insertion; U1 edited this file just before, read its current state first), `public/v2/views/system.js` (the Laya panel only), `ops/laya-control-check.ts` (add cases)

## What to build
1. `gpuUsers(exec?)` in `layaControl.ts`: read per-process GPU memory with PowerShell `Get-Counter '\GPU Process Memory(*)\Dedicated Usage'` (make the command runner injectable). Parse instance names of the form `pid_<number>_...`, keep entries above 20 MB, map each pid to its process name, and give each a plain LABEL: a python process whose command line contains `laya` is "Laya", one containing `tts` is "Voice, text to speech", one containing `stt` is "Voice, speech to text", anything else uses the process name. Return `[{pid, name, label, mb}]` sorted by size, newest-first on ties. NEVER return a command line, only the label. When the counter is unavailable return an empty list and a short reason, never an error.
2. Add `gpuUsers` to the object `layaStatus()` returns.
3. The panel: under the GPU bar, one line per user: "Voice, text to speech (python, pid 6668): 2.9 GB". When Laya is on the CPU and a non-Laya program keeps more than 1 GB, add one sentence "To give Laya the GPU, this program has to stop or restart first". The panel only describes; it must not offer a button that stops another program.

## Proof (`ops/laya-control-check.ts`, fakes only)
PASS or FAIL cases: parsing fake counter output into entries and dropping those under 20 MB; label mapping for laya, tts, stt and an unknown name; a command line never appears in the result; unavailable counter returns an empty list with a reason; sorting; the panel sentence appears only when Laya is on CPU and a non-Laya user keeps more than 1 GB. Keep every earlier case passing.

## Common rules
- Edit ONLY the files above. Small targeted edits, never rewrite an entire file. No new dependencies. Never restart the router or stop or start any real process. Never read or edit `.env`. No network calls.
- Run each command once: `npx tsc --noEmit`, then `npx tsx ops/laya-control-check.ts`. If a step fails, report the exact error and END your turn.
- Write `docs/overnight/REPORT_U2-gpu-users.md` (changed line ranges, exact output, open issues), print the same report and END your turn. Do not wait, poll, loop, or re-read this order.