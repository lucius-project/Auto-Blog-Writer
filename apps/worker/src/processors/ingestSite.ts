import type { Job } from "bullmq";
import { IngestSitePayload } from "@abw/shared";
import { prisma } from "../lib/prisma.js";
import { chatJson } from "../lib/openrouter.js";
import {
  fetchText, auditRobots, discoverSitemaps, sitemapUrls,
  extractPage, extractLinks, structureScore, type PageLink,
} from "../lib/site.js";
import { computeLinkGraph, checkLinks } from "../lib/linkAudit.js";

/**
 * Stage 1 — Site ingestion.
 * robots/AI-crawler audit -> sitemap discovery (auto; flags needsSitemap if
 * none found) -> fetch pages -> coverage map (LLM-classified SitePage rows).
 */
export async function ingestSite(job: Job) {
  const payload = IngestSitePayload.parse(job.data);
  const company = await prisma.company.findUniqueOrThrow({ where: { id: payload.companyId } });
  const origin = new URL(company.url).origin;

  // 1. robots + AI-crawler audit
  let robotsTxt = "";
  try { robotsTxt = (await fetchText(origin + "/robots.txt")).text; } catch { /* none */ }
  const { blocked, sitemaps } = auditRobots(robotsTxt);

  // 2. sitemap discovery
  const found = await discoverSitemaps(company.url, sitemaps);
  let urls: string[] = [];
  const primarySitemap = found[0] ?? null;
  if (primarySitemap) urls = await sitemapUrls(primarySitemap);
  const needsSitemap = urls.length === 0;

  await prisma.company.update({
    where: { id: company.id },
    data: {
      sitemapUrl: primarySitemap,
      siteAudit: {
        auditedAt: new Date().toISOString(),
        aiCrawlersBlocked: blocked,
        robotsFound: robotsTxt.length > 0,
        sitemapFound: !needsSitemap,
        needsSitemap,
        totalUrls: urls.length,
      },
    },
  });
  if (needsSitemap) {
    console.warn(`[ingest-site] no sitemap found for ${company.url} — ask the user for one`);
    return { status: "needs_sitemap", companyId: company.id };
  }

  // 3. choose pages: prioritize money pages, then newest-looking blog posts
  const norm = (h: string) => h.replace(/^www\./, "");
  const host = norm(new URL(company.url).hostname);
  const sameHost = urls.filter((u) => { try { return norm(new URL(u).hostname) === host; } catch { return false; } });
  const prio = (u: string) => {
    const p = new URL(u).pathname;
    if (p === "/" ) return 0;
    if (/^\/(services|industries|service-areas|locations)\//.test(p)) return 1;
    if (/^\/(about|contact|team)/.test(p)) return 2;
    if (/^\/blog\//.test(p)) return 3;
    if (/^\/\d{4}\//.test(p)) return 4; // dated legacy posts
    return 5;
  };
  const picked = sameHost.sort((a, b) => prio(a) - prio(b)).slice(0, payload.maxPages);

  // 4. fetch + extract + classify (batched LLM calls)
  type Extracted = { url: string; path: string; ex: ReturnType<typeof extractPage>; score: number; links: PageLink[] };
  const extracted: Extracted[] = [];
  for (const url of picked) {
    if (!payload.force) {
      const existing = await prisma.sitePage.findUnique({
        where: { companyId_url: { companyId: company.id, url } },
      });
      // still re-crawl if we've never captured its link graph
      if (existing?.lastCrawledAt && existing.outboundLinks != null
        && Date.now() - existing.lastCrawledAt.getTime() < 6 * 24 * 3600e3) continue;
    }
    try {
      const { status, text } = await fetchText(url);
      if (status !== 200) continue;
      const ex = extractPage(text);
      extracted.push({ url, path: new URL(url).pathname, ex, score: structureScore(text, ex), links: extractLinks(text, url) });
    } catch { /* skip page */ }
  }

  const BATCH = 8;
  let classified = 0;
  for (let i = 0; i < extracted.length; i += BATCH) {
    const batch = extracted.slice(i, i + BATCH);
    const pagesDesc = batch.map((p, idx) =>
      `PAGE ${idx}\npath: ${p.path}\ntitle: ${p.ex.title}\nh1: ${p.ex.h1}\nheadings: ${p.ex.headings.join(" | ")}\nexcerpt: ${p.ex.textSample.slice(0, 500)}`,
    ).join("\n\n");
    const result = await chatJson<{ pages: { index: number; contentType: string; primaryTopic: string; questionsAnswered: string[]; entities: string[] }[] }>([
      { role: "system", content: "You classify website pages for an AI-search coverage map. Reply with JSON only." },
      { role: "user", content: `For each page below, return JSON {"pages":[{"index":n,"contentType":"home|service|industry|location|blog|landing|legal|other","primaryTopic":"short phrase","questionsAnswered":["buyer questions this page substantively answers, phrased as a buyer would ask an AI (max 6, empty if none)"],"entities":["named services/tools/frameworks/places (max 8)"]}]}\n\n${pagesDesc}` },
    ], { companyId: company.id, tag: "ingest-classify", maxTokens: 3000, temperature: 0.2 });
    for (const c of result.pages ?? []) {
      const p = batch[c.index];
      if (!p) continue;
      await prisma.sitePage.upsert({
        where: { companyId_url: { companyId: company.id, url: p.url } },
        create: {
          companyId: company.id, url: p.url, path: p.path,
          contentType: c.contentType, title: p.ex.title, primaryTopic: c.primaryTopic,
          questionsAnswered: c.questionsAnswered, entities: c.entities,
          hasSchema: p.ex.hasJsonLd, structureScore: p.score,
          wordCount: p.ex.wordCount, outboundLinks: p.links as any, lastCrawledAt: new Date(),
        },
        update: {
          contentType: c.contentType, title: p.ex.title, primaryTopic: c.primaryTopic,
          questionsAnswered: c.questionsAnswered, entities: c.entities,
          hasSchema: p.ex.hasJsonLd, structureScore: p.score,
          wordCount: p.ex.wordCount, outboundLinks: p.links as any, lastCrawledAt: new Date(),
        },
      });
      classified++;
    }
  }

  // 5. link graph: inbound counts + pillar flags, then HTTP health of every target
  await computeLinkGraph(company.id).catch((e) => console.warn(`[ingest-site] link graph: ${e?.message}`));
  const linkAudit = await checkLinks(company.id, { max: 600 }).catch((e) => {
    console.warn(`[ingest-site] link check: ${e?.message}`);
    return { checked: 0, broken: 0 };
  });

  console.log(`[ingest-site] ${company.name}: ${urls.length} urls, ${extracted.length} crawled, ${classified} classified, ${linkAudit.broken} broken links, blocked=[${blocked.join(",")}]`);
  return { status: "ok", companyId: company.id, totalUrls: urls.length, crawled: extracted.length, classified, brokenLinks: linkAudit.broken, aiCrawlersBlocked: blocked };
}
