#!/usr/bin/env node
/**
 * ops/order-report-check.ts - proof for order F05-order-report (2026-10-06).
 *
 * Runs the REAL report code (ops/order-report.ts) against a fixture `company/fleet/orders.json` and
 * fixture REPORT.md files in a TEMPORARY folder under the OS temp dir. The only read of the real
 * repository is the final CLI smoke test (which is the report's own read-only run). No network call,
 * no process started by the report itself, `company/` is never written.
 *
 *   npx tsx ops/order-report-check.ts
 *
 * Prints PASS or FAIL per line; exit code is 1 if any line is FAIL. Every timestamp below is fixed,
 * so the checks do not depend on the wall clock.
 *
 * Fixture: foFixtureA (done, 2 work orders, 4 trace hops written OUT of order, one PASS with a fake
 * token and a 900+ char review, one work order with no REPORT.md), foFixtureB (cancelled, empty).
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_REVIEW_CHARS,
  ORDERS_REL,
  REDACTED,
  TRIMMED_MARKER,
  buildOrderReport,
  main,
  renderHtml,
  renderMarkdown,
  type Io,
  type OrderReport,
} from "./order-report.js";

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HARNESS_DIR, "..");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? `  -> ${detail}` : ""}`);
}

const tempDirs: string[] = [];
function mkroot(tag: string, files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `order-report-check-${tag}-`));
  tempDirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, "utf8");
  }
  return dir;
}

/** Captures what main() would print, so the CLI path is proven without spawning anything. */
function capture(argv: string[]): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line) => out.push(line), err: (line) => err.push(line) };
  const code = main(argv, io);
  return { code, out, err };
}

/** SHA-256 over every file under `dir` (path + bytes), used to prove the report writes nothing. */
function treeHash(dir: string): string {
  const hash = crypto.createHash("sha256");
  const walk = (d: string): void => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) {
        walk(p);
      } else {
        hash.update(path.relative(dir, p).replace(/\\/g, "/"));
        hash.update(fs.readFileSync(p));
      }
    }
  };
  walk(dir);
  return hash.digest("hex");
}

// ---- fake credentials, assembled from pieces so no real value exists here -------------
const FAKE_GH = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const FAKE_SLACK = "xoxb-" + "123456789012-abcdefghijklmnop";
const FAKE_OPENAI = "sk-" + "Zq7pLm3nR8tV2wX5yB9cD4eF6gH1jK2";
const REVIEW_TAIL = "END-OF-REVIEW";
const LONG_REVIEW = `Leaked ${FAKE_GH} into the log. ` + "Reviewed the diff carefully. ".repeat(30) + REVIEW_TAIL;

const WO_1 = {
  id: "WO-1",
  title: "Write the doc",
  role: "jcode worker",
  owns: ["docs/a.md", "docs/b.md"],
  state: "reviewed",
  verdict: "PASS",
  review: LONG_REVIEW,
  branch: "fleet/wo-1",
  prUrl: "https://github.com/example/repo/pull/12",
  ciState: "GREEN",
  attempts: 1,
};
const WO_2 = {
  id: "WO-2",
  title: "Add the test",
  role: "jcode worker",
  owns: ["ops/b.ts"],
  state: "working",
  ciState: "PENDING",
  attempts: 1,
};

// The trace is deliberately out of order: the report must sort it chronologically.
const TRACE_UNSORTED = [
  { ts: "2026-10-06T00:30:00.000Z", from: "Claude (manager)", to: "CEO", what: "review PASS", detail: "both work orders accepted" },
  { ts: "2026-10-06T00:00:05.000Z", from: "CEO", to: "Claude (manager)", what: "order", detail: `GOAL: ship the thing token=${FAKE_SLACK}` },
  { ts: "2026-10-06T00:20:00.000Z", from: "Claude (manager)", to: "jcode:WO-1", what: "spawn" },
  { ts: "2026-10-06T00:10:00.000Z", from: "jcode:WO-1", to: "Claude (manager)", what: "report", detail: `key ${FAKE_OPENAI}` },
];

const FIXTURE_ORDERS = [
  {
    id: "foFixtureA",
    text: `Ship the thing (token=${FAKE_SLACK})`,
    status: "done",
    createdAt: "2026-10-06T00:00:00.000Z",
    updatedAt: "2026-10-06T00:35:00.000Z",
    trace: TRACE_UNSORTED,
    workOrders: [WO_1, WO_2],
  },
  {
    id: "foFixtureB",
    text: "Cancelled experiment",
    status: "cancelled",
    createdAt: "2026-10-06T01:00:00.000Z",
    updatedAt: "2026-10-06T01:00:30.000Z",
    trace: [],
    workOrders: [],
  },
];

