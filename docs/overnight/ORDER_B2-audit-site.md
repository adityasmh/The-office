# Order B2-audit-site: one-page website for the audit offer

Context: docs/business/PLAN.md (read the section for this offer first).

Offer B in the plan. A single honest page that explains the audit and lets a visitor contact the owner.

## Files
`site/audit/index.html`, `site/audit/README.md`, `ops/site-check.ts`

## What to build
One self-contained HTML file (inline CSS, no JavaScript needed, no external fonts, scripts, images or trackers). Sections: a plain headline; the problem (AI spend nobody owns); what you get (a report from your own usage export: where the money goes, spikes, possible retry loops, context bloat, a model-comparison table you can check, and a list of what to test before switching); how it works in 3 steps (export the CSV from your provider dashboard, send it, receive the report; say the analysis runs locally on the file and the file is deleted afterwards, but ONLY as a promise the owner must confirm: write it as a template field `{{DATA_PROMISE}}` with a suggested sentence in the README); what it does not do (no guarantee of savings, no access to your accounts or keys, no reading of prompts); pricing as the template field `{{PRICE}}`; a short FAQ; contact as the template field `{{CONTACT_EMAIL}}` used in a `mailto:` link; footer with `{{BUSINESS_NAME}}`. NO testimonials, NO customer logos, NO invented statistics, NO "save up to X percent" claims. Responsive down to 360 px, readable contrast in light and dark (use CSS variables and `prefers-color-scheme`), keyboard friendly, with a proper title and meta description.
`site/audit/README.md`: how to fill the four template fields, the suggested data-promise sentence, how to publish a single static file for free (describe the options without asking the owner to give credentials to anyone), and a short list of the claims the owner must NOT add unless they are true and measured.
`ops/site-check.ts`: `npx tsx ops/site-check.ts site/audit/index.html [--final]` prints PASS or FAIL per rule and exits 1 on any FAIL. Rules: no `<script`; no external `http` or `https` URL except the `mailto:`; no digits followed by `%` or `x` used as a claim (flag any `\d+%` and report the line); none of the banned words (testimonial, "trusted by", "as seen", guarantee); title and meta description present; the four template fields present when not `--final` and ABSENT with `--final`; images have alt text; a viewport meta exists.

## Proof
Run `npx tsx ops/site-check.ts site/audit/index.html` (must pass in template mode) and `npx tsx ops/site-check.ts site/audit/index.html --final` (must FAIL because the fields are still there, and the report must show that failure on purpose). Include both outputs in the report. Also write a tiny fixture inside the check script that proves each rule can fail (a bad snippet per rule) so the rules are not vacuous.
## Common rules
- Create or edit ONLY the files named in "Files". Other workers run at the same time on other files. Make small targeted edits to any existing file; never rewrite an entire existing file. Match the surrounding style. No new dependencies; Node built-ins only (ES modules, `.js` import suffixes where importing).
- Never restart or start the router. Never read, print or edit `.env`. Never touch `company/`, Laya, Kafka or scheduled tasks. No real network calls in tests. No deletes of existing files.
- Never invent a number, customer, testimonial, logo or price. Any figure shown to a user must come from the data the tool was given or from a clearly labelled assumption the user supplies.
- Run each command ONCE, in the foreground. If a step fails, report the exact error and END your turn; do not retry in a loop.
- Narrow job with an explicit end: write `docs/overnight/REPORT_<stem>.md` (files, exact command output, open issues), print the same report and END your turn. Do not wait, poll, loop, or re-read this order.