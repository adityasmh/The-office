// airGap.ts - PERF item 7: the AIR_GAPPED=1 flag.
//
// What the CEO order asks: AIR_GAPPED=1 makes the router make ZERO outbound calls.
// Nothing may leave the machine: no OpenCode Go gateway, no Claude CLI, no Slack, no
// web, no telemetry. The ONLY permitted outbound calls are to loopback services that
// run on this same box (Laya's /v1/systemone on 127.0.0.1:8000, the local STT/TTS
// servers, and the router itself) - 127.0.0.1 and [::1] are never outbound.
//
// How the guarantee is enforced, in one place: this module replaces globalThis.fetch
// with a counting wrapper. Every fetch in the process goes through it (Node:no
// module can bypass globalThis.fetch once it is installed). In air-gapped mode the
// wrapper throws BEFORE any socket is opened for a non-loopback URL (undefined host
// is treated as non-loopback: DNS names are outbound by definition) and records the
// blocked count. With the flag OFF the wrapper still wraps and counts - but never
// blocks - so behaviour is unchanged and the same counter powers ops/airgap-proof.ts.
//
// CLIs (claude -p via claudeSubscription/spawnFleet*, opencode workers via spawn*)
// are gated where they are called (airgappedBlock("...") boolean checks), because a
// child process can bypass this process's fetch wrapper. The central helper counts
// and reports every one of those gates too, so the proof harness sees both numbers.
//
// The queue: work an air-gapped router cannot handle is NOT failed. Anything that
// asks for a locally served brain (Claude CLI, a hosted gateway model) is queued with
// status "held-air-gapped" (heldQueue()) and shows up on the dashboard panel as an
// "air-gapped" section instead of an error. Nothing is deleted; the same work runs
// normally the moment the flag is turned back off.
import fs from "node:fs";
import path from "node:path";

export type AirGapBlocked = {
  at: string; // ISO timestamp
  kind: "fetch" | AirGapCliKind;
  url: string; // full URL for fetch; the CLI/argv label for CLI gates
  reason: string;
};

const blockedList: AirGapBlocked[] = [];
const MAX_BLOCKED_RECORDS = 200;

// monotonicAt: the ISO stamp must NEVER go backwards, even on Windows where the wall
// clock inside one process can report a smaller millisecond on a later call (measured
// live: two consecutive refusals stamped .739 then .738, which made a time-sorted view
// look like it went "against" order). performance.now() is monotonic; we only bump the
// ISO string forward, never backward, so it stays a real timestamp of the refusal while
// remaining strictly non-decreasing.
let lastAtMs = 0;
function monotonicAt(): string {
  const nowMs = Date.now();
  const stamp = nowMs > lastAtMs ? nowMs : lastAtMs;
  lastAtMs = stamp;
  return new Date(stamp).toISOString();
}

let installed = false;
let origFetch: typeof fetch | null = null;
let blockedFetchCount = 0;
let blockedCliCount = 0;

/** Is this flag on? env reads directly so nothing else in the boot path has to import config first. */
export function airGapped(): boolean {
  return (process.env.AIR_GAPPED ?? "").trim() === "1";
}

/** Loopback means Laya, STT, TTS, our own router, and the 8791/8797/8801/8802 test-port routers. */
export function isLoopbackUrl(rawUrl: string): boolean {
  const host = new URL(rawUrl).hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

function recordBlocked(kind: AirGapBlocked["kind"], url: string, reason: string): void {
  const entry: AirGapBlocked = { at: monotonicAt(), kind, url, reason };
  blockedList.push(entry);
  if (blockedList.length > MAX_BLOCKED_RECORDS) blockedList.shift();
  if (kind === "fetch") blockedFetchCount++;
  else blockedCliCount++;
}

/** Kinds of CLI/subprocess hop the flag can block, besides a plain fetch. */
export type AirGapCliKind = "claude-cli" | "slack" | "opencode-worker" | "fleet-agent";

/** For CLI sites (claude -p, opencode spawn, slack): returns true when the call must NOT run. */
export function airgappedBlock(kind: AirGapCliKind, label: string): boolean {
  if (!airGapped()) return false;
  recordBlocked(kind, label, "AIR_GAPPED=1 blocks CLI subprocess");
  return true;
}

/**
 * AIR-GAP (review fix 1, second half): a CLI gate whose work cannot run locally is
 * QUEUED, not dropped and not failed. Same file as holdUnserved, with the caller's
 * pause-so-we-do-not-recount flag and an explicit label. Returns the held row id.
 */
export function airgappedHoldCli(kind: AirGapCliKind, label: string, queue: string): string {
  const row = holdUnserved(
    `[${kind}] ${label}`,
    "AIR_GAPPED=1: a local model is not installed for this hop",
    queue,
  );
  cliHolds.set(`${kind}:${label}`, row.id);
  return row.id;
}

/** True once this exact CLI hop has been queued, so a caller can pause instead of re-queueing. */
export function airgappedCliHoldPending(kind: AirGapCliKind, label: string): boolean {
  return cliHolds.has(`${kind}:${label}`);
}

/** Delete a pending hold marker once the underlying work has been served and the row removed. */
export function clearAirgappedCliHold(kind: AirGapCliKind, label: string): void {
  cliHolds.delete(`${kind}:${label}`);
}

const cliHolds = new Map<string, string>();

/**
 * Wrap globalThis.fetch so every fetch in the process is counted and, in air-gapped
 * mode, non-loopback URLs are refused before any socket is opened. Idempotent.
 */
export function installAirGapFetchGuard(): { installed: boolean; countedFetches: boolean } {
  if (installed) return { installed: true, countedFetches: true };
  installed = true;
  origFetch = globalThis.fetch.bind(globalThis);
  type G = typeof globalThis & { __origFetch?: typeof fetch };
  (globalThis as G).__origFetch = origFetch;
  const guard = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1], ...rest: number[]) => {
    const depth = rest[0] ?? 0;
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : String((input as Request).url ?? input);
    let target = "";
    try {
      target = new URL(raw).href;
    } catch {
      recordBlocked("fetch", raw, "unparseable URL treated as outbound");
      throw new Error(`air-gap: refusing to fetch unparseable URL ${raw}`);
    }
    if (airGapped() && !isLoopbackUrl(target)) {
      recordBlocked("fetch", target, "AIR_GAPPED=1 blocks non-loopback fetch");
      throw new Error(`air-gap: outbound fetch to ${target} blocked (AIR_GAPPED=1; only loopback is allowed)`);
    }
    // AIR-GAP redirect hardening (adversarial validation 2026-10-01): a loopback URL
    // that 302s to the internet would satisfy the letter of the guard while the socket
    // leaves. In air-gapped mode redirects are followed ONLY within loopback
    // (redirect: "manual" + a re-entry loop through this same check per hop).
    if (airGapped()) {
      const res = await origFetch!(target, { ...init, redirect: "manual" } as RequestInit);
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        const next = new URL(loc, target).href;
        if (!isLoopbackUrl(next)) {
          recordBlocked("fetch", next, "AIR_GAPPED=1 blocks redirect out of loopback");
          throw new Error(`air-gap: redirect from ${target} to ${next} blocked (AIR_GAPPED=1)`);
        }
        // Recurse through the SAME guard for the next hop (depth passed explicitly:
        // a per-call local would reset on every hop and never trip the ceiling).
        if (depth >= 32) throw new Error("air-gap: too many redirects");
        return await guard3(next, init, depth + 1);
      }
      return res;
    }
    return origFetch!(input as string, init);
  }) as unknown;
  type GuardFn = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1], depth?: number) => Promise<Response>;
  globalThis.fetch = guard as typeof fetch;
  const guard3 = guard as GuardFn;
  return { installed: true, countedFetches: false };
}

