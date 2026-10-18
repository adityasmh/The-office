/**
 * ops/auto-redo-check.ts - proof for R3-auto-redo (docs/overnight/ORDER_R3-auto-redo.md, 2026-10-06).
 *
 * PASS or FAIL per line:
 *   1  off by default (the flag, the pure verdict, and the real tick)
 *   2  retries once on a REDO that left notes (real tick: the work order is re-queued)
 *   3  respects the cap (pure, and a real tick with one retry already spent)
 *   4  does not retry with empty notes, nor when the REDO came from a missing/empty REPORT.md
 *   5  does not retry when a red CI check is the only reason
 *   6  does not retry when the notes repeat the previous attempt's
 *   7  does not retry when the company is paused
 *   8  does not retry with no free session slot
 *   9  the hard maximum of 2 is enforced even if a larger number is configured
 *  10  the trace text names the attempt
 *
 * The pure half drives the shipped shouldAutoRedo() / autoRedoMax() on explicit inputs. The tick
 * half drives the REAL exported tickFleet() with the gateway stubbed through globalThis.fetch
 * (every fixture order carries forceProvider:"kimi", so no Claude CLI and no real network is ever
 * used) and MIN_FREE_RAM_MB set above any real machine's free RAM, so the tick's fillSlots() always
 * stops at its RAM floor: no terminal window is ever opened and nothing is spawned.
 *
 *   npx tsx ops/auto-redo-check.ts
 */
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auto-redo-"));
process.env.COMPANY_ROOT = path.join(tmp, "company");
process.env.FLEET_REPO = path.join(tmp, "repo");
process.env.MOCK_MODE = "0"; // the reviewer path must really run
process.env.FLEET_AUTO_APPROVE = "0";
process.env.FLEET_WATCH_INTERVAL_MS = "600000";
// A redo re-queues a work order, and the tick's fillSlots() would then try to open a REAL jcode
// terminal. The RAM floor is set above any real machine's free memory, so fillSlots() always stops
// there; the proof must never spawn a window or make a call.
process.env.MIN_FREE_RAM_MB = "1000000";
delete process.env.FLEET_AUTO_REDO; // the baseline: the feature starts OFF
delete process.env.FLEET_AUTO_REDO_MAX;

const companyRoot = process.env.COMPANY_ROOT!;
const repo = process.env.FLEET_REPO!;
const fleetDir = path.join(companyRoot, "fleet");
fs.mkdirSync(path.join(repo, "src"), { recursive: true });
fs.mkdirSync(fleetDir, { recursive: true });

// ── stub HTTP: a Laya that is down, and a scripted gateway keyed by work-order id ──────────────
const calls: Array<{ url: string; user: string }> = [];
const queues: Record<string, string[]> = {};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes("/v1/systemone")) {
    // Laya unavailable: the model pick falls back to rules, no network.
    return new Response("laya unavailable", { status: 503 });
  }
  let body: { messages?: Array<{ role?: string; content?: string }> } = {};
  try { body = init?.body ? JSON.parse(String(init.body)) : {}; } catch { /* keep {} */ }
  const user = (body.messages ?? []).filter((m) => m.role === "user").map((m) => m.content ?? "").join("\n");
  calls.push({ url, user });
  let reply = "{}";
  for (const id of Object.keys(queues)) {
    if (user.includes(`WORK ORDER ${id}`)) {
      reply = queues[id].shift() ?? "{}";
      break;
    }
  }
  const payload = { choices: [{ finish_reason: "stop", message: { content: reply } }], usage: {} };
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
};

const autoRedo = await import("../src/company/autoRedo.js");

// ── the PURE verdict ──────────────────────────────────────────────────────────────────────────
const base = {
  verdict: "REDO" as const,
  attempts: 0,
  max: 1,
  reviewText: "the widget has no error path; add one and re-run the tests",
  prevReviewText: "",
  reason: "review",
  failedCiOnly: false,
  slotsFree: true,
  paused: false,
};

