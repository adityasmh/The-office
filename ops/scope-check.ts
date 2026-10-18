// Order F7-no-scope-creep proof. Pure check: fake model functions (nothing runs
// a model, network or router), temp folders via the sandbox import below.
// It packs fixtures, builds the three stage prompts with the same building
// blocks the pipeline uses (ROLES system prompts + the pure prompt builders),
// and exercises the pure helper findAddedRequirements.
import "./sandbox-company-root.js";
import { ROLES } from "../src/company/roles.js";
import {
  buildTesterPrompt,
  buildManagerReviewPrompt,
  ORIGINAL_ORDER_LABEL,
  TESTER_ORDER_RULE,
  MANAGER_ORDER_RULE,
} from "../src/company/pipeline.js";

// ── Pure helper (Order F7 Proof) ─────────────────────────────────────────────
// Simple rule: any "must"/"should"/"required" sentence in the brief that has
// no overlap (shared non-stopword word) with the order text is an added
// requirement. Verbatim echoes of the order overlap by construction, so a
// faithful brief is never flagged.
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "than", "so", "as", "at", "by", "from", "into",
  "of", "off", "on", "onto", "to", "for", "with", "is", "are", "was", "were", "be", "been", "being",
  "it", "its", "that", "this", "these", "those", "any", "all", "only", "may", "can", "shall",
  "must", "should", "required", "not", "do", "does", "did", "own", "once", "every", "when",
  "i", "we", "you", "he", "she", "my", "our", "your", "their", "his", "her", "they", "them",
]);

function tokens(text: string): string[] {
  return (String(text).toLowerCase().match(/[a-z]+/g) ?? []).filter((t) => t.length >= 3);
}

