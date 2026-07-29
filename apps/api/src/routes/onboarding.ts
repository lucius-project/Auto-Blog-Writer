import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { getQueue, QUEUES } from "../lib/queues.js";
import { encryptSecret } from "../lib/secrets.js";

/**
 * Full onboarding + tenant management: create a company (auto-starts site
 * ingestion and research), manage locations/verticals, publish targets
 * (credentials encrypted), custom topics, weekly automation.
 */
export async function onboardingRoutes(app: FastifyInstance) {
  // -- company creation with automatic onboarding chain --
  const CreateCompany = z.object({ name: z.string().min(1), url: z.string().url() });
  app.post("/onboard", async (req, reply) => {
    const input = CreateCompany.parse(req.body);
    const company = await prisma.company.create({ data: input });
    await getQueue(QUEUES.ingestSite).add(QUEUES.ingestSite, { companyId: company.id, maxPages: 60 });
    await getQueue(QUEUES.researchCompany).add(QUEUES.researchCompany, { companyId: company.id });
    return reply.code(201).send({ ...company, onboarding: "ingestion and research started" });
  });

  // -- locations & verticals management --
  app.delete("/locations/:id", async (req) => {
    const { id } = req.params as { id: string };
    await prisma.location.delete({ where: { id } });
    return { ok: true };
  });
  app.delete("/verticals/:id", async (req) => {
    const { id } = req.params as { id: string };
    await prisma.vertical.delete({ where: { id } });
    return { ok: true };
  });
  // profile a newly added vertical + refresh the graph in one click
  app.post("/companies/:companyId/refresh-research", async (req) => {
    const { companyId } = req.params as { companyId: string };
    await getQueue(QUEUES.researchCompany).add(QUEUES.researchCompany, { companyId, chainAnalyze: true });
    return { ok: true, message: "Researching new locations/verticals and rebuilding the topic graph" };
  });

  // -- publish targets --
  const TargetInput = z.object({
    kind: z.enum(["wordpress", "octane"]),
    name: z.string().min(1),
    isDefault: z.boolean().default(false),
    config: z.object({
      baseUrl: z.string().url().optional(),
      username: z.string().optional(),
      appPassword: z.string().optional(),
      profileDir: z.string().optional(),
    }).default({}),
  });
  app.post("/companies/:companyId/publish-targets", async (req, reply) => {
    const { companyId } = req.params as { companyId: string };
    const input = TargetInput.parse(req.body);
    const config: Record<string, unknown> = { ...input.config };
    if (input.kind === "octane") config.adapter = "octane";
    if (typeof config.appPassword === "string" && config.appPassword) config.appPassword = encryptSecret(config.appPassword);
    if (input.isDefault) await prisma.publishTarget.updateMany({ where: { companyId }, data: { isDefault: false } });
    const target = await prisma.publishTarget.create({
      data: { companyId, kind: input.kind === "octane" ? "custom" : "wordpress", name: input.name, isDefault: input.isDefault, config: config as any },
    });
    if (input.kind === "octane" && !config.profileDir) {
      // per-target browser profile: each Octane connection keeps its own session.
      // The very first target ever created reuses the original shared profile.
      const octaneCount = await prisma.publishTarget.count({ where: { kind: "custom" } });
      const profileDir = octaneCount <= 1 ? "secrets/octane-profile" : `secrets/octane-profile-${target.id}`;
      await prisma.publishTarget.update({ where: { id: target.id }, data: { config: { ...config, profileDir } as any } });
    }
    return reply.code(201).send({ id: target.id, kind: input.kind, name: target.name, isDefault: target.isDefault });
  });
  app.patch("/publish-targets/:id/default", async (req) => {
    const { id } = req.params as { id: string };
    const t = await prisma.publishTarget.findUniqueOrThrow({ where: { id } });
    await prisma.publishTarget.updateMany({ where: { companyId: t.companyId }, data: { isDefault: false } });
    await prisma.publishTarget.update({ where: { id }, data: { isDefault: true } });
    return { ok: true };
  });
  app.delete("/publish-targets/:id", async (req) => {
    const { id } = req.params as { id: string };
    await prisma.publishTarget.delete({ where: { id } });
    return { ok: true };
  });

  // -- owner-added topics/keywords (highest priority in the graph) --
  const TopicInput = z.object({
    question: z.string().min(8),
    locationId: z.string().optional().nullable(),
    verticalId: z.string().optional().nullable(),
  });
  app.post("/companies/:companyId/topics", async (req, reply) => {
    const { companyId } = req.params as { companyId: string };
    const input = TopicInput.parse(req.body);
    const node = await prisma.topicNode.upsert({
      where: { companyId_locationId_verticalId_question: {
        companyId, locationId: input.locationId ?? null, verticalId: input.verticalId ?? null, question: input.question,
      } as any },
      create: {
        companyId, locationId: input.locationId ?? null, verticalId: input.verticalId ?? null,
        question: input.question, category: "owner", funnelStage: "consideration", source: "owner",
        score: 95, scoreParts: { ownerPriority: true },
      },
      update: { score: 95 },
    });
    return reply.code(201).send(node);
  });

  // -- weekly automation state --
  app.get("/companies/:companyId/schedule", async (req) => {
    const { companyId } = req.params as { companyId: string };
    const schedulers = await getQueue(QUEUES.weeklyRun).getJobSchedulers();
    const mine = schedulers.find((s) => s.id === `weekly-${companyId}`);
    return mine
      ? { enabled: true, pattern: mine.pattern, tz: mine.tz, next: mine.next ? new Date(mine.next).toISOString() : null }
      : { enabled: false };
  });
}
