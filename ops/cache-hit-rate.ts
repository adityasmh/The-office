// CACHE-REPLAY (fleet order fomupgip2e): hit-rate replay for the decision cache.
//
// Replays real prompts from company/ project threads through the REAL
// classifyComplexity and classifyBrain (src/decision.ts) with the cache from
// src/decisionCache.ts active. On a miss the real Laya call on :8000 happens.
// Laya is never started or stopped here; if it is down the script says so and
// reports the hit rate only, with latency marked as not measured.
//
// Read-only on company/. Prints counts and numbers; any echoed prompt text is
// truncated to 60 chars. No secrets are read or printed (thread text is task
// briefs; nothing from .env is touched).
//
// Env: REPLAY_PASSES (default 2). Pass 1: DECISION_CACHE=1. Pass 2: the same
// prompts with DECISION_CACHE=0 as a no-cache baseline (module must not be in
// mock mode and must not be reading the flag at import time; the spec requires
// call-time reads, so setting process.env inside the process re-reads it).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyComplexity, classifyBrain } from "../src/decision.js";
import { cacheClear, cacheEnabled, cacheKey, cacheStats, normalisePrompt } from "../src/decisionCache.js";

const companyRoot = process.env.COMPANY_ROOT ?? "company";
const passes = Math.max(1, Number(process.env.REPLAY_PASSES ?? "2"));

type Entry = { ts: string; agent?: string; role?: string; kind?: string; text?: string; prompt?: string };
type Sample = { source: string; text: string; hint: string };

const PROMPT_KINDS = new Set(["intake", "task", "enhanced"]);

function trunc(s: string, n = 60): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}...` : t;
}

function collectThreadPrompts(threadPath: string): Sample[] {
  const out: Sample[] = [];
  let lines: string[] = [];
  try {
    lines = readFileSync(threadPath, "utf8").split("\n");
  } catch {
    return out;
  }
  for (const line of lines) {
    const l = line.trim();
    if (!l.startsWith("{")) continue;
    let e: Entry;
    try {
      e = JSON.parse(l) as Entry;
    } catch {
      continue;
    }
    const kind = String(e.kind ?? "");
    const text = typeof e.prompt === "string" ? e.prompt : typeof e.text === "string" ? e.text : "";
    if (!text.trim() || !PROMPT_KINDS.has(kind)) continue;
    // Task intake prompts and the enhancer's rewritten briefs, in file order:
    // these are the texts the pipeline actually classifies. Manager chatter,
    // worker reports and review verdicts are skipped.
    out.push({ source: `${threadPath.split(/[\\/]/).slice(-2, -1)[0]}#${out.length + 1}`, text, hint: kind });
    if (out.length >= 500) break;
  }
  return out;
}

function listThreadFiles(dir: string): string[] {
  const found: string[] = [];
  // company/projects/<id>/thread.jsonl only. The route through companyRoot is
  // one level deeper than callers may assume, so build the real path here.
  const projectsDir = join(dir, "projects");
  let names: string[];
  try {
    names = readdirSync(projectsDir, { withFileTypes: true }).map((d) => (d.isDirectory() ? d.name : ""));
  } catch {
    // Fallback: treat dir itself as the projects root.
    try {
      names = readdirSync(dir, { withFileTypes: true }).map((d) => (d.isDirectory() ? d.name : ""));
    } catch {
      return found;
    }
    for (const name of names.filter(Boolean)) {
      const p = join(dir, name, "thread.jsonl");
      try {
        readFileSync(p, "utf8");
        found.push(p);
      } catch {
        // Not a readable thread file: skip.
      }
    }
    return found;
  }
  for (const name of names.filter(Boolean)) {
    const p = join(projectsDir, name, "thread.jsonl");
    try {
      readFileSync(p, "utf8");
      found.push(p);
    } catch {
      // Not a readable thread file: skip read-only.
    }
  }
  return found;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}
function pctl(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1);
  return s[i];
}
function ms(n: number): string {
  return `${Math.round(n * 100) / 100} ms`;
}

type PassResult = {
  label: string;
  cacheOn: boolean;
  lookups: number;
  prompts: number;
  hits: number;
  misses: number;
  exactRepeats: number;
  rawRepeats: number;
  nearHits: number;
  latencies: number[]; // miss latency per classifier call (ms)
  mismatched: number;
  cacheSize: number;
  wallMs: number;
};

