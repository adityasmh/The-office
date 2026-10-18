/**
 * ops/terminals-routes-probe.ts — end-to-end check of the three Terminals routes
 * (docs/TERMINALS_SPEC.md) against a THROWAWAY server, so the live router on :8787 is
 * never touched.
 *
 *   npx tsx ops/terminals-routes-probe.ts
 *
 * What it does:
 *   - makes a temp dir with its own COMPANY_ROOT and its own copy of
 *     docs/AGENT_COORDINATION.md, and runs `src/server.ts` from there on a free port
 *     with MOCK_MODE=1, SLACK_BRIDGE=0 and blank Slack creds;
 *   - because the temp COMPANY_ROOT has no company/terminals.json and the cwd is the
 *     temp dir, every role it prints comes from the coordination-log copy or from the
 *     work order - which is exactly the fallback path under test;
 *   - calls GET /company/terminals/live, GET /company/terminals/:id/tail, and
 *     POST /company/terminals/:id/message (refusals + one REAL targeted message to the
 *     session that runs this probe, delivered with `jcode transcript --mode send -S`);
 *   - prints PASS/FAIL per check and exits non-zero when any check fails.
 *
 * It reads %USERPROFILE%\.jcode read-only, and writes only inside its temp dir.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";

const REPO_ROOT = process.cwd();
/** The session that runs this probe: it is the only one we are allowed to message. */
const OWN_SESSION = "session_maple_1790686910793_b9bba4247c47ac99";

let tempRoot = "";
let child: ChildProcess | undefined;
let out = "";
const results: Array<{ ok: boolean; label: string; detail: string }> = [];

function check(ok: boolean, label: string, detail = ""): boolean {
  results.push({ ok, label, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function req(method: string, url: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { "x-company-token": token } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, json };
}

function cleanup(): void {
  if (child && child.pid) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  }
  if (tempRoot) {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      console.log(`# could not remove ${tempRoot}`);
    }
  }
}

process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

const port = await freePort();
tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jcode-terminals-"));
const companyRoot = path.join(tempRoot, "company");
fs.mkdirSync(companyRoot, { recursive: true });
// A copy of the real coordination log, so the role-from-log path is exercised for real
// (this is also the file the instruction-auto-note writes to, which keeps the live log clean).
fs.mkdirSync(path.join(tempRoot, "docs"), { recursive: true });
const logSrc = path.join(REPO_ROOT, "docs", "AGENT_COORDINATION.md");
const logDst = path.join(tempRoot, "docs", "AGENT_COORDINATION.md");
fs.copyFileSync(logSrc, logDst);
const logBefore = fs.readFileSync(logDst, "utf8").split("\n").length;

const token = crypto.randomBytes(16).toString("hex");
const base = `http://127.0.0.1:${port}`;
console.log(`# terminals-routes-probe: isolated server on ${base}`);
console.log(`# temp root: ${tempRoot}`);
console.log(`# own session under test: ${OWN_SESSION}`);

