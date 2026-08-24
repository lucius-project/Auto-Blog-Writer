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
