#!/usr/bin/env node
/**
 * Session + run bookkeeping inventory.
 *
 * Deliverable of the fleet work order `fomunictiv/WO1`:
 *   "Clean up the company's session and run bookkeeping so we stop mistaking
 *    finished journals for idle workers, and report the true live state."
 *
 * WHAT IT DOES (read-only with respect to everything that can hurt):
 *   1. walks every jcode session in %JCODE_HOME%\sessions
 *      (session_*.json + session_*.journal.jsonl),
 *   2. gathers hard evidence per session:
 *        - the journal's last-written time and the timestamp of its last line,
 *        - whether a process is actually attached (a live pid recorded in
 *          client_sessions\<pid> whose content is the session id, or a live
 *          process whose command line carries the session id),
 *        - the company's own bookkeeping (company/terminals.json,
 *          company/reports/runs/jcode_<id>.json, company/reports/terminals.jsonl),
 *   3. labels every session exactly ONE of: live | finished | failed | stale,
 *   4. writes  company/reports/session-inventory.json  (the inventory), and
 *   5. appends ONLY provably finished/failed/stale sessions to
 *      company/reports/session-archive.jsonl  (the archive ledger).
 *
 * WHAT IT DELIBERATELY NEVER DOES:
 *   - it never kills a process, never closes a terminal window and never writes
 *     company/terminals.json (the live reaper inside the router owns that file,
 *     and a second writer would lose updates);
 *   - it refuses to archive any session whose journal was written in the last
 *     10 minutes, or that has a live process attached (hard guard, see ARCHIVE_SAFE_MS);
 *   - it does not move or delete a single jcode file, so `jcode --resume <id>`
 *     keeps working for every session.
 *
 * USAGE
 *   node ops/session-bookkeeping.mjs                 # inventory + archive ledger
 *   node ops/session-bookkeeping.mjs --dry-run       # inventory only, no archive write
 *   node ops/session-bookkeeping.mjs --json          # machine-readable stdout summary
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// ── knobs ───────────────────────────────────────────────────────────────────
const ARCHIVE_SAFE_MS = Number(process.env.BOOKKEEPING_NO_TOUCH_MS || 10 * 60 * 1000); // 10 minutes
const LIVE_WINDOW_MS = Number(process.env.BOOKKEEPING_LIVE_MS || 10 * 60 * 1000); // journal write = live
const WRITE_TAIL_BYTES = 512 * 1024;
const WRITE_HEAD_BYTES = 64 * 1024;

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const JSON_OUT = args.has("--json");

const repoRoot = process.cwd();
const jcodeHome = process.env.JCODE_HOME || path.join(os.homedir(), ".jcode");
const companyRoot = process.env.COMPANY_ROOT || path.join(repoRoot, "company");
const sessionsDir = path.join(jcodeHome, "sessions");
const clientSessionsDir = path.join(jcodeHome, "client_sessions");

const now = Date.now();
const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);
const rel = (p) => path.relative(repoRoot, p).split(path.sep).join("/");

// ── tiny helpers ────────────────────────────────────────────────────────────
function readHead(file, bytes) {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.allocUnsafe(bytes);
      const n = fs.readSync(fd, buf, 0, bytes, 0);
      return buf.subarray(0, n).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function readTail(file, bytes) {
  try {
    const st = fs.statSync(file);
    const size = Math.min(st.size, bytes);
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.allocUnsafe(size);
      const n = fs.readSync(fd, buf, 0, size, st.size - size);
      return buf.subarray(0, n).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

/** Last parseable JSON line of a JSONL file (tail window, newest first). */
function lastJsonLine(file) {
  const tail = readTail(file, WRITE_TAIL_BYTES);
  if (!tail) return null;
  let text = tail;
  if (tail.length === WRITE_TAIL_BYTES) {
    const nl = tail.indexOf("\n");
    if (nl >= 0) text = tail.slice(nl + 1);
  }
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 4; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* keep looking upwards: the tail window can start mid-line */
    }
  }
  return null;
}

function firstJsonLine(file) {
  const head = readHead(file, WRITE_HEAD_BYTES);
  if (!head) return null;
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    try {
      return JSON.parse(line);
    } catch {
      return null; // the head window cut the line: give up rather than guess
    }
  }
  return null;
}

