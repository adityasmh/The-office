// OPS-START scratch probe (session badger). Read-only.
//
// 1. Lists any pipeline task that is mid-run in company/projects/<id>/tasks.json
//    (the manager asked to confirm this before restarting the router).
// 2. Times a few live endpoints on the router, so the "before" numbers are recorded.
//
// Usage: node ops/tmp-ops-start-state.mjs [--base http://127.0.0.1:8787]
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const BASE = arg("base", "http://127.0.0.1:8787");

// ---- 1. mid-run tasks ------------------------------------------------------
const MID = new Set(["planning", "coding", "testing", "queued", "starting"]);
const projectsDir = "company/projects";
let found = 0;
if (fs.existsSync(projectsDir)) {
  for (const d of fs.readdirSync(projectsDir)) {
    const p = path.join(projectsDir, d, "tasks.json");
    if (!fs.existsSync(p)) continue;
    let tasks;
    try {
      tasks = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
      console.log(`  [warn] ${p}: unreadable (${e.message})`);
      continue;
    }
    const arr = Array.isArray(tasks) ? tasks : tasks.tasks ?? [];
    for (const t of arr) {
      if (t && MID.has(t.status)) {
        found++;
        console.log(`MID-RUN project=${d} id=${t.id} status=${t.status} title=${String(t.title ?? "").slice(0, 60)}`);
      }
    }
  }
}
console.log(`mid-run tasks: ${found}`);

// ---- 2. endpoint timings ---------------------------------------------------
const urls = [
  "/health",
  "/v2/",
  "/v2/index.html",
  "/v2/app.js",
  "/company/budget?lite=1",
  "/company/flow",
];
for (const u of urls) {
  const t0 = Date.now();
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30000);
    const r = await fetch(BASE + u, { signal: ac.signal });
    const body = await r.text();
    clearTimeout(timer);
    console.log(`  ${u}  ->  ${r.status}  ${Date.now() - t0}ms  bytes=${body.length}  ${body.slice(0, 120).replace(/\s+/g, " ")}`);
  } catch (e) {
    console.log(`  ${u}  ->  ERR ${Date.now() - t0}ms  ${e.name}: ${e.message}`);
  }
}
