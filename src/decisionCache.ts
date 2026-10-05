// Decision cache for classifyComplexity/classifyBrain (see docs/DECISION_CACHE_SPEC.md).
// Normalisation rule: lowercase -> trim -> collapse whitespace to a single space ->
// replace UUIDs, hex ids of 7+ chars, and digit runs with '#'. So "Task 12345" and
// "TASK   abc123ef" both become "task #".

export type CacheStats = { enabled: boolean; size: number; max: number; ttlMs: number; hits: number; misses: number; evictions: number; expired: number };

// Bounded LRU keyed by normalised text, with a per-entry TTL.
// Entries: key -> { value; expires } in Map insertion order, so "oldest" = first key.
type Entry = { value: unknown; expires: number };

const store = new Map<string, Entry>();

let hits = 0;
let misses = 0;
let evictions = 0;
let expired = 0;

function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : def;
}

export function normalisePrompt(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "#")
    .replace(/(?:\b|(?<=\W))[0-9a-f]{7,}(?=\b|\W|$)/g, "#")
    .replace(/\d+/g, "#");
}

export function cacheKey(kind: "complexity" | "brain", prompt: string, hint?: string): string {
  return `${kind}|${normalisePrompt(prompt)}|${normalisePrompt(hint ?? "")}`;
}

export function cacheEnabled(): boolean {
  return process.env.DECISION_CACHE !== "0";
}

export function cacheStats(): CacheStats {
  return {
    enabled: cacheEnabled(),
    size: store.size,
    max: envInt("DECISION_CACHE_MAX", 500),
    ttlMs: envInt("DECISION_CACHE_TTL_MS", 600000),
    hits,
    misses,
    evictions,
    expired,
  };
}

export function cacheClear(): void {
  store.clear();
  hits = 0;
  misses = 0;
  evictions = 0;
  expired = 0;
}

export function cacheGet<T>(key: string): T | undefined {
  if (!cacheEnabled()) {
    misses++;
    return undefined;
  }
  const e = store.get(key);
  if (e === undefined) {
    misses++;
    return undefined;
  }
  if (Date.now() >= e.expires) {
    store.delete(key);
    expired++;
    misses++;
    return undefined;
  }
  // LRU bump: delete then re-set to move key to the newest position.
  store.delete(key);
  store.set(key, e);
  hits++;
  return e.value as T;
}

export function cacheSet<T>(key: string, value: T): void {
  if (!cacheEnabled()) return;
  const ttl = envInt("DECISION_CACHE_TTL_MS", 600000);
  store.set(key, { value, expires: Date.now() + ttl });
  const max = envInt("DECISION_CACHE_MAX", 500);
  while (store.size > max) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
    evictions++;
  }
}
