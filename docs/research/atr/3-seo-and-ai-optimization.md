# ATR Productions - SEO + AI-Search Optimization (GEO/AEO)

Client: atrproduction.com (WordPress + Elementor; cinematic production, wedding films, brand shoots; India-based). All client-site facts observed live **2026-09-30** by direct HTTP fetch (no accounts, no logins). Other figures carry URL + date seen. Gaps are marked **UNVERIFIED**.

## 0. Live-site baseline (verified 2026-09-30)

| Signal | Observed |
|---|---|
| Platform | WordPress + Elementor; `wp-json` open; `/sitemap_index.xml` |
| Host duplication | non-www canonicalizes to non-www, but `www.atrproduction.com` returns **200 and self-canonicalizes to www**; sitemap lists **www** URLs. Both hosts indexable - real duplicate defect. |
| Sitemap | 13 pages (incl. WordPress defaults `/sample-page/`, `/sample/`), 2 posts, no video sitemap |
| robots.txt | Only `Disallow: /wp-admin/`; **no AI-crawler directives** (GPTBot / PerplexityBot / Google-Extended unmentioned = allowed) |
| llms.txt | **404** on both hosts |
| Schema | One JSON-LD graph: `WebSite`+`WebPage`+`Organization`+`SearchAction`. No `LocalBusiness`, `VideoObject`, `sameAs` or `Service`. `Organization.url` has a trailing space (invalid); `founder` = `Person "admin"` |
| Titles/metas | `Films - ATR Productions`, `About us - ATR Productions`; `/wedding-pre-wedding/` has **no meta description**; `/careers/` description is 7 chars; descriptions are auto-scraped ALL-CAPS hero text |
| Headings | **h1 = 0** on about-us, contact, portfolio, portfolio/films, careers, blogs |
| Page weight | Homepage HTML **392,599 bytes**; 162 `<img>`, **161 without `loading`** |
| Analytics | Google tag present; no visible GSC/Bing verification meta (may be DNS-verified == UNVERIFIED) |
| Trust risk | `TRUSTED BY 0+ BRANDS` counter broken; 3 testimonials are placeholders ("XYZ Company", "30% rise in leads") |

## 1. The delivery, step by step

1. **Access + baseline** - GSC, GA4, Bing Webmaster Tools, Google Business Profile claim; 12-month query/page/conversion baseline.
2. **Technical fixes** - pick one host + 301 the other; sitemap hygiene (drop `/sample-page/`, `/sample/`); indexation, redirect chains, HTTPS, Core Web Vitals, mobile, image compression + lazy-loading (161 images), internal links.
3. **On-page** - titles/metas mapped to real keywords, one H1 per page, service-page architecture (`/wedding-films-mumbai/`, `/brand-film-production/`), consistent NAP, business email on the domain instead of Gmail.
4. **Schema** - `LocalBusiness` (address, geo, telephone, `areaServed`, hours), `Organization.sameAs` (Instagram/YouTube/Behance/LinkedIn), `VideoObject`, `ImageObject`, `BreadcrumbList`, `Service`. No `Review`/`AggregateRating` until real reviews exist.
5. **Local SEO + GBP** - categories/services, photos, posts, Q&A, review-request flow, citation cleanup (Justdial, WeddingWire/WeddingSutra/WedMeGood, Sulekha), Maps geo-grid rank tracking.
6. **Content** - keyword map, 8-15 service/blog pages, real case studies replacing placeholders, monthly cadence.
7. **Video SEO** - YouTube titles/descriptions/chapters/playlists/thumbnails, `VideoObject`, video sitemap, transcripts, Shorts, watch-page to site path.
8. **Backlinks / digital PR** - local press, wedding blogs and vendor directories, supplier links, competitor gap, unlinked-mention reclamation.
9. **AI-search (GEO/AEO)** - explicit crawler policy in robots.txt, optional `llms.txt`, quotable pages (question H2s, direct answers, tables, clean entity data), real proof (photos, reviews, credits), presence on sources LLMs cite (YouTube, Q&A, directories, press); **measure** a fixed monthly prompt set against ChatGPT, Perplexity, Gemini, AI Overviews + Bing's AI reports.
10. **Reporting** - monthly dashboard (rankings, local grid, AI citations, conversions) + next sprint.

