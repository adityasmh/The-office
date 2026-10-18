// PERF-BACKEND: run one expression inside a LIVE process and close the inspector
// again (manager's order, 2026-09-29). Opens the inspector with
// process._debugProcess(pid), evaluates the expression over CDP with the built-in
// WebSocket, prints the value, then closes the inspector from the inside with
// process.getBuiltinModule("node:inspector").close() - the only way that works
// without restarting the target (a dynamic import is not available in the CDP
// context, but getBuiltinModule is, on Node >= 22).
//
// Usage:
//   node ops/perf-backend/live-eval.mjs --pid 25808 --expr "1+1"
//   node ops/perf-backend/live-eval.mjs --pid 25808 --expr-file path/to/snippet.js
//   node ops/perf-backend/live-eval.mjs --pid 25808 --expr "process.uptime()" --await
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const PID = Number(arg("pid", "0"));
const PORT = Number(arg("debug-port", "9229"));
const AWAY = args.includes("--await");
const exprFile = arg("expr-file", "");
const EXPR = exprFile ? fs.readFileSync(exprFile, "utf8") : arg("expr", "");
if (!PID || !EXPR) {
  console.error("usage: node ops/perf-backend/live-eval.mjs --pid <pid> --expr '<js>' | --expr-file <file> [--await]");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
execFileSync(process.execPath, ["-e", `process._debugProcess(${PID})`], { stdio: "pipe" });

let target = null;
for (let i = 0; i < 50 && !target; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.webSocketDebuggerUrl) ?? null;
  } catch {
    /* not up yet */
  }
  if (!target) await sleep(200);
}
if (!target) {
  console.error(`no inspector target on 127.0.0.1:${PORT} for pid ${PID}`);
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", (e) => rej(new Error(String(e?.message ?? e))), { once: true });
});
let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  let m;
  try {
    m = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
  } catch {
    return;
  }
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
});
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });

let exitCode = 0;
try {
  const r = await send("Runtime.evaluate", { expression: EXPR, returnByValue: true, awaitPromise: AWAY, timeout: 120000 });
  if (r.exceptionDetails) {
    console.error(`# expression threw: ${r.exceptionDetails.text ?? ""} ${r.exceptionDetails.exception?.description ?? ""}`.slice(0, 400));
    exitCode = 1;
  } else {
    console.log(`# result: ${JSON.stringify(r.result?.value)}`);
  }
} catch (e) {
  console.error(`# evaluate failed: ${String(e).slice(0, 200)}`);
  exitCode = 1;
}

// Close the inspector from the inside; the socket usually dies right after, so
// never await anything on it beyond this point.
try {
  const i = ++id;
  ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression: `(process.getBuiltinModule("node:inspector").close(), "closed")`, returnByValue: true } }));
} catch {
  /* socket already gone */
}
await sleep(900);
try {
  ws.close();
} catch {
  /* gone */
}
let open = true;
try {
  await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
} catch {
  open = false;
}
console.log(open ? `# WARNING: inspector still listening on ${PORT}` : `# inspector closed on ${PORT}`);
process.exit(exitCode);
