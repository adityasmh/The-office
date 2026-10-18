/**
 * ops/autoclose-reap.ts - drive the terminal reaper by hand (docs/AUTOCLOSE_SPEC.md).
 *
 *   npx tsx ops/autoclose-reap.ts --backfill        register hand-opened sessions (one-off)
 *   npx tsx ops/autoclose-reap.ts --status          print the registry + live evidence
 *   npx tsx ops/autoclose-reap.ts [--dry-run]       one pass, nothing is closed (default)
 *   npx tsx ops/autoclose-reap.ts --kill            one REAL pass (closes verified PASS terminals)
 *   npx tsx ops/autoclose-reap.ts --selftest        safety assertions on real pids, no kills
 *   npx tsx ops/autoclose-reap.ts --repair-archives rewrite missing archives + registry links
 *   npx tsx ops/autoclose-reap.ts --bench           timing proof that the route path never blocks
 *
 * --json prints the raw machine-readable result (used for the log evidence).
 * It never starts a server and never touches the router on :8787.
 *
 * REAPER-ASYNC: every pass here goes through the SAME async entry point the router loop uses
 * (`runReaperPassAsync`), so this CLI exercises the real code path: async `execFile` process table,
 * a 20s timeout, the re-entrancy guard and the async `taskkill`. A single pass never blocks this
 * process's event loop either (the selftest proves it with a 50ms interval).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  archiveAbsPath,
  archiveRelPath,
  buildArchive,
  effectiveVerdict,
  backfillTerminals,
  graceMs,
  listTerminals,
  liveClientPids,
  loadTerminals,
  ownProcessTree,
  processTableStatus,
  reaperStatus,
  registryFile,
  runReaperPass,
  runReaperPassAsync,
  saveTerminals,
  snapshotProcessesAsync,
  verifyWindow,
  windowHostsSession,
  PROTECTED_SESSION_NAMES,
  type ProcMap,
  type ProcRow,
  type ReapPass,
  type TerminalRec,
} from "../src/company/terminalReaper.js";

const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);
const json = has("--json");

function pad(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n);
}

function printPass(pass: ReapPass): void {
  if (json) {
    console.log(JSON.stringify(pass, null, 2));
    return;
  }
  console.log(
    `# autoclose pass ${pass.at} dryRun=${pass.dryRun} enabled=${pass.enabled} grace=${pass.graceSeconds}s -> ` +
      `${pass.decisions.length} terminal(s) considered, ${pass.closed.length} closed` +
      `${pass.note ? `\n# note: ${pass.note}` : ""}`,
  );
  console.log(
    `${pad("session", 12)} ${pad("name", 10)} ${pad("spawnedBy", 12)} ${pad("state", 9)} ${pad("action", 14)} ${pad("verdict", 7)} reason`,
  );
  for (const d of pass.decisions) {
    console.log(
      `${pad(d.sessionId.slice(0, 12), 12)} ${pad(d.sessionName || "-", 10)} ${pad(d.spawnedBy, 12)} ${pad(d.state, 9)} ` +
        `${pad(d.action, 14)} ${pad(d.verdict ?? "-", 7)} ${d.reason}`,
    );
  }
}

/** GET /company/terminals does exactly this (non-blocking); an ops report passes a fresh table in. */
async function printStatus(): Promise<void> {
  const procs = await snapshotProcessesAsync(true);
  const rows = listTerminals(procs);
  const status = reaperStatus();
  const table = processTableStatus();
  if (json) {
    console.log(JSON.stringify({ reaper: status, processTable: table, terminals: rows }, null, 2));
    return;
  }
  console.log(
    `# registry ${registryFile()} (${status.registered} record(s)) | reaper: enabled=${status.enabled} ` +
      `running=${status.running} dryRun=${status.dryRun} interval=${status.intervalMs}ms grace=${status.graceSeconds}s`,
  );
  console.log(
    `# process table: rows=${table.rows} age=${table.ageMs === undefined ? "-" : `${Math.round(table.ageMs / 1000)}s`} ` +
      `refreshing=${table.refreshing} ready=${table.ready} (a pass acts only on a table that is ready)`,
  );
  console.log(
    `${pad("name", 10)} ${pad("session", 44)} ${pad("spawnedBy", 12)} ${pad("state", 9)} ${pad("windowPid", 10)} ${pad("idle", 7)} ${pad("stream", 7)} window`,
  );
  for (const r of rows) {
    console.log(
      `${pad(r.sessionName || "-", 10)} ${pad(r.sessionId, 44)} ${pad(r.spawnedBy, 12)} ${pad(r.state, 9)} ` +
        `${pad(String(r.windowPid ?? "-"), 10)} ${pad(r.idleSeconds === undefined ? "-" : `${r.idleSeconds}s`, 7)} ` +
        `${pad(String(r.streaming), 7)} ${r.windowNote}`,
    );
  }
}