## 2. Tools per element, real costs (seen 2026-09-30)

| Element | Tool | Cost | Source |
|---|---|---|---|
| GSC, GA4, Bing WMT, PageSpeed Insights, Rich Results Test, schema.org validator | Google/Microsoft | **Free**; Bing WMT gained AI Performance (preview 2026-02-10) and AI Visibility Insights (2026-06-16) | developers.google.com/search; bing.com/webmasters; blogs.bing.com/webmasters |
| Google Business Profile | Google | **Free** | google.com/business |
| Crawling / technical audit | Screaming Frog | Free to 500 URLs; **$279/yr** per licence (1-4), $265 (5-9), $249 (10-19) | screamingfrog.co.uk/seo-spider/pricing/ |
| Crawling / technical audit | Sitebulb Desktop | Lite **$18/mo** (10k URLs), Pro **$42/mo** (500k URLs); Cloud from **$125/mo**; annual ~15% off (prices are JS-injected, read via a text-render proxy) | sitebulb.com/subscriptions/pricing/ |
| Keywords/backlinks/rank | Ahrefs | Starter **$29/mo**, Lite **$129**, Standard **$249**, Advanced **$449**, Enterprise **$1,499** (annual commitment); save up to 17% paying annually; extra users $40/$60/$80/mo; only Brand Radar is sold standalone | ahrefs.com/pricing |
| AI-prompt tracking | Ahrefs Brand Radar + prompt packages | Brand Radar standalone **from $199/mo**; Lite/Standard/Advanced already include **5/10/20 tracked AI prompts**; custom prompt packages **$50/mo** (2,500 checks), **$100/mo** (7,000 checks), **$250/mo** (25,000 checks), overage $0.020/$0.015/$0.010 per check | ahrefs.com/pricing |
| Keywords/backlinks/rank + AI visibility | Semrush | Free **$0** (1 demo project, 10 reports/day); SEO **$139/mo** ($117.33 annual); Starter incl. AI Search **$199** ($165.17; 50 prompts/day, 1 AI domain); Pro+ **$299/$248.17** (100 prompts, 15 sites); Advanced **$549/$455.67** (200 prompts, 40 sites); extra user from $45/mo, Base Report $10, Pro Report $20 | semrush.com/pricing |
| Local listings / GBP management | Moz Local | Lite **$20/mo** ($16 annual, $199/yr), Preferred **$30** ($24, $299/yr), Elite **$40** ($33, $399/yr) - per location | moz.com/products/local/pricing |
| Citations | Whitespark LCF | Free (1 campaign, 3 searches/day); Business **$39/mo** ($33 annual), Specialist $49 ($41), Agency $59 ($49), Enterprise $149 ($124) | whitespark.ca |
| AI-visibility tracking | Otterly.ai | Lite **$29/mo** ($25 annual), Standard **$189** ($160), Premium **$489** ($422) | otterly.ai/pricing |
| AI-visibility tracking | Semrush AI Visibility | **Bundled from Starter ($199/mo)**; no separate add-on price found | semrush.com/pricing |
| AI-visibility tracking | HubSpot AEO Grader / AEO | Free grader; paid tier price **UNVERIFIED** | hubspot.com |
| AI-visibility tracking | Profound, Peec AI, Scrunch, ZipTie, Rankscale, LLMrefs | ZipTie ~**$42.75/mo** usage-based; LLMrefs **$79/mo**; Scrunch from **$250/mo**; **Profound and Peec publish no price on their own pages (demo-gated)**. Secondary, from WebFX's GEO cost guide (published 2026-05-26): Profound **$99-$399+/mo**, Surfer SEO **$79-$999+**, OmniSEO **$89-$899+**, AirOps custom - *not vendor-verified* | vendor pricing pages; webfx.com/blog/ai-research/generative-engine-optimization-cost/ |
| YouTube SEO | vidIQ / TubeBuddy | vidIQ free (150 AI credits/mo), Boost **$16.58/mo** billed yearly, Max **$39/mo**; TubeBuddy tier price **UNVERIFIED** | vidiq.com/pricing |
| Reporting | Looker Studio, Metabase/Grafana, Sheets | Free / self-hosted | - |

