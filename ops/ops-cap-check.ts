import "./sandbox-company-root.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultOpsDeps } from "../src/company/opsView.js";

let fails = 0;
const say = (ok: boolean, msg: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${msg}`);
  if (!ok) fails++;
};

const KEY = "ORDER_CREDIT_CAP";
const saved = process.env[KEY];
function capWith(value: string | undefined): number | null | undefined {
  if (value === undefined) delete process.env[KEY];
  else process.env[KEY] = value;
  return defaultOpsDeps().creditCapUsd?.();
}
try {
  say(capWith(undefined) === null, "no ORDER_CREDIT_CAP means no cap (null)");
  say(capWith("") === null, "an empty value means no cap");
  say(capWith("15") === 15, "ORDER_CREDIT_CAP=15 gives 15");
  say(capWith("9.5") === 9.5, "a decimal cap is kept");
  say(capWith("abc") === null, "a non-number means no cap");
  say(capWith("0") === null, "zero means no cap");
  say(capWith("-3") === null, "a negative number means no cap");
} finally {
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "src", "company", "opsView.ts"), "utf8");
say(!/d\.creditCapUsd\(\)\s*:\s*9\.0/.test(src), "the money view no longer falls back to a cap of 9.0");
say(/cap:\s*number\s*\|\s*null/.test(src), "the money view type allows a null cap");
say(/cap\s*!==\s*null\s*&&\s*cap\s*>\s*0/.test(src), "the credit alert only runs for a real cap");
console.log(fails === 0 ? "ALL PASS" : `${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
