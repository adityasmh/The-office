import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { getCompanyRoot, loadOrg } from "./org.js";
import { findGraphify } from "./knowledge.js";
import { fileSig } from "./cache.js";
import { airgappedBlock } from "./airGap.js";

// COMPANY MEMORY (docs/MEMORY_SPEC.md)
//
// One memory for the whole company, stored as one markdown note per fact under
// company/memory/<folder>/<id>.md, and indexed by graphify as a knowledge graph
// (company/memory/graphify-out/graph.json) so recall finds the RELEVANT few notes
// instead of stuffing everything into prompts.
//
// Design rules (deliberate, do not "simplify" them away):
//   * remember()/recall()/memoryDigest() are SYNCHRONOUS, in-process and cheap:
//     they never spawn a process, so the router's event loop is never blocked and
//     recall stays well under its 2s budget.
//   * rebuildGraph() is the ONLY part that shells out to graphify. It is async
//     (never blocks the loop), debounced, and can never crash the router: every
//     failure is captured and reported.
//   * Everything works with NO LLM key. Degraded mode = code AST graph + keyword
//     scoring over the notes. When a semantic key appears in .env the next rebuild
//     switches doc/semantic extraction on with no code change.
//   * Secrets are never stored: anything that looks like a key/token is redacted
//     before a note is written.

export type MemoryNoteType =
  | "decision"
  | "preference"
  | "run-outcome"
  | "failure"
  | "person"
  | "project"
  | "reference";

export type MemoryNoteInput = {
  type: MemoryNoteType | string;
  title: string;
  body: string;
  /** Free-form provenance, e.g. "assistant-thread", "run:tm123", "claude-code". */
  source?: string;
  projects?: string[];
  tags?: string[];
  /** Explicit id (slug). When omitted it is derived from the title. */
  id?: string;
  /** Explicit folder override, e.g. "imported". Defaults from the type. */
  folder?: string;
  /** ISO date; defaults to now. */
  date?: string;
};

export type MemoryNote = {
  id: string;
  type: MemoryNoteType;
  title: string;
  date: string;
  updated?: string;
  source: string;
  projects: string[];
  tags: string[];
  body: string;
  /** Path relative to company/memory, e.g. "decisions/use-opus-for-assistant.md". */
  rel: string;
  path: string;
};

export type RecallHit = {
  id: string;
  title: string;
  type: MemoryNoteType;
  date: string;
  excerpt: string;
  path: string;
  score: number;
  /** Where the score came from: keyword hits, graph traversal, or both. */
  via: "keyword" | "graph" | "keyword+graph";
};

export type RebuildReport = {
  ok: boolean;
  startedAt: string;
  ms: number;
  skipped: boolean;
  reason?: string;
  mode: "code-only" | "semantic";
  graphify: string | null;
  graphifyVersion: string | null;
  graphPath: string;
  nodes: number;
  edges: number;
  roots: Array<{ root: string; kind: string; ok: boolean; nodes: number; ms: number; detail: string }>;
  errors: string[];
};

// ---------------------------------------------------------------- config

const NOTE_FOLDERS = [
  "decisions",
  "preferences",
  "runs",
  "failures",
  "projects",
  "people",
  "references",
  "imported",
] as const;

const FOLDER_BY_TYPE: Record<MemoryNoteType, string> = {
  decision: "decisions",
  preference: "preferences",
  "run-outcome": "runs",
  failure: "failures",
  project: "projects",
  person: "people",
  reference: "references",
};

const TYPES: MemoryNoteType[] = [
  "decision",
  "preference",
  "run-outcome",
  "failure",
  "person",
  "project",
  "reference",
];

// Env vars graphify itself reads for its LLM/semantic backend (see
// `graphify extract --help`). If the CEO sets ANY of these (or the company-wide
// GRAPHIFY_API_KEY below) semantic extraction switches on at the next rebuild.
const SEMANTIC_ENV_VARS = [
  "GRAPHIFY_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "DEEPSEEK_API_KEY",
  "MOONSHOT_API_KEY",
];

const BACKEND_ENV_BY_NAME: Record<string, string> = {
  claude: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  kimi: "MOONSHOT_API_KEY",
};

const REBUILD_MIN_S = Math.max(0, Number(process.env.MEMORY_REBUILD_MIN_S ?? 300) || 300);
const AUTOREBUILD = (process.env.MEMORY_AUTOREBUILD ?? "1") !== "0";
const MAX_NOTES = Math.max(50, Number(process.env.MEMORY_MAX_NOTES ?? 5000) || 5000);
const RECALL_LIMIT_DEFAULT = 8;
const MAX_BODY_CHARS = 20000;
const REDACTED = "[REDACTED]";

export function memoryRoot(): string {
  return path.join(getCompanyRoot(), "memory");
}

export function notesDir(): string {
  return memoryRoot();
}

export function graphPath(): string {
  return path.join(memoryRoot(), "graphify-out", "graph.json");
}

function statePath(): string {
  return path.join(memoryRoot(), ".memory-state.json");
}

function buildDirFor(kind: string): string {
  return path.join(memoryRoot(), ".graphify-build", kind);
}

// ---------------------------------------------------------------- tiny utils

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function nowIso(): string {
  return new Date().toISOString();
}

export function slugify(input: string, max = 60): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return s || `note-${Date.now().toString(36)}`;
}

function writeFileAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- redaction

