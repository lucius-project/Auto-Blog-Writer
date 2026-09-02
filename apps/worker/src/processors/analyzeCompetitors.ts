import type { Job } from "bullmq";
import { AnalyzeCompetitorsPayload } from "@abw/shared";
import { prisma } from "../lib/prisma.js";
import { chatJson } from "../lib/openrouter.js";
import { fetchText, discoverSitemaps, sitemapUrls, extractPage } from "../lib/site.js";
import { seedCompetitorTopics } from "../lib/competitorTopics.js";

interface CoverageEntry {
  path: string;
  title: string;
  primaryTopic: string;
  contentType: string;
  questionsAnswered: string[];
}

/**
 * Competitor content assessment. For each operator-listed competitor domain:
 * discover its sitemap, crawl its blog/service/industry pages, and LLM-classify
 * each into the buyer questions it answers (same shape as the tenant coverage
 * map in ingestSite). Then seedCompetitorTopics diffs those against the Topic
 * Graph and seeds what the tenant is missing.
 */
export async function analyzeCompetitors(job: Job) {
  const payload = AnalyzeCompetitorsPayload.parse(job.data);
  const competitors = await prisma.competitor.findMany({
    where: {
      companyId: payload.companyId,
      ...(payload.competitorId ? { id: payload.competitorId } : {}),
    },
  });
  if (!competitors.length) return { status: "no_competitors", companyId: payload.companyId };

  const prio = (path: string): number => {
    if (/^\/(blog|resources|insights|articles|news)\//.test(path)) return 0;
    if (/^\/(services?|solutions?)\//.test(path)) return 1;
    if (/^\/(industries|verticals|who-we-serve)\//.test(path)) return 1;
    if (path === "/") return 3;
    return 4;
  };

  for (const competitor of competitors) {
    await prisma.competitor.update({ where: { id: competitor.id }, data: { status: "crawling", error: null } });
    try {
      const base = `https://${competitor.domain}`;
      const norm = (h: string) => h.replace(/^www\./, "");
      const host = norm(competitor.domain);

      let robotsSitemaps: string[] = [];
      try {
        const { text } = await fetchText(`${base}/robots.txt`, 10000);
        robotsSitemaps = text.split(/\r?\n/)
          .map((l) => l.replace(/#.*$/, "").trim())
          .filter((l) => /^sitemap\s*:/i.test(l))
          .map((l) => l.split(/:\s*/i).slice(1).join(":").trim())
          .filter(Boolean);
      } catch { /* none */ }

      const found = await discoverSitemaps(base, robotsSitemaps);
      const urls = found[0] ? await sitemapUrls(found[0]) : [];
      const sameHost = urls.filter((u) => { try { return norm(new URL(u).hostname) === host; } catch { return false; } });
      const picked = sameHost.sort((a, b) => prio(new URL(a).pathname) - prio(new URL(b).pathname))
        .slice(0, payload.maxPagesPerCompetitor);

      type Extracted = { path: string; ex: ReturnType<typeof extractPage> };
      const extracted: Extracted[] = [];
      for (const url of picked) {
        try {
          const { status, text } = await fetchText(url);
          if (status !== 200) continue;
          extracted.push({ path: new URL(url).pathname, ex: extractPage(text) });
        } catch { /* skip page */ }
      }

      const BATCH = 8;
      const coverage: CoverageEntry[] = [];
      for (let i = 0; i < extracted.length; i += BATCH) {
        const batch = extracted.slice(i, i + BATCH);
        const pagesDesc = batch.map((p, idx) =>
          `PAGE ${idx}\npath: ${p.path}\ntitle: ${p.ex.title}\nh1: ${p.ex.h1}\nheadings: ${p.ex.headings.join(" | ")}\nexcerpt: ${p.ex.textSample.slice(0, 500)}`,
        ).join("\n\n");
        const result = await chatJson<{ pages: { index: number; contentType: string; primaryTopic: string; questionsAnswered: string[] }[] }>([
          { role: "system", content: "You classify a competitor's website pages for a content-gap analysis. Reply with JSON only." },
          { role: "user", content: `For each page below, return JSON {"pages":[{"index":n,"contentType":"home|service|industry|location|blog|landing|legal|other","primaryTopic":"short phrase","questionsAnswered":["buyer questions this page substantively answers, phrased as a buyer would ask an AI (max 6, empty if none)"]}]}\n\n${pagesDesc}` },
        ], { companyId: payload.companyId, tag: "competitor-classify", maxTokens: 3000, temperature: 0.2 });
        for (const c of result.pages ?? []) {
          const p = batch[c.index];
          if (!p) continue;
          coverage.push({
            path: p.path, title: p.ex.title, primaryTopic: c.primaryTopic ?? "",
            contentType: c.contentType ?? "other", questionsAnswered: c.questionsAnswered ?? [],
          });
        }
      }

      await prisma.competitor.update({
        where: { id: competitor.id },
        data: {
          coverage: coverage as any,
          pagesCrawled: coverage.length,
          status: "ready",
          lastCrawledAt: new Date(),
          error: coverage.length ? null : "no pages could be crawled (missing sitemap or blocked)",
        },
      });
      console.log(`[analyze-competitors] ${competitor.domain}: ${urls.length} urls, ${extracted.length} crawled, ${coverage.length} classified`);
    } catch (e: any) {
      await prisma.competitor.update({
        where: { id: competitor.id },
        data: { status: "failed", error: String(e?.message ?? e).slice(0, 300), lastCrawledAt: new Date() },
      });
      console.warn(`[analyze-competitors] ${competitor.domain} failed: ${e?.message}`);
    }
  }

  let seeded = 0;
  try {
    seeded = await seedCompetitorTopics(payload.companyId);
  } catch (e: any) {
    console.warn(`[analyze-competitors] seedCompetitorTopics failed: ${e?.message}`);
  }

  return { status: "ok", companyId: payload.companyId, competitors: competitors.length, seeded };
}
