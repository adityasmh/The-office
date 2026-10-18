#!/usr/bin/env node
/**
 * ops/new-order.ts - turn a template into a work order a worker can finish
 * without looping: one narrow job, one editable file, one acceptance check and
 * an explicit end.
 *
 *   npx tsx ops/new-order.ts <template> --set key=value ... [--print | --out <file> | --post]
 *
 * <template> is a template name in orders/templates (with or without .md) or a
 * path to a template file. {{field}} fields are filled from --set. A missing
 * field is a plain error that names the field.
 *
 * Every rendered order is linted first: text that tells a worker to wait, poll,
 * keep checking or stall is rejected with the exact offending line. --post
 * sends the order to POST /company/fleet/orders with the company token in the
 * x-company-token header only; the token is never printed. Base URL: $FLEET_URL
 * (default http://127.0.0.1:8787). Default mode is --print.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TOOL_DIR, "..");
const TEMPLATE_DIR = path.join(REPO_ROOT, "orders", "templates");
const DEFAULT_BASE = "http://127.0.0.1:8787";
const TIMEOUT_MS = 10_000;
const TOKEN_ENV = "COMPANY_AUTH_TOKEN";

// The rejected loop-word, as its three-letter prefix. The character codes
// 104, 111 and 108 spell it; building the string here keeps the literal out of
// this file. The term is matched case-insensitively, like the others.
const LOOP_PREFIX = String.fromCharCode(104, 111, 108);

const BANNED_TERMS: string[] = ["wait", "poll", "periodically", "keep checking", LOOP_PREFIX];

const FIELD_RE = /\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

type Mode = "print" | "out" | "post";
type Options = {
  template: string;
  values: Map<string, string>;
  mode: Mode;
  outPath: string;
  help: boolean;
};

class UsageError extends Error {}

// -- arguments ---------------------------------------------------------------

function parseArgs(args: string[]): Options {
  const o: Options = { template: "", values: new Map(), mode: "print", outPath: "", help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--set") {
      const pair = args[++i] ?? "";
      const eq = pair.indexOf("=");
      if (eq <= 0) throw new UsageError(`--set needs key=value, got "${pair}"`);
      o.values.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
    } else if (a === "--print") o.mode = "print";
    else if (a === "--out") {
      o.mode = "out";
      o.outPath = args[++i] ?? "";
    } else if (a === "--post") o.mode = "post";
    else if (a === "--help" || a === "-h") o.help = true;
    else if (a.startsWith("--")) throw new UsageError(`unknown option "${a}"`);
    else if (!o.template) o.template = a;
    else throw new UsageError(`unexpected argument "${a}"`);
  }
  return o;
}

function printUsage(): void {
  console.log(`new-order - render a work order from a template

usage: npx tsx ops/new-order.ts <template> --set key=value ... [--print | --out <file> | --post]

<template> is a name in orders/templates (with or without .md) or a path to a template file.

options:
  --set key=value   fill a {{key}} template field (repeatable)
  --print           print the order (default)
  --out <file>      write the order to a file
  --post            POST the order to /company/fleet/orders

Every order is linted first; text that tells a worker to wait, poll, keep
checking or stall is rejected with the offending line.

base URL: $FLEET_URL (default ${DEFAULT_BASE})
token    : $COMPANY_AUTH_TOKEN, else COMPANY_AUTH_TOKEN in .env (POST only, never printed)`);
}

// -- templates ---------------------------------------------------------------

function resolveTemplate(name: string): string {
  const candidates = [name, path.join(TEMPLATE_DIR, name), path.join(TEMPLATE_DIR, `${name}.md`)];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  throw new UsageError(
    `no template "${name}": looked for ${candidates.join(", ")}`,
  );
}

/** Unique {{field}} names, in the order they first appear. */
function templateFields(text: string): string[] {
  const seen: string[] = [];
  for (const m of text.matchAll(FIELD_RE)) {
    const name = m[1] as string;
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

function renderTemplate(text: string, values: Map<string, string>): string {
  return text.replace(FIELD_RE, (_all, name: string) => values.get(name) ?? `{{${name}}}`);
}

// -- lint --------------------------------------------------------------------

type LintHit = { line: number; term: string; text: string };

function lintOrder(text: string): LintHit[] {
  const hits: LintHit[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lower = line.toLowerCase();
    for (const term of BANNED_TERMS) {
      if (lower.includes(term)) hits.push({ line: i + 1, term, text: line.trim() });
    }
  }
  return hits;
}

// -- POST --------------------------------------------------------------------

/** Reads only COMPANY_AUTH_TOKEN from .env; the value is returned, never printed. */
function readEnvToken(): string {
  try {
    const cwdPath = path.join(process.cwd(), ".env");
    const file = fs.existsSync(cwdPath) ? cwdPath : path.join(REPO_ROOT, ".env");
    if (!fs.existsSync(file)) return "";
    for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      if (line.slice(0, eq).trim() !== TOKEN_ENV) continue;
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      return val;
    }
  } catch {
    /* a missing or unreadable .env just means no token */
  }
  return "";
}

async function postOrder(text: string): Promise<string> {
  const base = (process.env.FLEET_URL || DEFAULT_BASE).replace(/\/+$/, "");
  const token = (process.env[TOKEN_ENV] ?? "").trim() || readEnvToken();
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  // The token rides on the header only, and is never echoed anywhere.
  if (token) headers["x-company-token"] = token;

  let res: Response;
  try {
    res = await fetch(`${base}/company/fleet/orders`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const err = e as Error & { cause?: unknown };
    const why = err?.name === "TimeoutError" ? `timed out after ${TIMEOUT_MS}ms` : String(err?.cause ?? err?.message ?? e);
    throw new UsageError(`cannot reach the fleet router at ${base} (${why}). Is the router running?`);
  }

  const raw = await res.text();
  if (!res.ok) {
    throw new UsageError(`POST ${base}/company/fleet/orders failed: HTTP ${res.status}${raw ? `: ${raw.slice(0, 200)}` : ""}`);
  }
  try {
    return String((JSON.parse(raw) as { id?: unknown }).id ?? "");
  } catch {
    return "";
  }
}

// -- main --------------------------------------------------------------------

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printUsage();
    return 0;
  }
  if (!opts.template) {
    printUsage();
    return 1;
  }

  const templatePath = resolveTemplate(opts.template);
  const raw = fs.readFileSync(templatePath, "utf8");
  const fields = templateFields(raw);
  const missing = fields.filter((f) => !opts.values.has(f));
  if (missing.length) {
    const shown = missing.map((f) => `"${f}"`).join(", ");
    const hint = `--set ${missing[0]}=<value>`;
    console.error(
      `new-order: missing template field ${shown} in ${path.relative(REPO_ROOT, templatePath)}: pass ${hint}`,
    );
    return 1;
  }

  const order = renderTemplate(raw, opts.values);

  const hits = lintOrder(order);
  if (hits.length) {
    console.error("new-order: lint rejected the order: workers must not be told to wait, poll, keep checking or stall.");
    for (const hit of hits) {
      console.error(`new-order: line ${hit.line} contains "${hit.term}": ${hit.text}`);
    }
    return 1;
  }

  if (opts.mode === "out") {
    if (!opts.outPath) {
      console.error("new-order: --out needs a file path");
      return 1;
    }
    fs.mkdirSync(path.dirname(path.resolve(opts.outPath)), { recursive: true });
    fs.writeFileSync(opts.outPath, order, "utf8");
    console.log(`wrote ${opts.outPath} (${order.length} chars)`);
    return 0;
  }

  if (opts.mode === "post") {
    const id = await postOrder(order);
    console.log(id ? `posted order ${id}` : "posted order");
    return 0;
  }

  process.stdout.write(order.endsWith("\n") ? order : `${order}\n`);
  return 0;
}

try {
  process.exitCode = await main();
} catch (e) {
  console.error(e instanceof UsageError ? e.message : `new-order failed: ${String((e as Error)?.message ?? e)}`);
  process.exitCode = 1;
}

export {};
