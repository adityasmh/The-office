// ops/probe-stdin.mjs — isolate WHY the opencode worker hangs.
//
// Observed: `opencode run ...` works when launched from a terminal but emits
// ZERO bytes when launched by Node's spawn (the pipeline worker shape) and never
// exits. The main structural difference is stdin: a terminal gives it a TTY,
// Node's default spawn gives it an open pipe nobody ever closes.
//
// This runs 4 variants concurrently, with a short timeout, to isolate:
//   - model (kimi vs deepseek)
//   - stdin ('pipe' left open  vs  'ignore'  vs  'pipe' then immediately ended)
//
// Usage: node ops/probe-stdin.mjs [timeoutSeconds]

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const EXE = "C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe";
const ROOT = "C:\\Users\\user\\Desktop\\Default Project";
const PROBE_ROOT = path.join(ROOT, "company", "probe-stdin");
const TIMEOUT_S = Number(process.argv[2] ?? 30);

const prompt = "create hello.txt with content hello";
fs.mkdirSync(PROBE_ROOT, { recursive: true });

const variants = [
  { name: "kimi-stdin-pipe", model: "opencode-go/kimi-k2.7-code", stdin: "pipe" },
  { name: "kimi-stdin-ignore", model: "opencode-go/kimi-k2.7-code", stdin: "ignore" },
  { name: "deepseek-stdin-pipe", model: "opencode-go/deepseek-v4-flash", stdin: "pipe" },
  { name: "deepseek-stdin-ignore", model: "opencode-go/deepseek-v4-flash", stdin: "ignore" },
];

function runVariant(v) {
  return new Promise((resolve) => {
    const workdir = path.join(PROBE_ROOT, v.name);
    fs.mkdirSync(workdir, { recursive: true });
    const args = ["run", "--dir", workdir, "--model", v.model, "--auto", "--format", "json", prompt];
    const startedAt = Date.now();
    const child = spawn(EXE, args, {
      cwd: workdir,
      env: { ...process.env },
      stdio: [v.stdin, "pipe", "pipe"], // the whole point of the experiment
    });

    let lines = 0;
    let firstEventMs = null;
    let last = "";
    let cost = 0;
    let stop = false;
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => { killed = true; try { child.kill(); } catch { /* gone */ } }, TIMEOUT_S * 1000);

    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        lines++;
        if (firstEventMs === null) firstEventMs = Date.now() - startedAt;
        try {
          const ev = JSON.parse(line);
          last = ev.type === "step_finish" ? `step_finish:${ev.part?.reason}` : String(ev.type);
          if (ev.type === "step_finish") {
            if (typeof ev.part?.cost === "number") cost += ev.part.cost;
            if (ev.part?.reason === "stop") stop = true;
          }
        } catch { /* non-json */ }
      }
    });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ name: v.name, status: "SPAWN_ERROR", error: String(e) }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const hello = path.join(workdir, "hello.txt");
      resolve({
        name: v.name, model: v.model, stdin: v.stdin,
        status: killed ? "TIMEOUT_KILLED" : "EXITED",
        exitCode: code,
        seconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
        firstEventMs, jsonLines: lines, stopEvent: stop, lastEvent: last,
        costUsd: Number(cost.toFixed(6)),
        helloCreated: fs.existsSync(hello) ? fs.readFileSync(hello, "utf8").trim() : null,
        stderr: stderr.trim().replace(/\s+/g, " ").slice(0, 200),
      });
    });
  });
}

console.log(`timeout: ${TIMEOUT_S}s, 4 variants concurrent (stdin mode is the variable)\n`);
const t0 = Date.now();
const results = await Promise.all(variants.map(runVariant));
for (const r of results) {
  console.log(`--- ${r.name}  [stdin=${r.stdin}]`);
  console.log(`    status=${r.status} exit=${r.exitCode} wall=${r.seconds}s firstEvent=${r.firstEventMs}ms json=${r.jsonLines} stop=${r.stopEvent} last=${r.lastEvent} cost=$${r.costUsd} hello=${JSON.stringify(r.helloCreated)}`);
  if (r.stderr) console.log(`    stderr=${r.stderr}`);
}
console.log(`\ntotal: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
