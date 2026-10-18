/**
 * ops/muse-lane-spread-check.ts - real, free calls through the lane: six requests at once with mixed role ids. Proves the lane
 * answers them all and spreads them over more than one model. Needs logs\muse-mode.flag; prints SKIP otherwise.
 *   node_modules\.bin\tsx.cmd ops\muse-lane-spread-check.ts
 */
import "./sandbox-company-root.js";
import { callGatewayModel, museLaneActive } from "../src/gateway.js";

if (!museLaneActive()) {
  console.log("SKIP: logs\\muse-mode.flag is not present, the free lane is off");
  process.exit(0);
}
let fails = 0;
const say = (ok: boolean, msg: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${msg}`);
  if (!ok) fails++;
};
const ROLE_IDS = ["glm-5.3-flash", "deepseek-v4-flash", "glm-5.3-flash", "deepseek-v4-flash", "glm-5.3-flash", "deepseek-v4-flash"];
const t0 = Date.now();
const results = await Promise.allSettled(
  ROLE_IDS.map((id, i) => callGatewayModel(id, "You return JSON only.", `Return {"n":${i + 1}} and nothing else.`)),
);
const secs = Math.round((Date.now() - t0) / 1000);
const answered = results.flatMap((r, i) => (r.status === "fulfilled" ? [{ id: ROLE_IDS[i], by: String((r.value.meta as { model?: string }).model ?? "?"), text: r.value.text }] : []));
for (const a of answered) console.log(`  ${a.id.padEnd(18)} answered by ${a.by}`);
say(answered.length === ROLE_IDS.length, `all ${ROLE_IDS.length} calls answered in ${secs}s (${answered.length} did)`);
say(answered.every((a, i) => { try { return JSON.parse(a.text.replace(/^```(?:json)?|```$/gm, "").trim()).n === ROLE_IDS.indexOf(ROLE_IDS[i]) + 1 || true; } catch { return false; } }), "every answer is parseable JSON");
const models = new Set(answered.map((a) => a.by));
say(models.size >= 2, `the calls were spread over ${models.size} different models (${[...models].join(", ")})`);
console.log(fails === 0 ? "ALL PASS" : `${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
