import type { Job } from "bullmq";
import { SyncAnalyticsPayload } from "@abw/shared";
import { prisma } from "../lib/prisma.js";
import { decryptSecret } from "../lib/secrets.js";
import { fetchAnalyticsSummary } from "../lib/ga4Client.js";
import { fetchSearchConsoleSummary, listSites } from "../lib/gscClient.js";

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
      const path = new URL(p.publishedUrl!).pathname;
      // a CMS placeholder like /?p=123 would claim the homepage's traffic
      if (path !== "/") byPath.set(path, { id: p.id, title: p.title });
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

  // Search Console (optional — same service-account key, different property)
  let gscQueries = 0;
  if (connection.gscSiteUrl) {
    const saJson = decryptSecret(String(cfg.serviceAccountKey ?? ""));
    let siteUrl = connection.gscSiteUrl;
    // self-heal: if the configured property doesn't match what the service
    // account actually has access to (domain vs URL-prefix mix-ups are common),
    // switch to the granted one — preferring the closest match, then any.
    try {
      const sites = await listSites(saJson);
      if (sites.length && !sites.some((s) => s.siteUrl === siteUrl)) {
        const host = siteUrl.replace(/^sc-domain:|^https?:\/\/|\/.*$/g, "").replace(/^www\./, "");
        const pick = sites.find((s) => s.siteUrl.includes(host)) ?? sites[0]!;
        siteUrl = pick.siteUrl;
        await prisma.analyticsConnection.update({ where: { id: connection.id }, data: { gscSiteUrl: siteUrl } });
        console.log(`[sync-analytics] GSC property auto-resolved to ${siteUrl}`);
      } else if (!sites.length) {
        throw new Error(`the service account (${JSON.parse(saJson).client_email}) is not a user on any Search Console property yet — add it in Search Console → Settings → Users and permissions`);
      }
    } catch (e: any) {
      // listSites failing (e.g. API just enabled, propagation delay) shouldn't
      // block the primary fetch attempt below — only surface if that also fails
      if (/is not a user on any/.test(e?.message ?? "")) {
        await prisma.analyticsConnection.update({ where: { id: connection.id }, data: { gscLastSyncError: String(e.message).slice(0, 500) } });
        console.warn(`[sync-analytics] ${connection.companyId}: ${e.message}`);
        console.log(`[sync-analytics] ${connection.companyId}: ${summary.totalUsers} users, ${topPages.length} matched pages, 0 GSC queries`);
        return { status: "ok", totalUsers: summary.totalUsers, matchedPages: topPages.length, gscQueries: 0 };
      }
    }
    try {
      const gsc = await fetchSearchConsoleSummary(siteUrl, saJson, connection.companyId, 28);
      const topPagesGsc = gsc.topPagesRaw
        .map((row) => {
          try { const m = byPath.get(new URL(row.page).pathname); return m ? { ...row, blogPostId: m.id, title: m.title } : { ...row, blogPostId: null, title: null }; }
          catch { return { ...row, blogPostId: null, title: null }; }
        });
      await prisma.searchConsoleSnapshot.create({
        data: {
          companyId: connection.companyId,
          rangeDays: 28,
          summary: {
            totals: gsc.totals, prevTotals: gsc.prevTotals,
            trend: gsc.trend, topQueries: gsc.topQueries, topPages: topPagesGsc,
            queryPages: gsc.queryPages,
          } as any,
          liveFetchedAt: new Date(gsc.liveFetchedAt),
        },
      });
      await prisma.analyticsConnection.update({
        where: { id: connection.id },
        data: { gscLastSyncedAt: new Date(), gscLastSyncError: null },
      });
      gscQueries = gsc.topQueries.length;
    } catch (e: any) {
      console.warn(`[sync-analytics] ${connection.companyId}: GSC fetch failed — ${e?.message}`);
      await prisma.analyticsConnection.update({
        where: { id: connection.id },
        data: { gscLastSyncError: String(e?.message ?? "unknown error").slice(0, 500) },
      });
    }
  }

  console.log(`[sync-analytics] ${connection.companyId}: ${summary.totalUsers} users, ${topPages.length} matched pages, ${gscQueries} GSC queries`);
  return { status: "ok", totalUsers: summary.totalUsers, matchedPages: topPages.length, gscQueries };
}
