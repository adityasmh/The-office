/**
 * ops/agent-talk-check.ts - proof for R4-agent-mailbox (docs/overnight/ORDER_R4-agent-mailbox.md, 2026-10-06).
 *
 * PASS or FAIL per line:
 *   1  off by default (the brief is byte-identical to before, posting is refused)
 *   2  post and read round trip
 *   3  "*" reaches everyone but the sender
 *   4  inbox shows each message once (the seen watermark)
 *   5  the hard limits are reported
 *   6  the 7th message is refused with a plain reason
 *   7  the 3rd question-and-answer round between a pair is refused
 *   8  401 characters is refused
 *   9  a message to itself is refused
 *  10  an exact duplicate of the sender's previous text is refused
 *  11  a sender that is not a work order of that order is refused
 *  12  a fake token is redacted to [redacted]
 *  13  the Teammates section appears only with two or more work orders
 *  14  the command line tool works end to end on a temp board (inbox once per message)
 *  15  the command line tool prints a plain error and exits 1 on a refusal
 *  16  the watcher writes one "worker message" trace hop per new board line, once
 *
 * Everything runs against a THROWAWAY COMPANY_ROOT and FLEET_REPO in %TEMP%: no server, no
 * network, no terminal spawned (MIN_FREE_RAM_MB is set above any real machine's free RAM so the
 * tick's fillSlots() stops at its floor). MOCK_MODE=1 keeps any review deterministic.
 *
 *   npx tsx ops/agent-talk-check.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-talk-"));
process.env.COMPANY_ROOT = path.join(tmp, "company");
process.env.FLEET_REPO = path.join(tmp, "repo");
process.env.MOCK_MODE = "1";
process.env.FLEET_AUTO_APPROVE = "0";
process.env.FLEET_WATCH_INTERVAL_MS = "600000";
process.env.MIN_FREE_RAM_MB = "1000000"; // above any real machine's free RAM: fillSlots() always stops
delete process.env.FLEET_TALK; // the feature starts OFF

const companyRoot = process.env.COMPANY_ROOT;
const repo = process.env.FLEET_REPO;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
fs.mkdirSync(path.join(companyRoot, "fleet"), { recursive: true });
fs.mkdirSync(path.join(repo, "docs"), { recursive: true });

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
};

// ── fixtures: one order per behaviour, so no test can spend another test's limits ─────────────
type Wo = { id: string; title: string; role: string; owns: string[]; brief: string; done: string[]; state: string; attempts: number };
type Ord = { id: string; text: string; createdAt: string; updatedAt: string; status: string; workOrders: Wo[]; trace: unknown[] };

const at = "2026-10-06T06:00:00.000Z";
const mkWo = (id: string, role: string, owns: string[]): Wo => ({ id, title: `fixture ${id}`, role, owns, brief: "fixture", done: ["the fixture holds"], state: "working", attempts: 0 });
const mkOrder = (id: string, wos: Wo[]): Ord => ({ id, text: "(talk fixture)", createdAt: at, updatedAt: at, status: "running", workOrders: wos, trace: [] });

const ordTwo = mkOrder("ORD-TWO", [mkWo("WO-A", "code", ["src/a.ts"]), mkWo("WO-B", "code", ["src/x.ts"]), mkWo("WO-C", "docs", ["docs/y.md"])]);
const ordOne = mkOrder("ORD-ONE", [mkWo("WO-SOLO", "code", ["src/solo.ts"])]);
const twoWoOrders = ["ORD-RT", "ORD-CAP", "ORD-ROUND", "ORD-LONG", "ORD-SELF", "ORD-DUP", "ORD-FOREIGN", "ORD-TOKEN", "ORD-CLI", "ORD-TRACE"];
const orders: Ord[] = [ordTwo, ordOne, ...twoWoOrders.map((id) => mkOrder(id, [mkWo("WO-A", "code", ["src/a.ts"]), mkWo("WO-B", "code", ["src/b.ts"])]))];
fs.writeFileSync(path.join(companyRoot, "fleet", "orders.json"), JSON.stringify(orders, null, 2));

console.log(`# throwaway COMPANY_ROOT=${companyRoot}`);
console.log(`# FLEET_TALK off by default; no server, no network, no terminal`);
console.log("");

// Imported AFTER COMPANY_ROOT is set (org.ts captures COMPANY_ROOT at import time).
const talk = await import("../src/company/fleetTalk.js");
const fleet = await import("../src/company/fleet.js");

// ── 1. off by default ─────────────────────────────────────────────────
const briefOff1 = fleet.briefBody(ordTwo, ordTwo.workOrders[0]);
const refusedOff = talk.postMessage({ orderId: "ORD-TWO", from: "WO-A", to: "WO-B", kind: "note", text: "hi" });
process.env.FLEET_TALK = "1";
const briefOn = fleet.briefBody(ordTwo, ordTwo.workOrders[0]);
const startOfTeammates = briefOn.indexOf("\n\nTEAMMATES (");
const startOfFinish = briefOn.indexOf("\n\nFINISH:");
const stripped = startOfTeammates >= 0 && startOfFinish > startOfTeammates
  ? briefOn.slice(0, startOfTeammates) + briefOn.slice(startOfFinish)
  : briefOn;
delete process.env.FLEET_TALK;
const briefOff2 = fleet.briefBody(ordTwo, ordTwo.workOrders[0]);
check(
  "off by default (brief identical, posting refused)",
  !briefOff1.includes("TEAMMATES") && briefOff2 === briefOff1 && stripped === briefOff1 && refusedOff.ok === false && talk.talkEnabled() === false,
  refusedOff.ok ? "post was accepted with the flag off" : refusedOff.reason,
);

// From here on the feature is ON.
process.env.FLEET_TALK = "1";

// ── 2. post and read round trip ───────────────────────────────────────
const rt = talk.postMessage({ orderId: "ORD-RT", from: "WO-A", to: "WO-B", kind: "note", text: "handoff: I changed fn()" });
const board = talk.readBoard("ORD-RT");
const inboxB = talk.readInbox("ORD-RT", "WO-B", "");
check(
  "post and read round trip",
  rt.ok === true && board.length === 1 && inboxB.length === 1 && inboxB[0].from === "WO-A" && inboxB[0].to === "WO-B" && inboxB[0].kind === "note" && inboxB[0].text === "handoff: I changed fn()" && inboxB[0].id === "m000001",
  rt.ok ? `${board.length} on the board` : rt.reason,
);

// ── 3. "*" reaches everyone but the sender ────────────────────────────
const cast = talk.postMessage({ orderId: "ORD-RT", from: "WO-A", to: "*", kind: "note", text: "note: interface changed" });
const asB = talk.readInbox("ORD-RT", "WO-B", "");
const asA = talk.readInbox("ORD-RT", "WO-A", "");
check(
  "'*' reaches everyone but the sender",
  cast.ok === true && asB.some((m) => m.text === "note: interface changed") && !asA.some((m) => m.text === "note: interface changed"),
  `B sees ${asB.length}, A sees ${asA.length}`,
);

// ── 4. inbox shows each message once ──────────────────────────────────
const firstRead = talk.readInbox("ORD-RT", "WO-B");
if (firstRead.length) talk.markSeen("ORD-RT", "WO-B", firstRead[firstRead.length - 1].id);
const secondRead = talk.readInbox("ORD-RT", "WO-B");
check(
  "inbox shows each message once (seen watermark)",
  firstRead.length === 2 && secondRead.length === 0,
  `first=${firstRead.length} second=${secondRead.length}`,
);

// ── 5. the hard limits are reported ───────────────────────────────────
const limits = talk.limitsFor("ORD-CAP");
check(
  "limitsFor reports the hard limits",
  limits.maxMessagesPerOrder === 6 && limits.maxRoundsPerPair === 2 && limits.maxChars === 400,
  JSON.stringify(limits),
);

// ── 6. the 7th message is refused ─────────────────────────────────────
let sixOk = true;
for (let n = 0; n < 6; n++) {
  const r = talk.postMessage({ orderId: "ORD-CAP", from: "WO-A", to: "WO-B", kind: "note", text: `note ${n}` });
  if (!r.ok) sixOk = false;
}
const seventh = talk.postMessage({ orderId: "ORD-CAP", from: "WO-A", to: "WO-B", kind: "note", text: "note six-plus" });
check(
  "7th message refused with a plain reason",
  sixOk && seventh.ok === false && /6 messages/.test(seventh.ok ? "" : seventh.reason),
  seventh.ok ? "the 7th was accepted" : seventh.reason,
);

// ── 7. the 3rd question-and-answer round is refused ───────────────────
talk.postMessage({ orderId: "ORD-ROUND", from: "WO-A", to: "WO-B", kind: "question", text: "q1" });
talk.postMessage({ orderId: "ORD-ROUND", from: "WO-A", to: "WO-B", kind: "question", text: "q2" });
const q3 = talk.postMessage({ orderId: "ORD-ROUND", from: "WO-A", to: "WO-B", kind: "question", text: "q3" });
check(
  "3rd question-and-answer round refused with a plain reason",
  q3.ok === false && /rounds/.test(q3.ok ? "" : q3.reason),
  q3.ok ? "the 3rd round was accepted" : q3.reason,
);

// ── 8. 401 characters is refused ──────────────────────────────────────
const long = talk.postMessage({ orderId: "ORD-LONG", from: "WO-A", to: "WO-B", kind: "note", text: "x".repeat(401) });
check(
  "401 characters refused",
  long.ok === false && /400 characters/.test(long.ok ? "" : long.reason),
  long.ok ? "the long message was accepted" : long.reason,
);

// ── 9. a message to itself is refused ─────────────────────────────────
const self = talk.postMessage({ orderId: "ORD-SELF", from: "WO-A", to: "WO-A", kind: "note", text: "me" });
check(
  "message to itself refused",
  self.ok === false && /itself/.test(self.ok ? "" : self.reason),
  self.ok ? "the self message was accepted" : self.reason,
);

// ── 10. an exact duplicate is refused ─────────────────────────────────
talk.postMessage({ orderId: "ORD-DUP", from: "WO-A", to: "WO-B", kind: "note", text: "same words" });
const dup = talk.postMessage({ orderId: "ORD-DUP", from: "WO-A", to: "WO-B", kind: "note", text: "same words" });
check(
  "exact duplicate of the sender's previous text refused",
  dup.ok === false && /duplicate/.test(dup.ok ? "" : dup.reason),
  dup.ok ? "the duplicate was accepted" : dup.reason,
);

// ── 11. a foreign sender is refused ───────────────────────────────────
const foreign = talk.postMessage({ orderId: "ORD-FOREIGN", from: "WO-ZZ", to: "WO-A", kind: "note", text: "not mine" });
check(
  "foreign sender refused",
  foreign.ok === false && /not a work order/.test(foreign.ok ? "" : foreign.reason),
  foreign.ok ? "the foreign sender was accepted" : foreign.reason,
);

// ── 12. a fake token is redacted ──────────────────────────────────────
const tok = talk.postMessage({ orderId: "ORD-TOKEN", from: "WO-A", to: "WO-B", kind: "note", text: "the key is sk" + "-live0123456789abcdefghijkl ok" });
const stored = talk.readBoard("ORD-TOKEN")[0]?.text ?? "";
check(
  "a fake token is redacted",
  tok.ok === true && stored.includes("[redacted]") && !stored.includes("sk" + "-live0123456789abcdefghijkl"),
  stored,
);

// ── 13. the Teammates section appears only with two or more work orders ─
const briefSolo = fleet.briefBody(ordOne, ordOne.workOrders[0]);
const briefTwo = fleet.briefBody(ordTwo, ordTwo.workOrders[0]);
check(
  "Teammates section only with 2+ work orders",
  !briefSolo.includes("TEAMMATES") &&
    briefTwo.includes("TEAMMATES") &&
    briefTwo.includes("WO-B") && briefTwo.includes("WO-C") &&
    briefTwo.includes("role code") && briefTwo.includes("src/x.ts") &&
    briefTwo.includes("--order ORD-TWO --from WO-A") &&
    briefTwo.includes("--order ORD-TWO --wo WO-A") &&
    briefTwo.includes("never in a loop") && briefTwo.includes("never wait for answer"),
  `solo=${briefSolo.includes("TEAMMATES") ? "has TEAMMATES" : "none"}`,
);

// ── 14/15. the command line tool, end to end ──────────────────────────
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const tool = path.join(repoRoot, "ops", "agent-msg.ts");
const cliEnv = { ...process.env, COMPANY_ROOT: companyRoot, FLEET_REPO: repo, FLEET_TALK: "1" };
const runCli = (args: string[]): string =>
  execFileSync(process.execPath, [tsxCli, tool, ...args], { env: cliEnv, encoding: "utf8", windowsHide: true });

const sendOut = runCli(["send", "--order", "ORD-CLI", "--from", "WO-A", "--to", "WO-B", "--kind", "note", "--text", "cli hello"]);
const inbox1 = runCli(["inbox", "--order", "ORD-CLI", "--wo", "WO-B"]);
const inbox2 = runCli(["inbox", "--order", "ORD-CLI", "--wo", "WO-B"]);
check(
  "the command line tool works end to end (inbox once per message)",
  /sent m\d+/.test(sendOut) && inbox1.includes("cli hello") && /no new messages/.test(inbox2),
  `${sendOut.trim()} | ${inbox1.trim()} | ${inbox2.trim()}`,
);

let cliRefusal = "";
try {
  runCli(["send", "--order", "ORD-CLI", "--from", "WO-ZZ", "--to", "WO-B", "--kind", "note", "--text", "x"]);
} catch (e) {
  const err = e as Error & { stderr?: Buffer | string; status?: number };
  cliRefusal = `${String(err.stderr ?? "")}${err.message}`;
}
check(
  "the command line tool prints a plain error and exits 1 on a refusal",
  /refused/.test(cliRefusal) && /not a work order/.test(cliRefusal),
  cliRefusal.replace(/\s+/g, " ").trim().slice(0, 160),
);

// ── 16. the watcher traces each new board line once ───────────────────
const traceHops = (orderId: string): Array<{ from: string; what: string; detail: string }> => {
  // loadFleetOrders() returns the value tickFleet just mutated (its save is queued async, so
  // reading the file straight after the tick can race the write).
  const list = fleet.loadFleetOrders() as unknown as Array<{ id: string; trace?: Array<{ from: string; what: string; detail?: string }> }>;
  const order = list.find((o) => o.id === orderId);
  return (order?.trace ?? []).filter((t) => t.what === "worker message") as Array<{ from: string; what: string; detail: string }>;
};
talk.postMessage({ orderId: "ORD-TRACE", from: "WO-A", to: "WO-B", kind: "handoff", text: "trace me please" });
await fleet.tickFleet();
const hops1 = traceHops("ORD-TRACE");
await fleet.tickFleet();
const hops2 = traceHops("ORD-TRACE");
check(
  "the watcher traces each new board line once",
  hops1.length === 1 && hops2.length === 1 && hops1[0].from === "Fleet" && hops1[0].what === "worker message" && hops1[0].detail.includes("WO-A -> WO-B") && hops1[0].detail.includes("[handoff]") && hops1[0].detail.includes("trace me please"),
  `after tick 1: ${hops1.length}, after tick 2: ${hops2.length}${hops1[0] ? ` (${hops1[0].detail})` : ""}`,
);

console.log("");
console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
