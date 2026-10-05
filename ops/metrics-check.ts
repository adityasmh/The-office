// ---------------------------------------------------------------------------
// ops/metrics-check.ts - the acceptance checks for the Laya metrics stack
// (docs/METRICS_STACK_SPEC.md section "Checks (must pass)").
//
//   npx tsx ops/metrics-check.ts
//
// What it proves, in order:
//   1. the stack is up: VictoriaMetrics 8428, vmagent 8429, vmalert 8880, host
//      exporter 9101 all accept a loopback connection (metrics-up.ps1 is run
//      first, detached, if something is missing);
//   2. all THREE scrape targets report up=1 within 30 s (asked of VictoriaMetrics
//      itself, not of vmagent), and the router's /company/metrics text parses;
//   3. an alert POSTED TO THE WEBHOOK over HTTP creates exactly ONE manager-queue
//      item, a duplicate POST creates none, and a resolved POST closes it. This
//      runs against a THROWAWAY router (own PORT, own temp COMPANY_ROOT,
//      MOCK_MODE=1 + AIR_GAPPED=1) so the live manager queue and the real Slack
//      are never touched;
//   4. a `ceo` alert calls the Slack sender exactly once, a second one inside the
//      30-minute window calls it zero times (a STUBBED sender is injected, and
//      the script asserts the stub is the one in use);
//   5. the RAM guard: metrics-up.ps1 with a stubbed free-RAM value starts nothing
//      and exits 0;
//   6. npx tsc --noEmit exits 0.
//
// Nothing here restarts the live router, and nothing here talks to real Slack.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { companyAuthHeaders } from "../src/company/authguard.js";

const VM_PORT = Number(process.env.VM_PORT ?? 8428);
const VMAGENT_PORT = Number(process.env.VMAGENT_PORT ?? 8429);
const VMALERT_PORT = Number(process.env.VMALERT_PORT ?? 8880);
const EXPORTER_PORT = Number(process.env.HOST_EXPORTER_PORT ?? 9101);
const THROWAWAY_PORT = Number(process.env.METRICS_CHECK_PORT ?? 8795);
const TARGETS = ["router", "adaptive", "host"];

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];
function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
}

// ── helpers ────────────────────────────────────────────────────────────────
function tcpOpen(port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    const done = (v: boolean) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs: number, everyMs = 1000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

async function waitForHealth(base: string, timeoutMs = 90_000): Promise<boolean> {
  return waitFor(async () => {
    try {
      const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2500) });
      return r.ok;
    } catch {
      return false;
    }
  }, timeoutMs, 700);
}

function killTree(proc: ChildProcess): void {
  if (!proc.pid) return;
  spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}

