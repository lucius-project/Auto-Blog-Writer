import type { FastifyInstance } from "fastify";
import {
  CreateCompanyInput,
  CreateLocationInput,
  CreateVerticalInput,
} from "@abw/shared";
import { prisma } from "../lib/prisma.js";

export async function companyRoutes(app: FastifyInstance) {
  // NOTE: tenancy scoping. Every handler that touches tenant data takes an
  // explicit companyId and scopes all queries by it. When auth lands, the
  // companyId will be derived from the authenticated principal instead of
  // trusted from the path for cross-tenant users.

  app.get("/companies", async () => {
    return prisma.company.findMany({
      include: { locations: { include: { verticals: true } } },
      orderBy: { createdAt: "desc" },
    });
  });

  app.post("/companies", async (req, reply) => {
    const input = CreateCompanyInput.parse(req.body);
    const company = await prisma.company.create({ data: input });
    return reply.code(201).send(company);
  });

  app.get("/companies/:companyId", async (req, reply) => {
    const { companyId } = req.params as { companyId: string };
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      include: {
        locations: { include: { verticals: true } },
        publishTargets: true,
      },
    });
    if (!company) return reply.code(404).send({ error: "company not found" });
    return company;
  });

  app.post("/companies/:companyId/locations", async (req, reply) => {
    const { companyId } = req.params as { companyId: string };
    const input = CreateLocationInput.parse(req.body);
    const location = await prisma.location.create({
      data: { ...input, companyId },
    });
    return reply.code(201).send(location);
  });

  app.post(
    "/companies/:companyId/locations/:locationId/verticals",
    async (req, reply) => {
      const { companyId, locationId } = req.params as {
        companyId: string;
        locationId: string;
      };
      // scope check: location must belong to the company
      const location = await prisma.location.findFirst({
        where: { id: locationId, companyId },
      });
      if (!location) return reply.code(404).send({ error: "location not found" });

      const input = CreateVerticalInput.parse(req.body);
      const vertical = await prisma.vertical.create({
        data: { ...input, locationId },
      });
      return reply.code(201).send(vertical);
    },
  );
}

export async function scheduleRoutes(app: FastifyInstance) {
  // Enable the weekly forever-loop for a tenant (Mon 06:00 site time)
  app.post("/companies/:companyId/schedule", async (req, reply) => {
    const { companyId } = req.params as { companyId: string };
    const { cron, tz } = (req.body ?? {}) as { cron?: string; tz?: string };
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) return reply.code(404).send({ error: "company not found" });
    const { getQueue, QUEUES } = await import("../lib/queues.js");
    await getQueue(QUEUES.weeklyRun).upsertJobScheduler(
      `weekly-${companyId}`,
      { pattern: cron ?? "0 6 * * 1", tz: tz ?? "America/Denver" },
      { name: QUEUES.weeklyRun, data: { companyId } },
    );
    return { ok: true, schedule: cron ?? "0 6 * * 1", tz: tz ?? "America/Denver" };
  });

  app.delete("/companies/:companyId/schedule", async (req) => {
    const { companyId } = req.params as { companyId: string };
    const { getQueue, QUEUES } = await import("../lib/queues.js");
    await getQueue(QUEUES.weeklyRun).removeJobScheduler(`weekly-${companyId}`);
    return { ok: true };
  });
}
