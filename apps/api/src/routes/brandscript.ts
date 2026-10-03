import type { FastifyInstance } from "fastify";
import { BrandScriptInput, QUEUES } from "@abw/shared";
import { prisma } from "../lib/prisma.js";
import { getQueue } from "../lib/queues.js";

/**
 * StoryBrand BrandScripts: one per company (guide, plan, CTA) and one per
 * vertical (that industry's hero, problems, stakes). The writer reads them
 * from Company.profile.brandScript / Vertical.profile.brandScript.
 */
export async function brandScriptRoutes(app: FastifyInstance) {
  const findVertical = (companyId: string, verticalId: string) =>
    prisma.vertical.findFirst({ where: { id: verticalId, location: { companyId } } });

  app.put("/companies/:companyId/brandscript", async (req, reply) => {
    const { companyId } = req.params as { companyId: string };
    const brandScript = BrandScriptInput.parse(req.body ?? {});
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) return reply.code(404).send({ error: "not found" });
    const profile = { ...((company.profile as any) ?? {}), brandScript: { ...brandScript, editedAt: new Date().toISOString() } };
    await prisma.company.update({ where: { id: companyId }, data: { profile } });
    return { ok: true };
  });

  app.put("/companies/:companyId/verticals/:verticalId/brandscript", async (req, reply) => {
    const { companyId, verticalId } = req.params as { companyId: string; verticalId: string };
    const brandScript = BrandScriptInput.parse(req.body ?? {});
    const vertical = await findVertical(companyId, verticalId);
    if (!vertical) return reply.code(404).send({ error: "not found" });
    const profile = { ...((vertical.profile as any) ?? {}), brandScript: { ...brandScript, editedAt: new Date().toISOString() } };
    await prisma.vertical.update({ where: { id: verticalId }, data: { profile } });
    return { ok: true };
  });

  // Regenerate = drop the stored BrandScript and let research backfill it
  // (research only rebuilds missing BrandScripts, leaving profiles intact)
  app.post("/companies/:companyId/brandscript/regenerate", async (req, reply) => {
    const { companyId } = req.params as { companyId: string };
    const { verticalId } = (req.body ?? {}) as { verticalId?: string };
    if (verticalId) {
      const vertical = await findVertical(companyId, verticalId);
      if (!vertical) return reply.code(404).send({ error: "not found" });
      const { brandScript: _drop, ...rest } = (vertical.profile as any) ?? {};
      await prisma.vertical.update({ where: { id: verticalId }, data: { profile: rest } });
    } else {
      const company = await prisma.company.findUnique({ where: { id: companyId } });
      if (!company) return reply.code(404).send({ error: "not found" });
      const { brandScript: _drop, ...rest } = (company.profile as any) ?? {};
      await prisma.company.update({ where: { id: companyId }, data: { profile: rest } });
    }
    const job = await getQueue(QUEUES.researchCompany).add(QUEUES.researchCompany, { companyId });
    return { ok: true, jobId: job.id };
  });
}
