/**
 * ops/slack-test.ts — the Slack mirror smoke test.
 *
 *   npx tsx ops/slack-test.ts [--channel ID] [--text "..."] [--persona NAME] [--selftest]
 *
 * Reports slackStatus() and sends exactly ONE test message through the real
 * src/slack.ts code path.
 *
 *  - No token (or no channel, or MOCK_MODE=1): prints the clearly labelled
 *    mock/console result and exits 0.
 *  - Configured: makes the real chat.postMessage call and prints the exact
 *    result (posted ts, or the precise Slack error). Exits 1 on failure so ops
 *    and CI can detect a broken mirror.
 *  - --selftest sends nothing; it asserts token redaction and the approve URL
 *    shapes locally.
 *
 * The token is NEVER printed, logged or included in the output. Only status
 * flags and the channel id are shown.
 */
import "dotenv/config";

type Args = { channel?: string; text?: string; persona?: string; selftest: boolean; help: boolean };

const USAGE = [
  "Usage: npx tsx ops/slack-test.ts [options]",
  "",
  "  --channel <ID>   post to this channel for this run only (overrides SLACK_CHANNEL_ID)",
  '  --text "..."     the test message body (default: an obvious self-identifying test line)',
  "  --persona NAME   persona to post as (default SONNET_LEAD); e.g. OPUS_MANAGER, LAYA_QA",
  "  --selftest       check token redaction + approve URL shapes only; sends nothing",
  "  --help           show this help",
].join("\n");

function parseArgs(argv: string[]): Args {
  const out: Args = { selftest: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--selftest") out.selftest = true;
    else if (a === "--channel") out.channel = argv[++i]?.trim();
    else if (a === "--text") out.text = argv[++i];
    else if (a === "--persona") out.persona = argv[++i]?.trim();
  }
  return out;
}

function finish(code: number): void {
  // Set the code and let the process drain instead of calling process.exit():
  // exiting while undici tears down its keep-alive socket trips a libuv
  // assertion on Windows (src/win/async.c), which looks like a crash.
  process.exitCode = code;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(USAGE);
  finish(0);
} else {
  // The --channel override must land in the environment BEFORE src/config.ts is
  // imported, because config reads process.env once at module load. dotenv does
  // not overwrite variables that are already present, so a shell-set
  // SLACK_CHANNEL_ID still wins over .env.
  if (args.channel) process.env.SLACK_CHANNEL_ID = args.channel;

  const { slackStatus, postAs, redactSecrets, approveUrlPath } = await import("../src/slack.js");

  if (args.selftest) {
    // Synthetic credentials only: this never reads or prints the real token.
    const FAKE_BOT = "xox" + "b-000000000000-111111111111-abcdefghijklmnopqrstuv";
    const FAKE_APP = "xa" + "pp-1-A123-456-abcdefghijklmnop";
    const checks: Array<[string, boolean]> = [
      ["redactSecrets masks a bot token", redactSecrets(`token=${FAKE_BOT}`) === "token=[redacted-token]"],
      ["redactSecrets masks an app token", redactSecrets(FAKE_APP) === "[redacted-token]"],
      ["redactSecrets leaves ordinary text alone", redactSecrets("plain pipeline text") === "plain pipeline text"],
      ["approveUrlPath intake", approveUrlPath("p1", "t1", "intake") === "/company/projects/p1/tasks/t1/approve-intake"],
      ["approveUrlPath code", approveUrlPath("p1", "t1", "code") === "/company/projects/p1/tasks/t1/approve-code"],
      ["approveUrlPath merge", approveUrlPath("p1", "t1", "merge") === "/company/projects/p1/tasks/t1/approve-merge"],
      ["slackStatus() exposes no credential", !/xox[abpors]-|xapp-/.test(JSON.stringify(slackStatus()))],
    ];

    // Totality probe: postAs must resolve (never reject, never throw) even for a
    // persona that is not in the table and empty text. Only safe in mock mode -
    // in live mode this probe would actually post.
    if (slackStatus().mode === "mock") {
      let total = false;
      try {
        const r = await postAs("NOT_A_PERSONA" as Parameters<typeof postAs>[0], "");
        total = r.posted === false && r.mock === true;
      } catch {
        total = false;
      }
      checks.push(["postAs is total: unknown persona + empty text resolves without throwing", total]);
    } else {
      console.log("[slack-test] (skipping the totality probe: mirror is live and the probe would post)");
    }
    for (const [name, ok] of checks) console.log("[slack-test] " + (ok ? "PASS " : "FAIL ") + name);
    const failed = checks.filter(([, ok]) => !ok).length;
    console.log(`[slack-test] selftest: ${checks.length - failed}/${checks.length} passed (no network call made).`);
    finish(failed ? 1 : 0);
  } else {
    const status = slackStatus();
    console.log("[slack-test] slackStatus() = " + JSON.stringify(status));
    console.log(
      "[slack-test] mode=" + status.mode + " configured=" + status.configured + " channel=" + (status.channel ?? "(none)")
    );

    const persona = (args.persona ?? "SONNET_LEAD") as Parameters<typeof postAs>[0];
    const text =
      args.text ?? `slack-test: mirror smoke test from ops/slack-test.ts (${new Date().toISOString()}). Safe to ignore.`;

    const started = Date.now();
    const result = await postAs(persona, text);
    const elapsed = Date.now() - started;

    console.log(`[slack-test] postAs(${persona}) -> ${JSON.stringify(result)} in ${elapsed}ms`);

    if (result.posted) {
      console.log(`[slack-test] OK: live post accepted by Slack (ts=${result.ts ?? "?"}).`);
      finish(0);
    } else if (status.mode === "mock") {
      console.log("[slack-test] MOCK mode: nothing was sent to Slack. This is the expected result with no token configured.");
      finish(0);
    } else {
      console.log("[slack-test] FAILED: live mode but the post did not land. Slack said: " + (result.error ?? "unknown error"));
      console.log("[slack-test] Check: bot invited to the channel, chat:write + chat:write.customize granted, channel ID correct.");
      finish(1);
    }
  }
}
