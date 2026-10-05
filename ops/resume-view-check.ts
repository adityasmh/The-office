// RESUME_SPEC §4 rendering check (owner: RESUME).
//
// The spec says the restart hop must be rendered DISTINCTLY (restart icon + muted
// colour) on the Flow and Fleet pages, "so the CEO sees it happened". The drill and
// ops/smoke-flow.ts prove the DATA (the Router hop is in task.trace / order.trace);
// this script proves the PAGES, in a real browser, against an isolated instance.
//
// It drives Chrome over the DevTools protocol (Node's built-in WebSocket) instead of
// `--dump-dom`, because --dump-dom carries neither the view's injected <style> nor any
// computed style - and "muted colour" is exactly a computed-style claim. Every result
// below is read out of the live DOM in the browser.
//
//   * temp COMPANY_ROOT (fresh: one project + one task whose trace carries a Router
//     hop, one fleet order whose trace carries one). No live data is read or written.
//   * `node --import tsx src/server.ts` on a free port, MOCK_MODE=1, SLACK_BRIDGE=0.
//   * headless Chrome + CDP: navigate to `#/flow/<taskId>` and `#/fleet/<orderId>`,
//     then evaluate the assertions in the page.
//
// Usage: npx tsx ops/resume-view-check.ts [--keep] [--json]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const args = process.argv.slice(2);
const KEEP = args.includes("--keep");
const AS_JSON = args.includes("--json");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

