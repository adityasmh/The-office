/**
 * ops/needs-you-accept.ts - live HTTP acceptance test for the needs-you resolver.
 *
 * Run with: npx tsx ops/needs-you-accept.ts [--base http://127.0.0.1:8787]
 *
 * It calls the real API, resolves today's needs-you items, and verifies the
 * expected outcomes. It NEVER prints the Kimi key.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { TOKEN_HEADER } from "../src/company/authguard.js";

const argv = process.argv.slice(2);
function flag(name: string, def = ""): string {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
}

const DEFAULT_PORT = process.env.PORT ?? "8787";
const base = (flag("--base", `http://127.0.0.1:${DEFAULT_PORT}`) || `http://127.0.0.1:${DEFAULT_PORT}`).replace(/\/+$/, "");
const token = (process.env.COMPANY_AUTH_TOKEN ?? "").trim();

const TIMEOUT_MS = 10000;
const POLL_MS = 1500;
const MAX_POLLS = 40;

const clip = (s: unknown, n = 80): string => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

type BriefingItem = {
  id?: string;
  kind?: string;
  text?: string;
  question?: string;
  input?: { name?: string };
  actions?: Array<{ id: string; effect: string; params?: Record<string, string> }>;
};

async function http(method: string, route: string, body?: unknown): Promise<{ status: number; text: string; json: unknown }> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) headers[TOKEN_HEADER] = token;
  let init: RequestInit = { method, headers, signal: AbortSignal.timeout(TIMEOUT_MS) };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init = { ...init, body: JSON.stringify(body) };
  }
  const res = await fetch(`${base}${route}`, init);
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json };
}

async function getNeedsYou(): Promise<BriefingItem[]> {
  const res = await http("GET", "/api/needs-you");
  if (res.status !== 200) throw new Error(`GET /api/needs-you returned ${res.status}: ${clip(res.text, 200)}`);
  return ((res.json as { needsYou?: BriefingItem[] })?.needsYou ?? []) as BriefingItem[];
}

async function resolveItem(itemId: string, actionId: string, input?: Record<string, string>): Promise<{ ok: boolean; message?: string }> {
  const res = await http("POST", `/api/needs-you/${encodeURIComponent(itemId)}/resolve`, { actionId, input });
  if (res.status === 404) return { ok: false, message: ((res.json as any)?.message as string) ?? "not found" };
  if (res.status !== 200) throw new Error(`POST resolve returned ${res.status}: ${clip(res.text, 200)}`);
  const j = res.json as { ok: boolean; message?: string };
  return j;
}

async function getProject(projectId: string): Promise<{ rootDir?: string }> {
  const res = await http("GET", `/company/projects/${encodeURIComponent(projectId)}`);
  if (res.status !== 200) throw new Error(`GET project returned ${res.status}`);
  return (res.json ?? {}) as { rootDir?: string };
}

async function getTask(projectId: string, taskId: string): Promise<{ status?: string }> {
  const res = await http("GET", `/company/projects/${encodeURIComponent(projectId)}/tasks`);
  if (res.status !== 200) throw new Error(`GET tasks returned ${res.status}`);
  const tasks = (res.json ?? []) as Array<{ id: string; status?: string }>;
  return tasks.find((t) => t.id === taskId) ?? {};
}

async function listFleetOrders(): Promise<Array<{ id: string; status: string; text: string }>> {
  const res = await http("GET", "/company/fleet");
  if (res.status !== 200) throw new Error(`GET /company/fleet returned ${res.status}`);
  return ((res.json as { orders?: Array<{ id: string; status: string; text: string }> })?.orders ?? []) as Array<{
    id: string;
    status: string;
    text: string;
  }>;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollTaskStatus(projectId: string, taskId: string, predicate: (status: string) => boolean): Promise<string> {
  for (let i = 0; i < MAX_POLLS; i++) {
    const t = await getTask(projectId, taskId);
    if (t.status && predicate(t.status)) return t.status;
    await sleep(POLL_MS);
  }
  throw new Error(`task ${taskId} did not reach expected status in time`);
}

async function pollFileExists(file: string): Promise<void> {
  for (let i = 0; i < MAX_POLLS; i++) {
    if (fs.existsSync(file)) return;
    await sleep(POLL_MS);
  }
  throw new Error(`file ${file} did not appear in time`);
}

async function main(): Promise<number> {
  console.log(`needs-you accept against ${base}`);
  if (!token) console.log("warning: COMPANY_AUTH_TOKEN is empty; loopback reads will work but mutations may 401");

  const initial = await getNeedsYou();
  console.log(`initial needs-you items: ${initial.length}`);
  for (const item of initial) console.log(`  - ${item.id}: ${clip(item.text)}`);

  const fleetBefore = await listFleetOrders();
  console.log(`fleet orders before: ${fleetBefore.length}`);

  let resolvedCount = 0;
  let blocked = 0;
  const results: Array<{ itemId: string; action: string; ok: boolean; detail: string }> = [];

  for (const item of initial) {
    if (!item.id || !item.actions?.length) continue;
    const ids = item.actions.map((a) => a.id);

    // QA README plan at pending_merge: choice between alternatives.
    if (item.kind === "choice" && ids.includes("approve") && ids.includes("approve_alt")) {
      const action = item.actions.find((a) => a.id === "approve")!;
      const params = action.params ?? {};
      console.log(`\n[qa-readme] approving ${item.id} (gate=${params.gate ?? "merge"})`);
      const r = await resolveItem(item.id, "approve");
      if (!r.ok) throw new Error(`qa-readme resolve failed: ${r.message}`);
      const status = await pollTaskStatus(params.projectId!, params.taskId!, (s) => s !== "pending_merge");
      console.log(`  task ${params.taskId} status: ${status}`);
      results.push({ itemId: item.id, action: "approve", ok: true, detail: `task status ${status}` });
      resolvedCount++;
      continue;
    }

    // hello.txt intake approval.
    if (item.kind === "approve" && ids.includes("approve") && ids.includes("drop") && clip(item.text).toLowerCase().includes("hello")) {
      const action = item.actions.find((a) => a.id === "approve")!;
      const params = action.params ?? {};
      console.log(`\n[hello] approving intake ${item.id}`);
      const r = await resolveItem(item.id, "approve");
      if (!r.ok) throw new Error(`hello resolve failed: ${r.message}`);
      const project = await getProject(params.projectId!);
      const helloPath = path.join(project.rootDir!, "hello.txt");
      await pollFileExists(helloPath);
      console.log(`  hello.txt exists at ${helloPath}`);
      results.push({ itemId: item.id, action: "approve", ok: true, detail: "hello.txt exists" });
      resolvedCount++;
      continue;
    }

    // Kimi key provision.
    if (item.kind === "provide" && item.input?.name === "OPENCODE_API_KEY") {
      const key = process.env.NY_TEST_KIMI_KEY;
      if (!key) {
        console.log(`\n[kimi-key] BLOCKED: NY_TEST_KIMI_KEY is not set`);
        console.log(`  To unblock, run this command in a shell with the key and re-run the accept test:`);
        console.log(`    $env:NY_TEST_KIMI_KEY="<key>"; npx tsx ops/needs-you-accept.ts`);
        blocked++;
        results.push({ itemId: item.id, action: "save_key_retry", ok: false, detail: "NY_TEST_KIMI_KEY missing" });
        continue;
      }
      console.log(`\n[kimi-key] saving key and retrying ${item.id}`);
      const r = await resolveItem(item.id, "save_key_retry", { OPENCODE_API_KEY: key });
      if (!r.ok) throw new Error(`kimi-key resolve failed: ${r.message}`);
      await sleep(2000);
      const fleetAfter = await listFleetOrders();
      const newOrder = fleetAfter.find((o) => !fleetBefore.some((b) => b.id === o.id));
      if (!newOrder) throw new Error("kimi-key retry did not create a new fleet order");
      console.log(`  new fleet order: ${newOrder.id} (${newOrder.status})`);
      results.push({ itemId: item.id, action: "save_key_retry", ok: true, detail: `new order ${newOrder.id}` });
      resolvedCount++;
      continue;
    }

    // Claude-limit external item.
    if (item.kind === "external" && ids.includes("use_kimi") && ids.includes("open_limit_page")) {
      console.log(`\n[claude-limit] checking actions on ${item.id}: ${ids.join(", ")}`);
      const expected = ["open_limit_page", "raised_retry", "use_kimi"].sort();
      const actual = ids.slice().sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`claude-limit actions mismatch: expected ${expected.join(",")}, got ${actual.join(",")}`);
      }
      console.log(`  running use_kimi`);
      const r = await resolveItem(item.id, "use_kimi");
      if (!r.ok) throw new Error(`claude-limit resolve failed: ${r.message}`);
      await sleep(2000);
      const fleetAfter = await listFleetOrders();
      const newOrder = fleetAfter.find((o) => !fleetBefore.some((b) => b.id === o.id));
      if (!newOrder) throw new Error("use_kimi did not create a new fleet order");
      console.log(`  new fleet order: ${newOrder.id} (${newOrder.status})`);
      results.push({ itemId: item.id, action: "use_kimi", ok: true, detail: `new order ${newOrder.id}` });
      resolvedCount++;
      continue;
    }

    // Generic retry-or-drop (failed fleet order or failed task).
    if (item.kind === "choice" && ids.includes("retry") && ids.includes("drop")) {
      const action = item.actions.find((a) => a.id === "retry")!;
      const effect = action.effect;
      if (effect === "retry_order" || effect === "retry_task") {
        console.log(`\n[retry-or-drop] retrying ${item.id} (effect=${effect})`);
        const r = await resolveItem(item.id, "retry");
        if (!r.ok) throw new Error(`retry-or-drop resolve failed: ${r.message}`);

        if (effect === "retry_task") {
          const params = action.params ?? {};
          const status = await pollTaskStatus(params.projectId!, params.taskId!, (s) => s !== "failed" && s !== "closed_as_dropped");
          console.log(`  task ${params.taskId} status: ${status}`);
          results.push({ itemId: item.id, action: "retry", ok: true, detail: `task status ${status}` });
        } else {
          await sleep(2000);
          const fleetAfter = await listFleetOrders();
          const newOrder = fleetAfter.find((o) => !fleetBefore.some((b) => b.id === o.id));
          if (!newOrder) throw new Error("retry did not create a new fleet order");
          console.log(`  new fleet order: ${newOrder.id} (${newOrder.status})`);
          results.push({ itemId: item.id, action: "retry", ok: true, detail: `new order ${newOrder.id}` });
        }
        resolvedCount++;
        continue;
      }
    }

    console.log(`\n[skip] unhandled item ${item.id} (${item.kind}): ${ids.join(", ")}`);
  }

  console.log("\nwaiting for briefing to refresh...");
  await sleep(3000);

  const final = await getNeedsYou();
  console.log(`\nfinal needs-you items: ${final.length}`);
  for (const item of final) console.log(`  - ${item.id}: ${clip(item.text)}`);

  const companyRoot = path.join(process.cwd(), "company");
  const decisionsPath = path.join(companyRoot, "reports", "needs-you-decisions.json");
  let decisionCount = 0;
  if (fs.existsSync(decisionsPath)) {
    const decisions = JSON.parse(fs.readFileSync(decisionsPath, "utf8")) as Array<Record<string, unknown>>;
    decisionCount = decisions.length;
    console.log(`\ndecision log entries: ${decisionCount}`);
  }

  console.log("\n--- results ---");
  for (const r of results) console.log(`${r.ok ? "OK" : "FAIL"} ${r.itemId} ${r.action} -> ${r.detail}`);

  const expectedResolved = initial.length - blocked;
  if (resolvedCount !== expectedResolved) {
    console.error(`ERROR: resolved ${resolvedCount}, expected ${expectedResolved} (blocked ${blocked})`);
    return 1;
  }
  if (final.length > blocked) {
    console.error(`ERROR: ${final.length} item(s) still need you (excluding blocked)`);
    return 1;
  }
  if (decisionCount < resolvedCount) {
    console.error(`ERROR: decision log has ${decisionCount} entries but ${resolvedCount} items were resolved`);
    return 1;
  }

  console.log("\nALL NEEDS-YOU ACCEPTANCE ITEMS PROCESSED");
  return 0;
}

process.exitCode = await main();
