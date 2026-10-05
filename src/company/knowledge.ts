import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { airgappedBlock } from "./airGap.js";
import { getCompanyRoot, getProject, loadOrg } from "./org.js";

// Project knowledge graph (graphify phase 2).
//
// PURPOSE: agents currently re-read whole repos to get context. That is slow and
// burns tokens. `extractProjectKnowledge` walks a project rootDir once, records the
// file inventory + top-level symbols + markdown headings, and compresses it into a
// single `digest` string (<= 4000 chars). `projectContext(projectId)` returns that
// digest, cached on disk, so an enhancer/manager/coder prompt can carry the whole
// project shape in a few hundred tokens instead of thousands of lines of source.
//
// The real `graphify` CLI is used as the primary extractor when present on PATH;
// on ANY failure (missing, non-zero exit, unparseable output, timeout) we fall back
// to the built-in deterministic walker. This module therefore has zero runtime
// dependencies and works with or without graphify installed.
//
// Determinism contract: for an unchanged project, two extractions produce an
// identical `digest` (no timestamps, no absolute paths, stable sort order). Only
// `generatedAt` differs between runs.

export type ProjectKnowledge = {
  projectId: string;
  rootDir: string;
  generatedAt: string;
  fileCount: number;
  files: Array<{ path: string; bytes: number; kind: string }>;
  symbols: Array<{ file: string; symbol: string; kind: string }>;
  headings: Array<{ file: string; text: string }>;
  digest: string;
};

export type RefreshReport = {
  projectId: string;
  fileCount: number;
  symbols: number;
  headings: number;
  digestChars: number;
  ms: number;
  cachePath: string;
  extractor: "graphify" | "graphify-graph" | "builtin" | "none";
  issues: string[];
};

// ---------------------------------------------------------------- limits

const DIGEST_LIMIT = 4000;
const MAX_FILES = 5000;
const MAX_DEPTH = 12;
const MAX_SCAN_BYTES = 256 * 1024; // do not read giant files for symbols
const DIGEST_FILE_ROWS = 400;
const DIGEST_SYMBOL_ROWS = 400;
const DIGEST_HEADING_ROWS = 200;
const CACHE_VERSION = 1;

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".nuxt",
  ".venv", "venv", "__pycache__", ".turbo", ".cache", ".pytest_cache", ".mypy_cache",
]);

// ---------------------------------------------------------------- helpers

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

export function classify(file: string): string {
  const ext = path.extname(file).toLowerCase();
  switch (ext) {
    case ".ts": case ".tsx": case ".mts": case ".cts": return "ts";
    case ".js": case ".mjs": case ".cjs": case ".jsx": return "js";
    case ".md": case ".mdx": return "md";
    case ".json": return "json";
    case ".css": case ".scss": case ".less": return "css";
    case ".html": case ".htm": return "html";
    case ".py": return "py";
    case ".sh": case ".ps1": case ".bat": case ".cmd": return "script";
    case ".yml": case ".yaml": case ".toml": case ".ini": case ".env": return "config";
    case ".txt": case ".log": case ".csv": return "text";
    case ".png": case ".jpg": case ".jpeg": case ".gif": case ".svg": case ".ico": case ".webp": return "image";
    case ".pdf": return "pdf";
    case ".lock": return "lock";
    default: return ext ? "other" : "other";
  }
}

type WalkedFile = { rel: string; abs: string; bytes: number; mtimeMs: number; kind: string };

// Deterministic depth-first walk (sorted entries, skip-list dirs, no symlink following).
function walkRoot(rootDir: string): { files: WalkedFile[]; issues: string[]; truncated: boolean } {
  const files: WalkedFile[] = [];
  const issues: string[] = [];
  let truncated = false;

  let rootStat: fs.Stats;
  try {
    rootStat = fs.statSync(rootDir);
  } catch (e) {
    return { files, issues: [`rootDir unreadable (${rootDir}): ${msg(e)}`], truncated: false };
  }
  if (!rootStat.isDirectory()) {
    return { files, issues: [`rootDir is not a directory: ${rootDir}`], truncated: false };
  }

  const stack: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      issues.push(`unreadable dir ${toPosix(path.relative(rootDir, dir)) || "."}: ${msg(e)}`);
      continue;
    }
    // Sort descending because we pop from the end: yields ascending order overall.
    entries.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const isDir = ent.isDirectory();
      const isFile = ent.isFile();
      if (ent.isSymbolicLink()) continue; // avoid cycles
      if (isDir) {
        if (SKIP_DIRS.has(ent.name) || depth >= MAX_DEPTH) continue;
        stack.push({ dir: abs, depth: depth + 1 });
        continue;
      }
      if (!isFile) continue;
      if (files.length >= MAX_FILES) {
        truncated = true;
        break;
      }
      try {
        const st = fs.statSync(abs);
        files.push({
          rel: toPosix(path.relative(rootDir, abs)),
          abs,
          bytes: st.size,
          mtimeMs: st.mtimeMs,
          kind: classify(abs),
        });
      } catch (e) {
        issues.push(`unreadable file ${toPosix(path.relative(rootDir, abs))}: ${msg(e)}`);
      }
    }
    if (truncated) break;
  }

  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { files, issues, truncated };
}

