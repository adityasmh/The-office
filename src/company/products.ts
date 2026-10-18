// products.ts - "products" are the repos the office builds and runs. The office knows nothing about their
// insides: it only reads products.json, which says where each product lives, how to start it, and how to
// tell it is healthy. Leadscout is just one example entry (see products.example.json).
//
// products.json (repo root, or the file named by PRODUCTS_FILE):
//   { "products": [ {
//       "id": "leadscout",                      // lowercase, digits, hyphens
//       "name": "Leadscout",
//       "path": "../Leadscout",                 // the product's git repo (relative to this repo, or absolute)
//       "description": "optional one-liner",
//       "start":  { "command": "npm start", "port": 8790, "healthUrl": "http://127.0.0.1:8790/api/health" },
//       "checks": [ "npm run typecheck", "npm run check:all" ],   // the product's own quality gate
//       "env":    [ "OPTIONAL_VAR_NAMES_IT_NEEDS" ]               // names only, never values
//   } ] }
//
// The office never starts a product by itself from this file: `start` is information for operators and for
// work orders ("how do I run this to verify my change?"). Health probing is a plain GET with a short timeout.
// Node built-ins only. Never throws to the caller.
import fs from "node:fs";
import path from "node:path";

export const PRODUCTS_FILE = "products.json";

export type Product = {
  id: string;
  name: string;
  path: string; // absolute, resolved
  description: string;
  start?: { command: string; port?: number; healthUrl?: string };
  checks: string[];
  env: string[];
};

export type ProductHealth = { id: string; ok: boolean | null; status?: number; ms?: number; why: string };

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Validate a parsed products.json and resolve paths against `baseDir`. Throws a plain Error on a wrong shape. */
export function parseProducts(input: unknown, baseDir: string): Product[] {
  if (!isObj(input) || !Array.isArray(input.products)) throw new Error('products.json must be {"products": [...]}');
  const seen = new Set<string>();
  const out: Product[] = [];
  for (const [i, raw] of input.products.entries()) {
    if (!isObj(raw)) throw new Error(`products[${i}] must be an object`);
    const id = String(raw.id ?? "");
    if (!ID_RE.test(id)) throw new Error(`products[${i}].id must be lowercase letters, digits and hyphens`);
    if (seen.has(id)) throw new Error(`duplicate product id "${id}"`);
    seen.add(id);
    if (typeof raw.path !== "string" || raw.path.trim() === "") throw new Error(`products[${i}].path is required`);
    const strings = (v: unknown, label: string): string[] => {
      if (v === undefined) return [];
      if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) throw new Error(`products[${i}].${label} must be an array of strings`);
      return v as string[];
    };
    let start: Product["start"];
    if (raw.start !== undefined) {
      if (!isObj(raw.start) || typeof raw.start.command !== "string") throw new Error(`products[${i}].start.command is required`);
      start = { command: raw.start.command };
      if (typeof raw.start.port === "number") start.port = raw.start.port;
      if (typeof raw.start.healthUrl === "string") {
        if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(raw.start.healthUrl)) {
          throw new Error(`products[${i}].start.healthUrl must point at localhost (the office only probes local services)`);
        }
        start.healthUrl = raw.start.healthUrl;
      }
    }
    out.push({
      id,
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id,
      path: path.resolve(baseDir, raw.path),
      description: typeof raw.description === "string" ? raw.description : "",
      ...(start ? { start } : {}),
      checks: strings(raw.checks, "checks"),
      env: strings(raw.env, "env"),
    });
  }
  return out;
}

/** The configured products. Missing file = no products (normal). A bad file warns once and yields none. */
export function loadProducts(dir: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): Product[] {
  const override = String(env.PRODUCTS_FILE ?? "").trim();
  const file = override ? path.resolve(dir, override) : path.join(dir, PRODUCTS_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  try {
    return parseProducts(JSON.parse(raw), path.dirname(file));
  } catch (e) {
    console.warn(`[products] ${path.basename(file)} is invalid (${(e instanceof Error ? e.message : String(e)).slice(0, 160)}): no products loaded`);
    return [];
  }
}

/** One short GET against the product's healthUrl. ok=null means "no health URL configured". */
export async function probeProduct(p: Product, fetchFn: typeof fetch = fetch, timeoutMs = 2000): Promise<ProductHealth> {
  const url = p.start?.healthUrl;
  if (!url) return { id: p.id, ok: null, why: "no healthUrl configured" };
  const started = Date.now();
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { id: p.id, ok: res.ok, status: res.status, ms: Date.now() - started, why: res.ok ? "healthy" : `HTTP ${res.status}` };
  } catch (e) {
    return { id: p.id, ok: false, ms: Date.now() - started, why: `not reachable: ${(e instanceof Error ? e.message : String(e)).slice(0, 100)}` };
  }
}

/** Does the product's folder exist and look like a git repo? Used by `GET /company/products`. */
export function productRepoState(p: Product): { exists: boolean; isGit: boolean } {
  try {
    const exists = fs.statSync(p.path).isDirectory();
    return { exists, isGit: exists && fs.existsSync(path.join(p.path, ".git")) };
  } catch {
    return { exists: false, isGit: false };
  }
}
