import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";

const PricingInput = z.object({
  service: z.string().min(1),
  unit: z.string().min(1).default("per user/month"),
  low: z.number().min(0),
  high: z.number().min(0),
  notes: z.string().optional().nullable(),
});

/** Owner-maintained pricing ranges (the writer's only pricing source). */
export async function pricingRoutes(app: FastifyInstance) {
  app.get("/companies/:companyId/pricing", async (req) => {
    const { companyId } = req.params as { companyId: string };
    return prisma.pricingRange.findMany({ where: { companyId }, orderBy: { service: "asc" } });
  });

  app.post("/companies/:companyId/pricing", async (req, reply) => {
    const { companyId } = req.params as { companyId: string };
    const input = PricingInput.parse(req.body);
    const row = await prisma.pricingRange.create({ data: { ...input, companyId } });
    return reply.code(201).send(row);
  });

  app.patch("/pricing/:id", async (req) => {
    const { id } = req.params as { id: string };
    const input = PricingInput.partial().parse(req.body ?? {});
    return prisma.pricingRange.update({ where: { id }, data: input });
  });

  app.delete("/pricing/:id", async (req) => {
    const { id } = req.params as { id: string };
    await prisma.pricingRange.delete({ where: { id } });
    return { ok: true };
  });
}
