import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getCompanyRoot } from "./org.js";

// Provider subscription quota — the REAL constraint on this company.
//
// The dashboard's per-agent USD numbers (budget.ts DEFAULT_ALLOCATION_USD, e.g.
// coder $5, manager $3, assistant $3 -> the "$80.50 budget" headline) are a
// VIRTUAL policy cap this codebase invented. They are not money and not a
// provider limit: no card is charged when an "allocation" is exhausted, and the
// cap is just an internal throttle.
//
// The constraints that actually stop work are subscription quota windows:
//   - Anthropic (Claude) Pro: a rolling 5-hour window and a 7-day window. When
//     they fill, calls 429 (see claudeSubscription.ts) and roles fall back.
//   - OpenCode Go (one API key): a key validity state plus locally measured spend.
//   - OpenAI (ChatGPT): quota is only visible while the OAuth token refreshes.
// Everything in this module is either read from a provider/CLI directly
// ("cli"), measured from our own recorded per-call costs ("measured"), or
// explicitly reported as unavailable with a reason. No percentage is invented.

const execFileAsync = promisify(execFile);

export type UsageWindow = {
  label: string;
  usedPct?: number;
  resetsIn?: string;
  note?: string;
};

export type ProviderUsage = {
  provider: string;
  source: "cli" | "measured" | "unavailable";
  plan?: string;
  windows?: UsageWindow[];
  measuredSpendUsd?: number;
  calls?: number;
  detail: string;
  capturedAt: string;
};

export type MeasuredModelSpend = { model: string; calls: number; costUsd: number };

