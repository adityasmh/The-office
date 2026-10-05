// policy.ts - F10: the fleet's policy file. Protected paths that a work order (or an
// agent) may never change on its own, plus a cap on how many files one work order may
// publish. Read from `policy.json` at the repo root when present, otherwise the built-in
// defaults below apply. Example: policy.example.json.
//
// Shape:
//   { "protectedPaths": [globs], "maxFilesPerWorkOrder": number }
//
// Matching is forward-slash, case-insensitive and supports `*` (any run inside one path
// segment), `**` (any run, including `/`) and `?` (one non-`/` character). A rule with no
// `/` matches the file name anywhere in the tree (so `*.pem` covers `certs/a.pem`). A rule
// prefixed with `!` is an exception and removes the protection a later/earlier rule set.
//
// Node built-ins only; never throws to the caller (a broken file falls back to defaults
// with one warning line).
import fs from "node:fs";
import path from "node:path";

export type Policy = {
  /** glob rules; a `!` prefix is an exception that un-protects a match */
  protectedPaths: string[];
  /** the most paths one work order may publish; more than this is refused */
  maxFilesPerWorkOrder: number;
};

/** The policy file read from the repo root. */
export const POLICY_FILE = "policy.json";

/** Built-in protected paths: secrets, CI, git internals, the policy itself, keys. */
export const DEFAULT_PROTECTED_PATHS: string[] = [
  ".env*",
  "!.env.example", // an example file carries no secret, so it stays editable
  ".github/workflows/**",
  ".git/**",
  "policy.json",
  "*.pem",
  "*.key",
];

/** Built-in cap on how many files one work order may publish. */
export const DEFAULT_MAX_FILES_PER_WORK_ORDER = 20;

/** The built-in policy used when no readable `policy.json` is present. */
export const DEFAULT_POLICY: Policy = {
  protectedPaths: [...DEFAULT_PROTECTED_PATHS],
  maxFilesPerWorkOrder: DEFAULT_MAX_FILES_PER_WORK_ORDER,
};

/** Normalise a path for matching: forward slashes, no leading `./`, lower case, trimmed. */
function normalizePath(p: string): string {
  return String(p ?? "")
    .replace(/\\/g, "/")
    .trim()
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** Turn one glob into an anchored, case-insensitive regular expression. */
function globToRegExp(glob: string): RegExp {
  const g = normalizePath(glob);
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        i += 1;
        // `**/` also matches zero directories, so `a/**/b` matches `a/b`.
        if (g[i + 1] === "/") {
          i += 1;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/** True when `p` matches one glob rule (a slashless rule matches the basename anywhere). */
function matchesGlob(p: string, glob: string): boolean {
  const clean = normalizePath(glob);
  if (!clean) return false;
  const test = globToRegExp(clean);
  if (!clean.includes("/")) {
    const base = p.slice(p.lastIndexOf("/") + 1);
    return test.test(base) || test.test(p);
  }
  return test.test(p);
}

/**
 * The first rule that protects `p`, or null when nothing does. Later `!` rules remove the
 * protection an earlier rule set. Returns the rule text so a refusal can name it.
 */
export function protectedRuleFor(p: string, policy: Policy = DEFAULT_POLICY): string | null {
  const target = normalizePath(p);
  if (!target) return null;
  let rule: string | null = null;
  for (const raw of policy.protectedPaths) {
    const pat = String(raw ?? "").trim();
    if (!pat) continue;
    if (pat.startsWith("!")) {
      if (matchesGlob(target, pat.slice(1))) rule = null;
    } else if (matchesGlob(target, pat)) {
      rule = pat;
    }
  }
  return rule;
}

/** True when `p` is protected and must be changed by a human, not by a work order. */
export function isProtected(p: string, policy: Policy = DEFAULT_POLICY): boolean {
  return protectedRuleFor(p, policy) !== null;
}

/** The subset of `paths` the policy protects, in input order, de-duplicated. */
export function protectedPathsIn(paths: string[], policy: Policy = DEFAULT_POLICY): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(paths) ? paths : []) {
    const p = normalizePath(String(raw ?? ""));
    if (!p || seen.has(p)) continue;
    if (isProtected(p, policy)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

function validGlobs(input: unknown): string[] {
  if (!Array.isArray(input)) throw new Error("protectedPaths must be an array of glob strings");
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string" || raw.trim() === "") throw new Error("protectedPaths must contain only non-empty strings");
    out.push(raw.trim());
  }
  return out;
}

function validMax(input: unknown): number {
  if (typeof input !== "number" || !Number.isInteger(input) || input < 1) {
    throw new Error("maxFilesPerWorkOrder must be a positive integer");
  }
  return input;
}

/**
 * Validate a parsed policy object. Unknown keys are dropped; a missing field falls back to
 * its built-in default. Throws a plain Error when the shape is wrong (loadPolicy turns that
 * into a warning + defaults).
 */
export function parsePolicy(input: unknown): Policy {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("policy must be a JSON object");
  const raw = input as Record<string, unknown>;
  return {
    protectedPaths: raw.protectedPaths === undefined ? [...DEFAULT_PROTECTED_PATHS] : validGlobs(raw.protectedPaths),
    maxFilesPerWorkOrder: raw.maxFilesPerWorkOrder === undefined ? DEFAULT_MAX_FILES_PER_WORK_ORDER : validMax(raw.maxFilesPerWorkOrder),
  };
}

function warn(message: string): void {
  console.warn(`[policy] ${message}`);
}

/**
 * The policy for `repoDir`: `policy.json` when it parses, the built-in defaults otherwise.
 * A missing file is normal (no warning); a present but malformed file warns once and falls
 * back. Never throws.
 */
export function loadPolicy(repoDir: string = process.cwd()): Policy {
  const file = path.join(repoDir, POLICY_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return DEFAULT_POLICY;
  }
  try {
    return parsePolicy(JSON.parse(raw));
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    warn(`${POLICY_FILE} is malformed (${why.slice(0, 160)}): using the built-in defaults`);
    return DEFAULT_POLICY;
  }
}

export type PublishCheck = { ok: true } | { ok: false; reason: string };

/**
 * Decide whether a publish may proceed. Refuses when any path is protected (naming the
 * path and the rule) or when there are more paths than the policy allows (naming the rule).
 * The refusal is a plain sentence: a work order that hits it must stop at the human.
 */
export function checkPublish(paths: string[], policy: Policy = DEFAULT_POLICY): PublishCheck {
  const list = (Array.isArray(paths) ? paths : [])
    .map((p) => normalizePath(String(p ?? "")))
    .filter(Boolean);
  for (const p of list) {
    const rule = protectedRuleFor(p, policy);
    if (rule) {
      return {
        ok: false,
        reason: `refusing to publish "${p}": it matches the protected path rule "${rule}" in the fleet policy, so a human must make this change, not a work order`,
      };
    }
  }
  if (list.length > policy.maxFilesPerWorkOrder) {
    return {
      ok: false,
      reason: `refusing to publish ${list.length} files: the fleet policy rule maxFilesPerWorkOrder allows only ${policy.maxFilesPerWorkOrder}, so this work order must be split or approved by a human`,
    };
  }
  return { ok: true };
}
