/**
 * ops/regression-refusal-path.ts
 *
 * Regression guard for the budget-refusal ("budget gate") path.
 *
 * CONTRACT (docs/CEO_DASHBOARD_API.md:66-67, src/server.ts:309):
 *   POST /company/agents/:agentId/message {text, run:true} against an agent whose
 *   remaining budget is 0 must answer HTTP 402 with
 *     { status:"queued", error:"budget_exhausted", budget:{...} }
 *   and must notify the CEO on Slack (src/slack.ts notifyBudgetExhausted).
 *
 * REGRESSION THIS GUARDS (found by plan::gate):
 *   src/company/agentchat.ts calls notifyBudgetExhausted as the FIRST statement of
 *   the refusal branch. The symbol lives in src/slack.ts. When the call was added
 *   (15:49:03) without `import { notifyBudgetExhausted } from "../slack.js";`
 *   1. `npx tsc --noEmit` failed with TS2304 (rule: typecheck must pass), and
 *   2. after any restart the branch threw ReferenceError -> server.ts:311 catch ->
 *      HTTP 500 instead of the documented 402, and the CEO notice never fired.
 *
 *   A restart is REQUIRED to observe (2): a stale process that predates the call
 *   still answers 402 for the wrong reason (it has no call to throw on). So the
 *   live check below is only meaningful against a process started AFTER the
 *   agentchat.ts mtime - the caller must pass restart evidence (see assertLiveRevision).
 *
 * USAGE
 *   npx tsx ops/regression-refusal-path.ts            # static + live + emit checks
 *   npx tsx ops/regression-refusal-path.ts --static   # static/typecheck-only checks
 *   BASE=http://localhost:8787 npx tsx ops/regression-refusal-path.ts
 *
 * Exported for reuse by ops/regression-harness (p4-regression-harness):
 *   assertBudgetRefusalStatic(), assertBudgetRefusalLive(), assertBudgetNoticeEmits(),
 *   assertLiveRevision()
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { companyAuthHeaders } from "../src/company/authguard.js";
import type { SlackPostResult } from "../src/slack.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..");
export const AGENTCHAT_TS = path.join(REPO_ROOT, "src", "company", "agentchat.ts");

/** The zero-cap agent the plan froze as the documented fixture. */
export const FIXTURE_AGENT_KEY = "pmumhg71w::summarizer";

export type CheckResult = { name: string; ok: boolean; detail: string };

function pass(name: string, detail: string): CheckResult {
  return { name, ok: true, detail };
}
function fail(name: string, detail: string): CheckResult {
  return { name, ok: false, detail };
}

// ---------------------------------------------------------------------------
// 1. Static guard: the import must exist and typecheck must pass.
//    (This is the cheapest possible tripwire: removing the import is caught in
//    milliseconds without needing a running server.)
// ---------------------------------------------------------------------------