async function vmQuery(q: string): Promise<Array<{ metric: Record<string, string>; value: [number, string] }>> {
  const r = await fetch(`http://127.0.0.1:${VM_PORT}/api/v1/query?query=${encodeURIComponent(q)}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`VictoriaMetrics answered HTTP ${r.status}`);
  const j = (await r.json()) as { data?: { result?: Array<{ metric: Record<string, string>; value: [number, string] }> } };
  return j.data?.result ?? [];
}

/** Every non-comment line of a Prometheus text body must be "name{labels} value". */
function prometheusTextLooksValid(body: string): { ok: boolean; bad?: string; samples: number } {
  let samples = 0;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})?\s+(-?[\d.eE+]+|NaN|[+-]Inf)$/.test(line)) {
      return { ok: false, bad: line.slice(0, 120), samples };
    }
    samples += 1;
  }
  return { ok: samples > 0, samples };
}

function readPidServices(): Record<string, { pid: number }> {
  try {
    const file = path.join(process.cwd(), "company", "vm-data", "pids.json");
    const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    const j = JSON.parse(raw) as { services?: Record<string, { pid: number }> };
    return j.services ?? {};
  } catch {
    return {};
  }
}

// ── 1. the stack is up ─────────────────────────────────────────────────────
async function ensureStackUp(): Promise<void> {
  const ports: Array<[string, number]> = [
    ["victoria-metrics", VM_PORT],
    ["vmagent", VMAGENT_PORT],
    ["vmalert", VMALERT_PORT],
    ["host-exporter", EXPORTER_PORT],
  ];
  const missing = async () => {
    const out: string[] = [];
    for (const [name, port] of ports) if (!(await tcpOpen(port))) out.push(`${name}:${port}`);
    return out;
  };

  let gone = await missing();
  if (gone.length) {
    console.log(`stack not fully up (${gone.join(", ")}); running ops/metrics-up.ps1 detached...`);
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "ops\\metrics-up.ps1"],
      { cwd: process.cwd(), detached: true, stdio: "ignore", windowsHide: true },
    );
    child.unref();
    // The up-script takes ~15-25 s (RAM read, rules copy, four starts, 6 s settle).
    await waitFor(async () => (await missing()).length === 0, 180_000, 3000);
    gone = await missing();
  }
  record("stack up: 8428/8429/8880/9101 listening", gone.length === 0, gone.length ? `missing ${gone.join(", ")}` : "all four answered");
}

// ── 2. three scrape targets, up=1 within 30 s ─────────────────────────────
async function scrapeTargetsCheck(): Promise<void> {
  const up = async (): Promise<Map<string, string>> => {
    const map = new Map<string, string>();
    try {
      for (const row of await vmQuery('up{job=~"router|adaptive|host"}')) {
        map.set(row.metric.job ?? "?", row.value[1]);
      }
    } catch {
      /* VM not ready yet */
    }
    return map;
  };
  let last = new Map<string, string>();
  const ok = await waitFor(async () => {
    last = await up();
    return TARGETS.every((t) => last.get(t) === "1");
  }, 30_000, 3000);
  const detail = TARGETS.map((t) => `${t}=${last.get(t) ?? "no series"}`).join(" ");
  record("all 3 scrape targets up=1 within 30 s", ok, detail);

  // The router's own text must be well-formed Prometheus.
  try {
    const r = await fetch(`http://127.0.0.1:8787/company/metrics`, { signal: AbortSignal.timeout(10_000) });
    const body = await r.text();
    const parsed = prometheusTextLooksValid(body);
    record("GET /company/metrics parses as Prometheus text", r.ok && parsed.ok, `HTTP ${r.status}, ${parsed.samples} samples${parsed.bad ? `, bad line: ${parsed.bad}` : ""}`);
  } catch (e) {
    record("GET /company/metrics parses as Prometheus text", false, String(e));
  }
  try {
    const r = await fetch(`http://127.0.0.1:${EXPORTER_PORT}/metrics`, { signal: AbortSignal.timeout(8000) });
    const parsed = prometheusTextLooksValid(await r.text());
    record("host exporter /metrics parses as Prometheus text", r.ok && parsed.ok, `HTTP ${r.status}, ${parsed.samples} samples`);
  } catch (e) {
    record("host exporter /metrics parses as Prometheus text", false, String(e));
  }
}

// ── 3. webhook over HTTP, on a throwaway router ───────────────────────────
type AlertBody = {
  status?: string;
  alerts?: Array<{ status?: string; labels?: Record<string, string>; annotations?: Record<string, string>; fingerprint?: string }>;
};

