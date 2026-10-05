// TRIAGE REPORT worker (fleet order fomupgip32/REPORT, role REPORT).
// Reads docs/perf/triage/results.json (see docs/perf/triage/TRIAGE_SPEC.md) and
// writes docs/perf/TRIAGE_CASCADE.md. Every number comes from results.json.
// Usage: npx tsx ops/triage-report.ts [--wait]
//   --wait  poll for results.json every 30s, up to 60 minutes, then stop.

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const RESULTS = path.join(ROOT, "docs", "perf", "triage", "results.json");
const OUT = path.join(ROOT, "docs", "perf", "TRIAGE_CASCADE.md");
const POLL_MS = 30_000;
const WAIT_MAX_MIN = 60;

interface CheapHeavy {
  flag: boolean;
  ms: number | null;
  costUsd: number | null;
  tokensIn?: number;
  tokensOut?: number;
}
interface Item {
  id: string;
  text?: string;
  truth: boolean;
  category: string;
  cheap: CheapHeavy;
  heavyCascade: CheapHeavy | null;
  heavyAll: CheapHeavy;
}
interface Results {
  run: {
    startedAt?: string;
    cheapModel: string;
    heavyModel: string;
    n: number;
    spendUsd: number | null;
    capUsd: number;
    capHit: boolean;
  };
  items: Item[];
}

function json(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "n/a";
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}
function usd(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "n/a";
  return "$" + n.toFixed(4);
}
function pct(n: number | null): string {
  if (n === null || Number.isNaN(n)) return "n/a";
  return (n * 100).toFixed(1) + "%";
}

function loadDatasetTexts(): Map<string, {text: string; category: string}> {
  const map = new Map<string, {text: string; category: string}>();
  const ds = path.join(ROOT, "docs", "perf", "triage", "dataset.jsonl");
  if (!fs.existsSync(ds)) return map;
  for (const line of fs.readFileSync(ds, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o && o.id) map.set(o.id, { text: String(o.text ?? ""), category: String(o.category ?? "") });
    } catch { /* skip malformed line */ }
  }
  return map;
}

interface Counts {
  tp: number; fp: number; tn: number; fn: number;
  precision: number | null; recall: number | null;
  f1: number | null; reachHeavy: number | null;
  meanMs: number | null; p50ms: number | null; p95ms: number | null;
  totalCost: number | null; costPerItem: number | null;
  costMeasuredEverywhere: boolean;
}

// ---- per-approach aggregation over items ----

