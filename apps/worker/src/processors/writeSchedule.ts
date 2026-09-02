import type { Job } from "bullmq";
import { WriteSchedulePayload, QUEUES } from "@abw/shared";
import { prisma } from "../lib/prisma.js";
import { getQueue } from "../lib/queues.js";
import { generateBlog } from "./generateBlog.js";
import { notify } from "../lib/notify.js";

const norm = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => w.length > 3));
const jaccard = (a: Set<string>, b: Set<string>) => {
  const inter = [...a].filter((x) => b.has(x)).length;
  return inter / (a.size + b.size - inter || 1);
};

/**
 * Owner-triggered batch: write `count` articles for the top gaps, then
 * auto-schedule everything that passes QA (and isn't a near-duplicate)
 * across [start, end] — any day, 08:00-17:00 site time, min 36-62 min
 * random gaps — pushed immediately to the CMS's own scheduler.
 * QA failures and near-duplicates stay in the review queue instead.
 */
export async function writeSchedule(job: Job) {
  const payload = WriteSchedulePayload.parse(job.data);
  const nodes = await prisma.topicNode.findMany({
    where: { companyId: payload.companyId, status: { in: ["unanswered", "answered_weak", "competitor_owned", "stale"] }, blogPostId: null },
    orderBy: [{ score: { sort: "desc", nulls: "last" } }],
    take: payload.count,
  });
  console.log(`[write-schedule] writing ${nodes.length} articles`);
  const run = await prisma.batchRun.create({
    data: { companyId: payload.companyId, total: nodes.length },
  });
  const upd = (data: Record<string, unknown>) =>
    prisma.batchRun.update({ where: { id: run.id }, data }).catch(() => null);
  const postIds: string[] = [];
  let failedCount = 0;
  for (const node of nodes) {
    await upd({ currentTitle: node.question.slice(0, 120), currentStep: "starting" });
    try {
      const r = (await generateBlog(
        { data: { companyId: payload.companyId, topicNodeId: node.id } } as Job,
        async (stepName) => { await upd({ currentStep: stepName }); },
      )) as any;
      if (r.blogPostId) {
        postIds.push(r.blogPostId);
        await prisma.blogPost.update({ where: { id: r.blogPostId }, data: { batchRunId: run.id } }).catch(() => null);
      }
      await upd({ written: postIds.length, currentStep: "done", postIds });
    } catch (e: any) {
      failedCount++;
      await upd({ failed: failedCount, currentStep: "failed" });
      console.warn(`[write-schedule] generation failed for "${node.question.slice(0, 60)}": ${e?.message}`);
      // out of AI credits -> stop the batch NOW instead of failing every
      // remaining article one by one, and tell the owner exactly what happened
      if (/402|credit|monthly limit|limit exceeded/i.test(String(e?.message ?? ""))) {
        await notify({
          companyId: payload.companyId,
          type: "publish_failed",
          title: "Batch stopped — OpenRouter is out of credits",
          body: "Add credits or raise the key's monthly limit at openrouter.ai, then run the batch again — the unwritten topics are still in the backlog.",
          href: `/company/${payload.companyId}/batches`,
        });
        await upd({ state: "failed", currentStep: "out of AI credits", currentTitle: null });
        console.warn("[write-schedule] stopping batch: OpenRouter credit/limit exhausted");
        break;
      }
    }
  }
  await upd({ state: "scheduling", currentTitle: null, currentStep: "scheduling" });

  // filter: QA pass + not a near-duplicate of anything published or picked
  const published = await prisma.blogPost.findMany({ where: { status: "published" }, select: { title: true } });
  const seen = published.map((p) => norm(p.title));
  const candidates = await prisma.blogPost.findMany({ where: { id: { in: postIds } } });
  const pick: typeof candidates = [];
  let skippedQa = 0, skippedDup = 0;
  for (const d of candidates) {
    const qa = d.qa as { pass?: boolean } | null;
    if (!qa?.pass) { skippedQa++; continue; }
    const t = norm(d.title);
    if (seen.some((s) => jaccard(t, s) > 0.65)) { skippedDup++; continue; }
    seen.push(t);
    pick.push(d);
  }

  // spread across the window: any day, 08:00-16:59 site time, random 36-62 min min-gaps
  const start = new Date(payload.start).getTime();
  const end = new Date(payload.end).getTime();
  const span = Math.max(end - start, 3600e3);
  const step = span / Math.max(pick.length, 1);
  let prevTime = 0;
  let scheduled = 0;
  for (let i = 0; i < pick.length; i++) {
    const post = pick[i]!;
    const when = new Date(start + step * i + step * 0.5);
    when.setHours(8 + Math.floor(Math.random() * 9), Math.floor(Math.random() * 60), 0, 0);
    const gap = (36 + Math.random() * 26) * 60e3;
    if (prevTime && when.getTime() < prevTime + gap) when.setTime(prevTime + gap);
    prevTime = when.getTime();
    await prisma.blogPost.update({ where: { id: post.id }, data: { status: "approved", scheduledFor: when } });
    await getQueue(QUEUES.publishBlog).add(QUEUES.publishBlog, { blogPostId: post.id });
    scheduled++;
    await job.updateProgress(50 + Math.round((scheduled / pick.length) * 50));
  }
  // held-back articles (QA flags / near-duplicates) keep their reserved slot
  // in the owner's window too — the review queue then shows
  // "Approve — goes live {date}" instead of asking for a date again.
  const held = candidates.filter((c) => !pick.some((p) => p.id === c.id));
  for (const post of held) {
    const when = new Date((prevTime || start) + (36 + Math.random() * 26) * 60e3);
    if (when.getHours() >= 17) { when.setDate(when.getDate() + 1); when.setHours(8, when.getMinutes(), 0, 0); }
    if (when.getHours() < 8) when.setHours(8 + Math.floor(Math.random() * 9), Math.floor(Math.random() * 60), 0, 0);
    prevTime = when.getTime();
    await prisma.blogPost.update({ where: { id: post.id }, data: { scheduledFor: when } }).catch(() => null);
  }

  await upd({ state: "done", scheduled, skippedQa, skippedDup, finishedAt: new Date(), currentStep: null });
  const leftover = skippedQa + skippedDup;
  await notify({
    companyId: payload.companyId,
    type: "batch_done",
    title: `Batch finished: ${scheduled} article${scheduled === 1 ? "" : "s"} scheduled`,
    body: `${postIds.length} written` +
      (leftover ? `, ${leftover} held for your review (${skippedQa} QA, ${skippedDup} near-duplicate)` : "") +
      (failedCount ? `, ${failedCount} failed` : ""),
    href: `/company/${payload.companyId}/batches`,
  });
  if (leftover) {
    await notify({
      companyId: payload.companyId,
      type: "review_needed",
      title: `${leftover} article${leftover === 1 ? "" : "s"} awaiting review`,
      body: "Held back from auto-scheduling — approve, edit, or reject them in the review queue.",
      href: `/review/${payload.companyId}`,
    });
  }
  console.log(`[write-schedule] done: ${scheduled} scheduled, ${skippedQa} QA-fail + ${skippedDup} near-dup left in review`);
  return { written: postIds.length, scheduled, leftInReview: skippedQa + skippedDup };
}
