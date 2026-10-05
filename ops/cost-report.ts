#!/usr/bin/env node
/**
 * ops/cost-report.ts - "where did the tokens and money go" for the fleet (read-only).
 *
 *   npx tsx ops/cost-report.ts [--days N] [--by day|provider|model|worker] [--csv|--json]
 *
 * Reads three JSON-lines sources and skips malformed lines:
 *   - company/projects/<project>/cost.jsonl  one line per model call: {ts, modelId, costUsd, note}
 *   - logs/token-ledger.jsonl                one line per worker run: {date, name, turns, upload,
 *                                            download, cache_read, estUsd, endedBy}
 *   - logs/worker-providers.jsonl            one line per worker/day: {date, provider, name, model}
 *
 * The output is ALWAYS split into two blocks that are never mixed:
 *   == Prepaid credits (deepseek) ==                        real money from a prepaid balance
 *   == Subscription / quota (opencode-go, Claude, others) == usage inside a subscription or quota
 * A worker with no worker-providers record is never folded into either block: it lands in a
 * third "unknown provider" block, labelled "unknown provider".
 *
 * Rules baked in here:
 *   - read-only: nothing is written, no process is started, no network call is made
 *   - `--by` groups the rows inside each block (default `day`); rows sort by cost, biggest first
 *   - `--days N` keeps the N most recent days that actually appear in the data (clock-free)
 *   - tokens/turns are shown when a source recorded them, "-" / null / "" otherwise
 *   - ONE warning line when prepaid credits were spent on a day that also had opencode-go entries
 *   - empty data prints a friendly "no data" line and exits 0
 *
 * The pure parts (buildReport / renderText / renderCsv / renderJson) take a `root`, so the proof
 * harness (ops/cost-report-check.ts) runs the real code against a temporary folder.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A real, prepaid balance. Anything spent here is money that cannot be spent again. */
export const CREDIT_PROVIDER = "deepseek";
/** Subscription / quota providers named in the order (kept only to label the block). */
export const SUBSCRIPTION_PROVIDERS = ["opencode-go", "claude"];
/** Sentinel used for a worker that has no worker-providers record at all. */
export const UNKNOWN_PROVIDER = "unknown provider";
export const UNKNOWN_MODEL = "(unknown model)";

export const BLOCK_LABELS = {
  credits: `Prepaid credits (${CREDIT_PROVIDER})`,
  subscription: `Subscription / quota (${SUBSCRIPTION_PROVIDERS.join(", ")}, others)`,
  unknown: `Unknown provider (no worker-providers record)`,
} as const;

export const SOURCE_SUMMARY = "company/projects/*/cost.jsonl, logs/token-ledger.jsonl, logs/worker-providers.jsonl";

export type GroupBy = "day" | "provider" | "model" | "worker";
export type BlockId = keyof typeof BLOCK_LABELS;
export type Format = "text" | "csv" | "json";

export const GROUP_BY: GroupBy[] = ["day", "provider", "model", "worker"];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** One merged record: what a single source line contributes to the totals. */
export interface CostRecord {
  day: string;
  provider: string;
  model: string;
  worker: string;
  calls: number;
  turns: number;
  /** upload + download + cache_read; null when the source did not record tokens. */
  tokens: number | null;
  costUsd: number;
}

export interface ReportRow {
  key: string;
  calls: number;
  turns: number;
  tokens: number | null;
  costUsd: number;
}

export interface Totals {
  calls: number;
  turns: number;
  tokens: number;
  costUsd: number;
}

export interface ReportBlock {
  id: BlockId;
  label: string;
  rows: ReportRow[];
  totals: Totals;
}

export interface Report {
  by: GroupBy;
  /** The `--days` value that was applied, or null when every day is reported. */
  days: number | null;
  blocks: ReportBlock[];
  totals: Totals;
  /** Days actually reported, ascending. */
  windowDays: string[];
  /** Single warning line, or null when no credits were spent on a quota day. */
  warning: string | null;
  malformedLines: number;
  /** Relative paths that were read (or would have been read). */
  files: string[];
  rowCount: number;
  empty: boolean;
  message: string;
}

