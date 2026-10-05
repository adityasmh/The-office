# ATR Production - Website Aesthetic, Market Rates and Options (research only)

Author: jcode ATR-5 worker. Date of all observations: **2026-09-30**. No logins, no form submissions, no contact made.
Site audited: **https://atrproduction.com**. Method: raw HTML/CSS captured with `curl`, pages rendered in headless
Microsoft Edge over the DevTools Protocol at **1440x900 (desktop)** and **390x844 (mobile)**, screenshots taken,
`performance.getEntriesByType('resource')` used for real page-weight numbers. Everything below is measured or
sourced; anything I could not verify says UNVERIFIED.

---

## 1. What the site is, and who it targets

A single-owner **production house / wedding-and-brand film studio**, marketing itself as a "CINEMATIC PRODUCTION
HOUSE" with the tagline "A VISION FOR THE EXTRAORDINARY". It sells four buckets: cinematic films/brand campaigns,
creator & lifestyle (influencer), destination weddings, and commercial/drone/product/fashion shoots.

Who it targets: **couples planning weddings (destination weddings included) and brand/marketing managers wanting
films, fashion editorials and product photography.** Contact is one person's mobile (`+91 90041 99942`) and a Gmail
address (`officialatrhouse@gmail.com`).

Commercial reality check from the HTML itself:
- The whole funnel is **WhatsApp**: every CTA is `wa.me/919004199942`. There is **no enquiry form** - `0 <form>` and
  `0 <input>` elements on home, `/contact/`, `/portfolio/films/` and `/about-us/`.
- The footer advertises **four different Instagram accounts** (`@vighneshmhatre.in`, `@affairstoremember.in`,
  `@atrproductionhouse`, `@okayletsfly`), plus Behance, Facebook and YouTube (`@affairstoremember07`). The brand name
  itself is inconsistent across pages: "ATR Productions" (title tag), "ATR House" (WhatsApp prefill text), "ATR
  Production House" (Instagram), and a logo tagline rendered as "ASHORE TO BEYOND".

## 2. What the work is - the delivery, broken into steps

Elements a "website aesthetic review / refresh" delivery actually involves, in order:

1. **Audit and measurement** - crawl the pages, capture desktop + mobile renders, measure Core Web Vitals proxies
   (LCP, TTFB, page weight, request count, CLS risk), run an accessibility pass (alt text, contrast, focus order,
   heading outline), inventory the CMS/plugin stack and any leaked staging/duplicate URLs.
2. **Positioning and content model** - decide the ONE audience and offer per page; write the page hierarchy
   (home, films, weddings, fashion, brands, about, contact, enquiry); fix brand naming; write real copy to replace
   placeholder text and fake testimonials.
3. **Information architecture and navigation** - primary nav, mobile nav, portfolio taxonomy (video vs stills vs
   category), internal linking, breadcrumbs.
4. **Visual redesign** - art direction (colour, type scale, grid), a component library, hero treatment, portfolio
   grid/reel layout, reusable section patterns so new shoots can be added without new design work.
5. **Photography/video asset prep** - select, grade, crop; produce responsive derivatives (AVIF/WebP at several
   widths), poster frames for video, correct aspect ratios, real `width`/`height` attributes.
6. **Template build in the chosen CMS** - theme/sections, CMS collections for projects, reusable blocks, a content
   editor the owner can actually use.
7. **Enquiry and lead capture** - a real form + validation + spam protection + a notification destination (email/
   CRM/WhatsApp), plus fallback phone/WhatsApp CTAs, and lead-source tracking.
8. **Performance work** - image pipeline, lazy loading below the fold, font subsetting/self-hosting, CSS/JS
   reduction, caching/CDN, removal of unused plugin weight.
9. **SEO and metadata** - unique titles/descriptions, Open Graph/social cards, canonical tags, XML sitemap,
   `LocalBusiness`/`Organization` schema, removal of any staging-domain references, Google Search Console + GA4.
10. **Accessibility and quality pass** - alt text, contrast AA, keyboard focus, heading order, form labels; a
    Lighthouse/axe re-run with before/after numbers.
11. **Analytics, consent and legal** - GA4 or privacy-first analytics, cookie consent if any EU/UK traffic, privacy
    policy, terms, image/music licensing clearance.
12. **Content migration and launch** - redirects from old URLs (`/films/` -> `/portfolio/films/`), 404 handling,
    hosting/DNS, SSL, uptime + backups, then a **30/60/90 handover** with a "how to add a new project" guide.

