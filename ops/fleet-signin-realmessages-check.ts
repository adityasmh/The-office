/**
 * ops/fleet-signin-realmessages-check.ts — validate the predicate against the REAL error strings.
 *
 * Built from the throw sites in src/claudeSubscription.ts (8 of them) plus the `claude -p` failure
 * JSON shapes, rather than strings I invented. The question: does the predicate recognise EVERY
 * way "Claude is not signed in" can present, and stay silent for the ways it is NOT?
 */
import { mentionsClaudeSignInExpired, CLAUDE_SIGNIN_EXPIRED_MESSAGE } from "../src/company/claudeSignIn.js";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
};

// Exactly the messages the code can build, with plausible interpolations.
const REAL: Array<{ msg: string; signIn: boolean; why: string }> = [
  // 1. credentials missing entirely
  { msg: "Claude credentials not found at C:\\Users\\u\\.claude\\.credentials.json. Run: claude login", signIn: true, why: "credentials file absent" },
  // 2. the refresh endpoint rejected the refresh token (expired session)
  { msg: 'Claude OAuth refresh 400: {"error":"invalid_grant","error_description":"Refresh token not found or invalid"}', signIn: true, why: "refresh token dead" },
  { msg: "Claude OAuth refresh 401: unauthorized", signIn: true, why: "refresh rejected" },
  // 3. no oauth block
  { msg: "No claudeAiOauth block in credentials. Re-run `claude login`.", signIn: true, why: "no oauth block" },
  // 4. the CLI's own unauthenticated shape (what the fleet actually saw)
  { msg: "claude -p error: Failed to authenticate: OAuth session expired and could not be refreshed", signIn: true, why: "the measured production error" },
  // 6. the direct OAuth 401/403 path
  { msg: `Claude subscription rejected (401). Re-run 'claude login'. Body: {"type":"error","error":{"type":"authentication_error"}}`, signIn: true, why: "401 on messages" },
  { msg: "Claude subscription rejected (403). Re-run 'claude login'. Body: forbidden", signIn: true, why: "403 on messages" },
  // a raw error body that mentions the missing oauth scope/token
  { msg: 'Claude 400: {"error":{"type":"invalid_request_error","message":"OAuth token is invalid or expired; run claude login"}}', signIn: true, why: "body names claude login" },

  // NOT sign-in failures - these keep their own handling
  { msg: "Claude subscription rate-limited (429) via claude -p: usage limit reached", signIn: false, why: "429 must keep the limit path" },
  { msg: "Claude subscription rate-limited (429). Back off and retry, or fall back to the gateway model in CLAUDE_FALLBACK_MODEL.", signIn: false, why: "429 must keep the limit path" },
  { msg: "claude -p 500: internal server error", signIn: false, why: "transient upstream error" },
  { msg: "Claude 529: overloaded", signIn: false, why: "overload" },
  { msg: "claude -p timed out after 300s", signIn: false, why: "timeout" },
  { msg: "spawn C:\\x\\claude.exe ENOENT", signIn: false, why: "CLI not installed" },
  { msg: "claude -p exit 1: ", signIn: false, why: "unknown CLI failure" },
  { msg: "the planner produced no usable work orders", signIn: false, why: "the OLD stored error of the six live orders" },
  { msg: "review could not run: Claude is at its spend/rate limit and the deepseek-v4.1-flash / kimi-k2.7-code fallback did not answer", signIn: false, why: "the new review-unavailable text" },
  { msg: "no fallback model answered in 2 pass(es) (tried deepseek-v4.1-flash, kimi-k2.7-code): deepseek-v4.1-flash pass1: 14162 chars with no JSON", signIn: false, why: "the new fallback-exhausted text" },
  { msg: "GOAL: add a login form to the settings page", signIn: false, why: "the word login in an order" },
  { msg: "", signIn: false, why: "empty" },
];

for (const c of REAL) {
  const got = mentionsClaudeSignInExpired(c.msg);
  check(`${c.signIn ? "MATCHES " : "IGNORES "} (${c.why})`, got === c.signIn, got ? "matched" : "not matched");
}

// The exact stored error of the six live orders must NOT be turned into a sign-in prompt:
// they keep the honest retry/drop choice because their error says nothing about a sign-in.
const LIVE_ERROR = "the planner produced no usable work orders";
check("the six live orders' stored error stays a retry/drop item", !mentionsClaudeSignInExpired(LIVE_ERROR), LIVE_ERROR);

// The acceptance sentence is what the fleet writes.
check(
  "the acceptance sentence is the plain one",
  CLAUDE_SIGNIN_EXPIRED_MESSAGE === "Claude sign-in expired: the CEO must run claude /login in a terminal",
  JSON.stringify(CLAUDE_SIGNIN_EXPIRED_MESSAGE),
);

console.log(`\n[realmsgs] ${failures ? `${failures} FAILED` : "ALL CHECKS PASSED"} (${REAL.length} real messages)`);
process.exit(failures ? 1 : 0);
