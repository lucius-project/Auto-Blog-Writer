# Automated Blog Writer

Multi-tenant AI blog automation platform (911 IT). For each company (→ locations → verticals) it:

1. **Researches** the company from its URL with AI — size, services, differentiators, verticals, and how they tie together.
2. **Finds ranking gaps** — pulls AI-search analytics and SERP data **live (never cached)** to see who ranks and why the company doesn't or could rank better.
3. **Writes blogs** to fill those gaps — fully SEO + AEO optimized (meta, heading hierarchy, FAQ, schema.org JSON-LD) and customized per company size, location, vertical, and uniques.
4. **Publishes** approved posts to the company's website.

## Stack

Fastify 5 (`/api/*`) · Next.js 15 · BullMQ + Redis · PostgreSQL 16 + Prisma · TypeScript · npm workspaces

## Quick start

```bash
cp .env.example .env              # fill in keys
docker compose up -d --build      # FULL stack: web :3100, api :3101, worker,
                                  # Postgres :55433, Redis :63790 — auto-restarts
npm run octane:login-agent        # host-side helper: opens the Octane login
                                  # window when "Connect Octane" is clicked
                                  # (a browser window can't open from inside Docker)
```

**Backups**: the `backup` container dumps the database and archives
`secrets/` + `.env` nightly into `./backups/` (30-day retention, never
committed to git). Restore: `zcat backups/db-<stamp>.sql.gz | psql` into a
fresh DB, untar the secrets archive back into place. Copy `./backups/` to a
second location (NAS/cloud drive) for real disaster coverage — it holds keys
and sessions, so treat it as sensitive.

Dev mode (hot reload, apps on host): stop the app containers
(`docker compose stop web api worker`) then `npm install && npm run db:migrate`
and run `npm run dev:api` / `dev:worker` / `dev:web` as before.

## Layout

```
apps/web      Next.js UI
apps/api      Fastify API (/api/*)
apps/worker   BullMQ pipeline: research-company → analyze-gaps → generate-blog → publish-blog
packages/shared  queue names + zod payloads
prisma/       schema (Company → Location → Vertical, GapAnalysis, BlogPost, PublishTarget)
```

See `CLAUDE.md` for full conventions and hard constraints.