function statSafe(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

// ── evidence 1: the process table (one snapshot per run) ────────────────────
// CreationDate is formatted inside PowerShell: the CIM object serialises to a
// { value, DateTime } wrapper under ConvertTo-Json, which would stringify to
// "[object Object]" and silently break the pid-recycling check below.
function processTable() {
  const ps = [
    "-NoProfile",
    "-Command",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name," +
      "@{n='Created';e={$_.CreationDate.ToUniversalTime().ToString('o')}},CommandLine | ConvertTo-Json -Compress",
  ];
  try {
    const raw = execFileSync("powershell", ps, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
    const parsed = JSON.parse(raw || "[]");
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return new Map(
      rows
        .filter((r) => r && Number.isFinite(Number(r.ProcessId)))
        .map((r) => [
          Number(r.ProcessId),
          {
            pid: Number(r.ProcessId),
            ppid: Number(r.ParentProcessId),
            name: String(r.Name || ""),
            createdMs: Date.parse(String(r.Created || "")),
            cmd: String(r.CommandLine || ""),
          },
        ])
    );
  } catch (e) {
    process.stderr.write(`[bookkeeping] WARNING: process table unavailable (${e.message}); process evidence will be empty\n`);
    return new Map();
  }
}

// ── evidence 2: client_sessions/<pid> -> session id ────────────────────────
// IMPORTANT (measured, 2026-09-30): these files are NEVER cleaned up, and Windows
// reuses pids. A live pid whose process started AFTER the file was written cannot
// be the client the file describes - that is a recycled pid, not an attached
// session. Every hit is therefore checked against its file mtime (see attachEvidence).
function clientSessionMap() {
  /** @type {Map<string, Array<{pid:number,file:string,mtimeMs:number}>>} */
  const bySession = new Map();
  let files = [];
  try {
    files = fs.readdirSync(clientSessionsDir);
  } catch {
    return bySession;
  }
  const self = String(process.pid);
  for (const f of files) {
    if (f === self) continue; // our own client, never evidence about another session
    const pid = Number(f);
    if (!Number.isFinite(pid)) continue;
    let sid = "";
    try {
      sid = fs.readFileSync(path.join(clientSessionsDir, f), "utf8").trim();
    } catch {
      continue;
    }
    if (!sid.startsWith("session_")) continue;
    const st = statSafe(path.join(clientSessionsDir, f));
    const list = bySession.get(sid) || [];
    list.push({ pid, file: f, mtimeMs: st ? st.mtimeMs : NaN });
    bySession.set(sid, list);
  }
  return bySession;
}

/** sessionId -> the pid recorded by the shared jcode server (informational only). */
function pidRegistry(dirName) {
  const dir = path.join(jcodeHome, dirName);
  /** @type {Map<string, string>} */
  const out = new Map();
  try {
    for (const f of fs.readdirSync(dir)) {
      try {
        out.set(f, fs.readFileSync(path.join(dir, f), "utf8").trim());
      } catch {
        out.set(f, "");
      }
    }
  } catch {
    /* registry not present on this install */
  }
  return out;
}

// ── evidence 3: the company's own bookkeeping ──────────────────────────────
function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function terminalRegistry() {
  const file = path.join(companyRoot, "terminals.json");
  const list = readJsonSafe(file);
  /** @type {Map<string, any>} */
  const byId = new Map();
  if (Array.isArray(list)) for (const rec of list) if (rec?.sessionId) byId.set(String(rec.sessionId), rec);
  return { file, byId, count: byId.size };
}

function terminalCloseLog() {
  const file = path.join(companyRoot, "reports", "terminals.jsonl");
  /** @type {Map<string, any>} */
  const byId = new Map();
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec?.sessionId) byId.set(String(rec.sessionId), rec); // last line wins
      } catch {
        /* skip partial line */
      }
    }
  } catch {
    /* no close log yet */
  }
  return byId;
}

function runCards() {
  const dir = path.join(companyRoot, "reports", "runs");
  /** @type {Map<string, any>} */
  const bySession = new Map();
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return bySession;
  }
  for (const f of files) {
    if (!f.startsWith("jcode_") || !f.endsWith(".json")) continue;
    const card = readJsonSafe(path.join(dir, f));
    const sid = card?.sessionId || (f.startsWith("jcode_session_") ? f.slice("jcode_".length, -".json".length) : null);
    if (sid) bySession.set(String(sid), card);
  }
  return bySession;
}

