import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getCompanyRoot } from "./org.js";

// ── ATTACH: the CEO's attachments (PDF / PNG / JPG / WEBP) ──────────────
// Work order (docs/AGENT_COORDINATION.md, ATTACH 2026-09-29): the assistant page gets
// a paperclip + drag-and-drop, the file lands here, and the assistant is told to open
// and read it before answering.
//
// Two rules this module exists to enforce:
//   1. the TYPE comes from the file's magic bytes, never from the extension or the
//      browser's content-type (a .pdf that is really a script is refused);
//   2. the NAME never reaches the filesystem as given: the stored file is
//      <id>-<safe-name> under uploads/<YYYY-MM-DD>/, where the id is generated here
//      and safe-name has every path separator and odd character stripped (upload id
//      resolution also refuses anything that is not [A-Za-z0-9_-], so a caller cannot
//      walk out of uploads/ with an id like "../../.env").
//
// Files are append-only and recorded in uploads/index.json (id -> record). The index
// is a convenience for resolving ids and for remembering pages/notes; a record whose
// index entry is lost is still recoverable, because the file name carries the id.
//
// No npm dependency: the server reads the raw request body with express.raw (already
// a dependency of this router) and hands the Buffer to saveUpload().

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB per file
export const MAX_UPLOAD_PAGES = 20; // the UI warns above this; the server records the count
export const UPLOAD_ID_RE = /^up_[A-Za-z0-9_-]+$/;
const INDEX_CAP = 500;

export type UploadKind = "pdf" | "png" | "jpg" | "webp";

export type UploadRec = {
  id: string;
  /** Absolute path on this machine (what the assistant's Read tool needs). */
  path: string;
  /** Path relative to the company root, e.g. uploads/2026-09-29/up_x-memo.pdf. */
  rel: string;
  /** The name the CEO's browser sent, sanitised for display. */
  name: string;
  /** MIME type derived from the magic bytes. */
  type: string;
  kind: UploadKind;
  bytes: number;
  pages?: number;
  uploadedAt: string;
  /** Claude's plain-words description of what the file shows, once it has read it. */
  note?: string;
};

type Signature = { kind: UploadKind; type: string; ext: string; test: (b: Buffer) => boolean };

const SIGNATURES: Signature[] = [
  {
    kind: "pdf",
    type: "application/pdf",
    ext: "pdf",
    test: (b) => b.length > 5 && b.subarray(0, 5).toString("latin1") === "%PDF-",
  },
  {
    kind: "png",
    type: "image/png",
    ext: "png",
    // 89 50 4E 47 0D 0A 1A 0A
    test: (b) =>
      b.length > 8 &&
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  {
    kind: "jpg",
    type: "image/jpeg",
    ext: "jpg",
    test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    kind: "webp",
    type: "image/webp",
    ext: "webp",
    test: (b) =>
      b.length > 12 &&
      b.subarray(0, 4).toString("latin1") === "RIFF" &&
      b.subarray(8, 12).toString("latin1") === "WEBP",
  },
];

export const ACCEPTED_TYPES = SIGNATURES.map((s) => s.type).join(", ");

export function uploadsRoot(): string {
  return path.join(getCompanyRoot(), "uploads");
}

function indexFile(): string {
  return path.join(uploadsRoot(), "index.json");
}

/** Magic-byte sniffing. Returns null for anything that is not an accepted type. */
export function sniffType(bytes: Buffer): Signature | null {
  for (const sig of SIGNATURES) {
    try {
      if (sig.test(bytes)) return sig;
    } catch {
      /* a short/odd buffer simply does not match */
    }
  }
  return null;
}

/**
 * A conservative name for the CEO to read: no directories, no separators, no
 * control characters. The extension is forced to the sniffed type, so the stored
 * name always tells the truth about the contents.
 */
export function safeName(raw: string, ext: string): string {
  const base = path.basename(String(raw ?? "").replace(/\\/g, "/"));
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(0, 60);
  const stem = cleaned.replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/\.+$/, "") || "attachment";
  return `${stem}.${ext}`;
}

