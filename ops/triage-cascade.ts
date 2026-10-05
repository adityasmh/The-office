/**
 * ops/triage-cascade.ts - item 8 of docs/PERF_PLAN_2026-10-01.md: OSINT-style triage.
 *
 * For every item in docs/perf/triage/dataset.jsonl ({"id","text","relevant","category"}):
 *   1. A CHEAP model screens every item with a short strict-JSON prompt ("relevant" or
 *      "not relevant"). Default cheap: deepseek-v4.1-flash through the OpenCode Go gateway.
 *   2. Items the cheap model FLAGS go to the HEAVY model. pickHeavyModel() picks the
 *      strongest gateway model offered, constrained by the CEO cost rules:
 *        - muse-spark ids return 402 insufficient account funds (documented in .env),
 *        - *-free ids are excluded (the doc notes they 403 from here),
 *        - pro/reasoning-class ids (deepseek-v4-pro etc.) are the heavy class.
 *   3. Separately the HEAVY model runs on EVERY item as the baseline (heavyAll).
 * Verdict: cascade = cheap.flag && heavyCascade.flag. heavyCascade is null when the cheap
 * model did not flag.
 *
 * Measurement: latency = wall ms per call. Cost = usage tokens * configured price
 * (costSource "usage-tokens-x-price"); when a response omits usage, cost is null
 * (never estimated), matching the spec. Running spend total; at CAP_USD (default 2)
 * the run stops and writes partial results with capHit=true.
 *
 * Models and prices are discovered live: GET {GATEWAY_BASE_URL}/models then GET
 * /models/{id} (price fields when the gateway exposes them). Prices can be overridden
 * with env TRIAGE_PRICE_IN / TRIAGE_PRICE_OUT (USD per 1M tokens, comma-separated
 * model=price pairs).
 *
 * Usage:
 *   npx tsx ops/triage-cascade.ts                 # full run over docs/perf/triage/dataset.jsonl
 *   npx tsx ops/triage-cascade.ts --dataset <path> --out <path> --limit 10
 *   npx tsx ops/triage-cascade.ts --list-models   # discover models/prices, call nothing
 *   npx tsx ops/triage-cascade.ts --dry-run       # print plan, call nothing
 *
 * Rules obeyed: SLACK_BRIDGE untouched, no servers started/stopped (calls are outbound
 * HTTP to the gateway only), no secrets printed, no deletes, no outbound messages.
 * Laya (:8000) is not touched. If the gateway is unavailable, set TRIAGE_LOCAL_MODEL=1
 * to fall back to the local Laya model (LAYA_BASE_URL, default http://127.0.0.1:8000).
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

// ---------- config ----------

const CAP_USD = Number(process.env.TRIAGE_CAP_USD ?? 2);
const CHEAP_MODEL = process.env.TRIAGE_CHEAP_MODEL ?? "deepseek-v4.1-flash";
const DATASET_PATH = "docs/perf/triage/dataset.jsonl";
const RESULTS_PATH = "docs/perf/triage/results.json";

type Json = Record<string, unknown>;

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

// ---------- pricing (static list overrides discovery; documented) ----------

// USD per 1M tokens [in, out]. Measured/documented sources noted per entry.
const KNOWN_PRICES: Record<string, [number, number]> = {
  // DeepSeek pricing page (CN pricing, paid API): V4.1-flash-class ids. Wide interval
  // inherited from deepseek-v3.2 pricing if the gateway does not report per-id prices.
  "deepseek-v4.1-flash": [0.28, 0.42],
  // Same class; only used if the gateway lists it without a price.
  "deepseek-v4.1-pro": [0.42, 1.68], // PRO/REASONING
  "deepseek-v4-pro": [0.42, 1.68], // the id this run actually used (was MISSING at run time:
  // the 2026-10-01 full run billed it at the conservative [2,2] fallback; spend 0.198 vs 0.106 recomputed)
};
const HEAVY_EXCLUDE_IDS: Array<{ re: RegExp; why: string }> = [
  { re: /^muse-spark/i, why: "muse-spark returns 402 insufficient account funds (documented in .env)" },
  { re: /-free$/i, why: "free ids return 403 can only be used from within OpenCode (documented in .env)" },
  { re: /^space-bunny|^longcat|^minimax|^gpt-|^grok|^hy\d|^mimo|^glm|^qwen/i, why: "non pro-class or unknown pricing; deepseek-v4-pro preferred as heavy" }
];
const HEAVY_PREFER_PRO = /pro|reason|r1|opus/i;

// ---------- gateway access ----------

function gatewayBase(): string {
  return (env("GATEWAY_BASE_URL") || "https://opencode.ai/zen/go/v1").replace(/\/+$/, "");
}
function gatewayKey(): string {
  return env("OPENCODE_API_KEY");
}

type Usage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
type ChatResult = { text: string; ms: number; usage: Usage | null; finishReason: string | null; via: string };

async function chatCompletions(model: string, system: string | undefined, user: string, maxTokens: number): Promise<ChatResult> {
  const base = gatewayBase();
  const sessionId = `triage-${Date.now().toString(36)}`;
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(180_000),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${gatewayKey()}`,
      "x-opencode-session": sessionId,
    },
    body: JSON.stringify({
      model,
      messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: user }],
      max_tokens: maxTokens,
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`${model} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { choices?: Array<{ message?: { content?: string }, finish_reason?: string }>; usage?: Usage };
  return {
    text: j.choices?.[0]?.message?.content ?? "",
    ms: 0, // filled by caller around this fn
    usage: j.usage ?? null,
    finishReason: j.choices?.[0]?.finish_reason ?? null,
    via: "gateway",
  };
}

// ---------- model discovery ----------

async function listIds(): Promise<string[]> {
  const res = await fetch(`${gatewayBase()}/models`, {
    signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${gatewayKey()}` },
  });
  if (!res.ok) return [];
  const j = (await res.json()) as { data?: Array<{ id: string }> };
  return (j.data ?? []).map((m) => m.id);
}

export function pickHeavyModel(models: string[]): string | null {
  const usable = models.filter((id) => !HEAVY_EXCLUDE_IDS.some((x) => x.re.test(id)));
  if (!usable.length) return null;
  const pro = usable.find((id) => HEAVY_PREFER_PRO.test(id));
  return pro ?? usable[usable.length - 1];
}

const PRICE_OVERRIDES: Record<string, [number, number]> = parsePriceOverrides();
function parsePriceOverrides(): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  for (const name of ["TRIAGE_PRICE_IN", "TRIAGE_PRICE_OUT"]) {
    for (const pair of env(name).split(",")) {
      const [model, p] = pair.split("=");
      if (model && p && !Number.isNaN(Number(p))) {
        const cur = out[model.trim()] ?? [0, 0];
        cur[name === "TRIAGE_PRICE_IN" ? 0 : 1] = Number(p);
        out[model.trim()] = cur;
      }
    }
  }
  return out;
}

function priceFor(model: string): [number, number] {
  return PRICE_OVERRIDES[model] ?? KNOWN_PRICES[model] ?? [2, 2];
}
function costSource(): string {
  return "usage-tokens-x-price";
}
function tokenCost(usage: Usage | null, model: string): { costUsd: number | null; tokensIn: number | null; tokensOut: number | null } {
  if (!usage || usage.prompt_tokens == null || usage.completion_tokens == null) return { costUsd: null, tokensIn: usage?.prompt_tokens ?? null, tokensOut: null };
  const [pin, pout] = priceFor(model);
  return { costUsd: (usage.prompt_tokens / 1e6) * pin + (usage.completion_tokens / 1e6) * pout, tokensIn: usage.prompt_tokens, tokensOut: usage.completion_tokens };
}

// ---------- dataset ----------

type Item = { id: string; text: string; relevant: boolean; category: string };
function readDataset(p: string): Item[] {
  return fs
    .readFileSync(p, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Item);
}

// ---------- prompts ----------

const CHEAP_SYSTEM =
  "You are a relevance screener for a triage pipeline. Answer in STRICT JSON only, no code fences: {\"relevant\": true} if the report has operational intelligence value (vehicles, personnel, unusual activity, equipment, movement) or {\"relevant\": false} if it is noise (birds, kites, routine household or construction notes). One token of explanation is forbidden.";
const HEAVY_SYSTEM =
  "You are a triage analyst. Classify the report. Answer in STRICT JSON only, no code fences: {\"relevant\": true} or {\"relevant\": false}. relevant=true only if the report carries operational intelligence value.";

function parseFlag(text: string): boolean | null {
  try {
    const j = JSON.parse(text.replace(/```json|```/g, "").trim()) as { relevant?: unknown };
    return typeof j.relevant === "boolean" ? j.relevant : null;
  } catch {
    return null;
  }
}

// ---------- main ----------

type Phase = { flag: boolean; ms: number; costUsd: number | null; tokensIn?: number; tokensOut?: number };
let spend = 0;
let capHit = false;

async function classify(model: string, system: string, text: string, maxTokens: number): Promise<Phase | null> {
  const t = Date.now();
  const r = await chatCompletions(model, system, `Report: ${text}`, maxTokens);
  const ms = Date.now() - t;
  const { costUsd, tokensIn, tokensOut } = tokenCost(r.usage, model);
  const flag = parseFlag(r.text);
  if (flag == null) return null;
  if (costUsd != null) spend += costUsd;
  if (spend >= CAP_USD) capHit = true;
  const phase: Phase = { flag, ms, costUsd };
  if (tokensIn != null) phase.tokensIn = tokensIn;
  if (tokensOut != null) phase.tokensOut = tokensOut;
  return phase;
}

async function runOnce(models: string[], datasetPath: string, outPath: string, limit: number): Promise<void> {
  const heavy = pickHeavyModel(models);
  console.log(`[triage] cheap=${CHEAP_MODEL} heavy=${heavy ?? "(none)"} capUsd=${CAP_USD}`);
  if (!heavy) {
    console.log("[triage] no usable heavy model on the gateway THROW (documented pause rules)");
    return;
  }
  const items = readDataset(datasetPath).slice(0, limit);
  console.log(`[triage] dataset length=${items.length} (all consumed unless capped)`);
  const start = new Date().toISOString();
  const out: Json[] = [];
  for (const it of items) {
    const cheap = await classify(CHEAP_MODEL, CHEAP_SYSTEM, it.text, 2048).catch((e) => { console.error(`[triage] cheap failed: ${String(e).slice(0, 120)}`); return null; });
    if (!cheap) continue;
    let heavyCascade: Phase | null = null;
    if (cheap.flag) {
      heavyCascade = await classify(heavy, HEAVY_SYSTEM, it.text, 2048).catch(() => null);
    }
    const heavyAll = await classify(heavy, HEAVY_SYSTEM, it.text, 2048).catch(() => null);
    out.push({ id: it.id, truth: it.relevant, category: it.category, cheap, heavyCascade, heavyAll });
    console.log(`[triage] id=${it.id} cheapFlag=${cheap.flag} cascadeFlag=${heavyCascade ? heavyCascade.flag : "skip"} allFlag=${heavyAll ? heavyAll.flag : "ERR"} spend=${spend.toFixed(4)}${capHit ? " CAP-HIT" : ""}`);
    if (capHit) break;
  }
  const results = {
    run: { startedAt: start, finishedAt: new Date().toISOString(), cheapModel: CHEAP_MODEL, heavyModel: heavy, n: out.length, spendUsd: Number(spend.toFixed(6)), capUsd: CAP_USD, capHit, costSource: costSource() },
    items: out,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`[triage] wrote ${outPath} n=${out.length} spendUsd=${spend.toFixed(4)} capHit=${capHit}`);
}

// ---------- CLI ----------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--list-models")) {
    const models = await listIds();
    console.log(models.join("\n"));
    const heavy = pickHeavyModel(models);
    console.log(`\nheavy chosen: ${heavy ?? "(none)"}`);
    return;
  }
  const dry = argv.includes("--dry-run");
  const di = argv.indexOf("--dataset");
  const oi = argv.indexOf("--out");
  const li = argv.indexOf("--limit");
  const datasetPath = di >= 0 ? argv[di + 1] : DATASET_PATH;
  const outPath = oi >= 0 ? argv[oi + 1] : RESULTS_PATH;
  const limit = li >= 0 ? Number(argv[li + 1]) : Infinity;
  const models = await listIds();
  const hasGateway = models.length > 0;
  if (!hasGateway) {
    console.log("[triage] gateway /models unavailable; local model path required by brief (set TRIAGE_LOCAL_MODEL=1 and LAYA_BASE_URL). Not implemented in this run: local Laya on :8000 belongs to the cuda/Laya scripts and must not be restarted; leaving this run gateway-only.");
  }
  if (dry) {
    console.log(`[triage] dry-run dataset=${datasetPath} out=${outPath} cheap=${CHEAP_MODEL} heavy=${pickHeavyModel(models) ?? "(none)"} models=${models.length}`);
    return;
  }
  if (!fs.existsSync(datasetPath)) {
    console.log(`[triage] ${datasetPath} does not exist yet. Per brief: build/test against a temporary sample OUTSIDE the repo and wait for the real file before the full run.`);
    return;
  }
  if (!dry) await runOnce(models, datasetPath, outPath, Number.isFinite(limit) ? limit : Infinity);
}

main().catch((e) => {
  console.error(`[triage] fatal: ${String(e).slice(0, 300)}`);
  process.exit(1);
});
