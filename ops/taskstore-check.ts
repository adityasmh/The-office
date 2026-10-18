import "./sandbox-company-root.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createTaskStore, cachedByMtime, pruneBackups, backupName } from "../src/company/taskstore.js";
import { readTailLines } from "../src/company/org.js";
import { loadTasks, createTask, updateTask, getTask } from "../src/company/gates.js";
import type { TaskRec } from "../src/company/gates.js";

// Proof for order RP1-router-perf. Temp folders only: COMPANY_ROOT is a fresh
// mkdtemp from ./sandbox-company-root.js (first import, before org.ts runs).

const sandboxRoot = process.env.COMPANY_ROOT ?? "";
if (!sandboxRoot) {
  console.log("FAIL sandbox root not set");
  process.exit(1);
}

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

function freshDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(sandboxRoot, `${name}-`));
  return dir;
}

const NOW = Date.now();

function bigTask(i: number, status: TaskRec["status"], ageMs = 0): TaskRec {
  const when = new Date(NOW - ageMs).toISOString();
  return {
    id: `t${i}`,
    projectId: "p1",
    rawRequest: `fake request ${i}`,
    status,
    gates: { intake: true, code: true, merge: true },
    createdAt: when,
    updatedAt: when,
    loopCount: 0,
    result: "x".repeat(27000),
  };
}

// --------------------------------------------------------------- 1. batching
async function checkBatching(): Promise<void> {
  const root = freshDir("batch");
  const projectDir = path.join(root, "projects", "p1");
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, "tasks.json");
  const tasks = Array.from({ length: 300 }, (_, i) => bigTask(i, "coding"));
  fs.writeFileSync(file, JSON.stringify(tasks, null, 2));
  const fixtureSize = fs.statSync(file).size;

  let writes = 0;
  let renames = 0;
  const injected = {
    writeFile: async (target: string, data: string) => {
      writes++;
      await fsp.writeFile(target, data);
    },
    rename: async (from: string, to: string) => {
      renames++;
      await fsp.rename(from, to);
    },
  };

  const store = createTaskStore({ root: () => root, fs: injected, premigration: false });
  const first = store.list("p1");
  check("300-task fixture loads", first.length === 300, `got ${first.length}`);
  check("fixture is roughly 27 KB/task", fixtureSize > 7_000_000 && fixtureSize < 9_000_000, `${fixtureSize} bytes`);

  // Load once per process: change the file behind the store, the cache must win.
  fs.writeFileSync(file, "[]");
  check("loads tasks.json once per process", store.list("p1").length === 300);

  const beforeKeys = JSON.stringify(Object.keys(tasks[0]).sort());
  for (let i = 0; i < 1000; i++) {
    store.update("p1", `t${i % 300}`, { loopCount: i });
  }
  await store.flush("p1");

  check("1000 updates collapse to a handful of writes", writes <= 5, `${writes} writes / ${renames} renames`);
  const content = fs.readFileSync(file, "utf8");
  let parsed: unknown = null;
  let valid = true;
  try {
    parsed = JSON.parse(content);
  } catch {
    valid = false;
  }
  check("written file is valid JSON", valid);
  const inMemory = store.list("p1");
  check("written file is compact (no pretty print)", !content.includes("\n"), `${content.length} chars`);
  check("written file equals in-memory state", JSON.stringify(parsed) === JSON.stringify(inMemory));
  check("no half-written file left behind", !fs.existsSync(`${file}.tmp`));
  const afterKeys = JSON.stringify(Object.keys(store.get("p1", "t0") ?? {}).sort());
  check("caller result shape unchanged (Object.keys)", beforeKeys === afterKeys, `${beforeKeys} vs ${afterKeys}`);
}

