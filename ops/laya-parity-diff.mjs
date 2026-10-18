// ops/laya-parity-diff.mjs - compare two ops/laya-gpu-bench.ts runs field by field.
//
// The parity claim in docs/LAYA_TUNING.md is "the answers are unchanged by moving Laya
// to the GPU". This turns that claim into a command instead of an eyeball:
//
//   node ops/laya-parity-diff.mjs ops/laya-before-parity.txt ops/laya-after-parity.txt
//   node ops/laya-parity-diff.mjs ops/laya-before-bench.txt  ops/laya-after-bench.txt
//
// It compares everything EXCEPT the trailing latency number of each line, and prints
// the exit code 0 (identical) or 1 (differences listed).

import { readFileSync } from "node:fs";

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error("usage: node ops/laya-parity-diff.mjs <before.txt> <after.txt>");
  process.exit(2);
}

// Note the padding: the bench prints "call  1" (two spaces) for single digits, so the
// matcher must allow whitespace, not one literal space.
function answers(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^q\d/.test(l) || /^call\s+\d/.test(l) || l.startsWith("ANSWERS"))
    .map((l) => {
      if (/^call\s+\d/.test(l)) return l.replace(/^call\s+\d+\s+[\d]+\s+ms\s+/, "");
      if (l.startsWith("ANSWERS")) return l;
      return l.replace(/\s*\|\s*\d+ms\s*$/, "");
    });
}

const before = answers(beforePath);
const after = answers(afterPath);

console.log(`before: ${beforePath} -> ${before.length} answer lines`);
console.log(`after : ${afterPath} -> ${after.length} answer lines`);

let diffs = 0;
const n = Math.max(before.length, after.length);
for (let i = 0; i < n; i++) {
  if (before[i] !== after[i]) {
    diffs++;
    console.log(`DIFF line ${i + 1}`);
    console.log(`  before: ${before[i] ?? "(missing)"}`);
    console.log(`  after : ${after[i] ?? "(missing)"}`);
  }
}

if (diffs === 0) {
  console.log(`IDENTICAL: all ${n} answer lines match field for field (latency excluded)`);
  process.exit(0);
}
console.log(`${diffs} of ${n} lines differ`);
process.exit(1);