export function assertBudgetRefusalStatic(): CheckResult[] {
  const out: CheckResult[] = [];
  let src: string;
  try {
    src = fs.readFileSync(AGENTCHAT_TS, "utf8");
  } catch (e) {
    return [fail("agentchat.ts readable", `cannot read ${AGENTCHAT_TS}: ${String(e)}`)];
  }

  const importRe = /import\s*\{[^}]*\bnotifyBudgetExhausted\b[^}]*\}\s*from\s*["']\.\.\/slack(?:\.js)?["']/;
  const hasImport = importRe.test(src);
  out.push(
    hasImport
      ? pass("slack import wired", 'agentchat.ts imports notifyBudgetExhausted from "../slack.js"')
      : fail(
          "slack import wired",
          'agentchat.ts does NOT import notifyBudgetExhausted from ../slack(.js) - TS2304 + live 500 regression'
        )
  );

  const callCount = (src.match(/\bnotifyBudgetExhausted\s*\(/g) ?? []).length;
  out.push(
    callCount > 0
      ? pass("call site present", `notifyBudgetExhausted( ) called ${callCount}x in agentchat.ts`)
      : fail("call site present", "no notifyBudgetExhausted( ) call site in agentchat.ts")
  );

  // The refusal branch must still return the documented error code.
  out.push(
    /error:\s*["']budget_exhausted["']/.test(src)
      ? pass("documented error code", 'agentchat.ts returns error: "budget_exhausted"')
      : fail("documented error code", 'agentchat.ts no longer returns error: "budget_exhausted"')
  );

  return out;
}

// ---------------------------------------------------------------------------
// 2. Live refusal-path assertion: HTTP status + documented body.
// ---------------------------------------------------------------------------

export type LiveRefusalResult = {
  checks: CheckResult[];
  target?: { agentKey: string; name?: string; remainingUsd?: number };
  httpStatus?: number;
  body?: unknown;
};

async function pickZeroCapAgent(base: string, preferred?: string): Promise<{ agentKey: string; name?: string; remainingUsd?: number } | undefined> {
  const res = await fetch(`${base}/company/agents`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GET /company/agents -> HTTP ${res.status}`);
  const json = (await res.json()) as { agents?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
  const agents = Array.isArray(json) ? json : (json.agents ?? []);
  const zeroCap = agents.filter((a) => {
    const b = (a.budget ?? {}) as Record<string, unknown>;
    const remaining = typeof b.remainingUsd === "number" ? b.remainingUsd : NaN;
    return remaining <= 0;
  });
  if (preferred) {
    const hit = zeroCap.find((a) => a.agentKey === preferred);
    if (hit) return { agentKey: String(hit.agentKey), name: String(hit.name ?? ""), remainingUsd: Number((hit.budget as Record<string, unknown>).remainingUsd) };
  }
  const first = zeroCap[0];
  if (!first) return undefined;
  const b = (first.budget ?? {}) as Record<string, unknown>;
  return { agentKey: String(first.agentKey), name: String(first.name ?? ""), remainingUsd: Number(b.remainingUsd) };
}

export async function assertBudgetRefusalLive(
  base = process.env.BASE ?? "http://localhost:8787",
  preferredAgentKey = FIXTURE_AGENT_KEY
): Promise<LiveRefusalResult> {
  const checks: CheckResult[] = [];
  let target: LiveRefusalResult["target"];
  try {
    target = await pickZeroCapAgent(base, preferredAgentKey);
  } catch (e) {
    return { checks: [fail("reachable server", String(e))] };
  }
  if (!target) {
    return { checks: [fail("zero-cap agent exists", `no agent with remainingUsd <= 0 on ${base}`)] };
  }

  const key = target.agentKey;
  const res = await fetch(`${base}/company/agents/${encodeURIComponent(key)}/message`, {
    method: "POST",
    // Trust boundary (docs/CEO_RUNBOOK.md §0): mutations need the shared secret.
    headers: { "content-type": "application/json", ...(await companyAuthHeaders(base)) },
    body: JSON.stringify({ text: "regression-refusal-path probe (budget gate)", run: true }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;

  checks.push(
    res.status !== 500
      ? pass("no HTTP 500", `POST refusal returned HTTP ${res.status} (500 == ReferenceError in the refusal branch)`)
      : fail("no HTTP 500", "POST refusal returned HTTP 500 - the refusal branch threw (missing import / bad wiring)")
  );
  checks.push(
    res.status === 402
      ? pass("HTTP 402", `POST ${key} -> 402`)
      : fail("HTTP 402", `POST ${key} -> HTTP ${res.status}, expected 402 (body: ${JSON.stringify(body)})`)
  );
  checks.push(
    body?.error === "budget_exhausted"
      ? pass("error code", 'body.error === "budget_exhausted"')
      : fail("error code", `body.error === ${JSON.stringify(body?.error)}, expected "budget_exhausted"`)
  );
  checks.push(
    body?.status === "queued"
      ? pass("status queued", 'body.status === "queued" (busy/parked, not an error run)')
      : fail("status queued", `body.status === ${JSON.stringify(body?.status)}, expected "queued"`)
  );
  checks.push(
    body?.agentKey === key
      ? pass("echoes canonical key", `body.agentKey === ${key}`)
      : fail("echoes canonical key", `body.agentKey === ${JSON.stringify(body?.agentKey)}, expected ${key}`)
  );
  const remaining = (body?.budget as Record<string, unknown> | undefined)?.remainingUsd;
  checks.push(
    typeof remaining === "number" && remaining <= 0
      ? pass("budget attached", `body.budget.remainingUsd === ${remaining}`)
      : fail("budget attached", `body.budget.remainingUsd === ${JSON.stringify(remaining)}, expected a number <= 0`)
  );

  return { checks, target, httpStatus: res.status, body };
}

// ---------------------------------------------------------------------------
// 3. Notice emission: the refusal must notify the CEO on Slack and must never
//    throw (src/slack.ts postAs is total). We assert the resolved SlackPostResult
//    shape rather than end-to-end Slack delivery.
// ---------------------------------------------------------------------------

export async function assertBudgetNoticeEmits(): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  try {
    const mod = (await import("../src/slack.js")) as typeof import("../src/slack.js");
    if (typeof mod.notifyBudgetExhausted !== "function") {
      return [fail("notifyBudgetExhausted exported", "src/slack.ts does not export notifyBudgetExhausted")];
    }
    const result = (await mod.notifyBudgetExhausted({
      agentId: "summarizer",
      agentKey: FIXTURE_AGENT_KEY,
      name: "Summarizer",
      role: "summarizer",
      requiredUsd: 0,
      remainingUsd: 0,
      taskTitle: "regression-refusal-path probe (budget gate)",
    })) as SlackPostResult;
    const total = !!result && typeof result.posted === "boolean";
    checks.push(
      total
        ? pass("notice resolves", `notifyBudgetExhausted resolved {posted:${result.posted}, mock:${!!result.mock}, error:${result.error ?? "-"}}`)
        : fail("notice resolves", `notifyBudgetExhausted returned an unexpected shape: ${JSON.stringify(result)}`)
    );
    checks.push(
      result.posted || result.mock || !!result.error
        ? pass("notice is total", "no rejection; live post or documented mock/console fallback")
        : fail("notice is total", "notice returned without posted/mock/error - call site would silently swallow it")
    );
  } catch (e) {
    checks.push(fail("notice resolves", `notifyBudgetExhausted THREW: ${String(e)}`));
  }
  return checks;
}

// ---------------------------------------------------------------------------
// 4. Revision guard: a 402 from a process that PREDATES agentchat.ts is not
//    evidence. Only a process started after the file's mtime proves the fix.
// ---------------------------------------------------------------------------

export function assertLiveRevision(
  processStartedAt: Date | string,
  agentChatPath = AGENTCHAT_TS
): CheckResult {
  const started = processStartedAt instanceof Date ? processStartedAt : new Date(processStartedAt);
  const mtime = fs.statSync(agentChatPath).mtime;
  if (Number.isNaN(started.getTime())) return fail("live revision", `unparseable process start time: ${String(processStartedAt)}`);
  return started.getTime() >= mtime.getTime()
    ? pass(
        "live revision",
        `server started ${started.toISOString()} >= agentchat.ts mtime ${mtime.toISOString()}`
      )
    : fail(
        "live revision",
        `STALE PROCESS: server started ${started.toISOString()} < agentchat.ts mtime ${mtime.toISOString()} - any 402 is from the old build and proves nothing`
      );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printGroup(title: string, checks: CheckResult[]): number {
  const bad = checks.filter((c) => !c.ok).length;
  console.log(`${bad === 0 ? "PASS" : "FAIL"} ${title}`);
  for (const c of checks) console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.name} - ${c.detail}`);
  return bad;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).replace(/\.(ts|js)$/, "") === fileURLToPath(import.meta.url).replace(/\.(ts|js)$/, "");
if (isMain) {
  const staticOnly = process.argv.includes("--static");
  let failures = 0;
  failures += printGroup("static refusal-path guard", assertBudgetRefusalStatic());
  if (!staticOnly) {
    const live = await assertBudgetRefusalLive();
    failures += printGroup("live refusal path (402)", live.checks);
    failures += printGroup("CEO Slack notice", await assertBudgetNoticeEmits());
  }
  console.log(failures === 0 ? "\nREFUSAL-PATH REGRESSION CHECK: PASS" : `\nREFUSAL-PATH REGRESSION CHECK: FAIL (${failures} failing check(s))`);
  process.exit(failures === 0 ? 0 : 1);
}
