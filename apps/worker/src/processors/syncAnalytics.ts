import type { Job } from "bullmq";
import { SyncAnalyticsPayload } from "@abw/shared";
import { prisma } from "../lib/prisma.js";
import { decryptSecret } from "../lib/secrets.js";
import { fetchAnalyticsSummary } from "../lib/ga4Client.js";

/**
 * Pull a rolling 30-day GA4 report for a tenant: site-wide daily trend +
 * per-post leaderboard. A provider hiccup is soft-failed onto the connection
 * (lastSyncError) rather than crashing the job, same as DataForSEO calls in
 * analyzeGaps.ts.
 */
export async function syncAnalytics(job: Job) {
  const payload = SyncAnalyticsPayload.parse(job.data);
  const connection = await prisma.analyticsConnection.findUnique({ where: { companyId: payload.companyId } });
  if (!connection) {
    console.log(`[sync-analytics] ${payload.companyId}: no connection — skipping`);
    return { status: "noop" };
  }

  const cfg = connection.config as any;
  let summary;
  try {
    const serviceAccountJson = decryptSecret(String(cfg.serviceAccountKey ?? ""));
    summary = await fetchAnalyticsSummary(connection.propertyId, serviceAccountJson, connection.companyId, 30);
  } catch (e: any) {
    console.warn(`[sync-analytics] ${connection.companyId}: fetch failed — ${e?.message}`);
    await prisma.analyticsConnection.update({
      where: { id: connection.id },
      data: { lastSyncError: String(e?.message ?? "unknown error").slice(0, 500) },
    });
    return { status: "error", detail: e?.message };
  }

  const posts = await prisma.blogPost.findMany({
    where: { companyId: connection.companyId, publishedUrl: { not: null } },
    select: { id: true, title: true, publishedUrl: true },
  });
  const byPath = new Map<string, { id: string; title: string }>();
  for (const p of posts) {
    try {
      byPath.set(new URL(p.publishedUrl!).pathname, { id: p.id, title: p.title });
    } catch { /* malformed publishedUrl — skip */ }
  }

  const topPages = summary.topPagesRaw
    .map((row) => {
      const match = byPath.get(row.path);
      return match ? { path: row.path, blogPostId: match.id, title: match.title, users: row.users, sessions: row.sessions } : null;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  await prisma.analyticsSnapshot.create({
    data: {
      companyId: connection.companyId,
      rangeDays: 30,
      summary: { totalUsers: summary.totalUsers, totalSessions: summary.totalSessions, trend: summary.trend, topPages } as any,
      liveFetchedAt: new Date(summary.liveFetchedAt),
    },
  });
  await prisma.analyticsConnection.update({
    where: { id: connection.id },
    data: { lastSyncedAt: new Date(), lastSyncError: null },
  });

  console.log(`[sync-analytics] ${connection.companyId}: ${summary.totalUsers} users, ${topPages.length} matched pages`);
  return { status: "ok", totalUsers: summary.totalUsers, matchedPages: topPages.length };
}
