// ops/memory-recall.ts
//
// Ask the company memory a question from the terminal, exactly as the assistant and
// the pipeline do (same code path as GET /company/memory/recall, no server needed).
//
// Usage:
//   npx tsx ops/memory-recall.ts "why is the assistant on opus"
//   npx tsx ops/memory-recall.ts --digest "who fixes router crashes"
//   npx tsx ops/memory-recall.ts --limit 5 --projects pmumhp51u "flow check file"
//   npx tsx ops/memory-recall.ts --status

import { memoryDigest, memoryStatus, recall, semanticKeyConfigured } from "../src/company/memory.js";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  if (process.argv.includes("--status")) {
    console.log(JSON.stringify(memoryStatus(), null, 2));
    return;
  }
  const wantDigest = process.argv.includes("--digest");
  const limit = Number(argValue("--limit") ?? 8) || 8;
  const projects = (argValue("--projects") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  const q = process.argv
    .slice(2)
    .filter((a) => !a.startsWith("--") && a !== String(limit) && !projects.includes(a))
    .join(" ")
    .trim();

  if (!q) {
    console.error('usage: npx tsx ops/memory-recall.ts "your question" [--limit N] [--projects a,b] [--digest]');
    process.exitCode = 1;
    return;
  }

  const semantic = semanticKeyConfigured();
  console.log(`question: ${q}`);
  console.log(`semantic extraction key configured: ${semantic} (false means code-AST graph + keyword recall)`);

  if (wantDigest) {
    const digest = memoryDigest(q);
    console.log(`\n----- memoryDigest(${q}) -----`);
    console.log(digest || "(no matching notes)");
    return;
  }

  const t0 = Date.now();
  const hits = recall(q, { limit, projects });
  const ms = Date.now() - t0;
  console.log(`hits: ${hits.length} in ${ms}ms`);
  for (const h of hits) {
    console.log(`\n[${h.type}] ${h.title}`);
    console.log(`  id: ${h.id}  date: ${(h.date || "undated").slice(0, 10)}  score: ${h.score}  via: ${h.via}`);
    console.log(`  path: ${h.path}`);
    if (h.excerpt) console.log(`  ${h.excerpt.slice(0, 200)}`);
  }
}

main();
