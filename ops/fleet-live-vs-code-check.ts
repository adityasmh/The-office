/**
 * ops/fleet-live-vs-code-check.ts — INDEPENDENT confirmation that the RUNNING router still serves
 * the PRE-FIX wording, while the working tree serves the NEW wording.
 *
 * Method: the same live company data is classified twice -
 *   1. by the RUNNING router, through its HTTP API (what the CEO actually sees), and
 *   2. by the WORKING TREE code, in this process, on a read-only copy of the same orders.json.
 * If the two agree that the item is "Retry this order or drop it?", the running process has NOT
 * picked up the fix and the CEO is still seeing the old prompt.
 *
 *   npx tsx ops/fleet-live-vs-code-check.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const live = path.join(process.cwd(), "company", "fleet", "orders.json");
const orders = JSON.parse(fs.readFileSync(live, "utf8")) as any[];

// ── what the WORKING TREE says ─────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "live-vs-code-"));
process.env.COMPANY_ROOT = path.join(tmp, "company");
process.env.MOCK_MODE = "1";
fs.mkdirSync(path.join(process.env.COMPANY_ROOT, "fleet"), { recursive: true });
fs.writeFileSync(path.join(process.env.COMPANY_ROOT, "fleet", "orders.json"), JSON.stringify(orders));
const runManagers = await import("../src/company/runManagers.js");
const briefing = await import("../src/company/briefing.js");
const briefingCode = await import("../src/company/claudeSignIn.js");

const failedOpen = orders.filter((o) => o.status === "failed" && !o.closedAs && !o.supersededBy);
const treeView = (id: string) => {
  const cards = runManagers.listRunCards();
  const b = briefing.composeBriefing(cards, { seenAt: new Date(0).toISOString(), summary: "(x)", model: "local" });
  const i = b.needsYou.find((n: any) => n.runId === `fleet:${id}`);
  return { kind: i?.kind, question: i?.question, actions: (i?.actions ?? []).map((a: any) => a.id) };
};

// ── what the RUNNING ROUTER says ───────────────────────────────────────
let liveItems: any[] = [];
let liveErr = "";
try {
  const res = await fetch("http://127.0.0.1:8787/api/needs-you", { signal: AbortSignal.timeout(15000) });
  const j = (await res.json()) as { needsYou?: any[] };
  liveItems = j.needsYou ?? [];
} catch (e) {
  liveErr = String(e).slice(0, 120);
}
const routerView = (id: string) => {
  const i = liveItems.find((n) => n.id === `fleet:${id}`);
  return { kind: i?.kind, question: i?.question, actions: (i?.actions ?? []).map((a: any) => a.id) };
};

console.log(`live API: ${liveItems.length} items${liveErr ? ` (ERROR: ${liveErr})` : ""}`);
console.log(`working tree: ${failedOpen.length} open failed orders\n`);

let seenOld = 0;
let seenNew = 0;
let mismatched = 0;
for (const o of failedOpen) {
  const r = routerView(o.id);
  const t = treeView(o.id);
  const same = JSON.stringify(r) === JSON.stringify(t);
  if (!same) mismatched++;
  if (r.question === "Retry this order or drop it?") seenOld++;
  if (r.question === briefingCode.CLAUDE_SIGNIN_EXPIRED_MESSAGE) seenNew++;
  console.log(`${o.id}  identical=${same}`);
  console.log(`   router  : ${JSON.stringify(r)}`);
  console.log(`   tree    : ${JSON.stringify(t)}`);
}

console.log("");
console.log(`router serving the OLD retry/drop prompt : ${seenOld}/${failedOpen.length}`);
console.log(`router serving the NEW sign-in sentence  : ${seenNew}/${failedOpen.length}`);
console.log(`router vs tree mismatches                : ${mismatched}`);
console.log(
  mismatched === 0 && seenOld === failedOpen.length
    ? "\nCONCLUSION: the running router serves exactly what the working tree serves for these records,\nand that is the OLD retry/drop prompt - i.e. the live process has NOT picked up the fix.\n(The stale records keep retry/drop by design; only NEW runs get the sign-in sentence.)"
    : "\nCONCLUSION: unexpected - the router and the tree disagree; investigate before claiming anything.",
);
