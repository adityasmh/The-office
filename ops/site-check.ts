#!/usr/bin/env node
/**
 * ops/site-check.ts - proof for order B2-audit-site (2026-10-06).
 *
 *   npx tsx ops/site-check.ts site/audit/index.html [--final]
 *
 * Prints PASS or FAIL per rule and exits 1 when any rule fails. The page is
 * only read, never written, and nothing here touches the network.
 *
 * Rules
 *   no <script>                     the page must be plain HTML and CSS
 *   no external URL                 no http/https URL; mailto: links are allowed
 *   no figure used as a claim       flags every digit+% and digit+x on the line
 *   no banned word                  testimonial, "trusted by", "as seen", guarantee
 *   title and meta description      both present and non-empty
 *   template fields                 all four present unless --final, absent with --final
 *   images have alt text            every <img> tag carries alt
 *   viewport meta                   present
 *
 * After the file check a self-test runs one deliberately bad snippet per rule,
 * and a fixture that must pass. A rule that never fires is reported as vacuous,
 * so a rule cannot pass by being unable to fail.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The template fields the owner fills before publishing. Order is the README order. */
const TEMPLATE_FIELDS = ["{{DATA_PROMISE}}", "{{PRICE}}", "{{CONTACT_EMAIL}}", "{{BUSINESS_NAME}}"] as const;

/** Words the offer must never carry, because the offer has no evidence for them. */
const BANNED_WORDS = ["testimonial", "trusted by", "as seen", "guarantee"] as const;

export interface Rule {
  id: string;
  label: string;
  /** Offending descriptions; an empty array means the rule holds. */
  find: (html: string, final: boolean) => string[];
}

function lineNumberAt(html: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < html.length; i++) {
    if (html[i] === "\n") line++;
  }
  return line;
}

/** A short, single-line excerpt around a match, for the report. */
function excerpt(html: string, index: number, length: number): string {
  const raw = html.slice(index, index + length).split("\n")[0]!.trim();
  return raw.length > 60 ? `${raw.slice(0, 57)}...` : raw;
}