## 3. The current look

Structure: Astra theme + Elementor with the Spectra blocks plugin (WordPress **7.1.2**, Astra **4.13.12**),
LiteSpeed Cache, Smush, Site Kit by Google **1.188.0**, SureRank **1.10.1** SEO, JoinChat, Swiper, jQuery. Fonts
loaded from Google: **Playfair Display + Raleway**, plus **Cormorant** and **Poppins** in the theme CSS and
**Source Sans Pro** as the body font - five families in one page.

- **Home hero (desktop, 1440px):** near-black page background with a large cream rounded card on the left holding
  the eyebrow "CINEMATIC PRODUCTION HOUSE", the H1 "A VISION FOR THE EXTRAORDINARY." (Raleway, 42px, 2px letter
  spacing, uppercase), a serif sub-paragraph, a black pill CTA "EXPLORE OUR WORK ->", and a 2x2 row of icon chips
  (Cinematic Films / Brand Campaigns / Creator & Lifestyle / Destination Weddings). On the right, a tall
  rounded-corner portrait frame with a rotating circular "CREATIVE EXCELLENCE" badge overlapping it. It is a
  competent, current-looking editorial layout - the strongest thing on the site.
- **Home (mobile, 390px):** the photo jumps above the text, then eyebrow/H1/paragraph; a **fixed bottom tab bar**
  (Home / Portfolio / About Us / Contact) and a green WhatsApp bubble. The WhatsApp bubble **overlaps the hero
  paragraph** and the bottom bar covers content.
- **Contact page:** full-bleed **generic starfield/space stock photo** behind the word "CONTACT", then "READY TO
  GET STARTED?", an "ENQUIRY FORM" pill in a mud-grey that reads as *disabled*, then Gmail + mobile number, then an
  FAQ. The floating "AMBIENT MUSIC" pill sits on top of the content card.
- **Imagery:** strong, real photography (weddings, drone, editorial) - correctly the best asset the business has.
- **Motion:** light - hover menu animation, a rotating badge, a scroll-driven section or two. A background
  `<video autoplay loop muted playsinline>` exists with a single source `WEBSITE-F_1.webm` declared as
  `type="video/mp4"` (wrong MIME). An "AMBIENT MUSIC" toggle streams `HAUSER-Wicked-Game-1-1.mp3`.

## 4. What works

- **Real, high-quality photography and film work.** The imagery does the selling; the layout gets out of its way.
- **Clear service taxonomy** (weddings, fashion, brands, aerial/commercial) and a portfolio dropdown in the nav.
- **Baseline SEO hygiene exists:** `lang="en-US"`, viewport meta, canonical tag, per-page titles, a skip link,
  Organization/WebPage microdata, an XML sitemap declared in `robots.txt`, WebP delivery and `srcset`/`<picture>`
  in use (69 `<picture>` elements, 302 `.webp` references on the home page).
- **Alt text coverage is complete** - 162/162 images on the home page have an `alt` attribute (measured via DOM).
- **Mobile nav is native-feeling** (bottom tab bar) and the hero reflows sensibly.
- **LiteSpeed cache + HTTP/3** on Hostinger: cached home page TTFB measured at **42 ms**.

## 5. What hurts credibility and conversion

Ranked by damage:

1. **Placeholder content is live.** The home page renders the literal string **"TRUSTED BY 0+ BRANDS & CREATORS"**
   (a counter that never populated) and three testimonials from **"XYZ Company"** with **Emily Johnson / David
   Smith / Sophia Miller** - the template's sample personas. Any brand-side buyer who scrolls sees this.
2. **No way to enquire except WhatsApp/Gmail.** Zero forms on the site. A brand manager on a work laptop will not
   message a personal number, and `officialatrhouse@gmail.com` undercuts a "high-end production house" pitch.
3. **Staging domain leaked into live CSS.** Section background images still point at
   `https://mistyrose-lobster-739747.hostingersite.com/wp-content/uploads/2026/05/*.png` (10+ references). That
   leaks the Hostinger staging URL to every visitor and search crawler, and risks duplicate-content/soft-404s.
4. **Brand fragmentation.** Four Instagram handles, three spellings of the company name, and an undiscoverable
   logo strapline. The alt text on the logo is literally `untitled design 21`.
