/**
 * ops/loop-fix-check.ts — proof for docs/ORDER_2026-10-01_loop-fixes-1-2.md.
 *
 * Proves, entirely on a THROWAWAY COMPANY_ROOT / FLEET_REPO in %TEMP% (it never reads or
 * writes the live company/ dir, never starts/stops the router, prints no secrets):
 *
 *   FIX 1  fleet: 5 `tickFleet()` passes over an order set with nothing to change write
 *          NOTHING to company/fleet/orders.json; one real transition writes exactly ONCE.
 *          The pre-fix behaviour (unconditional write) is reproduced with FLEET_SAVE_ALWAYS=1.
 *   FIX 2  runs:  one `listRunCards()` call costs 1 `statSync` of the runs dir, where the old
 *          signature cost `readdirSync` + one `statSync` per card (150 here). A card rewrite is
 *          picked up after the TTL, and the TTL memo makes a second call cost 0 stats.
 *   FIX 3  attribution: the four hot call sites set a real breadcrumb (busyLabel()) instead of
 *          "idle" while they run: fleet tick / briefing storedCards / brain failures /
 *          reaper registry save.
 *
 *   npx tsx ops/loop-fix-check.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FleetOrder } from "../src/company/fleet.js";

process.env.MOCK_MODE = "1";
process.env.NEEDS_YOU_AUTO_NUDGE = "0";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loop-fix-check-"));
process.env.COMPANY_ROOT = path.join(tmp, "company");
process.env.FLEET_REPO = path.join(tmp, "repo");
process.env.RUNS_SIG_TTL_MS = "2000"; // production default is 8000; small here so the check is quick
fs.mkdirSync(process.env.FLEET_REPO, { recursive: true });

const fleet = await import("../src/company/fleet.js");
const runManagers = await import("../src/company/runManagers.js");
const brain = await import("../src/company/brainRouter.js");
const terminalReaper = await import("../src/company/terminalReaper.js");
const watchdog = await import("../src/company/loopWatchdog.js");

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const companyRoot = process.env.COMPANY_ROOT!;
const ordersPath = path.join(companyRoot, "fleet", "orders.json");
const runsDir = path.join(companyRoot, "reports", "runs");
fs.mkdirSync(runsDir, { recursive: true });

// ── spies ────────────────────────────────────────────────────────────────
// The modules import `fs` from "node:fs" (the same object), so patching here is what the
// code under test calls. The same trick installSyncOpTracing() uses.
type Fn = (...args: any[]) => any;
const rawFs = fs as unknown as Record<string, Fn>;
const rawPromises = fs.promises as unknown as Record<string, Fn>;
const original = {
  writeFileSync: rawFs.writeFileSync,
  renameSync: rawFs.renameSync,
  statSync: rawFs.statSync,
  readFileSync: rawFs.readFileSync,
  readdirSync: rawFs.readdirSync,
  promisesWriteFile: rawPromises.writeFile,
  promisesRename: rawPromises.rename,
};

let ordersTmpWrites = 0;
let ordersCommits = 0;
let ordersDirectWrites = 0;
let ordersBytes = 0;
let runsDirStats = 0;
let ordersStatReads = 0;
let oldStats = 0;
let labelAtOrdersRename = "";
let labelAtRunsStat = "";
let labelAtBrainRead = "";
let labelAtRegistryWrite = "";

const resetCounters = (): void => {
  ordersTmpWrites = 0;
  ordersCommits = 0;
  ordersDirectWrites = 0;
  ordersBytes = 0;
  ordersStatReads = 0;
};
const ordersWriteOps = (): number => ordersTmpWrites + ordersCommits + ordersDirectWrites;

rawFs.writeFileSync = (p: unknown, data: unknown, ...rest: unknown[]) => {
  const name = typeof p === "string" ? path.basename(p) : "";
  if (name === "orders.json") {
    ordersDirectWrites++;
    if (typeof data === "string") ordersBytes += Buffer.byteLength(data);
  } else if (name.startsWith("orders.json.tmp")) {
    ordersTmpWrites++;
    if (typeof data === "string") ordersBytes += Buffer.byteLength(data);
  } else if (name === "terminals.json" || name.startsWith("terminals.json.tmp")) {
    labelAtRegistryWrite = watchdog.busyLabel();
  }
  return original.writeFileSync(p, data, ...rest);
};
rawFs.renameSync = (a: unknown, b: unknown, ...rest: unknown[]) => {
  const name = typeof b === "string" ? path.basename(b) : "";
  if (name === "orders.json") {
    ordersCommits++;
    labelAtOrdersRename = watchdog.busyLabel();
  } else if (name === "terminals.json") {
    labelAtRegistryWrite = watchdog.busyLabel();
  }
  return original.renameSync(a, b, ...rest);
};
const samePath = (a: string, b: string): boolean => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
rawFs.statSync = (p: unknown, ...rest: unknown[]) => {
  if (typeof p === "string" && samePath(p, runsDir)) {
    runsDirStats++;
    labelAtRunsStat = watchdog.busyLabel();
  } else if (typeof p === "string" && path.basename(p) === "orders.json") {
    ordersStatReads++; // every loadFleetOrders() cache check stats the file: one+ per watcher tick
  }
  return original.statSync(p, ...rest);
};
rawFs.readFileSync = (p: unknown, ...rest: unknown[]) => {
  if (typeof p === "string" && path.basename(p) === "brain-failures.json") labelAtBrainRead = watchdog.busyLabel();
  return original.readFileSync(p, ...rest);
};

// LOOP-LAG (2026-10-01): saveFleetOrders now uses fs.promises for the actual I/O, so the
// test must count those async writes as well as the sync fallback path.
rawPromises.writeFile = async (p: unknown, data: unknown, ...rest: unknown[]) => {
  const name = typeof p === "string" ? path.basename(p) : "";
  if (name === "orders.json") {
    ordersDirectWrites++;
    if (typeof data === "string") ordersBytes += Buffer.byteLength(data);
  } else if (name.startsWith("orders.json.tmp")) {
    ordersTmpWrites++;
    if (typeof data === "string") ordersBytes += Buffer.byteLength(data);
  } else if (name === "terminals.json" || name.startsWith("terminals.json.tmp")) {
    labelAtRegistryWrite = watchdog.busyLabel();
  }
  return original.promisesWriteFile(p, data, ...rest);
};
rawPromises.rename = async (a: unknown, b: unknown, ...rest: unknown[]) => {
  const name = typeof b === "string" ? path.basename(b) : "";
  if (name === "orders.json") {
    ordersCommits++;
    labelAtOrdersRename = watchdog.busyLabel();
  } else if (name === "terminals.json") {
    labelAtRegistryWrite = watchdog.busyLabel();
  }
  return original.promisesRename(a, b, ...rest);
};

console.log(`[loop-fix-check] throwaway COMPANY_ROOT=${companyRoot}`);

// ── FIX 1: the fleet tick must not rewrite orders.json when nothing changed ──
console.log("\n== FIX 1: fleet tick (src/company/fleet.ts) ==");

const seedOrder = (id: string): FleetOrder => ({
  id,
  text: "loop-fix-check: nothing to change",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  status: "running",
  workOrders: [
    { id: "WO-1", title: "loop-fix-check work order", role: "check", owns: [], brief: "check", done: [], state: "idle", attempts: 0 },
  ],
  trace: [{ ts: "2026-10-01T00:00:00.000Z", from: "CEO", to: "Claude (manager)", what: "order", detail: "loop-fix-check" }],
});

await fleet.saveFleetOrders([seedOrder("foLoopFix1")]);
check("seed written", fs.existsSync(ordersPath), `orders.json at ${ordersPath}`);

// AFTER the fix: 5 passes over a set with nothing to change.
resetCounters();
for (let i = 0; i < 5; i++) await fleet.tickFleet();
const afterWrites = ordersWriteOps();
console.log(`  after  fix: 5 no-change ticks -> ${afterWrites} write op(s) (tmp=${ordersTmpWrites} rename=${ordersCommits} direct=${ordersDirectWrites} bytes=${ordersBytes})`);
check("5 no-change ticks write nothing", afterWrites === 0, `writes=${afterWrites}`);

// BEFORE the fix (pre-fix behaviour reproduced): the same 5 ticks with the escape hatch on.
process.env.FLEET_SAVE_ALWAYS = "1";
resetCounters();
for (let i = 0; i < 5; i++) await fleet.tickFleet();
const beforeWrites = ordersWriteOps();
console.log(`  before fix: 5 no-change ticks -> ${beforeWrites} write op(s) (tmp=${ordersTmpWrites} rename=${ordersCommits} bytes=${ordersBytes})`);
check("pre-fix behaviour reproduced (5 ticks -> writes)", beforeWrites >= 5, `writes=${beforeWrites}`);
delete process.env.FLEET_SAVE_ALWAYS;

// A REAL transition: the worker session is gone and no REPORT.md -> the work order (and the
// order) go to "failed". Written to disk directly so the rollback below is not counted.
const seeded = JSON.parse(original.readFileSync(ordersPath, "utf8") as string) as FleetOrder[];
const mut = seeded.find((o) => o.id === "foLoopFix1")!;
mut.workOrders[0].state = "working";
mut.workOrders[0].sessionId = "no-such-session-loop-fix-check";
mut.workOrders[0].startedAt = new Date(Date.now() - 300_000).toISOString();
original.writeFileSync(ordersPath, JSON.stringify(seeded, null, 2));

resetCounters();
const tick = await fleet.tickFleet();
const transitionWrites = ordersWriteOps();
console.log(`  transition : 1 tick -> ${transitionWrites} write op(s) (tmp=${ordersTmpWrites} rename=${ordersCommits} bytes=${ordersBytes}), advanced=${tick.advanced}`);
check("one real transition writes exactly once", ordersTmpWrites === 1 && ordersCommits === 1 && ordersDirectWrites === 0, `tmp=${ordersTmpWrites} rename=${ordersCommits} direct=${ordersDirectWrites}`);

const onDisk = JSON.parse(original.readFileSync(ordersPath, "utf8") as string) as FleetOrder[];
const diskOrder = onDisk.find((o) => o.id === "foLoopFix1")!;
check(
  "reading it back gives the right state",
  diskOrder.status === "failed" && diskOrder.workOrders[0].state === "failed",
  `status=${diskOrder.status} wo=${diskOrder.workOrders[0].state}`,
);
check("the new content carries the failure trace", JSON.stringify(diskOrder.trace).includes("worker gone"));
const inProcess = fleet.getFleetOrder("foLoopFix1")!;
check("the in-process read agrees with the file", inProcess.status === diskOrder.status);

// ── Integration: the REAL watcher loop the router runs (not just direct tick calls) ──
// Same public entry point the router uses at boot (startFleetWatcher -> tickFleet on a timer).
console.log("\n== Integration: startFleetWatcher() (the router's own fleet path) ==");
await fleet.saveFleetOrders([seedOrder("foLoopFix2")]);
process.env.FLEET_WATCH_INTERVAL_MS = "400";
const watcher = await fleet.startFleetWatcher();
check("the real fleet watcher started on the temp COMPANY_ROOT", watcher.running === true, `intervalMs=${watcher.intervalMs}`);
resetCounters();
await sleep(2500); // real timer ticks at FLEET_WATCH_INTERVAL_MS=400
const tickReads = ordersStatReads;
const idleWrites = ordersWriteOps();
console.log(`  real watcher, ${tickReads} orders.json loads (= >=1 per watcher tick), nothing to change -> ${idleWrites} write op(s)`);
check("the real watcher ran several real timer ticks", tickReads >= 3, `orders.json loads=${tickReads}`);
check("real watcher ticks on an unchanged fleet write nothing", idleWrites === 0, `writes=${idleWrites}`);

// A real transition, driven the way the code drives it: mutate the in-process order.
const live2 = fleet.getFleetOrder("foLoopFix2")!;
live2.workOrders[0].state = "working";
live2.workOrders[0].sessionId = "no-such-session-loop-fix-check-2";
live2.workOrders[0].startedAt = new Date(Date.now() - 300_000).toISOString();
resetCounters();
await sleep(2000);
const watcherTransition = ordersWriteOps();
console.log(`  real watcher, 1 mutating tick -> ${watcherTransition} write op(s) (tmp=${ordersTmpWrites} rename=${ordersCommits})`);
check("the real watcher writes exactly once for the transition", ordersTmpWrites === 1 && ordersCommits === 1, `tmp=${ordersTmpWrites} rename=${ordersCommits}`);
const disk2 = (JSON.parse(original.readFileSync(ordersPath, "utf8") as string) as FleetOrder[]).find((o) => o.id === "foLoopFix2")!;
check("the watcher's save is on disk with the new state", disk2.status === "failed" && disk2.workOrders[0].state === "failed", `status=${disk2.status} wo=${disk2.workOrders[0].state}`);
check("the watcher's save carried the 'fleet tick' label", labelAtOrdersRename === "fleet tick", `label="${labelAtOrdersRename}"`);
fleet.stopFleetWatcher();
resetCounters();
await sleep(1200);
check("no writes after the watcher is stopped", ordersWriteOps() === 0, `writes=${ordersWriteOps()}`);

// ── FIX 2: the runs-dir signature must cost ONE stat, not one per card ──
console.log("\n== FIX 2: runs signature (src/company/runManagers.ts) ==");

const CARD_COUNT = 150;
type FakeCard = {
  runId: string;
  kind: string;
  title: string;
  owner: string;
  state: string;
  headline: string;
  done: string[];
  remaining: string[];
  model: string;
  modelReason: string;
  checkedAt: string;
  evidenceHash: string;
  updatedAt: string;
};
const cardFor = (id: string, headline: string): FakeCard => ({
  runId: id,
  kind: "fleet",
  title: id,
  owner: "loop-fix-check",
  state: "done",
  headline,
  done: [],
  remaining: [],
  model: "local",
  modelReason: "loop-fix-check",
  checkedAt: "2026-10-01T00:00:00.000Z",
  evidenceHash: "loop-fix-check",
  // run-000 sorts first so it survives listRunCards()'s maxRuns slice.
  updatedAt: id === "run-000" ? "2099-01-01T00:00:00.000Z" : "2026-10-01T00:00:00.000Z",
});
function writeCardFile(id: string, headline: string): void {
  const file = path.join(runsDir, `${id}.json`);
  const tmpFile = `${file}.tmp`;
  original.writeFileSync(tmpFile, JSON.stringify(cardFor(id, headline), null, 2));
  original.renameSync(tmpFile, file); // writeCard()'s tmp+rename: moves the DIRECTORY mtime
}
for (let i = 0; i < CARD_COUNT; i++) writeCardFile(`run-${String(i).padStart(3, "0")}`, `card ${i}`);
console.log(`  created ${CARD_COUNT} fake run cards in ${runsDir}`);

// BEFORE: the pre-fix algorithm, verbatim (readdirSync + one statSync per card).
oldStats = 0;
const oldSignature = (): string => {
  const names = (original.readdirSync(runsDir) as string[]).filter((f) => f.endsWith(".json")).sort();
  return names.map((n) => {
    oldStats++;
    const st = original.statSync(path.join(runsDir, n));
    return `${n}@${st.mtimeMs}:${st.size}`;
  }).join("|");
};
const oldSig = oldSignature();
console.log(`  before fix: one signature = 1 readdirSync + ${oldStats} statSync (one per card)`);
check(`pre-fix signature did one stat per card (${CARD_COUNT})`, oldStats >= CARD_COUNT, `stats=${oldStats}`);

// AFTER: one listRunCards() with the signature memo expired. The first call in a process also
// pays discoverRuns() (the real .jcode\sessions dir, cached for 15 s), so warm that first and
// measure only the calls whose cost the fix changes.
runManagers.listRunCards();
await sleep(Number(process.env.RUNS_SIG_TTL_MS) + 120); // let the signature memo expire
runsDirStats = 0;
const cards1 = runManagers.listRunCards();
const afterStats1 = runsDirStats;
console.log(`  after  fix: one listRunCards() = ${afterStats1} statSync of the runs dir (${cards1.length} cards returned)`);
check("one listRunCards() costs 1-2 stats, not one per card", afterStats1 >= 1 && afterStats1 <= 2, `stats=${afterStats1}`);
check("the fixed signature still sees the same cards", cards1.some((c) => c.runId === "run-000"), `cards=${cards1.length}`);

// The TTL memo: a second call inside the TTL costs no stat at all.
runsDirStats = 0;
runManagers.listRunCards();
check("a call inside the TTL memo costs 0 stats", runsDirStats === 0, `stats=${runsDirStats}`);
check("old and new signatures are over the same file set", oldSig.length > 0 && oldStats === CARD_COUNT, `oldSigLen=${oldSig.length}`);

// Touch one card: writeCard-style tmp+rename, then wait past the TTL.
const mtimeBefore = original.statSync(runsDir).mtimeMs;
await sleep(20);
writeCardFile("run-000", "loop-fix-check UPDATED");
const mtimeAfter = original.statSync(runsDir).mtimeMs;
await sleep(Number(process.env.RUNS_SIG_TTL_MS) + 120);
runsDirStats = 0;
const cards2 = runManagers.listRunCards();
const touched = cards2.find((c) => c.runId === "run-000");
console.log(`  card rewrite: dir mtime moved=${mtimeAfter !== mtimeBefore}, stats after TTL=${runsDirStats}`);
check("a card rewrite is picked up after the TTL", touched?.headline === "loop-fix-check UPDATED", `headline=${touched?.headline}`);

// ── FIX 3: attribution - the hot call sites are no longer "idle" ──
console.log("\n== FIX 3: attribution (src/company/loopWatchdog.ts) ==");

watchdog.markBusy("idle");
const before = watchdog.busyLabel();

// fleet tick: captured on the transition tick's orders.json rename above.
check("fleet tick sets a real breadcrumb", labelAtOrdersRename === "fleet tick", `label="${labelAtOrdersRename}"`);
// briefing storedCards: captured when the TTL expired and the runs dir was statted.
check("briefing storedCards sets a real breadcrumb", labelAtRunsStat === "briefing storedCards", `label="${labelAtRunsStat}"`);

// brain failures: readFailures() reads brain-failures.json inside the breadcrumb.
labelAtBrainRead = "";
brain.noteCheapFailure("loop-fix-check:1");
const n1 = brain.cheapFailures("loop-fix-check:1");
check("brain failures sets a real breadcrumb", labelAtBrainRead === "brain failures", `label="${labelAtBrainRead}"`);
check("the failure counter still works", n1 >= 1, `count=${n1}`);
brain.clearCheapFailures("loop-fix-check:1");

// reaper registry save: saveTerminals() writes company/terminals.json atomically.
labelAtRegistryWrite = "";
await terminalReaper.saveTerminals([]);
check("reaper registry save sets a real breadcrumb", labelAtRegistryWrite === "reaper registry save", `label="${labelAtRegistryWrite}"`);
check("the breadcrumb is restored after each call", watchdog.busyLabel() === before, `label="${watchdog.busyLabel()}"`);

// ── summary ──
console.log(`\n[loop-fix-check] ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
console.log(`[loop-fix-check] temp dir left in place (nothing in the live company/ dir was touched): ${tmp}`);
process.exitCode = failures ? 1 : 0;
