/**
 * ops/needs-you-stale-resolve.ts - close the "Retry this order or drop it?" prompts whose
 * ROOT CAUSE is already gone.
 *
 * WHY (manager job 2026-09-30, item 2): the CEO's page carried six identical
 * "Retry this order or drop it?" prompts for six fleet orders that all died the same way -
 * "the planner produced no usable work orders" while the fallback planner answered with a
 * reasoning dump / tool-call artifact and Claude was unavailable because the sign-in had
 * expired. Both halves are fixed in code now (src/company/fleet.ts: fallbackMaxTokens 8192,
 * fallbackTries 2, the no-deliberation prompt line, and the expired-sign-in path), so those
 * six prompts ask the CEO to decide about a failure that can no longer happen. The CEO asked
 * (in chat, and through six earlier Retry answers) for these jobs to be re-run; that intent
 * was already spent - every one of the six IS the result of an earlier retry. Re-queueing
 * them a third time automatically would be clicking a decision he did not make, so this tool
 * CLOSES the stale prompts and says so, once, in plain words.
 *
 * WHAT IT WRITES (never deletes anything):
 *   - company/reports/needs-you-resolved.json: one entry per stale prompt id, plus the
 *     legacy `fleet:<orderId>` id the running router still serves (the new build keys a
 *     prompt on job+reason, so both forms must be recorded or the prompt would come back
 *     after the next restart);
 *   - company/reports/needs-you-decisions.json: one audit row per closed prompt;
 *   - ONE line in company/assistant.jsonl telling the CEO what happened.
 *
 * Usage:
 *   npx tsx ops/needs-you-stale-resolve.ts            # acts on the live company root
 *   npx tsx ops/needs-you-stale-resolve.ts --dry-run  # prints what it would close
 *
 * Safety: dry-run writes nothing. COMPANY_ROOT may point at a throwaway tree
 * (ops/needs-you-retry-loop-test.ts does exactly that).
 */
import fs from "node:fs";
import path from "node:path";
import { getCompanyRoot } from "../src/company/org.js";

// Causes that are FIXED IN CODE: a prompt raised for one of these is stale. Anything else
// (a missing key, a spent budget, a session limit) is a real decision and is left alone.
const FIXED_CAUSES = new Set(["planner-no-plan", "sign-in-expired"]);

type Card = {
  runId: string;
  kind: string;
  title: string;
  state: string;
  updatedAt?: string;
  fleetFailureCause?: string;
  fleetRetryExhausted?: boolean;
  ref?: { orderId?: string };
  verdictReason?: string;
  headline?: string;
};

export type StaleResolveResult = {
  openItems: number;
  /** the page's own count once the entries already on disk are honoured */
  pageItems: number;
  /** the items that count is made of */
  page: Array<{ id: string; runId: string; question: string }>;
  /** stale prompts that are still open (this run's work) */
  stale: Array<{ id: string; runId: string; orderId: string; cause: string; title: string }>;
  /** those stale prompts, with whether the page was showing them */
  open: Array<{ id: string; runId: string; kind: string; cause: string; stale: boolean; shown: boolean; title: string }>;
  /** stale prompts an earlier run already closed (why a re-run is a no-op) */
  alreadyClosed: string[];
  written: number;
  assistantLine: string;
};

function reportsDir(): string {
  return path.join(getCompanyRoot(), "reports");
}