5. **The home meta description is auto-generated mid-sentence:** "CINEMATIC PRODUCTION HOUSE A VISION FOR THE
   EXTRAORDINARY. Crafting timeless visual narratives, brand films, and high-end campaigns that inspire, engage,
   and" - it is the hero text truncated. This is the snippet Google will show.
6. **Contact page undercuts the pitch:** a generic starfield stock image (off-brand for a wedding studio) and a grey
   "ENQUIRY FORM" button that looks disabled.
7. **Copyright exposure on the ambient track.** "AMBIENT MUSIC" streams a commercial recording
   (`HAUSER - Wicked Game`) from the site's own `/wp-content/uploads/`. Streaming a copyrighted master as site
   ambience needs a licence; an unlicensed use is a real legal risk for a commercial site.
8. **Copy-paste boilerplate on "why work with us":** "STORY/SPEED/QUALITY/PROCESS/CONNECTION" with generic lines
   ("Fast delivery without compromising on creativity") that say nothing a competitor cannot say.
9. **Duplicate/contradictory pathways:** three separate "Book your service", "Start Your Story", "Ready to Create
   Perfect Memories?" and "Book a call" blocks, all going to the same WhatsApp link.

## 6. Speed, mobile and accessibility (measured)

| Metric (home page) | Desktop 1440px | Mobile 390px |
|---|---|---|
| HTML document (decoded) | 392,615 bytes | 392,615 bytes |
| Requests / decoded total | 158 / ~6.98 MB | 169 / ~7.5 MB |
| Image bytes decoded | 5.62 MB over 88 image requests | 5.62 MB over 88 requests |
| CSS decoded | 204 KB | 719 KB |
| JS decoded | 702 KB | 702 KB |
| TTFB | 42 ms (LiteSpeed cache HIT) | **4,109 ms** on an uncached first load |
| DOM size | 1,254 `<div>`, 1 `<section>` | 1,158 `<div>` |
| Page height | 9,138 px | **15,245 px** |

Findings:
- **~7 MB decoded per home page view** is the headline problem; ~5.6 MB of it is images. Raw files include
  2,560x1,920 and 1,708x2,560 originals, and `/about-us/` served a **1,144 KB** image set with one PNG at 383 KB.
- **Inline CSS: 25 `<style>` blocks = 159,684 characters.** One more cacheable file would be cheaper than 160 KB of
  inline CSS on every response.
- **146 of 162 images have no `width`/`height` attributes** - a direct CLS risk on a page whose layout depends on
  image aspect ratios.
- **20 images had an empty resolved `currentSrc`** after a full scroll-and-return: the lazy-load chain is fragile
  (Smush `data-src`/`lazyload` classes; only **1** native `loading="lazy"` in the markup).
- **Cold TTFB ~0.65-0.82 s** on interior pages (contact 819 ms, films 715 ms, about 655 ms); the mobile home load
  was **4.1 s TTFB** uncached. Cache-miss performance is the real-world experience.
- **Video is mis-declared:** the hero `<video>` has one `<source src="...WEBSITE-F_1.webm" type="video/mp4">`. A
  `.webm` announced as `video/mp4` can be refused by Safari/Firefox; the measured element also sat `paused` with
  `readyState=4`. No `poster` fallback image is provided.
- **Mobile overlap:** the fixed WhatsApp bubble and bottom tab bar cover the hero paragraph (confirmed in the
  390x844 screenshot); the "AMBIENT MUSIC" pill covers the contact card at the bottom-left on desktop.
