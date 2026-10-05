#!/usr/bin/env node
/**
 * ops/new-order-check.ts - proof for order F07-order-templates (2026-10-06).
 *
 * Runs the REAL ops/new-order.ts as a child process: against the five real
 * templates in orders/templates, against probe templates written in a temp
 * folder, and against a local stub HTTP server for --post. The router is never
 * started and there are no calls off 127.0.0.1. COMPANY_AUTH_TOKEN here is a
 * FAKE value; the repository .env is never opened.
 *
 *   npx tsx ops/new-order-check.ts
 *
 * Prints PASS or FAIL per line; exit code is 1 if any line is FAIL.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HARNESS_DIR, "..");
const TEMPLATE_DIR = path.join(REPO_ROOT, "orders", "templates");
const FAKE_TOKEN = "new_order_check_fake_token_7a3f";
const NEW_ORDER_ID = "foNEWORDER1";
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "new-order-check-"));

const TEMPLATE_NAMES = ["add-docs-section", "fix-small-bug", "add-unit-check", "small-refactor", "update-readme-status"];
const REQUIRED_FIELDS = ["file", "change", "check"];

// The rejected loop-word, spelled from its character codes so this file never
// contains it. BANNED_TERMS mirrors the list in ops/new-order.ts.
const LOOP_PREFIX = String.fromCharCode(104, 111, 108);
const LOOP_WORD = `${LOOP_PREFIX}d`;

// Probe lines for the lint, one banned term each, with the line number the
// probe template gives them (header = 1, blank = 2, probes = 3..). One term is
// written in capitals to prove the match is case-insensitive; the loop-word
// case carries the word in the line and expects the prefix in the report.
const LINT_PROBES: Array<{ label: string; reported: string; line: number; text: string }> = [
  { label: '"wait"', reported: "wait", line: 3, text: "please wait before reporting" },
  { label: '"poll"', reported: "poll", line: 4, text: "please POLL before reporting" },
  { label: '"periodically"', reported: "periodically", line: 5, text: "please periodically report" },
  { label: '"keep checking"', reported: "keep checking", line: 6, text: "please keep checking the logs" },
  { label: "the loop-word prefix", reported: LOOP_PREFIX, line: 7, text: `please ${LOOP_WORD} before reporting` },
];

const allOutputs: string[] = [];

const FIELD_RE = /\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

function templateFields(text: string): string[] {
  const seen: string[] = [];
  for (const m of text.matchAll(FIELD_RE)) {
    const name = m[1] as string;
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

const q = (s: string): string => `"${s}"`;

// -- the stub server ---------------------------------------------------------

type Rec = { method: string; path: string; token: string | null; body: string };
const requests: Rec[] = [];

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const method = req.method ?? "GET";
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const token = (req.headers["x-company-token"] as string | undefined) ?? null;
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({ method, path: pathname, token, body });

    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (method === "POST" && pathname === "/company/fleet/orders") {
      return send(200, { id: NEW_ORDER_ID, status: "planning", text: body });
    }
    return send(404, { error: "not found" });
  });
});

const base = await new Promise<string>((resolve) => {
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as AddressInfo).port;
    resolve(`http://127.0.0.1:${port}`);
  });
});

// -- running the real CLI ----------------------------------------------------

function runOrder(args: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(`npx tsx ops/new-order.ts ${args}`, [], {
      cwd: REPO_ROOT,
      shell: true,
      windowsHide: true,
      env: { ...process.env, FLEET_URL: base, COMPANY_AUTH_TOKEN: FAKE_TOKEN },
    });
    let out = "";
    let settled = false;
    const timer = setTimeout(() => child.kill(), 180_000);
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      allOutputs.push(out);
      resolve({ code, out });
    };
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
    child.on("close", (code) => finish(code ?? -1));
    child.on("error", () => finish(-1));
  });
}

// -- checks ------------------------------------------------------------------

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? `  -> ${detail}` : ""}`);
}

function setArgs(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([k, v]) => `--set ${k}=${q(v)}`)
    .join(" ");
}

async function main(): Promise<void> {
  // 1. every real template renders with its fields --------------------------
  for (const name of TEMPLATE_NAMES) {
    const text = fs.readFileSync(path.join(TEMPLATE_DIR, `${name}.md`), "utf8");
    const fields = templateFields(text);
    const values: Record<string, string> = {};
    for (const f of fields) values[f] = `value-${f}`;
    const r = await runOrder(`${name} ${setArgs(values)} --print`);
    const ok =
      r.code === 0 &&
      REQUIRED_FIELDS.every((f) => fields.includes(f)) &&
      fields.length > 0 &&
      fields.every((f) => r.out.includes(values[f] as string)) &&
      !r.out.includes("{{") &&
      /print the final report and END your turn/i.test(r.out);
    check(`${name} renders with its template fields and ends the turn`, ok, `exit=${r.code}; fields=${fields.join(",")}`);
  }

  // 2. a missing field errors by name --------------------------------------
  const raw = fs.readFileSync(path.join(TEMPLATE_DIR, "add-docs-section.md"), "utf8");
  const partial = templateFields(raw).filter((f) => f !== "check");
  const partialValues: Record<string, string> = {};
  for (const f of partial) partialValues[f] = `value-${f}`;
  const missing = await runOrder(`add-docs-section ${setArgs(partialValues)} --print`);
  check(
    "a missing template field errors by name",
    missing.code === 1 && /missing template field/i.test(missing.out) && missing.out.includes('"check"'),
    `exit=${missing.code}`,
  );

  // 3. the lint rejects every banned term with its line number ---------------
  const probePath = path.join(TEMP, "lint-probe.md");
  fs.writeFileSync(probePath, `# Order: lint probe\n\n${LINT_PROBES.map((p) => p.text).join("\n")}\n`, "utf8");
  const probe = await runOrder(`${q(probePath)} --print`);
  check("the lint rejects a template with banned words and exits 1", probe.code === 1 && /lint rejected/.test(probe.out), `exit=${probe.code}`);
  for (const p of LINT_PROBES) {
    const needle = `line ${p.line} contains "${p.reported}"`;
    check(`the lint rejects ${p.label} with line ${p.line}`, probe.out.toLowerCase().includes(needle), "");
  }

  // 4. a clean order passes and is printed by default ------------------------
  const cleanPath = path.join(TEMP, "clean.md");
  const cleanBody = "# Order: rename one variable\n\nRename `oldName` to `newName` in `src/example.ts`.\n\nPrint the final report and END your turn.\n";
  fs.writeFileSync(cleanPath, cleanBody, "utf8");
  const clean = await runOrder(`${q(cleanPath)}`);
  check(
    "a clean order passes the lint and is printed by default",
    clean.code === 0 && clean.out.includes("rename one variable") && clean.out.includes("oldName"),
    `exit=${clean.code}`,
  );

  // 4b. --out writes the rendered order to a file --------------------------
  const outPath = path.join(TEMP, "out", "order.md");
  const out = await runOrder(`${q(cleanPath)} --out ${q(outPath)}`);
  const written = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : "";
  check(
    "--out writes the rendered order to a file",
    out.code === 0 && written === cleanBody && /wrote /.test(out.out),
    `exit=${out.code}; bytes=${written.length}`,
  );

  // 5. --post sends the right JSON, token in the header only -----------------
  const postPath = path.join(TEMP, "post.md");
  const postBody = "# Order: post probe\n\nChange one line in `src/example.ts`.\n\nPrint the final report and END your turn.\n";
  fs.writeFileSync(postPath, postBody, "utf8");
  const before = requests.length;
  const posted = await runOrder(`${q(postPath)} --post`);
  const sent = requests.slice(before).find((r) => r.method === "POST" && r.path === "/company/fleet/orders");
  let sentText = "";
  let parsed = false;
  try {
    const j = JSON.parse(sent?.body ?? "{}") as { text?: unknown };
    parsed = typeof j.text === "string";
    sentText = String(j.text ?? "");
  } catch {
    parsed = false;
  }
  check(
    "--post sends the rendered order text as JSON",
    posted.code === 0 && parsed && sentText === postBody && posted.out.includes(NEW_ORDER_ID),
    `exit=${posted.code}; text matches=${sentText === postBody}`,
  );
  check(
    "--post sends the token only in the x-company-token header",
    sent?.token === FAKE_TOKEN && !(sent?.body ?? "").includes(FAKE_TOKEN) && !posted.out.includes(FAKE_TOKEN),
    `header ok=${sent?.token === FAKE_TOKEN}; body/output clean=${!(sent?.body ?? "").includes(FAKE_TOKEN) && !posted.out.includes(FAKE_TOKEN)}`,
  );

  // 6. the token never appears in any output --------------------------------
  const leaking = allOutputs.filter((o) => o.includes(FAKE_TOKEN));
  check("the token value never appears in any output", leaking.length === 0, `checked ${allOutputs.length} outputs`);
}

try {
  await main();
} catch (e) {
  check("harness completed without throwing", false, String(e instanceof Error ? e.message : e));
} finally {
  server.close();
  fs.rmSync(TEMP, { recursive: true, force: true });
}

console.log(failures === 0 ? "new-order-check: all checks passed" : `new-order-check: ${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
