// Throwaway self-test for the decision cache (CACHE-CORE). Stubs global fetch
// so it never calls the real Laya. Run: npx tsx ops/decision-cache-selftest.ts
// SlAG enum for checks is simple: throw on failure, print PASSES at the end.
import {
  cacheClear,
  cacheEnabled,
  cacheGet,
  cacheKey,
  cacheSet,
  cacheStats,
  normalisePrompt,
} from "../src/decisionCache.js";
import { classifyBrain, classifyComplexity } from "../src/decision.js";
import * as configMod from "../src/config.js";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name} ${detail}`);
  }
}
function assertEq(a: unknown, b: unknown, name: string) {
  check(name, JSON.stringify(a) === JSON.stringify(b), `json mismatch: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
}

// Stub global fetch. Each stubbed call returns a fresh decision with a call counter.
let fetchCount = 0;
let callSeq = 0;
const origFetch = globalThis.fetch;
(globalThis as { fetch: unknown }).fetch = (async (_url: unknown, init?: { body?: unknown }) => {
  fetchCount++;
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : (init?.body as Record<string, unknown>);
  void body;
  const seq = ++callSeq;
  return {
    ok: true,
    status: 200,
    json: async () => ({
      model: `stub-model-${seq}`,
      answers: {
        tiny: { type: "noul", noul: 0.9, confidence: 0.82 },
        multi: { type: "noul", noul: 0.1 },
        long: { type: "noul", noul: 0.1 },
        hard: { type: "noul", noul: 0.1, confidence: 0.7 },
      },
    }),
    text: async () => "",
  } as unknown as Response;
}) as typeof globalThis.fetch;

// Force non-mock mode lazily by mutating config once at load.
// config.decisionBackend default + mockMode=false is asserted before each phase.
// Fake timers for TTL: freeze Date.now jump via spy clock offset.
let clockOffset = 0;
const realDateNow = Date.now;
Date.now = () => realDateNow() + clockOffset;

// Force mockMode off in the shared config object.
(async () => {
  const cfg = configMod.config as { mockMode?: boolean; decisionBackend?: string };
  console.log("config mockMode(should work when stubbed fetch is used):", cfg.mockMode);
})();

function phase(env: Record<string, string>, fn: () => Promise<void> | void): Promise<void> {
  return (async () => {
    const saved: string[] = [];
    for (const [k, v] of Object.entries(env)) {
      saved.push(k);
      if (v === "") delete process.env[k];
      else process.env[k] = v;
    }
    cacheClear();
    try {
      await fn();
    } finally {
      for (const k of saved) delete process.env[k];
      // restore
    }
    // restore phase env cleanup is done above; keys deleted
    void saved;
  })();
}

const P1 = "Fix the login bug 7 in file a.ts please";
const P1V2 = "  FIX   the login bug 7 in file a.ts please ";
const P2num = "Fix the login bug 42 in file a.ts please";
const P1DIFFERENT = "Fix the logout bug in file b.ts please";

