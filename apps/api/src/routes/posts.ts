import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { getQueue, QUEUES } from "../lib/queues.js";
import { runQaGates } from "@abw/shared";

/** Is this post part of a batch that is still writing/scheduling? */
async function activeBatchFor(post: { batchRunId: string | null }) {
  if (!post.batchRunId) return null;
  const run = await prisma.batchRun.findUnique({ where: { id: post.batchRunId } });
  return run && (run.state === "running" || run.state === "scheduling") ? run : null;
}

/** Review queue + dashboard endpoints. */
export async function postRoutes(app: FastifyInstance) {
  // Review queue: drafts awaiting an editorial decision, with QA results and
  // batch context (so the UI can say "held back from batch X as near-duplicate").
  app.get("/companies/:companyId/review", async (req) => {
    const { companyId } = req.params as { companyId: string };
    const posts = await prisma.blogPost.findMany({
      where: { companyId, status: { in: ["draft", "review"] } },
      orderBy: { createdAt: "desc" },
      include: { location: true, vertical: true },
    });
    const runIds = [...new Set(posts.map((p) => p.batchRunId).filter(Boolean))] as string[];
    const runs = runIds.length ? await prisma.batchRun.findMany({ where: { id: { in: runIds } } }) : [];
    const runById = Object.fromEntries(runs.map((r) => [r.id, r]));
    return posts.map((p) => ({
      ...p,
      batch: p.batchRunId ? {
        id: p.batchRunId,
        state: runById[p.batchRunId]?.state ?? "unknown",
        startedAt: runById[p.batchRunId]?.startedAt ?? null,
      } : null,
    }));
  });

  app.get("/posts/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const post = await prisma.blogPost.findUnique({ where: { id }, include: { location: true, vertical: true } });
    if (!post) return reply.code(404).send({ error: "not found" });
    return post;
  });

  /**
   * Approve = editorial sign-off + explicit timing choice.
   *   when: "now"  -> publish immediately
   *   when: "at"   -> push to the CMS scheduler for `scheduledFor`
   *   when: "keep" -> keep the date already on the post (batch-assigned)
   * Default: keep a future date if one exists, otherwise publish now.
   * Posts belonging to a batch that is still running cannot be approved here
   * (the batch will schedule them) — 409 tells the UI to explain that.
   */
  const ApproveInput = z.object({
    when: z.enum(["now", "at", "keep"]).optional(),
    scheduledFor: z.string().datetime().optional(),
    publishTargetId: z.string().optional(),
  });
  app.post("/posts/:id/approve", async (req, reply) => {
    const { id } = req.params as { id: string };
    const input = ApproveInput.parse(req.body ?? {});
    const existing = await prisma.blogPost.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "not found" });
    if (existing.status === "published") {
      return reply.code(422).send({ error: "already published", publishedUrl: existing.publishedUrl });
    }
    const run = await activeBatchFor(existing);
    if (run) {
      return reply.code(409).send({
        error: "batch_active",
        detail: "This article is part of a batch that is still writing/scheduling. The batch will schedule it automatically when it finishes — approve it afterwards if it lands in review.",
      });
    }
    const hasFutureDate = existing.scheduledFor && existing.scheduledFor > new Date();
    const when = input.when ?? (hasFutureDate ? "keep" : "now");
    if (when === "at" && !input.scheduledFor) {
      return reply.code(422).send({ error: "scheduledFor required for when=at" });
    }
    const scheduledFor =
      when === "now" ? null :
      when === "at" ? new Date(input.scheduledFor!) :
      existing.scheduledFor;
    const post = await prisma.blogPost.update({
      where: { id },
      data: { status: "approved", scheduledFor, publishError: null },
    });
    // push to the CMS immediately — the CMS's own scheduler releases it at scheduledFor
    const job = await getQueue(QUEUES.publishBlog).add(
      QUEUES.publishBlog,
      { blogPostId: post.id, publishTargetId: input.publishTargetId },
    );
    return reply.send({
      ok: true,
      postId: post.id,
      publishJobId: job.id,
      action: scheduledFor && scheduledFor > new Date() ? "scheduled" : "publishing_now",
      scheduledFor: scheduledFor?.toISOString() ?? null,
    });
  });

  // Reject = editorial no. Distinct from publish failures ("failed").
  app.post("/posts/:id/reject", async (req) => {
    const { id } = req.params as { id: string };
    const { reason } = (req.body ?? {}) as { reason?: string };
    const post = await prisma.blogPost.update({
      where: { id },
      data: { status: "rejected", qa: undefined },
    });
    await prisma.blogPost.update({
      where: { id },
      data: { qa: { ...((post.qa as any) ?? {}), rejected: true, reason: reason ?? "rejected by reviewer" } },
    });
    if (post.topicNodeId) {
      await prisma.topicNode.update({ where: { id: post.topicNodeId }, data: { blogPostId: null, evidence: { rejectedReason: reason ?? null } } });
    }
    return { ok: true };
  });

  /** Retry a failed publish: back to approved (keeping a future date), re-enqueue. */
  const RetryInput = z.object({ scheduledFor: z.string().datetime().optional() });
  app.post("/posts/:id/retry-publish", async (req, reply) => {
    const { id } = req.params as { id: string };
    const input = RetryInput.parse(req.body ?? {});
    const post = await prisma.blogPost.findUnique({ where: { id } });
    if (!post) return reply.code(404).send({ error: "not found" });
    if (post.status !== "failed") return reply.code(422).send({ error: `post is '${post.status}', only failed posts retry` });
    const when = input.scheduledFor ? new Date(input.scheduledFor)
      : post.scheduledFor && post.scheduledFor > new Date() ? post.scheduledFor : null;
    await prisma.blogPost.update({ where: { id }, data: { status: "approved", scheduledFor: when, publishError: null } });
    await getQueue(QUEUES.publishBlog).add(QUEUES.publishBlog, { blogPostId: id });
    return { ok: true, action: when && when > new Date() ? "scheduled" : "publishing_now", scheduledFor: when?.toISOString() ?? null };
  });

  /** In-place editing in the review queue. Re-runs the QA gates on save. */
  const EditInput = z.object({
    title: z.string().min(4).optional(),
    metaTitle: z.string().min(4).optional(),
    metaDescription: z.string().min(10).optional(),
    bodyHtml: z.string().min(100).optional(),
  });
  app.patch("/posts/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const input = EditInput.parse(req.body ?? {});
    const post = await prisma.blogPost.findUnique({ where: { id } });
    if (!post) return reply.code(404).send({ error: "not found" });
    if (!["draft", "review", "rejected", "failed"].includes(post.status)) {
      return reply.code(422).send({ error: `cannot edit a '${post.status}' post — reschedule or rewrite instead` });
    }
    const seo = { ...((post.seo as any) ?? {}) };
    if (input.metaTitle) seo.metaTitle = input.metaTitle;
    if (input.metaDescription) seo.metaDescription = input.metaDescription;
    const title = input.title ?? post.title;
    const bodyHtml = input.bodyHtml ?? post.bodyHtml;
    const qa = runQaGates({
      title,
      metaTitle: seo.metaTitle ?? title,
      metaDescription: seo.metaDescription ?? "",
      slug: post.slug,
      bodyHtml,
      faqs: seo.faqs ?? [],
      jsonLd: seo.jsonLd ?? {},
      internalLinks: seo.internalLinks ?? [],
    }, { companyName: (await prisma.company.findUnique({ where: { id: post.companyId }, select: { name: true } }))?.name });
    const updated = await prisma.blogPost.update({
      where: { id },
      data: {
        title, bodyHtml, seo,
        qa: { ...qa, editedAt: new Date().toISOString(), editedBy: "reviewer" },
        status: post.status === "rejected" || post.status === "failed" ? "review" : post.status,
      },
    });
    return { ok: true, qa, status: updated.status };
  });

  /**
   * Rewrite & strengthen: regenerate this article against the same topic node
   * and slug. The new version lands back in review; approving it republishes
   * (updating the existing CMS page when we know its id).
   */
  app.post("/posts/:id/rewrite", async (req, reply) => {
    const { id } = req.params as { id: string };
    const post = await prisma.blogPost.findUnique({ where: { id } });
    if (!post) return reply.code(404).send({ error: "not found" });
    if (!post.topicNodeId) return reply.code(422).send({ error: "post has no topic node to rewrite against" });
    await getQueue(QUEUES.generateBlog).add(QUEUES.generateBlog, {
      companyId: post.companyId, topicNodeId: post.topicNodeId, refreshPostId: post.id,
    });
    return { ok: true, postId: id };
  });

  // Dashboard: company, coverage %, KPIs, data freshness, off-page tasks, spend
  app.get("/companies/:companyId/dashboard", async (req) => {
    const { companyId } = req.params as { companyId: string };
    const [
      company, total, strong, weak, unanswered, gapsToWrite,
      snapshot, latestGap, latestCrawl, offPage,
      drafts, scheduled, published, failed, activeBatch, spend, perPost,
    ] = await Promise.all([
      prisma.company.findUnique({ where: { id: companyId }, select: { name: true, url: true, siteAudit: true } }),
      prisma.topicNode.count({ where: { companyId } }),
      prisma.topicNode.count({ where: { companyId, status: "answered_strong" } }),
      prisma.topicNode.count({ where: { companyId, status: "answered_weak" } }),
      prisma.topicNode.count({ where: { companyId, status: "unanswered" } }),
      prisma.topicNode.count({
        where: { companyId, blogPostId: null, status: { in: ["unanswered", "answered_weak", "competitor_owned", "stale"] } },
      }),
      prisma.visibilitySnapshot.findFirst({ where: { companyId }, orderBy: { capturedAt: "desc" } }),
      prisma.gapAnalysis.findFirst({ where: { companyId, liveFetchedAt: { not: null } }, orderBy: { liveFetchedAt: "desc" }, select: { liveFetchedAt: true } }),
      prisma.sitePage.findFirst({ where: { companyId, lastCrawledAt: { not: null } }, orderBy: { lastCrawledAt: "desc" }, select: { lastCrawledAt: true } }),
      prisma.offPageTask.findMany({ where: { companyId, status: "open" }, orderBy: { priority: "desc" } }),
      prisma.blogPost.count({ where: { companyId, status: { in: ["draft", "review"] } } }),
      prisma.blogPost.count({ where: { companyId, status: "approved" } }),
      prisma.blogPost.count({ where: { companyId, status: "published" } }),
      prisma.blogPost.count({ where: { companyId, status: "failed" } }),
      prisma.batchRun.findFirst({ where: { companyId, state: { in: ["running", "scheduling"] } }, orderBy: { startedAt: "desc" } }),
      prisma.dataFetchLog.aggregate({ where: { companyId }, _sum: { cost: true } }),
      prisma.dataFetchLog.groupBy({
        by: ["blogPostId"],
        where: { companyId, blogPostId: { not: null } },
        _sum: { cost: true },
      }),
    ]);
    const writingNow = activeBatch ? Math.max(0, (activeBatch.total ?? 0) - (activeBatch.written ?? 0)) : 0;
    const audit = (company?.siteAudit ?? null) as { auditedAt?: string } | null;
    return {
      company: company ? { name: company.name, url: company.url } : null,
      coveragePct: total ? Math.round((strong / total) * 1000) / 10 : 0,
      topics: { total, strong, weak, unanswered },
      latestSnapshot: snapshot?.summary ?? null,
      freshness: {
        gapEvidenceAt: latestGap?.liveFetchedAt ?? snapshot?.capturedAt ?? null,
        siteCrawlAt: latestCrawl?.lastCrawledAt ?? (audit?.auditedAt ? new Date(audit.auditedAt) : null),
      },
      offPageTasks: offPage,
      kpis: {
        gapsToWrite,
        writingNow,
        inReview: drafts,
        scheduled,
        liveOnSite: published,
        publishFailures: failed,
      },
      // kept for existing callers
      posts: { awaitingReview: drafts, published, failed },
      providerSpend: spend._sum.cost ?? 0,
      articleSpend: {
        total: perPost.reduce((a, r) => a + (r._sum.cost ?? 0), 0),
        articles: perPost.length,
        avg: perPost.length ? perPost.reduce((a, r) => a + (r._sum.cost ?? 0), 0) / perPost.length : 0,
      },
    };
  });

  // Top gaps (the ranked backlog view)
  app.get("/companies/:companyId/topics", async (req) => {
    const { companyId } = req.params as { companyId: string };
    const { status, source, take } = (req.query ?? {}) as { status?: string; source?: string; take?: string };
    return prisma.topicNode.findMany({
      where: {
        companyId,
        ...(status ? { status: status as any } : {}),
        ...(source ? { source } : {}),
      },
      // scored gaps first; among unscored ones show the newest (e.g. freshly
      // seeded competitor topics) rather than truncating them off the end
      orderBy: [{ score: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      take: Math.min(Number(take ?? 50), 2000),
    });
  });
}

/** Full post management: list, reschedule, bulk schedule/backfill, settings, off-page. */
export async function managementRoutes(app: FastifyInstance) {
  app.get("/companies/:companyId/posts", async (req) => {
    const { companyId } = req.params as { companyId: string };
    const posts = await prisma.blogPost.findMany({
      where: { companyId },
      orderBy: [{ scheduledFor: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
      include: { location: true, vertical: true },
    });
    // per-post AI cost (sum of provider-reported actuals across every call)
    const costs = await prisma.dataFetchLog.groupBy({
      by: ["blogPostId"],
      where: { blogPostId: { in: posts.map((p) => p.id) } },
      _sum: { cost: true },
      _count: { _all: true },
    });
    const costById = Object.fromEntries(costs.map((c) => [c.blogPostId, { cost: c._sum.cost ?? 0, calls: c._count._all }]));
    return posts.map((p) => ({ ...p, aiCost: costById[p.id]?.cost ?? 0, aiCalls: costById[p.id]?.calls ?? 0 }));
  });

  /**
   * Exact AI spend for one post, split per model (each model's calls summed
   * separately from the provider-reported cost of every request), plus the
   * combined total. Precision: raw floats — the UI renders to $0.00001.
   */
  app.get("/posts/:id/cost", async (req) => {
    const { id } = req.params as { id: string };
    const rows = await prisma.dataFetchLog.findMany({
      where: { blogPostId: id },
      orderBy: { liveFetchedAt: "asc" },
      select: { endpoint: true, cost: true, meta: true, provider: true, liveFetchedAt: true },
    });
    const byModel: Record<string, { model: string; calls: number; cost: number }> = {};
    const bySteps: { step: string; model: string; cost: number; at: Date }[] = [];
    for (const r of rows) {
      const model = ((r.meta as any)?.model as string) ?? (r.endpoint.startsWith('imagegen:') ? r.endpoint.slice(9) : r.provider);
      byModel[model] ??= { model, calls: 0, cost: 0 };
      byModel[model].calls += 1;
      byModel[model].cost += r.cost ?? 0;
      bySteps.push({ step: r.endpoint, model, cost: r.cost ?? 0, at: r.liveFetchedAt });
    }
    const models = Object.values(byModel).sort((a, b) => b.cost - a.cost);
    return {
      postId: id,
      models,
      steps: bySteps,
      total: models.reduce((a, m) => a + m.cost, 0),
      calls: rows.length,
      estimatedAttribution: rows.some((r) => (r.meta as any)?.attributed === "backfill-heuristic"),
    };
  });

  const RescheduleInput = z.object({ scheduledFor: z.string().datetime() });
  app.post("/posts/:id/reschedule", async (req, reply) => {
    const { id } = req.params as { id: string };
    const input = RescheduleInput.parse(req.body);
    const post = await prisma.blogPost.findUniqueOrThrow({ where: { id } });
    if (post.status === "published") return reply.code(422).send({ error: "already published — edit on the CMS" });
    const when = new Date(input.scheduledFor);
    await prisma.blogPost.update({ where: { id }, data: { scheduledFor: when } });
    if (post.status === "approved") {
      await getQueue(QUEUES.publishBlog).add(QUEUES.publishBlog, { blogPostId: id });
    }
    return { ok: true };
  });

  /**
   * Bulk schedule DRAFTS across a window (approve + spread + push to CMS
   * scheduler). Published/approved/failed posts in the selection are skipped
   * and reported back — this action is for moving drafts out of review in
   * bulk, not for re-publishing.
   */
  const BatchInput = z.object({
    postIds: z.array(z.string()).min(1),
    start: z.string().datetime(),
    end: z.string().datetime().optional(),
    perWeek: z.number().int().min(1).max(14).default(3),
  });
  app.post("/companies/:companyId/schedule-batch", async (req) => {
    const input = BatchInput.parse(req.body);
    const posts = await prisma.blogPost.findMany({ where: { id: { in: input.postIds } } });
    const byId = Object.fromEntries(posts.map((p) => [p.id, p]));
    const skipped: { postId: string; title: string; reason: string }[] = [];
    const eligible: string[] = [];
    for (const id of input.postIds) {
      const p = byId[id];
      if (!p) { skipped.push({ postId: id, title: "?", reason: "not found" }); continue; }
      if (!["draft", "review"].includes(p.status)) {
        skipped.push({ postId: id, title: p.title, reason: `already ${p.status}` });
        continue;
      }
      const run = p.batchRunId ? await prisma.batchRun.findUnique({ where: { id: p.batchRunId } }) : null;
      if (run && (run.state === "running" || run.state === "scheduling")) {
        skipped.push({ postId: id, title: p.title, reason: "batch still running — it will schedule this one" });
        continue;
      }
      eligible.push(id);
    }
    const start = new Date(input.start).getTime();
    const end = input.end ? new Date(input.end).getTime()
      : start + Math.ceil(Math.max(eligible.length, 1) / input.perWeek) * 7 * 24 * 3600e3;
    const span = Math.max(end - start, 3600e3);
    const step = span / Math.max(eligible.length, 1);
    const scheduled: { postId: string; title: string; at: string }[] = [];
    const gapMs = () => (36 + Math.random() * 26) * 60e3; // random 36-62 min
    let prevTime = 0;
    for (let i = 0; i < eligible.length; i++) {
      const id = eligible[i]!;
      const base = new Date(start + step * i + step * 0.5);
      // randomized business-hours placement, never closer than 36-62 min to the previous post
      base.setHours(8 + Math.floor(Math.random() * 9), Math.floor(Math.random() * 60), 0, 0);
      if (prevTime && base.getTime() < prevTime + gapMs()) base.setTime(prevTime + gapMs());
      prevTime = base.getTime();
      await prisma.blogPost.update({ where: { id }, data: { status: "approved", scheduledFor: base, publishError: null } });
      // immediate push; CMS-side scheduling releases at the assigned time
      await getQueue(QUEUES.publishBlog).add(QUEUES.publishBlog, { blogPostId: id });
      scheduled.push({ postId: id, title: byId[id]!.title, at: base.toISOString() });
    }
    return { ok: true, scheduled, skipped };
  });

  const SettingsInput = z.object({
    weeklyCapPerPair: z.number().int().min(1).max(30).optional(),
    weeklyCapTotal: z.number().int().min(1).max(60).optional(),
    autoApprove: z.boolean().optional(),
    killSwitch: z.boolean().optional(),
    notifyWebhookUrl: z.string().url().nullable().optional(),
  });
  app.patch("/companies/:companyId/settings", async (req) => {
    const { companyId } = req.params as { companyId: string };
    const input = SettingsInput.parse(req.body ?? {});
    const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    const settings = { ...((company.settings as any) ?? {}), ...input };
    await prisma.company.update({ where: { id: companyId }, data: { settings } });
    return { ok: true, settings };
  });

  // ---- Competitors: operator-listed domains we crawl + diff for content gaps ----
  const normDomain = (raw: string): string => {
    let d = raw.trim().toLowerCase();
    d = d.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
    return d;
  };
  const CompetitorInput = z.object({ domain: z.string().min(3), label: z.string().max(120).optional() });

  app.get("/companies/:companyId/competitors", async (req) => {
    const { companyId } = req.params as { companyId: string };
    return prisma.competitor.findMany({ where: { companyId }, orderBy: { createdAt: "asc" } });
  });

  app.post("/companies/:companyId/competitors", async (req, reply) => {
    const { companyId } = req.params as { companyId: string };
    const input = CompetitorInput.parse(req.body ?? {});
    const domain = normDomain(input.domain);
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return reply.code(422).send({ error: "invalid domain" });
    const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    if (normDomain(company.url) === domain) return reply.code(422).send({ error: "that is the tenant's own domain" });
    const existing = await prisma.competitor.findUnique({ where: { companyId_domain: { companyId, domain } } });
    if (existing) return reply.code(409).send({ error: "already added" });
    const competitor = await prisma.competitor.create({
      data: { companyId, domain, label: input.label ?? null, status: "pending" },
    });
    return { ok: true, competitor };
  });

  app.delete("/competitors/:id", async (req) => {
    const { id } = req.params as { id: string };
    await prisma.competitor.delete({ where: { id } });
    return { ok: true };
  });

  app.post("/companies/:companyId/competitors/analyze", async (req) => {
    const { companyId } = req.params as { companyId: string };
    const count = await prisma.competitor.count({ where: { companyId } });
    if (!count) return { ok: false, error: "no competitors listed" };
    await prisma.competitor.updateMany({ where: { companyId }, data: { status: "pending" } });
    const job = await getQueue(QUEUES.analyzeCompetitors).add(QUEUES.analyzeCompetitors, { companyId });
    return { ok: true, jobId: job.id, competitors: count };
  });

  app.get("/companies/:companyId/offpage", async (req) => {
    const { companyId } = req.params as { companyId: string };
    return prisma.offPageTask.findMany({
      where: { companyId },
      orderBy: [{ status: "asc" }, { priority: "desc" }],
    });
  });

  app.patch("/offpage/:id", async (req) => {
    const { id } = req.params as { id: string };
    const { status } = (req.body ?? {}) as { status?: string };
    await prisma.offPageTask.update({ where: { id }, data: { status: status ?? "done" } });
    return { ok: true };
  });

  /** AI-draft the outreach/post copy for one off-page task (runs as a job). */
  app.post("/offpage/:id/draft", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = await prisma.offPageTask.findUnique({ where: { id } });
    if (!task) return reply.code(404).send({ error: "not found" });
    await getQueue(QUEUES.offpageDraft).add(QUEUES.offpageDraft, { taskId: id });
    return { ok: true };
  });

  app.get("/companies/:companyId/full", async (req, reply) => {
    const { companyId } = req.params as { companyId: string };
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      include: { locations: { include: { verticals: true } }, publishTargets: true },
    });
    if (!company) return reply.code(404).send({ error: "not found" });
    return company;
  });

  // ---- Site map: internal link structure, pillar pages, orphans, broken links ----
  const normPath = (p: string) => (p || "/").split("?")[0]!.replace(/\/+$/, "") || "/";

  app.get("/companies/:companyId/site-map", async (req) => {
    const { companyId } = req.params as { companyId: string };
    const [pagesRaw, brokenCount, lastCrawl] = await Promise.all([
      prisma.sitePage.findMany({ where: { companyId }, orderBy: [{ isPillar: "desc" }, { inboundInternal: "desc" }] }),
      prisma.linkCheck.count({ where: { companyId, ok: false } }),
      prisma.sitePage.findFirst({ where: { companyId, lastCrawledAt: { not: null } }, orderBy: { lastCrawledAt: "desc" }, select: { lastCrawledAt: true } }),
    ]);
    const byPath = new Map<string, (typeof pagesRaw)[number]>();
    for (const p of pagesRaw) byPath.set(normPath(p.path), p);

    // who links to each page
    const linkedFrom = new Map<string, { path: string; title: string | null; anchor: string }[]>();
    for (const src of pagesRaw) {
      const seen = new Set<string>();
      for (const l of (src.outboundLinks ?? []) as any[]) {
        if (l.kind !== "internal") continue;
        const tgt = byPath.get(normPath(l.path));
        if (!tgt || tgt.id === src.id || seen.has(tgt.id)) continue;
        seen.add(tgt.id);
        const arr = linkedFrom.get(tgt.id) ?? [];
        arr.push({ path: src.path, title: src.title, anchor: l.anchor });
        linkedFrom.set(tgt.id, arr);
      }
    }

    const view = (p: (typeof pagesRaw)[number]) => ({
      url: p.url, path: p.path, contentType: p.contentType, title: p.title,
      primaryTopic: p.primaryTopic, wordCount: p.wordCount, hasSchema: p.hasSchema,
      inboundInternal: p.inboundInternal, isPillar: p.isPillar,
      outboundInternal: ((p.outboundLinks ?? []) as any[]).filter((l) => l.kind === "internal").length,
      outboundExternal: ((p.outboundLinks ?? []) as any[]).filter((l) => l.kind === "external").length,
      orphan: p.inboundInternal === 0 && !["home", "legal"].includes(p.contentType ?? ""),
    });

    const pillars = pagesRaw.filter((p) => p.isPillar).map((p) => {
      const supporters = linkedFrom.get(p.id) ?? [];
      // content pages on the same topic that DON'T link to this pillar
      const topicWords = new Set((`${p.primaryTopic ?? ""} ${p.title ?? ""}`).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
      const missing = pagesRaw
        .filter((q) => q.id !== p.id && ["blog", "service", "industry"].includes(q.contentType ?? "")
          && !supporters.some((s) => normPath(s.path) === normPath(q.path))
          && [...topicWords].some((w) => (`${q.primaryTopic ?? ""} ${q.title ?? ""}`).toLowerCase().includes(w)))
        .slice(0, 8)
        .map((q) => ({ path: q.path, title: q.title, contentType: q.contentType }));
      return { ...view(p), linkedFrom: supporters, missingLinks: missing };
    });

    const pages = pagesRaw.map(view);
    return {
      lastCrawledAt: lastCrawl?.lastCrawledAt ?? null,
      brokenLinkCount: brokenCount,
      stats: {
        total: pages.length,
        pillars: pillars.length,
        orphans: pages.filter((p) => p.orphan).length,
        noInboundPct: pages.length ? Math.round((pages.filter((p) => p.inboundInternal === 0).length / pages.length) * 100) : 0,
      },
      pillars,
      orphans: pages.filter((p) => p.orphan).sort((a, b) => (b.wordCount ?? 0) - (a.wordCount ?? 0)),
      pages,
    };
  });

  const tokens = (s: string) => (s || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);

  app.get("/companies/:companyId/broken-links", async (req) => {
    const { companyId } = req.params as { companyId: string };
    const [rows, posts] = await Promise.all([
      prisma.linkCheck.findMany({ where: { companyId, ok: false }, orderBy: [{ kind: "asc" }, { checkedAt: "desc" }] }),
      prisma.blogPost.findMany({ where: { companyId, publishedUrl: { not: null } }, select: { id: true, title: true, publishedUrl: true } }),
    ]);
    const postByUrl = new Map<string, { id: string; title: string }>();
    for (const p of posts) postByUrl.set(p.publishedUrl!.replace(/\/$/, ""), { id: p.id, title: p.title });
    return rows.map((r) => {
      const srcs = (r.sources ?? []) as any[];
      const inPosts = [...new Set(srcs.map((s) => postByUrl.get(String(s.sourceUrl).replace(/\/$/, ""))).filter(Boolean))] as { id: string; title: string }[];
      return {
        targetUrl: r.targetUrl, status: r.status, kind: r.kind, error: r.error,
        checkedAt: r.checkedAt, sources: srcs,
        // a link we can repair automatically: internal target, appears in our blog posts
        fixable: r.kind === "internal" && inPosts.length > 0,
        inPosts,
      };
    });
  });

  /**
   * Repair broken internal links that live in our own published blog posts:
   * point each bad <a href> at the closest real page (by slug + anchor match),
   * or unwrap it (keep the text). Fixed posts are re-queued to publish the
   * update. Site-owned broken links can't be touched — use Export for those.
   */
  app.post("/companies/:companyId/broken-links/fix", async (req) => {
    const { companyId } = req.params as { companyId: string };
    const body = (req.body ?? {}) as { targetUrls?: string[] };
    const [broken, sitePages, posts] = await Promise.all([
      prisma.linkCheck.findMany({ where: { companyId, ok: false, kind: "internal" } }),
      prisma.sitePage.findMany({ where: { companyId }, select: { path: true, title: true, primaryTopic: true, contentType: true } }),
      prisma.blogPost.findMany({ where: { companyId, publishedUrl: { not: null } } }),
    ]);
    const wanted = body.targetUrls?.length ? new Set(body.targetUrls) : null;
    const badPaths = new Map<string, string>(); // normalized bad path -> full bad target
    for (const b of broken) {
      if (wanted && !wanted.has(b.targetUrl)) continue;
      try { badPaths.set(new URL(b.targetUrl).pathname.replace(/\/+$/, ""), b.targetUrl); } catch { /* skip */ }
    }
    if (!badPaths.size) return { ok: true, postsFixed: 0, linksFixed: 0, linksUnwrapped: 0 };

    const candidates = sitePages.filter((p) => !["legal", "other"].includes(p.contentType ?? ""));
    const bestMatch = (badPath: string, anchor: string): string | null => {
      const want = new Set([...tokens(badPath.split("/").pop() ?? ""), ...tokens(anchor)]);
      let best: { path: string; score: number } | null = null;
      for (const c of candidates) {
        const have = new Set([...tokens(c.path), ...tokens(c.title ?? ""), ...tokens(c.primaryTopic ?? "")]);
        let score = 0;
        for (const w of want) if (have.has(w)) score += 1;
        if (score > (best?.score ?? 0)) best = { path: c.path, score };
      }
      return best && best.score >= 2 ? best.path : null;
    };

    let postsFixed = 0, linksFixed = 0, linksUnwrapped = 0;
    const affected: string[] = [];
    for (const post of posts) {
      let html = post.bodyHtml;
      let changed = false;
      html = html.replace(/<a\b[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (whole, href: string, text: string) => {
        let path: string;
        try { path = new URL(href, post.publishedUrl!).pathname.replace(/\/+$/, ""); } catch { return whole; }
        if (!badPaths.has(path)) return whole;
        changed = true;
        const target = bestMatch(path, text.replace(/<[^>]+>/g, " "));
        if (target) { linksFixed++; return `<a href="${target}">${text}</a>`; }
        linksUnwrapped++; return text;
      });
      if (changed) {
        // save the repaired body; published posts go back to review so the
        // human can push the update (non-destructive — the live page is
        // untouched until re-approved, which updates it in place)
        await prisma.blogPost.update({
          where: { id: post.id },
          data: { bodyHtml: html, ...(post.status === "published" ? { status: "review" } : {}) },
        });
        postsFixed++;
        affected.push(post.title);
      }
    }
    return { ok: true, postsFixed, linksFixed, linksUnwrapped, affected: affected.slice(0, 20) };
  });

  app.post("/companies/:companyId/site-map/recheck", async (req) => {
    const { companyId } = req.params as { companyId: string };
    const job = await getQueue(QUEUES.ingestSite).add(QUEUES.ingestSite, { companyId, maxPages: 120, force: true });
    return { ok: true, jobId: job.id };
  });
}

/** One-click actions: check gaps, expand graph, write next blogs. */
export async function actionRoutes(app: FastifyInstance) {
  app.post("/companies/:companyId/analyze", async (req) => {
    const { companyId } = req.params as { companyId: string };
    const { expandPerPair, liveProbeCount } = (req.body ?? {}) as { expandPerPair?: number; liveProbeCount?: number };
    const job = await getQueue(QUEUES.analyzeGaps).add(QUEUES.analyzeGaps, {
      companyId, liveProbeCount: liveProbeCount ?? 12, expandPerPair: expandPerPair ?? 0,
    });
    return { ok: true, jobId: job.id };
  });

  const GenerateNextInput = z.object({ count: z.number().int().min(1).max(150).default(1) });
  app.post("/companies/:companyId/generate-next", async (req) => {
    const { companyId } = req.params as { companyId: string };
    const input = GenerateNextInput.parse(req.body ?? {});
    const nodes = await prisma.topicNode.findMany({
      where: { companyId, status: { in: ["unanswered", "answered_weak", "competitor_owned", "stale"] }, blogPostId: null },
      orderBy: [{ score: { sort: "desc", nulls: "last" } }],
      take: input.count,
    });
    for (const n of nodes) {
      await getQueue(QUEUES.generateBlog).add(QUEUES.generateBlog, { companyId, topicNodeId: n.id });
    }
    return { ok: true, queued: nodes.map((n) => n.question) };
  });

  app.post("/topics/:topicNodeId/generate", async (req, reply) => {
    const { topicNodeId } = req.params as { topicNodeId: string };
    const node = await prisma.topicNode.findUnique({ where: { id: topicNodeId } });
    if (!node) return reply.code(404).send({ error: "not found" });
    if (node.blogPostId) return reply.code(422).send({ error: "already has an article" });
    await getQueue(QUEUES.generateBlog).add(QUEUES.generateBlog, { companyId: node.companyId, topicNodeId });
    return { ok: true, question: node.question };
  });

  /**
   * Rewrite weak/stale answers in bulk: picks nodes whose existing article
   * (or site page) is underperforming and regenerates each in place. New
   * versions land in review.
   */
  const RewriteWeakInput = z.object({ count: z.number().int().min(1).max(50).default(5) });
  app.post("/companies/:companyId/rewrite-weak", async (req) => {
    const { companyId } = req.params as { companyId: string };
    const input = RewriteWeakInput.parse(req.body ?? {});
    const nodes = await prisma.topicNode.findMany({
      where: { companyId, status: { in: ["answered_weak", "stale"] }, blogPostId: { not: null } },
      orderBy: [{ score: { sort: "desc", nulls: "last" } }],
      take: input.count,
    });
    for (const n of nodes) {
      await getQueue(QUEUES.generateBlog).add(QUEUES.generateBlog, {
        companyId, topicNodeId: n.id, refreshPostId: n.blogPostId!,
      });
    }
    return { ok: true, queued: nodes.map((n) => n.question) };
  });
}

/** Owner-triggered write-and-schedule batch. */
export async function writeScheduleRoutes(app: FastifyInstance) {
  const Input = z.object({
    count: z.number().int().min(1).max(150),
    start: z.string().datetime(),
    end: z.string().datetime(),
  });
  app.post("/companies/:companyId/write-and-schedule", async (req) => {
    const { companyId } = req.params as { companyId: string };
    const input = Input.parse(req.body);
    const job = await getQueue(QUEUES.writeSchedule).add(QUEUES.writeSchedule, { companyId, ...input });
    return { ok: true, jobId: job.id };
  });
}

/** Latest batch progress for the dashboard progress bars. */
export async function batchStatusRoutes(app: FastifyInstance) {
  app.get("/companies/:companyId/batch", async (req) => {
    const { companyId } = req.params as { companyId: string };
    const run = await prisma.batchRun.findFirst({ where: { companyId }, orderBy: { startedAt: "desc" } });
    return run ?? { state: "none" };
  });
}

/** Batch history with the articles each run produced. */
export async function batchHistoryRoutes(app: FastifyInstance) {
  app.get("/companies/:companyId/batches", async (req) => {
    const { companyId } = req.params as { companyId: string };
    const runs = await prisma.batchRun.findMany({ where: { companyId }, orderBy: { startedAt: "desc" }, take: 30 });
    const out = [];
    for (const run of runs) {
      const ids = (run.postIds as string[] | null) ?? [];
      const posts = ids.length
        ? await prisma.blogPost.findMany({
            where: { id: { in: ids } },
            select: { id: true, title: true, slug: true, status: true, scheduledFor: true, publishedAt: true, publishedUrl: true, publishError: true },
            orderBy: { scheduledFor: "asc" },
          })
        : [];
      out.push({ ...run, posts });
    }
    return out;
  });
}

/** In-app notification center. */
export async function notificationRoutes(app: FastifyInstance) {
  app.get("/notifications", async (req) => {
    const { unread } = (req.query ?? {}) as { unread?: string };
    const items = await prisma.notification.findMany({
      where: unread ? { readAt: null } : {},
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    const unreadCount = await prisma.notification.count({ where: { readAt: null } });
    return { items, unreadCount };
  });
  app.post("/notifications/:id/read", async (req) => {
    const { id } = req.params as { id: string };
    await prisma.notification.update({ where: { id }, data: { readAt: new Date() } });
    return { ok: true };
  });
  app.post("/notifications/read-all", async () => {
    await prisma.notification.updateMany({ where: { readAt: null }, data: { readAt: new Date() } });
    return { ok: true };
  });
}

/** Coverage-over-time + publishing cadence for the Trends tab. */
export async function trendsRoutes(app: FastifyInstance) {
  app.get("/companies/:companyId/trends", async (req) => {
    const { companyId } = req.params as { companyId: string };
    const [snapshots, posts, verticals] = await Promise.all([
      prisma.visibilitySnapshot.findMany({
        where: { companyId }, orderBy: { capturedAt: "asc" }, take: 200,
        select: { capturedAt: true, summary: true, verticalId: true },
      }),
      prisma.blogPost.findMany({
        where: { companyId, status: "published" },
        select: { publishedAt: true, scheduledFor: true },
        orderBy: { publishedAt: "asc" },
      }),
      prisma.vertical.findMany({
        where: { location: { companyId } },
        select: { id: true, name: true },
      }),
    ]);
    // current coverage per vertical
    const perVertical = [];
    for (const v of verticals) {
      const [total, strong] = await Promise.all([
        prisma.topicNode.count({ where: { companyId, verticalId: v.id } }),
        prisma.topicNode.count({ where: { companyId, verticalId: v.id, status: "answered_strong" } }),
      ]);
      perVertical.push({ verticalId: v.id, name: v.name, total, strong, pct: total ? Math.round((strong / total) * 1000) / 10 : 0 });
    }
    return {
      snapshots: snapshots.map((s) => ({ at: s.capturedAt, verticalId: s.verticalId, summary: s.summary })),
      published: posts.map((p) => ({ at: p.publishedAt ?? p.scheduledFor })),
      perVertical,
    };
  });
}
