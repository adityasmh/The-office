/**
 * ops/fleet-live-signin-preview.ts — "what WOULD the CEO see" for the ORDERS ALREADY ON DISK,
 * evaluated with the NEW code, without touching the live company.
 *
 * This is the CEO-visible acceptance question for the existing backlog: the six orders whose
 * prompts were "Retry this order or drop it?" before the fix. It copies the live orders.json
 * into a throwaway COMPANY_ROOT (read-only w.r.t. the live file) and asks the real
 * run-manager + briefing code what each order's prompt becomes.
 *
 *   npx tsx ops/fleet-live-signin-preview.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const live = path.join(process.cwd(), "company", "fleet", "orders.json");
if (!fs.existsSync(live)) {
  console.log("no live orders.json; nothing to preview");
  process.exit(0);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-live-preview-"));
process.env.COMPANY_ROOT = path.join(tmp, "company");
process.env.MOCK_MODE = "1";
fs.mkdirSync(path.join(process.env.COMPANY_ROOT, "fleet"), { recursive: true });
// A read-only COPY: the live company/fleet/orders.json is never opened for writing.
const orders = JSON.parse(fs.readFileSync(live, "utf8")) as any[];
fs.writeFileSync(path.join(process.env.COMPANY_ROOT, "fleet", "orders.json"), JSON.stringify(orders));

const runManagers = await import("../src/company/runManagers.js");
const briefing = await import("../src/company/briefing.js");
const cards = runManagers.listRunCards();
const b = briefing.composeBriefing(cards, { seenAt: new Date(0).toISOString(), summary: "(preview)", model: "local" });

const failed = orders.filter((o) => o.status === "failed" && !o.closedAs && !o.supersededBy && o.status !== "cancelled");
console.log(`live orders: ${orders.length} | failed & open: ${failed.length}`);
console.log("");
for (const o of failed) {
  const item = b.needsYou.find((n: any) => n.runId === `fleet:${o.id}`);
  const mentionsSignIn = /failed to authenticate|oauth session expired|could not be refreshed|credentials not found|no claudeaioauth block|claude \/?login/i.test(String(o.error ?? ""));
  console.log(`${o.id}`);
  console.log(`  error        : ${JSON.stringify(String(o.error ?? "").slice(0, 100))}`);
  console.log(`  error says sign-in expired: ${mentionsSignIn}`);
  console.log(`  prompt now   : ${JSON.stringify(item?.question ?? "(not offered)")}`);
  console.log(`  buttons      : ${JSON.stringify((item?.actions ?? []).map((a: any) => a.label))}`);
}
console.log("");
console.log(`prompts still offering BOTH retry and drop: ${failed.filter((o) => {
  const i = b.needsYou.find((n: any) => n.runId === `fleet:${o.id}`);
  return (i?.actions ?? []).length === 2;
}).length}`);
console.log(`prompts showing the plain sign-in sentence: ${failed.filter((o) => {
  const i = b.needsYou.find((n: any) => n.runId === `fleet:${o.id}`);
  return /sign-in expired/i.test(String(i?.question ?? ""));
}).length}`);
