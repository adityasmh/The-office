// DUPLICATE-PROMPTS cleanup (data side).
//
// Stops the CEO seeing the same "Retry this order or drop it?" prompt again and again:
//
//   1. fleet orders that are copies of the SAME job (same long title) are closed, so
//      only the newest copy can ever raise a prompt;
//   2. cancelled (dropped) orders with no closure record are marked dropped, so a
//      dropped run cannot come back as "failed";
//   3. needs-you-asked.json is pruned to the items that are still OPEN, clearing the
//      backlog of "asked" records for runs that are already handled;
//   4. briefing.json is re-composed with the de-duplicating rule;
//   5. one short consolidation note is appended to Joey's thread (history is NOT
//      rewritten - nothing the CEO already said is touched).
//
// Usage:
//   npx tsx ops/needs-you-dedupe.ts            # apply
//   npx tsx ops/needs-you-dedupe.ts --dry-run  # report only, write nothing
//
// Safety: only edits company/ at the repo root. Writes are atomic (tmp + rename) and
// every file is re-parsed before it is written. No model call, no server, no restart.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { orderTitleKey, isSupersededOrder } from "../src/company/needsYouRule.js";
import { composeBriefing } from "../src/company/briefing.js";
import { listRunCards } from "../src/company/runManagers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const companyRoot = path.resolve(process.env.COMPANY_ROOT ?? path.join(repoRoot, "company"));
const dryRun = process.argv.slice(2).includes("--dry-run");

function reportsDir(): string {
  return path.join(companyRoot, "reports");
}
function ordersFile(): string {
  return path.join(companyRoot, "fleet", "orders.json");
}
function askedFile(): string {
  return path.join(reportsDir(), "needs-you-asked.json");
}
function briefingFile(): string {
  return path.join(reportsDir(), "briefing.json");
}
function resolvedFile(): string {
  return path.join(reportsDir(), "needs-you-resolved.json");
}
function threadFile(): string {
  return path.join(companyRoot, "assistant.jsonl");
}

function nowIso(): string {
  return new Date().toISOString();
}

function readJson<T>(file: string): T | undefined {
  try {
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function atomicWriteJson(file: string, value: unknown): void {
  const text = JSON.stringify(value, null, 2);
  JSON.parse(text); // validate before writing
  if (dryRun) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "EPERM") {
      // Windows: rename does not replace an existing file.
      fs.rmSync(file, { force: true });
      fs.renameSync(tmp, file);
    } else {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }
}

type OrderRec = {
  id?: string;
  text?: string;
  createdAt?: string;
  status?: string;
  closedAs?: string;
  supersededBy?: string;
  closedReason?: string;
  closedAt?: string;
  closedBy?: string;
};

// ---------------------------------------------------------------------------
// 1 + 2. Close duplicate and cancelled fleet orders.
// ---------------------------------------------------------------------------
function closeOrders(): { closed: number; dropped: number } {
  const file = ordersFile();
  const orders = readJson<OrderRec[]>(file);
  if (!Array.isArray(orders)) {
    console.log(`[SKIP] ${file}: not an order array`);
    return { closed: 0, dropped: 0 };
  }
  const stamp = (o: OrderRec) => Date.parse(o.createdAt ?? "") || 0;

  // Group by the same long title key the card layer uses (> = 20 chars).
  const groups = new Map<string, OrderRec[]>();
  for (const o of orders) {
    if (!o?.id) continue;
    const key = orderTitleKey(o.text);
    if (!key) continue;
    const list = groups.get(key);
    if (list) list.push(o);
    else groups.set(key, [o]);
  }

  let closed = 0;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => stamp(a) - stamp(b));
    const newest = sorted[sorted.length - 1]!;
    for (const o of sorted.slice(0, -1)) {
      if (o.closedAs || o.supersededBy) continue; // already closed
      // Only close copies that cannot make progress on their own: a failed or
      // cancelled copy. A running copy is real work and is left alone.
      if (o.status !== "failed" && o.status !== "cancelled") continue;
      o.closedAs = "superseded";
      o.supersededBy = newest.id;
      o.closedReason = `duplicate of newer order ${newest.id} for the same job`;
      o.closedAt = nowIso();
      o.closedBy = "dedupe";
      closed++;
      console.log(`[DONE] fleet:${o.id}: duplicate of ${newest.id} -> closedAs=superseded`);
    }
  }

  let dropped = 0;
  for (const o of orders) {
    if (!o?.id) continue;
    if (o.status === "cancelled" && !o.closedAs) {
      o.closedAs = "dropped";
      o.closedReason = o.closedReason ?? "cancelled by the CEO";
      o.closedAt = o.closedAt ?? nowIso();
      o.closedBy = o.closedBy ?? "dedupe";
      dropped++;
      console.log(`[DONE] fleet:${o.id}: cancelled -> closedAs=dropped`);
    }
  }

  if (closed || dropped) {
    atomicWriteJson(file, orders);
    console.log(`[WRITE] ${file}: ${closed} duplicate(s) + ${dropped} cancelled closed${dryRun ? " (dry-run: not written)" : ""}`);
  } else {
    console.log(`[OK] ${file}: no duplicate or cancelled order needed closing`);
  }
  // Sanity: every failed order is now either the newest of its title group or closed.
  const stillOpen = orders.filter((o) => o.status === "failed" && !o.closedAs && !o.supersededBy && !isSupersededOrder(o, orders));
  console.log(`[OK] open failed orders after cleanup: ${stillOpen.length} (${stillOpen.map((o) => o.id).join(", ") || "none"})`);
  return { closed, dropped };
}