export interface BuildOptions {
  /** Folder that holds `logs/` and `company/projects/`. Default: the repo containing this file. */
  root?: string;
  by?: GroupBy;
  /** Keep only the N most recent days present in the data. null / undefined: keep all. */
  days?: number | null;
}

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Parse JSON lines. Blank lines are ignored; anything unusable counts as malformed. */
export function parseJsonl(text: string): { rows: Record<string, unknown>[]; malformed: number } {
  const rows: Record<string, unknown>[] = [];
  let malformed = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) rows.push(parsed as Record<string, unknown>);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  return { rows, malformed };
}

/**
 * Names a provider record may be filed under for a worker. `cost.jsonl` notes look like
 * "enhancer smumi4qyz-enhancer", so the whole note and its last token are both tried.
 */
export function providerLookupKeys(worker: string): string[] {
  const trimmed = worker.trim();
  const keys = trimmed ? [trimmed] : [];
  const last = trimmed.split(/\s+/).filter(Boolean).pop();
  if (last && last !== trimmed) keys.push(last);
  return keys;
}

/** Which block a provider belongs to. Unknown is its own block, never folded into the others. */
export function blockFor(provider: string): BlockId {
  const p = provider.trim().toLowerCase();
  if (p === CREDIT_PROVIDER) return "credits";
  if (p === UNKNOWN_PROVIDER || p === "") return "unknown";
  return "subscription";
}

export function groupKeyFor(record: CostRecord, by: GroupBy): string {
  switch (by) {
    case "provider":
      return record.provider;
    case "model":
      return record.model || UNKNOWN_MODEL;
    case "worker":
      return record.worker;
    case "day":
    default:
      return record.day;
  }
}

interface ProviderRecord {
  date: string;
  provider: string;
  name: string;
  model: string;
}

interface LoadResult {
  records: CostRecord[];
  providerRecords: ProviderRecord[];
  malformedLines: number;
  files: string[];
}

const emptyTotals = (): Totals => ({ calls: 0, turns: 0, tokens: 0, costUsd: 0 });