async function runPass(label: string, useCache: boolean, samples: Sample[]): Promise<PassResult> {
  cacheClear();
  const cacheOn = cacheEnabled();
  if (cacheOn !== useCache) {
    console.log(`[warn] pass ${label}: wanted DECISION_CACHE=${useCache ? 1 : 0}, module reports ${cacheOn ? 1 : 0}`);
  }
  const firstDecisionByKey = new Map<string, string>(); // key -> JSON of first decision
  const rawSeen = new Map<string, string>(); // key -> first raw text seen for that key
  let hits = 0;
  let misses = 0;
  let exactRepeats = 0;
  let rawRepeats = 0;
  let nearHits = 0;
  let mismatched = 0;
  const latencies: number[] = [];
  const t0 = Date.now();
  let lookups = 0;

  for (const s of samples) {
    for (const which of ["complexity", "brain"] as const) {
      lookups += 1;
      const key = cacheKey(which, s.text, s.hint);
      const isRawRepeat = firstDecisionByKey.has(key);
      const firstRawOfNorm = rawSeen.get(key);
      const st0 = cacheStats();
      const tStart = performance.now();
      const decision =
        which === "complexity" ? await classifyComplexity(s.text, s.hint) : await classifyBrain(s.text, s.hint);
      const dt = performance.now() - tStart;
      const st1 = cacheStats();
      const wasHit = st1.hits > st0.hits;
      if (wasHit) {
        hits += 1;
        if (isRawRepeat) {
          exactRepeats += 1;
          // Safety: the cached decision must equal the first decision for the same key.
          const first = firstDecisionByKey.get(key);
          if (first !== undefined && first !== JSON.stringify(decision)) {
            mismatched += 1;
            console.log(`[safety] MISMATCH on exact repeat ${which} ${s.source} ${trunc(s.text)}`);
          }
        } else if (firstRawOfNorm !== undefined && firstRawOfNorm !== s.text) {
          // Near-identical hit: the normalised key was seen before with a
          // different raw text.
          nearHits += 1;
        }
      } else {
        misses += 1;
        if (layaUp) latencies.push(dt);
        if (!isRawRepeat) firstDecisionByKey.set(key, JSON.stringify(decision));
      }
      if (firstRawOfNorm === undefined) rawSeen.set(key, s.text);
      else if (firstRawOfNorm === s.text) rawRepeats += 1;
    }
  }

  const st = cacheStats();
  return {
    label,
    cacheOn,
    lookups,
    prompts: samples.length,
    hits,
    misses,
    exactRepeats,
    rawRepeats,
    nearHits,
    latencies,
    mismatched,
    cacheSize: st.size,
    wallMs: Date.now() - t0,
  };
}

let layaUp = true;

function printPass(r: PassResult): void {
  const hitRate = r.lookups === 0 ? 0 : (r.hits / r.lookups) * 100;
  const meanMiss = mean(r.latencies);
  const p50 = pctl(r.latencies, 50);
  const p95 = pctl(r.latencies, 95);
  const saved = r.hits * meanMiss;
  console.log(`[pass ${r.label}] cache=${r.cacheOn ? 1 : 0} prompts=${r.prompts} lookups=${r.lookups}`);
  console.log(`[pass ${r.label}] exact repeats=${r.exactRepeats} near-identical hits (raw text differed)=${r.nearHits}`);
  console.log(
    `[pass ${r.label}] hits=${r.hits} misses=${r.misses} hit rate=${hitRate.toFixed(1)}% cache size=${r.cacheSize} raw repeats=${r.rawRepeats}`,
  );
  if (r.cacheOn && layaUp && r.latencies.length > 0) {
    console.log(`[pass ${r.label}] miss latency: mean=${ms(meanMiss)} p50=${ms(p50)} p95=${ms(p95)} (n=${r.latencies.length})`);
    console.log(
      `[pass ${r.label}] latency saved = hits x mean miss latency = ${r.hits} x ${ms(meanMiss)} = ${ms(saved)}`,
    );
  } else {
    console.log(`[pass ${r.label}] miss latency: not measured (laya reachable=${layaUp ? "yes" : "no"})`);
  }
  console.log(
    `[pass ${r.label}] exact-repeat safety: mismatches=${r.mismatched} -> ${r.mismatched === 0 ? "PASS" : "FAIL"}`,
  );
  console.log(`[pass ${r.label}] wall time=${r.wallMs} ms`);
}

async function main(): Promise<void> {
  console.log("=== decision-cache hit-rate replay (CACHE-REPLAY fomupgip2e) ===");
  const threads = listThreadFiles(companyRoot);
  const samples: Sample[] = [];
  for (const t of threads) samples.push(...collectThreadPrompts(t));
  console.log(`dataset: ${samples.length} prompts from ${threads.length} threads under ${trunc(companyRoot, 60)}`);
  if (samples.length === 0) {
    console.log("FAIL: no prompts found under company/");
    process.exitCode = 1;
    return;
  }

  // Laya reachability (GET only; never stopped or started by this script).
  try {
    const r = await fetch("http://127.0.0.1:8000/health", { method: "GET" });
    layaUp = r.status < 500;
  } catch {
    layaUp = false;
  }
  console.log(`laya :8000 reachable: ${layaUp ? "yes" : "no"}`);

  const results: PassResult[] = [];
  for (let i = 1; i <= passes; i += 1) {
    const useCache = i === 1;
    process.env.DECISION_CACHE = useCache ? "1" : "0";
    console.log(`--- pass ${i}/${passes}: DECISION_CACHE=${useCache ? "1" : "0"} ---`);
    const r = await runPass(`pass${i}`, useCache, samples);
    results.push(r);
    printPass(r);
  }
  console.log("done.");
}

main().catch((e) => {
  console.error("FAIL:", (e as Error)?.message ?? e);
  process.exitCode = 1;
});
