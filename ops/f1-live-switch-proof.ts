/**
 * F1 proof driver: run `switchSessionModel()` (src/company/fleet.ts) against a REAL throwaway session
 * and confirm the switch from two independent places.
 *
 * It opens one visible window with EXACTLY the fleet's launcher shape (Start-Process, the same provider,
 * the same repo), finds the session the server registered for it, calls the production function, and
 * checks the SERVER's own session view plus the session journal. Then it switches the session back with
 * the raw one-line command and closes the window, so a run leaves nothing behind.
 *
 * Result of the first green run (2026-09-29):
 *   registered in ~2s: session_rabbit_... model=deepseek-v4.1-flash
 *   switchSessionModel(sid, kimi-k2.7-code) -> ok=true in 351ms
 *     detail: server view: kimi-k2.7-code @ OpenCode Go (a session writes its journal on its first turn)
 *   switched back with `jcode debug -S <sid> set_model:deepseek-v4.1-flash` -> deepseek-v4.1-flash
 *   window closed, sessions after: 4 (no residue)
 * The journal being empty before the first turn is WHY the production check asks the server first.
 *
 * Note: a bare spawn() from a non-interactive shell gives the child no console and the TUI dies
 * without registering - measured - so this must go through Start-Process exactly as the fleet does.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as fleet from "../src/company/fleet";

const REPO = process.cwd();
const WORK = path.join(process.env.TEMP ?? ".", "f1-live");

type DebugSession = {
  session_id: string;
  friendly_name: string;
  status: string;
  model: string | null;
  provider: string | null;
};

function debugSessions(): DebugSession[] {
  const raw = execFileSync("jcode", ["debug", "sessions"], { encoding: "utf8", timeout: 30000 });
  return JSON.parse(raw) as DebugSession[];
}

function serverModel(sid: string): string | null {
  return debugSessions().find((s) => s.session_id === sid)?.model ?? null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  fs.mkdirSync(WORK, { recursive: true });
  const script = [
    "$Host.UI.RawUI.WindowTitle = 'f1 model-switch proof (throwaway)'",
    `Set-Location -LiteralPath '${REPO}'`,
    "jcode -p opencode-go",
    "",
  ].join("\r\n");
  const file = path.join(WORK, "run.ps1");
  fs.writeFileSync(file, script);

  const before = new Set(debugSessions().map((s) => s.session_id));
  const beforeClients = new Set(fleet.liveClientSessions().keys());
  console.log(`[live] sessions before: ${before.size} (live TUI clients: ${beforeClients.size})`);

  // EXACTLY the fleet's mechanism (src/company/fleet.ts spawnWorkerWindow): a bare spawn() from a
  // non-interactive shell gives the child NO console, and a TUI dies without one - measured here, the
  // window never registered a session that way. Start-Process is what actually opens a real window.
  const argLine = `-NoLogo -NoExit -ExecutionPolicy Bypass -File "${file}"`;
  const inner =
    `Start-Process -FilePath 'powershell' ` +
    `-ArgumentList '${argLine.replace(/'/g, "''")}' ` +
    `-WorkingDirectory '${REPO}' -PassThru | Select-Object -ExpandProperty Id`;
  const launcherPid = Number(
    execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", inner], { encoding: "utf8", timeout: 30000 }).trim().split(/\r?\n/).pop(),
  );
  console.log(`[live] throwaway window pid ${launcherPid}; waiting for the server to register its session...`);

  let sid = "";
  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    // The window's TUI client registers client_sessions/<pid> = session id; take a session we did not
    // have before, and never one the server already knew.
    const newClients = [...fleet.liveClientSessions().entries()].filter(([id]) => !beforeClients.has(id) && !before.has(id));
    const fromServer = debugSessions().filter((s) => !before.has(s.session_id));
    if (newClients.length || fromServer.length) {
      sid = (newClients[0]?.[0] ?? fromServer[0].session_id);
      console.log(`[live] registered after ~${(i + 1) * 2}s: ${sid} (client pid ${newClients[0]?.[1] ?? "?"}) model=${fromServer[0]?.model ?? "null"}`);
      break;
    }
  }
  if (!sid) {
    console.log("[live] FAIL: the window never registered a session");
    try { execFileSync("taskkill", ["/PID", String(launcherPid), "/T", "/F"], { timeout: 30000 }); } catch { /* ignore */ }
    process.exitCode = 1;
    return;
  }

  await sleep(3000); // let the TUI settle: it is the TUI process that the server maps to this session

  const journalBefore = fleet.sessionLive(sid, 5, true).model ?? "(none)";
  const serverBefore = serverModel(sid) ?? "(none)";
  console.log("");

  // ── the real switch, through the production function ──
  const t = Date.now();
  const res = await fleet.switchSessionModel(sid, "kimi-k2.7-code");
  const ms = Date.now() - t;
  const journalAfter = fleet.sessionLive(sid, 5, true).model ?? "(none)";
  const serverAfter = serverModel(sid) ?? "(none)";
  console.log(`[live] switchSessionModel(sid, kimi-k2.7-code) -> ok=${res.ok} in ${ms}ms`);
  console.log(`[live]   detail        : ${res.detail}`);
  console.log(`[live]   server view   : ${serverBefore} -> ${serverAfter}`);
  console.log(`[live]   session record: ${journalBefore} -> ${journalAfter}`);
  console.log(`[live]   ${res.ok && serverAfter === "kimi-k2.7-code" ? "PASS" : "FAIL"}  set_model changes the session (server view agrees)`);
  console.log(
    `[live]   ${journalAfter === "kimi-k2.7-code" || journalBefore === "(none)" ? "PASS" : "FAIL"}  session's own record: ${
      journalBefore === "(none)" ? "(none yet - a fresh session writes its journal on its first turn, which is why the server view is asked first)" : `${journalBefore} -> ${journalAfter}`
    }`,
  );
  console.log("");

  // ── the raw command, as the manager's spawn helper would run it ──
  const rawOut = execFileSync("jcode", ["debug", "-S", sid, "set_model:deepseek-v4.1-flash"], { encoding: "utf8", timeout: 30000 }).trim();
  await sleep(1500);
  const backServer = serverModel(sid) ?? "(none)";
  const backJournal = fleet.sessionLive(sid, 5, true).model ?? "(none)";
  console.log(`[live] raw  "jcode debug -S <sid> set_model:deepseek-v4.1-flash" output: ${rawOut || "(empty; exit 0)"}`);
  console.log(`[live]   switched back: server=${backServer} journal=${backJournal}  ${backServer === "deepseek-v4.1-flash" ? "PASS" : "FAIL"}`);
  console.log("");

  try {
    execFileSync("taskkill", ["/PID", String(launcherPid), "/T", "/F"], { encoding: "utf8", timeout: 30000 });
    console.log(`[live] closed the throwaway window (pid ${launcherPid})`);
  } catch (e) {
    console.log(`[live] could not close the window: ${String(e)}`);
  }
  await sleep(2000);
  const left = debugSessions().filter((s) => !before.has(s.session_id));
  console.log(`[live] sessions after: ${debugSessions().length} (test session still server-side: ${left.length ? left[0].session_id : "no"})`);
}

void main();