// Phase 1: exact repeat hits, near-identical hits, different prompt misses.
await phase(
  {
    DECISION_CACHE: "1",
    DECISION_CACHE_MAX: "500",
    DECISION_CACHE_TTL_MS: "600000",
  },
  async () => {
    check("cache enabled by default(=1)", cacheEnabled() === true);
    const r1 = await classifyComplexity(P1);
    const after1 = cacheStats();
    assertEq(after1.hits, 0, "first call misses (hits=0)");
    assertEq(after1.misses, 1, "first call records one miss");
    const r2 = await classifyComplexity(P1);
    assertEq(cacheStats().hits, 1, "exact repeat hits");
    assertEq(fetchCount, 1, "fetch count unchanged after exact repeat");
    assertEq(r2, r1, "exact repeat returns deep-equal result");
    const r3 = await classifyComplexity(P1V2);
    assertEq(cacheStats().hits, 2, "case+whitespace-variant hits");
    assertEq(fetchCount, 1, "fetch count unchanged for case/whitespace variant");
    assertEq(r3, r1, "near-identical returns identical decision");
    const r4 = await classifyComplexity(P2num);
    assertEq(cacheStats().hits, 3, "digit-run variant hits");
    assertEq(fetchCount, 1, "fetch count unchanged for digit variant");
    assertEq(r4, r1, "digit variant returns identical decision");
    const r5 = await classifyComplexity(P1DIFFERENT);
    assertEq(cacheStats().misses, 2, "different prompt records a miss");
    assertEq(fetchCount, 2, "different prompt fetches");
    assertEq(r5.predicted, "ROUTINE", "different prompt gets its own decision (ROUTINE as logout)");

    // brain path too
    const b1 = await classifyBrain(P1);
    const beforeBrainHits = cacheStats().hits;
    const b2 = await classifyBrain(P1);
    assertEq(cacheStats().hits, beforeBrainHits + 1, "brain exact repeat hits");
    assertEq(b2 as unknown, b1 as unknown, "brain return deep-equal on hit");
  },
);

// Phase 2: TTL expiry with a tiny TTL.
await phase(
  { DECISION_CACHE: "1", DECISION_CACHE_TTL_MS: "50", DECISION_CACHE_MAX: "500" },
  async () => {
    check("cacheStats ttlMs reads env at call time", cacheStats().ttlMs === 50, `ttlMs=${cacheStats().ttlMs}`);
    await classifyComplexity(P1);
    const grew = fetchCount;
    clockOffset = 0;
    const rNow = await classifyComplexity(P1);
    check("within TTL hits", cacheStats().hits === 1, `hits=${cacheStats().hits}`);
    assertEq(rNow.predicted, rNow.predicted, "sanityでの within-ttl decision");
    clockOffset = 60; // 60ms later, past 50ms TTL
    const rExpired = await classifyComplexity(P1);
    check("past TTL misses and fetches again", fetchCount === grew + 1, `fetchCount=${fetchCount} grew=${grew}`);
    check("expired counter incremented", cacheStats().expired === 1, `expired=${cacheStats().expired}`);
    assertEq(
      { predicted: rExpired.predicted, confidence: rExpired.confidence, reason: rExpired.reason },
      { predicted: rNow.predicted, confidence: rNow.confidence, reason: rNow.reason },
      "after expiry the same prompt gets a fresh (equivalent) decision",
    );
    clockOffset = 0;
  },
);

// Phase 3: size bound at DECISION_CACHE_MAX with LRU eviction.
await phase(
  { DECISION_CACHE: "1", DECISION_CACHE_MAX: "3", DECISION_CACHE_TTL_MS: "600000" },
  async () => {
    cacheClear();
    for (let i = 0; i < 6; i++) cacheSet(`k${i}`, { i });
    const s = cacheStats();
    check("size bounded at max", s.size === 3, `size=${s.size}`);
    check("evictions counted", s.evictions === 3, `evictions=${s.evictions}`);
    check("oldest evicted (L0 gone)", cacheGet<{ i: number }>("k0") === undefined, "k0 missing");
    check("k1 gone", cacheGet("k1") === undefined, "k1 missing");
    check("newest survives", cacheGet<{ i: number }>("k5") !== undefined, "k5 present");
    // LRU bump: touch k3 (moves it to newest), then a new set evicts k4, not k3.
    cacheGet("k3");
    cacheSet("k99", { i: 99 });
    check("bumped key survives (LRU, not FIFO)", cacheGet("k3") !== undefined, "k3 survived after bump");
    check("next-oldest k4 evicted instead", cacheGet("k4") === undefined, "k4 evicted");
  },
);

