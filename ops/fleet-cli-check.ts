#!/usr/bin/env node
/**
 * ops/fleet-cli-check.ts - proof for order F06-fleet-cli (2026-10-06).
 *
 * Starts a local stub HTTP server on a free port that mimics the fleet router,
 * runs the REAL ops/fleet-cli.ts as a child process against it, and prints PASS
 * or FAIL per line. The only network calls go to 127.0.0.1 on that stub; the
 * router is never started, restarted or contacted. The COMPANY_AUTH_TOKEN used
 * here is a FAKE value and the repository .env is never opened by this harness.
 *
 *   npx tsx ops/fleet-cli-check.ts
 *
 * Prints PASS or FAIL per line; exit code is 1 if any line is FAIL.
 *
 * Covered:
 *   1. status / orders / show / new / approve / cancel / workers / tail each
 *      print the rows the stub served
 *   2. GET calls send no token and POST calls send it (x-company-token)
 *   3. the token value never appears in any output
 *   4. a 401 and a 503 give the plain-words messages
 *   5. --json parses
 *   6. an unknown command prints usage and exits 1
 */
import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HARNESS_DIR, "..");
const FAKE_TOKEN = "fleet_cli_check_fake_token_5c1d";
const ORDER_ID = "foCHECK001";
const OTHER_ID = "foCHECK002";
const NEW_ID = "foCHECKNEW1";
const SESSION_ID = "sess-check-aaa";

// ── stub data (fake, local only) ─────────────────────────────────────────────

const HEALTH = {
  ok: true,
  claude: "subscription-only, no api key",
  credsPresent: true,
  mock: false,
  bind: "127.0.0.1",
  authTokenConfigured: true,
  lagMs: 1,
  lagP95Ms: 1,
  lagMaxMs: 3,
};

const LAYA = {
  ok: true,
  device: "gpu",
  checkpointDevices: {},
  cpuFallbacks: {},
  loaded: ["laya"],
  pids: [4242],
  gpu: { name: "Fake GPU", usedMiB: 512, totalMiB: 8192 },
  layaGpuMiB: 512,
  requestedDevice: "gpu",
  starting: null,
  lastStartError: null,
  gpuHeadroom: null,
  fallbackNotice: null,
};

const ROUTING = {
  generatedAt: "2026-10-06T01:02:03.000Z",
  sampleStandard: { model: "deepseek-v4.1-flash", use: true, provider: "deepseek", modelId: "deepseek-chat", why: "off-peak and cheaper" },
  sampleHard: { model: "kimi-k2.7-code", use: false, provider: "opencode-go", modelId: "kimi-k2.7-code", why: "Go window has room" },
  go: { known: true, state: "green", remainingPct: 71, bindingWindow: "5h", resetsAt: "2026-10-06T06:00:00.000Z", resetsIn: "5h", checkedAt: "2026-10-06T01:00:00.000Z" },
  deepseek: { phase: "off-peak", minutesToChange: 30, ist: "01:30", keyPresent: true, armed: true, coolOff: false, goExhausted: false },
  counters: {
    boot: { directOk: 1, directFailed: 0, goOk: 0, goFailed: 0, fallbackGoToDirect: 0, fallbackDirectToGo: 0 },
    last60m: { directOk: 1, directFailed: 0, goOk: 0, goFailed: 0, fallbackGoToDirect: 0, fallbackDirectToGo: 0 },
  },
  lastFailures: [],
};

const SESSIONS = {
  running: 1,
  queued: 0,
  total: 1,
  items: [
    { id: SESSION_ID, agent: "coder-1", status: "running", model: "kimi-k2.7-code", task: "write the readme", department: "eng", project: "p1" },
  ],
};

const ORDER_ONE = {
  id: ORDER_ID,
  text: "add a readme section",
  createdAt: "2026-10-06T01:02:03.000Z",
  updatedAt: "2026-10-06T01:05:06.000Z",
  status: "running",
  plan: "1. write the readme",
  workOrders: [
    {
      id: "WO1",
      title: "readme section",
      role: "DOCS",
      owns: ["README.md"],
      state: "working",
      attempts: 0,
      sessionId: SESSION_ID,
      live: { streaming: true, lastActivity: "2026-10-06T01:05:00.000Z", tail: ["line one", "line two", "line three"] },
      reportPath: `company/fleet/${ORDER_ID}/WO1/REPORT.md`,
    },
  ],
  trace: [],
};

const ORDER_TWO = {
  id: OTHER_ID,
  text: "tidy config",
  createdAt: "2026-10-06T00:30:00.000Z",
  updatedAt: "2026-10-06T00:31:00.000Z",
  status: "awaiting_approval",
  workOrders: [],
  trace: [],
};

function fleetPayload() {
  return {
    orders: [ORDER_ONE, ORDER_TWO],
    limits: { maxSessions: 6, running: 1 },
    watcher: { running: true, intervalMs: 5000 },
  };
}

// ── the stub server ──────────────────────────────────────────────────────────

