# Company memory (graphify-indexed)

Written by Claude Code (manager). Built by the jcode session MEMORY. The CEO approved installing graphify.

## Goal
One memory for the whole company, so the assistant and managers remember decisions, CEO preferences, what each run
achieved and why things failed, across conversations and restarts. graphify indexes it as a knowledge graph, so
recall finds the RELEVANT few notes instead of stuffing everything into prompts.

## Ownership
MEMORY owns: `src/company/memory.ts` (new), `src/company/knowledge.ts` (was unowned; it becomes the code half),
`ops/memory-*.ts`, `company/memory/**`, `docs/MEMORY.md`, and ONLY the `/company/memory*` routes in `src/server.ts`
(small exact edits). Do NOT edit assistant.ts (owned by ASSISTANT-BRAIN/cactus), runManagers.ts/briefing.ts
(REPORTING/mushroom) or terminalReaper.ts (AUTOCLOSE/hibiscus). Ask those sessions in docs/AGENT_COORDINATION.md
to call your API instead.

## 1. Install graphify (approved by the CEO)
- Find the right package first. The PyPI package is expected to be `graphifyy` (CLI `graphify`). Read its PyPI page /
  README to confirm it is the knowledge-graph tool and check its license. Install it ONLY into the project venv:
  `deps\venv\Scripts\python.exe -m pip install graphifyy`. Do not install globally.
- Find out from its docs which parts work offline (code AST extraction) and which need an LLM API key (doc/semantic
  extraction), plus the exact env var name(s) it reads. The CEO is getting the key now. Add the var to
  `.env.example` as a placeholder with a comment, and note it in docs/MEMORY.md. NEVER ask for the key in chat, print
  it, or write it anywhere except the CEO putting it in `.env` themselves.
- Everything must work WITHOUT the key (degraded: code graph + plain-text/keyword recall over notes). When the key
  appears in `.env`, semantic extraction switches on after the next rebuild, with no code change.

## 2. Memory store: `company/memory/`
One markdown file per fact, with front matter:
```
---
id: <slug>
type: decision | preference | run-outcome | failure | person | project | reference
title: <one line>
date: <ISO>
source: <assistant-thread | run:<id> | briefing | coordination-log | terminal:<session> | claude-code>
projects: [<projectId>...]
tags: [...]
---
<the fact in plain words; for decisions/preferences add **Why:** and **How to apply:**>
```
Folders: `decisions/`, `preferences/`, `runs/`, `failures/`, `projects/`, `people/`, `imported/`. Before writing, check
for an existing note on the same subject and UPDATE it (no duplicates). Secrets are never stored: redact anything that
looks like a key or token before writing.

## 3. Module `src/company/memory.ts` (exports; others call these)
- `remember(note: {type, title, body, source, projects?, tags?}) -> {id, path, updated: boolean}`: writes or updates a note and marks the graph dirty.
- `recall(question: string, opts?: {limit?: number, projects?: string[]}) -> Array<{id, title, type, date, excerpt, path, score}>`:
  queries the graphify graph (graph traversal from matched nodes). Falls back to keyword/BM25-style scoring over the
  notes when the graph is missing or stale. Must return in < 2s and never throw.
- `memoryDigest(question, maxChars=2500) -> string`: a compact block for prompts ("RELEVANT COMPANY MEMORY: ...").
- `rebuildGraph()`: runs graphify over `company/memory/` + each project's `rootDir` (+ this repo's `src/` and `docs/`),
  output in `company/memory/graphify-out/`. Debounced: at most once per `MEMORY_REBUILD_MIN_S` (default 300s) when dirty,
  in a guarded background loop that can never crash the router. Uses graphify's incremental/cached mode if it has one.
- `knowledge.ts`: keep `projectContext()` working exactly as today for the pipeline, but use the real graphify output for
  the code digest when available.

## 4. Imports (one-off, rerunnable, idempotent)
`ops/memory-import.ts` imports into notes:
- Claude Code's memory for this project: `C:\Users\user\.claude\projects\C--Users-user-Desktop-Default-Project\memory\*.md`
  (skip MEMORY.md) → `imported/` (these are the manager's standing rules; type preference/feedback).
- `docs/AGENT_COORDINATION.md` log entries → decisions / failures (who did what, root causes). Summarise; don't copy
  wholesale.
- `company/assistant.jsonl` → CEO decisions and preferences stated in chat (e.g. "Claude plans only, jcode
  executes", "assistant model choices", "visible jcode terminals, many in parallel", "auto-close after verification").
- Merged tasks from `company/projects/*/tasks.json` → run-outcome notes (request, result, date).

## 5. Endpoints (reads loopback-exempt; mutations need the token)
`GET /company/memory/recall?q=...&limit=8` · `GET /company/memory/notes?type=&q=` · `GET /company/memory/notes/:id` ·
`POST /company/memory/notes {type,title,body,...}` · `POST /company/memory/rebuild` · `GET /company/memory/status`
(note count, graph built at, dirty, graphify version, whether the semantic key is configured (true/false only)).

## 6. Wiring (requests to other owners; post them in the coordination log)
- ASSISTANT-BRAIN (cactus): before answering or delegating, call `memoryDigest(ceoMessage)` and include it in the prompt.
  After each CEO message, if it states a decision or preference, call `remember()` (type decision/preference, source
  assistant-thread). The assistant can also do this when the CEO says "remember that…".
- REPORTING (mushroom): when a run's final card is written (done/failed) and when a Briefing is generated, call
  `remember()` (run-outcome / failure).
- AUTOCLOSE (hibiscus): after archiving a closed terminal, call `remember()` with the archive path (type run-outcome).
- The pipeline's manager prompt already gets `projectContext()`. Also propose adding `memoryDigest()` there.
  pipeline.ts is Claude Code's file: write the exact proposed change in the log and the manager will decide.

## Proof (real output in docs/AGENT_COORDINATION.md)
1. `graphify --version` from the venv, plus the license.
2. Import run: counts per note type, and 3 example notes (titles only).
3. `GET /company/memory/recall?q=why is the assistant on opus` and `?q=who fixes router crashes` return the right notes
   (show them). Works with the key absent. Say whether semantic mode is on.
4. `npx tsc --noEmit` clean. Router restart for the new routes: ask in the log (OPS/CRASHFIX do it when no task is in flight).