// ---------------------------------------------------------------------------
// 3 + 4. Re-compose the briefing and prune the "asked" backlog to what is open.
// ---------------------------------------------------------------------------
function refreshBriefingAndAsked(): { openIds: string[]; prunedAsked: number } {
  const resolved = readJson<Record<string, { at: string }>>(resolvedFile()) ?? {};
  const cards = listRunCards();
  const briefing = composeBriefing(cards, {
    seenAt: nowIso(),
    summary: "",
    model: "local",
    resolved,
  });
  // The running router may still hold the OLD rule in memory until it restarts. Keep
  // any item that file already shows open, so pruning never makes it re-ask one.
  const onDisk = readJson<{ needsYou?: { id?: string; runId?: string }[] }>(briefingFile());
  const openSet = new Set<string>(briefing.needsYou.map((n) => n.id ?? n.runId ?? "").filter(Boolean));
  for (const n of onDisk?.needsYou ?? []) {
    const id = n.id ?? n.runId;
    if (id) openSet.add(id);
  }
  const openIds = [...openSet];
  console.log(`[OK] open needs-you items: ${openSet.size} (${openIds.join(", ") || "none"})`);

  atomicWriteJson(briefingFile(), briefing);

  const asked = readJson<Record<string, { at: string }>>(askedFile()) ?? {};
  const keep: Record<string, { at: string }> = {};
  let pruned = 0;
  for (const [id, rec] of Object.entries(asked)) {
    if (openSet.has(id)) keep[id] = rec;
    else pruned++;
  }
  if (pruned) {
    atomicWriteJson(askedFile(), keep);
    console.log(`[WRITE] ${askedFile()}: cleared ${pruned} stale asked record(s), kept ${Object.keys(keep).length}${dryRun ? " (dry-run: not written)" : ""}`);
  } else {
    console.log(`[OK] ${askedFile()}: no stale asked records`);
  }
  return { openIds, prunedAsked: pruned };
}

// ---------------------------------------------------------------------------
// 5. One consolidation note in Joey's thread (append only; never rewrite history).
// ---------------------------------------------------------------------------
function appendConsolidationNote(text: string): void {
  const line = JSON.stringify({ ts: nowIso(), role: "assistant", text }) + "\n";
  if (dryRun) {
    console.log(`[DRY] would append to ${threadFile()}: ${text}`);
    return;
  }
  fs.mkdirSync(path.dirname(threadFile()), { recursive: true });
  fs.appendFileSync(threadFile(), line);
  console.log(`[WRITE] ${threadFile()}: consolidation note appended`);
}

// ---------------------------------------------------------------------------
const { closed, dropped } = closeOrders();
const { openIds, prunedAsked } = refreshBriefingAndAsked();

const openCount = openIds.length;
const changedAnything = closed + dropped + prunedAsked > 0;
if (changedAnything) {
  appendConsolidationNote(
    `I tidied the duplicated questions: closed ${closed + dropped} duplicate/dropped run(s) and cleared ${prunedAsked} old prompt record(s), so each job now asks you once. ` +
      (openCount > 0
        ? `${openCount} item(s) still need you - open the Briefing page to answer them.`
        : "Nothing is waiting on you right now.")
  );
} else {
  console.log("[OK] nothing to consolidate");
}

console.log(
  `\n[OK] DUPLICATE-PROMPTS cleanup finished${dryRun ? " (dry-run)" : ""}: ` +
    `${closed} duplicate order(s), ${dropped} cancelled order(s), ${prunedAsked} stale asked record(s) cleared, ${openCount} open item(s).`
);
