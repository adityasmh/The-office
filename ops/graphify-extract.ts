// ops/graphify-extract.ts
//
// Refresh the shared project knowledge graph for the whole company (or one project)
// and print a table so you can see what every agent will read as project context.
//
// Usage:
//   npx tsx ops/graphify-extract.ts                    # all projects in org.json
//   npx tsx ops/graphify-extract.ts --projectId pmumhg71w
//   npx tsx ops/graphify-extract.ts --digest pmumhg71w  # also print the digest text
//   npx tsx ops/graphify-extract.ts --check pmumhg71w   # cache hit/miss probe, no refresh
//
// Exit codes: 0 ok, 1 a project reported issues (extraction itself never throws).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadOrg } from "../src/company/org.js";
import {
  findGraphify,
  knowledgeCachePath,
  projectContext,
  refreshAllProjects,
  type RefreshReport,
} from "../src/company/knowledge.js";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function pad(s: string, n: number): string {
  const v = s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s;
  return v.padEnd(n, " ");
}

type CacheProbe = { exists: boolean; mtimeMs: number; generatedAt: string; digestHash: string; digestLen: number; fileCount: number };

function probeCache(projectId: string): CacheProbe {
  const file = knowledgeCachePath(projectId);
  try {
    const env = JSON.parse(fs.readFileSync(file, "utf8")) as { knowledge: { generatedAt: string; digest: string; fileCount: number } };
    return {
      exists: true,
      mtimeMs: Math.round(fs.statSync(file).mtimeMs),
      generatedAt: env.knowledge.generatedAt,
      digestHash: crypto.createHash("sha256").update(env.knowledge.digest).digest("hex").slice(0, 16),
      digestLen: env.knowledge.digest.length,
      fileCount: env.knowledge.fileCount,
    };
  } catch {
    return { exists: false, mtimeMs: 0, generatedAt: "-", digestHash: "-", digestLen: 0, fileCount: 0 };
  }
}

// Cache hit/miss probe: shows whether the next agent prompt would reuse the cached
// digest or pay for a regeneration. Two runs in a row must report HIT.
function checkProject(projectId: string): void {
  const before = probeCache(projectId);
  const digest = projectContext(projectId);
  const after = probeCache(projectId);
  const verdict = !before.exists ? "MISS (no cache)" : before.mtimeMs === after.mtimeMs ? "HIT (cache reused)" : "MISS (regenerated)";
  console.log(`--check ${projectId}`);
  console.log(`  digest returned : ${digest.length} chars`);
  console.log(`  before          : ${JSON.stringify(before)}`);
  console.log(`  after           : ${JSON.stringify(after)}`);
  console.log(`  verdict         : ${verdict}`);
  if (before.exists && after.digestHash !== before.digestHash) {
    console.log(`  digest changed  : ${before.digestHash} -> ${after.digestHash}`);
  }
  console.log(`  cache file      : ${knowledgeCachePath(projectId)}`);
}

function main(): void {
  const projectId = argValue("--projectId") ?? argValue("-p");
  const digestFor = argValue("--digest");
  const checkFor = argValue("--check");

  if (checkFor) {
    checkProject(checkFor);
    process.exitCode = 0;
    return;
  }

  const probe = findGraphify();
  console.log(`graphify CLI: ${probe.bin ?? "(not installed)"} — ${probe.why}`);
  console.log(`extractor    : ${probe.bin ? "graphify (primary, builtin walker as fallback)" : "builtin walker (graphify unavailable)"}`);
  console.log("");

  let ids: string[];
  if (projectId) {
    ids = [projectId];
  } else {
    const org = loadOrg();
    ids = org.projects.map((p) => p.id);
    if (!ids.length) {
      console.log("No projects in company/org.json. Create one from the panel first.");
      process.exitCode = 0;
      return;
    }
  }

  const reports: RefreshReport[] = refreshAllProjects(ids);

  const headers = ["project", "files", "symbols", "headings", "digest", "ms", "extractor"];
  const rows = reports.map((r) => [
    r.projectId,
    String(r.fileCount),
    String(r.symbols),
    String(r.headings),
    `${r.digestChars}c`,
    String(r.ms),
    r.extractor,
  ]);

  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));
  const line = (cells: string[]) => cells.map((c, i) => pad(c, widths[i])).join("  ");
  const sep = widths.map((w) => "-".repeat(w)).join("  ");

  console.log(line(headers));
  console.log(sep);
  for (const r of rows) console.log(line(r));
  console.log("");

  console.log("cache locations:");
  for (const r of reports) {
    let size = "?";
    try {
      size = `${fs.statSync(r.cachePath).size}b`;
    } catch {
      size = "missing";
    }
    console.log(`  ${pad(r.projectId, widths[0])} -> ${r.cachePath} (${size})`);
  }

  const problems = reports.filter((r) => r.issues.length);
  if (problems.length) {
    console.log("");
    console.log("issues:");
    for (const r of problems) {
      console.log(`  ${r.projectId}:`);
      for (const i of r.issues) console.log(`    - ${i}`);
    }
  }

  if (digestFor) {
    console.log("");
    console.log(`----- digest for ${digestFor} (${projectContext(digestFor).length} chars) -----`);
    console.log(projectContext(digestFor));
  }

  console.log("");
  console.log(`refreshed ${reports.length} project(s); total ${reports.reduce((s, r) => s + r.ms, 0)}ms`);
  console.log(`knowledge root: ${path.dirname(reports[0]?.cachePath ?? "company/projects")}`);

  process.exitCode = problems.length ? 1 : 0;
}

main();
