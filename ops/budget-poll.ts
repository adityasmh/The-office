// ops/budget-poll.ts - BUDGET (docs/BUDGET_SPEC.md §1): one budget poll, from
// the command line. The same code path the router's background watcher runs
// (src/company/budgetGuard.ts -> refreshBudgetState()).
//
//   npx tsx ops/budget-poll.ts              # poll, print, persist state.json + history.jsonl
//   npx tsx ops/budget-poll.ts --no-write   # poll and print only (nothing on disk changes)
//   npx tsx ops/budget-poll.ts --json       # the whole snapshot as JSON
//   npx tsx ops/budget-poll.ts --fresh      # bypass the 2-minute provider cache
//
// Read-only against the providers: it calls the OpenCode Go quota endpoint with
// the existing key and `jcode usage --json --no-update` for Claude. No secret is
// printed (usage.ts masks anything that comes back).

import "dotenv/config";
import { budgetPollS, buildSnapshot, refreshBudgetState, budgetStatePath, budgetHistoryPath, type BudgetSnapshot } from "../src/company/budgetGuard.js";

function fmtPct(v: number | undefined): string {
  return v === undefined ? "  ?  " : `${v.toFixed(1)}%`.padStart(6);
}

function usd(v: number | undefined): string {
  return v === undefined ? "?" : `$${v.toFixed(4)}`;
}

function table(s: BudgetSnapshot): string {
  const lines: string[] = [];
  lines.push("PROVIDER PRESSURE (real quota, read-only)");
  lines.push("-----------------------------------------------------------------------------------------------");
  lines.push("provider      level   remaining  window     resets in   burn $/h   runs out     source");
  for (const p of [s.providers.go, s.providers.claude]) {
    lines.push(
      [
        p.label.padEnd(13),
        p.level.padEnd(7),
        fmtPct(p.remainingPct),
        "  " + (p.bindingWindow ?? "-").padEnd(9),
        (p.resetsIn ?? "-").padEnd(11),
        usd(p.burnPerHour).padStart(9),
        (p.runsOutIn ?? (p.connected ? "no slope yet" : "-")).padEnd(12),
        p.source,
      ].join(" "),
    );
  }
  lines.push("");
  lines.push(`binding provider: ${s.binding.provider} (${s.binding.level}${s.binding.remainingPct !== undefined ? `, ${s.binding.remainingPct}% left` : ""})`);
  lines.push(`measured spend: last hour ${usd(s.spend.lastHourUsd)}, last 24 h ${usd(s.spend.last24hUsd)}, today ${usd(s.spend.todayUsd)}`);
  lines.push("");
  lines.push("WHAT THE SYSTEM IS DOING ABOUT IT");
  for (const e of s.effects) lines.push(`  - ${e}`);
  if (s.needsYou) lines.push(`  ! NEEDS YOU: ${s.needsYou.text}`);
  lines.push("");
  lines.push("DETAIL (one line per provider)");
  for (const p of [s.providers.go, s.providers.claude]) lines.push(`  ${p.label}: ${p.detail}`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const noWrite = args.includes("--no-write");
  const fresh = args.includes("--fresh");

  const snap = noWrite ? await buildSnapshot({ fresh }) : await refreshBudgetState({ fresh });

  if (asJson) {
    console.log(JSON.stringify(snap, null, 2));
    return;
  }
  console.log(table(snap));
  console.log("");
  console.log(`checked at ${snap.checkedAt}  (poll every ${budgetPollS()} s)`);
  console.log(noWrite ? "state file NOT written (--no-write)" : `state:   ${budgetStatePath()}\nhistory: ${budgetHistoryPath()}`);
}

main().catch((e) => {
  console.error("budget poll failed:", String(e));
  process.exit(1);
});
