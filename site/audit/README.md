# The audit page (`site/audit/index.html`)

One self-contained HTML file. Inline CSS, no JavaScript, no external fonts, images, scripts or
trackers. It can be opened straight from disk, emailed as an attachment, or published as a static
page.

Nothing on it is a measurement yet. Everything the owner must decide is a template field, and the
page must not be published until the four fields are filled.

## The four template fields

Fill them in the HTML file, then run the checker in final mode (see below).

| Field | Where it appears | What to put |
|---|---|---|
| `{{PRICE}}` | Price section | The real price of one audit, written the way you will say it out loud. Example shape: "A fixed fee of <amount> per audit." Leave it unpublished until you know the number from a real conversation. |
| `{{DATA_PROMISE}}` | How it works | One sentence, only if it is true for how you actually handle the file. See the suggested sentence below. |
| `{{CONTACT_EMAIL}}` | How it works, Start section, both as `mailto:` links | A mailbox you will check within a day, ideally one dedicated to the offer. |
| `{{BUSINESS_NAME}}` | Footer | The trading name. If you have no registered name yet, your own name is honest. |

The regex the checker looks for is the literal `{{FIELD}}` text, so keep the double braces while
editing.

## Suggested data-promise sentence

Only use this, or any variant, if every clause is true in the way you work:

> "Your export is analysed on my own machine, never uploaded to any other service, and the file is
> deleted once the report has been sent. I am happy to sign an NDA before you send anything."

If you plan to hand the analysis to another tool or a hosted service, change the sentence to say
so. The sentence is a promise the owner makes, not a default the page can make for you.

## Publish a single static file for free

You keep every account and every credential. No one else needs access to anything.

1. **Do nothing at all.** The page works from disk. Send the file, or a PDF print of it, to the
   people you are already talking to.
2. **GitHub Pages.** Put the file in a repository as `index.html` (repository root, or a `docs/`
   folder), then turn on Pages in the repository settings for that branch and folder. Free for
   public repositories, with your own domain optional. You log in, nobody else does.
3. **Cloudflare Pages or Netlify Drop, free tiers.** Upload the folder through their own dashboard
   and the host gives you a subdomain. Also possible by dragging a folder in the browser. Again,
   you sign in yourself.
4. **Any static host you already pay for.** Copy the single file into the web root.

Do not give a hosting password, an API token, a repository invite, or a domain login to anyone who
offers to "set the page up for you", including an assistant. These four options all work with your
own login on your own machine.

## Claims not to add unless true and measured

The offer's whole value is that its numbers come from the customer's own export. Every line below
weakens that unless you can point at a measurement.

- Any percentage or multiplier of savings, including "up to X percent".
- Any named customer, logo, or quote.
- "Trusted by", "as seen in", "used by teams at", or similar borrowed authority.
- Any promise that switching models will cut the bill.
- Any guarantee of a result, a deadline you have not hit before, or a refund term you have not
  decided.
- Any average or typical figure from someone else's audit, unless that customer agreed in writing
  to be named.
- Any claim about your own privacy practice that is not exactly how you work.

If a number is not from the customer's export or a price list you show beside it, leave it out.

## Check the page before publishing

```
npx tsx ops/site-check.ts site/audit/index.html          # template mode, must PASS
npx tsx ops/site-check.ts site/audit/index.html --final  # must FAIL until the fields are gone
```

The check covers: no `<script>`, no external URL other than `mailto:`, no digit followed by `%` or
`x` used as a claim, none of the banned words, a title and meta description, the four fields
present before publishing and gone after, `alt` text on every image, and a viewport meta. The
script also self-tests each rule against a deliberately bad snippet, so a rule that cannot fail is
reported instead of passing silently.

Run both commands once, in the foreground, and read the output before you publish.