// Cheap freshness signature: path + size + mtime of every walked file.
function signatureOf(files: WalkedFile[]): string {
  const h = crypto.createHash("sha256");
  for (const f of files) h.update(`${f.rel}\u0000${f.bytes}\u0000${Math.floor(f.mtimeMs)}\n`);
  return h.digest("hex");
}

const SYMBOL_PATTERNS: Array<{ re: RegExp; kind: string }> = [
  { re: /^[ \t]*export[ \t]+default[ \t]+(?:async[ \t]+)?function[ \t]+([A-Za-z_$][\w$]*)/gm, kind: "function" },
  { re: /^[ \t]*export[ \t]+default[ \t]+class[ \t]+([A-Za-z_$][\w$]*)/gm, kind: "class" },
  { re: /^[ \t]*export[ \t]+(?:async[ \t]+)?function[ \t]+([A-Za-z_$][\w$]*)/gm, kind: "function" },
  { re: /^[ \t]*export[ \t]+class[ \t]+([A-Za-z_$][\w$]*)/gm, kind: "class" },
  { re: /^[ \t]*export[ \t]+(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)/gm, kind: "const" },
  { re: /^[ \t]*export[ \t]+(?:type|interface|enum)[ \t]+([A-Za-z_$][\w$]*)/gm, kind: "type" },
  { re: /^[ \t]*(?:async[ \t]+)?function[ \t]+([A-Za-z_$][\w$]*)/gm, kind: "function" },
  { re: /^[ \t]*class[ \t]+([A-Za-z_$][\w$]*)/gm, kind: "class" },
];

function scanSource(text: string): Array<{ symbol: string; kind: string }> {
  const out: Array<{ symbol: string; kind: string }> = [];
  const seen = new Set<string>();
  for (const { re, kind } of SYMBOL_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const sym = m[1];
      if (!sym || seen.has(sym)) continue;
      seen.add(sym);
      out.push({ symbol: sym, kind });
    }
  }
  return out;
}

function scanHeadings(text: string): string[] {
  const out: string[] = [];
  const re = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const title = m[2].trim();
    if (title) out.push(title);
  }
  return out;
}

// ---------------------------------------------------------------- digest

function buildDigest(args: {
  projectId: string;
  projectName?: string;
  rootDir: string;
  files: Array<{ path: string; bytes: number; kind: string }>;
  symbols: Array<{ file: string; symbol: string; kind: string }>;
  headings: Array<{ file: string; text: string }>;
  extractor: string;
  issues: string[];
}): string {
  const { files, symbols, headings, issues } = args;
  const header = [
    `# PROJECT KNOWLEDGE: ${args.projectId}${args.projectName ? ` (${args.projectName})` : ""}`,
    `rootDir: ${args.rootDir}`,
    `extractor: ${args.extractor}`,
    `files: ${files.length}  symbols: ${symbols.length}  headings: ${headings.length}`,
    `Use this digest as project context. Read a file only if you must edit it.`,
  ];

  const chunks: string[] = [];

  if (files.length) {
    chunks.push("", "## FILES");
    for (const f of files.slice(0, DIGEST_FILE_ROWS)) chunks.push(`  ${f.path} [${f.kind}, ${f.bytes}b]`);
    if (files.length > DIGEST_FILE_ROWS) chunks.push(`  ... ${files.length - DIGEST_FILE_ROWS} more files`);
  }

  if (symbols.length) {
    chunks.push("", "## SYMBOLS (top-level)");
    for (const s of symbols.slice(0, DIGEST_SYMBOL_ROWS)) chunks.push(`  ${s.file}: ${s.symbol} (${s.kind})`);
    if (symbols.length > DIGEST_SYMBOL_ROWS) chunks.push(`  ... ${symbols.length - DIGEST_SYMBOL_ROWS} more symbols`);
  }

  if (headings.length) {
    chunks.push("", "## HEADINGS");
    for (const h of headings.slice(0, DIGEST_HEADING_ROWS)) chunks.push(`  ${h.file}: ${h.text}`);
    if (headings.length > DIGEST_HEADING_ROWS) chunks.push(`  ... ${headings.length - DIGEST_HEADING_ROWS} more headings`);
  }

  if (issues.length) {
    chunks.push("", "## ISSUES");
    for (const i of issues.slice(0, 20)) chunks.push(`  ${i}`);
  }

  let out = header.join("\n");
  let truncated = false;
  let dropped = 0;
  for (const c of chunks) {
    const next = `\n${c}`;
    if (out.length + next.length > DIGEST_LIMIT) {
      truncated = true;
      dropped++;
      continue;
    }
    out += next;
  }
  if (truncated) {
    const note = `\n\n[digest truncated at ${DIGEST_LIMIT} chars: ${dropped} section(s)/row(s) omitted]`;
    out = out.slice(0, Math.max(0, DIGEST_LIMIT - note.length)) + note;
  }
  return out;
}

