# Automated Blog Writer - Project Instructions

Context for all Claude Code agents working in this repository.

---

## What Is This Project?

**Automated Blog Writer** is a multi-tenant SaaS platform (DataStream Networks org) that:

1. **Researches** a company from its URL using AI: company size, services, what makes it unique, differentiators, brand voice — plus each vertical and how company + location + vertical tie together.
2. **Analyzes ranking gaps**: pulls AI-search analytics and SERP data to see which companies are ranking for the tenant's space and identifies why the tenant is not ranking or could rank better.
3. **Writes blogs** with AI to fill those gaps — fully SEO- and AEO-optimized so both search engines and AI assistants can find and cite them.
4. **Publishes** approved posts to the tenant's website.

**Tenancy model**: Company → Locations → Verticals. Content is customized by company size, location, vertical, and the company's unique traits.

**Repo URL**: https://github.com/911it/Auto-Blog-Writer

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript 5 (strict), Node 20+ |
| API | Fastify 5 — **all endpoints under `/api/*`** |
| Frontend | Next.js 15 (App Router), React 19, Tailwind 4 (CSS-first `@theme {}`) |
| Jobs | BullMQ 5 + Redis 7 — all async/AI work |
| Database | PostgreSQL 16 + Prisma 6 (schema at `prisma/schema.prisma`, repo root) |
| Validation | Zod (schemas shared in `@abw/shared`) |
| AI | OpenRouter (research, gap reasoning, blog writing — OpenAI-compatible API) |
| Dev infra | Docker Compose runs the FULL stack (web/api/worker/Postgres/Redis, restart: unless-stopped). One host-side helper stays outside Docker: `npm run octane:login-agent` (opens the headed Octane login window on Connect Octane clicks via redis — containers have no display). Hot-reload dev: stop app containers, run `npm run dev:*` on host. |
| Monorepo | npm workspaces: `apps/*`, `packages/*` |

---

## Hard Constraints (DO NOT VIOLATE)

| Constraint | Why |
|------------|-----|
| Gap analysis uses **LIVE results only** — no cached SERP/AI-analytics data, ever; stamp `GapAnalysis.liveFetchedAt` from the actual fetch | Stale rankings produce wrong gaps; freshness is a core product promise |
| All backend HTTP routes are Fastify under `/api/*` — no Next.js API routes | Single API surface, per project decision |
| All AI/research/publish work runs in BullMQ jobs, never inline in a request handler | Long-running work must not block HTTP |
| Every tenant-data query scopes by `companyId` | Multi-tenant isolation |
| Generated posts must ship the full SEO+AEO contract (below) | The product's entire value |
| Posts publish only from `approved` status | Human approval gate |
| Dev ports: web **3100**, api **3101**, postgres **55433**, redis **63790** | 3000-3002, 5173-5174, 6379, 55432, 8080 are taken by other 911it stacks on this box |
| Queue names/payloads come from `@abw/shared` — never hardcode strings | API and worker must stay in lockstep |

---

## SEO + AEO Output Contract (every generated post)

- Meta title (≤60 chars) + meta description (≤155 chars)
- Single H1; logical H2/H3 hierarchy; kebab-case slug
- Direct-answer opening paragraph (quotable by AI search)
- FAQ section with concise Q/A pairs
- schema.org JSON-LD: `Article` + `FAQPage` (+ `LocalBusiness` when a location applies)
- Target-query coverage from the gap analysis; internal link suggestions
- Customized to company size, location, vertical, and differentiators from the research profile

---

## Pipeline (BullMQ queues, defined in `@abw/shared`)

```
research-company  →  analyze-gaps  →  generate-blog  →  publish-blog
 (Company.profile)   (GapAnalysis,     (BlogPost as      (WordPress/webhook,
                      LIVE data only)   draft)            approved only)
```

Enqueue via `POST /api/jobs/:queue` with the zod-validated payload.

---

## Project Structure

```
apps/
  web/       Next.js frontend (port 3100)
  api/       Fastify API — /api/* (port 3101)
  worker/    BullMQ processors (the 4 pipeline stages)
packages/
  shared/    Queue names, zod job payloads, shared API input schemas
prisma/      schema.prisma (Company, Location, Vertical, GapAnalysis,
             BlogPost, PublishTarget)
```

---

## Commands

```bash
npm install                 # root — installs all workspaces
docker compose up -d        # Postgres (55433) + Redis (63790)
cp .env.example .env        # then fill in keys
npm run db:migrate          # prisma migrate dev (also generates client)
npm run dev:api             # Fastify on :3101
npm run dev:worker          # BullMQ workers
npm run dev:web             # Next.js on :3100
npm run typecheck           # all workspaces
```

---

## Current State (all phases implemented, 2026-07-21)

- **Phase 1** Ingestion + research: sitemap auto-discovery, AI-crawler audit, LLM coverage map (`SitePage`), grounded company/vertical profiles. Proven live on 911it.com (379 urls, 40 classified).
- **Phase 2** Gap engine: per-tenant Topic Graph (`TopicNode`, 92 nodes for 911 IT), coverage matching, live DataForSEO SERP/AI-Overview probes (`liveFetchedAt` enforced), scoring, off-page task detection, `VisibilitySnapshot` (baseline coverage 1.1%).
- **Phase 3** Content engine: grounding -> draft -> self-critique -> QA gates -> repair loop. First article passed all gates (1,800 words, answer block, FAQ + JSON-LD).
- **Phase 4** Review queue (web `/` dashboard + `/review/[companyId]`), approve/reject API, publishers: Octane Playwright adapter (`apps/worker/src/publishers/octane.ts`) + WordPress REST adapter.
- **Phase 5** Weekly forever-loop (`weekly-run` queue, BullMQ job scheduler, Mon 06:00 America/Denver registered for 911 IT), caps + kill switch via `Company.settings`, freshness staling at 90 days.
- **Phase 6** Event feeds (CISA KEV + endoflife.date -> news topics), auto-approve path (off by default), `DataFetchLog` spend ledger.

**Pending human steps:** one-time Octane login `DISPLAY=:0 npx tsx apps/worker/scripts/octane-login.ts` (Cloudflare Turnstile; saves `secrets/octane-state.json`).

DataForSEO account verification is complete as of 2026-08-22 — live SERP/AI-Overview probes are working.
