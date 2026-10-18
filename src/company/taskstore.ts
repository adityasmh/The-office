import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { getCompanyRoot } from "./org.js";
import { cloneDeep } from "./cache.js";
import type { TaskRec } from "./gates.js";

// ---------------------------------------------------------------------------
// Batched, in-memory task store (order RP1-router-perf, docs/reports/ORDER_RP1-router-perf.md).
//
// Why: every task update used to JSON.parse + JSON.stringify the whole
// company/projects/<id>/tasks.json (6.6 MB / 250 tasks, pretty printed) on the
// router's single thread, so with 30 tasks in flight /health stalled for seconds
// and the router restarted itself.
//
// Design:
//   * one in-memory Map of every task per project, loaded once per process;
//   * writes only mark the project dirty and are flushed at most once per
//     second, asynchronously, compact JSON, through a temp file + rename so a
//     crash can never leave a half-written tasks.json;
//   * finished tasks older than 60 minutes move to tasks-archive.jsonl
//     (append only) and leave the active list; list(id, true) returns both;
//   * reads hand out deep copies, so a caller cannot mutate the cache;
//   * flush on SIGTERM / SIGINT / beforeExit.
//
// Tests inject their own async writer/rename through `fs` so writes can be
// counted and a crash between the temp write and the rename can be simulated.
// ---------------------------------------------------------------------------