// ---------------------------------------------------------------- graphify CLI

let graphifyProbe: { checked: boolean; bin: string | null; why: string; retryAt?: number } = { checked: false, bin: null, why: "not probed" };

// PERF (2026-09-29): the "exists but --help failed" branch below used to leave
// `checked: false`, so EVERY later call re-ran `execFileSync(<candidate>,
// ["--help"], {timeout: 15000})` for every candidate - a synchronous child
// process on the request path, i.e. a blocked event loop. A failed probe is now
// remembered like a successful one and only retried after this long, so a
// transient failure (busy venv, temporary lock) still recovers.
const PROBE_RETRY_MS = 5 * 60 * 1000;

// Locate a real `graphify` executable. Never installs anything.
// Checks, in order: GRAPHIFY_BIN, the project venv (where the CEO-approved
// `pip install graphifyy` lives: deps\venv\Scripts\graphify.exe), then PATH.
export function findGraphify(): { bin: string | null; why: string } {
  const retryDue = graphifyProbe.retryAt !== undefined && Date.now() >= graphifyProbe.retryAt;
  if (graphifyProbe.checked && !retryDue) return { bin: graphifyProbe.bin, why: graphifyProbe.why };

  const candidates: string[] = [];
  if (process.env.GRAPHIFY_BIN) candidates.push(process.env.GRAPHIFY_BIN);

  const exts = process.platform === "win32" ? [".exe", ""] : [""];
  for (const venv of ["deps/venv", "deps/.venv", ".venv", "venv"]) {
    for (const binDir of ["Scripts", "bin"]) {
      for (const ext of exts) candidates.push(path.join(process.cwd(), venv, binDir, `graphify${ext}`));
    }
  }

  const pathExts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const ext of pathExts) candidates.push(path.join(dir, "graphify" + ext.toLowerCase()), path.join(dir, "graphify" + ext));
  }

  // PERF (2026-09-30): this loop used to run
  //   execFileSync(<candidate>, ["--help"], { timeout: 15000 })
  // for every candidate ON THE CALLING THREAD, i.e. up to 15 s of frozen event loop
  // per candidate before one answered. It now only stats the candidates (no process
  // at all) and lets the ASYNC runner validate the binary: a binary that exists but
  // cannot run is remembered by noteGraphifyFailure() and retried after PROBE_RETRY_MS.
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) {
        graphifyProbe = { checked: true, bin: c, why: `found at ${c} (validated on first async run)` };
        return { bin: c, why: graphifyProbe.why };
      }
    } catch {
      continue;
    }
  }
  graphifyProbe = {
    checked: true,
    bin: null,
    why: process.env.GRAPHIFY_BIN
      ? `GRAPHIFY_BIN=${process.env.GRAPHIFY_BIN} not found; not on PATH`
      : "not found on PATH (no graphify executable)",
  };
  return { bin: graphifyProbe.bin, why: graphifyProbe.why };
}

type GraphifyParse = { files: Array<{ path: string; bytes: number; kind: string }>; symbols: Array<{ file: string; symbol: string; kind: string }>; headings: Array<{ file: string; text: string }> };