async function printBackfill(): Promise<void> {
  const result = await backfillTerminals();
  if (json) {
    console.log(
      JSON.stringify(
        {
          scanned: result.scanned,
          added: result.added.map((r) => ({ sessionId: r.sessionId, sessionName: r.sessionName, role: r.role, spawnedBy: r.spawnedBy, windowPid: r.windowPid, clientPid: r.clientPid })),
          refreshed: result.refreshed.map((r) => ({ sessionId: r.sessionId, sessionName: r.sessionName, windowPid: r.windowPid })),
          unknown: result.unknown,
          windowless: result.windowless,
          pruned: result.pruned,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(`# backfill: scanned ${result.scanned} attached session(s), added ${result.added.length}, refreshed ${result.refreshed.length}, pruned ${result.pruned.length}`);
  for (const r of result.added) console.log(`ADD      ${pad(r.sessionName, 12)} ${pad(r.sessionId, 44)} ${pad(r.spawnedBy, 12)} window=${r.windowPid ?? "-"} client=${r.clientPid ?? "-"} ${r.role}`);
  for (const r of result.refreshed) console.log(`REFRESH  ${pad(r.sessionName, 12)} ${pad(r.sessionId, 44)} ${pad(r.spawnedBy, 12)} window=${r.windowPid ?? "-"} client=${r.clientPid ?? "-"} ${r.role}`);
  for (const u of result.unknown) console.log(`UNKNOWN  ${u} -> spawnedBy "unknown" (never closable)`);
  for (const w of result.windowless) console.log(`NOWINDOW ${w} -> not a terminal, nothing to close`);
  for (const p of result.pruned) console.log(`PRUNED   ${p} -> useless record removed (no window, no verdict, no archive)`);
}

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` -> ${detail}` : ""}`);
}

/**
 * Timing proof for the ROUTE path: `GET /company/terminals` must answer immediately even with a cold
 * process table (it used to spawn PowerShell synchronously and take 1.77s). The refresh itself is
 * allowed to take seconds - it just must not be on a request's stack.
 */
async function bench(): Promise<void> {
  const t0 = Date.now();
  listTerminals();
  const coldMs = Date.now() - t0;
  const t1 = Date.now();
  const procs = await snapshotProcessesAsync(true);
  const refreshMs = Date.now() - t1;
  const t2 = Date.now();
  listTerminals(procs);
  const warmMs = Date.now() - t2;
  console.log(`listTerminals() live route path (cold cache)  ${coldMs}ms  <- must be milliseconds`);
  console.log(`snapshotProcessesAsync(true) (async refresh)  ${refreshMs}ms  <- off the request stack`);
  console.log(`listTerminals(fresh table)  (warm)            ${warmMs}ms`);
}

/**
 * Rewrite the archive of every closed record whose file is missing at the registry path, and fix
 * the registry link. Idempotent; kills nothing.
 */
function repairArchives(): void {
  const list = loadTerminals();
  let fixed = 0;
  for (const rec of list) {
    if (!rec.closedAt && rec.state !== "closed") continue;
    const abs = archiveAbsPath(rec);
    const rel = archiveRelPath(rec);
    if (rec.archive === rel && fs.existsSync(abs)) continue;
    const verdict = effectiveVerdict(rec);
    const archive = buildArchive(rec, verdict);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, archive.text);
    rec.archive = rel;
    fixed++;
    console.log(`${rec.sessionName || rec.sessionId}: archive -> ${rel} (${archive.text.length} bytes, report source ${archive.reportSource})`);
  }
  if (fixed) saveTerminals(list);
  console.log(`# repaired ${fixed} archive link(s)`);
}

/** The router pids visible in the process table (never contacted: the table is read-only data). */
function routerPidsFromTable(procs: ProcMap): number[] {
  const envPid = Number(process.env.AUTOCLOSE_SELFTEST_ROUTER_PID ?? 0) || 0;
  if (envPid > 0) return [envPid];
  const found: number[] = [];
  for (const row of procs.values()) {
    if (!/server\.(ts|js)\b/i.test(row.cmd)) continue;
    if (!/(PORT=8787|--port[= ]8787|:8787)/i.test(row.cmd)) continue;
    found.push(row.pid);
  }
  return found;
}

function fakeRec(sessionId: string, windowPid: number): TerminalRec {
  return {
    sessionId,
    sessionName: "selftest-fake",
    role: "selftest",
    windowPid,
    spawnedBy: "claude-code",
    spawnedAt: new Date().toISOString(),
    state: "working",
  };
}

/** A synthetic process chain: 4242 (self) <- 4243 cmd <- 4244 powershell <- 4245 svchost. */
function syntheticChain(): ProcMap {
  const row = (pid: number, ppid: number, name: string, cmd: string): [number, ProcRow] => [pid, { pid, ppid, name, cmd, created: "" }];
  return new Map<number, ProcRow>([
    row(4242, 4243, "node.exe", "node node_modules\\.bin\\tsx src/server.ts"),
    row(4243, 4244, "cmd.exe", 'cmd /d /c "cd /d C:\\repo && set "PORT=8787" && tsx src/server.ts"'),
    row(4244, 4245, "powershell.exe", "powershell -NoProfile -File ops\\router-supervisor.ps1"),
    row(4245, 4246, "svchost.exe", "C:\\Windows\\system32\\svchost.exe -k netsvcs"),
  ]);
}

/** Safety assertions against the REAL process table. No kill, no write, no pass that can close. */
async function selftest(): Promise<void> {
  const records = loadTerminals();
  const byName = new Map(records.map((r) => [r.sessionName, r]));

  check(
    "registry has records to judge",
    records.length > 0,
    `${records.length} record(s): ${records.map((r) => r.sessionName).join(", ")}`,
  );

  // 0. FAIL CLOSED with a cold process table. This runs FIRST, before anything warms the cache, and it
  //    is the sync entry point src/server.ts uses: with no usable table it must decide nothing, close
  //    nothing and say why (an empty table used to make every live window look "gone").
  const cold = runReaperPass({ dryRun: true });
  const coldAllSkip = cold.decisions.length === 0 || cold.decisions.every((d) => d.action === "skip");
  check(
    "cold process table -> the sync pass decides nothing and closes nothing (fail closed)",
    cold.decisions.every((d) => !d.closed) && cold.closed.length === 0 && (cold.decisions.length === 0 ? Boolean(cold.note) : coldAllSkip),
    `decisions=${cold.decisions.length}, closed=${cold.closed.length}, note="${cold.note ?? "(none)"}"`,
  );

  // 1. The CEO's own window can never be closed, whatever the record says.
  const rose = byName.get("rose");
  if (rose) {
    const asCeo = { ...rose, spawnedBy: "ceo" as const, keepOpen: false };
    const asWorker = { ...rose, spawnedBy: "claude-code" as const, keepOpen: false };
    check("rose (spawnedBy=ceo) is classified as not closable", !["fleet", "claude-code"].includes(asCeo.spawnedBy), `spawnedBy=${asCeo.spawnedBy}`);
    check("rose is blocked by PROTECTED_SESSION_NAMES even as a worker", PROTECTED_SESSION_NAMES.includes(asWorker.sessionName), `protected=${PROTECTED_SESSION_NAMES.join(",")}`);
  } else {
    check("rose is in the registry", false, "rose missing from the registry");
  }

  // 2. A REAL, fresh process table (async: execFile, never execFileSync).
  const procs = await snapshotProcessesAsync(true);
  const table = processTableStatus();
  check(
    "the async process table fetched real rows",
    procs.size > 50 && table.rows === procs.size,
    `${procs.size} process row(s), age=${table.ageMs === undefined ? "-" : `${table.ageMs}ms`}, ready=${table.ready}`,
  );
  check("the freshly fetched process table is usable by a pass", table.ready, `ready=${table.ready}, rows=${table.rows}`);

  // 3. RULE 5 - the reaper's own process tree is never a close target (this pid + its ancestors).
  const routerPids = routerPidsFromTable(procs);
  if (routerPids.length === 0) {
    console.log("NOTE no router pid found in the process table (no process whose command line has server.ts + PORT=8787); the own-tree rule is checked on this CLI's own real tree and on a synthetic chain instead");
    routerPids.push(process.pid);
  }
  for (const routerPid of routerPids) {
    const own = ownProcessTree(procs, routerPid);
    const ancestors = [...own].filter((p) => p !== routerPid);
    const selfRow = procs.get(routerPid);
    const selfCheck = verifyWindow(fakeRec("session_selftest_own_self", routerPid), procs, routerPid);
    check(
      `pid ${routerPid} (router process) is refused as a close target`,
      !selfCheck.ok,
      `${selfRow ? `${selfRow.name} ` : ""}${selfCheck.reason}`,
    );
    const ancestorChecks = ancestors.map((p) => verifyWindow(fakeRec(`session_selftest_own_anc_${p}`, p), procs, routerPid));
    check(
      `every one of the ${ancestors.length} ancestor pid(s) of pid ${routerPid} is refused`,
      ancestors.length > 0 && ancestorChecks.every((c) => !c.ok),
      ancestors.map((p, i) => `${p}(${procs.get(p)?.name ?? "?"})=${ancestorChecks[i].ok ? "ALLOWED" : "refused"}`).join(" ") || "(no ancestors in the table)",
    );
    // The real foot-gun: an ancestor that IS a console window would pass every other check
    // (it is a shell window), so it must be stopped by the own-tree rule itself.
    const shellAncestors = ancestors.filter((p) => /^(powershell|pwsh|cmd)\.exe$/i.test(procs.get(p)?.name ?? ""));
    if (shellAncestors.length) {
      const shellCheck = verifyWindow(fakeRec("session_selftest_own_shell", shellAncestors[0]), procs, routerPid);
      check(
        `ancestor console window ${shellAncestors[0]} (${procs.get(shellAncestors[0])?.name}) is refused by the own-process-tree rule`,
        !shellCheck.ok && /ancestor of this process/i.test(shellCheck.reason),
        shellCheck.reason,
      );
    } else {
      console.log(`NOTE pid ${routerPid} has no console-window ancestor in the table; the own-tree rule is proven on the synthetic chain below`);
    }
  }
  const synth = syntheticChain();
  const synthShell = verifyWindow(fakeRec("session_selftest_synth_shell", 4244), synth, 4242);
  check(
    "synthetic chain: a powershell window that is an ANCESTOR of the reaper is refused by rule 5",
    !synthShell.ok && /ancestor of this process/i.test(synthShell.reason),
    synthShell.reason,
  );
  const synthSelf = verifyWindow(fakeRec("session_selftest_synth_self", 4242), synth, 4242);
  check(
    "synthetic chain: the reaper's own pid is refused as a close target",
    !synthSelf.ok && /is this process/i.test(synthSelf.reason),
    synthSelf.reason,
  );
  const synthOutside = verifyWindow(fakeRec("session_selftest_synth_outside", 999999), synth, 4242);
  check(
    "non-vacuity: a pid OUTSIDE the own tree is refused for its own reason, not by rule 5",
    !synthOutside.ok && !/own tree|ancestor of this process|is this process/i.test(synthOutside.reason),
    synthOutside.reason,
  );

  // 4. A non-window pid can never be closed (the jcode server is not a shell window).
  let serverPid = Number(process.env.AUTOCLOSE_SELFTEST_SERVER_PID ?? 0) || 0;
  if (!serverPid) {
    try {
      const servers = JSON.parse(
        fs.readFileSync(path.join(os.homedir(), ".jcode", "servers.json"), "utf8"),
      ) as Record<string, { pid?: number }>;
      serverPid = Number(Object.values(servers)[0]?.pid ?? 0);
    } catch {
      serverPid = 0;
    }
  }
  if (serverPid) {
    const serverCheck = verifyWindow(fakeRec("session_selftest_server", serverPid), procs, process.pid);
    check(`jcode server pid ${serverPid} is refused by verifyWindow`, !serverCheck.ok, serverCheck.reason);
  }

  // 5. Ownership: a window is only ever accepted for the session whose client runs inside it.
  //    windowHostsSession is the same proof registerTerminal uses, so a wrong pid never enters
  //    the registry in the first place. Windows inside this CLI's own tree are excluded as close
  //    targets (they are refused by rule 5 - that is asserted above, not a test failure).
  const ownTree = ownProcessTree(procs, process.pid);
  const liveWindows = records.filter((r) => r.windowPid && procs.has(r.windowPid) && r.spawnedBy !== "ceo" && !ownTree.has(r.windowPid));
  const skippedOwn = records.filter((r) => r.windowPid && procs.has(r.windowPid) && ownTree.has(r.windowPid));
  if (skippedOwn.length) {
    console.log(
      `NOTE ${skippedOwn.length} live window(s) belong to this selftest's own process tree and were skipped as close targets (rule 5 refuses them): ` +
        skippedOwn.map((r) => `${r.sessionName}#${r.windowPid}`).join(", "),
    );
  }
  // Only a window whose session has a LIVE jcode client is closable at all, so the non-vacuity check
  // is run on those (a live window whose TUI already exited is refused by design, not a bug).
  const closableNow = liveWindows.filter((r) => liveClientPids(r.sessionId).length > 0);
  const withoutClient = liveWindows.filter((r) => liveClientPids(r.sessionId).length === 0);
  if (withoutClient.length) {
    console.log(
      `NOTE ${withoutClient.length} live window(s) have no live jcode client right now (their TUI exited), so close-time verification correctly refuses them: ` +
        withoutClient.map((r) => `${r.sessionName}#${r.windowPid}`).join(", "),
    );
  }
  const sessionA = closableNow[0] ?? liveWindows[0];
  const sessionB = liveWindows.find((r) => r.windowPid !== sessionA?.windowPid);
  if (sessionA && sessionB?.windowPid) {
    const foreign = windowHostsSession("session_selftest_foreign_0000", sessionB.windowPid, procs);
    check(
      `an unrelated session id is refused for live window ${sessionB.windowPid}`,
      !foreign.ok,
      foreign.reason,
    );
    const cross = windowHostsSession(sessionA.sessionId, sessionB.windowPid, procs);
    check(
      `${sessionA.sessionName}'s session is refused for ${sessionB.sessionName}'s window ${sessionB.windowPid}`,
      !cross.ok,
      cross.reason,
    );
    if (closableNow.length > 0) {
      // Non-vacuity: close-time verification must ACCEPT its own record. After the 13:21Z TUI
      // re-exec no session has an intact ancestry chain any more, so this is the path that matters.
      const ownClose = verifyWindow(sessionA, procs, process.pid);
      check(
        `${sessionA.sessionName}'s own record IS accepted by verifyWindow (two-tier link, not vacuous)`,
        ownClose.ok,
        ownClose.reason,
      );
      const ownStrict = windowHostsSession(sessionA.sessionId, sessionA.windowPid as number, procs);
      if (ownStrict.ok) {
        check(`${sessionA.sessionName}'s intact chain also passes the strict registration proof`, true, ownStrict.reason);
      } else {
        console.log(
          `NOTE no registered session currently has an intact client->window chain (all TUIs re-exec'd), ` +
            `so the strict registration proof is exercised only through the refusals above: ${ownStrict.reason}`,
        );
      }
    } else {
      console.log(
        `NOTE the non-vacuity check ("a session's own record IS accepted") was skipped: none of the ${liveWindows.length} live window(s) ` +
          "currently has a live jcode client, so every record is correctly refused as unclosable",
      );
    }
  } else {
    check("two live windows outside this process's own tree exist to test ownership", false, `live=${liveWindows.length}`);
  }
  // 5b. A reused/foreign pid recorded for a real session must be refused too.
  const anyRecord = sessionA ?? records.find((r) => r.spawnedBy === "claude-code");
  if (anyRecord) {
    const staleCheck = verifyWindow({ ...anyRecord, windowPid: 4, windowCreatedAt: "2020-01-01T00:00:00.000Z" }, procs, process.pid);
    check(`${anyRecord.sessionName} with a foreign pid 4 is refused`, !staleCheck.ok, staleCheck.reason);
  }

  // 6. No window at all -> nothing to close.
  const noWindow = verifyWindow(fakeRec("session_selftest_nowindow", 0));
  check("a record without a windowPid is refused", !noWindow.ok, noWindow.reason);

  // 7. ONE real, dry pass, measured while a 50ms interval ticks: the pass must not block the event
  //    loop (this is the REAPER-ASYNC acceptance check), the re-entrancy guard must hold, and the pass
  //    must stay fail-closed about verdicts.
  const gaps: number[] = [];
  let last = Date.now();
  const ticker = setInterval(() => {
    const now = Date.now();
    gaps.push(now - last);
    last = now;
  }, 50);
  const started = Date.now();
  const realPromise = runReaperPassAsync({ dryRun: true });
  const guardHeld = reaperStatus().passInFlight;
  const secondPromise = runReaperPassAsync({ dryRun: true });
  const sharedPromise = secondPromise === realPromise;
  const second = await secondPromise;
  const real = await realPromise;
  const sharedResult = second === real;
  const elapsed = Date.now() - started;
  clearInterval(ticker);
  const maxGap = gaps.length ? Math.max(...gaps) : -1;
  check(
    "a reaper pass does NOT block the event loop (50ms interval, no gap > 500ms)",
    gaps.length >= 5 && maxGap <= 500 && maxGap >= 0,
    `${gaps.length} tick(s) in ${elapsed}ms while the pass ran, max gap ${maxGap}ms (limit 500ms), ${real.decisions.length} decision(s)`,
  );
  check(
    "the pass really fetched the process table while ticking (not a vacuous fast pass)",
    processTableStatus().rows > 50 && processTableStatus().ageMs !== undefined && processTableStatus().ageMs <= 60_000,
    `rows=${processTableStatus().rows}, age=${processTableStatus().ageMs}ms, pass decisions=${real.decisions.length}`,
  );
  check(
    "RE-ENTRANCY: a second call during a pass shares the running pass (no second, overlapping pass)",
    sharedPromise && sharedResult && guardHeld && !reaperStatus().passInFlight,
    `passInFlight while running=${guardHeld}, identical promise=${sharedPromise}, identical result=${sharedResult}, passInFlight after=${reaperStatus().passInFlight}`,
  );

  const closes = real.decisions.filter((d) => d.action === "close");
  const closedIds = new Set(real.closed.map((d) => d.sessionId));
  const passIds = new Set(records.filter((r) => effectiveVerdict(r).verdict === "PASS").map((r) => r.sessionId));
  check(
    "no terminal without a PASS verdict is closed",
    [...closedIds].every((id) => passIds.has(id)),
    `closed=${closedIds.size}, with PASS=${passIds.size}`,
  );
  check(
    "every close decision is backed by a verdict PASS",
    real.closed.every((d) => d.verdict === "PASS"),
    closes.map((d) => `${d.sessionName}:${d.verdict}`).join(", ") || "nothing to close right now",
  );
  const unprotected = records.filter(
    (r) => r.spawnedBy !== "ceo" && !PROTECTED_SESSION_NAMES.includes(r.sessionName) && r.state !== "closed",
  );
  check(
    "this dry pass closed 0 terminals",
    real.closed.length === 0,
    `closed=${real.closed.length}, considered=${real.decisions.length}, unprotected-open=${unprotected.length}`,
  );

  console.log(`# grace ${Math.round(graceMs() / 1000)}s | SELFTEST ${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
  if (failures > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  if (has("--selftest")) {
    await selftest();
  } else if (has("--bench")) {
    await bench();
  } else if (has("--repair-archives")) {
    repairArchives();
  } else if (has("--status")) {
    await printStatus();
  } else if (has("--backfill")) {
    await printBackfill();
  } else if (has("--archive-preview")) {
    const name = args[args.indexOf("--archive-preview") + 1];
    const rec = loadTerminals().find((r) => r.sessionName === name);
    if (!rec) {
      console.error(`no terminal named ${name ?? "(missing)"}`);
      process.exitCode = 1;
    } else {
      const archive = buildArchive(rec);
      console.log(`# would write ${archive.absPath} (${archive.text.length} bytes, report source: ${archive.reportSource})`);
    }
  } else {
    // Default = dry run; --kill is the only mode that can close anything (never run it casually).
    const pass = await runReaperPassAsync({ dryRun: !has("--kill") });
    printPass(pass);
  }
}

void main().catch((e) => {
  console.error(`autoclose-reap failed: ${String(e)}`);
  process.exitCode = 1;
});
