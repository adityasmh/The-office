# REPORT B2-audit-site: one-page website for the audit offer

Date: 2026-10-06. Order: `docs/overnight/ORDER_B2-audit-site.md`.

## Files

| File | State | What it is |
|---|---|---|
| `site/audit/index.html` | new | The page. One self-contained file, inline CSS, no JavaScript, no external font, script, image or tracker. Template mode: the four fields are still `{{...}}`. |
| `site/audit/README.md` | new | How to fill the four fields, the suggested data-promise sentence, free publishing options that need no credentials from anyone, and the claims not to add unless true and measured. |
| `ops/site-check.ts` | new | The checker. `npx tsx ops/site-check.ts <file> [--final]`. Prints PASS or FAIL per rule, exits 1 on any FAIL, and carries its own bad snippet per rule so no rule can pass by being unable to fail. |

No other file was created, edited or deleted. No new dependency (Node built-ins only). No network call.

## Page contents

Headline, the problem (AI spend nobody owns), what you get (where the money goes, spikes, possible
retry loops, context bloat, a model comparison table you can check, what to test before switching),
how it works in 3 steps, what it does not do, price, FAQ, contact, footer. Responsive layout with a
420 px breakpoint, CSS variables with `prefers-color-scheme: dark`, `:focus-visible` outlines, a skip
link, a title and a meta description. No testimonial, no customer logo, no invented statistic, no
"savings" figure. The words `testimonial`, `trusted by`, `as seen` and `guarantee` do not appear
(the "no promise of savings" line is written without the banned word).

Template fields: `{{DATA_PROMISE}}` (how it works), `{{PRICE}}` (price), `{{CONTACT_EMAIL}}` (two
`mailto:` links), `{{BUSINESS_NAME}}` (footer).

## Command 1: template mode (must PASS)

```
> npx tsx ops/site-check.ts site/audit/index.html
site-check: site/audit/index.html  (mode: template)
PASS  no <script>
PASS  no external http/https URL (mailto: allowed)
PASS  no digit+% or digit+x figure used as a claim
PASS  no banned word
PASS  title and meta description present
PASS  four template fields present (template) / absent (--final)
PASS  images have alt text
PASS  viewport meta exists
site-check: self-test (each rule must be able to fail; the good fixture must pass)
PASS  self-test: good fixture passes every rule in template mode
PASS  self-test: filled fixture passes every rule in --final mode
PASS  self-test: rule "no-script" catches adds a <script> block  -> line 16: <script>console.log("hi")</script>
PASS  self-test: rule "no-external-url" catches links to an outside site  -> line 16: https://example.com/x">see</a>
PASS  self-test: rule "no-claim-figure" catches claims a percentage  -> line 16: "30%" (digit+%)
PASS  self-test: rule "no-claim-figure" catches claims a multiplier  -> line 16: "4x" (digit+x)
PASS  self-test: rule "no-banned-word" catches quotes a testimonial  -> "testimonial" on line 16
PASS  self-test: rule "no-banned-word" catches says trusted by  -> "trusted by" on line 16
PASS  self-test: rule "no-banned-word" catches says as seen  -> "as seen" on line 16
PASS  self-test: rule "no-banned-word" catches offers a guarantee  -> "guarantee" on line 16
PASS  self-test: rule "title-and-description" catches drops the title  -> no non-empty <title> found
PASS  self-test: rule "title-and-description" catches drops the meta description  -> no meta description found
PASS  self-test: rule "template-fields" catches leaves a field missing in template mode  -> {{PRICE}} missing
PASS  self-test: rule "template-fields" catches keeps a field in --final mode  -> {{BUSINESS_NAME}} still present in --final mode
PASS  self-test: rule "image-alt" catches image without alt  -> line 14: <img src="chart.png" >
PASS  self-test: rule "viewport-meta" catches drops the viewport meta  -> no viewport meta found
RESULT: PASS
EXIT=0
```

## Command 2: final mode (must FAIL on purpose, fields still there)