type Step = { n: number; name: string; ok: boolean; detail: string };
const steps: Step[] = [];
function record(n: number, name: string, ok: boolean, detail: string) {
  steps.push({ n, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} [${n}] ${name}`);
  console.log(`      ${detail}`);
}

let child: ChildProcess | undefined;
let chrome: ChildProcess | undefined;
let tempRoot = "";
let port = 0;
let cdpPort = 0;
let token = "";
const base = () => `http://127.0.0.1:${port}`;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

async function req(method: string, urlPath: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base() + urlPath, {
    method,
    headers: { "content-type": "application/json", "X-Company-Token": token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}

/* ------------------------------------------------------------------ CDP */
type CdpTarget = { id: string; webSocketDebuggerUrl: string };

async function cdpTargets(): Promise<CdpTarget[]> {
  const r = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
  return (await r.json()) as CdpTarget[];
}

/** Evaluate `expr` in a fresh tab loaded at `url`, and return its JSON value. */
async function evalInPage<T>(url: string, expr: string, readyExpr: string, timeoutMs = 60000): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  const target = (await res.json()) as CdpTarget;
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  ws.addEventListener("message", (m: any) => {
    const msg = JSON.parse(String(m.data));
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)!(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method: string, params: unknown = {}) =>
    new Promise<any>((resolve) => {
      const myId = ++id;
      pending.set(myId, resolve);
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  try {
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", (e: any) => reject(new Error(`ws error: ${String(e?.message ?? e)}`)));
    });
    await send("Runtime.enable");
    const deadline = Date.now() + timeoutMs;
    let ready = false;
    while (Date.now() < deadline) {
      const r = await send("Runtime.evaluate", { expression: readyExpr, returnByValue: true });
      if (r?.result?.result?.value) {
        ready = true;
        break;
      }
      await sleep(300);
    }
    if (!ready) throw new Error(`page never became ready: ${expr.slice(0, 60)}`);
    const out = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
    if (out?.result?.exceptionDetails) throw new Error(`page threw: ${JSON.stringify(out.result.exceptionDetails).slice(0, 300)}`);
    return out?.result?.result?.value as T;
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    try {
      await fetch(`http://127.0.0.1:${cdpPort}/json/close/${target.id}`);
    } catch {
      /* ignore */
    }
  }
}

/** What the Flow page shows for the restart hop, straight from the rendered DOM. */
const FLOW_EXPR = `(() => {
  const hops = Array.from(document.querySelectorAll(".flow-hop"));
  const restarts = hops.filter((h) => h.classList.contains("is-restart"));
  const r = restarts[0];
  const ordinary = hops.find((h) => !h.classList.contains("is-restart"));
  const color = (el) => (el ? getComputedStyle(el).color : null);
  // The dashboard's theme tokens live in public/v2/style.css; resolve --dim by asking
  // the browser for the colour an element using it actually gets.
  const probe = document.createElement("span");
  probe.style.color = "var(--dim)";
  document.body.appendChild(probe);
  const dimResolved = getComputedStyle(probe).color;
  probe.remove();
  const sheetCss = Array.from(document.styleSheets)
    .map((s) => {
      try {
        return Array.from(s.cssRules).map((r2) => r2.cssText).join("\\n");
      } catch (e) {
        return "(unreadable: " + s.href + ")";
      }
    })
    .join("\\n");
  return {
    hopCount: hops.length,
    restartHops: restarts.length,
    restartFrom: r ? (r.querySelector(".who") || {}).textContent : null,
    hasIcon: !!document.querySelector(".flow-hop.is-restart .flow-restart-icon"),
    iconGlyph: (document.querySelector(".flow-hop.is-restart .flow-restart-icon") || {}).textContent || null,
    note: (document.querySelector(".flow-hop.is-restart .flow-restart-note") || {}).textContent || null,
    what: r ? (r.querySelector(".small.muted") || {}).textContent : null,
    restartWhoColor: color(r && r.querySelector(".who")),
    ordinaryWhoColor: color(ordinary && ordinary.querySelector(".who")),
    dimResolved,
    restartCardOpacity: r ? getComputedStyle(r.querySelector(".flow-hop-card")).opacity : null,
    ordinaryCardOpacity: ordinary ? getComputedStyle(ordinary.querySelector(".flow-hop-card")).opacity : null,
    noOrdinaryHopIsRestart: !ordinary || !ordinary.classList.contains("is-restart"),
    restartRuleInSheets: sheetCss.indexOf(".flow-hop.is-restart") >= 0,
    sheetCount: document.styleSheets.length
  };
})()`;

/** What the Fleet page shows for an order whose LAST trace hop is the restart hop. */
const FLEET_EXPR = `(() => {
  const badge = document.querySelector(".fleet-restart");
  const line = document.querySelector("#fleet-trace-last");
  const color = (el) => (el ? getComputedStyle(el).color : null);
  const probe = document.createElement("span");
  probe.style.color = "var(--dim)";
  document.body.appendChild(probe);
  const dimResolved = getComputedStyle(probe).color;
  probe.remove();
  const sheetCss = Array.from(document.styleSheets)
    .map((s) => {
      try {
        return Array.from(s.cssRules).map((r2) => r2.cssText).join("\\n");
      } catch (e) {
        return "(unreadable: " + s.href + ")";
      }
    })
    .join("\\n");
  return {
    hasBadge: !!badge,
    badgeText: badge ? badge.textContent : null,
    lineText: line ? line.textContent : null,
    badgeColor: color(badge),
    dimResolved,
    lineIsPlainText: !!line && !line.querySelector(".fleet-restart"),
    badgeBorderWidth: badge ? getComputedStyle(badge).borderTopWidth : null,
    badgeRadius: badge ? getComputedStyle(badge).borderTopLeftRadius : null,
    restartRuleInSheets: sheetCss.indexOf(".fleet-restart") >= 0,
    sheetCount: document.styleSheets.length
  };
})()`;

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error(`no Chrome at ${CHROME}`);
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jcode-resume-view-"));
  const companyRoot = path.join(tempRoot, "company");
  fs.mkdirSync(path.join(companyRoot, "reports"), { recursive: true });
  process.env.COMPANY_ROOT = companyRoot;

  const org = await import("../src/company/org.js");
  const { project } = org.createProject({
    companyName: "Resume View Co",
    departmentName: "Engineering",
    projectName: "Restart Rendering",
    description: "isolated render check (RESUME_SPEC section 4)",
    coderCount: 1,
  });
  const pid = project.id;

  const restartHop = {
    ts: new Date().toISOString(),
    from: "Router",
    to: "kimi-k2.7-code (coder-1)",
    what: "restarted → resumed at coding",
    detail: 'the router restarted while this task was in "coding"; the pipeline resumed from the last finished step',
  };
  const task = {
    id: "tviewcheck1",
    projectId: pid,
    rawRequest: "Render check: the restart hop must be distinct.",
    // NOT an in-motion status: an in-motion fixture would be auto-resumed by the
    // instance's own boot queue (RESUME_SPEC §2) and the extra real hops it appends
    // would make "exactly one restart hop" untestable. The live-page proof of a real
    // resumed task is separate (logs/resume-view-live-flow.dom.html).
    status: "merged",
    gates: { intake: true, code: true, merge: true },
    createdAt: new Date(Date.now() - 60000).toISOString(),
    updatedAt: new Date().toISOString(),
    loopCount: 0,
    trace: [
      { ts: new Date(Date.now() - 50000).toISOString(), from: "Claude (manager)", to: "Claude (manager)", what: "plan", detail: "one coder" },
      restartHop,
    ],
  };
  fs.mkdirSync(path.join(companyRoot, "projects", pid), { recursive: true });
  fs.writeFileSync(path.join(companyRoot, "projects", pid, "tasks.json"), JSON.stringify([task], null, 2));

  // Two orders, both terminal (so bonehound's fleet watcher has nothing to advance):
  // one whose LAST hop is the restart hop, one whose last hop is ordinary traffic. The
  // fleet detail line replaces itself with a restart badge in the first case and must
  // NOT do so in the second - that is the "renders it distinctly" comparison.
  const orderWith = (id: string, text: string, lastIsRestart: boolean) => ({
    id,
    text,
    createdAt: new Date(Date.now() - 60000).toISOString(),
    updatedAt: new Date().toISOString(),
    status: "done",
    plan: "One work order, frozen for the render check.",
    workOrders: [{ id: "wo1", title: "Render the restart hop", role: "UI", owns: ["public/v2/views/fleet.js"], brief: "frozen", done: ["visible"], state: "reviewed", verdict: "PASS", review: "frozen", attempts: 1 }],
    trace: [
      { ts: new Date(Date.now() - 55000).toISOString(), from: "CEO", to: "Claude (manager)", what: "order", detail: "check" },
      lastIsRestart
        ? restartHop
        : { ts: new Date(Date.now() - 40000).toISOString(), from: "Claude (manager)", to: "CEO", what: "report", detail: "done" },
    ],
  });
  const order = orderWith("foviewcheck1", "Render check: the fleet trace must show the restart hop.", true);
  const orderPlain = orderWith("foviewcheck2", "Render check: an ordinary order must NOT show a restart badge.", false);
  fs.mkdirSync(path.join(companyRoot, "fleet"), { recursive: true });
  fs.writeFileSync(path.join(companyRoot, "fleet", "orders.json"), JSON.stringify([order, orderPlain], null, 2));

  port = await freePort();
  cdpPort = await freePort();
  token = crypto.randomBytes(16).toString("hex");
  log(`isolated instance: ${base()} (project ${pid}, order ${order.id})`);
  child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      COMPANY_ROOT: companyRoot,
      COMPANY_AUTH_TOKEN: token,
      MOCK_MODE: "1",
      SLACK_BRIDGE: "0",
      SLACK_SOCKET_MODE: "0",
      SLACK_BOT_TOKEN: "",
      SLACK_APP_TOKEN: "",
      SLACK_CHANNEL_ID: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout?.on("data", (d) => (out += String(d)));
  child.stderr?.on("data", (d) => (out += String(d)));

  let up = false;
  for (let i = 0; i < 240; i++) {
    try {
      const r = await req("GET", "/health");
      if (r.status === 200 && r.json?.ok) {
        up = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  record(1, `isolated instance is up on :${port} with the fixtures`, up, up ? "GET /health ok=true mock=true" : `no /health within 60s\n${out.slice(-400)}`);
  if (!up) throw new Error("instance did not come up");

  chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${path.join(tempRoot, "chrome")}`,
      `--remote-debugging-port=${cdpPort}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  let cdpUp = false;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
      if (r.ok) {
        cdpUp = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  record(2, `headless Chrome is reachable over CDP on :${cdpPort}`, cdpUp, cdpUp ? "GET /json/version ok" : "no CDP endpoint");
  if (!cdpUp) throw new Error("chrome did not expose CDP");

  const flowUrl = `${base()}/v2/#/flow/${task.id}`;
  const flow = await evalInPage<any>(flowUrl, FLOW_EXPR, `!!document.querySelector(".flow-hop")`);
  log(`Flow DOM: ${JSON.stringify(flow)}`);
  const flowOk =
    flow.hopCount === 2 &&
    flow.restartHops === 1 &&
    flow.noOrdinaryHopIsRestart &&
    flow.restartFrom === "↻ Router" &&
    flow.hasIcon &&
    flow.iconGlyph === "↻" &&
    /resumed by the router after a restart/.test(String(flow.note)) &&
    /restarted/.test(String(flow.what)) &&
    flow.restartCardOpacity === "0.92" &&
    flow.ordinaryCardOpacity === "1" &&
    flow.restartWhoColor === flow.dimResolved &&
    flow.restartRuleInSheets;
  record(3, "Flow page: 1 of 2 hops is the restart hop; ↻ icon, restart note, muted colour (--dim) and muted card vs the ordinary hop", flowOk,
    `hops=${flow.hopCount} restartHops=${flow.restartHops} ordinaryIsRestart=${!flow.noOrdinaryHopIsRestart} from="${flow.restartFrom}" icon="${flow.iconGlyph}"` +
      ` note="${String(flow.note).trim()}" what="${String(flow.what).trim()}"` +
      ` | card opacity: restart=${flow.restartCardOpacity} vs ordinary=${flow.ordinaryCardOpacity}` +
      ` | restart .who colour=${flow.restartWhoColor} vs resolved var(--dim)=${flow.dimResolved}` +
      ` | rule in styleSheets (${flow.sheetCount} sheet(s)): ${flow.restartRuleInSheets}`);

  const fleetUrl = `${base()}/v2/#/fleet/${order.id}`;
  const fleet = await evalInPage<any>(fleetUrl, FLEET_EXPR, `!!document.querySelector("#fleet-trace-last")`);
  // The same element on an order whose last hop is ordinary traffic: no badge.
  const plainUrl = `${base()}/v2/#/fleet/${orderPlain.id}`;
  const plain = await evalInPage<any>(plainUrl, FLEET_EXPR, `!!document.querySelector("#fleet-trace-last") && !document.querySelector("#fleet-trace-last").textContent.includes("no trace")`);
  log(`Fleet DOM (restart order): ${JSON.stringify(fleet)}`);
  log(`Fleet DOM (ordinary order): ${JSON.stringify(plain)}`);
  const fleetOk =
    fleet.hasBadge &&
    /↻ restarted/.test(String(fleet.badgeText)) &&
    /resumed at coding/.test(String(fleet.badgeText)) &&
    parseFloat(String(fleet.badgeBorderWidth)) > 0 &&
    /^\d+px$/.test(String(fleet.badgeRadius)) &&
    String(fleet.badgeColor) === fleet.dimResolved &&
    fleet.restartRuleInSheets &&
    plain.hasBadge === false &&
    plain.lineIsPlainText &&
    /last hop/.test(String(plain.lineText));
  record(4, "Fleet page: the restart order shows the muted «↻ restarted» badge; an ordinary order shows plain text and no badge", fleetOk,
    `restart order: badge="${fleet.badgeText}" colour=${fleet.badgeColor} (var(--dim)=${fleet.dimResolved}) border=${fleet.badgeBorderWidth} radius=${fleet.badgeRadius}` +
      ` | ordinary order: badge=${plain.hasBadge} plainText=${plain.lineIsPlainText} line="${String(plain.lineText).slice(0, 70)}"` +
      ` | rule in styleSheets (${fleet.sheetCount} sheet(s)): ${fleet.restartRuleInSheets}`);

  fs.writeFileSync(
    path.join(REPO_ROOT, "logs", "resume-view-check.json"),
    JSON.stringify({ at: new Date().toISOString(), flowUrl, fleetUrl, plainUrl, flow, fleet, plain, steps }, null, 2),
  );
}

function cleanup() {
  for (const p of [chrome, child]) {
    try {
      p?.kill();
    } catch {
      /* ignore */
    }
  }
  if (tempRoot && tempRoot.startsWith(os.tmpdir()) && !KEEP) {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  } else if (KEEP) {
    console.log(`# kept temp root: ${tempRoot}`);
  }
}

main()
  .catch((e) => {
    console.log(`FATAL ${String((e as Error)?.stack ?? e).slice(0, 700)}`);
    steps.push({ n: 0, name: "fatal", ok: false, detail: String(e).slice(0, 300) });
  })
  .finally(async () => {
    cleanup();
    const failed = steps.filter((s) => !s.ok);
    if (AS_JSON) console.log(`VIEW_JSON ${JSON.stringify({ steps })}`);
    console.log("");
    console.log(`VIEW CHECK ${steps.length - failed.length}/${steps.length} passed; ${failed.length} failed`);
    process.exit(failed.length ? 1 : 0);
  });
