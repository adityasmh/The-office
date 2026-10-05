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
