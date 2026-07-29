# Automated Blog Writer — System Plan

**Repo:** https://github.com/911it/Auto-Blog-Writer · **Stack:** Fastify `/api/*` + Next.js + BullMQ/Redis + Postgres/Prisma (already scaffolded)
**Decisions locked:** DataForSEO as the paid data backbone · approval queue at launch · Octane (911it.com) is the first publish target, mapped live on 2026-07-21.

---

## 1. What this system is

A multi-tenant platform that makes companies show up in AI search results (ChatGPT, Gemini, Perplexity, Google AI Overviews/AI Mode). For each **Company → Location → Vertical** pair it runs a weekly forever-loop: research the company and its site, measure live AI visibility, find and rank the gaps keeping it from being cited, write genuinely valuable SEO+AEO blog articles to fill the top gaps, queue them for one-tap approval, publish and schedule them across the week — then re-measure and do it again, forever.

Two truths from the research shape everything:

1. **AI engines cite passages, not pages.** Structure (answer blocks, question-shaped headings, tables, FAQ, JSON-LD) and real data (numbers, specifics) are the levers. The 911it Semrush baseline shows the informational topic layer (HIPAA ~887K AI volume, Managed IT ~308K) is wide open — even the competitors have ≤1 mention each there. That's where blogs win.
2. **Local recommendation prompts ("best MSP in Utah") are decided off-page** — Reddit, Cloudtango, Clutch, directories, reviews. Blogs alone can't win those, so gap analysis also emits a ranked **off-page task list** per tenant (get listed on X, pursue reviews on Y). Execution is human; detection, prioritization and tracking are ours.

## 2. The weekly forever-loop (per tenant)

```
┌─► [1] INGEST      crawl site + sitemap.xml (auto-discover; ask if missing), robots/AI-crawler
│                   audit, build coverage map (what questions each URL answers)
│   [2] RESEARCH    AI-research company profile from URL + verticals + locations; refresh
│                   only what changed (first run: full onboarding research)
│   [3] MEASURE     LIVE visibility: run the prompt universe through DataForSEO
│                   (LLM Mentions/Responses, SERP+AI Overviews, PAA) — who is cited, is
│                   tenant present; stamp liveFetchedAt on every result
│   [4] GAP BRAIN   diff demand + fan-out sub-queries + live visibility against the coverage
│                   map → typed gaps → score → ranked backlog per (location × vertical)
│                   + off-page task list (sources citing competitors but not tenant)
│   [5] WRITE       top-N gaps (per caps): grounding pass → outline → draft → self-critique,
│                   customized by company profile + location + vertical profile
│   [6] QA GATES    structure, fan-out coverage, information gain, fact integrity,
│                   dedupe (embeddings), voice, entity clarity — fail = fix or drop
│   [7] APPROVE     review queue (mobile-friendly): approve / edit / reject per article
│   [8] PUBLISH     adapter pushes approved articles, scheduled across the following week
│                   (staggered days/times); freshness pass re-updates stale cornerstone posts
│   [9] LEARN       next week's [3] re-measures; movement feeds back into [4] scoring
└────────────────────────────────────────────────────────────────────── repeat weekly
```

Any gap still open next week re-enters the backlog; new gaps (new competitors cited, new demand, seasonal/event triggers) join it. The loop never templates: every article is driven by that pair's own live demand + gap data, which is also what keeps it on the right side of Google's scaled-content-abuse enforcement.

## 3. Gap analysis (the brain)

**Five gap types**, in priority order:
1. **Visibility gap** — prompts where competitors are cited, tenant absent (headline metric; from LLM Mentions + live LLM responses).
2. **Fan-out gap** — sub-queries behind a target prompt no page answers (engines decompose questions into 8 variant types; we generate the sub-query set per prompt with the LLM and diff it against the coverage map).
3. **Coverage gap** — real buyer questions (PAA, keyword demand, vertical topic map) the site doesn't address at all.
4. **Structural gap** — the page exists but isn't extractable (no answer block, no schema, weak hierarchy) → *rewrite/refresh* task, often higher ROI than a new post.
5. **Authority/access gap** — off-page (missing from cited sources) or technical (AI crawlers blocked). 911it audit: crawlers unblocked ✅, but zero presence on Reddit/Cloudtango/Clutch where "best MSP" answers are built → off-page tasks.

**Scoring:** `demand × buyer_intent × business_relevance × competitive_weakness × winnability`, then a timeliness multiplier for event triggers (breach/regulatory/seasonal/EOL feeds — Phase 6). `winnability` and `business_relevance` are the anti-slop guardrails: we don't chase topics the tenant can't credibly answer better.

