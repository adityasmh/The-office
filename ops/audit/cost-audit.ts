#!/usr/bin/env node
/**
 * ops/audit/cost-audit.ts - Offer B (docs/business/PLAN.md): the AI cost audit.
 *
 *   npx tsx ops/audit/cost-audit.ts <usage.csv> [--prices prices.json] [--map field=Column ...]
 *       [--out report.md] [--html report.html] [--json] [--allow-example-prices]
 *       [--compare modelA=modelB ...]
 *
 * Turns ONE usage export into a report computed only from that file: totals, spend by day /
 * model / project, the top 10 cost drivers, the biggest model's share, spike days, input:output
 * ratio per model, rows above the 95th percentile input ("possible context bloat") and
 * minute-level retry/loop bursts. A savings estimate is produced ONLY when the user supplies
 * `--prices`, and every such figure is labelled an assumption.
 *
 * Rules baked in here:
 *   - local only: no network call, nothing is uploaded, only numbers and short labels are read
 *   - never guess a unit: a column is spend only if it is mapped, or named like cost/amount/usd
 *   - never invent a price: no savings section without --prices
 *   - the shipped prices.example.json is refused unless --allow-example-prices is given, and then
 *     every number from it is labelled "illustrative only"
 *   - the report always ends with "What I measured", "What I am assuming", and a closing line
 *     saying a cheaper model is only a saving after a quality test on real calls
 *   - rows that cannot be parsed are skipped and counted, never guessed
 *
 * The pure parts (parseCsv / resolveColumns / buildRows / buildAudit / renderMarkdown /
 * renderHtml) take plain data, so the proof harness (ops/audit/cost-audit-check.ts) runs the real
 * code against fixtures in a temporary folder.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");
export const EXAMPLE_PRICES_PATH = path.join(HERE, "prices.example.json");
export const SAMPLE_CSV_PATH = path.join(HERE, "sample", "usage-sample-FAKE.csv");

// ---------------------------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------------------------

export const FIELD_ORDER = ["date", "model", "input", "output", "cost", "group", "requests"] as const;
export type Field = (typeof FIELD_ORDER)[number];

/** Required to compute anything. `group` and `requests` are optional extras. */
export const REQUIRED_FIELDS: Field[] = ["date", "model", "input", "output", "cost"];

export const FIELD_LABELS: Record<Field, string> = {
  date: "date or timestamp",
  model: "model",
  input: "input tokens",
  output: "output tokens",
  cost: "cost in dollars",
  group: "project, API key or user (optional)",
  requests: "request count (optional)",
};

/**
 * Common header names per field, all lowercased with every non-alphanumeric character removed,
 * so "Cost (USD)" and "cost_usd" both normalise to "costusd". Matched exactly, then case by case
 * through the safe fallbacks below.
 */
export const CANDIDATES: Record<Field, string[]> = {
  date: [
    "date", "day", "timestamp", "ts", "time", "datetime", "dateutc", "createdat", "created",
    "starttime", "startedat", "periodstart", "period", "usagedate", "requestdate", "startdate",
  ],
  model: ["model", "modelname", "modelid", "engine", "deployment", "deploymentname", "snapshot"],
  input: [
    "inputtokens", "prompttokens", "tokensin", "inputtokencount", "input", "prompt",
    "inputtokenscount", "prompttokenscount", "ncontexttokenstotal", "contexttokens",
  ],
  output: [
    "outputtokens", "completiontokens", "tokensout", "outputtokencount", "output", "completion",
    "outputtokenscount", "completiontokenscount", "ncompletiontokens", "generatedtokens",
  ],
  cost: [
    "cost", "costusd", "totalcost", "costinusd", "amount", "amountusd", "usd", "spend",
    "spendusd", "price", "charge", "charged", "billed", "usagecost", "totalusd", "fee",
  ],
  group: [
    "project", "projectid", "projectname", "apikey", "apikeyname", "apikeyid", "key", "keyid",
    "keyname", "user", "userid", "email", "account", "accountid", "workspace", "workspaceid",
    "team", "teamid", "org", "organization", "customer", "tenant",
  ],
  requests: [
    "requests", "requestcount", "reqs", "calls", "callcount", "nrequests", "numrequests",
    "numberofrequests", "requestcounttotal",
  ],
};

/**
 * Last-resort matching, only for the fields where a prefix/substring is unambiguous. There is no
 * fuzzy rule for `model` or `group`: a wrong guess there would silently mix two models or two
 * customers, so the tool asks the user for `--map` instead.
 */
const FUZZY: Partial<Record<Field, (norm: string) => boolean>> = {
  date: (n) => n.startsWith("date") || n.startsWith("timestamp") || n.endsWith("date") || n.includes("timestamp"),
  input: (n) => (n.includes("inputtoken") || n.includes("prompttoken")) && !n.includes("output") && !n.includes("completion"),
  output: (n) => n.includes("outputtoken") || n.includes("completiontoken"),
  // "taken as dollars only if mapped or named like cost/amount/usd" - plus the other
  // unambiguous money words. A column named "value" or "total" is NOT spend.
  cost: (n) =>
    !n.includes("token") &&
    ["cost", "amount", "usd", "spend", "billed", "charge", "fee", "price"].some((w) => n.includes(w)),
};

export type ColumnMap = Partial<Record<Field, string>>;

export interface ResolvedColumns {
  ok: boolean;
  error?: string;
  /** Field -> the header text it was mapped to. */
  fields: ColumnMap;
  /** Required fields that could not be found. */
  missing: Field[];
  /** Header cells that no field was mapped to (candidates for --map). */
  unused: string[];
}

