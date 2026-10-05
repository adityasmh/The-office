/**
 * ops/ceo-context-print.ts — print the LIVE COMPANY CONTEXT digest the CEO's
 * assistant is given on every turn (src/company/ceoContext.ts).
 *
 *   node_modules/.bin/tsx --env-file=.env ops/ceo-context-print.ts [--max 3000] [--json]
 *
 * Read-only and cheap: this only prints what buildUserPrompt() would embed. It
 * makes no model call and writes nothing, so it is safe to run at any time.
 */
import "dotenv/config";
import { CEO_CONTEXT_MAX_CHARS, ceoContextDigest } from "../src/company/ceoContext.js";

const argv = process.argv.slice(2);
const maxFlag = argv.indexOf("--max");
const max = maxFlag >= 0 ? Number(argv[maxFlag + 1]) || CEO_CONTEXT_MAX_CHARS : CEO_CONTEXT_MAX_CHARS;
const asJson = argv.includes("--json");

const digest = ceoContextDigest(max);

if (asJson) {
  console.log(JSON.stringify({ max, chars: digest.length, digest }, null, 2));
} else {
  console.log(`=== LIVE COMPANY CONTEXT (max ${max} chars) — ${digest.length} chars ===`);
  console.log(digest);
  console.log("=== end of digest ===");
  console.log(`[ceo-context] length=${digest.length} bound=${max} within=${digest.length <= max}`);
  const statusLines = digest.split("\n").filter((l) => l.trim().startsWith("tasks ("));
  console.log(`[ceo-context] per-project task-status lines: ${statusLines.length}`);
  for (const l of statusLines) console.log(`  ${l.trim()}`);
}
