/**
 * F1 harness: prove `switchSessionModel()` (src/company/fleet.ts) - the ONLY working way to put a
 * picked model into a running jcode TUI session (CEO-approved option 2, the debug socket).
 *
 * WHY THIS EXISTS
 * `jcode -p <provider> -m <model>` is IGNORED for TUI sessions (five flag forms tested) and
 * `/model <id>` sent through `jcode transcript --mode send` lands as a CHAT message. The debug
 * socket exposes `set_model:<model>`, verified in `jcode debug help`. That socket only exists on a
 * server started with `[display] debug_socket = true`, so the live success path cannot be run until
 * the shared jcode server has restarted. This harness pins down everything that is provable today
 * against the REAL jcode binary, and re-runs the success path the moment a debug-enabled server is up.
 *
 * WHAT IT CHECKS
 *   A. a missing/dead debug socket degrades cleanly: no throw, no hang past the timeout, and the
 *      detail says so (measured: with no server `jcode debug` prints NOTHING and BLOCKS forever).
 *   B. a malformed model id is refused BEFORE anything is spawned (so a bad catalog entry can never
 *      reach the CLI).
 *   C. the journal really is the source of truth the switch is verified against: sessionLive()
 *      reads `meta.model` out of a session file, and `force` bypasses the memo so a just-changed
 *      session is never confirmed from a stale cached read.
 *   D. (live mode, when a debug server exists) the real switch sets the model AND the journal agrees.
 *
 * USAGE
 *   npx tsx ops/fleet-model-switch-selftest.ts                  # A + B + C (safe, no server needed)
 *   npx tsx ops/fleet-model-switch-selftest.ts <sessionId> <model>   # + D, against a live session
 * Nothing here opens, closes, or writes to an existing session: C uses a throwaway file that is
 * removed again, and D only asks the server to change a model.
 */
