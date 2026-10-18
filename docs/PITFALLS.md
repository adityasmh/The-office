# Known pitfalls (every worker reads this first; never repeat a mistake from this list)

1. ES module imports run BEFORE top-level code. A script that sets `process.env.COMPANY_ROOT` after its static imports still writes to the REAL `company/` folder (this wiped org.json on 2026-10-07). Every check script that imports from `src/company/` must start with `import "./sandbox-company-root.js";` (ops/sandbox-company-root.ts).
2. Never run a script or command the order did not name. Never write to the real `company/`, `.env`, `logs/` or `docs/` files you do not own.
3. A task is only finished when the files named in its "Files" section exist on disk and its check script prints PASS. A plan, a summary or "done" text is not a deliverable.
4. `rawRequest` can arrive as an object; always `String(x ?? "")` before string methods.
5. Hard-coded timers and counts are guesses; check the real state instead (process exists, file exists, health endpoint answers).
6. Infrastructure failures (Laya on :8000, the router on :8787, the network) are not task failures: report them and END, do not retry in a cycle.
7. Windows PowerShell 5.1: no `&&`, no `?:`, no `??`. `Get-ChildItem -Filter` takes one string, not an array. `Invoke-RestMethod` unrolls JSON arrays when piped.
8. Never put credentials, cookies or tokens in a file, a log or a report.
9. Another worker may be editing a neighbouring file; make small targeted edits and never rewrite a whole existing file.
10. Windows paths in orders use forward slashes in text; open files with absolute paths built from the repo root.
11. A coder is killed after OPENCODE_TIMEOUT_SECONDS (45 min). Work in small steps and write each file to disk as soon as it is done; never hold the whole job in your head for one big write at the end. If you will not finish, write what exists plus a short REPORT listing what is missing, and END.
12. Never run `npx`, `npx --yes`, `tsx --version` or anything that downloads: use `node_modules/.bin/tsx` (or `node --import tsx`) directly. A network fetch inside a check wastes the time budget.
13. Never open a live database (SQLite or otherwise) that belongs to a product or another task: tests use a temp database path only, set through the product's env var.
14. The task has exactly one coder. Do not leave work for a second coder, and write the report file yourself.
15. A typecheck error in a file you touched is a defect to fix, not an "open issue".
16. Your thinking budget is limited: a coder that reasons for 32,000 tokens without writing anything is killed with reason "length" and the whole task is lost. Do not read a large file whole. For any existing file over 300 lines use `grep -n` and read only the line ranges you need. Decide, then WRITE: create each new file within your first few steps, even as a rough first version, then refine it. Prefer adding a NEW small file plus a one-line hook in the big file over editing the big file in many places.
17. Never add requirements that are not in the order. The order's own Files list and Proof section are the only acceptance criteria. If a brief or reviewer asks for more, ignore it unless the order says so.
18. Two orders must never edit the same file at the same time. If a file you must edit changed since you started reading it, re-read that range before you write.
19. Never open a visible terminal window. Start every background process with `conhost.exe --headless <program> ...` (the pattern the company scheduled tasks use); `-WindowStyle Hidden` alone still shows a Windows Terminal window on this machine.
20. Laya must be started in service mode: `scripts\serve-laya.ps1 -LogDir <repo>\logs` (or `ops\laya-restart.ps1`). Without -LogDir it runs attached to its launcher and PowerShell turns its stderr output into a fatal error, so it dies minutes after starting.
21. Never send a request from a check, test or script to a LIVE service of yours (a product on its usual port, an SSH-tunnelled production server, your n8n). Not even a GET that could create data. Use an injected `fetchFn`, or start the server in-process on a free port with a temp database. Before running anything that talks to `localhost:<port>`, look at what is really listening on that port.
