#!/usr/bin/env node
/**
 * ops/order-report.ts - a shareable post-mortem of any fleet order (read-only).
 *
 *   npx tsx ops/order-report.ts <orderId> [--html] [--out <file>] [--root <dir>]
 *
 * Reads `company/fleet/orders.json` and, per work order, the worker's report at
 * `company/fleet/<orderId>/<workOrderId>/REPORT.md`. Produces Markdown (default, to stdout or
 * `--out`) or ONE self-contained HTML file (inline CSS, no external assets) with the same content:
 *   - a summary: order text, status, duration, work order count and verdict counts
 *   - a timeline table built from `order.trace` (time, from, to, what), sorted chronologically
 *   - per work order: title, owned files, verdict, review trimmed to 600 characters, branch,
 *     PR link, CI state and the report (or "no report" when the worker never wrote one)
 *
 * Rules baked in here:
 *   - read-only: no repository file is written; `--out` writes only the file the caller asked for
 *   - every token-shaped string is redacted in the model, so Markdown and HTML are both safe
 *   - a missing REPORT.md is shown as "no report", never a crash
 *   - an unknown order id prints one plain error line and exits 1 (bad arguments exit 2)
 *
 * The pure parts (buildOrderReport / renderMarkdown / renderHtml) take a `root`, so the proof
 * harness (ops/order-report-check.ts) runs the real code against a temporary folder.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The review text shown per work order is trimmed to this many characters. */
export const MAX_REVIEW_CHARS = 600;
/** What a token-shaped string is replaced with. */
export const REDACTED = "[REDACTED]";
/** The fleet state file this report reads (repo-relative). */
export const ORDERS_REL = "company/fleet/orders.json";
/** Marker appended when a review was longer than MAX_REVIEW_CHARS. */
export const TRIMMED_MARKER = "... [trimmed]";

/**
 * Token-shaped strings. Each shape is replaced with REDACTED, in Markdown and HTML alike.
 * The list mirrors the shapes the secret scanner (ops/secret-scan.ts) knows about.
 */
export const TOKEN_RULES: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic style
  /\b(?:ghp|gho|ghs|ghr)_[A-Za-z0-9]{20,}/g, // GitHub token
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bxapp-[A-Za-z0-9-]{10,}/g, // Slack app-level
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, // Authorization header value
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // KEY=value / "secret": "..." assignments with a value long enough to be a secret.
  /\b(?:api[_-]?key|apikey|secret|token|password|passwd|access[_-]?key)\b\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{12,}["']?/gi,
];

/** Replaces every token-shaped string. Returns the safe text and how many replacements were made. */
export function redact(text: string): { text: string; hits: number } {
  let out = text;
  let hits = 0;
  for (const rule of TOKEN_RULES) {
    // A fresh RegExp per call: a shared /g regex would carry lastIndex across calls.
    out = out.replace(new RegExp(rule.source, rule.flags), () => {
      hits++;
      return REDACTED;
    });
  }
  return { text: out, hits };
}

export interface TraceRow {
  ts: string;
  /** Epoch ms, or null when the trace entry had no parsable timestamp. */
  at: number | null;
  from: string;
  to: string;
  what: string;
  detail: string;
}

export interface WorkOrderReport {
  id: string;
  title: string;
  role: string;
  state: string;
  owns: string[];
  verdict: "PASS" | "REDO" | null;
  /** Redacted, trimmed to MAX_REVIEW_CHARS. */
  review: string;
  reviewTrimmed: boolean;
  branch: string | null;
  prUrl: string | null;
  ciState: string | null;
  /** Repo-relative REPORT.md path that was looked for. */
  reportPath: string;
  /** True when a non-empty REPORT.md exists (a missing one is shown as "no report"). */
  reportWritten: boolean;
  /** First non-empty line of REPORT.md (redacted), when the file exists. */
  reportHeading: string | null;
  error: string | null;
}

export interface OrderReport {
  id: string;
  text: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  durationMs: number | null;
  durationText: string;
  plan: string | null;
  summary: string | null;
  error: string | null;
  workOrderCount: number;
  verdicts: { pass: number; redo: number; none: number };
  trace: TraceRow[];
  workOrders: WorkOrderReport[];
  /** Repo-relative path of the state file that was read. */
  ordersFile: string;
  /** How many REPORT.md files existed. */
  reportsFound: number;
  /** How many token-shaped strings were redacted across the whole model. */
  redactions: number;
}

