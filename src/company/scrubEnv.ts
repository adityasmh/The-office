/**
 * ENV-SCRUB (order R1-env-scrub, 2026-10-06): fleet terminals must not inherit secrets.
 *
 * The router opens every fleet terminal, so a worker's shell inherits the router's whole
 * environment - the GitHub token, the company auth token and the Slack tokens included. A
 * worker only needs to edit files, so anything else it can read is a leak waiting to be
 * printed into a log or a report.
 *
 * How it works: launcherScript() (src/company/fleet.ts) puts launcherScrubLines("powershell")
 * at the top of the generated run.ps1, before `jcode` starts. Each line removes ONE denied
 * variable from the child process. Only NAMES are ever emitted or logged, never values: the
 * caller cannot leak a value through this module because no function here returns one.
 *
 * Default OFF: FLEET_SCRUB_ENV=1 arms it. With the flag unset, launcherScrubLines() returns
 * nothing at all, so a generated launcher stays byte-for-byte what it was before this module.
 */

/** Arms the scrubber. Exactly "1" (the order's spelling); anything else keeps the old launcher. */
const SCRUB_FLAG = "FLEET_SCRUB_ENV";
/** Extra names to deny, comma separated (e.g. FLEET_SCRUB_EXTRA=ACME_TOKEN,FOO_SECRET). */
const SCRUB_EXTRA = "FLEET_SCRUB_EXTRA";

/** The credentials the router holds and a fleet worker never needs. */
const DEFAULT_DENY_NAMES = [
  "GITHUB_TOKEN",
  "COMPANY_AUTH_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_SIGNING_SECRET",
  "NOTIFY_WEBHOOK_URL",
];

/** Any other name ending like a credential is denied too (SLACK_SIGNING_SECRET already is). */
const DENY_SUFFIX_RE = /_(SECRET|PASSWORD)$/i;

/**
 * NEVER scrubbed, even if a name is listed in FLEET_SCRUB_EXTRA. These are provider
 * credentials, not router secrets: the `jcode` command line the launcher runs may need them
 * to start a terminal (DeepSeek is the cheap default provider, and opencode/Go, Anthropic/
 * Claude and LAYA keys authenticate the models a worker session can be told to run). Blanking
 * one of these would strand the terminal before `jcode` ever starts, so they are left alone
 * on purpose.
 */
const PROVIDER_KEY_EXACT = ["DEEPSEEK_API_KEY"];
const PROVIDER_KEY_PREFIXES = ["OPENCODE", "ANTHROPIC", "CLAUDE", "LAYA"];

function isProviderKey(name: string): boolean {
  const upper = name.toUpperCase();
  return PROVIDER_KEY_EXACT.includes(upper) || PROVIDER_KEY_PREFIXES.some((p) => upper.startsWith(p));
}

/** Only plain shell-style names are used: those are the ones a launcher can address safely. */
const PLAIN_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Armed only by FLEET_SCRUB_ENV=1; unset/anything else means the pre-change behaviour. */
function scrubArmed(): boolean {
  return (process.env[SCRUB_FLAG] ?? "") === "1";
}

/** The names FLEET_SCRUB_EXTRA adds, trimmed and with blanks dropped. */
function extraNames(): string[] {
  const raw = (process.env[SCRUB_EXTRA] ?? "").trim();
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * The deny-list policy: the default names, anything FLEET_SCRUB_EXTRA adds, and every name in
 * the current environment that ends in _SECRET or _PASSWORD. The provider keys above are
 * filtered out last, so nothing (not even an explicit FLEET_SCRUB_EXTRA entry) can put one of
 * them on the list. Names only; this function never reads or returns a value.
 */
export function scrubList(): string[] {
  const names = new Set<string>(DEFAULT_DENY_NAMES);
  for (const n of extraNames()) names.add(n);
  for (const n of Object.keys(process.env)) if (DENY_SUFFIX_RE.test(n)) names.add(n);

  const out: string[] = [];
  for (const n of names) {
    if (!PLAIN_NAME_RE.test(n)) continue; // cannot be addressed in the launcher's shell
    if (isProviderKey(n)) continue; // provider credential: must survive
    out.push(n);
  }
  return out.sort();
}

/** Single-quote a PowerShell string (double any quote inside), the fleet's own quoting rule. */
function psSingle(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * The PowerShell lines that blank every denied variable that EXISTS in this process, plus one
 * line naming what was cleared. Empty when the scrubber is off, when nothing is denied, or when
 * the shell asked for is not PowerShell (the fleet launcher is PowerShell only; no other shell
 * is guessed at).
 *
 * The lines are meant to go at the top of the generated launcher, before `jcode` starts. Only
 * NAMES appear in them: a name is never echoed with its value, so a console log of this script
 * cannot leak a secret.
 */
export function launcherScrubLines(shell = "powershell"): string[] {
  if (!scrubArmed()) return [];
  const sh = String(shell ?? "").trim().toLowerCase();
  if (sh !== "powershell" && sh !== "pwsh") return [];

  const hit = scrubList().filter((n) => process.env[n] !== undefined);
  if (hit.length === 0) return [];

  const lines = [
    "# env-scrub (R1-env-scrub): drop router secrets before jcode starts (names only, never values)",
    ...hit.map((n) => `Remove-Item -LiteralPath ${psSingle(`Env:${n}`)} -ErrorAction SilentlyContinue`),
    `Write-Host "env-scrub: cleared ${hit.length} variable name(s): ${hit.join(", ")}"`,
  ];
  return lines;
}