// ---------------------------------------------------------------------------
// Masking — provider CLIs hand back account identity. Never let it leave here.
// ---------------------------------------------------------------------------
// Strip terminal color codes so probe output is copy-pasteable.
const ANSI_RE = /\u001b\[[0-9;]*m/g;

export function maskSensitive(text: string): string {
  return String(text ?? "")
    .replace(ANSI_RE, "")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<redacted-email>")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      "<redacted-id>",
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, "$1<redacted-token>")
    .replace(/("(?:access|refresh)_token"\s*:\s*")[^"]+(")/gi, "$1<redacted-token>$2");
}

// ---------------------------------------------------------------------------
// CLI runner
// ---------------------------------------------------------------------------
type CliResult = { ok: boolean; stdout: string; stderr: string; error?: string };

// Static args only — never interpolate user input into a shell command.
// On Windows, jcode is a real .exe but opencode/claude are .cmd shims, so we
// deliberately go through cmd.exe (/d /s /c) rather than shell:true — same
// result without Node's DEP0190 arg-concatenation warning.
const IS_WIN = process.platform === "win32";

async function runCli(cmd: string, args: string[], timeoutMs = 25_000): Promise<CliResult> {
  const file = IS_WIN ? (process.env.ComSpec || "cmd.exe") : cmd;
  const argv = IS_WIN ? ["/d", "/s", "/c", cmd, ...args] : args;
  try {
    const { stdout, stderr } = await execFileAsync(file, argv, {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true, stdout: String(stdout), stderr: String(stderr) };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: String(err.stdout ?? ""),
      stderr: String(err.stderr ?? ""),
      error: String(err.message ?? e),
    };
  }
}

// ---------------------------------------------------------------------------
// jcode usage --json parsing
// ---------------------------------------------------------------------------
type JcodeLimit = { name?: string; usage_percent?: number; resets_at?: string; reset_in?: string };
type JcodeProvider = {
  provider_name?: string;
  limits?: JcodeLimit[];
  extra_info?: Array<[string, string]> | Record<string, string>;
  error?: string | null;
};
type JcodeDoc = { providers?: JcodeProvider[] };

function normalizeInfo(
  info: JcodeProvider["extra_info"],
): Array<{ key: string; value: string }> {
  if (!info) return [];
  if (Array.isArray(info)) {
    return info
      .filter((pair) => Array.isArray(pair) && pair.length >= 2)
      .map((pair) => ({ key: String(pair[0]), value: String(pair[1]) }));
  }
  return Object.entries(info).map(([key, value]) => ({ key, value: String(value) }));
}

function parseSpendLine(value: string | undefined): { today?: number; month?: number; allTime?: number } | undefined {
  if (!value) return undefined;
  const grab = (label: string) => {
    const m = value.match(new RegExp("\\$([0-9]+(?:\\.[0-9]+)?)\\s+" + label, "i"));
    return m ? Number(m[1]) : undefined;
  };
  const out = { today: grab("today"), month: grab("(?:this )?month"), allTime: grab("all-time") };
  if (out.today === undefined && out.month === undefined && out.allTime === undefined) return undefined;
  return out;
}

async function readClaudePlan(): Promise<string | undefined> {
  const res = await runCli("claude", ["auth", "status"], 15_000);
  if (!res.ok || !res.stdout.trim()) return undefined;
  try {
    const j = JSON.parse(res.stdout) as { subscriptionType?: string; loggedIn?: boolean };
    if (j.loggedIn === false) return "not logged in";
    return j.subscriptionType ? String(j.subscriptionType) : undefined;
  } catch {
    return undefined;
  }
}

function detailFor(
  windows: UsageWindow[],
  info: Array<{ key: string; value: string }>,
  spend: { today?: number; month?: number; allTime?: number } | undefined,
): string {
  const parts: string[] = [];
  for (const w of windows) {
    parts.push(
      w.usedPct !== undefined
        ? `${w.label}: ${w.usedPct}% used${w.resetsIn ? `, resets in ${w.resetsIn}` : ""}`
        : `${w.label}${w.resetsIn ? `: resets in ${w.resetsIn}` : ""}`,
    );
  }
  for (const { key, value } of info) parts.push(`${key}: ${value}`);
  if (spend && spend.allTime !== undefined) parts.push(`measured local spend all-time: $${spend.allTime.toFixed(2)}`);
  if (parts.length === 0) return "No quota windows exposed by this provider.";
  return parts.join("; ");
}

function toWindow(l: JcodeLimit): UsageWindow {
  const w: UsageWindow = { label: String(l.name ?? "window") };
  if (typeof l.usage_percent === "number" && Number.isFinite(l.usage_percent)) w.usedPct = l.usage_percent;
  if (l.reset_in) w.resetsIn = String(l.reset_in);
  else if (l.resets_at) w.resetsIn = `until ${String(l.resets_at)}`;
  return w;
}

// ---------------------------------------------------------------------------
// BUDGET (docs/BUDGET_SPEC.md §1): the REAL remaining allowance per provider.
//
// Before this section the module could only say "OpenCode Go: key valid, local
// spend $1.17" — the number that actually stops work (how much of the monthly
// allowance is left) lives on OpenCode's website. The probe in
// ops/budget-go-probe.ts found the least fragile source, and it is source (a)
// from the spec: the Go API surface answers quota for the SAME key this company
// already uses, read-only:
//
//   GET https://opencode.ai/zen/go/v1/usage      (Authorization: Bearer <OPENCODE_API_KEY>)
//   {"usage":{"rolling":{"status":"ok","percent":63,"resetsAt":"…Z"},
//             "weekly":{...},"monthly":{...}}}
//
// `rolling` is Go's 5-hour window (docs: 5-hour = 20% of the monthly limit,
// weekly = 50%, monthly = 100%), so the binding number is the worst of the
// three: remainingPct = 100 - max(percent).
//
// Fallbacks, in the spec's order:
//   (b) the JSON behind the console page, called with a session cookie the CEO
//       pastes into OPENCODE_SESSION_COOKIE themselves (never automated, never
//       logged, never printed);
//   (c) if neither is available: connected:false and the literal instruction
//       "not connected: add OPENCODE_SESSION_COOKIE" — never a guessed number.
//
// Hard rules honoured here: read-only GETs, no login is ever automated, the key
// and cookie are only ever placed in a header (maskSensitive() covers anything
// that comes back), and neither value is written to any file, log or response.
// ---------------------------------------------------------------------------

export type GoWindowName = "5-hour" | "weekly" | "monthly";

export type GoQuotaWindow = {
  window: GoWindowName;
  usedPct: number;
  remainingPct: number;
  resetsAt?: string;
  resetsIn?: string;
  status?: string;
};

export type GoQuota = {
  /** true only when a real percentage was read from OpenCode. */
  connected: boolean;
  source: "api" | "cookie" | "unavailable";
  plan?: string;
  windows: GoQuotaWindow[];
  /** the binding (worst) window: what a worker can still spend right now. */
  remainingPct?: number;
  usedPct?: number;
  bindingWindow?: GoWindowName;
  resetsAt?: string;
  detail: string;
  checkedAt: string;
};

export type ClaudeQuota = {
  connected: boolean;
  source: "cli" | "unavailable";
  plan?: string;
  windows: Array<{ label: string; usedPct?: number; remainingPct?: number; resetsAt?: string; resetsIn?: string }>;
  /** the binding window here too (the 5-hour window normally binds first). */
  remainingPct?: number;
  usedPct?: number;
  bindingWindow?: string;
  resetsAt?: string;
  resetIn?: string;
  detail: string;
  checkedAt: string;
};

/** "3h 18m" from an ISO timestamp (or a jcode "reset_in" string passthrough). */
export function humanizeUntil(iso?: string, from: Date = new Date()): string | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return undefined;
  let s = Math.round((t - from.getTime()) / 1000);
  if (s <= 0) return "now";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.round((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${Math.max(1, m)}m`;
}

const GO_WINDOW_LABELS: Record<string, GoWindowName> = {
  rolling: "5-hour",
  "5-hour": "5-hour",
  "5_hour": "5-hour",
  fiveHour: "5-hour",
  weekly: "weekly",
  week: "weekly",
  monthly: "monthly",
  month: "monthly",
};

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Tolerant reader for the Go quota payload: accepts the documented
 * `{usage:{rolling,weekly,monthly}}` shape, a flat `{rolling,…}`, or a console
 * payload that nests it under `data`. Unknown keys are ignored; a window with no
 * usable percent is dropped rather than guessed.
 */
export function parseGoQuotaPayload(body: unknown): GoQuotaWindow[] {
  const root = (body ?? {}) as Record<string, unknown>;
  const candidates: Array<Record<string, unknown>> = [];
  const push = (v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) candidates.push(v as Record<string, unknown>);
  };
  push(root);
  push(root.usage);
  push(root.data);
  push((root.data as Record<string, unknown> | undefined)?.usage);

  const out = new Map<GoWindowName, GoQuotaWindow>();
  for (const src of candidates) {
    for (const [key, raw] of Object.entries(src)) {
      const label = GO_WINDOW_LABELS[key];
      if (!label || out.has(label)) continue;
      const w = (raw ?? {}) as Record<string, unknown>;
      const used = num(w.percent ?? w.usedPct ?? w.used_percent ?? w.usage_percent);
      if (used === undefined) continue;
      const clamped = Math.max(0, Math.min(100, used));
      const resetsAt = String(w.resetsAt ?? w.resets_at ?? w.reset_at ?? "") || undefined;
      out.set(label, {
        window: label,
        usedPct: roundPct(clamped),
        remainingPct: roundPct(100 - clamped),
        resetsAt,
        resetsIn: humanizeUntil(resetsAt),
        status: w.status === undefined ? undefined : String(w.status),
      });
    }
  }
  const order: GoWindowName[] = ["5-hour", "weekly", "monthly"];
  return order.map((w) => out.get(w)).filter((w): w is GoQuotaWindow => !!w);
}

function bindingOf(
  windows: Array<{ label?: string; window?: string; remainingPct?: number; resetsAt?: string; resetsIn?: string }>,
  now: Date,
): { binding?: { label: string; remainingPct: number; resetsAt?: string; resetsIn?: string }; remainingPct?: number } {
  const withRemaining = windows.filter((w) => typeof w.remainingPct === "number");
  if (withRemaining.length === 0) return {};
  const worst = withRemaining.reduce((a, b) => (a.remainingPct! <= b.remainingPct! ? a : b));
  const label = String(worst.window ?? worst.label ?? "window");
  // Prefer a live countdown over a stale stored string.
  const resetsIn = humanizeUntil(worst.resetsAt, now) ?? worst.resetsIn;
  return {
    binding: { label, remainingPct: roundPct(worst.remainingPct!), resetsAt: worst.resetsAt, resetsIn },
    remainingPct: roundPct(worst.remainingPct!),
  };
}

/** URL of the Go quota endpoint: explicit override, else derived from the gateway base. */
function goUsageUrl(): string {
  const explicit = (process.env.BUDGET_GO_USAGE_URL ?? "").trim();
  if (explicit) return explicit;
  const base = (process.env.GATEWAY_BASE_URL ?? "https://opencode.ai/zen/go/v1").trim().replace(/\/+$/, "");
  return `${base}/usage`;
}

async function httpGetJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 15_000,
): Promise<{ ok: boolean; status?: number; json?: unknown; text: string; error?: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: "GET", headers, redirect: "manual", signal: ac.signal });
    const text = await r.text().catch(() => "");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { ok: r.ok, status: r.status, json, text };
  } catch (e) {
    return { ok: false, text: "", error: String((e as Error)?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Console JSON endpoints tried with the CEO's pasted session cookie (spec path b). */
const COOKIE_CANDIDATES = [
  "https://opencode.ai/zen/go/v1/usage",
  "https://opencode.ai/api/console/go/usage",
  "https://opencode.ai/api/console/usage",
];

export function openCodeGoNotConnectedDetail(): string {
  return (
    "not connected: add OPENCODE_SESSION_COOKIE. The key-only quota endpoint " +
    "(GET https://opencode.ai/zen/go/v1/usage) needs OPENCODE_API_KEY, and the cookie fallback needs " +
    "OPENCODE_SESSION_COOKIE. To get it: sign in to https://opencode.ai/auth in your browser, open " +
    "DevTools > Application > Cookies > https://opencode.ai, copy the session cookie (name=value) and " +
    "paste it as OPENCODE_SESSION_COOKIE=... in .env yourself. No login is ever automated and no secret is logged."
  );
}

/**
 * OpenCode Go remaining allowance. Source (a) is the key-based API; (b) is the
 * console JSON with the CEO's cookie; otherwise connected:false + instructions.
 */
export async function openCodeGoUsage(opts?: { fresh?: boolean }): Promise<GoQuota> {
  const ttl = (() => {
    const raw = Number(process.env.BUDGET_GO_CACHE_MS);
    return Number.isFinite(raw) && raw >= 0 ? raw : 60_000;
  })();
  if (opts?.fresh !== true && goCache && Date.now() - Date.parse(goCache.checkedAt) < ttl) return goCache;

  const res = await readGoQuota();
  goCache = res;
  if (res.connected) writeGoQuotaSnapshot(res);
  return res;
}

let goCache: GoQuota | null = null;

/**
 * The cached OpenCode Go snapshot, synchronously, for the routing POLICY
 * (src/company/deepseekDirect.ts). `null` means "never measured on this process";
 * the caller applies its own staleness rule (a snapshot older than ~15 min is treated
 * as UNKNOWN). No I/O here: this only reads the value `openCodeGoUsage()` already cached.
 */
export function openCodeGoUsageCached(): GoQuota | null {
  return goCache;
}

/** Test seam: set the cached Go snapshot (ops/deepseek-policy-check.ts). */
export function setGoUsageCache(snapshot: GoQuota | null): void {
  goCache = snapshot;
}

/**
 * company/adaptive/go-quota.json — the LAST KNOWN Go snapshot. Persisting it means a restart
 * with a cold cache is not blind (CEO order 2026-10-02: an unknown Go quota must not send work
 * to OpenCode blind). Small json, atomic tmp+rename, mirroring the adaptive estimates.json
 * helper. Never throws, and holds only window percentages + timestamps (no secret).
 */
export function goQuotaSnapshotPath(): string {
  return path.join(getCompanyRoot(), "adaptive", "go-quota.json");
}

function writeGoQuotaSnapshot(snap: GoQuota): void {
  const file = goQuotaSnapshotPath();
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(snap));
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Load the persisted last-known Go snapshot into the synchronous cache at boot. Accepts only a
 * connected snapshot with a numeric remainingPct; anything else leaves the cache untouched.
 * The normal staleness rule in deepseekDirect.ts still applies, so an old file reads as UNKNOWN.
 */
export function loadGoQuotaSnapshot(): GoQuota | null {
  try {
    const snap = JSON.parse(fs.readFileSync(goQuotaSnapshotPath(), "utf8")) as GoQuota;
    if (!snap || snap.connected !== true || typeof snap.remainingPct !== "number") return null;
    goCache = snap;
    return snap;
  } catch {
    return null;
  }
}

async function readGoQuota(): Promise<GoQuota> {
  const checkedAt = new Date().toISOString();
  const now = new Date();
  const key = (process.env.OPENCODE_API_KEY ?? "").trim();
  const cookie = (process.env.OPENCODE_SESSION_COOKIE ?? "").trim();
  const url = goUsageUrl();
  const problems: string[] = [];

  if (key) {
    const r = await httpGetJson(url, {
      authorization: `Bearer ${key}`,
      accept: "application/json",
      "user-agent": "local-ai-company-budget/1.0",
    });
    const windows = r.ok ? parseGoQuotaPayload(r.json) : [];
    if (windows.length > 0) {
      const b = bindingOf(windows, now);
      return {
        connected: true,
        source: "api",
        windows,
        remainingPct: b.remainingPct,
        usedPct: roundPct(100 - (b.remainingPct ?? 0)),
        bindingWindow: b.binding?.label as GoWindowName | undefined,
        resetsAt: b.binding?.resetsAt,
        detail:
          `OpenCode Go (API key, read-only): ` +
          windows.map((w) => `${w.window} ${w.remainingPct}% left${w.resetsIn ? ` (resets in ${w.resetsIn})` : ""}`).join("; ") +
          `. Binding window: ${b.binding?.label} (${b.binding?.remainingPct}% left).`,
        checkedAt,
      };
    }
    problems.push(r.ok ? `${url} answered ${r.status ?? 200} without quota windows` : `${url} -> ${r.error ?? `HTTP ${r.status}`}`);
  } else {
    problems.push("OPENCODE_API_KEY is not set");
  }

  if (cookie) {
    for (const candidate of COOKIE_CANDIDATES) {
      const r = await httpGetJson(candidate, { cookie, accept: "application/json, text/html;q=0.9" });
      const windows = r.ok ? parseGoQuotaPayload(r.json) : [];
      if (windows.length > 0) {
        const b = bindingOf(windows, now);
        return {
          connected: true,
          source: "cookie",
          windows,
          remainingPct: b.remainingPct,
          usedPct: roundPct(100 - (b.remainingPct ?? 0)),
          bindingWindow: b.binding?.label as GoWindowName | undefined,
          resetsAt: b.binding?.resetsAt,
          detail:
            `OpenCode Go (console session cookie, read-only): ` +
            windows.map((w) => `${w.window} ${w.remainingPct}% left`).join("; ") +
            `. Binding window: ${b.binding?.label}.`,
          checkedAt,
        };
      }
    }
    problems.push("OPENCODE_SESSION_COOKIE is set but no candidate endpoint returned quota (cookie may be stale)");
  }

  return {
    connected: false,
    source: "unavailable",
    windows: [],
    detail: `${openCodeGoNotConnectedDetail()} (probe: ${problems.join("; ")})`,
    checkedAt,
  };
}

// ---------------------------------------------------------------------------
// Claude windows, cached for 2 minutes (docs/BUDGET_SPEC.md §1: "reuse jcode
// usage --json --no-update ... async, never on the request path. Cache it for 2
// minutes"). The same cache serves providerUsage(), so a dashboard poll and the
// budget watcher never stack CLI runs.
// ---------------------------------------------------------------------------
const PROVIDER_CACHE_MS = (() => {
  const raw = Number(process.env.USAGE_CACHE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 120_000;
})();

type CachedDoc = { doc: JcodeDoc | undefined; raw: string; ok: boolean; at: number };
let docCache: CachedDoc | null = null;

async function readJcodeUsageDoc(fresh = false): Promise<CachedDoc> {
  if (!fresh && docCache && Date.now() - docCache.at < PROVIDER_CACHE_MS) return docCache;
  const res = await runCli("jcode", ["usage", "--json", "--no-update"]);
  let doc: JcodeDoc | undefined;
  try {
    doc = JSON.parse(res.stdout) as JcodeDoc;
  } catch {
    doc = undefined;
  }
  docCache = {
    doc,
    raw: res.stdout.trim() || res.stderr.trim() || res.error || "",
    ok: res.ok,
    at: Date.now(),
  };
  return docCache;
}

/**
 * The real Claude subscription windows (5-hour + 7-day) from `jcode usage
 * --json --no-update`, cached for 2 minutes. Never throws: an unreachable CLI
 * comes back as connected:false with the reason.
 */
export async function readClaudeQuota(opts?: { fresh?: boolean }): Promise<ClaudeQuota> {
  const checkedAt = new Date().toISOString();
  const now = new Date();
  const cache = await readJcodeUsageDoc(opts?.fresh === true);
  const providers = Array.isArray(cache.doc?.providers) ? cache.doc!.providers! : [];
  const p = providers.find((x) => /claude|anthropic/i.test(String(x.provider_name ?? "")));
  if (!p) {
    return {
      connected: false,
      source: "unavailable",
      windows: [],
      detail:
        "Claude windows unavailable: `jcode usage --json --no-update` did not report an Anthropic provider" +
        (cache.ok ? "." : ` (${maskSensitive(cache.raw).slice(0, 200) || "no output"}).`),
      checkedAt,
    };
  }
  const windows = (p.limits ?? []).map((l) => {
    const used = typeof l.usage_percent === "number" && Number.isFinite(l.usage_percent) ? l.usage_percent : undefined;
    const resetsAt = l.resets_at ? String(l.resets_at) : undefined;
    return {
      label: String(l.name ?? "window"),
      usedPct: used === undefined ? undefined : roundPct(used),
      remainingPct: used === undefined ? undefined : roundPct(100 - used),
      resetsAt,
      resetsIn: humanizeUntil(resetsAt, now) ?? (l.reset_in ? String(l.reset_in) : undefined),
    };
  });
  if (p.error || windows.length === 0) {
    return {
      connected: false,
      source: "unavailable",
      windows,
      detail: `Claude windows unavailable: ${p.error ? maskSensitive(String(p.error)) : "no quota windows reported"}.`,
      checkedAt,
    };
  }
  const b = bindingOf(windows, now);
  const plan = await readClaudePlan();
  return {
    connected: true,
    source: "cli",
    plan,
    windows,
    remainingPct: b.remainingPct,
    usedPct: b.remainingPct === undefined ? undefined : roundPct(100 - b.remainingPct),
    bindingWindow: b.binding?.label,
    resetsAt: b.binding?.resetsAt,
    resetIn: b.binding?.resetsIn,
    detail:
      `Claude subscription (jcode usage --json --no-update): ` +
      windows
        .map((w) => `${w.label} ${w.usedPct ?? "?"}% used${w.resetsIn ? `, resets in ${w.resetsIn}` : ""}`)
        .join("; ") +
      `. Binding window: ${b.binding?.label} (${b.binding?.remainingPct}% left).`,
    checkedAt,
  };
}

/**
 * Real provider quota as reported by the local CLIs.
 *
 * Sources: `jcode usage --json` (Anthropic/OpenAI/OpenCode quota + key state),
 * `claude auth status` (plan). If a provider exposes no quota endpoint, the entry
 * is returned with source "unavailable" and the concrete reason, never a guess.
 * Pass `{fresh:true}` to bypass the 2-minute cache.
 */
export async function providerUsage(opts?: { fresh?: boolean }): Promise<ProviderUsage[]> {
  const capturedAt = new Date().toISOString();
  const cache = await readJcodeUsageDoc(opts?.fresh === true);
  const res = { ok: cache.ok, stdout: cache.doc ? JSON.stringify(cache.doc) : "", stderr: "", error: cache.ok ? undefined : cache.raw };
  const raw = cache.raw;

  let doc: JcodeDoc;
  try {
    doc = cache.doc ?? (JSON.parse(res.stdout) as JcodeDoc);
  } catch {
    return [
      {
        provider: "provider-usage-cli",
        source: "unavailable",
        detail: `Could not read provider quota: \`jcode usage --json\` ${
          res.ok ? "returned no parseable JSON" : "failed"
        } (${maskSensitive(raw).slice(0, 400) || "no output"}).`,
        capturedAt,
      },
    ];
  }

  const providers = Array.isArray(doc.providers) ? doc.providers : [];
  if (providers.length === 0) {
    return [
      {
        provider: "provider-usage-cli",
        source: "unavailable",
        detail: "`jcode usage --json` returned zero providers (no providers connected?).",
        capturedAt,
      },
    ];
  }

  const claudePlan = await readClaudePlan();
  const out: ProviderUsage[] = [];

  for (const p of providers) {
    const provider = String(p.provider_name ?? "unknown provider");
    const windows = (p.limits ?? []).map(toWindow);
    const info = normalizeInfo(p.extra_info).map((kv) => ({
      key: kv.key,
      value: maskSensitive(kv.value),
    }));

    if (p.error) {
      out.push({
        provider,
        source: "unavailable",
        plan: /claude/i.test(provider) ? claudePlan : undefined,
        windows: windows.length > 0 ? windows : undefined,
        detail: `Quota unavailable: ${maskSensitive(String(p.error))}`,
        capturedAt,
      });
      continue;
    }

    const spendLine = info.find((kv) => /local spend/i.test(kv.key))?.value;
    const spend = parseSpendLine(spendLine);
    const plan = /claude/i.test(provider) ? claudePlan : undefined;

    // BUDGET: the Go row gets the REAL remaining allowance. Before this the CLI
    // only offered key validity + local spend, so the row showed no window at
    // all (`windows` empty); the API key this company already holds answers the
    // actual quota, so the row now carries it (and says so in `detail`).
    let windows2 = windows;
    let detail = detailFor(windows, info, spend);
    if (/opencode/i.test(provider) && !/claude/i.test(provider)) {
      const go = await openCodeGoUsage();
      if (go.connected && go.windows.length > 0) {
        windows2 = go.windows.map((w) => ({
          label: `${w.window} window`,
          usedPct: w.usedPct,
          resetsIn: w.resetsIn,
          note: `${w.remainingPct}% left`,
        }));
        detail = `${detail} | Real quota (OpenCode Go API, read-only): ${go.windows
          .map((w) => `${w.window} ${w.remainingPct}% left`)
          .join(", ")}`;
      } else if (/cookie/i.test(go.detail)) {
        detail = `${detail} | ${go.detail}`;
      }
    }

    out.push({
      provider,
      source: "cli",
      plan,
      windows: windows2.length > 0 ? windows2 : undefined,
      measuredSpendUsd: spend?.allTime,
      detail,
      capturedAt,
    });
  }

  // Our own per-call ledger as its own row: the only spend number here that is
  // measured rather than a policy cap.
  const measured = measuredSpendByModel();
  if (measured.length > 0) {
    const calls = measured.reduce((n, m) => n + m.calls, 0);
    const costUsd = round6(measured.reduce((n, m) => n + m.costUsd, 0));
    out.push({
      provider: "Local cost ledger (measured per call)",
      source: "measured",
      measuredSpendUsd: costUsd,
      calls,
      detail:
        `${calls} recorded calls, $${costUsd.toFixed(6)} total -> ` +
        measured.map((m) => `${m.model}: ${m.calls} calls $${m.costUsd.toFixed(6)}`).join("; ") +
        ". opencode runs carry the runtime's own per-call cost; router roles use a flat per-run estimate.",
      capturedAt,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Our own measured spend, per model, from the per-project cost ledgers
// (company/projects/<id>/cost.jsonl — one line per real model call, with the
// cost the provider/opencode reported for that call).
// ---------------------------------------------------------------------------
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Percentages are shown to two decimals: 100 - 15.000001 reads as 84.999999 otherwise. */
function roundPct(n: number): number {
  return Math.round(n * 100) / 100;
}

function latestSessionsByModel(): MeasuredModelSpend[] {
  const file = path.join(getCompanyRoot(), "sessions.jsonl");
  if (!fs.existsSync(file)) return [];
  const latest = new Map<string, { model: string; costUsd: number }>();
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec: { id?: string; model?: string; costUsd?: number };
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec.id) continue;
    const prev = latest.get(rec.id);
    latest.set(rec.id, {
      model: String(rec.model ?? prev?.model ?? "unknown"),
      costUsd: typeof rec.costUsd === "number" ? rec.costUsd : (prev?.costUsd ?? 0),
    });
  }
  const agg = new Map<string, { calls: number; costUsd: number }>();
  for (const { model, costUsd } of latest.values()) {
    const cur = agg.get(model) ?? { calls: 0, costUsd: 0 };
    cur.calls += 1;
    cur.costUsd += costUsd;
    agg.set(model, cur);
  }
  return [...agg.entries()]
    .map(([model, v]) => ({ model, calls: v.calls, costUsd: round6(v.costUsd) }))
    .sort((a, b) => b.costUsd - a.costUsd);
}

export function measuredSpendByModel(): MeasuredModelSpend[] {
  const agg = new Map<string, { calls: number; costUsd: number }>();
  const projectsDir = path.join(getCompanyRoot(), "projects");

  let projectIds: string[] = [];
  try {
    projectIds = fs.readdirSync(projectsDir);
  } catch {
    projectIds = [];
  }

  for (const pid of projectIds) {
    const file = path.join(projectsDir, pid, "cost.jsonl");
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      let e: { modelId?: string; model?: string; costUsd?: number };
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const model = String(e.modelId ?? e.model ?? "unknown");
      const cost = Number(e.costUsd ?? 0);
      const cur = agg.get(model) ?? { calls: 0, costUsd: 0 };
      cur.calls += 1;
      if (Number.isFinite(cost)) cur.costUsd += cost;
      agg.set(model, cur);
    }
  }

  if (agg.size === 0) return latestSessionsByModel();

  return [...agg.entries()]
    .map(([model, v]) => ({ model, calls: v.calls, costUsd: round6(v.costUsd) }))
    .sort((a, b) => b.costUsd - a.costUsd);
}

// ---------------------------------------------------------------------------
// Raw evidence for the ops probe (masked).
// ---------------------------------------------------------------------------
export type RawEvidence = { command: string; ok: boolean; output: string };

export async function captureRawEvidence(): Promise<RawEvidence[]> {
  const cmds: Array<{ command: string; argv: string[] }> = [
    { command: "jcode usage --json", argv: ["usage", "--json", "--no-update"] },
    { command: "opencode auth list", argv: ["auth", "list"] },
    { command: "claude auth status", argv: ["auth", "status"] },
  ];
  const out: RawEvidence[] = [];
  for (const c of cmds) {
    const bin = c.command.split(" ")[0]!;
    const res = await runCli(bin, c.argv);
    const body = (res.stdout.trim() || res.stderr.trim() || res.error || "").trim();
    out.push({
      command: c.command,
      ok: res.ok,
      output: maskSensitive(body) || "(no output)",
    });
  }
  return out;
}