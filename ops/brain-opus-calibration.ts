// ops/brain-opus-calibration.ts - CHEAP-DEFAULT (Job B): measure Laya on realistic CEO
// orders and calibrate the OPUS guardrail so that roughly 30% of the tasks the gate calls
// BIG reach Opus (the rest of the big work goes to Sonnet).
//
// Why this exists: the manager raised BUDGET_BRAIN_OPUS_P/LEAD to 0.92/0.85 to stop Opus
// leaking onto small work, which is far too high - Opus would then almost never run (measured
// below: 0 of the big fixtures cleared it). The CEO's rule is "Claude only for big/complex
// work; among that work, Opus ~30%". This script MEASURES Laya's numbers instead of guessing.
//
// Safety: read-only for the company. COMPANY_ROOT is a throwaway directory, so the decision
// log it writes lands there and never in the live company folder. It does not start or touch
// the router on :8787 and makes no Claude call: pickBrain() only asks Laya and logs a
// decision (Claude would only run later, on the caller's side).
//
// Run: npx tsx ops/brain-opus-calibration.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── isolation, BEFORE importing anything that reads config/company roots ───────────────
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "brain-opus-cal-"));
process.env.COMPANY_ROOT = path.join(SANDBOX, "company");
process.env.SLACK_BRIDGE = "0";
delete process.env.MOCK_MODE; // the gate must really ask Laya
fs.mkdirSync(process.env.COMPANY_ROOT, { recursive: true });

type Kind = "small" | "medium" | "big";
type Fixture = { kind: Kind; text: string };

// Realistic orders, written the way the CEO writes them. The BIG list is deliberately larger
// than the others: 30% of a 5-task population is 1.5 tasks, which cannot calibrate anything.
const FIXTURES: Fixture[] = [
  // ── small: must make ZERO Claude calls ───────────────────────────────────────────────
  { kind: "small", text: "rename the label 'Submit' to 'Send' on the settings page" },
  { kind: "small", text: "fix a typo in the README: 'recieve' -> 'receive'" },
  { kind: "small", text: "what is the status of the dashboard rebuild?" },
  { kind: "small", text: "change the button colour on the login page to blue" },
  { kind: "small", text: "update the copyright year in the footer to 2026" },
  { kind: "small", text: "add the word 'beta' next to the logo text" },
  { kind: "small", text: "delete the unused import in src/gateway.ts" },
  { kind: "small", text: "make the settings pill say 'Saved' instead of 'OK'" },
  // ── medium: ordinary work, cheap tier is fine ────────────────────────────────────────
  { kind: "medium", text: "rename a label and update the docs that mention it" },
  { kind: "medium", text: "fix the race condition in the fleet spawner" },
  { kind: "medium", text: "add unit tests for the budget module" },
  { kind: "medium", text: "add pagination to the projects list (API + UI)" },
  { kind: "medium", text: "make the build faster by caching the tsc output" },
  { kind: "medium", text: "expose the lag numbers on the system page" },
  // ── big: multi-file / architecture / migration / audit work ──────────────────────────
  { kind: "big", text: "add a multi-file feature: a new API endpoint plus a database migration and a UI page" },
  { kind: "big", text: "refactor the authentication layer across six files and keep the tests green" },
  { kind: "big", text: "migrate the project from Express to Fastify, updating every route and the tests" },
  { kind: "big", text: "design a new event-driven architecture for the order pipeline and write the plan" },
  { kind: "big", text: "audit the whole codebase for security holes and propose fixes for each finding" },
  { kind: "big", text: "build a new admin dashboard with charts, filters and a settings page" },
  { kind: "big", text: "reorganise the documentation into a new structure and rewrite the index" },
  { kind: "big", text: "plan a two-week roadmap with tasks for the voice feature across four workstreams" },
  { kind: "big", text: "split the monolithic fleet module into three files with a shared interface" },
  { kind: "big", text: "add end-to-end tests that cover the whole order pipeline" },
  { kind: "big", text: "replace the polling watcher with a durable queue across the backend and the UI" },
  { kind: "big", text: "write the architecture document for the new reporting chain and the migration steps" },
  { kind: "big", text: "rework the budget guard to support more providers and update every caller" },
  { kind: "big", text: "move the whole frontend to the new component library without losing features" },
  { kind: "big", text: "investigate why the router stalls under load and fix it properly" },
];

