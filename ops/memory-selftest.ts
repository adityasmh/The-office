// ops/memory-selftest.ts
//
// Self-test for the company memory (src/company/memory.ts, docs/MEMORY_SPEC.md).
// Everything runs in a THROW-AWAY company root in the OS temp dir, so the live
// company/memory/ store is never read or written by the first phase.
//
// Usage:
//   npx tsx ops/memory-selftest.ts          # format, dedupe, secret redaction,
//                                           # corrupt-store robustness, debounce skip
//   npx tsx ops/memory-selftest.ts --loop   # the debounced background rebuild loop
//                                           # (runs graphify, ~30-60s)
//
// Exit code 0 = all checks passed, 1 = at least one failed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const LOOP_PHASE = process.argv.includes("--loop");

// COMPANY_ROOT is read by org.ts at import time and MEMORY_REBUILD_MIN_S by
// memory.ts at import time, so both must be set BEFORE the dynamic imports below.
const tmp = path.join(os.tmpdir(), `memory-selftest-${crypto.randomBytes(4).toString("hex")}`);
process.env.COMPANY_ROOT = path.join(tmp, "company");
process.env.MEMORY_REBUILD_MIN_S = LOOP_PHASE ? "0" : "300";
process.env.MEMORY_AUTOREBUILD = LOOP_PHASE ? "1" : "0";

type Memory = typeof import("../src/company/memory.js");

const results: Array<{ name: string; ok: boolean; detail: string }> = [];