// ------------------------------------------------- 2. simulated crash / rename
async function checkCrash(): Promise<void> {
  const root = freshDir("crash");
  const projectDir = path.join(root, "projects", "p1");
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, "tasks.json");
  const tasks = [bigTask(1, "coding"), bigTask(2, "coding")];
  const fixture = JSON.stringify(tasks);
  fs.writeFileSync(file, fixture);

  let crashed = false;
  const injected = {
    rename: async (from: string, to: string) => {
      if (to.endsWith("tasks.json") && !crashed) {
        crashed = true;
        throw new Error("simulated crash between temp write and rename");
      }
      await fsp.rename(from, to);
    },
  };
  const store = createTaskStore({ root: () => root, fs: injected, premigration: true });
  store.list("p1");
  store.update("p1", "t1", { loopCount: 7 });
  await store.flush("p1");

  const onDisk = fs.readFileSync(file, "utf8");
  check("crash before rename leaves previous file intact", onDisk === fixture);
  const backups = fs.readdirSync(projectDir).filter((e) => e.startsWith("tasks.json.premigration."));
  check("premigration copy written once before first load", backups.length === 1, `${backups.length} copies`);
  // A second store on the same project must not add another premigration copy.
  const store2 = createTaskStore({ root: () => root, premigration: true });
  store2.list("p1");
  const backups2 = fs.readdirSync(projectDir).filter((e) => e.startsWith("tasks.json.premigration."));
  check("premigration copy only once", backups2.length === 1, `${backups2.length} copies`);
}

// ------------------------------------------------------------ 3. archive rules
async function checkArchive(): Promise<void> {
  const root = freshDir("archive");
  const projectDir = path.join(root, "projects", "p1");
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, "tasks.json");

  const OLD = 2 * 60 * 60 * 1000;
  const all: TaskRec[] = [
    bigTask(1, "coding"),
    bigTask(2, "planned"),
    bigTask(3, "pending_merge"),
    bigTask(4, "merged"),
    bigTask(5, "failed"),
    bigTask(6, "merged", OLD),
    bigTask(7, "failed", OLD),
    bigTask(8, "merged", OLD),
    bigTask(9, "failed", OLD),
    bigTask(10, "coding", OLD),
  ];
  fs.writeFileSync(file, JSON.stringify(all));

  const store = createTaskStore({ root: () => root, premigration: false });
  const active = store.list("p1");
  const activeIds = new Set(active.map((t) => t.id));
  const activeIdsStr = [...activeIds].sort().join(",");
  check("archive leaves recent finished tasks active", activeIds.has("t4") && activeIds.has("t5"));
  check("archive leaves old unfinished tasks active", activeIds.has("t10"));
  check(
    "archive moves only old finished tasks",
    !activeIds.has("t6") && !activeIds.has("t7") && !activeIds.has("t8") && !activeIds.has("t9"),
    activeIdsStr,
  );
  check("active list has 6 tasks", active.length === 6, `${active.length}`);
  const withArchive = store.list("p1", true);
  check("list(includeArchive) returns every task", withArchive.length === 10, `${withArchive.length}`);
  await store.flush("p1");
  const archiveLines = fs.readFileSync(path.join(projectDir, "tasks-archive.jsonl"), "utf8").trim().split("\n");
  check("archive file has the 4 moved tasks", archiveLines.length === 4, `${archiveLines.length}`);
  const persisted = JSON.parse(fs.readFileSync(file, "utf8")) as TaskRec[];
  check("persisted active file has 6 tasks", persisted.length === 6, `${persisted.length}`);
}

