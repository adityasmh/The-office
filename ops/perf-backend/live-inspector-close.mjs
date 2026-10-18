// PERF-BACKEND: close the inspector it opened on a live process.
//
// `process._debugProcess(pid)` opens the inspector and there is no "close from
// outside" in the CDP; the documented way is inspector.close() from INSIDE the
// target. A dynamic import is not available in the CDP default context, but Node
// >= 22 has process.getBuiltinModule(), which is. This tries that first and falls
// back to a few other handles, then reports whether 127.0.0.1:9229 is free.
//
// Usage: node ops/perf-backend/live-inspector-close.mjs --pid 25808 [--port 9229]
import fs from "node:fs";

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const PID = Number(arg("pid", "0"));
const PORT = Number(arg("port", "9229"));
if (!PID) {
  console.error("usage: node ops/perf-backend/live-inspector-close.mjs --pid <pid>");
  process.exit(2);
}

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const target = targets.find((t) => t.webSocketDebuggerUrl);
if (!target) {
  console.log("# no inspector target; nothing to close");
  process.exit(0);
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

const ATTEMPTS = [
  ["process.getBuiltinModule", `(() => { if (typeof process.getBuiltinModule !== "function") return "unavailable"; process.getBuiltinModule("node:inspector").close(); return "closed"; })()`],
  ["require", `(() => { if (typeof require !== "function") return "no require"; require("node:inspector").close(); return "closed"; })()`],
  ["process.mainModule", `(() => { const r = process.mainModule && process.mainModule.require; if (!r) return "no mainModule.require"; r("node:inspector").close(); return "closed"; })()`],
];

for (const [name, expression] of ATTEMPTS) {
  try {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true });
    const value = r.result?.value ?? (r.exceptionDetails ? `threw: ${String(r.exceptionDetails.text)}` : "?");
    console.log(`# ${name}: ${value}`);
    if (value === "closed") break;
  } catch (e) {
    console.log(`# ${name}: ${String(e).slice(0, 120)}`);
  }
}

// The socket usually dies when the inspector closes; either way, check the port.
await new Promise((r) => setTimeout(r, 700));
try {
  ws.close();
} catch {
  /* already closed by the target */
}
let listening = false;
try {
  await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  listening = true;
} catch {
  listening = false;
}
console.log(listening ? `# port ${PORT} is STILL listening` : `# port ${PORT} is closed`);
process.exit(listening ? 1 : 0);
