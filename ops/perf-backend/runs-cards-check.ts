// PERF-BACKEND run-cards check (manager's live order, 2026-09-29).
//
// `storedCards()` in runManagers.ts used to read and parse EVERY run card on every
// call; the live profile measured 3,707 ms of synchronous readFileSync inside that
// chain over a 60 s window (listRunCards is called by GET /company/runs, the
// briefing refresh and the assistant prompt, so the parse ran again and again).
//
// This checks the two things that matter:
//   1. EQUIVALENCE - listRunCards() with the new mtime cache returns exactly what a
//      cache-free call returns (resetCaches() forces the cold path);
//   2. COST - the old pattern (readdir + parse all cards, every call) against the
//      new one (readdir + stat all, reuse the parse), on the real card directory.
//
// Usage: npx tsx ops/perf-backend/runs-cards-check.ts
import fs from "node:fs";
import path from "node:path";

process.env.COMPANY_ROOT = process.env.BENCH_COMPANY_ROOT ?? path.join(process.env.TEMP ?? "/tmp", "jcode-perfbe", "company");
process.env.MOCK_MODE = "1";

const { listRunCards } = await import("../../src/company/runManagers.js");
const { resetCaches } = await import("../../src/company/cache.js");

const runsDir = path.join(process.env.COMPANY_ROOT, "reports", "runs");
const cardNames = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((f) => f.endsWith(".json")).sort() : [];
const bytes = cardNames.reduce((n, f) => n + fs.statSync(path.join(runsDir, f)).size, 0);
console.log(`# card dir: ${runsDir}`);
console.log(`# ${cardNames.length} cards, ${(bytes / 1024).toFixed(0)} KB total`);

// ---- what the OLD storedCards() did on every call -------------------------
function oldStoredCards() {
  try {
    if (!fs.existsSync(runsDir)) return [];
    return fs
      .readdirSync(runsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(runsDir, f), "utf8")))
      .filter((c) => c && typeof c.runId === "string");
  } catch {
    return [];
  }
}

const REPEAT = 5;
const t0 = performance.now();
let parsed = 0;
for (let i = 0; i < REPEAT; i++) parsed = oldStoredCards().length;
const oldMs = (performance.now() - t0) / REPEAT;

// ---- the new public path, cold and warm ----------------------------------
resetCaches();
const t1 = performance.now();
const first = listRunCards();
const firstMs = performance.now() - t1;

const t2 = performance.now();
for (let i = 0; i < REPEAT; i++) listRunCards();
const warmMs = (performance.now() - t2) / REPEAT;

console.log("");
console.log(`# OLD: readdir + parse every card, every call : ${oldMs.toFixed(1)} ms/call`);
console.log(`# NEW: listRunCards() first call (cold parse)  : ${firstMs.toFixed(1)} ms`);
console.log(`# NEW: listRunCards() repeat call (cache hit)  : ${warmMs.toFixed(1)} ms/call`);
console.log(`# repeat speedup: ${(oldMs / Math.max(warmMs, 0.001)).toFixed(0)}x  (${parsed} cards parsed by the old path)`);

// ---- equivalence ---------------------------------------------------------
resetCaches();
const coldJson = JSON.stringify(listRunCards());
resetCaches();
const coldJson2 = JSON.stringify(listRunCards());
const warmJson = JSON.stringify(listRunCards());
const same = coldJson === coldJson2 && coldJson === warmJson;
console.log("");
console.log(`${same ? "PASS" : "FAIL"}  listRunCards(): cold == cold == warm (${coldJson.length} chars, ${first.length} runs)`);
process.exit(same ? 0 : 1);
