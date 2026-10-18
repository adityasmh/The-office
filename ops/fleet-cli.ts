#!/usr/bin/env node
/**
 * ops/fleet-cli.ts - one command line client for the Laya fleet, so a developer
 * does not need the dashboard.
 *
 *   npx tsx ops/fleet-cli.ts status
 *   npx tsx ops/fleet-cli.ts orders [--status running]
 *   npx tsx ops/fleet-cli.ts show <id>
 *   npx tsx ops/fleet-cli.ts new "<text>" [--auto-approve]
 *   npx tsx ops/fleet-cli.ts approve <id>
 *   npx tsx ops/fleet-cli.ts cancel <id>
 *   npx tsx ops/fleet-cli.ts workers
 *   npx tsx ops/fleet-cli.ts tail <orderId>/<wid> [--lines N]
 *
 * Base URL: $FLEET_URL (default http://127.0.0.1:8787).
 *
 * The company auth token is read from $COMPANY_AUTH_TOKEN or, only when that is
 * unset, from COMPANY_AUTH_TOKEN in .env (only inside this tool). It is sent ONLY
 * as the x-company-token header on POST calls and is never printed or logged.
 *
 * --json prints the raw JSON payload instead of the table. Exit code is 0 on
 * success and 1 on any HTTP/network error or bad usage. A 401 explains the token
 * and a 503 explains a paused company, in plain words.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TOOL_DIR, "..");
const DEFAULT_BASE = "http://127.0.0.1:8787";
const TIMEOUT_MS = 10_000;
const TOKEN_ENV = "COMPANY_AUTH_TOKEN";

type Json = Record<string, unknown>;
type Result = { status: number; text: string; json: unknown };

// ── arguments ────────────────────────────────────────────────────────────────

type Options = {
  json: boolean;
  autoApprove: boolean;
  status: string;
  lines: number;
  help: boolean;
  positionals: string[];
};

function parseArgs(args: string[]): Options {
  const o: Options = { json: false, autoApprove: false, status: "", lines: 15, help: false, positionals: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--json") o.json = true;
    else if (a === "--auto-approve") o.autoApprove = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--status") o.status = args[++i] ?? "";
    else if (a === "--lines") o.lines = Math.max(1, Number(args[++i]) || 15);
    else o.positionals.push(a);
  }
  return o;
}

// ── token and base URL ───────────────────────────────────────────────────────

/** Reads only COMPANY_AUTH_TOKEN from .env; the value is returned, never printed. */
function readEnvToken(): string {
  try {
    const cwdPath = path.join(process.cwd(), ".env");
    const file = fs.existsSync(cwdPath) ? cwdPath : path.join(REPO_ROOT, ".env");
    if (!fs.existsSync(file)) return "";
    for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      if (line.slice(0, eq).trim() !== TOKEN_ENV) continue;
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      return val;
    }
  } catch {
    /* a missing or unreadable .env just means no token */
  }
  return "";
}

const token = (process.env[TOKEN_ENV] ?? "").trim() || readEnvToken();
const base = (process.env.FLEET_URL || DEFAULT_BASE).replace(/\/+$/, "");

// ── output helpers ───────────────────────────────────────────────────────────

const clip = (s: unknown, n = 60): string => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const hhmmss = (s: unknown): string => {
  const t = String(s ?? "");
  return t.length >= 19 ? t.slice(11, 19) : t || "-";
};
function arr<T = unknown>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/** Plain aligned table: one header row plus one row per record, columns padded. */
function table(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)));
  const render = (cells: string[]) =>
    cells.map((c, i) => String(c ?? "").padEnd(widths[i] ?? 0)).join("  ").replace(/\s+$/, "");
  return [render(headers), ...rows.map(render)];
}

class HttpError extends Error {}