**The live-results rule (hard):** every gap decision traces to data fetched *during that run* — DataForSEO live endpoints for LLM responses/SERP, `liveFetchedAt` stamped on every `GapAnalysis` row, enforced in code (a run that would reuse a previous run's visibility data fails loudly). Slow-moving reference data (monthly keyword volume, the topic taxonomy) may be cached with explicit TTLs since it isn't "results" — but citation/visibility/SERP evidence is always live.

## 4. Content contract (every generated article)

- **Slug:** descriptive, question/entity-based; **H1:** the buyer's actual question.
- **Answer block:** first paragraph, 40–60 words, self-contained, contains ≥1 concrete number.
- **4–6 question-shaped H2s** mapped to fan-out sub-queries; sequential hierarchy; atomic 2–4-line paragraphs; isolated bolded data lines; declarative "fact layer" closers.
- **Comparison table** where genuinely comparative; numbered lists for procedures.
- **FAQ section** (4–8 real PAA/fan-out questions, 40–60-word answers) mirrored verbatim in `FAQPage` JSON-LD.
- **JSON-LD:** `BlogPosting` + `FAQPage` + `LocalBusiness` (exact NAP) when location-scoped + `author` with credentials — Octane's per-page Schema tab / WP head injection.
- **E-E-A-T:** real author + bio, visible published/updated dates. (Today's 911it articles have neither JSON-LD nor bylines — immediate lift available.)
- **Grounding:** company differentiators, real pricing ranges, real SLAs/certifications/case results captured at onboarding. **Never invent specifics** — unknown facts become flagged placeholders for human fill-in.
- **Localization is earned:** a location-scoped article must carry something genuinely local (state reg, local scenario, areas served) — never city-name swaps. Per-pair gap data produces this naturally.

## 5. Publishing adapters

Pluggable `PublishTarget` interface: `createDraft(article) → schedule(datetime) → verifyLive(url) → updateExisting(url, article)`.

**Octane (first, mapped live):** DynamiX platform at octane.site. Admin is an SPA over an internal JSON API (`POST /inputs/update` saves fields; `GET /page/{id}/schema/get`; auth via session cookie). Flow: Add Entry → title + auto-slug (`blog/…`) → Article type → Full Width Content section with **raw HTML editing** (semantic h2/tables/FAQ markup accepted — verified) → SEO Toolbox (meta title/description with length validation, per-page **custom JSON-LD**) → Publisher (status + publish datetime, site timezone America/Denver). Adapter = Playwright driving this flow headlessly on the worker; login is behind Cloudflare Turnstile, so the adapter reuses a **persistent authenticated session** (cookie jar refreshed on a long TTL; if a session ever dies, the system raises a "re-login needed" task for a human instead of fighting the CAPTCHA — CAPTCHAs are never automated). Category assignment + preview-image upload included. Where the internal API proves stable we call it directly with the session cookie instead of UI-driving — faster and less brittle; the UI path stays as fallback.

**WordPress (second):** REST API `POST /wp/v2/posts` with `status=future` + `date` for native scheduling, application-password auth, Rank Math/Yoast meta or head-injection for JSON-LD. Covers most future tenants.

Per-tenant credentials: encrypted at rest (libsodium sealed box; key outside the DB), never in logs or the repo.

## 6. Approval queue & guardrails

- Weekly run produces a **batch review page** (Next.js, mobile-friendly): article cards with rendered preview, gap it fills, evidence (live citations it's targeting), QA-gate results; **Approve / Edit / Reject** per card, "approve all" once trusted.
- Approved → auto-scheduled across the following week (staggered days + randomized windows). Rejected → reason feeds back into scoring/generation.
- **Hard caps** per tenant/week (default: 5 net-new articles per location×vertical, configurable, ramped up only with proven indexation) + embedding-dedupe across the tenant's site *and* the current batch + kill switch. Later: per-tenant auto-approve above a quality threshold with sampled human review.
- Notifications: email (and later SMS/push) when a batch is ready.

## 7. Measurement loop

Weekly `VisibilitySnapshot` per (location × vertical): share of voice vs named competitors, per-topic presence, per-article citation status, mirroring the Semrush AI Visibility report as the baseline (911it = 0 across the board, competitors 20–29). Movement (or 90 days of none) adjusts `winnability` and reprioritizes: more of what's working, refresh what decayed (recency bias is real — visible "last updated" + scheduled refreshes), escalate off-page tasks where content alone isn't moving local prompts.

## 8. Data model additions (Prisma)

Existing: `Company`, `Location`, `Vertical`, `GapAnalysis`, `BlogPost`, `PublishTarget`.
Add: `SitePage` (coverage map: URL, topics, questions answered, structure score, schema present), `PromptUniverse` / `TrackedPrompt` (per pair, seeded from topic map + demand), `GapItem` (typed, scored, status: open→drafted→approved→published→verified), `ArticleDraft` (structured output: title/meta/slug/body_html/faqs/schema_jsonld/internal_links, QA results), `ReviewBatch` + decisions, `OffPageTask`, `VisibilitySnapshot`, `PublishJob` (schedule + verify state), `TopicMap` (versioned per industry; MSP taxonomy seeds v1), `DataFetchLog` (provider, cost, liveFetchedAt — enforces the live rule and tracks spend).

## 9. Build phases

| Phase | Delivers | Proof |
|---|---|---|
| **1. Ingestion + profiles** | Sitemap discovery (robots→common paths→index expansion→crawl→ask user), AI-crawler audit, coverage map; onboarding research jobs (company/vertical/location profiles from live site + web research) | 911it fully ingested & profiled |
| **2. Gap engine v1** | Prompt universe, DataForSEO integration (live), fan-out generation, typed gaps, scoring, per-pair backlog + off-page tasks | Ranked backlog for 911it that visibly matches/extends the Semrush report |
| **3. Content engine + QA** | Grounding→outline→draft→critique pipeline, full content contract, QA gates, dedupe | 3–5 articles for 911it's top gaps that pass every gate |
| **4. Approval + Octane publishing** | Review UI, Octane Playwright adapter (draft→schedule→verify), staggered calendar | Approved article live on 911it.com with schema, scheduled correctly |
| **5. The loop + measurement** | Weekly BullMQ repeatable per tenant, VisibilitySnapshots, feedback into scoring, freshness refreshes, caps + kill switch | Two consecutive autonomous weekly cycles on 911it end-to-end |
| **6. Scale-out** | WordPress adapter, event/trigger feeds (CISA KEV, Federal Register, EOL, seasonal calendar), second tenant, auto-approve thresholds, cost dashboards | Second company onboarded without code changes |

Each phase lands as PRs on `main` with tests; CLAUDE.md tracks phase state.

## 10. Costs (order of magnitude, single tenant)

DataForSEO pay-as-you-go ~$20–60/mo at weekly cadence (live LLM responses are the dear part; demand data is fractions of a cent) · OpenRouter ~$10–40/mo for research+generation+QA · infra already owned. Scales roughly linearly per tenant; `DataFetchLog` gives per-tenant cost visibility from day one.

## 11. Honest expectations & risks

- **Timeline:** structure/schema changes show citation movement in ~30–90 days; local recommendation prompts need the off-page work and 3–6 months. Competitors' positions (executech: 111 mentions) were built over months.
- **Octane brittleness:** UI changes can break the adapter → verify-after-publish step, screenshot-on-failure, alerting, and the internal-API path as primary with UI fallback.
- **Enforcement risk:** mitigated by caps, per-article genuine value, dedupe, approval gate — volume is an output, never a target.
- **Prompt-volume blind spot:** DataForSEO covers demand + citations well; if we later want conversational prompt volumes, add Profound/amplerank (~$99/mo) — not needed for v1.

## 12. Addendum (2026-07-21) — Topic Graph & retrieval density

New input: Qual IT (visibility 24, **+71 in the Semrush report — the fastest riser**) publishes near-daily across breaking IT news, vendor updates, security alerts; Executech runs a knowledge hub (case studies, webinars, verticals). The working theory — **AI retrieval density**: every distinct question answered is another retrieval candidate at chunk level. Correct, and it matches how retrieval actually works.

**What changes in this plan:**

1. **The Gap Brain's output is no longer a weekly top-N list — it's a persistent per-tenant Topic Graph.** Phase 2 builds the *complete* question universe per (location × vertical) from the master MSP knowledge graph (services × stacks × frameworks × funnel stages × locality — realistically 500–2,000 questions per tenant), each node scored and statused: `unanswered / answered_weak / answered_strong / competitor_owned / stale`. The headline product metric becomes **answer coverage %** — "what % of the questions my buyers ask an AI do we answer better than anyone" — with the weekly loop draining the graph in priority order and re-scoring it against live visibility data.
2. **The news/event trigger engine moves up** (from Phase 6 into Phase 5): Qual IT's breadth comes substantially from timely vendor/security news coverage, which is fresh by definition, high-winnability, and inherently un-templated. Feeds: CISA KEV, vendor lifecycle/EOL, Patch Tuesday, Federal Register, Google News/GDELT per vertical.
3. **The master MSP knowledge graph becomes explicit reusable IP** — versioned, instantiated per tenant, growing as tenants are added. New tenants start with high-quality coverage maps on day one.

**Where I push back on the research:** density ≠ raw volume. A 1,000-topic roadmap executed at maximum speed is exactly the profile Google's scaled-content-abuse enforcement deindexes — and a deindexed site loses AI retrieval too. Qual IT's pace is a risk they're absorbing, not a best practice to copy blindly. Also, Executech's lead isn't only density: 49 of their citations come from their own domain but the rest ride Reddit/Cloudtango/Clutch/directories — off-page still decides the local recommendation prompts. So: the Topic Graph sets the *destination* (full coverage), the capped weekly cadence with QA gates sets the *safe speed*, and the off-page engine remains co-equal. Coverage % will climb for months — that's fine; it compounds, and the approval-queue trust ramp lets us raise the cap as indexation proves out.