export function normalizeHeader(name: string): string {
  return name.replace(/^\uFEFF/, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Find the columns in `header`, honouring `--map` overrides exactly before any auto-detection. */
export function resolveColumns(header: string[], overrides: ColumnMap = {}): ResolvedColumns {
  const cells = header.map((raw, index) => ({ raw, norm: normalizeHeader(raw), index }));
  const used = new Set<number>();
  const fields: ColumnMap = {};

  for (const field of FIELD_ORDER) {
    const column = overrides[field];
    if (column === undefined) continue;
    const hit = cells.find((c) => c.norm === normalizeHeader(column) && !used.has(c.index));
    if (!hit) {
      return {
        ok: false,
        error: `--map ${field}=${JSON.stringify(column)}: no column with that name. Columns found: ${header.map((h) => JSON.stringify(h)).join(", ")}`,
        fields,
        missing: [],
        unused: header,
      };
    }
    fields[field] = hit.raw;
    used.add(hit.index);
  }

  for (const field of FIELD_ORDER) {
    if (fields[field] !== undefined) continue;
    const candidates = CANDIDATES[field];
    let hit = cells.find((c) => !used.has(c.index) && candidates.includes(c.norm));
    if (!hit) {
      const fuzzy = FUZZY[field];
      if (fuzzy) hit = cells.find((c) => !used.has(c.index) && fuzzy(c.norm));
    }
    if (hit) {
      fields[field] = hit.raw;
      used.add(hit.index);
    }
  }

  const missing = REQUIRED_FIELDS.filter((f) => fields[f] === undefined);
  const unused = cells.filter((c) => !used.has(c.index)).map((c) => c.raw);
  return { ok: true, fields, missing, unused };
}

/** The message printed when a needed column is missing: what was found and how to map it. */
export function missingColumnsMessage(file: string, header: string[], missing: Field[], unused: string[]): string {
  const lines: string[] = [];
  lines.push(`cost-audit: cannot read ${file} - missing required column(s).`);
  lines.push(`  columns found: ${header.map((h) => JSON.stringify(h)).join(", ")}`);
  for (const field of missing) {
    lines.push(`  missing ${FIELD_LABELS[field]}: recognised names are ${CANDIDATES[field].slice(0, 8).join(", ")}, ...`);
  }
  lines.push("");
  lines.push("  Pass a mapping for each wanted column and the tool will use it exactly. For example:");
  for (const field of missing) {
    const candidate = unused[0];
    lines.push(`    --map ${field}${candidate === undefined ? "=ColumnName" : `=${JSON.stringify(candidate)}`}`);
  }
  if (missing.includes("cost")) {
    lines.push("  A spend column is only treated as dollars when it is mapped or named like cost, amount or usd;");
    lines.push("  the tool never guesses a currency or a unit.");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// CSV + rows
// ---------------------------------------------------------------------------------------------

/** Minimal RFC4180-ish CSV: quoted fields, doubled quotes, CRLF or LF, blank lines dropped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let started = false;

  const endField = (): void => {
    row.push(field);
    field = "";
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      started = true;
      continue;
    }
    if (ch === ",") {
      endField();
      started = true;
      continue;
    }
    if (ch === "\r") continue;
    if (ch === "\n") {
      endRow();
      started = false;
      continue;
    }
    field += ch;
    started = true;
  }
  if (started || field !== "" || row.length > 0) endRow();

  const stripped = rows.map((r, i) => (i === 0 && r.length > 0 ? [r[0].replace(/^\uFEFF/, ""), ...r.slice(1)] : r));
  return stripped.filter((r) => r.some((c) => c.trim() !== ""));
}

export interface Row {
  /** Calendar date as written, YYYY-MM-DD. */
  day: string;
  /** YYYY-MM-DDTHH:MM when the timestamp had at least minute resolution, else null. */
  minute: string | null;
  model: string;
  input: number;
  output: number;
  cost: number;
  /** The project/key/user value, null when that column is not in the file, "" when blank. */
  group: string | null;
  requests: number | null;
}

export interface ParsedRows {
  rows: Row[];
  skipped: number;
}

const DATE_RE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/;

/** Parse a date/timestamp cell. Returns null when it is not a date the tool understands. */
export function parseDateCell(value: string): { day: string; minute: string | null } | null {
  const m = DATE_RE.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const day = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  const minute = h === undefined ? null : `${day}T${h.padStart(2, "0")}:${mi}`;
  return { day, minute };
}

/** Parse a numeric cell. Empty means 0 (many exports leave blanks); anything else non-numeric is null. */
export function parseNumberCell(value: string | undefined): number | null {
  if (value === undefined) return 0;
  const t = value.trim().replace(/\$/g, "").replace(/,/g, "").replace(/\s+/g, "").replace(/usd/i, "");
  if (t === "") return 0;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function buildRows(header: string[], table: string[][], fields: ColumnMap): ParsedRows {
  const indexOf = (field: Field): number => {
    const wanted = fields[field];
    if (wanted === undefined) return -1;
    return header.findIndex((h) => normalizeHeader(h) === normalizeHeader(wanted));
  };
  const at = (row: string[], field: Field): string | undefined => {
    const i = indexOf(field);
    return i < 0 ? undefined : row[i];
  };

  const rows: Row[] = [];
  let skipped = 0;
  for (const raw of table) {
    const date = parseDateCell(at(raw, "date") ?? "");
    const input = parseNumberCell(at(raw, "input"));
    const output = parseNumberCell(at(raw, "output"));
    const cost = parseNumberCell(at(raw, "cost"));
    if (!date || input === null || output === null || cost === null) {
      skipped++;
      continue;
    }
    const modelCell = (at(raw, "model") ?? "").trim();
    const groupIdx = indexOf("group");
    const requestsIdx = indexOf("requests");
    const requests = requestsIdx < 0 ? null : parseNumberCell(raw[requestsIdx]);
    rows.push({
      day: date.day,
      minute: date.minute,
      model: modelCell === "" ? "(unknown model)" : modelCell,
      input,
      output,
      cost,
      group: groupIdx < 0 ? null : (raw[groupIdx] ?? "").trim(),
      requests: requests === null ? 0 : requests,
    });
  }
  return { rows, skipped };
}

// ---------------------------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------------------------

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Nearest-rank percentile: the smallest value with at least p*n values at or below it. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.min(s.length, Math.max(1, Math.ceil(p * s.length)));
  return s[rank - 1];
}

export function usd(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

export function num(n: number): string {
  const r = Math.round(n);
  const s = String(Math.abs(r));
  return `${r < 0 ? "-" : ""}${s.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

export function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------------------------

export interface ModelPrice {
  inputPer1M: number;
  outputPer1M: number;
}
export type PriceMap = Record<string, ModelPrice>;

export interface LoadedPrices {
  path: string;
  map: PriceMap;
  /** True when these numbers are examples, not real quotes. */
  illustrative: boolean;
  note: string | null;
}

export function loadPrices(file: string): { ok: true; prices: LoadedPrices } | { ok: false; error: string } {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { ok: false, error: `cannot read the --prices file ${file}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `--prices ${file} is not valid JSON (${e instanceof Error ? e.message : String(e)})` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: `--prices ${file} must be an object: { "model": { "inputPer1M": number, "outputPer1M": number } }` };
  }

  const map: PriceMap = {};
  let note: string | null = null;
  let illustrative = false;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.startsWith("_")) {
      if (key === "_note" && typeof value === "string") note = value;
      if (key === "_example" && value === true) illustrative = true;
      continue;
    }
    const v = value as { inputPer1M?: unknown; outputPer1M?: unknown } | null;
    if (v && typeof v === "object" && Number.isFinite(v.inputPer1M) && Number.isFinite(v.outputPer1M)) {
      map[key] = { inputPer1M: v.inputPer1M as number, outputPer1M: v.outputPer1M as number };
    }
  }
  if (Object.keys(map).length === 0) {
    return { ok: false, error: `--prices ${file} has no usable entries; each must be { "inputPer1M": number, "outputPer1M": number }` };
  }
  // The shipped example file is refused by the caller unless --allow-example-prices is given.
  if (/^prices\.example\.json$/i.test(path.basename(file)) || path.resolve(file) === path.resolve(EXAMPLE_PRICES_PATH)) {
    illustrative = true;
  }
  return { ok: true, prices: { path: file, map, illustrative, note } };
}