function fixtureRoot(): string {
  return mkroot("main", {
    "company/fleet/orders.json": JSON.stringify(FIXTURE_ORDERS, null, 2),
    "company/fleet/foFixtureA/WO-1/REPORT.md": "# WO-1 report\n\nWrote the doc.\n",
  });
}

/** The timeline rows of the rendered Markdown table (skips the header and separator). */
function timelineTimes(markdown: string): string[] {
  const times: string[] = [];
  let inTable = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("| Time |")) {
      inTable = true;
      continue;
    }
    if (inTable) {
      if (!line.startsWith("|")) break;
      if (/^\|\s*-+/.test(line)) continue;
      const cell = line.split("|")[1]?.trim() ?? "";
      if (cell) times.push(cell);
    }
  }
  return times;
}

const isAscending = (times: string[]): boolean =>
  times.every((ts, i) => i === 0 || (Date.parse(times[i - 1]!) || 0) <= (Date.parse(ts) || 0));

function mainChecks(): void {
  const root = fixtureRoot();
  const before = treeHash(root);
  const built = buildOrderReport({ root, orderId: "foFixtureA" });
  if (!built.ok) {
    check("the fixture order builds without error", false, built.error);
    return;
  }
  const report: OrderReport = built.report;
  const markdown = renderMarkdown(report);
  const html = renderHtml(report);

  // ---- 1: all sections --------------------------------------------------------
  const labels = ["- Role:", "- State:", "- Owned files:", "- Verdict:", "- Branch:", "- PR:", "- CI:", "- Report:"];
  check(
    "markdown has all sections (summary, timeline, work orders, both work orders)",
    markdown.includes("# Order report: foFixtureA") &&
      markdown.includes("## Summary") &&
      markdown.includes("## Timeline") &&
      markdown.includes("## Work orders") &&
      markdown.includes("### WO-1 - Write the doc") &&
      markdown.includes("### WO-2 - Add the test") &&
      labels.every((l) => markdown.includes(l)),
    `sections=summary,timeline,work-orders; labels=${labels.length}`,
  );

  // ---- 2: summary -------------------------------------------------------------
  check(
    "summary carries the order text, status, duration, work order count and verdicts",
    report.text === "Ship the thing (token=[REDACTED])" &&
      report.status === "done" &&
      report.durationText === "35m 0s" &&
      report.durationMs === 35 * 60 * 1000 &&
      report.workOrderCount === 2 &&
      report.verdicts.pass === 1 &&
      report.verdicts.redo === 0 &&
      report.verdicts.none === 1 &&
      markdown.includes("- Status: done") &&
      markdown.includes("- Duration: 35m 0s") &&
      markdown.includes("- Work orders: 2") &&
      markdown.includes("- Verdicts: 1 PASS, 0 REDO, 1 none"),
    `status=${report.status}; duration=${report.durationText}; workOrders=${report.workOrderCount}; verdicts=${report.verdicts.pass}/${report.verdicts.redo}/${report.verdicts.none}`,
  );

  // ---- 3: chronology ----------------------------------------------------------
  const times = timelineTimes(markdown);
  const sortedFixture = [...TRACE_UNSORTED].map((t) => t.ts).sort((a, b) => Date.parse(a) - Date.parse(b));
  check(
    "the timeline is chronological and holds every hop (fixture trace is out of order)",
    times.length === TRACE_UNSORTED.length && isAscending(times) && times.join(",") === sortedFixture.join(","),
    `rendered=${times.join(" | ")}`,
  );

  // ---- 4: per work order ------------------------------------------------------
  check(
    "each work order shows title, owned files, verdict, branch, PR link and CI state",
    markdown.includes("### WO-1 - Write the doc") &&
      markdown.includes("- Owned files: docs/a.md, docs/b.md") &&
      markdown.includes("- Verdict: PASS") &&
      markdown.includes("- Branch: fleet/wo-1") &&
      markdown.includes("- PR: https://github.com/example/repo/pull/12") &&
      markdown.includes("- CI: GREEN") &&
      markdown.includes("- CI: PENDING") &&
      markdown.includes("- Verdict: none"),
    "WO-1 has verdict/branch/PR/CI, WO-2 renders 'none' without crashing",
  );

  // ---- 5: missing REPORT.md ---------------------------------------------------
  check(
    "a missing REPORT.md is shown as \"no report\" without a crash",
    report.workOrders[1]?.reportWritten === false &&
      report.workOrders[1]?.reportHeading === null &&
      report.reportsFound === 1 &&
      markdown.includes("- Report: no report") &&
      markdown.includes("- Report: company/fleet/foFixtureA/WO-1/REPORT.md"),
    `reportsFound=${report.reportsFound}; WO2=${report.workOrders[1]?.reportPath}`,
  );
  check(
    "an existing REPORT.md is read and its heading shown",
    report.workOrders[0]?.reportWritten === true && report.workOrders[0]?.reportHeading === "# WO-1 report",
    `heading=${JSON.stringify(report.workOrders[0]?.reportHeading)}`,
  );

  // ---- 6: redaction -----------------------------------------------------------
  check(
    "a fake token in a review is redacted in the model, the Markdown and the HTML",
    !report.workOrders[0]!.review.includes(FAKE_GH) &&
      markdown.includes(REDACTED) &&
      html.includes(REDACTED) &&
      !markdown.includes(FAKE_GH) &&
      !html.includes(FAKE_GH),
    `raw token in output: md=${markdown.includes(FAKE_GH)}; html=${html.includes(FAKE_GH)}`,
  );
  check(
    "tokens in the order text and in a trace detail are redacted too",
    !markdown.includes(FAKE_SLACK) &&
      !markdown.includes(FAKE_OPENAI) &&
      !html.includes(FAKE_SLACK) &&
      !html.includes(FAKE_OPENAI) &&
      markdown.includes("Ship the thing (token=[REDACTED])"),
    "order text and trace detail both carry [REDACTED]",
  );
  check(
    "redactions are counted in the summary line",
    report.redactions >= 3 && markdown.includes(`- Redactions: ${report.redactions}`),
    `redactions=${report.redactions}`,
  );

  // ---- 7: the 600-character trim ---------------------------------------------
  check(
    `the review is trimmed to ${MAX_REVIEW_CHARS} characters with a visible marker`,
    report.workOrders[0]!.reviewTrimmed === true &&
      report.workOrders[0]!.review.length <= MAX_REVIEW_CHARS + TRIMMED_MARKER.length &&
      report.workOrders[0]!.review.includes(TRIMMED_MARKER) &&
      markdown.includes("trimmed to 600 characters") &&
      !markdown.includes(REVIEW_TAIL) &&
      !html.includes(REVIEW_TAIL),
    `reviewLength=${report.workOrders[0]!.review.length}`,
  );

  // ---- 8: self-contained HTML -------------------------------------------------
  const externalAsset = /<link\b|<script\b|<img\b|@import|url\(\s*['"]?https?:|\bsrc=/i.test(html);
  check(
    "HTML is self-contained (doctype, inline style, zero external assets)",
    /^<!doctype html>/i.test(html.trim()) &&
      html.includes("<style>") &&
      !externalAsset &&
      !html.includes("<link") &&
      html.includes('href="https://github.com/example/repo/pull/12"'),
    `externalAsset=${externalAsset}; bytes=${html.length}`,
  );
  check(
    "HTML carries the same content as the Markdown (sections, verdicts, no report)",
    html.includes("<h1>Order report: foFixtureA</h1>") &&
      html.includes("<h2>Summary</h2>") &&
      html.includes("<h2>Timeline</h2>") &&
      html.includes("<h2>Work orders</h2>") &&
      html.includes("1 PASS, 0 REDO, 1 none") &&
      html.includes("no report") &&
      html.includes("<table>") &&
      html.includes("WO-1") &&
      html.includes("WO-2"),
    "summary/timeline/work orders all present in HTML",
  );

  // ---- 9: unknown id ----------------------------------------------------------
  const unknown = capture(["--root", root, "foNope"]);
  check(
    "an unknown order id exits 1 with one plain error line and no stack trace",
    unknown.code === 1 &&
      unknown.out.length === 0 &&
      unknown.err.length === 1 &&
      unknown.err[0]!.includes('unknown order id "foNope"') &&
      !/\n\s+at /.test(unknown.err[0]!) &&
      !/Error:/.test(unknown.err[0]!),
    `exit=${unknown.code}; err=${JSON.stringify(unknown.err[0])}`,
  );

  // ---- 10: empty order --------------------------------------------------------
  const emptyBuilt = buildOrderReport({ root, orderId: "foFixtureB" });
  const emptyMd = emptyBuilt.ok ? renderMarkdown(emptyBuilt.report) : "";
  const emptyCli = capture(["--root", root, "foFixtureB"]);
  check(
    "an order with no work orders and no trace renders empty sections, not a crash",
    emptyBuilt.ok === true &&
      emptyCli.code === 0 &&
      emptyMd.includes("_no trace hops_") &&
      emptyMd.includes("_no work orders_") &&
      emptyMd.includes("- Verdicts: 0 PASS, 0 REDO, 0 none"),
    `exit=${emptyCli.code}`,
  );

  // ---- 11: arguments ----------------------------------------------------------
  const noArgs = capture([]);
  const help = capture(["--help"]);
  check(
    "bad arguments exit 2 with the usage, --help exits 0",
    noArgs.code === 2 && noArgs.err.join(" ").includes("usage: order-report") && help.code === 0 && help.out.join(" ").includes("usage: order-report"),
    `noArgs=${noArgs.code}; help=${help.code}`,
  );

  // ---- 12: --out --------------------------------------------------------------
  const outDir = mkroot("out");
  const outMd = path.join(outDir, "report.md");
  const outHtml = path.join(outDir, "report.html");
  const okMd = capture(["--root", root, "foFixtureA", "--out", outMd]);
  const okHtml = capture(["--root", root, "foFixtureA", "--html", "--out", outHtml]);
  const writtenMd = fs.existsSync(outMd) ? fs.readFileSync(outMd, "utf8") : "";
  const writtenHtml = fs.existsSync(outHtml) ? fs.readFileSync(outHtml, "utf8") : "";
  check(
    "--out writes the Markdown (byte-identical to stdout) and leaves stdout clean",
    okMd.code === 0 && okMd.out.length === 0 && writtenMd === markdown && okMd.err.join(" ").includes("wrote"),
    `exit=${okMd.code}; bytes=${writtenMd.length}`,
  );
  check(
    "--html --out writes one self-contained HTML file",
    okHtml.code === 0 && okHtml.out.length === 0 && /^<!doctype html>/i.test(writtenHtml.trim()) && writtenHtml === html,
    `exit=${okHtml.code}; bytes=${writtenHtml.length}`,
  );

  // ---- 13: read-only ----------------------------------------------------------
  check(
    "the report wrote nothing into the tree it read (fixture tree byte-identical before/after)",
    treeHash(root) === before,
    `before=${before.slice(0, 12)}; after=${treeHash(root).slice(0, 12)}`,
  );

  // ---- 14: the real CLI on the real repo (read-only) --------------------------
  let realId = "";
  try {
    const real = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ORDERS_REL), "utf8")) as Array<{ id?: unknown }>;
    if (Array.isArray(real) && real.length > 0 && typeof real[0]?.id === "string") realId = real[0].id;
  } catch {
    realId = "";
  }
  if (realId) {
    const cli = spawnSync(`npx --no-install tsx ops/order-report.ts ${realId}`, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      shell: true,
      timeout: 180000,
      windowsHide: true,
    });
    check(
      "real CLI prints a Markdown report for a real order and exits 0",
      cli.status === 0 && (cli.stdout ?? "").includes("# Order report:") && (cli.stdout ?? "").includes("## Timeline") && (cli.stdout ?? "").includes("## Work orders"),
      `exit=${cli.status}; id=${realId}; stderr=${JSON.stringify((cli.stderr ?? "").slice(0, 160))}`,
    );
  } else {
    const cli = spawnSync("npx --no-install tsx ops/order-report.ts foNoSuchOrder", {
      cwd: REPO_ROOT,
      encoding: "utf8",
      shell: true,
      timeout: 180000,
      windowsHide: true,
    });
    check(
      "real CLI unknown-id path exits 1 (no real orders in the tree to report)",
      cli.status === 1 && /unknown order id/.test(cli.stderr ?? "") && (cli.stdout ?? "").trim() === "",
      `exit=${cli.status}; stderr=${JSON.stringify((cli.stderr ?? "").slice(0, 160))}`,
    );
  }
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

console.log(failures === 0 ? "order-report-check: all checks passed" : `order-report-check: ${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
