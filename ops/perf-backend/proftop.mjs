// PERF-BACKEND cpuprofile reader (2026-09-29).
//
// Turns a V8 .cpuprofile (node --cpu-prof) into the ranked list of functions by
// SELF time, which is what "what is blocking the event loop" actually means.
// Leaves (the functions doing the synchronous work) dominate the top of it.
//
// Usage: node ops/perf-backend/proftop.mjs <file.cpuprofile> [--top 25] [--json out.json]

import fs from "node:fs";

const [file, ...rest] = process.argv.slice(2);
if (!file) {
  console.error("usage: node ops/perf-backend/proftop.mjs <file.cpuprofile> [--top N] [--json out.json]");
  process.exit(2);
}
const topIx = rest.indexOf("--top");
const TOP = topIx >= 0 ? Number(rest[topIx + 1]) : 25;
const jsonIx = rest.indexOf("--json");

const prof = JSON.parse(fs.readFileSync(file, "utf8"));
const nodes = new Map(prof.nodes.map((n) => [n.id, n]));
// A 0.5 ms sampler that reports a single 29,502 ms gap was STARVED, not working:
// the delta is unwitnessed wall time, and whatever frame that one sample happens to
// carry gets charged with all of it. --max-delta (default 100 ms) drops those
// deltas so the ranking reflects sampled work only; --timeline shows the runs.
const clampIx = rest.indexOf("--max-delta");
const MAX_DELTA = clampIx >= 0 ? Number(rest[clampIx + 1]) : 100;
const self = new Map(); // id -> micros
const total = { micros: 0, dropped: 0 };
for (let i = 0; i < prof.samples.length; i++) {
  const id = prof.samples[i];
  const dt = prof.timeDeltas[i] ?? 0;
  if (dt < 0) continue;
  if (dt > MAX_DELTA * 1000) {
    total.dropped += dt;
    continue;
  }
  self.set(id, (self.get(id) ?? 0) + dt);
  total.micros += dt;
}

