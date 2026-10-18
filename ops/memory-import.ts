// ops/memory-import.ts
//
// One-off, rerunnable, idempotent import into the company memory
// (company/memory/**, see docs/MEMORY_SPEC.md section 4). Every source item gets a
// DETERMINISTIC note id, so a second run updates the same notes instead of
// duplicating them.
//
// Sources:
//   1. Claude Code's project memory (<user>/.claude/projects/<slug>/memory/*.md,
//      MEMORY.md skipped) -> imported/ (the manager's standing rules).
//   2. docs/AGENT_COORDINATION.md log entries -> decisions / failures (summarised).
//   3. company/assistant.jsonl -> CEO decisions and preferences stated in chat.
//   4. company/projects/*/tasks.json -> run-outcome (merged) / failure notes.
//
// Usage:
//   npx tsx ops/memory-import.ts                 # import, then rebuild the graph
//   npx tsx ops/memory-import.ts --dry           # report only, write nothing
//   npx tsx ops/memory-import.ts --no-rebuild    # import, skip the graphify rebuild
//
// Safe to run against the live company/ (that IS the point: this is the memory's
// own store). It starts no server and touches no other module's data.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { getCompanyRoot } from "../src/company/org.js";
import { memoryStatus, rebuildGraph, remember, slugify, type MemoryNoteType } from "../src/company/memory.js";

const DRY = process.argv.includes("--dry");
const NO_REBUILD = process.argv.includes("--no-rebuild");

type Pending = {
  type: MemoryNoteType;
  title: string;
  body: string;
  source: string;
  projects?: string[];
  tags?: string[];
  id: string;
  folder?: string;
  date?: string;
};

const pending: Pending[] = [];
const skipped: string[] = [];