function plainHttpError(res: Result): string {
  if (res.status === 401) {
    return "HTTP 401 unauthorized - the company token is missing or wrong. Set COMPANY_AUTH_TOKEN, or add COMPANY_AUTH_TOKEN to .env, then try again.";
  }
  if (res.status === 503) {
    const j = res.json as Json | undefined;
    const detail = j && typeof j.detail === "string" ? ` ${clip(j.detail, 160)}` : "";
    return `HTTP 503 - the company is paused, so it is refusing work.${detail} Resume it (System page, or Start Laya Company) and try again.`;
  }
  const j = res.json as Json | undefined;
  const bits =
    j && typeof j === "object"
      ? [j.error, j.detail].filter((v) => typeof v === "string").join(" - ")
      : "";
  const detail = bits || clip(res.text, 200);
  return `HTTP ${res.status}${detail ? `: ${detail}` : ""}`;
}

async function request(method: "GET" | "POST", route: string, body?: unknown): Promise<Result> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (method === "POST") {
    headers["content-type"] = "application/json";
    // The token rides on POST only, and is never echoed anywhere.
    if (token) headers["x-company-token"] = token;
  }
  const res = await fetch(`${base}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json };
}

async function call(method: "GET" | "POST", route: string, body?: unknown): Promise<Json> {
  let res: Result;
  try {
    res = await request(method, route, body);
  } catch (e) {
    const err = e as Error & { cause?: unknown };
    const why = err?.name === "TimeoutError" ? `timed out after ${TIMEOUT_MS}ms` : clip(err?.cause ?? err?.message ?? e, 160);
    throw new HttpError(`cannot reach the fleet router at ${base} (${why}). Is the router running?`);
  }
  if (res.status < 200 || res.status >= 300) throw new HttpError(plainHttpError(res));
  return (res.json ?? {}) as Json;
}

// ── commands ─────────────────────────────────────────────────────────────────

type Output = { lines: string[]; json: unknown };

function routingLine(r: Json): string {
  const one = (s: unknown): string => {
    const x = s as Json | undefined;
    if (!x || x.model === undefined) return "?";
    return `${x.model} -> ${x.provider} (use=${x.use}; ${clip(x.why, 60)})`;
  };
  const go = r.go as Json | undefined;
  const goText = go?.known
    ? `go remaining ${go.remainingPct}%${go.bindingWindow ? ` window=${go.bindingWindow}` : ""}`
    : "go unknown";
  const ds = r.deepseek as Json | undefined;
  return `standard ${one(r.sampleStandard)} | hard ${one(r.sampleHard)} | ${goText}${ds ? ` | deepseek ${ds.phase}` : ""}`;
}

async function cmdStatus(): Promise<Output> {
  const [health, laya, routing, sessions] = await Promise.all([
    call("GET", "/health"),
    call("GET", "/company/laya"),
    call("GET", "/company/routing/policy"),
    call("GET", "/company/sessions"),
  ]);
  const gpu = laya.gpu as Json | undefined;
  const lines: string[] = [
    `health    : ok=${health.ok} mock=${health.mock} bind=${health.bind} token=${health.authTokenConfigured ? "configured" : "missing"}`,
    `laya      : ok=${laya.ok} device=${laya.device ?? "-"} pids=${arr(laya.pids).length}` +
      (gpu ? ` gpu=${clip(gpu.name, 30)} (${gpu.usedMiB}/${gpu.totalMiB} MiB)` : ""),
    `routing   : ${routingLine(routing)}`,
    `sessions  : running=${sessions.running} queued=${sessions.queued} total=${sessions.total}`,
  ];
  const items = arr<Json>(sessions.items);
  if (items.length) {
    lines.push("");
    lines.push(
      ...table(
        ["id", "agent", "status", "model", "task"],
        items.map((s) => [clip(s.id, 24), clip(s.agent, 14), clip(s.status, 9), clip(s.model, 20), clip(s.task, 50)]),
      ),
    );
  }
  return { lines, json: { health, laya, routing, sessions } };
}

async function cmdOrders(opts: Options): Promise<Output> {
  const data = await call("GET", "/company/fleet");
  let orders = arr<Json>(data.orders);
  if (opts.status) orders = orders.filter((o) => String(o.status).toLowerCase() === opts.status.toLowerCase());
  const limits = (data.limits as Json | undefined) ?? {};
  const watcher = (data.watcher as Json | undefined) ?? {};
  const lines: string[] = [
    `limits : maxSessions=${limits.maxSessions ?? "-"} running=${limits.running ?? "-"}   ` +
      `watcher=${watcher.running ? "on" : "off"} (${watcher.intervalMs ?? "-"}ms)   orders=${orders.length}`,
    ...table(
      ["id", "status", "created", "progress", "text"],
      orders.map((o) => {
        const wos = arr<Json>(o.workOrders);
        const passed = wos.filter((w) => w.verdict === "PASS").length;
        return [clip(o.id, 16), clip(o.status, 18), hhmmss(o.createdAt), `${passed}/${wos.length}`, clip(o.text, 50)];
      }),
    ),
  ];
  return { lines, json: { ...data, orders } };
}

async function cmdShow(id: string): Promise<Output> {
  const o = await call("GET", `/company/fleet/orders/${encodeURIComponent(id)}`);
  const wos = arr<Json>(o.workOrders);
  const lines: string[] = [
    `order   : ${o.id}`,
    `status  : ${o.status}`,
    `created : ${o.createdAt}   updated=${o.updatedAt}`,
    `text    : ${clip(o.text, 100)}`,
  ];
  if (o.error) lines.push(`error   : ${clip(o.error, 160)}`);
  if (o.summary) lines.push(`summary : ${clip(o.summary, 160)}`);
  lines.push(`plan    : ${clip(o.plan, 200) || "(none)"}`);
  lines.push(`work orders: ${wos.length}`);
  lines.push(
    ...table(
      ["id", "state", "verdict", "role", "session", "last"],
      wos.map((w) => {
        const live = (w.live as Json | undefined) ?? {};
        const tail = arr<string>(live.tail);
        return [
          clip(w.id, 10),
          clip(w.state, 9),
          clip(w.verdict ?? "-", 7),
          clip(w.role, 10),
          w.sessionId ? clip(w.sessionId, 22) : "(none)",
          clip(tail[tail.length - 1] ?? "-", 50),
        ];
      }),
    ),
  );
  return { lines, json: o };
}

function orderLines(o: Json): string[] {
  return [`order  : ${o.id ?? "-"}`, `status : ${o.status ?? "-"}`, `text   : ${clip(o.text, 100)}`];
}

async function cmdNew(text: string, opts: Options): Promise<Output> {
  const o = await call("POST", "/company/fleet/orders", { text, autoApprove: opts.autoApprove });
  return { lines: orderLines(o), json: o };
}

async function cmdApprove(id: string): Promise<Output> {
  const o = await call("POST", `/company/fleet/orders/${encodeURIComponent(id)}/approve`);
  return { lines: orderLines(o), json: o };
}

async function cmdCancel(id: string): Promise<Output> {
  const o = await call("POST", `/company/fleet/orders/${encodeURIComponent(id)}/cancel`);
  return { lines: orderLines(o), json: o };
}

async function cmdWorkers(): Promise<Output> {
  const data = await call("GET", "/company/fleet");
  const workers: Json[] = [];
  for (const o of arr<Json>(data.orders)) {
    for (const w of arr<Json>(o.workOrders)) workers.push({ orderId: o.id, orderStatus: o.status, ...w });
  }
  const lines: string[] = [];
  if (workers.length) {
    lines.push(
      ...table(
        ["order", "wo", "state", "verdict", "role", "session", "last"],
        workers.map((w) => {
          const live = (w.live as Json | undefined) ?? {};
          const tail = arr<string>(live.tail);
          return [
            clip(w.orderId, 16),
            clip(w.id, 10),
            clip(w.state, 9),
            clip(w.verdict ?? "-", 7),
            clip(w.role, 10),
            w.sessionId ? clip(w.sessionId, 22) : "(none)",
            clip(tail[tail.length - 1] ?? "-", 40),
          ];
        }),
      ),
    );
  } else {
    lines.push("(no workers)");
  }
  return { lines, json: { workers } };
}

async function cmdTail(worker: string, opts: Options): Promise<Output> {
  const slash = worker.indexOf("/");
  if (slash < 0) {
    const s = await call("GET", `/company/sessions/${encodeURIComponent(worker)}?tail=1`);
    const tail = arr<string>(s.tail);
    const last = tail.slice(-opts.lines);
    const lines = [`session ${s.id ?? worker} status=${s.status ?? "-"}`];
    for (const l of last) lines.push(`  | ${l}`);
    return { lines, json: { session: s, lines: last } };
  }
  const orderId = worker.slice(0, slash);
  const wid = worker.slice(slash + 1);
  const o = await call("GET", `/company/fleet/orders/${encodeURIComponent(orderId)}`);
  const wo = arr<Json>(o.workOrders).find((w) => String(w.id).toLowerCase() === wid.toLowerCase());
  if (!wo) throw new HttpError(`no work order ${wid} in order ${orderId}`);
  const live = (wo.live as Json | undefined) ?? {};
  const tail = arr<string>(live.tail);
  const last = tail.slice(-opts.lines);
  const lines = [
    `worker ${orderId}/${wo.id} state=${wo.state} session=${wo.sessionId ?? "(none)"} streaming=${Boolean(live.streaming)}`,
  ];
  for (const l of last) lines.push(`  | ${l}`);
  return { lines, json: { worker: `${orderId}/${wo.id}`, workOrder: wo, lines: last } };
}

// ── usage and dispatch ───────────────────────────────────────────────────────

function printUsage(): void {
  console.log(`fleet-cli - command line client for the Laya fleet

usage: npx tsx ops/fleet-cli.ts <command> [options]

commands:
  status                            health, Laya, routing policy, running sessions
  orders [--status X]               list fleet orders (optionally only status X)
  show <id>                         one fleet order and its work orders
  new "<text>" [--auto-approve]     create an order (POST, needs the company token)
  approve <id>                      approve a plan and start the workers (POST)
  cancel <id>                       stop spawning queued work (POST)
  workers                           every work order across all orders
  tail <orderId>/<wid> [--lines N]  last N lines of a worker's live tail

options:
  --json        print the raw JSON payload instead of a table
  --lines N     tail lines (default 15)

base URL: $FLEET_URL (default ${DEFAULT_BASE})
token    : $COMPANY_AUTH_TOKEN, else COMPANY_AUTH_TOKEN in .env (POST only, never printed)`);
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const cmd = opts.positionals[0] ?? "";

  if (opts.help) {
    printUsage();
    return 0;
  }
  if (!cmd) {
    printUsage();
    return 1;
  }

  try {
    let out: Output;
    switch (cmd) {
      case "status":
        out = await cmdStatus();
        break;
      case "orders":
        out = await cmdOrders(opts);
        break;
      case "show": {
        const id = opts.positionals[1] ?? "";
        if (!id) return usageError("show needs an order id");
        out = await cmdShow(id);
        break;
      }
      case "new": {
        const text = (opts.positionals[1] ?? "").trim();
        if (!text) return usageError("new needs order text");
        out = await cmdNew(text, opts);
        break;
      }
      case "approve": {
        const id = opts.positionals[1] ?? "";
        if (!id) return usageError("approve needs an order id");
        out = await cmdApprove(id);
        break;
      }
      case "cancel": {
        const id = opts.positionals[1] ?? "";
        if (!id) return usageError("cancel needs an order id");
        out = await cmdCancel(id);
        break;
      }
      case "workers":
        out = await cmdWorkers();
        break;
      case "tail": {
        const worker = opts.positionals[1] ?? "";
        if (!worker) return usageError("tail needs a worker (orderId/wid) or a session id");
        out = await cmdTail(worker, opts);
        break;
      }
      default:
        printUsage();
        return 1;
    }
    if (opts.json) console.log(JSON.stringify(out.json, null, 2));
    else for (const line of out.lines) console.log(line);
    return 0;
  } catch (e) {
    if (e instanceof HttpError) {
      console.error(e.message);
      return 1;
    }
    console.error(`fleet-cli failed: ${clip((e as Error)?.message ?? e, 200)}`);
    return 1;
  }
}

function usageError(message: string): number {
  console.error(message);
  printUsage();
  return 1;
}

process.exitCode = await main();
export {};
