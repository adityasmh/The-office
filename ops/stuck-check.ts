/**
 * ops/stuck-check.ts - proof for R2-stuck-detector (docs/overnight/ORDER_R2-stuck-detector.md).
 *
 * PASS or FAIL per line:
 *   1  not stuck before the minutes limit
 *   2  stuck after the minutes limit with no change
 *   3  stuck by tokens (under the minutes limit)
 *   4  not stuck when an owned file changed
 *   5  not stuck when a REPORT.md exists
 *   6  not flagged twice (pure: a second verdict; tick: one hop over two passes)
 *   7  off by default (stuckEnabled false, isStuck vetoes, and the real tick behaves as before)
 *   8  the reason text names minutes and tokens
 *
 * It also drives the SHIPPED tickFleet() twice against a throwaway COMPANY_ROOT / FLEET_REPO, so
 * "off by default" and "not flagged twice" are measured on the real watcher, not on a copy.
 * No model is called and no network is used.
 *
 *   npx tsx ops/stuck-check.ts
 */
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-stuck-"));
process.env.COMPANY_ROOT = path.join(tmp, "company");
process.env.FLEET_REPO = path.join(tmp, "repo");
process.env.MOCK_MODE = "1";
process.env.FLEET_AUTO_APPROVE = "0";
process.env.FLEET_WATCH_INTERVAL_MS = "600000";
delete process.env.FLEET_STUCK; // the detector starts OFF: that is the baseline the tick must keep

const companyRoot = process.env.COMPANY_ROOT;
const repo = process.env.FLEET_REPO;
fs.mkdirSync(path.join(repo, "src"), { recursive: true });
fs.mkdirSync(path.join(companyRoot, "fleet"), { recursive: true });

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
};

const stuck = await import("../src/company/stuck.js");
const MIN = 60_000;
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

// ── 1..5, 6a, 8: the PURE verdict, on explicit inputs ────────────────────────
process.env.FLEET_STUCK = "1";
process.env.FLEET_STUCK_MINUTES = "8";
process.env.FLEET_STUCK_TOKENS = "80000";

const base = {
  now,
  tokens: 1000,
  reportExists: false,
  ownedChanged: false,
  alreadyFlagged: false,
};

const early = stuck.isStuck({ ...base, startedAt: iso(now - 2 * MIN) });
check("1: not stuck before the minutes limit", early.stuck === false, JSON.stringify(early));

const late = stuck.isStuck({ ...base, startedAt: iso(now - 20 * MIN) });
check("2: stuck after the minutes limit with no change", late.stuck === true, JSON.stringify(late));

check(
  "8: the reason names minutes and tokens",
  /minutes/i.test(late.reason) && /tokens/i.test(late.reason),
  late.reason,
);

const byTokens = stuck.isStuck({ ...base, startedAt: iso(now - 1 * MIN), tokens: 500000 });
check("3: stuck by tokens alone (minutes under the limit)", byTokens.stuck === true, JSON.stringify(byTokens));

const ownedMoved = stuck.isStuck({ ...base, startedAt: iso(now - 20 * MIN), tokens: 500000, ownedChanged: true });
check("4: not stuck when an owned file changed", ownedMoved.stuck === false, JSON.stringify(ownedMoved));

const hasReport = stuck.isStuck({ ...base, startedAt: iso(now - 20 * MIN), tokens: 500000, reportExists: true });
check("5: not stuck when a REPORT.md exists", hasReport.stuck === false, JSON.stringify(hasReport));

const secondVerdict = stuck.isStuck({ ...base, startedAt: iso(now - 20 * MIN), tokens: 500000, alreadyFlagged: true });
check("6a: isStuck raises no second flag when the work order is already flagged", secondVerdict.stuck === false, JSON.stringify(secondVerdict));

// ── 7a/7b: OFF by default ────────────────────────────────────────────────────
delete process.env.FLEET_STUCK;
check("7a: stuckEnabled() is false when FLEET_STUCK is unset", stuck.stuckEnabled() === false, "");
const offVerdict = stuck.isStuck({ ...base, startedAt: iso(now - 60 * MIN), tokens: 999999 });
check("7b: isStuck never flags while the detector is off", offVerdict.stuck === false, JSON.stringify(offVerdict));

// ── 7c, 2-tick, 6b: the REAL tick. Fixture: a `working` work order that started 20 min ago,
// with no session (so the tick's "worker gone" branch does not apply), no REPORT.md, and an
// owned path that was never written. That is exactly the fomuvs258c signature.
const startedAt = iso(now - 20 * MIN);
const fixture = {
  id: "foStuckTick",
  text: "GOAL: (fixture) a worker burning time with no progress.",
  createdAt: startedAt,
  updatedAt: startedAt,
  status: "running",
  plan: "one work order",
  workOrders: [
    {
      id: "WO1",
      title: "A stuck worker",
      role: "code",
      owns: ["src/never-written.ts"],
      brief: "Do the thing.",
      done: ["the file exists"],
      state: "working",
      startedAt,
      attempts: 0,
    },
  ],
  trace: [{ ts: startedAt, from: "CEO", to: "Claude (manager)", what: "order", detail: "GOAL: fixture" }],
};
fs.writeFileSync(path.join(companyRoot, "fleet", "orders.json"), JSON.stringify([fixture], null, 2));

const fleet = await import("../src/company/fleet.js");
const woOf = () => fleet.getFleetOrder("foStuckTick")!.workOrders[0]!;
const stuckHops = () => (fleet.getFleetOrder("foStuckTick")!.trace ?? []).filter((t) => t.what === "possibly stuck");

// OFF: the tick must behave exactly as before (no flag, no hop).
const before = await fleet.tickFleet();
const offWo = woOf();
check(
  "7c: with FLEET_STUCK unset the real tick adds no stuck flag and no trace hop",
  !offWo.stuck && stuckHops().length === 0 && offWo.state === "working",
  `tick=${JSON.stringify(before)} stuck=${offWo.stuck} state=${offWo.state} hops=${stuckHops().length}`,
);

// ON: the same tick must now flag it, exactly once.
process.env.FLEET_STUCK = "1";
await fleet.tickFleet();
const onWo = woOf();
check(
  "2-tick: the real tick flags the stuck work order",
  onWo.stuck === true && !!onWo.stuckReason,
  `stuck=${onWo.stuck} reason=${onWo.stuckReason ?? ""}`,
);
const hops = stuckHops();
check(
  "2-tick: exactly ONE trace hop Fleet -> CEO named 'possibly stuck'",
  hops.length === 1 && hops[0].from === "Fleet" && hops[0].to === "CEO" && /minutes/.test(hops[0].detail ?? ""),
  JSON.stringify(hops[0] ?? null),
);

// Second pass: still stuck, still one hop (not flagged twice).
await fleet.tickFleet();
check(
  "6b: a second tick does not flag it twice (one hop, still flagged)",
  stuckHops().length === 1 && woOf().stuck === true,
  `hops=${stuckHops().length} stuck=${woOf().stuck}`,
);

// Progress clears the flag: writing an owned file must unstick it.
fs.writeFileSync(path.join(repo, "src", "never-written.ts"), "// the worker finally edited its file\n");
await fleet.tickFleet();
check(
  "clear: an owned file change clears the stuck flag",
  !woOf().stuck && woOf().stuckReason === undefined,
  `stuck=${woOf().stuck} reason=${woOf().stuckReason ?? ""}`,
);

console.log(`\n[stuck-check] ${failures ? `${failures} FAILED` : "ALL CHECKS PASSED"} (temp dir ${tmp})`);
process.exit(failures ? 1 : 0);