// ------------------------------------------------------- 4. gates integration
async function checkGates(): Promise<void> {
  const projectDir = path.join(sandboxRoot, "projects", "pgate");
  fs.mkdirSync(projectDir, { recursive: true });
  const OLD = 2 * 60 * 60 * 1000;
  const all: TaskRec[] = [
    bigTask(1, "coding"),
    bigTask(2, "merged"),
    bigTask(3, "merged", OLD),
    bigTask(4, "failed", OLD),
  ];
  fs.writeFileSync(path.join(projectDir, "tasks.json"), JSON.stringify(all));

  const active = loadTasks("pgate");
  check("loadTasks default returns the active list", active.length === 2, `${active.length}`);
  const everything = loadTasks("pgate", true);
  check("loadTasks(includeArchive) returns all tasks", everything.length === 4, `${everything.length}`);

  const created = createTask("pgate", "fake request from check");
  const created2 = updateTask("pgate", created.id, { status: "enhancing", loopCount: 1 });
  const readBack = getTask("pgate", created.id);
  const keys = JSON.stringify(Object.keys(readBack ?? {}).sort());
  check(
    "create/update/get keep the task shape",
    created2.status === "enhancing" && readBack?.loopCount === 1 && keys.includes("rawRequest") && keys.includes("gates"),
  );

  // flush through the default store so the file reflects the changes
  const { taskStore } = await import("../src/company/taskstore.js");
  await taskStore().flush("pgate");
  const onDisk = JSON.parse(fs.readFileSync(path.join(projectDir, "tasks.json"), "utf8")) as TaskRec[];
  check("gates writes go through the store", onDisk.some((t) => t.id === created.id), `${onDisk.length} tasks`);
}

// ------------------------------------------------------- 5. thread tail read
function checkThreadTail(): void {
  const dir = freshDir("thread");
  const file = path.join(dir, "thread.jsonl");
  const lines: string[] = [];
  for (let i = 0; i < 6000; i++) lines.push(JSON.stringify({ i, agent: "Laya", role: "manager", kind: "note", text: "y".repeat(850) }));
  fs.writeFileSync(file, lines.join("\n") + "\n");
  const size = fs.statSync(file).size;
  check("thread fixture is about 5 MB", size >= 5_000_000, `${size} bytes`);

  const start = process.hrtime.bigint();
  const tail = readTailLines(file, 200);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  check("thread tail reader returns 200 lines", tail.length === 200, `${tail.length}`);
  const last = JSON.parse(tail[tail.length - 1]) as { i: number };
  const first = JSON.parse(tail[0]) as { i: number };
  check("thread tail reader returns the LAST 200 lines", last.i === 5999 && first.i === 5800, `${first.i}..${last.i}`);
  check("thread tail reader under 50 ms", ms < 50, `${ms.toFixed(1)} ms`);
}

// ------------------------------------------------------- 6. knowledge cache
function checkKnowledgeCache(): void {
  const dir = freshDir("knowledge");
  const file = path.join(dir, "knowledge.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, digest: "first" }));

  const load = () => JSON.parse(fs.readFileSync(file, "utf8")) as { version: number; digest: string };
  const a = cachedByMtime(file, load);
  const b = cachedByMtime(file, load);
  check("knowledge cache returns the same object until the file changes", a === b);

  fs.writeFileSync(file, JSON.stringify({ version: 1, digest: "second" }));
  const future = new Date(Date.now() + 3000);
  fs.utimesSync(file, future, future);
  const c = cachedByMtime(file, load);
  check("knowledge cache rebuilds after the file changes", c !== a && c.digest === "second");
}

// ------------------------------------------------------- 7. backup retention
function checkBackups(): void {
  const dir = freshDir("backups");
  const file = path.join(dir, "sessions.jsonl");
  fs.writeFileSync(file, "{}");
  for (let i = 0; i < 5; i++) {
    const name = backupName(file, new Date(NOW - i * 1000));
    fs.writeFileSync(name, `backup ${i}`);
  }
  const before = fs.readdirSync(dir).filter((e) => e.startsWith("sessions.jsonl.backup."));
  const removed = pruneBackups(file, 3);
  const after = fs.readdirSync(dir).filter((e) => e.startsWith("sessions.jsonl.backup."));
  check("backup retention keeps exactly 3", before.length === 5 && after.length === 3, `${before.length} -> ${after.length}`);
  check("backup retention deletes the 2 oldest", removed.length === 2);
}

async function main(): Promise<void> {
  await checkBatching();
  await checkCrash();
  await checkArchive();
  await checkGates();
  checkThreadTail();
  checkKnowledgeCache();
  checkBackups();

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}

void main();