// 1a/1b: OFF by default.
delete process.env.FLEET_AUTO_REDO;
check("1a: autoRedoEnabled() is false when FLEET_AUTO_REDO is unset", autoRedo.autoRedoEnabled() === false, "");
const off = autoRedo.shouldAutoRedo(base);
check(
  "1b: shouldAutoRedo never retries while the flag is off",
  off.redo === false && /FLEET_AUTO_REDO/.test(off.reason),
  JSON.stringify(off),
);

process.env.FLEET_AUTO_REDO = "1";

// 2 + 10a: the yes case, and the trace text it produces.
const yes = autoRedo.shouldAutoRedo(base);
check(
  "2: retries once on a REDO with notes",
  yes.redo === true && yes.attempt === 1 && yes.max === 1,
  JSON.stringify(yes),
);
check("10a: the trace text names the attempt", /attempt 1 of 1/.test(yes.reason), yes.reason);

// 3: the cap.
const capped = autoRedo.shouldAutoRedo({ ...base, attempts: 1 });
check(
  "3: respects the cap (1 attempt already used of max 1)",
  capped.redo === false && /already used/.test(capped.reason),
  JSON.stringify(capped),
);

// 4 + 4b: nothing to learn from.
const noNotes = autoRedo.shouldAutoRedo({ ...base, reviewText: "   " });
check("4: does not retry with empty notes", noNotes.redo === false && /no notes/i.test(noNotes.reason), JSON.stringify(noNotes));
const emptyReport = autoRedo.shouldAutoRedo({ ...base, reason: "empty-report" });
check(
  "4b: does not retry when the REDO came from a missing/empty report",
  emptyReport.redo === false && /REPORT/.test(emptyReport.reason),
  JSON.stringify(emptyReport),
);

// 5: a red CI check is a human's problem.
const ci = autoRedo.shouldAutoRedo({ ...base, reason: "ci-red", failedCiOnly: true });
check("5: does not retry when CI-red is the only reason", ci.redo === false && /CI check/.test(ci.reason), JSON.stringify(ci));

// 6: identical notes mean the worker is not learning.
const repeated = autoRedo.shouldAutoRedo({ ...base, prevReviewText: `  ${base.reviewText}  ` });
check(
  "6: does not retry on repeated identical notes",
  repeated.redo === false && /identical/.test(repeated.reason),
  JSON.stringify(repeated),
);

// 7/8: paused, or no free session slot.
const paused = autoRedo.shouldAutoRedo({ ...base, paused: true });
check("7: does not retry when the company is paused", paused.redo === false && /paused/.test(paused.reason), JSON.stringify(paused));
const noSlot = autoRedo.shouldAutoRedo({ ...base, slotsFree: false });
check("8: does not retry with no free session slot", noSlot.redo === false && /slot is busy/.test(noSlot.reason), JSON.stringify(noSlot));

// 9: the hard maximum of 2, even when a larger number is configured.
process.env.FLEET_AUTO_REDO_MAX = "5";
const max5 = autoRedo.autoRedoMax();
const over = autoRedo.shouldAutoRedo({ ...base, max: 5, attempts: 2 });
const oneMore = autoRedo.shouldAutoRedo({ ...base, max: 5, attempts: 1 });
check(
  "9: the hard maximum of 2 is enforced even when a larger number is configured",
  max5 === 2 && over.redo === false && over.max === 2 && oneMore.redo === true && oneMore.attempt === 2 && oneMore.max === 2,
  `autoRedoMax=${max5} over=${JSON.stringify(over)} oneMore=${JSON.stringify(oneMore)}`,
);
delete process.env.FLEET_AUTO_REDO_MAX;

