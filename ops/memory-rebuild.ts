// ops/memory-rebuild.ts
//
// Rebuild the company memory's graphify graph (company/memory/graphify-out/graph.json)
// from the shell - the same call the router makes from POST /company/memory/rebuild.
//
// Roots: company/memory/ (the notes) + this repo's src/ and docs/ + every project's
// rootDir in company/org.json. Code is extracted locally with no API key; the notes
// and docs only take part when a semantic LLM key is configured (see docs/MEMORY.md).
//
// Usage:
//   npx tsx ops/memory-rebuild.ts            # honours the MEMORY_REBUILD_MIN_S debounce
//   npx tsx ops/memory-rebuild.ts --force    # rebuild even if not dirty / too recent
//   npx tsx ops/memory-rebuild.ts --status   # status only, no rebuild

import { memoryStatus, rebuildGraph } from "../src/company/memory.js";

async function main(): Promise<void> {
  if (process.argv.includes("--status")) {
    console.log(JSON.stringify(memoryStatus(), null, 2));
    return;
  }

  const force = process.argv.includes("--force");
  const before = memoryStatus();
  console.log(
    `memory: ${before.notes} notes | graphify: ${before.graphify ?? "(not found)"} ${before.graphifyVersion ?? ""} | ` +
      `semantic key configured: ${before.semanticKeyConfigured}`,
  );

  const t0 = Date.now();
  // The router's own debounce guard lives inside rebuildGraph (MEMORY_REBUILD_MIN_S).
  const report = await rebuildGraph({ force });
  console.log(`rebuild ok=${report.ok} skipped=${report.skipped}${report.reason ? ` (${report.reason})` : ""} in ${Date.now() - t0}ms`);
  console.log(`mode=${report.mode} nodes=${report.nodes} edges=${report.edges} graph=${report.graphPath}`);
  for (const r of report.roots) {
    console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.kind.padEnd(22)} ${String(r.nodes).padStart(5)} nodes  ${r.ms}ms  ${r.detail}`);
  }
  for (const e of report.errors) console.log(`  issue: ${e}`);
  process.exitCode = report.ok ? 0 : 1;
}

void main();