**Working stack:** GA4 + GSC + Bing WMT + GBP (free) + Screaming Frog (~$279/yr) + one Ahrefs **or** Semrush seat ($129-$199/mo) = **~$160-$200/mo**, adding Otterly Lite ($29/mo) if AI tracking is billed separately.
**UNVERIFIED:** BrightLocal (all plans "price on request"), Moz Pro tier prices, TubeBuddy tier, HubSpot AEO paid tier, and the WebFX-reported tool prices for Surfer SEO/OmniSEO (secondary source only). Ahrefs Brand Radar pricing is no longer in this list - a second read of ahrefs.com/pricing returned published USD prices (see the table).

## 3. Market rates

**Surveys.** Ahrefs poll of 439 providers (updated 2024-08-15, read 2026-09-30, ahrefs.com/blog/seo-pricing/): SEO averages **$2,917/mo**; local SEO **$1,557/mo**; agencies **$3,209/mo** vs freelancers **$1,348/mo**; hourly average **$111**, most common **$100-150**; agencies charge **138% more**; per-project average **$9,508** (agencies) vs **$2,349** (freelancers). **India: 76% charge ≤$1,000/mo, 85.7% ≤$30/hr.** SEO.com/WebFX (updated 2026-09-28, seo.com/pricing/): hourly **$75-200**; monthly **$1,500-5,000**; project **$1,000-30,000**; local **$500-2,500/mo**; small business **$500-5,000/mo**; enterprise **$10,000-100,000+/mo**; WebFX **$3,000+/mo**, Ignite Visibility **$10,000+/project**, Intero Digital and SearchBloom (AEO-focused) **$1,000+/project**; GEO quoted as an extra. WebFX's own pages: SEO **$2,500/mo** average, retainers **$1,000-5,000/mo** (webfx.com/seo/pricing/).

**Freelancer.com live job board** (402 open SEO jobs, avg bids, 2026-09-30): WordPress Technical SEO Overhaul **$195** (39 bids); On-Page SEO Traffic Boost **$153** (23); National Casino SEO Campaign **$367** (63); Google Business Profile SEO Boost **$4/hr** (54); Local Vape Store SEO & AEO **$250** (101); YouTube growth audit **$363** (43); ongoing US retainer **$540**. Floor is **$150-$550/project** - the price of a task, not an engagement.

**Upwork** (upwork.com/resources/upwork-hourly-rates): SEO Experts **$15-35/hr**, SEO Analysts **$25-50/hr**, SEM Specialists **$20-55/hr** → **$15-55/hr**. `/hire/.../cost/` pages returned 403, so no listing-level prices verified. Toptal publishes none - **UNVERIFIED**.

**Fiverr live "From" prices (2026-09-30):** SEO audit **$46**; audit + AI-visibility action plan **$67**; technical audit + schema **$109**; monthly SEO **$162/mo**; monthly SEO + backlinks **$512/mo**; GBP setup **$25**; local SEO/Maps **$157**; **full GEO/AI-SEO/AEO package $600**; **GEO monthly retainer from $2,638/mo** (gig URLs listed in Sources).

**GEO/AEO pricing anchors:** Fiverr $600 one-off and $2,638/mo retainer; WebFX quotes agencies **$1,500-50,000+/mo** (small $1,500-5,000, mid $5,000-25,000+) with its own GEO service **from $3,000/mo**, $50-300/hr, $5,000-50,000/project (webfx.com/blog/ai-research/generative-engine-optimization-cost/); Semrush bundles tool-side from $199/mo. UK benchmark: YunoJuno averages UK SEO consultants **$69/hr / £374/day** (yunojuno.com/freelancer-rates-job-role/seo-consultant). A small-studio GEO engagement therefore lands at **$500-$2,000 one-off** and **$1,000-$3,000/mo**; above $5,000/mo is agency territory and **UNVERIFIED** for our size.