export interface BuildOptions {
  /** Folder that holds `company/`. Default: the repo containing this file. */
  root?: string;
  orderId: string;
}

export type BuildResult = { ok: true; report: OrderReport } | { ok: false; error: string; notFound: boolean };

const str = (value: unknown): string => (typeof value === "string" ? value : value === undefined || value === null ? "" : String(value));

/** Trims a review to MAX_REVIEW_CHARS, appending a visible marker when it had to cut. */
export function trimReview(review: string): { text: string; trimmed: boolean } {
  if (review.length <= MAX_REVIEW_CHARS) return { text: review, trimmed: false };
  return { text: `${review.slice(0, MAX_REVIEW_CHARS)}${TRIMMED_MARKER}`, trimmed: true };
}

/** "1h 2m 3s" / "35m 0s" / "12s". Null when either end is unparsable. */
export function durationBetween(fromIso: string, toIso: string): { ms: number | null; text: string } {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return { ms: null, text: "unknown" };
  const ms = to - from;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return { ms, text: parts.join(" ") };
}

/** Builds the chronological timeline. Entries without a parsable time sort last, in file order. */
export function traceRows(raw: unknown): TraceRow[] {
  const list = Array.isArray(raw) ? raw : [];
  const indexed = list.map((entry, index) => {
    const o = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const ts = str(o.ts);
    const parsed = ts ? Date.parse(ts) : NaN;
    const row: TraceRow = {
      ts: ts || "(no time)",
      at: Number.isFinite(parsed) ? parsed : null,
      from: str(o.from),
      to: str(o.to),
      what: str(o.what),
      detail: str(o.detail),
    };
    return { index, row };
  });
  indexed.sort((a, b) => {
    if (a.row.at === null && b.row.at === null) return a.index - b.index;
    if (a.row.at === null) return 1;
    if (b.row.at === null) return -1;
    if (a.row.at !== b.row.at) return a.row.at - b.row.at;
    return a.index - b.index;
  });
  return indexed.map((item) => item.row);
}

const branchOf = (wo: Record<string, unknown>): string => {
  const delivery = (wo.delivery && typeof wo.delivery === "object" ? wo.delivery : {}) as Record<string, unknown>;
  return str(wo.branch) || str(delivery.branch);
};
const isHttp = (url: string): boolean => /^https?:\/\//i.test(url);

