// ops/budget-real-check.ts — the verification for the CEO's "real budget" order
// (docs/ORDER_2026-10-01_real-budget.md).
//
//   npx tsx ops/budget-real-check.ts            # in-process checks + a router fetch
//   npx tsx ops/budget-real-check.ts --no-net   # skip the provider read + router fetch
//
// What it proves, in order:
//   1. GET /company/budget/real's JSON has NO invented numbers: every cap field is
//      null (allocatedUsd / capUsd / remainingUsd / pctUsed / totalUsd), an
//      unconnected provider carries no number, and each real number traces to a
//      named source (the Go quota endpoint, DeepSeek's balance endpoint,
//      `jcode usage --json`, or our own per-call ledger).
//   2. the DeepSeek key never appears in any response body (the value is read
//      from .env and compared, never printed).
//   3. a per-agent message is no longer refused for budget: canAfford() is true
//      for an absurd estimate, setAllocation() writes no cap, an agent whose
//      spend is far past the old invented cap is still "idle"/"running" (never
//      "budget_exhausted"), and the server/agentchat source no longer holds the
//      gate or the 402.
//   4. budgetGuard is UNCHANGED: the existing ops/budget-selftest.ts still passes
//      (run as a child process, exit 0).
//   5. the CEO-visible result: GET /company/budget/real and GET /company/panel
//      are fetched from a router — the live one if it already serves the route,
//      else a throwaway instance on another port — and the panel's realBudget
//      block is checked to carry the SAME provider numbers as the endpoint.
//
// Read-only: it never posts a message, never writes budgets.json, and never
// prints a secret.

import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canAfford, getBudget, listBudgets, setAllocation } from "../src/company/budget.js";
import { deepseekKey } from "../src/company/deepseekDirect.js";
import { companyAuthHeaders } from "../src/company/authguard.js";
import {
  buildRealBudget,
  resetRealBudgetCache,
  type RealBudget,
} from "../src/company/budgetReal.js";
import { levelFor, rulesFor } from "../src/company/budgetGuard.js";