type Rec = { method: string; path: string; token: string | null; body: string };
const requests: Rec[] = [];
let mode: "ok" | "unauthorized" | "paused" = "ok";

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const method = req.method ?? "GET";
    const rawUrl = req.url ?? "/";
    const url = new URL(rawUrl, "http://127.0.0.1");
    const pathname = url.pathname;
    const token = (req.headers["x-company-token"] as string | undefined) ?? null;
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({ method, path: pathname, token, body });

    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (method === "POST" && mode === "paused") {
      return send(503, { error: "company_paused", detail: "the company is shutting down" });
    }
    if (method === "POST" && mode === "unauthorized") {
      return send(401, { error: "unauthorized", detail: "bad token", header: "x-company-token", hint: "send the x-company-token header" });
    }
    if (method === "POST" && token !== FAKE_TOKEN) {
      return send(401, { error: "unauthorized", detail: "bad token", header: "x-company-token", hint: "send the x-company-token header" });
    }

    // GET routes
    if (method === "GET" && pathname === "/health") return send(200, HEALTH);
    if (method === "GET" && pathname === "/company/laya") return send(200, LAYA);
    if (method === "GET" && pathname === "/company/routing/policy") return send(200, ROUTING);
    if (method === "GET" && pathname === "/company/sessions") return send(200, SESSIONS);
    if (method === "GET" && pathname === `/company/sessions/${SESSION_ID}`) return send(200, { ...SESSIONS.items[0], tail: ["session line A", "session line B"] });
    if (method === "GET" && pathname === "/company/fleet") return send(200, fleetPayload());
    if (method === "GET" && pathname === `/company/fleet/orders/${ORDER_ID}`) return send(200, ORDER_ONE);
    if (method === "GET" && pathname === `/company/fleet/orders/${OTHER_ID}`) return send(200, ORDER_TWO);

    // POST routes
    if (method === "POST" && pathname === "/company/fleet/orders") {
      let text = "";
      try {
        text = String((JSON.parse(body) as { text?: unknown }).text ?? "");
      } catch {
        text = "";
      }
      return send(200, { id: NEW_ID, text, status: "planning", createdAt: "2026-10-06T01:06:00.000Z", updatedAt: "2026-10-06T01:06:00.000Z", workOrders: [], trace: [] });
    }
    if (method === "POST" && pathname === `/company/fleet/orders/${ORDER_ID}/approve`) {
      return send(200, { ...ORDER_ONE, status: "running" });
    }
    if (method === "POST" && pathname === `/company/fleet/orders/${ORDER_ID}/cancel`) {
      return send(200, { ...ORDER_ONE, status: "cancelled" });
    }

    return send(404, { error: "not found" });
  });
});

// ── running the real CLI ─────────────────────────────────────────────────────

const base = await new Promise<string>((resolve) => {
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as AddressInfo).port;
    resolve(`http://127.0.0.1:${port}`);
  });
});

const allOutputs: string[] = [];

function runCli(command: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(`npx tsx ops/fleet-cli.ts ${command}`, [], {
      cwd: REPO_ROOT,
      shell: true,
      windowsHide: true,
      env: { ...process.env, FLEET_URL: base, COMPANY_AUTH_TOKEN: FAKE_TOKEN },
    });
    let out = "";
    let settled = false;
    const timer = setTimeout(() => child.kill(), 180_000);
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      allOutputs.push(out);
      resolve({ code, out });
    };
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
    child.on("close", (code) => finish(code ?? -1));
    child.on("error", () => finish(-1));
  });
}

const q = (s: string): string => `"${s}"`;

