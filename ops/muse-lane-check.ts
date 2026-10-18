/**
 * ops/muse-lane-check.ts - proof that router-side steps can run on the free Muse model through the real opencode client.
 * One real (free) call, no paid provider is touched. Needs logs\muse-mode.flag to exist (Muse mode); prints SKIP otherwise.
 *   node_modules\.bin\tsx.cmd ops\muse-lane-check.ts
 */
import "./sandbox-company-root.js";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { callGatewayModel, museLaneActive } from "../src/gateway.js";

let fails = 0;
const say = (ok: boolean, msg: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${msg}`);
  if (!ok) fails++;
};
const laneDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith("muse-lane-")).length;

if (!museLaneActive()) {
  console.log("SKIP: logs\\muse-mode.flag is not present, the Muse lane is off");
  process.exit(0);
}
const before = laneDirs();
const t0 = Date.now();
const r = await callGatewayModel("glm-5.3-flash", "You return JSON only.", 'Return {"a":7,"b":"ok"} and nothing else.');
const secs = Math.round((Date.now() - t0) / 1000);
const answeredBy = String((r.meta as { model?: string }).model ?? "unknown");
say(typeof r.text === "string" && r.text.length > 0, `got text from the free lane in ${secs}s (answered by ${answeredBy})`);
let parsed: { a?: number; b?: string } = {};
try {
  parsed = JSON.parse(r.text.replace(/^```(?:json)?|```$/gm, "").trim());
} catch {
  /* handled below */
}
say(parsed.a === 7 && parsed.b === "ok", `the answer is the JSON that was asked for (${r.text.slice(0, 60).replace(/\s+/g, " ")})`);
say(laneDirs() === before, "temp folder is cleaned up after the call");
console.log(fails === 0 ? "ALL PASS" : `${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