function flat(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function clip(s: string, n: number): string {
  const t = flat(s);
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function shortHash(s: string): string {
  return crypto.createHash("sha1").update(flat(s).toLowerCase()).digest("hex").slice(0, 10);
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readJson<T>(file: string): T | null {
  const t = readText(file);
  if (t === null) return null;
  try {
    return JSON.parse(t) as T;
  } catch {
    return null;
  }
}

function push(p: Pending): void {
  if (!p.title && !p.body) return;
  pending.push(p);
}

// ---------------------------------------------------------------- 1. claude memory

function claudeMemoryDir(): string {
  if (process.env.CLAUDE_MEMORY_DIR) return process.env.CLAUDE_MEMORY_DIR;
  const slug = path.resolve(process.cwd()).replace(/[^A-Za-z0-9]/g, "-");
  return path.join(os.homedir(), ".claude", "projects", slug, "memory");
}

function importClaudeMemory(): void {
  const dir = claudeMemoryDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md") && f.toUpperCase() !== "MEMORY.MD");
  } catch {
    skipped.push(`claude memory: not found (${dir})`);
    return;
  }
  for (const name of entries) {
    const file = path.join(dir, name);
    const text = readText(file);
    if (!text) continue;
    const fm: Record<string, string> = {};
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
    const bodyText = m ? m[2] : text;
    if (m) {
      for (const line of m[1].split(/\r?\n/)) {
        const i = line.indexOf(":");
        if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      }
    }
    const nameKey = fm.name || path.basename(name, ".md");
    const title = clip(fm.description || nameKey, 200);
    // These are the manager's standing rules (metadata.type: feedback), so they land
    // as preferences tagged "feedback" - a standing instruction, not a one-off fact.
    push({
      type: "preference",
      id: `claude-${slugify(nameKey)}`,
      title,
      body: `${bodyText.trim()}\n\n(imported from Claude Code project memory: ${file})`,
      source: "claude-code",
      folder: "imported",
      tags: ["imported", "claude-code", (fm.type || "memory").toLowerCase()],
      date: fm.modified,
    });
  }
}

// ---------------------------------------------------------------- 2. coordination log

function importCoordinationLog(): void {
  const file = path.join(process.cwd(), "docs", "AGENT_COORDINATION.md");
  const text = readText(file);
  if (text === null) {
    skipped.push(`coordination log: not found (${file})`);
    return;
  }
  const idx = text.indexOf("\n## Log");
  const log = idx >= 0 ? text.slice(idx) : text;
  // One entry per top-level bullet; the rest of each bullet is continuation.
  const chunks = log
    .split(/\r?\n(?=- )/)
    .map((c) => c.replace(/^- /, "").trim())
    .filter((c) => c.length > 40);

  for (const chunk of chunks) {
    const head = chunk.split(/\r?\n/)[0];
    if (!/^\d{1,2}:\d{2}\s/.test(head)) continue; // "HH:MM who: ..." entries only
    const who = /^\d{1,2}:\d{2}\s+([^:]{2,60}):/.exec(head)?.[1]?.trim() ?? "unknown";
    // Deliberately narrow: an entry only becomes a failure note when it really
    // reports a problem ("one unverified link" is a caveat, not a failure).
    const isFailure =
      /\b(failed|failure|blocker|incident|root cause|root-caused|crash(ed)?|regress(ed|ion)?|broke|broken|error:|exception|threw)\b/i.test(chunk) &&
      !/\b0 failed|no failures|nothing failed\b/i.test(chunk);
    const sentences = flat(chunk).split(/(?<=\.)\s+/);
    const summary = clip(sentences.slice(0, 3).join(" "), 900);
    push({
      type: isFailure ? "failure" : "decision",
      id: `coord-${shortHash(chunk)}`,
      title: clip(head.replace(/^\d{1,2}:\d{2}\s+/, ""), 200),
      body:
        `${summary}\n\n**Why:** the coordination log records this as a ${isFailure ? "problem/lesson" : "decision"} ` +
        `made by ${who}.\n**How to apply:** read docs/AGENT_COORDINATION.md for the full entry before repeating this work.\n\n` +
        `(entry by ${who}, imported from docs/AGENT_COORDINATION.md)`,
      source: "coordination-log",
      tags: ["coordination", slugify(who)],
      date: undefined,
    });
  }
}

// ---------------------------------------------------------------- 3. assistant chat

type AssistantLine = { ts?: string; role?: string; text?: string; tasks?: string[] };

function importAssistantChat(): void {
  const file = path.join(getCompanyRoot(), "assistant.jsonl");
  const text = readText(file);
  if (text === null) {
    skipped.push(`assistant chat: not found (${file})`);
    return;
  }
  const POLICY =
    /(\bprefer\b|\balways\b|\bnever\b|\bonly\b|\bdon'?t\b|\bdo not\b|\bmust\b|\bcheap(er|est)\b|\bremember\b|\bi want\b|\bwe should\b|\bkeep\b.*\bvisible\b|\bparallel\b|\bauto-?close\b|\bno more than\b|\bfrom now on\b)/i;

  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let obj: AssistantLine;
    try {
      obj = JSON.parse(t) as AssistantLine;
    } catch {
      continue;
    }
    if (obj.role !== "ceo" || !obj.text) continue;
    if (!POLICY.test(obj.text)) continue;
    const isPref = /(\bprefer\b|\balways\b|\bnever\b|\bdon'?t\b|\bdo not\b|\bi want\b|\bcheap(er|est)\b|\bremember\b)/i.test(obj.text);
    push({
      type: isPref ? "preference" : "decision",
      id: `ceo-${shortHash(obj.text)}`,
      title: clip(obj.text, 200),
      body: `${clip(obj.text, 1200)}\n\n**Why:** stated by the CEO in the company assistant chat.\n**How to apply:** treat it as a standing ${isPref ? "preference" : "decision"} until the CEO changes it.`,
      source: "assistant-thread",
      tags: ["ceo", "chat"],
      date: obj.ts,
    });
  }
}

// ---------------------------------------------------------------- 4. tasks

type TaskLike = {
  id?: string;
  projectId?: string;
  rawRequest?: string;
  status?: string;
  result?: unknown;
  error?: string;
  createdAt?: string;
  updatedAt?: string;
  trace?: unknown[];
  loopCount?: number;
};

function summariseResult(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return clip(result, 600);
  try {
    const o = result as Record<string, unknown>;
    const bits: string[] = [];
    for (const key of ["summary", "text", "answer", "files", "merged", "verdict", "notes"]) {
      const v = o[key];
      if (typeof v === "string" && v.trim()) bits.push(`${key}: ${clip(v, 300)}`);
      else if (Array.isArray(v) && v.length) bits.push(`${key}: ${clip(v.map((x) => String(x)).join(", "), 300)}`);
    }
    return bits.length ? bits.join("; ") : clip(JSON.stringify(o), 600);
  } catch {
    return "";
  }
}

function importTasks(): void {
  const projectsDir = path.join(getCompanyRoot(), "projects");
  let ids: string[];
  try {
    ids = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    skipped.push(`tasks: no projects dir (${projectsDir})`);
    return;
  }
  for (const projectId of ids) {
    const file = path.join(projectsDir, projectId, "tasks.json");
    const raw = readJson<TaskLike[] | { tasks?: TaskLike[] }>(file);
    const tasks = Array.isArray(raw) ? raw : Array.isArray(raw?.tasks) ? raw.tasks : [];
    for (const task of tasks) {
      if (!task?.id) continue;
      const status = String(task.status ?? "");
      if (status !== "merged" && status !== "failed") continue;
      const request = clip(task.rawRequest ?? "(no request recorded)", 400);
      const detail = status === "failed"
        ? `Failed: ${clip(task.error ?? "no reason recorded", 500)}`
        : `Merged. ${summariseResult(task.result) || "no result summary recorded"}`;
      push({
        type: status === "failed" ? "failure" : "run-outcome",
        id: `run-${projectId}-${task.id}`,
        title: `${status === "failed" ? "Failed" : "Shipped"}: ${clip(request, 140)}`,
        body:
          `**Request:** ${request}\n\n**Outcome:** ${detail}\n\n` +
          `Project: ${projectId}  Task: ${task.id}  Status: ${status}  Loops: ${task.loopCount ?? 0}  ` +
          `Trace hops: ${Array.isArray(task.trace) ? task.trace.length : 0}\n` +
          `Created: ${task.createdAt ?? "?"}  Updated: ${task.updatedAt ?? "?"}\n\n` +
          `(imported from company/projects/${projectId}/tasks.json)`,
        source: `run:${task.id}`,
        projects: [projectId],
        tags: ["run", status],
        date: task.updatedAt ?? task.createdAt,
      });
    }
  }
}

// ---------------------------------------------------------------- main

function main(): void {
  importClaudeMemory();
  importCoordinationLog();
  importAssistantChat();
  importTasks();

  const byType = new Map<string, number>();
  const byFolder = new Map<string, number>();
  let written = 0;
  let updated = 0;

  for (const p of pending) {
    byType.set(p.type, (byType.get(p.type) ?? 0) + 1);
    if (DRY) continue;
    try {
      const out = remember({
        id: p.id,
        type: p.type,
        title: p.title,
        body: p.body,
        source: p.source,
        projects: p.projects,
        tags: p.tags,
        folder: p.folder,
        date: p.date,
      });
      const folder = path.basename(path.dirname(out.path));
      byFolder.set(folder, (byFolder.get(folder) ?? 0) + 1);
      if (out.updated) updated++;
      else written++;
    } catch (e) {
      skipped.push(`${p.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log(`[memory-import] ${DRY ? "DRY RUN - nothing written" : "import complete"}`);
  console.log(`[memory-import] candidate notes: ${pending.length}`);
  for (const [type, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type.padEnd(12)} ${n}`);
  }
  if (!DRY) {
    console.log(`[memory-import] written: ${written}  updated in place: ${updated}  (distinct notes: ${written + updated})`);
    console.log("[memory-import] notes per folder:");
    for (const [folder, n] of [...byFolder.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${folder.padEnd(12)} ${n}`);
    }
  }
  console.log("[memory-import] examples:");
  for (const p of pending.slice(0, 3)) console.log(`  - [${p.type}] ${clip(p.title, 100)} (${p.id})`);
  if (skipped.length) {
    console.log("[memory-import] skipped/notes:");
    for (const s of skipped.slice(0, 10)) console.log(`  - ${s}`);
  }

  if (DRY) return;

  const status = memoryStatus();
  console.log(`[memory-import] store now holds ${status.notes} notes (${JSON.stringify(status.byType)})`);
  console.log(`[memory-import] graphify: ${status.graphify ?? "(not found)"} ${status.graphifyVersion ?? ""} | semantic key configured: ${status.semanticKeyConfigured}`);

  if (NO_REBUILD) {
    console.log("[memory-import] --no-rebuild: skipping the graphify rebuild (memory is marked dirty)");
    return;
  }
  console.log("[memory-import] rebuilding the graph (this can take a while)...");
  void rebuildGraph({ force: true }).then((report) => {
    console.log(
      `[memory-import] rebuild ok=${report.ok} mode=${report.mode} nodes=${report.nodes} edges=${report.edges} ms=${report.ms}`,
    );
    for (const r of report.roots) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.kind.padEnd(22)} ${r.nodes} nodes  ${r.ms}ms  ${r.detail}`);
    for (const e of report.errors) console.log(`  issue: ${e}`);
  });
}

main();