// ── the REAL tick ─────────────────────────────────────────────────────────────────────────────
const nowIso = new Date().toISOString();
const NOTES_B = "still no error path in the widget; add one and re-run the tests";
const NOTES_D = "add the error path and re-run the tests";
const mkOrder = (orderId: string, wid: string, extra: Record<string, unknown> = {}) => ({
  id: orderId,
  text: "GOAL: (fixture) R3-auto-redo behaviour.",
  createdAt: nowIso,
  updatedAt: nowIso,
  status: "running",
  plan: "one work order",
  // Every fixture bypasses the Claude CLI: the reviewer goes straight to the stubbed gateway.
  forceProvider: "kimi",
  workOrders: [
    {
      id: wid,
      title: `fixture ${wid}`,
      role: "code",
      owns: [`src/${wid}.ts`],
      brief: "Do the thing and write REPORT.md.",
      done: ["the deliverable exists"],
      state: "reported",
      attempts: 0,
      reportedAt: nowIso,
      ...extra,
    },
  ],
  trace: [{ ts: nowIso, from: "CEO", to: "Claude (manager)", what: "order", detail: "GOAL: fixture" }],
});
const writeReport = (orderId: string, wid: string, text: string) => {
  const dir = path.join(fleetDir, orderId, wid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "REPORT.md"), text);
};
const hopsOf = (orderId: string) =>
  ((fleet.getFleetOrder(orderId)?.trace ?? []) as Array<{ what?: string; detail?: string }>).filter((t) =>
    String(t.what ?? "").startsWith("auto redo"),
  );
const skipHop = (orderId: string) => hopsOf(orderId).find((h) => h.what === "auto redo skipped");

// Order A: the OFF baseline. A REDO with real notes must stay a REDO.
// (The pure checks above left FLEET_AUTO_REDO=1: this is the baseline the tick must keep.)
delete process.env.FLEET_AUTO_REDO;
writeReport("foArAutoOff", "WOA", "# REPORT\nfirst attempt.\n");
queues["WOA"] = ['{"verdict":"REDO","review":"the widget has no error path; add one and re-run the tests"}'];
fs.writeFileSync(path.join(fleetDir, "orders.json"), JSON.stringify([mkOrder("foArAutoOff", "WOA")], null, 2));

const fleet = await import("../src/company/fleet.js");
console.log("[auto-redo] tick 1 - FLEET_AUTO_REDO is unset (the default)");
const t1 = await fleet.tickFleet();
console.log(`[auto-redo] tick 1 -> ${JSON.stringify(t1)}`);
const a = fleet.getFleetOrder("foArAutoOff")!.workOrders[0]!;
check(
  "1c: with the flag unset the real tick stores the REDO and does NOT redo it",
  a.state === "reviewed" && a.verdict === "REDO" && a.attempts === 0,
  `state=${a.state} verdict=${String(a.verdict)} attempts=${a.attempts}`,
);
check("1d: ... and adds NO auto-redo trace step", hopsOf("foArAutoOff").length === 0, `hops=${hopsOf("foArAutoOff").length}`);
check(
  "1e: ... and the reviewer is called exactly once (unchanged review path)",
  calls.filter((c) => c.user.includes("WORK ORDER WOA")).length === 1,
  `calls=${calls.filter((c) => c.user.includes("WORK ORDER WOA")).length}`,
);

// The ON fixtures. They are added through the fleet's OWN save path: writes are queued FIFO, so
// this payload lands after every write the tick queued and cannot be clobbered by a late one.
writeReport("foArRedo", "WOB", "# REPORT\nsecond attempt.\n");
queues["WOB"] = [`{"verdict":"REDO","review":${JSON.stringify(NOTES_B)}}`];
writeReport("foArEmptyReport", "WOC", ""); // exists but EMPTY: the automated PASS floor must REDO it
queues["WOC"] = ['{"verdict":"PASS","review":"looks complete to me"}'];
writeReport("foArRepeat", "WOD", "# REPORT\nrepeat attempt.\n");
queues["WOD"] = [`{"verdict":"REDO","review":${JSON.stringify(NOTES_D)}}`];
writeReport("foArCap", "WOE", "# REPORT\ncap attempt.\n");
queues["WOE"] = ['{"verdict":"REDO","review":"a genuinely different piece of feedback"}'];

