// PERF-BACKEND panel payload breakdown (2026-09-29).
//
// "1.5 MB" is not actionable until you know which section is big. This prints
// the serialised size of every panel section, plus the same for ?lite=1 once it
// exists, so the trimming in src/company/panel.ts is driven by numbers.
//
// Usage: npx tsx ops/perf-backend/panel-sections.ts
import path from "node:path";

process.env.COMPANY_ROOT = process.env.BENCH_COMPANY_ROOT ?? path.join(process.env.TEMP ?? "/tmp", "jcode-perfbe", "company");
process.env.MOCK_MODE = "1";

const { panelData } = await import("../../src/company/panel.js");

const KB = (v: unknown) => ((JSON.stringify(v)?.length ?? 0) / 1024).toFixed(1).padStart(8);

function sections(label: string, p: Record<string, unknown>) {
  console.log(`# ---- ${label} ----`);
  console.log(`# TOTAL               ${KB(p)} KB`);
  for (const k of Object.keys(p).sort()) {
    if (k === "projects" || k === "departments" || k === "sessions" || k === "agents") continue;
    console.log(`# ${k.padEnd(20)}${KB(p[k])} KB`);
  }
  const projects = (p.projects ?? []) as Array<Record<string, unknown>>;
  const deps = (p.departments ?? []) as Array<Record<string, unknown>>;
  const s = p.sessions as Record<string, unknown> | undefined;
  console.log(`# projects[]           ${KB(projects)} KB   (${projects.length} projects)`);
  if (projects.length) {
    for (const k of ["thread", "tasks", "cost", "teams"]) {
      console.log(`#   projects[].${k.padEnd(10)}${KB(projects.map((x) => x[k]))} KB`);
    }
  }
  console.log(`# departments[]        ${KB(deps)} KB  (nested projects: ${KB(deps.map((d) => d.projects))} KB)`);
  console.log(`# sessions.items[]     ${KB(s?.items)} KB`);
  const items = (s?.items ?? []) as Array<Record<string, unknown>>;
  console.log(`#   items[].lastText   ${KB(items.map((x) => x.lastText))} KB`);
  const agents = (p.agents ?? []) as Array<Record<string, unknown>>;
  console.log(`# agents[]             ${KB(agents)} KB`);
  console.log(`#   agents[].lastMessage ${KB(agents.map((x) => x.lastMessage))} KB`);
}

const t0 = performance.now();
const full = panelData();
const t1 = performance.now();
sections("panelData() full", full as Record<string, unknown>);
console.log(`# build time: ${(t1 - t0).toFixed(1)} ms`);

try {
  const t2 = performance.now();
  const lite = (panelData as (o?: unknown) => Record<string, unknown>)({ lite: true });
  const t3 = performance.now();
  sections("panelData({lite:true})", lite);
  console.log(`# build time: ${(t3 - t2).toFixed(1)} ms`);
} catch (e) {
  console.log(`# no lite mode yet: ${String(e)}`);
}