```
> npx tsx ops/site-check.ts site/audit/index.html --final
site-check: site/audit/index.html  (mode: final)
PASS  no <script>
PASS  no external http/https URL (mailto: allowed)
PASS  no digit+% or digit+x figure used as a claim
PASS  no banned word
PASS  title and meta description present
FAIL  four template fields present (template) / absent (--final)  -> {{DATA_PROMISE}} still present in --final mode | {{PRICE}} still present in --final mode | {{CONTACT_EMAIL}} still present in --final mode | {{BUSINESS_NAME}} still present in --final mode
PASS  images have alt text
PASS  viewport meta exists
site-check: self-test (each rule must be able to fail; the good fixture must pass)
PASS  self-test: good fixture passes every rule in template mode
PASS  self-test: filled fixture passes every rule in --final mode
PASS  self-test: rule "no-script" catches adds a <script> block  -> line 16: <script>console.log("hi")</script>
PASS  self-test: rule "no-external-url" catches links to an outside site  -> line 16: https://example.com/x">see</a>
PASS  self-test: rule "no-claim-figure" catches claims a percentage  -> line 16: "30%" (digit+%)
PASS  self-test: rule "no-claim-figure" catches claims a multiplier  -> line 16: "4x" (digit+x)
PASS  self-test: rule "no-banned-word" catches quotes a testimonial  -> "testimonial" on line 16
PASS  self-test: rule "no-banned-word" catches says trusted by  -> "trusted by" on line 16
PASS  self-test: rule "no-banned-word" catches says as seen  -> "as seen" on line 16
PASS  self-test: rule "no-banned-word" catches offers a guarantee  -> "guarantee" on line 16
PASS  self-test: rule "title-and-description" catches drops the title  -> no non-empty <title> found
PASS  self-test: rule "title-and-description" catches drops the meta description  -> no meta description found
PASS  self-test: rule "template-fields" catches leaves a field missing in template mode  -> {{PRICE}} missing
PASS  self-test: rule "template-fields" catches keeps a field in --final mode  -> {{BUSINESS_NAME}} still present in --final mode
PASS  self-test: rule "image-alt" catches image without alt  -> line 14: <img src="chart.png" >
PASS  self-test: rule "viewport-meta" catches drops the viewport meta  -> no viewport meta found
RESULT: FAIL (1 check failed)
EXIT=1
```

The single FAIL is the intended one: the page is still a template, so final mode must refuse it.
After the owner fills the four fields, final mode should reach `RESULT: PASS`.

## Extra verification

`npx tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext
--esModuleInterop --skipLibCheck ops/site-check.ts` -> `EXIT=0` (the script type-checks under the
repo's strict settings; `tsconfig.json` itself only includes `src`).

## Open issues

1. **The four fields are deliberately empty.** `{{PRICE}}` must stay a template until the owner
   learns the real number from a conversation. The README says so; nothing here invents one.
2. **`{{DATA_PROMISE}}` is only a placeholder.** The suggested sentence ("analysed on my own
   machine, never uploaded elsewhere, file deleted after the report") is a promise the owner must
   confirm, and must be rewritten if any part is not exactly how the work is done.
3. **Cosmetic wording in the self-test lines**, e.g. `rule "no-script" catches adds a <script>
   block`. Understandable, but the phrase would read better as `catches: adds a ...`. Left as is so
   the reported output matches the code exactly.
4. **The digits rule flags any `digit%` or `digitx`, including in CSS** (so no numeric percentages
   in styles, e.g. no `100%` widths). This is intentional and stricter than the order asked. A
   future edit that needs a percentage unit will fail the check.
5. **Not linked from anywhere yet.** The page is standalone by design. Whoever publishes it decides
   the URL, and the README explains the free options without anyone else needing credentials.
6. **Unverified in a real browser.** The file was checked by rules and by reading, not rendered on
   screen. The layout is simple and system-font based, but the first publish should be eye-checked
   at 360 px and in dark mode.