const rows = [];
for (const [id, micros] of self) {
  const n = nodes.get(id);
  if (!n) continue;
  const cf = n.callFrame ?? {};
  const url = String(cf.url ?? "");
  const shortUrl = url.replace(/^file:\/\/\//, "").replace(/^.*\/(node_modules|src)\//, "$1/");
  rows.push({
    fn: cf.functionName || "(anonymous)",
    url: shortUrl,
    line: cf.lineNumber,
    selfMs: micros / 1000,
    pct: (micros / total.micros) * 100,
  });
}
// Merge identical frames (same fn+url+line) - V8 emits one node per call site path.
const merged = new Map();
for (const r of rows) {
  const k = `${r.fn}\u0000${r.url}\u0000${r.line}`;
  const cur = merged.get(k);
  if (cur) { cur.selfMs += r.selfMs; cur.pct += r.pct; }
  else merged.set(k, { ...r });
}
const ranked = [...merged.values()].sort((a, b) => b.selfMs - a.selfMs);

const wall = total.micros / 1000;
console.log(
  `# ${file}: ${wall.toFixed(0)} ms of sampled CPU time (${prof.samples.length} samples, ${prof.nodes.length} nodes)` +
    (total.dropped ? `; DROPPED ${(total.dropped / 1000).toFixed(0)} ms in sampler gaps > ${MAX_DELTA} ms (profiler starved, not work)` : ""),
);
console.log(`# rank  self_ms    %cpu   function  (file:line)`);
ranked.slice(0, TOP).forEach((r, i) => {
  console.log(`${String(i + 1).padStart(4)}  ${r.selfMs.toFixed(0).padStart(8)}  ${r.pct.toFixed(2).padStart(6)}   ${r.fn}  (${r.url}:${r.line})`);
});
if (jsonIx >= 0 && rest[jsonIx + 1]) {
  fs.writeFileSync(rest[jsonIx + 1], JSON.stringify({ file, cpuMs: wall, top: ranked.slice(0, 200) }, null, 2));
  console.log(`# wrote ${rest[jsonIx + 1]}`);
}

// --callers <name>|  : who calls these functions? (aggregated parents)
const callersIx = rest.indexOf("--callers");
if (callersIx >= 0) {
  const needle = (rest[callersIx + 1] ?? "").toLowerCase();
  const parents = new Map(); // node id -> Set of parent ids
  for (const n of prof.nodes) {
    for (const c of n.children ?? []) {
      let set = parents.get(c);
      if (!set) { set = new Set(); parents.set(c, set); }
      set.add(n.id);
    }
  }
  const frame = (id) => {
    const cf = nodes.get(id)?.callFrame ?? {};
    const url = String(cf.url ?? "").replace(/^file:\/\/\//, "").replace(/^.*\/(node_modules|src)\//, "$1/");
    return `${cf.functionName || "(anonymous)"} (${url}:${cf.lineNumber})`;
  };
  console.log(`# callers of "${needle}":`);
  const agg = new Map();
  for (const n of prof.nodes) {
    const fn = String(n.callFrame?.functionName ?? "").toLowerCase();
    const url = String(n.callFrame?.url ?? "").toLowerCase();
    if (!fn.includes(needle) && !url.includes(needle)) continue;
    const selfMs = (self.get(n.id) ?? 0) / 1000;
    for (const pid of parents.get(n.id) ?? []) {
      const k = frame(pid);
      const cur = agg.get(k) ?? { selfMs: 0, sites: 0 };
      cur.selfMs += selfMs;
      cur.sites++;
      agg.set(k, cur);
    }
  }
  [...agg.entries()]
    .sort((a, b) => b[1].selfMs - a[1].selfMs)
    .slice(0, 12)
    .forEach(([k, v]) => console.log(`  ${v.selfMs.toFixed(0).padStart(8)} ms (from ${v.sites} call site(s))  ${k}`));
}

// --timeline <name> : when were the samples for matching frames taken?
// A frame with 30 s of self time is either ONE long block or MANY short ones, and
// the fix is completely different. This prints the contiguous sample runs (offset
// from profile start, duration) so that question is answered with numbers.
const tlIx = rest.indexOf("--timeline");
if (tlIx >= 0) {
  const needle = (rest[tlIx + 1] ?? "").toLowerCase();
  const interesting = new Set();
  for (const n of prof.nodes) {
    const fn = String(n.callFrame?.functionName ?? "").toLowerCase();
    const url = String(n.callFrame?.url ?? "").toLowerCase();
    if (fn.includes(needle) || url.includes(needle)) interesting.add(n.id);
  }
  const runs = [];
  let cur = null;
  let t = 0; // microseconds from profile start
  for (let i = 0; i < prof.samples.length; i++) {
    const dt = prof.timeDeltas[i] ?? 0;
    if (dt > 0) t += dt;
    const hit = interesting.has(prof.samples[i]);
    if (hit) {
      if (!cur) cur = { start: t, dur: 0, n: 0 };
      cur.dur += dt;
      cur.n++;
    } else if (cur) {
      if (cur.dur >= 1000) runs.push(cur); // ignore sub-ms noise
      cur = null;
    }
  }
  if (cur && cur.dur >= 1000) runs.push(cur);
  const totalMs = runs.reduce((n, r) => n + r.dur / 1000, 0);
  console.log(`# timeline for "${needle}": ${runs.length} contiguous run(s) >= 1 ms, ${totalMs.toFixed(0)} ms total`);
  console.log("#   at(s)   duration(ms)   samples");
  runs
    .sort((a, b) => b.dur - a.dur)
    .slice(0, 20)
    .forEach((r) => console.log(`   ${(r.start / 1e6).toFixed(1).padStart(7)}  ${(r.dur / 1000).toFixed(0).padStart(12)}  ${String(r.n).padStart(8)}`));
}
// ancestor chain, so a leaf like spawn/spawnSync can be attributed to the src/
// function that called it.
const stackIx = rest.indexOf("--stack");
if (stackIx >= 0) {
  const needle = (rest[stackIx + 1] ?? "").toLowerCase();
  const parentOf = new Map();
  for (const n of prof.nodes) {
    for (const c of n.children ?? []) if (!parentOf.has(c)) parentOf.set(c, n.id);
  }
  const frame = (id) => {
    const cf = nodes.get(id)?.callFrame ?? {};
    const url = String(cf.url ?? "").replace(/^file:\/\/\//, "").replace(/^.*\/(node_modules|src)\//, "$1/");
    return `${cf.functionName || "(anonymous)"} (${url}:${cf.lineNumber})`;
  };
  const hot = prof.nodes
    .filter((n) => {
      const fn = String(n.callFrame?.functionName ?? "").toLowerCase();
      const url = String(n.callFrame?.url ?? "").toLowerCase();
      return (fn.includes(needle) || url.includes(needle)) && (self.get(n.id) ?? 0) > 0;
    })
    .sort((a, b) => (self.get(b.id) ?? 0) - (self.get(a.id) ?? 0))
    .slice(0, 3);
  console.log(`# stacks for the hottest "${needle}" frames:`);
  for (const n of hot) {
    const chain = [];
    let id = n.id;
    let guard = 0;
    while (id !== undefined && guard++ < 40) {
      chain.push(frame(id));
      const p = parentOf.get(id);
      if (p === undefined) break;
      id = p;
    }
    console.log(`  self ${((self.get(n.id) ?? 0) / 1000).toFixed(0)} ms`);
    chain.slice(0, 14).forEach((f, i) => console.log(`      ${"  ".repeat(Math.min(i, 8))}${f}`));
  }
}