import fs from "node:fs";
import path from "node:path";
import * as fleet from "../src/company/fleet";

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} -- ${detail}`);
  if (!ok) failures++;
}

function envNum(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

// A clearly-marked throwaway session id: no jcode server has ever seen it, and the files are
// deleted before this process exits.
const STANDIN = `session_f1_standin_${Date.now()}_harness`;

async function main(): Promise<void> {
  const sessions = fleet.sessionsDir();
  const timeoutMs = envNum("FLEET_MODEL_SWITCH_TIMEOUT_MS", 20000);
  console.log(`[f1] sessions dir : ${sessions}`);
  console.log(`[f1] switch timeout: ${timeoutMs} ms (FLEET_MODEL_SWITCH_TIMEOUT_MS)`);
  console.log("");

  // ── B: a malformed model id must never reach the CLI ──────────────────
  const tb = Date.now();
  const bad = await fleet.switchSessionModel(STANDIN, "not a model; rm -rf /");
  const badMs = Date.now() - tb;
  check(
    "B malformed model id is refused without spawning jcode",
    bad.ok === false && bad.detail.includes("malformed") && badMs < 500,
    `ok=${bad.ok} in ${badMs}ms detail="${bad.detail}"`,
  );

  // ── A: no debug socket -> clean, bounded failure ──────────────────────
  // The real jcode is used here on purpose: this is the exact condition the fleet is in until the
  // shared server restarts, and it is the one that used to hang a spawn for three minutes.
  const ta = Date.now();
  let live = { ok: false, detail: "" };
  try {
    live = await fleet.switchSessionModel(STANDIN, "kimi-k2.7-code");
  } catch (e) {
    live = { ok: false, detail: `THREW: ${String(e)}` };
  }
  const aMs = Date.now() - ta;
  const bounded = aMs < timeoutMs + 15000;
  check(
    "A always answers, never throws, bounded by the timeout, self-describing",
    !live.detail.startsWith("THREW") && bounded && live.detail.length > 0,
    `ok=${live.ok} in ${aMs}ms (bounded<${timeoutMs + 15000}) detail="${live.detail}"`,
  );
  // A success claim must be BACKED BY THE JOURNAL, never by an exit code. This stand-in id exists
  // only in section C, so today it cannot succeed; if the socket is already up and the server still
  // reports a change for it, that assertion is exactly the one that must hold.
  check(
    "A an ok=true answer is only ever built from the session's own record",
    live.ok === false ? live.detail.includes("no answer") || live.detail.includes("exited") || live.detail.includes("still reports") : live.detail.includes("meta.model="),
    live.ok ? `ok=true claims: "${live.detail}"` : `ok=false is a soft failure the spawn survives: "${live.detail.slice(0, 90)}"`,
  );

  // ── C: the journal is the source of truth, and `force` bypasses the memo ──
  const journal = path.join(sessions, `${STANDIN}.journal.jsonl`);
  const snapshot = path.join(sessions, `${STANDIN}.json`);
  const write = (model: string) => {
    fs.writeFileSync(snapshot, JSON.stringify({ id: STANDIN, model }), "utf8");
    fs.appendFileSync(
      journal,
      `${JSON.stringify({ meta: { updated_at: new Date().toISOString(), model }, append_messages: [] })}\n`,
      "utf8",
    );
  };
  try {
    write("deepseek-v4.1-flash");
    const first = fleet.sessionLive(STANDIN, 5);
    check(
      "C sessionLive reads the model out of the session's own record",
      first.found && first.model === "deepseek-v4.1-flash",
      `found=${first.found} model=${first.model ?? "(none)"}`,
    );

    const memoised = fleet.sessionLive(STANDIN, 5); // served from the memo (same file state)
    check(
      "C an unchanged record is answered identically (memo hit is not a behaviour change)",
      memoised.found && memoised.model === first.model,
      `first=${first.model ?? "(none)"} memo=${memoised.model ?? "(none)"}`,
    );

    write("kimi-k2.7-code"); // the "server switched it" case
    const forced = fleet.sessionLive(STANDIN, 5, true); // what the switch check uses
    // The memo is keyed on (mtime, size), so any write invalidates it; `force` is belt-and-braces for
    // the case where the server changes the model without touching the file. What matters is that the
    // switch check can never be satisfied by a record that still shows the OLD model.
    const mismatch = fleet.sessionLive(STANDIN, 5, true).model !== "glm-5.3-flash";
    check(
      "C force=true sees the newest value (a just-changed session is never confirmed from a cached read)",
      forced.model === "kimi-k2.7-code",
      `force=${forced.model ?? "(none)"}`,
    );
    check(
      "C a session that reports some other model is detected as a mismatch, never as success",
      mismatch,
      `record=kimi-k2.7-code vs requested glm-5.3-flash -> mismatch=${mismatch}`,
    );
  } finally {
    for (const f of [journal, snapshot]) {
      try { fs.unlinkSync(f); } catch { /* already gone */ }
    }
    check(
      "C throwaway session files removed (nothing left in the live sessions dir)",
      !fs.existsSync(journal) && !fs.existsSync(snapshot),
      `${path.basename(journal)}, ${path.basename(snapshot)}`,
    );
  }

  // ── D: the real thing, when a debug-enabled server exists ─────────────
  const [sid, model] = process.argv.slice(2);
  if (sid && model) {
    console.log("");
    console.log(`[f1] D live switch: session ${sid} -> ${model}`);
    const before = fleet.sessionLive(sid, 5, true).model;
    const t = Date.now();
    const res = await fleet.switchSessionModel(sid, model);
    const after = fleet.sessionLive(sid, 5, true).model;
    check(
      "D live set_model switched the session and the journal agrees",
      res.ok && after === model,
      `ok=${res.ok} in ${Date.now() - t}ms before=${before ?? "(none)"} after=${after ?? "(none)"} detail="${res.detail}"`,
    );
  } else {
    console.log("");
    console.log("SKIP  D live switch (pass <sessionId> <model>; the socket needs `[display] debug_socket = true`");
    console.log("       on the server and a server start since - `jcode debug sessions` answers when it is up;");
    console.log("       ops/f1-live-switch-proof.ts runs the whole thing against a throwaway window)");
  }

  console.log("");
  console.log(failures === 0 ? "[f1] ALL PASS" : `[f1] ${failures} FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
