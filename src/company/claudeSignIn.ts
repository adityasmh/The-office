import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * One place for "Claude is not signed in" - the plain sentence the CEO is shown, and the
 * predicate that recognises the failure.
 *
 * WHY THIS MODULE EXISTS: the same fact has to be agreed on by three callers that must not
 * import each other - the fleet (which raises the failure), the run-manager cards (a FAILED
 * run has to keep showing the reason), and the briefing (which turns it into a prompt). A
 * leaf module with no imports cannot create a cycle between them.
 *
 * MEASURED (2026-09-30): a planning run whose Claude OAuth session had expired fell back to
 * the gateway model, got nothing usable, and the CEO was left with the generic
 * "Retry this order or drop it?" prompt - which hid the one thing that actually fixes it.
 */

/** The single plain sentence the CEO sees. No jargon, no paths, no secrets. */
export const CLAUDE_SIGNIN_EXPIRED_MESSAGE =
  "Claude sign-in expired: the CEO must run claude /login in a terminal";

/**
 * The recognised failure shapes (from src/claudeSubscription.ts):
 *  - `claude -p` (CLI backend) returns is_error with
 *    "Failed to authenticate: OAuth session expired and could not be refreshed";
 *  - the direct OAuth backend throws on 401/403 ("Re-run 'claude login'");
 *  - the REFRESH itself fails (an expired refresh token): `Claude OAuth refresh 400:
 *    {"error":"invalid_grant"}`, or a 401 from the token endpoint;
 *  - credentials are missing entirely, or carry no claudeAiOauth block.
 *
 * Deliberately NOT matched: a spend/rate limit (429), a timeout, an ENOENT/spawn failure, or
 * any text that merely contains the word "login". Those keep their own handling - a 429 still
 * gets the "raise the limit / use Kimi" path, and an outage still gets the bounded retry.
 */
const SIGN_IN_PATTERNS: RegExp[] = [
  /failed to authenticate/i,
  /oauth session expired/i,
  /could not be refreshed/i,
  /claude oauth refresh/i,
  /invalid_grant/i,
  /credentials not found/i,
  /no claudeaioauth block/i,
  /claude \/?login/i,
];

/** True when `text` says the Claude sign-in is gone (as opposed to a rate limit or an outage). */
export function mentionsClaudeSignInExpired(text: unknown): boolean {
  const s = String(text ?? "");
  if (!s) return false;
  return SIGN_IN_PATTERNS.some((re) => re.test(s));
}

// ── credential-file health check (FLEET-LOGIN guard) ────────────────────

/** Standard Claude Code credential path, env-overridable for tests. */
export function claudeCredentialPath(): string {
  return (
    process.env.CLAUDE_CREDENTIALS_PATH ??
    path.join(os.homedir(), ".claude", ".credentials.json")
  );
}

type StoredCreds = {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
  };
};

