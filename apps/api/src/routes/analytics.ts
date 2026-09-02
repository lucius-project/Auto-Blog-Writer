import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { QUEUES } from "@abw/shared";
import { prisma } from "../lib/prisma.js";
import { getQueue } from "../lib/queues.js";
import { encryptSecret, decryptSecret } from "../lib/secrets.js";

/**
 * GA4 analytics: connect a property (service-account auth), read the latest
 * rolling-window snapshot (total visitors, trend, per-post leaderboard), and
 * trigger syncs. The actual GA4 API call only ever happens in the worker
 * (sync-analytics queue) — these routes just read/write Postgres and enqueue.
 */
export async function analyticsRoutes(app: FastifyInstance) {
  app.get("/companies/:companyId/analytics", async (req) => {
    const { companyId } = req.params as { companyId: string };
    const connection = await prisma.analyticsConnection.findUnique({ where: { companyId } });
    if (!connection) return { connected: false, search: { connected: false } };
    const [snapshot, gscSnaps, pubPosts] = await Promise.all([
      prisma.analyticsSnapshot.findFirst({ where: { companyId }, orderBy: { capturedAt: "desc" } }),
      prisma.searchConsoleSnapshot.findMany({ where: { companyId }, orderBy: { capturedAt: "desc" }, take: 26 }),
      prisma.blogPost.findMany({ where: { companyId, publishedUrl: { not: null } }, select: { id: true, title: true, publishedUrl: true } }),
    ]);
    const summary = (snapshot?.summary as any) ?? null;

    // path -> published blog post, for attaching an action to each GSC page
    const postByPath = new Map<string, { id: string; title: string }>();
    for (const p of pubPosts) { try { postByPath.set(new URL(p.publishedUrl!).pathname, { id: p.id, title: p.title }); } catch { /* skip */ } }
    const pageInfo = (url: string) => {
      try { const path = new URL(url).pathname; return { path, ...(postByPath.get(path) ?? { id: null as string | null, title: null as string | null }) }; }
      catch { return { path: url, id: null, title: null }; }
    };

    // Search Console block
    const latestGsc = (gscSnaps[0]?.summary as any) ?? null;
    const queries = (latestGsc?.topQueries ?? []) as any[];
    const queryPages = (latestGsc?.queryPages ?? []) as any[];
    const movers = [...queries].filter((q) => q.positionDelta != null && Math.abs(q.positionDelta) >= 0.8);

    // ---- Ranking opportunities (actionable buckets) ----
    // rough organic CTR-by-position benchmark
    const expectedCtr = (pos: number) =>
      pos <= 1 ? 0.28 : pos <= 2 ? 0.15 : pos <= 3 ? 0.10 : pos <= 4 ? 0.075 : pos <= 5 ? 0.06 : pos <= 7 ? 0.04 : pos <= 10 ? 0.025 : 0.012;
    const bestPageForQuery = new Map<string, any>();
    for (const r of queryPages) {
      const cur = bestPageForQuery.get(r.query);
      if (!cur || r.impressions > cur.impressions) bestPageForQuery.set(r.query, r);
    }
    // (a) CTR fixes: rank well, far below expected clicks -> rewrite title/meta
    const ctrByPage = new Map<string, { page: string; queries: string[]; impressions: number; clicks: number; position: number }>();
    for (const r of queryPages) {
      if (r.position > 8 || r.impressions < 15) continue;
      if (r.ctr >= expectedCtr(r.position) * 0.45) continue;
      const e = ctrByPage.get(r.page) ?? { page: r.page, queries: [] as string[], impressions: 0, clicks: 0, position: 0 };
      e.queries.push(r.query);
      e.impressions += r.impressions;
      e.clicks += r.clicks;
      e.position = e.position ? Math.min(e.position, r.position) : r.position;
      ctrByPage.set(r.page, e);
    }
    const ctrFixes = [...ctrByPage.values()]
      .sort((a, b) => b.impressions - a.impressions).slice(0, 12)
      .map((e) => ({ ...e, queries: e.queries.slice(0, 5), missedClicks: Math.round(e.impressions * expectedCtr(e.position) - e.clicks), ...pageInfo(e.page) }));
    // (b) striking distance: pos 8-20, one page away from page 1
    const strikingDistance = queries
      .filter((q) => q.position >= 8 && q.position <= 20)
      .sort((a, b) => b.impressions - a.impressions).slice(0, 15)
      .map((q) => ({ query: q.query, position: q.position, impressions: q.impressions, clicks: q.clicks, positionDelta: q.positionDelta, losing: q.positionDelta != null && q.positionDelta < -1, ...pageInfo(bestPageForQuery.get(q.query)?.page ?? "") }));
    // (c) collapses: dropped hard, still has demand
    const drops = queries
      .filter((q) => q.positionDelta != null && q.positionDelta <= -8 && q.impressions >= 5)
      .sort((a, b) => a.positionDelta - b.positionDelta).slice(0, 12)
      .map((q) => ({ query: q.query, position: q.position, impressions: q.impressions, positionDelta: q.positionDelta, ...pageInfo(bestPageForQuery.get(q.query)?.page ?? "") }));
    let serviceAccountEmail: string | null = null;
    try { serviceAccountEmail = JSON.parse(decryptSecret(String((connection.config as any)?.serviceAccountKey ?? ""))).client_email ?? null; } catch { /* ignore */ }
    const search = connection.gscSiteUrl ? {
      connected: true,
      siteUrl: connection.gscSiteUrl,
      serviceAccountEmail,
      lastSyncedAt: connection.gscLastSyncedAt,
      lastSyncError: connection.gscLastSyncError,
      liveFetchedAt: gscSnaps[0]?.liveFetchedAt ?? null,
      totals: latestGsc?.totals ?? null,
      prevTotals: latestGsc?.prevTotals ?? null,
      // 90-day daily position/click trend from the newest snapshot
      dailyTrend: latestGsc?.trend ?? [],
      // avg position at each sync, oldest -> newest (longer-horizon view)
      positionHistory: [...gscSnaps].reverse().map((s) => ({
        at: s.capturedAt,
        position: (s.summary as any)?.totals?.position ?? null,
        clicks: (s.summary as any)?.totals?.clicks ?? null,
        impressions: (s.summary as any)?.totals?.impressions ?? null,
      })),
      topQueries: queries.slice(0, 50),
      improved: movers.filter((q) => q.positionDelta > 0).sort((a, b) => b.positionDelta - a.positionDelta).slice(0, 10),
      declined: movers.filter((q) => q.positionDelta < 0).sort((a, b) => a.positionDelta - b.positionDelta).slice(0, 10),
      topPages: latestGsc?.topPages ?? [],
      opportunities: latestGsc ? { ctrFixes, strikingDistance, drops } : null,
    } : { connected: false, serviceAccountEmail };

    return {
      connected: true,
      propertyId: connection.propertyId,
      lastSyncedAt: connection.lastSyncedAt,
      lastSyncError: connection.lastSyncError,
      totals: summary ? { totalUsers: summary.totalUsers, totalSessions: summary.totalSessions } : null,
      trend: summary?.trend ?? [],
      topPages: summary?.topPages ?? [],
      liveFetchedAt: snapshot?.liveFetchedAt ?? null,
      search,
    };
  });

  // Connect / update the Search Console property (reuses the GA4 service-account key)
  const GscInput = z.object({ siteUrl: z.string().min(4) });
  app.post("/companies/:companyId/analytics/gsc", async (req, reply) => {
    const { companyId } = req.params as { companyId: string };
    const { siteUrl } = GscInput.parse(req.body);
    const connection = await prisma.analyticsConnection.findUnique({ where: { companyId } });
    if (!connection) return reply.code(400).send({ error: "connect GA4 first — Search Console reuses the same service-account key" });
    // accept "sc-domain:example.com" or a full "https://example.com/" URL
    const normalized = /^sc-domain:/.test(siteUrl) ? siteUrl : (siteUrl.startsWith("http") ? siteUrl : `sc-domain:${siteUrl.replace(/^www\./, "")}`);
    await prisma.analyticsConnection.update({
      where: { companyId }, data: { gscSiteUrl: normalized, gscLastSyncError: null },
    });
    await getQueue(QUEUES.syncAnalytics).add(QUEUES.syncAnalytics, { companyId });
    return reply.code(201).send({ ok: true, siteUrl: normalized });
  });

  app.delete("/companies/:companyId/analytics/gsc", async (req) => {
    const { companyId } = req.params as { companyId: string };
    await prisma.analyticsConnection.updateMany({
      where: { companyId }, data: { gscSiteUrl: null, gscLastSyncedAt: null, gscLastSyncError: null },
    });
    return { ok: true };
  });

  /**
   * Competitor visibility: aggregate the live SERP/AI-Overview evidence stored
   * on TopicNodes by the last gap check into a scoreboard (you vs each domain),
   * a trend from VisibilitySnapshot history, and the specific buyer questions
   * where a competitor is cited and you are not.
   */
  app.get("/companies/:companyId/competitor-visibility", async (req) => {
    const { companyId } = req.params as { companyId: string };
    const [company, listed, nodes, snapshots] = await Promise.all([
      prisma.company.findUnique({ where: { id: companyId }, select: { url: true } }),
      prisma.competitor.findMany({ where: { companyId }, select: { domain: true, label: true } }),
      prisma.topicNode.findMany({
        where: { companyId },
        select: { id: true, question: true, score: true, funnelStage: true, category: true, status: true, blogPostId: true, evidence: true },
      }),
      prisma.visibilitySnapshot.findMany({
        where: { companyId, verticalId: null },
        orderBy: { capturedAt: "asc" },
        select: { capturedAt: true, summary: true },
      }),
    ]);

    const tenant = company ? new URL(company.url).hostname.replace(/^www\./, "") : "";
    const listedSet = new Set(listed.map((c) => c.domain.replace(/^www\./, "")));

    // scoreboard from current evidence
    const presence = new Map<string, { organic: number; ai: number }>();
    const bump = (d: string, kind: "organic" | "ai") => {
      if (!d || d === tenant) return;
      const cur = presence.get(d) ?? { organic: 0, ai: 0 };
      cur[kind]++;
      presence.set(d, cur);
    };
    let tenantOrganic = 0, tenantAi = 0, probed = 0;
    let lastProbeAt: string | null = null;
    const headToHead: any[] = [];
    for (const n of nodes) {
      const e = n.evidence as any;
      if (!e || (!Array.isArray(e.organicDomains) && !Array.isArray(e.aiOverviewDomains))) continue;
      probed++;
      if (e.liveFetchedAt && (!lastProbeAt || e.liveFetchedAt > lastProbeAt)) lastProbeAt = e.liveFetchedAt;
      for (const d of new Set<string>(e.organicDomains ?? [])) bump(d, "organic");
      for (const d of new Set<string>(e.aiOverviewDomains ?? [])) bump(d, "ai");
      if (e.tenantInOrganicTop10) tenantOrganic++;
      if (e.tenantInAiOverview) tenantAi++;

      const competitorsHere: string[] = [
        ...new Set<string>([...(e.aiOverviewDomains ?? []), ...(e.organicDomains ?? [])]),
      ].filter((d) => d && d !== tenant);
      const tenantPresent = e.tenantInAiOverview || e.tenantInOrganicTop10;
      if (!tenantPresent && competitorsHere.length) {
        headToHead.push({
          topicNodeId: n.id, question: n.question, score: n.score ?? 0,
          funnelStage: n.funnelStage, category: n.category,
          hasBlogPost: !!n.blogPostId, status: n.status,
          inAiOverview: (e.aiOverviewDomains ?? []).filter((d: string) => d && d !== tenant),
          listedCompetitors: competitorsHere.filter((d) => listedSet.has(d)),
          competitors: competitorsHere.slice(0, 6),
        });
      }
    }

    const rate = (v: number) => (probed ? Math.round((v / probed) * 100) : 0);
    const scoreboard = [...presence.entries()]
      .map(([domain, s]) => ({
        domain, organic: s.organic, ai: s.ai,
        organicRate: rate(s.organic), aiRate: rate(s.ai),
        isListed: listedSet.has(domain),
        label: listed.find((c) => c.domain.replace(/^www\./, "") === domain)?.label ?? null,
      }))
      .sort((a, b) => (b.ai * 2 + b.organic) - (a.ai * 2 + a.organic))
      .slice(0, 15);

    headToHead.sort((a, b) => {
      // listed competitors first, then by opportunity score
      const la = a.listedCompetitors.length ? 1 : 0, lb = b.listedCompetitors.length ? 1 : 0;
      return lb - la || b.score - a.score;
    });

    // trend from snapshot history (only snapshots that carry the visibility block)
    const trend = snapshots
      .map((s) => {
        const v = (s.summary as any)?.visibility;
        if (!v?.tenant) return null;
        const topComp = (v.competitors ?? [])[0];
        const topListed = (v.competitors ?? []).find((c: any) => c.isListed);
        return {
          at: s.capturedAt,
          tenantAiRate: v.tenant.aiRate ?? 0,
          tenantOrganicRate: v.tenant.organicRate ?? 0,
          topCompetitorAiRate: (topListed ?? topComp)?.aiRate ?? 0,
          topCompetitorDomain: (topListed ?? topComp)?.domain ?? null,
        };
      })
      .filter(Boolean);

    return {
      tenant,
      probed,
      lastProbeAt,
      listedCompetitors: listed.map((c) => ({ ...c, domain: c.domain.replace(/^www\./, "") })),
      you: { organic: tenantOrganic, ai: tenantAi, organicRate: rate(tenantOrganic), aiRate: rate(tenantAi) },
      scoreboard,
      headToHead: headToHead.slice(0, 20),
      trend,
    };
  });

  const ConnectionInput = z.object({
    propertyId: z.string().min(1),
    serviceAccountKey: z.string().min(1),
  });
  app.post("/companies/:companyId/analytics/connection", async (req, reply) => {
    const { companyId } = req.params as { companyId: string };
    const input = ConnectionInput.parse(req.body);
    let parsed: any;
    try {
      parsed = JSON.parse(input.serviceAccountKey);
    } catch {
      return reply.code(400).send({ error: "serviceAccountKey must be valid JSON" });
    }
    if (!parsed.client_email || !parsed.private_key) {
      return reply.code(400).send({ error: "serviceAccountKey JSON must include client_email and private_key" });
    }
    const config = { serviceAccountKey: encryptSecret(input.serviceAccountKey) };
    await prisma.analyticsConnection.upsert({
      where: { companyId },
      create: { companyId, propertyId: input.propertyId, config },
      update: { propertyId: input.propertyId, config, lastSyncError: null },
    });
    await getQueue(QUEUES.syncAnalytics).add(QUEUES.syncAnalytics, { companyId });
    await getQueue(QUEUES.syncAnalytics).upsertJobScheduler(
      `ga4-sync-${companyId}`,
      { pattern: "0 5 * * *", tz: "America/Denver" },
      { name: QUEUES.syncAnalytics, data: { companyId } },
    );
    return reply.code(201).send({ ok: true, propertyId: input.propertyId });
  });

  app.delete("/companies/:companyId/analytics/connection", async (req) => {
    const { companyId } = req.params as { companyId: string };
    await getQueue(QUEUES.syncAnalytics).removeJobScheduler(`ga4-sync-${companyId}`);
    await prisma.analyticsConnection.deleteMany({ where: { companyId } });
    return { ok: true };
  });

  app.post("/companies/:companyId/analytics/sync", async (req, reply) => {
    const { companyId } = req.params as { companyId: string };
    const connection = await prisma.analyticsConnection.findUnique({ where: { companyId } });
    if (!connection) return reply.code(404).send({ error: "no GA4 connection for this company" });
    await getQueue(QUEUES.syncAnalytics).add(QUEUES.syncAnalytics, { companyId });
    return { ok: true };
  });
}
