/**
 * ops/loop-lag-check.ts
 *
 * Starts a throwaway router on port 8795 with a temp COMPANY_ROOT, measures
 * /health lagMs and lagMaxMs over 60 s idle and under 20 concurrent GET
 * /company/panel requests, then kills the router.
 *
 * Usage:
 *   npx tsx ops/loop-lag-check.ts
 *
 * The live router on :8787 is never touched.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const PORT = 8795;
const IDLE_SECONDS = 60;
const CONCURRENT_PANEL_REQUESTS = 20;
const PANEL_URL = `http://127.0.0.1:${PORT}/company/panel?lite=1`;
const HEALTH_URL = `http://127.0.0.1:${PORT}/health`;

function nowIso(): string {
  return new Date().toISOString();
}

function log(line: string): void {
  console.log(`[loop-lag-check] ${line}`);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url: string, timeoutMs = 30000): Promise<Record<string, unknown>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const text = await res.text();
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { _parseError: text };
    }
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHealth(maxMs = 120000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const j = await fetchJson(HEALTH_URL, 5000);
      if (j.ok === true) return;
    } catch {
      // not ready yet
    }
    await sleep(500);
  }
  throw new Error(`router did not become healthy within ${maxMs}ms`);
}

type Sample = { at: string; lagMs: number; lagMaxMs: number };

async function sampleHealth(durationMs: number, label: string): Promise<Sample[]> {
  const samples: Sample[] = [];
  const start = Date.now();
  log(`sampling /health for ${durationMs}ms (${label})...`);
  while (Date.now() - start < durationMs) {
    try {
      const j = await fetchJson(HEALTH_URL, 5000);
      const s: Sample = {
        at: nowIso(),
        lagMs: typeof j.lagMs === "number" ? j.lagMs : -1,
        lagMaxMs: typeof j.lagMaxMs === "number" ? j.lagMaxMs : -1,
      };
      samples.push(s);
    } catch (e) {
      samples.push({ at: nowIso(), lagMs: -1, lagMaxMs: -1 });
    }
    await sleep(1000);
  }
  return samples;
}

function summarize(samples: Sample[]): { maxLagMs: number; maxLagMaxMs: number; finalLagMs: number; finalLagMaxMs: number; count: number } {
  let maxLagMs = 0;
  let maxLagMaxMs = 0;
  for (const s of samples) {
    if (s.lagMs > maxLagMs) maxLagMs = s.lagMs;
    if (s.lagMaxMs > maxLagMaxMs) maxLagMaxMs = s.lagMaxMs;
  }
  const last = samples[samples.length - 1] ?? { lagMs: -1, lagMaxMs: -1 };
  return { maxLagMs, maxLagMaxMs, finalLagMs: last.lagMs, finalLagMaxMs: last.lagMaxMs, count: samples.length };
}

async function hammerPanel(concurrency: number): Promise<void> {
  log(`hammering GET /company/panel?lite=1 with ${concurrency} concurrent requests...`);
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      try {
        await fetchJson(PANEL_URL, 30000);
      } catch {
        // we only care that the requests hit the router
      }
    }),
  );
}

function copyDir(src: string, dst: string, filter?: (name: string) => boolean): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (filter && !filter(name)) continue;
    const s = path.join(src, name);
    const d = path.join(dst, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) {
      copyDir(s, d, filter);
    } else if (st.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

function seedFromReal(root: string): void {
  const realCompany = path.join(process.cwd(), "company");
  if (!fs.existsSync(realCompany)) return;

  fs.mkdirSync(root, { recursive: true });

  // Core files that the panel/flow routes read synchronously.
  for (const name of ["org.json", "sessions.jsonl", "budgets.json", "assistant.jsonl", "slack-inbound.json"]) {
    const s = path.join(realCompany, name);
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(root, name));
  }

  copyDir(path.join(realCompany, "fleet"), path.join(root, "fleet"));
  copyDir(path.join(realCompany, "reports"), path.join(root, "reports"), (n) => n.endsWith(".json") || n.endsWith(".jsonl") || n.endsWith(".md"));
  copyDir(path.join(realCompany, "budget"), path.join(root, "budget"));

  // Project tasks only (the expensive part is the task list, not source files).
  fs.mkdirSync(path.join(root, "projects"), { recursive: true });
  if (fs.existsSync(path.join(realCompany, "projects"))) {
    for (const pid of fs.readdirSync(path.join(realCompany, "projects"))) {
      const srcDir = path.join(realCompany, "projects", pid);
      const dstDir = path.join(root, "projects", pid);
      const st = fs.statSync(srcDir);
      if (!st.isDirectory()) continue;
      fs.mkdirSync(dstDir, { recursive: true });
      for (const name of ["tasks.json", "thread.jsonl", "cost.jsonl"]) {
        const s = path.join(srcDir, name);
        if (fs.existsSync(s)) fs.copyFileSync(s, path.join(dstDir, name));
      }
    }
  }

  // .jcode session state drives discovery of runs and terminals.
  const realJcode = path.join(os.homedir(), ".jcode");
  if (fs.existsSync(realJcode)) {
    copyDir(path.join(realJcode, "sessions"), path.join(root, ".jcode-sessions"), (n) => n.endsWith(".json") || n.endsWith(".journal.jsonl"));
    copyDir(path.join(realJcode, "client_sessions"), path.join(root, ".jcode-client_sessions"));
  }
}

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loop-lag-check-"));
  const companyRoot = path.join(tmp, "company");

  // Seed from the live company tree so the measurement reflects real stalls.
  seedFromReal(companyRoot);
  log(`seeded temp COMPANY_ROOT from real company/ data`);

  const env = {
    ...process.env,
    PORT: String(PORT),
    COMPANY_ROOT: companyRoot,
    SLACK_BRIDGE: "0",
    AIR_GAPPED: "1",
    MOCK_MODE: "1",
    AUTOCLOSE: "0",
    FLEET_WATCH_INTERVAL_MS: "5000",
    BUDGET_REAL_TIMEOUT_MS: "3000",
  };

  log(`starting throwaway router on port ${PORT} with COMPANY_ROOT=${companyRoot}`);
  const node = process.execPath;
  const child = spawn(
    node,
    [
      "--require",
      path.join(process.cwd(), "node_modules/tsx/dist/preflight.cjs"),
      "--import",
      `file:///${path.join(process.cwd(), "node_modules/tsx/dist/loader.mjs").replace(/\\/g, "/")}`,
      path.join(process.cwd(), "src/server.ts"),
    ],
    {
      env,
      cwd: process.cwd(),
      stdio: "ignore",
      detached: true,
    },
  );

  try {
    await waitForHealth(120000);
    log(`router healthy on port ${PORT}`);

    // 1) idle measurement
    const idleSamples = await sampleHealth(IDLE_SECONDS * 1000, "idle");
    const idle = summarize(idleSamples);
    log(`idle summary: ${JSON.stringify(idle)}`);

    // 2) under load: sample during and after the concurrent panel burst
    const loadStart = Date.now();
    const loadPromise = hammerPanel(CONCURRENT_PANEL_REQUESTS);
    const loadSamples = sampleHealth(20000, "during panel burst");
    await loadPromise;
    const loadEnd = Date.now();
    const load = summarize(await loadSamples);
    log(`panel burst took ${loadEnd - loadStart}ms; load summary: ${JSON.stringify(load)}`);

    // 3) recovery sample
    await sleep(5000);
    const recoverySamples = await sampleHealth(10000, "post-burst recovery");
    const recovery = summarize(recoverySamples);
    log(`recovery summary: ${JSON.stringify(recovery)}`);

    // Final report
    console.log("\n=== LOOP LAG REPORT ===");
    console.log(`port: ${PORT}`);
    console.log(`companyRoot: ${companyRoot}`);
    console.log(`idle (60 s):     maxLagMs=${idle.maxLagMs}  maxLagMaxMs=${idle.maxLagMaxMs}  samples=${idle.count}`);
    console.log(`panel burst:     maxLagMs=${load.maxLagMs}  maxLagMaxMs=${load.maxLagMaxMs}  samples=${load.count}`);
    console.log(`recovery (10 s): maxLagMs=${recovery.maxLagMs}  maxLagMaxMs=${recovery.maxLagMaxMs}  samples=${recovery.count}`);
  } finally {
    try {
      process.kill(-child.pid!, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        // best effort
      }
    }
    await sleep(1000);
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // leave temp behind if busy
    }
  }
}

main().catch((e) => {
  console.error("[loop-lag-check] failed:", e);
  process.exit(1);
});
