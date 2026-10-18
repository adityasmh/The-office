/**
 * ops/sessions-check.ts - verification harness for Order F2-sessions-board.
 *
 * Problem: GET /company/panel `sessions` rows showed all fields empty while
 * tasks run. This harness reproduces the session -> panel pipeline end to end
 * against a THROWAWAY COMPANY_ROOT (temp folder, real company/ data never
 * touched, no router, no network, .env never read) and checks:
 *
 *   (a) startSession row appears in the panel payload with ALL ten fields filled
 *       (agentId/agentName, role, departmentId/Name, projectId/Name,
 *       taskId/taskTitle, model, status, pid after updateSession, startedAt,
 *       costUsd)
 *   (b) updateSession status change is visible in the panel payload
 *   (c) finishSession(done, costUsd) stays listed as done with the cost, also
 *       after __resetSessionsForTest + replay from the jsonl
 *   (d) an old-format jsonl line (aliases agent, title, started, cost, task,
 *       status "success") loads, and blank/corrupt lines are skipped without
 *       error
 *   (e) reconcileStaleSessions marks a running session with a dead pid
 *       (2147483646) as error/[stale:...] and leaves a live-pid session running
 *   (f) updateSession on an unknown id returns undefined without crashing, and
 *       a cost patch arriving after finish does not blank the other fields
 *
 * Run:  npx tsx ops/sessions-check.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── throwaway root: MUST be set before org.ts is imported (org.ts captures
// COMPANY_ROOT at import time). No dotenv import: .env is never read here. ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-check-"));
process.env.COMPANY_ROOT = path.join(tmp, "company");
// Hermetic: make the optional provider/CLI seams inert so nothing ever fetches
// or spawns CLI quota reads through the panel build.
process.env.OPENCODE_API_KEY = "";
process.env.OPENCODE_SESSION_COOKIE = "";
process.env.DEEPSEEK_API_KEY = "";
process.env.SLACK_BOT_TOKEN = "";

// Type-only imports: erased at runtime, so they do NOT load the module before
// the env var is set.
import type { SessionContext, SessionRec } from "../src/company/sessions.js";
import type { PanelPayload } from "../src/company/panel.js";

// Imported AFTER COMPANY_ROOT is set.
const companyRoot = process.env.COMPANY_ROOT!;
const sessionsMod = await import("../src/company/sessions.js");
const panelMod = await import("../src/company/panel.js");
const orgMod = await import("../src/company/org.js");

const {
  startSession, updateSession, finishSession,
  reconcileStaleSessions,
} = sessionsMod;
// Test seams are part of the F2 registry; against older code they may be absent.
// Degrade to no-ops so the harness can still diagnose a pre-fix build (the
// checks that need a true replay then read the already-loaded store).
const __resetSessionsForTest: () => void =
  typeof (sessionsMod as { __resetSessionsForTest?: () => void }).__resetSessionsForTest === "function"
    ? (sessionsMod as { __resetSessionsForTest: () => void }).__resetSessionsForTest
    : () => undefined;
const __setPidStartTimeForTest: (pid: number, ms: number | undefined) => void =
  typeof (sessionsMod as { __setPidStartTimeForTest?: (pid: number, ms: number | undefined) => void }).__setPidStartTimeForTest === "function"
    ? (sessionsMod as { __setPidStartTimeForTest: (pid: number, ms: number | undefined) => void }).__setPidStartTimeForTest
    : () => undefined;
const { buildPanelData } = panelMod;
const { createProject } = orgMod;

// ── seed a minimal but REAL org in the temp root (org.json lives only there) ──
const seeded = createProject({
  companyName: "Sessions Check Co",
  departmentName: "Engineering",
  projectName: "Check Project",
  description: "throwaway",
  coderCount: 1,
});
const agent = seeded.project.teams[0]?.agents.find((a) => a.id === "coder-1")!;

if (!fs.existsSync(companyRoot) && !fs.existsSync(path.join(companyRoot, "org.json"))) {
  console.error(`FAIL  setup: expected seeded org.json at ${companyRoot}/org.json`);
  process.exit(1);
}

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) failures++;
};

const peach = (payload: PanelPayload, id: string) =>
  payload.sessions.items.find((s) => s.id === id) as (SessionRec & { id: string }) | undefined;

const filled = (s: Record<string, unknown>): string[] => {
  const missing: string[] = [];
  const req: Array<[string, unknown]> = [
    ["agentId", s.agentId], ["agentName", s.agentName], ["role", s.role],
    ["departmentId", s.departmentId], ["departmentName", s.departmentName],
    ["projectId", s.projectId], ["projectName", s.projectName],
    ["taskId", s.taskId], ["taskTitle", s.taskTitle], ["model", s.model],
    ["status", s.status], ["pid", s.pid], ["startedAt", s.startedAt],
  ];
  for (const [k, v] of req) {
    if (v === undefined || v === null || (typeof v === "string" && v.length === 0)) missing.push(k);
  }
  if (typeof s.costUsd !== "number") missing.push("costUsd(number)");
  return missing;
};

const ctx: SessionContext = {
  agentId: agent.id,
  agentName: agent.name,
  role: agent.role,
  departmentId: seeded.project.departmentId,
  departmentName: "Engineering",
  projectId: seeded.project.id,
  projectName: seeded.project.name,
  taskId: "t-check",
  taskTitle: "Check task for the sessions board",
  model: agent.modelId,
  runtime: "opencode",
};

// warm the pid start-time seam so reconcile never spawns PowerShell Get-Process
__setPidStartTimeForTest(process.pid, Date.now() - 60_000);

// ── (a) startSession row in the panel payload with all fields ────────────────
const started = startSession(ctx);
check("(a0) startSession returns a running record", started.status === "running" && !!started.id, JSON.stringify(started).slice(0, 200));

const rec = updateSession(started.id, { pid: process.pid }); // pid attach, as workers.ts does
check("(a1) updateSession attaches the pid without changing the rest", !!rec && rec?.status === "running" && rec?.agentName === agent.name, JSON.stringify(rec ?? null).slice(0, 200));

const p1 = buildPanelData(false);
const row1 = peach(p1, started.id);
check("(a2) panel payload lists the started session", !!row1, "not found in sessions.items");
if (row1) {
  const missing = filled(row1);
  check("(a3) all ten panel fields are filled", missing.length === 0, `missing: ${missing.join(", ")}. row=${JSON.stringify(row1).slice(0, 400)}`);
  check("(a4) panel pid matches the opencode child pid", row1.pid === process.pid, String(row1.pid));
}

// ── (b) updateSession status change visible in the panel ─────────────────────
const upd = updateSession(started.id, { status: "queued" });
if (!upd) check("(b) updateSession applied", false, "updateSession returned undefined");
else {
  const p2 = buildPanelData(false);
  const row2 = peach(p2, started.id);
  check("(b) status change (running -> queued) visible in the panel", !!row2 && (row2 as { status?: string }).status === "queued",
    `status=${row2?.status ?? "(row missing)"}`);
  buildPanelData(false); // leave the registry sane
}

// ── (c) finishSession(done, costUsd) stays listed, incl. replay from jsonl ──
const fin = finishSession(started.id, "done", { costUsd: 0.0123, text: "final line" });
check("(c1) finishSession marks the row done with the cost", !!fin && fin.status === "done" && fin.costUsd === 0.0123,
  JSON.stringify(fin ?? null).slice(0, 200));

const p3 = buildPanelData(false);
const row3 = peach(p3, started.id);
check("(c2) finished row still listed as done with cost", !!row3 && row3.status === "done" && row3.costUsd === 0.0123,
  `row=${JSON.stringify(row3 ?? null).slice(0, 300)}`);

// replay from the jsonl after a full module reset (server-restart simulation)
__resetSessionsForTest();
const p4 = buildPanelData(false);
const row4 = peach(p4, started.id);
check("(c3) after reset+replay the finished row persists (done, cost, identity)",
  !!row4 && row4.status === "done" && row4.costUsd === 0.0123 && row4.agentName === agent.name && row4.taskTitle !== "",
  `row=${JSON.stringify(row4 ?? null).slice(0, 300)}`);

// ── (d) old-format line + blank + corrupt lines all survive ──────────────────
const oldId = `sold-${Date.now().toString(36)}`;
const oldLine = JSON.stringify({
  id: oldId,
  agent: "tester",
  title: "old-format smoke",           // alias of taskTitle
  started: "2026-01-02T03:04:05.000Z", // alias of startedAt
  cost: 0.5,                           // alias of costUsd
  task: "t-old",                       // alias of taskId
  status: "success",                   // alias of done
  model: "glm-old",
  deptId: seeded.project.departmentId, // legacy department alias
  deptName: "Engineering",
  projId: seeded.project.id,           // legacy project alias
  projName: seeded.project.name,
});
fs.appendFileSync(path.join(companyRoot, "sessions.jsonl"), "\n" + oldLine + "\nnot json at all{\n" + "\n");
__resetSessionsForTest();
const p5 = buildPanelData(false);
const row5 = peach(p5, oldId);
check("(d1) old-format line loads with aliases mapped", !!row5 && row5.status === "done" && row5.costUsd === 0.5 &&
  row5.agentId === "tester" && (row5 as { agentName?: string }).agentName === "tester" && row5.taskTitle === "old-format smoke" &&
  row5.startedAt === "2026-01-02T03:04:05.000Z" && row5.taskId === "t-old",
  `row=${JSON.stringify(row5 ?? null).slice(0, 300)}`);
check("(d2) blank and corrupt lines skipped, no error, payload still builds", Array.isArray(p5.sessions.items) && p5.sessions.total >= 1, "");

// ── (e) reconcileStaleSessions: dead pid -> error/[stale:]; live pid untouched ──
__resetSessionsForTest();
const staleAgent = seeded.project.teams[0]?.agents.find((a) => a.id === "manager")!;
const staleCtx = { ...ctx, agentId: staleAgent.id, agentName: staleAgent.name, role: staleAgent.role, model: staleAgent.model };
const live = startSession(staleCtx);
updateSession(live.id, { pid: process.pid });
const dead = startSession({ ...staleCtx, agentId: "coder-1", agentName: agent.name, role: "coder", model: agent.modelId });
updateSession(dead.id, { pid: 2147483646 });

const fixed = reconcileStaleSessions("sessions-check probe");
const rowLive = peachAsRec(live.id);
const rowDead = peachAsRec(dead.id);
check("(e1) live-pid session left running by reconcile", rowLive?.status === "running" && !String(rowLive?.lastText ?? "").includes("[stale:"),
  `live row=${JSON.stringify(rowLive ?? null).slice(0, 250)}`);
check("(e2) dead-pid session marked error/[stale:]", fixed >= 1 && rowDead?.status === "error" && String(rowDead?.lastText ?? "").includes("[stale:"),
  `fixed=${fixed}, row=${JSON.stringify(rowDead ?? null).slice(0, 250)}`);

function peachAsRec(id: string): SessionRec | undefined {
  const payload = buildPanelData(false);
  return peach(payload, id);
}

// ── (f) unknown-id update + cost-after-finish must not blank fields ─────────
const unknown = updateSession("s-ghost-does-not-exist", { pid: 1, costUsd: 9 });
check("(f1) updateSession on an unknown id returns undefined", unknown === undefined, String(unknown));

const revived = startSession({ ...ctx, taskId: "t-after", taskTitle: "cost after finish", agentId: "coder-1", agentName: agent.name, role: "coder", model: agent.modelId });
finishSession(revived.id, "done", { costUsd: 0.05 });
const late = updateSession(revived.id, { costUsd: 0.09 });
const row6 = peach(buildPanelData(false), revived.id);
const intact = !!row6 && row6.status === "done" && row6.agentName === agent.name && row6.role === "coder" &&
  row6.departmentName === "Engineering" && row6.projectName === seeded.project.name &&
  row6.taskTitle === "cost after finish" && row6.model === agent.modelId && row6.startedAt !== "" &&
  row6.costUsd === 0.09;
check("(f2) late cost patch updates cost and does not blank other fields", intact,
  `late=${JSON.stringify(late ?? null).slice(0, 160)}, row=${JSON.stringify(row6 ?? null).slice(0, 300)}`);

// ── verdict ──────────────────────────────────────────────────────────────────
console.log(failures === 0 ? "\nVERDICT: PASS (all checks green)" : `\nVERDICT: FAIL (${failures} check(s) failed)`);
process.exitCode = failures === 0 ? 0 : 1;
