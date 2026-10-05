// PERF-BACKEND cache equivalence check (2026-09-29).
//
// The PERF work is "caching only, no behaviour change", so this asserts exactly
// that: every cached read must return the same thing as an uncached read of the
// same data. `resetCaches()` forces a cold path; the comparison is a deep
// JSON equality of the two results.
//
// Usage: npx tsx ops/perf-backend/cache-equivalence.ts
import fs from "node:fs";
import path from "node:path";

process.env.COMPANY_ROOT = process.env.BENCH_COMPANY_ROOT ?? path.join(process.env.TEMP ?? "/tmp", "jcode-perfbe", "company");
process.env.MOCK_MODE = "1";

const { resetCaches, cacheStats } = await import("../../src/company/cache.js");
const { loadOrg, readThread, readCost, getCompanyRoot } = await import("../../src/company/org.js");
const { flowData } = await import("../../src/company/flow.js");
const { listSessions, sessionCounts, getSession } = await import("../../src/company/sessions.js");
const { memoryStatus } = await import("../../src/company/memory.js");
const { panelData, buildPanelData } = await import("../../src/company/panel.js");

let failures = 0;
function equal(name: string, a: unknown, b: unknown) {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  const ok = sa === sb;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      cached: ${String(sa).slice(0, 200)}\n      fresh : ${String(sb).slice(0, 200)}`}`);
}

const root = getCompanyRoot();
const org = loadOrg();

// 1. loadOrg: cached vs the file on disk.
equal("loadOrg() == JSON.parse(org.json)", loadOrg(), JSON.parse(fs.readFileSync(path.join(root, "org.json"), "utf8")));

// 2. org read paths: warm (cached) vs cold (cache cleared).
for (const p of org.projects) {
  const warmThread = readThread(p.id, 60);
  const warmCost = readCost(p.id);
  resetCaches();
  equal(`readThread(${p.id},60) cached == fresh`, warmThread, readThread(p.id, 60));
  equal(`readCost(${p.id}) cached == fresh`, warmCost, readCost(p.id));
}

// 3. flowData: warm vs cold.
const warmFlow = flowData(30);
resetCaches();
equal("flowData(30) cached == fresh", warmFlow, flowData(30));

// 4. memoryStatus: warm vs cold (the 4.4 MB graph parse is cached now).
// Two fields are normalised away because they are not data:
//   * `graphAgeSeconds` is derived from the current clock;
//   * `graphifyVersion` is filled by a background `graphify --version` probe
//     (PERF: it used to be a synchronous 250 ms child process on this request
//     path), so it can flip from null to a version between two calls.
const withoutVolatile = (s: unknown) => {
  const c = JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
  delete c.graphAgeSeconds;
  delete c.graphifyVersion;
  return c;
};
const warmMem = memoryStatus();
resetCaches();
equal("memoryStatus() cached == fresh (modulo graphAgeSeconds/graphifyVersion)", withoutVolatile(warmMem), withoutVolatile(memoryStatus()));

// 5. panel: the panel does its own memoisation; its force/no-force contract must
// hold, i.e. a cached payload equals a freshly built one.
//
// The payload is normalised by dropping `generatedAt` (the build timestamp).
// NOTE, measured while writing this check: the FIRST build in a fresh process
// differs from every later one in `budgets.byAgent[].projectName` for the CEO
// assistant ("" -> "Executive Office"). That is pre-existing budget.ts behaviour
// (listBudgets() runs before agentRows() registers the identities, so
// identityFromOrg's hardcoded assistant branch answers first), NOT caching: two
// uncached buildPanelData() calls in one process differ the same way. So the
// comparison warms the process with one build first.
const withoutTimestamp = (p: unknown) => {
  const c = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
  delete c.generatedAt;
  return c;
};
buildPanelData(false); // warm the budget identity map, as any served request would
const warmPanel = panelData();
const forced = panelData({ force: true });
equal("panelData() cached == panelData({force:true}) (modulo generatedAt)", withoutTimestamp(warmPanel), withoutTimestamp(forced));
const litePanel = panelData({ lite: true });
equal("panelData({lite:true}) == buildPanelData(true) (modulo generatedAt)", withoutTimestamp(litePanel), withoutTimestamp(buildPanelData(true)));
equal("lite payload is marked lite:true", (litePanel as { lite?: unknown }).lite, true);

// 6. sessions: the memoised list must still be newest-first and hold the CURRENT
// record for every id (getSession reads the registry map directly, no memo).
const warmList = listSessions(60);
const reSorted = [...warmList].sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")));
equal("listSessions(60) is newest-first", warmList, reSorted);
equal(
  "listSessions(60) rows == getSession(id) (uncached read)",
  warmList,
  warmList.map((s) => getSession(s.id)),
);
const counts = sessionCounts();
const all = listSessions(500);
equal("sessionCounts() == counted from the registry", counts, {
  running: all.filter((s) => s.status === "running").length,
  queued: all.filter((s) => s.status === "queued").length,
  total: all.length,
});

console.log(`# cache stats: ${JSON.stringify(cacheStats())}`);
console.log(failures === 0 ? "# ALL CHECKS PASSED" : `# ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