// Tolerant parser: accepts a single JSON document or JSONL, and normalises several
// plausible node shapes. Returns null when nothing usable came back (-> fallback).
function parseGraphifyOutput(stdout: string, rootDir: string): GraphifyParse | null {
  const docs: Array<Record<string, unknown>> = [];
  try {
    docs.push(JSON.parse(stdout) as Record<string, unknown>);
  } catch {
    for (const line of stdout.split(/\r?\n/)) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try {
        docs.push(JSON.parse(t) as Record<string, unknown>);
      } catch {
        /* skip partial */
      }
    }
  }
  if (!docs.length) return null;

  const files: GraphifyParse["files"] = [];
  const symbols: GraphifyParse["symbols"] = [];
  const headings: GraphifyParse["headings"] = [];
  const seenFile = new Set<string>();

  const relOf = (p: unknown): string | null => {
    if (typeof p !== "string" || !p) return null;
    const abs = path.isAbsolute(p) ? p : path.join(rootDir, p);
    const rel = toPosix(path.relative(rootDir, abs));
    return rel.startsWith("..") ? toPosix(p) : rel;
  };

  const pushNode = (n: Record<string, unknown>) => {
    const rel = relOf(n.path ?? n.file ?? n.filePath ?? n.relativePath);
    const kindRaw = typeof n.kind === "string" ? n.kind : undefined;
    const symbol = typeof n.symbol === "string" ? n.symbol : typeof n.name === "string" ? n.name : undefined;
    if (rel && kindRaw === "heading" && typeof n.text === "string") {
      headings.push({ file: rel, text: n.text });
      return;
    }
    if (rel && symbol && kindRaw && kindRaw !== "file") {
      symbols.push({ file: rel, symbol, kind: kindRaw });
      if (!seenFile.has(rel)) {
        seenFile.add(rel);
        files.push({ path: rel, bytes: 0, kind: classify(rel) });
      }
      return;
    }
    if (rel && kindRaw === "heading" && symbol) {
      headings.push({ file: rel, text: symbol });
      return;
    }
    if (rel && !seenFile.has(rel)) {
      seenFile.add(rel);
      files.push({ path: rel, bytes: typeof n.bytes === "number" ? n.bytes : 0, kind: classify(rel) });
    }
  };

  for (const d of docs) {
    const nodes =
      (Array.isArray(d.files) ? d.files : undefined) ??
      (Array.isArray(d.nodes) ? d.nodes : undefined) ??
      (Array.isArray(d.entries) ? d.entries : undefined);
    if (Array.isArray(nodes)) for (const n of nodes) if (n && typeof n === "object") pushNode(n as Record<string, unknown>);

    for (const key of ["symbols", "headings"]) {
      const arr = d[key];
      if (Array.isArray(arr)) {
        for (const n of arr) {
          if (n && typeof n === "object") {
            const o = n as Record<string, unknown>;
            if (key === "headings") {
              const rel = relOf(o.file ?? o.path);
              const text = typeof o.text === "string" ? o.text : typeof o.title === "string" ? o.title : undefined;
              if (rel && text) headings.push({ file: rel, text });
            } else {
              const rel = relOf(o.file ?? o.path);
              const sym = typeof o.symbol === "string" ? o.symbol : typeof o.name === "string" ? o.name : undefined;
              if (rel && sym) {
                symbols.push({ file: rel, symbol: sym, kind: typeof o.kind === "string" ? o.kind : "symbol" });
                if (!seenFile.has(rel)) {
                  seenFile.add(rel);
                  files.push({ path: rel, bytes: 0, kind: classify(rel) });
                }
              }
            }
          }
        }
      }
    }
  }

  if (!files.length && !symbols.length && !headings.length) return null;

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const dedupe = <T extends { file: string }>(arr: T[], key: (x: T) => string): T[] => {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const x of arr.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))) {
      const k = key(x);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(x);
    }
    return out;
  };
  return {
    files,
    symbols: dedupe(symbols, (s) => `${s.file}\u0000${s.symbol}`),
    headings: dedupe(headings, (h) => `${h.file}\u0000${h.text}`),
  };
}

async function tryGraphifyAsync(rootDir: string): Promise<{ parsed: GraphifyParse; bin: string } | null> {
  const { bin } = findGraphify();
  if (!bin) return null;
  // AIR-GAP (PERF item 7 review fix 2): graphify's semantic pass calls a hosted LLM
  // (GRAPHIFY_BACKEND: openai/claude) when a semantic key is set. The local-only
  // builtin walker source is fine - so under AIR_GAPPED=1 the CLI child is refused
  // here and extraction continues via the walker the caller falls back to.
  if (airgappedBlock("fleet-agent", `graphify extract ${rootDir}`)) return null;
  const variants: string[][] = [
    ["extract", rootDir, "--json"],
    ["extract", rootDir],
    ["--json", "extract", rootDir],
  ];
  const timeoutMs = graphifySyncTimeoutMs();
  let lastErr = "";
  for (const args of variants) {
    const res = await spawnCapture(bin, args, timeoutMs);
    if (res.code !== 0) {
      lastErr = res.err.trim().slice(0, 200);
      continue;
    }
    const parsed = parseGraphifyOutput(res.out, rootDir);
    if (parsed) return { parsed, bin };
  }
  // Exists but never produced usable output: stop paying for it every TTL.
  if (lastErr) noteGraphifyFailure(`${bin} produced no usable output: ${lastErr}`);
  return null;
}

const MAX_GRAPHIFY_OUT = 64 * 1024 * 1024;

