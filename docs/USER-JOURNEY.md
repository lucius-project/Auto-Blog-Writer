# The User Journey — Automated Blog Writer

The complete story of how an owner uses the system, mapped to what exists in
the product. Every step below is clickable in the UI today unless marked
ROADMAP.

## Story 1 — Onboard a new company (5 minutes of typing, then automatic)

1. **Dashboard → "+ Add company"** — name + website. The system immediately:
   crawls the site (sitemap auto-discovery, AI-crawler audit), builds the
   coverage map, and researches the company profile (services,
   differentiators, brand voice, proof points) — grounded only in what the
   site actually says.
2. **Manage → Settings → Locations & verticals** — add each office
   (city/state) and the industries served at each, one chip at a time. Each
   vertical is a REAL industry (dental ≠ healthcare ≠ construction): each
   gets its own researched profile, its own buyer questions, its own
   articles. Click **"Research new additions"** — profiles and
   industry-specific topic questions build in minutes.
3. **Settings → Pricing ranges** — pre-filled with industry averages;
   overwrite with the company's real ranges (always ranges). The writer may
   only use these numbers for pricing claims.
4. **Settings → Testimonial book** — upload the PDF. Every testimonial is
   extracted individually and tagged (industry, services, keywords) so each
   article automatically pulls the 3-4 most relevant real client stories —
   deterministic search, no AI, never the whole book.
5. **Settings → Where blogs publish** — connect the CMS: Octane via the
   dashboard's "Connect Octane" human login (session kept warm by a daily
   health check), or WordPress via URL + application password (stored
   encrypted, AES-256-GCM).

## Story 2 — See where you stand

- **Dashboard**: answer-coverage % (the headline metric: what share of the
  questions buyers ask an AI do we answer better than anyone), topic counts,
  review queue size, published count, off-page targets.
- **Topic Graph tab**: every question, filterable by status, each with live
  evidence (was there an AI Overview? was the company cited? who was?).
  **Add your own question/keyword** — owner topics jump to the top priority.
- **Off-page tab**: the sources AI engines cite where the company is absent
  (Reddit, Clutch...) — human tasks blogs can't fix; mark done/dismissed.

## Story 3 — Write and schedule content (the core loop)

1. **Dashboard → Write & auto-schedule**: how many + date window.
2. Watch the two progress bars: batch-level (X of N) and per-article
   pipeline steps (grounding → draft → editor critique → QA gates →
   auto-repair → saved).
3. QA-passing, non-duplicate articles are auto-scheduled across the window —
   any day, 08:00-17:00 site time, randomized, never closer than 36-62
   minutes — and pushed immediately to the CMS's own scheduler (releases
   happen even if this system is offline). QA failures and near-duplicates
   go to the review queue instead.
4. When the batch finishes, the card lists every article with its scheduled
   date/time. **Batch history tab** keeps every run forever.
5. One-offs: "Write next blog (to review queue)" for a single article you
   want to approve manually; per-gap "Write article" buttons on the Topic
   Graph.

## Story 4 — Review, publish, verify

- **Review queue**: preview rendered articles, QA badge + failing gates,
  the gap each fills; Approve (publishes/schedules) or Reject (feeds back).
- Posts & Schedule tab: full list, per-post datetime reschedule, bulk
  scheduling with backfill (past dates publish immediately carrying the past
  date, building history — at the cost of AI freshness).
- Every publish is verified against the live site; SEO title/meta/JSON-LD
  (BlogPosting + FAQPage + LocalBusiness) go through the CMS's internal API.

## Story 5 — Let it run forever

- **Settings → Weekly automation ON**: every Monday 6 AM the loop re-crawls,
  refreshes research, pulls breaking triggers (CISA exploited vulns,
  Microsoft EOL dates), runs LIVE gap probes (never cached), re-scores the
  graph, drafts within the weekly caps to the review queue, marks aging
  content stale for refresh, and snapshots visibility so coverage-over-time
  is measurable.
- Guardrails: weekly caps, kill switch, auto-approve (off by default),
  QA gates, cross-batch dedupe, session health alerts.

## ROADMAP — BUILT (2026-07-21)

- ✅ In-place article editing in the review queue (Edit -> save re-runs QA gates).
- ✅ Review flow made explicit: approve shows WHEN it goes live (keep batch date /
  publish now / pick date & time), outcome banners replace silent disappearance,
  active-batch posts are guarded from early approval, rejected is its own status,
  failed publishes carry the error + a Retry button on Posts & Schedule.
- ✅ Notifications: in-app bell (batch done, review needed, publish failed, weekly
  run, Octane session expired) + optional Slack/Teams webhook per company.
- ✅ Trends tab: coverage %-over-time, cumulative published articles, coverage by
  industry (VisibilitySnapshot history).
- ✅ Multi-user auth: first-run owner setup at /login, scrypt-hashed passwords,
  signed session cookies, admin vs viewer (read-only) roles. Setup mode keeps the
  app open until the first account exists.
- ✅ Per-company/target Octane browser profiles: each publish target keeps its own
  session (connect + health chip in Settings), daily keepalive checks them all.
- ✅ Off-page task aids: "Draft copy for me" writes the Reddit answer / directory
  listing / outreach email (grounded in the company profile, marketing-speak
  banned), with status workflow open -> in progress -> done/dismissed.
- ✅ Structural-gap rewrites: "Rewrite & strengthen" per weak/stale topic (and a
  bulk "Rewrite 5 weakest"), regenerates in place — same slug, updates the SAME
  CMS page via Octane/WordPress update, new version passes through review.

## STILL AHEAD (nice-to-haves)

- Per-article AI-citation tracking at volume (DataForSEO LLM Mentions — cost-gated).
- Email/SMS notification channels (webhook covers Slack/Teams today).
- Structural rewrites of non-blog site pages (service/industry pages).
