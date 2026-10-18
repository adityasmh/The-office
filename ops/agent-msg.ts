/**
 * ops/agent-msg.ts - leave a peer a short note on the order board, or read your own inbox.
 *
 * Order R4-agent-mailbox (docs/overnight/ORDER_R4-agent-mailbox.md). The board is
 * company/fleet/<orderId>/BOARD.jsonl (append-only), and the limits live in
 * src/company/fleetTalk.ts - this tool only parses arguments and prints a plain answer.
 * No server is involved, so it returns immediately and never waits for a reply.
 *
 *   npx tsx ops/agent-msg.ts send --order <id> --from <woId> --to <woId|*> --kind note --text "..."
 *   npx tsx ops/agent-msg.ts inbox --order <id> --wo <woId>
 *
 * `inbox` prints only messages addressed to that work order or to "*" that it has not printed
 * before (a small state file sits beside the board). A refused message prints the plain reason
 * and exits 1. FLEET_TALK=1 must be set (the flag is off by default).
 */
import { markSeen, postMessage, readInbox, seenId, talkEnabled } from "../src/company/fleetTalk.js";

class UsageError extends Error {}

type SendOpts = { mode: "send"; order: string; from: string; to: string; kind: string; text: string };
type InboxOpts = { mode: "inbox"; order: string; wo: string };
type Opts = SendOpts | InboxOpts | { mode: "help" };

function parseArgs(args: string[]): Opts {
  const mode = args[0] ?? "";
  if (!mode || mode === "help" || mode === "--help" || mode === "-h") return { mode: "help" };
  if (mode !== "send" && mode !== "inbox") throw new UsageError(`unknown command "${mode}" (use \`send\` or \`inbox\`)`);
  let order = "";
  let from = "";
  let to = "";
  let kind = "note";
  let text = "";
  let wo = "";
  for (let i = 1; i < args.length; i++) {
    const a = args[i] ?? "";
    const val = (): string => args[++i] ?? "";
    if (a === "--order") order = val();
    else if (a === "--from") from = val();
    else if (a === "--to") to = val();
    else if (a === "--kind") kind = val();
    else if (a === "--text") text = val();
    else if (a === "--wo") wo = val();
    else if (a === "--help" || a === "-h") return { mode: "help" };
    else throw new UsageError(`unknown option "${a}"`);
  }
  if (!order) throw new UsageError("--order is required");
  if (mode === "send") {
    if (!from) throw new UsageError("--from is required");
    if (!to) throw new UsageError("--to is required");
    if (!text) throw new UsageError("--text is required");
    return { mode: "send", order, from, to, kind, text };
  }
  if (!wo) throw new UsageError("--wo is required");
  return { mode: "inbox", order, wo };
}

function printUsage(): void {
  console.log(`agent-msg - leave a short note for a teammate, or read your own inbox

usage:
  npx tsx ops/agent-msg.ts send --order <id> --from <woId> --to <woId|*> --kind <note|question|answer|handoff> --text "..."
  npx tsx ops/agent-msg.ts inbox --order <id> --wo <woId>

The board is company/fleet/<orderId>/BOARD.jsonl. FLEET_TALK=1 turns talk on (default off).
Limits: 6 messages per work order per order, 2 question-and-answer rounds per pair, 400 chars.
A message never waits for a reply.`);
}

function main(): number {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.mode === "help") {
    printUsage();
    return 0;
  }

  if (!talkEnabled()) {
    console.error("agent-msg: talk is off (set FLEET_TALK=1)");
    return 1;
  }

  if (opts.mode === "send") {
    const res = postMessage({ orderId: opts.order, from: opts.from, to: opts.to, kind: opts.kind, text: opts.text });
    if (!res.ok) {
      console.error(`agent-msg: refused: ${res.reason}`);
      return 1;
    }
    console.log(`sent ${res.message.id}: ${res.message.from} -> ${res.message.to} (${res.message.kind})`);
    return 0;
  }

  const messages = readInbox(opts.order, opts.wo);
  if (!messages.length) {
    console.log(`inbox: no new messages for ${opts.wo}`);
    return 0;
  }
  for (const m of messages) {
    console.log(`${m.id} ${m.from} -> ${m.to} [${m.kind}] ${m.text}`);
  }
  // Remember the newest message this worker was addressed by, so the next read shows each once.
  const newest = messages[messages.length - 1];
  if (newest && newest.id > seenId(opts.order, opts.wo)) markSeen(opts.order, opts.wo, newest.id);
  return 0;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error(`agent-msg: ${e instanceof UsageError ? e.message : String((e as Error)?.message ?? e)}`);
  if (e instanceof UsageError) printUsage();
  process.exitCode = 1;
}
