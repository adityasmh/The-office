/**
 * ops/jcode-model-probe.ts — does `jcode -m <model>` actually switch the model?
 *
 * docs/LAYA_FIX_SPEC.md Fix 1 says to spawn each fleet terminal with
 * `jcode -p opencode-go -m <model>`. Measured 20:19: it does NOT switch. This probe
 * tries the plausible command forms, one throwaway window each (a temp dir, serialized),
 * and reports what the session itself says it runs.
 *
 * It spawns real terminals (that is the point) but touches nothing else: no server, no
 * repo files, and it kills each window it opens.
 *
 *   npx tsx ops/jcode-model-probe.ts [--model kimi-k2.7-code]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const modelIdx = process.argv.indexOf("--model");
const MODEL = modelIdx >= 0 ? process.argv[modelIdx + 1] : "kimi-k2.7-code";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jcode-model-probe-"));
const jcodeDir = path.join(os.homedir(), ".jcode");
const clientSessions = path.join(jcodeDir, "client_sessions");
const sessionsDir = path.join(jcodeDir, "sessions");

const liveSessions = (): Set<string> => {
  const out = new Set<string>();
  for (const name of fs.readdirSync(clientSessions)) {
    const pid = Number(name);
    if (!Number.isFinite(pid)) continue;
    try { process.kill(pid, 0); } catch { continue; }
    const sid = fs.readFileSync(path.join(clientSessions, name), "utf8").trim();
    if (sid) out.add(sid);
  }
  return out;
};

const sessionModel = (sid: string): { json?: string; journal?: string } => {
  const out: { json?: string; journal?: string } = {};
  try {
    const j = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${sid}.json`), "utf8")) as { model?: string };
    out.json = j.model;
  } catch { /* not written yet */ }
  const jf = path.join(sessionsDir, `${sid}.journal.jsonl`);
  try {
    const lines = fs.readFileSync(jf, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      const rec = JSON.parse(line) as { meta?: { model?: string } };
      if (rec.meta?.model) out.journal = rec.meta.model;
    }
  } catch { /* no journal yet */ }
  return out;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const forms: Array<{ label: string; args: string }> = [
  { label: "spec form: -p opencode-go -m <model>", args: `-p opencode-go -m ${MODEL}` },
  { label: "long flag: -p opencode-go --model <model>", args: `-p opencode-go --model ${MODEL}` },
  { label: "model first: -m <model> -p opencode-go", args: `-m ${MODEL} -p opencode-go` },
  { label: "qualified id: -p opencode-go -m opencode-go/<model>", args: `-p opencode-go -m opencode-go/${MODEL}` },
  { label: "resume-free: -p opencode-go --model=<model>", args: `-p opencode-go --model=${MODEL}` },
];

console.log(`[model-probe] model=${MODEL}  (temp dir ${tmp})`);
console.log("");
for (const form of forms) {
  const before = liveSessions();
  const dir = path.join(tmp, form.label.replace(/[^a-z0-9]+/gi, "_").slice(0, 40));
  fs.mkdirSync(dir, { recursive: true });
  const launcher = path.join(dir, "run.ps1");
  fs.writeFileSync(launcher, ["Set-Location -LiteralPath '" + dir + "'", `jcode ${form.args}`, ""].join("\r\n"));
  const inner = `Start-Process -FilePath 'powershell' -ArgumentList ${`'-NoLogo -NoExit -ExecutionPolicy Bypass -File "${launcher}"'`} -WorkingDirectory '${dir}' -PassThru | Select-Object -ExpandProperty Id`;
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", inner], { encoding: "utf8" });
  const pid = Number(r.stdout.trim());
  if (!Number.isFinite(pid) || pid <= 0) {
    console.log(`${form.label}\n   spawn FAILED: ${r.stderr.trim().slice(0, 120)}`);
    continue;
  }
  // Wait for a new session to appear, then a moment for its first record.
  let sid = "";
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    for (const s of liveSessions()) if (!before.has(s)) sid = s;
    if (sid) break;
    await sleep(1000);
  }
  await sleep(1500);
  // Deliver one tiny message: without a turn the session writes no model record at all.
  if (sid) {
    try {
      spawnSync("jcode", ["transcript", "--mode", "send", "-S", sid], { input: "Reply with the single word ACK.", encoding: "utf8", timeout: 60000 });
    } catch { /* delivery best effort */ }
    await sleep(12000);
  }
  const seen = sid ? sessionModel(sid) : {};
  const switched = seen.json === MODEL || seen.journal === MODEL;
  console.log(`${form.label}`);
  console.log(`   window pid ${pid} session ${sid || "(none)"}`);
  console.log(`   session says: json.model=${seen.json ?? "-"} journal.meta.model=${seen.journal ?? "-"}  => ${switched ? "SWITCHED" : "NOT switched"}`);
  spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  await sleep(1500);
}
console.log("");
console.log("[model-probe] done (every window it opened was closed)");
