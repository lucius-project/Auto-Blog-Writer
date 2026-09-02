import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { QUEUES } from "@abw/shared";
import { prisma } from "../lib/prisma.js";
import { getQueue } from "../lib/queues.js";
import { encryptSecret } from "../lib/secrets.js";

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
    if (!connection) return { connected: false };
    const snapshot = await prisma.analyticsSnapshot.findFirst({
      where: { companyId },
      orderBy: { capturedAt: "desc" },
    });
    const summary = (snapshot?.summary as any) ?? null;
    return {
      connected: true,
      propertyId: connection.propertyId,
      lastSyncedAt: connection.lastSyncedAt,
      lastSyncError: connection.lastSyncError,
      totals: summary ? { totalUsers: summary.totalUsers, totalSessions: summary.totalSessions } : null,
      trend: summary?.trend ?? [],
      topPages: summary?.topPages ?? [],
      liveFetchedAt: snapshot?.liveFetchedAt ?? null,
    };
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