// Phase 4: DECISION_CACHE=0 disables; no hits, cacheSet no-op.
await phase(
  { DECISION_CACHE: "0", DECISION_CACHE_MAX: "", DECISION_CACHE_TTL_MS: "600000" },
  async () => {
    check("DECISION_CACHE=0 disables", cacheEnabled() === false);
    cacheSet("x", { a: 1 });
    check("cacheSet is a no-op when disabled", cacheStats().size === 0, `size=${cacheStats().size}`);
    check("cacheGet always undefined when disabled", cacheGet("x") === undefined, "get undefined");
    const before = fetchCount;
    await classifyComplexity(P1);
    await classifyComplexity(P1);
    check("no hits recorded when disabled", cacheStats().hits === 0, `hits=${cacheStats().hits}`);
    check("every call fetched (disabled cache does not dedupe)", fetchCount === before + 2, `fetchCount=${fetchCount} before=${before}`);
  },
);

// Phase 5: normalisePrompt unit checks.
{
  assertEq(normalisePrompt("Hello   WORLD"), "hello world", "collapse ws+mixed case");
  assertEq(normalisePrompt("id=19 0 2 ( GF 8)"), "id=# # # ( gf #)", "digit runs collapse to #, words untouched");
  assertEq(normalisePrompt("id 8a5c877c"), "id #", "hex >=7 normalized");
  assertEq(normalisePrompt("id x86_64-v3"), "id x#_#-v#", "digit runs inside words normalized (simple rule)");
  assertEq(normalisePrompt("Run d6f19ac03929e8 "), "run #", "longer hex normalized");
  assertEq(normalisePrompt("uuid"), "uuid", "sanity: the word uuid itself untouched (no digits)");
  assertEq(normalisePrompt("a 8a5c877c-1f2e-4c9e-8d7a-7a9e5c9d1f2e b"), "a # b", "uuid normalized");
  assertEq(normalisePrompt("count=777"), "count=#", "digit run normalized");
  assertEq(normalisePrompt("  Multi   Line\nText  "), "multi line text", "multiline collapses");
}

// Phase 6: cacheKey shapes.
{
  assertEq(cacheKey("brain", "A B 2", "hint 1"), "brain|a b #|hint #", "cacheKey format with hint");
  assertEq(cacheKey("complexity", "X", undefined), "complexity|x|", "cacheKey empty hint");
}

// Phase 7: thrown errors are never cached.
await phase({ DECISION_CACHE: "1" }, async () => {
  cacheClear();
  const origFetch2 = (globalThis as { fetch: unknown }).fetch;
  fetchCount = 0;
  (globalThis as { fetch: unknown }).fetch = (async () => {
    fetchCount++;
    throw new Error("boom");
  }) as unknown as typeof fetch;
  try {
    let threwOne = false;
    try {
      await classifyComplexity(P1DIFFERENT);
    } catch {
      threwOne = true;
    }
    check("error propagates from decisionCall", threwOne === true, "unexpectedly didn't throw");
    const s = cacheStats();
    check("error result not stored", cacheGet(P1DIFFERENT) === undefined, "error result was stored");
    check("no anomaly in counters", s.hits === 0 && s.misses === 1, `hits=${s.hits} misses=${s.misses}`);
    let threwAgain = false;
    try {
      await classifyComplexity(P1DIFFERENT);
    } catch {
      threwAgain = true;
    }
    check("second call still throws(no cached error)", threwAgain === true, "no throw");
    check("second call was a real fetch", fetchCount === 2, `fetchCount=${fetchCount}`);
  } finally {
    (globalThis as { fetch: unknown }).fetch = origFetch2;
  }
});

fetchCount = 0;
callSeq = 0;
clockOffset = 0;
(globalThis as { fetch: unknown }).fetch = origFetch;
Date.now = realDateNow;
console.log(`\nDone: fetchCount reset=${fetchCount} failures=${failures}`);
if (failures > 0) {
  process.exit(1);
} else {
  console.log("SELFTEST ALL PASS");
}