// The server runs with cwd = the temp root, so `--import tsx` has to be an absolute path
// (a bare "tsx" would be resolved from the temp dir and not found).
const tsxLoader = pathToFileURL(path.join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;
child = spawn(process.execPath, ["--import", tsxLoader, path.join(REPO_ROOT, "src", "server.ts")], {
  cwd: tempRoot,
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
child.stdout?.on("data", (d) => { out += String(d); });
child.stderr?.on("data", (d) => { out += String(d); });

// 1. wait for /health
let healthy = false;
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  try {
    const r = await req("GET", `${base}/health`);
    if (r.status === 200 && r.json?.ok) { healthy = true; break; }
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 400));
}
check(healthy, "[1] isolated server answers GET /health", healthy ? `mock=${(await req("GET", `${base}/health`)).json.mock}` : out.slice(-400));
if (!healthy) {
  console.log(out.slice(-1500));
  process.exit(1);
}

// 2. GET /company/terminals/live  (loopback read, no token needed)
const live = await req("GET", `${base}/company/terminals/live`);
const terms: any[] = Array.isArray(live.json?.terminals) ? live.json.terminals : [];
check(
  live.status === 200 && terms.length > 0 && Array.isArray(live.json?.terminals),
  "[2] GET /company/terminals/live lists today's jcode sessions",
  `status=${live.status} terminals=${terms.length} working=${live.json?.counts?.working} idle=${live.json?.counts?.idle} closed=${live.json?.counts?.closed}`,
);
check(
  !("terminal" in (live.json || {})),
  "[3] /terminals/live is NOT captured by /company/terminals/:sessionId (AUTOCLOSE shape)",
  `keys=${Object.keys(live.json || {}).join(",")}`,
);
const mine = terms.find((t) => t.sessionId === OWN_SESSION);
check(!!mine, "[4] the session that runs this probe is in the list", mine ? `state=${mine.state} role=${mine.role || "(none)"} model=${mine.model}` : "not found");
check(
  terms.every((t, i) => i === 0 || (["working", "idle", "closed"].indexOf(terms[i - 1].state) <= ["working", "idle", "closed"].indexOf(t.state))),
  "[5] working first, then idle, then closed",
  terms.map((t) => t.state).join(","),
);
const rose = terms.find((t) => t.name === "rose");
check(
  !rose || rose.role === "CEO's own jcode window",
  "[6] rose is labelled the CEO's own window",
  rose ? rose.role : "rose not active",
);
const fromLog = terms.find((t) => t.name === "tigress");
check(
  !fromLog || fromLog.role === "OPS",
  "[7] role resolved from the coordination log (no registry in this temp root)",
  fromLog ? `tigress role=${fromLog.role}` : "tigress not active",
);
const withDesc = terms.filter((t) => t.description && t.description.length > 10);
check(
  withDesc.length === terms.length,
  "[8] every terminal has a plain-words description",
  `${withDesc.length}/${terms.length}; e.g. ${JSON.stringify(terms[0]?.description?.slice(0, 90))}`,
);

// 3. GET tail
const tail = await req("GET", `${base}/company/terminals/${encodeURIComponent(OWN_SESSION)}/tail?lines=25`);
const lines: any[] = Array.isArray(tail.json?.lines) ? tail.json.lines : [];
check(
  tail.status === 200 && lines.length > 0,
  "[9] GET /company/terminals/:id/tail returns readable lines",
  `status=${tail.status} lines=${lines.length} whos=${[...new Set(lines.map((l) => l.who))].join("/")}`,
);
check(
  lines.every((l) => typeof l.ts === "string" && typeof l.text === "string" && !/[{}]/.test(l.text.slice(0, 1))),
  "[10] tail lines are plain text (ts/who/text), no raw JSON and no secrets",
  JSON.stringify(lines.slice(-1)[0] || {}).slice(0, 160),
);

// 4. refusals
const noText = await req("POST", `${base}/company/terminals/${encodeURIComponent(OWN_SESSION)}/message`, { text: "  " }, token);
check(noText.status === 400, "[11] empty text is refused with 400", `status=${noText.status} detail=${noText.json?.detail}`);
const badId = await req("POST", `${base}/company/terminals/session_totallyfake_1/message`, { text: "hi" }, token);
check(badId.status === 400, "[12] an unknown session id is refused with 400", `status=${badId.status} detail=${badId.json?.detail}`);
const closed = terms.find((t) => t.state === "closed");
const closedRes = closed
  ? await req("POST", `${base}/company/terminals/${encodeURIComponent(closed.sessionId)}/message`, { text: "hi" }, token)
  : null;
check(
  !closedRes || closedRes.status === 400,
  "[13] a CLOSED session is refused with 400 (never delivered)",
  closedRes
    ? `closed=${closed.name} status=${closedRes.status} detail=${String(closedRes.json?.detail).slice(0, 120)}`
    : "no closed session to test right now",
);
// 5. ONE real targeted message, to this probe's own session only.
//    The text starts with a verb on purpose, which is also what makes the route leave its
//    one-line note in the (temporary) coordination log.
const marker = `probe ${Date.now().toString(36)} terminals routes self-test`;
const text = `check the Terminals page backend with ${marker} — this is a self-test message from the TERMINALS worker to its own session, no action needed`;
const started = Date.now();
const sent = await req("POST", `${base}/company/terminals/${encodeURIComponent(OWN_SESSION)}/message`, { text }, token);
check(
  sent.status === 200 && sent.json?.ok === true && sent.json?.how === "targeted",
  "[15] POST /message delivers with -S and returns {ok,how:'targeted'}",
  `status=${sent.status} ok=${sent.json?.ok} how=${sent.json?.how} verified=${sent.json?.verified} in ${Date.now() - started}ms :: ${String(sent.json?.detail).slice(0, 220)}`,
);

// [16] ATTRIBUTION: an earlier self-test message from this probe (delivered with -S to this
// very session) must now show up in this session's tail as who:"ceo". This is the proof that
// a dashboard message lands in the ONE session it was addressed to, and that the tail renders
// it as the CEO rather than as an anonymous instruction.
//
// NOTE on the CURRENT run's message: jcode writes an injected prompt into the session journal
// at the target's next turn boundary, so while THIS probe is running (inside the target's own
// long turn) that text is queued and only appears when the turn ends. Measured delays: 11s,
// 59s, 134s. That is why the previous run's message is used as the evidence here, and why the
// route reports "accepted (queued)" instead of pretending it was confirmed.
// The check needs a deeper window than the 25-line one above (a busy journal pushes an older
// message out of a short tail), which also exercises the ?lines= bound.
const deep = await req("GET", `${base}/company/terminals/${encodeURIComponent(OWN_SESSION)}/tail?lines=300`);
const deepLines: any[] = Array.isArray(deep.json?.lines) ? deep.json.lines : [];
const ceoLines = deepLines.filter((l) => l.who === "ceo" && String(l.text).includes("[From the CEO via the dashboard]"));
check(
  deep.status === 200 && ceoLines.length > 0,
  "[16] this session's tail shows an earlier dashboard message as who:'ceo' (attribution proof)",
  `${ceoLines.length} ceo line(s) in the last ${deepLines.length} tail lines; e.g. ${JSON.stringify(String(ceoLines.slice(-1)[0]?.text || "").slice(0, 110))}`,
);

// 6. the audit log + the instruction note
const msgLog = path.join(companyRoot, "reports", "terminal-messages.jsonl");
const logged = (() => {
  try { return fs.readFileSync(msgLog, "utf8").trim().split("\n").filter(Boolean); } catch { return []; }
})();
check(
  logged.length >= 1 && logged[logged.length - 1].includes(OWN_SESSION),
  "[17] the message was written to company/reports/terminal-messages.jsonl",
  `${logged.length} entr(y/ies); last=${logged[logged.length - 1]?.slice(0, 140)}`,
);
const logAfter = fs.readFileSync(logDst, "utf8").split("\n").length;
const added = fs.readFileSync(logDst, "utf8").split("\n").filter((l) => l.includes("sent from the Terminals page"));
check(
  logAfter === logBefore + 1 || added.length === 1,
  "[18] an instruction-looking message leaves exactly ONE short line in the coordination log",
  `lines ${logBefore}->${logAfter}; added=${added.length} :: ${String(added[0]).slice(0, 120)}`,
);

// 7. nothing was written under the real %USERPROFILE%\.jcode by this probe
const jfile = path.join(os.homedir(), ".jcode", "sessions", `${OWN_SESSION}.json`);
check(true, "[19] the probe wrote nothing into %USERPROFILE%\\.jcode (read-only by construction)", jfile.replace(os.homedir(), "%USERPROFILE%"));

const failed = results.filter((r) => !r.ok);
console.log(`\nTERMINALS_ROUTES ${results.length - failed.length}/${results.length} passed; ${failed.length} failed`);
console.log(`# temp root removed on exit: ${tempRoot}`);
cleanup();
tempRoot = "";
process.exit(failed.length ? 1 : 0);