// ── checks ───────────────────────────────────────────────────────────────────

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? `  -> ${detail}` : ""}`);
}
const has = (out: string, ...needles: string[]): boolean => needles.every((n) => out.includes(n));

async function main(): Promise<void> {
  // 1. status ---------------------------------------------------------------
  const status = await runCli("status");
  check(
    "status exits 0 and prints health, Laya, routing policy and running sessions",
    status.code === 0 && has(status.out, "health", "ok=true", "laya", "Fake GPU", "routing", "deepseek-v4.1-flash", "sessions", SESSION_ID, "coder-1"),
    `exit=${status.code}`,
  );

  // 2. orders ---------------------------------------------------------------
  const orders = await runCli("orders");
  check(
    "orders prints both stub orders with state and progress",
    orders.code === 0 && has(orders.out, ORDER_ID, OTHER_ID, "running", "awaiting_approval", "0/1", "add a readme section"),
    `exit=${orders.code}`,
  );

  const filtered = await runCli("orders --status running");
  check(
    "orders --status running filters out the other status",
    filtered.code === 0 && has(filtered.out, ORDER_ID) && !filtered.out.includes(OTHER_ID),
    `exit=${filtered.code}`,
  );

  // 3. show -----------------------------------------------------------------
  const show = await runCli(`show ${ORDER_ID}`);
  check(
    "show prints the order and its work order row",
    show.code === 0 && has(show.out, ORDER_ID, "running", "1. write the readme", "WO1", "DOCS", "line three"),
    `exit=${show.code}`,
  );

  // 4. new ------------------------------------------------------------------
  const newOut = await runCli(`new ${q("a brand new order")}`);
  const newBody = requests.filter((r) => r.method === "POST" && r.path === "/company/fleet/orders").at(-1)?.body ?? "";
  let newText = "";
  try {
    newText = String((JSON.parse(newBody) as { text?: unknown }).text ?? "");
  } catch {
    newText = "";
  }
  check(
    "new POSTs the text and prints the new order id",
    newOut.code === 0 && newOut.out.includes(NEW_ID) && newText === "a brand new order",
    `exit=${newOut.code}; body.text=${JSON.stringify(newText)}`,
  );

  // 5. approve / cancel -----------------------------------------------------
  const approve = await runCli(`approve ${ORDER_ID}`);
  check("approve prints the approved order", approve.code === 0 && has(approve.out, ORDER_ID, "running"), `exit=${approve.code}`);

  const cancel = await runCli(`cancel ${ORDER_ID}`);
  check("cancel prints the cancelled order", cancel.code === 0 && has(cancel.out, ORDER_ID, "cancelled"), `exit=${cancel.code}`);

  // 6. workers --------------------------------------------------------------
  const workers = await runCli("workers");
  check(
    "workers lists every work order across orders",
    workers.code === 0 && has(workers.out, ORDER_ID, "WO1", "DOCS", "working"),
    `exit=${workers.code}`,
  );

  // 7. tail -----------------------------------------------------------------
  const tail = await runCli(`tail ${ORDER_ID}/WO1 --lines 2`);
  check(
    "tail --lines prints only the requested tail lines",
    tail.code === 0 && has(tail.out, "line two", "line three") && !tail.out.includes("line one"),
    `exit=${tail.code}`,
  );

  // 8. auth: GET sends no token, POST sends it ------------------------------
  const okModeRequests = requests.slice();
  const gets = okModeRequests.filter((r) => r.method === "GET");
  const posts = okModeRequests.filter((r) => r.method === "POST");
  check(
    "GET calls send no x-company-token header",
    gets.length > 0 && gets.every((r) => r.token === null),
    `gets=${gets.length}; with token=${gets.filter((r) => r.token !== null).length}`,
  );
  check(
    "POST calls send the token in x-company-token",
    posts.length > 0 && posts.every((r) => r.token === FAKE_TOKEN),
    `posts=${posts.length}; correct=${posts.filter((r) => r.token === FAKE_TOKEN).length}`,
  );

  // 9. the token never appears in any output --------------------------------
  const leaking = allOutputs.filter((o) => o.includes(FAKE_TOKEN));
  check(
    "the token value never appears in any command output",
    leaking.length === 0,
    leaking.length ? `leaked in ${leaking.length} output(s)` : `checked ${allOutputs.length} outputs`,
  );

  // 10. --json parses -------------------------------------------------------
  const jsonCmds = ["status", "orders", `show ${ORDER_ID}`, "workers", `tail ${ORDER_ID}/WO1 --lines 2`];
  const jsonResults: boolean[] = [];
  for (const c of jsonCmds) {
    const r = await runCli(`${c} --json`);
    let parsed = false;
    try {
      parsed = typeof JSON.parse(r.out.trim()) === "object" && JSON.parse(r.out.trim()) !== null;
    } catch {
      parsed = false;
    }
    jsonResults.push(r.code === 0 && parsed);
  }
  check(
    "--json prints one parsable JSON object for every command",
    jsonResults.every(Boolean),
    `parsed ${jsonResults.filter(Boolean).length}/${jsonResults.length}`,
  );

  // 11. unknown command -----------------------------------------------------
  const unknown = await runCli("definitely-not-a-command");
  check(
    "an unknown command prints usage and exits 1",
    unknown.code === 1 && /usage/i.test(unknown.out),
    `exit=${unknown.code}`,
  );

  // 12. 401 plain message ---------------------------------------------------
  mode = "unauthorized";
  const unauth = await runCli(`cancel ${ORDER_ID}`);
  check(
    "a 401 gives the plain token message and exits 1",
    unauth.code === 1 && /401/.test(unauth.out) && /token/i.test(unauth.out) && unauth.out.includes("COMPANY_AUTH_TOKEN") && !unauth.out.includes(FAKE_TOKEN),
    `exit=${unauth.code}`,
  );

  // 13. 503 plain message ---------------------------------------------------
  mode = "paused";
  const paused = await runCli(`new ${q("another order")}`);
  check(
    "a 503 gives the plain paused-company message and exits 1",
    paused.code === 1 && /503/.test(paused.out) && /paused/i.test(paused.out) && !paused.out.includes(FAKE_TOKEN),
    `exit=${paused.code}`,
  );
}

try {
  await main();
} catch (e) {
  check("harness completed without throwing", false, String(e instanceof Error ? e.message : e));
} finally {
  server.close();
}

console.log(failures === 0 ? "fleet-cli-check: all checks passed" : `fleet-cli-check: ${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
