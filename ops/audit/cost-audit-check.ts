#!/usr/bin/env node
/**
 * ops/audit/cost-audit-check.ts - proof for order B1-audit-tool (docs/overnight/ORDER_B1-audit-tool.md,
 * 2026-10-06).
 *
 * Runs the REAL audit code (ops/audit/cost-audit.ts) against CSV fixtures built in a TEMPORARY
 * folder under the OS temp dir, and spawns the real CLI for the cases that must be judged by exit
 * code (a missing column, refused example prices, the bundled sample, --out/--html). Every date is
 * fixed, so no check depends on the wall clock. No network calls; the temp folders are removed at
 * the end.
 *
 *   npx tsx ops/audit/cost-audit-check.ts
 *
 * PASS or FAIL per line; exit code 1 if any line is FAIL.
 *
 * Hand-computed fixture "main.csv" (20 rows, 5 days):
 *   gpt-4o       8 rows  in 207,000  out 4,500  $9.50
 *   gpt-4o-mini  4 rows  in   4,000  out   400  $0.80
 *   claude       8 rows  in   8,000  out 1,600  $2.40
 *   totals: 20 rows, in 219,000, out 6,500, 225,500 tokens, $12.70
 *   by day: 10-01 $2.00, 10-02 $0.80, 10-03 $1.20, 10-04 $1.20, 10-05 $7.50; median day $1.20
 *   spike: 10-05 only ($7.50 = 6.25x). 95th percentile input is 1,000 (19 rows sit at 1,000, one
 *   row is 200,000): that one row holds $6.00, which is 47.24% of spend and 5% of rows.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLOSING_LINE,
  buildAudit,
  buildRows,
  parseCsv,
  renderHtml,
  renderMarkdown,
  resolveColumns,
  type Audit,
  type ColumnMap,
} from "./cost-audit.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const SAMPLE = path.join("ops", "audit", "sample", "usage-sample-FAKE.csv");
const EXAMPLE_PRICES = path.join("ops", "audit", "prices.example.json");
const CLI = path.join("ops", "audit", "cost-audit.ts");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? `  -> ${detail}` : ""}`);
}

const CLOSE = 1e-9;
const close = (a: number, b: number): boolean => Math.abs(a - b) < CLOSE;

const tempDirs: string[] = [];
function mktemp(tag: string, files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cost-audit-check-${tag}-`));
  tempDirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), text, "utf8");
  }
  return dir;
}

/** Spawn the real CLI once. Paths are quoted because the repo root contains a space. */
function cli(args: string[]): { status: number; stdout: string; stderr: string } {
  const quote = (s: string): string => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  const cmd = ["npx", "--no-install", "tsx", quote(CLI), ...args.map(quote)].join(" ");
  const r = spawnSync(cmd, { cwd: REPO_ROOT, encoding: "utf8", shell: true, env: { ...process.env, NO_COLOR: "1" } });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

interface Built {
  audit: Audit;
  skipped: number;
  fields: ColumnMap;
}

/** Run the real pure code over CSV text, exactly as the CLI does. */
function auditOf(text: string, options: { maps?: ColumnMap; source?: string } = {}): Built {
  const table = parseCsv(text);
  const header = table[0];
  const resolved = resolveColumns(header, options.maps ?? {});
  if (!resolved.ok || resolved.missing.length > 0) {
    throw new Error(resolved.error ?? `unresolved fields: ${resolved.missing.join(", ")}`);
  }
  const built = buildRows(header, table.slice(1), resolved.fields);
  const audit = buildAudit({
    source: options.source ?? "fixture.csv",
    rows: built.rows,
    skipped: built.skipped,
    columns: resolved.fields,
    mappedByUser: options.maps ?? {},
    prices: null,
    comparisons: [],
  });
  return { audit, skipped: built.skipped, fields: resolved.fields };
}

// ---- fixtures built in a temp folder ---------------------------------------------------------

/** Hand-computed fixture (see the header comment). 20 rows, $12.70, one spike, no loop burst. */
const MAIN_CSV = [
  "timestamp,model,prompt_tokens,completion_tokens,cost_usd,project_id",
  "2026-10-01T09:00:00Z,gpt-4o,1000,500,0.50,alpha",
  "2026-10-01T09:01:00Z,gpt-4o,1000,500,0.50,alpha",
  "2026-10-01T09:02:00Z,gpt-4o,1000,500,0.50,alpha",
  "2026-10-01T09:03:00Z,gpt-4o,1000,500,0.50,alpha",
  "2026-10-02T09:00:00Z,gpt-4o-mini,1000,100,0.20,alpha",
  "2026-10-02T09:01:00Z,gpt-4o-mini,1000,100,0.20,alpha",
  "2026-10-02T09:02:00Z,gpt-4o-mini,1000,100,0.20,alpha",
  "2026-10-02T09:03:00Z,gpt-4o-mini,1000,100,0.20,alpha",
  "2026-10-03T09:00:00Z,claude,1000,200,0.30,beta",
  "2026-10-03T09:01:00Z,claude,1000,200,0.30,beta",
  "2026-10-03T09:02:00Z,claude,1000,200,0.30,beta",
  "2026-10-03T09:03:00Z,claude,1000,200,0.30,beta",
  "2026-10-04T09:00:00Z,claude,1000,200,0.30,beta",
  "2026-10-04T09:01:00Z,claude,1000,200,0.30,beta",
  "2026-10-04T09:02:00Z,claude,1000,200,0.30,beta",
  "2026-10-04T09:03:00Z,claude,1000,200,0.30,beta",
  "2026-10-05T09:00:00Z,gpt-4o,1000,500,0.50,beta",
  "2026-10-05T09:01:00Z,gpt-4o,1000,500,0.50,beta",
  "2026-10-05T09:02:00Z,gpt-4o,1000,500,0.50,beta",
  "2026-10-05T09:03:00Z,gpt-4o,200000,1000,6.00,beta",
].join("\n");

/** Second header style: spaces, capitals and a parenthesis. Two rows, $1.25. */
const STYLE2_CSV = [
  "Usage Date,Model Name,Input Tokens,Output Tokens,Total Cost (USD)",
  "2026-10-06,gpt-4o,1000,500,1.00",
  "2026-10-06,gpt-4o-mini,2000,100,0.25",
].join("\n");

/** A date column named "when", which the tool must NOT guess; --map date=When fixes it. */
const MAPPING_CSV = [
  "when,engine,tokens_in,tokens_out,charge_usd,team",
  "2026-10-07,atlas-small,100,20,0.05,team-a",
  "2026-10-07,atlas-small,200,40,0.10,team-a",
].join("\n");

/** No cost column; "value" is numeric but is never taken as spend. */
const NO_COST_CSV = [
  "date,model,input_tokens,output_tokens,project,value",
  "2026-10-01,gpt-4o,1000,500,alpha,0.75",
].join("\n");

/** One model with six rows in a single minute and one row in each of two other minutes. */
const LOOP_CSV = [
  "timestamp,model,input_tokens,output_tokens,cost_usd",
  "2026-10-01T09:00:00Z,alpha-model,100,50,0.10",
  "2026-10-01T09:00:00Z,alpha-model,100,50,0.10",
  "2026-10-01T09:00:00Z,alpha-model,100,50,0.10",
  "2026-10-01T09:00:00Z,alpha-model,100,50,0.10",
  "2026-10-01T09:00:00Z,alpha-model,100,50,0.10",
  "2026-10-01T09:00:00Z,alpha-model,100,50,0.10",
  "2026-10-01T09:01:00Z,alpha-model,100,50,0.10",
  "2026-10-01T09:02:00Z,alpha-model,100,50,0.10",
].join("\n");

/** Same shape but one row per minute: no minute can be above 5x the median. */
const FLAT_CSV = [
  "timestamp,model,input_tokens,output_tokens,cost_usd",
  "2026-10-01T09:00:00Z,alpha-model,100,50,0.10",
  "2026-10-01T09:01:00Z,alpha-model,100,50,0.10",
  "2026-10-01T09:02:00Z,alpha-model,100,50,0.10",
  "2026-10-01T09:03:00Z,alpha-model,100,50,0.10",
  "2026-10-01T09:04:00Z,alpha-model,100,50,0.10",
  "2026-10-01T09:05:00Z,alpha-model,100,50,0.10",
].join("\n");

// ---- checks ----------------------------------------------------------------------------------

function mainChecks(): void {
  const main = auditOf(MAIN_CSV, { source: "main.csv" });

  // Column auto-detection, two header styles.
  const style1 = resolveColumns(parseCsv(MAIN_CSV)[0]);
  check(
    "column auto-detection: header style 1 (snake_case) maps every field",
    style1.ok &&
      style1.missing.length === 0 &&
      style1.fields.date === "timestamp" &&
      style1.fields.model === "model" &&
      style1.fields.input === "prompt_tokens" &&
      style1.fields.output === "completion_tokens" &&
      style1.fields.cost === "cost_usd" &&
      style1.fields.group === "project_id",
    JSON.stringify(style1.fields),
  );
  const style2 = resolveColumns(parseCsv(STYLE2_CSV)[0]);
  check(
    "column auto-detection: header style 2 (spaces, capitals, parentheses) maps every field",
    style2.ok &&
      style2.missing.length === 0 &&
      style2.fields.date === "Usage Date" &&
      style2.fields.model === "Model Name" &&
      style2.fields.input === "Input Tokens" &&
      style2.fields.output === "Output Tokens" &&
      style2.fields.cost === "Total Cost (USD)",
    JSON.stringify(style2.fields),
  );
  const style2Audit = auditOf(STYLE2_CSV);
  check(
    "both header styles produce the same numbers without --map",
    close(style2Audit.audit.totals.cost, 1.25) && close(style2Audit.audit.totals.input, 3000) && style2Audit.audit.rowsRead === 2,
    JSON.stringify(style2Audit.audit.totals),
  );

  // --map override.
  const mapDir = mktemp("map", { "mapping.csv": MAPPING_CSV });
  const mapFile = path.join(mapDir, "mapping.csv");
  const noMap = cli([mapFile, "--json"]);
  check(
    "an unnamed date column is refused with the columns found, a --map suggestion and exit 1",
    noMap.status === 1 && /missing required column/.test(noMap.stderr) && /columns found:/.test(noMap.stderr) && /--map date=/.test(noMap.stderr) && /"when"/.test(noMap.stderr),
    `exit=${noMap.status}; ${JSON.stringify(noMap.stderr.split("\n")[0] ?? "")}`,
  );
  const withMap = cli([mapFile, "--map", "date=When", "--map", "cost=charge_usd", "--json"]);
  let mappedJson: Audit | null = null;
  try {
    mappedJson = JSON.parse(withMap.stdout) as Audit;
  } catch {
    /* reported by the check below */
  }
  check(
    "--map overrides auto-detection and the same file then computes exact totals ($0.15, 300 in, 60 out)",
    withMap.status === 0 &&
      mappedJson !== null &&
      close(mappedJson.totals.cost, 0.15) &&
      close(mappedJson.totals.input, 300) &&
      close(mappedJson.totals.output, 60) &&
      mappedJson.columns.date === "when" &&
      mappedJson.columns.cost === "charge_usd",
    `exit=${withMap.status}; cost=${mappedJson?.totals?.cost}; date=${mappedJson?.columns?.date}; cost=${mappedJson?.columns?.cost}`,
  );

  // Missing column, and the unit that is never guessed.
  const missDir = mktemp("missing", { "no-cost.csv": NO_COST_CSV });
  const missing = cli([path.join(missDir, "no-cost.csv"), "--json"]);
  check(
    "a missing cost column gives the helpful message and exit 1",
    missing.status === 1 &&
      /missing required column/.test(missing.stderr) &&
      /columns found:/.test(missing.stderr) &&
      /missing cost in dollars/.test(missing.stderr) &&
      /--map cost=/.test(missing.stderr) &&
      /never guesses a currency/.test(missing.stderr),
    `exit=${missing.status}; ${JSON.stringify(missing.stderr.split("\n").slice(0, 2).join(" | "))}`,
  );
  check(
    'a numeric column named "value" is never guessed to be spend (the unit is not guessed)',
    missing.status === 1 && /--map cost="value"/.test(missing.stderr),
    `suggestion=${JSON.stringify((/--map cost=[^\n]+/.exec(missing.stderr) ?? ["-"])[0])}`,
  );

  // Totals and per-model sums against the hand-computed fixture.
  check(
    "totals match the hand-computed fixture (20 rows, $12.70, 225,500 tokens)",
    close(main.audit.totals.cost, 12.7) &&
      close(main.audit.totals.input, 219000) &&
      close(main.audit.totals.output, 6500) &&
      close(main.audit.totals.tokens, 225500) &&
      main.audit.totals.rows === 20 &&
      main.audit.totals.requests === null &&
      main.skipped === 0,
    JSON.stringify({ ...main.audit.totals, skipped: main.skipped }),
  );
  const byModel = Object.fromEntries(main.audit.byModel.map((m) => [m.model, m]));
  check(
    "per-model sums and shares match the hand-computed fixture",
    close(byModel["gpt-4o"].cost, 9.5) &&
      close(byModel["gpt-4o"].input, 207000) &&
      close(byModel["gpt-4o"].output, 4500) &&
      byModel["gpt-4o"].rows === 8 &&
      close(byModel["gpt-4o-mini"].cost, 0.8) &&
      close(byModel["gpt-4o-mini"].input, 4000) &&
      close(byModel.claude.cost, 2.4) &&
      byModel.claude.rows === 8 &&
      close(byModel["gpt-4o"].share, 9.5 / 12.7) &&
      close(byModel.claude.share, 2.4 / 12.7),
    main.audit.byModel.map((m) => `${m.model}=$${m.cost}/${m.rows}r/${(m.share * 100).toFixed(2)}%`).join(", "),
  );
  const byDay = Object.fromEntries(main.audit.byDay.map((d) => [d.day, d.cost]));
  check(
    "spend by day and the median day match the hand-computed fixture",
    close(byDay["2026-10-01"], 2) &&
      close(byDay["2026-10-02"], 0.8) &&
      close(byDay["2026-10-03"], 1.2) &&
      close(byDay["2026-10-04"], 1.2) &&
      close(byDay["2026-10-05"], 7.5) &&
      close(main.audit.medianDayCost, 1.2),
    `days=${JSON.stringify(byDay)} median=${main.audit.medianDayCost}`,
  );
  check(
    "the single biggest model and its share are reported",
    main.audit.topModelShare?.model === "gpt-4o" && close(main.audit.topModelShare.share, 9.5 / 12.7),
    JSON.stringify(main.audit.topModelShare),
  );
  check(
    "spend by project is available when the column exists (alpha $2.80, beta $9.90)",
    main.audit.groupColumn === "project_id" &&
      main.audit.byGroup !== null &&
      main.audit.byGroup.length === 2 &&
      close(main.audit.byGroup[0].cost, 9.9),
    JSON.stringify(main.audit.byGroup?.map((g) => `${g.key}=$${g.cost}`)),
  );
  check(
    "the top cost drivers are ranked model + project",
    main.audit.topDrivers.length === 4 &&
      main.audit.topDrivers[0].label === "gpt-4o / beta" &&
      close(main.audit.topDrivers[0].cost, 7.5) &&
      main.audit.topDrivers[0].rows === 4,
    main.audit.topDrivers.map((d) => `${d.label}=$${d.cost}`).join(", "),
  );

  // Signals.
  check(
    "spike days are detected (only 2026-10-05, $7.50 = 6.25x the median day)",
    main.audit.spikes.length === 1 &&
      main.audit.spikes[0].day === "2026-10-05" &&
      close(main.audit.spikes[0].cost, 7.5) &&
      close(main.audit.spikes[0].multiple, 6.25),
    JSON.stringify(main.audit.spikes),
  );
  check(
    "context-bloat share is computed from the 95th percentile input (1 row above, $6.00 = 47.24% of spend)",
    close(main.audit.contextBloat.threshold, 1000) &&
      main.audit.contextBloat.rowsAbove === 1 &&
      main.audit.contextBloat.rowsTotal === 20 &&
      close(main.audit.contextBloat.costAbove, 6) &&
      close(main.audit.contextBloat.shareOfSpend, 6 / 12.7) &&
      close(main.audit.contextBloat.shareOfRows, 0.05),
    JSON.stringify(main.audit.contextBloat),
  );
  const ratio = Object.fromEntries(main.audit.ioRatios.map((r) => [r.model, r.inputPerOutput]));
  check(
    "average input:output ratio per model matches (gpt-4o 46, gpt-4o-mini 10, claude 5)",
    close(ratio["gpt-4o"] as number, 46) && close(ratio["gpt-4o-mini"] as number, 10) && close(ratio.claude as number, 5),
    JSON.stringify(ratio),
  );
  const loop = auditOf(LOOP_CSV);
  check(
    "a loop burst is detected on the burst fixture (6 rows in one minute vs median 1; $0.50 of excess)",
    loop.audit.loopBursts.length === 1 &&
      loop.audit.loopBursts[0].model === "alpha-model" &&
      loop.audit.loopBursts[0].minute === "2026-10-01T09:00" &&
      loop.audit.loopBursts[0].count === 6 &&
      loop.audit.loopBursts[0].excessRows === 5 &&
      close(loop.audit.loopBursts[0].excessCost, 0.5),
    JSON.stringify(loop.audit.loopBursts),
  );
  const flat = auditOf(FLAT_CSV);
  check("no loop burst is found on the flat fixture", flat.audit.loopBursts.length === 0, JSON.stringify(flat.audit.loopBursts));
  check("no loop burst is found on the main fixture", main.audit.loopBursts.length === 0, JSON.stringify(main.audit.loopBursts));

  // No prices, no estimate.
  const noPricesMd = renderMarkdown(main.audit);
  check(
    "no savings estimate without --prices (the report says why, and the JSON has no comparison)",
    !/the same tokens on/.test(noPricesMd) &&
      /No `--prices` file was given/.test(noPricesMd) &&
      main.audit.pricesPath === null &&
      main.audit.comparisons.length === 0,
    `prices=${main.audit.pricesPath}; comparisons=${main.audit.comparisons.length}`,
  );

  // Example prices refused, then allowed as illustrative only.
  const workDir = mktemp("prices", { "main.csv": MAIN_CSV });
  const mainFile = path.join(workDir, "main.csv");
  const refused = cli([mainFile, "--prices", EXAMPLE_PRICES]);
  check(
    "the shipped example prices are refused without --allow-example-prices (exit 1, names the flag)",
    refused.status === 1 && /refusing to estimate/.test(refused.stderr) && /--allow-example-prices/.test(refused.stderr),
    `exit=${refused.status}; ${JSON.stringify(refused.stderr.split("\n")[0] ?? "")}`,
  );
  const illustrative = cli([mainFile, "--prices", EXAMPLE_PRICES, "--allow-example-prices", "--compare", "gpt-4o=gpt-4o-mini", "--json"]);
  let illusJson: Audit | null = null;
  try {
    illusJson = JSON.parse(illustrative.stdout) as Audit;
  } catch {
    /* reported below */
  }
  check(
    'with --allow-example-prices every figure from those prices is labelled "illustrative only"',
    illustrative.status === 0 &&
      illusJson !== null &&
      illusJson.illustrativePrices === true &&
      /ILLUSTRATIVE ONLY/.test(renderMarkdown(illusJson)) &&
      /illustrative only/i.test(renderMarkdown(illusJson)),
    `exit=${illustrative.status}; illustrative=${illusJson?.illustrativePrices}`,
  );

  // Real-looking prices: the --compare arithmetic must be exact.
  const pricesFile = path.join(workDir, "real-prices.json");
  fs.writeFileSync(
    pricesFile,
    JSON.stringify({ "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10 }, "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 } }, null, 2),
    "utf8",
  );
  const priced = cli([mainFile, "--prices", pricesFile, "--compare", "gpt-4o=gpt-4o-mini", "--json"]);
  let pricedJson: Audit | null = null;
  try {
    pricedJson = JSON.parse(priced.stdout) as Audit;
  } catch {
    /* reported below */
  }
  const comparison = pricedJson?.comparisons[0];
  const expectedOnMini = (207000 / 1e6) * 0.15 + (4500 / 1e6) * 0.6;
  check(
    "with real-looking prices and --compare the arithmetic is exact",
    priced.status === 0 &&
      comparison !== undefined &&
      close(comparison.fromInputTokens, 207000) &&
      close(comparison.fromOutputTokens, 4500) &&
      close(comparison.fromActualCost, 9.5) &&
      close(comparison.costOnTo as number, expectedOnMini) &&
      close(comparison.difference as number, 9.5 - expectedOnMini),
    `costOnTo=${comparison?.costOnTo} expected=${expectedOnMini} actual=${comparison?.fromActualCost}`,
  );
  const pricedMd = pricedJson ? renderMarkdown(pricedJson) : "";
  check(
    'the comparison is labelled "if gpt-4o-mini were acceptable for these calls" and claims nothing more',
    /### if gpt-4o-mini were acceptable for these calls/.test(pricedMd) && /not a claim the tool makes/.test(pricedMd),
    `heading=${/### if [^\n]*/.exec(pricedMd)?.[0] ?? "-"}`,
  );

  // The two closing sections and the closing line.
  check(
    'the report contains "What I measured" and "What I am assuming"',
    /## What I measured/.test(pricedMd) && /## What I am assuming/.test(pricedMd),
  );
  check(
    "the report ends with the quality-test closing line (nothing after it)",
    pricedMd.trimEnd().endsWith(CLOSING_LINE) && /quality test on a sample of real calls/.test(pricedMd),
    JSON.stringify(pricedMd.trimEnd().slice(-70)),
  );

  // One self-contained HTML file, no external URL, inline CSS bar chart.
  const html = pricedJson ? renderHtml(pricedJson) : "";
  check(
    'the HTML has no external URL (no "http" anywhere), no script, and an inline CSS bar chart',
    html.length > 0 && !/http/i.test(html) && !/<script/i.test(html) && /<style>/.test(html) && /class="bar"/.test(html) && /width:/.test(html),
    `len=${html.length}; bars=${(html.match(/class="bar"/g) ?? []).length}`,
  );

  // --out / --html write both files.
  const outDir = mktemp("out", { "main.csv": MAIN_CSV });
  const outMd = path.join(outDir, "report.md");
  const outHtml = path.join(outDir, "report.html");
  const wrote = cli([path.join(outDir, "main.csv"), "--out", outMd, "--html", outHtml]);
  const htmlText = fs.existsSync(outHtml) ? fs.readFileSync(outHtml, "utf8") : "";
  check(
    "--out and --html write both reports and the HTML stays self-contained",
    wrote.status === 0 &&
      fs.existsSync(outMd) &&
      /## What I measured/.test(fs.readFileSync(outMd, "utf8")) &&
      htmlText.length > 0 &&
      !/http/i.test(htmlText) &&
      /class="bar"/.test(htmlText),
    `exit=${wrote.status}; md=${fs.existsSync(outMd)}; html=${htmlText.length}B`,
  );

  // The bundled fake sample runs end to end.
  const sampleRun = cli([SAMPLE, "--json"]);
  let sampleJson: Audit | null = null;
  try {
    sampleJson = JSON.parse(sampleRun.stdout) as Audit;
  } catch {
    /* reported below */
  }
  check(
    "the bundled fake sample runs end to end with exit 0 (28 rows, $6.32, all three signals fire)",
    sampleRun.status === 0 &&
      sampleJson !== null &&
      sampleJson.rowsRead === 28 &&
      close(sampleJson.totals.cost, 6.32) &&
      sampleJson.spikes.length === 1 &&
      sampleJson.loopBursts.length === 1 &&
      sampleJson.contextBloat.rowsAbove === 1,
    `exit=${sampleRun.status}; rows=${sampleJson?.rowsRead}; cost=${sampleJson?.totals?.cost}; spikes=${sampleJson?.spikes?.length}; bursts=${sampleJson?.loopBursts?.length}; bloat=${sampleJson?.contextBloat?.rowsAbove}`,
  );
  const samplePath = path.join(REPO_ROOT, SAMPLE);
  check(
    "the bundled sample is clearly labelled FAKE and is a plain CSV (no first-line comment)",
    /FAKE/.test(path.basename(SAMPLE)) && fs.readFileSync(samplePath, "utf8").startsWith("timestamp,model,"),
    path.basename(SAMPLE),
  );
}

try {
  mainChecks();
} catch (e) {
  check("harness completed without throwing", false, String(e instanceof Error ? e.message : e));
} finally {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort: outside the repo */
    }
  }
}

console.log(failures === 0 ? "cost-audit-check: all checks passed" : `cost-audit-check: ${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