// Laya samples; big/medium fixtures are asked several times so one noisy draw cannot set the
// thresholds (the gate itself asks once per decision - this is calibration, not the gate).
const REPEATS: Record<Kind, number> = { small: 1, medium: 2, big: 3 };

async function main() {
  // Imported AFTER the env is set (config and the company root are read per call).
  const { pickBrain, brainThresholds, cheapModel } = await import("../src/company/brainRouter.js");

  const th = brainThresholds();
  console.log(`# brain-opus-calibration`);
  console.log(`# sandbox COMPANY_ROOT: ${process.env.COMPANY_ROOT}`);
  console.log(`# Laya: ${process.env.LAYA_BASE_URL ?? "http://127.0.0.1:8000"} (DECISION_BACKEND=${process.env.DECISION_BACKEND ?? "laya"})`);
  console.log(`# thresholds in force: bigP=${th.bigP} bigLead=${th.bigLead} opusP=${th.opusP} opusLead=${th.opusLead} (BUDGET_BRAIN_OPUS_P/LEAD)`);
  console.log(`# cheap tier: ${cheapModel()}`);
  console.log("");

  type Sample = { kind: Kind; text: string; top: number; lead: number; predicted?: string; tier: string };
  const samples: Sample[] = [];
  const failures: string[] = [];
  for (const f of FIXTURES) {
    for (let i = 0; i < REPEATS[f.kind]; i++) {
      const pick = await pickBrain({ purpose: "plan", text: f.text, needsFiles: true });
      if (typeof pick.laya.top !== "number" || typeof pick.laya.lead !== "number") {
        failures.push(`${f.kind}: ${f.text.slice(0, 50)} -> ${pick.laya.error ?? "no numbers"}`);
        continue;
      }
      samples.push({ kind: f.kind, text: f.text, top: pick.laya.top, lead: pick.laya.lead, predicted: pick.laya.predicted, tier: pick.tier });
    }
  }

  // Per-fixture view (min..max over the repeats) so Laya's noise is visible, not hidden.
  console.log("kind    | top(min..max)  lead(min..max) | tier(s)          | order");
  console.log("--------|------------------------------|------------------|---------------------------------");
  for (const f of FIXTURES) {
    const s = samples.filter((x) => x.text === f.text);
    if (!s.length) {
      console.log(`${f.kind.padEnd(7)} | (no measurement)             |                  | ${f.text.slice(0, 40)}`);
      continue;
    }
    const tops = s.map((x) => x.top).sort((a, b) => a - b);
    const leads = s.map((x) => x.lead).sort((a, b) => a - b);
    const tiers = [...new Set(s.map((x) => x.tier))].join("/");
    const fmt = (a: number[]) => `${a[0]!.toFixed(2)}..${a[a.length - 1]!.toFixed(2)}`;
    console.log(`${f.kind.padEnd(7)} | ${fmt(tops).padEnd(14)} ${fmt(leads).padEnd(15)} | ${tiers.padEnd(16)} | ${f.text.slice(0, 40)}`);
  }
  if (failures.length) {
    console.log(`\nUNMEASURED (${failures.length}):`);
    for (const f of failures) console.log(`  - ${f}`);
  }
  if (!samples.length) {
    console.log("\nNO MEASUREMENTS: Laya answered nothing (is it up?). Nothing to calibrate.");
    process.exitCode = 2;
    return;
  }

  const measured = samples.length;
  const bigSamples = samples.filter((s) => s.top >= th.bigP && s.lead >= th.bigLead);
  const falseNeg = samples.filter((s) => s.kind === "big" && !(s.top >= th.bigP && s.lead >= th.bigLead));
  const falsePos = samples.filter((s) => s.kind !== "big" && s.top >= th.bigP && s.lead >= th.bigLead);
  console.log(`\nmeasured ${measured} samples from ${FIXTURES.length} fixtures`);
  console.log(`gate says BIG: ${bigSamples.length}/${measured}; of the intended-BIG samples the gate missed ${falseNeg.length}; non-big samples the gate called BIG: ${falsePos.length}`);
  console.log(`  missed BIG samples:    ${falseNeg.map((s) => `${s.top.toFixed(2)}/${s.lead.toFixed(2)}`).join(" ") || "(none)"}`);
  console.log(`  false-positive samples:${falsePos.length ? " " + falsePos.map((s) => `${s.kind} ${s.top.toFixed(2)}/${s.lead.toFixed(2)}`).join(" ") : " (none)"}`);

  const SCORES = bigSamples.map((s) => s.top).sort((a, b) => a - b);
  const LEADS = bigSamples.map((s) => s.lead).sort((a, b) => a - b);
  console.log(`\nBIG-sample tops  (sorted): ${SCORES.map((s) => s.toFixed(2)).join(" ")}`);
  console.log(`BIG-sample leads (sorted): ${LEADS.map((s) => s.toFixed(2)).join(" ")}`);

  // Grid search over the (top, lead) bar: which pair sends ~30% of the measured BIG samples
  // to Opus? Ties prefer the lowest lead bar (a high lead bar rejects real near-tie work).
  const shares: Array<{ p: number; l: number; n: number; share: number; near: number }> = [];
  for (let p = 0.4; p <= 0.9001; p += 0.01) {
    for (let l = 0.05; l <= 0.5001; l += 0.05) {
      const n = bigSamples.filter((s) => s.top >= p - 1e-9 && s.lead >= l - 1e-9).length;
      const share = n / bigSamples.length;
      shares.push({ p: Math.round(p * 100) / 100, l: Math.round(l * 100) / 100, n, share, near: Math.abs(share - 0.3) });
    }
  }
  const best = shares.slice().sort((a, b) => a.near - b.near || a.l - b.l || a.p - b.p)[0]!;
  console.log(`\nbest fit to the CEO's ~30% target: opusP=${best.p.toFixed(2)} opusLead=${best.l.toFixed(2)} -> ${(best.share * 100).toFixed(0)}% of BIG samples (${best.n}/${bigSamples.length})`);
  const band = shares.filter((s) => s.share >= 0.25 && s.share <= 0.35).sort((a, b) => a.l - b.l || a.p - b.p);
  for (const b of band.slice(0, 8)) {
    console.log(`  in-band: opusP=${b.p.toFixed(2)} opusLead=${b.l.toFixed(2)} -> ${(b.share * 100).toFixed(0)}% (${b.n}/${bigSamples.length})`);
  }
  const hand = bigSamples.filter((s) => s.top >= 0.92 && s.lead >= 0.85).length;
  console.log(`  current hand-raised 0.92/0.85 -> ${hand}/${bigSamples.length} (${((hand / bigSamples.length) * 100).toFixed(0)}%) - this is the guardrail that needs fixing`);

  // Small tasks must never reach Claude at all.
  const small = samples.filter((s) => s.kind === "small");
  const smallClaude = small.filter((s) => s.tier !== "none");
  console.log(`\nsmall samples: ${small.length}; tier=none: ${small.filter((s) => s.tier === "none").length}; reached Claude: ${smallClaude.length} (must be 0)`);
  const mediumClaude = samples.filter((s) => s.kind === "medium" && s.tier !== "none");
  console.log(`medium samples that reached Claude: ${mediumClaude.length}/${samples.filter((s) => s.kind === "medium").length}`);

  // Machine-readable line for the log entry.
  const pairs = FIXTURES.filter((f) => f.kind === "big")
    .map((f) => {
      const s = samples.filter((x) => x.text === f.text);
      if (!s.length) return undefined;
      const top = s.reduce((a, b) => a + b.top, 0) / s.length;
      const lead = s.reduce((a, b) => a + b.lead, 0) / s.length;
      return { top: Math.round(top * 10000) / 10000, lead: Math.round(lead * 10000) / 10000, big: top >= th.bigP && lead >= th.bigLead, text: f.text.slice(0, 46) };
    })
    .filter((x): x is { top: number; lead: number; big: boolean; text: string } => !!x);
  console.log(`\nCALIBRATION_PAIRS ${JSON.stringify(pairs.filter((p) => p.big))}`);
  console.log(`\nCALIBRATION_RESULT ${JSON.stringify({ nBig: bigSamples.length, best, scores: SCORES, leads: LEADS, handShare: hand / bigSamples.length, smallClaude: smallClaude.length })}`);
  console.log(`\n# decision log: ${path.join(process.env.COMPANY_ROOT!, "budget", "brain-decisions.jsonl")} (sandbox, not the live one)`);
  if (smallClaude.length) process.exitCode = 3;
}

main().catch((e) => {
  console.error("calibration failed:", e);
  process.exitCode = 1;
});