// ---------------------------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------------------------

export interface DayRow {
  day: string;
  cost: number;
  tokens: number;
  rows: number;
}

export interface ModelRow {
  model: string;
  cost: number;
  share: number;
  input: number;
  output: number;
  tokens: number;
  rows: number;
}

export interface GroupRow {
  key: string;
  cost: number;
  share: number;
  tokens: number;
  rows: number;
}

export interface DriverRow {
  label: string;
  model: string;
  group: string | null;
  cost: number;
  tokens: number;
  rows: number;
}

export interface Spike {
  day: string;
  cost: number;
  medianDayCost: number;
  multiple: number;
}

export interface ContextBloat {
  threshold: number;
  rowsAbove: number;
  rowsTotal: number;
  costAbove: number;
  shareOfSpend: number;
  shareOfRows: number;
}

export interface IoRatio {
  model: string;
  input: number;
  output: number;
  inputPerOutput: number | null;
}

export interface LoopBurst {
  model: string;
  minute: string;
  count: number;
  medianPerActiveMinute: number;
  excessRows: number;
  excessCost: number;
}

export interface ComparisonResult {
  from: string;
  to: string;
  fromRows: number;
  fromInputTokens: number;
  fromOutputTokens: number;
  fromActualCost: number;
  fromInputPer1M: number | null;
  fromOutputPer1M: number | null;
  toInputPer1M: number | null;
  toOutputPer1M: number | null;
  costOnTo: number | null;
  difference: number | null;
}

export interface Audit {
  source: string;
  generatedFor: string | null;
  rowsRead: number;
  rowsSkipped: number;
  columns: ColumnMap;
  mappedByUser: ColumnMap;
  timeRange: { first: string; last: string; days: number } | null;
  totals: { cost: number; input: number; output: number; tokens: number; rows: number; requests: number | null };
  byDay: DayRow[];
  byModel: ModelRow[];
  byGroup: GroupRow[] | null;
  groupColumn: string | null;
  topDrivers: DriverRow[];
  topModelShare: { model: string; cost: number; share: number } | null;
  medianDayCost: number;
  spikes: Spike[];
  contextBloat: ContextBloat;
  ioRatios: IoRatio[];
  loopBursts: LoopBurst[];
  pricesPath: string | null;
  pricesNote: string | null;
  illustrativePrices: boolean;
  pricesUsed: Array<{ model: string; inputPer1M: number; outputPer1M: number }>;
  comparisons: ComparisonResult[];
  comparisonNotes: string[];
  assumptions: string[];
}

export interface AuditInput {
  source: string;
  rows: Row[];
  skipped: number;
  columns: ColumnMap;
  mappedByUser: ColumnMap;
  prices: LoadedPrices | null;
  comparisons: Array<{ from: string; to: string }>;
}