// ── collect sessions ────────────────────────────────────────────────────────
function collectSessions() {
  let dirents = [];
  try {
    dirents = fs.readdirSync(sessionsDir);
  } catch (e) {
    throw new Error(`cannot read ${sessionsDir}: ${e.message}`);
  }
  const ids = new Set();
  for (const f of dirents) {
    const m = /^(session_[^.]+)\.json$/.exec(f);
    if (m) ids.add(m[1]);
    const j = /^(session_[^.]+)\.journal\.jsonl$/.exec(f);
    if (j) ids.add(j[1]);
    const b = /^(session_[^.]+)\.bak$/.exec(f);
    if (b) ids.add(b[1]);
  }
  return [...ids].sort();
}

const procs = processTable();
const clientMap = clientSessionMap();
const terminals = terminalRegistry();
const closes = terminalCloseLog();
const cards = runCards();
const activePids = pidRegistry("active_pids");
const streamingPids = pidRegistry("streaming_pids");
const sessionIds = collectSessions();

// A pids file is only trustworthy while the pid it names has not been reused: a
// process that started more than a minute AFTER the file was written cannot be
// the client the file describes.
const PID_REUSE_TOLERANCE_MS = 60 * 1000;
// "jcode" invoked as a program (so a stray path like ...\.jcode\sessions\... in a
// read-only probe command does not count as a client).
const JCODE_INVOKED = /(?:^|[\s"'\\/])jcode(?:\.exe)?(?=[\s"'])/i;

function attachment(id) {
  const viaClientPid = [];
  const recycled = [];
  for (const e of clientMap.get(id) || []) {
    const p = procs.get(e.pid);
    if (!p) continue; // the recorded pid is gone: stale file, no process attached
    if (Number.isFinite(p.createdMs) && Number.isFinite(e.mtimeMs) && p.createdMs > e.mtimeMs + PID_REUSE_TOLERANCE_MS) {
      recycled.push({ pid: e.pid, name: p.name, file: e.file, fileWritten: iso(e.mtimeMs), processStarted: iso(p.createdMs) });
      continue;
    }
    viaClientPid.push({ pid: e.pid, name: p.name, processStarted: iso(p.createdMs), fileWritten: iso(e.mtimeMs) });
  }
  const viaCmdline = [];
  for (const [pid, p] of procs) {
    if (pid === process.pid) continue;
    if (!p.cmd || !p.cmd.includes(id)) continue;
    if (!JCODE_INVOKED.test(p.cmd) && !/^jcode(\.exe)?$/i.test(p.name)) continue;
    viaCmdline.push({ pid, name: p.name, processStarted: iso(p.createdMs), cmd: p.cmd.slice(0, 200) });
  }
  const pids = [...new Set([...viaClientPid.map((x) => x.pid), ...viaCmdline.map((x) => x.pid)])];
  return { viaClientPid, viaCmdline, recycled, pids, attached: pids.length > 0 };
}

const records = sessionIds.map((id) => {
  const journal = path.join(sessionsDir, `${id}.journal.jsonl`);
  const sessionJson = path.join(sessionsDir, `${id}.json`);
  const jStat = statSafe(journal);
  const sStat = statSafe(sessionJson);

  const lastLine = jStat ? lastJsonLine(journal) : null;
  const head = jStat ? firstJsonLine(journal) : null;
  const meta = lastLine?.meta || head?.meta || head || null;

  const lastLineAt = lastLine?.timestamp ? Date.parse(String(lastLine.timestamp)) : NaN;
  const metaUpdatedAt = meta?.updated_at ? Date.parse(String(meta.updated_at)) : NaN;
  const metaLastActiveAt = meta?.last_active_at ? Date.parse(String(meta.last_active_at)) : NaN;
  const journalMtime = jStat ? jStat.mtimeMs : NaN;

  // newest of every "the session did something" signal we can see
  const activityMs = Math.max(
    ...[journalMtime, lastLineAt, metaUpdatedAt, metaLastActiveAt, sStat ? sStat.mtimeMs : NaN].filter((n) => Number.isFinite(n))
  );

  // process evidence
  const attach = attachment(id);
  const clientPidsAll = (clientMap.get(id) || []).map((e) => e.pid);
  const attached = attach.attached;
  const attachedPids = attach.pids;

  const journalFresh = Number.isFinite(journalMtime) && now - journalMtime <= LIVE_WINDOW_MS;
  const protectedByWrite = Number.isFinite(activityMs) && now - activityMs <= ARCHIVE_SAFE_MS;
  const serverKnows = activePids.has(id);
  const streaming = streamingPids.has(id);

  const term = terminals.byId.get(id);
  const closeRec = closes.get(id);
  const card = cards.get(id);

  return {
    id,
    shortName: meta?.short_name ?? term?.sessionName ?? null,
    title: meta?.title ?? card?.title ?? closeRec?.reportSource ?? null,
    workingDir: meta?.working_dir ?? null,
    model: meta?.model ?? null,
    journalStatus: meta?.status ?? null,
    sessionJsonExists: !!sStat,
    journalExists: !!jStat,
    journalMtime: iso(journalMtime),
    journalLastLineAt: iso(lastLineAt),
    journalMetaUpdatedAt: iso(metaUpdatedAt),
    journalMetaLastActiveAt: iso(metaLastActiveAt),
    idleMinutes: Number.isFinite(activityMs) ? Math.round((now - activityMs) / 60000) : null,
    attached,
    attachedPids,
    attachedViaClientPid: attach.viaClientPid,
    attachedViaCmdline: attach.viaCmdline,
    recycledPids: attach.recycled,
    staleClientPids: clientPidsAll.filter((p) => !procs.has(p)),
    journalFresh,
    protectedByRecentWrite: protectedByWrite,
    serverRegistry: serverKnows ? { activePidsFile: true, streaming: streaming } : { activePidsFile: false, streaming },
    terminal: term ? { state: term.state, verdict: term.verdict ?? null, spawnedBy: term.spawnedBy ?? null, keepOpen: !!term.keepOpen } : null,
    terminalClose: closeRec ? { verdict: closeRec.verdict ?? null, at: closeRec.at ?? null, reason: closeRec.reason ?? null } : null,
    runCard: card ? { state: card.state, verdict: card.verdict ?? null, updatedAt: card.updatedAt ?? null, owner: card.owner ?? null, headline: card.headline ?? null } : null,
    _activityMs: activityMs,
  };
});

// ── classify: exactly one label each, with the evidence that decided it ────
function classify(r) {
  const ev = [];
  if (r.attachedViaClientPid.length) {
    ev.push(`live process from client_sessions (${r.attachedViaClientPid.map((x) => `pid ${x.pid} ${x.name}`).join(", ")})`);
  }
  if (r.attachedViaCmdline.length) {
    ev.push(`live process whose command line invokes jcode for this session (${r.attachedViaCmdline.map((x) => `pid ${x.pid} ${x.name}`).join(", ")})`);
  }
  if (r.recycledPids.length) {
    ev.push(
      `client_sessions file(s) ${r.recycledPids.map((x) => x.file).join(", ")} point at a RECYCLED pid (${r.recycledPids
        .map((x) => `pid ${x.pid} ${x.name} started ${x.processStarted}, file written ${x.fileWritten}`)
        .join("; ")}) - not evidence of a live session`
    );
  }
  if (r.staleClientPids.length) ev.push(`stale client_sessions pid(s) ${r.staleClientPids.join(", ")} (process gone)`);
  if (r.serverRegistry.streaming) ev.push("listed in the jcode server's streaming_pids registry");
  else if (r.serverRegistry.activePidsFile) ev.push("listed in the jcode server's active_pids registry");
  if (r.journalFresh) ev.push(`journal written ${r.idleMinutes}m ago (inside the 10m no-touch window)`);

  // 1. live - a real process is attached right now (hard evidence only).
  if (r.attached) {
    return { classification: "live", reason: ev.filter((e) => !e.includes("not evidence")).join("; ") || "live process attached" };
  }

  const failedEv = [];
  if (r.runCard?.state === "failed") failedEv.push(`run card state=failed (updated ${r.runCard.updatedAt})`);
  if (r.runCard?.verdict === "FAIL") failedEv.push("run card verdict=FAIL");
  if (r.terminal?.state === "failed") failedEv.push("terminals.json state=failed");
  if (r.terminal?.verdict === "FAIL") failedEv.push("terminals.json verdict=FAIL");
  if (r.terminalClose?.verdict === "FAIL") failedEv.push("terminals close log verdict=FAIL");

  const doneEv = [];
  if (r.terminal?.state === "closed") doneEv.push(`terminals.json state=closed (verdict ${r.terminal.verdict ?? "none"})`);
  if (r.terminal?.verdict === "PASS") doneEv.push("terminals.json verdict=PASS");
  if (r.terminalClose) doneEv.push(`company close log entry (verdict ${r.terminalClose.verdict ?? "none"}, ${r.terminalClose.at})`);
  if (r.runCard?.state === "done") doneEv.push(`run card state=done (updated ${r.runCard.updatedAt})`);
  if (["Ended", "Archived", "Closed", "Exited"].includes(String(r.journalStatus))) doneEv.push(`journal meta status=${r.journalStatus}`);

  if (failedEv.length) return { classification: "failed", reason: `no process attached; ${failedEv.join("; ")}; ${ev.join("; ")}` };
  if (doneEv.length) return { classification: "finished", reason: `no process attached; ${doneEv.join("; ")}; ${ev.join("; ")}` };

  // 3. stale - nothing attached, no completion or failure evidence, and silent.
  return {
    classification: "stale",
    reason: [
      "no process attached",
      r.idleMinutes === null ? "no journal activity timestamp available" : `journal silent for ${r.idleMinutes}m`,
      "no completion evidence (no closed/PASS terminal, no done run card) and no failure evidence",
      ...ev,
    ].join("; "),
  };
}

for (const r of records) {
  const { classification, reason } = classify(r);
  r.classification = classification;
  r.reason = reason;
  r.protected = classification === "live" || r.protectedByRecentWrite;
  delete r._activityMs;
}

const totals = {
  sessions: records.length,
  live: records.filter((r) => r.classification === "live").length,
  finished: records.filter((r) => r.classification === "finished").length,
  failed: records.filter((r) => r.classification === "failed").length,
  stale: records.filter((r) => r.classification === "stale").length,
};
const archived = records.filter((r) => !r.protected);
const protectedLive = records.filter((r) => r.classification === "live");
const protectedByWriteOnly = records.filter((r) => r.classification !== "live" && r.protectedByRecentWrite);

// ── guards: refuse to write an archive that touches anything alive ─────────
const violations = archived.filter((r) => r.classification === "live" || r.attached || r.journalFresh || r.protectedByRecentWrite);
if (violations.length) {
  process.stderr.write(`[bookkeeping] ABORT: ${violations.length} archive candidate(s) failed the safety guard: ${violations.map((v) => v.id).join(", ")}\n`);
  process.exit(2);
}

// ── write the inventory ────────────────────────────────────────────────────
const inventory = {
  generatedAt: new Date(now).toISOString(),
  generatedBy: "ops/session-bookkeeping.mjs",
  workOrder: "fomunictv/WO1",
  host: os.hostname(),
  jcodeHome,
  companyRoot,
  thresholds: {
    liveWindowMinutes: LIVE_WINDOW_MS / 60000,
    noTouchMinutes: ARCHIVE_SAFE_MS / 60000,
    note: "A session with a journal write inside noTouchMinutes is never archived; a session with a live process attached is never archived and never killed.",
  },
  totals: { ...totals, archived: archived.length, liveProtected: protectedLive.length, heldByRecentWrite: protectedByWriteOnly.length },
  labels: {
    live: "A real process is attached to the session right now (a live pid recorded in client_sessions that has not been recycled, or a live process whose command line invokes jcode for this session id).",
    finished: "No process attached and the company bookkeeping shows completion (terminal closed, verdict PASS, company close-log entry, or run card state=done).",
    failed: "No process attached and the company bookkeeping shows failure (run card state=failed, verdict FAIL, or terminal state=failed).",
    stale: "No process attached, no completion or failure evidence, and the journal has been silent for more than 10 minutes.",
  },
  sessions: records.map((r) => ({
    id: r.id,
    shortName: r.shortName,
    title: typeof r.title === "string" ? r.title.slice(0, 160) : r.title,
    workingDir: r.workingDir,
    classification: r.classification,
    reason: r.reason,
    protected: r.protected,
    evidence: {
      journalPath: r.journalExists ? rel(path.join(sessionsDir, `${r.id}.journal.jsonl`)) : null,
      journalLastWrite: r.journalMtime,
      journalLastLineAt: r.journalLastLineAt,
      journalMetaUpdatedAt: r.journalMetaUpdatedAt,
      journalMetaLastActiveAt: r.journalMetaLastActiveAt,
      journalStatus: r.journalStatus,
      idleMinutes: r.idleMinutes,
      processAttached: r.attached,
      attachedPids: r.attachedPids,
      attachedViaClientPid: r.attachedViaClientPid,
      attachedViaCmdline: r.attachedViaCmdline,
      recycledPids: r.recycledPids,
      staleClientPids: r.staleClientPids,
      jcodeServerRegistry: r.serverRegistry,
      terminal: r.terminal,
      terminalClose: r.terminalClose,
      runCard: r.runCard,
    },
  })),
};

const outFile = path.join(companyRoot, "reports", "session-inventory.json");
if (!DRY_RUN) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(inventory, null, 2) + "\n");
}