/**
 * Run a child to completion (or its deadline) WITHOUT ever blocking the event loop.
 * This is the whole point of the 2026-09-30 fix: the previous execFileSync version
 * stopped every timer and every HTTP response for as long as graphify ran.
 */
function spawnCapture(bin: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let out = "";
    let err = "";
    let child: ReturnType<typeof spawn>;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out, err });
    };
    const timer = setTimeout(() => {
      try {
        child?.kill();
      } catch {
        /* already gone */
      }
      finish(-1);
    }, Math.max(1000, timeoutMs));
    timer.unref?.();
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      noteGraphifyFailure(`${bin} could not start: ${msg(e)}`);
      finish(-1);
      return;
    }
    child.stdout?.on("data", (d) => {
      out += d.toString();
      if (out.length > MAX_GRAPHIFY_OUT) {
        try {
          child?.kill();
        } catch {
          /* gone */
        }
        finish(-1);
      }
    });
    child.stderr?.on("data", (d) => {
      err += d.toString();
    });
    child.on("error", (e) => {
      noteGraphifyFailure(`${bin} failed: ${msg(e)}`);
      finish(-1);
    });
    child.on("close", (code) => finish(code ?? -1));
  });
}

/** Remember a binary that exists but does not work, so we stop re-trying it. */
function noteGraphifyFailure(why: string): void {
  graphifyProbe = { checked: true, bin: null, why: why.slice(0, 300), retryAt: Date.now() + PROBE_RETRY_MS };
}

// PERF (docs/PERF_SPEC.md item 5). The call above WAS a SYNCHRONOUS child process:
// the whole event loop stopped for as long as graphify took, and the timeout
// allowed 120 s across THREE variants, i.e. up to 360 s with /health and static
// files queued behind it. A CPU profile of the polling replay caught it three
// times, the worst one as
//   spawn <- spawnSync <- execFileSync <- tryGraphify <- extractProjectKnowledge
//   <- projectContext <- stages <- runPipeline
// i.e. 1.4 s of blocked event loop inside one pipeline stage, and the result was
// then DISCARDED because the prebuilt company-memory graph won (see the caller).
// Changes, none of which change the extraction result:
//   * the caller only runs this when the prebuilt graph produced nothing;
//   * the outcome (including "nothing") is reused per rootDir for CLI_CACHE_MS;
//   * (2026-09-30) the spawn is ASYNC on a real child process, so a slow or wedged
//     graphify can no longer freeze the event loop; a cold cache now returns the
//     builtin walker for this call and upgrades to the CLI result on a later call.
const DEFAULT_GRAPHIFY_SYNC_TIMEOUT_MS = 120_000;
const DEFAULT_CLI_CACHE_MS = 5 * 60 * 1000;