function relativeFile(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

/**
 * Read every source under `root`. Missing files are normal (a fresh checkout has none) and are
 * simply reported as read-with-nothing-in-them; broken lines increment `malformedLines`.
 */
export function loadData(root: string): LoadResult {
  const files: string[] = [];
  let malformedLines = 0;

  const readText = (file: string): string | null => {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
  };

  // ---- logs/worker-providers.jsonl ----
  const providersPath = path.join(root, "logs", "worker-providers.jsonl");
  const providerRecords: ProviderRecord[] = [];
  const providerText = readText(providersPath);
  if (providerText !== null) {
    files.push(relativeFile(root, providersPath));
    const parsed = parseJsonl(providerText);
    malformedLines += parsed.malformed;
    for (const row of parsed.rows) {
      const date = stringOrNull(row.date);
      const provider = stringOrNull(row.provider);
      const name = stringOrNull(row.name);
      if (!date || !DAY_RE.test(date) || !provider || !name || !name.trim()) {
        malformedLines++;
        continue;
      }
      providerRecords.push({ date, provider: provider.trim(), name: name.trim(), model: stringOrNull(row.model)?.trim() ?? "" });
    }
  }

  const providerByDayName = new Map<string, ProviderRecord>();
  for (const record of providerRecords) providerByDayName.set(`${record.date}\u0000${record.name}`, record);

  const lookup = (day: string, worker: string): ProviderRecord | undefined => {
    for (const key of providerLookupKeys(worker)) {
      const hit = providerByDayName.get(`${day}\u0000${key}`);
      if (hit) return hit;
    }
    return undefined;
  };

  const records: CostRecord[] = [];

  // ---- logs/token-ledger.jsonl ----
  const ledgerPath = path.join(root, "logs", "token-ledger.jsonl");
  const ledgerText = readText(ledgerPath);
  if (ledgerText !== null) {
    files.push(relativeFile(root, ledgerPath));
    const parsed = parseJsonl(ledgerText);
    malformedLines += parsed.malformed;
    for (const row of parsed.rows) {
      const date = stringOrNull(row.date);
      const name = stringOrNull(row.name);
      if (!date || !DAY_RE.test(date) || !name || !name.trim()) {
        malformedLines++;
        continue;
      }
      const fields: Array<[string, number]> = [["turns", 0], ["upload", 0], ["download", 0], ["cache_read", 0], ["estUsd", 0]];
      const values: Record<string, number> = {};
      let bad = false;
      for (const [key, fallback] of fields) {
        if (row[key] === undefined || row[key] === null) {
          values[key] = fallback;
          continue;
        }
        const n = numberOrNull(row[key]);
        if (n === null) {
          bad = true;
          break;
        }
        values[key] = n;
      }
      if (bad) {
        malformedLines++;
        continue;
      }
      const worker = name.trim();
      const provider = lookup(date, worker);
      const tokenParts = [row.upload, row.download, row.cache_read].filter((v) => v !== undefined && v !== null);
      records.push({
        day: date,
        provider: provider ? provider.provider : UNKNOWN_PROVIDER,
        model: provider ? provider.model : "",
        worker,
        calls: 0,
        turns: values.turns!,
        tokens: tokenParts.length ? values.upload! + values.download! + values.cache_read! : null,
        costUsd: values.estUsd!,
      });
    }
  }

  // ---- company/projects/<project>/cost.jsonl ----
  const projectsDir = path.join(root, "company", "projects");
  let projectDirs: string[] = [];
  try {
    projectDirs = fs
      .readdirSync(projectsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    projectDirs = [];
  }
  const costFiles = projectDirs
    .map((name) => path.join(projectsDir, name, "cost.jsonl"))
    .filter((file) => {
      try {
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    });
  if (projectDirs.length === 0) files.push("company/projects/*/cost.jsonl");
  for (const costFile of costFiles) {
    files.push(relativeFile(root, costFile));
    const text = readText(costFile);
    if (text === null) continue;
    const parsed = parseJsonl(text);
    malformedLines += parsed.malformed;
    for (const row of parsed.rows) {
      const ts = stringOrNull(row.ts);
      const day = ts ? ts.slice(0, 10) : "";
      const cost = numberOrNull(row.costUsd);
      if (!ts || !DAY_RE.test(day) || cost === null) {
        malformedLines++;
        continue;
      }
      const worker = (stringOrNull(row.note) ?? "").trim() || "(unnamed)";
      const provider = lookup(day, worker);
      records.push({
        day,
        provider: provider ? provider.provider : UNKNOWN_PROVIDER,
        model: (stringOrNull(row.modelId) ?? "").trim(),
        worker,
        calls: 1,
        turns: 0,
        tokens: null,
        costUsd: cost,
      });
    }
  }

  return { records, providerRecords, malformedLines, files };
}

function noDataMessage(root: string, files: string[]): string {
  const looked = files.length ? files.join(", ") : SOURCE_SUMMARY;
  return `cost-report: no data - nothing recorded in ${looked} under ${root}. Run the fleet once, then try again.`;
}

/** Aggregate the merged records into the two (or three) blocks the order requires. */
export function buildReport(options: BuildOptions = {}): Report {
  const root = path.resolve(options.root ?? REPO_ROOT);
  const by: GroupBy = options.by ?? "day";
  const days = options.days ?? null;
  const loaded = loadData(root);
  let records = loaded.records;

  // --days keeps the N most recent days that appear in the data, so the result never depends
  // on the wall clock and never comes back empty just because the last run was a while ago.
  let allDays = [...new Set(records.map((r) => r.day))].sort();
  if (days !== null && days > 0 && allDays.length > days) {
    const keep = new Set(allDays.slice(-days));
    records = records.filter((r) => keep.has(r.day));
    allDays = [...new Set(records.map((r) => r.day))].sort();
  }

  const buckets = new Map<BlockId, Map<string, { calls: number; turns: number; tokens: number; tokensSeen: boolean; costUsd: number }>>();
  for (const id of ["credits", "subscription", "unknown"] as BlockId[]) buckets.set(id, new Map());
  for (const record of records) {
    const id = blockFor(record.provider);
    const key = groupKeyFor(record, by);
    const bucket = buckets.get(id)!.get(key) ?? { calls: 0, turns: 0, tokens: 0, tokensSeen: false, costUsd: 0 };
    bucket.calls += record.calls;
    bucket.turns += record.turns;
    if (record.tokens !== null) {
      bucket.tokens += record.tokens;
      bucket.tokensSeen = true;
    }
    bucket.costUsd += record.costUsd;
    buckets.get(id)!.set(key, bucket);
  }

  const blocks: ReportBlock[] = [];
  const totals = emptyTotals();
  for (const id of ["credits", "subscription", "unknown"] as BlockId[]) {
    const bucket = buckets.get(id)!;
    const rows: ReportRow[] = [...bucket.entries()]
      .map(([key, value]) => ({
        key,
        calls: value.calls,
        turns: value.turns,
        tokens: value.tokensSeen ? value.tokens : null,
        costUsd: value.costUsd,
      }))
      // Biggest spend first; ties fall back to the key so the table is stable.
      .sort((a, b) => b.costUsd - a.costUsd || a.key.localeCompare(b.key));
    const blockTotals = emptyTotals();
    for (const row of rows) {
      blockTotals.calls += row.calls;
      blockTotals.turns += row.turns;
      blockTotals.tokens += row.tokens ?? 0;
      blockTotals.costUsd += row.costUsd;
      totals.calls += row.calls;
      totals.turns += row.turns;
      totals.tokens += row.tokens ?? 0;
      totals.costUsd += row.costUsd;
    }
    blocks.push({ id, label: BLOCK_LABELS[id], rows, totals: blockTotals });
  }

  const reportedDays = new Set(allDays);
  const quotaDays = new Set(
    loaded.providerRecords
      .filter((p) => p.provider.trim().toLowerCase() === "opencode-go" && reportedDays.has(p.date))
      .map((p) => p.date),
  );
  const creditDays = [...new Set(records.filter((r) => blockFor(r.provider) === "credits" && r.costUsd > 0).map((r) => r.day))].sort();
  const overlap = creditDays.filter((day) => quotaDays.has(day));
  const warning =
    overlap.length > 0
      ? `WARNING: prepaid credits were used on ${overlap.length} day(s) when quota was available (opencode-go): ${overlap.join(", ")}`
      : null;

  const rowCount = blocks.reduce((sum, block) => sum + block.rows.length, 0);
  const empty = rowCount === 0;
  return {
    by,
    days,
    blocks,
    totals,
    windowDays: allDays,
    warning,
    malformedLines: loaded.malformedLines,
    files: loaded.files,
    rowCount,
    empty,
    message: empty ? noDataMessage(root, loaded.files) : "",
  };
}

export function blockOf(report: Report, id: BlockId): ReportBlock {
  return report.blocks.find((b) => b.id === id) ?? { id, label: BLOCK_LABELS[id], rows: [], totals: emptyTotals() };
}

// ---------------------------------------------------------------- rendering --

function fmtInt(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function fmtTokens(value: number | null): string {
  return value === null ? "-" : fmtInt(value);
}

function fmtCost(value: number): string {
  return `$${value.toFixed(4)}`;
}

const KEY_WIDTH_MIN = 8;
const CALLS_WIDTH = 6;
const TURNS_WIDTH = 6;
const TOKENS_WIDTH = 12;
const COST_WIDTH = 10;

function tableLines(rows: ReportRow[], totals: Totals, keyHeader: string): string[] {
  const keyWidth = Math.max(KEY_WIDTH_MIN, "subtotal".length, keyHeader.length, ...rows.map((r) => r.key.length));
  const line = (key: string, calls: string, turns: string, tokens: string, cost: string): string =>
    key.padEnd(keyWidth) +
    calls.padStart(CALLS_WIDTH) +
    turns.padStart(TURNS_WIDTH) +
    tokens.padStart(TOKENS_WIDTH) +
    cost.padStart(COST_WIDTH);
  const out = [line(keyHeader, "CALLS", "TURNS", "TOKENS", "COST")];
  for (const row of rows) {
    out.push(line(row.key, String(row.calls), String(row.turns), fmtTokens(row.tokens), fmtCost(row.costUsd)));
  }
  out.push(line("subtotal", String(totals.calls), String(totals.turns), fmtTokens(totals.tokens), fmtCost(totals.costUsd)));
  return out;
}

export function renderText(report: Report): string {
  if (report.empty) return report.message;
  const lines: string[] = [];
  const first = report.windowDays[0] ?? "-";
  const last = report.windowDays[report.windowDays.length - 1] ?? "-";
  const byLabel = report.by === "day" ? "day" : report.by;
  lines.push(
    `cost-report: --by ${byLabel}${report.days !== null ? ` --days ${report.days}` : ""} | ${report.windowDays.length} day(s) ${first}..${last} | ` +
      `${report.totals.calls} call(s), ${report.totals.turns} turn(s), ${fmtTokens(report.totals.tokens)} token(s), ${fmtCost(report.totals.costUsd)} total`,
  );
  lines.push(`sources: ${report.files.join(", ")}`);
  for (const block of report.blocks) {
    if (block.id === "unknown" && block.rows.length === 0) continue;
    lines.push("");
    lines.push(`== ${block.label} ==`);
    lines.push(...tableLines(block.rows, block.totals, report.by.toUpperCase()));
  }
  lines.push("");
  lines.push(`total: ${fmtCost(report.totals.costUsd)} across ${report.rowCount} row(s)`);
  if (report.warning) lines.push(report.warning);
  if (report.malformedLines > 0) lines.push(`note: skipped ${report.malformedLines} malformed line(s)`);
  if (blockOf(report, "unknown").rows.length > 0) {
    lines.push(`note: ${blockOf(report, "unknown").rows.length} row(s) have no worker-providers record (${UNKNOWN_PROVIDER})`);
  }
  return lines.join("\n");
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function renderCsv(report: Report): string {
  const lines = ["block,key,calls,turns,tokens,cost_usd"];
  if (report.empty) return lines.join("\n");
  for (const block of report.blocks) {
    for (const row of block.rows) {
      lines.push(
        [
          csvCell(block.id),
          csvCell(row.key),
          String(row.calls),
          String(row.turns),
          row.tokens === null ? "" : String(row.tokens),
          row.costUsd.toFixed(6),
        ].join(","),
      );
    }
  }
  return lines.join("\n");
}

export function renderJson(report: Report): string {
  return JSON.stringify(
    {
      by: report.by,
      days: report.days,
      windowDays: report.windowDays,
      empty: report.empty,
      message: report.message || null,
      blocks: report.blocks.map((block) => ({
        id: block.id,
        label: block.label,
        rows: block.rows,
        totals: block.totals,
      })),
      totals: report.totals,
      rowCount: report.rowCount,
      warning: report.warning,
      malformedLines: report.malformedLines,
      sources: report.files,
    },
    null,
    2,
  );
}

export function render(report: Report, format: Format): string {
  if (format === "csv") return renderCsv(report);
  if (format === "json") return renderJson(report);
  return renderText(report);
}

// --------------------------------------------------------------------- CLI --

export interface CliOptions extends BuildOptions {
  format: Format;
}

export function parseArgs(argv: string[]): { ok: true; options: CliOptions } | { ok: false; error: string } {
  const options: CliOptions = { format: "text" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--csv" || arg === "--json") {
      options.format = arg === "--csv" ? "csv" : "json";
    } else if (arg === "--days") {
      const raw = argv[++i];
      const n = raw === undefined ? NaN : Number(raw);
      if (!Number.isInteger(n) || n < 1) return { ok: false, error: `--days needs a positive whole number, got ${raw === undefined ? "nothing" : JSON.stringify(raw)}` };
      options.days = n;
    } else if (arg === "--by") {
      const raw = argv[++i];
      if (!raw || !GROUP_BY.includes(raw as GroupBy)) return { ok: false, error: `--by needs one of ${GROUP_BY.join("|")}, got ${raw === undefined ? "nothing" : JSON.stringify(raw)}` };
      options.by = raw as GroupBy;
    } else if (arg === "--root") {
      const raw = argv[++i];
      if (!raw) return { ok: false, error: "--root needs a folder" };
      options.root = raw;
    } else if (arg === "--help" || arg === "-h") {
      return { ok: false, error: "usage: cost-report [--days N] [--by day|provider|model|worker] [--csv|--json] [--root DIR]" };
    } else {
      return { ok: false, error: `unknown argument ${JSON.stringify(arg)} - usage: cost-report [--days N] [--by day|provider|model|worker] [--csv|--json]` };
    }
  }
  return { ok: true, options };
}

export const CONSOLE_IO: Io = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

/** Returns the process exit code: 0 for a report (including "no data"), 2 for bad arguments. */
export function main(argv: string[] = process.argv.slice(2), io: Io = CONSOLE_IO): number {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    io.err(`cost-report: ${parsed.error}`);
    return 2;
  }
  const { format, ...build } = parsed.options;
  const report = buildReport(build);
  if (report.empty && format === "csv") {
    // Keep the CSV machine-readable: header on stdout, the friendly note on stderr.
    io.out(renderCsv(report));
    io.err(report.message);
    return 0;
  }
  io.out(render(report, format));
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
    console.error(`cost-report: unexpected error - ${String(e instanceof Error ? e.message : e)}`);
    process.exitCode = 1;
  }
}
