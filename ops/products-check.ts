// Offline check for src/company/products.ts: parsing, validation, path resolution, health probing with a fake fetch.
// Run: npx tsx ops/products-check.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadProducts, parseProducts, probeProduct, productRepoState } from "../src/company/products.js";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "products-check-"));
const example = JSON.parse(fs.readFileSync(path.join(process.cwd(), "products.example.json"), "utf8"));

// the shipped example parses and resolves relative paths against the file's folder
const parsed = parseProducts(example, base);
assert.equal(parsed.length, 2);
assert.equal(parsed[0]!.id, "leadscout");
assert.equal(parsed[0]!.path, path.resolve(base, "../leadscout"));
assert.deepEqual(parsed[0]!.checks, ["npm run typecheck", "npm run check:env", "npm run check:all"]);

// validation
assert.throws(() => parseProducts({}, base), /products/);
assert.throws(() => parseProducts({ products: [{ id: "Bad Id", path: "x" }] }, base), /id must be/);
assert.throws(() => parseProducts({ products: [{ id: "a", path: "x" }, { id: "a", path: "y" }] }, base), /duplicate/);
assert.throws(() => parseProducts({ products: [{ id: "a" }] }, base), /path is required/);
assert.throws(
  () => parseProducts({ products: [{ id: "a", path: "x", start: { command: "run", healthUrl: "http://example.com/health" } }] }, base),
  /localhost/,
);

// loadProducts: missing file = none; bad file = none (warns); good file = parsed; PRODUCTS_FILE override works
assert.deepEqual(loadProducts(base, {}), []);
fs.writeFileSync(path.join(base, "products.json"), "{not json");
assert.deepEqual(loadProducts(base, {}), []);
fs.writeFileSync(path.join(base, "products.json"), JSON.stringify(example));
assert.equal(loadProducts(base, {}).length, 2);
fs.writeFileSync(path.join(base, "other.json"), JSON.stringify({ products: [{ id: "solo", path: "." }] }));
assert.equal(loadProducts(base, { PRODUCTS_FILE: "other.json" })[0]!.id, "solo");

// probing with an injected fetch
const ok = (async () => new Response("ok", { status: 200 })) as typeof fetch;
const down = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
assert.equal((await probeProduct(parsed[0]!, ok)).ok, true);
const refused = await probeProduct(parsed[0]!, down);
assert.equal(refused.ok, false);
assert.match(refused.why, /not reachable/);
assert.equal((await probeProduct({ ...parsed[0]!, start: undefined }, ok)).ok, null);

// repo state
assert.deepEqual(productRepoState({ ...parsed[0]!, path: path.join(base, "nope") }), { exists: false, isGit: false });
assert.equal(productRepoState({ ...parsed[0]!, path: base }).exists, true);

fs.rmSync(base, { recursive: true, force: true });
console.log("PASS products-check");
