/**
 * ops/laya-gpu-bench.ts — before/after harness for moving Laya from CPU to the
 * RTX 4050. Read-only: it never writes company/ files, never dispatches work and
 * never restarts anything. It only POSTs decisions to a Laya server and reads
 * company/org.json for the team roster.
 *
 * Two modes:
 *   --bench [n]   n sequential /v1/systemone calls (default 20) with the EXACT
 *                 dispatch wire payload (state+questions from agentQuestionSpec,
 *                 the same function src/company/dispatch.ts sends). Prints every
 *                 call's ms + the answer, then min/p50/p95/max/mean.
 *   --parity      the 5 fixed test questions, run through the REAL pipeline
 *                 functions (chooseAgent, classifyComplexity, chooseBestModel,
 *                 classifyBrain, decideRoute). Prints one compact line per
 *                 question so the CPU run and the GPU run can be diffed.
 *                 Writes the same lines to --out <file> when given.
 *
 * Usage (project root):
 *   npx tsx ops/laya-gpu-bench.ts --bench 20
 *   npx tsx ops/laya-gpu-bench.ts --parity --out ops/laya-parity-after.txt
 *   LAYA_BASE_URL=http://127.0.0.1:8099 npx tsx ops/laya-gpu-bench.ts --bench 20
 */

import "dotenv/config";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { config } from "../src/config.js";
import { loadOrg } from "../src/company/org.js";
import type { AgentType } from "../src/company/org.js";
import { agentQuestionSpec, chooseAgent } from "../src/company/dispatch.js";
import { chooseBestModel, classifyBrain, classifyComplexity } from "../src/decision.js";
import { decideRoute } from "../src/orchestrator.js";

const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const MODE = argv.includes("--parity") ? "parity" : "bench";
const CALLS = Math.max(1, Number(flag("--bench") ?? 20) || 20);
const OUT = flag("--out");
const BASE = config.decisionBaseUrl;
const KEY = config.decisionKey;
const TIMEOUT_MS = Number(flag("--timeout") ?? 60000) || 60000;

const lines: string[] = [];
const emit = (s: string) => {
  lines.push(s);
  console.log(s);
};

// The task the bench replays: a realistic mid-size order, fixed so the before and
// after runs are the same input.
const BENCH_TASK =
  "Refactor logging across src/api/*.ts into a shared src/log.ts module: update all six call sites, " +
  "delete the duplicated helper, keep the public log format unchanged, then run the test suite.";

// The 5 fixed test questions. Fixed text, so CPU and GPU runs are identical inputs.
const PARITY_CASES: Array<{ id: string; text: string }> = [
  {
    id: "q1-single-file",
    text: "In src/util/date.ts, fix the off-by-one in addDays(): it must return the same wall-clock time across a DST boundary. Minimal diff, no new dependencies.",
  },
  {
    id: "q2-tests",
    text: "Write unit tests for company/budget.ts setAllocation() covering zero, negative and repeated allocations, plus a re-allocation after spend. Report pass/fail.",
  },
  {
    id: "q3-refactor",
    text: "Refactor logging across src/api/*.ts into a shared src/log.ts module: update all six call sites, delete the duplicated helper, keep the public log format unchanged, then run the test suite.",
  },
  {
    id: "q4-review",
    text: "Adversarially review the last merged diff in this repository: list concrete correctness bugs, missed edge cases and security risks, ordered by severity.",
  },
  {
    id: "q5-ambiguous",
    text: "make it faster",
  },
];

// ---------------------------------------------------------------------------
// roster (read-only, same source as the pipeline)
// ---------------------------------------------------------------------------
const org = loadOrg();
const project = org.projects.find((p) => (p.teams?.[0]?.agents?.length ?? 0) > 0);
if (!project) {
  console.error("no project with a team found in company/org.json");
  process.exit(2);
}
const agents: AgentType[] = project.teams[0]?.agents ?? [];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}
const f2 = (n: number) => n.toFixed(2);