export type StoreFs = {
  readFileSync(file: string, encoding: "utf8"): string;
  writeFile(file: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  appendFile(file: string, data: string): Promise<void>;
  mkdir(dir: string): Promise<void>;
  readdir(dir: string): Promise<string[]>;
  unlink(file: string): Promise<void>;
};

const realFs: StoreFs = {
  readFileSync: (file, encoding) => fs.readFileSync(file, encoding),
  writeFile: (file, data) => fsp.writeFile(file, data),
  rename: (from, to) => fsp.rename(from, to),
  appendFile: (file, data) => fsp.appendFile(file, data),
  mkdir: async (dir) => {
    await fsp.mkdir(dir, { recursive: true });
  },
  readdir: (dir) => fsp.readdir(dir),
  unlink: (file) => fsp.unlink(file),
};

export type TaskStoreOptions = {
  /** Where the company root is; defaults to getCompanyRoot() (lazy, per call). */
  root?: () => string;
  /** Async fs overrides, for tests (write counting, simulated crash). */
  fs?: Partial<StoreFs>;
  /** Flush cadence. The store never flushes faster than this. Default 1000 ms. */
  flushMs?: number;
  /** A merged/failed task older than this leaves the active list. Default 60 min. */
  archiveAgeMs?: number;
  /** Clock injection, for the archive and premigration timestamps. */
  now?: () => number;
  /** Copy tasks.json to tasks.json.premigration.<time> once, before first load. */
  premigration?: boolean;
};

export type TaskStore = {
  get(projectId: string, taskId: string): TaskRec | undefined;
  list(projectId: string, includeArchive?: boolean): TaskRec[];
  create(projectId: string, task: TaskRec): TaskRec;
  update(projectId: string, taskId: string, patch: Partial<TaskRec>): TaskRec | undefined;
  /** Replace or insert a whole task (what gates.saveTask used to write). */
  upsert(projectId: string, task: TaskRec): TaskRec;
  flush(projectId?: string): Promise<void>;
  /** Synchronous best-effort flush, used by the signal handlers. */
  flushSync(): void;
  projectDir(projectId: string): string;
  tasksFile(projectId: string): string;
  archiveFile(projectId: string): string;
};

type ProjectState = {
  tasks: Map<string, TaskRec>; // every task, active first then archived
  archived: Set<string>;
  dirty: boolean;
  timer: NodeJS.Timeout | null;
  flushing: Promise<void> | null;
  pendingArchive: TaskRec[];
};

function isTask(value: unknown): value is TaskRec {
  return Boolean(value) && typeof value === "object" && typeof (value as { id?: unknown }).id === "string";
}

function isFinished(task: TaskRec): boolean {
  return task.status === "merged" || task.status === "failed";
}

const stores = new Set<TaskStore>();
let signalsWired = false;

function flushAllSync(): void {
  for (const store of stores) {
    try {
      store.flushSync();
    } catch {
      // a shutdown flush is best effort
    }
  }
}

function wireSignals(): void {
  if (signalsWired) return;
  signalsWired = true;
  const forward = (sig: NodeJS.Signals) => {
    flushAllSync();
    process.removeListener(sig, listener);
    // Re-raise so the default action (or another handler) still terminates.
    try {
      process.kill(process.pid, sig);
    } catch {
      // Windows may refuse to re-raise SIGINT; beforeExit covers that case.
    }
  };
  const listener = (sig: NodeJS.Signals) => forward(sig);
  try {
    process.on("SIGTERM", listener);
    process.on("SIGINT", listener);
    process.on("beforeExit", flushAllSync);
  } catch {
    // No process signals available (e.g. a worker); the periodic flush still runs.
  }
}

export function createTaskStore(options: TaskStoreOptions = {}): TaskStore {
  const rootOf = options.root ?? (() => getCompanyRoot());
  const io: StoreFs = { ...realFs, ...(options.fs ?? {}) };
  const flushMs = Math.max(0, options.flushMs ?? 1000);
  const archiveAgeMs = Math.max(0, options.archiveAgeMs ?? 60 * 60 * 1000);
  const nowFn = options.now ?? (() => Date.now());
  const premigration = options.premigration !== false;
  const projects = new Map<string, ProjectState>();

  const projectDir = (projectId: string) => path.join(rootOf(), "projects", projectId);
  const tasksFile = (projectId: string) => path.join(projectDir(projectId), "tasks.json");
  const archiveFile = (projectId: string) => path.join(projectDir(projectId), "tasks-archive.jsonl");

  function premigrate(projectId: string): void {
    const file = tasksFile(projectId);
    try {
      if (!fs.existsSync(file)) return;
      const dir = projectDir(projectId);
      const entries = fs.readdirSync(dir);
      if (entries.some((e) => e.startsWith("tasks.json.premigration."))) return;
      const ts = new Date(nowFn()).toISOString().replace(/[:.]/g, "-");
      fs.copyFileSync(file, path.join(dir, `tasks.json.premigration.${ts}`));
    } catch {
      // A failed safety copy must not stop the store from loading.
    }
  }

  function sweepArchive(state: ProjectState): void {
    const now = nowFn();
    for (const [id, task] of state.tasks) {
      if (state.archived.has(id)) continue;
      if (!isFinished(task)) continue;
      const updated = Date.parse(String(task.updatedAt ?? ""));
      if (!Number.isFinite(updated)) continue;
      if (now - updated <= archiveAgeMs) continue;
      state.archived.add(id);
      state.pendingArchive.push(task);
      state.dirty = true;
    }
  }

  function loadProject(projectId: string): ProjectState {
    const state: ProjectState = {
      tasks: new Map(),
      archived: new Set(),
      dirty: false,
      timer: null,
      flushing: null,
      pendingArchive: [],
    };
    if (premigration) premigrate(projectId);
    try {
      const raw = fs.readFileSync(tasksFile(projectId), "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const task of parsed) if (isTask(task)) state.tasks.set(task.id, task);
      }
    } catch {
      // Missing or corrupt tasks.json: start empty, exactly like the old load.
    }
    try {
      const raw = fs.readFileSync(archiveFile(projectId), "utf8");
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const task: unknown = JSON.parse(line);
          if (isTask(task) && !state.tasks.has(task.id)) {
            state.tasks.set(task.id, task);
            state.archived.add(task.id);
          }
        } catch {
          // skip a malformed archive line
        }
      }
    } catch {
      // no archive yet
    }
    sweepArchive(state);
    return state;
  }

  function state(projectId: string): ProjectState {
    let state = projects.get(projectId);
    if (!state) {
      state = loadProject(projectId);
      projects.set(projectId, state);
    }
    if (state.dirty) scheduleFlush(projectId, state);
    return state;
  }

  function scheduleFlush(projectId: string, state: ProjectState): void {
    if (state.timer) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      void flushProject(projectId, state);
    }, flushMs);
    state.timer.unref?.();
  }

  async function doFlush(projectId: string, state: ProjectState): Promise<void> {
    if (!state.dirty && !state.pendingArchive.length) return;
    const active = [...state.tasks.values()].filter((task) => !state.archived.has(task.id));
    const archive = state.pendingArchive.splice(0, state.pendingArchive.length);
    state.dirty = false;
    try {
      await io.mkdir(projectDir(projectId));
      // Archive first: if the active rewrite fails, the task exists in both files
      // (never lost); a duplicate archive line is deduped on load by id.
      if (archive.length) {
        await io.appendFile(archiveFile(projectId), archive.map((task) => JSON.stringify(task)).join("\n") + "\n");
      }
      const tmp = `${tasksFile(projectId)}.tmp`;
      await io.writeFile(tmp, JSON.stringify(active));
      await io.rename(tmp, tasksFile(projectId));
    } catch {
      // A crash between the temp write and the rename left the previous file
      // intact; keep the state dirty so a later flush retries.
      state.dirty = true;
      if (archive.length) state.pendingArchive.unshift(...archive);
    }
  }

  function flushProject(projectId: string, state: ProjectState): Promise<void> {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    const run = (state.flushing ?? Promise.resolve()).then(() => doFlush(projectId, state));
    const guarded = run.then(
      () => undefined,
      () => undefined,
    );
    state.flushing = guarded;
    void guarded.then(() => {
      if (state.flushing === guarded) state.flushing = null;
    });
    return guarded;
  }

  function markDirty(projectId: string, state: ProjectState): void {
    state.dirty = true;
    scheduleFlush(projectId, state);
  }

  const store: TaskStore = {
    projectDir,
    tasksFile,
    archiveFile,

    get(projectId, taskId) {
      const task = state(projectId).tasks.get(taskId);
      return task ? cloneDeep(task) : undefined;
    },

    list(projectId, includeArchive = false) {
      const state_ = state(projectId);
      const out: TaskRec[] = [];
      for (const [id, task] of state_.tasks) {
        if (!includeArchive && state_.archived.has(id)) continue;
        out.push(task);
      }
      return cloneDeep(out);
    },

    create(projectId, task) {
      if (!isTask(task)) throw new Error("task.id required");
      const state_ = state(projectId);
      state_.tasks.set(task.id, cloneDeep(task));
      state_.archived.delete(task.id);
      sweepArchive(state_);
      markDirty(projectId, state_);
      return cloneDeep(task);
    },

    upsert(projectId, task) {
      if (!isTask(task)) throw new Error("task.id required");
      const state_ = state(projectId);
      state_.tasks.set(task.id, cloneDeep(task));
      state_.archived.delete(task.id);
      sweepArchive(state_);
      markDirty(projectId, state_);
      return cloneDeep(task);
    },

    update(projectId, taskId, patch) {
      const state_ = state(projectId);
      const current = state_.tasks.get(taskId);
      if (!current) return undefined;
      const next: TaskRec = { ...current, ...patch, id: current.id };
      state_.tasks.set(taskId, next);
      if (state_.archived.has(taskId) && !isFinished(next)) state_.archived.delete(taskId);
      sweepArchive(state_);
      markDirty(projectId, state_);
      return cloneDeep(next);
    },

    flush(projectId) {
      if (projectId) return flushProject(projectId, state(projectId));
      const pending: Promise<void>[] = [];
      for (const [id, state_] of projects) pending.push(flushProject(id, state_));
      return Promise.all(pending).then(() => undefined);
    },

    flushSync() {
      for (const [projectId, state_] of projects) {
        if (state_.timer) {
          clearTimeout(state_.timer);
          state_.timer = null;
        }
        if (!state_.dirty && !state_.pendingArchive.length) continue;
        const active = [...state_.tasks.values()].filter((task) => !state_.archived.has(task.id));
        const archive = state_.pendingArchive.slice();
        try {
          fs.mkdirSync(projectDir(projectId), { recursive: true });
          if (archive.length) {
            fs.appendFileSync(archiveFile(projectId), archive.map((task) => JSON.stringify(task)).join("\n") + "\n");
          }
          const tmp = `${tasksFile(projectId)}.tmp`;
          fs.writeFileSync(tmp, JSON.stringify(active));
          fs.renameSync(tmp, tasksFile(projectId));
          state_.pendingArchive.length = 0;
          state_.dirty = false;
        } catch {
          state_.dirty = true;
        }
      }
    },
  };

  stores.add(store);
  wireSignals();
  return store;
}

