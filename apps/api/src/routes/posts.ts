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
    });
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

  // Dashboard: coverage %, latest snapshot, off-page tasks, spend
  app.get("/companies/:companyId/dashboard", async (req) => {
    const { companyId } = req.params as { companyId: string };
    const [total, strong, weak, unanswered, snapshot, offPage, drafts, published, failed, spend, perPost] = await Promise.all([
      prisma.topicNode.count({ where: { companyId } }),
      prisma.topicNode.count({ where: { companyId, status: "answered_strong" } }),
      prisma.topicNode.count({ where: { companyId, status: "answered_weak" } }),
      prisma.topicNode.count({ where: { companyId, status: "unanswered" } }),
      prisma.visibilitySnapshot.findFirst({ where: { companyId }, orderBy: { capturedAt: "desc" } }),
      prisma.offPageTask.findMany({ where: { companyId, status: "open" }, orderBy: { priority: "desc" } }),
      prisma.blogPost.count({ where: { companyId, status: { in: ["draft", "review"] } } }),
      prisma.blogPost.count({ where: { companyId, status: "published" } }),
      prisma.blogPost.count({ where: { companyId, status: "failed" } }),
      prisma.dataFetchLog.aggregate({ where: { companyId }, _sum: { cost: true } }),
      prisma.dataFetchLog.groupBy({
        by: ["blogPostId"],
        where: { companyId, blogPostId: { not: null } },
        _sum: { cost: true },
      }),
    ]);
    return {
      coveragePct: total ? Math.round((strong / total) * 1000) / 10 : 0,
      topics: { total, strong, weak, unanswered },
      latestSnapshot: snapshot?.summary ?? null,
      offPageTasks: offPage,
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
    const { status, take } = (req.query ?? {}) as { status?: string; take?: string };
    return prisma.topicNode.findMany({
      where: { companyId, ...(status ? { status: status as any } : {}) },
      orderBy: [{ score: { sort: "desc", nulls: "last" } }],
      take: Math.min(Number(take ?? 50), 200),
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
      where: { companyId, status: { in: ["unanswered", "answered_weak", "stale"] }, blogPostId: null },
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
