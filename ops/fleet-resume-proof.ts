/**
 * ops/fleet-resume-proof.ts — RESUME_SPEC §5 proof for the FLEET side (§1).
 *
 * Runs ONLY against throwaway instances: its own PORT, SLACK_BRIDGE=0, a temp
 * COMPANY_ROOT and a temp FLEET_REPO (so a spawn could never touch the repo or the
 * live company/). It never touches :8787 and never uses the live company/.
 *
 * What it proves, with timestamps:
 *   1. kill a test router MID-PLANNING, boot a new one  -> the order is resumed
 *      ("restarted -> resumed at planning") and then plans to completion on its own;
 *   2. kill it mid-planning three times in a row         -> the 4th boot marks the
 *      order `failed` with "planning interrupted 3 times by restarts" (no endless retry);
 *   3. the trace hops carry from:"Router" and what:"restarted -> ..." (RESUME's literal).
 *
 *   npx tsx ops/fleet-resume-proof.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

const PORT = Number(process.env.RESUME_PROOF_PORT ?? 8799);
const TOKEN = "resume-proof-token";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-resume-proof-"));
const company = path.join(tmp, "company");
const repo = path.join(tmp, "repo");
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# throwaway repo for the resume proof\n");
const ordersFile = path.join(company, "fleet", "orders.json");

type Order = {
  id: string;
  status: string;
  planAttempts?: number;
  plannerPid?: number;
  error?: string;
  trace: Array<{ ts: string; from: string; to: string; what: string; detail?: string }>;
};
const logLines: string[] = [];
const readOrders = (): Order[] => {
  try { return JSON.parse(fs.readFileSync(ordersFile, "utf8")) as Order[]; } catch { return []; }
};
const getOrder = (id: string): Order | undefined => readOrders().find((o) => o.id === id);

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startRouter(): Promise<{ child: ChildProcess; pid: number; boot: string[] }> {
  const started = new Date().toISOString();
  const child = spawn("npx", ["tsx", "src/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      SLACK_BRIDGE: "0",
      COMPANY_ROOT: company,
      FLEET_REPO: repo,
      COMPANY_AUTH_TOKEN: TOKEN,
      HOST: "127.0.0.1",
      MAX_PARALLEL_SESSIONS: "30",
      MIN_FREE_RAM_MB: "512",
      FLEET_WATCH_INTERVAL_MS: "2000",
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });
  const boot: string[] = [];
  child.stdout?.on("data", (d) => { const s = d.toString(); logLines.push(s); boot.push(s); });
  child.stderr?.on("data", (d) => { const s = d.toString(); logLines.push(s); boot.push(s); });
  const pid = child.pid ?? 0;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (boot.join("").includes("router on ")) return { child, pid, boot };
    if (child.exitCode !== null) throw new Error(`test router exited early (code ${child.exitCode}): ${boot.join("").slice(-300)}`);
    await sleep(500);
  }
  throw new Error(`test router did not boot within 60s on :${PORT}`);
}

function killRouter(child: ChildProcess, pid: number, label: string): void {
  console.log(`   [kill] ${label}: killing the test router pid ${pid} (and its tree)`);
  spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  try { child.kill("SIGKILL"); } catch { /* already gone */ }
}

