/**
 * ops/ask-model.ts — ask a gateway model a question and print the answer.
 *
 * The CEO's rule for today ("since u dont have claude at the moment u can refer to kimi for
 * doubts") needs a one-liner any worker can run, so this is it:
 *
 *   npx tsx ops/ask-model.ts kimi-k2.7-code "how do I keep the TTS server alive on Windows?"
 *   npx tsx ops/ask-model.ts kimi-k2.7-code --system "You are a Windows audio expert" "question"
 *
 * Note: `jcode -m <model>` does NOT switch a session's model (verified 20:19-20:22 - see
 * docs/AGENT_COORDINATION.md), which is exactly why consulting a model has to go through the
 * gateway. Default model is kimi-k2.7-code; any id from `jcode model list -p opencode-go`
 * works. Read-only: it calls the gateway and prints text, nothing else.
 */
import "dotenv/config";
import { callGatewayModel } from "../src/gateway.js";

const argv = process.argv.slice(2);
const sysIdx = argv.indexOf("--system");
const system = sysIdx >= 0 ? argv[sysIdx + 1] : undefined;
const rest = argv.filter((a, i) => (sysIdx >= 0 ? i !== sysIdx && i !== sysIdx + 1 : true));
const model = rest[0] ?? "kimi-k2.7-code";
const question = rest.slice(1).join(" ").trim();

if (!question) {
  console.error('usage: npx tsx ops/ask-model.ts <model> [--system "..."] "<question>"');
  process.exit(2);
}

console.log(`[ask-model] model=${model} chars=${question.length}`);
const t = Date.now();
try {
  const r = await callGatewayModel(model, system, question);
  const text = (r?.text ?? "").trim();
  console.log(`[ask-model] ${Date.now() - t}ms`);
  console.log("");
  console.log(text || "(empty response)");
  process.exit(text ? 0 : 1);
} catch (e) {
  console.error(`[ask-model] FAILED after ${Date.now() - t}ms: ${String(e).slice(0, 300)}`);
  process.exit(1);
}