/** Local-date folder, so the CEO can find yesterday's attachments: uploads/2026-09-29/. */
function dayDir(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------------------------------------------------------------- page count

/**
 * Page count for a PDF, from the file's own structure. Deliberately approximate:
 * PDFs that keep their page tree in compressed object streams report nothing
 * usable, in which case the count is left undefined (the UI then says "pages
 * unknown" instead of inventing a number).
 */
export function pdfPageCount(bytes: Buffer): number | undefined {
  let text = "";
  try {
    text = bytes.subarray(0, Math.min(bytes.length, 4 * 1024 * 1024)).toString("latin1");
  } catch {
    return undefined;
  }
  const pageObjects = (text.match(/\/Type\s*\/Page(?![sA-Za-z])/g) ?? []).length;
  let counted = 0;
  for (const m of text.matchAll(/\/Count\s+(\d+)/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > counted) counted = n;
  }
  const best = Math.max(pageObjects, counted);
  return best > 0 ? best : undefined;
}

/** One image = one page, for the UI's "20 pages/images" warning. */
export function pageEstimate(rec: { kind: UploadKind; pages?: number }): number {
  return rec.kind === "pdf" ? rec.pages ?? 0 : 1;
}

// ---------------------------------------------------------------- the index

function readIndex(): Record<string, UploadRec> {
  try {
    const raw = fs.readFileSync(indexFile(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, UploadRec>;
  } catch {
    /* missing or corrupt: the dated folders are still the source of truth */
  }
  return {};
}

function writeIndex(index: Record<string, UploadRec>): void {
  try {
    fs.mkdirSync(path.dirname(indexFile()), { recursive: true });
    // Cap the index (keep the newest entries) so it cannot grow without bound.
    const ids = Object.keys(index);
    if (ids.length > INDEX_CAP) {
      ids
        .sort((a, b) => String(index[a].uploadedAt).localeCompare(String(index[b].uploadedAt)))
        .slice(0, ids.length - INDEX_CAP)
        .forEach((id) => delete index[id]);
    }
    fs.writeFileSync(indexFile(), JSON.stringify(index, null, 2));
  } catch {
    /* the file on disk is what matters; the index is a convenience */
  }
}

// ---------------------------------------------------------------- save

export type SaveResult =
  | { ok: true; upload: UploadRec }
  | { ok: false; error: string; detail: string; status: number };

export function saveUpload(input: { name?: string; bytes: Buffer }): SaveResult {
  const bytes = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.alloc(0);
  const shown = path.basename(String(input.name ?? "attachment").replace(/\\/g, "/")) || "attachment";
  if (!bytes.length) {
    return { ok: false, error: "empty_file", detail: "the request body was empty", status: 400 };
  }
  if (bytes.length > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      error: "too_large",
      detail: `${shown} is ${(bytes.length / (1024 * 1024)).toFixed(1)} MB; the limit is ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB`,
      status: 413,
    };
  }
  const sig = sniffType(bytes);
  if (!sig) {
    return {
      ok: false,
      error: "unsupported_type",
      detail: `not a PDF/PNG/JPG/WEBP by its magic bytes (only ${ACCEPTED_TYPES} are accepted). The extension is ignored on purpose.`,
      status: 415,
    };
  }

  const id = `up_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
  const name = safeName(String(input.name ?? "attachment").replace(/\.(pdf|png|jpe?g|webp)$/i, `.${sig.ext}`), sig.ext);
  const dir = path.join(uploadsRoot(), dayDir());
  const abs = path.join(dir, `${id}-${name}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(abs, bytes, { flag: "wx" });
  } catch (e) {
    return { ok: false, error: "write_failed", detail: String(e), status: 500 };
  }

  const rec: UploadRec = {
    id,
    path: abs,
    rel: path.relative(getCompanyRoot(), abs).split(path.sep).join("/"),
    name,
    type: sig.type,
    kind: sig.kind,
    bytes: bytes.length,
    uploadedAt: new Date().toISOString(),
  };
  if (sig.kind === "pdf") {
    const pages = pdfPageCount(bytes);
    if (pages !== undefined) rec.pages = pages;
  }
  const index = readIndex();
  index[id] = rec;
  writeIndex(index);
  return { ok: true, upload: rec };
}

// ---------------------------------------------------------------- resolve

/**
 * Look up upload ids (the values the CEO's page sends with the order). Unknown or
 * malformed ids are reported, never guessed at: the assistant says it could not
 * find them instead of silently answering without the file.
 */
export function resolveUploads(ids: unknown): { found: UploadRec[]; missing: string[] } {
  const wanted = (Array.isArray(ids) ? ids : [])
    .map((v) => String(v ?? "").trim())
    .filter(Boolean)
    .slice(0, 20);
  const found: UploadRec[] = [];
  const missing: string[] = [];
  if (!wanted.length) return { found, missing };
  const index = readIndex();
  for (const id of wanted) {
    if (!UPLOAD_ID_RE.test(id)) {
      missing.push(id);
      continue;
    }
    const hit = index[id];
    if (hit?.path && fs.existsSync(hit.path)) {
      found.push(hit);
      continue;
    }
    const recovered = recoverFromDisk(id);
    if (recovered) {
      found.push(recovered);
      index[id] = recovered;
      continue;
    }
    missing.push(id);
  }
  if (found.some((f) => !index[f.id])) writeIndex(index);
  return { found, missing };
}

/**
 * Index-free recovery: the file name starts with the id, so a lost index entry is
 * found by scanning the dated folders (newest first, bounded).
 */
function recoverFromDisk(id: string): UploadRec | null {
  const root = uploadsRoot();
  let days: string[] = [];
  try {
    days = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse()
      .slice(0, 30);
  } catch {
    return null;
  }
  for (const day of days) {
    const dir = path.join(root, day);
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const hit = entries.find((f) => f.startsWith(`${id}-`));
    if (!hit) continue;
    const abs = path.join(dir, hit);
    const name = hit.slice(id.length + 1);
    const sig = SIGNATURES.find((s) => abs.toLowerCase().endsWith(`.${s.ext}`));
    return {
      id,
      path: abs,
      rel: path.relative(getCompanyRoot(), abs).split(path.sep).join("/"),
      name,
      type: sig?.type ?? "application/octet-stream",
      kind: sig?.kind ?? "pdf",
      bytes: (() => {
        try {
          return fs.statSync(abs).size;
        } catch {
          return 0;
        }
      })(),
      uploadedAt: (() => {
        try {
          return fs.statSync(abs).mtime.toISOString();
        } catch {
          return new Date().toISOString();
        }
      })(),
    };
  }
  return null;
}

/** Store Claude's plain-words description of a file (used by the memory note). */
export function setUploadNote(id: string, note: string): void {
  if (!UPLOAD_ID_RE.test(String(id ?? ""))) return;
  const index = readIndex();
  const rec = index[id];
  if (!rec) return;
  rec.note = String(note ?? "").slice(0, 1200);
  writeIndex(index);
}
