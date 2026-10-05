// ops/brain-gate-post-restart-check.ts - CHEAP-DEFAULT: did the restart actually change the gate?
//
// READ-ONLY. It reads company/budget/brain-decisions.jsonl and answers the one question a
// restart is supposed to change: is the CALIBRATED Opus bar in force, and did the `redo2`
// re-fire pattern stop?
//
// Why this exists: the `redo2` fix (runManagers.ts, redoEscalation) is on disk but not live
// until :8787 is restarted, and the old rule was firing Opus on every re-check of any run that
// had ever collected two REDOs. After someone restarts the router, this prints the numbers that
// say whether it worked - no dashes-in-the-dark, no restarting on a hunch.
//
// Usage:
//   npx tsx ops/brain-gate-post-restart-check.ts              (last 15 minutes)
//   npx tsx ops/brain-gate-post-restart-check.ts --minutes 60
//   npx tsx ops/brain-gate-post-restart-check.ts --since 2026-09-29T21:31:11Z
import fs from "node:fs";
import path from "node:path";
import { getCompanyRoot } from "../src/company/org.js";

type Row = {
  ts?: string;
  purpose?: string;
  tier?: string;
  model?: string;
  reasonKind?: string;
  reason?: string;
  hardRule?: string;
  claudeCall?: boolean;
  climbed?: boolean;
  costUsd?: number | null;
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const file = path.join(getCompanyRoot(), "budget", "brain-decisions.jsonl");
  if (!fs.existsSync(file)) {
    console.log(`no decision log at ${file} - the gate has not run in this company root`);
    return;
  }
  const minutes = Number(arg("minutes") ?? 15);
  const sinceArg = arg("since");
  const sinceMs = sinceArg ? Date.parse(sinceArg) : Date.now() - minutes * 60_000;
  if (!Number.isFinite(sinceMs)) {
    console.error(`could not parse --since "${sinceArg}" (use an ISO timestamp, e.g. 2026-09-29T21:31:11Z)`);
    process.exitCode = 2;
    return;
  }

  const rows: Row[] = [];
  let malformed = 0;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Row;
      if (r.ts && Date.parse(r.ts) >= sinceMs) rows.push(r);
    } catch {
      malformed += 1;
    }
  }

  const window = sinceArg ? `since ${sinceArg}` : `last ${minutes} min`;
  console.log(`# brain gate post-restart check - ${window}`);
  console.log(`# log: ${file}${malformed ? ` (${malformed} unparsable line(s) skipped)` : ""}`);
  if (!rows.length) {
    console.log("NO DECISIONS IN THIS WINDOW: either nothing has called the gate, or the window is wrong.");
    console.log("Tip: --since <the router's boot time from logs/router.crash.log>.");
    return;
  }

  const byTier: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  const hardRules: Record<string, number> = {};
  const opusBySource: Record<string, number> = {};
  let climbed = 0;
  let fileBlind = 0;
  // Match the THRESHOLD PHRASING, not the bare numbers: `lead=0.85` (a real Laya lead) must not
  // look like the removed 0.92/0.85 bar. The old bar was printed as ">= 0.92/0.85".
  const staleBar = rows.filter((r) => /0\.92\/0\.85/.test(r.reason ?? ""));
  const calibrated = rows.filter((r) => /0\.75\/0\.2\b/.test(r.reason ?? ""));

  for (const r of rows) {
    byTier[r.tier ?? "?"] = (byTier[r.tier ?? "?"] ?? 0) + 1;
    byReason[r.reasonKind ?? "?"] = (byReason[r.reasonKind ?? "?"] ?? 0) + 1;
    if (r.hardRule) hardRules[r.hardRule] = (hardRules[r.hardRule] ?? 0) + 1;
    if (r.tier === "opus") {
      const src = r.hardRule ? `hardRule:${r.hardRule}` : (r.reasonKind ?? "?");
      opusBySource[src] = (opusBySource[src] ?? 0) + 1;
    }
    if (r.climbed) climbed += 1;
    if (r.reasonKind === "laya" && r.tier === "none") fileBlind += 1;
  }

  const tierList = Object.entries(byTier).sort((a, b) => b[1] - a[1]);
  const opus = byTier.opus ?? 0;
  console.log(`decisions: ${rows.length} | byTier ${tierList.map(([t, n]) => `${t}=${n}`).join(" ")}`);
  console.log(`Opus share: ${((opus / rows.length) * 100).toFixed(0)}% (${opus}/${rows.length})` +
    (opus ? ` | where from: ${Object.entries(opusBySource).map(([k, n]) => `${k}=${n}`).join(" ")}` : ""));
  console.log(`reason kinds: ${Object.entries(byReason).map(([k, n]) => `${k}=${n}`).join(" ")}`);
  if (Object.keys(hardRules).length) console.log(`hard rules used: ${Object.entries(hardRules).map(([k, n]) => `${k}=${n}`).join(" ")}`);
  console.log(`calibrated bar cited (0.75/0.2): ${calibrated.length} row(s)` + (staleBar.length ? ` | ROWS CITING THE REMOVED 0.92/0.85 BAR: ${staleBar.length}` : ""));
  console.log("");

  // The judgement is deliberately about the ONE thing a restart changes.
  if (staleBar.length) {
    console.log(`FAIL  ${staleBar.length} row(s) cite the removed 0.92/0.85 bar -> the running process predates the`);
    console.log("      calibrated guardrail; the restart has NOT loaded it (or the window reaches back before it).");
    process.exitCode = 1;
    return;
  }
  if (hardRules.redo2 && hardRules.redo2 >= 3 && opus / rows.length > 0.4) {
    console.log(`FAIL  redo2 escalated ${hardRules.redo2} times in this window and Opus is ${((opus / rows.length) * 100).toFixed(0)}% of all`);
    console.log("      decisions - the OLD accumulated-history rule looks like it is still live (the fix needs a restart).");
    process.exitCode = 1;
    return;
  }
  console.log("PASS  no row cites the removed bar" + (calibrated.length ? `, and ${calibrated.length} row(s) cite the calibrated 0.75/0.2` : "") + ".");
  if (hardRules.redo2) console.log(`      note: redo2 fired ${hardRules.redo2}x in this window - watch it; with the fix it should fire once per run.`);
}

main();