export function buildOrderReport(options: BuildOptions): BuildResult {
  const root = options.root ?? REPO_ROOT;
  const orderId = options.orderId;
  const file = path.join(root, "company", "fleet", "orders.json");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { ok: false, error: `cannot read ${ORDERS_REL} - ${e instanceof Error ? e.message : String(e)}`, notFound: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `cannot parse ${ORDERS_REL} - ${e instanceof Error ? e.message : String(e)}`, notFound: false };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: `${ORDERS_REL} is not an array of orders`, notFound: false };
  const order = parsed.find((entry) => !!entry && typeof entry === "object" && String((entry as Record<string, unknown>).id) === orderId);
  if (!order) return { ok: false, error: `unknown order id ${JSON.stringify(orderId)}`, notFound: true };
  const o = order as Record<string, unknown>;

  let redactions = 0;
  const rd = (value: unknown): string => {
    const result = redact(str(value));
    redactions += result.hits;
    return result.text;
  };
  const rdOpt = (value: unknown): string | null => (value === undefined || value === null || value === "" ? null : rd(value));

  const text = rd(o.text).replace(/\s+/g, " ").trim();
  const createdAt = rd(o.createdAt);
  const updatedAt = rd(o.updatedAt);
  const closedAt = rdOpt(o.closedAt);
  const duration = durationBetween(createdAt, closedAt ?? updatedAt);

  const rawWorkOrders = Array.isArray(o.workOrders) ? o.workOrders : [];
  const workOrders: WorkOrderReport[] = rawWorkOrders.map((entry) => {
    const wo = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const id = rd(wo.id);
    const reviewTrimmed = trimReview(str(wo.review));
    const review = rd(reviewTrimmed.text);
    const reportRel = path.posix.join("company", "fleet", orderId, id, "REPORT.md");
    const reportFile = path.join(root, "company", "fleet", orderId, id, "REPORT.md");
    let reportHeading: string | null = null;
    let reportWritten = false;
    try {
      const reportText = fs.readFileSync(reportFile, "utf8");
      reportWritten = reportText.trim().length > 0;
      const heading = reportText.split(/\r?\n/).find((line) => line.trim().length > 0);
      reportHeading = reportWritten && heading !== undefined ? rd(heading.trim()) : null;
    } catch {
      reportWritten = false; // "no report": the worker never wrote one, or the folder is gone
    }
    const verdict = wo.verdict === "PASS" || wo.verdict === "REDO" ? wo.verdict : null;
    const branch = rdOpt(branchOf(wo));
    const prUrl = rdOpt(wo.prUrl);
    return {
      id,
      title: rd(wo.title),
      role: rd(wo.role),
      state: rd(wo.state),
      owns: (Array.isArray(wo.owns) ? wo.owns : []).map((item) => rd(item)),
      verdict,
      review,
      reviewTrimmed: reviewTrimmed.trimmed,
      branch,
      prUrl,
      ciState: rdOpt(wo.ciState),
      reportPath: reportRel,
      reportHeading,
      reportWritten,
      error: rdOpt(wo.error),
    };
  });

  const verdicts = {
    pass: workOrders.filter((wo) => wo.verdict === "PASS").length,
    redo: workOrders.filter((wo) => wo.verdict === "REDO").length,
    none: workOrders.filter((wo) => wo.verdict === null).length,
  };

  const trace = traceRows(o.trace).map((row) => ({
    ts: rd(row.ts),
    at: row.at,
    from: rd(row.from),
    to: rd(row.to),
    what: rd(row.what),
    detail: rd(row.detail),
  }));

  return {
    ok: true,
    report: {
      id: rd(o.id),
      text,
      status: rd(o.status),
      createdAt,
      updatedAt,
      closedAt,
      durationMs: duration.ms,
      durationText: duration.text,
      plan: rdOpt(o.plan),
      summary: rdOpt(o.summary),
      error: rdOpt(o.error),
      workOrderCount: workOrders.length,
      verdicts,
      trace,
      workOrders,
      ordersFile: ORDERS_REL,
      reportsFound: workOrders.filter((wo) => wo.reportWritten).length,
      redactions,
    },
  };
}

// ------------------------------------------------------------------ render --

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}...`);

/** The 4th timeline column: `what`, with a clipped `detail` appended when the trace carried one. */
const whatCell = (row: TraceRow): string => (row.detail ? `${row.what}: ${clip(row.detail, 160)}` : row.what);

export function renderMarkdown(report: OrderReport): string {
  const lines: string[] = [];
  lines.push(`# Order report: ${report.id}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Order: ${report.text || "(no text)"}`);
  lines.push(`- Status: ${report.status}`);
  lines.push(`- Created: ${report.createdAt}`);
  if (report.closedAt) lines.push(`- Closed: ${report.closedAt}`);
  lines.push(`- Duration: ${report.durationText}${report.closedAt ? ` (${report.createdAt} -> ${report.closedAt})` : ` (${report.createdAt} -> ${report.updatedAt})`}`);
  lines.push(`- Work orders: ${report.workOrderCount}`);
  lines.push(`- Verdicts: ${report.verdicts.pass} PASS, ${report.verdicts.redo} REDO, ${report.verdicts.none} none`);
  lines.push(`- Reports: ${report.reportsFound} of ${report.workOrderCount} found`);
  lines.push(`- Redactions: ${report.redactions}`);

  lines.push("");
  lines.push("## Timeline");
  lines.push("");
  if (report.trace.length === 0) {
    lines.push("_no trace hops_");
  } else {
    lines.push("| Time | From | To | What |");
    lines.push("|---|---|---|---|");
    for (const row of report.trace) lines.push(`| ${row.ts} | ${row.from} | ${row.to} | ${whatCell(row)} |`);
  }

  lines.push("");
  lines.push("## Work orders");
  if (report.workOrders.length === 0) {
    lines.push("");
    lines.push("_no work orders_");
    return `${lines.join("\n")}\n`;
  }
  for (const wo of report.workOrders) {
    lines.push("");
    lines.push(`### ${wo.id} - ${wo.title}`);
    lines.push("");
    lines.push(`- Role: ${wo.role}`);
    lines.push(`- State: ${wo.state}`);
    lines.push(`- Owned files: ${wo.owns.length ? wo.owns.join(", ") : "(none)"}`);
    lines.push(`- Verdict: ${wo.verdict ?? "none"}`);
    lines.push(`- Branch: ${wo.branch ?? "-"}`);
    lines.push(`- PR: ${wo.prUrl ?? "-"}`);
    lines.push(`- CI: ${wo.ciState ?? "-"}`);
    lines.push(`- Report: ${wo.reportWritten ? wo.reportPath : "no report"}`);
    if (wo.reportHeading) lines.push(`- Report heading: ${wo.reportHeading}`);
    if (wo.error) lines.push(`- Error: ${wo.error}`);
    const reviewLines = wo.review.length ? wo.review.split(/\r?\n/) : ["(no review)"];
    lines.push("");
    lines.push(`Review${wo.reviewTrimmed ? ` (trimmed to ${MAX_REVIEW_CHARS} characters)` : ""}:`);
    for (const line of reviewLines) lines.push(`> ${line}`);
  }
  return `${lines.join("\n")}\n`;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "section";