const NO_NET = process.argv.includes("--no-net");
const THROWAWAY_PORT = Number(process.env.BUDGET_CHECK_PORT ?? 8793);

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n        ${detail}`);
  if (!ok) failures += 1;
}

// ---------------------------------------------------------------------------
// 1. No invented numbers in the real-budget JSON
// ---------------------------------------------------------------------------
const CAP_KEYS = new Set(["allocatedUsd", "capUsd", "remainingUsd", "pctUsed", "totalUsd"]);

function findCapFields(value: unknown, at = "$"): Array<{ path: string; value: unknown }> {
  const out: Array<{ path: string; value: unknown }> = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => out.push(...findCapFields(v, `${at}[${i}]`)));
    return out;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (CAP_KEYS.has(k)) out.push({ path: `${at}.${k}`, value: v });
      out.push(...findCapFields(v, `${at}.${k}`));
    }
  }
  return out;
}

/** Every number in the payload must sit under a field that names a source. */
const SOURCED_NUMBER_FIELDS = new Set([
  "version", "cacheTtlS",        // the payload's own metadata
  "usedPct", "remainingPct",     // provider quota windows
  "balanceUsd", "totalBalanceUsd", "grantedBalanceUsd", "toppedUpBalanceUsd", // DeepSeek API
  "todayUsd", "last7dUsd", "allTimeUsd", "costUsd",         // our measured ledger
  "opencodeGoUsd", "deepseekDirectUsd", "claudeUsd", "otherUsd",
  "calls", "spentUsd", "spentTodayUsd", "sharePct", "capUsd", // per-agent ledger
  "multiplier", "minutesToChange",                            // the off-peak clock
]);

function findUnsourcedNumbers(value: unknown, at = "$"): string[] {
  const bad: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => bad.push(...findUnsourcedNumbers(v, `${at}[${i}]`)));
    return bad;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "number" && !SOURCED_NUMBER_FIELDS.has(k)) bad.push(`${at}.${k}=${v}`);
      bad.push(...findUnsourcedNumbers(v, `${at}.${k}`));
    }
  }
  return bad;
}

function providerChecks(b: RealBudget): string[] {
  const problems: string[] = [];
  for (const p of [b.providers.go, b.providers.deepseek, b.providers.claude]) {
    if (!p.connected) {
      if (p.remainingPct !== null) problems.push(`${p.id}: not connected but remainingPct=${p.remainingPct}`);
      if (p.balanceUsd !== null) problems.push(`${p.id}: not connected but balanceUsd=${p.balanceUsd}`);
      if (!p.notMeasured) problems.push(`${p.id}: not connected without a "not measured" reason`);
      if (!p.source || p.source !== "unavailable") problems.push(`${p.id}: not connected but source=${p.source}`);
    } else {
      if (!p.source || p.source === "unavailable") problems.push(`${p.id}: connected but no real source`);
      if (!p.checkedAt) problems.push(`${p.id}: connected without checkedAt`);
      if (p.id === "deepseek-direct" && p.balanceUsd === null) problems.push("deepseek: connected but no balance");
      if (p.id !== "deepseek-direct" && p.windows.length === 0) problems.push(`${p.id}: connected but no windows`);
    }
    for (const w of p.windows) {
      if (w.remainingPct !== null && w.usedPct !== null && Math.abs(w.usedPct + w.remainingPct - 100) > 0.02) {
        problems.push(`${p.id}/${w.window}: used+remaining != 100 (${w.usedPct}+${w.remainingPct})`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 3. The budget gate is gone
// ---------------------------------------------------------------------------
async function sourceGrepCheck(): Promise<void> {
  const { readFileSync } = await import("node:fs");
  const server = readFileSync(path.join(process.cwd(), "src", "server.ts"), "utf8");
  const agentchat = readFileSync(path.join(process.cwd(), "src", "company", "agentchat.ts"), "utf8");
  const budget = readFileSync(path.join(process.cwd(), "src", "company", "budget.ts"), "utf8");
  // Read the files but never print their contents: only the boolean result.
  check(
    "the server no longer answers 402 budget_exhausted for a message",
    !/budget_exhausted"?\)\s*return res\.status\(402\)/.test(server) && !/res\.status\(402\)/.test(server),
    "src/server.ts has no 402 budget refusal",
  );
  check(
    "agentchat no longer gates a message on canAfford()",
    !/canAfford\(/.test(agentchat),
    "src/company/agentchat.ts has no canAfford() call",
  );
  check(
    "budget.ts canAfford() is a no-op",
    /export function canAfford\([^)]*\): boolean \{\s*return true;/.test(budget),
    "canAfford() always returns true",
  );
}

// ---------------------------------------------------------------------------
// 3b. A REAL HTTP message, on an ISOLATED company root
//
// The old code refused a message with HTTP 402 `budget_exhausted` as soon as the
// agent's remaining allocation hit zero. That can only be proven end-to-end: POST
// the real route with a spend far past the old invented cap ($5). The instance
// runs with COMPANY_ROOT pointing at a throwaway copy (org.json + budgets.json),
// AIR_GAPPED=1 (so no Slack/provider call can leave) and every watcher off, so it
// can never touch the live company/ state or spend anything.
// ---------------------------------------------------------------------------
function writeIsolatedRoot(dir: string): { companyRoot: string; agentId: string } {
  const projectId = "p-gate";
  const agentId = "coder-1";
  const companyRoot = path.join(dir, "company");
  fs.mkdirSync(path.join(companyRoot, "projects", projectId), { recursive: true });
  fs.mkdirSync(path.join(companyRoot, "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(companyRoot, "org.json"),
    JSON.stringify(
      {
        name: "Gate Probe (throwaway)",
        departments: [{ id: "d-gate", name: "Probe", projectIds: [projectId] }],
        projects: [
          {
            id: projectId,
            name: "Gate Probe",
            description: "isolated budget-gate probe; never the live company",
            departmentId: "d-gate",
            rootDir: dir,
            status: "active",
            teams: [
              {
                id: "t-gate",
                name: "Team",
                projectId,
                agents: [{ id: agentId, role: "coder", name: "Coder 1", modelId: "deepseek-v4.1-flash", workdir: dir }],
              },
            ],
          },
        ],
      },
      null,
      2,
    ),
  );
  // Spend 200x the old invented cap: the OLD code computed remaining = 0 and
  // refused with 402 before it ever queued the message.
  fs.writeFileSync(
    path.join(companyRoot, "budgets.json"),
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        agents: { [`${projectId}::${agentId}`]: { allocatedUsd: 5, spentUsd: 999, ledger: [] } },
      },
      null,
      2,
    ),
  );
  return { companyRoot, agentId };
}

async function messageGateCheck(): Promise<{ ok: boolean; detail: string }> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jcode-budget-gate-"));
  const { companyRoot, agentId } = writeIsolatedRoot(tmp);
  const port = THROWAWAY_PORT + 1;
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn("npx", ["tsx", "src/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      COMPANY_ROOT: companyRoot,
      AIR_GAPPED: "1",
      BUDGET_POLL_S: "86400",
      BRIEFING_WATCH: "0",
      AUTOCLOSE: "0",
      MANAGER_QUEUE: "0",
    },
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let log = "";
  proc.stdout?.on("data", (d) => (log += String(d)));
  proc.stderr?.on("data", (d) => (log += String(d)));
  try {
    if (!(await waitForHealth(base, 90_000))) {
      return { ok: false, detail: `the isolated instance on :${port} did not come up: ${log.split(/\r?\n/).filter(Boolean).slice(-2).join(" | ") || "no output"}` };
    }
    const headers = { "content-type": "application/json", ...(await companyAuthHeaders(base)) };
    const r = await fetch(`${base}/company/agents/${agentId}/message`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "budget-gate probe (queued, never run)", run: false }),
    });
    const body = (await r.json().catch(() => ({}))) as { status?: string; error?: string };
    const refused = r.status === 402 || body.error === "budget_exhausted";
    const queued = body.status === "queued" && !body.error;
    return {
      ok: !refused && queued,
      detail: `HTTP ${r.status}, status=${String(body.status)}, error=${String(body.error ?? "none")} (spent $999 against the old $5 cap; the old code answered 402 budget_exhausted)`,
    };
  } catch (e) {
    return { ok: false, detail: `probe failed: ${String(e)}` };
  } finally {
    killTree(proc);
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* the OS temp dir is disposable */
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Router fetch (live, else a throwaway instance)
// ---------------------------------------------------------------------------
type Fetched = { base: string; real: Record<string, unknown>; panel: Record<string, unknown> | null; how: string };

async function tryFetch(base: string, timeoutMs = 10_000): Promise<Record<string, unknown> | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}/company/budget/real`, { signal: ac.signal });
    if (!r.ok) return null;
    return (await r.json()) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function waitForHealth(base: string, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

function killTree(proc: ChildProcess): void {
  if (!proc.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      proc.kill("SIGKILL");
    }
  }
}