export function airGapStatus() {
  return { enabled: airGapped(), blockedFetches: blockedFetchCount, blockedClis: blockedCliCount, recentBlocked: blockedList.slice(-25).reverse() };
}

/**
 * Local generation: Laya's /v1/systemone answers via the SAME decision backend the
 * router already uses today, plus deterministic local textCues (src/decision.ts) for
 * anything Laya does not have a question spec for. No hosted call is involved. This
 * is the "Laya + a small local model" path the order names. The local weights on disk
 * (models/qwen3-tts-12hz-0.6b-base) are speech models, and no Ollama / llama.cpp /
 * llama.cpp-class CLI exists on this box, so the interface is stubbed as callLocalModel
 * and every caller uses Laya via the existing config.decisionBackend local backend.
 */
export async function callLocalModel(system: string, prompt: string, maxTokens = 1024) {
  void system;
  void prompt;
  void maxTokens;
  throw new Error(
    "no suitable local generative model is installed on this machine (models/ holds only the Qwen speech " +
      "tokenizer weights, and no Ollama / llama.cpp / llama.cpp-class CLI is present): the local-model " +
      "interface is a stub - this work is queued as held-air-gapped and needs a real local model to serve",
  );
}

/** The held-air-gapped queue: plain JSON on disk so the dashboard can list it. */
type HeldRow = { id: string; text: string; heldAt: string; reason: string; queue: string; status: "held-air-gapped" };
export const heldQueuePath = path.join(process.cwd(), "company", "held-air-gapped.json");
// AIR-GAP (review fix 1): NO cap. The order is "queued ... instead of failing":
// dropping the oldest rows to keep a fixed-size list would silently lose work, and
// the header comment above claims "Nothing is deleted". The queue file is small plain
// JSON (one object per row), so an uncapped append stays cheap and the dashboard
// list can be trimmed at display time instead.
export function holdUnserved(text: string, reason: string, queue: string): HeldRow {
  // (review fix 1b) probe isolation: proof rows must never pollute the REAL queue.
  // A probe sets AIRGAP_PROBE=1 and gets a probe-scoped file instead of the live one.
  // The READ must use the same split, or every append re-reads the (absent) live file
  // and clobbers the probe file down to one row - which is exactly the silent-drop
  // shape this fix removes.
  const target = process.env.AIRGAP_PROBE === "1" ? `${heldQueuePath}.probe` : heldQueuePath;
  let rows: HeldRow[] = [];
  try {
    rows = JSON.parse(fs.readFileSync(target, "utf8")) as HeldRow[];
  } catch {
    /* first entry */
  }
  const row: HeldRow = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, text: text.slice(0, 400), heldAt: new Date().toISOString(), reason, queue, status: "held-air-gapped" as const };
  rows.push(row);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(rows, null, 2));
  return row;
}

/** Any queued work the air-gapped router cannot serve locally, oldest first. The SAME probe split applies. */
export function heldQueue(): HeldRow[] {
  const target = process.env.AIRGAP_PROBE === "1" ? `${heldQueuePath}.probe` : heldQueuePath;
  try {
    return JSON.parse(fs.readFileSync(target, "utf8")) as HeldRow[];
  } catch {
    return [];
  }
}