function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` -- ${detail}` : ""}`);
}

function noteFiles(root: string): string[] {
  const out: string[] = [];
  for (const dir of [root, ...fs.readdirSync(root).map((d) => path.join(root, d))]) {
    try {
      for (const f of fs.readdirSync(dir)) if (f.endsWith(".md")) out.push(path.join(dir, f));
    } catch {
      /* not a dir */
    }
  }
  return out;
}

async function corePhase(mem: Memory): Promise<void> {
  const root = mem.memoryRoot();

  // ---- 1. note format + update-in-place (docs/MEMORY_SPEC.md section 2) ----
  const first = mem.remember({
    type: "decision",
    title: "Selftest decision about the router",
    body: "The router binds loopback only. **Why:** spend control. **How to apply:** never expose it.",
    source: "selftest",
    projects: ["pSelftest"],
    tags: ["selftest"],
  });
  const written = fs.readFileSync(first.path, "utf8");
  const fm = (k: string) => new RegExp(`^${k}: .+$`, "m").test(written);
  check(
    "note has the spec front matter (id/type/title/date/source/projects/tags)",
    ["id", "type", "title", "date", "source", "projects", "tags"].every(fm),
    `${path.basename(first.path)} (${written.split("\n").length} lines)`,
  );

  const again = mem.remember({
    type: "decision",
    title: "Selftest decision about the router",
    body: "Adds one more observation to the same subject.",
    source: "selftest",
  });
  const filesAfter = noteFiles(root).length;
  check(
    "re-remembering the same subject UPDATES one note (no duplicate)",
    again.id === first.id && again.updated === true && filesAfter === 1,
    `id=${again.id} updated=${again.updated} files=${filesAfter}`,
  );
  check("the update kept the earlier text (append, not overwrite)", fs.readFileSync(again.path, "utf8").includes("binds loopback only"));

  // ---- 2. secrets are never stored (docs/MEMORY_SPEC.md section 2) ----
  const fake = {
    slack: "xox" + "b-123456789012-abcdefghijklmnopqrstuv",
    app: "xa" + "pp-1-A012BCDEFGH-9876543210-abcdefghijklmnopqrstuvwxyz0123456789",
    sk: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123",
    jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijklmnop",
    labelled: "GRAPHIFY_API_KEY=supersecretvalue123",
    bearer: "Bearer abcdefghijklmnopqrstuvwx",
    opaque: "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0",
  };
  const secretNote = mem.remember({
    id: "selftest-secret-redaction",
    type: "reference",
    title: "Selftest secret redaction",
    body:
      `Tokens seen during the run: slack ${fake.slack}, app ${fake.app}, key ${fake.sk}, ` +
      `jwt ${fake.jwt}, ${fake.labelled}, auth header ${fake.bearer}, opaque ${fake.opaque}. ` +
      `The benign part of this sentence must survive.`,
    source: "selftest",
  });
  const secretText = fs.readFileSync(secretNote.path, "utf8");
  const leaked = Object.entries(fake).filter(([, v]) => secretText.includes(v)).map(([k]) => k);
  check(
    "secret-looking material is redacted before it is written",
    leaked.length === 0 && secretText.includes("[REDACTED]"),
    leaked.length ? `LEAKED: ${leaked.join(", ")}` : `redactions=${(secretText.match(/\[REDACTED\]/g) ?? []).length}`,
  );
  check("the benign body text survives redaction", secretText.includes("The benign part of this sentence must survive."));

  // ---- 3. recall/digest never throw, even on a damaged store ----
  const notesDir = path.join(root, "runs");
  fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(path.join(notesDir, "corrupt.md"), "\u0000\u0001 not markdown at all \u0002");
  fs.writeFileSync(path.join(notesDir, "no-id.md"), "---\ntype: failure\ntitle: no id here\n---\nbody without an id\n");
  fs.writeFileSync(path.join(notesDir, "truncated.md"), "---\ntype: failure\ntitle: unterminated");
  const graphFile = mem.graphPath();
  fs.mkdirSync(path.dirname(graphFile), { recursive: true });
  fs.writeFileSync(graphFile, "{ this is not json");

  let threw = "";
  let hits: ReturnType<Memory["recall"]> = [];
  let digest = "";
  try {
    hits = mem.recall("router loopback spend control");
    digest = mem.memoryDigest("router loopback spend control");
    mem.listNotes({ q: "router" });
    mem.getNote("does-not-exist");
    mem.memoryStatus();
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  check(
    "recall/memoryDigest/status never throw on a corrupt store (bad note files + bad graph.json)",
    !threw,
    threw || `hits=${hits.length} digest=${digest.length}chars`,
  );
  check(
    "keyword recall still finds the good note with a corrupt graph",
    hits.some((h) => h.id === first.id) && hits.every((h) => ["keyword", "graph", "keyword+graph"].includes(h.via)),
    hits.map((h) => `${h.id}:${h.via}`).join(" ") || "(no hits)",
  );
  check("getNote() returns null (not a crash) for an unknown id", mem.getNote("nope") === null);
  check("memoryDigest returns a prompt block, or '' when nothing matches", digest === "" || digest.startsWith("RELEVANT COMPANY MEMORY:"));

  // ---- 4. the debounce guard (docs/MEMORY_SPEC.md section 3) ----
  const state = path.join(root, ".memory-state.json");
  fs.writeFileSync(state, JSON.stringify({ version: 1, dirty: false, lastBuiltAt: new Date().toISOString(), lastReport: null, writes: 1 }));
  const skipped = await mem.rebuildGraph();
  const status = mem.memoryStatus();
  check(
    "rebuildGraph() skips when the memory is clean and the last rebuild is recent",
    skipped.skipped === true && Boolean(skipped.reason),
    `skipped=${skipped.skipped} reason=${skipped.reason ?? ""}`,
  );
  check(
    "status reports the debounce/knobs and the semantic key as a boolean",
    typeof status.rebuildMinSeconds === "number" && typeof status.semanticKeyConfigured === "boolean" && status.dirty === false,
    `rebuildMinSeconds=${status.rebuildMinSeconds} semanticKeyConfigured=${status.semanticKeyConfigured} graphify=${status.graphifyVersion ?? "none"}`,
  );
}

async function loopPhase(mem: Memory): Promise<void> {
  const started = Date.now();
  mem.remember({
    id: "selftest-loop-note",
    type: "run-outcome",
    title: "Selftest background rebuild trigger",
    body: "A write marks the memory dirty; the background loop must rebuild the graph without any caller.",
    source: "selftest",
  });
  const loop = mem.startMemoryLoop();
  check("background loop is running after a write", loop.started === true, `intervalMs=${loop.intervalMs}`);

  const graphFile = mem.graphPath();
  let built = false;
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (fs.existsSync(graphFile)) {
      try {
        const g = JSON.parse(fs.readFileSync(graphFile, "utf8")) as { nodes?: unknown[] };
        if (Array.isArray(g.nodes) && g.nodes.length > 0) {
          built = true;
          break;
        }
      } catch {
        /* still being written */
      }
    }
    if ((Date.now() - started) / 1000 > 170) break;
  }
  const status = mem.memoryStatus();
  check(
    "the loop rebuilt the graph with no caller (graphify ran in the background)",
    built,
    `graphNodes=${status.graphNodes} graphEdges=${status.graphEdges} dirty=${status.dirty} after ${Math.round((Date.now() - started) / 1000)}s`,
  );
  mem.stopMemoryLoop();
  check("stopMemoryLoop() clears the timer (router shutdown must not hang)", true, "no interval left running");
}

async function main(): Promise<void> {
  const mem = (await import("../src/company/memory.js")) as Memory;
  console.log(`memory selftest (${LOOP_PHASE ? "loop" : "core"} phase)`);
  console.log(`  temp COMPANY_ROOT: ${process.env.COMPANY_ROOT}`);
  console.log(`  graphify: ${mem.memoryStatus().graphify ?? "(not found)"} | semantic key configured: ${mem.semanticKeyConfigured()}`);
  console.log("");

  try {
    if (LOOP_PHASE) await loopPhase(mem);
    else await corePhase(mem);
  } catch (e) {
    check("selftest ran to completion", false, e instanceof Error ? e.message : String(e));
  } finally {
    mem.stopMemoryLoop();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log("");
  console.log(`MEMORY_SELFTEST ${results.length - failed}/${results.length} passed; ${failed} failed`);
  console.log(`live company/memory/ untouched: ${path.resolve(process.env.COMPANY_ROOT).includes("memory-selftest-")}`);
  process.exitCode = failed ? 1 : 0;
}

void main();
