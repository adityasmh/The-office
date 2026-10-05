/**
 * ops/usage-probe.ts — show the REAL provider quota constraints for this company.
 *
 * This is the honest counterweight to the dashboard's virtual per-agent USD
 * "budget" (budget.ts allocations, e.g. the "$80.50 budget" headline). Those
 * numbers are an internal throttle policy, not money and not a provider limit.
 * This probe prints what is actually measured or provider-reported, and says
 * "unavailable, because X" when nothing can be measured. It never invents a
 * percentage.
 *
 * Read-only: runs `jcode usage --json`, `opencode auth list`, `claude auth status`
 * and reads company/projects/<id>/cost.jsonl. Writes nothing. Emails / account
 * ids in raw CLI output are masked.
 *
 * Usage (from the project root):
 *   npx tsx ops/usage-probe.ts           # tables + raw evidence
 *   npx tsx ops/usage-probe.ts --json    # machine-readable dump
 *   npx tsx ops/usage-probe.ts --no-raw  # skip the raw evidence blocks
 */

import "dotenv/config";
import { captureRawEvidence, measuredSpendByModel, providerUsage } from "../src/company/usage.js";
import type { ProviderUsage, RawEvidence } from "../src/company/usage.js";

const argv = process.argv.slice(2);
const AS_JSON = argv.includes("--json");
const NO_RAW = argv.includes("--no-raw");

function pad(s: string, n: number): string {
  const t = s.length > n ? s.slice(0, n - 1) + "…" : s;
  return t + " ".repeat(Math.max(0, n - t.length));
}

function renderProviders(rows: ProviderUsage[]): string {
  const lines: string[] = [];
  lines.push("PROVIDER QUOTA (source: jcode usage / claude auth status)");
  lines.push("-".repeat(96));
  lines.push(`${pad("provider", 40)} ${pad("source", 12)} ${pad("plan", 8)} ${pad("spend(all-time)", 15)} detail`);
  for (const r of rows) {
    lines.push(
      `${pad(r.provider, 40)} ${pad(r.source, 12)} ${pad(r.plan ?? "—", 8)} ${pad(
        r.measuredSpendUsd === undefined ? "—" : `$${r.measuredSpendUsd.toFixed(2)}`,
        15,
      )} ${r.detail}`,
    );
  }
  lines.push("");
  for (const r of rows) {
    if (!r.windows || r.windows.length === 0) continue;
    lines.push(`  ${r.provider} windows:`);
    for (const w of r.windows) {
      lines.push(
        `    - ${pad(w.label, 18)} used=${w.usedPct === undefined ? "—" : `${w.usedPct}%`}  ${
          w.resetsIn ? `resets in ${w.resetsIn}` : ""
        }`,
      );
    }
  }
  return lines.join("\n");
}

function renderMeasured(): string {
  const rows = measuredSpendByModel();
  const lines: string[] = [];
  lines.push("MEASURED SPEND BY MODEL (company/projects/*/cost.jsonl — real per-call costs)");
  lines.push("-".repeat(96));
  if (rows.length === 0) {
    lines.push("  unavailable: no cost.jsonl records found under company/projects/*/");
    return lines.join("\n");
  }
  lines.push(`${pad("model", 28)} ${pad("calls", 8)} costUsd`);
  let calls = 0;
  let total = 0;
  for (const r of rows) {
    calls += r.calls;
    total += r.costUsd;
    lines.push(`${pad(r.model, 28)} ${pad(String(r.calls), 8)} $${r.costUsd.toFixed(6)}`);
  }
  lines.push("-".repeat(96));
  lines.push(`${pad("TOTAL", 28)} ${pad(String(calls), 8)} $${total.toFixed(6)}`);
  return lines.join("\n");
}

function renderRaw(evidence: RawEvidence[]): string {
  const lines: string[] = [];
  lines.push("RAW EVIDENCE (masked: emails, account/org ids, tokens)");
  lines.push("=".repeat(96));
  for (const e of evidence) {
    lines.push(`$ ${e.command}   [${e.ok ? "exit 0" : "non-zero exit"}]`);
    lines.push(e.output);
    lines.push("-".repeat(96));
  }
  return lines.join("\n");
}

async function main() {
  const [providers, evidence] = await Promise.all([providerUsage(), captureRawEvidence()]);
  const measured = measuredSpendByModel();

  if (AS_JSON) {
    process.stdout.write(
      JSON.stringify({ capturedAt: new Date().toISOString(), providers, measuredByModel: measured }, null, 2) + "\n",
    );
    return;
  }

  process.stdout.write("\n");
  process.stdout.write(renderProviders(providers) + "\n\n");
  process.stdout.write(renderMeasured() + "\n\n");
  if (!NO_RAW) process.stdout.write(renderRaw(evidence) + "\n");

  process.stdout.write(
    "NOTE: the dashboard '$80.50 budget' is a virtual policy cap (budget.ts allocations), not money.\n" +
      "The real constraint is the subscription quota above; when Claude's 5-hour window fills, calls 429.\n" +
      "Measured spend: opencode runs carry the runtime's own per-call cost; router roles use a flat\n" +
      "per-run estimate (budget.ts ROUTER_RUN_COST_USD) when the provider reports no cost.\n",
  );
}

main().catch((e) => {
  process.stderr.write(`usage-probe failed: ${String(e)}\n`);
  process.exitCode = 1;
});