async function postOrder(text: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${PORT}/company/fleet/orders`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-company-token": TOKEN },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(15000),
  });
  const j = (await res.json()) as { id?: string; status?: string; error?: string };
  if (!res.ok || !j.id) throw new Error(`POST /company/fleet/orders -> ${res.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j.id;
}

function restartHops(id: string): Array<{ what: string; to: string }> {
  return (getOrder(id)?.trace ?? []).filter((h) => h.from === "Router" && /^restarted/i.test(h.what)).map((h) => ({ what: h.what, to: h.to }));
}

const ORDER_TEXT = "A one-line plan is enough: write exactly one line of text to the work order's report. Keep it trivial.";
console.log(`[proof] throwaway COMPANY_ROOT=${company}`);
console.log(`[proof] throwaway FLEET_REPO=${repo}`);
console.log(`[proof] test PORT=${PORT} (never :8787), SLACK_BRIDGE=0`);

// ── 1. kill mid-planning, restart, expect the order to plan itself to the end ──
console.log("\n── case 1: one kill mid-planning, then the order finishes on its own");
let router = await startRouter();
console.log(`   [boot] instance A pid=${router.pid} at ${new Date().toISOString()}`);
const idA = await postOrder(ORDER_TEXT);
await sleep(6000);
const midA = getOrder(idA);
check("order is mid-planning with a plannerPid and no plan yet", midA?.status === "planning" && !!midA?.plannerPid && !("plan" in (midA as object) && (midA as { plan?: string }).plan), `status=${midA?.status} plannerPid=${midA?.plannerPid} attempts=${midA?.planAttempts}`);
killRouter(router.child, router.pid, "mid-planning A");
await sleep(2000);

router = await startRouter();
console.log(`   [boot] instance B pid=${router.pid} at ${new Date().toISOString()}`);
const bootLog = router.boot.join("");
check("[fleet] restart resume was logged at boot", bootLog.includes("[fleet] restart resume:"), (bootLog.split("\n").find((l) => l.includes("[fleet] restart resume:")) ?? "(no line)").trim());
const deadline = Date.now() + 180000;
while (Date.now() < deadline && getOrder(idA)?.status === "planning") await sleep(3000);
const doneA = getOrder(idA);
check("the resumed order planned itself to a finish (no human)", doneA?.status === "awaiting_approval" || doneA?.status === "running" || doneA?.status === "done", `status=${doneA?.status} attempts=${doneA?.planAttempts}`);
const hopsA = restartHops(idA);
check("a Router restart hop with RESUMEs literal was appended", hopsA.some((h) => h.what === "restarted -> resumed at planning"), JSON.stringify(hopsA));
console.log(`   [trace] ${(getOrder(idA)?.trace ?? []).map((h) => `${h.from}->${h.to}[${h.what}]`).join(" | ").slice(0, 400)}`);
killRouter(router.child, router.pid, "after case 1");
await sleep(2000);

// ── 2. three kills in a row on a second order -> failed, no endless retry ──
console.log("\n── case 2: killed mid-planning three times -> the order fails with the reason");
router = await startRouter();
console.log(`   [boot] instance C pid=${router.pid}`);
const idB = await postOrder(ORDER_TEXT);
await sleep(6000);
check("order 2 is mid-planning", getOrder(idB)?.status === "planning", `status=${getOrder(idB)?.status} attempts=${getOrder(idB)?.planAttempts}`);
killRouter(router.child, router.pid, "kill 1/3");
await sleep(2000);

for (let i = 1; i <= 2; i++) {
  router = await startRouter();
  console.log(`   [boot] instance ${["D", "E"][i - 1]} pid=${router.pid} (after kill ${i})`);
  await sleep(6000);
  check(`order 2 was re-planned after kill ${i} (attempts grew)`, (getOrder(idB)?.planAttempts ?? 0) >= i + 1, `attempts=${getOrder(idB)?.planAttempts} status=${getOrder(idB)?.status}`);
  killRouter(router.child, router.pid, `kill ${i + 1}/3`);
  await sleep(2000);
}

router = await startRouter();
console.log(`   [boot] instance F pid=${router.pid} (4th boot: should give up)`);
await sleep(6000);
const failedB = getOrder(idB);
check("after 3 interrupted attempts the order is failed, not retried again", failedB?.status === "failed" && /interrupted .* by restarts/i.test(failedB?.error ?? ""), `status=${failedB?.status} error=${failedB?.error}`);
const hopsB = restartHops(idB);
check("the 3-strike failure is also a Router restart hop", hopsB.some((h) => h.what === "restarted -> planning gave up"), JSON.stringify(hopsB.map((h) => h.what)));
console.log(`   [trace] ${(failedB?.trace ?? []).map((h) => `${h.from}->${h.to}[${h.what}]`).join(" | ").slice(0, 500)}`);
killRouter(router.child, router.pid, "final cleanup");

check("no router of mine is left on the test port", spawnSync("powershell", ["-NoProfile", "-Command", `(netstat -ano | Select-String ':${PORT}' | Select-String LISTENING | Measure-Object).Count`], { encoding: "utf8" }).stdout.trim() === "0");

console.log("");
console.log(`[proof] ${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
console.log(`[proof] throwaway dir kept for inspection: ${tmp}`);
process.exit(failures === 0 ? 0 : 1);