// ── append the archive ledger (one line per provably non-live session) ─────
const archiveFile = path.join(companyRoot, "reports", "session-archive.jsonl");
const archiveLines = archived.map((r) =>
  JSON.stringify({
    archivedAt: new Date(now).toISOString(),
    sessionId: r.id,
    shortName: r.shortName,
    classification: r.classification,
    reason: r.reason,
    journalLastWrite: r.journalMtime,
    journalLastLineAt: r.journalLastLineAt,
    processAttached: false,
    archivedBy: "ops/session-bookkeeping.mjs",
    workOrder: "fomunictv/WO1",
    note: "Bookkeeping only. No process was killed, no window was closed, no jcode file was moved or deleted.",
  })
);
if (!DRY_RUN && archiveLines.length) {
  fs.appendFileSync(archiveFile, archiveLines.join("\n") + "\n");
}

// ── report ─────────────────────────────────────────────────────────────────
const summary = {
  generatedAt: inventory.generatedAt,
  dryRun: DRY_RUN,
  inventoryFile: DRY_RUN ? null : rel(outFile),
  archiveFile: DRY_RUN ? null : rel(archiveFile),
  newArchiveLines: DRY_RUN ? 0 : archiveLines.length,
  totals: inventory.totals,
  live: records.filter((r) => r.classification === "live").map((r) => ({ id: r.id, name: r.shortName, idleMinutes: r.idleMinutes, pids: r.attachedPids })),
  failed: records.filter((r) => r.classification === "failed").map((r) => ({ id: r.id, name: r.shortName, reason: r.reason })),
};
if (JSON_OUT) {
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
} else {
  const line = (s) => process.stdout.write(s + "\n");
  line(`# session bookkeeping ${DRY_RUN ? "(dry run)" : ""} ${summary.generatedAt}`);
  line(`# jcodeHome: ${jcodeHome}`);
  line(`# companyRoot: ${companyRoot}`);
  line(`# process table: ${procs.size} live processes; client_sessions files: ${clientMap.size} session(s) mapped`);
  line(`# sessions found: ${totals.sessions} -> live (process attached) ${totals.live}, finished ${totals.finished}, failed ${totals.failed}, stale ${totals.stale}`);
  line(`# recycled client_sessions pid(s) found (bookkeeping lies): ${records.filter((r) => r.recycledPids.length).length} session(s)`);
  line(`# archived (bookkeeping only): ${DRY_RUN ? archiveLines.length + " (dry run: not written)" : `${archiveLines.length} -> ${rel(archiveFile)}`}`);
  line(`# held by the 10-minute no-touch rule: ${protectedByWriteOnly.length}`);
  line(`# inventory: ${DRY_RUN ? "(dry run: not written)" : rel(outFile)}`);
  line("");
  line(`LIVE - process attached now (${protectedLive.length})`);
  for (const r of protectedLive) line(`  ${r.id} [${r.shortName ?? "?"}] idle ${r.idleMinutes}m pids=${r.attachedPids.join(",") || "none"}`);
  line("");
  if (protectedByWriteOnly.length) {
    line(`HELD (${protectedByWriteOnly.length}) - not live, but journal written within 10m, so untouched`);
    for (const r of protectedByWriteOnly) line(`  ${r.id} [${r.shortName ?? "?"}] ${r.classification} idle ${r.idleMinutes}m`);
    line("");
  }
  line(`FAILED (${totals.failed})`);
  for (const r of records.filter((x) => x.classification === "failed")) line(`  ${r.id} [${r.shortName ?? "?"}] ${r.reason}`);
  line("");
  line(`ARCHIVED (${archived.length}) - bookkeeping ledger only, nothing killed`);
  for (const r of archived) line(`  ${r.id} [${r.shortName ?? "?"}] ${r.classification}`);
}

if (DRY_RUN) process.stderr.write("[bookkeeping] dry run: no file was written and no ledger line was appended\n");