export const RULES: Rule[] = [
  {
    id: "no-script",
    label: "no <script>",
    find(html) {
      const out: string[] = [];
      const re = /<script/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null) {
        out.push(`line ${lineNumberAt(html, m.index)}: ${excerpt(html, m.index, 40)}`);
      }
      return out;
    },
  },
  {
    id: "no-external-url",
    label: "no external http/https URL (mailto: allowed)",
    find(html) {
      const out: string[] = [];
      const re = /https?:\/\/[^\s"'<>)\]]+/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null) {
        const before = html.slice(Math.max(0, m.index - 7), m.index).toLowerCase();
        if (before === "mailto:") continue; // a mailto: URI may carry a domain, nothing is fetched
        out.push(`line ${lineNumberAt(html, m.index)}: ${excerpt(html, m.index, 80)}`);
      }
      return out;
    },
  },
  {
    id: "no-claim-figure",
    label: "no digit+% or digit+x figure used as a claim",
    find(html) {
      const out: string[] = [];
      const patterns: Array<[RegExp, string]> = [
        [/\d+(?:\.\d+)?\s*%/g, "%"],
        [/\b\d+(?:\.\d+)?x\b/gi, "x"],
      ];
      for (const [re, kind] of patterns) {
        let m: RegExpExecArray | null;
        while ((m = re.exec(html)) !== null) {
          out.push(`line ${lineNumberAt(html, m.index)}: "${m[0].trim()}" (digit+${kind})`);
        }
      }
      return out;
    },
  },
  {
    id: "no-banned-word",
    label: "no banned word",
    find(html) {
      const out: string[] = [];
      for (const word of BANNED_WORDS) {
        const re = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
        let m: RegExpExecArray | null;
        while ((m = re.exec(html)) !== null) {
          out.push(`"${word}" on line ${lineNumberAt(html, m.index)}`);
        }
      }
      return out;
    },
  },
  {
    id: "title-and-description",
    label: "title and meta description present",
    find(html) {
      const out: string[] = [];
      const title = /<title>([\s\S]*?)<\/title>/i.exec(html);
      if (!title || title[1]!.trim() === "") out.push("no non-empty <title> found");
      const desc = /<meta\b[^>]*name\s*=\s*["']description["'][^>]*>/i.exec(html);
      if (!desc) {
        out.push("no meta description found");
      } else {
        const content = /content\s*=\s*["']([\s\S]*?)["']/i.exec(desc[0]);
        if (!content || content[1]!.trim() === "") out.push("meta description has no content");
      }
      return out;
    },
  },
  {
    id: "template-fields",
    label: "four template fields present (template) / absent (--final)",
    find(html, final) {
      if (final) {
        return TEMPLATE_FIELDS.filter((f) => html.includes(f)).map((f) => `${f} still present in --final mode`);
      }
      return TEMPLATE_FIELDS.filter((f) => !html.includes(f)).map((f) => `${f} missing`);
    },
  },
  {
    id: "image-alt",
    label: "images have alt text",
    find(html) {
      const out: string[] = [];
      const re = /<img\b[^>]*>/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null) {
        if (!/\balt\s*=/i.test(m[0])) out.push(`line ${lineNumberAt(html, m.index)}: ${excerpt(m[0], 0, 60)}`);
      }
      return out;
    },
  },
  {
    id: "viewport-meta",
    label: "viewport meta exists",
    find(html) {
      return /<meta\b[^>]*name\s*=\s*["']viewport["']/i.test(html) ? [] : ["no viewport meta found"];
    },
  },
];

/* ------------------------------------------------------------------ */
/* Self-test: one bad snippet per rule, plus a fixture that must pass. */
/* ------------------------------------------------------------------ */

const FIXTURE_GOOD = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fixture page</title>
<meta name="description" content="A fixture page used by the checker self-test.">
</head>
<body>
<h1>{{BUSINESS_NAME}}</h1>
<p>Write to {{CONTACT_EMAIL}} about the report.</p>
<p>{{DATA_PROMISE}}</p>
<p>Price: {{PRICE}}</p>
<img src="chart.png" alt="Spend by day for the fixture export">
</body>
</html>`;

/** The same fixture with the template fields filled in, so --final must pass. */
const FIXTURE_FINAL = FIXTURE_GOOD.replace("{{BUSINESS_NAME}}", "Acme Audits")
  .replace("{{CONTACT_EMAIL}}", "hello@acme.example")
  .replace("{{DATA_PROMISE}}", "The file is deleted once the report is sent.")
  .replace("{{PRICE}}", "A fixed fee, agreed in writing.");

interface Mutation {
  ruleId: string;
  detail: string;
  html: string;
  final?: boolean;
}

const MUTATIONS: Mutation[] = [
  { ruleId: "no-script", detail: "adds a <script> block", html: `${FIXTURE_GOOD}<script>console.log("hi")</script>` },
  { ruleId: "no-external-url", detail: "links to an outside site", html: `${FIXTURE_GOOD}<a href="https://example.com/x">see</a>` },
  { ruleId: "no-claim-figure", detail: "claims a percentage", html: `${FIXTURE_GOOD}<p>Save 30% on every call.</p>` },
  { ruleId: "no-claim-figure", detail: "claims a multiplier", html: `${FIXTURE_GOOD}<p>Runs 4x faster.</p>` },
  { ruleId: "no-banned-word", detail: "quotes a testimonial", html: `${FIXTURE_GOOD}<p>A testimonial from a happy user.</p>` },
  { ruleId: "no-banned-word", detail: "says trusted by", html: `${FIXTURE_GOOD}<p>Trusted by teams everywhere.</p>` },
  { ruleId: "no-banned-word", detail: "says as seen", html: `${FIXTURE_GOOD}<p>As seen in a newsletter.</p>` },
  { ruleId: "no-banned-word", detail: "offers a guarantee", html: `${FIXTURE_GOOD}<p>We guarantee a smaller bill.</p>` },
  {
    ruleId: "title-and-description",
    detail: "drops the title",
    html: FIXTURE_GOOD.replace(/<title>[\s\S]*?<\/title>/, ""),
  },
  {
    ruleId: "title-and-description",
    detail: "drops the meta description",
    html: FIXTURE_GOOD.replace(/<meta name="description"[^>]*>/, ""),
  },
  {
    ruleId: "template-fields",
    detail: "leaves a field missing in template mode",
    html: FIXTURE_GOOD.replace("{{PRICE}}", "A fixed fee."),
    final: false,
  },
  {
    ruleId: "template-fields",
    detail: "keeps a field in --final mode",
    html: FIXTURE_FINAL.replace("Acme Audits", "{{BUSINESS_NAME}}"),
    final: true,
  },
  {
    ruleId: "image-alt",
    detail: "image without alt",
    html: FIXTURE_GOOD.replace('alt="Spend by day for the fixture export"', ""),
  },
  {
    ruleId: "viewport-meta",
    detail: "drops the viewport meta",
    html: FIXTURE_GOOD.replace(/<meta name="viewport"[^>]*>/, ""),
  },
];

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  -> ${detail}` : ""}`);
}

function runRules(html: string, final: boolean): Map<string, string[]> {
  const results = new Map<string, string[]>();
  for (const rule of RULES) results.set(rule.id, rule.find(html, final));
  return results;
}

function reportFile(file: string, html: string, final: boolean): void {
  console.log(`site-check: ${file}  (mode: ${final ? "final" : "template"})`);
  const results = runRules(html, final);
  for (const rule of RULES) {
    const offenders = results.get(rule.id)!;
    check(rule.label, offenders.length === 0, offenders.join(" | "));
  }
}

function runSelfTest(): void {
  console.log("site-check: self-test (each rule must be able to fail; the good fixture must pass)");

  const good = runRules(FIXTURE_GOOD, false);
  const badRules = RULES.filter((r) => good.get(r.id)!.length > 0);
  check(
    "self-test: good fixture passes every rule in template mode",
    badRules.length === 0,
    badRules.map((r) => `${r.id}: ${good.get(r.id)!.join(" | ")}`).join(" | "),
  );

  const goodFinal = runRules(FIXTURE_FINAL, true);
  const badFinalRules = RULES.filter((r) => goodFinal.get(r.id)!.length > 0);
  check(
    "self-test: filled fixture passes every rule in --final mode",
    badFinalRules.length === 0,
    badFinalRules.map((r) => `${r.id}: ${goodFinal.get(r.id)!.join(" | ")}`).join(" | "),
  );

  const goodIsClean = RULES.every((r) => good.get(r.id)!.length === 0);

  for (const mut of MUTATIONS) {
    const results = runRules(mut.html, mut.final ?? false);
    const offenders = results.get(mut.ruleId)!;
    const vacuous = goodIsClean && offenders.length === 0;
    check(
      `self-test: rule "${mut.ruleId}" catches ${mut.detail}`,
      !vacuous,
      vacuous ? "rule is vacuous: it cannot fail" : offenders[0] ?? "",
    );
  }
}

function main(argv: string[]): number {
  const final = argv.includes("--final");
  const file = argv.find((a) => !a.startsWith("--"));

  if (!file) {
    console.error("usage: npx tsx ops/site-check.ts <file.html> [--final]");
    return 1;
  }

  let html: string;
  try {
    html = fs.readFileSync(file, "utf8");
  } catch (err) {
    console.error(`FAIL  cannot read ${file}  -> ${(err as Error).message}`);
    return 1;
  }

  reportFile(file, html, final);
  runSelfTest();

  const summary = failures === 0 ? "RESULT: PASS" : `RESULT: FAIL (${failures} check${failures === 1 ? "" : "s"} failed)`;
  console.log(summary);
  return failures === 0 ? 0 : 1;
}

const invokedDirectly = process.argv[1] ? path.resolve(process.argv[1]) : "";
const thisFile = path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly === thisFile || process.env.SITE_CHECK_FORCE_MAIN === "1") {
  process.exitCode = main(process.argv.slice(2));
}