export function renderHtml(report: OrderReport): string {
  const e = escapeHtml;
  const html: string[] = [];
  html.push("<!doctype html>");
  html.push('<html lang="en">');
  html.push("<head>");
  html.push('<meta charset="utf-8">');
  html.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  html.push(`<title>Order report ${e(report.id)}</title>`);
  html.push(
    // One self-contained file: inline CSS, no external asset of any kind.
    "<style>" +
      "body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;margin:0 auto;max-width:62rem;padding:1.5rem;color:#1a1a1a}" +
      "h1{margin:0 0 .25rem} h2{border-bottom:1px solid #ddd;padding-bottom:.2rem;margin-top:1.75rem}" +
      "table{border-collapse:collapse;width:100%} th,td{border:1px solid #ddd;padding:.25rem .5rem;text-align:left;vertical-align:top}" +
      "th{background:#f4f4f4} blockquote{margin:.25rem 0;padding:.25rem .75rem;border-left:3px solid #ccc;background:#fafafa}" +
      "dl{display:grid;grid-template-columns:11rem 1fr;gap:.15rem .75rem;margin:0} dt{color:#555} dd{margin:0}" +
      ".wo{border:1px solid #e3e3e3;border-radius:6px;padding:.75rem;margin:.75rem 0}" +
      "</style>",
  );
  html.push("</head>");
  html.push("<body>");
  html.push(`<h1>Order report: ${e(report.id)}</h1>`);

  html.push('<section id="summary"><h2>Summary</h2><dl>');
  const row = (key: string, value: string): void => {
    html.push(`<dt>${e(key)}</dt><dd>${value}</dd>`);
  };
  row("Order", e(report.text || "(no text)") || "(no text)");
  row("Status", e(report.status));
  row("Created", e(report.createdAt));
  if (report.closedAt) row("Closed", e(report.closedAt));
  row("Duration", `${e(report.durationText)} (${e(report.createdAt)} &rarr; ${e(report.closedAt ?? report.updatedAt)})`);
  row("Work orders", String(report.workOrderCount));
  row("Verdicts", `${report.verdicts.pass} PASS, ${report.verdicts.redo} REDO, ${report.verdicts.none} none`);
  row("Reports", `${report.reportsFound} of ${report.workOrderCount} found`);
  row("Redactions", String(report.redactions));
  html.push("</dl></section>");

  html.push('<section id="timeline"><h2>Timeline</h2>');
  if (report.trace.length === 0) {
    html.push("<p><em>no trace hops</em></p>");
  } else {
    html.push("<table><thead><tr><th>Time</th><th>From</th><th>To</th><th>What</th></tr></thead><tbody>");
    for (const r of report.trace) {
      html.push(`<tr><td>${e(r.ts)}</td><td>${e(r.from)}</td><td>${e(r.to)}</td><td>${e(whatCell(r))}</td></tr>`);
    }
    html.push("</tbody></table>");
  }
  html.push("</section>");

  html.push('<section id="work-orders"><h2>Work orders</h2>');
  if (report.workOrders.length === 0) html.push("<p><em>no work orders</em></p>");
  for (const wo of report.workOrders) {
    html.push(`<article class="wo" id="${e(slug(wo.id))}">`);
    html.push(`<h3>${e(wo.id)} - ${e(wo.title)}</h3>`);
    html.push("<dl>");
    row("Role", e(wo.role));
    row("State", e(wo.state));
    row("Owned files", wo.owns.length ? wo.owns.map((item) => `<code>${e(item)}</code>`).join(", ") : "(none)");
    row("Verdict", e(wo.verdict ?? "none"));
    row("Branch", e(wo.branch ?? "-"));
    row("PR", wo.prUrl ? (/^https?:\/\//i.test(wo.prUrl) ? `<a href="${e(wo.prUrl)}">${e(wo.prUrl)}</a>` : e(wo.prUrl)) : "-");
    row("CI", e(wo.ciState ?? "-"));
    row("Report", wo.reportWritten ? `<code>${e(wo.reportPath)}</code>` : "no report");
    if (wo.reportHeading) row("Report heading", e(wo.reportHeading));
    if (wo.error) row("Error", e(wo.error));
    html.push("</dl>");
    html.push(`<p>Review${wo.reviewTrimmed ? ` (trimmed to ${MAX_REVIEW_CHARS} characters)` : ""}:</p>`);
    if (wo.review.length) {
      html.push("<blockquote>");
      for (const line of wo.review.split(/\r?\n/)) html.push(e(line));
      html.push("</blockquote>");
    } else {
      html.push("<blockquote>(no review)</blockquote>");
    }
    html.push("</article>");
  }
  html.push("</section>");
  html.push("</body>");
  html.push("</html>");
  return `${html.join("\n")}\n`;
}

// --------------------------------------------------------------------- CLI --

export const USAGE = "usage: order-report <orderId> [--html] [--out <file>] [--root <dir>]";

export interface CliOptions {
  orderId: string;
  html: boolean;
  out: string | null;
  root?: string;
}

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const CONSOLE_IO: Io = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

export function parseArgs(argv: string[]): { ok: true; options: CliOptions } | { ok: false; error: string; code: number } {
  const options: CliOptions = { orderId: "", html: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--html") {
      options.html = true;
    } else if (arg === "--out") {
      const raw = argv[++i];
      if (!raw) return { ok: false, error: "--out needs a file", code: 2 };
      options.out = raw;
    } else if (arg === "--root") {
      const raw = argv[++i];
      if (!raw) return { ok: false, error: "--root needs a folder", code: 2 };
      options.root = raw;
    } else if (arg === "--help" || arg === "-h") {
      return { ok: false, error: USAGE, code: 0 };
    } else if (arg.startsWith("-")) {
      return { ok: false, error: `unknown argument ${JSON.stringify(arg)} - ${USAGE}`, code: 2 };
    } else if (options.orderId) {
      return { ok: false, error: `only one order id is allowed (got ${JSON.stringify(options.orderId)} and ${JSON.stringify(arg)})`, code: 2 };
    } else {
      options.orderId = arg;
    }
  }
  if (!options.orderId) return { ok: false, error: USAGE, code: 2 };
  return { ok: true, options };
}

/** 0 for a report, 1 for an unknown/unreadable order or an unwritable --out, 2 for bad arguments. */
export function main(argv: string[] = process.argv.slice(2), io: Io = CONSOLE_IO): number {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    if (parsed.code === 0) io.out(parsed.error);
    else io.err(`order-report: ${parsed.error}`);
    return parsed.code;
  }
  const { orderId, html, out, root } = parsed.options;
  const built = buildOrderReport({ root, orderId });
  if (!built.ok) {
    io.err(`order-report: ${built.error}`);
    return 1;
  }
  const text = html ? renderHtml(built.report) : renderMarkdown(built.report);
  if (out) {
    const target = path.resolve(out);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text, "utf8");
    } catch (e) {
      io.err(`order-report: cannot write ${out} - ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
    io.err(`order-report: wrote ${out}`);
    return 0;
  }
  io.out(text);
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
    console.error(`order-report: unexpected error - ${String(e instanceof Error ? e.message : e)}`);
    process.exitCode = 1;
  }
}
