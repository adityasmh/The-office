#!/usr/bin/env node
/**
 * ops/cost-report-check.ts - proof for order F04-cost-report (2026-10-06).
 *
 * Runs the REAL report code (ops/cost-report.ts) against fixture JSONL files in a TEMPORARY
 * folder under the OS temp dir. Nothing in the repository is read except by the final CLI smoke
 * test (which is the report's own read-only run). No network calls, no processes started by the
 * report itself, `/company` is never written.
 *
 *   npx tsx ops/cost-report-check.ts
 *
 * Prints PASS or FAIL per line; exit code is 1 if any line is FAIL. Every date below is fixed,
 * so the checks do not depend on the wall clock.
 *
 * Fixture totals (5 valid calls, 3 valid ledger runs, 4 malformed lines):
 *   2026-10-04  w-quota   opencode-go  calls 1  turns 4  tokens 1600  $0.01 + $0.02 est = $0.03
 *   2026-10-05  w-credit  deepseek     calls 1  turns 6  tokens 3000  $0.02 + $0.03 est = $0.05
 *   2026-10-05  w-claude  claude       calls 1  turns -  tokens -     $0.05
 *   2026-10-05  w-quota   opencode-go  calls 1  turns -  tokens -     $0.03
 *   2026-10-05  w-mystery (no record)  turns 2  tokens 11            $0.01 est
 *   2026-10-06  w-credit  deepseek     calls 1  turns -  tokens -     $0.04
 *   totals: calls 5, turns 12, tokens 4611, $0.21
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BLOCK_LABELS,
  UNKNOWN_MODEL,
  UNKNOWN_PROVIDER,
  blockOf,
  buildReport,
  main,
  renderCsv,
  renderJson,
  renderText,
  type BlockId,
  type GroupBy,
  type Io,
  type Report,
  type ReportRow,
} from "./cost-report.js";

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HARNESS_DIR, "..");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? `  -> ${detail}` : ""}`);
}

const tempDirs: string[] = [];
function mkroot(tag: string, files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cost-report-check-${tag}-`));
  tempDirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, "utf8");
  }
  return dir;
}

const CLOSE = 1e-9;
const close = (a: number, b: number): boolean => Math.abs(a - b) < CLOSE;

// ---- fixture lines ---------------------------------------------------------
const PROVIDERS = [
  `{"date":"2026-10-04","provider":"opencode-go","name":"w-quota","model":"deepseek-v4-flash"}`,
  `{"date":"2026-10-04","provider":"deepseek","name":"w-credit","model":"deepseek-v4-pro"}`,
  `{"date":"2026-10-05","provider":"opencode-go","name":"w-quota","model":"deepseek-v4-flash"}`,
  `{"date":"2026-10-05","provider":"deepseek","name":"w-credit","model":"deepseek-v4-pro"}`,
  `{"date":"2026-10-05","provider":"claude","name":"w-claude","model":"claude-sonnet-5"}`,
  `{"date":"2026-10-06","provider":"deepseek","name":"w-credit","model":"deepseek-v4-pro"}`,
  `this line is not json at all`,
].join("\n");

const LEDGER = [
  `{"date":"2026-10-04","name":"w-quota","turns":4,"upload":1000,"download":100,"cache_read":500,"estUsd":0.02,"endedBy":"finished"}`,
  `{"date":"2026-10-05","name":"w-credit","turns":6,"upload":2000,"download":200,"cache_read":800,"estUsd":0.03,"endedBy":"finished"}`,
  `{"date":"2026-10-05","name":"w-mystery","turns":2,"upload":10,"download":1,"cache_read":0,"estUsd":0.01,"endedBy":"finished"}`,
  `{"date":"2026-10-05","name":"truncated-ledger-line"`,
].join("\n");

const COST_ALPHA = [
  `{"ts":"2026-10-04T10:00:00.000Z","modelId":"deepseek-v4-flash","costUsd":0.01,"note":"w-quota"}`,
  `{"ts":"2026-10-05T11:00:00.000Z","modelId":"claude-sonnet-5","costUsd":0.05,"note":"w-claude"}`,
  `{"ts":"2026-10-05T12:00:00.000Z","modelId":"deepseek-v4-pro","costUsd":0.02,"note":"w-credit"}`,
  `not json, not a cost line`,
].join("\n");

const COST_BETA = [
  `{"ts":"2026-10-05T13:00:00.000Z","modelId":"deepseek-v4-flash","costUsd":0.03,"note":"w-quota"}`,
  `{"ts":"2026-10-06T09:00:00.000Z","modelId":"deepseek-v4-pro","costUsd":0.04,"note":"w-credit"}`,
  `{"ts":"13-13-13T00:00:00.000Z","modelId":"deepseek-v4-pro","costUsd":9.99,"note":"w-credit"}`,
].join("\n");

function fixtureRoot(): string {
  return mkroot("main", {
    "logs/worker-providers.jsonl": PROVIDERS,
    "logs/token-ledger.jsonl": LEDGER,
    "company/projects/p-alpha/cost.jsonl": COST_ALPHA,
    "company/projects/p-beta/cost.jsonl": COST_BETA,
  });
}

interface ExpectRow {
  key: string;
  calls: number;
  turns: number;
  tokens: number | null;
  costUsd: number;
}

/** "" when the rows match the expectation, otherwise a human-readable difference. */
function diffRows(actual: ReportRow[], expected: ExpectRow[]): string {
  const byKey = new Map(actual.map((row) => [row.key, row]));
  const problems: string[] = [];
  for (const want of expected) {
    const got = byKey.get(want.key);
    if (!got) {
      problems.push(`missing row ${JSON.stringify(want.key)}`);
      continue;
    }
    byKey.delete(want.key);
    if (got.calls !== want.calls) problems.push(`${want.key}: calls ${got.calls} != ${want.calls}`);
    if (got.turns !== want.turns) problems.push(`${want.key}: turns ${got.turns} != ${want.turns}`);
    const tokensOk = want.tokens === null ? got.tokens === null : got.tokens !== null && close(got.tokens, want.tokens);
    if (!tokensOk) problems.push(`${want.key}: tokens ${String(got.tokens)} != ${String(want.tokens)}`);
    if (!close(got.costUsd, want.costUsd)) problems.push(`${want.key}: cost ${got.costUsd} != ${want.costUsd}`);
  }
  for (const key of byKey.keys()) problems.push(`unexpected row ${JSON.stringify(key)}`);
  if (actual.length !== expected.length) problems.push(`row count ${actual.length} != ${expected.length}`);
  return problems.join("; ");
}

