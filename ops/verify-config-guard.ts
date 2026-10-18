// ops/verify-config-guard.ts — unit check for the trust-boundary startup guard.
//
// Contract: docs/CEO_RUNBOOK.md section 0 ("assertConfig refuses to start when
// HOST is not loopback and no COMPANY_AUTH_TOKEN is set").
//
// config.ts reads process.env at import time, so each case sets the environment
// first and then dynamically imports the module with a fresh query string to
// defeat the module cache.
//
// Usage: .\node_modules\.bin\tsx.cmd ops/verify-config-guard.ts   (exit 1 on failure)
// (avoid `npx` here: on this box the npx wrapper can stall on a registry check;
// the local bin starts in ~0.3 s.)

type Case = {
  name: string;
  env: Record<string, string | undefined>;
  expectThrow: boolean;
  expectToken?: string;
  // The trust-boundary refusal must be the FIRST failure, i.e. it has to fire
  // before provider-key validation and before the MOCK_MODE early return.
  expectBoundaryMessage?: boolean;
};

const TOKEN_48 = "a".repeat(48);
const CASES: Case[] = [
  { name: "default (no HOST) binds loopback with no token", env: { HOST: undefined, COMPANY_AUTH_TOKEN: undefined, MOCK_MODE: "1" }, expectThrow: false, expectToken: "" },
  { name: "HOST=127.0.0.1 with no token is fine", env: { HOST: "127.0.0.1", COMPANY_AUTH_TOKEN: undefined, MOCK_MODE: "1" }, expectThrow: false, expectToken: "" },
  { name: "HOST=0.0.0.0 with no token is REFUSED (even in mock mode)", env: { HOST: "0.0.0.0", COMPANY_AUTH_TOKEN: undefined, MOCK_MODE: "1" }, expectThrow: true, expectBoundaryMessage: true },
  { name: "HOST=0.0.0.0 with an empty token is REFUSED", env: { HOST: "0.0.0.0", COMPANY_AUTH_TOKEN: "", MOCK_MODE: "1" }, expectThrow: true, expectBoundaryMessage: true },
  { name: "HOST=0.0.0.0 with a token starts", env: { HOST: "0.0.0.0", COMPANY_AUTH_TOKEN: TOKEN_48, MOCK_MODE: "1" }, expectThrow: false, expectToken: TOKEN_48 },
  { name: "HOST=192.168.29.242 with no token is REFUSED", env: { HOST: "192.168.29.242", COMPANY_AUTH_TOKEN: undefined, MOCK_MODE: "1" }, expectThrow: true, expectBoundaryMessage: true },
  { name: "HOST=0.0.0.0 with no token is REFUSED in real (non-mock) mode too", env: { HOST: "0.0.0.0", COMPANY_AUTH_TOKEN: undefined, MOCK_MODE: undefined }, expectThrow: true, expectBoundaryMessage: true },
];

let failed = 0;
const saved = {
  HOST: process.env.HOST,
  COMPANY_AUTH_TOKEN: process.env.COMPANY_AUTH_TOKEN,
  MOCK_MODE: process.env.MOCK_MODE,
};

for (let i = 0; i < CASES.length; i++) {
  const c = CASES[i]!;
  for (const [k, v] of Object.entries(c.env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const url = new URL("../src/config.js", import.meta.url).href + `?case=${i}`;
  let threw: string | null = null;
  let token: string | undefined;
  try {
    const mod = (await import(url)) as { config: { authToken: string }; assertConfig: () => void };
    token = mod.config.authToken;
    mod.assertConfig();
  } catch (e) {
    threw = String((e as Error)?.message ?? e);
  }
  const ok = c.expectThrow ? threw !== null : threw === null;
  const tokenOk = c.expectToken === undefined || token === c.expectToken;
  const boundaryOk = !c.expectBoundaryMessage || (threw !== null && threw.startsWith("Refusing to start"));
  if (!ok || !tokenOk || !boundaryOk) failed++;
  console.log(`${ok && tokenOk && boundaryOk ? "PASS" : "FAIL"}  ${c.name}`);
  console.log(`      ${threw ? `threw: ${threw.slice(0, 150)}` : `started, authToken=${token ? `set(len ${token.length})` : "unset"}`}`);
}

const restore: Array<[string, string | undefined]> = [
  ["HOST", saved.HOST],
  ["COMPANY_AUTH_TOKEN", saved.COMPANY_AUTH_TOKEN],
  ["MOCK_MODE", saved.MOCK_MODE],
];
for (const [k, v] of restore) {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

console.log(`\nsummary: ${CASES.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
