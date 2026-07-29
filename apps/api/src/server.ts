import Fastify from "fastify";
import cors from "@fastify/cors";
import { ZodError } from "zod";
import { companyRoutes } from "./routes/companies.js";
import { jobRoutes } from "./routes/jobs.js";
import { postRoutes } from "./routes/posts.js";

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: process.env.WEB_ORIGIN ?? "http://localhost:3100",
  credentials: true,
});

// Auth enforcement: open until the first user is created (setup mode).
const { requireAuth } = await import("./routes/auth.js");
app.addHook("onRequest", async (req, reply) => {
  const denied = await requireAuth(req);
  if (denied) return reply.code(denied.code).send({ error: denied.error });
});

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof ZodError) {
    return reply.code(422).send({ error: "validation", issues: err.issues });
  }
  app.log.error(err);
  return reply.code(500).send({ error: "internal" });
});

// Everything lives under /api/*
await app.register(
  async (api) => {
    api.get("/health", async () => ({ ok: true, service: "abw-api" }));
    await api.register(companyRoutes);
    await api.register(jobRoutes);
    await api.register(postRoutes);
    const { scheduleRoutes } = await import("./routes/companies.js");
    await api.register(scheduleRoutes);
    const { publisherRoutes } = await import("./routes/publishers.js");
    await api.register(publisherRoutes);
    const { managementRoutes } = await import("./routes/posts.js");
    await api.register(managementRoutes);
    const { actionRoutes } = await import("./routes/posts.js");
    await api.register(actionRoutes);
    const { onboardingRoutes } = await import("./routes/onboarding.js");
    await api.register(onboardingRoutes);
    const { batchHistoryRoutes } = await import("./routes/posts.js");
    await api.register(batchHistoryRoutes);
    const { batchStatusRoutes } = await import("./routes/posts.js");
    await api.register(batchStatusRoutes);
    const { writeScheduleRoutes } = await import("./routes/posts.js");
    await api.register(writeScheduleRoutes);
    const { pricingRoutes } = await import("./routes/pricing.js");
    await api.register(pricingRoutes);
    const { documentRoutes } = await import("./routes/documents.js");
    await api.register(documentRoutes);
    const { authRoutes } = await import("./routes/auth.js");
    await api.register(authRoutes);
    const { notificationRoutes, trendsRoutes } = await import("./routes/posts.js");
    await api.register(notificationRoutes);
    await api.register(trendsRoutes);
  },
  { prefix: "/api" },
);

const port = Number(process.env.API_PORT ?? 3101);
app
  .listen({ port, host: "0.0.0.0" })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