const ordersOnDisk = fleet.loadFleetOrders();
ordersOnDisk.push(
  mkOrder("foArRedo", "WOB"),
  mkOrder("foArEmptyReport", "WOC"),
  // One redo already spent, and the reviewer repeats the exact notes he gave for it.
  mkOrder("foArRepeat", "WOD", { attempts: 1, review: NOTES_D }),
  // One redo already spent (the default cap), with different notes.
  mkOrder("foArCap", "WOE", { attempts: 1, review: "older notes from the first attempt" }),
);
fleet.saveFleetOrders(ordersOnDisk);

process.env.FLEET_AUTO_REDO = "1";
console.log("[auto-redo] tick 2 - FLEET_AUTO_REDO=1");
const t2 = await fleet.tickFleet();
console.log(`[auto-redo] tick 2 -> ${JSON.stringify(t2)}`);

// 2 + 10b: the retry really happened, and the trace names the attempt.
const b = fleet.getFleetOrder("foArRedo")!.workOrders[0]!;
const bHop = hopsOf("foArRedo").find((h) => String(h.what ?? "").startsWith("auto redo (attempt"));
check(
  "2b: the real tick re-queues the REDO'd work order automatically",
  b.state === "queued" && b.verdict === undefined && b.attempts === 1,
  `state=${b.state} verdict=${String(b.verdict)} attempts=${b.attempts}`,
);
check(
  "2c: the retry keeps the reviewer's notes, so the new brief carries them",
  String(b.review ?? "").includes("error path"),
  `review=${JSON.stringify(String(b.review ?? "").slice(0, 80))}`,
);
check(
  "10b: the trace step names the attempt",
  String(bHop?.what ?? "") === "auto redo (attempt 1 of 1)",
  JSON.stringify(bHop ?? null),
);
check(
  "2d: no terminal was opened for the retry (the RAM floor stopped fillSlots)",
  !b.sessionId && !b.windowPid,
  `sessionId=${String(b.sessionId)} windowPid=${String(b.windowPid)}`,
);

// 4c: the automated empty-report REDO is never retried.
const c = fleet.getFleetOrder("foArEmptyReport")!.workOrders[0]!;
check(
  "4c: a REDO from an empty REPORT.md is not retried by the real tick",
  c.verdict === "REDO" && c.state === "reviewed" && c.attempts === 0 && /automated check/.test(String(c.review ?? "")),
  `verdict=${String(c.verdict)} state=${c.state} attempts=${c.attempts}`,
);
check(
  "4d: ... and the skip is explained in plain words",
  !!skipHop("foArEmptyReport") && /REPORT/.test(String(skipHop("foArEmptyReport")!.detail)),
  JSON.stringify(skipHop("foArEmptyReport") ?? null),
);

// 6b: repeated notes stop the retry and ask the CEO.
const d = fleet.getFleetOrder("foArRepeat")!.workOrders[0]!;
check(
  "6b: identical notes to the previous attempt are not retried by the real tick",
  d.verdict === "REDO" && d.state === "reviewed" && d.attempts === 1,
  `verdict=${String(d.verdict)} state=${d.state} attempts=${d.attempts}`,
);
check(
  "6c: ... and the skip names the repeat",
  !!skipHop("foArRepeat") && /identical/.test(String(skipHop("foArRepeat")!.detail)),
  JSON.stringify(skipHop("foArRepeat") ?? null),
);

// 3b: the cap stops the second automatic retry.
const e = fleet.getFleetOrder("foArCap")!.workOrders[0]!;
check(
  "3b: the cap stops a second automatic retry in the real tick",
  e.verdict === "REDO" && e.state === "reviewed" && e.attempts === 1,
  `verdict=${String(e.verdict)} state=${e.state} attempts=${e.attempts}`,
);
check(
  "3c: ... and the skip says how many retries were used",
  !!skipHop("foArCap") && /already used/.test(String(skipHop("foArCap")!.detail)),
  JSON.stringify(skipHop("foArCap") ?? null),
);

globalThis.fetch = realFetch;
console.log(`\n[auto-redo] ${failures ? `${failures} FAILED` : "ALL CHECKS PASSED"} (temp dir ${tmp})`);
process.exit(failures ? 1 : 0);
