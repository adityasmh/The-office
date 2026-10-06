# Plan: two offers, one 30-day test (written 2026-10-06)

Nothing here is a revenue forecast. Every number below is either measured from this project or labelled as a hypothesis to test. The goal of the first 30 days is NOT to earn a million dollars; it is to find out whether anyone will pay, and for which of the two offers.

## The two offers

### Offer A: the autonomous fleet for people who are not AI experts
**Promise:** describe the job in plain English; a team of AI workers plans it, asks your approval, does it in a safe workspace, shows the result and what it cost. You never touch a terminal.
**Who (hypothesis, to be tested):** small teams and solo operators with repetitive digital work: agencies, solo founders, small advisory and finance shops, anyone who today pays a freelancer for small recurring tasks.
**What already exists:** planner, approval gates, guarded workers, OpenCode-first cost routing, secret scrubbing, stuck detection, auto-redo, GitHub pull-request output, dashboard, doctor and setup, demo (mock) mode.
**What is missing for non-experts (in build order):** a first-run page that explains the system in plain words and checks that it works; a plain-money monthly cost cap; a gallery of ready orders for common jobs; a one-click installer. Today it needs Node, git and the `jcode` tool, which a non-expert will not have.
**Honest weakness:** this space is crowded (Emdash, CrewCode, Commander, Software Factory and others). Our angle is cost control and safety by default, not more features.

### Offer B: the AI cost audit (the fastest path to a first dollar)
**Promise:** "Send us your LLM usage export. In a week you get a report that shows where the money goes, which calls are waste, and what changing models, retries and prompts would save, computed from your own data."
**Who (hypothesis):** startups and small teams spending real money on OpenAI, Anthropic or agent tools, where nobody owns the bill.
**What already exists:** the cost report, the routing policy and the loop guard are working examples of exactly this analysis on our own usage.
**Price (hypothesis only, to test):** a fixed fee per audit, or a share of verified savings. We learn the right number from the first conversations, not from a guess.
**Honest weakness:** an audit is a service, so it earns from your time and does not scale. Its job is to fund and teach the product.

## How the two connect
The audit finds teams with a cost problem. The fleet, with its cost caps and guards, is the thing that fixes it. Every audit is research for the product and a lead for it.

## The 30-day test
| Week | Build (what I do) | Talk (what only you can do) |
|---|---|---|
| 1 | Audit tool that reads usage exports; one-page offer; first-run page for the fleet | Write down 30 names: founders and engineers you can reach (LinkedIn, your network, communities). Decide the contact email and who gets paid |
| 2 | Run the audit tool on our own data as a case study (real, measured, no invented savings) | Send 30 short messages that offer one free audit in exchange for feedback. I draft them; you send them |
| 3 | Fix what the first pilots find; build the plain-money cost cap | Run 3 free audits. Ask each: would you pay for this, and how much? |
| 4 | Turn the best pilot into a written case study (with permission) | Try to charge 1 of the 3. Watch 5 non-experts use the fleet demo and note where they get stuck |

**Success after 30 days (what counts):** at least 3 completed pilots and at least 1 person who paid or clearly would. If none, we change the audience or the offer, not the amount of code.

## What I will not do
- I will not send messages, emails or posts on your behalf without you reading them first.
- I will not set up payments, accounts or tax details; those are yours.
- I will not invent testimonials, customer counts, savings figures or logos. Any number on a page must come from measured data.
- I will not touch other people's accounts, cookies or private data. The audit tool runs on a file the customer chooses to give you.

## Risks to check early
- **Customer data:** a usage export can reveal their business. Decide a written data-handling promise (analyse locally, delete after the report) and use an NDA when asked.
- **Your job and school:** check any employment or university agreement for rules about side businesses and IP before you charge anyone, especially with a fintech employer or the TIFIN application in play.
- **Reliability:** the fleet still fails sometimes (a worker window failed to attach once today). A paid product needs a retry path and honest status messages.