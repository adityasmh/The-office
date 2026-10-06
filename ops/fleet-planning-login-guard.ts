/**
 * ops/fleet-planning-login-guard.ts — probe the FLEET-LOGIN preflight guard.
 *
 * The guard lives in src/company/claudeSignIn.ts and is wired into
 * src/company/fleet.ts at startup (startFleetWatcher) and before every plan
 * (planOrder). This probe exercises BOTH the credential-file check and the real
 * `claude -p` probe, including a moment where the real credential file is moved
 * aside to prove the probe fails loudly with a broken credential.
 *
 * Run:
 *   npx tsx ops/fleet-planning-login-guard.ts
 *
 * Expected output when the real credential is healthy:
 *   PASS  real credential probe passes
 *   PASS  missing credential is rejected (sync)
 *   PASS  no claudeAiOauth block rejected (sync)
 *   PASS  missing refresh token rejected (sync)
 *   PASS  broken real credential (file moved aside) makes probe fail
 *   PASS  restored real credential probe passes
 *   [guard] ALL CHECKS PASSED
 *
 * On a machine with no real credential, the first and last checks fail and the
 * probe exits non-zero.
 */
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeSignInCheck, probeClaudeSignIn } from "../src/company/claudeSignIn.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-login-guard-"));

function writeCreds(oauth: { accessToken?: string; refreshToken?: string; expiresAt?: number }) {
  fs.writeFileSync(
    process.env.CLAUDE_CREDENTIALS_PATH!,
    JSON.stringify({ claudeAiOauth: oauth }, null, 2),
  );
}

function removeCreds() {
  try {
    fs.rmSync(process.env.CLAUDE_CREDENTIALS_PATH!, { force: true });
  } catch { /* ignore */ }
}

// 1. Real credential (if present) should pass the real probe.
{
  delete process.env.CLAUDE_CREDENTIALS_PATH;
  const realPath = path.join(os.homedir(), ".claude", ".credentials.json");
  if (fs.existsSync(realPath)) {
    const r = await probeClaudeSignIn();
    check("real credential probe passes", r.ok, r.ok ? (r.probe ?? "") : r.reason);
  } else {
    check("real credential probe passes", false, `no credential at ${realPath}`);
  }
}

// Point subsequent file-only checks at the temp path.
process.env.CLAUDE_CREDENTIALS_PATH = path.join(tmp, ".credentials.json");

// 2. Missing credential file.
{
  removeCreds();
  const r = claudeSignInCheck();
  check("missing credential rejected (sync)", !r.ok, r.ok ? "expected failure" : r.reason);
}

// 3. Credential file exists but has no claudeAiOauth block.
{
  fs.writeFileSync(process.env.CLAUDE_CREDENTIALS_PATH!, JSON.stringify({ other: true }));
  const r = claudeSignInCheck();
  check("no claudeAiOauth block rejected (sync)", !r.ok, r.ok ? "expected failure" : r.reason);
}

// 4. Missing refresh token.
{
  writeCreds({ accessToken: "a", expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
  const r = claudeSignInCheck();
  check("missing refresh token rejected (sync)", !r.ok, r.ok ? "expected failure" : r.reason);
}

// 5. Temporarily move the REAL credential aside and prove the probe fails loudly.
{
  const realPath = path.join(os.homedir(), ".claude", ".credentials.json");
  const bakPath = `${realPath}.guard-test-bak`;
  let moved = false;
  try {
    if (fs.existsSync(realPath)) {
      fs.copyFileSync(realPath, bakPath);
      fs.rmSync(realPath, { force: true });
      moved = true;
    }
    delete process.env.CLAUDE_CREDENTIALS_PATH;
    const r = await probeClaudeSignIn();
    check(
      "broken real credential (file moved aside) makes probe fail",
      !r.ok,
      r.ok ? "expected failure when credential is missing" : r.reason,
    );
  } finally {
    if (moved) {
      fs.copyFileSync(bakPath, realPath);
      fs.rmSync(bakPath, { force: true });
    }
  }
}

// 6. Restored real credential should pass the probe again.
{
  delete process.env.CLAUDE_CREDENTIALS_PATH;
  const realPath = path.join(os.homedir(), ".claude", ".credentials.json");
  if (fs.existsSync(realPath)) {
    const r = await probeClaudeSignIn();
    check("restored real credential probe passes", r.ok, r.ok ? (r.probe ?? "") : r.reason);
  } else {
    check("restored real credential probe passes", false, `credential did not return to ${realPath}`);
  }
}

removeCreds();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n[guard] ${failures ? `${failures} FAILED` : "ALL CHECKS PASSED"}`);
process.exit(failures ? 1 : 0);
