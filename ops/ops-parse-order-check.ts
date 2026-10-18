import "./sandbox-company-root.js";
import { parseOrderId } from "../src/company/opsView.js";

let fails = 0;
const say = (ok: boolean, msg: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${msg}`);
  if (!ok) fails++;
};

say(parseOrderId("# Order ZX1-ops-api: build the thing\n\nbody") === "ZX1-ops-api", "a plain order heading is read");
say(parseOrderId("opencode.exe --run 'Order ZX1- in dev' --auto") === "ZX1", "the inline form is still read");
say(parseOrderId("no order here") === undefined, "text without an order gives nothing");
say(parseOrderId("format: `# Order <id>-...` then the real work\n# Order AB1-real-one: x") === "AB1-real-one", "a placeholder example is skipped and the real order after it is found");
say(parseOrderId("only the example: `# Order <id>-...` and nothing else") === undefined, "a placeholder alone gives nothing");
say(parseOrderId("# Order <id>-x\n# Order <other>\n# Order QQ2-second: y") === "QQ2-second", "several placeholders are all skipped");
console.log(fails === 0 ? "ALL PASS" : `${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
