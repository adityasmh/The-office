// Offline check for src/routingPolicy.ts and for the routing/*.example.json samples.
// Run: npx tsx ops/routing-policy-check.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_ROUTING_POLICY, loadRoutingPolicy, parseRoutingPolicy, routingPolicyPath } from "../src/routingPolicy.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routing-check-"));

// no file -> defaults
assert.deepEqual(loadRoutingPolicy(dir, {}), DEFAULT_ROUTING_POLICY);

// partial file merges over the defaults
const merged = parseRoutingPolicy({ gateway: { baseUrl: "https://gw.example/v1", keyEnv: "MY_KEY" }, tiers: { standard: "my-model" } });
assert.equal(merged.gateway.baseUrl, "https://gw.example/v1");
assert.equal(merged.gateway.keyEnv, "MY_KEY");
assert.equal(merged.tiers.standard, "my-model");
assert.equal(merged.tiers.routine, DEFAULT_ROUTING_POLICY.tiers.routine, "untouched fields keep the default");
assert.deepEqual(merged.allowedFamilies, DEFAULT_ROUTING_POLICY.allowedFamilies);

// allowedFamilies are lower-cased and trimmed; bad shapes throw
assert.deepEqual(parseRoutingPolicy({ allowedFamilies: [" GPT ", "o3"] }).allowedFamilies, ["gpt", "o3"]);
assert.throws(() => parseRoutingPolicy({ allowedFamilies: "gpt" }), /array of strings/);
assert.throws(() => parseRoutingPolicy({ direct: { peakUtcBlocks: [[5, 2]] } }), /from < to/);
assert.throws(() => parseRoutingPolicy([]), /JSON object/);

// file on disk, env override of the file name, malformed file falls back with a warning
fs.writeFileSync(path.join(dir, "routing.policy.json"), JSON.stringify({ tiers: { routine: "from-file" } }));
assert.equal(loadRoutingPolicy(dir, {}).tiers.routine, "from-file");
fs.writeFileSync(path.join(dir, "alt.json"), JSON.stringify({ tiers: { routine: "from-alt" } }));
assert.equal(loadRoutingPolicy(dir, { ROUTING_POLICY_FILE: "alt.json" }).tiers.routine, "from-alt");
assert.equal(routingPolicyPath(dir, { ROUTING_POLICY_FILE: "alt.json" }), path.join(dir, "alt.json"));
fs.writeFileSync(path.join(dir, "routing.policy.json"), "{broken");
assert.deepEqual(loadRoutingPolicy(dir, {}), DEFAULT_ROUTING_POLICY);

// every shipped sample parses, and the opencode-go sample equals the built-in defaults
const samples = fs.readdirSync(path.join(process.cwd(), "routing")).filter((f) => f.endsWith(".example.json"));
assert.ok(samples.length >= 3, "ships at least three sample policies");
for (const f of samples) {
  const p = parseRoutingPolicy(JSON.parse(fs.readFileSync(path.join(process.cwd(), "routing", f), "utf8")));
  assert.ok(p.gateway.baseUrl.startsWith("http"), `${f}: gateway.baseUrl`);
  assert.ok(p.allowedFamilies.length > 0, `${f}: allowedFamilies`);
}
const goSample = parseRoutingPolicy(JSON.parse(fs.readFileSync(path.join(process.cwd(), "routing", "opencode-go.example.json"), "utf8")));
assert.deepEqual(goSample, DEFAULT_ROUTING_POLICY);

fs.rmSync(dir, { recursive: true, force: true });
console.log("PASS routing-policy-check");
