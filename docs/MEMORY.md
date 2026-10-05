# Company memory (graphify-indexed)

Built by the jcode session **MEMORY** from `docs/MEMORY_SPEC.md`. Owner: MEMORY
(`src/company/memory.ts`, `src/company/knowledge.ts`, `ops/memory-*.ts`,
`company/memory/**`, this file, and only the `/company/memory*` routes in `src/server.ts`).

## What it is

One memory for the whole company. Decisions, CEO preferences, run outcomes and
failures are stored as one markdown note per fact under `company/memory/`, and
graphify indexes them (plus this repo's code) as a knowledge graph, so `recall`
returns the RELEVANT few notes instead of stuffing everything into a prompt.

## graphify (the engine)

| Fact | Value |
|---|---|
| PyPI package | `graphifyy` (double y). The CLI command is `graphify`. |
| Installed into | `deps\venv` ONLY (CEO-approved): `deps\venv\Scripts\python.exe -m pip install graphifyy` |
| Version installed | `graphify 0.9.71` (`deps\venv\Scripts\graphify.exe --version`) |
| License | Apache-2.0 (`License-Expression: Apache-2.0` in the installed dist metadata) |
| Upstream | https://github.com/Graphify-Labs/graphify |
| Offline (no key, nothing leaves the machine) | Code parsing via tree-sitter AST + clustering + graph.json |
| Needs an LLM key | The semantic pass over docs (`*.md`), PDFs, images, video |

The install added only new packages (tree-sitter grammars, rapidfuzz); it upgraded
nothing the local Laya venv already had.

### Env vars it reads (verbatim from `graphify extract --help` / its README)

`ANTHROPIC_API_KEY` (claude), `OPENAI_API_KEY` (openai), `GEMINI_API_KEY` or
`GOOGLE_API_KEY` (gemini), `DEEPSEEK_API_KEY` (deepseek), `MOONSHOT_API_KEY` (kimi),
`OLLAMA_BASE_URL` (ollama), plus `OPENAI_BASE_URL` / `OPENAI_MODEL` (or the
Anthropic equivalents) for self-hosted/compatible endpoints. `--backend` picks one;
without a flag graphify uses whichever key it finds.

`memory.ts` also accepts one company-wide knob: **`GRAPHIFY_API_KEY`**. When it is
set, the key is handed to graphify under the selected backend's own variable name
(`GRAPHIFY_BACKEND`, default `openai`), and `GRAPHIFY_BASE_URL` / `GRAPHIFY_MODEL`
are passed through as `OPENAI_BASE_URL` / `OPENAI_MODEL` (or the Anthropic pair).
That is the placeholder in `.env.example`. The CEO puts the real value in `.env`
themselves; nothing here ever asks for it, prints it, or writes it down.

**Without any key everything still works** (degraded mode): the graphify graph only
holds code, and recall is keyword/BM25-style scoring over the notes. When a key
appears in `.env`, the next rebuild switches the notes and `docs/` to semantic
extraction with **no code change**.

## Store layout

```
company/memory/
  decisions/ preferences/ runs/ failures/ projects/ people/ references/ imported/
  .memory-state.json      dirty flag, last rebuild, last report
  .graphifyignore         keeps the scratch dirs out of the corpus it scans
  graphify-out/graph.json the graphify graph recall traverses
  .graphify-build/<kind>/ per-root graphify work dirs (incremental manifests)
```

`references/` is not in the spec's folder list; the spec's `reference` note type
needs a home and the other folders are type-specific, so it got its own folder.
`imported/` holds the imported Claude Code project memory (type `preference`,
tag `feedback`). Files in the memory root without valid front matter are ignored,
so a README can live there.

### Note format

```markdown
---
id: <slug>
type: decision | preference | run-outcome | failure | person | project | reference
title: "<one line>"
date: <ISO>
source: <assistant-thread | run:<id> | briefing | coordination-log | terminal:<session> | claude-code>
projects: ["<projectId>"]
tags: ["..."]
---
<the fact in plain words; decisions/preferences add **Why:** and **How to apply:**>
```

`remember()` derives the id from the title (or takes an explicit `id`), checks for an
existing note on the same subject (same id, or >= 75% title-token overlap within the
same type) and UPDATES it in place instead of duplicating. An update appends the new
text as `**Update (date):**` so nothing is silently lost. Secrets are never stored:
`redactSecrets()` strips Slack tokens, `sk-*`/`lsk_*`/`ghp_*`/`AKIA*` style keys,
JWTs, `key: value` / `Bearer ...` patterns and long opaque tokens before anything is
written.

## API

```ts
import { remember, recall, memoryDigest, rebuildGraph, memoryStatus, listNotes, getNote } from "./memory.js";

remember({ type: "decision", title, body, source, projects?, tags?, id?, folder? }) // -> {id, path, updated}
recall(question, { limit?, projects? })   // -> [{id,title,type,date,excerpt,path,score,via}], never throws, < 2s
memoryDigest(question, maxChars = 2500)   // -> "RELEVANT COMPANY MEMORY: ..." block, "" when nothing matches
await rebuildGraph({ force? })            // -> RebuildReport
```

`remember`/`recall`/`memoryDigest` are synchronous, in-process and never spawn a
process, so the router's event loop is never blocked. `rebuildGraph` is the only part
that shells out; it is async, debounced (`MEMORY_REBUILD_MIN_S`, default 300s, only
when dirty), single-flight, and catches everything (it can never crash the router).
The background timer starts lazily on the first `remember()` and is `unref()`'d, so a
router that never records anything never schedules work.

Rebuild roots: `company/memory/` + this repo's `src/` and `docs/` + every project's
`rootDir`. Code roots are always `--code-only` (free, local, bounded); the notes and
`docs/` go through the semantic pass only when a key is configured. Each root keeps a
stable work dir, so graphify's incremental manifest makes the second run much faster
than the first. The per-root graphs are merged into `graphify-out/graph.json`.

`recall` scores notes with an idf-weighted keyword match over title/tags/projects/
type/body, then, when the graph is FRESH (not dirty, newer than every note), matches
query tokens against graph node labels and does a 2-hop BFS, boosting the notes those
nodes point at. A stale or missing graph simply drops the graph half (`via` says which
half scored: `keyword`, `graph` or `keyword+graph`).

### Endpoints (reads loopback-exempt, mutations need `X-Company-Token`)

| Route | Purpose |
|---|---|
| `GET /company/memory/recall?q=...&limit=8&projects=a,b` | scored notes for a question (`{q,count,ms,hits}`) |
| `GET /company/memory/notes?type=&q=&limit=` | note index without bodies |
| `GET /company/memory/notes/:id` | one full note |
| `POST /company/memory/notes` | `{type,title,body,source,projects,tags,id?,folder?}` -> write/update |
| `POST /company/memory/rebuild` | `{force:true}` to ignore the debounce |
| `GET /company/memory/status` | note count + type/folder counts, graph built-at/nodes/edges/fresh, dirty, graphify bin+version, `semanticKeyConfigured` (boolean only) |

## Ops

```powershell
npx tsx ops/memory-import.ts        # import Claude memory + coordination log + assistant chat + tasks
npx tsx ops/memory-recall.ts "why is the assistant on opus" [--limit N] [--digest]
npx tsx ops/memory-rebuild.ts [--force|--status]
```

`ops/memory-import.ts` is rerunnable and idempotent: every source item maps to a
deterministic note id, so a second run updates notes in place. Current store: 64
notes (20 decision, 17 failure, 11 preference, 16 run-outcome).

## knowledge.ts

`projectContext()` still returns the same digest shape the pipeline has always
consumed. What changed:

1. `findGraphify()` now also probes `deps\venv` (where graphify actually lives),
   not just `GRAPHIFY_BIN` and PATH.
2. The preferred extractor is now the **company memory graph** (real graphify output,
   read straight off disk, no process spawn): symbols and doc headings come from it,
   the file inventory still comes from the disk walk. `extractor: graphify-graph` in
   the digest. Falls back to a live graphify CLI run, then to the builtin walker,
   exactly as before.
3. The knowledge cache key includes the memory graph's mtime, so a rebuild refreshes
   the digests instead of serving a stale symbol list.

## Wiring (other owners)

The memory is only useful if the other modules call it. Requests are posted in
`docs/AGENT_COORDINATION.md`:

- ASSISTANT-BRAIN (`assistant.ts`): `memoryDigest(ceoMessage)` into the prompt;
  `remember()` for CEO decisions/preferences ("remember that ...").
- REPORTING (`runManagers.ts`, `briefing.ts`): `remember()` per finished run card
  (run-outcome/failure) and per briefing.
- AUTOCLOSE (`terminalReaper.ts`): `remember()` after archiving a closed terminal.
- pipeline.ts (Claude Code's file): proposal in the coordination log to add
  `memoryDigest()` next to the existing `projectContext()`.
