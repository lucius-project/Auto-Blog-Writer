import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { QUEUES, checklistScore, type ChecklistItem } from "@abw/shared";
import { prisma } from "../lib/prisma.js";
import { getQueue } from "../lib/queues.js";

type Manual = Record<string, { done: boolean; at: string }>;

/** Website SEO/AEO checklist: latest automated run merged with the owner's manual ticks. */
export async function checklistRoutes(app: FastifyInstance) {
  app.get("/companies/:companyId/checklist", async (req) => {
    const { companyId } = req.params as { companyId: string };
    const row = await prisma.websiteChecklist.findUnique({ where: { companyId } });
    const manual = (row?.manual ?? {}) as Manual;
    const items = ((row?.items ?? []) as unknown as ChecklistItem[]).map((it) =>
      it.status === "manual" ? { ...it, done: manual[it.key]?.done ?? false, doneAt: manual[it.key]?.at } : it);
    return {
      status: row?.status ?? "never_run",
      error: row?.error ?? null,
      liveFetchedAt: row?.liveFetchedAt ?? null,
      score: items.length ? checklistScore(items) : null,
      items,
    };
  });

  app.post("/companies/:companyId/checklist/run", async (req, reply) => {
    const { companyId } = req.params as { companyId: string };
    const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true } });
    if (!company) return reply.code(404).send({ error: "not found" });
    await prisma.websiteChecklist.upsert({
      where: { companyId }, create: { companyId, status: "queued" }, update: { status: "queued", error: null },
    });
    await getQueue(QUEUES.websiteChecklist).add(QUEUES.websiteChecklist, { companyId });
    return reply.code(202).send({ ok: true });
  });

  const TickInput = z.object({ done: z.boolean() });
  app.patch("/companies/:companyId/checklist/:key", async (req, reply) => {
    const { companyId, key } = req.params as { companyId: string; key: string };
    const { done } = TickInput.parse(req.body);
    const row = await prisma.websiteChecklist.findUnique({ where: { companyId } });
    if (!row) return reply.code(404).send({ error: "run the checklist first" });
    const manual = { ...((row.manual ?? {}) as Manual), [key]: { done, at: new Date().toISOString() } };
    await prisma.websiteChecklist.update({ where: { companyId }, data: { manual } });
    return { ok: true };
  });
}