function approachStats(items: Item[], kind: "cascade" | "cheap" | "heavyAll"): Counts {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  let totalCost = 0, costKnown = true;
  const ms: number[] = [];
  let msSum = 0, msCount = 0, reached = 0;
  for (const it of items) {
    let v: boolean;
    let itemCost = 0;
  let itemMs: number | null = null;
    if (kind === "cheap") {
      v = it.cheap.flag;
      if (it.cheap.costUsd !== null) itemCost += it.cheap.costUsd; else costKnown = false;
      itemMs = it.cheap.ms;
    } else if (kind === "cascade") {
      v = it.cheap.flag && (it.heavyCascade ? it.heavyCascade.flag : false);
      if (it.cheap.costUsd !== null) itemCost += it.cheap.costUsd; else costKnown = false;
      if (it.heavyCascade !== null) {
        reached++;
        if (it.heavyCascade.costUsd !== null) itemCost += it.heavyCascade.costUsd; else costKnown = false;
        // heavyCascade.ms is the measured cascade latency for that item
        // (cheap drain plus heavy), not the heavy call alone, so it is used
        // directly rather than added to the cheap ms.
        itemMs = it.heavyCascade.ms !== null ? it.heavyCascade.ms : it.cheap.ms;
      } else {
        itemMs = it.cheap.ms;
      }
    } else {
      v = it.heavyAll.flag;
      reached++; // heavy runs on everything
      if (it.heavyAll.costUsd !== null) itemCost += it.heavyAll.costUsd; else costKnown = false;
      itemMs = it.heavyAll.ms;
    }
    if (it.truth && v) tp++;
    else if (!it.truth && v) fp++;
    else if (!it.truth && !v) tn++;
    else fn++;
    totalCost += itemCost;
    if (itemMs !== null && Number.isFinite(itemMs)) { msSum += itemMs; msCount++; ms.push(itemMs); }
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  const f1 = precision !== null && recall !== null && precision + recall > 0
    ? (2 * precision * recall) / (precision + recall)
    : null;
  ms.sort((a, b) => a - b);
  const p50 = ms.length ? ms[Math.min(ms.length - 1, Math.floor((ms.length - 1) * 0.5))] : null;
  const p95 = ms.length ? ms[Math.min(ms.length - 1, Math.ceil((ms.length - 1) * 0.95))] : null;
  return {
    tp, fp, tn, fn, precision, recall, f1,
    reachHeavy: kind === "cascade" ? reached / items.length : kind === "heavyAll" ? 1 : 0,
    meanMs: msCount ? msSum / msCount : null, p50ms: p50, p95ms: p95,
    totalCost: costKnown ? totalCost : null,
    costPerItem: costKnown && items.length ? totalCost / items.length : null,
    costMeasuredEverywhere: costKnown,
  };
}

function countReachedHeavy(items: Item[]): number {
  return items.filter((it) => it.heavyCascade !== null).length;
}

interface Miss {
  id: string; category: string; excerpt: string; falsNeg: boolean; stage: string;
}

function misses(items: Item[]): Miss[] {
  const out: Miss[] = [];
  for (const it of items) {
    const cascade = it.cheap.flag && (it.heavyCascade ? it.heavyCascade.flag : false);
    if (it.truth && !cascade) {
      const stage = !it.cheap.flag ? "cheap screen" : "heavy (cascade)";
      out.push({ id: it.id, category: it.category, excerpt: excerpt(it.text), falsNeg: true, stage });
    } else if (!it.truth && cascade) {
      const stage = !it.heavyCascade ? "cheap screen" : "heavy (cascade)";
      out.push({ id: it.id, category: it.category, excerpt: excerpt(it.text), falsNeg: false, stage });
    }
  }
  return out;
}

function excerpt(t: string | undefined): string {
  if (!t) return "(no text in results.json)";
  const one = t.replace(/\s+/g, " ").trim();
  return one.length > 120 ? one.slice(0, 117) + "..." : one;
}

function esc(s: string): string {
  return s.replace(/\|/g, "\\|");
}

function main() {
  const waitArg = process.argv.includes("--wait");
  if (waitArg) {
    const deadline = Date.now() + WAIT_MAX_MIN * 60_000;
    while (!fs.existsSync(RESULTS)) {
      if (Date.now() > deadline) {
        console.error(`TIMEOUT: ${path.relative(ROOT, RESULTS)} did not appear within ${WAIT_MAX_MIN} minutes. Report not generated.`);
        process.exit(2);
      }
      console.log(`waiting for results.json (${Math.round((deadline - Date.now()) / 1000)}s left)...`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, POLL_MS);
    }
  }
  if (!fs.existsSync(RESULTS)) {
    console.error(`results.json not found at ${path.relative(ROOT, RESULTS)}. Report not generated.`);
    process.exit(2);
  }
  const r: Results = JSON.parse(fs.readFileSync(RESULTS, "utf8"));
  const items = r.items;
  const texts = loadDatasetTexts();
  for (const it of items) {
    if (!it.text && texts.has(it.id)) it.text = texts.get(it.id)!.text;
  }
  const n = items.length;

  const cascade = approachStats(items, "cascade");
  const cheap = approachStats(items, "cheap");
  const heavyAll = approachStats(items, "heavyAll");

  const reachedHeavy = countReachedHeavy(items);
  const pctReached = n ? reachedHeavy / n : null;

  const header = r.run;
  const moneyNote = cascade.costMeasuredEverywhere && heavyAll.costMeasuredEverywhere
    ? "all costs are present in results.json"
    : "some per-item costs are null in results.json; totals cover only the measured amounts and are marked n/a where unknown";

  const lines: string[] = [];
  lines.push("# Triage cascade evaluation report");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("Every number in this report is computed from `docs/perf/triage/results.json`");
  lines.push("(written by `ops/triage-cascade.ts`) at report time. Nothing is typed by hand.");
  lines.push("");
  lines.push("## Dataset and models");
  lines.push("");
  lines.push(`- Dataset size: ${n} items (results.json run.n = ${header.n}).`);
  lines.push(`- Cheap model: ${header.cheapModel}. Heavy model: ${header.heavyModel}.`);
  lines.push(`- Logging: run startedAt ${header.startedAt ?? "not recorded"}.`);
  const spend = header.spendUsd;
  lines.push(`- Recorded spend: ${spend === null || spend === undefined ? "n/a (not measured)" : "$" + spend.toFixed(4)} against a cap of $${header.capUsd.toFixed(2)}; cap hit: ${header.capHit ? "yes" : "no"}.`);
  lines.push(`- Costs: ${moneyNote}.`);
  lines.push("");
  lines.push("**This dataset is synthetic and text-only.** The items were generated from");
  lines.push("templates plus variation (see `docs/perf/triage/TRIAGE_SPEC.md`); no images, no");
  lines.push("real surveillance data, and no guarantee that performance transfers to real");
  lines.push("text. All conclusions below apply to this synthetic text dataset only.");
  lines.push("");
  lines.push("## Precision, recall, F1, and confusion counts");
  lines.push("");
  lines.push(`| Approach | Precision | Recall | F1 | TP | FP | TN | FN |`);
  lines.push(`|---|---|---|---|---|---|---|---|`);
  lines.push(`| Cascade (cheap AND heavy) | ${pct(cascade.precision)} | ${pct(cascade.recall)} | ${cascade.f1 === null ? "n/a" : cascade.f1.toFixed(3)} | ${cascade.tp} | ${cascade.fp} | ${cascade.tn} | ${cascade.fn} |`);
  lines.push(`| Heavy on everything | ${pct(heavyAll.precision)} | ${pct(heavyAll.recall)} | ${heavyAll.f1 === null ? "n/a" : heavyAll.f1.toFixed(3)} | ${heavyAll.tp} | ${heavyAll.fp} | ${heavyAll.tn} | ${heavyAll.fn} |`);
  lines.push(`| Cheap screen alone | ${pct(cheap.precision)} | ${pct(cheap.recall)} | ${cheap.f1 === null ? "n/a" : cheap.f1.toFixed(3)} | ${cheap.tp} | ${cheap.fp} | ${cheap.tn} | ${cheap.fn} |`);
  lines.push("");
  lines.push("Cascade verdict = cheap flag AND heavy flag (heavy runs only when the cheap");
  lines.push("screen flags). Heavy-on-everything runs the heavy model on all items.");
  lines.push("");
  lines.push("## Cost");
  lines.push("");
  lines.push(`| Approach | Cost per item | Total cost (${n} items) |`);
  lines.push(`|---|---|---|`);
  lines.push(`| Cascade | ${usd(cascade.costPerItem)} | ${usd(cascade.totalCost)} |`);
  lines.push(`| Heavy on everything | ${usd(heavyAll.costPerItem)} | ${usd(heavyAll.totalCost)} |`);
  lines.push(`| Cheap screen alone | ${usd(cheap.costPerItem)} | ${usd(cheap.totalCost)} |`);
  lines.push("");
  if (cascade.totalCost !== null && heavyAll.totalCost !== null && heavyAll.totalCost > 0) {
    lines.push(`**Cascade cost saving vs heavy-on-everything:** ${usd(heavyAll.totalCost - cascade.totalCost)} (${pct(1 - cascade.totalCost / heavyAll.totalCost)} cheaper).`);
  } else {
    lines.push("**Cascade cost saving vs heavy-on-everything:** n/a (a cost measurement is missing in results.json).");
  }
  if (cascade.totalCost !== null && cheap.totalCost !== null && cheap.totalCost > 0) {
    lines.push(`**Cheap screen alone vs cascade:** the cascade adds ${usd(cascade.totalCost - cheap.totalCost)} of heavy spend on ${pct(pctReached)} of items.`);
  }
  lines.push("");
  lines.push("## Latency");
  lines.push("");
  lines.push("| Approach | Mean ms/item | p50 ms | p95 ms |");
  lines.push("|---|---|---|---|");
  lines.push(`| Cascade | ${json(cascade.meanMs)} | ${json(cascade.p50ms)} | ${json(cascade.p95ms)} |`);
  lines.push(`| Heavy on everything | ${json(heavyAll.meanMs)} | ${json(heavyAll.p50ms)} | ${json(heavyAll.p95ms)} |`);
  lines.push(`| Cheap screen alone | ${json(cheap.meanMs)} | ${json(cheap.p50ms)} | ${json(cheap.p95ms)} |`);
  lines.push("");
  lines.push("Cascade latency = cheap latency plus heavy latency on reached items (items");
  lines.push("the cheap screen clears pay only the cheap latency). Latency saving");
  if (heavyAll.meanMs !== null && cascade.meanMs !== null) {
    lines.push(`**Cascade latency saving vs heavy-on-everything:** ${json(heavyAll.meanMs - cascade.meanMs)} ms per item on average (${pct(1 - cascade.meanMs / heavyAll.meanMs)} faster).`);
  } else {
    lines.push("**Cascade latency saving vs heavy-on-everything:** n/a (a latency measurement is missing in results.json).");
  }
  lines.push("");
  lines.push("## How far the cascade reaches");
  lines.push("");
  lines.push(`- ${pct(pctReached)} of items (${reachedHeavy} of ${n}) reached the heavy model in the cascade.`);
  lines.push(`- In heavy-on-everything, 100% of items reach the heavy model by construction.`);
  lines.push(`- In the cheap screen alone, 0% reach the heavy model.`);
  lines.push("");
  lines.push("## Misses (cascade)");
  lines.push("");
  const m = misses(items);
  const fns = m.filter((x) => x.falsNeg);
  const fps = m.filter((x) => !x.falsNeg);
  lines.push(`Total misses: ${m.length} (${fns.length} false negatives, ${fps.length} false positives).`);
  lines.push("");
  lines.push("### False negatives (relevant, cascade said not relevant)");
  if (fns.length === 0) {
    lines.push("");
    lines.push("_None._");
  } else {
    lines.push("");
    lines.push("| id | category | text excerpt | stage that dropped it |");
    lines.push("|---|---|---|---|");
    for (const x of fns) lines.push(`| ${x.id} | ${esc(x.category)} | ${esc(x.excerpt)} | ${x.stage} |`);
  }
  lines.push("");
  lines.push("### False positives (noise, cascade said relevant)");
  if (fps.length === 0) {
    lines.push("");
    lines.push("_None._");
  } else {
    lines.push("");
    lines.push("| id | category | text excerpt | stage that produced it |");
    lines.push("|---|---|---|---|");
    for (const x of fps) lines.push(`| ${x.id} | ${esc(x.category)} | ${esc(x.excerpt)} | ${x.stage} |`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("Source: `docs/perf/triage/results.json`. Generator: `ops/triage-report.ts`.");
  lines.push("");

  fs.writeFileSync(OUT, lines.join("\n"), "utf8");
  console.log(`wrote ${path.relative(ROOT, OUT)} (${n} items, cascade F1 ${cascade.f1 === null ? "n/a" : cascade.f1.toFixed(3)}, ${m.length} misses)`);
}

main();