function readJson<T>(file: string): T | undefined {
  try {
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * The stale prompts, computed with the SAME pure code the page uses.
 *
 * NB it iterates the CARDS, not just the visible needs-you items: the page shows at most
 * NEEDS_MAX (6) items, so closing the visible ones simply lets three older stale prompts
 * surface into the freed slots (measured 2026-09-30 12:14: the six visible prompts were
 * three tasks plus three fleet jobs; closing those three revealed three more fleet jobs from
 * the same incident). The whole class has to be closed in one pass.
 */
export async function findStalePrompts(): Promise<StaleResolveResult> {
  const { listRunCards } = (await import("../src/company/runManagers.js")) as typeof import("../src/company/runManagers.js");
  const { composeBriefing, classifyNeedsYou } = (await import("../src/company/briefing.js")) as typeof import("../src/company/briefing.js");
  const cards = listRunCards() as Card[];
  // resolved = {} on purpose: this is the RAW open set, not what is already hidden.
  const briefing = composeBriefing(cards, {
    seenAt: new Date(0).toISOString(),
    summary: "stale-prompt check",
    model: "local",
    resolved: {},
  });
  const visible = new Set(briefing.needsYou.map((i) => i.runId));
  const resolved = readJson<Record<string, { at: string }>>(path.join(reportsDir(), "needs-you-resolved.json")) ?? {};
  const closedAt = (card: Card, id: string): number => {
    const at = Date.parse(resolved[id]?.at ?? "");
    const cardAt = Date.parse(card.updatedAt ?? "");
    return Number.isFinite(at) && Number.isFinite(cardAt) && at >= cardAt ? at : NaN;
  };
  const stale: StaleResolveResult["stale"] = [];
  const alreadyClosed: string[] = [];
  const open: StaleResolveResult["open"] = [];
  for (const card of cards) {
    const cause = card.kind === "fleet" ? (card.fleetFailureCause ?? "") : "";
    const isStale = card.kind === "fleet" && card.state === "failed" && FIXED_CAUSES.has(cause);
    if (!isStale) continue;
    const itemId = classifyNeedsYou(card).id ?? card.runId;
    // Already closed by an earlier pass (the resolver writes the rule's own id, the running
    // build may serve the legacy per-order id): a re-run must be a no-op, not a rewrite.
    if (Number.isFinite(closedAt(card, itemId)) || Number.isFinite(closedAt(card, card.runId))) {
      alreadyClosed.push(card.runId);
      continue;
    }
    open.push({
      id: itemId,
      runId: card.runId,
      kind: card.kind,
      cause,
      stale: true,
      shown: visible.has(card.runId),
      title: String(card.title ?? "").slice(0, 80),
    });
    stale.push({
      id: itemId,
      runId: card.runId,
      orderId: card.ref?.orderId ?? card.runId.replace(/^fleet:/, ""),
      cause,
      title: String(card.title ?? "").slice(0, 100),
    });
  }
  // What the page really shows now, with the entries already on disk honoured.
  const pageNow = composeBriefing(cards, {
    seenAt: new Date(0).toISOString(),
    summary: "stale-prompt check",
    model: "local",
    resolved,
  });
  const page: StaleResolveResult["page"] = pageNow.needsYou.map((i) => ({ id: i.id ?? "", runId: i.runId, question: i.question ?? "" }));
  return { openItems: briefing.needsYou.length, pageItems: pageNow.needsYou.length, page, stale, open, alreadyClosed, written: 0, assistantLine: "" };
}

export function applyStaleResolve(found: StaleResolveResult): StaleResolveResult {
  const at = new Date().toISOString();
  const resolvedFile = path.join(reportsDir(), "needs-you-resolved.json");
  const decisionsFile = path.join(reportsDir(), "needs-you-decisions.json");
  const resolved = readJson<Record<string, { at: string; actionId: string }>>(resolvedFile) ?? {};
  const decisions = readJson<Array<Record<string, unknown>>>(decisionsFile) ?? [];
  let written = 0;
  for (const s of found.stale) {
    // The stable id AND the legacy per-order id: the running build serves the latter, the
    // next build serves the former, and both must stay closed after a restart.
    for (const id of [s.id, s.runId]) {
      resolved[id] = { at, actionId: "auto-stale" };
      written++;
    }
    decisions.push({
      at,
      who: "manager:stale-cleanup",
      itemId: s.id,
      actionId: "auto-stale",
      effect: "resolve_stale",
      ok: true,
      message: `Closed automatically: the reason this job failed (${s.cause}) is fixed in code and this order is already a retry of an earlier attempt.`,
    });
  }
  if (decisions.length > 500) decisions.splice(0, decisions.length - 500);
  writeJsonAtomic(resolvedFile, resolved);
  writeJsonAtomic(decisionsFile, decisions);

  const assistantLine = found.stale.length
    ? `Closed ${found.stale.length} stale "Retry this order or drop it?" prompt(s): each one was a fleet job that never started because the planner could not log in, which is fixed now. Nothing was re-run automatically - ask for a job again in chat if you still want it:\n${found.stale
        .map((s) => `- ${s.title}`)
        .join("\n")}`
    : "No stale retry prompts to close.";
  try {
    const file = path.join(getCompanyRoot(), "assistant.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ at, role: "assistant", text: assistantLine })}\n`);
  } catch {
    // the thread note is best effort
  }
  return { ...found, written, assistantLine };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const found = await findStalePrompts();
  console.log(`[stale] company root: ${getCompanyRoot()}`);
  console.log(`[stale] open needs-you items (raw, ignoring the resolved ledger): ${found.openItems}`);
  for (const p of found.page) console.log(`  [page] ${p.runId} id=${p.id} q=${p.question.slice(0, 60)}`);
  for (const o of found.open) {
    console.log(`  [close] ${o.shown ? "shown" : "capped"} ${o.runId} cause=${o.cause} id=${o.id} ${o.title}`);
  }
  if (found.alreadyClosed.length) console.log(`[stale] already closed by an earlier pass: ${found.alreadyClosed.length} (${found.alreadyClosed.join(", ")})`);
  console.log(`[stale] stale prompts still open (fixed cause): ${found.stale.length}`);
  if (dryRun) {
    console.log(`[stale] page would show ${found.stale.length ? found.pageItems - found.stale.length : found.pageItems} item(s) after this pass.`);
    console.log("[stale] --dry-run: nothing written.");
    return;
  }
  const out = applyStaleResolve(found);
  console.log(`[stale] resolved entries written: ${out.written}`);
  const after = await findStalePrompts();
  console.log(`[stale] page now: ${after.pageItems} item(s); stale left: ${after.stale.length}`);
  for (const p of after.page) console.log(`  [page] ${p.runId} q=${p.question.slice(0, 60)}`);
  console.log(`[stale] ${out.assistantLine.split("\n")[0]}`);
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("ops", "needs-you-stale-resolve.ts"))) {
  void main().catch((e) => {
    console.error(`[stale] failed: ${String(e)}`);
    process.exitCode = 1;
  });
}