async function postAlert(base: string, body: AlertBody): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers = { "content-type": "application/json", ...(await companyAuthHeaders(base)) };
  const r = await fetch(`${base}/company/alerts/webhook`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

function alertQueueItems(companyRoot: string): Array<{ id: string; state: string; text?: string }> {
  try {
    const file = path.join(companyRoot, "reports", "manager-queue.json");
    const j = JSON.parse(fs.readFileSync(file, "utf8")) as { items?: Array<{ id: string; state: string; text?: string }> };
    return (j.items ?? []).filter((i) => i.id.startsWith("alert:"));
  } catch {
    return [];
  }
}

async function webhookHttpCheck(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jcode-metrics-webhook-"));
  const companyRoot = path.join(tmp, "company");
  fs.mkdirSync(companyRoot, { recursive: true });
  fs.writeFileSync(
    path.join(companyRoot, "org.json"),
    JSON.stringify({ name: "metrics-check", departments: [], projects: [] }, null, 2),
  );
  const base = `http://127.0.0.1:${THROWAWAY_PORT}`;
  const proc = spawn("npx", ["tsx", "src/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(THROWAWAY_PORT),
      COMPANY_ROOT: companyRoot,
      // no real Slack, no outbound call of any kind from this instance
      MOCK_MODE: "1",
      AIR_GAPPED: "1",
      SLACK_BRIDGE: "0",
      BUDGET_POLL_S: "86400",
      BRIEFING_WATCH: "0",
      AUTOCLOSE: "0",
    },
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let log = "";
  proc.stdout?.on("data", (d) => (log += String(d)));
  proc.stderr?.on("data", (d) => (log += String(d)));

  try {
    if (!(await waitForHealth(base, 120_000))) {
      record(
        "webhook: throwaway router came up",
        false,
        `:${THROWAWAY_PORT} never answered /health - ${log.split(/\r?\n/).filter(Boolean).slice(-2).join(" | ") || "no output"}`,
      );
      return;
    }
    const fp = "metrics-check-routine-0001";
    const firing: AlertBody = {
      version: "4",
      status: "firing",
      alerts: [
        {
          status: "firing",
          labels: { alertname: "MetricsCheckSelfTest", severity: "routine", job: "metrics-check" },
          annotations: { summary: "The metrics check posted a routine test alert." },
          fingerprint: fp,
        },
      ],
    };

    const first = await postAlert(base, firing);
    const afterFirst = alertQueueItems(companyRoot);
    record(
      "webhook: a firing routine alert creates exactly ONE manager-queue item",
      first.status === 200 && afterFirst.length === 1 && afterFirst[0]!.state === "pending",
      `HTTP ${first.status}, items=${afterFirst.length}, queued=${JSON.stringify(first.json.queued ?? [])}`,
    );

    const second = await postAlert(base, firing);
    const afterSecond = alertQueueItems(companyRoot);
    const dupes = Array.isArray(second.json.duplicates) ? (second.json.duplicates as string[]) : [];
    record(
      "webhook: a duplicate alert creates NO second item",
      second.status === 200 && afterSecond.length === 1 && dupes.includes(fp),
      `items=${afterSecond.length}, duplicates=${JSON.stringify(dupes)}`,
    );

    const resolved = await postAlert(base, {
      version: "4",
      status: "resolved",
      alerts: [{ status: "resolved", labels: { alertname: "MetricsCheckSelfTest", severity: "routine" }, fingerprint: fp }],
    });
    const afterResolve = alertQueueItems(companyRoot);
    record(
      "webhook: a resolved alert closes the item",
      resolved.status === 200 && afterResolve.length === 1 && afterResolve[0]!.state === "resolved",
      `state=${afterResolve[0]?.state ?? "missing"}, resolved=${JSON.stringify(resolved.json.resolved ?? [])}`,
    );

    // A ceo alert must take the Slack branch exactly once, while MOCK_MODE=1 +
    // AIR_GAPPED=1 guarantee that branch cannot reach real Slack.
    const ceo = await postAlert(base, {
      version: "4",
      status: "firing",
      alerts: [
        {
          status: "firing",
          labels: { alertname: "MetricsCheckCeoTest", severity: "ceo", job: "metrics-check" },
          annotations: { summary: "The metrics check posted a ceo test alert." },
          fingerprint: "metrics-check-ceo-0001",
        },
      ],
    });
    const slack = Array.isArray(ceo.json.slack) ? (ceo.json.slack as Array<{ posted?: boolean; reason?: string }>) : [];
    record(
      "webhook: a ceo alert takes the Slack branch exactly once (mocked, never real Slack)",
      ceo.status === 200 && slack.length === 1 && slack[0]!.reason !== undefined,
      `slack=${JSON.stringify(slack)}`,
    );

    // The check must have proved all of the above against the THROWAWAY root:
    // none of the test fingerprints may appear in the live manager queue.
    const testIds = ["alert:metrics-check-routine-0001", "alert:metrics-check-ceo-0001"];
    const liveQueue = path.join(process.cwd(), "company", "reports", "manager-queue.json");
    let liveHit = false;
    try {
      const raw = fs.readFileSync(liveQueue, "utf8");
      liveHit = testIds.some((id) => raw.includes(id));
    } catch {
      liveHit = false;
    }
    record(
      "webhook: none of the test alerts leaked into the LIVE manager queue",
      !liveHit,
      `checked ${liveQueue}`,
    );
  } catch (e) {
    record("webhook: HTTP checks", false, String(e));
  } finally {
    killTree(proc);
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* OS temp is disposable */
    }
  }
}

// ── 4. ceo -> stubbed Slack sender, once per 30 minutes ───────────────────
async function stubbedSenderCheck(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jcode-metrics-stub-"));
  const companyRoot = path.join(tmp, "company");
  fs.mkdirSync(path.join(companyRoot, "reports"), { recursive: true });
  fs.writeFileSync(
    path.join(companyRoot, "reports", "manager-queue.json"),
    JSON.stringify({ updatedAt: new Date().toISOString(), items: [] }, null, 2),
  );
  process.env.COMPANY_ROOT = companyRoot;

  // Import AFTER COMPANY_ROOT is set: src/company/org.ts reads it at module load.
  const alerts = await import("../src/metrics/alerts.js");
  const sent: string[] = [];
  alerts.setAlertSlackSender(async (text: string) => {
    sent.push(text);
    return { posted: true, ts: "stub-1" };
  });
  let now = Date.parse("2026-10-01T12:00:00.000Z");
  alerts.setAlertClock(() => now);
  try {
    record("ceo -> stub: the test sender replaced the real Slack bridge", alerts.alertSlackSenderIsStub(), `sender is the stub`);

    const ceoAlert = {
      version: "4",
      status: "firing",
      alerts: [
        {
          status: "firing",
          labels: { alertname: "StubCeoAlert", severity: "ceo" },
          annotations: { summary: "Router is not responding for 2 minutes." },
          fingerprint: "stub-ceo-0001",
        },
      ],
    };
    const first = await alerts.receiveAlerts(ceoAlert);
    const second = await alerts.receiveAlerts(ceoAlert);
    record(
      "ceo -> stub: exactly ONE Slack call for one alert",
      sent.length === 1 && first.slack.length === 1 && first.slack[0]!.posted === true,
      `calls=${sent.length}, text="${sent[0] ?? ""}"`,
    );
    record(
      "ceo -> stub: inside 30 minutes a repeat sends NO further Slack message",
      second.slack.length === 1 && second.slack[0]!.posted === false && sent.length === 1,
      `reason="${second.slack[0]?.reason ?? ""}"`,
    );

    // 31 minutes later the rate limit has expired.
    now += 31 * 60_000;
    const third = await alerts.receiveAlerts(ceoAlert);
    record(
      "ceo -> stub: after the interval one more Slack message is allowed",
      sent.length === 2 && third.slack.length === 1 && third.slack[0]!.posted === true,
      `calls=${sent.length}`,
    );

    // The plain-words shape the spec asks for.
    record(
      "ceo -> stub: the message is plain words, no secrets/prompt text",
      /Router is not responding for 2 minutes\./.test(sent[0] ?? "") && !/xox|sk-|token/i.test(sent[0] ?? ""),
      `"${(sent[0] ?? "").slice(0, 90)}"`,
    );

    // Resolve closes the queue item.
    const resolved = await alerts.receiveAlerts({
      version: "4",
      status: "resolved",
      alerts: [{ status: "resolved", labels: { alertname: "StubCeoAlert", severity: "ceo" }, fingerprint: "stub-ceo-0001" }],
    });
    const items = alertQueueItems(companyRoot);
    record(
      "ceo -> stub: resolve closes the queue item",
      resolved.resolved.length === 1 && items.length === 1 && items[0]!.state === "resolved",
      `state=${items[0]?.state ?? "missing"}, stateFile=${alerts.alertStateFile()}`,
    );
  } finally {
    alerts.setAlertSlackSender(null);
    alerts.setAlertClock(null);
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* OS temp is disposable */
    }
    delete process.env.COMPANY_ROOT;
  }
}