function row(report: Report, blockId: "credits" | "subscription" | "unknown", key: string): ReportRow | undefined {
  return blockOf(report, blockId).rows.find((r) => r.key === key);
}

function isSortedByCostDesc(rows: ReportRow[]): boolean {
  for (let i = 1; i < rows.length; i++) {
    if (rows[i - 1]!.costUsd < rows[i]!.costUsd - CLOSE) return false;
  }
  return true;
}

/** Captures what main() would print, so the CLI path is proven without spawning anything. */
function capture(argv: string[]): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line) => out.push(line), err: (line) => err.push(line) };
  const code = main(argv, io);
  return { code, out, err };
}

function mainChecks(): void {
  const root = fixtureRoot();
  const base = buildReport({ root });
  const byProvider = buildReport({ root, by: "provider" });
  const text = renderText(base);

  // ---- 1: the two blocks are always separate (and unknown is its own block) ----
  const creditsAt = text.indexOf(`== ${BLOCK_LABELS.credits} ==`);
  const subscriptionAt = text.indexOf(`== ${BLOCK_LABELS.subscription} ==`);
  const unknownAt = text.indexOf(`== ${BLOCK_LABELS.unknown} ==`);
  check(
    "two blocks are separated: credits first, subscription second, unknown last",
    creditsAt >= 0 && subscriptionAt > creditsAt && unknownAt > subscriptionAt,
    `credits@${creditsAt}; subscription@${subscriptionAt}; unknown@${unknownAt}`,
  );
  const creditKeys = blockOf(base, "credits").rows.map((r) => r.key);
  check(
    "credits block holds only deepseek rows and the subscription block holds only non-deepseek rows",
    close(blockOf(base, "credits").totals.costUsd, 0.09) &&
      close(blockOf(base, "subscription").totals.costUsd, 0.11) &&
      close(blockOf(base, "unknown").totals.costUsd, 0.01),
    `credits=${creditKeys.join("|")} $${blockOf(base, "credits").totals.costUsd}; subscription=$${blockOf(base, "subscription").totals.costUsd}; unknown=$${blockOf(base, "unknown").totals.costUsd}`,
  );
  check(
    "subscription block names the quota providers from the order (opencode-go, claude)",
    blockOf(byProvider, "subscription").rows.some((r) => r.key === "opencode-go") &&
      blockOf(byProvider, "subscription").rows.some((r) => r.key === "claude"),
    `keys=${byProvider.blocks.find((b) => b.id === "subscription")?.rows.map((r) => r.key).join("|") ?? ""}`,
  );

  // ---- 2: grouping by day sums correctly -------------------------------------
  check(
    "grouping by day sums correctly",
    diffRows(blockOf(base, "credits").rows, [
      { key: "2026-10-05", calls: 1, turns: 6, tokens: 3000, costUsd: 0.05 },
      { key: "2026-10-06", calls: 1, turns: 0, tokens: null, costUsd: 0.04 },
    ]) === "" &&
      diffRows(blockOf(base, "subscription").rows, [
        { key: "2026-10-04", calls: 1, turns: 4, tokens: 1600, costUsd: 0.03 },
        { key: "2026-10-05", calls: 2, turns: 0, tokens: null, costUsd: 0.08 },
      ]) === "" &&
      diffRows(blockOf(base, "unknown").rows, [{ key: "2026-10-05", calls: 0, turns: 2, tokens: 11, costUsd: 0.01 }]) === "",
    [
      diffRows(blockOf(base, "credits").rows, [
        { key: "2026-10-05", calls: 1, turns: 6, tokens: 3000, costUsd: 0.05 },
        { key: "2026-10-06", calls: 1, turns: 0, tokens: null, costUsd: 0.04 },
      ]),
      diffRows(blockOf(base, "subscription").rows, [
        { key: "2026-10-04", calls: 1, turns: 4, tokens: 1600, costUsd: 0.03 },
        { key: "2026-10-05", calls: 2, turns: 0, tokens: null, costUsd: 0.08 },
      ]),
      diffRows(blockOf(base, "unknown").rows, [{ key: "2026-10-05", calls: 0, turns: 2, tokens: 11, costUsd: 0.01 }]),
    ]
      .filter(Boolean)
      .join(" | ") || `rows=${blockOf(base, "credits").rows.length}/${blockOf(base, "subscription").rows.length}/${blockOf(base, "unknown").rows.length}`,
  );

  // ---- 3: grouping by provider ----------------------------------------------
  check(
    "grouping by provider sums correctly",
    diffRows(blockOf(byProvider, "credits").rows, [{ key: "deepseek", calls: 2, turns: 6, tokens: 3000, costUsd: 0.09 }]) === "" &&
      diffRows(blockOf(byProvider, "subscription").rows, [
        { key: "opencode-go", calls: 2, turns: 4, tokens: 1600, costUsd: 0.06 },
        { key: "claude", calls: 1, turns: 0, tokens: null, costUsd: 0.05 },
      ]) === "" &&
      diffRows(blockOf(byProvider, "unknown").rows, [
        { key: UNKNOWN_PROVIDER, calls: 0, turns: 2, tokens: 11, costUsd: 0.01 },
      ]) === "",
    `credits=${blockOf(byProvider, "credits").rows.map((r) => r.key).join("|")}; subscription=${blockOf(byProvider, "subscription").rows.map((r) => r.key).join("|")}; unknown=${blockOf(byProvider, "unknown").rows.map((r) => r.key).join("|")}`,
  );

  // ---- 4: grouping by model --------------------------------------------------
  const byModel = buildReport({ root, by: "model" });
  check(
    "grouping by model sums correctly",
    diffRows(blockOf(byModel, "credits").rows, [
      { key: "deepseek-v4-pro", calls: 2, turns: 6, tokens: 3000, costUsd: 0.09 },
    ]) === "" &&
      diffRows(blockOf(byModel, "subscription").rows, [
        { key: "deepseek-v4-flash", calls: 2, turns: 4, tokens: 1600, costUsd: 0.06 },
        { key: "claude-sonnet-5", calls: 1, turns: 0, tokens: null, costUsd: 0.05 },
      ]) === "" &&
      diffRows(blockOf(byModel, "unknown").rows, [
        { key: UNKNOWN_MODEL, calls: 0, turns: 2, tokens: 11, costUsd: 0.01 },
      ]) === "",
    [
      diffRows(blockOf(byModel, "credits").rows, [{ key: "deepseek-v4-pro", calls: 2, turns: 6, tokens: 3000, costUsd: 0.09 }]),
      diffRows(blockOf(byModel, "subscription").rows, [
        { key: "deepseek-v4-flash", calls: 2, turns: 4, tokens: 1600, costUsd: 0.06 },
        { key: "claude-sonnet-5", calls: 1, turns: 0, tokens: null, costUsd: 0.05 },
      ]),
      diffRows(blockOf(byModel, "unknown").rows, [{ key: UNKNOWN_MODEL, calls: 0, turns: 2, tokens: 11, costUsd: 0.01 }]),
    ]
      .filter(Boolean)
      .join(" | ") || `credits=${blockOf(byModel, "credits").rows.map((r) => r.key).join("|")}`,
  );

  // ---- 5: grouping by worker -------------------------------------------------
  const byWorker = buildReport({ root, by: "worker" });
  check(
    "grouping by worker sums correctly",
    diffRows(blockOf(byWorker, "credits").rows, [{ key: "w-credit", calls: 2, turns: 6, tokens: 3000, costUsd: 0.09 }]) === "" &&
      diffRows(blockOf(byWorker, "subscription").rows, [
        { key: "w-quota", calls: 2, turns: 4, tokens: 1600, costUsd: 0.06 },
        { key: "w-claude", calls: 1, turns: 0, tokens: null, costUsd: 0.05 },
      ]) === "" &&
      diffRows(blockOf(byWorker, "unknown").rows, [
        { key: "w-mystery", calls: 0, turns: 2, tokens: 11, costUsd: 0.01 },
      ]) === "",
    [
      diffRows(blockOf(byWorker, "credits").rows, [{ key: "w-credit", calls: 2, turns: 6, tokens: 3000, costUsd: 0.09 }]),
      diffRows(blockOf(byWorker, "subscription").rows, [
        { key: "w-quota", calls: 2, turns: 4, tokens: 1600, costUsd: 0.06 },
        { key: "w-claude", calls: 1, turns: 0, tokens: null, costUsd: 0.05 },
      ]),
      diffRows(blockOf(byWorker, "unknown").rows, [{ key: "w-mystery", calls: 0, turns: 2, tokens: 11, costUsd: 0.01 }]),
    ]
      .filter(Boolean)
      .join(" | "),
  );

  // ---- 6: the totals do not depend on the grouping ---------------------------
  const groupingTotals = (["day", "provider", "model", "worker"] as GroupBy[]).map((by) => buildReport({ root, by }).totals);
  check(
    "totals are identical for every grouping (calls 5, turns 12, tokens 4611, $0.21)",
    groupingTotals.every((t) => t.calls === 5 && t.turns === 12 && t.tokens === 4611 && close(t.costUsd, 0.21)) &&
      close(base.totals.costUsd, 0.21) &&
      base.totals.calls === 5 &&
      base.totals.turns === 12 &&
      base.totals.tokens === 4611,
    `totals=${JSON.stringify(base.totals)}`,
  );
  check(
    "rows inside a block sort by cost, biggest first",
    (["day", "provider", "model", "worker"] as GroupBy[]).every((by) =>
      (["credits", "subscription", "unknown"] as BlockId[]).every((id) => isSortedByCostDesc(blockOf(buildReport({ root, by }), id).rows)),
    ),
    `subscription by provider: ${blockOf(byProvider, "subscription").rows.map((r) => `${r.key}=$${r.costUsd}`).join(", ")}`,
  );

  // ---- 7: --days filters -----------------------------------------------------
  const lastTwo = buildReport({ root, days: 2 });
  const lastOne = buildReport({ root, days: 1 });
  check(
    "--days 2 keeps the two most recent days present in the data",
    lastTwo.windowDays.join(",") === "2026-10-05,2026-10-06" &&
      lastTwo.totals.calls === 4 &&
      close(lastTwo.totals.costUsd, 0.18) &&
      lastTwo.totals.turns === 8 &&
      lastTwo.totals.tokens === 3011 &&
      blockOf(lastTwo, "subscription").rows.every((r) => r.key !== "2026-10-04"),
    `window=${lastTwo.windowDays.join(",")}; totals=${JSON.stringify(lastTwo.totals)}`,
  );
  check(
    "--days 1 keeps only the newest day and its rows",
    lastOne.windowDays.join(",") === "2026-10-06" &&
      lastOne.rowCount === 1 &&
      close(lastOne.totals.costUsd, 0.04) &&
      lastOne.totals.calls === 1 &&
      blockOf(lastOne, "credits").rows.length === 1 &&
      blockOf(lastOne, "subscription").rows.length === 0,
    `window=${lastOne.windowDays.join(",")}; rows=${lastOne.rowCount}; totals=${JSON.stringify(lastOne.totals)}`,
  );
  check(
    "days larger than the data keeps everything",
    buildReport({ root, days: 99 }).windowDays.join(",") === "2026-10-04,2026-10-05,2026-10-06" &&
      close(buildReport({ root, days: 99 }).totals.costUsd, 0.21),
    `window=${buildReport({ root, days: 99 }).windowDays.join(",")}`,
  );

  // ---- 8: malformed lines are skipped ---------------------------------------
  check(
    "malformed lines are skipped and counted (1 provider + 1 ledger + 1 cost + 1 bad day)",
    base.malformedLines === 4,
    `malformed=${base.malformedLines}; text has note=${text.includes("skipped 4 malformed line(s)")}`,
  );
  check(
    "a malformed cost line's amount never reaches the totals",
    close(base.totals.costUsd, 0.21) && !text.includes("9.99"),
    `total=$${base.totals.costUsd}`,
  );

  // ---- 9: CSV ---------------------------------------------------------------
  const csv = renderCsv(base);
  const csvLines = csv.split("\n");
  const csvHeader = csvLines[0] ?? "";
  const csvCost = csvLines.slice(1).reduce((sum, line) => sum + Number(line.split(",")[5]), 0);
  check(
    "CSV has a header and the right row count",
    csvHeader === "block,key,calls,turns,tokens,cost_usd" && csvLines.length === base.rowCount + 1 && base.rowCount === 5,
    `header=${JSON.stringify(csvHeader)}; lines=${csvLines.length}; rows=${base.rowCount}`,
  );
  check(
    "CSV rows carry the right blocks, a raw cost that sums to the total, and a blank for absent tokens",
    csvLines.slice(1).every((line) => ["credits", "subscription", "unknown"].includes(line.split(",")[0] ?? "")) &&
      close(csvCost, base.totals.costUsd) &&
      (csvLines.find((line) => line === "credits,2026-10-06,1,0,,0.040000") ?? "") !== "",
    `costSum=$${csvCost.toFixed(4)}; line=${JSON.stringify(csvLines.find((line) => line.startsWith("credits,2026-10-06")) ?? "")}`,
  );

  // ---- 10: JSON -------------------------------------------------------------
  let parsed: Report | null = null;
  let parseError = "";
  try {
    parsed = JSON.parse(renderJson(base)) as Report;
  } catch (e) {
    parseError = String(e instanceof Error ? e.message : e);
  }
  check(
    "JSON parses and carries both blocks, the totals and the warning",
    parsed !== null &&
      parsed.blocks.map((b) => b.id).join(",") === "credits,subscription,unknown" &&
      close(parsed.totals.costUsd, 0.21) &&
      typeof parsed.warning === "string" &&
      parsed.malformedLines === 4 &&
      parsed.rowCount === 5,
    parseError ? `parse error: ${parseError}` : `blocks=${parsed?.blocks.map((b) => b.id).join(",")}; total=${parsed?.totals.costUsd}`,
  );

  // ---- 11: unknown provider is visible --------------------------------------
  check(
    "a worker with no provider record is shown as \"unknown provider\"",
    text.includes(UNKNOWN_PROVIDER) &&
      text.includes(`== ${BLOCK_LABELS.unknown} ==`) &&
      blockOf(base, "unknown").rows.length === 1 &&
      blockOf(base, "unknown").rows[0]!.key === "2026-10-05",
    `unknown rows=${blockOf(base, "unknown").rows.map((r) => r.key).join("|")}`,
  );

  // ---- 12: tokens when present, "-" when absent -----------------------------
  const creditsOct6 = row(base, "credits", "2026-10-06");
  const subOct4 = row(base, "subscription", "2026-10-04");
  check(
    "tokens are shown when a source recorded them and \"-\" / null when it did not",
    creditsOct6?.tokens === null &&
      subOct4?.tokens === 1600 &&
      /(^|\n)2026-10-06 +1 +0 +- +\$0\.0400/.test(text) &&
      /(^|\n)2026-10-04 +1 +4 +1,600 +\$0\.0300/.test(text) &&
      parsed?.blocks[0]?.rows.find((r) => r.key === "2026-10-06")?.tokens === null,
    `oct6 tokens=${String(creditsOct6?.tokens)}; oct4 tokens=${String(subOct4?.tokens)}`,
  );

  // ---- 13: the one warning line --------------------------------------------
  const warningLines = text.split("\n").filter((line) => line.startsWith("WARNING"));
  check(
    "exactly one warning line, for the credit day that also had quota (2026-10-05)",
    warningLines.length === 1 &&
      warningLines[0]!.includes("2026-10-05") &&
      !warningLines[0]!.includes("2026-10-06") &&
      base.warning === warningLines[0],
    `warning=${JSON.stringify(base.warning)}`,
  );
  check(
    "no warning when the reported window has no quota day (--days 1)",
    lastOne.warning === null && !renderText(lastOne).includes("WARNING"),
    `warning=${JSON.stringify(lastOne.warning)}`,
  );

  // ---- 14: empty folder ---------------------------------------------------
  const emptyRoot = mkroot("empty", { "logs/.keep": "", "company/projects/.keep": "" });
  const empty = buildReport({ root: emptyRoot });
  const emptyText = renderText(empty);
  const emptyCli = capture(["--root", emptyRoot]);
  const emptyJson = capture(["--root", emptyRoot, "--json"]);
  let emptyParsed: Report | null = null;
  try {
    emptyParsed = JSON.parse(emptyJson.out.join("\n")) as Report;
  } catch {
    emptyParsed = null;
  }
  check(
    "empty folder prints a friendly \"no data\" message, exits 0, and still parses as JSON",
    empty.empty === true &&
      empty.rowCount === 0 &&
      /no data/i.test(emptyText) &&
      emptyCli.code === 0 &&
      /no data/i.test(emptyCli.out.join("\n")) &&
      emptyCli.err.length === 0 &&
      emptyJson.code === 0 &&
      emptyParsed?.empty === true &&
      emptyParsed?.blocks.length === 3,
    `text=${JSON.stringify(emptyText.slice(0, 90))}; exit=${emptyCli.code}; jsonExit=${emptyJson.code}`,
  );

  // ---- 15: arguments -----------------------------------------------------
  const goodCli = capture(["--root", root, "--by", "worker", "--days", "2"]);
  const badCli = capture(["--by", "nope"]);
  check(
    "the CLI path renders --by/--days and rejects a bad --by with exit 2",
    goodCli.code === 0 &&
      goodCli.out.join("\n").includes("--by worker") &&
      goodCli.out.join("\n").includes("w-credit") &&
      goodCli.out.join("\n").includes("w-quota") &&
      badCli.code === 2 &&
      badCli.out.length === 0 &&
      /--by needs one of/.test(badCli.err.join("\n")),
    `good=${goodCli.code}; bad=${badCli.code}; err=${JSON.stringify(badCli.err.join(" "))}`,
  );

  // ---- 16: the real CLI on the real repo (read-only) -----------------------
  const cli = spawnSync("npx --no-install tsx ops/cost-report.ts --json", {
    cwd: REPO_ROOT,
    encoding: "utf8",
    shell: true,
    timeout: 180000,
    windowsHide: true,
  });
  let cliJson: Report | null = null;
  let cliParseError = "";
  try {
    cliJson = JSON.parse((cli.stdout ?? "").trim()) as Report;
  } catch (e) {
    cliParseError = String(e instanceof Error ? e.message : e);
  }
  check(
    "real CLI `npx tsx ops/cost-report.ts --json` prints one parsable JSON report and exits 0",
    cliJson !== null &&
      Array.isArray(cliJson.blocks) &&
      cliJson.blocks.map((b) => b.id).join(",") === "credits,subscription,unknown" &&
      typeof cliJson.totals?.costUsd === "number" &&
      typeof cliJson.malformedLines === "number" &&
      cli.status === 0,
    cliParseError
      ? `parse error: ${cliParseError}; stderr=${JSON.stringify((cli.stderr ?? "").slice(0, 200))}`
      : `exit=${cli.status}; empty=${cliJson?.empty}; rows=${cliJson?.rowCount}; total=$${cliJson?.totals.costUsd}`,
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

console.log(failures === 0 ? "cost-report-check: all checks passed" : `cost-report-check: ${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
