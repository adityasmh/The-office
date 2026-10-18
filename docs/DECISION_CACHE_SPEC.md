# Decision cache contract

Module: `src/decisionCache.ts` (new, owned by CACHE-CORE). Consumed by `ops/cache-hit-rate.ts` (CACHE-REPLAY).

## Exports

export function normalisePrompt(text: string): string;
// lowercase -> trim -> collapse whitespace to single space -> replace UUIDs, hex ids of 7+ chars, and digit runs with '#'

export function cacheKey(kind: 'complexity' | 'brain', prompt: string, hint?: string): string;
// `${kind}|${normalisePrompt(prompt)}|${normalisePrompt(hint ?? '')}`

export type CacheStats = { enabled: boolean; size: number; max: number; ttlMs: number; hits: number; misses: number; evictions: number; expired: number };
export function cacheStats(): CacheStats;
export function cacheClear(): void;
export function cacheEnabled(): boolean;

export function cacheGet<T>(key: string): T | undefined; // honours TTL, bumps LRU, counts hit/miss
export function cacheSet<T>(key: string, value: T): void; // evicts oldest when size > max


## Env flags (read at call time, not import time)
- `DECISION_CACHE=0` disables the cache. When disabled, cacheGet always returns undefined and cacheSet is a no-op.
- `DECISION_CACHE_MAX` (default 500)
- `DECISION_CACHE_TTL_MS` (default 600000)

## Integration in src/decision.ts
`classifyComplexity` and `classifyBrain` check the cache after the mockMode branch and before `decisionCall`. They store the full returned object on a miss. The cache returns a shallow copy of the stored result.

Do not cache thrown errors.

## Rule
An exact repeat of a prompt always returns the identical decision. Near-identical prompts share the first call's decision. That is intended and must be stated in the doc.

## Replay (ops/cache-hit-rate.ts)
It reads prompts from `company/` threads, runs them in file order through the real `classifyComplexity` and `classifyBrain` (so the real Laya is called on misses), and prints hit rate and latency saved. It runs the cache in-process and never starts or stops Laya.