let defaultStore: TaskStore | null = null;

/** The process-wide store used by gates.ts. Root is read lazily from COMPANY_ROOT. */
export function taskStore(): TaskStore {
  if (!defaultStore) defaultStore = createTaskStore();
  return defaultStore;
}

// ---------------------------------------------------------------------------
// Helpers (knowledge cache, backups)
// ---------------------------------------------------------------------------

type MtimeEntry = { signature: string; value: unknown };
const mtimeCache = new Map<string, MtimeEntry>();

/**
 * In-memory cache keyed by the file's modification time (and size). The same
 * object is returned until the file changes; knowledge.json is the caller.
 */
export function cachedByMtime<T>(file: string, load: () => T): T {
  let signature = "missing";
  try {
    const stat = fs.statSync(file);
    signature = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    // keep "missing"
  }
  const hit = mtimeCache.get(file);
  if (hit && hit.signature === signature) return hit.value as T;
  const value = load();
  mtimeCache.set(file, { signature, value });
  return value;
}

/** Timestamped backup name, the same shape sessions.ts already writes. */
export function backupName(file: string, now = new Date()): string {
  return `${file}.backup.${now.toISOString().replace(/[:.]/g, "-")}`;
}

/**
 * Keep only the `keep` newest `<file>.backup.<time>` siblings and delete the
 * rest. ISO-derived timestamps sort lexicographically, so a plain sort is the
 * age order. Returns the removed file names (tests assert on it).
 */
export function pruneBackups(file: string, keep = 3): string[] {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.backup.`;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const backups = entries.filter((entry) => entry.startsWith(prefix)).sort();
  const remove = backups.slice(0, Math.max(0, backups.length - keep));
  const removed: string[] = [];
  for (const name of remove) {
    try {
      fs.unlinkSync(path.join(dir, name));
      removed.push(name);
    } catch {
      // leave a file we cannot delete; retention is best effort
    }
  }
  return removed;
}