function graphifySyncTimeoutMs(): number {
  const raw = Number(process.env.GRAPHIFY_SYNC_TIMEOUT_MS ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_GRAPHIFY_SYNC_TIMEOUT_MS;
}

function cliCacheMs(): number {
  const raw = Number(process.env.GRAPHIFY_CLI_CACHE_MS ?? "");
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_CLI_CACHE_MS;
}

const cliCache = new Map<string, { at: number; value: { parsed: GraphifyParse; bin: string } | null }>();
const cliInFlight = new Set<string>();

/**
 * Synchronous by contract, and deliberately so: it NEVER runs the CLI itself.
 * A fresh cache hit is returned as-is. Otherwise the refresh is handed to
 * tryGraphifyAsync() and THIS call falls back to whatever we already had (usually
 * null, i.e. the builtin walker), so a cold cache costs a caller nothing but a
 * worse extractor for one call. That is what keeps extractProjectKnowledge() sync
 * for its callers while making it impossible for graphify to freeze the loop.
 */
function tryGraphifyCached(rootDir: string): { parsed: GraphifyParse; bin: string } | null {
  const ttl = cliCacheMs();
  const now = Date.now();
  const hit = cliCache.get(rootDir);
  if (hit && ttl > 0 && now - hit.at < ttl) return hit.value;
  scheduleGraphifyRefresh(rootDir);
  return hit ? hit.value : null;
}

/**
 * One async graphify run per rootDir at a time, result written back into cliCache.
 *
 * GUARD (2026-09-30): GRAPHIFY_MAX_CONCURRENT caps how many heavy CLI children may be
 * alive at once, default 1. The old synchronous code ran exactly one at a time by
 * construction, so going async must not turn a burst of N cold rootDirs into N
 * concurrent Python processes on a box that is already short of RAM. Over the cap this
 * call simply does not schedule; the TTL means a later caller retries.
 */
function graphifyMaxConcurrent(): number {
  const raw = Number(process.env.GRAPHIFY_MAX_CONCURRENT ?? "");
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1;
}

function scheduleGraphifyRefresh(rootDir: string): void {
  if (cliInFlight.has(rootDir)) return;
  if (cliInFlight.size >= graphifyMaxConcurrent()) return;
  cliInFlight.add(rootDir);
  void tryGraphifyAsync(rootDir)
    .catch(() => null)
    .then((value) => {
      if (cliCache.size >= 64 && !cliCache.has(rootDir)) {
        const oldest = cliCache.keys().next();
        if (!oldest.done) cliCache.delete(oldest.value);
      }
      cliCache.set(rootDir, { at: Date.now(), value });
    })
    .finally(() => {
      cliInFlight.delete(rootDir);
    });
}

// ---------------------------------------------------------------- prebuilt graph

// The company memory rebuild (src/company/memory.ts) leaves a REAL graphify graph at
// company/memory/graphify-out/graph.json covering this repo's src/ and docs/ plus
// every project rootDir. Reading it costs one file read (no process spawn, no CLI
// guesswork), so it is preferred over re-running graphify for every projectContext()
// call. Absent or unreadable, everything falls back to the CLI and then the builtin
// walker exactly as before.
function memoryGraphFile(): string {
  return path.join(getCompanyRoot(), "memory", "graphify-out", "graph.json");
}

type RawGraphNode = { id?: unknown; label?: unknown; source_file?: unknown; file_type?: unknown };

let prebuiltCache: { mtimeMs: number; nodes: RawGraphNode[] } | null = null;

function loadPrebuiltNodes(): { nodes: RawGraphNode[]; mtimeMs: number } | null {
  try {
    const file = memoryGraphFile();
    const mtimeMs = fs.statSync(file).mtimeMs;
    if (prebuiltCache && prebuiltCache.mtimeMs === mtimeMs) return { nodes: prebuiltCache.nodes, mtimeMs };
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { nodes?: unknown };
    if (!Array.isArray(raw.nodes) || !raw.nodes.length) return null;
    const nodes = raw.nodes.filter((n): n is RawGraphNode => Boolean(n) && typeof n === "object");
    prebuiltCache = { mtimeMs, nodes };
    return { nodes, mtimeMs };
  } catch {
    return null;
  }
}

// graphify stores source_file relative to the scanned root, which is not this
// project's rootDir, so a node is matched by exact path, then unambiguous basename,
// then suffix.
function matchWalkedRel(src: string, rels: Set<string>, byBase: Map<string, string | null>): string | null {
  const clean = toPosix(src).replace(/^\.\//, "");
  if (rels.has(clean)) return clean;
  const base = clean.split("/").pop() ?? clean;
  const viaBase = byBase.get(base);
  if (viaBase) return viaBase;
  for (const rel of rels) {
    if (rel.endsWith(`/${clean}`) || clean.endsWith(`/${rel}`)) return rel;
  }
  return null;
}

type PrebuiltHit = {
  symbols: Array<{ file: string; symbol: string; kind: string }>;
  headings: Array<{ file: string; text: string }>;
  builtAt: string;
  nodes: number;
};

function tryPrebuiltGraph(walked: WalkedFile[]): PrebuiltHit | null {
  const loaded = loadPrebuiltNodes();
  if (!loaded) return null;

  const rels = new Set(walked.map((f) => f.rel));
  const byBase = new Map<string, string | null>();
  for (const rel of rels) {
    const base = rel.split("/").pop() ?? rel;
    byBase.set(base, byBase.has(base) ? null : rel); // null = ambiguous
  }

  const symbols: PrebuiltHit["symbols"] = [];
  const headings: PrebuiltHit["headings"] = [];
  const seen = new Set<string>();

  for (const n of loaded.nodes) {
    const src = typeof n.source_file === "string" ? n.source_file : "";
    const label = typeof n.label === "string" ? n.label : typeof n.id === "string" ? n.id : "";
    if (!src || !label) continue;
    const rel = matchWalkedRel(src, rels, byBase);
    if (!rel) continue;
    const fileType = typeof n.file_type === "string" ? n.file_type : "code";
    const base = src.split("/").pop() ?? src;
    if (label === base || label === src) continue; // the file node itself
    const key = `${rel}\u0000${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (fileType === "doc") headings.push({ file: rel, text: label });
    else
      symbols.push({
        file: rel,
        symbol: label,
        kind: label.endsWith("()") ? "function" : /^[A-Z]/.test(label) ? "class-or-type" : "symbol",
      });
  }

  if (!symbols.length && !headings.length) return null;
  symbols.sort((a, b) => (a.file + a.symbol < b.file + b.symbol ? -1 : 1));
  headings.sort((a, b) => (a.file + a.text < b.file + b.text ? -1 : 1));
  return { symbols, headings, builtAt: new Date(loaded.mtimeMs).toISOString(), nodes: loaded.nodes.length };
}

// ---------------------------------------------------------------- core

function minimalKnowledge(projectId: string, rootDir: string, issue: string): ProjectKnowledge {
  const digest = buildDigest({
    projectId,
    rootDir,
    files: [],
    symbols: [],
    headings: [],
    extractor: "none",
    issues: [issue],
  });
  return { projectId, rootDir, generatedAt: new Date().toISOString(), fileCount: 0, files: [], symbols: [], headings: [], digest };
}

// Never throws: a missing/unreadable project yields a minimal object whose digest
// records the problem, so a caller can always safely paste the digest into a prompt.
// `opts.force` is a hint for callers that deliberately want a cold extraction (the
// extractor is already unconditional; the flag exists so caching can be added inside
// here later without changing any call site).
export function extractProjectKnowledge(projectId: string, opts: { force?: boolean } = {}): ProjectKnowledge {
  void opts;
  let project = undefined as ReturnType<typeof getProject>;
  try {
    project = getProject(projectId);
  } catch (e) {
    return minimalKnowledge(projectId, "", `org.json unreadable: ${msg(e)}`);
  }
  if (!project) return minimalKnowledge(projectId, "", `project not found in org.json: ${projectId}`);

  const rootDir = project.rootDir;
  try {
    const walked = walkRoot(rootDir);
    const issues = [...walked.issues];

    let files: ProjectKnowledge["files"];
    let symbols: ProjectKnowledge["symbols"];
    let headings: ProjectKnowledge["headings"];
    let extractor: "graphify" | "graphify-graph" | "builtin";

    // Preferred order: the company memory graph (real graphify output, already built,
    // free to read) -> a fresh graphify CLI run -> the builtin walker.
    // PERF: tryGraphify() below the "else" used to run BEFORE this check, i.e. every
    // call paid for a synchronous `graphify extract` child process even when the
    // prebuilt graph was about to win and the CLI result was thrown away.
    const prebuilt = tryPrebuiltGraph(walked.files);
    if (prebuilt) {
      extractor = "graphify-graph";
      files = walked.files.map((f) => ({ path: f.rel, bytes: f.bytes, kind: f.kind }));
      symbols = prebuilt.symbols;
      headings = prebuilt.headings;
      issues.push(
        `symbols/headings from the company memory graph (${prebuilt.nodes} nodes, built ${prebuilt.builtAt}); ` +
          `file inventory from disk (${walked.files.length} files)`,
      );
      if (walked.truncated) issues.push(`file walk truncated at ${MAX_FILES} files`);
    } else {
      // Only now is the CLI considered at all: it is a synchronous child process
      // (see tryGraphifyCached), and it is only reached when the prebuilt company
      // memory graph produced nothing.
      const graphify = tryGraphifyCached(rootDir);
      if (graphify) {
        extractor = "graphify";
        files = graphify.parsed.files.map((f) => {
          let bytes = f.bytes;
          if (!bytes) {
            try {
              bytes = fs.statSync(path.join(rootDir, f.path)).size;
            } catch {
              bytes = 0;
            }
          }
          return { path: f.path, bytes, kind: f.kind };
        });
        symbols = graphify.parsed.symbols;
        headings = graphify.parsed.headings;
      } else {
        extractor = "builtin";
        files = walked.files.map((f) => ({ path: f.rel, bytes: f.bytes, kind: f.kind }));
        symbols = [];
        headings = [];
        for (const f of walked.files) {
          if (f.kind !== "ts" && f.kind !== "js" && f.kind !== "md") continue;
          if (f.bytes > MAX_SCAN_BYTES) {
            issues.push(`skipped symbol scan (${f.bytes}b > ${MAX_SCAN_BYTES}b): ${f.rel}`);
            continue;
          }
          let text: string;
          try {
            text = fs.readFileSync(f.abs, "utf8");
          } catch (e) {
            issues.push(`unreadable file ${f.rel}: ${msg(e)}`);
            continue;
          }
          if (f.kind === "md") {
            for (const text_ of scanHeadings(text)) headings.push({ file: f.rel, text: text_ });
          } else {
            for (const s of scanSource(text)) symbols.push({ file: f.rel, symbol: s.symbol, kind: s.kind });
          }
        }
        if (walked.truncated) issues.push(`file walk truncated at ${MAX_FILES} files`);
      }
    }

    const digest = buildDigest({
      projectId,
      projectName: project.name,
      rootDir,
      files,
      symbols,
      headings,
      extractor,
      issues,
    });

    return {
      projectId,
      rootDir,
      generatedAt: new Date().toISOString(),
      fileCount: files.length,
      files,
      symbols,
      headings,
      digest,
    };
  } catch (e) {
    // Absolute safety net: knowledge extraction must never break a pipeline run.
    return minimalKnowledge(projectId, rootDir, `extraction failed: ${msg(e)}`);
  }
}

// ---------------------------------------------------------------- cache

export function knowledgeCachePath(projectId: string): string {
  return path.join(getCompanyRoot(), "projects", projectId, "knowledge.json");
}

type CacheEnvelope = { version: number; signature: string; extractor: string; knowledge: ProjectKnowledge };

function readCache(file: string): CacheEnvelope | null {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as CacheEnvelope;
    if (!raw || typeof raw !== "object" || raw.version !== CACHE_VERSION || !raw.knowledge?.digest) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeCache(file: string, env: CacheEnvelope): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(env, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    // Cache is an optimisation only; a read-only disk must not fail the call.
  }
}

// The knowledge digest also depends on the memory graph (symbols come from it when
// it is available), so the graph's mtime is part of the cache key: a graph rebuild
// regenerates the digests instead of serving a stale symbol list.
function graphSignature(): string {
  try {
    return `g${Math.round(fs.statSync(memoryGraphFile()).mtimeMs)}`;
  } catch {
    return "g0";
  }
}

// The digest an agent should read instead of the files. Cached at
// company/projects/<id>/knowledge.json and regenerated when the project (or the
// memory graph the symbols came from) changes.
export function projectContext(projectId: string, maxChars = DIGEST_LIMIT): string {
  try {
    const project = getProject(projectId);
    if (!project) return extractProjectKnowledge(projectId).digest.slice(0, maxChars);

    const file = knowledgeCachePath(projectId);
    const walked = walkRoot(project.rootDir);
    const signature = `${signatureOf(walked.files)}|${graphSignature()}`;
    const cached = readCache(file);

    if (cached && cached.signature === signature) {
      return cached.knowledge.digest.slice(0, maxChars);
    }

    const knowledge = extractProjectKnowledge(projectId, { force: true });
    // Recompute the signature after extraction so the cache reflects the state the
    // digest was built from (files may have changed mid-extraction).
    const post = walkRoot(project.rootDir);
    writeCache(file, {
      version: CACHE_VERSION,
      signature: `${signatureOf(post.files)}|${graphSignature()}`,
      extractor: extractorOf(knowledge.digest),
      knowledge,
    });
    return knowledge.digest.slice(0, maxChars);
  } catch {
    return minimalKnowledge(projectId, "", "projectContext failed unexpectedly").digest.slice(0, maxChars);
  }
}

function extractorOf(digest: string): "graphify" | "graphify-graph" | "builtin" | "none" {
  if (/^extractor: graphify-graph$/m.test(digest)) return "graphify-graph";
  if (/^extractor: graphify$/m.test(digest)) return "graphify";
  if (/^extractor: none$/m.test(digest)) return "none";
  return "builtin";
}

// Force a fresh extraction for every project in org.json, reporting timing.
export function refreshAllProjects(projectIds?: string[]): RefreshReport[] {
  const reports: RefreshReport[] = [];
  let ids: string[];
  try {
    ids = projectIds ?? loadOrg().projects.map((p) => p.id);
  } catch {
    return reports;
  }

  for (const projectId of ids) {
    const t0 = Date.now();
    // Works identically whether or not the project exists: an unknown/ broken project
    // still yields a digest (the failure is written into it) and a cache file, so the
    // report and any agent prompt agree on what the knowledge looks like.
    const knowledge = extractProjectKnowledge(projectId, { force: true });
    const cachePath = knowledgeCachePath(projectId);

    let project = undefined as ReturnType<typeof getProject>;
    try {
      project = getProject(projectId);
    } catch {
      project = undefined;
    }

    let signature = "unavailable";
    if (project) {
      try {
        signature = `${signatureOf(walkRoot(project.rootDir).files)}|${graphSignature()}`;
      } catch {
        signature = "unavailable";
      }
    }
    const extractor = extractorOf(knowledge.digest);
    writeCache(cachePath, { version: CACHE_VERSION, signature, extractor, knowledge });

    const issueSection = knowledge.digest.includes("## ISSUES")
      ? knowledge.digest.slice(knowledge.digest.indexOf("## ISSUES"))
      : "";
    const issueLines = issueSection
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && l !== "## ISSUES")
      .slice(0, 5);
    reports.push({
      projectId,
      fileCount: knowledge.fileCount,
      symbols: knowledge.symbols.length,
      headings: knowledge.headings.length,
      digestChars: knowledge.digest.length,
      ms: Date.now() - t0,
      cachePath,
      extractor,
      issues: issueLines,
    });
  }
  return reports;
}
