// ops/probe-node.mjs — faithful reproduction of the coder worker spawn.
//
// Mirrors src/company/workers.ts spawnOpencodeWorker exactly:
//   spawn(EXE, ["run","--dir",workdir,"--model",model,"--auto","--format","json",prompt],
//         { cwd: workdir, env: process.env })   // no shell -> argv quoting handled by libuv
//
// Runs several variants CONCURRENTLY with a hard timeout and reports, per variant:
// exit code, wall time, JSON event counts, whether a terminal step_finish{reason:stop}
// was seen, accumulated cost, and whether the file was really created.
//
// Usage: node ops/probe-node.mjs [timeoutSeconds]

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const EXE = "C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe";
const ROOT = "C:\\Users\\user\\Desktop\\Default Project";
const PROBE_ROOT = path.join(ROOT, "company", "probe-node");
const TIMEOUT_S = Number(process.argv[2] ?? 100);

const coderSystem =
  "You are a Coder. Implement the assigned subtask: edit the files, keep the diff minimal and focused, and report exactly what you changed and why. Follow the acceptance criteria. Run relevant checks if feasible.";
const longPrompt = `${coderSystem}\n\nTASK:\ncreate hello.txt with content hello`;
const shortPrompt = "create hello.txt with content hello";

const variants = [
  { name: "kimi-both", model: "opencode-go/kimi-k2.7-code", prompt: longPrompt, cwd: true, dir: true },
  { name: "kimi-dir-only", model: "opencode-go/kimi-k2.7-code", prompt: longPrompt, cwd: false, dir: true },
  { name: "deepseek-both", model: "opencode-go/deepseek-v4-flash", prompt: longPrompt, cwd: true, dir: true },
  { name: "kimi-short", model: "opencode-go/kimi-k2.7-code", prompt: shortPrompt, cwd: true, dir: true },
];

fs.mkdirSync(PROBE_ROOT, { recursive: true });

function runVariant(v) {
  return new Promise((resolve) => {
    const workdir = path.join(PROBE_ROOT, v.name);
    fs.mkdirSync(workdir, { recursive: true });
    const args = ["run"];
    if (v.dir) args.push("--dir", workdir);
    args.push("--model", v.model, "--auto", "--format", "json", v.prompt);

    const startedAt = Date.now();
    const logFile = path.join(PROBE_ROOT, `${v.name}.stdout.txt`);
    fs.writeFileSync(logFile, "");
    const log = fs.createWriteStream(logFile, { flags: "a" });

    const child = spawn(EXE, args, { ...(v.cwd ? { cwd: workdir } : { cwd: ROOT }), env: { ...process.env } });

    const types = {};
    let lines = 0;
    let cost = 0;
    let stopSeen = false;
    let firstEventAt = null;
    let lastEvent = "";
    const textParts = [];
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      try { child.kill(); } catch { /* already gone */ }
    }, TIMEOUT_S * 1000);

    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        log.write(line + "\n");
        lines++;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        const t = ev.type ?? "unknown";
        types[t] = (types[t] ?? 0) + 1;
        if (firstEventAt === null) firstEventAt = Date.now();
        lastEvent = t === "step_finish" ? `step_finish:${ev.part?.reason}` : t;
        if (t === "step_finish") {
          if (typeof ev.part?.cost === "number") cost += ev.part.cost;
          if (ev.part?.reason === "stop") stopSeen = true;
        }
        if (t === "text" && ev.part?.text) textParts.push(ev.part.text);
      }
    });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ name: v.name, status: "SPAWN_ERROR", error: String(e), seconds: (Date.now() - startedAt) / 1000 });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      log.end();
      const helloFile = path.join(workdir, "hello.txt");
      resolve({
        name: v.name,
        model: v.model,
        cwd: v.cwd,
        status: killed ? "TIMEOUT_KILLED" : "EXITED",
        exitCode: code,
        seconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
        firstEventSeconds: firstEventAt ? Number(((firstEventAt - startedAt) / 1000).toFixed(1)) : null,
        jsonLines: lines,
        stopEvent: stopSeen,
        lastEvent,
        costUsd: Number(cost.toFixed(6)),
        types,
        helloCreated: fs.existsSync(helloFile) ? fs.readFileSync(helloFile, "utf8").trim() : null,
        stderr: stderr.trim().slice(0, 300),
        textTail: textParts.join(" ").slice(-160),
      });
    });
  });
}

console.log(`probe root: ${PROBE_ROOT}`);
console.log(`timeout per variant: ${TIMEOUT_S}s, running ${variants.length} variants concurrently\n`);

const startedAt = Date.now();
const results = await Promise.all(variants.map(runVariant));

for (const r of results) {
  console.log(`--- ${r.name} (${r.model}${r.cwd ? ", cwd+dir" : ", --dir only"})`);
  console.log(
    `    status=${r.status} exit=${r.exitCode} wall=${r.seconds}s firstEvent=${r.firstEventSeconds}s json=${r.jsonLines} ` +
    `stopEvent=${r.stopEvent} last=${r.lastEvent} cost=$${r.costUsd} hello=${JSON.stringify(r.helloCreated)}`
  );
  console.log(`    events=${JSON.stringify(r.types)}`);
  if (r.stderr) console.log(`    stderr=${r.stderr.replace(/\s+/g, " ")}`);
  if (r.textTail) console.log(`    text="${r.textTail.replace(/\s+/g, " ")}"`);
}
console.log(`\ntotal wall time: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
