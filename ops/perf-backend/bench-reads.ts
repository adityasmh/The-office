// PERF-BACKEND micro-benchmark (2026-09-29).
//
// Times each read path of the dashboard payload separately against a TEMP
// COMPANY_ROOT copy, so "the endpoint takes 194 ms" becomes "these 4 functions
// cost 180 of it". Uses the real src/ modules (no mocks) via tsx.
//
// Usage: npx tsx ops/perf-backend/bench-reads.ts [--repeat 20]
import path from "node:path";

const argv = process.argv.slice(2);
const repIx = argv.indexOf("--repeat");
const REPEAT = repIx >= 0 ? Number(argv[repIx + 1]) : 20;

const root = process.env.BENCH_COMPANY_ROOT ?? path.join(process.env.TEMP ?? "/tmp", "jcode-perfbe", "company");
process.env.COMPANY_ROOT = root;
process.env.MOCK_MODE = "1";
console.log(`# COMPANY_ROOT=${root}`);

const { loadOrg, readThread, readCost } = await import("../../src/company/org.js");
const { loadTasks } = await import("../../src/company/gates.js");
const { listSessions, sessionCounts } = await import("../../src/company/sessions.js");
const { panelData } = await import("../../src/company/panel.js");
const { flowData } = await import("../../src/company/flow.js");
const { listBudgets, budgetTotals, budgetByDepartment } = await import("../../src/company/budget.js");
const { listAgentsFlat } = await import("../../src/company/agentchat.js");
const { assistantThread, assistantStatus } = await import("../../src/company/assistant.js");
const { memoryStatus } = await import("../../src/company/memory.js");

const org = loadOrg();
const projectIds = org.projects.map((p) => p.id);
console.log(`# projects: ${projectIds.join(", ")}`);

function bench(name: string, fn: () => unknown, repeat = REPEAT, warm = 3) {
  for (let i = 0; i < warm; i++) fn();
  // Payload size is measured OUTSIDE the timing loop: serialisation is the
  // server's cost, not this function's.
  const bytes = (JSON.stringify(fn())?.length ?? 0) / 1024;
  const t0 = performance.now();
  for (let i = 0; i < repeat; i++) fn();
  const ms = (performance.now() - t0) / repeat;
  console.log(`${name.padEnd(46)} ${ms.toFixed(1).padStart(8)} ms/call   (json ${bytes.toFixed(0)} KB)`);
}

bench("loadOrg()", () => loadOrg());
bench("listSessions(60)+counts", () => ({ ...sessionCounts(), items: listSessions(60) }));
bench("listBudgets()", () => listBudgets());
bench("budgetTotals()+byDepartment", () => ({ ...budgetTotals(), d: budgetByDepartment() }));
bench("listAgentsFlat()", () => listAgentsFlat());
bench("assistantThread(60)+status", () => ({ s: assistantStatus(), t: assistantThread(60) }));
for (const id of projectIds) bench(`loadTasks(${id})`, () => loadTasks(id));
for (const id of projectIds) bench(`readThread(${id},60)`, () => readThread(id, 60));
for (const id of projectIds) bench(`readCost(${id})`, () => readCost(id));
bench("panelData()", () => panelData(), 5);
bench("flowData(30)", () => flowData(30), 5);
bench("memoryStatus()", () => memoryStatus(), 5);