function sentences(text: string): string[] {
  return String(text ?? "")
    .split(/(?:\r?\n)|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function findAddedRequirements(order: unknown, enhanced: unknown): string[] {
  const orderTokens = new Set(tokens(String(order ?? "")));
  const flags: string[] = [];
  for (const sentence of sentences(String(enhanced ?? ""))) {
    if (!/\b(must|should|required)\b/i.test(sentence)) continue;
    const shared = tokens(sentence).some((t) => !STOPWORDS.has(t) && orderTokens.has(t));
    if (!shared) flags.push(sentence);
  }
  return flags;
}

// ── Fixtures (clearly fake; no real order is used) ───────────────────────────
const FAKE_ORDER = [
  "Order X0-fake-fixture (clearly fake test data, never a real task):",
  "Add a greet() export to src/fake/widget.ts and note the run in the fake report.",
  "## Requirements",
  "- The fixture widget must print PASS when the fake check runs.",
  "## Files",
  "- src/fake/widget.ts (new), src/fake/report.md (new)",
  "## Proof",
  "PASS or FAIL for: src/fake/widget.ts exists and the fake check prints PASS; the fake report file exists. Run npm run typecheck once and paste the result.",
].join("\n");

// Faithful brief: restates the order (its own Files and Proof sections are
// copied verbatim) plus allowed clarifying detail — no new requirements.
const FAITHFUL_BRIEF = [
  "ENHANCED BRIEF (fake fixture)",
  FAKE_ORDER,
  "CLARIFYING DETAIL (derived from the order, no new requirements): the files live under the project root in src/fake/ and the fake check is offline.",
].join("\n");

// Enhanced brief with one extra requirement that the order never asked for.
const CREEP_SENTENCE = "The demo tenant must persist UI layout preferences in browser localStorage.";
const CREEP_BRIEF = `${FAITHFUL_BRIEF}\n\n${CREEP_SENTENCE}`;

// ── Cheap fake model functions: never called with anything real ──────────────
const FAKE_MODEL = (prompt: string) => `FAKE OUTPUT for "${prompt.slice(0, 60)}"`;
const fakeEnhancer = (_request: string) => FAITHFUL_BRIEF; // fake enhancer model stands in for the router
void FAKE_MODEL;
void fakeEnhancer;

// ── Built prompts (same building blocks the pipeline stages use) ─────────────
const enhancerPrompt = `${ROLES["prompt-enhancer"].systemPrompt}\n\n${ORIGINAL_ORDER_LABEL}:\n${FAKE_ORDER}`;
const testerPrompt = buildTesterPrompt({
  subtask: "Fake subtask: add greet() to src/fake/widget.ts (fixture)",
  brief: FAITHFUL_BRIEF,
  work: "(fixture: coder wrote the fake widget)",
  packText: "(fixture facts-from-disk pack)",
  request: FAKE_ORDER,
});
const managerPrompt = buildManagerReviewPrompt({
  request: FAKE_ORDER,
  plan: "(fixture plan)",
  work: "(fixture coder output)",
  reviews: "(fixture tester review)",
  packText: "(fixture facts-from-disk pack)",
});

type Check = { id: string; parts: Array<{ label: string; ok: boolean }> };
const checks: Array<Check> = [];
const has = (text: string, needle: string): boolean => text.includes(needle);

// (a) The three built prompts contain the instruction text and the original order text.
checks.push({
  id: "(a1) enhancer prompt restates the order, forbids added requirements, keeps Files+Proof verbatim",
  parts: [
    { label: "restate faithfully", ok: has(enhancerPrompt, "Restate the order faithfully") },
    { label: "may add clarifying detail and file paths", ok: has(enhancerPrompt, "may add clarifying detail and file paths") },
    { label: "forbids new requirements/features/checks/acceptance criteria", ok: has(enhancerPrompt, "must NOT add new requirements, features, checks or acceptance criteria") },
    { label: "Files list and Proof section verbatim", ok: has(enhancerPrompt, "Files list and Proof section verbatim") },
    { label: "original order text", ok: has(enhancerPrompt, FAKE_ORDER) },
    { label: "labelled ORIGINAL ORDER (authoritative)", ok: has(enhancerPrompt, `${ORIGINAL_ORDER_LABEL}:\n${FAKE_ORDER}`) },
  ],
});
checks.push({
  id: "(a2) tester prompt contains the instruction text and the original order text",
  parts: [
    { label: "ORIGINAL ORDER (authoritative)", ok: has(testerPrompt, ORIGINAL_ORDER_LABEL) },
    { label: "order rule text (exported constant)", ok: has(testerPrompt, TESTER_ORDER_RULE) },
    { label: "ONLY vs order's Files+Proof", ok: has(testerPrompt, "ONLY against the order's own Files list and Proof section") },
    { label: "note-never-FAIL rule", ok: has(testerPrompt, "never makes the verdict FAIL") },
    { label: "original order text", ok: has(testerPrompt, FAKE_ORDER) },
  ],
});
checks.push({
  id: "(a3) manager review prompt contains the instruction text and the original order text",
  parts: [
    { label: "ORIGINAL ORDER (authoritative)", ok: has(managerPrompt, ORIGINAL_ORDER_LABEL) },
    { label: "order rule text (exported constant)", ok: has(managerPrompt, MANAGER_ORDER_RULE) },
    { label: "PASS definition", ok: has(managerPrompt, "A verdict is PASS when every item of the order's Files list exists and its Proof command prints PASS, even if the work could be better.") },
    { label: "original order text", ok: has(managerPrompt, FAKE_ORDER) },
  ],
});

// (b) findAddedRequirements flags an added requirement, not the faithful brief.
const faithfulFlags = findAddedRequirements(FAKE_ORDER, FAITHFUL_BRIEF);
const creepFlags = findAddedRequirements(FAKE_ORDER, CREEP_BRIEF);
checks.push({
  id: "(b1) faithful brief (order Files+Proof verbatim) is not flagged",
  parts: [{ label: `flags=${faithfulFlags.length} (expected 0)`, ok: faithfulFlags.length === 0 }],
});
checks.push({
  id: "(b2) enhanced brief with an extra requirement is flagged exactly once",
  parts: [
    { label: `flags=${creepFlags.length} (expected 1)`, ok: creepFlags.length === 1 },
    { label: "flagged sentence is the added one", ok: creepFlags.length === 1 && creepFlags[0] === CREEP_SENTENCE },
  ],
});

// (c) The tester prompt marks the enhanced brief as context.
checks.push({
  id: "(c) tester prompt marks the enhanced brief as context",
  parts: [{ label: "enhanced brief is context only", ok: has(testerPrompt, "the enhanced brief is context only") }],
});

let overall = true;
for (const c of checks) {
  const ok = c.parts.every((p) => p.ok);
  console.log(`${ok ? "PASS" : "FAIL"} - ${c.id}`);
  for (const p of c.parts) {
    console.log(`      ${p.ok ? "PASS" : "FAIL"} - ${p.label}`);
  }
  if (!ok) overall = false;
}
console.log(overall ? "PASS: scope-check passed all assertions" : "FAIL: scope-check failed");
process.exitCode = overall ? 0 : 1;
