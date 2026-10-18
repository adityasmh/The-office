// drop-zombies.mjs - retire "zombie" pipeline tasks: non-final tasks that have no live worker and have not changed for a while,
// plus older duplicates of an order that already has a newer live task. Lossless: JSON.parse / JSON.stringify of the same structure,
// atomic write (temp file + rename), and a one-time backup copy. Usage: node ops/drop-zombies.mjs <tasks.json> <liveStems,comma> <minIdleMinutes> [--apply]
import fs from "node:fs";

const [file, liveArg = "", idleArg = "12", flag = ""] = process.argv.slice(2);
if (!file) { console.log("usage: node ops/drop-zombies.mjs <tasks.json> <liveStems> <minIdleMinutes> [--apply]"); process.exit(2); }
const apply = flag === "--apply";
const live = new Set(liveArg.split(",").map((s) => s.trim()).filter(Boolean));
const idleMs = Number(idleArg) * 60000;
const FINAL = new Set(["merged", "failed", "pending_merge", "pending_code", "pending_intake"]);

const raw = fs.readFileSync(file, "utf8");
const tasks = JSON.parse(raw);
if (!Array.isArray(tasks)) { console.log("tasks.json is not an array; refusing"); process.exit(3); }

const stemOf = (t) => { const m = /^# Order ([A-Za-z0-9]+)-/.exec(String(typeof t.rawRequest === "string" ? t.rawRequest : (t.rawRequest && t.rawRequest.value) || "")); return m ? m[1] : ""; };
const now = Date.now();
const age = (t) => now - Date.parse(t.updatedAt || t.createdAt || 0);

// newest non-final task per stem is the only one allowed to be "the live one"
const byStem = new Map();
for (const t of tasks) { if (FINAL.has(t.status)) continue; const s = stemOf(t); if (!s) continue; const arr = byStem.get(s) || []; arr.push(t); byStem.set(s, arr); }

const drop = [];
for (const [stem, arr] of byStem) {
  arr.sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
  arr.forEach((t, i) => {
    const newest = i === 0;
    if (!newest) { drop.push([t, "older duplicate of a newer task for the same order"]); return; }
    if (!live.has(stem) && age(t) > idleMs) drop.push([t, "no live worker for " + Math.round(age(t) / 60000) + " min"]);
  });
}

console.log((apply ? "APPLY" : "DRY RUN") + ": " + tasks.length + " tasks, " + [...byStem.values()].flat().length + " non-final, " + drop.length + " zombie(s)");
for (const [t, why] of drop.slice(0, 40)) console.log("  " + t.id + " " + stemOf(t) + " [" + t.status + "] " + why);

if (apply && drop.length) {
  const bak = file + ".prezombie";
  if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
  const ids = new Set(drop.map(([t]) => t.id));
  const stamp = new Date().toISOString();
  for (const t of tasks) if (ids.has(t.id)) { t.status = "failed"; t.error = "dropped by the manager: zombie task (no live worker)"; t.updatedAt = stamp; }
  const tmp = file + ".tmp" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(tasks, null, 2));
  JSON.parse(fs.readFileSync(tmp, "utf8")); // must parse back
  fs.renameSync(tmp, file);
  console.log("applied: " + drop.length + " task(s) marked failed (backup: " + bak + ")");
}