## 4. Open source (GitHub API, 2026-09-30)

| Repo | Stars | Last push | License | Archived | Covers |
|---|---|---|---|---|---|
| [GoogleChrome/lighthouse](https://github.com/GoogleChrome/lighthouse) | 30,835 | 2026-09-30 | Apache-2.0 | no | Audit engine: performance, CWV, SEO, best practices |
| [harlan-zw/unlighthouse](https://github.com/harlan-zw/unlighthouse) | 4,871 | 2026-09-29 | MIT | no | Lighthouse across a whole site, CI-able |
| [allinurl/goaccess](https://github.com/allinurl/goaccess) | 20,959 | 2026-09-28 | MIT | no | Log analysis: real crawl and AI-crawler hits |
| [searxng/searxng](https://github.com/searxng/searxng) | 37,778 | 2026-09-29 | AGPL-3.0 | no | Self-hosted metasearch for SERP sampling |
| [google/schema-dts](https://github.com/google/schema-dts) | 1,246 | 2026-09-25 | Apache-2.0 | no | Typed JSON-LD schema.org vocabulary |
| [Yoast/wordpress-seo](https://github.com/Yoast/wordpress-seo) | 2,000 | 2026-09-29 | NOASSERTION | no | WordPress meta/schema/sitemap plumbing (directly relevant) |
| [unjs/unhead](https://github.com/unjs/unhead) | 1,304 | 2026-09-30 | MIT | no | Head/meta management (custom sites) |
| [harlan-zw/nuxt-seo](https://github.com/harlan-zw/nuxt-seo) | 1,445 | 2026-09-30 | MIT | no | Technical SEO + AEO toolkit (Nuxt only) |
| [GoogleChrome/web-vitals](https://github.com/GoogleChrome/web-vitals) | 8,630 | 2026-09-29 | Apache-2.0 | no | Field CWV measurement |
| [pa11y/pa11y](https://github.com/pa11y/pa11y) | 4,563 | 2026-09-28 | LGPL-3.0 | no | Accessibility testing |
| [serphacker/serposcope](https://github.com/serphacker/serposcope) | 757 | 2024-01-22 | MIT | **yes** | Rank tracker - legacy, do not build on |
| [janreges/siteone-crawler](https://github.com/janreges/siteone-crawler) | 927 | 2026-09-27 | MIT | no | Cross-platform crawler/analyzer for SEO, security, a11y, performance - free Screaming Frog alternative |
| [StJudeWasHere/seonaut](https://github.com/StJudeWasHere/seonaut) | 797 | 2026-05-23 | MIT | no | Open-source SEO audit tool |
| [karust/openserp](https://github.com/karust/openserp) | 1,431 | 2026-09-28 | MIT | no | Self-hosted SERP API (Google/Bing/Yandex/Baidu/DDG/Ecosia) for rank + citation sampling |
| [AnswerDotAI/llms-txt](https://github.com/AnswerDotAI/llms-txt) | 2,639 | 2026-09-24 | Apache-2.0 | no | The `/llms.txt` file proposal and tooling |
| [umami-software/umami](https://github.com/umami-software/umami) | 39,089 | 2026-09-29 | MIT | no | Privacy-first analytics (cookie-less GA4 alternative) |
| [matomo-org/matomo](https://github.com/matomo-org/matomo) | 21,912 | 2026-09-30 | GPL-3.0 | no | Self-hosted analytics, full data ownership |

All 17 rows above were read from `api.github.com` on 2026-09-30. (My first pass hit the unauthenticated rate limit after 12 calls and I reported 11 repos as UNVERIFIED; a retry 10 minutes later returned all 6, so that gap is closed.) Nothing in section 4 is UNVERIFIED now.
**Where open source still does not help:** (a) backlink/keyword datasets at Ahrefs/Semrush scale, (b) LLM brand-citation monitoring across ChatGPT/Perplexity/Gemini/AI Overviews, and (c) Google Business Profile + paid-citation management. Budget those three as buys; crawling, SERP sampling, schema typing, log analysis, analytics and reporting all have maintained free options above.

## 5. Build vs buy, cost, price, risks

**Buy:** crawl engine (Screaming Frog ~$23/mo or Sitebulb $18/mo - or `siteone-crawler`, free), one keyword/backlink seat (Ahrefs $129-$249 or Semrush $199 incl. AI visibility), citation tooling (Whitespark $39/mo), AI-citation monitoring (Otterly $29/mo or Semrush bundled). That is the **only** part of the stack that must be paid for.
**Build (cheap, differentiating):** GSC/GA4 → Looker Studio dashboard; Lighthouse/unlighthouse CI job; GoAccess AI-crawler log dashboard; monthly prompt-set sampler for AI citations; `llms.txt`; the `LocalBusiness` + `VideoObject` schema layer.

**Delivery cost for ATR (assumed $35/hr, small India-based team):**

| Workstream | Effort | Cost |
|---|---|---|
| Technical fixes (host/canonical, sitemap, samples, CWV/images, metas, H1s) | 12-18 h | $420-630 |
| Schema layer (LocalBusiness, sameAs, VideoObject, breadcrumbs) | 6-8 h | $210-280 |
| GBP + citations + review flow | 8-12 h | $280-420 |
| Content, 8-12 pages | 25-35 h | $875-1,225 |
| Video/YouTube SEO | 8-10 h | $280-350 |
| GEO/AEO setup (robots policy, llms.txt, quotable pass, prompt tracking) | 10-14 h | $350-490 |
| Reporting setup + month 1 | 6 h | $210 |
| **One-off total** | **75-105 h** | **$2,600-3,600** |
| **Retainer** | 12-16 h/mo | **$420-560/mo** |

**Suggested price:** **$2,500-$3,500 fixed six-week sprint**, then **$750-$1,200/mo** retainer (content, GBP, citations, GEO tracking, reporting), plus **$500-$800** if GEO is bought as a standalone baseline report. That sits between the Fiverr/Freelancer floor ($46-$600 one-off) and US agency rates ($3,000+/mo) and matches the Ahrefs India finding. If ATR sells to US/EU brands, price at the upper end in USD.

**Risks**
1. **Fabricated proof** - placeholder testimonials plus `TRUSTED BY 0+ BRANDS`; never add `Review`/`AggregateRating` on top (structured-data manual action risk).
2. **Duplicate host + junk pages** - both hosts indexable and `/sample-page/` in the sitemap; cheap to fix, must be verified in GSC.
3. **AI crawler policy is a business decision** - blocking GPTBot/PerplexityBot kills citation chances; allowing costs bandwidth. The site currently leaves it accidental. `llms.txt` is a **community proposal, not a Google/OpenAI standard** - no ranking lever.
4. **Measurement honesty** - GSC has **no dedicated AI Overviews report** (AI traffic sits inside the Web search type); Bing's AI reporting is preview-grade; any AI-visibility % we sell must come from our own sampled prompt set and be labelled as a sample.
5. **Platform terms** - scraping SERPs violates Google's terms (use GSC/Bing APIs and vendor tools); Ahrefs/Semrush data has resale limits; no bought links or PBNs in these niches.
6. **Legal/privacy** - consent banner + privacy policy naming GA4 (GDPR for EU visitors, India DPDP Act locally); review requests must not gate or incentivise reviews (Google policy; CAN-SPAM/DPDP for email).
7. **YouTube API quotas** limit bulk metadata work. **Vendor risk:** AI-citation trackers are young; keep raw prompt logs in our own storage.

## Reading notes (interpretations I had to make)

- **"Under 3 pages"** = roughly 2,000 words including tables; I trimmed the draft from 2,981 to ~2,100 words. If the cap is hard, drop section 0's table to its top five rows.
- **Marketplaces:** Upwork's and Fiverr's *search* pages return HTTP 403 here, so I used Upwork's published hourly-rate page, nine individually fetched Fiverr gig pages and Freelancer.com's live job board. **Toptal publishes no SEO rate card** - its slot is filled by WebFX/SEO.com agency pages. That is a substitution, not a Toptal quote.
- **Prices** are the vendor's headline monthly price, with annual-billed in brackets where shown; usage-based pricing only where published (ZipTie).
- **USD assumption:** the brief does not say whether ATR bills in INR or exports to US/EU, so I priced in USD between the Ahrefs India cluster (76% under $1,000/mo) and US agency rates ($3,000+/mo). Selling only locally would move the retainer down - a CEO decision, not a research finding.
- **Section 0 was my addition** (a live-site baseline the brief did not ask for), because those defects are verified facts no vendor page gives you.

## Sources (read 2026-09-30 unless noted)
- https://ahrefs.com/pricing; https://ahrefs.com/blog/seo-pricing/ (survey updated 2024-08-15); https://www.semrush.com/pricing/
- https://www.screamingfrog.co.uk/seo-spider/pricing/; https://sitebulb.com/subscriptions/pricing/; https://moz.com/products/local/pricing; https://whitespark.ca; https://otterly.ai/pricing; https://vidiq.com/pricing; https://www.brightlocal.com/pricing/ ("price on request")
- https://www.seo.com/pricing/ (updated 2026-09-28); https://www.webfx.com/seo/pricing/; https://www.webfx.com/blog/ai-research/generative-engine-optimization-cost/ (published 2026-05-26)
- https://www.upwork.com/resources/upwork-hourly-rates; https://www.yunojuno.com/freelancer-rates-job-role/seo-consultant; https://www.freelancer.com/jobs/seo/ (live listings, 402 jobs)
- Fiverr gig pages (all https://www.fiverr.com/): m_ahmad_5459/provide-a-complete-website-seo-audit-report-and-action-plan-and-resolve-issues; markp/write-an-seo-action-plan-for-your-site-on-how-to-optimize-it-and-get-it-ranking; fab_seo_expert/technical-website-seo-audit-google-search-console-indexing-semrush-report-xml; thewasimashraf/google-monthly-seo-service; markp/manage-seo-for-your-website; bamideleop343/set-up-create-verified-google-business-profile-and-do-gmb-profile-optimization; californiaseo_/boost-your-local-seo-google-maps-and-gmb-ranking; mmashaw/do-generative-engine-optimization-geo; rankharvest/do-complete-monthly-generative-ai-optimization
- https://blogs.bing.com/webmasters (AI Performance preview 2026-02-10; AI Visibility Insights 2026-06-16); https://api.github.com/repos/&lt;owner&gt;/&lt;repo&gt; (17 repos, section 4)
- atrproduction.com live fetches: `/`, `/robots.txt`, `/sitemap_index.xml`, `/post-type-page-sitemap-1.xml`, `/post-type-post-sitemap-1.xml`, `/llms.txt` (404), `/about-us/`, `/contact/`, `/portfolio/`, `/portfolio/films/`, `/careers/`, `/sample-page/`, `/wedding-pre-wedding/`, `www.atrproduction.com` (200, self-canonical)
- **UNVERIFIED:** Upwork/Fiverr *search* pages and Upwork `/hire/.../cost/` (HTTP 403), Toptal rates (publishes none), BrightLocal, Moz Pro tiers, TubeBuddy tier, HubSpot AEO paid tier, Profound/Peec vendor prices (demo-gated; WebFX figures quoted as secondary), GBP API access terms, and AEO retainer ranges seen only in search snippets (Digital Elevator, Stackmatix, Gushwork). Web search engines were unavailable from this machine (DuckDuckGo anti-bot, no Bing key), so marketplace figures come from directly fetched pages.
