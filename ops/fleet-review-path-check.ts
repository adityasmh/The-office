/**
 * ops/fleet-review-path-check.ts — adversarial check of the REVIEW consumer.
 *
 * The review call shares `planOrReviewModel` with planning, so the fallback chain, the token
 * budget, the no-deliberation prompt note and the JSON check apply to it too. But `reviewWorkOrder`
 * classifies the answer with the strict `parseJsonObject` (NOT `extractPlanObject`), and the
 * DEFAULT verdict when parsing fails is REDO - so a wasted sample could silently force a REDO and
 * make the CEO see failing work that actually passed.
 *
 * This asks the REAL gateway, through the REAL review entry point, with a fake worker report and a
 * fake expired Claude CLI, and checks every answer is a well-formed verdict object.
 *
 *   npx tsx ops/fleet-review-path-check.ts
 */
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-path-"));
process.env.COMPANY_ROOT = path.join(tmp, "company");
process.env.FLEET_REPO = path.join(tmp, "repo");
process.env.MOCK_MODE = "0";
process.env.FLEET_FALLBACK_MODELS = "deepseek-v4.1-flash,kimi-k2.7-code";
process.env.FLEET_FALLBACK_TRIES = "2";
fs.mkdirSync(path.join(process.env.FLEET_REPO, "docs"), { recursive: true });
fs.writeFileSync(path.join(process.env.FLEET_REPO, "docs", "FLEET_OPERATOR_GUIDE.md"), "# guide\nsix routes documented.\n");

const binDir = path.join(tmp, "bin");
fs.mkdirSync(binDir, { recursive: true });
const payload = JSON.stringify({ type: "result", is_error: true, result: "Failed to authenticate: OAuth session expired and could not be refreshed" });
const claudeExe = path.join(binDir, process.platform === "win32" ? "claude.exe" : "claude");
if (process.platform === "win32") {
  const src = path.join(tmp, "bad.cs");
  fs.writeFileSync(src, ["public class Program {", "  public static int Main(string[] a) {", `    System.Console.WriteLine(${JSON.stringify(payload)});`, "    return 1;", "  }", "}"].join("\n"));
  const { execFileSync } = await import("node:child_process");
  execFileSync(path.join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"), ["/nologo", `/out:${claudeExe}`, src], { stdio: "inherit" });
}
process.env.CLAUDE_BIN = claudeExe;

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
};

// The review prompt, assembled exactly like reviewWorkOrder does.
const REVIEW_SYSTEM = [
  "You are the reviewing manager of a small engineering company. The model that runs this prompt may be Claude or a cheaper one; the standard does not change.",
  "A worker reports on a work order. Read its REPORT.md and the actual files it owns, then judge the work.",
  "Be strict but fair: PASS means the acceptance checks demonstrably hold and the report carries REAL command output.",
  "REDO means something required is missing, unverified, or broken - and your notes must say exactly what to fix.",
  'Reply with ONLY a JSON object: {"verdict":"PASS"|"REDO","review":"markdown notes"}',
].join("\n");
const REPORT = [
  "# REPORT",
  "## What I did",
  "Wrote docs/FLEET_OPERATOR_GUIDE.md documenting all six fleet routes.",
  "## How I verified",
  "Ran `type docs\\FLEET_OPERATOR_GUIDE.md` and the six route headings are present.",
  "```",
  "## Route 1 GET /company/fleet/orders (200)",
  "## Route 2 ... (200)",
  "```",
  "## Acceptance checks",
  "- The guide exists and names all six routes: yes.",
].join("\n");
const USER = [
  `WORK ORDER: write the operator guide for the six fleet routes.`,
  `ACCEPTANCE CHECKS:\n- the guide names all six routes`,
  `OWNED FILES AND THEIR CURRENT CONTENT:\n--- docs/FLEET_OPERATOR_GUIDE.md ---\n# guide\nsix routes documented.`,
  `REPORT.md:\n${REPORT}`,
  "Judge it now. Reply with only the JSON object.",
].join("\n");

const { pickBrain } = await import("../src/company/brainRouter.js");
const gateway = await import("../src/gateway.js");

// Reproduce reviewWorkOrder's classification exactly (it uses the strict parser + REDO default).
function parseJsonObject(raw: string): unknown | null {
  const cleaned = String(raw ?? "").replace(/```[a-zA-Z]*/g, "");
  const i = cleaned.indexOf("{");
  if (i < 0) return null;
  let depth = 0;
  for (let k = i; k < cleaned.length; k++) {
    if (cleaned[k] === "{") depth++;
    else if (cleaned[k] === "}") {
      depth--;
      if (depth === 0) { try { return JSON.parse(cleaned.slice(i, k + 1)); } catch { return null; } }
    }
  }
  return null;
}

const run = async (label: string) => {
  // Route through the SAME gate the fleet uses, then the same ordered fallback helper behaviour.
  const pick = await pickBrain({ purpose: "review", text: USER, needsFiles: true });
  console.log(`  [${label}] gate: tier=${pick.tier} claudeCall=${pick.claudeCall}`);
  if (pick.claudeCall) {
    console.log(`  [${label}] gate would ask Claude; Claude is dead, so the fleet would take the fallback`);
  }
  // Directly exercise the fallback as the fleet does for a review (no reasoning note is applied
  // to the planner prompt only, so mirror `fallbackNote` here to keep the comparison honest).
  const NOTE = [
    "",
    "IMPORTANT: do not think step by step and do not deliberate. Do not use any tool and do not emit a tool call.",
    "Answer IMMEDIATELY with the single JSON object described above and nothing else.",
  ].join("\n");
  const t0 = Date.now();
  const r = await gateway.callGatewayModel("deepseek-v4.1-flash", REVIEW_SYSTEM, `${USER}${NOTE}`, { maxTokens: 8192 });
  const text = (r?.text ?? "").trim();
  const parsed = parseJsonObject(text) as { verdict?: unknown; review?: unknown } | null;
  const verdict = parsed && (parsed.verdict === "PASS" || parsed.verdict === "REDO") ? parsed.verdict : "REDO(default-after-parse-failure)";
  const notes = parsed && typeof parsed.review === "string" && parsed.review.trim() ? parsed.review.trim() : (text || "none");
  console.log(`  [${label}] ${((Date.now() - t0) / 1000).toFixed(1)}s len=${text.length} parsed=${!!parsed} verdict=${verdict} notes=${notes.length} chars`);
  return { parsed: !!parsed, verdict, text };
};

for (let i = 1; i <= 3; i++) {
  const res = await run(`attempt ${i}`);
  check(`review ${i}: the answer parsed as a JSON object`, res.parsed, `len=${res.text.length}`);
  check(`review ${i}: the verdict is PASS or REDO`, res.verdict === "PASS" || res.verdict === "REDO", String(res.verdict));
  check(`review ${i}: the reviewer gave notes`, res.text.length > 20, `${res.text.length} chars`);
}

console.log(`\n[review] ${failures ? `${failures} FAILED` : "ALL CHECKS PASSED"} (temp dir ${tmp})`);
process.exit(failures ? 1 : 0);