// ── 5. the RAM guard ──────────────────────────────────────────────────────
function ramGuardCheck(): void {
  const before = JSON.stringify(readPidServices());
  const run = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "ops\\metrics-up.ps1"],
    {
      cwd: process.cwd(),
      env: { ...process.env, METRICS_RAM_GUARD_STUB_MB: "100" },
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const after = JSON.stringify(readPidServices());
  const refused = /NOT starting/.test(out) && /below the 1536 MB guard/.test(out);
  record(
    "RAM guard: a stubbed free-RAM value below 1.5 GB starts nothing and exits 0",
    run.status === 0 && refused && before === after,
    `exit=${run.status}, refused=${refused}, pid file unchanged=${before === after}`,
  );
}

// ── 6. typecheck ──────────────────────────────────────────────────────────
function typecheck(): void {
  const run = spawnSync("npx", ["tsc", "--noEmit"], { cwd: process.cwd(), encoding: "utf8", timeout: 600_000, shell: true });
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
  record("npx tsc --noEmit exits 0", run.status === 0, out ? out.split(/\r?\n/).slice(0, 3).join(" | ") : "no output");
}

// ── main ──────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("metrics-check: Laya metrics stack acceptance checks\n");
  await ensureStackUp();
  await scrapeTargetsCheck();
  await ramGuardCheck();
  await webhookHttpCheck();
  await stubbedSenderCheck();
  typecheck();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("FAILED:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.log("METRICS CHECK PASS");
  process.exit(0);
}

main().catch((e) => {
  console.error(`metrics-check crashed: ${String(e instanceof Error ? e.stack ?? e.message : e)}`);
  process.exit(2);
});
