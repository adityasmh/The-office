/**
 * ops/terminals-print.ts — print what the Terminals page will show, read-only.
 *
 *   npx tsx ops/terminals-print.ts [--json] [--tail <sessionId>] [--lines 20]
 *
 * Reads `%USERPROFILE%\.jcode\` and `company/terminals.json` and prints the live
 * terminal list (name, role, state, description, model, last activity) plus, with
 * `--tail`, the human-readable tail of one session. It writes NOTHING and makes no
 * model call, so it is safe to run against the live install at any time.
 */
import "dotenv/config";
import { listLiveTerminals, terminalTail, terminalChatStatus } from "../src/company/terminalChat.js";

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const tailIdx = argv.indexOf("--tail");
const tailId = tailIdx >= 0 ? argv[tailIdx + 1] : "";
const linesIdx = argv.indexOf("--lines");
const lines = linesIdx >= 0 ? Number(argv[linesIdx + 1]) || 20 : 20;

const status = terminalChatStatus();
const payload = await listLiveTerminals();

if (asJson) {
  console.log(JSON.stringify({ status, payload }, null, 2));
} else {
  console.log(`jcode home : ${status.jcodeHome}`);
  console.log(`jcode bin  : ${status.jcodeBin}`);
  console.log(
    `sessions   : ${payload.counts.total} (working ${payload.counts.working}, idle ${payload.counts.idle}, ` +
      `closed ${payload.counts.closed}; closed kept ${status.closedKeepMinutes} min)`,
  );
  for (const t of payload.terminals) {
    const card = t.runCard
      ? ` | runcard: ${t.runCard.doneCount} done / ${t.runCard.remainingCount} remaining${t.runCard.verdict ? ` | ${t.runCard.verdict}` : ""}`
      : "";
    console.log(
      `[${t.state.padEnd(7)}] ${String(t.name).padEnd(12)} ${(t.role || "(no role)").padEnd(30)} ` +
        `${String(t.model).padEnd(20)} ${t.idleSeconds ?? "?"}s ago`,
    );
    console.log(`            ${t.description}${card}`);
  }
}

if (tailId) {
  const tail = terminalTail(tailId, lines);
  console.log(`\n=== tail of ${tail.name} (${tailId}), state=${tail.state}, ${tail.lines.length} lines ===`);
  for (const l of tail.lines) console.log(`${l.ts} [${l.who}] ${l.text}`);
}
