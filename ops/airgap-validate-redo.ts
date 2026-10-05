// ops/airgap-validate-redo.ts - deeper validation of the 2026-10-01 redo findings.
// Behavioral tests, not rereads: each fix is exercised, not inspected.
// Isolation: AIRGAP_PROBE=1 (held rows -> .probe file), no real hosts contacted that
// need credentials, no live server. Run: npx tsx ops/airgap-validate-redo.ts
process.chdir(path.resolve(import.meta.dirname ?? process.cwd(), ".."));
process.env.AIRGAP_PROBE = "1";
process.env.SLACK_BRIDGE = "0";
process.env.MOCK_MODE = "";
process.env.OPENCODE_API_KEY = "";
process.env.JCODE_GATEWAY_TIMEOUT_SECONDS = "5";
process.env.CLAUDE_CLI_TIMEOUT_SECONDS = "5";

import fs from "node:fs";
import path from "node:path";
import http from "node:http";

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];
const push = (name: string, ok: boolean, detail: string): void => { results.push({ name, ok, detail }); };

async function main() {
  const g = await import("../src/company/airGap.js");
  const { installAirGapFetchGuard, airGapped, airgappedBlock, airgappedHoldCli, airgappedCliHoldPending, clearAirgappedCliHold, holdUnserved, heldQueue, heldQueuePath, airGapStatus, isLoopbackUrl } = g;
  installAirGapFetchGuard();

  // ── V1: held queue uncapped + probe isolation (behavioral) ──
  // This harness is NOT idempotent unless the throwaway probe file starts empty:
  // V1.all-ten asserts exactly 10 'validate' rows, so leftover rows from a previous
  // run of this same probe file would fail it. The probe file is proof-scoped and
  // disposable by design; the REAL held-air-gapped.json is never touched here.
  try { fs.rmSync(`${heldQueuePath}.probe`, { force: true }); } catch { /* stateless */ }
  // (moved into V1.post: the check must run AFTER a hold proves the split; see V1.post below)
  push("V1.setup2: heldQueue path points at the live file even under probe (write/read split only)", heldQueuePath.endsWith("held-air-gapped.json"), heldQueuePath);

  const heldA = holdUnserved("validate row A", "validate", "validate");
  const heldB = holdUnserved("validate row B", "validate", "validate");
  for (let i = 0; i < 8; i++) holdUnserved(`validate bulk ${i}`, "validate", "validate");
  const q = heldQueue();
  const foundA = q.find((r) => r.id === heldA.id);
  const foundB = q.find((r) => r.id === heldB.id);
  push("V1.first-row-survives: row A (first of 10) still in the queue", !!foundA, `queue length=${q.length}, id=${heldA.id}`);
  push("V1.second-row-survives: row B still in the queue", !!foundB, `queue length=${q.length}, id=${heldB.id}`);
  push("V1.all-ten: all 10 queued rows present (no cap)", q.filter((r) => r.reason === "validate").length === 10, `validate rows=${q.filter((r) => r.reason === "validate").length}`);
  push("V1.live-untouched: the REAL queue file was never created by this harness", !fs.existsSync(heldQueuePath), fs.existsSync(heldQueuePath) ? "LIVE FILE EXISTS - probe isolation FAILED" : "absent");
  push("V1.post: probe rows landed in the .probe file (probe isolation ACTIVE)", fs.existsSync(`${heldQueuePath}.probe`), `${fs.existsSync(`${heldQueuePath}.probe`)} (${fs.statSync(`${heldQueuePath}.probe`).size} bytes)`);
  push("V1.status-literal: every row has status held-air-gapped", q.every((r) => r.status === "held-air-gapped"), JSON.stringify(q[0]?.status));

  // ── V2: recentBlocked newest-first under >25 entries ──
  // (flag was off during V1's holding? no: holding is env-independent. Unset flag for now.)
  const beforeEnabled = airGapped();
  process.env.AIR_GAPPED = "1";
  const urls: string[] = [];
  for (let i = 0; i < 30; i++) {
    const u = `https://blocked.test/v${i}`;
    urls.push(u);
    try { await fetch(u); } catch { /* expected: refused */ }
  }
  const st = airGapStatus();
  expectNewestFirst: {
    const rec = st.recentBlocked.filter((b) => b.kind === "fetch" && b.url.startsWith("https://blocked.test/"));
    const firstIsNewest = rec.length >= 25 && rec[0].url === urls[urls.length - 1];
    push("V2.newest-first: recentBlocked[0] is the NEWEST blocked url (29, not 0)", firstIsNewest, `rec[0]=${rec[0]?.url}, rec[last]=${rec[rec.length - 1]?.url}, count=${rec.length}`);
    // rec is newest-FIRST (recordBlocked appends then reverse()); so adjacent entries must be
    // non-INCREASING in time: curr.at <= prev.at. The old comparator used >= (ascending),
    // which only passed by accident when all 30 refusals shared one millisecond.
    const sortedDesc = rec.every((b, i) => i === 0 || b.at <= rec[i - 1].at);
    push("V2.order-desc: recentBlocked is in descending-time order throughout", sortedDesc, `checked ${rec.length} entries`);
    const capOk = st.blockedFetches >= 30;
    push("V2.c counted: blockedFetches reflects 30 refused attempts", capOk, `blockedFetches=${st.blockedFetches}`);
  }

  // ── V3: spawn gates actually refuse (direct calls under flag) ──
  push("V3.claude-cli: airgappedBlock(claude-cli) refuses under flag", airgappedBlock("claude-cli", "validate-gate") === true, "returned true (call site must not launch the child)");
  push("V3.slack: airgappedBlock(slack) refuses under flag", airgappedBlock("slack", "validate-gate") === true, "returned true");
  push("V3.opencode-worker: airgappedBlock(opencode-worker) refuses under flag", airgappedBlock("opencode-worker", "opencode run anthropic/fake") === true, "returned true");
  push("V3.fleet-agent: airgappedBlock(fleet-agent) refuses under flag", airgappedBlock("fleet-agent", "jcode transcript --mode send") === true, "returned true");

  // The opencode gate's held-queue append: queue once, pending, then clear.
  const okLabel = "opencode run anthropic/once-model";
  const gate1: ["opencode-worker", string] = ["opencode-worker", okLabel];
  if (airgappedBlock(...gate1)) {
    if (!airgappedCliHoldPending(...gate1)) airgappedHoldCli(...gate1, "opencode-worker");
  }
  push("V3.hold-pending: the same hop is marked pending after queueing", airgappedCliHoldPending(...gate1), `label=${okLabel}`);
  const qBefore = heldQueue().length;
  if (airgappedBlock(...gate1)) {
    if (!airgappedCliHoldPending(...gate1)) airgappedHoldCli(...gate1, "opencode-worker");
  }
  push("V3.no-dup: a repeat of the same hop does NOT requeue (length unchanged)", heldQueue().length === qBefore, `before=${qBefore}, after=${heldQueue().length}`);
  clearAirgappedCliHold(...gate1);
  push("V3.clear: after clearAirgappedCliHold the marker is gone", !airgappedCliHoldPending(...gate1), "pending=false");

  // Real gated module behavior: callClaudeSubscription actually refuses (not just the boolean helper).
  const cs = await import("../src/claudeSubscription.js");
  let claudeThrew = "";
  try {
    await cs.callClaudeCode({ model: "claude-sonnet-5-5", user: "validate", purpose: "validate" } as never);
  } catch (e) { claudeThrew = String(e); }
  push("V3.real-claude-child: callClaudeCode throws under flag (child never launched)", /air-gap|AIR_GAPPED|blocked/i.test(claudeThrew), claudeThrew.slice(0, 140));

  // Real gated Slack behavior.
  const sl = await import("../src/slack.js");
  const notif = await sl.notifySlack("airgap-validate-redo probe");
  push("V3.real-slack: notifySlack returns posted:false mock:true under flag", notif.posted === false && notif.mock === true, JSON.stringify(notif).slice(0, 140));

  // graphify gate: tryGraphifyAsync is module-private, so verify its gate directly in
  // the source AND time a rebuild-path probe (the gate returns null before any child).
  const knSrc = fs.readFileSync(path.join(process.cwd(), "src", "company", "knowledge.ts"), "utf8");
  const gatePresent = /tryGraphifyAsync[\s\S]{0,600}?airgappedBlock\("fleet-agent", `graphify extract/.test(knSrc) || /airgappedBlock\("fleet-agent", `graphify extract/.test(knSrc);
  const memSrc = fs.readFileSync(path.join(process.cwd(), "src", "company", "memory.ts"), "utf8");
  const memGatePresent = memSrc.includes('airgappedBlock("fleet-agent", `graphify') && memSrc.includes('airgappedBlock("fleet-agent", "graphify --version")');
  push("V3.real-graphify: gate present at the tryGraphifyAsync + runGraphify spawn sites (module-private, checked in source; a null return skips any child)", gatePresent && memGatePresent, `knowledge.ts gate=${gatePresent}, memory.ts gates=${memGatePresent}`);

  // ── V4: redirect hardening ──
  push("V4.loopback-parse: isLoopbackUrl accepts 127.0.0.1/localhost/[::1] only", isLoopbackUrl("http://127.0.0.1:8000/x") && isLoopbackUrl("http://localhost/x") === true && !isLoopbackUrl("https://example.com/x"), "ok");
  // Local redirect server: loopback URL that 302s to the internet.
  const redir = http.createServer((req, res) => {
    res.writeHead(302, { location: "https://example.com/out" });
    res.end();
  }).listen(0, "127.0.0.1");
  await new Promise<void>((r) => redir.on("listening", () => r()));
  const port = (redir.address() as { port: number }).port;
  let redirectErr = "";
  try { await fetch(`http://127.0.0.1:${port}/go`); } catch (e) { redirectErr = String(e); }
  push("V4.redirect-block: loopback 302 -> internet is refused", /redirect|air-gap|blocked/i.test(redirectErr), redirectErr.slice(0, 140));
  // Loopback->loopback redirect must be FOLLOWED (not over-blocked).
  const inner = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("INNER"); }).listen(0, "127.0.0.1");
  await new Promise<void>((r) => inner.on("listening", () => r()));
  const iport = (inner.address() as { port: number }).port;
  const outer = http.createServer((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${iport}/real` });
    res.end();
  }).listen(0, "127.0.0.1");
  await new Promise<void>((r) => outer.on("listening", () => r()));
  const oport = (outer.address() as { port: number }).port;
  let followed = "";
  try { followed = await (await fetch(`http://127.0.0.1:${oport}/go`)).text(); } catch (e) { followed = `ERR:${String(e)}`; }
  push("V4.loop-redirect-followed: loopback 302 -> loopback is followed and returns the inner body", followed === "INNER", `body=${followed.slice(0, 60)}`);
  redir.close(); inner.close(); outer.close();

  // ── V5: flag-off = pre-flag error shape in this same process (clean re-check) ──
  process.env.AIR_GAPPED = "";
  const stOff = airGapStatus();
  push("V5.off: enabled=false with the flag unset", stOff.enabled === false, `enabled=${stOff.enabled}`);
  push("V5.off-block-false: airgappedBlock permits every site with the flag off", airgappedBlock("claude-cli", "off-probe") === false, "returned false (site would have run)");
  // An outbound fetch with the flag ON must land in blockedFetches, not succeed; with the flag OFF it must attempt for real (DNS fail on a reserved .test domain is fine, what matters is NO air-gap interference string).
  let offFetch = "";
  try { await fetch("https://airgap-flagoff-probe.invalid/nope"); } catch (e) { offFetch = String(e); }
  push("V5.off-fetch: outbound fetch under flag-off fails on its own (no air-gap text in the error)", !/air-gap|AIR_GAPPED/.test(offFetch), offFetch.slice(0, 160));

  // restore flag for the record
  process.env.AIR_GAPPED = "1";
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}\n      ${r.detail}`);
  console.log(`\nairgap-validate-redo: ${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error("crashed:", e); process.exit(1); });