async function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race<T>([
      fn(),
      new Promise<T>((_res, rej) => {
        timer = setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type RawAnswer = { choice?: string; confidence?: number; noul?: number; probabilities?: Record<string, number> };
type RawResponse = { model?: string; answers: Record<string, RawAnswer | undefined> };

/** One /v1/systemone call with the production dispatch payload. */
async function rawCall(payload: { state: unknown; questions: unknown }): Promise<{ ms: number; body: RawResponse }> {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/v1/systemone`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) },
    body: JSON.stringify(payload),
  });
  const ms = performance.now() - t0;
  if (!res.ok) throw new Error(`laya ${res.status}: ${await res.text()}`);
  return { ms, body: (await res.json()) as RawResponse };
}

async function health(): Promise<unknown> {
  try {
    const res = await fetch(`${BASE}/health`);
    return res.ok ? await res.json() : { error: `HTTP ${res.status}` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
const h = await health();
emit(`# laya-gpu-bench  mode=${MODE}  base=${BASE}  mockMode=${config.mockMode ? "ON" : "off"}  backend=${config.decisionBackend}`);
emit(`# roster: project ${project.id} "${project.name}" agents=${agents.map((a) => a.id).join(",")}`);
emit(`# /health: ${JSON.stringify(h)}`);

if (config.mockMode) {
  console.error("MOCK_MODE is on: refusing to present mock numbers as live Laya measurements.");
  process.exit(3);
}

if (MODE === "bench") {
  const spec = agentQuestionSpec(BENCH_TASK, agents);
  const payload = { state: spec.state, questions: spec.questions };
  emit(`# bench: ${CALLS} sequential /v1/systemone calls, same payload as chooseAgent()`);
  const times: number[] = [];
  const choices: string[] = [];
  for (let i = 1; i <= CALLS; i++) {
    const { ms, body } = await withTimeout(() => rawCall(payload), TIMEOUT_MS);
    const a = body.answers.assignment ?? {};
    times.push(ms);
    choices.push(`${a.choice ?? "none"}/${f2(a.confidence ?? 0)}`);
    emit(`call ${String(i).padStart(2)}  ${ms.toFixed(0).padStart(5)} ms  agent=${a.choice ?? "(none)"} conf=${f2(a.confidence ?? 0)} parallel_noul=${f2(body.answers.parallel?.noul ?? 0)}`);
  }
  const sorted = [...times].sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  emit("");
  emit(
    `SUMMARY n=${times.length} min=${sorted[0]!.toFixed(0)} p50=${pct(sorted, 50).toFixed(0)} p95=${pct(sorted, 95).toFixed(0)} max=${sorted[sorted.length - 1]!.toFixed(0)} mean=${mean.toFixed(0)} ms`
  );
  const uniq = [...new Set(choices)];
  emit(`ANSWERS distinct=${uniq.length} -> ${uniq.join(" | ")}`);
} else {
  emit(`# parity: ${PARITY_CASES.length} fixed questions through the real pipeline functions`);
  for (const c of PARITY_CASES) {
    const t0 = performance.now();
    const [disp, cx, bm, br, rt] = await Promise.all([
      withTimeout(() => chooseAgent(c.text, agents), TIMEOUT_MS),
      withTimeout(() => classifyComplexity(c.text), TIMEOUT_MS),
      withTimeout(() => chooseBestModel(c.text), TIMEOUT_MS),
      withTimeout(() => classifyBrain(c.text), TIMEOUT_MS),
      withTimeout(() => decideRoute(c.text, {}), TIMEOUT_MS),
    ]);
    const ms = performance.now() - t0;
    emit(
      `${c.id.padEnd(15)} agent=${(disp.assignments[0]?.agentId ?? "none").padEnd(10)} ` +
        `conf=${f2(disp.confidence).padStart(5)} parallel=${disp.parallel ? "yes" : "no "} | ` +
        `complexity=${cx.predicted}(${f2(cx.confidence)}) | ` +
        `model=${bm.modelId}(${f2(bm.confidence)}) | ` +
        `brain=${br.brain}(${f2(br.confidence)}) | ` +
        `route=${rt.modelId} via ${rt.via} | ${ms.toFixed(0)}ms`
    );
  }
}

if (OUT) {
  writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  console.log(`# wrote ${OUT}`);
}