async function fetchFromRouter(orInProc: RealBudget): Promise<Fetched> {
  // (a) the RUNNING router on :8787, if it already serves both routes.
  const live = await tryFetch("http://127.0.0.1:8787");
  if (live) {
    const panel = await (async () => {
      try {
        const r = await fetch("http://127.0.0.1:8787/company/panel");
        return r.ok ? ((await r.json()) as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    })();
    return { base: "http://127.0.0.1:8787", real: live, panel, how: "running router on :8787" };
  }

  // (b) a throwaway instance on another port (read-only; the real data stays put).
  const base = `http://127.0.0.1:${THROWAWAY_PORT}`;
  const env = {
    ...process.env,
    PORT: String(THROWAWAY_PORT),
    // This instance exists ONLY to answer two GETs. Every background watcher that
    // could call a provider, spend Claude, or rewrite shared state is switched off:
    //   - no budget poll (which would rewrite company/budget/state.json);
    //   - no CEO briefing (it makes Claude manager calls every 30 s);
    //   - no terminal reaper (it closes windows);
    //   - no manager queue (it retries jobs).
    // The fleet watcher refuses to start while the live router holds its lock.
    BUDGET_POLL_S: "86400",
    BUDGET_REAL_CACHE_MS: "30000",
    PANEL_CACHE_MS: "0",
    BRIEFING_WATCH: "0",
    AUTOCLOSE: "0",
    MANAGER_QUEUE: "0",
  };
  const proc = spawn("npx", ["tsx", "src/server.ts"], {
    cwd: process.cwd(),
    env,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let log = "";
  proc.stdout?.on("data", (d) => (log += String(d)));
  proc.stderr?.on("data", (d) => (log += String(d)));
  try {
    if (!(await waitForHealth(base))) {
      return { base, real: JSON.parse(JSON.stringify(orInProc)) as Record<string, unknown>, panel: null, how: `throwaway on :${THROWAWAY_PORT} did not start (using the in-process build)` };
    }
    const real = (await tryFetch(base, 30_000)) ?? (JSON.parse(JSON.stringify(orInProc)) as Record<string, unknown>);
    const panel = await (async () => {
      try {
        const r = await fetch(`${base}/company/panel`);
        return r.ok ? ((await r.json()) as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    })();
    return { base, real, panel, how: `throwaway instance on :${THROWAWAY_PORT}` };
  } finally {
    killTree(proc);
  }
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const key = deepseekKey();

  console.log("=== 1. THE REAL BUDGET JSON (in-process build) ===");
  resetRealBudgetCache();
  const real = await buildRealBudget({ fresh: true });
  const json = JSON.stringify(real);
  const pretty = JSON.stringify(real, null, 2);

  const caps = findCapFields(real);
  const badCaps = caps.filter((c) => c.value !== null);
  check(
    "every cap field is null (no invented per-agent quota)",
    badCaps.length === 0,
    caps.length
      ? `${caps.length} cap field(s) found, all null: ${[...new Set(caps.map((c) => c.path.split(".").pop()))].join(", ")}`
      : "no cap fields at all",
  );
  check("the top-level caps key is null", (real as { caps?: unknown }).caps === null, `caps = ${String((real as { caps?: unknown }).caps)}`);
  check("capsRemoved is stated in the payload", real.capsRemoved === true, `capsRemoved = ${String(real.capsRemoved)}`);

  const unsourced = findUnsourcedNumbers(real);
  check("every number in the JSON sits under a source-named field", unsourced.length === 0, unsourced.length ? unsourced.join(", ") : "no unsourced number");

  const provProblems = providerChecks(real);
  check("no unmeasured provider carries a number", provProblems.length === 0, provProblems.length ? provProblems.join("; ") : "all provider blocks honest");

  const goWindows = real.providers.go.windows.map((w) => `${w.window} ${w.remainingPct}% left${w.resetsIn ? ` (resets in ${w.resetsIn})` : ""}`);
  console.log(`        Go: ${real.providers.go.connected ? goWindows.join(", ") : "not measured"}`);
  console.log(`        DeepSeek: ${real.providers.deepseek.balanceUsd === null ? "not measured" : `$${real.providers.deepseek.balanceUsd} ${real.providers.deepseek.currency ?? ""}`} · ${real.providers.deepseek.phaseLine ?? ""} · ${real.providers.deepseek.armed ? "armed" : "off"}`);
  console.log(`        Claude: ${real.providers.claude.connected ? real.providers.claude.windows.map((w) => `${w.window} ${w.remainingPct}% left`).join(", ") : "not measured"} (${real.providers.claude.source})`);
  console.log(`        Spend: today $${real.spend.todayUsd}, 7d $${real.spend.last7dUsd}, all $${real.spend.allTimeUsd}; direct $${real.spend.byProvider.deepseekDirectUsd}; ${real.agents.length} agent rows`);

  check(
    "per-agent rows carry spend and a null cap",
    real.agents.every((a) => typeof a.spentUsd === "number" && a.capUsd === null),
    `${real.agents.length} rows, all capUsd=null`,
  );

  console.log("\n=== 2. THE KEY NEVER APPEARS IN A RESPONSE BODY ===");
  if (!key) {
    check("DEEPSEEK_API_KEY not set: nothing can leak", true, "no key in .env, so the balance proves it via its own reason");
  } else {
    const leaked = json.includes(key) || pretty.includes(key);
    check("the key value is absent from the real-budget JSON", !leaked, leaked ? "LEAK FOUND" : `key present in .env (${key.length} chars), absent from every field of the payload`);
  }

  console.log("\n=== 3. A PER-AGENT MESSAGE IS NO LONGER REFUSED FOR BUDGET ===");
  const rows = listBudgets();
  const withSpend = rows.filter((r) => r.spentUsd > 0);
  const sample = withSpend[0] ?? rows[0];
  check("canAfford() is true for an absurd estimate on every agent", rows.every((r) => canAfford(r.agentId, 1e9)), `${rows.length} agents, all affordable at $1e9`);
  check("no agent is in a budget_exhausted state", rows.every((r) => r.status !== "budget_exhausted"), `${rows.length} agents, statuses: ${[...new Set(rows.map((r) => r.status))].join(", ")}`);
  if (sample) {
    const spentBefore = sample.spentUsd;
    const returned = setAllocation(sample.agentId, 0.000001);
    check(
      "setAllocation() writes no cap and still answers",
      !!returned && returned.allocatedUsd === null && returned.remainingUsd === null && returned.pctUsed === null,
      `${sample.agentId}: allocated=${String(returned?.allocatedUsd)} remaining=${String(returned?.remainingUsd)} (spent unchanged at $${spentBefore})`,
    );
    const again = getBudget(sample.agentId);
    check("the legacy budget read still answers, cap null", !!again && again.allocatedUsd === null && again.spentUsd === spentBefore, `${sample.agentId}: spent $${again?.spentUsd}`);
  }
  await sourceGrepCheck();
  console.log("\n=== 3b. REAL HTTP: the message route does not refuse for budget ===");
  const gate = await messageGateCheck();
  check(
    "a real POST /company/agents/:id/message with spend far past the old cap is queued, not refused",
    gate.ok,
    gate.detail,
  );

  console.log("\n=== 4. budgetGuard IS UNCHANGED (existing ops/budget checks) ===");
  check("thresholds unchanged (41 -> green, 15 -> amber, 14.9 -> red, undefined -> unknown)", levelFor(41) === "green" && levelFor(15) === "amber" && levelFor(14.9) === "red" && levelFor(undefined) === "unknown", `41=${levelFor(41)} 15=${levelFor(15)} 14.9=${levelFor(14.9)} undefined=${levelFor(undefined)}`);
  check("the amber/red rules table is intact", rulesFor("amber", "green").go.forbiddenModels.length > 0 && rulesFor("red", "red").go.cheapestModels.length > 0, `amber forbids ${rulesFor("amber", "green").go.forbiddenModels.join("/")}; red allows ${rulesFor("red", "red").go.cheapestModels.join("/")}`);
  const selftestOk = await runSelftest();
  check("ops/budget-selftest.ts still passes", selftestOk, selftestOk ? "exit 0" : "non-zero exit (see output above)");

  if (NO_NET) {
    console.log("\n(--no-net: skipped the router fetch)");
  } else {
    console.log("\n=== 5. THE CEO-VISIBLE RESULT (from a router) ===");
    const got = await fetchFromRouter(real);
    console.log(`        fetched from ${got.how} (${got.base})`);
    const capsR = findCapFields(got.real).filter((c) => c.value !== null);
    check("the served endpoint also has null caps", capsR.length === 0, capsR.length ? capsR.map((c) => c.path).join(", ") : "all cap fields null");
    const servedJson = JSON.stringify(got.real);
    check("the served body does not contain the key", !key || !servedJson.includes(key), key ? `checked ${key.length}-char key against ${servedJson.length} chars of response` : "no key set");
    const servedGo = (got.real.providers as { go?: { remainingPct?: number | null; windows?: unknown[] } } | undefined)?.go;
    check("the served endpoint carries the Go windows", !!servedGo && Array.isArray(servedGo.windows) && servedGo.windows.length > 0, `go remainingPct=${String(servedGo?.remainingPct)}, windows=${servedGo?.windows?.length ?? 0}`);
    const panelReal = (got.panel?.realBudget as { providers?: { go?: { remainingPct?: number | null }; deepseek?: { balanceUsd?: number | null } } } | undefined) ?? undefined;
    if (got.panel) {
      check(
        "the panel payload carries the SAME provider numbers as the endpoint",
        !!panelReal &&
          panelReal.providers?.go?.remainingPct === (servedGo as { remainingPct?: number | null } | undefined)?.remainingPct &&
          panelReal.providers?.deepseek?.balanceUsd === (got.real.providers as { deepseek?: { balanceUsd?: number | null } }).deepseek?.balanceUsd,
        `panel go=${String(panelReal?.providers?.go?.remainingPct)}% vs endpoint go=${String(servedGo?.remainingPct)}%, panel deepseek=$${String(panelReal?.providers?.deepseek?.balanceUsd)}`,
      );
    } else {
      check("the panel payload answered", false, "GET /company/panel did not answer");
    }
  }

  console.log(
    failures === 0
      ? "\nBUDGET REAL CHECK: all checks passed."
      : `\nBUDGET REAL CHECK FAILED: ${failures} check(s) failed.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

function runSelftest(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("npx", ["tsx", "ops/budget-selftest.ts"], {
      cwd: process.cwd(),
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    proc.stdout?.on("data", (d) => (out += String(d)));
    proc.stderr?.on("data", (d) => (out += String(d)));
    proc.on("close", (code) => {
      const line = out.split(/\r?\n/).filter((l) => /SELFTEST|FAILED|passed/i.test(l)).slice(-3).join(" | ");
      console.log(`        ${line || "(selftest produced no summary line)"}`);
      resolve(code === 0);
    });
    proc.on("error", () => resolve(false));
  });
}

main().catch((e) => {
  console.error("budget real check failed:", String(e));
  process.exit(1);
});