/** How long before expiry the guard starts warning (default: 1 hour). */
export function claudeSignInExpiryWarningMs(): number {
  const raw = Number(process.env.CLAUDE_SIGNIN_EXPIRY_WARNING_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 60 * 60 * 1000;
}

export type ClaudeSignInStatus =
  | { ok: true; expiresAt: number; expiresInMs: number; aboutToExpire: boolean; probe?: string }
  | { ok: false; reason: string };

/**
 * Read the on-disk Claude credential file and report its health.
 * Does not make any network call; safe to run at startup and before every plan.
 */
export function claudeSignInStatus(): ClaudeSignInStatus {
  const credPath = claudeCredentialPath();
  if (!fs.existsSync(credPath)) {
    return { ok: false, reason: `Claude credentials not found at ${credPath}. Run: claude login` };
  }
  let creds: StoredCreds;
  try {
    creds = JSON.parse(fs.readFileSync(credPath, "utf8")) as StoredCreds;
  } catch (e) {
    return { ok: false, reason: `Claude credentials file at ${credPath} is unreadable or invalid JSON: ${String(e).slice(0, 120)}` };
  }
  const oauth = creds.claudeAiOauth;
  if (!oauth) {
    return { ok: false, reason: "No claudeAiOauth block in credentials. Re-run `claude login`." };
  }
  if (!oauth.accessToken || !oauth.refreshToken) {
    return { ok: false, reason: "Claude credentials are missing access or refresh token. Re-run `claude login`." };
  }
  const expiresAt = typeof oauth.expiresAt === "number" ? oauth.expiresAt : 0;
  const expiresInMs = expiresAt ? expiresAt - Date.now() : Number.NEGATIVE_INFINITY;
  const warningMs = claudeSignInExpiryWarningMs();
  const aboutToExpire = expiresAt > 0 && expiresInMs <= warningMs;
  return { ok: true, expiresAt, expiresInMs, aboutToExpire };
}

/**
 * Credential-file-only check used by the sync startup guard.
 *
 * Returns ok:false for credentials that are missing, unreadable, or structurally unusable.
 * Returns ok:false for an expired access token ONLY when there is no refresh token to renew it.
 *
 * Does NOT block on a near-expiry access token: the Claude CLI refreshes short-lived tokens
 * on its own, so a refreshable session is healthy. Use probeClaudeSignIn() before spending a
 * planner call to confirm the CLI can actually refresh and run.
 */
export function claudeSignInCheck(): ClaudeSignInStatus {
  const status = claudeSignInStatus();
  if (!status.ok) return status;

  // A token within the warning window is a warning, not a hard failure. The async probe will
  // confirm whether the CLI can still refresh and answer.
  if (status.aboutToExpire) {
    const mins = Math.max(0, Math.round(status.expiresInMs / 60000));
    return {
      ok: true,
      expiresAt: status.expiresAt,
      expiresInMs: status.expiresInMs,
      aboutToExpire: true,
      probe: `Claude sign-in expires in ${mins} minute${mins === 1 ? "" : "s"} (${new Date(status.expiresAt).toISOString()}). A real probe will confirm it still works.`,
    };
  }

  return status;
}

// ── real CLI probe ──────────────────────────────────────────────────────

const CLAUDE_BIN =
  process.env.CLAUDE_BIN ??
  path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");

const PROBE_MODEL = process.env.CLAUDE_PROBE_MODEL ?? "claude-sonnet-5-5";
const PROBE_TIMEOUT_MS = Number(process.env.CLAUDE_PROBE_TIMEOUT_MS ?? "30000");
const PROBE_PROMPT = process.env.CLAUDE_PROBE_PROMPT ?? "Reply with the single word login-ok.";

/**
 * Confirm the Claude CLI login with a cheap real `claude -p` call.
 *
 * Behaviour:
 *  - If the credential file is missing/unreadable/has no oauth block/has no tokens,
 *    returns ok:false immediately without spawning.
 *  - If the access token is expired and there is no refresh token, returns ok:false.
 *  - Otherwise spawns the same `claude -p` command the planner uses, with a one-line prompt.
 *  - If the CLI reports a sign-in failure (is_error + mentionsClaudeSignInExpired),
 *    returns ok:false with the plain CEO sentence.
 *  - If the CLI answers successfully, returns ok:true.
 *  - If the CLI fails for a non-sign-in reason (rate limit, timeout, spawn ENOENT, etc.),
 *    returns ok:true with a warning note: the guard's job is to detect invalid logins, not
 *    to block every transient CLI problem.
 */
export async function probeClaudeSignIn(): Promise<ClaudeSignInStatus> {
  const status = claudeSignInCheck();
  if (!status.ok) return status;

  // If the file check says the access token is expired (but a refresh token exists), the
  // probe itself will tell us whether the CLI can refresh. If the access token is merely near
  // expiry, the probe confirms the session is still usable.
  const expiresAt = status.expiresAt;
  const expiresInMs = status.expiresInMs;
  const aboutToExpire = status.aboutToExpire;

  const bin = CLAUDE_BIN;
  if (!fs.existsSync(bin)) {
    return {
      ok: true,
      expiresAt,
      expiresInMs,
      aboutToExpire,
      probe: `Claude CLI not found at ${bin}; cannot confirm login, but credentials look present.`,
    };
  }

  const args = [
    "-p",
    "--model", PROBE_MODEL,
    "--output-format", "json",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--tools", "Read",
  ];
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const cwd = process.cwd();

  let stdout = "";
  let stderr = "";
  try {
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* gone */ }
        reject(new Error(`claude -p probe timed out after ${PROBE_TIMEOUT_MS}ms`));
      }, PROBE_TIMEOUT_MS);
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (stdout.trim()) resolve(stdout);
        else reject(new Error(`claude -p probe exit ${code}: ${stderr.slice(-400)}`));
      });
      child.stdin.end(PROBE_PROMPT);
    });

    const lastLine = out.trim().split(/\r?\n/).pop() ?? "{}";
    const j = JSON.parse(lastLine) as {
      result?: string;
      is_error?: boolean;
      api_error_status?: number | null;
      total_cost_usd?: number;
    };

    if (j.is_error || j.api_error_status) {
      const resultText = String(j.result ?? "");
      if (mentionsClaudeSignInExpired(resultText)) {
        return { ok: false, reason: `${CLAUDE_SIGNIN_EXPIRED_MESSAGE} (probe: ${resultText.slice(0, 160)})` };
      }
      return {
        ok: true,
        expiresAt,
        expiresInMs,
        aboutToExpire,
        probe: `claude -p probe failed with a non-sign-in error (${j.api_error_status ?? "error"}: ${resultText.slice(0, 160)}). Login may still be valid; letting the planner handle it.`,
      };
    }

    return {
      ok: true,
      expiresAt,
      expiresInMs,
      aboutToExpire,
      probe: aboutToExpire
        ? `Claude sign-in expires in ${Math.max(0, Math.round(expiresInMs / 60000))} minutes, but the CLI probe succeeded.`
        : `Claude CLI probe succeeded (cost $${j.total_cost_usd ?? "unknown"}).`,
    };
  } catch (e) {
    const why = String(e).slice(0, 200);
    if (mentionsClaudeSignInExpired(why)) {
      return { ok: false, reason: `${CLAUDE_SIGNIN_EXPIRED_MESSAGE} (probe: ${why})` };
    }
    return {
      ok: true,
      expiresAt,
      expiresInMs,
      aboutToExpire,
      probe: `claude -p probe could not run (${why}); assuming login is present and letting the planner report any real failure.`,
    };
  }
}