- **Accessibility:** good baseline (skip link, `lang`, viewport, 12 `aria-label`s, 0 unnamed buttons, all images
  have `alt`). Problems: **headings misused** - Spectra renders body paragraphs as `<h2>` (e.g. "Your story deserves
  to be told with authenticity, artistry, and emotion..." is an H2) and there are 12 H2s but no H1 on
  `/contact/`, `/films/` or `/about-us/`; the muddy grey CTA is a **contrast** failure; the logo `alt` is
  meaningless, so a screen-reader user hears "untitled design 21".
- **Privacy/consent:** Google Tag Manager and Site Kit by Google are loaded, and I found **no consent banner or CMP**
  in the rendered DOM. Analytics cookies on the first paint without consent is a UK/EU GDPR exposure, and the site
  offers no privacy-policy link in the footer nav.

## 7. Five to eight concrete ranked improvements

1. **Delete the placeholders today (30 minutes of work, biggest credibility win).** Remove the testimonials block
   and "TRUSTED BY 0+ BRANDS" rather than leaving them empty. Replace the counter with real numbers or nothing.
2. **Add a real enquiry form** (name, email, phone, event/project date, budget band, service, message) with
   validation and spam protection, posting to email + a CRM sheet, and keep WhatsApp as a secondary CTA. Add a
   proper `hello@atrproduction.com`-style address on the domain instead of Gmail.
3. **Fix the leaked staging domain** - rewrite all `mistyrose-lobster-739747.hostingersite.com` references in the
   Elementor/CSS to the live domain, and add a canonical + 301 for the staging host so it cannot be indexed.
4. **Cut page weight by ~70%.** Ship AVIF/WebP at 3-4 widths with correct `sizes`, add `width`/`height` everywhere
   (or an aspect-ratio wrapper), convert the 160 KB of inline CSS to one cached stylesheet, drop unused font
   families to **two** (e.g. one display serif + one sans), self-host and preload the two used weights, and lazy-load
   everything below the fold with a real `IntersectionObserver` + `<noscript>` fallback.
5. **Redo the hero video and the music.** Offer MP4 (H.264) **and** WebM sources with correct `type` values plus a
   poster frame; replace the streamed commercial track with licensed production music or silence, and if the music
   stays, add a clear opt-in toggle with `preload="none"` (never autoplay audio).
6. **Unify the brand.** One name, one lockup, one Instagram handle in the header/footer (others can live in a
   "Follow" row), a written strapline that is legible at 100%, and a descriptive logo `alt` ("ATR Productions").
7. **Fix the mobile overlaps and the type system.** Move the WhatsApp bubble clear of body text (bottom-right with
   a reserved gutter), give the mobile tab bar a safe-area inset, and lock a type scale so headings/paragraphs are
   consistent; fix heading levels (one H1 per page, paragraphs as `<p>`).
8. **Rebuild the contact page and metadata.** Drop the stock starfield for a real film still or a short reel loop,
   style the submit button at AA contrast, write unique 150-160 character meta descriptions and Open Graph cards per
   page, and add `LocalBusiness` schema with the studio's city, hours and service area.

## 8. Comparison sites and what to borrow

All verified reachable on 2026-09-30. HTML sizes are the raw document bytes I measured - a good proxy for how much
markup a studio site needs to ship before assets.

| Site | What it is | Measured | What to borrow |
|---|---|---|---|
| https://smugglersite.com (SMUGGLER) | Top-tier commercial/film production co | 74.6 KB HTML, 10 `<img>`, 1 `<video>` | Reel-first home: one full-bleed showreel, minimal chrome, credits listed like a filmography. Nothing else competes with the work. |
| https://parkpictures.com (Park Pictures) | Film/TV production co | 63.6 KB HTML, 10 `<video>`, 10 `loading="lazy"` | Multiple silent looping clips as the grid, each lazy-loaded - the "moving poster" portfolio ATR should copy for its films page. |
| https://biscuitfilmworks.com | Commercials production co | 38.5 KB HTML | Aggressive minimalism: almost no markup, the work loads on demand. Proof you do not need a 392 KB document. |
| https://mjz.com (MJZ) | Commercials production co | 15.6 KB HTML | A 15 KB HTML document for an industry-leading studio. Restraint reads as confidence. |
| https://www.radicalmedia.com | Global production co | 99.4 KB HTML, 52 `<img>`, 6 `<video>`, 45 lazy, 45 `srcset` | How to do a large catalogue properly: every image has `srcset` and `loading="lazy"`. This is the pattern for a real portfolio at scale. |
| https://theweddingfilmer.com | Indian wedding-film studio (direct competitor) | 1.03 MB HTML, 409 `<img>`, 180 lazy, 246 `srcset`; **Webflow** | Same market, so worth studying: film-led hero, testimonial wall with real client names, and a visible "enquire" form. Note its own weight problem - do not copy that. |
| https://www.houseontheclouds.com | Indian wedding photo/film studio | 534 KB HTML, 48 `<img>`, 27 lazy, 40 `srcset`; **Squarespace** | Editorial gallery pacing and per-wedding story pages. Shows a no-code platform is enough for this market. |
| https://josephradhik.com | Indian wedding photographer | 89.8 KB HTML; **Squarespace** | A personal-brand site that feels premium at under 90 KB. Excellent copy, one clear CTA. |

**What to borrow, in one line:** a reel-first hero, silent looping video in the portfolio grid, `srcset` + `lazy` on
every image, one restrained typeface pairing, real client names, and a single obvious enquiry path - while keeping
ATR's genuinely good photography as the star.

## 9. Tools/services/APIs and their real costs

Prices read from the vendors' own pages on **2026-09-30** (no login, no account).

| Tool | Price observed | Source |
|---|---|---|
| **Webflow** - site plans | Basic **$15/mo**, Premier **$25/mo** (annual billing, per-month figures in the page markup); plus a $39/mo tier | https://webflow.com/pricing |
| **Webflow** - workspace plans | Freelancer **$16/mo**, Core **$19/mo**, Agency **$35/mo**, Growth **$49/mo** (annual, per month) | https://webflow.com/pricing |
| **Webflow** - bandwidth add-ons | +50 GB **$20/mo** (annual) rising to +2.45 TB **$974/mo** | https://webflow.com/pricing |
| **Webflow** - certification exam | **$100 USD** | https://webflow.com/pricing |
| **Framer** | Free **$0** (no custom domain, 1 GB bandwidth); Basic **$10/mo**; Pro **$30/mo**; Enterprise custom. Extra editor **$20/mo**, content editor **$10/mo**, each extra locale **$20**, Advanced Hosting **$200** | https://www.framer.com/pricing/ |
| **Squarespace** (INR geo-pricing) | Basic **₹810/mo** (₹630/mo annual); Core **₹1,080** (₹720 annual); Advanced **₹1,530** (₹1,100 annual). 14-day free trial, no free plan; annual includes 1 year of a free domain | https://www.squarespace.com/pricing |
| **WordPress.com** | Free **$0**; Personal **$9/mo** list -> **$4/mo** billed yearly (**$2.75/mo** on a 3-year term); Premium **$18 -> $8/mo** yearly ($5.50 3-yr); Business **$40 -> $25/mo** yearly ($17.50 3-yr); Commerce **$70 -> $45/mo** yearly ($31.50 3-yr) | https://wordpress.com/pricing/ |
| **Hostinger** (the client's current host) | Website Builder **$2.99/mo** on a 48-month term (regular $11.99, renews $10.99/mo); mid tier **$3.99/mo** (regular $18.99, renews $16.99); Startup **$7.99/mo** (regular $27.99, renews $25.99). Hostinger's own FAQ says a simple small-business site costs **US$100-$500** | https://www.hostinger.com/website-builder |
| **Current stack, observed live** | WordPress 7.1.2 on **Hostinger** (LiteSpeed, PHP 8.3.33, `panel: hpanel`), Astra theme, Elementor + Spectra, LiteSpeed Cache, Smush, Site Kit by Google 1.188.0, SureRank 1.10.1, JoinChat, Swiper | Response headers + `meta generator` on https://atrproduction.com |
| Elementor Pro / Spectra Pro licence price | **UNVERIFIED** - not fetched in this pass; check elementor.com before quoting a renewal | - |
| Domain + business email | **UNVERIFIED** - no registrar/Workspace pricing fetched | - |
| WhatsApp Business Cloud API pricing (1,000 free service conversations/mo is the commonly cited figure) | **UNVERIFIED** - not fetched. The site currently uses the free `wa.me` click-to-chat link, which has no API cost | - |
| Instagram Graph API / Meta app review requirements | **UNVERIFIED** - not fetched. Assume app review is required for any automated posting/insights work | - |

Note on Webflow: the plan-name-to-price mapping above was parsed from the pricing page's
`data-yearly-price` attributes, because the page renders prices by JavaScript; the amounts are exact as published,
but confirm the plan you intend to buy on the page itself before quoting.

## 10. Market rates for a website redesign / refresh

**What I could verify (2026-09-30):**

- **Fiverr** - live gig package prices on the website-development category page were **$80, $85, $90, $95, $100,
  $105, $120, $125, $130, $145, $150, $195, $250**, and gigs shown as "From ₹8,071", "From ₹10,089", "From
  ₹25,221". Fiverr's own guidance on that page: *"a website with a basic design and limited functionality can cost
  between $175 and $1000."* Source: https://www.fiverr.com/categories/programming-tech/website-development
- **Freelancer.com** - live "Average bid" figures from the website-design job board on 2026-09-30 included fixed
  prices of **$29, $36, $97, $125, $130, $139, $141, $184, $228, $279, $287, $374, $385, $429, $441, $443, $567,
  $935, $949, $988, $993, $2,563** and hourly bids of **$7/hr, $13/hr and $19/hr**. Representative live listings:
  "Migrate Wix Portfolio to Hostinger" (avg bid **$125**), "Multisite Product Sales Setup" (**$279**), "Remodeling
  Website" (**$949**), "eCentral Marketplace - Website Redesign & SEO Project" (**$993**), "eCentral Marketplace"
  (**$443**). Source: https://www.freelancer.com/jobs/website-design/

**What I could NOT verify - UNVERIFIED, do not quote as fact:** Upwork's rate benchmarks and individual job
postings (**HTTP 403 to automated fetch**), Toptal, and agency/Clutch rate cards (**clutch.co returned HTTP 403**).
The web-search engines available on this machine were also blocked, so I could not corroborate Upwork/Toptal ranges
from secondary sources. If you need Upwork and agency numbers, a human must open
https://www.upwork.com/hire/wordpress-developers/ and https://clutch.co/website-builders in a browser and read them.

**Practical read of the verified numbers:** the global commodity market for "build me a website" is **$80-$300**
fixed (Fiverr packages, Freelancer average bids) rising to **$400-$1,000** for jobs that pair design with
migration/SEO, with **$7-$19/hr** at the bottom of the hourly market. A premium studio redesign for a real brand
does not compete on that ladder at all - which is exactly why it should be sold as art direction + conversion
outcomes, not as "a website".

## 11. Open source and template options

All figures pulled from the GitHub API on **2026-09-30**; "pushed" is the last push date.

| Repo | Stars | License | Last push | What it covers / maintained? |
|---|---|---|---|---|
| https://github.com/WordPress/WordPress | 21,445 | GPL (NOASSERTION) | 2026-09-30 | The CMS the client is already on. Very actively maintained (SVN mirror). |
| https://github.com/WordPress/wordpress-develop | 3,468 | GPL-2.0 | 2026-09-30 | Same codebase with tests; the place to read core. |
| https://github.com/elementor/elementor | 7,083 | GPL-3.0 | 2026-09-29 | The page builder currently powering the site. Active (3,945 open issues). |
| https://github.com/litespeedtech/lscache_wp | 256 | GPL-3.0 | 2026-09-29 | LiteSpeed Cache - the caching plugin already installed. Active. |
| https://github.com/WordPress/performance | 462 | GPL-2.0 | 2026-09-25 | Official WP performance modules (image/font optimisation). Active. |
| https://github.com/Yoast/wordpress-seo | 2,000 | (NOASSERTION) | 2026-09-29 | SEO plugin; alternative to the SureRank plugin in use. Active. |
| https://github.com/Automattic/jetpack | 1,848 | (NOASSERTION) | 2026-09-30 | Forms, CDN images, security for WP. Active. |
| https://github.com/GoogleChrome/lighthouse | 30,835 | Apache-2.0 | 2026-09-30 | The audit tool for the before/after numbers in step 10. Very active. |
| https://github.com/GoogleChromeLabs/squoosh | 25,970 | Apache-2.0 | 2026-09-23 | Image compression (CLI + web) for the responsive derivative pipeline. Active. |
| https://github.com/imagemin/imagemin | 5,719 | MIT | 2025-03-07 | Build-time image minification. Maintained but slower cadence. |
| https://github.com/WPTT/webfont-loader | 126 | MIT | 2024-10-14 | Self-hosts Google Fonts on WordPress (privacy + speed fix for step 8). Small but stable. |
| https://github.com/paulirish/lite-youtube-embed | 6,351 | (NOASSERTION) | 2025-11-10 | Lightweight YouTube facade - only loads the player on click. Ideal for ATR's film pages. |
| https://github.com/photoprism/photoprism | 40,258 | (NOASSERTION) | 2026-09-30 | Self-hosted photo library/AI tagging for the studio's own archive. Very active. |
| https://github.com/Piwigo/Piwigo | 3,865 | GPL-2.0 | 2026-09-24 | Self-hosted photo gallery with 200+ plugins. Active. |
| https://github.com/decaporg/decap-cms | 19,409 | MIT | 2026-09-29 | Git-based CMS: a free, fast admin for a static portfolio. Active. |
| https://github.com/TryGhost/Ghost | 55,461 | MIT | 2026-09-30 | Publishing/CMS platform with hosting options if you want to leave WP. Very active. |
| https://github.com/getgrav/grav | 15,675 | MIT | 2026-09-29 | Flat-file CMS, no database, fast for a brochure/portfolio site. Active. |
| https://github.com/withastro/astro | 62,931 | (NOASSERTION) | 2026-09-29 | Static site framework - the cheapest way to hit the speed targets. Very active. |
| https://github.com/gohugoio/hugo | 89,989 | Apache-2.0 | 2026-09-29 | Fastest static generator; good for an image-heavy portfolio with a build pipeline. |
| https://github.com/arthelokyo/astrowind | 6,002 | MIT | 2026-09-12 | Free Astro + Tailwind **marketing/portfolio template** (repo formerly under `onwidget/astrowind`). Active. |
| https://github.com/tailwindlabs/tailwindcss | 97,751 | MIT | 2026-09-25 | Utility CSS for building the component library in step 4. Very active. |
| https://github.com/plausible/analytics | 29,264 | AGPL-3.0 | 2026-09-29 | Privacy-first, cookie-free analytics - removes the consent-banner problem in step 11. Very active. |

Relevant nuance: the client's **Astra theme has no public GitHub repo** (`brainstormforce/astra` returned HTTP 404),
so the theme is distributed via wordpress.org/GPL but not developed in the open - do not assume community support.
Squarespace and Webflow are closed platforms; their "templates" are not open source.

## 12. Recommended build-vs-buy split, delivery cost, price, and risks

### Build vs buy (small team)

- **Buy:** hosting (keep **Hostinger**, already paid and performing at 42 ms cached TTFB), the CMS
  (keep WordPress + Elementor/Spectra, since the owner must be able to add shoots), fonts (two, self-hosted via
  `WPTT/webfont-loader`), spam protection, analytics. Do **not** migrate to Webflow/Framer/Squarespace for this
  client: the platforms are fine (Framer Basic **$10/mo**, Squarespace Core **₹720/mo** annual) but a migration
  throws away working hosting, existing URLs and the owner's editing familiarity for no client-facing gain.
- **Build (custom):** the design system (type scale, colour, grid, component library), the responsive image
  pipeline, the enquiry form + CRM wiring, per-page metadata/schema, and the redirect map. This is where the
  actual money and quality difference live.
- **Deliberately not now:** a headless rebuild (Astro/Payload/Directus), a booking system, multi-language. Revisit
  if they start taking paid online bookings or run destination-wedding campaigns abroad.

### Rough cost to deliver (estimates, clearly labelled as estimates)

Assumes a 2-person team (designer + WordPress builder) at India-market blended rates, and a scope of ~8-12
templates plus the fixes in section 7:

- Audit + measurement (step 1): **2-3 days**
- Art direction + component library in Figma (steps 2-4): **5-7 days**
- Asset pipeline + responsive derivatives (step 5): **2-3 days**
- Build in WordPress (step 6): **6-9 days**
- Form, CRM, WhatsApp routing (step 7): **2 days**
- Performance + SEO + accessibility + legal (steps 8-11): **4-5 days**
- Migration, redirects, launch, handover (step 12): **2-3 days**

Total **23-32 person-days**. At Freelancer-observed commodity levels ($19/hr) that is ~$3,500-$4,900; at a
specialist studio rate it is materially more. **Note: no agency or Toptal rate card could be verified (UNVERIFIED),
so treat the day-rate input as an assumption you must confirm internally.**

### Suggested price to charge

- **Phase 1 - "Credibility fix" (1 week, no redesign):** remove placeholders, add the enquiry form, fix the staging
  domain leak, correct metadata, fix the mobile overlaps, move to a domain email. Flat **$600-$900**. Highest
  return per rupee; do this first and screenshot the before/after.
- **Phase 2 - "Refresh" (the recommended engagement):** Phase 1 plus art direction, new home/films/contact
  templates, image pipeline, two-font system, accessibility and SEO pass. **$3,000-$5,000** flat, or
  **$1,200-$1,800/mo** retainer over 3 months.
- **Phase 3 - "Care plan":** monthly retainer **$150-$400/mo** for a new shoot upload, performance monitoring,
  plugin/security updates, and quarterly conversion reporting.
- **Benchmark honesty:** these prices sit well above the Fiverr/Freelancer commodity band ($80-$300) and must be
  justified with the measured before/after numbers from section 6, not with "premium design".

### Main risks

1. **Legal - music licensing (highest immediate risk).** The site streams a commercial recording (`HAUSER - Wicked
   Game`) as ambient audio. Replace with licensed production music or remove it; an unlicensed commercial master on
   a business site is exposed to a takedown or claim.
2. **Legal - image licensing.** Confirm the rights for stock used as page backgrounds (the contact-page starfield)
   and for any client work shown before publication (model/venue releases for weddings and fashion).
3. **Privacy - GDPR/UK GDPR.** Google Tag Manager and Site Kit are loaded and no consent banner was detected. Add a
   consent gate (or move to cookie-free analytics such as the self-hosted **Plausible**), publish a privacy policy,
   and note that the client's India operation also falls under the **DPDP Act 2023**. **UNVERIFIED:** I did not
   test the site from an EU IP, so the actual cookie behaviour for EU visitors was not observed.
4. **Platform/API limits.** The `wa.me` click-to-chat link has no API quota, but moving to the WhatsApp Business
   Cloud API introduces conversation pricing and template approval. Any Instagram automation needs Meta app review
   and respects rate limits - **UNVERIFIED:** exact meta/WhatsApp quotas were not fetched in this pass. **Do not
   scrape Instagram**; it breaches Meta's terms and would put the client's accounts at risk.
5. **SEO/duplicate content from the Hostinger staging domain.** `mistyrose-lobster-739747.hostingersite.com` is
   still referenced in the live CSS. If that host is indexable, the client has a duplicate-content and
   credential-leak problem. Fix, then add a canonical and a 301.
6. **Content risk - the business only has social handles, not owned data.** With no forms, all leads live inside
   WhatsApp and Instagram. Phase 1's form is also a data-ownership fix: it starts building an owned lead list.
7. **Delivery risk - Elementor dependency.** The site is 1,254 `<div>`s of builder markup; a redesign that stays in
   Elementor will inherit the same weight. Budget either a disciplined Elementor build (global styles, minimal
   nested containers) or plan the static-site escape hatch; do not half-migrate.
8. **Measurement risk.** No LCP entries were captured and there is no visible RUM. Install GA4 plus a Core Web
   Vitals field-data source before the rewrite so the "after" numbers are defensible.

---

## Sources (all accessed 2026-09-30, no login)

**Client site**
- https://atrproduction.com/ , /about-us/ , /contact/ , /portfolio/films/ , /portfolio/blogs/ ,
  /portfolio/fashion-and-editorial/ , /portfolio/brand-influencers/ , /portfolio/aerial-commercials/ ,
  /robots.txt (HTTP response headers: `Server: LiteSpeed`, `platform: hostinger`, `panel: hpanel`,
  `x-powered-by: PHP/8.3.33`, `X-LiteSpeed-Cache: hit`)

**Comparison sites**
- https://smugglersite.com/ , https://parkpictures.com/ , https://biscuitfilmworks.com/ , https://mjz.com/ ,
  https://www.radicalmedia.com/ , https://theweddingfilmer.com/ , https://www.houseontheclouds.com/ ,
  https://josephradhik.com/

**Pricing (vendor pages)**
- https://webflow.com/pricing
- https://www.framer.com/pricing/
- https://www.squarespace.com/pricing
- https://wordpress.com/pricing/
- https://www.hostinger.com/website-builder

**Market rates**
- https://www.fiverr.com/categories/programming-tech/website-development
- https://www.freelancer.com/jobs/website-design/
- UNVERIFIED / blocked to automated fetch: https://www.upwork.com/hire/wordpress-developers/ (HTTP 403),
  https://clutch.co/website-builders (HTTP 403), and the available web-search engines.

**Open source**
- GitHub REST API `https://api.github.com/repos/{owner}/{repo}` for every repository listed in section 11
  (stars, license, `pushed_at` read 2026-09-30): WordPress/WordPress, WordPress/wordpress-develop,
  elementor/elementor, litespeedtech/lscache_wp, WordPress/performance, Yoast/wordpress-seo, Automattic/jetpack,
  GoogleChrome/lighthouse, GoogleChromeLabs/squoosh, imagemin/imagemin, WPTT/webfont-loader,
  paulirish/lite-youtube-embed, photoprism/photoprism, Piwigo/Piwigo, decaporg/decap-cms, TryGhost/Ghost,
  getgrav/grav, withastro/astro, gohugoio/hugo, arthelokyo/astrowind, tailwindlabs/tailwindcss,
  plausible/analytics. `brainstormforce/astra` returned **HTTP 404** (no public repo).