/** Build every number the report shows, from the parsed rows only. */
export function buildAudit(input: AuditInput): Audit {
  const { rows } = input;
  const totalCost = rows.reduce((a, r) => a + r.cost, 0);
  const totalInput = rows.reduce((a, r) => a + r.input, 0);
  const totalOutput = rows.reduce((a, r) => a + r.output, 0);
  const hasRequests = input.columns.requests !== undefined;
  const totalRequests = hasRequests ? rows.reduce((a, r) => a + (r.requests ?? 0), 0) : null;

  const dayMap = new Map<string, DayRow>();
  for (const r of rows) {
    const hit = dayMap.get(r.day) ?? { day: r.day, cost: 0, tokens: 0, rows: 0 };
    hit.cost += r.cost;
    hit.tokens += r.input + r.output;
    hit.rows += 1;
    dayMap.set(r.day, hit);
  }
  const byDay = [...dayMap.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  const modelMap = new Map<string, ModelRow>();
  for (const r of rows) {
    const hit = modelMap.get(r.model) ?? { model: r.model, cost: 0, share: 0, input: 0, output: 0, tokens: 0, rows: 0 };
    hit.cost += r.cost;
    hit.input += r.input;
    hit.output += r.output;
    hit.tokens += r.input + r.output;
    hit.rows += 1;
    modelMap.set(r.model, hit);
  }
  const byModel = [...modelMap.values()].sort((a, b) => b.cost - a.cost || (a.model < b.model ? -1 : 1));
  for (const m of byModel) m.share = totalCost > 0 ? m.cost / totalCost : 0;

  const groupColumn = input.columns.group ?? null;
  let byGroup: GroupRow[] | null = null;
  if (groupColumn !== null) {
    const groupMap = new Map<string, GroupRow>();
    for (const r of rows) {
      const key = r.group && r.group !== "" ? r.group : "(blank)";
      const hit = groupMap.get(key) ?? { key, cost: 0, share: 0, tokens: 0, rows: 0 };
      hit.cost += r.cost;
      hit.tokens += r.input + r.output;
      hit.rows += 1;
      groupMap.set(key, hit);
    }
    byGroup = [...groupMap.values()].sort((a, b) => b.cost - a.cost || (a.key < b.key ? -1 : 1));
    for (const g of byGroup) g.share = totalCost > 0 ? g.cost / totalCost : 0;
  }

  const driverMap = new Map<string, DriverRow>();
  for (const r of rows) {
    const group = groupColumn === null ? null : r.group && r.group !== "" ? r.group : "(blank)";
    const key = `${r.model}\u0000${group ?? ""}`;
    const label = group === null ? r.model : `${r.model} / ${group}`;
    const hit = driverMap.get(key) ?? { label, model: r.model, group, cost: 0, tokens: 0, rows: 0 };
    hit.cost += r.cost;
    hit.tokens += r.input + r.output;
    hit.rows += 1;
    driverMap.set(key, hit);
  }
  const topDrivers = [...driverMap.values()]
    .sort((a, b) => b.cost - a.cost || (a.label < b.label ? -1 : 1))
    .slice(0, 10);

  const top = byModel[0] ?? null;
  const topModelShare = top ? { model: top.model, cost: top.cost, share: top.share } : null;

  const medianDayCost = median(byDay.map((d) => d.cost));
  const spikeLimit = medianDayCost * 3;
  const spikes: Spike[] = byDay
    .filter((d) => medianDayCost > 0 && d.cost > spikeLimit)
    .map((d) => ({ day: d.day, cost: d.cost, medianDayCost, multiple: d.cost / medianDayCost }))
    .sort((a, b) => b.cost - a.cost);

  const inputs = rows.map((r) => r.input);
  const threshold = percentile(inputs, 0.95);
  const above = rows.filter((r) => r.input > threshold);
  const costAbove = above.reduce((a, r) => a + r.cost, 0);
  const contextBloat: ContextBloat = {
    threshold,
    rowsAbove: above.length,
    rowsTotal: rows.length,
    costAbove,
    shareOfSpend: totalCost > 0 ? costAbove / totalCost : 0,
    shareOfRows: rows.length > 0 ? above.length / rows.length : 0,
  };

  const ioRatios: IoRatio[] = byModel.map((m) => ({
    model: m.model,
    input: m.input,
    output: m.output,
    inputPerOutput: m.output > 0 ? m.input / m.output : null,
  }));

  // Retry / loop signal: one model's rows in one minute, when that count is more than 5x the
  // model's median per active minute. The "cost of the excess" is the minute's cost pro-rated to
  // the rows above the median: excessCost = minuteCost * (count - medianCount) / count.
  const perModelMinutes = new Map<string, Map<string, { count: number; cost: number }>>();
  for (const r of rows) {
    if (r.minute === null) continue;
    const minutes = perModelMinutes.get(r.model) ?? new Map<string, { count: number; cost: number }>();
    const hit = minutes.get(r.minute) ?? { count: 0, cost: 0 };
    hit.count += 1;
    hit.cost += r.cost;
    minutes.set(r.minute, hit);
    perModelMinutes.set(r.model, minutes);
  }
  const loopBursts: LoopBurst[] = [];
  for (const [model, minutes] of perModelMinutes) {
    const counts = [...minutes.values()].map((m) => m.count);
    const medianPerActiveMinute = median(counts);
    if (medianPerActiveMinute <= 0) continue;
    for (const [minute, hit] of minutes) {
      if (hit.count > 5 * medianPerActiveMinute) {
        const excessRows = hit.count - medianPerActiveMinute;
        loopBursts.push({
          model,
          minute,
          count: hit.count,
          medianPerActiveMinute,
          excessRows,
          excessCost: hit.cost * (excessRows / hit.count),
        });
      }
    }
  }
  loopBursts.sort((a, b) => b.excessCost - a.excessCost || (a.minute < b.minute ? -1 : 1));

  const comparisons: ComparisonResult[] = [];
  const comparisonNotes: string[] = [];
  if (input.prices) {
    const prices = input.prices.map;
    for (const pair of input.comparisons) {
      const fromRows = rows.filter((r) => r.model === pair.from);
      const fromIn = fromRows.reduce((a, r) => a + r.input, 0);
      const fromOut = fromRows.reduce((a, r) => a + r.output, 0);
      const fromCost = fromRows.reduce((a, r) => a + r.cost, 0);
      const fromPrice = prices[pair.from] ?? null;
      const toPrice = prices[pair.to] ?? null;
      if (fromRows.length === 0) comparisonNotes.push(`no rows for "${pair.from}" in this file, so the "${pair.from}=${pair.to}" comparison has no token volume`);
      if (!fromPrice) comparisonNotes.push(`no price for "${pair.from}" in ${input.prices.path}, so its actual tokens cannot be priced there`);
      if (!toPrice) comparisonNotes.push(`no price for "${pair.to}" in ${input.prices.path}, so this comparison was skipped`);
      const costOnTo = toPrice ? (fromIn / 1e6) * toPrice.inputPer1M + (fromOut / 1e6) * toPrice.outputPer1M : null;
      comparisons.push({
        from: pair.from,
        to: pair.to,
        fromRows: fromRows.length,
        fromInputTokens: fromIn,
        fromOutputTokens: fromOut,
        fromActualCost: fromCost,
        fromInputPer1M: fromPrice?.inputPer1M ?? null,
        fromOutputPer1M: fromPrice?.outputPer1M ?? null,
        toInputPer1M: toPrice?.inputPer1M ?? null,
        toOutputPer1M: toPrice?.outputPer1M ?? null,
        costOnTo,
        difference: costOnTo === null ? null : fromCost - costOnTo,
      });
    }
  }

  const timeRange =
    byDay.length === 0
      ? null
      : { first: byDay[0].day, last: byDay[byDay.length - 1].day, days: byDay.length };

  const audit: Audit = {
    source: input.source,
    generatedFor: null,
    rowsRead: rows.length,
    rowsSkipped: input.skipped,
    columns: input.columns,
    mappedByUser: input.mappedByUser,
    timeRange,
    totals: { cost: totalCost, input: totalInput, output: totalOutput, tokens: totalInput + totalOutput, rows: rows.length, requests: totalRequests },
    byDay,
    byModel,
    byGroup,
    groupColumn,
    topDrivers,
    topModelShare,
    medianDayCost,
    spikes,
    contextBloat,
    ioRatios,
    loopBursts,
    pricesPath: input.prices?.path ?? null,
    pricesNote: input.prices?.note ?? null,
    illustrativePrices: input.prices?.illustrative ?? false,
    pricesUsed: input.prices
      ? byModel
          .filter((m) => input.prices?.map[m.model] !== undefined)
          .map((m) => ({ model: m.model, inputPer1M: input.prices!.map[m.model].inputPer1M, outputPer1M: input.prices!.map[m.model].outputPer1M }))
      : [],
    comparisons,
    comparisonNotes,
    assumptions: [],
  };
  audit.assumptions = assumptionsFor(audit);
  return audit;
}

/** Every assumption behind the numbers, in plain words. */
export function assumptionsFor(a: Audit): string[] {
  const list: string[] = [];
  list.push(`Every figure comes from ${a.source} only. Nothing was fetched, uploaded or added by the tool.`);
  const costColumn = a.columns.cost;
  list.push(
    costColumn === undefined
      ? "No spend column was used."
      : `Spend is the value of the "${costColumn}" column treated as US dollars. The tool never guesses a unit, so if that column is not in dollars the totals are wrong in the same proportion.`,
  );
  list.push("Each CSV row is treated as one exported line (one request unless the export says otherwise).");
  if (a.totals.requests !== null) {
    list.push(
      `A request-count column ("${a.columns.requests}") is summed for the requests figure, but "possible context bloat" and the loop signal are computed per ROW, not per request inside a row.`,
    );
  } else {
    list.push("The file has no request-count column, so rows stand in for requests.");
  }
  list.push("Day means the calendar date exactly as written in the file. No timezone conversion is applied.");
  list.push("Spikes are days with spend above 3 times the MEDIAN day (the middle day of the days that appear in the file).");
  list.push('The 95th percentile uses nearest rank, and "above" means strictly greater than that value.');
  list.push("Retry/loop bursts look at minutes only, and the cost of the excess is the minute's cost pro-rated to the rows above the model's median active minute.");
  list.push("Nothing is extrapolated to days, keys or models that are not in the file.");
  if (a.pricesPath) {
    list.push(
      `Prices come from ${a.pricesPath}, supplied by the user as dollars per 1M tokens.${a.pricesNote ? ` Its own note says: ${a.pricesNote}` : ""}`,
    );
    if (a.illustrativePrices) list.push("Those prices are the shipped EXAMPLE numbers (made-up round figures), so every savings figure here is illustrative only.");
    for (const c of a.comparisons) {
      if (c.costOnTo === null) continue;
      list.push(
        `The "${c.from}=${c.to}" comparison asks what the "${c.from}" tokens would cost on "${c.to}". It assumes the same input/output token counts and it does NOT claim "${c.to}" is acceptable for these calls.`,
      );
    }
  } else {
    list.push("No prices were supplied, so this report contains no savings estimate and no price for any model.");
  }
  return list;
}

export const CLOSING_LINE =
  "A cheaper model is only a saving after a quality test on a sample of real calls shows the output is still good enough; run that test before switching anything.";

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

function table(headers: string[], rows: string[][]): string[] {
  const out: string[] = [];
  out.push(`| ${headers.join(" | ")} |`);
  out.push(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const r of rows) out.push(`| ${r.join(" | ")} |`);
  return out;
}

export function renderMarkdown(a: Audit): string {
  const L: string[] = [];
  const src = path.basename(a.source);
  L.push(`# AI cost audit: ${src}`);
  L.push("");
  L.push(`Computed from \`${a.source}\` only. Nothing was uploaded; the tool read numbers and short labels from this one file and made no network call.`);
  L.push("");

  L.push("## Headline");
  L.push("");
  const headline: string[][] = [
    ["Total spend", usd(a.totals.cost)],
    ["Total tokens", `${num(a.totals.tokens)} (input ${num(a.totals.input)} / output ${num(a.totals.output)})`],
    ["Exported rows read", num(a.totals.rows)],
    ["Rows skipped (unparsable)", num(a.rowsSkipped)],
    ["Requests (summed request column)", a.totals.requests === null ? "not in the file" : num(a.totals.requests)],
    [
      "Days in the file",
      a.timeRange ? `${num(a.timeRange.days)} (${a.timeRange.first} to ${a.timeRange.last})` : "0",
    ],
  ];
  L.push(...table(["Measure", "Value"], headline));
  L.push("");

  L.push("## Spend by day");
  L.push("");
  if (a.byDay.length === 0) {
    L.push("No day could be read from the file.");
  } else {
    L.push(...table(["Day", "Spend", "Tokens", "Rows"], a.byDay.map((d) => [d.day, usd(d.cost), num(d.tokens), num(d.rows)])));
  }
  L.push("");

  L.push("## Spend by model");
  L.push("");
  if (a.byModel.length === 0) {
    L.push("No model could be read from the file.");
  } else {
    L.push(
      ...table(
        ["Model", "Spend", "Share", "Tokens", "Input", "Output", "In:Out"],
        a.byModel.map((m) => [
          m.model,
          usd(m.cost),
          pct(m.share),
          num(m.tokens),
          num(m.input),
          num(m.output),
          m.output > 0 ? (m.input / m.output).toFixed(2) : "n/a (no output tokens)",
        ]),
      ),
    );
  }
  L.push("");

  if (a.byGroup && a.groupColumn) {
    L.push(`## Spend by ${a.groupColumn}`);
    L.push("");
    L.push(...table(["Key", "Spend", "Share", "Tokens", "Rows"], a.byGroup.map((g) => [g.key, usd(g.cost), pct(g.share), num(g.tokens), num(g.rows)])));
    L.push("");
  }

  L.push("## Top 10 cost drivers");
  L.push("");
  L.push(`A driver is a model${a.groupColumn ? ` plus its ${a.groupColumn}` : ""}, summed over the whole file.`);
  L.push("");
  if (a.topDrivers.length === 0) {
    L.push("No rows to rank.");
  } else {
    L.push(
      ...table(
        ["#", "Model", a.groupColumn ?? "Group", "Spend", "Tokens", "Rows"],
        a.topDrivers.map((d, i) => [String(i + 1), d.model, d.group ?? "-", usd(d.cost), num(d.tokens), num(d.rows)]),
      ),
    );
  }
  L.push("");

  L.push("## The single biggest model");
  L.push("");
  L.push(
    a.topModelShare
      ? `${a.topModelShare.model} is ${usd(a.topModelShare.cost)} of ${usd(a.totals.cost)} (${pct(a.topModelShare.share)} of spend).`
      : "No model could be read from the file.",
  );
  L.push("");

  L.push("## Spike days (more than 3x the median day)");
  L.push("");
  L.push(`Median day: ${usd(a.medianDayCost)}. A spike is any day above ${usd(a.medianDayCost * 3)}.`);
  L.push("");
  if (a.spikes.length === 0) {
    L.push("No day was more than 3x the median day.");
  } else {
    for (const s of a.spikes) L.push(`- ${s.day}: ${usd(s.cost)} (${s.multiple.toFixed(1)}x the median day)`);
  }
  L.push("");

  L.push("## Possible context bloat (input above the 95th percentile)");
  L.push("");
  L.push(`- 95th percentile input: ${num(a.contextBloat.threshold)} tokens`);
  L.push(`- Rows above it: ${num(a.contextBloat.rowsAbove)} of ${num(a.contextBloat.rowsTotal)} (${pct(a.contextBloat.shareOfRows)})`);
  L.push(`- Spend sitting above it: ${usd(a.contextBloat.costAbove)} of ${usd(a.totals.cost)} (${pct(a.contextBloat.shareOfSpend)})`);
  L.push("");
  L.push("This is a signal, not proof: a long input can be a legitimate document or a whole file. Read a few of those rows before calling it waste.");
  L.push("");

  L.push("## Possible retry or loop bursts (rows in one minute above 5x the model's median minute)");
  L.push("");
  if (a.loopBursts.length === 0) {
    L.push("No burst was found. This is only a signal either way, and it needs timestamps with at least minute resolution.");
  } else {
    for (const b of a.loopBursts) {
      L.push(
        `- ${b.model} at ${b.minute}: ${num(b.count)} rows (median ${num(b.medianPerActiveMinute)} per active minute), ${num(b.excessRows)} rows of excess, about ${usd(b.excessCost)} of spend pro-rated to those rows`,
      );
    }
    L.push("");
    L.push("This is a signal, not proof. A burst can be a legitimate queue flush or a batch job.");
  }
  L.push("");

  L.push("## Savings estimate");
  L.push("");
  if (!a.pricesPath) {
    L.push("No `--prices` file was given, so this report contains no estimate for another model. The tool never invents a price. Pass `--prices your-prices.json` (and optionally `--compare modelA=modelB`) to get one.");
  } else {
    if (a.illustrativePrices) {
      L.push("**ILLUSTRATIVE ONLY.** These prices came from the shipped example file, which holds made-up round numbers, not quotes from any vendor. Nothing below is a real estimate.");
      L.push("");
    }
    L.push(`Prices: \`${a.pricesPath}\`${a.pricesNote ? ` - ${a.pricesNote}` : ""}`);
    L.push("");
    if (a.pricesUsed.length > 0) {
      L.push(...table(["Model in the file", "Input $/1M", "Output $/1M"], a.pricesUsed.map((p) => [p.model, p.inputPer1M.toFixed(2), p.outputPer1M.toFixed(2)])));
      L.push("");
    }
    const priced = a.comparisons.filter((c) => c.costOnTo !== null);
    if (priced.length === 0) {
      L.push("No `--compare modelA=modelB` pair was priced, so there is no same-tokens comparison in this report.");
    }
    for (const c of priced) {
      L.push(`### if ${c.to} were acceptable for these calls`);
      L.push("");
      L.push(`- ${c.from} in this file: ${num(c.fromInputTokens)} input + ${num(c.fromOutputTokens)} output tokens across ${num(c.fromRows)} rows, ${usd(c.fromActualCost)} actually spent`);
      L.push(`- the same tokens on ${c.to} at $${c.toInputPer1M?.toFixed(2)} / $${c.toOutputPer1M?.toFixed(2)} per 1M: ${usd(c.costOnTo as number)}`);
      L.push(`- difference: ${usd(c.difference as number)} ${(c.difference as number) >= 0 ? "less" : "more"}`);
      L.push("");
      L.push(`"if ${c.to} were acceptable for these calls" is the question this line asks, not a claim the tool makes.`);
      L.push("");
    }
    for (const n of a.comparisonNotes) L.push(`- note: ${n}`);
    if (a.comparisonNotes.length > 0) L.push("");
  }
  L.push("");

  L.push("## What I measured");
  L.push("");
  const digits = a.columns.date !== undefined ? `, mapped from "${a.columns.date}"` : "";
  L.push(`- Read ${num(a.rowsRead)} rows from \`${a.source}\`${digits}; skipped ${num(a.rowsSkipped)} unparsable row(s).`);
  if (a.timeRange) L.push(`- Days present: ${a.timeRange.first} to ${a.timeRange.last} (${num(a.timeRange.days)} day(s)).`);
  L.push(`- Totals: ${usd(a.totals.cost)}, ${num(a.totals.tokens)} tokens (input ${num(a.totals.input)} / output ${num(a.totals.output)}).`);
  L.push(`- Biggest model: ${a.topModelShare ? `${a.topModelShare.model} at ${pct(a.topModelShare.share)} of spend` : "none"}.`);
  L.push(`- Spike days found: ${num(a.spikes.length)} (threshold ${usd(a.medianDayCost * 3)}, median day ${usd(a.medianDayCost)}).`);
  L.push(`- Rows above the ${num(a.contextBloat.threshold)}-token 95th percentile: ${num(a.contextBloat.rowsAbove)}, holding ${pct(a.contextBloat.shareOfSpend)} of spend.`);
  L.push(`- Loop-burst minutes found: ${num(a.loopBursts.length)}.`);
  L.push("");
  L.push("## What I am assuming");
  L.push("");
  for (const line of a.assumptions) L.push(`- ${line}`);
  L.push("");
  L.push(CLOSING_LINE);
  L.push("");
  return L.join("\n");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function bars(rows: Array<{ label: string; value: number; text: string }>): string {
  if (rows.length === 0) return '<p class="empty">No rows to chart.</p>';
  const max = Math.max(...rows.map((r) => r.value), 0) || 1;
  return [
    '<div class="bars">',
    ...rows.map(
      (r) =>
        `  <div class="bar"><span class="label">${esc(r.label)}</span><span class="track"><span class="fill" style="width:${((r.value / max) * 100).toFixed(1)}%"></span></span><span class="value">${esc(r.text)}</span></div>`,
    ),
    "</div>",
  ].join("\n");
}

/** One self-contained HTML file: inline CSS, no external asset, no external URL. */
export function renderHtml(a: Audit): string {
  const src = path.basename(a.source);
  const rowsHtml = (headers: string[], rows: string[][]): string => {
    const head = headers.map((h) => `<th>${esc(h)}</th>`).join("");
    const body = rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("\n");
    return `<table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table>`;
  };

  const signals: string[] = [];
  signals.push(
    `<h3>Possible context bloat (input above the 95th percentile)</h3>
<ul>
<li>95th percentile input: ${num(a.contextBloat.threshold)} tokens</li>
<li>Rows above it: ${num(a.contextBloat.rowsAbove)} of ${num(a.contextBloat.rowsTotal)} (${pct(a.contextBloat.shareOfRows)})</li>
<li>Spend above it: ${usd(a.contextBloat.costAbove)} of ${usd(a.totals.cost)} (${pct(a.contextBloat.shareOfSpend)})</li>
</ul>
<p class="hint">A signal, not proof: a long input can be a legitimate document. Read a few of those rows before calling it waste.</p>`,
  );
  if (a.loopBursts.length === 0) {
    signals.push(`<h3>Possible retry or loop bursts</h3><p>None found. This needs timestamps with at least minute resolution, and it is a signal only.</p>`);
  } else {
    signals.push(
      `<h3>Possible retry or loop bursts</h3>\n<ul>\n${a.loopBursts
        .map(
          (b) =>
            `<li>${esc(b.model)} at ${esc(b.minute)}: ${num(b.count)} rows (median ${num(b.medianPerActiveMinute)}), about ${usd(b.excessCost)} of excess spend</li>`,
        )
        .join("\n")}\n</ul>\n<p class="hint">A signal, not proof. A burst can be a legitimate queue flush or a batch job.</p>`,
    );
  }

  const savings: string[] = ['<h2>Savings estimate</h2>'];
  if (!a.pricesPath) {
    savings.push(`<p>No <code>--prices</code> file was given, so there is no estimate for another model. The tool never invents a price.</p>`);
  } else {
    if (a.illustrativePrices) savings.push(`<p class="warn"><strong>ILLUSTRATIVE ONLY.</strong> These prices are the shipped example numbers: made-up round figures, not quotes. Nothing here is a real estimate.</p>`);
    savings.push(`<p>Prices: <code>${esc(a.pricesPath)}</code>${a.pricesNote ? ` - ${esc(a.pricesNote)}` : ""}</p>`);
    for (const c of a.comparisons) {
      if (c.costOnTo === null) continue;
      savings.push(
        `<h3>if ${esc(c.to)} were acceptable for these calls</h3>
<ul>
<li>${esc(c.from)} in this file: ${num(c.fromInputTokens)} input + ${num(c.fromOutputTokens)} output tokens across ${num(c.fromRows)} rows, ${usd(c.fromActualCost)} actually spent</li>
<li>The same tokens on ${esc(c.to)}: <strong>${usd(c.costOnTo)}</strong> (difference ${usd(c.difference as number)} ${(c.difference as number) >= 0 ? "less" : "more"})</li>
</ul>
<p class="hint">"if ${esc(c.to)} were acceptable for these calls" is the question, not a claim the tool makes.</p>`,
      );
    }
    for (const n of a.comparisonNotes) savings.push(`<p class="hint">note: ${esc(n)}</p>`);
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI cost audit - ${esc(src)}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0 auto; max-width: 60rem; padding: 2rem 1.25rem 4rem; font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; color: #12161c; background: #f6f7f9; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.15rem; margin: 2rem 0 .5rem; border-top: 1px solid #d9dde3; padding-top: 1rem; }
  h3 { font-size: 1rem; margin: 1.25rem 0 .35rem; }
  p.lede { color: #4a5462; margin-top: 0; }
  table { border-collapse: collapse; width: 100%; margin: .5rem 0 1rem; background: #fff; }
  th, td { border: 1px solid #e1e5ea; padding: .35rem .55rem; text-align: left; font-variant-numeric: tabular-nums; }
  th { background: #eef1f5; font-weight: 600; }
  .bars { display: grid; gap: 6px; margin: .5rem 0 1rem; }
  .bar { display: grid; grid-template-columns: 13rem 1fr auto; align-items: center; gap: .6rem; }
  .bar .label { color: #3d4654; overflow-wrap: anywhere; }
  .bar .track { background: #e4e8ee; border-radius: 4px; height: 14px; display: block; }
  .bar .fill { display: block; height: 14px; background: #2f6feb; border-radius: 4px; }
  .bar .value { color: #3d4654; font-variant-numeric: tabular-nums; }
  .hint { color: #4a5462; font-size: .92rem; }
  .empty { color: #4a5462; }
  .warn { background: #fff4e5; border: 1px solid #f0c98a; padding: .6rem .8rem; border-radius: 6px; }
  footer { margin-top: 2.5rem; border-top: 1px solid #d9dde3; padding-top: 1rem; color: #3d4654; }
</style>
</head>
<body>
<h1>AI cost audit: ${esc(src)}</h1>
<p class="lede">Computed from <code>${esc(a.source)}</code> only. Nothing was uploaded; the tool read numbers and short labels from this one file and made no network call.</p>

<h2>Headline</h2>
${rowsHtml(
    ["Measure", "Value"],
    [
      ["Total spend", usd(a.totals.cost)],
      ["Total tokens", `${num(a.totals.tokens)} (input ${num(a.totals.input)} / output ${num(a.totals.output)})`],
      ["Exported rows read", num(a.totals.rows)],
      ["Rows skipped (unparsable)", num(a.rowsSkipped)],
      ["Requests (summed request column)", a.totals.requests === null ? "not in the file" : num(a.totals.requests)],
      ["Days in the file", a.timeRange ? `${num(a.timeRange.days)} (${a.timeRange.first} to ${a.timeRange.last})` : "0"],
    ],
  )}

<h2>Spend by day</h2>
${bars(a.byDay.map((d) => ({ label: d.day, value: d.cost, text: `${usd(d.cost)} - ${num(d.tokens)} tokens` })))}

<h2>Spend by model</h2>
${bars(a.byModel.map((m) => ({ label: m.model, value: m.cost, text: `${usd(m.cost)} - ${pct(m.share)}` })))}

<h2>Top 10 cost drivers</h2>
${rowsHtml(
    ["#", "Model", a.groupColumn ?? "Group", "Spend", "Tokens", "Rows"],
    a.topDrivers.map((d, i) => [String(i + 1), d.model, d.group ?? "-", usd(d.cost), num(d.tokens), num(d.rows)]),
  )}
<p class="hint">Biggest model: ${a.topModelShare ? `${esc(a.topModelShare.model)} at ${pct(a.topModelShare.share)} of spend` : "none"}.</p>

<h2>Spike days (more than 3x the median day)</h2>
<p>Median day: ${usd(a.medianDayCost)}; a spike is above ${usd(a.medianDayCost * 3)}.</p>
${a.spikes.length === 0 ? "<p>No day was more than 3x the median day.</p>" : `<ul>${a.spikes.map((s) => `<li>${esc(s.day)}: ${usd(s.cost)} (${s.multiple.toFixed(1)}x)</li>`).join("")}</ul>`}

<h2>Signals, not proof</h2>
${signals.join("\n")}

${savings.join("\n")}

<h2>What I measured</h2>
<ul>
<li>Read ${num(a.rowsRead)} rows from <code>${esc(a.source)}</code>; skipped ${num(a.rowsSkipped)} unparsable row(s).</li>
${a.timeRange ? `<li>Days present: ${esc(a.timeRange.first)} to ${esc(a.timeRange.last)} (${num(a.timeRange.days)} day(s)).</li>` : ""}
<li>Totals: ${usd(a.totals.cost)}, ${num(a.totals.tokens)} tokens.</li>
<li>Spike days found: ${num(a.spikes.length)}. Rows above the 95th percentile: ${num(a.contextBloat.rowsAbove)}. Loop-burst minutes: ${num(a.loopBursts.length)}.</li>
</ul>

<h2>What I am assuming</h2>
<ul>
${a.assumptions.map((line) => `<li>${esc(line)}</li>`).join("\n")}
</ul>

<footer>${esc(CLOSING_LINE)}</footer>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const CONSOLE_IO: Io = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

export interface CliOptions {
  file: string;
  prices?: string;
  maps: ColumnMap;
  out?: string;
  html?: string;
  json: boolean;
  allowExamplePrices: boolean;
  comparisons: Array<{ from: string; to: string }>;
}

export function parseArgs(argv: string[]): { ok: true; options: CliOptions } | { ok: false; error: string } {
  const options: CliOptions = { file: "", maps: {}, json: false, allowExamplePrices: false, comparisons: [] };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--prices") {
      const value = argv[++i];
      if (!value) return { ok: false, error: "--prices needs a JSON file path" };
      options.prices = value;
    } else if (arg === "--map") {
      const value = argv[++i];
      if (!value || !value.includes("=")) return { ok: false, error: `--map needs field=Column, got ${JSON.stringify(value ?? "")}` };
      const eq = value.indexOf("=");
      const field = value.slice(0, eq).trim() as Field;
      const column = value.slice(eq + 1).trim();
      if (!FIELD_ORDER.includes(field)) return { ok: false, error: `--map ${field}=...: field must be one of ${FIELD_ORDER.join("|")}` };
      if (column === "") return { ok: false, error: `--map ${field}=...: the column name is empty` };
      options.maps[field] = column;
    } else if (arg === "--out") {
      const value = argv[++i];
      if (!value) return { ok: false, error: "--out needs a file path" };
      options.out = value;
    } else if (arg === "--html") {
      const value = argv[++i];
      if (!value) return { ok: false, error: "--html needs a file path" };
      options.html = value;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--allow-example-prices") {
      options.allowExamplePrices = true;
    } else if (arg === "--compare") {
      const value = argv[++i];
      if (!value || !value.includes("=")) return { ok: false, error: `--compare needs modelA=modelB, got ${JSON.stringify(value ?? "")}` };
      const eq = value.indexOf("=");
      const from = value.slice(0, eq).trim();
      const to = value.slice(eq + 1).trim();
      if (from === "" || to === "") return { ok: false, error: `--compare ${value}: both model names are required` };
      options.comparisons.push({ from, to });
    } else if (arg === "--help" || arg === "-h") {
      return { ok: false, error: usage() };
    } else if (arg.startsWith("--")) {
      return { ok: false, error: `unknown argument ${JSON.stringify(arg)} - ${usage()}` };
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length === 0) return { ok: false, error: `no usage file given - ${usage()}` };
  if (positionals.length > 1) return { ok: false, error: `expected one usage file, got ${positionals.length}` };
  options.file = positionals[0];
  return { ok: true, options };
}

export function usage(): string {
  return "usage: cost-audit <usage.csv> [--map field=Column ...] [--prices prices.json] [--compare modelA=modelB ...] [--out report.md] [--html report.html] [--json] [--allow-example-prices]";
}

/** Returns the process exit code: 0 for a report, 1 for a refusal/missing column, 2 for bad arguments. */
export function main(argv: string[] = process.argv.slice(2), io: Io = CONSOLE_IO): number {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    io.err(`cost-audit: ${parsed.error}`);
    return 2;
  }
  const { options } = parsed;

  let text: string;
  try {
    text = fs.readFileSync(options.file, "utf8");
  } catch {
    io.err(`cost-audit: cannot read ${options.file}`);
    return 1;
  }

  const table = parseCsv(text);
  if (table.length < 2) {
    io.err(`cost-audit: ${options.file} has no data rows (a header and at least one row are needed)`);
    return 1;
  }
  const header = table[0];
  const dataRows = table.slice(1);

  const resolved = resolveColumns(header, options.maps);
  if (!resolved.ok) {
    io.err(`cost-audit: ${resolved.error}`);
    return 1;
  }
  if (resolved.missing.length > 0) {
    io.err(missingColumnsMessage(options.file, header, resolved.missing, resolved.unused));
    return 1;
  }

  const built = buildRows(header, dataRows, resolved.fields);
  if (built.rows.length === 0) {
    io.err(`cost-audit: ${options.file} has no usable data rows (${built.skipped} row(s) could not be parsed as date/model/tokens/cost)`);
    return 1;
  }

  let prices: LoadedPrices | null = null;
  if (options.prices !== undefined) {
    const loaded = loadPrices(options.prices);
    if (!loaded.ok) {
      io.err(`cost-audit: ${loaded.error}`);
      return 1;
    }
    if (loaded.prices.illustrative && !options.allowExamplePrices) {
      io.err(
        [
          `cost-audit: refusing to estimate savings from ${options.prices}.`,
          "  Its numbers are made-up examples, not quotes from any vendor.",
          "  Pass your own prices, or re-run with --allow-example-prices to see an illustrative-only example.",
        ].join("\n"),
      );
      return 1;
    }
    prices = loaded.prices;
  }

  const audit = buildAudit({
    source: options.file,
    rows: built.rows,
    skipped: built.skipped,
    columns: resolved.fields,
    mappedByUser: options.maps,
    prices,
    comparisons: options.comparisons,
  });

  const markdown = renderMarkdown(audit);
  if (options.out !== undefined) {
    fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
    fs.writeFileSync(options.out, markdown, "utf8");
    io.err(`cost-audit: wrote ${options.out}`);
  }
  if (options.html !== undefined) {
    fs.mkdirSync(path.dirname(path.resolve(options.html)), { recursive: true });
    fs.writeFileSync(options.html, renderHtml(audit), "utf8");
    io.err(`cost-audit: wrote ${options.html}`);
  }
  if (options.json) {
    io.out(JSON.stringify(audit, null, 2));
  } else if (options.out === undefined && options.html === undefined) {
    io.out(markdown);
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]).replace(/\.(ts|js)$/, "").toLowerCase() ===
    fileURLToPath(import.meta.url).replace(/\.(ts|js)$/, "").toLowerCase();

if (invokedDirectly) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(`cost-audit: unexpected error - ${String(e instanceof Error ? e.message : e)}`);
    process.exitCode = 1;
  }
}