// Anything that looks like a credential is replaced before it reaches a note.
// Order matters: long opaque tokens last, so labelled secrets keep their label.
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(xox[abposr]|xapp)-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\b(lsk|sk_live|sk_test|pk_live|ghp|gho|github_pat|glpat|AKIA)[-_A-Za-z0-9]{8,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, REDACTED],
  [/((?:api[_-]?key|token|secret|password|passwd|bearer|authorization)\s*[:=]\s*)(["']?)([^\s"',;]{6,})(\2)/gi, `$1$2${REDACTED}$4`],
  [/(bearer\s+)[A-Za-z0-9._-]{12,}/gi, `$1${REDACTED}`],
  [/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, REDACTED],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, to] of SECRET_PATTERNS) out = out.replace(re, to);
  return out;
}

// ---------------------------------------------------------------- front matter

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  const t = raw.trim();
  if (!t || t === "[]") return [];
  if (t.startsWith("[")) {
    try {
      const arr = JSON.parse(t.replace(/'/g, '"')) as unknown;
      if (Array.isArray(arr)) return arr.map((x) => String(x).trim()).filter(Boolean);
    } catch {
      /* fall through to the comma split */
    }
    return t
      .slice(1, -1)
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  return [t];
}

function quoteValue(v: string): string {
  // Always double-quote: titles legitimately contain ':' and '#'.
  return JSON.stringify(v.replace(/\r?\n/g, " ").trim());
}

export function formatNote(note: {
  id: string;
  type: string;
  title: string;
  date: string;
  updated?: string;
  source: string;
  projects: string[];
  tags: string[];
  body: string;
}): string {
  const fm = [
    "---",
    `id: ${note.id}`,
    `type: ${note.type}`,
    `title: ${quoteValue(note.title)}`,
    `date: ${note.date}`,
  ];
  if (note.updated) fm.push(`updated: ${note.updated}`);
  fm.push(`source: ${quoteValue(note.source || "unknown")}`);
  fm.push(`projects: ${JSON.stringify(note.projects ?? [])}`);
  fm.push(`tags: ${JSON.stringify(note.tags ?? [])}`);
  fm.push("---", "");
  return `${fm.join("\n")}${(note.body ?? "").trim()}\n`;
}

export function parseNoteText(text: string, rel: string, abs: string): MemoryNote | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const fm: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const id = fm.id?.replace(/^["']|["']$/g, "").trim();
  if (!id) return null;
  const rawType = (fm.type ?? "reference").replace(/^["']|["']$/g, "").trim() as MemoryNoteType;
  return {
    id,
    type: TYPES.includes(rawType) ? rawType : "reference",
    title: (fm.title ?? id).replace(/^["']|["']$/g, "").trim() || id,
    date: fm.date ?? "",
    updated: fm.updated,
    source: (fm.source ?? "unknown").replace(/^["']|["']$/g, "").trim(),
    projects: parseList(fm.projects),
    tags: parseList(fm.tags),
    body: (m[2] ?? "").trim(),
    rel: toPosix(rel),
    path: abs,
  };
}

// ---------------------------------------------------------------- note index

type IndexedNotes = { notes: MemoryNote[]; signature: string; newestMtimeMs: number };

let indexCache: IndexedNotes | null = null;

function walkNoteFiles(): Array<{ rel: string; abs: string; mtimeMs: number; size: number }> {
  const root = notesDir();
  const out: Array<{ rel: string; abs: string; mtimeMs: number; size: number }> = [];
  const dirs: string[] = [root];
  for (const f of NOTE_FOLDERS) dirs.push(path.join(root, f));

  for (const dir of dirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // a missing folder is not an error
    }
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.toLowerCase().endsWith(".md")) continue;
      const abs = path.join(dir, ent.name);
      try {
        const st = fs.statSync(abs);
        out.push({
          rel: toPosix(path.relative(root, abs)),
          abs,
          mtimeMs: st.mtimeMs,
          size: st.size,
        });
      } catch {
        /* vanished mid-scan */
      }
    }
    if (out.length >= MAX_NOTES) break;
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

// The whole index is rebuilt only when some note changed (path+mtime+size).
function loadNotes(): { notes: MemoryNote[]; newestMtimeMs: number } {
  const files = walkNoteFiles();
  const h = crypto.createHash("sha1");
  let newest = 0;
  for (const f of files) {
    h.update(`${f.rel}\u0000${Math.round(f.mtimeMs)}\u0000${f.size}\n`);
    if (f.mtimeMs > newest) newest = f.mtimeMs;
  }
  const signature = h.digest("hex");
  if (indexCache && indexCache.signature === signature) {
    return { notes: indexCache.notes, newestMtimeMs: indexCache.newestMtimeMs };
  }
  const notes: MemoryNote[] = [];
  for (const f of files) {
    try {
      const parsed = parseNoteText(fs.readFileSync(f.abs, "utf8"), f.rel, f.abs);
      if (parsed) notes.push(parsed);
    } catch {
      /* unreadable note: ignore, never fail the caller */
    }
  }
  indexCache = { notes, signature, newestMtimeMs: newest };
  return { notes, newestMtimeMs: newest };
}

// ---------------------------------------------------------------- state

type MemoryState = {
  version: number;
  dirty: boolean;
  lastBuiltAt: string | null;
  lastReport: null | { ok: boolean; mode: string; nodes: number; edges: number; ms: number; errors: string[] };
  writes: number;
};

function readState(): MemoryState {
  const s = readJson<Partial<MemoryState>>(statePath());
  return {
    version: 1,
    dirty: s?.dirty === true,
    lastBuiltAt: typeof s?.lastBuiltAt === "string" ? s.lastBuiltAt : null,
    lastReport: s?.lastReport ?? null,
    writes: typeof s?.writes === "number" ? s.writes : 0,
  };
}

function writeState(s: MemoryState): void {
  try {
    writeFileAtomic(statePath(), JSON.stringify(s, null, 2));
  } catch {
    /* the notes themselves are the source of truth; state is an optimisation */
  }
}

export function markDirty(): void {
  const s = readState();
  s.dirty = true;
  s.writes += 1;
  writeState(s);
}

export function isDirty(): boolean {
  return readState().dirty;
}

export type MemoryStatus = {
  notes: number;
  byType: Record<string, number>;
  folders: Array<{ folder: string; notes: number }>;
  memoryRoot: string;
  graphPath: string;
  graphBuiltAt: string | null;
  graphAgeSeconds: number | null;
  graphNodes: number;
  graphEdges: number;
  graphFresh: boolean;
  dirty: boolean;
  lastRebuildAt: string | null;
  lastRebuildError: string | null;
  graphify: string | null;
  graphifyWhy: string;
  graphifyVersion: string | null;
  semanticKeyConfigured: boolean;
  semanticMode: boolean;
  rebuildMinSeconds: number;
  autoRebuild: boolean;
};

let versionCache: { bin: string | null; version: string | null; checkedAt: number } = {
  bin: null,
  version: null,
  checkedAt: 0,
};

let versionProbeInFlight = false;

// PERF (docs/PERF_SPEC.md item 5, 2026-09-29). This used to run
// `execFileSync(bin, ["--version"])` - a ~250 ms SYNCHRONOUS child process, caught
// in a CPU profile as
//   spawn <- spawnSync <- execFileSync <- execFileSyncVersion <- graphifyVersion
//   <- memoryStatus <- GET /company/memory/status
// i.e. a quarter of a second of blocked event loop, for a value the status page
// only displays. The probe is now asynchronous and off the request path: the
// cached version (10 min TTL, unchanged) is returned immediately, and a missing or
// stale value is refreshed in the background - so the first status response after
// a boot shows graphifyVersion: null once and the picture is complete on the next
// poll (the dashboard polls this every 6 s).
function graphifyVersion(bin: string | null): string | null {
  if (!bin) return null;
  const fresh = Date.now() - versionCache.checkedAt < 600000;
  if (fresh && versionCache.bin === bin) return versionCache.version;
  if (!versionProbeInFlight) {
    versionProbeInFlight = true;
    try {
      // AIR-GAP (PERF item 7 review fix 2): the --version child is local-only, but
      // it is still a subprocess spawn; refuse it under the flag (version stays null,
      // nothing depends on it functionally).
      if (airgappedBlock("fleet-agent", "graphify --version")) {
        versionProbeInFlight = false;
        return versionCache.bin === bin ? versionCache.version : null;
      }
      execFile(bin, ["--version"], { timeout: 20000, encoding: "utf8" }, (err, stdout) => {
        versionProbeInFlight = false;
        const out = typeof stdout === "string" ? stdout.trim().split(/\r?\n/)[0] || null : null;
        versionCache = { bin, version: err ? null : out, checkedAt: Date.now() };
      });
    } catch {
      versionProbeInFlight = false;
    }
  }
  // Last known value for this binary while the probe runs (null on first call).
  return versionCache.bin === bin ? versionCache.version : null;
}

export function semanticKeyConfigured(): boolean {
  return SEMANTIC_ENV_VARS.some((v) => (process.env[v] ?? "").trim().length > 0);
}

function graphCounts(): { nodes: number; edges: number; builtAt: string | null; mtimeMs: number } {
  const file = graphPath();
  const sig = fileSig(file);
  if (countsCache && countsCache.sig === sig) return countsCache.value;
  const value = readGraphCounts(file);
  countsCache = { sig, value };
  return value;
}

// PERF (docs/PERF_SPEC.md, 2026-09-29): graph.json here is 4.4 MB, and this used
// to parse it on EVERY call - /company/memory/status calls it directly and again
// through graphFresh(), measured at 149 ms per request on an isolated server. The
// file only changes when a rebuild replaces it, so the counts are cached by
// mtime+size (the same rule as the panel's file reads).
let countsCache: { sig: string; value: { nodes: number; edges: number; builtAt: string | null; mtimeMs: number } } | null = null;

function readGraphCounts(file: string): { nodes: number; edges: number; builtAt: string | null; mtimeMs: number } {
  const g = readJson<{ nodes?: unknown[]; links?: unknown[]; edges?: unknown[] }>(file);
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  if (!g) return { nodes: 0, edges: 0, builtAt: null, mtimeMs };
  const edges = Array.isArray(g.links) ? g.links.length : Array.isArray(g.edges) ? g.edges.length : 0;
  return {
    nodes: Array.isArray(g.nodes) ? g.nodes.length : 0,
    edges,
    builtAt: mtimeMs ? new Date(mtimeMs).toISOString() : null,
    mtimeMs,
  };
}

function graphFresh(newestNoteMtimeMs: number): boolean {
  const { mtimeMs } = graphCounts();
  if (!mtimeMs) return false;
  if (readState().dirty) return false;
  return mtimeMs >= newestNoteMtimeMs;
}

// ---------------------------------------------------------------- remember

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 2);
}

function titleSimilarity(a: string, b: string): number {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.max(A.size, B.size);
}

function normalizeFolder(note: MemoryNoteInput): string {
  const explicit = (note.folder ?? "").trim().toLowerCase().replace(/[^a-z-]/g, "");
  if (explicit) return explicit;
  const type = normalizeType(note.type);
  return FOLDER_BY_TYPE[type];
}

function normalizeType(t: string): MemoryNoteType {
  const v = (t ?? "").trim().toLowerCase();
  if ((TYPES as string[]).includes(v)) return v as MemoryNoteType;
  if (v === "run" || v === "runoutcome" || v === "outcome") return "run-outcome";
  if (v === "pref" || v === "feedback") return "preference";
  return "reference";
}

// Writes or UPDATES a note. The subject key is the slugified title (or an explicit
// id), so re-remembering the same fact rewrites one file instead of duplicating.
export function remember(note: MemoryNoteInput): { id: string; path: string; updated: boolean } {
  ensureLoop();
  const type = normalizeType(note.type);
  const title = redactSecrets((note.title || note.body.split(/\r?\n/)[0] || "untitled note").trim()).slice(0, 200);
  const body = redactSecrets((note.body ?? "").slice(0, MAX_BODY_CHARS)).trim();
  const source = redactSecrets((note.source ?? "unknown").trim());
  const projects = (note.projects ?? []).map((p) => String(p).trim()).filter(Boolean).slice(0, 20);
  const tags = (note.tags ?? []).map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 20);
  const folder = normalizeFolder({ ...note, type });
  const wanted = slugify(note.id ? String(note.id) : title);
  const date = note.date && !Number.isNaN(Date.parse(note.date)) ? new Date(note.date).toISOString() : nowIso();

  const { notes } = loadNotes();
  const sameId = notes.find((n) => n.id === wanted);
  // Same subject, different slug (e.g. the title was reworded): update in place.
  const similar =
    sameId ??
    notes.find((n) => n.type === type && titleSimilarity(n.title, title) >= 0.75) ??
    null;

  const id = similar ? similar.id : uniqueId(wanted, notes);
  const rel = similar && similar.rel.includes("/") ? similar.rel : path.posix.join(folder, `${id}.md`);
  const abs = path.join(notesDir(), rel);
  const payload = {
    id,
    type,
    title,
    date: similar?.date && similar.date ? similar.date : date,
    updated: similar ? date : undefined,
    source,
    projects: projects.length ? projects : similar?.projects ?? [],
    tags: Array.from(new Set([...(similar?.tags ?? []), ...tags])).slice(0, 20),
    body: appendBody(similar?.body, body, similar ? date : undefined),
  };
  writeFileAtomic(abs, formatNote(payload));
  indexCache = null;
  markDirty();
  return { id, path: abs, updated: Boolean(similar) };
}

function uniqueId(wanted: string, notes: MemoryNote[]): string {
  if (!notes.some((n) => n.id === wanted)) return wanted;
  for (let i = 2; i < 100; i++) {
    const cand = `${wanted}-${i}`;
    if (!notes.some((n) => n.id === cand)) return cand;
  }
  return `${wanted}-${Date.now().toString(36)}`;
}

// An update keeps the old text and appends the new observation, so history is not
// silently lost (that is what "no duplicates" must not cost us).
function appendBody(oldBody: string | undefined, body: string, at?: string): string {
  if (!oldBody) return body;
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  if (norm(oldBody).includes(norm(body)) || norm(body).includes(norm(oldBody))) return body.length > oldBody.length ? body : oldBody;
  return `${oldBody}\n\n**Update${at ? ` (${at.slice(0, 10)})` : ""}:** ${body}`;
}

// ---------------------------------------------------------------- recall

const STOPWORDS = new Set([
  "the","a","an","is","are","was","were","be","been","being","to","of","for","and","or","on","in","at","by","with",
  "it","its","this","that","these","those","what","which","who","whom","whose","why","how","when","where","does",
  "did","do","we","our","us","i","you","your","my","me","not","no","but","if","then","than","as","from","so",
  "there","their","them","they","he","she","his","her","can","could","should","would","will","shall","just","about",
  "into","over","up","down","out","more","most","some","any","all","very","has","have","had",
]);

function queryTokens(question: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokenize(question)) {
    if (STOPWORDS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.slice(0, 24);
}

function fieldTokens(s: string): string[] {
  return tokenize(s);
}

function hitsIn(field: string[], tok: string): number {
  let n = 0;
  for (const w of field) {
    if (w === tok) n += 1;
    else if (tok.length >= 4 && w.startsWith(tok)) n += 0.6;
  }
  return n;
}

function stripMarkdown(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*#{1,6}\s*/gm, "")
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1")
    .replace(/^\s*[-+*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function excerptOf(note: MemoryNote, toks: string[], max = 240): string {
  const flat = stripMarkdown(`${note.body}`);
  if (!flat) return "";
  let at = -1;
  const lower = flat.toLowerCase();
  for (const t of toks) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at <= 80) return flat.slice(0, max);
  const start = Math.max(0, at - 60);
  const cut = flat.slice(start, start + max);
  return `…${cut}`;
}

type GraphNode = { id: string; label: string; source_file?: string; file_type?: string };
type GraphJson = { nodes?: GraphNode[]; links?: Array<{ source: string; target: string; relation?: string }> };

let graphCache: { mtimeMs: number; nodes: GraphNode[]; adj: Map<string, string[]> } | null = null;

function loadGraph(): { nodes: GraphNode[]; adj: Map<string, string[]> } | null {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(graphPath()).mtimeMs;
  } catch {
    return null;
  }
  if (graphCache && graphCache.mtimeMs === mtimeMs) return graphCache;
  const g = readJson<GraphJson>(graphPath());
  if (!g || !Array.isArray(g.nodes) || !g.nodes.length) return null;
  const adj = new Map<string, string[]>();
  for (const l of g.links ?? []) {
    if (!l || typeof l.source !== "string" || typeof l.target !== "string") continue;
    (adj.get(l.source) ?? adj.set(l.source, []).get(l.source)!).push(l.target);
    (adj.get(l.target) ?? adj.set(l.target, []).get(l.target)!).push(l.source);
  }
  graphCache = { mtimeMs, nodes: g.nodes, adj };
  return graphCache;
}

// Token-overlap match of the question against graph node labels/ids, then a short
// BFS. Returns the notes reachable from the matched nodes plus how strong the match was.
function graphRecall(toks: string[]): Map<string, number> {
  const noteRels = new Map<string, number>();
  const graph = loadGraph();
  if (!graph || !toks.length) return noteRels;

  const seedScore = new Map<string, number>();
  for (const n of graph.nodes) {
    const label = `${n.label ?? ""} ${n.id ?? ""}`.toLowerCase();
    if (!label.trim()) continue;
    const words = label.replace(/[^a-z0-9]+/g, " ").split(" ").filter(Boolean);
    let s = 0;
    for (const t of toks) {
      for (const w of words) {
        if (w === t) s += 1;
        else if (t.length >= 4 && w.startsWith(t)) s += 0.6;
      }
    }
    if (s > 0) seedScore.set(n.id, s);
  }
  if (!seedScore.size) return noteRels;

  const seeds = [...seedScore.entries()].sort((a, b) => b[1] - a[1]);
  // BFS from the best-matching nodes; the further a note sits from a seed, the less
  // the graph contributes to its score.
  const depth = new Map<string, number>();
  const queue: Array<{ id: string; depth: number }> = seeds.slice(0, 12).map(([id]) => ({ id, depth: 0 }));
  while (queue.length) {
    const cur = queue.shift()!;
    const known = depth.get(cur.id);
    if (known !== undefined && known <= cur.depth) continue;
    depth.set(cur.id, cur.depth);
    if (cur.depth >= 2) continue;
    for (const nb of graph.adj.get(cur.id) ?? []) queue.push({ id: nb, depth: cur.depth + 1 });
  }

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const [id, d] of depth) {
    const node = byId.get(id);
    if (!node) continue;
    const score = (seedScore.get(id) ?? 1) / (1 + d * 0.6);
    for (const key of [node.source_file, node.label, node.id]) {
      if (!key || typeof key !== "string") continue;
      const rel = toPosix(key).replace(/^\.\//, "").replace(/^graphify-out\//, "");
      const base = path.posix.basename(rel);
      for (const alias of [rel, base, slugify(base.replace(/\.md$/i, ""))]) {
        noteRels.set(alias, Math.max(noteRels.get(alias) ?? 0, score));
      }
    }
  }
  return noteRels;
}

export function recall(
  question: string,
  opts: { limit?: number; projects?: string[] } = {},
): RecallHit[] {
  const limit = Math.max(1, Math.min(50, opts.limit ?? RECALL_LIMIT_DEFAULT));
  try {
    const { notes, newestMtimeMs } = loadNotes();
    if (!notes.length) return [];
    const toks = queryTokens(question ?? "");
    const projectFilter = (opts.projects ?? []).map((p) => String(p).trim()).filter(Boolean);

    const fresh = graphFresh(newestMtimeMs);
    const noteRels = fresh ? graphRecall(toks) : new Map<string, number>();

    // Document frequency for a light BM25-ish idf.
    const df = new Map<string, number>();
    for (const t of toks) {
      let n = 0;
      for (const note of notes) {
        const hay = `${note.title} ${note.tags.join(" ")} ${note.projects.join(" ")} ${note.type} ${note.body.slice(0, 1200)}`.toLowerCase();
        if (hay.includes(t)) n++;
      }
      df.set(t, n);
    }

    const results: RecallHit[] = [];
    for (const note of notes) {
      if (projectFilter.length && !note.projects.some((p) => projectFilter.includes(p))) continue;
      const title = fieldTokens(note.title);
      const tags = note.tags.flatMap(fieldTokens);
      const projects = note.projects.flatMap(fieldTokens);
      const type = fieldTokens(note.type);
      const body = fieldTokens(note.body.slice(0, 4000));

      let raw = 0;
      for (const t of toks) {
        const idf = Math.log(1 + notes.length / (1 + (df.get(t) ?? 0)));
        const hits =
          hitsIn(title, t) * 3 +
          hitsIn(tags, t) * 2.5 +
          hitsIn(projects, t) * 2 +
          hitsIn(type, t) * 1.5 +
          hitsIn(body, t) * 1;
        if (hits > 0) raw += idf * (1 + Math.log(1 + hits));
      }
      if (raw > 0) raw = raw / (1 + Math.log(1 + body.length / 100));

      // Graph traversal: a note linked to a matched node is relevant even when the
      // question's words never appear in the note itself.
      const graphScore = Math.max(
        noteRels.get(note.rel) ?? 0,
        noteRels.get(path.posix.basename(note.rel)) ?? 0,
        noteRels.get(note.id) ?? 0,
      );
      const score = raw + graphScore * 1.2;
      if (score <= 0) continue;
      results.push({
        id: note.id,
        title: note.title,
        type: note.type,
        date: note.date,
        excerpt: excerptOf(note, toks),
        path: note.path,
        score: Number(score.toFixed(4)),
        via: raw > 0 && graphScore > 0 ? "keyword+graph" : raw > 0 ? "keyword" : "graph",
      });
    }

    results.sort((a, b) => b.score - a.score || (a.date < b.date ? 1 : -1));
    if (results.length) return results.slice(0, limit);

    // No keyword/graph hit at all (or an empty question): return the most recent
    // notes so the caller still gets *something* usable instead of nothing.
    if (!toks.length) {
      return [...notes]
        .sort((a, b) => (a.date < b.date ? 1 : -1))
        .slice(0, limit)
        .map((n) => ({
          id: n.id,
          title: n.title,
          type: n.type,
          date: n.date,
          excerpt: excerptOf(n, []),
          path: n.path,
          score: 0,
          via: "keyword" as const,
        }));
    }
    return [];
  } catch {
    // recall must never throw, and must never take the prompt path down with it.
    return [];
  }
}

export function memoryDigest(question: string, maxChars = 2500): string {
  try {
    const hits = recall(question, { limit: 6 });
    if (!hits.length) return "";
    const { newestMtimeMs } = loadNotes();
    const state = readState();
    const fresh = graphFresh(newestMtimeMs) ? "fresh" : graphCounts().mtimeMs ? "stale" : "missing";
    const header = `RELEVANT COMPANY MEMORY: (graph: ${fresh}, notes: ${loadNotes().notes.length}${state.dirty ? ", pending rebuild" : ""})`;
    const lines: string[] = [header];
    for (const h of hits) {
      const line = `- [${h.type}] ${h.title} (${(h.date || "undated").slice(0, 10)})${h.excerpt ? ` — ${h.excerpt.slice(0, 260)}` : ""}`;
      if (lines.join("\n").length + line.length > maxChars - 40) break;
      lines.push(line);
    }
    lines.push(`Full notes: GET /company/memory/notes/:id (searching ${memoryRoot()})`);
    const out = lines.join("\n");
    return out.length <= maxChars ? out : `${out.slice(0, maxChars - 20)}\n[truncated]`;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- reads

export function listNotes(opts: { type?: string; q?: string; limit?: number } = {}): Array<Omit<MemoryNote, "body"> & { chars: number }> {
  try {
    const { notes } = loadNotes();
    const type = (opts.type ?? "").trim();
    const q = (opts.q ?? "").trim().toLowerCase();
    let out = notes;
    if (type) out = out.filter((n) => n.type === type);
    if (q) {
      out = out.filter((n) =>
        `${n.id} ${n.title} ${n.tags.join(" ")} ${n.projects.join(" ")} ${n.body}`.toLowerCase().includes(q),
      );
    }
    const limit = Math.max(1, Math.min(1000, opts.limit ?? 200));
    return out
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      .slice(0, limit)
      .map(({ body, ...rest }) => ({ ...rest, chars: body.length }));
  } catch {
    return [];
  }
}

export function getNote(id: string): MemoryNote | null {
  try {
    const wanted = String(id ?? "").trim();
    if (!wanted) return null;
    const { notes } = loadNotes();
    const slug = slugify(wanted);
    return notes.find((n) => n.id === wanted) ?? notes.find((n) => n.id === slug) ?? null;
  } catch {
    return null;
  }
}

export function memoryStatus(): MemoryStatus {
  try {
    const { notes, newestMtimeMs } = loadNotes();
    const state = readState();
    const counts = graphCounts();
    const byType: Record<string, number> = {};
    const folders = new Map<string, number>();
    for (const n of notes) {
      byType[n.type] = (byType[n.type] ?? 0) + 1;
      const folder = n.rel.includes("/") ? n.rel.split("/")[0] : ".";
      folders.set(folder, (folders.get(folder) ?? 0) + 1);
    }
    const probe = findGraphify();
    const semantic = semanticKeyConfigured();
    return {
      notes: notes.length,
      byType,
      folders: [...folders.entries()].map(([folder, count]) => ({ folder, notes: count })).sort((a, b) => a.folder.localeCompare(b.folder)),
      memoryRoot: memoryRoot(),
      graphPath: graphPath(),
      graphBuiltAt: counts.builtAt,
      graphAgeSeconds: counts.mtimeMs ? Math.round((Date.now() - counts.mtimeMs) / 1000) : null,
      graphNodes: counts.nodes,
      graphEdges: counts.edges,
      graphFresh: graphFresh(newestMtimeMs),
      dirty: state.dirty,
      lastRebuildAt: state.lastBuiltAt,
      lastRebuildError: state.lastReport && !state.lastReport.ok ? (state.lastReport.errors[0] ?? "rebuild failed") : null,
      graphify: probe.bin,
      graphifyWhy: probe.why,
      graphifyVersion: graphifyVersion(probe.bin),
      semanticKeyConfigured: semantic,
      semanticMode: semantic,
      rebuildMinSeconds: REBUILD_MIN_S,
      autoRebuild: AUTOREBUILD,
    };
  } catch (e) {
    return {
      notes: 0, byType: {}, folders: [], memoryRoot: memoryRoot(), graphPath: graphPath(),
      graphBuiltAt: null, graphAgeSeconds: null, graphNodes: 0, graphEdges: 0, graphFresh: false,
      dirty: false, lastRebuildAt: null, lastRebuildError: msg(e), graphify: null, graphifyWhy: "status failed",
      graphifyVersion: null, semanticKeyConfigured: semanticKeyConfigured(), semanticMode: semanticKeyConfigured(),
      rebuildMinSeconds: REBUILD_MIN_S, autoRebuild: AUTOREBUILD,
    };
  }
}

// ---------------------------------------------------------------- rebuild

type RunResult = { code: number; stdout: string; stderr: string };

function runGraphify(bin: string, args: string[], timeoutMs: number, extraEnv?: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    // AIR-GAP (PERF item 7 review fix 2): graphify extract/merge-graphs can call a
    // hosted LLM backend (semantic key). Under AIR_GAPPED=1 the child is refused;
    // code 1 means the rebuild records a failure and keeps the existing graph.
    if (airgappedBlock("fleet-agent", `graphify ${args[0] ?? ""}`)) {
      resolve({ code: 1, stdout: "", stderr: "AIR_GAPPED=1 blocks graphify child" });
      return;
    }
    const child = execFile(
      bin,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, ...(extraEnv ?? {}) },
      },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number }) | null;
        resolve({
          code: e ? (typeof e.code === "number" ? e.code : 1) : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      },
    );
    child.on("error", () => resolve({ code: 1, stdout: "", stderr: "spawn failed" }));
  });
}

// The company-wide knob: when GRAPHIFY_API_KEY is present it is handed to graphify
// under the name of the backend it reads (GRAPHIFY_BACKEND, default openai).
function semanticEnv(): NodeJS.ProcessEnv {
  const key = (process.env.GRAPHIFY_API_KEY ?? "").trim();
  if (!key) return {};
  const backend = (process.env.GRAPHIFY_BACKEND ?? "openai").trim().toLowerCase();
  const target = BACKEND_ENV_BY_NAME[backend];
  const env: NodeJS.ProcessEnv = {};
  if (target && !(process.env[target] ?? "").trim()) env[target] = key;
  const base = (process.env.GRAPHIFY_BASE_URL ?? "").trim();
  if (base) env[backend === "claude" ? "ANTHROPIC_BASE_URL" : "OPENAI_BASE_URL"] = base;
  const model = (process.env.GRAPHIFY_MODEL ?? "").trim();
  if (model) env[backend === "claude" ? "ANTHROPIC_MODEL" : "OPENAI_MODEL"] = model;
  return env;
}

type RootSpec = { root: string; kind: string; semantic: boolean };

function collectRoots(): RootSpec[] {
  const repo = process.cwd();
  const roots: RootSpec[] = [];
  const semantic = semanticKeyConfigured();
  // Notes first: this is what recall traverses. Without a key the notes are
  // markdown, which graphify can only read via its LLM pass, so it is skipped.
  roots.push({ root: memoryRoot(), kind: "memory-notes", semantic });
  for (const [kind, rel] of [["repo-src", "src"], ["repo-docs", "docs"]] as const) {
    const abs = path.join(repo, rel);
    if (fs.existsSync(abs)) roots.push({ root: abs, kind, semantic: semantic && kind === "repo-docs" });
  }
  try {
    for (const p of loadOrg().projects) {
      if (p.rootDir && fs.existsSync(p.rootDir)) roots.push({ root: p.rootDir, kind: `project:${p.id}`, semantic: false });
    }
  } catch {
    /* no org file yet: repo roots are enough */
  }
  const seen = new Set<string>();
  return roots.filter((r) => {
    const k = path.resolve(r.root).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    // A root with no files at all just wastes a process.
    try {
      return fs.readdirSync(r.root).length > 0;
    } catch {
      return false;
    }
  });
}

let rebuilding = false;

export async function rebuildGraph(opts: { force?: boolean } = {}): Promise<RebuildReport> {
  const startedAt = nowIso();
  const t0 = Date.now();
  const state = readState();
  const base: RebuildReport = {
    ok: false,
    startedAt,
    ms: 0,
    skipped: false,
    mode: semanticKeyConfigured() ? "semantic" : "code-only",
    graphify: null,
    graphifyVersion: null,
    graphPath: graphPath(),
    nodes: 0,
    edges: 0,
    roots: [],
    errors: [],
  };

  try {
    const probe = findGraphify();
    base.graphify = probe.bin;
    base.graphifyVersion = graphifyVersion(probe.bin);
    if (!probe.bin) {
      base.errors.push(`graphify CLI not found: ${probe.why}`);
      base.ms = Date.now() - t0;
      return base;
    }
    if (rebuilding) {
      base.skipped = true;
      base.reason = "a rebuild is already running";
      base.ms = Date.now() - t0;
      return base;
    }
    const sinceLast = state.lastBuiltAt ? Date.now() - Date.parse(state.lastBuiltAt) : Number.POSITIVE_INFINITY;
    if (!opts.force && !state.dirty && sinceLast < REBUILD_MIN_S * 1000) {
      base.skipped = true;
      base.ok = true;
      base.reason = `not dirty and last rebuild was ${Math.round(sinceLast / 1000)}s ago (< MEMORY_REBUILD_MIN_S=${REBUILD_MIN_S}s)`;
      base.ms = Date.now() - t0;
      return base;
    }

    rebuilding = true;
    const semEnv = semanticEnv();
    const graphs: string[] = [];
    const roots = collectRoots();
    for (const spec of roots) {
      const rt0 = Date.now();
      const out = buildDirFor(spec.kind.replace(/[^a-z0-9]+/gi, "-").toLowerCase());
      const args = ["extract", spec.root, "--out", out];
      // Code roots are always code-only: it is free, local, deterministic and it
      // keeps the rebuild bounded even when a semantic key is configured.
      if (!spec.semantic) args.push("--code-only");
      const res = await runGraphify(probe.bin, args, spec.semantic ? 900000 : 300000, semEnv);
      const graphFile = path.join(out, "graphify-out", "graph.json");
      const exists = fs.existsSync(graphFile);
      const combined = `${res.stderr}\n${res.stdout}`;
      // A root that holds no extractable code (e.g. a markdown-only project) reports
      // "graph is empty" and exits 1. That is expected in code-only mode, not a
      // rebuild failure, so it must not spam the router log.
      const emptyCorpus = /graph is empty/i.test(combined) && !exists;
      let nodes = 0;
      if (exists) {
        const g = readJson<{ nodes?: unknown[] }>(graphFile);
        nodes = Array.isArray(g?.nodes) ? g.nodes.length : 0;
      }
      if (nodes > 0) graphs.push(graphFile);
      const lastLine = combined.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? "";
      const detail = emptyCorpus
        ? `no extractable code here (docs/notes need a semantic key): ${spec.semantic ? "semantic pass produced nothing" : "code-only mode"}`
        : lastLine.slice(0, 240);
      base.roots.push({
        root: spec.root,
        kind: spec.kind,
        ok: (res.code === 0 && exists) || emptyCorpus,
        nodes,
        ms: Date.now() - rt0,
        detail,
      });
      if (res.code !== 0 && !emptyCorpus) base.errors.push(`${spec.kind}: graphify exited ${res.code} (${lastLine.slice(0, 160)})`);
    }

    fs.mkdirSync(path.dirname(graphPath()), { recursive: true });
    // Keep graphify's own scratch output out of the corpus it scans next time.
    const ignoreFile = path.join(memoryRoot(), ".graphifyignore");
    if (!fs.existsSync(ignoreFile)) {
      try {
        fs.writeFileSync(ignoreFile, ".graphify-build/\ngraphify-out/\n", "utf8");
      } catch {
        /* non-fatal: a missing ignore file only costs a little scan time */
      }
    }
    if (!graphs.length) {
      base.errors.push("graphify produced no nodes (degraded mode: keyword recall over the notes still works)");
    } else if (graphs.length === 1) {
      fs.copyFileSync(graphs[0], graphPath());
    } else {
      const outGraph = graphPath();
      const merged = await runGraphify(probe.bin, ["merge-graphs", ...graphs, "--out", outGraph], 180000, semEnv);
      if (merged.code !== 0 || !fs.existsSync(outGraph)) {
        base.errors.push(`merge-graphs failed (exit ${merged.code}); falling back to the first root's graph`);
        fs.copyFileSync(graphs[0], outGraph);
      }
    }

    const counts = graphCounts();
    base.nodes = counts.nodes;
    base.edges = counts.edges;
    base.ok = base.nodes > 0;
    base.ms = Date.now() - t0;

    const next = readState();
    // Only mark clean when the graph really landed: otherwise the next tick retries.
    next.dirty = !base.ok;
    next.lastBuiltAt = nowIso();
    next.lastReport = { ok: base.ok, mode: base.mode, nodes: base.nodes, edges: base.edges, ms: base.ms, errors: base.errors.slice(0, 5) };
    writeState(next);
    return base;
  } catch (e) {
    base.errors.push(`rebuild failed: ${msg(e)}`);
    base.ms = Date.now() - t0;
    return base;
  } finally {
    rebuilding = false;
  }
}

// ---------------------------------------------------------------- background loop

let loop: NodeJS.Timeout | null = null;

function tickIntervalMs(): number {
  return Math.max(15000, Math.min(120000, Math.round((REBUILD_MIN_S * 1000) / 2) || 15000));
}

// Started lazily by the first remember(): a router that never records anything
// never schedules any work.
function ensureLoop(): void {
  if (!AUTOREBUILD || loop) return;
  try {
    const timer = setInterval(() => {
      void (async () => {
        try {
          const s = readState();
          if (!s.dirty) return;
          const since = s.lastBuiltAt ? Date.now() - Date.parse(s.lastBuiltAt) : Number.POSITIVE_INFINITY;
          if (since < REBUILD_MIN_S * 1000) return;
          const report = await rebuildGraph();
          console.log(`[memory] rebuild ${report.ok ? "ok" : "incomplete"} in ${report.ms}ms (mode=${report.mode}, nodes=${report.nodes}, edges=${report.edges}${report.errors.length ? `, ${report.errors.length} issue(s)` : ""})`);
        } catch (e) {
          console.error(`[memory] rebuild loop error (ignored): ${msg(e)}`);
        }
      })();
    }, tickIntervalMs());
    timer.unref?.();
    loop = timer;
  } catch {
    /* no timers available: recall still works, only auto-rebuild is lost */
  }
}

export function startMemoryLoop(): { started: boolean; intervalMs: number } {
  ensureLoop();
  return { started: Boolean(loop), intervalMs: tickIntervalMs() };
}

export function stopMemoryLoop(): void {
  if (loop) clearInterval(loop);
  loop = null;
}
