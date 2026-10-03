import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  QUEUES, scoreDomain, queryHit, untrackedDomains, normDomain, toBenchmarkRow, type BenchmarkRow,
} from "@abw/shared";
import { prisma } from "../lib/prisma.js";
import { getQueue } from "../lib/queues.js";

/**
 * Competitive benchmark: you vs tracked competitors on a fixed, BrandScript-
 * derived query set probed live per run (see worker runBenchmark).
 */
export async function benchmarkRoutes(app: FastifyInstance) {
  app.get("/companies/:companyId/benchmark", async (req, reply) => {
    const { companyId } = req.params as { companyId: string };
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      include: { locations: { include: { verticals: true } }, competitors: true },
    });
    if (!company) return reply.code(404).send({ error: "not found" });
    const tenant = normDomain(new URL(company.url).hostname);

    const runs = await prisma.benchmarkRun.findMany({
      where: { companyId }, orderBy: { startedAt: "asc" },
      select: { id: true, status: true, startedAt: true, finishedAt: true, queriesTotal: true, queriesProbed: true, summary: true, error: true },
    });
    const queryCount = await prisma.benchmarkQuery.count({ where: { companyId, active: true } });
    const latest = [...runs].reverse().find((r) => r.status === "complete");
    const running = runs.find((r) => r.status === "running") ?? null;
    const trend = runs.filter((r) => r.status === "complete").map((r) => ({ at: r.startedAt, summary: r.summary }));
    if (!latest) return { tenant, queryCount, running, latest: null, trend, runs: runs.slice(-10).reverse() };

    const results = await prisma.benchmarkResult.findMany({ where: { runId: latest.id } });
    const rows = results.map(toBenchmarkRow);
    const fetched = results.map((r) => r.liveFetchedAt.getTime());

    const cityOf = new Map(company.locations.map((l) => [l.id, l.city]));
    const verticalOf = new Map(company.locations.flatMap((l) => l.verticals.map((v) => [v.id, v.name] as const)));
    const listed = company.competitors.map((c) => normDomain(c.domain));

    // content footprint: what each side has published that answers buyers
    const [tenantPages, tenantQuestions, tenantPosts] = await Promise.all([
      prisma.sitePage.count({ where: { companyId } }),
      prisma.sitePage.findMany({ where: { companyId }, select: { questionsAnswered: true } })
        .then((ps) => ps.reduce((n, p) => n + (Array.isArray(p.questionsAnswered) ? p.questionsAnswered.length : 0), 0)),
      prisma.blogPost.count({ where: { companyId, status: "published" } }),
    ]);

    const scorecard = [
      { ...scoreDomain(rows, tenant), isTenant: true, label: company.name, content: { pages: tenantPages, questions: tenantQuestions, posts: tenantPosts }, crawl: null },
      ...company.competitors.map((c) => {
        const cov = (Array.isArray(c.coverage) ? c.coverage : []) as { questionsAnswered?: string[]; contentType?: string }[];
        return {
          ...scoreDomain(rows, c.domain, tenant), isTenant: false, label: c.label,
          content: {
            pages: c.pagesCrawled,
            questions: cov.reduce((n, p) => n + (p.questionsAnswered?.length ?? 0), 0),
            posts: cov.filter((p) => p.contentType === "blog").length,
          },
          crawl: { status: c.status, error: c.error },
        };
      }).sort((a, b) => b.score - a.score),
    ];

    // by city x industry: who leads each segment
    const groups = new Map<string, BenchmarkRow[]>();
    for (const r of rows) {
      const k = `${r.locationId}|${r.verticalId ?? ""}`;
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    const segments = [...groups.entries()].map(([k, gr]) => {
      const [locationId, verticalId] = k.split("|");
      const you = scoreDomain(gr, tenant).score;
      const comps = listed.map((d) => ({ domain: d, score: scoreDomain(gr, d).score })).sort((a, b) => b.score - a.score);
      return {
        locationId, city: cityOf.get(locationId!) ?? "?", verticalId: verticalId || null,
        vertical: verticalId ? verticalOf.get(verticalId) ?? "?" : "General local",
        queries: gr.length, you, leader: comps[0] && comps[0].score > 0 ? comps[0] : null, competitors: comps,
      };
    }).sort((a, b) => a.city.localeCompare(b.city) || (a.verticalId ? 1 : 0) - (b.verticalId ? 1 : 0) || a.vertical.localeCompare(b.vertical));

    // per query: you vs the best tracked competitor
    const queries = rows.map((r) => {
      const you = queryHit(r, tenant);
      const best = listed.map((d) => ({ domain: d, ...queryHit(r, d) })).sort((a, b) => b.points - a.points)[0];
      return {
        queryId: r.queryId, query: r.query, intent: r.intent,
        city: cityOf.get(r.locationId) ?? "?", vertical: r.verticalId ? verticalOf.get(r.verticalId) ?? "?" : "General local",
        hasAiOverview: r.hasAiOverview, you,
        competitor: best && best.points > 0 ? best : null,
        outcome: you.points > (best?.points ?? 0) ? "win" : you.points === 0 && (best?.points ?? 0) === 0 ? "none" : you.points === (best?.points ?? 0) ? "tie" : "loss",
        topOrganic: r.organic.slice(0, 3).map((o) => o.domain),
      };
    });

    return {
      tenant, queryCount, running, trend, runs: runs.slice(-10).reverse(),
      latest: {
        runId: latest.id, startedAt: latest.startedAt, queriesProbed: latest.queriesProbed, queriesTotal: latest.queriesTotal,
        liveFetchedFrom: fetched.length ? new Date(Math.min(...fetched)) : null,
        liveFetchedTo: fetched.length ? new Date(Math.max(...fetched)) : null,
        scorecard, segments, queries,
        untracked: untrackedDomains(rows, [tenant, ...listed]),
      },
    };
  });

  app.get("/companies/:companyId/benchmark/queries", async (req) => {
    const { companyId } = req.params as { companyId: string };
    return prisma.benchmarkQuery.findMany({ where: { companyId }, orderBy: [{ locationId: "asc" }, { verticalId: "asc" }, { query: "asc" }] });
  });

  const QueryInput = z.object({
    query: z.string().min(3).max(200),
    locationId: z.string().min(1),
    verticalId: z.string().min(1).nullable().optional(),
    intent: z.enum(["local", "vertical", "problem", "comparison", "compliance"]).default("vertical"),
  });
  app.post("/companies/:companyId/benchmark/queries", async (req, reply) => {
    const { companyId } = req.params as { companyId: string };
    const input = QueryInput.parse(req.body ?? {});
    const loc = await prisma.location.findFirst({ where: { id: input.locationId, companyId }, include: { verticals: true } });
    if (!loc) return reply.code(404).send({ error: "location not found" });
    if (input.verticalId && !loc.verticals.some((v) => v.id === input.verticalId)) return reply.code(404).send({ error: "vertical not found" });
    const q = await prisma.benchmarkQuery.create({
      data: { companyId, locationId: loc.id, verticalId: input.verticalId ?? null, query: input.query.trim(), intent: input.intent, source: "manual" },
    });
    return { ok: true, query: q };
  });

  app.patch("/companies/:companyId/benchmark/queries/:id", async (req, reply) => {
    const { companyId, id } = req.params as { companyId: string; id: string };
    const { active } = z.object({ active: z.boolean() }).parse(req.body ?? {});
    const r = await prisma.benchmarkQuery.updateMany({ where: { id, companyId }, data: { active } });
    if (!r.count) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  });

  app.delete("/companies/:companyId/benchmark/queries/:id", async (req, reply) => {
    const { companyId, id } = req.params as { companyId: string; id: string };
    const r = await prisma.benchmarkQuery.deleteMany({ where: { id, companyId } });
    if (!r.count) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  });

  app.post("/companies/:companyId/benchmark/generate", async (req) => {
    const { companyId } = req.params as { companyId: string };
    const body = z.object({ replace: z.boolean().default(false), runAfter: z.boolean().default(false) }).parse(req.body ?? {});
    const job = await getQueue(QUEUES.benchmarkQueries).add(QUEUES.benchmarkQueries, { companyId, ...body });
    return { ok: true, jobId: job.id };
  });

  app.post("/companies/:companyId/benchmark/run", async (req) => {
    const { companyId } = req.params as { companyId: string };
    const { resumeRunId } = z.object({ resumeRunId: z.string().min(1).optional() }).parse(req.body ?? {});
    const job = await getQueue(QUEUES.runBenchmark).add(QUEUES.runBenchmark, { companyId, resumeRunId });
    return { ok: true, jobId: job.id };
  });
}
